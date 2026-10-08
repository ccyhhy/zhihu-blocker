/** 本机屏蔽按稳定主页标识保存；不按昵称合并用户。 */
const ZBHidden = (() => {
  let tail = Promise.resolve();
  const serial = fn => {
    const next = tail.then(fn); tail = next.catch(() => {}); return next;
  };
  const prefix = 'zb:hide:';
  const key = value => {
    const token = ZBStorage.tokenFrom(value);
    if (!token) throw new Error('用户标识无效'); return prefix + token;
  };
  async function get() {
    const data = await ZBStorage.localGet(null);
    return Object.entries(data).flatMap(([entry, value]) => {
      const token = entry.startsWith(prefix) && ZBStorage.tokenFrom(entry.slice(prefix.length));
      return token && value ? [{urlToken:token,name:String(value.name || token).slice(0,80)}] : [];
    });
  }
  const add = user => serial(async () => {
    const entry = key(user?.urlToken), token = entry.slice(prefix.length), settings = await ZBStorage.getSettings();
    if (settings.whitelist.includes(token)) throw new Error('该用户在白名单中，未屏蔽');
    const data = await ZBStorage.localGet({zbAccount:null});
    if (token === data.zbAccount) throw new Error('该用户是插件最近确认的登录账号，未屏蔽');
    await ZBStorage.localSet({[entry]:{name:String(user.name || token).slice(0,80),at:Date.now()}});
    return {hidden:true};
  });
  const remove = token => serial(async () => {
    const entry = key(token), data = await ZBStorage.localGet({zbTask:null});
    if (data.zbTask?.queue?.some(user => user.urlToken === token && (user.state === 'inflight' || ['running','paused'].includes(data.zbTask.status) && user.state === 'pending'))) {
      throw new Error('此用户的拉黑任务尚未结束，请先结束任务并等待请求完成');
    }
    await ZBStorage.localRemove(entry); return {hidden:false};
  });
  return {get,add,remove};
})();
