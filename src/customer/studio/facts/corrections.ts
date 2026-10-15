// Pure logic for reviewing researched facts (GT-05): grouping, targeted questions, and the correction history.
// A correction never rewrites the research. It adds an entry to stub.corrections (oldest first) that keeps the original
// value, the new value, who, when and why. Undo is another entry. The fact itself is updated only so the stub renders the new value.
import { factKey, resolveFact, uniqueFacts } from "./identity";
import type { Correction, Fact, ReviewAsset, Stub } from "../types";

/** Anything that carries a correction history. Facts on the printing receipt have none yet. */
export type History = Pick<Stub, "corrections"> & Partial<Pick<Stub, "event">>;

export type FactGroup = "source" | "corrected" | "unsure" | "missing";

/** Facts a stub can't print well without. The title is event.title, the rest are facts. */
export const REQUIRED_FACTS = ["date", "venue"] as const;

export const SURE = 0.8;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY_VALUES = new Set(["", "pending", "not known yet"]);

function monthDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

/** True only for a real calendar date written YYYY-MM-DD (leap years honoured). Checked on the fields, with no timezone involved. */
export function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1];
}

export function entries(stub: History, factId?: string): Correction[] {
  const all = stub.corrections ?? [];
  if (!factId) return all;
  const facts = stub.event?.facts;
  const target = facts ? resolveFact(facts, factId) : undefined;
  return all.filter(c => !c.unresolvedIdentity && (facts
    ? !!target && (c.clientEntityKey ? c.clientEntityKey === target.clientEntityKey && c.factId === target.id : facts.filter(f => f.id === c.factId).length === 1 && target.id === c.factId)
    : !c.clientEntityKey && c.factId === factId));
}

/** The entry that currently decides a fact: corrections and confirmations not yet undone, latest first. Undefined when there is none. */
export function activeCorrection(stub: History, factId: string): Correction | undefined {
  const stack: Correction[] = [];
  for (const c of entries(stub, factId)) {
    if (c.kind === "undo") {
      const i = stack.findIndex((s) => s.id === c.undoes);
      if (i >= 0) stack.splice(i, 1);
    } else stack.push(c);
  }
  return stack[stack.length - 1];
}

/** The original researched value of a fact: the first thing the history recorded about it, or the fact as it stands. */
export function originalOf(stub: History, fact: Fact): Correction["original"] {
  const first = entries(stub, factKey(fact))[0];
  return first?.original ?? { value: fact.value, label: fact.label, source: fact.source, provenance: fact.provenance, confidence: fact.confidence, kept: fact.kept };
}

function isMissingValue(f: Fact): boolean {
  return f.provenance === "pending" || EMPTY_VALUES.has(f.value.trim().toLowerCase());
}

/** More than one distinct known answer and no confident pick: the sources disagree, or the guess is a guess. */
export function isConflicting(f: Fact): boolean {
  return new Set(f.alternatives ?? []).size > 1 && !(f.confidence >= SURE);
}

/** Unknown confidence (not a number) is unsure. It is never read as zero or as verified. */
function isUnsure(f: Fact): boolean {
  return !(typeof f.confidence === "number" && f.confidence >= SURE) || isConflicting(f);
}

export function factGroup(stub: History, f: Fact): FactGroup {
  if (activeCorrection(stub, factKey(f))) return "corrected";
  if (isMissingValue(f)) return "missing";
  if (isUnsure(f)) return "unsure";
  return "source";
}

export interface GroupedFacts {
  source: Fact[];
  corrected: Fact[];
  unsure: Fact[];
  missing: Fact[];
}

export function groupFacts(facts: Fact[], stub: History = {}): GroupedFacts {
  const out: GroupedFacts = { source: [], corrected: [], unsure: [], missing: [] };
  for (const f of facts) out[factGroup(stub, f)].push(f);
  return out;
}

/** True when the fact appears on the printed stub: kept facts, and the date and venue the stub always prints. */
export function isPrinted(f: Pick<Fact, "id" | "kept">): boolean {
  return !!f.kept || f.id === "date" || f.id === "venue";
}

/** A short question about one fact the person needs to settle (GT-05.2). */
export interface Question {
  factId: string; // source ID, not a local targeting token
  clientEntityKey?: string;
  label: string; // what is being asked about: "date", "venue", "title"
  text: string;
  alternatives: string[]; // known alternatives, de-duplicated, the current value first when it is one
  input: "date" | "text";
  required: boolean;
}

