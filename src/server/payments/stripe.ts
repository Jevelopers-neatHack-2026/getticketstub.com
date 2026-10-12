import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PaymentError, providerFetch } from "./fetch";

// Stripe: hosted Checkout for orders with a physical line (Dodo only takes digital goods). Link and cards come from
// the account's payment method configuration, so no method list is pinned here. Server-only; no SDK, plain REST.
// https://docs.stripe.com/api/checkout/sessions

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  environment: "test_mode" | "live_mode";
}

/**
 * Stripe is on only with a secret key and the webhook signing secret. Test or live follows the key itself
 * (sk_test_/rk_test_ or sk_live_/rk_live_); anything else, a publishable key included, turns payments off.
 */
export function stripeConfig(env: Record<string, string | undefined> = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secretKey || !webhookSecret?.startsWith("whsec_")) return null;
  const mode = /^(?:sk|rk)_(test|live)_/.exec(secretKey)?.[1];
  if (!mode) return null;
  return { secretKey, webhookSecret, environment: mode === "live" ? "live_mode" : "test_mode" };
}

const call = <T>(cfg: StripeConfig, method: "GET" | "POST", path: string, form?: Record<string, string>, idempotencyKey?: string) =>
  providerFetch<T>("stripe", `https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });

/**
 * One hosted Checkout for one order, charging the server-verified total as a single USD line. Stripe collects the
 * shipping address, so the app never stores it. The order id is the idempotency key. The orders route derives it from
 * the browser's per-attempt id, so a retried or double-submitted attempt can't open a second session.
 */
export async function createCheckout(cfg: StripeConfig, input: { orderId: string; amountMinor: number; email: string; returnUrl: string; description: string }): Promise<{ sessionId: string; checkoutUrl: string }> {
  const ret = (status: string) => `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}status=${status}`;
  const out = await call<{ id?: string; url?: string | null }>(
    cfg,
    "POST",
    "/checkout/sessions",
    {
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(input.amountMinor),
      "line_items[0][price_data][product_data][name]": input.description,
      customer_email: input.email,
      client_reference_id: input.orderId,
      "metadata[order_id]": input.orderId,
      "payment_intent_data[metadata][order_id]": input.orderId,
      "shipping_address_collection[allowed_countries][0]": "US",
      success_url: ret("succeeded"),
      cancel_url: ret("cancelled"),
    },
    `checkout-${input.orderId}`,
  );
  if (!out.id || !out.url) throw new PaymentError(502, "stripe");
  return { sessionId: out.id, checkoutUrl: out.url };
}

/** The fields of a Checkout Session this app reads. Fetched from the API, never trusted from a webhook body. */
export interface StripeSession {
  id: string;
  status?: "open" | "complete" | "expired" | null;
  payment_status?: "paid" | "unpaid" | "no_payment_required" | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  /** Expanded by `getSession`: its status tells a delayed method still processing from one that failed. */
  payment_intent?: string | { id: string; status?: string } | null;
}

export const getSession = (cfg: StripeConfig, id: string) => call<StripeSession>(cfg, "GET", `/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent`);

const TOLERANCE_S = 5 * 60;

/**
 * Stripe-Signature verification: HMAC-SHA256 (hex) of `{t}.{raw body}` keyed with the whole `whsec_` secret, compared
 * in constant time against every `v1` signature, and refused when `t` is more than five minutes away.
 */
export function verifyWebhook(secret: string, header: string | null, rawBody: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!/^\d+$/.test(t) || Math.abs(nowS - Number(t)) > TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/.test(s)) return false;
    return timingSafeEqual(Buffer.from(s, "hex"), expected);
  });
}
