const RESOLVER_MESSAGES = {
    invalid_binding: "A secret reference binding is invalid.",
    duplicate_binding: "A secret reference or environment variable is bound more than once.",
    live_binding_refused: "Live credential bindings are disabled.",
    class_name_mismatch: "The environment variable name does not match its credential class."
};
export class SecretResolverError extends Error {
    code;
    constructor(code) {
        super(RESOLVER_MESSAGES[code]);
        this.name = "SecretResolverError";
        this.code = code;
    }
}
/** The only predeclared binding. No live binding (and no `PRODIGI_API_KEY`) is defined. */
export const PRODIGI_SANDBOX_SECRET_BINDING = Object.freeze({
    reference: "prodigi/sandbox/api-key",
    providerId: "prodigi",
    credentialClass: "sandbox",
    envVar: "PRODIGI_SANDBOX_API_KEY"
});
const REFERENCE_PATTERN = /^[a-z][a-z0-9._/-]{0,127}$/u;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SECRET_VALUE_PATTERN = /^[\x21-\x7E]{1,4096}$/u;
const LEASE_VERSION = "env-unversioned";
function hasSandboxToken(envVar) {
    return envVar.split("_").includes("SANDBOX");
}
function hasLiveConflictToken(envVar) {
    const parts = envVar.split("_");
    return parts.includes("LIVE") || parts.includes("PROD") || parts.includes("PRODUCTION");
}
function snapshotBinding(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new SecretResolverError("invalid_binding");
    const read = (key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor))
            throw new SecretResolverError("invalid_binding");
        return descriptor.value;
    };
    const reference = read("reference");
    const providerId = read("providerId");
    const credentialClass = read("credentialClass");
    const envVar = read("envVar");
    if (typeof reference !== "string" || !REFERENCE_PATTERN.test(reference) ||
        typeof providerId !== "string" || !PROVIDER_PATTERN.test(providerId) ||
        (credentialClass !== "sandbox" && credentialClass !== "live") ||
        typeof envVar !== "string" || !ENV_VAR_PATTERN.test(envVar)) {
        throw new SecretResolverError("invalid_binding");
    }
    return Object.freeze({ reference, providerId, credentialClass, envVar });
}
/**
 * Validates bindings eagerly and returns a `ServerSecretSource` for
 * `withServerSecret`. Missing, empty or malformed values resolve to `undefined`
 * so callers get the existing safe `server_secret_unavailable` failure.
 */
export function createEnvServerSecretSource(options) {
    if (options === null || typeof options !== "object")
        throw new SecretResolverError("invalid_binding");
    const rawBindings = options.bindings;
    if (!Array.isArray(rawBindings) || rawBindings.length === 0 || rawBindings.length > 32) {
        throw new SecretResolverError("invalid_binding");
    }
    const allowLive = options.allowLiveCredentialBindings === true;
    const byReference = new Map();
    const envVars = new Set();
    for (const raw of rawBindings) {
        const binding = snapshotBinding(raw);
        if (binding.credentialClass === "live" && !allowLive)
            throw new SecretResolverError("live_binding_refused");
        if (binding.credentialClass === "sandbox" && (!hasSandboxToken(binding.envVar) || hasLiveConflictToken(binding.envVar))) {
            throw new SecretResolverError("class_name_mismatch");
        }
        if (binding.credentialClass === "live" && hasSandboxToken(binding.envVar)) {
            throw new SecretResolverError("class_name_mismatch");
        }
        if (byReference.has(binding.reference) || envVars.has(binding.envVar))
            throw new SecretResolverError("duplicate_binding");
        byReference.set(binding.reference, binding);
        envVars.add(binding.envVar);
    }
    const env = options.env;
    return Object.freeze({
        async load(input) {
            const binding = byReference.get(input.secretReference);
            if (binding === undefined || binding.providerId !== input.providerId)
                return undefined;
            // Only a sandbox lease can be issued: the class must equal the requested mode,
            // and ProviderMode has no live member. Simulated mode never receives a credential.
            if (input.mode !== "sandbox" || binding.credentialClass !== "sandbox")
                return undefined;
            const source = env ?? process.env;
            const value = Object.prototype.hasOwnProperty.call(source, binding.envVar) ? source[binding.envVar] : undefined;
            if (typeof value !== "string" || !SECRET_VALUE_PATTERN.test(value))
                return undefined;
            return Object.freeze({ secret: value, version: LEASE_VERSION, mode: "sandbox" });
        }
    });
}
