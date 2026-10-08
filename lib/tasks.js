/** 单个可恢复任务。网页不写拉黑记录，不驻留所有分页名单。 */
const ZBTasks = (() => {
  let task = null, running = null, commandTail = Promise.resolve(), writeTail = Promise.resolve();
  let accountCache = null, blocked = new Set(), uncertain = new Set(), totalCount = 0, daily = 0, date = '', legacy = 0;
  const active = () => task && ['running', 'paused'].includes(task.status);
  const recordKey = (account, token) => 'zb:block:' + account + ':' + token;
  const uncertainKey = (account, token) => 'zb:unknown:' + account + ':' + token;
  const statsKey = account => 'zb:daily:' + account + ':' + ZBStorage.todayKey();
  const snapshot = value => JSON.parse(JSON.stringify(value));
  const write = value => {
    const copy = snapshot(value);
    const next = writeTail.then(() => ZBStorage.localSet(copy));
    writeTail = next.catch(() => {}); return next;
  };
  const ready = (async () => {
    const data = await ZBStorage.localGet({ zbTask: null });
    task = data.zbTask;
    let changed = false;
    if (task?.status === 'running') {
      task.status = 'paused'; task.error = '后台已重新启动，进度已保留；点击继续处理剩余用户';
      changed = true;
    }
    for (const user of task?.queue || []) if (user.state === 'inflight') {
      user.state = 'unknown'; task.unknown++; changed = true;
      task.error = '后台重启前的部分请求结果待核对；继续时不会重试这些用户';
    }
    if (task && ['auto', 'followees'].includes(task.type) && ['running', 'paused'].includes(task.status)) {
      task.status = 'cancelled'; task.error = '新版已停用关键词和关注名单任务，旧记录仍保留'; changed = true;
    }
    const holds = {};
    for (const user of task?.queue || []) if (user.state === 'unknown') holds[uncertainKey(task.account,user.urlToken)] = Date.now();
    if (changed || Object.keys(holds).length) await write({ ...holds, zbTask: task });
  })();
  function summary() {
    if (!task) return null;
    return { ...task, queue: undefined,
      remaining: task.queue.filter(u => ['pending', 'failed'].includes(u.state)).length,
      uncertainUsers: task.queue.filter(u => u.state === 'unknown').map(u => ({urlToken:u.urlToken,name:u.name || u.urlToken})),
      evidence: task.evidence || [] };
  }
  function notify() {
    try { chrome.runtime.sendMessage({ type: 'taskUpdate', task: summary(), stats: { account: accountCache, daily, total: totalCount, legacy } }, () => void chrome.runtime.lastError); } catch { /* 没有 popup 接收不影响任务。 */ }
  }
  async function persist() { await write({ zbTask: task }); notify(); }
  async function loadAccount(account) {
    if (accountCache !== account) {
      const data = await ZBStorage.localGet(null), prefix = 'zb:block:' + account + ':';
      blocked = new Set(Object.keys(data).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)));
      const unknownPrefix = 'zb:unknown:' + account + ':';
      uncertain = new Set(Object.keys(data).filter(key => key.startsWith(unknownPrefix)).map(key => key.slice(unknownPrefix.length)));
      totalCount = Number(data['zb:total:' + account]) || blocked.size;
      legacy = Object.keys(data.blockedUsers || {}).length;
      const migrationKey = 'zb:hide-migrated:' + account, imported = {};
      if (!data[migrationKey]) {
        for (const token of blocked) if (token !== account && ZBStorage.tokenFrom(token) && !data['zb:hide:' + token]) imported['zb:hide:' + token] = {name:token,at:Date.now()};
        imported[migrationKey] = true;
      }
      await write({...imported,zbAccount:account});
      accountCache = account; date = '';
    }
    const today = ZBStorage.todayKey();
    if (date !== today) {
      const key = statsKey(account);
      daily = Number((await ZBStorage.localGet({ [key]: 0 }))[key]) || 0; date = today;
    }
  }
  async function verifyAccount(expected) {
    const account = await ZhihuAPI.currentAccount();
    if (expected && expected !== account) throw new Error('知乎账号已切换，任务暂停；切回原账号后可继续');
    await loadAccount(account); return account;
  }
  function serialCommand(fn) {
    const next = commandTail.then(async () => { await ready; return fn(); });
    commandTail = next.catch(() => {}); return next;
  }
  function normalize(users) {
    const seen = new Set();
    return (Array.isArray(users) ? users : []).flatMap(user => {
      const token = ZBStorage.tokenFrom(user?.urlToken);
      if (!token || seen.has(token)) return [];
      seen.add(token);
      return [{ urlToken: token, name: String(user.name || token).slice(0, 80), state: 'pending',
        evidence: Array.isArray(user.evidence) ? user.evidence.slice(0, 3).map(e => ({
          keyword: String(e.keyword || '').slice(0, 80), source: String(e.source || '').slice(0, 20), text: String(e.text || '').slice(0, 180),
        })) : [] }];
    });
  }
  async function start(spec) {
    return serialCommand(async () => {
      if (active() || running) return { busy: true, task: summary() };
      if (!['selected', 'voters', 'followers'].includes(spec.type)) throw new Error('该任务类型已停用');
      const account = await verifyAccount(spec.account);
      const queue = normalize(spec.users).slice(0, spec.type === 'selected' ? 200 : 20);

      if (spec.type === 'voters' && !/^\d+$/.test(String(spec.target))) throw new Error('回答标识无效');
      if (spec.type === 'followers' && !ZBStorage.tokenFrom(spec.target)) throw new Error('用户标识无效');
      const limit = Number(spec.maxUsers || 0);
      if (spec.type !== 'selected' && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('处理人数请填写正整数，留空或 0 表示全部');
      task = { id: crypto.randomUUID(), account, tabId: spec.tabId, type: spec.type, target: spec.target || '',
        status: 'running', queue, cursor: null, nextCursor: null, exhausted: spec.type === 'selected',
        maxUsers: spec.type === 'selected' ? queue.length : limit,
        fetched: queue.length, blocked: 0, skipped: 0, failed: 0, unknown: 0, error: '', retryAt: 0,
        lastFingerprint: '', recentCursors: [], evidence: queue.flatMap(u => u.evidence.map(e => ({ ...e, name: u.name, urlToken: u.urlToken }))).slice(0, 5) };
      await persist(); kick();
      return { task: summary(), accepted: queue.map(u => u.urlToken) };
    });
  }
  async function pause() {
    return serialCommand(async () => {
      if (task?.status === 'running') { task.status = 'paused'; task.error = '已暂停；已发出的请求完成后会保存结果'; await persist(); }
      return { task: summary() };
    });
  }
  async function resume() {
    return serialCommand(async () => {
      if (!task || task.status !== 'paused') return { task: summary() };
      if (Date.now() < task.retryAt) throw new Error('接口要求等待，请稍后再继续');
      await verifyAccount(task.account);
      for (const user of task.queue) if (user.state === 'failed') { user.state = 'pending'; task.failed--; }
      task.status = 'running'; task.error = ''; task.retryAt = 0;
      await persist(); kick(); return { task: summary() };
    });
  }
  async function end() {
    return serialCommand(async () => {
      if (active()) { task.status = 'cancelled'; task.error = '任务已结束；已发出的请求完成后仍会保存结果'; await persist(); }
      return { task: summary() };
    });
  }
  async function getState() {
    await ready;
    let error = '';
    try { await verifyAccount(active() ? task.account : null); } catch (e) { error = e.message; }
    return { task: summary(), stats: error ? null : { account: accountCache, daily, total: totalCount, legacy }, error };
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  async function waitWhileRunning(ms) {
    const end = Date.now() + ms;
    while (task.status === 'running' && Date.now() < end) await delay(Math.min(250, end - Date.now()));
  }
  async function saveSuccess(user) {
    // 此函数通过 successTail 串行执行，日期与计数不会互相覆盖。
    await loadAccount(task.account);
    const added = !blocked.has(user.urlToken);
    if (added) {
      blocked.add(user.urlToken); daily++; totalCount++; task.blocked++;
    }
    user.state = 'done';
    try {
      await write({ [recordKey(task.account, user.urlToken)]: Date.now(),
        [statsKey(task.account)]: daily, ['zb:total:' + task.account]: totalCount,
        ['zb:hide:' + user.urlToken]: { name: user.name, at: Date.now() }, zbTask: task });
    } catch (cause) {
      if (added) { blocked.delete(user.urlToken); daily--; totalCount--; task.blocked--; }
      user.state = 'inflight';
      const error = new Error('拉黑请求已成功，但本地记录保存失败；请核对结果后再继续：' + cause.message);
      error.uncertain = true; throw error;
    }
    notify();
  }
  let successTail = Promise.resolve();
  async function pump() {
    try {
      while (task.status === 'running') {
        await verifyAccount(task.account);
        if (task.status !== 'running') break;
        const settings = await ZBStorage.getSettings(), whitelist = new Set(settings.whitelist);
        if (!task.queue.some(u => u.state === 'pending')) {
          if (task.exhausted || task.maxUsers > 0 && task.fetched >= task.maxUsers) { task.status = 'done'; await persist(); break; }
          const page = await ZhihuAPI.getPage(task.type, task.target, task.cursor);
          const fingerprint = page.users.map(u => u.urlToken).sort().join('|');
          if (fingerprint && fingerprint === task.lastFingerprint || page.next && (task.recentCursors || []).includes(page.next)) throw new Error('名单分页重复，任务已暂停');
          task.lastFingerprint = fingerprint;
          const normalized = normalize(page.users);
          task.queue = task.maxUsers > 0 ? normalized.slice(0, task.maxUsers - task.fetched) : normalized;
          task.recentCursors = [...(task.recentCursors || []), ...(page.next ? [page.next] : [])].slice(-64);
          task.fetched += task.queue.length; task.nextCursor = page.next; task.exhausted = !page.next;
          await persist();
          if (task.status !== 'running') break;
          // 名单请求可能耗时；派发前重新确认账号和最新白名单。
          continue;
        }
        for (const user of task.queue) if (user.state === 'pending' && (user.urlToken === task.account || whitelist.has(user.urlToken) || blocked.has(user.urlToken))) {
          user.state = 'done'; task.skipped++;
        }
        for (const user of task.queue) if (user.state === 'pending' && uncertain.has(user.urlToken)) {
          user.state = 'unknown'; task.unknown++;
        }
        const min = Math.max(0, Number(settings.blockIntervalMin) || 0), max = Math.max(min, Number(settings.blockIntervalMax) || 0);
        const concurrency = max > 0 ? 1 : Math.max(1, Math.min(20, Math.floor(Number(settings.blockConcurrency) || 5)));
        const chunk = task.queue.filter(u => u.state === 'pending').slice(0, concurrency);
        if (chunk.length) {
          for (const user of chunk) user.state = 'inflight';
          await persist();
          if (task.status !== 'running') {
            for (const user of chunk) user.state = 'pending';
            await persist(); break;
          }
          await Promise.all(chunk.map(async user => {
            try {
              await ZhihuAPI.blockUser(user.urlToken);
              const result = successTail.then(() => saveSuccess(user));
              successTail = result.catch(() => {}); await result;
            } catch (error) {
              const unknown = user.state === 'done' || error.uncertain;
              if (unknown) { user.state = 'unknown'; task.unknown++; uncertain.add(user.urlToken); }
              else { user.state = 'failed'; task.failed++; }
              if (task.status !== 'cancelled') task.status = 'paused';
              task.error = error.message; task.retryAt = Math.max(task.retryAt || 0, error.retryAt || 0);
              if (unknown) { await write({ [uncertainKey(task.account,user.urlToken)]: Date.now(), zbTask: task }); notify(); }
              else await persist();
            }
          }));
        } else await persist();
        if (task.status !== 'running') break;
        if (!task.queue.some(u => u.state === 'pending')) {
          task.cursor = task.nextCursor; await persist();
          await waitWhileRunning(Math.max(0, Number(settings.pageInterval) || 0));
        } else if (max > 0) await waitWhileRunning(min + Math.random() * (max - min));
      }
    } catch (error) {
      if (task.status !== 'cancelled') task.status = 'paused';
      task.error = error.message;
      task.retryAt = Math.max(task.retryAt || 0, error.retryAt || 0);
      try { await persist(); } catch { notify(); }
    }
  }
  function kick() {
    if (running) return;
    running = pump().finally(() => {
      running = null; notify();
      if (task?.status === 'running') kick();
    });
  }
  return { start, pause, resume, end, getState };
})();
