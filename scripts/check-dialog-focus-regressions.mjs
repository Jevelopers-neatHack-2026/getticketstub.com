// Refs #18 / #126: independent regressions for review comments 4253031263, 4253031270 and 4253031277.
// This supplements, never replaces, check-dialog-focus.mjs. Native keyboard/DOM; synthetic effects.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { launchBrowser } from "./lib/cdp.mjs";

const out = resolve(process.argv[2] ?? "out/dialog-focus");
mkdirSync(out, { recursive: true });
const source = readFileSync(new URL("../src/customer/a11y/focus.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const command = (exe, args) => {
  try { return execFileSync(exe, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};
const report = {
  mode: "native DOM/layout/keyboard; synthetic useEffect and programmatic pre-effect focus, NOT production React or screen-reader qualification",
  revision: command("git", ["rev-parse", "HEAD"]), tree: command("git", ["rev-parse", "HEAD^{tree}"]),
  worktreeStatus: command("git", ["status", "--porcelain"]),
  node: process.version, npm: command("npm", ["--version"]), typescript: ts.version,
  runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  runnerSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  expectedScenarios: 220, viewports: [{ width: 390, height: 844, mobile: true }, { width: 1280, height: 844, mobile: false }],
  checks: [], errors: [], sequences: {},
};
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  report.checks.push({ name, actual, expected, ok });
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify({ actual, expected })}`}`);
}
const active = (page) => page.eval("document.activeElement.id");
const settle = (page) => page.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
async function start(page, root = "dialog", initial = null) {
  await page.eval(`window.__focus.useDialogFocus({ current: document.getElementById(${JSON.stringify(root)}) }, true, ${JSON.stringify(initial)}); true`);
  await settle(page);
}
const shell = (html) => `<button id="opener">open</button><div id="dialog" role="dialog" aria-modal="true">${html}</div><button id="outside">outside</button>`;
// The srcdoc witness reports only its own active id. The helper never reads a frame's document.
// Opaque sandbox frames retain scripts solely to report fixture observations over postMessage.
function frame(id, opaque = false) {
  const body = `<button id="one">one</button><button id="two">two</button><script>
    const send = () => parent.postMessage({ fixture: 'dialog-focus-regression', active: document.activeElement.id, ready: true }, '*');
    document.addEventListener('focusin', send); send();
  <\/script>`;
  return `<iframe id="${id}" ${opaque ? 'sandbox="allow-scripts"' : ""} srcdoc="${body.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`;
}
let browser, off, requests = 0, exceptions = 0;
try {
  browser = await launchBrowser(); // Preserve the repository's launcher, isolation and platform behavior unchanged.
  const version = await browser.conn.send("Browser.getVersion");
  report.browser = { product: version.product, protocolVersion: version.protocolVersion, jsVersion: version.jsVersion };
  off = browser.conn.on((event) => {
    if (event.method === "Network.requestWillBeSent" && /^https?:/.test(event.params.request.url)) requests++;
    if (event.method === "Runtime.exceptionThrown") exceptions++;
  });
  async function withPage(width, html, work, seedBefore = false) {
    const page = await browser.newPage({ width, height: 844, mobile: width < 700 });
    try {
      await page.send("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
      await page.send("Page.bringToFront");
      await page.eval(`(() => {
        window.__frameWitness = {};
        window.addEventListener('message', e => {
          if (e.data?.fixture !== 'dialog-focus-regression') return;
          const frame = [...document.querySelectorAll('iframe')].find(f => f.contentWindow === e.source);
          if (frame) window.__frameWitness[frame.id] = { active: e.data.active, ready: e.data.ready };
        });
        document.body.innerHTML = ${JSON.stringify(html)};
        ${seedBefore ? "document.getElementById('opener').focus();" : ""}
        window.__cleanups = [];
        const exports = {};
        const require = name => {
          if (name !== 'react') throw new Error('unexpected fixture import');
          return { useEffect: effect => window.__cleanups.push(effect()) };
        };
        new Function('exports', 'require', ${JSON.stringify(compiled)})(exports, require);
        window.__focus = exports;
        window.__trusted = [];
        document.addEventListener('keydown', e => { if (e.key === 'Tab') window.__trusted.push(e.isTrusted); }, true);
        ${seedBefore ? "" : "document.getElementById('opener')?.focus();"}
        return true;
      })()`);
      await work(page);
    } finally {
      // Each fixture owns a fresh page. Teardown errors are evidence, not silent skips.
      try { await page.eval("window.__cleanups?.splice(0).reverse().forEach(f => f?.()); true"); }
      catch (error) { report.errors.push({ phase: "fixture-cleanup", message: String(error) }); }
      await page.close();
    }
  }
  for (const width of [390, 1280]) {
    for (const mode of ["true", "plaintext-only"]) for (const positive of [false, true]) for (const reverse of [false, true]) {
      const name = `${width}:editing:${mode}:positive=${positive}:reverse=${reverse}`;
      const html = positive
        ? `<div id="edit" contenteditable="${mode}">editable</div><button id="zero">zero</button><button id="positive" tabindex="1">positive</button>`
        : `<button id="first">first</button><div id="edit" contenteditable="${mode}">editable</div>`;
      const order = positive ? ["positive", "edit", "zero"] : ["first", "edit"];
      const initial = reverse ? order.at(-1) : order[0];
      const expected = [];
      let index = order.indexOf(initial);
      for (let i = 0; i <= order.length; i++) {
        index = (index + (reverse ? -1 : 1) + order.length) % order.length;
        expected.push(order[index]);
      }
      await withPage(width, shell(html), async page => {
        await start(page, "dialog", `#${initial}`);
        check(`${name}:implicit-tabindex`, await page.eval("document.getElementById('edit').tabIndex"), -1);
        const sequence = [];
        for (let i = 0; i < expected.length; i++) { await page.key("Tab", { shift: reverse }); sequence.push(await active(page)); }
        check(`${name}:cycle`, sequence, expected);
        check(`${name}:trusted`, await page.eval("window.__trusted"), expected.map(() => true));
      });
      await withPage(width, html, async page => {
        await page.eval(`document.getElementById(${JSON.stringify(initial)}).focus(); true`);
        const sequence = [];
        for (let i = 0; i < order.length - 1; i++) { await page.key("Tab", { shift: reverse }); sequence.push(await active(page)); }
        check(`${name}:untrapped-order`, sequence, expected.slice(0, order.length - 1));
      });
    }
    await withPage(width, '<button id="opener">open</button><div id="child" role="dialog" aria-modal="true"><button id="auto">autofocus proxy</button><audio id="media" controls></audio></div><div id="parent" role="dialog" aria-modal="true"><button id="p1">parent one</button><button id="p2">parent two</button></div>', async page => {
      await start(page, "parent", "#p1");
      // Model the pre-passive-effect autofocus ordering explicitly; this is not React lifecycle execution.
      await page.eval("document.getElementById('p2').focus(); document.getElementById('auto').focus(); true");
      await start(page, "child");
      let visited = false, contained = true, wrapped = false;
      const sequence = [];
      for (let i = 0; i < 16; i++) {
        await page.key("Tab"); const id = await active(page); sequence.push(id); visited ||= id === "media";
        contained = await page.eval("document.getElementById('child').contains(document.activeElement)");
        if (!contained) break;
        if (visited && id === "auto") { wrapped = true; break; }
      }
      report.sequences[`${width}:portal`] = sequence;
      check(`${width}:portal-autofocus:media-visited`, visited, true);
      check(`${width}:portal-autofocus:exit-contained`, contained, true);
      check(`${width}:portal-autofocus:wrap`, wrapped, true);
      await page.eval("document.getElementById('auto').focus(); window.__cleanups.splice(1, 1)[0](); true");
      check(`${width}:portal-autofocus:restore-parent-opener`, await active(page), "p2");
      await page.eval("document.getElementById('p1').focus(); document.getElementById('auto').focus(); true");
      await start(page, "child");
      await page.eval("window.__cleanups.splice(1, 1)[0](); true");
      check(`${width}:portal-autofocus:reopen-new-opener`, await active(page), "p1");
      await page.eval("window.__cleanups.splice(0, 1)[0](); true");
      check(`${width}:portal-autofocus:parent-restore`, await active(page), "opener");
    });
    await withPage(width, shell('<button id="auto">auto</button>'), async page => {
      await page.eval("document.getElementById('auto').focus(); true"); await start(page);
      await page.eval("window.__cleanups.splice(0, 1)[0](); true");
      check(`${width}:module-existing-focus:restore`, await active(page), "opener");
    }, true);
    for (const opaque of [false, true]) for (const reverse of [false, true]) {
      const name = `${width}:iframe:opaque=${opaque}:reverse=${reverse}`;
      await withPage(width, shell(`<button id="first">first</button>${frame("frame", opaque)}<button id="last">last</button>`), async page => {
        if (!await page.waitFor("window.__frameWitness.frame?.ready === true")) throw new Error(`${name}: frame did not become ready`);
        await start(page, "dialog", reverse ? "#last" : "#first");
        const order = reverse ? ["two", "one"] : ["one", "two"];
        for (let i = 0; i < order.length; i++) {
          await page.key("Tab", { shift: reverse });
          check(`${name}:inner-${i}`, await page.eval("[document.activeElement.id, window.__frameWitness.frame?.active]"), ["frame", order[i]]);
        }
        await page.key("Tab", { shift: reverse });
        check(`${name}:interior-return`, await active(page), reverse ? "first" : "last");
      });
    }
    await withPage(width, '<button id="opener">open</button><div id="dialog" role="dialog" aria-modal="true"><button id="first">first</button><audio id="media" controls></audio></div>' + frame("external"), async page => {
      if (!await page.waitFor("window.__frameWitness.external?.ready === true")) throw new Error("external frame did not become ready");
      await start(page, "dialog", "#first");
      let visited = false, contained = true, wrapped = false; const sequence = [];
      for (let i = 0; i < 16; i++) {
        await page.key("Tab"); const id = await active(page); sequence.push(id); visited ||= id === "media";
        contained = await page.eval("document.getElementById('dialog').contains(document.activeElement)");
        if (!contained) break;
        if (visited && id === "first") { wrapped = true; break; }
      }
      report.sequences[`${width}:external-frame`] = sequence;
      check(`${width}:outside-iframe:media-visited`, visited, true);
      check(`${width}:outside-iframe:contained`, contained, true);
      check(`${width}:outside-iframe:wrap`, wrapped, true);
    });
    // Review 5512305553: iframe edges, stopped propagation and measured image-map parity.
    for (const opaque of [false, true]) for (const reverse of [false, true]) {
      const name = `${width}:iframe-edge:opaque=${opaque}:reverse=${reverse}`;
      const html = reverse ? `${frame("edge", opaque)}<button id="last">last</button>`
        : `<button id="first">first</button>${frame("edge", opaque)}`;
      await withPage(width, shell(html), async page => {
        if (!await page.waitFor("window.__frameWitness.edge?.ready === true")) throw new Error(`${name}: frame not ready`);
        await start(page, "dialog", reverse ? "#last" : "#first");
        for (const [i, id] of (reverse ? ["two", "one"] : ["one", "two"]).entries()) {
          await page.key("Tab", { shift: reverse });
          check(`${name}:inner-${i}`, await page.eval("[document.activeElement.id, window.__frameWitness.edge?.active]"), ["edge", id]);
        }
        await page.key("Tab", { shift: reverse });
        check(`${name}:wrap`, await active(page), reverse ? "last" : "first");
        await page.key("Tab", { shift: reverse });
        const point = await page.eval("(() => { const r = document.getElementById('outside').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
        await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
        await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
        check(`${name}:pointer-intent`, await active(page), "outside");
        await page.eval("window.__cleanups.splice(0).reverse().forEach(f => f?.()); true");
        check(`${name}:cleanup-intent`, await active(page), "outside");
      });
    }
    for (const target of ["target", "document"]) for (const cancel of [false, true]) for (const reverse of [false, true]) {
      const name = `${width}:stopped-tab:${target}:cancel=${cancel}:reverse=${reverse}`;
      await withPage(width, shell('<button id="first">first</button><button id="last">last</button>'), async page => {
        await start(page, "dialog", reverse ? "#first" : "#last");
        await page.eval(`(() => {
          const target = ${JSON.stringify(target)} === 'document' ? document : document.activeElement;
          target.addEventListener('keydown', e => { if (e.key === 'Tab') { e.stopPropagation(); ${cancel ? "e.preventDefault();" : ""} } }); return true;
        })()`);
        await page.key("Tab", { shift: reverse });
        check(`${name}:result`, await active(page), cancel ? reverse ? "first" : "last" : reverse ? "last" : "first");
        check(`${name}:trusted`, await page.eval("window.__trusted"), [true]);
      });
    }
    for (const target of ["target", "document"]) {
      await withPage(width, shell('<button id="first">first</button><div aria-hidden="true"><button id="excluded">excluded</button></div><button id="last">last</button>'), async page => {
        await start(page, "dialog", "#first");
        await page.eval(`(() => {
          window.__excludedFocus = [];
          document.addEventListener('focusin', e => { if (e.target.closest('[aria-hidden="true"]')) window.__excludedFocus.push(e.target.id); }, true);
          const target = ${JSON.stringify(target)} === 'document' ? document : document.activeElement;
          target.addEventListener('keydown', e => { if (e.key === 'Tab') e.stopPropagation(); }); return true;
        })()`);
        await page.key("Tab");
        check(`${width}:stopped-hidden:${target}:native-next`, await active(page), "last");
        check(`${width}:stopped-hidden:${target}:no-transient-hidden-focus`, await page.eval("window.__excludedFocus"), []);
      });
    }
    for (const target of ["target", "document"]) for (const cancelBefore of [false, true]) {
      await withPage(width, shell('<button id="first">first</button><button id="last">last</button>'), async page => {
        await start(page, "dialog", "#last");
        await page.eval(`(() => {
          const target = ${JSON.stringify(target)} === 'document' ? document : document.activeElement;
          target.addEventListener('keydown', e => { if (e.key === 'Tab') {
            e.stopPropagation(); ${cancelBefore ? "e.preventDefault();" : ""}
            document.getElementById('outside').focus(); ${cancelBefore ? "" : "e.preventDefault();"}
          } }); return true;
        })()`);
        await page.key("Tab");
        check(`${width}:stopped-intent:${target}:cancel-before=${cancelBefore}`, await active(page), "outside");
        await page.eval("window.__cleanups.splice(0).reverse().forEach(f => f?.()); true");
        check(`${width}:stopped-intent:${target}:cleanup:cancel-before=${cancelBefore}`, await active(page), "outside");
      });
    }
    for (const mapStyle of ["default", "map-hidden", "area-hidden", "image-hidden"]) {
      // A data SVG supplies known local pixels; neither page makes a network request.
      const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/></svg>');
      const html = `<button id="positive" tabindex="1">positive</button><img id="map-image" width="100" height="100" src="${picture}" usemap="#ticket-map" ${mapStyle === "image-hidden" ? 'style="display:none"' : ''}><map name="ticket-map" ${mapStyle === "map-hidden" ? 'style="display:none"' : ''}><area id="area" href="#" shape="rect" coords="0,0,100,100" alt="Mapped link" ${mapStyle === "area-hidden" ? 'style="display:none"' : ''}></map><button id="last">last</button>`;
      let native;
      await withPage(width, html, async page => {
        if (!await page.waitFor("document.getElementById('map-image').complete")) throw new Error('image map not ready');
        await page.eval("document.getElementById('positive').focus(); true");
        await page.key("Tab"); native = await active(page);
        check(`${width}:image-map:${mapStyle}:native-exercised`, native, mapStyle === "image-hidden" ? "last" : "area");
        report.sequences[`${width}:image-map:${mapStyle}:layout`] = await page.eval("({rects:document.getElementById('area').getClientRects().length, imageRects:document.getElementById('map-image').getClientRects().length, areaTabindex:document.getElementById('area').tabIndex})");
      });
      await withPage(width, shell(html), async page => {
        if (!await page.waitFor("document.getElementById('map-image').complete")) throw new Error('image map not ready');
        await start(page, "dialog", "#positive"); await page.key("Tab");
        check(`${width}:image-map:${mapStyle}:native-parity`, await active(page), native);
      });
    }
  }
} catch (error) {
  report.errors.push({ phase: "execution", message: String(error), stack: error.stack ?? null });
} finally {
  const scenarioNames = report.checks.map(item => item.name);
  check("integrity:scenario-count", scenarioNames.length, report.expectedScenarios);
  check("integrity:unique-scenario-names", new Set(scenarioNames).size, report.expectedScenarios);
  check("integrity:no-http-requests", requests, 0);
  check("integrity:no-runtime-exceptions", exceptions, 0);
  off?.();
  try { await browser?.close(); }
  catch (error) { report.errors.push({ phase: "browser-cleanup", message: String(error) }); }
  report.counts = { tests: report.checks.length, passed: report.checks.filter(item => item.ok).length, failed: report.checks.filter(item => !item.ok).length, skipped: 0, errors: report.errors.length };
  report.passed = report.counts.failed === 0 && report.errors.length === 0;
  writeFileSync(resolve(out, "native-focus-regressions.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.counts));
  if (!report.passed) process.exitCode = 1;
}
