import type {
  CreativeConceptProviderInput,
  CreativeProviderRouteInput,
  CreativeConceptReferenceInspection,
  CreativeConceptReferencePreflight,
  ProviderInput,
  ProviderOutput,
  CreativeProviderRoute,
  UsageRecord,
  ImagePreparationInput,
  PreparedImageAttempt,
} from "../api/v1.mjs";

export type OpenAIImageOperation = "generate" | "edit";
export type OpenAIImageOutputFormat = "png" | "jpeg" | "webp";
export type OpenAIImageQuality = "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenAIImageConfiguration {
  readonly quality: OpenAIImageQuality;
  readonly size: "auto" | `${number}x${number}`;
  readonly output_format: OpenAIImageOutputFormat;
  readonly background: "opaque" | "transparent";
  readonly moderation: "auto" | "low";
}

export interface OpenAIImageTokenDetails {
  readonly [detail: string]: number | undefined;
  readonly text_tokens?: number;
  readonly image_tokens?: number;
}

/** Fields shared by every raw image usage observation; each provider declares its own token-detail shapes. */
interface ImageUsageBase extends UsageRecord {
  readonly [providerField: string]: unknown;
  readonly completeness: "unknown";
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly provider_request_id?: string;
  readonly transport_attempt_id?: string;
  readonly missing_fields: readonly string[];
}

/** Raw allowlisted provider counters. The owner-reviewed operation profile maps these to C03. */
export interface OpenAIImageUsage extends ImageUsageBase {
  readonly input_tokens_details?: OpenAIImageTokenDetails;
  readonly output_tokens_details?: OpenAIImageTokenDetails;
}

export type OpenAIImagesInput = ProviderInput & { readonly reservation_ref: string };
export type OpenAIImagesConceptInput = CreativeConceptProviderInput;

export interface OpenAIImagesOutput extends ProviderOutput {
  readonly target_binding_sha256: `sha256:${string}`;
  readonly usage: OpenAIImageUsage;
}

export interface OpenAIImageEvidence {
  readonly evidence_ref: string;
  readonly evidence_sha256: `sha256:${string}`;
}

export interface OpenAIImageTargetBinding {
  readonly service: "openai";
  readonly endpoint: string;
  readonly model: string;
  readonly sdk_name: "native-fetch";
  readonly sdk_version: string;
  readonly configuration_sha256: `sha256:${string}`;
  readonly operation: OpenAIImageOperation;
  readonly operation_kind: string;
  readonly input_sha256: `sha256:${string}`;
  readonly prompt_sha256: `sha256:${string}`;
  readonly plan_sha256: `sha256:${string}`;
  readonly parent_artifact_sha256?: `sha256:${string}`;
  readonly mask_content_sha256?: `sha256:${string}`;
  readonly image_reference_manifest_sha256?: `sha256:${string}`;
  readonly deadline_at: string;
  readonly transport_policy: Readonly<{
    maximum_transport_attempts: 1;
    automatic_retry: false;
    stop_on: readonly string[];
  }>;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly budget_scope_id: string;
  readonly billable_attempt_id: string;
}

export interface OpenAIImageCapabilityRequest {
  readonly scope: ProviderInput["scope"];
  readonly attempt: ProviderInput["attempt"];
  readonly operation: OpenAIImageOperation;
  readonly model: string;
  readonly target_binding: OpenAIImageTargetBinding;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly reservation_ref: string;
  readonly billable_attempt_id: string;
  readonly deadline_at: string;
  readonly checked_at?: string;
  readonly phase?: "post_transport_ack";
  readonly account_ref?: string;
  readonly project_ref?: string;
  readonly grant_ref?: string;
}

export interface OpenAIImageCapabilityPort {
  /** Must read trusted, current account/project eligibility and operation quota evidence. */
  verify(input: OpenAIImageCapabilityRequest): Promise<unknown> | unknown;
  revalidate(input: OpenAIImageCapabilityRequest): Promise<unknown> | unknown;
}

export interface OpenAIImageAuthorizationRequest {
  readonly scope: ProviderInput["scope"];
  readonly attempt: ProviderInput["attempt"];
  readonly operation: OpenAIImageOperation;
  readonly target_binding: OpenAIImageTargetBinding;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly reservation_ref: string;
  readonly account_ref?: string;
  readonly project_ref?: string;
  readonly grant_ref?: string;
  readonly finance_lease_ref?: string;
  readonly billable_attempt_id: string;
  readonly budget_scope_id: string;
  readonly dispatch_intent_ref: string;
  readonly deadline_at: string;
  readonly phase: "preparation" | "post_transport_ack";
}

export interface OpenAIImageAuthorizationPort {
  /** Authenticates grant and Finance reservation/lease identity, cap, currency and current state. */
  revalidate(input: OpenAIImageAuthorizationRequest): Promise<unknown> | unknown;
}

