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
  const dailyLimitEl = document.getElementById('dailyLimit');
  const totalBlockedEl = document.getElementById('totalBlocked');
  const specialActions = document.getElementById('pageSpecialActions');
  const actionProgress = document.getElementById('actionProgress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const pageStatus = document.getElementById('pageStatus');
  const actionHint = document.getElementById('actionHint');
  const refreshPageBtn = document.getElementById('refreshPageBtn');
  const sourceCheckboxes = Array.from(document.querySelectorAll('input[name="source"]'));

  const SOURCE_LABELS = { bio: '签名', comment: '评论', answer: '回答', article: '文章' };
  const PAGE_TYPE_LABELS = {
    feed: '知乎普通页面',
    answer: '回答页面',
    article: '文章页面',
    followers: '粉丝页面',
    followees: '关注列表页面',
    profile: '个人主页',
  };
  let isOperating = false;
  let currentPageType = null;

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
    dailyLimitEl.textContent = settings.dailyLimit;
    totalBlockedEl.textContent = Object.keys(blocked).length;

    document.getElementById('dailyLimitInput').value = settings.dailyLimit;
    document.getElementById('intervalMin').value = settings.blockIntervalMin / 1000;
    document.getElementById('intervalMax').value = settings.blockIntervalMax / 1000;
    document.getElementById('pageIntervalInput').value = settings.pageInterval / 1000;

    // 检测当前页面类型，显示对应操作
    await detectPageActions();
  }

  // ── 页面类型检测 + 动态操作按钮 ─────────────
  async function detectPageActions() {
    const rules = await ZBStorage.getRules();
    try {
      const resp = await sendToBackground({ action: 'getPageContext' });
      const type = resp.type;
      currentPageType = type;

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

      if (type === 'answer') {
        // 回答点赞者
        const wrap = document.createElement('div');
        wrap.className = 'voter-controls';
        wrap.innerHTML = `
          <label>最多 <input type="number" id="voterMax" value="100" min="1" max="2000"> 人</label>
          <button class="btn btn-danger" id="blockVotersBtn">拉黑回答点赞者</button>
        `;
        specialActions.appendChild(wrap);
        document.getElementById('blockVotersBtn').onclick = () => blockVoters();
        hints.push('回答点赞者会通过接口分页获取，不受当前页面可见人数限制。');
      }

      // 评论喜爱者列表目前没有确认可用接口，仅显示诊断提示。
      if (type === 'answer' || type === 'feed' || type === 'article') {
        const comments = resp.comments || [];
        if (comments.length > 0) {
          hints.push(`已识别到 ${comments.length} 条当前可见评论，但知乎没有确认开放评论喜爱者名单接口，暂不提供拉黑评论喜爱者。`);
        } else {
          hints.push('评论喜爱者功能暂不可用：目前只看到喜爱数量，没有可稳定获取喜爱者名单的接口。');
        }
      }

      if (rules.length > 0) {
        if (type === 'feed' || type === 'answer' || type === 'article' || type === 'profile') {
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

    try {
      const label = currentPageType === 'followers' ? '粉丝' : '关注的人';
      const maxUsers = parseInt(document.getElementById('followMax')?.value) || 100;
      showProgress(`正在获取${label}...`, '');
      const resp = await sendToBackground({ action: 'blockFollowList', maxUsers });
      const r = resp.result;
      showProgress(`完成！获取 ${resp.totalFetched || resp.count || 0} 人，拉黑 ${r.blocked}，跳过 ${r.skipped}，失败 ${r.failed}`, '');
      refresh();
    } catch (e) {
      showProgress('出错：' + e.message, '');
    }

    isOperating = false;
  }

  // ── 拉黑点赞者 ──────────────────────────────
  async function blockVoters() {
    if (isOperating) return;
    isOperating = true;

    const maxUsers = parseInt(document.getElementById('voterMax')?.value) || 100;

    try {
      showProgress('正在获取点赞者...', '');
      const resp = await sendToBackground({ action: 'blockAnswerVoters', maxUsers });
      if (resp.error) {
        showProgress('出错：' + resp.error, '');
      } else {
        const r = resp.result;
        showProgress(`完成！获取 ${resp.totalFetched} 人，拉黑 ${r.blocked}，跳过 ${r.skipped}，失败 ${r.failed}`, '');
      }
      refresh();
    } catch (e) {
      showProgress('出错：' + e.message, '');
    }

    isOperating = false;
  }

  // ── 进度显示 ────────────────────────────────
  function showProgress(text, pct) {
    actionProgress.style.display = 'flex';
    progressText.textContent = text;
    if (pct === '') {
      progressFill.style.width = '100%';
    } else if (pct == null) {
      progressFill.style.width = '0%';
    } else {
      progressFill.style.width = pct;
    }
  }

  // 监听 content script 发来的进度消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'blockProgress') {
      if (msg.reason === 'fetching') {
        showProgress(msg.name, '');
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

  document.getElementById('saveSettingsBtn').onclick = async () => {
    const settings = await ZBStorage.getSettings();
    const minDelay = parseFloat(document.getElementById('intervalMin').value);
    const maxDelay = parseFloat(document.getElementById('intervalMax').value);
    const pageDelay = parseFloat(document.getElementById('pageIntervalInput').value);

    settings.dailyLimit = Math.max(10, parseInt(document.getElementById('dailyLimitInput').value) || 100);
    settings.autoMode = true;
    settings.blockIntervalMin = Math.max(0, Number.isFinite(minDelay) ? minDelay * 1000 : 0);
    settings.blockIntervalMax = Math.max(settings.blockIntervalMin, Number.isFinite(maxDelay) ? maxDelay * 1000 : 0);
    settings.pageInterval = Math.max(0, Number.isFinite(pageDelay) ? pageDelay * 1000 : 0);
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
