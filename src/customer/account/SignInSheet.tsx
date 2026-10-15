"use client";
// The one way in: an email, a link. The sheet is a PaperSheet with a Field and a Stamp; once the link is
// sent it shows the address, and (only when the server says it is sandboxed) a clearly labelled link to open.
import Link from "next/link";
import { useState } from "react";
import { Field, MarkLegend, PaperSheet, Rule, SourceMark, Stamp, TearLink } from "@/customer/desk/Desk";
import d from "@/customer/desk/Desk.module.css";
import { LeavesMark } from "@/customer/pages/ui";
import { ProgressNote, useProgress } from "@/customer/feedback-messages/progress";
import { play } from "@/customer/studio/feedback";
import { EMAIL_RE, api, type LinkReason } from "./api";
import { SAVING_OFF_LINE, useSavingOff } from "./saving";
import { closeSignIn, updateSignIn, type SignInRequest } from "./signin";
import { errorCode, flow } from "@/customer/flows/events";
import s from "./account.module.css";

const COPY: Record<LinkReason, { title: string; lede: string }> = {
  save: { title: "Save to your wall", lede: "We'll email you a link, so your stubs follow you to any phone or laptop." },
  checkout: { title: "Save to your wall", lede: "We'll email you a link, so your order and your stubs follow you to any phone or laptop." },
  claim: { title: "Save this stub", lede: "We'll email you a link, so the stub you claim follows you to any phone or laptop." },
};

export function SignInSheet({ request }: { request: SignInRequest | null }) {
  const off = useSavingOff();
  return (
    <PaperSheet open={!!request} onClose={closeSignIn} title={request ? (off ? "Saving is off" : request.sent ? "Check your email" : (request.title ?? COPY[request.reason].title)) : ""}>
      {request ? <Body key={`${request.reason}-${request.returnTo ?? ""}`} request={request} /> : null}
    </PaperSheet>
  );
}

function Body({ request }: { request: SignInRequest }) {
  const off = useSavingOff();
  if (off) {
    // No writable storage on this preview: say so calmly, offer nothing to fill in.
    return (
      <div className={s.body}>
        <p className={s.lede} data-announce>
          {SAVING_OFF_LINE}
        </p>
        <TearLink type="button" onClick={closeSignIn}>
          Close
        </TearLink>
      </div>
    );
  }
  return <Form request={request} />;
}

function Form({ request }: { request: SignInRequest }) {
  const copy = { ...COPY[request.reason], ...(request.lede ? { lede: request.lede } : {}) };
  const [email, setEmail] = useState(request.email ?? "");
  const [error, setError] = useState("");
  const progress = useProgress();
  const sent = request.sent;
  const guest = request.onGuest ? (
    <TearLink
      type="button"
      onClick={() => {
        flow("signin_choice", { choice: "guest", reason: request.reason });
        play("tap", { emphasis: "subtle" });
        closeSignIn();
        request.onGuest?.();
      }}
    >
      Continue as guest
    </TearLink>
  ) : null;

  async function send() {
    const to = email.trim();
    if (!EMAIL_RE.test(to)) {
      flow("sign_in_link", { reason: request.reason, result: "invalid" });
      setError("That email doesn't look right. Check it and try again.");
      document.getElementById("signin-email")?.focus();
      return;
    }
    setError("");
    // a link sent is not a sign-in: the session only exists once the emailed link is opened
    const res = await progress.run(() =>
      api.link(to, request.reason, request.returnTo).then(
        (r) => (flow("sign_in_link", { reason: request.reason, result: r.sandbox || r.devLink ? "sandbox" : "sent" }), r),
        (e: unknown) => {
          flow("sign_in_link", { reason: request.reason, result: "error", error_code: errorCode(e) });
          throw e;
        },
      ),
    );
    if (res) {
      play("success", { emphasis: "subtle" });
      updateSignIn({ sent: { email: to, devLink: res.devLink } });
      progress.reset();
    }
  }

  if (sent) {
    return (
      <div className={s.body}>
        <p className={s.lede} data-announce>
          We sent a link to <strong className={s.addr}>{sent.email}</strong>. {request.onGuest ? "Open it on this device to come back here and finish paying." : "Open it on this device to save your wall."} It works once and lasts 15 minutes.
        </p>
        {sent.devLink ? (
          <div className={s.sandbox}>
            <p className={s.sandboxNote}>
              <span className="desk-label">Sandbox mail</span>
              <SourceMark p="sandbox" />
            </p>
            <p className={s.small}>No mail service is connected here, so nothing was emailed. Use this button instead of the inbox.</p>
            {/* a full navigation: the link signs you in on the server, then sends you on */}
            <a href={sent.devLink} className={`${d.paper} ${s.open}`} onClick={() => play("tap", { emphasis: "subtle" })}>
              Open the link
              <LeavesMark />
            </a>
            <MarkLegend marks={["sandbox"]} />
          </div>
        ) : null}
        <Rule kind="perf" />
        <div className={s.row}>
          <TearLink
            type="button"
            onClick={() => {
              updateSignIn({ sent: undefined, email: sent.email });
              setError("");
              progress.reset();
            }}
          >
            Use a different email
          </TearLink>
          <TearLink type="button" onClick={closeSignIn}>
            Close
          </TearLink>
        </div>
        {guest}
      </div>
    );
  }

  return (
    <form
      className={s.body}
      onSubmit={(ev) => {
        ev.preventDefault();
        void send();
      }}
      noValidate
    >
      <p className={s.lede}>{copy.lede}</p>
      <Field
        id="signin-email"
        type="email"
        label="Your email"
        hint="No password. The link works once."
        error={error || undefined}
        required
        value={email}
        autoComplete="email"
        inputMode="email"
        autoFocus
        onChange={(ev) => {
          setEmail(ev.target.value);
          setError("");
          if (progress.state.phase === "failed") progress.reset();
        }}
      />
      <ProgressNote state={progress.state} labels={{ sending: "Sending your link" }} onRetry={() => void send()} />
      <Stamp type="submit" block disabled={progress.busy}>
        {progress.busy ? "Sending" : "Email me a link"}
      </Stamp>
      {guest ?? (
        <TearLink
          type="button"
          onClick={() => {
            flow("signin_choice", { choice: "skip", reason: request.reason });
            closeSignIn();
          }}
        >
          Not now
        </TearLink>
      )}
      <p className={s.small}>
        We keep your email to sign you in. Read the{" "}
        <Link href="/privacy" className={s.plain} onClick={closeSignIn}>
          privacy note
        </Link>{" "}
        and the{" "}
        <Link href="/terms" className={s.plain} onClick={closeSignIn}>
          terms
        </Link>
        .
      </p>
    </form>
  );
}
