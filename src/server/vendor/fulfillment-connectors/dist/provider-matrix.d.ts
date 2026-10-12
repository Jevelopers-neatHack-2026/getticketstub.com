export type MatrixEvidence = "documented" | "conditional" | "not_established" | "local_fixture_only" | "not_implemented" | "deferred";
export interface ProviderOperationMatrixCell {
    readonly documentation: MatrixEvidence;
    readonly implementation: "local_fixture_only" | "not_implemented" | "deferred";
    readonly accountTested: false;
    readonly details: string;
}
export declare const PRODIGI_SANDBOX_BASE_URL: "https://api.sandbox.prodigi.com/v4.0";
export type SandboxOperation = "quote" | "submit" | "status";
/**
 * Identifier the offline-tested Prodigi v4 sandbox adapter presents to the
 * policy. Only a request naming this adapter can reach `sandbox_call_permitted`;
 * every other request keeps the prerequisites-only result.
 */
export declare const PRODIGI_SANDBOX_ADAPTER_ID: "prodigi-v4-sandbox";
export interface SandboxRoute {
    readonly method: "GET" | "POST";
    readonly path: string;
}
export declare const PRODIGI_SANDBOX_OPERATION_ENDPOINTS: Readonly<Record<SandboxOperation, SandboxRoute>>;
export declare const PROVIDER_ENVIRONMENT_MATRIX: {
    readonly schemaVersion: "fulfillment-provider-environment-matrix/1";
    readonly checkedAt: "2026-10-10";
    readonly documentationRevision: "unknown; the official reference does not expose an immutable source revision";
    readonly observedSnapshotDigest: null;
    readonly meaning: "Official documentation observations only; not an accepted provider specification, account test, implementation, or release approval.";
    readonly liveEnabled: false;
    readonly releaseReady: false;
    readonly providers: readonly [{
        readonly providerId: "deterministic-simulator";
        readonly mode: "simulated";
        readonly apiVersion: "local-fixture/1";
        readonly status: "local_fixture_only";
        readonly network: "forbidden";
        readonly credentialClass: "none";
        readonly accountTested: false;
        readonly selectedSku: null;
        readonly destinationCountryCode: null;
        readonly shippingMethod: null;
        readonly operations: {
            readonly quote: {
                readonly documentation: "local_fixture_only";
                readonly implementation: "local_fixture_only";
                readonly accountTested: false;
                readonly details: "Deterministic repository fixtures only; no supplier quote.";
            };
            readonly submit: {
                readonly documentation: "local_fixture_only";
                readonly implementation: "local_fixture_only";
                readonly accountTested: false;
                readonly details: "Deterministic repository fixtures only; no supplier order.";
            };
            readonly status: {
                readonly documentation: "local_fixture_only";
                readonly implementation: "local_fixture_only";
                readonly accountTested: false;
                readonly details: "Deterministic repository fixtures only; no supplier status.";
            };
            readonly cancel: {
                readonly documentation: "local_fixture_only";
                readonly implementation: "local_fixture_only";
                readonly accountTested: false;
                readonly details: "Fixture behavior only; no supplier cancellation.";
            };
            readonly webhook: {
                readonly documentation: "not_established";
                readonly implementation: "not_implemented";
                readonly accountTested: false;
                readonly details: "No authenticated callback integration.";
            };
        };
    }, {
        readonly providerId: "prodigi";
        readonly mode: "sandbox";
        readonly apiVersion: "v4.0";
        readonly status: "official_documentation_observed_only";
        readonly endpointBase: "https://api.sandbox.prodigi.com/v4.0";
        readonly endpointAllowlist: {
            method: "GET" | "POST";
            path: string;
            operation: string;
        }[];
        readonly credentialClass: "sandbox";
        readonly accountTested: false;
        readonly accountAccess: "unknown";
        readonly selectedSku: null;
        readonly selectedDestinationCountryCode: null;
        readonly selectedShippingMethod: null;
        readonly productAndDestinationSuitability: "pending print-production owner decision";
        readonly sandboxAdapter: {
            readonly adapterId: "prodigi-v4-sandbox";
            readonly implementation: "offline_fixture_tested";
            readonly accountTested: false;
            readonly callPermittedWhen: "evaluateProviderPolicy returns sandbox_call_permitted: the request names this adapter, uses the sandbox host and credential class, and an injected verifier confirms the owner decision.";
            readonly details: "Quote, order-create and order-read adapter covered by synthetic fixtures only. No request has been sent to Prodigi; per-operation implementation and accountTested fields stay unchanged until sandbox evidence exists.";
        };
        readonly documentation: {
            readonly checkedAt: "2026-10-10";
            readonly revision: "unknown";
            readonly observedSnapshotDigest: null;
            readonly sources: readonly ["https://www.prodigi.com/print-api/docs/reference/", "https://www.prodigi.com/faq/print-api/"];
            readonly interfaceFacts: "The v4 reference documents a sandbox host, X-API-Key authentication, quote, order, product-details and retrieval endpoints. Sandbox is documented as non-charging and non-fulfilling; credentials may differ by environment.";
            readonly skuAndDestination: "The docs include example SKUs and dynamic product details, but no example is selected or accepted here. Product, variant, destination and shipping remain unknown.";
            readonly assetFacts: "General docs describe JPG, PNG and PDF assets; image sizing/product constraints are product-specific. No approved print specification or artifact checks exist here.";
            readonly quoteExpiry: "No quote-expiry guarantee was established in the inspected reference.";
            readonly leadTime: "No selected-SKU and destination lead-time evidence was established.";
            readonly callbackAuthenticity: "The inspected reference documents CloudEvents callbacks but does not establish an authenticity/signature policy; callbacks must remain untrusted hints pending verification.";
        };
        readonly operations: {
            readonly quote: {
                readonly documentation: "documented";
                readonly implementation: "not_implemented";
                readonly accountTested: false;
                readonly details: "POST /v4.0/quotes is documented; exact quote semantics, selected product, and sandbox behavior have not been tested against an account.";
            };
            readonly submit: {
                readonly documentation: "documented";
                readonly implementation: "not_implemented";
                readonly accountTested: false;
                readonly details: "POST /v4.0/Orders is documented; order creation can enter fulfillment, so only a future approved sandbox path may be considered.";
            };
            readonly status: {
                readonly documentation: "documented";
                readonly implementation: "not_implemented";
                readonly accountTested: false;
                readonly details: "GET /v4.0/orders/{id} is documented. Complete means shipping notifications for all items, not proof of delivery.";
            };
            readonly cancel: {
                readonly documentation: "conditional";
                readonly implementation: "not_implemented";
                readonly accountTested: false;
                readonly details: "Cancellation is conditional on per-order action availability and fulfillment state; fees/refunds may vary. Excluded from the initial sandbox slice.";
            };
            readonly webhook: {
                readonly documentation: "not_established";
                readonly implementation: "not_implemented";
                readonly accountTested: false;
                readonly details: "CloudEvents callbacks are documented; authenticity is not established by the inspected reference. Use trusted polling until an accepted verification policy exists.";
            };
        };
        readonly idempotency: {
            readonly documentation: "documented";
            readonly implementation: "not_implemented";
            readonly accountTested: false;
            readonly providerScope: "account";
            readonly retention: "indefinite according to the reference";
            readonly optional: true;
            readonly merchantReferenceIsUnique: false;
            readonly note: "Provider idempotency does not replace application authorization/action claims or local uncertain-outcome persistence.";
        };
    }, {
        readonly providerId: "other-providers";
        readonly mode: "sandbox_or_live";
        readonly apiVersion: "unknown";
        readonly status: "deferred";
        readonly network: "forbidden";
        readonly credentialClass: "none";
        readonly accountTested: false;
        readonly selectedSku: null;
        readonly destinationCountryCode: null;
        readonly shippingMethod: null;
        readonly operations: {
            readonly quote: {
                readonly documentation: "deferred";
                readonly implementation: "deferred";
                readonly accountTested: false;
                readonly details: "No support claimed.";
            };
            readonly submit: {
                readonly documentation: "deferred";
                readonly implementation: "deferred";
                readonly accountTested: false;
                readonly details: "No support claimed.";
            };
            readonly status: {
                readonly documentation: "deferred";
                readonly implementation: "deferred";
                readonly accountTested: false;
                readonly details: "No support claimed.";
            };
            readonly cancel: {
                readonly documentation: "deferred";
                readonly implementation: "deferred";
                readonly accountTested: false;
                readonly details: "No support claimed.";
            };
            readonly webhook: {
                readonly documentation: "deferred";
                readonly implementation: "deferred";
                readonly accountTested: false;
                readonly details: "No support claimed.";
            };
        };
    }];
};
export interface ProviderPolicyInput {
    readonly mode?: unknown;
    readonly providerId?: unknown;
    readonly endpoint?: unknown;
    readonly operation?: unknown;
    readonly credentialClass?: unknown;
    readonly sku?: unknown;
    readonly destinationCountryCode?: unknown;
    readonly shippingMethod?: unknown;
    readonly decisionReference?: unknown;
    /** Names the calling adapter. Only `PRODIGI_SANDBOX_ADAPTER_ID` can be permitted. */
    readonly adapterId?: unknown;
}
export interface SandboxDecisionRequest {
    readonly decisionReference: string;
    readonly providerId: "prodigi";
    readonly apiVersion: "v4.0";
    readonly sku: string;
    readonly destinationCountryCode: string;
    readonly shippingMethod: string;
    readonly credentialClass: "sandbox";
}
export interface VerifiedSandboxDecision extends SandboxDecisionRequest {
    /** The verifier must confirm an owner-approved product and destination decision. */
    readonly productAndDestinationApproved: true;
    /** The verifier must confirm sandbox account access without returning credential material. */
    readonly sandboxAccountAccessConfirmed: true;
}
export interface SandboxDecisionVerifier {
    /** Resolve the evidence reference with its owning authorities; caller configuration alone is insufficient. */
    verify(request: SandboxDecisionRequest): Promise<VerifiedSandboxDecision | undefined>;
}
export type ProviderPolicyReason = "invalid_configuration" | "unsupported_mode" | "provider_not_supported" | "simulated_mode_must_be_offline" | "sandbox_host_not_allowed" | "sandbox_path_not_allowed" | "sandbox_credential_class_required" | "sandbox_operation_not_in_scope" | "selected_sku_required" | "destination_required" | "shipping_choice_required" | "decision_reference_required" | "decision_verifier_unavailable" | "decision_unverified" | "decision_does_not_match_request" | "provider_adapter_not_implemented";
export interface ProviderPolicyAssessment {
    readonly schemaVersion: "fulfillment-provider-policy-assessment/1";
    readonly status: "simulated_offline" | "blocked" | "sandbox_prerequisites_verified" | "sandbox_call_permitted";
    readonly mode: "simulated" | "sandbox" | null;
    readonly providerId: "deterministic-simulator" | "prodigi" | null;
    readonly sandboxPreconditionsSatisfied: boolean;
    readonly sandboxRoute: SandboxRoute | null;
    /** True only for `sandbox_call_permitted`. */
    readonly providerAdapterImplemented: boolean;
    /** True only for `sandbox_call_permitted`; the policy itself still makes no request. */
    readonly providerCallPermitted: boolean;
    readonly networkRequests: 0;
    readonly credentialReads: 0;
    readonly secretMaterialReturned: false;
    readonly reasons: readonly ProviderPolicyReason[];
}
/**
 * Validate environment policy without resolving credentials or making requests.
 * The default path is the local simulator. A sandbox decision verifier is an
 * explicit trust port; this repository has no implementation of that port.
 */
export declare function evaluateProviderPolicy(input?: ProviderPolicyInput, verifier?: SandboxDecisionVerifier): Promise<ProviderPolicyAssessment>;
