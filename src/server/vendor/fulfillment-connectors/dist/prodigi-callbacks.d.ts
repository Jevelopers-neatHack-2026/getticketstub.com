import { type ServerSecretSource } from "./security.js";
import { type ProdigiOrderObservation, type ProdigiOrderStage, type ProdigiSandboxErrorCode, type ProdigiStepState } from "./prodigi-sandbox.js";
import type { StatusResult, TrustedScope } from "./types.js";
/**
 * Prodigi v4 callback intake and authenticated reconciliation.
 *
 * The public v4 reference (https://www.prodigi.com/print-api/docs/reference/#callbacks,
 * checked 2026-10-11) documents callbacks as CloudEvents 1.0 JSON posted to a
 * merchant-chosen `callbackUrl`. It documents no signature, HMAC, shared
 * secret, signing header, source IP list or retry policy. A callback is
 * therefore never treated as provider-authenticated here:
 *
 * 1. The containing application may embed a server-held capability token in
 *    the callback URL it registers. The token is resolved through the secret
 *    reference port at call time and compared in constant time. It only keeps
 *    anonymous senders out; it is not provider authenticity (Prodigi echoes
 *    `callbackUrl` in order objects, so anyone with order read access can see it).
 * 2. A callback that passes the token gate is an untrusted *hint*: only the
 *    event ID, order ID (`subject`), event type and time are kept. The embedded
 *    order object (`data`, which includes the recipient) is discarded unread.
 * 3. The order state changes only from an authenticated `GET /v4.0/orders/{id}`
 *    read through the sandbox adapter, applied with monotonic ordering checks
 *    so a stale or reordered read cannot regress it.
 *
 * A callback is acknowledged (2xx) only when an authenticated read that
 * started after the callback was received (our clock) has been applied, or a
 * durable job owing such a read is persisted in the store. The request does at
 * most one quick, single-flight, rate-limited read under a hard deadline;
 * anything else is recorded as a pending reconciliation in the store and run
 * outside the request with jittered backoff. Nothing is recorded for an event
 * until an authenticated read covering it has been applied.
 *
 * Callbacks are disabled by default, and only sandbox mode is accepted.
 */
export type ProdigiCallbackErrorCode = "invalid_config" | "live_refused" | "callbacks_disabled" | "callback_forged" | "callback_token_unavailable" | "callback_invalid" | "callback_oversized" | "callback_source_mismatch" | "invalid_input" | "store_unavailable" | "deadline_exceeded";
export declare class ProdigiCallbackError extends Error {
    readonly code: ProdigiCallbackErrorCode;
    constructor(code: ProdigiCallbackErrorCode);
}
/**
 * Documented stage-change callback types. The v4 reference documents the
 * `com.prodigi.order.status.stage.changed#<Stage>` shape (its example is
 * `#InProgress`) and the order stages `InProgress`, `Complete` and `Cancelled`.
 * Only these name a stage (`claimedStage`).
 */
export declare const PRODIGI_CALLBACK_EVENT_TYPES: readonly string[];
/**
 * Prefix of every order callback type. The reference says callbacks are sent
 * "when an order's stage changes or when a shipment is made" and defines `type`
 * as `com.prodigi.` + object + path to the changed nested object + `#` + new
 * value, but gives no shipment type string. Any well-formed `com.prodigi.order.*`
 * type (stage changes and shipments) may therefore trigger one bounded read;
 * other objects are `ignored_type`.
 */
export declare const PRODIGI_ORDER_CALLBACK_TYPE_PREFIX = "com.prodigi.order.";
/** Whether a well-formed callback type may trigger an authenticated read. */
export declare function isProdigiOrderCallbackType(type: string): boolean;
export declare const PRODIGI_SANDBOX_CALLBACK_SOURCE = "https://api.sandbox.prodigi.com/v4.0/Orders/";
/** The only fields kept from a callback. Nothing here is provider evidence. */
export interface ProdigiCallbackHint {
    readonly eventId: string;
    readonly orderId: string;
    readonly type: string;
    /** Stage named by a `stage.changed#<Stage>` type, otherwise null. Untrusted. */
    readonly claimedStage: ProdigiOrderStage | null;
    readonly eventTime: string;
}
/**
 * Parse a Prodigi CloudEvent body into a bounded hint. `data` (the full order,
 * including the recipient) is only checked for a matching `id` and is not kept.
 */
