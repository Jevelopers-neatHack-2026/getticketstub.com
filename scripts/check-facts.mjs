// Offline production-browser checks for fact identities, inclusion and measured local layout.
// Start a demo server, then: node scripts/check-facts.mjs http://127.0.0.1:4317
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import '../tests/analytics-hooks.mjs';
import { launchBrowser } from './lib/cdp.mjs';
const { newStub } = await import('../src/customer/studio/fixtures.ts');
const base = process.argv[2] ?? 'http://127.0.0.1:4317';
const evidenceDir = process.argv[3] ? join(process.argv[3], 'facts') : null;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
const browser = await launchBrowser();
let passed = 0;
const check = (name, ok) => { assert.ok(ok, name); passed++; console.log(`PASS ${name}`); };
try {
  const page = await browser.newPage({ width: 1280, height: 900 });
  await page.goto(base + '/make');
  const seed = async (count, edition, long = false, collision = false) => {
    const facts = Array.from({ length: count }, (_, i) => ({ id: `f${i}`, label: long ? `Fact ${i} ${'long text '.repeat(100)}` : `Fact ${i}`, value: `Value ${i}`, source: 'offline fixture', confidence: .9, provenance: 'simulated', kept: true }));
    const stub = newStub({ type: 'concert', title: 'Offline fit test', venue: 'Hall', dateISO: '2026-10-10', setlist: [{ title: 'Occupied back' }], facts }, 'fact-browser');
    stub.versions[0].edition = edition;
    if (collision) stub.event.facts[1].id = stub.event.facts[0].id;
    await page.eval(`localStorage.setItem('ticketstub.wall.v1', ${JSON.stringify(JSON.stringify([stub]))})`);
    await page.goto(base + '/studio/fact-browser');
    await page.waitFor(`document.querySelector('figure[data-edition]')`, 10000);
  };
  const click = async (prefix) => {
    const rect = await page.eval(`(async () => { const b = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()).startsWith(${JSON.stringify(prefix)}) && b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden'); if (!b) return null; b.scrollIntoView({block:'center'}); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    assert.ok(rect, `visible button ${prefix}`);
    await page.click(rect.x, rect.y);
  };
  for (const width of [320, 375, 640, 1280]) {
    await page.resize(width, 900, width === 640 ? 2 : 1);
    for (const edition of ['minimal', 'researched']) {
      await seed(6, edition);
      if (width < 700) await click('Facts');
      check(`${width}/${edition}: local proof resolves`, await page.waitFor(`document.body.textContent.includes('Selected extra facts fit') || document.body.textContent.includes('These facts do not fit completely')`, 10000));
      const status = await page.eval(`document.body.textContent.includes('Selected extra facts fit')`);
      check(`${width}/${edition}: six short facts fit`, status);
      await click('Remove from stub: Fact 0');
      check(`${width}/${edition}: only requested fact removed`, await page.waitFor(`JSON.parse(localStorage.getItem('ticketstub.wall.v1'))[0].event.facts.map(f=>f.kept).join(',') === 'false,true,true,true,true,true'`));
      await click('Add to stub: Fact 0');
      check(`${width}/${edition}: choice restored`, await page.waitFor(`JSON.parse(localStorage.getItem('ticketstub.wall.v1'))[0].event.facts.every(f=>f.kept)`));
      await page.waitFor(`![...document.querySelectorAll('button[aria-label^="Add to stub: Fact 0"]')].some(b=>b.checkVisibility() && !b.closest('[inert]'))`);
      const controls = await page.eval(`(() => { const bs=[...document.querySelectorAll('button[aria-label^="Remove from stub:"]')].filter(b=>b.checkVisibility() && !b.closest('[inert]')); return bs.map(b=>({name:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed'),height:b.getBoundingClientRect().height,minHeight:parseFloat(getComputedStyle(b).minHeight)})); })()`);
      console.log('CONTROLS',width,edition,JSON.stringify(controls));
      check(`${width}/${edition}: action semantics and targets`, controls.length === 6 && controls.every(b=>b.pressed===null && b.minHeight>=44 && Math.round(b.height*100)/100>=44));
      check(`${width}/${edition}: no page overflow`, await page.eval(`document.documentElement.scrollWidth <= innerWidth + 1`));
      if (evidenceDir && edition === 'minimal') await page.screenshot(join(evidenceDir, `facts-${width}.png`));
    }
  }
  await page.resize(1280, 900);
  await seed(2, 'minimal', false, true);
  await click('Remove from stub: Fact 1');
  check('legacy duplicate IDs normalize and target only the second fact', await page.eval(`(() => { const fs=JSON.parse(localStorage.getItem('ticketstub.wall.v1'))[0].event.facts; return fs[0].id !== fs[1].id && fs[0].kept && !fs[1].kept; })()`));
  await page.goto(base + '/studio/fact-browser');
  check('independent legacy choice survives reload', await page.waitFor(`!!document.querySelector('button[aria-label="Add to stub: Fact 1"]')`,10000));
  await page.eval(`document.querySelector('button[aria-label="Add to stub: Fact 1"]').focus()`);
  await page.key('Enter');
  check('keyboard activation preserves the repaired row identity and focus', await page.waitFor(`document.activeElement?.getAttribute('aria-label') === 'Remove from stub: Fact 1' && JSON.parse(localStorage.getItem('ticketstub.wall.v1'))[0].event.facts.every(f=>f.kept)`));
  for (const edition of ['classic','letterpress','risograph','minimal','researched']) for (const count of [0,1,5,6,10]) {
    await seed(count, edition);
    if (!count) check(`${edition}/0: no selected-fact overflow`, await page.eval(`!document.body.textContent.includes('These facts do not fit completely:')`));
    if (count) check(`${edition}/${count}: local fit result available`, await page.waitFor(`document.body.textContent.includes('Selected extra facts fit') || document.body.textContent.includes('These facts do not fit completely')`,10000));
  }
  const mixed = newStub({ type: 'generic', title: 'Ordered facts', venue: 'Hall', dateISO: '2026-10-10', facts: ['A','B','C'].map((id,i)=>({id,label:id,value:id,source:'fixture',confidence:i===1?.5:.9,provenance:'simulated',kept:true})) }, 'fact-browser');
  mixed.versions[0].edition = 'minimal';
  await page.eval(`localStorage.setItem('ticketstub.wall.v1', ${JSON.stringify(JSON.stringify([mixed]))})`);
  await page.goto(base + '/studio/fact-browser');
  check('mixed-confidence identities stay A/B/C on both rendered faces', await page.waitFor(`(() => { const figures=[...document.querySelectorAll('figure[data-edition="minimal"]')].sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width); const ids=[...figures[0]?.querySelectorAll('[data-fact-id]')||[]].map(e=>e.dataset.factId); return ids.join(',')==='A,B,C,A,B,C'; })()`,10000));
  await seed(10, 'minimal', true);
  check('long selected facts produce explicit blocked identities', await page.waitFor(`document.body.textContent.includes('These facts do not fit completely:')`, 10000));
  await click('Download PNG');
  check('clipped selected facts block PNG export with recovery guidance', await page.waitFor(`document.body.textContent.includes('Some selected facts do not fit completely.')`,10000));
  if (evidenceDir) await page.screenshot(join(evidenceDir, 'overflow-refused.png'));
  // Real production React account UI, with explicit synthetic auth/sync transport and a failed browser cache.
  const accountPage = await browser.newPage({ width: 1280, height: 900 });
  await accountPage.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.removeItem('ticketstub.wall.v1');
    window.__syncFault = true;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k,v) {
      if(k==='ticketstub.wall.v1' && window.__syncFault) throw new DOMException('synthetic storage fault','QuotaExceededError');
      return originalSet.call(this,k,v);
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input,init) => {
      const path = new URL(typeof input==='string'?input:input.url,location.href).pathname;
      if(path==='/api/auth/me') return Response.json({account:{id:'synthetic-account',email:'fixture@example.test'}});
      if(path==='/api/wall/sync') return Response.json({stubs:[],deleted:[],now:Date.now()});
      return originalFetch(input,init);
    };
  ` });
  await accountPage.goto(base + '/make');
  const warning = `document.body.textContent.includes("this browser couldn't save the updated copy")`;
  check('normal signed-in mount surfaces failed local persistence without sign-in return parameters', await accountPage.waitFor(warning,10000) && await accountPage.eval(`location.search===''`));
  await accountPage.eval(`new Promise(r=>setTimeout(r,5100))`);
  check('local persistence warning stays until recovery', await accountPage.eval(warning));
  await accountPage.eval(`window.__syncFault=false; [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry saving on this device').focus()`);
  await accountPage.key('Enter');
  check('visible retry recovers and clears the warning', await accountPage.waitFor(`!(${warning})`,10000));
  for (const event of ['focus','ticketstub:wall-changed']) {
    await accountPage.eval(`window.__syncFault=true; window.dispatchEvent(new Event(${JSON.stringify(event)}))`);
    check(`signed-in ${event} surfaces failed scheduled persistence`, await accountPage.waitFor(warning,10000));
    await accountPage.eval(`window.__syncFault=false; window.dispatchEvent(new Event('focus'))`);
    check(`signed-in ${event} recovery clears the warning`, await accountPage.waitFor(`!(${warning})`,10000));
  }
  await accountPage.resize(320, 900);
  await accountPage.eval(`window.__syncFault=true; window.dispatchEvent(new Event('focus'))`);
  check('phone background persistence warning remains visible', await accountPage.waitFor(warning,10000));
  check('phone warning and recovery control fit within the viewport', await accountPage.eval(`(() => { const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry saving on this device'); const r=button.getBoundingClientRect(); return document.documentElement.scrollWidth<=innerWidth+1 && r.left>=0 && r.right<=innerWidth+1; })()`));
  await accountPage.close();
  await page.close();
} finally { await browser.close(); }
console.log(`${passed} passed, 0 failed`);
