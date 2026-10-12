import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  MAX_PIXELS, OpenAIImagesProviderError, PRIVATE_PROVIDER_REQUEST_IDS, PRIVATE_RETRY_DISPOSITIONS,
  PRIVATE_TARGET_BINDING_SHA256, attachUsageObservation, checkRef, exactUsage, fail, freezeUsageObservation, hashJson,
  inspectConceptReferenceBytes, isRecord, runImageDispatch, prepareImageAttempt, snapshotUsageData, usageWithMissingField,
} from "./image-adapter-core.mjs";
import { IMAGE_PROVIDER_ROUTES } from "./image-routes.mjs";

// OpenRouter Images adapter. It sends one non-streaming POST to the documented
// Images endpoint and reuses the shared authority, credential, fence, byte-inspection
// and attribution machinery from image-adapter-core.mjs. Nothing here selects a model,
// proves entitlement, or reads the environment: the host supplies an explicit profile
// and a credential port. See docs/providers/openrouter-images.md for the sourced facts.

const ENDPOINT = IMAGE_PROVIDER_ROUTES.openrouter.generation_endpoint;
const RETRY_MAPPING_REF = "openrouter-images/retry-policy-v1";
const COST_PROVENANCE = "provider_reported_unsettled";
const MAX_REFERENCE_CEILING = 32;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const CONFIGURATION_KEYS = Object.freeze(["aspect_ratio", "quality", "background", "output_format", "resolution", "output_compression"]);
// Catalog descriptors list "auto" for aspect_ratio, so a host can pass them verbatim. "auto" is only accepted as a
// listed value: pinning it as the configuration is refused (see validateConfiguration) because the provider then
// chooses the dimensions and they would no longer be predictable.
const ENUM_VALUES = Object.freeze({
  aspect_ratio: /^(?:auto|[1-9]\d{0,2}:[1-9]\d{0,2})$/,
  quality: /^[a-z][a-z0-9_-]{0,31}$/,
  background: /^(?:auto|transparent|opaque)$/,
  output_format: /^(?:png|jpeg|webp)$/,
  resolution: /^(?:512|768|1K|1\.5K|2K|4K)$/,
});
// Catalog range descriptors that are not pinnable configuration keys. They are validated and bound into the profile
// hash, but a configuration may never set them (the request always sends n:1 and derives input_references itself).
const DESCRIPTOR_ONLY_RANGES = Object.freeze({ n: { min: 0, max: 32 }, input_references: { min: 0, max: MAX_REFERENCE_CEILING } });
const DESCRIPTOR_KEYS = Object.freeze([...CONFIGURATION_KEYS, ...Object.keys(DESCRIPTOR_ONLY_RANGES)]);
/** Maximum relative error between the decoded and the pinned aspect ratio. */
const ASPECT_RATIO_TOLERANCE = 0.03;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;
const COST_DETAIL_KEYS = Object.freeze(["upstream_inference_cost", "upstream_inference_prompt_cost", "upstream_inference_completions_cost"]);
const USAGE_DETAIL_FIELDS = Object.freeze({
  prompt_tokens_details: Object.freeze({ target: "input_tokens_details",
    keys: Object.freeze(["audio_tokens", "cache_write_tokens", "cached_tokens", "file_tokens", "video_tokens"]) }),
  completion_tokens_details: Object.freeze({ target: "output_tokens_details",
    keys: Object.freeze(["audio_tokens", "image_tokens", "reasoning_tokens"]) }),
});
// Disjoint groups of detail counters whose sum must not exceed the parent (see the sum check in the normalizer).
const SUMMED_DETAIL_GROUPS = Object.freeze({
  input_tokens_details: Object.freeze([Object.freeze(["cached_tokens", "cache_write_tokens"]),
    Object.freeze(["audio_tokens", "file_tokens", "video_tokens"])]),
  output_tokens_details: Object.freeze([Object.freeze(["audio_tokens", "image_tokens"])]),
});
const USAGE_ROOT_KEYS = Object.freeze(["prompt_tokens", "completion_tokens", "total_tokens", "cost", "cost_details", "is_byok",
  ...Object.keys(USAGE_DETAIL_FIELDS)]);
// Documented ImageGenerationUsage keys that are deliberately not mapped. Only these fixed names may appear in a
// finding; any other provider key is reported anonymously and its name is never echoed.
const DOCUMENTED_UNMAPPED_USAGE_KEYS = Object.freeze(["server_tool_use", "service_tier", "speed", "cache_creation", "iterations"]);

