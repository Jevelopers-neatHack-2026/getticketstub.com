/**
 * Connector-local worker types.
 *
 * These are private adapter-facing values. Cross-repository envelopes and
 * payloads remain owned by shared-contracts and are accepted or emitted only
 * through an injected ContractValidator.
 */
export type ProviderMode = "simulated" | "sandbox";
export type Operation = "discover_capabilities" | "quote" | "preflight" | "submit" | "status" | "shipment" | "cancel";
export type SharedShape = "operation_envelope" | "capability" | "print_specification" | "preflight_report" | "production_bundle" | "fulfillment_quote" | "order_authorization" | "shipment_observation" | "operation_result" | "budget_reservation" | "fulfillment_usage";
export interface TrustedScope {
    readonly tenantId: string;
    readonly projectId: string;
}
export type ContractBindingState = "missing" | "development_fixture" | "accepted";
export interface ContractBinding {
    readonly shape: SharedShape;
    readonly ownerRepository: string;
    readonly upstreamIssue: string;
    readonly state: ContractBindingState;
    readonly schemaVersion?: string;
    readonly sourceRevision?: string;
    readonly fixtureDigest?: string;
}
export interface ContractReceipt {
    readonly shape: SharedShape;
    readonly schemaVersion: string;
    readonly tenantId: string;
    readonly projectId: string;
}
export interface BoundaryFailure {
    readonly code: "invalid_input" | "contract_missing" | "unsupported_schema_major" | "scope_mismatch";
}
export type BoundaryResult<T> = {
    readonly ok: true;
    readonly value: T;
    readonly receipts: readonly ContractReceipt[];
} | {
    readonly ok: false;
    readonly failure: BoundaryFailure;
};
export interface InboundBoundaryRequest {
    readonly operation: Operation;
    readonly requiredShapes: readonly SharedShape[];
    readonly envelope: unknown;
    readonly trustedScope: TrustedScope;
}
export interface OutboundBoundaryRequest {
    readonly operation: Operation;
    readonly requiredShapes: readonly SharedShape[];
    readonly value: unknown;
    readonly trustedScope: TrustedScope;
}
export interface ContractValidator {
    binding(shape: SharedShape): ContractBinding;
    validateInbound<T>(request: InboundBoundaryRequest): Promise<BoundaryResult<T>>;
    validateOutbound(request: OutboundBoundaryRequest): Promise<BoundaryResult<unknown>>;
}
export interface CapabilityQuery {
    readonly catalogKey?: string;
}
export interface QuoteCommand {
    readonly productionBundle: unknown;
    readonly quantity: number;
    readonly destination: unknown;
}
export interface PreflightCommand {
    readonly productionBundle: unknown;
    readonly printSpecification: unknown;
}
export interface SubmitQuoteTerms {
    readonly quoteId: string;
    readonly currency: string;
    readonly totalMinor: number;
    readonly expiresAt: string;
    readonly productionBundleDigest: string;
    readonly termsFingerprint: string;
}
export interface SubmitCommand {
    readonly productionBundle: unknown;
    readonly productionBundleDigest: string;
    readonly quote: SubmitQuoteTerms;
    readonly authorizationEnvelope: unknown;
    readonly amountMinor: number;
    readonly currency: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
}
export interface StatusCommand {
    readonly providerRequestId: string;
}
export interface ShipmentCommand {
    readonly providerRequestId: string;
}
export interface CancelCommand {
    readonly providerRequestId: string;
    readonly authorizationEnvelope: unknown;
    readonly budgetRequest?: BudgetRequest;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
}
export interface QuoteResult {
    readonly providerQuoteId: string;
    readonly currency: string;
    readonly totalMinor: number;
    readonly expiresAt: string;
    readonly breakdown: readonly {
        readonly label: string;
        readonly amountMinor: number;
    }[];
}
export interface PreflightIssue {
    readonly code: string;
    readonly safeMessage: string;
}
export interface PreflightReport {
    readonly valid: boolean;
    readonly issues: readonly PreflightIssue[];
}
export interface SubmitResult {
    readonly providerRequestId: string;
    readonly acceptedAt: string;
}
export interface StatusResult {
    readonly providerRequestId: string;
    readonly providerStatus: string;
    readonly normalizedState: "pending" | "accepted" | "in_production" | "shipped" | "delivered" | "cancelled" | "failed" | "unknown";
    readonly observedAt: string;
}
export interface ShipmentResult {
    readonly providerRequestId: string;
    readonly providerShipmentId?: string;
    readonly trackingNumber?: string;
    readonly carrier?: string;
    readonly observedAt: string;
}
export interface CancelResult {
    readonly providerRequestId: string;
    readonly outcome: "cancelled" | "already_terminal" | "not_found";
    readonly observedAt: string;
}
export type ProviderResult<T> = {
    readonly status: "supported";
    readonly value: T;
} | {
    readonly status: "unsupported";
};
export type SideEffectDeclaration = "none" | "external";
export type IdempotencyDeclaration = "not_applicable" | "provider_key" | "connector_attempt_store" | "unknown";
export interface OperationCapability {
    readonly supported: boolean;
    readonly sideEffect: SideEffectDeclaration;
    readonly mayCharge: boolean;
    readonly idempotency: IdempotencyDeclaration;
}
export type OperationCapabilities = Readonly<Record<Operation, OperationCapability>>;
export interface ProviderDescriptor {
    readonly providerId: string;
    readonly apiVersion: string;
    readonly productLimits: Readonly<Record<string, number | string | boolean>>;
    readonly operations: OperationCapabilities;
    readonly supportedModes: readonly ProviderMode[];
}
export interface ConnectorCapabilities extends ProviderDescriptor {
    readonly mode: ProviderMode;
}
export interface ProviderTransportRequest {
    readonly operation: Operation;
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly path: string;
    readonly body?: unknown;
    readonly idempotencyKey?: string;
}
export interface ProviderTransport {
    readonly mode: ProviderMode;
    request<T>(request: ProviderTransportRequest): Promise<T>;
}
export interface Clock {
    now(): number;
}
export interface AdapterCallContext {
    readonly mode: ProviderMode;
    readonly transport: ProviderTransport;
    readonly clock: Clock;
}
export interface PreSubmitContext {
    readonly mode: ProviderMode;
    readonly clock: Clock;
    readonly trustedScope: TrustedScope;
}
export interface AuthorizationFacts {
    /** Facts the issuer must bind; caller idempotency keys/fingerprints are excluded. */
    readonly providerId: string;
    readonly mode: ProviderMode;
    readonly trustedScope: TrustedScope;
    readonly operation: "submit" | "cancel";
    readonly command: Readonly<Record<string, unknown>>;
}
export interface AuthorizationCheck {
    readonly authorizationEnvelope: unknown;
    readonly facts: AuthorizationFacts;
}
export type AuthorizationClaimResult = {
    readonly status: "rejected";
} | {
    readonly status: "claimed";
    /** Stable identity of the issuer authorization. */
    readonly authorizationId: string;
    /** Stable logical fulfillment-action identity across authorization renewals and delivery keys. */
    readonly actionId: string;
    readonly claimReference: string;
};
export interface AuthorizationVerifier {
    /**
     * The external authorization authority must verify these exact facts and
     * atomically claim the permitted action. A local boolean check is insufficient.
     */
    verifyAndClaim(check: AuthorizationCheck): Promise<AuthorizationClaimResult>;
}
export interface BudgetRequest {
    readonly amountMinor: number;
    readonly currency: string;
    readonly purpose: "fulfillment_submit" | "fulfillment_cancel";
}
export interface BudgetCheck {
    /** Canonical shared-contract payload, produced by ContractValidator. */
    readonly contractPayload: unknown;
    readonly trustedScope: TrustedScope;
    readonly mode: ProviderMode;
}
export interface BudgetClient {
    /** A thrown or malformed response is an uncertain reservation, never a denial. */
    authorize(check: BudgetCheck): Promise<{
        readonly authorized: boolean;
        readonly reference?: string;
    }>;
}
export type AttemptEffectState = "not_dispatched" | "possible" | "confirmed" | "unknown";
export type BudgetReservationState = "not_requested" | "pending" | "reserved" | "denied" | "unknown";
export interface SubmitAttemptRecord {
    readonly providerId: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly idempotencyKey: string;
    readonly claimId: string;
    readonly authorizationId: string;
    readonly actionId: string;
    readonly authorizationClaimReference: string;
    readonly requestFingerprint: string;
    readonly sideEffectState: AttemptEffectState;
    readonly budgetReservationState: BudgetReservationState;
    readonly budgetReservationReference?: string;
    readonly providerRequestId?: string;
    readonly updatedAt: number;
}
export interface AttemptPersistence {
    getSubmitAttempt(providerId: string, scope: TrustedScope, idempotencyKey: string): Promise<SubmitAttemptRecord | undefined>;
    /**
     * Atomically creates a durable, non-reclaimable action claim. The backing
     * store must enforce uniqueness by scoped logical actionId and authorizationId
     * as well as provider idempotency key, across workers and process restarts.
     * Budget reservations in pending, reserved, or unknown state are never
     * released or retried here; only an external authority may reconcile them.
     */
    claimSubmitAttempt(record: SubmitAttemptRecord): Promise<{
        readonly claimed: boolean;
        readonly existing?: SubmitAttemptRecord;
    }>;
    /** Updates only the record owned by record.claimId. */
    saveSubmitAttempt(record: SubmitAttemptRecord): Promise<void>;
}
export interface UsageEvent {
    readonly providerId: string;
    readonly operation: Operation;
    readonly mode: ProviderMode;
    readonly outcome: "dispatching" | "succeeded" | "failed";
    readonly sideEffectState: AttemptEffectState;
    readonly recordedAt: number;
}
export interface UsageSink {
    /** Canonical shared-contract payload, produced by ContractValidator. */
    record(contractPayload: unknown): Promise<void>;
}
/** Observation facts accepted by the runtime's durable metering adapter. */
export interface RuntimeMeteringObservation {
    readonly operation: Operation;
    readonly sourceEventKey?: string;
    readonly logicalOperationId?: string;
    readonly billableAttemptId?: string;
    readonly transportAttemptId?: string;
    readonly providerRequestId?: string;
    readonly outcome: "observed" | "attempt_prepared" | "dispatching" | "provider_accepted" | "not_dispatched" | "unknown";
    readonly completeness: "complete" | "partial" | "unknown";
    readonly durationMs?: number;
    readonly sourceRefs?: readonly string[];
    readonly quoteAmount?: {
        readonly amount: null | {
            readonly representation: "decimal";
            readonly value: string;
            readonly currency: string;
        } | {
            readonly representation: "scaled";
            readonly units: string;
            readonly scale: number;
            readonly currency: string;
        } | {
            readonly representation: "minor_units";
            readonly units: string;
            readonly currency: string;
        };
        readonly basis: "unknown" | "estimated" | "provider_confirmed";
    };
    readonly chargeAmount?: {
        readonly amount: null | {
            readonly representation: "decimal";
            readonly value: string;
            readonly currency: string;
        } | {
            readonly representation: "scaled";
            readonly units: string;
            readonly scale: number;
            readonly currency: string;
        } | {
            readonly representation: "minor_units";
            readonly units: string;
            readonly currency: string;
        };
        readonly basis: "unknown" | "estimated" | "provider_confirmed";
    };
    readonly effect: "non_billable_observation" | "potentially_billable_effect" | "confirmed_effect" | "unknown_effect";
}
export interface RuntimeMeteringRecorder {
    isConfiguredFor(providerId: string, mode: ProviderMode, scope: TrustedScope): boolean;
    recordObservation(input: RuntimeMeteringObservation): Promise<{
        readonly status: string;
        readonly reason?: string;
    }>;
    replayPending(): Promise<{
        readonly pending: number;
        readonly failures: readonly string[];
    }>;
}
/** Opens a tenant/project-scoped durable metering recorder for one runtime call. */
export type RuntimeMeteringResolver = (scope: TrustedScope) => Promise<RuntimeMeteringRecorder>;
export interface ProviderAdapter {
    readonly descriptor: ProviderDescriptor;
    quote(command: QuoteCommand, context: AdapterCallContext): Promise<ProviderResult<QuoteResult>>;
    preflight(command: PreflightCommand, context: AdapterCallContext): Promise<ProviderResult<PreflightReport>>;
    validateBeforeSubmit(command: SubmitCommand, context: PreSubmitContext): Promise<ProviderResult<PreflightReport>>;
    submit(command: SubmitCommand, context: AdapterCallContext): Promise<ProviderResult<SubmitResult>>;
    getStatus(command: StatusCommand, context: AdapterCallContext): Promise<ProviderResult<StatusResult>>;
    observeShipment(command: ShipmentCommand, context: AdapterCallContext): Promise<ProviderResult<ShipmentResult>>;
    cancel(command: CancelCommand, context: AdapterCallContext): Promise<ProviderResult<CancelResult>>;
}
export interface RuntimeDependencies {
    readonly contracts: ContractValidator;
    readonly transport: ProviderTransport;
    readonly clock: Clock;
    readonly persistence: AttemptPersistence;
    readonly authorizationVerifier: AuthorizationVerifier;
    readonly budgetClient: BudgetClient;
    readonly usageSink: UsageSink;
    /** Billable operations fail closed when no durable metering recorder is configured. */
    readonly metering?: RuntimeMeteringResolver;
}
export interface RuntimeOptions {
    readonly mode?: ProviderMode;
    readonly sandboxEnabled?: boolean;
}
export interface ConnectorResponse<T> {
    readonly operation: Operation;
    readonly mode: ProviderMode;
    readonly providerId: string;
    readonly value: T;
    readonly sharedPayload: unknown;
    readonly emittedShapes: readonly SharedShape[];
}
export interface ContractReadiness {
    readonly ready: boolean;
    readonly missingAcceptedPins: readonly {
        readonly shape: SharedShape;
        readonly ownerRepository: string;
        readonly upstreamIssue: string;
        readonly state: ContractBindingState;
        readonly schemaVersion?: string;
        readonly sourceRevision?: string;
        readonly fixtureDigest?: string;
    }[];
}
export interface RuntimeAudit {
    readonly runtimeVersion: string;
    readonly defaultMode: ProviderMode;
    readonly liveModeSupported: false;
    readonly contractReadiness: ContractReadiness;
    readonly sandboxReady: boolean;
    readonly sandboxReasons: readonly string[];
}
