"use client";
import { useState } from "react";
import { MarkLegend, PunchTabs, SourceMark, Stamp, Stamped } from "@/customer/desk/Desk";
import { haptic } from "@/customer/studio/feedback";
import { getStub } from "@/customer/studio/store";
import { currentVersion, type Stub } from "@/customer/studio/types";
import { PageShell, EmptyState, QrPlaceholder, StampLink, ui } from "@/customer/pages/ui";
import { absoluteUrl, formatDate, memoryPath } from "@/customer/pages/share";
import { useMounted } from "@/customer/pages/useMounted";
import { flow } from "@/customer/flows/events";
import s from "./wallet.module.css";

type Provider = "apple" | "google";

const PROVIDERS = [
  { value: "apple" as const, label: "Apple Wallet" },
  { value: "google" as const, label: "Google Wallet" },
];

export default function WalletClient({ id }: { id: string }) {
  const mounted = useMounted();
  const [stub, setStub] = useState<Stub | null | undefined>(undefined);
  const [provider, setProvider] = useState<Provider>("apple");
  const [issued, setIssued] = useState<Provider | null>(null);

  if (mounted && stub === undefined) setStub(getStub(id) ?? null);

  if (!mounted || stub === undefined) return <PageShell back={{ href: "/wall", label: "Wall" }}>{null}</PageShell>;
  if (stub === null) {
    return (
      <PageShell back={{ href: "/wall", label: "Wall" }}>
        <EmptyState kind="stub" title="This stub isn't on this device." body="A wallet pass is made from a stub you own here. Open your wall and pick the one to keep in your pocket.">
          <StampLink href="/wall">Open your wall</StampLink>
        </EmptyState>
      </PageShell>
    );
  }

  const e = stub.event;
  const art = currentVersion(stub)?.art;
  const memUrl = absoluteUrl(memoryPath(stub));
  const friends = stub.personal.friends.length;
  const place = [e.venue, e.city].filter(Boolean).join(", ");
  const providerLabel = PROVIDERS.find((p) => p.value === provider)?.label ?? "Wallet";

  return (
    <PageShell back={{ href: memoryPath(stub), label: "Back to your stub" }}>
      <div className={s.layout}>
        <section className={s.main} aria-labelledby="w-h">
          <header className={s.head}>
            <p className="desk-label">{e.title}</p>
            <h1 id="w-h" className={s.title}>
              Keep it in your pocket.
            </h1>
            <p className={ui.lede}>Your stub as a wallet pass. It updates when friends claim their seats.</p>
          </header>

          <div className={s.pass} aria-label={`Wallet pass for ${e.title}`} role="group">
            <div className={s.passTop}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/favicon.svg" alt="" width={22} height={22} />
              <span className={s.passBrand}>TicketStub</span>
              {e.dateISO ? <span className={s.passDate}>{formatDate(e.dateISO)}</span> : null}
            </div>
            <div className={s.strip} style={art?.kind === "image" && art.src ? { backgroundImage: `url(${art.src})` } : undefined} aria-hidden="true" />
            <div className={s.passBody}>
              <div>
                <p className={s.passLabel}>Event</p>
                <p className={s.passTitle}>{e.title}</p>
              </div>
              {place || e.seat ? (
                <div className={s.passRow}>
                  {place ? (
                    <div>
                      <p className={s.passLabel}>Venue</p>
                      <p className={s.passValue}>{place}</p>
                    </div>
                  ) : null}
                  {e.seat ? (
                    <div>
                      <p className={s.passLabel}>Seat</p>
                      <p className={s.passValue}>{e.seat}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className={s.perf} aria-hidden />
              <div className={s.passQr}>
                <QrPlaceholder value={memUrl} />
                <p className={s.passSmall}>Opens your memory page</p>
              </div>
              {friends > 0 ? (
                <p className={s.passSmall}>
                  {friends} {friends === 1 ? "friend" : "friends"} added
                </p>
              ) : null}
            </div>
          </div>

          <div className={s.buttons}>
            <PunchTabs
              label="Wallet"
              options={PROVIDERS}
              value={provider}
              onChange={(v) => {
                if (v !== provider) flow("wallet_option", { provider: v });
                setProvider(v);
              }}
            />
            <Stamp
              block
              onClick={() => {
                setIssued(provider);
                // a simulated pass: choosing a wallet is not a pass issued
                flow("wallet_select", { provider, capability: "simulated" });
                haptic([20]);
              }}
            >
              Add to {providerLabel}
            </Stamp>
          </div>
          <div data-announce>
            {issued ? (
              <div className={ui.card}>
                <div>
                  <Stamped key={issued}>Simulated</Stamped>
                </div>
                <p>
                  In the live app we&apos;d issue a signed {issued === "apple" ? "Apple Wallet" : "Google Wallet"} pass with this design. No pass was issued in this demo.
                  <SourceMark p="simulated" />
                </p>
              </div>
            ) : null}
          </div>
          <MarkLegend marks={["simulated"]} />
        </section>

        <aside className={s.phone} aria-labelledby="phone-h">
          <h2 id="phone-h" className={s.phoneTitle}>
            Send to your phone
          </h2>
          <QrPlaceholder value={absoluteUrl(`/wallet/${stub.id}`)} />
          <p className={ui.muted}>
            Scan with your phone camera to add the pass there.
            <SourceMark p="simulated" />
          </p>
        </aside>
      </div>
    </PageShell>
  );
}
