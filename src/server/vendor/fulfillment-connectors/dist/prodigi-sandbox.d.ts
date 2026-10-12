import { type SandboxDecisionVerifier } from "./provider-matrix.js";
import { type ServerSecretSource } from "./security.js";
import type { BoundedQuotePort, QuoteProviderRequest, QuoteUnknownReason } from "./quotes.js";
import type { StatusResult } from "./types.js";
/**
 * Prodigi Print API v4 sandbox adapter.
 *
 * Maps the connector's private quote request and a private order-create input
 * to the documented v4 `POST /v4.0/quotes`, `POST /v4.0/Orders` and
 * `GET /v4.0/orders/{id}` requests, and projects the documented responses into
 * bounded, PII-free observations. All network access goes through an injected
 * HTTP port; the module never constructs a live URL and refuses to send unless
 * sandbox calls are explicitly enabled, the owner sandbox decision verifies,
 * and a sandbox-class credential resolves through the secret-reference port.
 */
export declare const PRODIGI_SANDBOX_ORIGIN: "https://api.sandbox.prodigi.com";
export type ProdigiShippingMethod = "Budget" | "Standard" | "StandardPlus" | "Express" | "Overnight";
/** Create-quote spelling: the quote reference lists these lowercase values. */
export type ProdigiQuoteShippingMethod = "budget" | "standard" | "standardplus" | "express" | "overnight";
export type ProdigiSizing = "fillPrintArea" | "fitPrintArea" | "stretchToPrintArea";
export interface ProdigiHttpRequest {
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
}
export interface ProdigiHttpResponse {
    readonly status: number;
    readonly bodyText: string;
}
/** Transport port. Tests inject recorded fixtures; production may use `createFetchProdigiHttpPort`. */
export interface ProdigiHttpPort {
    send(request: ProdigiHttpRequest): Promise<ProdigiHttpResponse>;
}
export interface ProdigiSandboxDecision {
    readonly decisionReference: string;
    readonly sku: string;
    readonly destinationCountryCode: string;
    readonly shippingMethod: ProdigiShippingMethod;
}
export interface ProdigiSandboxClientOptions {
    readonly http: ProdigiHttpPort;
    readonly secrets: ServerSecretSource;
    readonly decision: ProdigiSandboxDecision;
    readonly decisionVerifier: SandboxDecisionVerifier;
    /** Must be exactly `true`. Defaults off so constructing a client sends nothing. */
    readonly sandboxCallsEnabled?: boolean;
    /** Secret reference name; defaults to `prodigi/sandbox/api-key`. Never a raw key. */
    readonly secretReference?: string;
    readonly timeoutMs?: number;
}
export type ProdigiSandboxErrorCode = "sandbox_calls_disabled" | "aborted" | "decision_unverified" | "decision_mismatch" | "invalid_input" | "credential_unavailable" | "authentication_failed" | "validation_failed" | "not_found" | "rate_limited" | "provider_unavailable" | "timeout" | "invalid_response";
/** Whether the provider may have applied the request. Order creation uses `unknown` when uncertain. */
export type ProdigiSideEffectState = "not_dispatched" | "possible" | "confirmed" | "unknown";
export declare class ProdigiSandboxError extends Error {
    readonly code: ProdigiSandboxErrorCode;
    readonly sideEffectState: ProdigiSideEffectState;
    readonly httpStatus: number | null;
    constructor(code: ProdigiSandboxErrorCode, sideEffectState: ProdigiSideEffectState, httpStatus?: number | null);
}
/**
 * Case-insensitive mapping of a configured shipping choice to the documented
 * create-order enum (`Budget`, `Standard`, `StandardPlus`, `Express`, `Overnight`).
 */
export declare function toProdigiShippingMethod(value: unknown): ProdigiShippingMethod;
export interface ProdigiQuoteMappingConfig {
    /** Prodigi attributes approved for the selected SKU (from the print specification). */
    readonly attributes?: Readonly<Record<string, string>>;
    readonly printArea?: string;
    readonly currencyCode: string;
}
/** Maps the connector's private `QuoteProviderRequest` to a v4 create-quote body. */
export declare function mapQuoteRequest(request: QuoteProviderRequest, config: ProdigiQuoteMappingConfig): Readonly<Record<string, unknown>>;
export interface ProdigiOrderRecipientInput {
    readonly name: string;
    readonly email?: string;
    readonly phoneNumber?: string;
    readonly address: {
        readonly line1: string;
        readonly line2?: string;
        readonly postalOrZipCode: string;
        readonly countryCode: string;
        readonly townOrCity: string;
        readonly stateOrCounty?: string;
    };
}
export interface ProdigiOrderItemInput {
    readonly merchantReference?: string;
    readonly sku: string;
    readonly copies: number;
    readonly sizing: ProdigiSizing;
    readonly attributes?: Readonly<Record<string, string>>;
    readonly assets: readonly {
        readonly printArea: string;
        readonly url: string;
        readonly md5Hash?: string;
    }[];
}
/**
 * Private, connector-local order-create input. The recipient is expected to be
 * resolved server-side from an encrypted scoped reference immediately before
 * the call; it is sent to Prodigi and never returned, logged or persisted here.
 */
