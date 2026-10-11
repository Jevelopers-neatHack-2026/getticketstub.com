// Shared by the start section and /new: what a typed value means, and how a researched event becomes
// a stub on the wall without ever making a second copy of the same night.
import { DEMO_EVENTS, demoStubId, newStub, type DemoKey } from "@/customer/studio/fixtures";
import { getStub, loadWall, upsertStub } from "@/customer/studio/store";
import type { EventData, Stub } from "@/customer/studio/types";

export type PrintInput = { url?: string; query?: string; event?: EventData };

export const DEMO_TAGS: { key: DemoKey; label: string }[] = [
  { key: "neathack", label: "neatHack 2026" },
  { key: "pale", label: "The Pale Hours" },
  { key: "harbour", label: "Harbour FC" },
];

export function isDemoKey(key: string | null | undefined): key is DemoKey {
  return !!key && Object.prototype.hasOwnProperty.call(DEMO_EVENTS, key);
}

export function looksLikeLink(text: string): boolean {
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(text);
}

/** A pasted link researches the page; anything else searches for the show. */
export function inputFromText(text: string): PrintInput {
  const v = text.trim();
  if (looksLikeLink(v)) return { url: /^https?:\/\//i.test(v) ? v : `https://${v}` };
  return { query: v };
}

export function inputFromDemo(key: DemoKey): PrintInput {
  return { event: structuredClone(DEMO_EVENTS[key]) };
}

const norm = (s?: string) => (s ?? "").trim().toLowerCase();
const sameNight = (a: EventData, b: EventData) => norm(a.title) === norm(b.title) && norm(a.dateISO) === norm(b.dateISO) && norm(a.venue) === norm(b.venue);

/** The stub already on the wall for this event, if any. Read-only. */
export function existingStub(event?: EventData, id?: string): Stub | undefined {
  if (id) {
    const byId = getStub(id);
    if (byId) return byId;
  }
  return event ? loadWall().find((s) => sameNight(s.event, event)) : undefined;
}

/** What keeping a finished stub did: the id to open, whether it was a new stub, and whether it reached storage. */
export interface Kept {
  id: string;
  created: boolean;
  /** False when storage refused the write: the stub was not saved on this device. */
  stored: boolean;
}

/** Put the finished stub on the wall (or reopen the one that is there). */
export function keepStubResult(event: EventData, id: string): Kept {
  const found = existingStub(event, id);
  if (found) return { id: found.id, created: false, stored: true };
  return { id, created: true, stored: upsertStub(newStub(event, id)) };
}

/** Put the finished stub on the wall (or reopen the one that is there). Returns the id to open. */
export function keepStub(event: EventData, id: string): string {
  return keepStubResult(event, id).id;
}

/** Where a print's input came from, in the analytics catalog's words. */
export function inputSource(input: PrintInput, picked = false): "link" | "query" | "demo" | "picked" {
  if (input.event) return picked ? "picked" : "demo";
  return input.url ? "link" : "query";
}

export { demoStubId };
