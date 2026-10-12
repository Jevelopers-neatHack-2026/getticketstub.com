// The ONE art-generation operation controller. The editor owns it; the remix sheet, the agent notes and the agent chat
// are only entry points (disposable panels never own a request). Every dispatched operation has its own run id, project
// and source version/revision. A completion may change only the art: it is committed against the CURRENT draft, so
// intervening text, facts, corrections, visibility, style, edition, material and history stay exactly as they are.
// A result is applied at most once, and never: after cancel, supersession, project change or deletion, or unmount.
// A changed selection never silently switches: the result waits as a ready candidate for an explicit Apply (or Discard).
// Aborting the transport is a local courtesy; the provider may still finish, and the text never claims otherwise.
import type { ArtLayer, Stub } from "../types";
import { currentVersion } from "../types";
import { addArtVersion } from "../editor/ops";
import { forgetStatus, loadStatus, saveStatus, type GenerationOp, type GenerationVia } from "./status-store";

export type { GenerationOp, GenerationPhase, GenerationVia } from "./status-store";

/** What the editor gives the controller: its live draft and its REAL commit (state, ref, local save, sync notice). */
export interface GenerationHost {
  /** The live draft: always the latest committed stub. */
  current(): Stub | null;
  /** The editor's committed-edit counter. */
  revision(): number;
  /** The project was deleted on this device. */
  isGone(stubId: string): boolean;
  /** Replace the live draft and persist it. True when it reached this device's storage. */
  commit(next: Stub): boolean;
}

/** The host over an editor's refs: its live draft, edit counter and real commit. */
export function editorHost(
  stub: { readonly current: Stub | null },
  revision: { readonly current: number },
  commit: (next: Stub) => boolean,
  isGone: (stubId: string) => boolean,
): GenerationHost {
  return { current: () => stub.current, revision: () => revision.current, isGone, commit };
}

export interface Produced {
  art: ArtLayer;
  /** Set when the daily limit turned the art into procedural art. */
  limitNote?: string;
}

export interface StartRequest {
  via: GenerationVia;
  vibe?: string;
  /** What to do when only procedural fallback art exists: apply it (labelled), or only report the limit. */
  fallback?: "apply" | "offer";
  /** Make the art. Must honour the signal to stop its transport; late results are ignored either way. */
  run: (signal: AbortSignal, source: Stub) => Promise<Produced>;
}

export interface StartResult {
  /** False when an operation for this project was already pending: nothing was dispatched. */
  started: boolean;
  op: GenerationOp;
}

export const STOPPED_MESSAGE =
  "Stopped. If a result still arrives it is ignored. This does not cancel the request on the art service, which may still finish it.";
/** A photo is read on this device: there is no art service to speak of. */
export const PHOTO_STOPPED_MESSAGE = "Stopped. The photo is ignored if it finishes reading. Your current art is unchanged.";
export const PHOTO_PENDING_MESSAGE = "Adding your photo as the art. Your current art stays in place until it is ready.";

interface Entry {
  req: StartRequest;
  ac: AbortController;
  /** Resolves the start() promise at a terminal phase. */
  done: (op: GenerationOp) => void;
  candidate?: Produced;
}