/** Fixed-vocabulary findings for root usage keys outside the allowlist. */
function unmappedRootFindings(keys) {
  const findings = new Set();
  for (const key of keys) {
    if (USAGE_ROOT_KEYS.includes(key)) continue;
    findings.add(DOCUMENTED_UNMAPPED_USAGE_KEYS.includes(key) ? `usage.unmapped.${key}` : "usage.unmapped_fields");
  }
  return [...findings];
}

export class OpenRouterImagesProviderError extends OpenAIImagesProviderError {
  constructor(code, message, options) {
    super(code, message, options);
    this.name = "OpenRouterImagesProviderError";
  }
}

export const OPENROUTER_IMAGES_ENDPOINT = ENDPOINT;
export const OPENROUTER_IMAGES_COST_PROVENANCE = COST_PROVENANCE;

/** Re-brand a shared-core error while preserving its public fields and private attribution. */
function asOpenRouterError(error) {
  if (!(error instanceof OpenAIImagesProviderError) || error instanceof OpenRouterImagesProviderError) return error;
  const converted = new OpenRouterImagesProviderError(error.code, error.message, {
    outcome: error.provider_outcome, http_status: error.http_status, retry: error.retry,
    provider_request_ref: error.provider_request_ref, field: error.field, embedded_code: error.embedded_code,
  });
  if (Object.hasOwn(error, "usage")) attachUsageObservation(converted, error.usage, PRIVATE_PROVIDER_REQUEST_IDS.get(error));
  const targetBinding = PRIVATE_TARGET_BINDING_SHA256.get(error);
  if (typeof targetBinding === "string") PRIVATE_TARGET_BINDING_SHA256.set(converted, targetBinding);
  const disposition = PRIVATE_RETRY_DISPOSITIONS.get(error);
  if (disposition) PRIVATE_RETRY_DISPOSITIONS.set(converted, disposition);
  return converted;
}

function guarded(callback) {
  try { return callback(); } catch (error) { throw asOpenRouterError(error); }
}

async function guardedAsync(callback) {
  try { return await callback(); } catch (error) { throw asOpenRouterError(error); }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const INSPECTION_ARGUMENT_KEYS = Object.freeze(["scope", "references", "maximum_single_reference_bytes",
  "maximum_aggregate_reference_bytes"]);
const MAX_INSPECTION_SNAPSHOT_DEPTH = 128;
const MAX_INSPECTION_SNAPSHOT_NODES = 65_536;
const MAX_INSPECTION_SNAPSHOT_VALUES = 65_536;
const MAX_INSPECTION_SNAPSHOT_PROPERTIES = 65_536;
const MAX_INSPECTION_SNAPSHOT_BYTES = 1024 * 1024;

function rejectInspectionInput(field) {
  fail("invalid_provider_input", "Concept reference inspection accepts bounded plain data without accessors, proxies, or serialization hooks.", {
    outcome: "failed", field,
  });
}

function accountInspectionValue(state, field) {
  state.values += 1;
  if (state.values > MAX_INSPECTION_SNAPSHOT_VALUES) rejectInspectionInput(field);
}

function accountInspectionProperties(state, count, field) {
  if (count > MAX_INSPECTION_SNAPSHOT_PROPERTIES - state.properties) rejectInspectionInput(field);
  state.properties += count;
}

function accountInspectionBytes(state, count, field) {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_INSPECTION_SNAPSHOT_BYTES - state.bytes) {
    rejectInspectionInput(field);
  }
  state.bytes += count;
}

function encodedJsonStringBytes(value, maximum) {
  let bytes = 2; // JSON string delimiters.
  if (bytes > maximum) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code <= 0x1f) bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

function accountInspectionString(state, value, field) {
  const bytes = encodedJsonStringBytes(value, MAX_INSPECTION_SNAPSHOT_BYTES - state.bytes);
  if (bytes === undefined) rejectInspectionInput(field);
  accountInspectionBytes(state, bytes, field);
}

