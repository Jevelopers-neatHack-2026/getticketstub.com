// Neatlogs trace export for operational events (ticketstub.ops/1). Off unless TICKETSTUB_OPS_TELEMETRY includes
// "neatlogs" AND NEATLOGS_INGEST_KEY (formerly NEATLOGS_API_KEY, still read as a fallback) is set.
//
// One measured operation (one /api/research, /api/art or /api/agent request) becomes one Neatlogs trace:
//   WORKFLOW span  ticketstub.<route>        from api_request (status, outcome, fallback, dependency, attempts)
//   LLM span       <capability>.<phase>      one per provider_attempt (model, provider, tokens, reported cost)
//   TOOL span      source.<name>             one per source_fetch (event page, Ticketmaster, weather)
//   TOOL span      parse.<parser>            one per source_parse
//   TOOL span      agent.<step>              one per agent_step (plan, result, followup, failure, recovery)
// The spans carry only the fields the ops schema already allow-lists. Nothing here sees prompts, page text, event
// titles, URLs, headers or any person, so nothing of that kind can be exported.
//
// Delivery is OTLP/HTTP protobuf to {NEATLOGS_ENDPOINT or https://ingest.neatlogs.com}/v1/traces with the project
// key in `x-api-key`, as documented by Neatlogs. Export is fire-and-forget: it never delays or changes a response, a
// failure is only counted, and a 2xx means "accepted by the receiver", not "stored" (see docs/operations/observability.md).
import { randomBytes } from "node:crypto";
import type { OpsEvent, OpsValue } from "./schema";

const DEFAULT_ENDPOINT = "https://ingest.neatlogs.com";
const ENDPOINT = /^https:\/\/(?:eu\.)?ingest\.neatlogs\.com$/;
const WORKFLOW = "ticketstub";
// The receiver groups SDK traffic by this instrumentation scope; it is the scope the official SDK (neatlogs@1.1.28)
// emits and that agent-harness#38 confirmed Neatlogs accepts and renders.
const SCOPE = { name: "neatlogs", version: "1.1.28" };
const MAX_PENDING_OPERATIONS = 200;
const MAX_EVENTS_PER_OPERATION = 64;
const PENDING_TTL_MS = 5 * 60_000;
const MAX_IN_FLIGHT = 8;
const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 256 * 1024;

export interface NeatlogsConfig { apiKey: string; endpoint: string; tags: string[] }
export interface NeatlogsStats { traces: number; accepted: number; rejectedSpans: number; failed: number; dropped: number }

/** Host settings are often pasted with surrounding quotes; strip one matching pair, nothing else. */
const unquote = (v: string | undefined) => v?.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** NEATLOGS_INGEST_KEY, or the pre-rename NEATLOGS_API_KEY while hosts rename their setting. */
export const ingestKeyOf = (env: NodeJS.ProcessEnv): string | undefined =>
  unquote(env.NEATLOGS_INGEST_KEY) || unquote(env.NEATLOGS_API_KEY) || undefined;

/** Why the Neatlogs settings cannot be used, in words safe to log (never a value), or undefined when they can. */
export function neatlogsConfigProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const apiKey = ingestKeyOf(env);
  if (!apiKey) return "NEATLOGS_INGEST_KEY is not set";
  if (/\s/.test(apiKey)) return "NEATLOGS_INGEST_KEY contains whitespace";
  const endpoint = (unquote(env.NEATLOGS_ENDPOINT) || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  if (!ENDPOINT.test(endpoint)) return "NEATLOGS_ENDPOINT must be empty, https://ingest.neatlogs.com or https://eu.ingest.neatlogs.com";
  return undefined;
}

