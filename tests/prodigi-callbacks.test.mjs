// Prodigi sandbox callbacks, host side, fully offline. The network guard is imported first; every Prodigi "call"
// goes to a recording fake transport, and the suite ends by asserting zero network attempts.
import { networkAttempts } from "./lib/no-network.mjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const file = fileURLToPath(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url));
      if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ticketstub-prodigi-"));
process.env.TICKETSTUB_DB = join(scratch, "app.sqlite");
process.env.TICKETSTUB_FILES = join(scratch, "files");
for (const name of ["TICKETSTUB_PRODIGI_CALLBACKS", "TICKETSTUB_OPS_ENVIRONMENT", "PRODIGI_SANDBOX_CALLBACK_TOKEN", "PRODIGI_SANDBOX_CALLBACK_TOKEN_PREVIOUS", "PRODIGI_SANDBOX_API_KEY", "APP_URL"]) {
  delete process.env[name];
}

const { openDatabase } = await import("../src/server/sqlite.ts");
const { createProdigiHost, prodigiCallbackHost, resetProdigiCallbackHost } = await import("../src/server/fulfillment/prodigi-host.ts");
const { handleProdigiCallback } = await import("../src/server/fulfillment/prodigi-callback-route.ts");
const { createSandboxOrder } = await import("../src/server/fulfillment/prodigi-orders.ts");
const { SqliteProdigiStore } = await import("../src/server/fulfillment/prodigi-store.ts");
const { migrateProdigi } = await import("../src/server/fulfillment/prodigi-migrations.ts");
const { listProdigiAlerts, SqliteProdigiJobQueue, abandonAlertHook } = await import("../src/server/fulfillment/prodigi-jobs.ts");
const { callbackUrl, prodigiScope } = await import("../src/server/fulfillment/prodigi-config.ts");
const { ProdigiOrderTrackingError, POST_CREATE_POLL_DELAY_MS, withCallbackUrl } = await import("../src/server/fulfillment/prodigi-orders.ts");
const { HttpError, route } = await import("../src/server/http.ts");
const { ringEvents } = await import("../src/server/events.ts");
const PRODIGI_SCOPE = prodigiScope("test");
const { VENDORED_FILES } = await import("../scripts/vendor-fulfillment-connectors.mjs");

after(() => {
  resetProdigiCallbackHost();
  assert.equal(networkAttempts.count, 0, `network attempts: ${networkAttempts.channels.join(", ")}`);
});

// ---- fixtures ----

const TOKEN = "Tq3Jx0bW8vYp2Lr5Kd7Hs9Ga1Nf4Mc6Ze8Xu0Qi2Ow4"; // 44 base64url characters, test only
const PREVIOUS = "Pv9Lm2Kc4Jn6Hb8Gz0Fx1Dw3Sa5Qe7Rt9Yu1Io3Pl5Mk";
const ENV = Object.freeze({
  TICKETSTUB_PRODIGI_CALLBACKS: "sandbox",
  PRODIGI_SANDBOX_CALLBACK_TOKEN: TOKEN,
  PRODIGI_SANDBOX_CALLBACK_TOKEN_PREVIOUS: PREVIOUS,
  PRODIGI_SANDBOX_API_KEY: "sandbox-test-key-not-real",
  APP_URL: "https://preview.example.test",
});
const DETAILS_STARTED = { downloadAssets: "Complete", printReadyAssetsPrepared: "InProgress", allocateProductionLocation: "NotStarted", inProduction: "NotStarted", shipping: "NotStarted" };

/** Approves the 0003 decision, so the vendored client's policy gate passes and requests reach the fake transport. */
const approve = { verify: async (request) => ({ ...request, productAndDestinationApproved: true, sandboxAccountAccessConfirmed: true }) };

function orderBody(id, stage = "InProgress", outcome = "Ok", lastUpdated = "2026-10-11T10:00:00Z") {
  return { outcome, order: { id, created: "2026-10-11T09:00:00Z", lastUpdated, status: { stage, details: DETAILS_STARTED, issues: [] }, shipments: [] } };
}

/** A recording Prodigi transport. `respond(request)` returns { status, body }. */
function fakeProdigi(respond) {
  const requests = [];
  return {
    requests,
    reads: () => requests.filter((r) => r.method === "GET").length,
    port: {
      async send(request) {
        requests.push({ method: request.method, url: request.url, body: request.body, headers: request.headers });
        const { status, body } = respond(request);
        return { status, bodyText: JSON.stringify(body) };
      },
    },
  };
}

const okReads = (stage = "InProgress") => (request) => {
  if (request.method === "POST") return { status: 200, body: orderBody("ord_100", "InProgress", "Created") };
  const id = request.url.split("/").pop();
  return { status: 200, body: orderBody(id, stage) };
};

function clock(start = Date.parse("2026-10-11T12:00:00Z")) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; }, set: (t) => { now = t; } };
}

let dbSeq = 0;
function freshDbFile() {
  return join(scratch, `prodigi-${++dbSeq}.sqlite`);
}

function host({ file = freshDbFile(), respond = okReads(), clk = clock(), env = ENV, environment = "test", ...rest } = {}) {
  const fake = fakeProdigi(respond);
  const logs = [];
  const db = openDatabase(file);
  const h = createProdigiHost({ db, environment, env, http: fake.port, decisionVerifier: approve, clock: clk, random: () => 0.5, log: (l) => logs.push(l), ...rest });
  return { h, db, fake, clk, logs, file };
}

