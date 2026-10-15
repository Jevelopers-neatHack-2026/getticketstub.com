import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier.startsWith("@/")) {
      for (const ext of [".ts", ".tsx"]) {
        const file = fileURLToPath(new URL(`../src/${specifier.slice(2)}${ext}`, import.meta.url));
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
      }
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

const dir = mkdtempSync(join(tmpdir(), "ticketstub-payments-test-"));
const key = `whsec_${randomBytes(24).toString("base64")}`;
const stripeSecret = `whsec_${randomBytes(16).toString("hex")}`;
Object.assign(process.env, {
  TICKETSTUB_DB: join(dir, "ticketstub.sqlite"),
  TICKETSTUB_FILES: join(dir, "files"),
  APP_URL: "https://getticketstub.test",
  DODO_PAYMENTS_API_KEY: "test-key",
  DODO_PAYMENTS_WEBHOOK_KEY: key,
  DODO_PAYMENTS_PRODUCT_ID: "pdt_test",
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: stripeSecret,
});
delete process.env.RESEND_API_KEY;

const { verifiedTotalMinor, isDigitalOnly, allOrderable } = await import("../src/server/payments/pricing.ts");
const { dodoConfig, verifyWebhook } = await import("../src/server/payments/dodo.ts");
const { getStorage } = await import("../src/server/index.ts");
const { POST } = await import("../src/app/api/payments/dodo/webhook/route.ts");
const stripe = await import("../src/server/payments/stripe.ts");
const { POST: STRIPE_POST } = await import("../src/app/api/payments/stripe/webhook/route.ts");

const line = (material, finish, totalMinor) => ({ title: "Show", material, finish, size: material === "digital" ? "file" : "classic", totalMinor });

test("verifies a paid order's amounts against the price list", () => {
  assert.equal(verifiedTotalMinor({ lines: [line("digital", "matte", 900)], totalMinor: 900 }), 900);
  // seats multiply the unit price; a digital finish adds nothing
  assert.equal(verifiedTotalMinor({ lines: [line("digital", "foil", 1800)], totalMinor: 1800 }), 1800);
  // print 4900 + foil 600, plus flat shipping 600
  assert.equal(verifiedTotalMinor({ lines: [line("print", "foil", 5500)], totalMinor: 6100 }), 6100);
  for (const bad of [
    { lines: [line("digital", "matte", 100)], totalMinor: 100 }, // under the unit price
    { lines: [line("digital", "matte", 1000)], totalMinor: 1000 }, // not a whole number of stubs
    { lines: [line("digital", "matte", 900)], totalMinor: 1 }, // total disagrees with the lines
    { lines: [line("print", "matte", 4900)], totalMinor: 4900 }, // shipping missing
    { lines: [line("digital", "matte", 900 * 201)], totalMinor: 900 * 201 }, // over the quantity cap
  ]) assert.throws(() => verifiedTotalMinor(bad), (e) => e.code === "amount_mismatch");
  assert.equal(isDigitalOnly({ lines: [line("digital", "matte", 900)] }), true);
  assert.equal(isDigitalOnly({ lines: [line("digital", "matte", 900), line("card", "matte", 2900)] }), false);
  assert.equal(isDigitalOnly({ lines: [] }), false);
  assert.equal(allOrderable({ lines: [{ ...line("digital", "matte", 900), variantStatus: "orderable" }] }), true);
  assert.equal(allOrderable({ lines: [{ ...line("digital", "holo", 900), variantStatus: "preview" }] }), false, "holo is a preview");
  assert.equal(allOrderable({ lines: [line("digital", "matte", 900)] }), false, "an unknown status is not orderable");
});

test("turns payments off unless every setting and an explicit environment are present", () => {
  const full = { DODO_PAYMENTS_API_KEY: "k", DODO_PAYMENTS_WEBHOOK_KEY: "w", DODO_PAYMENTS_PRODUCT_ID: "p", DODO_PAYMENTS_ENVIRONMENT: "test_mode" };
  assert.equal(dodoConfig(full)?.baseUrl, "https://test.dodopayments.com");
  assert.equal(dodoConfig({ ...full, DODO_PAYMENTS_ENVIRONMENT: "live_mode" })?.baseUrl, "https://live.dodopayments.com");
  assert.equal(dodoConfig({ ...full, DODO_PAYMENTS_ENVIRONMENT: undefined }), null);
  assert.equal(dodoConfig({ ...full, DODO_PAYMENTS_ENVIRONMENT: "live" }), null);
  for (const k of ["DODO_PAYMENTS_API_KEY", "DODO_PAYMENTS_WEBHOOK_KEY", "DODO_PAYMENTS_PRODUCT_ID"]) assert.equal(dodoConfig({ ...full, [k]: "" }), null);
});

function sign(body, { id = `msg_${randomBytes(6).toString("hex")}`, at = Math.floor(Date.now() / 1000), secret = key } = {}) {
  const raw = Buffer.from(secret.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", raw).update(`${id}.${at}.${body}`).digest("base64");
  return new Headers({ "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${sig}`, "content-type": "application/json" });
}

test("accepts only a current, correctly signed webhook", () => {
  const body = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_1" } });
  assert.ok(verifyWebhook(key, sign(body), body));
  assert.equal(verifyWebhook(key, sign(body), `${body} `), null, "a changed body fails");
  assert.equal(verifyWebhook(key, sign(body, { at: Math.floor(Date.now() / 1000) - 600 }), body), null, "an old timestamp fails");
  assert.equal(verifyWebhook(key, sign(body, { secret: `whsec_${randomBytes(24).toString("base64")}` }), body), null, "another key fails");
  const h = sign(body);
  h.set("webhook-signature", `v1,AAAA ${h.get("webhook-signature")}`);
  assert.ok(verifyWebhook(key, h, body), "any one matching v1 signature is enough");
  h.delete("webhook-id");
  assert.equal(verifyWebhook(key, h, body), null);
});

// The Dodo API as the webhook route sees it: GET /payments/:id answers with whatever the test sets.
let remote = {};
// POSTs open a checkout and are recorded in `calls`; `netFail` makes every call throw, as a network failure or timeout does.
const calls = [];
let netFail = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
  if (netFail) throw netFail;
  if (init.method === "POST") {
    return Response.json(u.includes("/checkout/sessions") ? { id: `cs_test_${calls.length}`, url: `https://checkout.stripe.test/c/${calls.length}` } : { session_id: `cks_${calls.length}`, checkout_url: `https://checkout.dodo.test/c/${calls.length}` });
  }
  const id = decodeURIComponent((u.includes("/checkout/sessions/") ? u.split("/checkout/sessions/")[1].split("?")[0] : u.split("/payments/")[1]) ?? "");
  const p = remote[id];
  return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response("{}", { status: 404 });
};

async function placePending(id, amountMinor = 900, provider = "dodo") {
  await getStorage().createOrder({
    id, mode: "sandbox", createdAt: new Date().toISOString(), stubIds: ["stub_1"], lines: [line("digital", "matte", amountMinor)],
    totalMinor: amountMinor, currency: "USD", method: "card", email: "buyer@example.test",
    payment: { provider, environment: "test_mode", status: "pending", amountMinor, currency: "USD", checkoutSessionId: provider === "stripe" ? `cs_test_${id}` : `cks_${id}`, updatedAt: new Date().toISOString() },
  }, null, "buyer@example.test");
}

async function deliver(type, paymentId, headers) {
  const body = JSON.stringify({ business_id: "bus_1", type, timestamp: new Date().toISOString(), data: { payment_id: paymentId } });
  const res = await POST(new Request("https://getticketstub.test/api/payments/dodo/webhook", { method: "POST", headers: headers ?? sign(body), body }));
  return { status: res.status, json: await res.json() };
}

const statusOf = async (id) => (await getStorage().getOrder(id))?.order.payment?.status;

test("marks an order paid only from the payment fetched back from Dodo, once, and never downgrades it", async () => {
  await placePending("ord_a");
  remote.pay_a = { payment_id: "pay_a", status: "succeeded", total_amount: 900, tax: 0, currency: "USD", checkout_session_id: "cks_ord_a", metadata: { order_id: "ord_a" } };
  let r = await deliver("payment.succeeded", "pay_a");
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.handled, r.json.status], [true, "paid"]);
  assert.equal(await statusOf("ord_a"), "paid");
  // a repeated delivery changes nothing
  r = await deliver("payment.succeeded", "pay_a");
  assert.equal(r.json.handled, false);
  // an out-of-order failure after success leaves it paid
  remote.pay_a = { ...remote.pay_a, status: "failed" };
  r = await deliver("payment.failed", "pay_a");
  assert.equal(r.json.handled, false);
  assert.equal(await statusOf("ord_a"), "paid");
});

test("ignores the webhook body's claims and another checkout session's payment", async () => {
  await placePending("ord_b", 1800);
  // another checkout session for the same order id is not this order's payment
  remote.pay_b = { payment_id: "pay_b", status: "succeeded", total_amount: 1800, currency: "USD", checkout_session_id: "cks_other", metadata: { order_id: "ord_b" } };
  assert.equal((await deliver("payment.succeeded", "pay_b")).json.handled, false);
  assert.equal(await statusOf("ord_b"), "pending");
  // tax added on top of the asked amount is accepted
  remote.pay_b = { ...remote.pay_b, total_amount: 1950, tax: 150, checkout_session_id: "cks_ord_b" };
  assert.equal((await deliver("payment.succeeded", "pay_b")).json.status, "paid");
});

test("records a failure, refuses bad signatures and acknowledges unrelated events", async () => {
  await placePending("ord_c");
  remote.pay_c = { payment_id: "pay_c", status: "failed", total_amount: 900, currency: "USD", checkout_session_id: "cks_ord_c", metadata: { order_id: "ord_c" } };
  assert.equal((await deliver("payment.failed", "pay_c")).json.status, "failed");
  const body = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_c" } });
  assert.equal((await deliver("payment.succeeded", "pay_c", sign(`${body}x`))).status, 401);
  assert.deepEqual((await deliver("refund.succeeded", "pay_c")).json, { ok: true, handled: false });
  // a payment Dodo doesn't know makes Dodo retry later
  assert.equal((await deliver("payment.succeeded", "pay_missing")).status, 502);
});

test("reads Stripe test or live mode from the secret key and refuses anything else", () => {
  const w = "whsec_x";
  assert.equal(stripe.stripeConfig({ STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: w })?.environment, "test_mode");
  assert.equal(stripe.stripeConfig({ STRIPE_SECRET_KEY: "rk_live_1", STRIPE_WEBHOOK_SECRET: w })?.environment, "live_mode");
  assert.equal(stripe.stripeConfig({ STRIPE_SECRET_KEY: "pk_test_1", STRIPE_WEBHOOK_SECRET: w }), null, "a publishable key can't charge");
  assert.equal(stripe.stripeConfig({ STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "" }), null);
  assert.equal(stripe.stripeConfig({ STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "nope" }), null);
});

function stripeSign(body, { at = Math.floor(Date.now() / 1000), secret = stripeSecret } = {}) {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

test("accepts only a current, correctly signed Stripe webhook", () => {
  const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } });
  assert.equal(stripe.verifyWebhook(stripeSecret, stripeSign(body), body), true);
  assert.equal(stripe.verifyWebhook(stripeSecret, stripeSign(body), `${body} `), false);
  assert.equal(stripe.verifyWebhook(stripeSecret, stripeSign(body, { at: Math.floor(Date.now() / 1000) - 600 }), body), false);
  assert.equal(stripe.verifyWebhook(stripeSecret, stripeSign(body, { secret: "whsec_other" }), body), false);
  assert.equal(stripe.verifyWebhook(stripeSecret, `${stripeSign(body)},v1=${"0".repeat(64)}`, body), true, "any one matching v1 is enough");
  assert.equal(stripe.verifyWebhook(stripeSecret, null, body), false);
});

