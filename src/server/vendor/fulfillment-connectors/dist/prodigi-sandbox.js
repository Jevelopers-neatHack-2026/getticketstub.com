import { createHash } from "node:crypto";
import { evaluateProviderPolicy, PRODIGI_SANDBOX_ADAPTER_ID, PRODIGI_SANDBOX_BASE_URL, PRODIGI_SANDBOX_OPERATION_ENDPOINTS } from "./provider-matrix.js";
import { withServerSecret } from "./security.js";
import { PRODIGI_SANDBOX_SECRET_BINDING } from "./prodigi-secrets.js";
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
export const PRODIGI_SANDBOX_ORIGIN = "https://api.sandbox.prodigi.com";
const ERROR_MESSAGES = {
    sandbox_calls_disabled: "Prodigi sandbox calls are disabled.",
    aborted: "The Prodigi request was aborted before it was sent.",
    decision_unverified: "The owner sandbox decision could not be verified.",
    decision_mismatch: "The request does not match the verified sandbox decision.",
    invalid_input: "The Prodigi request input did not pass validation.",
    credential_unavailable: "The Prodigi sandbox credential is unavailable.",
    authentication_failed: "Prodigi rejected the sandbox credential.",
    validation_failed: "Prodigi rejected the request as invalid.",
    not_found: "Prodigi did not find the requested entity.",
    rate_limited: "Prodigi rate-limited the request.",
    provider_unavailable: "Prodigi was unavailable or returned an unexpected status.",
    timeout: "The Prodigi request timed out.",
    invalid_response: "The Prodigi response is invalid or unsupported."
};
export class ProdigiSandboxError extends Error {
    code;
    sideEffectState;
    httpStatus;
    constructor(code, sideEffectState, httpStatus = null) {
        super(ERROR_MESSAGES[code]);
        this.name = "ProdigiSandboxError";
        this.code = code;
        this.sideEffectState = sideEffectState;
        this.httpStatus = httpStatus;
    }
}
// ---------------------------------------------------------------------------
// Input validation helpers
const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const CURRENCY_SCALES = Object.freeze({ USD: 2, GBP: 2, EUR: 2, CAD: 2, AUD: 2 });
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const PRINT_AREA_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]{1,64}$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const MD5_PATTERN = /^[a-f0-9]{32}$/u;
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/u;
const ISSUE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._]{0,127}$/u;
const MAX_RESPONSE_CHARS = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const SHIPPING_METHODS = Object.freeze({
    budget: "Budget",
    standard: "Standard",
    standardplus: "StandardPlus",
    express: "Express",
    overnight: "Overnight"
});
function invalidInput() {
    throw new ProdigiSandboxError("invalid_input", "not_dispatched");
}
function invalidResponse(sideEffectState, httpStatus) {
    throw new ProdigiSandboxError("invalid_response", sideEffectState, httpStatus);
}
/**
 * Case-insensitive mapping of a configured shipping choice to the documented
 * create-order enum (`Budget`, `Standard`, `StandardPlus`, `Express`, `Overnight`).
 */
export function toProdigiShippingMethod(value) {
    if (typeof value !== "string")
        return invalidInput();
    const key = value.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SHIPPING_METHODS, key))
        return invalidInput();
    return SHIPPING_METHODS[key];
}
function boundedText(value, max, optional) {
    if (value === undefined && optional)
        return undefined;
    if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value ||
        /[\u0000-\u001F\u007F]/u.test(value))
        return invalidInput();
    return value;
}
function attributesOf(value) {
    if (value === undefined)
        return Object.freeze({});
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return invalidInput();
    const entries = Object.entries(value);
    if (entries.length > 16)
        return invalidInput();
    const result = {};
    for (const [key, attribute] of entries) {
        if (!ATTRIBUTE_KEY_PATTERN.test(key))
            return invalidInput();
        result[key] = boundedText(attribute, 64, false);
    }
    return Object.freeze(result);
}
function httpsAssetUrl(value) {
    const text = boundedText(value, 2048, false);
    let parsed;
    try {
        parsed = new URL(text);
    }
    catch {
        return invalidInput();
    }
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "")
        return invalidInput();
    return text;
}
/**
 * The create-quote reference documents `shippingMethod` as `budget`,
 * `standard`, `standardplus`, `express` or `overnight`, while create-order uses
 * PascalCase. Each endpoint gets its own documented spelling.
 */
