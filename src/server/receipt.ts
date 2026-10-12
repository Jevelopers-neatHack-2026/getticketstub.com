import "server-only";
import type { Order } from "@/customer/pages/commerce";
import { newToken } from "@/server/crypto";
import { getStorage } from "@/server/index";
import { sendMail } from "@/server/mail";
import { receiptMail, stubImageUrl } from "@/server/templates";

/** Emails an order's receipt. Never throws: the order is kept either way, and sendMail logs why a receipt didn't go. */
export async function sendReceipt(order: Order, accountId: string | null, email: string, origin: string): Promise<void> {
  try {
    // A signed-in order can show its first stub: snapshot it as a share so the email picture can render it.
    let shareToken: string | null = null;
    const first = accountId ? (await getStorage().listWall(accountId)).find((s) => s.id === order.stubIds[0]) : undefined;
    if (accountId && first) shareToken = await getStorage().upsertShare(accountId, first, newToken(9), Date.now());
    await sendMail(email, receiptMail(order, `${origin}/wall`, stubImageUrl(origin, shareToken)), `receipt ${order.id}`);
  } catch {
    // The order is saved either way.
  }
}
