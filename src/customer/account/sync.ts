"use client";
// Keeps the local wall and the account's wall the same. localStorage stays the cache and the
// signed-out mode; signed in, every change goes up (debounced) and the merged wall comes back down.
// A failed request changes nothing locally, so no stub is ever lost: the next trigger tries again.
import { WALL_CHANGED, loadDeleted, loadWall, saveDeleted, writeWall } from "@/customer/studio/store";
import type { Stub } from "@/customer/studio/types";
import { api } from "./api";
import { isSavingOff } from "./saving";
import { errorCode, flow } from "@/customer/flows/events";

export const WALL_SYNCED = "ticketstub:wall-synced";
const DEBOUNCE_MS = 1500;

const at = (s: Stub) => s.updatedAt ?? 0;

/** Fold the server's merged wall into whatever is on the device now (which may have moved on during the request). */
export function foldWall(current: Stub[], remote: Stub[], deleted: string[], sentAt: number): Stub[] {
  const byId = new Map(current.map((s) => [s.id, s]));
  const gone = new Set(deleted);
  const out: Stub[] = [];
  const seen = new Set<string>();
  for (const s of remote) {
    seen.add(s.id);
    const mine = byId.get(s.id);
    if (!mine) out.push(s);
    // photos stay on the device: the server keeps none, so its copy never wipes ours
    else out.push(at(mine) > at(s) ? mine : { ...s, photos: mine.photos.length ? mine.photos : s.photos });
  }
  for (const s of current) {
    if (seen.has(s.id)) continue;
    // Made on this device while the request was in flight (or just re-made after a delete): keep it.
    if (!gone.has(s.id) || at(s) >= sentAt) out.push(s);
  }
  // This device's order wins; stubs that came down from the account go in front, newest first.
  const order = new Map(current.map((s, i) => [s.id, i]));
  const known = out.filter((s) => order.has(s.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const fresh = out.filter((s) => !order.has(s.id)).sort((a, b) => at(b) - at(a));
  return [...fresh, ...known];
}

export interface SyncResult {
  ok: boolean;
  count: number;
}

/** Ids the server has acknowledged this visit: a stub is "on the server" once a sync that carried it has come back. */
const onServer = new Set<string>();
export const isOnServer = (id: string): boolean => onServer.has(id);

let running: Promise<SyncResult> | null = null;
let again = false;
/** Syncs run on every change and focus: a success is reported when it follows a failure (or is the first), every failure is. */
let lastSynced: boolean | null = null;

/** One merge round trip. Calls overlapping a running one are folded into a single follow-up. */
export function syncNow(): Promise<SyncResult> {
  if (isSavingOff()) return Promise.resolve({ ok: true, count: loadWall().length }); // nothing to sync to
  if (running) {
    again = true;
    return running;
  }
  running = (async (): Promise<SyncResult> => {
    const sentAt = Date.now();
    const local = loadWall();
    const deleted = loadDeleted();
    try {
      const reply = await api.sync(local, deleted);
      for (const s of local) onServer.add(s.id);
      for (const s of reply.stubs) onServer.add(s.id);
      for (const id of reply.deleted) onServer.delete(id);
      const merged = foldWall(loadWall(), reply.stubs, reply.deleted, sentAt);
      writeWall(merged);
      // the tombstones we just sent are on the server now; ones made since stay queued
      const sent = new Set(deleted);
      saveDeleted(loadDeleted().filter((id) => !sent.has(id)));
      window.dispatchEvent(new CustomEvent(WALL_SYNCED, { detail: { count: merged.length } }));
      if (lastSynced !== true) flow("server_save", { kind: "sync", result: "saved" });
      lastSynced = true;
      return { ok: true, count: merged.length };
    } catch (e) {
      flow("server_save", { kind: "sync", result: "failed", error_code: errorCode(e) });
      lastSynced = false;
      return { ok: false, count: local.length };
    }
  })().finally(() => {
    running = null;
    if (again) {
      again = false;
      schedule(0);
    }
  });
  return running;
}

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncNow();
  }, ms);
}

/** Start listening for changes and focus. Returns the stop function. Call only while signed in. */
export function startSync(): () => void {
  const onChange = () => schedule(DEBOUNCE_MS);
  const onFocus = () => schedule(300);
  const onVisible = () => document.visibilityState === "visible" && onFocus();
  window.addEventListener(WALL_CHANGED, onChange);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener(WALL_CHANGED, onChange);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
