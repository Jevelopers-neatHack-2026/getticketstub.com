import "server-only";
import type { Order } from "@/customer/pages/commerce";
import { createCheckout as createDodoCheckout, dodoConfig } from "./dodo";
import { allOrderable, isDigitalOnly } from "./pricing";
import { createCheckout as createStripeCheckout, stripeConfig } from "./stripe";

/** Methods a hosted provider checkout collects. Gift and organizer prints are not paid this way. */
const PAID_METHODS = new Set<Order["method"]>(["apple-pay", "google-pay", "card"]);

export interface CheckoutInput {
  orderId: string;
  amountMinor: number;
  email: string;
  returnUrl: string;
  description: string;
}

/** The one provider that charges an order, resolved once. */
export interface Provider {
  name: "dodo" | "stripe";
  environment: "test_mode" | "live_mode";
  create(input: CheckoutInput): Promise<{ sessionId: string; checkoutUrl: string }>;
}

/**
 * A card or wallet order whose variants are all orderable is charged, and only when its provider is configured:
 * Dodo for all-digital (it only takes digital goods), Stripe for anything with a physical line (#64). Anything else
 * (a preview variant such as an unconfirmed print SKU or digital holo, a gift or organizer print) stays a sandbox order.
 */
export function providerFor(order: Pick<Order, "lines" | "method">): Provider | null {
  if (!allOrderable(order) || !PAID_METHODS.has(order.method)) return null;
  if (isDigitalOnly(order)) {
    const cfg = dodoConfig();
    return cfg && { name: "dodo", environment: cfg.environment, create: (i) => createDodoCheckout(cfg, i) };
  }
  const cfg = stripeConfig();
  return cfg && { name: "stripe", environment: cfg.environment, create: (i) => createStripeCheckout(cfg, i) };
}