export declare function parseProdigiCallbackEvent(rawBody: Uint8Array): ProdigiCallbackHint;
declare const DETAIL_KEYS: readonly ["downloadAssets", "printReadyAssetsPrepared", "allocateProductionLocation", "inProduction", "shipping"];
/** Last authoritative state for one order. Only authenticated reads write it. */
export interface ProdigiReconciledOrderState {
    readonly orderId: string;
    /** Compare-and-set revision, starting at 0 when the order is tracked. */
    readonly revision: number;
    /** Null until the first authenticated read. */
    readonly stage: ProdigiOrderStage | null;
    readonly normalizedState: StatusResult["normalizedState"] | "pending";
    readonly details: Readonly<Record<(typeof DETAIL_KEYS)[number], ProdigiStepState>> | null;
    readonly shipmentIds: readonly string[];
    readonly lastUpdated: string | null;
    readonly observationDigest: string | null;
    readonly reconciledAt: string | null;
    /**
     * Start time, on our own clock, of the latest authenticated read whose
     * result was applied or matched the stored state. A callback received
     * strictly before this is covered. Prodigi's event `time` is never compared
     * with it. Null until such a read. Callback content never sets it.
     */
    readonly confirmedAt: string | null;
    /** Set when an authenticated read contradicted a terminal stage; the read was not applied. */
    readonly conflict: boolean;
}
export type ProdigiOrderingDecision = "apply" | "unchanged" | "stale" | "regression" | "terminal_conflict";
/**
 * Decide whether an authenticated observation may replace the stored state.
 * Terminal disagreement is evaluated first, so `Complete` versus `Cancelled`
 * is always a conflict, never hidden as `stale` or selected by timestamp. A
 * strictly older `lastUpdated` is then stale. A terminal stage cannot move
 * back to `InProgress`. Within `InProgress`, no step and no shipment may go
 * backwards.
 */
export declare function decideProdigiOrdering(current: ProdigiReconciledOrderState | undefined, observation: ProdigiOrderObservation): ProdigiOrderingDecision;
/**
 * Durable record that a background reconciliation is owed for one order.
 * It lives in the store, not in process memory, so whichever worker runs the
 * job (or a worker after a restart) sees and clears it.
 */
