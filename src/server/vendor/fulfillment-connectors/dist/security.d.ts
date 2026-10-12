import type { ProviderMode, TrustedScope } from "./types.js";
export type SecurityErrorCode = "invalid_scope" | "reference_unavailable" | "provider_payload_policy_invalid" | "mode_mismatch" | "server_secret_unavailable" | "provider_operation_failed" | "asset_policy_invalid" | "asset_url_rejected" | "asset_host_rejected" | "asset_address_rejected" | "asset_peer_mismatch" | "asset_redirect_rejected" | "asset_too_large" | "asset_type_rejected" | "asset_response_invalid" | "asset_timeout" | "asset_retrieval_failed" | "asset_approval_mismatch" | "refresh_changed_approval" | "retention_policy_invalid" | "retention_unavailable" | "callback_disabled" | "callback_invalid" | "callback_oversized" | "callback_verification_failed" | "callback_verification_unavailable" | "callback_replayed" | "callback_unavailable" | "internal_failure";
export declare class SecurityBoundaryError extends Error {
    readonly code: SecurityErrorCode;
    readonly diagnosticReference: string;
    readonly safeMessage: string;
    constructor(code: SecurityErrorCode, diagnosticReference: string);
    toJSON(): {
        code: SecurityErrorCode;
        safeMessage: string;
        diagnosticReference: string;
    };
}
export interface EncryptedScopedRecord {
    readonly tenantId: string;
    readonly projectId: string;
    readonly ciphertext: Uint8Array;
    readonly keyVersion: string;
}
export interface EncryptedScopedReferenceStore {
    /** The store must apply both scope predicates before returning any encrypted bytes. */
    get(reference: string, trustedScope: TrustedScope): Promise<EncryptedScopedRecord | undefined>;
}
export interface ScopedDecryptor<T> {
    decrypt(ciphertext: Uint8Array, context: {
        readonly trustedScope: TrustedScope;
        readonly keyVersion: string;
        readonly purpose: string;
    }): Promise<T>;
}
export declare function resolveEncryptedScopedReference<T>(input: {
    readonly reference: unknown;
    readonly trustedScope: unknown;
    readonly purpose: unknown;
    readonly store: EncryptedScopedReferenceStore;
    readonly decryptor: ScopedDecryptor<T>;
    readonly diagnosticReference?: unknown;
}): Promise<T>;
export type ProviderFieldSelection = true | ProviderArraySelection | ProviderObjectSelection;
export interface ProviderArraySelection {
    readonly $each: ProviderFieldSelection;
}
export interface ProviderObjectSelection {
    readonly [field: string]: ProviderFieldSelection;
}
/** Project only explicitly reviewed fields; nested objects and arrays need nested selections. */
export declare function minimizeProviderPayload<T = Readonly<Record<string, unknown>>>(input: {
    readonly value: unknown;
    readonly fields: ProviderFieldSelection;
    readonly diagnosticReference?: unknown;
}): T;
export interface ServerSecretLease {
    readonly secret: string;
    readonly version: string;
    readonly mode: ProviderMode;
}
export interface ServerSecretSource {
    /** Resolve from a server-side secret manager on each operation; do not cache across rotation. */
    load(input: {
        readonly providerId: string;
        readonly secretReference: string;
        readonly mode: ProviderMode;
    }): Promise<ServerSecretLease | undefined>;
}
export interface ServerSecretContext {
    readonly secret: string;
    readonly version: string;
    readonly mode: ProviderMode;
}
export declare function withServerSecret<T>(input: {
    readonly providerId: unknown;
    readonly secretReference: unknown;
    readonly mode: unknown;
    readonly source: ServerSecretSource;
    readonly use: (context: ServerSecretContext) => Promise<T>;
    readonly diagnosticReference?: unknown;
}): Promise<T>;
export declare function isPublicIPAddress(value: string): boolean;
export type SafeAssetMimeType = "image/png" | "image/jpeg" | "image/webp";
export interface SafeAssetPolicy {
    readonly allowedHosts: readonly string[];
    readonly allowedMimeTypes: readonly SafeAssetMimeType[];
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly maxRedirects: number;
}
export interface AssetResolver {
    resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
}
export interface AssetRequest {
    readonly mode: ProviderMode;
    readonly trustedScope: TrustedScope;
    readonly url: string;
    readonly hostname: string;
    readonly connectTo: readonly string[];
    readonly tlsServerName: string;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
    readonly maxBytes: number;
    readonly method: "GET";
}
export interface AssetResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly connectedAddress: string;
    readonly body?: Uint8Array | AsyncIterable<Uint8Array>;
}
export interface AssetTransport {
    /** Must connect only to `connectTo`, preserve TLS verification for `tlsServerName`, and never auto-follow redirects. */
    request(input: AssetRequest): Promise<AssetResponse>;
}
export interface RetrievedAsset {
    readonly bytes: Uint8Array;
    readonly contentType: SafeAssetMimeType;
    readonly sha256: string;
    readonly byteLength: number;
    readonly finalHost: string;
    readonly redirectCount: number;
}
export declare function retrieveApprovedAsset(input: {
    readonly url: unknown;
    readonly mode: unknown;
    readonly trustedScope: unknown;
    readonly policy: SafeAssetPolicy;
    readonly resolver: AssetResolver;
    readonly transport: AssetTransport;
    readonly diagnosticReference?: unknown;
}): Promise<RetrievedAsset>;
export interface ApprovedArtifactIdentity {
    readonly artifactId: string;
    readonly sha256: string;
    readonly contentType: SafeAssetMimeType;
    readonly byteLength: number;
    readonly termsFingerprint: string;
}
export interface SignedAssetAccess {
    readonly url: string;
    readonly expiresAt: number;
    readonly approved: ApprovedArtifactIdentity;
}
export declare function refreshSignedAssetAccess(input: {
    readonly previous: SignedAssetAccess;
    readonly refreshed: SignedAssetAccess;
    readonly allowedHosts: readonly string[];
    readonly now: number;
    readonly diagnosticReference?: unknown;
}): SignedAssetAccess;
export declare function assertRetrievedAssetMatchesApproval(input: {
    readonly asset: RetrievedAsset;
    readonly approved: ApprovedArtifactIdentity;
    readonly diagnosticReference?: unknown;
}): Promise<Uint8Array>;
export interface TombstoneFingerprint {
    readonly keyVersion: string;
    readonly digest: string;
}
/** A freshly issued fingerprint. `maxRetainUntil` is the latest `retainUntil` (ms since the epoch)
 * a tombstone storing it may use: the issuing key version stays verifiable at least that long.
 * Tombstones expire exclusively at `retainUntil`. The bound is not stored in the tombstone. */
