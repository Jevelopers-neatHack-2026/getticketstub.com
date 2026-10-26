import { NextResponse } from "next/server";
import { recordEvent } from "@/server/event-log";
import { errorJson, HttpError, readJson, route } from "@/server/http";
import { generateText, ProviderError, providerFailure } from "@/server/ai/providers";
import { HARBOUR_GAME, NEATHACK, PALE_HOURS } from "@/customer/studio/fixtures";
import type { EventData, EventType, Fact } from "@/customer/studio/types";
import { uniqueFacts } from "@/customer/studio/facts/identity";
import { lookupTicketmaster, parseTicketmasterUrl, type TicketmasterUrl, type TmLookupMiss, type TmLookupOk } from "@/customer/studio/research/ticketmaster";
import { buildEventIntelligencePackage } from "@/customer/studio/research/ticketmasterPackage";
import { BlockedDestinationError, fetchPublic, INTAKE_LIMITS, parseIntakeUrl, readCapped, UNSUPPORTED_FIELDS, type IntakeRejection } from "@/server/intake-url";
import { annotate, fetchFailure, observeRoute, providerObserver, recordParse, sourceTimer, type SourceName, type SourceOutcome } from "@/server/observability/measure";
import { AccessRestrictedError, isAccessChallenge, isRestrictedEvent, manualFallback, providerForUrl, providerLabel } from "@/customer/studio/research/access";
import { eventFromManual, readManualDetails } from "@/customer/studio/research/manual";
import { supportsEnrichedFact } from "@/customer/studio/research/factEvidence";

// Research an event from a link. Real page fetch + schema.org parse + Open-Meteo weather.
// Every fact carries source + provenance: "live" only for values fetched in this request,
// "simulated" for fixtures, "pending" for unknowns (EVAL-03 / AGT-01).
// Provenance describes retrieval; it is not a guarantee of correctness. Model-only
// interpretations remain estimated unless a conservative literal extraction supports them.

const UA = "TicketStubResearch/0.1 (+https://getticketstub.com; event research for personal keepsakes)";
const READ_ERROR = "We couldn't read that link.";

type Json = Record<string, unknown>;

// ---------- Fixtures (demo keywords + search fallback) ----------

const FIXTURES: { keys: string[]; event: EventData }[] = [
  { keys: ["neathack", "neat hack"], event: NEATHACK },
  { keys: ["pale hours", "palehours", "rosewood"], event: PALE_HOURS },
  { keys: ["harbour", "northgate", "kelvin park"], event: HARBOUR_GAME },
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // malformed %-escapes must not throw out of the handler
  }
};
const norm = (s: string) => safeDecode(s).toLowerCase().replace(/[-_+.\/]+/g, " ");

function matchFixture(input: string): EventData | undefined {
  const n = norm(input);
  return FIXTURES.find((f) => f.keys.some((k) => n.includes(k)))?.event;
}

