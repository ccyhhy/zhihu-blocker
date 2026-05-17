/**
 * Popup 脚本 — 所有操作通过 background 转发到页面脚本
 */
document.addEventListener('DOMContentLoaded', async () => {
  // ── 元素引用 ────────────────────────────────
  const keywordInput = document.getElementById('keywordInput');
  const addRuleBtn = document.getElementById('addRuleBtn');
  const ruleList = document.getElementById('ruleList');
  const noRules = document.getElementById('noRules');
  const dailyCountEl = document.getElementById('dailyCount');
  const speedModeEl = document.getElementById('speedMode');
  const totalBlockedEl = document.getElementById('totalBlocked');
  const specialActions = document.getElementById('pageSpecialActions');
  const actionProgress = document.getElementById('actionProgress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const pageStatus = document.getElementById('pageStatus');
  const actionHint = document.getElementById('actionHint');
  const refreshPageBtn = document.getElementById('refreshPageBtn');
  const headerSettingsBtn = document.getElementById('headerSettingsBtn');
  const sourceCheckboxes = Array.from(document.querySelectorAll('input[name="source"]'));

  const SOURCE_LABELS = { bio: '签名', comment: '评论', answer: '回答', article: '文章' };
  const PAGE_TYPE_LABELS = {
    feed: '知乎普通页面',
    answer: '回答页面',
    question: '问题页面',
    article: '文章页面',
    followers: '粉丝页面',
    followees: '关注列表页面',
    profile: '个人主页',
  };
  let isOperating = false;
  let currentPageType = null;
  let lastProgressPercent = 0;
  let currentAnswerId = null;

  async function saveRuleSourceDefaults() {
    const settings = await ZBStorage.getSettings();
    settings.ruleSourceDefaults = sourceCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
    await ZBStorage.saveSettings(settings);
  }

  function applyRuleSourceDefaults(settings) {
    const defaults = Array.isArray(settings.ruleSourceDefaults) && settings.ruleSourceDefaults.length
      ? settings.ruleSourceDefaults
      : ['bio', 'comment', 'answer'];
    sourceCheckboxes.forEach(cb => {
      cb.checked = defaults.includes(cb.value);
    });
  }

  async function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ target: 'background', ...msg }, resp => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || '插件通信失败'));
        } else {
          if (resp?.error) {
            reject(new Error(resp.error));
            return;
          }
          resolve(resp);
        }
      });
    });
  }

  // ── 加载状态 ────────────────────────────────
  async function refresh() {
    const rules = await ZBStorage.getRules();
    const settings = await ZBStorage.getSettings();
    const dailyCount = await ZBStorage.getDailyCount();
    const blocked = await ZBStorage.getBlockedSet();

    if (!settings.autoMode) {
      settings.autoMode = true;
      await ZBStorage.saveSettings(settings);
    }

    renderRules(rules);
    applyRuleSourceDefaults(settings);
    dailyCountEl.textContent = dailyCount;
    speedModeEl.textContent = settings.blockIntervalMin === 0 && settings.blockIntervalMax === 0 ? '极速' : '限速';
    totalBlockedEl.textContent = Object.keys(blocked).length;

    document.getElementById('intervalMin').value = settings.blockIntervalMin / 1000;
    document.getElementById('intervalMax').value = settings.blockIntervalMax / 1000;
    document.getElementById('pageIntervalInput').value = settings.pageInterval / 1000;
    document.getElementById('blockConcurrencyInput').value = settings.blockConcurrency || 5;

    // 检测当前页面类型，显示对应操作
    await detectPageActions();
  }

  // ── 页面类型检测 + 动态操作按钮 ─────────────
  async function detectPageActions() {
    const rules = await ZBStorage.getRules();
    try {
      const resp = await sendToBackground({ action: 'getPageContext' });
      const type = resp.type;
      const answers = Array.isArray(resp.answers) ? resp.answers : [];
      currentPageType = type;
      currentAnswerId = resp.answerId || answers[0]?.answerId || null;

      specialActions.innerHTML = '';
      actionHint.textContent = '';
      pageStatus.textContent = `当前页面：${PAGE_TYPE_LABELS[type] || '知乎页面'}`;

      const hints = [];

      if (type === 'followers' || type === 'followees') {
        const label = type === 'followers' ? '关注者' : '关注的人';
        const wrap = document.createElement('div');
        wrap.className = 'voter-controls';
        wrap.innerHTML = `
          <label>最多 <input type="number" id="followMax" value="100" min="1" max="2000"> 人</label>
          <button class="btn btn-danger" id="blockFollowListBtn">拉黑${label}</button>
        `;
        specialActions.appendChild(wrap);
        document.getElementById('blockFollowListBtn').onclick = () => blockFollowers();
        hints.push(`${label}会通过接口分页获取，不再受当前页面已经滚动加载多少人的限制。`);
      }

      if (currentAnswerId) {
        // 回答点赞者
        const wrap = document.createElement('div');
        wrap.className = 'voter-controls';
        const answerPicker = answers.length > 1
          ? `<select id="answerPicker" title="选择当前页面识别到的回答">${answers.map(answer => `<option value="${escapeHtml(answer.answerId)}">${escapeHtml(formatAnswerOption(answer))}</option>`).join('')}</select>`
          : `<span class="answer-id-pill">回答 ${escapeHtml(currentAnswerId)}</span>`;
        wrap.innerHTML = `
          <label class="voter-limit">最多 <input type="number" id="voterMax" value="100" min="1" max="2000"> 人</label>
          ${answerPicker}
          <button class="btn btn-danger" id="blockVotersBtn">拉黑该回答赞同者</button>
        `;
        specialActions.appendChild(wrap);
        const picker = document.getElementById('answerPicker');
        if (picker) {
          picker.value = currentAnswerId;
          picker.onchange = () => { currentAnswerId = picker.value; };
        }
        document.getElementById('blockVotersBtn').onclick = () => blockVoters();
        hints.push(`已识别到 ${answers.length || 1} 个可见回答，可直接拉黑所选回答的赞同者。首页信息流建议先滚动到目标回答后点「重新识别」。`);
      } else if (type === 'feed' || type === 'question') {
        hints.push('当前可见区域还没识别到回答 ID。请先滚动到目标回答卡片，再点「重新识别」。');
      }

      // 评论喜爱者列表目前没有确认可用接口，仅显示诊断提示。
      if (type === 'answer' || type === 'question' || type === 'feed' || type === 'article') {
        const comments = resp.comments || [];
        if (comments.length > 0) {
          hints.push(`已识别到 ${comments.length} 条当前可见评论，但知乎没有确认开放评论喜爱者名单接口，暂不提供拉黑评论喜爱者。`);
        } else {
          hints.push('评论喜爱者功能暂不可用：目前只看到喜爱数量，没有可稳定获取喜爱者名单的接口。');
        }
      }

      if (rules.length > 0) {
        if (type === 'feed' || type === 'answer' || type === 'question' || type === 'article' || type === 'profile') {
          hints.unshift(`当前已启用 ${rules.length} 条关键词规则，会自动扫描当前已加载内容。`);
        }
      } else {
        hints.unshift('还没有关键词规则，添加后会自动扫描当前已加载内容。');
      }

      if (specialActions.innerHTML === '' && rules.length === 0) {
        specialActions.innerHTML = '<div class="empty-hint empty-hint-left">这个页面暂时没有可直接执行的动作。</div>';
      }

      actionHint.textContent = hints.join(' ');
    } catch (e) {
      // 不在知乎页面或 content script 未加载
      currentPageType = null;
      pageStatus.textContent = '当前不是可用的知乎页面';
      actionHint.textContent = '请先打开知乎页面。如果页面刚打开，刷新一下知乎页面后再试。';
      specialActions.innerHTML = '<div class="empty-hint">请打开知乎页面使用</div>';
    }
  }

  // ── 拉黑关注者/粉丝 ─────────────────────────
  async function blockFollowers() {
    if (isOperating) return;
    isOperating = true;
    lastProgressPercent = 0;

    try {
      const label = currentPageType === 'followers' ? '粉丝' : '关注的人';
      const maxUsers = parseInt(document.getElementById('followMax')?.value) || 100;
      showProgress(`正在获取${label}...`, null);
      const resp = await sendToBackground({ action: 'blockFollowList', maxUsers });
      const r = resp.result;
      showProgress(`完成！获取 ${resp.totalFetched || resp.count || 0} 人，拉黑 ${r.blocked}，跳过 ${r.skipped}，失败 ${r.failed}`, '100%');
      refresh();
    } catch (e) {
      showProgress('出错：' + e.message, '100%');
    }

    isOperating = false;
  }

  // ── 拉黑点赞者 ──────────────────────────────
  async function blockVoters() {
    if (isOperating) return;
    isOperating = true;
    lastProgressPercent = 0;

    const maxUsers = parseInt(document.getElementById('voterMax')?.value) || 100;

    try {
      showProgress('正在获取点赞者...', null);
      const resp = await sendToBackground({ action: 'blockAnswerVoters', maxUsers, answerId: currentAnswerId });
      if (resp.error) {
        showProgress('出错：' + resp.error, '100%');
      } else {
        const r = resp.result;
        showProgress(`完成！获取 ${resp.totalFetched} 人，拉黑 ${r.blocked}，跳过 ${r.skipped}，失败 ${r.failed}`, '100%');
      }
      refresh();
    } catch (e) {
      showProgress('出错：' + e.message, '100%');
    }

    isOperating = false;
  }

  // ── 进度显示 ────────────────────────────────
  function showProgress(text, pct) {
    actionProgress.style.display = 'flex';
    progressText.textContent = text;
    actionProgress.classList.toggle('is-pending', pct == null);

    if (pct == null) {
      progressFill.style.width = '8%';
      return;
    }

    const nextPercent = Math.max(lastProgressPercent, parseInt(pct, 10) || 0);
    lastProgressPercent = Math.min(100, nextPercent);
    progressFill.style.width = lastProgressPercent + '%';
  }

  // 监听 content script 发来的进度消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'blockProgress') {
      if (msg.reason === 'fetching') {
        showProgress(msg.name, null);
      } else {
        const pct = msg.total > 0 ? Math.round((msg.current / msg.total) * 100) + '%' : '';
        const status = msg.success ? '已拉黑' : (msg.reason === 'duplicate' ? '跳过' : '失败');
        showProgress(`${msg.current}/${msg.total} ${msg.name} — ${status}`, pct);
      }
    }
    if (msg.type === 'autoBlockUpdate') {
      refresh();
    }
  });

  // ── 规则管理 ────────────────────────────────
  function renderRules(rules) {
    ruleList.innerHTML = '';
    noRules.style.display = rules.length ? 'none' : 'block';

    rules.forEach(rule => {
      const el = document.createElement('div');
      el.className = 'rule-item';
      const div = document.createElement('div');
      div.innerHTML = `<span class="rule-keyword">${escapeHtml(rule.keyword)}</span> <span class="rule-sources">${rule.sources.map(s => SOURCE_LABELS[s]).join('、')}</span>`;
      el.appendChild(div);
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger';
      delBtn.textContent = '删除';
      delBtn.onclick = async () => {
        await ZBStorage.removeRule(rule.id);
        refresh();
      };
      el.appendChild(delBtn);
      ruleList.appendChild(el);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatAnswerOption(answer) {
    const author = answer.author ? `${answer.author}：` : '';
    const excerpt = answer.excerpt || `回答 ${answer.answerId}`;
    return `${author}${excerpt}`.slice(0, 46);
  }

  sourceCheckboxes.forEach(cb => {
    cb.addEventListener('change', saveRuleSourceDefaults);
  });

  addRuleBtn.onclick = async () => {
    const keyword = keywordInput.value.trim();
    if (!keyword) return;
    const sources = Array.from(document.querySelectorAll('input[name="source"]:checked')).map(cb => cb.value);
    if (sources.length === 0) { alert('请至少选择一个匹配来源'); return; }
    await saveRuleSourceDefaults();
    await ZBStorage.addRule(keyword, sources);
    keywordInput.value = '';
    refresh();
  };

  keywordInput.addEventListener('keydown', e => { if (e.key === 'Enter') addRuleBtn.click(); });

  // ── 设置面板 ────────────────────────────────
  const settingsToggle = document.getElementById('settingsToggle');
  const settingsBody = document.getElementById('settingsBody');

  settingsToggle.onclick = () => {
    const visible = settingsBody.style.display !== 'none';
    settingsBody.style.display = visible ? 'none' : 'block';
    settingsToggle.classList.toggle('open', !visible);
  };

  headerSettingsBtn.onclick = () => {
    settingsBody.style.display = 'block';
    settingsToggle.classList.add('open');
    document.getElementById('intervalMin').focus();
  };

  document.getElementById('saveSettingsBtn').onclick = async () => {
    const settings = await ZBStorage.getSettings();
    const minDelay = parseFloat(document.getElementById('intervalMin').value);
    const maxDelay = parseFloat(document.getElementById('intervalMax').value);
    const pageDelay = parseFloat(document.getElementById('pageIntervalInput').value);
    const blockConcurrency = parseInt(document.getElementById('blockConcurrencyInput').value);

    settings.autoMode = true;
    settings.blockIntervalMin = Math.max(0, Number.isFinite(minDelay) ? minDelay * 1000 : 0);
    settings.blockIntervalMax = Math.max(settings.blockIntervalMin, Number.isFinite(maxDelay) ? maxDelay * 1000 : 0);
    settings.pageInterval = Math.max(0, Number.isFinite(pageDelay) ? pageDelay * 1000 : 0);
    settings.blockConcurrency = Math.max(1, Math.min(20, Number.isFinite(blockConcurrency) ? blockConcurrency : 5));
    settings.fastNoDelayMigrated = true;
    await ZBStorage.saveSettings(settings);
    refresh();
    const btn = document.getElementById('saveSettingsBtn');
    btn.textContent = '已保存';
    setTimeout(() => btn.textContent = '保存设置', 1500);
  };

  refreshPageBtn.onclick = () => {
    pageStatus.textContent = '正在重新识别页面...';
    actionHint.textContent = '';
    detectPageActions();
  };

  // ── 初始化 ──────────────────────────────────
  refresh();
});
