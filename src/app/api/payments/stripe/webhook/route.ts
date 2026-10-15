import type { OrderPayment } from "@/customer/pages/commerce";
import { HttpError, isObject, json, readBody, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { settlePayment } from "@/server/payments/settle";
import { PaymentError } from "@/server/payments/fetch";
import { getSession, stripeConfig, verifyWebhook, type StripeSession } from "@/server/payments/stripe";

// Stripe webhook. Only a signed delivery is read, and only the Checkout Session fetched back from Stripe's API is
// trusted: the body says which session changed, never what it is. settlePayment applies it forward-only.

const MAX_BODY = 512 * 1024;
const SESSION_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"]);

/**
 * The order's payment status, from the session fetched back and never from the event type, so a redelivered older
 * event can't change the answer. A complete session that is unpaid is either still processing (a bank debit in flight)
 * or failed: the payment intent says which, because a failed one is back to needing a payment method.
 */
function statusOf(s: StripeSession): OrderPayment["status"] {
  if (s.payment_status === "paid") return "paid";
  if (s.status === "expired") return "cancelled";
  const intent = typeof s.payment_intent === "object" && s.payment_intent !== null ? s.payment_intent.status : undefined;
  if (s.status === "complete" && intent === "requires_payment_method") return "failed";
  return "pending";
}

export const POST = route(async (req: Request) => {
  const stripe = stripeConfig();
  if (!stripe) throw new HttpError(503, "payments_off", "Payments are not configured.");
  requireStorage();
  const raw = (await readBody(req, MAX_BODY)).toString("utf8");
  if (!verifyWebhook(stripe.webhookSecret, req.headers.get("stripe-signature"), raw)) throw new HttpError(401, "bad_signature", "The webhook signature is not valid.");

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "bad_request", "The webhook body is not JSON.");
  }
  const type = isObject(event) && typeof event.type === "string" ? event.type : "";
  const object = isObject(event) && isObject(event.data) && isObject(event.data.object) ? event.data.object : null;
  const sessionId = object && typeof object.id === "string" ? object.id : "";
  // Signed but not a Checkout Session change (refunds, disputes, ...): acknowledged so Stripe stops retrying, and left alone.
  if (!SESSION_EVENTS.has(type) || !sessionId) return json({ ok: true, handled: false });

  let session: StripeSession;
  try {
    session = await getSession(stripe, sessionId);
  } catch (e) {
    if (!(e instanceof PaymentError)) throw e;
    // A 5xx answer makes Stripe retry later, including when Stripe could not be reached at all.
    throw new HttpError(502, "provider_unavailable", "Stripe could not be reached.");
  }
  const orderId = session.metadata?.order_id ?? session.client_reference_id ?? "";
  if (!orderId) return json({ ok: true, handled: false });

  const intent = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  const settled = await settlePayment(
    {
      provider: "stripe",
      orderId,
      sessionId: session.id,
      paymentId: intent,
      status: statusOf(session),
      charged: { currency: session.currency ?? "", amountsMinor: typeof session.amount_total === "number" ? [session.amount_total] : [] },
    },
    req,
  );
  return json({ ok: true, ...settled });
});
