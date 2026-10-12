// Reconciling the editor's open version list with what is stored, for a generation commit. Versions are immutable and only ever
// added, so the safe union keeps every version either side has: the editor's own unsaved history (a failed save leaves it only
// here) AND versions another editor saved meanwhile. Nothing is deleted, nothing is rewritten, the selection is not moved here.
import type { DesignVersion } from "../types";
import { artUnavailable } from "../versions/retention";
import { compareArtSrc } from "./art-identity";

/** How two copies of one version id relate: identical identity and body ("same"), provably different, or not comparable. */
export function compareVersions(a: DesignVersion, b: DesignVersion): "same" | "different" | "unverifiable" {
  if (a.id !== b.id || a.parentId !== b.parentId || a.edition !== b.edition || a.createdAt !== b.createdAt) return "different";
  if (a.art.seed !== b.art.seed || a.art.vibe !== b.art.vibe) return "different";
  if (artUnavailable(a.art) || artUnavailable(b.art)) return "same"; // one side let go of its picture: not a different version
  if (a.art.kind !== b.art.kind || a.art.provenance !== b.art.provenance) return "different";
  // the account server moves an inline picture to a content-addressed file: the same bytes are the same body
  return compareArtSrc(a.art.src, b.art.src);
}

/** The same stored version: identical identity and body. */
export const sameVersion = (a: DesignVersion, b: DesignVersion): boolean => compareVersions(a, b) === "same";

export type Reconciled =
  | { status: "ok"; versions: DesignVersion[]; peerOnly: string[]; ownOnly: string[] }
  | { status: "replaced" } // no version in common: a different project now holds the id
  | { status: "conflict"; versionId: string } // the same id with a different body: cannot be merged safely
  | { status: "unverifiable"; versionId: string }; // the same id, but its picture cannot be compared with the stored reference

export function reconcileVersions(draft: DesignVersion[], stored: DesignVersion[]): Reconciled {
  const have = new Map(stored.map((v) => [v.id, v]));
  const mine = new Set(draft.map((v) => v.id));
  let shared = 0;
  for (const v of draft) {
    const other = have.get(v.id);
    if (!other) continue;
    shared++;
    const rel = compareVersions(v, other);
    if (rel === "different") return { status: "conflict", versionId: v.id };
    if (rel === "unverifiable") return { status: "unverifiable", versionId: v.id };
  }
  if (draft.length > 0 && shared === 0) return { status: "replaced" };
  const peerOnly = stored.filter((v) => !mine.has(v.id));
  return { status: "ok", versions: [...draft, ...peerOnly], peerOnly: peerOnly.map((v) => v.id), ownOnly: draft.filter((v) => !have.has(v.id)).map((v) => v.id) };
}