async function deliverStripe(type, sessionId, signature) {
  const body = JSON.stringify({ id: `evt_${randomBytes(4).toString("hex")}`, type, data: { object: { id: sessionId, payment_status: "paid", amount_total: 1 } } });
  const res = await STRIPE_POST(new Request("https://getticketstub.test/api/payments/stripe/webhook", { method: "POST", headers: { "stripe-signature": signature ?? stripeSign(body) }, body }));
  return { status: res.status, json: await res.json() };
}

test("settles a Stripe order from the session fetched back, forward-only", async () => {
  await placePending("ord_s1", 6100, "stripe");
  const session = { id: "cs_test_ord_s1", status: "complete", payment_status: "paid", amount_total: 6100, currency: "usd", metadata: { order_id: "ord_s1" }, payment_intent: "pi_1" };
  remote.cs_test_ord_s1 = session;
  let r = await deliverStripe("checkout.session.completed", "cs_test_ord_s1");
  assert.deepEqual([r.status, r.json.handled, r.json.status], [200, true, "paid"]);
  assert.equal((await getStorage().getOrder("ord_s1"))?.order.payment?.paymentId, "pi_1");
  r = await deliverStripe("checkout.session.completed", "cs_test_ord_s1");
  assert.equal(r.json.handled, false, "a repeat changes nothing");
  remote.cs_test_ord_s1 = { ...session, status: "expired", payment_status: "unpaid" };
  assert.equal((await deliverStripe("checkout.session.expired", "cs_test_ord_s1")).json.handled, false, "paid is never downgraded");
  assert.equal(await statusOf("ord_s1"), "paid");
});

