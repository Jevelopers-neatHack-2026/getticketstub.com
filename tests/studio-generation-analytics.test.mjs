import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import "./analytics-hooks.mjs";

// Actual producer, research client and analytics runtime. Only storage, fetch and telemetry transport
// are synthetic; no browser, provider request or external network is used.
const values = new Map();
const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
globalThis.localStorage = storage;
globalThis.window = Object.assign(new EventTarget(), { localStorage: storage,
  location: { origin: "https://synthetic.invalid", hostname: "synthetic.invalid", pathname: "/wall", search: "" } });
const { remixProducer } = await import("../src/customer/studio/generation/producers.ts");
const runtime = await import("../src/customer/analytics/runtime.ts");
const turn = () => new Promise((resolve) => setImmediate(resolve));
const stub = () => ({ id: "synthetic-generation-analytics", createdAt: "2026-10-01T00:00:00.000Z",
  event: { type: "concert", title: "Synthetic fixture", facts: [] }, currentVersionId: "v0",
  versions: [{ id: "v0", edition: "researched", art: { kind: "procedural", seed: 1, provenance: "simulated" }, createdAt: "2026-10-01T00:00:00.000Z" }],
  personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [], friends: [] }, material: "card", finish: "matte", torn: false, wallAngle: 0, photos: [] });
const transport = { sent: [], load: async () => {}, send(name, params) { this.sent.push({ name, params: structuredClone(params) }); }, pause() {}, resume() {} };
beforeEach(async () => {
  values.clear(); transport.sent.length = 0; runtime.resetAnalyticsForTests();
  runtime.configureAnalytics({ config: { measurementId: "G-TEST000000", environment: "preview", runtimeMode: "demo", debug: false }, transport: () => transport, origin: "https://synthetic.invalid", referrer: "" });
  runtime.recordPageView("/wall"); runtime.updateConsent("granted"); await turn();
  transport.sent.length = 0;
});
afterEach(() => {
  globalThis.fetch = () => { throw new Error("outbound_denied"); };
  runtime.resetAnalyticsForTests();
});
for (const scenario of ["user_abort", "network_failure", "success"]) test(`remix telemetry keeps ${scenario} distinct`, async () => {
  let calls = 0, receivedSignal;
  globalThis.fetch = (path, init) => {
    assert.equal(path, "/api/art"); calls++; receivedSignal = init.signal;
    if (scenario === "user_abort") return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("synthetic abort", "AbortError")), { once: true }));
    if (scenario === "network_failure") return Promise.reject(new TypeError("synthetic network failure"));
    return Promise.resolve(new Response(JSON.stringify({ kind: "procedural", seed: 1, provenance: "simulated" }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  const ac = new AbortController();
  const pending = remixProducer("sheet", undefined, "none")(ac.signal, stub());
  if (scenario === "user_abort") ac.abort();
  if (scenario === "success") assert.equal((await pending).art.kind, "procedural");
  else await assert.rejects(pending, { code: scenario === "user_abort" ? "aborted" : "network" });
  await turn();
  assert.equal(calls, 1); assert.equal(receivedSignal, ac.signal);
  const events = transport.sent, results = events.filter((event) => event.name === "remix_result");
  assert.equal(events.filter((event) => event.name === "remix_request").length, 1);
  if (scenario === "user_abort") {
    assert.equal(results.length, 0, "stopping does not report a generated result or a failure");
    assert.equal(events.filter((event) => event.name === "api_call" && event.params.result === "failure").length, 0);
  } else {
    assert.equal(results.length, 1);
    assert.equal(results[0].params.result, scenario === "success" ? "success" : "error");
    if (scenario === "network_failure") assert.equal(results[0].params.error_code, "network");
  }
});
