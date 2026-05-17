/**
 * 知乎 API 封装 — 拉黑用户、获取关注者/粉丝、获取回答点赞者
 *
 * 所有请求通过 content script 的 fetch 发出，自动携带 cookie。
 * 已验证：拉黑 API 不需要 x-zse 等签名头。
 */
const ZhihuAPI = (() => {
  const BASE = 'https://www.zhihu.com/api/v4';

  /**
   * 拉黑单个用户
   * @param {string} urlToken  用户的 url_token
   * @returns {Promise<boolean>} 是否成功
   */
  async function blockUser(urlToken) {
    try {
      const resp = await fetch(`${BASE}/members/${urlToken}/actions/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_types: ['block-essential'] }),
        credentials: 'include',
      });
      return resp.ok;
    } catch (e) {
      console.error(`[知乎拉黑] 拉黑 ${urlToken} 失败:`, e);
      return false;
    }
  }

  /**
   * 获取用户的关注者列表（分页）
   * @param {string} urlToken
   * @param {number} offset
   * @param {number} limit
   * @returns {Promise<{users: Array, total: number, hasMore: boolean}>}
   */
  async function getFollowers(urlToken, offset = 0, limit = 20) {
    return _getMemberList(urlToken, 'followers', offset, limit);
  }

  /**
   * 获取用户关注的人列表（分页）
   */
  async function getFollowees(urlToken, offset = 0, limit = 20) {
    return _getMemberList(urlToken, 'followees', offset, limit);
  }

  /**
   * 获取回答的点赞者列表（分页）
   * @param {string} answerId
   * @param {number} offset
   * @param {number} limit
   * @returns {Promise<{users: Array, total: number, hasMore: boolean}>}
   */
  async function getVoters(answerId, offset = 0, limit = 20) {
    return _getVoters('answers', answerId, offset, limit);
  }

  function getBlockDelay(settings) {
    const min = Number(settings.blockIntervalMin) || 0;
    const max = Math.max(min, Number(settings.blockIntervalMax) || 0);
    return min + Math.random() * (max - min);
  }

  function wait(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getBlockConcurrency(settings) {
    const concurrency = Number(settings.blockConcurrency) || 5;
    return Math.max(1, Math.min(20, Math.floor(concurrency)));
  }

  /**
   * 批量拉黑用户列表（计数、去重；设置为 0 秒时不主动等待）
   * @param {Array<{urlToken: string, name?: string}>} users
   * @param {function} onProgress  (current, total, user, success) => void
   * @returns {Promise<{blocked: number, skipped: number, failed: number}>}
   */
  async function batchBlock(users, onProgress) {
    let blocked = 0, skipped = 0, failed = 0;
    const total = users.length;
    const state = await ZBStorage.getBlockState();
    const firstDelay = getBlockDelay(state.settings);

    if (firstDelay <= 0) {
      return batchBlockConcurrent(users, state, getBlockConcurrency(state.settings), onProgress);
    }

    const delayMs = () => getBlockDelay(state.settings);

    for (let i = 0; i < total; i++) {
      // 去重
      if (state.blockedUsers[users[i].urlToken]) {
        skipped++;
        onProgress?.(i + 1, total, users[i], false, 'duplicate');
        continue;
      }

      // 拉黑
      const ok = await blockUser(users[i].urlToken);
      if (ok) {
        state.blockedUsers[users[i].urlToken] = Date.now();
        state.dailyCount++;
        blocked++;
        onProgress?.(i + 1, total, users[i], true, 'ok');
      } else {
        failed++;
        onProgress?.(i + 1, total, users[i], false, 'error');
        // 失败时停止
        await ZBStorage.saveBlockState(state);
        return { blocked, skipped, failed: total - i };
      }

      // 延迟（最后一个不需要）
      if (i < total - 1) {
        await wait(delayMs());
      }
    }

    await ZBStorage.saveBlockState(state);
    return { blocked, skipped, failed };
  }

  async function batchBlockConcurrent(users, state, concurrency, onProgress) {
    let blocked = 0, skipped = 0, failed = 0, completed = 0, nextIndex = 0;
    const total = users.length;

    async function worker() {
      while (nextIndex < total) {
        const index = nextIndex++;
        const user = users[index];

        if (state.blockedUsers[user.urlToken]) {
          skipped++;
          completed++;
          onProgress?.(completed, total, user, false, 'duplicate');
          continue;
        }

        const ok = await blockUser(user.urlToken);
        completed++;

        if (ok) {
          state.blockedUsers[user.urlToken] = Date.now();
          state.dailyCount++;
          blocked++;
          onProgress?.(completed, total, user, true, 'ok');
        } else {
          failed++;
          onProgress?.(completed, total, user, false, 'error');
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);

    await ZBStorage.saveBlockState(state);
    return { blocked, skipped, failed };
  }

  /**
   * 翻页获取全部用户（关注者/粉丝/点赞者）
   * @param {string} type  'followers' | 'followees' | 'voters'
   * @param {string} id    url_token 或 answer_id
   * @param {number} maxUsers  最大获取数量
   * @param {function} onProgress  (fetched, estimated) => void
   * @returns {Promise<Array>}
   */
  async function fetchAllUsers(type, id, maxUsers = 500, onProgress) {
    const users = [];
    const seen = new Set();
    let offset = 0;
    const limit = 20;
    let hasMore = true;
    const max = Math.max(1, Number(maxUsers) || 500);

    while (hasMore && users.length < max) {
      let result;
      if (type === 'voters') {
        result = await getVoters(id, offset, limit);
      } else if (type === 'followers') {
        result = await getFollowers(id, offset, limit);
      } else {
        result = await getFollowees(id, offset, limit);
      }

      for (const user of result.users) {
        if (!user.urlToken || seen.has(user.urlToken)) continue;
        seen.add(user.urlToken);
        users.push(user);
        if (users.length >= max) break;
      }
      hasMore = result.hasMore;
      offset += limit;

      onProgress?.(users.length, result.total);

      if (result.users.length === 0) {
        break;
      }

      if (hasMore && users.length < max) {
        await ZBStorage.pageDelay();
      }
    }

    return users.slice(0, max);
  }

  // ── 内部辅助 ──────────────────────────────────────────
  async function _getVoters(resourceType, id, offset, limit) {
    try {
      const result = await _getUserListByUrl(`${BASE}/${resourceType}/${id}/voters?offset=${offset}&limit=${limit}`);
      return { users: result.users, total: result.total, hasMore: result.hasMore };
    } catch (e) {
      console.error(`[知乎拉黑] 获取 ${resourceType} 点赞者失败:`, e);
      return { users: [], total: 0, hasMore: false };
    }
  }

  async function _getMemberList(urlToken, type, offset, limit) {
    try {
      const result = await _getUserListByUrl(`${BASE}/members/${urlToken}/${type}?offset=${offset}&limit=${limit}`);
      return { users: result.users, total: result.total, hasMore: result.hasMore };
    } catch (e) {
      console.error(`[知乎拉黑] 获取 ${type} 列表失败:`, e);
      return { users: [], total: 0, hasMore: false };
    }
  }

  async function _getUserListByUrl(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return { users: [], total: 0, hasMore: false, supported: false };

    const data = await resp.json();
    const rawUsers = Array.isArray(data.data) ? data.data : [];
    const users = rawUsers.map(normalizeUser).filter(u => u.urlToken);

    return {
      users,
      total: data.paging?.totals || data.paging?.total || users.length,
      hasMore: data.paging ? !data.paging.is_end : false,
      supported: true,
    };
  }

  function normalizeUser(item) {
    const user = item?.member || item?.author || item?.target || item?.user || item;
    return {
      urlToken: user?.url_token || user?.urlToken || user?.id || '',
      name: user?.name || user?.fullname || '',
      headline: user?.headline || '',
      avatar: user?.avatar_url || user?.avatarUrl || '',
    };
  }

  return {
    blockUser,
    getFollowers,
    getFollowees,
    getVoters,
    batchBlock,
    fetchAllUsers,
  };
})();
