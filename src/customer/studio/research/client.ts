// Browser-side calls to the research, art and agent routes. Errors carry user-facing copy.
import type { ArtLayer, EventData, Stub } from "../types";
import { currentVersion } from "../types";
import { codeOf, messageFor } from "@/customer/feedback-messages/messages";
import { track, type EventParams } from "@/customer/analytics/track";
import { AGENT_SCHEMA, parsePlan, type AgentRequest, type AgentResponse } from "../agent/protocol";

const READ_ERROR = "We couldn't read that link.";

type Api = "research" | "art" | "agent";
type ApiCall = EventParams<"api_call">;

/** The coarse analytics class for a server error code. The code itself is never sent. */
function errorClass(code: string | undefined, status: number): NonNullable<ApiCall["error_code"]> {
  switch (code) {
    case "art_limit":
    case "rate_limited":
    case "provider_rate_limited":
      return "rate_limited";
    case "missing_provider_key":
    case "invalid_provider_configuration":
    case "invalid_model_configuration":
    case "unsupported_image_model":
    case "provider_authentication_failed":
      return "provider_config";
    case "provider_unavailable":
    case "provider_request_cancelled":
    case "invalid_provider_response":
    case "unsupported_provider_response":
    case "invalid_image_response":
    case "unsupported_provider_request":
      return "provider";
    case "bad_request":
    case "bad_json":
    case "too_large":
    case "unsupported_input":
      return "invalid_input";
    case "unsupported_url":
    case "unreadable_link":
    case "demo_only":
      return "unsupported_url";
    case "bad_origin":
    case "unauthorized":
    case "forbidden":
      return "unauthorized";
    case "not_found":
      return "not_found";
  }
  return status >= 500 ? "http_5xx" : status >= 400 ? "http_4xx" : "unknown";
}

const statusClass = (status: number): ApiCall["status_class"] => (status === 204 ? "204" : status < 300 ? "2xx" : status < 400 ? "3xx" : status < 500 ? "4xx" : "5xx");

/** One client-observed API call: how it ended and how long the network round trip took. Never throws. */
function reportCall(api: Api, started: number, outcome: { status?: number; result: ApiCall["result"]; code?: string; mode?: ApiCall["mode"]; parse?: boolean }): void {
  const params: ApiCall = { api, result: outcome.result, duration_ms: Math.max(0, Math.min(3_600_000, Math.round(performance.now() - started))), attempt: 1 };
  if (outcome.status === undefined) {
    params.status_class = "network";
    params.error_code = "network";
  } else {
    params.status_class = statusClass(outcome.status);
    if (outcome.parse) params.error_code = "parse";
    else if (outcome.result === "failure" || outcome.code) params.error_code = errorClass(outcome.code, outcome.status);
  }
  if (outcome.mode) params.mode = outcome.mode;
  track("api_call", params);
}

const serverCode = (data: unknown): string | undefined => {
  const e = (data as { error?: unknown } | null)?.error;
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
};

/** The words to show for a caught failure: our own copy (it carries a catalog code), never a raw runtime message. */
export function failureCopy(e: unknown, fallback: string): string {
  return e instanceof Error && typeof (e as { code?: unknown }).code === "string" ? e.message : fallback;
}

/** An Error whose message is the catalog copy for the server's code, and which carries that code for useProgress. */
function apiError(data: unknown, fallback: string): Error {
  const code = codeOf(data);
  if (code === "unknown") {
    // Older bodies carried a bare string; show it only when it is plain copy, never a code or a stack.
    const legacy = (data as { error?: unknown } | null)?.error;
    return Object.assign(new Error(typeof legacy === "string" && legacy ? legacy : fallback), { code });
  }
  return Object.assign(new Error(messageFor(code).message), { code });
}

async function postJson<T>(api: Api, path: string, body: unknown, fallbackError: string): Promise<T> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    reportCall(api, started, { result: "failure" });
    throw Object.assign(new Error(messageFor("network").message), { code: "network" });
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    reportCall(api, started, { status: res.status, result: "failure", parse: res.ok });
    throw Object.assign(new Error(fallbackError), { code: "unavailable" });
  }
  if (!res.ok || (data && typeof data === "object" && "error" in data)) {
    reportCall(api, started, { status: res.status, result: "failure", code: serverCode(data) });
    throw apiError(data, fallbackError);
  }
  const results = (data as { results?: unknown } | null)?.results;
  reportCall(api, started, { status: res.status, result: Array.isArray(results) && results.length === 0 ? "empty" : "success" });
  return data as T;
}

const EVENT_KEYS: (keyof EventData)[] = ["type", "title", "subtitle", "venue", "city", "dateISO", "seat", "sourceUrl", "setlist", "score", "cast", "programme", "facts", "assets"];

/** Only the EventData fields: the route also returns research extras that must not be saved into (and synced with) a stub. */
export function pickEvent(data: EventData): EventData {
  const out: Record<string, unknown> = {};
  for (const k of EVENT_KEYS) if (data[k] !== undefined) out[k] = data[k];
  const event = out as unknown as EventData;
  // The route's extras say when a source was read and whether it sent an image. Keep those two things, honestly.
  const tm = (data as EventData & { ticketmaster?: { retrievedAt?: string; image?: { url?: string } } }).ticketmaster;
  if (tm?.retrievedAt) {
    event.facts = event.facts.map((f) => (f.retrievedAt || f.provenance === "pending" || !/ticketmaster/i.test(f.source) ? f : { ...f, retrievedAt: tm.retrievedAt }));
  }
  if (tm?.image?.url && !event.assets?.length) {
    event.assets = [
      {
        id: "ticketmaster-image",
        label: "Event image from Ticketmaster",
        sourceUrl: tm.image.url,
        status: "unknown",
        reason: "We can't confirm we have the right to print Ticketmaster's image, so it stays off your stub. The art is made from your facts instead.",
      },
    ];
  }
  return event;
}