function event({ id = "evt_1", order = "ord_100", type = "com.prodigi.order.status.stage.changed#InProgress", time = "2026-10-11T11:59:59Z", source = "https://api.sandbox.prodigi.com/v4.0/Orders/" } = {}) {
  return JSON.stringify({ specversion: "1.0", id, type, source, subject: order, time, datacontenttype: "application/json", data: { order: { id: order } } });
}

function post(body, init = {}) {
  return new Request("https://preview.example.test/api/fulfillment/prodigi/callbacks/x", {
    method: "POST", body, headers: { "content-type": "application/json", ...init.headers },
  });
}

const call = (h, token, body, init) => handleProdigiCallback(post(body, init), token, () => h);

const orderInput = {
  merchantReference: "ts-sandbox-1",
  idempotencyKey: "ts-sandbox-1-key",
  shippingMethod: "Standard",
  recipient: { name: "Sandbox Test", address: { line1: "1 Test St", postalOrZipCode: "10001", countryCode: "US", townOrCity: "New York" } },
  items: [{ sku: "GLOBAL-PHO-4X6", copies: 1, sizing: "fillPrintArea", assets: [{ printArea: "default", url: "https://preview.example.test/api/files/a.png" }] }],
};

// ---- vendoring ----

test("the vendored fulfillment-connectors files match MANIFEST.json and the script's file list", () => {
  const dir = join(ROOT, "src", "server", "vendor", "fulfillment-connectors");
  const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(manifest.files).sort(), [...VENDORED_FILES].sort());
  for (const [file, sha] of Object.entries(manifest.files)) {
    const actual = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
    assert.equal(actual, sha, `${file} differs from fulfillment-connectors@${manifest.commit.slice(0, 7)}; re-run scripts/vendor-fulfillment-connectors.mjs`);
  }
});

// ---- route: off by default ----

test("disabled by default: 404, nothing opened, the body is not read", async () => {
  resetProdigiCallbackHost();
  assert.equal(prodigiCallbackHost(), null);
  const req = post(event());
  const res = await handleProdigiCallback(req, TOKEN);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "not_found");
  assert.equal(req.bodyUsed, false);
});

test("live and unrecognized values are refused: 404 and one log line", async () => {
  for (const value of ["live", "LIVE", "on", "true", "1"]) {
    resetProdigiCallbackHost();
    process.env.TICKETSTUB_PRODIGI_CALLBACKS = value;
    const warn = console.warn;
    const lines = [];
    console.warn = (l) => lines.push(String(l));
    try {
      assert.equal(prodigiCallbackHost(), null, value);
      assert.equal(prodigiCallbackHost(), null, value);
      assert.equal((await handleProdigiCallback(post(event()), TOKEN)).status, 404, value);
    } finally {
      console.warn = warn;
      delete process.env.TICKETSTUB_PRODIGI_CALLBACKS;
    }
    assert.equal(lines.length, 1, value);
    if (value.toLowerCase() === "live") assert.match(lines[0], /live is refused/);
  }
});

// ---- route: enabled ----

test("bad or missing token: 404 before any store access or read", async () => {
  const { h, fake } = host();
  await h.reconciler.trackOrder("ord_100");
  for (const token of ["", "short", TOKEN.slice(0, -1) + "X", `${TOKEN}A`, "%2e%2e"]) {
    const res = await call(h, token, event());
    assert.equal(res.status, 404, token);
  }
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(h.store.stats(), { orders: 1, replayRecords: 0, pendingReconciliations: 0 });
  h.close();
});

test("untracked order: 503 not_tracked with Retry-After, nothing stored, no read", async () => {
  const { h, fake } = host();
  const res = await call(h, TOKEN, event({ order: "ord_999" }));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal((await res.json()).outcome, "not_tracked");
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(h.store.stats(), { orders: 0, replayRecords: 0, pendingReconciliations: 0 });
  h.close();
});

test("good callback for a tracked order: one authenticated read, 200 reconciled; its redelivery is 200 replayed", async () => {
  const { h, fake } = host();
  await h.reconciler.trackOrder("ord_100");
  const res = await call(h, TOKEN, event());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { outcome: "reconciled" });
  assert.equal(fake.reads(), 1);
  assert.equal(fake.requests[0].url, "https://api.sandbox.prodigi.com/v4.0/orders/ord_100");
  const state = await h.store.getOrder({ scope: PRODIGI_SCOPE, orderId: "ord_100" });
  assert.equal(state.stage, "InProgress");
  const again = await call(h, TOKEN, event());
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { outcome: "replayed" });
  assert.equal(fake.reads(), 1, "a replay causes no read");
  h.close();
});

test("the previous token is accepted during a rotation and logged", async () => {
  const { h } = host();
  await h.reconciler.trackOrder("ord_100");
  const warn = console.warn;
  const lines = [];
  console.warn = (l) => lines.push(String(l));
  try {
    assert.equal((await call(h, PREVIOUS, event())).status, 200);
  } finally {
    console.warn = warn;
  }
  assert.ok(lines.some((l) => /previous token/.test(l)));
  h.close();
});

