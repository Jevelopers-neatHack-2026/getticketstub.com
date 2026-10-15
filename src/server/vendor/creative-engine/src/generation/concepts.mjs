import { canonicalHash } from "../contracts/validation.mjs";
import {
  validateCreativeBrief,
  validateDesignVersion,
  validateResearchPackage,
} from "../contracts/creative/v1.mjs";
import {
  validateMeteredAttempt,
} from "../contracts/metering.mjs";
import { inspectOpenAIImageBytes } from "../models/openai-images.mjs";
import { imageProviderRoute } from "../models/image-routes.mjs";
import { hashArtifactBytes } from "../storage/content-addressed.mjs";

export const CREATIVE_CONCEPT_PROPOSAL = Object.freeze({
  contract: "CreativeConceptBatchProposal",
  schema_version: "0.3.0",
  acceptance_status: "unaccepted_local_proposal",
});
const LEGACY_CONCEPT_SCHEMA_VERSION = "0.1.0";
const SETTLEMENT_CONCEPT_SCHEMA_VERSION = "0.2.0";
function supportedConceptSchemaVersion(version) {
  return version === LEGACY_CONCEPT_SCHEMA_VERSION || version === SETTLEMENT_CONCEPT_SCHEMA_VERSION ||
    version === CREATIVE_CONCEPT_PROPOSAL.schema_version;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const FORMATS = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });
const CONFIGURATION_KEYS = Object.freeze(["background", "moderation", "output_format", "quality", "size"]);
const QUALITIES = new Set(["low", "medium", "high", "xhigh", "max"]);
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const BACKGROUNDS = new Set(["opaque", "transparent"]);
const MODERATION = new Set(["auto", "low"]);
// Keep this membership aligned with MeteredOperationKind and the C03 validator.
const METERED_OPERATION_KINDS = new Set([
  "image_generation",
  "image_edit",
  "responses_orchestration",
  "planning",
  "vision_observation",
  "jev_decision",
  "baseline_evaluation",
]);

const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "buffer").get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteOffset").get;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteLength").get;

export class CreativeConceptProposalError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "CreativeConceptProposalError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new CreativeConceptProposalError(code, field, message);
}

function record(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", field, `${field} must be an object.`);
  }
  return value;
}

function onlyKeys(value, allowed, field) {
  record(value, field);
  const rejected = Object.keys(value).find((key) => !allowed.includes(key));
  if (rejected) fail("unsupported_field", `${field}.${rejected}`, `${field} contains an unsupported field.`);
}

function nonEmpty(value, field, max = 500) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    fail("invalid_value", field, `${field} must be a bounded non-empty string.`);
  }
  return value;
}

function hash(value, field) {
  if (typeof value !== "string" || !HASH.test(value)) {
    fail("invalid_hash", field, `${field} must be a lowercase SHA-256 reference.`);
  }
  return value;
}

function integer(value, field, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("invalid_integer", field, `${field} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function instant(value, field) {
  if (typeof value !== "string") fail("invalid_time", field, `${field} must be an ISO timestamp.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("invalid_time", field, `${field} must be a normalized UTC ISO timestamp.`);
  }
  return milliseconds;
}

function same(left, right) {
  return canonicalHash(left) === canonicalHash(right);
}

function freezeDeep(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function cloned(value) {
  return structuredClone(value);
}

const OPENROUTER_CONFIGURATION_PATTERNS = Object.freeze({
  aspect_ratio: /^[1-9]\d{0,2}:[1-9]\d{0,2}$/,
  quality: /^[a-z][a-z0-9_-]{0,31}$/,
  background: /^(?:auto|transparent|opaque)$/,
  output_format: /^(?:png|jpeg|webp)$/,
  resolution: /^(?:512|768|1K|1\.5K|2K|4K)$/,
});

/** OpenRouter's configuration is an explicit host-declared subset; every present key is validated. */
function validateOpenRouterConfiguration(value) {
  record(value, "adapter.configuration");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (key === "output_compression") {
      if (!Number.isSafeInteger(item) || item < 0 || item > 100) {
        fail("unsupported_configuration", "adapter.configuration", "The explicit image configuration contains an unsupported value.");
      }
    } else if (!Object.hasOwn(OPENROUTER_CONFIGURATION_PATTERNS, key) || typeof item !== "string" ||
        !OPENROUTER_CONFIGURATION_PATTERNS[key].test(item)) {
      fail("unsupported_configuration", "adapter.configuration", "The explicit OpenRouter image configuration contains an unsupported option or value.");
    }
    result[key] = item;
  }
  if (result.background === "transparent" && !["png", "webp"].includes(result.output_format)) {
    fail("unsupported_configuration", "adapter.configuration", "Transparent output requires PNG or WebP.");
  }
  return Object.freeze(result);
}

function validateConfiguration(value, providerName = "openai") {
  if (providerName === "openrouter") return validateOpenRouterConfiguration(value);
  record(value, "adapter.configuration");
  const keys = Object.keys(value).sort();
  if (!same(keys, [...CONFIGURATION_KEYS].sort())) {
    fail("unsupported_configuration", "adapter.configuration", "The explicit OpenAI image configuration must contain exactly the supported fields.");
  }
  if (!QUALITIES.has(value.quality) || !OUTPUT_FORMATS.has(value.output_format) ||
      !BACKGROUNDS.has(value.background) || !MODERATION.has(value.moderation) ||
      !(value.size === "auto" || (typeof value.size === "string" && /^\d+x\d+$/.test(value.size)))) {
    fail("unsupported_configuration", "adapter.configuration", "The explicit image configuration contains an unsupported value.");
  }
  return Object.freeze({
    quality: value.quality,
    size: value.size,
    output_format: value.output_format,
    background: value.background,
    moderation: value.moderation,
  });
}

function validatePermissionEvidence(evidence, asset, packageValue, scope, nowMs, field) {
  onlyKeys(evidence, ["status", "tenant_id", "project_id", "asset_id", "content_hash", "action", "package_id", "package_hash", "owner_evidence_status", "evidence_ref", "checked_at", "expires_at"], field);
  const expiresAt = instant(evidence.expires_at, `${field}.expires_at`);
  const checkedAt = instant(evidence.checked_at, `${field}.checked_at`);
  if (evidence.status !== "granted" || evidence.owner_evidence_status !== "verified" ||
      evidence.action !== "reproduce") {
    fail("reference_permission_denied", field, "A current owner-verified reproduce permission is required for each reference.");
  }
  if (evidence.tenant_id !== scope.tenant_id || evidence.project_id !== scope.project_id ||
      evidence.asset_id !== asset.asset_id || evidence.content_hash !== asset.content_hash ||
      evidence.package_id !== packageValue.package_id || evidence.package_hash !== canonicalHash(packageValue)) {
    fail("reference_permission_scope_mismatch", field, "Permission evidence must bind the exact scoped package, asset, and hash.");
  }
  if (checkedAt > nowMs || expiresAt <= nowMs || expiresAt <= checkedAt) {
    fail("reference_permission_expired", field, "Reference permission evidence is stale or expired.");
  }
  nonEmpty(evidence.evidence_ref, `${field}.evidence_ref`);
  return Object.freeze({
    evidence_ref: evidence.evidence_ref,
    checked_at: evidence.checked_at,
    expires_at: evidence.expires_at,
  });
}