function snapshotInspectionValue(value, field, state, depth = 0) {
  accountInspectionValue(state, field);
  if (value === null) {
    accountInspectionBytes(state, 4, field);
    return value;
  }
  if (typeof value === "boolean") {
    accountInspectionBytes(state, value ? 4 : 5, field);
    return value;
  }
  if (typeof value === "string") {
    accountInspectionString(state, value, field);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      accountInspectionBytes(state, 4, field);
      return null;
    }
    accountInspectionBytes(state, String(value === 0 ? 0 : value).length, field);
    return value;
  }
  if (value === undefined) return undefined;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") rejectInspectionInput(field);
  if (utilTypes.isProxy(value)) rejectInspectionInput(field);
  state.nodes += 1;
  if (state.nodes > MAX_INSPECTION_SNAPSHOT_NODES || depth > MAX_INSPECTION_SNAPSHOT_DEPTH || state.active.has(value)) {
    rejectInspectionInput(field);
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertyDescriptor(value, "toJSON")) rejectInspectionInput(field);
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length > MAX_INSPECTION_SNAPSHOT_NODES) rejectInspectionInput(field);
      // Every array slot is copied, including sparse holes. Check the minimum
      // expanded value count and exact JSON delimiters before allocating the copy.
      if (length > MAX_INSPECTION_SNAPSHOT_VALUES - state.values) rejectInspectionInput(field);
      const keys = Reflect.ownKeys(value);
      accountInspectionProperties(state, keys.length, field);
      for (const key of keys) {
        if (typeof key !== "string") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) rejectInspectionInput(field);
      }
      accountInspectionBytes(state, 2 + Math.max(0, length - 1), field);
      const copy = new Array(length);
      Object.setPrototypeOf(copy, null);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          copy[index] = snapshotInspectionValue(null, field, state, depth + 1);
          continue;
        }
        if (!Object.hasOwn(descriptor, "value")) rejectInspectionInput(field);
        const child = snapshotInspectionValue(descriptor.value, field, state, depth + 1);
        if (child === undefined) {
          accountInspectionBytes(state, 4, field);
          copy[index] = null;
        } else copy[index] = child;
      }
      return Object.freeze(copy);
    }
    if (!isRecord(value) || Object.getOwnPropertyDescriptor(value, "toJSON")) rejectInspectionInput(field);
    const keys = Reflect.ownKeys(value);
    accountInspectionProperties(state, keys.length, field);
    let enumerableCount = 0;
    let outputCount = 0;
    let structureBytes = 2; // JSON object delimiters.
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) rejectInspectionInput(field);
      if (!descriptor.enumerable) continue;
      enumerableCount += 1;
      if (descriptor.value === undefined) continue;
      const keyBytes = encodedJsonStringBytes(key, MAX_INSPECTION_SNAPSHOT_BYTES - state.bytes - structureBytes);
      if (keyBytes === undefined) rejectInspectionInput(field);
      structureBytes += keyBytes + 1 + (outputCount === 0 ? 0 : 1); // key, colon, and comma.
      if (structureBytes > MAX_INSPECTION_SNAPSHOT_BYTES - state.bytes) rejectInspectionInput(field);
      outputCount += 1;
    }
    if (enumerableCount > MAX_INSPECTION_SNAPSHOT_VALUES - state.values) rejectInspectionInput(field);
    accountInspectionBytes(state, structureBytes, field);
    const copy = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, "value")) rejectInspectionInput(field);
      if (!descriptor.enumerable) continue;
      const child = snapshotInspectionValue(descriptor.value, field, state, depth + 1);
      if (child !== undefined) copy[key] = child;
    }
    return Object.freeze(copy);
  } finally {
    state.active.delete(value);
  }
}

