// Studio art-generation lifecycle across the REAL entry points (issues #97/#98): the agent note's "Make it moodier", the
// agent chat's proposed remix (Apply), and the sheet's "From my photo" — all through the real UI, client, controller,
// editor commit and local persistence, in headless Chrome, offline.
//   node scripts/check-generation-entrypoints.mjs <base-url> [evidence-dir]
// Only the network is faked, IN THE PAGE: /api/art is a deferred fake resolved by hand, /api/agent returns a fixed plan, the
// photo is a synthetic PNG and its read can be held. Nothing leaves the browser; no provider, key or account is involved.
// It does not invent progress: it asserts the text has no percentage, no ETA and no provider-cancel claim.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser } from "./lib/cdp.mjs";

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const evidenceDir = process.argv[3] ? resolve(process.argv[3]) : null;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
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

// A real 2x2 PNG (synthetic) for the photo path.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=", "base64");
const photoFile = `${process.env.GEN_FIXTURE_DIR ?? "/tmp/gen-entrypoints-evidence"}/synthetic-photo.png`;
const badFile = `${process.env.GEN_FIXTURE_DIR ?? "/tmp/gen-entrypoints-evidence"}/not-a-photo.png`;
mkdirSync(resolve(photoFile, ".."), { recursive: true });
writeFileSync(photoFile, PNG);
writeFileSync(badFile, "this is not an image");

/** Installed before every load: /api/art deferred by hand, /api/agent a fixed plan, photo reads that can be held. */
const HOOK = `(() => {
  window.__art = [];
  window.__agent = [];
  window.__gate = false;
  window.__held = [];
  const real = window.fetch.bind(window);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  window.fetch = (url, init) => {
    const u = String(url);
    if (u.includes("/api/agent")) {
      const n = window.__agent.length;
      window.__agent.push(init && init.body ? JSON.parse(init.body) : null);
      return Promise.resolve(n === 0
        ? json(200, { reply: "Here is a moodier look for the art.", actions: [{ type: "remix_art", vibe: "moodier" }], provenance: "rules" })
        : json(200, { reply: "Done. Anything else?", actions: [], provenance: "rules" }));
    }
    if (!u.includes("/api/art")) return real(url, init);
    return new Promise((resolve, reject) => {
      const call = { settled: false, aborted: false };
      const send = (status, body) => { call.settled = true; resolve(json(status, body)); };
      call.ok = (tag) => send(200, { kind: "image", src: "/brand/mockup-art-glasgow.webp?v=" + tag, seed: 11, provenance: "simulated" });
      call.fail = () => send(500, { error: { code: "provider_unavailable", message: "The art service is unavailable." } });
      call.quota = () => send(429, { error: { code: "art_limit" }, art: { kind: "procedural", seed: 7, provenance: "simulated" }, retryAt: 0 });
      init && init.signal && init.signal.addEventListener("abort", () => { call.aborted = true; reject(new DOMException("aborted", "AbortError")); });
      window.__art.push(call);
    });
  };
  const read = FileReader.prototype.readAsDataURL;
  FileReader.prototype.readAsDataURL = function (f) { if (window.__gate) { window.__held.push(() => read.call(this, f)); } else read.call(this, f); };
  window.__release = () => { const h = window.__held.splice(0); h.forEach((fn) => fn()); return h.length; };
})()`;