test("trusts the fetched Stripe session, not the event body, and maps expiry and async failure", async () => {
  await placePending("ord_s2", 6100, "stripe");
  // the event body claims paid with amount 1; the API says unpaid: stays pending
  remote.cs_test_ord_s2 = { id: "cs_test_ord_s2", status: "complete", payment_status: "unpaid", amount_total: 6100, currency: "usd", metadata: { order_id: "ord_s2" } };
  assert.equal((await deliverStripe("checkout.session.completed", "cs_test_ord_s2")).json.handled, false);
  assert.equal(await statusOf("ord_s2"), "pending");
  // a bank debit still processing is pending, whatever the event type says
  remote.cs_test_ord_s2 = { ...remote.cs_test_ord_s2, payment_intent: { id: "pi_2", status: "processing" } };
  assert.equal((await deliverStripe("checkout.session.async_payment_failed", "cs_test_ord_s2")).json.handled, false);
  assert.equal(await statusOf("ord_s2"), "pending");
  // a bank debit that finally failed: the fetched session says so
  remote.cs_test_ord_s2 = { ...remote.cs_test_ord_s2, payment_intent: { id: "pi_2", status: "requires_payment_method" } };
  assert.equal((await deliverStripe("checkout.session.async_payment_failed", "cs_test_ord_s2")).json.status, "failed");
  await placePending("ord_s3", 6100, "stripe");
  remote.cs_test_ord_s3 = { id: "cs_test_ord_s3", status: "expired", payment_status: "unpaid", amount_total: 6100, currency: "usd", client_reference_id: "ord_s3" };
  assert.equal((await deliverStripe("checkout.session.expired", "cs_test_ord_s3")).json.status, "cancelled");
  // a Dodo order is never settled by a Stripe event
  await placePending("ord_s4", 900, "dodo");
  remote.cs_test_ord_s4 = { id: "cks_ord_s4", status: "complete", payment_status: "paid", amount_total: 900, currency: "usd", metadata: { order_id: "ord_s4" } };
  assert.equal((await deliverStripe("checkout.session.completed", "cs_test_ord_s4")).json.handled, false);
  assert.equal(await statusOf("ord_s4"), "pending");
});

