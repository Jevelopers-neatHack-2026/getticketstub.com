import { createHash } from "node:crypto";
import { canonicalHash } from "./validation.mjs";
import {
  COMPOSITION_EDIT_PROPOSAL_VERSION,
  hashCompositionLayerManifest,
  validateApprovalBinding,
} from "./approval-handoff.mjs";

export const CREATIVE_COMPOSITION_AUTHORITY_VERSION = "creative.composition-authority/v1.1";
export const CREATIVE_COMPOSITION_SOURCE_CONTRACT = "CreativeCompositionSource";
export const CREATIVE_COMPOSITION_PREVIEW_CONTRACT = "CreativeCompositionPreview";
export const CREATIVE_COMPOSITION_PRODUCTION_CONTRACT = "CreativeCompositionProductionEnvelope";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIZE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_NODES = 50_000;
const MAX_DEPTH = 32;
const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteLength").get;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "buffer").get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteOffset").get;
const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

export class CreativeCompositionContractError extends Error {
  constructor(code, field = "") {
    super("The composition contract could not be validated.");
    this.name = "CreativeCompositionContractError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field) {
  throw new CreativeCompositionContractError(code, field);
}

function freezeJson(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function stableDependenciesForState(dependencies) {
  // Authority proofs attest how the caller obtained the state; they are
  // separately bound by the immutable revision digest and must not create a
  // state-hash fixed point when their state_sha256 names this state.
  const { authority_proof: _authority_proof, ...stateDependencies } = dependencies;
  return Object.freeze(stateDependencies);
}

function assertTimestampWindow(checked_at, expires_at, nowMs, field) {
  if (!Number.isSafeInteger(checked_at) || checked_at < 0 || !Number.isSafeInteger(expires_at) ||
      expires_at <= checked_at || nowMs !== undefined && (checked_at > nowMs || expires_at <= nowMs)) {
    fail("integrity_error", field);
  }
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyCompositionBytes(value, field) {
  let buffer;
  let byteOffset;
  let byteLength;
  let bufferLength;
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
      fail("invalid_request", field);
    }
    // Use the intrinsic typed-array accessors and copy operation. Caller-owned
    // own properties such as `byteLength` and `Symbol.iterator` are ignored.
    buffer = TYPED_ARRAY_BUFFER.call(value);
    byteOffset = TYPED_ARRAY_BYTE_OFFSET.call(value);
    byteLength = TYPED_ARRAY_BYTE_LENGTH.call(value);
    if (!(buffer instanceof ArrayBuffer)) fail("invalid_request", field);
    bufferLength = ARRAY_BUFFER_BYTE_LENGTH.call(buffer);
  } catch (error) {
    if (error instanceof CreativeCompositionContractError) throw error;
    fail("invalid_request", field);
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_PREVIEW_BYTES ||
      !Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + byteLength > bufferLength) {
    fail("invalid_request", field);
  }
  try {
    const source = new Uint8Array(buffer, byteOffset, byteLength);
    const copy = new Uint8Array(byteLength);
    TYPED_ARRAY_SET.call(copy, source);
    return copy;
  } catch {
    fail("invalid_request", field);
  }
}

/** Copy an untrusted JSON value without invoking accessors, toJSON, or inherited fields. */
export function snapshotCompositionJson(value) {
  let nodes = 0;
  function copy(input, depth, field) {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) fail("invalid_request", field);
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    let prototype;
    let descriptors;
    try {
      prototype = Object.getPrototypeOf(input);
      descriptors = Object.getOwnPropertyDescriptors(input);
    } catch { fail("invalid_request", field); }
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype) fail("invalid_request", field);
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) fail("invalid_request", field);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
          fail("invalid_request", field);
        }
      }
      const output = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("invalid_request", field);
        output[index] = copy(descriptor.value, depth + 1, `${field}[${index}]`);
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) fail("invalid_request", field);
    const output = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("invalid_request", field);
      Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1, `${field}.${key}`),
        enumerable: true, configurable: false, writable: false });
    }
    return output;
  }
  return copy(value, 0, "composition");
}

