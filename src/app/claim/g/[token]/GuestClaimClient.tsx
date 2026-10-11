"use client";
// A guest's own claim link from an organizer: their stub, already named. A magic link signs them in,
// then one tap puts the stub on their wall.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MarkLegend, PaperButton, Stamp, Stamped, TearLink } from "@/customer/desk/Desk";
import { ApiError, api, type ClaimInfo } from "@/customer/account/api";
import { messageFor } from "@/customer/feedback-messages/messages";
import { ProgressNote, useProgress } from "@/customer/feedback-messages/progress";
import { openSignIn } from "@/customer/account/signin";
import { useAccount } from "@/customer/account/useAccount";
import { StubView } from "@/customer/studio/stub/StubView";
import { haptic } from "@/customer/studio/feedback";
import { upsertStub } from "@/customer/studio/store";
import { LeavesMark, PageShell, FriendlyError, OnDesk, ui } from "@/customer/pages/ui";
import { formatDate } from "@/customer/pages/share";
import { useMounted } from "@/customer/pages/useMounted";
import { errorCode, flow } from "@/customer/flows/events";
import s from "../../[set]/claim.module.css";

type Load = { state: "loading" } | { state: "ready"; info: ClaimInfo } | { state: "missing" } | { state: "offline"; code: string };

export default function GuestClaimClient({ token }: { token: string }) {
  const router = useRouter();
  const mounted = useMounted();
  const { status, account, savingOff } = useAccount();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const progress = useProgress();
  const [done, setDone] = useState(false);

  // What the link turned out to be, once it is known (never the guest's name or seat).
  const viewed = useRef(false);
  useEffect(() => {
    if (load.state === "loading" || viewed.current) return;
    viewed.current = true;
    if (load.state === "missing") flow("claim_view", { flow: "guest", result: "invalid", error_code: "not_found" });
    else if (load.state === "offline") flow("claim_view", { flow: "guest", result: "error", error_code: errorCode(load.code) });
    else flow("claim_view", { flow: "guest", result: load.info.expired ? "expired" : load.info.claimed ? "claimed" : "valid" });
  }, [load]);

  useEffect(() => {
    let live = true;
    api
      .claimInfo(token)
      .then((info) => live && setLoad({ state: "ready", info }))
      .catch((e: ApiError) => live && setLoad(e.status === 404 ? { state: "missing" } : { state: "offline", code: e.code }));
    return () => {
      live = false;
    };
  }, [token]);

  if (!mounted || load.state === "loading") return <PageShell>{null}</PageShell>;
  if (load.state === "missing") {
    return (
      <PageShell>
        <FriendlyError title="We couldn't find this claim link." body="The link may be cut short. Ask the organizer to send it again." />
      </PageShell>
    );
  }
  if (load.state === "offline") {
    return (
      <PageShell>
        <FriendlyError title="We can't open this claim link right now." body={messageFor(load.code).message} />
        <PaperButton type="button" onClick={() => window.location.reload()}>
          Try again
        </PaperButton>
      </PageShell>
    );
  }

  const { info } = load;
  // the seat lives on the guest's row; show it on the stub if the server's copy doesn't carry it
  const stub = info.seat && !info.stub.event.seat ? { ...info.stub, event: { ...info.stub.event, seat: info.seat } } : info.stub;
  const e = stub.event;
  const meta = [formatDate(e.dateISO), e.venue, e.city].filter(Boolean).join(" · ");
  const first = info.guestName.split(/\s+/)[0] || info.guestName;

  async function claim() {
    const res = await progress.run(() =>
      api.claim(token).catch((e: unknown) => {
        flow("claim_complete", { flow: "guest", result: "error", error_code: errorCode(e) });
        throw e;
      }),
    );
    if (!res) return;
    // claimed on the server (the account has it); storage says whether this device kept its copy
    flow("claim_complete", { flow: "guest", result: "claimed", storage: upsertStub({ ...res.stub, torn: true }) ? "ok" : "failed" });
    haptic([20]);
    setDone(true);
    setTimeout(() => router.push(`/wall?pinned=${encodeURIComponent(res.stub.id)}`), 900);
  }

  const expired = info.expired;

  return (
    <PageShell right={<span className="desk-label">Guest claim</span>}>
      <div className={s.layout}>
        <div className={s.desk}>
          <OnDesk>
            <StubView stub={stub} size="md" tilt />
          </OnDesk>
          {info.seat ? <p className={s.seat}>Seat {info.seat}</p> : null}
        </div>

        <section className={s.panel} aria-labelledby="guest-h">
          <header className={s.head}>
            <p className="desk-label">Your stub from the organizer</p>
            <h1 id="guest-h" className={s.title}>
              {expired ? "This link has expired." : `Claim your stub, ${first}.`}
            </h1>
            <p className={s.lede}>{e.title}</p>
            {meta ? <p className={s.meta}>{meta}</p> : null}
          </header>

          {expired ? (
            <p className={ui.muted}>Ask the organizer to send you a new claim link.</p>
          ) : done ? (
            <div className={s.signed} data-announce>
              <Stamped>Claimed</Stamped>
              <span>It&apos;s on your wall.</span>
            </div>
          ) : status === "loading" ? null : savingOff ? (
            <p className={ui.muted}>Saving is off on this preview. Your stubs stay on this device.</p>
          ) : account ? (
            <div className={s.form}>
              <p className={ui.muted}>
                Signed in as <strong>{account.email}</strong>. Claiming puts this stub on your wall, on every device you sign in on.
              </p>
              <Stamp type="button" block disabled={progress.busy} onClick={() => void claim()}>
                {progress.busy ? "Claiming" : "Claim my stub"}
                <LeavesMark />
              </Stamp>
              <ProgressNote state={progress.state} labels={{ sending: "Putting it on your wall" }} onRetry={() => void claim()} onSignIn={() => openSignIn({ reason: "claim", returnTo: `/claim/g/${encodeURIComponent(token)}` })} />
              {info.claimed ? <p className={ui.muted}>Already claimed? Claiming again with the same email is fine.</p> : null}
            </div>
          ) : (
            <div className={s.form}>
              <p className={ui.muted}>
                {info.claimed ? "This stub is claimed. If it's yours, sign in with the same email." : "We'll email you a link, so this stub follows you to any phone or laptop. No password."}
              </p>
              <Stamp type="button" block onClick={() => openSignIn({ reason: "claim", returnTo: `/claim/g/${encodeURIComponent(token)}` })}>
                Email me a link
              </Stamp>
              <TearLink
                type="button"
                onClick={() => {
                  flow("cta_select", { cta: "make_own", context: "claim" });
                  router.push("/make");
                }}
              >
                Make a stub of my own
                <LeavesMark />
              </TearLink>
            </div>
          )}
          <MarkLegend marks={["sandbox"]} />
        </section>
      </div>
    </PageShell>
  );
}
