import { inflateSync } from "node:zlib";
import { validateCreativeBrief, validateDesignVersion } from "../contracts/creative/v1.mjs";
import { canonicalHash } from "../contracts/validation.mjs";
import { hashArtifactBytes } from "../storage/content-addressed.mjs";

export const INSPECTION_LIMITS = Object.freeze({
  maxArtifactBytes: 20 * 1024 * 1024,
  maxDimension: 20_000,
  maxPixels: 40_000_000,
  maxPngInflatedBytes: 160 * 1024 * 1024,
  maxUsedAssets: 64,
});

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CONTRACT = "CreativeDeterministicInspection";
const SAFE_MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "buffer").get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteOffset").get;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteLength").get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const UNCERTAINTY_NOTES = new Set(["low_confidence", "not_independently_measured", "observation_conflict", "source_age_unknown"]);
const ARTIFACT_SNAPSHOTS = new WeakMap();
const VALIDATED_OBSERVATIONS = new WeakSet();

/** Internal authenticity check shared by the inspection submodules. */
export function isInspectionHandle(value) {
  return value !== null && typeof value === "object" && ARTIFACT_SNAPSHOTS.has(value);
}

export function isSafePublicInspectionReference(value) {
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value)) return false;
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return !/(?:credential|token|secret|password|apikey|authorization|bearer|cookie)/.test(normalized) &&
    !/(?:sk|rk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i.test(value) &&
    !/^(?:bearer|basic)(?:$|[-_:])/i.test(value) &&
    !/[A-Za-z][A-Za-z0-9+.-]*:\/\//i.test(value);
}

function isSafePublicInspectionMediaType(value) {
  return typeof value === "string" && SAFE_MEDIA_TYPE.test(value) && isSafePublicInspectionReference(value);
}

export class InspectionError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "InspectionError";
    this.code = code;
    this.contract = CONTRACT;
    this.field = field;
  }
}

function fail(code, field, message) {
  // Validation paths occasionally include an input object key (for example
  // while snapshotting nested arrays). Never echo credential-shaped keys or
  // values in the public error envelope.
  const comparableField = typeof field === "string"
    ? field.replace(/\[\d+\]/g, "").replaceAll("_", "-")
    : "";
  const publicField = comparableField.length <= 200 && isSafePublicInspectionReference(comparableField)
    ? field
    : "inspection.input";
  throw new InspectionError(code, publicField, message);
}

function plainRecord(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("invalid_type", field, "Expected a plain object.");
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("invalid_type", field, "Plain contract objects cannot contain hidden, symbolic, or accessor properties.");
    }
  }
  return value;
}

export function copyBoundedPlainArray(value, field, maximumLength) {
  if (!Array.isArray(value)) fail("invalid_type", field, "Expected a plain array.");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) {
    fail("out_of_bounds", field, "Array length is outside the bounded contract.");
  }
  const allowedKeys = new Set(["length"]);
  const copied = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("invalid_type", field, "Arrays must be dense data-only values without accessors.");
    }
    allowedKeys.add(key);
    copied[index] = descriptor.value;
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
    fail("invalid_type", field, "Arrays cannot contain symbols or custom properties.");
  }
  return copied;
}