/** Copy the one permitted byte field separately from strict JSON metadata. */
export function snapshotCompositionBytesRecord(value, byteField = "preview_bytes") {
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { fail("invalid_request", "composition.port_result"); }
  if (!plain(value) || prototype !== Object.prototype && prototype !== null) fail("invalid_request", "composition.port_result");
  const byteDescriptor = descriptors[byteField];
  if (!byteDescriptor || !byteDescriptor.enumerable || !Object.hasOwn(byteDescriptor, "value")) {
    fail("invalid_request", `composition.${byteField}`);
  }
  const bytes = copyCompositionBytes(byteDescriptor.value, `composition.${byteField}`);
  const metadata = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === byteField) continue;
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("invalid_request", "composition.port_result");
    Object.defineProperty(metadata, key, { value: snapshotCompositionJson(descriptor.value), enumerable: true,
      configurable: false, writable: false });
  }
  return Object.freeze({ metadata: Object.freeze(metadata), bytes });
}

function id(value, field) {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid_request", field);
  return value;
}

function hash(value, field) {
  if (typeof value !== "string" || !HASH.test(value)) fail("invalid_request", field);
  return value;
}

function exactKeys(value, keys, field) {
  if (!plain(value) || Object.keys(value).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(value, key))) fail("invalid_request", field);
}

function validateLayout(value, field) {
  if (value === null) return null;
  const allowed = ["x_milli", "y_milli", "width_milli", "height_milli"];
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key)) ||
      !Number.isSafeInteger(value.x_milli) || value.x_milli < 0 || value.x_milli > 1000 ||
      !Number.isSafeInteger(value.y_milli) || value.y_milli < 0 || value.y_milli > 1000) fail("invalid_request", field);
  const output = { x_milli: value.x_milli, y_milli: value.y_milli };
  for (const dimension of ["width_milli", "height_milli"]) {
    if (!Object.hasOwn(value, dimension)) continue;
    if (!Number.isSafeInteger(value[dimension]) || value[dimension] < 1 || value[dimension] > 1000) fail("invalid_request", `${field}.${dimension}`);
    output[dimension] = value[dimension];
  }
  if (output.width_milli !== undefined && output.x_milli + output.width_milli > 1000 ||
      output.height_milli !== undefined && output.y_milli + output.height_milli > 1000) fail("invalid_request", field);
  return Object.freeze(output);
}

function validateTextSize(value, field) {
  if (value === null) return null;
  exactKeys(value, ["value", "unit"], field);
  if (typeof value.value !== "string" || !SIZE.test(value.value) || Number(value.value) <= 0 ||
      !["pt", "px"].includes(value.unit)) fail("invalid_request", field);
  return Object.freeze({ value: value.value, unit: value.unit });
}

export function validateCompositionGeometry(value, layerManifest) {
  value = snapshotCompositionJson(value);
  layerManifest = snapshotCompositionJson(layerManifest);
  if (!Array.isArray(value) || !Array.isArray(layerManifest) || value.length !== layerManifest.length) {
    fail("invalid_request", "geometry");
  }
  const seen = new Set();
  return Object.freeze(value.map((raw, index) => {
    exactKeys(raw, ["layer_id", "layout", "text_size"], `geometry[${index}]`);
    const layerId = id(raw.layer_id, `geometry[${index}].layer_id`);
    const layer = layerManifest[index];
    if (!layer || layer.layer_id !== layerId || seen.has(layerId)) fail("invalid_request", `geometry[${index}].layer_id`);
    seen.add(layerId);
    const layout = validateLayout(raw.layout, `geometry[${index}].layout`);
    const textSize = validateTextSize(raw.text_size, `geometry[${index}].text_size`);
    if (layer.kind !== "text" && textSize !== null) fail("invalid_request", `geometry[${index}].text_size`);
    return Object.freeze({ layer_id: layerId, layout, text_size: textSize });
  }));
}

function cleanBinding(value, trustedScope) {
  try { return validateApprovalBinding(value, trustedScope); }
  catch (error) { fail("invalid_request", `binding.${error?.field ?? "value"}`); }
}

