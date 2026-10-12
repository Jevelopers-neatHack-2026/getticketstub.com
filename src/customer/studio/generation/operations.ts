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
import { readStoredStub } from "../store";
import { compareVersions, reconcileVersions } from "./reconcile";
import { forgetStatus, loadStatus, saveStatus, type GenerationOp, type GenerationVia } from "./status-store";

export type { GenerationOp, GenerationPhase, GenerationVia } from "./status-store";

/** What the editor gives the controller: its live draft and its REAL commit (state, ref, local save, sync notice). */
export interface GenerationHost {
  /** The live draft: always the latest committed stub. */
  current(): Stub | null;
  /** The editor's committed-edit counter. */
  revision(): number;
  /** The project was deleted on this device (a queued deletion). One signal among several, never the only authority. */
  isGone(stubId: string): boolean;
  /**
   * What this device's store says about the project now. Once an operation has seen it "present", a later "absent" is a
   * removal, whatever happens to any outbound queue afterwards. "unknown" (storage unreadable) is never a removal.
   * Optional: a host without a store has nothing to observe.
   */
  presence?(stubId: string): "present" | "absent" | "unknown";
  /**
   * Replace the live draft and persist it. True when it reached this device's storage. `persist: false` updates the open
   * editor only and writes nothing (used when storage cannot be read, where a write could erase other projects).
   */
  commit(next: Stub, opts?: { persist?: boolean }): boolean;
}