export interface OpenAIImageCredentialPort {
  resolveCredential(input: Readonly<Record<string, unknown>>): Promise<unknown> | unknown;
}

export interface OpenAIImagePromptPort {
  render(input: Readonly<Record<string, unknown>>): Promise<string | { prompt: string }> | string | { prompt: string };
}

export interface OpenAIImageAssetPort {
  readArtifact(input: Readonly<Record<string, unknown>>): Promise<Uint8Array> | Uint8Array;
  readReference?(input: Readonly<Record<string, unknown>>): Promise<Uint8Array> | Uint8Array;
}

export interface OpenAIImageRetryPolicy {
  readonly max_attempts?: number;
  readonly max_elapsed_ms?: number;
  readonly max_delay_ms?: number;
}

export interface OpenAIImageProviderOptions {
  readonly model_id: string;
  readonly configuration: OpenAIImageConfiguration;
  readonly capabilityPort: OpenAIImageCapabilityPort;
  readonly authorizationPort: OpenAIImageAuthorizationPort;
  readonly credentialPort: OpenAIImageCredentialPort;
  readonly promptPort: OpenAIImagePromptPort;
  readonly assetPort?: OpenAIImageAssetPort;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly retryPolicy?: OpenAIImageRetryPolicy;
}

export type OpenAIImagesErrorCode =
  | "invalid_configuration" | "unsupported_model_profile" | "unsupported_image_configuration" | "unsupported_operation"
  | "provider_ports_unavailable" | "provider_attempt_mismatch" | "invalid_provider_input" | "reservation_reference_missing"
  | "model_capability_unverified" | "model_capability_unavailable" | "authorization_unavailable"
  | "credential_unavailable" | "asset_unavailable" | "asset_invalid" | "asset_integrity_error"
  | "mask_unavailable" | "mask_invalid" | "prompt_unavailable" | "prompt_invalid" | "unsupported_plan"
  | "deadline_or_cancelled" | "cancelled_before_dispatch" | "dispatch_fence_closed" | "transport_ack_unknown"
  | "transport_ack_mismatch" | "provider_transport_unknown" | "provider_response_invalid" | "provider_request_failed"
  | "provider_rate_limited" | "provider_quota_exhausted" | "authentication_denied" | "operation_permission_denied"
  | "moderation_blocked" | "provider_output_mismatch" | "provider_outcome_unknown" | "image_bytes_invalid"
  | "image_decoder_unavailable";

export interface OpenAIImageRetryDecision {
  readonly decision: "stop" | "eligible_for_separately_authorized_attempt";
  readonly stop_reason?: string;
  readonly delay_ms: number | null;
  readonly automatic_retry: false;
  readonly new_billable_identity_required?: true;
}

export declare const OPENAI_IMAGE_CANDIDATE_PROFILES: Readonly<Record<string, Readonly<{
  model_id: string;
  docs_checked_at: string;
  documentation_status: "candidate_unselected";
  qualities: readonly OpenAIImageQuality[];
  formats: readonly OpenAIImageOutputFormat[];
  transparent_formats: readonly ("png" | "webp")[];
  moderation: readonly ("auto" | "low")[];
  size_policy: string;
  response_encoding: "base64";
  supports_input_fidelity: false;
  supports_streaming: false;
}>>>;

export declare const OPENAI_IMAGES_ENDPOINTS: Readonly<{
  generation: "https://api.openai.com/v1/images/generations";
  edit: "https://api.openai.com/v1/images/edits";
}>;

export declare class OpenAIImagesProviderError extends Error {
  constructor(code: OpenAIImagesErrorCode | string, message: string, options?: {
    outcome?: "succeeded" | "failed" | "partial" | "unknown";
    http_status?: number;
    retry?: OpenAIImageRetryDecision;
    provider_request_ref?: string;
    field?: string;
    embedded_code?: number;
  });
  readonly code: OpenAIImagesErrorCode | string;
  readonly provider_outcome: "succeeded" | "failed" | "partial" | "unknown";
  readonly http_status?: number;
  readonly retry?: OpenAIImageRetryDecision;
  readonly provider_request_ref?: string;
  readonly field?: string;
  /** Sanitized numeric code of an error body delivered under a different HTTP status (for example 200). */
  readonly embedded_code?: number;
  /** Raw allowlisted counters observed before a failed outcome; never implies settlement. */
  readonly usage?: OpenAIImageUsage;
}