function validateArtifact(value, expectedHash) {
  exactKeys(value, ["artifact_id", "locator_ref", "sha256", "mime_type", "width_px", "height_px", "access_policy_ref"], "artwork");
  for (const field of ["artifact_id", "locator_ref", "mime_type", "access_policy_ref"]) id(value[field], `artwork.${field}`);
  if (value.sha256 !== expectedHash || !SHA256.test(value.sha256) ||
      !Number.isSafeInteger(value.width_px) || value.width_px < 1 ||
      !Number.isSafeInteger(value.height_px) || value.height_px < 1) fail("invalid_request", "artwork");
  return Object.freeze({ ...value });
}

function validateRights(value, binding, dependencies, layerManifest) {
  const modificationRequired = new Set(layerManifest.filter((layer) => layer.kind === "approved_asset")
    .map((layer) => layer.asset_id));
  if (!Array.isArray(value) || value.length < binding.assets.length * 2 || value.length > binding.assets.length * 3) {
    fail("invalid_request", "dependencies.asset_rights");
  }
  const rights = value.map((raw, index) => {
    exactKeys(raw, ["asset_id", "action", "source_ref", "content_hash", "package_id", "package_hash",
      "permission_ref", "intended_use", "evidence_ref", "checked_at", "expires_at"], `dependencies.asset_rights[${index}]`);
    const asset = binding.assets.find((candidate) => candidate.asset_id === raw.asset_id);
    const proof = {
      asset_id: id(raw.asset_id, `dependencies.asset_rights[${index}].asset_id`),
      action: raw.action,
      source_ref: id(raw.source_ref, `dependencies.asset_rights[${index}].source_ref`),
      content_hash: hash(raw.content_hash, `dependencies.asset_rights[${index}].content_hash`),
      package_id: id(raw.package_id, `dependencies.asset_rights[${index}].package_id`),
      package_hash: hash(raw.package_hash, `dependencies.asset_rights[${index}].package_hash`),
      permission_ref: id(raw.permission_ref, `dependencies.asset_rights[${index}].permission_ref`),
      intended_use: id(raw.intended_use, `dependencies.asset_rights[${index}].intended_use`),
      evidence_ref: id(raw.evidence_ref, `dependencies.asset_rights[${index}].evidence_ref`),
      checked_at: raw.checked_at,
      expires_at: raw.expires_at,
    };
    if (!asset || proof.asset_id !== asset.asset_id || proof.content_hash !== `sha256:${asset.sha256}` ||
        proof.permission_ref !== asset.permission_ref || proof.intended_use !== asset.intended_use ||
        !["display", "modify", "reproduce"].includes(proof.action) || proof.package_id !== dependencies.package_id ||
        proof.package_hash !== dependencies.package_sha256 || !Number.isSafeInteger(proof.checked_at) ||
        proof.checked_at < 0 || !Number.isSafeInteger(proof.expires_at) || proof.expires_at <= proof.checked_at) {
      fail("invalid_request", `dependencies.asset_rights[${index}]`);
    }
    return Object.freeze(proof);
  });
  if (rights.some((item, index) => index > 0 && (rights[index - 1].asset_id.localeCompare(item.asset_id) > 0 ||
      rights[index - 1].asset_id === item.asset_id && rights[index - 1].action.localeCompare(item.action) >= 0))) {
    fail("invalid_request", "dependencies.asset_rights");
  }
  for (const asset of binding.assets) {
    if (!rights.some((proof) => proof.asset_id === asset.asset_id && proof.action === "display")) {
      fail("invalid_request", "dependencies.asset_rights");
    }
    if (!rights.some((proof) => proof.asset_id === asset.asset_id && proof.action === "reproduce")) {
      fail("invalid_request", "dependencies.asset_rights");
    }
    if (modificationRequired.has(asset.asset_id) &&
        !rights.some((proof) => proof.asset_id === asset.asset_id && proof.action === "modify")) {
      fail("invalid_request", "dependencies.asset_rights");
    }
  }
  return Object.freeze(rights);
}

