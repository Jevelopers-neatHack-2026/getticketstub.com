const checkedAt = "2026-10-10";
export const PRODIGI_SANDBOX_BASE_URL = "https://api.sandbox.prodigi.com/v4.0";
/**
 * Identifier the offline-tested Prodigi v4 sandbox adapter presents to the
 * policy. Only a request naming this adapter can reach `sandbox_call_permitted`;
 * every other request keeps the prerequisites-only result.
 */
export const PRODIGI_SANDBOX_ADAPTER_ID = "prodigi-v4-sandbox";
export const PRODIGI_SANDBOX_OPERATION_ENDPOINTS = deepFreeze({
    quote: { method: "POST", path: "/v4.0/quotes" },
    submit: { method: "POST", path: "/v4.0/Orders" },
    status: { method: "GET", path: "/v4.0/orders/{prodigi_order_id}" }
});
function deepFreeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
export const PROVIDER_ENVIRONMENT_MATRIX = deepFreeze({
    schemaVersion: "fulfillment-provider-environment-matrix/1",
    checkedAt,
    documentationRevision: "unknown; the official reference does not expose an immutable source revision",
    observedSnapshotDigest: null,
    meaning: "Official documentation observations only; not an accepted provider specification, account test, implementation, or release approval.",
    liveEnabled: false,
    releaseReady: false,
    providers: [
        {
            providerId: "deterministic-simulator",
            mode: "simulated",
            apiVersion: "local-fixture/1",
            status: "local_fixture_only",
            network: "forbidden",
            credentialClass: "none",
            accountTested: false,
            selectedSku: null,
            destinationCountryCode: null,
            shippingMethod: null,
            operations: {
                quote: { documentation: "local_fixture_only", implementation: "local_fixture_only", accountTested: false, details: "Deterministic repository fixtures only; no supplier quote." },
                submit: { documentation: "local_fixture_only", implementation: "local_fixture_only", accountTested: false, details: "Deterministic repository fixtures only; no supplier order." },
                status: { documentation: "local_fixture_only", implementation: "local_fixture_only", accountTested: false, details: "Deterministic repository fixtures only; no supplier status." },
                cancel: { documentation: "local_fixture_only", implementation: "local_fixture_only", accountTested: false, details: "Fixture behavior only; no supplier cancellation." },
                webhook: { documentation: "not_established", implementation: "not_implemented", accountTested: false, details: "No authenticated callback integration." }
            }
        },
        {
            providerId: "prodigi",
            mode: "sandbox",
            apiVersion: "v4.0",
            status: "official_documentation_observed_only",
            endpointBase: PRODIGI_SANDBOX_BASE_URL,
            endpointAllowlist: Object.entries(PRODIGI_SANDBOX_OPERATION_ENDPOINTS).map(([operation, route]) => ({ operation, ...route })),
            credentialClass: "sandbox",
            accountTested: false,
            accountAccess: "unknown",
            selectedSku: null,
            selectedDestinationCountryCode: null,
            selectedShippingMethod: null,
            productAndDestinationSuitability: "pending print-production owner decision",
            sandboxAdapter: {
                adapterId: PRODIGI_SANDBOX_ADAPTER_ID,
                implementation: "offline_fixture_tested",
                accountTested: false,
                callPermittedWhen: "evaluateProviderPolicy returns sandbox_call_permitted: the request names this adapter, uses the sandbox host and credential class, and an injected verifier confirms the owner decision.",
                details: "Quote, order-create and order-read adapter covered by synthetic fixtures only. No request has been sent to Prodigi; per-operation implementation and accountTested fields stay unchanged until sandbox evidence exists."
            },
            documentation: {
                checkedAt,
                revision: "unknown",
                observedSnapshotDigest: null,
                sources: [
                    "https://www.prodigi.com/print-api/docs/reference/",
                    "https://www.prodigi.com/faq/print-api/"
                ],
                interfaceFacts: "The v4 reference documents a sandbox host, X-API-Key authentication, quote, order, product-details and retrieval endpoints. Sandbox is documented as non-charging and non-fulfilling; credentials may differ by environment.",
                skuAndDestination: "The docs include example SKUs and dynamic product details, but no example is selected or accepted here. Product, variant, destination and shipping remain unknown.",
                assetFacts: "General docs describe JPG, PNG and PDF assets; image sizing/product constraints are product-specific. No approved print specification or artifact checks exist here.",
                quoteExpiry: "No quote-expiry guarantee was established in the inspected reference.",
                leadTime: "No selected-SKU and destination lead-time evidence was established.",
                callbackAuthenticity: "The inspected reference documents CloudEvents callbacks but does not establish an authenticity/signature policy; callbacks must remain untrusted hints pending verification."
            },
            operations: {
                quote: { documentation: "documented", implementation: "not_implemented", accountTested: false, details: "POST /v4.0/quotes is documented; exact quote semantics, selected product, and sandbox behavior have not been tested against an account." },
                submit: { documentation: "documented", implementation: "not_implemented", accountTested: false, details: "POST /v4.0/Orders is documented; order creation can enter fulfillment, so only a future approved sandbox path may be considered." },
                status: { documentation: "documented", implementation: "not_implemented", accountTested: false, details: "GET /v4.0/orders/{id} is documented. Complete means shipping notifications for all items, not proof of delivery." },
                cancel: { documentation: "conditional", implementation: "not_implemented", accountTested: false, details: "Cancellation is conditional on per-order action availability and fulfillment state; fees/refunds may vary. Excluded from the initial sandbox slice." },
                webhook: { documentation: "not_established", implementation: "not_implemented", accountTested: false, details: "CloudEvents callbacks are documented; authenticity is not established by the inspected reference. Use trusted polling until an accepted verification policy exists." }
            },
            idempotency: {
                documentation: "documented",
                implementation: "not_implemented",
                accountTested: false,
                providerScope: "account",
                retention: "indefinite according to the reference",
                optional: true,
                merchantReferenceIsUnique: false,
                note: "Provider idempotency does not replace application authorization/action claims or local uncertain-outcome persistence."
            }
        },
        {
            providerId: "other-providers",
            mode: "sandbox_or_live",
            apiVersion: "unknown",
            status: "deferred",
            network: "forbidden",
            credentialClass: "none",
            accountTested: false,
            selectedSku: null,
            destinationCountryCode: null,
            shippingMethod: null,
            operations: {
                quote: { documentation: "deferred", implementation: "deferred", accountTested: false, details: "No support claimed." },
                submit: { documentation: "deferred", implementation: "deferred", accountTested: false, details: "No support claimed." },
                status: { documentation: "deferred", implementation: "deferred", accountTested: false, details: "No support claimed." },
                cancel: { documentation: "deferred", implementation: "deferred", accountTested: false, details: "No support claimed." },
                webhook: { documentation: "deferred", implementation: "deferred", accountTested: false, details: "No support claimed." }
            }
        }
    ]
});
const INPUT_KEYS = new Set([
    "mode",
    "providerId",
    "endpoint",
    "operation",
    "credentialClass",
    "sku",
    "destinationCountryCode",
    "shippingMethod",
    "decisionReference",
    "adapterId"
]);
function readPlainDataRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return undefined;
        const result = Object.create(null);
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string" || !INPUT_KEYS.has(key))
                return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || !("value" in descriptor))
                return undefined;
            result[key] = descriptor.value;
        }
        return result;
    }
    catch {
        return undefined;
    }
}
function assessment(status, mode, providerId, sandboxPreconditionsSatisfied, reasons, sandboxRoute = null) {
    return Object.freeze({
        schemaVersion: "fulfillment-provider-policy-assessment/1",
        status,
        mode,
        providerId,
        sandboxPreconditionsSatisfied,
        sandboxRoute,
        providerAdapterImplemented: status === "sandbox_call_permitted",
        providerCallPermitted: status === "sandbox_call_permitted",
        networkRequests: 0,
        credentialReads: 0,
        secretMaterialReturned: false,
        reasons: Object.freeze([...reasons])
    });
}
function validSandboxEndpoint(value) {
    if (typeof value !== "string")
        return "sandbox_host_not_allowed";
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return "sandbox_host_not_allowed";
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.sandbox.prodigi.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") {
        return "sandbox_host_not_allowed";
    }
    if (parsed.pathname !== "/v4.0" || parsed.search !== "" || parsed.hash !== "" || value !== PRODIGI_SANDBOX_BASE_URL) {
        return "sandbox_path_not_allowed";
    }
    return undefined;
}
function validVerifiedDecision(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "object" || Array.isArray(value))
        return undefined;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return undefined;
        const result = Object.create(null);
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string")
                return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || !("value" in descriptor))
                return undefined;
            result[key] = descriptor.value;
        }
        return result;
    }
    catch {
        return undefined;
    }
}
/**
 * Validate environment policy without resolving credentials or making requests.
 * The default path is the local simulator. A sandbox decision verifier is an
 * explicit trust port; this repository has no implementation of that port.
 */
