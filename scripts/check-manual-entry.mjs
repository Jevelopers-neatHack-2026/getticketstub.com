// Offline production-browser regression: synthetic blocked response, real manual-entry API and saved stub.
// The server receives only an explicit demo environment; no provider credentials are inherited.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/cdp.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = process.argv.indexOf('--evidence-dir');
const evidence = arg >= 0 ? resolve(process.argv[arg + 1]) : mkdtempSync(join(tmpdir(), 'ticketstub-manual-browser-'));
mkdirSync(evidence, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'ticketstub-manual-data-'));
const probe = createServer();
await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { NODE_ENV: 'production', TICKETSTUB_RUNTIME_MODE: 'demo', APP_URL: base, TICKETSTUB_DB: join(temp, 'test.sqlite'), TICKETSTUB_FILES: join(temp, 'files'), TICKETSTUB_OPS_TELEMETRY: 'off' });
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
const result = { mode: 'offline-browser-demo-server', scenarios: [], evidence };
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(ready, 'production server starts');
  browser = await launchBrowser();
  for (const width of [390, 1280]) for (const path of ['/make', '/new?url=https%3A%2F%2Fra.co%2Fevents%2F2200000']) {
    const page = await browser.newPage({ width, height: 844, reducedMotion: true });
    const requests = [], failures = [];
    let manualRequests = 0;
    const off = page.conn.on(m => {
      if (m.sessionId !== page.sid) return;
      if (m.method === 'Network.requestWillBeSent') {
        const url = m.params.request.url;
        if (/^https?:/.test(url) && !url.startsWith(`${base}/`)) failures.push('non-loopback request');
      }
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      const body = JSON.parse(request.postData ?? '{}');
      requests.push(body);
      if (body.manual) {
        manualRequests++;
        page.send('Fetch.continueRequest', { requestId }).catch(e => failures.push(e.message));
      } else {
        const response = { error: { code: 'access_restricted', message: 'This site blocks automated reads.' }, fallback: { kind: 'manual_event', provider: 'ra', url: 'https://ra.co/events/2200000', title: '' } };
        page.send('Fetch.fulfillRequest', { requestId, responseCode: 422, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(response)).toString('base64') }).catch(e => failures.push(e.message));
      }
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/research' }] });
    await page.goto(base + path);
    if (path === '/make') {
      assert.ok(await page.waitFor('document.querySelector("input[inputmode=url]")'));
      await page.eval('document.querySelector("input[inputmode=url]").focus()');
      await page.type('https://ra.co/events/2200000');
      await page.key('Enter');
    }
    assert.ok(await page.waitFor('!!document.querySelector("input[name=title]")', 20000), 'fallback is shown');
    assert.match(await page.eval('document.body.innerText'), /Resident Advisor blocks automated page reads/);
    assert.ok(await page.eval('document.activeElement.tagName === "H2"'), 'fallback heading receives focus');
    assert.equal(await page.eval('document.documentElement.scrollWidth > innerWidth'), false, 'no horizontal overflow');
    const link = await page.eval(`document.querySelector('a[href="https://ra.co/events/2200000"]').outerHTML`);
    assert.match(link, /noopener/);
    assert.ok(await page.eval('Array.from(document.querySelectorAll("input[name]")).every(e => !!document.querySelector(`label[for="${e.id}"]`))'), 'every field is labelled');
    // Native browser required-field validation runs before the API.
    await page.eval('document.querySelector("input[name=title]").form.requestSubmit()');
    assert.equal(manualRequests, 0);
    await page.eval('document.querySelector("input[name=title]").focus()');
    await page.type('Offline Night');
    await page.eval('document.querySelector("input[name=dateISO]").value="2026-10-20"');
    await page.eval('document.querySelector("input[name=venue]").focus()');
    await page.type('Offline Hall');
    await page.eval(readFileSync(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8'));
    const a11y = await page.eval('(async()=>{const section=document.querySelector("input[name=title]").closest("section");return (await axe.run(section,{runOnly:{type:"tag",values:["wcag2a","wcag2aa"]}})).violations.map(v=>({id:v.id,impact:v.impact}));})()');
    assert.deepEqual(a11y, [], 'fallback passes scoped WCAG A/AA automation');
    await page.eval('document.querySelector("input[name=title]").closest("section").scrollIntoView({block:"start"})');
    const metrics = await page.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    const capture = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
    const screenshot = join(evidence, `${width}-${path === '/make' ? 'make' : 'new'}.png`);
    writeFileSync(screenshot, Buffer.from(capture.data, 'base64'));
    const submit = await page.eval('(() => { const button=document.querySelector("input[name=title]").form.querySelector("button[type=submit]"); button.scrollIntoView({block:"center"}); const r=button.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return {x,y,uncovered:button.contains(document.elementFromPoint(x,y))}; })()');
    assert.ok(submit.uncovered, 'submit control is not covered by fixed UI');
    await page.click(submit.x, submit.y);
    assert.ok(await page.waitFor('location.pathname.startsWith("/studio/")', 25000), 'manual event reaches studio');
    const stored = await page.eval('JSON.parse(localStorage.getItem("ticketstub.wall.v1")||"[]").find(s=>s.event.title==="Offline Night")');
    assert.ok(stored, 'manual event is persisted');
    assert.equal(stored.event.venue, 'Offline Hall');
    assert.ok(stored.event.facts.filter(f=>f.id!=="weather").every(f=>f.provenance==='customer'));
    assert.equal(manualRequests, 1, 'exactly one manual submit');
    assert.deepEqual(failures, []);
    assert.deepEqual(page.consoleErrors, []);
    result.scenarios.push({ width, path, passed: true, a11y, manualRequests, screenshot });
    off(); await page.close();
  }
  result.passed = true;
} catch (error) {
  result.passed = false; result.error = error.stack; process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  writeFileSync(join(evidence, 'server.log'), log);
  writeFileSync(join(evidence, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
// The browser and owned server are closed above; do not retain HTTP keep-alive timers in a CLI check.
process.exit(process.exitCode ?? 0);
