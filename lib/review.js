/** 按需读取并保存候选名单；只有确认的用户才交给拉黑任务。 */
const ZBReview = (() => {
  let review = null, tail = Promise.resolve();
  const ready = ZBStorage.localGet({ zbReview: null }).then(async data => {
    review = data.zbReview;
    if (review && !['voters', 'followers'].includes(review.type)) { review = null; await ZBStorage.localSet({zbReview:null}); }
  });
  const serial = fn => {
    const next = tail.then(async () => { await ready; return fn(); });
    tail = next.catch(() => {}); return next;
  };
  const save = () => ZBStorage.localSet({ zbReview: review });
  const snapshot = () => review ? JSON.parse(JSON.stringify(review)) : null;
  function requireReview(id) {
    if (!review || review.id !== id) throw new Error('预览已变更，请重新打开预览');
  }
  async function verify() {
    const account = await ZhihuAPI.currentAccount();
    if (review && account !== review.account) throw new Error('知乎账号已切换，请切回原账号或重新生成预览');
    return account;
  }
  async function filter() {
    const settings = await ZBStorage.getSettings(), data = await ZBStorage.localGet(null), whitelist = new Set(settings.whitelist);
    for (const user of review.users) {
      user.skip = user.urlToken === review.account ? '当前账号' : whitelist.has(user.urlToken) ? '白名单' :
        data['zb:block:' + review.account + ':' + user.urlToken] ? '已记录拉黑' :
        data['zb:unknown:' + review.account + ':' + user.urlToken] ? '结果待核对' : '';
    }
    const eligible = new Set(review.users.filter(user => !user.skip).map(user => user.urlToken));
    review.selected = review.selected.filter(token => eligible.has(token));
  }
  async function readPage() {
    if (review.exhausted || review.users.length >= review.maxUsers) return;
    if (Date.now() < (review.retryAt || 0)) throw new Error('接口要求等待，请稍后再读取');
    await verify();
    const page = await ZhihuAPI.getPage(review.type, review.target, review.cursor);
    await verify(); // 请求期间切换账号时，不把另一账号的名单加入本预览。
    if (review.seenCursors.includes(page.next) && page.next) throw new Error('名单分页重复，已停止读取');
    const seen = new Set(review.users.map(user => user.urlToken));
    const added = page.users.filter(user => !seen.has(user.urlToken));
    if (!added.length && page.next) throw new Error('名单分页没有新用户，已停止读取');
    review.users.push(...added.slice(0, review.maxUsers - review.users.length).map(user => ({ ...user, evidence: [] })));
    if (review.cursor) review.seenCursors.push(review.cursor);
    review.cursor = page.next; review.exhausted = !page.next;
    review.error = ''; review.retryAt = 0;
    await filter(); await save();
  }
  function selection(tokens) {
    if (!Array.isArray(tokens)) throw new Error('请选择要拉黑的用户');
    const known = new Set(review.users.map(user => user.urlToken));
    const selected = [...new Set(tokens)];
    if (selected.some(token => !known.has(token))) throw new Error('所选用户不在本次预览中');
    return selected;
  }
  async function create(spec) {
    return serial(async () => {
      if (!['voters', 'followers'].includes(spec.type)) throw new Error('当前只支持回答赞同者或粉丝名单');
      if (spec.type === 'voters' && !/^\d+$/.test(String(spec.target))) throw new Error('回答标识无效');
      if (spec.type === 'followers' && !ZBStorage.tokenFrom(spec.target)) throw new Error('用户标识无效');
      const state = await ZBTasks.getState();
      if (state.error) throw new Error(state.error);
      if (['running', 'paused'].includes(state.task?.status)) throw new Error('请先结束当前任务，再生成预览');
      review = { id: crypto.randomUUID(), account: state.stats.account, type: spec.type, target: spec.target, tabId: spec.tabId,
        users: [], selected: [], cursor: null, seenCursors: [], exhausted: false,
        maxUsers: Math.max(1, Math.min(200, Math.floor(Number(spec.maxUsers) || 100))), error: '', retryAt: 0 };
      await filter(); await save();
      try { await readPage(); } catch (error) { review.error = error.message; review.retryAt = error.retryAt || 0; await save(); }
      return { review: snapshot() };
    });
  }
  const get = () => serial(async () => snapshot());
  const more = id => serial(async () => {
    requireReview(id);
    try { await readPage(); } catch (error) { review.error = error.message; review.retryAt = error.retryAt || 0; await save(); }
    return { review: snapshot() };
  });
  const select = (id, tokens) => serial(async () => {
    requireReview(id); review.selected = selection(tokens); await save(); return { review: snapshot() };
  });
  const discard = id => serial(async () => { requireReview(id); review = null; await save(); return { review: null }; });
  const confirm = (id, tokens) => serial(async () => {
    requireReview(id); await verify();
    review.selected = selection(tokens); await filter(); await save();
    const selected = new Set(review.selected), users = review.users.filter(user => selected.has(user.urlToken));
    if (!users.length) throw new Error('没有可执行的勾选用户，请重新检查预览');
    const result = await ZBTasks.start({ type: 'selected', account: review.account, users, tabId: review.tabId });
    if (!result.busy) { review = null; await save(); }
    return { ...result, review: snapshot() };
  });
  return { create, get, more, select, discard, confirm };
})();
