// Server transport only. Import from route handlers, never from client components.
export type Capability = "research" | "agent" | "art";
type Provider = "openrouter" | "openai" | "anthropic";
export interface ProviderMetadata {
  provider: Provider;
  requestedModel: string;
  returnedModel?: string;
  upstreamProvider?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
}
export interface ProviderResult { value: string; metadata: ProviderMetadata }
export class ProviderError extends Error {
  readonly code: string;
  readonly status: number;
  /** Server-side diagnostics only; never part of a response. */
  readonly upstreamStatus?: number;
  readonly reason?: "timeout" | "aborted";
  constructor(code: string, status = 502, detail: { upstreamStatus?: number; reason?: "timeout" | "aborted" } = {}) {
    super("The selected AI service could not complete this request.");
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.upstreamStatus = detail.upstreamStatus;
    this.reason = detail.reason;
  }
}

/** One upstream call as measured by the transport. Carries codes and numbers only: no prompt, key, URL or body. */
export interface ProviderAttempt {
  capability: Capability;
  provider: Provider;
  model: string;
  phase: "model_check" | "generate";
  ok: boolean;
  durationMs: number;
  code?: string;
  upstreamStatus?: number;
  reason?: "timeout" | "aborted";
  metadata?: ProviderMetadata;
}
/** Called after every upstream attempt. Its failures are ignored, so measurement can never change a result. */
export type ProviderObserver = (attempt: ProviderAttempt) => void;

type Config = { capability: Capability; provider: Provider; model: string; key: string };
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const identifier = (value: unknown): string | undefined => typeof value === "string" && !/(?:sk-|bearer|secret|token|api[_-]?key)/i.test(value) && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,159}$/.test(value) ? value : undefined;

function config(capability: Capability): Config | undefined {
  if (typeof window !== "undefined") throw new ProviderError("server_only", 500);
  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") return undefined;
  const prefix = `TICKETSTUB_${capability.toUpperCase()}`;
  const provider = process.env[`${prefix}_PROVIDER`] ?? (capability === "art" ? "openai" : "anthropic");
  if (provider !== "openrouter" && provider !== (capability === "art" ? "openai" : "anthropic")) {
    throw new ProviderError("invalid_provider_configuration", 503);
  }
  const key = process.env[provider === "openrouter" ? `${prefix}_OPENROUTER_API_KEY` : provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]?.trim();
  if (!key) {
    if (provider === "openrouter") throw new ProviderError("missing_provider_key", 503);
    return undefined; // Retain the optional direct-provider prototype behavior.
  }
  const model = provider === "openrouter" ? process.env[`${prefix}_MODEL`] : capability === "art" ? "gpt-image-1" : "claude-sonnet-5-5";
  if (typeof model !== "string" || !identifier(model) || (provider === "openrouter" && !/^(openai|anthropic)\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(model))) {
    throw new ProviderError("invalid_model_configuration", 503);
  }
  if (capability === "art" && provider === "openrouter" && !model.startsWith("openai/")) {
    throw new ProviderError("unsupported_image_model", 422);
  }
  return { capability, provider, model, key };
}

function metadata(c: Config, data: Json): ProviderMetadata {
  const usage = object(data.usage);
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const cost = typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
  return {
    provider: c.provider, requestedModel: c.model,
    returnedModel: identifier(data.model), upstreamProvider: identifier(data.provider),
    usage: {
      inputTokens: count(usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
      totalTokens: count(usage.total_tokens), costUsd: cost,
    },
  };
}

async function request(url: string, c: Config, signal: AbortSignal, body?: Json): Promise<Json> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (c.provider === "anthropic") {
      headers["x-api-key"] = c.key;
      headers["anthropic-version"] = "2023-06-01";
    } else headers.authorization = `Bearer ${c.key}`;
    if (c.provider === "openrouter") headers["X-OpenRouter-Title"] = "TicketStub";
    const response = await fetch(url, {
      method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
      signal, redirect: "error", cache: "no-store",
    });
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "provider_authentication_failed"
        : response.status === 429 ? "provider_rate_limited"
        : response.status === 400 || response.status === 404 || response.status === 422 ? "unsupported_provider_request"
        : "provider_unavailable";
      throw new ProviderError(code, response.status === 429 ? 429 : 502, { upstreamStatus: response.status });
    }
    const data = object(await response.json());
    if (data.error) throw new ProviderError("provider_unavailable", 502, { upstreamStatus: response.status });
    return data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const reason = !signal.aborted ? undefined : (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError" ? "timeout" : "aborted";
    throw new ProviderError(signal.aborted ? "provider_request_cancelled" : "provider_unavailable", signal.aborted ? 504 : 502, { reason });
  }
}