export interface ProdigiOrderCreateInput {
    readonly merchantReference: string;
    readonly idempotencyKey: string;
    readonly shippingMethod: string;
    readonly recipient: ProdigiOrderRecipientInput;
    readonly items: readonly ProdigiOrderItemInput[];
}
/** Maps the private order-create input to a v4 create-order body. No callback URL or metadata is sent. */
export declare function mapOrderRequest(input: ProdigiOrderCreateInput): Readonly<Record<string, unknown>>;
/** Provider quote shape consumed by `executePrivateQuote` (see quotes.ts). */
export interface ProdigiProviderQuote {
    readonly providerQuoteReference: string;
    readonly currency: string;
    readonly currencyScale: number;
    readonly breakdown: {
        readonly production: ProviderAmount;
        readonly shipping: ProviderAmount;
        readonly tax: ProviderAmount;
        readonly fee: ProviderAmount;
    };
    readonly taxBasis: "included" | "excluded" | "unknown";
    readonly total: ProviderAmount;
    readonly providerExpiry: {
        readonly state: "unknown";
        readonly reasonCode: QuoteUnknownReason;
    };
    readonly leadTime: {
        readonly state: "unknown";
        readonly reasonCode: QuoteUnknownReason;
    };
    readonly warnings: readonly string[];
    readonly providerNotes: readonly string[];
}
type ProviderAmount = {
    readonly state: "known";
    readonly decimal: string;
} | {
    readonly state: "unknown";
    readonly reasonCode: QuoteUnknownReason;
};
/**
 * Projects a v4 create-quote response for one requested shipping method.
 *
 * - `production` = `costSummary.items`, `shipping` = `costSummary.shipping`.
 * - `fee` = `costSummary.branding`; this adapter never requests branded inserts,
 *   so an absent branding cost is an explicit known zero.
 * - `tax` = `costSummary.totalTax`, `total` = `costSummary.totalCost`; absent
 *   values stay unknown, never zero.
 * - The docs say `totalCost` includes tax but not whether line amounts already
 *   include it, so the tax basis is taken from exact reconciliation only:
 *   lines + tax = total gives `excluded`, lines = total with tax > 0 gives
 *   `included`, anything else is `unknown`.
 * - Prodigi documents no quote identifier or expiry; the reference is a local
 *   digest and expiry and lead time are reported as undisclosed.
 */
export declare function projectQuoteResponse(body: unknown, expected: {
    readonly shippingMethod: ProdigiShippingMethod;
    readonly currencyCode: string;
    readonly requestDigest: string;
}, httpStatus?: number): ProdigiProviderQuote;
export type ProdigiOrderStage = "InProgress" | "Complete" | "Cancelled";
export type ProdigiStepState = "NotStarted" | "InProgress" | "Complete" | "Error";
/**
 * PII-free order observation. Recipient, asset URLs, tracking numbers and URLs,
 * charges and metadata are dropped. A tracking number can reveal the delivery
 * town and signer, so only its presence is kept.
 */
export interface ProdigiOrderObservation {
    readonly outcome: string;
    readonly orderId: string;
    readonly created: string;
    readonly lastUpdated: string | null;
    readonly stage: ProdigiOrderStage;
    readonly details: Readonly<Record<"downloadAssets" | "printReadyAssetsPrepared" | "allocateProductionLocation" | "inProduction" | "shipping", ProdigiStepState>>;
    readonly issueCodes: readonly string[];
    readonly shipments: readonly {
        readonly id: string;
        readonly status: string;
        /** Display-only; `null` when absent or not plain text. */
        readonly carrier: string | null;
        readonly hasTrackingNumber: boolean;
        readonly dispatchDate: string | null;
    }[];
    readonly normalizedState: StatusResult["normalizedState"];
}
export declare function projectOrderResponse(body: unknown, allowedOutcomes: readonly string[], sideEffect: ProdigiSideEffectState, httpStatus?: number): ProdigiOrderObservation;
export declare class ProdigiSandboxClient {
    #private;
    constructor(options: ProdigiSandboxClientOptions);
    get decision(): ProdigiSandboxDecision;
    /** Creates a quote for the verified decision. Quotes are non-charging and create no order. */
    createQuote(request: QuoteProviderRequest, config: ProdigiQuoteMappingConfig, signal?: AbortSignal): Promise<ProdigiProviderQuote>;
    /** Creates a sandbox order. Uncertain transport outcomes report `sideEffectState: "unknown"`. */
    createOrder(input: ProdigiOrderCreateInput, signal?: AbortSignal): Promise<ProdigiOrderObservation>;
    /** Reads one order by Prodigi order ID. */
    getOrder(orderId: string, signal?: AbortSignal): Promise<ProdigiOrderObservation>;
}
/**
 * Adapts the client to the existing `BoundedQuotePort` so `executePrivateQuote`
 * can normalize Prodigi quotes. The port exposes no order or payment method.
 */
export declare function createProdigiQuotePort(client: ProdigiSandboxClient, config: ProdigiQuoteMappingConfig): BoundedQuotePort;
/** Map an order observation to the runtime's `StatusResult`. */
export declare function toStatusResult(observation: ProdigiOrderObservation, observedAt: string): StatusResult;
/**
 * Fetch-backed HTTP port with redirects disabled and a body bounded while
 * streaming. It is only ever handed URLs under the fixed sandbox origin by the
 * client above.
 */
export declare function createFetchProdigiHttpPort(fetchImpl?: typeof fetch): ProdigiHttpPort;
export {};