export function snapshotPlainRecord(value, field) {
  const budget = { nodes: 0, active: new WeakSet() };
  const copy = (item, path, depth) => {
    budget.nodes += 1;
    if (budget.nodes > 50_000 || depth > 32) fail("out_of_bounds", field, "Nested contract input exceeds the structural limit.");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (Buffer.byteLength(item, "utf8") > 64 * 1024) fail("out_of_bounds", field, "Contract string exceeds the input limit.");
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("invalid_type", field, "Contract numbers must be finite.");
      return item;
    }
    if (typeof item !== "object" || item === null || budget.active.has(item)) {
      fail("invalid_type", field, "Contract input must be acyclic JSON data.");
    }
    budget.active.add(item);
    try {
      if (Array.isArray(item)) {
        return copyBoundedPlainArray(item, path, 10_000).map((entry, index) => copy(entry, `${path}[${index}]`, depth + 1));
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) fail("invalid_type", field, "Contract objects must be plain records.");
      const target = Object.create(null);
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail("invalid_type", field, "Contract records cannot contain hidden, symbolic, or accessor properties.");
        }
        Object.defineProperty(target, key, { value: copy(descriptor.value, `${path}.${key}`, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return target;
    } finally {
      budget.active.delete(item);
    }
  };
  const result = copy(value, field, 0);
  if (result === null || typeof result !== "object" || Array.isArray(result)) fail("invalid_type", field, "Expected a plain object.");
  return result;
}

function cloneBytes(value) {
  const length = TYPED_ARRAY_BYTE_LENGTH.call(value);
  const source = new Uint8Array(TYPED_ARRAY_BUFFER.call(value), TYPED_ARRAY_BYTE_OFFSET.call(value), length);
  const copy = new Uint8Array(length);
  TYPED_ARRAY_SET.call(copy, source);
  return copy;
}

function safeBytes(value) {
  let byteLength;
  try { byteLength = TYPED_ARRAY_BYTE_LENGTH.call(value); } catch { byteLength = -1; }
  if (!(value instanceof Uint8Array) || byteLength === 0 || byteLength < 0 || byteLength > INSPECTION_LIMITS.maxArtifactBytes) {
    fail("invalid_bytes", "artifact_bytes", "Artifact bytes are empty or exceed the bounded inspection size.");
  }
  try {
    // Copy through typed-array intrinsics so Buffer subclasses cannot choose the clone type.
    return cloneBytes(value);
  } catch {
    fail("invalid_bytes", "artifact_bytes", "Artifact bytes could not be safely snapshotted.");
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function decodePng(bytes) {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (input.length < 45 || !PNG_SIGNATURE.every((byte, index) => input[index] === byte)) {
    fail("image_decode_failed", "artifact_bytes", "PNG signature or minimum structure is invalid.");
  }

  let offset = PNG_SIGNATURE.length;
  let header = null;
  let paletteSeen = false;
  let paletteEntries = 0;
  let idatStarted = false;
  let idatEnded = false;
  let endSeen = false;
  const idat = [];
  let compressedLength = 0;

  while (offset < input.length) {
    if (offset + 12 > input.length) fail("image_decode_failed", "artifact_bytes", "PNG chunk is truncated.");
    const length = input.readUInt32BE(offset);
    const typeBytes = input.subarray(offset + 4, offset + 8);
    if ([...typeBytes].some((byte) => !((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)))) {
      fail("image_decode_failed", "artifact_bytes", "PNG chunk type must use four ASCII letters.");
    }
    const type = typeBytes.toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const nextOffset = dataEnd + 4;
    if (!/^[A-Za-z]{4}$/.test(type) || length > INSPECTION_LIMITS.maxArtifactBytes || nextOffset > input.length) {
      fail("image_decode_failed", "artifact_bytes", "PNG chunk length or type is invalid.");
    }
    const expectedCrc = input.readUInt32BE(dataEnd);
    if (crc32(input.subarray(offset + 4, dataEnd)) !== expectedCrc) {
      fail("image_decode_failed", "artifact_bytes", "PNG chunk checksum is invalid.");
    }
    const data = input.subarray(dataStart, dataEnd);

    if (!header && type !== "IHDR") fail("image_decode_failed", "artifact_bytes", "PNG must begin with IHDR.");
    if (type === "IHDR") {
      if (header || offset !== PNG_SIGNATURE.length || length !== 13) {
        fail("image_decode_failed", "artifact_bytes", "PNG IHDR placement or size is invalid.");
      }
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
      const supportedDepths = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })[colorType];
      if (!width || !height || width > INSPECTION_LIMITS.maxDimension || height > INSPECTION_LIMITS.maxDimension ||
        width * height > INSPECTION_LIMITS.maxPixels || !channels || !supportedDepths.includes(bitDepth) ||
        data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        fail("image_decode_failed", "artifact_dimensions", "PNG dimensions or encoding parameters are unsupported.");
      }
      header = { width, height, bitDepth, colorType, channels };
    } else if (type === "PLTE") {
      const entryCount = length / 3;
      const indexedMaximum = header?.colorType === 3 ? 2 ** header.bitDepth : 256;
      if (idatStarted || paletteSeen || length === 0 || length % 3 !== 0 || length > 768 || entryCount > indexedMaximum) {
        fail("image_decode_failed", "artifact_bytes", "PNG palette placement or size is invalid.");
      }
      paletteSeen = true;
      paletteEntries = entryCount;
    } else if (type === "IDAT") {
      if (idatEnded || (header.colorType === 3 && !paletteSeen)) {
        fail("image_decode_failed", "artifact_bytes", "PNG image data ordering is invalid.");
      }
      idatStarted = true;
      compressedLength += length;
      if (compressedLength > INSPECTION_LIMITS.maxArtifactBytes) {
        fail("image_decode_failed", "artifact_bytes", "PNG compressed image data exceeds the limit.");
      }
      idat.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !idatStarted || endSeen || nextOffset !== input.length) {
        fail("image_decode_failed", "artifact_bytes", "PNG end marker placement is invalid.");
      }
      endSeen = true;
      offset = nextOffset;
      break;
    } else {
      if (idatStarted) idatEnded = true;
      // Unknown critical chunks change decoding semantics; do not guess.
      if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90 && type !== "IHDR") {
        fail("image_decode_failed", "artifact_bytes", "PNG contains an unsupported critical chunk.");
      }
    }
    if (type !== "IDAT" && idatStarted) idatEnded = true;
    offset = nextOffset;
  }
  if (!header || !endSeen || idat.length === 0) fail("image_decode_failed", "artifact_bytes", "PNG is missing required image data.");

  const rowBytes = Math.ceil(header.width * header.channels * header.bitDepth / 8);
  const expectedInflated = (rowBytes + 1) * header.height;
  if (!Number.isSafeInteger(expectedInflated) || expectedInflated > INSPECTION_LIMITS.maxPngInflatedBytes) {
    fail("image_decode_failed", "artifact_dimensions", "Decoded PNG exceeds the bounded pixel buffer size.");
  }
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat, compressedLength), { maxOutputLength: expectedInflated });
  } catch {
    fail("image_decode_failed", "artifact_bytes", "PNG compressed image data is invalid.");
  }
  if (raw.length !== expectedInflated) fail("image_decode_failed", "artifact_bytes", "PNG decoded scanline length is invalid.");

  const bytesPerPixel = Math.max(1, Math.ceil(header.channels * header.bitDepth / 8));
  let prior = Buffer.alloc(rowBytes);
  let sourceOffset = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[sourceOffset];
    if (filter > 4) fail("image_decode_failed", "artifact_bytes", "PNG scanline filter is invalid.");
    sourceOffset += 1;
    const row = Buffer.from(raw.subarray(sourceOffset, sourceOffset + rowBytes));
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = prior[x] ?? 0;
      const upLeft = x >= bytesPerPixel ? (prior[x - bytesPerPixel] ?? 0) : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up :
        filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upLeft);
      row[x] = (row[x] + predictor) & 0xff;
    }
    if (header.colorType === 3) {
      for (let x = 0; x < header.width; x += 1) {
        const sample = header.bitDepth === 8 ? row[x] :
          (row[Math.floor(x * header.bitDepth / 8)] >> (8 - header.bitDepth - ((x * header.bitDepth) % 8))) & (2 ** header.bitDepth - 1);
        if (sample >= paletteEntries) {
          fail("image_decode_failed", "artifact_bytes", "Indexed PNG pixel refers to a palette entry that does not exist.");
        }
      }
    }
    prior = row;
    sourceOffset += rowBytes;
  }
  return Object.freeze({ format: "png", width: header.width, height: header.height, decoded_scanlines: header.height });
}