export interface IssuedTombstoneFingerprint extends TombstoneFingerprint {
    readonly maxRetainUntil: number;
}
export interface TombstoneFingerprinter {
    /** Use a stable server-held key distinct from rotating provider API credentials. The result must
     * carry the retention bound of the issuing key version; `purgeSensitiveRecord` requires it. */
    fingerprint(purpose: "authorization_action" | "idempotency_key", canonicalIdentity: string): Promise<IssuedTombstoneFingerprint>;
}
export interface IdempotencyTombstone {
    readonly tenantId: string;
    readonly projectId: string;
    readonly actionFingerprint: TombstoneFingerprint;
    readonly idempotencyFingerprint: TombstoneFingerprint;
    readonly deletedAt: number;
    readonly retainUntil: number;
}
export interface SensitiveRecordRetentionPort {
    /** This operation must atomically erase personal fields and retain the supplied non-sensitive tombstone. */
    purgePersonalDataAndRetainTombstone(input: {
        readonly reference: string;
        readonly trustedScope: TrustedScope;
        readonly tombstone: IdempotencyTombstone;
    }): Promise<void>;
}
export declare function purgeSensitiveRecord(input: {
    readonly reference: unknown;
    readonly trustedScope: unknown;
    readonly providerId: unknown;
    readonly authorizationId: unknown;
    readonly actionId: unknown;
    readonly idempotencyKey: unknown;
    readonly deletedAt: number;
    readonly retainUntil: number;
    readonly fingerprinter: TombstoneFingerprinter;
    readonly retentionPort: SensitiveRecordRetentionPort;
    readonly diagnosticReference?: unknown;
}): Promise<IdempotencyTombstone>;
/** Overridable policy defaults. Retired-key retention has no default: it must cover the
 * longest approved tombstone retention period, which this package does not invent. */
