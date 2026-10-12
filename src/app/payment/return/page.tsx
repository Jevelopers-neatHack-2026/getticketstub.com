import type { Metadata } from "next";
import { EmptyState, PaperLink, StampLink } from "@/customer/pages/ui";

export const metadata: Metadata = { title: "Payment · TicketStub", robots: { index: false } };

/**
 * Where the payment provider sends the buyer back. The query string is only a hint for the wording: whether the order
 * is paid is decided by the provider's signed webhook, which also sends the receipt.
 */
export default async function PaymentReturn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const status = typeof q.status === "string" ? q.status : "";
  const failed = status === "failed" || status === "cancelled";
  return (
    <main className="desk-surface" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "var(--ts-space-5)" }}>
      {failed ? (
        <EmptyState kind="stub" title="The payment didn't go through." body="Nothing was charged. Your stub is still on your desk, so you can try again.">
          <StampLink href="/cart">Back to your cart</StampLink>
          <PaperLink href="/wall">Your wall</PaperLink>
        </EmptyState>
      ) : (
        <EmptyState kind="stub" title="Thanks. We're confirming your payment." body="Your receipt arrives by email as soon as the payment is confirmed, usually within a minute.">
          <StampLink href="/wall">Your wall</StampLink>
          <PaperLink href="/make">Make another stub</PaperLink>
        </EmptyState>
      )}
    </main>
  );
}
