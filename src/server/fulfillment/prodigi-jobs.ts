import "server-only";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ProdigiCallbackError,
  type ProdigiCallbackReconciler,
  type ProdigiReconcileAbandonedEvent,
  type ProdigiReconcileJob,
  type ProdigiReconciliationScheduler,
} from "../vendor/fulfillment-connectors/dist/prodigi-callbacks.js";

// A durable scheduler for the Prodigi reconciler: jobs are rows in prodigi_jobs (same database as the store), and
// an in-process worker loop runs them when due. It is `durable: true`, so the reconciler answers a deferred callback
// with 202 and owes the read to this queue (docs/prodigi-callbacks.md, "Durable pending records").
//
// - schedule() inserts a row due at now + job.delayMs. Every schedule is a new row: the reconciler collapses
//   duplicates itself (superseded / obsolete), and a resumed chain may reuse the running job's attempt number, so
//   rows are never merged or dropped in favour of an older one.
// - Rows carry the deployment environment. Preview and Publish share one database on Plus Launch, and a queue
//   only ever inserts, claims, lists or releases its own environment's rows.
// - A worker leases one due row at a time, right before running it (BEGIN IMMEDIATE, so two workers never take the
//   same row), so a long batch can never outrun a lease. It deletes a row only when its run returns. If the run throws (store blip, abandon hook failure, schedule failure) the row is released with
//   a backoff and retried. If the process dies, the lease runs out and any worker takes the row again: jobs survive
//   a restart.
// - The abandon hook stores an alert and queues a poll (reconcileOrder) in one transaction, and logs one line.

export type ProdigiJobKind = "reconcile" | "poll" | "track";

export interface ProdigiJobRow {
  id: number;
  kind: ProdigiJobKind;
  orderId: string;
  payload: Record<string, unknown>;
  dueAt: number;
  runs: number;
}

export interface ProdigiJobQueueOptions {
  /** The deployment environment whose rows this queue owns. */
  readonly environment: string;
  readonly clock?: { now(): number };
  /** How long a leased row is held before another worker may take it. Longer than any one run. Default 5 min. */
  readonly leaseMs?: number;
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

export class SqliteProdigiJobQueue implements ProdigiReconciliationScheduler {
  readonly durable = true;
  readonly leaseMs: number;
  readonly environment: string;
  private readonly clock: { now(): number };

  constructor(private readonly db: DatabaseSync, options: ProdigiJobQueueOptions) {
    if (!/^[a-z]{1,32}$/.test(options.environment)) throw new Error("invalid environment");
    this.environment = options.environment;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
  }

  /** The reconciler's scheduler port. Throws if the row cannot be written, so the reconciler rolls back (reconcile_failed). */
  schedule(job: ProdigiReconcileJob): void {
    const delay = Number.isFinite(job.delayMs) && job.delayMs > 0 ? Math.ceil(job.delayMs) : 0;
    this.enqueue("reconcile", job.orderId, { ...job }, delay);
  }

  enqueue(kind: ProdigiJobKind, orderId: string, payload: Record<string, unknown>, delayMs = 0): number {
    const now = this.clock.now();
    const res = this.db
      .prepare("INSERT INTO prodigi_jobs (environment, kind, order_id, payload, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.environment, kind, orderId, JSON.stringify(payload), now + Math.max(0, delayMs), now);
    return Number(res.lastInsertRowid);
  }

  /**
   * Leases the next due row of this environment to `owner`, or returns null. One row per call: the worker claims
   * each row right before running it, so the lease always starts when the run does. A row whose lease ran out is
   * due again.
   */
  claimOne(owner: string): ProdigiJobRow | null {
    const now = this.clock.now();
    const due = "environment = ? AND due_at <= ? AND (lease_until IS NULL OR lease_until <= ?)";
    // The loop asks every second; take the write lock only when something is due.
    if (!this.db.prepare(`SELECT 1 AS x FROM prodigi_jobs WHERE ${due} LIMIT 1`).get(this.environment, now, now)) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db.prepare(`SELECT id, kind, order_id, payload, due_at, runs FROM prodigi_jobs WHERE ${due} ORDER BY due_at, id LIMIT 1`)
        .get(this.environment, now, now) as { id: number; kind: ProdigiJobKind; order_id: string; payload: string; due_at: number; runs: number } | undefined;
      if (r) this.db.prepare("UPDATE prodigi_jobs SET lease_owner = ?, lease_until = ?, runs = runs + 1 WHERE id = ?").run(owner, now + this.leaseMs, r.id);
      this.db.exec("COMMIT");
      return r ? { id: Number(r.id), kind: r.kind, orderId: r.order_id, payload: JSON.parse(r.payload), dueAt: Number(r.due_at), runs: Number(r.runs) + 1 } : null;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The run returned: the row is done. Only the lease holder may delete it. */
  complete(id: number, owner: string): boolean {
    return Number(this.db.prepare("DELETE FROM prodigi_jobs WHERE id = ? AND environment = ? AND lease_owner = ?").run(id, this.environment, owner).changes) === 1;
  }

  /** The run threw: release the row with a capped exponential backoff, so the queue retries it. */
  release(id: number, owner: string, runs: number, errorCode: string): boolean {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(runs - 1, 0), 16));
    return Number(this.db.prepare(
      "UPDATE prodigi_jobs SET lease_owner = NULL, lease_until = NULL, due_at = ?, last_error = ? WHERE id = ? AND environment = ? AND lease_owner = ?",
    ).run(this.clock.now() + delay, errorCode.slice(0, 64), id, this.environment, owner).changes) === 1;
  }