/** Reads the Neatlogs settings, or undefined when export cannot run. The key is never logged or returned elsewhere. */
export function neatlogsConfig(env: NodeJS.ProcessEnv = process.env): NeatlogsConfig | undefined {
  if (neatlogsConfigProblem(env)) return undefined;
  const apiKey = ingestKeyOf(env)!;
  const endpoint = (unquote(env.NEATLOGS_ENDPOINT) || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const commit = env.TICKETSTUB_COMMIT_SHA?.trim();
  const tags = ["ticketstub", ...(commit && /^[0-9a-f]{7,40}$/.test(commit) ? [`ticketstub@${commit}`] : [])];
  return { apiKey, endpoint, tags };
}

// --- Minimal OTLP protobuf writer (opentelemetry.proto.collector.trace.v1), ported from agent-harness#38 ---

class Writer {
  private chunks: Uint8Array[] = [];
  private length = 0;
  bytes(value: Uint8Array) { this.chunks.push(value); this.length += value.length; }
  varint(value: number | bigint) {
    let n = BigInt(value);
    const out: number[] = [];
    while (n > BigInt(0x7f)) { out.push(Number((n & BigInt(0x7f)) | BigInt(0x80))); n >>= BigInt(7); }
    out.push(Number(n));
    this.bytes(Uint8Array.from(out));
  }
  tag(field: number, wire: number) { this.varint((field << 3) | wire); }
  delimited(field: number, payload: Uint8Array) { this.tag(field, 2); this.varint(payload.length); this.bytes(payload); }
  string(field: number, value: string) { this.delimited(field, Buffer.from(value, "utf8")); }
  message(field: number, build: (w: Writer) => void) { const w = new Writer(); build(w); this.delimited(field, w.finish()); }
  fixed64(field: number, value: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); this.tag(field, 1); this.bytes(b); }
  double(field: number, value: number) { const b = Buffer.alloc(8); b.writeDoubleLE(value); this.tag(field, 1); this.bytes(b); }
  finish(): Buffer { return Buffer.concat(this.chunks, this.length); }
}

type Attr = [string, OpsValue];
interface Span { spanId: string; parentSpanId?: string; name: string; startMs: number; endMs: number; error?: string; attributes: Attr[]; scope?: "internal" }

function attribute(w: Writer, field: number, [key, value]: Attr) {
  w.message(field, (kv) => {
    kv.string(1, key);
    kv.message(2, (any) => {
      if (typeof value === "string") any.string(1, value);
      else if (typeof value === "boolean") { any.tag(2, 0); any.varint(value ? 1 : 0); }
      else if (Number.isSafeInteger(value) && value >= 0) { any.tag(3, 0); any.varint(value); }
      else any.double(4, value);
    });
  });
}

const nanos = (ms: number) => BigInt(Math.max(0, Math.round(ms * 1000))) * BigInt(1000);

function writeSpan(w: Writer, traceId: string, s: Span) {
  w.message(2, (span) => {
    span.delimited(1, Buffer.from(traceId, "hex"));
    span.delimited(2, Buffer.from(s.spanId, "hex"));
    if (s.parentSpanId) span.delimited(4, Buffer.from(s.parentSpanId, "hex"));
    span.string(5, s.name);
    span.tag(6, 0); span.varint(1); // SPAN_KIND_INTERNAL
    span.fixed64(7, nanos(s.startMs));
    span.fixed64(8, nanos(Math.max(s.startMs, s.endMs)));
    for (const a of s.attributes) attribute(span, 9, a);
    span.message(15, (status) => {
      if (s.error) status.string(2, s.error);
      status.tag(3, 0); status.varint(s.scope === "internal" ? 0 : s.error ? 2 : 1); // UNSET / ERROR / OK
    });
  });
}

/** Encodes one operation's spans as an OTLP ExportTraceServiceRequest. */
export function encodeTrace(traceId: string, spans: Span[], tags: string[]): Buffer {
  const w = new Writer();
  w.message(1, (rs) => {
    rs.message(1, (resource) => {
      for (const a of [["service.name", WORKFLOW], ["neatlogs.workflow_name", WORKFLOW], ["neatlogs.tags", tags.join(",")],
        ["telemetry.sdk.name", "opentelemetry"], ["telemetry.sdk.language", "nodejs"]] as Attr[]) attribute(resource, 1, a);
    });
    rs.message(2, (ss) => {
      ss.message(1, (scope) => { scope.string(1, SCOPE.name); scope.string(2, SCOPE.version); });
      for (const s of spans) if (s.scope !== "internal") writeSpan(ss, traceId, s);
    });
    rs.message(2, (ss) => {
      ss.message(1, (scope) => scope.string(1, "neatlogs.internal"));
      for (const s of spans) if (s.scope === "internal") writeSpan(ss, traceId, s);
    });
  });
  return w.finish();
}

