"use client";
// Local persistence: the cache and the signed-out mode. Signed in, account/sync.ts merges it with the account's wall.
// Old share links carry the stub itself (see encodeStub),
// so memory pages work without a backend. Storage can throw (private mode): every access is guarded.
import type { Correction, Stub } from "./types";
import { releasable, releaseOldest, retainArt } from "./versions/retention";
import { applyCorrection, entries, undoCorrection, type CorrectionInput } from "./facts/corrections";
import { storageFailure, storageReason } from "@/customer/flows/events";
import { forgetStatus } from "./generation/status-store";
import { readableGenerationHistory } from "./generation/readable-history";

const KEY = "ticketstub.wall.v1";
/** The localStorage key of the wall, for code that reads a `storage` event's payload. */
export const WALL_STORAGE_KEY = KEY;
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
export type DeletedRead = { status: "known"; ids: string[] } | { status: "unknown" };
export function readDeleted(): DeletedRead {
  try {
    const raw = localStorage.getItem(DELETED_KEY);
    const ids: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) throw new SyntaxError("deleted IDs are not a list");
    return { status: "known", ids };
  } catch (e) {
    storageFailure("deleted", "read", e);
    return { status: "unknown" };
  }
}
export function loadDeleted(): string[] {
  const read = readDeleted();
  return read.status === "known" ? read.ids : [];
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

export type WallRead = { status: "known"; stubs: Stub[] } | { status: "unknown" };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Local consumer readability, not a canonical schema or a data migration. Unknown fields are retained. */
export function readableWall(value: unknown): value is Stub[] {
  return Array.isArray(value) && value.every(s => readableGenerationHistory(s) && record(s)
    && record(s.event) && typeof s.event.title === "string" && Array.isArray(s.event.facts)
    && record(s.personal) && Array.isArray(s.personal.hiddenFields) && Array.isArray(s.personal.friends)
    && (s.photos === undefined || Array.isArray(s.photos))
    && (s.updatedAt === undefined || typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt)));
}
function wallFromValue(raw: string | null): Extract<WallRead, { status: "known" }> {
  const stubs: unknown = raw === null ? [] : JSON.parse(raw);
  if (!readableWall(stubs)) throw new SyntaxError("wall rows are not readable");
  return { status: "known", stubs };
}
/** Null alone means first use. An exception, empty string or malformed row/history is unknown. */
export function readWall(): WallRead {
  try { return wallFromValue(localStorage.getItem(KEY)); }
  catch (e) { storageFailure("wall", "read", e); return { status: "unknown" }; }
}
/** Legacy display projection only. Mutation and sync must use readWall instead. */
export function loadWall(): Stub[] {
  const read = readWall();
  return read.status === "known" ? read.stubs : [];
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
  if (readWall().status !== "known" || !readableWall(stubs)) return { ok: false, released: 0 };
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
  if (ok) changed();
  return ok;
}

/** What a wall says about one stub. "unknown" means the wall could not be read: never "gone". */
export type StubPresence = "present" | "absent" | "unknown";

/** Presence from a raw stored wall value (a `storage` event's newValue, or a direct read). A malformed peer makes the wall unknown. */
export function wallPresenceFromValue(raw: string | null, id: string): StubPresence {
  try {
    const wall = wallFromValue(raw);
    return wall.stubs.some(s => s.id === id) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

/** A typed presence read that, unlike loadWall, does not turn a failed read into an empty wall. */
export function stubPresence(id: string): StubPresence {
  try {
    return wallPresenceFromValue(localStorage.getItem(KEY), id);
  } catch {
    return "unknown";
  }
}

/** The stored copy of one stub with a typed outcome ("unknown" when the wall cannot be read). */
export function readStoredStub(id: string): { status: "present"; stub: Stub } | { status: "absent" | "unknown" } {
  const read = readWall();
  if (read.status === "unknown") return read;
  const stub = read.stubs.find(s => s.id === id);
  return stub ? { status: "present", stub } : { status: "absent" };
}

export function getStub(id: string): Stub | undefined {
  return loadWall().find((s) => s.id === id);
}

/** Save one stub to the front of the wall. True when it is stored on this device; false means it lives in memory only. */
export function upsertStub(stub: Stub): boolean {
  const read = readWall();
  const deleted = readDeleted();
  if (read.status !== "known" || deleted.status !== "known" || !readableWall([stub])) return false;
  const stored = read.stubs;
  const wall = stored.filter(s => s.id !== stub.id);
  const next = [{ ...retainArt(stub, stored.find(s => s.id === stub.id)), updatedAt: Date.now() }, ...wall];
  // Write first: a refused/failed wall mutation never clears a deletion or advertises a saved change.
  if (!writeWall(next)) return false;
  if (deleted.ids.includes(stub.id) && !saveDeleted(deleted.ids.filter(id => id !== stub.id))) return false;
  changed();
  return true;
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
  const read = readWall();
  const deleted = readDeleted();
  if (read.status !== "known" || deleted.status !== "known") return false;
  if (!writeWall(read.stubs.filter(s => s.id !== id))) return false;
  if (!saveDeleted([...deleted.ids, id])) return false;
  forgetStatus(id);
  changed();
  return true;
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
