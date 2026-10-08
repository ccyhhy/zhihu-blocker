/** 增量识别页面；单个观察器，不在页面调用拉黑接口。 */
(async () => {
  let rules = [], settings = {}, valid = true, scanning = false, sending = false, generation = 0;
  let timer = null, maxTimer = null, retryTimer = null, fingerprints = new WeakMap();
  const dirty = new Set(), pending = new Map(), accepted = new Set();
  function stop() {
    valid = false; observer.disconnect();
    clearTimeout(timer); clearTimeout(maxTimer); clearTimeout(retryTimer);
    chrome.storage.onChanged.removeListener(onChanged);
  }
  function send(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ target: 'background', ...message }, response => {
          const error = chrome.runtime.lastError;
          if (error) { stop(); reject(new Error(error.message)); }
          else resolve(response || {});
        });
      } catch (error) { stop(); reject(error); }
    });
  }
  async function flush() {
    if (!valid || sending || !pending.size || !settings.autoMode) return;
    sending = true;
    const epoch = generation;
    try {
      const users = [...pending.values()].slice(0, 20), response = await send({ action: 'enqueueAuto', users, rulesSignature: JSON.stringify(rules) });
      if (epoch !== generation) return;
      for (const token of response.accepted || []) { pending.delete(token); accepted.add(token); }
      if (response.error || response.stale || response.disabled) {
        // API 或登录异常后停止自动提交，保留任务提示；由用户继续。
        pending.clear(); return;
      }
      if (response.busy && response.task?.status === 'paused') return;
      if (pending.size) {
        clearTimeout(retryTimer); retryTimer = setTimeout(flush, 2000);
      }
    } catch { /* 上下文失效已经停止观察。 */ }
    finally { sending = false; if (epoch !== generation) flush(); }
  }
  async function scanDirty() {
    clearTimeout(timer); clearTimeout(maxTimer); timer = null; maxTimer = null;
    if (!valid || scanning || !rules.length || !settings.autoMode) return;
    scanning = true;
    const epoch = generation;
    try {
      const units = [...dirty]; dirty.clear();
      // 大页面分块让出事件循环；只缓存内容指纹，节点移除后可被回收。
      for (let offset = 0; offset < units.length && valid && epoch === generation; offset += 30) {
        const changed = [];
        for (const unit of units.slice(offset, offset + 30)) {
          if (!unit.isConnected) continue;
          const fingerprint = unit.textContent + '|' + unit.querySelector('a[href*="/people/"]')?.getAttribute('href');
          if (fingerprints.get(unit) === fingerprint) continue;
          fingerprints.set(unit, fingerprint); changed.push(unit);
        }
        const matched = ZBScanner.matchUsers(ZBScanner.extractUsers(changed), rules, settings.whitelist);
        for (const user of matched) if (!accepted.has(user.urlToken)) pending.set(user.urlToken, {
          urlToken: user.urlToken, name: user.name,
          evidence: user.matchedRules.map(m => ({ keyword: m.rule.keyword, source: m.source, text: m.evidence })),
        });
        if (offset + 30 < units.length) await new Promise(resolve => setTimeout(resolve, 0));
      }
      // 后台确认账号可能等待网络；页面扫描无需等待提交结果。
      if (epoch === generation) flush();
    } finally {
      scanning = false;
      if (dirty.size) schedule();
    }
  }
  function schedule() {
    if (!valid || !rules.length || !settings.autoMode) return;
    clearTimeout(timer); timer = setTimeout(scanDirty, 500);
    if (!maxTimer) maxTimer = setTimeout(scanDirty, 2000);
  }
  function mark(root) {
    for (const unit of ZBScanner.collectUnits([root])) dirty.add(unit);
  }
  const observer = new MutationObserver(mutations => {
    if (!chrome.runtime?.id) { stop(); return; }
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      if (target) {
        // 父容器新增一张卡片时不遍历它的所有旧卡片。
        const owner = ZBScanner.closestUnit(target);
        if (owner) dirty.add(owner);
      }
      for (const node of mutation.addedNodes || []) if (node.nodeType === Node.ELEMENT_NODE) mark(node);
    }
    schedule();
  });
  async function reload() {
    const epoch = ++generation;
    observer.disconnect(); clearTimeout(timer); clearTimeout(maxTimer); clearTimeout(retryTimer);
    pending.clear(); accepted.clear(); dirty.clear();
    try {
      const values = await Promise.all([ZBStorage.getRules(), ZBStorage.getSettings()]);
      if (epoch !== generation || !valid) return;
      [rules, settings] = values;
      fingerprints = new WeakMap(); pending.clear(); accepted.clear(); dirty.clear();
      observer.disconnect(); clearTimeout(timer); clearTimeout(maxTimer); clearTimeout(retryTimer);
      if (!rules.length || !settings.autoMode) return;
      mark(document); observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] }); schedule();
    } catch { stop(); }
  }
  function onChanged(changes, area) {
    if (area === 'sync' && (changes.rules || changes.settings)) reload();
    if (area === 'local' && changes.zbTask) {
      const previous = changes.zbTask.oldValue, next = changes.zbTask.newValue;
      if (['done', 'cancelled'].includes(next?.status) || next?.status === 'running' && previous?.status === 'paused') flush();
    }
  }
  chrome.storage.onChanged.addListener(onChanged);
  async function pageMatches() {
    const [currentRules, currentSettings] = await Promise.all([ZBStorage.getRules(), ZBStorage.getSettings()]);
    const units = [...ZBScanner.collectUnits()], users = new Map();
    for (let offset = 0; offset < units.length; offset += 30) {
      const matches = ZBScanner.matchUsers(ZBScanner.extractUsers(units.slice(offset, offset + 30)), currentRules, currentSettings.whitelist);
      for (const user of matches) {
        const prior = users.get(user.urlToken);
        const evidence = user.matchedRules.map(m => ({ keyword: m.rule.keyword, source: m.source, text: m.evidence }));
        if (prior) prior.evidence = prior.evidence.concat(evidence).slice(0, 3);
        else if (users.size < 200) users.set(user.urlToken, { urlToken: user.urlToken, name: user.name, evidence });
      }
      if (offset + 30 < units.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { users: [...users.values()], rulesSignature: JSON.stringify(currentRules), limited: users.size >= 200 };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.action === 'getPageMatches') {
      pageMatches().then(respond).catch(error => respond({error: error.message}));
      return true;
    }
    if (message.action === 'getPageContext') {
      const answers = ZBScanner.extractAnswerIdsFromPage();
      respond({ type: ZBScanner.detectPageType(), profileToken: ZBScanner.extractProfileTokenFromUrl(), listUnavailable: ZBScanner.listUnavailable(),
        answerId: ZBScanner.extractAnswerIdFromUrl() || answers[0]?.answerId || null, answers });
    }
    if (message.type === 'taskUpdate' && message.task?.status === 'done') flush();
  });
  await reload();
})();