function checkRecord(id, status, reason = undefined) {
  return Object.freeze({ id, status, ...(reason ? { reason } : {}) });
}

function validateUsedAssets(brief, usedAssets) {
  const assetList = copyBoundedPlainArray(usedAssets, "used_assets", INSPECTION_LIMITS.maxUsedAssets);
  const seen = new Set();
  const permissions = brief.permissions;
  const permissionItems = copyBoundedPlainArray(permissions.items, "brief.permissions.items", 10_000);
  return assetList.map((asset) => {
    plainRecord(asset, "used_assets");
    const allowed = ["asset_id", "action"];
    if (Object.keys(asset).some((key) => !allowed.includes(key)) || typeof asset.asset_id !== "string" ||
      !["reproduce", "modify", "publish", "display"].includes(asset.action)) {
      fail("invalid_references", "used_assets", "Used asset reference shape is invalid.");
    }
    const identity = `${asset.asset_id}\u0000${asset.action}`;
    if (seen.has(identity)) fail("invalid_references", "used_assets", "Used asset references must be unique.");
    seen.add(identity);
    if (permissions.presence !== "present") {
      return checkRecord("asset_permission", "unknown", "permission_records_unavailable");
    }
    const matches = permissionItems.filter((permission) => permission.asset_id === asset.asset_id && permission.action === asset.action);
    if (matches.length !== 1 || matches[0].status !== "granted" || matches[0].evidence_refs.length === 0) {
      return checkRecord("asset_permission", matches.some((match) => match.status === "denied") ? "fail" : "unknown",
        matches.some((match) => match.status === "denied") ? "permission_denied" : "permission_not_verified");
    }
    return checkRecord("asset_permission", "pass");
  });
}

