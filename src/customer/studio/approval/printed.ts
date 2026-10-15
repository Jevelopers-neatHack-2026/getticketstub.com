// What an approval covers, in words (GT-06B.1). Pure and shared: the server stores printedSummary() beside each approval
// (owner-only, never in the signed record) and the review sheet shows printedLines() for the stub in front of the owner.
// printedLines() reads exactly the fields bindStub() hashes into factsHash (event fields + kept facts), so what the sheet
// lists is what the binding covers. Keep the two in step: scripts/check-approval.mjs fails if they drift apart.
import type { Stub } from "../types";

export interface PrintedLine {
  key: string;
  label: string;
  value: string;
  /** Provenance of a kept fact; the event's own fields (title, venue, date, seat) have none. */
  provenance?: string;
}
export interface ApprovalSummary {
  printed: PrintedLine[];
}
/** Which parts of the stub differ from an approval's binding right now, by comparing hashes. Owner-only, computed by the server. */
export interface ApprovalDrift {
  version: boolean;
  art: boolean;
  design: boolean;
  facts: boolean;
  composition: boolean;
}
export interface Composition {
  edition: string;
  material: string;
  finish: string;
  size: string;
}

/** The server canonicalizes object keys; equality depends on the four bound
 * composition values, never their insertion order in a JSON response. */
export function sameComposition(value: unknown, current: Composition): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bound = value as Record<string, unknown>;
  return (["edition", "material", "finish", "size"] as const).every((key) =>
    Object.hasOwn(bound, key) && typeof bound[key] === "string" && bound[key] === current[key]);
}

const EVENT_LINES: [keyof Stub["event"], string][] = [
  ["type", "Kind of event"],
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["venue", "Venue"],
  ["city", "City"],
  ["dateISO", "Date"],
  ["seat", "Seat"],
];

export function printedLines(stub: Pick<Stub, "event">): PrintedLine[] {
  const e = stub.event;
  const lines: PrintedLine[] = [];
  for (const [k, label] of EVENT_LINES) {
    const v = e[k];
    if (typeof v === "string" && v.trim()) lines.push({ key: k, label, value: v });
  }
  for (const f of [...(e.facts ?? [])].filter((x) => x.kept).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    lines.push({ key: `fact:${f.id}`, label: f.label, value: f.value, provenance: f.provenance });
  }
  return lines;
}

/** UI-only row identity, deliberately separate from the source/content-only approval summary DTO. */
export function printedRowKeys(stub: Pick<Stub, "event">): string[] {
  const lines = printedLines(stub);
  const facts = [...(stub.event.facts ?? [])].filter(f => f.kept).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const offset = lines.length - facts.length;
  return lines.map((line,i) => i < offset ? line.key : (facts[i-offset].clientEntityKey ?? facts[i-offset].id));
}

export const printedSummary = (stub: Pick<Stub, "event">): ApprovalSummary => ({ printed: printedLines(stub) });

export function parseSummary(json: string | null): ApprovalSummary | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as ApprovalSummary;
    return Array.isArray(s?.printed) ? s : null;
  } catch {
    return null;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SIZE_WORDS: Record<string, string> = { classic: "Classic stub", stamp: "Stamp", framed: "Framed print", file: "Digital file" };
export const sizeWords = (size: string) => SIZE_WORDS[size] ?? cap(size);

/** "Letterpress style, Print, Foil finish, Classic stub" as separate labelled parts. */
export function compositionParts(c: Composition): { label: string; value: string }[] {
  return [
    { label: "Style", value: cap(c.edition) },
    { label: "Material", value: cap(c.material) },
    { label: "Finish", value: cap(c.finish) },
    { label: "Size", value: sizeWords(c.size) },
  ];
}

function dateWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
export const valueWords = (l: PrintedLine) => (l.key === "dateISO" ? dateWords(l.value) : l.key === "type" ? cap(l.value) : l.value);

export interface ChangeSource {
  id: string;
  status: "active" | "revoked" | "expired" | "stale";
  binding: { versionId: string; composition: Composition };
  summary: ApprovalSummary | null;
  drift: ApprovalDrift | null;
}

/**
 * Plain-words differences between an earlier approval and the stub as it would be approved now.
 * Can say: the version, the art, each composition field (style, material, finish, size) and which printed facts were
 * added, removed or changed (when the earlier approval kept a summary). Cannot say: what exactly changed in the title
 * style, hidden fields or note (only that something in the settings did), or art detail beyond "the art changed".
 */
export function changesSince(prev: ChangeSource | undefined, now: { printed: PrintedLine[]; composition: Composition }): { first: boolean; items: string[]; same: boolean; hash: string } {
  if (!prev) return { first: true, items: [], same: false, hash: "" };
  const hash = prev.id.slice(4, 10);
  const items: string[] = [];
  const d = prev.drift;
  const pc = prev.binding.composition;
  if (d?.art) items.push("Art changed");
  else if (d?.version) items.push("A different version is selected, with the same art");
  for (const [label, a, b] of [
    ["Style", pc.edition, now.composition.edition],
    ["Material", pc.material, now.composition.material],
    ["Finish", pc.finish, now.composition.finish],
    ["Size", pc.size, now.composition.size],
  ] as const) {
    if (a !== b) items.push(`${label}: ${label === "Size" ? sizeWords(a) : cap(a)} → ${label === "Size" ? sizeWords(b) : cap(b)}`);
  }
  if (prev.summary) {
    const was = new Map(prev.summary.printed.map((l) => [l.key, l]));
    const is = new Map(now.printed.map((l) => [l.key, l]));
    const names: string[] = [];
    for (const [k, l] of is) {
      const o = was.get(k);
      if (!o) names.push(`${l.label} added`);
      else if (o.value !== l.value || o.label !== l.label) names.push(`${l.label} changed`);
    }
    for (const [k, l] of was) if (!is.has(k)) names.push(`${l.label} removed`);
    for (const n of names) items.push(`Facts: ${n}`);
  } else if (d?.facts) items.push("Facts changed");
  if (d?.facts && !items.some((i) => i.startsWith("Facts"))) items.push("Facts: a source or detail changed");
  // Something in the signed settings moved that the words above don't name (title style, hidden fields, note).
  if (d?.composition && !items.some((i) => /^(Style|Material|Finish|Size):/.test(i))) items.push("Title style, hidden fields or note changed");
  if (d?.design && !items.length) items.push("Design settings changed");
  return { first: false, items, same: !items.length && d !== null && !d.version && !d.art && !d.design && !d.facts && !d.composition, hash };
}
