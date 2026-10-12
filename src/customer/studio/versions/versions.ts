// Pure logic for the version history (GT-06A): how a version was made, comparing two in words, and restoring one.
// A DesignVersion is art plus edition. Restoring only changes which version is selected: it overwrites nothing and
// generates nothing, and the next edit branches from the restored version because new versions take the selected one as parent.
import type { ArtLayer, DesignVersion, Stub, VersionContext } from "../types";
import { artUnavailable } from "./retention";

/** A short, stable id for a version: a hash of what makes it what it is. Inline image data is hashed by its length and ends. */
export function versionHash(v: DesignVersion): string {
  const src = v.art.src ?? "";
  const art = src.startsWith("data:") ? `data:${src.length}:${src.slice(-24)}` : src;
  const text = [v.id, v.parentId ?? "", v.edition, v.art.kind, art, v.art.seed, v.art.vibe ?? ""].join("|");
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/** What the stub's settings were, to keep on a version when it is made. */
export function contextOf(stub: Stub): VersionContext {
  const p = stub.personal;
  return {
    material: stub.material,
    finish: stub.finish,
    keptFacts: stub.event.facts.filter((f) => f.kept).map((f) => f.label),
    personal: { titleFont: p.titleFont, titleColor: p.titleColor, foilTitle: p.foilTitle, hiddenFields: [...p.hiddenFields], ...(p.note ? { note: p.note } : {}) },
  };
}

export function sameArt(a: ArtLayer, b: ArtLayer): boolean {
  return a.kind === b.kind && a.src === b.src && a.seed === b.seed && a.vibe === b.vibe;
}

/** What the art is, in plain words. Sample and procedural art never reads as the real thing. */
export function artLabel(a: ArtLayer): { text: string; sample: boolean } {
  if (artUnavailable(a)) {
    return a.vibe === "photo"
      ? { text: "Your photo, image not kept on this device (sample shown)", sample: true }
      : { text: "Generated art, image not kept on this device (sample shown)", sample: true };
  }
  if (a.vibe === "photo") return { text: "Your photo", sample: false };
  if (a.kind === "procedural") return { text: "Procedural art (sample)", sample: true };
  if (a.provenance === "live") return { text: "Generated art", sample: false };
  return { text: "Sample art (not generated)", sample: true };
}

export type MadeKind = "first" | "edition" | "photo" | "remix" | "procedural";

/** How a version came to be, from its parent: the first one, a new edition on the same art, or a remix. */
export function howMade(stub: Stub, v: DesignVersion): { kind: MadeKind; text: string } {
  const parent = v.parentId ? stub.versions.find((x) => x.id === v.parentId) : undefined;
  if (!v.parentId || !parent) return { kind: "first", text: v.parentId ? "From an earlier version no longer kept" : "First version" };
  if (sameArt(parent.art, v.art) && parent.edition !== v.edition) return { kind: "edition", text: `New style: ${v.edition}` };
  if (v.art.vibe === "photo") return { kind: "photo", text: "Remix from your photo" };
  if (v.art.vibe) return { kind: "remix", text: `Remix, ${v.art.vibe} vibe` };
  if (v.art.kind === "procedural") return { kind: "procedural", text: "Procedural remix" };
  return { kind: "remix", text: "Remix" };
}

/** Newest first, so the list reads as a history. Ties keep the order they were made in. */
export function listVersions(stub: Stub): DesignVersion[] {
  return stub.versions
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => !v.id.startsWith("preview-"))
    .sort((a, b) => b.v.createdAt.localeCompare(a.v.createdAt) || b.i - a.i)
    .map(({ v }) => v);
}

/** Select a prior version. Nothing is overwritten and nothing is generated. An unknown id leaves the stub as it was. */
export function restoreVersion(stub: Stub, id: string): Stub {
  if (stub.currentVersionId === id || !stub.versions.some((v) => v.id === id)) return stub;
  return { ...stub, currentVersionId: id };
}

export interface VersionChange {
  field: "art" | "edition" | "finish" | "material" | "facts" | "personalization";
  text: string;
}