function validatePolicySnapshot(value, scope, request, nowMs) {
  onlyKeys(value, ["tenant_id", "project_id", "brief_id", "policy_ref", "policy_version", "evidence_ref", "observed_at", "expires_at", "deadline_at", "maximum_concept_count", "maximum_reference_count", "maximum_elapsed_ms", "maximum_single_reference_bytes", "maximum_aggregate_reference_bytes", "budget_scope_id", "budget_snapshot_ref", "budget_expires_at"], "policy_snapshot");
  if (value.tenant_id !== scope.tenant_id || value.project_id !== scope.project_id || value.brief_id !== scope.brief_id) {
    fail("policy_scope_mismatch", "policy_snapshot", "The policy snapshot must match the trusted tenant, project, and brief.");
  }
  const policyExpires = instant(value.expires_at, "policy_snapshot.expires_at");
  const budgetExpires = instant(value.budget_expires_at, "policy_snapshot.budget_expires_at");
  const deadline = instant(value.deadline_at, "policy_snapshot.deadline_at");
  const observed = instant(value.observed_at, "policy_snapshot.observed_at");
  if (observed > nowMs || policyExpires <= nowMs || budgetExpires <= nowMs || deadline <= nowMs ||
      policyExpires <= observed || budgetExpires <= observed) {
    fail("policy_snapshot_expired", "policy_snapshot", "The supplied policy or budget snapshot is stale or expired.");
  }
  const conceptCount = integer(request.requested_count, "request.requested_count");
  const referenceCount = request.references.length;
  const maximumConceptCount = integer(value.maximum_concept_count, "policy_snapshot.maximum_concept_count");
  const maximumReferenceCount = integer(value.maximum_reference_count, "policy_snapshot.maximum_reference_count");
  integer(value.maximum_elapsed_ms, "policy_snapshot.maximum_elapsed_ms");
  integer(value.maximum_single_reference_bytes, "policy_snapshot.maximum_single_reference_bytes");
  integer(value.maximum_aggregate_reference_bytes, "policy_snapshot.maximum_aggregate_reference_bytes");
  if (conceptCount > maximumConceptCount || referenceCount > maximumReferenceCount) {
    fail("policy_limit_exceeded", "request", "The requested concept or reference count exceeds its supplied policy snapshot.");
  }
  if (deadline - nowMs > value.maximum_elapsed_ms) {
    fail("policy_elapsed_limit_exceeded", "policy_snapshot.deadline_at", "The supplied deadline exceeds the policy snapshot elapsed-time bound.");
  }
  return Object.freeze({
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    brief_id: scope.brief_id,
    policy_ref: nonEmpty(value.policy_ref, "policy_snapshot.policy_ref"),
    policy_version: nonEmpty(value.policy_version, "policy_snapshot.policy_version"),
    evidence_ref: nonEmpty(value.evidence_ref, "policy_snapshot.evidence_ref"),
    observed_at: value.observed_at,
    expires_at: value.expires_at,
    deadline_at: value.deadline_at,
    maximum_concept_count: maximumConceptCount,
    maximum_reference_count: maximumReferenceCount,
    maximum_elapsed_ms: value.maximum_elapsed_ms,
    maximum_single_reference_bytes: value.maximum_single_reference_bytes,
    maximum_aggregate_reference_bytes: value.maximum_aggregate_reference_bytes,
    budget_scope_id: nonEmpty(value.budget_scope_id, "policy_snapshot.budget_scope_id"),
    budget_snapshot_ref: nonEmpty(value.budget_snapshot_ref, "policy_snapshot.budget_snapshot_ref"),
    budget_expires_at: value.budget_expires_at,
  });
}