// --- Operation events -> spans ---

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const str = (v: OpsValue | undefined) => (v === undefined ? undefined : String(v));
const num = (v: OpsValue | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Builds the spans for one finished operation. Pure apart from random ids, so it is tested directly. */
export function buildTrace(events: OpsEvent[], tags: string[]): { traceId: string; spans: Span[] } | undefined {
  const closing = events.find((e) => e.name === "api_request");
  if (!closing) return undefined;
  const traceId = hex(16);
  const rootId = hex(8);
  const f = closing.fields;
  const rootEnd = closing.at;
  const rootStart = rootEnd - (num(f.durationMs) ?? 0);
  const common: Attr[] = [["neatlogs.session.id", closing.operationId], ["neatlogs.tags", tags.join(",")]];
  const failed = f.outcome !== "success" && f.outcome !== "no_content"; // api_request outcomes (schema OUTCOMES)
  const spans: Span[] = [{
    spanId: rootId, name: `${WORKFLOW}.${str(f.route) ?? "unknown"}`, startMs: rootStart, endMs: rootEnd,
    error: failed ? str(f.code) ?? str(f.outcome) : undefined,
    attributes: [
      ["neatlogs.span.kind", "WORKFLOW"], ["neatlogs.workflow.name", WORKFLOW], ["neatlogs.workflow_name", WORKFLOW], ...common,
      ["ticketstub.operation_id", closing.operationId], ["ticketstub.environment", closing.environment], ["ticketstub.mode", closing.mode],
      ...Object.entries(f).map(([k, v]) => [`ticketstub.${k}`, v] as Attr),
      ...(failed && (str(f.code) ?? str(f.outcome)) ? [["neatlogs.error.message", str(f.code) ?? str(f.outcome)!] as Attr] : []),
    ],
  }];
  for (const e of events) {
    if (e.operationId !== closing.operationId || e === closing) continue;
    const g = e.fields;
    const end = e.at;
    const start = end - (num(g.durationMs) ?? 0);
    const base = { spanId: hex(8), parentSpanId: rootId, startMs: Math.max(rootStart, start), endMs: end };
    if (e.name === "provider_attempt") {
      const err = g.outcome !== "ok" ? str(g.code) ?? str(g.outcome) : undefined;
      const attrs: Attr[] = [
        ["neatlogs.span.kind", "LLM"], ...common,
        ["neatlogs.llm.model_name", str(g.returnedModel) ?? str(g.model) ?? "unknown"],
        ["neatlogs.llm.provider", str(g.upstreamProvider) ?? str(g.provider) ?? "unknown"],
        ...Object.entries(g).map(([k, v]) => [`ticketstub.${k}`, v] as Attr),
      ];
      if (num(g.inputTokens) !== undefined) attrs.push(["neatlogs.llm.token_count.prompt", num(g.inputTokens)!]);
      if (num(g.outputTokens) !== undefined) attrs.push(["neatlogs.llm.token_count.completion", num(g.outputTokens)!]);
      if (num(g.totalTokens) !== undefined) attrs.push(["neatlogs.llm.token_count.total", num(g.totalTokens)!]);
      // Only a cost the provider itself reported; an unreported cost stays absent rather than becoming zero.
      if (g.costSource === "provider_reported" && num(g.costUsd) !== undefined) attrs.push(["neatlogs.llm.cost_usd", num(g.costUsd)!]);
      if (err) attrs.push(["neatlogs.error.message", err]);
      spans.push({ ...base, name: `${str(g.capability) ?? "ai"}.${str(g.phase) ?? "generate"}`, error: err, attributes: attrs });
    } else if (e.name === "agent_step") {
      const tool = `agent.${str(g.step) ?? "step"}`;
      const err = ["failed", "rejected", "invalid_plan"].includes(String(g.outcome)) ? str(g.code) ?? str(g.outcome) : undefined;
      spans.push({ ...base, name: tool, error: err, attributes: [
        ["neatlogs.span.kind", "TOOL"], ["neatlogs.tool.name", tool], ...common,
        ...Object.entries(g).map(([k, v]) => [`ticketstub.${k}`, v] as Attr),
        ...(err ? [["neatlogs.error.message", err] as Attr] : []),
      ] });
    } else if (e.name === "source_fetch" || e.name === "source_parse") {
      const tool = e.name === "source_fetch" ? `source.${str(g.source) ?? "unknown"}` : `parse.${str(g.parser) ?? "none"}`;
      // A source that simply had nothing (no_match, no_data, not_found) or was skipped is not a failure.
      const err = e.name === "source_fetch" && !["ok", "skipped", "pending", "no_match", "no_data", "not_found"].includes(String(g.outcome)) ? str(g.outcome) : undefined;
      spans.push({ ...base, name: tool, error: err, attributes: [
        ["neatlogs.span.kind", "TOOL"], ["neatlogs.tool.name", tool], ...common,
        ...Object.entries(g).map(([k, v]) => [`ticketstub.${k}`, v] as Attr),
      ] });
    }
  }
  // Completion marker, as the SDK emits, so the receiver can finalize the trace without waiting for a timeout.
  spans.push({ spanId: hex(8), parentSpanId: rootId, name: "neatlogs.trace.complete", startMs: rootEnd, endMs: rootEnd, scope: "internal",
    attributes: [["neatlogs.trace.complete", true], ["neatlogs.internal", true], ["neatlogs.span.kind", "Neatlogs.INTERNAL"], ...common] });
  return { traceId, spans };
}

// --- The sink ---

const stats: NeatlogsStats = { traces: 0, accepted: 0, rejectedSpans: 0, failed: 0, dropped: 0 };

// One line per kind of outcome per process, so the host log shows whether export works without flooding it.
// Lines carry only a status code or error class: never the key, a trace body or a response body.
const noted = new Set<string>();
export function noteOnce(kind: string, line: string, level: "info" | "warn" = "warn"): void {
  if (noted.has(kind)) return;
  noted.add(kind);
  (level === "info" ? console.info : console.warn)(`[ops] neatlogs: ${line}`);
}
export const resetNeatlogsNotes = (): void => noted.clear();
export const neatlogsStats = (): NeatlogsStats => ({ ...stats });
export function resetNeatlogsStats(): void { stats.traces = stats.accepted = stats.rejectedSpans = stats.failed = stats.dropped = 0; }

/** Reads rejected spans from an OTLP protobuf/JSON response; an empty body is full success per the OTLP spec. */
export function rejectedSpans(body: Uint8Array, contentType: string): number {
  if (body.length === 0) return 0;
  if (contentType.includes("json")) {
    try {
      const p = JSON.parse(Buffer.from(body).toString("utf8"));
      const partial = p?.partialSuccess ?? p?.partial_success;
      return Number(partial?.rejectedSpans ?? partial?.rejected_spans ?? 0) || 0;
    } catch { return -1; }
  }
  // ExportTraceServiceResponse { partial_success (1): { rejected_spans (1): int64 } }
  const fields = (buf: Uint8Array): Map<number, number | Uint8Array> | undefined => {
    const out = new Map<number, number | Uint8Array>();
    let i = 0;
    const varint = () => {
      let r = 0;
      for (let s = 0; i < buf.length && s < 56; s += 7) { const x = buf[i++]; r += (x & 0x7f) * 2 ** s; if (!(x & 0x80)) return r; }
      return -1;
    };
    while (i < buf.length) {
      const key = varint();
      if (key < 0) return undefined;
      if ((key & 7) === 0) out.set(key >> 3, varint());
      else if ((key & 7) === 2) { const len = varint(); if (len < 0 || i + len > buf.length) return undefined; out.set(key >> 3, buf.subarray(i, i + len)); i += len; }
      else return undefined;
    }
    return out;
  };
  const top = fields(body);
  if (top === undefined) return -1;
  const partial = top.get(1);
  if (partial === undefined) return 0;
  if (typeof partial === "number") return -1;
  const inner = fields(partial);
  const rejected = inner?.get(1);
  return inner === undefined ? -1 : typeof rejected === "number" ? rejected : 0;
}

export interface NeatlogsSinkOptions { config: NeatlogsConfig; fetchImpl?: typeof fetch; onSent?: (r: { traceId: string; status: number; rejectedSpans: number }) => void }

/** A sink that groups each operation's events and exports the operation as one trace when it closes. */
export function neatlogsSink({ config, fetchImpl, onSent }: NeatlogsSinkOptions) {
  const pending = new Map<string, { events: OpsEvent[]; first: number }>();
  let inFlight = 0;
  const prune = (now: number) => {
    for (const [id, p] of pending) if (now - p.first > PENDING_TTL_MS) { pending.delete(id); stats.dropped++; }
    while (pending.size > MAX_PENDING_OPERATIONS) { const oldest = pending.keys().next().value!; pending.delete(oldest); stats.dropped++; }
  };
  async function send(events: OpsEvent[]) {
    const built = buildTrace(events, config.tags);
    if (!built) return;
    const body = encodeTrace(built.traceId, built.spans, config.tags);
    if (body.length > MAX_BODY_BYTES || inFlight >= MAX_IN_FLIGHT) { stats.dropped++; return; }
    stats.traces++;
    inFlight++;
    try {
      const res = await (fetchImpl ?? fetch)(`${config.endpoint}/v1/traces`, {
        method: "POST", body: new Uint8Array(body), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/x-protobuf", "x-api-key": config.apiKey },
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!res.ok) {
        stats.failed++;
        noteOnce(`http_${res.status}`, `export failed: HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check NEATLOGS_INGEST_KEY is the project key for this region)" : ""}`);
        onSent?.({ traceId: built.traceId, status: res.status, rejectedSpans: -1 });
        return;
      }
      const rejected = rejectedSpans(bytes, res.headers.get("content-type") ?? "");
      if (rejected === 0) { stats.accepted++; noteOnce("accepted", `export accepted (HTTP ${res.status})`, "info"); }
      else if (rejected > 0) { stats.rejectedSpans += rejected; noteOnce("rejected_spans", `receiver rejected ${rejected} span(s)`); }
      else { stats.failed++; noteOnce("unreadable", "export response unreadable; acceptance unknown"); }
      onSent?.({ traceId: built.traceId, status: res.status, rejectedSpans: rejected });
    } catch (e) {
      stats.failed++;
      const kind = e instanceof Error ? e.name : "unknown";
      noteOnce(`error_${kind}`, `export failed: ${kind === "TimeoutError" ? "timed out" : `network error (${kind})`}`);
    } finally {
      inFlight--;
    }
  }
  return {
    name: "neatlogs",
    pendingOperations: () => pending.size,
    write(event: OpsEvent): void | Promise<void> {
      const now = Date.now();
      const p = pending.get(event.operationId) ?? { events: [], first: now };
      // The closing event is always kept, so a busy operation is truncated, never lost.
      if (event.name !== "api_request" && p.events.length >= MAX_EVENTS_PER_OPERATION) { stats.dropped++; return; }
      p.events.push(event);
      pending.set(event.operationId, p);
      prune(now);
      if (event.name !== "api_request") return;
      if (!pending.has(event.operationId)) return; // pruned as the oldest open operation
      pending.delete(event.operationId);
      return send(p.events);
    },
  };
}
