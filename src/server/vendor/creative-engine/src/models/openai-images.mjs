import { randomUUID } from "node:crypto";
import {
  HASH, MAX_PIXELS, OPAQUE_REF, OpenAIImagesProviderError, PRIVATE_PROVIDER_REQUEST_IDS, PRIVATE_TARGET_BINDING_SHA256,
  checkRef, evaluateOpenAIImageRetry, exactUsage, fail, freezeUsageObservation, hashJson, inspectConceptReferenceBytes,
  inspectOpenAIImageBytes, isRecord, readPrivateOpenAIImageRequestId, readPrivateOpenAIImageRetryDisposition,
  readPrivateOpenAIImageTargetBindingSha256, responseHeader, runImageDispatch, prepareImageAttempt, safeProviderRequestRef,
  snapshotJson, snapshotUsageData, usageWithMissingField,
} from "./image-adapter-core.mjs";
import { IMAGE_PROVIDER_ROUTES } from "./image-routes.mjs";

// The shared validation, decoding, fence, and dispatch logic lives in image-adapter-core.mjs
// and is reused by the OpenRouter adapter. This module keeps only the direct OpenAI Images
// wire contract, candidate profiles, configuration, usage shape, and error mapping.
export {
  OpenAIImagesProviderError, evaluateOpenAIImageRetry, inspectOpenAIImageBytes,
  readPrivateOpenAIImageRequestId, readPrivateOpenAIImageRetryDisposition, readPrivateOpenAIImageTargetBindingSha256,
};

const GENERATION_ENDPOINT = IMAGE_PROVIDER_ROUTES.openai.generation_endpoint;
const EDIT_ENDPOINT = IMAGE_PROVIDER_ROUTES.openai.edit_endpoint;
const RETRY_MAPPING_REF = "openai-images-direct/retry-policy-v1";

/** The documented candidate pin is explicit and never auto-selected. Owner capability evidence is still required. */
export const OPENAI_IMAGE_CANDIDATE_PROFILES = Object.freeze({
  "gpt-image-2.5-sunburst-2026-09-08": Object.freeze({
    model_id: "gpt-image-2.5-sunburst-2026-09-08",
    docs_checked_at: "2026-10-10",
    documentation_status: "candidate_unselected",
    qualities: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    formats: Object.freeze(["png", "jpeg", "webp"]),
    transparent_formats: Object.freeze(["png", "webp"]),
    moderation: Object.freeze(["auto", "low"]),
    size_policy: "multiples_of_16_up_to_3840x2160_ratio_1_to_3",
    response_encoding: "base64",
    supports_input_fidelity: false,
    supports_streaming: false,
  }),
  "gpt-image-2.5-flare-2026-09-08": Object.freeze({
    model_id: "gpt-image-2.5-flare-2026-09-08",
    docs_checked_at: "2026-10-10",
    documentation_status: "candidate_unselected",
    qualities: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    formats: Object.freeze(["png", "jpeg", "webp"]),
    transparent_formats: Object.freeze(["png", "webp"]),
    moderation: Object.freeze(["auto", "low"]),
    size_policy: "multiples_of_16_up_to_3840x2160_ratio_1_to_3",
    response_encoding: "base64",
    supports_input_fidelity: false,
    supports_streaming: false,
  }),
});

function checkTargetProfile(modelId) {
  const profile = typeof modelId === "string" && Object.hasOwn(OPENAI_IMAGE_CANDIDATE_PROFILES, modelId)
    ? OPENAI_IMAGE_CANDIDATE_PROFILES[modelId] : undefined;
  if (!profile) fail("unsupported_model_profile", "No explicit documented image model profile is configured.", { outcome: "failed", field: "model" });
  return profile;
}

function imageSize(value, profile) {
  if (value === "auto") return null;
  if (typeof value !== "string" || !/^(?:[1-9]\d{0,3})x(?:[1-9]\d{0,3})$/.test(value)) {
    fail("unsupported_image_configuration", "Image size must use a documented width x height value or auto.", { outcome: "failed", field: "size" });
  }
  const [width, height] = value.split("x").map(Number);
  const maxW = width >= height ? 3840 : 2160;
  const maxH = width >= height ? 2160 : 3840;
  if (width < 16 || height < 16 || width > maxW || height > maxH || width * height > MAX_PIXELS ||
      width / height < 1 / 3 || width / height > 3 || width % 16 !== 0 || height % 16 !== 0 ||
      profile.size_policy !== "multiples_of_16_up_to_3840x2160_ratio_1_to_3") {
    fail("unsupported_image_configuration", "Image dimensions exceed the pinned documented capability profile.", { outcome: "failed", field: "size" });
  }
  return { width, height };
}

