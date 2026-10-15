import "server-only";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProdigiPendingReconciliation,
  ProdigiReconciledOrderState,
  ProdigiReconciliationStore,
} from "../vendor/fulfillment-connectors/dist/prodigi-callbacks.js";
import type { TrustedScope } from "../vendor/fulfillment-connectors/dist/types.js";

// The durable ProdigiReconciliationStore (fulfillment-connectors docs/prodigi-callbacks.md, "Store and retention"),
// on the app's SQLite database. Each compare-and-set is one conditional statement, so it is atomic across every
// connection and process sharing the file, and it survives a restart. Tables: prodigi-migrations.ts.

export interface SqliteProdigiStoreOptions {
  /** Replay-record cap, oldest first. 1..1000000, default 10000. */
  readonly maxReplayRecords?: number;
  readonly clock?: { now(): number };
}

const ms = (iso: string, what: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid ${what}`);
  return t;
};

export class SqliteProdigiStore implements ProdigiReconciliationStore {
  private readonly maxReplayRecords: number;
  private readonly clock: { now(): number };

  constructor(private readonly db: DatabaseSync, options: SqliteProdigiStoreOptions = {}) {
    const cap = options.maxReplayRecords ?? 10_000;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1_000_000) throw new Error("invalid maxReplayRecords");
    this.maxReplayRecords = cap;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  async hasEvent(input: { readonly scope: TrustedScope; readonly orderId: string; readonly eventId: string }): Promise<boolean> {
    const { tenantId, projectId } = input.scope;
    const row = this.db
      .prepare("SELECT expires_at FROM prodigi_callback_events WHERE tenant_id = ? AND project_id = ? AND order_id = ? AND event_id = ?")
      .get(tenantId, projectId, input.orderId, input.eventId) as { expires_at: number } | undefined;
    return row !== undefined && Number(row.expires_at) > this.clock.now();
  }

  async recordEvent(input: { readonly scope: TrustedScope; readonly orderId: string; readonly eventId: string; readonly expiresAt: string }): Promise<void> {
    const expiresAt = ms(input.expiresAt, "expiry");
    const { tenantId, projectId } = input.scope;
    this.tx(() => {
      // Re-recording moves the event to the newest position, like the reference store.
      this.db.prepare("DELETE FROM prodigi_callback_events WHERE tenant_id = ? AND project_id = ? AND order_id = ? AND event_id = ?")
        .run(tenantId, projectId, input.orderId, input.eventId);
      this.db.prepare("INSERT INTO prodigi_callback_events (tenant_id, project_id, order_id, event_id, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(tenantId, projectId, input.orderId, input.eventId, expiresAt);
      this.db.prepare("DELETE FROM prodigi_callback_events WHERE expires_at <= ?").run(this.clock.now());
      const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM prodigi_callback_events").get() as { n: number };
      const over = Number(n) - this.maxReplayRecords;
      if (over > 0) {
        this.db.prepare("DELETE FROM prodigi_callback_events WHERE seq IN (SELECT seq FROM prodigi_callback_events ORDER BY seq LIMIT ?)").run(over);
      }
    });
  }

  async getOrder(input: { readonly scope: TrustedScope; readonly orderId: string }): Promise<ProdigiReconciledOrderState | undefined> {
    const { tenantId, projectId } = input.scope;
    const row = this.db
      .prepare("SELECT state FROM prodigi_orders WHERE tenant_id = ? AND project_id = ? AND order_id = ?")
      .get(tenantId, projectId, input.orderId) as { state: string } | undefined;
    return row ? (Object.freeze(JSON.parse(row.state)) as ProdigiReconciledOrderState) : undefined;
  }

  async compareAndSetOrder(input: {
    readonly scope: TrustedScope;
    readonly orderId: string;
    readonly expectedRevision: number | null;
    readonly next: ProdigiReconciledOrderState;
  }): Promise<boolean> {
    const { tenantId, projectId } = input.scope;
    if (input.next.orderId !== input.orderId || !Number.isSafeInteger(input.next.revision)) throw new Error("invalid order state");
    const state = JSON.stringify(input.next);
    const now = this.clock.now();
    const res = input.expectedRevision === null
      ? this.db.prepare("INSERT OR IGNORE INTO prodigi_orders (tenant_id, project_id, order_id, revision, state, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(tenantId, projectId, input.orderId, input.next.revision, state, now)
      : this.db.prepare("UPDATE prodigi_orders SET revision = ?, state = ?, updated_at = ? WHERE tenant_id = ? AND project_id = ? AND order_id = ? AND revision = ?")
        .run(input.next.revision, state, now, tenantId, projectId, input.orderId, input.expectedRevision);
    return Number(res.changes) === 1;
  }

  async getPendingReconciliation(input: { readonly scope: TrustedScope; readonly orderId: string }): Promise<ProdigiPendingReconciliation | undefined> {
    const { tenantId, projectId } = input.scope;
    const row = this.db
      .prepare("SELECT record FROM prodigi_pending WHERE tenant_id = ? AND project_id = ? AND order_id = ?")
      .get(tenantId, projectId, input.orderId) as { record: string } | undefined;
    return row ? (Object.freeze(JSON.parse(row.record)) as ProdigiPendingReconciliation) : undefined;
  }

  async compareAndSetPendingReconciliation(input: {
    readonly scope: TrustedScope;
    readonly orderId: string;
    readonly expectedRevision: number | null;
    readonly next: ProdigiPendingReconciliation | null;
  }): Promise<boolean> {
    const { tenantId, projectId } = input.scope;
    const { next, expectedRevision } = input;
    if (next === null) {
      if (expectedRevision === null) {
        // "Delete if absent": succeeds only when there is nothing there.
        return !this.db.prepare("SELECT 1 AS x FROM prodigi_pending WHERE tenant_id = ? AND project_id = ? AND order_id = ?").get(tenantId, projectId, input.orderId);
      }
      const res = this.db.prepare("DELETE FROM prodigi_pending WHERE tenant_id = ? AND project_id = ? AND order_id = ? AND revision = ?")
        .run(tenantId, projectId, input.orderId, expectedRevision);
      return Number(res.changes) === 1;
    }
    if (next.orderId !== input.orderId || !Number.isSafeInteger(next.revision)) throw new Error("invalid pending record");
    const staleAt = ms(next.staleAt, "staleAt");
    const record = JSON.stringify(next);
    // Only for a tracked order: the INSERT selects from prodigi_orders, so an untracked order writes nothing.
    const res = expectedRevision === null
      ? this.db.prepare(
        "INSERT OR IGNORE INTO prodigi_pending (tenant_id, project_id, order_id, revision, stale_at, record) " +
          "SELECT tenant_id, project_id, order_id, ?, ?, ? FROM prodigi_orders WHERE tenant_id = ? AND project_id = ? AND order_id = ?",
      ).run(next.revision, staleAt, record, tenantId, projectId, input.orderId)
      : this.db.prepare("UPDATE prodigi_pending SET revision = ?, stale_at = ?, record = ? WHERE tenant_id = ? AND project_id = ? AND order_id = ? AND revision = ?")
        .run(next.revision, staleAt, record, tenantId, projectId, input.orderId, expectedRevision);
    return Number(res.changes) === 1;
  }

  async countPendingReconciliations(input: { readonly scope: TrustedScope; readonly now: string }): Promise<number> {
    const { n } = this.db
      .prepare("SELECT COUNT(*) AS n FROM prodigi_pending WHERE tenant_id = ? AND project_id = ? AND stale_at > ?")
      .get(input.scope.tenantId, input.scope.projectId, ms(input.now, "now")) as { n: number };
    return Number(n);
  }

  /** Row counts, for tests and diagnostics. */
  stats(): { orders: number; replayRecords: number; pendingReconciliations: number } {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return { orders: count("prodigi_orders"), replayRecords: count("prodigi_callback_events"), pendingReconciliations: count("prodigi_pending") };
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