test("body cap: an oversized body is 413 with the right token and still 404 with a wrong one; malformed is 400", async () => {
  const { h, fake } = host();
  await h.reconciler.trackOrder("ord_100");
  const big = "x".repeat(h.maxBodyBytes + 10);
  assert.equal((await call(h, TOKEN, big)).status, 413);
  assert.equal((await call(h, "W".repeat(43), big)).status, 404);
  // A declared length over the cap is not read at all.
  const declared = post("{}", { headers: { "content-length": String(h.maxBodyBytes + 1) } });
  assert.equal((await handleProdigiCallback(declared, TOKEN, () => h)).status, 413);
  assert.equal((await call(h, TOKEN, "{not json")).status, 400);
  assert.equal((await call(h, TOKEN, event({ id: "not-an-event-id" }))).status, 400);
  assert.equal(fake.requests.length, 0);
  h.close();
});

test("a live or foreign source is 503 and logged (redelivered, not dropped); a non-order type is 200 with no read", async () => {
  const { h, fake } = host();
  await h.reconciler.trackOrder("ord_100");
  const warn = console.warn;
  const lines = [];
  console.warn = (l) => lines.push(String(l));
  try {
    const res = await call(h, TOKEN, event({ source: "https://api.prodigi.com/v4.0/Orders/" }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "callback_source_mismatch");
  } finally {
    console.warn = warn;
  }
  assert.ok(lines.some((l) => /source/.test(l)));
  const ignored = await call(h, TOKEN, event({ id: "evt_2", type: "com.prodigi.invoice.created" }));
  assert.equal(ignored.status, 200);
  assert.deepEqual(await ignored.json(), { outcome: "ignored_type" });
  assert.equal(fake.requests.length, 0);
  h.close();
});

test("a missing callback token secret fails closed with 503, never a match", async () => {
  const { h } = host({ env: { ...ENV, PRODIGI_SANDBOX_CALLBACK_TOKEN: undefined } });
  const res = await call(h, TOKEN, event());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "callbacks_unavailable");
  h.close();
});

test("without a verified owner decision (the default) no read reaches the transport", async () => {
  const fake = fakeProdigi(okReads());
  const db = openDatabase(freshDbFile());
  const h = createProdigiHost({ db, environment: "test", env: ENV, http: fake.port, clock: clock(), log: () => {} });
  await h.reconciler.trackOrder("ord_100");
  const res = await call(h, TOKEN, event());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).outcome, "reconcile_failed");
  assert.equal(fake.requests.length, 0);
  h.close();
});

// ---- order creation: callbackUrl and trackOrder ----

test("sandbox order with callbacks on: callbackUrl is sent on POST /v4.0/Orders only, and the order is tracked before returning", async () => {
  const { h, fake } = host();
  const result = await createSandboxOrder({ http: fake.port, secrets: h.secrets, decisionVerifier: approve, sandboxCallsEnabled: true, callbacks: h, env: ENV }, orderInput);
  assert.equal(result.callbackUrlSent, true);
  assert.equal(result.tracking, "now");
  assert.equal(result.readBackQueued, true);
  const [create] = fake.requests;
  assert.equal(create.method, "POST");
  assert.equal(create.url, "https://api.sandbox.prodigi.com/v4.0/Orders");
  const body = JSON.parse(create.body);
  assert.equal(body.callbackUrl, `https://preview.example.test/api/fulfillment/prodigi/callbacks/${TOKEN}`);
  assert.equal(body.merchantReference, "ts-sandbox-1");
  const tracked = await h.store.getOrder({ scope: PRODIGI_SCOPE, orderId: "ord_100" });
  assert.equal(tracked.revision, 0);
  // So the first callback for it is read, not 503 not_tracked.
  assert.equal((await call(h, TOKEN, event())).status, 200);
  h.close();
});

test("sandbox order with callbacks off: no callbackUrl and no tracking", async () => {
  const fake = fakeProdigi(okReads());
  const { prodigiSecretSource } = await import("../src/server/fulfillment/prodigi-host.ts");
  const env = { ...ENV, TICKETSTUB_PRODIGI_CALLBACKS: "off" };
  const result = await createSandboxOrder({ http: fake.port, secrets: prodigiSecretSource(env), decisionVerifier: approve, sandboxCallsEnabled: true, callbacks: null, env }, orderInput);
  assert.equal(result.callbackUrlSent, false);
  assert.equal(result.tracking, "off");
  assert.equal("callbackUrl" in JSON.parse(fake.requests[0].body), false);
});

test("sandbox order: nothing is sent when the callback URL cannot be built, or sandbox calls are not enabled", async () => {
  const { h, fake } = host();
  for (const env of [{ ...ENV, APP_URL: "http://preview.example.test" }, { ...ENV, APP_URL: undefined }, { ...ENV, PRODIGI_SANDBOX_CALLBACK_TOKEN: "too-short" }]) {
    await assert.rejects(createSandboxOrder({ http: fake.port, secrets: h.secrets, decisionVerifier: approve, sandboxCallsEnabled: true, callbacks: h, env }, orderInput), /callback URL/);
  }
  await assert.rejects(createSandboxOrder({ http: fake.port, secrets: h.secrets, decisionVerifier: approve, callbacks: h, env: ENV }, orderInput), (e) => e.code === "sandbox_calls_disabled");
  assert.equal(fake.requests.length, 0);
  assert.throws(() => callbackUrl({ ...ENV, TICKETSTUB_PRODIGI_CALLBACKS: "live" }), /off/);
  h.close();
});

