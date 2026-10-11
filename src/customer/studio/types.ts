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

/** DesignVersion: art changes only. Type, chips and material are personalization on the same version. */
export interface DesignVersion {
  id: string;
  parentId?: string;
  edition: Edition;
  art: ArtLayer;
  createdAt: string;
}

export interface Personalization {
  titleFont: 0 | 1 | 2 | 3; // index into the edition's font pairs
  titleColor: string;
  foilTitle: boolean;
  hiddenFields: string[];
  note?: string;
  friends: { name: string; seat?: string; claimed: boolean }[];
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
  photos: string[]; // data urls (local only)
  setId?: string; // matching set / claim set
}

export function currentVersion(s: Stub): DesignVersion {
  return s.versions.find((v) => v.id === s.currentVersionId) ?? s.versions[0];
}

export function formatMoney(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 0 }).format(minor / 100);
}
