// The exact stub download (MVP P0-2, issue #16), in a real headless Chrome over the DevTools protocol.
//   node scripts/check-download.mjs <base-url> [evidence-dir]
// Run through `npm run verify:product -- --suite download --mode fixture --evidence-dir <dir>`, which serves the production build.
// For five stubs (three editions at least; image art and procedural art; foil, matte and holo) at 390 and 1440 px it
// opens the stub in the studio, presses the real Download button, takes the file Chrome saved and asserts:
//  1. it is a PNG that decodes, with the size the edition prints at (3x the large stub: 1080 wide portrait, 1680 landscape);
//  2. it is not blank (spread of tones, many colours, an opaque body) and has die-cut edges where the edition has them;
//  3. it matches a CDP screenshot of the stub on the studio screen (2x device pixels): the PNG is laid over the screenshot
//     where it is transparent, both are blurred to a quarter size, and the mean absolute difference and the share of clearly
//     different pixels stay under the edition's tolerance (TOLERANCE below). The tolerance covers what is screen-only (window light, desk shadow);
//  4. a control: the same screenshot against a different stub's PNG fails that tolerance, so the metric can tell;
//  5. the back face downloads too, and matches the on-screen back (flipped);
//  6. an edit shows: with the title changed in the saved stub, the next download differs from the first inside the title
//     region and hardly anywhere else, and matches the screen again.
// Plus the delivery paths: the iPhone path hands a PNG File to the share sheet (and opens a tab when sharing is absent),
// and art that cannot be read (another origin without CORS) ends in a message instead of a broken file.
// Writes the PNGs, the screenshots and side-by-sides to <evidence-dir>/download/. Offline: Chrome resolves loopback only.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromePath } from "./lib/cdp.mjs";
import { BEGIN_CAPTURE_PROVENANCE, captureFailureFrames, readCaptureProvenance } from "./lib/download-capture-diagnostics.mjs";
import { DownloadLayerDiagnostics } from "./lib/download-layer-diagnostics.mjs";
import { CaptureQualification, captureQualificationPlan, retainFirstCapture } from "./lib/download-capture-qualification.mjs";
import { DownloadBrowserSessions, browserSessionIdForPair } from "./lib/download-browser-sessions.mjs";
import { checkDownloadReceiptControls } from "./lib/download-receipt-controls.mjs";
import { MESSAGES } from "../src/customer/feedback-messages/messages.ts";

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const evidenceDir = resolve(process.argv[3] ?? "out/gt-evidence");
const outDir = join(evidenceDir, "download");
mkdirSync(outDir, { recursive: true });

// Tolerances, measured on the quarter-size blurred images (0..255 per channel; mean absolute difference, and the share of
// pixels where any channel is off by more than 40). The default holds for photo and flat-colour editions. Two editions
// carry more rasteriser noise by design and get their own, still far under what a different stub scores (45 and up):
//   risograph: 3 px pink/white and teal stripes whose phase moves by a sub-pixel (stripe edges are the whole difference);
//   letterpress: 1.3 px frame rules, which Chrome snaps to whole device pixels on screen and in the clone differently.
const TOLERANCE = { default: { mean: 7, bad: 0.06 }, risograph: { mean: 15, bad: 0.25 }, letterpress: { mean: 9, bad: 0.1 } };
const tol = (edition) => TOLERANCE[edition] ?? TOLERANCE.default;
const MEAN_MAX = TOLERANCE.default.mean;
const BAD_MAX = TOLERANCE.default.bad;
// The control (a different stub) must exceed at least half of the default tolerance.
const SCALE = 3;
const WIDTH = { portrait: 360, landscape: 560 };
// height / width
const ASPECT = { researched: 1.5, risograph: 1.5, minimal: 1.5, letterpress: 1 / 1.9, classic: 1 / 2.4 };
const LANDSCAPE = new Set(["letterpress", "classic"]);

const CASES_ALL = [
  { key: "pale", edition: "researched", finish: "foil", art: "image" },
  { key: "neathack", edition: "letterpress", finish: "matte", art: "image" },
  { key: "harbour", edition: "risograph", finish: "foil", art: "procedural" },
  { key: "pale", edition: "classic", finish: "matte", art: "image" },
  { key: "harbour", edition: "minimal", finish: "holo", art: "procedural" },
  // the researched painters lay a grain SVG over the art; it once made the export drop the whole art window
  { key: "neathack", edition: "researched", finish: "foil", art: "procedural" },
];
// DOWNLOAD_ONLY=<n> runs the first n cases at 390 only (for working on the renderer).
const ONLY = Number(process.env.DOWNLOAD_ONLY) || 0;
const CASES = ONLY ? CASES_ALL.slice(0, ONLY) : CASES_ALL;
const VIEWPORTS_ALL = [
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1440", width: 1440, height: 900, mobile: false },
];