test("a trackOrder failure after the order exists queues a durable track job that tracks and reads it", async () => {
  const { h, fake, clk } = host();
  const realTrack = h.reconciler.trackOrder.bind(h.reconciler);
  h.reconciler.trackOrder = async () => { throw new Error("store blip"); };
  const warn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await createSandboxOrder({ http: fake.port, secrets: h.secrets, decisionVerifier: approve, sandboxCallsEnabled: true, callbacks: h, env: ENV }, orderInput);
  } finally {
    console.warn = warn;
  }
  assert.equal(result.tracking, "queued");
  assert.deepEqual(h.queue.list().map((j) => j.kind), ["track"]);
  h.reconciler.trackOrder = realTrack;
  clk.advance(1);
  assert.equal(await h.worker.tick(), 1);
  assert.equal(h.queue.list().length, 0);
  assert.equal((await h.store.getOrder({ scope: PRODIGI_SCOPE, orderId: "ord_100" })).stage, "InProgress");
  assert.equal(fake.reads(), 1);
  h.close();
});

// ---- store compare-and-set ----

function storeOn(file, clk = clock()) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  migrateProdigi(db);
  return { db, store: new SqliteProdigiStore(db, { clock: clk, maxReplayRecords: 3 }) };
}

const S = { tenantId: "getticketstub", projectId: "prodigi-sandbox" };
const initial = (orderId, revision = 0) => ({ orderId, revision, stage: null, normalizedState: "pending", details: null, shipmentIds: [], lastUpdated: null, observationDigest: null, reconciledAt: null, confirmedAt: null, conflict: false });
const pendingRecord = (orderId, revision, staleAt = "2026-10-11T13:00:00.000Z") => ({
  orderId, revision, coverAfter: "2026-10-11T12:00:00.000Z", requiredStage: null, firstReceivedAt: "2026-10-11T12:00:00.000Z",
  budgetSince: "2026-10-11T12:00:00.000Z", readsSpent: 0, refusals: 0, abandoning: null, eventIds: ["evt_1"], attempt: 1,
  dueAt: "2026-10-11T12:00:05.000Z", staleAt,
});

