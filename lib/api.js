/** 网页内部接口，仅由 background 调用；真实兼容性须在当前登录环境验证。 */
const ZhihuAPI = (() => {
  const BASE = 'https://www.zhihu.com/api/v4';
  const apiError = (message, status = 0, retryAt = 0) => Object.assign(new Error(message), { status, retryAt });
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { ...options, credentials: 'include', signal: controller.signal });
      if (!response.ok) {
        const label = { 401: '登录已失效', 403: '接口拒绝访问，请检查登录、权限或页面验证',
          404: '当前接口或目标不可用', 429: '请求频率受限，请稍后继续' }[response.status] || '接口请求失败';
        const retry = response.headers.get('Retry-After');
        const retryAt = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry || '') || 0;
        throw apiError(label + '（' + response.status + '）', response.status, retryAt);
      }
      if (options.method === 'POST') {
        const text = await response.text();
        if (text) {
          let data;
          try { data = JSON.parse(text); } catch { throw Object.assign(apiError('拉黑响应无法识别，请在知乎屏蔽列表核对结果'), { uncertain: true }); }
          if (data.error || data.success === false) throw apiError('知乎返回拉黑失败，请在页面核对结果');
        }
        return true;
      }
      let data;
      try { data = await response.json(); } catch { throw apiError('接口返回格式不受支持'); }
      if (data.error) throw apiError('知乎返回接口错误，请核对登录或权限');
      return data;
    } catch (error) {
      if ('status' in error) throw error;
      throw Object.assign(apiError(error.name === 'AbortError' ? '请求超时，任务已暂停' : '网络请求失败，任务已暂停'), { uncertain: options.method === 'POST' });
    } finally { clearTimeout(timeout); }
  }
  function requireToken(value) {
    const token = ZBStorage.tokenFrom(value);
    if (!token) throw apiError('用户标识无效'); return token;
  }
  function listPath(type, id) {
    if (type === 'voters' && /^\d+$/.test(String(id))) return '/answers/' + id + '/upvoters';
    if (['followers', 'followees'].includes(type)) return '/members/' + encodeURIComponent(requireToken(id)) + '/' + type;
    throw apiError('名单类型或目标标识无效');
  }
  async function currentAccount() {
    const data = await request(BASE + '/me');
    if (!data.url_token) throw apiError('无法确认当前知乎账号，请先登录知乎');
    return requireToken(data.url_token);
  }
  async function blockUser(token) {
    return request(BASE + '/members/' + encodeURIComponent(requireToken(token)) + '/actions/block', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_types: ['block-essential'] }),
    });
  }
  async function getPage(type, id, cursor = null) {
    const pathname = '/api/v4' + listPath(type, id);
    const url = new URL(cursor || 'https://www.zhihu.com' + pathname + '?offset=0&limit=20');
    const valid = u => u.origin === 'https://www.zhihu.com' && u.pathname === pathname && !u.username && !u.password;
    if (!valid(url)) throw apiError('分页地址不受支持，已停止');
    const data = await request(url.href);
    if (!Array.isArray(data.data) || typeof data.paging?.is_end !== 'boolean') throw apiError('名单返回结构不受支持，已停止');
    const seen = new Set(), users = [];
    for (const item of data.data) {
      const member = item?.member || item?.author || item?.user || item;
      const token = ZBStorage.tokenFrom(member?.url_token || member?.urlToken);
      if (!token || seen.has(token)) continue;
      seen.add(token); users.push({ urlToken: token, name: String(member.name || member.fullname || '').slice(0, 80) });
    }
    if (data.data.length && !users.length) throw apiError('名单中没有可识别的用户标识，已停止');
    let next = null;
    if (!data.paging.is_end) {
      if (!users.length) throw apiError('分页返回空名单但未结束，已停止');
      if (data.paging.next) next = new URL(data.paging.next, url).href;
      else {
        const offset = Number(url.searchParams.get('offset'));
        if (!Number.isFinite(offset)) throw apiError('分页缺少可用游标，已停止');
        const nextUrl = new URL(url);
        nextUrl.searchParams.set('offset', String(offset + data.data.length)); next = nextUrl.href;
      }
      const nextUrl = new URL(next);
      if (!valid(nextUrl) || next === url.href) throw apiError('分页游标无效，已停止');
    }
    return { users, next, total: Number(data.paging.totals || data.paging.total) || users.length };
  }
  return { currentAccount, blockUser, getPage };
})();