test("refuses bad Stripe signatures and acknowledges unrelated events", async () => {
  assert.equal((await deliverStripe("checkout.session.completed", "cs_x", "t=1,v1=00")).status, 401);
  assert.deepEqual((await deliverStripe("charge.refunded", "ch_1")).json, { ok: true, handled: false });
  assert.equal((await deliverStripe("checkout.session.completed", "cs_missing")).status, 502);
});

const eventsOf = async (type) => (await getStorage().listEvents({ limit: 200 })).filter((e) => e.type === type);

test("holds a charge that isn't the asked amount or currency for review, with an event and an order ref, and never overwrites it", async () => {
  const { refOf } = await import("../src/server/events.ts");
  await placePending("ord_m", 1800);
  // the API says the charge was smaller than the order: a real charge, so it is not left pending
  remote.pay_m = { payment_id: "pay_m", status: "succeeded", total_amount: 100, currency: "USD", checkout_session_id: "cks_ord_m", metadata: { order_id: "ord_m" } };
  const r = await deliver("payment.succeeded", "pay_m");
  assert.deepEqual([r.status, r.json.status], [200, "needs_review"]);
  assert.equal(await statusOf("ord_m"), "needs_review");
  const [ev] = (await eventsOf("payment_needs_review")).filter((e) => e.fields.order === refOf("ord_m"));
  assert.deepEqual([ev.fields.provider, ev.fields.reason], ["dodo", "amount"]);
  // a later, correct-looking delivery cannot talk it into paid
  remote.pay_m = { ...remote.pay_m, total_amount: 1800 };
  assert.equal((await deliver("payment.succeeded", "pay_m")).json.handled, false);
  assert.equal(await statusOf("ord_m"), "needs_review");
  // a wrong currency is held too
  await placePending("ord_n");
  remote.pay_n = { payment_id: "pay_n", status: "succeeded", total_amount: 900, currency: "EUR", checkout_session_id: "cks_ord_n", metadata: { order_id: "ord_n" } };
  assert.equal((await deliver("payment.succeeded", "pay_n")).json.status, "needs_review");
  assert.ok((await eventsOf("payment_needs_review")).some((e) => e.fields.reason === "currency"));
});

test("records order_paid once, on the transition to paid, with what was charged", async () => {
  const { refOf } = await import("../src/server/events.ts");
  await placePending("ord_p");
  remote.pay_p = { payment_id: "pay_p", status: "succeeded", total_amount: 1050, tax: 150, currency: "USD", checkout_session_id: "cks_ord_p", metadata: { order_id: "ord_p" } };
  await deliver("payment.succeeded", "pay_p");
  await deliver("payment.succeeded", "pay_p");
  const paid = (await eventsOf("order_paid")).filter((e) => e.fields.order === refOf("ord_p"));
  assert.equal(paid.length, 1);
  assert.deepEqual([paid[0].fields.totalMinor, paid[0].fields.provider], [1050, "dodo"]);
  assert.equal((await getStorage().getOrder("ord_p")).order.payment.chargedMinor, 1050);
});