test("store: order compare-and-set is atomic across two connections to the same file", async () => {
  const file = freshDbFile();
  const a = storeOn(file);
  const b = storeOn(file);
  const results = await Promise.all([
    a.store.compareAndSetOrder({ scope: S, orderId: "ord_1", expectedRevision: null, next: initial("ord_1") }),
    b.store.compareAndSetOrder({ scope: S, orderId: "ord_1", expectedRevision: null, next: initial("ord_1") }),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  // Both connections race the same revision: exactly one wins, and the loser sees the winner's write.
  const next = { ...initial("ord_1", 1), stage: "InProgress" };
  const raced = await Promise.all([
    a.store.compareAndSetOrder({ scope: S, orderId: "ord_1", expectedRevision: 0, next }),
    b.store.compareAndSetOrder({ scope: S, orderId: "ord_1", expectedRevision: 0, next: { ...next, stage: "Complete" } }),
  ]);
  assert.deepEqual(raced, [true, false]);
  assert.equal((await b.store.getOrder({ scope: S, orderId: "ord_1" })).stage, "InProgress");
  assert.equal(await a.store.compareAndSetOrder({ scope: S, orderId: "ord_1", expectedRevision: 0, next }), false, "a stale revision never writes");
  // Scopes are separate.
  assert.equal(await a.store.getOrder({ scope: { ...S, projectId: "other" }, orderId: "ord_1" }), undefined);
  a.db.close();
  b.db.close();
});

test("store: pending records exist only for tracked orders, compare-and-set on revision, delete with null, live count by staleAt", async () => {
  const { db, store } = storeOn(freshDbFile());
  assert.equal(await store.compareAndSetPendingReconciliation({ scope: S, orderId: "ord_2", expectedRevision: null, next: pendingRecord("ord_2", 1) }), false, "untracked");
  await store.compareAndSetOrder({ scope: S, orderId: "ord_2", expectedRevision: null, next: initial("ord_2") });
  assert.equal(await store.compareAndSetPendingReconciliation({ scope: S, orderId: "ord_2", expectedRevision: null, next: pendingRecord("ord_2", 1) }), true);
  assert.equal(await store.compareAndSetPendingReconciliation({ scope: S, orderId: "ord_2", expectedRevision: null, next: pendingRecord("ord_2", 1) }), false, "already exists");
  assert.equal(await store.compareAndSetPendingReconciliation({ scope: S, orderId: "ord_2", expectedRevision: 7, next: pendingRecord("ord_2", 8) }), false, "wrong revision");
  assert.equal(await store.compareAndSetPendingReconciliation({ scope: S, orderId: "ord_2", expectedRevision: 1, next: pendingRecord("ord_2", 2) }), true);
  assert.equal((await store.getPendingReconciliation({ scope: S, orderId: "ord_2" })).revision, 2);
  assert.equal(await store.countPendingReconciliations({ scope: S, now: "2026-10-11T12:30:00.000Z" }), 1);
  assert.equal(await store.countPendingReconciliations({ scope: S, now: "2026-10-11T13:00:00.000Z" }), 0, "staleAt is exclusive");
  assert.equal(await store.countPendingReconciliations({ scope: { ...S, tenantId: "other" }, now: "2026-10-11T12:30:00.000Z" }), 0);
  assert.equal(await store.compareAndSetPendingReconciliation({ scope: S, orderId: "ord_2", expectedRevision: 1, next: null }), false, "stale delete");
  assert.equal(await store.compareAndSetPendingReconciliation({ scope: S, orderId: "ord_2", expectedRevision: 2, next: null }), true);
  assert.equal(await store.getPendingReconciliation({ scope: S, orderId: "ord_2" }), undefined);
  assert.equal(await store.compareAndSetPendingReconciliation({ scope: S, orderId: "ord_2", expectedRevision: null, next: null }), true, "delete-if-absent");
  db.close();
});

test("store: replay records expire at expiresAt and are capped oldest first", async () => {
  const clk = clock();
  const { db, store } = storeOn(freshDbFile(), clk);
  const at = (ms) => new Date(clk.now() + ms).toISOString();
  await store.recordEvent({ scope: S, orderId: "ord_3", eventId: "evt_a", expiresAt: at(1000) });
  assert.equal(await store.hasEvent({ scope: S, orderId: "ord_3", eventId: "evt_a" }), true);
  clk.advance(1000);
  assert.equal(await store.hasEvent({ scope: S, orderId: "ord_3", eventId: "evt_a" }), false, "expired");
  for (const id of ["evt_b", "evt_c", "evt_d", "evt_e"]) await store.recordEvent({ scope: S, orderId: "ord_3", eventId: id, expiresAt: at(60_000) });
  assert.equal(store.stats().replayRecords, 3);
  assert.equal(await store.hasEvent({ scope: S, orderId: "ord_3", eventId: "evt_b" }), false, "oldest evicted");
  assert.equal(await store.hasEvent({ scope: S, orderId: "ord_3", eventId: "evt_e" }), true);
  db.close();
});

// ---- durable scheduler ----

test("scheduler: a deferred callback is 202, its job honours delayMs and runs after the host reopens in the same process", async () => {
  const file = freshDbFile();
  const clk = clock();
  // First host: the fixture provider is down, so the in-request read fails retryably and a durable job is recorded.
  const first = host({ file, clk, respond: (r) => (r.method === "GET" ? { status: 503, body: {} } : okReads()(r)) });
  await first.h.reconciler.trackOrder("ord_100");
  const res = await call(first.h, TOKEN, event());
  assert.equal(res.status, 503, "a failed in-request read is reconcile_failed");
  assert.equal((await res.json()).outcome, "reconcile_failed");
  // A second callback inside the read interval is merged into the durable record: 202, no read.
  const deferred = await call(first.h, TOKEN, event({ id: "evt_2" }));
  assert.equal(deferred.status, 202);
  assert.deepEqual(await deferred.json(), { outcome: "deferred" });
  const [job] = first.h.queue.list();
  assert.equal(job.kind, "reconcile");
  assert.ok(job.dueAt > clk.now(), "due in the future: delayMs is honoured");
  assert.equal(await first.h.worker.tick(), 0, "nothing runs before it is due");
  assert.equal(first.fake.reads(), 1);
  // Close the host and database without running the job; this is not a process crash.
  first.h.close();
  first.db.close();

  // Reopen a host on the same file in this process, with the fixture provider back up.
  clk.set(job.dueAt + 1);
  const second = host({ file, clk });
  assert.deepEqual(second.h.queue.list().map((j) => j.kind), ["reconcile"], "the job survived the restart");
  assert.ok(await second.h.worker.tick() >= 1);
  assert.equal(second.fake.reads(), 1);
  assert.equal((await second.h.store.getOrder({ scope: PRODIGI_SCOPE, orderId: "ord_100" })).stage, "InProgress");
  assert.equal(await second.h.store.getPendingReconciliation({ scope: PRODIGI_SCOPE, orderId: "ord_100" }), undefined, "the covering read cleared the record");
  assert.equal(second.h.queue.list().length, 0);
  // Both merged events are now replays.
  assert.deepEqual(await (await call(second.h, TOKEN, event({ id: "evt_2" }))).json(), { outcome: "replayed" });
  second.h.close();
});

test("scheduler: a leased job held by a crashed worker is taken over only after its lease runs out", async () => {
  const file = freshDbFile();
  const clk = clock();
  const a = host({ file, clk, leaseMs: 60_000, workerId: "w_a" });
  a.h.queue.enqueue("track", "ord_100", {}, 0);
  const claimed = [a.h.queue.claimOne("w_a")];
  assert.ok(claimed[0]);
  // Worker A dies here without completing or releasing. Worker B, another connection, cannot take it yet.
  const b = host({ file, clk, leaseMs: 60_000, workerId: "w_b" });
  assert.equal(await b.h.worker.tick(), 0);
  clk.advance(60_000);
  assert.equal(await b.h.worker.tick(), 1);
  assert.equal(b.h.queue.list().length, 0);
  assert.equal(a.h.queue.complete(claimed[0].id, "w_a"), false, "the old lease holder cannot delete it afterwards");
  a.h.close();
  b.h.close();
});

test("scheduler: a run that throws is retried with backoff, not dropped", async () => {
  const { h, clk, logs } = host();
  h.queue.enqueue("track", "ord_100", {}, 0);
  const real = h.reconciler.trackOrder.bind(h.reconciler);
  h.reconciler.trackOrder = async () => { throw Object.assign(new Error("down"), { code: "store_unavailable" }); };
  assert.equal(await h.worker.tick(), 1);
  const [row] = h.queue.list();
  assert.equal(row.lastError, "store_unavailable");
  assert.equal(row.leased, false);
  assert.ok(row.dueAt > clk.now());
  assert.ok(logs.some((l) => /retrying/.test(l)));
  h.reconciler.trackOrder = real;
  clk.set(row.dueAt);
  assert.equal(await h.worker.tick(), 1);
  assert.equal(h.queue.list().length, 0);
  h.close();
});

// ---- abandon alert ----

test("an abandoned chain stores one alert, logs it, queues a poll, and the poll's outcome is kept on the alert", async () => {
  const clk = clock();
  let mode = "down";
  const respond = (r) => {
    if (r.method !== "GET") return okReads()(r);
    return mode === "down" ? { status: 503, body: {} } : { status: 401, body: {} };
  };
  const { h, logs } = host({ clk, respond, reconciler: { jobRetryPolicy: { initialDelayMs: 1000, maxDelayMs: 1000, maxAttempts: 1, horizonMs: 60_000 } } });
  await h.reconciler.trackOrder("ord_100");
  assert.equal((await call(h, TOKEN, event())).status, 503);
  assert.equal(h.queue.list().length, 1, "the retryable failure recorded a job");
  // From here Prodigi rejects the credential: a non-retryable failure abandons the chain with read_failed.
  mode = "unauthorized";
  for (let i = 0; i < 5 && listProdigiAlerts(h.db, "test").length === 0; i++) {
    clk.advance(10_000);
    await h.worker.tick();
  }
  const [alert, ...more] = listProdigiAlerts(h.db, "test");
  assert.equal(more.length, 0);
  assert.equal(alert.orderId, "ord_100");
  assert.equal(alert.reason, "read_failed");
  assert.equal(alert.errorCode, "authentication_failed");
  assert.match(alert.dedupeKey, /^ord_100\|/);
  assert.ok(logs.some((l) => l.startsWith("[prodigi] reconcile_abandoned order=ord_100 reason=read_failed") && l.includes("poll=queued")));
  assert.equal(logs.join("\n").includes(TOKEN), false, "no token in the log");
  assert.equal(await h.store.getPendingReconciliation({ scope: PRODIGI_SCOPE, orderId: "ord_100" }), undefined);
  // The poll job runs reconcileOrder and records what it found. Rows are claimed one at a time, so the poll may
  // already have run in the tick that queued it.
  clk.advance(1);
  await h.worker.tick();
  const [polled] = listProdigiAlerts(h.db, "test");
  assert.equal(polled.pollStatus, "read_failed");
  assert.equal(polled.pollError, "authentication_failed");
  assert.equal(h.queue.list().length, 0);
  h.close();
});

test("the abandon hook is idempotent on dedupeKey: a repeat neither duplicates the alert nor queues a second poll", async () => {
  const db = openDatabase(freshDbFile());
  migrateProdigi(db);
  const queue = new SqliteProdigiJobQueue(db, { environment: "test" });
  const logs = [];
  const hook = abandonAlertHook(db, queue, { log: (l) => logs.push(l) });
  const ev = { outcome: "reconcile_abandoned", scope: S, orderId: "ord_7", reason: "horizon_exceeded", attempts: 3, coverAfter: "2026-10-11T12:00:00.000Z", requiredStage: "Complete", firstReceivedAt: "2026-10-11T11:00:00.000Z", abandonedAt: "2026-10-11T13:00:00.000Z", dedupeKey: "ord_7|2026-10-11T11:00:00.000Z|2026-10-11T12:00:00.000Z", errorCode: "provider_unavailable" };
  hook(ev);
  hook(ev);
  assert.equal(listProdigiAlerts(db, "test").length, 1);
  assert.deepEqual(queue.list().map((j) => j.kind), ["poll"]);
  assert.match(logs[1], /repeat$/);
  db.close();
});

test("the migration is recorded in module_schema and leaves PRAGMA user_version to the app's own chain", () => {
  const db = openDatabase(freshDbFile());
  const before = db.prepare("PRAGMA user_version").get().user_version;
  migrateProdigi(db);
  migrateProdigi(db);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, before);
  assert.equal(db.prepare("SELECT version FROM module_schema WHERE module = 'prodigi-callbacks'").get().version, 1);
  db.close();
});

// ---- review follow-ups ----

test("environments: two environments on one database never run, list or alert each other's rows", async () => {
  const file = freshDbFile();
  const clk = clock();
  const preview = host({ file, clk, environment: "preview", workerId: "w_preview" });
  const publish = host({ file, clk, environment: "production", workerId: "w_publish" });
  assert.notDeepEqual(preview.h.scope, publish.h.scope);
  await preview.h.reconciler.trackOrder("ord_100");
  preview.h.queue.enqueue("poll", "ord_100", {}, 0);
  assert.equal(publish.h.queue.list().length, 0);
  assert.equal(publish.h.queue.claimOne("w_publish"), null);
  assert.equal(await publish.h.worker.tick(), 0, "production never runs preview's job");
  assert.equal(await publish.h.store.getOrder({ scope: publish.h.scope, orderId: "ord_100" }), undefined, "store rows are scoped too");
  // A production callback for preview's order is not_tracked there.
  assert.equal((await call(publish.h, TOKEN, event())).status, 503);
  assert.equal(await preview.h.worker.tick(), 1);
  assert.equal(preview.fake.reads(), 1);
  assert.equal(publish.fake.reads(), 0);
  abandonAlertHook(preview.db, preview.h.queue, { log: () => {} })({ outcome: "reconcile_abandoned", scope: preview.h.scope, orderId: "ord_100", reason: "read_failed", attempts: 1, coverAfter: "x", requiredStage: null, firstReceivedAt: "y", abandonedAt: "z", dedupeKey: "ord_100|y|x" });
  assert.equal(listProdigiAlerts(preview.db, "preview").length, 1);
  assert.equal(listProdigiAlerts(publish.db, "production").length, 0);
  assert.equal(publish.h.queue.list().length, 0, "the alert's poll is preview's");
  preview.h.close();
  publish.h.close();
});

test("callbacks stay off unless TICKETSTUB_OPS_ENVIRONMENT names the environment", async () => {
  resetProdigiCallbackHost();
  process.env.TICKETSTUB_PRODIGI_CALLBACKS = "sandbox";
  const warn = console.warn;
  const lines = [];
  console.warn = (l) => lines.push(String(l));
  try {
    for (const value of [undefined, "", "unspecified", "staging"]) {
      if (value === undefined) delete process.env.TICKETSTUB_OPS_ENVIRONMENT;
      else process.env.TICKETSTUB_OPS_ENVIRONMENT = value;
      assert.equal(prodigiCallbackHost(() => assert.fail("must not open the database")), null, String(value));
      assert.equal((await handleProdigiCallback(post(event()), TOKEN)).status, 404);
    }
  } finally {
    console.warn = warn;
    delete process.env.TICKETSTUB_PRODIGI_CALLBACKS;
    delete process.env.TICKETSTUB_OPS_ENVIRONMENT;
    resetProdigiCallbackHost();
  }
  assert.ok(lines.some((l) => /TICKETSTUB_OPS_ENVIRONMENT/.test(l)));
});

test("lease per job: a slow first job never lets a second worker take the next row while it waits", async () => {
  const file = freshDbFile();
  const clk = clock();
  const a = host({ file, clk, leaseMs: 1_000, workerId: "w_a" });
  const b = host({ file, clk, leaseMs: 1_000, workerId: "w_b" });
  a.h.queue.enqueue("track", "ord_100", {}, 0);
  a.h.queue.enqueue("track", "ord_101", {}, 0);
  const real = a.h.reconciler.trackOrder.bind(a.h.reconciler);
  const stolen = [];
  a.h.reconciler.trackOrder = async (orderId) => {
    if (orderId === "ord_100") clk.advance(5_000); // far past a batch-wide lease
    else stolen.push(b.h.queue.claimOne("w_b")); // B tries while A runs the second row
    return real(orderId);
  };
  assert.equal(await a.h.worker.tick(), 2);
  assert.deepEqual(stolen, [null], "the second row was leased when its run started, so B could not take it");
  assert.equal(a.h.queue.list().length, 0);
  a.h.close();
  b.h.close();
});

test("createSandboxOrder: if trackOrder and the track job both fail, it stores a track_failed alert and throws with the order ID", async () => {
  const { h, fake } = host();
  h.reconciler.trackOrder = async () => { throw new Error("store blip"); };
  h.queue.enqueue = () => { throw new Error("database is locked"); };
  const error = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      createSandboxOrder({ http: fake.port, secrets: h.secrets, decisionVerifier: approve, sandboxCallsEnabled: true, callbacks: h, env: ENV }, orderInput),
      (e) => e instanceof ProdigiOrderTrackingError && e.orderId === "ord_100" && e.alerted === true && /exists at Prodigi: ord_100, tracking pending/.test(e.message),
    );
  } finally {
    console.error = error;
  }
  const [alert] = listProdigiAlerts(h.db, "test");
  assert.equal(alert.reason, "track_failed");
  assert.equal(alert.orderId, "ord_100");
  h.close();
});

