/** 页面只提供已识别目标；固定接口与统一任务在后台执行。 */
importScripts('lib/storage.js', 'lib/api.js', 'lib/tasks.js');
const isZhihu = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && /(^|\.)zhihu\.com$/.test(u.hostname); } catch { return false; }
};
function activeTab() {
  return new Promise((resolve, reject) => chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const error = chrome.runtime.lastError;
    if (error || !tabs[0]?.id || !isZhihu(tabs[0].url)) reject(new Error('请先打开知乎页面'));
    else resolve(tabs[0]);
  }));
}
function pageContext(tab) {
  return new Promise((resolve, reject) => chrome.tabs.sendMessage(tab.id, { action: 'getPageContext' }, response => {
    const error = chrome.runtime.lastError;
    if (error || !response) reject(new Error('无法连接页面，请刷新知乎页面后重试')); else resolve(response);
  }));
}
async function handle(message, sender) {
  if (message.action === 'getState') return ZBTasks.getState();
  if (message.action === 'pauseTask') return ZBTasks.pause();
  if (message.action === 'endTask') return ZBTasks.end();
  if (message.action === 'resumeTask') return ZBTasks.resume();
  if (message.action === 'enqueueAuto') {
    if (!sender.tab?.id || !isZhihu(sender.tab.url)) throw new Error('页面来源无效');
    if (typeof message.rulesSignature !== 'string') throw new Error('插件已更新，请刷新知乎页面');
    return ZBTasks.start({ type: 'auto', tabId: sender.tab.id, users: message.users, rulesSignature: message.rulesSignature });
  }
  const tab = await activeTab(), context = await pageContext(tab);
  if (message.action === 'getPageContext') return { ...context, tabId: tab.id };
  if (message.action === 'blockFollowList') {
    if (!['followers', 'followees'].includes(context.type) || !context.profileToken) throw new Error('请先打开粉丝或关注列表页面');
    if (context.listUnavailable) throw new Error(context.listUnavailable);
    return ZBTasks.start({ type: context.type, target: context.profileToken, tabId: tab.id, maxUsers: message.maxUsers });
  }
  if (message.action === 'blockAnswerVoters') {
    const answerId = String(message.answerId || '');
    if (!(context.answers || []).some(a => a.answerId === answerId)) throw new Error('所选回答已不在当前页面，请重新识别');
    return ZBTasks.start({ type: 'voters', target: answerId, tabId: tab.id, maxUsers: message.maxUsers });
  }
  throw new Error('未知操作');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  handle(message, sender).then(respond).catch(error => respond({ error: error.message }));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.rules || changes.settings)) ZBTasks.refreshAutoPolicy().catch(() => {});
});
