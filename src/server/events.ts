// The TicketStub event taxonomy (ticketstub.event/1): what happened, never who or what was said.
// Pure (node:crypto only, no app imports) so scripts/smoke-server.mjs runs this exact sanitizer under plain Node.
// The one exception is exportToHarness, which loads ./harness-export only when the hand-off is switched on.
//
// An event carries only safe fields: ids as hashes ("refs"), codes, counts, flags, timestamps and a few fixed
// words. It never carries a URL or query string, a prompt, an email, a name, a note, a photo or a token. The
// sanitizer below is the only way an event gets built, and it works from an allow-list per type: a field that
// is not named for that type is dropped, and a value that does not fit its kind is dropped.
//
// Retention: events are stored in the SQLite `events` table (append-only: UPDATE is refused, and DELETE is
// refused until a row is older than EVENT_RETENTION_DAYS, so only the nightly-ish prune can remove them).
// When storage is unavailable, events go to a small in-memory ring (lost on restart) and nothing else.
import { createHash, randomBytes } from "node:crypto";

export const EVENT_SCHEMA = "ticketstub.event/1";
export const EVENT_RETENTION_DAYS = 90;
export const EVENT_RETENTION_MS = EVENT_RETENTION_DAYS * 24 * 3600_000;

type Kind = "ref" | "code" | "count" | "ts" | "flag" | readonly string[];

/** The taxonomy: every event type and the fields it may carry. */
export const EVENT_SPEC = {
  intake_submitted: { source: ["link", "search", "manual"] },
  intake_rejected: { code: "code", provider: ["axs", "seatgeek", "stubhub", "ra", "eventim", "see_tickets", "shotgun", "etix", "tixr", "skiddle", "unknown"] },
  research_started: { source: ["fixture", "link", "ticketmaster"], facts: "count" },
  fact_corrected: { fact: "ref", versions: "count" },
  art_requested: { first: "flag" },
  art_ready: { provider: ["procedural", "image", "simulated", "live"] },
  art_failed: { code: "code" },
  art_limit: { retryAt: "ts" },
  agent_plan: { source: ["rules", "live"], outcome: ["ok", "repaired", "invalid_plan"], actions: "count" },
  agent_action: { action: ["set_fact", "set_style", "set_material", "set_finish", "set_text", "remix_art", "show_back", "ask_user"], result: ["applied", "failed", "rejected"], code: "code" },
  version_selected: { version: "ref", versions: "count" },
  share_created: { share: "ref" },
  share_revoked: { revoked: "flag" },
  approval_issued: { purpose: ["print.compose", "artifact.download"], approval: "ref", reissued: "flag" },
  approval_revoked: { approval: "ref", already: "flag" },
  order_authorized: { provider: ["sandbox", "prodigi"], authorization: "ref", reissued: "flag" },
  authorization_claimed: { authorization: "ref", replayed: "flag" },
  authorization_revoked: { authorization: "ref", already: "flag" },
  authorization_refused: { op: ["claim", "revalidate"], reason: "code" },
  gift_created: { share: "ref", messageChars: "count" },
  order_placed: { order: "ref", lines: "count", totalMinor: "count" },
  order_blocked: { code: "code" },
  checkout_started: { order: "ref", lines: "count", totalMinor: "count", provider: "code" },
  order_paid: { order: "ref", totalMinor: "count", provider: "code" },
  payment_needs_review: { order: "ref", provider: "code", reason: ["amount", "currency", "late"] },
  signin_link_sent: { reason: ["save", "checkout", "claim"], delivery: ["mail", "sandbox"] },
  signed_in: { fresh: "flag" },
  claim_redeemed: { status: ["claimed", "already"] },
  storage_unavailable: { code: "code", route: "code" },
} as const satisfies Record<string, Record<string, Kind>>;

export type EventType = keyof typeof EVENT_SPEC;
export const EVENT_TYPES = Object.keys(EVENT_SPEC) as EventType[];
/** The two types the browser may report (the server has no other way to see them). */
export const CLIENT_EVENT_TYPES: readonly EventType[] = ["version_selected", "fact_corrected"];

export type EventValue = string | number | boolean;

export interface TicketstubEvent {
  schema: typeof EVENT_SCHEMA;
  type: EventType;
  /** Epoch ms. */
  at: number;
  /** Correlation id: x-request-id in, or generated. Shared by every event one request makes. */
  requestId: string;
  actor: "account" | "guest" | "anonymous";
  /** Hash of the account id or guest tenant. Absent for anonymous. */
  actorRef?: string;
  /** Hash of the stub or organizer event id this concerns. */
  projectRef?: string;
  mode: "sandbox" | "live";
  fields: Record<string, EventValue>;
}

export interface StoredEvent extends TicketstubEvent {
  /** Append order, assigned by storage. */
  seq: number;
  tenantRef?: string;
}

// ---------------------------------------------------------------------------------------------
// Refs and ids
// ---------------------------------------------------------------------------------------------

/** An id as a 16-hex hash: stable, so an owner can look their project up, but the id itself never leaves. */
export const refOf = (id: string): string => createHash("sha256").update(`ticketstub.event/1:${id}`).digest("hex").slice(0, 16);

