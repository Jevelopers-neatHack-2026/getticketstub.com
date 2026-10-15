import { createHash, randomBytes } from "node:crypto";
import type { Order } from "@/customer/pages/commerce";
import { CAPABILITY_VERSION, orderGate, runtimeMode, variantFor } from "@/customer/pages/capabilities";
import { accountOf, getRequestContext, requireCapability } from "@/server/context";
import { recordEvent } from "@/server/event-log";
import { HttpError, appOrigin, checkOrigin, configuredOrigin, clientIp, isObject, json, limit, readJson, route } from "@/server/http";
import { getStorage, requireStorage } from "@/server/index";
import { refOf } from "@/server/events";
import { sendReceipt } from "@/server/receipt";
import { parseEmail, parseText } from "@/server/validate";
import { PaymentError } from "@/server/payments/fetch";
import { verifiedTotalMinor } from "@/server/payments/pricing";
import { providerFor } from "@/server/payments/provider";

const MATERIALS = ["digital", "card", "print", "framed"];
const FINISHES = ["matte", "foil", "holo"];
const SIZES = ["classic", "stamp", "framed", "file"];
const METHODS = ["apple-pay", "google-pay", "card", "gift-print", "organizer-print"];
const bad = (m: string) => new HttpError(400, "bad_request", m);
const minor = (v: unknown, what: string) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100_000_000) throw bad(`${what} is not a valid amount.`);
  return v;
};

/** Rebuilds the order from the fields we know, so nothing else the client sent is stored. */
function parseOrder(v: unknown): Omit<Order, "id" | "mode" | "createdAt"> {
  if (!isObject(v)) throw bad("Send { order }.");
  if (!Array.isArray(v.stubIds) || v.stubIds.length > 200 || !v.stubIds.every((s) => typeof s === "string" && s.length > 0 && s.length <= 128)) throw bad("The order's stubs are not valid.");
  if (!Array.isArray(v.lines) || v.lines.length < 1 || v.lines.length > 200) throw bad("The order has no lines.");
  const lines = v.lines.map((l: unknown) => {
    if (!isObject(l)) throw bad("An order line is not valid.");
    if (!MATERIALS.includes(l.material as string) || !FINISHES.includes(l.finish as string) || !SIZES.includes(l.size as string)) throw bad("An order line has an unknown material, finish or size.");
    const material = l.material as Order["lines"][number]["material"];
    const finish = l.finish as Order["lines"][number]["finish"];
    const size = l.size as Order["lines"][number]["size"];
    // The status is derived here from the capability map. A variantStatus the browser sent is read by nobody.
    const variant = variantFor(material, size, finish);
    const gate = orderGate(variant, runtimeMode({ TICKETSTUB_RUNTIME_MODE: process.env.TICKETSTUB_RUNTIME_MODE }));
    if (!gate.ok || !variant) throw new HttpError(422, "variant_not_orderable", gate.ok ? "That combination isn't on our list." : gate.message);
    return {
      title: parseText(l.title, 200, "A line title"),
      material,
      finish,
      size,
      totalMinor: minor(l.totalMinor, "A line total"),
      variantStatus: variant.status,
    };
  });
  if (!METHODS.includes(v.method as string)) throw bad("The payment method is not valid.");
  const out: Omit<Order, "id" | "mode" | "createdAt"> = {
    stubIds: v.stubIds as string[],
    lines,
    capabilityVersion: CAPABILITY_VERSION,
    totalMinor: minor(v.totalMinor, "The total"),
    currency: "USD",
    method: v.method as Order["method"],
  };
  if (typeof v.quoteId === "string" && v.quoteId.length <= 200) out.quoteId = v.quoteId;
  if (v.email !== undefined && v.email !== "") out.email = parseEmail(v.email);
  return out;
}

/** Where the provider sends the buyer back. A live charge is only ever sent to APP_URL, never to a host the request names. */
function returnOrigin(req: Request, environment: "test_mode" | "live_mode"): string {
  if (environment === "live_mode" && !configuredOrigin()) {
    console.error("[payments] live payments need APP_URL; checkout refused");
    throw unavailable();
  }
  return appOrigin(req);
}

const unavailable = () => new HttpError(502, "payment_unavailable", "We couldn't start the payment. Nothing was charged. Try again in a moment.");

/** The browser's id for one checkout attempt: generated once, resent on every retry. Bounded so it is safe to hash and log. */
function parseAttemptId(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) throw bad("The checkout attempt id is not valid.");
  return v;
}

/**
 * The order id follows from who is ordering, the attempt and what is in it, so a double submit or a retry of the same
 * attempt lands on the same order (and the same provider idempotency key) instead of creating a second one.
 */
