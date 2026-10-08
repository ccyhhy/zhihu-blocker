document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);

  const pageNames = {feed:'知乎普通页面',answer:'回答页面',question:'问题页面',article:'文章页面',profile:'用户页面'};
  let task = null, review = null, settings = {}, starting = false, retryTimer, reviewPage = 0;
  let selected = new Set(), selectionTail = Promise.resolve();
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
    if (review) { $('reviewHint').classList.add('error'); $('reviewHint').textContent = text; }
  };
  function renderTask(value) {
    task = value;
    clearTimeout(retryTimer);
    const active = task && ['running','paused'].includes(task.status);
    $('taskToggleBtn').hidden = !active; $('taskEndBtn').hidden = !active;
    if (task) {
      $('actionProgress').style.display = 'flex';
      const status = {running:'处理中',paused:'已暂停',done:'完成',cancelled:'已结束'}[task.status];
      $('progressText').textContent = status + ' · 已检查 ' + task.fetched + '，成功 ' + task.blocked + '，跳过 ' + task.skipped + '，失败 ' + task.failed +
        (task.unknown ? '，待核对 ' + task.unknown : '') + (task.remaining ? '，未处理 ' + task.remaining : '') + (task.error ? '。' + task.error : '');
      const pct = task.status === 'done' ? 100 : Math.min(99, task.fetched ? Math.round((task.blocked + task.skipped + task.failed + task.unknown) / task.fetched * 100) : 0);
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
    updateReviewButtons();
  }
  const reviewNames = {voters:'回答赞同者',followers:'这个人的粉丝'};
  function updateReviewButtons() {
    const busy = starting || task && ['running','paused'].includes(task.status);
    $('confirmReviewBtn').disabled = !!busy || !selected.size;
    $('confirmReviewBtn').textContent = selected.size ? '拉黑并屏蔽勾选的 ' + selected.size + ' 人' : '拉黑并屏蔽勾选的用户';
    $('selectedCount').textContent = '已勾选 ' + selected.size + ' 人';
    $('loadMoreReviewBtn').disabled = !!busy;
    $('discardReviewBtn').disabled = !!starting;
    $('selectPageBtn').disabled = !!starting || !(review?.users || []).slice(reviewPage * 20, (reviewPage + 1) * 20).some(user => !user.skip);
    const visible = (review?.users || []).slice(reviewPage * 20, (reviewPage + 1) * 20).filter(user => !user.skip);
    $('selectPageBtn').textContent = visible.length && visible.every(user => selected.has(user.urlToken)) ? '取消本页' : '选中本页';
    document.querySelectorAll('#reviewList input').forEach(input => { input.disabled = !!starting || input.dataset.skip === 'true'; });
  }
  function saveSelection() {
    const id = review.id, tokens = [...selected];
    selectionTail = selectionTail.catch(() => {}).then(() => send({action:'saveReviewSelection',reviewId:id,tokens}));
    selectionTail.catch(error); updateReviewButtons();
  }
  function renderReview(value, reset = true) {
    if (value?.id !== review?.id) reviewPage = 0;
    review = value; $('reviewSection').hidden = !review;
    if (!review) { selected.clear(); updateReviewButtons(); return; }
    if (reset) selected = new Set(review.selected || []);
    const pages = Math.max(1, Math.ceil(review.users.length / 20)); reviewPage = Math.min(reviewPage,pages - 1);
    $('reviewSummary').textContent = (reviewNames[review.type] || '候选名单') + ' · 来源：' + review.target + ' · 账号：' + review.account + ' · 已收集 ' + review.users.length + ' 人。' +
      (review.exhausted ? '名单读取完毕。' : review.users.length >= review.maxUsers ? '已达到本次上限。' : '还有未读取的名单。');
    $('reviewHint').classList.toggle('error',!!review.error);
    $('reviewHint').textContent = review.error || '默认不勾选；确认后只处理所选用户，知乎拉黑成功后在本机隐藏其内容。';
    $('reviewList').replaceChildren();
    for (const user of review.users.slice(reviewPage * 20,(reviewPage + 1) * 20)) {
      const row = node('div','','review-row'), checkbox = document.createElement('input'), copy = node('div','','review-copy');
      checkbox.type = 'checkbox'; checkbox.checked = selected.has(user.urlToken); checkbox.dataset.skip = String(!!user.skip);
      checkbox.setAttribute('aria-label','选择 ' + user.name);
      checkbox.onchange = () => { if (checkbox.checked) selected.add(user.urlToken); else selected.delete(user.urlToken); saveSelection(); };
      const link = node('a',user.name || user.urlToken); link.href = 'https://www.zhihu.com/people/' + encodeURIComponent(user.urlToken); link.target = '_blank'; link.rel = 'noopener noreferrer';
      copy.appendChild(link); copy.appendChild(node('div',user.urlToken,'muted'));
      if (user.skip) copy.appendChild(node('p','跳过：' + user.skip,'review-skip'));
      copy.appendChild(node('p','来自' + (reviewNames[review.type] || '候选名单') + '，关联关系不代表思想或素质判断。'));
      row.append(checkbox,copy); $('reviewList').appendChild(row);
    }
    if (!review.users.length) $('reviewList').appendChild(node('p','暂时没有候选用户。','muted'));
    $('reviewPage').textContent = (reviewPage + 1) + ' / ' + pages;
    $('reviewPrevBtn').disabled = reviewPage === 0; $('reviewNextBtn').disabled = reviewPage + 1 >= pages;
    $('loadMoreReviewBtn').hidden = review.exhausted || review.users.length >= review.maxUsers;
    updateReviewButtons();
  }
  function renderStats(stats) {
    $('dailyCount').textContent = stats?.daily ?? '—'; $('totalBlocked').textContent = stats?.total ?? '—';
    $('accountHint').textContent = stats ? '当前账号：' + stats.account + (stats.legacy ? '。旧版全局记录已保留，不计入此账号统计。' : '') : '账号尚未确认，请检查知乎登录状态。';
  }
  async function refreshSettings(apply = false) {
    settings = await ZBStorage.getSettings();
    if (apply) {
      $('intervalMin').value = settings.blockIntervalMin / 1000; $('intervalMax').value = settings.blockIntervalMax / 1000;
      $('blockConcurrencyInput').value = settings.blockConcurrency; $('whitelistInput').value = settings.whitelist.join('\n');
    }
  }
  async function refreshHidden(users) {
    if (!users) users = (await send({action:'getHiddenUsers'})).hiddenUsers || [];
    $('hiddenCount').textContent = users.length + ' 人'; $('hiddenList').replaceChildren();
    for (const user of users) {
      const row = node('div','','rule-item'), link = node('a',user.name || user.urlToken), restore = node('button','恢复显示','btn btn-quiet');
      link.href = 'https://www.zhihu.com/people/' + encodeURIComponent(user.urlToken); link.target = '_blank'; link.rel = 'noopener noreferrer';
      restore.onclick = async () => { restore.disabled = true; try { await send({action:'unhideUser',urlToken:user.urlToken}); await refreshHidden(); } catch (e) { error(e);restore.disabled=false; } };
      row.append(link,restore); $('hiddenList').appendChild(row);
    }
    if (!users.length) $('hiddenList').appendChild(node('p','暂未在本机屏蔽用户。','muted'));
  }
  async function start(action,input,answerId,profileToken) {
    if (starting || task && ['running','paused'].includes(task.status)) return;
    starting = true; renderTask(task);
    $('actionHint').classList.remove('error'); $('actionHint').textContent = '正在读取候选，仅预览…';
    try {
      const response = await send({action,answerId,profileToken,maxUsers:Math.max(1,Math.min(200,Number(input.value) || 100))});
      renderReview(response.review);
      $('actionHint').textContent = '请在预览中勾选要处理的用户。';
      $('reviewSection').scrollIntoView({block:'start'});
    } catch (e) { error(e); } finally { starting = false; renderTask(task); }
  }
  function control(label,caption,action,answers) {
    const wrap = node('div','','voter-controls'), limit = node('label','最多检查 '), input = document.createElement('input');
    input.setAttribute('aria-label','本次最多预览人数');
    input.type = 'number'; input.min = '1'; input.max = '200'; input.value = '100';
    limit.append(input,document.createTextNode(' 人（最多 200）')); wrap.appendChild(limit);
    let picker;
    if (answers) {
      picker = document.createElement('select'); picker.setAttribute('aria-label','选择回答');
      for (const answer of answers) {
        const option = node('option',(answer.author ? answer.author + '：' : '') + (answer.excerpt || '回答 ' + answer.answerId));
        option.value = answer.answerId; picker.appendChild(option);
      }
      wrap.appendChild(picker);
    }
    const button = node('button',caption,'btn btn-secondary'); button.dataset.startTask = label;
    button.onclick = () => start(action,input,picker?.value);
    wrap.appendChild(button); $('pageSpecialActions').appendChild(wrap);
  }
  async function detectPage() {
    try {
      const context = await send({action:'getPageContext'});
      $('pageStatus').textContent = '当前页面：' + (pageNames[context.type] || '知乎页面');
      $('pageSpecialActions').replaceChildren();
      if (context.answers?.length) control('voters','预览回答赞同者','previewAnswerVoters',context.answers);
      else $('pageSpecialActions').appendChild(node('p','打开回答页面，可预览该回答的赞同者。','muted'));
      const wrap = node('div','','voter-controls'), input = document.createElement('input'), label = node('label','某人的粉丝');
      input.type = 'text'; input.placeholder = '填写知乎用户主页地址'; input.setAttribute('aria-label','预览粉丝的用户主页');
      input.value = context.profileToken ? 'https://www.zhihu.com/people/' + context.profileToken : ''; input.style.width = '100%';
      const preview = node('button','预览这个人的粉丝','btn btn-secondary btn-full'); preview.dataset.startTask = 'followers';
      preview.onclick = () => start('previewFollowers',{value:100},null,ZBStorage.tokenFrom(input.value));
      wrap.append(label,input,preview); $('pageSpecialActions').appendChild(wrap);
      $('actionHint').classList.remove('error'); $('actionHint').textContent = '名单先预览，勾选后再执行。粉丝是关注这个人的账号。';
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
  $('selectPageBtn').onclick = () => {
    const visible = review.users.slice(reviewPage * 20,(reviewPage + 1) * 20).filter(user => !user.skip);
    const clear = visible.every(user => selected.has(user.urlToken));
    for (const user of visible) if (clear) selected.delete(user.urlToken); else selected.add(user.urlToken);
    renderReview(review,false); saveSelection();
  };
  $('reviewPrevBtn').onclick = () => { reviewPage--; renderReview(review,false); };
  $('reviewNextBtn').onclick = () => { reviewPage++; renderReview(review,false); };
  async function reviewAction(action) {
    if (starting || !review) return;
    starting = true; updateReviewButtons(); renderTask(task);
    try {
      await selectionTail;
      const response = await send({action,reviewId:review.id,tokens:[...selected]});
      if (response.busy) throw new Error('已有任务，请继续或结束该任务');
      renderReview(response.review);
      if (response.task) { renderTask(response.task); $('actionHint').textContent = '仅处理本次勾选用户，进度会自动保存。'; }
    } catch (e) { error(e); } finally { starting = false; updateReviewButtons(); renderTask(task); }
  }
  $('loadMoreReviewBtn').onclick = () => reviewAction('loadMoreReview');
  $('discardReviewBtn').onclick = () => reviewAction('discardReview');
  $('confirmReviewBtn').onclick = () => reviewAction('confirmReview');
  $('taskToggleBtn').onclick = async () => { try { renderTask((await send({action:task.status === 'running' ? 'pauseTask' : 'resumeTask'})).task); } catch (e) { error(e); } };
  $('taskEndBtn').onclick = async () => { try { renderTask((await send({action:'endTask'})).task); } catch (e) { error(e); } };
  $('refreshPageBtn').onclick = detectPage;
  if (new URLSearchParams(location.search).get('panel') === '1') {
    $('closePanelBtn').hidden = false; $('closePanelBtn').onclick = () => send({action:'closeFloatingPanel'}).catch(error);
  }
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'taskUpdate') { renderTask(message.task); renderStats(message.stats); } });
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area === 'sync' && changes.settings) refreshSettings().catch(error);
    if (area === 'local' && Object.keys(changes).some(key => key.startsWith('zb:hide:'))) refreshHidden().catch(error);
  });
  await refreshSettings(true); await detectPage();
  try { const state = await send({action:'getState'}); renderTask(state.task); renderStats(state.stats); renderReview(state.review); await refreshHidden(state.hiddenUsers); if (state.error) error(state.error); } catch (e) { error(e); }
});