  /** This environment's rows, for tests and diagnostics. */
  list(): { id: number; kind: ProdigiJobKind; orderId: string; dueAt: number; leased: boolean; runs: number; lastError: string | null }[] {
    const now = this.clock.now();
    return (this.db.prepare("SELECT id, kind, order_id, due_at, lease_until, runs, last_error FROM prodigi_jobs WHERE environment = ? ORDER BY due_at, id").all(this.environment) as Record<string, unknown>[])
      .map((r) => ({
        id: Number(r.id),
        kind: r.kind as ProdigiJobKind,
        orderId: r.order_id as string,
        dueAt: Number(r.due_at),
        leased: r.lease_until !== null && Number(r.lease_until) > now,
        runs: Number(r.runs),
        lastError: (r.last_error as string | null) ?? null,
      }));
  }
}

// ---- alerts ----

export interface ProdigiAlert {
  environment: string;
  dedupeKey: string;
  orderId: string;
  reason: string;
  errorCode: string | null;
  attempts: number;
  requiredStage: string | null;
  coverAfter: string;
  firstReceivedAt: string;
  abandonedAt: string;
  createdAt: number;
  pollStatus: string;
  polledAt: number | null;
  pollError: string | null;
}

/**
 * The reconciler's onReconcileAbandoned hook. A 202 told Prodigi not to redeliver, so this hook and the poller own
 * the event: it stores the alert and queues a poll (reconcileOrder) in one transaction, then logs one line with
 * codes and IDs only. Delivery is at least once; the alert's primary key is the event's dedupeKey, so a repeat
 * neither duplicates the alert nor queues a second poll. If the write fails the hook throws, the reconciler keeps
 * the pending record, and the queue retries the job.
 */
export function abandonAlertHook(db: DatabaseSync, queue: SqliteProdigiJobQueue, options: { clock?: { now(): number }; log?: (line: string) => void } = {}) {
  const clock = options.clock ?? { now: () => Date.now() };
  const log = options.log ?? ((line: string) => console.warn(line));
  return (event: ProdigiReconcileAbandonedEvent): void => {
    let fresh = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      const res = db.prepare(
        "INSERT OR IGNORE INTO prodigi_alerts (environment, dedupe_key, order_id, reason, error_code, attempts, required_stage, cover_after, first_received_at, abandoned_at, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        queue.environment, event.dedupeKey, event.orderId, event.reason, event.errorCode ?? null, event.attempts, event.requiredStage,
        event.coverAfter, event.firstReceivedAt, event.abandonedAt, clock.now(),
      );
      fresh = Number(res.changes) === 1;
      if (fresh) queue.enqueue("poll", event.orderId, { dedupeKey: event.dedupeKey });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    log(`[prodigi] reconcile_abandoned order=${event.orderId} reason=${event.reason}${event.errorCode ? ` error=${event.errorCode}` : ""} attempts=${event.attempts}${fresh ? " poll=queued" : " repeat"}`);
  };
}

/**
 * An order exists at Prodigi but neither trackOrder nor its durable track job could be written (the database was
 * failing). Best effort: if this write fails too, the caller's explicit error is all that is left.
 */
export function recordTrackFailedAlert(db: DatabaseSync, environment: string, orderId: string, now: number): boolean {
  const at = new Date(now).toISOString();
  const res = db.prepare(
    "INSERT OR IGNORE INTO prodigi_alerts (environment, dedupe_key, order_id, reason, error_code, attempts, required_stage, cover_after, first_received_at, abandoned_at, created_at, poll_status) " +
      "VALUES (?, ?, ?, 'track_failed', NULL, 0, NULL, ?, ?, ?, ?, 'not_queued')",
  ).run(environment, `${orderId}|track_failed`, orderId, at, at, at, now);
  return Number(res.changes) === 1;
}

export function listProdigiAlerts(db: DatabaseSync, environment: string): ProdigiAlert[] {
  return (db.prepare("SELECT * FROM prodigi_alerts WHERE environment = ? ORDER BY created_at, dedupe_key").all(environment) as Record<string, unknown>[]).map((r) => ({
    environment: r.environment as string,
    dedupeKey: r.dedupe_key as string,
    orderId: r.order_id as string,
    reason: r.reason as string,
    errorCode: (r.error_code as string | null) ?? null,
    attempts: Number(r.attempts),
    requiredStage: (r.required_stage as string | null) ?? null,
    coverAfter: r.cover_after as string,
    firstReceivedAt: r.first_received_at as string,
    abandonedAt: r.abandoned_at as string,
    createdAt: Number(r.created_at),
    pollStatus: r.poll_status as string,
    polledAt: r.polled_at === null ? null : Number(r.polled_at),
    pollError: (r.poll_error as string | null) ?? null,
  }));
}

// ---- worker ----

export interface ProdigiWorkerOptions {
  readonly db: DatabaseSync;
  readonly queue: SqliteProdigiJobQueue;
  readonly reconciler: ProdigiCallbackReconciler;
  readonly clock?: { now(): number };
  readonly workerId?: string;
  /** How often the loop looks for due rows. Default 1 s. */
  readonly intervalMs?: number;
  /** Rows run per tick, each claimed (and leased) right before it runs. Default 8. */
  readonly batch?: number;
  readonly log?: (line: string) => void;
}

const errorCodeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unexpected";
};

