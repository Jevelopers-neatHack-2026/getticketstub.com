"use client";
// Placing a sandbox order: the local record always lands first (it is the offline copy), then the server
// is told so it can keep the order and email the receipt. A failed request never undoes the order.
import { OrderBlocked, addOrderStored, type Order } from "@/customer/pages/commerce";
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
}

type Draft = Omit<Order, "id" | "mode" | "createdAt">;
const METHOD = { "apple-pay": "apple_pay", "google-pay": "google_pay", card: "card", "gift-print": "gift_print", "organizer-print": "organizer_print" } as const satisfies Record<Order["method"], string>;

/**
 * One `sandbox_order` per placed order, once it is known where the receipt lives. Never a purchase and never revenue:
 * nothing was charged. `storage` says whether the local record reached this device's storage.
 */
export function reportOrder(draft: Draft, receipt: "server" | "local", stored: boolean, err?: unknown): void {
  flow("sandbox_order", { method: METHOD[draft.method], result: "placed", receipt, line_count: count(draft.lines.length), value: major(draft.totalMinor), currency: "USD", capability: "sandbox", storage: stored ? "ok" : "failed", error_code: err === undefined ? undefined : errorCode(err) });
}

export async function placeOrder(draft: Draft): Promise<Placed> {
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
    reportOrder(draft, "local", made.stored);
    return { order: local, receipt: false };
  }
  try {
    const { order } = await api.order(draft);
    reportOrder(draft, "server", made.stored);
    return { order, receipt: !!draft.email };
  } catch (e) {
    reportOrder(draft, "local", made.stored, e);
    return { order: local, receipt: false, code: codeOf(e) };
  }
}

/** Sends an order that stayed on this device to the server again. It does not make a second local record. */
export async function resendOrder(placed: Placed): Promise<Placed> {
  if (isSavingOff()) return placed;
  const { order } = placed;
  try {
    const sent = await api.order({ stubIds: order.stubIds, lines: order.lines, capabilityVersion: order.capabilityVersion, totalMinor: order.totalMinor, currency: order.currency, quoteId: order.quoteId, method: order.method, email: order.email });
    flow("sandbox_order_retry", { result: "server" });
    return { order: sent.order, receipt: !!order.email };
  } catch (e) {
    flow("sandbox_order_retry", { result: "local", error_code: errorCode(e) });
    return { order, receipt: false, code: codeOf(e) };
  }
}
