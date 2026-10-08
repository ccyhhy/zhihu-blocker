const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {source,root}=require('./helpers.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const results=[];
async function check(name,fn){const evidence=await fn();results.push({name,passed:true,evidence});console.log('PASS '+name);}
(async()=>{
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try {
  const context=await browser.newContext({viewport:{width:390,height:800}});
  await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'}):route.abort());
  const page=await context.newPage();
  const rule=(source,exclude=[])=>[{id:'r',keyword:'营销号',sources:[source],exclude}];
  const card=(token,body)=>'<div class="AnswerItem"><div class="AuthorInfo"><a class="UserLink-link" href="/people/'+token+'">'+token+'</a></div><div class="RichContent-inner">'+body+'</div></div>';
  async function fixture(html,url='https://www.zhihu.com/question/1/answer/2'){
    await page.goto(url);await page.setContent(html);
    await page.addScriptTag({content:source('content/scanner.js')+';window.scanner=ZBScanner;'});
  }
  const matches=(rules,white=[])=>page.evaluate(({rules,white})=>scanner.matchUsers(scanner.extractUsers(),rules,white).map(u=>u.urlToken),{rules,white});
  await check('username links no longer cut off answer context',async()=>{
    await fixture(card('alice','营销号'));assert.deepEqual(await matches(rule('answer')),['alice']);
  });
  await check('multiple posts of same user aggregate without losing later match',async()=>{
    await fixture(card('alice','普通内容')+card('alice','营销号'));assert.deepEqual(await matches(rule('answer')),['alice']);
  });
  await check('nested comments belong only to their direct authors',async()=>{
    await fixture('<div class="AnswerItem"><a href="/people/alice">Alice</a><div class="RichContent-inner">普通回答</div><div class="CommentItem"><a href="/people/bob">Bob</a><div class="CommentContent">营销号</div></div></div>');
    assert.deepEqual(await matches(rule('comment')),['bob']);assert.deepEqual(await matches(rule('answer')),[]);
  });
  const modernComment=(id,token,body,target='')=>'<div data-id="'+id+'"><div><a href="/people/'+token+'"><img class="Avatar" alt="'+token+'"></a><div><div><a href="/people/'+token+'">'+token+'</a>'+(target?'<a href="/people/'+target+'">'+target+'</a>':'')+'</div><div class="CommentContent">'+body+'</div><button>回复</button></div></div></div>';
  await check('modern comments and replies identify avatar author, not reply target or quoted user',async()=>{
    await fixture('<div data-id="999">'+card('alice','普通回答')+modernComment(101,'bob','营销号 <a href="/people/quoted">引用者</a>','target')+modernComment(102,'carol','普通评论')+'</div><div data-id="103"><a href="/people/uncertain">不明作者</a><div class="CommentContent">营销号</div></div>');
    assert.deepEqual(await matches(rule('comment')),['bob']);
    const users=await page.evaluate(()=>scanner.extractUsers().map(u=>({token:u.urlToken,name:u.name,text:u.context.comment})));
    assert.equal(users.find(u=>u.token==='bob').name,'bob');assert.ok(!users.some(u=>u.token==='target'||u.token==='quoted'||u.token==='uncertain'));
    assert.equal(await page.evaluate(()=>scanner.closestUnit(document.querySelector('[data-id="101"] .CommentContent')).getAttribute('data-id')),'101');
  });
  await check('modern comment nesting and author introduction remain separate from answer content',async()=>{
    await fixture('<div class="AnswerItem" data-id="2"><div class="AuthorInfo"><a href="/people/alice">Alice</a><div class="AuthorInfo-detail"><div class="AuthorInfo-badgeText ztext">营销号</div></div></div><div class="RichContent-inner">普通回答'+modernComment(101,'bob','普通评论'+modernComment(102,'carol','营销号','bob'))+'</div></div><div class="ContentItem" data-za-detail-view-path-module="UserItem"><span class="UserLink"><a href="/people/dave">Dave</a></span><div class="ContentItem-meta"><div><div class="ztext">营销号</div><div class="ContentItem-status">100 回答</div></div></div></div>');
    assert.deepEqual(await matches(rule('bio')),['alice','dave']);assert.deepEqual(await matches(rule('answer')),[]);assert.deepEqual(await matches(rule('comment')),['carol']);
  });
  await check('current following route works while private lists and topic tabs do not offer user-list actions',async()=>{
    await fixture('<main>由于对方已设置，他关注的人不可见</main>','https://www.zhihu.com/people/alice/following');
    assert.equal(await page.evaluate(()=>scanner.detectPageType()),'followees');assert.ok(await page.evaluate(()=>scanner.listUnavailable()));
    await fixture('','https://www.zhihu.com/people/alice/following/topics');assert.equal(await page.evaluate(()=>scanner.detectPageType()),'feed');
    await fixture('','https://www.zhihu.com/people/alice/followers');assert.equal(await page.evaluate(()=>scanner.detectPageType()),'followers');
  });
  await check('article type and /p/ path classify correctly',async()=>{
    await fixture('<article class="Post-Main"><div class="Post-Author"><a href="/people/alice">Alice</a></div><div class="Post-RichTextContainer">营销号</div></article>','https://zhuanlan.zhihu.com/p/123456');
    assert.equal(await page.evaluate(()=>scanner.detectPageType()),'article');
    assert.deepEqual(await matches(rule('article')),['alice']);assert.deepEqual(await matches(rule('answer')),[]);
  });
  await check('typed article itemId is excluded, typed answer ID is accepted',async()=>{
    await fixture('<div class="ArticleItem" data-zop=\'{"type":"article","itemId":111}\'></div><div class="AnswerItem" data-zop=\'{"itemId":222,"type":"answer"}\'></div>','https://www.zhihu.com/');
    assert.deepEqual(await page.evaluate(()=>scanner.extractAnswerIdsFromPage().map(a=>a.answerId)),['222']);
  });
  await check('promoter links and quoted profile links are never treated as author',async()=>{
    await fixture('<div class="AnswerItem"><div class="UserLink"><a href="/people/promoter">Promoter</a></div><div class="AuthorInfo"><a href="/people/alice">Alice</a></div><div class="RichContent-inner">营销号 <a href="/people/quoted">Quoted</a></div></div>');
    assert.deepEqual(await matches(rule('answer')),['alice']);
  });
  await check('per-statement exclude terms and whitelist work without suppressing another matching post',async()=>{
    await fixture(card('alice','反驳营销号')+card('alice','营销号'));
    assert.deepEqual(await matches(rule('answer',['反驳'])),['alice']);
    assert.deepEqual(await matches(rule('answer',['反驳']),['alice']),[]);
    await fixture(card('alice','反驳营销号'));assert.deepEqual(await matches(rule('answer',['反驳'])),[]);
  });
  await check('keywords beyond old 2000-character truncation are detected',async()=>{
    await fixture(card('alice','普通内容'.repeat(800)+'营销号'));assert.deepEqual(await matches(rule('answer')),['alice']);
  });
  await check('first added rule activates existing page and later mutations scan only changed units',async()=>{
    await fixture(Array.from({length:500},(_,i)=>card('u'+i,'普通内容')).join('')+card('alice','营销号'));
    await page.evaluate(()=>{
      window.audit={data:{settings:{autoMode:true,whitelist:[],ruleSourceDefaults:['answer']},rules:[]},listeners:[],calls:[],units:0,users:0};
      const original=scanner.extractUsers;
      scanner.extractUsers=roots=>{const result=original(roots);audit.units+=roots.length;audit.users+=result.length;return result;};
      window.chrome={runtime:{id:'audit',lastError:null,sendMessage:(msg,cb)=>{audit.calls.push(msg);cb({accepted:msg.users?.map(u=>u.urlToken)||[]});},onMessage:{addListener(){}}},
        storage:{onChanged:{addListener(fn){audit.listeners.push(fn);},removeListener(){}},sync:{
          get(defaults,cb){cb({...defaults,...audit.data});},
          set(value,cb){const changes={};for(const k in value){changes[k]={oldValue:audit.data[k],newValue:value[k]};audit.data[k]=value[k];}cb();audit.listeners.forEach(fn=>fn(changes,'sync'));}
        }}};
    });
    await page.addScriptTag({content:source('lib/storage.js')});await page.addScriptTag({content:source('content/ui.js')});
    assert.equal(await page.evaluate(()=>audit.calls.length),0);
    await page.evaluate(()=>chrome.storage.sync.set({rules:[{id:'r',keyword:'营销号',sources:['answer'],exclude:[]}]},()=>{}));
    await page.waitForFunction(()=>audit.calls.length===1);
    assert.equal(await page.evaluate(()=>audit.calls[0].users[0].urlToken),'alice');
    const baseline=await page.evaluate(()=>{const r={units:audit.units,users:audit.users};audit.units=0;audit.users=0;return r;});
    await page.evaluate(()=>{const el=document.createElement('div');el.className='AnswerItem';el.innerHTML='<a href="/people/newuser">New</a><div class="RichContent-inner">营销号</div>';document.body.appendChild(el);});
    await page.waitForFunction(()=>audit.calls.length===2);
    const incremental=await page.evaluate(()=>({units:audit.units,users:audit.users}));
    assert.equal(incremental.units,1);assert.equal(incremental.users,1);
    await page.evaluate(html=>{const wrapper=document.createElement('div');wrapper.innerHTML=html;document.body.appendChild(wrapper);},modernComment(201,'newcomment','普通评论'));
    await page.waitForTimeout(700);
    await page.evaluate(()=>chrome.storage.sync.set({rules:[{id:'c',keyword:'营销号',sources:['comment'],exclude:[]}]},()=>{}));
    await page.waitForTimeout(800);
    await page.evaluate(()=>{audit.units=0;audit.users=0;document.querySelector('[data-id="201"] .CommentContent').textContent='营销号';});
    await page.waitForFunction(()=>audit.calls.length===3);
    assert.equal(await page.evaluate(()=>audit.calls[2].users[0].urlToken),'newcomment');
    assert.equal(await page.evaluate(()=>audit.units),1);
    // Removing a rule stops scanning, including already scheduled work.
    await page.evaluate(()=>chrome.storage.sync.set({rules:[]},()=>{}));
    await page.evaluate(()=>{document.querySelector('.RichContent-inner').textContent='营销号';});
    await page.waitForTimeout(700);assert.equal(await page.evaluate(()=>audit.calls.length),3);
    return {baseline,incremental};
  });
  await check('500 nested comments are not recursively rescanned when only parent unit changes',async()=>{
    await fixture('<div class="AnswerItem"><a href="/people/alice">Alice</a><div class="RichContent-inner">普通回答</div>'+Array.from({length:500},(_,i)=>'<div class="CommentItem"><a href="/people/c'+i+'">Commenter</a><div class="CommentContent">普通评论</div></div>').join('')+'</div>');
    const count=await page.evaluate(()=>scanner.extractUsers([document.querySelector('.AnswerItem')]).length);
    assert.equal(count,1);return {changedParentUsers:count};
  });
  await check('rule reload during an in-flight submission does not reuse old acceptance',async()=>{
    await fixture(card('alice','营销号 推广'));
    await page.evaluate(()=>{
      window.race={rules:[{id:'r',keyword:'营销号',sources:['answer'],exclude:[]}],listeners:[],calls:[],scans:0,first:null};
      const original=scanner.extractUsers;scanner.extractUsers=roots=>{race.scans++;return original(roots);};
      window.chrome={runtime:{id:'audit',lastError:null,onMessage:{addListener(){}},sendMessage:(m,cb)=>{
        race.calls.push(m);if(race.calls.length===1)race.first=cb;else cb({accepted:['alice']});
      }},storage:{onChanged:{addListener(fn){race.listeners.push(fn);},removeListener(){}},sync:{
        get:(d,cb)=>cb({...d,rules:race.rules,settings:{autoMode:true,whitelist:[]}})
      }}};
    });
    await page.addScriptTag({content:source('lib/storage.js')});await page.addScriptTag({content:source('content/ui.js')});
    await page.waitForFunction(()=>race.calls.length===1);
    await page.evaluate(()=>{race.rules=[{id:'new',keyword:'推广',sources:['answer'],exclude:[]}];race.listeners.forEach(fn=>fn({rules:{newValue:race.rules}},'sync'));});
    await page.waitForFunction(()=>race.scans===2);
    await page.evaluate(()=>race.first({accepted:['alice']}));
    await page.waitForFunction(()=>race.calls.length===2);
    assert.equal(await page.evaluate(()=>race.calls[1].users[0].evidence[0].keyword),'推广');
  });
  await check('1000-card scan remains bounded and records elapsed time',async()=>{
    await fixture(Array.from({length:1000},(_,i)=>card('u'+i,i===999?'营销号':'普通内容')).join(''));
    const metric=await page.evaluate(r=>{const start=performance.now();const users=scanner.extractUsers();const matches=scanner.matchUsers(users,r);return {users:users.length,matches:matches.length,elapsedMs:performance.now()-start};},rule('answer'));
    assert.equal(metric.users,1000);assert.equal(metric.matches,1);assert.ok(metric.elapsedMs<2000);return metric;
  });
  await check('popup restores task, shows escaped evidence, saves simple controls and renders within width',async()=>{
    await page.goto('https://www.zhihu.com/');
    const html=source('popup/popup.html').replace(/<script[\s\S]*?<\/script>/g,'').replace('<link rel="stylesheet" href="popup.css">','<style>'+source('popup/popup.css')+'</style>');
    await page.setContent(html);
    await page.evaluate(()=>{
      window.popupState={settings:{autoMode:true,whitelist:[],ruleSourceDefaults:['answer'],blockIntervalMin:0,blockIntervalMax:0,pageInterval:0,blockConcurrency:5},rules:[]};
      window.chrome={runtime:{id:'audit',lastError:null,onMessage:{addListener(){}},sendMessage:(m,cb)=>{
        if(m.action==='getPageContext')return cb(popupState.context || {type:'answer',answers:[{answerId:'42',author:'Alice',excerpt:'回答摘要'}]});
        if(m.action==='getState')return cb({task:{id:'1',status:'paused',fetched:6,blocked:2,skipped:1,failed:1,unknown:1,remaining:1,error:'已暂停',uncertainUsers:[{urlToken:'uncertain-user',name:'<img src=x>'}],evidence:[{name:'Alice',source:'answer',text:'<img src=x onerror=alert(1)>'}]},stats:{account:'owner',daily:2,total:20}});
        cb({});
      }},storage:{onChanged:{addListener(){}},sync:{get:(d,cb)=>cb({...d,...popupState}),set:(v,cb)=>{Object.assign(popupState,v);cb();}}}};
    });
    await page.addScriptTag({content:source('lib/storage.js')});await page.addScriptTag({content:source('popup/popup.js')});
    await page.evaluate(()=>document.dispatchEvent(new Event('DOMContentLoaded')));
    await page.waitForFunction(()=>document.getElementById('taskToggleBtn').textContent==='继续');
    assert.equal(await page.locator('#dailyCount').textContent(),'2');
    assert.equal(await page.locator('#taskEvidence img').count(),0);assert.equal(await page.locator('#taskEvidence a').getAttribute('href'),'https://www.zhihu.com/people/uncertain-user');
    await page.locator('#keywordInput').fill('营销号');await page.locator('.exclude-options summary').click();await page.locator('#excludeInput').fill('反驳');
    await page.locator('#addRuleBtn').click();await page.waitForFunction(()=>popupState.rules.length===1);
    assert.deepEqual(await page.evaluate(()=>popupState.rules[0].exclude),['反驳']);
    await page.locator('#headerSettingsBtn').click();await page.locator('#whitelistInput').fill('https://www.zhihu.com/people/alice');
    await page.locator('#saveSettingsBtn').click();await page.waitForFunction(()=>popupState.settings.whitelist.length===1);
    assert.deepEqual(await page.evaluate(()=>popupState.settings.whitelist),['alice']);
    const layout=await page.evaluate(()=>({bodyWidth:document.body.getBoundingClientRect().width,scrollWidth:document.body.scrollWidth}));
    assert.ok(layout.scrollWidth<=layout.bodyWidth+1);
    const screenshot=process.env.AUDIT_SCREENSHOT;
    if(screenshot) { await page.evaluate(()=>{document.getElementById('settingsToggle').click();document.querySelector('.exclude-options').open=false;document.getElementById('taskEvidence').textContent='Alice · 回答：示例命中内容';window.scrollTo(0,0);});await page.screenshot({path:screenshot,fullPage:true}); }
    await page.evaluate(()=>{popupState.context={type:'followees',answers:[],listUnavailable:'对方已设置关注名单不可见，无法处理此名单。'};});
    await page.locator('#refreshPageBtn').click();await page.waitForFunction(()=>document.getElementById('actionHint').textContent.includes('不可见'));
    assert.equal(await page.locator('[data-start-task]').count(),0);
    return layout;
  });
  await context.close();
} finally {await browser.close();}
if(process.env.AUDIT_RESULTS)fs.writeFileSync(process.env.AUDIT_RESULTS,JSON.stringify(results,null,2));
console.log(results.length+' browser checks passed; all page requests were intercepted.');
})().catch(e=>{console.error(e);process.exitCode=1;});
