import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { launchBrowser } from '../scripts/lib/cdp.mjs';

// A real CSS-cascade regression using the same Chrome discovery as the product checks.
test('landing Motion-on overrides OS reduction only inside mounted landing hosts', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ reducedMotion: true });
    const globals = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
    const landing = readFileSync(new URL('../src/customer/landing/landing.css', import.meta.url), 'utf8');
    const probeCSS = '@keyframes test-loop { to { opacity:.5 } } .probe,.probe::before,.probe::after { animation:test-loop 3s linear infinite;transition:transform 2s } .probe::before,.probe::after { content:"probe" }';
    const html = `<style>${globals}\n${landing}\n${probeCSS}</style>
      <div class="lp" data-motion="2d"><div class="lp-host"><div class="probe" id="moving2d"></div><div class="disc"><svg id="spin"></svg></div></div><div class="probe" id="embeddedStudio"></div></div>
      <div class="lp" data-motion="3d"><div class="lp-host"><div class="probe" id="moving3d"></div></div></div>
      <div class="lp still" data-motion="off"><div class="lp-host"><div class="probe" id="off"></div></div><div class="probe" id="embeddedOff"></div></div>
      <div class="lp"><div class="lp-host"><div class="probe" id="beforeMount"></div></div></div>
      <div class="probe" id="otherRoute"></div>`;
    await page.eval(`document.documentElement.innerHTML = ${JSON.stringify(html)}`);
    const styles = await page.eval(`(() => {
      const read = (id, pseudo) => { const s = getComputedStyle(document.getElementById(id), pseudo); return { animation:s.animationName, duration:s.animationDuration, count:s.animationIterationCount, transition:s.transitionDuration }; };
      return Object.fromEntries(['moving2d','moving3d','off','beforeMount','embeddedStudio','otherRoute','spin','embeddedOff'].map(id => [id, [read(id),read(id,'::before'),read(id,'::after')]]));
    })()`);
    for (const id of ['moving2d', 'moving3d']) for (const style of styles[id]) {
      assert.equal(style.duration, '3s', `${id} retains the requested animation duration`);
      assert.equal(style.count, 'infinite');
      assert.equal(style.transition, '2s');
    }
    assert.equal(styles.spin[0].animation, 'lp-spin');
    assert.equal(styles.spin[0].duration, '26s');
    assert.equal(styles.spin[0].count, 'infinite');
    for (const id of ['beforeMount','embeddedStudio','otherRoute']) for (const style of styles[id]) {
      assert.ok(Number.parseFloat(style.duration) < .001, `${id} still follows OS reduction`);
      assert.equal(style.count, '1');
      assert.ok(Number.parseFloat(style.transition) < .001);
    }
    for (const id of ['off','embeddedOff']) for (const style of styles[id]) {
      assert.equal(style.animation, 'none');
      assert.equal(style.transition, '0s');
    }
    await page.close();
  } finally { await browser.close(); }
});
