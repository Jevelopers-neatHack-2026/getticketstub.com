"use client";
// Keeps the local wall and the account's wall the same. localStorage stays the cache and the
// signed-out mode; signed in, every change goes up (debounced) and the merged wall comes back down.
// Failed requests do not write a local result. A remote acknowledgement and local persistence are distinct outcomes;
// neither localStorage reads nor multi-key writes establish a cross-tab transaction.
import { WALL_CHANGED, readDeleted, readWall, readableWall, saveDeleted, writeWall } from "@/customer/studio/store";
import type { Stub } from "@/customer/studio/types";
import { retainArt } from "@/customer/studio/versions/retention";
import { api } from "./api";
import { isSavingOff } from "./saving";
import { errorCode, flow } from "@/customer/flows/events";

export const WALL_SYNC_RESULT = "ticketstub:wall-sync-result";
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
    // a version whose picture one side let go of takes it from the other, when that still has it
    else out.push(at(mine) > at(s) ? retainArt(mine, s) : retainArt({ ...s, photos: mine.photos?.length ? mine.photos : s.photos }, mine));
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
  remoteAcknowledged?: true;
  localReadFailed?: true;
  localPersistenceFailed?: true;
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
  if (isSavingOff()) {
    const read = readWall();
    return Promise.resolve(read.status === "known" ? { ok: true, count: read.stubs.length } : { ok: false, count: 0, localReadFailed: true });
  }
  if (running) {
    again = true;
    return running;
  }
  running = (async (): Promise<SyncResult> => {
    const sentAt = Date.now();
    const initial = readWall();
    const tombstones = readDeleted();
    const local = initial.status === "known" ? initial.stubs : [];
    let remoteAcknowledged = false;
    const failLocal = (readFailed: boolean, count: number): SyncResult => {
      flow("server_save", { kind: "sync", result: "failed", error_code: "unavailable" });
      lastSynced = false;
      return { ok: false, count, ...(remoteAcknowledged ? { remoteAcknowledged: true } : {}), ...(readFailed ? { localReadFailed: true } : { localPersistenceFailed: true }) };
    };
    if (initial.status !== "known" || tombstones.status !== "known") return failLocal(true, local.length);
    const deleted = tombstones.ids;
    try {
      const reply = await api.sync(local, deleted);
      if (!readableWall(reply.stubs) || !Array.isArray(reply.deleted) || !reply.deleted.every(id => typeof id === "string")) throw new Error("unreadable sync reply");
      remoteAcknowledged = true;
      // Server custody is distinct from local persistence. A local failure does not roll this acknowledgement back.
      for (const s of local) onServer.add(s.id);
      for (const s of reply.stubs) onServer.add(s.id);
      for (const id of reply.deleted) onServer.delete(id);
      const current = readWall();
      const queued = readDeleted();
      if (current.status !== "known" || queued.status !== "known") return failLocal(true, local.length);
      const merged = foldWall(current.stubs, reply.stubs, reply.deleted, sentAt);
      if (!writeWall(merged)) return failLocal(false, current.stubs.length);
      // Only this acknowledged request's deletion snapshot is cleared, after the wall is safely handled.
      const sent = new Set(deleted);
      if (!saveDeleted(queued.ids.filter(id => !sent.has(id)))) return failLocal(false, merged.length);
      window.dispatchEvent(new CustomEvent(WALL_SYNCED, { detail: { count: merged.length } }));
      if (lastSynced !== true) flow("server_save", { kind: "sync", result: "saved" });
      lastSynced = true;
      return { ok: true, count: merged.length, remoteAcknowledged: true };
    } catch (e) {
      flow("server_save", { kind: "sync", result: "failed", error_code: errorCode(e) });
      lastSynced = false;
      return { ok: false, count: local.length, ...(remoteAcknowledged ? { remoteAcknowledged: true } : {}) };
    }
  })().then(result => {
    window.dispatchEvent(new CustomEvent(WALL_SYNC_RESULT, { detail: result }));
    return result;
  }).finally(() => {
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