/**
 * Snapshot and structurally decode a PNG, then bind it to the trusted brief,
 * version, and explicitly supplied trusted asset-use set. No model decision
 * can change these checks.
 */
export function inspectCreativeArtifact(input) {
  plainRecord(input, "input");
  const trustedScope = snapshotPlainRecord(plainRecord(input.trusted_scope, "trusted_scope"), "trusted_scope");
  const briefInput = snapshotPlainRecord(plainRecord(input.brief, "brief"), "brief");
  const designInput = snapshotPlainRecord(plainRecord(input.design_version, "design_version"), "design_version");
  const parentInput = input.parent_design === undefined ? undefined : snapshotPlainRecord(plainRecord(input.parent_design, "parent_design"), "parent_design");
  let brief;
  let design;
  try {
    brief = validateCreativeBrief(briefInput, { trustedScope });
    const designScope = trustedScope.design_version_id === undefined
      ? { ...trustedScope, design_version_id: designInput.design_version_id }
      : trustedScope;
    design = validateDesignVersion(designInput, {
      trustedScope: designScope,
      brief_hash: canonicalHash(brief),
      known_source_refs: copyBoundedPlainArray(brief.source_identity, "brief.source_identity", 10_000).map((source) => source.source_id),
    });
  } catch {
    fail("subject_invalid", "subject", "Brief or design version failed trusted scope and reference validation.");
  }

  // C01 validates identity shape, not whether an opaque identifier is safe to
  // expose in inspection output. Keep the exact identity when it is safe, but
  // reject credential-shaped references before they enter public handles or
  // reports. Use one fixed diagnostic path so an unsafe value cannot escape
  // through an error field.
  const publicSubjectReferences = [
    trustedScope.tenant_id,
    trustedScope.project_id,
    brief.brief_id,
    design.design_version_id,
    design.artifact.artifact_id,
  ];
  if (publicSubjectReferences.some((reference) => !isSafePublicInspectionReference(reference))) {
    fail("invalid_references", "subject.identity", "A subject identity is not safe for public inspection output.");
  }
  // Keep the exact C01 media_type for hash/subject identity, but only emit it
  // when it is a bounded MIME token and safe public reference. Safe, unknown
  // media types remain visible as review-only; private values fail closed.
  const publicMediaType = design.artifact.media_type;
  if (!isSafePublicInspectionMediaType(publicMediaType)) {
    fail("invalid_references", "subject.media_type", "Artifact media type is not safe for public inspection output.");
  }

  let parentDesignHash = null;
  if (design.parent_version_id !== null) {
    if (!parentInput) fail("invalid_references", "parent_design", "A trusted parent version is required for a non-root inspection.");
    if (!Object.hasOwn(input, "parent_design_hash") || typeof input.parent_design_hash !== "string") {
      fail("invalid_references", "parent_design_hash", "A non-root inspection requires the trusted expected parent hash.");
    }
    try {
      const { artifact_id: _childArtifactId, ...parentScope } = trustedScope;
      const parent = validateDesignVersion(parentInput, {
        // The child artifact ID is not a trusted parent artifact reference.
        // The immutable child does bind the exact parent version ID, while
        // the parent's own artifact and content hash are validated below.
        trustedScope: { ...parentScope, design_version_id: design.parent_version_id },
        brief_hash: canonicalHash(brief),
        known_source_refs: copyBoundedPlainArray(brief.source_identity, "brief.source_identity", 10_000).map((source) => source.source_id),
      });
      if (parent.design_version_id !== design.parent_version_id) throw new Error("parent mismatch");
      parentDesignHash = parent.design_hash;
    } catch {
      fail("invalid_references", "parent_design", "Trusted parent version failed scope, hash, or lineage validation.");
    }
  } else if (parentInput !== undefined) {
    fail("invalid_references", "parent_design", "Root design versions cannot declare a parent version.");
  }
  if (input.parent_design_hash !== undefined && input.parent_design_hash !== parentDesignHash) {
    fail("stale_version", "parent_design_hash", "Parent hash does not match the validated immutable parent version.");
  }

  const bytes = safeBytes(input.artifact_bytes);
  const actualHash = hashArtifactBytes(bytes);
  const hashMatches = actualHash === design.artifact.content_hash;
  const checks = [checkRecord("artifact_hash", hashMatches ? "pass" : "fail", hashMatches ? undefined : "hash_mismatch")];
  let decoderResult = null;
  if (input.decoder_result !== undefined) {
    try { decoderResult = snapshotPlainRecord(plainRecord(input.decoder_result, "decoder_result"), "decoder_result"); }
    catch { decoderResult = null; }
    if (decoderResult && Object.keys(decoderResult).some((key) => ![
      "contract", "schema_version", "status", "artifact_hash", "format", "width", "height", "has_alpha", "has_transparency",
    ].includes(key))) decoderResult = null;
  }
  const selectedDecodeValid = decoderResult?.contract === "OpenAIBoundedImageDecode" &&
    decoderResult.schema_version === "1.0" && decoderResult.status === "pass" && decoderResult.artifact_hash === actualHash &&
    decoderResult.format === ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" })[publicMediaType] &&
    Number.isSafeInteger(decoderResult.width) && decoderResult.width > 0 && decoderResult.width <= INSPECTION_LIMITS.maxDimension &&
    Number.isSafeInteger(decoderResult.height) && decoderResult.height > 0 && decoderResult.height <= INSPECTION_LIMITS.maxDimension &&
    decoderResult.width * decoderResult.height <= INSPECTION_LIMITS.maxPixels &&
    typeof decoderResult.has_alpha === "boolean" && typeof decoderResult.has_transparency === "boolean";
  let dimensions = null;
  let decodeError = null;
  let decodeStatus = "fail";
  if (publicMediaType === "image/png") {
    try {
      dimensions = decodePng(bytes);
      decodeStatus = "pass";
      // The local policy parser independently checks the PNG structure and
      // dimensions. Pixel alpha/transparency comes from the trusted shared
      // decoder bound to the same byte hash; this parser intentionally does
      // not duplicate that pixel-level metadata walk.
      if (input.decoder_result !== undefined && (!selectedDecodeValid || decoderResult.width !== dimensions.width ||
        decoderResult.height !== dimensions.height)) {
        dimensions = null;
        decodeError = decoderResult?.status === "unknown" ? "image_decoder_unavailable" : "image_decoder_mismatch";
        decodeStatus = decoderResult?.status === "unknown" ? "unknown" : "fail";
      }
    } catch (error) {
      decodeError = error instanceof InspectionError ? error.code : "image_decode_failed";
    }
  } else if (publicMediaType === "image/jpeg" || publicMediaType === "image/webp") {
    // JPEG and WebP use the same bounded native decoder as the provider
    // adapter. The runtime supplies only its immediately verified metadata,
    // bound to this byte snapshot's content hash. A missing or mismatched
    // decoder result remains unknown and can never become eligible.
    const expectedFormat = publicMediaType === "image/jpeg" ? "jpeg" : "webp";
    if (selectedDecodeValid && decoderResult.format === expectedFormat) {
      dimensions = Object.freeze({ width: decoderResult.width, height: decoderResult.height, format: expectedFormat,
        has_alpha: decoderResult.has_alpha, has_transparency: decoderResult.has_transparency });
      decodeStatus = "pass";
    } else if (decoderResult === null) {
      decodeError = "unsupported_media_type";
      decodeStatus = "unknown";
    } else if (decoderResult?.status === "fail") {
      decodeError = "image_decode_failed";
      decodeStatus = "fail";
    } else {
      decodeError = "image_decode_unverified";
      decodeStatus = "unknown";
    }
  } else {
    decodeError = "unsupported_media_type";
    decodeStatus = "unknown";
  }
  checks.push(checkRecord("artifact_decode", decodeStatus, decodeError ?? undefined));
  if (dimensions) {
    checks.push(checkRecord("artifact_dimensions", "pass"));
  } else {
    checks.push(checkRecord("artifact_dimensions", decodeStatus === "unknown" ? "unknown" : "fail", decodeError ?? "image_decode_failed"));
  }

  const knownSourceIds = new Set(copyBoundedPlainArray(brief.source_identity, "brief.source_identity", 10_000).map((source) => source.source_id));
  const designSourceRefs = copyBoundedPlainArray(design.source_refs, "design_version.source_refs", 10_000);
  const sourceRefsValid = designSourceRefs.every((sourceRef) => knownSourceIds.has(sourceRef));
  checks.push(checkRecord("source_references", sourceRefsValid ? "pass" : "fail", sourceRefsValid ? undefined : "unknown_source"));
  const unresolvedFacts = copyBoundedPlainArray(brief.facts.unresolved, "brief.facts.unresolved", 10_000);
  checks.push(checkRecord("brief_facts", unresolvedFacts.length === 0 ? "pass" : "unknown",
    unresolvedFacts.length === 0 ? undefined : "unresolved_facts_present"));
  if (!Object.hasOwn(input, "used_assets")) fail("invalid_references", "used_assets", "The complete trusted asset-use set must be explicit.");
  const assetUseStatus = input.asset_use_evidence_status ?? "verified";
  if (!["verified", "unknown"].includes(assetUseStatus)) fail("invalid_references", "asset_use_evidence_status");
  const assetChecks = assetUseStatus === "unknown"
    ? [checkRecord("asset_permission", "unknown", "asset_use_evidence_unavailable")]
    : validateUsedAssets(brief, input.used_assets);
  checks.push(...assetChecks);

  const failed = checks.some((check) => check.status === "fail");
  const unknown = checks.some((check) => check.status === "unknown");
  const gate = failed ? "failure" : unknown ? "needs_human_review" : "eligible";
  const eligibleActions = gate === "eligible" ? validateEligibleActions(input.eligible_repair_actions ?? []) : [];
  const result = Object.freeze({
    contract: "CreativeDeterministicInspection",
    schema_version: "1.0",
    tenant_id: trustedScope.tenant_id,
    project_id: trustedScope.project_id,
    brief_id: brief.brief_id,
    brief_hash: canonicalHash(brief),
    design_version_id: design.design_version_id,
    design_hash: design.design_hash,
    parent_design_hash: parentDesignHash,
    artifact_id: design.artifact.artifact_id,
    artifact_hash: design.artifact.content_hash,
    actual_artifact_hash: actualHash,
    media_type: publicMediaType,
    dimensions,
    checks: Object.freeze(checks),
    gate,
    eligible_repair_actions: Object.freeze(eligibleActions),
  });
  ARTIFACT_SNAPSHOTS.set(result, bytes);
  return result;
}

