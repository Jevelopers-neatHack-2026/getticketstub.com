import { type CatalogSnapshot } from "./catalog.js";
import type { ContractValidator, TrustedScope } from "./types.js";
/** Private FC-04 development output. It is not shared-contracts FulfillmentQuote. */
export declare const PRIVATE_QUOTE_FORMAT: "connector-development-quote/1";
export type QuoteErrorCode = "missing_input" | "invalid_input" | "unsupported" | "stale_quote" | "rate_limit" | "timeout" | "provider_failure" | "provider_response_invalid" | "contract_missing" | "contract_rejected" | "scope_mismatch" | "unsupported_schema_major";
export declare class QuoteExecutionError extends Error {
    readonly operation: "quote";
    readonly code: QuoteErrorCode;
    readonly safeMessage: string;
    constructor(code: QuoteErrorCode);
    toJSON(): {
        operation: "quote";
        code: QuoteErrorCode;
        safeMessage: string;
    };
}
export type QuoteUnknownReason = "not_disclosed" | "not_provided" | "not_supported" | "provider_unspecified" | "outside_scope";
export type ProviderAmountInput = {
    readonly state: "known";
    readonly decimal: string;
} | {
    readonly state: "unknown";
    readonly reasonCode: QuoteUnknownReason;
};
export interface QuoteProviderRequest {
    readonly providerId: string;
    readonly apiVersion: string;
    readonly catalogVersion: string;
    readonly catalogSnapshotIdentity: string;
    readonly catalogContentIdentity: string;
    readonly sku: string;
    readonly variantId: string;
    readonly specIdentity: string;
    readonly selectionDigest: string;
    readonly quantity: number;
    readonly options: readonly string[];
    readonly materials: readonly string[];
    readonly destination: {
        readonly reference: string;
        readonly digest: string;
        readonly countryCode: string;
        readonly regionCode?: string;
    };
    readonly shippingMethod: string;
    readonly personalization: null | {
        readonly mode: string;
        readonly fieldCount: number;
    };
    readonly requestDigest: string;
}
export interface QuoteProviderCallContext {
    readonly operation: "quote";
    readonly signal: AbortSignal;
}
/** This port deliberately has one operation and no submission or payment API. */
export interface BoundedQuotePort {
    quote(request: QuoteProviderRequest, context: QuoteProviderCallContext): Promise<unknown>;
}
export interface QuoteClock {
    now(): number;
}
export interface QuoteExecutionPolicy {
    readonly timeoutMs: number;
    readonly maximumQuotesPerWindow: number;
    readonly rateWindowMs: number;
    readonly localMaximumValidityMs: number;
}
export interface QuoteDependencies {
    readonly quotePort: BoundedQuotePort;
    readonly contracts: ContractValidator;
    readonly clock: QuoteClock;
    readonly trustedScope: TrustedScope;
    readonly policy?: Partial<QuoteExecutionPolicy>;
}
export type ExactMoney = {
    readonly currency: string;
    readonly scale: number;
    readonly decimal: string;
    readonly minorUnits: string;
};
export type QuotedAmount = {
    readonly state: "known";
    readonly value: ExactMoney;
} | {
    readonly state: "unknown";
    readonly reasonCode: QuoteUnknownReason;
};
export type QuoteLeadTime = {
    readonly state: "known";
    readonly minimumDays: number;
    readonly maximumDays: number;
    readonly confidence: "estimate";
} | {
    readonly state: "unknown";
    readonly reasonCode: QuoteUnknownReason;
};
export interface PrivateQuoteBinding {
    readonly tenantId: string;
    readonly projectId: string;
    readonly providerId: string;
    readonly apiVersion: string;
    readonly catalogVersion: string;
    readonly catalogSnapshotIdentity: string;
    readonly catalogContentIdentity: string;
    readonly sku: string;
    readonly variantId: string;
    readonly specIdentity: string;
    readonly selectionDigest: string;
    readonly quantity: number;
    readonly options: readonly string[];
    readonly materials: readonly string[];
    readonly destination: {
        readonly reference: string;
        readonly digest: string;
        readonly countryCode: string;
        readonly regionCode?: string;
    };
    readonly shippingMethod: string;
    readonly requestDigest: string;
}
export interface PrivateQuoteSnapshot {
    readonly localFormat: typeof PRIVATE_QUOTE_FORMAT;
    readonly quoteId: string;
    readonly termsFingerprint: string;
    readonly status: "complete" | "incomplete";
    readonly binding: PrivateQuoteBinding;
    readonly catalogEvidenceMode: CatalogSnapshot["source"]["evidenceMode"];
    readonly providerQuoteReference: string;
    readonly createdAt: string;
    readonly expiry: {
        readonly provider: {
            readonly state: "known";
            readonly validUntil: string;
        } | {
            readonly state: "unknown";
            readonly reasonCode: QuoteUnknownReason;
        };
        readonly localPolicy: {
            readonly version: "quote-local-policy/1";
            readonly validUntil: string;
        };
        readonly effectiveValidUntil: string;
        readonly effectiveSource: "provider" | "local_policy" | "provider_and_local_policy";
    };
    readonly currency: string;
    readonly currencyScale: number;
    readonly breakdown: {
        readonly production: QuotedAmount;
        readonly shipping: QuotedAmount;
        readonly tax: QuotedAmount;
        readonly fee: QuotedAmount;
        readonly total: QuotedAmount;
        readonly taxBasis: "included" | "excluded" | "unknown";
        readonly reconciliation: {
            readonly state: "reconciled";
            readonly expectedTotal: ExactMoney;
        } | {
            readonly state: "incomplete";
            readonly missing: readonly string[];
        };
    };
    readonly leadTime: QuoteLeadTime;
    readonly warnings: readonly string[];
    readonly providerNotes: readonly string[];
    readonly financialEffect: "quote_only";
}
export interface PrivateQuoteResponse {
    readonly quote: PrivateQuoteSnapshot;
    readonly sharedPayload: unknown;
    readonly contractBinding: {
        readonly state: "development_fixture" | "accepted";
        readonly schemaVersion: string;
        readonly sourceRevision?: string;
        readonly fixtureDigest: string;
    };
}
export type QuoteCurrentReason = "quote_integrity_invalid" | "quote_expired" | "quote_incomplete" | "trusted_scope_changed" | "catalog_changed" | "catalog_stale" | "selection_changed" | "destination_changed" | "request_changed" | "selection_ineligible";
export type QuoteRequiredAction = "refresh_catalog" | "revalidate_selection" | "requote" | "obtain_external_authorization" | "renew_external_authorization";
export interface QuoteCurrentEvaluation {
    readonly status: "current" | "stale" | "incomplete" | "invalid";
    readonly reasons: readonly QuoteCurrentReason[];
    readonly requiredActions: readonly QuoteRequiredAction[];
    readonly quoteMayBePresentedForExternalReview: boolean;
}
/**
 * Validates a private catalog selection, invokes one bounded quote-only port,
 * normalizes exact decimal amounts, and delegates canonical encoding to the
 * injected shared-contract boundary. No order, payment, or budget operation is reachable here.
 */
export declare function executePrivateQuote(input: unknown, dependencies: QuoteDependencies): Promise<PrivateQuoteResponse>;
/** Rechecks expiry, scope, catalog, selection, destination, quantity, and shipping before downstream use. */
export declare function evaluatePrivateQuoteCurrent(quoteValue: unknown, currentInput: unknown, dependencies: Pick<QuoteDependencies, "clock" | "trustedScope">): Promise<QuoteCurrentEvaluation>;