function profileDimensionsMatch(info, profile) {
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 16 || info.height < 16) return false;
  const maxWidth = info.width >= info.height ? 3840 : 2160;
  const maxHeight = info.width >= info.height ? 2160 : 3840;
  return profile.size_policy === "multiples_of_16_up_to_3840x2160_ratio_1_to_3" &&
    info.width <= maxWidth && info.height <= maxHeight && info.width * info.height <= MAX_PIXELS &&
    info.width % 16 === 0 && info.height % 16 === 0 && info.width / info.height >= 1 / 3 && info.width / info.height <= 3;
}

function validateConfiguration(configuration, profile, operation) {
  if (!isRecord(configuration)) fail("invalid_configuration", "Explicit image configuration is required.", { outcome: "failed", field: "configuration" });
  const allowed = new Set(["quality", "size", "output_format", "background", "moderation"]);
  if (Object.keys(configuration).some((key) => !allowed.has(key))) {
    fail("unsupported_image_configuration", "Image configuration contains an unsupported option.", { outcome: "failed", field: "configuration" });
  }
  const { quality, size, output_format, background, moderation } = configuration;
  const dimensions = imageSize(size, profile);
  if (!profile.qualities.includes(quality) || !profile.formats.includes(output_format) ||
      !["opaque", "transparent"].includes(background) || !profile.moderation.includes(moderation) ||
      (background === "transparent" && !profile.transparent_formats.includes(output_format))) {
    fail("unsupported_image_configuration", "Requested quality, format, background, or moderation is outside the explicit model profile.", { outcome: "failed", field: "configuration" });
  }
  if (operation !== "generate" && operation !== "edit") {
    fail("unsupported_operation", "Only direct Images generation and edit operations are supported.", { outcome: "failed", field: "operation" });
  }
  return Object.freeze({ quality, size, output_format, background, moderation, dimensions });
}

/** Preserve allowlisted provider counters; only a reviewed owner profile may map them for settlement. */
export function normalizeOpenAIImageUsage(raw, identities = {}) {
  const identityData = snapshotUsageData(identities, "usage.identities", new Set(["transport_attempt_id", "provider_request_id"]), { rejectUnknown: true }) ?? Object.create(null);
  const transport_attempt_id = identityData.transport_attempt_id;
  const provider_request_id = identityData.provider_request_id;
  const result = { completeness: "unknown", missing_fields: ["usage.profile_mapping_pending"] };
  if (transport_attempt_id !== undefined) result.transport_attempt_id = checkRef(transport_attempt_id, "transport_attempt_id");
  const safeRequestRef = safeProviderRequestRef(provider_request_id);
  if (safeRequestRef) result.provider_request_id = safeRequestRef;
  if (typeof provider_request_id === "string") PRIVATE_PROVIDER_REQUEST_IDS.set(result, provider_request_id);
  const rawData = snapshotUsageData(raw, "usage", new Set([
    "input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details",
  ]));
  if (!rawData) {
    result.missing_fields = Object.freeze(["usage"]);
    return freezeUsageObservation(result);
  }

  const missing = new Set(result.missing_fields);
  for (const name of ["input_tokens", "output_tokens", "total_tokens"]) {
    if (!Object.hasOwn(rawData, name)) { missing.add(`usage.${name}`); continue; }
    const quantity = exactUsage(rawData[name]);
    if (quantity === undefined) missing.add(`usage.${name}`);
    else result[name] = Number(quantity);
  }
  for (const parent of ["input_tokens", "output_tokens"]) {
    const detailsKey = `${parent}_details`;
    if (!Object.hasOwn(rawData, detailsKey)) { missing.add(`usage.${detailsKey}`); continue; }
    const details = snapshotUsageData(rawData[detailsKey], `usage.${detailsKey}`, new Set(["text_tokens", "image_tokens"]));
    if (!details) { missing.add(`usage.${detailsKey}`); continue; }
    const safeDetails = {};
    for (const part of ["text_tokens", "image_tokens"]) {
      if (!Object.hasOwn(details, part)) { missing.add(`usage.${detailsKey}.${part}`); continue; }
      const quantity = exactUsage(details[part]);
      if (quantity === undefined) missing.add(`usage.${detailsKey}.${part}`);
      else safeDetails[part] = Number(quantity);
    }
    if (Object.keys(details).some((key) => !["text_tokens", "image_tokens"].includes(key))) {
      missing.add(`usage.${detailsKey}.unmapped_fields`);
    }
    result[detailsKey] = Object.freeze(safeDetails);
  }
  if (Object.keys(rawData).some((key) => ![
    "input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details",
  ].includes(key))) missing.add("usage.unmapped_fields");
  result.missing_fields = Object.freeze([...missing]);
  return freezeUsageObservation(result);
}