test("createSandboxOrder: a delayed read-back poll covers a callback lost before tracking", async () => {
  const { h, fake, clk } = host();
  await createSandboxOrder({ http: fake.port, secrets: h.secrets, decisionVerifier: approve, sandboxCallsEnabled: true, callbacks: h, env: ENV }, orderInput);
  const [poll] = h.queue.list();
  assert.equal(poll.kind, "poll");
  assert.equal(poll.dueAt, clk.now() + POST_CREATE_POLL_DELAY_MS);
  assert.equal(await h.worker.tick(), 0, "not before the delay");
  clk.advance(POST_CREATE_POLL_DELAY_MS);
  assert.equal(await h.worker.tick(), 1);
  assert.equal(fake.reads(), 1);
  assert.equal((await h.store.getOrder({ scope: h.scope, orderId: "ord_100" })).stage, "InProgress");
  h.close();
});

test("createSandboxOrder: a body the callbackUrl wrapper refuses is reported not_dispatched, and nothing reaches the transport", async () => {
  const { h, fake } = host();
  const parse = JSON.parse;
  // Make the wrapper see a create body that already carries a callbackUrl.
  JSON.parse = (text, ...rest) => (typeof text === "string" && text.includes("merchantReference") ? { callbackUrl: "https://elsewhere.test/" } : parse(text, ...rest));
  try {
    await assert.rejects(
      createSandboxOrder({ http: fake.port, secrets: h.secrets, decisionVerifier: approve, sandboxCallsEnabled: true, callbacks: h, env: ENV }, orderInput),
      (e) => e.code === "invalid_input" && e.sideEffectState === "not_dispatched",
    );
  } finally {
    JSON.parse = parse;
  }
  assert.equal(fake.requests.length, 0);
  const wrapped = withCallbackUrl(fake.port, "https://x.test/cb");
  await assert.rejects(wrapped.send({ method: "POST", url: "https://api.sandbox.prodigi.com/v4.0/Orders", headers: {}, body: "[]", signal: AbortSignal.timeout(1000) }));
  assert.equal(wrapped.refused(), true);
  assert.equal(fake.requests.length, 0);
  h.close();
});

