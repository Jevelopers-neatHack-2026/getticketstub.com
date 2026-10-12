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
  async function withPage(width, html, work) {
    const page = await browser.newPage({ width, height: 844, mobile: width < 700 });
    try {
      await page.send("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
      await page.send("Page.bringToFront");
      const fixture = '<button id="opener">open</button><div id="dialog" role="dialog" aria-modal="true">' + html + '</div><button id="outside">outside</button>';
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
  }
  check("complete unique native matrix", [report.checks.length, new Set(report.checks.map((item) => item.name)).size], [46, 46]);
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
