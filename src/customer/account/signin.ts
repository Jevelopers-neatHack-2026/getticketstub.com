"use client";
// Who asked for the sign-in sheet and why. Screens call openSignIn(); AccountRoot renders the one sheet.
import { useSyncExternalStore } from "react";
import type { LinkReason } from "./api";
import { flow } from "@/customer/flows/events";

export interface SignInRequest {
  reason: LinkReason;
  /** Where the emailed link lands. Defaults to the wall. Must be a relative path. */
  returnTo?: string;
  email?: string;
  /** Replace the sheet's title and lede when the default copy for `reason` doesn't fit the place. */
  title?: string;
  lede?: string;
  /** Set when the sheet stands in front of a step that can go on without an account: shows "Continue as guest", which closes the sheet and runs this. */
  onGuest?: () => void;
  /** Set once the link is sent: the sheet then shows where it went. */
  sent?: { email: string; devLink?: string };
}

let current: SignInRequest | null = null;
const listeners = new Set<() => void>();

export function openSignIn(req: SignInRequest) {
  // a choice to start signing in, never a sign-in: that is only known when the emailed link comes back
  if (!current) flow("signin_choice", { choice: "sign_in", reason: req.reason });
  current = req;
  listeners.forEach((l) => l());
}
/** Change the open request in place (the sheet stays open). */
export function updateSignIn(patch: Partial<SignInRequest>) {
  if (!current) return;
  current = { ...current, ...patch };
  listeners.forEach((l) => l());
}
export function closeSignIn() {
  current = null;
  listeners.forEach((l) => l());
}

// Paying after signing in: the link lands back on the pay step (?resume=pay), or another tab of this browser notices the session.
const RESUME_PARAM = "resume";
let resumed = false;
const resumeListeners = new Set<() => void>();

/** The page the person was paying on, marked so it can say "tap Pay to finish" when the link brings them back. Relative, same origin. */
export function payReturnTo(): string {
  const u = new URL(window.location.href);
  u.searchParams.set(RESUME_PARAM, "pay");
  return `${u.pathname}${u.search}`;
}
/** This tab learned (not from the address) that the person signed in while paying. */
export function markPayResumed() {
  if (resumed) return;
  resumed = true;
  resumeListeners.forEach((l) => l());
}
export function usePayResumed(): boolean {
  return useSyncExternalStore(
    (cb) => {
      resumeListeners.add(cb);
      return () => resumeListeners.delete(cb);
    },
    () => resumed || new URLSearchParams(window.location.search).get(RESUME_PARAM) === "pay",
    () => false,
  );
}

export function useSignInRequest(): SignInRequest | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
}

const DISMISS_KEY = "ticketstub.savePrompt.dismissed";
/** "Not now" on the first-pin prompt lasts for the session. */
export function savePromptDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
export function dismissSavePrompt(): void {
  flow("signin_choice", { choice: "skip", reason: "save" });
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* storage unavailable: it asks again next time */
  }
}
