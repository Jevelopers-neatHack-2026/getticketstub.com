import type { OrderPayment } from "@/customer/pages/commerce";
import { HttpError, isObject, json, readBody, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { PaymentError } from "@/server/payments/fetch";
import { dodoConfig, getPayment, verifyWebhook, type DodoPayment } from "@/server/payments/dodo";
import { settlePayment } from "@/server/payments/settle";

// Dodo Payments webhook. Only a signed delivery is read, and only the payment fetched back from Dodo's API is trusted:
// the body says which payment changed, never what it is. settlePayment applies it forward-only.

const MAX_BODY = 256 * 1024;

function nextStatus(p: DodoPayment): OrderPayment["status"] {
  switch (p.status) {
    case "succeeded":
      return "paid";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

export const POST = route(async (req: Request) => {
  const dodo = dodoConfig();
  if (!dodo) throw new HttpError(503, "payments_off", "Payments are not configured.");
  requireStorage();
  const raw = (await readBody(req, MAX_BODY)).toString("utf8");
  if (!verifyWebhook(dodo.webhookKey, req.headers, raw)) throw new HttpError(401, "bad_signature", "The webhook signature is not valid.");

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "bad_request", "The webhook body is not JSON.");
  }
  const type = isObject(event) && typeof event.type === "string" ? event.type : "";
  const paymentId = isObject(event) && isObject(event.data) && typeof event.data.payment_id === "string" ? event.data.payment_id : "";
  // Signed but not about a payment (refunds, disputes, ...): acknowledged so Dodo stops retrying, and left alone.
  if (!type.startsWith("payment.") || !paymentId) return json({ ok: true, handled: false });

  let payment: DodoPayment;
  try {
    payment = await getPayment(dodo, paymentId);
  } catch (e) {
    if (!(e instanceof PaymentError)) throw e;
    // A 5xx answer makes Dodo retry later, including when Dodo could not be reached at all.
    throw new HttpError(502, "provider_unavailable", "Dodo Payments could not be reached.");
  }
  const orderId = typeof payment.metadata?.order_id === "string" ? payment.metadata.order_id : "";
  if (!orderId) return json({ ok: true, handled: false });

  const settled = await settlePayment(
    {
      provider: "dodo",
      orderId,
      sessionId: payment.checkout_session_id ?? null,
      paymentId: payment.payment_id,
      status: nextStatus(payment),
      // any tax Dodo adds as merchant of record is on top of the asked amount
      charged: { currency: payment.currency, amountsMinor: [payment.total_amount, payment.total_amount - (payment.tax ?? 0)] },
    },
    req,
  );
  return json({ ok: true, ...settled });
});
