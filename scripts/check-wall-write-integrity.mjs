// Offline production React consumer check; synthetic auth/sync and Storage faults only.
import assert from 'node:assert/strict';
import '../tests/analytics-hooks.mjs';
const {newStub,PALE_HOURS}=await import('../src/customer/studio/fixtures.ts');
import { launchBrowser } from './lib/cdp.mjs';
const browser=await launchBrowser();let passed=0;
const check=(name,ok)=>{assert.ok(ok,name);passed++;console.log(`PASS ${name}`);};
try {
 const page=await browser.newPage({width:1280,height:900});
 await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`
 window.__fault=true;window.__syncCalls=0;
 const set=Storage.prototype.setItem;
 Storage.prototype.setItem=function(k,v){if(k==='ticketstub.wall.v1' && window.__fault)throw new DOMException('fixture fault','QuotaExceededError');return set.call(this,k,v);};
 const originalFetch=window.fetch.bind(window);
 window.fetch=async (input,init)=>{const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
 if(path==='/api/auth/me')return Response.json({account:{id:'fixture-account',email:'fixture@example.test'}});
 if(path==='/api/wall/sync'){window.__syncCalls++;return Response.json({stubs:[],deleted:[],now:Date.now()});}return originalFetch(input,init);};
 `});
 await page.goto((process.argv[2]??'http://127.0.0.1:4317')+'/make');
 const warning=`document.body.textContent.includes('server acknowledged your wall, but this browser could not safely update')`;
 check('normal signed-in mount exposes remote acknowledgement with failed local save',await page.waitFor(warning,10000));
 await page.eval(`new Promise(r=>setTimeout(r,5100))`);
 check('local warning persists until recovery',await page.eval(warning));
 await page.eval(`window.__fault=false;[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry saving on this device').focus()`);
 await page.key('Enter');check('keyboard retry clears warning after successful local write',await page.waitFor(`!(${warning})`,10000));
 for(const event of ['focus','ticketstub:wall-changed']){
 await page.eval(`window.__fault=true;window.dispatchEvent(new Event(${JSON.stringify(event)}))`);
 check(`${event} failure is visible`,await page.waitFor(warning,10000));
 await page.eval(`window.__fault=false;window.dispatchEvent(new Event('focus'))`);
 check(`${event} recovery is visible`,await page.waitFor(`!(${warning})`,10000));
 }
 await page.resize(320,900);
 await page.eval(`window.__fault=true;window.dispatchEvent(new Event('focus'))`);
 check('phone warning is visible',await page.waitFor(warning,10000));
 check('phone warning/retry fit within viewport',await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry saving on this device');const r=b.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1 && r.left>=0 && r.right<=innerWidth+1;})()`));
 await page.eval(`window.__fault=false;localStorage.setItem('ticketstub.wall.v1','[null]');window.__before=window.__syncCalls;window.dispatchEvent(new Event('focus'))`);
 check('unreadable wall shows distinct nothing-sent message',await page.waitFor(`document.body.textContent.includes('Nothing was sent to the server')`,10000));
 check('unreadable wall has no remote request and retains original bytes',await page.eval(`window.__syncCalls===window.__before && localStorage.getItem('ticketstub.wall.v1')==='[null]'`));
 await page.eval(`localStorage.setItem('ticketstub.wall.v1','[]');localStorage.setItem('ticketstub.wall.deleted.v1','[]');window.dispatchEvent(new Event('focus'))`);
 check('readable local data recovers before deletion-queue negative',await page.waitFor(`!document.body.textContent.includes('Nothing was sent to the server')`,10000));
 await page.eval(`localStorage.setItem('ticketstub.wall.deleted.v1','{}');window.__before=window.__syncCalls;window.dispatchEvent(new Event('focus'))`);
 check('malformed deletion history gets accurate saved-data message, not unreadable-wall claim',await page.waitFor(`document.body.textContent.includes('Some saved data on this browser could not be read')`,10000));
 check('unknown deletion queue sends nothing and preserves both keys',await page.eval(`window.__syncCalls===window.__before && localStorage.getItem('ticketstub.wall.v1')==='[]' && localStorage.getItem('ticketstub.wall.deleted.v1')==='{}'`));
 await page.close();
 const wall=await browser.newPage({width:1280,height:900});
 await wall.send('Page.addScriptToEvaluateOnNewDocument',{source:`
 window.__deleteFault=false;window.__recoveryFault=false;
 const originalRemove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(k==='ticketstub.wall.mutation.v1'&&window.__recoveryFault)throw new DOMException('fixture recovery fault','SecurityError');return originalRemove.call(this,k);};
 const originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='ticketstub.wall.deleted.v1'&&window.__deleteFault)throw new DOMException('fixture fault','SecurityError');return originalSet.call(this,k,v);};
 const originalFetch=window.fetch.bind(window);window.fetch=async(input,init)=>new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/auth/me'?Response.json({account:null}):originalFetch(input,init);
 `});
 await wall.goto((process.argv[2]??'http://127.0.0.1:4317')+'/make');
 const seeded=newStub(structuredClone(PALE_HOURS),'delete-fixture');seeded.wallX=100;seeded.wallY=100;
 await wall.eval(`localStorage.setItem('ticketstub.wall.v1',${JSON.stringify(JSON.stringify([seeded]))});localStorage.setItem('ticketstub.wall.deleted.v1','[]')`);
 await wall.goto((process.argv[2]??'http://127.0.0.1:4317')+'/wall');
 check('deletion fixture card is visible',await wall.waitFor(`!!document.querySelector('[data-stub-id="delete-fixture"]')`,10000));
 const click=async prefix=>{const rect=await wall.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent.trim()).startsWith(${JSON.stringify(prefix)})&&b.getClientRects().length);if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);assert.ok(rect,prefix);await wall.click(rect.x,rect.y);};
 await click('Lift ');await wall.waitFor(`!!document.querySelector('[role="dialog"]')`,10000);
 await wall.eval(`window.__deleteFault=true;window.__beforeWall=localStorage.getItem('ticketstub.wall.v1')`);
 await click('Take it down');await click('Tap again to take it down');
 check('failed native delete retains card and exposes announced retry',await wall.waitFor(`!!document.querySelector('[data-stub-id="delete-fixture"]') && document.querySelector('[role="dialog"]').textContent.includes('Could not save this removal') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Retry taking it down')`,10000));
 check('failed native delete restores exact persisted wall and keeps tombstones unchanged',await wall.eval(`localStorage.getItem('ticketstub.wall.v1')===window.__beforeWall && localStorage.getItem('ticketstub.wall.deleted.v1')==='[]'`));
 await wall.eval(`window.__deleteFault=false;[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry taking it down').focus()`);await wall.key('Enter');
 check('keyboard retry removes card only after durable deletion succeeds',await wall.waitFor(`!document.querySelector('[data-stub-id="delete-fixture"]') && JSON.parse(localStorage.getItem('ticketstub.wall.v1')).length===0 && JSON.parse(localStorage.getItem('ticketstub.wall.deleted.v1')).includes('delete-fixture')`,10000));
 // Exact interrupted preparation survives a reload; neither elapsed time nor ordinary retry resolves it.
 const before=JSON.stringify([seeded]);
 await wall.eval(`localStorage.setItem('ticketstub.wall.v1',${JSON.stringify(before)});localStorage.setItem('ticketstub.wall.deleted.v1','[]');localStorage.setItem('ticketstub.wall.mutation.v1',${JSON.stringify(JSON.stringify({phase:'prepared',beforeWall:before,beforeDeleted:'[]',afterWall:'[]',afterDeleted:'["delete-fixture"]'}))})`);
 await wall.goto((process.argv[2]??'http://127.0.0.1:4317')+'/wall');
 check('reloaded guest sees explicit interrupted-save recovery without inventing an empty wall',await wall.waitFor(`!!document.querySelector('[aria-label="Recover interrupted wall save"]')`,10000));
 for(const [width,height] of [[1280,900],[390,844]]){
 await wall.resize(width,height);
 console.log("RECOVERY_VIEWPORT",JSON.stringify(await wall.eval(`(()=>{const p=document.querySelector('[aria-label="Recover interrupted wall save"]'),r=p.getBoundingClientRect();return{width:innerWidth,height:innerHeight,scrollY,top:r.top,bottom:r.bottom,left:r.left,right:r.right,clientHeight:p.clientHeight,scrollHeight:p.scrollHeight};})()`)));
 check(`recovery panel is inside initial ${width}x${height} viewport`,await wall.eval(`(()=>{const p=document.querySelector('[aria-label="Recover interrupted wall save"]'),r=p.getBoundingClientRect();return scrollY===0&&r.width>0&&r.height>0&&r.top>=0&&r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&getComputedStyle(p).visibility==='visible'&&getComputedStyle(p).display!=='none'&&p.scrollHeight>=p.clientHeight;})()`));
 check(`recovery controls are labeled and confirmation gates action at ${width}`,await wall.eval(`(()=>{const p=document.querySelector('[aria-label="Recover interrupted wall save"]'),i=p.querySelector('input[type="checkbox"]'),b=[...p.querySelectorAll('button')].find(b=>b.textContent.trim()==='Restore previous saved wall');return !!i.closest('label')&&i.closest('label').textContent.includes('No other save is running')&&!i.checked&&b.disabled;})()`));
 await wall.eval(`document.querySelector('[aria-label="Recover interrupted wall save"] input').focus()`);await wall.key(' ');await wall.key('Tab');
 check(`native keyboard reaches visible enabled restore control at ${width}`,await wall.eval(`(()=>{const b=document.activeElement,r=b.getBoundingClientRect();return b.tagName==='BUTTON'&&b.textContent.trim()==='Restore previous saved wall'&&!b.disabled&&r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1;})()`));
 await wall.eval(`document.querySelector('[aria-label="Recover interrupted wall save"] input').focus()`);await wall.key(' ');
 }
 await wall.resize(1280,900);
 check('restoration requires affirmative exclusive-use confirmation',await wall.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Restore previous saved wall').disabled && !!localStorage.getItem('ticketstub.wall.mutation.v1')`));
 await wall.eval(`document.querySelector('[aria-label="Recover interrupted wall save"] input').focus()`);await wall.key(' ');
 await wall.eval(`window.__deleteFault=false;window.__recoveryFault=true;[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Restore previous saved wall').focus()`);await wall.key('Enter');
 check('failed explicit restore announces truthful failure and retains blocked journal',await wall.waitFor(`document.querySelector('[aria-label="Recover interrupted wall save"]').textContent.includes('Could not restore safely') && !!localStorage.getItem('ticketstub.wall.mutation.v1')`,10000));
 await wall.eval(`window.__recoveryFault=false;document.querySelector('[aria-label="Recover interrupted wall save"] input').focus()`);await wall.key(' ');
 await wall.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Restore previous saved wall').focus()`);await wall.key('Enter');
 check('confirmed native recovery reloads restored card and clears preparation',await wall.waitFor(`!localStorage.getItem('ticketstub.wall.mutation.v1') && !!document.querySelector('[data-stub-id="delete-fixture"]') && !document.querySelector('[aria-label="Recover interrupted wall save"]')`,10000));
 const diverged=JSON.stringify([{...seeded,id:'peer-fixture'}]);
 await wall.eval(`localStorage.setItem('ticketstub.wall.v1',${JSON.stringify(diverged)});localStorage.setItem('ticketstub.wall.mutation.v1',${JSON.stringify(JSON.stringify({phase:'prepared',beforeWall:before,beforeDeleted:'[]',afterWall:'[]',afterDeleted:'["delete-fixture"]'}))});window.dispatchEvent(new Event('focus'))`);
 check('diverged peer data has truthful blocked message and no rollback action',await wall.waitFor(`document.body.textContent.includes('Saved data differs from the interrupted save record') && ![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Restore previous saved wall')`,10000));
 check('diverged recovery inspection preserves peer bytes and journal',await wall.eval(`localStorage.getItem('ticketstub.wall.v1')===${JSON.stringify(diverged)} && !!localStorage.getItem('ticketstub.wall.mutation.v1')`));
 await wall.close();
}finally{await browser.close();}
console.log(`${passed} passed, 0 failed`);
