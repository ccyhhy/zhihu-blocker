const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {source,harness,json,until,copy}=require('./helpers.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const results=[];
async function check(name,fn){const evidence=await fn();results.push({name,passed:true,evidence});console.log('PASS '+name);}
const answer=(token,id=42)=>'<div class="AnswerItem" data-id="'+id+'"><div class="AuthorInfo"><a href="/people/'+token+'">'+token+'</a></div><div class="RichContent-inner">回答正文 <a href="/people/quoted">引用者</a></div></div>';
const comment=(id,token,body,target='')=>'<div data-id="'+id+'"><a href="/people/'+token+'"><img class="Avatar" alt="'+token+'"></a><a href="/people/'+token+'">'+token+'</a>'+(target?'<a href="/people/'+target+'">'+target+'</a>':'')+'<div class="CommentContent">'+body+'</div></div>';
const hover=(token)=>'<div class="HoverCard"><span class="UserLink"><a class="UserLink-link" href="/people/'+token+'">'+token+'</a></span><div class="MemberButtonGroup ProfileButtonGroup HoverCard-buttons"></div></div>';
(async()=>{
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
 const context=await browser.newContext({viewport:{width:390,height:800}});
 await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='extension.test'){
     const file=url.pathname.slice(1),allowed=['popup/popup.html','popup/popup.js','popup/popup.css','lib/storage.js'];
     if(!allowed.includes(file))return route.abort();
     return route.fulfill({status:200,contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:source(file)});
   }
   return route.request().isNavigationRequest()?route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head></head><body></body></html>'}):route.abort();
 });
 const page=await context.newPage();
 async function fixture(html,url='https://www.zhihu.com/question/1/answer/42'){
   await page.goto(url);await page.setContent(html);await page.addScriptTag({content:source('content/scanner.js')+';window.scanner=ZBScanner;'});
 }
 await check('direct comment author excludes reply target and quoted users',async()=>{
   await fixture(answer('alice')+comment(101,'bob','评论 <a href="/people/quoted">引用用户</a>','target')+'<div data-id="102"><a href="/people/uncertain">不明作者</a><div class="CommentContent">无头像评论</div></div>');
   assert.equal(await page.evaluate(()=>scanner.authorOf(document.querySelector('[data-id="101"]')).urlToken),'bob');
   assert.equal(await page.evaluate(()=>scanner.authorOf(document.querySelector('[data-id="102"]'))),null);
   assert.equal(await page.evaluate(()=>scanner.authorOf(document.querySelector('.AnswerItem')).urlToken),'alice');
 });
 await check('answer IDs exclude article IDs and body reference links',async()=>{
   await fixture('<div class="ArticleItem" data-zop=\'{"type":"article","itemId":111}\'></div><div class="AnswerItem" data-zop=\'{"type":"answer","itemId":222}\'><a href="/people/alice">Alice</a><div class="RichContent-inner"><a href="/answer/999">引用回答</a></div></div>','https://www.zhihu.com/');
   assert.deepEqual(await page.evaluate(()=>scanner.extractAnswerIdsFromPage().map(a=>a.answerId)),['222']);
 });
 await check('hover user requires one stable identity and profile uses its page identity',async()=>{
   await fixture(hover('alice')+'<div class="ProfileHeader"><span class="ProfileHeader-name">本人</span><a href="/people/other">简介引用用户</a></div>','https://www.zhihu.com/people/owner');
   assert.equal(await page.evaluate(()=>scanner.hoverContext(document.querySelector('.HoverCard-buttons')).user.urlToken),'alice');
   assert.equal(await page.evaluate(()=>scanner.authorOf(document.querySelector('.ProfileHeader')).urlToken),'owner');
   await page.evaluate(()=>document.querySelector('.HoverCard').insertAdjacentHTML('afterbegin','<a class="UserLink-link" href="/people/other">另一个用户</a>'));
   assert.equal(await page.evaluate(()=>scanner.hoverContext(document.querySelector('.HoverCard-buttons'))),null);
 });
 await page.close();
 async function liveFixture(html,url='https://www.zhihu.com/question/1/answer/42',saved={}){
   const p=await context.newPage(),requests=[],actions=[];
   const h=harness(async(url,options)=>{
     requests.push({url,method:options?.method||'GET'});
     if(url.endsWith('/me'))return json({url_token:'owner'});
     if(options?.method==='POST')return json({});
     const offset=Number(new URL(url).searchParams.get('offset'));
     return json({data:Array.from({length:20},(_,i)=>({url_token:'v'+(offset+i),name:i===1 && !offset?'<img src=x>':'示例用户 '+(offset+i)})),paging:{is_end:offset>=40,next:url.replace('offset='+offset,'offset='+(offset+20))}});
   },saved);
   h.context.importScripts=()=>{};vm.runInContext(source('background.js'),h.context);const handle=vm.runInContext('handle',h.context);
   h.context.chrome.tabs={query:(q,cb)=>cb([{id:1,url:p.url()}]),sendMessage:(id,m,cb)=>p.evaluate(m=>new Promise(resolve=>{const listeners=window.mockChrome?.runtimeListeners||[];for(const fn of listeners)fn(m,{},resolve);}),m).then(cb)};
   const broadcast=async(message)=>{for(const frame of p.frames())try{await frame.evaluate(m=>{for(const fn of window.mockChrome?.runtimeListeners||[])fn(m,{},()=>{});},message);}catch{}};
   const notify=async(changes,area)=>{for(const frame of p.frames())try{await frame.evaluate(({changes,area})=>{for(const fn of window.mockChrome?.storageListeners||[])fn(changes,area);},{changes,area});}catch{}};
   h.context.chrome.runtime.sendMessage=(m,cb)=>{h.events.push(copy(m));broadcast(m);cb?.();};
   for(const area of ['local','sync']){
     const originalSet=h.context.chrome.storage[area].set, originalRemove=h.context.chrome.storage[area].remove;
     h.context.chrome.storage[area].set=(value,cb)=>{const changes={};for(const k in value)changes[k]={oldValue:h.data[area][k],newValue:value[k]};originalSet(value,cb);notify(copy(changes),area);};
     h.context.chrome.storage[area].remove=(key,cb)=>{const changes={[key]:{oldValue:h.data[area][key]}};originalRemove(key,cb);notify(copy(changes),area);};
   }
   await p.exposeFunction('bridgeBackground',async m=>{actions.push(copy(m));try{return await handle(m,{id:'test-extension',tab:{id:1,url:p.url()}});}catch(e){return {error:e.message};}});
   await p.exposeFunction('bridgeRead',async(area,keys)=>keys===null?copy(h.data[area]):copy({...keys,...Object.fromEntries(Object.keys(keys).filter(k=>k in h.data[area]).map(k=>[k,h.data[area][k]]))}));
   await p.exposeFunction('bridgeWrite',async(area,value)=>new Promise(resolve=>h.context.chrome.storage[area].set(value,resolve)));
   await p.addInitScript(()=>{
     window.mockChrome={storageListeners:[],runtimeListeners:[]};
     window.chrome={runtime:{id:'test-extension',lastError:null,getURL:path=>'https://extension.test/'+path,onMessage:{addListener:fn=>mockChrome.runtimeListeners.push(fn)},sendMessage:(m,cb)=>bridgeBackground(m).then(cb)},
       storage:{onChanged:{addListener:fn=>mockChrome.storageListeners.push(fn)}}};
     for(const area of ['local','sync'])chrome.storage[area]={get:(keys,cb)=>bridgeRead(area,keys).then(cb),set:(value,cb)=>bridgeWrite(area,value).then(cb)};
   });
   await p.goto(url);await p.setContent(html);
   await p.addScriptTag({content:source('lib/storage.js')});await p.addScriptTag({content:source('content/scanner.js')+';window.scanner=ZBScanner;'});await p.addScriptTag({content:source('content/ui.js')});
   await p.waitForFunction(()=>document.querySelector('[data-zb-ui=launcher]'));
   return {p,h,requests,actions,notify};
 }
 await check('local hiding respects direct authors, nested comments, whitelist and restoration without requests',async()=>{
   const {p,h,requests,notify}=await liveFixture(answer('alice')+comment(101,'bob','评论','alice')+hover('bob'),undefined,{'zb:hide:bob':{name:'Bob'}});
   await p.waitForFunction(()=>document.querySelector('[data-id="101"]').getAttribute('data-zb-hidden')==='1');
   assert.equal(await p.locator('.AnswerItem').getAttribute('data-zb-hidden'),null);assert.equal(requests.length,0);
   h.data.sync.settings.whitelist=['bob'];await notify({settings:{newValue:h.data.sync.settings}},'sync');
   await p.waitForFunction(()=>!document.querySelector('[data-id="101"]').hasAttribute('data-zb-hidden'));
   h.data.sync.settings.whitelist=[];await notify({settings:{newValue:h.data.sync.settings}},'sync');
   await p.waitForFunction(()=>document.querySelector('[data-id="101"]').hasAttribute('data-zb-hidden'));
   await h.hidden.remove('bob');await p.waitForFunction(()=>!document.querySelector('[data-id="101"]').hasAttribute('data-zb-hidden'));
   assert.equal(requests.length,0);await p.close();return {networkRequests:0};
 });
 await check('reused hover cards target the current user, avoid duplicate controls and hide without login',async()=>{
   const {p,h,requests}=await liveFixture(hover('alice')+answer('alice'));
   await p.waitForFunction(()=>document.querySelector('.HoverCard-buttons [data-zb-ui]')?.shadowRoot.querySelectorAll('button').length===3);
   await p.evaluate(()=>{const a=document.querySelector('.HoverCard .UserLink-link');a.href='/people/bob';a.textContent='bob';document.querySelector('.HoverCard-buttons').replaceChildren();});
   await p.waitForFunction(()=>document.querySelector('.HoverCard-buttons [data-zb-ui]')?.shadowRoot.querySelectorAll('button').length===3);
   await p.locator('.HoverCard-buttons').getByRole('button',{name:'仅本机屏蔽',exact:true}).click();
   await until(()=>!!h.data.local['zb:hide:bob']);assert.ok(!h.data.local['zb:hide:alice']);assert.equal(requests.length,0);
   assert.equal(await p.locator('.HoverCard-buttons [data-zb-ui]').count(),1);
   await p.locator('.HoverCard-buttons').getByRole('button',{name:'恢复本机显示',exact:true}).click();await until(()=>!h.data.local['zb:hide:bob']);assert.equal(requests.length,0);
   await p.close();
 });
 await check('hover block shows local status separately from failed server requests',async()=>{
   const {p,h,requests}=await liveFixture(hover('alice')+answer('alice'));
   h.context.fetch=async(url,opts)=>{requests.push({url,method:opts?.method||'GET'});return json({},401);};
   await p.locator('.HoverCard-buttons').getByRole('button',{name:'屏蔽并拉黑',exact:true}).click();
   await p.waitForFunction(()=>document.querySelector('[data-zb-ui=launcher]').shadowRoot.textContent.includes('知乎拉黑未开始'));
   assert.ok(h.data.local['zb:hide:alice']);assert.ok(!requests.some(r=>r.method==='POST'));
   await p.waitForFunction(()=>document.querySelector('.AnswerItem').hasAttribute('data-zb-hidden'));await p.close();
 });
 await check('floating panel previews correct answer and fans, preserves choices and posts only confirmed users',async()=>{
   const {p,h,requests,actions}=await liveFixture(answer('alice')+hover('alice'),undefined,{'zb:block:owner:v0':1});
   await p.locator('.AnswerItem').getByRole('button',{name:'预览回答赞同者',exact:true}).click();
   await p.waitForFunction(()=>document.querySelector('[data-zb-ui=panel]')?.shadowRoot.querySelector('iframe'));
   const frame=p.frameLocator('iframe[title="知乎屏蔽面板"]');
   await frame.locator('#reviewList .review-row').first().waitFor();assert.equal(await frame.locator('.review-row').count(),20);
   assert.equal(requests.filter(r=>r.method==='POST').length,0);assert.ok(await frame.locator('#reviewList input').first().isDisabled());
   assert.equal(await frame.locator('#reviewList img').count(),0);assert.equal(await frame.locator('#keywordInput').count(),0);assert.equal(await frame.locator('#autoModeInput').count(),0);
   await frame.locator('#reviewList input').nth(1).check();await frame.locator('#loadMoreReviewBtn').click();
   await frame.locator('#reviewNextBtn').click();await frame.locator('#reviewList input').first().check();
   await until(()=>h.data.local.zbReview.selected.length===2);assert.equal(requests.filter(r=>r.method==='POST').length,0);
   await frame.locator('#closePanelBtn').click();await p.waitForFunction(()=>!document.querySelector('[data-zb-ui=panel]'));
   await p.locator('[data-zb-ui=launcher]').getByRole('button',{name:'屏蔽面板',exact:true}).click();
   await frame.locator('#selectedCount').waitFor();await frame.locator('#selectedCount').filter({hasText:'已勾选 2 人'}).waitFor();
   await frame.locator('#confirmReviewBtn').click();await until(()=>h.data.local.zbTask?.status==='done');
   assert.equal(requests.filter(r=>r.method==='POST').length,2);assert.ok(h.data.local['zb:hide:v1']);assert.ok(h.data.local['zb:hide:v20']);assert.ok(!h.data.local['zb:hide:v2']);
   assert.ok(requests.some(r=>r.url.includes('/answers/42/upvoters')));
   await frame.getByLabel('预览粉丝的用户主页').fill('https://www.zhihu.com/people/person');
   await frame.getByRole('button',{name:'预览这个人的粉丝',exact:true}).click();await frame.locator('#reviewSummary').filter({hasText:'person'}).waitFor();
   assert.ok(requests.some(r=>r.url.includes('/members/person/followers')));assert.ok(!requests.some(r=>r.url.includes('/followees')));
   assert.ok(await frame.getByRole('button',{name:'预览评论赞同者',exact:true}).isDisabled());assert.ok(!actions.some(a=>a.action==='previewCommentVoters'));
   const inner=p.frames().find(f=>f.url().includes('popup/popup.html'));const layout=await inner.evaluate(()=>({width:document.body.getBoundingClientRect().width,scroll:document.body.scrollWidth}));assert.ok(layout.scroll<=layout.width+1);
   if(process.env.POPUP_SCREENSHOT){
     await frame.locator('#discardReviewBtn').click();await frame.locator('#reviewSection').waitFor({state:'hidden'});
     const html=await inner.evaluate(()=>{const copy=document.documentElement.cloneNode(true);const original=document.querySelectorAll('input');copy.querySelectorAll('input').forEach((input,index)=>{input.setAttribute('value',original[index].value);});return copy.outerHTML;});
     const shot=await context.newPage();await shot.setContent(html.replace(/<script[\s\S]*?<\/script>/g,'').replace('<link rel="stylesheet" href="popup.css">','<style>'+source('popup/popup.css')+'</style>'));
     await shot.screenshot({path:process.env.POPUP_SCREENSHOT,fullPage:true});await shot.close();
   }
   if(process.env.FLOAT_SCREENSHOT){
     await frame.locator('#closePanelBtn').click();await p.waitForFunction(()=>!document.querySelector('[data-zb-ui=panel]'));
     await p.setViewportSize({width:1200,height:800});
     await p.addStyleTag({content:'body{font:15px system-ui;background:#f4f6f9;margin:32px;color:#233044}.AnswerItem{width:660px;background:white;border:1px solid #e6eaf0;border-radius:10px;padding:24px;line-height:2}.HoverCard{position:absolute;right:24px;top:80px;width:350px;background:white;border:1px solid #e6eaf0;border-radius:10px;padding:20px;box-shadow:0 5px 25px #0002}a{color:#1964c5;text-decoration:none}.HoverCard:before{content:"用户信息悬浮卡片（模拟）";display:block;color:#728096;font-size:12px;margin-bottom:12px}.RichContent-inner{margin:18px 0}'});
     await p.evaluate(()=>{document.querySelector('.AuthorInfo a').textContent='示例作者';document.querySelector('.HoverCard .UserLink-link').textContent='示例用户';});
     await p.screenshot({path:process.env.FLOAT_SCREENSHOT,fullPage:true});
   }
   await p.close();return {confirmedPosts:2,renderedRows:20,restoredSelections:2,...layout};
 });
 await check('comment controls keep direct author and answer shortcut keeps its own answer ID',async()=>{
   const {p,h,actions}=await liveFixture(answer('alice',42)+answer('bob',99)+comment(101,'carol','评论','target'));
   await p.locator('.AnswerItem').nth(1).getByRole('button',{name:'预览回答赞同者',exact:true}).click();await until(()=>h.data.local.zbReview?.target==='99');
   assert.equal(actions.find(a=>a.action==='previewAnswerVoters').answerId,'99');
   await p.frameLocator('iframe[title="知乎屏蔽面板"]').locator('#reviewSummary').filter({hasText:'99'}).waitFor();
   await p.frameLocator('iframe[title="知乎屏蔽面板"]').locator('#closePanelBtn').click();
   await p.waitForFunction(()=>!document.querySelector('[data-zb-ui=panel]'));
   await p.locator('[data-id="101"]').getByRole('button',{name:'仅本机屏蔽',exact:true}).click();await until(()=>!!h.data.local['zb:hide:carol']);assert.ok(!h.data.local['zb:hide:target']);
   await p.close();
 });
 await check('500 nested comments are not rescanned after a parent-only change; inserted unit stays incremental',async()=>{
   const {p}=await liveFixture(answer('alice')+Array.from({length:500},(_,i)=>comment(1000+i,'c'+i,'普通评论')).join(''));
   await p.waitForFunction(()=>document.querySelectorAll('[data-zb-ui=controls]').length===501);
   await p.evaluate(()=>{window.audit={count:0};const original=scanner.authorOf;scanner.authorOf=unit=>{audit.count++;return original(unit);};document.querySelector('.RichContent-inner').firstChild.textContent='新正文';});
   await p.waitForTimeout(400);assert.equal(await p.evaluate(()=>audit.count),1);
   await p.evaluate(html=>{audit.count=0;document.body.insertAdjacentHTML('beforeend',html);},answer('new',100));
   await p.waitForFunction(()=>document.querySelectorAll('[data-zb-ui=controls]').length===502);await p.waitForTimeout(300);assert.ok(await p.evaluate(()=>audit.count)<=2);
   await p.close();return {parentChangeAuthors:1};
 });
 await check('1000-card author scan is bounded without walking body text',async()=>{
   const p=await context.newPage();await p.goto('https://www.zhihu.com/');await p.setContent(Array.from({length:1000},(_,i)=>answer('u'+i,i+1)).join(''));await p.addScriptTag({content:source('content/scanner.js')+';window.scanner=ZBScanner;'});
   const metric=await p.evaluate(()=>{const start=performance.now();const users=[...scanner.collectUnits()].map(unit=>scanner.authorOf(unit));return {users:users.length,elapsedMs:performance.now()-start};});
   assert.equal(metric.users,1000);assert.ok(metric.elapsedMs<2000);await p.close();return metric;
 });
 await context.close();
}finally{await browser.close();}
if(process.env.AUDIT_RESULTS)fs.writeFileSync(process.env.AUDIT_RESULTS,JSON.stringify(results,null,2));
console.log(results.length+' browser checks passed; all requests simulated or intercepted.');
})().catch(error=>{console.error(error);process.exit(1);});
