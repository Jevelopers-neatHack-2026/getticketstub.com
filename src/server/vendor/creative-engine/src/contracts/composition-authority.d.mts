import type { ApprovalBinding, HandoffArtifact, HandoffLayer } from "./approval-handoff.mjs";
import type { TrustedScope } from "./creative/v1.mjs";

export type CreativeCompositionSha256 = `sha256:${string}`;
export type CreativeCompositionLayout = Readonly<{
  x_milli: number;
  y_milli: number;
  width_milli?: number;
  height_milli?: number;
}> | null;
export type CreativeCompositionTextSize = Readonly<{ value: string; unit: "pt" | "px" }> | null;
export interface CreativeCompositionGeometryEntry {
  readonly layer_id: string;
  readonly layout: CreativeCompositionLayout;
  readonly text_size: CreativeCompositionTextSize;
}
export interface CreativeCompositionAssetRight {
  readonly asset_id: string;
  readonly action: "display" | "modify" | "reproduce";
  readonly source_ref: string;
  readonly content_hash: CreativeCompositionSha256;
  readonly package_id: string;
  readonly package_hash: CreativeCompositionSha256;
  readonly permission_ref: string;
  readonly intended_use: string;
  readonly evidence_ref: string;
  readonly checked_at: number;
  readonly expires_at: number;
}
export interface CreativeCompositionEditPolicy {
  readonly contract: "CreativeCompositionEditPolicy";
  readonly schema_version: "1.0";
  readonly policy_ref: string;
  readonly policy_version: string;
  readonly policy_sha256: CreativeCompositionSha256;
  readonly brief_hash: CreativeCompositionSha256;
  readonly facts_revision_id: string;
  readonly facts_sha256: CreativeCompositionSha256;
  readonly package_id: string;
  readonly package_sha256: CreativeCompositionSha256;
  readonly design_version_id: string;
  /** Full immutable DesignVersion.design_hash, distinct from artifact bytes. */
  readonly design_version_sha256: CreativeCompositionSha256;
  /** Content hash of the selected artwork bytes. */
  readonly artwork_sha256: CreativeCompositionSha256;
  readonly selection_revision: number;
  readonly locked_layer_ids: readonly string[];
  readonly factual_text_layers: readonly Readonly<{
    layer_id: string;
    fact_id: string;
    fact_sha256: CreativeCompositionSha256;
    text_sha256: CreativeCompositionSha256;
  }>[];
  readonly checked_at: number;
  readonly expires_at: number;
}
export interface CreativeCompositionDependencies {
  readonly brief_hash: CreativeCompositionSha256;
  readonly facts_revision_id: string;
  readonly facts_sha256: CreativeCompositionSha256;
  readonly package_id: string;
  readonly package_sha256: CreativeCompositionSha256;
  readonly design_version_id: string;
  readonly design_version_sha256: CreativeCompositionSha256;
  readonly artwork_sha256: CreativeCompositionSha256;
  readonly parent_version_id: string | null;
  readonly parent_design_hash: CreativeCompositionSha256 | null;
  readonly selection_revision: number;
  readonly asset_rights: readonly CreativeCompositionAssetRight[];
  readonly edit_policy: CreativeCompositionEditPolicy;
  readonly authority_proof: Readonly<{
    proof_ref: string;
    state_sha256: CreativeCompositionSha256;
    checked_at: number;
    expires_at: number;
  }>;
}
export interface CreativeCompositionPreview {
  readonly contract: "CreativeCompositionPreviewMetadata";
  readonly schema_version: "1.1";
  readonly preview_id: string;
  readonly preview_sha256: CreativeCompositionSha256;
  readonly byte_length: number;
  readonly mime_type: "image/png" | "image/jpeg" | "image/webp";
  readonly width_px: number;
  readonly height_px: number;
  readonly proof_ref: string;
  readonly state_sha256: CreativeCompositionSha256;
  readonly checked_at: number;
  readonly expires_at: number;
}
export interface CreativeCompositionRevision {
  readonly contract: "CreativeCompositionRevision";
  readonly schema_version: "1.1";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly composition_id: string;
  readonly revision_id: string;
  readonly parent_revision_id: string | null;
  readonly parent_revision_sha256: CreativeCompositionSha256 | null;
  readonly binding: ApprovalBinding;
  readonly artwork: HandoffArtifact;
  readonly layer_manifest: readonly HandoffLayer[];
  readonly geometry: readonly CreativeCompositionGeometryEntry[];
  readonly dependencies: CreativeCompositionDependencies;
  readonly preview: CreativeCompositionPreview;
  readonly state_sha256: CreativeCompositionSha256;
  readonly revision_sha256: CreativeCompositionSha256;
  readonly created_at: string;
}
export interface CreativeCompositionProductionEnvelope {
  readonly contract: "CreativeCompositionProductionEnvelope";
  readonly schema_version: typeof CREATIVE_COMPOSITION_AUTHORITY_VERSION;
  readonly revision: Omit<CreativeCompositionRevision, "created_at">;
}
export interface CreativeCompositionRevisionInput extends Omit<CreativeCompositionRevision,
  "contract" | "schema_version" | "state_sha256" | "revision_sha256" | "created_at"> {}

/** Current C04 state returned by the configured trusted authority adapter. The runtime
 * independently checks scope, brief/facts/package, selected artwork, rights, C04
 * manifest projection, full state digest, proof expiry, and exact preview bytes. */
