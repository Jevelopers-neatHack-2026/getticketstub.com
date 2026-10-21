import type { EventData, Fact } from "../types";

export const MANUAL_LIMITS = { title: 200, venue: 200, city: 100 } as const;
export interface ManualDetails { title: string; dateISO: string; venue: string; city: string }

/** Shared client/server validation. No date rollover or silently truncated customer input. */
export function readManualDetails(value: unknown): ManualDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["title", "dateISO", "venue", "city"].includes(k))) return;
  const out = { title: "", dateISO: "", venue: "", city: "" };
  for (const key of ["title", "venue", "city"] as const) {
    const text = v[key] ?? "";
    if (typeof text !== "string" || text.length > MANUAL_LIMITS[key] || /[\x00-\x1f\x7f]/.test(text)) return;
    out[key] = text.trim();
  }
  if (!out.title || typeof v.dateISO !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(v.dateISO)) return;
  const date = new Date(`${v.dateISO}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== v.dateISO) return;
  out.dateISO = v.dateISO;
  return out;
}

export function eventFromManual(details: ManualDetails, sourceUrl?: string): EventData {
  const fact = (id: string, value: string): Fact => ({ id, label: value, value, source: "Entered by you", provenance: "customer", confidence: 1, kept: id === "date" });
  return {
    type: "generic", title: details.title, dateISO: details.dateISO,
    ...(details.venue ? { venue: details.venue } : {}), ...(details.city ? { city: details.city } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    facts: [fact("date", details.dateISO), ...(details.venue ? [fact("venue", details.venue)] : []), ...(details.city ? [fact("city", details.city)] : [])],
  };
}