test("the receipt prints what was charged, tax included", async () => {
  const { receiptMail } = await import("../src/server/templates.ts");
  const order = { id: "ord_r", mode: "sandbox", createdAt: "x", stubIds: [], lines: [line("digital", "matte", 900)], totalMinor: 900, currency: "USD", method: "card",
    payment: { provider: "dodo", environment: "test_mode", status: "paid", amountMinor: 900, chargedMinor: 1050, currency: "USD", checkoutSessionId: "c", updatedAt: "x" } };
  const mail = receiptMail(order, "https://getticketstub.test/wall", "");
  assert.match(mail.text, /Tax: \$1\.5\n/);
  assert.match(mail.text, /Total: \$10\.5\n/);
  assert.match(receiptMail({ ...order, payment: undefined }, "https://getticketstub.test/wall", "").text, /Total: \$9\n/);
});

test("caps the webhook body while it streams, before anything is parsed", async () => {
  const big = "x".repeat(300 * 1024);
  // no content-length (a chunked body), so only the streaming cap can refuse it
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  const req = new Request("https://getticketstub.test/api/payments/dodo/webhook", { method: "POST", headers: sign(big), body: stream, duplex: "half" });
  const res = await POST(req);
  assert.equal(res.status, 413);
});

const eventsOf2 = async (type) => (await getStorage().listEvents({ limit: 500 })).filter((e) => e.type === type);

// Receipts are counted by the mail API call; a key makes sendMail call it (the fetch mock answers).
async function withMail(fn) {
  process.env.RESEND_API_KEY = "re_test";
  const before = calls.filter((c) => c.url.includes("api.resend.com")).length;
  try {
    await fn();
  } finally {
    delete process.env.RESEND_API_KEY;
  }
  return calls.filter((c) => c.url.includes("api.resend.com")).length - before;
}

test("a failed payment can still be paid: Dodo's decline then retry ends paid with exactly one receipt", async () => {
  await placePending("ord_f1");
  const sent = await withMail(async () => {
    remote.pay_f1 = { payment_id: "pay_f1", status: "failed", total_amount: 900, currency: "USD", checkout_session_id: "cks_ord_f1", metadata: { order_id: "ord_f1" } };
    assert.equal((await deliver("payment.failed", "pay_f1")).json.status, "failed");
    // the buyer retries the card in the same checkout and it works
    remote.pay_f1b = { payment_id: "pay_f1b", status: "succeeded", total_amount: 900, currency: "USD", checkout_session_id: "cks_ord_f1", metadata: { order_id: "ord_f1" } };
    assert.equal((await deliver("payment.succeeded", "pay_f1b")).json.status, "paid");
    assert.equal((await deliver("payment.succeeded", "pay_f1b")).json.handled, false, "a repeat changes nothing");
    // and a stale failure afterwards can't undo it
    remote.pay_f1b = { ...remote.pay_f1b, status: "failed" };
    assert.equal((await deliver("payment.failed", "pay_f1b")).json.handled, false);
  });
  assert.equal(sent, 1);
  assert.equal(await statusOf("ord_f1"), "paid");
});

test("a failed payment retried for the wrong amount is held for review, once", async () => {
  const { refOf } = await import("../src/server/events.ts");
  await placePending("ord_f2");
  remote.pay_f2 = { payment_id: "pay_f2", status: "failed", total_amount: 900, currency: "USD", checkout_session_id: "cks_ord_f2", metadata: { order_id: "ord_f2" } };
  await deliver("payment.failed", "pay_f2");
  remote.pay_f2b = { ...remote.pay_f2, payment_id: "pay_f2b", status: "succeeded", total_amount: 100 };
  assert.equal((await deliver("payment.succeeded", "pay_f2b")).json.status, "needs_review");
  assert.equal((await deliver("payment.succeeded", "pay_f2b")).json.handled, false);
  assert.equal((await eventsOf2("payment_needs_review")).filter((e) => e.fields.order === refOf("ord_f2")).length, 1);
});

