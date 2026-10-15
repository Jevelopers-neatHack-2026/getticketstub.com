import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Real settlement, HTTP and SQLite; only the receipt delivery boundary is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "@/server/receipt") return {
      url: "data:text/javascript," + encodeURIComponent("export async function sendReceipt(order, accountId, email, origin) { globalThis.__httpSettlementReceipts.push({ orderId: order.id, status: order.payment.status, accountId, email, origin }); }"),
      shortCircuit: true,
    };
    if (specifier.startsWith("@/")) {
      const url = new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
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

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const scratch = mkdtempSync(join(tmpdir(), "ticketstub-settlement-origin-"));
process.env.TICKETSTUB_DB = join(scratch, "test.sqlite");
process.env.TICKETSTUB_FILES = join(scratch, "files");
delete process.env.TICKETSTUB_HARNESS_EXPORT;
globalThis.fetch = () => { throw new Error("Settlement origin tests must stay offline"); };
globalThis.__httpSettlementReceipts = [];
const { getStorage } = await import("../src/server/index.ts");
const { settlePayment } = await import("../src/server/payments/settle.ts");
const { json, route } = await import("../src/server/http.ts");
const storage = getStorage();
beforeEach(() => { delete process.env.APP_URL; globalThis.__httpSettlementReceipts = []; });
afterEach(() => { delete process.env.APP_URL; });
after(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  delete globalThis.__httpSettlementReceipts;
  rmSync(scratch, { recursive: true, force: true });
});

let sequence = 0;
async function createOrder(status = "pending", provider = "dodo") {
  const order = {
    id: `ord_origin_fixture_${++sequence}`, mode: "sandbox", createdAt: "2026-10-12T00:00:00.000Z", stubIds: ["fixture_stub"],
    lines: [{ title: "Fixture", material: "digital", finish: "matte", size: "file", totalMinor: 900 }],
    totalMinor: 900, currency: "USD", method: "card", email: "fixture@example.test",
    payment: { provider, environment: "test_mode", status, amountMinor: 900, currency: "USD", checkoutSessionId: "session_fixture", updatedAt: "2026-10-12T00:00:00.000Z" },
  };
  await storage.createOrder(order, null, order.email);
  return order;
}
const payment = (order, extra = {}) => ({
  provider: order.payment.provider, orderId: order.id, sessionId: "session_fixture", paymentId: "payment_fixture", status: "paid",
  charged: { currency: "USD", amountsMinor: [900] }, ...extra,
});
const request = (headers = {}, url = "https://public.example/api/payments/dodo/webhook") => new Request(url, { method: "POST", headers });
// Same exception-to-response boundary used by both signed webhook callers. No browser Origin is sent.
const callback = route(async (req, providerPayment) => json({ ok: true, ...await settlePayment(providerPayment, req) }));

test("unavailable public origin rolls back payment and a repaired retry sends one receipt", async () => {
  for (const configuration of [undefined, "", "not-a-url", "http://public.example", "https://user:fixture@public.example"]) {
    if (configuration === undefined) delete process.env.APP_URL; else process.env.APP_URL = configuration;
    const order = await createOrder();
    const event = payment(order);
    const first = await callback(request({ "x-request-id": "req_settlement_fixture" }), event);
    const firstBody = await first.json();
    const afterFirst = (await storage.getOrder(order.id)).order;
    const receiptsAfterFirst = globalThis.__httpSettlementReceipts.length;
    process.env.APP_URL = "https://public.example";
    const retry = await callback(request(), event);
    const retryBody = await retry.json();
    const repeated = await callback(request(), event);
    const repeatedBody = await repeated.json();
    console.log("SETTLEMENT_ORIGIN_OBSERVATION " + JSON.stringify({ configuration: configuration === undefined ? "missing" : "invalid_or_blank", firstStatus: first.status, firstCode: firstBody.error?.code, stateAfterFirst: afterFirst.payment.status, receiptsAfterFirst, retry: retryBody, repeated: repeatedBody, receiptsAfterRetry: globalThis.__httpSettlementReceipts.length }));
    assert.equal(first.status, 503);
    assert.equal(firstBody.error.code, "origin_unavailable");
    assert.equal(first.headers.get("x-request-id"), "req_settlement_fixture");
    assert.deepEqual(afterFirst, order, "the complete pending order must survive the retryable failure");
    assert.equal(receiptsAfterFirst, 0);
    assert.deepEqual(retryBody, { ok: true, handled: true, status: "paid" });
    assert.deepEqual(repeatedBody, { ok: true, handled: false });
    assert.equal(globalThis.__httpSettlementReceipts.length, 1);
    assert.equal(globalThis.__httpSettlementReceipts[0].origin, "https://public.example");
    globalThis.__httpSettlementReceipts = [];
  }
});