const REQUEST_ID = /^[A-Za-z0-9_.-]{8,64}$/;
export const newRequestId = (): string => `req_${randomBytes(9).toString("base64url")}`;

/** The caller's x-request-id when it is well formed, otherwise a new one. Never an input to who the caller is. */
export function requestIdOf(headers: Pick<Headers, "get">): string {
  const given = headers.get("x-request-id")?.trim();
  return given && REQUEST_ID.test(given) ? given : newRequestId();
}

// ---------------------------------------------------------------------------------------------
// The sanitizer
// ---------------------------------------------------------------------------------------------

const REF = /^[a-f0-9]{16}$/;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_COUNT = 1_000_000_000;
// A last line of defence over the finished event: nothing that looks like one of these may be stored.
const EMAIL = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;
const URLISH = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|[?&][\w.%-]+=)/i;
const TOKENISH = /[A-Za-z0-9_-]{24,}/;

const clean = (v: string) => !EMAIL.test(v) && !URLISH.test(v) && !TOKENISH.test(v);

function fit(kind: Kind, v: unknown): EventValue | undefined {
  if (typeof kind !== "string") return typeof v === "string" && kind.includes(v) ? v : undefined;
  switch (kind) {
    case "ref":
      return typeof v === "string" && REF.test(v) ? v : undefined;
    case "code":
      return typeof v === "string" && CODE.test(v) ? v : undefined;
    case "count":
      return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : undefined;
    case "ts":
      return typeof v === "number" && Number.isInteger(v) && v > 0 && v < 8.64e15 ? v : undefined;
    case "flag":
      return typeof v === "boolean" ? v : undefined;
  }
}

/** Keeps only the fields this type names, each only if its value fits. Everything else is dropped, not repaired. */
export function sanitizeFields(type: EventType, raw: unknown): Record<string, EventValue> {
  const spec = EVENT_SPEC[type] as Record<string, Kind>;
  const out: Record<string, EventValue> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [key, kind] of Object.entries(spec)) {
    if (!Object.hasOwn(raw, key)) continue;
    const v = fit(kind, (raw as Record<string, unknown>)[key]);
    if (v !== undefined && (typeof v !== "string" || clean(v))) out[key] = v;
  }
  return out;
}

export interface EventInput {
  type: string;
  at?: number;
  requestId?: string;
  actor?: TicketstubEvent["actor"];
  actorRef?: string;
  projectRef?: string;
  mode?: TicketstubEvent["mode"];
  fields?: unknown;
}

/** Builds a safe event, or null for an unknown type. */
export function sanitizeEvent(input: EventInput): TicketstubEvent | null {
  if (!Object.hasOwn(EVENT_SPEC, input.type)) return null;
  const type = input.type as EventType;
  const actor = input.actor === "account" || input.actor === "guest" ? input.actor : "anonymous";
  const ev: TicketstubEvent = {
    schema: EVENT_SCHEMA,
    type,
    at: typeof input.at === "number" && Number.isInteger(input.at) && input.at > 0 ? input.at : Date.now(),
    requestId: input.requestId && REQUEST_ID.test(input.requestId) ? input.requestId : newRequestId(),
    actor,
    mode: input.mode === "live" ? "live" : "sandbox",
    fields: sanitizeFields(type, input.fields),
  };
  if (actor !== "anonymous" && input.actorRef && REF.test(input.actorRef)) ev.actorRef = input.actorRef;
  if (input.projectRef && REF.test(input.projectRef)) ev.projectRef = input.projectRef;
  return ev;
}

// ---------------------------------------------------------------------------------------------
// In-memory ring: where events go when storage cannot take them (and what storage_unavailable can use).
// ---------------------------------------------------------------------------------------------

const RING_MAX = 200;
const g = globalThis as unknown as { __ticketstubEventRing?: StoredEvent[]; __ticketstubEventSeq?: number };

export function pushRing(ev: TicketstubEvent, tenantRef?: string): void {
  const ring = (g.__ticketstubEventRing ??= []);
  const seq = (g.__ticketstubEventSeq = (g.__ticketstubEventSeq ?? 0) - 1); // negative: never collides with stored seq
  ring.push({ ...ev, seq, ...(tenantRef ? { tenantRef } : {}) });
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

export const ringEvents = (): StoredEvent[] => [...(g.__ticketstubEventRing ?? [])];

// ---------------------------------------------------------------------------------------------
// Harness hand-off
// ---------------------------------------------------------------------------------------------

/**
 * Gives already-sanitized events to the agent-harness, which owns Neatlogs and durable workflow tracing (see
 * docs/architecture/events.md). Off unless TICKETSTUB_HARNESS_EXPORT=neatlogs; then the harness module is loaded on
 * first use and stores the events in its durable outbox, and a background drain delivers them. Never throws and
 * never waits for the network, so recording an event costs a request nothing more than one local write.
 */
export async function exportToHarness(events: readonly TicketstubEvent[]): Promise<void> {
  if (events.length === 0 || process.env.TICKETSTUB_HARNESS_EXPORT?.trim().replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase() !== "neatlogs") return;
  try {
    const { handOff } = await import("./harness-export");
    handOff(events);
  } catch {
    console.warn("[harness] hand-off module could not load");
  }
}
