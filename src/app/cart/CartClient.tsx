"use client";
import { useEffect, useRef, useState } from "react";
import { MarkLegend, SandboxStrip, SourceMark, Stamp, TearLink, Rule } from "@/customer/desk/Desk";
import { StubView } from "@/customer/studio/stub/StubView";
import { haptic } from "@/customer/studio/feedback";
import { getStub, upsertStub } from "@/customer/studio/store";
import { formatMoney, type Stub } from "@/customer/studio/types";
import { CartLineSpec } from "@/customer/studio/editor/MaterialPicker";
import { PageShell, EmptyState, PaperLink, StampLink, TearAnchor, ui } from "@/customer/pages/ui";
import { AfterPay, PayResumeNote, ReceiptField, askToSignIn, useReceiptEmail } from "@/customer/account/Receipt";
import { useOrderFlow } from "@/customer/account/useOrderFlow";
import { CART_EVENT, SANDBOX_LABEL, billableSeats, cartItemState, cartMarks, cartTotals, loadCart, saveCart, type CartItem, type CartSeat } from "@/customer/pages/commerce";
import { CAPABILITY_VERSION, orderGate, runtimeMode, variantFor } from "@/customer/pages/capabilities";
import { useMounted } from "@/customer/pages/useMounted";
import { flow, major, variantId } from "@/customer/flows/events";
import s from "./cart.module.css";

function seatStatus(seat: CartSeat): string {
  if (seat.decision === "drop") return "Dropped, not charged";
  if (seat.claimed) return "Claimed";
  if (seat.decision === "seat-only") return "Prints with the seat number only";
  if (seat.decision === "gift") return "Sent as a gift";
  return "Not claimed yet";
}