const VIEWPORTS = ONLY ? VIEWPORTS_ALL.filter((v) => v.name === (process.env.DOWNLOAD_VP || "390")) : VIEWPORTS_ALL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
const T0 = Date.now();
const evidence = { chrome: chromePath(), base, tolerance: TOLERANCE, cases: [] };
const capturePlan = captureQualificationPlan(VIEWPORTS);
const qualification = new CaptureQualification(capturePlan, { diagnosticSubset: !!ONLY });
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}${process.env.DOWNLOAD_TIMING ? ` [+${Math.round((Date.now() - T0) / 1000)}s]` : ""}`);
  return ok;
}

// ---- the comparison runs in a blank tab (no CSP, a real canvas): same decoder and resampler people have ----
const COMPARE = `(() => {
  const load = async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return createImageBitmap(new Blob([bytes], { type: "image/png" }));
  };
  const cv = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });
  const half = (src, w, h) => {
    const c = cv(Math.round(w / 4), Math.round(h / 4));
    const x = c.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingQuality = "high";
    x.drawImage(src, 0, 0, c.width, c.height);
    return x.getImageData(0, 0, c.width, c.height);
  };
  const stats = (a, b, region) => {
    // region: {x,y,w,h} in 0..1; returns metrics inside and outside it (or everywhere when absent)
    const W = a.width, H = a.height;
    const acc = { in: [0, 0, 0], out: [0, 0, 0] };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = [Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])];
      const inside = region && x / W >= region.x && x / W <= region.x + region.w && y / H >= region.y && y / H <= region.y + region.h;
      const t = acc[inside ? "in" : "out"];
      t[0] += (d[0] + d[1] + d[2]) / 3;
      t[1] += Math.max(d[0], d[1], d[2]) > 40 ? 1 : 0;
      t[2] += 1;
    }
    const fin = (t) => (t[2] ? { mean: t[0] / t[2], bad: t[1] / t[2], n: t[2] } : { mean: 0, bad: 0, n: 0 });
    return { in: fin(acc.in), out: fin(acc.out) };
  };
  // the PNG laid over the screenshot (it is transparent at the die-cut edges, where the screen shows the desk)
  const overlay = (ref, png, w, h) => {
    const c = cv(w, h);
    const x = c.getContext("2d");
    x.drawImage(ref, 0, 0);
    x.imageSmoothingQuality = "high";
    x.drawImage(png, 0, 0, w, h);
    return c;
  };
  const shape = (png) => {
    const c = cv(png.width, png.height);
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(png, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height, band = Math.round(W * 0.035);
    let opaque = 0, edgeClear = 0, edgeN = 0, sum = 0, sum2 = 0;
    const colours = new Set();
    for (let y = 0; y < H; y++) for (let x2 = 0; x2 < W; x2++) {
      const i = (y * W + x2) * 4;
      const a = d[i + 3];
      const inBand = x2 < band || y < band || x2 >= W - band || y >= H - band;
      if (inBand) { edgeN++; if (a < 128) edgeClear++; }
      if (a > 250) {
        opaque++;
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += l; sum2 += l * l;
        if ((x2 + y) % 7 === 0) colours.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
      }
    }
    const mean = sum / Math.max(1, opaque);
    return { width: W, height: H, opaque: opaque / (W * H), edgeClear: edgeClear / Math.max(1, edgeN), sd: Math.sqrt(Math.max(0, sum2 / Math.max(1, opaque) - mean * mean)), colours: colours.size };
  };
  const sideBySide = (ref, over, png, a, b) => {
    const W = ref.width, H = ref.height, gap = 12;
    const c = cv(W * 3 + gap * 2, H);
    const x = c.getContext("2d");
    x.fillStyle = "#777"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(ref, 0, 0);
    // the PNG alone on a checker, so transparency reads as transparency
    for (let yy = 0; yy < H; yy += 16) for (let xx = 0; xx < W; xx += 16) { x.fillStyle = ((xx + yy) / 16) % 2 ? "#ddd" : "#fff"; x.fillRect(W + gap + xx, yy, 16, 16); }
    x.imageSmoothingQuality = "high";
    x.drawImage(png, W + gap, 0, W, H);
    // difference x4
    const d = x.createImageData(a.width, a.height);
    for (let i = 0; i < d.data.length; i += 4) { for (let k = 0; k < 3; k++) d.data[i + k] = 255 - Math.min(255, Math.abs(a.data[i + k] - b.data[i + k]) * 4); d.data[i + 3] = 255; }
    const dc = cv(a.width, a.height); dc.getContext("2d").putImageData(d, 0, 0);
    x.drawImage(dc, 0, 0, a.width, a.height, (W + gap) * 2, 0, W, H);
    return c.toDataURL("image/jpeg", 0.88); // JPEG: a PNG of this noisy picture is too big to send back over the protocol
  };
  return {
    // PNG against the screenshot
    async against(refB64, pngB64, wantSides) {
      const ref = await load(refB64), png = await load(pngB64);
      const over = overlay(ref, png, ref.width, ref.height);
      const a = half(ref, ref.width, ref.height), b = half(over, ref.width, ref.height);
      const s = stats(a, b).out;
      return { ...s, ref: { width: ref.width, height: ref.height }, shape: shape(png), sides: wantSides ? sideBySide(ref, over, png, a, b) : null };
    },
    // PNG against PNG at the first one's size, with a region (fractions) to split the difference
    async between(aB64, bB64, region) {
      const A = await load(aB64), B = await load(bB64);
      const w = Math.round(A.width / 4), h = Math.round(A.height / 4);
      const ia = half(A, A.width, A.height), ib = half(B, A.width, A.height);
      return { ...stats(ia, ib, region), w, h };
    },
  };
})()`;

// ---- helpers over the studio page ----
function pngSize(buf) {
  const sig = buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  return { sig, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const browserSessions = new DownloadBrowserSessions(outDir, capturePlan);
let baselineSession;
const layerObservers = [];
evidence.layerObserverCleanup = [];
try {
  // Startup provenance is outside the capture path; an executable path/inventory is not a measured browser version.
  try {
    baselineSession = await browserSessions.open("baseline");
    evidence.browser = baselineSession.version;
  } catch { check("baseline browser session setup completed", false, "baseline_session_setup_failed"); }
  try { evidence.nativeControls = await checkDownloadReceiptControls(check, mkdtempSync(join(outDir, "native-controls-"))); }
  catch { check("native receipt controls completed", false, "native_receipt_control_setup_failed"); }
  // Each comparison gets a fresh blank tab: one tab kept for the whole run stopped answering after many large images.
  const within = async (promise, what, ms = 60_000) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, no) => {
        timer = setTimeout(() => no(new Error(`${what} did not finish in ${ms / 1000} s`)), ms);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (const item of capturePlan) {
    const { viewport: vp, trial, kind } = item;
    const browserSessionId = browserSessionIdForPair(item);
    let page, layers;
    try {
    // The fixed extra pairs each launch once, with a separate process/profile and a collector
    // installed before application navigation. Setup failures never retry or skip later planned pairs.
    const session = kind === "baseline" ? baselineSession : await browserSessions.open(browserSessionId);
    if (!session) throw new Error("baseline_session_setup_failed");
    const { browser, receipts } = session;
    async function inTab(call) {
    const tab = await browser.newPage({ width: 800, height: 600 });
    try {
      await tab.goto("about:blank", { settle: 30 });
      await tab.send("Page.bringToFront");
      await tab.eval(`window.__cmp = ${COMPARE}; true`);
      return await within(tab.eval(call), "the comparison");
    } finally {
      await tab.close();
    }
    }
    const against = (ref, png, sides) => inTab(`window.__cmp.against(${JSON.stringify(ref.toString("base64"))}, ${JSON.stringify(png.toString("base64"))}, ${sides})`);
    const between = (a, b, region) => inTab(`window.__cmp.between(${JSON.stringify(a.toString("base64"))}, ${JSON.stringify(b.toString("base64"))}, ${JSON.stringify(region)})`);
    page = await browser.newPage({ width: vp.width, height: vp.height, dpr: 2, mobile: vp.mobile });
    await receipts.install(page); // observe before app code; every press below gets a fresh openStudio document
    layers = new DownloadLayerDiagnostics(page);
    layerObservers.push(layers);
    await layers.start(); // passive, bounded protocol setup before this page's first navigation
    const pngs = []; // [{ id, png }] for the control
    /** The studio, with the stored stub changed the way the editor stores it. */
    async function openStudio(c, mutate) {
      const id = `demo-${c.key}`;
      await page.send("Page.bringToFront");
      await page.goto(`${base}/new?demo=${c.key}`, { settle: 300 });
      if (!(await page.waitFor(`location.pathname === "/studio/${id}"`, 30000))) throw new Error(`demo ${c.key} did not reach the studio`);
      await page.eval(`(() => {
        const wall = JSON.parse(localStorage.getItem("ticketstub.wall.v1"));
        const s = wall.find((x) => x.id === ${JSON.stringify(id)});
        const v = s.versions.find((x) => x.id === s.currentVersionId);
        v.edition = ${JSON.stringify(c.edition)};
        s.finish = ${JSON.stringify(c.finish)};
        s.material = "print";
        ${mutate ?? ""}
        localStorage.setItem("ticketstub.wall.v1", JSON.stringify(wall));
        return true;
      })()`);
      await page.goto(`${base}/studio/${id}`, { settle: 1800 });
      return page.waitFor(`document.querySelector('figure[data-edition="${c.edition}"]')`, 15000);
    }
    /** The stub on the studio screen: the biggest figure of that edition, screenshotted in device pixels. */
    async function screenStub(c, { flip = false, checkout = false } = {}) {
      const figure = `[...document.querySelectorAll('figure[data-edition="${c.edition}"]')]
        .map((f) => ({ f, r: f.getBoundingClientRect() }))
        .filter((o) => o.r.width > 0 && o.r.height > 0)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0]?.f`;
      await page.send("Page.bringToFront");
      // The editor's stub is made of edit buttons (`all: unset` there drops the foil title's gradient), so the front is
      // compared with the same stub on the checkout screen, which shows it plain. The back has no buttons: the editor shows it.
      if (checkout) {
        await page.goto(`${base}/checkout/demo-${c.key}`, { settle: 1200 });
      }
      if (flip) {
        await page.eval(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /^(Flip|Show the back)$/i.test((x.textContent || "").trim()) && x.getBoundingClientRect().width > 0); if (b) b.click(); return !!b; })()`);
        await sleep(900);
      }
      // Checkout mounts its image after hydration, so loadEventFired and a stationary figure do not imply painted art.
      // Wait for the actual figure's fonts and pictures, then decode and allow the scroll/layout change to paint.
      const ready = await page.waitFor(`(() => {
        const f = ${figure};
        return f && document.fonts.status === "loaded" && [...f.querySelectorAll("img")].every((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
      })()`, 15000);
      if (!ready) throw new Error(`the ${c.edition} screen stub's fonts or images did not load in 15 s`);
      await within(page.eval(`(async () => {
        window.scrollTo(0, 0);
        const f = ${figure};
        await document.fonts.ready;
        const images = [...f.querySelectorAll("img")];
        const diagnostic = ${BEGIN_CAPTURE_PROVENANCE};
        diagnostic.sample("decode_start", f, images);
        await Promise.all(images.map((img) => img.decode()));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        diagnostic.sample("after_existing_decode_and_frames", f, [...f.querySelectorAll("img")]);
        return true;
      })()`), "the screen stub's decode and paint", 15000);
      if (checkout) {
        // the page settles in (it slides and fades): wait until the stub stops moving
        let last = "";
        for (let i = 0; i < 30; i++) {
          const now = await page.eval(`[...document.querySelectorAll('figure[data-edition]')].map((f) => { const r = f.getBoundingClientRect(); return [r.x, r.y, r.width].map(Math.round).join(","); }).join("|")`);
          if (now === last) break;
          last = now;
          await sleep(400);
        }
      }
      const captureId = randomUUID();
      const info = await page.eval(`(() => {
        const f = ${figure};
        if (!f) return null;
        const images = [...f.querySelectorAll("img")];
        if (document.fonts.status !== "loaded" || images.some((img) => !img.complete || !img.naturalWidth || !img.naturalHeight)) throw new Error("screen stub readiness changed before capture");
        // These bounded reads may flush layout; they observe presentation, never establish readiness.
        window.__ticketstubCaptureProvenance?.sample("before_original_capture", f, images, true, ${JSON.stringify(captureId)});
        const r = f.getBoundingClientRect();
        const t = f.querySelector('[class*="_title"]');
        const tr = t ? t.getBoundingClientRect() : null;
        return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, title: tr ? { x: (tr.x - r.x) / r.width, y: (tr.y - r.y) / r.height, w: tr.width / r.width, h: tr.height / r.height } : null, flipped: f.getAttribute("aria-label"), readiness: {
          fonts: document.fonts.status,
          images: images.map((img) => ({ complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight })),
        } };
      })()`);
      if (!info) return null;
      const beforeRequest = layers.mark(captureId, "before_screenshot_request");
      const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { x: info.x, y: info.y, width: info.width, height: info.height, scale: 1 } });
      const capturedAt = performance.now();
      const afterResponse = layers.mark(captureId, "after_screenshot_response");
      const png = Buffer.from(data, "base64");
      const sha256 = createHash("sha256").update(png).digest("hex");
      // Hashes and backend-node mapping occur only after the authoritative screenshot. Pre-first
      // presentation reads and passive event instrumentation are explicitly disclosed in its record.
      info.captureProvenance = await readCaptureProvenance(page, figure);
      info.layerProvenance = await layers.record({ captureId, beforeRequest, afterResponse, provenance: info.captureProvenance,
        figure, screenshotSha256: sha256 });
      return { png, info, capturedAt, figure, captureId, sha256 };
    }
    const diagnoseFailure = (matched, shot, tag) => captureFailureFrames({
      matched, page, figure: shot.figure, originalCapturedAt: shot.capturedAt,
      clip: { x: shot.info.x, y: shot.info.y, width: shot.info.width, height: shot.info.height, scale: 1 },
      save: async (offsetMs, png) => {
        const file = `${tag}-diagnostic-after-failure-${offsetMs}ms.png`;
        await writeFile(join(outDir, file), png, { signal: AbortSignal.timeout(2000) });
        return file;
      },
    });
    const press = (side) =>
      page.eval(`(() => {
        const els = [...document.querySelectorAll('[data-download="${side}"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; });
        const e = els[0];
        if (!e) return false;
        e.scrollIntoView({ block: "center" });
        e.click();
        return true;
      })()`);
    async function download(side, label) {
      try {
        const action = await receipts.arm(page, side, label);
        if (!(await press(side))) return { error: "no visible Download control" };
        const result = await receipts.download(action);
        return { ...result, receipt: { ...result.receipt, browserSessionId } };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    for (const c of kind === "baseline" ? CASES : CASES.filter((c) => c.key === "pale" && c.edition === "researched")) {
      const label = `${vp.name}px ${c.key}/${c.edition} (${c.art} art, ${c.finish})${trial ? ` cold-browser trial ${trial + 1}/3` : ""}`;
      const rec = { viewport: vp.name, trial, kind, browserSessionId, ...c };
      evidence.cases.push(rec);
      const tag = `${vp.name}-${c.key}-${c.edition}${trial ? `-cold-${trial}` : ""}`;
      const pairId = c.key === "pale" && c.edition === "researched" ? `${vp.name}:${trial}` : null;
      const failedBefore = failed;
      let exception = false;
      if (pairId) qualification.begin(pairId, browserSessionId);
      const retainFirst = (phase, shot) => {
        if (!shot) return;
        const file = `${tag}${phase === "edited" ? "-edited" : ""}-screen.png`;
        rec[phase === "edited" ? "editedScreen" : "screen"] = shot.info;
        retainFirstCapture({ directory: outDir, file, png: shot.png, captureId: shot.captureId, sha256: shot.sha256, qualification, pairId, phase });
      };
      try {
        // Only the baseline's first studio load/download is throttled. Additional pairs start in new
        // processes/profiles; their edited capture shares that pair's cache. None proves compositor readiness.
        const cold = kind === "baseline" && !evidence.cases.slice(0, -1).length;
        if (cold) {
          await page.send("Emulation.setCPUThrottlingRate", { rate: 6 });
          await page.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 200_000 });
        }
        const opened = await openStudio(c);
        const got = opened ? await download("front", `${label}: original front`) : { error: "no studio" };
        rec.downloadReceipt = got.receipt;
        if (cold) {
          await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        }
        if (!check(`${label}: the stub is on the studio desk${cold ? " (first load, throttled)" : ""}`, opened)) continue;
        if (!check(`${label}: the Download button saved a file`, !got.error, got.error)) continue;
        const shot = await screenStub(c, { checkout: true });
        retainFirst("original", shot);
        if (!check(`${label}: the on-screen stub was captured`, !!shot)) continue;
        const sz = pngSize(got.buf);
        const wantW = (LANDSCAPE.has(c.edition) ? WIDTH.landscape : WIDTH.portrait) * SCALE;
        const wantH = Math.round(wantW * ASPECT[c.edition]);
        check(`${label}: file name is ticketstub-<slug>-<date>.png (${got.name})`, /^ticketstub-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.png$/.test(got.name));
        check(`${label}: a PNG, ${sz.width} x ${sz.height} (want ${wantW} x ${wantH})`, sz.sig && sz.width === wantW && Math.abs(sz.height - wantH) <= 1, JSON.stringify(sz));
        writeFileSync(join(outDir, `${tag}.png`), got.buf);
        const m = await against(shot.png, got.buf, true);
        rec.diff = { mean: +m.mean.toFixed(2), bad: +m.bad.toFixed(4) };
        rec.shape = m.shape;
        writeFileSync(join(outDir, `${tag}-sidebyside.jpg`), Buffer.from(m.sides.split(",")[1], "base64"));
        check(`${label}: decodes at ${m.shape.width} x ${m.shape.height}, not blank (tone spread ${m.shape.sd.toFixed(0)}, ${m.shape.colours} colours, ${(m.shape.opaque * 100).toFixed(0)}% opaque)`, m.shape.width === sz.width && m.shape.sd > 12 && m.shape.colours > 30 && m.shape.opaque > 0.85, JSON.stringify(m.shape));
        check(`${label}: the same shape as the screen (aspect ${(m.shape.width / m.shape.height).toFixed(3)} vs ${(shot.info.width / shot.info.height).toFixed(3)})`, Math.abs(m.shape.width / m.shape.height - shot.info.width / shot.info.height) < 0.01);
        if (c.edition === "researched") check(`${label}: the perforated edge is cut out (${(m.shape.edgeClear * 100).toFixed(1)}% of the border is clear)`, m.shape.edgeClear > 0.015);
        const matched = check(`${label}: matches the screen (mean ${m.mean.toFixed(2)} <= ${tol(c.edition).mean}, differing pixels ${(m.bad * 100).toFixed(2)}% <= ${(tol(c.edition).bad * 100).toFixed(0)}%)`, m.mean <= tol(c.edition).mean && m.bad <= tol(c.edition).bad, JSON.stringify({ mean: m.mean, bad: m.bad }));
        if (pairId) qualification.compared(pairId, "original", matched, m);
        if (!matched) rec.captureFailure = await diagnoseFailure(matched, shot, tag);
        const other = pngs.find((p) => p.edition === c.edition && p.key !== c.key) ?? pngs.find((p) => p.edition !== c.edition);
        if (other) {
          const ctl = await against(shot.png, other.png, false);
          check(`${label}: control, another stub's PNG does not match (mean ${ctl.mean.toFixed(1)}, differing ${(ctl.bad * 100).toFixed(1)}%)`, ctl.mean > MEAN_MAX * 0.5 || ctl.bad > BAD_MAX * 0.5);
        }
        pngs.push({ ...c, png: got.buf });

        // an edit shows: title changed in the stored stub, the next download differs there and matches the new screen
        const first = shot;
        const reversed = `(() => { s.event.title = s.event.title.split(" ").reverse().join(" "); })();`;
        if (!check(`${label}: reopened with the title edited`, await openStudio(c, reversed))) continue;
        const got2 = await download("front", `${label}: edited front`);
        rec.editedDownloadReceipt = got2.receipt;
        const shot2 = await screenStub(c, { checkout: true });
        retainFirst("edited", shot2);
        if (!check(`${label}: the edited stub downloads`, !got2.error && !!shot2, got2.error)) continue;
        writeFileSync(join(outDir, `${tag}-edited.png`), got2.buf);
        const region = first.info.title;
        const d = await between(got.buf, got2.buf, region);
        rec.edit = { inside: +d.in.bad.toFixed(3), outside: +d.out.bad.toFixed(3) };
        check(`${label}: the edited title shows in the PNG (title region differs ${(d.in.bad * 100).toFixed(1)}%, the rest ${(d.out.bad * 100).toFixed(2)}%)`, !!region && d.in.bad > 0.05 && d.out.bad < 0.02, JSON.stringify(d));
        const m2 = await against(shot2.png, got2.buf, true);
        rec.editedDiff = { mean: +m2.mean.toFixed(2), bad: +m2.bad.toFixed(4) };
        writeFileSync(join(outDir, `${tag}-edited-sidebyside.jpg`), Buffer.from(m2.sides.split(",")[1], "base64"));
        const editedMatched = check(`${label}: the edited PNG matches the edited screen (mean ${m2.mean.toFixed(2)}, differing ${(m2.bad * 100).toFixed(2)}%)`, m2.mean <= tol(c.edition).mean && m2.bad <= tol(c.edition).bad);
        if (pairId) qualification.compared(pairId, "edited", editedMatched, m2);
        if (!editedMatched) rec.editedCaptureFailure = await diagnoseFailure(editedMatched, shot2, `${tag}-edited`);

        // the back, for the first two editions of each viewport (a landscape and a portrait)
        if (kind === "baseline" && (c.key === "pale" && c.edition === "researched" || c.edition === "letterpress")) {
          if (!(await openStudio(c))) continue;
          const back = await download("back", `${label}: back`);
          rec.backDownloadReceipt = back.receipt;
          if (!check(`${label}: the back downloads (${back.name ?? back.error})`, !back.error && /-back\.png$/.test(back.name ?? ""), back.error)) continue;
          const sh = await screenStub(c, { flip: true });
          const bm = sh ? await against(sh.png, back.buf, true) : null;
          if (!check(`${label}: the back is on screen to compare`, !!bm)) continue;
          writeFileSync(join(outDir, `${tag}-back.png`), back.buf);
          writeFileSync(join(outDir, `${tag}-back-screen.png`), sh.png);
          writeFileSync(join(outDir, `${tag}-back-sidebyside.jpg`), Buffer.from(bm.sides.split(",")[1], "base64"));
          rec.backScreen = sh.info;
          rec.backDiff = { mean: +bm.mean.toFixed(2), bad: +bm.bad.toFixed(4) };
          const backMatched = check(`${label}: the back matches the screen (mean ${bm.mean.toFixed(2)}, differing ${(bm.bad * 100).toFixed(2)}%, not blank sd ${bm.shape.sd.toFixed(0)})`, bm.mean <= tol(c.edition).mean && bm.bad <= tol(c.edition).bad && bm.shape.sd > 12);
          if (!backMatched) rec.backCaptureFailure = await diagnoseFailure(backMatched, sh, `${tag}-back`);
        }
      } catch (e) {
        exception = true;
        rec.exception = "case_did_not_complete";
        check(`${label}: ran to completion`, false, e instanceof Error ? e.message : String(e));
      } finally {
        if (pairId) qualification.finish(pairId, failed - failedBefore, exception);
      }
    }

    if (kind === "baseline" && vp.name === "390") {
      const c = CASES[0];
      const label = `${vp.name}px delivery paths`;
      try {
        const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
        await page.send("Emulation.setUserAgentOverride", { userAgent: IPHONE, platform: "iPhone" });
        // 1. iPhone with file sharing: the share sheet gets one PNG File
        await openStudio(c);
        await page.eval(`(() => { window.__shared = null; navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = { n: d.files.length, name: d.files[0].name, type: d.files[0].type, size: d.files[0].size }; }; return true; })()`);
        const shareAction = await receipts.arm(page, "front", `${label}: share`);
        await press("front");
        const shared = await page.waitFor("window.__shared", 20000).then(() => page.eval("window.__shared"));
        check(`${label}: iPhone hands one PNG file to the share sheet (${JSON.stringify(shared)})`, !!shared && shared.n === 1 && shared.type === "image/png" && shared.size > 5000 && /^ticketstub-.*\.png$/.test(shared.name));
        check(`${label}: iPhone sharing saves no download`, !!shared && await receipts.noDownload(page, shareAction, "share"));
        await sleep(300);
        check(`${label}: the screen says it was saved`, await page.waitFor(`document.body.innerText.includes("Saved")`, 3000));
        // 2. iPhone, share sheet closed: a cancel, no error
        await openStudio(c);
        await page.eval(`(() => { window.__cancelled = false; navigator.canShare = () => true; navigator.share = async () => { window.__cancelled = true; throw Object.assign(new Error("closed"), { name: "AbortError" }); }; return true; })()`);
        const cancelAction = await receipts.arm(page, "front", `${label}: share cancelled`);
        await press("front");
        const cancelled = await page.waitFor("window.__cancelled", 20000);
        const cancelTerminal = cancelled && await receipts.noDownload(page, cancelAction, "cancelled");
        check(`${label}: iPhone closing the share sheet is not an error`, cancelTerminal && await page.eval(`!document.querySelector("[data-failure]")`));
        // 3. iPhone without file sharing: the picture opens in a tab
        await openStudio(c);
        await page.eval(`(() => { window.__opened = null; navigator.canShare = undefined; window.open = (u) => { window.__opened = String(u); return {}; }; return true; })()`);
        const tabAction = await receipts.arm(page, "front", `${label}: tab`);
        await press("front");
        const opened = await page.waitFor("window.__opened", 20000).then(() => page.eval("window.__opened"));
        check(`${label}: iPhone without file sharing opens the blob in a tab`, typeof opened === "string" && opened.startsWith("blob:"), String(opened));
        check(`${label}: the screen tells them to press and hold`, await page.waitFor(`document.body.innerText.includes("Press and hold")`, 3000));
        if (typeof opened === "string" && opened.startsWith("blob:")) await receipts.noDownload(page, tabAction, "tab");
        await page.send("Emulation.setUserAgentOverride", { userAgent: "" });
        // 4. art that cannot be read: a message, no file
        await openStudio(c, `v.art = { kind: "image", src: "https://127.0.0.1:9/never.png", seed: 1, provenance: "simulated" };`);
        const failureAction = await receipts.arm(page, "front", `${label}: unreadable art`);
        await press("front");
        // "unknown" also renders data-failure and re-enables its button. Only the actual bad-image
        // outcome in this armed control's root can prove that this operation ended without a file.
        const failed$ = await receipts.waitForFailure(page, failureAction, MESSAGES.bad_image.message, 20000);
        check(`${label}: unreadable art ends in a message, not a broken file`, failed$ && await receipts.noDownload(page, failureAction, "failed", { failureMessage: MESSAGES.bad_image.message }), failed$ ? "a file was saved" : "no completed bad-image message");
        await page.eval(`localStorage.removeItem("ticketstub.wall.v1")`); // the demo stubs come back as they were
        evidence.failureMessage = await page.eval(`document.querySelector("[data-failure]")?.innerText ?? null`);
        console.log(`note unreadable-art message: ${JSON.stringify(evidence.failureMessage)}`);
      } catch (e) {
        check(`${label}: ran to completion`, false, e instanceof Error ? e.message : String(e));
      }
    }
    } catch (e) {
      browserSessions.fault(browserSessionId, "page_setup_or_execution_failed");
      check(`${vp.name}px ${kind} trial ${trial + 1}: page setup or execution completed`, false, e instanceof Error ? e.message : String(e));
    } finally {
      if (layers) evidence.layerObserverCleanup.push(await layers.stop());
      try { if (page) await page.close(); }
      catch (e) { browserSessions.fault(browserSessionId, "page_cleanup_failed"); check(`${vp.name}px ${kind} trial ${trial + 1}: page closed`, false, e instanceof Error ? e.message : String(e)); }
      if (kind !== "baseline") await browserSessions.close(browserSessionId);
    }
  }
} finally {
  for (const layers of layerObservers) if (!layers.stopped) evidence.layerObserverCleanup.push(await layers.stop());
  try { await browserSessions.closeAll(); }
  catch (e) { check("browser completed bounded shutdown", false, e instanceof Error ? e.message : String(e)); }
  // Unknown, duplicate and late deliveries remain failures, including arrivals after a no-download terminal.
  const { downloadReceipts, ...sessionEvidence } = browserSessions.snapshot();
  evidence.browserSessions = sessionEvidence;
  evidence.downloadReceipts = downloadReceipts;
  check("all native downloads have one current document/action/Blob receipt and completed matching GUID", evidence.downloadReceipts.violations.length === 0, JSON.stringify(evidence.downloadReceipts.violations));
  evidence.captureQualification = qualification.snapshot(sessionEvidence);
  check("all fixed original/edited first-capture pairs completed and passed", evidence.captureQualification.passed,
    JSON.stringify(evidence.captureQualification));
}
evidence.passed = passed;
evidence.failed = failed;
writeFileSync(join(outDir, "download-evidence.json"), JSON.stringify(evidence, null, 2));
console.log(`\ndownload: ${passed} passed, ${failed} failed. Samples: ${outDir}`);
process.exit(failed ? 1 : 0);