function snapshotConceptInspectionArguments(args) {
  if (utilTypes.isProxy(args) || !isRecord(args)) rejectInspectionInput("concept_reference_request");
  const state = { active: new WeakSet(), nodes: 0, values: 0, properties: 0, bytes: 0 };
  const copy = Object.create(null);
  for (const key of INSPECTION_ARGUMENT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    if (!descriptor) {
      copy[key] = undefined;
      continue;
    }
    if (!Object.hasOwn(descriptor, "value")) rejectInspectionInput(`concept_reference_request.${key}`);
    copy[key] = snapshotInspectionValue(descriptor.value, `concept_reference_request.${key}`, state);
  }
  return Object.freeze(copy);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateCapabilities(value) {
  const valid = isRecord(value) && onlyKeys(value, ["generation", "edit"]) && typeof value.generation === "boolean" &&
    (value.edit === false || (isRecord(value.edit) && onlyKeys(value.edit, ["max_input_references"]) &&
      Number.isSafeInteger(value.edit.max_input_references) && value.edit.max_input_references >= 1 &&
      value.edit.max_input_references <= MAX_REFERENCE_CEILING)) &&
    (value.generation || value.edit !== false);
  if (!valid) {
    fail("unsupported_model_profile", "The OpenRouter profile must explicitly declare generation and edit capabilities.", {
      outcome: "failed", field: "capabilities",
    });
  }
  return deepFreeze({ generation: value.generation,
    edit: value.edit === false ? false : { max_input_references: value.edit.max_input_references } });
}

function validateSupportedParameters(value) {
  if (value === undefined) return deepFreeze({});
  const reject = () => fail("unsupported_model_profile", "Supported parameter descriptors must be bounded enum or range descriptors.", {
    outcome: "failed", field: "supported_parameters",
  });
  if (!isRecord(value) || !onlyKeys(value, DESCRIPTOR_KEYS)) reject();
  const result = {};
  for (const [key, descriptor] of Object.entries(value)) {
    if (key === "output_compression" || Object.hasOwn(DESCRIPTOR_ONLY_RANGES, key)) {
      const bounds = key === "output_compression" ? { min: 0, max: 100 } : DESCRIPTOR_ONLY_RANGES[key];
      if (!isRecord(descriptor) || !onlyKeys(descriptor, ["type", "min", "max"]) || descriptor.type !== "range" ||
          !Number.isSafeInteger(descriptor.min) || !Number.isSafeInteger(descriptor.max) ||
          descriptor.min < bounds.min || descriptor.max > bounds.max || descriptor.min > descriptor.max) reject();
      result[key] = { type: "range", min: descriptor.min, max: descriptor.max };
      continue;
    }
    if (!isRecord(descriptor) || !onlyKeys(descriptor, ["type", "values"]) || descriptor.type !== "enum" ||
        !Array.isArray(descriptor.values) || descriptor.values.length < 1 || descriptor.values.length > 32 ||
        descriptor.values.some((item) => typeof item !== "string" || !ENUM_VALUES[key].test(item)) ||
        new Set(descriptor.values).size !== descriptor.values.length) reject();
    result[key] = { type: "enum", values: [...descriptor.values] };
  }
  return deepFreeze(result);
}

function rangeContains(range, value) {
  return range === undefined || (value >= range.min && value <= range.max);
}

function validateCatalogCountCompatibility(capabilities, supported) {
  if (supported.n && !rangeContains(supported.n, 1)) {
    fail("unsupported_model_profile", "The declared n range excludes the adapter's fixed single-image request.", {
      outcome: "failed", field: "supported_parameters",
    });
  }
  const references = supported.input_references;
  if (!references) return;
  if (capabilities.generation && !rangeContains(references, 0)) {
    fail("unsupported_model_profile", "The declared input-reference range excludes generation's zero-reference request.", {
      outcome: "failed", field: "supported_parameters",
    });
  }
  if (capabilities.edit !== false) {
    const maximum = capabilities.edit.max_input_references;
    if (maximum > references.max || maximum < references.min) {
      fail("unsupported_model_profile", "Edit capability and the declared input-reference range are incompatible.", {
        outcome: "failed", field: "supported_parameters",
      });
    }
  }
}

function assertReferenceCount(count, maximum, descriptor) {
  if (count > maximum || !rangeContains(descriptor, count)) {
    fail("unsupported_operation", "The actual OpenRouter request reference count is outside the explicit model profile.", {
      outcome: "failed", field: "input_references",
    });
  }
}

function assertFixedImageCount(supported) {
  if (!rangeContains(supported.n, 1)) {
    fail("unsupported_operation", "The actual OpenRouter request image count is outside the explicit model profile.", {
      outcome: "failed", field: "n",
    });
  }
}

function validateConfiguration(configuration, supported) {
  const reject = () => fail("unsupported_image_configuration",
    "Requested image configuration is outside the explicit OpenRouter model profile.", { outcome: "failed", field: "configuration" });
  if (!isRecord(configuration)) {
    fail("invalid_configuration", "Explicit image configuration is required.", { outcome: "failed", field: "configuration" });
  }
  if (!onlyKeys(configuration, CONFIGURATION_KEYS)) reject();
  const result = {};
  for (const key of CONFIGURATION_KEYS) {
    if (!Object.hasOwn(configuration, key)) continue;
    const descriptor = supported[key];
    const configured = configuration[key];
    if (!descriptor) reject();
    if (descriptor.type === "range") {
      if (!Number.isSafeInteger(configured) || configured < descriptor.min || configured > descriptor.max) reject();
    } else if (typeof configured !== "string" || !descriptor.values.includes(configured)) reject();
    result[key] = configured;
  }
  // A listed "auto" is catalog-only: the provider would choose the shape, so the pinned ratio must be explicit.
  if (result.aspect_ratio === "auto") reject();
  if (result.background === "transparent" && !["png", "webp"].includes(result.output_format)) reject();
  if (Object.hasOwn(result, "output_compression") && !["jpeg", "webp"].includes(result.output_format)) reject();
  return deepFreeze(result);
}

function dimensionsMatch(info, config) {
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 16 || info.height < 16 ||
      info.width * info.height > MAX_PIXELS) return false;
  const ratio = typeof config.aspect_ratio === "string" ? /^(\d+):(\d+)$/.exec(config.aspect_ratio) : null;
  if (!ratio) return true;
  const [a, b] = [Number(ratio[1]), Number(ratio[2])];
  // OpenRouter documents that providers clamp requested ratios and derive pixel sizes themselves, so the
  // pinned ratio is a bounded relative tolerance (3%), not an exact match. A clearly different shape is rejected.
  return Math.abs(info.width * b - info.height * a) <= ASPECT_RATIO_TOLERANCE * a * info.height;
}

