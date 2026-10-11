"use client";
import { useState } from "react";
import { Field, PaperButton, PunchTabs, Rule, SandboxStrip, Stamp, Tag, Tags } from "@/customer/desk/Desk";
import { StubView } from "@/customer/studio/stub/StubView";
import { play, haptic } from "@/customer/studio/feedback";
import { encodeStub, getStub, upsertStub } from "@/customer/studio/store";
import { formatMoney, type Stub } from "@/customer/studio/types";
import { PageShell, CopyField, EmptyArt, EmptyState, OnDesk, StampLink, ui } from "@/customer/pages/ui";
import { SANDBOX_LABEL, cartItemFromStub, quote, defaultSize } from "@/customer/pages/commerce";
import { addToCartAndFly } from "@/customer/cart/cartStore";
import { useMounted } from "@/customer/pages/useMounted";
import { flow } from "@/customer/flows/events";
import s from "./friends.module.css";

type Mode = "make" | "claim";

const MODES = [
  { value: "claim" as const, label: "Send a claim link", sub: "They add their name" },
  { value: "make" as const, label: "I'll make them all", sub: "You hand them out" },
];

export default function FriendsClient({ id }: { id: string }) {
  const mounted = useMounted();
  const [stub, setStub] = useState<Stub | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("claim");

  if (mounted && stub === undefined) {
    const st = getStub(id) ?? null;
    setStub(st);
    if (st && st.personal.friends.length > 0 && st.personal.friends.every((f) => f.claimed)) setMode("make");
  }

  if (!mounted || stub === undefined) return <PageShell back={{ href: `/studio/${id}`, label: "Back to your stub" }}>{null}</PageShell>;
  if (stub === null) {
    return (
      <PageShell back={{ href: "/wall", label: "Wall" }}>
        <EmptyState kind="stub" title="This stub isn't on this device." body="Matching stubs start from a stub you made here. Open your wall and pick the one you went with.">
          <StampLink href="/wall">Open your wall</StampLink>
        </EmptyState>
      </PageShell>
    );
  }

  const friends = stub.personal.friends;

  function save(nextFriends: Stub["personal"]["friends"], m: Mode = mode, action: "add" | "remove" | "mode" = "mode") {
    if (!stub) return;
    const renumbered = nextFriends.map((f, i) => ({ ...f, seat: `Seat ${i + 2}`, claimed: m === "make" }));
    const next: Stub = { ...stub, setId: stub.setId ?? stub.id, personal: { ...stub.personal, friends: renumbered } };
    const stored = upsertStub(next);
    // counts only: never the names
    flow("friends_update", { action, friend_count: renumbered.length, mode: m, storage: stored ? "ok" : "failed" });
    setStub(next);
  }

  function add() {
    const n = name.trim();
    if (!n) return;
    save([...friends, { name: n, claimed: false }], mode, "add");
    setName("");
    play("pin");
    haptic([12]);
  }

  const setId = stub.setId ?? stub.id;
  const claimPath = `/claim/${encodeURIComponent(setId)}?from=${encodeStub({ ...stub, setId })}`;
  const seats = friends.length + 1;
  const material = stub.material === "digital" ? "print" : stub.material;
  const size = defaultSize(stub, material);
  const q = quote(material, stub.finish, size);
  const unit = q.itemMinor + q.finishMinor;

  return (
    <PageShell back={{ href: `/studio/${stub.id}`, label: "Back to your stub" }} narrow>
      <SandboxStrip>{SANDBOX_LABEL}</SandboxStrip>
      <div className={s.wrap}>
        <header className={s.head}>
          <p className="desk-label">{stub.event.title}</p>
          <h1 className={s.title}>Send matching stubs.</h1>
          <p className={ui.lede}>Everyone you went with gets the same design, with their own name and seat.</p>
        </header>

        <OnDesk>
          <StubView stub={stub} size="sm" tilt />
        </OnDesk>

        <section aria-labelledby="seats-h" className={s.block}>
          <h2 id="seats-h" className="desk-label">
            Seats · <span className={ui.num}>{seats}</span>
          </h2>
          <Tags label="Seats in this set">
            <Tag pressed disabled aria-label="You, Seat 1">
              You · Seat 1
            </Tag>
            {friends.map((f, i) => (
              <Tag key={`${f.name}-${i}`} onClick={() => save(friends.filter((_, j) => j !== i), mode, "remove")} aria-label={`Remove ${f.name}`}>
                {f.name} · {f.seat ?? `Seat ${i + 2}`} ×
              </Tag>
            ))}
          </Tags>
          <form
            className={s.addRow}
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Field id="friend-name" label="Add a friend" placeholder="Their name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            <PaperButton type="submit" disabled={!name.trim()}>
              Add
            </PaperButton>
          </form>
        </section>

        {friends.length === 0 ? (
          <div className={s.nobody}>
            <EmptyArt kind="set" />
            <p className={ui.muted}>Who stood next to you? Add their names and each one gets a stub with their own seat.</p>
          </div>
        ) : (
          <>
            <Rule kind="perf" />
            <section aria-labelledby="how-h" className={s.block}>
              <h2 id="how-h" className="desk-label">
                How they get their stub
              </h2>
              <PunchTabs
                label="How they get their stub"
                options={MODES}
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  save(friends, m);
                }}
              />
            </section>

            {mode === "claim" ? (
              <section className={ui.card} aria-labelledby="link-h">
                <h2 id="link-h" className={ui.h3}>
                  Your claim link
                </h2>
                <CopyField path={claimPath} label="Claim link" context="friends" content="invite" />
                <p className={ui.muted}>Anyone with the link can claim a seat in this set.</p>
              </section>
            ) : null}

            <Stamp
              block
              price={`${seats} × ${formatMoney(unit)}`}
              onClick={(e) => addToCartAndFly(cartItemFromStub(stub, material, stub.finish, size), stub, e.currentTarget, "friends")}
            >
              Add the set to your cart
            </Stamp>
          </>
        )}
      </div>
    </PageShell>
  );
}
