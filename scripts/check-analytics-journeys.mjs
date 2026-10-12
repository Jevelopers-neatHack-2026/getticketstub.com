// Analytics customer journeys in a real headless Chrome, against the production build, offline.
//   npm run build && node scripts/check-analytics-journeys.mjs
// Starts `next start` on a free loopback port with a synthetic preview configuration (G-TEST000000, never a real
// property), sandbox mail and a throwaway database and files folder. Chrome resolves loopback only (scripts/lib/cdp.mjs);
// the gtag.js request is answered locally with an empty stub (or failed, to play an ad blocker), so nothing reaches
// Google and no paid provider is called (demo runtime). Events are read from window.dataLayer, which is exactly what the
// GA tag would read. Every journey runs twice, at a phone (390 x 844, touch emulation) and a desktop (1280 x 900) size,
// through the rendered UI: controls get real pointer clicks only when visible and uncovered (any programmatic fallback
// is printed), fields get keystrokes, files go through the file inputs. This is analytics coverage at emulated sizes,
// not a visual or mobile-usability check. Warm in-app navigations are mixed with hard loads:
//   consent   no tag before a choice; "No thanks" persists across navigation and reload; reopen and Allow; withdrawal
//             stops events at once and after reload; a blocked tag leaves every flow working and sends nothing
//   creation  empty and link intake (demo_only), demo intake -> reveal -> creation_complete -> studio, each once, in order
//   studio    flip, style (dots on the phone, rail and keyboard on desktop), stock and finish, a fixture remix, the
//             agent (suggestion, typed question), tear started/backed out, then torn -> exactly one tear_complete -> wall
//   search    one settled search per query (typed key by key), zero results, result selection, reopened stub
//   sharing   wall lamp open (pointer), encoded share landing (visitor), invalid and public-wall landings, gift unwrap,
//             server share snapshot, owner landing, native share success and cancel, story download started
//   claims    friends add/mode/invite copy/set to cart, set claim (missing name, sign-in choice, sandbox link, claimed),
//             missing guest claim link
//   commerce  checkout begin/options/add to cart, sandbox pay with no email (local) and with email (server receipt),
//             cart view/remove, quote expiry/refusal/refresh, wallet tab/simulated add, gift options/invalid/prepared
//   organizer design/lock, CSV import from a file, auto and manual mapping, check, contact sheet, publish one link,
//             link copy, sandbox print run, attendee claim with a photo
//   entry     landing-page search link, sidebar navigation
// Throughout: seeded private values (names, emails, notes, CSV cells/headers, file names, tokens, queries) must never
// appear in the dataLayer or in any request that leaves loopback; every event carries the route template of the latest
// page view; no purchase, refund, login or sign_up; sandbox and simulated outcomes are labelled as such.
// Exits nonzero on any failure, a missing Chrome or a missing build.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./lib/cdp.mjs";