/** Runs one upstream attempt and reports how it ended to the observer, if any. */
async function attempt<T>(c: Config, phase: ProviderAttempt["phase"], observe: ProviderObserver | undefined, run: () => Promise<T>, metadataOf?: (value: T) => ProviderMetadata): Promise<T> {
  const started = performance.now();
  const report = (outcome: Pick<ProviderAttempt, "ok" | "code" | "upstreamStatus" | "reason" | "metadata">) => {
    if (!observe) return;
    try {
      observe({ capability: c.capability, provider: c.provider, model: c.model, phase, durationMs: performance.now() - started, ...outcome });
    } catch {
      /* measurement never changes a result */
    }
  };
  try {
    const value = await run();
    report({ ok: true, metadata: metadataOf?.(value) });
    return value;
  } catch (error) {
    const e = error instanceof ProviderError ? error : undefined;
    report({ ok: false, code: e?.code ?? "provider_unavailable", upstreamStatus: e?.upstreamStatus, reason: e?.reason });
    throw error;
  }
}

function signalWithTimeout(signal: AbortSignal | undefined, timeout: number) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

export async function generateText(input: {
  capability: "research" | "agent"; prompt: string; system?: string; maxTokens: number; signal?: AbortSignal; observe?: ProviderObserver;
}): Promise<ProviderResult | undefined> {
  const c = config(input.capability);
  if (!c) return undefined;
  const messages = [{ role: "user", content: input.prompt }];
  const body: Json = c.provider === "openrouter" ? {
    model: c.model, max_tokens: input.maxTokens, stream: false,
    messages: input.system ? [{ role: "system", content: input.system }, ...messages] : messages,
    provider: { allow_fallbacks: false, require_parameters: true },
  } : { model: c.model, max_tokens: input.maxTokens, ...(input.system ? { system: input.system } : {}), messages };
  return attempt(c, "generate", input.observe, async () => {
    const data = await request(c.provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.anthropic.com/v1/messages", c, signalWithTimeout(input.signal, 15_000), body);
    let text: unknown;
    if (c.provider === "openrouter") {
      const choice = object(Array.isArray(data.choices) ? data.choices[0] : undefined);
      const message = object(choice.message);
      // These application routes need final text, not unexecuted client tool calls.
      if (choice.finish_reason !== "stop" || message.tool_calls) throw new ProviderError("unsupported_provider_response");
      text = message.content;
    } else text = Array.isArray(data.content) ? object(data.content.find((v: unknown) => object(v).type === "text")).text : undefined;
    if (typeof text !== "string" || !text.trim() || text.length > 32_000) throw new ProviderError("invalid_provider_response");
    return { value: text.trim(), metadata: metadata(c, data) };
  }, (result) => result.metadata);
}

export async function generateImage(prompt: string, signal?: AbortSignal, observe?: ProviderObserver): Promise<ProviderResult | undefined> {
  const c = config("art");
  if (!c) return undefined;
  const boundedSignal = signalWithTimeout(signal, 90_000);
  if (c.provider === "openrouter") {
    await attempt(c, "model_check", observe, async () => {
      const models = await request("https://openrouter.ai/api/v1/images/models", c, boundedSignal);
      const supported = Array.isArray(models.data) && models.data.some((entry: unknown) => {
        const model = object(entry);
        const architecture = object(model.architecture);
        return model.id === c.model && Array.isArray(architecture.output_modalities) && architecture.output_modalities.includes("image");
      });
      if (!supported) throw new ProviderError("unsupported_image_model", 422);
    });
  }
  const body: Json = c.provider === "openrouter" ? {
    model: c.model, prompt, n: 1, provider: { allow_fallbacks: false },
  } : { model: c.model, prompt, size: "1024x1536", n: 1, quality: "medium", output_format: "jpeg", output_compression: 82 };
  return attempt(c, "generate", observe, async () => {
    const data = await request(c.provider === "openrouter" ? "https://openrouter.ai/api/v1/images" : "https://api.openai.com/v1/images/generations", c, boundedSignal, body);
    const image = object(Array.isArray(data.data) ? data.data[0] : undefined);
    const mediaType = c.provider === "openrouter" ? image.media_type : "image/jpeg";
    const b64 = image.b64_json;
    if (!["image/png", "image/jpeg", "image/webp"].includes(String(mediaType)) || typeof b64 !== "string" || !b64.length || b64.length > 20_000_000 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      throw new ProviderError("invalid_image_response");
    }
    const bytes = Buffer.from(b64.slice(0, 24), "base64");
    const valid = mediaType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mediaType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new ProviderError("invalid_image_response");
    return { value: `data:${mediaType};base64,${b64}`, metadata: metadata(c, data) };
  }, (result) => result.metadata);
}

// Only fixed errors are public; upstream bodies, headers, and exception text are discarded.
export function providerFailure(error: unknown): { status: number; body: { error: string; code: string } } | undefined {
  if (!(error instanceof ProviderError)) return undefined;
  return { status: error.status, body: { error: error.message, code: error.code } };
}
