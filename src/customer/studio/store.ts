"use client";
// Local-only persistence for the hackathon build. Share links carry the stub itself (see encodeStub),
// so memory pages work without a backend. Storage can throw (private mode): every access is guarded.
import type { Stub } from "./types";

const KEY = "ticketstub.wall.v1";

export function loadWall(): Stub[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stub[]) : [];
  } catch {
    return [];
  }
}

/** Drop inline image data from non-current versions to reduce stored history size. */
function slim(stub: Stub): Stub {
  return {
    ...stub,
    versions: stub.versions.map((v) =>
      v.id !== stub.currentVersionId && v.art.src?.startsWith("data:") ? { ...v, art: { ...v.art, kind: "procedural", src: undefined } } : v,
    ),
  };
}

export function saveWall(stubs: Stub[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(stubs.map(slim)));
  } catch {
    /* storage unavailable or full: nothing is persisted; callers retain their own state */
  }
}

export function getStub(id: string): Stub | undefined {
  return loadWall().find((s) => s.id === id);
}

export function upsertStub(stub: Stub): void {
  const wall = loadWall().filter((s) => s.id !== stub.id);
  saveWall([stub, ...wall]);
}

export function removeStub(id: string): void {
  saveWall(loadWall().filter((s) => s.id !== id));
}

/** Compact, URL-safe encoding of a stub for share links (photos dropped to keep URLs short). */
export function encodeStub(stub: Stub): string {
  // Omit data-URL art to limit link size; recipients render its procedural seed instead.
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
