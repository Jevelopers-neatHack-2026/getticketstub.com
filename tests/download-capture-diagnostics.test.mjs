import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { BEGIN_CAPTURE_PROVENANCE, browserProvenance, captureFailureFrames, readCaptureProvenance } from "../scripts/lib/download-capture-diagnostics.mjs";

const SECRET = "private-token-for-diagnostic-redaction";
const secretUrl = `https://user:${SECRET}@private.invalid/art.png?key=${SECRET}#${SECRET}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const plain = (value) => JSON.parse(JSON.stringify(value));
const CAPTURE = "00000000-0000-0000-0000-000000000001";

function browserFixture({ crypto = webcrypto } = {}) {
  const reads = { layout: 0, style: 0 };
  const node = (src = secretUrl) => ({ src, currentSrc: src, complete: true, naturalWidth: 1067, naturalHeight: 1600, isConnected: true,
    getBoundingClientRect() { reads.layout++; return { x: 1, y: 2, width: 300, height: 450 }; },
    getAnimations() { return [{ playState: "running", currentTime: 4, id: SECRET }]; },
  });
  const figure = node("");
  const context = { window: {}, crypto, TextEncoder, performance: { now: () => 100, timeOrigin: 1000 },
    document: { fonts: { status: "loaded" }, visibilityState: "visible" },
    getComputedStyle() {
      reads.style++;
      return { display: "block", visibility: "visible", opacity: "1", transform: `url(${secretUrl})`, transformStyle: "preserve-3d",
        perspective: "none", backfaceVisibility: "hidden", filter: `url(${secretUrl})`, maskImage: `url(${secretUrl})`, clipPath: `url(${secretUrl})`,
        contentVisibility: "visible", objectFit: "cover", animationName: SECRET };
    },
  };
  const collector = runInNewContext(BEGIN_CAPTURE_PROVENANCE, context);
  return { collector, reads, node, figure, context };
}

test("identity-only decode boundaries read no layout/style and serialized evidence contains only source digests", async () => {
  const { collector, reads, node, figure } = browserFixture();
  const image = node(); image.parentElement = figure;
  collector.sample("decode_start", figure, [image]);
  collector.sample("after_existing_decode_and_frames", figure, [image]);
  collector.sample("before_original_capture", figure, [image]);
  assert.deepEqual(reads, { layout: 0, style: 0 });
  collector.sample("after_original_capture", figure, [image], true);
  const record = plain(await collector.read());
  assert.ok(reads.layout > 0 && reads.style > 0);
  for (const snapshot of record.snapshots) {
    assert.equal(snapshot.images[0].src.sha256, hash(secretUrl));
    assert.equal(snapshot.images[0].currentSrc.sha256, hash(secretUrl));
  }
  const serialized = JSON.stringify(record);
  for (const privateValue of [SECRET, "private.invalid", "https:", "url(", "rawSrc", "rawCurrentSrc"]) assert.ok(!serialized.includes(privateValue), privateValue);
  assert.equal(record.snapshots[3].images[0].styles.transform, "other");
  assert.equal(record.snapshots[3].images[0].styles.hasMask, true);
});

test("the final pre-first sample records outer ancestors and active transitions without URL, keyframe or name leakage", async () => {
  const { collector, reads, node, figure, context } = browserFixture();
  const image = node(), outer = node("");
  image.parentElement = figure; figure.parentElement = outer;
  context.document.documentElement = outer;
  figure.querySelectorAll = () => [image];
  outer.getAnimations = () => [{ transitionProperty: SECRET, playState: "running", pending: true, currentTime: 32, startTime: 10, playbackRate: 1,
    effect: { getKeyframes() { throw new Error("keyframes must never be read"); } } }];
  const previousStyle = context.getComputedStyle;
  context.getComputedStyle = (n) => ({ ...previousStyle(n), visibility: n === outer ? "hidden" : "visible", opacity: n === outer ? "0.25" : "1", transform: "matrix(1, 0, 0, 1, 3, 4)",
    getPropertyValue: (name) => ({ "--rx": "1.250deg", "--ry": `url(${secretUrl})`, "--px": "0.25", "--py": "0" })[name] });
  collector.sample("decode_start", figure, [image]);
  assert.deepEqual(reads, { layout: 0, style: 0 });
  collector.sample("before_original_capture", figure, [image], true, CAPTURE);
  const record = plain(await collector.read());
  const before = record.snapshots[1];
  assert.equal(record.sampledStylesOnlyAfterCapture, false);
  assert.equal(record.instrumentationMayAffectFirstCapture, true);
  assert.equal(record.presentationReadsMayFlushLayout, true);
  assert.equal(before.presentationRead, "before_first_screenshot");
  assert.equal(before.images[0].ancestors.length, 2);
  assert.equal(before.images[0].ancestorBoundary, "document_root");
  assert.equal(before.images[0].ancestors[1].styles.visibility, "hidden");
  assert.equal(before.images[0].ancestors[1].styles.opacity, 0.25);
  assert.equal(before.images[0].ancestors[1].styles.animations[0].kind, "css_transition");
  assert.equal(before.images[0].ancestors[1].styles.animations[0].pending, true);
  assert.deepEqual(before.images[0].styles.tilt.rx, { status: "recorded", value: 1.25, unit: "deg" });
  assert.deepEqual(before.images[0].styles.tilt.px, { status: "recorded", value: 0.25, unit: "number" });
  assert.equal(before.images[0].styles.tilt.ry.status, "omitted_unrecognized_value");
  assert.equal(record.animationObservationDoesNotIncludeJavaScriptFrameLoops, true);
  assert.equal(reads.style, 3); // one read per retained node, including the shared figure ancestor
  assert.ok(!JSON.stringify(record).includes(SECRET));
  assert.equal(collector.nodesForCapture(CAPTURE, figure)[0], figure);
  assert.equal(collector.releaseCapture(CAPTURE), true);
  assert.equal(collector.nodesForCapture(CAPTURE, figure), null);
});

test("retained pre-first references refuse same-source replacement, disconnect and moved ancestry", () => {
  for (const mutation of ["image", "figure", "disconnected", "ancestry"]) {
    const { collector, node, figure } = browserFixture();
    const original = node(), parent = node("");
    original.parentElement = figure; figure.parentElement = parent;
    let images = [original];
    figure.querySelectorAll = () => images;
    collector.sample("before_original_capture", figure, images, true, CAPTURE);
    assert.ok(collector.nodesForCapture(CAPTURE, figure));
    if (mutation === "image") images = [node(original.src)];
    if (mutation === "disconnected") original.isConnected = false;
    if (mutation === "ancestry") figure.parentElement = node("");
    assert.equal(collector.nodesForCapture(CAPTURE, mutation === "figure" ? node("") : figure), null, mutation);
  }
});

test("pre-first evidence retains bounded nodes and explicitly reports ancestor, animation and identity omissions", async () => {
  const { collector, node, figure } = browserFixture();
  const images = Array.from({ length: 10 }, () => node());
  for (const image of images) {
    let last = image;
    for (let n = 0; n < 18; n++) { const parent = node(""); last.parentElement = parent; last = parent; }
  }
  images[0].getAnimations = () => Array.from({ length: 7 }, () => ({ playState: "running", currentTime: 1 }));
  figure.querySelectorAll = () => images;
  collector.sample("before_original_capture", figure, images, true, CAPTURE);
  const record = plain(await collector.read());
  const image = record.snapshots[0].images[0];
  assert.equal(record.preCaptureNodeIds.length, 48);
  assert.ok(record.nodeRetentionOmissions > 0);
  assert.equal(image.ancestors.length, 16); assert.equal(image.ancestorsTruncated, true);
  assert.equal(image.ancestorBoundary, "limit");
  assert.equal(image.styles.animationCount, 7); assert.equal(image.styles.animationsTruncated, true);
  assert.equal(image.styles.animations.length, 4);
  assert.equal(collector.nodeStatusForCapture(CAPTURE, figure).status, "partial");
});

test("an unavailable pre-first style read still discloses its timing effect and duplicate bindings cannot reuse references", async () => {
  const { collector, node, figure, context } = browserFixture();
  const image = node(); figure.querySelectorAll = () => [image];
  context.getComputedStyle = () => { throw new Error(secretUrl); };
  collector.sample("before_original_capture", figure, [image], true, CAPTURE);
  const first = plain(await collector.read());
  assert.equal(first.instrumentationMayAffectFirstCapture, true);
  assert.equal(first.snapshots[0].figure.presentationStatus, "unavailable");
  assert.ok(!JSON.stringify(first).includes(SECRET));
  collector.sample("before_original_capture", figure, [image], true, "00000000-0000-0000-0000-000000000002");
  assert.equal(collector.nodesForCapture(CAPTURE, figure), null);
  assert.equal((await collector.read()).captureBindingStatus, "duplicate_capture_binding");
});

test("a source change and a same-source node replacement remain distinguishable", async () => {
  const { collector, node, figure } = browserFixture();
  const original = node("data:image/png;base64,first-private-art");
  collector.sample("decode_start", figure, [original]);
  original.src = original.currentSrc = "data:image/png;base64,second-private-art";
  collector.sample("after_existing_decode_and_frames", figure, [original]);
  const replacement = node(original.src);
  collector.sample("before_original_capture", figure, [replacement]);
  const record = plain(await collector.read());
  const [a, b, c] = record.snapshots.map((s) => s.images[0]);
  assert.equal(a.nodeId, b.nodeId);
  assert.notEqual(a.src.sha256, b.src.sha256);
  assert.notEqual(b.nodeId, c.nodeId);
  assert.equal(b.src.sha256, c.src.sha256);
  assert.ok(!JSON.stringify(record).includes("data:image"));
  assert.ok(!JSON.stringify(record).includes("private-art"));
});

test("image/snapshot/source limits and an empty image set are explicit, without promoting readiness to a pass", async () => {
  const { collector, node, figure } = browserFixture();
  collector.sample("decode_start", figure, []);
  const images = Array.from({ length: 10 }, () => node(`data:image/png;base64,${SECRET}${"x".repeat(65536)}`));
  for (let i = 0; i < 8; i++) collector.sample(`bounded_${i}`, figure, images);
  const record = plain(await collector.read());
  assert.equal(record.snapshots.length, 6);
  assert.equal(record.snapshotsTruncated, true);
  assert.equal(record.snapshotsOmitted, 3);
  assert.equal(record.snapshots[0].imageCount, 0);
  assert.deepEqual(record.snapshots[0].images, []);
  assert.equal(record.snapshots[1].imageCount, 10);
  assert.equal(record.snapshots[1].imagesTruncated, true);
  assert.equal(record.snapshots[1].images.length, 8);
  assert.equal(record.snapshots[1].images[0].src.status, "omitted_too_long");
  assert.ok(!JSON.stringify(record).includes(SECRET));
  assert.equal(Object.hasOwn(record, "passed"), false);
});

test("hash failures and CDP errors expose fixed unavailable codes without raw error/source text", async () => {
  const { collector, node, figure } = browserFixture({ crypto: { subtle: { digest() { throw new Error(secretUrl); } } } });
  collector.sample("decode_start", figure, [node()]);
  const record = plain(await collector.read());
  assert.equal(record.snapshots[0].images[0].src.status, "digest_unavailable");
  assert.ok(!JSON.stringify(record).includes(SECRET));
  const failed = await readCaptureProvenance({ eval: async () => { throw new Error(secretUrl); } }, "null");
  assert.deepEqual(failed, { status: "unavailable" });
});

test("browser provenance comes from Browser.getVersion and records unavailable transport honestly", async () => {
  const calls = [];
  const version = { protocolVersion: "1.3", product: "HeadlessChrome/141.0.7390.37", revision: "test", userAgent: "test-agent", jsVersion: "14.1" };
  const recorded = await browserProvenance({ send: async (method) => { calls.push(method); return version; } });
  assert.deepEqual(calls, ["Browser.getVersion"]);
  assert.equal(recorded.product, version.product);
  assert.equal(recorded.status, "recorded");
  assert.deepEqual(recorded.userAgent, { status: "hashed", sha256: hash(version.userAgent) });
  const privateMetadata = await browserProvenance({ send: async () => ({ protocolVersion: secretUrl, product: secretUrl,
    revision: `data:text/plain,${SECRET}`, userAgent: secretUrl, jsVersion: SECRET }) });
  assert.ok(!JSON.stringify(privateMetadata).includes(SECRET));
  assert.ok(!JSON.stringify(privateMetadata).includes("data:"));
  assert.ok(!JSON.stringify(privateMetadata).includes("https:"));
  assert.equal(privateMetadata.product, "omitted_unrecognized_format");
  const failed = await browserProvenance({ send: async () => { throw new Error(secretUrl); } });
  assert.deepEqual(failed, { status: "unavailable", method: "Browser.getVersion" });
});

function frameFixture(send) {
  let time = 1000;
  const calls = [], waits = [], saves = [];
  const clip = Object.freeze({ x: 4, y: 5, width: 200, height: 300, scale: 1 });
  const options = { matched: false, figure: "null", clip, originalCapturedAt: 700, now: () => time,
    wait: async (ms) => { waits.push(ms); time += ms; },
    page: { send: async (method, params) => { calls.push({ method, params }); return send ? send(calls.length) : { data: Buffer.from("later-visible-art").toString("base64") }; },
      eval: async () => ({ status: "recorded" }) },
    save: async (offset, png) => { saves.push({ offset, bytes: png.toString() }); return `diagnostic-${offset}.png`; },
  };
  return { options, calls, waits, saves, clip, advance: (ms) => { time += ms; } };
}

test("passing original comparison causes zero diagnostic work", async () => {
  const f = frameFixture();
  assert.equal(await captureFailureFrames({ ...f.options, matched: true }), null);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.waits, []); assert.deepEqual(f.saves, []);
});

test("failed-comparison diagnostics save two separate frames with the original clip and absolute offsets", async () => {
  const f = frameFixture();
  const record = await captureFailureFrames(f.options);
  assert.equal(record.originalComparison, "failed");
  assert.equal(record.authoritativeFrame, "original");
  assert.equal(record.frames.length, 2);
  assert.deepEqual(f.waits, [100, 400]);
  assert.deepEqual(record.frames.map((frame) => frame.startedAfterFailureMs), [100, 500]);
  assert.deepEqual(record.frames.map((frame) => frame.startedAfterOriginalMs), [400, 800]);
  for (const call of f.calls) assert.deepEqual(call, { method: "Page.captureScreenshot", params: { format: "png", captureBeyondViewport: false, clip: f.clip } });
  assert.ok(f.saves.every((s) => s.bytes === "later-visible-art"));
  assert.equal(Object.hasOwn(record, "png"), false);
});

test("first capture error still permits exactly the second diagnostic attempt without error text", async () => {
  const f = frameFixture((n) => { if (n === 1) { f.advance(900); throw new Error(secretUrl); } return { data: Buffer.from("recovered").toString("base64") }; });
  const record = await captureFailureFrames(f.options);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(record.frames.map((f) => f.status), ["unavailable", "recorded"]);
  assert.deepEqual(f.waits, [100, 0]);
  assert.deepEqual(record.frames.map((f) => f.startedAfterFailureMs), [100, 1000]);
  assert.ok(!JSON.stringify(record).includes(SECRET));
  assert.equal(record.originalComparison, "failed");
});

test("a first diagnostic timeout is bounded and does not cancel the second attempt", { timeout: 5000 }, async () => {
  const f = frameFixture((n) => n === 1 ? new Promise(() => {}) : { data: Buffer.from("recovered").toString("base64") });
  const record = await captureFailureFrames(f.options);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(record.frames.map((f) => f.status), ["unavailable", "recorded"]);
  assert.equal(record.originalComparison, "failed");
});

test("failed diagnostic writes and provenance remain unavailable evidence, not new assertions", async () => {
  const f = frameFixture();
  let saves = 0;
  f.options.save = async () => { if (++saves === 1) throw new Error(secretUrl); return "later.png"; };
  f.options.page.eval = async () => { throw new Error(secretUrl); };
  const record = await captureFailureFrames(f.options);
  assert.equal(f.calls.length, 2); assert.equal(saves, 2);
  assert.deepEqual(record.frames.map((f) => f.status), ["unavailable", "recorded"]);
  assert.deepEqual(record.frames[1].provenance, { status: "unavailable" });
  assert.ok(!JSON.stringify(record).includes(SECRET));
  assert.equal(record.originalComparison, "failed");
});

test("a hanging diagnostic write is bounded and the second attempt still runs", { timeout: 5000 }, async () => {
  const f = frameFixture();
  let saves = 0;
  f.options.save = async () => ++saves === 1 ? new Promise(() => {}) : "later.png";
  const record = await captureFailureFrames(f.options);
  assert.equal(f.calls.length, 2); assert.equal(saves, 2);
  assert.deepEqual(record.frames.map((f) => f.status), ["unavailable", "recorded"]);
  assert.equal(record.originalComparison, "failed");
});