function usageFromPayload(payload, transportAttemptId, rawProviderRequestId, targetBindingSha256) {
  if (!isRecord(payload) || !Object.hasOwn(payload, "usage")) {
    const usage = normalizeOpenAIImageUsage(undefined, {
      transport_attempt_id: transportAttemptId,
      provider_request_id: rawProviderRequestId,
    });
    if (typeof targetBindingSha256 === "string") PRIVATE_TARGET_BINDING_SHA256.set(usage, targetBindingSha256);
    return Object.freeze({ usage, present: false, unsupported_shape: false });
  }
  const projectionFindings = { tooManyFields: [], unmappedFields: [] };
  const boundedUsage = boundedParsedUsageObject(payload.usage, new Set([
    "input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details",
  ]), "usage", projectionFindings);
  const usage = normalizeOpenAIImageUsage(boundedUsage, {
    transport_attempt_id: transportAttemptId,
    provider_request_id: rawProviderRequestId,
  });
  if (typeof targetBindingSha256 === "string") PRIVATE_TARGET_BINDING_SHA256.set(usage, targetBindingSha256);
  let observation = usage;
  for (const field of [...projectionFindings.unmappedFields, ...projectionFindings.tooManyFields]) {
    observation = usageWithMissingField(observation, field, rawProviderRequestId, targetBindingSha256);
  }
  return Object.freeze({ usage: observation, present: true,
    unsupported_shape: projectionFindings.tooManyFields.length > 0 });
}

// This projection is only used on objects produced by readJsonBounded/JSON.parse.
// Keep the provider's known counters without retaining an oversized response
// extension; the public normalizer remains strict for arbitrary caller input.
function boundedParsedUsageObject(value, allowedKeys, field, projectionFindings) {
  if (!isRecord(value)) return value;
  let count = 0;
  let hasUnknownFields = false;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (!allowedKeys.has(key)) hasUnknownFields = true;
    count += 1;
    if (count > 32) {
      projectionFindings.tooManyFields.push(`${field}.too_many_fields`);
      break;
    }
  }
  if (hasUnknownFields) projectionFindings.unmappedFields.push(`${field}.unmapped_fields`);
  const projected = Object.create(null);
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) continue;
    const child = value[key];
    if (key === "input_tokens_details" || key === "output_tokens_details") {
      projected[key] = boundedParsedUsageObject(child, new Set(["text_tokens", "image_tokens"]),
        `usage.${key}`, projectionFindings);
    } else {
      projected[key] = child;
    }
  }
  return projected;
}

function makeBody(operation, input, config, profile, prompt, editAssets) {
  if (operation === "generate") {
    return { content_type: "application/json", body: JSON.stringify({
      model: profile.model_id,
      prompt,
      n: 1,
      size: config.size,
      quality: config.quality,
      output_format: config.output_format,
      background: config.background,
      moderation: config.moderation,
    }) };
  }
  const form = new FormData();
  form.set("model", profile.model_id);
  form.set("prompt", prompt);
  form.set("n", "1");
  form.set("size", config.size);
  form.set("quality", config.quality);
  form.set("output_format", config.output_format);
  form.set("background", config.background);
  form.set("moderation", config.moderation);
  if (editAssets.parent) {
    form.append("image[]", new Blob([editAssets.parent.bytes], { type: input.base_design.artifact.media_type }), "parent-artwork");
  }
  for (let index = 0; index < editAssets.references.length; index += 1) {
    const reference = editAssets.references[index];
    form.append("image[]", new Blob([reference.bytes], { type: reference.manifest.media_type }),
      input.concept_reference_manifest ? `concept-reference-${index + 1}` : `reference-${index + 1}`);
  }
  if (editAssets.mask) form.set("mask", new Blob([editAssets.mask.bytes], { type: "image/png" }), "edit-mask.png");
  return { content_type: undefined, body: form };
}

function knownProviderError(payload, status) {
  const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
  const type = typeof payload?.error?.type === "string" ? payload.error.type : "";
  const marker = `${code} ${type}`.toLowerCase();
  if (/moderation|content[_-]?policy|safety[_-]?system/.test(marker)) return { code: "moderation_blocked", outcome: "failed", retry_disposition: "hard_stop" };
  if (/insufficient[_-]?quota|quota[_-]?exceeded|billing[_-]?hard[_-]?limit/.test(marker)) return { code: "provider_quota_exhausted", outcome: "failed", retry_disposition: "hard_stop" };
  if (status === 401 || /invalid[_-]?api[_-]?key|authentication/.test(marker)) return { code: "authentication_denied", outcome: "failed", retry_disposition: "hard_stop" };
  if (status === 403 || /permission[_-]?denied|forbidden/.test(marker)) return { code: "operation_permission_denied", outcome: "failed", retry_disposition: "hard_stop" };
  if (status === 429 || /rate[_-]?limit|overload/.test(marker)) return { code: "provider_rate_limited", outcome: "unknown" };
  if (status === 409 && code === "request_conflict") {
    return { code: "provider_request_failed", outcome: "failed", retry_disposition: "eligible_retry" };
  }
  return { code: "provider_request_failed", outcome: status >= 500 ? "unknown" : "failed",
    ...(status >= 400 && status < 500 ? { retry_disposition: "hard_stop" } : {}) };
}

