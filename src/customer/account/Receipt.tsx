"use client";
// The receipt's email, as part of the magic-link flow: signed in it is just stated; signed out it is the
// field, and after paying the same address is offered back as "Save to your wall".
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Field, PaperButton, Stamped, TearLink } from "@/customer/desk/Desk";
import { FeedbackNote, ProgressNote, type ProgressState } from "@/customer/feedback-messages/progress";
import { EMAIL_RE } from "./api";
import { type Placed } from "./orders";
import { openSignIn, payReturnTo, usePayResumed } from "./signin";
import { useAccount } from "./useAccount";
import s from "./account.module.css";

/** The address the receipt goes to: the account's when signed in, else what was typed (may be empty). */
export function useReceiptEmail() {
  const { status, account, savingOff } = useAccount();
  const [typed, setTyped] = useState("");
  const email = account ? account.email : typed.trim();
  const problem = !account && email !== "" && !EMAIL_RE.test(email) ? "That email doesn't look right. Check it, or leave it empty." : "";
  return { status, savingOff, signedIn: !!account, email, typed, setTyped, problem };
}

/**
 * Pay was pressed signed out: open the sign-in sheet right there, with "Continue as guest" to go on as before.
 * Returns whether the sheet took over; false (signed in, still loading, or saving off) means pay now.
 */
export function askToSignIn(r: ReturnType<typeof useReceiptEmail>, onGuest: () => void): boolean {
  if (r.status !== "out" || r.savingOff) return false;
  openSignIn({
    reason: "checkout",
    returnTo: payReturnTo(),
    email: r.email || undefined,
    title: "Sign in before you pay",
    lede: "Sign in to keep your order and receipt with your wall. We'll send a link; it takes a few seconds.",
    onGuest,
  });
  return true;
}

/** After the link brings them back: who they are now, and that paying is still theirs to do. */
export function PayResumeNote({ r }: { r: ReturnType<typeof useReceiptEmail> }) {
  const resumed = usePayResumed();
  if (!resumed || !r.signedIn) return null;
  return (
    <p className={s.resume} data-announce>
      Signed in as <strong className={s.addr}>{r.email}</strong>. Tap Pay to finish.
    </p>
  );
}

export function ReceiptField({ id, r, onChange, error }: { id: string; r: ReturnType<typeof useReceiptEmail>; onChange?: () => void; /** A problem with this address, shown on the field itself and tied to it for screen readers. */ error?: string }) {
  if (r.status === "loading") return null;
  if (r.savingOff) return null; // no receipt email on a preview that saves nothing
  if (r.signedIn) {
    return (
      <p className={s.lede}>
        Receipt goes to <strong className={s.addr}>{r.email}</strong>.
      </p>
    );
  }
  return (
    <Field
      id={id}
      type="email"
      label="Email for your receipt"
      hint="We'll send the receipt here. Use it again to save your wall. You can leave it empty in the sandbox."
      value={r.typed}
      error={error || undefined}
      autoComplete="email"
      inputMode="email"
      onChange={(ev) => {
        r.setTyped(ev.target.value);
        onChange?.();
      }}
    />
  );
}

/**
 * What replaces the Pay stamp once the order is in. The stamp says "Ordered" only after the server's answer
 * (or, with saving off, the local record): until then it is the real progress state. If the server refused,
 * the order is said to be on this device only, with a way to send it again. Signed in, or with nobody to
 * email, a clean order walks on to the wall.
 */
export function AfterPay({ placed, email, signedIn, progress, onRetry }: { placed: Placed | null; email: string; signedIn: boolean; progress?: ProgressState; onRetry?: () => void }) {
  const router = useRouter();
  const offer = !signedIn && !!email && placed?.receipt === true;
  const problem = placed?.code;
  useEffect(() => {
    if (!placed || offer || problem) return;
    const t = setTimeout(() => router.push(email ? "/wall?email=sent" : "/wall"), 900);
    return () => clearTimeout(t);
  }, [placed, offer, problem, email, router]);
  return (
    <div className={s.after}>
      {placed && !problem ? <Stamped say>Ordered</Stamped> : null}
      {!placed ? (
        <ProgressNote state={progress ?? { phase: "sending" }} labels={{ sending: "Placing your order" }} onRetry={onRetry} />
      ) : problem ? (
        <>
          <p className={s.small}>Your order is saved on this device only. The server didn&apos;t take it.</p>
          <FeedbackNote code={problem} onRetry={onRetry} />
          <TearLink type="button" onClick={() => router.push("/wall")}>
            Open your wall
          </TearLink>
        </>
      ) : offer ? (
        <>
          <p className={s.lede}>
            Your receipt is on its way to <strong className={s.addr}>{email}</strong>. Save to your wall with the same address, so your stubs follow you to any phone or laptop.
          </p>
          <PaperButton type="button" block onClick={() => openSignIn({ reason: "checkout", returnTo: "/wall", email })}>
            Save to your wall
          </PaperButton>
          <TearLink type="button" onClick={() => router.push("/wall")}>
            Open your wall
          </TearLink>
        </>
      ) : (
        <p className={s.small}>Taking you to your wall.</p>
      )}
    </div>
  );
}
