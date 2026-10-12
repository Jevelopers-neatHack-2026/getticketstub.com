"use client";
// Placing a sandbox order: the local record always lands first (it is the offline copy), then the server
// is told so it can keep the order and email the receipt. A failed request never undoes the order.
import { OrderBlocked, addOrderStored, dropOrder, type Order } from "@/customer/pages/commerce";
import { variantFor } from "@/customer/pages/capabilities";
import { codeOf } from "@/customer/feedback-messages/messages";
import { count, errorCode, flow, major } from "@/customer/flows/events";
import { api } from "./api";
import { isSavingOff } from "./saving";

export interface Placed {
  order: Order;
  /** True when the server took the order, so the receipt is on its way to order.email. */
  receipt: boolean;
  /** Set when the server refused or couldn't be reached: the order is only on this device. Catalog code, never shown raw. */
  code?: string;
  /** The id of this checkout attempt. A retry sends it again, so the server answers with the order it already made. */
  attemptId: string;
  /** The provider's hosted checkout, when the server is taking payment for this order. The browser goes there next. */
  checkoutUrl?: string;
}

type Draft = Omit<Order, "id" | "mode" | "createdAt">;
const METHOD = { "apple-pay": "apple_pay", "google-pay": "google_pay", card: "card", "gift-print": "gift_print", "organizer-print": "organizer_print" } as const satisfies Record<Order["method"], string>;

/**
 * One `sandbox_order` per order attempt, once it is known where the receipt lives. Never a purchase and never revenue:
 * nothing was charged. `placed` means the order is kept somewhere: by the server (whatever happened locally) or in this
 * device's storage. With no server receipt and a local write that failed, nothing kept it: that is `not_persisted`,
 * with no value, so a funnel filtered on `placed` never counts an order that exists only in memory.
 */
export function reportOrder(draft: Draft, receipt: "server" | "local", stored: boolean, err?: unknown): void {
  const kept = receipt === "server" || stored;
  flow("sandbox_order", {
    method: METHOD[draft.method],
    result: kept ? "placed" : "not_persisted",
    receipt,
    line_count: count(draft.lines.length),
    value: kept ? major(draft.totalMinor) : undefined,
    currency: kept ? "USD" : undefined,
    capability: "sandbox",
    storage: stored ? "ok" : "failed",
    // why the server didn't keep it, when it was asked (or saving is off); storage says what this device did
    error_code: err === undefined ? undefined : errorCode(err),
  });
}

/** A draft the server may charge for: a card or wallet method and every line orderable. Anything else stays a sandbox order. */
export function isPayable(draft: Pick<Draft, "method" | "lines">): boolean {
  return (draft.method === "card" || draft.method === "apple-pay" || draft.method === "google-pay") && draft.lines.every((l) => variantFor(l.material, l.size, l.finish)?.status === "orderable");
}

/** True when the order was handed to the provider's hosted checkout, so the browser is leaving for it. */
export function goToCheckout(p: Placed): boolean {
  if (!p.checkoutUrl || !/^https:\/\//.test(p.checkoutUrl)) return false;
  window.location.assign(p.checkoutUrl);
  return true;
}

/** A fresh id for one checkout attempt (16 to 64 URL-safe characters, as the server requires). */
export const newAttemptId = () => crypto.randomUUID().replaceAll("-", "");

export async function placeOrder(draft: Draft, attemptId = newAttemptId()): Promise<Placed> {
  let made: { order: Order; stored: boolean };
  try {
    made = addOrderStored(draft);
  } catch (e) {
    // live mode refuses a variant no supplier has confirmed: no record was made
    if (e instanceof OrderBlocked) flow("sandbox_order", { method: METHOD[draft.method], result: "blocked", line_count: count(draft.lines.length), capability: "sandbox", error_code: "variant_not_orderable" });
    throw e;
  }
  const local = made.order;
  // Signed out with no email there is nobody to send a receipt to, and with saving off nobody to keep it: the order stays on this device.
  if (isSavingOff()) {
    reportOrder(draft, "local", made.stored, "storage_unavailable");
    return { order: local, receipt: false, attemptId };
  }
  try {
    const { order, checkoutUrl } = await api.order(draft, attemptId);
    if (checkoutUrl) {
      // Not an order until the provider confirms the payment: no sandbox_order (the server counted a checkout_started),
      // no local record, and a receipt only once it is paid.
      dropOrder(local.id);
      return { order, receipt: false, checkoutUrl, attemptId };
    }
    reportOrder(draft, "server", made.stored);
    return { order, receipt: !!draft.email, attemptId };
  } catch (e) {
    const code = codeOf(e);
    // An order that could be paid for, and wasn't taken, is no order: nothing was charged, so this device keeps no record of it.
    const unpaid = isPayable(draft);
    if (unpaid) dropOrder(local.id);
    reportOrder(draft, "local", made.stored && !unpaid, e);
    return { order: local, receipt: false, code, attemptId };
  }
}

/** Sends an order that stayed on this device to the server again. It does not make a second local record. */
export async function resendOrder(placed: Placed): Promise<Placed> {
  if (isSavingOff()) return placed;
  const { order } = placed;
  try {
    const { order: sent, checkoutUrl } = await api.order({ stubIds: order.stubIds, lines: order.lines, capabilityVersion: order.capabilityVersion, totalMinor: order.totalMinor, currency: order.currency, quoteId: order.quoteId, method: order.method, email: order.email }, placed.attemptId);
    flow("sandbox_order_retry", { result: "server" });
    return checkoutUrl ? { order: sent, receipt: false, checkoutUrl, attemptId: placed.attemptId } : { order: sent, receipt: !!order.email, attemptId: placed.attemptId };
  } catch (e) {
    flow("sandbox_order_retry", { result: "local", error_code: errorCode(e) });
    return { order, receipt: false, code: codeOf(e), attemptId: placed.attemptId };
  }
}