const list = (items: string[]) => (items.length ? items.join(", ") : "none");

function personalLines(a: VersionContext["personal"], b: VersionContext["personal"]): string[] {
  const out: string[] = [];
  if (a.titleFont !== b.titleFont) out.push(`title font ${a.titleFont + 1} to ${b.titleFont + 1}`);
  if (a.titleColor !== b.titleColor) out.push(`title colour ${a.titleColor || "from the art"} to ${b.titleColor || "from the art"}`);
  if (a.foilTitle !== b.foilTitle) out.push(b.foilTitle ? "foil title on" : "foil title off");
  if ((a.note ?? "") !== (b.note ?? "")) out.push(b.note ? `back note "${b.note}"` : "back note removed");
  const hideAdded = b.hiddenFields.filter((h) => !a.hiddenFields.includes(h));
  const hideShown = a.hiddenFields.filter((h) => !b.hiddenFields.includes(h));
  if (hideAdded.length) out.push(`hidden: ${hideAdded.join(", ")}`);
  if (hideShown.length) out.push(`shown again: ${hideShown.join(", ")}`);
  return out;
}

/**
 * What differs between two versions, in words. Art and edition come from the versions. Material, finish, kept facts and
 * personalization come from the settings kept when each version was made; the selected version uses the stub as it is now.
 * When a version has no kept settings (an older one), the comparison says so rather than guessing.
 */
export function compareVersions(stub: Stub, aId: string, bId: string): VersionChange[] {
  const a = stub.versions.find((v) => v.id === aId);
  const b = stub.versions.find((v) => v.id === bId);
  if (!a || !b) return [];
  const out: VersionChange[] = [];
  const la = artLabel(a.art);
  const lb = artLabel(b.art);
  if (!sameArt(a.art, b.art)) out.push({ field: "art", text: `Art: ${la.text}${a.art.vibe ? `, ${a.art.vibe}` : ""} became ${lb.text}${b.art.vibe ? `, ${b.art.vibe}` : ""}.` });
  else out.push({ field: "art", text: "Art: the same." });
  if (a.edition !== b.edition) out.push({ field: "edition", text: `Style: ${a.edition} became ${b.edition}.` });
  const ca = a.id === stub.currentVersionId ? contextOf(stub) : a.context;
  const cb = b.id === stub.currentVersionId ? contextOf(stub) : b.context;
  if (!ca || !cb) {
    out.push({ field: "material", text: "Material, finish, kept facts and personalization: not recorded for the older version, so they can't be compared." });
    return out;
  }
  if (ca.material !== cb.material) out.push({ field: "material", text: `Material: ${ca.material} became ${cb.material}.` });
  if (ca.finish !== cb.finish) out.push({ field: "finish", text: `Finish: ${ca.finish} became ${cb.finish}.` });
  const added = cb.keptFacts.filter((f) => !ca.keptFacts.includes(f));
  const dropped = ca.keptFacts.filter((f) => !cb.keptFacts.includes(f));
  if (added.length || dropped.length) {
    out.push({ field: "facts", text: `Kept facts: ${added.length ? `added ${list(added)}` : ""}${added.length && dropped.length ? "; " : ""}${dropped.length ? `removed ${list(dropped)}` : ""}.` });
  }
  const p = personalLines(ca.personal, cb.personal);
  if (p.length) out.push({ field: "personalization", text: `Personalization: ${p.join("; ")}.` });
  if (out.length === 1 && out[0].text.endsWith("the same.")) out.push({ field: "personalization", text: "Nothing else differs." });
  return out;
}

/** Plain-language line for the approval hook: exactly which version a print or checkout would use. */
export function selectedSummary(stub: Stub): { hash: string; text: string } {
  const v = stub.versions.find((x) => x.id === stub.currentVersionId) ?? stub.versions[0];
  return { hash: versionHash(v), text: `${v.edition} style, ${artLabel(v.art).text.toLowerCase()}, ${stub.material}, ${stub.finish}` };
}
