import test from "node:test";
import assert from "node:assert/strict";
import { DownloadLayerDiagnostics } from "../scripts/lib/download-layer-diagnostics.mjs";

const CAPTURE = "00000000-0000-0000-0000-000000000001";
const SECRET = "https://user:private-password@private.invalid/art?token=private-token";
const frame = { id: "aaaa", loaderId: "bbbb" };
const layer = (n = 1) => ({ layerId: String(n), backendNodeId: n + 100, offsetX: 0, offsetY: 1,
  width: 300, height: 450, paintCount: 2, drawsContent: true, unknownPrivateField: SECRET });

function fixture({ send, identity, timeoutMs = 100 } = {}) {
  const listeners = new Set(), calls = [];
  let time = 0, statusCalls = 0;
  const page = { sid: "this-session", conn: { on(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async send(method, params) {
      calls.push({ method, params });
      const override = send?.(method, params);
      if (override !== undefined) return await override;
      if (method === "Runtime.evaluate") return { result: { objectId: "array-ref", subtype: "array" } };
      if (method === "Runtime.getProperties") return { result: [0, 1].map((n) => ({ name: String(n), value: { objectId: `node-${n}` } })) };
      if (method === "DOM.describeNode") return { node: { backendNodeId: Number(params.objectId.slice(-1)) + 101, attributes: ["src", SECRET], nodeValue: SECRET } };
      return {};
    },
    async eval(expression) {
      if (expression.includes("releaseCapture")) { calls.push({ method: "releaseCapture" }); return true; }
      statusCalls++;
      return identity?.(statusCalls) ?? { status: "recorded", nodeIds: [1, 2] };
    },
  };
  const observer = new DownloadLayerDiagnostics(page, { now: () => time, timeoutMs });
  const emit = (method, params = {}, sessionId = page.sid) => { time += 1; for (const listener of listeners) listener({ method, params, sessionId }); };
  const mark = (stage) => observer.mark(CAPTURE, stage);
  const record = (beforeRequest, afterResponse, extra = {}) => observer.record({ captureId: CAPTURE, beforeRequest, afterResponse,
    provenance: { captureId: CAPTURE, captureBindingStatus: "recorded", preCaptureNodeIds: [1, 2] }, figure: "null", screenshotSha256: "a".repeat(64), ...extra });
  return { observer, emit, mark, record, calls, listeners };
}

test("request/response boundaries remain immutable when later paint and navigation events arrive", async () => {
  const f = fixture();
  await f.observer.start();
  f.emit("Page.frameNavigated", { frame });
  f.emit("LayerTree.layerTreeDidChange", { layers: [layer()] });
  f.emit("LayerTree.layerPainted", { layerId: "1", clip: { x: 0, y: 0, width: 300, height: 450 } }, "unrelated-session");
  const before = f.mark("before_screenshot_request");
  f.emit("LayerTree.layerPainted", { layerId: "1", clip: { x: 0, y: 0, width: 300, height: 450 } });
  const after = f.mark("after_screenshot_response");
  const beforeBytes = JSON.stringify(before), afterBytes = JSON.stringify(after);
  const record = await f.record(before, after);
  f.emit("LayerTree.layerTreeDidChange", { layers: [layer(9)] });
  f.emit("Page.frameNavigated", { frame: { id: "cccc", loaderId: "dddd" } });
  assert.equal(JSON.stringify(record.beforeRequest), beforeBytes);
  assert.equal(JSON.stringify(record.afterResponse), afterBytes);
  assert.equal(before.events.length, 1);
  assert.equal(after.events.length, 2);
  assert.equal(after.sequence, before.sequence + 1);
  assert.equal(record.status, "associated");
  assert.deepEqual(record.mapping.nodes, [{ nodeId: 1, backendNodeId: 101, status: "recorded" }, { nodeId: 2, backendNodeId: 102, status: "recorded" }]);
  assert.equal(record.eventsAreNotCompositorReadiness, true);
  assert.ok(!JSON.stringify(record).includes("private"));
  assert.ok(Object.isFrozen(record.beforeRequest.tree.layers));
  assert.ok(f.calls.some((call) => call.method === "Runtime.releaseObjectGroup"));
  assert.ok(f.calls.some((call) => call.method === "releaseCapture"));
  await f.observer.stop();
  assert.equal(f.listeners.size, 0);
});

test("caps, malformed fields and absent compositor data are explicit rather than no-paint claims", async () => {
  const f = fixture(); await f.observer.start();
  f.emit("LayerTree.layerTreeDidChange", { layers: Array.from({ length: 70 }, (_, n) => layer(n + 1)) });
  for (let n = 0; n < 130; n++) f.emit("LayerTree.layerPainted", { layerId: "1", clip: { x: 0, y: 0, width: 3, height: 4 } });
  const capped = f.mark("before_screenshot_request");
  assert.equal(capped.events.length, 128);
  assert.equal(capped.completeness.eventCount, 131);
  assert.equal(capped.completeness.eventsDropped, 3);
  assert.equal(capped.tree.layers.length, 64);
  assert.equal(capped.tree.layersOmitted, 6);
  f.emit("LayerTree.layerTreeDidChange", { layers: [null, { ...layer(), layerId: SECRET, parentLayerId: SECRET, transform: [SECRET] }] });
  f.emit("LayerTree.layerPainted", { layerId: SECRET, clip: { x: SECRET, y: Infinity, width: 2, height: 3 } });
  const malformed = f.mark("after_screenshot_response");
  assert.ok(malformed.completeness.malformedEvents >= 3);
  assert.ok(!JSON.stringify(malformed).includes("private"));
  f.emit("LayerTree.layerTreeDidChange");
  assert.equal(f.mark("after_screenshot_response").tree.status, "not_compositing_reported");
  await f.observer.stop();
});

test("enable rejection and timeout detach listeners and never imply no compositor activity", async () => {
  for (const timeout of [false, true]) {
    const f = fixture({ timeoutMs: 5, send: (method) => method === "LayerTree.enable"
      ? timeout ? new Promise(() => {}) : Promise.reject(new Error(SECRET)) : undefined });
    await f.observer.start();
    assert.equal(f.mark("before_screenshot_request").status, timeout ? "unavailable_enable_timeout" : "unavailable_enable_error");
    assert.equal(f.listeners.size, 0);
    f.emit("LayerTree.layerTreeDidChange", { layers: [layer()] });
    assert.equal(f.mark("after_screenshot_response").events.length, 0);
    assert.ok(!JSON.stringify(f.mark("after_screenshot_response")).includes("private"));
    await f.observer.stop();
  }
});

test("a same-source replacement or ancestor change before/through mapping cannot acquire an earlier layer identity", async () => {
  for (const replaceAt of [1, 2]) {
    const f = fixture({ identity: (call) => call === replaceAt ? { status: "unavailable", reason: "figure_replaced_or_disconnected" } : { status: "recorded", nodeIds: [1, 2] } });
    await f.observer.start();
    const result = await f.record(f.mark("before_screenshot_request"), f.mark("after_screenshot_response"));
    assert.equal(result.mapping.status, "unavailable");
    assert.deepEqual(result.mapping.nodes, []);
    assert.equal(f.calls.filter((c) => c.method === "DOM.describeNode").length, replaceAt === 1 ? 0 : 2);
    await f.observer.stop();
  }
});

test("navigation during screenshot or a mismatched capture ID refuses backend association", async () => {
  const f = fixture(); await f.observer.start();
  const before = f.mark("before_screenshot_request");
  f.emit("Page.frameNavigated", { frame });
  const result = await f.record(before, f.mark("after_screenshot_response"));
  assert.equal(result.status, "unavailable");
  assert.equal(result.mapping.reason, "capture_association_unavailable");
  assert.equal(f.calls.filter((c) => c.method === "DOM.describeNode").length, 0);
  const wrong = await f.record(f.mark("before_screenshot_request"), f.mark("after_screenshot_response"), { provenance: { captureId: "different", preCaptureNodeIds: [1, 2] } });
  assert.equal(wrong.status, "unavailable");
  await f.observer.stop();
});

test("late mapping responses cannot revise unavailable evidence and release their remote object group", async () => {
  let resolveRemote;
  const f = fixture({ timeoutMs: 5, send: (method) => method === "Runtime.evaluate" ? new Promise((resolve) => { resolveRemote = resolve; }) : undefined });
  await f.observer.start();
  const result = await f.record(f.mark("before_screenshot_request"), f.mark("after_screenshot_response"));
  assert.equal(result.mapping.status, "unavailable");
  const bytes = JSON.stringify(result);
  assert.equal(f.calls.filter((call) => call.method === "Runtime.releaseObjectGroup").length, 1);
  resolveRemote({ result: { objectId: "late-private-object", subtype: "array" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(result), bytes);
  assert.equal(f.calls.filter((call) => call.method === "Runtime.releaseObjectGroup").length, 2);
  assert.equal(f.calls.filter((call) => call.method === "DOM.describeNode").length, 0);
  await f.observer.stop();
});

test("cleanup stays bounded and rejects late session events even when disable never replies", async () => {
  const f = fixture({ timeoutMs: 5, send: (method) => method === "LayerTree.disable" ? new Promise(() => {}) : undefined });
  await f.observer.start();
  assert.deepEqual(await f.observer.stop(), { status: "listener_detached_disable_unavailable" });
  f.emit("LayerTree.layerTreeDidChange", { layers: [layer()] });
  assert.equal(f.mark("after_screenshot_response").sequence, 0);
  assert.equal(f.listeners.size, 0);
});