test("Stripe: a failed session that is later paid ends paid with one receipt; paid, cancelled and needs_review are final", async () => {
  const { refOf } = await import("../src/server/events.ts");
  await placePending("ord_t1", 6100, "stripe");
  const sent = await withMail(async () => {
    remote.cs_test_ord_t1 = { id: "cs_test_ord_t1", status: "complete", payment_status: "unpaid", amount_total: 6100, currency: "usd", metadata: { order_id: "ord_t1" }, payment_intent: { id: "pi_t1", status: "requires_payment_method" } };
    assert.equal((await deliverStripe("checkout.session.async_payment_failed", "cs_test_ord_t1")).json.status, "failed");
    // redelivered while still unpaid: still failed
    assert.equal((await deliverStripe("checkout.session.completed", "cs_test_ord_t1")).json.handled, false);
    remote.cs_test_ord_t1 = { ...remote.cs_test_ord_t1, payment_status: "paid", payment_intent: { id: "pi_t1", status: "succeeded" } };
    assert.equal((await deliverStripe("checkout.session.completed", "cs_test_ord_t1")).json.status, "paid");
    assert.equal((await deliverStripe("checkout.session.completed", "cs_test_ord_t1")).json.handled, false);
  });
  assert.equal(sent, 1);
  assert.equal(await statusOf("ord_t1"), "paid");
  await placePending("ord_t2", 6100, "stripe");
  remote.cs_test_ord_t2 = { id: "cs_test_ord_t2", status: "expired", payment_status: "unpaid", amount_total: 6100, currency: "usd", metadata: { order_id: "ord_t2" } };
  assert.equal((await deliverStripe("checkout.session.expired", "cs_test_ord_t2")).json.status, "cancelled");
  // a charge after cancellation leaves it cancelled and is flagged late, once
  remote.cs_test_ord_t2 = { ...remote.cs_test_ord_t2, status: "complete", payment_status: "paid", payment_intent: "pi_t2" };
  await deliverStripe("checkout.session.completed", "cs_test_ord_t2");
  await deliverStripe("checkout.session.completed", "cs_test_ord_t2");
  assert.equal(await statusOf("ord_t2"), "cancelled");
  assert.equal((await eventsOf2("payment_needs_review")).filter((e) => e.fields.order === refOf("ord_t2") && e.fields.reason === "late").length, 1);
});

test("holds a Stripe charge of the wrong amount for review, with an event, and keeps it there", async () => {
  const { refOf } = await import("../src/server/events.ts");
  await placePending("ord_s5", 6100, "stripe");
  remote.cs_test_ord_s5 = { id: "cs_test_ord_s5", status: "complete", payment_status: "paid", amount_total: 100, currency: "usd", metadata: { order_id: "ord_s5" }, payment_intent: "pi_5" };
  const r = await deliverStripe("checkout.session.completed", "cs_test_ord_s5");
  assert.deepEqual([r.status, r.json.status], [200, "needs_review"]);
  const order = (await getStorage().getOrder("ord_s5")).order;
  assert.deepEqual([order.payment.status, order.payment.chargedMinor], ["needs_review", 100]);
  const ev = (await eventsOf2("payment_needs_review")).find((e) => e.fields.order === refOf("ord_s5"));
  assert.deepEqual([ev.fields.provider, ev.fields.reason], ["stripe", "amount"]);
  remote.cs_test_ord_s5 = { ...remote.cs_test_ord_s5, amount_total: 6100 };
  assert.equal((await deliverStripe("checkout.session.completed", "cs_test_ord_s5")).json.handled, false);
  assert.equal(await statusOf("ord_s5"), "needs_review");
});

test("answers 502 when a provider can't be reached, so the webhook is retried", async () => {
  await placePending("ord_net", 6100, "stripe");
  netFail = new TypeError("fetch failed");
  try {
    assert.equal((await deliverStripe("checkout.session.completed", "cs_test_ord_net")).status, 502);
    assert.equal((await deliver("payment.succeeded", "pay_net")).status, 502);
    netFail = new DOMException("The operation timed out.", "TimeoutError");
    assert.equal((await deliverStripe("checkout.session.completed", "cs_test_ord_net")).status, 502);
  } finally {
    netFail = null;
  }
  assert.equal(await statusOf("ord_net"), "pending");
});

// ---- POST /api/orders ----
const { POST: ORDERS } = await import("../src/app/api/orders/route.ts");
const { providerFor } = await import("../src/server/payments/provider.ts");

