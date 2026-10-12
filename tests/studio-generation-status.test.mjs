import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./analytics-hooks.mjs";

// Synthetic persisted statuses, actual controller and React components. Only CSS module exports
// are inert for the Node render. This is not browser/provider acceptance; network access is forbidden.
registerHooks({ load(url, context, next) {
  return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "export default {}" } : next(url, context);
} });
globalThis.fetch = () => { throw new Error("Network forbidden in generation status recovery controls."); };
const { GenerationController } = await import("../src/customer/studio/generation/operations.ts");
const { GenerationStatus } = await import("../src/customer/studio/generation/GenerationStatus.tsx");
const { loadStatus, saveStatus, forgetStatus, INTERRUPTED_MESSAGE } = await import("../src/customer/studio/generation/status-store.ts");
const KEY = "ticketstub.generation.v1";
class MemoryStorage {
  values = new Map(); writes = 0; blockedRead = false; blockedWrite = false;
  getItem(key) { if (this.blockedRead) throw new Error("synthetic unreadable storage"); return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.blockedWrite) throw new Error("synthetic blocked write"); this.writes++; this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const status = (phase = "failed", stubId = "synthetic-status") => ({
  runId: "synthetic-run", stubId, sourceVersionId: "v0", sourceRevision: 0, via: "sheet", phase,
  startedAt: 1, endedAt: 2, message: "We could not make new art. Try again starts a new request.", code: "provider_unavailable",
});
function saved(value) {
  const storage = new MemoryStorage();
  storage.values.set(KEY, JSON.stringify(value));
  return storage;
}
function render(storage, stubId = "synthetic-status") {
  globalThis.localStorage = storage;
  const controller = new GenerationController({ current: () => ({ id: stubId }), revision: () => 0,
    isGone: () => false, presence: () => "present", commit() { throw new Error("Status recovery cannot commit a design."); } }, storage);
  try {
    controller.attach();
    const op = controller.get(stubId);
    const html = renderToStaticMarkup(React.createElement(GenerationStatus, { controller, stubId, onOpenRemix() {} }));
    if (op) {
      assert.equal(controller.canRetry(op.runId), false);
      assert.equal(controller.retry(op.runId), null, "a persisted reminder must not restore a request");
    }
    return { op, html };
  } finally { controller.detach(); }
}
const phases = ["pending", "ready", "applied", "failed", "canceled", "discarded", "interrupted"];
for (const phase of phases) test(`valid ${phase} status follows the recovery policy and renders safely`, () => {
  const storage = saved({ "synthetic-status": status(phase) }), raw = storage.getItem(KEY);
  const { op, html } = render(storage);
  if (["pending", "ready"].includes(phase)) {
    assert.equal(op.phase, "interrupted"); assert.equal(op.message, INTERRUPTED_MESSAGE);
    assert.ok(html.includes("Open Remix"));
  } else if (["failed", "interrupted"].includes(phase)) {
    assert.equal(op.phase, phase); assert.ok(html.includes("Art generation status"));
  } else { assert.equal(op, null); assert.equal(html, ""); }
  assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes, 0);
});

for (const phase of phases) test(`object-valued message in ${phase} status is not adopted or rewritten`, () => {
  const record = { ...status(phase), message: { unexpected: "synthetic-corrupt-value" } };
  const storage = saved({ "synthetic-status": record }), raw = storage.getItem(KEY);
  assert.equal(loadStatus(record.stubId, storage), null);
  const result = render(storage); assert.equal(result.op, null); assert.equal(result.html, "");
  saveStatus(status(), record.stubId, storage); forgetStatus(record.stubId, storage);
  assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes, 0);
});

const faults = [
  ["foreign project binding", { stubId: "another-project" }],
  ["object run id", { runId: {} }], ["blank run id", { runId: " " }], ["oversized run id", { runId: "x".repeat(257) }],
  ["object version id", { sourceVersionId: [] }], ["missing version id", { sourceVersionId: undefined }],
  ["negative revision", { sourceRevision: -1 }], ["fractional revision", { sourceRevision: 0.5 }],
  ["string revision", { sourceRevision: "0" }], ["unsafe revision", { sourceRevision: Number.MAX_SAFE_INTEGER + 1 }],
  ["object start time", { startedAt: {} }], ["negative start time", { startedAt: -1 }],
  ["object end time", { endedAt: {} }], ["null end time", { endedAt: null }],
  ["unknown via", { via: "other" }], ["object via", { via: {} }],
  ["unknown phase", { phase: "other" }], ["object phase", { phase: {} }],
  ["array message", { message: [] }], ["null message", { message: null }], ["blank message", { message: " " }],
  ["oversized message", { message: "x".repeat(2049) }],
  ["object code", { code: {} }], ["oversized code", { code: "x".repeat(129) }],
  ["object vibe", { vibe: {} }], ["oversized vibe", { vibe: "x".repeat(2049) }],
  ["object fallback", { fallback: {} }], ["string saved", { saved: "true" }],
];
for (const [name, delta] of faults) test(`malformed ${name} cannot enter the live controller`, () => {
  const storage = saved({ "synthetic-status": { ...status(), ...delta } }), raw = storage.getItem(KEY);
  assert.equal(loadStatus("synthetic-status", storage), null);
  assert.deepEqual(render(storage), { op: null, html: "" });
  saveStatus(status(), "synthetic-status", storage); forgetStatus("synthetic-status", storage);
  assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes, 0);
});