const WORD: Record<string, string> = { date: "date", venue: "venue", title: "title" };

function questionFor(f: Fact | undefined, id: string, event: Stub["event"]): Question {
  const word = WORD[id] ?? (f?.label ?? "this");
  const known = [...new Set((f?.alternatives ?? []).filter((a) => a && !EMPTY_VALUES.has(a.trim().toLowerCase())))];
  const missing = !f || isMissingValue(f);
  const current = f && !missing ? f.value : id === "date" ? event.dateISO : id === "venue" ? event.venue : undefined;
  const alternatives = current && !known.includes(current) && !missing ? [current, ...known] : known;
  const text = missing
    ? id === "date"
      ? "What date was it?"
      : id === "venue"
        ? "Where was it?"
        : `What is the ${word}?`
    : id === "date"
      ? "Which date was it?"
      : id === "venue"
        ? "Which venue was it?"
        : `Which ${word} is right?`;
  return { factId: id, ...(f?.clientEntityKey ? { clientEntityKey: f.clientEntityKey } : {}), label: word, text, alternatives, input: id === "date" ? "date" : "text", required: (REQUIRED_FACTS as readonly string[]).includes(id) || id === "title" };
}

/**
 * The questions still open. Required facts (date, venue, title) that are missing or conflicting always ask. Other unsure facts ask too.
 * Optional facts that are missing stay explicitly unknown and are not asked. A question closes the moment a correction is recorded, so
 * every surface that reads this list agrees on what is still open and nothing is asked twice.
 */
export function openQuestions(stub: Stub): Question[] {
  const ev = stub.event;
  const out: Question[] = [];
  for (const id of REQUIRED_FACTS) {
    const matches = ev.facts.filter(f => f.id === id);
    const have = id === "date" ? ev.dateISO : ev.venue;
    if (!matches.length && !have) out.push(questionFor(undefined, id, ev));
    for (const f of matches) {
      if (!activeCorrection(stub, factKey(f)) && (isMissingValue(f) || isUnsure(f))) out.push(questionFor(f, id, ev));
    }
  }
  if (!ev.title.trim()) out.push(questionFor(undefined, "title", ev));
  for (const f of ev.facts) {
    if ((REQUIRED_FACTS as readonly string[]).includes(f.id) || activeCorrection(stub, factKey(f))) continue;
    if (!isMissingValue(f) && isUnsure(f)) out.push(questionFor(f, f.id, ev));
  }
  return out;
}

export type CorrectionInput = { factId: string; value: string; reason?: string; now?: Date; id?: string };

function entryId(stub: Stub, now: Date): string {
  return `c${(stub.corrections?.length ?? 0) + 1}-${now.getTime().toString(36)}`;
}

/** Fold a value into the fields the stub prints from, so the stub shows what the person said. */
function withValue(stub: Stub, f: Fact, value: string, label: string, confidence: number, kept: boolean | undefined): Stub {
  const ev = stub.event;
  const next: Fact = { ...f, value, label, confidence, kept };
  const target = resolveFact(ev.facts, factKey(f)) ?? resolveFact(ev.facts, f.id);
  const facts = target ? ev.facts.map(x => x === target ? next : x) : [...ev.facts, next];
  const event = { ...ev, facts };
  if (f.id === "date") {
    if (isIsoDate(value)) event.dateISO = value;
    else delete event.dateISO;
  }
  if (f.id === "venue") event.venue = value;
  if (f.id === "title") event.title = value;
  return { ...stub, event };
}

function labelFor(factId: string, value: string): string {
  return factId === "date" && isIsoDate(value) ? monthDay(value) : value;
}

/**
 * Record the person's answer for a fact. A different value is a correction; the same value is a confirmation. Either way the
 * research result is kept in the entry. Returns the stub unchanged for an empty value or an impossible ISO date.
 */
