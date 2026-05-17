/**
 * chrome.storage 封装 — 规则 CRUD、拉黑记录、每日计数
 */
const ZBStorage = (() => {
  // ── 默认配置 ──────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    autoMode: true,           // 全自动模式
    blockIntervalMin: 0,      // 拉黑间隔最小 ms
    blockIntervalMax: 0,      // 拉黑间隔最大 ms
    dailyLimit: 100,          // 每日拉黑上限
    pageInterval: 0,          // 翻页间隔 ms（关注者/点赞者列表）
    fastNoDelayMigrated: true,
    ruleSourceDefaults: ['bio', 'comment', 'answer'],
  };

  const DEFAULT_RULES = [];   // [{ id, keyword, sources: ['bio','comment','answer','article'] }]

  function isContextInvalidError(error) {
    return /Extension context invalidated/i.test(String(error?.message || error || ''));
  }

  function rejectIfRuntimeError(reject) {
    const err = chrome.runtime?.lastError;
    if (err) {
      reject(new Error(err.message || String(err)));
      return true;
    }
    return false;
  }

  // ── 辅助 ──────────────────────────────────────────────
  function todayKey() {
    return new Date().toISOString().slice(0, 10); // "2026-05-17"
  }

  function get(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          if (rejectIfRuntimeError(reject)) return;
          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function set(obj) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(obj, () => {
          if (rejectIfRuntimeError(reject)) return;
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function syncGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.get(keys, (result) => {
          if (rejectIfRuntimeError(reject)) return;
          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function syncSet(obj) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.set(obj, () => {
          if (rejectIfRuntimeError(reject)) return;
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // ── 设置 ──────────────────────────────────────────────
  async function getSettings() {
    try {
      const data = await syncGet({ settings: DEFAULT_SETTINGS });
      const savedSettings = data.settings || {};
      const settings = { ...DEFAULT_SETTINGS, ...savedSettings };

      if (savedSettings.fastNoDelayMigrated !== true) {
        settings.blockIntervalMin = 0;
        settings.blockIntervalMax = 0;
        settings.pageInterval = 0;
        settings.fastNoDelayMigrated = true;
        await saveSettings(settings);
      }

      return settings;
    } catch (error) {
      if (isContextInvalidError(error)) return { ...DEFAULT_SETTINGS };
      throw error;
    }
  }

  async function saveSettings(settings) {
    await syncSet({ settings });
  }

  // ── 规则 ──────────────────────────────────────────────
  async function getRules() {
    try {
      const data = await syncGet({ rules: DEFAULT_RULES });
      return data.rules || [];
    } catch (error) {
      if (isContextInvalidError(error)) return [];
      throw error;
    }
  }

  async function saveRules(rules) {
    await syncSet({ rules });
  }

  async function addRule(keyword, sources) {
    const rules = await getRules();
    const id = Date.now().toString(36);
    rules.push({ id, keyword, sources });
    await saveRules(rules);
    return rules;
  }

  async function removeRule(id) {
    let rules = await getRules();
    rules = rules.filter(r => r.id !== id);
    await saveRules(rules);
    return rules;
  }

  // ── 拉黑记录 ──────────────────────────────────────────
  async function getBlockedSet() {
    try {
      const data = await get({ blockedUsers: {} });
      return data.blockedUsers; // { url_token: timestamp }
    } catch (error) {
      if (isContextInvalidError(error)) return {};
      throw error;
    }
  }

  async function isBlocked(urlToken) {
    const blocked = await getBlockedSet();
    return !!blocked[urlToken];
  }

  async function markBlocked(urlToken) {
    const blocked = await getBlockedSet();
    blocked[urlToken] = Date.now();
    await set({ blockedUsers: blocked });
  }

  // ── 每日计数 ──────────────────────────────────────────
  async function getDailyCount() {
    const key = 'daily_' + todayKey();
    try {
      const data = await get({ [key]: 0 });
      return data[key];
    } catch (error) {
      if (isContextInvalidError(error)) return 0;
      throw error;
    }
  }

  async function incrementDailyCount(n = 1) {
    const key = 'daily_' + todayKey();
    const data = await get({ [key]: 0 });
    const newCount = data[key] + n;
    await set({ [key]: newCount });
    return newCount;
  }

  async function canBlock() {
    const settings = await getSettings();
    const count = await getDailyCount();
    return count < settings.dailyLimit;
  }

  // ── 随机延迟 ──────────────────────────────────────────
  async function randomDelay() {
    const settings = await getSettings();
    const min = Number(settings.blockIntervalMin) || 0;
    const max = Math.max(min, Number(settings.blockIntervalMax) || 0);
    const ms = min + Math.random() * (max - min);
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function pageDelay() {
    const settings = await getSettings();
    const ms = Number(settings.pageInterval) || 0;
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    getSettings, saveSettings,
    getRules, saveRules, addRule, removeRule,
    getBlockedSet, isBlocked, markBlocked,
    getDailyCount, incrementDailyCount, canBlock,
    randomDelay, pageDelay,
  };
})();
