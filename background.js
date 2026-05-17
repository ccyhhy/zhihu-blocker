/**
 * Background service worker
 * 负责统一转发 popup -> content 的指令，以及 content -> popup 的进度事件。
 */

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
        return;
      }

      const tab = tabs?.[0];
      if (!tab?.id) {
        reject(new Error('未找到当前页面'));
        return;
      }
      resolve(tab);
    });
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error('无法连接到页面，请刷新知乎页面后重试'));
        return;
      }
      resolve(response);
    });
  });
}

async function sendToActiveZhihuTab(message) {
  const tab = await getActiveTab();
  if (!/^https?:\/\/([^/]+\.)?zhihu\.com\//.test(tab.url || '')) {
    throw new Error('请先打开知乎页面');
  }
  return sendToTab(tab.id, message);
}

async function handlePopupCommand(message) {
  switch (message.action) {
    case 'getPageContext':
      return sendToActiveZhihuTab({ action: 'getPageContext' });
    case 'scanCurrentPage':
      return sendToActiveZhihuTab({ action: 'scan' });
    case 'blockMatchedUsers':
      return sendToActiveZhihuTab({ action: 'blockList', users: message.users || [] });
    case 'blockFollowList':
      return sendToActiveZhihuTab({ action: 'blockFollowers', maxUsers: message.maxUsers });
    case 'blockAnswerVoters':
      return sendToActiveZhihuTab({ action: 'blockVoters', maxUsers: message.maxUsers, answerId: message.answerId });
    default:
      throw new Error('未知操作');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel === 'zb-ui-event') {
    try {
      chrome.runtime.sendMessage(message.event, () => {
        // popup 关闭时没有接收方，这是正常情况。
        void chrome.runtime.lastError;
      });
    } catch {
      // 事件通知失败不影响正在执行的拉黑任务。
    }
    return;
  }

  if (message?.target !== 'background') return;

  handlePopupCommand(message)
    .then((result) => sendResponse(result || {}))
    .catch((error) => sendResponse({ error: error.message }));

  return true;
});
