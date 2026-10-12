import "server-only";
import type { DatabaseSync } from "node:sqlite";
import {
  ProdigiCallbackReconciler,
  type ProdigiReadLimiter,
} from "../vendor/fulfillment-connectors/dist/prodigi-callbacks.js";
import {
  ProdigiSandboxClient,
  createFetchProdigiHttpPort,
  type ProdigiHttpPort,
} from "../vendor/fulfillment-connectors/dist/prodigi-sandbox.js";
import { createEnvServerSecretSource, PRODIGI_SANDBOX_SECRET_BINDING } from "../vendor/fulfillment-connectors/dist/prodigi-secrets.js";
import type { SandboxDecisionVerifier } from "../vendor/fulfillment-connectors/dist/provider-matrix.js";
import type { ServerSecretSource } from "../vendor/fulfillment-connectors/dist/security.js";
import { openDatabase } from "../sqlite";
import { dbPath } from "../index";
import {
  CALLBACK_TOKEN_BINDING,
  CALLBACK_TOKEN_PREVIOUS_BINDING,
  PRODIGI_SANDBOX_DECISION,
  prodigiCallbackMode,
  prodigiEnvironment,
  prodigiScope,
  type ProdigiEnvironment,
} from "./prodigi-config";
import { migrateProdigi } from "./prodigi-migrations";
import { abandonAlertHook, ProdigiJobWorker, SqliteProdigiJobQueue } from "./prodigi-jobs";
import { SqliteProdigiStore } from "./prodigi-store";

// Assembles the getticketstub side of Prodigi sandbox callbacks: the vendored ProdigiCallbackReconciler over the
// durable SQLite store and job queue, the abandon hook, and the worker loop. It exists only while
// TICKETSTUB_PRODIGI_CALLBACKS=sandbox; otherwise prodigiCallbackHost() is null and nothing is opened or read.

/** Raw body cap for the route and the reconciler (the reconciler's default, 512 KiB). */
export const PRODIGI_CALLBACK_MAX_BODY_BYTES = 512 * 1024;

/**
 * Fails closed: no owner decision is verified, so every sandbox read (and order) is refused as
 * decision_unverified before a credential is loaded or a request is built. 0003 blocker 5 replaces this with a
 * verifier that resolves the 0003 record.
 */
export const UNVERIFIED_DECISION: SandboxDecisionVerifier = Object.freeze({ verify: async () => undefined });

export interface ProdigiHostOptions {
  readonly db: DatabaseSync;
  /** Partitions the shared database: the scope, job rows and alert rows all carry it. */
  readonly environment: ProdigiEnvironment;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly http?: ProdigiHttpPort;
  readonly decisionVerifier?: SandboxDecisionVerifier;
  readonly clock?: { now(): number };
  readonly random?: () => number;
  readonly readLimiter?: ProdigiReadLimiter;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly log?: (line: string) => void;
  /** Passed through to the reconciler (tests shorten these). */
  readonly reconciler?: { minReadIntervalMs?: number; requestDeadlineMs?: number; workerClockSkewMs?: number; jobRetryPolicy?: { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number; horizonMs?: number } };
}

export interface ProdigiHost {
  readonly db: DatabaseSync;
  readonly environment: ProdigiEnvironment;
  readonly scope: { readonly tenantId: string; readonly projectId: string };
  readonly store: SqliteProdigiStore;
  readonly queue: SqliteProdigiJobQueue;
  readonly reconciler: ProdigiCallbackReconciler;
  readonly worker: ProdigiJobWorker;
  readonly secrets: ServerSecretSource;
  readonly maxBodyBytes: number;
  close(): void;
}

export function prodigiSecretSource(env?: Readonly<Record<string, string | undefined>>): ServerSecretSource {
  return createEnvServerSecretSource({
    bindings: [PRODIGI_SANDBOX_SECRET_BINDING, CALLBACK_TOKEN_BINDING, CALLBACK_TOKEN_PREVIOUS_BINDING],
    ...(env ? { env } : {}),
  });
}