function validateEditPolicy(value, dependencies, binding, layerManifest, nowMs) {
  exactKeys(value, ["contract", "schema_version", "policy_ref", "policy_version", "policy_sha256",
    "brief_hash", "facts_revision_id", "facts_sha256", "package_id", "package_sha256",
    "design_version_id", "design_version_sha256", "artwork_sha256", "selection_revision", "locked_layer_ids",
    "factual_text_layers", "checked_at", "expires_at"], "dependencies.edit_policy");
  const policy = {
    contract: value.contract,
    schema_version: value.schema_version,
    policy_ref: id(value.policy_ref, "dependencies.edit_policy.policy_ref"),
    policy_version: id(value.policy_version, "dependencies.edit_policy.policy_version"),
    brief_hash: hash(value.brief_hash, "dependencies.edit_policy.brief_hash"),
    facts_revision_id: id(value.facts_revision_id, "dependencies.edit_policy.facts_revision_id"),
    facts_sha256: hash(value.facts_sha256, "dependencies.edit_policy.facts_sha256"),
    package_id: id(value.package_id, "dependencies.edit_policy.package_id"),
    package_sha256: hash(value.package_sha256, "dependencies.edit_policy.package_sha256"),
    design_version_id: id(value.design_version_id, "dependencies.edit_policy.design_version_id"),
    design_version_sha256: hash(value.design_version_sha256, "dependencies.edit_policy.design_version_sha256"),
    artwork_sha256: hash(value.artwork_sha256, "dependencies.edit_policy.artwork_sha256"),
    selection_revision: value.selection_revision,
    locked_layer_ids: value.locked_layer_ids,
    factual_text_layers: value.factual_text_layers,
    checked_at: value.checked_at,
    expires_at: value.expires_at,
  };
  if (policy.contract !== "CreativeCompositionEditPolicy" || policy.schema_version !== "1.0" ||
      policy.brief_hash !== dependencies.brief_hash || policy.facts_revision_id !== dependencies.facts_revision_id ||
      policy.facts_sha256 !== dependencies.facts_sha256 || policy.package_id !== dependencies.package_id ||
      policy.package_sha256 !== dependencies.package_sha256 || policy.design_version_id !== dependencies.design_version_id ||
      policy.design_version_sha256 !== dependencies.design_version_sha256 ||
      policy.artwork_sha256 !== dependencies.artwork_sha256 || policy.selection_revision !== dependencies.selection_revision ||
      !Array.isArray(policy.locked_layer_ids) || !Array.isArray(policy.factual_text_layers) ||
      policy.locked_layer_ids.length > layerManifest.length || policy.factual_text_layers.length > layerManifest.length) {
    fail("invalid_request", "dependencies.edit_policy");
  }
  assertTimestampWindow(policy.checked_at, policy.expires_at, nowMs, "dependencies.edit_policy");
  const layerMap = new Map(layerManifest.map((layer) => [layer.layer_id, layer]));
  const locked = [...policy.locked_layer_ids];
  if (locked.some((layerId, index) => typeof layerId !== "string" || !layerMap.has(layerId) ||
      index > 0 && locked[index - 1].localeCompare(layerId) >= 0)) fail("invalid_request", "dependencies.edit_policy.locked_layer_ids");
  const factual = policy.factual_text_layers.map((raw, index) => {
    exactKeys(raw, ["layer_id", "fact_id", "fact_sha256", "text_sha256"], `dependencies.edit_policy.factual_text_layers[${index}]`);
    const layerId = id(raw.layer_id, `dependencies.edit_policy.factual_text_layers[${index}].layer_id`);
    const layer = layerMap.get(layerId);
    if (!layer || layer.kind !== "text" || index > 0 &&
        policy.factual_text_layers[index - 1].layer_id.localeCompare(layerId) >= 0 ||
        hash(raw.fact_sha256, `dependencies.edit_policy.factual_text_layers[${index}].fact_sha256`) !== dependencies.facts_sha256 ||
        hash(raw.text_sha256, `dependencies.edit_policy.factual_text_layers[${index}].text_sha256`) !==
          `sha256:${createHash("sha256").update(layer.value, "utf8").digest("hex")}`) {
      fail("invalid_request", `dependencies.edit_policy.factual_text_layers[${index}]`);
    }
    return Object.freeze({ layer_id: layerId, fact_id: id(raw.fact_id, `dependencies.edit_policy.factual_text_layers[${index}].fact_id`),
      fact_sha256: raw.fact_sha256, text_sha256: raw.text_sha256 });
  });
  const { policy_sha256: suppliedHash, ...body } = policy;
  const policy_sha256 = hash(value.policy_sha256, "dependencies.edit_policy.policy_sha256");
  if (canonicalHash(body) !== policy_sha256) fail("integrity_error", "dependencies.edit_policy.policy_sha256");
  return freezeJson({ ...body, policy_sha256, locked_layer_ids: Object.freeze(locked),
    factual_text_layers: Object.freeze(factual) });
}