function decimal(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) return undefined;
  const fixed = value.toFixed(9).replace(/\.?0+$/, "");
  // A positive reported amount that rounds to zero at nine decimals is unknown, never recorded as 0.
  if (value > 0 && Number(fixed) === 0) return undefined;
  return DECIMAL.test(fixed) ? { amount: fixed, exact: Number(fixed) === value } : undefined;
}

/**
 * Normalize allowlisted OpenRouter usage. Counters are raw provider observations and the result is
 * always `completeness: "unknown"`. A missing `usage` or missing `cost` is reported in `missing_fields`
 * and is never zero. `cost` is the provider-reported USD amount; it is not settlement.
 */
export function normalizeOpenRouterImageUsage(raw, identities = {}) {
  return guarded(() => {
    const identityData = snapshotUsageData(identities, "usage.identities", new Set(["transport_attempt_id"]),
      { rejectUnknown: true }) ?? Object.create(null);
    const result = { completeness: "unknown", missing_fields: ["usage.profile_mapping_pending"] };
    if (identityData.transport_attempt_id !== undefined) {
      result.transport_attempt_id = checkRef(identityData.transport_attempt_id, "transport_attempt_id");
    }
    const rawData = snapshotUsageData(raw, "usage", new Set(USAGE_ROOT_KEYS));
    if (!rawData) {
      result.missing_fields = Object.freeze(["usage", "usage.cost"]);
      return Object.freeze(result);
    }
    const missing = new Set(result.missing_fields);
    for (const [source, target] of [["prompt_tokens", "input_tokens"], ["completion_tokens", "output_tokens"], ["total_tokens", "total_tokens"]]) {
      const quantity = Object.hasOwn(rawData, source) ? exactUsage(rawData[source]) : undefined;
      if (quantity === undefined) missing.add(`usage.${target}`);
      else result[target] = Number(quantity);
    }
    const cost = Object.hasOwn(rawData, "cost") ? decimal(rawData.cost) : undefined;
    if (cost === undefined) missing.add("usage.cost");
    else {
      result.cost = Object.freeze({ amount: cost.amount, currency: "USD", provenance: COST_PROVENANCE });
      if (!cost.exact) missing.add("usage.cost.precision_truncated");
    }
    if (Object.hasOwn(rawData, "cost_details")) {
      const details = snapshotUsageData(rawData.cost_details, "usage.cost_details", new Set(COST_DETAIL_KEYS));
      if (!details) missing.add("usage.cost_details");
      else {
        const safeDetails = {};
        for (const key of COST_DETAIL_KEYS) {
          if (!Object.hasOwn(details, key)) continue;
          const amount = decimal(details[key]);
          if (amount === undefined) missing.add(`usage.cost_details.${key}`);
          else {
            safeDetails[key] = amount.amount;
            if (!amount.exact) missing.add(`usage.cost_details.${key}.precision_truncated`);
          }
        }
        if (Object.keys(details).some((key) => !COST_DETAIL_KEYS.includes(key))) missing.add("usage.cost_details.unmapped_fields");
        result.cost_details = Object.freeze(safeDetails);
      }
    }
    for (const [source, { target, keys }] of Object.entries(USAGE_DETAIL_FIELDS)) {
      if (!Object.hasOwn(rawData, source) || rawData[source] === null || rawData[source] === undefined) continue;
      const details = snapshotUsageData(rawData[source], `usage.${source}`, new Set(keys));
      if (!details) { missing.add(`usage.${source}`); continue; }
      const safeDetails = {};
      for (const key of keys) {
        if (!Object.hasOwn(details, key)) continue;
        const quantity = exactUsage(details[key]);
        if (quantity === undefined) missing.add(`usage.${source}.${key}`);
        else safeDetails[key] = Number(quantity);
      }
      if (Object.keys(details).some((key) => !keys.includes(key))) missing.add(`usage.${source}.unmapped_fields`);
      result[target] = Object.freeze(safeDetails);
      // Details are documented subsets of their parent. Real counters are never clamped or dropped; a contradiction
      // or a missing parent is only reported, as a fixed finding that carries no provider value.
      const parent = result[target === "input_tokens_details" ? "input_tokens" : "output_tokens"];
      const counters = Object.values(safeDetails);
      if (counters.length > 0 && parent === undefined) missing.add(`usage.${target}.parent_missing`);
      else if (parent !== undefined && counters.some((counter) => counter > parent)) missing.add(`usage.${target}.exceeds_parent`);
      // Sum check, mirroring src/telemetry/usage.mjs (its OPENAI_RESPONSES profile sums cached_tokens and
      // cache_write_tokens against input_tokens). Only counters that are disjoint parts of the parent are summed:
      // cache read and cache write are mutually exclusive; modality counters partition the tokens by media type.
      // Cache and modality counters can describe the same tokens (cached audio), and reasoning_tokens is a
      // purpose split that can overlap any modality, so those are never added together (no false positives).
      // The sum is only reported (fixed finding, no values); counters are never clamped.
      if (parent !== undefined && SUMMED_DETAIL_GROUPS[target].some((group) =>
        group.reduce((sum, key) => sum + (safeDetails[key] ?? 0), 0) > parent)) missing.add(`usage.${target}.sum_exceeds_parent`);
    }
    if (Object.hasOwn(rawData, "is_byok")) {
      if (typeof rawData.is_byok === "boolean") result.is_byok = rawData.is_byok;
      else missing.add("usage.is_byok");
    }
    for (const finding of unmappedRootFindings(Object.keys(rawData))) missing.add(finding);
    result.missing_fields = Object.freeze([...missing]);
    return freezeUsageObservation(result);
  });
}