export declare const TOMBSTONE_FINGERPRINT_KEY_POLICY_DEFAULTS: Readonly<{
    rotationIntervalMs: number;
    maxActiveKeyAgeMs: number;
    maxKeyVersions: 64;
    maxClockSkewMs: number;
}>;
/** Hard limits. A policy cannot override them. */
export declare const TOMBSTONE_FINGERPRINT_KEY_LIMITS: Readonly<{
    minKeyBytes: 32;
    maxKeyBytes: 1024;
    /** A key with this many or fewer distinct byte values is rejected as degenerate (all-same bytes, ASCII hex). */
    maxDegenerateDistinctKeyBytes: 16;
    /** Upper bound for `policy.maxKeyVersions` and for any loaded key set. */
    maxKeyVersions: 256;
    minKeyVersions: 2;
    /** Upper bound for `policy.maxClockSkewMs`. */
    maxClockSkewMs: number;
    /** Upper bound for `policy.retiredKeyRetentionMs` (100 years of 365 days), so every retention
     * bound and purge time stays a safe integer. */
    maxRetiredKeyRetentionMs: number;
}>;
export type TombstoneFingerprintPurpose = "authorization_action" | "idempotency_key";
export type FingerprintKeyState = "active" | "retired";
export interface FingerprintKeyMetadata {
    /** `<label>-g<generation>`, for example `tombstone-g7`. Generations strictly increase with activation. */
    readonly keyVersion: string;
    readonly state: FingerprintKeyState;
    /** Milliseconds since the epoch. */
    readonly activatedAt: number;
    /** Required for retired keys, absent for the active key. Equals the successor's `activatedAt`. */
    readonly retiredAt?: number;
}
export interface FingerprintKeyMaterial extends FingerprintKeyMetadata {
    /** At least 32 random bytes from the server-side secret manager, already decoded from any
     * hex or base64 text encoding. Never a supplier credential. */
    readonly key: Uint8Array;
}
export interface FingerprintKeySet {
    readonly keys: readonly FingerprintKeyMaterial[];
}
export interface FingerprintKeySource {
    /** Resolve the complete versioned key set for one keyring reference from the approved
     * server-side secret manager on each operation; do not cache across rotation. */
    load(input: {
        readonly keyringReference: string;
    }): Promise<FingerprintKeySet | undefined>;
}
export interface TombstoneFingerprintKeyPolicy {
    /** Scheduled rotation cadence. Default 90 days. */
    readonly rotationIntervalMs?: number;
    /** Hard limit. Past this age the active key stops issuing fingerprints. Default 180 days. */
    readonly maxActiveKeyAgeMs?: number;
    /** Required. How long a retired key stays verifiable; at least the longest approved tombstone
     * retention. At most `TOMBSTONE_FINGERPRINT_KEY_LIMITS.maxRetiredKeyRetentionMs` (100 years). */
    readonly retiredKeyRetentionMs: number;
    /** Retained versions a scheduled rotation may produce. Default 64, at most 256. Creation fails when
     * `ceil((retiredKeyRetentionMs + maxClockSkewMs) / rotationIntervalMs) + 2` exceeds it. */
    readonly maxKeyVersions?: number;
    /** Tolerated clock difference between hosts. Default 5 minutes, at most 60 minutes. */
    readonly maxClockSkewMs?: number;
}
export interface FingerprintKeyringStatus {
    readonly keyringReference: string;
    readonly activeKeyVersion: string;
    readonly activeKeyAgeMs: number;
    /** The scheduled rotation interval has elapsed. */
    readonly rotationDue: boolean;
    /** The hard age limit has elapsed; new fingerprints fail closed until rotation. */
    readonly rotationRequired: boolean;
    /** Active first, then retired keys still inside their retention window. */
    readonly verifiableKeyVersions: readonly string[];
    /** Retired keys past retention, oldest first. Remove them from the secret manager in this order, only
     * after their tombstones are deleted. `candidates` still covers them until they are removed. */
    readonly purgeableKeyVersions: readonly string[];
}
export interface TombstoneFingerprintKeyring extends TombstoneFingerprinter {
    /** HMAC-SHA256 with the active key; the key version is part of the HMAC input and the result.
     * `maxRetainUntil` is the latest `retainUntil` a tombstone storing this fingerprint may use. */
    fingerprint(purpose: TombstoneFingerprintPurpose, canonicalIdentity: string): Promise<IssuedTombstoneFingerprint>;
    /** One fingerprint per key version in the set, for a store lookup: the active key, the retired keys
     * inside retention, then (oldest first) retired keys past retention that are still in the set. A
     * store must confirm every hit with `matches`, which throws for a version past retention. */
    candidates(purpose: TombstoneFingerprintPurpose, canonicalIdentity: string): Promise<readonly TombstoneFingerprint[]>;
    /** Constant-time check of a stored fingerprint. Throws (never returns false) for a key version that
     * is unknown or past its retention window. */
    matches(purpose: TombstoneFingerprintPurpose, canonicalIdentity: string, stored: TombstoneFingerprint): Promise<boolean>;
    /** Key versions and rotation state only; never key material. */
    status(): Promise<FingerprintKeyringStatus>;
}
/**
 * A stable, server-held, versioned HMAC keyring for idempotency tombstone fingerprints.
 * Key material is resolved through the injected source on every operation and is never
 * returned. Every failure (no source, no key set, no or several active keys, short, degenerate
 * or duplicate keys, a broken rotation chain, an over-age active key, an unknown or purgeable
 * stored version) fails closed.
 */