const root = new URL("..", import.meta.url).pathname;
if (!existsSync(join(root, ".next/BUILD_ID"))) {
  console.error("FAIL no production build: run `npm run build` first");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const MEASUREMENT_ID = "G-TEST000000";
/** Private values typed, uploaded or put in addresses. All start with "zq" so one case-insensitive sweep finds any leak. */
const SEED = {
  token: "ZQTOKEN7f3a9c",
  link: "https://zqtickets.example/event/zq-private-order-991",
  query: "zqquery nobody",
  friend: "Zqfriend Ravi",
  claimer: "Zqclaim Jane",
  email: "zq.jane.doe@example.test",
  giftTo: "Zqgift Priya",
  note: "zqnote we got engaged here",
  orgName: "Zqorg Holdings",
  csvHeader: "zqcol_fullname",
  csvA: "Zqguest Alpha",
  csvB: "Zqguest Beta",
  csvC: "Zqguest Gamma",
  csvFile: "zqguests-of-jane.csv",
  photoFile: "zqphoto-of-jane.png",
};
const LEAK = /zq/i;

let failed = 0;
let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else {
    failed++;
    failures.push(name);
  }
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` :: ${String(detail).slice(0, 600)}`}`);
  return ok;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "ticketstub-analytics-journeys-"));
const csvPath = join(dataDir, SEED.csvFile);
writeFileSync(csvPath, `${SEED.csvHeader},seat,team\n${SEED.csvA},A1,Zqteam\n${SEED.csvB},A2,Zqteam\n,A3,Zqteam\n"${SEED.csvC}",A4,Zqteam\n`);
const photoPath = join(dataDir, SEED.photoFile);
// a 1 x 1 PNG
writeFileSync(photoPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    TICKETSTUB_OPS_TELEMETRY: "off",
    NODE_ENV: "production",
    TICKETSTUB_ANALYTICS_ENV: "preview",
    TICKETSTUB_GA_MEASUREMENT_ID: MEASUREMENT_ID,
    TICKETSTUB_ANALYTICS_DISABLED: "",
    TICKETSTUB_GA_DEBUG: "",
    TICKETSTUB_RUNTIME_MODE: "demo",
    TICKETSTUB_SANDBOX_MAIL: "1",
    TICKETSTUB_DB: join(dataDir, "ticketstub.sqlite"),
    TICKETSTUB_FILES: join(dataDir, "files"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 150 && !/Ready|started server/i.test(log); i++) await sleep(200);

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1280, height: 900, mobile: false },
];

// A watchdog: a stuck page or server fails the run (and frees the port and the profile) instead of hanging CI.
const WATCHDOG_MS = Number(process.env.JOURNEYS_TIMEOUT_MS || 8 * 60_000);
let browser = null;
const watchdog = setTimeout(async () => {
  console.log(`FAIL watchdog: the run took longer than ${WATCHDOG_MS} ms`);
  try {
    await browser?.close();
  } catch {
    /* gone */
  }
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}, WATCHDOG_MS);

browser = await launchBrowser();
try {
  await browser.conn.send("Browser.grantPermissions", { origin: base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await browser.conn.send("Browser.setDownloadBehavior", { behavior: "deny" });
  for (const vp of VIEWPORTS) await runViewport(vp);
} catch (e) {
  check("run", false, e.stack);
} finally {
  clearTimeout(watchdog);
  await browser.close();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`failed: ${failures.join(" | ")}`);
process.exit(failed ? 1 : 0);

async function runViewport(vp) {
  const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
  const T = (s) => `[${vp.name}] ${s}`;
  await page.send("Storage.clearDataForOrigin", { origin: base, storageTypes: "all" });

  /* ---- the network: the tag is stubbed (or blocked); anything else leaving loopback is recorded ---- */
  let tagMode = "stub";
  const tagRequests = [];
  const outbound = [];
  page.conn.on((m) => {
    if (m.sessionId !== page.sid) return;
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params.request.url;
      if (!/^(https?:\/\/(127\.0\.0\.1|localhost)[:/]|data:|blob:|about:|chrome)/.test(u)) outbound.push({ url: u, body: m.params.request.postData ?? "" });
    }
    if (m.method !== "Fetch.requestPaused") return;
    tagRequests.push(m.params.request.url);
    if (tagMode === "block") page.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "BlockedByClient" });
    else
      page.send("Fetch.fulfillRequest", {
        requestId: m.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "text/javascript" }],
        body: Buffer.from("/* offline stub of gtag.js */").toString("base64"),
      });
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*googletagmanager.com*" }, { urlPattern: "*google-analytics.com*" }, { urlPattern: "*doubleclick.net*" }] });

  /* ---- reading what the tag would read, across hard loads ---- */
  const archive = []; // dataLayer entries from documents we navigated away from
  const raw = async () => {
    try {
      return JSON.parse(await page.eval("JSON.stringify((window.dataLayer || []).map((a) => Array.from(a)))"));
    } catch {
      return [];
    }
  };
  const events = async () => (await raw()).filter((a) => a[0] === "event").map((a) => ({ name: a[1], p: a[2] ?? {} }));
  const allEntries = async () => [...archive, ...(await raw())];
  async function hard(path, settle = 1200) {
    archive.push(...(await raw()));
    await page.goto(`${base}${path}`, { settle });
  }
  const push = (path) => page.eval(`(() => { if (!window.next?.router?.push) return false; window.next.router.push(${JSON.stringify(path)}); return true; })()`);
  const at = (path, ms = 15000) => page.waitFor(`location.pathname === ${JSON.stringify(path)}`, ms);
  const atPrefix = (prefix, ms = 15000) => page.waitFor(`location.pathname.startsWith(${JSON.stringify(prefix)})`, ms);
  /** Events after a mark, optionally one name; waits until `pred` holds over them (or times out). */
  async function waitEvents(from, pred, ms = 8000) {
    const end = Date.now() + ms;
    let ev = (await events()).slice(from);
    while (!pred(ev) && Date.now() < end) {
      await sleep(150);
      ev = (await events()).slice(from);
    }
    return ev;
  }
  const mark = async () => (await events()).length;
  const named = (ev, name) => ev.filter((e) => e.name === name);
  const fmt = (ev) => ev.map((e) => `${e.name}${e.p.result ? `(${e.p.result})` : ""}@${e.p.route_template}`).join(", ");
  /** Pick the params a check is about, ignoring the runtime's own fields. */
  const pick = (p, keys) => Object.fromEntries(keys.map((k) => [k, p[k]]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* ---- driving the rendered UI ---- */
  const norm = "(s) => (s || '').replace(/\\s+/g, ' ').trim()";
  /**
   * Press a control the way a person does: the first matching element that is visible and not covered, scrolled into
   * view, gets a real pointer click at its centre (Input.dispatchMouseEvent; a touch-emulated tap on the phone size).
   * Only when no match is visible and hit-testable does it fall back to element.click(), and every fallback is
   * recorded (`fallbacks`) and printed at the end, so the coverage is never mistaken for visual usability.
   */
  async function press(selector, text = null, { exact = false, strict = false } = {}) {
    const r = await page.eval(`(() => {
      const n = ${norm};
      const want = ${JSON.stringify(text)};
      const all = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => want === null || (${JSON.stringify(exact)} ? n(e.textContent) === want : n(e.textContent).startsWith(want)));
      if (!all.length) return { found: false };
      // a disabled control can't be pressed by anyone: report it as not found rather than "press" it
      if (all.every((e) => e.disabled)) return { found: false, why: "disabled" };
      let why = "not visible";
      const usable = (e) => {
        if (e.disabled || e.closest("[inert]")) return false;
        const st = getComputedStyle(e);
        if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
        e.scrollIntoView({ block: "center", inline: "center" });
        const b = e.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return false;
        const x = b.x + b.width / 2, y = b.y + b.height / 2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === e || e.contains(hit))) {
          document.querySelectorAll("[data-journey-target]").forEach((o) => o.removeAttribute("data-journey-target"));
          e.setAttribute("data-journey-target", "");
          return { x, y };
        }
        why = "covered by " + (hit ? hit.tagName.toLowerCase() + "." + String(hit.className).slice(0, 60) : "nothing") + " at " + Math.round(x) + "," + Math.round(y);
        return false;
      };
      for (const e of all) {
        const at = usable(e);
        if (at) return { found: true, real: true, ...at };
      }
      if (${JSON.stringify(strict)}) return { found: true, real: false, refused: true, why };
      all[0].click();
      return { found: true, real: false };
    })()`);
    if (!r?.found) {
      if (r?.why) console.log(`info [${vp.name}] not pressed (${r.why}): ${selector}${text !== null ? ` "${text}"` : ""}`);
      return false;
    }
    if (r.real) {
      // let scrolling and any entrance animation settle, then measure and hit-test the same element again
      await sleep(150);
      const at = await page.eval(`(() => { const e = document.querySelector("[data-journey-target]"); if (!e) return null; const b = e.getBoundingClientRect(); const x = b.x + b.width / 2, y = b.y + b.height / 2; const hit = document.elementFromPoint(x, y); e.removeAttribute("data-journey-target"); return hit && (hit === e || e.contains(hit)) ? { x, y } : null; })()`);
      if (!at) {
        console.log(`info [${vp.name}] the control moved or was covered before the click: ${selector}${text !== null ? ` "${text}"` : ""}`);
        return false;
      }
      await page.click(at.x, at.y);
      realClicks++;
      return true;
    }
    if (r.refused) {
      console.log(`info [${vp.name}] refused, not a usable control (${r.why}): ${selector}${text !== null ? ` "${text}"` : ""}`);
      return false;
    }
    fallbacks.add(`${selector}${text !== null ? ` "${text}"` : ""}`);
    return true;
  }
  const clickText = (selector, text, opts) => press(selector, text, opts);
  const clickSel = (selector, opts) => press(selector, null, opts);
  /** A control that must be pressed as a visible, uncovered control (no programmatic fallback). */
  const tap = (selector, text = null, opts = {}) => press(selector, text, { ...opts, strict: true });
  const mouse = (selector) => tap(selector);
  /** Focus a field, select what is there and type over it, as a person would. */
  async function typeInto(selector, text, { keys = false } = {}) {
    const ok = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.select?.(); return true; })()`);
    if (!ok) return false;
    if (keys) for (const ch of text) await page.type(ch);
    else await page.type(text);
    return true;
  }
  async function setFiles(selector, files) {
    const r = await page.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!r.result?.objectId) return false;
    await page.send("DOM.setFileInputFiles", { files, objectId: r.result.objectId });
    return true;
  }
  const value = (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
  const exists = (selector) => page.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
  const allow = () => clickText("button", "Allow analytics");
  let realClicks = 0;
  const fallbacks = new Set();

  /* ================= consent, withdrawal and a blocked tag ================= */

  await hard(`/make?from=${SEED.token}&q=${encodeURIComponent(SEED.query)}`);
  check(T("consent: the choice card is shown on a first visit"), await page.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Allow analytics")`));
  check(T("consent: no tag request and no events before a choice"), tagRequests.length === 0 && (await events()).length === 0, tagRequests.join(","));
  check(T("consent: No thanks"), await clickText("button", "No thanks"));
  await push("/wall");
  await at("/wall");
  await sleep(1200);
  await hard("/make");
  check(T("consent: denial holds across an in-app navigation and a reload (no tag, no events)"), tagRequests.length === 0 && (await events()).length === 0, `${tagRequests.length} tag, ${(await events()).length} events`);
  check(T("consent: reopen the choices from the Analytics tag"), await clickSel('button[aria-label^="Analytics choices"]'));
  check(T("consent: Allow after a denial"), await page.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Allow analytics")`) && (await allow()));
  let ev = await waitEvents(0, (e) => named(e, "page_view").length > 0);
  check(T("consent: one tag request after Allow, for the synthetic id only"), tagRequests.length === 1 && tagRequests[0].includes(`id=${MEASUREMENT_ID}`), tagRequests.join(","));
  check(T("consent: the current page is viewed once, sanitized (/make, no query)"), named(ev, "page_view").length === 1 && ev[0].p.page_location === `${base}/make`, fmt(ev));
  // withdrawal
  check(T("withdraw: reopen and Turn off analytics"), (await clickSel('button[aria-label^="Analytics choices"]')) && (await page.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Turn off analytics")`)) && (await clickText("button", "Turn off analytics")));
  await sleep(300);
  const afterOff = (await raw()).length;
  const lastConsent = (await raw()).filter((a) => a[0] === "consent").pop();
  check(T("withdraw: the tag is told analytics_storage=denied and disabled"), lastConsent?.[1] === "update" && lastConsent?.[2]?.analytics_storage === "denied" && (await page.eval(`window["ga-disable-${MEASUREMENT_ID}"] === true`)), JSON.stringify(lastConsent));
  await push("/search");
  await at("/search");
  await typeInto('input[type="search"]', "pale");
  await sleep(1500);
  check(T("withdraw: in-app navigation and a search add nothing to the dataLayer"), (await raw()).length === afterOff, `${(await raw()).length} vs ${afterOff}`);
  const tagsBefore = tagRequests.length;
  await hard("/wall");
  check(T("withdraw: after a reload, no tag request and no events"), tagRequests.length === tagsBefore && (await events()).length === 0);

  // a blocked tag (an ad blocker): every flow still works and nothing is sent
  await page.send("Storage.clearDataForOrigin", { origin: base, storageTypes: "all" });
  tagMode = "block";
  await hard("/make");
  check(T("blocker: Allow with the tag blocked"), await allow());
  await sleep(800);
  check(T("blocker: the blocked tag fails closed (disabled, no events in the dataLayer)"), (await page.eval(`window["ga-disable-${MEASUREMENT_ID}"] === true`)) && (await events()).length === 0, fmt(await events()));
  check(T("blocker: a demo print still works"), await clickText("button", "The Pale Hours"));
  check(T("blocker: the studio opens"), await at("/studio/demo-pale", 30000), await page.eval("location.pathname"));
  await sleep(1000);
  check(T("blocker: still nothing in the dataLayer after a whole creation"), (await events()).length === 0, fmt(await events()));
  check(T("blocker: no page errors"), page.consoleErrors.length === 0, page.consoleErrors.join(" | "));
  tagMode = "stub";
  await page.send("Storage.clearDataForOrigin", { origin: base, storageTypes: "all" });

  /* ================= creation, from the start section, with a fresh grant ================= */

  await hard("/make");
  check(T("creation: Allow"), await allow());
  await waitEvents(0, (e) => named(e, "page_view").length > 0);
  // an empty submit, then a pasted link this demo runtime can't research (no provider is called)
  let from = await mark();
  await clickText("button", "Make my stub");
  ev = await waitEvents(from, (e) => named(e, "intake_invalid").length > 0, 3000);
  check(T("intake: an empty submit is intake_invalid(empty)"), same(named(ev, "intake_invalid").map((e) => pick(e.p, ["entry", "reason"])), [{ entry: "make", reason: "empty" }]), fmt(ev));
  from = await mark();
  await typeInto('input[inputmode="url"]', SEED.link);
  await clickText("button", "Make my stub");
  ev = await waitEvents(from, (e) => named(e, "creation_error").length > 0, 20000);
  const research = named(ev, "research_complete")[0]?.p ?? {};
  check(T("intake: a link is accepted, starts a creation, research is refused as demo_only (the demo runtime fetches nothing), and the creation errors (no completion)"), same(pick(named(ev, "intake_submit")[0]?.p ?? {}, ["input_source", "result"]), { input_source: "link", result: "accepted" }) && named(ev, "creation_start").length === 1 && research.result === "error" && research.error_code === "demo_only" && named(ev, "creation_error").length === 1 && named(ev, "creation_complete").length === 0, fmt(ev) + JSON.stringify(research));
  check(T("intake: the field is back with the problem, on /make"), (await page.eval("location.pathname")) === "/make" && (await exists('input[inputmode="url"]')));
  from = await mark();
  check(T("creation: choose the Pale Hours demo"), await clickText("button", "The Pale Hours"));
  check(T("creation: the studio opens"), await at("/studio/demo-pale", 30000));
  ev = await waitEvents(from, (e) => named(e, "studio_open").length > 0, 10000);
  const flowNames = ["intake_submit", "creation_start", "reveal_complete", "creation_complete", "page_view", "studio_open"];
  const order = flowNames.map((n) => ev.findIndex((e) => e.name === n));
  check(T("creation: intake -> start -> reveal -> complete -> page_view -> studio_open, each once, in order"), flowNames.every((n) => named(ev, n).length === 1) && order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), fmt(ev));
  const intake = named(ev, "intake_submit")[0]?.p ?? {};
  const created = named(ev, "creation_complete")[0]?.p ?? {};
  check(T("creation: demo intake on /make, created and stored, studio ready"), same(pick(intake, ["entry", "input_source", "result"]), { entry: "make", input_source: "demo", result: "accepted" }) && same(pick(created, ["entry", "input_source", "result", "storage"]), { entry: "make", input_source: "demo", result: "created", storage: "ok" }) && named(ev, "studio_open")[0]?.p.status === "ready", fmt(ev));
  check(T("creation: no research request for a handed-in demo (no research_complete)"), named(ev, "research_complete").length === 0);
  check(T("creation: studio events stamped /studio/:id"), named(ev, "studio_open").every((e) => e.p.route_template === "/studio/:id" && e.p.page_location === `${base}/studio/:id`), fmt(ev));
  // a committed studio edit from the rendered UI: the Flip tool
  from = await mark();
  check(T("studio: Flip"), await clickText("button", "Flip"));
  ev = await waitEvents(from, (e) => named(e, "studio_flip").length > 0, 3000);
  check(T("studio: one studio_flip(button)"), named(ev, "studio_flip").length === 1 && named(ev, "studio_flip")[0].p.method === "button", fmt(ev));

  // committed edits through visible controls: the style dots (phone) or the styles rail (desktop), the keyboard (desktop),
  // the stock and the finish. Each must be exactly one studio_edit, named by what changed, stored.
  from = await mark();
  const styleControl = vp.mobile ? '[role="group"][aria-label="Styles"] button[aria-label="Minimal style"]' : 'aside[aria-label="Styles"] button[data-edition="minimal"]';
  check(T("studio: pick the Minimal style from a visible control"), await tap(styleControl));
  ev = await waitEvents(from, (e) => named(e, "studio_edit").length > 0, 3000);
  await sleep(400);
  ev = (await events()).slice(from);
  check(T(`studio: one studio_edit(edition=minimal, method=${vp.mobile ? "dots" : "rail"}, stored)`), same(named(ev, "studio_edit").map((e) => pick(e.p, ["change", "method", "edition", "storage"])), [{ change: "edition", method: vp.mobile ? "dots" : "rail", edition: "minimal", storage: "ok" }]), fmt(ev));
  if (!vp.mobile) {
    from = await mark();
    await page.eval("document.activeElement?.blur()");
    await page.key("ArrowRight");
    ev = await waitEvents(from, (e) => named(e, "studio_edit").length > 0, 3000);
    await sleep(400);
    ev = (await events()).slice(from);
    check(T("studio: ArrowRight deals the next style: one studio_edit(edition, keyboard)"), same(named(ev, "studio_edit").map((e) => pick(e.p, ["change", "method"])), [{ change: "edition", method: "keyboard" }]), fmt(ev));
  }
  from = await mark();
  check(T("studio: choose the Framed stock from the visible picker"), await tap('[role="radiogroup"][aria-label="Material"] [data-value="framed"]'));
  ev = await waitEvents(from, (e) => named(e, "studio_edit").length > 0, 3000);
  check(T("studio: one studio_edit(material=framed, stored)"), same(named(ev, "studio_edit").map((e) => pick(e.p, ["change", "material", "storage"])), [{ change: "material", material: "framed", storage: "ok" }]), fmt(ev));
  from = await mark();
  // Matte, not Holo: Holo is a screen effect that is never printed, so it would (truthfully) block the checkout later on
  check(T("studio: choose the Matte finish"), await tap('[role="radiogroup"][aria-label="Finish"] [role="radio"]', "Matte"));
  ev = await waitEvents(from, (e) => named(e, "studio_edit").length > 0, 3000);
  check(T("studio: one studio_edit(finish=matte, stored)"), same(named(ev, "studio_edit").map((e) => pick(e.p, ["change", "finish", "storage"])), [{ change: "finish", finish: "matte", storage: "ok" }]), fmt(ev));
  // remix from the sheet (the demo runtime's art is procedural and labelled simulated: no provider is called)
  from = await mark();
  check(T("remix: open the Remix sheet from the tools"), await tap('[role="toolbar"] button', "Remix", { exact: true }));
  await page.waitFor(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === "Neon")`);
  await sleep(900);
  check(T("remix: pick Neon, then Remix the art"), (await tap('[role="dialog"] button', "Neon", { exact: true })) && (await tap('[role="dialog"] button', "Remix the art")));
  ev = await waitEvents(from, (e) => named(e, "remix_result").length > 0, 10000);
  await sleep(400);
  ev = (await events()).slice(from);
  check(T("remix: studio_panel(remix), one remix_request(sheet, neon), one remix_result(success, procedural, simulated)"), named(ev, "studio_panel").some((e) => e.p.panel === "remix" && e.p.open === true) && same(named(ev, "remix_request").map((e) => pick(e.p, ["via", "vibe"])), [{ via: "sheet", vibe: "neon" }]) && same(named(ev, "remix_result").map((e) => pick(e.p, ["via", "result", "art", "capability"])), [{ via: "sheet", result: "success", art: "procedural", capability: "simulated" }]) && typeof named(ev, "remix_result")[0]?.p.duration_ms === "number", fmt(ev) + JSON.stringify(named(ev, "studio_panel").map((e) => e.p.panel)) + JSON.stringify(named(ev, "remix_result").map((e) => pick(e.p, ["via", "result", "art", "capability"]))));
  check(T("remix: new art is not counted a second time as a studio_edit"), named(ev, "studio_edit").length === 0, fmt(ev));
  await page.waitFor(`!document.querySelector('[role="dialog"]')`, 3000);
  // the agent, from the tools: a suggestion and a typed question (the words are never sent)
  from = await mark();
  check(T("agent: open Ask from the tools"), await tap('[role="toolbar"] button', "Ask", { exact: true }));
  await page.waitFor(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === "Add the weather")`);
  await sleep(900); // the sheet slides and fades in; a person taps once it has arrived
  check(T("agent: the Add the weather suggestion"), await tap('[role="dialog"] button', "Add the weather", { exact: true }));
  ev = await waitEvents(from, (e) => named(e, "agent_message").length > 0, 5000);
  const weather = named(ev, "agent_message")[0]?.p ?? {};
  check(T("agent: agent_open(button), agent_suggestion(weather), one agent_message(weather) answered by rules or pending"), same(named(ev, "agent_open").map((e) => e.p.via), ["button"]) && same(named(ev, "agent_suggestion").map((e) => e.p.suggestion), ["weather"]) && named(ev, "agent_message").length === 1 && weather.intent === "weather" && ["rules", "pending"].includes(weather.result), fmt(ev));
  from = await mark();
  await typeInto('[role="dialog"] form input', "zq when did my friend Ravi arrive?");
  check(T("agent: Send the typed question"), await tap('[role="dialog"] form button[type="submit"]', "Send", { exact: true }));
  ev = await waitEvents(from, (e) => named(e, "agent_message").length > 0, 8000);
  check(T("agent: a typed question is one agent_message(question, rules): the demo runtime has no model (204)"), same(named(ev, "agent_message").map((e) => pick(e.p, ["intent", "result"])), [{ intent: "question", result: "rules" }]), fmt(ev));
  await page.key("Escape");
  await page.waitFor(`!document.querySelector('[role="dialog"]')`, 3000);
  // the tear: start and back out, then start and finish it (phone: "tear it off for me"; desktop: Enter on the handle)
  from = await mark();
  check(T("tear: Tear off and pin to your wall"), await tap("button", "Tear off and pin to your wall"));
  await page.waitFor(`document.querySelector('[role="dialog"] [role="slider"]')`);
  check(T("tear: Back to styling"), await tap('[role="dialog"] button', "Back to styling"));
  await page.waitFor(`!document.querySelector('[role="slider"]')`, 3000);
  ev = (await events()).slice(from);
  check(T("tear: one tear_start and one tear_cancel, nothing torn"), named(ev, "tear_start").length === 1 && named(ev, "tear_cancel").length === 1 && named(ev, "tear_complete").length === 0, fmt(ev));
  from = await mark();
  check(T("tear: start again"), await tap("button", "Tear off and pin to your wall"));
  await page.waitFor(`document.querySelector('[role="dialog"] [role="slider"]')`);
  await sleep(300);
  if (vp.mobile) check(T("tear: Or tear it off for me"), await tap('[role="dialog"] button', "Or tear it off for me"));
  else {
    check(T("tear: the handle has focus"), await page.waitFor(`document.activeElement?.getAttribute("role") === "slider"`, 3000));
    await page.key("Enter");
  }
  check(T("tear: the wall takes over"), await at("/wall", 10000));
  ev = await waitEvents(from, (e) => named(e, "wall_view").length > 0, 6000);
  await sleep(500);
  ev = (await events()).slice(from);
  const tearMethod = vp.mobile ? "auto" : "keyboard";
  check(T(`tear: exactly one tear_complete(${tearMethod}, stored), then page_view /wall, then wall_view`), same(named(ev, "tear_complete").map((e) => pick(e.p, ["method", "storage", "route_template"])), [{ method: tearMethod, storage: "ok", route_template: "/studio/:id" }]) && ev.findIndex((e) => e.name === "tear_complete") < ev.findIndex((e) => e.name === "page_view" && e.p.route_template === "/wall") && ev.findIndex((e) => e.name === "page_view" && e.p.route_template === "/wall") < ev.findIndex((e) => e.name === "wall_view"), fmt(ev));
  // the tear lands on /wall?pinned=<id> and the wall then replaces it with /wall: the runtime counts that as one visit
  check(T("tear: exactly one page_view for /wall (the transient ?pinned address is not a second visit)"), named(ev, "page_view").filter((e) => e.p.route_template === "/wall").length === 1, fmt(ev));
  check(T("tear: the stub is torn on the device"), await page.eval(`JSON.parse(localStorage.getItem("ticketstub.wall.v1") || "[]").some((s) => s.id === "demo-pale" && s.torn === true)`));

  /* ================= search ================= */

  from = await mark();
  await push("/search");
  await at("/search");
  await sleep(1200);
  const typedFrom = await mark();
  await typeInto('input[type="search"]', SEED.query, { keys: true });
  ev = await waitEvents(typedFrom, (e) => named(e, "search_results").length > 0, 4000);
  await sleep(800);
  ev = (await events()).slice(typedFrom);
  check(T("search: typing key by key settles into one search_results"), named(ev, "search_results").length === 1, fmt(ev));
  check(T("search: an unknown show is zero results, typed text"), same(pick(named(ev, "search_results")[0]?.p ?? {}, ["result", "result_count", "query_kind"]), { result: "zero", result_count: 0, query_kind: "text" }), JSON.stringify(named(ev, "search_results")[0]?.p));
  from = await mark();
  await typeInto('input[type="search"]', "Pale");
  ev = await waitEvents(from, (e) => named(e, "search_results").length > 0, 4000);
  check(T("search: a known show has results"), named(ev, "search_results")[0]?.p.result === "results" && named(ev, "search_results")[0]?.p.result_count >= 1, fmt(ev));
  from = await mark();
  check(T("search: open the first result"), await page.waitFor(`document.querySelector('ul[class*="results"] button')`) && (await clickSel('ul[class*="results"] button')));
  check(T("search: the stub already on the wall reopens in the studio"), await at("/studio/demo-pale", 20000));
  ev = await waitEvents(from, (e) => named(e, "studio_open").length > 0, 8000);
  const sel = named(ev, "select_item")[0]?.p ?? {};
  check(T("search: select_item is rank 1 of the results, a demo"), same(pick(sel, ["item_list_id", "index", "demo"]), { item_list_id: "search_results", index: 1, demo: true }), JSON.stringify(sel));
  check(T("search: /new reports the intake as reopened, not created"), named(ev, "intake_submit")[0]?.p.result === "reopened" && named(ev, "creation_complete").length === 0, fmt(ev));

  /* ================= sharing and landings ================= */

  await push("/wall");
  await at("/wall");
  await page.waitFor(`document.querySelector('[data-stub-id="demo-pale"]')`);
  await sleep(800);
  from = await mark();
  check(T("wall: lift the stub with a pointer"), await mouse('[data-stub-id="demo-pale"]'));
  ev = await waitEvents(from, (e) => named(e, "wall_stub_open").length > 0, 3000);
  check(T("wall: one wall_stub_open(pointer)"), named(ev, "wall_stub_open").length === 1 && named(ev, "wall_stub_open")[0].p.via === "pointer", fmt(ev));
  // the lamp's Share: a server snapshot (guest device), then the share sheet if the browser has one, else a copy
  await page.eval("(() => { try { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch {} })()");
  from = await mark();
  check(T("share: the lamp's Share"), await clickText('[role="dialog"] button', "Share"));
  ev = await waitEvents(from, (e) => named(e, "share").length > 0, 6000);
  check(T("share: the server kept a snapshot (server_save share saved)"), same(named(ev, "server_save").map((e) => pick(e.p, ["kind", "result"])), [{ kind: "share", result: "saved" }]), fmt(ev));
  check(T("share: one share by copy from the lamp, with an outcome"), named(ev, "share").length === 1 && same(pick(named(ev, "share")[0].p, ["method", "content_type", "context"]), { method: "copy", content_type: "stub", context: "lamp" }) && ["success", "failure"].includes(named(ev, "share")[0].p.result), fmt(ev));
  const copied = named(ev, "share")[0]?.p.result === "success" ? await page.eval("navigator.clipboard.readText().catch(() => '')") : "";
  const serverPath = /\/s\/[\w-]+$/.exec(copied ?? "")?.[0] ?? null;
  // the lamp's Page: the encoded link, read as a visitor would (an encoded link is never owned)
  from = await mark();
  check(T("share: the lamp's Page"), await clickText('[role="dialog"] button', "Page"));
  check(T("share: the memory page opens"), await atPrefix("/s/"));
  ev = await waitEvents(from, (e) => named(e, "share_landing").length > 0, 6000);
  const landing = named(ev, "share_landing")[0]?.p ?? {};
  check(T("landing: an encoded link is a valid visitor landing on /s/:token"), same(pick(landing, ["surface", "result", "viewer", "link_kind"]), { surface: "memory", result: "valid", viewer: "visitor", link_kind: "encoded" }) && landing.page_location === `${base}/s/:token`, JSON.stringify(landing));
  const encodedPath = await page.eval("location.pathname");
  // an invalid link
  from = await mark();
  await push(`/s/${SEED.token}?to=${encodeURIComponent(SEED.giftTo)}`);
  ev = await waitEvents(from, (e) => named(e, "share_landing").length > 0, 6000);
  check(T("landing: a broken link is an invalid landing, its token and query never sent"), same(pick(named(ev, "share_landing")[0]?.p ?? {}, ["surface", "result"]), { surface: "memory", result: "invalid" }) && named(ev, "share_landing")[0]?.p.page_location === `${base}/s/:token`, fmt(ev));
  // a missing public wall
  from = await mark();
  await push(`/u/${SEED.token}`);
  ev = await waitEvents(from, (e) => named(e, "share_landing").length > 0, 6000);
  check(T("landing: a missing public wall is not_found on /u/:token"), same(pick(named(ev, "share_landing")[0]?.p ?? {}, ["surface", "result", "viewer"]), { surface: "public_wall", result: "not_found", viewer: "visitor" }) && named(ev, "share_landing")[0]?.p.route_template === "/u/:token", fmt(ev));
  // the wrapped gift link, on a hard load
  await hard(`${encodedPath}?gift=1&to=${encodeURIComponent(SEED.giftTo)}`, 1500);
  ev = await waitEvents(0, (e) => named(e, "share_landing").length > 0, 6000);
  check(T("gift link: a gift landing, page_view first"), ev[0]?.name === "page_view" && named(ev, "share_landing")[0]?.p.surface === "gift", fmt(ev));
  check(T("gift link: Tear it open"), await clickText("button", "Tear it open"));
  ev = await waitEvents(0, (e) => named(e, "gift_unwrap").length > 0, 4000);
  check(T("gift link: one gift_unwrap once the wrap is off"), named(ev, "gift_unwrap").length === 1, fmt(ev));
  // the server snapshot, opened on the device that holds the stub: an owner landing with the owner's tools
  if (check(T("share: the copied link is a server snapshot"), !!serverPath, copied)) {
    await hard(serverPath, 1500);
    ev = await waitEvents(0, (e) => named(e, "share_landing").length > 0, 6000);
    check(T("landing: a server snapshot on its own device is an owner landing"), same(pick(named(ev, "share_landing")[0]?.p ?? {}, ["surface", "result", "viewer", "link_kind"]), { surface: "memory", result: "valid", viewer: "owner", link_kind: "server" }), fmt(ev));
    // the share sheet: success, then a closed sheet (a cancel, never a failure, and no copy)
    await page.eval("(() => { Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true }); })()");
    from = await mark();
    check(T("memory: Share your stub (sheet finishes)"), await clickText("button", "Share your stub"));
    ev = await waitEvents(from, (e) => named(e, "share").length > 0, 5000);
    check(T("memory: share native success"), same(named(ev, "share").map((e) => pick(e.p, ["method", "result", "context"])), [{ method: "native", result: "success", context: "memory" }]), fmt(ev));
    await page.eval("(() => { Object.defineProperty(navigator, 'share', { value: () => Promise.reject(new DOMException('closed', 'AbortError')), configurable: true }); })()");
    from = await mark();
    await clickText("button", "Share your stub");
    ev = await waitEvents(from, (e) => named(e, "share").length > 0, 5000);
    await sleep(500);
    ev = (await events()).slice(from);
    check(T("memory: a closed share sheet is one cancel, not a failure, and copies nothing"), same(named(ev, "share").map((e) => pick(e.p, ["method", "result"])), [{ method: "native", result: "cancel" }]), fmt(ev));
    from = await mark();
    check(T("memory: Story image"), await clickText("button", "Story image"));
    ev = await waitEvents(from, (e) => named(e, "story_export").length > 0, 8000);
    check(T("memory: story export is the image generated and a download started (downloads are denied in this run)"), same(named(ev, "story_export").map((e) => pick(e.p, ["action", "result"])), [{ action: "download", result: "generated" }]), fmt(ev));
  }

  /* ================= friends and claims ================= */

  await hard("/friends/demo-pale");
  from = await mark();
  check(T("friends: add a friend by name"), (await typeInto("#friend-name", SEED.friend)) && (await clickText('form button[type="submit"]', "Add")));
  ev = await waitEvents(from, (e) => named(e, "friends_update").length > 0, 3000);
  check(T("friends: one add, a count of 1, stored"), same(named(ev, "friends_update").map((e) => pick(e.p, ["action", "friend_count", "storage"])), [{ action: "add", friend_count: 1, storage: "ok" }]), fmt(ev));
  from = await mark();
  await clickSel('[role="radiogroup"][aria-label="How they get their stub"] [data-value="make"]');
  await clickSel('[role="radiogroup"][aria-label="How they get their stub"] [data-value="claim"]');
  ev = await waitEvents(from, (e) => named(e, "friends_update").length >= 2, 3000);
  check(T("friends: each mode change once"), same(named(ev, "friends_update").map((e) => e.p.mode), ["make", "claim"]) && named(ev, "friends_update").every((e) => e.p.action === "mode"), fmt(ev));
  await page.waitFor(`document.querySelector("input[readonly]")`);
  const claimUrl = await value("input[readonly]");
  from = await mark();
  check(T("friends: copy the claim link"), await clickText("button", "Copy link"));
  ev = await waitEvents(from, (e) => named(e, "share").length > 0, 3000);
  check(T("friends: one invite share by copy"), named(ev, "share").length === 1 && same(pick(named(ev, "share")[0].p, ["method", "content_type", "context", "result"]), { method: "copy", content_type: "invite", context: "friends", result: "success" }), fmt(ev));
  from = await mark();
  check(T("friends: add the set to the cart"), await clickText("button", "Add the set to your cart"));
  ev = await waitEvents(from, (e) => named(e, "add_to_cart").length > 0, 3000);
  const set = named(ev, "add_to_cart")[0]?.p ?? {};
  // the tag shapes GA's items array: the closed variant id and the seat count move into items[0]
  check(T("friends: add_to_cart is the 2-seat set, sandbox, a closed variant id in GA's items"), set.context === "friends" && set.capability === "sandbox" && set.items?.length === 1 && set.items[0].quantity === 2 && /^(digital|card|print|framed)_(matte|foil|holo)_(classic|stamp|framed|file)$/.test(set.items[0].item_id) && !("item_id" in set) && !("quantity" in set), JSON.stringify(set));
  // the set claim, from the copied link
  check(T("claim: the claim link points at /claim/"), typeof claimUrl === "string" && claimUrl.startsWith(`${base}/claim/`), claimUrl);
  await hard(claimUrl.slice(base.length), 1500);
  ev = await waitEvents(0, (e) => named(e, "claim_view").length > 0, 5000);
  check(T("claim: a valid set link, on /claim/:set with no query"), same(pick(named(ev, "claim_view")[0]?.p ?? {}, ["flow", "result"]), { flow: "set", result: "valid" }) && named(ev, "claim_view")[0]?.p.page_location === `${base}/claim/:set`, fmt(ev));
  from = await mark();
  await clickText('form button[type="submit"]', "Claim my stub");
  ev = await waitEvents(from, (e) => named(e, "claim_invalid").length > 0, 3000);
  check(T("claim: Claim with no name is claim_invalid(name_missing), not a claim"), same(named(ev, "claim_invalid").map((e) => e.p.reason), ["name_missing"]) && named(ev, "claim_complete").length === 0, fmt(ev));
  from = await mark();
  check(T("claim: Email me a link"), await clickText("button", "Email me a link"));
  await page.waitFor(`document.querySelector("#signin-email")`);
  await typeInto("#signin-email", SEED.email);
  check(T("claim: the sheet's Email me a link (submit)"), await tap('[role="dialog"] form button[type="submit"]', "Email me a link"));
  ev = await waitEvents(from, (e) => named(e, "sign_in_link").length > 0, 6000);
  check(T("claim: the sign-in choice, then a sandbox link at the server's answer; never a login"), same(named(ev, "signin_choice").map((e) => pick(e.p, ["choice", "reason"])), [{ choice: "sign_in", reason: "claim" }]) && same(named(ev, "sign_in_link").map((e) => pick(e.p, ["reason", "result"])), [{ reason: "claim", result: "sandbox" }]) && named(ev, "sign_in_return").length === 0, fmt(ev));
  await clickText('[role="dialog"] button', "Close");
  await sleep(400);
  from = await mark();
  await typeInto("#claim-name", SEED.claimer);
  await clickText('form button[type="submit"]', "Claim my stub");
  ev = await waitEvents(from, (e) => named(e, "claim_complete").length > 0 && named(e, "page_view").length > 0, 8000);
  check(T("claim: one local claim, stored, then the memory page"), same(named(ev, "claim_complete").map((e) => pick(e.p, ["flow", "result", "storage"])), [{ flow: "set", result: "claimed", storage: "ok" }]) && named(ev, "page_view")[0]?.p.route_template === "/s/:token", fmt(ev));
  from = await mark();
  await push(`/claim/g/${SEED.token}`);
  ev = await waitEvents(from, (e) => named(e, "claim_view").length > 0, 6000);
  check(T("claim: a missing guest claim link is invalid on /claim/g/:token"), same(pick(named(ev, "claim_view")[0]?.p ?? {}, ["flow", "result"]), { flow: "guest", result: "invalid" }) && named(ev, "claim_view")[0]?.p.route_template === "/claim/g/:token", fmt(ev));

  /* ================= checkout, cart, wallet, gift (all sandbox or simulated) ================= */

  from = await mark();
  await push("/checkout/demo-pale");
  await at("/checkout/demo-pale");
  ev = await waitEvents(from, (e) => named(e, "begin_checkout").length > 0, 5000);
  await sleep(600);
  ev = (await events()).slice(from);
  check(T("checkout: one begin_checkout, sandbox, after its page_view"), named(ev, "begin_checkout").length === 1 && named(ev, "begin_checkout")[0].p.capability === "sandbox" && ev.findIndex((e) => e.name === "page_view") < ev.findIndex((e) => e.name === "begin_checkout"), fmt(ev));
  from = await mark();
  await clickSel('[role="radiogroup"][aria-label="Material"] [data-value="card"]');
  ev = await waitEvents(from, (e) => named(e, "product_option").length > 0, 3000);
  check(T("checkout: a material choice is product_option(material=card)"), same(named(ev, "product_option").map((e) => pick(e.p, ["option", "material"])), [{ option: "material", material: "card" }]), fmt(ev));
  from = await mark();
  await clickText("button", "Add to cart");
  ev = await waitEvents(from, (e) => named(e, "add_to_cart").length > 0, 3000);
  check(T("checkout: Add to cart is one add_to_cart(context=checkout)"), named(ev, "add_to_cart").length === 1 && named(ev, "add_to_cart")[0].p.context === "checkout", fmt(ev));
  from = await mark();
  check(T("checkout: Pay with no receipt email"), await clickText("button", "Pay "));
  // signed out, Pay opens the sign-in sheet first; Continue as guest is the choice that goes on (one signin_choice(sign_in), one guest)
  check(T("checkout: Pay signed out opens the sheet, Continue as guest goes on"), (await page.waitFor(`document.querySelector('[role="dialog"]')`)) && (await clickText('[role="dialog"] button', "Continue as guest")));
  ev = await waitEvents(from, (e) => named(e, "sandbox_order").length > 0, 8000);
  const local = named(ev, "sandbox_order")[0]?.p ?? {};
  check(T("checkout: sandbox card chosen, then a placed local order (no email: the server needs one), never a purchase"), named(ev, "add_payment_info").length === 1 && named(ev, "add_payment_info")[0].p.capability === "sandbox" && same(pick(local, ["result", "receipt", "storage", "capability", "method", "error_code"]), { result: "placed", receipt: "local", storage: "ok", capability: "sandbox", method: "card", error_code: "unauthorized" }), fmt(ev) + JSON.stringify(local));
  // the cart
  from = await mark();
  await push("/cart");
  await at("/cart");
  ev = await waitEvents(from, (e) => named(e, "view_cart").length > 0, 5000);
  check(T("cart: one view_cart with one line"), named(ev, "view_cart").length === 1 && named(ev, "view_cart")[0].p.item_count === 1, fmt(ev));
  from = await mark();
  await clickText("button", "Remove");
  ev = await waitEvents(from, (e) => named(e, "remove_from_cart").length > 0, 3000);
  check(T("cart: Remove is one remove_from_cart"), named(ev, "remove_from_cart").length === 1 && named(ev, "remove_from_cart")[0].p.context === "cart", fmt(ev));
  // the quote runs out (the page's clock moved 16 minutes on), is refused at Pay, and is refreshed
  await push("/checkout/demo-pale");
  await at("/checkout/demo-pale");
  await sleep(800);
  from = await mark();
  await page.eval("(() => { const real = Date.now.bind(Date); Date.now = () => real() + 16 * 60_000; })()");
  ev = await waitEvents(from, (e) => named(e, "quote_expired").length > 0, 18000);
  check(T("quote: one quote_expired when the 15-minute quote runs out"), named(ev, "quote_expired").length === 1, fmt(ev));
  from = await mark();
  await clickText("button", "Pay ");
  await clickText("button", "Refresh the quote");
  ev = await waitEvents(from, (e) => named(e, "quote_refresh").length > 0, 3000);
  check(T("quote: Pay on an expired quote is refused (checkout_invalid quote_expired, no order), then refreshed"), same(named(ev, "checkout_invalid").map((e) => e.p.reason), ["quote_expired"]) && named(ev, "sandbox_order").length === 0 && named(ev, "quote_refresh").length === 1, fmt(ev));
  // a cart order with a receipt email: the server keeps it
  await clickText("button", "Add to cart");
  await sleep(300);
  from = await mark();
  await push("/cart");
  await at("/cart");
  await page.waitFor(`document.querySelector("#cart-email")`);
  await typeInto("#cart-email", SEED.email);
  await clickText("button", "Pay ");
  await page.waitFor(`document.querySelector('[role="dialog"]')`);
  await clickText('[role="dialog"] button', "Continue as guest");
  ev = await waitEvents(from, (e) => named(e, "sandbox_order").length > 0, 8000);
  const serverOrder = named(ev, "sandbox_order")[0]?.p ?? {};
  check(T("cart: begin_checkout(cart), sandbox card, then a placed order with a server receipt"), named(ev, "begin_checkout")[0]?.p.context === "cart" && named(ev, "add_payment_info").length === 1 && same(pick(serverOrder, ["result", "receipt", "storage", "capability"]), { result: "placed", receipt: "server", storage: "ok", capability: "sandbox" }), fmt(ev) + JSON.stringify(serverOrder));
  // wallet
  from = await mark();
  await push("/wallet/demo-pale");
  await at("/wallet/demo-pale");
  await page.waitFor(`document.querySelector('[role="radiogroup"][aria-label="Wallet"]')`);
  await clickSel('[role="radiogroup"][aria-label="Wallet"] [data-value="google"]');
  await clickText("button", "Add to Google Wallet");
  ev = await waitEvents(from, (e) => named(e, "wallet_select").length > 0, 3000);
  check(T("wallet: the tab is wallet_option(google), the Add is wallet_select(google) labelled simulated"), same(named(ev, "wallet_option").map((e) => e.p.provider), ["google"]) && same(named(ev, "wallet_select").map((e) => pick(e.p, ["provider", "capability"])), [{ provider: "google", capability: "simulated" }]), fmt(ev));
  // gift
  from = await mark();
  await push("/gift/demo-pale");
  await at("/gift/demo-pale");
  await page.waitFor(`document.querySelector('[role="radiogroup"][aria-label="Delivery"]')`);
  await clickSel('[role="radiogroup"][aria-label="Delivery"] [data-value="print"]');
  await clickSel('[role="switch"]');
  await clickSel('[role="radiogroup"][aria-label="Delivery"] [data-value="link"]');
  ev = await waitEvents(from, (e) => named(e, "gift_option").length >= 3, 3000);
  check(T("gift: three option changes, choices only"), same(named(ev, "gift_option").map((e) => pick(e.p, ["option", "delivery", "wrap"])), [{ option: "delivery", delivery: "print", wrap: true }, { option: "wrap", delivery: "print", wrap: false }, { option: "delivery", delivery: "link", wrap: false }]), fmt(ev));
  from = await mark();
  await clickText('form button[type="submit"]', "Send the gift");
  ev = await waitEvents(from, (e) => named(e, "gift_prepare").length > 0, 3000);
  check(T("gift: Send with no name is gift_prepare(invalid)"), same(named(ev, "gift_prepare").map((e) => e.p.result), ["invalid"]), fmt(ev));
  from = await mark();
  await typeInto("#gift-for", SEED.giftTo);
  await typeInto("textarea", SEED.note);
  await clickText('form button[type="submit"]', "Send the gift");
  ev = await waitEvents(from, (e) => named(e, "gift_prepare").length > 0, 8000);
  const gp = named(ev, "gift_prepare")[0]?.p ?? {};
  check(T("gift: a link gift with a note is prepared by the server (prepared, never 'delivered')"), same(pick(gp, ["result", "delivery", "wrap", "has_message", "storage"]), { result: "prepared", delivery: "link", wrap: false, has_message: true, storage: "server" }) && same(named(ev, "server_save").map((e) => pick(e.p, ["kind", "result"])).filter((x) => x.kind === "gift"), [{ kind: "gift", result: "saved" }]), fmt(ev) + JSON.stringify(gp));

  /* ================= organizer ================= */

  from = await mark();
  await push("/organizer");
  await at("/organizer");
  ev = await waitEvents(from, (e) => named(e, "organizer_step").length > 0, 5000);
  await sleep(500);
  ev = (await events()).slice(from);
  check(T("organizer: opens on Design once (via=open), after its page_view"), same(named(ev, "organizer_step").map((e) => pick(e.p, ["step", "via"])), [{ step: "design", via: "open" }]) && ev.findIndex((e) => e.name === "page_view") < ev.findIndex((e) => e.name === "organizer_step"), fmt(ev));
  from = await mark();
  await typeInto("#org-name", SEED.orgName);
  await clickText("button", "Minimal");
  await clickSel('button[role="switch"]');
  ev = await waitEvents(from, (e) => named(e, "organizer_design").length >= 2, 3000);
  check(T("organizer: style and lock choices, and nothing for the typed name"), same(named(ev, "organizer_design").map((e) => e.p.change), ["edition", "lock_logo"]) && ev.every((e) => e.name === "organizer_design"), fmt(ev));
  from = await mark();
  await clickText("button", "Add your guest list");
  await setFiles('input[type="file"]', [csvPath]);
  ev = await waitEvents(from, (e) => named(e, "organizer_mapping").length > 0, 5000);
  check(T("organizer: Next is organizer_step(guests, nav)"), same(named(ev, "organizer_step").map((e) => pick(e.p, ["step", "via"])), [{ step: "guests", via: "nav" }]), fmt(ev));
  check(T("organizer: the CSV file is counted (4 rows, 3 columns), never read out"), same(named(ev, "organizer_csv").map((e) => pick(e.p, ["source", "result", "row_count", "column_count"])), [{ source: "file", result: "parsed", row_count: 4, column_count: 3 }]), fmt(ev));
  check(T("organizer: columns matched automatically"), same(named(ev, "organizer_mapping").map((e) => e.p.result), ["auto"]), fmt(ev));
  from = await mark();
  await clickText("button", "None");
  ev = await waitEvents(from, (e) => named(e, "organizer_mapping").length > 0, 3000);
  check(T("organizer: a column picked by hand is manual"), named(ev, "organizer_mapping")[0]?.p.result === "manual", fmt(ev));
  from = await mark();
  await clickText("button", "Check the stubs");
  ev = await waitEvents(from, (e) => named(e, "organizer_check").length > 0, 3000);
  check(T("organizer: Check counts 4 rows, 1 with no name"), same(named(ev, "organizer_check").map((e) => pick(e.p, ["row_count", "missing_name_count"])), [{ row_count: 4, missing_name_count: 1 }]) && named(ev, "organizer_step")[0]?.p.step === "check", fmt(ev));
  from = await mark();
  check(T("organizer: tap the second stub on the contact sheet"), await tap(`[aria-label="Contact sheet of every guest's stub"] li:nth-child(2) button[aria-pressed]`));
  ev = await waitEvents(from, (e) => named(e, "organizer_contact_select").length > 0, 3000);
  check(T("organizer: inspecting the second stub is rank 2 of 3"), same(named(ev, "organizer_contact_select").map((e) => pick(e.p, ["action", "rank", "row_count"])), [{ action: "inspect", rank: 2, row_count: 3 }]), fmt(ev));
  from = await mark();
  await clickText("button", "Publish");
  await sleep(500);
  await clickSel('[role="radiogroup"][aria-label="How to publish"] [data-value="claim"]');
  await clickText("button", "Share one link without guest names");
  ev = await waitEvents(from, (e) => named(e, "organizer_publish").length > 0, 3000);
  check(T("organizer: one shared link made on this device (local), for 3 guests"), same(named(ev, "organizer_publish").map((e) => pick(e.p, ["mode", "result", "guest_count"])), [{ mode: "links", result: "local", guest_count: 3 }]) && named(ev, "organizer_step")[0]?.p.step === "publish", fmt(ev));
  await page.waitFor(`document.querySelector("input[readonly]")`);
  const attendeeUrl = await value("input[readonly]");
  from = await mark();
  await clickText("button", "Copy link");
  ev = await waitEvents(from, (e) => named(e, "share").length > 0, 3000);
  check(T("organizer: the claim link copy is one share(claim_link)"), same(named(ev, "share").map((e) => pick(e.p, ["content_type", "context", "result"])), [{ content_type: "claim_link", context: "organizer", result: "success" }]), fmt(ev));
  from = await mark();
  await clickSel('[role="radiogroup"][aria-label="How to publish"] [data-value="print"]');
  await sleep(300);
  // the Stamp, not the publish tab that carries the same words
  await clickText('button:not([role="radio"])', "Print all");
  ev = await waitEvents(from, (e) => named(e, "sandbox_order").length > 0, 8000);
  check(T("organizer: the print run is a placed sandbox order (organizer_print, local: no account email), never a purchase"), same(named(ev, "sandbox_order").map((e) => pick(e.p, ["method", "result", "receipt", "capability", "storage"])), [{ method: "organizer_print", result: "placed", receipt: "local", capability: "sandbox", storage: "ok" }]), fmt(ev));
  // the attendee
  check(T("attendee: the organizer link is /organizer/claim?d="), typeof attendeeUrl === "string" && attendeeUrl.startsWith(`${base}/organizer/claim?d=`), attendeeUrl);
  await hard(attendeeUrl.slice(base.length), 1500);
  ev = await waitEvents(0, (e) => named(e, "claim_view").length > 0, 5000);
  check(T("attendee: a valid organizer link; the design in ?d= is never sent"), same(pick(named(ev, "claim_view")[0]?.p ?? {}, ["flow", "result"]), { flow: "organizer", result: "valid" }) && named(ev, "claim_view")[0]?.p.page_location === `${base}/organizer/claim`, fmt(ev));
  from = await mark();
  await setFiles('input[type="file"]', [photoPath]);
  ev = await waitEvents(from, (e) => named(e, "photo_add").length > 0, 5000);
  check(T("attendee: a picked photo is photo_add(organizer_claim, success, 1)"), same(named(ev, "photo_add").map((e) => pick(e.p, ["via", "result", "photo_count"])), [{ via: "organizer_claim", result: "success", photo_count: 1 }]), fmt(ev));
  from = await mark();
  await typeInto("#claim-name", SEED.claimer);
  check(T("attendee: Claim my stub (submit)"), await tap('form button[type="submit"]', "Claim my stub"));
  ev = await waitEvents(from, (e) => named(e, "claim_complete").length > 0, 5000);
  check(T("attendee: one local organizer claim, stored"), same(named(ev, "claim_complete").map((e) => pick(e.p, ["flow", "result", "storage"])), [{ flow: "organizer", result: "claimed", storage: "ok" }]), fmt(ev));

  /* ================= entry points ================= */

  await hard("/");
  from = await mark();
  check(T("entry: the landing page's search link"), await clickText("button", "No link? Search for your show"));
  check(T("entry: /search opens"), await at("/search"));
  ev = await waitEvents(from, (e) => named(e, "page_view").length > 0, 4000);
  check(T("entry: cta_select(search, home) on / before the /search page_view"), named(ev, "cta_select")[0]?.p.context === "home" && named(ev, "cta_select")[0]?.p.route_template === "/" && ev.findIndex((e) => e.name === "cta_select") < ev.findIndex((e) => e.name === "page_view"), fmt(ev));
  from = await mark();
  // the sidebar's Wall as a visible control: on the phone the menu is opened first; a folded desktop rail is opened too
  const wallRow = 'a[data-row-link][href="/wall"]';
  let wallTapped = await tap(wallRow);
  if (!wallTapped) {
    const opener = vp.mobile ? 'button[aria-label="Open the menu"]' : 'button[aria-label="Open the sidebar"]';
    check(T(`entry: ${vp.mobile ? "Open the menu" : "Open the sidebar"}`), await tap(opener));
    await sleep(600);
    wallTapped = await tap(wallRow);
  }
  check(T("entry: the sidebar's Wall row, tapped as a visible control"), wallTapped);
  await at("/wall");
  ev = await waitEvents(from, (e) => named(e, "wall_view").length > 0, 5000);
  check(T("entry: the sidebar's Wall is nav_select(wall, a returning wall) on /search, then wall_view loaded"), same(named(ev, "nav_select").map((e) => pick(e.p, ["item", "has_stubs", "route_template"])), [{ item: "wall", has_stubs: true, route_template: "/search" }]) && named(ev, "wall_view")[0]?.p.state === "loaded", fmt(ev));

  /* ================= the whole run, at this size ================= */

  const entries = await allEntries();
  const all = entries.filter((a) => a[0] === "event").map((a) => ({ name: a[1], p: a[2] ?? {} }));
  check(T("privacy: no seeded value anywhere in the dataLayer (events, config, set, consent)"), !LEAK.test(JSON.stringify(entries)), (JSON.stringify(entries).match(/.{60}zq.{60}/i) ?? [""])[0]);
  check(T("privacy: no query string or raw token in any page_location or page_referrer"), all.every((e) => !/[?#]/.test(String(e.p.page_location ?? "")) && !/[?#]/.test(String(e.p.page_referrer ?? ""))), "");
  const leaving = outbound.filter((o) => !/^https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-TEST000000$/.test(o.url));
  check(T("network: nothing left loopback except the (stubbed or blocked) tag request"), leaving.length === 0, leaving.map((o) => o.url).join(", "));
  check(T("network: no seeded value in any request that left loopback"), !outbound.some((o) => LEAK.test(o.url) || LEAK.test(o.body)));
  check(T("truth: no purchase, refund, login or sign_up"), !all.some((e) => ["purchase", "refund", "login", "sign_up"].includes(e.name)), fmt(all.filter((e) => ["purchase", "refund", "login", "sign_up"].includes(e.name))));
  check(T("truth: every commerce event is labelled sandbox, every wallet event simulated"), all.filter((e) => ["add_to_cart", "remove_from_cart", "view_cart", "begin_checkout", "add_payment_info", "sandbox_order", "sandbox_order_retry"].includes(e.name)).every((e) => e.p.capability === "sandbox") && named(all, "wallet_select").every((e) => e.p.capability === "simulated"), "");
  // every event belongs to the latest page_view before it, document by document
  let current = null;
  const wrong = [];
  for (const a of entries) {
    if (a[0] === "config") current = null; // a new document's tag configuration
    if (a[0] !== "event") continue;
    const p = a[2] ?? {};
    if (a[1] === "page_view") current = p.route_template;
    else if (current !== null && p.route_template !== current) wrong.push(`${a[1]}@${p.route_template} (page ${current})`);
  }
  check(T("order: every event carries the template of the latest page_view before it"), wrong.length === 0, wrong.join("; "));
  check(T("no page errors"), page.consoleErrors.length === 0, page.consoleErrors.join(" | "));
  console.log(`info [${vp.name}] ${realClicks} real pointer clicks on visible controls; ${fallbacks.size} control(s) were not visible/uncovered and were pressed programmatically: ${[...fallbacks].join("; ") || "none"}`);
  await page.close();
}
