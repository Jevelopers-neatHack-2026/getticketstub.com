// Keeping a version's picture (GT-06A, GT-02.3). Inline art is large, so a full browser store may have to let go of
// some. When it does, the version says so (art.unavailable) instead of quietly showing different art, and any other
// copy of the same version that still has its picture (the account's wall, another tab) is used to fill it back in.
import type { ArtLayer, DesignVersion, Stub } from "../types";

const isInline = (src: string | undefined): src is string => !!src && src.startsWith("data:");

/**
 * True when this version's picture is not on this copy. Covers the explicit marker and the old silent drop, which left
 * generated ("live") art as procedural with no image, and photo versions left with no image.
 */
export function artUnavailable(a: ArtLayer): boolean {
  // a photo remix always had a picture, so a photo version with none lost it, whatever its provenance says
  return a.unavailable === true || (!a.src && (a.vibe === "photo" || (a.kind === "procedural" && a.provenance === "live")));
}

/** The version with its inline picture released and said so. Everything else about it (id, parent, seed, vibe) stays. */
export function releaseArt(v: DesignVersion): DesignVersion {
  return { ...v, art: { ...v.art, kind: "procedural", src: undefined, unavailable: true } };
}

/** Inline-art versions that are not the selected one, oldest first: the order a full store lets go of them. */
export function releasable(stubs: Stub[]): { stubId: string; versionId: string; at: string }[] {
  const out: { stubId: string; versionId: string; at: string }[] = [];
  for (const s of stubs) {
    for (const v of s.versions) {
      if (v.id !== s.currentVersionId && isInline(v.art.src)) out.push({ stubId: s.id, versionId: v.id, at: v.createdAt });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The stubs with the first `count` releasable versions (see `releasable`) released. The selected version is never touched. */
export function releaseOldest(stubs: Stub[], count: number): Stub[] {
  if (count <= 0) return stubs;
  const drop = new Set(releasable(stubs).slice(0, count).map((r) => `${r.stubId}\u0000${r.versionId}`));
  return stubs.map((s) => (s.versions.some((v) => drop.has(`${s.id}\u0000${v.id}`)) ? { ...s, versions: s.versions.map((v) => (drop.has(`${s.id}\u0000${v.id}`) ? releaseArt(v) : v)) } : s));
}

/**
 * `next` with any version whose picture is unavailable taking it back from the same version in `kept`, when `kept`
 * still has it. Matches by version id only; nothing else about the version changes. Returns `next` itself when nothing is restored.
 */
export function retainArt(next: Stub, kept: Stub | undefined): Stub {
  if (!kept || kept.id !== next.id) return next;
  const have = new Map(kept.versions.map((v) => [v.id, v]));
  let changed = false;
  const versions = next.versions.map((v) => {
    const old = have.get(v.id);
    if (!old || !artUnavailable(v.art) || artUnavailable(old.art) || !old.art.src) return v;
    changed = true;
    return { ...v, art: old.art };
  });
  return changed ? { ...next, versions } : next;
}
