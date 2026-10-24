// Immutable stub edits and editor helpers. Edits may return the original Stub for a no-op;
// callers persist changes with upsertStub. New versions receive generated IDs and timestamps.
import { EDITIONS, currentVersion } from "../types";
import type { ArtLayer, DesignVersion, Edition, Finish, Material, Stub } from "../types";

export type Selectable = "title" | "subtitle" | "facts" | "art";

export function uid(prefix = "v"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/** The same stub, viewed at another design version (for thumbnails). */
export function atVersion(stub: Stub, versionId: string): Stub {
  return { ...stub, currentVersionId: versionId };
}

/** The same stub, viewed in another edition with the current art (for the style grid). */
export function previewEdition(stub: Stub, edition: Edition): Stub {
  const cur = currentVersion(stub);
  const existing = findVersion(stub, edition, cur.art);
  if (existing) return atVersion(stub, existing.id);
  const v: DesignVersion = { ...cur, id: `preview-${edition}`, edition };
  return { ...stub, versions: [...stub.versions, v], currentVersionId: v.id };
}

function sameArt(a: ArtLayer, b: ArtLayer): boolean {
  return a.kind === b.kind && a.src === b.src && a.seed === b.seed && a.vibe === b.vibe;
}

function findVersion(stub: Stub, edition: Edition, art: ArtLayer): DesignVersion | undefined {
  return stub.versions.find((v) => v.edition === edition && sameArt(v.art, art));
}

/** Switch edition, keeping the data and the art. Reuses a matching version so history stays short. */
export function setEdition(stub: Stub, edition: Edition): Stub {
  const cur = currentVersion(stub);
  if (cur.edition === edition) return stub;
  const existing = findVersion(stub, edition, cur.art);
  if (existing) return atVersion(stub, existing.id);
  const v: DesignVersion = { id: uid(), parentId: cur.id, edition, art: cur.art, createdAt: new Date().toISOString() };
  return { ...stub, versions: [...stub.versions, v], currentVersionId: v.id };
}

export function stepEdition(stub: Stub, dir: 1 | -1): Stub {
  const i = EDITIONS.indexOf(currentVersion(stub).edition);
  const next = EDITIONS[(i + dir + EDITIONS.length) % EDITIONS.length];
  return setEdition(stub, next);
}

/** An art change is always a new design version. */
export function addArtVersion(stub: Stub, art: ArtLayer): Stub {
  const cur = currentVersion(stub);
  const v: DesignVersion = { id: uid(), parentId: cur.id, edition: cur.edition, art, createdAt: new Date().toISOString() };
  return { ...stub, versions: [...stub.versions, v], currentVersionId: v.id };
}

function looksLikeIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function formatDate(iso?: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", opts).format(d);
}

/** Display text for an alternative value (dates read as "12 Oct 2024"). */
export function altLabel(value: string): string {
  return looksLikeIsoDate(value) ? formatDate(value) : value;
}

/** Confirm a fact: set its value, mark it certain, and keep the printed label in step. */
export function setFactValue(stub: Stub, factId: string, value: string): Stub {
  let dateISO = stub.event.dateISO;
  const facts = stub.event.facts.map((f) => {
    if (f.id !== factId) return f;
    const isDate = looksLikeIsoDate(value);
    if (isDate) dateISO = value;
    const label = isDate ? formatDate(value, { day: "numeric", month: "short" }) : value;
    return { ...f, value, label, confidence: 1, kept: true };
  });
  return { ...stub, event: { ...stub.event, facts, dateISO } };
}

export function toggleKept(stub: Stub, factId: string): Stub {
  const facts = stub.event.facts.map((f) => (f.id === factId ? { ...f, kept: !f.kept } : f));
  return { ...stub, event: { ...stub.event, facts } };
}

export function setHidden(stub: Stub, field: string, hidden: boolean): Stub {
  const rest = stub.personal.hiddenFields.filter((h) => h !== field);
  return { ...stub, personal: { ...stub.personal, hiddenFields: hidden ? [...rest, field] : rest } };
}

export function cycleFont(stub: Stub): Stub {
  const next = ((stub.personal.titleFont + 1) % 4) as 0 | 1 | 2 | 3;
  return { ...stub, personal: { ...stub.personal, titleFont: next } };
}

/** "" uses the edition's default title colour. */
export const TITLE_SWATCHES: { value: string; label: string }[] = [
  { value: "", label: "From the art" },
  { value: "#17140F", label: "Ink" },
  { value: "#E4572E", label: "Orange" },
  { value: "#F4ECDD", label: "Cream" },
];

export function cycleColour(stub: Stub): Stub {
  const i = TITLE_SWATCHES.findIndex((s) => s.value === stub.personal.titleColor);
  const next = TITLE_SWATCHES[(i + 1) % TITLE_SWATCHES.length].value;
  return { ...stub, personal: { ...stub.personal, titleColor: next } };
}

export function swatchLabel(value: string): string {
  return TITLE_SWATCHES.find((s) => s.value === value)?.label ?? "Custom";
}

export function toggleFoil(stub: Stub): Stub {
  return { ...stub, personal: { ...stub.personal, foilTitle: !stub.personal.foilTitle } };
}

export function holoAllowed(m: Material): boolean {
  return m === "print" || m === "framed";
}

export function setMaterial(stub: Stub, material: Material): Stub {
  const finish: Finish = stub.finish === "holo" && !holoAllowed(material) ? "foil" : stub.finish;
  return { ...stub, material, finish };
}

export function setFinish(stub: Stub, finish: Finish): Stub {
  if (finish === "holo" && !holoAllowed(stub.material)) return stub;
  return { ...stub, finish };
}

/** Read an image file and shrink it so it fits comfortably in local storage. */
export function readImageFile(file: File, max = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("We couldn't read that photo. Try another one."));
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onerror = () => reject(new Error("We couldn't read that photo. Try another one."));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(src);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

/** "var(--font-display), \"Fraunces\", Georgia, serif" -> "Fraunces". */
export function fontName(stack: string | undefined, fallback: string): string {
  if (!stack) return fallback;
  const first = stack
    .split(",")
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("var("));
  return first ? first.replace(/["']/g, "") : fallback;
}

/** Hide what's selected. The title always stays; "facts" hides every fact on the line. */
export function canHide(sel: Selectable): boolean {
  return sel === "subtitle" || sel === "facts";
}
export function hideSelection(stub: Stub, sel: Selectable): Stub {
  if (sel === "subtitle") return setHidden(stub, "subtitle", true);
  if (sel === "facts") {
    const ids = stub.event.facts.map((f) => f.id);
    const rest = stub.personal.hiddenFields.filter((h) => !ids.includes(h));
    return { ...stub, personal: { ...stub.personal, hiddenFields: [...rest, ...ids] } };
  }
  return stub;
}
export function hiddenLabel(stub: Stub, key: string): string {
  return stub.event.facts.find((f) => f.id === key)?.label ?? key;
}