export async function evaluateProviderPolicy(input, verifier) {
    const fields = input === undefined ? Object.create(null) : readPlainDataRecord(input);
    if (fields === undefined)
        return assessment("blocked", null, null, false, ["invalid_configuration"]);
    const mode = fields.mode === undefined ? "simulated" : fields.mode;
    if (mode !== "simulated" && mode !== "sandbox") {
        return assessment("blocked", null, null, false, ["unsupported_mode"]);
    }
    if (mode === "simulated") {
        const providerId = fields.providerId === undefined ? "deterministic-simulator" : fields.providerId;
        if (providerId !== "deterministic-simulator") {
            return assessment("blocked", "simulated", null, false, ["provider_not_supported"]);
        }
        if ("endpoint" in fields || "credentialClass" in fields || "adapterId" in fields) {
            return assessment("blocked", "simulated", "deterministic-simulator", false, ["simulated_mode_must_be_offline"]);
        }
        return assessment("simulated_offline", "simulated", "deterministic-simulator", false, []);
    }
    if (fields.providerId !== "prodigi") {
        return assessment("blocked", "sandbox", null, false, ["provider_not_supported"]);
    }
    if (fields.adapterId !== undefined && fields.adapterId !== PRODIGI_SANDBOX_ADAPTER_ID) {
        return assessment("blocked", "sandbox", "prodigi", false, ["invalid_configuration"]);
    }
    const endpointFailure = validSandboxEndpoint(fields.endpoint);
    if (endpointFailure !== undefined) {
        return assessment("blocked", "sandbox", "prodigi", false, [endpointFailure]);
    }
    if (fields.credentialClass !== "sandbox") {
        return assessment("blocked", "sandbox", "prodigi", false, ["sandbox_credential_class_required"]);
    }
    if (fields.operation !== "quote" && fields.operation !== "submit" && fields.operation !== "status") {
        return assessment("blocked", "sandbox", "prodigi", false, ["sandbox_operation_not_in_scope"]);
    }
    const operation = fields.operation;
    if (typeof fields.sku !== "string" || fields.sku.trim() === "") {
        return assessment("blocked", "sandbox", "prodigi", false, ["selected_sku_required"]);
    }
    if (typeof fields.destinationCountryCode !== "string" || !/^[A-Z]{2}$/.test(fields.destinationCountryCode)) {
        return assessment("blocked", "sandbox", "prodigi", false, ["destination_required"]);
    }
    if (typeof fields.shippingMethod !== "string" || fields.shippingMethod.trim() === "") {
        return assessment("blocked", "sandbox", "prodigi", false, ["shipping_choice_required"]);
    }
    if (typeof fields.decisionReference !== "string" || fields.decisionReference.trim() === "") {
        return assessment("blocked", "sandbox", "prodigi", false, ["decision_reference_required"]);
    }
    if (verifier === undefined || (typeof verifier !== "object" && typeof verifier !== "function") || verifier === null) {
        return assessment("blocked", "sandbox", "prodigi", false, ["decision_verifier_unavailable"]);
    }
    const request = Object.freeze({
        decisionReference: fields.decisionReference,
        providerId: "prodigi",
        apiVersion: "v4.0",
        sku: fields.sku,
        destinationCountryCode: fields.destinationCountryCode,
        shippingMethod: fields.shippingMethod,
        credentialClass: "sandbox"
    });
    let verifiedRaw;
    let verifyMethod;
    try {
        verifyMethod = verifier.verify;
    }
    catch {
        return assessment("blocked", "sandbox", "prodigi", false, ["decision_unverified"]);
    }
    if (typeof verifyMethod !== "function") {
        return assessment("blocked", "sandbox", "prodigi", false, ["decision_verifier_unavailable"]);
    }
    try {
        verifiedRaw = await verifyMethod.call(verifier, request);
    }
    catch {
        return assessment("blocked", "sandbox", "prodigi", false, ["decision_unverified"]);
    }
    const verified = validVerifiedDecision(verifiedRaw);
    if (verified === undefined) {
        return assessment("blocked", "sandbox", "prodigi", false, ["decision_unverified"]);
    }
    if (verified.decisionReference !== request.decisionReference ||
        verified.providerId !== request.providerId ||
        verified.apiVersion !== request.apiVersion ||
        verified.sku !== request.sku ||
        verified.destinationCountryCode !== request.destinationCountryCode ||
        verified.shippingMethod !== request.shippingMethod ||
        verified.credentialClass !== request.credentialClass ||
        verified.productAndDestinationApproved !== true ||
        verified.sandboxAccountAccessConfirmed !== true) {
        return assessment("blocked", "sandbox", "prodigi", false, ["decision_does_not_match_request"]);
    }
    if (fields.adapterId === PRODIGI_SANDBOX_ADAPTER_ID) {
        return assessment("sandbox_call_permitted", "sandbox", "prodigi", true, [], PRODIGI_SANDBOX_OPERATION_ENDPOINTS[operation]);
    }
    return assessment("sandbox_prerequisites_verified", "sandbox", "prodigi", true, ["provider_adapter_not_implemented"], PRODIGI_SANDBOX_OPERATION_ENDPOINTS[operation]);
}