export declare function createTombstoneFingerprintKeyring(input: {
    readonly keyringReference: unknown;
    readonly source: FingerprintKeySource;
    readonly policy: TombstoneFingerprintKeyPolicy;
    readonly clock?: () => number;
    /** Optional floor from the host's persisted `highWaterGeneration`. A key set whose active
     * generation is below it (a keyring rebuilt from scratch under a reused label) fails closed. */
    readonly minActiveGeneration?: number;
    readonly diagnosticReference?: unknown;
}): TombstoneFingerprintKeyring;
export interface FingerprintKeyRotationPlan {
    readonly reason: "scheduled" | "incident";
    readonly retiringKeyVersion: string;
    readonly newActiveKeyVersion: string;
    /** Generation of `newActiveKeyVersion`. Persist it and pass it back as `highWaterGeneration`. */
    readonly highWaterGeneration: number;
    /** The next key set metadata, newest first. It keeps removable versions (still `retired`). The host
     * adds the new key's random bytes in the secret manager and writes this set atomically. */
    readonly keys: readonly FingerprintKeyMetadata[];
    /** Retired versions past retention, oldest first. Drop them from the key set in a separate step,
     * only after every tombstone with that version is deleted or confirmed expired. Remove them in this
     * order (or all in one write): every intermediate set is then still a valid rotation chain. */
    readonly removableKeyVersions: readonly string[];
}
/**
 * Plan a rotation from key metadata only (no key bytes). The current active key becomes retired at
 * `now` and a new version with the next generation becomes active. Generations only increase: the new
 * one exceeds every generation in the set and the persisted `highWaterGeneration`, so a removed
 * version is never reissued. A scheduled rotation is refused before the active key is
 * `policy.rotationIntervalMs` old (the cadence the capacity check assumes) and above
 * `policy.maxKeyVersions` retained versions; an incident rotation is refused only above the hard limit.
 * The planner applies no clock skew: `now` must be past every recorded timestamp.
 */
export declare function planTombstoneFingerprintKeyRotation(input: {
    readonly keys: unknown;
    readonly reason: unknown;
    readonly now: unknown;
    readonly policy: TombstoneFingerprintKeyPolicy;
    readonly keyVersionLabel?: unknown;
    readonly highWaterGeneration?: unknown;
    readonly diagnosticReference?: unknown;
}): FingerprintKeyRotationPlan;
export interface CallbackHeaders {
    readonly [name: string]: string;
}
export interface CallbackVerifier {
    /** Implement only the selected provider's documented authenticity method. */
    verify(input: {
        readonly providerId: string;
        readonly mode: ProviderMode;
        readonly trustedScope: TrustedScope;
        readonly headers: CallbackHeaders;
        readonly rawBody: Uint8Array;
    }): Promise<boolean>;
}
export interface CallbackReplayStore {
    /** Atomically claim a provider event in the trusted tenant/project scope across restarts. */
    claim(input: {
        readonly providerId: string;
        readonly trustedScope: TrustedScope;
        readonly eventId: string;
    }): Promise<boolean>;
}
export interface CallbackHint {
    readonly eventId: string;
    readonly providerRequestId?: string;
}
export interface CallbackObservation {
    readonly status: "accepted" | "duplicate";
    readonly providerId: string;
    readonly trustedScope: TrustedScope;
    readonly trust: "verified" | "unverified";
    readonly hint: CallbackHint;
    readonly requiresAuthenticatedPoll: boolean;
    readonly authoritativeMutationAllowed: false;
}
export declare function ingestProviderCallback(input: {
    readonly providerId: unknown;
    readonly mode: unknown;
    readonly trustedScope: unknown;
    readonly headers: unknown;
    readonly rawBody: Uint8Array;
    readonly maxBodyBytes: number;
    readonly allowUnverifiedHints: boolean;
    readonly verifier?: CallbackVerifier;
    readonly parseHint: (rawBody: Uint8Array) => unknown;
    readonly replayStore: CallbackReplayStore;
    readonly diagnosticReference?: unknown;
}): Promise<CallbackObservation>;
/** Return a bounded diagnostic copy with nested personal data, credentials, and URLs removed. */
export declare function redactSensitive(value: unknown): unknown;
export interface SafeSecurityDiagnostic {
    readonly code: SecurityErrorCode;
    readonly diagnosticReference: string;
    readonly safeMessage: string;
}
/** Never copies raw error messages, stacks, URLs, headers, or provider response fields. */
export declare function safeSecurityDiagnostic(error: unknown, diagnosticReference?: unknown): SafeSecurityDiagnostic;