export declare function createOpenAIImagesProvider(options: OpenAIImageProviderOptions): Readonly<{
  prepareAttempt(input: ImagePreparationInput): Promise<PreparedImageAttempt>;
  resolveRoute(input: Pick<CreativeProviderRouteInput, "operation">): CreativeProviderRoute;
  getConceptConfiguration(): Readonly<{ model_id: string; configuration: OpenAIImageConfiguration }>;
  inspectConceptReferences(input: { scope: ProviderInput["scope"];
    references: readonly CreativeConceptReferencePreflight[];
    maximum_single_reference_bytes: number; maximum_aggregate_reference_bytes: number }):
    Promise<readonly CreativeConceptReferenceInspection[]>;
  generate(input: OpenAIImagesInput): Promise<OpenAIImagesOutput>;
  edit(input: OpenAIImagesInput | OpenAIImagesConceptInput): Promise<OpenAIImagesOutput>;
}>;

export declare function inspectOpenAIImageBytes(value: Uint8Array): Promise<Readonly<{
  format: OpenAIImageOutputFormat;
  width: number;
  height: number;
  has_alpha: boolean;
  has_transparency: boolean;
}>>;

export declare function normalizeOpenAIImageUsage(raw: unknown, identities?: {
  transport_attempt_id?: string;
  provider_request_id?: string;
}): OpenAIImageUsage;

export declare function evaluateOpenAIImageRetry(input: {
  retry_after?: string;
  attempt_number: number;
  started_at: string;
  now_at: string;
  deadline_at: string;
  max_attempts?: number;
  max_elapsed_ms?: number;
  max_delay_ms?: number;
  next_attempt_authorized?: boolean;
}): OpenAIImageRetryDecision;

// ---------------------------------------------------------------------------
// OpenRouter Images adapter. The host supplies an explicit profile; there is no
// built-in default model, provider tag, price, or entitlement.
// ---------------------------------------------------------------------------

export type OpenRouterImageOutputFormat = OpenAIImageOutputFormat;

/** Typed discovery descriptors. Optional n/reference ranges bound adapter-owned wire counts when present. */
export type OpenRouterImageEnumDescriptor<T extends string = string> = Readonly<{ type: "enum"; values: readonly T[] }>;
/** Inclusive range; runtime accepts only ordered bounded safe-integer endpoints. */
export type OpenRouterImageRangeDescriptor = Readonly<{ type: "range"; min: number; max: number }>;

export interface OpenRouterImageSupportedParameters {
  /** Catalog descriptors list "auto"; it is accepted here but can never be the pinned configuration. */
  readonly aspect_ratio?: OpenRouterImageEnumDescriptor<`${number}:${number}` | "auto">;
  readonly quality?: OpenRouterImageEnumDescriptor;
  readonly background?: OpenRouterImageEnumDescriptor<"auto" | "opaque" | "transparent">;
  readonly output_format?: OpenRouterImageEnumDescriptor<OpenRouterImageOutputFormat>;
  readonly resolution?: OpenRouterImageEnumDescriptor<"512" | "768" | "1K" | "1.5K" | "2K" | "4K">;
  readonly output_compression?: OpenRouterImageRangeDescriptor;
  /** Optional catalog bound for the fixed wire n:1; when present, it must contain 1. */
  readonly n?: OpenRouterImageRangeDescriptor;
  /** Optional actual wire reference-count bound; generation uses 0 and edits count the parent plus approved references. */
  readonly input_references?: OpenRouterImageRangeDescriptor;
}

/** The pinned subset sent to the provider. Every key must be declared by `supported_parameters`. */
export interface OpenRouterImageConfiguration {
  readonly aspect_ratio?: string;
  readonly quality?: string;
  readonly background?: "auto" | "opaque" | "transparent";
  readonly output_format?: OpenRouterImageOutputFormat;
  readonly resolution?: "512" | "768" | "1K" | "1.5K" | "2K" | "4K";
  readonly output_compression?: number;
}

/** Generation and reference-guided edit are separate capabilities; one never implies the other. */
export interface OpenRouterImageCapabilities {
  readonly generation: boolean;
  readonly edit: false | Readonly<{ max_input_references: number }>;
}

export interface OpenRouterImageCostObservation {
  readonly amount: string;
  readonly currency: "USD";
  /** Provider-reported and unsettled: never a Finance expense, a price, or a settlement. */
  readonly provenance: "provider_reported_unsettled";
}

/**
 * Documented OpenRouter prompt token details, normalized as `input_tokens_details`. Exactly the documented keys: no
 * `text_tokens` and no index signature (a type alias, so it stays assignable to the generic `ProviderOutput` usage record).
 */
export type OpenRouterImageInputTokenDetails = Readonly<{
  readonly audio_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly cached_tokens?: number;
  readonly file_tokens?: number;
  readonly video_tokens?: number;
}>;

/** Documented OpenRouter completion token details, normalized as `output_tokens_details`. */
export type OpenRouterImageOutputTokenDetails = Readonly<{
  readonly audio_tokens?: number;
  readonly image_tokens?: number;
  readonly reasoning_tokens?: number;
}>;