test("a wrong token is 404 even when the body stream fails or the host cannot start; a right one is 400 / 503", async () => {
  const { h } = host();
  await h.reconciler.trackOrder("ord_100");
  const broken = () => new Request("https://preview.example.test/api/fulfillment/prodigi/callbacks/x", {
    method: "POST", duplex: "half",
    body: new ReadableStream({ pull(c) { c.error(new Error("socket reset")); } }),
  });
  const bad = "W".repeat(43);
  const r1 = await handleProdigiCallback(broken(), bad, () => h);
  assert.equal(r1.status, 404);
  assert.equal((await handleProdigiCallback(broken(), TOKEN, () => h)).status, 400);
  // The host fails to start (database unusable): the configured tokens still decide 404 against 503.
  Object.assign(process.env, { PRODIGI_SANDBOX_CALLBACK_TOKEN: TOKEN });
  const error = console.error;
  console.error = () => {};
  try {
    const failing = () => { throw new Error("disk I/O error"); };
    assert.equal((await handleProdigiCallback(post(event()), bad, failing)).status, 404);
    assert.equal((await handleProdigiCallback(post(event()), "", failing)).status, 404);
    const ok = await handleProdigiCallback(post(event()), TOKEN, failing);
    assert.equal(ok.status, 503);
    assert.equal((await ok.json()).error.code, "callbacks_unavailable");
  } finally {
    console.error = error;
    delete process.env.PRODIGI_SANDBOX_CALLBACK_TOKEN;
  }
  h.close();
});

