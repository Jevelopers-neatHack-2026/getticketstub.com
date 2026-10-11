"use client";
// The signed-in account, read once from /api/auth/me and shared by every screen that asks.
import { useCallback, useSyncExternalStore } from "react";
import { api, type Account } from "./api";
import { useSavingOff } from "./saving";
import { flow } from "@/customer/flows/events";

/** "loading" until the first answer, so screens never flash a signed-out prompt at a signed-in person. */
export type AccountState = { status: "loading" } | { status: "out" } | { status: "in"; account: Account };

let state: AccountState = { status: "loading" };
let inflight: Promise<void> | null = null;
let started = false;
const listeners = new Set<() => void>();

function set(next: AccountState) {
  state = next;
  listeners.forEach((l) => l());
}

/** Ask the server who is signed in. A network failure keeps what we already knew (or settles on signed out). */
export function refreshAccount(): Promise<void> {
  inflight ??= api
    .me()
    .then((account) => set(account ? { status: "in", account } : { status: "out" }))
    .catch(() => {
      if (state.status === "loading") set({ status: "out" });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function signOut(): Promise<void> {
  try {
    await api.signOut();
    flow("sign_out", { result: "done" });
  } catch {
    /* offline: the cookie stays, but this device forgets for now */
    flow("sign_out", { result: "offline" });
  }
  set({ status: "out" });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!started) {
    started = true;
    void refreshAccount();
  }
  return () => listeners.delete(cb);
}

const LOADING: AccountState = { status: "loading" };

export function useAccount() {
  const s = useSyncExternalStore(subscribe, () => state, () => LOADING);
  const refresh = useCallback(() => refreshAccount(), []);
  const savingOff = useSavingOff();
  return { status: s.status, savingOff, account: s.status === "in" ? s.account : null, refresh, signOut };
}

export const getAccountState = () => state;
