const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = p => fs.readFileSync(path.join(root, p), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function harness(fetch, saved = {}, extra = {}) {
  const data = { local: saved, sync: { settings: { autoMode:true, blockConcurrency: 5, blockIntervalMin: 0, blockIntervalMax: 0, pageInterval: 0 }, rules: [] } };
  const writes = [], events = [];
  const chrome = { runtime: {id:'test-extension', lastError:null, sendMessage:(message, cb) => {events.push(copy(message)); cb?.();}, onMessage:{addListener(){}}}, storage:{} };
  for (const area of ['local','sync']) chrome.storage[area] = {
    get(keys, cb) {
      if (keys === null) return cb(copy(data[area]));
      cb(copy({...keys,...Object.fromEntries(Object.keys(keys).filter(key => key in data[area]).map(key => [key,data[area][key]]))}));
    },
    set(value, cb) { const item = copy(value); Object.assign(data[area],item); writes.push(item); cb?.(); },
    remove(key, cb) { delete data[area][key]; cb?.(); },
  };
  const context = vm.createContext({chrome,fetch,URL,AbortController,setTimeout,clearTimeout,Date,crypto:webcrypto,console,...extra});
  for (const file of ['lib/storage.js','lib/api.js','lib/tasks.js','lib/hidden.js']) vm.runInContext(source(file),context,{filename:file});
  const tasks = vm.runInContext('ZBTasks',context), store = vm.runInContext('ZBStorage',context), api = vm.runInContext('ZhihuAPI',context);
  const hidden = vm.runInContext('ZBHidden',context);
  return {data,writes,events,context,tasks,store,api,hidden};
}
const json = (value,status=200,headers={}) => new Response(JSON.stringify(value),{status,headers});
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(predicate) {
  for (let i=0;i<500;i++) {if (predicate()) return; await sleep(2);}
  throw new Error('Timed out waiting for task');
}
module.exports = {source,harness,json,until,sleep,copy,root};