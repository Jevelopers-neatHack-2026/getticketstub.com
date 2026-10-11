"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Field, MarkLegend, PaperButton, SourceMark, Stamp } from "@/customer/desk/Desk";
import { openSignIn } from "@/customer/account/signin";
import { useAccount } from "@/customer/account/useAccount";
import { StubView } from "@/customer/studio/stub/StubView";
import { haptic } from "@/customer/studio/feedback";
import { NEATHACK, newStub } from "@/customer/studio/fixtures";
import { decodeStub, encodeStub, upsertStub } from "@/customer/studio/store";
import type { Stub } from "@/customer/studio/types";
import { LeavesMark, PageShell, FriendlyError, OnDesk, QrPlaceholder, ui } from "@/customer/pages/ui";
import { formatDate, isStub } from "@/customer/pages/share";
import { useMounted } from "@/customer/pages/useMounted";
import { flow } from "@/customer/flows/events";
import s from "./claim.module.css";

export default function ClaimClient({ set, from }: { set: string; from?: string }) {
  const router = useRouter();
  const mounted = useMounted();
  const source = useMemo(() => {
    if (!mounted || !from) return undefined;
    const d = decodeStub(from);
    return isStub(d) ? d : undefined;
  }, [mounted, from]);
  const event = set === "neathack" ? NEATHACK : source?.event;

  const { status: acct, account, savingOff } = useAccount();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const here = mounted ? window.location.href : "";

  // Seat: only what the sender's list actually says. With no list there is no seat to print.
  const friends = source?.personal.friends ?? [];
  const openIdx = friends.findIndex((f) => !f.claimed);
  const seatLabel = openIdx >= 0 ? (friends[openIdx].seat ?? `Seat ${openIdx + 2}`) : undefined;

  const preview = useMemo<Stub | null>(() => {
    if (!event) return null;
    const st = newStub(event, `preview-${set}`);
    if (source) {
      st.versions = source.versions;
      st.currentVersionId = source.currentVersionId;
      st.personal = { ...source.personal, friends: [] };
    }
    st.personal = { ...st.personal, friends: [{ name: name.trim() || "Your name", seat: seatLabel, claimed: true }] };
    st.setId = set;
    st.wallAngle = 0;
    return st;
  }, [event, source, set, name, seatLabel]);

  // Whether the set link opened, once the page has read it (never the sender's stub or names).
  const viewed = useRef(false);
  useEffect(() => {
    if (!mounted || viewed.current) return;
    viewed.current = true;
    flow("claim_view", { flow: "set", result: event ? "valid" : "invalid" });
  }, [mounted, event]);

  if (!mounted) return <PageShell>{null}</PageShell>;
  if (!event || !preview) {
    return (
      <PageShell>
        <FriendlyError title="We couldn't find this set." body="The claim link may be cut short. Ask the person who sent it for the link again." />
      </PageShell>
    );
  }

  function claim() {
    const n = name.trim();
    if (!n) {
      flow("claim_invalid", { flow: "set", reason: "name_missing" });
      setError("Add your name so it prints on your stub.");
      return;
    }
    setClaiming(true);
    const st = newStub(event!);
    if (source) {
      st.versions = source.versions;
      st.currentVersionId = source.currentVersionId;
      st.personal = { ...source.personal, note: undefined };
    }
    const others = friends.filter((_, i) => i !== openIdx).map((f) => ({ ...f }));
    st.personal = { ...st.personal, friends: [{ name: n, seat: seatLabel, claimed: true }, ...others] };
    st.setId = set;
    st.torn = true;
    // a local claim: the stub is on this device's wall (signed in, the sync takes it to the account)
    flow("claim_complete", { flow: "set", result: "claimed", storage: upsertStub(st) ? "ok" : "failed" });
    haptic([20]);
    router.push(`/s/${encodeStub(st)}`);
  }

  const setTitle = set === "neathack" ? "neatHack 2026 · judges" : `${event.title} · matching set`;
  const meta = [formatDate(event.dateISO), event.venue, event.city].filter(Boolean).join(" · ");

  return (
    <PageShell right={<span className="desk-label">{set === "neathack" ? "Judges' claim" : "Claim"}</span>}>
      <div className={s.layout}>
        <div className={s.desk}>
          <OnDesk>
            <StubView stub={preview} size="md" tilt />
          </OnDesk>
          {seatLabel ? <p className={s.seat}>{seatLabel}</p> : null}
        </div>

        <section className={s.panel} aria-labelledby="claim-h">
          <header className={s.head}>
            <p className="desk-label">{setTitle}</p>
            <h1 id="claim-h" className={s.title}>
              Claim your stub.
            </h1>
            <p className={s.lede}>{event.title}</p>
            {meta ? <p className={s.meta}>{meta}</p> : null}
          </header>

          <form
            className={s.form}
            onSubmit={(ev) => {
              ev.preventDefault();
              claim();
            }}
          >
            <Field
              id="claim-name"
              label="Name on your stub"
              value={name}
              maxLength={32}
              autoComplete="name"
              placeholder="Your name"
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              aria-invalid={!!error}
              hint={error || undefined}
            />

            <div className={s.signIn}>
              {acct === "loading" || savingOff ? null : account ? (
                <>
                  <p className="desk-label">Your wall</p>
                  <p className={s.signed} data-announce>
                    <span>
                      Signed in as {account.email}. This stub is saved to your wall.
                    </span>
                  </p>
                </>
              ) : (
                <>
                  <p className="desk-label">Save it to your wall</p>
                  <p className={s.signed}>
                    <span>We&apos;ll email you a link, so this stub follows you to any phone or laptop.</span>
                  </p>
                  <div className={s.signRow}>
                    <PaperButton type="button" onClick={() => openSignIn({ reason: "claim", returnTo: `${window.location.pathname}${window.location.search}` })}>
                      Email me a link
                    </PaperButton>
                  </div>
                </>
              )}
            </div>

            <Stamp type="submit" block disabled={claiming}>
              Claim my stub
              <LeavesMark />
            </Stamp>
            <MarkLegend marks={["simulated"]} />
          </form>

          <aside className={s.qr} aria-label="Claim on your phone">
            <QrPlaceholder value={here || set} size={25} />
            <p className={ui.muted}>
              Open this link on your phone to claim there.
              <SourceMark p="simulated" />
            </p>
          </aside>
        </section>
      </div>
    </PageShell>
  );
}
