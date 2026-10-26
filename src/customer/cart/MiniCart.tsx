"use client";
// The mini cart: a paper sheet that slides in from the right over whatever screen you are on. It lists the
// lines with their stubs, takes a remove (with undo), shows the total, and hands "Check out" to the cart's
// own pay step so there is one pay flow. Esc, the scrim and a swipe to the right close it; closing leaves
// you exactly where you were.
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { MarkLegend, SandboxStrip, SourceMark, Stamp, TearLink } from "@/customer/desk/Desk";
import { CloseIcon } from "@/customer/desk/icons";
import { LeavesMark, PaperLink } from "@/customer/pages/ui";
import { SANDBOX_LABEL, billableSeats, cartMarks, cartTotals, restoreCartItem, saveCart, type CartItem } from "@/customer/pages/commerce";
import { flow, major, variantId } from "@/customer/flows/events";
import { CartLineSpec } from "@/customer/studio/editor/MaterialPicker";
import { haptic, play } from "@/customer/studio/feedback";
import { getStub } from "@/customer/studio/store";
import { StubView } from "@/customer/studio/stub/StubView";
import { formatMoney } from "@/customer/studio/types";
import { closeMiniCart, useCartItems, useMiniCartOpen } from "./cartStore";
import m from "./MiniCart.module.css";

type Phase = "closed" | "open" | "closing";

function seatLine(item: CartItem): string {
  if (billableSeats(item) === 0) return "No retained seats · not charged";
  if (item.seats.length < 2) return "Just you";
  const open = item.seats.filter((s) => s && typeof s === "object" && !s.claimed && !s.decision).length;
  const claimed = item.seats.filter((s) => s && typeof s === "object" && s.claimed).length;
  return `Set of ${item.seats.length} · ${claimed} claimed${open ? `, ${open} not claimed yet` : ""}`;
}

