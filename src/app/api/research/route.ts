import { NextResponse } from "next/server";
import { HARBOUR_GAME, NEATHACK, PALE_HOURS } from "@/customer/studio/fixtures";
import type { EventData, EventType, Fact } from "@/customer/studio/types";

// Preview mode serves demo fixtures; live mode also fetches event pages and Open-Meteo weather.
// Facts carry source + provenance: fetched values are "live", unsupported model claims are
// "estimated", and demo or unknown facts are "simulated" or "pending" (EVAL-03 / AGT-01).

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
const norm = (s: string) => decodeURIComponent(s).toLowerCase().replace(/[-_+.\/]+/g, " ");

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
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text.slice(0, 2_000_000);
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
      event: { type, title: performers[0] && type === "concert" ? performers[0] : name, subtitle: superEvent ?? (performers[0] && type === "concert" && performers[0] !== name ? name : undefined), venue, city, dateISO, sourceUrl: url, facts },
      text,
      dateConfidence: dateISO ? 0.9 : 0,
    };
  }

  // Without event JSON-LD, use page metadata and look for a date in metadata or page text.
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
    event: { type: inferType([], `${title} ${desc}`), title: cleanTitle, subtitle: undefined, sourceUrl: url, dateISO, facts },
    text,
    dateConfidence: dateISO ? 0.5 : 0,
  };
}

// ---------- Weather (Open-Meteo) ----------

async function weatherFact(city: string, dateISO: string, dateConfidence: number): Promise<Fact | undefined> {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const geo = await fetch(geoUrl, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6000), cache: "no-store" });
  if (!geo.ok) return undefined;
  const g = (await geo.json()) as { results?: { latitude: number; longitude: number; name: string }[] };
  const place = g.results?.[0];
  if (!place) return undefined;

  const today = new Date().toISOString().slice(0, 10);
  const daysFromToday = Math.round((Date.parse(`${dateISO}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (daysFromToday > 15) {
    return { id: "weather", label: "Weather: pending", value: "Forecast opens 16 days before the date", source: "Open-Meteo", confidence: 0.3, provenance: "pending" };
  }
  const base = daysFromToday < -60 ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  const wUrl = `${base}?latitude=${place.latitude}&longitude=${place.longitude}&start_date=${dateISO}&end_date=${dateISO}&daily=temperature_2m_max,precipitation_sum&timezone=auto`;
  const res = await fetch(wUrl, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6000), cache: "no-store" });
  if (!res.ok) return undefined;
  const w = (await res.json()) as { daily?: { temperature_2m_max?: (number | null)[]; precipitation_sum?: (number | null)[] } };
  const t = w.daily?.temperature_2m_max?.[0];
  const p = w.daily?.precipitation_sum?.[0];
  if (t == null) return undefined;
  const wet = (p ?? 0) >= 0.5;
  const forecast = daysFromToday > 0;
  return {
    id: "weather",
    label: `${Math.round(t)}°C · ${wet ? "rain" : "dry"}`,
    value: `${Math.round(t)}°C max, ${p ?? 0} mm ${wet ? "rain" : "precipitation"} in ${place.name}${forecast ? " (forecast)" : ""}`,
    source: "Open-Meteo",
    sourceUrl: wUrl,
    confidence: Math.min(forecast ? 0.75 : 0.9, dateConfidence >= 0.8 ? 1 : 0.6),
    provenance: "live",
    kept: dateConfidence >= 0.8 && !forecast,
  };
}

// ---------- Optional LLM enrichment (Anthropic Messages API, one call) ----------

async function llmFacts(event: EventData, text: string, url: string): Promise<Fact[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [];
  try {
    const prompt = `You extract facts about one event from a web page for a printed keepsake stub.
Event: ${event.title}${event.dateISO ? ` on ${event.dateISO}` : ""}${event.venue ? ` at ${event.venue}` : ""}.
Return ONLY a JSON array (max 4 items) of objects {"id": "opener"|"tour"|"run"|"other", "label": short stub text (max 28 chars), "value": string, "evidence": exact short quote from the page, "confidence": 0..1}.
Only include facts stated on the page. If nothing is stated, return [].

PAGE TEXT:
${text.slice(0, 6000)}`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const out = data.content?.find((c) => c.type === "text")?.text ?? "";
    const json = out.match(/\[[\s\S]*\]/)?.[0];
    if (!json) return [];
    const items = JSON.parse(json) as { id?: string; label?: string; value?: string; evidence?: string; confidence?: number }[];
    const lowerText = text.toLowerCase();
    return items
      .filter((i) => i.label && i.value)
      .slice(0, 4)
      .map((i, n) => {
        // Mark "live" when the first 60 evidence characters match page text, ignoring case.
        // This substring check does not verify that the evidence supports the claimed value.
        const grounded = !!i.evidence && lowerText.includes(i.evidence.toLowerCase().slice(0, 60));
        return {
          id: `${i.id && i.id !== "other" ? i.id : "note"}${event.facts.some((f) => f.id === i.id) ? `-${n}` : ""}`,
          label: String(i.label).slice(0, 40),
          value: String(i.value),
          source: "event page (read by Claude)",
          sourceUrl: url,
          confidence: Math.min(grounded ? 0.85 : 0.5, typeof i.confidence === "number" ? i.confidence : 0.6),
          provenance: grounded ? ("live" as const) : ("estimated" as const),
        };
      });
  } catch {
    return [];
  }
}

// ---------- Handler ----------

function readError(status = 422) {
  return NextResponse.json({ error: READ_ERROR }, { status });
}

export async function POST(req: Request) {
  let body: { url?: string; query?: string };
  try {
    body = (await req.json()) as { url?: string; query?: string };
  } catch {
    return NextResponse.json({ error: "Send a link or a search." }, { status: 400 });
  }

  if (typeof body.query === "string" && !body.url) {
    return NextResponse.json({ results: searchFixtures(body.query) });
  }

  const raw = typeof body.url === "string" ? body.url.trim() : "";
  if (!raw) return readError();

  let url: URL | undefined;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) url = undefined;
  } catch {
    url = undefined;
  }

  // Demo keywords / matching URLs return fixtures; preview mode relabels non-pending facts as simulated.
  const fixture = matchFixture(raw);
  if (fixture) {
    const e = clone(fixture);
    if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") {
      e.facts = e.facts.map((fact) => ({
        ...fact,
        provenance: fact.provenance === "pending" ? "pending" : "simulated",
        source: fact.source.includes("(demo)") ? fact.source : `${fact.source} (demo)`,
      }));
    }
    if (url) e.sourceUrl = url.toString();
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
    return NextResponse.json(e);
  }

  if (!url) return readError();

  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") {
    return NextResponse.json({ error: "This preview uses demo events. Try neatHack, The Pale Hours, or Harbour FC." }, { status: 422 });
  }

  try {
    const html = await fetchPage(url.toString());
    const ex = extract(html, url.toString());
    if (!ex) return readError();
    const { event } = ex;

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
    tasks.push(llmFacts(event, ex.text, url.toString()).then((fs) => event.facts.push(...fs)));
    await Promise.all(tasks);
    if (!event.facts.some((f) => f.id === "weather")) {
      event.facts.push({ id: "weather", label: "Weather: pending", value: "Weather lookup unavailable", source: "Open-Meteo", confidence: 0.2, provenance: "pending" });
    }
    return NextResponse.json(event);
  } catch {
    return readError();
  }
}