/** Builds a host on `db`. Always sandbox: the reconciler itself refuses any other mode. */
export function createProdigiHost(options: ProdigiHostOptions): ProdigiHost {
  const { db } = options;
  migrateProdigi(db);
  const clock = options.clock ?? { now: () => Date.now() };
  const log = options.log;
  const store = new SqliteProdigiStore(db, { clock });
  const scope = prodigiScope(options.environment);
  const queue = new SqliteProdigiJobQueue(db, { environment: options.environment, clock, ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}) });
  const secrets = prodigiSecretSource(options.env);
  // The reader for authenticated reads. Sandbox calls are permitted at this layer, but every call still needs the
  // verified owner decision (UNVERIFIED_DECISION refuses) and the sandbox API key.
  const reader = new ProdigiSandboxClient({
    http: options.http ?? createFetchProdigiHttpPort(),
    secrets,
    decision: PRODIGI_SANDBOX_DECISION,
    decisionVerifier: options.decisionVerifier ?? UNVERIFIED_DECISION,
    sandboxCallsEnabled: true,
  });
  const reconciler = new ProdigiCallbackReconciler({
    mode: "sandbox",
    trustedScope: scope,
    reader,
    store,
    callbacksEnabled: true,
    secrets,
    callbackTokenReference: CALLBACK_TOKEN_BINDING.reference,
    previousCallbackTokenReference: CALLBACK_TOKEN_PREVIOUS_BINDING.reference,
    maxBodyBytes: PRODIGI_CALLBACK_MAX_BODY_BYTES,
    scheduler: queue,
    onReconcileAbandoned: abandonAlertHook(db, queue, { clock, ...(log ? { log } : {}) }),
    clock,
    ...(options.random ? { random: options.random } : {}),
    ...(options.readLimiter ? { readLimiter: options.readLimiter } : {}),
    ...(options.reconciler ?? {}),
  });
  const worker = new ProdigiJobWorker({ db, queue, reconciler, clock, ...(options.workerId ? { workerId: options.workerId } : {}), ...(log ? { log } : {}) });
  return {
    db, environment: options.environment, scope, store, queue, reconciler, worker, secrets,
    maxBodyBytes: PRODIGI_CALLBACK_MAX_BODY_BYTES,
    close() {
      worker.stop();
      reconciler.close();
    },
  };
}

// ---- process singleton ----

const g = globalThis as unknown as { __ticketstubProdigiHost?: ProdigiHost | null; __ticketstubProdigiRefusalLogged?: boolean };

const refuseOnce = (line: string) => {
  if (g.__ticketstubProdigiRefusalLogged) return;
  g.__ticketstubProdigiRefusalLogged = true;
  console.warn(line);
};

/**
 * The process's host, or null when callbacks are off. Opens its own connection to TICKETSTUB_DB (WAL, so it
 * shares the file safely with the storage connection) and starts the worker loop. Callbacks stay off unless
 * TICKETSTUB_OPS_ENVIRONMENT names the environment, because Preview and Publish share the database. Throws if the
 * database cannot be opened or migrated, after closing the connection it opened; the route answers 503 (404 for a
 * wrong token).
 */
export function prodigiCallbackHost(open: () => DatabaseSync = () => openDatabase(dbPath())): ProdigiHost | null {
  const mode = prodigiCallbackMode();
  if (mode.state !== "sandbox") {
    if (mode.state === "refused") refuseOnce(`[prodigi] TICKETSTUB_PRODIGI_CALLBACKS=${mode.value === "live" ? "live is refused (sandbox only)" : "<unrecognized> is treated as off"}; callbacks stay off`);
    return null;
  }
  const environment = prodigiEnvironment();
  if (!environment) {
    refuseOnce("[prodigi] TICKETSTUB_OPS_ENVIRONMENT must be production, preview, development or test; callbacks stay off");
    return null;
  }
  if (g.__ticketstubProdigiHost) return g.__ticketstubProdigiHost;
  const db = open();
  let host: ProdigiHost;
  try {
    host = createProdigiHost({ db, environment });
    host.worker.start();
  } catch (e) {
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    throw e;
  }
  g.__ticketstubProdigiHost = host;
  console.log(`[prodigi] sandbox callbacks on (${environment}); job worker started`);
  return host;
}

/** Starts the worker at boot (instrumentation), so queued jobs resume after a restart without waiting for a callback. */
export function startProdigiCallbackWorker(): void {
  try {
    prodigiCallbackHost();
  } catch (e) {
    console.error("[prodigi] callback worker not started:", e instanceof Error ? e.message : "unknown");
  }
}

/** Tests only: drop the singleton. */
export function resetProdigiCallbackHost(): void {
  g.__ticketstubProdigiHost?.close();
  g.__ticketstubProdigiHost = undefined;
  g.__ticketstubProdigiRefusalLogged = undefined;
}