export interface ProdigiPendingReconciliation {
    readonly orderId: string;
    /** Compare-and-set revision. */
    readonly revision: number;
    /**
     * Newest local receipt time (ISO, our clock) of a callback this job owes a
     * read to. Only a read that starts strictly after it covers the job.
     */
    readonly coverAfter: string;
    /** Highest stage claimed by a merged callback; the covering read must reach it. Untrusted, so it only ever causes more reads. */
    readonly requiredStage: ProdigiOrderStage | null;
    /** Receipt time of the oldest callback in this chain (informational). */
    readonly firstReceivedAt: string;
    /**
     * Start of the current retry budget. It is reset to the receipt time
     * whenever a newer receipt is merged, so every uncovered receipt gets a full
     * budget of its own. `horizonMs` is measured from it.
     */
    readonly budgetSince: string;
    /** Reads performed (and not covering) in the current budget; counted against `maxAttempts`. Local refusals do not count. */
    readonly readsSpent: number;
    /** Local refusals (limiter, read interval, older in-flight read) in the current budget; only used for backoff. */
    readonly refusals: number;
    /**
     * Set while a worker is reporting this record as abandoned. The worker that
     * set it (by compare-and-set) calls the hook and then deletes the record.
     * After `leaseUntil` another run may take it over, so a crash keeps the
     * obligation (at-least-once). Null otherwise.
     */
    readonly abandoning: {
        /** Unique per claim, so a takeover is never mistaken for a merge. */
        readonly claimId: string;
        readonly reason: ProdigiAbandonReason;
        readonly errorCode: ProdigiReconcileErrorCode | null;
        readonly leaseUntil: string;
        /** The requirement being reported. A newer merged receipt or claim makes a retry or takeover resume instead. */
        readonly coverAfter: string;
        readonly requiredStage: ProdigiOrderStage | null;
        /** Reads spent in the reported budget, including the one that triggered the abandonment. */
        readonly readsSpent: number;
    } | null;
    /**
     * Event IDs merged into this record (at most 32). When a covering read
     * clears the record they are recorded as reconciled, so their redeliveries
     * are `replayed`. Event IDs beyond the cap only cost a read on redelivery.
     */
    readonly eventIds: readonly string[];
    /** Sequence number of the currently scheduled job (increments on every reschedule; used to collapse duplicates). */
    readonly attempt: number;
    readonly dueAt: string;
    /**
     * After this instant the record is treated as orphaned (its job was lost, for
     * example with the in-process scheduler after a restart): it no longer
     * counts toward `maxPendingJobs`, and the next callback replaces it and
     * schedules a fresh job.
     */
    readonly staleAt: string;
}
/**
 * Replay, order-state and pending-job store. This is the durable interface.
 *
 * - Replay records are keyed on scope, order ID and event ID. They are written
 *   only after an authenticated read covering the event was applied, and only
 *   for tracked orders. Each record carries `expiresAt` (the reconciler's
 *   `replayTtlMs`, default 7 days). An implementation must keep a record until
 *   it expires *or* until a fixed capacity bound evicts it oldest-first, and
 *   must not keep it after it expires. Eviction is safe: a replay record only
 *   saves work.
 * - Order state is written only through `compareAndSetOrder`, which must be
 *   atomic across workers and restarts.
 * - Pending reconciliations are written only through
 *   `compareAndSetPendingReconciliation` (`next: null` deletes), which must be
 *   atomic across workers and restarts. `countPendingReconciliations` counts
 *   one scope's records whose `staleAt` is after `now`.
 * - Nothing is written for an order that was never tracked.
 */
export interface ProdigiReconciliationStore {
    hasEvent(input: {
        readonly scope: TrustedScope;
        readonly orderId: string;
        readonly eventId: string;
    }): Promise<boolean>;
    recordEvent(input: {
        readonly scope: TrustedScope;
        readonly orderId: string;
        readonly eventId: string;
        readonly expiresAt: string;
    }): Promise<void>;
    getOrder(input: {
        readonly scope: TrustedScope;
        readonly orderId: string;
    }): Promise<ProdigiReconciledOrderState | undefined>;
    /** Writes `next` only if the stored revision equals `expectedRevision` (null = absent). */
    compareAndSetOrder(input: {
        readonly scope: TrustedScope;
        readonly orderId: string;
        readonly expectedRevision: number | null;
        readonly next: ProdigiReconciledOrderState;
    }): Promise<boolean>;
    getPendingReconciliation(input: {
        readonly scope: TrustedScope;
        readonly orderId: string;
    }): Promise<ProdigiPendingReconciliation | undefined>;
    /** Writes `next` (or deletes, when `next` is null) only if the stored revision equals `expectedRevision` (null = absent). */
    compareAndSetPendingReconciliation(input: {
        readonly scope: TrustedScope;
        readonly orderId: string;
        readonly expectedRevision: number | null;
        readonly next: ProdigiPendingReconciliation | null;
    }): Promise<boolean>;
    /** Records in `scope` whose `staleAt` is strictly after `now`. */
    countPendingReconciliations(input: {
        readonly scope: TrustedScope;
        readonly now: string;
    }): Promise<number>;
}
export interface InMemoryProdigiReconciliationStore extends ProdigiReconciliationStore {
    /** Entry counts, for tests and diagnostics. */
    stats(): {
        readonly orders: number;
        readonly replayRecords: number;
        readonly pendingReconciliations: number;
    };
}
/**
 * Single-process reference store for tests and local development. It is not
 * durable and gives no cross-process atomicity. Replay records expire at their
 * `expiresAt` and are capped at `maxReplayRecords` (default 10000), evicting
 * the oldest record first. Pending records exist only for tracked orders.
 */
