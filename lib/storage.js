/** 规则和设置；任务与账号记录仅由 background 写入。 */
const ZBStorage = (() => {
  const DEFAULT_SETTINGS = {
    autoMode: false, blockIntervalMin: 0, blockIntervalMax: 0,
    pageInterval: 0, blockConcurrency: 5, fastNoDelayMigrated: true,
    ruleSourceDefaults: ['bio', 'comment', 'answer'], whitelist: [],
  };
  function read(area, keys) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].get(keys, result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve(result);
      });
    });
  }
  function write(area, value) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].set(value, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve();
      });
    });
  }
  function tokenFrom(value) {
    const text = String(value || '').trim();
    if (/^https?:/i.test(text)) {
      try {
        const url = new URL(text);
        if (!/(^|\.)zhihu\.com$/.test(url.hostname)) return '';
        return url.pathname.match(/^\/people\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] || '';
      } catch { return ''; }
    }
    return /^[a-zA-Z0-9_-]+$/.test(text) && !['undefined', 'null'].includes(text) ? text : '';
  }
  function words(value) {
    return [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，\n]/))
      .map(x => String(x).trim()).filter(Boolean))];
  }
  async function getSettings() {
    const { settings = {} } = await read('sync', { settings: {} });
    const result = { ...DEFAULT_SETTINGS, ...settings, autoMode: false };
    result.whitelist = words(result.whitelist).map(tokenFrom).filter(Boolean);
    // 保留已有间隔设置，不在读取设置时改写用户选择。
    return result;
  }
  async function getRules() {
    const { rules = [] } = await read('sync', { rules: [] });
    return rules.filter(r => r && typeof r.keyword === 'string' && r.keyword.trim() && Array.isArray(r.sources))
      .map(r => ({ ...r, sources: r.sources.filter(s => ['bio', 'comment', 'answer', 'article'].includes(s)), exclude: words(r.exclude) }));
  }
  function todayKey(date = new Date()) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  return {
    getSettings, getRules, tokenFrom, words, todayKey,
    saveSettings: settings => write('sync', { settings }),
    localGet: keys => read('local', keys), localSet: value => write('local', value),
    localRemove: key => new Promise((resolve, reject) => chrome.storage.local.remove(key, () => {
      const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else resolve();
    })),
  };
})();