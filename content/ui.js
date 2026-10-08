/** 单个增量观察器：悬浮卡片入口、本机内容屏蔽与共享面板。 */
(async () => {
  const hidden = new Set(), dirty = new Set(), hoverGroups = new Set(), controls = new WeakMap();
  let whitelist = new Set(), timer = null, maxTimer = null, scanning = false, valid = true, panel = null;
  function node(tag,text) { const el = document.createElement(tag); if (text) el.textContent = text; return el; }
  function send(message) {
    return new Promise((resolve,reject) => {
      try { chrome.runtime.sendMessage({target:'background',...message},response => {
        const error = chrome.runtime.lastError;
        if (error || response?.error) reject(new Error(error?.message || response.error)); else resolve(response || {});
      }); } catch (error) { valid = false; observer.disconnect(); reject(error); }
    });
  }
  const chromeURL = path => chrome.runtime.getURL(path);
  const launcher = node('div'); launcher.setAttribute('data-zb-ui','launcher');
  launcher.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;';
  const launcherRoot = launcher.attachShadow({mode:'open'}), launch = node('button','屏蔽面板'), status = node('div');
  launch.type = 'button'; status.setAttribute('role','status');
  const launcherStyle = node('style'); launcherStyle.textContent = 'button{border:1px solid #d5e4fb;border-radius:20px;background:#edf4ff;color:#1964c5;padding:10px 16px;font:13px system-ui;cursor:pointer}div{max-width:330px;background:#fff;color:#536178;border-radius:8px;font:12px/1.6 system-ui;overflow-wrap:anywhere;margin-bottom:8px;box-shadow:0 3px 16px #0002;padding:10px}div:empty{display:none}';
  launcherRoot.append(launcherStyle,status,launch); document.body.appendChild(launcher);
  const hideStyle = node('style'); hideStyle.setAttribute('data-zb-ui','style'); hideStyle.textContent = '[data-zb-hidden="1"]{display:none!important}'; document.head.appendChild(hideStyle);
  let toastTimer;
  function toast(text) { status.textContent = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => {status.textContent='';},8000); }
  function closePanel() { panel?.remove(); panel = null; launch.textContent = '屏蔽面板'; }
  function openPanel() {
    closePanel(); panel = node('div'); panel.setAttribute('data-zb-ui','panel');
    panel.style.cssText = 'position:fixed;right:18px;bottom:70px;width:min(390px,calc(100vw - 24px));height:min(650px,calc(100vh - 95px));z-index:2147483646;border-radius:10px;box-shadow:0 8px 35px #0003;overflow:hidden;background:#fff;';
    const shadow = panel.attachShadow({mode:'open'}), iframe = node('iframe'); iframe.title = '知乎屏蔽面板';
    iframe.src = chromeURL('popup/popup.html?panel=1'); iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;';
    shadow.appendChild(iframe); document.body.appendChild(panel); launch.textContent = '收起面板';
  }
  launch.onclick = () => panel ? closePanel() : openPanel();
  async function action(message) {
    try {
      const result = await send(message);
      if (message.action.startsWith('preview')) { if (result.review) openPanel(); }
      else toast(result.message || (result.hidden ? '已在本机屏蔽，该操作未请求知乎拉黑' : '已恢复本机显示，知乎黑名单未改变'));
    } catch (error) { toast(error.message); }
  }
  function attach(owner, user, answerId = null) {
    let entry = controls.get(owner);
    if (entry && !!entry.user !== !!user) { entry.host.remove(); controls.delete(owner); entry = null; }
    if (!entry) {
      const host = node('div'); host.setAttribute('data-zb-ui','controls'); host.style.cssText = 'margin:8px 0;';
      const shadow = host.attachShadow({mode:'open'}), style = node('style'), wrap = node('div');
      style.textContent = 'div{display:flex;flex-wrap:wrap;gap:6px}button{border:1px solid #d5e4fb;background:#edf4ff;color:#1964c5;border-radius:5px;padding:5px 8px;cursor:pointer;font:12px system-ui}button:first-child{background:#fff4f3;border-color:#f4dcd8;color:#ba4036}button:disabled{opacity:.5;cursor:default}';
      entry = {host,user,answerId,buttons:[]}; controls.set(owner,entry);
      function button(label,fn) { const el=node('button',label);el.type='button';el.onclick=async()=>{el.disabled=true;await fn();if(valid)refreshEntry(entry);};wrap.appendChild(el);entry.buttons.push(el);return el; }
      if (user) {
        button('屏蔽并拉黑',() => action({action:'shieldUser',user:entry.user}));
        button('仅本机屏蔽',() => action(hidden.has(entry.user.urlToken) ? {action:'unhideUser',urlToken:entry.user.urlToken} : {action:'hideUser',user:entry.user}));
        button('预览粉丝',() => action({action:'previewFollowers',profileToken:entry.user.urlToken,maxUsers:100}));
      } else button('预览回答赞同者',() => action({action:'previewAnswerVoters',answerId:entry.answerId,maxUsers:100}));
      shadow.append(style,wrap); owner.appendChild(host);
    }
    if (!entry.host.isConnected) owner.appendChild(entry.host);
    entry.user = user; entry.answerId = answerId; refreshEntry(entry);
  }
  function refreshEntry(entry) {
    if (!entry.user) { entry.buttons[0].disabled = false; return; }
    const blocked = hidden.has(entry.user.urlToken), protectedUser = whitelist.has(entry.user.urlToken);
    entry.buttons[0].textContent = blocked ? '本机已屏蔽' : '屏蔽并拉黑'; entry.buttons[0].disabled = blocked || protectedUser;
    entry.buttons[1].textContent = blocked ? '恢复本机显示' : '仅本机屏蔽'; entry.buttons[1].disabled = !blocked && protectedUser;
    entry.buttons[2].disabled = false;
  }
  function mark(root) {
    if (root.nodeType === Node.ELEMENT_NODE && root.closest('[data-zb-ui]')) return;
    for (const unit of ZBScanner.collectUnits([root])) dirty.add(unit);
    if (root.matches?.('.HoverCard-buttons')) hoverGroups.add(root);
    root.querySelectorAll?.('.HoverCard-buttons').forEach(group => hoverGroups.add(group));
  }
  function markHoverTarget(target) {
    let root = target.closest('.HoverCard, .UserHoverCard, .Popover-content');
    if (!root) { root=target;for(let i=0;i<4 && root?.parentElement !== document.body && !root?.querySelector('.HoverCard-buttons');i++)root=root?.parentElement; }
    if (root && root !== document.body) root.querySelectorAll('.HoverCard-buttons').forEach(group => hoverGroups.add(group));
  }
  async function scan() {
    clearTimeout(timer);clearTimeout(maxTimer);timer=maxTimer=null;
    if (!valid || scanning) return;scanning=true;
    try {
      const units=[...dirty];dirty.clear();
      for(let offset=0;offset<units.length && valid;offset+=30) {
        for(const unit of units.slice(offset,offset+30)) {
          if(!unit.isConnected)continue;
          const user=ZBScanner.authorOf(unit), shouldHide=user && hidden.has(user.urlToken) && !whitelist.has(user.urlToken) && ZBScanner.shieldable(unit);
          if(shouldHide)unit.setAttribute('data-zb-hidden','1');else unit.removeAttribute('data-zb-hidden');
          if(user && (ZBScanner.isComment(unit) || unit.matches('.ProfileHeader')))attach(unit,user);
          else {const answerId=ZBScanner.answerIdForUnit(unit);if(answerId)attach(unit,null,answerId);}
        }
        if(offset+30<units.length)await new Promise(resolve=>setTimeout(resolve,0));
      }
      const groups=[...hoverGroups];hoverGroups.clear();
      for(const group of groups) if(group.isConnected){const context=ZBScanner.hoverContext(group);if(context)attach(group,context.user);else {controls.get(group)?.host.remove();controls.delete(group);}}
    } finally {scanning=false;if(dirty.size || hoverGroups.size)schedule();}
  }
  function schedule() {if(!valid)return;clearTimeout(timer);timer=setTimeout(scan,150);if(!maxTimer)maxTimer=setTimeout(scan,1000);}
  const observer = new MutationObserver(mutations => {
    if(!chrome.runtime?.id){valid=false;observer.disconnect();return;}
    for(const mutation of mutations) {
      const changedNodes=[...(mutation.addedNodes || []),...(mutation.removedNodes || [])];
      if(changedNodes.length && changedNodes.every(child=>child.nodeType===Node.ELEMENT_NODE && child.hasAttribute('data-zb-ui')))continue;
      const target=mutation.target.nodeType===Node.ELEMENT_NODE?mutation.target:mutation.target.parentElement;
      if(!target || target.closest('[data-zb-ui]'))continue;
      const owner=ZBScanner.closestUnit(target);if(owner)dirty.add(owner);markHoverTarget(target);
      for(const child of mutation.addedNodes || [])if(child.nodeType===Node.ELEMENT_NODE)mark(child);
    }
    schedule();
  });
  chrome.runtime.onMessage.addListener((message,sender,respond) => {
    if(message.action==='getPageContext')respond({type:ZBScanner.detectPageType(),profileToken:ZBScanner.extractProfileTokenFromUrl(),answers:ZBScanner.extractAnswerIdsFromPage()});
    if(message.action==='closeFloatingPanel'){closePanel();respond({closed:true});}
  });
  chrome.storage.onChanged.addListener((changes,area) => {
    if(area==='local') {
      let changed=false;
      for(const [key,value] of Object.entries(changes))if(key.startsWith('zb:hide:')) {
        const token=ZBStorage.tokenFrom(key.slice(8));if(!token)continue;
        if(value.newValue)hidden.add(token);else hidden.delete(token);changed=true;
      }
      if(changed){mark(document);schedule();}
    }
    if(area==='sync' && changes.settings)ZBStorage.getSettings().then(settings=>{whitelist=new Set(settings.whitelist);mark(document);schedule();});
  });
  try {
    const [data,settings]=await Promise.all([ZBStorage.localGet(null),ZBStorage.getSettings()]);
    for(const [key,value] of Object.entries(data))if(key.startsWith('zb:hide:') && value){const token=ZBStorage.tokenFrom(key.slice(8));if(token)hidden.add(token);}
    whitelist=new Set(settings.whitelist);mark(document);
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['href','data-id','data-zop']});schedule();
  } catch(error){toast('无法加载本机屏蔽设置：'+error.message);}
})();