/**
 * Direct Images API provider. Construction performs no I/O. Each invocation
 * makes at most one POST, after the C03 transport acknowledgement and a fresh
 * synchronous cancellation/deadline/lease fence. It has no implicit retry.
 */
export function createOpenAIImagesProvider({ model_id, configuration, capabilityPort, authorizationPort,
  credentialPort, promptPort, assetPort, fetchImpl = globalThis.fetch, now = () => Date.now(),
  idFactory = randomUUID, retryPolicy = {} }) {
  const profile = checkTargetProfile(model_id);
  const configured = validateConfiguration(configuration, profile, "generate");
  const pinnedConfiguration = Object.freeze({ quality: configured.quality, size: configured.size,
    output_format: configured.output_format, background: configured.background, moderation: configured.moderation });
  if (!capabilityPort || typeof capabilityPort.verify !== "function" || typeof capabilityPort.revalidate !== "function" ||
      !authorizationPort || typeof authorizationPort.revalidate !== "function" ||
      !credentialPort || typeof credentialPort.resolveCredential !== "function" ||
      typeof fetchImpl !== "function") {
    fail("provider_ports_unavailable", "Trusted model, access, credential, and native-fetch ports are required.", { outcome: "failed" });
  }
  const nodeVersion = process.versions.node;
  const endpointFor = (operation) => operation === "generate" ? GENERATION_ENDPOINT : EDIT_ENDPOINT;

  const driver = Object.freeze({
    service: "openai", model_id: profile.model_id, nodeVersion, now, idFactory, retryPolicy, fetchImpl,
    capabilityPort, authorizationPort, credentialPort, promptPort, assetPort, allowMask: true,
    endpointFor,
    preflight() {},
    validateConfiguration: (operation) => validateConfiguration(pinnedConfiguration, profile, operation),
    bindingExtras: () => ({}),
    configurationSha256: (config) => hashJson({ model_id: profile.model_id, config }),
    bindingOperationKind: (_operation, attempt) => attempt.operation_kind,
    buildRequest({ operation, input, config, prompt, editAssets, credential, expected }) {
      const request = makeBody(operation, input, config, profile, prompt, editAssets);
      return { body: request.body, headers: Object.freeze({
        authorization: `Bearer ${credential.token}`,
        accept: "application/json",
        ...(request.content_type ? { "content-type": request.content_type } : {}),
        "OpenAI-Organization": expected.account_ref,
        "OpenAI-Project": expected.project_ref,
      }) };
    },
    classifyError: knownProviderError,
    embeddedErrorStatus: (_payload, status) => status,
    wantsRetryAdvisory: (status, mapped, embedded = false) => !embedded &&
      ((status === 429 && mapped.code === "provider_rate_limited") || status === 503),
    usageFromPayload,
    requestIdFromResponse: (response) => responseHeader(response, "x-request-id"),
    outputMatches: (imageInfo, _item, config) => profileDimensionsMatch(imageInfo, profile) &&
      imageInfo.format === config.output_format &&
      !(config.background === "transparent" && !imageInfo.has_alpha) &&
      !(config.dimensions && (imageInfo.width !== config.dimensions.width || imageInfo.height !== config.dimensions.height)),
  });

  function resolveRoute({ operation }) {
    const endpoint = operation === "generate" ? GENERATION_ENDPOINT : operation === "edit" ? EDIT_ENDPOINT : undefined;
    if (!endpoint) fail("unsupported_operation", "Only Images generation and edit are supported.", { outcome: "failed" });
    return Object.freeze({ retry_mapping_ref: RETRY_MAPPING_REF, provider: Object.freeze({
      name: "openai", model: profile.model_id, endpoint,
      sdk: Object.freeze({ name: "native-fetch", version: nodeVersion }),
    }) });
  }

  return Object.freeze({
    resolveRoute,
    prepareAttempt(input) { return prepareImageAttempt(driver, undefined, input); },
    getConceptConfiguration() {
      return Object.freeze({ model_id: profile.model_id, configuration: pinnedConfiguration });
    },
    inspectConceptReferences: (args) => inspectConceptReferenceBytes(assetPort, args),
    async generate(input) { return runImageDispatch(driver, "generate", input); },
    async edit(input) { return runImageDispatch(driver, "edit", input); },
  });
}

export const OPENAI_IMAGES_ENDPOINTS = Object.freeze({ generation: GENERATION_ENDPOINT, edit: EDIT_ENDPOINT });
