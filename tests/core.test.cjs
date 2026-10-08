const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {source,harness,json,until,sleep,copy} = require('./helpers.cjs');
const users = count => Array.from({length:count},(_,i)=>({urlToken:'user'+i,name:'User '+i}));
const accountReply = url => url.endsWith('/me') ? json({url_token:'owner'}) : null;
const done = h => until(()=>h.data.local.zbTask?.status === 'done');
test('manifest references, imported scripts and JavaScript syntax',()=>{
  const manifest=JSON.parse(source('manifest.json'));
  assert.equal(manifest.version,'1.1.0');
  for (const file of ['background.js','lib/tasks.js','popup/popup.js',...manifest.content_scripts.flatMap(x=>x.js),'lib/api.js']) new vm.Script(source(file),{filename:file});
  for (const file of [manifest.action.default_popup,...Object.values(manifest.icons)]) assert.ok(source(file).length);
  assert.ok(!manifest.content_scripts[0].js.includes('lib/api.js'));
});
test('parallel starts share one queue; successful records persist individually and deduplicate',async()=>{
  let posts=0;
  const h=harness(async(url,options)=>accountReply(url)||(++posts,json({})));
  const results=await Promise.all([h.tasks.start({type:'auto',users:[...users(3),...users(3)]}),h.tasks.start({type:'auto',users:users(3)})]);
  assert.equal(results.filter(r=>r.busy).length,1);
  await done(h); assert.equal(posts,3);
  assert.equal(h.data.local.zbTask.blocked,3);
  assert.equal(Object.keys(h.data.local).filter(k=>k.startsWith('zb:block:owner:')).length,3);
  assert.ok(h.writes.some(w=>w['zb:block:owner:user0']));
  await h.tasks.start({type:'auto',users:users(3)}); await done(h);
  assert.equal(posts,3); assert.equal(h.data.local.zbTask.skipped,3);
});
test('401 stops new dispatch; unattempted users are not counted as failures',async()=>{
  let posts=0;
  const h=harness(async url=>accountReply(url)||(++posts,json({},401)));
  await h.tasks.start({type:'auto',users:users(12)});
  await until(()=>h.data.local.zbTask?.failed===5);
  assert.equal(posts,5); assert.equal(h.data.local.zbTask.status,'paused');
  assert.equal(h.data.local.zbTask.queue.filter(u=>u.state==='pending').length,7);
});
test('white-listed users and current account are skipped in all task types',async()=>{
  let posts=0;
  const h=harness(async url=>accountReply(url)||(++posts,json({})));
  h.data.sync.settings.whitelist=['user0'];
  await h.tasks.start({type:'auto',users:[{urlToken:'owner'},...users(2)]}); await done(h);
  assert.equal(posts,1); assert.equal(h.data.local.zbTask.skipped,2);
});
test('pause allows in-flight completion and resume processes only remaining users',async()=>{
  const releases=[]; let posts=0;
  const h=harness(async url=>accountReply(url)||new Promise(resolve=>{posts++;releases.push(()=>resolve(json({})));}));
  h.data.sync.settings.blockConcurrency=1;
  await h.tasks.start({type:'auto',users:users(3)});
  await until(()=>posts===1); await h.tasks.pause(); releases.shift()();
  await until(()=>h.data.local.zbTask.blocked===1);
  assert.equal(h.data.local.zbTask.status,'paused');
  await sleep(10); assert.equal(posts,1);
  await h.tasks.resume(); await until(()=>posts===2); releases.shift()();
  await until(()=>posts===3); releases.shift()(); await done(h);
  assert.equal(h.data.local.zbTask.blocked,3);
});
test('ending an active task allows another task after in-flight settlement',async()=>{
  let release;
  const h=harness(async url=>accountReply(url)||new Promise(resolve=>{release=()=>resolve(json({}));}));
  await h.tasks.start({type:'auto',users:users(1)});
  await until(()=>!!release); await h.tasks.end(); release();
  await until(()=>h.data.local.zbTask.blocked===1); await sleep(10);
  assert.equal(h.data.local.zbTask.status,'cancelled');
  const result=await h.tasks.start({type:'auto',users:users(1)}); assert.ok(!result.busy); await done(h);
});
test('restart retains successful records and marks interrupted requests uncertain',async()=>{
  const saved={zbTask:{id:'task',account:'owner',type:'auto',rulesSignature:'[]',status:'running',queue:[{urlToken:'user0',state:'done'},{urlToken:'user1',state:'inflight'},{urlToken:'user2',state:'pending'}],exhausted:true,maxUsers:3,fetched:3,blocked:1,skipped:0,failed:0,unknown:0},'zb:block:owner:user0':1,'zb:total:owner':1};
  let posts=0;
  const h=harness(async url=>accountReply(url)||(++posts,json({})),saved);
  const state=await h.tasks.getState();
  assert.equal(state.task.status,'paused'); assert.equal(state.task.unknown,1);
  await h.tasks.resume(); await done(h);
  assert.equal(posts,1); assert.ok(h.data.local['zb:block:owner:user2']);
  assert.ok(!h.data.local['zb:block:owner:user1']);
});
test('account switches cannot resume old tasks, and records remain account scoped',async()=>{
  let account='owner',posts=0;
  const h=harness(async url=>url.endsWith('/me')?json({url_token:account}):(++posts,json({})));
  await h.tasks.start({type:'auto',users:users(1)}); await done(h);
  account='other';
  await h.tasks.start({type:'auto',users:users(1)}); await done(h);
  assert.equal(posts,2); assert.ok(h.data.local['zb:block:owner:user0']); assert.ok(h.data.local['zb:block:other:user0']);
  await h.tasks.start({type:'auto',users:users(2)}); await h.tasks.pause();
  account='third'; await assert.rejects(()=>h.tasks.resume(),/账号已切换/);
  await h.tasks.end();
});
test('restart also marks requests uncertain when user had already paused the task',async()=>{
  const saved={zbTask:{id:'task',account:'owner',type:'auto',rulesSignature:'[]',status:'paused',queue:[{urlToken:'user0',state:'inflight'},{urlToken:'user1',state:'pending'}],exhausted:true,maxUsers:2,fetched:2,blocked:0,skipped:0,failed:0,unknown:0}};
  let posts=0;
  const h=harness(async url=>accountReply(url)||(++posts,json({})),saved);
  const state=await h.tasks.getState();assert.equal(state.task.unknown,1);
  await h.tasks.resume();await done(h);assert.equal(posts,1);
  assert.ok(!h.data.local['zb:block:owner:user0']);
});
test('list pages are processed one at a time, follow actual next URL, and enforce candidate cap',async()=>{
  const gets=[],posts=[];
  const h=harness(async(url,options)=>{
    if (url.endsWith('/me')) return accountReply(url);
    if (options?.method==='POST') {posts.push(url);return json({});}
    gets.push(url);
    const second=url.includes('offset=3');
    if (second) assert.equal(posts.length,3);
    return json({data:(second?users(4).slice(3):users(3)).map(u=>({url_token:u.urlToken})),paging:{is_end:second,next:'https://www.zhihu.com/api/v4/answers/42/voters?offset=3&limit=20',totals:4}});
  });
  await h.tasks.start({type:'voters',target:'42',maxUsers:4}); await done(h);
  assert.equal(gets.length,2); assert.equal(posts.length,4);
  assert.ok(gets[1].includes('offset=3'));
  assert.equal(h.data.local.zbTask.fetched,4);
});
test('repeated non-empty pages pause instead of looping',async()=>{
  let pages=0;
  const h=harness(async(url,options)=>{
    if (url.endsWith('/me')) return accountReply(url);
    if (options?.method==='POST') return json({});
    pages++; return json({data:[{url_token:'alice'}],paging:{is_end:false,next:'https://www.zhihu.com/api/v4/answers/42/voters?offset='+pages}});
  });
  await h.tasks.start({type:'voters',target:'42',maxUsers:100});
  await until(()=>h.data.local.zbTask.status==='paused');
  assert.equal(pages,2); assert.match(h.data.local.zbTask.error,/分页重复/);
});
test('account and whitelist changes while loading a page take effect before POST dispatch',async()=>{
  for (const change of ['account','whitelist']) {
    let account='owner',release,posts=0;
    const h=harness(async(url,options)=>{
      if(url.endsWith('/me'))return json({url_token:account});
      if(options?.method==='POST'){posts++;return json({});}
      return new Promise(resolve=>{release=()=>resolve(json({data:[{url_token:'alice'}],paging:{is_end:true}}));});
    });
    await h.tasks.start({type:'voters',target:'42',maxUsers:1});await until(()=>!!release);
    if(change==='account')account='other';else h.data.sync.settings.whitelist=['alice'];
    release();await until(()=>['done','paused'].includes(h.data.local.zbTask.status));
    assert.equal(posts,0);assert.equal(h.data.local.zbTask.status,change==='account'?'paused':'done');
  }
});
test('cross-origin paging, malformed schema and invalid token cannot trigger a POST',async()=>{
  const h=harness(async()=>json({data:[{url_token:'alice'}],paging:{is_end:false,next:'https://evil.example/users'}}));
  await assert.rejects(()=>h.api.getPage('voters','42'),/分页游标/);
  await assert.rejects(()=>h.api.blockUser('https://evil.example/people/alice'),/标识无效/);
  const malformed=harness(async()=>json({data:[{id:'not-a-url-token'}],paging:{is_end:true}}));
  await assert.rejects(()=>malformed.api.getPage('voters','42'),/用户标识/);
});
test('429 exposes Retry-After, blocks early resume and retries only on explicit resume',async()=>{
  let rejected=true,posts=0;
  const h=harness(async url=>accountReply(url)||(++posts,rejected?json({},429,{'Retry-After':'3600'}):json({})));
  h.data.sync.settings.blockConcurrency=1;
  await h.tasks.start({type:'auto',users:users(2)});
  await until(()=>h.data.local.zbTask.status==='paused');
  await assert.rejects(()=>h.tasks.resume(),/等待/);
  assert.equal(posts,1);
  // Simulate the wall clock advancing; no real delay.
  h.context.Date=class extends Date { static now(){return Date.now()+3601000;} };
  rejected=false; await h.tasks.resume(); await done(h);
  assert.equal(posts,3); assert.equal(h.data.local.zbTask.failed,0); assert.equal(h.data.local.zbTask.blocked,2);
});
test('ambiguous POST outcomes pause and are never automatically retried',async()=>{
  let posts=0;
  const h=harness(async url=>accountReply(url)||(++posts,new Response('<html>unknown</html>')));
  h.data.sync.settings.blockConcurrency=1;
  await h.tasks.start({type:'auto',users:users(1)});
  await until(()=>h.data.local.zbTask.status==='paused');
  assert.equal(h.data.local.zbTask.unknown,1);
  await h.tasks.resume(); await done(h); assert.equal(posts,1);
  await h.tasks.start({type:'auto',users:users(1)});await done(h);
  assert.equal(posts,1);assert.equal(h.data.local.zbTask.unknown,1);
  const restarted=harness(async url=>accountReply(url)||(++posts,json({})),copy(h.data.local));
  await restarted.tasks.start({type:'auto',users:users(1)});await done(restarted);assert.equal(posts,1);
});
test('local date and midnight statistics; old settings and global records are preserved',async()=>{
  process.env.TZ='Asia/Shanghai';
  let now=new Date('2026-10-07T17:00:00Z').getTime();
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
  const h=harness(async url=>accountReply(url)||json({}),{blockedUsers:{legacyUser:1}},{Date:Clock});
  h.data.sync.settings.blockIntervalMin=1000; h.data.sync.settings.blockIntervalMax=1000;
  assert.equal((await h.store.getSettings()).blockIntervalMin,1000);
  assert.equal(h.store.todayKey(),'2026-10-08');
  h.data.sync.settings.blockIntervalMin=0; h.data.sync.settings.blockIntervalMax=0;
  await h.tasks.start({type:'auto',users:users(1)}); await done(h);
  now=new Date('2026-10-08T16:00:01Z').getTime();
  await h.tasks.start({type:'auto',users:[{urlToken:'newuser'}]}); await done(h);
  assert.equal(h.data.local['zb:daily:owner:2026-10-08'],1);
  assert.equal(h.data.local['zb:daily:owner:2026-10-09'],1);
  assert.deepEqual(h.data.local.blockedUsers,{legacyUser:1});
});
test('disabling auto matching stops remaining dispatch after in-flight completion',async()=>{
  let posts=0,release;
  const h=harness(async url=>accountReply(url)||new Promise(resolve=>{posts++;release=()=>resolve(json({}));}));
  h.data.sync.settings.blockConcurrency=1;
  await h.tasks.start({type:'auto',users:users(3)});
  await until(()=>posts===1);
  h.data.sync.settings.autoMode=false;
  await h.tasks.refreshAutoPolicy();release();
  await until(()=>h.data.local.zbTask.blocked===1);await sleep(10);
  assert.equal(posts,1);assert.equal(h.data.local.zbTask.status,'cancelled');
  assert.equal((await h.tasks.start({type:'auto',users:users(1)})).disabled,true);
});
test('changed rules reject stale submissions and terminate paused old auto task',async()=>{
  const h=harness(async url=>accountReply(url)||json({}));
  assert.equal((await h.tasks.start({type:'auto',users:users(1),rulesSignature:'old'})).stale,true);
  assert.equal(h.data.local.zbTask,undefined);
  await h.tasks.start({type:'auto',users:users(3),rulesSignature:'[]'});
  await h.tasks.pause();
  h.data.sync.rules=[{id:'new',keyword:'test',sources:['answer']}];
  await h.tasks.refreshAutoPolicy();
  assert.equal(h.data.local.zbTask.status,'cancelled');
  assert.equal((await h.tasks.resume()).task.status,'cancelled');
});
test('failed local success write pauses without inflated success count or automatic re-POST',async()=>{
  let posts=0,fail=true;
  const h=harness(async url=>accountReply(url)||(++posts,json({})));
  const original=h.context.chrome.storage.local.set;
  h.context.chrome.storage.local.set=(value,cb)=>{
    if (fail && Object.keys(value).some(k=>k.startsWith('zb:block:'))) {
      fail=false;h.context.chrome.runtime.lastError={message:'disk full'};cb();h.context.chrome.runtime.lastError=null;
    } else original(value,cb);
  };
  await h.tasks.start({type:'auto',users:users(1)});
  await until(()=>h.data.local.zbTask.status==='paused');
  assert.equal(h.data.local.zbTask.blocked,0);assert.equal(h.data.local.zbTask.unknown,1);
  assert.equal(Object.keys(h.data.local).filter(k=>k.startsWith('zb:block:')).length,0);
  await h.tasks.resume();await done(h);
  assert.equal(posts,1);assert.equal(h.data.local.zbTask.unknown,1);
});