let seq = 0;
const newRunId = (): string => `gen-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class GenerationController {
  private ops = new Map<string, GenerationOp>();
  private latest = new Map<string, string>();
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private attached = false;
  private tick = 0;

  constructor(
    private host: GenerationHost,
    private storage?: Storage,
  ) {}

  /** The editor mounted (also after a Strict Mode re-run): adopt what an earlier page left for this stub. */
  attach(): void {
    this.attached = true;
    const id = this.host.current()?.id;
    if (id && !this.latest.has(id)) {
      const old = loadStatus(id, this.storage);
      if (old) {
        this.ops.set(old.runId, old);
        this.latest.set(id, old.runId);
        this.emit();
      }
    }
  }

  /** The editor unmounted (navigation away, project switch): nothing may write after this; pending work becomes unknown. */
  detach(): void {
    this.attached = false;
    for (const [runId, e] of [...this.entries]) {
      const op = this.ops.get(runId);
      if (!op || (op.phase !== "pending" && op.phase !== "ready")) continue;
      e.ac.abort();
      this.finish(runId, {
        phase: "interrupted",
        code: "interrupted",
        message: "Generation was interrupted when the editor closed. We can't tell whether it finished, and nothing was applied.",
      });
    }
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  /** Changes whenever any operation does (a useSyncExternalStore snapshot). */
  version = (): number => this.tick;

  /** The latest operation for a project, if there is one to show. */
  get(stubId: string): GenerationOp | null {
    const id = this.latest.get(stubId);
    return (id && this.ops.get(id)) || null;
  }
  all(): GenerationOp[] {
    return [...this.ops.values()];
  }

  /** Dispatch one operation against the project that is open now. One pending operation per project: no duplicate request. */
  start(req: StartRequest): Promise<StartResult> {
    const source = this.host.current();
    if (!source || !this.attached) return Promise.reject(new Error("The editor is not open."));
    const active = this.get(source.id);
    if (active?.phase === "pending") return Promise.resolve({ started: false, op: active });
    // A new request replaces whatever the status was showing. An unapplied ready result is deliberately retired first,
    // so the older run can no longer be applied, retried or shown over the newer one.
    if (active) this.retire(active);
    const runId = newRunId();
    const op: GenerationOp = {
      runId,
      stubId: source.id,
      sourceVersionId: currentVersion(source).id,
      sourceRevision: this.host.revision(),
      via: req.via,
      ...(req.vibe ? { vibe: req.vibe } : {}),
      phase: "pending",
      startedAt: Date.now(),
      message: req.via === "photo" ? PHOTO_PENDING_MESSAGE : "Generating new art. Your current art stays in place until the result is ready.",
    };
    return new Promise<StartResult>((resolve) => {
      const entry: Entry = { req, ac: new AbortController(), done: (o) => resolve({ started: true, op: o }) };
      this.ops.set(runId, op);
      this.latest.set(source.id, runId);
      this.entries.set(runId, entry);
      this.persist(op);
      this.emit();
      let work: Promise<Produced>;
      try {
        work = req.run(entry.ac.signal, source);
      } catch (e) {
        work = Promise.reject(e);
      }
      work.then(
        (produced) => this.settle(runId, produced),
        (error) => this.fail(runId, error),
      );
    });
  }

  /** Stop applying this operation's result. Local only: the provider may still complete the request. */
  cancel(runId: string): void {
    const op = this.ops.get(runId);
    if (!op || op.phase !== "pending" || !this.isLatest(op)) return;
    this.entries.get(runId)?.ac.abort();
    this.finish(runId, { phase: "canceled", code: "canceled", message: op.via === "photo" ? PHOTO_STOPPED_MESSAGE : STOPPED_MESSAGE });
  }

  /** Explicitly apply a ready candidate to the CURRENT draft: a new version from what is selected now. At most once. */
  apply(runId: string): GenerationOp | null {
    const op = this.ops.get(runId);
    const entry = this.entries.get(runId);
    // only the project's CURRENT operation may write; an older run's Apply is inert
    if (!op || !this.isLatest(op) || op.phase !== "ready" || !entry?.candidate) return op ?? null;
    const { art } = entry.candidate;
    entry.candidate = undefined;
    const cur = this.guard(op);
    if (!cur) return this.discardGone(runId);
    return this.commitArt(runId, cur, art, !!op.fallback);
  }

  /** Throw away a ready candidate (or stop a pending run). The draft is untouched. */
  discard(runId: string): void {
    const op = this.ops.get(runId);
    if (!op || !this.isLatest(op)) return;
    if (op.phase === "pending") return this.cancel(runId);
    if (op.phase !== "ready") return;
    this.finish(runId, { phase: "discarded", message: "New art discarded. Your design is unchanged." });
  }

  /** Remove a finished status from view. */
  dismiss(runId: string): void {
    const op = this.ops.get(runId);
    if (!op || op.phase === "pending" || op.phase === "ready") return;
    this.ops.delete(runId);
    this.entries.delete(runId);
    if (this.latest.get(op.stubId) === runId) {
      this.latest.delete(op.stubId);
      forgetStatus(op.stubId, this.storage);
    }
    this.emit();
  }

  /** An explicit NEW operation with the same request. Not possible after a reload (the request is not kept). */
  retry(runId: string): Promise<StartResult> | null {
    const op = this.ops.get(runId);
    const entry = this.entries.get(runId);
    // only the current operation can be retried: an older run must not displace a newer pending or ready one
    if (!op || !entry || !this.isLatest(op) || op.phase === "pending" || op.phase === "ready" || op.phase === "applied") return null;
    return this.start(entry.req);
  }

  canRetry(runId: string): boolean {
    const op = this.ops.get(runId);
    return !!op && this.isLatest(op) && this.entries.has(runId);
  }

  /* ---------------- internals ---------------- */

  private isLatest(op: GenerationOp): boolean {
    return this.latest.get(op.stubId) === op.runId;
  }

  /** Replace the shown operation: a ready candidate is discarded as superseded; its request and candidate are dropped. */
  private retire(op: GenerationOp): void {
    if (op.phase === "ready") {
      this.finish(op.runId, { phase: "discarded", code: "superseded", message: "An earlier result was not applied: a newer request replaced it." });
    }
    this.entries.delete(op.runId);
  }

  /** The current draft, when this operation may still write to it. */
  private guard(op: GenerationOp): Stub | null {
    const cur = this.host.current();
    if (!this.attached || !cur || cur.id !== op.stubId || this.host.isGone(op.stubId)) return null;
    return cur;
  }

  private settle(runId: string, produced: Produced): void {
    const op = this.ops.get(runId);
    const entry = this.entries.get(runId);
    // at most once: a duplicate, canceled, superseded or interrupted completion finds a terminal operation and stops here
    if (!op || !entry || op.phase !== "pending" || !this.isLatest(op)) return;
    const cur = this.guard(op);
    if (!cur) {
      this.discardGone(runId);
      return;
    }
    const fallback = !!produced.limitNote;
    if (fallback && entry.req.fallback === "offer") {
      this.finish(runId, {
        phase: "failed",
        code: "art_limit",
        fallback: true,
        message: `${produced.limitNote} No generated image was made and nothing was applied.`,
      });
      return;
    }
    if (currentVersion(cur).id !== op.sourceVersionId) {
      // the selection moved while this ran: never attach the result to a look the person has left
      entry.candidate = produced;
      this.finish(runId, {
        phase: "ready",
        fallback,
        message: `New art ready, not applied: you changed the selected look while it was generating. Apply it as a new version, or discard it.${fallback ? ` ${produced.limitNote} This is procedural art, not a generated image.` : ""}`,
      });
      return;
    }
    this.commitArt(runId, cur, produced.art, fallback, produced.limitNote);
  }

  private commitArt(runId: string, cur: Stub, art: ArtLayer, fallback: boolean, limitNote?: string): GenerationOp {
    // art-only: the new version is built from the CURRENT draft, so every other field stays as the person left it
    const saved = this.host.commit(addArtVersion(cur, art));
    const lead = fallback ? `${limitNote ?? "The daily limit was reached."} No generated image was made; procedural art was applied instead.` : "New art applied.";
    return this.finish(runId, {
      phase: "applied",
      fallback,
      saved,
      message: `${lead} The earlier look stays in Versions.${saved ? "" : " It could not be saved on this device: it exists only in this open editor."}`,
    });
  }

  private discardGone(runId: string): GenerationOp {
    return this.finish(runId, { phase: "discarded", code: "project_changed", message: "The project changed or was removed while art was generating, so the result was not applied." });
  }

  private fail(runId: string, error: unknown): void {
    const op = this.ops.get(runId);
    if (!op || op.phase !== "pending") return; // canceled, interrupted or already settled: a late rejection changes nothing
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown";
    if (code === "aborted") return;
    const text = error instanceof Error && error.message ? error.message : "We couldn't make new art.";
    this.finish(runId, { phase: "failed", code, message: `${text} Your current art and edits are unchanged. Try again starts a new request.` });
  }

  private finish(runId: string, patch: Partial<GenerationOp> & Pick<GenerationOp, "phase" | "message">): GenerationOp {
    const op = this.ops.get(runId)!;
    const next: GenerationOp = { ...op, ...patch, ...(patch.phase === "ready" ? {} : { endedAt: Date.now() }) };
    this.ops.set(runId, next);
    const entry = this.entries.get(runId);
    if (entry) {
      if (patch.phase !== "ready") entry.candidate = undefined;
      entry.done(next);
    }
    this.persist(next);
    this.emit();
    return next;
  }

  private persist(op: GenerationOp): void {
    if (this.latest.get(op.stubId) === op.runId) saveStatus(op, op.stubId, this.storage);
  }

  private emit(): void {
    this.tick++;
    this.listeners.forEach((l) => l());
  }
}
