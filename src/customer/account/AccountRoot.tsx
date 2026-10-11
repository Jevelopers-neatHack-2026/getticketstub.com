"use client";
// Mounted once, in NavFrame, on every route. It owns the sign-in sheet, keeps the wall synced while
// someone is signed in, and answers the two ways the emailed link can come back (?signedIn=1, ?signin=expired).
import { useEffect, useState } from "react";
import { Stamped, TearLink } from "@/customer/desk/Desk";
import { haptic } from "@/customer/studio/feedback";
import { messageFor } from "@/customer/feedback-messages/messages";
import { SignInSheet } from "./SignInSheet";
import { openSignIn, useSignInRequest } from "./signin";
import { startSync, syncNow } from "./sync";
import { getAccountState, refreshAccount, useAccount } from "./useAccount";
import { flow } from "@/customer/flows/events";
import s from "./account.module.css";

/** The emailed link's return is reported once per page load, even when a remount (Strict Mode) runs the effect again. */
let returnReported = false;

type Slip = { id: number; kind: "saved"; text: string } | { id: number; kind: "expired" } | { id: number; kind: "offline" };

const stubs = (n: number) => `${n} ${n === 1 ? "stub" : "stubs"}`;

function landed(): "signedIn" | "expired" | null {
  const q = new URLSearchParams(window.location.search);
  if (q.get("signedIn") === "1") return "signedIn";
  if (q.get("signin") === "expired") return "expired";
  return null;
}

export function AccountRoot() {
  const request = useSignInRequest();
  const { status } = useAccount();
  const [slip, setSlip] = useState<Slip | null>(null);
  const [leavingId, setLeavingId] = useState<number | null>(null);
  const leaving = !!slip && leavingId === slip.id;

  // Read the address before any screen tidies it (the wall drops its own params when a stub lands).
  const [came] = useState(() => (typeof window === "undefined" ? null : landed()));

  useEffect(() => {
    if (!came) return;
    const q = new URLSearchParams(window.location.search);
    q.delete("signedIn");
    q.delete("signin");
    const rest = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    if (came === "expired") {
      if (!returnReported) flow("sign_in_return", { result: "expired" });
      returnReported = true;
      // after hydration, so the server's markup and the first client render agree
      void Promise.resolve().then(() => setSlip({ id: Date.now(), kind: "expired" }));
      return;
    }
    let live = true;
    void (async () => {
      await refreshAccount();
      // signed in only when the server's /api/auth/me says so, not because the address carries ?signedIn=1
      if (!returnReported) flow("sign_in_return", { result: getAccountState().status === "in" ? "signed_in" : "not_signed_in" });
      returnReported = true;
      const r = await syncNow();
      if (!live) return;
      haptic([14]);
      setSlip(r.ok ? { id: Date.now(), kind: "saved", text: r.count > 0 ? `Saved. ${stubs(r.count)} on your wall.` : "Saved. Your wall is ready." } : { id: Date.now(), kind: "offline" });
    })();
    return () => {
      live = false;
    };
  }, [came]);

  // Signed in: merge now, then on every change and on focus.
  useEffect(() => {
    if (status !== "in") return;
    void syncNow();
    return startSync();
  }, [status]);

  // A slip stays a few seconds, then lifts away. The expired one waits to be answered.
  useEffect(() => {
    if (!slip || slip.kind === "expired") return;
    const a = setTimeout(() => setLeavingId(slip.id), 4600);
    const b = setTimeout(() => setSlip(null), 4920);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [slip]);

  return (
    <>
      <SignInSheet request={request} />
      {slip ? (
        <div className={s.toast} data-leaving={leaving} key={slip.id}>
          {slip.kind === "saved" ? (
            <>
              <Stamped>Saved</Stamped>
              <p className={s.toastText} data-announce>{slip.text.replace(/^Saved\.\s*/, "")}</p>
            </>
          ) : slip.kind === "offline" ? (
            <p className={s.toastText} data-announce>You&apos;re signed in. We&apos;ll save your wall as soon as we can reach the server.</p>
          ) : (
            <>
              <p className={s.toastText} data-announce>{messageFor("signin_expired").message} We can send a fresh one.</p>
              <TearLink
                type="button"
                onClick={() => {
                  setSlip(null);
                  openSignIn({ reason: "save" });
                }}
              >
                {messageFor("signin_expired").action?.label}
              </TearLink>
              <TearLink type="button" onClick={() => setSlip(null)}>
                Dismiss
              </TearLink>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
