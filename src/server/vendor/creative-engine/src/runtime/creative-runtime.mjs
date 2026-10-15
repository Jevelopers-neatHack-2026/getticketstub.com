import { Buffer } from "node:buffer";
import {
  ContractError,
  canonicalHash,
  canonicalSerialize,
  validateCreativeBrief,
  validateDesignVersion,
  validateEditPlan,
  computeDesignVersionHash,
} from "../contracts/index.mjs";
import { validateUsageObservation } from "../contracts/metering.mjs";
import { OpenAIImagesProviderError, inspectOpenAIImageBytes, readPrivateOpenAIImageRetryDisposition,
  readPrivateOpenAIImageTargetBindingSha256 } from "../models/openai-images.mjs";
import {
  validateDecisionRequest,
  validateDecisionResult,
  decisionExecutionTarget,
  decisionExecutionTargetHash,
  PINNED_JEV_MODEL_ID,
} from "../contracts/decision-port/v1.mjs";
import {
  ApprovalHandoffContractError,
  createCompositionEditPlan,
  createArtworkHandoff,
  hashCompositionLayerManifest,
  validateArtworkHandoff,
  validateApprovalBinding,
  validateConsumptionReceipt,
  verifyHandoffApproval,
} from "../contracts/approval-handoff.mjs";
import {
  CreativeCompositionContractError,
  applyCompositionPlan,
  compositionPreviewHash,
  compositionStateHash,
  createCompositionProductionEnvelope,
  createCompositionRevision,
  snapshotCompositionBytesRecord,
  snapshotCompositionJson,
  validateCompositionProductionEnvelope,
  validateCompositionRevision,
} from "../contracts/composition-authority.mjs";
import { MeteringContractError, METERING_PROPOSAL_VERSION } from "../contracts/metering.mjs";
import {
  createUsageObservation,
  executeCreativeMeteredAttempt,
  projectPublicTelemetry,
  TelemetryBoundaryError,
  USAGE_PROFILE,
} from "../telemetry/index.mjs";
import { assertSafePublicIdentifier } from "../telemetry/privacy.mjs";
import { hashArtifactBytes } from "../storage/content-addressed.mjs";
import { buildCreativeBrief, CreativePlanningError } from "../planning/index.mjs";
import { normalizeResearchPackage } from "../contracts/creative/v1.mjs";
import {
  canonicalInspectionSubjectHash,
  copyInspectionArtifactBytes,
  createInspectionDecisionPlan,
  createInspectionEvidenceBatch,
  createInspectionReport,
  createInspectionRouteBatch,
  prepareInspectionDecisionPlan,
  prepareInspectionEvidenceBatch,
  prepareInspectionRouteBatch,
  bindInspectionDecisionReservation,
  createInspectionRoutingInput,
  deterministicDecisionObservation,
  evaluateInspectionDecision,
  inspectCreativeArtifact,
  REPAIR_LIMITS,
  validateVisualObservation,
} from "../inspection/index.mjs";
import { isSafePublicInspectionReference, snapshotPlainRecord } from "../inspection/deterministic.mjs";
import { INSPECTION_POLICY_VERSION, INSPECTION_QUESTION_SCHEMA_VERSION } from "../inspection/questions.mjs";
import {
  CREATIVE_CONCEPT_PROPOSAL,
  applyCreativeConceptEvent,
  createCreativeConceptBatchProposal,
  inspectCreativeConceptReferenceBytes,
  inspectCreativeConceptImageBytes,
  replayCreativeConceptBatch,
} from "../generation/concepts.mjs";
import { imageProviderRoute } from "../models/image-routes.mjs";

export const CREATIVE_API_VERSION = "1.0";
export const CREATIVE_API_VERSIONS = Object.freeze(["1.0", "1.1", "1.2", "1.3"]);
export const CREATIVE_API_OPERATIONS = Object.freeze([
  "generate", "edit", "concepts.create", "composition.create", "composition.get", "composition.update",
  "composition.history", "composition.revalidate",
  "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status",
  "brief.create", "brief.invalidate",
]);

const MUTATIONS = new Set(["generate", "edit", "concepts.create", "composition.create", "composition.update", "composition.revalidate",
  "inspect", "restore", "cancel", "handoff", "brief.create", "brief.invalidate"]);
const READ_OPERATIONS = new Set(["list", "compare", "job.status", "composition.get", "composition.history"]);
const OPERATION_PERMISSION = Object.freeze({
  generate: "creative.generate",
  edit: "creative.edit",
  "concepts.create": "creative.generate",
  "composition.create": "creative.edit",
  "composition.get": "creative.read",
  "composition.update": "creative.edit",
  "composition.history": "creative.read",
  "composition.revalidate": "creative.edit",
  inspect: "creative.read",
  list: "creative.read",
  compare: "creative.read",
  restore: "creative.restore",
  cancel: "creative.cancel",
  handoff: "creative.handoff",
  "job.status": "creative.read",
  "brief.create": "creative.brief.create",
  "brief.invalidate": "creative.brief.invalidate",
});
const REQUEST_KEYS = [
  "contract", "schema_version", "event_id", "request_id", "tenant_id", "project_id",
  "correlation_id", "producer", "occurred_at", "ingested_at", "environment", "billing_mode",
  "source_refs", "operation", "action_id", "payload",
];
const REQUEST_CONTRACT = "CreativeApiRequest";
function responseVersionFor(request) {
  if (request?.operation === "concepts.create" && request?.schema_version === "1.1") return "1.1";
  if (request?.operation?.startsWith("composition.") && request?.schema_version === "1.3") return "1.3";
  if (request?.operation?.startsWith("composition.") && request?.schema_version === "1.2") return "1.2";
  return CREATIVE_API_VERSION;
}
const IMAGE_REFERENCE_MANIFEST_KEYS = Object.freeze([
  "contract", "schema_version", "tenant_id", "project_id", "brief_id", "brief_hash",
  "research_package_id", "research_package_hash", "base_design_version_id", "base_design_hash", "references",
]);
const IMAGE_REFERENCE_KEYS = Object.freeze([
  "source_ref", "asset_id", "content_hash", "media_type", "width", "height",
]);
const MAX_IMAGE_REFERENCES = 15;
const IMAGE_MIME_BY_FORMAT = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });
const ERROR_MESSAGES = Object.freeze({
  invalid_request: "The request does not match the supported API contract.",
  unsupported_version: "The requested API version is not supported.",
  unauthorized: "Trusted application context is missing or expired.",
  permission_denied: "The trusted application context does not allow this operation.",
  scope_denied: "The requested resource is outside the trusted project scope.",
  not_found: "The scoped resource was not found.",
  conflict: "The operation identity conflicts with an existing operation.",
  stale_version: "The requested design version is no longer current.",
  unavailable: "A required service is unavailable; no successful result was produced.",
  budget_unavailable: "The budget authority did not authorize this operation.",
  cancelled: "The operation was cancelled before publication.",
  review_required: "The requested action requires review before it can continue.",
  failed: "The operation could not be completed.",
});
const MAX_PORT_WAIT_MS = 30_000;
const DECISION_POLICY_VERSION = "creative-engine-decision/1";

export class CreativeApiError extends Error {
  constructor(code, operation = "unknown", field = "", options = {}) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.failed);
    this.name = "CreativeApiError";
    this.code = code;
    this.module = "creative-engine.api";
    this.operation = operation;
    this.field = field;
    this.retryable = Boolean(options.retryable);
    if (options.diagnostic_ref) this.diagnostic_ref = options.diagnostic_ref;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function immutableRequestSnapshot(value) {
  let nodes = 0;
  function copy(current, depth = 0) {
    nodes += 1;
    if (depth > 32 || nodes > 50_000) throw new CreativeApiError("invalid_request", "unknown", "request");
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    let prototype;
    let descriptors;
    try {
      prototype = Object.getPrototypeOf(current);
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      throw new CreativeApiError("invalid_request", "unknown", "request");
    }
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) throw new CreativeApiError("invalid_request", "unknown", "request");
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) {
        throw new CreativeApiError("invalid_request", "unknown", "request");
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
          throw new CreativeApiError("invalid_request", "unknown", "request");
        }
      }
      const result = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          throw new CreativeApiError("invalid_request", "unknown", "request");
        }
        result[index] = copy(descriptor.value, depth + 1);
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CreativeApiError("invalid_request", "unknown", "request");
    }
    const result = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new CreativeApiError("invalid_request", "unknown", "request");
      }
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1), enumerable: true, configurable: false, writable: false,
      });
    }
    return result;
  }
  const snapshot = copy(value);
  const freeze = (current) => {
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(snapshot);
}

function boundedString(value, field, max = 200) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new CreativeApiError("invalid_request", "unknown", field);
  }
  return value;
}

const SENSITIVE_PUBLIC_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/i,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret|password|authorization|credential|cookie)\s*[:=]\s*["']?[^\s"'&,;]+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/i,
  /https?:\/\/[^\s"'<>]+[?&][^=\s&#]*(?:signature|sig|token|credential|secret|access[_-]?key|auth)[^=\s&#]*=[^&#\s]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/,
];

const BASIC_AUTH_CANDIDATE = /\bBasic[\t ]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi;
const MAX_BASIC_AUTH_TOKEN_CHARS = 8192;

function hasBasicAuthMaterial(value) {
  BASIC_AUTH_CANDIDATE.lastIndex = 0;
  let match;
  while ((match = BASIC_AUTH_CANDIDATE.exec(value)) !== null) {
    const token = match[1];
    const unpadded = token.replace(/=+$/, "");
    if (unpadded.length % 4 === 1) continue;
    if (token.length > MAX_BASIC_AUTH_TOKEN_CHARS) return true;
    const decoded = Buffer.from(token, "base64");
    const canonical = decoded.toString("base64");
    if (canonical !== token && canonical.replace(/=+$/, "") !== token) continue;
    const colon = decoded.indexOf(0x3a);
    if (colon < 0 || [...decoded].some((byte) => byte < 0x20 || byte === 0x7f)) continue;
    return true;
  }
  return false;
}

function hasSensitivePublicText(value) {
  return hasBasicAuthMaterial(value) || SENSITIVE_PUBLIC_TEXT.some((pattern) => pattern.test(value));
}

const SENSITIVE_PUBLIC_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|credential|authorization|cookie|raw[_-]?response)/i;

function publicIdentifier(value, field, operation, max = 512) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || hasSensitivePublicText(value)) {
    throw new CreativeApiError("unavailable", operation, field);
  }
  return value;
}

function projectPublicIdentifiers(value, operation, path = "response", depth = 0) {
  if (depth > 32) throw new CreativeApiError("unavailable", operation, "result");
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => projectPublicIdentifiers(item, operation, `${path}[${index}]`, depth + 1)));
  }
  if (typeof value === "string") {
    if (hasSensitivePublicText(value)) throw new CreativeApiError("unavailable", operation, path);
    return value;
  }
  if (!isRecord(value)) return value;
  const projected = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_PUBLIC_FIELD.test(key) || hasSensitivePublicText(key)) {
      throw new CreativeApiError("unavailable", operation, safeFieldPath(path) || "result");
    }
    const field = `${path}.${key}`;
    const projectedValue = projectPublicIdentifiers(item, operation, field, depth + 1);
    Object.defineProperty(projected, key, { value: projectedValue, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(projected);
}

function assertPublicIdentifiers(value, operation, path = "response", depth = 0) {
  if (depth > 32) throw new CreativeApiError("unavailable", operation, "result");
  if (typeof value === "string") {
    if (hasSensitivePublicText(value)) throw new CreativeApiError("unavailable", operation, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicIdentifiers(item, operation, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_PUBLIC_FIELD.test(key) || hasSensitivePublicText(key)) {
      throw new CreativeApiError("unavailable", operation, safeFieldPath(path) || "result");
    }
    const field = `${path}.${key}`;
    assertPublicIdentifiers(item, operation, field, depth + 1);
  }
}

function publicReference(value, field, operation, max = 512) {
  publicIdentifier(value, field, operation, max);
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new CreativeApiError("unavailable", operation, field);
  }
  return value;
}

function traceReference(value) {
  return typeof value === "string" && value.length <= 200 &&
    /^[A-Za-z0-9_.:-]+$/.test(value) && !hasSensitivePublicText(value) ? value : undefined;
}

function safeTraceEvent(event) {
  const safe = {
    event: ["creative_api.request", "creative_api.completed", "creative_api.rejected"].includes(event.event)
      ? event.event : "creative_api.rejected",
    operation: CREATIVE_API_OPERATIONS.includes(event.operation) ? event.operation : "unknown",
  };
  for (const field of ["request_id", "operation_id", "tenant_id", "project_id", "actor_id"]) {
    const value = traceReference(event[field]);
    if (value !== undefined) safe[field] = value;
  }
  if (Object.hasOwn(ERROR_MESSAGES, event.code)) safe.code = event.code;
  return Object.freeze(safe);
}

function inspectionText(value, field, max, operation, stored = false) {
  const valid = typeof value === "string" && value.trim() !== "" && value.length <= max;
  if (!valid || hasSensitivePublicText(value)) {
    throw new CreativeApiError(stored ? "unavailable" : "failed", operation, field);
  }
  return value;
}

function timestampMillis(value) {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function validatedReceiptTime(receipt, trustedNow, operation, stored = false) {
  const consumedAt = isRecord(receipt) ? timestampMillis(receipt.consumed_at) : null;
  const nowMillis = trustedNow instanceof Date ? trustedNow.getTime() : NaN;
  if (consumedAt === null || !Number.isFinite(nowMillis) || consumedAt > nowMillis) {
    throw new CreativeApiError(stored ? "unavailable" : "failed", operation, "receipt.consumed_at");
  }
  return new Date(consumedAt);
}

function assertReceiptWindow(receipt, handoff, handoffCreatedAt, trustedNow, operation, stored = false) {
  const consumedAt = timestampMillis(receipt?.consumed_at);
  const createdAt = timestampMillis(handoffCreatedAt);
  const issuedAt = timestampMillis(handoff?.approval?.issued_at);
  const expiresAt = timestampMillis(handoff?.approval?.expires_at);
  const nowMillis = trustedNow instanceof Date ? trustedNow.getTime() : NaN;
  if (consumedAt === null || createdAt === null || issuedAt === null || expiresAt === null ||
    !Number.isFinite(nowMillis) || createdAt > nowMillis || consumedAt > nowMillis ||
    issuedAt > createdAt || consumedAt < createdAt || consumedAt < issuedAt || consumedAt >= expiresAt) {
    throw new CreativeApiError(stored ? "unavailable" : "failed", operation, "receipt.consumed_at");
  }
}

function assertOnlyKeys(value, allowed, field) {
  if (!isRecord(value)) throw new CreativeApiError("invalid_request", "unknown", field);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CreativeApiError("invalid_request", "unknown", field);
  }
}

function assertStoredOnlyKeys(value, allowed, operation, field) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CreativeApiError("unavailable", operation, field);
  }
}

function trustedString(value, field, max = 200) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new CreativeApiError("unauthorized", "unknown", field);
  }
  return value;
}

function validatePrincipal(principal, now) {
  if (!isRecord(principal)) throw new CreativeApiError("unauthorized");
  const actor_id = trustedString(principal.actor_id, "actor_id");
  const tenant_id = trustedString(principal.tenant_id, "tenant_id");
  const project_id = trustedString(principal.project_id, "project_id");
  const expires_at = trustedString(principal.expires_at, "expires_at", 40);
  const budget_scope_id = trustedString(principal.budget_scope_id, "budget_scope_id");
  const budget_policy_version = trustedString(principal.budget_policy_version, "budget_policy_version");
  const expiry = Date.parse(expires_at);
  if (!Number.isFinite(expiry) || expiry <= now) throw new CreativeApiError("unauthorized");
  if (!Array.isArray(principal.permissions) || principal.permissions.length > 64 ||
    principal.permissions.some((permission) => typeof permission !== "string" || permission.length > 100)) {
    throw new CreativeApiError("unauthorized");
  }
  return Object.freeze({ actor_id, tenant_id, project_id, expires_at, budget_scope_id, budget_policy_version,
    permissions: [...new Set(principal.permissions)] });
}

function validateImageReferenceManifestShape(value) {
  if (value === undefined) return undefined;
  const operation = "edit";
  if (!isRecord(value)) throw new CreativeApiError("invalid_request", operation, "image_reference_manifest");
  assertOnlyKeys(value, IMAGE_REFERENCE_MANIFEST_KEYS, "image_reference_manifest");
  if (value.contract !== "CreativeImageReferenceManifest" || value.schema_version !== "1.0") {
    throw new CreativeApiError("unsupported_version", operation, "image_reference_manifest.schema_version");
  }
  for (const key of ["tenant_id", "project_id", "brief_id", "research_package_id", "base_design_version_id"]) {
    boundedString(value[key], `image_reference_manifest.${key}`, 256);
  }
  for (const key of ["brief_hash", "research_package_hash", "base_design_hash"]) {
    if (typeof value[key] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value[key])) {
      throw new CreativeApiError("invalid_request", operation, `image_reference_manifest.${key}`);
    }
  }
  if (!Array.isArray(value.references) || value.references.length < 1 || value.references.length > MAX_IMAGE_REFERENCES) {
    throw new CreativeApiError("invalid_request", operation, "image_reference_manifest.references");
  }
  const sourceRefs = new Set();
  const assetIds = new Set();
  for (let index = 0; index < value.references.length; index += 1) {
    const reference = value.references[index];
    const field = `image_reference_manifest.references[${index}]`;
    if (!isRecord(reference)) throw new CreativeApiError("invalid_request", operation, field);
    assertOnlyKeys(reference, IMAGE_REFERENCE_KEYS, field);
    boundedString(reference.source_ref, `${field}.source_ref`, 300);
    boundedString(reference.asset_id, `${field}.asset_id`, 256);
    if (typeof reference.content_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(reference.content_hash) ||
        !["image/png", "image/jpeg", "image/webp"].includes(reference.media_type) ||
        !Number.isSafeInteger(reference.width) || reference.width < 1 || reference.width > 4096 ||
        !Number.isSafeInteger(reference.height) || reference.height < 1 || reference.height > 4096 ||
        reference.width * reference.height > 16_777_216) {
      throw new CreativeApiError("invalid_request", operation, field);
    }
    if (sourceRefs.has(reference.source_ref) || assetIds.has(reference.asset_id)) {
      throw new CreativeApiError("invalid_request", operation, "image_reference_manifest.references");
    }
    sourceRefs.add(reference.source_ref);
    assetIds.add(reference.asset_id);
  }
  return value;
}

function validateRequest(request) {
  assertOnlyKeys(request, REQUEST_KEYS, "request");
  if (request.contract !== REQUEST_CONTRACT) throw new CreativeApiError("invalid_request", "unknown", "contract");
  if (!CREATIVE_API_VERSIONS.includes(request.schema_version)) {
    throw new CreativeApiError("unsupported_version", "unknown", "schema_version");
  }
  boundedString(request.event_id, "event_id");
  boundedString(request.request_id, "request_id");
  boundedString(request.tenant_id, "tenant_id");
  boundedString(request.project_id, "project_id");
  boundedString(request.correlation_id, "correlation_id");
  boundedString(request.producer, "producer");
  for (const key of ["occurred_at", "ingested_at"]) {
    boundedString(request[key], key, 40);
    if (!/^\d{4}-\d\d-\d\dT/.test(request[key]) || !Number.isFinite(Date.parse(request[key]))) {
      throw new CreativeApiError("invalid_request", "unknown", key);
    }
  }
  if (!['development', 'test', 'production'].includes(request.environment) ||
    !['live', 'sandbox', 'simulated'].includes(request.billing_mode)) {
    throw new CreativeApiError("invalid_request", "unknown", "environment_or_billing_mode");
  }
  if (!Array.isArray(request.source_refs) || request.source_refs.length > 100 ||
    request.source_refs.some((ref) => typeof ref !== "string" || ref.length === 0 || ref.length > 300)) {
    throw new CreativeApiError("invalid_request", "unknown", "source_refs");
  }
  if (new Set(request.source_refs).size !== request.source_refs.length) {
    throw new CreativeApiError("invalid_request", "unknown", "source_refs");
  }
  if (!CREATIVE_API_OPERATIONS.includes(request.operation)) throw new CreativeApiError("invalid_request", "unknown", "operation");
  const expectedVersion = request.operation === "concepts.create" ? "1.1"
    : ["composition.history", "composition.revalidate"].includes(request.operation) ? "1.3"
      : request.operation.startsWith("composition.") ? "1.2" : "1.0";
  if (request.schema_version !== expectedVersion) {
    throw new CreativeApiError("unsupported_version", request.operation, "schema_version");
  }
  if (MUTATIONS.has(request.operation)) boundedString(request.action_id, "action_id");
  if (request.action_id !== undefined && (typeof request.action_id !== "string" || request.action_id.length > 200)) {
    throw new CreativeApiError("invalid_request", request.operation, "action_id");
  }
  if (!isRecord(request.payload)) throw new CreativeApiError("invalid_request", request.operation, "payload");
  const allowedPayloadKeys = {
    generate: ["brief_id", "plan", "decision_request"],
    edit: ["brief_id", "design_version_id", "plan", "selection_mode", "decision_request", "image_reference_manifest",
      "inspection_repair"],
    "concepts.create": ["brief_id", "plan_id", "requested_count", "references"],
    "composition.create": ["brief_id", "design_version_id"],
    "composition.get": ["brief_id", "design_version_id"],
    "composition.update": ["brief_id", "design_version_id", "plan"],
    "composition.history": ["brief_id", "design_version_id", "limit", "after_revision_id"],
    "composition.revalidate": ["brief_id", "design_version_id", "expected_current_revision_id",
      "expected_current_revision_sha256", "candidate_revision_id"],
    inspect: ["brief_id", "design_version_id"],
    list: ["brief_id", "limit", "cursor"],
    compare: ["brief_id", "left_design_version_id", "right_design_version_id"],
    restore: ["brief_id", "target_design_version_id", "expected_selection_revision"],
    cancel: ["job_id"],
    handoff: ["brief_id", "design_version_id", "approval_ref", "destination_ref"],
    "job.status": ["job_id"],
    "brief.create": ["customer_preferences", "artistic_intent", "additional_required_fact_keys", "fact_corrections",
      "locked_fields", "expected_brief_hash"],
    "brief.invalidate": ["event_id"],
  }[request.operation];
  assertOnlyKeys(request.payload, allowedPayloadKeys, "payload");
  if (READ_OPERATIONS.has(request.operation) || request.operation === "cancel" || request.operation === "handoff") {
    if (Object.keys(request.payload).length === 0) throw new CreativeApiError("invalid_request", request.operation, "payload");
  }
  const requiredPayload = {
    generate: ["brief_id", "plan"],
    edit: ["brief_id", "design_version_id", "plan"],
    "concepts.create": ["brief_id", "plan_id", "requested_count", "references"],
    "composition.create": ["brief_id", "design_version_id"],
    "composition.get": ["brief_id", "design_version_id"],
    "composition.update": ["brief_id", "design_version_id", "plan"],
    "composition.history": ["brief_id", "design_version_id"],
    "composition.revalidate": ["brief_id", "design_version_id", "expected_current_revision_id",
      "expected_current_revision_sha256", "candidate_revision_id"],
    inspect: ["brief_id", "design_version_id"],
    list: ["brief_id"],
    compare: ["brief_id", "left_design_version_id", "right_design_version_id"],
    restore: ["brief_id", "target_design_version_id", "expected_selection_revision"],
    cancel: ["job_id"],
    handoff: ["brief_id", "design_version_id", "approval_ref", "destination_ref"],
    "job.status": ["job_id"],
    "brief.create": [],
    "brief.invalidate": ["event_id"],
  }[request.operation];
  for (const key of requiredPayload) {
    if (!Object.prototype.hasOwnProperty.call(request.payload, key)) throw new CreativeApiError("invalid_request", request.operation, key);
  }
  if (request.operation === "concepts.create") {
    boundedString(request.payload.plan_id, "payload.plan_id", 200);
    if (!Number.isSafeInteger(request.payload.requested_count) || request.payload.requested_count < 1 ||
        request.payload.requested_count > 2 || !Array.isArray(request.payload.references) ||
        request.payload.references.length !== 2) {
      throw new CreativeApiError("invalid_request", request.operation, "payload.requested_count");
    }
    const assets = new Set();
    for (const [index, reference] of request.payload.references.entries()) {
      assertOnlyKeys(reference, ["asset_id", "role_ref"], `payload.references[${index}]`);
      boundedString(reference.asset_id, `payload.references[${index}].asset_id`, 256);
      boundedString(reference.role_ref, `payload.references[${index}].role_ref`, 256);
      if (assets.has(reference.asset_id)) throw new CreativeApiError("invalid_request", request.operation, "payload.references");
      assets.add(reference.asset_id);
    }
  }
  if (request.operation === "restore" && (!Number.isSafeInteger(request.payload.expected_selection_revision) ||
    request.payload.expected_selection_revision < 0)) {
    throw new CreativeApiError("invalid_request", request.operation, "payload.expected_selection_revision");
  }
  if (request.operation === "list" && request.payload.cursor !== undefined &&
    (typeof request.payload.cursor !== "string" || request.payload.cursor.length > 1024)) {
    throw new CreativeApiError("invalid_request", request.operation, "cursor");
  }
  if (request.operation === "composition.history" && request.payload.after_revision_id !== undefined) {
    boundedString(request.payload.after_revision_id, "payload.after_revision_id");
  }
  if (request.operation === "composition.revalidate") {
    for (const key of ["expected_current_revision_id", "candidate_revision_id"]) {
      boundedString(request.payload[key], `payload.${key}`);
    }
    if (request.payload.expected_current_revision_id === request.payload.candidate_revision_id ||
        typeof request.payload.expected_current_revision_sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(request.payload.expected_current_revision_sha256)) {
      throw new CreativeApiError("invalid_request", request.operation, "payload.expected_current");
    }
  }
  if (request.operation === "brief.create" && request.payload.expected_brief_hash !== undefined &&
    (typeof request.payload.expected_brief_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(request.payload.expected_brief_hash))) {
    throw new CreativeApiError("invalid_request", request.operation, "payload.expected_brief_hash");
  }
  if (request.operation === "brief.invalidate") boundedString(request.payload.event_id, "payload.event_id");
  for (const key of ["brief_id", "design_version_id", "left_design_version_id", "right_design_version_id",
    "target_design_version_id", "job_id", "approval_ref", "destination_ref"]) {
    if (Object.prototype.hasOwnProperty.call(request.payload, key)) boundedString(request.payload[key], "payload." + key);
  }
  if ((request.operation === "generate" || request.operation === "edit") && !isRecord(request.payload.plan)) {
    throw new CreativeApiError("invalid_request", request.operation, "plan");
  }
  if (request.payload.decision_request !== undefined && !isRecord(request.payload.decision_request)) {
    throw new CreativeApiError("invalid_request", request.operation, "decision_request");
  }
  if (request.operation === "edit" && request.payload.selection_mode !== undefined &&
    !["advance", "branch"].includes(request.payload.selection_mode)) {
    throw new CreativeApiError("invalid_request", request.operation, "selection_mode");
  }
  if (request.operation === "edit" && request.payload.inspection_repair !== undefined) {
    const repair = request.payload.inspection_repair;
    assertOnlyKeys(repair, ["contract", "schema_version", "inspection_action_id", "report_hash", "repair_action"],
      "payload.inspection_repair");
    if (!isRecord(repair) || repair.contract !== "CreativeInspectionRepairRequest" || repair.schema_version !== "1.0" ||
      typeof repair.inspection_action_id !== "string" || repair.inspection_action_id.length < 1 || repair.inspection_action_id.length > 200 ||
      typeof repair.report_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(repair.report_hash) ||
      repair.repair_action !== "image.edit") {
      throw new CreativeApiError("invalid_request", request.operation, "payload.inspection_repair");
    }
    boundedString(repair.inspection_action_id, "payload.inspection_repair.inspection_action_id", 200);
  }
  if (request.operation === "edit") validateImageReferenceManifestShape(request.payload.image_reference_manifest);
  if (request.payload.limit !== undefined && (!Number.isSafeInteger(request.payload.limit) || request.payload.limit < 1 || request.payload.limit > 100)) {
    throw new CreativeApiError("invalid_request", request.operation, "limit");
  }
  return request;
}

function scopeFor(principal, brief_id) {
  return Object.freeze({
    tenant_id: principal.tenant_id,
    project_id: principal.project_id,
    ...(brief_id ? { brief_id } : {}),
  });
}

function assertRequestScope(principal, request) {
  if (request.tenant_id !== principal.tenant_id || request.project_id !== principal.project_id) {
    throw new CreativeApiError("scope_denied", request.operation);
  }
  if (!principal.permissions.includes(OPERATION_PERMISSION[request.operation])) {
    throw new CreativeApiError("permission_denied", request.operation);
  }
}

function assertScopedRecord(record, scope, operation, expectedBriefId) {
  if (!isRecord(record)) throw new CreativeApiError("failed", operation);
  if (record.tenant_id !== scope.tenant_id || record.project_id !== scope.project_id ||
    (expectedBriefId && record.brief_id !== expectedBriefId)) {
    throw new CreativeApiError("scope_denied", operation);
  }
}

function publicJob(job, operation_id) {
  if (!isRecord(job) || !["queued", "running", "completed", "cancelled", "failed"].includes(job.status)) {
    throw new CreativeApiError("unavailable", "unknown");
  }
  const job_id = publicReference(job.job_id, "job_id", job.operation, 256);
  if (operation_id !== undefined) publicReference(operation_id, "operation_id", job.operation, 256);
  const result_ref = job.result_ref === undefined ? undefined
    : publicReference(job.result_ref, "result_ref", job.operation, 512);
  return projectPublicIdentifiers(Object.freeze({
    contract: "CreativeJob",
    schema_version: "1.0",
    operation_id,
    job_id,
    status: job.status,
    ...(result_ref ? { result_ref } : {}),
    ...(job.error ? { error: safeStoredJobError(job.error, job.operation) } : {}),
  }), job.operation ?? "unknown", "job");
}

async function validateTelemetryEvidenceStatus(value, operation, expected = {}, evidenceOutbox) {
  const legacyEvidenceStatus = async () => {
    if (!isRecord(evidenceOutbox) || typeof evidenceOutbox.hasAttemptEvidence !== "function") {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    let status;
    try {
      status = await evidenceOutbox.hasAttemptEvidence({
        tenant_id: expected.tenant_id,
        project_id: expected.project_id,
        budget_scope_id: expected.budget_scope_id,
        logical_operation_id: expected.logical_operation_id,
        billable_attempt_id: expected.billable_attempt_id,
      });
    } catch {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    if (status !== "not_found") {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    // Pre-integration jobs have no local evidence records. This status makes
    // that absence explicit without claiming any sink or owner acceptance.
    return Object.freeze({ local_status: "unknown" });
  };
  if (value === undefined) return await legacyEvidenceStatus();
  if (!isRecord(value)) throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
  assertStoredOnlyKeys(value, ["local_status", "pending_event_id", "pending_event_staged", "pending_event", "pending_event_hash"],
    operation, "stored_result.telemetry_evidence");
  if (!["recorded", "duplicate", "pending", "unknown"].includes(value.local_status)) {
    throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
  }
  if (value.local_status === "unknown") {
    if (value.pending_event_id !== undefined || value.pending_event_staged !== undefined ||
      value.pending_event !== undefined || value.pending_event_hash !== undefined) {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    return await legacyEvidenceStatus();
  }
  if (value.local_status !== "pending") {
    if (value.pending_event_id !== undefined || value.pending_event_staged !== undefined ||
      value.pending_event !== undefined || value.pending_event_hash !== undefined) {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    return Object.freeze({ local_status: value.local_status });
  }
  publicIdentifier(value.pending_event_id, "stored_result.telemetry_evidence.pending_event_id", operation, 256);
  if (typeof value.pending_event_staged !== "boolean") {
    throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
  }
  if (value.pending_event_staged) {
    if (value.pending_event !== undefined || value.pending_event_hash !== undefined) {
      throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
    }
    return Object.freeze({ local_status: "pending", pending_event_id: value.pending_event_id,
      pending_event_staged: true });
  }
  const event = value.pending_event;
  if (!isRecord(event) || event.schema_version !== "creative.telemetry.evidence/v1" ||
    event.event_type !== "attempt_outcome" || event.event_id !== value.pending_event_id ||
    typeof value.pending_event_hash !== "string" || canonicalHash(event) !== value.pending_event_hash ||
    (expected.tenant_id !== undefined && event.tenant_id !== expected.tenant_id) ||
    (expected.project_id !== undefined && event.project_id !== expected.project_id) ||
    (expected.budget_scope_id !== undefined && event.budget_scope_id !== expected.budget_scope_id) ||
    (expected.logical_operation_id !== undefined && event.logical_operation_id !== expected.logical_operation_id) ||
    (expected.billable_attempt_id !== undefined && event.billable_attempt_id !== expected.billable_attempt_id)) {
    throw new CreativeApiError("unavailable", operation, "stored_result.telemetry_evidence");
  }
  assertPublicIdentifiers(event, operation, "stored_result.telemetry_evidence.pending_event");
  return Object.freeze({ local_status: "pending", pending_event_id: value.pending_event_id,
    pending_event_staged: false, pending_event: event, pending_event_hash: value.pending_event_hash });
}

function safeDiagnosticRef(value, fallback) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) &&
    !hasSensitivePublicText(value) ? value : fallback;
}

function safeFieldPath(value) {
  if (typeof value !== "string" || value.length > 120 ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:\[\d+\])?(?:\.[A-Za-z][A-Za-z0-9_-]*(?:\[\d+\])?)*$/.test(value) ||
    /token|secret|credential|password|api[_-]?key|authorization|cookie|bearer/i.test(value) ||
    hasSensitivePublicText(value)) return "";
  return value;
}

function creativeContextFence(brief, design = null, expectedCurrentDesignVersionId = undefined,
  expectedCurrentDesignHash = design?.design_hash ?? null, extra = undefined) {
  return Object.freeze({
    brief_id: brief.brief_id,
    brief_hash: canonicalHash(brief),
    ...(design ? { design_version_id: design.design_version_id, design_hash: design.design_hash } : {}),
    ...(expectedCurrentDesignVersionId !== undefined ? {
      expected_current_design_version_id: expectedCurrentDesignVersionId,
      expected_current_design_hash: expectedCurrentDesignHash,
    } : {}),
    ...(isRecord(extra) ? extra : {}),
  });
}

function aggregateUsageCompleteness(stages) {
  if (!Array.isArray(stages) || stages.length === 0) return "unknown";
  const values = stages.map((stage) => isRecord(stage) ? stage.usage_completeness : stage);
  if (values.some((value) => !["complete", "partial", "unknown"].includes(value))) return "unknown";
  if (values.includes("unknown")) return "unknown";
  if (values.includes("partial")) return "partial";
  return "complete";
}

function usageUncertainty(completeness, extra = []) {
  return Object.freeze([...new Set([
    ...(completeness === "unknown" ? ["unknown_cost"] : completeness === "partial" ? ["usage_incomplete"] : []),
    ...extra,
  ])]);
}

function safeStoredJobError(error, operation) {
  if (!isRecord(error) || !Object.hasOwn(ERROR_MESSAGES, error.code)) {
    throw new CreativeApiError("unavailable", operation ?? "unknown");
  }
  const field = safeFieldPath(error.field);
  return Object.freeze({
    code: error.code,
    operation: CREATIVE_API_OPERATIONS.includes(operation) ? operation : "unknown",
    module: "creative-engine.api",
    field,
    retryable: error.retryable === true,
    message: ERROR_MESSAGES[error.code],
    diagnostic_ref: safeDiagnosticRef(error.diagnostic_ref, `creative-api:${error.code}`),
  });
}

function normalizeUsage(value) {
  if (!isRecord(value) || !["complete", "partial", "incomplete", "unknown"].includes(value.completeness)) {
    return Object.freeze({ completeness: "unknown", reason: "usage_unavailable" });
  }
  const normalized = { completeness: value.completeness === "partial" ? "incomplete" : value.completeness };
  for (const field of ["input_tokens", "output_tokens"]) {
    if (value[field] === undefined) continue;
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      return Object.freeze({ completeness: "incomplete", reason: "usage_malformed" });
    }
    normalized[field] = value[field];
  }
  return Object.freeze(normalized);
}

function meteredTrustedScope(principal) {
  return Object.freeze({ tenant_id: principal.tenant_id, project_id: principal.project_id,
    budget_scope_id: principal.budget_scope_id });
}

function meteredAttempt(principal, request, attempt_id, operation_kind, route, logicalOperationId = request.action_id) {
  if (!isRecord(route) || !isRecord(route.provider) || typeof route.retry_mapping_ref !== "string") {
    throw new CreativeApiError("unavailable", request.operation, "provider_route");
  }
  const attempt = {
    schema_version: METERING_PROPOSAL_VERSION,
    ...meteredTrustedScope(principal),
    logical_operation_id: logicalOperationId,
    billable_attempt_id: attempt_id,
    retry_mapping_ref: route.retry_mapping_ref,
    environment: request.environment,
    billing_mode: request.billing_mode,
    operation_kind,
    budget: { scope_id: principal.budget_scope_id, policy_version: principal.budget_policy_version },
    provider: route.provider,
    correlation_id: request.correlation_id,
  };
  return attempt;
}

function startDeadline(operation, durationMs, clock = Date.now, maximumDeadlineAt) {
  const controller = new AbortController();
  const startedAt = clock();
  const requestedDeadline = maximumDeadlineAt === undefined ? startedAt + durationMs : Date.parse(maximumDeadlineAt);
  const deadlineTime = Math.min(startedAt + durationMs, requestedDeadline);
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineTime) || deadlineTime <= startedAt) {
    throw new CreativeApiError("cancelled", operation, "deadline");
  }
  const deadline_at = new Date(deadlineTime).toISOString();
  const timer = setTimeout(() => controller.abort(), deadlineTime - startedAt);
  return Object.freeze({
    signal: controller.signal,
    deadline_at,
    dispose: () => clearTimeout(timer),
  });
}

async function usageObservation({ attempt, trustedScope, rawUsage, profile, transportAttemptId, idFactory,
  usageProfileAuthority, targetBindingSha256, reservationRef, dispatchIntentRef, providerOutcome }) {
  const sourceObservationId = `usage:${idFactory()}`;
  const fallback = () => Object.freeze({ observation: createUsageObservation({
    attempt,
    trustedScope,
    usage: isRecord(rawUsage) ? rawUsage : {},
    profile,
    sourceObservationId,
    source: "provider_response",
    transportAttemptId,
  }) });
  if (typeof usageProfileAuthority?.mapProviderUsage !== "function" || !isRecord(rawUsage) ||
      typeof targetBindingSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(targetBindingSha256) ||
      typeof reservationRef !== "string" || typeof dispatchIntentRef !== "string") return fallback();

  const rawUsageSha256 = canonicalHash(rawUsage);
  const attemptBindingSha256 = canonicalHash({ attempt, trusted_scope: trustedScope, reservation_ref: reservationRef,
    dispatch_intent_ref: dispatchIntentRef, transport_attempt_id: transportAttemptId,
    target_binding_sha256: targetBindingSha256, provider_outcome: providerOutcome, source_observation_id: sourceObservationId });
  const profileInput = Object.freeze({ attempt, trustedScope, rawUsage, rawUsageSha256,
    targetBindingSha256, attemptBindingSha256, sourceObservationId, transportAttemptId, providerOutcome,
    reservationRef, dispatchIntentRef });
  let mapped;
  try { mapped = await usageProfileAuthority.mapProviderUsage(profileInput); }
  catch { return fallback(); }
  try {
    if (!isRecord(mapped) || mapped.status !== "mapped" ||
        typeof mapped.profile_ref !== "string" || typeof mapped.profile_sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(mapped.profile_sha256) ||
        mapped.raw_usage_sha256 !== rawUsageSha256 || mapped.target_binding_sha256 !== targetBindingSha256 ||
        mapped.attempt_binding_sha256 !== attemptBindingSha256) return fallback();
    assertSafePublicIdentifier(mapped.profile_ref, { maxLength: 256 });
    const rawMissing = Array.isArray(rawUsage.missing_fields) ? rawUsage.missing_fields : [];
    // Only the adapter's explicit profile-pending marker may be resolved by a
    // trusted owner map. Invalid or unmapped provider dimensions remain gaps.
    const unresolved = rawMissing.filter((field) => field !== "usage.profile_mapping_pending");
    if (unresolved.length > 0 && mapped.observation?.completeness === "complete") return fallback();
    const observation = validateUsageObservation(mapped.observation, attempt);
    if (observation.source !== "provider_response" || observation.source_observation_id !== sourceObservationId ||
        observation.transport_attempt_id !== transportAttemptId || observation.provider_name !== attempt.provider.name ||
        observation.model !== attempt.provider.model ||
        (rawUsage.provider_request_id === undefined
          ? observation.provider_request_id !== undefined
          : observation.provider_request_id !== rawUsage.provider_request_id) ||
        observation.rate_card_ref !== undefined || observation.valuation !== undefined) return fallback();
    return Object.freeze({ observation,
      ...(observation.completeness === "complete" ? { mapping: Object.freeze({
        profile_ref: mapped.profile_ref,
        profile_sha256: mapped.profile_sha256,
        raw_usage_sha256: rawUsageSha256,
        target_binding_sha256: targetBindingSha256,
        attempt_binding_sha256: attemptBindingSha256,
        source_observation_id: sourceObservationId,
        transport_attempt_id: transportAttemptId,
        billable_attempt_id: attempt.billable_attempt_id,
        provider_name: attempt.provider.name,
        model: attempt.provider.model,
        observation_sha256: canonicalHash(observation),
      }) } : {}) });
  } catch {
    return fallback();
  }
}

function retainUsageWithoutSettlement(observation, attempt) {
  if (!isRecord(observation)) return undefined;
  try {
    const missing = Array.isArray(observation.missing_fields) ? [...observation.missing_fields] : [];
    if (!missing.includes("usage.dispatch_authorization_not_current")) {
      missing.push("usage.dispatch_authorization_not_current");
    }
    return validateUsageObservation({
      ...observation,
      completeness: observation.completeness === "unknown" ? "unknown" : "partial",
      missing_fields: missing,
    }, attempt);
  } catch {
    return undefined;
  }
}

const OMIT_FAILURE_USAGE_VALUE = Symbol("omit_failure_usage_value");

function snapshotFailureUsage(value) {
  const state = { nodes: 0, bytes: 0, incomplete: false, seen: new WeakSet() };

  function copy(current, depth) {
    state.nodes += 1;
    if (state.nodes > 512 || depth > 12) {
      state.incomplete = true;
      return OMIT_FAILURE_USAGE_VALUE;
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (current.length > 16 * 1024 || state.bytes + current.length > 16 * 1024) {
        state.incomplete = true;
        return OMIT_FAILURE_USAGE_VALUE;
      }
      state.bytes += current.length;
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        state.incomplete = true;
        return OMIT_FAILURE_USAGE_VALUE;
      }
      return current;
    }
    if (typeof current !== "object") {
      state.incomplete = true;
      return OMIT_FAILURE_USAGE_VALUE;
    }
    if (state.seen.has(current)) {
      state.incomplete = true;
      return OMIT_FAILURE_USAGE_VALUE;
    }
    state.seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          state.incomplete = true;
          return OMIT_FAILURE_USAGE_VALUE;
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
        const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, "value")
          ? lengthDescriptor.value
          : undefined;
        if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
          state.incomplete = true;
          return OMIT_FAILURE_USAGE_VALUE;
        }
        const result = [];
        let outputIndex = 0;
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            state.incomplete = true;
            continue;
          }
          const child = copy(descriptor.value, depth + 1);
          if (child === OMIT_FAILURE_USAGE_VALUE) continue;
          Object.defineProperty(result, String(outputIndex), {
            value: child,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          outputIndex += 1;
        }
        return result;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        state.incomplete = true;
        return OMIT_FAILURE_USAGE_VALUE;
      }
      const keys = Reflect.ownKeys(current);
      const result = Object.create(null);
      for (const key of keys) {
        if (state.nodes >= 512) {
          state.incomplete = true;
          break;
        }
        if (typeof key !== "string") {
          state.incomplete = true;
          continue;
        }
        if (key.length > 1024 || state.bytes + key.length > 16 * 1024) {
          state.incomplete = true;
          continue;
        }
        state.bytes += key.length;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          state.incomplete = true;
          continue;
        }
        const child = copy(descriptor.value, depth + 1);
        if (child === OMIT_FAILURE_USAGE_VALUE) continue;
        Object.defineProperty(result, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } catch {
      state.incomplete = true;
      return OMIT_FAILURE_USAGE_VALUE;
    } finally {
      state.seen.delete(current);
    }
  }

  const snapshot = copy(value, 0);
  if (snapshot === OMIT_FAILURE_USAGE_VALUE || !isRecord(snapshot)) return undefined;
  if (!state.incomplete) return snapshot;

  function markIncomplete(counters) {
    if (!isRecord(counters)) return;
    if (counters.completeness !== "unknown") {
      Object.defineProperty(counters, "completeness", {
        value: "partial", enumerable: true, configurable: true, writable: true,
      });
    }
    const existing = Array.isArray(counters.missing_fields) ? counters.missing_fields : [];
    const missing = [];
    for (let index = 0; index < existing.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(existing, String(index));
      if (descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string") {
        Object.defineProperty(missing, String(missing.length), {
          value: descriptor.value, enumerable: true, configurable: true, writable: true,
        });
      }
    }
    if (!missing.some((field) => field === "usage.unmapped_extension")) {
      Object.defineProperty(missing, String(missing.length), {
        value: "usage.unmapped_extension", enumerable: true, configurable: true, writable: true,
      });
    }
    Object.defineProperty(counters, "missing_fields", {
      value: missing, enumerable: true, configurable: true, writable: true,
    });
  }

  markIncomplete(snapshot);
  if (Object.hasOwn(snapshot, "usage")) markIncomplete(snapshot.usage);
  return snapshot;
}

function providerFailureUsage(error) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  let usageDescriptor;
  let outcomeDescriptor;
  try {
    usageDescriptor = Object.getOwnPropertyDescriptor(error, "usage");
    outcomeDescriptor = Object.getOwnPropertyDescriptor(error, "provider_outcome");
    if (!usageDescriptor || !Object.hasOwn(usageDescriptor, "value") || !isRecord(usageDescriptor.value)) return undefined;
    const snapshot = snapshotFailureUsage(usageDescriptor.value);
    if (!snapshot) return undefined;
    const projected = projectPublicTelemetry(snapshot, { maxDepth: 8, maxNodes: 256, maxBytes: 16 * 1024 });
    const reportedOutcome = outcomeDescriptor && Object.hasOwn(outcomeDescriptor, "value")
      ? outcomeDescriptor.value : undefined;
    const providerOutcome = ["failed", "partial", "unknown"].includes(reportedOutcome) ? reportedOutcome : "unknown";
    return Object.freeze({ usage: projected.value, provider_outcome: providerOutcome,
      target_binding_sha256: readPrivateOpenAIImageTargetBindingSha256(error),
      retry_disposition: readPrivateOpenAIImageRetryDisposition(error) });
  } catch {
    return undefined;
  }
}

function meteringFailure(outcome, operation) {
  if (outcome?.status === "reservation_denied") {
    return new CreativeApiError("budget_unavailable", operation, "budget");
  }
  if (["cancelled_before_dispatch", "cancelled_after_dispatch"].includes(outcome?.status)) {
    return new CreativeApiError("cancelled", operation);
  }
  return new CreativeApiError("unavailable", operation, "metering", { retryable: true });
}

function safeError(error, operation) {
  if (error instanceof CreativeApiError) {
    const operationId = CREATIVE_API_OPERATIONS.includes(error.operation)
      ? error.operation
      : (CREATIVE_API_OPERATIONS.includes(operation) ? operation : "unknown");
    const code = Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : "failed";
    const field = safeFieldPath(error.field);
    const safe = new CreativeApiError(code, operationId, field, { retryable: error.retryable === true });
    safe.diagnostic_ref = safeDiagnosticRef(error.diagnostic_ref, undefined);
    return safe;
  }
  if (error instanceof ApprovalHandoffContractError) {
    const code = error.code === "verifier_unavailable" ? "unavailable"
      : error.code.includes("scope") ? "scope_denied"
        : error.code.includes("approval") ? "permission_denied" : "invalid_request";
    return new CreativeApiError(code, operation, safeFieldPath(error.field));
  }
  if (error instanceof CreativeCompositionContractError) {
    const code = error.code === "unsupported_version" ? "unsupported_version"
      : error.code.includes("scope") ? "scope_denied"
        : error.code === "stale_version" ? "stale_version"
          : error.code === "permission_denied" ? "permission_denied"
            : error.code === "integrity_error" ? "failed" : "invalid_request";
    return new CreativeApiError(code, operation, safeFieldPath(error.field));
  }
  if (error instanceof MeteringContractError) return new CreativeApiError("unavailable", operation, "metering", { retryable: true });
  if (error instanceof TelemetryBoundaryError) return new CreativeApiError("unavailable", operation, "telemetry", { retryable: true });
  if (error instanceof CreativePlanningError) {
    const code = error.code === "scope_mismatch" ? "scope_denied"
      : error.code === "research_package_invalid" || error.code === "brief_store_unavailable" ? "unavailable"
        : error.code === "permission_proof_invalid" ? "permission_denied" : "invalid_request";
    return new CreativeApiError(code, operation, safeFieldPath(error.field));
  }
  if (error?.module === "creative-engine.versions") {
    const versionCodeMap = Object.freeze({
      invalid_request: "invalid_request",
      unsupported_version: "unsupported_version",
      scope_denied: "scope_denied",
      not_found: "not_found",
      conflict: "conflict",
      stale_version: "stale_version",
      unavailable: "unavailable",
      cancelled: "cancelled",
      integrity_error: "failed",
      unknown_completion: "unavailable",
    });
    const code = versionCodeMap[error.code] ?? "failed";
    return new CreativeApiError(code, operation, safeFieldPath(error.field), { retryable: error.retryable === true });
  }
  if (error instanceof ContractError) {
    const code = error.code === "unsupported_version" || error.code === "unsupported_major"
      ? "unsupported_version"
      : (error.code.includes("scope") ? "scope_denied" : "invalid_request");
    return new CreativeApiError(code, operation, safeFieldPath(error.field));
  }
  return new CreativeApiError("failed", operation);
}

function encodeCursor(scope, brief_id, item) {
  const body = JSON.stringify({
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    brief_id,
    occurred_at: item.occurred_at,
    design_version_id: item.design_version_id,
  });
  return Buffer.from(body, "utf8").toString("base64url");
}

function decodeCursor(cursor, scope, brief_id) {
  if (cursor === undefined) return undefined;
  boundedString(cursor, "cursor", 1024);
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isRecord(parsed) || Object.keys(parsed).some((key) => !["tenant_id", "project_id", "brief_id", "occurred_at", "design_version_id"].includes(key)) ||
      parsed.tenant_id !== scope.tenant_id || parsed.project_id !== scope.project_id || parsed.brief_id !== brief_id) {
      throw new Error("scope");
    }
    boundedString(parsed.occurred_at, "cursor.occurred_at", 40);
    if (!/^\d{4}-\d\d-\d\dT/.test(parsed.occurred_at) || !Number.isFinite(Date.parse(parsed.occurred_at))) throw new Error("date");
    boundedString(parsed.design_version_id, "cursor.design_version_id");
    return Object.freeze({ occurred_at: parsed.occurred_at, design_version_id: parsed.design_version_id });
  } catch {
    throw new CreativeApiError("invalid_request", "list", "cursor");
  }
}

function actionRequestHash(request) {
  const value = {
    contract: request.contract,
    schema_version: request.schema_version,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    operation: request.operation,
    environment: request.environment,
    billing_mode: request.billing_mode,
    source_refs: request.source_refs,
    payload: request.payload,
  };
  if (request.action_id !== undefined) value.action_id = request.action_id;
  return canonicalHash(value);
}

function compareOrder(a, b) {
  const byTime = b.occurred_at.localeCompare(a.occurred_at);
  return byTime || a.design_version_id.localeCompare(b.design_version_id);
}

function isAfterCursor(item, cursor) {
  return item.occurred_at < cursor.occurred_at ||
    (item.occurred_at === cursor.occurred_at && item.design_version_id > cursor.design_version_id);
}

function requiredPort(ports, path, operation) {
  const found = path.split(".").reduce((current, key) => current?.[key], ports);
  if (typeof found !== "function") throw new CreativeApiError("unavailable", operation, path);
  return found;
}

export function createCreativeApi(options = {}) {
  const ports = options.ports ?? {};
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  const emitTrace = async (event) => {
    if (typeof ports.trace?.record === "function") {
      try { await ports.trace.record(safeTraceEvent(event)); } catch { /* trace failure must not expose details */ }
    }
  };
  const failResponse = (error, operation = "unknown", schemaVersion = CREATIVE_API_VERSION) => {
    const safe = safeError(error, operation);
    return Object.freeze({
      ok: false,
      contract: "CreativeApiResponse",
      schema_version: schemaVersion,
      error: Object.freeze({
        code: safe.code,
        operation: safe.operation,
        module: safe.module,
        field: safe.field,
        retryable: safe.retryable,
        message: safe.message,
        diagnostic_ref: safeDiagnosticRef(safe.diagnostic_ref,
          `creative-api:${safe.code}:${safeDiagnosticRef(idFactory(), "request")}`),
      }),
    });
  };

  async function loadBrief(scope, briefId, operation) {
    boundedString(briefId, "brief_id");
    const getBrief = requiredPort(ports, "storage.getBrief", operation);
    const brief = await getBrief(Object.freeze({ scope, brief_id: briefId }));
    if (!brief) throw new CreativeApiError("not_found", operation, "brief_id");
    assertScopedRecord(brief, scope, operation, briefId);
    return validateCreativeBrief(brief, { trustedScope: scope });
  }

  function validateSavedBriefPlan(value, scope, expectedHash, operation) {
    let plan;
    try { plan = immutableRequestSnapshot(value); }
    catch { throw new CreativeApiError("unavailable", operation, "brief_persistence"); }
    if (!isRecord(plan) || plan.contract !== "CreativeBriefPlan" || plan.schema_version !== "1.0" ||
      !isRecord(plan.brief)) throw new CreativeApiError("unavailable", operation, "brief_persistence");
    const briefId = boundedString(plan.brief.brief_id, "brief_id");
    let brief;
    try { brief = validateCreativeBrief(plan.brief, { trustedScope: { ...scope, brief_id: briefId } }); }
    catch { throw new CreativeApiError("unavailable", operation, "brief_persistence"); }
    const { plan_hash: planHash, ...planBody } = plan;
    let calculatedPlanHash;
    try { calculatedPlanHash = canonicalHash(planBody); }
    catch { throw new CreativeApiError("unavailable", operation, "brief_persistence"); }
    if (plan.brief_hash !== canonicalHash(brief) || plan.brief_hash !== expectedHash ||
      typeof planHash !== "string" || planHash !== calculatedPlanHash) {
      throw new CreativeApiError("unavailable", operation, "brief_persistence");
    }
    return plan;
  }

  async function createBrief(principal, request) {
    const scope = scopeFor(principal);
    const requestHash = actionRequestHash(request);
    const getAction = requiredPort(ports, "planning.getBriefAction", request.operation);
    const getPackage = requiredPort(ports, "planning.getCurrentResearchPackage", request.operation);
    const saveAction = requiredPort(ports, "planning.saveBriefAction", request.operation);
    const priorAction = await getAction(Object.freeze({ scope, actor_id: principal.actor_id,
      action_id: request.action_id, request_hash: requestHash }));
    if (priorAction !== null && !isRecord(priorAction)) throw new CreativeApiError("unavailable", request.operation, "brief_persistence");
    if (priorAction?.status === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
    if (priorAction?.status === "replayed") {
      const result = validateSavedBriefPlan(priorAction.plan, scope, priorAction.brief_hash, request.operation);
      assertPublicIdentifiers(result, request.operation, "brief_plan");
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse",
        schema_version: CREATIVE_API_VERSION, operation_id: result.brief.brief_id, replayed: true, result }), request.operation);
    }
    if (priorAction !== null) throw new CreativeApiError("unavailable", request.operation, "brief_persistence");
    const rawPackage = await getPackage(Object.freeze({ scope }));
    let researchPackage;
    try { researchPackage = immutableRequestSnapshot(rawPackage); }
    catch { throw new CreativeApiError("unavailable", request.operation, "research_package"); }
    const { expected_brief_hash: requestedExpectedHash, ...planningInput } = request.payload;
    const plan = buildCreativeBrief({
      trusted_scope: scope,
      research_package: researchPackage,
      context: { created_at: request.occurred_at, environment: request.environment,
        billing_mode: request.billing_mode, correlation_id: request.correlation_id },
      ...planningInput,
    });
    const getBrief = requiredPort(ports, "storage.getBrief", request.operation);
    const existing = await getBrief(Object.freeze({ scope, brief_id: plan.brief.brief_id }));
    let currentHash = null;
    if (existing) {
      assertScopedRecord(existing, scope, request.operation, plan.brief.brief_id);
      const current = validateCreativeBrief(existing, { trustedScope: { ...scope, brief_id: plan.brief.brief_id } });
      currentHash = canonicalHash(current);
    }
    const expectedBriefHash = requestedExpectedHash ?? currentHash;
    const saved = await saveAction(Object.freeze({ scope, actor_id: principal.actor_id,
      action_id: request.action_id, request_hash: requestHash, plan,
      expected_brief_hash: expectedBriefHash }));
    if (!isRecord(saved)) throw new CreativeApiError("unavailable", request.operation, "brief_persistence");
    if (saved.status === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
    if (saved.status === "stale") throw new CreativeApiError("stale_version", request.operation, "expected_brief_hash");
    if (!["saved", "replayed"].includes(saved.status) || !isRecord(saved.plan) ||
      saved.brief_hash !== saved.plan.brief_hash ||
      (saved.status === "saved" && saved.plan.brief?.brief_id !== plan.brief.brief_id)) {
      throw new CreativeApiError("unavailable", request.operation, "brief_persistence");
    }
    const result = validateSavedBriefPlan(saved.plan, scope, saved.brief_hash, request.operation);
    assertPublicIdentifiers(result, request.operation, "brief_plan");
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse",
      schema_version: CREATIVE_API_VERSION, operation_id: result.brief.brief_id,
      replayed: saved.status === "replayed", result }), request.operation);
  }

  async function invalidateBrief(principal, request) {
    const apply = requiredPort(ports, "planning.applyInvalidation", request.operation);
    const action = await apply(Object.freeze({
      trusted_scope: scopeFor(principal),
      actor_id: principal.actor_id,
      action_id: request.action_id,
      operation: request.operation,
      request_hash: actionRequestHash(request),
      event_id: request.payload.event_id,
    }));
    if (!isRecord(action) || action.public_action_status === "conflict") {
      if (action?.public_action_status === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
      throw new CreativeApiError("unavailable", request.operation, "invalidation_action");
    }
    if (!["completed", "replayed", "pending"].includes(action.public_action_status) || !isRecord(action.invalidation)) {
      throw new CreativeApiError("unavailable", request.operation, "invalidation_action");
    }
    const result = action.invalidation;
    if (!isRecord(result) || result.event_id !== request.payload.event_id || !isRecord(result.durable_receipt)) {
      throw new CreativeApiError("unavailable", request.operation, "invalidation_receipt");
    }
    assertPublicIdentifiers(result, request.operation, "invalidation");
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse",
      schema_version: CREATIVE_API_VERSION, operation_id: result.event_id,
      replayed: action.public_action_status === "replayed",
      result: Object.freeze({ invalidation: result,
        local_status: result.producer_acknowledgment ? "acknowledged" : "pending" }) }), request.operation);
  }

  async function loadDesign(scope, brief, designVersionId, operation, { allowHistorical = false } = {}) {
    boundedString(designVersionId, "design_version_id");
    const getDesignVersion = requiredPort(ports, "storage.getDesignVersion", operation);
    const design = await getDesignVersion(Object.freeze({ scope, brief_id: brief.brief_id, design_version_id: designVersionId }));
    if (!design) throw new CreativeApiError("not_found", operation, "design_version_id");
    assertScopedRecord(design, scope, operation, brief.brief_id);
    if (design.design_version_id !== designVersionId) throw new CreativeApiError("scope_denied", operation, "design_version_id");
    let sourceBrief = brief;
    if (design.brief_hash !== canonicalHash(brief)) {
      if (!allowHistorical) throw new CreativeApiError("stale_version", operation, "brief_hash");
      const getBriefVersion = requiredPort(ports, "storage.getBriefVersionByHash", operation);
      const historical = await getBriefVersion(Object.freeze({ scope, brief_id: brief.brief_id, brief_hash: design.brief_hash }));
      if (!historical) throw new CreativeApiError("unavailable", operation, "brief_history");
      assertScopedRecord(historical, scope, operation, brief.brief_id);
      sourceBrief = validateCreativeBrief(historical, { trustedScope: { ...scope, brief_id: brief.brief_id } });
      if (canonicalHash(sourceBrief) !== design.brief_hash) throw new CreativeApiError("failed", operation, "brief_history.hash");
    }
    return validateDesignVersion(design, {
      trustedScope: { ...scope, design_version_id: designVersionId },
      brief_hash: canonicalHash(sourceBrief),
      known_source_refs: sourceBrief.source_identity.map((source) => source.source_id),
    });
  }

  async function assertCurrentCreativeContext(scope, brief, design, operation,
    expectedCurrentDesignVersionId = undefined, expectedCurrentDesignHash = undefined) {
    const currentBrief = await loadBrief(scope, brief.brief_id, operation);
    if (canonicalHash(currentBrief) !== canonicalHash(brief)) {
      throw new CreativeApiError("stale_version", operation, "brief_hash");
    }
    if (typeof ports.storage?.isBriefUsable === "function" &&
      !(await ports.storage.isBriefUsable(Object.freeze({ scope, brief_id: brief.brief_id, brief_hash: canonicalHash(brief) })))) {
      throw new CreativeApiError("stale_version", operation, "brief_invalidation");
    }
    if (design) {
      const currentDesign = await loadDesign(scope, currentBrief, design.design_version_id, operation);
      if (currentDesign.design_hash !== design.design_hash ||
        currentDesign.artifact.content_hash !== design.artifact.content_hash) {
        throw new CreativeApiError("stale_version", operation, "design_hash");
      }
    }
    if (expectedCurrentDesignVersionId !== undefined) {
      const getCurrent = requiredPort(ports, "storage.getCurrentDesignVersion", operation);
      const selected = await getCurrent(Object.freeze({ scope, brief_id: brief.brief_id }));
      if (selected !== null && !isRecord(selected)) throw new CreativeApiError("unavailable", operation, "current_design_version");
      if ((selected?.design_version_id ?? null) !== expectedCurrentDesignVersionId) {
        throw new CreativeApiError("stale_version", operation, "design_version_id");
      }
      if (selected) {
        assertScopedRecord(selected, scope, operation, brief.brief_id);
        const validated = await loadDesign(scope, currentBrief, selected.design_version_id, operation, { allowHistorical: true });
        const expectedHash = expectedCurrentDesignHash === undefined ? (design?.design_hash ?? null) : expectedCurrentDesignHash;
        if (validated.design_hash !== expectedHash) throw new CreativeApiError("stale_version", operation, "design_hash");
        if (design && validated.design_hash !== design.design_hash) {
          throw new CreativeApiError("stale_version", operation, "design_hash");
        }
      }
    }
    return currentBrief;
  }

  async function readCompositionContext(principal, request, scope) {
    const operation = request.operation;
    const brief = await loadBrief(scope, request.payload.brief_id, operation);
    const design = await loadDesign(scope, brief, request.payload.design_version_id, operation);
    await assertCurrentCreativeContext(scope, brief, design, operation, design.design_version_id, design.design_hash);
    const getSelection = requiredPort(ports, "storage.getSelection", operation);
    const selection = await getSelection(Object.freeze({ scope, brief_id: brief.brief_id }));
    if (!isRecord(selection)) throw new CreativeApiError("stale_version", operation, "selection");
    assertScopedRecord(selection, scope, operation, brief.brief_id);
    if (selection.design_version_id !== design.design_version_id || selection.design_hash !== design.design_hash ||
        !Number.isSafeInteger(selection.revision) || selection.revision < 1) {
      throw new CreativeApiError("stale_version", operation, "selection");
    }
    const parent = design.parent_version_id === null ? null
      : await loadDesign(scope, brief, design.parent_version_id, operation, { allowHistorical: true });
    const getPackage = requiredPort(ports, "planning.getCurrentResearchPackage", operation);
    let research;
    try { research = normalizeResearchPackage(immutableRequestSnapshot(await getPackage(Object.freeze({ scope }))), scope); }
    catch { throw new CreativeApiError("unavailable", operation, "research_package"); }
    const packageHash = canonicalHash(research);
    if (research.package_id !== brief.research_package_ref.package_id ||
        packageHash !== brief.research_package_ref.content_hash) {
      throw new CreativeApiError("stale_version", operation, "research_package_hash");
    }
    const getArtifactBytes = requiredPort(ports, "storage.getArtifactBytes", operation);
    let artworkBytes;
    try { artworkBytes = Uint8Array.from(await getArtifactBytes(Object.freeze({ scope, brief_id: brief.brief_id,
      design_version_id: design.design_version_id }))); }
    catch { throw new CreativeApiError("unavailable", operation, "artwork_bytes"); }
    if (hashArtifactBytes(artworkBytes) !== design.artifact.content_hash) {
      throw new CreativeApiError("failed", operation, "artwork_bytes.hash");
    }
    let artworkDimensions;
    try { artworkDimensions = await inspectOpenAIImageBytes(artworkBytes); }
    catch { throw new CreativeApiError("failed", operation, "artwork_bytes.decode"); }
    const scopeWithBrief = Object.freeze({ ...scope, brief_id: brief.brief_id });
    return Object.freeze({ scope: scopeWithBrief, brief, design, parent, selection, research, package_hash: packageHash,
      artwork_bytes: artworkBytes, artwork_dimensions: artworkDimensions,
      actor_id: principal.actor_id, action_id: request.action_id ?? `read:${request.request_id}`,
      request_hash: actionRequestHash(request) });
  }

  function compositionOwnerInput(context) {
    return Object.freeze({ scope: context.scope, actor_id: context.actor_id, action_id: context.action_id,
      request_hash: context.request_hash, brief: context.brief, brief_hash: canonicalHash(context.brief),
      selected_design: context.design, selection_revision: context.selection.revision,
      research_package: context.research, package_hash: context.package_hash });
  }

  async function validateCompositionOwnerSource(raw, context, operation) {
    let copied;
    try { copied = snapshotCompositionBytesRecord(raw); }
    catch { throw new CreativeApiError("failed", operation, "composition.source"); }
    const source = copied.metadata;
    assertOnlyKeys(source, ["contract", "schema_version", "scope", "revision"], "composition.source");
    if (source.contract !== "CreativeCompositionSource" || source.schema_version !== "1.1" ||
        !isRecord(source.scope) || source.scope.tenant_id !== context.scope.tenant_id ||
        source.scope.project_id !== context.scope.project_id || source.scope.brief_id !== context.scope.brief_id) {
      throw new CreativeApiError("scope_denied", operation, "composition.source.scope");
    }
    let revision;
    revision = validateCurrentCompositionRevision(source.revision, copied.bytes, context.scope, operation);
    const dependencies = revision.dependencies;
    const briefHash = canonicalHash(context.brief);
    const factsHash = canonicalHash(context.brief.facts);
    const design = context.design;
    const dimensions = context.artwork_dimensions;
    let previewDimensions;
    try { previewDimensions = await inspectOpenAIImageBytes(copied.bytes); }
    catch { throw new CreativeApiError("failed", operation, "composition.preview.decode"); }
    const artworkMimeType = IMAGE_MIME_BY_FORMAT[dimensions.format];
    const previewMimeType = IMAGE_MIME_BY_FORMAT[previewDimensions.format];
    if (!artworkMimeType || design.artifact.media_type !== artworkMimeType ||
        revision.artwork.mime_type !== artworkMimeType || revision.artwork.width_px !== dimensions.width ||
        revision.artwork.height_px !== dimensions.height) {
      throw new CreativeApiError("failed", operation, "composition.artwork.metadata");
    }
    if (!previewMimeType || revision.preview.mime_type !== previewMimeType ||
        revision.preview.width_px !== previewDimensions.width || revision.preview.height_px !== previewDimensions.height ||
        revision.preview.byte_length !== copied.bytes.byteLength || revision.preview.preview_sha256 !== hashArtifactBytes(copied.bytes)) {
      throw new CreativeApiError("failed", operation, "composition.preview.metadata");
    }
    if (revision.tenant_id !== context.scope.tenant_id || revision.project_id !== context.scope.project_id ||
        revision.brief_id !== context.scope.brief_id || revision.binding.brief.sha256 !== briefHash.slice(7) ||
        revision.binding.facts.sha256 !== factsHash.slice(7) || dependencies.brief_hash !== briefHash ||
        dependencies.facts_revision_id !== context.research.event_id || dependencies.facts_sha256 !== factsHash ||
        dependencies.package_id !== context.research.package_id || dependencies.package_sha256 !== context.package_hash ||
        revision.binding.design_version.design_version_id !== design.design_version_id ||
        revision.binding.design_version.artwork_sha256 !== design.artifact.content_hash.slice(7) ||
        dependencies.design_version_id !== design.design_version_id ||
        dependencies.design_version_sha256 !== design.design_hash || dependencies.artwork_sha256 !== design.artifact.content_hash ||
        dependencies.parent_version_id !== design.parent_version_id ||
        dependencies.parent_design_hash !== (context.parent?.design_hash ?? null) ||
        dependencies.selection_revision !== context.selection.revision ||
        revision.artwork.sha256 !== design.artifact.content_hash.slice(7) ||
        revision.artwork.artifact_id !== design.artifact.artifact_id) {
      throw new CreativeApiError("stale_version", operation, "composition.source.binding");
    }
    const permissions = new Map(context.brief.permissions.items.map((item) => [`${item.asset_id}\u0000${item.action}`, item.status]));
    const researchPermissions = new Map(context.research.permissions.items.map((item) => [`${item.asset_id}\u0000${item.action}`, item.status]));
    const requiresModify = new Set(revision.layer_manifest.filter((layer) => layer.kind === "approved_asset")
      .map((layer) => layer.asset_id));
    for (const asset of revision.binding.assets) {
      const sourceAsset = context.research.assets.items.find((item) => item.asset_id === asset.asset_id);
      if (!sourceAsset || sourceAsset.content_hash !== `sha256:${asset.sha256}`) {
        throw new CreativeApiError("permission_denied", operation, "composition.asset_binding");
      }
      const rights = revision.dependencies.asset_rights.filter((item) => item.asset_id === asset.asset_id);
      const requiredActions = ["display", "reproduce", ...(requiresModify.has(asset.asset_id) ? ["modify"] : [])];
      for (const action of requiredActions) {
        const right = rights.find((item) => item.action === action);
        if (!right || right.source_ref !== sourceAsset.source_id || right.content_hash !== sourceAsset.content_hash ||
            permissions.get(`${asset.asset_id}\u0000${action}`) !== "granted" ||
            researchPermissions.get(`${asset.asset_id}\u0000${action}`) !== "granted") {
          throw new CreativeApiError("permission_denied", operation, "composition.asset_rights");
        }
      }
      const readAsset = requiredPort(ports, "composition.readApprovedAssetBytes", operation);
      let rawAsset;
      try { rawAsset = await readAsset(Object.freeze({ scope: context.scope, asset_id: asset.asset_id,
        content_hash: sourceAsset.content_hash, package_id: context.research.package_id,
        package_hash: context.package_hash, permission_ref: asset.permission_ref })); }
      catch { throw new CreativeApiError("unavailable", operation, "composition.asset_bytes"); }
      let assetBytes;
      try { assetBytes = snapshotCompositionBytesRecord(rawAsset, "bytes"); }
      catch { throw new CreativeApiError("failed", operation, "composition.asset_bytes"); }
      const assetRecord = assetBytes.metadata;
      assertOnlyKeys(assetRecord, ["asset_id", "content_hash", "mime_type"], "composition.asset_bytes");
      if (assetRecord.asset_id !== asset.asset_id || assetRecord.content_hash !== sourceAsset.content_hash ||
          assetRecord.mime_type !== sourceAsset.media_type || hashArtifactBytes(assetBytes.bytes) !== sourceAsset.content_hash) {
        throw new CreativeApiError("failed", operation, "composition.asset_bytes.hash");
      }
      try { await inspectOpenAIImageBytes(assetBytes.bytes); }
      catch { throw new CreativeApiError("failed", operation, "composition.asset_bytes.decode"); }
    }
    // Asset reads are awaited. Revalidate local preview/authority/right proof
    // windows after the final read so a proof cannot expire during validation.
    validateCurrentCompositionRevision(revision, copied.bytes, context.scope, operation);
    return Object.freeze({ revision, preview_bytes: copied.bytes });
  }

  function assertCompositionAuthorityCurrent(context, revision, expectedCurrent, operation) {
    const assertCurrent = requiredPort(ports, "composition.assertCurrent", operation);
    const result = assertCurrent(Object.freeze({ contract: "CreativeCompositionCurrentAssertion", schema_version: "1.1",
      scope: context.scope, actor_id: context.actor_id, action_id: context.action_id, request_hash: context.request_hash,
      composition_id: revision.composition_id, expected_current_revision_id: expectedCurrent?.revision_id ?? null,
      expected_current_revision_sha256: expectedCurrent?.revision_sha256 ?? null,
      target_revision_id: revision.revision_id, target_revision_sha256: revision.revision_sha256,
      target_state_sha256: revision.state_sha256, design_version_id: context.design.design_version_id,
      design_version_sha256: context.design.design_hash, selection_revision: context.selection.revision,
      facts_revision_id: revision.dependencies.facts_revision_id, facts_sha256: revision.dependencies.facts_sha256,
      package_id: revision.dependencies.package_id, package_sha256: revision.dependencies.package_sha256, checked_at: now() }));
    if (result !== null && typeof result === "object" && typeof result.then === "function") {
      throw new CreativeApiError("failed", operation, "composition.assert_current_async");
    }
    let checked;
    try { checked = immutableRequestSnapshot(result); }
    catch { throw new CreativeApiError("failed", operation, "composition.assert_current"); }
    assertOnlyKeys(checked, ["contract", "schema_version", "status", "scope", "composition_id",
      "current_revision_id", "current_revision_sha256", "selection_revision", "design_version_id",
      "design_version_sha256", "facts_revision_id", "facts_sha256", "package_id", "package_sha256",
      "proof_ref", "checked_at", "expires_at"], "composition.assert_current");
    const expectedRevision = expectedCurrent ?? revision;
    const checkedAt = checked.checked_at;
    const expiresAt = checked.expires_at;
    if (checked.contract !== "CreativeCompositionCurrentAssertionResult" || checked.schema_version !== "1.1" ||
        checked.status !== "current" || !isRecord(checked.scope) ||
        checked.scope.tenant_id !== context.scope.tenant_id || checked.scope.project_id !== context.scope.project_id ||
        checked.scope.brief_id !== context.scope.brief_id || checked.composition_id !== revision.composition_id ||
        checked.current_revision_id !== expectedRevision.revision_id ||
        checked.current_revision_sha256 !== expectedRevision.revision_sha256 ||
        checked.selection_revision !== context.selection.revision || checked.design_version_id !== context.design.design_version_id ||
        checked.design_version_sha256 !== context.design.design_hash ||
        checked.facts_revision_id !== revision.dependencies.facts_revision_id ||
        checked.facts_sha256 !== revision.dependencies.facts_sha256 || checked.package_id !== revision.dependencies.package_id ||
        checked.package_sha256 !== revision.dependencies.package_sha256 || typeof checked.proof_ref !== "string" ||
        !Number.isSafeInteger(checkedAt) || checkedAt > now() || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) {
      throw new CreativeApiError("stale_version", operation, "composition.current_authority");
    }
    return checked;
  }

  function compositionPreviewAccess(revision, bytes) {
    return Object.freeze({ contract: "CreativeCompositionPreviewAccess", schema_version: "1.1",
      preview_id: revision.preview.preview_id, sha256: revision.preview.preview_sha256,
      byte_length: bytes.byteLength, mime_type: revision.preview.mime_type,
      width_px: revision.preview.width_px, height_px: revision.preview.height_px,
      bytes_base64: Buffer.from(bytes).toString("base64") });
  }

  function validateCurrentCompositionRevision(rawRevision, previewBytes, trustedScope, operation) {
    let revision;
    try { revision = validateCompositionRevision(rawRevision, { trustedScope, previewBytes }); }
    catch (error) { throw safeError(error, operation); }
    const checkedAt = now();
    const proofs = [revision.preview, revision.dependencies.authority_proof,
      ...(revision.dependencies.edit_policy ? [revision.dependencies.edit_policy] : []),
      ...revision.dependencies.asset_rights];
    if (proofs.some((proof) => proof.checked_at > checkedAt || proof.expires_at <= checkedAt)) {
      throw new CreativeApiError("stale_version", operation, "composition.proof_expired");
    }
    return revision;
  }

  async function getPublicCompositionHistory(principal, request) {
    const operation = request.operation;
    const scope = scopeFor(principal, request.payload.brief_id);
    const brief = await loadBrief(scope, request.payload.brief_id, operation);
    const design = await loadDesign(scope, brief, request.payload.design_version_id, operation, { allowHistorical: true });
    const getSelection = requiredPort(ports, "storage.getSelection", operation);
    const selection = await getSelection(Object.freeze({ scope, brief_id: brief.brief_id }));
    if (selection !== null && !isRecord(selection)) throw new CreativeApiError("unavailable", operation, "selection");
    if (selection) assertScopedRecord(selection, scope, operation, brief.brief_id);
    const readIdentity = requiredPort(ports, "storage.getCurrentCompositionIdentity", operation);
    let current;
    try { current = await readIdentity(Object.freeze({ scope, design_version_id: design.design_version_id })); }
    catch (error) { throw safeError(error, operation); }
    const validPublicRef = (value) => {
      try { assertSafePublicIdentifier(value, { maxLength: 256 }); return true; }
      catch { return false; }
    };
    const validCompositionHash = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
    if (current !== null && (!isRecord(current) || !validPublicRef(current.composition_id) ||
        !validPublicRef(current.revision_id) || !validCompositionHash(current.revision_sha256) ||
        current.design_version_id !== design.design_version_id || !validCompositionHash(current.design_version_sha256) ||
        current.design_version_sha256 !== design.design_hash || !Number.isSafeInteger(current.selection_revision) ||
        current.selection_revision < 1 || timestampMillis(current.updated_at) === null)) {
      throw new CreativeApiError("failed", operation, "composition.current_identity");
    }
    const selection_compatibility = !selection ? "unavailable"
      : selection.design_version_id !== design.design_version_id || selection.design_hash !== design.design_hash
        ? "different_design"
        : current && selection.revision !== current.selection_revision ? "changed" : "current";
    let items = [];
    let hasMore = false;
    if (current) {
      const list = requiredPort(ports, "storage.listCompositionRevisions", operation);
      const page = await list(Object.freeze({ scope, composition_id: current.composition_id,
        limit: request.payload.limit ?? 20,
        ...(request.payload.after_revision_id !== undefined ? { after_revision_id: request.payload.after_revision_id } : {}) }));
      if (!isRecord(page) || !Array.isArray(page.items) || typeof page.has_more !== "boolean" ||
          page.items.length > (request.payload.limit ?? 20) || page.has_more && page.items.length === 0) {
        throw new CreativeApiError("unavailable", operation, "composition.history");
      }
      const seenRevisionIds = new Set();
      let previousCreatedAt = Number.POSITIVE_INFINITY;
      let previousRevisionId = "";
      items = page.items.map((revision) => {
        const parentPairValid = revision?.parent_revision_id === null && revision?.parent_revision_sha256 === null ||
          validPublicRef(revision?.parent_revision_id) && validCompositionHash(revision?.parent_revision_sha256);
        const createdAt = timestampMillis(revision?.created_at);
        if (!isRecord(revision) || !validPublicRef(revision.revision_id) || seenRevisionIds.has(revision.revision_id) ||
            !validCompositionHash(revision.revision_sha256) || revision.composition_id !== current.composition_id ||
            !parentPairValid || !isRecord(revision.dependencies) ||
            revision.dependencies.design_version_id !== design.design_version_id ||
            revision.dependencies.design_version_sha256 !== design.design_hash || createdAt === null ||
            // Safe public IDs are ASCII, so code-unit order matches SQLite's BINARY collation.
            createdAt > previousCreatedAt || createdAt === previousCreatedAt && revision.revision_id < previousRevisionId) {
          throw new CreativeApiError("failed", operation, "composition.history_record");
        }
        seenRevisionIds.add(revision.revision_id);
        previousCreatedAt = createdAt;
        previousRevisionId = revision.revision_id;
        return Object.freeze({ revision_id: revision.revision_id, revision_sha256: revision.revision_sha256,
          parent_revision_id: revision.parent_revision_id, parent_revision_sha256: revision.parent_revision_sha256,
          design_version_id: revision.dependencies.design_version_id,
          design_version_sha256: revision.dependencies.design_version_sha256, created_at: revision.created_at });
      });
      hasMore = page.has_more;
    }
    const projectedCurrent = current ? Object.freeze({ composition_id: current.composition_id,
      revision_id: current.revision_id, revision_sha256: current.revision_sha256,
      design_version_id: current.design_version_id, design_version_sha256: current.design_version_sha256,
      selection_revision: current.selection_revision, updated_at: current.updated_at }) : null;
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: "1.3",
      result: Object.freeze({ contract: "CreativeCompositionHistoryIdentity", schema_version: "1.0",
        status: current ? "identity_only" : "not_initialized", current: projectedCurrent,
        selection_compatibility, revisions: Object.freeze(items), has_more: hasMore,
        next_after_revision_id: hasMore && items.length ? items.at(-1).revision_id : null }) }), operation);
  }

  async function getPublicComposition(principal, request) {
    const operation = request.operation;
    const scope = scopeFor(principal, request.payload.brief_id);
    const context = await readCompositionContext(principal, request, scope);
    const getCurrent = requiredPort(ports, "storage.getCurrentComposition", operation);
    const stored = await getCurrent(Object.freeze({ scope: context.scope, design_version_id: context.design.design_version_id }));
    if (stored === null) {
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: "1.2",
        result: Object.freeze({ composition: null, status: "not_initialized" }) }), operation);
    }
    let storedSnapshot;
    try { storedSnapshot = snapshotCompositionBytesRecord(stored); }
    catch { throw new CreativeApiError("failed", operation, "composition.storage_record"); }
    let revision;
    let previewBytes = storedSnapshot.bytes;
    revision = validateCurrentCompositionRevision(storedSnapshot.metadata.revision, previewBytes, context.scope, operation);
    const authority = requiredPort(ports, "composition.resolveCurrent", operation);
    let rawSource;
    try { rawSource = await authority(compositionOwnerInput(context)); }
    catch { throw new CreativeApiError("unavailable", operation, "composition.authority"); }
    const source = await validateCompositionOwnerSource(rawSource, context, operation);
    if (canonicalSerialize(source.revision) !== canonicalSerialize(revision) ||
        !Buffer.from(source.preview_bytes).equals(Buffer.from(previewBytes))) {
      throw new CreativeApiError("stale_version", operation, "composition.owner_revision");
    }
    // Re-read the persisted pointer after every external await. This checks
    // the exact selected design/current revision again after asset-byte reads
    // and catches proof expiry or a concurrent currentness change.
    let finalStored;
    try { finalStored = await getCurrent(Object.freeze({ scope: context.scope, design_version_id: context.design.design_version_id })); }
    catch (error) { throw safeError(error, operation); }
    if (finalStored === null) throw new CreativeApiError("stale_version", operation, "composition.current");
    let finalSnapshot;
    let finalRevision;
    try {
      finalSnapshot = snapshotCompositionBytesRecord(finalStored);
      finalRevision = validateCurrentCompositionRevision(finalSnapshot.metadata.revision, finalSnapshot.bytes,
        context.scope, operation);
    } catch (error) { throw safeError(error, operation); }
    if (canonicalSerialize(finalRevision) !== canonicalSerialize(revision) ||
        !Buffer.from(finalSnapshot.bytes).equals(Buffer.from(previewBytes))) {
      throw new CreativeApiError("stale_version", operation, "composition.current");
    }
    assertCompositionAuthorityCurrent(context, revision, revision, operation);
    // External ownership may still be current while this process has already
    // observed a local selection/current-pointer change. Run the same-connection
    // synchronous store fence last, after every await and external assertion.
    const assertLocalCurrent = requiredPort(ports, "storage.assertCurrentComposition", operation);
    let localCurrent;
    try {
      localCurrent = assertLocalCurrent(Object.freeze({ scope: context.scope,
        composition_id: revision.composition_id, design_version_id: context.design.design_version_id,
        revision_id: revision.revision_id, revision_sha256: revision.revision_sha256,
        selection_revision: revision.dependencies.selection_revision }));
    } catch (error) { throw safeError(error, operation); }
    if (localCurrent === null || typeof localCurrent !== "object" ||
        typeof localCurrent.then === "function" || localCurrent.status !== "current" ||
        localCurrent.composition_id !== revision.composition_id || localCurrent.revision_id !== revision.revision_id ||
        localCurrent.revision_sha256 !== revision.revision_sha256 ||
        localCurrent.design_version_id !== context.design.design_version_id ||
        localCurrent.selection_revision !== revision.dependencies.selection_revision) {
      throw new CreativeApiError("stale_version", operation, "composition.current");
    }
    const result = Object.freeze({ composition: createCompositionProductionEnvelope(revision), status: "current",
      preview_access: compositionPreviewAccess(revision, previewBytes) });
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: "1.2",
      result }), operation);
  }

  async function executeCompositionMutation(principal, request, started) {
    const operation = request.operation;
    const scope = started.scope;
    // This request crosses several awaits (context reads, owner resolution,
    // preview preparation, and publication). Copy the caller's typed plan once
    // so later mutation cannot change the plan that is hashed, staged, or
    // recorded in the immutable action intent.
    let requestedPlan = null;
    if (operation === "composition.update") {
      try { requestedPlan = snapshotCompositionJson(request.payload.plan); }
      catch { throw new CreativeApiError("invalid_request", operation, "plan"); }
    }
    const context = await readCompositionContext(principal, request, scope);
    const getCurrent = requiredPort(ports, "storage.getCurrentComposition", operation);
    const stored = await getCurrent(Object.freeze({ scope: context.scope, design_version_id: context.design.design_version_id }));
    if (operation === "composition.create" && stored !== null) {
      throw new CreativeApiError("conflict", operation, "composition.current");
    }
    let storedCurrent = null;
    let storedPreviewBytes = null;
    if (operation === "composition.update") {
      let storedSnapshot;
      try { storedSnapshot = snapshotCompositionBytesRecord(stored); }
      catch {
        throw new CreativeApiError("stale_version", operation, "composition.current");
      }
      storedPreviewBytes = storedSnapshot.bytes;
      storedCurrent = validateCurrentCompositionRevision(storedSnapshot.metadata.revision, storedPreviewBytes,
        context.scope, operation);
    }
    const authority = requiredPort(ports, "composition.resolveCurrent", operation);
    let rawSource;
    try { rawSource = await authority(compositionOwnerInput(context)); }
    catch { throw new CreativeApiError("unavailable", operation, "composition.authority"); }
    const source = await validateCompositionOwnerSource(rawSource, context, operation);
    const currentRevision = source.revision;
    let revision = currentRevision;
    let previewBytes = source.preview_bytes;
    let expectedCurrent = null;
    let plan = null;
    let alreadyStaged = false;
    if (operation === "composition.create") {
      if (revision.parent_revision_id !== null || revision.parent_revision_sha256 !== null) {
        throw new CreativeApiError("unavailable", operation, "composition.initial_history");
      }
    } else {
      if (canonicalSerialize(currentRevision) !== canonicalSerialize(storedCurrent) ||
          !Buffer.from(source.preview_bytes).equals(Buffer.from(storedPreviewBytes))) {
        throw new CreativeApiError("stale_version", operation, "composition.owner_revision");
      }
      expectedCurrent = Object.freeze({ revision_id: currentRevision.revision_id,
        revision_sha256: currentRevision.revision_sha256 });
      assertCompositionAuthorityCurrent(context, currentRevision, currentRevision, operation);

      // Rebuild the plan from the trusted current binding and exact manifest,
      // then require byte-for-byte canonical equality with the submitted plan.
      // This applies the C04 closed-manifest rules without placing geometry in
      // the legacy approval hash.
      try {
        plan = createCompositionEditPlan({ plan_id: requestedPlan?.plan_id, binding: currentRevision.binding,
          layer_manifest: currentRevision.layer_manifest,
          target_composition_revision_id: requestedPlan?.target_composition_revision_id,
          operations: requestedPlan?.operations, trustedScope: context.scope });
      } catch (error) { throw safeError(error, operation); }
      const stalePlanFields = ["tenant_id", "project_id", "base_design_version_id", "base_artwork_sha256",
        "base_brief_id", "base_brief_sha256", "base_facts_revision_id", "base_facts_sha256",
        "base_composition_id", "base_composition_revision_id", "base_composition_sha256"];
      if (stalePlanFields.some((field) => requestedPlan?.[field] !== plan[field])) {
        throw new CreativeApiError("stale_version", operation, "plan.base_binding");
      }
      if (canonicalSerialize(plan) !== canonicalSerialize(requestedPlan)) {
        throw new CreativeApiError("invalid_request", operation, "plan");
      }
      let applied;
      try { applied = applyCompositionPlan(currentRevision, plan, context.scope); }
      catch (error) { throw safeError(error, operation); }
      const binding = { ...currentRevision.binding,
        composition: { ...currentRevision.binding.composition, revision_id: applied.revision_id } };
      binding.composition.sha256 = hashCompositionLayerManifest({ binding, artifact: currentRevision.artwork,
        layer_manifest: applied.layer_manifest, trustedScope: context.scope });
      const { preview_sha256: _preview_sha256, ...bindingWithoutPreview } = binding;
      const candidate = { tenant_id: context.scope.tenant_id, project_id: context.scope.project_id,
        brief_id: context.scope.brief_id, composition_id: currentRevision.composition_id,
        revision_id: applied.revision_id, parent_revision_id: currentRevision.revision_id,
        parent_revision_sha256: currentRevision.revision_sha256, binding: bindingWithoutPreview,
        artwork: currentRevision.artwork, layer_manifest: applied.layer_manifest, geometry: applied.geometry,
        dependencies: Object.fromEntries(Object.entries(currentRevision.dependencies)
          .filter(([key]) => key !== "authority_proof")) };
      const targetStateHash = compositionStateHash(candidate);
      const intentCandidate = snapshotCompositionJson(candidate);
      const intent = Object.freeze({ contract: "CreativeCompositionActionIntent", schema_version: "1.0",
        operation, composition_id: currentRevision.composition_id, candidate_revision_id: applied.revision_id,
        source_revision_id: currentRevision.revision_id, source_revision_sha256: currentRevision.revision_sha256,
        plan });
      const begin = requiredPort(ports, "storage.beginCompositionAction", operation);
      const action = await begin(Object.freeze({ scope: context.scope, actor_id: principal.actor_id,
        job_id: started.job_id, lease_token: started.lease_token, action_id: request.action_id,
        operation, request_hash: started.request_hash, intent, expected_current: expectedCurrent,
        expected_design_version_id: context.design.design_version_id,
        expected_design_hash: context.design.design_hash, expected_selection_revision: context.selection.revision }));
      if (!isRecord(action) || action.status === "conflict") throw new CreativeApiError("conflict", operation, "action_id");
      if (action.status === "stale") throw new CreativeApiError("stale_version", operation, "composition.current");
      if (!["pending", "staged"].includes(action.status) || action.action_id !== request.action_id || action.job_id !== started.job_id ||
          action.request_hash !== started.request_hash || action.intent?.candidate_revision_id !== applied.revision_id) {
        throw new CreativeApiError("failed", operation, "composition.action");
      }
      if (action.status === "staged") {
        if (!action.revision || !(action.preview_bytes instanceof Uint8Array) ||
            action.revision.state_sha256 !== targetStateHash ||
            action.revision.parent_revision_id !== currentRevision.revision_id ||
            action.revision.parent_revision_sha256 !== currentRevision.revision_sha256 ||
            canonicalSerialize(action.intent.plan) !== canonicalSerialize(plan)) {
          throw new CreativeApiError("failed", operation, "composition.action.staged_identity");
        }
        revision = action.revision;
        try { previewBytes = snapshotCompositionBytesRecord({ preview_bytes: action.preview_bytes }).bytes; }
        catch { throw new CreativeApiError("failed", operation, "composition.action.preview_bytes"); }
        alreadyStaged = true;
      } else {
        const preparePreview = requiredPort(ports, "composition.preparePreview", operation);
        let rawPreview;
        try {
          rawPreview = await preparePreview(Object.freeze({ contract: "CreativeCompositionPreview", schema_version: "1.1",
            scope: context.scope, actor_id: principal.actor_id, action_id: request.action_id,
            request_hash: started.request_hash,
            idempotency_key: `composition-preview:${canonicalHash({ scope: context.scope,
              action_id: request.action_id, request_hash: started.request_hash, candidate_sha256: targetStateHash })}`,
            base_revision: currentRevision,
            candidate: Object.freeze({ composition_id: intentCandidate.composition_id,
              revision_id: intentCandidate.revision_id, parent_revision_id: intentCandidate.parent_revision_id,
              parent_revision_sha256: intentCandidate.parent_revision_sha256, binding: intentCandidate.binding,
              artwork: intentCandidate.artwork, layer_manifest: intentCandidate.layer_manifest,
              geometry: intentCandidate.geometry, dependencies: intentCandidate.dependencies,
              state_sha256: targetStateHash }) }));
        } catch { throw new CreativeApiError("unavailable", operation, "composition.preview"); }
        let copiedPreview;
        try { copiedPreview = snapshotCompositionBytesRecord(rawPreview); }
        catch { throw new CreativeApiError("failed", operation, "composition.preview"); }
        const previewResult = copiedPreview.metadata;
        assertOnlyKeys(previewResult, ["contract", "schema_version", "preview", "authority_proof"], "composition.preview");
        if (previewResult.contract !== "CreativeCompositionPreview" || previewResult.schema_version !== "1.1" ||
            !isRecord(previewResult.preview) || !isRecord(previewResult.authority_proof)) {
          throw new CreativeApiError("unavailable", operation, "composition.preview.contract");
        }
        const withPreviewBinding = { ...intentCandidate.binding,
          preview_sha256: previewResult.preview.preview_sha256?.slice?.("sha256:".length) };
        const rawRevision = { ...intentCandidate, binding: withPreviewBinding,
          dependencies: { ...intentCandidate.dependencies, authority_proof: previewResult.authority_proof },
          preview: previewResult.preview };
        try { ({ revision, preview_bytes: previewBytes } = createCompositionRevision(rawRevision, {
          trustedScope: context.scope, previewBytes: copiedPreview.bytes, nowMs: now() })); }
        catch (error) { throw safeError(error, operation); }
        let decodedPreview;
        try { decodedPreview = await inspectOpenAIImageBytes(previewBytes); }
        catch { throw new CreativeApiError("failed", operation, "composition.preview.decode"); }
        const expectedMimeType = IMAGE_MIME_BY_FORMAT[decodedPreview.format];
        if (!expectedMimeType || revision.preview.mime_type !== expectedMimeType ||
            revision.preview.width_px !== decodedPreview.width || revision.preview.height_px !== decodedPreview.height ||
            revision.preview.byte_length !== previewBytes.byteLength || revision.preview.preview_sha256 !== hashArtifactBytes(previewBytes)) {
          throw new CreativeApiError("failed", operation, "composition.preview.metadata");
        }
      }
    }

    if (operation === "composition.create") {
      const intent = Object.freeze({ contract: "CreativeCompositionActionIntent", schema_version: "1.0",
        operation, composition_id: revision.composition_id, candidate_revision_id: revision.revision_id,
        source_revision_id: null, source_revision_sha256: null, plan: null });
      const begin = requiredPort(ports, "storage.beginCompositionAction", operation);
      const action = await begin(Object.freeze({ scope: context.scope, actor_id: principal.actor_id,
        job_id: started.job_id, lease_token: started.lease_token, action_id: request.action_id,
        operation, request_hash: started.request_hash, intent, expected_current: null,
        expected_design_version_id: context.design.design_version_id,
        expected_design_hash: context.design.design_hash, expected_selection_revision: context.selection.revision }));
      if (!isRecord(action) || action.status === "conflict") throw new CreativeApiError("conflict", operation, "action_id");
      if (action.status === "stale") throw new CreativeApiError("stale_version", operation, "composition.current");
      if (!["pending", "staged"].includes(action.status) || action.action_id !== request.action_id || action.job_id !== started.job_id ||
          action.request_hash !== started.request_hash || action.intent?.candidate_revision_id !== revision.revision_id) {
        throw new CreativeApiError("failed", operation, "composition.action");
      }
      if (action.status === "staged") {
        if (!action.revision || !(action.preview_bytes instanceof Uint8Array) ||
            canonicalSerialize(action.revision) !== canonicalSerialize(revision) ||
            !Buffer.from(action.preview_bytes).equals(Buffer.from(previewBytes))) {
          throw new CreativeApiError("failed", operation, "composition.action.staged_identity");
        }
        revision = action.revision;
        try { previewBytes = snapshotCompositionBytesRecord({ preview_bytes: action.preview_bytes }).bytes; }
        catch { throw new CreativeApiError("failed", operation, "composition.action.preview_bytes"); }
        alreadyStaged = true;
      }
    }
    if (!alreadyStaged) {
      const stage = requiredPort(ports, "storage.stageCompositionRevision", operation);
      const staged = await stage(Object.freeze({ scope: context.scope, actor_id: principal.actor_id,
        job_id: started.job_id, lease_token: started.lease_token, action_id: request.action_id,
        request_hash: started.request_hash, revision, preview_bytes: previewBytes }));
      if (!isRecord(staged) || staged.status === "conflict") throw new CreativeApiError("conflict", operation, "composition.stage");
      if (staged.status !== "staged" || staged.revision?.revision_sha256 !== revision.revision_sha256 ||
          !(staged.preview_bytes instanceof Uint8Array) || !Buffer.from(snapshotCompositionBytesRecord({
            preview_bytes: staged.preview_bytes }).bytes).equals(Buffer.from(previewBytes))) {
        throw new CreativeApiError("failed", operation, "composition.stage");
      }
    }
    const result = Object.freeze({ status: "saved", composition: createCompositionProductionEnvelope(revision),
      revision_sha256: revision.revision_sha256, selection_revision: context.selection.revision,
      preview_access: compositionPreviewAccess(revision, previewBytes) });
    const fence = creativeContextFence(context.brief, context.design, context.design.design_version_id,
      context.design.design_hash, { composition: Object.freeze({ composition_id: revision.composition_id,
        action_id: request.action_id, job_id: started.job_id, target_revision_id: revision.revision_id,
        target_revision_sha256: revision.revision_sha256, expected_current_revision_id: expectedCurrent?.revision_id ?? null,
        expected_current_revision_sha256: expectedCurrent?.revision_sha256 ?? null }) });
    const job = await publish(principal, request, started, result, (transaction) => {
      const commit = requiredPort(ports, "storage.commitCompositionRevision", operation);
      const committed = commit(Object.freeze({ scope: context.scope, actor_id: principal.actor_id,
        job_id: started.job_id, action_id: request.action_id, request_hash: started.request_hash,
        revision_sha256: revision.revision_sha256 }), transaction);
      if (committed !== null && typeof committed === "object" && typeof committed.then === "function") {
        throw new CreativeApiError("failed", operation, "composition.commit_async");
      }
      if (!isRecord(committed) || committed.status !== "saved" ||
          committed.composition?.revision_sha256 !== revision.revision_sha256) {
        throw new CreativeApiError("stale_version", operation, "composition.commit");
      }
    }, fence, () => {
      validateCurrentCompositionRevision(revision, previewBytes, context.scope, operation);
      assertCompositionAuthorityCurrent(context, revision, expectedCurrent ? currentRevision : null, operation);
      // The owner assertion is synchronous but may advance a fake clock or
      // observe a revocation at its boundary. Recheck every local proof window
      // after that callback; commitCompositionRevision rechecks the active job
      // lease and same-store context under the publication transaction.
      validateCurrentCompositionRevision(revision, previewBytes, context.scope, operation);
      return true;
    });
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: "1.2",
      operation_id: job.job_id, job: publicJob(job, job.job_id), result }), operation);
  }

  async function executeCompositionRevalidation(principal, request, started) {
    const operation = request.operation;
    const context = await readCompositionContext(principal, request, started.scope);
    const getIdentity = requiredPort(ports, "storage.getCurrentCompositionIdentity", operation);
    const current = await getIdentity(Object.freeze({ scope: context.scope,
      design_version_id: context.design.design_version_id }));
    if (!isRecord(current) || current.revision_id !== request.payload.expected_current_revision_id ||
        current.revision_sha256 !== request.payload.expected_current_revision_sha256 ||
        current.design_version_id !== context.design.design_version_id || current.design_version_sha256 !== context.design.design_hash) {
      throw new CreativeApiError("stale_version", operation, "expected_current");
    }
    const getRevision = requiredPort(ports, "storage.getCompositionRevision", operation);
    let storedParent;
    try {
      storedParent = await getRevision(Object.freeze({ scope: context.scope, composition_id: current.composition_id,
        revision_id: current.revision_id }));
    } catch (error) { throw safeError(error, operation); }
    if (!isRecord(storedParent) || !(storedParent.preview_bytes instanceof Uint8Array)) {
      throw new CreativeApiError("failed", operation, "composition.history_revision");
    }
    let parent;
    try { parent = validateCompositionRevision(storedParent.revision, { trustedScope: context.scope,
      previewBytes: storedParent.preview_bytes, allowExpired: true }); }
    catch (error) { throw safeError(error, operation); }
    if (parent.revision_id !== request.payload.expected_current_revision_id ||
        parent.revision_sha256 !== request.payload.expected_current_revision_sha256 ||
        parent.composition_id !== current.composition_id || parent.dependencies.design_version_id !== context.design.design_version_id ||
        parent.dependencies.design_version_sha256 !== context.design.design_hash ||
        parent.dependencies.brief_hash !== canonicalHash(context.brief) ||
        parent.dependencies.facts_revision_id !== context.research.event_id ||
        parent.dependencies.facts_sha256 !== canonicalHash(context.brief.facts) ||
        parent.dependencies.package_id !== context.research.package_id ||
        parent.dependencies.package_sha256 !== context.package_hash ||
        parent.dependencies.artwork_sha256 !== context.design.artifact.content_hash ||
        parent.dependencies.parent_version_id !== context.design.parent_version_id ||
        parent.dependencies.parent_design_hash !== (context.parent?.design_hash ?? null) ||
        parent.artwork.artifact_id !== context.design.artifact.artifact_id ||
        parent.artwork.sha256 !== context.design.artifact.content_hash.slice(7) ||
        parent.binding.brief.sha256 !== canonicalHash(context.brief).slice(7) ||
        parent.binding.facts.revision_id !== context.research.event_id ||
        parent.binding.facts.sha256 !== canonicalHash(context.brief.facts).slice(7)) {
      throw new CreativeApiError("stale_version", operation, "composition.revalidation_context");
    }
    const candidateRevisionId = boundedString(request.payload.candidate_revision_id, "payload.candidate_revision_id");
    if (candidateRevisionId === parent.revision_id) throw new CreativeApiError("invalid_request", operation, "candidate_revision_id");
    const expectedCurrent = Object.freeze({ revision_id: parent.revision_id, revision_sha256: parent.revision_sha256 });
    const intent = Object.freeze({ contract: "CreativeCompositionActionIntent", schema_version: "1.1",
      operation, composition_id: parent.composition_id, candidate_revision_id: candidateRevisionId,
      source_revision_id: parent.revision_id, source_revision_sha256: parent.revision_sha256, plan: null });
    const begin = requiredPort(ports, "storage.beginCompositionAction", operation);
    const action = await begin(Object.freeze({ scope: context.scope, actor_id: principal.actor_id,
      job_id: started.job_id, lease_token: started.lease_token, action_id: request.action_id,
      operation, request_hash: started.request_hash, intent, expected_current: expectedCurrent,
      expected_design_version_id: context.design.design_version_id,
      expected_design_hash: context.design.design_hash, expected_selection_revision: context.selection.revision }));
    if (!isRecord(action) || action.status === "conflict") throw new CreativeApiError("conflict", operation, "action_id");
    if (action.status === "stale") throw new CreativeApiError("stale_version", operation, "composition.current");
    if (!["pending", "staged"].includes(action.status) || action.action_id !== request.action_id ||
        action.job_id !== started.job_id || action.request_hash !== started.request_hash ||
        action.operation !== operation || canonicalSerialize(action.intent) !== canonicalSerialize(intent) ||
        canonicalSerialize(action.expected_current) !== canonicalSerialize(expectedCurrent)) {
      throw new CreativeApiError("failed", operation, "composition.action");
    }
    let revision;
    let previewBytes;
    let alreadyStaged = false;
    if (action.status === "staged") {
      if (!action.revision || !(action.preview_bytes instanceof Uint8Array) ||
          action.revision.revision_id !== candidateRevisionId || action.revision.parent_revision_id !== parent.revision_id ||
          action.revision.parent_revision_sha256 !== parent.revision_sha256 ||
          canonicalSerialize(action.revision.artwork) !== canonicalSerialize(parent.artwork) ||
          canonicalSerialize(action.revision.layer_manifest) !== canonicalSerialize(parent.layer_manifest) ||
          canonicalSerialize(action.revision.geometry) !== canonicalSerialize(parent.geometry)) {
        throw new CreativeApiError("failed", operation, "composition.action.staged_identity");
      }
      revision = action.revision;
      previewBytes = Uint8Array.from(action.preview_bytes);
      alreadyStaged = true;
    } else {
      const resolve = requiredPort(ports, "composition.resolveRevalidation", operation);
      let rawEvidence;
      try {
        rawEvidence = await resolve(Object.freeze({ contract: "CreativeCompositionRevalidationRequest", schema_version: "1.0",
          scope: context.scope, actor_id: principal.actor_id, action_id: request.action_id,
          request_hash: started.request_hash, composition_id: parent.composition_id,
          expected_current: Object.freeze({ revision_id: parent.revision_id, revision_sha256: parent.revision_sha256 }),
          candidate_revision_id: candidateRevisionId, base_revision: parent,
          brief: context.brief, brief_hash: canonicalHash(context.brief), selected_design: context.design,
          selection_revision: context.selection.revision, research_package: context.research, package_hash: context.package_hash }));
      } catch (error) {
        if (error instanceof CreativeApiError || error instanceof CreativeCompositionContractError ||
            error instanceof CreativePlanningError || error?.module === "creative-engine.versions") {
          throw safeError(error, operation);
        }
        throw new CreativeApiError("unavailable", operation, "composition.revalidation_evidence", { retryable: true });
      }
      let evidence;
      try { evidence = immutableRequestSnapshot(rawEvidence); }
      catch { throw new CreativeApiError("failed", operation, "composition.revalidation_evidence"); }
      assertOnlyKeys(evidence, ["contract", "schema_version", "scope", "composition_id", "expected_current",
        "candidate_revision_id", "brief_hash", "facts_revision_id", "facts_sha256", "package_id", "package_sha256",
        "design_version_id", "design_version_sha256", "selection_revision", "asset_rights", "edit_policy"],
      "composition.revalidation_evidence");
      if (evidence.contract !== "CreativeCompositionRevalidationEvidence" || evidence.schema_version !== "1.0" ||
          !Array.isArray(evidence.asset_rights) || !isRecord(evidence.edit_policy)) {
        throw new CreativeApiError("failed", operation, "composition.revalidation_evidence");
      }
      if (!isRecord(evidence.scope) || evidence.scope.tenant_id !== context.scope.tenant_id ||
          evidence.scope.project_id !== context.scope.project_id || evidence.scope.brief_id !== context.scope.brief_id) {
        throw new CreativeApiError("scope_denied", operation, "composition.revalidation_evidence.scope");
      }
      if (evidence.composition_id !== parent.composition_id || evidence.candidate_revision_id !== candidateRevisionId ||
          canonicalSerialize(evidence.expected_current) !== canonicalSerialize(expectedCurrent) ||
          evidence.brief_hash !== canonicalHash(context.brief) || evidence.facts_revision_id !== context.research.event_id ||
          evidence.facts_sha256 !== canonicalHash(context.brief.facts) || evidence.package_id !== context.research.package_id ||
          evidence.package_sha256 !== context.package_hash || evidence.design_version_id !== context.design.design_version_id ||
          evidence.design_version_sha256 !== context.design.design_hash || evidence.selection_revision !== context.selection.revision) {
        throw new CreativeApiError("stale_version", operation, "composition.revalidation_evidence");
      }
      const previousPolicy = parent.dependencies.edit_policy;
      if (previousPolicy) {
        const nextPolicy = evidence.edit_policy;
        const preservesRestrictions = Array.isArray(nextPolicy.locked_layer_ids) &&
          Array.isArray(nextPolicy.factual_text_layers) &&
          previousPolicy.locked_layer_ids.every((id) => nextPolicy.locked_layer_ids.includes(id)) &&
          previousPolicy.factual_text_layers.every((priorFact) => nextPolicy.factual_text_layers.some((nextFact) =>
            canonicalSerialize(nextFact) === canonicalSerialize(priorFact)));
        if (!preservesRestrictions) {
          throw new CreativeApiError("permission_denied", operation, "composition.revalidation_policy");
        }
      }
      const binding = { ...parent.binding,
        composition: { ...parent.binding.composition, revision_id: candidateRevisionId },
        action_id: request.action_id, actor_id: principal.actor_id };
      binding.composition.sha256 = hashCompositionLayerManifest({ binding, artifact: parent.artwork,
        layer_manifest: parent.layer_manifest, trustedScope: context.scope });
      const { preview_sha256: _previewSha256, ...bindingWithoutPreview } = binding;
      const dependencies = { ...parent.dependencies, selection_revision: context.selection.revision,
        asset_rights: evidence.asset_rights, edit_policy: evidence.edit_policy };
      delete dependencies.authority_proof;
      const candidate = { tenant_id: context.scope.tenant_id, project_id: context.scope.project_id,
        brief_id: context.scope.brief_id, composition_id: parent.composition_id, revision_id: candidateRevisionId,
        parent_revision_id: parent.revision_id, parent_revision_sha256: parent.revision_sha256,
        binding: bindingWithoutPreview, artwork: parent.artwork, layer_manifest: parent.layer_manifest,
        geometry: parent.geometry, dependencies };
      const targetStateHash = compositionStateHash(candidate);
      const permissions = new Map(context.brief.permissions.items.map((item) => [`${item.asset_id}\u0000${item.action}`, item.status]));
      const researchPermissions = new Map(context.research.permissions.items.map((item) => [`${item.asset_id}\u0000${item.action}`, item.status]));
      for (const asset of parent.binding.assets) {
        const sourceAsset = context.research.assets.items.find((item) => item.asset_id === asset.asset_id);
        const requiredActions = ["display", "reproduce", ...(parent.layer_manifest.some((layer) =>
          layer.kind === "approved_asset" && layer.asset_id === asset.asset_id) ? ["modify"] : [])];
        const rights = evidence.asset_rights.filter((proof) => proof?.asset_id === asset.asset_id);
        if (!sourceAsset || sourceAsset.content_hash !== `sha256:${asset.sha256}` ||
            requiredActions.some((actionName) => permissions.get(`${asset.asset_id}\u0000${actionName}`) !== "granted" ||
              researchPermissions.get(`${asset.asset_id}\u0000${actionName}`) !== "granted" ||
              !rights.some((proof) => proof.action === actionName && proof.source_ref === sourceAsset.source_id &&
                proof.content_hash === sourceAsset.content_hash))) {
          throw new CreativeApiError("permission_denied", operation, "composition.asset_rights");
        }
        const isFenced = requiredPort(ports, "storage.isAssetFenced", operation);
        if (await isFenced(Object.freeze({ scope: context.scope, asset_id: asset.asset_id,
          content_hash: sourceAsset.content_hash }))) throw new CreativeApiError("permission_denied", operation, "asset_invalidation");
        const readAsset = requiredPort(ports, "composition.readApprovedAssetBytes", operation);
        let rawAsset;
        try { rawAsset = await readAsset(Object.freeze({ scope: context.scope, asset_id: asset.asset_id,
          content_hash: sourceAsset.content_hash, package_id: context.research.package_id,
          package_hash: context.package_hash, permission_ref: asset.permission_ref })); }
        catch { throw new CreativeApiError("unavailable", operation, "composition.asset_bytes"); }
        let copiedAsset;
        try { copiedAsset = snapshotCompositionBytesRecord(rawAsset, "bytes"); }
        catch { throw new CreativeApiError("failed", operation, "composition.asset_bytes"); }
        const assetRecord = copiedAsset.metadata;
        assertOnlyKeys(assetRecord, ["asset_id", "content_hash", "mime_type"], "composition.asset_bytes");
        if (assetRecord.asset_id !== asset.asset_id || assetRecord.content_hash !== sourceAsset.content_hash ||
            assetRecord.mime_type !== sourceAsset.media_type || hashArtifactBytes(copiedAsset.bytes) !== sourceAsset.content_hash) {
          throw new CreativeApiError("failed", operation, "composition.asset_bytes.hash");
        }
        try { await inspectOpenAIImageBytes(copiedAsset.bytes); }
        catch { throw new CreativeApiError("failed", operation, "composition.asset_bytes.decode"); }
      }
      const preparePreview = requiredPort(ports, "composition.preparePreview", operation);
      let rawPreview;
      try {
        rawPreview = await preparePreview(Object.freeze({ contract: "CreativeCompositionPreview", schema_version: "1.1",
          scope: context.scope, actor_id: principal.actor_id, action_id: request.action_id,
          request_hash: started.request_hash,
          idempotency_key: `composition-preview:${canonicalHash({ scope: context.scope,
            action_id: request.action_id, request_hash: started.request_hash, candidate_sha256: targetStateHash })}`,
          base_revision: parent, candidate: Object.freeze({ ...candidate, state_sha256: targetStateHash }) }));
      } catch { throw new CreativeApiError("unavailable", operation, "composition.preview"); }
      let copiedPreview;
      try { copiedPreview = snapshotCompositionBytesRecord(rawPreview); }
      catch { throw new CreativeApiError("failed", operation, "composition.preview"); }
      const previewResult = copiedPreview.metadata;
      assertOnlyKeys(previewResult, ["contract", "schema_version", "preview", "authority_proof"], "composition.preview");
      if (previewResult.contract !== "CreativeCompositionPreview" || previewResult.schema_version !== "1.1" ||
          !isRecord(previewResult.preview) || !isRecord(previewResult.authority_proof)) {
        throw new CreativeApiError("unavailable", operation, "composition.preview.contract");
      }
      const withPreviewBinding = { ...candidate.binding,
        preview_sha256: previewResult.preview.preview_sha256?.slice?.("sha256:".length) };
      try { ({ revision, preview_bytes: previewBytes } = createCompositionRevision({ ...candidate,
        binding: withPreviewBinding, dependencies: { ...candidate.dependencies,
          authority_proof: previewResult.authority_proof }, preview: previewResult.preview },
      { trustedScope: context.scope, previewBytes: copiedPreview.bytes, nowMs: now() })); }
      catch (error) { throw safeError(error, operation); }
      if (canonicalSerialize(revision.artwork) !== canonicalSerialize(parent.artwork) ||
          canonicalSerialize(revision.layer_manifest) !== canonicalSerialize(parent.layer_manifest) ||
          canonicalSerialize(revision.geometry) !== canonicalSerialize(parent.geometry)) {
        throw new CreativeApiError("failed", operation, "composition.revalidation_state");
      }
      let decodedPreview;
      try { decodedPreview = await inspectOpenAIImageBytes(previewBytes); }
      catch { throw new CreativeApiError("failed", operation, "composition.preview.decode"); }
      const expectedMimeType = IMAGE_MIME_BY_FORMAT[decodedPreview.format];
      if (!expectedMimeType || revision.preview.mime_type !== expectedMimeType ||
          revision.preview.width_px !== decodedPreview.width || revision.preview.height_px !== decodedPreview.height ||
          revision.preview.byte_length !== previewBytes.byteLength || revision.preview.preview_sha256 !== hashArtifactBytes(previewBytes)) {
        throw new CreativeApiError("failed", operation, "composition.preview.metadata");
      }
    }
    if (!alreadyStaged) {
      const stage = requiredPort(ports, "storage.stageCompositionRevision", operation);
      const staged = await stage(Object.freeze({ scope: context.scope, actor_id: principal.actor_id,
        job_id: started.job_id, lease_token: started.lease_token, action_id: request.action_id,
        request_hash: started.request_hash, revision, preview_bytes: previewBytes }));
      if (!isRecord(staged) || staged.status !== "staged" ||
          staged.revision?.revision_sha256 !== revision.revision_sha256 || !(staged.preview_bytes instanceof Uint8Array) ||
          !Buffer.from(staged.preview_bytes).equals(Buffer.from(previewBytes))) {
        throw new CreativeApiError("failed", operation, "composition.stage");
      }
    }
    const result = Object.freeze({ contract: "CreativeCompositionRevalidationResult", schema_version: "1.0",
      status: "saved", composition: createCompositionProductionEnvelope(revision),
      revision_sha256: revision.revision_sha256, selection_revision: context.selection.revision,
      preview_access: compositionPreviewAccess(revision, previewBytes) });
    const fence = creativeContextFence(context.brief, context.design, context.design.design_version_id,
      context.design.design_hash, { composition: Object.freeze({ composition_id: revision.composition_id,
        action_id: request.action_id, job_id: started.job_id, target_revision_id: revision.revision_id,
        target_revision_sha256: revision.revision_sha256, expected_current_revision_id: parent.revision_id,
        expected_current_revision_sha256: parent.revision_sha256 }) });
    const job = await publish(principal, request, started, result, (transaction) => {
      const commit = requiredPort(ports, "storage.commitCompositionRevision", operation);
      const committed = commit(Object.freeze({ scope: context.scope, actor_id: principal.actor_id,
        job_id: started.job_id, action_id: request.action_id, request_hash: started.request_hash,
        revision_sha256: revision.revision_sha256 }), transaction);
      if (committed !== null && typeof committed === "object" && typeof committed.then === "function") {
        throw new CreativeApiError("failed", operation, "composition.commit_async");
      }
      if (!isRecord(committed) || committed.status !== "saved" ||
          committed.composition?.revision_sha256 !== revision.revision_sha256) {
        throw new CreativeApiError("stale_version", operation, "composition.commit");
      }
    }, fence, () => {
      validateCurrentCompositionRevision(revision, previewBytes, context.scope, operation);
      assertCompositionAuthorityCurrent(context, revision, parent, operation);
      validateCurrentCompositionRevision(revision, previewBytes, context.scope, operation);
      return true;
    });
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: "1.3",
      operation_id: job.job_id, job: publicJob(job, job.job_id), result }), operation);
  }

  function inspectionAssetUseSet(design, brief, operation) {
    const value = design.creative_asset_use;
    if (value === undefined) return Object.freeze({ status: "unknown", entries: Object.freeze([]) });
    if (!isRecord(value) || value.contract !== "CreativeAssetUseSet" || value.schema_version !== "1.0" ||
      value.status !== "verified" || value.brief_hash !== canonicalHash(brief) || !Array.isArray(value.entries) ||
      value.entries.length > 64) {
      throw new CreativeApiError("unavailable", operation, "asset_use_evidence");
    }
    const entries = [];
    const seen = new Set();
    for (let index = 0; index < value.entries.length; index += 1) {
      const item = value.entries[index];
      const field = `asset_use_evidence.entries[${index}]`;
      assertOnlyKeys(item, ["asset_id", "action", "source_ref", "content_hash", "package_id", "package_hash"], field);
      for (const key of ["asset_id", "source_ref", "package_id"]) boundedString(item[key], `${field}.${key}`, 256);
      if (!["reproduce", "modify"].includes(item.action) || typeof item.content_hash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(item.content_hash) || typeof item.package_hash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(item.package_hash) ||
        !brief.source_identity.some((source) => source.source_id === item.source_ref)) {
        throw new CreativeApiError("unavailable", operation, "asset_use_evidence");
      }
      const identity = `${item.asset_id}\u0000${item.action}`;
      if (seen.has(identity)) throw new CreativeApiError("unavailable", operation, "asset_use_evidence");
      seen.add(identity);
      entries.push(Object.freeze({ asset_id: item.asset_id, action: item.action, source_ref: item.source_ref,
        content_hash: item.content_hash, package_id: item.package_id, package_hash: item.package_hash }));
    }
    return Object.freeze({ status: "verified", brief_hash: value.brief_hash, entries: Object.freeze(entries) });
  }

  async function verifyInspectionAssetRights(scope, brief, assetUse, operation) {
    if (assetUse.status !== "verified" || assetUse.entries.length === 0) return Object.freeze([]);
    const getPackage = requiredPort(ports, "planning.getCurrentResearchPackage", operation);
    const verifier = ports.planning?.assetPermissionVerifier;
    if (!isRecord(verifier) || typeof verifier.verifyAssetUse !== "function" ||
      typeof ports.storage?.isAssetFenced !== "function") {
      throw new CreativeApiError("unavailable", operation, "asset_permission_verifier");
    }
    let research;
    try { research = normalizeResearchPackage(immutableRequestSnapshot(await getPackage(Object.freeze({ scope }))), scope); }
    catch { throw new CreativeApiError("unavailable", operation, "research_package"); }
    const packageHash = canonicalHash(research);
    if (research.package_id !== brief.research_package_ref.package_id || packageHash !== brief.research_package_ref.content_hash) {
      throw new CreativeApiError("stale_version", operation, "research_package_hash");
    }
    const checked = [];
    for (const entry of assetUse.entries) {
      const asset = research.assets.items.find((item) => item.asset_id === entry.asset_id);
      const packagePermission = research.permissions.items.find((item) => item.asset_id === entry.asset_id && item.action === entry.action);
      const briefPermission = brief.permissions.items.find((item) => item.asset_id === entry.asset_id && item.action === entry.action);
      if (!asset || asset.source_id !== entry.source_ref || asset.content_hash !== entry.content_hash ||
        asset.media_type === undefined || entry.package_id !== research.package_id || entry.package_hash !== packageHash ||
        packagePermission?.status !== "granted" || briefPermission?.status !== "granted") {
        throw new CreativeApiError("permission_denied", operation, "asset_permission");
      }
      let evidence;
      try {
        evidence = await verifier.verifyAssetUse({ tenant_id: scope.tenant_id, project_id: scope.project_id,
          asset_id: asset.asset_id, content_hash: asset.content_hash, action: entry.action,
          package_id: research.package_id, package_hash: packageHash, now: new Date(now()).toISOString() });
      } catch { throw new CreativeApiError("unavailable", operation, "asset_permission_verifier", { retryable: true }); }
      const verifiedAt = new Date(now()).getTime();
      if (!isRecord(evidence) || evidence.status !== "granted" || evidence.owner_evidence_status !== "verified" ||
        evidence.tenant_id !== scope.tenant_id || evidence.project_id !== scope.project_id ||
        evidence.asset_id !== entry.asset_id || evidence.content_hash !== entry.content_hash ||
        evidence.action !== entry.action || evidence.package_id !== research.package_id || evidence.package_hash !== packageHash ||
        typeof evidence.evidence_ref !== "string" || !Number.isFinite(Date.parse(evidence.checked_at)) ||
        Date.parse(evidence.checked_at) > verifiedAt || !Number.isFinite(Date.parse(evidence.expires_at)) ||
        Date.parse(evidence.expires_at) <= verifiedAt) {
        throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
      }
      checked.push({ entry, expires_at: Date.parse(evidence.expires_at) });
    }
    let current;
    try { current = normalizeResearchPackage(immutableRequestSnapshot(await getPackage(Object.freeze({ scope }))), scope); }
    catch { throw new CreativeApiError("unavailable", operation, "research_package"); }
    if (current.package_id !== research.package_id || canonicalHash(current) !== packageHash) {
      throw new CreativeApiError("stale_version", operation, "research_package_hash");
    }
    for (const { entry } of checked) {
      if (await ports.storage.isAssetFenced(Object.freeze({ scope, asset_id: entry.asset_id, content_hash: entry.content_hash }))) {
        throw new CreativeApiError("permission_denied", operation, "asset_invalidation");
      }
    }
    const completedAt = new Date(now()).getTime();
    if (checked.some((item) => item.expires_at <= completedAt)) {
      throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
    }
    return Object.freeze(checked.map(({ entry, expires_at }) => Object.freeze({
      asset_id: entry.asset_id, action: entry.action, source_ref: entry.source_ref,
      content_hash: entry.content_hash, package_id: entry.package_id, package_hash: entry.package_hash,
      expires_at,
    })));
  }

  function assertRepairAuthorizationCurrent(repairAuthorization, operation = "edit") {
    if (!repairAuthorization) return true;
    const repairPort = ports.storage?.inspectionRepair;
    if (!isRecord(repairPort) || typeof repairPort.isClaimCurrent !== "function" ||
      !repairPort.isClaimCurrent({ scope: repairAuthorization.repairScope, proof: repairAuthorization.proof })) {
      throw new CreativeApiError("review_required", operation, "inspection_repair.limit");
    }
    return true;
  }

  async function verifyRequestedAssetPermissions(scope, brief, plan, operation, imageReferenceManifest,
    baseDesign, briefHash, conceptReferenceRequests = []) {
    const explicit = new Map();
    const sourceRefs = new Set(Array.isArray(plan.source_refs) ? plan.source_refs : []);
    for (const step of plan.steps ?? []) {
      for (const sourceRef of step.source_refs ?? []) sourceRefs.add(sourceRef);
      const action = step.action === "concept.generate" ? "reproduce" : "modify";
      const ids = [step.parameters?.asset_id,
        ...(Array.isArray(step.parameters?.changes) ? step.parameters.changes.map((change) => change?.asset_id) : [])]
        .filter((value) => value !== undefined);
      for (const assetId of ids) explicit.set(assetId, action);
    }
    if (operation === "concepts.create") {
      for (const reference of conceptReferenceRequests) explicit.set(reference.asset_id, "reproduce");
    }
    const getPackage = ports.planning?.getCurrentResearchPackage;
    if (typeof getPackage !== "function") {
      if (explicit.size > 0 || imageReferenceManifest !== undefined) {
        throw new CreativeApiError("unavailable", operation, "asset_permission_verifier");
      }
      return Object.freeze({ proofs: Object.freeze([]), image_reference_manifest: undefined });
    }
    let research;
    try {
      const raw = await getPackage(Object.freeze({ scope }));
      research = normalizeResearchPackage(immutableRequestSnapshot(raw), scope);
    } catch {
      throw new CreativeApiError("unavailable", operation, "research_package");
    }
    const packageHash = canonicalHash(research);
    if (research.package_id !== brief.research_package_ref.package_id ||
      packageHash !== brief.research_package_ref.content_hash) {
      throw new CreativeApiError("stale_version", operation, "research_package_hash");
    }
    let trustedImageReferenceManifest;
    if (imageReferenceManifest !== undefined) {
      if (operation !== "edit" || !baseDesign ||
        imageReferenceManifest.tenant_id !== scope.tenant_id ||
        imageReferenceManifest.project_id !== scope.project_id ||
        imageReferenceManifest.brief_id !== brief.brief_id || imageReferenceManifest.brief_hash !== briefHash ||
        imageReferenceManifest.research_package_id !== research.package_id ||
        imageReferenceManifest.research_package_hash !== packageHash ||
        imageReferenceManifest.base_design_version_id !== baseDesign.design_version_id ||
        imageReferenceManifest.base_design_hash !== baseDesign.design_hash) {
        throw new CreativeApiError("stale_version", operation, "image_reference_manifest.binding");
      }
      for (const reference of imageReferenceManifest.references) {
        if (!plan.source_refs.includes(reference.source_ref) ||
          !brief.source_identity.some((item) => item.source_id === reference.source_ref)) {
          throw new CreativeApiError("scope_denied", operation, "image_reference_manifest.references.source_ref");
        }
        const asset = research.assets.items.find((item) => item.asset_id === reference.asset_id);
        if (!asset || asset.source_id !== reference.source_ref || asset.content_hash !== reference.content_hash ||
            asset.media_type !== reference.media_type) {
          throw new CreativeApiError("stale_version", operation, "image_reference_manifest.references.asset_binding");
        }
        explicit.set(reference.asset_id, "modify");
      }
      trustedImageReferenceManifest = Object.freeze({
        contract: "CreativeImageReferenceManifest",
        schema_version: "1.0",
        tenant_id: scope.tenant_id,
        project_id: scope.project_id,
        brief_id: brief.brief_id,
        brief_hash: briefHash,
        research_package_id: research.package_id,
        research_package_hash: packageHash,
        base_design_version_id: baseDesign.design_version_id,
        base_design_hash: baseDesign.design_hash,
        references: Object.freeze(imageReferenceManifest.references.map((reference) => Object.freeze({
          source_ref: reference.source_ref,
          asset_id: reference.asset_id,
          content_hash: reference.content_hash,
          media_type: reference.media_type,
          width: reference.width,
          height: reference.height,
        }))),
      });
    }
    for (const asset of research.assets.items) {
      if (operation !== "concepts.create" &&
          (sourceRefs.has(asset.source_id) || sourceRefs.has(asset.asset_id) || sourceRefs.has(`asset:${asset.asset_id}`))) {
        explicit.set(asset.asset_id, explicit.get(asset.asset_id) ?? (operation === "generate" ? "reproduce" : "modify"));
      }
    }
    if (explicit.size === 0) return Object.freeze({ proofs: Object.freeze([]), permission_evidence: Object.freeze([]),
      image_reference_manifest: undefined });
    const requestedAssets = [];
    for (const [assetId, action] of explicit) {
      const asset = research.assets.items.find((item) => item.asset_id === assetId);
      const packagePermission = research.permissions.items.find((item) => item.asset_id === assetId && item.action === action);
      const briefPermission = brief.permissions.items.find((item) => item.asset_id === assetId && item.action === action);
      if (!asset || !packagePermission || packagePermission.status !== "granted" ||
        !briefPermission || briefPermission.status !== "granted") {
        throw new CreativeApiError("permission_denied", operation, "asset_permission");
      }
      requestedAssets.push({ asset, action });
    }
    const verifier = ports.planning?.assetPermissionVerifier;
    if (!isRecord(verifier) || typeof verifier.verifyAssetUse !== "function" ||
      typeof ports.storage?.isAssetFenced !== "function") {
      throw new CreativeApiError("unavailable", operation, "asset_permission_verifier");
    }
    const acceptedProofs = [];
    const permissionEvidence = [];
    for (const { asset, action } of requestedAssets) {
      const requestedAt = new Date(now()).toISOString();
      let proof;
      try {
        proof = await verifier.verifyAssetUse({ tenant_id: scope.tenant_id, project_id: scope.project_id,
          asset_id: asset.asset_id, content_hash: asset.content_hash, action,
          package_id: research.package_id, package_hash: packageHash, now: requestedAt });
      } catch {
        throw new CreativeApiError("unavailable", operation, "asset_permission_verifier", { retryable: true });
      }
      const verifiedAt = new Date(now()).getTime();
      const checkedAt = typeof proof?.checked_at === "string" ? Date.parse(proof.checked_at) : NaN;
      const expiresAt = typeof proof?.expires_at === "string" ? Date.parse(proof.expires_at) : NaN;
      if (!isRecord(proof) || proof.status !== "granted" || proof.owner_evidence_status !== "verified" ||
        proof.tenant_id !== scope.tenant_id || proof.project_id !== scope.project_id || proof.asset_id !== asset.asset_id ||
        proof.content_hash !== asset.content_hash || proof.action !== action || proof.package_id !== research.package_id ||
        proof.package_hash !== packageHash || typeof proof.evidence_ref !== "string" || proof.evidence_ref.length < 1 ||
        !Number.isFinite(checkedAt) || checkedAt > verifiedAt || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
        throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
      }
      acceptedProofs.push(Object.freeze({ asset_id: asset.asset_id, content_hash: asset.content_hash, action,
        source_ref: asset.source_id, package_id: research.package_id, package_hash: packageHash,
        checked_at: checkedAt, expires_at: expiresAt }));
      permissionEvidence.push(Object.freeze({ status: proof.status, tenant_id: proof.tenant_id,
        project_id: proof.project_id, asset_id: proof.asset_id, content_hash: proof.content_hash,
        action: proof.action, package_id: proof.package_id, package_hash: proof.package_hash,
        owner_evidence_status: proof.owner_evidence_status, evidence_ref: proof.evidence_ref,
        checked_at: proof.checked_at, expires_at: proof.expires_at }));
    }
    // Bind the permission result to the still-current package after all owner
    // verifier awaits. The caller then performs its final same-DB fence/CAS.
    const currentRaw = await getPackage(Object.freeze({ scope }));
    let current;
    try { current = normalizeResearchPackage(immutableRequestSnapshot(currentRaw), scope); }
    catch { throw new CreativeApiError("unavailable", operation, "research_package"); }
    if (current.package_id !== research.package_id || canonicalHash(current) !== packageHash) {
      throw new CreativeApiError("stale_version", operation, "research_package_hash");
    }
    // The package read above can itself await. Check the durable asset fence
    // last so an invalidation committed during permission verification or the
    // current-package lookup cannot pass through to a transport call.
    for (const { asset } of requestedAssets) {
      if (await ports.storage.isAssetFenced(Object.freeze({ scope, asset_id: asset.asset_id,
        content_hash: asset.content_hash }))) {
        throw new CreativeApiError("permission_denied", operation, "asset_invalidation");
      }
    }
    const completedAt = new Date(now()).getTime();
    if (acceptedProofs.some((proof) => proof.expires_at <= completedAt)) {
      throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
    }
    const conceptAssetMetadata = operation === "concepts.create" ? Object.freeze(conceptReferenceRequests.map((reference) => {
      const asset = research.assets.items.find((item) => item.asset_id === reference.asset_id);
      if (!asset) throw new CreativeApiError("scope_denied", operation, "references.asset_id");
      return Object.freeze({ asset_id: asset.asset_id, source_ref: asset.source_id,
        content_hash: asset.content_hash, media_type: asset.media_type, role_ref: reference.role_ref });
    })) : undefined;
    return Object.freeze({ proofs: Object.freeze(acceptedProofs), permission_evidence: Object.freeze(permissionEvidence),
      ...(operation === "concepts.create" ? { research_package: research, concept_asset_metadata: conceptAssetMetadata } : {}),
      image_reference_manifest: trustedImageReferenceManifest });
  }

  async function beginMutation(principal, request) {
    const begin = requiredPort(ports, "jobs.begin", request.operation);
    const scope = scopeFor(principal, request.payload.brief_id);
    const request_hash = actionRequestHash(request);
    const record = await begin(Object.freeze({
      scope,
      actor_id: principal.actor_id,
      action_id: request.action_id,
      request_hash,
      operation: request.operation,
    }));
    if (!isRecord(record) || !["started", "existing", "conflict"].includes(record.kind)) {
      throw new CreativeApiError("unavailable", request.operation);
    }
    if (record.kind === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
    if (record.kind === "existing") {
      if (!isRecord(record.job)) throw new CreativeApiError("unavailable", request.operation);
      assertScopedRecord(record.job, scope, request.operation);
      if (record.job.job_id === undefined || record.job.request_hash !== request_hash ||
        record.job.action_id !== request.action_id || record.job.actor_id !== principal.actor_id ||
        record.job.operation !== request.operation) throw new CreativeApiError("conflict", request.operation, "action_id");
      return { replayed: true, scope, request_hash, job: record.job };
    }
    if (typeof record.job_id !== "string" || typeof record.lease_token !== "string") {
      throw new CreativeApiError("unavailable", request.operation);
    }
    return { replayed: false, scope, request_hash, job_id: record.job_id, lease_token: record.lease_token };
  }

  async function publish(principal, request, started, result, persist, publicationFence, beforeCommit) {
    const completeIfActive = requiredPort(ports, "jobs.completeIfActive", request.operation);
    assertPublicIdentifiers(result, request.operation, "result");
    const record = await completeIfActive(Object.freeze({
      scope: started.scope,
      actor_id: principal.actor_id,
      job_id: started.job_id,
      lease_token: started.lease_token,
      action_id: request.action_id,
      operation: request.operation,
      result,
      publication_fence: publicationFence,
    }), async (transaction) => {
      const persisted = await persist(transaction);
      assertPublicIdentifiers(result, request.operation, "result");
      return persisted;
    }, beforeCommit);
    if (!isRecord(record)) throw new CreativeApiError("unavailable", request.operation);
    if (record.status === "cancelled") throw new CreativeApiError("cancelled", request.operation);
    if (record.status === "stale_context") throw new CreativeApiError("stale_version", request.operation, "creative_context");
    if (record.status !== "completed" || !record.job) throw new CreativeApiError("unavailable", request.operation);
    assertScopedRecord(record.job, started.scope, request.operation);
    if (record.job.job_id !== started.job_id || record.job.actor_id !== principal.actor_id ||
      record.job.action_id !== request.action_id || record.job.operation !== request.operation ||
      record.job.request_hash !== started.request_hash) throw new CreativeApiError("unavailable", request.operation);
    return record.job;
  }

  function routeFor(route, operation) {
    if (!isRecord(route)) throw new CreativeApiError("unavailable", operation, "provider_route");
    assertOnlyKeys(route, ["retry_mapping_ref", "provider"], "provider_route");
    boundedString(route.retry_mapping_ref, "provider_route.retry_mapping_ref", 256);
    const provider = route.provider;
    assertOnlyKeys(provider, ["name", "model", "endpoint", "sdk"], "provider_route.provider");
    boundedString(provider.name, "provider_route.provider.name", 256);
    boundedString(provider.model, "provider_route.provider.model", 256);
    boundedString(provider.endpoint, "provider_route.provider.endpoint", 256);
    assertOnlyKeys(provider.sdk, ["name", "version"], "provider_route.provider.sdk");
    boundedString(provider.sdk.name, "provider_route.provider.sdk.name", 256);
    boundedString(provider.sdk.version, "provider_route.provider.sdk.version", 256);
    return Object.freeze({
      retry_mapping_ref: route.retry_mapping_ref,
      provider: Object.freeze({ ...provider, sdk: Object.freeze({ ...provider.sdk }) }),
    });
  }

  function newBillableAttempt(request) {
    let attemptId = boundedString(idFactory(), "billable_attempt_id", 256);
    if (attemptId === request.action_id) attemptId = "attempt:" + attemptId;
    if (attemptId.length > 256 || attemptId === request.action_id) {
      throw new CreativeApiError("unavailable", request.operation, "billable_attempt_id");
    }
    return attemptId;
  }

  async function authorizeJobDispatch(principal, request, started, transportAttemptId, billableAttemptId,
    reservationRef, contextFence, route) {
    const authorize = requiredPort(ports, "jobs.authorizeDispatch", request.operation);
    const input = Object.freeze({
      scope: started.scope,
      actor_id: principal.actor_id,
      job_id: started.job_id,
      lease_token: started.lease_token,
      action_id: request.action_id,
      operation: request.operation,
      ...(billableAttemptId ? { billable_attempt_id: billableAttemptId } : {}),
      ...(reservationRef ? { reservation_ref: reservationRef } : {}),
      ...(route?.provider?.name ? { provider_name: route.provider.name } : {}),
      ...(route?.provider?.model ? { provider_model: route.provider.model } : {}),
      transport_attempt_id: boundedString(transportAttemptId, "transport_attempt_id", 256),
      context_fence: contextFence,
    });
    let result;
    try {
      result = await authorize(input);
    } catch {
      throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization", { retryable: true });
    }
    if (!isRecord(result)) throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
    if (result.status === "cancelled" || result.status === "lease_lost") {
      throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
    }
    if (result.status === "stale_context") {
      throw new CreativeApiError("stale_version", request.operation, "creative_context");
    }
    if (result.status !== "authorized") throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
    return boundedString(result.dispatch_intent_ref, "dispatch_intent_ref", 256);
  }

  function assertJobDispatchCurrent(principal, request, started, transportAttemptId, billableAttemptId,
    reservationRef, contextFence, route, expectedIntentRef) {
    const assertCurrent = requiredPort(ports, "jobs.assertDispatchCurrent", request.operation);
    const input = Object.freeze({
      scope: started.scope,
      actor_id: principal.actor_id,
      job_id: started.job_id,
      lease_token: started.lease_token,
      action_id: request.action_id,
      operation: request.operation,
      ...(billableAttemptId ? { billable_attempt_id: billableAttemptId } : {}),
      ...(reservationRef ? { reservation_ref: reservationRef } : {}),
      ...(route?.provider?.name ? { provider_name: route.provider.name } : {}),
      ...(route?.provider?.model ? { provider_model: route.provider.model } : {}),
      transport_attempt_id: boundedString(transportAttemptId, "transport_attempt_id", 256),
      context_fence: contextFence,
      dispatch_intent_ref: boundedString(expectedIntentRef, "dispatch_intent_ref", 256),
    });
    let result;
    try { result = assertCurrent(input); }
    catch {
      throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
    }
    if (!isRecord(result)) {
      throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
    }
    if (result.status === "cancelled" || result.status === "lease_lost") {
      throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
    }
    if (result.status === "stale_context") {
      throw new CreativeApiError("stale_version", request.operation, "creative_context");
    }
    if (result.status !== "authorized" || result.dispatch_intent_ref !== expectedIntentRef) {
      throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
    }
    return expectedIntentRef;
  }

  async function runMetered(principal, request, started, operationKind, route, portPath, invokePort, preDispatchGuard,
    contextFence, { allowTerminalFailure = false, allowUnknownOutcome = false,
      logicalOperationId = request.action_id, maximumDeadlineAt, onReservation, prepareAttempt } = {}) {
    if (preDispatchGuard) await preDispatchGuard();
    requiredPort(ports, "metering.reserveAttempt", request.operation);
    const telemetry = ports.telemetry;
    if (!isRecord(telemetry) || !isRecord(telemetry.modes) || !isRecord(telemetry.outbox) ||
      typeof telemetry.outbox.append !== "function" ||
      typeof telemetry.outbox.stagePendingEvidence !== "function" ||
      typeof telemetry.outbox.enqueueUsageObservation !== "function") {
      throw new CreativeApiError("unavailable", request.operation, "telemetry", { retryable: true });
    }
    const usageProfile = isRecord(telemetry.usage_profiles) && Object.hasOwn(telemetry.usage_profiles, operationKind)
      ? telemetry.usage_profiles[operationKind] : undefined;
    if (!Object.values(USAGE_PROFILE).includes(usageProfile)) {
      throw new CreativeApiError("unavailable", request.operation, "telemetry.usage_profile", { retryable: true });
    }
    const metering = ports.metering;
    const method = requiredPort(ports, portPath, request.operation);
    const checkedRoute = routeFor(route, request.operation);
    const attemptId = newBillableAttempt(request);
    const attempt = meteredAttempt(principal, request, attemptId, operationKind, checkedRoute, logicalOperationId);
    const deadline = startDeadline(request.operation, MAX_PORT_WAIT_MS, now, maximumDeadlineAt);
    let providerValue;
    let providerRetryDisposition;
    let validatedDecisionRequest;
    let preDispatchError;
    let currentPermissionProofs = Object.freeze([]);
    let hasCurrentPermissionProofs = false;
    const dispatchIntentRefs = new Map();
    const currentContextFence = () => {
      const base = typeof contextFence === "function" ? contextFence(currentPermissionProofs) : contextFence;
      return hasCurrentPermissionProofs && isRecord(base)
        ? Object.freeze({ ...base, inspection_rights: Object.freeze({ proofs: currentPermissionProofs }) })
        : base;
    };
    const checkDispatchFence = async () => {
      if (!preDispatchGuard) return;
      try {
        const current = await preDispatchGuard();
        if (Array.isArray(current)) {
          currentPermissionProofs = Object.freeze([...current]);
          hasCurrentPermissionProofs = true;
        }
      }
      catch (error) { preDispatchError = error; throw error; }
    };
    const authorizeTransport = async (transportAttemptId, reservationRef) => {
      boundedString(transportAttemptId, "transport_attempt_id", 256);
      await checkDispatchFence();
      const existing = dispatchIntentRefs.get(transportAttemptId);
      if (existing) {
        if (deadline.signal.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
        return existing;
      }
      let intentRef;
      try {
        intentRef = await authorizeJobDispatch(principal, request, started, transportAttemptId,
          attempt.billable_attempt_id, reservationRef, currentContextFence(), checkedRoute);
      } catch (error) {
        preDispatchError = error;
        throw error;
      }
      if (deadline.signal.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
      await checkDispatchFence();
      dispatchIntentRefs.set(transportAttemptId, intentRef);
      return intentRef;
    };
    const assertFinalDispatchEligibility = (signal) => {
      const currentTime = new Date(now()).getTime();
      const deadlineTime = Date.parse(deadline.deadline_at);
      if (!Number.isFinite(currentTime) || !Number.isFinite(deadlineTime) || currentTime >= deadlineTime) {
        throw new CreativeApiError("cancelled", request.operation, "deadline");
      }
      if (signal?.aborted || deadline.signal.aborted || Date.parse(principal.expires_at) <= currentTime) {
        throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
      }
      if (currentPermissionProofs.some((proof) => proof.expires_at <= currentTime)) {
        throw new CreativeApiError("permission_denied", request.operation, "asset_permission_evidence");
      }
      // A C03 ACK and the awaited same-database job authorization are not
      // enough to extend an inspection repair's cumulative root lease. Re-read
      // the durable claim synchronously after that final await, immediately
      // before returning a permit to the adapter. An ACK already issued stays
      // attributable and is held for reconciliation when this fence expires.
      const repairProof = currentContextFence()?.inspection_repair;
      if (repairProof !== undefined) {
        const repairScope = { ...started.scope, brief_id: request.payload.brief_id,
          design_version_id: repairProof.root_design_version_id };
        if (!Number.isSafeInteger(repairProof.deadline_at_ms) || currentTime < repairProof.started_at_ms ||
            currentTime >= repairProof.deadline_at_ms ||
            !isRecord(ports.storage?.inspectionRepair) ||
            typeof ports.storage.inspectionRepair.isClaimCurrent !== "function" ||
            !ports.storage.inspectionRepair.isClaimCurrent({ scope: repairScope, proof: repairProof })) {
          throw new CreativeApiError("review_required", request.operation, "inspection_repair.limit");
        }
      }
    };
    const revalidateMappedDispatch = async (dispatchContext) => {
      const transportAttemptId = dispatchContext.transport_attempt_id;
      const expectedIntentRef = dispatchIntentRefs.get(transportAttemptId);
      if (!expectedIntentRef || dispatchContext.attempt.billable_attempt_id !== attempt.billable_attempt_id ||
          dispatchContext.reservation_ref === undefined || dispatchContext.dispatch_intent_ref !== expectedIntentRef ||
          dispatchContext.signal?.aborted || deadline.signal.aborted) {
        const error = new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
        preDispatchError = error;
        throw error;
      }
      // Usage-profile mapping is an asynchronous trusted boundary. Recheck
      // current creative/package and per-asset rights after it, then make the
      // job/lease/context authorization the final await before C03 can decide
      // whether a complete observation is eligible for settlement.
      await checkDispatchFence();
      if (dispatchContext.signal?.aborted || deadline.signal.aborted) {
        const error = new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
        preDispatchError = error;
        throw error;
      }
      let currentIntentRef;
      try {
        currentIntentRef = await authorizeJobDispatch(principal, request, started, transportAttemptId,
          attempt.billable_attempt_id, dispatchContext.reservation_ref, currentContextFence(), checkedRoute);
      } catch (error) {
        preDispatchError = error;
        throw error;
      }
      if (currentIntentRef !== expectedIntentRef || dispatchContext.signal?.aborted || deadline.signal.aborted) {
        const error = new CreativeApiError(currentIntentRef !== expectedIntentRef ? "stale_version" : "cancelled",
          request.operation, "dispatch_authorization");
        preDispatchError = error;
        throw error;
      }
      try {
        assertFinalDispatchEligibility(dispatchContext.signal);
        assertJobDispatchCurrent(principal, request, started, transportAttemptId,
          dispatchContext.attempt.billable_attempt_id, dispatchContext.reservation_ref,
          currentContextFence(), checkedRoute, expectedIntentRef);
      }
      catch (error) {
        preDispatchError = error;
        throw error;
      }
    };
    let settledUsageMappingCandidate;
    const finishUsageMapping = async (dispatchContext, mappedUsage) => {
      const observation = mappedUsage?.observation;
      // Generic legacy consumers use a synchronous local usage profile. The
      // CE-03 owner mapper is an asynchronous authority boundary and must be
      // followed by fresh rights/job checks. If those checks fail, retain an
      // incomplete observation for reconciliation instead of dropping known
      // usage or letting C03 settle it.
      if (typeof telemetry.usage_profile_authority?.mapProviderUsage !== "function") return observation;
      try {
        await revalidateMappedDispatch(dispatchContext);
        if (mappedUsage?.mapping) settledUsageMappingCandidate = mappedUsage.mapping;
        return observation;
      } catch (error) {
        return retainUsageWithoutSettlement(observation, dispatchContext.attempt);
      }
    };
    const revalidateTransport = async ({ transport_attempt_id, billable_attempt_id, reservation_ref,
      dispatch_intent_ref, signal }) => {
      boundedString(transport_attempt_id, "transport_attempt_id", 256);
      if (billable_attempt_id !== attempt.billable_attempt_id || signal?.aborted || deadline.signal.aborted) {
        throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
      }
      await checkDispatchFence();
      if (signal?.aborted || deadline.signal.aborted) {
        throw new CreativeApiError("cancelled", request.operation, "dispatch_authorization");
      }
      let freshIntentRef;
      try {
        // This atomic, idempotent authorization is intentionally the final
        // awaited fence after the external Finance ACK and before dispatch.
        freshIntentRef = await authorizeJobDispatch(principal, request, started, transport_attempt_id,
          billable_attempt_id, reservation_ref, currentContextFence(), checkedRoute);
      } catch (error) {
        preDispatchError = error;
        throw error;
      }
      if (freshIntentRef !== dispatch_intent_ref || signal?.aborted || deadline.signal.aborted) {
        const error = new CreativeApiError(signal?.aborted || deadline.signal.aborted ? "cancelled" : "stale_version",
          request.operation, "dispatch_authorization");
        preDispatchError = error;
        throw error;
      }
      dispatchIntentRefs.set(transport_attempt_id, freshIntentRef);
      try {
        assertFinalDispatchEligibility(signal);
        assertJobDispatchCurrent(principal, request, started, transport_attempt_id,
          billable_attempt_id, reservation_ref, currentContextFence(), checkedRoute, freshIntentRef);
      }
      catch (error) {
        preDispatchError = error;
        throw error;
      }
      return freshIntentRef;
    };
    let outcome;
    let evidenceRefs = [];
    let observationRef;
    let telemetryEvidence;
    let preparedExecution;
    try {
      if (typeof prepareAttempt === "function") {
        let abortListener;
        try {
          preparedExecution = await Promise.race([
            Promise.resolve().then(() => prepareAttempt(Object.freeze({ attempt, route: checkedRoute,
              signal: deadline.signal, deadline_at: deadline.deadline_at }))),
            new Promise((_, reject) => {
              abortListener = () => reject(new CreativeApiError("cancelled", request.operation, "preparation"));
              if (deadline.signal.aborted) abortListener();
              else deadline.signal.addEventListener("abort", abortListener, { once: true });
            }),
          ]);
        } finally {
          if (abortListener) deadline.signal.removeEventListener("abort", abortListener);
        }
        await checkDispatchFence();
        assertFinalDispatchEligibility(deadline.signal);
        const currentJob = await requiredPort(ports, "jobs.get", request.operation)(Object.freeze({
          scope: started.scope, job_id: started.job_id }));
        assertScopedRecord(currentJob, started.scope, request.operation);
        if (currentJob.job_id !== started.job_id || currentJob.actor_id !== principal.actor_id ||
            currentJob.action_id !== request.action_id || currentJob.request_hash !== started.request_hash ||
            currentJob.status !== "running") {
          throw new CreativeApiError(currentJob.status === "cancelled" ? "cancelled" : "stale_version",
            request.operation, "prepared_execution_job");
        }
        assertFinalDispatchEligibility(deadline.signal);
        if (!isRecord(preparedExecution) || !isRecord(preparedExecution.target_binding) ||
            !/^sha256:[a-f0-9]{64}$/.test(preparedExecution.target_binding_sha256) ||
            preparedExecution.deadline_at !== deadline.deadline_at) {
          throw new CreativeApiError("unavailable", request.operation, "prepared_execution_target");
        }
      }
      const telemetryResult = await executeCreativeMeteredAttempt({
      meteringPort: metering,
      evidencePort: telemetry.outbox,
      observationOutbox: telemetry.outbox,
      request: attempt,
      trustedScope: meteredTrustedScope(principal),
      modes: telemetry.modes,
      idFactory,
      clock: () => new Date(now()),
      signal: deadline.signal,
      ...(preparedExecution ? { executionTarget: { target_binding: preparedExecution.target_binding,
        target_binding_sha256: preparedExecution.target_binding_sha256,
        deadline_at: preparedExecution.deadline_at } } : {}),
      authorizeTransport: async ({ transport_attempt_id, reservation_ref }) =>
        authorizeTransport(transport_attempt_id, reservation_ref),
      revalidateTransport,
      dispatch: async (dispatchContext) => {
        const transportAttemptId = dispatchContext.transport_attempt_id;
        const dispatch_intent_ref = dispatchContext.dispatch_intent_ref;
        if (dispatchContext.signal?.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
        let dispatched;
        try { dispatched = await invokePort({
          method,
          request,
          principal,
          started,
          route: checkedRoute,
          attempt: dispatchContext.attempt,
          reservation_ref: dispatchContext.reservation_ref,
          signal: dispatchContext.signal,
          deadline_at: deadline.deadline_at,
          transportAttemptId,
          dispatch_intent_ref,
          prepared_execution: preparedExecution,
          async recordTransportAttempt(transportId) {
            boundedString(transportId, "transport_attempt_id", 256);
            if (dispatchContext.signal?.aborted) throw new CreativeApiError("cancelled", request.operation, "deadline");
            // The telemetry executor owns idempotent transport identity reuse
            // and must revalidate the active job/context fence on every call.
            await dispatchContext.recordTransportAttempt(transportId);
            // C03 transport acknowledgment is an async boundary. Recheck
            // owner rights, current package, and same-database fences after it
            // and then do one final uncached atomic job/lease/context check.
            // Nothing asynchronous follows that authorization: these local
            // checks run synchronously immediately before returning the send
            // permit to the trusted provider adapter.
            await checkDispatchFence();
            const intentRef = dispatchIntentRefs.get(transportId);
            if (!intentRef) throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
            let finalIntentRef;
            try {
              finalIntentRef = await authorizeJobDispatch(principal, request, started, transportId,
              dispatchContext.attempt.billable_attempt_id, dispatchContext.reservation_ref, currentContextFence(), checkedRoute);
            } catch (error) {
              preDispatchError = error;
              throw error;
            }
            if (finalIntentRef !== intentRef) {
              const error = new CreativeApiError("stale_version", request.operation, "dispatch_authorization");
              preDispatchError = error;
              throw error;
            }
            try {
              assertFinalDispatchEligibility(dispatchContext.signal);
              assertJobDispatchCurrent(principal, request, started, transportId,
                dispatchContext.attempt.billable_attempt_id, dispatchContext.reservation_ref,
                currentContextFence(), checkedRoute, intentRef);
            }
            catch (error) {
              preDispatchError = error;
              throw error;
            }
            return intentRef;
          },
          async revalidateDispatch(binding) {
            if (!isRecord(binding) || binding.transport_attempt_id !== transportAttemptId ||
                binding.billable_attempt_id !== attempt.billable_attempt_id ||
                binding.reservation_ref !== dispatchContext.reservation_ref ||
                binding.dispatch_intent_ref !== dispatch_intent_ref ||
                typeof binding.target_binding_sha256 !== "string" ||
                !/^sha256:[a-f0-9]{64}$/.test(binding.target_binding_sha256) || binding.signal !== dispatchContext.signal) {
              throw new CreativeApiError("unavailable", request.operation, "dispatch_authorization");
            }
            return revalidateTransport({ transport_attempt_id: transportAttemptId,
              billable_attempt_id: attempt.billable_attempt_id, reservation_ref: dispatchContext.reservation_ref,
              dispatch_intent_ref, signal: dispatchContext.signal });
          },
          assertDispatchCurrent() {
            assertFinalDispatchEligibility(dispatchContext.signal);
            return assertJobDispatchCurrent(principal, request, started, transportAttemptId,
              attempt.billable_attempt_id, dispatchContext.reservation_ref,
              currentContextFence(), checkedRoute, dispatch_intent_ref);
          },
          setDecisionRequest(value) { validatedDecisionRequest = value; },
        }); } catch (error) {
          const failed = providerFailureUsage(error);
          if (!failed) throw error;
          providerRetryDisposition = failed.retry_disposition;
          const mappedUsage = await usageObservation({ attempt: dispatchContext.attempt,
            trustedScope: meteredTrustedScope(principal), rawUsage: failed.usage, profile: usageProfile,
            transportAttemptId, idFactory, usageProfileAuthority: telemetry.usage_profile_authority,
            targetBindingSha256: failed.target_binding_sha256, reservationRef: dispatchContext.reservation_ref,
            dispatchIntentRef: dispatch_intent_ref, providerOutcome: failed.provider_outcome });
          return { provider_outcome: failed.provider_outcome,
            usage_observation: await finishUsageMapping(dispatchContext, mappedUsage) };
        }
        providerValue = dispatched?.value;
        const rawUsage = dispatched?.usage;
        const mappedUsage = await usageObservation({ attempt: dispatchContext.attempt,
          trustedScope: meteredTrustedScope(principal), rawUsage, profile: usageProfile, transportAttemptId,
          idFactory, usageProfileAuthority: telemetry.usage_profile_authority,
          targetBindingSha256: preparedExecution?.target_binding_sha256 ?? dispatched?.value?.target_binding_sha256,
          reservationRef: dispatchContext.reservation_ref,
          dispatchIntentRef: dispatch_intent_ref, providerOutcome: dispatched?.provider_outcome ?? "succeeded" });
        return { provider_outcome: dispatched?.provider_outcome ?? "succeeded",
          usage_observation: await finishUsageMapping(dispatchContext, mappedUsage) };
      },
      ...(typeof onReservation === "function" ? { onReservation } : {}),
    });
      outcome = telemetryResult.outcome;
      evidenceRefs = telemetryResult.evidence_refs;
      observationRef = telemetryResult.observation_ref;
      if (telemetryResult.pending_evidence) {
        const event = telemetryResult.pending_evidence;
        const staged = evidenceRefs.includes(event.event_id);
        telemetryEvidence = Object.freeze({ local_status: "pending", pending_event_id: event.event_id,
          pending_event_staged: staged,
          ...(!staged ? { pending_event: event, pending_event_hash: canonicalHash(event) } : {}) });
      } else {
        telemetryEvidence = Object.freeze({ local_status: telemetryResult.evidence_delivery });
      }
    } finally {
      deadline.dispose();
    }
    const unknownStatus = allowUnknownOutcome && outcome.status !== "settled" &&
      ["cancelled_after_dispatch", "dispatch_outcome_unknown", "transport_attempt_unreported", "dispatch_result_invalid",
        "usage_observation_invalid", "usage_unknown", "usage_observation_unconfirmed", "usage_incomplete",
        "settlement_unknown", "settlement_pending", "dispatch_authorization_unknown"].includes(outcome.status);
    const settledUnknownProviderOutcome = allowUnknownOutcome && outcome.status === "settled" &&
      outcome.provider_outcome === "unknown" && outcome.settlement?.status === "settled" &&
      outcome.observation_ack?.status && ["accepted", "duplicate"].includes(outcome.observation_ack.status);
    if ((!unknownStatus && outcome.status !== "settled") ||
      (!unknownStatus && outcome.provider_outcome !== "succeeded" &&
        !(allowTerminalFailure && outcome.provider_outcome === "failed") && !settledUnknownProviderOutcome)) {
      if (preDispatchError) throw preDispatchError;
      throw meteringFailure(outcome, request.operation);
    }
    const mapping = settledUsageMappingCandidate;
    const usageEvidence = mapping && outcome.settlement?.status === "settled" &&
      outcome.observation_ack?.status && ["accepted", "duplicate"].includes(outcome.observation_ack.status) &&
      outcome.observation_ack.source_observation_id === mapping.source_observation_id &&
      outcome.observation_ack.effective_billable_attempt_id === mapping.billable_attempt_id &&
      mapping.billable_attempt_id === attempt.billable_attempt_id
      ? Object.freeze({ status: "settled_owner_mapping", ...mapping,
        observation_ref: observationRef ?? mapping.source_observation_id }) : undefined;
    return { value: providerValue, attempt_id: attemptId, decision_request: validatedDecisionRequest,
      metering: outcome, transport_attempt_ids: Object.freeze([...dispatchIntentRefs.keys()]),
      provider_outcome: outcome.provider_outcome,
      usage_completeness: usageEvidence?.status === "settled_owner_mapping" ? "complete" :
        ["partial", "unknown"].includes(providerValue?.usage?.completeness) ? providerValue.usage.completeness : "unknown",
      usage_ref: observationRef ?? outcome.observation_ack?.source_observation_id,
      ...(providerRetryDisposition ? { private_retry_disposition: providerRetryDisposition } : {}),
      ...(usageEvidence ? { usage_evidence: usageEvidence } : {}),
      evidence_refs: Object.freeze([...(evidenceRefs ?? [])]), telemetry_evidence: telemetryEvidence };
  }

  function decisionInput(decisionRequest, principal, request, brief, started) {
    assertOnlyKeys(decisionRequest, ["execution_mode", "state", "questions"], "decision_request");
    const input = {
      execution_mode: decisionRequest.execution_mode,
      state: decisionRequest.state,
      questions: decisionRequest.questions,
    };
    if (!isRecord(input.state) || !isRecord(input.questions)) throw new CreativeApiError("invalid_request", request.operation, "decision_request");
    if (request.source_refs.some((ref) => !brief.source_identity.some((source) => source.source_id === ref))) {
      throw new CreativeApiError("scope_denied", request.operation, "source_refs");
    }
    return input;
  }

  async function decision(principal, request, started, brief, decisionRequest, baseDesign = null,
    selectedDesignVersionId = undefined, selectedDesignHash = undefined, repairAuthorization = null) {
    if (decisionRequest === undefined) return undefined;
    const branchMode = request.operation === "edit" && request.payload.selection_mode === "branch";
    const expectedCurrentDesignVersionId = branchMode ? undefined
      : (selectedDesignVersionId === undefined ? (baseDesign?.design_version_id ?? null) : selectedDesignVersionId);
    const expectedCurrentDesignHash = branchMode ? undefined
      : (selectedDesignHash === undefined ? (baseDesign?.design_hash ?? null) : selectedDesignHash);
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, request.operation,
      expectedCurrentDesignVersionId, expectedCurrentDesignHash);
    assertRepairAuthorizationCurrent(repairAuthorization, request.operation);
    const input = decisionInput(decisionRequest, principal, request, brief, started);
    const resolveRoute = requiredPort(ports, "decisionPort.resolveRoute", request.operation);
    const route = routeFor(await resolveRoute(Object.freeze({ scope: started.scope, actor_id: principal.actor_id, decision: input })), request.operation);
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, request.operation,
      expectedCurrentDesignVersionId, expectedCurrentDesignHash);
    assertRepairAuthorizationCurrent(repairAuthorization, request.operation);
    if (route.provider.model !== PINNED_JEV_MODEL_ID) throw new CreativeApiError("unsupported_version", request.operation, "decision_route.model");
    const assertDecisionContext = async () => {
      await assertCurrentCreativeContext(started.scope, brief, baseDesign, request.operation,
        expectedCurrentDesignVersionId, expectedCurrentDesignHash);
      assertRepairAuthorizationCurrent(repairAuthorization, request.operation);
      return Object.freeze([]);
    };
    const decisionScope = { ...started.scope, job_id: started.job_id };
    const prepareDecision = ({ attempt, deadline_at }) => {
        const timestamp = new Date(now()).toISOString();
        const boundRequest = {
          contract: "DecisionPortRequest",
          schema_version: "1.0",
          event_id: boundedString(idFactory(), "decision_request.event_id", 200),
          tenant_id: principal.tenant_id,
          project_id: principal.project_id,
          correlation_id: request.correlation_id,
          producer: "creative-runtime",
          occurred_at: timestamp,
          ingested_at: timestamp,
          environment: request.environment,
          billing_mode: request.billing_mode,
          source_refs: [...new Set(request.source_refs)],
          request_id: boundedString(idFactory(), "decision_request.request_id", 200),
          logical_operation_id: attempt.logical_operation_id,
          billable_attempt_id: attempt.billable_attempt_id,
          attempt_number: 1,
          attempt_limit: 1,
          budget_ref: {
            budget_scope_ref: principal.budget_scope_id,
            policy_version: principal.budget_policy_version,
          },
          deadline_at,
          cancellation_ref: started.job_id,
          model_policy: { model_id: PINNED_JEV_MODEL_ID, policy_version: DECISION_POLICY_VERSION },
          execution_mode: input.execution_mode,
          state: input.state,
          questions: input.questions,
          job_id: started.job_id,
        };
      const target_binding = decisionExecutionTarget(boundRequest, { trustedScope: decisionScope });
      return Object.freeze({ target_binding, target_binding_sha256: decisionExecutionTargetHash(boundRequest,
        { trustedScope: decisionScope }), deadline_at });
    };
    const result = await runMetered(principal, request, started, "jev_decision", route, "decisionPort.execute",
      async ({ method, attempt, reservation_ref, signal, deadline_at, transportAttemptId, dispatch_intent_ref,
        recordTransportAttempt, revalidateDispatch, assertDispatchCurrent, setDecisionRequest, prepared_execution }) => {
        const target_binding_sha256 = prepared_execution.target_binding_sha256;
        const unreserved = prepared_execution.target_binding.request;
        const boundRequest = { ...unreserved, budget_ref: { ...unreserved.budget_ref, reservation_ref } };
        let validated;
        try {
          validated = validateDecisionRequest(boundRequest, { trustedScope: decisionScope });
          if (decisionExecutionTargetHash(validated, { trustedScope: decisionScope }) !== target_binding_sha256) {
            throw new CreativeApiError("unavailable", request.operation, "decision_execution_target");
          }
        } catch (error) { throw safeError(error, request.operation); }
        setDecisionRequest(validated);
        const raw = await method(Object.freeze({ scope: started.scope, actor_id: principal.actor_id,
          request: validated, attempt, reservation_ref, transport_attempt_id: transportAttemptId,
          dispatch_intent_ref, target_binding_sha256, recordTransportAttempt, revalidateDispatch,
          assertDispatchCurrent, signal, deadline_at }));
        return { value: raw, usage: raw?.usage,
          provider_outcome: raw?.status === "complete" || raw?.status === "review" ? "succeeded" : "failed" };
      }, assertDecisionContext,
      creativeContextFence(brief, baseDesign, expectedCurrentDesignVersionId, expectedCurrentDesignHash,
        repairAuthorization ? { inspection_repair: repairAuthorization.proof } : undefined),
      { prepareAttempt: prepareDecision });
    if (!result.decision_request) throw new CreativeApiError("unavailable", request.operation, "decision_request");
    let validated;
    try { validated = validateDecisionResult(result.decision_request, result.value, {
      trustedScope: { ...started.scope, job_id: started.job_id },
    }); }
    catch (error) { throw safeError(error, request.operation); }
    if (validated.status === "review") throw new CreativeApiError("review_required", request.operation, "decision_result");
    if (validated.status === "cancelled") throw new CreativeApiError("cancelled", request.operation, "decision_result");
    if (validated.status !== "complete") throw new CreativeApiError("unavailable", request.operation, "decision_result");
    return validated;
  }

  async function runImageOperation(principal, request, started, brief, baseDesign, expectedSelection = null,
    repairAuthorization = null) {
    const operation = request.operation;
    const plan = request.payload.plan;
    if (!isRecord(plan)) throw new CreativeApiError("invalid_request", operation, "plan");
    const briefHash = canonicalHash(brief);
    const rootDesignId = "root:" + brief.brief_id;
    const expectedBaseHash = baseDesign ? baseDesign.design_hash : canonicalHash({ contract: "DesignRoot", schema_version: "1.0", brief_id: brief.brief_id });
    const knownDesignIds = baseDesign ? [baseDesign.design_version_id] : [rootDesignId];
    const allowedSourceRefs = brief.source_identity.map((source) => source.source_id);
    if (operation === "generate" && plan.operation !== "concept.generate") throw new CreativeApiError("invalid_request", operation, "plan.operation");
    if (operation === "edit" && !["image.edit", "composition.update", "correction.apply"].includes(plan.operation)) {
      throw new CreativeApiError("invalid_request", operation, "plan.operation");
    }
    validateEditPlan(plan, {
      trustedScope: started.scope,
      brief_hash: briefHash,
      design_hash: expectedBaseHash,
      design_version_ids: knownDesignIds,
      known_artifact_ids: baseDesign ? [baseDesign.artifact.artifact_id] : [],
      known_source_refs: allowedSourceRefs,
      known_asset_ids: (brief.permissions?.items ?? []).filter((item) => item.status === "granted").map((item) => item.asset_id),
      known_fact_ids: [...brief.facts.verified, ...brief.facts.unresolved].map((fact) => fact.fact_id),
    });
    for (const step of plan.steps) {
      const assetIds = [step.parameters?.asset_id,
        ...(Array.isArray(step.parameters?.changes) ? step.parameters.changes.map((change) => change?.asset_id) : [])]
        .filter((assetId) => assetId !== undefined);
      for (const assetId of assetIds) {
        const requiredAction = step.action === "concept.generate" ? "reproduce" : "modify";
        const permission = brief.permissions.items.find((item) => item.asset_id === assetId && item.action === requiredAction);
        if (!permission || permission.status !== "granted") {
          throw new CreativeApiError("permission_denied", operation, "plan.steps.parameters.asset_id");
        }
      }
    }
    if (baseDesign && plan.base.design_version_id !== baseDesign.design_version_id) {
      throw new CreativeApiError("stale_version", operation, "plan.base.design_version_id");
    }
    if (plan.expected_result.parent_version_id !== (baseDesign?.design_version_id ?? rootDesignId)) {
      throw new CreativeApiError("stale_version", operation, "plan.expected_result.parent_version_id");
    }
    if (!baseDesign && plan.base.design_version_id !== undefined) {
      throw new CreativeApiError("invalid_request", operation, "plan.base.design_version_id");
    }
    // Composition changes require deterministic layout-only execution. This
    // runtime has no injected composition executor yet, so fail before any
    // provider routing, reservation, or image transport.
    if (operation === "edit" && plan.operation === "composition.update") {
      throw new CreativeApiError("unavailable", operation, "composition_executor");
    }
    // Corrections change the authoritative research facts and require a
    // research-owner handoff plus invalidation of dependent creative state.
    // Until that capability is injected, do not reinterpret the correction
    // as an image edit or let optional DecisionPort work run first.
    if (operation === "edit" && plan.operation === "correction.apply") {
      throw new CreativeApiError("unavailable", operation, "correction_handoff");
    }
    let currentReferenceManifest;
    let currentAssetUseProofs = Object.freeze([]);
    const assertImageContext = async () => {
      await assertCurrentCreativeContext(started.scope, brief, baseDesign, operation,
        expectedCurrentDesignVersionId, expectedCurrentDesignHash);
      const permissionContext = await verifyRequestedAssetPermissions(started.scope, brief, plan, operation,
        request.payload.image_reference_manifest, baseDesign, briefHash);
      const proofs = permissionContext.proofs;
      currentReferenceManifest = permissionContext.image_reference_manifest;
      currentAssetUseProofs = proofs;
      await assertCurrentCreativeContext(started.scope, brief, baseDesign, operation,
        expectedCurrentDesignVersionId, expectedCurrentDesignHash);
      const checkedAt = new Date(now()).getTime();
      if (proofs.some((proof) => proof.expires_at <= checkedAt)) {
        throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
      }
      assertRepairAuthorizationCurrent(repairAuthorization, operation);
      return proofs;
    };
    const branchMode = operation === "edit" && request.payload.selection_mode === "branch";
    const expectedCurrentDesignVersionId = branchMode ? undefined
      : (operation === "generate" ? (expectedSelection?.design_version_id ?? null) : (baseDesign?.design_version_id ?? null));
    const expectedCurrentDesignHash = branchMode ? undefined
      : (operation === "generate" ? (expectedSelection?.design_hash ?? null) : (baseDesign?.design_hash ?? null));
    await assertImageContext();
    const decisionResult = await decision(principal, request, started, brief,
      request.payload.decision_request, baseDesign, expectedCurrentDesignVersionId, expectedCurrentDesignHash,
      repairAuthorization);
    await assertImageContext();
    const method = operation === "generate" ? "provider.generate" : "provider.edit";
    const resolveRoute = requiredPort(ports, "provider.resolveRoute", operation);
    const route = routeFor(await resolveRoute(Object.freeze({ scope: started.scope, actor_id: principal.actor_id, operation, plan })), operation);
    await assertImageContext();
      const privateAttributionPort = imageProviderRoute(route.provider.name) !== undefined
        ? requiredPort(ports, "jobs.recordPrivateProviderAttribution", operation)
        : ports.jobs?.recordPrivateProviderAttribution;
      const privateUsageAttributionPort = imageProviderRoute(route.provider.name) !== undefined
        ? requiredPort(ports, "jobs.recordPrivateProviderUsageAttribution", operation) : undefined;
      const privateAttributionPendingPort = imageProviderRoute(route.provider.name) !== undefined
        ? requiredPort(ports, "jobs.stagePrivateProviderAttribution", operation) : undefined;
      const prepareImage = typeof ports.provider?.prepareAttempt === "function"
        ? requiredPort(ports, "provider.prepareAttempt", operation) : undefined;
      const metered = await runMetered(principal, request, started, operation === "generate" ? "image_generation" : "image_edit", route, method,
      async ({ method: dispatch, scope, actor_id, started: job, route: resolved, attempt, signal, deadline_at,
        reservation_ref, transportAttemptId, dispatch_intent_ref, recordTransportAttempt, revalidateDispatch, assertDispatchCurrent, prepared_execution }) => {
        const value = await dispatch(Object.freeze({ scope: started.scope, actor_id: principal.actor_id,
          job_id: started.job_id, attempt, route: resolved, brief, base_design: baseDesign, plan,
          ...(currentReferenceManifest ? { image_reference_manifest: currentReferenceManifest } : {}),
          decision_result: decisionResult, reservation_ref, transport_attempt_id: transportAttemptId, dispatch_intent_ref,
          ...(prepared_execution ? { prepared_attempt: prepared_execution } : {}),
          recordTransportAttempt,
          revalidateDispatch,
          assertDispatchCurrent,
          ...(typeof privateAttributionPort === "function" ? {
            async recordPrivateProviderRequestId(attribution) {
              if (!isRecord(attribution) || typeof attribution.provider_request_id !== "string" ||
                  typeof attribution.provider_request_ref !== "string") {
                throw new CreativeApiError("failed", operation, "provider_attribution");
              }
              const ack = await privateAttributionPort(Object.freeze({
                scope: started.scope,
                actor_id: principal.actor_id,
                job_id: started.job_id,
                action_id: request.action_id,
                request_hash: started.request_hash,
                operation,
                provider: route.provider.name,
                model: route.provider.model,
                reservation_ref,
                billable_attempt_id: attempt.billable_attempt_id,
                transport_attempt_id: transportAttemptId,
                dispatch_intent_ref,
                provider_request_id: attribution.provider_request_id,
                provider_request_ref: attribution.provider_request_ref,
              }));
              if (!isRecord(ack) || !["recorded", "replayed"].includes(ack.status) ||
                  ack.transport_attempt_id !== transportAttemptId ||
                  ack.provider_request_ref !== attribution.provider_request_ref) {
                throw new CreativeApiError("unavailable", operation, "provider_attribution_ack");
              }
              return ack;
            },
          } : {}),
          ...(typeof privateUsageAttributionPort === "function" ? {
            async recordPrivateProviderUsage(attribution) {
              if (!isRecord(attribution) || !isRecord(attribution.usage) ||
                  typeof attribution.target_binding_sha256 !== "string") {
                throw new CreativeApiError("failed", operation, "provider_usage_attribution");
              }
              const usageHash = canonicalHash(attribution.usage);
              const ack = await privateUsageAttributionPort(Object.freeze({
                scope: started.scope,
                actor_id: principal.actor_id,
                job_id: started.job_id,
                action_id: request.action_id,
                request_hash: started.request_hash,
                operation,
                provider: route.provider.name,
                model: route.provider.model,
                reservation_ref,
                billable_attempt_id: attempt.billable_attempt_id,
                transport_attempt_id: transportAttemptId,
                dispatch_intent_ref,
                target_binding_sha256: attribution.target_binding_sha256,
                usage_sha256: usageHash,
                usage: attribution.usage,
              }));
              if (!isRecord(ack) || !["recorded", "replayed"].includes(ack.status) ||
                  ack.transport_attempt_id !== transportAttemptId ||
                  ack.target_binding_sha256 !== attribution.target_binding_sha256 || ack.usage_sha256 !== usageHash) {
                throw new CreativeApiError("unavailable", operation, "provider_usage_attribution_ack");
              }
              return ack;
            },
          } : {}),
          ...(typeof privateAttributionPendingPort === "function" ? {
            async stagePrivateProviderAttribution(attribution) {
              if (!isRecord(attribution) || typeof attribution.target_binding_sha256 !== "string" ||
                  (attribution.provider_request_id === undefined) !== (attribution.provider_request_ref === undefined) ||
                  attribution.provider_request_id === undefined && attribution.usage === undefined) {
                throw new CreativeApiError("failed", operation, "provider_attribution_pending");
              }
              const pendingInput = Object.freeze({
                scope: started.scope,
                actor_id: principal.actor_id,
                job_id: started.job_id,
                action_id: request.action_id,
                request_hash: started.request_hash,
                operation,
                provider: route.provider.name,
                model: route.provider.model,
                reservation_ref,
                billable_attempt_id: attempt.billable_attempt_id,
                transport_attempt_id: transportAttemptId,
                dispatch_intent_ref,
                target_binding_sha256: attribution.target_binding_sha256,
                ...(attribution.provider_request_id !== undefined ? {
                  provider_request_id: attribution.provider_request_id,
                  provider_request_ref: attribution.provider_request_ref,
                } : {}),
                ...(attribution.usage !== undefined ? { usage: attribution.usage } : {}),
              });
              const pendingPayload = {
                tenant_id: pendingInput.scope.tenant_id,
                project_id: pendingInput.scope.project_id,
                actor_id: pendingInput.actor_id,
                job_id: pendingInput.job_id,
                action_id: pendingInput.action_id,
                request_hash: pendingInput.request_hash,
                operation: pendingInput.operation,
                provider: pendingInput.provider,
                model: pendingInput.model,
                reservation_ref: pendingInput.reservation_ref,
                billable_attempt_id: pendingInput.billable_attempt_id,
                transport_attempt_id: pendingInput.transport_attempt_id,
                dispatch_intent_ref: pendingInput.dispatch_intent_ref,
                target_binding_sha256: pendingInput.target_binding_sha256,
                ...(pendingInput.provider_request_id !== undefined ? {
                  provider_request_id: pendingInput.provider_request_id,
                  provider_request_ref: pendingInput.provider_request_ref,
                } : {}),
                ...(pendingInput.usage !== undefined ? {
                  usage: pendingInput.usage,
                  usage_sha256: canonicalHash(pendingInput.usage),
                } : {}),
              };
              const expectedPayloadSha256 = canonicalHash(pendingPayload);
              const expectedPendingRef = `private-attribution:${expectedPayloadSha256.slice(7)}`;
              const ack = await privateAttributionPendingPort(pendingInput);
              if (!isRecord(ack) || !["staged", "replayed"].includes(ack.status) ||
                  ack.pending_ref !== expectedPendingRef || ack.transport_attempt_id !== transportAttemptId ||
                  ack.payload_sha256 !== expectedPayloadSha256) {
                throw new CreativeApiError("unavailable", operation, "provider_attribution_pending_ack");
              }
              return ack;
            },
          } : {}),
          signal, deadline_at }));
        return { value, usage: value?.usage, provider_outcome: "succeeded" };
      }, assertImageContext,
      creativeContextFence(brief, baseDesign, expectedCurrentDesignVersionId, expectedCurrentDesignHash,
        repairAuthorization ? { inspection_repair: repairAuthorization.proof } : undefined),
      prepareImage ? { prepareAttempt: ({ attempt, signal, deadline_at }) => prepareImage(Object.freeze({
        operation, scope: started.scope, actor_id: principal.actor_id, job_id: started.job_id, attempt,
        brief, base_design: baseDesign, plan, decision_result: decisionResult,
        ...(currentReferenceManifest ? { image_reference_manifest: currentReferenceManifest } : {}), signal, deadline_at,
      })) } : {});
    const finalRightsProofs = await assertImageContext();
    const generated = metered.value;
    const usage = normalizeUsage(generated?.usage);
    const usageEvidence = metered.usage_evidence;
    const effectiveUsageCompleteness = usageEvidence?.status === "settled_owner_mapping"
      ? "complete" : (usage.completeness ?? "unknown");
    if (!isRecord(generated) || !isRecord(generated.artifact) ||
      typeof generated.artifact.artifact_id !== "string" || typeof generated.artifact.content_hash !== "string" ||
      typeof generated.artifact.media_type !== "string") {
      throw new CreativeApiError("failed", operation, "provider_result");
    }
    if (!(generated.artifact_bytes instanceof Uint8Array) || generated.artifact_bytes.byteLength === 0) {
      throw new CreativeApiError("failed", operation, "artifact_bytes");
    }
    // Copy bytes before any later storage await. Provider-owned buffers can be
    // reused or mutated after the call returns; the published hash must bind
    // the exact immutable snapshot below.
    const artifactBytes = Uint8Array.from(generated.artifact_bytes);
    if (hashArtifactBytes(artifactBytes) !== generated.artifact.content_hash) {
      throw new CreativeApiError("failed", operation, "artifact_content_hash");
    }
    const design_version_id = boundedString(generated.design_version_id ?? idFactory(), "design_version_id");
    boundedString(generated.provider, "provider_result.provider", 100);
    boundedString(generated.model, "provider_result.model", 100);
    if (generated.provider !== route.provider.name || generated.model !== route.provider.model) {
      throw new CreativeApiError("failed", operation, "provider_identity");
    }
    const parent_version_id = baseDesign?.design_version_id ?? null;
    const designBase = {
      contract: "DesignVersion",
      schema_version: "1.0",
      event_id: idFactory(),
      tenant_id: principal.tenant_id,
      project_id: principal.project_id,
      correlation_id: request.correlation_id,
      producer: "creative-runtime",
      occurred_at: new Date(now()).toISOString(),
      ingested_at: new Date(now()).toISOString(),
      environment: request.environment,
      billing_mode: request.billing_mode,
      source_refs: [...new Set([...request.source_refs, ...plan.source_refs])],
      logical_operation_id: request.action_id,
      design_version_id,
      brief_id: brief.brief_id,
      parent_version_id,
      brief_hash: briefHash,
      artifact: generated.artifact,
      creative_asset_use: Object.freeze({ contract: "CreativeAssetUseSet", schema_version: "1.0",
        status: "verified", brief_hash: briefHash,
        entries: Object.freeze(currentAssetUseProofs.map((proof) => Object.freeze({
          asset_id: proof.asset_id, action: proof.action, source_ref: proof.source_ref,
          content_hash: proof.content_hash, package_id: proof.package_id, package_hash: proof.package_hash,
        }))) }),
      provider: route.provider.name,
      model: route.provider.model,
      billable_attempt_id: metered.attempt_id,
      usage_status: effectiveUsageCompleteness === "complete" ? "complete" : "incomplete",
    };
    const design = { ...designBase, design_hash: computeDesignVersionHash(designBase) };
    validateDesignVersion(design, {
      trustedScope: { ...started.scope, design_version_id },
      brief_hash: briefHash,
      design_version_ids: baseDesign ? [baseDesign.design_version_id] : [],
      known_source_refs: allowedSourceRefs,
    });
    const providerRequestIds = [];
    if (generated.usage?.provider_request_id !== undefined) {
      providerRequestIds.push(publicIdentifier(generated.usage.provider_request_id, "provider_request_id", operation, 256));
    }
    const usageRefs = typeof metered.usage_ref === "string"
      ? [publicIdentifier(metered.usage_ref, "usage_ref", operation, 256)] : [];
    return { design, artifact_bytes: artifactBytes, permission_fence: Object.freeze([...finalRightsProofs]),
      refresh_permission_fence: assertImageContext,
      telemetry_evidence: metered.telemetry_evidence,
      ...(usageEvidence ? { usage_evidence: usageEvidence } : {}),
      creation_evidence: { transport_attempt_ids: [...metered.transport_attempt_ids], provider_request_ids: providerRequestIds,
        usage_refs: usageRefs, evidence_refs: [...metered.evidence_refs] },
      usage: { completeness: effectiveUsageCompleteness }, attempt_id: metered.attempt_id };
  }

  async function validateInspectionRepairSource(principal, request, started, brief, baseDesign) {
    const source = request.payload.inspection_repair;
    if (!source || request.operation !== "edit" || request.payload.selection_mode === "branch" ||
      request.payload.plan?.operation !== "image.edit" || !baseDesign ||
      request.payload.design_version_id !== baseDesign.design_version_id) {
      throw new CreativeApiError("invalid_request", "edit", "inspection_repair");
    }
    validateEditPlan(request.payload.plan, {
      trustedScope: started.scope,
      brief_hash: canonicalHash(brief),
      design_hash: baseDesign.design_hash,
      design_version_ids: [baseDesign.design_version_id],
      known_artifact_ids: [baseDesign.artifact.artifact_id],
      known_source_refs: brief.source_identity.map((item) => item.source_id),
      known_asset_ids: (brief.permissions?.items ?? []).filter((item) => item.status === "granted").map((item) => item.asset_id),
      known_fact_ids: [...brief.facts.verified, ...brief.facts.unresolved].map((fact) => fact.fact_id),
    });
    if (request.payload.plan.steps.some((step) => step.action !== "image.edit") ||
      request.payload.plan.expected_result.parent_version_id !== baseDesign.design_version_id) {
      throw new CreativeApiError("invalid_request", "edit", "inspection_repair.plan");
    }
    const getSession = requiredPort(ports, "storage.getInspectionSession", "edit");
    const getJob = requiredPort(ports, "jobs.get", "edit");
    const readSource = async () => {
      const session = await getSession(Object.freeze({ scope: started.scope, brief_id: brief.brief_id,
        action_id: source.inspection_action_id }));
      if (!isRecord(session) || session.status !== "completed" || !Array.isArray(session.stages) || !isRecord(session.result) ||
        session.tenant_id !== principal.tenant_id || session.project_id !== principal.project_id ||
        session.brief_id !== brief.brief_id || session.actor_id !== principal.actor_id ||
        session.action_id !== source.inspection_action_id ||
        session.design_version_id !== baseDesign.design_version_id || session.design_hash !== baseDesign.design_hash ||
        session.brief_hash !== canonicalHash(brief) || !isRecord(session.result.report) ||
        canonicalHash(session.result.report) !== source.report_hash ||
        session.result.inspection_id !== `inspection-series:${session.root_design_version_id}:${session.root_design_hash.slice(7, 23)}`) {
        throw new CreativeApiError("unavailable", "edit", "inspection_repair.source");
      }
      const sourceJob = await getJob(Object.freeze({ scope: started.scope, job_id: session.job_id }));
      if (!isRecord(sourceJob) || sourceJob.status !== "completed" || sourceJob.operation !== "inspect" ||
        sourceJob.actor_id !== principal.actor_id || sourceJob.action_id !== source.inspection_action_id ||
        sourceJob.request_hash !== session.request_hash || canonicalSerialize(sourceJob.result) !== canonicalSerialize(session.result)) {
        throw new CreativeApiError("unavailable", "edit", "inspection_repair.job");
      }
      return { session, sourceJob };
    };
    let { session, sourceJob } = await readSource();
    const report = session.result.report;
    const parent = baseDesign.parent_version_id === null ? null
      : await loadDesign(started.scope, brief, baseDesign.parent_version_id, "edit", { allowHistorical: true });
    let root = baseDesign;
    while (root.parent_version_id !== null) {
      root = await loadDesign(started.scope, brief, root.parent_version_id, "edit", { allowHistorical: true });
    }
    if (session.root_design_version_id !== root.design_version_id || session.root_design_hash !== root.design_hash) {
      throw new CreativeApiError("stale_version", "edit", "inspection_repair.lineage");
    }
    const getBytes = requiredPort(ports, "storage.getArtifactBytes", "edit");
    let bytes;
    try { bytes = Uint8Array.from(await getBytes(Object.freeze({ scope: started.scope,
      brief_id: brief.brief_id, design_version_id: baseDesign.design_version_id }))); }
    catch { throw new CreativeApiError("unavailable", "edit", "inspection_repair.bytes"); }
    if (hashArtifactBytes(bytes) !== baseDesign.artifact.content_hash) {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.bytes");
    }
    const assetUse = inspectionAssetUseSet(baseDesign, brief, "edit");
    await verifyInspectionAssetRights(started.scope, brief, assetUse, "edit");
    let decoder;
    try { decoder = await inspectOpenAIImageBytes(bytes); }
    catch { throw new CreativeApiError("unavailable", "edit", "inspection_repair.decode"); }
    const usedAssets = assetUse.status === "verified"
      ? assetUse.entries.map(({ asset_id, action }) => ({ asset_id, action })) : [];
    const deterministic = inspectCreativeArtifact({ trusted_scope: { ...started.scope,
      design_version_id: baseDesign.design_version_id, artifact_id: baseDesign.artifact.artifact_id }, brief,
      design_version: baseDesign, ...(parent ? { parent_design: parent, parent_design_hash: parent.design_hash } : {}),
      artifact_bytes: bytes, used_assets: usedAssets, asset_use_evidence_status: assetUse.status,
      decoder_result: Object.freeze({ contract: "OpenAIBoundedImageDecode", schema_version: "1.0", status: "pass",
        artifact_hash: hashArtifactBytes(bytes), format: decoder.format, width: decoder.width, height: decoder.height,
        has_alpha: decoder.has_alpha, has_transparency: decoder.has_transparency }),
      eligible_repair_actions: ports.provider?.edit && ports.metering ? ["image.edit"] : [] });
    const subjectHash = canonicalInspectionSubjectHash(deterministic);
    const stages = new Map();
    for (const stage of session.stages) {
      if (!isRecord(stage) || stages.has(stage.stage) || stage.status !== "completed" || !isRecord(stage.intent) || !isRecord(stage.result)) {
        throw new CreativeApiError("unavailable", "edit", "inspection_repair.stages");
      }
      stages.set(stage.stage, stage);
    }
    const observerStage = stages.get("observer");
    const firstStage = stages.get("decision_evidence");
    const routeStage = stages.get("decision_route");
    if (!observerStage || !firstStage || !routeStage || stages.size !== 3 || observerStage.intent.subject_hash !== subjectHash ||
      observerStage.result.subject_hash !== subjectHash || observerStage.result.attempt_id !== observerStage.attempt_id ||
      !isRecord(observerStage.result.telemetry_evidence) || observerStage.result.usage_completeness !== "complete") {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.evidence");
    }
    const observation = validateVisualObservation(observerStage.result.observation, deterministic);
    const firstRequest = firstStage.result.request;
    const firstResult = firstStage.result.decision_result;
    if (!isRecord(firstRequest) || !isRecord(firstResult) || !isRecord(firstStage.result.telemetry_evidence) ||
      firstStage.result.usage_completeness !== "complete" || firstStage.intent.subject_hash !== subjectHash ||
      firstStage.intent.request_hash !== canonicalHash(firstRequest) || firstRequest.billable_attempt_id !== firstStage.attempt_id) {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.decision_first");
    }
    const contextKeys = ["event_id", "correlation_id", "producer", "occurred_at", "ingested_at", "environment", "billing_mode",
      "request_id", "logical_operation_id", "billable_attempt_id", "attempt_number", "attempt_limit", "budget_ref", "deadline_at",
      "cancellation_ref", "model_policy", "workflow_id", "run_id", "order_id", "job_id", "transport_attempt_id", "provider_request_id"];
    const firstContext = Object.fromEntries(Object.entries(firstRequest).filter(([key]) => contextKeys.includes(key)));
    const preparedFirstStage = firstStage.intent.target_binding_sha256 !== undefined;
    const plan = (preparedFirstStage ? prepareInspectionDecisionPlan : createInspectionDecisionPlan)({ deterministic,
      observation, decision_context: firstContext });
    const expectedFirst = plan.status === "ready" ? preparedFirstStage
      ? bindInspectionDecisionReservation(plan, prepareInspectionEvidenceBatch(plan, observation),
        firstRequest.budget_ref.reservation_ref)
      : createInspectionEvidenceBatch(plan, observation) : null;
    if (plan.status !== "ready" || plan.plan_ref !== firstStage.intent.plan_ref ||
      canonicalHash(expectedFirst) !== canonicalHash(firstRequest) || preparedFirstStage &&
      decisionExecutionTargetHash(firstRequest) !== firstStage.intent.target_binding_sha256) {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.decision_plan");
    }
    const trustedInspectionScope = Object.freeze({ ...started.scope, brief_id: brief.brief_id,
      design_version_id: baseDesign.design_version_id, artifact_id: baseDesign.artifact.artifact_id, job_id: session.job_id });
    const checkedFirst = validateDecisionResult(firstRequest, firstResult, { trustedScope: trustedInspectionScope });
    const routeRequest = routeStage.result.request;
    const routeResult = routeStage.result.decision_result;
    if (!isRecord(routeRequest) || !isRecord(routeResult) || !isRecord(routeStage.result.telemetry_evidence) ||
      routeStage.result.usage_completeness !== "complete" || routeStage.intent.subject_hash !== subjectHash ||
      routeStage.intent.request_hash !== canonicalHash(routeRequest) ||
      routeStage.intent.first_request_ref !== canonicalHash(firstRequest) ||
      routeStage.intent.first_result_ref !== canonicalHash(checkedFirst) ||
      routeStage.intent.plan_ref !== plan.plan_ref) {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.decision_route");
    }
    const routeContext = { ...Object.fromEntries(Object.entries(routeRequest).filter(([key]) => contextKeys.includes(key))),
      linked_request_id: firstRequest.request_id, linked_billable_attempt_id: firstRequest.billable_attempt_id,
      plan_ref: plan.plan_ref, inspection_subject_hash: subjectHash };
    const preparedRouteStage = routeStage.intent.target_binding_sha256 !== undefined;
    const unboundRoute = (preparedRouteStage ? prepareInspectionRouteBatch : createInspectionRouteBatch)(plan,
      firstRequest, checkedFirst, trustedInspectionScope, routeContext);
    const expectedRoute = preparedRouteStage ? bindInspectionDecisionReservation(plan, unboundRoute,
      routeRequest.budget_ref.reservation_ref) : unboundRoute;
    if (!isRecord(expectedRoute) || canonicalHash(expectedRoute) !== canonicalHash(routeRequest) ||
      preparedRouteStage && decisionExecutionTargetHash(routeRequest) !== routeStage.intent.target_binding_sha256) {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.decision_provenance");
    }
    const checkedRoute = validateDecisionResult(routeRequest, routeResult, { trustedScope: trustedInspectionScope });
    const decision = evaluateInspectionDecision(plan, firstRequest, checkedFirst, routeRequest, checkedRoute, trustedInspectionScope);
    const expectedReport = createInspectionReport({ deterministic, provider_status: "complete", decision,
      observations: [observation], policy_version: INSPECTION_POLICY_VERSION, evidence_mode: "fixture",
      subject_hash: subjectHash, question_schema_version: INSPECTION_QUESTION_SCHEMA_VERSION,
      model_id: PINNED_JEV_MODEL_ID, decision_policy_version: INSPECTION_POLICY_VERSION,
      uncertainty: [], limits: report.limits });
    if (canonicalSerialize(expectedReport) !== canonicalSerialize(report) ||
      report.outcome !== "bounded_repair_recommended" || report.recommendation !== "image.edit" ||
      report.eligible_repair_actions.length !== 1 || report.eligible_repair_actions[0] !== "image.edit" ||
      report.limits.usage_completeness !== "complete" || report.limits.remaining_repairs < 1 ||
      report.limits.remaining_elapsed_ms < 1 || report.limits.remaining_simulated_units <= 0 ||
      report.decision_ref !== decision.decision_ref) {
      throw new CreativeApiError("review_required", "edit", "inspection_repair.not_authorized");
    }
    const attemptIds = [observerStage.attempt_id, firstStage.attempt_id, routeStage.attempt_id];
    if (canonicalSerialize(session.result.attempt_ids) !== canonicalSerialize(attemptIds) ||
      !Array.isArray(session.result.telemetry_evidence) || session.result.telemetry_evidence.length !== attemptIds.length ||
      session.result.telemetry_evidence.some((item, index) => canonicalSerialize(item) !== canonicalSerialize(
        [observerStage.result, firstStage.result, routeStage.result][index].telemetry_evidence))) {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.attempts");
    }
    if (request.billing_mode !== "simulated" || request.environment === "production" ||
      typeof ports.inspection?.estimateFixtureRepairCost !== "function") {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.cost_unknown");
    }
    let estimate;
    try { estimate = await ports.inspection.estimateFixtureRepairCost(Object.freeze({ scope: started.scope,
      actor_id: principal.actor_id, repair_action: "image.edit", source_report_hash: source.report_hash,
      source_design_hash: baseDesign.design_hash, plan_hash: canonicalHash(request.payload.plan) })); }
    catch { throw new CreativeApiError("unavailable", "edit", "inspection_repair.cost_unknown"); }
    if (!isRecord(estimate) || estimate.contract !== "CreativeFixtureRepairEstimate" || estimate.schema_version !== "1.0" ||
      estimate.evidence_mode !== "fixture" || estimate.policy_version !== "fixture-repair-estimate/1" ||
      typeof estimate.simulated_units !== "number" || !Number.isFinite(estimate.simulated_units) ||
      estimate.simulated_units <= 0 || estimate.simulated_units > 3 || Math.round(estimate.simulated_units * 1000) !== estimate.simulated_units * 1000) {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.cost_unknown");
    }
    await assertCurrentCreativeContext(started.scope, brief, baseDesign, "edit", baseDesign.design_version_id, baseDesign.design_hash);
    await verifyInspectionAssetRights(started.scope, brief, assetUse, "edit");
    const afterEstimate = await readSource();
    if (canonicalSerialize(afterEstimate.session) !== canonicalSerialize({ ...session, status: session.status }) ||
      canonicalSerialize(afterEstimate.sourceJob.result) !== canonicalSerialize(sourceJob.result)) {
      throw new CreativeApiError("stale_version", "edit", "inspection_repair.source_changed");
    }
    const repairPort = ports.storage?.inspectionRepair;
    if (!isRecord(repairPort) || typeof repairPort.recordRepairClaim !== "function") {
      throw new CreativeApiError("unavailable", "edit", "inspection_repair.state");
    }
    const repairScope = Object.freeze({ ...started.scope, brief_id: brief.brief_id,
      design_version_id: session.root_design_version_id });
    let claim;
    try { claim = repairPort.recordRepairClaim({ scope: repairScope, inspection_id: session.result.inspection_id,
      action_id: request.action_id, request_hash: started.request_hash, repair_action: "image.edit",
      simulated_units: estimate.simulated_units }); }
    catch { throw new CreativeApiError("unavailable", "edit", "inspection_repair.claim"); }
    if (!isRecord(claim) || claim.status !== "recorded" || claim.local_limit_status !== "within_limits" ||
      typeof claim.claim_ref !== "string" || !Number.isSafeInteger(claim.started_at_ms) ||
      claim.root_brief_hash !== canonicalHash(brief) || claim.root_design_hash !== session.root_design_hash) {
      const field = claim?.status === "expired" || claim?.status === "limit_reached" || claim?.status === "cancelled"
        ? "inspection_repair.limit" : "inspection_repair.claim";
      throw new CreativeApiError("unavailable", "edit", field);
    }
    const proof = Object.freeze({ inspection_id: session.result.inspection_id, action_id: request.action_id,
      request_hash: started.request_hash, claim_ref: claim.claim_ref, root_brief_hash: claim.root_brief_hash,
      root_design_hash: claim.root_design_hash, root_design_version_id: session.root_design_version_id,
      started_at_ms: claim.started_at_ms, deadline_at_ms: claim.started_at_ms + REPAIR_LIMITS.maxElapsedMs,
      simulated_units_milli: Math.round(estimate.simulated_units * 1000) });
    const authorization = Object.freeze({ repairScope, proof });
    assertRepairAuthorizationCurrent(authorization, "edit");
    return Object.freeze({ repairScope, inspection_id: session.result.inspection_id,
      inspection_action_id: source.inspection_action_id, source_report_hash: source.report_hash,
      root_design_version_id: session.root_design_version_id, root_design_hash: session.root_design_hash,
      claim_ref: claim.claim_ref, simulated_units: estimate.simulated_units, proof });
  }

  function conceptUsageRef(value, batch, slot, attempt) {
    const candidate = typeof value === "string" && value.length > 0 ? value : undefined;
    if (candidate && /^[A-Za-z0-9_.:-]{1,256}$/.test(candidate) && !hasSensitivePublicText(candidate)) return candidate;
    return `concept-usage-unknown:${canonicalHash({ batch_id: batch.batch_id, concept_id: slot.concept_id,
      billable_attempt_id: attempt.billable_attempt_id }).slice(7)}`;
  }

  function conceptProviderRequestRef(value) {
    if (!isRecord(value)) return undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, "provider_request_ref");
      if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string" ||
          !/^provider-request-[a-f0-9]{64}$/.test(descriptor.value)) return undefined;
      return descriptor.value;
    } catch { return undefined; }
  }

  function conceptLineage(batch, slot, version) {
    const attempt = slot?.attempts?.find((item) => item.billable_attempt_id === slot.current_billable_attempt_id);
    if (!slot || !attempt || !attempt.metering_attempt || !attempt.dispatch_intent_ref ||
        !attempt.provider_target_binding_sha256 || !attempt.rendered_prompt_sha256 || !attempt.usage_evidence_ref) {
      throw new CreativeApiError("unavailable", "concepts.create", "concept.lineage");
    }
    return Object.freeze({
      contract: "CreativeConceptLineage", schema_version: "1.1",
      mapping_status: "local_mapping_external_acceptance_pending",
      concept_id: slot.concept_id, ordinal: slot.ordinal, parent_version_id: null,
      brief_sha256: batch.brief_sha256, package_id: batch.package_id, package_sha256: batch.package_sha256,
      plan_id: batch.plan_id, plan_sha256: batch.plan_sha256, policy_snapshot: batch.policy_snapshot,
      adapter_snapshot: batch.adapter_snapshot, source_assets: batch.references, attempt: attempt.metering_attempt,
      logical_operation_id: slot.logical_operation_id, billable_attempt_id: attempt.billable_attempt_id,
      transport_attempt_id: attempt.transport_attempt_id, provider_request_ref: attempt.latest_provider_request_id,
      dispatch_intent_ref: attempt.dispatch_intent_ref,
      provider_target_binding_sha256: attempt.provider_target_binding_sha256,
      rendered_prompt_sha256: attempt.rendered_prompt_sha256,
      usage_evidence_refs: Object.freeze([...attempt.usage_evidence_refs]),
      usage_completeness: attempt.usage_completeness ?? "unknown",
      unknown_financial_exposure: attempt.unknown_financial_exposure,
      design_version_id: version.design_version_id, design_sha256: version.design_hash,
      artifact_id: version.artifact.artifact_id, artifact_sha256: version.artifact.content_hash,
      artifact_media_type: version.artifact.media_type,
    });
  }

  function conceptBatchStatus(batch) {
    const hasUnknown = batch.slots.some((slot) => slot.attempts.some((attempt) => attempt.unknown_financial_exposure));
    if (hasUnknown) return "unknown_hold";
    if (batch.slots.every((slot) => slot.status === "succeeded")) return "completed";
    if (batch.slots.some((slot) => ["failed", "cancelled", "unknown"].includes(slot.status))) return "partial";
    if (batch.slots.some((slot) => slot.status === "succeeded")) return "partial";
    return "running";
  }

  async function executeConceptsCreate(principal, request, started) {
    const operation = request.operation;
    const scope = Object.freeze({ ...started.scope, brief_id: request.payload.brief_id });
    const requestSnapshot = Object.freeze({ action_id: request.action_id, brief_id: request.payload.brief_id,
      plan_id: request.payload.plan_id, requested_count: request.payload.requested_count,
      references: Object.freeze(request.payload.references.map((reference) => Object.freeze({
        asset_id: reference.asset_id, role_ref: reference.role_ref,
      }))) });
    const brief = await loadBrief(scope, request.payload.brief_id, operation);
    const briefHash = canonicalHash(brief);
    const conceptPlan = Object.freeze({ source_refs: Object.freeze([...request.source_refs]), steps: Object.freeze([]) });
    let permissionContext = await verifyRequestedAssetPermissions(scope, brief, conceptPlan, operation,
      undefined, null, briefHash, requestSnapshot.references);
    const expectedSourceRefs = [...new Set(permissionContext.concept_asset_metadata.map((asset) => asset.source_ref))];
    if (canonicalSerialize(expectedSourceRefs) !== canonicalSerialize(request.source_refs) ||
        expectedSourceRefs.some((sourceRef) => !brief.source_identity.some((source) => source.source_id === sourceRef))) {
      throw new CreativeApiError("scope_denied", operation, "source_refs");
    }
    await assertCurrentCreativeContext(scope, brief, null, operation);

    const resolveSnapshots = requiredPort(ports, "concepts.resolveTrustedSnapshots", operation);
    let ownerSnapshots;
    try {
      ownerSnapshots = immutableRequestSnapshot(await resolveSnapshots(Object.freeze({ scope, actor_id: principal.actor_id,
        brief, brief_hash: briefHash, research_package: permissionContext.research_package,
        request: requestSnapshot, now: new Date(now()).toISOString() })));
    } catch { throw new CreativeApiError("unavailable", operation, "concept_policy_or_adapter", { retryable: true }); }
    if (!isRecord(ownerSnapshots) || !isRecord(ownerSnapshots.policy_snapshot) || !isRecord(ownerSnapshots.adapter_snapshot)) {
      throw new CreativeApiError("unavailable", operation, "concept_policy_or_adapter");
    }
    const policySnapshot = ownerSnapshots.policy_snapshot;
    const adapterSnapshot = ownerSnapshots.adapter_snapshot;
    const nativeRoute = imageProviderRoute(adapterSnapshot.provider_name);
    if (policySnapshot.budget_scope_id !== principal.budget_scope_id || !nativeRoute ||
        adapterSnapshot.operation_mapping_ref !== nativeRoute.concept_mapping_ref ||
        adapterSnapshot.provider_operation !== "edit" ||
        adapterSnapshot.endpoint !== nativeRoute.edit_endpoint || adapterSnapshot.operation_kind !== "image_edit" ||
        adapterSnapshot.sdk_name !== "native-fetch" || adapterSnapshot.sdk_version !== process.versions.node) {
      throw new CreativeApiError("unavailable", operation, "concept_policy_or_adapter");
    }
    const assertPolicyCurrent = (snapshot = policySnapshot) => {
      const currentTime = new Date(now()).getTime();
      const observed = Date.parse(snapshot.observed_at);
      const deadline = Date.parse(snapshot.deadline_at);
      if (!Number.isFinite(currentTime) || !Number.isFinite(observed) || !Number.isFinite(deadline) ||
          currentTime < observed || currentTime >= deadline || currentTime >= Date.parse(snapshot.expires_at) ||
          currentTime >= Date.parse(snapshot.budget_expires_at) || currentTime - observed > snapshot.maximum_elapsed_ms ||
          Date.parse(principal.expires_at) <= currentTime || snapshot.budget_scope_id !== principal.budget_scope_id ||
          requestSnapshot.requested_count > snapshot.maximum_concept_count || requestSnapshot.references.length > snapshot.maximum_reference_count) {
        throw new CreativeApiError("budget_unavailable", operation, "concept_policy");
      }
    };
    assertPolicyCurrent();

    const provider = ports.provider;
    if (!isRecord(provider) || typeof provider.getConceptConfiguration !== "function" ||
        typeof provider.inspectConceptReferences !== "function") {
      throw new CreativeApiError("unavailable", operation, "provider.concept_capability");
    }
    let configuration;
    try { configuration = immutableRequestSnapshot(provider.getConceptConfiguration()); }
    catch { throw new CreativeApiError("unavailable", operation, "provider.concept_configuration"); }
    if (!isRecord(configuration) || configuration.model_id !== adapterSnapshot.model ||
        canonicalSerialize(configuration.configuration) !== canonicalSerialize(adapterSnapshot.configuration) ||
        (nativeRoute.name === "openrouter" && (configuration.provider_tag !== adapterSnapshot.provider_tag ||
          canonicalSerialize(configuration.capabilities) !== canonicalSerialize(adapterSnapshot.capabilities)))) {
      throw new CreativeApiError("unavailable", operation, "concept_adapter_configuration");
    }
    const resolveRoute = requiredPort(ports, "provider.resolveRoute", operation);
    const nativePlan = Object.freeze({ operation: "concept.generate", brief_id: brief.brief_id,
      source_refs: Object.freeze([...expectedSourceRefs]),
      steps: Object.freeze([Object.freeze({ action: "concept.generate", source_refs: Object.freeze([...expectedSourceRefs]),
        parameters: Object.freeze({ variant_count: 1 }) })]) });
    const route = routeFor(await resolveRoute(Object.freeze({ scope, actor_id: principal.actor_id,
      operation: "edit", plan: nativePlan })), operation);
    if (route.provider.name !== nativeRoute.name || route.provider.model !== adapterSnapshot.model ||
        route.provider.endpoint !== nativeRoute.edit_endpoint || route.provider.sdk.name !== "native-fetch" ||
        route.provider.sdk.version !== process.versions.node) {
      throw new CreativeApiError("unavailable", operation, "concept_provider_route");
    }
    const storedBatchPort = requiredPort(ports, "storage.getConceptBatch", operation);
    let storedRecord;
    try { storedRecord = await storedBatchPort(Object.freeze({ scope, action_id: request.action_id })); }
    catch { throw new CreativeApiError("unavailable", operation, "concept.batch", { retryable: true }); }
    let batch;
    if (storedRecord) {
      try {
        replayCreativeConceptBatch(storedRecord.batch, { trusted_scope: scope, request: requestSnapshot });
      } catch { throw new CreativeApiError("conflict", operation, "action_id"); }
      batch = storedRecord.batch;
      if (storedRecord.job_id !== started.job_id || storedRecord.actor_id !== principal.actor_id ||
          storedRecord.request_hash !== started.request_hash || canonicalSerialize(batch.adapter_snapshot) !== canonicalSerialize(adapterSnapshot) ||
          batch.brief_sha256 !== briefHash || batch.policy_snapshot.budget_scope_id !== principal.budget_scope_id ||
          !["pending", "running", "unknown_hold", "partial", "completed", "cancelled"].includes(storedRecord.status)) {
        throw new CreativeApiError("unavailable", operation, "concept.batch_identity");
      }
    }
    let initialProposal;
    try {
      initialProposal = createCreativeConceptBatchProposal({ trusted_scope: scope, now: new Date(now()).toISOString(),
        brief, brief_sha256: briefHash, research_package: permissionContext.research_package,
        request: requestSnapshot, permission_evidence: permissionContext.permission_evidence,
        policy_snapshot: policySnapshot, adapter_snapshot: adapterSnapshot });
    } catch (error) { throw safeError(error, operation); }
    const preflightSingleLimit = Math.min(initialProposal.policy_snapshot.maximum_single_reference_bytes,
      batch?.policy_snapshot.maximum_single_reference_bytes ?? Number.MAX_SAFE_INTEGER);
    const preflightAggregateLimit = Math.min(initialProposal.policy_snapshot.maximum_aggregate_reference_bytes,
      batch?.policy_snapshot.maximum_aggregate_reference_bytes ?? Number.MAX_SAFE_INTEGER);
    let referenceMetadata;
    try {
      referenceMetadata = immutableRequestSnapshot(await provider.inspectConceptReferences(Object.freeze({ scope,
        references: Object.freeze(permissionContext.concept_asset_metadata.map((item) => Object.freeze({
          asset_id: item.asset_id, source_ref: item.source_ref, content_hash: item.content_hash,
          media_type: item.media_type, role_ref: item.role_ref,
        }))), maximum_single_reference_bytes: preflightSingleLimit,
        maximum_aggregate_reference_bytes: preflightAggregateLimit })));
    } catch { throw new CreativeApiError("permission_denied", operation, "concept_reference_preflight"); }
    if (!Array.isArray(referenceMetadata) || referenceMetadata.length !== requestSnapshot.references.length) {
      throw new CreativeApiError("unavailable", operation, "concept_reference_preflight");
    }
    let totalReferenceBytes = 0;
    for (let index = 0; index < referenceMetadata.length; index += 1) {
      const actual = referenceMetadata[index];
      const expected = permissionContext.concept_asset_metadata[index];
      if (!isRecord(actual) || actual.asset_id !== expected.asset_id || actual.source_ref !== expected.source_ref ||
          actual.content_hash !== expected.content_hash || actual.media_type !== expected.media_type ||
          actual.role_ref !== expected.role_ref || !Number.isSafeInteger(actual.width) || actual.width < 1 || actual.width > 4096 ||
          !Number.isSafeInteger(actual.height) || actual.height < 1 || actual.height > 4096 ||
          !Number.isSafeInteger(actual.byte_length) || actual.byte_length < 1 || actual.byte_length > preflightSingleLimit) {
        throw new CreativeApiError("permission_denied", operation, "concept_reference_preflight");
      }
      totalReferenceBytes += actual.byte_length;
      if (!Number.isSafeInteger(totalReferenceBytes) || totalReferenceBytes > preflightAggregateLimit) {
        throw new CreativeApiError("permission_denied", operation, "concept_reference_preflight");
      }
    }
    try {
      const metadataBoundProposal = createCreativeConceptBatchProposal({ trusted_scope: scope,
        now: new Date(now()).toISOString(), brief, brief_sha256: briefHash,
        research_package: permissionContext.research_package, request: requestSnapshot,
        permission_evidence: permissionContext.permission_evidence, policy_snapshot: policySnapshot,
        adapter_snapshot: adapterSnapshot, reference_metadata: referenceMetadata });
      if (batch) {
        const metadataReferences = metadataBoundProposal.references.map(({ asset_id, source_ref, content_hash, media_type,
          role_ref, width, height, byte_length }) => ({ asset_id, source_ref, content_hash, media_type, role_ref, width, height, byte_length }));
        const storedReferences = batch.references.map(({ asset_id, source_ref, content_hash, media_type,
          role_ref, width, height, byte_length }) => ({ asset_id, source_ref, content_hash, media_type, role_ref, width, height, byte_length }));
        if (canonicalSerialize(metadataReferences) !== canonicalSerialize(storedReferences)) {
          throw new CreativeApiError("stale_version", operation, "concept_reference_metadata");
        }
      } else {
        batch = metadataBoundProposal;
        const beginBatch = requiredPort(ports, "storage.beginConceptBatch", operation);
        const created = await beginBatch(Object.freeze({ scope, actor_id: principal.actor_id, job_id: started.job_id,
          action_id: request.action_id, request_hash: started.request_hash, lease_token: started.lease_token, batch }));
        if (!isRecord(created) || !["created", "existing"].includes(created.status) || !isRecord(created.batch) ||
            created.batch.batch_id !== batch.batch_id || canonicalSerialize(created.batch) !== canonicalSerialize(batch)) {
          throw new CreativeApiError("unavailable", operation, "concept.batch_persistence");
        }
        batch = created.batch;
      }
    } catch (error) {
      if (error instanceof CreativeApiError) throw error;
      throw safeError(error, operation);
    }

    let currentPermissionProofs = permissionContext.proofs;
    const assertConceptCurrent = async () => {
      assertPolicyCurrent(batch.policy_snapshot);
      await assertCurrentCreativeContext(scope, brief, null, operation);
      const refreshed = await verifyRequestedAssetPermissions(scope, brief, conceptPlan, operation,
        undefined, null, briefHash, requestSnapshot.references);
      if (canonicalSerialize(refreshed.concept_asset_metadata) !== canonicalSerialize(permissionContext.concept_asset_metadata)) {
        throw new CreativeApiError("stale_version", operation, "concept_references");
      }
      await assertCurrentCreativeContext(scope, brief, null, operation);
      if (refreshed.proofs.some((proof) => proof.expires_at <= new Date(now()).getTime())) {
        throw new CreativeApiError("permission_denied", operation, "asset_permission_evidence");
      }
      currentPermissionProofs = refreshed.proofs;
      return currentPermissionProofs;
    };
    const eventPort = requiredPort(ports, "storage.appendConceptEvent", operation);
    const persistEvent = async (event) => {
      const ack = await eventPort(Object.freeze({ scope, actor_id: principal.actor_id, job_id: started.job_id,
        action_id: request.action_id, request_hash: started.request_hash, lease_token: started.lease_token, event }));
      if (!isRecord(ack) || !["recorded", "replayed"].includes(ack.status) || !isRecord(ack.batch) ||
          ack.batch.batch_id !== batch.batch_id) throw new CreativeApiError("unavailable", operation, "concept.event");
      batch = ack.batch;
      return batch;
    };
    const baseEvent = (slot, event_type, fields = {}) => Object.freeze({ tenant_id: batch.tenant_id,
      project_id: batch.project_id, action_id: batch.action_id, batch_id: batch.batch_id,
      concept_id: slot?.concept_id ?? null, event_id: boundedString(idFactory(), "concept_event_id", 256), event_type, ...fields });
    if (batch.schema_version !== CREATIVE_CONCEPT_PROPOSAL.schema_version) {
      const priorSchemaVersion = batch.schema_version;
      await persistEvent(baseEvent(null, "upgrade_retry_disposition", {
        from_schema_version: priorSchemaVersion, to_schema_version: CREATIVE_CONCEPT_PROPOSAL.schema_version,
      }));
    }
    const dispatchCount = () => batch.slots.reduce((total, slot) => total + slot.attempts.length, 0);
    const batchHasNativeHardStop = () => batch.slots.some((slot) => slot.attempts.some((attempt) =>
      ["hard_stop", "legacy_unclassified"].includes(attempt.latest_retry_disposition)));
    const hasEligibleSettledFailure = (slot) => {
      const latest = slot.attempts.at(-1);
      return latest?.latest_provider_outcome === "failed" && latest.latest_retry_disposition === "eligible_retry" &&
        latest.usage_completeness === "complete" && latest.financial_exposure_status === "settled" &&
        latest.unknown_financial_exposure === false;
    };
    const responseStagePort = requiredPort(ports, "storage.getConceptResponseStage", operation);
    const getStage = async (slot) => responseStagePort(Object.freeze({ scope, action_id: request.action_id, concept_id: slot.concept_id }));
    const appendOutcome = async (slot, attempt, outcome, artifactHash, providerRequestRef, usageEvidenceRef,
      usageCompleteness, recovered = false, financialSettlementEvidence = undefined, retryDisposition = undefined) => {
      const eventType = recovered && attempt.status === "unknown" ? "reconcile_unknown_attempt" : "provider_outcome";
      await persistEvent(baseEvent(slot, eventType, {
        billable_attempt_id: attempt.billable_attempt_id, transport_attempt_id: attempt.transport_attempt_id,
        outcome, outcome_evidence_ref: `concept-outcome:${canonicalHash({ batch_id: batch.batch_id,
          concept_id: slot.concept_id, billable_attempt_id: attempt.billable_attempt_id,
          outcome, artifact_sha256: artifactHash ?? null }).slice(7)}`,
        ...(providerRequestRef ? { provider_request_id: providerRequestRef } : {}),
        ...(artifactHash ? { artifact_sha256: artifactHash } : {}),
        ...(financialSettlementEvidence ? { financial_exposure_status: "settled",
          financial_settlement_evidence: financialSettlementEvidence } : {}),
        ...(eventType === "provider_outcome" && batch.schema_version === CREATIVE_CONCEPT_PROPOSAL.schema_version &&
          ["eligible_retry", "hard_stop"].includes(retryDisposition)
          ? { retry_disposition: retryDisposition } : {}),
        usage_evidence_ref: conceptUsageRef(usageEvidenceRef, batch, slot, attempt), usage_completeness: usageCompleteness,
      }));
    };
    const stageCandidate = async (slot, stage, usageEvidenceRef = undefined, usageCompleteness = "unknown") => {
      const currentSlot = batch.slots.find((item) => item.concept_id === slot.concept_id);
      if (currentSlot.status === "staged" || currentSlot.status === "succeeded") return;
      const attempt = currentSlot.attempts.find((item) => item.billable_attempt_id === currentSlot.current_billable_attempt_id);
      if (!attempt || !["dispatching", "response_received", "unknown"].includes(currentSlot.status) ||
          attempt.billable_attempt_id !== stage.billable_attempt_id || attempt.transport_attempt_id !== stage.transport_attempt_id ||
          !["dispatching", "response_received", "unknown"].includes(attempt.status) ||
          stage.status !== "response_received") throw new CreativeApiError("unavailable", operation, "concept.response_stage");
      let inspected;
      try { inspected = await inspectCreativeConceptImageBytes({ bytes: stage.response_bytes,
        expected_media_type: stage.media_type, maximum_bytes: Number.MAX_SAFE_INTEGER,
        expected_dimensions: { width: stage.width, height: stage.height } }); }
      catch { throw new CreativeApiError("failed", operation, "concept.response_image"); }
      if (inspected.content_sha256 !== stage.content_hash) throw new CreativeApiError("failed", operation, "concept.response_hash");
      if (currentSlot.status === "dispatching" || currentSlot.status === "unknown") {
        await appendOutcome(currentSlot, attempt, "succeeded", stage.content_hash, undefined,
          usageEvidenceRef, usageCompleteness, true);
      }
      const latest = batch.slots.find((item) => item.concept_id === slot.concept_id);
      const latestAttempt = latest.attempts.find((item) => item.billable_attempt_id === stage.billable_attempt_id);
      await persistEvent(baseEvent(latest, "candidate_staged", {
        billable_attempt_id: latestAttempt.billable_attempt_id, transport_attempt_id: latestAttempt.transport_attempt_id,
        artifact_sha256: stage.content_hash, media_type: stage.media_type, width: stage.width, height: stage.height,
        storage_stage_ref: stage.stage_ref,
        inspection_evidence_ref: `concept-image-inspection:${canonicalHash({ artifact_sha256: stage.content_hash,
          media_type: stage.media_type, width: stage.width, height: stage.height }).slice(7)}`,
      }));
    };
    const markUnobservedAttemptUnknown = async (slot) => {
      const currentSlot = batch.slots.find((item) => item.concept_id === slot.concept_id);
      if (!["reserved", "dispatching"].includes(currentSlot.status)) return;
      const attempt = currentSlot.attempts.find((item) => item.billable_attempt_id === currentSlot.current_billable_attempt_id);
      await appendOutcome(currentSlot, attempt, "unknown", undefined, undefined,
        undefined, "unknown");
    };

    const recordPrivateCallbacks = (reservation, attempt, transportAttemptId, dispatchIntentRef) => {
      const providerJobs = ports.jobs;
      const requestIdPort = providerJobs?.recordPrivateProviderAttribution;
      const usagePort = providerJobs?.recordPrivateProviderUsageAttribution;
      const pendingPort = providerJobs?.stagePrivateProviderAttribution;
      return {
        ...(typeof requestIdPort === "function" ? { async recordPrivateProviderRequestId(attribution) {
          if (!isRecord(attribution) || typeof attribution.provider_request_id !== "string" ||
              typeof attribution.provider_request_ref !== "string") throw new CreativeApiError("failed", operation, "provider_attribution");
          const ack = await requestIdPort(Object.freeze({ scope, actor_id: principal.actor_id, job_id: started.job_id,
            action_id: request.action_id, request_hash: started.request_hash, operation, provider: route.provider.name,
            model: route.provider.model, reservation_ref: reservation.reservation_id,
            billable_attempt_id: attempt.billable_attempt_id, transport_attempt_id: transportAttemptId,
            dispatch_intent_ref: dispatchIntentRef, provider_request_id: attribution.provider_request_id,
            provider_request_ref: attribution.provider_request_ref }));
          if (!isRecord(ack) || !["recorded", "replayed"].includes(ack.status) ||
              ack.transport_attempt_id !== transportAttemptId || ack.provider_request_ref !== attribution.provider_request_ref) {
            throw new CreativeApiError("unavailable", operation, "provider_attribution_ack");
          }
          return ack;
        } } : {}),
        ...(typeof usagePort === "function" ? { async recordPrivateProviderUsage(attribution) {
          if (!isRecord(attribution) || !isRecord(attribution.usage) || typeof attribution.target_binding_sha256 !== "string") {
            throw new CreativeApiError("failed", operation, "provider_usage_attribution");
          }
          const usage_sha256 = canonicalHash(attribution.usage);
          const ack = await usagePort(Object.freeze({ scope, actor_id: principal.actor_id, job_id: started.job_id,
            action_id: request.action_id, request_hash: started.request_hash, operation, provider: route.provider.name,
            model: route.provider.model, reservation_ref: reservation.reservation_id,
            billable_attempt_id: attempt.billable_attempt_id, transport_attempt_id: transportAttemptId,
            dispatch_intent_ref: dispatchIntentRef, target_binding_sha256: attribution.target_binding_sha256,
            usage_sha256, usage: attribution.usage }));
          if (!isRecord(ack) || !["recorded", "replayed"].includes(ack.status) ||
              ack.transport_attempt_id !== transportAttemptId || ack.target_binding_sha256 !== attribution.target_binding_sha256 ||
              ack.usage_sha256 !== usage_sha256) throw new CreativeApiError("unavailable", operation, "provider_usage_attribution_ack");
          return ack;
        } } : {}),
        ...(typeof pendingPort === "function" ? { async stagePrivateProviderAttribution(attribution) {
          if (!isRecord(attribution) || typeof attribution.target_binding_sha256 !== "string" ||
              (attribution.provider_request_id === undefined) !== (attribution.provider_request_ref === undefined) ||
              attribution.provider_request_id === undefined && attribution.usage === undefined) {
            throw new CreativeApiError("failed", operation, "provider_attribution_pending");
          }
          const payload = Object.freeze({ scope, actor_id: principal.actor_id, job_id: started.job_id,
            action_id: request.action_id, request_hash: started.request_hash, operation, provider: route.provider.name,
            model: route.provider.model, reservation_ref: reservation.reservation_id,
            billable_attempt_id: attempt.billable_attempt_id, transport_attempt_id: transportAttemptId,
            dispatch_intent_ref: dispatchIntentRef, target_binding_sha256: attribution.target_binding_sha256,
            ...(attribution.provider_request_id !== undefined ? { provider_request_id: attribution.provider_request_id,
              provider_request_ref: attribution.provider_request_ref } : {}),
            ...(attribution.usage !== undefined ? { usage: attribution.usage } : {}) });
          const payloadBody = { tenant_id: scope.tenant_id, project_id: scope.project_id, actor_id: payload.actor_id,
            job_id: payload.job_id, action_id: payload.action_id, request_hash: payload.request_hash,
            operation: payload.operation, provider: payload.provider, model: payload.model,
            reservation_ref: payload.reservation_ref, billable_attempt_id: payload.billable_attempt_id,
            transport_attempt_id: payload.transport_attempt_id, dispatch_intent_ref: payload.dispatch_intent_ref,
            target_binding_sha256: payload.target_binding_sha256,
            ...(payload.provider_request_id !== undefined ? { provider_request_id: payload.provider_request_id,
              provider_request_ref: payload.provider_request_ref } : {}),
            ...(payload.usage !== undefined ? { usage: payload.usage, usage_sha256: canonicalHash(payload.usage) } : {}) };
          const payload_sha256 = canonicalHash(payloadBody);
          const ack = await pendingPort(payload);
          if (!isRecord(ack) || !["staged", "replayed"].includes(ack.status) ||
              ack.pending_ref !== `private-attribution:${payload_sha256.slice(7)}` ||
              ack.transport_attempt_id !== transportAttemptId || ack.payload_sha256 !== payload_sha256) {
            throw new CreativeApiError("unavailable", operation, "provider_attribution_pending_ack");
          }
          return ack;
        } } : {}),
      };
    };

    const conceptExecutionInput = (slot) => ({ scope, actor_id: principal.actor_id, job_id: started.job_id,
      brief, base_design: null, plan: nativePlan,
              concept_reference_manifest: Object.freeze({ contract: "CreativeConceptReferenceManifest", schema_version: "1.0",
                tenant_id: principal.tenant_id, project_id: principal.project_id, brief_id: brief.brief_id,
                brief_hash: briefHash, research_package_id: permissionContext.research_package.package_id,
                research_package_hash: canonicalHash(permissionContext.research_package),
                mapping_ref: batch.adapter_snapshot.operation_mapping_ref,
                mapping_version: batch.adapter_snapshot.capability_schema_version,
                prompt_template_ref: batch.adapter_snapshot.prompt_template_ref,
                prompt_template_version: batch.adapter_snapshot.prompt_template_version,
                prompt_template_sha256: batch.adapter_snapshot.prompt_template_sha256,
                references: Object.freeze(batch.references.map((reference) => Object.freeze({ source_ref: reference.source_ref,
                  asset_id: reference.asset_id, content_hash: reference.content_hash, media_type: reference.media_type,
                  width: reference.width, height: reference.height, role_ref: reference.role_ref }))) }),
              concept_batch_id: batch.batch_id, concept_id: slot.concept_id,
    });
    const dispatchSlot = async (conceptId) => {
      let slot = batch.slots.find((item) => item.concept_id === conceptId);
      if (!slot || !["pending", "failed"].includes(slot.status) || dispatchCount() >= 2 || batchHasNativeHardStop() ||
          slot.status === "failed" && slot.attempts.at(-1)?.latest_provider_outcome === "failed" &&
            !hasEligibleSettledFailure(slot)) return false;
      assertPolicyCurrent(batch.policy_snapshot);
      await assertConceptCurrent();
      let reservationCapture;
      let metered;
      try {
        metered = await runMetered(principal, request, started, "image_edit", route, "provider.edit",
          async ({ method, attempt, reservation_ref, signal, deadline_at, transportAttemptId, dispatch_intent_ref,
            recordTransportAttempt, revalidateDispatch, assertDispatchCurrent, prepared_execution }) => {
            const reservation = reservationCapture?.reservation;
            if (!reservation || reservation.reservation_id !== reservation_ref ||
                reservationCapture.attempt.billable_attempt_id !== attempt.billable_attempt_id) {
              throw new CreativeApiError("unavailable", operation, "concept.reservation");
            }
            const privateCallbacks = recordPrivateCallbacks(reservation, attempt, transportAttemptId, dispatch_intent_ref);
            const value = await method(Object.freeze({ ...conceptExecutionInput(slot), attempt, route,
              ...(prepared_execution ? { prepared_attempt: prepared_execution } : {}),
              reservation_ref, transport_attempt_id: transportAttemptId, dispatch_intent_ref,
              recordTransportAttempt, revalidateDispatch, assertDispatchCurrent,
              ...privateCallbacks,
              async recordConceptDispatchBinding(binding) {
                await persistEvent(baseEvent(slot, "dispatch_started", {
                  billable_attempt_id: attempt.billable_attempt_id, transport_attempt_id: transportAttemptId,
                  dispatch_intent_ref, provider_target_binding_sha256: binding.target_binding_sha256,
                  rendered_prompt_sha256: binding.rendered_prompt_sha256,
                }));
                const ack = await requiredPort(ports, "storage.recordConceptDispatchBinding", operation)(Object.freeze({
                  scope, actor_id: principal.actor_id, job_id: started.job_id, action_id: request.action_id,
                  request_hash: started.request_hash, lease_token: started.lease_token, concept_batch_id: batch.batch_id,
                  concept_id: slot.concept_id, billable_attempt_id: attempt.billable_attempt_id,
                  transport_attempt_id: transportAttemptId, reservation_ref, dispatch_intent_ref,
                  target_binding: binding.target_binding, target_binding_sha256: binding.target_binding_sha256,
                  rendered_prompt_sha256: binding.rendered_prompt_sha256,
                }));
                if (!isRecord(ack) || !["recorded", "replayed"].includes(ack.status) ||
                    ack.transport_attempt_id !== transportAttemptId || ack.target_binding_sha256 !== binding.target_binding_sha256) {
                  throw new CreativeApiError("unavailable", operation, "concept.dispatch_binding");
                }
                return ack;
              },
              async stageConceptResponse(stageInput) {
                const ack = await requiredPort(ports, "storage.stageConceptResponse", operation)(Object.freeze({
                  scope, actor_id: principal.actor_id, job_id: started.job_id, action_id: request.action_id,
                  request_hash: started.request_hash, lease_token: started.lease_token, concept_batch_id: batch.batch_id,
                  concept_id: slot.concept_id, billable_attempt_id: attempt.billable_attempt_id,
                  transport_attempt_id: transportAttemptId, reservation_ref, dispatch_intent_ref,
                  bytes: Uint8Array.from(stageInput.bytes), content_hash: stageInput.content_hash,
                  media_type: stageInput.media_type, width: stageInput.width, height: stageInput.height,
                  target_binding_sha256: stageInput.target_binding_sha256,
                }));
                if (!isRecord(ack) || !["staged", "replayed"].includes(ack.status) ||
                    typeof ack.stage_ref !== "string" || ack.content_hash !== stageInput.content_hash) {
                  throw new CreativeApiError("unavailable", operation, "concept.response_stage");
                }
                return ack;
              }, signal, deadline_at,
            }));
            return { value, usage: value?.usage, provider_outcome: "succeeded" };
          }, assertConceptCurrent, creativeContextFence(brief), {
            allowTerminalFailure: true, allowUnknownOutcome: true,
            logicalOperationId: slot.logical_operation_id,
            maximumDeadlineAt: batch.policy_snapshot.deadline_at,
            ...(typeof ports.provider?.prepareAttempt === "function" ? {
              prepareAttempt: ({ attempt, signal, deadline_at }) => ports.provider.prepareAttempt(Object.freeze({
                ...conceptExecutionInput(slot), operation: "edit", attempt, signal, deadline_at,
              })),
            } : {}),
            async onReservation({ reservation, transport_attempt_id, attempt }) {
              const exactReservation = Object.freeze({ status: reservation.status,
                reservation_id: reservation.reservation_id, billable_attempt_id: reservation.billable_attempt_id,
                held_amount: Object.freeze({ amount: reservation.held_amount.amount, currency: reservation.held_amount.currency }),
                lease_id: reservation.lease_id });
              reservationCapture = { reservation: exactReservation, attempt, transport_attempt_id };
              slot = batch.slots.find((item) => item.concept_id === conceptId);
              await persistEvent(baseEvent(slot, "reserve_attempt", { billable_attempt_id: attempt.billable_attempt_id,
                transport_attempt_id, metered_attempt: attempt, reservation: exactReservation }));
            },
          });
      } catch (error) {
        const latestSlot = batch.slots.find((item) => item.concept_id === conceptId);
        if (latestSlot && ["reserved", "dispatching"].includes(latestSlot.status)) {
          const staged = await getStage(latestSlot);
          if (staged) {
            await stageCandidate(latestSlot, staged, undefined, "unknown");
          } else {
            await markUnobservedAttemptUnknown(latestSlot);
          }
        } else if (latestSlot?.status === "cancelled") {
          throw new CreativeApiError("cancelled", operation);
        } else if (!reservationCapture) {
          throw error;
        }
        return true;
      }
      const latestSlot = batch.slots.find((item) => item.concept_id === conceptId);
      if (!latestSlot) throw new CreativeApiError("unavailable", operation, "concept.slot");
      const stage = await getStage(latestSlot);
      const currentAttempt = latestSlot.attempts.find((item) => item.billable_attempt_id === metered.attempt_id);
      if (!currentAttempt) throw new CreativeApiError("unavailable", operation, "concept.attempt");
      const providerRequestRef = conceptProviderRequestRef(metered.value);
      const mapping = metered.usage_evidence;
      const settlement = metered.metering?.settlement;
      const acknowledgement = metered.metering?.observation_ack;
      const financialSettlementEvidence = mapping?.status === "settled_owner_mapping" &&
        metered.metering?.status === "settled" && settlement?.status === "settled" &&
        settlement.reservation_id === currentAttempt.reservation_ref &&
        acknowledgement && ["accepted", "duplicate"].includes(acknowledgement.status) &&
        acknowledgement.source_observation_id === mapping.source_observation_id &&
        acknowledgement.effective_billable_attempt_id === mapping.billable_attempt_id &&
        mapping.billable_attempt_id === currentAttempt.billable_attempt_id &&
        mapping.observation_ref === metered.usage_ref && metered.usage_completeness === "complete"
        ? Object.freeze({ status: "settled", reservation_id: settlement.reservation_id,
          source_observation_id: metered.usage_ref,
          effective_billable_attempt_id: acknowledgement.effective_billable_attempt_id }) : undefined;
      if (stage) {
        await appendOutcome(latestSlot, currentAttempt, "succeeded", stage.content_hash, providerRequestRef,
          metered.usage_ref, metered.usage_completeness, false, financialSettlementEvidence);
        await stageCandidate(batch.slots.find((item) => item.concept_id === conceptId), stage,
          metered.usage_ref, metered.usage_completeness);
      } else {
        const providerOutcome = ["succeeded", "failed"].includes(metered.provider_outcome)
          ? metered.provider_outcome : "unknown";
        await appendOutcome(latestSlot, currentAttempt, providerOutcome, undefined, providerRequestRef,
          metered.usage_ref, metered.usage_completeness, false, financialSettlementEvidence,
          metered.private_retry_disposition);
      }
      return true;
    };

    // A durable response stage is the recovery point. Reconstruct it byte-for-byte
    // and never send another request for the same reserved attempt.
    for (const snapshotSlot of [...batch.slots]) {
      let slot = batch.slots.find((item) => item.concept_id === snapshotSlot.concept_id);
      const staged = await getStage(slot);
      if (staged && !["staged", "succeeded", "cancelled", "failed"].includes(slot.status)) {
        const attempt = slot.attempts.find((item) => item.billable_attempt_id === staged.billable_attempt_id);
        if (!attempt) throw new CreativeApiError("unavailable", operation, "concept.response_stage_attempt");
        await stageCandidate(slot, staged, undefined, "unknown");
      } else if (!staged && ["reserved", "dispatching"].includes(slot.status)) {
        await markUnobservedAttemptUnknown(slot);
      }
      slot = batch.slots.find((item) => item.concept_id === snapshotSlot.concept_id);
      if (["pending", "failed"].includes(slot.status) && !slot.attempts.some((attempt) => attempt.unknown_financial_exposure) &&
          !batchHasNativeHardStop()) {
        await dispatchSlot(slot.concept_id);
      }
      if (batchHasNativeHardStop() || batch.slots.some((item) => item.status === "unknown" ||
          item.attempts.some((attempt) => attempt.unknown_financial_exposure))) break;
    }
    // A second billable attempt is allowed only for a known failed provider outcome
    // with complete usage and a fresh C03 reservation; never retry unknown exposure.
    for (const slotSnapshot of [...batch.slots]) {
      const slot = batch.slots.find((item) => item.concept_id === slotSnapshot.concept_id);
      const latest = slot.attempts.at(-1);
      if (batchHasNativeHardStop()) break;
      if (dispatchCount() >= 2 || slot.status !== "failed" || slot.attempts.length !== 1 || !latest ||
          !hasEligibleSettledFailure(slot)) continue;
      await dispatchSlot(slot.concept_id);
    }

    let versions;
    try { versions = await requiredPort(ports, "storage.getConceptVersions", operation)(Object.freeze({ scope, action_id: request.action_id })); }
    catch { throw new CreativeApiError("unavailable", operation, "concept.versions", { retryable: true }); }
    const candidateById = new Map(versions.map((candidate) => [candidate.concept_id, candidate]));
    const publications = [];
    let projectedBatch = batch;
    for (const slot of batch.slots) {
      const currentSlot = projectedBatch.slots.find((item) => item.concept_id === slot.concept_id);
      if (currentSlot.status !== "staged") continue;
      const stage = await getStage(currentSlot);
      if (!stage) throw new CreativeApiError("unavailable", operation, "concept.response_stage");
      const attempt = currentSlot.attempts.find((item) => item.billable_attempt_id === currentSlot.current_billable_attempt_id);
      const designVersionId = `concept-design:${canonicalHash({ concept_id: currentSlot.concept_id,
        billable_attempt_id: attempt.billable_attempt_id, artifact_sha256: stage.content_hash }).slice(7)}`;
      const artifactId = `concept-artifact:${canonicalHash({ concept_id: currentSlot.concept_id,
        billable_attempt_id: attempt.billable_attempt_id, artifact_sha256: stage.content_hash }).slice(7)}`;
      const designBase = Object.freeze({ contract: "DesignVersion", schema_version: "1.0",
        event_id: boundedString(idFactory(), "design_event_id", 256), tenant_id: principal.tenant_id,
        project_id: principal.project_id, correlation_id: request.correlation_id, producer: "creative-runtime",
        occurred_at: new Date(now()).toISOString(), ingested_at: new Date(now()).toISOString(),
        environment: request.environment, billing_mode: request.billing_mode,
        source_refs: Object.freeze(expectedSourceRefs), logical_operation_id: currentSlot.logical_operation_id,
        design_version_id: designVersionId, brief_id: brief.brief_id, parent_version_id: null, brief_hash: briefHash,
        artifact: Object.freeze({ artifact_id: artifactId, content_hash: stage.content_hash, media_type: stage.media_type }),
        creative_asset_use: Object.freeze({ contract: "CreativeAssetUseSet", schema_version: "1.0", status: "verified",
          brief_hash: briefHash, entries: Object.freeze(currentPermissionProofs.map((proof) => Object.freeze({
            asset_id: proof.asset_id, action: proof.action, source_ref: proof.source_ref,
            content_hash: proof.content_hash, package_id: proof.package_id, package_hash: proof.package_hash,
          }))) }), provider: route.provider.name, model: route.provider.model,
        billable_attempt_id: attempt.billable_attempt_id,
        usage_status: attempt.usage_completeness === "complete" && !attempt.unknown_financial_exposure ? "complete" : "incomplete",
        ...(attempt.latest_provider_request_id ? { provider_request_id: attempt.latest_provider_request_id } : {}) });
      const design = Object.freeze({ ...designBase, design_hash: computeDesignVersionHash(designBase) });
      try { validateDesignVersion(design, { trustedScope: { ...scope, design_version_id: designVersionId },
        brief_hash: briefHash, known_source_refs: expectedSourceRefs }); }
      catch { throw new CreativeApiError("failed", operation, "concept.design_version"); }
      const creationActionId = currentSlot.ordinal === 1 ? request.action_id
        : `concept-version-${canonicalHash({ action_id: request.action_id, concept_id: currentSlot.concept_id }).slice(7)}`;
      const creation = Object.freeze({ job_id: started.job_id, action_id: creationActionId, actor_id: principal.actor_id,
        request_hash: started.request_hash, logical_operation_id: currentSlot.logical_operation_id,
        billable_attempt_id: attempt.billable_attempt_id, transport_attempt_ids: Object.freeze([attempt.transport_attempt_id]),
        provider_request_ids: Object.freeze(attempt.latest_provider_request_id ? [attempt.latest_provider_request_id] : []),
        usage_refs: Object.freeze([...attempt.usage_evidence_refs]), trace_refs: Object.freeze([]) });
      const storageCommitRef = `concept-store:${canonicalHash({ concept_id: currentSlot.concept_id,
        design_hash: design.design_hash, artifact_hash: design.artifact.content_hash })}`;
      const preliminaryLineage = conceptLineage(projectedBatch, currentSlot, design);
      const lineageEvidenceRef = `concept-lineage:${canonicalHash(preliminaryLineage)}`;
      const publishEvent = baseEvent(currentSlot, "candidate_published", {
        billable_attempt_id: attempt.billable_attempt_id, transport_attempt_id: attempt.transport_attempt_id,
        design_version: design, storage_commit_ref: storageCommitRef, lineage_evidence_ref: lineageEvidenceRef,
      });
      const applied = applyCreativeConceptEvent(projectedBatch, publishEvent);
      projectedBatch = applied.batch;
      const publishedSlot = projectedBatch.slots.find((item) => item.concept_id === currentSlot.concept_id);
      const storedCandidate = candidateById.get(currentSlot.concept_id);
      if (storedCandidate && canonicalSerialize(storedCandidate.design_version) !== canonicalSerialize(design)) {
        throw new CreativeApiError("unavailable", operation, "concept.version_identity");
      }
      publications.push(Object.freeze({ concept_id: currentSlot.concept_id, ordinal: currentSlot.ordinal,
        design_version: design, creation,
        storage_commit_ref: storageCommitRef, lineage_evidence_ref: lineageEvidenceRef,
        creative_concept_lineage: conceptLineage(projectedBatch, publishedSlot, design), event_id: publishEvent.event_id }));
    }

    for (const candidate of versions) {
      const slot = projectedBatch.slots.find((item) => item.concept_id === candidate.concept_id);
      if (!slot || slot.status !== "succeeded" || slot.ordinal !== candidate.ordinal ||
          candidate.design_version.parent_version_id !== null) {
        throw new CreativeApiError("unavailable", operation, "concept.existing_version_identity");
      }
    }
    const candidatesById = new Map(publications.map((candidate) => [candidate.concept_id, candidate]));
    for (const slot of projectedBatch.slots) {
      if (slot.status !== "succeeded" || candidatesById.has(slot.concept_id)) continue;
      const candidate = candidateById.get(slot.concept_id);
      if (!candidate || candidate.ordinal !== slot.ordinal || candidate.design_version.parent_version_id !== null) {
        throw new CreativeApiError("unavailable", operation, "concept.existing_version_identity");
      }
      candidatesById.set(slot.concept_id, candidate);
    }

    const status = conceptBatchStatus(projectedBatch);
    const predicted = Object.freeze({ contract: "CreativeConceptBatchResult", schema_version: "1.1",
      batch_id: batch.batch_id, status, requested_count: batch.requested_count,
      progress: Object.freeze(projectedBatch.slots.map((slot) => Object.freeze({ concept_id: slot.concept_id,
        ordinal: slot.ordinal, status: slot.status, attempts: slot.attempts.length,
        billable_attempt_id: slot.current_billable_attempt_id }))),
      candidates: Object.freeze(projectedBatch.slots.filter((slot) => slot.status === "succeeded")
        .map((slot) => candidatesById.get(slot.concept_id)).map((candidate) => Object.freeze({ concept_id: candidate.concept_id,
        ordinal: candidate.ordinal,
        design_version: candidate.design_version, creative_concept_lineage: candidate.creative_concept_lineage,
        storage_commit_ref: candidate.storage_commit_ref, lineage_evidence_ref: candidate.lineage_evidence_ref }))) });
    const expectedResult = Object.freeze({ candidate_batch: predicted });
    const prepareObjects = requiredPort(ports, "storage.prepareConceptArtifactObjects", operation);
    if (publications.length) {
      await prepareObjects(Object.freeze({ scope, action_id: request.action_id,
        concept_ids: Object.freeze(publications.map((candidate) => candidate.concept_id)) }));
    }
    const finalProofs = await assertConceptCurrent();
    assertPolicyCurrent(batch.policy_snapshot);
    const publicationFence = creativeContextFence(brief, null, undefined, null,
      { inspection_rights: Object.freeze({ proofs: finalProofs }) });
    const completedJob = await publish(principal, request, started, expectedResult,
      async (transaction) => requiredPort(ports, "storage.publishConceptBatch", operation)(Object.freeze({
        scope, actor_id: principal.actor_id, job_id: started.job_id, action_id: request.action_id,
        request_hash: started.request_hash, expected_result: expectedResult, publications: Object.freeze(publications),
      }), transaction), publicationFence);
    const durableBatch = await storedBatchPort(Object.freeze({ scope, action_id: request.action_id }));
    const durableVersions = await requiredPort(ports, "storage.getConceptVersions", operation)(Object.freeze({ scope, action_id: request.action_id }));
    if (!isRecord(durableBatch) || durableBatch.batch.batch_id !== batch.batch_id ||
        canonicalSerialize(completedJob.result?.candidate_batch) !== canonicalSerialize(predicted) ||
        canonicalSerialize(durableVersions.map((candidate) => candidate.design_version)) !==
          canonicalSerialize(predicted.candidates.map((candidate) => candidate.design_version))) {
      throw new CreativeApiError("unavailable", operation, "concept.publication_readback");
    }
    for (const candidate of predicted.candidates) {
      const byId = await loadDesign(scope, brief, candidate.design_version.design_version_id, operation);
      if (canonicalSerialize(byId) !== canonicalSerialize(candidate.design_version)) {
        throw new CreativeApiError("unavailable", operation, "concept.public_version_readback");
      }
    }
    return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: "1.1",
      operation_id: completedJob.job_id, job: publicJob(completedJob, completedJob.job_id), result: predicted }), operation);
  }

  async function executeNew(principal, request, started) {
    const operation = request.operation;
    const payload = request.payload;
    const scope = started.scope;
    if (operation === "concepts.create") return executeConceptsCreate(principal, request, started);
    if (["composition.create", "composition.update"].includes(operation)) {
      return executeCompositionMutation(principal, request, started);
    }
    if (operation === "composition.revalidate") return executeCompositionRevalidation(principal, request, started);
    if (operation === "inspect") {
      const brief = await loadBrief(scope, payload.brief_id, operation);
      const design = await loadDesign(scope, brief, payload.design_version_id, operation);
      const parent = design.parent_version_id === null ? null
        : await loadDesign(scope, brief, design.parent_version_id, operation, { allowHistorical: true });
      await assertCurrentCreativeContext(scope, brief, design, operation);
      const getBytes = requiredPort(ports, "storage.getArtifactBytes", operation);
      let artifactBytes;
      try { artifactBytes = Uint8Array.from(await getBytes(Object.freeze({ scope, brief_id: brief.brief_id,
        design_version_id: design.design_version_id }))); }
      catch { throw new CreativeApiError("unavailable", operation, "artifact_bytes"); }
      let root = design;
      while (root.parent_version_id !== null) {
        root = await loadDesign(scope, brief, root.parent_version_id, operation, { allowHistorical: true });
      }
      const assetUse = inspectionAssetUseSet(design, brief, operation);
      await verifyInspectionAssetRights(scope, brief, assetUse, operation);
      let decoderResult;
      try {
        const decoded = await inspectOpenAIImageBytes(artifactBytes);
        decoderResult = Object.freeze({ contract: "OpenAIBoundedImageDecode", schema_version: "1.0", status: "pass",
          artifact_hash: hashArtifactBytes(artifactBytes), format: decoded.format, width: decoded.width, height: decoded.height,
          has_alpha: decoded.has_alpha, has_transparency: decoded.has_transparency });
      } catch {
        decoderResult = Object.freeze({ contract: "OpenAIBoundedImageDecode", schema_version: "1.0", status: "fail",
          artifact_hash: hashArtifactBytes(artifactBytes), format: ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" })[design.artifact.media_type] ?? "png",
          width: 1, height: 1, has_alpha: false, has_transparency: false });
      }
      const usedAssets = assetUse.status === "verified"
        ? assetUse.entries.map(({ asset_id, action }) => ({ asset_id, action })) : [];
      const deterministic = inspectCreativeArtifact({ trusted_scope: { ...scope, design_version_id: design.design_version_id,
        artifact_id: design.artifact.artifact_id }, brief, design_version: design,
        ...(parent ? { parent_design: parent, parent_design_hash: parent.design_hash } : {}),
        artifact_bytes: artifactBytes, used_assets: usedAssets, asset_use_evidence_status: assetUse.status,
        decoder_result: decoderResult,
        eligible_repair_actions: ports.provider?.edit && ports.metering ? ["image.edit"] : [] });
      // The repair counter is scoped to the immutable root lineage so fresh
      // inspect action IDs and process restarts cannot reset its bounds.
      const inspectionId = `inspection-series:${root.design_version_id}:${root.design_hash.slice(7, 23)}`;
      const repairScope = Object.freeze({ ...scope, brief_id: brief.brief_id, design_version_id: root.design_version_id });
      const repairPort = ports.storage?.inspectionRepair;
      if (!isRecord(repairPort) || typeof repairPort.startInspection !== "function" || typeof repairPort.getState !== "function") {
        throw new CreativeApiError("unavailable", operation, "inspection.repair_state");
      }
      repairPort.startInspection({ scope: repairScope, inspection_id: inspectionId,
        brief_hash: canonicalHash(brief), design_hash: root.design_hash });
      const repairState = repairPort.getState({ scope: repairScope, inspection_id: inspectionId });
      const identity = Object.freeze({ scope: Object.freeze({ ...scope, brief_id: brief.brief_id }), actor_id: principal.actor_id,
        job_id: started.job_id, action_id: request.action_id, request_hash: started.request_hash, lease_token: started.lease_token,
        brief_id: brief.brief_id, brief_hash: canonicalHash(brief), design_version_id: design.design_version_id,
        design_hash: design.design_hash, parent_version_id: design.parent_version_id,
        parent_design_hash: parent?.design_hash ?? null, artifact_id: design.artifact.artifact_id,
        artifact_hash: design.artifact.content_hash, root_design_version_id: root.design_version_id, root_design_hash: root.design_hash });
      const beginSession = requiredPort(ports, "storage.beginInspectionSession", operation);
      const session = await beginSession(identity);
      if (!isRecord(session) || !Array.isArray(session.stages) || session.action_id !== request.action_id ||
        session.request_hash !== started.request_hash || session.design_hash !== design.design_hash) {
        throw new CreativeApiError("unavailable", operation, "inspection.session");
      }
      const priorStage = (name) => session.stages.find((item) => item.stage === name);
      if (session.stages.some((item) => item.status !== "completed")) {
        throw new CreativeApiError("unavailable", operation, "inspection.stage_reconciliation", { retryable: true });
      }
      const stagePort = {
        async begin(stage, attemptId, intent) {
          return requiredPort(ports, "storage.stageInspectionStage", operation)({ ...identity,
            stage, attempt_id: attemptId, intent });
        },
        async complete(stage, attemptId, result) {
          return requiredPort(ports, "storage.completeInspectionStage", operation)({ ...identity,
            stage, attempt_id: attemptId, result });
        },
      };
      const attempts = [];
      const telemetryEvidence = [];
      const subjectHash = canonicalInspectionSubjectHash(deterministic);
      let observation;
      let providerStatus = "not_requested";
      let decision;
      const ownerUsageStages = [];
      let decisionAbstained = false;
      const observerPrior = priorStage("observer");
      if (deterministic.gate === "eligible" && observerPrior?.status === "completed") {
        const stored = observerPrior.result;
        if (!isRecord(stored) || stored.subject_hash !== subjectHash || typeof stored.attempt_id !== "string" ||
          !isRecord(stored.telemetry_evidence) || !["complete", "partial", "unknown"].includes(stored.usage_completeness)) {
          throw new CreativeApiError("unavailable", operation, "inspection.observer_stage");
        }
        if (stored.provider_status === undefined) {
          if (!isRecord(stored.observation)) throw new CreativeApiError("unavailable", operation, "inspection.observer_stage");
          observation = validateVisualObservation(stored.observation, deterministic);
          providerStatus = "complete";
        } else if (["refused", "unavailable", "timeout"].includes(stored.provider_status) &&
          stored.observation === undefined) {
          providerStatus = stored.provider_status;
        } else {
          throw new CreativeApiError("unavailable", operation, "inspection.observer_stage");
        }
        attempts.push(stored.attempt_id);
        telemetryEvidence.push(stored.telemetry_evidence);
        ownerUsageStages.push(stored.usage_completeness);
      } else if (deterministic.gate === "eligible") {
        const resolveRoute = requiredPort(ports, "inspection.resolveRoute", operation);
        const inspect = requiredPort(ports, "inspection.inspect", operation);
        const dimensions = deterministic.dimensions;
        if (!dimensions || !["png", "jpeg", "webp"].includes(dimensions.format)) {
          providerStatus = "unavailable";
        } else {
          const route = routeFor(await resolveRoute(Object.freeze({ scope, actor_id: principal.actor_id,
            design_version: design, artifact: Object.freeze({ artifact_id: design.artifact.artifact_id,
              content_hash: design.artifact.content_hash, media_type: design.artifact.media_type,
              width: dimensions.width, height: dimensions.height, format: dimensions.format }) })), operation);
          await assertCurrentCreativeContext(scope, brief, design, operation);
          const metered = await runMetered(principal, request, started, "vision_observation", route, "inspection.inspect",
            async ({ method, attempt, reservation_ref, signal, deadline_at, transportAttemptId, dispatch_intent_ref,
              recordTransportAttempt, revalidateDispatch }) => {
              const intent = Object.freeze({ subject_hash: subjectHash, artifact_hash: design.artifact.content_hash,
                design_hash: design.design_hash, route_hash: canonicalHash(route), transport_attempt_id: transportAttemptId,
                dispatch_intent_ref, reservation_ref });
              await stagePort.begin("observer", attempt.billable_attempt_id, intent);
              await revalidateDispatch({ transport_attempt_id: transportAttemptId,
                billable_attempt_id: attempt.billable_attempt_id, reservation_ref, dispatch_intent_ref,
                target_binding_sha256: subjectHash, signal });
              const raw = await inspect(Object.freeze({ scope, actor_id: principal.actor_id, job_id: started.job_id,
                attempt, reservation_ref, transport_attempt_id: transportAttemptId, dispatch_intent_ref,
                recordTransportAttempt, revalidateDispatch, signal, deadline_at, route, brief,
                design_version: design, parent_design: parent,
                deterministic, artifact_bytes: copyInspectionArtifactBytes(deterministic), used_assets: Object.freeze(usedAssets) }));
              if (!isRecord(raw) || !["complete", "refused", "unavailable", "timeout", "cancelled"].includes(raw.status)) {
                throw new CreativeApiError("failed", operation, "inspection.observer_result");
              }
              if (raw.status !== "complete") {
                assertOnlyKeys(raw, ["status", "usage"], "inspection.observer_result");
                return { value: raw, usage: raw?.usage, provider_outcome: "failed" };
              }
              assertOnlyKeys(raw, ["status", "observer", "uncertainty", "findings", "usage"], "inspection.observer_result");
              if (!isRecord(raw.observer) || !["human", "model", "system"].includes(raw.observer.type)) {
                throw new CreativeApiError("failed", operation, "inspection.observer");
              }
              assertOnlyKeys(raw.observer, ["type", "id", "model_id", "config_ref"], "inspection.observer");
              const observer = { ...raw.observer };
              if (observer.type === "model") {
                observer.model_id ??= route.provider.model;
                observer.config_ref ??= canonicalHash({ provider: route.provider.name, model: route.provider.model,
                  endpoint: route.provider.endpoint, sdk: route.provider.sdk });
              }
              const rawUsage = normalizeUsage(raw.usage);
              const visualObservation = validateVisualObservation({
                contract: "CreativeVisualObservation", schema_version: "1.0", tenant_id: scope.tenant_id,
                project_id: scope.project_id, brief_id: brief.brief_id, design_version_id: design.design_version_id,
                artifact_id: design.artifact.artifact_id, brief_hash: canonicalHash(brief),
                parent_design_hash: parent?.design_hash ?? null, design_hash: design.design_hash,
                artifact_hash: design.artifact.content_hash, observation_id: boundedString(idFactory(), "inspection.observation_id", 200),
                observed_at: new Date(now()).toISOString(), observer,
                source: { kind: "vision_model", source_ref: canonicalHash({ provider: route.provider.name,
                  model: route.provider.model, config_ref: observer.config_ref ?? null }) },
                uncertainty: raw.uncertainty, findings: raw.findings,
                usage: { completeness: rawUsage.completeness === "complete" ? "complete" : rawUsage.completeness === "incomplete" ? "partial" : "unknown",
                  ...(Number.isSafeInteger(rawUsage.input_tokens) ? { input_tokens: rawUsage.input_tokens } : {}),
                  ...(Number.isSafeInteger(rawUsage.output_tokens) ? { output_tokens: rawUsage.output_tokens } : {}),
                  usage_ref: canonicalHash({ attempt_id: attempt.billable_attempt_id, transport_attempt_id: transportAttemptId,
                    input_tokens: rawUsage.input_tokens ?? null, output_tokens: rawUsage.output_tokens ?? null }) },
              }, deterministic);
              return { value: { observation: visualObservation, raw_usage: raw.usage,
                target_binding_sha256: subjectHash }, usage: raw.usage, provider_outcome: "succeeded" };
            }, async () => {
              await assertCurrentCreativeContext(scope, brief, design, operation);
              return verifyInspectionAssetRights(scope, brief, assetUse, operation);
            }, creativeContextFence(brief, design), { allowTerminalFailure: true });
          if (metered.value?.status === "cancelled") throw new CreativeApiError("cancelled", operation, "inspection.observer_result");
          if (isRecord(metered.value) && ["refused", "unavailable", "timeout"].includes(metered.value.status)) {
            const stageResult = Object.freeze({ subject_hash: subjectHash, provider_status: metered.value.status,
              attempt_id: metered.attempt_id,
              usage_completeness: metered.usage_evidence?.status === "settled_owner_mapping" ? "complete" : "unknown",
              telemetry_evidence: metered.telemetry_evidence });
            await stagePort.complete("observer", metered.attempt_id, stageResult);
            attempts.push(metered.attempt_id);
            telemetryEvidence.push(metered.telemetry_evidence);
            providerStatus = metered.value.status;
            ownerUsageStages.push(stageResult.usage_completeness);
          } else {
            if (!isRecord(metered.value) || !isRecord(metered.value.observation)) {
              throw new CreativeApiError("failed", operation, "inspection.observer_result");
            }
            observation = validateVisualObservation(metered.value.observation, deterministic);
            const stageResult = Object.freeze({ subject_hash: subjectHash, observation, attempt_id: metered.attempt_id,
              usage_completeness: metered.usage_evidence?.status === "settled_owner_mapping" ? "complete" : "unknown",
              telemetry_evidence: metered.telemetry_evidence });
            await stagePort.complete("observer", metered.attempt_id, stageResult);
            attempts.push(metered.attempt_id);
            telemetryEvidence.push(metered.telemetry_evidence);
            providerStatus = "complete";
            ownerUsageStages.push(stageResult.usage_completeness);
          }
        }
      }
      if (observation && deterministic.gate === "eligible" && providerStatus === "complete") {
        const routing = createInspectionRoutingInput({ deterministic, observation });
        if (routing.status === "ready" && typeof ports.decisionPort?.resolveRoute === "function" &&
            typeof ports.decisionPort?.execute === "function") {
          const independentQuestions = Object.fromEntries(Object.entries(routing.questions)
            .filter(([key]) => key !== "next_step"));
          const decisionRoute = routeFor(await ports.decisionPort.resolveRoute(Object.freeze({ scope,
            actor_id: principal.actor_id, decision: Object.freeze({ execution_mode: "independent_batch",
              state: routing.state, questions: Object.freeze(independentQuestions) }) })), operation);
          if (decisionRoute.provider.model !== PINNED_JEV_MODEL_ID) {
            throw new CreativeApiError("unsupported_version", operation, "inspection.decision_model");
          }
          const makeDecisionContext = ({ attempt, reservation_ref, deadline_at, transportAttemptId }) => {
            const timestamp = new Date(now()).toISOString();
            return Object.freeze({ event_id: boundedString(idFactory(), "decision_request.event_id", 200),
              correlation_id: request.correlation_id, producer: "creative-engine.inspection", occurred_at: timestamp,
              ingested_at: timestamp, environment: request.environment, billing_mode: request.billing_mode,
              request_id: boundedString(idFactory(), "decision_request.request_id", 200),
              logical_operation_id: attempt.logical_operation_id, billable_attempt_id: attempt.billable_attempt_id,
              attempt_number: 1, attempt_limit: 1,
              budget_ref: { budget_scope_ref: principal.budget_scope_id, ...(reservation_ref === undefined ? {} : { reservation_ref }),
                policy_version: principal.budget_policy_version }, deadline_at, cancellation_ref: started.job_id,
              model_policy: { model_id: PINNED_JEV_MODEL_ID, policy_version: INSPECTION_POLICY_VERSION },
              job_id: started.job_id, ...(transportAttemptId === undefined ? {} : { transport_attempt_id: transportAttemptId }) });
          };
          const trustedInspectionScope = Object.freeze({ ...scope, brief_id: brief.brief_id,
            design_version_id: design.design_version_id, artifact_id: design.artifact.artifact_id });
          const loadDecisionStage = (name) => {
            const prior = priorStage(name);
            if (!prior) return null;
            if (prior.status !== "completed" || !isRecord(prior.intent) || !isRecord(prior.result)) {
              throw new CreativeApiError("unavailable", operation, "inspection.decision_reconciliation");
            }
            return prior;
          };
          let firstStage = loadDecisionStage("decision_evidence");
          let plan;
          let firstRequest;
          let firstResult;
          let firstTelemetry;
          let firstUsageCompleteness = "unknown";
          if (firstStage) {
            const stored = firstStage.result;
            firstRequest = stored.request;
            firstResult = stored.decision_result;
            firstTelemetry = stored.telemetry_evidence;
            if (!isRecord(firstRequest) || !isRecord(firstResult) ||
              canonicalHash(firstRequest) !== firstStage.intent.request_hash ||
              firstRequest.billable_attempt_id !== firstStage.attempt_id ||
              !["complete", "partial", "unknown"].includes(stored.usage_completeness)) {
              throw new CreativeApiError("unavailable", operation, "inspection.decision_evidence");
            }
            const context = Object.fromEntries(Object.entries(firstRequest).filter(([key]) => [
              "event_id", "correlation_id", "producer", "occurred_at", "ingested_at", "environment", "billing_mode",
              "request_id", "logical_operation_id", "billable_attempt_id", "attempt_number", "attempt_limit", "budget_ref",
              "deadline_at", "cancellation_ref", "model_policy", "workflow_id", "run_id", "order_id", "job_id",
              "transport_attempt_id", "provider_request_id",
            ].includes(key)));
            const preparedStage = firstStage.intent.target_binding_sha256 !== undefined;
            const planned = (preparedStage ? prepareInspectionDecisionPlan : createInspectionDecisionPlan)({ deterministic, observation, decision_context: context });
            if (planned.status !== "ready") throw new CreativeApiError("unavailable", operation, "inspection.question_plan");
            plan = planned;
            const expected = preparedStage ? bindInspectionDecisionReservation(plan, prepareInspectionEvidenceBatch(plan, observation),
              firstRequest.budget_ref.reservation_ref) : createInspectionEvidenceBatch(plan, observation);
            if (canonicalHash(expected) !== canonicalHash(firstRequest) || plan.plan_ref !== firstStage.intent.plan_ref ||
              preparedStage && decisionExecutionTargetHash(firstRequest) !== firstStage.intent.target_binding_sha256) {
              throw new CreativeApiError("unavailable", operation, "inspection.decision_provenance");
            }
            firstResult = validateDecisionResult(firstRequest, firstResult, { trustedScope: { ...trustedInspectionScope,
              job_id: started.job_id } });
            firstUsageCompleteness = stored.usage_completeness;
            ownerUsageStages.push(firstUsageCompleteness);
            attempts.push(firstStage.attempt_id);
            telemetryEvidence.push(firstTelemetry);
          } else {
            let capturedPlan;
            const firstMetered = await runMetered(principal, request, started, "jev_decision", decisionRoute,
              "decisionPort.execute", async ({ method, attempt, reservation_ref, signal, deadline_at,
                transportAttemptId, dispatch_intent_ref, recordTransportAttempt, setDecisionRequest, revalidateDispatch,
                assertDispatchCurrent, prepared_execution }) => {
                const planned = prepared_execution.inspection_plan;
                const decisionRequest = bindInspectionDecisionReservation(planned, prepared_execution.decision_request, reservation_ref);
                const target_binding_sha256 = prepared_execution.target_binding_sha256;
                if (decisionExecutionTargetHash(decisionRequest) !== target_binding_sha256) {
                  throw new CreativeApiError("unavailable", operation, "inspection.execution_target");
                }
                setDecisionRequest(decisionRequest);
                await stagePort.begin("decision_evidence", attempt.billable_attempt_id,
                  Object.freeze({ request: decisionRequest, request_hash: canonicalHash(decisionRequest), plan_ref: planned.plan_ref,
                    subject_hash: subjectHash, target_binding_sha256, stage: "independent_batch" }));
                await revalidateDispatch({ transport_attempt_id: transportAttemptId,
                  billable_attempt_id: attempt.billable_attempt_id, reservation_ref, dispatch_intent_ref,
                  target_binding_sha256, signal });
                const raw = await method(Object.freeze({ scope, actor_id: principal.actor_id, request: decisionRequest,
                  attempt, reservation_ref, transport_attempt_id: transportAttemptId, dispatch_intent_ref,
                  target_binding_sha256, recordTransportAttempt, revalidateDispatch, assertDispatchCurrent, signal, deadline_at }));
                let checked;
                try { checked = validateDecisionResult(decisionRequest, raw, { trustedScope: { ...trustedInspectionScope,
                  job_id: started.job_id } }); }
                catch (error) { throw safeError(error, operation); }
                capturedPlan = planned;
                return { value: { request: decisionRequest, decision_result: checked,
                  target_binding_sha256 }, usage: raw?.usage,
              provider_outcome: checked.status === "complete" || checked.status === "review" ? "succeeded" : "failed" };
              }, async () => {
                await assertCurrentCreativeContext(scope, brief, design, operation);
                return verifyInspectionAssetRights(scope, brief, assetUse, operation);
              }, creativeContextFence(brief, design), { allowTerminalFailure: true,
                prepareAttempt({ attempt, deadline_at }) {
                  const context = makeDecisionContext({ attempt, deadline_at });
                  const planned = prepareInspectionDecisionPlan({ deterministic, observation, decision_context: context });
                  if (planned.status !== "ready") throw new CreativeApiError("unavailable", operation, "inspection.question_plan");
                  const decisionRequest = prepareInspectionEvidenceBatch(planned, observation);
                  return Object.freeze({ inspection_plan: planned, decision_request: decisionRequest,
                    target_binding: decisionExecutionTarget(decisionRequest, { trustedScope: { ...trustedInspectionScope, job_id: started.job_id } }),
                    target_binding_sha256: decisionExecutionTargetHash(decisionRequest, { trustedScope: { ...trustedInspectionScope, job_id: started.job_id } }),
                    deadline_at });
                },
              });
            plan = capturedPlan;
            if (!plan && isRecord(firstMetered.value?.request)) {
              const context = Object.fromEntries(Object.entries(firstMetered.value.request).filter(([key]) => [
                "event_id", "correlation_id", "producer", "occurred_at", "ingested_at", "environment", "billing_mode",
                "request_id", "logical_operation_id", "billable_attempt_id", "attempt_number", "attempt_limit", "budget_ref",
                "deadline_at", "cancellation_ref", "model_policy", "workflow_id", "run_id", "order_id", "job_id",
                "transport_attempt_id", "provider_request_id",
              ].includes(key)));
              plan = prepareInspectionDecisionPlan({ deterministic, observation, decision_context: context });
            }
            if (!plan || plan.status !== "ready") throw new CreativeApiError("unavailable", operation, "inspection.question_plan");
            firstRequest = firstMetered.value.request;
            firstResult = firstMetered.value.decision_result;
            if (firstResult?.status === "cancelled") throw new CreativeApiError("cancelled", operation, "inspection.decision_result");
            firstTelemetry = firstMetered.telemetry_evidence;
            firstUsageCompleteness = firstMetered.usage_evidence?.status === "settled_owner_mapping"
              ? (firstMetered.usage_evidence.completeness ?? "complete") : "unknown";
            await stagePort.complete("decision_evidence", firstMetered.attempt_id, Object.freeze({ request: firstRequest,
              decision_result: firstResult, telemetry_evidence: firstTelemetry,
              usage_completeness: firstUsageCompleteness }));
            attempts.push(firstMetered.attempt_id);
            telemetryEvidence.push(firstTelemetry);
            ownerUsageStages.push(firstUsageCompleteness);
            if (firstResult.status !== "complete") decisionAbstained = true;
          }
          if (firstResult.status !== "complete") decisionAbstained = true;
          if (firstResult.status === "complete") {
            let routeStage = loadDecisionStage("decision_route");
            let routeRequest;
            let routeResult;
            let routeTelemetry;
            let routeUsageCompleteness = "unknown";
            if (routeStage) {
              routeRequest = routeStage.result.request;
              routeResult = routeStage.result.decision_result;
              routeTelemetry = routeStage.result.telemetry_evidence;
              if (!isRecord(routeRequest) || !isRecord(routeResult) || canonicalHash(routeRequest) !== routeStage.intent.request_hash ||
                routeRequest.billable_attempt_id !== routeStage.attempt_id) {
                throw new CreativeApiError("unavailable", operation, "inspection.decision_route");
              }
              const preparedRouteStage = routeStage.intent.target_binding_sha256 !== undefined;
              const reservationRef = routeRequest.budget_ref.reservation_ref;
              routeRequest = (preparedRouteStage ? prepareInspectionRouteBatch : createInspectionRouteBatch)(plan, firstRequest, firstResult, trustedInspectionScope,
                { ...Object.fromEntries(Object.entries(routeRequest).filter(([key]) => [
                  "event_id", "correlation_id", "producer", "occurred_at", "ingested_at", "environment", "billing_mode",
                  "request_id", "logical_operation_id", "billable_attempt_id", "attempt_number", "attempt_limit", "budget_ref",
                  "deadline_at", "cancellation_ref", "model_policy", "workflow_id", "run_id", "order_id", "job_id",
                  "transport_attempt_id", "provider_request_id",
                ].includes(key))), linked_request_id: firstRequest.request_id,
                  linked_billable_attempt_id: firstRequest.billable_attempt_id, plan_ref: plan.plan_ref,
                  inspection_subject_hash: subjectHash });
              if (preparedRouteStage) routeRequest = bindInspectionDecisionReservation(plan, routeRequest, reservationRef);
              if (canonicalHash(routeRequest) !== routeStage.intent.request_hash || preparedRouteStage &&
                decisionExecutionTargetHash(routeRequest) !== routeStage.intent.target_binding_sha256) {
                throw new CreativeApiError("unavailable", operation, "inspection.decision_provenance");
              }
              routeResult = validateDecisionResult(routeRequest, routeResult, { trustedScope: { ...trustedInspectionScope,
                job_id: started.job_id } });
              if (!["complete", "partial", "unknown"].includes(routeStage.result.usage_completeness)) {
                throw new CreativeApiError("unavailable", operation, "inspection.decision_route");
              }
              routeUsageCompleteness = routeStage.result.usage_completeness;
              ownerUsageStages.push(routeUsageCompleteness);
              attempts.push(routeStage.attempt_id);
              telemetryEvidence.push(routeTelemetry);
            } else {
              const routeShape = Object.freeze({ execution_mode: "independent_batch",
                state: Object.freeze({ text: "A validated first-stage inspection result is required before route selection." }),
                questions: Object.freeze({ next_step: Object.freeze(Object.fromEntries(Object.entries(plan.questions.next_step)
                  .filter(([key]) => key !== "depends_on"))) }) });
              const routeConfig = routeFor(await ports.decisionPort.resolveRoute(Object.freeze({ scope,
                actor_id: principal.actor_id, decision: routeShape })), operation);
              if (routeConfig.provider.model !== PINNED_JEV_MODEL_ID) {
                throw new CreativeApiError("unsupported_version", operation, "inspection.decision_model");
              }
              let builtRouteRequest;
              const routeMetered = await runMetered(principal, request, started, "jev_decision", routeConfig,
                "decisionPort.execute", async ({ method, attempt, reservation_ref, signal, deadline_at,
                  transportAttemptId, dispatch_intent_ref, recordTransportAttempt, setDecisionRequest, revalidateDispatch,
                  assertDispatchCurrent, prepared_execution }) => {
                  builtRouteRequest = bindInspectionDecisionReservation(plan, prepared_execution.decision_request, reservation_ref);
                  const target_binding_sha256 = prepared_execution.target_binding_sha256;
                  if (decisionExecutionTargetHash(builtRouteRequest) !== target_binding_sha256) {
                    throw new CreativeApiError("unavailable", operation, "inspection.execution_target");
                  }
                  setDecisionRequest(builtRouteRequest);
                  await stagePort.begin("decision_route", attempt.billable_attempt_id,
                    Object.freeze({ request: builtRouteRequest, request_hash: canonicalHash(builtRouteRequest),
                      plan_ref: plan.plan_ref, subject_hash: subjectHash, first_request_ref: canonicalHash(firstRequest),
                      first_result_ref: canonicalHash(firstResult), target_binding_sha256, stage: "dependent_route" }));
                  await revalidateDispatch({ transport_attempt_id: transportAttemptId,
                    billable_attempt_id: attempt.billable_attempt_id, reservation_ref, dispatch_intent_ref,
                    target_binding_sha256, signal });
                  const raw = await method(Object.freeze({ scope, actor_id: principal.actor_id, request: builtRouteRequest,
                    attempt, reservation_ref, transport_attempt_id: transportAttemptId, dispatch_intent_ref,
                    target_binding_sha256, recordTransportAttempt, revalidateDispatch, assertDispatchCurrent, signal, deadline_at }));
                  let checked;
                  try { checked = validateDecisionResult(builtRouteRequest, raw, { trustedScope: { ...trustedInspectionScope,
                    job_id: started.job_id } }); }
                  catch (error) { throw safeError(error, operation); }
                  return { value: { request: builtRouteRequest, decision_result: checked,
                    target_binding_sha256 }, usage: raw?.usage,
                  provider_outcome: checked.status === "complete" || checked.status === "review" ? "succeeded" : "failed" };
                }, async () => {
                  await assertCurrentCreativeContext(scope, brief, design, operation);
                  return verifyInspectionAssetRights(scope, brief, assetUse, operation);
                }, creativeContextFence(brief, design), { allowTerminalFailure: true,
                  prepareAttempt({ attempt, deadline_at }) {
                    const context = makeDecisionContext({ attempt, deadline_at });
                    const requestContext = { ...context, linked_request_id: firstRequest.request_id,
                      linked_billable_attempt_id: firstRequest.billable_attempt_id, plan_ref: plan.plan_ref,
                      inspection_subject_hash: subjectHash };
                    const preparedRequest = prepareInspectionRouteBatch(plan, firstRequest, firstResult, trustedInspectionScope, requestContext);
                    if (preparedRequest.contract !== "DecisionPortRequest") throw new CreativeApiError("review_required", operation, "inspection.decision_route");
                    return Object.freeze({ decision_request: preparedRequest,
                      target_binding: decisionExecutionTarget(preparedRequest, { trustedScope: { ...trustedInspectionScope, job_id: started.job_id } }),
                      target_binding_sha256: decisionExecutionTargetHash(preparedRequest, { trustedScope: { ...trustedInspectionScope, job_id: started.job_id } }),
                      deadline_at });
                  },
                });
              routeRequest = routeMetered.value.request;
              routeResult = routeMetered.value.decision_result;
              if (routeResult?.status === "cancelled") throw new CreativeApiError("cancelled", operation, "inspection.decision_result");
              routeTelemetry = routeMetered.telemetry_evidence;
              routeUsageCompleteness = routeMetered.usage_evidence?.status === "settled_owner_mapping"
                ? (routeMetered.usage_evidence.completeness ?? "complete") : "unknown";
              await stagePort.complete("decision_route", routeMetered.attempt_id, Object.freeze({ request: routeRequest,
                decision_result: routeResult, telemetry_evidence: routeTelemetry,
                usage_completeness: routeUsageCompleteness }));
              attempts.push(routeMetered.attempt_id);
              telemetryEvidence.push(routeTelemetry);
              ownerUsageStages.push(routeUsageCompleteness);
            }
            decision = evaluateInspectionDecision(plan, firstRequest, firstResult, routeRequest, routeResult, trustedInspectionScope);
            if (routeResult.status !== "complete") decisionAbstained = true;
          }
        }
      }
      await assertCurrentCreativeContext(scope, brief, design, operation);
      const finalRightsProofs = await verifyInspectionAssetRights(scope, brief, assetUse, operation);
      const state = repairPort.getState({ scope: repairScope, inspection_id: inspectionId }) ?? repairState;
      const usageCompleteness = aggregateUsageCompleteness(ownerUsageStages);
      const report = createInspectionReport({ deterministic, provider_status: providerStatus, decision,
        observations: observation ? [observation] : [], policy_version: INSPECTION_POLICY_VERSION,
        evidence_mode: "fixture", subject_hash: subjectHash,
        question_schema_version: decision ? INSPECTION_QUESTION_SCHEMA_VERSION : null,
        model_id: decision ? PINNED_JEV_MODEL_ID : null,
        decision_policy_version: decision ? INSPECTION_POLICY_VERSION : null,
        uncertainty: usageUncertainty(usageCompleteness, decisionAbstained ? ["question_abstained"] : []),
        limits: { remaining_repairs: state?.remaining_repairs ?? 2, remaining_elapsed_ms: state?.remaining_elapsed_ms ?? 60_000,
          remaining_simulated_units: state?.remaining_simulated_units ?? 3, usage_completeness: usageCompleteness } });
      const output = Object.freeze({ report, inspection_id: inspectionId, attempt_ids: Object.freeze(attempts),
        telemetry_evidence: Object.freeze(telemetryEvidence) });
      const job = await publish(principal, request, started, output, async (transaction) => {
        await requiredPort(ports, "storage.completeInspectionSession", operation)({ ...identity, result: output }, transaction);
      }, { brief_id: brief.brief_id, brief_hash: canonicalHash(brief),
        design_version_id: design.design_version_id, design_hash: design.design_hash,
        expected_current_design_version_id: design.design_version_id, expected_current_design_hash: design.design_hash,
        inspection_rights: Object.freeze({ proofs: Object.freeze([...finalRightsProofs]) }) });
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id), result: output }), operation);
    }
    if (operation === "generate" || operation === "edit") {
      let repairAuthorization = null;
      const brief = await loadBrief(scope, payload.brief_id, operation);
      if (typeof ports.storage?.isBriefUsable === "function" &&
        !(await ports.storage.isBriefUsable(Object.freeze({ scope, brief_id: brief.brief_id, brief_hash: canonicalHash(brief) })))) {
        throw new CreativeApiError("stale_version", operation, "brief_invalidation");
      }
      const baseDesign = operation === "edit"
        ? await loadDesign(scope, brief, payload.design_version_id, operation)
        : null;
      const branchMode = operation === "edit" && payload.selection_mode === "branch";
      let expectedSelection = Object.freeze({ design_version_id: null, design_hash: null });
      if (operation === "edit") {
        const getCurrent = requiredPort(ports, "storage.getCurrentDesignVersion", operation);
        const current = await getCurrent(Object.freeze({ scope, brief_id: brief.brief_id }));
        if (!branchMode && (!current || current.design_version_id !== baseDesign.design_version_id)) {
          throw new CreativeApiError("stale_version", operation, "design_version_id");
        }
        if (current) {
          assertScopedRecord(current, scope, operation, brief.brief_id);
          validateDesignVersion(current, { trustedScope: { ...scope, design_version_id: current.design_version_id }, brief_hash: canonicalHash(brief),
            known_source_refs: brief.source_identity.map((source) => source.source_id) });
          if (!branchMode && current.design_hash !== baseDesign.design_hash) throw new CreativeApiError("stale_version", operation, "design_hash");
        }
      } else {
        const getCurrent = requiredPort(ports, "storage.getCurrentDesignVersion", operation);
        const current = await getCurrent(Object.freeze({ scope, brief_id: brief.brief_id }));
        if (current !== null) {
          assertScopedRecord(current, scope, operation, brief.brief_id);
          const selected = await loadDesign(scope, brief, current.design_version_id, operation, { allowHistorical: true });
          if (selected.brief_hash === canonicalHash(brief)) throw new CreativeApiError("stale_version", operation, "brief_id");
          expectedSelection = Object.freeze({ design_version_id: selected.design_version_id, design_hash: selected.design_hash });
        }
      }
      if (operation === "edit" && payload.inspection_repair !== undefined) {
        repairAuthorization = await validateInspectionRepairSource(principal, request, started, brief, baseDesign);
      }
      if (repairAuthorization) assertRepairAuthorizationCurrent(repairAuthorization, operation);
      const output = await runImageOperation(principal, request, started, brief, baseDesign, expectedSelection,
        repairAuthorization);
      let publicationPermissionProofs = output.permission_fence;
      let repairEvidence;
      let repairResultHash;
      if (repairAuthorization) {
        repairResultHash = canonicalHash({ design_hash: output.design.design_hash,
          billable_attempt_id: output.design.billable_attempt_id, telemetry_evidence: output.telemetry_evidence });
        repairEvidence = Object.freeze({ contract: "CreativeInspectionRepairExecution", schema_version: "1.0",
          inspection_id: repairAuthorization.inspection_id, inspection_action_id: repairAuthorization.inspection_action_id,
          source_report_hash: repairAuthorization.source_report_hash, repair_action: "image.edit",
          claim_ref: repairAuthorization.claim_ref, root_design_version_id: repairAuthorization.root_design_version_id,
          root_design_hash: repairAuthorization.root_design_hash, output_design_version_id: output.design.design_version_id,
          output_design_hash: output.design.design_hash, billable_attempt_id: output.design.billable_attempt_id });
      }
      const { artifact_bytes: _artifactBytes, creation_evidence: creationEvidence,
        permission_fence: _permissionFence, refresh_permission_fence: refreshPermissionFence, ...outputRecord } = output;
      const publishedOutput = Object.freeze({ ...outputRecord, ...(repairEvidence ? { inspection_repair: repairEvidence } : {}) });
      const selectionMode = operation === "edit" && payload.selection_mode === "branch" ? "branch" : "advance";
      const creation = Object.freeze({
        job_id: started.job_id,
        action_id: request.action_id,
        actor_id: principal.actor_id,
        request_hash: started.request_hash,
        logical_operation_id: request.action_id,
        billable_attempt_id: output.design.billable_attempt_id,
        ...(baseDesign ? { parent_design_hash: baseDesign.design_hash } : {}),
        transport_attempt_ids: Object.freeze([...(creationEvidence?.transport_attempt_ids ?? [])]),
        provider_request_ids: Object.freeze([...(creationEvidence?.provider_request_ids ?? [])]),
        usage_refs: Object.freeze([...(creationEvidence?.usage_refs ?? [])]),
        trace_refs: Object.freeze([...(creationEvidence?.evidence_refs ?? [])]),
      });
      const saveInput = Object.freeze({ scope, brief_id: brief.brief_id,
        design_version: output.design,
        artifact_bytes: Uint8Array.from(output.artifact_bytes),
        selection_mode: selectionMode,
        creation,
        lease_token: started.lease_token,
        job_result: publishedOutput,
        expected_brief_hash: canonicalHash(brief),
        expected_current_design_version_id: selectionMode === "advance"
          ? (operation === "generate" ? expectedSelection.design_version_id : (baseDesign?.design_version_id ?? null)) : null,
        expected_current_design_hash: selectionMode === "advance"
          ? (operation === "generate" ? expectedSelection.design_hash : (baseDesign?.design_hash ?? null)) : null,
        expected_parent_design_version_id: baseDesign?.design_version_id ?? null,
        expected_parent_design_hash: baseDesign?.design_hash ?? null });
      const prepare = ports.storage?.prepareDesignVersion;
      const commitPrepared = ports.storage?.commitPreparedDesignVersion;
      if ((typeof prepare === "function") !== (typeof commitPrepared === "function")) {
        throw new CreativeApiError("unavailable", operation, "storage.version_transaction");
      }
      if (typeof prepare === "function") {
        const recordAttemptEvidence = requiredPort(ports, "jobs.recordAttemptEvidence", operation);
        const evidenceRecord = await recordAttemptEvidence(Object.freeze({
          scope,
          actor_id: principal.actor_id,
          job_id: started.job_id,
          lease_token: started.lease_token,
          action_id: request.action_id,
          request_hash: started.request_hash,
          creation,
        }));
        if (!isRecord(evidenceRecord) || !["recorded", "replayed"].includes(evidenceRecord.status)) {
          throw new CreativeApiError("unavailable", operation, "attempt_evidence");
        }
        publicationPermissionProofs = await refreshPermissionFence();
        if (repairAuthorization) assertRepairAuthorizationCurrent(repairAuthorization, operation);
      }
      const makePublicationFence = (proofs) => creativeContextFence(brief, baseDesign, branchMode ? undefined
        : (operation === "generate" ? expectedSelection.design_version_id : (baseDesign?.design_version_id ?? null)),
      branchMode ? undefined
        : (operation === "generate" ? expectedSelection.design_hash : (baseDesign?.design_hash ?? null)), {
        inspection_rights: Object.freeze({ proofs: Object.freeze([...proofs]) }),
        ...(repairAuthorization ? { inspection_repair: Object.freeze({ ...repairAuthorization.proof,
          result_hash: repairResultHash }) } : {}),
      });
      const prepareInput = typeof prepare === "function"
        ? Object.freeze({ ...saveInput, publication_fence: makePublicationFence(publicationPermissionProofs) })
        : saveInput;
      const prepared = typeof prepare === "function" ? await prepare(prepareInput) : null;
      if (prepared !== null && (!isRecord(prepared) || prepared.status !== "prepared" ||
        prepared.action_id !== request.action_id || prepared.job_id !== started.job_id || typeof prepared.payload_hash !== "string")) {
        throw new CreativeApiError("unavailable", operation, "storage.version_intent");
      }
      if (typeof prepare === "function") {
        publicationPermissionProofs = await refreshPermissionFence();
        if (repairAuthorization) assertRepairAuthorizationCurrent(repairAuthorization, operation);
      }
      const publicationFence = makePublicationFence(publicationPermissionProofs);
      const job = await publish(principal, request, started, publishedOutput, async (transaction) => {
        if (repairAuthorization) {
          let outcome;
          try { outcome = ports.storage.inspectionRepair.recordRepairOutcomeInPublication({
            scope: repairAuthorization.repairScope, inspection_id: repairAuthorization.inspection_id,
            action_id: request.action_id, result_hash: repairResultHash, proof: repairAuthorization.proof }); }
          catch { throw new CreativeApiError("unavailable", operation, "inspection_repair.outcome"); }
          if (!isRecord(outcome) || outcome.status !== "recorded" || outcome.result_hash !== repairResultHash) {
            throw new CreativeApiError("stale_version", operation, "inspection_repair.outcome");
          }
        }
        const saved = prepared
          ? await commitPrepared(Object.freeze({ scope, brief_id: brief.brief_id, action_id: prepared.action_id,
            job_id: prepared.job_id, payload_hash: prepared.payload_hash }), transaction)
          : await requiredPort(ports, "storage.saveDesignVersion", operation)(saveInput, transaction);
        if (!isRecord(saved) || saved.status !== "saved") throw new CreativeApiError("stale_version", operation);
      }, publicationFence);
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id), result: Object.freeze({
          design_version: output.design, usage: output.usage, telemetry_evidence: output.telemetry_evidence,
          ...(repairEvidence ? { inspection_repair: repairEvidence } : {}),
        }) }), operation);
    }
    if (operation === "restore") {
      const brief = await loadBrief(scope, payload.brief_id, operation);
      const target = await loadDesign(scope, brief, payload.target_design_version_id, operation);
      const getSelection = requiredPort(ports, "storage.getSelection", operation);
      const selection = await getSelection(Object.freeze({ scope, brief_id: brief.brief_id }));
      if (!selection) throw new CreativeApiError("not_found", operation, "selection");
      assertScopedRecord(selection, scope, operation, brief.brief_id);
      if (!Number.isSafeInteger(selection.revision) || selection.revision < 0 ||
        selection.revision !== payload.expected_selection_revision) throw new CreativeApiError("stale_version", operation, "expected_selection_revision");
      const selectedDesign = await loadDesign(scope, brief, boundedString(selection.design_version_id, "selection.design_version_id"), operation);
      const selected = await publish(principal, request, started, { selection: {
        tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: brief.brief_id,
        design_version_id: target.design_version_id, design_hash: target.design_hash, revision: selection.revision + 1,
      } }, async (transaction) => {
        const select = requiredPort(ports, "storage.selectDesignVersion", operation);
        const selectedResult = await select(Object.freeze({ scope, brief_id: brief.brief_id,
          design_version_id: target.design_version_id, expected_brief_hash: canonicalHash(brief),
          expected_target_design_hash: target.design_hash,
          expected_selected_design_version_id: selectedDesign.design_version_id,
          expected_selected_design_hash: selectedDesign.design_hash,
          expected_selection_revision: selection.revision }), transaction);
        if (!isRecord(selectedResult) || selectedResult.status !== "selected") throw new CreativeApiError("stale_version", operation);
        assertScopedRecord(selectedResult.selection, scope, operation, brief.brief_id);
        if (selectedResult.selection.design_version_id !== target.design_version_id ||
          selectedResult.selection.design_hash !== target.design_hash ||
          selectedResult.selection.revision !== selection.revision + 1) throw new CreativeApiError("failed", operation, "selection");
      }, Object.freeze({ ...creativeContextFence(brief, target),
        expected_current_design_version_id: selectedDesign.design_version_id,
        expected_current_design_hash: selectedDesign.design_hash }));
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: selected.job_id, job: publicJob(selected, selected.job_id),
        result: Object.freeze({ selection: { tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: brief.brief_id,
          design_version_id: target.design_version_id, design_hash: target.design_hash, revision: selection.revision + 1 } }) }), operation);
    }
    if (operation === "handoff") {
      const briefId = boundedString(payload.brief_id, "brief_id");
      const handoffScope = scopeFor(principal, briefId);
      const brief = await loadBrief(handoffScope, briefId, operation);
      const design = await loadDesign(handoffScope, brief, payload.design_version_id, operation);
      const getContext = requiredPort(ports, "storage.getHandoffContext", operation);
      const resolveDestination = requiredPort(ports, "handoff.resolveDestination", operation);
      const submit = requiredPort(ports, "handoff.submit", operation);
      const approvalVerifier = ports.approval;
      requiredPort(ports, "approval.verifyApproval", operation);
      const asHex = (value, field) => {
        if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return value;
        if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)) return value.slice(7);
        throw new CreativeApiError("failed", operation, field);
      };
      const readContext = async () => {
        const raw = await getContext(Object.freeze({ scope: handoffScope, brief_id: brief.brief_id,
          design_version_id: design.design_version_id }));
        if (!isRecord(raw) || !isRecord(raw.binding) || !isRecord(raw.artifact) || !Array.isArray(raw.layer_manifest)) {
          throw new CreativeApiError("unavailable", operation, "handoff_context");
        }
        const proposedBinding = { ...raw.binding, action_id: request.action_id, actor_id: principal.actor_id };
        const binding = validateApprovalBinding(proposedBinding, handoffScope);
        if (binding.brief.brief_id !== brief.brief_id || binding.brief.sha256 !== asHex(canonicalHash(brief), "binding.brief.sha256") ||
          binding.design_version.design_version_id !== design.design_version_id ||
          binding.design_version.artwork_sha256 !== asHex(design.artifact.content_hash, "binding.design_version.artwork_sha256") ||
          binding.facts.sha256 !== asHex(canonicalHash(brief.facts), "binding.facts.sha256")) {
          throw new CreativeApiError("stale_version", operation, "handoff_binding");
        }
        for (const asset of binding.assets) {
          const permission = brief.permissions.items.find((item) => item.asset_id === asset.asset_id &&
            item.action === asset.intended_use && item.status === "granted" && item.evidence_refs.includes(asset.permission_ref));
          if (!permission) throw new CreativeApiError("permission_denied", operation, "binding.assets");
        }
        if (raw.artifact.sha256 !== binding.design_version.artwork_sha256 ||
          raw.artifact.mime_type !== design.artifact.media_type) throw new CreativeApiError("stale_version", operation, "artifact");
        hashCompositionLayerManifest({ binding, artifact: raw.artifact, layer_manifest: raw.layer_manifest, trustedScope: handoffScope });
        return { binding, artifact: structuredClone(raw.artifact), layer_manifest: structuredClone(raw.layer_manifest) };
      };
      const initialContext = await readContext();
      const destination = await resolveDestination(Object.freeze({ scope: handoffScope, actor_id: principal.actor_id,
        destination_ref: boundedString(payload.destination_ref, "destination_ref") }));
      if (!isRecord(destination) || typeof destination.expected_audience !== "string") throw new CreativeApiError("unavailable", operation, "destination");
      const handoff = projectPublicIdentifiers(await createArtworkHandoff({
        approvalVerifier,
        approval_reference: boundedString(payload.approval_ref, "approval_ref"),
        expected_audience: boundedString(destination.expected_audience, "destination.expected_audience", 200),
        binding: initialContext.binding,
        artifact: initialContext.artifact,
        layer_manifest: initialContext.layer_manifest,
        handoff_id: boundedString(idFactory(), "handoff_id", 256),
        trustedScope: handoffScope,
        trace_refs: [started.job_id],
        usage_refs: [],
        now: new Date(now()),
      }), operation, "handoff");
      const handoffCreatedAt = new Date(now()).toISOString();
      const afterBuild = await readContext();
      if (canonicalSerialize(afterBuild) !== canonicalSerialize(initialContext)) throw new CreativeApiError("stale_version", operation, "handoff_context");
      const beforeSubmit = await readContext();
      if (canonicalSerialize(beforeSubmit) !== canonicalSerialize(initialContext)) throw new CreativeApiError("stale_version", operation, "handoff_context");
      const transportAttemptId = boundedString(idFactory(), "transport_attempt_id", 256);
      const dispatchIntentRef = await authorizeJobDispatch(principal, request, started, transportAttemptId, undefined,
        undefined, creativeContextFence(brief, design));
      const result = { handoff, receipt: null, handoff_created_at: handoffCreatedAt };
      const job = await publish(principal, request, started, result, async () => {
        const assertHandoffContextCurrent = async () => {
          const currentBrief = await loadBrief(handoffScope, briefId, operation);
          const currentDesign = await loadDesign(handoffScope, currentBrief, design.design_version_id, operation);
          const currentContext = await readContext();
          if (canonicalHash(currentBrief) !== canonicalHash(brief) || currentDesign.design_hash !== design.design_hash ||
            canonicalSerialize(currentContext) !== canonicalSerialize(initialContext)) {
            throw new CreativeApiError("stale_version", operation, "handoff_binding");
          }
        };
        await assertHandoffContextCurrent();
        try {
          await verifyHandoffApproval({ approvalVerifier, handoff, expected_audience: destination.expected_audience,
            trustedScope: handoffScope, now: new Date(now()) });
        } catch (error) { throw safeError(error, operation); }
        // Approval verification is asynchronous, so re-read every authoritative
        // component it binds before handing the request to the consumer. The
        // consumer must atomically consume the same approval and binding.
        await assertHandoffContextCurrent();
        const receipt = await submit(Object.freeze({ scope: handoffScope, actor_id: principal.actor_id,
          job_id: started.job_id, destination_ref: payload.destination_ref, handoff,
          transport_attempt_id: transportAttemptId, dispatch_intent_ref: dispatchIntentRef }));
        assertPublicIdentifiers(receipt, operation, "receipt");
        const receiptNow = new Date(now());
        const consumedAt = validatedReceiptTime(receipt, receiptNow, operation);
        assertReceiptWindow(receipt, handoff, handoffCreatedAt, receiptNow, operation);
        // A consumer may return a valid receipt after the approval expires.
        // The receipt is accepted only if its trusted consumption timestamp is
        // within the original approval window and no later than trusted now.
        result.receipt = validateConsumptionReceipt(receipt, handoff, { trustedScope: handoffScope, now: consumedAt });
      }, creativeContextFence(brief, design));
      assertScopedRecord(job, handoffScope, operation);
      return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
        operation_id: job.job_id, job: publicJob(job, job.job_id),
        result: Object.freeze({ handoff: result.handoff, receipt: result.receipt }) }), operation);
    }
    throw new CreativeApiError("invalid_request", operation);
  }

  async function validateReplay(principal, request, started) {
    const job = started.job;
    assertScopedRecord(job, started.scope, request.operation, request.payload.brief_id);
    if (job.job_id !== started.job.job_id || job.actor_id !== principal.actor_id || job.action_id !== request.action_id ||
      job.operation !== request.operation || job.request_hash !== started.request_hash || !isRecord(job.result)) {
      throw new CreativeApiError("unavailable", request.operation, "stored_result");
    }
    if (request.operation === "concepts.create") {
      assertStoredOnlyKeys(job.result, ["candidate_batch"], request.operation, "stored_result");
      const saved = job.result.candidate_batch;
      if (!isRecord(saved) || saved.contract !== "CreativeConceptBatchResult" || saved.schema_version !== "1.1" ||
          !["completed", "partial", "unknown_hold", "running", "cancelled"].includes(saved.status) ||
          !Array.isArray(saved.progress) || saved.progress.length < 1 || saved.progress.length > 2 ||
          !Array.isArray(saved.candidates) || saved.candidates.length > 2) {
        throw new CreativeApiError("unavailable", request.operation, "stored_result.concept_batch");
      }
      const requestSnapshot = Object.freeze({ action_id: request.action_id, brief_id: request.payload.brief_id,
        plan_id: request.payload.plan_id, requested_count: request.payload.requested_count,
        references: Object.freeze(request.payload.references.map((reference) => Object.freeze({
          asset_id: reference.asset_id, role_ref: reference.role_ref,
        }))) });
      const durable = await requiredPort(ports, "storage.getConceptBatch", request.operation)(Object.freeze({
        scope: started.scope, action_id: request.action_id }));
      if (!isRecord(durable) || durable.job_id !== job.job_id || durable.actor_id !== principal.actor_id ||
          durable.request_hash !== started.request_hash || durable.status !== saved.status ||
          durable.batch.batch_id !== saved.batch_id || durable.batch.requested_count !== saved.requested_count ||
          canonicalSerialize(durable.batch.slots.map((slot) => ({ concept_id: slot.concept_id, ordinal: slot.ordinal,
            status: slot.status, attempts: slot.attempts.length, billable_attempt_id: slot.current_billable_attempt_id }))) !==
            canonicalSerialize(saved.progress)) {
        throw new CreativeApiError("unavailable", request.operation, "stored_result.concept_batch_identity");
      }
      try { replayCreativeConceptBatch(durable.batch, { trusted_scope: started.scope, request: requestSnapshot }); }
      catch { throw new CreativeApiError("unavailable", request.operation, "stored_result.concept_batch_request"); }
      const versions = await requiredPort(ports, "storage.getConceptVersions", request.operation)(Object.freeze({
        scope: started.scope, action_id: request.action_id }));
      if (versions.length !== saved.candidates.length) {
        throw new CreativeApiError("unavailable", request.operation, "stored_result.concept_versions");
      }
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      for (let index = 0; index < saved.candidates.length; index += 1) {
        const candidate = saved.candidates[index];
        const version = versions[index];
        if (!isRecord(candidate) || candidate.concept_id !== version.concept_id || candidate.ordinal !== version.ordinal ||
            canonicalSerialize(candidate.design_version) !== canonicalSerialize(version.design_version) ||
            canonicalSerialize(candidate.creative_concept_lineage) !== canonicalSerialize(version.creative_concept_lineage) ||
            candidate.storage_commit_ref !== version.storage_commit_ref ||
            candidate.lineage_evidence_ref !== version.lineage_evidence_ref || version.design_version.parent_version_id !== null ||
            version.design_version.brief_id !== request.payload.brief_id ||
            version.design_version.design_hash !== candidate.design_version.design_hash) {
          throw new CreativeApiError("unavailable", request.operation, "stored_result.concept_version_identity");
        }
        const publicVersion = await loadDesign(started.scope, brief, version.design_version.design_version_id,
          request.operation, { allowHistorical: true });
        if (canonicalSerialize(publicVersion) !== canonicalSerialize(version.design_version)) {
          throw new CreativeApiError("unavailable", request.operation, "stored_result.concept_public_version");
        }
      }
      return saved;
    }
    if (["composition.create", "composition.update", "composition.revalidate"].includes(request.operation)) {
      assertStoredOnlyKeys(job.result, request.operation === "composition.revalidate"
        ? ["contract", "schema_version", "status", "composition", "revision_sha256", "selection_revision", "preview_access"]
        : ["status", "composition", "revision_sha256", "selection_revision", "preview_access"],
      request.operation, "stored_result.composition");
      const getAction = requiredPort(ports, "storage.getCompositionAction", request.operation);
      const action = await getAction(Object.freeze({ scope: started.scope, action_id: request.action_id }));
      if (!isRecord(action) || action.status !== "published" || action.action_id !== request.action_id ||
          action.job_id !== job.job_id || action.actor_id !== principal.actor_id ||
          action.request_hash !== started.request_hash || action.operation !== request.operation ||
          action.intent?.schema_version !== (request.operation === "composition.revalidate" ? "1.1" : "1.0") ||
          !isRecord(action.intent) || !isRecord(action.revision) || !(action.preview_bytes instanceof Uint8Array)) {
        throw new CreativeApiError("unavailable", request.operation, "stored_result.composition_action");
      }
      let revision;
      let envelope;
      try {
        revision = validateCompositionRevision(action.revision, { trustedScope: started.scope,
          previewBytes: action.preview_bytes, allowExpired: true });
        envelope = validateCompositionProductionEnvelope(job.result.composition, { trustedScope: started.scope,
          previewBytes: action.preview_bytes });
      } catch { throw new CreativeApiError("unavailable", request.operation, "stored_result.composition_revision"); }
      let decodedPreview;
      try { decodedPreview = await inspectOpenAIImageBytes(action.preview_bytes); }
      catch (error) {
        if (error instanceof OpenAIImagesProviderError && error.code === "image_decoder_unavailable") {
          throw new CreativeApiError("unavailable", request.operation, "stored_result.preview.decoder", { retryable: true });
        }
        throw new CreativeApiError("failed", request.operation, "stored_result.preview.decode");
      }
      const decodedPreviewMime = IMAGE_MIME_BY_FORMAT[decodedPreview.format];
      if (!decodedPreviewMime || revision.preview.mime_type !== decodedPreviewMime ||
          revision.preview.width_px !== decodedPreview.width || revision.preview.height_px !== decodedPreview.height ||
          revision.preview.byte_length !== action.preview_bytes.byteLength ||
          revision.preview.preview_sha256 !== hashArtifactBytes(action.preview_bytes)) {
        throw new CreativeApiError("failed", request.operation, "stored_result.preview.metadata");
      }
      const expectedParent = request.operation === "composition.create" ? null : action.expected_current;
      let expectedPlan = null;
      if (request.operation === "composition.update") {
        try { expectedPlan = snapshotCompositionJson(request.payload.plan); }
        catch { throw new CreativeApiError("unavailable", request.operation, "stored_result.request_plan"); }
      }
      if (canonicalSerialize(revision) !== canonicalSerialize(action.revision) ||
          canonicalSerialize(envelope) !== canonicalSerialize(createCompositionProductionEnvelope(revision)) ||
          revision.revision_sha256 !== action.revision.revision_sha256 ||
          revision.revision_sha256 !== job.result.revision_sha256 ||
          canonicalSerialize(action.result) !== canonicalSerialize({ status: "published",
            revision_id: revision.revision_id, revision_sha256: revision.revision_sha256 }) ||
          request.operation === "composition.revalidate" &&
            (job.result.contract !== "CreativeCompositionRevalidationResult" || job.result.schema_version !== "1.0") ||
          revision.dependencies.selection_revision !== job.result.selection_revision ||
          job.result.status !== "saved" || revision.composition_id !== action.intent.composition_id ||
          revision.revision_id !== action.intent.candidate_revision_id ||
          revision.parent_revision_id !== (expectedParent?.revision_id ?? null) ||
          revision.parent_revision_sha256 !== (expectedParent?.revision_sha256 ?? null) ||
          request.operation === "composition.update" && canonicalSerialize(action.intent.plan) !== canonicalSerialize(expectedPlan) ||
          request.operation !== "composition.update" && action.intent.plan !== null ||
          request.operation === "composition.revalidate" &&
            (action.expected_current?.revision_id !== request.payload.expected_current_revision_id ||
             action.expected_current?.revision_sha256 !== request.payload.expected_current_revision_sha256 ||
             revision.revision_id !== request.payload.candidate_revision_id)) {
        throw new CreativeApiError("unavailable", request.operation, "stored_result.composition_identity");
      }
      const expectedAccess = compositionPreviewAccess(revision, action.preview_bytes);
      if (canonicalSerialize(job.result.preview_access) !== canonicalSerialize(expectedAccess)) {
        throw new CreativeApiError("unavailable", request.operation, "stored_result.preview_access");
      }
      return job.result;
    }
    if (["generate", "edit"].includes(request.operation)) {
      assertStoredOnlyKeys(job.result, ["design", "usage", "usage_evidence", "attempt_id", "telemetry_evidence",
        "inspection_repair"], request.operation, "stored_result");
      const currentBrief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const storedDesignInput = job.result.design;
      if (!isRecord(storedDesignInput) || storedDesignInput.brief_id !== currentBrief.brief_id ||
        typeof storedDesignInput.brief_hash !== "string") {
        throw new CreativeApiError("unavailable", request.operation, "stored_result");
      }
      let brief = currentBrief;
      if (storedDesignInput.brief_hash !== canonicalHash(currentBrief)) {
        const getBriefVersion = requiredPort(ports, "storage.getBriefVersionByHash", request.operation);
        const historical = await getBriefVersion(Object.freeze({ scope: started.scope,
          brief_id: currentBrief.brief_id, brief_hash: storedDesignInput.brief_hash }));
        if (!historical) throw new CreativeApiError("unavailable", request.operation, "stored_result.brief_history");
        assertScopedRecord(historical, started.scope, request.operation, currentBrief.brief_id);
        try { brief = validateCreativeBrief(historical, { trustedScope: { ...started.scope, brief_id: currentBrief.brief_id } }); }
        catch { throw new CreativeApiError("unavailable", request.operation, "stored_result.brief_history"); }
        if (canonicalHash(brief) !== storedDesignInput.brief_hash) {
          throw new CreativeApiError("unavailable", request.operation, "stored_result.brief_history");
        }
      }
      const stored = validateDesignVersion(job.result.design, {
        trustedScope: { ...started.scope, design_version_id: job.result.design?.design_version_id },
        brief_hash: canonicalHash(brief), known_source_refs: brief.source_identity.map((source) => source.source_id),
      });
      const current = await loadDesign(started.scope, brief, stored.design_version_id, request.operation);
      if (job.result.usage_evidence !== undefined) {
        const usageEvidence = job.result.usage_evidence;
        const usageEvidenceKeys = ["status", "profile_ref", "profile_sha256", "raw_usage_sha256",
          "target_binding_sha256", "attempt_binding_sha256", "source_observation_id", "transport_attempt_id",
          "billable_attempt_id", "provider_name", "model", "observation_sha256", "observation_ref"];
        try {
          assertStoredOnlyKeys(usageEvidence, usageEvidenceKeys, request.operation, "stored_result.usage_evidence");
          if (usageEvidence.status !== "settled_owner_mapping" ||
              usageEvidence.billable_attempt_id !== current.billable_attempt_id ||
              usageEvidence.provider_name !== current.provider || usageEvidence.model !== current.model ||
              current.usage_status !== "complete" || job.result.usage?.completeness !== "complete" ||
              typeof usageEvidence.profile_ref !== "string" || typeof usageEvidence.source_observation_id !== "string" ||
              typeof usageEvidence.observation_ref !== "string" || typeof usageEvidence.transport_attempt_id !== "string" ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.profile_sha256) ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.raw_usage_sha256) ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.target_binding_sha256) ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.attempt_binding_sha256) ||
              !/^sha256:[a-f0-9]{64}$/.test(usageEvidence.observation_sha256)) {
            throw new CreativeApiError("unavailable", request.operation, "stored_result.usage_evidence");
          }
          for (const field of ["profile_ref", "source_observation_id", "observation_ref", "transport_attempt_id"]) {
            assertSafePublicIdentifier(usageEvidence[field], { maxLength: 256 });
          }
        } catch {
          throw new CreativeApiError("unavailable", request.operation, "stored_result.usage_evidence");
        }
      }
      if (canonicalSerialize(stored) !== canonicalSerialize(current) || !isRecord(job.result.usage) ||
        job.result.usage.completeness !== "complete" || job.result.attempt_id !== current.billable_attempt_id) {
        throw new CreativeApiError("unavailable", request.operation, "stored_result");
      }
      const telemetryEvidence = await validateTelemetryEvidenceStatus(job.result.telemetry_evidence, request.operation, {
        tenant_id: principal.tenant_id, project_id: principal.project_id, budget_scope_id: principal.budget_scope_id,
        logical_operation_id: request.action_id, billable_attempt_id: current.billable_attempt_id,
      }, ports.telemetry?.outbox);
      let repairEvidence;
      if (job.result.inspection_repair !== undefined || request.payload.inspection_repair !== undefined) {
        const value = job.result.inspection_repair;
        const requested = request.payload.inspection_repair;
        assertStoredOnlyKeys(value, ["contract", "schema_version", "inspection_id", "inspection_action_id", "source_report_hash",
          "repair_action", "claim_ref", "root_design_version_id", "root_design_hash", "output_design_version_id",
          "output_design_hash", "billable_attempt_id"], request.operation, "stored_result.inspection_repair");
        if (!requested || !isRecord(value) || value.contract !== "CreativeInspectionRepairExecution" || value.schema_version !== "1.0" ||
          value.inspection_action_id !== requested.inspection_action_id || value.source_report_hash !== requested.report_hash ||
          value.repair_action !== requested.repair_action || value.output_design_version_id !== current.design_version_id ||
          value.output_design_hash !== current.design_hash || value.billable_attempt_id !== current.billable_attempt_id ||
          !/^sha256:[a-f0-9]{64}$/.test(value.source_report_hash) || !/^sha256:[a-f0-9]{64}$/.test(value.root_design_hash)) {
          throw new CreativeApiError("unavailable", request.operation, "stored_result.inspection_repair");
        }
        for (const field of ["inspection_id", "inspection_action_id", "claim_ref", "root_design_version_id",
          "output_design_version_id", "billable_attempt_id"]) {
          assertSafePublicIdentifier(value[field], { maxLength: 256 });
        }
        repairEvidence = Object.freeze({ ...value });
      }
      return Object.freeze({ design_version: current, usage: Object.freeze({ completeness: "complete" }),
        telemetry_evidence: telemetryEvidence, ...(repairEvidence ? { inspection_repair: repairEvidence } : {}) });
    }
    if (request.operation === "restore") {
      assertStoredOnlyKeys(job.result, ["selection"], request.operation, "stored_result");
      const selection = job.result.selection;
      assertStoredOnlyKeys(selection, ["tenant_id", "project_id", "brief_id", "design_version_id", "design_hash", "revision"],
        request.operation, "stored_selection");
      if (!isRecord(selection) || selection.tenant_id !== principal.tenant_id || selection.project_id !== principal.project_id ||
        selection.brief_id !== request.payload.brief_id || selection.design_version_id !== request.payload.target_design_version_id ||
        selection.design_hash !== undefined && (typeof selection.design_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(selection.design_hash)) ||
        !Number.isSafeInteger(selection.revision) ||
        selection.revision !== request.payload.expected_selection_revision + 1) {
        throw new CreativeApiError("unavailable", request.operation, "stored_selection");
      }
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const design = await loadDesign(started.scope, brief, selection.design_version_id, request.operation);
      if (selection.design_hash !== undefined && selection.design_hash !== design.design_hash) {
        throw new CreativeApiError("unavailable", request.operation, "stored_selection");
      }
      return Object.freeze({ selection: Object.freeze({ tenant_id: selection.tenant_id,
        project_id: selection.project_id, brief_id: selection.brief_id,
        design_version_id: selection.design_version_id, design_hash: design.design_hash, revision: selection.revision }) });
    }
    if (request.operation === "inspect") {
      if (Object.hasOwn(job.result, "report")) {
        assertStoredOnlyKeys(job.result, ["report", "inspection_id", "attempt_ids", "telemetry_evidence"],
          request.operation, "stored_inspection");
        const getSession = requiredPort(ports, "storage.getInspectionSession", request.operation);
        const session = await getSession(Object.freeze({ scope: started.scope, brief_id: request.payload.brief_id,
          action_id: request.action_id }));
        if (!isRecord(session) || session.status !== "completed" || !Array.isArray(session.stages) ||
          !isRecord(session.result) || canonicalSerialize(session.result) !== canonicalSerialize(job.result) ||
          session.tenant_id !== principal.tenant_id || session.project_id !== principal.project_id ||
          session.brief_id !== request.payload.brief_id || session.actor_id !== principal.actor_id ||
          session.action_id !== request.action_id || session.job_id !== job.job_id ||
          session.request_hash !== started.request_hash ||
          !isSafePublicInspectionReference(job.result.inspection_id) ||
          !Array.isArray(job.result.attempt_ids) || job.result.attempt_ids.length > 3 ||
          !Array.isArray(job.result.telemetry_evidence) || job.result.telemetry_evidence.length !== job.result.attempt_ids.length) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.session");
        }
        // Capabilities describe what can be dispatched now. Replay instead
        // reconstructs the exact completed report from its persisted,
        // hash-bound historical eligibility; current read rights are checked
        // below and no provider or metering work is reopened.
        const reportInput = job.result.report;
        if (!isRecord(reportInput) || !Array.isArray(reportInput.eligible_repair_actions)) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.report");
        }
        const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
        if (canonicalHash(brief) !== session.brief_hash) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.brief");
        }
        const design = await loadDesign(started.scope, brief, request.payload.design_version_id, request.operation);
        const parent = design.parent_version_id === null ? null
          : await loadDesign(started.scope, brief, design.parent_version_id, request.operation, { allowHistorical: true });
        let rootDesign = design;
        while (rootDesign.parent_version_id !== null) {
          rootDesign = await loadDesign(started.scope, brief, rootDesign.parent_version_id, request.operation, { allowHistorical: true });
        }
        if (session.design_version_id !== design.design_version_id || session.design_hash !== design.design_hash ||
          session.parent_version_id !== design.parent_version_id || session.parent_design_hash !== (parent?.design_hash ?? null) ||
          session.artifact_id !== design.artifact.artifact_id || session.artifact_hash !== design.artifact.content_hash ||
          session.root_design_version_id !== rootDesign.design_version_id || session.root_design_hash !== rootDesign.design_hash) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.subject");
        }
        const getBytes = requiredPort(ports, "storage.getArtifactBytes", request.operation);
        let artifactBytes;
        try { artifactBytes = Uint8Array.from(await getBytes(Object.freeze({ scope: started.scope,
          brief_id: brief.brief_id, design_version_id: design.design_version_id }))); }
        catch { throw new CreativeApiError("unavailable", request.operation, "stored_inspection.bytes"); }
        if (hashArtifactBytes(artifactBytes) !== design.artifact.content_hash) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.bytes");
        }
        const assetUse = inspectionAssetUseSet(design, brief, request.operation);
        await verifyInspectionAssetRights(started.scope, brief, assetUse, request.operation);
        let decoderResult;
        try {
          const decoded = await inspectOpenAIImageBytes(artifactBytes);
          decoderResult = Object.freeze({ contract: "OpenAIBoundedImageDecode", schema_version: "1.0", status: "pass",
            artifact_hash: hashArtifactBytes(artifactBytes), format: decoded.format, width: decoded.width, height: decoded.height,
            has_alpha: decoded.has_alpha, has_transparency: decoded.has_transparency });
        } catch {
          decoderResult = Object.freeze({ contract: "OpenAIBoundedImageDecode", schema_version: "1.0", status: "fail",
            artifact_hash: hashArtifactBytes(artifactBytes),
            format: ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" })[design.artifact.media_type] ?? "png",
            width: 1, height: 1, has_alpha: false, has_transparency: false });
        }
        const usedAssets = assetUse.status === "verified"
          ? assetUse.entries.map(({ asset_id, action }) => ({ asset_id, action })) : [];
        const deterministic = inspectCreativeArtifact({ trusted_scope: { ...started.scope,
          design_version_id: design.design_version_id, artifact_id: design.artifact.artifact_id }, brief,
          design_version: design, ...(parent ? { parent_design: parent, parent_design_hash: parent.design_hash } : {}),
          artifact_bytes: artifactBytes, used_assets: usedAssets, asset_use_evidence_status: assetUse.status,
          decoder_result: decoderResult,
          eligible_repair_actions: reportInput.eligible_repair_actions });
        const subjectHash = canonicalInspectionSubjectHash(deterministic);
        const stageByName = new Map();
        for (const stage of session.stages) {
          if (!isRecord(stage) || !["observer", "decision_evidence", "decision_route"].includes(stage.stage) ||
            stageByName.has(stage.stage) || stage.status !== "completed" || typeof stage.attempt_id !== "string" ||
            !isRecord(stage.intent) || !isRecord(stage.result)) {
            throw new CreativeApiError("unavailable", request.operation, "stored_inspection.stage");
          }
          stageByName.set(stage.stage, stage);
        }
        const expectedAttemptIds = ["observer", "decision_evidence", "decision_route"]
          .map((name) => stageByName.get(name)?.attempt_id).filter(Boolean);
        if (canonicalSerialize(expectedAttemptIds) !== canonicalSerialize(job.result.attempt_ids)) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.attempts");
        }
        const observerStage = stageByName.get("observer");
        let observation;
        let providerStatus = "not_requested";
        if (deterministic.gate === "eligible" &&
          (!deterministic.dimensions || !["png", "jpeg", "webp"].includes(deterministic.dimensions.format))) {
          providerStatus = "unavailable";
        }
        const ownerUsageStages = [];
        let decisionAbstained = false;
        if (observerStage) {
          const staged = observerStage.result;
          if (observerStage.intent.subject_hash !== subjectHash || observerStage.intent.design_hash !== design.design_hash ||
            observerStage.intent.artifact_hash !== design.artifact.content_hash || staged.subject_hash !== subjectHash ||
            staged.attempt_id !== observerStage.attempt_id || !isRecord(staged.telemetry_evidence) ||
            !["complete", "partial", "unknown"].includes(staged.usage_completeness)) {
            throw new CreativeApiError("unavailable", request.operation, "stored_inspection.observer");
          }
          ownerUsageStages.push(staged.usage_completeness);
          if (staged.provider_status === undefined) {
            assertStoredOnlyKeys(staged, ["subject_hash", "observation", "attempt_id", "usage_completeness", "telemetry_evidence"],
              request.operation, "stored_inspection.observer");
            observation = validateVisualObservation(staged.observation, deterministic);
            providerStatus = "complete";
          } else if (["refused", "unavailable", "timeout"].includes(staged.provider_status) &&
            staged.observation === undefined) {
            assertStoredOnlyKeys(staged, ["subject_hash", "provider_status", "attempt_id", "usage_completeness", "telemetry_evidence"],
              request.operation, "stored_inspection.observer");
            providerStatus = staged.provider_status;
          } else {
            throw new CreativeApiError("unavailable", request.operation, "stored_inspection.observer");
          }
        }
        if (providerStatus === "complete" && !observation || providerStatus !== "complete" && observation ||
          observerStage && deterministic.gate !== "eligible") {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.observer");
        }
        let decision;
        const firstStage = stageByName.get("decision_evidence");
        const routeStage = stageByName.get("decision_route");
        if (firstStage && !observation || routeStage && !firstStage) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_stages");
        }
        if (firstStage) {
          const firstRequest = firstStage.result.request;
          const firstResult = firstStage.result.decision_result;
          if (!isRecord(firstRequest) || !isRecord(firstResult) || !isRecord(firstStage.result.telemetry_evidence) ||
            firstStage.intent.subject_hash !== subjectHash || firstStage.intent.request_hash !== canonicalHash(firstRequest) ||
            firstRequest.billable_attempt_id !== firstStage.attempt_id ||
            !["complete", "partial", "unknown"].includes(firstStage.result.usage_completeness)) {
            throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_first");
          }
          assertStoredOnlyKeys(firstStage.result, ["request", "decision_result", "telemetry_evidence", "usage_completeness"],
            request.operation, "stored_inspection.decision_first");
          ownerUsageStages.push(firstStage.result.usage_completeness);
          const decisionContextKeys = ["event_id", "correlation_id", "producer", "occurred_at", "ingested_at", "environment",
            "billing_mode", "request_id", "logical_operation_id", "billable_attempt_id", "attempt_number", "attempt_limit",
            "budget_ref", "deadline_at", "cancellation_ref", "model_policy", "workflow_id", "run_id", "order_id",
            "job_id", "transport_attempt_id", "provider_request_id"];
          const decisionContext = Object.fromEntries(Object.entries(firstRequest).filter(([key]) => decisionContextKeys.includes(key)));
          const preparedFirstStage = firstStage.intent.target_binding_sha256 !== undefined;
          const plan = (preparedFirstStage ? prepareInspectionDecisionPlan : createInspectionDecisionPlan)({ deterministic,
            observation, decision_context: decisionContext });
          const expectedFirst = plan.status === "ready" ? preparedFirstStage
            ? bindInspectionDecisionReservation(plan, prepareInspectionEvidenceBatch(plan, observation),
              firstRequest.budget_ref.reservation_ref)
            : createInspectionEvidenceBatch(plan, observation) : null;
          if (plan.status !== "ready" || plan.plan_ref !== firstStage.intent.plan_ref ||
            canonicalHash(expectedFirst) !== canonicalHash(firstRequest) || preparedFirstStage &&
            decisionExecutionTargetHash(firstRequest) !== firstStage.intent.target_binding_sha256) {
            throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_plan");
          }
          const trustedInspectionScope = Object.freeze({ ...started.scope, brief_id: brief.brief_id,
            design_version_id: design.design_version_id, artifact_id: design.artifact.artifact_id, job_id: job.job_id });
          const checkedFirstResult = validateDecisionResult(firstRequest, firstResult, { trustedScope: trustedInspectionScope });
          if (checkedFirstResult.status === "cancelled") {
            throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_first");
          }
          if (checkedFirstResult.status !== "complete") {
            if (routeStage) throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_stages");
            decisionAbstained = true;
          } else {
            if (!routeStage) throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_stages");
            const routeRequest = routeStage.result.request;
            const routeResult = routeStage.result.decision_result;
            if (!isRecord(routeRequest) || !isRecord(routeResult) || !isRecord(routeStage.result.telemetry_evidence) ||
              routeStage.intent.subject_hash !== subjectHash || routeStage.intent.request_hash !== canonicalHash(routeRequest) ||
              routeStage.intent.first_request_ref !== canonicalHash(firstRequest) ||
              routeStage.intent.first_result_ref !== canonicalHash(checkedFirstResult) ||
              routeStage.intent.plan_ref !== plan.plan_ref ||
              !["complete", "partial", "unknown"].includes(routeStage.result.usage_completeness)) {
              throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_route");
            }
            assertStoredOnlyKeys(routeStage.result, ["request", "decision_result", "telemetry_evidence", "usage_completeness"],
              request.operation, "stored_inspection.decision_route");
            ownerUsageStages.push(routeStage.result.usage_completeness);
            const routeContext = { ...Object.fromEntries(Object.entries(routeRequest)
              .filter(([key]) => decisionContextKeys.includes(key))), linked_request_id: firstRequest.request_id,
              linked_billable_attempt_id: firstRequest.billable_attempt_id, plan_ref: plan.plan_ref,
              inspection_subject_hash: subjectHash };
            const preparedRouteStage = routeStage.intent.target_binding_sha256 !== undefined;
            const unboundRoute = (preparedRouteStage ? prepareInspectionRouteBatch : createInspectionRouteBatch)(plan,
              firstRequest, checkedFirstResult, trustedInspectionScope, routeContext);
            const expectedRouteRequest = preparedRouteStage ? bindInspectionDecisionReservation(plan, unboundRoute,
              routeRequest.budget_ref.reservation_ref) : unboundRoute;
            if (!isRecord(expectedRouteRequest) || canonicalHash(expectedRouteRequest) !== canonicalHash(routeRequest) ||
              preparedRouteStage && decisionExecutionTargetHash(routeRequest) !== routeStage.intent.target_binding_sha256) {
              throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_provenance");
            }
            const checkedRouteResult = validateDecisionResult(routeRequest, routeResult, { trustedScope: trustedInspectionScope });
            if (checkedRouteResult.status === "cancelled") {
              throw new CreativeApiError("unavailable", request.operation, "stored_inspection.decision_route");
            }
            decision = evaluateInspectionDecision(plan, firstRequest, checkedFirstResult, routeRequest, checkedRouteResult,
              trustedInspectionScope);
            if (checkedRouteResult.status !== "complete") decisionAbstained = true;
          }
        }
        if (!isRecord(reportInput) || reportInput.contract !== "CreativeInspectionReport" || reportInput.schema_version !== "1.0" ||
          !isRecord(reportInput.limits) || reportInput.subject_hash !== subjectHash) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.report");
        }
        const usageCompleteness = aggregateUsageCompleteness(ownerUsageStages);
        const expectedReport = createInspectionReport({ deterministic, provider_status: providerStatus, decision,
          observations: observation ? [observation] : [], policy_version: INSPECTION_POLICY_VERSION, evidence_mode: "fixture",
          subject_hash: subjectHash,
          question_schema_version: decision ? INSPECTION_QUESTION_SCHEMA_VERSION : null,
          model_id: decision ? PINNED_JEV_MODEL_ID : null,
          decision_policy_version: decision ? INSPECTION_POLICY_VERSION : null,
          uncertainty: usageUncertainty(usageCompleteness, decisionAbstained ? ["question_abstained"] : []),
          limits: { ...reportInput.limits, usage_completeness: usageCompleteness } });
        if (canonicalSerialize(expectedReport) !== canonicalSerialize(reportInput)) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection.report");
        }
        const telemetryEvidence = [];
        for (let index = 0; index < job.result.attempt_ids.length; index += 1) {
          const stageName = ["observer", "decision_evidence", "decision_route"][index];
          const stage = stageByName.get(stageName);
          const evidence = job.result.telemetry_evidence[index];
          if (!stage || canonicalSerialize(evidence) !== canonicalSerialize(stage.result.telemetry_evidence)) {
            throw new CreativeApiError("unavailable", request.operation, "stored_inspection.telemetry");
          }
          telemetryEvidence.push(await validateTelemetryEvidenceStatus(evidence, request.operation, {
            tenant_id: principal.tenant_id, project_id: principal.project_id, budget_scope_id: principal.budget_scope_id,
            logical_operation_id: request.action_id, billable_attempt_id: stage.attempt_id,
          }, ports.telemetry?.outbox));
        }
        return Object.freeze({ report: expectedReport, inspection_id: job.result.inspection_id,
          attempt_ids: Object.freeze([...job.result.attempt_ids]), telemetry_evidence: Object.freeze(telemetryEvidence) });
      }
      assertStoredOnlyKeys(job.result, ["inspection", "attempt_id"], request.operation, "stored_result");
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const design = await loadDesign(started.scope, brief, request.payload.design_version_id, request.operation);
      const result = job.result.inspection;
      if (!isRecord(result)) throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
      assertStoredOnlyKeys(result, ["tenant_id", "project_id", "brief_id", "design_version_id", "artifact_id", "artifact_hash",
        "design_hash", "inspection_id", "observations", "usage", "telemetry_evidence"], request.operation, "stored_inspection");
      if (result.tenant_id !== principal.tenant_id || result.project_id !== principal.project_id || result.brief_id !== brief.brief_id ||
        result.design_version_id !== design.design_version_id || result.artifact_id !== design.artifact.artifact_id ||
        result.artifact_hash !== design.artifact.content_hash || result.design_hash !== design.design_hash ||
        typeof result.inspection_id !== "string" || !Array.isArray(result.observations) || result.observations.length > 64 ||
        !isRecord(result.usage)) throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
      assertStoredOnlyKeys(result.usage, ["completeness", "input_tokens", "output_tokens"],
        request.operation, "stored_inspection.usage");
      const normalizedUsage = normalizeUsage(result.usage);
      if (normalizedUsage.completeness !== "complete" ||
        canonicalSerialize(normalizedUsage) !== canonicalSerialize(result.usage)) {
        throw new CreativeApiError("unavailable", request.operation, "stored_inspection.usage");
      }
      const observations = result.observations.map((observation, index) => {
        const field = `stored_inspection.observations[${index}]`;
        assertStoredOnlyKeys(observation, ["observer", "content_hash", "uncertainty", "summary", "source_ref"], request.operation, field);
        if (!isRecord(observation.observer) || !["human", "model", "system"].includes(observation.observer.type) ||
          observation.content_hash !== design.artifact.content_hash || !isRecord(observation.uncertainty) ||
          !["measured", "not_measured", "unknown"].includes(observation.uncertainty.status) ||
          (observation.source_ref !== undefined && !brief.source_identity.some((source) => source.source_id === observation.source_ref))) {
          throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
        }
        assertStoredOnlyKeys(observation.observer, ["type", "id"], request.operation, `${field}.observer`);
        assertStoredOnlyKeys(observation.uncertainty, ["status", "note"], request.operation, `${field}.uncertainty`);
        inspectionText(observation.observer.id, `${field}.observer.id`, 200, request.operation, true);
        if (observation.uncertainty.note !== undefined) {
          inspectionText(observation.uncertainty.note, `${field}.uncertainty.note`, 500, request.operation, true);
        }
        inspectionText(observation.summary, `${field}.summary`, 1500, request.operation, true);
        if (observation.source_ref !== undefined) {
          inspectionText(observation.source_ref, `${field}.source_ref`, 200, request.operation, true);
        }
        return Object.freeze({ observer: Object.freeze({ type: observation.observer.type, id: observation.observer.id }),
          content_hash: observation.content_hash,
          uncertainty: Object.freeze({ status: observation.uncertainty.status,
            ...(observation.uncertainty.note !== undefined ? { note: observation.uncertainty.note } : {}) }),
          summary: observation.summary,
          ...(observation.source_ref !== undefined ? { source_ref: observation.source_ref } : {}) });
      });
      if (typeof started.job.result.attempt_id !== "string") throw new CreativeApiError("unavailable", request.operation, "stored_inspection");
      publicIdentifier(result.inspection_id, "stored_inspection.inspection_id", request.operation, 256);
      const telemetryEvidence = await validateTelemetryEvidenceStatus(result.telemetry_evidence, request.operation, {
        tenant_id: principal.tenant_id, project_id: principal.project_id, budget_scope_id: principal.budget_scope_id,
        logical_operation_id: request.action_id, billable_attempt_id: started.job.result.attempt_id,
      }, ports.telemetry?.outbox);
      return Object.freeze({ tenant_id: result.tenant_id, project_id: result.project_id, brief_id: result.brief_id,
        design_version_id: result.design_version_id, artifact_id: result.artifact_id,
        artifact_hash: result.artifact_hash, design_hash: result.design_hash,
        inspection_id: result.inspection_id, observations: Object.freeze(observations), usage: normalizedUsage,
        telemetry_evidence: telemetryEvidence });
    }
    if (request.operation === "handoff") {
      assertStoredOnlyKeys(job.result, ["handoff", "receipt", "handoff_created_at"], request.operation, "stored_result");
      const brief = await loadBrief(started.scope, request.payload.brief_id, request.operation);
      const design = await loadDesign(started.scope, brief, request.payload.design_version_id, request.operation);
      const replayNow = new Date(now());
      const consumedAt = validatedReceiptTime(job.result.receipt, replayNow, request.operation, true);
      let handoff;
      try {
        handoff = validateArtworkHandoff(job.result.handoff, started.scope, { now: consumedAt });
      } catch {
        throw new CreativeApiError("unavailable", request.operation, "stored_handoff");
      }
      assertReceiptWindow(job.result.receipt, handoff, job.result.handoff_created_at, replayNow, request.operation, true);
      if (handoff.binding.brief.brief_id !== brief.brief_id || handoff.binding.brief.sha256 !== canonicalHash(brief).slice(7) ||
        handoff.binding.design_version.design_version_id !== design.design_version_id ||
        handoff.binding.design_version.artwork_sha256 !== design.artifact.content_hash.replace(/^sha256:/, "")) {
        throw new CreativeApiError("unavailable", request.operation, "stored_handoff");
      }
      let receipt;
      try {
        receipt = validateConsumptionReceipt(job.result.receipt, handoff, { trustedScope: started.scope, now: consumedAt });
      } catch {
        throw new CreativeApiError("unavailable", request.operation, "stored_receipt");
      }
      return Object.freeze({ handoff, receipt });
    }
    throw new CreativeApiError("unavailable", request.operation, "stored_result");
  }

  async function invoke(principalInput, requestInput) {
    let operation = "unknown";
    let request;
    let principal;
    let responseSchemaVersion = CREATIVE_API_VERSION;
    try {
      const snapshot = immutableRequestSnapshot(requestInput);
      if (snapshot?.schema_version === "1.1") responseSchemaVersion = "1.1";
      if (snapshot?.schema_version === "1.2") responseSchemaVersion = "1.2";
      if (snapshot?.schema_version === "1.3") responseSchemaVersion = "1.3";
      operation = CREATIVE_API_OPERATIONS.includes(snapshot?.operation) ? snapshot.operation : "unknown";
      request = validateRequest(snapshot);
      operation = request.operation;
      principal = validatePrincipal(principalInput, now());
      assertRequestScope(principal, request);
      const assertOperationAvailable = ports.jobs?.assertOperationAvailable;
      if (typeof assertOperationAvailable === "function") {
        const availability = await assertOperationAvailable(Object.freeze({ operation }));
        if (!isRecord(availability) || availability.status !== "available") {
          throw new CreativeApiError("unavailable", operation, "operation_capability", { retryable: true });
        }
      }
      await emitTrace({ event: "creative_api.request", operation, request_id: request.request_id,
        tenant_id: principal.tenant_id, project_id: principal.project_id, actor_id: principal.actor_id });
      if (operation === "brief.create") return await createBrief(principal, request);
      if (operation === "brief.invalidate") return await invalidateBrief(principal, request);
      if (operation === "composition.get") return await getPublicComposition(principal, request);
      if (operation === "composition.history") return await getPublicCompositionHistory(principal, request);
      if (operation === "list") {
        const scope = scopeFor(principal, boundedString(request.payload.brief_id, "brief_id"));
        const limit = request.payload.limit === undefined ? 20 : request.payload.limit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CreativeApiError("invalid_request", operation, "limit");
        const after = decodeCursor(request.payload.cursor, scope, scope.brief_id);
        const list = requiredPort(ports, "storage.listDesignVersions", operation);
        const page = await list(Object.freeze({ scope, brief_id: scope.brief_id, limit: limit + 1, after }));
        if (!isRecord(page) || !Array.isArray(page.items) || page.items.length > limit + 1 || typeof page.has_more !== "boolean") {
          throw new CreativeApiError("unavailable", operation);
        }
        const brief = await loadBrief(scope, scope.brief_id, operation);
        const items = await Promise.all(page.items.map((item) => {
          assertScopedRecord(item, scope, operation, scope.brief_id);
          return loadDesign(scope, brief, item.design_version_id, operation, { allowHistorical: true });
        }));
        const sorted = [...items].sort(compareOrder);
        if (canonicalSerialize(sorted) !== canonicalSerialize(items) ||
          (after && items.some((item) => !isAfterCursor(item, after)))) throw new CreativeApiError("failed", operation, "page_order");
        const visible = items.slice(0, limit);
        const hasMore = page.has_more || items.length > limit;
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          result: Object.freeze({ items: visible, next_cursor: hasMore && visible.length ? encodeCursor(scope, scope.brief_id, visible.at(-1)) : null }) }), operation);
      }
      if (operation === "compare") {
        const scope = scopeFor(principal, boundedString(request.payload.brief_id, "brief_id"));
        const brief = await loadBrief(scope, scope.brief_id, operation);
        const [left, right] = await Promise.all([
          loadDesign(scope, brief, request.payload.left_design_version_id, operation, { allowHistorical: true }),
          loadDesign(scope, brief, request.payload.right_design_version_id, operation, { allowHistorical: true }),
        ]);
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          result: Object.freeze({ left, right, changed_fields: Object.freeze([
            ...(left.artifact.content_hash !== right.artifact.content_hash ? ["artifact.content_hash"] : []),
            ...(left.parent_version_id !== right.parent_version_id ? ["parent_version_id"] : []),
            ...(left.brief_hash !== right.brief_hash ? ["brief_hash"] : []),
          ]) }) }), operation);
      }
      if (operation === "job.status") {
        const scope = scopeFor(principal);
        const get = requiredPort(ports, "jobs.get", operation);
        const job = await get(Object.freeze({ scope, job_id: boundedString(request.payload.job_id, "job_id") }));
        if (!job) throw new CreativeApiError("not_found", operation, "job_id");
        assertScopedRecord(job, scope, operation);
        if (job.job_id !== request.payload.job_id || typeof job.action_id !== "string" || typeof job.request_hash !== "string" ||
          typeof job.actor_id !== "string" || !CREATIVE_API_OPERATIONS.includes(job.operation)) {
          throw new CreativeApiError("scope_denied", operation, "job_id");
        }
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          job: publicJob(job, job.job_id) }), operation);
      }
      if (operation === "cancel") {
        const scope = scopeFor(principal);
        const job_id = boundedString(request.payload.job_id, "job_id");
        const get = requiredPort(ports, "jobs.get", operation);
        const target = await get(Object.freeze({ scope, job_id }));
        if (!target) throw new CreativeApiError("not_found", operation, "job_id");
        assertScopedRecord(target, scope, operation);
        if (target.job_id !== job_id || typeof target.action_id !== "string" || typeof target.request_hash !== "string" ||
          typeof target.actor_id !== "string" || !CREATIVE_API_OPERATIONS.includes(target.operation)) {
          throw new CreativeApiError("not_found", operation, "job_id");
        }
        const isCompositionJob = ["composition.create", "composition.update", "composition.revalidate"].includes(target.operation);
        const compositionBriefId = isCompositionJob ? boundedString(target.brief_id, "brief_id") : null;
        if (isCompositionJob && typeof ports.storage?.getCompositionActionIdentityByJob === "function") {
          const identify = ports.storage.getCompositionActionIdentityByJob;
          const identity = await identify(Object.freeze({ scope, job_id }));
          if (identity !== null) {
            const identityKeys = ["tenant_id", "project_id", "brief_id", "job_id", "actor_id", "action_id", "operation", "request_hash"];
            const identityStringFields = ["tenant_id", "project_id", "brief_id", "job_id", "actor_id", "action_id", "request_hash"];
            if (!isRecord(identity) || Object.keys(identity).length !== identityKeys.length ||
                Object.keys(identity).some((key) => !identityKeys.includes(key)) ||
                identityStringFields.some((field) => typeof identity[field] !== "string" || identity[field].trim() === "" ||
                  identity[field].length > 256) ||
                identity.tenant_id !== scope.tenant_id || identity.project_id !== scope.project_id ||
                identity.brief_id !== compositionBriefId || identity.job_id !== job_id ||
                identity.actor_id !== target.actor_id || identity.action_id !== target.action_id ||
                identity.operation !== target.operation ||
                typeof identity.request_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(identity.request_hash) ||
                identity.request_hash !== target.request_hash) {
              throw new CreativeApiError("failed", operation, "composition.action_identity");
            }
          }
        }
        const cancel = requiredPort(ports, "jobs.cancel", operation);
        const record = await cancel(Object.freeze({ scope, actor_id: principal.actor_id,
          job_id, target_action_id: target.action_id, action_id: request.action_id,
          request_hash: actionRequestHash(request) }));
        if (!isRecord(record) || !record.job || !["cancelled", "replayed"].includes(record.kind)) {
          if (record?.kind === "conflict") throw new CreativeApiError("conflict", operation, "action_id");
          throw new CreativeApiError("not_found", operation, "job_id");
        }
        assertScopedRecord(record.job, scope, operation);
        if (record.job.job_id !== job_id || record.job.action_id !== target.action_id || record.job.request_hash !== target.request_hash) {
          throw new CreativeApiError("scope_denied", operation, "job_id");
        }
        if (isCompositionJob && record.job.brief_id !== compositionBriefId) {
          throw new CreativeApiError("scope_denied", operation, "brief_id");
        }
        if (isCompositionJob) {
          const reconcile = requiredPort(ports, "storage.recoverCompositionAction", operation);
          const compositionScope = Object.freeze({ ...scope, brief_id: compositionBriefId });
          const recovered = await reconcile(Object.freeze({ scope: compositionScope, action_id: target.action_id }));
          if (!isRecord(recovered) || !["cancelled", "unknown", "already_final", "not_found", "pending"].includes(recovered.status)) {
            throw new CreativeApiError("unavailable", operation, "composition_recovery");
          }
          if (recovered.status === "unknown") {
            throw new CreativeApiError(recovered.code === "integrity_error" ? "failed" : "unavailable",
              operation, "composition_recovery");
          }
        }
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: CREATIVE_API_VERSION,
          job: publicJob(record.job, record.job.job_id) }), operation);
      }
      let started = await beginMutation(principal, request);
      if (started.replayed && ["inspect", "concepts.create", "composition.create", "composition.update", "composition.revalidate"].includes(request.operation) &&
        started.job.status === "running" &&
        typeof ports.jobs?.resumeExpired === "function") {
        const resumed = await ports.jobs.resumeExpired(Object.freeze({ scope: started.scope, actor_id: principal.actor_id,
          job_id: started.job.job_id, action_id: request.action_id, request_hash: started.request_hash }));
        if (!isRecord(resumed) || !["started", "existing", "conflict"].includes(resumed.kind)) {
          throw new CreativeApiError("unavailable", request.operation, "job_resume");
        }
        if (resumed.kind === "conflict") throw new CreativeApiError("conflict", request.operation, "action_id");
        if (resumed.kind === "started") {
          if (resumed.job_id !== started.job.job_id || typeof resumed.lease_token !== "string") {
            throw new CreativeApiError("unavailable", request.operation, "job_resume");
          }
          started = { ...started, replayed: false, job_id: resumed.job_id, lease_token: resumed.lease_token };
        } else if (resumed.job?.status === "completed") {
          started = { ...started, job: resumed.job };
        } else if (resumed.job?.status === "running") {
          return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: responseVersionFor(request),
            operation_id: resumed.job.job_id, replayed: true, job: publicJob(resumed.job, resumed.job.job_id) }), operation);
        } else {
          throw new CreativeApiError("unavailable", request.operation, "job_resume");
        }
      }
      if (started.replayed) {
        if (["composition.create", "composition.update", "composition.revalidate"].includes(request.operation) && started.job.status === "cancelled") {
          const reconcile = requiredPort(ports, "storage.recoverCompositionAction", request.operation);
          const recovered = await reconcile(Object.freeze({ scope: started.scope, action_id: request.action_id }));
          if (!isRecord(recovered) || !["cancelled", "already_final", "not_found"].includes(recovered.status)) {
            throw new CreativeApiError("failed", request.operation, "composition_recovery");
          }
        }
        if (started.job.status === "completed") {
          const replayedResult = await validateReplay(principal, request, started);
          return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: responseVersionFor(request),
            operation_id: started.job.job_id, replayed: true, job: publicJob(started.job, started.job.job_id),
            result: replayedResult }), operation);
        }
        return projectPublicIdentifiers(Object.freeze({ ok: true, contract: "CreativeApiResponse", schema_version: responseVersionFor(request),
          operation_id: started.job.job_id, replayed: true, job: publicJob(started.job, started.job.job_id),
        }), operation);
      }
      let response;
      try {
        response = await executeNew(principal, request, started);
      } catch (error) {
        const safe = safeError(error, operation);
        const failIfActive = requiredPort(ports, "jobs.failIfActive", operation);
        const failed = await failIfActive(Object.freeze({ scope: started.scope, actor_id: principal.actor_id,
          job_id: started.job_id, lease_token: started.lease_token, error: {
            code: safe.code, module: "creative-engine.api", operation: safe.operation, field: safe.field,
            retryable: safe.retryable, message: safe.message, diagnostic_ref: safe.diagnostic_ref ?? `creative-api:${safe.code}:${idFactory()}`,
          } }));
        if (!isRecord(failed) || !failed.job || !["failed", "cancelled"].includes(failed.status)) {
          throw new CreativeApiError("unavailable", operation, "job_failure_state");
        }
        if (failed.status === "cancelled") throw new CreativeApiError("cancelled", operation);
        assertScopedRecord(failed.job, started.scope, operation);
        if (["composition.create", "composition.update", "composition.revalidate"].includes(operation) && failed.status === "failed") {
          const reconcile = requiredPort(ports, "storage.recoverCompositionAction", operation);
          const recovered = await reconcile(Object.freeze({ scope: started.scope, action_id: request.action_id }));
          if (!isRecord(recovered) || !["unknown", "already_final", "not_found"].includes(recovered.status)) {
            throw new CreativeApiError("unavailable", operation, "composition_recovery");
          }
        }
        throw safe;
      }
      await emitTrace({ event: "creative_api.completed", operation, operation_id: response.operation_id,
        tenant_id: principal.tenant_id, project_id: principal.project_id, actor_id: principal.actor_id });
      return response;
    } catch (error) {
      await emitTrace({ event: "creative_api.rejected", operation, code: safeError(error, operation).code });
      return failResponse(error, operation, responseSchemaVersion);
    }
  }

  return Object.freeze({ invoke });
}

export const createCreativeRuntime = createCreativeApi;