/** Return a fresh byte copy from a trusted inspection handle for an injected decoder/observer. */
export function copyInspectionArtifactBytes(deterministic) {
  const snapshot = deterministic && ARTIFACT_SNAPSHOTS.get(deterministic);
  if (!snapshot) fail("invalid_request", "deterministic", "Artifact bytes are available only from an inspection handle created in this module.");
  return cloneBytes(snapshot);
}

const REPAIR_ACTIONS = new Set(["image.edit", "composition.update", "correction.apply", "concept.generate"]);

function validateEligibleActions(actions) {
  const candidates = copyBoundedPlainArray(actions, "eligible_repair_actions", 4);
  const unique = new Set();
  for (const action of candidates) {
    if (!REPAIR_ACTIONS.has(action) || unique.has(action)) fail("invalid_references", "eligible_repair_actions", "Eligible repair actions must be unique allowlisted actions.");
    unique.add(action);
  }
  return [...unique];
}

/** Bind a separately sourced observation to the exact creative records. */
export function validateVisualObservation(value, deterministic) {
  plainRecord(value, "observation");
  plainRecord(deterministic, "deterministic");
  if (!isInspectionHandle(deterministic)) {
    fail("invalid_request", "deterministic", "A deterministic inspection handle from this module is required.");
  }
  const allowed = ["contract", "schema_version", "tenant_id", "project_id", "brief_id", "design_version_id",
    "artifact_id", "brief_hash", "parent_design_hash", "design_hash", "artifact_hash", "observation_id",
    "observed_at", "observer", "source", "uncertainty", "findings", "usage"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("invalid_observation", "observation", "Observation has unsupported fields.");
  if (value.contract !== "CreativeVisualObservation" || value.schema_version !== "1.0") {
    fail("unsupported_version", "observation.schema_version", "Unsupported visual observation version.");
  }
  for (const key of ["tenant_id", "project_id", "brief_id", "design_version_id", "artifact_id", "brief_hash", "design_hash", "artifact_hash"]) {
    if (value[key] !== deterministic[key]) fail("stale_observation", "observation.binding", "Observation is bound to a different creative record.");
  }
  if ((value.parent_design_hash ?? null) !== (deterministic.parent_design_hash ?? null)) {
    fail("stale_observation", "observation.parent_design_hash", "Observation parent hash does not match the inspected design.");
  }
  if (!isSafePublicInspectionReference(value.observation_id)) {
    fail("invalid_observation", "observation.observation_id", "Observation identity is invalid.");
  }
  if (typeof value.observed_at !== "string" || !Number.isFinite(Date.parse(value.observed_at)) || !/^\d{4}-\d\d-\d\dT/.test(value.observed_at)) {
    fail("invalid_observation", "observation.observed_at", "Observation time must be an ISO date-time.");
  }
  plainRecord(value.observer, "observation.observer");
  if (Object.keys(value.observer).some((key) => !["type", "id", "model_id", "config_ref"].includes(key)) ||
    !["human", "model", "system"].includes(value.observer.type) || !isSafePublicInspectionReference(value.observer.id)) {
    fail("invalid_observation", "observation.observer", "Observer identity is invalid.");
  }
  if ((value.observer.model_id !== undefined && !isSafePublicInspectionReference(value.observer.model_id)) ||
    (value.observer.config_ref !== undefined && (typeof value.observer.config_ref !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.observer.config_ref)))) {
    fail("invalid_observation", "observation.observer", "Optional observer metadata must be safe bounded public references.");
  }
  if (value.observer.type === "model" && (!isSafePublicInspectionReference(value.observer.model_id) || typeof value.observer.config_ref !== "string")) {
    fail("invalid_observation", "observation.observer", "Model observations require model and configuration provenance.");
  }
  if (value.observer.config_ref !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.observer.config_ref)) {
    fail("invalid_observation", "observation.observer.config_ref", "Configuration reference must be a content hash.");
  }
  plainRecord(value.source, "observation.source");
  if (Object.keys(value.source).some((key) => !["kind", "source_ref"].includes(key)) ||
    !["vision_model", "human_review", "deterministic_check"].includes(value.source.kind) ||
    typeof value.source.source_ref !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.source.source_ref)) {
    fail("invalid_observation", "observation.source", "Observation source must be a separately scoped content reference.");
  }
  plainRecord(value.uncertainty, "observation.uncertainty");
  if (Object.keys(value.uncertainty).some((key) => !["status", "note"].includes(key)) ||
    !["measured", "not_measured", "unknown"].includes(value.uncertainty.status) ||
    (value.uncertainty.note !== undefined && !UNCERTAINTY_NOTES.has(value.uncertainty.note))) {
    fail("invalid_observation", "observation.uncertainty", "Observation uncertainty is invalid.");
  }
  const suppliedFindings = copyBoundedPlainArray(value.findings, "observation.findings", 32);
  const allowedCodes = new Set(["wrong_subject", "mask_drift", "text_mismatch", "crop_issue", "layout_issue", "brand_mark", "other_visual_defect"]);
  const findings = suppliedFindings.map((finding) => {
    plainRecord(finding, "observation.findings");
    if (Object.keys(finding).some((key) => !["code", "status", "severity", "confidence", "region"].includes(key)) ||
      !allowedCodes.has(finding.code) || !["present", "absent", "uncertain"].includes(finding.status) ||
      !["info", "low", "moderate", "high", "critical"].includes(finding.severity) ||
      (finding.confidence !== undefined && (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1))) {
      fail("invalid_observation", "observation.findings", "Structured visual finding is invalid.");
    }
    if (finding.region !== undefined) {
      plainRecord(finding.region, "observation.findings.region");
      const keys = Object.keys(finding.region);
      if (keys.length !== 4 || keys.some((key) => !["x", "y", "width", "height"].includes(key)) ||
        [finding.region.x, finding.region.y, finding.region.width, finding.region.height].some((number) =>
          typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 1) ||
        finding.region.x + finding.region.width > 1 || finding.region.y + finding.region.height > 1) {
        fail("invalid_observation", "observation.findings.region", "Finding region must be normalized to the image bounds.");
      }
    }
    return Object.freeze({ ...finding, ...(finding.region ? { region: Object.freeze({ ...finding.region }) } : {}) });
  });
  plainRecord(value.usage, "observation.usage");
  if (Object.keys(value.usage).some((key) => !["completeness", "usage_ref", "input_tokens", "output_tokens"].includes(key)) ||
    !["complete", "partial", "unknown"].includes(value.usage.completeness) ||
    (value.usage.usage_ref !== undefined && (typeof value.usage.usage_ref !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.usage.usage_ref))) ||
    [value.usage.input_tokens, value.usage.output_tokens].some((number) => number !== undefined && (!Number.isSafeInteger(number) || number < 0)) ||
    (value.usage.completeness === "complete" && (!Number.isSafeInteger(value.usage.input_tokens) || !Number.isSafeInteger(value.usage.output_tokens)))) {
    fail("invalid_observation", "observation.usage", "Observation usage provenance is malformed or incomplete.");
  }
  const validated = Object.freeze({
    contract: "CreativeVisualObservation",
    schema_version: "1.0",
    tenant_id: value.tenant_id,
    project_id: value.project_id,
    brief_id: value.brief_id,
    design_version_id: value.design_version_id,
    artifact_id: value.artifact_id,
    brief_hash: value.brief_hash,
    parent_design_hash: value.parent_design_hash ?? null,
    design_hash: value.design_hash,
    artifact_hash: value.artifact_hash,
    observation_id: value.observation_id,
    observed_at: value.observed_at,
    observer: Object.freeze({ ...value.observer }),
    source: Object.freeze({ ...value.source }),
    uncertainty: Object.freeze({ ...value.uncertainty }),
    findings: Object.freeze(findings),
    usage: Object.freeze({ ...value.usage }),
  });
  VALIDATED_OBSERVATIONS.add(validated);
  return validated;
}

