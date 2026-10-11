import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { ProviderAttempt, ProviderObserver } from "@/server/ai/providers";
import { HttpError } from "@/server/http";
import { outcomeOf, sanitizeOpsEvent, type OpsName, type OpsValue } from "./schema";
import { activeSink, opsEnvironment, type OpsSink } from "./sink";

// Operational measurement for the AI-backed API routes. A route wrapped in observeRoute gets one server-generated
// operation id; everything measured while it runs (provider attempts, source fetches, parses) is tied to that id
// through AsyncLocalStorage, and one api_request event closes the operation.
//
// Measurement is a side effect, never a reason for a request to change: with collection off nothing is built,
// and with it on every sink failure is swallowed and counted. Responses keep their status, body, 204s and
// fallbacks; the only addition is an `x-ticketstub-operation` header carrying the random operation id, so support
// can find the matching log lines. That id grants nothing and is never read back from a request.

export type OpsRoute = "research" | "art" | "agent";

interface Operation {
  id: string;
  sink: OpsSink;
  environment: ReturnType<typeof opsEnvironment>;
  mode: "demo" | "live";
  fields: Record<string, OpsValue | undefined>;
  attempts: number;
}

const store = new AsyncLocalStorage<Operation>();
const stats = { emitted: 0, rejected: 0, droppedFields: 0, sinkErrors: 0 };
let warned = false;

const newId = (prefix: "op" | "att") => `${prefix}_${randomBytes(12).toString("base64url")}`;
const now = () => performance.now();

/** In-process counters (no payloads): how many events were written, refused, trimmed, or lost to a sink failure. */
export const opsStats = () => ({ ...stats });
export function resetOpsStats(): void {
  stats.emitted = stats.rejected = stats.droppedFields = stats.sinkErrors = 0;
}

function sinkFailed(): void {
  stats.sinkErrors++;
  if (!warned) {
    warned = true;
    console.warn("[ops] telemetry sink failed; operational events are being dropped");
  }
}

function emit(op: Operation, name: OpsName, fields: Record<string, OpsValue | undefined>): void {
  try {
    const built = sanitizeOpsEvent({ name, operationId: op.id, environment: op.environment, mode: op.mode, fields });
    if (!built) {
      stats.rejected++;
      return;
    }
    stats.droppedFields += built.dropped;
    const written = op.sink.write(built.event);
    stats.emitted++;
    if (written && typeof (written as Promise<void>).then === "function") (written as Promise<void>).then(undefined, sinkFailed);
  } catch {
    sinkFailed();
  }
}

/**
 * Wraps a route handler as one measured product operation. When collection is off the handler runs untouched.
 * Thrown errors are measured with the status the surrounding error handling will give them, then rethrown.
 */
export function observeRoute(route: OpsRoute, handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const sink = activeSink();
    if (!sink) return handler(req);
    const op: Operation = {
      id: newId("op"),
      sink,
      environment: opsEnvironment(),
      mode: process.env.TICKETSTUB_RUNTIME_MODE === "live" ? "live" : "demo",
      fields: {},
      attempts: 0,
    };
    const started = now();
    const finish = (status: number, code?: string) => {
      const aborted = req.signal.aborted;
      emit(op, "api_request", {
        operation: "unknown",
        dependency: "none",
        fallback: "none",
        ...op.fields,
        route,
        status,
        outcome: outcomeOf(status, aborted),
        durationMs: now() - started,
        aborted,
        attempts: op.attempts,
        // Only whether the caller sent its own correlation header; the value itself is never kept.
        clientCorrelation: req.headers.has("x-request-id"),
        ...(code ? { code } : {}),
      });
    };
    let res: Response;
    try {
      res = await store.run(op, () => handler(req));
    } catch (e) {
      finish(e instanceof HttpError ? e.status : 500, e instanceof HttpError ? e.code : "internal");
      throw e;
    }
    finish(res.status);
    try {
      res.headers.set("x-ticketstub-operation", op.id);
    } catch {
      /* immutable headers */
    }
    return res;
  };
}

/** Adds categorical facts about the current operation (dependency, fallback, code, counts). No-op outside one. */
export function annotate(fields: Record<string, OpsValue | undefined>): void {
  const op = store.getStore();
  if (op) Object.assign(op.fields, fields);
}

/** True while an operation is being measured (lets callers skip work that only feeds measurement). */
export const measuring = (): boolean => store.getStore() !== undefined;

/** The provider transport's observer for the current operation, or undefined when nothing is measured. */
export function providerObserver(): ProviderObserver | undefined {
  const op = store.getStore();
  if (!op) return undefined;
  return (a: ProviderAttempt) => {
    const usage = a.metadata?.usage;
    const reported = !!usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.costUsd].some((v) => v !== undefined);
    emit(op, "provider_attempt", {
      attemptId: newId("att"),
      attempt: ++op.attempts,
      capability: a.capability,
      provider: a.provider,
      phase: a.phase,
      model: a.model,
      returnedModel: a.metadata?.returnedModel,
      upstreamProvider: a.metadata?.upstreamProvider,
      outcome: a.ok ? "ok" : a.reason === "timeout" ? "timeout" : a.reason === "aborted" ? "cancelled" : "error",
      code: a.code,
      upstreamStatus: a.upstreamStatus,
      durationMs: a.durationMs,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      // Only what the provider returned in this response. Nothing is estimated here; absent stays unknown.
      costUsd: usage?.costUsd,
      costSource: usage?.costUsd !== undefined ? "provider_reported" : "unknown",
      usageReported: reported,
    });
  };
}

export type SourceName = "event_page" | "ticketmaster" | "weather_geocode" | "weather_forecast" | "weather_archive";
export type SourceOutcome = "ok" | "http_error" | "timeout" | "network_error" | "no_match" | "no_data" | "pending" | "skipped" | "rate_limited" | "auth_failed" | "not_found" | "bad_response";

/** A started clock for a source fetch; call the result to record how it ended. No-op outside an operation. */
export function sourceTimer(source: SourceName): (outcome: SourceOutcome, upstreamStatus?: number) => void {
  const op = store.getStore();
  if (!op) return () => {};
  const started = now();
  let done = false;
  return (outcome, upstreamStatus) => {
    if (done) return;
    done = true;
    emit(op, "source_fetch", { source, outcome, upstreamStatus, durationMs: now() - started });
  };
}

/** Classifies a thrown fetch failure without reading its message. */
export function fetchFailure(error: unknown): SourceOutcome {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
}

export function recordParse(fields: { parser: "schema_org" | "title" | "none"; facts: number; date: boolean }): void {
  const op = store.getStore();
  if (op) emit(op, "source_parse", { ...fields, outcome: fields.parser === "none" ? "empty" : "ok" });
}