function normalizeDependencies(value, binding, expectedScope, layerManifest, nowMs) {
  exactKeys(value, ["brief_hash", "facts_revision_id", "facts_sha256", "package_id", "package_sha256",
    "design_version_id", "design_version_sha256", "artwork_sha256", "parent_version_id", "parent_design_hash", "selection_revision",
    "asset_rights", "edit_policy", "authority_proof"], "dependencies");
  const dependencies = {
    brief_hash: hash(value.brief_hash, "dependencies.brief_hash"),
    facts_revision_id: id(value.facts_revision_id, "dependencies.facts_revision_id"),
    facts_sha256: hash(value.facts_sha256, "dependencies.facts_sha256"),
    package_id: id(value.package_id, "dependencies.package_id"),
    package_sha256: hash(value.package_sha256, "dependencies.package_sha256"),
    design_version_id: id(value.design_version_id, "dependencies.design_version_id"),
    design_version_sha256: hash(value.design_version_sha256, "dependencies.design_version_sha256"),
    artwork_sha256: hash(value.artwork_sha256, "dependencies.artwork_sha256"),
    parent_version_id: value.parent_version_id === null ? null : id(value.parent_version_id, "dependencies.parent_version_id"),
    parent_design_hash: value.parent_design_hash === null ? null : hash(value.parent_design_hash, "dependencies.parent_design_hash"),
    selection_revision: value.selection_revision,
  };
  if (!Number.isSafeInteger(dependencies.selection_revision) || dependencies.selection_revision < 0 ||
      binding.tenant_id !== expectedScope.tenant_id || binding.project_id !== expectedScope.project_id ||
      binding.brief.brief_id !== expectedScope.brief_id || binding.brief.sha256 !== dependencies.brief_hash.slice(7) ||
      binding.facts.sha256 !== dependencies.facts_sha256.slice(7) ||
      binding.facts.revision_id !== dependencies.facts_revision_id ||
      binding.design_version.design_version_id !== dependencies.design_version_id ||
      binding.design_version.artwork_sha256 !== dependencies.artwork_sha256.slice(7)) fail("invalid_request", "dependencies.binding");
  const authority = value.authority_proof;
  exactKeys(authority, ["proof_ref", "state_sha256", "checked_at", "expires_at"], "dependencies.authority_proof");
  dependencies.authority_proof = Object.freeze({
    proof_ref: id(authority.proof_ref, "dependencies.authority_proof.proof_ref"),
    state_sha256: hash(authority.state_sha256, "dependencies.authority_proof.state_sha256"),
    checked_at: authority.checked_at,
    expires_at: authority.expires_at,
  });
  assertTimestampWindow(authority.checked_at, authority.expires_at, nowMs, "dependencies.authority_proof");
  dependencies.asset_rights = validateRights(value.asset_rights, binding, dependencies, layerManifest);
  dependencies.edit_policy = validateEditPolicy(value.edit_policy, dependencies, binding, layerManifest, nowMs);
  return Object.freeze(dependencies);
}

function bindingWithoutPreview(binding) {
  const { preview_sha256: _preview, ...rest } = binding;
  return rest;
}

