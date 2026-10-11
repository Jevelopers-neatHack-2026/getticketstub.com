"use client";
// Organizer mode: a locked design that attendees claim within, plus a client-side CSV guest list parser.
import { NEATHACK, newStub } from "@/customer/studio/fixtures";
import type { Edition, EventData, Stub } from "@/customer/studio/types";
import { flow } from "@/customer/flows/events";

export interface OrganizerDesign {
  v: 1;
  setId: string;
  organizer: string;
  title: string;
  edition: Edition;
  allowed: [Edition, Edition]; // attendees may switch between these two only
  locks: { logo: boolean; title: boolean };
}

export function defaultDesign(): OrganizerDesign {
  return {
    v: 1,
    setId: `org-${Math.random().toString(36).slice(2, 8)}`,
    organizer: "",
    title: NEATHACK.title,
    edition: "researched",
    allowed: ["researched", "minimal"],
    locks: { logo: true, title: true },
  };
}

export function designEvent(d: OrganizerDesign): EventData {
  return { ...NEATHACK, title: d.title || NEATHACK.title, subtitle: d.organizer ? `Hosted by ${d.organizer}` : NEATHACK.subtitle };
}

/** A stub for one attendee (or the organizer preview). */
export function designStub(d: OrganizerDesign, opts: { id?: string; name?: string; seat?: string; edition?: Edition } = {}): Stub {
  const ev = designEvent(d);
  const st = newStub(opts.seat ? { ...ev, seat: opts.seat } : ev, opts.id);
  st.versions = st.versions.map((v) => ({ ...v, edition: opts.edition ?? d.edition }));
  st.setId = d.setId;
  st.wallAngle = 0;
  if (opts.name) st.personal = { ...st.personal, friends: [{ name: opts.name, seat: opts.seat, claimed: true }] };
  return st;
}

function toB64Url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64Url(s: string): string {
  return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
}

export function encodeDesign(d: OrganizerDesign): string {
  return toB64Url(JSON.stringify(d));
}
export function decodeDesign(token: string | undefined): OrganizerDesign | null {
  if (!token) return null;
  try {
    const d = JSON.parse(fromB64Url(token)) as OrganizerDesign;
    return d && d.v === 1 && Array.isArray(d.allowed) ? d : null;
  } catch {
    return null;
  }
}

/* CSV */

export interface GuestList {
  headers: string[];
  rows: string[][];
}
export interface ColumnMap {
  name: number;
  seat: number;
  extra: number; // -1 when none
}

/** Simple CSV: one row per line, comma separated, double quotes allowed around a cell. */
export function parseCsv(text: string): GuestList {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const [head = [], ...rows] = lines.map(split);
  return { headers: head, rows: rows.filter((r) => r.some((c) => c)) };
}

const NAME_KEYS = ["name", "full_name", "fullname", "full name", "attendee", "guest"];
const SEAT_KEYS = ["seat", "bib", "seat_number", "table", "badge"];

export function autoMatch(headers: string[]): ColumnMap {
  const norm = headers.map((h) => h.toLowerCase().trim());
  const find = (keys: string[]) => norm.findIndex((h) => keys.includes(h));
  const name = Math.max(0, find(NAME_KEYS));
  const seat = find(SEAT_KEYS);
  const extra = norm.findIndex((_, i) => i !== name && i !== seat);
  return { name, seat, extra };
}

export const SAMPLE_CSV = `full_name,seat,team
Priya Raman,A12,Jevelopers
Tomás Ortega,A13,Jevelopers
Mei Chen,B04,Night Owls
Kwame Mensah,B05,Night Owls
Sofia Lindqvist,C01,Paperclip
Arjun Mehta,C02,Paperclip`;

/** What a parsed guest list amounts to, as counts only: never a header, a cell, a name or the file's name. */
export function csvSummary(list: GuestList): { result: "parsed" | "empty" | "no_rows"; row_count: number; column_count: number } {
  const column_count = Math.min(100, list.headers.length);
  const row_count = Math.min(1000, list.rows.length);
  if (list.headers.length === 0) return { result: "empty", row_count, column_count };
  if (list.rows.length === 0) return { result: "no_rows", row_count, column_count };
  return { result: "parsed", row_count, column_count };
}

/** Guests a mapping yields (rows with a name), and rows it drops for having none. */
export function mappedCounts(list: GuestList, nameColumn: number): { row_count: number; missing_name_count: number } {
  const named = list.rows.filter((r) => (r[nameColumn] ?? "").trim()).length;
  return { row_count: Math.min(1000, list.rows.length), missing_name_count: Math.min(1000, list.rows.length - named) };
}

/** The wizard's steps, in order, as the analytics catalog names them. */
export const ORGANIZER_STEPS = ["design", "guests", "check", "publish"] as const;

/**
 * Report the step the wizard settles on when it opens: Design, or Publish when a draft came back from sign-in. Once per
 * mount: `seen` is the component's ref, which survives Strict Mode's second effect run (and that second run no longer
 * finds the draft, so without the guard it would wrongly add a Design step).
 */
export function reportOpeningStep(seen: { current: boolean }, restored: boolean): void {
  if (seen.current) return;
  seen.current = true;
  flow("organizer_step", restored ? { step: "publish", via: "restore" } : { step: "design", via: "open" });
}

/** Report a move between steps (Back, Next, the step list). Moving to the step already shown is not a move. */
export function reportStepMove(from: number, to: number): void {
  if (from === to || !ORGANIZER_STEPS[to]) return;
  flow("organizer_step", { step: ORGANIZER_STEPS[to], via: "nav" });
}
