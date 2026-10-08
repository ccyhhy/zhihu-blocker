document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const sourceNames = { bio:'签名', comment:'评论', answer:'回答', article:'文章' };
  const pageNames = { feed:'知乎普通页面', answer:'回答页面', question:'问题页面', article:'文章页面', followers:'粉丝页面', followees:'关注列表页面', profile:'个人主页' };
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
      for (const e of task.evidence || []) $('taskEvidence').appendChild(node('div', e.name + ' · ' + (sourceNames[e.source] || e.source) + '：' + e.text, 'evidence-item'));
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
  const reviewNames = {rules:'当前页面规则匹配',voters:'所选回答赞同者',followers:'粉丝名单',followees:'关注名单'};
  function updateReviewButtons() {
    const busy = starting || task && ['running','paused'].includes(task.status);
    $('confirmReviewBtn').disabled = !!busy || !selected.size;
    $('confirmReviewBtn').textContent = selected.size ? '拉黑勾选的 ' + selected.size + ' 人' : '拉黑勾选的用户';
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
    $('reviewSummary').textContent = (reviewNames[review.type] || '候选名单') + ' · 账号：' + review.account + ' · 已收集 ' + review.users.length + ' 人。' +
      (review.exhausted ? (review.type === 'rules' ? '只检查已加载内容。' : '名单读取完毕。') : review.users.length >= review.maxUsers ? '已达到本次上限。' : '还有未读取的名单。') + (review.limited ? '本次最多保留 200 人。' : '');
    $('reviewHint').classList.toggle('error',!!review.error);
    $('reviewHint').textContent = review.error || '默认不勾选；确认后只处理所选用户。预览和勾选会保存。';
    $('reviewList').replaceChildren();
    for (const user of review.users.slice(reviewPage * 20,(reviewPage + 1) * 20)) {
      const row = node('div','','review-row'), checkbox = document.createElement('input'), copy = node('div','','review-copy');
      checkbox.type = 'checkbox'; checkbox.checked = selected.has(user.urlToken); checkbox.dataset.skip = String(!!user.skip);
      checkbox.setAttribute('aria-label','选择 ' + user.name);
      checkbox.onchange = () => { if (checkbox.checked) selected.add(user.urlToken); else selected.delete(user.urlToken); saveSelection(); };
      const link = node('a',user.name || user.urlToken); link.href = 'https://www.zhihu.com/people/' + encodeURIComponent(user.urlToken); link.target = '_blank'; link.rel = 'noopener noreferrer';
      copy.appendChild(link); copy.appendChild(node('div',user.urlToken,'muted'));
      if (user.skip) copy.appendChild(node('p','跳过：' + user.skip,'review-skip'));
      for (const evidence of user.evidence || []) copy.appendChild(node('p',(sourceNames[evidence.source] || evidence.source) + ' · 命中「' + evidence.keyword + '」：' + evidence.text));
      if (!user.evidence?.length) copy.appendChild(node('p','来自' + (reviewNames[review.type] || '候选名单') + '，未按关键词筛选。'));
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
  async function refreshRules(apply = false) {
    const rules = await ZBStorage.getRules(); settings = await ZBStorage.getSettings();
    $('ruleCount').textContent = rules.length ? rules.length + ' 条' : '';
    $('ruleList').replaceChildren(); $('noRules').style.display = rules.length ? 'none' : 'block';
    for (const rule of rules) {
      const row = node('div','','rule-item'), copy = node('div','','rule-copy');
      copy.append(node('span',rule.keyword,'rule-keyword'),node('span',' ' + rule.sources.map(s => sourceNames[s]).join('、'),'rule-sources'));
      if (rule.exclude.length) copy.appendChild(node('div','排除：' + rule.exclude.join('、'),'rule-sources'));
      const remove = node('button','删除','btn btn-danger');
      remove.onclick = () => ZBStorage.removeRule(rule.id).then(() => refreshRules()).catch(error);
      row.append(copy,remove); $('ruleList').appendChild(row);
    }
    $('speedMode').textContent = !settings.autoMode ? '先预览再拉黑' : '自动拉黑开启';
    if (apply) {
      document.querySelectorAll('input[name="source"]').forEach(cb => { cb.checked = settings.ruleSourceDefaults.includes(cb.value); });
      $('autoModeInput').checked = settings.autoMode;
      $('intervalMin').value = settings.blockIntervalMin / 1000; $('intervalMax').value = settings.blockIntervalMax / 1000;
      $('pageIntervalInput').value = settings.pageInterval / 1000; $('blockConcurrencyInput').value = settings.blockConcurrency;
      $('whitelistInput').value = settings.whitelist.join('\n');
    }
  }
  async function start(action,input,answerId) {
    if (starting || task && ['running','paused'].includes(task.status)) return;
    starting = true; renderTask(task);
    $('actionHint').classList.remove('error'); $('actionHint').textContent = '正在读取候选，仅预览…';
    try {
      const response = await send({action,answerId,maxUsers:Math.max(1,Math.min(200,Number(input.value) || 100))});
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
      if (['followers','followees'].includes(context.type) && !context.listUnavailable) control(context.type,context.type === 'followers' ? '预览粉丝名单' : '预览关注名单','previewFollowList');
      if (context.answers?.length) control('voters','预览所选回答赞同者','previewAnswerVoters',context.answers);
      $('actionHint').classList.remove('error');
      $('actionHint').textContent = context.listUnavailable || (settings.autoMode ? '自动拉黑开启，会跳过预览；如需手动选择，请先在设置中关闭。' : '只读取候选，勾选后才会拉黑。名单关联不等于关键词命中。');
      const preview = node('button','预览当前页面规则匹配','btn btn-secondary btn-full'); preview.dataset.startTask = 'rules';
      preview.style.marginTop = '10px'; preview.onclick = () => start('previewRules',{value:200}); $('pageSpecialActions').appendChild(preview);
      renderTask(task);
    } catch (e) { $('pageStatus').textContent = '页面暂不可用'; $('pageSpecialActions').replaceChildren(); error(e); }
  }
  $('addRuleBtn').onclick = async () => {
    const keyword = $('keywordInput').value.trim(), sources = [...document.querySelectorAll('input[name="source"]:checked')].map(cb => cb.value);
    if (!keyword) return;
    if (!sources.length) { error('请至少选择一个匹配来源'); return; }
    try {
      await ZBStorage.addRule(keyword,sources,ZBStorage.words($('excludeInput').value));
      $('keywordInput').value = ''; $('excludeInput').value = ''; await refreshRules();
    } catch (e) { error(e); }
  };
  $('keywordInput').addEventListener('keydown',e => { if (e.key === 'Enter') $('addRuleBtn').click(); });
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
      saved.autoMode = $('autoModeInput').checked;
      saved.blockIntervalMin = bounded('intervalMin',30) * 1000;
      saved.blockIntervalMax = Math.max(saved.blockIntervalMin,bounded('intervalMax',30) * 1000);
      saved.pageInterval = bounded('pageIntervalInput',10) * 1000;
      saved.blockConcurrency = Math.max(1,Math.floor(bounded('blockConcurrencyInput',20)) || 5);
      saved.whitelist = whitelist; saved.ruleSourceDefaults = [...document.querySelectorAll('input[name="source"]:checked')].map(cb => cb.value);
      await ZBStorage.saveSettings(saved); await refreshRules(); await detectPage();
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
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'taskUpdate') { renderTask(message.task); renderStats(message.stats); } });
  chrome.storage.onChanged.addListener((changes,area) => { if (area === 'sync' && (changes.rules || changes.settings)) refreshRules().catch(error); });
  await refreshRules(true); await detectPage();
  try { const state = await send({action:'getState'}); renderTask(state.task); renderStats(state.stats); renderReview(state.review); if (state.error) error(state.error); } catch (e) { error(e); }
});