function stateValue({ tenant_id, project_id, brief_id, composition_id, revision_id, parent_revision_id,
  parent_revision_sha256, binding, artwork, layer_manifest, geometry, dependencies }) {
  return Object.freeze({ contract: "CreativeCompositionState", schema_version: "1.1",
    tenant_id, project_id, brief_id, composition_id, revision_id,
    parent_revision_id, parent_revision_sha256, binding: bindingWithoutPreview(binding), artwork,
    layer_manifest, geometry, dependencies: stableDependenciesForState(dependencies) });
}

export function compositionStateHash(state) {
  return canonicalHash(stateValue(state));
}

function revisionDigest(revision) {
  const { revision_sha256: _digest, created_at: _created, ...body } = revision;
  return canonicalHash(body);
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createCompositionRevision(rawInput, { trustedScope, previewBytes, nowMs }) {
  const input = snapshotCompositionJson(rawInput);
  previewBytes = copyCompositionBytes(previewBytes, "preview_bytes");
  exactKeys(input, ["tenant_id", "project_id", "brief_id", "composition_id", "revision_id", "parent_revision_id",
    "parent_revision_sha256", "binding", "artwork", "layer_manifest", "geometry", "dependencies", "preview"], "revision");
  const tenant_id = id(input.tenant_id, "tenant_id");
  const project_id = id(input.project_id, "project_id");
  const brief_id = id(input.brief_id, "brief_id");
  if (tenant_id !== trustedScope.tenant_id || project_id !== trustedScope.project_id || brief_id !== trustedScope.brief_id) {
    fail("scope_denied", "scope");
  }
  const composition_id = id(input.composition_id, "composition_id");
  const revision_id = id(input.revision_id, "revision_id");
  const parent_revision_id = input.parent_revision_id === null ? null : id(input.parent_revision_id, "parent_revision_id");
  const parent_revision_sha256 = input.parent_revision_sha256 === null ? null : hash(input.parent_revision_sha256, "parent_revision_sha256");
  if ((parent_revision_id === null) !== (parent_revision_sha256 === null)) fail("invalid_request", "parent_revision");
  const binding = cleanBinding(input.binding, trustedScope);
  if (binding.composition.composition_id !== composition_id || binding.composition.revision_id !== revision_id) {
    fail("invalid_request", "binding.composition");
  }
  const artwork = validateArtifact(input.artwork, binding.design_version.artwork_sha256);
  if (!Array.isArray(input.layer_manifest)) fail("invalid_request", "layer_manifest");
  let layer_manifest;
  try {
    const projection = hashCompositionLayerManifest({ binding, artifact: artwork, layer_manifest: input.layer_manifest, trustedScope });
    if (projection !== binding.composition.sha256) fail("invalid_request", "binding.composition.sha256");
    layer_manifest = snapshotCompositionJson(input.layer_manifest);
  } catch (error) {
    if (error instanceof CreativeCompositionContractError) throw error;
    fail("invalid_request", "layer_manifest");
  }
  const geometry = validateCompositionGeometry(input.geometry, layer_manifest);
  const dependencies = normalizeDependencies(input.dependencies, binding, trustedScope, layer_manifest, nowMs);
  exactKeys(input.preview, ["contract", "schema_version", "preview_id", "preview_sha256", "byte_length",
    "mime_type", "width_px", "height_px", "proof_ref", "state_sha256", "checked_at", "expires_at"], "preview");
  if (input.preview.contract !== "CreativeCompositionPreviewMetadata" || input.preview.schema_version !== "1.1") {
    fail("unsupported_version", "preview.schema_version");
  }
  const preview = Object.freeze({
    contract: input.preview.contract,
    schema_version: input.preview.schema_version,
    preview_id: id(input.preview.preview_id, "preview.preview_id"),
    preview_sha256: hash(input.preview.preview_sha256, "preview.preview_sha256"),
    byte_length: input.preview.byte_length,
    mime_type: input.preview.mime_type,
    width_px: input.preview.width_px,
    height_px: input.preview.height_px,
    proof_ref: id(input.preview.proof_ref, "preview.proof_ref"),
    state_sha256: hash(input.preview.state_sha256, "preview.state_sha256"),
    checked_at: input.preview.checked_at,
    expires_at: input.preview.expires_at,
  });
  assertTimestampWindow(preview.checked_at, preview.expires_at, nowMs, "preview");
  if (!Number.isSafeInteger(preview.byte_length) || preview.byte_length < 1 || preview.byte_length > MAX_PREVIEW_BYTES ||
      !["image/png", "image/jpeg", "image/webp"].includes(preview.mime_type) ||
      !Number.isSafeInteger(preview.width_px) || preview.width_px < 1 || preview.width_px > 16_384 ||
      !Number.isSafeInteger(preview.height_px) || preview.height_px < 1 || preview.height_px > 16_384 ||
      preview.width_px * preview.height_px > 40_000_000 ||
      preview.preview_sha256 !== `sha256:${binding.preview_sha256}` ||
      previewBytes.byteLength !== preview.byte_length ||
      sha256Bytes(previewBytes) !== preview.preview_sha256) fail("integrity_error", "preview");
  const withoutHashes = {
    contract: "CreativeCompositionRevision",
    schema_version: "1.1",
    tenant_id, project_id, brief_id, composition_id, revision_id,
    parent_revision_id, parent_revision_sha256,
    binding, artwork, layer_manifest, geometry, dependencies, preview,
    state_sha256: "",
    revision_sha256: "",
  };
  const state_sha256 = compositionStateHash({ tenant_id, project_id, brief_id, composition_id, revision_id,
    parent_revision_id, parent_revision_sha256, binding, artwork, layer_manifest, geometry, dependencies });
  if (dependencies.authority_proof.state_sha256 !== state_sha256) {
    fail("integrity_error", "dependencies.authority_proof.state_sha256");
  }
  if (preview.state_sha256 !== state_sha256) fail("integrity_error", "preview.state_sha256");
  const preliminary = { ...withoutHashes, state_sha256 };
  const revision_sha256 = revisionDigest(preliminary);
  const created_at = nowMs === undefined ? new Date().toISOString() : new Date(nowMs).toISOString();
  const revision = freezeJson({ ...preliminary, revision_sha256, created_at });
  return Object.freeze({ revision, preview_bytes: Uint8Array.from(previewBytes) });
}

export function validateCompositionRevision(value, { trustedScope, previewBytes, nowMs, allowExpired = false } = {}) {
  const snapshot = snapshotCompositionJson(value);
  exactKeys(snapshot, ["contract", "schema_version", "tenant_id", "project_id", "brief_id", "composition_id", "revision_id",
    "parent_revision_id", "parent_revision_sha256", "binding", "artwork", "layer_manifest", "geometry", "dependencies",
    "preview", "state_sha256", "revision_sha256", "created_at"], "revision");
  if (snapshot.contract !== "CreativeCompositionRevision" || snapshot.schema_version !== "1.1") fail("unsupported_version", "revision.schema_version");
  const { contract: _contract, schema_version: _schema_version, revision_sha256,
    created_at, state_sha256: _state, ...input } = snapshot;
  const computed = createCompositionRevision(input, { trustedScope, previewBytes,
    nowMs: allowExpired ? undefined : nowMs });
  if (computed.revision.state_sha256 !== snapshot.state_sha256 || computed.revision.revision_sha256 !== revision_sha256) {
    fail("integrity_error", "revision.revision_sha256");
  }
  if (typeof created_at !== "string" || !Number.isFinite(Date.parse(created_at))) {
    fail("integrity_error", "revision.created_at");
  }
  return freezeJson({ ...computed.revision, created_at });
}

export function applyCompositionPlan(current, plan, trustedScope) {
  current = snapshotCompositionJson(current);
  plan = snapshotCompositionJson(plan);
  if (!plain(plan) || plan.schema_version !== COMPOSITION_EDIT_PROPOSAL_VERSION ||
      plan.tenant_id !== trustedScope.tenant_id || plan.project_id !== trustedScope.project_id ||
      plan.base_design_version_id !== current.dependencies.design_version_id ||
      plan.base_artwork_sha256 !== current.binding.design_version.artwork_sha256 ||
      plan.base_brief_id !== current.brief_id || plan.base_brief_sha256 !== current.binding.brief.sha256 ||
      plan.base_facts_revision_id !== current.binding.facts.revision_id ||
      plan.base_facts_sha256 !== current.binding.facts.sha256 ||
      plan.base_composition_id !== current.composition_id ||
      plan.base_composition_revision_id !== current.revision_id ||
      plan.base_composition_sha256 !== current.binding.composition.sha256 ||
      plan.approval_required_after_application !== true) fail("stale_version", "plan.base_binding");
  if (!Array.isArray(plan.operations) || plan.operations.length < 1 || plan.operations.length > 100) {
    fail("invalid_request", "plan.operations");
  }
  const layers = snapshotCompositionJson(current.layer_manifest);
  const geometry = snapshotCompositionJson(current.geometry);
  const layerIndex = new Map(layers.map((layer, index) => [layer.layer_id, index]));
  for (const operation of plan.operations) {
    const index = layerIndex.get(operation.layer_id);
    if (index === undefined) fail("integrity_error", "plan.layer_id");
    const layer = layers[index];
    const entry = geometry[index];
    if (current.dependencies.edit_policy.locked_layer_ids.includes(operation.layer_id)) {
      fail("permission_denied", "plan.locked_layer");
    }
    if (operation.kind === "set_text") {
      if (layer.kind !== "text") fail("invalid_request", "plan.kind");
      if (current.dependencies.edit_policy.factual_text_layers.some((item) => item.layer_id === operation.layer_id)) {
        fail("permission_denied", "plan.factual_text");
      }
      layers[index] = { ...layer, value: operation.value };
    } else if (operation.kind === "set_text_size") {
      if (layer.kind !== "text") fail("invalid_request", "plan.kind");
      geometry[index] = { ...entry, text_size: { value: operation.size.value, unit: operation.size.unit } };
    } else if (operation.kind === "set_layer_layout" || operation.kind === "position_approved_logo") {
      if (operation.kind === "position_approved_logo" &&
          (layer.kind !== "approved_asset" || layer.asset_id !== operation.asset_id)) fail("invalid_request", "plan.asset_id");
      if (layer.kind === "approved_asset" && !current.dependencies.asset_rights.some((right) =>
          right.asset_id === layer.asset_id && right.action === "modify")) fail("permission_denied", "plan.asset_rights");
      geometry[index] = { ...entry, layout: operation.layout };
    } else fail("invalid_request", "plan.operation");
  }
  return Object.freeze({ layer_manifest: Object.freeze(layers), geometry: validateCompositionGeometry(geometry, layers),
    revision_id: id(plan.target_composition_revision_id, "plan.target_composition_revision_id") });
}

export function createCompositionProductionEnvelope(revision) {
  const { created_at: _created_at, ...state } = snapshotCompositionJson(revision);
  return freezeJson({ contract: CREATIVE_COMPOSITION_PRODUCTION_CONTRACT,
    schema_version: CREATIVE_COMPOSITION_AUTHORITY_VERSION, revision: state });
}

export function validateCompositionProductionEnvelope(value, { trustedScope, previewBytes } = {}) {
  const snapshot = snapshotCompositionJson(value);
  exactKeys(snapshot, ["contract", "schema_version", "revision"], "production_envelope");
  if (snapshot.contract !== CREATIVE_COMPOSITION_PRODUCTION_CONTRACT ||
      snapshot.schema_version !== CREATIVE_COMPOSITION_AUTHORITY_VERSION) fail("unsupported_version", "production_envelope.schema_version");
  const revision = validateCompositionRevision({ ...snapshot.revision, created_at: new Date(0).toISOString() },
    { trustedScope, previewBytes, allowExpired: true });
  return freezeJson({ contract: snapshot.contract, schema_version: snapshot.schema_version,
    revision: Object.fromEntries(Object.entries(revision).filter(([key]) => key !== "created_at")) });
}

export function compositionPreviewHash(bytes) {
  if (!(bytes instanceof Uint8Array)) fail("invalid_request", "preview_bytes");
  return sha256Bytes(bytes);
}