function toQuoteShippingMethod(method) {
    return method.toLowerCase();
}
/** Maps the connector's private `QuoteProviderRequest` to a v4 create-quote body. */
export function mapQuoteRequest(request, config) {
    if (request === null || typeof request !== "object")
        return invalidInput();
    if (request.providerId !== "prodigi")
        return invalidInput();
    if (typeof request.sku !== "string" || !SKU_PATTERN.test(request.sku))
        return invalidInput();
    if (!Number.isSafeInteger(request.quantity) || request.quantity < 1 || request.quantity > 1000)
        return invalidInput();
    const countryCode = request.destination?.countryCode;
    if (typeof countryCode !== "string" || !COUNTRY_PATTERN.test(countryCode))
        return invalidInput();
    if (request.personalization !== null)
        return invalidInput();
    const currencyCode = config.currencyCode;
    if (typeof currencyCode !== "string" || CURRENCY_SCALES[currencyCode] === undefined)
        return invalidInput();
    const printArea = config.printArea ?? "default";
    if (!PRINT_AREA_PATTERN.test(printArea))
        return invalidInput();
    return Object.freeze({
        shippingMethod: toQuoteShippingMethod(toProdigiShippingMethod(request.shippingMethod)),
        destinationCountryCode: countryCode,
        currencyCode,
        items: [{
                sku: request.sku,
                copies: request.quantity,
                attributes: attributesOf(config.attributes),
                assets: [{ printArea }]
            }]
    });
}
/** Maps the private order-create input to a v4 create-order body. No callback URL or metadata is sent. */
export function mapOrderRequest(input) {
    if (input === null || typeof input !== "object")
        return invalidInput();
    const merchantReference = boundedText(input.merchantReference, 100, false);
    const idempotencyKey = boundedText(input.idempotencyKey, 100, false);
    if (!REFERENCE_PATTERN.test(merchantReference) || !REFERENCE_PATTERN.test(idempotencyKey))
        return invalidInput();
    const recipient = input.recipient;
    if (recipient === null || typeof recipient !== "object")
        return invalidInput();
    const address = recipient.address;
    if (address === null || typeof address !== "object")
        return invalidInput();
    if (typeof address.countryCode !== "string" || !COUNTRY_PATTERN.test(address.countryCode))
        return invalidInput();
    const mappedAddress = {
        line1: boundedText(address.line1, 256, false),
        postalOrZipCode: boundedText(address.postalOrZipCode, 32, false),
        countryCode: address.countryCode,
        townOrCity: boundedText(address.townOrCity, 128, false)
    };
    const line2 = boundedText(address.line2, 256, true);
    if (line2 !== undefined)
        mappedAddress.line2 = line2;
    const stateOrCounty = boundedText(address.stateOrCounty, 128, true);
    if (stateOrCounty !== undefined)
        mappedAddress.stateOrCounty = stateOrCounty;
    const mappedRecipient = { name: boundedText(recipient.name, 256, false), address: mappedAddress };
    const email = boundedText(recipient.email, 254, true);
    if (email !== undefined)
        mappedRecipient.email = email;
    const phoneNumber = boundedText(recipient.phoneNumber, 32, true);
    if (phoneNumber !== undefined)
        mappedRecipient.phoneNumber = phoneNumber;
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10)
        return invalidInput();
    const items = input.items.map((item) => {
        if (item === null || typeof item !== "object")
            return invalidInput();
        if (typeof item.sku !== "string" || !SKU_PATTERN.test(item.sku))
            return invalidInput();
        if (!Number.isSafeInteger(item.copies) || item.copies < 1 || item.copies > 1000)
            return invalidInput();
        if (item.sizing !== "fillPrintArea" && item.sizing !== "fitPrintArea" && item.sizing !== "stretchToPrintArea")
            return invalidInput();
        if (!Array.isArray(item.assets) || item.assets.length < 1 || item.assets.length > 8)
            return invalidInput();
        const assets = item.assets.map((raw) => {
            const asset = raw;
            if (asset === null || typeof asset !== "object" || typeof asset.printArea !== "string" || !PRINT_AREA_PATTERN.test(asset.printArea)) {
                return invalidInput();
            }
            const mapped = { printArea: asset.printArea, url: httpsAssetUrl(asset.url) };
            if (asset.md5Hash !== undefined) {
                if (typeof asset.md5Hash !== "string" || !MD5_PATTERN.test(asset.md5Hash))
                    return invalidInput();
                mapped.md5Hash = asset.md5Hash;
            }
            return mapped;
        });
        const mapped = { sku: item.sku, copies: item.copies, sizing: item.sizing, attributes: attributesOf(item.attributes), assets };
        const itemReference = boundedText(item.merchantReference, 100, true);
        if (itemReference !== undefined) {
            if (!REFERENCE_PATTERN.test(itemReference))
                return invalidInput();
            mapped.merchantReference = itemReference;
        }
        return mapped;
    });
    return Object.freeze({
        merchantReference,
        idempotencyKey,
        shippingMethod: toProdigiShippingMethod(input.shippingMethod),
        recipient: mappedRecipient,
        items
    });
}
function record(value, sideEffect, status) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return invalidResponse(sideEffect, status);
    return value;
}
function outcomeOf(body) {
    return typeof body.outcome === "string" ? body.outcome.toLowerCase() : "";
}
function issueCodes(value, sideEffect, status) {
    if (value === undefined || value === null)
        return Object.freeze([]);
    if (!Array.isArray(value) || value.length > 64)
        return invalidResponse(sideEffect, status);
    const codes = [];
    for (const issue of value) {
        const code = record(issue, sideEffect, status).errorCode;
        if (typeof code !== "string" || !ISSUE_CODE_PATTERN.test(code))
            return invalidResponse(sideEffect, status);
        if (!codes.includes(code))
            codes.push(code);
    }
    return Object.freeze(codes.slice(0, 16));
}
function money(value, currency, scale, status) {
    if (value === undefined || value === null)
        return undefined;
    const cost = record(value, "not_dispatched", status);
    if (cost.currency !== currency || typeof cost.amount !== "string" || !AMOUNT_PATTERN.test(cost.amount)) {
        return invalidResponse("not_dispatched", status);
    }
    const [whole = "0", fraction = ""] = cost.amount.split(".");
    if (fraction.length > scale)
        return invalidResponse("not_dispatched", status);
    const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
    return { decimal: cost.amount, minor };
}
function known(value) {
    return value === undefined ? { state: "unknown", reasonCode: "not_provided" } : { state: "known", decimal: value.decimal };
}
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
export function projectQuoteResponse(body, expected, httpStatus = 200) {
    const scale = CURRENCY_SCALES[expected.currencyCode];
    if (scale === undefined)
        return invalidInput();
    const envelope = record(body, "not_dispatched", httpStatus);
    const outcome = outcomeOf(envelope);
    if (outcome !== "created" && outcome !== "createdwithissues")
        return invalidResponse("not_dispatched", httpStatus);
    const quotes = envelope.quotes;
    if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > 8)
        return invalidResponse("not_dispatched", httpStatus);
    const matching = quotes.filter((quote) => {
        const method = record(quote, "not_dispatched", httpStatus).shipmentMethod;
        return typeof method === "string" && method.toLowerCase() === expected.shippingMethod.toLowerCase();
    });
    if (matching.length !== 1)
        return invalidResponse("not_dispatched", httpStatus);
    const quote = record(matching[0], "not_dispatched", httpStatus);
    const summary = record(quote.costSummary, "not_dispatched", httpStatus);
    const currency = expected.currencyCode;
    const items = money(summary.items, currency, scale, httpStatus);
    const shipping = money(summary.shipping, currency, scale, httpStatus);
    if (items === undefined || shipping === undefined)
        return invalidResponse("not_dispatched", httpStatus);
    const fee = money(summary.branding, currency, scale, httpStatus) ?? { decimal: "0", minor: 0n };
    const tax = money(summary.totalTax, currency, scale, httpStatus);
    const total = money(summary.totalCost, currency, scale, httpStatus);
    let taxBasis = "unknown";
    if (tax !== undefined && total !== undefined) {
        const lines = items.minor + shipping.minor + fee.minor;
        if (lines + tax.minor === total.minor)
            taxBasis = "excluded";
        else if (lines === total.minor && tax.minor > 0n && tax.minor <= total.minor)
            taxBasis = "included";
    }
    const warnings = [
        ...issueCodes(envelope.issues, "not_dispatched", httpStatus),
        ...issueCodes(quote.issues, "not_dispatched", httpStatus)
    ].filter((code, index, all) => all.indexOf(code) === index).slice(0, 16);
    const digest = createHash("sha256")
        .update(JSON.stringify([expected.requestDigest, expected.shippingMethod, currency, items.decimal, shipping.decimal,
        fee.decimal, tax?.decimal ?? null, total?.decimal ?? null]))
        .digest("hex");
    return Object.freeze({
        providerQuoteReference: `prodigi-quote:sha256-${digest}`,
        currency,
        currencyScale: scale,
        breakdown: Object.freeze({ production: known(items), shipping: known(shipping), tax: known(tax), fee: known(fee) }),
        taxBasis,
        total: known(total),
        providerExpiry: Object.freeze({ state: "unknown", reasonCode: "not_disclosed" }),
        leadTime: Object.freeze({ state: "unknown", reasonCode: "not_disclosed" }),
        warnings: Object.freeze(warnings),
        providerNotes: Object.freeze([])
    });
}
const STAGES = Object.freeze({ inprogress: "InProgress", complete: "Complete", cancelled: "Cancelled" });
const STEP_STATES = Object.freeze({
    notstarted: "NotStarted", inprogress: "InProgress", complete: "Complete", error: "Error"
});
const DETAIL_KEYS = ["downloadAssets", "printReadyAssetsPrepared", "allocateProductionLocation", "inProduction", "shipping"];
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/u;
const SHORT_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{0,127}$/u;
const CARRIER_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:/#()&,'+-]{0,127}$/u;
function lookup(table, value) {
    if (typeof value !== "string")
        return undefined;
    const key = value.toLowerCase();
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
function optionalShort(value, sideEffect, status) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string" || !SHORT_TEXT.test(value))
        return invalidResponse(sideEffect, status);
    return value;
}
/** Display-only optional text degrades to `null` instead of failing the whole read. */
function lenientText(value, pattern) {
    return typeof value === "string" && pattern.test(value) ? value : null;
}
/**
 * Status mapping. `Complete` means shipping notifications were sent for all
 * items, not delivery, so it maps to `shipped`. Any step in `Error` maps to
 * `unknown` because the docs do not say whether such errors are terminal.
 */