export default function CartClient() {
  const mounted = useMounted();
  const [items, setItems] = useState<CartItem[]>([]);
  const [stubs, setStubs] = useState<Record<string, Stub | undefined>>({});
  const [paid, setPaid] = useState(false);
  // set before the cart is cleared, so the page keeps its receipt instead of following the cart to empty
  const paidRef = useRef(false);
  const { placed, progress, place: placeOrder, retry } = useOrderFlow();
  const [emailError, setEmailError] = useState("");
  const receipt = useReceiptEmail();

  const [loaded, setLoaded] = useState(false);
  if (mounted && !loaded) {
    const cart = loadCart();
    setLoaded(true);
    setItems(cart);
    setStubs(Object.fromEntries(cart.map((c) => [c.stubId, getStub(c.stubId)])));
  }

  // One view per visit, once the stored cart is read (not on every render, not again on a Strict Mode remount).
  const viewed = useRef(false);
  useEffect(() => {
    if (!loaded || viewed.current) return;
    viewed.current = true;
    const cart = loadCart();
    flow("view_cart", { currency: "USD", value: major(cartTotals(cart).totalMinor), item_count: cart.length, context: "cart" });
  }, [loaded]);
  const checkoutBegun = useRef(false);
  const guestPlacement = useRef<(() => void) | null>(null);

  // The mini cart edits the same cart: follow it, until the order is placed (then this page keeps its receipt).
  useEffect(() => {
    if (!loaded) return;
    const sync = () => {
      if (paidRef.current) return;
      const cart = loadCart();
      setItems(cart);
      setStubs(Object.fromEntries(cart.map((c) => [c.stubId, getStub(c.stubId)])));
    };
    window.addEventListener(CART_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CART_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [loaded]);

  function remove(id: string) {
    const gone = items.find((c) => c.id === id);
    const next = items.filter((c) => c.id !== id);
    setItems(next);
    if (saveCart(next) && gone) {
      flow("remove_from_cart", { currency: "USD", value: major(gone.unitMinor * billableSeats(gone)), item_id: variantId(gone.material, gone.finish, gone.size), quantity: billableSeats(gone), context: "cart" });
    }
  }

  // Every retained line goes back through the capability map before it can be paid: a line saved before the map, or under another
  // version, has to be chosen again, and the gate holds back anything that can't be ordered in this mode.
  const mode = runtimeMode();
  const retained = items.filter((i) => billableSeats(i) > 0);
  const stale = retained.filter((i) => cartItemState(i).state === "choose-again");
  const blocked = retained.map((i) => orderGate(variantFor(i.material, i.size, i.finish), mode)).find((g) => !g.ok);
  const hold = stale.length > 0 ? `${stale.length === 1 ? "One stub needs" : `${stale.length} stubs need`} you to choose again before you can pay.` : blocked && !blocked.ok ? blocked.message : "";

  // Signed out, Pay opens the sign-in sheet first; "Continue as guest" (or being signed in) goes straight on.
  function pay() {
    if (paid || retained.length === 0) return;
    if (!hold && !receipt.problem && askToSignIn(receipt, () => guestPlacement.current?.())) return;
    placeAsGuest();
  }
  function placeAsGuest() {
    if (paidRef.current || paid || retained.length === 0) return;
    if (!checkoutBegun.current) {
      checkoutBegun.current = true;
      const t = cartTotals(items);
      flow("begin_checkout", { currency: "USD", value: major(t.totalMinor), item_id: retained.length === 1 ? variantId(retained[0].material, retained[0].finish, retained[0].size) : undefined, item_count: retained.length, context: "cart", capability: "sandbox" });
    }
    if (hold) {
      flow("checkout_invalid", { reason: stale.length > 0 ? "choose_again" : "variant_blocked" });
      setEmailError(hold);
      return;
    }
    if (receipt.problem) {
      flow("checkout_invalid", { reason: "email" });
      setEmailError(receipt.problem);
      document.getElementById("cart-email")?.focus();
      return;
    }
    paidRef.current = true;
    setPaid(true);
    // a sandbox card: nothing is charged. placeOrder reports the order once the server answers.
    flow("add_payment_info", { payment_type: "card", capability: "sandbox" });
    const totals = cartTotals(items);
    placeOrder({
      stubIds: retained.map((i) => i.stubId),
      lines: retained.map((i) => ({ title: i.title, material: i.material, finish: i.finish, size: i.size, totalMinor: i.unitMinor * billableSeats(i), variantStatus: variantFor(i.material, i.size, i.finish)?.status })),
      capabilityVersion: CAPABILITY_VERSION,
      totalMinor: totals.totalMinor,
      currency: "USD",
      // one quote names the order only when the cart holds one priced item
      quoteId: retained.length === 1 ? retained[0].quoteId : undefined,
      method: "card",
      email: receipt.email || undefined,
    }, () => {
      for (const i of retained) {
        const st = stubs[i.stubId];
        if (st) upsertStub({ ...st, material: i.material, finish: i.finish, torn: true });
      }
      saveCart([]);
    });
    haptic([18, 40, 28]);
  }

  // The open sheet must use this tab's current cart, including changes made in another tab.
  useEffect(() => {
    guestPlacement.current = placeAsGuest;
    return () => { guestPlacement.current = null; };
  });

  const totals = cartTotals(items);

  return (
    <PageShell back={{ href: "/wall", label: "Wall" }} title="Your cart">
      {!mounted ? null : items.length === 0 ? (
        <EmptyState kind="cart" title="Nothing in your cart yet." body="Print a stub from your wall, or build a matching set for the people you went with. It lands here until you pay.">
          <StampLink href="/wall">Open your wall</StampLink>
        </EmptyState>
      ) : retained.length === 0 && !paid ? (
        <EmptyState kind="cart" title="No seats left to check out." body="This cart has no retained seats. Nothing will be charged. Add a stub from your wall to start again.">
          <StampLink href="/wall">Open your wall</StampLink>
        </EmptyState>
      ) : (
        <>
          <SandboxStrip>{SANDBOX_LABEL}</SandboxStrip>
          <div className={s.layout}>
            <section aria-labelledby="cart-h" className={s.items}>
              <h1 id="cart-h" className={s.title}>
                Your cart
              </h1>
              <ul className={s.list}>
                {items.map((item) => {
                  const st = stubs[item.stubId];
                  const billable = billableSeats(item);
                  return (
                    <li key={item.id} className={s.item}>
                      <div className={s.itemHead}>
                        <div className={s.thumb}>{st ? <StubView stub={st} size="sm" /> : <div className={s.thumbEmpty} aria-hidden="true" />}</div>
                        <div className={s.itemInfo}>
                          <h2 className={s.itemTitle}>{item.title}</h2>
                          <CartLineSpec item={item} className={ui.muted} />
                          <p className={s.price}>
                            {billable > 1 ? <span className={s.each}>{`${billable} × ${formatMoney(item.unitMinor)}`}</span> : null}
                            <strong>{formatMoney(item.unitMinor * billable)}</strong>
                          </p>
                          <TearLink type="button" onClick={() => remove(item.id)}>
                            Remove
                          </TearLink>
                        </div>
                      </div>
                      {Array.isArray(item.seats) && item.seats.length > 1 ? (
                        <div className={s.seats}>
                          <Rule kind="perf" />
                          <p className="desk-label">Matching set · {item.seats.length} seats</p>
                          <ul className={s.seatList}>
                            {item.seats.map((seat, i) => {
                              if (!seat || typeof seat !== "object") return null;
                              const open = !seat.claimed && !seat.decision;
                              const label = `${seat.name}${seat.seat ? ` · ${seat.seat}` : ""}`;
                              return (
                                <li key={i} className={s.seatRow}>
                                  <span>{label}</span>
                                  {open ? (
                                    <TearAnchor href={`/cart/unclaimed/${item.id}?seat=${i}`}>Not claimed yet · decide</TearAnchor>
                                  ) : (
                                    <span className={s.seatStatus}>{seatStatus(seat)}</span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <div>
                <PaperLink href="/wall">Add another stub from your wall</PaperLink>
              </div>
            </section>

            <aside id="pay" className={s.summary} aria-labelledby="sum-h">
              <h2 id="sum-h" className={s.sumTitle}>
                Summary
              </h2>
              <dl className={s.dl}>
                <div className={s.line}>
                  <dt>Stubs</dt>
                  <dd>{formatMoney(totals.itemsMinor)}</dd>
                </div>
                {totals.shippingMinor ? (
                  <div className={s.line}>
                    <dt>Shipping</dt>
                    <dd>
                      {formatMoney(totals.shippingMinor)}
                      <SourceMark p="estimated" />
                    </dd>
                  </div>
                ) : null}
                <div className={`${s.line} ${s.total}`}>
                  <dt>Total</dt>
                  <dd>{formatMoney(totals.totalMinor)}</dd>
                </div>
              </dl>
              <p className={s.quote}>
                Quote holds for 15 min
                <SourceMark p="estimated" />. A quote is not a charge. Prices are sandbox fixtures, not printer quotes · capability map {CAPABILITY_VERSION}.
              </p>
              {paid ? null : <ReceiptField id="cart-email" r={receipt} error={emailError === hold ? "" : emailError} onChange={() => setEmailError("")} />}
              {paid ? null : <PayResumeNote r={receipt} />}
              {hold && !paid ? (
                <p className={ui.err} data-announce>
                  {hold}
                </p>
              ) : null}
              {paid ? (
                <div className={s.done}>
                  <AfterPay placed={placed} email={receipt.email} signedIn={receipt.signedIn} progress={progress} onRetry={retry} />
                </div>
              ) : (
                <Stamp block onClick={pay} disabled={!!hold}>
                  Pay {formatMoney(totals.totalMinor)}
                </Stamp>
              )}
              <MarkLegend marks={["estimated", ...cartMarks(items)]} />
            </aside>
          </div>
        </>
      )}
    </PageShell>
  );
}
