"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MarkLegend, Rule, SandboxStrip, SourceMark, Stamp } from "@/customer/desk/Desk";
import { play } from "@/customer/studio/feedback";
import { formatMoney } from "@/customer/studio/types";
import { LeavesMark, PageShell, EmptyState, StampLink, TearAnchor, ui } from "@/customer/pages/ui";
import { loadCart, updateSeat, type CartItem } from "@/customer/pages/commerce";
import { useMounted } from "@/customer/pages/useMounted";
import { flow } from "@/customer/flows/events";
import s from "./unclaimed.module.css";

const TIMELINE = [
  { day: "Day 0", text: "You bought the set. Claim links went out." },
  { day: "Days 1–6", text: "Friends claim their seats and add their name." },
  { day: "Day 7", text: "Still open? You decide what happens to the seat." },
];

type Choice = "seat-only" | "gift" | "drop";

export default function UnclaimedClient({ id, seatIndex }: { id: string; seatIndex?: number }) {
  const router = useRouter();
  const mounted = useMounted();
  const [item, setItem] = useState<CartItem | null | undefined>(undefined);
  const [choice, setChoice] = useState<Choice>("seat-only");

  if (mounted && item === undefined) setItem(loadCart().find((c) => c.id === id || c.stubId === id) ?? null);

  if (!mounted || item === undefined) return <PageShell back={{ href: "/cart", label: "Cart" }}>{null}</PageShell>;

  const idx = seatIndex ?? item?.seats.findIndex((x) => !x.claimed && !x.decision) ?? -1;
  const seat = item && idx >= 0 ? item.seats[idx] : undefined;

  if (!item || !seat) {
    return (
      <PageShell back={{ href: "/cart", label: "Cart" }}>
        <EmptyState kind="set" title="Every seat in this set is sorted." body="Nothing is waiting on you here. Everyone has claimed their stub or you've decided what to do with it.">
          <StampLink href="/cart">Back to your cart</StampLink>
        </EmptyState>
      </PageShell>
    );
  }

  const label = `${seat.name}${seat.seat ? ` · ${seat.seat}` : ""}`;
  const giftHref = `/gift/${encodeURIComponent(item.stubId)}?for=${encodeURIComponent(seat.name)}&from=cart&item=${encodeURIComponent(item.id)}&seat=${idx}`;

  const options: { id: Choice; title: string; body: React.ReactNode }[] = [
    { id: "seat-only", title: "Print it with the seat number only", body: "The stub prints without a name. You can hand it over later." },
    { id: "gift", title: "Gift it by name", body: "Send the stub to someone as a gift, with their name on it." },
    { id: "drop", title: "Drop it and get a refund", body: `${formatMoney(item.unitMinor)} comes back to you. No stub is printed for this seat.` },
  ];

  function confirm() {
    if (choice === "gift") {
      router.push(giftHref);
      return;
    }
    // a sandbox decision: "drop" is a simulated refund, no money moves
    if (updateSeat(item!.id, idx, { decision: choice })) flow("seat_decision", { decision: choice === "seat-only" ? "seat_only" : "drop" });
    if (choice === "drop") play("tear");
    router.push("/cart");
  }

  const cta = choice === "gift" ? "Gift it" : choice === "drop" ? `Drop it · refund ${formatMoney(item.unitMinor)}` : "Print with the seat number";

  return (
    <PageShell back={{ href: "/cart", label: "Cart" }} narrow>
      <SandboxStrip>Sandbox refund. No real money moves.</SandboxStrip>
      <div className={s.wrap}>
        <header className={s.head}>
          <p className="desk-label">{item.title} · matching set</p>
          <h1 className={s.title}>{seat.name}&apos;s seat is still open.</h1>
          <p className={ui.lede}>
            <span className={s.num}>{label}</span> has gone unclaimed for 7 days. Pick what happens to it.
          </p>
        </header>

        <section className={s.timeline} aria-labelledby="tl-h">
          <h2 id="tl-h" className="desk-label">
            How the week went
            <SourceMark p="simulated" />
          </h2>
          <ol className={s.steps}>
            {TIMELINE.map((t, i) => (
              <li key={t.day} className={i === TIMELINE.length - 1 ? s.now : undefined}>
                <span className={s.day}>{t.day}</span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <Rule kind="perf" />

        <div role="radiogroup" aria-label="What happens to this seat" className={s.choices}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={choice === o.id}
              className={s.choice}
              onClick={() => {
                if (choice !== o.id) play("select", { direction: options.findIndex((x) => x.id === o.id) > options.findIndex((x) => x.id === choice) ? "forward" : "back" });
                setChoice(o.id);
              }}
            >
              <span className={s.punch} aria-hidden />
              <strong>{o.title}</strong>
              <span className={s.body}>{o.body}</span>
            </button>
          ))}
        </div>

        <div className={s.actions}>
          <Stamp block onClick={confirm}>
            {cta}
            <LeavesMark />
          </Stamp>
          <TearAnchor href="/cart">Decide later, back to your cart</TearAnchor>
        </div>
        <MarkLegend marks={["simulated"]} />
      </div>
    </PageShell>
  );
}
