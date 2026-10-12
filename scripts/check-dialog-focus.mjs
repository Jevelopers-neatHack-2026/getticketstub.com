// Native DOM/layout/keyboard controls for the exact focus.ts module (GT-11.1).
// React effect scheduling is deliberately synthetic here; the production a11y suite checks real React separately.
// node scripts/check-dialog-focus.mjs <evidence-dir>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { launchBrowser } from "./lib/cdp.mjs";

const out = resolve(process.argv[2] ?? "out/dialog-focus");
mkdirSync(out, { recursive: true });
const sourcePath = "src/customer/a11y/focus.ts";
const source = readFileSync(new URL(`../${sourcePath}`, import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const command = (exe, args) => {
  try { return execFileSync(exe, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};
const report = {
  mode: "exact focus.ts; native DOM/layout/keyboard; synthetic effect scheduling, not a React lifecycle or screen-reader pass",
  revision: command("git", ["rev-parse", "HEAD"]),
  tree: command("git", ["rev-parse", "HEAD^{tree}"]),
  worktreeStatus: command("git", ["status", "--porcelain"]),
  node: process.version,
  npm: command("npm", ["--version"]),
  typescript: ts.version,
  sourcePath,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  checks: [],
};
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  report.checks.push({ name, actual, expected, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify({ actual, expected })}`}`);
}

const cases = [
  ["visibility-hidden", '<button id="excluded" style="visibility:hidden">hidden</button><button id="valid">valid</button>', ["valid"]],
  ["inherited-visibility", '<div style="visibility:hidden"><button id="excluded">hidden</button><button id="override" style="visibility:visible">visible override</button></div><button id="valid">valid</button>', ["override", "valid"]],
  ["visibility-collapse", '<button id="excluded" style="visibility:collapse">hidden</button><button id="valid">valid</button>', ["valid"]],
  ["fixed-display-none", '<button id="excluded" style="position:fixed;display:none">hidden</button><button id="valid">valid</button>', ["valid"]],
  ["hidden-fixed-descendant", '<div hidden><button id="excluded" style="position:fixed">hidden</button></div><button id="valid">valid</button>', ["valid"]],
  ["disabled-tabindex", '<button id="excluded" disabled tabindex="0">disabled</button><button id="valid">valid</button>', ["valid"]],
  ["disabled-fieldset", '<fieldset disabled><button id="excluded">disabled</button><input id="input"></fieldset><button id="valid">valid</button>', ["valid"]],
  ["first-legend-exception", '<fieldset disabled><legend><button id="legend">legend</button></legend><button id="excluded">disabled</button></fieldset><button id="valid">valid</button>', ["legend", "valid"]],
  ["aria-hidden-ancestor", '<div aria-hidden="true"><button id="excluded">hidden</button></div><button id="valid">valid</button>', ["valid"]],
  ["inert-ancestor", '<div inert><button id="excluded">inert</button></div><button id="valid">valid</button>', ["valid"]],
  ["negative-tabindex", '<a id="excluded" tabindex="-2" href="#">excluded</a><button id="valid">valid</button>', ["valid"]],
  ["visible-fixed", '<button id="fixed" style="position:fixed;top:0;left:0">fixed</button><button id="valid">valid</button>', ["fixed", "valid"]],
];
const initialCases = [
  ["requested-hidden", '<input id="hidden" style="visibility:hidden"><button id="valid">valid</button>', "#hidden", "valid"],
  ["requested-disabled", '<input id="disabled" disabled><button id="valid">valid</button>', "#disabled", "valid"],
  ["heading-initial", '<h2 id="heading" tabindex="-1">Title</h2><button id="valid">valid</button>', "#heading", "heading"],
  ["self-initial", '<button id="valid">valid</button>', "self", "dialog"],
  ["empty-fallback", '<button id="hidden" style="visibility:hidden">hidden</button>', null, "dialog"],
];
// Native sequential navigation must never enter a target excluded by focusables().
const traversalCases = [
  {"name": "interior-forward", "html": "<button id='first'>first</button><div aria-hidden='true'><button id='excluded'>excluded</button></div><button id='last'>last</button>", "initial": "#first", "keys": ["Tab"], "expected": ["last"]},
  {"name": "interior-reverse", "html": "<button id='first'>first</button><div aria-hidden='true'><button id='excluded'>excluded</button></div><button id='last'>last</button>", "initial": "#last", "keys": ["Shift+Tab"], "expected": ["first"]},
  {"name": "dynamic-interior", "html": "<button id='first'>first</button><div id='hidden'><button id='excluded'>excluded</button></div><button id='last'>last</button>", "initial": "#first", "setup": "document.getElementById('hidden').setAttribute('aria-hidden','true')", "keys": ["Tab"], "expected": ["last"]},
  {"name": "removed-current-forward", "html": "<button id='first'>first</button><div id='hidden'><button id='excluded'>excluded</button></div><button id='last'>last</button>", "initial": "#excluded", "setup": "document.getElementById('hidden').setAttribute('aria-hidden','true')", "keys": ["Tab"], "expected": ["last"]},
  {"name": "removed-current-reverse", "html": "<button id='first'>first</button><div id='hidden'><button id='excluded'>excluded</button></div><button id='last'>last</button>", "initial": "#excluded", "setup": "document.getElementById('hidden').setAttribute('aria-hidden','true')", "keys": ["Shift+Tab"], "expected": ["first"]},
  {"name": "positive-order-forward", "html": "<button id='zero'>zero</button><button id='second' tabindex='2'>two</button><div aria-hidden='true'><button id='excluded' tabindex='3'>excluded</button></div><button id='first' tabindex='1'>one</button>", "initial": "#first", "keys": ["Tab", "Tab", "Tab"], "expected": ["second", "zero", "first"]},
  {"name": "positive-order-reverse", "html": "<button id='zero'>zero</button><button id='second' tabindex='2'>two</button><div aria-hidden='true'><button id='excluded' tabindex='3'>excluded</button></div><button id='first' tabindex='1'>one</button>", "initial": "#zero", "keys": ["Shift+Tab", "Shift+Tab", "Shift+Tab"], "expected": ["second", "first", "zero"]},
  {"name": "checked-radio-forward", "html": "<button id='first'>first</button><div aria-hidden='true'><button id='excluded'>excluded</button></div><input type='radio' name='g' id='one'><input type='radio' name='g' id='two' checked><input type='radio' name='g' id='three'><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "Tab"], "expected": ["two", "last"]},
  {"name": "checked-radio-reverse", "html": "<button id='first'>first</button><div aria-hidden='true'><button id='excluded'>excluded</button></div><input type='radio' name='g' id='one'><input type='radio' name='g' id='two' checked><input type='radio' name='g' id='three'><button id='last'>last</button>", "initial": "#last", "keys": ["Shift+Tab", "Shift+Tab"], "expected": ["two", "first"]},
  {"name": "unchecked-radio-forward", "html": "<button id='first'>first</button><input type='radio' name='g' id='one'><input type='radio' name='g' id='two'><input type='radio' name='g' id='three'><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "Tab"], "expected": ["one", "last"]},
  {"name": "unchecked-radio-reverse", "html": "<button id='first'>first</button><input type='radio' name='g' id='one'><input type='radio' name='g' id='two'><input type='radio' name='g' id='three'><button id='last'>last</button>", "initial": "#last", "keys": ["Shift+Tab", "Shift+Tab"], "expected": ["three", "first"]},
  {"name": "different-form-radios", "html": "<button id='first'>first</button><form><input type='radio' name='g' id='one' checked></form><form><input type='radio' name='g' id='two' checked></form><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "Tab", "Tab"], "expected": ["one", "two", "last"]},
  {"name": "unnamed-radios", "html": "<button id='first'>first</button><input type='radio' id='one'><input type='radio' id='two'><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "Tab", "Tab"], "expected": ["one", "two", "last"]},
  {"name": "heading-interior-forward", "html": "<button id='first'>first</button><h2 id='heading' tabindex='-1'>Heading</h2><div aria-hidden='true'><button id='excluded'>excluded</button></div><button id='last'>last</button>", "initial": "#heading", "keys": ["Tab"], "expected": ["last"]},
  {"name": "heading-interior-reverse", "html": "<button id='first'>first</button><h2 id='heading' tabindex='-1'>Heading</h2><div aria-hidden='true'><button id='excluded'>excluded</button></div><button id='last'>last</button>", "initial": "#heading", "keys": ["Shift+Tab"], "expected": ["first"]},
  {"name": "one-control", "html": "<button id='first'>first</button>", "initial": "#first", "keys": ["Tab", "Shift+Tab"], "expected": ["first", "first"]},
  {"name": "widget-prevents-tab", "html": "<button id=\"first\">first</button><button id=\"last\">last</button>", "initial": "#first", "setup": "document.getElementById(\"first\").addEventListener(\"keydown\", e => { if(e.key === \"Tab\") e.preventDefault(); })", "keys": ["Tab"], "expected": ["first"]},
  {"name": "radio-only-boundary", "html": "<input id='a' type='radio' name='g'><input id='b' type='radio' name='g' checked><input id='c' type='radio' name='g'>", "initial": "#b", "keys": ["Tab", "Shift+Tab"], "expected": ["b", "b"]},
  {"name": "radio-first-boundary", "html": "<input id='a' type='radio' name='g'><input id='b' type='radio' name='g' checked><input id='c' type='radio' name='g'><button id='last'>last</button>", "initial": "#b", "keys": ["Shift+Tab"], "expected": ["last"]},
  {"name": "radio-last-boundary", "html": "<button id='first'>first</button><input id='a' type='radio' name='g'><input id='b' type='radio' name='g' checked><input id='c' type='radio' name='g'>", "initial": "#b", "keys": ["Tab"], "expected": ["first"]},
  {"name": "summary-only-boundary", "html": "<details><summary id='summary'>summary</summary><button id='inside'>inside</button></details>", "initial": "#summary", "keys": ["Tab", "Shift+Tab"], "expected": ["summary", "summary"]}
];

const nativeCases = [
  {"name": "summary-and-open-details", "html": "<button id='first'>first</button><details><summary id='summary'>summary</summary><button id='inside'>inside</button></details><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "Enter", "Tab", "Tab"], "nativeMustVisit": "summary"},
  {"name": "native-audio-controls", "html": "<button id='first'>first</button><audio id='audio' controls></audio><button id='last'>last</button>", "initial": "#first", "untilLast": true, "nativeMustVisit": "audio"},
  {"name": "native-video-controls", "html": "<button id='first'>first</button><video id='video' controls width='160' height='90'></video><button id='last'>last</button>", "initial": "#first", "untilLast": true, "nativeMustVisit": "video"},
  {"name": "native-editing-host", "html": "<button id='first'>first</button><div id='edit' contenteditable='plaintext-only'>editable</div><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "Tab"], "nativeMustVisit": "edit"},
  {"name": "document-delegated-widget", "html": "<button id='first'>first</button><button id='last'>last</button>", "initial": "#first", "setup": "document.addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();window.__widget=(window.__widget??0)+1}})", "keys": ["Tab", "Shift+Tab"], "nativeMustVisit": "first"},
  {"name": "native-unchecked-radio-reverse", "html": "<button id='first'>first</button><input type='radio' name='g' id='one'><input type='radio' name='g' id='two'><input type='radio' name='g' id='three'><button id='last'>last</button>", "initial": "#last", "keys": ["Shift+Tab", "Shift+Tab"], "nativeRadioEntry": true},
  {"name": "external-checked-form-radio", "outside": "<form id='shared'></form><input id='external' type='radio' form='shared' name='g' checked>", "html": "<button id='first'>first</button><input id='inside' type='radio' form='shared' name='g'><button id='last'>last</button>", "initial": "#first", "keys": ["Tab"], "nativeMustVisit": "last"},
  {"name": "external-disabled-checked-radio", "outside": "<form id='shared'></form><input id='external' type='radio' form='shared' name='g' checked disabled>", "html": "<button id='first'>first</button><input id='inside' type='radio' form='shared' name='g'><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "Tab"], "nativeMustVisit": "inside"},
  {"name": "external-inert-checked-radio", "outside": "<form id='shared'></form><div inert><input id='external' type='radio' form='shared' name='g' checked></div>", "html": "<button id='first'>first</button><input id='inside' type='radio' form='shared' name='g'><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "Tab"], "nativeMustVisit": "inside"},
  {"name": "radio-arrow-selection", "html": "<button id='first'>first</button><input type='radio' name='g' id='one' checked><input type='radio' name='g' id='two'><input type='radio' name='g' id='three'><button id='last'>last</button>", "initial": "#first", "keys": ["Tab", "ArrowRight", "Tab"], "nativeMustVisit": "two"},
  {"name": "native-audio-boundary", "html": "<button id='first'>first</button><audio id='audio' controls></audio>", "initial": "#first", "untilOutside": true, "nativeMustVisit": "audio", "wrapTarget": "first"}
];

let browser;
let requests = 0;
let exceptions = 0;
let off;
try {
  browser = await launchBrowser();
  const version = await browser.conn.send("Browser.getVersion");
  report.browser = { product: version.product, protocolVersion: version.protocolVersion, jsVersion: version.jsVersion };
  off = browser.conn.on((event) => {
    if (event.method === "Network.requestWillBeSent" && /^https?:/.test(event.params.request.url)) requests++;
    if (event.method === "Runtime.exceptionThrown") exceptions++;
  });
  async function withPage(width, html, work, outside = "") {
    const page = await browser.newPage({ width, height: 844, mobile: width < 700 });
    try {
      await page.send("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
      await page.send("Page.bringToFront");
      const fixture = outside + '<button id="opener">open</button><div id="dialog" role="dialog" aria-modal="true">' + html + '</div><button id="outside">outside</button>';
      await page.eval(`(() => {
        document.body.innerHTML = ${JSON.stringify(fixture)};
        const exports = {};
        const require = (name) => {
          if (name !== "react") throw new Error("unexpected fixture import");
          return { useEffect: (effect) => { window.__cleanup = effect(); } };
        };
        new Function("exports", "require", ${JSON.stringify(compiled)})(exports, require);
        window.__focus = exports;
        document.getElementById("opener").focus();
        return true;
      })()`);
      await work(page);
    } finally {
      await page.eval('typeof window.__cleanup === "function" ? (window.__cleanup(), window.__cleanup = null, true) : true').catch(() => {});
      await page.close();
    }
  }
  const active = (page) => page.eval("document.activeElement.id");
  const start = async (page, initial = null) => {
    await page.eval(`window.__focus.useDialogFocus({ current: document.getElementById("dialog") }, true, ${JSON.stringify(initial)}); true`);
    await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
  };
  for (const width of [390, 1280]) {
    for (const [name, html, expected] of cases) {
      await withPage(width, html, async (page) => {
        check(`${width}:${name}`, await page.eval('window.__focus.focusables(document.getElementById("dialog")).map((el) => el.id)'), expected);
      });
    }
    await withPage(width, '<button id="hidden" style="visibility:hidden">hidden</button><button id="first">first</button><button id="last">last</button><button id="none" style="display:none;position:fixed">none</button>', async (page) => {
      await start(page);
      check(`${width}:initial-visible`, await active(page), "first");
      await page.eval('document.getElementById("first").focus(); true');
      await page.key("Tab", { shift: true });
      check(`${width}:reverse-wrap`, await active(page), "last");
      await page.eval('document.getElementById("last").focus(); true');
      await page.key("Tab");
      check(`${width}:forward-wrap`, await active(page), "first");
      await page.eval('document.getElementById("last").style.visibility = "hidden"; document.getElementById("first").focus(); true');
      await page.key("Tab");
      check(`${width}:dynamic-hidden-wrap`, await active(page), "first");
      await page.eval('document.getElementById("first").focus(); window.__cleanup(); window.__cleanup = null; true');
      check(`${width}:restore-opener`, await active(page), "opener");
    });
    await withPage(width, '<button id="first">first</button>', async (page) => {
      await start(page);
      await page.eval('document.getElementById("outside").focus(); window.__cleanup(); window.__cleanup = null; true');
      check(`${width}:intentional-outside-focus`, await active(page), "outside");
    });
    for (const [name, html, initial, expected] of initialCases) {
      await withPage(width, html, async (page) => {
        await start(page, initial);
        check(`${width}:${name}`, await active(page), expected);
      });
    }
    for (const test of traversalCases) {
      let expected = test.expected;
      if (test.name.startsWith("unchecked-radio-")) {
        // Radio entry varies with browser implementation/feature state. Measure this browser's
        // untrapped native sequence instead of codifying either first/last reverse entry.
        expected = [];
        await withPage(width, test.html, async (page) => {
          await page.eval(`document.querySelector(${JSON.stringify(test.initial)}).focus(); true`);
          for (const key of test.keys) {
            await page.key("Tab", { shift: key === "Shift+Tab" });
            expected.push(await active(page));
          }
        });
        check(`${width}:${test.name}:native-entry-control`, expected.length === 2
          && ["one", "three"].includes(expected[0])
          && expected[1] === (test.name.endsWith("reverse") ? "first" : "last"), true);
      }
      await withPage(width, test.html, async (page) => {
        await start(page, test.initial);
        if (test.setup) await page.eval(test.setup);
        await page.eval(`(() => {
          window.__keys = []; window.__badFocus = [];
          document.addEventListener("keydown", (e) => { if (e.key === "Tab") window.__keys.push(e.isTrusted); }, true);
          document.addEventListener("focusin", (e) => { if (e.target.closest('[aria-hidden="true"]')) window.__badFocus.push(e.target.id); }, true);
          return true;
        })()`);
        const actual = [];
        for (const key of test.keys) {
          await page.key("Tab", { shift: key === "Shift+Tab" });
          actual.push(await active(page));
        }
        check(`${width}:${test.name}`, actual, expected);
        check(`${width}:${test.name}:trusted-no-hidden-focus`, await page.eval('({ keys: window.__keys, hidden: window.__badFocus })'),
          { keys: test.keys.map(() => true), hidden: [] });
      });
    }
    for (const placement of ["nested", "portal"]) {
      const inner = '<div id="inner" role="dialog" aria-modal="true"><button id="inner-first">first</button><div aria-hidden="true"><button id="excluded">excluded</button></div><button id="inner-last">last</button></div>';
      await withPage(width, '<button id="outer-first">outer</button>' + (placement === "nested" ? inner : ""), async (page) => {
        await start(page, "#outer-first");
        if (placement === "portal") await page.eval(`document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(inner)}); true`);
        await page.eval(`(() => {
          const outer = window.__cleanup;
          window.__focus.useDialogFocus({ current: document.getElementById("inner") }, true);
          window.__innerCleanup = window.__cleanup;
          window.__outerCleanup = outer;
          window.__cleanup = () => { window.__innerCleanup?.(); outer(); };
          window.__keys = []; window.__badFocus = [];
          document.addEventListener("keydown", (e) => { if (e.key === "Tab") window.__keys.push(e.isTrusted); }, true);
          document.addEventListener("focusin", (e) => { if (e.target.closest('[aria-hidden="true"]')) window.__badFocus.push(e.target.id); }, true);
          return true;
        })()`);
        await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
        const actual = [await active(page)];
        for (const shift of [false, false, true]) {
          await page.key("Tab", { shift }); actual.push(await active(page));
        }
        check(`${width}:${placement}:inner-owns-tab`, actual, ["inner-first", "inner-last", "inner-first", "inner-last"]);
        if (placement === "portal") {
          await page.eval('document.getElementById("outer-first").hidden = true; true');
          await page.key("Tab");
          check(`${width}:portal:empty-outer-does-not-steal`, await active(page), "inner-first");
          await page.eval('document.getElementById("outer-first").hidden = false; true');
        }
        check(`${width}:${placement}:trusted-no-hidden-focus`, await page.eval('({ keys: window.__keys, hidden: window.__badFocus })'),
          { keys: Array(placement === "portal" ? 4 : 3).fill(true), hidden: [] });
        await page.eval('window.__innerCleanup(); window.__innerCleanup = null; window.__cleanup = window.__outerCleanup; true');
        check(`${width}:${placement}:return-to-parent`, await active(page), "outer-first");
      });
    }
    for (const test of nativeCases) {
      const native = [], nativeKeys = [];
      let keys = test.keys ?? [];
      await withPage(width, test.html, async (page) => {
        await page.eval(`document.querySelector(${JSON.stringify(test.initial)}).focus(); true`);
        if (test.setup) await page.eval(`${test.setup}; true`);
        await page.eval(`(() => { window.__nativeKeys = [];
          document.addEventListener("keydown", (e) => { if (e.key !== "Shift") window.__nativeKeys.push(e.isTrusted); }, true);
          return true;
        })()`);
        if (test.untilLast || test.untilOutside) {
          keys = [];
          for (let step = 0; step < 12; step++) {
            keys.push("Tab");
            await page.key("Tab");
            native.push(await active(page));
            if (native.at(-1) === (test.untilOutside ? "outside" : "last")) break;
          }
        } else {
          for (const key of keys) {
            await page.key(key === "Shift+Tab" ? "Tab" : key, { shift: key === "Shift+Tab" });
            native.push(await active(page));
          }
        }
        nativeKeys.push(...await page.eval("window.__nativeKeys"));
      }, test.outside);
      const nativeExercised = native.length > 0 && nativeKeys.length > 0 && nativeKeys.every((trusted) => trusted === true)
        && (test.nativeRadioEntry ? ["one", "three"].includes(native[0]) && native.at(-1) === "first" : native.includes(test.nativeMustVisit))
        && (!(test.untilLast || test.untilOutside) || native.at(-1) === (test.untilOutside ? "outside" : "last") && native.length <= 12);
      check(`${width}:${test.name}:native-control-exercised`, nativeExercised, true);
      await withPage(width, test.html, async (page) => {
        await start(page, test.initial);
        if (test.setup) await page.eval(`${test.setup}; true`);
        await page.eval(`(() => {
          window.__keys = []; window.__badFocus = [];
          document.addEventListener("keydown", (e) => { if (e.key !== "Shift") window.__keys.push(e.isTrusted); }, true);
          document.addEventListener("focusin", (e) => { if (e.target.closest('[aria-hidden="true"]')) window.__badFocus.push(e.target.id); }, true);
          return true;
        })()`);
        const actual = [];
        for (const key of keys) {
          await page.key(key === "Shift+Tab" ? "Tab" : key, { shift: key === "Shift+Tab" });
          actual.push(await active(page));
        }
        check(`${width}:${test.name}:native-parity`, actual, test.wrapTarget ? [...native.slice(0, -1), test.wrapTarget] : native);
        // Browser-owned media controls can consume an internal key before it reaches the document.
        // Compare with the measured native dispatch trace, not a guessed one-event-per-command count.
        check(`${width}:${test.name}:trusted-no-hidden-focus`, await page.eval('({ keys: window.__keys, hidden: window.__badFocus })'),
          { keys: nativeKeys, hidden: [] });
      }, test.outside);
    }
    for (const intent of ["pointer", "document-widget"]) {
      await withPage(width, '<button id="first">first</button><button id="last">last</button>', async (page) => {
        await start(page, "#first");
        await page.key("Tab");
        if (intent === "pointer") {
          const point = await page.eval('(() => { const r = document.getElementById("outside").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
          await page.click(point.x, point.y);
        } else {
          await page.eval(`(() => { document.addEventListener("keydown", (e) => {
            if (e.key === "Tab") { e.preventDefault(); document.getElementById("outside").focus(); }
          }, { once: true }); return true; })()`);
          await page.key("Tab");
        }
        check(`${width}:${intent}:clears-native-continuation`, await active(page), "outside");
        await page.eval("window.__cleanup(); window.__cleanup = null; true");
        check(`${width}:${intent}:cleanup-preserves-intent`, await active(page), "outside");
      });
    }
    const maskFixture = '<button id="first">first</button><div id="hidden" aria-hidden="true"><button id="excluded">excluded</button></div><div id="owned" aria-hidden="true" inert="owner"><button>owner</button></div><button id="last">last</button>';
    for (const mutation of ["none", "same-value", "new-value", "remove"]) {
      await withPage(width, maskFixture, async (page) => {
        await start(page, "#first");
        const script = mutation === "same-value" ? 'h.setAttribute("inert", "");'
          : mutation === "new-value" ? 'h.setAttribute("inert", "other-owner");'
          : mutation === "remove" ? 'h.removeAttribute("inert"); e.preventDefault();' : "";
        await page.eval(`(() => { window.addEventListener("keydown", (e) => {
          if (e.key !== "Tab") return;
          const h = document.getElementById("hidden"); window.__masked = h.hasAttribute("inert");
          ${script}
        }, { once: true }); return true; })()`);
        await page.key("Tab");
        await page.eval("new Promise((r) => setTimeout(() => r(true), 20))");
        check(`${width}:mask-${mutation}:applied-before-default`, await page.eval("window.__masked"), true);
        check(`${width}:mask-${mutation}:owned-cleanup`, await page.eval('({ hidden: document.getElementById("hidden").getAttribute("inert"), existing: document.getElementById("owned").getAttribute("inert") })'),
          { hidden: mutation === "same-value" ? "" : mutation === "new-value" ? "other-owner" : null, existing: "owner" });
      });
    }
    await withPage(width, maskFixture, async (page) => {
      await start(page, "#first");
      await page.eval(`(() => { window.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        window.__masked = document.getElementById("hidden").hasAttribute("inert");
        window.__cleanup(); window.__cleanup = null; e.preventDefault();
      }, { once: true }); return true; })()`);
      await page.key("Tab");
      check(`${width}:mask-unmount:observed-before-cleanup`, await page.eval("window.__masked"), true);
      check(`${width}:mask-unmount:restores-owned-only`, await page.eval('({ hidden: document.getElementById("hidden").getAttribute("inert"), existing: document.getElementById("owned").getAttribute("inert"), focus: document.activeElement.id })'),
        { hidden: null, existing: "owner", focus: "opener" });
    });
  }
  check("complete unique native matrix", [report.checks.length, new Set(report.checks.map((item) => item.name)).size], [242, 242]);
  check("no page HTTP requests", requests, 0);
  check("no page exceptions", exceptions, 0);
  check("source and runtime metadata present", /^[a-f0-9]{40}$/.test(report.revision ?? "") && /^[a-f0-9]{40}$/.test(report.tree ?? "") && report.worktreeStatus === "" && /^\d+\.\d+\.\d+$/.test(report.npm ?? ""), true);
} catch (error) {
  check("native runner completed", { error: error instanceof Error ? error.name : "unknown" }, "completed");
} finally {
  off?.();
  try { await browser?.close(); }
  catch { check("browser teardown", "failed", "completed"); }
  report.passed = report.checks.filter((item) => item.ok).length;
  report.failed = report.checks.filter((item) => !item.ok).length;
  report.skipped = 0;
  writeFileSync(resolve(out, "dialog-focus.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(`dialog focus: ${report.passed} passed, ${report.failed} failed, 0 skipped`);
process.exitCode = report.failed ? 1 : 0;