/** Raw allowlisted counters. A missing usage or cost is listed in `missing_fields`, never zero. */
export interface OpenRouterImageUsage extends ImageUsageBase {
  readonly input_tokens_details?: OpenRouterImageInputTokenDetails;
  readonly output_tokens_details?: OpenRouterImageOutputTokenDetails;
  readonly cost?: OpenRouterImageCostObservation;
  readonly cost_details?: Readonly<{
    upstream_inference_cost?: string;
    upstream_inference_prompt_cost?: string;
    upstream_inference_completions_cost?: string;
  }>;
  readonly is_byok?: boolean;
}

export interface OpenRouterImagesOutput extends ProviderOutput {
  readonly target_binding_sha256: `sha256:${string}`;
  readonly usage: OpenRouterImageUsage;
}

export type OpenRouterImageTargetBinding = Omit<OpenAIImageTargetBinding, "service" | "operation_kind"> & Readonly<{
  service: "openrouter";
  endpoint: "https://openrouter.ai/api/v1/images";
  provider_tag: string;
  provider_routing: Readonly<{ only: readonly [string]; allow_fallbacks: false }>;
  /** `image_generation`, or `image_reference_edit` for reference-guided edit (not the direct masked/parent edit). */
  operation_kind: "image_generation" | "image_reference_edit";
  /** The C03 MeteredOperationKind of the attempt. */
  metered_operation_kind: string;
  edit_semantics?: "reference_guided";
  max_input_references?: number;
}>;

export type OpenRouterImageCapabilityRequest = Omit<OpenAIImageCapabilityRequest, "target_binding"> &
  Readonly<{ target_binding: OpenRouterImageTargetBinding }>;
export type OpenRouterImageAuthorizationRequest = Omit<OpenAIImageAuthorizationRequest, "target_binding"> &
  Readonly<{ target_binding: OpenRouterImageTargetBinding }>;

export interface OpenRouterImageCapabilityPort {
  verify(input: OpenRouterImageCapabilityRequest): Promise<unknown> | unknown;
  revalidate(input: OpenRouterImageCapabilityRequest): Promise<unknown> | unknown;
}

export interface OpenRouterImageAuthorizationPort {
  revalidate(input: OpenRouterImageAuthorizationRequest): Promise<unknown> | unknown;
}

/** The host injects the creative-engine OpenRouter key here. The adapter never reads the environment. */
export interface OpenRouterImageCredentialPort {
  resolveCredential(input: Readonly<Record<string, unknown>>): Promise<unknown> | unknown;
}

export interface OpenRouterImageProviderOptions {
  /** `author/slug` model id chosen by the host. */
  readonly model_id: string;
  /** Pinned into `provider.only` with `allow_fallbacks: false`. */
  readonly provider_tag: string;
  readonly capabilities: OpenRouterImageCapabilities;
  readonly supported_parameters?: OpenRouterImageSupportedParameters;
  readonly configuration: OpenRouterImageConfiguration;
  readonly capabilityPort: OpenRouterImageCapabilityPort;
  readonly authorizationPort: OpenRouterImageAuthorizationPort;
  readonly credentialPort: OpenRouterImageCredentialPort;
  readonly promptPort: OpenAIImagePromptPort;
  readonly assetPort?: OpenAIImageAssetPort;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly retryPolicy?: OpenAIImageRetryPolicy;
}

export declare const OPENROUTER_IMAGES_ENDPOINT: "https://openrouter.ai/api/v1/images";
export declare const OPENROUTER_IMAGES_COST_PROVENANCE: "provider_reported_unsettled";

export declare class OpenRouterImagesProviderError extends OpenAIImagesProviderError {
  readonly usage?: OpenRouterImageUsage;
}

export declare function createOpenRouterImagesProvider(options: OpenRouterImageProviderOptions): Readonly<{
  prepareAttempt(input: ImagePreparationInput): Promise<PreparedImageAttempt>;
  resolveRoute(input: Pick<CreativeProviderRouteInput, "operation">): CreativeProviderRoute;
  getConceptConfiguration(): Readonly<{ model_id: string; provider_tag: string; capabilities: OpenRouterImageCapabilities;
    configuration: OpenRouterImageConfiguration }>;
  inspectConceptReferences(input: { scope: ProviderInput["scope"];
    references: readonly CreativeConceptReferencePreflight[];
    maximum_single_reference_bytes: number; maximum_aggregate_reference_bytes: number }):
    Promise<readonly CreativeConceptReferenceInspection[]>;
  generate(input: OpenAIImagesInput): Promise<OpenRouterImagesOutput>;
  edit(input: OpenAIImagesInput | OpenAIImagesConceptInput): Promise<OpenRouterImagesOutput>;
}>;

export declare function normalizeOpenRouterImageUsage(raw: unknown, identities?: {
  transport_attempt_id?: string;
}): OpenRouterImageUsage;
