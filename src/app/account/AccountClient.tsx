"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Field, MarkLegend, PaperButton, PaperSheet, Rule, SourceMark, Stamp, Stamped, TearLink } from "@/customer/desk/Desk";
import { EMAIL_RE, api } from "@/customer/account/api";
import { codeOf } from "@/customer/feedback-messages/messages";
import { FeedbackNote, ProgressNote, useProgress } from "@/customer/feedback-messages/progress";
import { openSignIn } from "@/customer/account/signin";
import { refreshAccount, useAccount } from "@/customer/account/useAccount";
import { MATERIALS, formatMoney } from "@/customer/studio/types";
import type { Order } from "@/customer/pages/commerce";
import { PageShell } from "@/customer/pages/ui";
import { useMounted } from "@/customer/pages/useMounted";
import { errorCode, flow } from "@/customer/flows/events";
import s from "./account.module.css";

const dateOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const materialLabel = (id: string) => MATERIALS.find((m) => m.id === id)?.label ?? id;

export default function AccountClient() {
  const router = useRouter();
  const mounted = useMounted();
  const { status, account, signOut, savingOff } = useAccount();
  const [orders, setOrders] = useState<Order[] | null | "error">(null);
  const [ordersCode, setOrdersCode] = useState("unknown");
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState<"email" | "delete" | null>(null);
  // /account?email=changed|taken is where the emailed confirmation link lands
  const [note] = useState(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("email")));

  useEffect(() => {
    if (status !== "in") return;
    let live = true;
    api
      .orders()
      .then((o) => live && setOrders(o))
      .catch((e) => {
        if (!live) return;
        setOrdersCode(codeOf(e));
        setOrders("error");
      });
    return () => {
      live = false;
    };
  }, [status, attempt]);

  useEffect(() => {
    if (note === "changed") void refreshAccount();
  }, [note]);

  if (!mounted || status === "loading") return <PageShell title="Your account">{null}</PageShell>;

  if (!account && savingOff) {
    return (
      <PageShell title="Your account">
        <div className={s.wrap}>
          <h1 className={s.title}>Saving is off.</h1>
          <p className={s.lede}>Saving is off on this preview. Your stubs stay on this device.</p>
        </div>
      </PageShell>
    );
  }

  if (!account) {
    return (
      <PageShell title="Your account">
        <div className={s.wrap}>
          <h1 className={s.title}>Save your wall.</h1>
          <p className={s.lede}>We&apos;ll email you a link, so your stubs and orders follow you to any phone or laptop. No password.</p>
          <Stamp type="button" onClick={() => openSignIn({ reason: "save", returnTo: "/account" })}>
            Email me a link
          </Stamp>
          <p className={s.muted}>
            <Link className={s.plain} href="/privacy">
              Privacy
            </Link>{" "}
            ·{" "}
            <Link className={s.plain} href="/terms">
              Terms
            </Link>
          </p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="Your account">
      <div className={s.wrap}>
        <header className={s.head}>
          <p className="desk-label">Signed in</p>
          <h1 className={s.title}>Your account</h1>
        </header>
        {note === "changed" ? (
          <p className={s.notice} data-announce>
            <Stamped>Changed</Stamped> Your email is updated.
          </p>
        ) : note === "taken" ? (
          <p className={s.notice} data-announce>
            That email already has an account, so we kept your current one. Use another address, or sign in with that one.
          </p>
        ) : null}

        <section className={s.block} aria-labelledby="acct-email">
          <h2 id="acct-email" className="desk-label">
            Email
          </h2>
          <p className={s.email}>{account.email}</p>
          <div>
            <PaperButton type="button" onClick={() => setSheet("email")}>
              Change email
            </PaperButton>
          </div>
        </section>

        <Rule kind="perf" />

        <section className={s.block} aria-labelledby="acct-orders">
          <h2 id="acct-orders" className="desk-label">
            Your orders
          </h2>
          {orders === null ? (
            <p className={s.muted}>Loading your orders.</p>
          ) : orders === "error" ? (
            <FeedbackNote
              code={ordersCode}
              onRetry={() => {
                setOrders(null);
                setAttempt((n) => n + 1);
              }}
            />
          ) : orders.length === 0 ? (
            <p className={s.muted}>No orders yet. When you print a stub, the receipt lands here.</p>
          ) : (
            <ul className={s.orders}>
              {orders.map((o) => (
                <li key={o.id} className={s.order}>
                  <p className={s.orderHead}>
                    <span className={s.num}>{dateOf(o.createdAt)}</span>
                    <span className={s.num}>
                      {formatMoney(o.totalMinor)}
                      <SourceMark p="sandbox" />
                    </span>
                  </p>
                  <ul className={s.lines}>
                    {o.lines.map((l, i) => (
                      <li key={i}>
                        {l.title}{" "}
                        <span className={s.muted}>
                          · {materialLabel(l.material)}, {l.finish}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {Array.isArray(orders) && orders.length > 0 ? <MarkLegend marks={["sandbox"]} /> : null}
        </section>

        <Rule kind="perf" />

        <p className={s.muted}>
          <Link className={s.plain} href="/privacy">
            Privacy
          </Link>{" "}
          ·{" "}
          <Link className={s.plain} href="/terms">
            Terms
          </Link>
        </p>

        <div className={s.foot}>
          <TearLink
            type="button"
            onClick={async () => {
              await signOut();
              router.push("/wall");
            }}
          >
            Sign out
          </TearLink>
          <button type="button" className={s.danger} onClick={() => setSheet("delete")}>
            Delete my account
          </button>
        </div>
      </div>

      <PaperSheet open={sheet === "email"} onClose={() => setSheet(null)} title="Change email">
        {sheet === "email" ? <ChangeEmail /> : null}
      </PaperSheet>
      <PaperSheet open={sheet === "delete"} onClose={() => setSheet(null)} title="Delete your account">
        {sheet === "delete" ? <DeleteAccount email={account.email} onDone={() => router.push("/wall")} /> : null}
      </PaperSheet>
    </PageShell>
  );
}

function ChangeEmail() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const progress = useProgress();
  const [sent, setSent] = useState<{ email: string; devLink?: string } | null>(null);
  async function send() {
    const to = email.trim();
    if (!EMAIL_RE.test(to)) {
      flow("account_action", { action: "change_email", result: "invalid" });
      return setError("That email doesn't look right. Check it and try again.");
    }
    setError("");
    // a link sent, not an email changed: that happens when the link is opened
    const r = await progress.run(() =>
      api.changeEmail(to).then(
        (res) => (flow("account_action", { action: "change_email", result: res.sandbox || res.devLink ? "sandbox" : "sent" }), res),
        (e: unknown) => {
          flow("account_action", { action: "change_email", result: "error", error_code: errorCode(e) });
          throw e;
        },
      ),
    );
    if (r) {
      setSent({ email: to, devLink: r.devLink });
      progress.reset();
    }
  }
  if (sent) {
    return (
      <div className={s.sheetBody}>
        <p className={s.lede} data-announce>
          Check your email. We sent a link to <strong>{sent.email}</strong>. Your email changes when you open it.
        </p>
        {sent.devLink ? (
          <p className={s.muted}>
            Sandbox mail
            <SourceMark p="sandbox" />: nothing was emailed.{" "}
            <a className={s.plain} href={sent.devLink}>
              Open the link
            </a>
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className={s.sheetBody}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p className={s.lede}>We&apos;ll email a link to the new address. Your email changes when you open it.</p>
      <Field
        id="acct-new"
        type="email"
        label="New email"
        autoComplete="email"
        autoFocus
        value={email}
        hint={error || undefined}
        aria-invalid={!!error}
        onChange={(e) => {
          setEmail(e.target.value);
          setError("");
          if (progress.state.phase === "failed") progress.reset();
        }}
      />
      <ProgressNote state={progress.state} labels={{ sending: "Sending your link" }} onRetry={() => void send()} />
      <Stamp type="submit" block disabled={progress.busy}>
        {progress.busy ? "Sending" : "Email me a link"}
      </Stamp>
    </form>
  );
}

function DeleteAccount({ email, onDone }: { email: string; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const progress = useProgress();
  const match = typed.trim().toLowerCase() === email.toLowerCase();
  async function go() {
    const done = await progress.run(async () => {
      try {
        await api.deleteAccount(typed.trim());
      } catch (e) {
        flow("account_action", { action: "delete", result: "error", error_code: errorCode(e) });
        throw e;
      }
      flow("account_action", { action: "delete", result: "done" });
      await refreshAccount();
      return true;
    });
    if (done) onDone();
  }
  return (
    <form
      className={s.sheetBody}
      onSubmit={(e) => {
        e.preventDefault();
        if (match) void go();
      }}
    >
      <p className={s.lede}>This removes your wall, share links and organizer events from our server, and anonymises your receipts. The stubs on this device stay here.</p>
      <Field id="acct-confirm" type="email" label="Type your email to confirm" autoComplete="off" value={typed} hint={email} onChange={(e) => setTyped(e.target.value)} />
      <ProgressNote state={progress.state} labels={{ sending: "Deleting your account" }} onRetry={() => void go()} />
      <Stamp type="submit" block disabled={!match || progress.busy}>
        {progress.busy ? "Deleting" : "Delete my account"}
      </Stamp>
    </form>
  );
}
