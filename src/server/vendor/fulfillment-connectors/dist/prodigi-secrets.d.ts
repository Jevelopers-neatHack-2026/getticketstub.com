import type { ServerSecretSource } from "./security.js";
/**
 * Server-side secret-reference resolver backed by process environment variables.
 *
 * Configuration refers to a credential only by an opaque reference name. The
 * resolver maps that name to exactly one environment variable and one
 * credential class, reads the variable at call time (no caching), and returns a
 * lease only for a matching provider and mode. Sandbox and live references are
 * separate bindings that may not share a reference name or variable. Live-class
 * bindings are refused unless an explicit future flag is set, and even then no
 * live lease can be issued because the runtime has no live mode.
 */
export type CredentialClass = "sandbox" | "live";
export interface SecretReferenceBinding {
    /** Opaque reference name used by configuration, e.g. `prodigi/sandbox/api-key`. */
    readonly reference: string;
    readonly providerId: string;
    readonly credentialClass: CredentialClass;
    /** Name of the server-side environment variable that holds the secret. */
    readonly envVar: string;
}
export interface EnvSecretSourceOptions {
    readonly bindings: readonly SecretReferenceBinding[];
    /** Defaults to `process.env`, read on every `load` call. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /**
     * Future launch flag. Default false: any live-class binding is rejected at
     * construction. Setting it does not create a live mode; it only permits a
     * live binding to be declared for a later, separately authorized step.
     */
    readonly allowLiveCredentialBindings?: boolean;
}
export type SecretResolverErrorCode = "invalid_binding" | "duplicate_binding" | "live_binding_refused" | "class_name_mismatch";
export declare class SecretResolverError extends Error {
    readonly code: SecretResolverErrorCode;
    constructor(code: SecretResolverErrorCode);
}
/** The only predeclared binding. No live binding (and no `PRODIGI_API_KEY`) is defined. */
export declare const PRODIGI_SANDBOX_SECRET_BINDING: SecretReferenceBinding;
/**
 * Validates bindings eagerly and returns a `ServerSecretSource` for
 * `withServerSecret`. Missing, empty or malformed values resolve to `undefined`
 * so callers get the existing safe `server_secret_unavailable` failure.
 */
export declare function createEnvServerSecretSource(options: EnvSecretSourceOptions): ServerSecretSource;