function normalizeOrderState(stage, details) {
    if (stage === "Cancelled")
        return "cancelled";
    if (stage === "Complete")
        return "shipped";
    if (DETAIL_KEYS.some((key) => details[key] === "Error"))
        return "unknown";
    if (details.shipping !== "NotStarted")
        return "in_production";
    if (details.inProduction !== "NotStarted")
        return "in_production";
    return "accepted";
}
export function projectOrderResponse(body, allowedOutcomes, sideEffect, httpStatus = 200) {
    const envelope = record(body, sideEffect, httpStatus);
    const outcome = outcomeOf(envelope);
    if (!allowedOutcomes.includes(outcome))
        return invalidResponse(sideEffect, httpStatus);
    const order = record(envelope.order, sideEffect, httpStatus);
    if (typeof order.id !== "string" || !ORDER_ID_PATTERN.test(order.id))
        return invalidResponse(sideEffect, httpStatus);
    if (typeof order.created !== "string" || !TIMESTAMP_PATTERN.test(order.created))
        return invalidResponse(sideEffect, httpStatus);
    const lastUpdated = order.lastUpdated === undefined || order.lastUpdated === null ? null : order.lastUpdated;
    if (lastUpdated !== null && (typeof lastUpdated !== "string" || !TIMESTAMP_PATTERN.test(lastUpdated)))
        return invalidResponse(sideEffect, httpStatus);
    const status = record(order.status, sideEffect, httpStatus);
    const stage = lookup(STAGES, status.stage);
    if (stage === undefined)
        return invalidResponse(sideEffect, httpStatus);
    const rawDetails = record(status.details, sideEffect, httpStatus);
    const details = {};
    for (const key of DETAIL_KEYS) {
        const state = lookup(STEP_STATES, rawDetails[key]);
        if (state === undefined)
            return invalidResponse(sideEffect, httpStatus);
        details[key] = state;
    }
    const rawShipments = order.shipments ?? [];
    if (!Array.isArray(rawShipments) || rawShipments.length > 64)
        return invalidResponse(sideEffect, httpStatus);
    const shipments = rawShipments.map((raw) => {
        const shipment = record(raw, sideEffect, httpStatus);
        const id = optionalShort(shipment.id, sideEffect, httpStatus);
        const shipmentStatus = optionalShort(shipment.status, sideEffect, httpStatus);
        if (id === null || shipmentStatus === null)
            return invalidResponse(sideEffect, httpStatus);
        const carrierRecord = shipment.carrier;
        const carrier = carrierRecord !== null && typeof carrierRecord === "object" && !Array.isArray(carrierRecord)
            ? lenientText(carrierRecord.name, CARRIER_TEXT)
            : lenientText(carrierRecord, CARRIER_TEXT);
        const tracking = shipment.tracking;
        const trackingNumber = tracking !== null && typeof tracking === "object" && !Array.isArray(tracking)
            ? tracking.number
            : undefined;
        const hasTrackingNumber = typeof trackingNumber === "string" && trackingNumber.trim() !== "";
        const dispatchDate = shipment.dispatchDate;
        if (dispatchDate !== undefined && dispatchDate !== null && (typeof dispatchDate !== "string" || !TIMESTAMP_PATTERN.test(dispatchDate))) {
            return invalidResponse(sideEffect, httpStatus);
        }
        return Object.freeze({ id, status: shipmentStatus, carrier, hasTrackingNumber, dispatchDate: dispatchDate ?? null });
    });
    const frozenDetails = Object.freeze(details);
    return Object.freeze({
        outcome,
        orderId: order.id,
        created: order.created,
        lastUpdated: lastUpdated,
        stage,
        details: frozenDetails,
        issueCodes: issueCodes(status.issues, sideEffect, httpStatus),
        shipments: Object.freeze(shipments),
        normalizedState: normalizeOrderState(stage, frozenDetails)
    });
}
function classifyHttpFailure(status, operation) {
    // For order creation, only explicit client errors prove the order was not created.
    const ambiguous = operation === "submit" ? "unknown" : "not_dispatched";
    if (status === 401 || status === 403)
        return new ProdigiSandboxError("authentication_failed", "not_dispatched", status);
    if (status === 400)
        return new ProdigiSandboxError("validation_failed", "not_dispatched", status);
    if (status === 404)
        return new ProdigiSandboxError("not_found", "not_dispatched", status);
    if (status === 429)
        return new ProdigiSandboxError("rate_limited", "not_dispatched", status);
    return new ProdigiSandboxError("provider_unavailable", ambiguous, status);
}
export class ProdigiSandboxClient {
    #http;
    #secrets;
    #decision;
    #verifier;
    #enabled;
    #secretReference;
    #timeoutMs;
    constructor(options) {
        if (options === null || typeof options !== "object")
            throw new ProdigiSandboxError("invalid_input", "not_dispatched");
        if (options.http === null || typeof options.http !== "object" || typeof options.http.send !== "function")
            throw new ProdigiSandboxError("invalid_input", "not_dispatched");
        if (options.secrets === null || typeof options.secrets !== "object" || typeof options.secrets.load !== "function")
            throw new ProdigiSandboxError("invalid_input", "not_dispatched");
        const decision = options.decision;
        if (decision === null || typeof decision !== "object" || typeof decision.sku !== "string" || !SKU_PATTERN.test(decision.sku) ||
            typeof decision.destinationCountryCode !== "string" || !COUNTRY_PATTERN.test(decision.destinationCountryCode) ||
            typeof decision.decisionReference !== "string" || decision.decisionReference.trim() === "") {
            throw new ProdigiSandboxError("invalid_input", "not_dispatched");
        }
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
            throw new ProdigiSandboxError("invalid_input", "not_dispatched");
        const secretReference = options.secretReference ?? PRODIGI_SANDBOX_SECRET_BINDING.reference;
        if (typeof secretReference !== "string" || secretReference.length === 0)
            throw new ProdigiSandboxError("invalid_input", "not_dispatched");
        this.#http = options.http;
        this.#secrets = options.secrets;
        this.#decision = Object.freeze({
            decisionReference: decision.decisionReference,
            sku: decision.sku,
            destinationCountryCode: decision.destinationCountryCode,
            shippingMethod: toProdigiShippingMethod(decision.shippingMethod)
        });
        this.#verifier = options.decisionVerifier;
        this.#enabled = options.sandboxCallsEnabled === true;
        this.#secretReference = secretReference;
        this.#timeoutMs = timeoutMs;
    }
    get decision() {
        return this.#decision;
    }
    /** Creates a quote for the verified decision. Quotes are non-charging and create no order. */
    async createQuote(request, config, signal) {
        const body = mapQuoteRequest(request, config);
        const shippingMethod = toProdigiShippingMethod(body.shippingMethod);
        this.#assertMatchesDecision(request.sku, request.destination.countryCode, shippingMethod);
        const result = await this.#send("quote", "POST", PRODIGI_SANDBOX_OPERATION_ENDPOINTS.quote.path, body, signal);
        return projectQuoteResponse(result, {
            shippingMethod,
            currencyCode: config.currencyCode,
            requestDigest: request.requestDigest
        });
    }
    /** Creates a sandbox order. Uncertain transport outcomes report `sideEffectState: "unknown"`. */
    async createOrder(input, signal) {
        const body = mapOrderRequest(input);
        const items = body.items;
        for (const item of items) {
            this.#assertMatchesDecision(item.sku, body.recipient.address.countryCode, body.shippingMethod);
        }
        const result = await this.#send("submit", "POST", PRODIGI_SANDBOX_OPERATION_ENDPOINTS.submit.path, body, signal);
        return projectOrderResponse(result, ["created", "onhold", "createdwithissues", "alreadyexists"], "unknown");
    }
    /** Reads one order by Prodigi order ID. */
    async getOrder(orderId, signal) {
        if (typeof orderId !== "string" || !ORDER_ID_PATTERN.test(orderId))
            return invalidInput();
        const path = PRODIGI_SANDBOX_OPERATION_ENDPOINTS.status.path.replace("{prodigi_order_id}", orderId);
        const result = await this.#send("status", "GET", path, undefined, signal);
        return projectOrderResponse(result, ["ok"], "not_dispatched");
    }
    #assertMatchesDecision(sku, countryCode, shippingMethod) {
        if (sku !== this.#decision.sku || countryCode !== this.#decision.destinationCountryCode || shippingMethod !== this.#decision.shippingMethod) {
            throw new ProdigiSandboxError("decision_mismatch", "not_dispatched");
        }
    }
    async #send(operation, method, path, body, signal) {
        if (!this.#enabled)
            throw new ProdigiSandboxError("sandbox_calls_disabled", "not_dispatched");
        if (isAborted(signal))
            throw new ProdigiSandboxError("aborted", "not_dispatched");
        const policy = await evaluateProviderPolicy({
            adapterId: PRODIGI_SANDBOX_ADAPTER_ID,
            mode: "sandbox",
            providerId: "prodigi",
            endpoint: PRODIGI_SANDBOX_BASE_URL,
            operation,
            credentialClass: "sandbox",
            sku: this.#decision.sku,
            destinationCountryCode: this.#decision.destinationCountryCode,
            shippingMethod: this.#decision.shippingMethod,
            decisionReference: this.#decision.decisionReference
        }, this.#verifier);
        // The policy is the source of truth: only `sandbox_call_permitted` with
        // `providerCallPermitted: true` for this exact route may dispatch.
        if (policy.status !== "sandbox_call_permitted" || policy.providerCallPermitted !== true ||
            policy.sandboxRoute?.method !== method || policy.sandboxRoute.path !== PRODIGI_SANDBOX_OPERATION_ENDPOINTS[operation].path) {
            throw new ProdigiSandboxError("decision_unverified", "not_dispatched");
        }
        // Paths come only from the fixed endpoint table; the origin is the fixed sandbox host.
        if (!path.startsWith("/v4.0/"))
            throw new ProdigiSandboxError("invalid_input", "not_dispatched");
        const url = `${PRODIGI_SANDBOX_ORIGIN}${path}`;
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const http = this.#http;
        const timeoutMs = this.#timeoutMs;
        const uncertain = operation === "submit" ? "unknown" : "not_dispatched";
        const dispatch = { dispatched: false };
        let outcome;
        try {
            outcome = await withServerSecret({
                providerId: "prodigi",
                secretReference: this.#secretReference,
                mode: "sandbox",
                source: this.#secrets,
                use: async ({ secret }) => sendWithSecret(http, operation, method, url, payload, secret, timeoutMs, signal, dispatch)
            });
        }
        catch {
            // Once the request was handed to the port, the provider may have applied
            // it: an order may or may not exist, so the outcome is unknown.
            if (dispatch.dispatched)
                throw new ProdigiSandboxError("provider_unavailable", uncertain);
            throw new ProdigiSandboxError("credential_unavailable", "not_dispatched");
        }
        if (!outcome.ok)
            throw outcome.error ?? new ProdigiSandboxError("provider_unavailable", uncertain);
        return outcome.body;
    }
}
function isAborted(signal) {
    if (signal === undefined)
        return false;
    try {
        return signal.aborted === true;
    }
    catch {
        return true;
    }
}
async function sendWithSecret(http, operation, method, url, payload, secret, timeoutMs, external, dispatch) {
    const uncertain = operation === "submit" ? "unknown" : "not_dispatched";
    // The signal may have aborted while the policy or secret was resolving.
    if (isAborted(external))
        return { ok: false, status: 0, error: new ProdigiSandboxError("aborted", "not_dispatched") };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    try {
        external?.addEventListener("abort", onAbort, { once: true });
    }
    catch {
        return { ok: false, status: 0, error: new ProdigiSandboxError("invalid_input", "not_dispatched") };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const headers = { "X-API-Key": secret, Accept: "application/json" };
    if (payload !== undefined)
        headers["Content-Type"] = "application/json";
    let status;
    let text;
    try {
        dispatch.dispatched = true;
        const response = await http.send(Object.freeze({
            method,
            url,
            headers: Object.freeze(headers),
            ...(payload === undefined ? {} : { body: payload }),
            signal: controller.signal
        }));
        // Every response field is read inside the try: a throwing getter after
        // dispatch is an uncertain outcome, never "not dispatched".
        if (response === null || typeof response !== "object") {
            return { ok: false, status: 0, error: new ProdigiSandboxError("invalid_response", uncertain) };
        }
        const rawStatus = response.status;
        if (typeof rawStatus !== "number" || !Number.isSafeInteger(rawStatus)) {
            return { ok: false, status: 0, error: new ProdigiSandboxError("invalid_response", uncertain) };
        }
        status = rawStatus;
        if (status < 200 || status > 299)
            return { ok: false, status, error: classifyHttpFailure(status, operation) };
        text = response.bodyText;
    }
    catch {
        const error = timedOut
            ? new ProdigiSandboxError("timeout", uncertain)
            : new ProdigiSandboxError("provider_unavailable", uncertain);
        return { ok: false, status: 0, error };
    }
    finally {
        clearTimeout(timer);
        try {
            external?.removeEventListener("abort", onAbort);
        }
        catch {
            // Listener cleanup failure cannot change the dispatched outcome.
        }
    }
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_RESPONSE_CHARS) {
        return { ok: false, status, error: new ProdigiSandboxError("invalid_response", uncertain, status) };
    }
    try {
        return { ok: true, status, body: JSON.parse(text) };
    }
    catch {
        return { ok: false, status, error: new ProdigiSandboxError("invalid_response", uncertain, status) };
    }
}
/**
 * Adapts the client to the existing `BoundedQuotePort` so `executePrivateQuote`
 * can normalize Prodigi quotes. The port exposes no order or payment method.
 */