export class ProdigiJobWorker {
  readonly workerId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private readonly clock: { now(): number };
  private readonly log: (line: string) => void;

  constructor(private readonly options: ProdigiWorkerOptions) {
    this.workerId = options.workerId ?? `w_${process.pid}_${randomBytes(4).toString("hex")}`;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.log = options.log ?? ((line: string) => console.warn(line));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.options.intervalMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs every due row once (one tick at a time). Returns how many rows it ran. */
  tick(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<number> {
    const { queue } = this.options;
    let ran = 0;
    for (; ran < (this.options.batch ?? 8); ran++) {
      let row: ProdigiJobRow | null;
      try {
        row = queue.claimOne(this.workerId);
      } catch (e) {
        this.log(`[prodigi] job claim failed: ${errorCodeOf(e)}`);
        break;
      }
      if (!row) break;
      try {
        await this.run(row);
        queue.complete(row.id, this.workerId);
      } catch (e) {
        const code = errorCodeOf(e);
        // A job the reconciler rejects as malformed will never succeed: drop it and say so.
        if (e instanceof ProdigiCallbackError && e.code === "invalid_input") {
          queue.complete(row.id, this.workerId);
          this.log(`[prodigi] ${row.kind} job ${row.id} dropped: invalid_input`);
          continue;
        }
        queue.release(row.id, this.workerId, row.runs, code);
        this.log(`[prodigi] ${row.kind} job ${row.id} order=${row.orderId} failed (${code}) on run ${row.runs}; retrying`);
      }
    }
    return ran;
  }

  private async run(row: ProdigiJobRow): Promise<void> {
    const { reconciler, db } = this.options;
    if (row.kind === "reconcile") {
      await reconciler.runScheduledReconciliation(row.payload as unknown as ProdigiReconcileJob);
      return;
    }
    if (row.kind === "track") {
      // An order created while trackOrder failed: track it now, then read once, because callbacks answered
      // untracked_expired in the meantime caused no read (docs/prodigi-callbacks.md, "Tracking").
      await reconciler.trackOrder(row.orderId);
      const result = await reconciler.reconcileOrder(row.orderId);
      if (result.status === "read_failed" || result.status === "retries_exhausted") {
        this.log(`[prodigi] track job order=${row.orderId} tracked; first read ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}`);
      }
      return;
    }
    // poll: reconcileOrder once. Queued for an abandoned chain (the alert keeps the outcome), and after each created
    // order as a delayed read-back, so an early callback answered not_tracked is covered even if never redelivered.
    const result = await reconciler.reconcileOrder(row.orderId);
    const dedupeKey = typeof row.payload.dedupeKey === "string" ? row.payload.dedupeKey : null;
    if (dedupeKey) {
      db.prepare("UPDATE prodigi_alerts SET poll_status = ?, polled_at = ?, poll_error = ? WHERE environment = ? AND dedupe_key = ?")
        .run(result.status, this.clock.now(), result.errorCode ?? null, this.options.queue.environment, dedupeKey);
    }
    if (result.status === "read_failed" || result.status === "retries_exhausted") {
      this.log(`[prodigi] poll order=${row.orderId} ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}${dedupeKey ? "; alert stays open" : ""}`);
    }
  }
}