test("configured settlement trusts only APP_URL and requires no browser Origin", async () => {
  process.env.APP_URL = "https://public.example:8443/configured-path";
  for (const provider of ["dodo", "stripe"]) {
    const order = await createOrder("pending", provider);
    const req = request({ host: "attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" }, `http://internal.example/api/payments/${provider}/webhook`);
    assert.deepEqual(await settlePayment(payment(order), req), { handled: true, status: "paid" });
    assert.equal((await storage.getOrder(order.id)).order.payment.status, "paid");
    assert.equal(globalThis.__httpSettlementReceipts.at(-1).origin, "https://public.example:8443");
    assert.deepEqual(await settlePayment(payment(order), req), { handled: false });
  }
  assert.equal(globalThis.__httpSettlementReceipts.length, 2);
});

test("amount and currency mismatches still enter review without receipt-origin configuration", async () => {
  for (const charged of [{ currency: "USD", amountsMinor: [100] }, { currency: "EUR", amountsMinor: [900] }]) {
    const order = await createOrder();
    const event = payment(order, { charged });
    assert.deepEqual(await settlePayment(event, request()), { handled: true, status: "needs_review" });
    const after = (await storage.getOrder(order.id)).order.payment;
    assert.equal(after.status, "needs_review");
    assert.equal(after.chargedMinor, charged.amountsMinor[0]);
    assert.deepEqual(await settlePayment(event, request()), { handled: false });
  }
  assert.deepEqual(globalThis.__httpSettlementReceipts, []);
});

test("failed and cancelled payment transitions have no receipt-origin dependency", async () => {
  for (const status of ["failed", "cancelled"]) {
    const order = await createOrder();
    const event = payment(order, { status });
    assert.deepEqual(await settlePayment(event, request()), { handled: true, status });
    assert.equal((await storage.getOrder(order.id)).order.payment.status, status);
    assert.deepEqual(await settlePayment(event, request()), { handled: false });
  }
  assert.deepEqual(globalThis.__httpSettlementReceipts, []);
});

test("a failed checkout can retry to paid after origin configuration is repaired", async () => {
  const order = await createOrder("failed");
  const event = payment(order);
  await assert.rejects(settlePayment(event, request()), (e) => e.status === 503 && e.code === "origin_unavailable");
  assert.deepEqual((await storage.getOrder(order.id)).order, order);
  process.env.APP_URL = "https://public.example";
  assert.deepEqual(await settlePayment(event, request()), { handled: true, status: "paid" });
  assert.deepEqual(await settlePayment(event, request()), { handled: false });
  assert.equal(globalThis.__httpSettlementReceipts.length, 1);
});

test("terminal and pending no-ops preserve their state with missing or invalid APP_URL", async () => {
  for (const status of ["paid", "needs_review", "cancelled", "pending", "failed"]) {
    const order = await createOrder(status);
    const event = payment(order, { status: "pending" });
    process.env.APP_URL = "not-a-url";
    assert.deepEqual(await settlePayment(event, request()), { handled: false });
    if (status === "paid" || status === "needs_review") assert.deepEqual(await settlePayment(payment(order), request()), { handled: false });
    assert.deepEqual((await storage.getOrder(order.id)).order, order);
  }
  assert.deepEqual(globalThis.__httpSettlementReceipts, []);
});

test("unmatched provider, session and order events remain no-ops without origin authority", async () => {
  const order = await createOrder();
  for (const extra of [{ provider: "stripe" }, { sessionId: "different_session" }, { orderId: "ord_fixture_missing" }]) {
    assert.deepEqual(await settlePayment(payment(order, extra), request()), { handled: false });
    assert.deepEqual((await storage.getOrder(order.id)).order, order);
  }
  assert.deepEqual(globalThis.__httpSettlementReceipts, []);
});

test("a late paid callback stays cancelled and is held once without receipt authority", async () => {
  const order = await createOrder("cancelled");
  const event = payment(order);
  assert.deepEqual(await settlePayment(event, request()), { handled: true, status: "cancelled" });
  const after = (await storage.getOrder(order.id)).order.payment;
  assert.equal(after.status, "cancelled");
  assert.equal(after.paymentId, "payment_fixture");
  assert.deepEqual(await settlePayment(event, request()), { handled: false });
  assert.deepEqual(globalThis.__httpSettlementReceipts, []);
});