export declare function createInMemoryProdigiReconciliationStore(options?: {
    readonly maxReplayRecords?: number;
    readonly clock?: {
        now(): number;
    };
}): InMemoryProdigiReconciliationStore;
/**
 * Bound on authenticated reads. `tryAcquire` returns a release function when
 * a read may start now, or null when it must be deferred. It never waits.
 * The reconciler passes its tenant ID so a shared limiter can be fair across
 * tenants.
 */
export interface ProdigiReadLimiter {
    tryAcquire(tenantKey?: string): (() => void) | null;
}
/**
 * Token bucket plus a concurrency cap, with a per-tenant sub-budget. A read
 * needs a token from the global bucket *and* from its tenant's bucket, so one
 * tenant's burst can use at most `tenantBurst` of the global burst and
 * `tenantMaxConcurrent` of the concurrency, and other tenants keep the rest.
 * Defaults: 4 concurrent reads, a burst of 10 and 2 reads per second globally;
 * per tenant, half of each (2 concurrent, a burst of 5, 1 read per second).
 * Calls without a tenant key use only the global budget.
 */
export declare function createProdigiReadLimiter(options?: {
    readonly maxConcurrent?: number;
    readonly burst?: number;
    readonly refillPerSecond?: number;
    readonly tenantMaxConcurrent?: number;
    readonly tenantBurst?: number;
    readonly tenantRefillPerSecond?: number;
    readonly clock?: {
        now(): number;
    };
}): ProdigiReadLimiter;
/**
 * Background reconciliation job. It carries the order ID and the receipt time
 * (`coverAfter`, our clock) that the job must cover; the authoritative,
 * possibly newer requirement is the store's `ProdigiPendingReconciliation`.
 * Queues must not drop a job in favor of an older one for the same `key`;
 * the reconciler collapses duplicate jobs itself (`superseded`).
 */
export interface ProdigiReconcileJob {
    readonly key: string;
    readonly orderId: string;
    readonly attempt: number;
    readonly delayMs: number;
    readonly coverAfter: string;
    readonly requiredStage: ProdigiOrderStage | null;
}
/**
 * Runs `ProdigiCallbackReconciler.runScheduledReconciliation(job)` after
 * `job.delayMs`, outside the callback request. `durable: true` means an
 * accepted job survives a restart and runs on some worker; only then may the
 * host acknowledge a deferred callback with 202. If
 * `runScheduledReconciliation` throws (for example, the store is down), a
 * durable queue must retry the job. The default scheduler is in-process timers
 * (`durable: false`).
 */
export interface ProdigiReconciliationScheduler {
    readonly durable: boolean;
    schedule(job: ProdigiReconcileJob): Promise<void> | void;
}
/** The authenticated read used for reconciliation (`ProdigiSandboxClient` satisfies it). */
export interface ProdigiOrderReader {
    getOrder(orderId: string, signal?: AbortSignal): Promise<ProdigiOrderObservation>;
}
export interface ProdigiPollPolicy {
    /** Backoff cap before the second attempt. 1..60000 ms, default 1000. */
    readonly initialDelayMs?: number;
    /** Cap for any single delay. initialDelayMs..300000 ms, default 60000. */
    readonly maxDelayMs?: number;
    /** Total read attempts per `reconcileOrder` call. 1..10, default 5. */
    readonly maxAttempts?: number;
}
/**
 * Retry budget for deferred (background) jobs. `maxAttempts` counts reads
 * that ran and did not cover the record; local refusals (limiter, read
 * interval) do not count and are bounded only by `horizonMs`. Both are
 * measured per budget, and a newly merged receipt starts a fresh budget, so a
 * receipt is never abandoned on another callback's budget. A chain is
 * abandoned, and `reconcile_abandoned` is emitted, once its budget runs out.
 *
 * Defaults with a durable scheduler: 2 s initial, 5 min cap, 40 attempts,
 * a 1 h horizon (full jitter; the horizon binds first). With the in-process
 * scheduler: the poll policy's delays and attempts, and a 10 min horizon
 * (those deferrals were answered with 503, so Prodigi redelivers anyway).
 */
