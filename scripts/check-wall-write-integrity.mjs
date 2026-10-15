// Offline production React consumer check; synthetic auth/sync and Storage faults only.
import assert from 'node:assert/strict';
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
 const warning=`document.body.textContent.includes('server acknowledged your wall, but this browser could not save')`;
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
 await page.close();
}finally{await browser.close();}
console.log(`${passed} passed, 0 failed`);