test("bounded text is an escaped React child, optional fields stay primitive, and extras stay out of the controller", () => {
  const record = { ...status(), runId: "r".repeat(256), sourceVersionId: "v".repeat(256), via: "photo", sourceRevision: 1,
    message: "<synthetic>" + "x".repeat(2037), vibe: "v".repeat(2048), code: "c".repeat(128), saved: false, fallback: true,
    unrecognized: { message: { doNotAdopt: true } } };
  const storage = saved({ "synthetic-status": record }), raw = storage.getItem(KEY);
  const { op, html } = render(storage);
  assert.equal(op.message, record.message); assert.equal(op.vibe, record.vibe); assert.equal(op.saved, false);
  assert.equal(op.unrecognized, undefined); assert.ok(html.includes("&lt;synthetic&gt;"));
  assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes, 0);
});

for (const raw of ["", "{", "null", "[]", "42", '"text"', '{"synthetic-status":null}', '{"synthetic-status":[]}']) {
  test(`unreadable status map ${JSON.stringify(raw)} remains unchanged on load/save/forget`, () => {
    const storage = new MemoryStorage(); storage.values.set(KEY, raw);
    assert.equal(loadStatus("synthetic-status", storage), null);
    saveStatus(status(), "synthetic-status", storage); forgetStatus("synthetic-status", storage);
    assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes, 0);
  });
}

test("a valid reminder remains readable beside a malformed peer, without normalizing either stored record", () => {
  const storage = saved({ "synthetic-status": status(), other: { ...status("failed", "other"), message: {} } });
  const raw = storage.getItem(KEY);
  assert.equal(render(storage).op.phase, "failed"); assert.equal(loadStatus("other", storage), null);
  saveStatus(status("interrupted"), "synthetic-status", storage); forgetStatus("synthetic-status", storage);
  assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes, 0);
});

test("new valid reminders save, load and clear normally without restoring a producer request", () => {
  const storage = new MemoryStorage();
  for (const phase of phases) {
    saveStatus(status(phase), "synthetic-status", storage);
    const op = loadStatus("synthetic-status", storage);
    assert.equal(!!op, ["pending", "ready", "failed", "interrupted"].includes(phase));
  }
  forgetStatus("synthetic-status", storage); assert.equal(loadStatus("synthetic-status", storage), null);
});

test("prototype-like project identifiers use own properties and never an inherited record", () => {
  const storage = new MemoryStorage();
  assert.equal(loadStatus("__proto__", storage), null);
  saveStatus(status("failed", "__proto__"), "__proto__", storage);
  const all = JSON.parse(storage.getItem(KEY));
  assert.ok(Object.hasOwn(all, "__proto__")); assert.equal(loadStatus("__proto__", storage).stubId, "__proto__");
  forgetStatus("__proto__", storage); assert.equal(loadStatus("__proto__", storage), null);
  assert.equal(Object.hasOwn(Object.prototype, "runId"), false);
});

test("invalid caller identity and invalid outgoing status cannot overwrite a valid stored reminder", () => {
  const storage = saved({ "synthetic-status": status() }), raw = storage.getItem(KEY);
  for (const id of [null, {}, "", " ", "x".repeat(257)]) {
    assert.equal(loadStatus(id, storage), null); saveStatus(status(), id, storage); forgetStatus(id, storage);
  }
  saveStatus({ ...status(), message: {} }, "synthetic-status", storage);
  saveStatus(status("failed", "other"), "synthetic-status", storage);
  assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes, 0);
});

test("unavailable reads and blocked writes do not erase a stored reminder", () => {
  const storage = saved({ "synthetic-status": status() }), raw = storage.getItem(KEY);
  storage.blockedRead = true;
  assert.equal(loadStatus("synthetic-status", storage), null); saveStatus(status("interrupted"), "synthetic-status", storage);
  forgetStatus("synthetic-status", storage); storage.blockedRead = false;
  storage.blockedWrite = true; saveStatus(status("interrupted"), "synthetic-status", storage); forgetStatus("synthetic-status", storage);
  storage.blockedWrite = false;
  assert.equal(storage.getItem(KEY), raw); assert.equal(storage.writes, 0); assert.equal(render(storage).op.phase, "failed");
});