export interface ProdigiJobRetryPolicy {
    /** 1..600000 ms. */
    readonly initialDelayMs?: number;
    /** initialDelayMs..3600000 ms. */
    readonly maxDelayMs?: number;
    /** 1..1000. */
    readonly maxAttempts?: number;
    /** 1000..86400000 ms. */
    readonly horizonMs?: number;
}
export type ProdigiAbandonReason = "retries_exhausted" | "horizon_exceeded" | "read_failed" | "claim_unconfirmed" | "receipt_uncovered" | "schedule_failed";
/**
 * Terminal outcome of a background chain that gave up without covering every
 * callback it owed a read to. The host must route it to the poller
 * (`reconcileOrder`) or an operator; it is never dropped silently.
 */
export interface ProdigiReconcileAbandonedEvent {
    readonly outcome: "reconcile_abandoned";
    readonly scope: TrustedScope;
    readonly orderId: string;
    readonly reason: ProdigiAbandonReason;
    readonly attempts: number;
    readonly coverAfter: string;
    readonly requiredStage: ProdigiOrderStage | null;
    readonly firstReceivedAt: string;
    readonly abandonedAt: string;
    /** Stable across redelivery of the same abandonment (`orderId`, `firstReceivedAt`, `coverAfter`), for at-least-once dedupe. */
    readonly dedupeKey: string;
    readonly errorCode?: ProdigiReconcileErrorCode;
}
export interface ProdigiCallbackReconcilerOptions {
    /** Must be `"sandbox"`. `"live"` (or anything else) is refused at construction. */
    readonly mode: string;
    readonly trustedScope: TrustedScope;
    readonly reader: ProdigiOrderReader;
    readonly store: ProdigiReconciliationStore;
    /** Must be exactly `true` to accept callbacks. Polling works without it. */
    readonly callbacksEnabled?: boolean;
    /** Secret source used to resolve the callback capability token. Required when callbacks are enabled. */
    readonly secrets?: ServerSecretSource;
    /** Host-injected secret reference for the current callback URL token. There is no default binding. */
    readonly callbackTokenReference?: string;
    /** Optional previous token reference, accepted during a rotation window. */
    readonly previousCallbackTokenReference?: string;
    /** Raw body limit, 1..1048576 bytes, default 524288. */
    readonly maxBodyBytes?: number;
    readonly pollPolicy?: ProdigiPollPolicy;
    /** Retry budget for background jobs. Defaults depend on `scheduler.durable`. */
    readonly jobRetryPolicy?: ProdigiJobRetryPolicy;
    /** Hard deadline for in-request work in `handleCallback`. 50..10000 ms, default 2000. */
    readonly requestDeadlineMs?: number;
    /** Timeout for one authenticated read, independent of any request. 100..120000 ms, default 30000. */
    readonly readTimeoutMs?: number;
    /** Minimum time between reads of one order in this process; bursts inside it are coalesced into one follow-up read. 0..600000 ms, default 5000. */
    readonly minReadIntervalMs?: number;
    /** Replay record TTL. 60000..2592000000 ms (30 days), default 604800000 (7 days). */
    readonly replayTtlMs?: number;
    /** Cap on pending reconciliations per scope, counted from the store. 1..100000, default 1000. */
    readonly maxPendingJobs?: number;
    /** How long after its due time a pending record is considered orphaned. 1000..3600000 ms, default max(120000, 2 × readTimeoutMs). */
    readonly pendingJobGraceMs?: number;
    /**
     * Callbacks for an order that was never tracked get 503 so a callback racing
     * `trackOrder` is redelivered. Once the event is older than this (by its
     * `time`), the answer is `untracked_expired`/200 instead, so an order created
     * outside this application is not redelivered forever. 0 disables;
     * otherwise 60000..2592000000 ms. Default 86400000 (24 h).
     */
    readonly untrackedAckAfterMs?: number;
    /**
     * Bound on wall-clock skew between workers that share the store (keep them
     * NTP-synchronized within it). Cross-worker coverage comparisons (stored
     * `confirmedAt` versus a receipt, and a read start versus a stored
     * `coverAfter`) require this margin, so a lagging worker reads rather than
     * skips. Job delays are at least this long. 0..60000 ms, default 2000.
     */
    readonly workerClockSkewMs?: number;
    /** Read bound. Defaults to `createProdigiReadLimiter()` on this reconciler's clock. Called with the tenant ID. */
    readonly readLimiter?: ProdigiReadLimiter;
    /** Background scheduler. Defaults to in-process timers (`durable: false`). */
    readonly scheduler?: ProdigiReconciliationScheduler;
    /**
     * Receives every `reconcile_abandoned` outcome, at least once (dedupe on
     * `dedupeKey`). Required when `scheduler.durable` is true. It is called
     * before the pending record is deleted; if it throws, the record is kept and
     * the error is rethrown from `runScheduledReconciliation`, so the queue
     * retries the job and the hook is called again.
     */
    readonly onReconcileAbandoned?: (event: ProdigiReconcileAbandonedEvent) => void | Promise<void>;
    readonly clock?: {
        now(): number;
    };
    /** Uniform random in [0, 1) for full jitter. Injected for tests. */
    readonly random?: () => number;
    /** Injected for tests; defaults to an abortable timer. Used only by `reconcileOrder` backoff. */
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export type ProdigiReconcileErrorCode = ProdigiSandboxErrorCode | "reader_error" | "read_budget_exhausted" | "store_unavailable";
export type ProdigiReconcileStatus = "applied" | "unchanged" | "stale_rejected" | "regression_rejected" | "terminal_conflict" | "untracked_order" | "retries_exhausted" | "read_failed";
export interface ProdigiReconcileResult {
    readonly status: ProdigiReconcileStatus;
    readonly orderId: string;
    readonly attempts: number;
    /** Delays actually waited between attempts, in ms. */
    readonly delaysMs: readonly number[];
    readonly state: ProdigiReconciledOrderState | undefined;
    readonly errorCode?: ProdigiReconcileErrorCode;
}
/**
 * Callback outcomes and the HTTP status the host should answer with
 * (`recommendedHttpStatus`). A 2xx is given only when a successful
 * authenticated read that started after this callback was received has been
 * applied, or a durable job that will perform such a read is persisted.
 *
 * | outcome | meaning | status |
 * | --- | --- | --- |
 * | `reconciled` | this request's read (started after receipt) was applied | 200 |
 * | `already_reconciled` | another read that started after receipt was already applied | 200 |
 * | `replayed` | the event ID was already reconciled | 200 |
 * | `already_terminal` | the authoritative state is terminal | 200 |
 * | `ignored_type` | not a `com.prodigi.order.*` type | 200 |
 * | `untracked_expired` | never tracked, and older than `untrackedAckAfterMs` | 200 |
 * | `deferred` | a job owing a covering read is recorded in the store | 202 if the scheduler is durable, else 503 |
 * | `not_tracked` | the order is not (yet) tracked; nothing was stored | 503 |
 * | `reconcile_failed` | the read failed or no job could be recorded | 503 |
 */
export type ProdigiCallbackOutcome = "reconciled" | "replayed" | "already_reconciled" | "already_terminal" | "ignored_type" | "untracked_expired" | "deferred" | "not_tracked" | "reconcile_failed";
export interface ProdigiCallbackResult {
    readonly outcome: ProdigiCallbackOutcome;
    readonly trust: "unverified";
    readonly eventId: string;
    readonly orderId: string;
    /** The callback body itself never mutates state; only `reconciliation` does. */
    readonly authoritativeMutationAllowed: false;
    /** 200, 202 or 503. Non-2xx asks Prodigi to redeliver. */
    readonly recommendedHttpStatus: 200 | 202 | 503;
    /** Present with 503. */
    readonly retryAfterSeconds?: number;
    /** Whether a background job owing a covering read is recorded for this order. */
    readonly scheduled: boolean;
    /** Which configured token matched. `previous` means a rotation is still in progress. */
    readonly tokenGeneration: "current" | "previous";
    readonly reconciliation?: ProdigiReconcileResult;
    readonly errorCode?: ProdigiReconcileErrorCode;
}
export type ProdigiScheduledRunStatus = "applied" | "unchanged" | "terminal_conflict" | "covered" | "already_terminal" | "untracked_order" | "rescheduled" | "superseded" | "obsolete" | "abandon_pending" | "reconcile_abandoned";
export interface ProdigiScheduledRunResult {
    readonly status: ProdigiScheduledRunStatus;
    readonly orderId: string;
    readonly attempt: number;
    readonly errorCode?: ProdigiReconcileErrorCode;
    /** Present with `reconcile_abandoned`. */
    readonly reason?: ProdigiAbandonReason;
}
export declare class ProdigiCallbackReconciler {
    #private;
    constructor(options: ProdigiCallbackReconcilerOptions);
    get callbacksEnabled(): boolean;
    /** In-process bookkeeping sizes, for tests and diagnostics. All are bounded. Pending jobs are in the store. */
    diagnostics(): {
        readonly inFlightReads: number;
        readonly localTimers: number;
        readonly orderEntries: number;
    };
    /** Cancel in-process scheduled timers (the default scheduler only). */
    close(): void;
    /**
     * Poll backoff caps: the delay before attempt n+1 is drawn uniformly from
     * (0, min(max, initial * 2^(n-1))] (full jitter).
     */
    backoffSchedule(): readonly number[];
    /** The effective background-job retry budget. */
    jobRetryBudget(): {
        readonly initialDelayMs: number;
        readonly maxDelayMs: number;
        readonly maxAttempts: number;
        readonly horizonMs: number;
    };
    /**
     * Register an order this application created, so callbacks for it may
     * trigger reads. Call it before the order's `callbackUrl` can receive
     * callbacks (that is, before or immediately after `POST /Orders`, and before
     * enabling a dashboard-wide callback URL for existing orders).
     */
    trackOrder(orderId: string): Promise<ProdigiReconciledOrderState>;
    /**
     * Accept one callback request. `presentedToken` is the capability token the
     * host's HTTP handler extracted from the callback URL it registered. The body
     * is never applied; at most it triggers one quick authenticated read, under
     * a hard deadline of `requestDeadlineMs`. The host answers with
     * `recommendedHttpStatus`.
     */
    handleCallback(input: {
        readonly presentedToken: unknown;
        readonly headers: unknown;
        readonly rawBody: Uint8Array;
        readonly signal?: AbortSignal;
    }): Promise<ProdigiCallbackResult>;
    /**
     * Run one background reconciliation job, outside any callback request. The
     * default scheduler calls this; a host with a durable queue calls it when a
     * job it accepted through `scheduler.schedule` is due, on any worker. The
     * pending record in the store is authoritative; it is cleared by whichever
     * worker's read covers it. If this throws (store unavailable, or the
     * abandon hook failed), the queue must retry the job.
     */
    runScheduledReconciliation(job: ProdigiReconcileJob): Promise<ProdigiScheduledRunResult>;
    /**
     * Authenticated polling entry point, independent of callbacks: read the
     * order (single-flight, through the read limiter) with bounded, fully
     * jittered exponential backoff on retryable failures, then apply it under
     * the ordering rules with compare-and-set. Meant for a scheduled poller and
     * for orders reported by `reconcile_abandoned`, not for a request handler.
     */
    reconcileOrder(orderId: string, signal?: AbortSignal): Promise<ProdigiReconcileResult>;
}
export {};
