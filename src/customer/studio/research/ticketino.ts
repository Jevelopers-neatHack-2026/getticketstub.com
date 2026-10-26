import type { EventData, EventType, Fact } from "../types";
import { decodeHtmlEntities } from "./jsonLd";

type Language = "de" | "en" | "fr" | "it";
export interface TicketinoEventLink {
  kind: "event";
  id: string;
  /** Stable identity across language and slug changes; never invent a fetch URL from it. */
  canonicalId: string;
  language: Language;
  /** The public, real event path with tracking data removed. */
  url: string;
}

/** Only the two verified .com hosts and single-event paths are supported. */
export function parseTicketinoUrl(input: string | URL): TicketinoEventLink | { kind: "not_event" } | undefined {
  let url: URL;
  try { url = input instanceof URL ? input : new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`); } catch { return undefined; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !["ticketino.com", "www.ticketino.com"].includes(url.hostname.toLowerCase())) return undefined;
  const match = /^\/(de|en|fr|it)\/Event\/([^/]+)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (!match || /%(?:2f|5c|00)/i.test(match[2])) return { kind: "not_event" };
  return { kind: "event", id: match[3], canonicalId: `ticketino:event:${match[3]}`, language: match[1] as Language, url: `https://www.ticketino.com${url.pathname.replace(/\/$/, "")}` };
}

type Json = Record<string, unknown>;
const str = (value: unknown) => typeof value === "string" && value.trim() ? decodeHtmlEntities(value) : undefined;
function localDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.test(value)) return undefined;
  const date = value.slice(0, 10);
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
}
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** A dated, single schema event is required: catalogues and shells never use title fallback. */
export function ticketinoEvent(nodes: Json[], link: TicketinoEventLink): EventData | undefined {
  if (nodes.length !== 1) return undefined;
  const node = nodes[0];
  const title = str(node.name), dateISO = localDate(node.startDate);
  if (!title || !dateISO) return undefined;
  // A page declaring another event's identity must not be attached to the submitted event.
  for (const identity of [node.url, node["@id"]]) {
    if (identity === undefined) continue;
    if (typeof identity !== "string") return undefined;
    let declared: URL;
    try { declared = new URL(identity, link.url); } catch { return undefined; }
    const parsed = parseTicketinoUrl(declared);
    if (!parsed || parsed.kind !== "event" || parsed.id !== link.id) return undefined;
  }
  // Several venues need a performance/location choice, not a guessed first item.
  if (Array.isArray(node.location) && node.location.length > 1) return undefined;
  const location = Array.isArray(node.location) ? node.location[0] : node.location;
  const place = location && typeof location === "object" ? location as Json : undefined;
  const venue = str(typeof location === "string" ? location : place?.name);
  const address = place?.address && typeof place.address === "object" ? place.address as Json : undefined;
  const city = str(address?.addressLocality);
  const country = str(typeof address?.addressCountry === "object" && address.addressCountry ? (address.addressCountry as Json).name : address?.addressCountry);
  const end = localDate(node.endDate);
  const fact = (id: string, label: string, value = label): Fact => ({ id, label, value, source: "TICKETINO", sourceUrl: link.url, confidence: 0.9, provenance: "live" });
  const facts: Fact[] = [{ ...fact("date", shortDate(dateISO), dateISO), kept: true }];
  if (end && end > dateISO) facts.push(fact("date_range", `${shortDate(dateISO)} – ${shortDate(end)}`, `${dateISO} – ${end}`));
  if (venue) facts.push(fact("venue", venue));
  if (city) facts.push(fact("city", city));
  if (country) facts.push(fact("country", country));
  const types = (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]).map((type) => typeof type === "string" ? type.replace(/^https?:\/\/schema\.org\//, "") : type);
  const type: EventType = types.includes("MusicEvent") || types.includes("Festival") ? "concert" : types.includes("SportsEvent") ? "game" : types.some((t) => ["TheaterEvent", "ComedyEvent", "DanceEvent"].includes(String(t))) ? "show" : "generic";
  return { type, title, venue, city, dateISO, sourceUrl: link.url, facts };
}