const orderIdFor = (attemptId: string, owner: string, order: Pick<Order, "stubIds" | "totalMinor">) =>
  `ord_${createHash("sha256").update(JSON.stringify([attemptId, owner, order.stubIds, order.totalMinor])).digest("base64url").slice(0, 12)}`;

export const POST = route(async (req: Request) => {
  requireStorage();
  checkOrigin(req);
  limit(`orders:ip:${clientIp(req)}`, 30, 15 * 60_000);
  const body = await readJson(req, 64 * 1024);
  if (!isObject(body)) throw bad("Send { order }.");
  let parsed: ReturnType<typeof parseOrder>;
  try {
    parsed = parseOrder(body.order);
  } catch (e) {
    if (e instanceof HttpError && e.code === "variant_not_orderable") await recordEvent(req, "order_blocked", { code: e.code });
    throw e;
  }
  const attemptId = parseAttemptId(body.attemptId);
  const ctx = await getRequestContext(req);
  requireCapability(ctx, "order.create");
  const account = ctx.actor.kind === "account" ? await accountOf(ctx) : null;
  // A guest order needs an email for the receipt. A signed-in order always uses the account's email.
  if (!account && !parsed.email) throw new HttpError(401, "unauthorized", "Add your email or sign in to place an order.");
  const email = account?.email ?? (parsed.email as string);
  const provider = providerFor({ lines: parsed.lines, method: parsed.method });
  if (provider && !attemptId) throw bad("Send the checkout attempt id with a paid order.");
  const id = attemptId ? orderIdFor(attemptId, account?.id ?? email.toLowerCase(), parsed) : `ord_${randomBytes(9).toString("base64url")}`;
  // The same attempt again: answer with the order (and its open checkout) the first request made.
  const replay = async () => {
    const found = attemptId ? await getStorage().getOrder(id) : null;
    if (!found || found.accountId !== (account?.id ?? null)) return null;
    const status = found.order.payment?.status;
    // A checkout that failed, was cancelled or is held for review can't be paid any more: the client starts a new attempt.
    if (status === "failed" || status === "cancelled" || status === "needs_review") throw new HttpError(409, "checkout_closed", "That checkout has closed. Nothing more was charged. Start again.");
    const open = status === "pending" ? found.order.payment?.checkoutUrl : undefined;
    return json(open ? { order: found.order, checkoutUrl: open } : { order: found.order });
  };
  const again = await replay();
  if (again) return again;
  const order: Order = { ...parsed, email, id, mode: "sandbox", createdAt: new Date().toISOString() };
  // Nothing is stored when a checkout can't be started.
  let checkoutUrl: string | undefined;
  if (provider) {
    const amountMinor = verifiedTotalMinor(order);
    const returnUrl = `${returnOrigin(req, provider.environment)}/payment/return?order=${encodeURIComponent(order.id)}`;
    try {
      const c = await provider.create({ orderId: order.id, amountMinor, email, returnUrl, description: `TicketStub order · ${order.lines.length} ${order.lines.length === 1 ? "item" : "items"}` });
      order.payment = { provider: provider.name, environment: provider.environment, status: "pending", amountMinor, currency: "USD", checkoutSessionId: c.sessionId, checkoutUrl: c.checkoutUrl, updatedAt: new Date().toISOString() };
      checkoutUrl = c.checkoutUrl;
    } catch (e) {
      // A provider that answered badly, or couldn't be reached at all (a network failure or the timeout)
      if (!(e instanceof PaymentError)) throw e;
      console.error(`[payments] ${e.provider} checkout failed: ${e.status}`);
      throw unavailable();
    }
  }
  try {
    await getStorage().createOrder(order, account?.id ?? null, email);
  } catch (e) {
    // A concurrent request for the same attempt stored it first
    const won = await replay();
    if (won) return won;
    throw e;
  }
  // A paid order's receipt is sent once its payment is confirmed (see the provider webhooks), not now.
  if (!checkoutUrl) await sendReceipt(order, account?.id ?? null, email, appOrigin(req));
  // A started checkout is not an order yet: it counts as paid only when the provider's webhook says so (order_paid).
  if (provider && checkoutUrl) await recordEvent(req, "checkout_started", { order: refOf(order.id), lines: order.lines.length, totalMinor: order.totalMinor, provider: provider.name }, { ctx });
  else await recordEvent(req, "order_placed", { order: refOf(order.id), lines: order.lines.length, totalMinor: order.totalMinor }, { ctx });
  return json(checkoutUrl ? { order, checkoutUrl } : { order });
});

export const GET = route(async (req: Request) => {
  requireStorage();
  const ctx = await getRequestContext(req);
  requireCapability(ctx, "order.read");
  const account = await accountOf(ctx);
  return json({ orders: await getStorage().listOrders(account.id, account.email) });
});
