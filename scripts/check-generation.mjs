// Studio art-generation lifecycle (issues #97/#98), in a real headless Chrome over the DevTools protocol, offline.
//   node scripts/check-generation.mjs <base-url> [evidence-dir]
// /api/art is replaced IN THE PAGE by a controllable deferred fake, so no art request ever leaves the browser and no
// provider is involved. Synthetic stub only. For each of a desktop and a phone viewport it checks:
//  - an edit made while the request is pending (and the sheet closed) survives the completion, in the editor and the saved wall;
//  - the pending status stays beside the artwork after the sheet closes, reopens without a second request, shows no percentage/ETA;
//  - a changed edition is never switched silently: the result waits for an explicit Apply;
//  - Stop ignores a late result (and says it does not cancel the provider); failure keeps the draft and Try again is a new request;
//  - a reload while pending reads "interrupted", not resumed; axe finds no serious or critical violation with the status shown.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser } from "./lib/cdp.mjs";

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const evidenceDir = process.argv[3] ? resolve(process.argv[3]) : null;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let passed = 0;
const lines = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  const line = `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`;
  lines.push(line);
  console.log(line);
  return ok;
}

const fact = (id, label, value, kept = true) => ({ id, label, value, source: "setlist.fm", confidence: 0.95, provenance: "live", kept });
const stub = {
  id: "s1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: 1,
  event: { type: "concert", title: "Synthetic Night", facts: [fact("venue", "Venue", "Hall A"), fact("date", "Date", "2026-11-01"), fact("seat", "Seat", "Row 4", false)] },
  versions: [{ id: "v0", edition: "researched", art: { kind: "procedural", seed: 1, provenance: "simulated" }, createdAt: "2026-10-01T00:00:00.000Z" }],
  currentVersionId: "v0",
  personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [], friends: [] },
  material: "card",
  finish: "matte",
  torn: false,
  wallAngle: 0,
  photos: [],
};

/** Installed before every page load: /api/art becomes a deferred fake the script resolves by hand. */
const HOOK = `(() => {
  window.__art = [];
  const real = window.fetch.bind(window);
  window.fetch = (url, init) => {
    if (!String(url).includes("/api/art")) return real(url, init);
    return new Promise((resolve, reject) => {
      const call = { settled: false, aborted: false };
      const send = (status, body) => { call.settled = true; resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); };
      call.ok = (tag) => send(200, { kind: "image", src: "/brand/mockup-art-glasgow.webp?v=" + tag, seed: 11, provenance: "simulated" });
      call.fail = () => send(500, { error: { code: "provider_unavailable", message: "The art service is unavailable." } });
      init && init.signal && init.signal.addEventListener("abort", () => { call.aborted = true; reject(new DOMException("aborted", "AbortError")); });
      window.__art.push(call);
    });
  };
})()`;

