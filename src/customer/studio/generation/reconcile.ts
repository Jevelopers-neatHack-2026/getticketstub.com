// Reconciling the editor's open version list with what is stored, for a generation commit. Versions are immutable and only ever
// added, so the safe union keeps every version either side has: the editor's own unsaved history (a failed save leaves it only
// here) AND versions another editor saved meanwhile. Nothing is deleted, nothing is rewritten, the selection is not moved here.
import type { DesignVersion } from "../types";
import { artUnavailable } from "../versions/retention";

/** The same stored version: identical identity and body. A picture released to fit storage is not a different body. */
export function sameVersion(a: DesignVersion, b: DesignVersion): boolean {
  if (a.id !== b.id || a.parentId !== b.parentId || a.edition !== b.edition || a.createdAt !== b.createdAt) return false;
  if (a.art.seed !== b.art.seed || a.art.vibe !== b.art.vibe) return false;
  if (artUnavailable(a.art) || artUnavailable(b.art)) return true; // one side let go of its picture: not a different version
  return a.art.src === b.art.src && a.art.kind === b.art.kind && a.art.provenance === b.art.provenance;
}

export type Reconciled =
  | { status: "ok"; versions: DesignVersion[]; peerOnly: string[]; ownOnly: string[] }
  | { status: "replaced" } // no version in common: a different project now holds the id
  | { status: "conflict"; versionId: string }; // the same id with a different body: cannot be merged safely

export function reconcileVersions(draft: DesignVersion[], stored: DesignVersion[]): Reconciled {
  const have = new Map(stored.map((v) => [v.id, v]));
  const mine = new Set(draft.map((v) => v.id));
  let shared = 0;
  for (const v of draft) {
    const other = have.get(v.id);
    if (!other) continue;
    shared++;
    if (!sameVersion(v, other)) return { status: "conflict", versionId: v.id };
  }
  if (draft.length > 0 && shared === 0) return { status: "replaced" };
  const peerOnly = stored.filter((v) => !mine.has(v.id));
  return { status: "ok", versions: [...draft, ...peerOnly], peerOnly: peerOnly.map((v) => v.id), ownOnly: draft.filter((v) => !have.has(v.id)).map((v) => v.id) };
}