export function MiniCart() {
  const open = useMiniCartOpen();
  const path = usePathname();
  const router = useRouter();
  const items = useCartItems();
  const [phase, setPhase] = useState<Phase>("closed");
  const shut = phase === "closed"; // a closed cart is not in the page at all: no dialog to find, nothing to Tab into
  const [removed, setRemoved] = useState<{ item: CartItem; index: number } | null>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number; live: boolean } | null>(null);
  const swiped = useRef(false);
  // the items as of the last render, for the open effect (which must not re-run when the cart changes)
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  if (open && phase !== "open") setPhase("open");
  else if (!open && phase === "open") setPhase("closing");

  // the sheet belongs to the screen it was opened on: going anywhere closes it
  useEffect(() => closeMiniCart(), [path]);

  useEffect(() => {
    if (phase === "open") {
      const t = cartTotals(itemsRef.current);
      flow("view_cart", { currency: "USD", value: major(t.totalMinor), item_count: itemsRef.current.length, context: "mini_cart" });
      swiped.current = false;
      play("open", { emphasis: "subtle" });
      closeRef.current?.focus();
    } else if (phase === "closing") {
      play("close", { emphasis: "subtle" });
      document.querySelector<HTMLElement>("[data-cart-button]")?.focus({ preventScroll: true });
      const t = setTimeout(
        () => {
          setPhase("closed");
          setRemoved(null);
        },
        swiped.current ? 200 : 260,
      );
      return () => clearTimeout(t);
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "open") return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && closeMiniCart();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  useEffect(() => {
    if (!removed) return;
    const t = setTimeout(() => setRemoved(null), 8000);
    return () => clearTimeout(t);
  }, [removed]);

  const stubs = useMemo(() => Object.fromEntries(items.map((i) => [i.stubId, getStub(i.stubId)])), [items]);
  const totals = cartTotals(items);

  if (phase === "closed") return null;

  const remove = (item: CartItem) => {
    setRemoved({ item, index: items.findIndex((c) => c.id === item.id) });
    if (saveCart(items.filter((c) => c.id !== item.id))) {
      flow("remove_from_cart", { currency: "USD", value: major(item.unitMinor * billableSeats(item)), item_id: variantId(item.material, item.finish, item.size), quantity: billableSeats(item), context: "mini_cart" });
    }
    haptic(8);
  };

  // keep Tab inside the sheet while it is open
  const trap = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    const f = [...(sheetRef.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? [])].filter((el) => !el.hasAttribute("disabled"));
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const down = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse") return;
    drag.current = { x: e.clientX, y: e.clientY, live: false };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = sheetRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    if (!d.live && dx > 10 && Math.abs(e.clientY - d.y) < dx) d.live = true;
    if (d.live) el.style.transform = `translateX(${Math.max(0, dx)}px)`;
  };
  const up = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = sheetRef.current;
    drag.current = null;
    if (!d?.live || !el) return;
    if (e.clientX - d.x > 80) {
      swiped.current = true;
      el.dataset.swiped = "true";
      el.style.transform = "translateX(105%)";
      closeMiniCart();
    } else {
      el.style.transform = "";
    }
  };

  return (
    <div className={m.root} data-phase={phase} inert={shut}>
      <button type="button" className={m.scrim} aria-label="Close the cart" tabIndex={-1} onClick={closeMiniCart} />
      <section
        ref={sheetRef}
        className={m.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Your cart"
        onKeyDown={trap}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <header className={m.head}>
          <div>
            <p className="desk-label">{items.length === 0 ? "Nothing yet" : `${items.length} ${items.length === 1 ? "stub" : "stubs"}`}</p>
            <h2 className={m.title}>Your cart</h2>
          </div>
          <button ref={closeRef} type="button" className={m.close} onClick={closeMiniCart} aria-label="Close the cart">
            <CloseIcon />
          </button>
        </header>

        <div className={m.body}>
          {items.length === 0 ? (
            <div className={m.empty}>
              <p className={m.emptyTitle}>Your cart is waiting for its first stub.</p>
              <p className={m.muted}>Print one from your wall, or build a matching set for the people you went with. It lands here until you pay.</p>
              <div onClick={closeMiniCart}>
                <PaperLink href="/wall">Open your wall</PaperLink>
              </div>
            </div>
          ) : (
            <ul className={m.list}>
              {items.map((item) => {
                const st = stubs[item.stubId];
                const billable = billableSeats(item);
                return (
                  <li key={item.id} className={m.item}>
                    <div className={m.thumb}>{st ? <StubView stub={st} size="sm" /> : <div className={m.thumbEmpty} aria-hidden />}</div>
                    <div className={m.info}>
                      <h3 className={m.itemTitle}>{item.title}</h3>
                      <CartLineSpec item={item} className={m.muted} />
                      <p className={m.muted}>{seatLine(item)}</p>
                      <p className={m.price}>
                        {billable > 1 ? <span className={m.each}>{`${billable} × ${formatMoney(item.unitMinor)}`}</span> : null}
                        <strong>{formatMoney(item.unitMinor * billable)}</strong>
                      </p>
                      <TearLink type="button" onClick={() => remove(item)}>
                        Remove
                      </TearLink>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {removed ? (
            <p className={m.undo} data-announce>
              <span>Removed {removed.item.title}.</span>
              <TearLink
                type="button"
                onClick={() => {
                  if (restoreCartItem(removed.item, removed.index)) flow("cart_update", { action: "remove_undo" });
                  setRemoved(null);
                }}
              >
                Undo
              </TearLink>
            </p>
          ) : null}
        </div>

        {items.length > 0 ? (
          <footer className={m.foot}>
            <SandboxStrip>{SANDBOX_LABEL}</SandboxStrip>
            <dl className={m.dl}>
              {totals.shippingMinor ? (
                <div className={m.line}>
                  <dt>Shipping</dt>
                  <dd>
                    {formatMoney(totals.shippingMinor)}
                    <SourceMark p="estimated" />
                  </dd>
                </div>
              ) : null}
              <div className={`${m.line} ${m.total}`}>
                <dt>Total</dt>
                <dd>{formatMoney(totals.totalMinor)}</dd>
              </div>
            </dl>
            <Stamp
              block
              disabled={!items.some((item) => billableSeats(item) > 0)}
              onClick={() => {
                if (!items.some((item) => billableSeats(item) > 0)) return;
                closeMiniCart();
                router.push("/cart#pay");
              }}
            >
              Check out
              <LeavesMark />
            </Stamp>
            <div onClick={closeMiniCart}>
              <PaperLink block href="/cart">
                Open full cart
              </PaperLink>
            </div>
            <MarkLegend marks={["estimated", ...cartMarks(items)]} />
          </footer>
        ) : null}
      </section>
    </div>
  );
}
