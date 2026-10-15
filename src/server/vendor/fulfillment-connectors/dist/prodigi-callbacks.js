import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { ingestProviderCallback, SecurityBoundaryError, withServerSecret } from "./security.js";
import { ProdigiSandboxError } from "./prodigi-sandbox.js";
const CALLBACK_MESSAGES = {
    invalid_config: "The Prodigi callback reconciler configuration is invalid.",
    live_refused: "Live Prodigi callbacks and reconciliation are refused.",
    callbacks_disabled: "Prodigi callbacks are disabled.",
    callback_forged: "The callback did not present the expected capability token.",
    callback_token_unavailable: "The callback capability token is unavailable.",
    callback_invalid: "The callback did not pass validation.",
    callback_oversized: "The callback exceeded the configured body limit.",
    callback_source_mismatch: "The callback source is not the expected sandbox origin.",
    invalid_input: "The reconciliation input did not pass validation.",
    store_unavailable: "The reconciliation store is unavailable.",
    deadline_exceeded: "The callback request exceeded its processing deadline."
};
export class ProdigiCallbackError extends Error {
    code;
    constructor(code) {
        super(CALLBACK_MESSAGES[code]);
        this.name = "ProdigiCallbackError";
        this.code = code;
    }
}
// ---------------------------------------------------------------------------
// CloudEvent parsing (untrusted hint only)
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9]{1,64}$/u;
const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]{1,64}$/u;
const EVENT_TYPE_PATTERN = /^com\.prodigi\.[A-Za-z0-9.]{1,96}(#[A-Za-z]{1,32})?$/u;
const STAGE_EVENT_PREFIX = "com.prodigi.order.status.stage.changed#";
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/u;
const STAGE_BY_NAME = Object.freeze({
    inprogress: "InProgress", complete: "Complete", cancelled: "Cancelled"
});
/**
 * Documented stage-change callback types. The v4 reference documents the
 * `com.prodigi.order.status.stage.changed#<Stage>` shape (its example is
 * `#InProgress`) and the order stages `InProgress`, `Complete` and `Cancelled`.
 * Only these name a stage (`claimedStage`).
 */
export const PRODIGI_CALLBACK_EVENT_TYPES = Object.freeze([
    "com.prodigi.order.status.stage.changed#InProgress",
    "com.prodigi.order.status.stage.changed#Complete",
    "com.prodigi.order.status.stage.changed#Cancelled"
]);
/**
 * Prefix of every order callback type. The reference says callbacks are sent
 * "when an order's stage changes or when a shipment is made" and defines `type`
 * as `com.prodigi.` + object + path to the changed nested object + `#` + new
 * value, but gives no shipment type string. Any well-formed `com.prodigi.order.*`
 * type (stage changes and shipments) may therefore trigger one bounded read;
 * other objects are `ignored_type`.
 */
export const PRODIGI_ORDER_CALLBACK_TYPE_PREFIX = "com.prodigi.order.";
/** Whether a well-formed callback type may trigger an authenticated read. */
export function isProdigiOrderCallbackType(type) {
    return typeof type === "string" && EVENT_TYPE_PATTERN.test(type) && type.startsWith(PRODIGI_ORDER_CALLBACK_TYPE_PREFIX) &&
        type.length > PRODIGI_ORDER_CALLBACK_TYPE_PREFIX.length && type[PRODIGI_ORDER_CALLBACK_TYPE_PREFIX.length] !== "#";
}
/**
 * Accepted CloudEvent `source` values. The reference documents the sandbox
 * source as `https://api.sandbox.prodigi.com/v4.0/Orders/` (live:
 * `https://api.prodigi.com/v4.0/Orders/`); its example uses `http://`, so both
 * schemes are accepted, case-insensitively, with an optional trailing order ID.
 * Only the sandbox host is accepted; a live-origin callback is invalid here.
 */
const SANDBOX_SOURCE_PATTERN = /^https?:\/\/api\.sandbox\.prodigi\.com\/v4\.0\/orders(\/(ord_[A-Za-z0-9]{1,64})?)?$/iu;
export const PRODIGI_SANDBOX_CALLBACK_SOURCE = "https://api.sandbox.prodigi.com/v4.0/Orders/";
function invalidCallback() {
    throw new ProdigiCallbackError("callback_invalid");
}
/**
 * Parse a Prodigi CloudEvent body into a bounded hint. `data` (the full order,
 * including the recipient) is only checked for a matching `id` and is not kept.
 */
export function parseProdigiCallbackEvent(rawBody) {
    if (!(rawBody instanceof Uint8Array) || rawBody.byteLength === 0)
        return invalidCallback();
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    }
    catch {
        return invalidCallback();
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return invalidCallback();
    const event = parsed;
    const own = (key) => (Object.prototype.hasOwnProperty.call(event, key) ? event[key] : undefined);
    if (own("specversion") !== "1.0")
        return invalidCallback();
    const eventId = own("id");
    const type = own("type");
    const subject = own("subject");
    const time = own("time");
    const source = own("source");
    if (typeof source !== "string")
        return invalidCallback();
    if (typeof eventId !== "string" || !EVENT_ID_PATTERN.test(eventId))
        return invalidCallback();
    if (typeof type !== "string" || !EVENT_TYPE_PATTERN.test(type))
        return invalidCallback();
    if (typeof subject !== "string" || !ORDER_ID_PATTERN.test(subject))
        return invalidCallback();
    if (typeof time !== "string" || !TIME_PATTERN.test(time) || Number.isNaN(Date.parse(time)))
        return invalidCallback();
    const data = own("data");
    if (data !== undefined && data !== null) {
        if (typeof data !== "object" || Array.isArray(data))
            return invalidCallback();
        // The reference shows both `data.id` and `data.order.id`; whichever is present must match.
        const record = data;
        const dataId = Object.prototype.hasOwnProperty.call(record, "id") ? record.id : undefined;
        if (dataId !== undefined && dataId !== subject)
            return invalidCallback();
        const nested = Object.prototype.hasOwnProperty.call(record, "order") ? record.order : undefined;
        if (nested !== undefined && nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
            const nestedId = Object.prototype.hasOwnProperty.call(nested, "id") ? nested.id : undefined;
            if (nestedId !== undefined && nestedId !== subject)
                return invalidCallback();
        }
    }
    let claimedStage = null;
    if (type.startsWith(STAGE_EVENT_PREFIX)) {
        const name = type.slice(STAGE_EVENT_PREFIX.length).toLowerCase();
        claimedStage = Object.prototype.hasOwnProperty.call(STAGE_BY_NAME, name) ? STAGE_BY_NAME[name] : null;
        if (claimedStage === null)
            return invalidCallback();
    }
    // Checked last, with its own code: a source mismatch means the wire format or
    // environment differs from the documentation, so the host answers 503 and
    // logs it (Prodigi redelivers) instead of a 400 that drops the callback.
    if (source.length > 256 || !SANDBOX_SOURCE_PATTERN.test(source))
        throw new ProdigiCallbackError("callback_source_mismatch");
    return Object.freeze({ eventId, orderId: subject, type, claimedStage, eventTime: time });
}
// ---------------------------------------------------------------------------
// Ordering
const STEP_RANK = Object.freeze({ NotStarted: 0, InProgress: 1, Error: 1, Complete: 2 });
const DETAIL_KEYS = ["downloadAssets", "printReadyAssetsPrepared", "allocateProductionLocation", "inProduction", "shipping"];
function isTerminalStage(stage) {
    return stage === "Complete" || stage === "Cancelled";
}
function stageRank(stage) {
    if (stage === null)
        return 0;
    return stage === "InProgress" ? 1 : 2;
}
function timeOf(value) {
    if (value === null)
        return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}
function observationDigest(observation) {
    const canonical = JSON.stringify({
        stage: observation.stage,
        details: DETAIL_KEYS.map((key) => observation.details[key]),
        issues: [...observation.issueCodes].sort(),
        shipments: observation.shipments.map((s) => [s.id, s.status, s.carrier, s.hasTrackingNumber, s.dispatchDate])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    });
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
/**
 * Decide whether an authenticated observation may replace the stored state.
 * Terminal disagreement is evaluated first, so `Complete` versus `Cancelled`
 * is always a conflict, never hidden as `stale` or selected by timestamp. A
 * strictly older `lastUpdated` is then stale. A terminal stage cannot move
 * back to `InProgress`. Within `InProgress`, no step and no shipment may go
 * backwards.
 */
export function decideProdigiOrdering(current, observation) {
    if (current === undefined || current.stage === null || current.details === null)
        return "apply";
    if (current.observationDigest === observationDigest(observation))
        return "unchanged";
    if (isTerminalStage(current.stage) && isTerminalStage(observation.stage) && observation.stage !== current.stage)
        return "terminal_conflict";
    const storedTime = timeOf(current.lastUpdated);
    const incomingTime = timeOf(observation.lastUpdated);
    if (storedTime !== null && incomingTime !== null && incomingTime < storedTime)
        return "stale";
    if (isTerminalStage(current.stage) && !isTerminalStage(observation.stage))
        return "regression";
    if (stageRank(observation.stage) < stageRank(current.stage))
        return "regression";
    for (const key of DETAIL_KEYS) {
        if (STEP_RANK[observation.details[key]] < STEP_RANK[current.details[key]])
            return "regression";
    }
    const incomingShipments = new Set(observation.shipments.map((s) => s.id));
    if (current.shipmentIds.some((id) => !incomingShipments.has(id)))
        return "regression";
    return "apply";
}
const STORE_METHODS = [
    "hasEvent", "recordEvent", "getOrder", "compareAndSetOrder",
    "getPendingReconciliation", "compareAndSetPendingReconciliation", "countPendingReconciliations"
];
function scopeKey(scope, orderId) {
    return JSON.stringify([scope.tenantId, scope.projectId, orderId]);
}
/**
 * Single-process reference store for tests and local development. It is not
 * durable and gives no cross-process atomicity. Replay records expire at their
 * `expiresAt` and are capped at `maxReplayRecords` (default 10000), evicting
 * the oldest record first. Pending records exist only for tracked orders.
 */
export function createInMemoryProdigiReconciliationStore(options = {}) {
    const maxReplayRecords = boundedInt(options.maxReplayRecords, 10_000, 1, 1_000_000);
    const clock = options.clock ?? { now: () => Date.now() };
    // Insertion-ordered: the first entry is the oldest.
    const events = new Map();
    const orders = new Map();
    const pending = new Map();
    const sweep = () => {
        const now = clock.now();
        for (const [key, expiresAt] of events) {
            if (expiresAt > now)
                break;
            events.delete(key);
        }
    };
    return Object.freeze({
        async hasEvent(input) {
            const key = `${scopeKey(input.scope, input.orderId)}|${input.eventId}`;
            const expiresAt = events.get(key);
            if (expiresAt === undefined)
                return false;
            if (expiresAt <= clock.now()) {
                events.delete(key);
                return false;
            }
            return true;
        },
        async recordEvent(input) {
            const expiresAt = Date.parse(input.expiresAt);
            if (Number.isNaN(expiresAt))
                throw new Error("invalid expiry");
            const key = `${scopeKey(input.scope, input.orderId)}|${input.eventId}`;
            events.delete(key);
            events.set(key, expiresAt);
            sweep();
            while (events.size > maxReplayRecords) {
                const oldest = events.keys().next().value;
                events.delete(oldest);
            }
        },
        async getOrder(input) {
            return orders.get(scopeKey(input.scope, input.orderId));
        },
        async compareAndSetOrder(input) {
            const key = scopeKey(input.scope, input.orderId);
            const current = orders.get(key);
            if ((current?.revision ?? null) !== input.expectedRevision)
                return false;
            orders.set(key, Object.freeze({ ...input.next }));
            return true;
        },
        async getPendingReconciliation(input) {
            return pending.get(scopeKey(input.scope, input.orderId))?.record;
        },
        async compareAndSetPendingReconciliation(input) {
            const key = scopeKey(input.scope, input.orderId);
            const current = pending.get(key);
            if ((current?.record.revision ?? null) !== input.expectedRevision)
                return false;
            if (input.next === null) {
                pending.delete(key);
            }
            else {
                if (!orders.has(key))
                    return false;
                pending.set(key, { scope: JSON.stringify([input.scope.tenantId, input.scope.projectId]), record: Object.freeze({ ...input.next }) });
            }
            return true;
        },
        async countPendingReconciliations(input) {
            const scope = JSON.stringify([input.scope.tenantId, input.scope.projectId]);
            const now = Date.parse(input.now);
            let count = 0;
            for (const entry of pending.values()) {
                if (entry.scope === scope && Date.parse(entry.record.staleAt) > now)
                    count += 1;
            }
            return count;
        },
        stats() {
            sweep();
            return Object.freeze({ orders: orders.size, replayRecords: events.size, pendingReconciliations: pending.size });
        }
    });
}
/** Bound on per-tenant buckets kept by `createProdigiReadLimiter`, least recently used evicted first. */
const MAX_TENANT_BUCKETS = 10_000;
/**
 * Token bucket plus a concurrency cap, with a per-tenant sub-budget. A read
 * needs a token from the global bucket *and* from its tenant's bucket, so one
 * tenant's burst can use at most `tenantBurst` of the global burst and
 * `tenantMaxConcurrent` of the concurrency, and other tenants keep the rest.
 * Defaults: 4 concurrent reads, a burst of 10 and 2 reads per second globally;
 * per tenant, half of each (2 concurrent, a burst of 5, 1 read per second).
 * Calls without a tenant key use only the global budget.
 */
export function createProdigiReadLimiter(options = {}) {
    const maxConcurrent = boundedInt(options.maxConcurrent, 4, 1, 64);
    const burst = boundedInt(options.burst, 10, 1, 1000);
    const refillPerSecond = boundedInt(options.refillPerSecond, 2, 1, 100);
    const tenantMaxConcurrent = boundedInt(options.tenantMaxConcurrent, Math.max(1, Math.ceil(maxConcurrent / 2)), 1, maxConcurrent);
    const tenantBurst = boundedInt(options.tenantBurst, Math.max(1, Math.floor(burst / 2)), 1, burst);
    const tenantRefillPerSecond = boundedInt(options.tenantRefillPerSecond, Math.max(1, Math.floor(refillPerSecond / 2)), 1, refillPerSecond);
    const clock = options.clock ?? { now: () => Date.now() };
    const global = { tokens: burst, refilledAt: clock.now(), active: 0 };
    const tenants = new Map();
    const refill = (bucket, cap, rate, now) => {
        if (now > bucket.refilledAt) {
            bucket.tokens = Math.min(cap, bucket.tokens + ((now - bucket.refilledAt) / 1000) * rate);
            bucket.refilledAt = now;
        }
    };
    const tenantBucket = (key, now) => {
        let bucket = tenants.get(key);
        if (bucket === undefined) {
            bucket = { tokens: tenantBurst, refilledAt: now, active: 0 };
        }
        else {
            tenants.delete(key);
        }
        tenants.set(key, bucket);
        while (tenants.size > MAX_TENANT_BUCKETS) {
            const [oldestKey, oldest] = tenants.entries().next().value;
            if (oldest.active > 0)
                break;
            tenants.delete(oldestKey);
        }
        return bucket;
    };
    return Object.freeze({
        tryAcquire(tenantKey) {
            const now = clock.now();
            refill(global, burst, refillPerSecond, now);
            if (global.active >= maxConcurrent || global.tokens < 1)
                return null;
            let tenant;
            if (typeof tenantKey === "string" && tenantKey.length > 0) {
                tenant = tenantBucket(tenantKey, now);
                refill(tenant, tenantBurst, tenantRefillPerSecond, now);
                if (tenant.active >= tenantMaxConcurrent || tenant.tokens < 1)
                    return null;
                tenant.tokens -= 1;
                tenant.active += 1;
            }
            global.tokens -= 1;
            global.active += 1;
            let released = false;
            return () => {
                if (released)
                    return;
                released = true;
                global.active -= 1;
                if (tenant !== undefined)
                    tenant.active -= 1;
            };
        }
    });
}
const RETRYABLE = new Set(["rate_limited", "provider_unavailable", "timeout", "read_budget_exhausted", "store_unavailable"]);
/** Presented and stored tokens: printable ASCII, 43..512 characters (43 base64url characters carry 256 bits). */
const TOKEN_PATTERN = /^[\x21-\x7E]{1,512}$/u;
const MIN_TOKEN_LENGTH = 43;
const MAX_TOKEN_LENGTH = 512;
const DEFAULT_BODY_BYTES = 512 * 1024;
const RETRY_AFTER_SECONDS = 30;
/** Bound on per-order in-process bookkeeping (read times), oldest evicted first. */
const MAX_ORDER_ENTRIES = 10_000;
const CAS_ROUNDS = 4;
const MAX_PENDING_EVENT_IDS = 32;
// Scope identifiers intentionally exclude `_` (unlike callback event/order IDs,
// which must admit Prodigi's `evt_`/`ord_` prefixes); this matches the shared
// trusted-scope rules elsewhere in the package.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REFERENCE_PATTERN = /^[a-z][a-z0-9._/-]{0,127}$/u;
const STAGES = new Set(["InProgress", "Complete", "Cancelled"]);
function defaultSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new Error("aborted"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function boundedInt(value, fallback, min, max) {
    if (value === undefined)
        return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new ProdigiCallbackError("invalid_config");
    return value;
}
function digestToken(value) {
    return createHash("sha256").update(value, "utf8").digest();
}
function iso(ms) {
    return new Date(ms).toISOString();
}
function maxStage(a, b) {
    if (a === null)
        return b;
    if (b === null)
        return a;
    return stageRank(b) > stageRank(a) ? b : a;
}
/** Whether the authoritative state has reached a claimed stage (a claim never lowers the bar). */
function stageMet(state, stage) {
    return stage === null || state.conflict || stageRank(state.stage) >= stageRank(stage);
}
const TIMED_OUT = Symbol("timed_out");
/** Resolve with the promise, or with TIMED_OUT after `ms` or on abort. Never rejects for the timer. */
function raceDeadline(promise, ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true || ms <= 0) {
            resolve(TIMED_OUT);
            promise.catch(() => undefined);
            return;
        }
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            finish();
            resolve(TIMED_OUT);
        };
        const timer = setTimeout(onAbort, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        promise.then((value) => { finish(); resolve(value); }, (error) => { finish(); reject(error); });
    });
}
export class ProdigiCallbackReconciler {
    #scope;
    #reader;
    #store;
    #callbacksEnabled;
    #secrets;
    #tokenReference;
    #previousTokenReference;
    #maxBodyBytes;
    #initialDelayMs;
    #maxDelayMs;
    #maxAttempts;
    #jobInitialDelayMs;
    #jobMaxDelayMs;
    #jobMaxAttempts;
    #jobHorizonMs;
    #requestDeadlineMs;
    #readTimeoutMs;
    #minReadIntervalMs;
    #replayTtlMs;
    #maxPendingJobs;
    #pendingGraceMs;
    #workerSkewMs;
    #untrackedAckAfterMs;
    #limiter;
    #scheduler;
    #onAbandoned;
    #clock;
    #random;
    #sleep;
    /** Monotonic in-process sequence for callback receipts and read starts. */
    #seq = 0;
    /** Single-flight reads, keyed by scope and order. Entries live only while a read runs. */
    #flights = new Map();
    /** Start time of the latest read per tracked order, bounded to MAX_ORDER_ENTRIES. */
    #lastReadStart = new Map();
    /** In-process scheduler timers only. Pending-job state lives in the store. */
    #timers = new Set();
    constructor(options) {
        if (options === null || typeof options !== "object")
            throw new ProdigiCallbackError("invalid_config");
        if (options.mode === "live")
            throw new ProdigiCallbackError("live_refused");
        if (options.mode !== "sandbox")
            throw new ProdigiCallbackError("invalid_config");
        const scope = options.trustedScope;
        if (scope === null || typeof scope !== "object" ||
            typeof scope.tenantId !== "string" || !IDENTIFIER_PATTERN.test(scope.tenantId) ||
            typeof scope.projectId !== "string" || !IDENTIFIER_PATTERN.test(scope.projectId)) {
            throw new ProdigiCallbackError("invalid_config");
        }
        if (options.reader === null || typeof options.reader !== "object" || typeof options.reader.getOrder !== "function")
            throw new ProdigiCallbackError("invalid_config");
        const store = options.store;
        if (store === null || typeof store !== "object" || STORE_METHODS.some((name) => typeof store[name] !== "function")) {
            throw new ProdigiCallbackError("invalid_config");
        }
        const enabled = options.callbacksEnabled === true;
        if (enabled) {
            if (options.secrets === null || typeof options.secrets !== "object" || typeof options.secrets.load !== "function")
                throw new ProdigiCallbackError("invalid_config");
            if (typeof options.callbackTokenReference !== "string" || !REFERENCE_PATTERN.test(options.callbackTokenReference))
                throw new ProdigiCallbackError("invalid_config");
            if (options.previousCallbackTokenReference !== undefined &&
                (typeof options.previousCallbackTokenReference !== "string" || !REFERENCE_PATTERN.test(options.previousCallbackTokenReference) ||
                    options.previousCallbackTokenReference === options.callbackTokenReference)) {
                throw new ProdigiCallbackError("invalid_config");
            }
        }
        if (options.readLimiter !== undefined && (options.readLimiter === null || typeof options.readLimiter.tryAcquire !== "function"))
            throw new ProdigiCallbackError("invalid_config");
        if (options.scheduler !== undefined && (options.scheduler === null || typeof options.scheduler.schedule !== "function" || typeof options.scheduler.durable !== "boolean")) {
            throw new ProdigiCallbackError("invalid_config");
        }
        if (options.onReconcileAbandoned !== undefined && typeof options.onReconcileAbandoned !== "function")
            throw new ProdigiCallbackError("invalid_config");
        // A 202 hands the callback to the durable job chain; if that chain gives up,
        // the hook is the only remaining owner, so it is mandatory.
        if (options.scheduler?.durable === true && options.onReconcileAbandoned === undefined)
            throw new ProdigiCallbackError("invalid_config");
        const policy = options.pollPolicy ?? {};
        this.#initialDelayMs = boundedInt(policy.initialDelayMs, 1000, 1, 60_000);
        this.#maxDelayMs = boundedInt(policy.maxDelayMs, Math.max(60_000, this.#initialDelayMs), this.#initialDelayMs, 300_000);
        this.#maxAttempts = boundedInt(policy.maxAttempts, 5, 1, 10);
        const durable = options.scheduler?.durable === true;
        const jobPolicy = options.jobRetryPolicy ?? {};
        if (jobPolicy === null || typeof jobPolicy !== "object")
            throw new ProdigiCallbackError("invalid_config");
        this.#jobInitialDelayMs = boundedInt(jobPolicy.initialDelayMs, durable ? 2000 : this.#initialDelayMs, 1, 600_000);
        this.#jobMaxDelayMs = boundedInt(jobPolicy.maxDelayMs, Math.max(this.#jobInitialDelayMs, durable ? 300_000 : this.#maxDelayMs), this.#jobInitialDelayMs, 3_600_000);
        this.#jobMaxAttempts = boundedInt(jobPolicy.maxAttempts, durable ? 40 : this.#maxAttempts, 1, 1000);
        this.#jobHorizonMs = boundedInt(jobPolicy.horizonMs, durable ? 3_600_000 : 600_000, 1000, 86_400_000);
        this.#maxBodyBytes = boundedInt(options.maxBodyBytes, DEFAULT_BODY_BYTES, 1, 1024 * 1024);
        this.#requestDeadlineMs = boundedInt(options.requestDeadlineMs, 2000, 50, 10_000);
        this.#readTimeoutMs = boundedInt(options.readTimeoutMs, 30_000, 100, 120_000);
        this.#minReadIntervalMs = boundedInt(options.minReadIntervalMs, 5000, 0, 600_000);
        this.#replayTtlMs = boundedInt(options.replayTtlMs, 7 * 24 * 3600 * 1000, 60_000, 30 * 24 * 3600 * 1000);
        this.#maxPendingJobs = boundedInt(options.maxPendingJobs, 1000, 1, 100_000);
        this.#pendingGraceMs = boundedInt(options.pendingJobGraceMs, Math.max(120_000, 2 * this.#readTimeoutMs), 1000, 3_600_000);
        this.#workerSkewMs = boundedInt(options.workerClockSkewMs, 2000, 0, 60_000);
        const untracked = options.untrackedAckAfterMs;
        this.#untrackedAckAfterMs = untracked === 0 ? 0 : boundedInt(untracked, 24 * 3600 * 1000, 60_000, 30 * 24 * 3600 * 1000);
        this.#scope = Object.freeze({ tenantId: scope.tenantId, projectId: scope.projectId });
        this.#reader = options.reader;
        this.#store = store;
        this.#callbacksEnabled = enabled;
        this.#secrets = enabled ? options.secrets : undefined;
        this.#tokenReference = enabled ? options.callbackTokenReference : undefined;
        this.#previousTokenReference = enabled ? options.previousCallbackTokenReference : undefined;
        this.#clock = options.clock ?? { now: () => Date.now() };
        this.#random = options.random ?? Math.random;
        this.#sleep = options.sleep ?? defaultSleep;
        this.#limiter = options.readLimiter ?? createProdigiReadLimiter({ clock: this.#clock });
        this.#scheduler = options.scheduler ?? this.#inProcessScheduler();
        this.#onAbandoned = options.onReconcileAbandoned;
    }
    get callbacksEnabled() {
        return this.#callbacksEnabled;
    }
    /** In-process bookkeeping sizes, for tests and diagnostics. All are bounded. Pending jobs are in the store. */
    diagnostics() {
        return Object.freeze({ inFlightReads: this.#flights.size, localTimers: this.#timers.size, orderEntries: this.#lastReadStart.size });
    }
    /** Cancel in-process scheduled timers (the default scheduler only). */
    close() {
        for (const timer of this.#timers)
            clearTimeout(timer);
        this.#timers.clear();
    }
    /**
     * Poll backoff caps: the delay before attempt n+1 is drawn uniformly from
     * (0, min(max, initial * 2^(n-1))] (full jitter).
     */
    backoffSchedule() {
        const delays = [];
        for (let attempt = 1; attempt < this.#maxAttempts; attempt += 1)
            delays.push(this.#backoffCap(attempt));
        return Object.freeze(delays);
    }
    /** The effective background-job retry budget. */
    jobRetryBudget() {
        return Object.freeze({ initialDelayMs: this.#jobInitialDelayMs, maxDelayMs: this.#jobMaxDelayMs, maxAttempts: this.#jobMaxAttempts, horizonMs: this.#jobHorizonMs });
    }
    /**
     * Register an order this application created, so callbacks for it may
     * trigger reads. Call it before the order's `callbackUrl` can receive
     * callbacks (that is, before or immediately after `POST /Orders`, and before
     * enabling a dashboard-wide callback URL for existing orders).
     */
    async trackOrder(orderId) {
        if (typeof orderId !== "string" || !ORDER_ID_PATTERN.test(orderId))
            throw new ProdigiCallbackError("invalid_input");
        const existing = await this.#getOrder(orderId);
        if (existing !== undefined)
            return existing;
        const initial = Object.freeze({
            orderId, revision: 0, stage: null, normalizedState: "pending", details: null, shipmentIds: Object.freeze([]),
            lastUpdated: null, observationDigest: null, reconciledAt: null, confirmedAt: null, conflict: false
        });
        if (await this.#cas(orderId, null, initial))
            return initial;
        const raced = await this.#getOrder(orderId);
        if (raced === undefined)
            throw new ProdigiCallbackError("store_unavailable");
        return raced;
    }
    /**
     * Accept one callback request. `presentedToken` is the capability token the
     * host's HTTP handler extracted from the callback URL it registered. The body
     * is never applied; at most it triggers one quick authenticated read, under
     * a hard deadline of `requestDeadlineMs`. The host answers with
     * `recommendedHttpStatus`.
     */
    async handleCallback(input) {
        if (!this.#callbacksEnabled)
            throw new ProdigiCallbackError("callbacks_disabled");
        if (input === null || typeof input !== "object")
            throw new ProdigiCallbackError("callback_invalid");
        // Receipt is stamped first, on our clock. Coverage is decided only against it.
        const receipt = { at: this.#clock.now(), seq: this.#nextSeq() };
        const deadline = receipt.at + this.#requestDeadlineMs;
        const outcome = await raceDeadline(this.#handle(input, deadline, receipt), this.#requestDeadlineMs, input.signal);
        if (outcome === TIMED_OUT)
            throw new ProdigiCallbackError("deadline_exceeded");
        return outcome;
    }
    async #handle(input, deadline, receipt) {
        const generation = await this.#verifyToken(input.presentedToken);
        const rawBody = input.rawBody;
        if (!(rawBody instanceof Uint8Array))
            throw new ProdigiCallbackError("callback_invalid");
        if (rawBody.byteLength > this.#maxBodyBytes)
            throw new ProdigiCallbackError("callback_oversized");
        const hint = parseProdigiCallbackEvent(rawBody);
        const respond = (outcome, extra = {}, scheduled = false) => {
            const status = outcome === "deferred" ? (this.#scheduler.durable ? 202 : 503)
                : outcome === "not_tracked" || outcome === "reconcile_failed" ? 503 : 200;
            return Object.freeze({
                outcome,
                trust: "unverified",
                eventId: hint.eventId,
                orderId: hint.orderId,
                authoritativeMutationAllowed: false,
                recommendedHttpStatus: status,
                ...(status === 503 ? { retryAfterSeconds: RETRY_AFTER_SECONDS } : {}),
                scheduled,
                tokenGeneration: generation,
                ...extra
            });
        };
        // 1. Only order callbacks (stage changes and shipments) may cause a read;
        //    other objects touch neither the store nor the provider.
        if (!isProdigiOrderCallbackType(hint.type))
            return respond("ignored_type");
        // 2. Tracking before anything else: an unknown order stores nothing and is
        //    not consumed, so a callback racing trackOrder is redelivered.
        const current = await this.#getOrder(hint.orderId);
        if (current === undefined) {
            const age = receipt.at - Math.min(Date.parse(hint.eventTime), receipt.at);
            if (this.#untrackedAckAfterMs > 0 && age >= this.#untrackedAckAfterMs)
                return respond("untracked_expired");
            return respond("not_tracked");
        }
        // 3. Shared intake boundary. The replay check is read-only here; the
        //    event is recorded only after a covering read was applied.
        const store = this.#store;
        const scope = this.#scope;
        let seen = false;
        try {
            await ingestProviderCallback({
                providerId: "prodigi",
                mode: "sandbox",
                trustedScope: scope,
                headers: input.headers ?? {},
                rawBody,
                maxBodyBytes: this.#maxBodyBytes,
                // Prodigi documents no authenticity method, so there is no verifier:
                // the hint stays unverified and requires an authenticated read.
                allowUnverifiedHints: true,
                parseHint: (bytes) => {
                    const parsed = parseProdigiCallbackEvent(bytes);
                    if (parsed.eventId !== hint.eventId || parsed.orderId !== hint.orderId)
                        throw new Error("mismatch");
                    return { eventId: parsed.eventId, providerRequestId: parsed.orderId };
                },
                replayStore: {
                    async claim() {
                        seen = await store.hasEvent({ scope, orderId: hint.orderId, eventId: hint.eventId });
                        return !seen;
                    }
                }
            });
        }
        catch (error) {
            if (error instanceof SecurityBoundaryError) {
                if (error.code === "callback_oversized")
                    throw new ProdigiCallbackError("callback_oversized");
                if (error.code === "callback_unavailable")
                    throw new ProdigiCallbackError("store_unavailable");
                throw new ProdigiCallbackError("callback_invalid");
            }
            throw new ProdigiCallbackError("store_unavailable");
        }
        if (seen)
            return respond("replayed");
        // 4. Suppression only from authoritative read state on our own clock.
        if (isTerminalStage(current.stage) && !current.conflict)
            return respond("already_terminal");
        const need = { after: receipt.at, stage: hint.claimedStage };
        if (this.#satisfied(current, need)) {
            await this.#recordEvent(hint.orderId, hint.eventId);
            return respond("already_reconciled");
        }
        // 5. At most one quick read that starts after receipt.
        const key = scopeKey(scope, hint.orderId);
        let flight = this.#flights.get(key);
        if (flight !== undefined && flight.seq < receipt.seq) {
            // The read in flight started before this callback arrived, so it cannot
            // cover it. Join the next read: one follow-up job, after the interval.
            return this.#deferResult(respond, hint, need, Math.max(1, this.#intervalRemaining(key)));
        }
        if (flight === undefined) {
            const wait = this.#intervalRemaining(key);
            if (wait > 0)
                return this.#deferResult(respond, hint, need, wait);
            flight = this.#startFlight(hint.orderId);
            if (flight === undefined)
                return this.#deferResult(respond, hint, need, this.#jobInitialDelayMs);
        }
        const reserve = Math.min(250, Math.floor(this.#requestDeadlineMs / 4));
        const read = await raceDeadline(flight.promise, deadline - reserve - this.#clock.now());
        if (read === TIMED_OUT) {
            // The read keeps running and still applies; the job covers this callback either way.
            return this.#deferResult(respond, hint, need, Math.max(this.#jobInitialDelayMs, this.#intervalRemaining(key)));
        }
        if (!read.ok) {
            const retryable = RETRYABLE.has(read.code);
            const scheduled = retryable ? await this.#defer(hint.orderId, need, this.#intervalRemaining(key), hint.eventId) : false;
            return respond("reconcile_failed", { errorCode: read.code }, scheduled);
        }
        const status = read.result.status;
        if (status === "untracked_order")
            return respond("not_tracked");
        const state = read.result.state;
        if (status === "terminal_conflict" ||
            ((status === "applied" || status === "unchanged") && state !== undefined && stageMet(state, need.stage))) {
            await this.#recordEvent(hint.orderId, hint.eventId);
            if (state !== undefined)
                await this.#settleQuietly(hint.orderId, state);
            return respond("reconciled", { reconciliation: read.result });
        }
        // A stale or regressed read, or one that has not yet reached the claimed
        // stage (Prodigi read lag): not covered, so read again outside the request.
        return this.#deferResult(respond, hint, need, Math.max(this.#jobInitialDelayMs, this.#intervalRemaining(key)), read.result);
    }
    async #deferResult(respond, hint, need, minDelayMs, reconciliation) {
        const scheduled = await this.#defer(hint.orderId, need, minDelayMs, hint.eventId);
        const extra = reconciliation === undefined ? {} : { reconciliation };
        return scheduled ? respond("deferred", extra, true) : respond("reconcile_failed", extra, false);
    }
    /**
     * Run one background reconciliation job, outside any callback request. The
     * default scheduler calls this; a host with a durable queue calls it when a
     * job it accepted through `scheduler.schedule` is due, on any worker. The
     * pending record in the store is authoritative; it is cleared by whichever
     * worker's read covers it. If this throws (store unavailable, or the
     * abandon hook failed), the queue must retry the job.
     */
    async runScheduledReconciliation(job) {
        if (job === null || typeof job !== "object" || typeof job.orderId !== "string" || !ORDER_ID_PATTERN.test(job.orderId) ||
            !Number.isSafeInteger(job.attempt) || job.attempt < 1 ||
            typeof job.coverAfter !== "string" || Number.isNaN(Date.parse(job.coverAfter)) ||
            (job.requiredStage !== null && !STAGES.has(job.requiredStage))) {
            throw new ProdigiCallbackError("invalid_input");
        }
        const { orderId, attempt } = job;
        const key = scopeKey(this.#scope, orderId);
        const done = (status, errorCode, reason) => Object.freeze({ status, orderId, attempt, ...(errorCode === undefined ? {} : { errorCode }), ...(reason === undefined ? {} : { reason }) });
        const pending = await this.#getPending(orderId);
        if (pending === undefined)
            return done("obsolete");
        if (attempt < pending.attempt)
            return done("superseded");
        if (pending.abandoning !== null) {
            // Another run is reporting this record, or crashed while doing so.
            return this.#abandon(orderId, pending.abandoning.reason, pending.abandoning.errorCode ?? undefined, done);
        }
        const current = await this.#getOrder(orderId);
        if (current === undefined) {
            await this.#clearPending(orderId);
            return done("untracked_order");
        }
        if (isTerminalStage(current.stage) && !current.conflict) {
            await this.#clearPending(orderId);
            return done("already_terminal");
        }
        if (this.#covers(pending, current)) {
            const settled = await this.#settle(orderId, current);
            return settled === "remaining" ? this.#reschedule(orderId, attempt, "refusal", undefined, this.#intervalRemaining(key), done) : done("covered");
        }
        // Local refusals do not spend the read budget (F3); only horizonMs bounds them.
        let flight = this.#flights.get(key);
        if (flight !== undefined && flight.startedAt <= Date.parse(pending.coverAfter) + this.#workerSkewMs) {
            return this.#reschedule(orderId, attempt, "refusal", "read_budget_exhausted", this.#intervalRemaining(key), done);
        }
        if (flight === undefined) {
            const wait = this.#intervalRemaining(key);
            if (wait > 0)
                return this.#reschedule(orderId, attempt, "refusal", "read_budget_exhausted", wait, done);
            flight = this.#startFlight(orderId);
            if (flight === undefined)
                return this.#reschedule(orderId, attempt, "refusal", "read_budget_exhausted", 0, done);
        }
        const read = await flight.promise;
        if (!read.ok) {
            if (RETRYABLE.has(read.code))
                return this.#reschedule(orderId, attempt, "read", read.code, this.#intervalRemaining(key), done);
            return this.#abandon(orderId, "read_failed", read.code, done, undefined, pending.readsSpent + 1);
        }
        const status = read.result.status;
        const state = read.result.state;
        if (status === "untracked_order") {
            await this.#clearPending(orderId);
            return done("untracked_order");
        }
        if (status === "terminal_conflict") {
            await this.#clearPending(orderId);
            return done("terminal_conflict");
        }
        if ((status === "applied" || status === "unchanged") && state !== undefined) {
            const settled = await this.#settle(orderId, state);
            if (settled !== "remaining")
                return done(status);
        }
        // Not covered: a newer callback arrived during the read, the claimed stage
        // is not visible yet (read lag or a forged claim), or the read was stale.
        return this.#reschedule(orderId, attempt, "read", undefined, this.#intervalRemaining(key), done);
    }
    /**
     * Authenticated polling entry point, independent of callbacks: read the
     * order (single-flight, through the read limiter) with bounded, fully
     * jittered exponential backoff on retryable failures, then apply it under
     * the ordering rules with compare-and-set. Meant for a scheduled poller and
     * for orders reported by `reconcile_abandoned`, not for a request handler.
     */
    async reconcileOrder(orderId, signal) {
        if (typeof orderId !== "string" || !ORDER_ID_PATTERN.test(orderId))
            throw new ProdigiCallbackError("invalid_input");
        const tracked = await this.#getOrder(orderId);
        if (tracked === undefined) {
            return Object.freeze({ status: "untracked_order", orderId, attempts: 0, delaysMs: Object.freeze([]), state: undefined });
        }
        const key = scopeKey(this.#scope, orderId);
        const delays = [];
        let attempts = 0;
        let lastCode;
        while (attempts < this.#maxAttempts) {
            attempts += 1;
            const flight = this.#flights.get(key) ?? this.#startFlight(orderId);
            const read = flight === undefined
                ? { ok: false, code: "read_budget_exhausted", startedAt: this.#clock.now() }
                : await flight.promise;
            if (read.ok) {
                if (read.result.state !== undefined && (read.result.status === "applied" || read.result.status === "unchanged")) {
                    await this.#settleQuietly(orderId, read.result.state);
                }
                return Object.freeze({ ...read.result, attempts, delaysMs: Object.freeze([...delays]) });
            }
            lastCode = read.code;
            if (!RETRYABLE.has(lastCode) || attempts >= this.#maxAttempts || signal?.aborted === true)
                break;
            const delay = this.#jitter(attempts);
            delays.push(delay);
            try {
                await this.#sleep(delay, signal);
            }
            catch {
                break;
            }
        }
        const status = lastCode !== undefined && RETRYABLE.has(lastCode) && attempts >= this.#maxAttempts ? "retries_exhausted" : "read_failed";
        return Object.freeze({
            status, orderId, attempts, delaysMs: Object.freeze(delays), state: await this.#getOrder(orderId),
            ...(lastCode === undefined ? {} : { errorCode: lastCode })
        });
    }
    // -------------------------------------------------------------------------
    // Reads
    #nextSeq() {
        this.#seq += 1;
        return this.#seq;
    }
    /** Start a single-flight read if the limiter allows one now; otherwise undefined. */
    #startFlight(orderId) {
        const key = scopeKey(this.#scope, orderId);
        const release = this.#limiter.tryAcquire(this.#scope.tenantId);
        if (typeof release !== "function")
            return undefined;
        const seq = this.#nextSeq();
        const startedAt = this.#clock.now();
        this.#lastReadStart.delete(key);
        this.#lastReadStart.set(key, startedAt);
        while (this.#lastReadStart.size > MAX_ORDER_ENTRIES)
            this.#lastReadStart.delete(this.#lastReadStart.keys().next().value);
        const promise = this.#read(orderId, startedAt).finally(() => {
            release();
            this.#flights.delete(key);
        });
        const flight = { startedAt, seq, promise };
        this.#flights.set(key, flight);
        return flight;
    }
    async #read(orderId, startedAt) {
        const controller = new AbortController();
        let observation;
        try {
            const result = await raceDeadline(Promise.resolve().then(() => this.#reader.getOrder(orderId, controller.signal)), this.#readTimeoutMs);
            if (result === TIMED_OUT) {
                controller.abort();
                return { ok: false, code: "timeout", startedAt };
            }
            observation = result;
        }
        catch (error) {
            // Unknown, non-adapter failures are programming or wiring errors: not retried.
            return { ok: false, code: error instanceof ProdigiSandboxError ? error.code : "reader_error", startedAt };
        }
        if (observation === null || typeof observation !== "object" || observation.orderId !== orderId) {
            return { ok: false, code: "invalid_response", startedAt };
        }
        try {
            return { ok: true, result: await this.#apply(orderId, observation, startedAt), startedAt };
        }
        catch {
            // Store blips and CAS exhaustion while applying are transient: retryable.
            return { ok: false, code: "store_unavailable", startedAt };
        }
    }
    async #apply(orderId, observation, startedAt) {
        const result = (status, state) => Object.freeze({ status, orderId, attempts: 1, delaysMs: Object.freeze([]), state });
        const startedIso = iso(startedAt);
        const confirm = (state) => state.confirmedAt !== null && Date.parse(state.confirmedAt) >= startedAt ? state.confirmedAt : startedIso;
        for (let round = 0; round < CAS_ROUNDS; round += 1) {
            const current = await this.#getOrder(orderId);
            if (current === undefined)
                return result("untracked_order", undefined);
            const decision = decideProdigiOrdering(current, observation);
            if (decision === "stale")
                return result("stale_rejected", current);
            if (decision === "regression")
                return result("regression_rejected", current);
            let next;
            if (decision === "unchanged") {
                // Record that a read confirmed the state, so callbacks received before it are covered.
                if (current.confirmedAt !== null && Date.parse(current.confirmedAt) >= startedAt)
                    return result("unchanged", current);
                next = Object.freeze({ ...current, revision: current.revision + 1, confirmedAt: startedIso });
            }
            else if (decision === "terminal_conflict") {
                if (current.conflict)
                    return result("terminal_conflict", current);
                next = Object.freeze({ ...current, revision: current.revision + 1, conflict: true });
            }
            else {
                next = Object.freeze({
                    orderId,
                    revision: current.revision + 1,
                    stage: observation.stage,
                    normalizedState: observation.normalizedState,
                    details: Object.freeze({ ...observation.details }),
                    shipmentIds: Object.freeze(observation.shipments.map((s) => s.id).sort()),
                    lastUpdated: observation.lastUpdated,
                    observationDigest: observationDigest(observation),
                    reconciledAt: iso(this.#clock.now()),
                    confirmedAt: confirm(current),
                    conflict: current.conflict
                });
            }
            if (await this.#cas(orderId, current.revision, next)) {
                return result(decision === "apply" ? "applied" : decision === "unchanged" ? "unchanged" : "terminal_conflict", next);
            }
        }
        throw new ProdigiCallbackError("store_unavailable");
    }
    // -------------------------------------------------------------------------
    // Coverage, coalescing and scheduling
    /** A read confirmed by the store started more than the worker skew margin after receipt (our clock), and reached any claimed stage. */
    #satisfied(state, need) {
        if (state.confirmedAt === null)
            return false;
        return Date.parse(state.confirmedAt) > need.after + this.#workerSkewMs && stageMet(state, need.stage);
    }
    #intervalRemaining(key) {
        const last = this.#lastReadStart.get(key);
        if (last === undefined)
            return 0;
        return Math.max(0, last + this.#minReadIntervalMs - this.#clock.now());
    }
    #backoffCap(attempt) {
        return Math.min(this.#maxDelayMs, this.#initialDelayMs * 2 ** (attempt - 1));
    }
    #jitter(attempt) {
        const r = this.#random();
        const unit = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.5;
        return Math.max(1, Math.ceil(this.#backoffCap(attempt) * unit));
    }
    /** Full jitter for background job `attempt` (1-based): uniform in (0, min(max, initial * 2^(attempt-1))]. */
    #jobJitter(attempt) {
        const r = this.#random();
        const unit = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.5;
        const cap = Math.min(this.#jobMaxDelayMs, this.#jobInitialDelayMs * 2 ** Math.min(attempt - 1, 40));
        return Math.max(1, Math.ceil(cap * unit));
    }
    #job(record, delayMs) {
        return Object.freeze({
            key: scopeKey(this.#scope, record.orderId),
            orderId: record.orderId,
            attempt: record.attempt,
            delayMs,
            coverAfter: record.coverAfter,
            requiredStage: record.requiredStage
        });
    }
    /** Job delays are at least the worker skew margin, so a job's read starts after `coverAfter + workerClockSkewMs`. */
    #jobDelay(minDelayMs, step) {
        return Math.max(minDelayMs, this.#workerSkewMs + 1, this.#jobJitter(step));
    }
    /**
     * Whether the authoritative state covers a pending record: a read that
     * started more than the worker skew margin after the record's newest
     * receipt, and that reached its claimed stage. A terminal state always covers.
     */
    #covers(record, state) {
        if (isTerminalStage(state.stage) || state.conflict)
            return true;
        return this.#receiptsCovered(record, state) && stageMet(state, record.requiredStage);
    }
    /** Every merged receipt is older than the latest applied read (claims aside). */
    #receiptsCovered(record, state) {
        if (state === undefined || state.confirmedAt === null)
            return false;
        return Date.parse(state.confirmedAt) > Date.parse(record.coverAfter) + this.#workerSkewMs;
    }
    /**
     * Record in the store that a covering read is owed. If a live pending record
     * exists, merge this callback's requirement into it (its job will see it, so
     * acknowledging is safe). A newer receipt resets the record's retry budget,
     * so it is never abandoned on another callback's budget. Otherwise create a
     * record, subject to `maxPendingJobs` counted from the store, and schedule
     * its job. Returns whether a job owns the requirement.
     */
    async #defer(orderId, need, minDelayMs, eventId) {
        const withEvent = (ids) => eventId === null || ids.includes(eventId) || ids.length >= MAX_PENDING_EVENT_IDS ? ids : Object.freeze([...ids, eventId]);
        for (let round = 0; round < CAS_ROUNDS; round += 1) {
            const now = this.#clock.now();
            const existing = await this.#getPending(orderId);
            if (existing !== undefined && Date.parse(existing.staleAt) > now) {
                const previousAfter = Date.parse(existing.coverAfter);
                const after = Math.max(previousAfter, need.after);
                const stage = maxStage(existing.requiredStage, need.stage);
                const eventIds = withEvent(existing.eventIds ?? []);
                if (after === previousAfter && stage === existing.requiredStage && eventIds === existing.eventIds)
                    return true;
                const fresh = after > previousAfter;
                const merged = Object.freeze({
                    ...existing,
                    revision: existing.revision + 1,
                    coverAfter: iso(after),
                    requiredStage: stage,
                    eventIds,
                    ...(fresh ? { budgetSince: iso(after), readsSpent: 0, refusals: 0 } : {})
                });
                if (await this.#casPending(orderId, existing.revision, merged))
                    return true;
                continue;
            }
            if (await this.#countPending(now) >= this.#maxPendingJobs)
                return false;
            const delayMs = this.#jobDelay(minDelayMs, 1);
            // An orphaned record's requirement is carried into the fresh chain.
            const after = existing === undefined ? need.after : Math.max(Date.parse(existing.coverAfter), need.after);
            const record = Object.freeze({
                orderId,
                revision: existing === undefined ? 0 : existing.revision + 1,
                coverAfter: iso(after),
                requiredStage: existing === undefined ? need.stage : maxStage(existing.requiredStage, need.stage),
                firstReceivedAt: existing === undefined ? iso(need.after) : existing.firstReceivedAt,
                budgetSince: iso(need.after),
                readsSpent: 0,
                refusals: 0,
                abandoning: null,
                eventIds: withEvent(existing === undefined ? [] : (existing.eventIds ?? [])),
                attempt: existing === undefined ? 1 : existing.attempt + 1,
                dueAt: iso(now + delayMs),
                staleAt: iso(now + delayMs + this.#pendingGraceMs)
            });
            if (!(await this.#casPending(orderId, existing?.revision ?? null, record)))
                continue;
            try {
                await this.#scheduler.schedule(this.#job(record, delayMs));
                return true;
            }
            catch {
                try {
                    await this.#casPending(orderId, record.revision, null);
                }
                catch {
                    // Left to expire at staleAt.
                }
                return false;
            }
        }
        return false;
    }
    /**
     * Reschedule the record's job. `kind: "read"` spends one read of the budget
     * (`maxAttempts`); `"refusal"` (limiter, interval, older in-flight read)
     * spends none. Both stop at `horizonMs` since the budget started.
     */
    async #reschedule(orderId, attempt, kind, errorCode, minDelayMs, done) {
        for (let round = 0; round < CAS_ROUNDS; round += 1) {
            const m = await this.#getPending(orderId);
            if (m === undefined)
                return done("obsolete", errorCode);
            if (attempt < m.attempt)
                return done("superseded", errorCode);
            if (m.abandoning !== null)
                return this.#abandon(orderId, m.abandoning.reason, m.abandoning.errorCode ?? undefined, done);
            const now = this.#clock.now();
            const readsSpent = m.readsSpent + (kind === "read" ? 1 : 0);
            const refusals = m.refusals + (kind === "refusal" ? 1 : 0);
            if (readsSpent >= this.#jobMaxAttempts)
                return this.#abandon(orderId, "retries_exhausted", errorCode, done, m.budgetSince, readsSpent);
            if (now - Date.parse(m.budgetSince) >= this.#jobHorizonMs)
                return this.#abandon(orderId, "horizon_exceeded", errorCode, done, m.budgetSince, readsSpent);
            // Refusals are floored at jobInitialDelayMs, so a refusing limiter cannot cause a hot loop.
            const floor = kind === "refusal" ? Math.max(minDelayMs, this.#jobInitialDelayMs) : minDelayMs;
            const delayMs = this.#jobDelay(floor, Math.max(readsSpent, refusals) + 1);
            const next = Object.freeze({
                ...m, revision: m.revision + 1, attempt: m.attempt + 1, readsSpent, refusals,
                dueAt: iso(now + delayMs), staleAt: iso(now + delayMs + this.#pendingGraceMs)
            });
            if (!(await this.#casPending(orderId, m.revision, next)))
                continue;
            try {
                await this.#scheduler.schedule(this.#job(next, delayMs));
            }
            catch {
                return this.#abandon(orderId, "schedule_failed", errorCode, done);
            }
            return done("rescheduled", errorCode);
        }
        throw new ProdigiCallbackError("store_unavailable");
    }
    /**
     * After a successful read, clear the pending record if the resulting state
     * covers it. Atomic, so a callback merged during the read keeps the record.
     * The merged event IDs are then recorded as reconciled.
     */
    async #settle(orderId, state) {
        for (let round = 0; round < CAS_ROUNDS; round += 1) {
            const m = await this.#getPending(orderId);
            if (m === undefined)
                return "none";
            if (!this.#covers(m, state))
                return "remaining";
            if (await this.#casPending(orderId, m.revision, null)) {
                for (const eventId of m.eventIds ?? [])
                    await this.#recordEvent(orderId, eventId);
                return "cleared";
            }
        }
        return "remaining";
    }
    async #settleQuietly(orderId, state) {
        try {
            await this.#settle(orderId, state);
        }
        catch {
            // Best effort: the pending job still runs and finds the order covered.
        }
    }
    async #clearPending(orderId) {
        for (let round = 0; round < CAS_ROUNDS; round += 1) {
            const m = await this.#getPending(orderId);
            if (m === undefined || await this.#casPending(orderId, m.revision, null))
                return;
        }
    }
    /**
     * Report a chain as abandoned, at least once and without duplicates in the
     * normal case:
     *
     * 1. Re-read the record. Gone: `obsolete` (no hook). Covered by a read
     *    meanwhile: settle it (no hook).
     * 2. Claim it by compare-and-set: `abandoning` with a unique `claimId`, a
     *    lease, and the `coverAfter`, `requiredStage` and reads it reports. Only
     *    the run whose claim succeeds calls the hook; a run that finds a live
     *    claim held by another run schedules a check job for the lease expiry.
     *    A retry or takeover of an expired claim first checks whether a newer
     *    receipt (or claim) was merged since; if so it drops the claim and
     *    resumes a fresh chain, so that receipt gets its own read.
     * 3. Call the hook. If it throws, release the lease and rethrow, so the
     *    queue retries and the hook is called again. A crash here leaves the
     *    claim, which expires and is taken over by the job's redelivery.
     * 4. If the claim is still ours, delete the record by compare-and-set, or,
     *    if a newer receipt was merged while the hook ran, resume a fresh chain
     *    for it. If another run took the claim over, leave the record to it.
     *
     * `claim_unconfirmed` is used only when every merged receipt is older than
     * the latest applied read and just the stage claim is unmet; otherwise a
     * budget that ran out on non-covering reads is `receipt_uncovered`.
     * `readsSpent` is the number of reads this budget spent, including the one
     * that triggered the abandonment.
     */
    async #abandon(orderId, reason, errorCode, done, budgetSince, readsSpent) {
        let claimed;
        for (let round = 0; round < CAS_ROUNDS && claimed === undefined; round += 1) {
            const m = await this.#getPending(orderId);
            if (m === undefined)
                return done("obsolete", errorCode);
            const now = this.#clock.now();
            const prior = m.abandoning;
            if (prior !== null && Date.parse(prior.leaseUntil) > now) {
                const waitMs = Math.max(this.#workerSkewMs + 1, Date.parse(prior.leaseUntil) - now + 1);
                await this.#scheduler.schedule(this.#job(m, waitMs));
                return done("abandon_pending", errorCode);
            }
            const state = await this.#getOrder(orderId);
            if (state === undefined) {
                await this.#clearPending(orderId);
                return done("untracked_order");
            }
            if (this.#covers(m, state)) {
                if ((await this.#settle(orderId, state)) === "remaining")
                    continue;
                return done("covered");
            }
            if (prior !== null && this.#mergedSince(m, prior)) {
                // Retry or takeover of a claim made before a newer receipt arrived:
                // that receipt was never read, so resume instead of reporting it.
                if (await this.#resume(orderId, m))
                    return done("rescheduled", errorCode);
                continue;
            }
            if (prior === null && budgetSince !== undefined && m.budgetSince !== budgetSince) {
                // A newer receipt was merged and reset the budget: it gets its own reads.
                return this.#reschedule(orderId, m.attempt, "refusal", errorCode, 0, done);
            }
            let effective = prior?.reason ?? reason;
            const code = prior !== null ? (prior.errorCode ?? undefined) : errorCode;
            if (prior === null && (effective === "retries_exhausted" || effective === "horizon_exceeded")) {
                if (this.#receiptsCovered(m, state))
                    effective = "claim_unconfirmed";
                else if (code === undefined)
                    effective = "receipt_uncovered";
            }
            const leaseUntil = now + this.#pendingGraceMs;
            const next = Object.freeze({
                ...m,
                revision: m.revision + 1,
                abandoning: Object.freeze({
                    claimId: randomUUID(),
                    reason: effective,
                    errorCode: code ?? null,
                    leaseUntil: iso(leaseUntil),
                    coverAfter: m.coverAfter,
                    requiredStage: m.requiredStage,
                    readsSpent: prior?.readsSpent ?? Math.max(m.readsSpent, readsSpent ?? m.readsSpent)
                }),
                staleAt: iso(Math.max(Date.parse(m.staleAt), leaseUntil + this.#pendingGraceMs))
            });
            if (await this.#casPending(orderId, m.revision, next))
                claimed = next;
        }
        if (claimed === undefined || claimed.abandoning === null)
            throw new ProdigiCallbackError("store_unavailable");
        const claim = claimed.abandoning;
        const event = Object.freeze({
            outcome: "reconcile_abandoned",
            scope: this.#scope,
            orderId,
            reason: claim.reason,
            attempts: claim.readsSpent,
            coverAfter: claim.coverAfter,
            requiredStage: claim.requiredStage,
            firstReceivedAt: claimed.firstReceivedAt,
            abandonedAt: iso(this.#clock.now()),
            dedupeKey: `${orderId}|${claimed.firstReceivedAt}|${claim.coverAfter}`,
            ...(claim.errorCode === null ? {} : { errorCode: claim.errorCode })
        });
        if (this.#onAbandoned !== undefined) {
            try {
                await this.#onAbandoned(event);
            }
            catch (error) {
                try {
                    const m = await this.#getPending(orderId);
                    if (m !== undefined && m.abandoning?.claimId === claim.claimId) {
                        await this.#casPending(orderId, m.revision, Object.freeze({ ...m, revision: m.revision + 1, abandoning: Object.freeze({ ...claim, leaseUntil: iso(0) }) }));
                    }
                }
                catch {
                    // The lease expires on its own.
                }
                throw error;
            }
        }
        for (let round = 0; round < CAS_ROUNDS; round += 1) {
            const m = await this.#getPending(orderId);
            // Gone, or taken over by another run (the hook outlived the lease): the
            // record is no longer ours to delete or resume.
            if (m === undefined || m.abandoning === null || m.abandoning.claimId !== claim.claimId)
                break;
            if (this.#mergedSince(m, claim)) {
                // A newer receipt (or claim) was merged while the hook ran. The
                // reported part is done; resume a fresh chain for the rest.
                if (await this.#resume(orderId, m))
                    break;
                continue;
            }
            if (await this.#casPending(orderId, m.revision, null))
                break;
        }
        return done("reconcile_abandoned", claim.errorCode ?? undefined, claim.reason);
    }
    /** Whether a receipt newer than the claim's, or a higher stage claim, was merged after it was made. */
    #mergedSince(record, claim) {
        return Date.parse(record.coverAfter) > Date.parse(claim.coverAfter) || stageRank(record.requiredStage) > stageRank(claim.requiredStage);
    }
    /**
     * Drop an abandon claim and resume a fresh chain (full budget from the
     * newest receipt). The job keeps the record's attempt number, so if
     * `schedule()` throws here the error propagates and the queue's retry of
     * the current job runs the resumed chain itself.
     */
    async #resume(orderId, m) {
        const now = this.#clock.now();
        const delayMs = this.#jobDelay(this.#jobInitialDelayMs, 1);
        const resumed = Object.freeze({
            ...m, revision: m.revision + 1, abandoning: null, readsSpent: 0, refusals: 0, budgetSince: m.coverAfter,
            dueAt: iso(now + delayMs), staleAt: iso(now + delayMs + this.#pendingGraceMs)
        });
        if (!(await this.#casPending(orderId, m.revision, resumed)))
            return false;
        await this.#scheduler.schedule(this.#job(resumed, delayMs));
        return true;
    }
    #inProcessScheduler() {
        return Object.freeze({
            durable: false,
            schedule: (job) => {
                const timer = setTimeout(() => {
                    this.#timers.delete(timer);
                    this.runScheduledReconciliation(job).catch(() => undefined);
                }, job.delayMs);
                timer.unref?.();
                this.#timers.add(timer);
            }
        });
    }
    async #recordEvent(orderId, eventId) {
        try {
            await this.#store.recordEvent({ scope: this.#scope, orderId, eventId, expiresAt: iso(this.#clock.now() + this.#replayTtlMs) });
        }
        catch {
            // The state is already applied, so a missing replay record only costs a
            // read on redelivery.
        }
    }
    // -------------------------------------------------------------------------
    // Token and store helpers
    async #verifyToken(presented) {
        if (typeof presented !== "string" || !TOKEN_PATTERN.test(presented))
            throw new ProdigiCallbackError("callback_forged");
        // The current token must resolve and be well formed, or the gate fails closed.
        const current = await this.#matchToken(this.#tokenReference, presented);
        if (current === "unavailable")
            throw new ProdigiCallbackError("callback_token_unavailable");
        // A previous token is optional during rotation; if it is unavailable it simply never matches.
        const previous = this.#previousTokenReference === undefined ? "nomatch" : await this.#matchToken(this.#previousTokenReference, presented);
        if (current === "match")
            return "current";
        if (previous === "match")
            return "previous";
        throw new ProdigiCallbackError("callback_forged");
    }
    async #matchToken(reference, presented) {
        try {
            const matched = await withServerSecret({
                providerId: "prodigi",
                secretReference: reference,
                mode: "sandbox",
                source: this.#secrets,
                use: async ({ secret }) => {
                    if (secret.length < MIN_TOKEN_LENGTH || secret.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(secret))
                        throw new Error("unusable");
                    return timingSafeEqual(digestToken(presented), digestToken(secret));
                }
            });
            return matched ? "match" : "nomatch";
        }
        catch {
            return "unavailable";
        }
    }
    async #getOrder(orderId) {
        try {
            return await this.#store.getOrder({ scope: this.#scope, orderId });
        }
        catch {
            throw new ProdigiCallbackError("store_unavailable");
        }
    }
    async #cas(orderId, expectedRevision, next) {
        let written;
        try {
            written = await this.#store.compareAndSetOrder({ scope: this.#scope, orderId, expectedRevision, next });
        }
        catch {
            throw new ProdigiCallbackError("store_unavailable");
        }
        if (typeof written !== "boolean")
            throw new ProdigiCallbackError("store_unavailable");
        return written;
    }
    async #getPending(orderId) {
        try {
            return await this.#store.getPendingReconciliation({ scope: this.#scope, orderId });
        }
        catch {
            throw new ProdigiCallbackError("store_unavailable");
        }
    }
    async #casPending(orderId, expectedRevision, next) {
        let written;
        try {
            written = await this.#store.compareAndSetPendingReconciliation({ scope: this.#scope, orderId, expectedRevision, next });
        }
        catch {
            throw new ProdigiCallbackError("store_unavailable");
        }
        if (typeof written !== "boolean")
            throw new ProdigiCallbackError("store_unavailable");
        return written;
    }
    async #countPending(now) {
        let count;
        try {
            count = await this.#store.countPendingReconciliations({ scope: this.#scope, now: iso(now) });
        }
        catch {
            throw new ProdigiCallbackError("store_unavailable");
        }
        if (!Number.isSafeInteger(count) || count < 0)
            throw new ProdigiCallbackError("store_unavailable");
        return count;
    }
}
