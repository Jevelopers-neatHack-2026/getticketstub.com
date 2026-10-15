import "server-only";
import type { Order } from "@/customer/pages/commerce";
import { SHIPPING_ESTIMATE_MINOR, unitPriceMinor } from "@/customer/pages/prices";
import { HttpError } from "@/server/http";

type Priced = Pick<Order, "lines" | "totalMinor">;

const MAX_QUANTITY = 200;

/**
 * Checks a paid order's amounts against the price list before anything is charged. Each line must be a whole number
 * of stubs at the listed unit price (seats multiply it), and the total must be the lines plus flat shipping when any
 * line is physical. Returns the total to charge; throws 422 `amount_mismatch` when the browser's numbers disagree.
 */
export function verifiedTotalMinor(order: Priced): number {
  let sum = 0;
  for (const line of order.lines) {
    const unit = unitPriceMinor(line.material, line.finish);
    const quantity = unit > 0 ? line.totalMinor / unit : 0;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw mismatch();
    sum += line.totalMinor;
  }
  const total = sum + (order.lines.some((l) => l.material !== "digital") ? SHIPPING_ESTIMATE_MINOR : 0);
  if (total !== order.totalMinor) throw mismatch();
  return total;
}

/**
 * Only a variant confirmed orderable can be charged. Its status is derived on the server from the capability map
 * (orders route), never taken from the browser. A preview (an unconfirmed print SKU, or holo) stays a sandbox order.
 */
export const allOrderable = (order: Pick<Order, "lines">) => order.lines.length > 0 && order.lines.every((l) => l.variantStatus === "orderable");

/** Dodo Payments only accepts digitally delivered goods, so only an all-digital order can be paid there. */
export const isDigitalOnly = (order: Pick<Order, "lines">) => order.lines.length > 0 && order.lines.every((l) => l.material === "digital");

const mismatch = () => new HttpError(422, "amount_mismatch", "The price changed. Refresh to see the current price.");
