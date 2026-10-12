import type { ProviderMetadata } from "@/server/ai/providers";

// Studio domain types. Field names follow the shared-contracts catalog where one exists
// (EventIntelligencePackage facts, DesignVersion, FulfillmentQuote); studio-only fields are marked.

/** How a value was obtained. Every claim the demo shows carries one (acceptance item EVAL-03). */
export type BillingMode = "live" | "sandbox" | "simulated";
export type Provenance = "live" | "sandbox" | "simulated" | "estimated" | "pending";

export type EventType = "concert" | "game" | "show" | "generic";

/** One researched fact (EventIntelligencePackage.facts[]). Unknown facts stay visible (AGT-01). */
export interface Fact {
  id: string;
  label: string; // short, printed on the stub, e.g. "Night 2 of 3"
  value: string;
  source: string; // e.g. "setlist.fm", "Open-Meteo", "event page (schema.org)"
  sourceUrl?: string;
  confidence: number; // 0..1; under 0.8 renders as a pulsing chip
  alternatives?: string[]; // top guesses for an unsure fact
  provenance: Provenance;
  kept?: boolean; // studio-only: user tapped "Keep on stub"
  retrievedAt?: string; // ISO time the source was read, when known (live research only)
}

/** A permission-sensitive asset found while researching (an image on a page whose rights we can't confirm). Never "allowed" unless a source says so. */
export interface ReviewAsset {
  id: string;
  label: string;
  sourceUrl?: string;
  status: "allowed" | "blocked" | "unknown";
  reason?: string; // plain-language explanation shown to the person
}

/** One entry in a stub's correction history. Entries are never edited or removed; an undo is a new entry (GT-05). */
export interface Correction {
  id: string;
  factId: string;
  kind: "correct" | "confirm" | "undo";
  /** The fact as it was before this entry. */
  original: { value: string; label: string; source: string; provenance: Provenance; confidence: number; kept?: boolean };
  /** The fact after this entry. */
  corrected: { value: string; label: string };
  by: "you";
  at: string; // ISO
  reason?: string;
  undoes?: string; // id of the entry an undo reverses
}

export interface GameMoment {
  minute: string;
  text: string;
  starred?: boolean;
}

export interface EventData {
  providerMetadata?: ProviderMetadata;
  type: EventType;
  title: string; // artist, matchup, show or event name
  subtitle?: string; // tour, competition, run
  venue?: string;
  city?: string;
  dateISO?: string; // yyyy-mm-dd
  seat?: string;
  sourceUrl?: string;
  setlist?: { title: string; starred?: boolean }[];
  score?: { home: string; away: string; homeScore: number; awayScore: number; moments: GameMoment[] };
  cast?: { name: string; starred?: boolean }[];
  programme?: string[];
  facts: Fact[];
  assets?: ReviewAsset[];
}

export type Edition = "classic" | "letterpress" | "risograph" | "minimal" | "researched";
export const EDITIONS: Edition[] = ["researched", "letterpress", "risograph", "minimal", "classic"];

export type Material = "digital" | "card" | "print" | "framed";
export type Finish = "matte" | "foil" | "holo";

export const MATERIALS: { id: Material; label: string; priceMinor: number }[] = [
  { id: "digital", label: "Digital", priceMinor: 900 },
  { id: "card", label: "Card", priceMinor: 2900 },
  { id: "print", label: "Print", priceMinor: 4900 },
  { id: "framed", label: "Framed", priceMinor: 8900 },
];

/** Art layer: generated, text-free. A remix creates a new DesignVersion. */
export interface ArtLayer {
  providerMetadata?: ProviderMetadata;
  kind: "image" | "procedural";
  src?: string; // image url when kind = image
  seed: number; // deterministic procedural art / foil plate
  vibe?: string; // remix vibe chip used
  provenance: Provenance; // "live" only when a real image model produced it
}

/** The stub's settings when a version was made: lets two versions be compared in words (GT-06A). Absent on older versions. */
export interface VersionContext {
  material: Material;
  finish: Finish;
  keptFacts: string[]; // labels of the facts kept on the stub
  personal: { titleFont: number; titleColor: string; foilTitle: boolean; hiddenFields: string[]; note?: string };
}

/** DesignVersion: art changes only. Type, chips and material are personalization on the same version. */
export interface DesignVersion {
  id: string;
  parentId?: string;
  edition: Edition;
  /** SVG stub template id (public/stubs/<id>). When set it is the style drawn; `edition` stays as the fallback. */
  template?: string;
  art: ArtLayer;
  createdAt: string;
  context?: VersionContext;
}

export interface Personalization {
  titleFont: 0 | 1 | 2 | 3; // index into the edition's font pairs
  titleColor: string;
  foilTitle: boolean;
  hiddenFields: string[];
  note?: string;
  friends: { name: string; seat?: string; claimed: boolean }[];
  /** Whose stub this is, when it was issued to a named guest (organizer runs, claimed stubs). Printed "Admit · name" on the front and back. A fan's own stub has none. */
  guestName?: string;
}

export interface Stub {
  id: string;
  createdAt: string;
  event: EventData;
  versions: DesignVersion[];
  currentVersionId: string;
  personal: Personalization;
  material: Material;
  finish: Finish;
  torn: boolean; // finished and pinned to the wall
  wallAngle: number; // -4..4 degrees
  /** Where the stub is pinned on the wall canvas, in canvas px. Unset until it is first placed. */
  wallX?: number;
  wallY?: number;
  photos: string[]; // data urls (local only)
  setId?: string; // matching set / claim set
  /** Immutable history of fact corrections, oldest first. */
  corrections?: Correction[];
  /** Epoch ms of the last change. Set on every upsert; the newer one wins when a device and an account merge. */
  updatedAt?: number;
}

export function currentVersion(s: Stub): DesignVersion {
  return s.versions.find((v) => v.id === s.currentVersionId) ?? s.versions[0];
}

/** The stub issued to one named guest: the name prints on the front and back, and the seat stays on the event. */
export function withGuestName(s: Stub, name: string | undefined): Stub {
  const guestName = name?.trim() || undefined;
  return { ...s, personal: { ...s.personal, guestName, friends: [] } };
}

export function formatMoney(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 0 }).format(minor / 100);
}