function usageFromPayload(payload, transportAttemptId, _rawProviderRequestId, targetBindingSha256) {
  const attach = (usage) => {
    if (typeof targetBindingSha256 === "string") PRIVATE_TARGET_BINDING_SHA256.set(usage, targetBindingSha256);
    return usage;
  };
  if (!isRecord(payload) || !Object.hasOwn(payload, "usage")) {
    return Object.freeze({ usage: attach(normalizeOpenRouterImageUsage(undefined, { transport_attempt_id: transportAttemptId })),
      present: false, unsupported_shape: false });
  }
  // The parsed object comes from bounded JSON.parse. Project only allowlisted fields so an oversized
  // provider extension cannot be retained, and flag it instead of failing the normalizer.
  const rawUsage = payload.usage;
  const findings = [];
  let projected = rawUsage;
  if (isRecord(rawUsage)) {
    let count = 0;
    const rootKeys = [];
    for (const key in rawUsage) {
      if (!Object.hasOwn(rawUsage, key)) continue;
      count += 1;
      rootKeys.push(key);
      if (count > 32) { findings.push("usage.too_many_fields"); break; }
    }
    findings.push(...unmappedRootFindings(rootKeys));
    projected = Object.create(null);
    for (const key of USAGE_ROOT_KEYS) if (Object.hasOwn(rawUsage, key)) projected[key] = rawUsage[key];
    if (isRecord(projected.cost_details)) {
      const rawDetails = projected.cost_details;
      let detailCount = 0;
      let detailUnmapped = false;
      for (const key in rawDetails) {
        if (!Object.hasOwn(rawDetails, key)) continue;
        detailCount += 1;
        if (!COST_DETAIL_KEYS.includes(key)) detailUnmapped = true;
        if (detailCount > 32) {
          findings.push("usage.cost_details.too_many_fields");
          break;
        }
      }
      if (detailUnmapped) findings.push("usage.cost_details.unmapped_fields");
      const boundedDetails = Object.create(null);
      // Read only the three documented amount fields. This preserves valid
      // billing observations even if the provider adds an over-wide extension.
      for (const key of COST_DETAIL_KEYS) {
        if (Object.hasOwn(rawDetails, key)) boundedDetails[key] = rawDetails[key];
      }
      projected.cost_details = boundedDetails;
    }
    for (const [source, { keys }] of Object.entries(USAGE_DETAIL_FIELDS)) {
      if (!isRecord(projected[source])) continue;
      const rawDetails = projected[source];
      let detailCount = 0;
      let detailUnmapped = false;
      for (const key in rawDetails) {
        if (!Object.hasOwn(rawDetails, key)) continue;
        detailCount += 1;
        if (!keys.includes(key)) detailUnmapped = true;
        if (detailCount > 32) {
          findings.push(`usage.${source}.too_many_fields`);
          break;
        }
      }
      if (detailUnmapped) findings.push(`usage.${source}.unmapped_fields`);
      const boundedDetails = Object.create(null);
      for (const key of keys) if (Object.hasOwn(rawDetails, key)) boundedDetails[key] = rawDetails[key];
      projected[source] = boundedDetails;
    }
  }
  let usage = attach(normalizeOpenRouterImageUsage(projected, { transport_attempt_id: transportAttemptId }));
  for (const finding of findings) usage = attach(usageWithMissingField(usage, finding, undefined, targetBindingSha256));
  return Object.freeze({ usage, present: true, unsupported_shape: findings.some((finding) =>
    finding === "usage.too_many_fields" || /^usage\.[a-z_]+\.too_many_fields$/.test(finding)) });
}