const wall = (page) => page.eval(`JSON.parse(localStorage.getItem("ticketstub.wall.v1") || "[]")[0] || null`);
const calls = (page) => page.eval(`window.__art.length`);
// a missing call (a request that was never made) is a failed check later, not a crash
const settle = (page, n, how, arg = "") => page.eval(`window.__art[${n}] ? (window.__art[${n}].${how}(${JSON.stringify(arg)}), true) : false`);
const clickText = (page, text, scope = "document") =>
  page.eval(`(() => { const b = [...${scope}.querySelectorAll("button")].find((e) => e.offsetParent !== null && !e.disabled && e.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
/** Click the visible enabled button whose text (or aria-label) starts with the given words. */
const clickStarts = (page, start) =>
  page.eval(`(() => { const b = [...document.querySelectorAll("button")].find((e) => e.offsetParent !== null && !e.disabled && ((e.getAttribute("aria-label") || e.textContent).trim().startsWith(${JSON.stringify(start)}))); if (!b) return false; b.click(); return true; })()`);
const statusText = (page) => page.eval(`(document.querySelector('[aria-label="Art generation status"]') || {}).textContent || ""`);
const hasStatus = (page, re) => page.eval(`${re}.test((document.querySelector('[aria-label="Art generation status"]') || {}).textContent || "")`);
const visible = (page) => page.eval(`(() => { const e = document.querySelector('[aria-label="Art generation status"]'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; })()`);

async function open(browser, label, vp) {
  const page = await browser.newPage(vp);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  await page.goto(`${base}/wall`);
  await page.eval(`localStorage.clear(); localStorage.setItem("ticketstub.wall.v1", ${JSON.stringify(JSON.stringify([stub]))}); localStorage.setItem("ticketstub.hint.swipe.v1", "1")`);
  await page.goto(`${base}/studio/s1`, { settle: 1500 });
  return page;
}
const openRemix = async (page) => {
  await clickText(page, "Remix");
  await sleep(500);
};
const startRemix = async (page) => {
  await openRemix(page);
  const ok = await clickText(page, "Remix the art");
  await sleep(300);
  return ok;
};
const closeSheet = async (page) => {
  await page.key("Escape");
  await sleep(500);
};
// let stylesheets and fonts finish before a picture is taken
const shot = async (page, name) => {
  if (!evidenceDir) return;
  await page.eval("document.fonts.ready.then(() => true)");
  await sleep(1200);
  await page.screenshot(`${evidenceDir}/${name}.png`);
};

async function scenarios(browser, label, vp) {
  const tag = (n) => `[${label}] ${n}`;
  const pickEdition = async (page) => {
    await page.key("ArrowRight"); // deals the next style from the keyboard, on both layouts
    return true;
  };

  // 1. an edit made while the request is pending survives its completion
  let page = await open(browser, label, vp);
  check(tag("remix request dispatched from the sheet"), await startRemix(page));
  check(tag("exactly one art request"), (await calls(page)) === 1);
  await closeSheet(page);
  await sleep(300);
  check(tag("pending status stays beside the artwork after the sheet closes"), (await hasStatus(page, "/Generating new art/")) && (await visible(page)), await statusText(page));
  check(tag("pending text has no percentage or ETA"), !/%|ETA|minutes?\b/i.test(await statusText(page)), await statusText(page));
  await shot(page, `${label}-pending-sheet-closed`);
  check(tag("material and finish chosen while pending"), (await clickStarts(page, "Framed")) && (await clickStarts(page, "Foil")));
  await sleep(300);
  let w = await wall(page);
  check(tag("edits reached the saved wall before completion"), w?.material === "framed" && w?.finish === "foil", `${w?.material}/${w?.finish}`);
  await openRemix(page);
  check(tag("reopened sheet shows the same operation: no second request"), (await calls(page)) === 1 && (await page.eval(`!![...document.querySelectorAll("button")].find((b) => /Remixing…/.test(b.textContent) && b.disabled)`)));
  await closeSheet(page);
  const axe = await page.eval(`(async () => { ${axeSource}; const r = await axe.run(document, { resultTypes: ["violations"] }); return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id + ":" + v.nodes.length); })()`);
  check(tag("axe: no serious or critical violation with the status shown"), axe.length === 0, JSON.stringify(axe));
  await settle(page, 0, "ok", "one");
  await sleep(600);
  w = await wall(page);
  check(tag("completion keeps material and finish edits (art-only commit)"), w?.material === "framed" && w?.finish === "foil", `${w?.material}/${w?.finish}`);
  check(tag("completion added exactly one version and selected it"), w?.versions?.length === 2 && w?.currentVersionId === w?.versions?.[1]?.id, `versions=${w?.versions?.length}`);
  check(tag("applied status is shown"), await hasStatus(page, /New art applied/));
  await shot(page, `${label}-applied`);
  await page.close();

  // 2. a changed edition is never silently switched
  page = await open(browser, label, vp);
  await startRemix(page);
  await closeSheet(page);
  check(tag("edition picked while pending"), await pickEdition(page));
  await sleep(500);
  const chosen = (await wall(page))?.currentVersionId;
  await settle(page, 0, "ok", "two");
  await sleep(600);
  w = await wall(page);
  check(tag("edition choice survives the completion"), w?.currentVersionId === chosen && w?.versions?.find((v) => v.id === w.currentVersionId)?.edition === "letterpress", `${w?.currentVersionId} vs ${chosen}`);
  check(tag("result waits as ready for explicit Apply"), await hasStatus(page, /New art ready/), await statusText(page));
  await shot(page, `${label}-ready-candidate`);
  const before = w?.versions?.length;
  check(tag("Apply is offered and explicit"), await clickText(page, "Apply as new version"));
  await sleep(500);
  w = await wall(page);
  check(tag("Apply adds one version in the chosen edition"), w?.versions?.length === before + 1 && w?.versions?.find((v) => v.id === w.currentVersionId)?.edition === "letterpress");
  await page.close();

  // 3. Stop ignores a late result; failure keeps the draft; retry is a new request; reload reads interrupted
  page = await open(browser, label, vp);
  await startRemix(page);
  await closeSheet(page);
  check(tag("Stop is offered"), await clickText(page, "Stop and ignore the result"));
  await sleep(300);
  check(tag("Stop says it does not cancel the art service"), await hasStatus(page, /does not cancel the request on the art service/), await statusText(page));
  await settle(page, 0, "ok", "late").catch(() => undefined);
  await sleep(500);
  w = await wall(page);
  check(tag("late result after Stop changes nothing"), w?.versions?.length === 1);
  await clickText(page, "Try again");
  await sleep(400);
  check(tag("Try again is a NEW request"), (await calls(page)) === 2);
  await settle(page, 1, "fail");
  await sleep(500);
  check(tag("failure is visible with the sheet closed"), await hasStatus(page, /New art not made/), await statusText(page));
  await shot(page, `${label}-failed`);
  w = await wall(page);
  check(tag("failure leaves the saved draft unchanged"), w?.versions?.length === 1);
  await clickText(page, "Try again");
  await sleep(400);
  check(tag("retry after failure is another new request"), (await calls(page)) === 3);
  await page.goto(`${base}/studio/s1`, { settle: 1500 });
  check(tag("reload while pending reads interrupted, not resumed"), (await hasStatus(page, /can't tell whether it finished/)) && (await calls(page)) === 0, await statusText(page));
  await shot(page, `${label}-reload-interrupted`);
  await page.close();

  // 4. ready A, then a newer request B: A is retired (cannot be applied late), B completes exactly once
  page = await open(browser, label, vp);
  await startRemix(page);
  await closeSheet(page);
  await pickEdition(page);
  await sleep(400);
  await settle(page, 0, "ok", "A");
  await sleep(600);
  check(tag("A is ready (selection moved)"), await hasStatus(page, /New art ready/), await statusText(page));
  const vA = (await wall(page))?.versions?.length;
  check(tag("a newer request B starts while A is ready"), await startRemix(page));
  await closeSheet(page);
  check(tag("two requests were made, B is pending"), (await calls(page)) === 2 && (await hasStatus(page, /Generating new art/)), await statusText(page));
  check(tag("A's Apply is gone while B is pending"), !(await page.eval(`!![...document.querySelectorAll("button")].find((b) => /Apply as new version/.test(b.textContent))`)));
  check(tag("A did not write while superseded"), (await wall(page))?.versions?.length === vA);
  await shot(page, `${label}-superseded-b-pending`);
  await settle(page, 1, "ok", "B");
  await sleep(700);
  w = await wall(page);
  check(tag("B applied exactly once (one new version, A's never added)"), w?.versions?.length === vA + 1 && (await hasStatus(page, /New art applied/)), `versions=${w?.versions?.length} vs ${vA}`);
  await settle(page, 0, "ok", "A-again").catch(() => undefined);
  await sleep(400);
  check(tag("a repeated late A response changes nothing"), (await wall(page))?.versions?.length === vA + 1);
  await page.close();
}

const browser = await launchBrowser();
try {
  await scenarios(browser, "desktop", { width: 1280, height: 900 });
  await scenarios(browser, "mobile", { width: 390, height: 844, dpr: 2 });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (evidenceDir) writeFileSync(`${evidenceDir}/check-generation.txt`, `${lines.join("\n")}\n\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