test("the host closes the database connection it opened when startup fails", () => {
  resetProdigiCallbackHost();
  Object.assign(process.env, { TICKETSTUB_PRODIGI_CALLBACKS: "sandbox", TICKETSTUB_OPS_ENVIRONMENT: "test" });
  let closed = 0;
  try {
    const open = () => {
      const db = new DatabaseSync(freshDbFile());
      db.exec("CREATE TABLE prodigi_orders (x)"); // the migration then fails: table already exists
      const close = db.close.bind(db);
      db.close = () => { closed += 1; close(); };
      return db;
    };
    assert.throws(() => prodigiCallbackHost(open), /already exists/);
    assert.throws(() => prodigiCallbackHost(open), /already exists/);
  } finally {
    delete process.env.TICKETSTUB_PRODIGI_CALLBACKS;
    delete process.env.TICKETSTUB_OPS_ENVIRONMENT;
    resetProdigiCallbackHost();
  }
  assert.equal(closed, 2, "one close per failed open, no leaked connections");
});

test("the storage_unavailable wrapper keeps callback and dynamic path tokens out of the event ring", async () => {
  const token = "Abcdefghij_klmnopqrstuvwxyz0123456789-ABCDEF";
  const lowerToken = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq";
  const unavailable = route(async () => { throw new HttpError(503, "storage_unavailable", "Storage isn't available.", { "retry-after": "30" }); });
  delete globalThis.__ticketstubEventRing;
  delete globalThis.__ticketstubEventSeq;
  try {
    for (const [path, expected] of [
      [`/api/fulfillment/prodigi/callbacks/${token}`, "prodigi_callbacks"],
      [`/api/fulfillment/prodigi/callbacks/${lowerToken}`, "prodigi_callbacks"],
      [`/api/share/${token}`, "share_token"],
      [`/api/u/${lowerToken}`, "u_token"],
      ["/api/auth/link", "auth_link"],
      ["/api/wall/sync", "wall_sync"],
      [`/api/files/${token}.png`, "files_name"],
      ["/api/fulfillment/prodigi/callbacks", "unknown"],
      [`/api/fulfillment/prodigi/callbacks/${token}/extra`, "unknown"],
      [`/api/fulfillment/${lowerToken}/callbacks/${token}`, "unknown"],
      [`/api/${lowerToken}`, "unknown"],
      [`/api/SHARE/${token}`, "unknown"],
    ]) {
      const response = await unavailable(new Request(`https://preview.example.test${path}?canary=fixture_callback_query`, { headers: { "x-request-id": "req_callback_routes" } }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { code: "storage_unavailable", message: "Storage isn't available." } });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "30");
      assert.equal(response.headers.get("x-request-id"), "req_callback_routes");
      const event = ringEvents().at(-1);
      assert.equal(event.type, "storage_unavailable");
      assert.equal(event.requestId, "req_callback_routes");
      assert.deepEqual(event.fields, { code: "storage_unavailable", route: expected }, path);
      const serialized = JSON.stringify(ringEvents());
      for (const canary of [token, lowerToken, "fixture_callback_query", "preview.example.test"]) assert.ok(!serialized.includes(canary), path);
    }
  } finally {
    delete globalThis.__ticketstubEventRing;
    delete globalThis.__ticketstubEventSeq;
  }
});
