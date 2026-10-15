// Production landing regression suite. Requires Node 22 and a production build.
// npm run build && node scripts/check-landing.mjs [--base http://127.0.0.1:PORT]
// Optional: --build-root CHECKOUT (production build and source), --source-root CHECKOUT
// (reviewed assets when source is separate), --evidence-dir PATH.
// All browser traffic is confined to loopback. The built-in server inherits no provider credentials.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./lib/cdp.mjs";
import { checkSocialMetadata } from "./lib/landing-metadata-checks.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(option("--build-root", repo));
const sourceRoot = resolve(option("--source-root", buildRoot));
const evidenceDir = resolve(option("--evidence-dir", join(repo, "artifacts", "landing-browser")));
mkdirSync(evidenceDir, { recursive: true });
const result = { suite: "production-landing", buildId: null, buildRoot, sourceRoot, base: null, assertions: [], scenarios: [], screenshots: [], limitations: [], threeChunks: [], startedAt: new Date().toISOString() };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, ok, detail) {
  result.assertions.push({ name, passed: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
  return Boolean(ok);
}
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
// Discover the actual emitted Three modules, independent of hashed chunk filenames.
// Turbopack chunks retain public Three export names and renderer diagnostics even after minification.
function discoverThreeChunks() {
  const chunks = files(join(buildRoot, ".next", "static", "chunks")).filter(f => f.endsWith(".js"));
  return chunks.filter(f => {
    const text = readFileSync(f, "utf8");
    return text.includes("WebGLRenderer") && /THREE|WebGLShader|WebGLProgram|REVISION/.test(text);
  }).map(f => `/_next/${relative(join(buildRoot, ".next"), f).replaceAll("\\", "/")}`);
}
const freePort = () => new Promise((yes, no) => {
  const s = createServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => yes(port)); });
});
let server, browser, dataDir;
let base = option("--base");
const pages = new Set();
try {
  if (!existsSync(join(buildRoot, ".next", "BUILD_ID"))) throw new Error("Missing production build; run npm run build first");
  result.buildId = readFileSync(join(buildRoot, ".next", "BUILD_ID"), "utf8").trim();
  result.threeChunks = discoverThreeChunks();
  check("production Three chunks can be identified from build files", result.threeChunks.length > 0, result.threeChunks);
  if (!base) {
    const port = await freePort(); base = `http://127.0.0.1:${port}`;
    dataDir = mkdtempSync(join(tmpdir(), "ticketstub-landing-"));
    server = spawn(process.execPath, [join(buildRoot, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: buildRoot,
      env: { PATH: process.env.PATH, NODE_ENV: "production", TICKETSTUB_RUNTIME_MODE: "demo", TICKETSTUB_OPS_TELEMETRY: "off", TICKETSTUB_ANALYTICS_DISABLED: "1", TICKETSTUB_DB: join(dataDir, "ticketstub.sqlite") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = ""; server.stdout.on("data", d => log += d); server.stderr.on("data", d => log += d);
    for (let i = 0; i < 150 && !/Ready|started server/i.test(log) && server.exitCode === null; i++) await sleep(200);
    if (!/Ready|started server/i.test(log)) throw new Error(`Production server failed to become ready: ${log.slice(-1500)}`);
  }
  const url = new URL(base);
  if (!/^https?:$/.test(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("--base must be a loopback HTTP URL");
  base = url.origin; result.base = base;
  await checkSocialMetadata(base, check, { buildRoot, sourceRoot });
  browser = await launchBrowser();
  result.limitations.push("The shared CDP launcher passes --disable-gpu. Physical GPU fidelity, performance, and hardware compositor behavior require a separate hardware-browser run. Any positive Three test below uses a simulated detector and identifies the real browser renderer separately.");

  const trackingInit = `(() => {
    window.__landingEvidence = { firstMode: null, ready: null, modes: [], trustedClicks: 0, probes: 0, releasedProbes: 0, actualContexts: 0, draws: 0, lostContexts: 0, fontsLoaded: null };
    const record = () => { const el = document.querySelector('.lp'); if (!el?.dataset.motion) return;
      const e = window.__landingEvidence; e.firstMode ??= performance.now();
      if (el.classList.contains('ready')) e.ready ??= performance.now();
      if (e.modes.at(-1) !== el.dataset.motion) e.modes.push(el.dataset.motion);
    };
    new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-motion'] });
    document.fonts?.addEventListener('loadingdone', () => window.__landingEvidence.fontsLoaded = performance.now());
    document.addEventListener('click', e => { if (e.isTrusted && e.target.closest?.('.motion-toggle')) window.__landingEvidence.trustedClicks++; }, true);
  })();`;
  const hintsInit = hints => `(() => {
    const hints = ${JSON.stringify(hints)};
    if (hints.connection) Object.defineProperty(navigator, 'connection', { configurable: true, value: hints.connection });
    for (const name of ['deviceMemory','hardwareConcurrency']) if (name in hints) Object.defineProperty(navigator, name, { configurable: true, value: hints[name] });
    if (hints.softwareGL || hints.hardwareProbeSimulation) {
      const contexts = new WeakSet();
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, options) {
        if ((type === 'webgl' || type === 'webgl2') && options?.failIfMajorPerformanceCaveat) {
          window.__landingEvidence.probes++;
          return { getExtension(name) { if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 37446 };
            if (name === 'WEBGL_lose_context') return { loseContext() { window.__landingEvidence.releasedProbes++; } }; return null; },
            getParameter() { return hints.hardwareProbeSimulation ? 'Test-only hardware probe success' : 'ANGLE (Google, Vulkan SwiftShader Device (Subzero))'; } };
        }
        const gl = original.call(this, type, options);
        if (gl && (type === 'webgl' || type === 'webgl2') && !contexts.has(gl)) {
          contexts.add(gl); window.__landingEvidence.actualContexts++;
          this.addEventListener('webglcontextlost', () => window.__landingEvidence.lostContexts++);
          for (const method of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) if (gl[method]) {
            const originalDraw = gl[method].bind(gl); gl[method] = (...args) => { window.__landingEvidence.draws++; return originalDraw(...args); };
          }
          if (this.id === 'gl') window.__landingActualGL = gl;
        }
        return gl;
      };
    }
    if (hints.storageDenied) Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage denied for fixture', 'SecurityError'); } });
  })();`;
  const state = page => page.eval(`(() => { const el = document.querySelector('.lp'); const b = el?.querySelector('.motion-toggle'); return { mode: el?.dataset.motion, reason: el?.dataset.lite || '', ready: el?.classList.contains('ready'), pressed: b?.getAttribute('aria-pressed'), focused: document.activeElement === b, loaderHidden: el?.querySelector('#loader')?.hidden, evidence: window.__landingEvidence }; })()`);
  async function open(name, { reducedMotion = false, pref, query = "", hints = {}, width = 1280 } = {}) {
    const page = await browser.newPage({ width, height: 900, reducedMotion }); pages.add(page);
    const entry = { name, requestedChunks: [], errors: [], blockedExternal: [], fontDelays: 0 }; result.scenarios.push(entry); page.entry = entry;
    page.conn.on(m => {
      if (m.sessionId !== page.sid) return;
      if (m.method === "Network.requestWillBeSent") {
        const u = new URL(m.params.request.url); if (u.pathname.endsWith('.js')) entry.requestedChunks.push(u.pathname);
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") entry.errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
      if (m.method === "Fetch.requestPaused") {
        const u = new URL(m.params.request.url);
        if (['localhost','127.0.0.1','[::1]'].includes(u.hostname)) {
          const proceed = () => void page.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
          if (hints.delayFonts && /\.woff2?$/.test(u.pathname)) { entry.fontDelays++; setTimeout(proceed, 2000); } else proceed();
        }
        else { entry.blockedExternal.push(u.origin); void page.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
      }
    });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] });
    // Establish the origin before installing denied-storage fixtures. Preferences persist on later hard reloads.
    await page.goto(`${base}/robots.txt`, { settle: 0 });
    await page.eval(`localStorage.removeItem('ticketstub.motion'); ${pref ? `localStorage.setItem('ticketstub.motion',${JSON.stringify(pref)});` : ''}`);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: trackingInit + hintsInit(hints) });
    await page.goto(`${base}/${query}`, { settle: 20 });
    check(`${name}: landing initializes`, await page.waitFor(`!!document.querySelector('.lp')?.dataset.motion`, 10000));
    check(`${name}: landing becomes ready`, await page.waitFor(`document.querySelector('.lp')?.classList.contains('ready')`, 12000));
    entry.initial = await state(page);
    return page;
  }
  async function close(page, { allowThree = false } = {}) {
    page.entry.final = await state(page);
    check(`${page.entry.name}: no browser JavaScript/hydration errors`, page.consoleErrors.length === 0 && page.entry.errors.length === 0, [...page.consoleErrors, ...page.entry.errors]);
    if (!allowThree) check(`${page.entry.name}: no Three chunk request while 3D disabled`, !page.entry.requestedChunks.some(c => result.threeChunks.includes(c)), page.entry.requestedChunks.filter(c => result.threeChunks.includes(c)));
    await page.close(); pages.delete(page);
  }
  async function snapshot(page, name) { const file = join(evidenceDir, `${name}.png`); await page.screenshot(file); result.screenshots.push(file); }
  async function center(page, selector) {
    if(!await page.eval(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.scrollIntoView({block:'center',behavior:'instant'});return true;})()`)) return null;
    // Fixed scene controls reconcile on a frame after scrolling; click only once the real target is uncovered.
    const actionable=await page.waitFor(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0 && r.height>0 && !!hit && el.contains(hit);})()`,2000);
    check(`${page.entry.name}: pointer target ${selector} is visible and uncovered`,actionable);
    if(!actionable) throw new Error(`Pointer target is covered or invisible: ${selector}`);
    return page.eval(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  }
  async function pointer(page, selector = '.motion-toggle') {
    await page.waitFor(`!document.querySelector('#loader') || document.querySelector('#loader').hidden`, 5000);
    const p = await center(page, selector); if (!p) throw new Error(`No target ${selector}`); await page.click(p.x, p.y);
  }
  async function activate(page, method) {
    await page.waitFor(`!document.querySelector('#loader') || document.querySelector('#loader').hidden`, 5000);
    if (method === 'pointer') await pointer(page);
    else if (method === 'touch') {
      const p = await center(page, '.motion-toggle');
      await page.send('Emulation.setTouchEmulationEnabled', { enabled:true });
      await page.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{ ...p, id:1 }] });
      await page.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    } else {
      await page.eval(`document.querySelector('.lp .logo').focus()`);
      let found = false;
      for (let i = 0; i < 25 && !found; i++) { await page.key('Tab'); found = await page.eval(`document.activeElement?.matches('.motion-toggle')`); }
      check(`${page.entry.name}: Tab reaches toggle`, found);
      if (found) await page.key(method);
    }
    await sleep(150);
  }
  async function expected(page, mode, label) {
    const ok = await page.waitFor(`document.querySelector('.lp')?.dataset.motion === ${JSON.stringify(mode)}`, 2000);
    const s = await state(page); check(`${label}: mode ${mode}`, ok, s);
    check(`${label}: aria-pressed matches reduced motion`, s.pressed === String(mode === 'off'), s);
    return s;
  }
  async function accessible(page, selector) {
    const { root } = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { node } = await page.send('DOM.describeNode', { nodeId });
    const { nodes } = await page.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId });
    return nodes.find(n => n.backendDOMNodeId === node.backendNodeId);
  }

  async function tabToGeneratedCard(page, selector, label, seed = '.lp .logo') {
    await page.eval(`document.querySelector(${JSON.stringify(seed)}).focus({preventScroll:true})`);
    let reached=false;
    for(let i=0;i<120 && !reached;i++) {await page.key('Tab');reached=await page.eval(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`);}
    check(`${label}: trusted Tab reaches generated card`,reached);
  }
  const generatedCardState = (page,selector) => page.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});return {focused:document.activeElement===e,name:e?.getAttribute('aria-label'),flipped:e?.classList.contains('flipped')};})()`);
  async function flipGeneratedCard(page, selector, label) {
    const before=await generatedCardState(page,selector);await page.key(' ');const after=await generatedCardState(page,selector);
    check(`${label}: trusted Space still flips the focused card`,after.focused && before.flipped!==after.flipped,{before,after});
  }

  const os = await open('system-reduced', { reducedMotion:true });
  await expected(os, 'off', 'system reduced default');
  check('system reduced: ready without loader', os.entry.initial.loaderHidden && os.entry.initial.evidence.ready - os.entry.initial.evidence.firstMode < 1000, os.entry.initial);
  await snapshot(os, 'desktop-motion-off'); await close(os);

  for (const pref of ['on','off']) {
    const page = await open(`persistent-${pref}`, { pref, reducedMotion:pref === 'on', hints:{ softwareGL:true } });
    const mode = pref === 'off' ? 'off' : '2d'; await expected(page, mode, `persisted ${pref}`);
    if (pref === 'on') {
      const css = await page.eval(`(() => {const s=getComputedStyle(document.querySelector('.disc svg'));return {name:s.animationName,duration:s.animationDuration,iterations:s.animationIterationCount};})()`);
      check('explicit motion on overrides OS reduction for CSS animation', css.name === 'lp-spin' && css.duration === '26s' && css.iterations === 'infinite', css);
      const firstRing = await page.eval(`getComputedStyle(document.querySelector('.disc svg')).transform`); await sleep(180);
      const secondRing = await page.eval(`getComputedStyle(document.querySelector('.disc svg')).transform`);
      check('explicit motion on under OS reduction actually rotates ring', firstRing !== secondRing, {before:firstRing,after:secondRing});
      const embeddedReduction = await page.eval(`(() => {const fixture=document.createElement('span');fixture.style.cssText='position:fixed;left:-10000px;animation:lp-spin 26s linear infinite';document.querySelector('#start').appendChild(fixture);const s=getComputedStyle(fixture);const answer={duration:s.animationDuration,iterations:s.animationIterationCount};fixture.remove();return answer;})()`);
      check('OS reduction still governs embedded application content', parseFloat(embeddedReduction.duration) <= .00001 && embeddedReduction.iterations === '1', embeddedReduction);
    }
    await page.send('Page.reload'); await page.waitFor(`!!document.querySelector('.lp')?.dataset.motion`); await expected(page, mode, `persisted ${pref} after hard reload`); await close(page);
  }
  for (const query of ['on','off']) {
    const page = await open(`query-${query}`, { query:`?motion=${query}`, pref:query === 'on' ? 'off':'on', hints:{ softwareGL:true } });
    await expected(page, query === 'on' ? '2d':'off', `query ${query} takes initial precedence`);
    for (const [i, method] of ['pointer','touch','Enter',' '].entries()) {
      await activate(page, method);
      const mode = (query === 'on') === (i % 2 === 0) ? 'off':'2d';
      const s = await expected(page, mode, `query ${query}: ${JSON.stringify(method)} activation ${i+1}`);
      check(`query ${query}: focus restored after ${JSON.stringify(method)} remount`, s.focused, s);
      check(`query ${query}: exactly one toggle after remount ${i+1}`, await page.eval(`document.querySelectorAll('.motion-toggle').length === 1`));
    }
    check(`query ${query}: actual trusted activation events`, (await state(page)).evidence.trustedClicks === 4, (await state(page)).evidence);
    await close(page);
  }
  const denied = await open('storage-denied', { query:'?motion=off', hints:{ storageDenied:true, softwareGL:true } });
  await expected(denied, 'off', 'denied storage still honors query');
  await activate(denied, 'pointer'); await expected(denied, '2d', 'denied storage session enables motion');
  await activate(denied, 'Enter'); await expected(denied, 'off', 'denied storage session disables motion'); await close(denied);

  const auto = await open('system-setting-update', { hints:{ softwareGL:true } });
  await expected(auto, '2d', 'automatic mode without OS reduction');
  await auto.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'reduce' }] });
  await expected(auto, 'off', 'system reduction changes during visit');
  await auto.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'no-preference' }] });
  await expected(auto, '2d', 'system reduction resets during visit'); await close(auto);

  for (const [name, hints, reason] of [
    ['save-data',{ connection:{ saveData:true, effectiveType:'4g' } },'save-data'],
    ['2g',{ connection:{ saveData:false, effectiveType:'2g' } },'slow connection'],
    ['slow-2g',{ connection:{ saveData:false, effectiveType:'slow-2g' } },'slow connection'],
    ['low-memory',{ deviceMemory:2 },'low-end device'],
    ['low-cores',{ hardwareConcurrency:2 },'low-end device'],
    ['software-webgl',{ softwareGL:true },'no hardware-accelerated WebGL'],
  ]) {
    const page = await open(name, { pref:'on', hints }); const s = await expected(page, '2d', name);
    check(`${name}: explains static fallback`, s.reason === reason, s);
    check(`${name}: ready immediately after initialization rather than 3.5s wait`, s.evidence.ready - s.evidence.firstMode < 1000, s.evidence);
    if (hints.softwareGL) check(`${name}: temporary probe context is released`, s.evidence.probes > 0 && s.evidence.probes === s.evidence.releasedProbes, s.evidence);
    await close(page);
  }

  const fonts = await open('delayed-font-static-fallback', { pref:'on', hints:{ connection:{saveData:true,effectiveType:'4g'}, delayFonts:true } });
  const fontState = await state(fonts);
  check('delayed fonts: fixture actually holds font requests', fonts.entry.fontDelays > 0, fonts.entry.fontDelays);
  check('delayed fonts: fallback is ready before fonts finish loading', fontState.evidence.fontsLoaded !== null && fontState.evidence.ready < fontState.evidence.fontsLoaded, fontState.evidence);
  await close(fonts);

  const capability = await browser.newPage({width:1280,height:900}); pages.add(capability);
  const actualGL = await capability.eval(`(() => {const c=document.createElement('canvas');const gl=c.getContext('webgl2') || c.getContext('webgl');if(!gl)return {available:false};const ext=gl.getExtension('WEBGL_debug_renderer_info');const renderer=ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unreported';gl.getExtension('WEBGL_lose_context')?.loseContext();return {available:true,renderer};})()`);
  await capability.close(); pages.delete(capability);
  if (actualGL.available) {
    result.limitations.push('Positive 3D exercise simulates only the hardware detector probe. The real Three.js renderer executes using the browser WebGL implementation: ' + actualGL.renderer + '. This does not establish physical GPU support.');
    const three = await open('simulated-detector-real-three-software-webgl', {hints:{hardwareProbeSimulation:true,deviceMemory:8,hardwareConcurrency:8,connection:{saveData:false,effectiveType:'4g'}}});
    check('positive 3D: hardware probe simulation selects 3D', (await state(three)).mode === '3d', await state(three));
    check('positive 3D: actual emitted Three chunk requested', three.entry.requestedChunks.some(c=>result.threeChunks.includes(c)), three.entry.requestedChunks);
    check('positive 3D: real WebGL renderer makes draw calls', await three.waitFor(`window.__landingEvidence.draws > 0 && !document.querySelector('.lp').classList.contains('no3d')`,20000), await state(three));
    check('positive 3D: loader dismisses before visual evidence', await three.waitFor(`document.querySelector('#loader')?.hidden`,5000), await state(three));
    check('positive 3D: hero text intro settles', await three.waitFor(`(() => {const chars=[...document.querySelectorAll('.hero h1 .ch')];return chars.length>0 && chars.every(e=>e.getAnimations().every(a=>a.playState!=='running'));})()`,5000));
    await sleep(800); // Allow the ticket's spring to settle after the text intro, while real draw calls continue.
    await snapshot(three,'simulated-detector-real-three');
    await pointer(three,'.cta-foot[href="#make"]');
    check('positive 3D: maker CTA establishes raw input focus',await three.waitFor(`document.activeElement?.id==='ev' && !document.querySelector('#finale').inert`,5000));
    await three.type('Actual Three focus fixture night');
    await three.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await expected(three,'off','positive 3D: automatic OS reduction');
    const reducedFocus=await three.eval(`(() => {const e=document.querySelector('#ev');return {value:e.value,focused:document.activeElement===e};})()`);
    check('positive 3D: automatic reduction retains editable raw draft',reducedFocus.focused && reducedFocus.value==='Actual Three focus fixture night',reducedFocus);
    const beforeRestart=await three.eval('window.__landingEvidence.draws');
    await three.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await expected(three,'3d','positive 3D: automatic OS permission returns');
    check('positive 3D: real renderer restarts after asynchronous initialization',await three.waitFor(`window.__landingEvidence.actualContexts>=2 && window.__landingEvidence.draws>${beforeRestart} && document.querySelector('.lp').classList.contains('ready') && document.querySelector('#loader')?.hidden && !document.querySelector('.lp').classList.contains('no3d')`,20000),await state(three));
    const initializedFocus=await three.eval(`(() => {const e=document.querySelector('#ev');return {value:e.value,focused:document.activeElement===e};})()`);
    check('positive 3D: completed async initialization retains raw input focus',initializedFocus.focused && initializedFocus.value==='Actual Three focus fixture night',initializedFocus);
    await three.type(' continued');
    const continuedFocus=await three.eval(`(() => {const e=document.querySelector('#ev');return {value:e.value,start:e.selectionStart,end:e.selectionEnd,focused:document.activeElement===e};})()`);
    check('positive 3D: trusted typing continues after actual renderer restart',continuedFocus.focused && continuedFocus.value==='Actual Three focus fixture night continued' && continuedFocus.start===continuedFocus.value.length && continuedFocus.end===continuedFocus.value.length,continuedFocus);
    const ribbonSelector='#ribbon .ts-stub:not([aria-hidden="true"])';
    await tabToGeneratedCard(three,ribbonSelector,'positive 3D: generated ribbon');
    const ribbonName=(await generatedCardState(three,ribbonSelector)).name;
    await flipGeneratedCard(three,ribbonSelector,'positive 3D: original ribbon');
    await three.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await expected(three,'off','positive 3D: ribbon OS reduction');
    const ribbonReduced=await generatedCardState(three,ribbonSelector);
    check('positive 3D: automatic reduction restores generated ribbon focus',ribbonReduced.focused && ribbonReduced.name===ribbonName,ribbonReduced);
    await flipGeneratedCard(three,ribbonSelector,'positive 3D: reduced ribbon');
    const beforeRibbonRestart=await three.eval('({contexts:window.__landingEvidence.actualContexts,draws:window.__landingEvidence.draws})');
    await three.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await expected(three,'3d','positive 3D: ribbon OS permission returns');
    check('positive 3D: regenerated ribbon waits for real renderer handoff',await three.waitFor(`window.__landingEvidence.actualContexts>${beforeRibbonRestart.contexts} && window.__landingEvidence.draws>${beforeRibbonRestart.draws} && document.querySelector('.lp').classList.contains('ready') && document.querySelector('#loader')?.hidden && !document.querySelector('.lp').classList.contains('no3d')`,20000),await state(three));
    const ribbonResumed=await generatedCardState(three,ribbonSelector);
    check('positive 3D: async art generation restores logical ribbon focus',ribbonResumed.focused && ribbonResumed.name===ribbonName,ribbonResumed);
    await flipGeneratedCard(three,ribbonSelector,'positive 3D: regenerated ribbon');
    await activate(three,'Enter'); await expected(three,'off','positive 3D: disable via real toggle');
    check('positive 3D: renderer context released after remount', await three.waitFor(`window.__landingActualGL?.isContextLost()`,5000), await state(three));
    const drawCount = await three.eval('window.__landingEvidence.draws'); await sleep(400);
    check('positive 3D: disposed renderer stops drawing', await three.eval('window.__landingEvidence.draws') === drawCount, await state(three));
    await close(three,{allowThree:true});
  } else result.limitations.push('The available browser cannot create a real WebGL context even without a performance caveat. Real Three rendering under a simulated positive detector remains unexercised.');

  const embedded = await open('embedded-studio-motion', {pref:'on',hints:{softwareGL:true}});
  async function observeSample(page, selector) {
    check(`${page.entry.name}: showcase exists`, await page.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`,5000));
    await page.eval(`(() => {const f=document.querySelector(${JSON.stringify(selector)});f.scrollIntoView({block:'center',behavior:'instant'});window.__sampleMotionEvents=0;f.addEventListener('pointermove',e=>{if(!e.isTrusted)window.__sampleMotionEvents++});})()`);
    await sleep(250);
  }
  const sample = (page,selector) => page.eval(`(() => {const f=document.querySelector(${JSON.stringify(selector)}),t=f.querySelector(':scope > div'),s=getComputedStyle(t);return {transform:s.transform,events:window.__sampleMotionEvents,style:t.getAttribute('style')};})()`);
  await embedded.eval(`(() => {window.__embeddedVibrations=[];window.__embeddedScrolls=[];Object.defineProperty(navigator,'vibrate',{configurable:true,value:p=>{window.__embeddedVibrations.push(p);return true}});const scroll=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(options){if(this.closest('#start'))window.__embeddedScrolls.push(options);return scroll.call(this,options)};})()`);
  await observeSample(embedded,'#start figure');
  const onBefore = await sample(embedded,'#start figure'); await sleep(600); const onAfter = await sample(embedded,'#start figure');
  check('embedded studio: on mode actually sways visible sample', onAfter.events-onBefore.events>2 && onBefore.transform!==onAfter.transform,{before:onBefore,after:onAfter});
  const makeButton = async page => page.eval(`(() => {const b=[...document.querySelectorAll('#start button')].find(b=>b.textContent.trim()==='Make my stub');b.dataset.motionTestMake='';})()`);
  await makeButton(embedded); await pointer(embedded,'[data-motion-test-make]');
  check('embedded studio: motion on permits press haptic', await embedded.eval('window.__embeddedVibrations.length>0'));
  await embedded.eval(`document.querySelector('#start input').focus()`); await embedded.type('Browser fixture night');
  await activate(embedded,'Enter'); await expected(embedded,'off','embedded studio: local toggle disables motion');
  check('embedded studio: input survives disabling motion', await embedded.eval(`document.querySelector('#start input').value === 'Browser fixture night'`));
  await embedded.eval(`document.querySelector('#start figure').scrollIntoView({block:'center',behavior:'instant'})`); await sleep(250);
  await embedded.eval('window.__sampleMotionEvents=0');
  const offBefore = await sample(embedded,'#start figure'); await sleep(600); const offAfter = await sample(embedded,'#start figure');
  check('embedded studio: local off stops synthetic sway', offAfter.events===0,offAfter);
  check('embedded studio: local off keeps real sample transform still', offBefore.transform===offAfter.transform && offBefore.style===offAfter.style,{before:offBefore,after:offAfter});
  const embeddedCSS = await embedded.eval(`(() => {const root=document.querySelector('#start'),elements=[root,...root.querySelectorAll('*')];return {count:elements.length,transitions:elements.flatMap(e=>getComputedStyle(e).transitionDuration.split(',').map(v=>parseFloat(v))),running:root.getAnimations({subtree:true}).filter(a=>a.playState==='running' && Number(a.effect.getComputedTiming().activeDuration)>0).map(a=>a.animationName)};})()`);
  check('embedded studio: local off suppresses component transitions and CSS animations', embeddedCSS.count>10 && embeddedCSS.transitions.every(d=>d<=.00001) && embeddedCSS.running.length===0,embeddedCSS);
  await activate(embedded,'Enter'); await expected(embedded,'2d','embedded studio: local toggle resumes motion');
  check('embedded studio: input survives enabling motion', await embedded.eval(`document.querySelector('#start input').value === 'Browser fixture night'`));
  await embedded.eval(`document.querySelector('#start figure').scrollIntoView({block:'center',behavior:'instant'})`); await sleep(250);
  const resumedBefore = await sample(embedded,'#start figure'); await sleep(600); const resumedAfter = await sample(embedded,'#start figure');
  check('embedded studio: enabling motion restores real sway', resumedAfter.events-resumedBefore.events>2 && resumedBefore.transform!==resumedAfter.transform,{before:resumedBefore,after:resumedAfter});
  await activate(embedded,'Enter'); await expected(embedded,'off','embedded studio: disable before intake');
  await embedded.eval(`document.querySelector('#start input').select();window.__embeddedVibrations=[]`);
  await embedded.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await embedded.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await makeButton(embedded); await pointer(embedded,'[data-motion-test-make]');
  check('embedded studio: local off suppresses press haptic', await embedded.eval('window.__embeddedVibrations.length===0'));
  await embedded.eval(`(() => {window.__embeddedScrolls=[];const b=[...document.querySelectorAll('#start button')].find(b=>b.textContent.trim()==='The Pale Hours');b.dataset.motionTestDemo='';})()`);
  await pointer(embedded,'[data-motion-test-demo]');
  const intakeScrolls = await embedded.eval('window.__embeddedScrolls');
  check('embedded studio: local off intake scroll is automatic', intakeScrolls.some(s=>s?.behavior==='auto') && !intakeScrolls.some(s=>s?.behavior==='smooth'),intakeScrolls);
  check('embedded studio: local off fixture prints and opens studio', await embedded.waitFor(`location.pathname==='/studio/demo-pale'`,30000));
  check('embedded studio: local off suppresses printing haptics', await embedded.eval('window.__embeddedVibrations.length===0'),await embedded.eval('window.__embeddedVibrations'));
  await embedded.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await embedded.goto(`${base}/make`,{settle:100}); await observeSample(embedded,'figure[data-size="lg"]');
  await embedded.eval('window.__sampleMotionEvents=0');
  const standaloneBefore = await sample(embedded,'figure[data-size="lg"]'); await sleep(600); const standaloneAfter = await sample(embedded,'figure[data-size="lg"]');
  check('standalone make: OS reduction stops sample sway', standaloneAfter.events===0 && standaloneBefore.transform===standaloneAfter.transform,{before:standaloneBefore,after:standaloneAfter});
  await embedded.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]}); await sleep(250);
  const standaloneResumeBefore = await sample(embedded,'figure[data-size="lg"]'); await sleep(600); const standaloneResumeAfter = await sample(embedded,'figure[data-size="lg"]');
  check('standalone make: OS motion permission resumes sample sway', standaloneResumeAfter.events-standaloneResumeBefore.events>2 && standaloneResumeBefore.transform!==standaloneResumeAfter.transform,{before:standaloneResumeBefore,after:standaloneResumeAfter});
  await close(embedded);

  const rawDraft = await open('raw-maker-draft', {pref:'on',hints:{softwareGL:true}});
  await pointer(rawDraft,'.cta-foot[href="#make"]');
  check('raw maker: existing CTA exposes and focuses intake', await rawDraft.waitFor(`document.activeElement?.id==='ev' && !document.querySelector('#finale').inert`,5000));
  await rawDraft.type('Raw maker fixture night, fixture venue');
  for (let i=0;i<3;i++) await rawDraft.key('ArrowLeft',{shift:true});
  const draftBefore = await rawDraft.eval(`(() => {const e=document.querySelector('#ev');return {value:e.value,start:e.selectionStart,end:e.selectionEnd,direction:e.selectionDirection};})()`);
  check('raw maker: trusted typing and selection establish draft', draftBefore.value==='Raw maker fixture night, fixture venue' && draftBefore.end-draftBefore.start===3,draftBefore);
  for (const mode of ['off','2d']) {
    await activate(rawDraft,'Enter'); const s = await expected(rawDraft,mode,`raw maker: toggle to ${mode}`);
    const draftAfter = await rawDraft.eval(`(() => {const e=document.querySelector('#ev');return {value:e.value,start:e.selectionStart,end:e.selectionEnd,direction:e.selectionDirection};})()`);
    check(`raw maker: ${mode} remount retains draft and selection`, JSON.stringify(draftBefore)===JSON.stringify(draftAfter),{before:draftBefore,after:draftAfter});
    const preview = await rawDraft.eval(`({title:document.querySelector('#finCard .tc-a')?.textContent,typing:document.querySelector('#finale').classList.contains('typing')})`);
    check(`raw maker: ${mode} remount retains draft preview`, preview.typing && preview.title?.includes('Raw maker fixture night'),preview);
    check(`raw maker: ${mode} remount restores toggle focus`,s.focused,s);
  }
  await close(rawDraft);

  const automaticFocus = await open('automatic-motion-input-focus', {hints:{softwareGL:true}});
  await pointer(automaticFocus,'.cta-foot[href="#make"]');
  check('automatic motion: maker CTA establishes editable focus',await automaticFocus.waitFor(`document.activeElement?.id==='ev' && !document.querySelector('#finale').inert`,5000));
  await automaticFocus.type('Automatic maker fixture night, fixture venue');
  for(let i=0;i<3;i++) await automaticFocus.key('ArrowLeft',{shift:true});
  const inputState = (page,selector) => page.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});return {value:e.value,start:e.selectionStart,end:e.selectionEnd,direction:e.selectionDirection,focused:document.activeElement===e};})()`);
  const rawAutoBefore=await inputState(automaticFocus,'#ev');
  check('automatic motion: trusted draft has active backward selection',rawAutoBefore.focused && rawAutoBefore.end-rawAutoBefore.start===3 && rawAutoBefore.direction==='backward',rawAutoBefore);
  await automaticFocus.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await expected(automaticFocus,'off','automatic motion: OS reduction');
  const rawAutoReduced=await inputState(automaticFocus,'#ev');
  check('automatic motion: OS reduction retains raw draft, selection and focus',JSON.stringify(rawAutoBefore)===JSON.stringify(rawAutoReduced),{before:rawAutoBefore,after:rawAutoReduced});
  check('automatic motion: OS reduction retains raw preview',await automaticFocus.eval(`document.querySelector('#finale').classList.contains('typing') && document.querySelector('#finCard .tc-a')?.textContent.includes('Automatic maker fixture night')`));
  await automaticFocus.key('ArrowRight'); await automaticFocus.type(' / continued');
  const continued=await inputState(automaticFocus,'#ev'),continuedValue=rawAutoBefore.value+' / continued';
  check('automatic motion: trusted typing continues after OS reduction',continued.focused && continued.value===continuedValue && continued.start===continuedValue.length && continued.end===continuedValue.length,continued);
  await automaticFocus.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await expected(automaticFocus,'2d','automatic motion: OS permission returns');
  const rawAutoResumed=await inputState(automaticFocus,'#ev');
  check('automatic motion: OS reset retains continued raw draft, selection and focus',rawAutoResumed.focused && rawAutoResumed.value===continuedValue && rawAutoResumed.start===continuedValue.length && rawAutoResumed.end===continuedValue.length,rawAutoResumed);
  const continuedPreview=await automaticFocus.eval(`({typing:document.querySelector('#finale').classList.contains('typing'),title:document.querySelector('#finCard .tc-a')?.textContent,meta:document.querySelector('#finCard .tc-meta')?.textContent})`);
  check('automatic motion: OS reset retains continued raw preview',continuedPreview.typing && continuedPreview.title?.includes('Automatic maker fixture night') && continuedPreview.meta?.includes('fixture venue / continued'),continuedPreview);
  await automaticFocus.eval(`document.querySelector('#start input').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('#start input').focus()`);
  await automaticFocus.type('Embedded automatic fixture draft');
  for(let i=0;i<2;i++) await automaticFocus.key('ArrowLeft',{shift:true});
  const embeddedAutoBefore=await inputState(automaticFocus,'#start input');
  check('automatic motion: trusted embedded draft establishes focus and selection',embeddedAutoBefore.focused && embeddedAutoBefore.end-embeddedAutoBefore.start===2,embeddedAutoBefore);
  for(const [os,mode] of [['reduce','off'],['no-preference','2d']]) {
    await automaticFocus.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:os}]});
    await expected(automaticFocus,mode,`automatic motion: embedded input OS ${os}`);
    const after=await inputState(automaticFocus,'#start input');
    check(`automatic motion: OS ${os} keeps embedded focus and draft`,JSON.stringify(embeddedAutoBefore)===JSON.stringify(after),{before:embeddedAutoBefore,after});
  }
  for(const [label,selector] of [['navigation anchor','.lp .nav a[href="#studio"]'],['hero CTA','.hero a[href="#start"]']]) {
    await automaticFocus.eval(`document.querySelector('.lp .logo').focus({preventScroll:true})`);
    let reached=false;
    for(let i=0;i<25 && !reached;i++) {await automaticFocus.key('Tab');reached=await automaticFocus.eval(`document.activeElement?.matches(${JSON.stringify(selector)})`);}
    check(`automatic motion: Tab reaches ${label}`,reached);
    for(const [os,mode] of [['reduce','off'],['no-preference','2d']]) {
      await automaticFocus.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:os}]});
      await expected(automaticFocus,mode,`automatic motion: ${label} OS ${os}`);
      check(`automatic motion: OS ${os} retains ${label} focus`,await automaticFocus.eval(`document.activeElement?.matches(${JSON.stringify(selector)})`));
    }
  }
  await close(automaticFocus);

  const generatedFocus = await open('automatic-generated-card-focus', {hints:{softwareGL:true}});
  for(const [label,selector,seed] of [['studio cork','#tsCork .ts-stub','.lp .logo'],['board preview','#finCard .ts-stub','#ev'],['gallery ribbon','#ribbon .ts-stub:not([aria-hidden="true"])','.lp .logo']]) {
    check(`generated ${label}: script creates focusable ticket card`,await generatedFocus.eval(`document.querySelector(${JSON.stringify(selector)})?.matches('figure[role="button"][tabindex="0"]')`));
    const originalName=(await generatedCardState(generatedFocus,selector)).name;
    for(const [os,mode] of [['reduce','off'],['no-preference','2d']]) {
      if(seed==='#ev') {await pointer(generatedFocus,'.cta-foot[href="#make"]');check(`generated board preview before OS ${os}: maker CTA exposes board`,await generatedFocus.waitFor(`document.activeElement?.id==='ev' && !document.querySelector('#finale').inert`,5000));}
      await tabToGeneratedCard(generatedFocus,selector,`generated ${label} before OS ${os}`,seed);
      await flipGeneratedCard(generatedFocus,selector,`generated ${label} before OS ${os}`);
      await generatedFocus.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:os}]});
      await expected(generatedFocus,mode,`generated ${label}: OS ${os}`);
      const restored=await generatedCardState(generatedFocus,selector);
      check(`generated ${label}: OS ${os} retains logical card focus`,restored.focused && restored.name===originalName,restored);
      await flipGeneratedCard(generatedFocus,selector,`generated ${label} after OS ${os}`);
    }
  }
  await close(generatedFocus);

  const leavingDemo = await open('printing-settle-navigation', {pref:'on',hints:{softwareGL:true}});
  await leavingDemo.goto(`${base}/search`,{settle:100});
  await pointer(leavingDemo,'a[aria-label="TicketStub home"]');
  check('printing cleanup: real home navigation mounts landing', await leavingDemo.waitFor(`location.pathname==='/' && document.querySelector('.lp')?.classList.contains('ready')`,5000));
  await leavingDemo.eval(`(() => {const b=[...document.querySelectorAll('#start button')].find(b=>b.textContent.trim()==='Harbour FC');b.dataset.motionTestSettle='';window.__lateWallWrites=0;window.addEventListener('ticketstub:wall-changed',()=>window.__lateWallWrites++);})()`);
  await pointer(leavingDemo,'[data-motion-test-settle]');
  check('printing cleanup: local fixture reaches visible ink-settle phase', await leavingDemo.waitFor(`document.querySelector('[aria-label="Printing your stub"]')?.textContent.includes('Letting the ink settle')`,30000));
  const beforeLeaving = await leavingDemo.eval(`({wall:localStorage.getItem('ticketstub.wall.v1'),writes:window.__lateWallWrites})`);
  await leavingDemo.eval('history.back()');
  check('printing cleanup: back returns to the preceding search route',await leavingDemo.waitFor(`location.pathname==='/search' && !document.querySelector('[aria-label="Printing your stub"]')`,5000));
  // Observe beyond the visible settle callback and subsequent studio-navigation window, after a real unmount.
  await sleep(1800);
  const afterLeaving = await leavingDemo.eval(`({path:location.pathname,wall:localStorage.getItem('ticketstub.wall.v1'),writes:window.__lateWallWrites})`);
  check('printing cleanup: no late studio navigation after leaving settle phase',afterLeaving.path==='/search',afterLeaving.path);
  check('printing cleanup: abandoned fixture never writes a finished stub',beforeLeaving.wall===afterLeaving.wall && beforeLeaving.writes===afterLeaving.writes,{before:beforeLeaving,after:afterLeaving});
  await close(leavingDemo);

  const layout = await open('responsive-accessibility-and-lifecycle', { pref:'off' });
  for (const width of [320,375,390,520,768,1100,1101,1280]) {
    await layout.resize(width, 900); await layout.eval('scrollTo(0,0)'); await sleep(150);
    const geometry = await layout.eval(`(() => {
      const nav = document.querySelector('.lp .nav'); const controls = [...nav.querySelectorAll('a,button')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      const boxes = controls.map(e => { const r=e.getBoundingClientRect();return { label:e.getAttribute('aria-label') || e.textContent.trim(),x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; });
      const collisions = boxes.flatMap((a,i) => boxes.slice(i+1).filter(b => Math.min(a.right,b.right)-Math.max(a.x,b.x)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1).map(b=>[a.label,b.label]));
      return { width:innerWidth, scrollWidth:document.documentElement.scrollWidth,boxes,collisions, wrappedLinks:[...nav.querySelectorAll('ul a')].filter(e=>e.getClientRects().length>1).map(e=>e.textContent.trim()) }; })()`);
    check(`width ${width}: no horizontal page overflow`, geometry.scrollWidth <= width+1, geometry);
    check(`width ${width}: navigation targets do not collide or leave viewport`, geometry.collisions.length === 0 && geometry.boxes.every(b=>b.x>=-1 && b.right<=width+1), geometry);
    const button = geometry.boxes.find(b => /reduce motion/i.test(b.label));
    const logo = await layout.eval(`(() => {const r=document.querySelector('.lp .logo').getBoundingClientRect();return {width:r.width,height:r.height}})()`);
    check(`width ${width}: visible navigation labels stay on one line`, geometry.wrappedLinks.length === 0, geometry.wrappedLinks);
    check(`width ${width}: motion toggle has 44px target`, button?.width >= 44 && button?.height >= 44, button);
    check(`width ${width}: logo has 44px target`, logo.width >= 44 && logo.height >= 44, logo);
    const toggleAX = await accessible(layout,'.motion-toggle'), logoAX = await accessible(layout,'.lp .logo');
    check(`width ${width}: accessible toggle name and pressed state`, /reduce motion/i.test(toggleAX?.name?.value || '') && toggleAX?.properties?.some(p=>p.name==='pressed' && p.value.value==='true'), toggleAX);
    check(`width ${width}: accessible logo name remains present`, /getticketstub|ticketstub/i.test(logoAX?.name?.value || ''), logoAX);
    if ([320,390,768,1101,1280].includes(width)) await snapshot(layout, `nav-${width}`);
  }
  const moving = await open('motion-css', { pref:'on', hints:{ softwareGL:true } });
  const animationNames = await moving.eval(`['.disc svg','.marquee .track','.search .caret','.cta-end'].map(s=>({selector:s,name:getComputedStyle(document.querySelector('.lp '+s)).animationName,duration:getComputedStyle(document.querySelector('.lp '+s)).animationDuration,iterations:getComputedStyle(document.querySelector('.lp '+s)).animationIterationCount}))`);
  for (const [selector, name, duration] of [['.disc svg','lp-spin',26],['.marquee .track','lp-mq',34],['.search .caret','lp-blink',1],['.cta-end','lp-ctaFlap',5.6]]) {
    check(`motion on: ${selector} keyframes survive production CSS`, animationNames.some(a=>a.selector===selector && a.name===name && parseFloat(a.duration)===duration && a.iterations==='infinite'), animationNames);
  }
  // Exercise the production CSS for short-lived printing state classes without starting a research request.
  const stateAnimations = await moving.eval(`(() => {
    const host=document.querySelector('.lp-host'),fixture=document.createElement('div');
    fixture.style.cssText='position:fixed;left:-10000px;top:0';
    fixture.innerHTML='<div class="maker"><button class="gleam" type="button">CSS proof</button></div><div class="fin-card"><div class="ts-stub inked printing"><div class="ts-face"></div><i class="ts-sweep"></i></div></div>';
    host.appendChild(fixture);
    const values=[['lp-ctaIn',document.querySelector('.lp .cta-in')],['lp-gleam',fixture.querySelector('button'),'::after'],['lp-ink',fixture.querySelector('.ts-face')],['lp-sweep',fixture.querySelector('.ts-sweep')]].map(([key,e,pseudo])=>{
      const css=getComputedStyle(e,pseudo);return {key,name:css.animationName,duration:css.animationDuration,iterations:css.animationIterationCount};
    });
    const active=fixture.getAnimations({subtree:true}).map(a=>a.animationName);
    const introActive=document.querySelector('.lp .cta-in').getAnimations().map(a=>a.animationName);
    fixture.remove();return {values,active:[...active,...introActive]};
  })()`);
  for (const [name,duration,iterations] of [['lp-ctaIn',.64,'1'],['lp-gleam',1.1,'1'],['lp-ink',.45,'1'],['lp-sweep',2.6,'infinite']]) {
    check(`motion on: ${name} production state animation is defined`, stateAnimations.values.some(a=>a.key===name && a.name===name && parseFloat(a.duration)===duration && a.iterations===iterations) && stateAnimations.active.includes(name), stateAnimations);
  }
  await moving.eval(`document.querySelector('.motion-toggle').focus(); scrollTo(0,800)`);
  await sleep(400);
  const focusedNav = await moving.eval(`(() => {const nav=document.querySelector('.lp .nav'),b=document.querySelector('.motion-toggle'),r=b.getBoundingClientRect();return {hidden:nav.classList.contains('hide'),focused:document.activeElement===b,top:r.top,bottom:r.bottom,viewport:innerHeight};})()`);
  check('focused nav stays visible after downward scroll', focusedNav.focused && focusedNav.top >= -1 && focusedNav.bottom <= focusedNav.viewport, focusedNav);
  await moving.eval('scrollTo(0,0)'); await sleep(200); await snapshot(moving,'desktop-motion-on'); await close(moving);
  // Tabs share this origin's preference; restore the long-lived lifecycle fixture before its next remount.
  await layout.eval(`localStorage.setItem('ticketstub.motion','off')`);
  const offMotion = await layout.eval(`(() => {const root=document.querySelector('.lp');return { running:root.getAnimations({subtree:true}).filter(a=>a.playState==='running' && Number(a.effect.getComputedTiming().activeDuration)>0).map(a=>({name:a.animationName,duration:a.effect.getComputedTiming().activeDuration})), heading:[...root.querySelectorAll('.hero h1 .l>span')].map(e=>({transform:getComputedStyle(e).transform,opacity:getComputedStyle(e).opacity})) };})()`);
  check('motion off: no running landing animation', offMotion.running.length===0, offMotion);
  check('motion off: hero reveal text is visible', offMotion.heading.length>0 && offMotion.heading.every(e=>e.transform==='none' && Number(e.opacity)>0), offMotion);
  const transform = () => layout.eval(`['.disc svg','.marquee .track','.hero h1'].map(s=>getComputedStyle(document.querySelector('.lp '+s)).transform)`);
  const before = await transform(); await sleep(500); check('motion off: sampled elements remain still over time', JSON.stringify(before)===JSON.stringify(await transform()), before);

  const reveals = await layout.eval(`[...document.querySelectorAll('.lp-host .statement h2,.lp-host .statement .cols p,.lp-host .scenes-intro h2,.lp-host .interlude h2,.lp-host .how h2,.lp-host .how .step,.lp-host .studio h2,.lp-host .gallery h2,.lp-host footer .bigmark')].map(e=>({text:e.textContent.trim().slice(0,40),opacity:getComputedStyle(e).opacity,clipPath:getComputedStyle(e).clipPath}))`);
  check('motion off: section reveal copy is not hidden', reveals.length >= 10 && reveals.every(e=>Number(e.opacity)>0 && !/100%/.test(e.clipPath)), reveals);
  await layout.resize(1280,900);
  await pointer(layout, '.hero a[href="#start"]');
  check('hero studio CTA reaches mounted studio start', await layout.waitFor(`location.hash === '#start' && document.querySelector('#start').getBoundingClientRect().top >= -1 && document.querySelector('#start').getBoundingClientRect().top < innerHeight`));
  // Trusted keyboard activation exercises Next router navigation and landing cleanup; return via browser history.
  for (let i=1;i<=3;i++) {
    await layout.eval(`(() => {const b=[...document.querySelectorAll('#start button')].find(b=>b.textContent.includes('Search for your show'));b.scrollIntoView({behavior:'instant',block:'center'});b.focus();})()`);
    await layout.key('Enter'); check(`search return ${i}: arrives at /search`, await layout.waitFor(`location.pathname === '/search'`,10000));
    await layout.eval('history.back()'); check(`search return ${i}: landing remounts`, await layout.waitFor(`location.pathname === '/' && document.querySelector('.lp')?.classList.contains('ready')`,10000));
    check(`search return ${i}: one navigation and 3 studio sample cards`, await layout.eval(`document.querySelectorAll('.lp .nav').length === 1 && document.querySelectorAll('#tsCork .ts-stub').length === 3`));
    await pointer(layout); await expected(layout,'2d',`search return ${i}: enable once`);
    await pointer(layout); await expected(layout,'off',`search return ${i}: disable once`);
  }
  // Demo printing uses only the deterministic fixture and exercises the actual embedded studio entry.
  await layout.eval(`(() => {const b=[...document.querySelectorAll('#start button')].find(b=>b.textContent.trim()==='The Pale Hours');b.scrollIntoView({behavior:'instant',block:'center'});b.focus();})()`);
  await layout.key('Enter');
  check('embedded studio demo reaches fixture studio', await layout.waitFor(`location.pathname === '/studio/demo-pale'`,30000), await layout.eval('location.pathname'));
  await layout.eval('history.back()');
  check('return from studio restores landing', await layout.waitFor(`location.pathname === '/' && document.querySelector('.lp')?.classList.contains('ready')`,10000));
  await expected(layout,'off','return from studio keeps motion preference'); await close(layout);
} catch (error) {
  check('suite completes without infrastructure/runtime error', false, error.stack || String(error));
} finally {
  for (const page of pages) await page.close().catch(() => {});
  if (browser) await browser.close().catch(error => check('browser cleanup', false, String(error)));
  if (server) { server.kill(); await Promise.race([new Promise(r=>server.exitCode!==null ? r() : server.once('exit',r)),sleep(3000)]); if (server.exitCode===null) server.kill('SIGKILL'); }
  if (dataDir) rmSync(dataDir,{recursive:true,force:true});
  result.finishedAt = new Date().toISOString(); result.passed = result.assertions.filter(a=>a.passed).length; result.failed = result.assertions.length-result.passed;
  writeFileSync(join(evidenceDir,'results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(`Landing browser checks: ${result.passed} passed, ${result.failed} failed. Evidence: ${join(evidenceDir,'results.json')}`);
  process.exitCode = result.failed ? 1 : 0;
}
