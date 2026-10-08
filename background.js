/** 固定名单接口、手动任务及本机屏蔽。 */
importScripts('lib/storage.js', 'lib/api.js', 'lib/tasks.js', 'lib/hidden.js');
const isZhihu = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && /(^|\.)zhihu\.com$/.test(u.hostname); } catch { return false; }
};
function activeTab(sender) {
  if (sender.tab?.id && isZhihu(sender.tab.url)) return Promise.resolve(sender.tab);
  return new Promise((resolve, reject) => chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const error = chrome.runtime.lastError;
    if (error || !tabs[0]?.id || !isZhihu(tabs[0].url)) reject(new Error('请先打开知乎页面'));
    else resolve(tabs[0]);
  }));
}
function pageMessage(tab, message) {
  return new Promise((resolve, reject) => chrome.tabs.sendMessage(tab.id, message, response => {
    const error = chrome.runtime.lastError;
    if (error || !response) reject(new Error('无法连接页面，请刷新知乎页面后重试')); else resolve(response);
  }));
}
async function handle(message, sender) {
  if (message.action === 'getState') return { ...await ZBTasks.getState(), hiddenUsers: await ZBHidden.get() };
  if (message.action === 'getHiddenUsers') return {hiddenUsers:await ZBHidden.get()};
  if (message.action === 'unhideUser') return ZBHidden.remove(message.urlToken);
  if (message.action === 'hideUser') return ZBHidden.add(message.user);
  if (message.action === 'shieldUser') {
    await ZBHidden.add(message.user);
    try {
      const result = await ZBTasks.start({type:'selected',users:[message.user],tabId:sender.tab?.id});
      return {...result,hidden:true,message:result.busy ? '本机已屏蔽；已有拉黑任务，本次没有派发知乎拉黑' : '本机已屏蔽；知乎拉黑任务已开始，请在面板查看结果'};
    } catch (error) { return {hidden:true,message:'本机已屏蔽；知乎拉黑未开始：' + error.message}; }
  }
  if (['loadMoreReview','saveReviewSelection','confirmReview','discardReview','previewFollowers','previewAnswerVoters'].includes(message.action)) throw new Error('新版已取消预览，请刷新页面后使用直接拉黑按钮');
  if (message.action === 'pauseTask') return ZBTasks.pause();
  if (message.action === 'endTask') return ZBTasks.end();
  if (message.action === 'resumeTask') return ZBTasks.resume();
  if (message.action === 'enqueueAuto' || message.action === 'previewRules' || message.action === 'previewFollowList' || message.action === 'blockFollowList') throw new Error('新版已停用关键词和关注名单入口');
  if (['previewCommentVoters','blockCommentVoters'].includes(message.action)) throw new Error('评论赞同者名单尚不可读取；两个已核对的候选接口均返回 404');
  const tab = await activeTab(sender);
  if (message.action === 'closeFloatingPanel') return pageMessage(tab,{action:'closeFloatingPanel'});
  if (message.action === 'blockFollowers') {
    const target = ZBStorage.tokenFrom(message.profileToken);
    if (!target) throw new Error('请填写有效的知乎用户主页地址');
    return ZBTasks.start({type:'followers',target,tabId:tab.id,maxUsers:message.maxUsers});
  }
  const context = await pageMessage(tab,{action:'getPageContext'});
  if (message.action === 'getPageContext') return {...context,tabId:tab.id};
  if (message.action === 'blockAnswerVoters') {
    const answerId = String(message.answerId || '');
    if (!(context.answers || []).some(answer => answer.answerId === answerId)) throw new Error('所选回答已不在当前页面，请重新识别');
    return ZBTasks.start({type:'voters',target:answerId,tabId:tab.id,maxUsers:message.maxUsers});
  }
  throw new Error('未知操作');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  handle(message, sender).then(respond).catch(error => respond({error:error.message}));
  return true;
});
