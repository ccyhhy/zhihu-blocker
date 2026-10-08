document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);

  const pageNames = {feed:'知乎普通页面',answer:'回答页面',question:'问题页面',article:'文章页面',profile:'用户页面'};
  let task = null, settings = {}, starting = false, retryTimer;
  const hiddenUsers = new Map(); let hiddenShown = 100;
  function node(tag, value, style) {
    const element = document.createElement(tag); element.textContent = value;
    if (style) element.className = style; return element;
  }
  function send(message) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage({target:'background', ...message}, response => {
      const error = chrome.runtime.lastError;
      if (error || response?.error) reject(new Error(error?.message || response.error)); else resolve(response || {});
    }));
  }
  const error = e => {
    const text = e.message || String(e); $('actionHint').classList.add('error'); $('actionHint').textContent = text;
  };
  function renderTask(value) {
    task = value;
    clearTimeout(retryTimer);
    const active = task && ['running','paused'].includes(task.status);
    $('taskToggleBtn').hidden = !active; $('taskEndBtn').hidden = !active;
    if (task) {
      $('actionProgress').style.display = 'flex';
      const status = {running:'处理中',paused:'已暂停',done:'完成',cancelled:'已结束'}[task.status];
      const source = task.type === 'voters' ? '回答 ' + task.target + ' 的赞同者' : task.type === 'followers' ? task.target + ' 的粉丝' : '所选用户';
      $('progressText').textContent = status + ' · ' + source + ' · 已读取 ' + task.fetched + (task.maxUsers ? ' / ' + task.maxUsers : '（不限人数）') + '，成功 ' + task.blocked + '，跳过 ' + task.skipped + '，失败 ' + task.failed +
        (task.unknown ? '，待核对 ' + task.unknown : '') + (task.remaining ? '，未处理 ' + task.remaining : '') + (task.error ? '。' + task.error : '');
      const pct = task.status === 'done' ? 100 : task.maxUsers ? Math.min(99, Math.round((task.blocked + task.skipped + task.failed + task.unknown) / task.maxUsers * 100)) : 35;
      $('progressFill').classList.toggle('indeterminate',task.status === 'running' && !task.maxUsers);
      $('progressFill').style.width = pct + '%';
      $('taskToggleBtn').textContent = task.status === 'running' ? '暂停' : '继续';
      $('taskToggleBtn').disabled = task.status === 'paused' && task.retryAt > Date.now();
      if ($('taskToggleBtn').disabled) retryTimer = setTimeout(() => renderTask(task), Math.min(2147483647, task.retryAt - Date.now() + 100));
      $('taskEvidence').replaceChildren();
      for (const e of task.evidence || []) $('taskEvidence').appendChild(node('div', e.name + '：' + e.text, 'evidence-item'));
      for (const user of task.uncertainUsers || []) {
        const row = node('div','待核对：','evidence-item'), link = node('a',user.name);
        const token = ZBStorage.tokenFrom(user.urlToken); if (!token) continue;
        link.href = 'https://www.zhihu.com/people/' + encodeURIComponent(token); link.target = '_blank'; link.rel = 'noopener noreferrer';
        row.appendChild(link); $('taskEvidence').appendChild(row);
      }
      const details = document.querySelector('.task-evidence');
      details.hidden = !task.evidence?.length && !task.uncertainUsers?.length;
      details.querySelector('summary').textContent = task.uncertainUsers?.length ? '查看命中及待核对用户' : '查看命中内容';
    }
    document.querySelectorAll('[data-start-task]').forEach(button => { button.disabled = !!(active || starting); });
  }
  function renderStats(stats) {
    $('dailyCount').textContent = stats?.daily ?? '—'; $('totalBlocked').textContent = stats?.total ?? '—';
    $('accountHint').textContent = stats ? '当前账号：' + stats.account + (stats.legacy ? '。旧版全局记录已保留，不计入此账号统计。' : '') : '账号尚未确认，请检查知乎登录状态。';
  }
  async function refreshSettings(apply = false) {
    settings = await ZBStorage.getSettings();
    $('speedMode').textContent = settings.blockIntervalMax > 0 ? '逐个 · 有间隔' : '并发 ' + settings.blockConcurrency + ' · 无间隔';
    if (apply) {
      $('intervalMin').value = settings.blockIntervalMin / 1000; $('intervalMax').value = settings.blockIntervalMax / 1000;
      $('blockConcurrencyInput').value = settings.blockConcurrency; $('whitelistInput').value = settings.whitelist.join('\n');
    }
  }
  function renderHidden(users) {
    if (users) { hiddenUsers.clear(); for (const user of users) hiddenUsers.set(user.urlToken,user); }
    $('hiddenCount').textContent = hiddenUsers.size + ' 人';
    if (!$('hiddenDetails').open) return;
    $('hiddenList').replaceChildren();
    for (const user of [...hiddenUsers.values()].slice(0,hiddenShown)) {
      const row = node('div','','rule-item'), link = node('a',user.name || user.urlToken), restore = node('button','恢复显示','btn btn-quiet');
      link.href = 'https://www.zhihu.com/people/' + encodeURIComponent(user.urlToken); link.target = '_blank'; link.rel = 'noopener noreferrer';
      restore.onclick = async () => { restore.disabled = true; try { await send({action:'unhideUser',urlToken:user.urlToken}); hiddenUsers.delete(user.urlToken); renderHidden(); } catch (e) { error(e);restore.disabled=false; } };
      row.append(link,restore); $('hiddenList').appendChild(row);
    }
    if (hiddenUsers.size > hiddenShown) {
      const more=node('button','显示更多','btn btn-quiet');more.onclick=()=>{hiddenShown+=100;renderHidden();};$('hiddenList').appendChild(more);
    }
    if (!hiddenUsers.size) $('hiddenList').appendChild(node('p','暂未在本机屏蔽用户。','muted'));
  }
  $('hiddenDetails').ontoggle = () => renderHidden();
  async function start(action,answerId,profileToken) {
    if (starting || task && ['running','paused'].includes(task.status)) return;
    const maxUsers = Number($('maxUsersInput').value || 0);
    if (!Number.isSafeInteger(maxUsers) || maxUsers < 0) { error(new Error('处理人数请填写正整数，留空或 0 表示全部')); return; }
    starting = true; renderTask(task);
    $('actionHint').classList.remove('error'); $('actionHint').textContent = '正在启动批量拉黑…';
    try {
      const response = await send({action,answerId,profileToken,maxUsers});
      if (response.busy) throw new Error('已有任务，请继续或结束该任务');
      renderTask(response.task);
      $('actionHint').textContent = '已开始逐页拉黑并屏蔽，进度自动保存；可随时暂停或结束。';
    } catch (e) { error(e); } finally { starting = false; renderTask(task); }
  }
  function answerControl(answers) {
    const wrap = node('div','','voter-controls'), picker = document.createElement('select'); picker.setAttribute('aria-label','选择回答');
    for (const answer of answers) {
      const option = node('option',(answer.author ? answer.author + '：' : '') + (answer.excerpt || '回答 ' + answer.answerId));
      option.value = answer.answerId; picker.appendChild(option);
    }
    const button = node('button','拉黑回答赞同者','btn btn-danger'); button.dataset.startTask = 'voters';
    button.onclick = () => start('blockAnswerVoters',picker.value);
    wrap.append(picker,button); $('pageSpecialActions').appendChild(wrap);
  }
  async function detectPage() {
    try {
      const context = await send({action:'getPageContext'});
      $('pageStatus').textContent = '当前页面：' + (pageNames[context.type] || '知乎页面');
      $('pageSpecialActions').replaceChildren();
      if (context.answers?.length) answerControl(context.answers);
      else $('pageSpecialActions').appendChild(node('p','打开回答页面，可批量拉黑该回答的赞同者。','muted'));
      const wrap = node('div','','voter-controls'), input = document.createElement('input'), label = node('label','某人的粉丝');
      input.type = 'text'; input.placeholder = '填写知乎用户主页地址'; input.setAttribute('aria-label','拉黑粉丝的用户主页');
      input.value = context.profileToken ? 'https://www.zhihu.com/people/' + context.profileToken : ''; input.style.width = '100%';
      const button = node('button','拉黑这个人的粉丝','btn btn-danger btn-full'); button.dataset.startTask = 'followers';
      button.onclick = () => start('blockFollowers',null,ZBStorage.tokenFrom(input.value));
      wrap.append(label,input,button); $('pageSpecialActions').appendChild(wrap);
      $('actionHint').classList.remove('error'); $('actionHint').textContent = '点击按钮立即开始，自动读取下一页；粉丝是关注这个人的账号。';
      renderTask(task);
    } catch (e) { $('pageStatus').textContent = '页面暂不可用'; $('pageSpecialActions').replaceChildren(); error(e); }
  }
  const openSettings = () => { $('settingsBody').style.display = 'block'; $('settingsToggle').classList.add('open'); $('settingsToggle').setAttribute('aria-expanded','true'); };
  $('settingsToggle').onclick = () => {
    if ($('settingsBody').style.display === 'none') openSettings();
    else { $('settingsBody').style.display = 'none'; $('settingsToggle').classList.remove('open'); $('settingsToggle').setAttribute('aria-expanded','false'); }
  };
  $('headerSettingsBtn').onclick = () => { openSettings(); $('settingsToggle').scrollIntoView({block:'start'}); };
  $('saveSettingsBtn').onclick = async () => {
    try {
      const whitelist = ZBStorage.words($('whitelistInput').value).map(ZBStorage.tokenFrom);
      if (whitelist.some(token => !token)) throw new Error('白名单请填知乎主页地址或 url_token，每行一个');
      const saved = await ZBStorage.getSettings();
      const bounded = (id,max) => Math.max(0,Math.min(max,Number($(id).value) || 0));
      saved.autoMode = false;
      saved.blockIntervalMin = bounded('intervalMin',30) * 1000;
      saved.blockIntervalMax = Math.max(saved.blockIntervalMin,bounded('intervalMax',30) * 1000);
      saved.blockConcurrency = Math.max(1,Math.floor(bounded('blockConcurrencyInput',20)) || 5);
      saved.whitelist = whitelist;
      await ZBStorage.saveSettings(saved); await refreshSettings(); await detectPage();
      $('saveSettingsBtn').textContent = '已保存'; setTimeout(() => { $('saveSettingsBtn').textContent = '保存设置'; },1500);
    } catch (e) { error(e); }
  };
  $('fastModeBtn').onclick = async () => {
    try {
      const saved=await ZBStorage.getSettings();
      Object.assign(saved,{blockIntervalMin:0,blockIntervalMax:0,pageInterval:0,blockConcurrency:5});
      await ZBStorage.saveSettings(saved); await refreshSettings(true);
      $('actionHint').classList.remove('error');$('actionHint').textContent='快速模式已启用：5 并发、无额外等待，下个批次生效。';
    } catch(e) {error(e);}
  };
  $('taskToggleBtn').onclick = async () => { try { renderTask((await send({action:task.status === 'running' ? 'pauseTask' : 'resumeTask'})).task); } catch (e) { error(e); } };
  $('taskEndBtn').onclick = async () => { try { renderTask((await send({action:'endTask'})).task); } catch (e) { error(e); } };
  $('refreshPageBtn').onclick = detectPage;
  if (new URLSearchParams(location.search).get('panel') === '1') {
    $('closePanelBtn').hidden = false; $('closePanelBtn').onclick = () => send({action:'closeFloatingPanel'}).catch(error);
  }
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'taskUpdate') { renderTask(message.task); renderStats(message.stats); } });
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area === 'sync' && changes.settings) refreshSettings().catch(error);
    if (area === 'local') {
      let changed=false;
      for (const [key,value] of Object.entries(changes)) if (key.startsWith('zb:hide:')) {
        const token=ZBStorage.tokenFrom(key.slice(8));if (!token) continue;
        if (value.newValue) hiddenUsers.set(token,{urlToken:token,name:value.newValue.name || token});else hiddenUsers.delete(token);changed=true;
      }
      if (changed) renderHidden();
    }
  });
  await refreshSettings(true); await detectPage();
  try { const state = await send({action:'getState'}); renderTask(state.task); renderStats(state.stats); renderHidden(state.hiddenUsers); if (state.error) error(state.error); } catch (e) { error(e); }
});