function classifyError(payload, status) {
  const error = isRecord(payload?.error) ? payload.error : {};
  const metadata = isRecord(error.metadata) ? error.metadata : {};
  const hard = { outcome: "failed", retry_disposition: "hard_stop" };
  switch (status) {
    case 401: return { code: "authentication_denied", ...hard };
    case 402: return { code: "provider_quota_exhausted", ...hard };
    case 403: {
      // The moderation metadata echoes user text; it is only inspected for its shape and never retained.
      const moderated = Object.hasOwn(metadata, "flagged_input") || Object.hasOwn(metadata, "reasons") ||
        (typeof error.message === "string" && /moderat|content[ _-]?polic|flagged/i.test(error.message));
      return { code: moderated ? "moderation_blocked" : "operation_permission_denied", ...hard };
    }
    case 404: return { code: "model_capability_unavailable", ...hard };
    case 400: case 413: return { code: "provider_request_failed", ...hard };
    case 408: case 524: return { code: "provider_outcome_unknown", outcome: "unknown" };
    case 429: return { code: "provider_rate_limited", outcome: "failed" };
    // Only 502 is documented as a failed, non-billed generation. 429 (rate limited) and 503 (no provider meets
    // routing) are refusals before any generation. 500 and 529 do not document that, so the hold is retained.
    case 502: case 503: return { code: "provider_request_failed", outcome: "failed" };
    case 500: case 529: return { code: "provider_request_failed", outcome: "unknown" };
    default:
      if (Number.isInteger(status) && status >= 400 && status < 500) return { code: "provider_request_failed", ...hard };
      return { code: "provider_request_failed", outcome: "unknown" };
  }
}

function embeddedErrorStatus(payload, status) {
  const code = payload?.error?.code;
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : status;
}