export function applyCorrection(stub: Stub, input: CorrectionInput): Stub {
  const value = input.value.trim();
  if (!value) return stub;
  // A date answer shaped like YYYY-MM-DD but not on the calendar (2026-02-31) is refused: no fact, event or history change.

  const now = input.now ?? new Date();
  const existing = resolveFact(stub.event.facts, input.factId);
  if (!existing && (!["title", "date", "venue"].includes(input.factId) || stub.event.facts.some(f => f.id === input.factId))) return stub;
  const sourceId = existing?.id ?? input.factId;
  if (sourceId === "date" && ISO_DATE.test(value) && !isIsoDate(value)) return stub;
  // Older drafts can carry a printed date or venue without a fact row. Preserve that
  // current value for undo without inventing a source or marking it verified.
  const originalValue = input.factId === "date" ? (stub.event.dateISO ?? "") : input.factId === "venue" ? (stub.event.venue ?? "") : "";
  const base: Fact = uniqueFacts([existing ??
    (input.factId === "title"
      ? { id: "title", label: stub.event.title, value: stub.event.title, source: "your ticket", confidence: 0, provenance: "pending" }
      : { id: input.factId, label: originalValue ? labelFor(input.factId, originalValue) : input.factId, value: originalValue, source: originalValue ? "current stub" : "not found", confidence: 0, provenance: "pending" })])[0];
  const label = labelFor(sourceId, value);
  const entry: Correction = {
    id: input.id ?? entryId(stub, now),
    factId: base.id,
    clientEntityKey: base.clientEntityKey,
    kind: value === base.value && !isMissingValue(base) ? "confirm" : "correct",
    original: { value: base.value, label: base.label, source: base.source, provenance: base.provenance, confidence: base.confidence, kept: base.kept },
    corrected: { value, label },
    by: "you",
    at: now.toISOString(),
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  };
  return { ...withValue(stub, base, value, label, 1, true), corrections: [...(stub.corrections ?? []), entry] };
}

/** Undo the entry currently deciding a fact by adding a new entry that restores the value before it. Nothing is rewritten. */
export function undoCorrection(stub: Stub, factId: string, now = new Date()): Stub {
  const active = activeCorrection(stub, factId);
  const f = resolveFact(stub.event.facts, factId);
  if (!active || !f) return stub;
  const back = active.original;
  const entry: Correction = {
    id: entryId(stub, now),
    factId: f.id,
    clientEntityKey: f.clientEntityKey,
    kind: "undo",
    original: { ...active.original, value: active.corrected.value, label: active.corrected.label },
    corrected: { value: back.value, label: back.label },
    by: "you",
    at: now.toISOString(),
    undoes: active.id,
  };
  const restored = { ...stub, corrections: [...(stub.corrections ?? []), entry] };
  // Back to what the research said, unless an earlier correction of yours still stands.
  const still = activeCorrection(restored, factId);
  const first = entries(stub, factId)[0];
  return withValue(restored, f, back.value, back.label, still ? 1 : (first?.original.confidence ?? back.confidence), still ? true : first?.original.kept);
}

/** Whether recording this answer would change what is printed on the stub (shown as "This changes the printed stub"). */
export function changesPrintedStub(stub: Stub, factId: string, value: string): boolean {
  const f = resolveFact(stub.event.facts, factId);
  const v = value.trim();
  if (factId === "title") return !!v && v !== stub.event.title;
  if (!f) return !!v && (REQUIRED_FACTS as readonly string[]).includes(factId);
  return isPrinted(f) && !!v && v !== f.value;
}

/** Assets we must not treat as allowed. Anything without an explicit "allowed" from a source reads as unknown. */
export function reviewAssets(stub: Stub): ReviewAsset[] {
  return (stub.event.assets ?? []).map((a) => (a.status === "allowed" ? a : { ...a, status: a.status === "blocked" ? ("blocked" as const) : ("unknown" as const) }));
}

export const ASSET_WORDS: Record<ReviewAsset["status"], string> = {
  allowed: "Allowed",
  blocked: "Blocked",
  unknown: "Not confirmed",
};

export function assetExplanation(a: ReviewAsset): string {
  if (a.reason) return a.reason;
  return a.status === "blocked"
    ? "The page says we can't reuse this image, so it stays off your stub."
    : "We can't confirm we have the right to use this image, so it stays off your stub. Your own photo is always fine.";
}

/** Derived only: immutable legacy history is never rewritten to invent its target. */
export function unresolvedHistory(stub: Stub): boolean {
  return !!stub.corrections?.some(c => {
    const target = resolveFact(stub.event.facts, c.clientEntityKey ?? c.factId);
    return c.unresolvedIdentity || !target || target.id !== c.factId;
  });
}

export const questionKey = (q: Question): string => q.clientEntityKey ?? q.factId;
