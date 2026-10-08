document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const sourceNames = { bio:'签名', comment:'评论', answer:'回答', article:'文章' };
  const pageNames = { feed:'知乎普通页面', answer:'回答页面', question:'问题页面', article:'文章页面', followers:'粉丝页面', followees:'关注列表页面', profile:'个人主页' };
  let task = null, settings = {}, starting = false, retryTimer;
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
  const error = e => { $('actionHint').classList.add('error'); $('actionHint').textContent = e.message || String(e); };
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
    $('speedMode').textContent = !settings.autoMode ? '自动匹配关闭' : '自动匹配开启';
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
    $('actionHint').classList.remove('error'); $('actionHint').textContent = '正在确认登录账号…';
    try {
      const response = await send({action,answerId,maxUsers:Math.max(1,Math.min(2000,Number(input.value) || 100))});
      if (response.busy) error('已有任务，请继续或结束该任务'); renderTask(response.task);
      if (!response.busy) $('actionHint').textContent = '任务进度会自动保存，可暂停后继续。';
    } catch (e) { error(e); } finally { starting = false; renderTask(task); }
  }
  function control(label,caption,action,answers) {
    const wrap = node('div','','voter-controls'), limit = node('label','最多检查 '), input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.max = '2000'; input.value = '100';
    limit.append(input,document.createTextNode(' 人（含跳过）')); wrap.appendChild(limit);
    let picker;
    if (answers) {
      picker = document.createElement('select'); picker.setAttribute('aria-label','选择回答');
      for (const answer of answers) {
        const option = node('option',(answer.author ? answer.author + '：' : '') + (answer.excerpt || '回答 ' + answer.answerId));
        option.value = answer.answerId; picker.appendChild(option);
      }
      wrap.appendChild(picker);
    }
    const button = node('button',caption,'btn btn-danger'); button.dataset.startTask = label;
    button.onclick = () => start(action,input,picker?.value);
    wrap.appendChild(button); $('pageSpecialActions').appendChild(wrap);
  }
  async function detectPage() {
    try {
      const context = await send({action:'getPageContext'});
      $('pageStatus').textContent = '当前页面：' + (pageNames[context.type] || '知乎页面');
      $('pageSpecialActions').replaceChildren();
      if (['followers','followees'].includes(context.type) && !context.listUnavailable) control(context.type,context.type === 'followers' ? '拉黑粉丝名单' : '拉黑关注名单','blockFollowList');
      if (context.answers?.length) control('voters','拉黑所选回答赞同者','blockAnswerVoters',context.answers);
      $('actionHint').classList.remove('error');
      $('actionHint').textContent = context.listUnavailable || '规则匹配已加载的本人内容。名单会整批处理，跳过白名单和本插件已记录的用户。';
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
      await ZBStorage.saveSettings(saved); await refreshRules();
      $('saveSettingsBtn').textContent = '已保存'; setTimeout(() => { $('saveSettingsBtn').textContent = '保存设置'; },1500);
    } catch (e) { error(e); }
  };
  $('taskToggleBtn').onclick = async () => { try { renderTask((await send({action:task.status === 'running' ? 'pauseTask' : 'resumeTask'})).task); } catch (e) { error(e); } };
  $('taskEndBtn').onclick = async () => { try { renderTask((await send({action:'endTask'})).task); } catch (e) { error(e); } };
  $('refreshPageBtn').onclick = detectPage;
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'taskUpdate') { renderTask(message.task); renderStats(message.stats); } });
  chrome.storage.onChanged.addListener((changes,area) => { if (area === 'sync' && (changes.rules || changes.settings)) refreshRules().catch(error); });
  await refreshRules(true); await detectPage();
  try { const state = await send({action:'getState'}); renderTask(state.task); renderStats(state.stats); if (state.error) error(state.error); } catch (e) { error(e); }
});