const orderBody = (material, attemptId, extra = {}) => ({
  order: {
    stubIds: ["stub_1"], lines: [{ ...line(material, "matte", 900) }], capabilityVersion: "x", totalMinor: 900, currency: "USD", method: "card", email: "buyer@example.test",
    ...extra,
  },
  ...(attemptId ? { attemptId } : {}),
});
async function postOrder(body, origin = "https://getticketstub.test") {
  const res = await ORDERS(new Request(`${origin}/api/orders`, { method: "POST", headers: { origin, host: new URL(origin).host, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
const posts = () => calls.filter((c) => c.method === "POST");

test("picks one provider for an order: Dodo for digital, Stripe for a physical line, none for previews and prints", () => {
  const lines = (material, variantStatus = "orderable") => [{ ...line(material, "matte", 900), variantStatus }];
  assert.equal(providerFor({ lines: lines("digital"), method: "card" })?.name, "dodo");
  assert.equal(providerFor({ lines: lines("print"), method: "apple-pay" })?.name, "stripe");
  assert.equal(providerFor({ lines: [...lines("digital"), ...lines("card")], method: "google-pay" })?.name, "stripe", "any physical line goes to Stripe");
  assert.equal(providerFor({ lines: lines("print", "preview"), method: "card" }), null, "a preview is never charged");
  assert.equal(providerFor({ lines: lines("digital"), method: "gift-print" }), null);
  assert.equal(providerFor({ lines: lines("digital"), method: "organizer-print" }), null);
});

test("a physical order that is only a preview stays a sandbox order, with no provider call", async () => {
  const before = posts().length;
  const r = await postOrder(orderBody("print", "attempt-sandbox-0001", { lines: [line("print", "matte", 4900)], totalMinor: 5500 }));
  assert.equal(r.status, 200);
  assert.equal(r.json.checkoutUrl, undefined);
  assert.equal(r.json.order.payment, undefined);
  assert.equal(posts().length, before);
});

test("starts a Dodo checkout for a digital order, stores the payment, and answers a repeat of the attempt with the same order", async () => {
  const before = posts().length;
  const r = await postOrder(orderBody("digital", "attempt-digital-0001"));
  assert.equal(r.status, 200);
  assert.match(r.json.checkoutUrl, /^https:\/\/checkout\.dodo\.test\//);
  const { payment } = r.json.order;
  assert.deepEqual([payment.provider, payment.status, payment.amountMinor], ["dodo", "pending", 900]);
  assert.equal((await getStorage().getOrder(r.json.order.id)).order.payment.checkoutSessionId, payment.checkoutSessionId);
  // the retry (a double press, or a client retry) gets the same order and the same checkout; nothing new opens
  const again = await postOrder(orderBody("digital", "attempt-digital-0001"));
  assert.deepEqual([again.json.order.id, again.json.checkoutUrl], [r.json.order.id, r.json.checkoutUrl]);
  assert.equal(posts().length, before + 1);
  // another attempt is another order
  const other = await postOrder(orderBody("digital", "attempt-digital-0002"));
  assert.notEqual(other.json.order.id, r.json.order.id);
  assert.equal(posts().length, before + 2);
});

test("needs a well-formed attempt id for a paid order, and refuses a malformed one", async () => {
  const before = posts().length;
  assert.equal((await postOrder(orderBody("digital"))).status, 400, "a paid order has to carry its attempt id");
  for (const bad of ["short", "has spaces in it, 16+ chars", "x".repeat(65), 12345678901234567890]) assert.equal((await postOrder(orderBody("digital", bad))).status, 400);
  assert.equal(posts().length, before);
});

test("answers 502 payment_unavailable, and stores nothing, when the provider can't be reached", async () => {
  netFail = new TypeError("fetch failed");
  try {
    const r = await postOrder(orderBody("digital", "attempt-offline-0001"));
    assert.deepEqual([r.status, r.json.error.code], [502, "payment_unavailable"]);
  } finally {
    netFail = null;
  }
  // the same attempt, retried once the provider is back, opens the checkout
  const r = await postOrder(orderBody("digital", "attempt-offline-0001"));
  assert.equal(r.status, 200);
  assert.ok(r.json.checkoutUrl);
});

test("opens a Stripe Checkout with a form-encoded payload the webhook can match, keyed by the attempt's order", async () => {
  const provider = providerFor({ lines: [{ ...line("print", "matte", 5500), variantStatus: "orderable" }], method: "card" });
  const before = calls.length;
  const c = await provider.create({ orderId: "ord_form", amountMinor: 6100, email: "buyer@example.test", returnUrl: "https://getticketstub.test/payment/return?order=ord_form", description: "TicketStub order · 1 item" });
  assert.match(c.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
  const call = calls[before];
  assert.deepEqual([call.method, call.url], ["POST", "https://api.stripe.com/v1/checkout/sessions"]);
  assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(call.headers["idempotency-key"], "checkout-ord_form");
  assert.match(call.headers.authorization, /^Bearer sk_test_/);
  const form = Object.fromEntries(new URLSearchParams(call.body));
  assert.deepEqual(form, {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": "6100",
    "line_items[0][price_data][product_data][name]": "TicketStub order · 1 item",
    customer_email: "buyer@example.test",
    client_reference_id: "ord_form",
    "metadata[order_id]": "ord_form",
    "payment_intent_data[metadata][order_id]": "ord_form",
    "shipping_address_collection[allowed_countries][0]": "US",
    success_url: "https://getticketstub.test/payment/return?order=ord_form&status=succeeded",
    cancel_url: "https://getticketstub.test/payment/return?order=ord_form&status=cancelled",
  });
});

test("accepts APP_URL only as an absolute https URL, or http on localhost", async () => {
  const { configuredOrigin } = await import("../src/server/http.ts");
  const was = process.env.APP_URL;
  try {
    for (const [v, want] of [["https://getticketstub.com/x", "https://getticketstub.com"], ["http://localhost:3000", "http://localhost:3000"], ["http://getticketstub.com", null], ["getticketstub.com", null], ["javascript:alert(1)", null], ["", null]]) {
      process.env.APP_URL = v;
      assert.equal(configuredOrigin(), want, v);
    }
  } finally {
    process.env.APP_URL = was;
  }
});

test("Dodo returns to this deployment's canonical per-order route and ignores obsolete and client redirect settings", async () => {
  const saved = { app: process.env.APP_URL, old: process.env.DODO_PAYMENTS_RETURN_URL };
  try {
    process.env.DODO_PAYMENTS_RETURN_URL = "https://outside.example.test/redirect";
    for (const [deployment, origin] of [["production", "https://getticketstub.test"], ["preview", "https://preview.getticketstub.test"]]) {
      process.env.APP_URL = `${origin}/irrelevant-path?untrusted=1`;
      const before = calls.length;
      const r = await postOrder({ ...orderBody("digital", `attempt-return-${deployment}-01`), returnUrl: "https://outside.example.test/client", redirect: "//outside.example.test" }, origin);
      assert.equal(r.status, 200);
      const checkout = calls.slice(before).find((call) => call.method === "POST" && call.url.endsWith("/checkouts"));
      const body = JSON.parse(checkout.body);
      assert.equal(body.return_url, `${origin}/payment/return?order=${encodeURIComponent(r.json.order.id)}`);
      assert.equal(body.metadata.order_id, r.json.order.id);
      assert.equal(r.json.order.payment.status, "pending", "a checkout return never establishes payment");
    }
  } finally {
    if (saved.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.app;
    if (saved.old === undefined) delete process.env.DODO_PAYMENTS_RETURN_URL; else process.env.DODO_PAYMENTS_RETURN_URL = saved.old;
  }
});

test("public Dodo checkout rejects missing or invalid APP_URL at the Origin guard before any provider request", async () => {
  const saved = { app: process.env.APP_URL, environment: process.env.DODO_PAYMENTS_ENVIRONMENT };
  try {
    process.env.DODO_PAYMENTS_ENVIRONMENT = "live_mode";
    const before = calls.length;
    const storedBefore = await getStorage().listOrders("unowned-origin-control", "buyer@example.test");
    for (const [i, value] of [undefined, "", "not-a-url", "http://outside.example.test"].entries()) {
      if (value === undefined) delete process.env.APP_URL; else process.env.APP_URL = value;
      const r = await postOrder(orderBody("digital", `attempt-return-invalid-${i}0`));
      assert.deepEqual([r.status, r.json.error.code], [403, "bad_origin"]);
    }
    assert.equal(calls.length, before);
    assert.deepEqual(await getStorage().listOrders("unowned-origin-control", "buyer@example.test"), storedBefore);
  } finally {
    if (saved.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.app;
    if (saved.environment === undefined) delete process.env.DODO_PAYMENTS_ENVIRONMENT; else process.env.DODO_PAYMENTS_ENVIRONMENT = saved.environment;
  }
});

test("live Dodo checkout requires a configured return origin even when a loopback request passes the Origin guard", async () => {
  const saved = { app: process.env.APP_URL, environment: process.env.DODO_PAYMENTS_ENVIRONMENT };
  try {
    process.env.DODO_PAYMENTS_ENVIRONMENT = "live_mode";
    const before = calls.length;
    const storedBefore = await getStorage().listOrders("unowned-origin-control", "buyer@example.test");
    for (const [i, value] of [undefined, ""].entries()) {
      if (value === undefined) delete process.env.APP_URL; else process.env.APP_URL = value;
      const r = await postOrder(orderBody("digital", `attempt-return-loopback-${i}0`), "http://localhost:3000");
      assert.deepEqual([r.status, r.json.error.code], [502, "payment_unavailable"]);
    }
    assert.equal(calls.length, before);
    assert.deepEqual(await getStorage().listOrders("unowned-origin-control", "buyer@example.test"), storedBefore);
  } finally {
    if (saved.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.app;
    if (saved.environment === undefined) delete process.env.DODO_PAYMENTS_ENVIRONMENT; else process.env.DODO_PAYMENTS_ENVIRONMENT = saved.environment;
  }
});

test("replaying an attempt whose checkout has closed answers 409 checkout_closed", async () => {
  const r = await postOrder(orderBody("digital", "attempt-closed-0001"));
  assert.equal(r.status, 200);
  const id = r.json.order.id;
  const sessionId = r.json.order.payment.checkoutSessionId;
  for (const [status, url] of [["failed", "x"], ["cancelled", "x"], ["needs_review", "x"]]) {
    await getStorage().updateOrderPayment(id, (o) => ({ ...o.payment, status, updatedAt: url }));
    const again = await postOrder(orderBody("digital", "attempt-closed-0001"));
    assert.deepEqual([again.status, again.json.error.code], [409, "checkout_closed"], status);
  }
  // a paid one is a success, not an error
  await getStorage().updateOrderPayment(id, (o) => ({ ...o.payment, status: "paid", checkoutSessionId: sessionId }));
  assert.equal((await postOrder(orderBody("digital", "attempt-closed-0001"))).status, 200);
});