/** Search fallback: fixtures only, labelled simulated (pending stays pending). */
function searchFixtures(query: string): EventData[] {
  const terms = norm(query).split(/\s+/).filter((t) => t.length > 1);
  const scored = FIXTURES.map((f) => {
    const hay = norm([f.event.title, f.event.subtitle, f.event.venue, f.event.city, f.event.dateISO, f.event.type, ...f.keys].filter(Boolean).join(" "));
    const score = terms.length === 0 ? 1 : terms.filter((t) => hay.includes(t)).length;
    return { f, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return scored.map(({ f }) => {
    const e = clone(f.event);
    e.facts = e.facts.map((fact) => ({
      ...fact,
      provenance: fact.provenance === "pending" ? "pending" : "simulated",
      source: fact.source.includes("(demo)") ? fact.source : `${fact.source} (demo)`,
    }));
    return e;
  });
}

// ---------- Page fetch + parse ----------

async function fetchPage(url: string): Promise<string> {
  // Event sites sometimes reset a connection or return a transient 5xx. Retry once so a brief
  // upstream wobble does not turn into an unreadable-link response; timeouts and 4xx stay final.
  for (let attempt = 0; attempt < 2; attempt++) {
    const done = sourceTimer("event_page");
    let res: Response;
    try {
      // The only page fetch for user links: each hop is checked and the socket is pinned to a validated address.
      res = await fetchPublic(url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
    } catch (error) {
      const outcome = fetchFailure(error);
      done(outcome);
      if (error instanceof BlockedDestinationError) throw error; // a refused destination is never retried
      if (attempt === 0 && outcome === "network_error") continue;
      throw error;
    }
    if (isAccessChallenge(res.status, res.headers)) {
      done("access_restricted", res.status);
      await res.body?.cancel().catch(() => {});
      throw new AccessRestrictedError();
    }
    if (res.status >= 500) {
      done("http_error", res.status);
      await res.body?.cancel().catch(() => {});
      if (attempt === 0) continue;
      throw new Error(`HTTP ${res.status}`);
    }
    let text: string;
    try {
      text = await readCapped(res, INTAKE_LIMITS.pageBytes);
    } catch (error) {
      done(fetchFailure(error));
      if (attempt === 0 && fetchFailure(error) === "network_error") continue;
      throw error;
    }
    if (isAccessChallenge(res.status, res.headers, text)) {
      done("access_restricted", res.status);
      throw new AccessRestrictedError();
    }
    if (!res.ok) {
      done("http_error", res.status);
      throw new Error(`HTTP ${res.status}`);
    }
    done("ok", res.status);
    return text;
  }
  throw new Error("Event page request did not complete.");
}

/** Fetches a source API response as JSON, measuring how the fetch ended. Undefined when it was not usable. */
async function fetchSourceJson<T>(source: SourceName, url: string): Promise<T | undefined> {
  const done = sourceTimer(source);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!res.ok) {
      done(res.status === 429 ? "rate_limited" : res.status === 401 || res.status === 403 ? "auth_failed" : "http_error", res.status);
      return undefined;
    }
    const data = (await res.json().catch(() => undefined)) as T | undefined;
    done(data === undefined ? "bad_response" : "ok", res.status);
    return data;
  } catch (error) {
    done(fetchFailure(error));
    throw error;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .trim();
}

function metaContent(html: string, key: string): string | undefined {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i");
  const m = html.match(re1) ?? html.match(re2);
  return m?.[1] ? decodeEntities(m[1]) : undefined;
}

function titleTag(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? decodeEntities(m[1].replace(/\s+/g, " ")) : undefined;
}

function pageText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).slice(0, 8000);
}

const EVENT_TYPES = /(^|:)(Event|MusicEvent|SportsEvent|TheaterEvent|ComedyEvent|DanceEvent|Festival|ExhibitionEvent|SocialEvent|EducationEvent|BusinessEvent)$/;

function typesOf(node: Json): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
}

function collectNodes(v: unknown, out: Json[]): void {
  if (Array.isArray(v)) v.forEach((x) => collectNodes(x, out));
  else if (v && typeof v === "object") {
    const o = v as Json;
    out.push(o);
    if (o["@graph"]) collectNodes(o["@graph"], out);
    if (o.subEvent) collectNodes(o.subEvent, out);
  }
}

function findJsonLdEvent(html: string): Json | undefined {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const nodes: Json[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      collectNodes(JSON.parse(m[1].trim()), nodes);
    } catch {
      /* malformed block: skip */
    }
  }
  return nodes.find((n) => typesOf(n).some((t) => EVENT_TYPES.test(t)));
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? decodeEntities(v) : undefined);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

function names(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.map((x) => (typeof x === "string" ? x : str((x as Json)?.name))).filter((x): x is string => !!x);
}

function inferType(schemaTypes: string[], text: string): EventType {
  if (schemaTypes.some((t) => /MusicEvent|Festival/.test(t))) return "concert";
  if (schemaTypes.some((t) => /SportsEvent/.test(t))) return "game";
  if (schemaTypes.some((t) => /TheaterEvent|ComedyEvent|DanceEvent/.test(t))) return "show";
  const t = text.toLowerCase();
  if (/\b(vs\.?|v\.?)\s|\bmatch\b|\bfixture\b|\bkick[- ]?off\b|\bfc\b|\bleague\b|\bstadium\b/.test(t)) return "game";
  if (/\bconcert\b|\btour\b|\bgig\b|\blive at\b|\bsetlist\b|\bband\b|\bdj\b/.test(t)) return "concert";
  if (/\btheatre\b|\btheater\b|\bmusical\b|\bplay\b|\bballet\b|\bopera\b|\bcomedy\b/.test(t)) return "show";
  return "generic";
}

