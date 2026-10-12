// Offline production-build regression for PR #112: server runtime mode reaches real checkout/cart controls.
// node scripts/check-runtime-order-gates.mjs --runtime live|demo --evidence-dir <outside-repo-dir>
// The optional --without-runtime-attribute mutation MUST fail live preview controls. It is not a product pass.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser } from "./lib/cdp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let mode, destination, mutate = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--runtime" && mode === undefined) mode = args[++i];
  else if (args[i] === "--evidence-dir" && destination === undefined) destination = args[++i];
  else if (args[i] === "--without-runtime-attribute" && !mutate) mutate = true;
  else throw new Error(`Unknown or duplicate argument: ${args[i]}`);
}
if (!["live", "demo"].includes(mode) || !destination || (mutate && mode !== "live")) {
  throw new Error("Use --runtime live|demo --evidence-dir <dir>; mutation is live-only.");
}
// Next loads these files itself. Never run this fixture server with an owner's populated environment files.
for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(join(root, name))) throw new Error(`Refusing ${name}; use a clean isolated checkout without environment files.`);
}
if (!existsSync(join(root, ".next/BUILD_ID"))) throw new Error("A production build is required.");
const out = resolve(destination);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "ticketstub-runtime-gates-"));
const netLog = join(scratch, "network.log");
writeFileSync(netLog, "");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const paths = ["src/app/layout.tsx", "src/customer/pages/capabilities.ts", "src/app/api/orders/route.ts",
  "src/app/checkout/[id]/CheckoutClient.tsx", "src/app/cart/CartClient.tsx", "scripts/lib/fixture-network-guard.mjs",
  "scripts/check-runtime-order-gates.mjs", "package-lock.json", ".next/BUILD_ID"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  revision: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "", node: process.version,
  npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), runtime: mode,
  mode: "offline synthetic browser-local stubs; real production React/HTTP; no provider or purchase",
  mutation: mutate ? "remove server runtime attribute before hydration" : null,
  command: ["node", "scripts/check-runtime-order-gates.mjs", ...args],
  hashes: Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(root, path)))])),
  checks: [], browser: null, blockedBrowserRequests: 0, orderRequests: 0, serverGuardAttempts: null, completedViewports: [],
};
function check(name, ok, actual = null) {
  report.checks.push({ name, ok: !!ok, actual });
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(actual)}`}`);
}
const within = async (promise, label, ms = 30_000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const n = server.address().port; server.close(() => resolve(n)); });
});
const base = `http://127.0.0.1:${port}`;
const env = {};
for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
Object.assign(env, {
  NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", TICKETSTUB_RUNTIME_MODE: mode,
  TICKETSTUB_DB: join(scratch, "fixture.sqlite"), TICKETSTUB_FILES: join(scratch, "files"),
  APP_URL: base, CONTEXT_SECRET: randomBytes(32).toString("hex"), TICKETSTUB_SANDBOX_MAIL: "0",
  TICKETSTUB_ANALYTICS_ENV: "off", TICKETSTUB_OPS_ENVIRONMENT: "test",
  NODE_OPTIONS: `--import ${pathToFileURL(join(root, "scripts/lib/fixture-network-guard.mjs")).href}`,
  VERIFY_NET_LOG: netLog,
});
const child = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "", spawnError = null, browser;
child.on("error", error => { spawnError = error; });
child.stdout.on("data", bytes => { serverLog += bytes; });
child.stderr.on("data", bytes => { serverLog += bytes; });
const capability = /export const CAPABILITY_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "src/customer/pages/capabilities.ts"), "utf8"))?.[1];
const ID = "runtime-gate-synthetic";
const fixture = (material = "digital", finish = "matte") => ({
  id: ID, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: 1791763200000,
  event: { type: "generic", title: "Synthetic runtime gate", venue: "Fixture room", dateISO: "2026-10-12", facts: [] },
  versions: [{ id: "runtime-gate-version", edition: "minimal", art: { kind: "procedural", seed: 1, provenance: "simulated" }, createdAt: "2026-10-12T00:00:00.000Z" }],
  currentVersionId: "runtime-gate-version", personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [], friends: [] },
  material, finish, torn: false, wallAngle: 0, photos: [],
});
const payExpression = `[...document.querySelectorAll('button')].find(e => /^Pay\\s/.test(e.textContent.trim()) && e.getBoundingClientRect().width > 0)`;
const addExpression = `[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Add to cart' && e.getBoundingClientRect().width > 0)`;
async function nativeClick(page, expression, mobile) {
  const point = await page.eval(`(async () => {
    const e = (${expression}); if (!e) throw new Error('Missing control');
    e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = e.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + b.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || (top !== e && !e.contains(top))) throw new Error('Control is occluded');
    return { x, y };
  })()`);
  if (mobile) {
    await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else await page.click(point.x, point.y);
}
async function controls(page, wantAdd) {
  if (!await page.waitFor(payExpression, 15_000)) throw new Error("Pay control did not mount");
  return page.eval(`(() => {
    const pay = (${payExpression}), add = (${addExpression});
    return { payDisabled: pay.disabled, addDisabled: ${wantAdd ? "add?.disabled ?? null" : "null"},
      previewMessage: [...document.querySelectorAll('[data-announce]')].some(e => e.textContent.includes("This is a preview.")),
      cart: localStorage.getItem('ticketstub.cart.v1'), orders: localStorage.getItem('ticketstub.orders.v1') };
  })()`);
}
try {
  if (!capability) throw new Error("Current capability version was not found; refusing stale fixture data.");
  // Probe the same preload in a separate process/log: refused traffic must never be sent or hidden in the product result.
  const probeLog = join(out, "guard-self-check.log");
  writeFileSync(probeLog, "");
  let probeExit = 0;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e",
      "try { await fetch('https://example.invalid/fixture-guard-probe'); process.exitCode = 1; } catch (e) { process.exitCode = e.code === 'ETICKETSTUB_FIXTURE_NETWORK' ? 0 : 2; }"],
      { cwd: root, env: { ...env, VERIFY_NET_LOG: probeLog }, stdio: "pipe", timeout: 5000 });
  } catch (error) { probeExit = error.status ?? 1; }
  const probeLines = readFileSync(probeLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const guarded = probeExit === 0 && probeLines.length === 1 && probeLines[0] === "fetch example.invalid";
  check("network.guard.refuses-before-transport", guarded, { exit: probeExit, refusals: probeLines.length });
  if (!guarded) throw new Error("The required server network guard self-check failed");
  let health;
  for (let i = 0; i < 60; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Fixture server exited ${child.exitCode}`);
    try { const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { health = await response.json(); break; } } catch { /* bounded startup */ }
    await pause(500);
  }
  check("health.runtime", health?.mode === mode, { mode: health?.mode, commit: health?.commit });
  if (!health || health.mode !== mode) throw new Error("Expected fixture server is unavailable");
  browser = await launchBrowser();
  report.browser = await browser.conn.send("Browser.getVersion");
  for (const vp of [{ width: 390, height: 844, mobile: true }, { width: 1280, height: 900, mobile: false }]) {
    const page = await browser.newPage({ ...vp, reducedMotion: true });
    const off = browser.conn.on(message => {
      if (message.sessionId !== page.sid || message.method !== "Fetch.requestPaused") return;
      const { requestId, request } = message.params;
      const url = new URL(request.url);
      const allowed = url.origin === base || ["data:", "blob:", "about:"].includes(url.protocol);
      if (!allowed) report.blockedBrowserRequests++;
      if (allowed && url.pathname === "/api/orders" && request.method === "POST") report.orderRequests++;
      page.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" })
        .catch(() => { /* target closing; final assertions still require no blocked egress */ });
    });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    if (mutate) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const remove = () => document.documentElement?.removeAttribute('data-runtime-mode');
      new MutationObserver(remove).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-runtime-mode'] }); remove();
    })();` });
    try {
      await page.goto(`${base}/make`);
      check(`${vp.width}.html.runtime`, await page.eval(`document.documentElement.dataset.runtimeMode`) === (mutate ? undefined : mode));
      await page.eval(`localStorage.clear(); localStorage.setItem('ticketstub.wall.v1', ${JSON.stringify(JSON.stringify([fixture()]))});`);
      await page.goto(`${base}/checkout/${ID}`);
      for (const [key, material] of [["digital", "digital"], ["card", "card"], ["print", "print"], ["framed", "framed"], ["return-digital", "digital"]]) {
        const selector = `document.querySelector('[aria-label="Material"] [data-value="${material}"]')`;
        await within(nativeClick(page, selector, vp.mobile), "material click");
        if (!await page.waitFor(`(${selector})?.getAttribute('aria-checked') === 'true'`)) throw new Error("Material selection did not change");
        const state = await controls(page, true);
        const disabled = mode === "live" && material !== "digital";
        check(`${vp.width}.checkout.${key}.gate`, state.payDisabled === disabled && state.addDisabled === disabled, state);
        if (disabled) {
          check(`${vp.width}.checkout.${key}.explanation`, state.previewMessage);
          // Never click a mistakenly enabled Pay button, including in the deliberate negative control.
          if (state.payDisabled && state.addDisabled) {
            await within(nativeClick(page, payExpression, vp.mobile), "disabled pay click");
            await within(nativeClick(page, addExpression, vp.mobile), "disabled cart click");
            const after = await controls(page, true);
            check(`${vp.width}.checkout.${key}.inert`, after.cart === state.cart && after.orders === state.orders && report.orderRequests === 0);
          } else check(`${vp.width}.checkout.${key}.inert`, false, "controls-not-disabled; no payment clicked");
        } else {
          await within(nativeClick(page, addExpression, vp.mobile), "add to cart");
          const added = await page.waitFor(`JSON.parse(localStorage.getItem('ticketstub.cart.v1') || '[]').some(x => x.material === '${material}')`);
          check(`${vp.width}.checkout.${key}.adds`, added);
          await page.eval(`localStorage.removeItem('ticketstub.cart.v1'); window.dispatchEvent(new Event('ticketstub:cart'));`);
        }
      }
      // Unavailable physical holographic stock remains blocked in BOTH modes.
      await page.eval(`localStorage.setItem('ticketstub.wall.v1', ${JSON.stringify(JSON.stringify([fixture("card", "holo")]))});`);
      await page.goto(`${base}/checkout/${ID}`);
      const holo = await controls(page, true);
      check(`${vp.width}.checkout.holo.blocked`, holo.payDisabled && holo.addDisabled, holo);
      await page.screenshot(join(out, `${mode}-${vp.width}-checkout-holo.png`));
      for (const material of ["card", "print", "framed", "digital", "stale-digital"]) {
        const stale = material === "stale-digital", actualMaterial = stale ? "digital" : material;
        const item = { id: `cart-${material}`, stubId: ID, title: "Synthetic runtime gate", material: actualMaterial, finish: "matte",
          size: actualMaterial === "digital" ? "file" : actualMaterial === "framed" ? "framed" : "stamp", unitMinor: 900,
          capabilityVersion: stale ? "synthetic-stale-version" : capability, seats: [], addedAt: "2026-10-12T00:00:00.000Z" };
        await page.eval(`localStorage.setItem('ticketstub.cart.v1', ${JSON.stringify(JSON.stringify([item]))});`);
        await page.goto(`${base}/cart`);
        const state = await controls(page, false);
        const disabled = stale || (mode === "live" && actualMaterial !== "digital");
        check(`${vp.width}.cart.${material}.gate`, state.payDisabled === disabled, state);
        if (disabled) {
          if (state.payDisabled) {
            await within(nativeClick(page, payExpression, vp.mobile), "disabled cart pay click");
            const after = await controls(page, false);
            check(`${vp.width}.cart.${material}.inert`, after.cart === state.cart && after.orders === state.orders && report.orderRequests === 0);
          } else check(`${vp.width}.cart.${material}.inert`, false, "control-not-disabled; no payment clicked");
        }
        // A real reload reads the same persisted selection and must retain its gate.
        await page.goto(`${base}/cart`);
        check(`${vp.width}.cart.${material}.reload`, (await controls(page, false)).payDisabled === disabled);
      }
      check(`${vp.width}.browser.no-exceptions`, page.consoleErrors.length === 0, page.consoleErrors);
      report.completedViewports.push(vp.width);
    } finally { off(); await page.close(); }
  }
  if (mode === "live") {
    // Direct forged browser claims cannot turn a preview into a server-accepted physical order.
    for (const material of ["card", "print", "framed"]) {
      const response = await fetch(`${base}/api/orders`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ order: { stubIds: [ID],
          lines: [{ title: "Synthetic runtime gate", material, finish: "matte", size: material === "framed" ? "framed" : "stamp", totalMinor: 900, variantStatus: "orderable" }],
          totalMinor: 900, currency: "USD", method: "card", mode: "demo" } }) });
      const body = await response.json();
      check(`server.${material}.forged-preview-denied`, response.status === 422 && body.error?.code === "variant_not_orderable", { status: response.status, code: body.error?.code });
    }
  }
} catch (error) {
  check("runner.completed", false, error instanceof Error ? error.message : String(error));
} finally {
  if (browser) await within(browser.close(), "browser shutdown", 15_000).catch(error => check("browser.shutdown", false, error.message));
  const exited = new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null || spawnError) resolve(); else child.once("exit", resolve); });
  child.kill("SIGTERM");
  await within(exited, "server shutdown", 10_000).catch(() => child.kill("SIGKILL"));
  child.stdout.destroy(); child.stderr.destroy();
  report.serverGuardAttempts = readFileSync(netLog, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
  check("matrix.all-viewports-completed", JSON.stringify(report.completedViewports) === "[390,1280]", report.completedViewports);
  check("network.browser.no-egress", report.blockedBrowserRequests === 0, report.blockedBrowserRequests);
  check("network.server.no-egress", report.serverGuardAttempts === 0, report.serverGuardAttempts);
  check("browser.no-order-submissions", report.orderRequests === 0, report.orderRequests);
  report.passed = report.checks.filter(check => check.ok).length;
  report.failed = report.checks.filter(check => !check.ok).length;
  report.skipped = 0;
  writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(out, "server.log"), serverLog);
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`runtime-order-gates: ${report.passed} passed, ${report.failed} failed, 0 skipped`);
process.exit(report.failed ? 1 : 0);