/** The host over an editor's refs: its live draft, edit counter and real commit. */
export function editorHost(
  stub: { readonly current: Stub | null },
  revision: { readonly current: number },
  commit: (next: Stub, opts?: { persist?: boolean }) => boolean,
  isGone: (stubId: string) => boolean,
  presence?: (stubId: string) => "present" | "absent" | "unknown",
): GenerationHost {
  return { current: () => stub.current, revision: () => revision.current, isGone, commit, presence };
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

export const CONFLICT_MESSAGE = "Nothing was applied: a version with the same id differs between this editor and what is stored, so they can't be merged safely. Your open draft and the stored project are both unchanged.";
export const UNVERIFIABLE_MESSAGE = "New art ready, not applied: this editor's copy of an earlier version and the stored copy name their picture differently and the pictures can't be compared, so nothing was merged or written. Nothing is lost; discard this and try again, or reopen the project.";
export const PEER_SELECTED_MESSAGE = "New art ready, not applied: another editor on this project added or selected a version while this was generating. Apply it to add it as a new version alongside theirs (their versions are kept), or discard it.";
export const CHANGED_MESSAGE = "This project was replaced on this device (for example restored from elsewhere) while art was being made, so nothing was applied. What is stored now is unchanged.";
export const UNREADABLE_HOLD_MESSAGE = "New art ready, not applied automatically: this device's storage can't be read right now, so the project can't be updated safely. Apply it to use it in this open editor only (it will not be saved), or discard it.";
export const REMOVED_MESSAGE = "This project was removed from this device while art was being made, so nothing was applied. Your open draft is unchanged.";
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

/** Only these end states can be started again; a discarded run (superseded, removed, project changed) never is. */
/** Fired by the account sync (src/customer/account/sync.ts WALL_SYNCED) after it wrote the merged wall to this device. */
export const WALL_SYNCED_EVENT = "ticketstub:wall-synced";

const RETRYABLE = new Set<GenerationOp["phase"]>(["failed", "canceled", "interrupted"]);

let seq = 0;
const newRunId = (): string => `gen-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class GenerationController {
  private ops = new Map<string, GenerationOp>();
  private latest = new Map<string, string>();
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private attached = false;
  private tick = 0;
  /** Projects this editor has seen saved on the device, and those it has since seen removed (for this editor session). */
  private seen = new Set<string>();
  private removed = new Set<string>();
  /** `${stubId}\0${versionId}` -> the file reference this editor's own sync wrote in place of that version's inline picture. */
  private attested = new Map<string, string>();
  private onSynced = (): void => this.attestSync();

  constructor(
    private host: GenerationHost,
    private storage?: Storage,
  ) {}

  /** The editor mounted (also after a Strict Mode re-run): adopt what an earlier page left for this stub. */
  attach(): void {
    this.attached = true;
    this.seen.clear();
    this.removed.clear();
    this.attested.clear();
    if (typeof window !== "undefined") window.addEventListener(WALL_SYNCED_EVENT, this.onSynced);
    const id = this.host.current()?.id;
    if (id) this.watch(id);
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
    if (typeof window !== "undefined") window.removeEventListener(WALL_SYNCED_EVENT, this.onSynced);
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

  /**
   * Re-read the store for every project with a live operation (call it on wall, storage and sync events). A removal seen
   * here retires those operations at once and for good: a project restored under the same id later does not revive them.
   */
  observe = (): void => this.scan();

  /** As observe, with what a delivered `storage` event's payload says about each project at THAT moment. */
  observeTransition = (hint: (stubId: string) => "present" | "absent" | "unknown"): void => this.scan(hint);

  private scan(hint?: (stubId: string) => "present" | "absent" | "unknown"): void {
    if (!this.attached) return;
    const ids = new Set<string>();
    for (const op of this.ops.values()) if (op.phase === "pending" || op.phase === "ready") ids.add(op.stubId);
    const cur = this.host.current()?.id;
    if (cur) ids.add(cur);
    // `hint` is what a delivered storage event's payload says. It is a transition: read before the current store, because by
    // the time a queued event is handled the project may already have been restored under the same id.
    ids.forEach((id) => this.watch(id, hint?.(id)));
  }

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
    this.watch(source.id);
    const active = this.get(source.id);
    if (active?.phase === "pending") return Promise.resolve({ started: false, op: active });
    if (this.removed.has(source.id)) {
      // this open draft's project was removed from the device: nothing may be generated into it
      if (active) this.retire(active);
      const runId = newRunId();
      const op: GenerationOp = {
        runId,
        stubId: source.id,
        sourceVersionId: currentVersion(source).id,
        sourceRevision: this.host.revision(),
        via: req.via,
        phase: "discarded",
        code: "project_removed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        message: REMOVED_MESSAGE,
      };
      this.ops.set(runId, op);
      this.latest.set(source.id, runId);
      this.emit();
      return Promise.resolve({ started: false, op });
    }
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
    const cur = this.guard(op);
    if (!cur) return this.discardGone(runId);
    const v = this.inspect(op.stubId, cur);
    if (v.kind === "removed" || v.kind === "replaced") {
      this.latchRemoved(op.stubId, v.kind === "removed" ? REMOVED_MESSAGE : CHANGED_MESSAGE, v.kind === "removed" ? "project_removed" : "project_changed");
      return this.ops.get(runId) ?? null;
    }
    if (v.kind === "conflict") return this.finish(runId, { phase: "discarded", code: "version_conflict", message: CONFLICT_MESSAGE });
    if (v.kind === "unverifiable") return this.finish(runId, { phase: "ready", code: "art_unverifiable", message: UNVERIFIABLE_MESSAGE });
    const { art } = entry.candidate;
    entry.candidate = undefined;
    // an explicit Apply on an unreadable store changes the open editor only: it writes nothing, so nothing can be erased
    return this.commitArt(runId, cur, art, !!op.fallback, undefined, v.kind === "unknown", v.kind === "ok" || v.kind === "peer_selected" ? v.stored : undefined);
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
    if (!op || !entry || !this.isLatest(op) || !RETRYABLE.has(op.phase)) return null;
    return this.start(entry.req);
  }

  canRetry(runId: string): boolean {
    const op = this.ops.get(runId);
    return !!op && this.isLatest(op) && RETRYABLE.has(op.phase) && this.entries.has(runId);
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

  /** Compare the store with what this editor has seen of the project. A removal latches for the session. */
  private watch(stubId: string, transition?: "present" | "absent" | "unknown"): "present" | "absent" | "unknown" | undefined {
    if (transition === "absent" && this.seen.has(stubId)) this.latchRemoved(stubId, REMOVED_MESSAGE, "project_removed");
    const p = this.host.presence?.(stubId);
    if (p === "present") this.seen.add(stubId);
    else if (p === "absent" && this.seen.has(stubId)) this.latchRemoved(stubId, REMOVED_MESSAGE, "project_removed");
    return p;
  }

  /**
   * This editor's own sync just wrote the merged wall. Where it moved one of this draft's inline pictures to a file, remember
   * the reference it wrote, so the same version is not mistaken for a conflicting body when its picture cannot be compared
   * byte for byte. Only a version whose every other field already matches, only an inline draft picture, only a stored
   * `/api/files/` reference; a later change to that reference voids it.
   */
  private attestSync(): void {
    const cur = this.host.current();
    if (!this.attached || !cur || !this.host.presence) return;
    const read = readStoredStub(cur.id);
    if (read.status !== "present") return;
    const have = new Map((read.stub.versions ?? []).map((v) => [v.id, v]));
    for (const v of cur.versions) {
      const other = have.get(v.id);
      if (!other || !other.art.src || !v.art.src?.startsWith("data:") || !other.art.src.startsWith("/api/files/")) continue;
      if (compareVersions(v, other) === "unverifiable") this.attested.set(`${cur.id}\u0000${v.id}`, other.art.src);
    }
  }

  private attestedFor(stubId: string): (versionId: string) => string | undefined {
    return (versionId) => this.attested.get(`${stubId}\u0000${versionId}`);
  }

  /** The project was seen removed or replaced: retire its live operations for good, for this editor session. */
  private latchRemoved(stubId: string, message: string, code: string): void {
    this.removed.add(stubId);
    for (const op of [...this.ops.values()]) {
      if (op.stubId !== stubId || (op.phase !== "pending" && op.phase !== "ready")) continue;
      this.entries.get(op.runId)?.ac.abort();
      this.finish(op.runId, { phase: "discarded", code, message });
    }
  }

  /**
   * Immediately before a write, what is stored compared with this draft; independent of any event or queue.
   * removed: absent (or queued for deletion). replaced: no version in common, so a different project holds the id.
   * conflict: the same version id with a different body. unknown: the store cannot be read (never a removal).
   * peer_selected: another editor selected a version this one has never seen (never silently switched).
   * ok: carries the stored project so its versions are kept alongside this draft's, own unsaved ones included.
   * A host without a store has nothing to check.
   */
  private inspect(stubId: string, cur: Stub):
    | { kind: "ok"; stored?: Stub }
    | { kind: "removed" | "replaced" | "unknown" }
    | { kind: "conflict" | "unverifiable"; versionId: string }
    | { kind: "peer_selected"; stored: Stub } {
    if (!this.host.presence) return { kind: "ok" };
    if (this.host.isGone(stubId)) return { kind: "removed" };
    const read = readStoredStub(stubId);
    if (read.status === "unknown") return { kind: "unknown" };
    if (read.status !== "present") return { kind: "removed" };
    const stored = read.stub;
    const r = reconcileVersions(cur.versions, stored.versions ?? [], this.attestedFor(stubId));
    if (r.status === "replaced") return { kind: "replaced" };
    if (r.status === "conflict") return { kind: "conflict", versionId: r.versionId };
    if (r.status === "unverifiable") return { kind: "unverifiable", versionId: r.versionId };
    return r.peerOnly.includes(stored.currentVersionId) ? { kind: "peer_selected", stored } : { kind: "ok", stored };
  }

  /** The current draft, when this operation may still write to it: it is the open project, and not seen removed. */
  private guard(op: GenerationOp): Stub | null {
    const cur = this.host.current();
    if (!this.attached || !cur || cur.id !== op.stubId) return null;
    this.watch(op.stubId);
    if (this.removed.has(op.stubId) || this.host.isGone(op.stubId)) return null;
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
    const v = this.inspect(op.stubId, cur);
    if (v.kind === "removed" || v.kind === "replaced") {
      this.latchRemoved(op.stubId, v.kind === "removed" ? REMOVED_MESSAGE : CHANGED_MESSAGE, v.kind === "removed" ? "project_removed" : "project_changed");
      return;
    }
    if (v.kind === "conflict") {
      this.finish(runId, { phase: "discarded", code: "version_conflict", message: CONFLICT_MESSAGE });
      return;
    }
    if (v.kind === "unverifiable") {
      entry.candidate = produced;
      this.finish(runId, { phase: "ready", fallback, code: "art_unverifiable", message: UNVERIFIABLE_MESSAGE });
      return;
    }
    if (v.kind === "peer_selected") {
      entry.candidate = produced;
      this.finish(runId, { phase: "ready", fallback, code: "peer_selected", message: PEER_SELECTED_MESSAGE });
      return;
    }
    if (v.kind === "unknown") {
      // storage cannot be read: "saved" and "removed" cannot be told apart, and a write could erase other projects. Never call it
      // deleted, never write; keep the result for an explicit, honest Apply.
      entry.candidate = produced;
      this.finish(runId, { phase: "ready", fallback, message: UNREADABLE_HOLD_MESSAGE });
      return;
    }
    this.commitArt(runId, cur, produced.art, fallback, produced.limitNote, false, v.kind === "ok" ? v.stored : undefined);
  }

  private commitArt(runId: string, cur: Stub, art: ArtLayer, fallback: boolean, limitNote?: string, memoryOnly = false, stored?: Stub): GenerationOp {
    // art-only: the new version is built from the CURRENT draft, so every other field stays as the person left it
    let next = addArtVersion(cur, art);
    // ...and every version the stored project already has (another editor's, saved meanwhile) is kept alongside it
    if (stored && !memoryOnly) {
      const merged = reconcileVersions(next.versions, stored.versions ?? [], this.attestedFor(cur.id));
      if (merged.status === "ok") next = { ...next, versions: merged.versions };
    }
    const saved = this.host.commit(next, memoryOnly ? { persist: false } : undefined);
    if (memoryOnly) {
      return this.finish(runId, {
        phase: "applied",
        fallback,
        saved: false,
        message: "New art applied in this open editor only. This device's storage can't be read right now, so it is NOT saved. The earlier look stays in Versions.",
      });
    }
    const lead = fallback ? `${limitNote ?? "The daily limit was reached."} No generated image was made; procedural art was applied instead.` : "New art applied.";
    return this.finish(runId, {
      phase: "applied",
      fallback,
      saved,
      message: `${lead} The earlier look stays in Versions.${saved ? "" : " It could not be saved on this device: it exists only in this open editor."}`,
    });
  }

  private discardGone(runId: string): GenerationOp {
    const was = this.ops.get(runId)!;
    if (was.phase !== "pending" && was.phase !== "ready") return was; // already retired (e.g. removal seen first)
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