function shiftDay(iso: string, d: number): string {
  const dt = new Date(`${iso}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function guessDateFromText(text: string): string | undefined {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/i) ?? null;
  const m2 = m ? null : text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i);
  const parts = m ? { d: m[1], mo: m[2], y: m[3] } : m2 ? { d: m2[2], mo: m2[1], y: m2[3] } : undefined;
  if (!parts) return undefined;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mi = months.indexOf(parts.mo.slice(0, 3).toLowerCase());
  if (mi < 0) return undefined;
  return `${parts.y}-${String(mi + 1).padStart(2, "0")}-${String(Number(parts.d)).padStart(2, "0")}`;
}

interface Extracted {
  parser: "schema_org" | "title";
  event: EventData;
  text: string;
  dateConfidence: number;
}

function extract(html: string, url: string): Extracted | undefined {
  const text = pageText(html);
  const node = findJsonLdEvent(html);
  const facts: Fact[] = [];

  if (node) {
    const src = "event page (schema.org)";
    const name = str(node.name);
    const loc = first(node.location) as Json | string | undefined;
    const locObj = typeof loc === "object" && loc ? loc : undefined;
    const venue = typeof loc === "string" ? str(loc) : str(locObj?.name);
    const addr = locObj?.address;
    const city = typeof addr === "string" ? str(addr.split(",").slice(-2, -1)[0] ?? addr) : str((addr as Json | undefined)?.addressLocality);
    const start = str(node.startDate);
    const dateISO = start && /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : undefined;
    const performers = names(node.performer);
    const schemaTypes = typesOf(node);
    const type = inferType(schemaTypes, `${name ?? ""} ${str(node.description) ?? ""} ${(Array.isArray(node.keywords) ? node.keywords.join(" ") : str(node.keywords)) ?? ""}`);
    if (!name) return undefined;

    if (dateISO) facts.push({ id: "date", label: shortDate(dateISO), value: dateISO, source: src, sourceUrl: url, confidence: 0.9, provenance: "live", kept: true });
    if (venue) facts.push({ id: "venue", label: venue, value: venue, source: src, sourceUrl: url, confidence: 0.9, provenance: "live" });
    if (performers.length && !(performers.length === 1 && performers[0] === name)) {
      facts.push({ id: "lineup", label: performers.slice(0, 3).join(" · "), value: performers.join(", "), source: src, sourceUrl: url, confidence: 0.9, provenance: "live" });
    }
    const superEvent = str((first(node.superEvent) as Json | undefined)?.name);
    return {
      parser: "schema_org",
      event: { type, title: performers[0] && type === "concert" ? performers[0] : name, subtitle: superEvent ?? (performers[0] && type === "concert" && performers[0] !== name ? name : undefined), venue, city, dateISO, sourceUrl: url, facts },
      text,
      dateConfidence: dateISO ? 0.9 : 0,
    };
  }

  // Title-only fallback
  const title = metaContent(html, "og:title") ?? titleTag(html);
  if (!title) return undefined;
  const desc = metaContent(html, "og:description") ?? metaContent(html, "description") ?? "";
  const src = "event page (title)";
  const cleanTitle = title.split(/\s[|–—-]\s/)[0].trim() || title;
  const dateISO = guessDateFromText(`${title} ${desc}`) ?? guessDateFromText(text.slice(0, 3000));
  if (dateISO) {
    facts.push({ id: "date", label: shortDate(dateISO), value: dateISO, source: src, sourceUrl: url, confidence: 0.5, alternatives: [dateISO, shiftDay(dateISO, -1), shiftDay(dateISO, 1)], provenance: "live" });
  }
  return {
    parser: "title",
    event: { type: inferType([], `${title} ${desc}`), title: cleanTitle, subtitle: undefined, sourceUrl: url, dateISO, facts },
    text,
    dateConfidence: dateISO ? 0.5 : 0,
  };
}

// ---------- Weather (Open-Meteo) ----------

// The API Standard subscription (#48) covers forecast and geocoding only; the Historical Weather API needs the
// Professional plan. So a date must sit inside the forecast API's own window (past_days <= 92, forecast_days <= 16).
const WEATHER_PAST_DAYS = 92;
const WEATHER_AHEAD_DAYS = 15;
// CC BY 4.0 wants a link next to the data (https://open-meteo.com/en/licence); place names are GeoNames data.
const OPEN_METEO_CREDIT = { source: "Open-Meteo.com · place: GeoNames", sourceUrl: "https://open-meteo.com/" };

/** With OPEN_METEO_API_KEY: the customer endpoint. Without it: the free tier, for evaluation only. The key goes only into this outbound URL. */
function openMeteoUrl(host: "api" | "geocoding-api", path: string, params: Record<string, string>): string {
  const key = process.env.OPEN_METEO_API_KEY?.trim();
  const query = new URLSearchParams(key ? { ...params, apikey: key } : params);
  return `https://${key ? "customer-" : ""}${host}.open-meteo.com${path}?${query}`;
}

async function weatherFact(city: string, dateISO: string, dateConfidence: number): Promise<Fact | undefined> {
  const today = new Date().toISOString().slice(0, 10);
  const daysFromToday = Math.round((Date.parse(`${dateISO}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (daysFromToday > WEATHER_AHEAD_DAYS) {
    sourceTimer("weather_forecast")("pending");
    return { id: "weather", label: "Weather: pending", value: "Forecast opens 16 days before the date", source: "Open-Meteo", confidence: 0.3, provenance: "pending" };
  }
  if (daysFromToday < -WEATHER_PAST_DAYS) {
    sourceTimer("weather_forecast")("skipped"); // historical weather is not in the subscription
    return { id: "weather", label: "Weather: pending", value: "Past weather is not available this far back", source: "Open-Meteo", confidence: 0.2, provenance: "pending" };
  }

  const geoUrl = openMeteoUrl("geocoding-api", "/v1/search", { name: city, count: "1", language: "en", format: "json" });
  const g = await fetchSourceJson<{ results?: { latitude: number; longitude: number; name: string }[] }>("weather_geocode", geoUrl);
  if (!g) return undefined;
  const place = g.results?.[0];
  if (!place) {
    sourceTimer("weather_forecast")("skipped"); // the geocoder knew no such place
    return undefined;
  }

  const wUrl = openMeteoUrl("api", "/v1/forecast", {
    latitude: String(place.latitude), longitude: String(place.longitude), start_date: dateISO, end_date: dateISO,
    daily: "temperature_2m_max,precipitation_sum", timezone: "auto",
  });
  const w = await fetchSourceJson<{ daily?: { temperature_2m_max?: (number | null)[]; precipitation_sum?: (number | null)[] } }>("weather_forecast", wUrl);
  if (!w) return undefined;
  const t = w.daily?.temperature_2m_max?.[0];
  const p = w.daily?.precipitation_sum?.[0];
  if (t == null) return undefined; // inside the window, but the forecast API keeps no values for that day
  const wet = (p ?? 0) >= 0.5;
  const forecast = daysFromToday > 0;
  return {
    id: "weather",
    // The label rounds and summarises; the value keeps the API's own figures.
    label: `${Math.round(t)}°C · ${wet ? "rain" : "dry"}`,
    value: `${t}°C max, ${p ?? 0} mm ${wet ? "rain" : "precipitation"} in ${place.name}${forecast ? " (forecast)" : ""}`,
    ...OPEN_METEO_CREDIT,
    confidence: Math.min(forecast ? 0.75 : 0.9, dateConfidence >= 0.8 ? 1 : 0.6),
    provenance: "live",
    kept: dateConfidence >= 0.8 && !forecast,
  };
}

// ---------- Optional grounded LLM enrichment (one selected provider call) ----------

async function llmFacts(event: EventData, text: string, url: string, signal: AbortSignal): Promise<Fact[]> {
  try {
    const prompt = `You extract facts about one event from a web page for a printed keepsake stub.
Event: ${event.title}${event.dateISO ? ` on ${event.dateISO}` : ""}${event.venue ? ` at ${event.venue}` : ""}.
Return ONLY a JSON array (max 4 items) of objects {"id": "opener"|"tour"|"run"|"other", "label": short stub text (max 28 chars), "value": string, "evidence": exact short quote from the page, "confidence": 0..1}.
Only include facts stated on the page. If nothing is stated, return [].
Prefer verbatim field/value statements (for example "Opener: Example Band"); preserve uncertainty and do not infer a role from an unrelated mention.

PAGE TEXT:
${text.slice(0, 6000)}`;
    const result = await generateText({ capability: "research", prompt, maxTokens: 600, signal, observe: providerObserver() });
    if (!result) return [];
    event.providerMetadata = result.metadata;
    const out = result.value;
    const json = out.match(/\[[\s\S]*\]/)?.[0];
    if (!json) throw new ProviderError("invalid_provider_response");
    const items = JSON.parse(json) as { id?: string; label?: string; value?: string; evidence?: string; confidence?: number }[];
    if (!Array.isArray(items) || items.some((i) => !i || typeof i !== "object" || typeof i.label !== "string" || typeof i.value !== "string" || (i.evidence !== undefined && typeof i.evidence !== "string"))) throw new ProviderError("invalid_provider_response");
    return uniqueFacts(items
      .filter((i) => i.label && i.value)
      .slice(0, 4)
      .map((i) => {
        // Quote presence alone cannot support the value or the role printed on the stub.
        const grounded = supportsEnrichedFact(text, { ...i, label: i.label!, value: i.value! });
        return {
          id: i.id && ["opener", "tour", "run"].includes(i.id) ? i.id : "note",
          label: String(i.label).slice(0, 40),
          value: String(i.value),
          source: `event page (read by ${result.metadata.requestedModel})`,
          sourceUrl: url,
          confidence: Math.min(grounded ? 0.85 : 0.5, typeof i.confidence === "number" ? i.confidence : 0.6),
          provenance: grounded ? ("live" as const) : ("estimated" as const),
        };
      }), event.facts);
  } catch (error) {
    if (process.env.TICKETSTUB_RESEARCH_PROVIDER === "openrouter" || (error instanceof ProviderError && error.code === "invalid_provider_configuration")) throw error instanceof ProviderError ? error : new ProviderError("invalid_provider_response");
    annotate({ fallback: "no_enrichment", code: error instanceof ProviderError ? error.code : "invalid_provider_response" });
    return [];
  }
}

// ---------- Ticketmaster Discovery (API key only) ----------

/** Additive response field: what the Ticketmaster lookup did. "skipped" = no key, "error" = the API failed (429 included). */
type TicketmasterMeta =
  | { status: "ok"; eventId: string; matchedBy: "id" | "keyword"; retrievedAt: string; image?: TmLookupOk["image"] }
  | { status: TmLookupMiss["status"]; reason: TmLookupMiss["reason"]; message: string };

async function finishTicketmaster(tm: TmLookupOk): Promise<EventData & { ticketmaster: TicketmasterMeta }> {
  const event = tm.event;
  if (event.city && event.dateISO) {
    const f = await weatherFact(event.city, event.dateISO, tm.matchedBy === "id" ? 0.9 : 0.5).catch(() => undefined);
    if (f) event.facts.push(f);
  }
  if (!event.facts.some((f) => f.id === "weather")) {
    event.facts.push({ id: "weather", label: "Weather: pending", value: event.city && event.dateISO ? "Weather lookup unavailable" : "Needs a city and a date", source: "Open-Meteo", confidence: 0.2, provenance: "pending" });
  }
  return {
    ...event,
    ticketmaster: { status: "ok", eventId: tm.eventId, matchedBy: tm.matchedBy, retrievedAt: tm.retrievedAt, image: tm.image },
    eventIntelligencePackage: buildEventIntelligencePackage(tm),
  } as EventData & { ticketmaster: TicketmasterMeta };
}

/** Last resort for a Ticketmaster link when neither the API nor the page could be read: a title from the slug, everything else pending. */
function slugEvent(link: TicketmasterUrl): EventData | undefined {
  if (!link.keyword) return undefined;
  const title = link.keyword.replace(/(^| )[a-z]/g, (c) => c.toUpperCase());
  const pending = (id: string, label: string): Fact => ({ id, label, value: "Not known yet", source: "Ticketmaster", sourceUrl: link.url, confidence: 0.2, provenance: "pending" });
  return {
    type: "generic",
    title,
    sourceUrl: link.url,
    dateISO: undefined,
    facts: [pending("date", "Date: pending"), pending("venue", "Venue: pending"), { id: "weather", label: "Weather: pending", value: "Needs a city and a date", source: "Open-Meteo", confidence: 0.2, provenance: "pending" }],
  };
}

// ---------- Handler ----------

async function readError(req: Request, status = 422) {
  annotate({ code: "unreadable_link" });
  await recordEvent(req, "intake_rejected", { code: "unreadable_link" });
  return errorJson(status, "unreadable_link", READ_ERROR);
}

async function restricted(req: Request, url: URL) {
  const fallback = manualFallback(url);
  annotate({ code: "access_restricted", provider: fallback.provider, fallback: "manual" });
  await recordEvent(req, "intake_rejected", { code: "access_restricted", provider: fallback.provider });
  return errorJson(422, "access_restricted", `${providerLabel(fallback.provider)} doesn't let us read this page automatically. Enter the event details to make your stub.`, { fallback });
}

/** A provider failure in the one error envelope; the code and fixed message come from providerFailure. */
const providerEnvelope = (failure: NonNullable<ReturnType<typeof providerFailure>>) => {
  annotate({ code: failure.body.code, dependency: "provider" });
  return errorJson(failure.status, failure.body.code, failure.body.error);
};

/** The source outcome word for a Ticketmaster lookup that did not produce an event. */
const TM_OUTCOME: Record<TmLookupMiss["reason"], SourceOutcome> = {
  "no-api-key": "skipped",
  "rate-limited": "rate_limited",
  "bad-api-key": "auth_failed",
  "not-found": "not_found",
  timeout: "timeout",
  "api-error": "http_error",
  "bad-response": "bad_response",
};

/** A refusal before any lookup or fetch. One fixed message per class; the input is never echoed or logged. */
async function intakeRefusal(req: Request, status: number, code: string, message: string) {
  annotate({ code });
  await recordEvent(req, "intake_rejected", { code });
  return errorJson(status, code, message);
}

const URL_REFUSAL: Record<IntakeRejection, string> = {
  url_too_long: "That link is too long. Paste the event page address.",
  url_malformed: READ_ERROR,
  unsupported_scheme: "Only web links that start with http or https can be read.",
  url_credentials: "Links with a username or password in them can't be read. Paste the plain event page address.",
  unsupported_port: "That link uses a port we don't read. Paste the normal event page address.",
  blocked_destination: "That address isn't a public event page, so we can't read it.",
};

export const POST = route(observeRoute("research", async (req: Request) => {
  let body: Record<string, unknown>;
  try {
    // readJson counts real bytes, cancels the stream at the cap and never parses an oversize body.
    const parsed = await readJson(req, INTAKE_LIMITS.bodyBytes);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "bad_json", "Send a JSON body.");
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) return intakeRefusal(req, 413, "too_large", "That request is too big. Send one link or a short search.");
    annotate({ code: "bad_request" });
    await recordEvent(req, "intake_rejected", { code: "bad_request" });
    return errorJson(400, "bad_request", "Send a link or a search.");
  }

  // Uploads, extra sources and anything else we don't read are refused out loud, never accepted and ignored.
  if (UNSUPPORTED_FIELDS.some((f) => f in body)) {
    return intakeRefusal(req, 422, "unsupported_input", "Uploads and extra sources aren't supported yet. Paste one event page link instead.");
  }
  if (body.url !== undefined && typeof body.url !== "string") return intakeRefusal(req, 400, "bad_request", "Send a link or a search.");
  if (body.query !== undefined && typeof body.query !== "string") return intakeRefusal(req, 400, "bad_request", "Send a link or a search.");

  // Every provided field is validated before any branch is chosen, so a second field can't hide behind the first.
  if (typeof body.query === "string" && body.query.length > INTAKE_LIMITS.queryChars) return intakeRefusal(req, 422, "too_large", "That search is too long. Try the event name.");

  if (body.manual !== undefined) {
    const details = readManualDetails(body.manual);
    if (!details || body.query !== undefined) return intakeRefusal(req, 400, "bad_request", "Enter an event name and a valid date, with an optional venue and city.");
    const checked = body.url === undefined ? undefined : parseIntakeUrl(body.url as string);
    if (checked && !checked.ok) return intakeRefusal(req, 422, "unsupported_url", "Use a public event page link.");
    const event = eventFromManual(details, checked?.ok ? manualFallback(checked.url).url : undefined);
    annotate({ operation: "research_manual", dependency: "manual", facts: event.facts.length });
    await recordEvent(req, "intake_submitted", { source: "manual" });
    if (details.city && process.env.TICKETSTUB_RUNTIME_MODE === "live") {
      const weather = await weatherFact(details.city, details.dateISO, 1).catch(() => undefined);
      if (weather) event.facts.push(weather);
    }
    if (!event.facts.some((f) => f.id === "weather")) event.facts.push({ id: "weather", label: "Weather: pending", value: details.city ? "Weather lookup unavailable" : "Needs a city", source: "Open-Meteo", confidence: 0.2, provenance: "pending" });
    return NextResponse.json(event);
  }

  if (typeof body.query === "string" && !body.url) {
    await recordEvent(req, "intake_submitted", { source: "search" });
    const results = searchFixtures(body.query);
    annotate({ operation: "research_search", dependency: "fixture", fallback: "simulated", results: results.length });
    return NextResponse.json({ results });
  }
  annotate({ operation: "research_link" });

  const raw = typeof body.url === "string" ? body.url.trim() : "";
  if (!raw) return readError(req);

  // Control characters are never valid in a link or a keyword. A link-shaped value must pass the full boundary
  // on its own: a demo keyword inside a malformed link ("https://neat hack.example/") does not rescue it.
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(raw)) return intakeRefusal(req, 422, "unreadable_link", READ_ERROR);
  const linkShaped = /^https?:\/\//i.test(raw) || /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(raw) || raw.startsWith("//") || /[./@\\]/.test(raw);
  let url: URL | undefined;
  if (linkShaped) {
    const checked = parseIntakeUrl(raw);
    if (!checked.ok) {
      if (checked.reason === "url_malformed") return intakeRefusal(req, 422, "unreadable_link", READ_ERROR);
      return intakeRefusal(req, 422, checked.reason === "url_too_long" ? "too_large" : "unsupported_url", URL_REFUSAL[checked.reason]);
    }
    url = checked.url;
  }

  // Ticketmaster / Live Nation links go to the Discovery API first. Without a key, or on any API failure
  // (429 included), we fall through to the page parse below and say so in `ticketmaster`.
  // Demo preview (the default) never calls Ticketmaster or fetches pages; only live mode does.
  await recordEvent(req, "intake_submitted", { source: "link" });
  const live = process.env.TICKETSTUB_RUNTIME_MODE === "live";
  if (url && live && isRestrictedEvent(url)) return restricted(req, url);
  if (url && live && providerForUrl(url)?.id === "ra") return intakeRefusal(req, 422, "unsupported_url", "Use a Resident Advisor event link, not a listing or profile page.");
  const tmLink = url && live ? parseTicketmasterUrl(url) : undefined;
  let tmMeta: TicketmasterMeta | undefined;
  if (tmLink) {
    const done = sourceTimer("ticketmaster");
    const tm = await lookupTicketmaster(tmLink, { apiKey: process.env.TICKETMASTER_API_KEY });
    done(tm.status === "ok" ? "ok" : TM_OUTCOME[tm.reason] ?? "bad_response");
    if (tm.status === "ok") {
      try {
        const finished = await finishTicketmaster(tm);
        annotate({ dependency: "ticketmaster", facts: finished.facts.length });
        return NextResponse.json(finished);
      } catch {
        tmMeta = { status: "error", reason: "bad-response", message: "Ticketmaster sent a response we could not use. Read the page instead." };
      }
    } else {
      tmMeta = { status: tm.status, reason: tm.reason, message: tm.message };
    }
  }
  const withTm = <T extends object>(e: T): T | (T & { ticketmaster: TicketmasterMeta }) => (tmMeta ? { ...e, ticketmaster: tmMeta } : e);

  // Demo keywords / known demo URLs return the fixture with its provenance as set.
  const fixture = tmLink ? undefined : matchFixture(raw);
  if (fixture) {
    await recordEvent(req, "research_started", { source: "fixture", facts: fixture.facts.length });
    const e = clone(fixture);
    if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") {
      e.facts = e.facts.map((fact) => ({
        ...fact,
        provenance: fact.provenance === "pending" ? "pending" : "simulated",
        source: fact.source.includes("(demo)") ? fact.source : `${fact.source} (demo)`,
      }));
    }
    if (url) e.sourceUrl = url.toString();
    annotate({ dependency: "fixture", fallback: process.env.TICKETSTUB_RUNTIME_MODE === "live" ? "none" : "simulated" });
    if (fixture === NEATHACK && url && process.env.TICKETSTUB_RUNTIME_MODE === "live") {
      // Enrich: confirm the page is reachable and record its live title.
      try {
        const html = await fetchPage(url.toString());
        const t = metaContent(html, "og:title") ?? titleTag(html);
        if (t) e.facts.push({ id: "page", label: t.slice(0, 40), value: t, source: "event page (title)", sourceUrl: url.toString(), confidence: 0.9, provenance: "live" });
      } catch {
        /* fixture stands on its own */
      }
    }
    annotate({ facts: e.facts.length });
    return NextResponse.json(withTm(e));
  }

  if (!url) return readError(req);

  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") {
    annotate({ code: "demo_only", dependency: "demo" });
    await recordEvent(req, "intake_rejected", { code: "demo_only" });
    return errorJson(422, "demo_only", "This preview uses demo events. Try neatHack, The Pale Hours, or Harbour FC.");
  }

  // A Ticketmaster page often refuses bots; the slug still names the event, so don't dead-end the person.
  const tmFallback = () => {
    const e = tmLink ? slugEvent(tmLink) : undefined;
    if (e) annotate({ dependency: "ticketmaster", fallback: "slug", facts: e.facts.length });
    return e ? NextResponse.json(withTm(e)) : readError(req);
  };

  await recordEvent(req, "research_started", { source: tmLink ? "ticketmaster" : "link" });
  try {
    const html = await fetchPage(url.toString());
    const ex = extract(html, url.toString());
    recordParse({ parser: ex?.parser ?? "none", facts: ex?.event.facts.length ?? 0, date: !!ex?.event.dateISO });
    if (!ex) return tmFallback();
    const { event } = ex;
    annotate({ dependency: "page" });

    if (!event.dateISO) {
      event.facts.push({ id: "date", label: "Date: pending", value: "pending", source: "event page", sourceUrl: url.toString(), confidence: 0.2, provenance: "pending" });
    }
    const tasks: Promise<unknown>[] = [];
    if (event.city && event.dateISO) {
      tasks.push(
        weatherFact(event.city, event.dateISO, ex.dateConfidence)
          .then((f) => f && event.facts.push(f))
          .catch(() => undefined),
      );
    } else {
      event.facts.push({ id: "weather", label: "Weather: pending", value: "Needs a city and a date", source: "Open-Meteo", confidence: 0.2, provenance: "pending" });
    }
    tasks.push(llmFacts(event, ex.text, url.toString(), req.signal).then((fs) => event.facts.push(...fs)));
    await Promise.all(tasks);
    if (!event.facts.some((f) => f.id === "weather")) {
      event.facts.push({ id: "weather", label: "Weather: pending", value: "Weather lookup unavailable", source: "Open-Meteo", confidence: 0.2, provenance: "pending" });
    }
    annotate({ facts: event.facts.length });
    return NextResponse.json(withTm(event));
  } catch (error) {
    if (error instanceof AccessRestrictedError) return restricted(req, url);
    const failure = providerFailure(error);
    if (failure) return providerEnvelope(failure);
    // A redirect or resolved address that left the public web is refused, not papered over with a slug guess.
    if (error instanceof BlockedDestinationError && error.reason !== "dns_failed") return intakeRefusal(req, 422, "unsupported_url", URL_REFUSAL.blocked_destination);
    return tmFallback();
  }
}));