function dataUrl(bytes, mediaType) {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * OpenRouter Images provider. Construction performs no I/O and reads no environment variable. The host supplies
 * an explicit model profile (no built-in default model), trusted ports, and the credential port that injects the
 * creative-engine OpenRouter key. Each invocation makes at most one POST and has no implicit retry or fallback.
 */
export function createOpenRouterImagesProvider({ model_id, provider_tag, capabilities, supported_parameters,
  configuration, capabilityPort, authorizationPort, credentialPort, promptPort, assetPort,
  fetchImpl = globalThis.fetch, now = () => Date.now(), idFactory = randomUUID, retryPolicy = {} }) {
  return guarded(() => {
    if (typeof model_id !== "string" || !MODEL_ID.test(model_id)) {
      fail("unsupported_model_profile", "An explicit OpenRouter model id (author/slug) is required.", { outcome: "failed", field: "model" });
    }
    if (typeof provider_tag !== "string" || !PROVIDER_TAG.test(provider_tag)) {
      fail("unsupported_model_profile", "An explicit pinned OpenRouter provider tag is required.", { outcome: "failed", field: "provider_tag" });
    }
    const profileCapabilities = validateCapabilities(capabilities);
    const supported = validateSupportedParameters(supported_parameters);
    validateCatalogCountCompatibility(profileCapabilities, supported);
    const pinnedConfiguration = validateConfiguration(configuration, supported);
    if (!capabilityPort || typeof capabilityPort.verify !== "function" || typeof capabilityPort.revalidate !== "function" ||
        !authorizationPort || typeof authorizationPort.revalidate !== "function" ||
        !credentialPort || typeof credentialPort.resolveCredential !== "function" ||
        typeof fetchImpl !== "function") {
      fail("provider_ports_unavailable", "Trusted model, access, credential, and native-fetch ports are required.", { outcome: "failed" });
    }
    const nodeVersion = process.versions.node;
    const maxReferences = profileCapabilities.edit === false ? 0 : profileCapabilities.edit.max_input_references;
    const routing = deepFreeze({ only: [provider_tag], allow_fallbacks: false });

    const requireOperation = (operation) => {
      if (operation !== "generate" && operation !== "edit") {
        fail("unsupported_operation", "Only OpenRouter image generation and reference-guided edit are supported.", { outcome: "failed" });
      }
      if (operation === "generate" ? !profileCapabilities.generation : profileCapabilities.edit === false) {
        fail("operation_permission_denied", `The explicit OpenRouter profile does not declare ${operation} capability.`, {
          outcome: "failed", field: `capabilities.${operation}`,
        });
      }
    };

    const driver = Object.freeze({
      service: "openrouter", model_id, nodeVersion, now, idFactory, retryPolicy, fetchImpl,
      capabilityPort, authorizationPort, credentialPort, promptPort, assetPort, allowMask: false,
      endpointFor: () => ENDPOINT,
      preflight(input, operation, conceptMode) {
        requireOperation(operation);
        assertFixedImageCount(supported);
        if (operation === "generate") {
          assertReferenceCount(0, 0, supported.input_references);
          return;
        }
        if (input.plan.steps.some((step) => isRecord(step?.parameters) && step.parameters.mask_source_ref !== undefined)) {
          fail("unsupported_operation", "OpenRouter has no documented mask or inpainting parameter.", {
            outcome: "failed", field: "plan.steps.parameters.mask_source_ref",
          });
        }
        const referenceCount = conceptMode ? input.concept_reference_manifest.references.length
          : 1 + (input.image_reference_manifest?.references.length ?? 0);
        assertReferenceCount(referenceCount, maxReferences, supported.input_references);
      },
      validateConfiguration: () => pinnedConfiguration,
      bindingExtras: (operation, attempt) => ({
        provider_tag,
        provider_routing: routing,
        metered_operation_kind: attempt.operation_kind,
        ...(operation === "edit" ? { edit_semantics: "reference_guided", max_input_references: maxReferences } : {}),
      }),
      configurationSha256: (config) => hashJson({ model_id, provider_tag, capabilities: profileCapabilities,
        supported_parameters: supported, config }),
      bindingOperationKind: (operation, attempt) => operation === "edit"
        ? IMAGE_PROVIDER_ROUTES.openrouter.edit_binding_operation_kind : attempt.operation_kind,
      buildRequest({ operation, input, config, prompt, editAssets, credential }) {
        const body = { model: model_id, prompt, n: 1, stream: false, provider: { only: [provider_tag], allow_fallbacks: false } };
        for (const key of CONFIGURATION_KEYS) if (Object.hasOwn(config, key)) body[key] = config[key];
        if (operation === "edit") {
          const references = [];
          if (editAssets.parent) {
            references.push({ type: "image_url", image_url: { url: dataUrl(editAssets.parent.bytes, input.base_design.artifact.media_type) } });
          }
          for (const reference of editAssets.references) {
            references.push({ type: "image_url", image_url: { url: dataUrl(reference.bytes, reference.manifest.media_type) } });
          }
          body.input_references = references;
        }
        return { body: JSON.stringify(body), headers: Object.freeze({
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
        }) };
      },
      classifyError,
      embeddedErrorStatus,
      wantsRetryAdvisory: (status) => status === 429 || status === 503,
      usageFromPayload,
      // The Images response documents no generation or request id; none is read or fabricated.
      requestIdFromResponse: () => undefined,
      outputMatches(imageInfo, item, config) {
        if (!dimensionsMatch(imageInfo, config)) return false;
        if (config.output_format !== undefined && imageInfo.format !== config.output_format) return false;
        if (item.media_type !== undefined && item.media_type !== `image/${imageInfo.format}`) return false;
        return !(config.background === "transparent" && !imageInfo.has_alpha);
      },
    });

    function resolveRoute({ operation }) {
      return guarded(() => {
        requireOperation(operation);
        return Object.freeze({ retry_mapping_ref: RETRY_MAPPING_REF, provider: Object.freeze({
          name: "openrouter", model: model_id, endpoint: ENDPOINT,
          sdk: Object.freeze({ name: "native-fetch", version: nodeVersion }),
        }) });
      });
    }

    return Object.freeze({
      resolveRoute,
      prepareAttempt(input) { return guardedAsync(() => prepareImageAttempt(driver, undefined, input)); },
      getConceptConfiguration() {
        return guarded(() => {
          requireOperation("edit");
          return Object.freeze({ model_id, provider_tag, capabilities: profileCapabilities, configuration: pinnedConfiguration });
        });
      },
      inspectConceptReferences(args) {
        return guardedAsync(async () => {
          requireOperation("edit");
          const inspectionArgs = snapshotConceptInspectionArguments(args);
          return inspectConceptReferenceBytes(assetPort, inspectionArgs,
            (referenceCount) => assertReferenceCount(referenceCount, maxReferences, supported.input_references));
        });
      },
      generate(input) { return guardedAsync(() => runImageDispatch(driver, "generate", input)); },
      edit(input) { return guardedAsync(() => runImageDispatch(driver, "edit", input)); },
    });
  });
}
