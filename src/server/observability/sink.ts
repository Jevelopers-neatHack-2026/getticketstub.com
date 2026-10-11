// Where sanitized operational events go. Collection is off unless TICKETSTUB_OPS_TELEMETRY names a sink.
//
//   TICKETSTUB_OPS_TELEMETRY=off   (default; also any unknown value) — nothing is built or written
//   TICKETSTUB_OPS_TELEMETRY=log   — one JSON line per event on stdout, prefixed by nothing, schema ticketstub.ops/1
//
// The log sink relies on the host's log pipeline for retention (see docs/operations/observability.md). Tests
// install the in-memory collector with setOpsSink; nothing here makes a network call.
import { OPS_ENVIRONMENTS, type OpsEnvironment, type OpsEvent } from "./schema";

export interface OpsSink {
  readonly name: string;
  /** May throw or reject: the caller isolates every failure from the request. */
  write(event: OpsEvent): void | Promise<void>;
}

/** Structured stdout lines: the event is already sanitized, so it is written as is and nothing else is added. */
export const logSink: OpsSink = {
  name: "log",
  write(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  },
};

export interface MemoryCollector extends OpsSink {
  readonly events: OpsEvent[];
  clear(): void;
}

/** Offline collector for tests and local inspection: keeps the newest `limit` events in process memory. */
export function memoryCollector(limit = 1000): MemoryCollector {
  const events: OpsEvent[] = [];
  return {
    name: "memory",
    events,
    write(event) {
      events.push(event);
      if (events.length > limit) events.splice(0, events.length - limit);
    },
    clear() {
      events.length = 0;
    },
  };
}

const g = globalThis as unknown as { __ticketstubOpsSink?: OpsSink | null };

/** Replaces the configured sink (tests). `null` forces collection off; `undefined` returns to configuration. */
export function setOpsSink(sink: OpsSink | null | undefined): void {
  if (sink === undefined) delete g.__ticketstubOpsSink;
  else g.__ticketstubOpsSink = sink;
}

/** The active sink, or undefined when collection is off. Read per operation so a restart is not needed in tests. */
export function activeSink(): OpsSink | undefined {
  if (g.__ticketstubOpsSink !== undefined) return g.__ticketstubOpsSink ?? undefined;
  return process.env.TICKETSTUB_OPS_TELEMETRY?.trim().toLowerCase() === "log" ? logSink : undefined;
}

export function opsEnvironment(): OpsEnvironment {
  const v = process.env.TICKETSTUB_OPS_ENVIRONMENT?.trim().toLowerCase();
  return (OPS_ENVIRONMENTS as readonly string[]).includes(v ?? "") ? (v as OpsEnvironment) : "unspecified";
}