/** Research one event from a link (or a demo keyword). Throws Error(message) on failure. */
export async function researchEvent(input: { url?: string; query?: string }): Promise<EventData> {
  if (input.url && input.url.trim()) {
    return pickEvent(await postJson<EventData>("research", "/api/research", { url: input.url.trim() }, READ_ERROR));
  }
  if (input.query && input.query.trim()) {
    const results = await searchEvents(input.query);
    if (!results[0]) throw new Error("We couldn't find that show. Try the artist, team or venue name.");
    return results[0];
  }
  throw new Error("Paste a link or search for your show.");
}

/** Search fallback. Results are demo events, labelled simulated. */
export async function searchEvents(query: string): Promise<EventData[]> {
  const data = await postJson<{ results?: EventData[] }>("research", "/api/research", { query }, "Search is unavailable right now. Try again in a moment.");
  return Array.isArray(data.results) ? data.results.map(pickEvent) : [];
}

/** Shown when the daily art cap is reached. The art that comes back with it is procedural, so nothing breaks. */
export const ART_LIMIT_NOTE = "You've made a lot of art today. Procedural art still works, and new art comes back tomorrow.";

export interface RemixResult {
  art: ArtLayer;
  /** Set when the daily cap was reached and `art` is the procedural fallback. */
  limitNote?: string;
  /** Epoch ms when new art is available again. */
  retryAt?: number;
}

/** Remix the art layer for a stub, and say so when the daily cap turned it into procedural art. */
export async function remixArtNoted(stub: Stub, vibe?: string, opts: { simulate?: "failure" } = {}): Promise<RemixResult> {
  const v = currentVersion(stub);
  const seed = Math.floor(Math.random() * 2_147_483_647);
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch("/api/art", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: stub.event, vibe, seed, edition: v?.edition, first: false, ...(opts.simulate ? { simulate: opts.simulate } : {}) }),
    });
  } catch {
    reportCall("art", started, { result: "failure" });
    throw Object.assign(new Error(messageFor("network").message), { code: "network" });
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    reportCall("art", started, { status: res.status, result: "failure", parse: res.ok });
    throw Object.assign(new Error("We couldn't remix the art. Try again in a moment."), { code: "unavailable" });
  }
  if (res.status === 429 && (data as { error?: { code?: string } })?.error?.code === "art_limit") {
    const d = data as { art?: ArtLayer; retryAt?: number };
    const art: ArtLayer = d.art?.kind === "procedural" ? d.art : { kind: "procedural", seed, vibe, provenance: "simulated" };
    reportCall("art", started, { status: res.status, result: "fallback", code: "art_limit", mode: "fallback" });
    return { art, limitNote: ART_LIMIT_NOTE, retryAt: d.retryAt };
  }
  if (!res.ok || (data && typeof data === "object" && "error" in data)) {
    reportCall("art", started, { status: res.status, result: "failure", code: serverCode(data) });
    throw apiError(data, "We couldn't remix the art. Try again in a moment.");
  }
  const art = data as ArtLayer;
  reportCall("art", started, { status: res.status, result: "success", mode: art.provenance === "live" ? "live" : "simulated" });
  return { art };
}

/** Remix the art layer for a stub. The caller pushes it as a new DesignVersion. */
export async function remixArt(stub: Stub, vibe?: string): Promise<ArtLayer> {
  return (await remixArtNoted(stub, vibe)).art;
}

/** Optional server agent reply. Returns undefined when no model is configured (caller falls back to rules). */
export async function askAgent(stub: Stub, message: string): Promise<{ reply: string; provenance: "live" } | undefined> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: stub.event, message }),
    });
  } catch {
    reportCall("agent", started, { result: "failure" });
    throw Object.assign(new Error(messageFor("network").message), { code: "network" });
  }
  if (res.status === 204) {
    // No model answered (demo, unconfigured, or a direct-provider failure): the caller falls back to rules.
    reportCall("agent", started, { status: 204, result: "fallback", mode: "fallback" });
    return undefined;
  }
  const data = (await res.json().catch(() => ({}))) as { reply?: string; provenance?: string };
  if (!res.ok) {
    reportCall("agent", started, { status: res.status, result: "failure", code: serverCode(data) });
    throw apiError(data, "The agent is unavailable. Try again in a moment.");
  }
  const live = !!data.reply && data.provenance === "live";
  reportCall("agent", started, live ? { status: res.status, result: "success", mode: "live" } : { status: res.status, result: "fallback", mode: "fallback" });
  return live ? { reply: data.reply as string, provenance: "live" } : undefined;
}

/**
 * One agent turn over the action protocol: a plan for a message, or the follow-up to observed results. The answer is
 * validated here too (the same rules as the server), so a malformed reply never becomes a chip. Throws Error(message).
 */
export async function planAgent(req: AgentRequest): Promise<AgentResponse> {
  const data = await postJson<Record<string, unknown>>("agent", "/api/agent", req, "The agent is unavailable. Try again in a moment.");
  const plan = parsePlan({ reply: data.reply, actions: data.actions }, { allowSimulate: true });
  if (!plan.ok) throw Object.assign(new Error("The agent sent something we could not use. Try again in a moment."), { code: "unavailable" });
  return { schema: AGENT_SCHEMA, ...plan.value, provenance: data.provenance === "live" ? "live" : "rules" };
}