export function createProdigiQuotePort(client, config) {
    return Object.freeze({
        async quote(request, context) {
            return client.createQuote(request, config, context.signal);
        }
    });
}
/** Map an order observation to the runtime's `StatusResult`. */
export function toStatusResult(observation, observedAt) {
    return Object.freeze({
        providerRequestId: observation.orderId,
        providerStatus: observation.stage,
        normalizedState: observation.normalizedState,
        observedAt
    });
}
/**
 * Reads at most `MAX_RESPONSE_BYTES` while streaming and cancels the body past
 * the limit. An oversized body becomes `""`, which the client rejects.
 */
async function readBoundedBody(response) {
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return "";
    }
    const body = response.body;
    if (body === null || body === undefined)
        return "";
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            return "";
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}
/**
 * Fetch-backed HTTP port with redirects disabled and a body bounded while
 * streaming. It is only ever handed URLs under the fixed sandbox origin by the
 * client above.
 */
export function createFetchProdigiHttpPort(fetchImpl = globalThis.fetch) {
    return Object.freeze({
        async send(request) {
            if (!request.url.startsWith(`${PRODIGI_SANDBOX_ORIGIN}/`))
                throw new Error("refused");
            const response = await fetchImpl(request.url, {
                method: request.method,
                headers: request.headers,
                ...(request.body === undefined ? {} : { body: request.body }),
                redirect: "error",
                signal: request.signal
            });
            const status = response.status;
            if (status < 200 || status > 299) {
                await response.body?.cancel().catch(() => undefined);
                return { status, bodyText: "" };
            }
            return { status, bodyText: await readBoundedBody(response) };
        }
    });
}
