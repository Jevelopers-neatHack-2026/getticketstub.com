// Narrow persistence for the art-generation status shown beside the artwork. Only a small status record per stub is kept
// (never art bytes, requests or provider detail). A request cannot outlive its page, so on load a pending or unapplied
// record is rewritten as "interrupted": the outcome is honestly unknown. Storage can throw: every access is guarded.

const KEY = "ticketstub.generation.v1";

export type GenerationVia = "sheet" | "note" | "agent" | "photo";
export type GenerationPhase = "pending" | "ready" | "applied" | "failed" | "canceled" | "discarded" | "interrupted";

/** One operation as the editor shows it. */
export interface GenerationOp {
  /** Unique per dispatched operation; ownership is never a seed, a busy flag or response order. */
  runId: string;
  /** The project the operation was dispatched for. */
  stubId: string;
  /** The design version selected when it was dispatched, and the editor's edit counter at that moment. */
  sourceVersionId: string;
  sourceRevision: number;
  via: GenerationVia;
  vibe?: string;
  phase: GenerationPhase;
  startedAt: number;
  endedAt?: number;
  /** The result is procedural art because no generated image was produced (daily limit). */
  fallback?: boolean;
  /** For an applied result: whether the edit reached this device's storage. */
  saved?: boolean;
  /** A bounded code for a failure (art_limit, network, ...). */
  code?: string;
  /** Plain-language, truthful status text. */
  message: string;
}

type Record_ = Pick<GenerationOp, "runId" | "stubId" | "sourceVersionId" | "sourceRevision" | "via" | "vibe" | "phase" | "startedAt" | "endedAt" | "fallback" | "saved" | "code" | "message">;

export const INTERRUPTED_MESSAGE =
  "This page was closed or reloaded while new art was generating. We can't tell whether it finished, and nothing was applied. Your current art is unchanged. Starting again is a new request.";

const PHASES = new Set<GenerationPhase>(["pending", "ready", "applied", "failed", "canceled", "discarded", "interrupted"]);
const VIAS = new Set<GenerationVia>(["sheet", "note", "agent", "photo"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number, empty = false): value is string =>
  typeof value === "string" && value.length <= limit && (empty || value.trim().length > 0);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Storage is untrusted input, including the record's project identity and every field the controller adopts. */
function valid(value: unknown, stubId: string): value is Record_ {
  if (!record(value)) return false;
  return text(stubId, 256) && value.stubId === stubId && text(value.runId, 256) && text(value.sourceVersionId, 256)
    && count(value.sourceRevision) && count(value.startedAt) && (value.endedAt === undefined || count(value.endedAt))
    && VIAS.has(value.via as GenerationVia) && PHASES.has(value.phase as GenerationPhase)
    && text(value.message, 2048) && (value.vibe === undefined || text(value.vibe, 2048, true))
    && (value.code === undefined || text(value.code, 128, true))
    && (value.fallback === undefined || typeof value.fallback === "boolean")
    && (value.saved === undefined || typeof value.saved === "boolean");
}

/** Copy only the small persisted contract; extra stored fields never enter the live controller. */
function select(op: Record_): Record_ {
  const { runId, stubId, sourceVersionId, sourceRevision, via, vibe, phase, startedAt, endedAt, fallback, saved, code, message } = op;
  return { runId, stubId, sourceVersionId, sourceRevision, via, vibe, phase, startedAt, endedAt, fallback, saved, code, message };
}

/** null means unreadable content, which must not be replaced by an empty status map. */
function read(storage: Storage | undefined): Record<string, unknown> | null {
  try {
    const raw = storage?.getItem(KEY);
    if (raw === undefined || raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const defaultStorage = (): Storage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

/** Phases worth showing again after a reload: what needs the person's attention. */
const KEEP = new Set<GenerationPhase>(["failed", "interrupted"]);

/** Save (or clear) the status record for one stub. A storage failure only loses the reminder, never the draft. */
export function saveStatus(op: GenerationOp | null, stubId: string, storage: Storage | undefined = defaultStorage()): void {
  if (!storage || !text(stubId, 256)) return;
  try {
    const all = read(storage);
    // Never erase or normalize unknown reminder bytes, including another project's malformed record.
    if (!all || Object.entries(all).some(([id, saved]) => !valid(saved, id)) || op && !valid(op, stubId)) return;
    let next;
    if (op && (op.phase === "pending" || op.phase === "ready" || KEEP.has(op.phase))) {
      // A computed own property also handles an identifier such as "__proto__" without a setter.
      next = { ...all, [stubId]: select(op) };
    } else {
      next = { ...all };
      delete next[stubId];
    }
    storage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the status lasts for this visit */
  }
}

/** The status left for a stub by an earlier page. A pending or ready record becomes interrupted. */
export function loadStatus(stubId: string, storage: Storage | undefined = defaultStorage()): GenerationOp | null {
  if (!text(stubId, 256)) return null;
  const all = read(storage);
  if (!all || !Object.hasOwn(all, stubId) || !valid(all[stubId], stubId)) return null;
  const rec = select(all[stubId]);
  if (rec.phase === "pending" || rec.phase === "ready") {
    return { ...rec, phase: "interrupted", code: "interrupted", endedAt: rec.endedAt ?? Date.now(), message: INTERRUPTED_MESSAGE };
  }
  return KEEP.has(rec.phase) ? { ...rec } : null;
}

/** A deleted stub keeps no generation status. */
export function forgetStatus(stubId: string, storage: Storage | undefined = defaultStorage()): void {
  saveStatus(null, stubId, storage);
}
