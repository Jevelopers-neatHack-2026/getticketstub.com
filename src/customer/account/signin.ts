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