export interface CreativeCompositionSourceResult {
  readonly contract: typeof CREATIVE_COMPOSITION_SOURCE_CONTRACT;
  readonly schema_version: "1.1";
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly revision: CreativeCompositionRevision;
  readonly preview_bytes: Uint8Array;
}
export interface CreativeCompositionPreviewInput {
  readonly contract: typeof CREATIVE_COMPOSITION_PREVIEW_CONTRACT;
  readonly schema_version: "1.1";
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly action_id: string;
  readonly request_hash: CreativeCompositionSha256;
  /** Stable across retries so the trusted preview service can deduplicate its effect. */
  readonly idempotency_key: string;
  readonly base_revision: CreativeCompositionRevision;
  readonly candidate: Readonly<{
    composition_id: string;
    revision_id: string;
    parent_revision_id: string;
    parent_revision_sha256: CreativeCompositionSha256;
    binding: Omit<ApprovalBinding, "preview_sha256">;
    artwork: HandoffArtifact;
    layer_manifest: readonly HandoffLayer[];
    geometry: readonly CreativeCompositionGeometryEntry[];
    /** The owner proof is returned separately so it can bind state_sha256 without a fixed point. */
    dependencies: Omit<CreativeCompositionDependencies, "authority_proof">;
    state_sha256: CreativeCompositionSha256;
  }>;
}
export interface CreativeCompositionPreviewResult {
  readonly contract: typeof CREATIVE_COMPOSITION_PREVIEW_CONTRACT;
  readonly schema_version: "1.1";
  readonly preview: CreativeCompositionPreview;
  readonly authority_proof: CreativeCompositionDependencies["authority_proof"];
  readonly preview_bytes: Uint8Array;
}

/** Authenticated, immutable preview bytes safe for a consumer to render. */
export interface CreativeCompositionPreviewAccess {
  readonly contract: "CreativeCompositionPreviewAccess";
  readonly schema_version: "1.1";
  readonly preview_id: string;
  readonly sha256: CreativeCompositionSha256;
  readonly byte_length: number;
  readonly mime_type: "image/png" | "image/jpeg" | "image/webp";
  readonly width_px: number;
  readonly height_px: number;
  /** Base64 of the exact immutable bytes whose SHA-256 is `sha256`. */
  readonly bytes_base64: string;
}

export interface CreativeCompositionAssetBytesInput {
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly asset_id: string;
  readonly content_hash: CreativeCompositionSha256;
  readonly package_id: string;
  readonly package_hash: CreativeCompositionSha256;
  readonly permission_ref: string;
}
export interface CreativeCompositionAssetBytesResult {
  readonly asset_id: string;
  readonly content_hash: CreativeCompositionSha256;
  readonly mime_type: "image/png" | "image/jpeg" | "image/webp";
  readonly bytes: Uint8Array;
}

export declare const CREATIVE_COMPOSITION_AUTHORITY_VERSION: "creative.composition-authority/v1.1";
export declare const CREATIVE_COMPOSITION_SOURCE_CONTRACT: "CreativeCompositionSource";
export declare const CREATIVE_COMPOSITION_PREVIEW_CONTRACT: "CreativeCompositionPreview";
export declare const CREATIVE_COMPOSITION_PRODUCTION_CONTRACT: "CreativeCompositionProductionEnvelope";

export declare class CreativeCompositionContractError extends Error {
  constructor(code: string, field?: string);
  readonly code: string;
  readonly field: string;
}
export declare function snapshotCompositionJson<T = unknown>(value: T): T;
export declare function snapshotCompositionBytesRecord(value: unknown, byteField?: string): Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  bytes: Uint8Array;
}>;
export declare function validateCompositionGeometry(value: unknown,
  layerManifest: readonly HandoffLayer[]): readonly CreativeCompositionGeometryEntry[];
export declare function compositionStateHash(state: Omit<CreativeCompositionRevisionInput, "preview">): CreativeCompositionSha256;
export declare function createCompositionRevision(input: CreativeCompositionRevisionInput,
  options: { trustedScope: TrustedScope & { readonly brief_id: string }; previewBytes: Uint8Array; nowMs?: number }):
  Readonly<{ revision: CreativeCompositionRevision; preview_bytes: Uint8Array }>;
export declare function validateCompositionRevision(value: unknown,
  options: { trustedScope: TrustedScope & { readonly brief_id: string }; previewBytes: Uint8Array;
    nowMs?: number; allowExpired?: boolean }): CreativeCompositionRevision;
export declare function applyCompositionPlan(current: CreativeCompositionRevision, plan: unknown,
  trustedScope: TrustedScope & { readonly brief_id: string }): Readonly<{
    layer_manifest: readonly HandoffLayer[];
    geometry: readonly CreativeCompositionGeometryEntry[];
    revision_id: string;
  }>;
export declare function createCompositionProductionEnvelope(revision: CreativeCompositionRevision):
  CreativeCompositionProductionEnvelope;
export declare function validateCompositionProductionEnvelope(value: unknown,
  options: { trustedScope: TrustedScope & { readonly brief_id: string }; previewBytes: Uint8Array }):
  CreativeCompositionProductionEnvelope;
export declare function compositionPreviewHash(bytes: Uint8Array): CreativeCompositionSha256;
