"use client";
// Local persistence: the cache and the signed-out mode. Signed in, account/sync.ts merges it with the account's wall.
// Old share links carry the stub itself (see encodeStub),
// so memory pages work without a backend. Storage can throw (private mode): every access is guarded.
import type { Correction, Stub } from "./types";
import { releasable, releaseOldest, retainArt } from "./versions/retention";
import { applyCorrection, entries, undoCorrection, type CorrectionInput } from "./facts/corrections";
import { storageFailure, storageReason } from "@/customer/flows/events";

const KEY = "ticketstub.wall.v1";
const DELETED_KEY = "ticketstub.wall.deleted.v1";
/** Fired after a local change the account sync should hear about. A sync's own writes don't fire it. */
export const WALL_CHANGED = "ticketstub:wall-changed";

function changed(): void {
  try {
    window.dispatchEvent(new Event(WALL_CHANGED));
  } catch {
    /* no window (server render) */
  }
}

/** Ids removed on this device that the account hasn't heard about yet. Signed out they just accumulate, a few bytes each. */
export function loadDeleted(): string[] {
  try {
    const raw = localStorage.getItem(DELETED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch (e) {
    storageFailure("deleted", "read", e);
    return [];
  }
}

/** True when the ids were written. A false is already reported (without the ids). */
export function saveDeleted(ids: string[]): boolean {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify([...new Set(ids)]));
    return true;
  } catch (e) {
    /* storage unavailable or full */
    storageFailure("deleted", "write", e);
    return false;
  }
}

export function loadWall(): Stub[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stub[]) : [];
  } catch (e) {
    storageFailure("wall", "read", e);
    return [];
  }
}

/**
 * Write the wall without telling the sync (the sync's own result goes through here). True when it was stored.
 * Every version keeps its picture. Only when the browser says it is full are the oldest unselected pictures released
 * (marked unavailable, never swapped for other art) until it fits: a bounded search, log2(n) extra writes at most.
 * The selected version's picture is never released; if even that doesn't fit, nothing is written and the wall stays as it was.
 */
export function writeWall(stubs: Stub[]): boolean {
  return writeWallDetailed(stubs).ok;
}

/** As writeWall, plus how many older pictures had to be released to fit (0 when everything was kept). */
export function writeWallDetailed(stubs: Stub[]): { ok: boolean; released: number } {
  const total = releasable(stubs).length;
  const attempt = (n: number): unknown => {
    try {
      localStorage.setItem(KEY, JSON.stringify(releaseOldest(stubs, n)));
      return undefined;
    } catch (e) {
      return e ?? new Error("storage write failed");
    }
  };
  const first = attempt(0);
  if (first === undefined) return { ok: true, released: 0 };
  /* storage unavailable or full: the session still works in memory */
  storageFailure("wall", "write", first);
  if (storageReason(first) !== "quota" || total === 0) return { ok: false, released: 0 };
  if (attempt(total) !== undefined) return { ok: false, released: 0 }; // even the selected pictures alone don't fit
  // Fewest releases that fit: the smallest n in (0, total] that succeeds. Failed writes leave the old value in place.
  let lo = 1;
  let hi = total;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (attempt(mid) === undefined) hi = mid;
    else lo = mid + 1;
  }
  return attempt(lo) === undefined ? { ok: true, released: lo } : { ok: false, released: 0 };
}

/** True when the wall was stored. Callers that used to ignore the result still can. */
export function saveWall(stubs: Stub[]): boolean {
  const ok = writeWall(stubs);
  changed();
  return ok;
}

export function getStub(id: string): Stub | undefined {
  return loadWall().find((s) => s.id === id);
}

/** Save one stub to the front of the wall. True when it is stored on this device; false means it lives in memory only. */
export function upsertStub(stub: Stub): boolean {
  const stored = loadWall();
  const wall = stored.filter((s) => s.id !== stub.id);
  const gone = loadDeleted();
  if (gone.includes(stub.id)) saveDeleted(gone.filter((id) => id !== stub.id));
  // a copy that had to let go of a picture takes it back from what is stored, if that still has it
  return saveWall([{ ...retainArt(stub, stored.find((s) => s.id === stub.id)), updatedAt: Date.now() }, ...wall]);
}

/** A stub's correction history, oldest first. Entries are only ever appended (an undo is a new entry). */
export function correctionsFor(id: string): Correction[] {
  const stub = getStub(id);
  return stub ? entries(stub) : [];
}

/** Record the person's answer for one fact on a saved stub and keep it. Returns the saved stub, or undefined when there is none. */
export function recordCorrection(id: string, input: CorrectionInput): Stub | undefined {
  const stub = getStub(id);
  if (!stub) return undefined;
  const next = applyCorrection(stub, input);
  if (next !== stub) upsertStub(next);
  return next;
}

/** Undo the standing correction for a fact by appending a new entry. */
export function undoStubCorrection(id: string, factId: string): Stub | undefined {
  const stub = getStub(id);
  if (!stub) return undefined;
  const next = undoCorrection(stub, factId);
  if (next !== stub) upsertStub(next);
  return next;
}

/** True when the stub is gone from storage too. */
export function removeStub(id: string): boolean {
  saveDeleted([...loadDeleted(), id]);
  return saveWall(loadWall().filter((s) => s.id !== id));
}

/** Compact, URL-safe encoding of a stub for share links (photos dropped to keep URLs short). */
export function encodeStub(stub: Stub): string {
  // Share links can't carry inline images: data-URL art falls back to its procedural seed.
  const lean: Stub = {
    ...stub,
    photos: [],
    versions: stub.versions.map((v) => (v.art.src?.startsWith("data:") ? { ...v, art: { ...v.art, kind: "procedural", src: undefined } } : v)),
  };
  const json = JSON.stringify(lean);
  const b64 = typeof window === "undefined" ? Buffer.from(json, "utf-8").toString("base64") : btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeStub(token: string): Stub | undefined {
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof window === "undefined" ? Buffer.from(b64, "base64").toString("utf-8") : decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json) as Stub;
  } catch {
    return undefined;
  }
}
