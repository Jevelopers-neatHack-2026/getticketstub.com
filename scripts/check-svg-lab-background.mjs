// Actual browser control: untrusted background query values must not initiate any URL request.
import assert from 'node:assert/strict';
import {launchBrowser} from './lib/cdp.mjs';
const browser=await launchBrowser();let passed=0;
try {
 const page=await browser.newPage({width:1280,height:900}),attempts=[];
 await page.send('Fetch.enable',{patterns:[{urlPattern:'*__bg_probe__*',resourceType:'Image',requestStage:'Request'}]});
 const off=page.conn.on(m=>{if(m.sessionId===page.sid&&m.method==='Fetch.requestPaused'){attempts.push(m.params.request.url);void page.send('Fetch.failRequest',{requestId:m.params.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}});
 try {
  const cases=[
   ['url("https://background-probe.invalid/__bg_probe__")','rgb(26, 26, 26)'],
   ['image-set(url("https://background-probe.invalid/__bg_probe__") 1x)','rgb(26, 26, 26)'],
   ['url("/__bg_probe__")','rgb(26, 26, 26)'],
   ['red url("https://background-probe.invalid/__bg_probe__")','rgb(26, 26, 26)'],
   ['var(--external-background)','rgb(26, 26, 26)'],
   ['#AbC','rgb(170, 187, 204)'],['#123456','rgb(18, 52, 86)'],['transparent','rgba(0, 0, 0, 0)']
  ];
  for(const [bg,color] of cases){
   const before=attempts.length,url=new URL('/stub-lab',process.argv[2]);url.search=new URLSearchParams({t:'premiere',w:'300',bg}).toString();
   await page.goto(url.href);assert.ok(await page.waitFor(`document.body.dataset.stubReady==='1'`,15000));
   const style=await page.eval(`(()=>{const s=getComputedStyle(document.querySelector('#stub').closest('main'));return{color:s.backgroundColor,image:s.backgroundImage};})()`);
   console.log('BG_PROBE',JSON.stringify({input:bg,style,attempts:attempts.length-before}));
   assert.equal(attempts.length,before,'background query initiated a resource request');assert.equal(style.image,'none');assert.equal(style.color,color);passed++;console.log('PASS background is literal color only');
  }
 }finally{off();await page.close();}
}finally{await browser.close();}
console.log(`${passed} passed, 0 failed`);