const wall = (page) => page.eval(`JSON.parse(localStorage.getItem("ticketstub.wall.v1") || "[]")[0] || null`);
const calls = (page) => page.eval(`window.__art.length`);
const settle = (page, n, how) => page.eval(`window.__art[${n}] ? (window.__art[${n}].${how}(), true) : false`);
const clickText = (page, text) =>
  page.eval(`(() => { const b = [...document.querySelectorAll("button")].find((e) => e.offsetParent !== null && !e.disabled && e.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
const clickStarts = (page, start) =>
  page.eval(`(() => { const b = [...document.querySelectorAll("button")].find((e) => e.offsetParent !== null && !e.disabled && ((e.getAttribute("aria-label") || e.textContent).trim().startsWith(${JSON.stringify(start)}))); if (!b) return false; b.click(); return true; })()`);
const status = (page) => page.eval(`(document.querySelector('[aria-label="Art generation status"]') || {}).textContent || ""`);
const has = async (page, re) => re.test(await status(page));
const visible = (page) => page.eval(`(() => { const e = document.querySelector('[aria-label="Art generation status"]'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; })()`);
const printed = (page) => page.eval(`(document.body.textContent.match(/Prints version #([0-9a-f]+)/) || [])[1] || ""`);
const hasButton = (page, re) => page.eval(`!![...document.querySelectorAll("button")].find((b) => b.offsetParent !== null && ${re}.test(b.textContent))`);
const shot = async (page, name) => {
  if (!evidenceDir) return;
  await page.eval("document.fonts.ready.then(() => true)");
  await sleep(1200);
  await page.screenshot(`${evidenceDir}/${name}.png`);
};
const closeSheet = async (page) => {
  await page.key("Escape");
  await sleep(500);
};
const noInvention = (text) => !/\d\s*%|ETA|minutes? (left|remaining)/i.test(text) && !/provider (was |has )?(cancel|stopp)|cancelled by|resum/i.test(text);

async function open(browser, vp) {
  const page = await browser.newPage(vp);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  await page.goto(`${base}/wall`);
  await page.eval(`localStorage.clear(); localStorage.setItem("ticketstub.wall.v1", ${JSON.stringify(JSON.stringify([stub]))}); localStorage.setItem("ticketstub.hint.swipe.v1", "1")`);
  await page.goto(`${base}/studio/s1`, { settle: 1500 });
  return page;
}
const edit = async (page) => (await clickStarts(page, "Framed")) && (await clickStarts(page, "Foil"));
/** Click through the notes until the art note shows, then press its action. */
async function noteMoodier(page) {
  for (let i = 0; i < 10; i++) {
    if (await clickText(page, "Make it moodier")) return true;
    // the desktop pin steps with Next note; the phone card has no stepper, so a note is dismissed unchanged
    if (!(await clickStarts(page, "Next note")) && !(await clickStarts(page, "Dismiss this note"))) {
      await clickStarts(page, "Unfold the agent note");
      await sleep(250);
    }
    await sleep(250);
  }
  return false;
}
async function openChat(page) {
  await clickText(page, "Ask");
  await sleep(600);
}
async function chatProposal(page) {
  await page.eval(`document.querySelector('input[placeholder^="Make it feel"]').focus()`);
  await page.type("make the art moodier");
  await page.key("Enter");
  await page.waitFor(`[...document.querySelectorAll("button")].some((b) => b.offsetParent !== null && /^Apply/.test(b.textContent.trim()) && !b.disabled)`, 6000);
}
const chatApply = (page) => page.eval(`(() => { const b = [...document.querySelectorAll('ul[aria-label="Proposed changes"] button')].find((x) => !x.disabled); if (!b) return false; b.click(); return true; })()`);
async function pickPhoto(page, file) {
  await page.send("DOM.getDocument", { depth: 0 });
  const { root } = await page.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"][aria-label="Choose a photo for the art"]' });
  if (!nodeId) return false;
  await page.send("DOM.setFileInputFiles", { files: [file], nodeId });
  return true;
}

async function scenarios(browser, label, vp, { photo = true } = {}) {
  const tag = (n) => `[${label}] ${n}`;
  const dir = (n) => `${label}-${n}`;
  let page, w, h0, v0;

  // ---------------- AGENT NOTE ----------------
  page = await open(browser, vp);
  h0 = await printed(page);
  check(tag("note: the real 'Make it moodier' action is clicked"), await noteMoodier(page));
  await sleep(400);
  check(tag("note: exactly one art request"), (await calls(page)) === 1);
  check(tag("note: status beside the artwork, no invented progress"), (await has(page, /Generating new art/)) && (await visible(page)) && noInvention(await status(page)), await status(page));
  check(tag("note: edits made while pending"), await edit(page));
  // cross-entrypoint duplicate: the sheet and the chat both refuse while the note's request is pending
  await clickText(page, "Remix");
  await sleep(500);
  check(tag("note: sheet's Remix button is disabled while the note's request is pending"), await page.eval(`!![...document.querySelectorAll("button")].find((b) => /Remixing…/.test(b.textContent) && b.disabled)`));
  await closeSheet(page);
  await openChat(page);
  await chatProposal(page);
  await chatApply(page);
  await sleep(700);
  check(tag("note+chat: still exactly one art request (cross-entrypoint duplicate refused)"), (await calls(page)) === 1, `calls=${await calls(page)}`);
  check(tag("chat: the refused action says Not applied (truthful)"), await page.eval(`/Not applied/.test(document.querySelector('ul[aria-label="Proposed changes"]')?.textContent || "")`));
  await closeSheet(page);
  check(tag("note: status still shown with panels closed"), (await has(page, /Generating new art/)) && (await visible(page)));
  await shot(page, dir("note-pending"));
  w = await wall(page);
  check(tag("note: edits are saved while pending"), w?.material === "framed" && w?.finish === "foil", `${w?.material}/${w?.finish}`);
  await settle(page, 0, "ok");
  await sleep(700);
  w = await wall(page);
  check(tag("note: completion keeps the edits and adds exactly one version"), w?.material === "framed" && w?.finish === "foil" && w?.versions?.length === 2, `versions=${w?.versions?.length}`);
  check(tag("note: applied status shown"), await has(page, /New art applied/), await status(page));
  check(tag("note: the printed version changed with the applied art (existing selected-version path)"), h0 !== "" && (await printed(page)) !== h0 && (await printed(page)) !== "", `${h0} -> ${await printed(page)}`);
  await page.close();

  // note: selection change -> ready, explicit Apply (the printed version only changes on Apply)
  page = await open(browser, vp);
  h0 = await printed(page);
  await noteMoodier(page);
  await sleep(300);
  await page.key("ArrowRight");
  await sleep(500);
  const hChosen = await printed(page);
  await settle(page, 0, "ok");
  await sleep(700);
  w = await wall(page);
  v0 = w?.versions?.length;
  check(tag("note: changed selection -> ready, not applied"), await has(page, /New art ready/), await status(page));
  check(tag("note: the printed version did not move to the result"), (await printed(page)) === hChosen);
  check(tag("note: Apply is explicit"), await clickText(page, "Apply as new version"));
  await sleep(500);
  w = await wall(page);
  check(tag("note: Apply adds one version in the chosen style and changes the printed version"), (await wall(page))?.versions?.length === v0 + 1 && (await printed(page)) !== hChosen);
  await page.close();

  // note: Stop + late completion no writes; failure; quota
  page = await open(browser, vp);
  await noteMoodier(page);
  await sleep(300);
  check(tag("note: Stop offered and pressed"), await clickText(page, "Stop and ignore the result"));
  await sleep(300);
  check(tag("note: Stop does not claim provider cancellation"), (await has(page, /does not cancel the request on the art service/)) && noInvention((await status(page)).replace(/does not cancel[^.]*\./, "")), await status(page));
  await settle(page, 0, "ok");
  await sleep(500);
  check(tag("note: late completion after Stop writes nothing"), (await wall(page))?.versions?.length === 1);
  await page.close();

  page = await open(browser, vp);
  await noteMoodier(page);
  await sleep(300);
  await settle(page, 0, "fail");
  await sleep(500);
  check(tag("note: provider failure is shown, honest, draft unchanged"), (await has(page, /New art not made/)) && (await has(page, /unchanged/)) && (await wall(page))?.versions?.length === 1 && noInvention(await status(page)), await status(page));
  await shot(page, dir("note-failed"));
  await page.close();

  page = await open(browser, vp);
  await noteMoodier(page);
  await sleep(300);
  await settle(page, 0, "quota");
  await sleep(600);
  w = await wall(page);
  check(tag("note: quota applies labelled procedural fallback, not a generated image"), (await has(page, /No generated image was made; procedural art was applied/)) && w?.versions?.length === 2 && w.versions[1].art.kind === "procedural", await status(page));
  await page.close();

  // ---------------- AGENT CHAT ----------------
  page = await open(browser, vp);
  h0 = await printed(page);
  await openChat(page);
  await chatProposal(page);
  check(tag("chat: a proposed remix is shown with Apply"), true);
  check(tag("chat: Apply pressed"), await chatApply(page));
  await sleep(500);
  check(tag("chat: exactly one art request"), (await calls(page)) === 1);
  await closeSheet(page);
  check(tag("chat: status shown after the chat is closed"), (await has(page, /Generating new art/)) && (await visible(page)) && noInvention(await status(page)), await status(page));
  await edit(page);
  await shot(page, dir("chat-pending-closed"));
  await settle(page, 0, "ok");
  await sleep(800);
  w = await wall(page);
  check(tag("chat: completion after the chat closed keeps edits and adds one version"), w?.material === "framed" && w?.finish === "foil" && w?.versions?.length === 2, `${w?.material}/${w?.finish} v=${w?.versions?.length}`);
  check(tag("chat: applied and the printed version changed"), (await has(page, /New art applied/)) && (await printed(page)) !== h0);
  await page.close();

  page = await open(browser, vp);
  await openChat(page);
  await chatProposal(page);
  await chatApply(page);
  await sleep(400);
  await closeSheet(page);
  await page.key("ArrowRight");
  await sleep(500);
  await settle(page, 0, "ok");
  await sleep(700);
  w = await wall(page);
  v0 = w?.versions?.length;
  check(tag("chat: changed selection -> ready, explicit Apply (never silently switched)"), (await has(page, /New art ready/)) && (await hasButton(page, /Apply as new version/)), await status(page));
  await clickText(page, "Apply as new version");
  await sleep(500);
  check(tag("chat: explicit Apply adds exactly one version"), (await wall(page))?.versions?.length === v0 + 1);
  await page.close();

  page = await open(browser, vp);
  await openChat(page);
  await chatProposal(page);
  await chatApply(page);
  await sleep(400);
  await settle(page, 0, "quota");
  await sleep(700);
  check(tag("chat: quota is reported honestly and nothing is applied for the agent"), (await has(page, /No generated image was made and nothing was applied/)) && (await wall(page))?.versions?.length === 1, await status(page));
  await shot(page, dir("chat-quota"));
  await page.close();

  page = await open(browser, vp);
  await openChat(page);
  await chatProposal(page);
  await chatApply(page);
  await sleep(400);
  await closeSheet(page);
  await clickText(page, "Stop and ignore the result");
  await sleep(300);
  await settle(page, 0, "ok");
  await sleep(500);
  check(tag("chat: Stop then late completion writes nothing"), (await wall(page))?.versions?.length === 1 && (await has(page, /Stopped/)));
  await page.close();

  if (!photo) return;
  // ---------------- PHOTO ----------------
  page = await open(browser, vp);
  h0 = await printed(page);
  await page.eval(`window.__gate = true`);
  await clickText(page, "Remix");
  await sleep(500);
  check(tag("photo: the real file input receives a synthetic PNG"), await pickPhoto(page, photoFile));
  await sleep(500);
  const pending = await status(page);
  check(tag("photo: pending status is about the photo, not an art service"), /photo/i.test(pending) && !/art service|Generating new art/i.test(pending) && noInvention(pending), pending);
  check(tag("photo: no art request was made"), (await calls(page)) === 0);
  await closeSheet(page);
  check(tag("photo: status stays with the sheet closed"), (await visible(page)) && /photo/i.test(await status(page)));
  check(tag("photo: edits made while pending"), await edit(page));
  await shot(page, dir("photo-pending"));
  await page.eval(`window.__release()`);
  await sleep(1200);
  w = await wall(page);
  check(tag("photo: completion keeps the edits and adds one photo-art version"), w?.material === "framed" && w?.versions?.length === 2 && w.versions[1].art.vibe === "photo" && String(w.versions[1].art.src).startsWith("data:image/"), `v=${w?.versions?.length}`);
  check(tag("photo: still zero art requests; printed version changed"), (await calls(page)) === 0 && (await printed(page)) !== h0);
  await page.close();

  page = await open(browser, vp);
  await page.eval(`window.__gate = true`);
  await clickText(page, "Remix");
  await sleep(500);
  await pickPhoto(page, photoFile);
  await sleep(400);
  await closeSheet(page);
  await page.key("ArrowRight");
  await sleep(500);
  await page.eval(`window.__release()`);
  await sleep(1200);
  check(tag("photo: changed selection -> ready, explicit Apply"), (await has(page, /New art ready/)) && (await hasButton(page, /Apply as new version/)), await status(page));
  w = await wall(page);
  v0 = w?.versions?.length;
  await clickText(page, "Apply as new version");
  await sleep(500);
  check(tag("photo: Apply adds one version"), (await wall(page))?.versions?.length === v0 + 1);
  await page.close();

  page = await open(browser, vp);
  await page.eval(`window.__gate = true`);
  await clickText(page, "Remix");
  await sleep(500);
  await pickPhoto(page, photoFile);
  await sleep(400);
  await closeSheet(page);
  check(tag("photo: Stop pressed"), await clickText(page, "Stop and ignore the result"));
  await sleep(300);
  check(tag("photo: Stop text does not mention an art service or provider cancel"), !/art service|provider/i.test(await status(page)) && /Stopped/.test(await status(page)), await status(page));
  await page.eval(`window.__release()`);
  await sleep(1200);
  check(tag("photo: late read after Stop writes nothing"), (await wall(page))?.versions?.length === 1);
  await page.close();

  page = await open(browser, vp);
  await clickText(page, "Remix");
  await sleep(500);
  await pickPhoto(page, badFile);
  await sleep(1200);
  check(tag("photo: an unreadable file fails honestly and changes nothing"), (await has(page, /couldn't read that photo/i)) && (await wall(page))?.versions?.length === 1, await status(page));
  await shot(page, dir("photo-failed"));
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
if (evidenceDir) writeFileSync(`${evidenceDir}/check-generation-entrypoints.txt`, `${lines.join("\n")}\n\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
