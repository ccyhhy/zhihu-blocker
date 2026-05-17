/**
 * Content script — 后台逻辑 + 评论区拉黑按钮注入
 */
(async () => {
  'use strict';

  let isBlocking = false;
  let autoBlockCount = 0;
  let contextValid = true;
  let commentObserver = null;
  let autoObserver = null;
  let autoScanTimer = null;

  // ── 扩展上下文检测 ──────────────────────────
  function isContextAlive() {
    try {
      // chrome.runtime.id 在上下文失效后会变成 undefined
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function safeSendMessage(msg) {
    if (!isContextAlive()) {
      invalidateContext();
      return Promise.resolve();
    }
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, () => {
          const err = chrome.runtime.lastError;
          if (err && /Extension context invalidated/i.test(err.message || '')) {
            invalidateContext();
          }
          resolve();
        });
      } catch {
        invalidateContext();
        resolve();
      }
    });
  }

  function invalidateContext() {
    if (!contextValid) return;
    contextValid = false;
    isBlocking = false;
    if (commentObserver) commentObserver.disconnect();
    if (autoObserver) autoObserver.disconnect();
    if (autoScanTimer) {
      clearTimeout(autoScanTimer);
      autoScanTimer = null;
    }
  }

  // ── 评论区识别 ────────────────
  function injectCommentButtons() {
    if (!contextValid) return;
    const comments = ZBScanner.extractCommentIds();
    if (comments.length > 0) {
      document.body.dataset.zbCommentsDetected = String(comments.length);
    }
  }

  injectCommentButtons();
  commentObserver = new MutationObserver(() => {
    if (contextValid) injectCommentButtons();
  });
  commentObserver.observe(document.body, { childList: true, subtree: true });

  // ── 监听 popup 消息 ────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!contextValid) return;

    if (msg.action === 'scan') {
      ZBScanner.scan().then(matched => {
        sendResponse({
          users: matched.map(u => ({
            urlToken: u.urlToken,
            name: u.name,
            matchedRules: u.matchedRules?.map(m => m.rule.keyword) || [],
          })),
        });
      }).catch(e => sendResponse({ users: [], error: e.message }));
      return true;
    }

    if (msg.action === 'blockList') {
      if (isBlocking) {
        sendResponse({ error: '正在拉黑中，请稍候' });
        return;
      }
      isBlocking = true;
      ZhihuAPI.batchBlock(msg.users, (current, total, user, success, reason) => {
        safeSendMessage({ type: 'blockProgress', current, total, name: user.name || user.urlToken, success, reason });
      }).then(result => {
        isBlocking = false;
        sendResponse({ result });
      }).catch(e => {
        isBlocking = false;
        sendResponse({ error: e.message });
      });
      return true;
    }

    if (msg.action === 'blockFollowers') {
      if (isBlocking) {
        sendResponse({ error: '正在拉黑中' });
        return;
      }
      const pageType = ZBScanner.detectPageType();
      const profileToken = ZBScanner.extractProfileTokenFromUrl();
      const listType = pageType === 'followees' ? 'followees' : 'followers';
      if (!profileToken || !['followers', 'followees'].includes(pageType)) {
        sendResponse({ error: '请先打开用户的关注者或关注列表页面' });
        return;
      }
      isBlocking = true;
      (async () => {
        const maxUsers = msg.maxUsers || 100;
        safeSendMessage({
          type: 'blockProgress',
          current: 0,
          total: 0,
          name: listType === 'followers' ? '正在获取关注者...' : '正在获取关注的人...',
          success: true,
          reason: 'fetching',
        });
        const users = await ZhihuAPI.fetchAllUsers(listType, profileToken, maxUsers, (fetched, estimated) => {
          safeSendMessage({
            type: 'blockProgress',
            current: 0,
            total: 0,
            name: `获取中 ${fetched}/${estimated || '?'}`,
            success: true,
            reason: 'fetching',
          });
        });
        if (users.length === 0) {
          isBlocking = false;
          sendResponse({ error: '未获取到用户，可能是页面类型不支持或登录状态失效' });
          return;
        }
        const result = await ZhihuAPI.batchBlock(users, (current, total, user, success, reason) => {
          safeSendMessage({ type: 'blockProgress', current, total, name: user.name || user.urlToken, success, reason });
        });
        isBlocking = false;
        sendResponse({ result, count: users.length, totalFetched: users.length, listType });
      })().catch(e => {
        isBlocking = false;
        sendResponse({ error: e.message });
      });
      return true;
    }

    if (msg.action === 'blockVoters') {
      if (isBlocking) {
        sendResponse({ error: '正在拉黑中' });
        return;
      }
      const answerId = ZBScanner.extractAnswerIdFromUrl();
      if (!answerId) {
        sendResponse({ error: '未找到回答 ID' });
        return;
      }
      isBlocking = true;
      (async () => {
        const maxUsers = msg.maxUsers || 100;
        safeSendMessage({ type: 'blockProgress', current: 0, total: 0, name: '正在获取点赞者...', success: true, reason: 'fetching' });
        const voters = await ZhihuAPI.fetchAllUsers('voters', answerId, maxUsers, (fetched, estimated) => {
          safeSendMessage({ type: 'blockProgress', current: 0, total: 0, name: `获取中 ${fetched}/${estimated || '?'}`, success: true, reason: 'fetching' });
        });
        if (voters.length === 0) {
          isBlocking = false;
          sendResponse({ error: '未获取到点赞者' });
          return;
        }
        const result = await ZhihuAPI.batchBlock(voters, (current, total, user, success, reason) => {
          safeSendMessage({ type: 'blockProgress', current, total, name: user.name || user.urlToken, success, reason });
        });
        isBlocking = false;
        sendResponse({ result, totalFetched: voters.length });
      })().catch(e => {
        isBlocking = false;
        sendResponse({ error: e.message });
      });
      return true;
    }

    if (msg.action === 'getPageType') {
      sendResponse({ type: ZBScanner.detectPageType() });
    }

    if (msg.action === 'getPageContext') {
      sendResponse({
        type: ZBScanner.detectPageType(),
        profileToken: ZBScanner.extractProfileTokenFromUrl(),
        comments: serializeComments(ZBScanner.extractCommentIds()),
      });
    }

    if (msg.action === 'getAnswerId') {
      sendResponse({ answerId: ZBScanner.extractAnswerIdFromUrl() });
    }

    if (msg.action === 'getCommentIds') {
      sendResponse({ comments: serializeComments(ZBScanner.extractCommentIds()) });
    }
  });

  function serializeComments(comments) {
    return comments.map(({ commentId, author, content }) => ({ commentId, author, content }));
  }

  // ── 全自动模式 ──────────────────────────────
  async function initAutoMode() {
    const rules = await ZBStorage.getRules();
    if (rules.length === 0) return;

    let scanTimer = null;
    autoObserver = new MutationObserver(() => {
      if (!contextValid) {
        autoObserver.disconnect();
        return;
      }
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(autoScan, 800);
      autoScanTimer = scanTimer;
    });

    autoObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    autoScanTimer = setTimeout(autoScan, 1000);
  }

  async function autoScan() {
    if (isBlocking || !contextValid) return;

    try {
      const matched = await ZBScanner.scan();
      if (matched.length === 0) return;

      isBlocking = true;
      const result = await ZhihuAPI.batchBlock(matched, () => {});
      autoBlockCount += result.blocked;

      if (autoBlockCount > 0) {
        safeSendMessage({ type: 'autoBlockUpdate', count: autoBlockCount });
      }

      isBlocking = false;
    } catch (e) {
      if (!isContextAlive()) {
        invalidateContext();
        console.log('[知乎拉黑] 扩展已更新，content script 停止运行');
      } else {
        console.error('[知乎拉黑] 自动扫描出错:', e);
      }
      isBlocking = false;
    }
  }

  initAutoMode();

})();
