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

function read(storage: Storage | undefined): Record<string, Record_> {
  try {
    const raw = storage?.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Record_>) : {};
  } catch {
    return {};
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
  if (!storage) return;
  try {
    const all = read(storage);
    if (op && (op.phase === "pending" || op.phase === "ready" || KEEP.has(op.phase))) {
      const { runId, sourceVersionId, sourceRevision, via, vibe, phase, startedAt, endedAt, fallback, saved, code, message } = op;
      all[stubId] = { runId, stubId, sourceVersionId, sourceRevision, via, vibe, phase, startedAt, endedAt, fallback, saved, code, message };
    } else {
      delete all[stubId];
    }
    storage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the status lasts for this visit */
  }
}

/** The status left for a stub by an earlier page. A pending or ready record becomes interrupted. */
export function loadStatus(stubId: string, storage: Storage | undefined = defaultStorage()): GenerationOp | null {
  const rec = read(storage)[stubId];
  if (!rec || typeof rec.runId !== "string") return null;
  if (rec.phase === "pending" || rec.phase === "ready") {
    return { ...rec, phase: "interrupted", code: "interrupted", endedAt: rec.endedAt ?? Date.now(), message: INTERRUPTED_MESSAGE };
  }
  return KEEP.has(rec.phase) ? { ...rec } : null;
}

/** A deleted stub keeps no generation status. */
export function forgetStatus(stubId: string, storage: Storage | undefined = defaultStorage()): void {
  saveStatus(null, stubId, storage);
}
