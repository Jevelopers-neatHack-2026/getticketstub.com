import type { BoundaryResult, ContractValidator, TrustedScope } from "./types.js";
/**
 * Private connector development shape. This is not a shared-contracts schema,
 * accepted version, provider adapter, or statement of provider support.
 */
export declare const CATALOG_DEVELOPMENT_FORMAT: "connector-development-catalog/1";
export declare const CATALOG_SNAPSHOT_FORMAT: "connector-development-catalog-snapshot/1";
export type CatalogEvidenceMode = "synthetic_fixture" | "documentation_reference" | "account_observation" | "unverified_import";
export type CatalogReasonCode = "not_exposed" | "not_in_source" | "not_confirmed" | "outside_scope" | "provider_declares_unsupported";
export type CatalogConstraint<T> = {
    readonly state: "known";
    readonly value: T;
} | {
    readonly state: "unknown";
    readonly reasonCode: CatalogReasonCode;
} | {
    readonly state: "unsupported";
    readonly reasonCode: CatalogReasonCode;
};
export type LengthUnit = "mm" | "cm" | "in";
export interface CatalogDimensionsInput {
    readonly width: string;
    readonly height: string;
    readonly depth: string;
    readonly unit: LengthUnit;
}
export interface CatalogInsetsInput {
    readonly top: string;
    readonly right: string;
    readonly bottom: string;
    readonly left: string;
    readonly unit: LengthUnit;
}
export interface CatalogFileSupportInput {
    readonly types: readonly string[];
    readonly minimumCount: number;
    readonly maximumCount: number;
}
export interface CatalogColorSupportInput {
    readonly spaces: readonly string[];
    readonly profiles: readonly string[];
}
export interface CatalogPersonalizationInput {
    readonly modes: readonly string[];
    readonly maximumFields: number;
    readonly maximumCharactersPerField: number;
}
export interface CatalogDestinationRuleInput {
    readonly countryCode: string;
    readonly regions: CatalogConstraint<readonly string[]>;
}
export interface CatalogShippingRuleInput {
    readonly countryCode: string;
    readonly regionCode: string | null;
    readonly methods: readonly string[];
}
export interface CatalogProductConstraintsInput {
    readonly dimensions: CatalogConstraint<CatalogDimensionsInput>;
    readonly minimumBleed: CatalogConstraint<CatalogInsetsInput>;
    readonly minimumSafeArea: CatalogConstraint<CatalogInsetsInput>;
    readonly minimumResolutionDpi: CatalogConstraint<number>;
    readonly surfaces: CatalogConstraint<readonly string[]>;
    readonly files: CatalogConstraint<CatalogFileSupportInput>;
    readonly color: CatalogConstraint<CatalogColorSupportInput>;
    readonly options: CatalogConstraint<readonly string[]>;
    readonly materials: CatalogConstraint<readonly string[]>;
    readonly personalization: CatalogConstraint<CatalogPersonalizationInput>;
    readonly destinations: CatalogConstraint<readonly CatalogDestinationRuleInput[]>;
    readonly shipping: CatalogConstraint<readonly CatalogShippingRuleInput[]>;
}
export interface ProviderCatalogInput {
    readonly localFormat: typeof CATALOG_DEVELOPMENT_FORMAT;
    readonly providerId: string;
    readonly apiVersion: string;
    readonly catalogVersion: string;
    readonly source: {
        readonly reference: string;
        readonly revision: string;
        readonly retrievedAt: string;
        readonly evidenceMode: CatalogEvidenceMode;
        readonly evidenceReference: string;
    };
    readonly freshness: {
        readonly maximumAgeSeconds: number;
    };
    readonly products: readonly {
        readonly sku: string;
        readonly variantId: string;
        readonly availability: "available" | "removed";
        readonly constraints: CatalogProductConstraintsInput;
        readonly providerAttributes: Readonly<Record<string, unknown>>;
    }[];
}
export interface CatalogDimensions {
    readonly widthNm: string;
    readonly heightNm: string;
    readonly depthNm: string;
    readonly unit: "nm";
}
export interface CatalogInsets {
    readonly topNm: string;
    readonly rightNm: string;
    readonly bottomNm: string;
    readonly leftNm: string;
    readonly unit: "nm";
}
export interface CatalogFileSupport {
    readonly types: readonly string[];
    readonly minimumCount: number;
    readonly maximumCount: number;
}
export interface CatalogColorSupport {
    readonly spaces: readonly string[];
    readonly profiles: readonly string[];
}
export interface CatalogPersonalization {
    readonly modes: readonly string[];
    readonly maximumFields: number;
    readonly maximumCharactersPerField: number;
}
export interface CatalogDestinationRule {
    readonly countryCode: string;
    readonly regions: CatalogConstraint<readonly string[]>;
}
export interface CatalogShippingRule {
    readonly countryCode: string;
    readonly regionCode: string | null;
    readonly methods: readonly string[];
}
export interface CatalogProductConstraints {
    readonly dimensions: CatalogConstraint<CatalogDimensions>;
    readonly minimumBleed: CatalogConstraint<CatalogInsets>;
    readonly minimumSafeArea: CatalogConstraint<CatalogInsets>;
    readonly minimumResolutionDpi: CatalogConstraint<number>;
    readonly surfaces: CatalogConstraint<readonly string[]>;
    readonly files: CatalogConstraint<CatalogFileSupport>;
    readonly color: CatalogConstraint<CatalogColorSupport>;
    readonly options: CatalogConstraint<readonly string[]>;
    readonly materials: CatalogConstraint<readonly string[]>;
    readonly personalization: CatalogConstraint<CatalogPersonalization>;
    readonly destinations: CatalogConstraint<readonly CatalogDestinationRule[]>;
    readonly shipping: CatalogConstraint<readonly CatalogShippingRule[]>;
}
export interface CatalogProductSnapshot {
    readonly sku: string;
    readonly variantId: string;
    readonly availability: "available" | "removed";
    readonly constraints: CatalogProductConstraints;
    readonly providerAttributes: Readonly<Record<string, unknown>>;
    readonly specIdentity: string;
}
export interface CatalogSnapshot {
    readonly localFormat: typeof CATALOG_SNAPSHOT_FORMAT;
    readonly providerId: string;
    readonly apiVersion: string;
    readonly catalogVersion: string;
    readonly source: ProviderCatalogInput["source"];
    readonly freshness: {
        readonly maximumAgeSeconds: number;
        readonly freshUntil: string;
    };
    readonly catalogContentIdentity: string;
    readonly snapshotIdentity: string;
    readonly products: readonly CatalogProductSnapshot[];
}
export interface CatalogSource {
    /** Read-only capability source. Implementations must not quote or submit. */
    readCatalogSnapshot(): Promise<unknown>;
}
export interface CatalogSelectionInput {
    readonly snapshotIdentity: string;
    readonly catalogContentIdentity: string;
    readonly sku: string;
    readonly variantId: string;
    readonly specIdentity: string;
    readonly dimensions: CatalogDimensionsInput;
    readonly bleed: CatalogInsetsInput;
    readonly safeArea: CatalogInsetsInput;
    readonly effectiveResolutionDpi: number;
    readonly surface: string;
    readonly fileType: string;
    readonly fileCount: number;
    readonly colorSpace: string;
    readonly colorProfile: string;
    readonly options: readonly string[];
    readonly materials: readonly string[];
    readonly personalization: null | {
        readonly mode: string;
        readonly fields: readonly {
            readonly name: string;
            readonly characterCount: number;
        }[];
    };
    readonly destination: {
        readonly countryCode: string;
        readonly regionCode?: string;
    };
    readonly shippingMethod: string;
}
export type CatalogSelectionStatus = "eligible" | "ineligible" | "revalidation_required";
export type CatalogSelectionReason = "catalog_input_invalid" | "catalog_clock_invalid" | "catalog_clock_before_retrieval" | "catalog_stale" | "sku_not_found" | "sku_removed" | "spec_identity_changed" | "snapshot_binding_mismatch" | "unknown_mandatory_constraint" | "unsupported_mandatory_constraint" | "contradictory_catalog_constraints" | "selection_incompatible" | "selection_input_invalid";
export interface CatalogSelectionResult {
    readonly status: CatalogSelectionStatus;
    readonly eligible: boolean;
    readonly providerId: string;
    readonly snapshotIdentity: string;
    readonly catalogContentIdentity: string;
    readonly sku: string;
    readonly variantId: string;
    readonly specIdentity?: string;
    readonly reasons: readonly CatalogSelectionReason[];
    readonly details: readonly string[];
    readonly requiredActions: readonly ("refresh_catalog" | "revalidate" | "requote" | "reapprove")[];
}
/** Pure offline normalizer for one provider-supplied private catalog snapshot. */
export declare function normalizeCatalogSnapshot(input: unknown): Promise<CatalogSnapshot>;
/** Calls exactly one injected read-only source operation, then normalizes its copy. */
export declare function discoverCatalogSnapshot(source: CatalogSource): Promise<CatalogSnapshot>;
/**
 * Checks a previously bound selection against a fresh normalized snapshot.
 * A spec identity change, stale capture, removed SKU, or binding mismatch
 * requires revalidation, re-quote, and new approval before use.
 */
export declare function evaluateCatalogSelection(snapshot: CatalogSnapshot, input: unknown, now: string): CatalogSelectionResult;
/**
 * Pass the private development snapshot to the existing injected canonical
 * boundary. A development fixture validator remains only a fixture; this
 * helper makes no accepted-schema or cross-repository conformance claim.
 */
export declare function validateCatalogSnapshotBoundary(snapshot: CatalogSnapshot, validator: ContractValidator, trustedScope: TrustedScope): Promise<BoundaryResult<unknown>>;