function validateAdapterSnapshot(value) {
  onlyKeys(value, ["capability_ref", "capability_schema_version", "provider_name", "model", "endpoint", "provider_operation", "operation_mapping_ref", "operation_kind", "target_ref", "sdk_name", "sdk_version", "configuration_ref", "configuration_sha256", "configuration", "prompt_template_ref", "prompt_template_version", "prompt_template_sha256", "provider_tag", "capabilities"], "adapter_snapshot");
  const nativeRoute = imageProviderRoute(value.provider_name);
  if (value.provider_operation !== "edit" || !nativeRoute || value.endpoint !== nativeRoute.edit_endpoint) {
    fail("unsupported_concept_route", "adapter_snapshot.endpoint", "Referenced initial concepts require the explicit native image-edit route proposal.");
  }
  const config = validateConfiguration(value.configuration, nativeRoute.name);
  // An OpenRouter approval binds the pinned provider tag and the declared capabilities; direct OpenAI has neither.
  let routing = {};
  if (nativeRoute.name === "openrouter") {
    const capabilities = value.capabilities;
    if (typeof value.provider_tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(value.provider_tag) ||
        !isPlainRecord(capabilities) || !Object.keys(capabilities).every((key) => key === "generation" || key === "edit") ||
        typeof capabilities.generation !== "boolean" ||
        // Concepts send two references, so edit:false and any smaller or unknown-shaped edit declaration is refused.
        !isPlainRecord(capabilities.edit) || !Object.keys(capabilities.edit).every((key) => key === "max_input_references") ||
        !Number.isSafeInteger(capabilities.edit.max_input_references) || capabilities.edit.max_input_references < 2 ||
        capabilities.edit.max_input_references > 32) {
      fail("unsupported_concept_route", "adapter_snapshot.provider_tag", "OpenRouter concepts must bind the pinned provider tag and an edit capability that admits both references.");
    }
    routing = { provider_tag: value.provider_tag, capabilities: cloned(capabilities) };
  } else if (value.provider_tag !== undefined || value.capabilities !== undefined) {
    fail("unsupported_concept_route", "adapter_snapshot.provider_tag", "Only OpenRouter adapter snapshots carry a provider tag or capabilities.");
  }
  const configurationHash = hash(value.configuration_sha256, "adapter_snapshot.configuration_sha256");
  if (configurationHash !== canonicalHash(config)) {
    fail("configuration_hash_mismatch", "adapter_snapshot.configuration_sha256", "The configuration hash does not match the exact supplied configuration.");
  }
  const promptHash = hash(value.prompt_template_sha256, "adapter_snapshot.prompt_template_sha256");
  const operationKind = nonEmpty(value.operation_kind, "adapter_snapshot.operation_kind");
  if (!METERED_OPERATION_KINDS.has(operationKind)) {
    fail("unsupported_operation_kind", "adapter_snapshot.operation_kind", "The adapter operation kind must use a declared MeteredOperationKind value.");
  }
  return Object.freeze({
    capability_ref: nonEmpty(value.capability_ref, "adapter_snapshot.capability_ref"),
    capability_schema_version: nonEmpty(value.capability_schema_version, "adapter_snapshot.capability_schema_version"),
    provider_name: nonEmpty(value.provider_name, "adapter_snapshot.provider_name"),
    model: nonEmpty(value.model, "adapter_snapshot.model"),
    endpoint: value.endpoint,
    provider_operation: "edit",
    operation_kind: operationKind,
    operation_mapping_ref: nonEmpty(value.operation_mapping_ref, "adapter_snapshot.operation_mapping_ref"),
    target_ref: nonEmpty(value.target_ref, "adapter_snapshot.target_ref"),
    sdk_name: nonEmpty(value.sdk_name, "adapter_snapshot.sdk_name"),
    sdk_version: nonEmpty(value.sdk_version, "adapter_snapshot.sdk_version"),
    configuration_ref: nonEmpty(value.configuration_ref, "adapter_snapshot.configuration_ref"),
    configuration_sha256: configurationHash,
    configuration: config,
    prompt_template_ref: nonEmpty(value.prompt_template_ref, "adapter_snapshot.prompt_template_ref"),
    prompt_template_version: nonEmpty(value.prompt_template_version, "adapter_snapshot.prompt_template_version"),
    prompt_template_sha256: promptHash,
    ...routing,
  });
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageReference(packageValue, assetId, field) {
  const asset = packageValue.assets.items.find((item) => item.asset_id === assetId);
  if (!asset) fail("unknown_reference", field, "Reference asset IDs must resolve inside the validated research package.");
  const permission = packageValue.permissions.items.find((item) => item.asset_id === assetId && item.action === "reproduce");
  if (!permission || permission.status !== "granted") {
    fail("reference_permission_denied", field, "The validated research package does not grant reproduce permission for this asset.");
  }
  return asset;
}

function requestReferenceSet(request, packageValue, brief, permissionEvidence, scope, nowMs, referenceMetadata = undefined) {
  if (!Array.isArray(request.references) || request.references.length === 0) {
    fail("missing_references", "request.references", "At least one explicitly requested reference asset is required.");
  }
  const seen = new Set();
  const evidenceByAsset = new Map();
  for (const [index, evidence] of permissionEvidence.entries()) {
    record(evidence, `permission_evidence[${index}]`);
    if (typeof evidence.asset_id !== "string" || evidenceByAsset.has(evidence.asset_id)) {
      fail("duplicate_permission_evidence", `permission_evidence[${index}].asset_id`, "Permission evidence must be unique by asset.");
    }
    evidenceByAsset.set(evidence.asset_id, evidence);
  }
  if (referenceMetadata !== undefined && (!Array.isArray(referenceMetadata) || referenceMetadata.length !== request.references.length)) {
    fail("reference_metadata_mismatch", "reference_metadata", "Native reference inspection must return metadata for every ordered authorized asset.");
  }
  const result = request.references.map((reference, index) => {
    const field = `request.references[${index}]`;
    onlyKeys(reference, ["asset_id", "role_ref"], field);
    const assetId = nonEmpty(reference.asset_id, `${field}.asset_id`);
    const roleRef = nonEmpty(reference.role_ref, `${field}.role_ref`);
    if (seen.has(assetId)) fail("duplicate_reference", `${field}.asset_id`, "Each concept batch reference must identify a distinct package asset.");
    seen.add(assetId);
    const asset = packageReference(packageValue, assetId, `${field}.asset_id`);
    const evidence = evidenceByAsset.get(assetId);
    if (!evidence) fail("reference_permission_missing", field, "A request reference does not grant rights; separate owner-verified permission evidence is required.");
    const checked = validatePermissionEvidence(evidence, asset, packageValue, scope, nowMs, `permission_evidence[${assetId}]`);
    const briefPermission = brief.permissions.items.find((item) => item.asset_id === assetId && item.action === "reproduce");
    if (!briefPermission || briefPermission.status !== "granted") {
      fail("reference_permission_denied", field, "The current brief projection does not grant reproduce permission for this asset.");
    }
    const inspected = referenceMetadata?.[index];
    if (inspected !== undefined) {
      onlyKeys(inspected, ["asset_id", "source_ref", "content_hash", "media_type", "width", "height", "byte_length", "role_ref"],
        `reference_metadata[${index}]`);
      if (inspected.asset_id !== asset.asset_id || inspected.source_ref !== asset.source_id ||
          inspected.content_hash !== asset.content_hash || inspected.media_type !== asset.media_type ||
          inspected.role_ref !== roleRef || !Number.isSafeInteger(inspected.width) || inspected.width < 1 || inspected.width > 4096 ||
          !Number.isSafeInteger(inspected.height) || inspected.height < 1 || inspected.height > 4096 ||
          inspected.width * inspected.height > 16_777_216 || !Number.isSafeInteger(inspected.byte_length) || inspected.byte_length < 1) {
        fail("reference_metadata_mismatch", `reference_metadata[${index}]`, "Inspected reference dimensions and bytes must bind to the exact ordered permission-verified asset.");
      }
    }
    return Object.freeze({
      asset_id: asset.asset_id,
      source_ref: asset.source_id,
      content_hash: asset.content_hash,
      media_type: asset.media_type,
      role_ref: roleRef,
      ...(inspected ? { width: inspected.width, height: inspected.height, byte_length: inspected.byte_length } : {}),
      package_id: packageValue.package_id,
      package_sha256: canonicalHash(packageValue),
      permission_evidence_ref: checked.evidence_ref,
      permission_checked_at: checked.checked_at,
      permission_expires_at: checked.expires_at,
    });
  });
  if (evidenceByAsset.size !== result.length) {
    fail("permission_evidence_mismatch", "permission_evidence", "Permission evidence must correspond exactly to the requested reference assets.");
  }
  return Object.freeze(result);
}

function validateProposalInput(input) {
  onlyKeys(input, ["trusted_scope", "now", "brief", "brief_sha256", "research_package", "request", "permission_evidence", "policy_snapshot", "adapter_snapshot", "reference_metadata"], "input");
  const scope = record(input.trusted_scope, "trusted_scope");
  if (Object.keys(scope).some((key) => !["tenant_id", "project_id", "brief_id", "job_id", "artifact_id", "design_version_id"].includes(key))) {
    fail("unsupported_field", "trusted_scope", "Trusted scope contains an unsupported field.");
  }
  const trustedScope = {
    tenant_id: nonEmpty(scope.tenant_id, "trusted_scope.tenant_id"),
    project_id: nonEmpty(scope.project_id, "trusted_scope.project_id"),
    brief_id: nonEmpty(scope.brief_id, "trusted_scope.brief_id"),
  };
  const now = nonEmpty(input.now, "now");
  const nowMs = instant(now, "now");
  const packageValue = validateResearchPackage(input.research_package, trustedScope);
  const brief = validateCreativeBrief(input.brief, { trustedScope, researchPackage: packageValue });
  const briefHash = hash(input.brief_sha256, "brief_sha256");
  if (briefHash !== canonicalHash(brief) || brief.brief_id !== trustedScope.brief_id) {
    fail("brief_hash_mismatch", "brief_sha256", "The supplied brief snapshot does not match the trusted brief identity and hash.");
  }
  const request = record(input.request, "request");
  onlyKeys(request, ["action_id", "brief_id", "plan_id", "requested_count", "references"], "request");
  if (request.brief_id !== brief.brief_id) fail("brief_scope_mismatch", "request.brief_id", "The request must target the trusted brief.");
  nonEmpty(request.action_id, "request.action_id");
  nonEmpty(request.plan_id, "request.plan_id");
  integer(request.requested_count, "request.requested_count");
  if (!Array.isArray(request.references)) fail("invalid_type", "request.references", "request.references must be an array.");
  const requestedReferences = request.references.map((ref, index) => {
    const field = `request.references[${index}]`;
    onlyKeys(ref, ["asset_id", "role_ref"], field);
    return Object.freeze({
      asset_id: nonEmpty(ref.asset_id, `${field}.asset_id`),
      role_ref: nonEmpty(ref.role_ref, `${field}.role_ref`),
    });
  });
  const requestSnapshot = Object.freeze({
    action_id: request.action_id,
    brief_id: request.brief_id,
    plan_id: request.plan_id,
    requested_count: request.requested_count,
    references: Object.freeze(requestedReferences),
  });
  const policy = validatePolicySnapshot(input.policy_snapshot, trustedScope, requestSnapshot, nowMs);
  const evidence = Array.isArray(input.permission_evidence) ? input.permission_evidence :
    fail("invalid_type", "permission_evidence", "Separate permission evidence must be supplied by the trusted rights adapter.");
  const references = requestReferenceSet(requestSnapshot, packageValue, brief, evidence, trustedScope, nowMs, input.reference_metadata);
  const adapter = validateAdapterSnapshot(input.adapter_snapshot);
  const plan = Object.freeze({
    plan_id: requestSnapshot.plan_id,
    brief_id: brief.brief_id,
    brief_sha256: briefHash,
    requested_count: requestSnapshot.requested_count,
    references: references.map(({ asset_id, source_ref, content_hash, role_ref }) => ({
      asset_id, source_ref, content_hash, role_ref,
    })),
  });
  const planHash = canonicalHash(plan);
  const requestHash = canonicalHash(requestSnapshot);
  const batchId = `batch:${canonicalHash({
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    action_id: requestSnapshot.action_id,
    request_sha256: requestHash,
  })}`;
  return { trustedScope, now, nowMs, brief, packageValue, briefHash, requestSnapshot, requestHash, plan, planHash, batchId, policy, references, adapter };
}

export function createCreativeConceptBatchProposal(input) {
  const validated = validateProposalInput(input);
  const { trustedScope, brief, packageValue, briefHash, requestSnapshot, requestHash, plan, planHash, batchId, policy, references, adapter } = validated;
  const slots = Array.from({ length: requestSnapshot.requested_count }, (_, offset) => {
    const ordinal = offset + 1;
    const conceptId = `concept:${canonicalHash({
      tenant_id: trustedScope.tenant_id,
      project_id: trustedScope.project_id,
      brief_id: brief.brief_id,
      action_id: requestSnapshot.action_id,
      request_sha256: requestHash,
      ordinal,
    })}`;
    return {
      concept_id: conceptId,
      ordinal,
      logical_operation_id: `logical:${canonicalHash({ batch_id: batchId, concept_id: conceptId })}`,
      status: "pending",
      parent_version_id: null,
      attempts: [],
      current_billable_attempt_id: null,
      output_lineage: null,
      metadata_reconciliations: [],
      late_evidence: [],
    };
  });
  const state = {
    ...CREATIVE_CONCEPT_PROPOSAL,
    batch_id: batchId,
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    brief_id: brief.brief_id,
    brief_sha256: briefHash,
    package_id: packageValue.package_id,
    package_sha256: canonicalHash(packageValue),
    action_id: requestSnapshot.action_id,
    request_sha256: requestHash,
    plan_id: plan.plan_id,
    plan_sha256: planHash,
    requested_count: requestSnapshot.requested_count,
    policy_snapshot: policy,
    adapter_snapshot: adapter,
    references,
    slots,
    events: [],
  };
  return freezeDeep(state);
}

export function replayCreativeConceptBatch(existing, incoming) {
  record(existing, "existing_batch");
  onlyKeys(incoming, ["trusted_scope", "request"], "incoming_request");
  const request = record(incoming.request, "incoming_request.request");
  const scope = record(incoming.trusted_scope, "incoming_request.trusted_scope");
  onlyKeys(request, ["action_id", "brief_id", "plan_id", "requested_count", "references"], "incoming_request.request");
  const actionId = nonEmpty(request.action_id, "incoming_request.request.action_id");
  if (existing.contract !== CREATIVE_CONCEPT_PROPOSAL.contract ||
      !supportedConceptSchemaVersion(existing.schema_version) ||
      existing.acceptance_status !== CREATIVE_CONCEPT_PROPOSAL.acceptance_status) {
    fail("unsupported_batch_version", "existing_batch", "Only explicitly supported local proposal versions can be replayed.");
  }
  if (scope.tenant_id !== existing.tenant_id || scope.project_id !== existing.project_id ||
      scope.brief_id !== existing.brief_id || actionId !== existing.action_id) {
    fail("replay_scope_mismatch", "incoming_request", "Historical replay requires the exact stored tenant, project, brief, and action identity.");
  }
  const normalizedRequest = {
    action_id: actionId,
    brief_id: nonEmpty(request.brief_id, "incoming_request.request.brief_id"),
    plan_id: nonEmpty(request.plan_id, "incoming_request.request.plan_id"),
    requested_count: integer(request.requested_count, "incoming_request.request.requested_count"),
    references: Array.isArray(request.references) ? request.references.map((ref, index) => {
      onlyKeys(ref, ["asset_id", "role_ref"], `incoming_request.request.references[${index}]`);
      return {
        asset_id: nonEmpty(ref.asset_id, `incoming_request.request.references[${index}].asset_id`),
        role_ref: nonEmpty(ref.role_ref, `incoming_request.request.references[${index}].role_ref`),
      };
    }) : fail("invalid_type", "incoming_request.request.references", "Request references must be an array."),
  };
  if (canonicalHash(normalizedRequest) !== existing.request_sha256) {
    fail("action_replay_conflict", "incoming_request.request", "The scoped action ID already exists with a different canonical request.");
  }
  return Object.freeze({ status: "replayed", batch: existing });
}

function contextSlot(batch, event) {
  record(batch, "batch");
  record(event, "event");
  if (batch.contract !== CREATIVE_CONCEPT_PROPOSAL.contract ||
      !supportedConceptSchemaVersion(batch.schema_version) ||
      batch.acceptance_status !== CREATIVE_CONCEPT_PROPOSAL.acceptance_status) {
    fail("unsupported_batch_version", "batch", "Only explicitly supported local proposal versions can accept source events.");
  }
  for (const field of ["tenant_id", "project_id", "action_id", "batch_id"]) {
    if (event[field] !== batch[field]) fail("event_scope_mismatch", `event.${field}`, `Event ${field} must match the stored scoped batch identity.`);
  }
  nonEmpty(event.event_id, "event.event_id");
  nonEmpty(event.event_type, "event.event_type");
  const common = ["tenant_id", "project_id", "action_id", "batch_id", "concept_id", "event_id", "event_type"];
  const eventFields = {
    upgrade_retry_disposition: ["from_schema_version", "to_schema_version"],
    reserve_attempt: ["billable_attempt_id", "transport_attempt_id", "metered_attempt", "reservation"],
    dispatch_started: ["billable_attempt_id", "transport_attempt_id", "dispatch_intent_ref", "provider_target_binding_sha256", "rendered_prompt_sha256"],
    provider_outcome: ["billable_attempt_id", "transport_attempt_id", "outcome", "outcome_evidence_ref", "provider_request_id", "artifact_sha256", "usage_evidence_ref", "usage_completeness"],
    reconcile_unknown_attempt: ["billable_attempt_id", "transport_attempt_id", "outcome", "outcome_evidence_ref", "provider_request_id", "artifact_sha256", "usage_evidence_ref", "usage_completeness"],
    artifact_rejected: ["billable_attempt_id", "transport_attempt_id", "artifact_sha256", "failure_code", "inspection_evidence_ref"],
    candidate_staged: ["billable_attempt_id", "transport_attempt_id", "artifact_sha256", "media_type", "width", "height", "storage_stage_ref", "inspection_evidence_ref"],
    reconcile_staged_metadata: ["billable_attempt_id", "transport_attempt_id", "artifact_sha256", "metadata_evidence_ref"],
    candidate_published: ["billable_attempt_id", "transport_attempt_id", "design_version", "storage_commit_ref", "lineage_evidence_ref"],
    cancel_concept: ["billable_attempt_id", "transport_attempt_id", "cancellation_evidence_ref"],
    late_provider_evidence: ["billable_attempt_id", "transport_attempt_id", "outcome", "outcome_evidence_ref", "provider_request_id", "artifact_sha256", "usage_evidence_ref", "usage_completeness"],
  };
  if ([SETTLEMENT_CONCEPT_SCHEMA_VERSION, CREATIVE_CONCEPT_PROPOSAL.schema_version].includes(batch.schema_version)) {
    eventFields.provider_outcome.push("financial_exposure_status", "financial_settlement_evidence");
    eventFields.reconcile_unknown_attempt.push("financial_exposure_status", "financial_settlement_evidence");
  }
  if (batch.schema_version === CREATIVE_CONCEPT_PROPOSAL.schema_version) {
    eventFields.provider_outcome.push("retry_disposition");
  }
  if (!eventFields[event.event_type]) fail("unsupported_event", "event.event_type", `Unsupported concept event ${String(event.event_type)}.`);
  onlyKeys(event, [...common, ...eventFields[event.event_type]], "event");
  if (event.concept_id === undefined || event.concept_id === null) return null;
  const slot = batch.slots.find((candidate) => candidate.concept_id === event.concept_id);
  if (!slot) fail("unknown_concept", "event.concept_id", "The event concept ID is not part of this ordered batch.");
  return slot;
}

function findAttempt(slot, billableAttemptId, transportAttemptId) {
  const attempt = slot.attempts.find((item) => item.billable_attempt_id === billableAttemptId);
  if (!attempt) fail("unknown_attempt", "event.billable_attempt_id", "The event must bind an existing reserved billable attempt.");
  const exactTransportAttemptId = nonEmpty(transportAttemptId, "event.transport_attempt_id");
  if (attempt.transport_attempt_id !== exactTransportAttemptId) {
    fail("attempt_identity_mismatch", "event.transport_attempt_id", "The event transport attempt does not match its reserved billable attempt.");
  }
  return attempt;
}

function validateEventAttemptIdentity(slot, event) {
  if (event.event_type === "cancel_concept" && slot.current_billable_attempt_id === null) {
    if (event.billable_attempt_id !== undefined || event.transport_attempt_id !== undefined) {
      fail("attempt_identity_mismatch", "event", "Cancellation without an attempt must omit both billable and transport identities.");
    }
    return;
  }

  const billableAttemptId = nonEmpty(event.billable_attempt_id, "event.billable_attempt_id");
  const transportAttemptId = nonEmpty(event.transport_attempt_id, "event.transport_attempt_id");
  if (event.event_type === "reserve_attempt") {
    const existing = slot.attempts.find((attempt) => attempt.billable_attempt_id === billableAttemptId);
    if (existing && existing.transport_attempt_id !== transportAttemptId) {
      fail("attempt_identity_reused", "event.transport_attempt_id", "A reused billable attempt must preserve its exact transport attempt identity.");
    }
    const meteredAttempt = record(event.metered_attempt, "event.metered_attempt");
    const reservation = record(event.reservation, "event.reservation");
    if (meteredAttempt.billable_attempt_id !== billableAttemptId || reservation.billable_attempt_id !== billableAttemptId) {
      fail("attempt_identity_mismatch", "event.billable_attempt_id", "The event, metered request, and reservation must name the same billable attempt.");
    }
    return;
  }
  if (event.event_type === "cancel_concept" && billableAttemptId !== slot.current_billable_attempt_id) {
    fail("attempt_identity_mismatch", "event.billable_attempt_id", "Cancellation must bind the exact current billable attempt.");
  }
  findAttempt(slot, billableAttemptId, transportAttemptId);
}

function eventReplay(batch, event, slot) {
  const eventHash = canonicalHash(event);
  const previous = batch.events.find((item) => item.event_id === event.event_id);
  if (!previous) return { eventHash, duplicate: false };
  if (previous.event_hash !== eventHash || previous.event_type !== event.event_type || previous.concept_id !== (event.concept_id ?? null) ||
      previous.billable_attempt_id !== (event.billable_attempt_id ?? null)) {
    fail("event_identity_conflict", "event.event_id", "Reusing an event identity with changed context or payload is a conflict.");
  }
  if (event.billable_attempt_id) {
    const attempt = findAttempt(slot, event.billable_attempt_id, event.transport_attempt_id);
    if (previous.reservation_ref && attempt.reservation_ref !== previous.reservation_ref) {
      fail("event_attempt_conflict", "event.reservation_ref", "The replayed reservation does not match the stored attempt.");
    }
  }
  return { eventHash, duplicate: true };
}

function appendEvent(next, event, eventHash) {
  next.events.push(Object.freeze({
    event_id: event.event_id,
    event_hash: eventHash,
    event_type: event.event_type,
    concept_id: event.concept_id ?? null,
    billable_attempt_id: event.billable_attempt_id ?? null,
    reservation_ref: event.reservation_ref ?? null,
  }));
}

function validateReservation(event, batch, slot) {
  const meteringScope = {
    tenant_id: batch.tenant_id,
    project_id: batch.project_id,
    budget_scope_id: batch.policy_snapshot.budget_scope_id,
  };
  const attempt = validateMeteredAttempt(event.metered_attempt, meteringScope);
  if (event.billable_attempt_id !== attempt.billable_attempt_id) {
    fail("attempt_identity_mismatch", "event.billable_attempt_id", "The event identity must name the exact C03 billable attempt.");
  }
  if (attempt.logical_operation_id !== slot.logical_operation_id || attempt.operation_kind !== batch.adapter_snapshot.operation_kind ||
      attempt.provider.name !== batch.adapter_snapshot.provider_name || attempt.provider.model !== batch.adapter_snapshot.model ||
      attempt.provider.endpoint !== batch.adapter_snapshot.endpoint || attempt.provider.sdk.name !== batch.adapter_snapshot.sdk_name ||
      attempt.provider.sdk.version !== batch.adapter_snapshot.sdk_version) {
    fail("metered_attempt_binding_mismatch", "event.metered_attempt", "C03 attempt identity must match this concept slot and the explicit adapter target snapshot.");
  }
  onlyKeys(event.reservation, ["status", "reservation_id", "billable_attempt_id", "held_amount", "lease_id"], "event.reservation");
  const reservation = event.reservation;
  if (reservation.status !== "reserved" || reservation.billable_attempt_id !== attempt.billable_attempt_id) {
    fail("reservation_binding_mismatch", "event.reservation", "The C03 reservation must be granted for the exact billable attempt.");
  }
  nonEmpty(reservation.reservation_id, "event.reservation.reservation_id");
  nonEmpty(reservation.lease_id, "event.reservation.lease_id");
  onlyKeys(reservation.held_amount, ["amount", "currency"], "event.reservation.held_amount");
  if (typeof reservation.held_amount.amount !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(reservation.held_amount.amount) ||
      typeof reservation.held_amount.currency !== "string" || reservation.held_amount.currency.length === 0) {
    fail("invalid_reservation_amount", "event.reservation.held_amount", "C03 reservation amount evidence must be structurally valid.");
  }
  const transportId = nonEmpty(event.transport_attempt_id, "event.transport_attempt_id");
  const allAttempts = batch.slots.flatMap((item) => item.attempts);
  if (allAttempts.some((item) => item.billable_attempt_id === attempt.billable_attempt_id ||
      item.transport_attempt_id === transportId || item.reservation_ref === reservation.reservation_id)) {
    fail("attempt_identity_reused", "event.metered_attempt", "A new dispatch requires distinct billable, transport, and reservation identities.");
  }
  return { attempt, reservation, transportId };
}

function appendProviderObservation(attempt, event, outcome) {
  const financialExposureStatus = event.financial_exposure_status;
  const settlementEvidence = event.financial_settlement_evidence;
  if (financialExposureStatus !== undefined && financialExposureStatus !== "settled") {
    fail("invalid_financial_exposure_status", "event.financial_exposure_status",
      "Only an explicit C03 settlement may resolve unknown financial exposure.");
  }
  if (financialExposureStatus === "settled" && (!settlementEvidence || event.usage_completeness !== "complete")) {
    fail("invalid_financial_exposure_status", "event.financial_exposure_status",
      "A settled attempt must carry complete usage and exact C03 settlement evidence.");
  }
  if (settlementEvidence !== undefined) {
    onlyKeys(settlementEvidence, ["status", "reservation_id", "source_observation_id", "effective_billable_attempt_id"],
      "event.financial_settlement_evidence");
    if (financialExposureStatus !== "settled" || settlementEvidence.status !== "settled" ||
        settlementEvidence.reservation_id !== attempt.reservation_ref ||
        settlementEvidence.source_observation_id !== event.usage_evidence_ref ||
        settlementEvidence.effective_billable_attempt_id !== attempt.billable_attempt_id ||
        event.usage_completeness !== "complete") {
      fail("invalid_financial_exposure_status", "event.financial_settlement_evidence",
        "The C03 settlement, observation, usage reference, and billable attempt must bind exactly.");
    }
  }
  const retryDisposition = event.retry_disposition;
  if (retryDisposition !== undefined && (outcome !== "failed" ||
      !["eligible_retry", "hard_stop"].includes(retryDisposition))) {
    fail("invalid_retry_disposition", "event.retry_disposition",
      "A native retry disposition must explicitly classify a known failed provider response.");
  }
  const observation = Object.freeze({
    event_id: event.event_id,
    outcome,
    outcome_evidence_ref: nonEmpty(event.outcome_evidence_ref, "event.outcome_evidence_ref"),
    provider_request_id: event.provider_request_id === undefined ? null : nonEmpty(event.provider_request_id, "event.provider_request_id"),
    artifact_sha256: event.artifact_sha256 === undefined ? null : hash(event.artifact_sha256, "event.artifact_sha256"),
    usage_evidence_ref: nonEmpty(event.usage_evidence_ref, "event.usage_evidence_ref"),
    usage_completeness: event.usage_completeness,
    ...(retryDisposition ? { retry_disposition: retryDisposition } : {}),
    ...(financialExposureStatus ? { financial_exposure_status: financialExposureStatus,
      financial_settlement_evidence: Object.freeze({ status: settlementEvidence.status,
        reservation_id: settlementEvidence.reservation_id, source_observation_id: settlementEvidence.source_observation_id,
        effective_billable_attempt_id: settlementEvidence.effective_billable_attempt_id }) } : {}),
  });
  if (!["complete", "partial", "unknown"].includes(observation.usage_completeness)) {
    fail("invalid_usage_completeness", "event.usage_completeness", "Usage completeness must preserve complete, partial, or unknown status.");
  }
  if (outcome === "succeeded" && !observation.artifact_sha256) {
    fail("missing_artifact_hash", "event.artifact_sha256", "A successful provider response must identify its exact image bytes by hash.");
  }
  attempt.provider_observations.push(observation);
  attempt.latest_provider_outcome = outcome;
  if (Object.hasOwn(attempt, "latest_retry_disposition")) attempt.latest_retry_disposition = retryDisposition ?? null;
  attempt.latest_provider_request_id = observation.provider_request_id;
  attempt.usage_evidence_refs.push(observation.usage_evidence_ref);
  attempt.usage_evidence_ref = observation.usage_evidence_ref;
  attempt.usage_completeness = observation.usage_completeness;
  attempt.unknown_financial_exposure = financialExposureStatus === "settled" ? false :
    attempt.unknown_financial_exposure || outcome === "unknown" || observation.usage_completeness !== "complete";
  if (attempt.unknown_financial_exposure) attempt.financial_exposure_status = "unknown_hold";
  else attempt.financial_exposure_status = financialExposureStatus === "settled" ? "settled" : "awaiting_c03_reconciliation";
  return observation;
}

function eventRelatedAttempt(slot, event) {
  return findAttempt(slot, nonEmpty(event.billable_attempt_id, "event.billable_attempt_id"), event.transport_attempt_id);
}

function validateDesignVersionAttemptIdentity(version, slot, attempt) {
  for (const [field, expected] of [
    ["logical_operation_id", slot.logical_operation_id],
    ["billable_attempt_id", attempt.billable_attempt_id],
    ["transport_attempt_id", attempt.transport_attempt_id],
    ["provider_request_id", attempt.latest_provider_request_id],
  ]) {
    if (Object.prototype.hasOwnProperty.call(version, field) && version[field] !== expected) {
      fail("design_version_attempt_identity_mismatch", `event.design_version.${field}`, `The supplied DesignVersion ${field} must match the exact concept attempt observation.`);
    }
  }
}

function validatePublishedVersionIdentities(batch, slot, version) {
  const otherPublished = batch.slots.filter((candidate) =>
    candidate.concept_id !== slot.concept_id && candidate.output_lineage !== null);
  if (otherPublished.some((candidate) => candidate.output_lineage.design_version_id === version.design_version_id)) {
    fail("design_version_identity_reused", "event.design_version.design_version_id", "A published DesignVersion identity may belong to only one concept slot in this batch.");
  }
  const artifactIdentity = otherPublished.find((candidate) =>
    candidate.output_lineage.artifact_id === version.artifact.artifact_id);
  if (artifactIdentity && (artifactIdentity.output_lineage.artifact_sha256 !== version.artifact.content_hash ||
      artifactIdentity.output_lineage.artifact_media_type !== version.artifact.media_type)) {
    fail("artifact_identity_conflict", "event.design_version.artifact", "A reused artifact identity must preserve its exact content hash and media type.");
  }
}

export function applyCreativeConceptEvent(batch, incomingEvent) {
  const event = cloned(incomingEvent);
  const slot = contextSlot(batch, event);
  if (!["cancel_batch", "upgrade_retry_disposition"].includes(event.event_type) && !slot) {
    fail("missing_concept", "event.concept_id", "This event type requires an ordered concept slot.");
  }
  if (slot) {
    validateEventAttemptIdentity(slot, event);
    const { duplicate } = eventReplay(batch, event, slot);
    if (duplicate) return Object.freeze({ status: "duplicate", batch });
    if (slot.status === "succeeded" || (slot.status === "cancelled" && event.event_type !== "late_provider_evidence")) {
      fail("terminal_state_immutable", "event.concept_id", "Completed and cancelled histories accept no state-changing events.");
    }
  } else {
    const { duplicate } = eventReplay(batch, event, null);
    if (duplicate) return Object.freeze({ status: "duplicate", batch });
  }

  if (event.event_type === "upgrade_retry_disposition") {
    if (event.concept_id !== null || ![LEGACY_CONCEPT_SCHEMA_VERSION, SETTLEMENT_CONCEPT_SCHEMA_VERSION].includes(batch.schema_version) ||
        event.from_schema_version !== batch.schema_version || event.to_schema_version !== CREATIVE_CONCEPT_PROPOSAL.schema_version) {
      fail("invalid_schema_upgrade", "event.schema_version", "Retry disposition upgrades must advance a supported legacy batch to proposal 0.3.0 exactly once.");
    }
    const next = cloned(batch);
    next.schema_version = CREATIVE_CONCEPT_PROPOSAL.schema_version;
    for (const concept of next.slots) {
      for (const attempt of concept.attempts) {
        if (attempt.latest_retry_disposition !== undefined) continue;
        // Initializing the field lets any subsequent observation on an in-flight
        // legacy attempt replace null with its private classification. A prior
        // failure with no historical classification stays durably non-retryable.
        attempt.latest_retry_disposition = attempt.latest_provider_outcome === "failed"
          ? "legacy_unclassified" : null;
      }
    }
    appendEvent(next, event, canonicalHash(event));
    return Object.freeze({ status: "applied", batch: freezeDeep(next) });
  }

  const next = cloned(batch);
  const nextSlot = slot ? next.slots.find((item) => item.concept_id === slot.concept_id) : null;
  switch (event.event_type) {
    case "reserve_attempt": {
      if (nextSlot.status !== "pending" && nextSlot.status !== "failed") {
        fail("dispatch_not_allowed", "event.concept_id", "Only a pending concept or a known failed concept may receive a new C03 reservation.");
      }
      const priorAttempt = nextSlot.attempts.at(-1);
      if (next.schema_version === CREATIVE_CONCEPT_PROPOSAL.schema_version &&
          nextSlot.status === "failed" && priorAttempt?.latest_provider_outcome === "failed" &&
          (priorAttempt.latest_retry_disposition !== "eligible_retry" || priorAttempt.usage_completeness !== "complete" ||
            priorAttempt.financial_exposure_status !== "settled" || priorAttempt.unknown_financial_exposure)) {
        fail("retry_not_authorized", "event.billable_attempt_id",
          "A native failure may retry only after explicit eligibility, complete usage, and exact settled C03 evidence.");
      }
      const { attempt, reservation, transportId } = validateReservation(event, next, nextSlot);
      if (nextSlot.attempts.some((item) => item.billable_attempt_id === attempt.billable_attempt_id)) {
        fail("attempt_identity_reused", "event.metered_attempt.billable_attempt_id", "A genuine retry requires a new C03 billable-attempt identity.");
      }
      const storedAttempt = {
        logical_operation_id: attempt.logical_operation_id,
        billable_attempt_id: attempt.billable_attempt_id,
        transport_attempt_id: transportId,
        reservation_ref: reservation.reservation_id,
        lease_ref: reservation.lease_id,
        metering_attempt: cloned(attempt),
        status: "reserved",
        financial_exposure_status: "reservation_active",
        unknown_financial_exposure: false,
        provider_observations: [],
        latest_provider_outcome: null,
        ...(next.schema_version === CREATIVE_CONCEPT_PROPOSAL.schema_version ? { latest_retry_disposition: null } : {}),
        latest_provider_request_id: null,
        usage_evidence_ref: null,
        usage_evidence_refs: [],
        usage_completeness: null,
        dispatch_intent_ref: null,
        provider_target_binding_sha256: null,
        rendered_prompt_sha256: null,
        provider_artifact_sha256: null,
        storage_stage_ref: null,
        inspection_evidence_ref: null,
        storage_metadata_evidence_refs: [],
        publication: null,
      };
      nextSlot.attempts.push(storedAttempt);
      nextSlot.current_billable_attempt_id = attempt.billable_attempt_id;
      nextSlot.status = "reserved";
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "dispatch_started": {
      if (nextSlot.status !== "reserved") fail("dispatch_not_allowed", "event.concept_id", "Only a freshly C03-reserved concept may cross into dispatch.");
      const attempt = eventRelatedAttempt(nextSlot, event);
      if (attempt.status !== "reserved" || nextSlot.current_billable_attempt_id !== attempt.billable_attempt_id) {
        fail("attempt_state_conflict", "event.billable_attempt_id", "Dispatch must use the current reserved attempt exactly once.");
      }
      attempt.dispatch_intent_ref = nonEmpty(event.dispatch_intent_ref, "event.dispatch_intent_ref");
      attempt.provider_target_binding_sha256 = hash(event.provider_target_binding_sha256, "event.provider_target_binding_sha256");
      attempt.rendered_prompt_sha256 = hash(event.rendered_prompt_sha256, "event.rendered_prompt_sha256");
      attempt.status = "dispatching";
      attempt.financial_exposure_status = "in_flight";
      nextSlot.status = "dispatching";
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "provider_outcome": {
      if (nextSlot.status !== "dispatching" && !(nextSlot.status === "reserved" && event.outcome === "unknown")) {
        fail("outcome_state_conflict", "event.concept_id", "A first provider outcome requires the same attempt to be dispatching; a reserved attempt can only be conservatively marked unknown.");
      }
      const attempt = eventRelatedAttempt(nextSlot, event);
      if (!(["dispatching", "reserved"].includes(attempt.status) && attempt.status === nextSlot.status) ||
          nextSlot.current_billable_attempt_id !== attempt.billable_attempt_id ||
          attempt.status === "reserved" && event.outcome !== "unknown") {
        fail("attempt_state_conflict", "event.billable_attempt_id", "Provider outcome must bind the current in-flight attempt.");
      }
      if (!["succeeded", "failed", "unknown"].includes(event.outcome)) fail("invalid_outcome", "event.outcome", "Provider outcome must be succeeded, failed, or unknown.");
      appendProviderObservation(attempt, event, event.outcome);
      if (event.outcome === "succeeded") {
        attempt.status = "response_received";
        attempt.provider_artifact_sha256 = hash(event.artifact_sha256, "event.artifact_sha256");
        nextSlot.status = "response_received";
      } else if (event.outcome === "failed") {
        attempt.status = "failed";
        nextSlot.status = "failed";
      } else {
      attempt.status = "unknown";
        nextSlot.status = "unknown";
      }
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "reconcile_unknown_attempt": {
      if (nextSlot.status !== "unknown") fail("reconciliation_state_conflict", "event.concept_id", "Only the existing unknown attempt can be reconciled; a new attempt is not allowed.");
      const attempt = eventRelatedAttempt(nextSlot, event);
      if (attempt.status !== "unknown" || nextSlot.current_billable_attempt_id !== attempt.billable_attempt_id ||
          !attempt.unknown_financial_exposure) {
        fail("attempt_state_conflict", "event.billable_attempt_id", "Unknown reconciliation must append to the same attempt and retain its financial exposure.");
      }
      if (!["succeeded", "failed"].includes(event.outcome)) fail("invalid_outcome", "event.outcome", "Reconciliation requires a same-attempt known provider outcome.");
      appendProviderObservation(attempt, event, event.outcome);
      if (event.outcome === "succeeded") {
        attempt.status = "response_received";
        attempt.provider_artifact_sha256 = hash(event.artifact_sha256, "event.artifact_sha256");
        nextSlot.status = "response_received";
      } else {
        attempt.status = "failed";
        nextSlot.status = "failed";
      }
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "candidate_staged": {
      if (nextSlot.status !== "response_received") fail("stage_state_conflict", "event.concept_id", "Only a same-attempt successful response can be staged.");
      const attempt = eventRelatedAttempt(nextSlot, event);
      if (attempt.status !== "response_received" || nextSlot.current_billable_attempt_id !== attempt.billable_attempt_id) {
        fail("attempt_state_conflict", "event.billable_attempt_id", "Candidate staging must bind the exact successful attempt.");
      }
      const artifactHash = hash(event.artifact_sha256, "event.artifact_sha256");
      if (artifactHash !== attempt.provider_artifact_sha256) fail("artifact_hash_mismatch", "event.artifact_sha256", "Staged candidate bytes must match the exact successful provider response hash.");
      const mediaType = nonEmpty(event.media_type, "event.media_type");
      const width = integer(event.width, "event.width");
      const height = integer(event.height, "event.height");
      const format = Object.keys(FORMATS).find((key) => FORMATS[key] === mediaType);
      if (!format) fail("unsupported_media_type", "event.media_type", "Only native inspected PNG, JPEG, and WebP bytes can be staged.");
      const pinnedFormat = next.adapter_snapshot.configuration.output_format;
      if (pinnedFormat !== undefined && mediaType !== FORMATS[pinnedFormat]) {
        fail("adapter_output_format_mismatch", "event.media_type", "Staged media type must match the explicit adapter output-format snapshot.");
      }
      attempt.staged_artifact = Object.freeze({ content_hash: artifactHash, media_type: mediaType, width, height, format });
      attempt.storage_stage_ref = nonEmpty(event.storage_stage_ref, "event.storage_stage_ref");
      attempt.inspection_evidence_ref = nonEmpty(event.inspection_evidence_ref, "event.inspection_evidence_ref");
      attempt.status = "staged";
      nextSlot.status = "staged";
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "artifact_rejected": {
      if (nextSlot.status !== "response_received") fail("artifact_rejection_state_conflict", "event.concept_id", "Artifact rejection must retain a successful response from the same attempt.");
      const attempt = eventRelatedAttempt(nextSlot, event);
      const artifactHash = hash(event.artifact_sha256, "event.artifact_sha256");
      if (attempt.status !== "response_received" || nextSlot.current_billable_attempt_id !== attempt.billable_attempt_id ||
          artifactHash !== attempt.provider_artifact_sha256) {
        fail("artifact_rejection_identity_mismatch", "event", "Artifact rejection must bind the exact successful response bytes and current attempt.");
      }
      attempt.artifact_validation_failure = Object.freeze({
        artifact_sha256: artifactHash,
        failure_code: nonEmpty(event.failure_code, "event.failure_code"),
        inspection_evidence_ref: nonEmpty(event.inspection_evidence_ref, "event.inspection_evidence_ref"),
      });
      attempt.status = "failed_artifact";
      nextSlot.status = "failed";
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "reconcile_staged_metadata": {
      if (nextSlot.status !== "staged") fail("reconciliation_state_conflict", "event.concept_id", "Storage metadata reconciliation requires the existing staged attempt.");
      const attempt = eventRelatedAttempt(nextSlot, event);
      if (attempt.status !== "staged" || nextSlot.current_billable_attempt_id !== attempt.billable_attempt_id ||
          hash(event.artifact_sha256, "event.artifact_sha256") !== attempt.staged_artifact.content_hash) {
        fail("staged_metadata_mismatch", "event", "Metadata reconciliation must retain the same staged billable attempt and exact bytes hash.");
      }
      attempt.storage_metadata_evidence_refs.push(nonEmpty(event.metadata_evidence_ref, "event.metadata_evidence_ref"));
      nextSlot.metadata_reconciliations.push(event.event_id);
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "candidate_published": {
      if (nextSlot.status !== "staged") fail("publication_state_conflict", "event.concept_id", "A candidate is visible only after same-attempt native inspection and durable staging.");
      const attempt = eventRelatedAttempt(nextSlot, event);
      if (attempt.status !== "staged" || nextSlot.current_billable_attempt_id !== attempt.billable_attempt_id) {
        fail("attempt_state_conflict", "event.billable_attempt_id", "Publication must bind the exact staged attempt.");
      }
      const designVersion = record(event.design_version, "event.design_version");
      const designVersionId = nonEmpty(designVersion.design_version_id, "event.design_version.design_version_id");
      const version = validateDesignVersion(event.design_version, {
        trustedScope: { tenant_id: next.tenant_id, project_id: next.project_id, brief_id: next.brief_id,
          design_version_id: designVersionId },
        brief_hash: next.brief_sha256,
        known_source_refs: next.references.map((item) => item.source_ref),
      });
      if (version.parent_version_id !== null || version.artifact.content_hash !== attempt.staged_artifact.content_hash ||
          version.artifact.media_type !== attempt.staged_artifact.media_type ||
          !next.references.every((item) => version.source_refs.includes(item.source_ref))) {
        fail("candidate_lineage_mismatch", "event.design_version", "Initial concept publication must preserve its exact staged bytes, no-parent lineage, and every source reference.");
      }
      validateDesignVersionAttemptIdentity(version, nextSlot, attempt);
      validatePublishedVersionIdentities(next, nextSlot, version);
      attempt.publication = Object.freeze({
        design_version_id: version.design_version_id,
        design_sha256: version.design_hash,
        storage_commit_ref: nonEmpty(event.storage_commit_ref, "event.storage_commit_ref"),
        lineage_evidence_ref: nonEmpty(event.lineage_evidence_ref, "event.lineage_evidence_ref"),
      });
      attempt.status = "published";
      nextSlot.output_lineage = Object.freeze({
        concept_id: nextSlot.concept_id,
        parent_version_id: null,
        brief_sha256: next.brief_sha256,
        package_sha256: next.package_sha256,
        plan_sha256: next.plan_sha256,
        source_assets: next.references,
        adapter_capability_ref: next.adapter_snapshot.capability_ref,
        target_ref: next.adapter_snapshot.target_ref,
        model: next.adapter_snapshot.model,
        configuration_ref: next.adapter_snapshot.configuration_ref,
        configuration_sha256: next.adapter_snapshot.configuration_sha256,
        configuration: next.adapter_snapshot.configuration,
        prompt_template_ref: next.adapter_snapshot.prompt_template_ref,
        prompt_template_version: next.adapter_snapshot.prompt_template_version,
        prompt_template_sha256: next.adapter_snapshot.prompt_template_sha256,
        rendered_prompt_sha256: attempt.rendered_prompt_sha256,
        provider_target_binding_sha256: attempt.provider_target_binding_sha256,
        logical_operation_id: attempt.logical_operation_id,
        billable_attempt_id: attempt.billable_attempt_id,
        transport_attempt_id: attempt.transport_attempt_id,
        provider_request_id: attempt.latest_provider_request_id,
        usage_evidence_ref: attempt.usage_evidence_ref,
        usage_evidence_refs: Object.freeze([...attempt.usage_evidence_refs]),
        usage_completeness: attempt.usage_completeness,
        unknown_financial_exposure: attempt.unknown_financial_exposure,
        design_version_id: version.design_version_id,
        design_sha256: version.design_hash,
        artifact_id: version.artifact.artifact_id,
        artifact_sha256: version.artifact.content_hash,
        artifact_media_type: version.artifact.media_type,
        storage_commit_ref: attempt.publication.storage_commit_ref,
        lineage_evidence_ref: attempt.publication.lineage_evidence_ref,
      });
      nextSlot.status = "succeeded";
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "cancel_concept": {
      if (["succeeded", "cancelled"].includes(nextSlot.status)) fail("terminal_state_immutable", "event.concept_id", "Completed and cancelled concept histories are immutable.");
      if (nextSlot.current_billable_attempt_id !== null) {
        const attempt = nextSlot.attempts.find((item) => item.billable_attempt_id === nextSlot.current_billable_attempt_id);
        if (event.billable_attempt_id !== attempt.billable_attempt_id || event.transport_attempt_id !== attempt.transport_attempt_id) {
          fail("attempt_identity_mismatch", "event.billable_attempt_id", "Cancellation must bind the current reserved or dispatched attempt identity.");
        }
        attempt.cancelled = true;
        if (["dispatching", "response_received", "staged", "unknown"].includes(nextSlot.status)) {
          attempt.unknown_financial_exposure = true;
          attempt.financial_exposure_status = "unknown_hold";
          if (attempt.status === "dispatching") attempt.status = "unknown";
        }
        if (attempt.status === "reserved") attempt.status = "cancelled_before_dispatch";
      } else if (event.billable_attempt_id !== undefined || event.transport_attempt_id !== undefined) {
        fail("attempt_identity_mismatch", "event.billable_attempt_id", "Cancellation without an attempt cannot claim a billable or transport identity.");
      }
      nextSlot.status = "cancelled";
      nextSlot.cancellation_event_id = event.event_id;
      nextSlot.cancellation_evidence_ref = nonEmpty(event.cancellation_evidence_ref, "event.cancellation_evidence_ref");
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "late_provider_evidence": {
      if (nextSlot.status !== "cancelled") fail("late_evidence_state_conflict", "event.concept_id", "Late provider evidence is accepted only as append-only evidence for a cancelled slot.");
      const attempt = eventRelatedAttempt(nextSlot, event);
      if (!["succeeded", "failed", "unknown"].includes(event.outcome)) fail("invalid_outcome", "event.outcome", "Late evidence must report a provider outcome without changing cancellation.");
      const evidence = Object.freeze({
        billable_attempt_id: attempt.billable_attempt_id,
        transport_attempt_id: attempt.transport_attempt_id,
        outcome: event.outcome,
        outcome_evidence_ref: nonEmpty(event.outcome_evidence_ref, "event.outcome_evidence_ref"),
        provider_request_id: event.provider_request_id === undefined ? null : nonEmpty(event.provider_request_id, "event.provider_request_id"),
        artifact_sha256: event.artifact_sha256 === undefined ? null : hash(event.artifact_sha256, "event.artifact_sha256"),
        usage_evidence_ref: nonEmpty(event.usage_evidence_ref, "event.usage_evidence_ref"),
        usage_completeness: event.usage_completeness,
      });
      if (!["complete", "partial", "unknown"].includes(evidence.usage_completeness)) fail("invalid_usage_completeness", "event.usage_completeness", "Usage completeness must preserve complete, partial, or unknown status.");
      attempt.provider_observations.push(Object.freeze({ event_id: event.event_id, ...evidence, publication_suppressed: true }));
      attempt.usage_evidence_refs.push(evidence.usage_evidence_ref);
      attempt.unknown_financial_exposure = true;
      attempt.financial_exposure_status = "unknown_hold";
      nextSlot.late_evidence.push(Object.freeze({ event_id: event.event_id, billable_attempt_id: attempt.billable_attempt_id, outcome: evidence.outcome }));
      appendEvent(next, event, canonicalHash(event));
      return Object.freeze({ status: "applied", batch: freezeDeep(next) });
    }
    case "cancel_batch":
      fail("unsupported_event", "event.event_type", "Batch cancellation is reserved for the later shared job/lease integration.");
    default:
      fail("unsupported_event", "event.event_type", `Unsupported concept event ${String(event.event_type)}.`);
  }
}

function copyBytes(value, maximumBytes) {
  if (!(value instanceof Uint8Array)) fail("invalid_image_bytes", "bytes", "Image bytes must be supplied as a Uint8Array from the trusted asset/provider boundary.");
  let buffer;
  let byteOffset;
  let byteLength;
  try {
    buffer = Reflect.apply(TYPED_ARRAY_BUFFER, value, []);
    byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET, value, []);
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []);
  } catch {
    fail("invalid_image_bytes", "bytes", "Image bytes must be a valid typed-array view.");
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > maximumBytes) {
    fail("image_bytes_out_of_bounds", "bytes", "Image bytes are empty or exceed the supplied host-owned byte bound.");
  }
  try {
    const snapshot = Buffer.allocUnsafe(byteLength);
    snapshot.set(new Uint8Array(buffer, byteOffset, byteLength));
    return snapshot;
  } catch {
    fail("invalid_image_bytes", "bytes", "Image bytes could not be snapshotted safely.");
  }
}

export async function inspectCreativeConceptImageBytes(input) {
  record(input, "input");
  const maximumBytes = integer(input.maximum_bytes, "maximum_bytes");
  const mediaType = nonEmpty(input.expected_media_type, "expected_media_type");
  if (!Object.values(FORMATS).includes(mediaType)) fail("unsupported_media_type", "expected_media_type", "Only PNG, JPEG, and WebP media types are supported.");
  const bytes = copyBytes(input.bytes, maximumBytes);
  let decoded;
  try {
    decoded = await inspectOpenAIImageBytes(bytes);
  } catch (error) {
    fail("image_inspection_failed", "bytes", `The existing native image codec rejected the candidate bytes (${String(error?.code ?? "decode_error")}).`);
  }
  if (FORMATS[decoded.format] !== mediaType) fail("image_media_type_mismatch", "expected_media_type", "The native decoded image format does not match the supplied media type.");
  if (input.expected_dimensions !== undefined) {
    record(input.expected_dimensions, "expected_dimensions");
    if (input.expected_dimensions.width !== decoded.width || input.expected_dimensions.height !== decoded.height) {
      fail("image_dimensions_mismatch", "expected_dimensions", "The native image dimensions do not match the explicit expected dimensions.");
    }
  }
  return freezeDeep({
    content_sha256: hashArtifactBytes(bytes),
    media_type: mediaType,
    format: decoded.format,
    width: decoded.width,
    height: decoded.height,
    byte_length: bytes.byteLength,
  });
}

export async function inspectCreativeConceptReferenceBytes(batch, resolvedReferences) {
  record(batch, "batch");
  if (batch.contract !== CREATIVE_CONCEPT_PROPOSAL.contract || !supportedConceptSchemaVersion(batch.schema_version)) {
    fail("unsupported_batch_version", "batch", "Reference-byte checks require an explicitly supported local proposal version.");
  }
  if (!Array.isArray(resolvedReferences) || resolvedReferences.length !== batch.references.length) {
    fail("reference_set_mismatch", "resolved_references", "The trusted resolver must return exactly one byte buffer for each ordered authorized asset.");
  }
  let aggregateBytes = 0;
  const inspected = [];
  for (const [index, reference] of batch.references.entries()) {
    const resolved = record(resolvedReferences[index], `resolved_references[${index}]`);
    if (resolved.asset_id !== reference.asset_id) fail("reference_order_mismatch", `resolved_references[${index}].asset_id`, "Resolved reference bytes must retain the authorized ordered asset identity.");
    const metadata = await inspectCreativeConceptImageBytes({
      bytes: resolved.bytes,
      expected_media_type: reference.media_type,
      maximum_bytes: batch.policy_snapshot.maximum_single_reference_bytes,
    });
    if (metadata.content_sha256 !== reference.content_hash) fail("reference_hash_mismatch", `resolved_references[${index}].bytes`, "Resolved bytes do not match the exact authorized package hash.");
    aggregateBytes += metadata.byte_length;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > batch.policy_snapshot.maximum_aggregate_reference_bytes) {
      fail("reference_bytes_out_of_bounds", "resolved_references", "The resolved reference set exceeds its supplied aggregate byte bound.");
    }
    inspected.push(Object.freeze({
      asset_id: reference.asset_id,
      source_ref: reference.source_ref,
      role_ref: reference.role_ref,
      content_sha256: metadata.content_sha256,
      media_type: metadata.media_type,
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      byte_length: metadata.byte_length,
      permission_evidence_ref: reference.permission_evidence_ref,
    }));
  }
  return freezeDeep({ references: inspected, aggregate_byte_length: aggregateBytes });
}
