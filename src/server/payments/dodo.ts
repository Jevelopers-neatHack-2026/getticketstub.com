import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PaymentError, providerFetch } from "./fetch";

// Dodo Payments: hosted checkout for all-digital orders (Dodo is a merchant of record for digital goods only).
// Server-only. The API key and webhook key never leave the server. https://docs.dodopayments.com

export type DodoEnvironment = "test_mode" | "live_mode";

export interface DodoConfig {
  apiKey: string;
  webhookKey: string;
  productId: string;
  environment: DodoEnvironment;
  baseUrl: string;
}

/**
 * Dodo is on only when every setting is present. The environment is required and explicit: Dodo's own default is live,
 * so an unset or unknown value turns payments off rather than charging real cards.
 */
export function dodoConfig(env: Record<string, string | undefined> = process.env): DodoConfig | null {
  const apiKey = env.DODO_PAYMENTS_API_KEY?.trim();
  const webhookKey = env.DODO_PAYMENTS_WEBHOOK_KEY?.trim();
  const productId = env.DODO_PAYMENTS_PRODUCT_ID?.trim();
  const environment = env.DODO_PAYMENTS_ENVIRONMENT?.trim();
  if (!apiKey || !webhookKey || !productId) return null;
  if (environment !== "test_mode" && environment !== "live_mode") return null;
  const baseUrl = environment === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
  return { apiKey, webhookKey, productId, environment, baseUrl };
}

const call = <T>(cfg: DodoConfig, method: "GET" | "POST", path: string, body?: unknown) =>
  providerFetch<T>("dodo", `${cfg.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** One hosted checkout for one order. The amount is the server-verified total, in cents, on a pay-what-you-want product. */
export async function createCheckout(cfg: DodoConfig, input: { orderId: string; amountMinor: number; email: string; returnUrl: string }): Promise<{ sessionId: string; checkoutUrl: string }> {
  const out = await call<{ session_id: string; checkout_url: string | null }>(cfg, "POST", "/checkouts", {
    product_cart: [{ product_id: cfg.productId, quantity: 1, amount: input.amountMinor }],
    customer: { email: input.email },
    return_url: input.returnUrl,
    metadata: { order_id: input.orderId },
  });
  if (!out.session_id || !out.checkout_url) throw new PaymentError(502, "dodo");
  return { sessionId: out.session_id, checkoutUrl: out.checkout_url };
}

/** The fields of a Dodo payment this app reads. Fetched from the API, never trusted from a webhook body. */
export interface DodoPayment {
  payment_id: string;
  status?: string | null;
  total_amount: number;
  tax?: number | null;
  currency: string;
  checkout_session_id?: string | null;
  metadata?: Record<string, unknown>;
}

export const getPayment = (cfg: DodoConfig, paymentId: string) => call<DodoPayment>(cfg, "GET", `/payments/${encodeURIComponent(paymentId)}`);

const TOLERANCE_S = 5 * 60;

/**
 * Standard Webhooks verification, as Dodo signs: HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}` with the
 * base64 key after `whsec_`, compared in constant time against every `v1,` signature, and refused outside five minutes.
 */
export function verifyWebhook(key: string, headers: Headers, rawBody: string, nowS = Math.floor(Date.now() / 1000)): { id: string } | null {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return null;
  if (Math.abs(nowS - Number(timestamp)) > TOLERANCE_S) return null;
  const secret = Buffer.from(key.startsWith("whsec_") ? key.slice("whsec_".length) : key, "base64");
  if (secret.length === 0) return null;
  const expected = createHmac("sha256", secret).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of signatures.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { id };
  }
  return null;
}