export function deterministicDecisionObservation(observation) {
  if (!observation || typeof observation !== "object" || !VALIDATED_OBSERVATIONS.has(observation)) {
    fail("invalid_observation", "observation", "A validated visual observation is required.");
  }
  return Object.freeze({
    observer: Object.freeze({ type: observation.observer.type, id: observation.observer.id }),
    content_hash: observation.artifact_hash,
    uncertainty: Object.freeze({ status: observation.uncertainty.status,
      ...(observation.uncertainty.note ? { note: observation.uncertainty.note } : {}) }),
    // Only generated enum codes cross into the DecisionPort; observer prose and image bytes never do.
    summary: observation.findings.map(({ code, status, severity }) => `${code}:${status}:${severity}`).join("; ") || "no_structured_findings",
    source_ref: observation.source.source_ref,
  });
}

export function canonicalInspectionSubjectHash(deterministic) {
  if (!isInspectionHandle(deterministic)) fail("invalid_request", "deterministic", "A genuine inspection handle is required.");
  return canonicalHash({
    tenant_id: deterministic.tenant_id,
    project_id: deterministic.project_id,
    brief_id: deterministic.brief_id,
    brief_hash: deterministic.brief_hash,
    design_version_id: deterministic.design_version_id,
    design_hash: deterministic.design_hash,
    artifact_id: deterministic.artifact_id,
    artifact_hash: deterministic.artifact_hash,
    parent_design_hash: deterministic.parent_design_hash,
  });
}
