import type { Operation, SharedShape } from "./types.js";
/**
 * References are catalog pointers only. They do not define payload schemas or
 * assert that upstream issues have been accepted.
 */
export declare const CONTRACT_OWNERSHIP: {
    readonly operation_envelope: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#4";
    };
    readonly capability: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#4";
    };
    readonly print_specification: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#4";
    };
    readonly preflight_report: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#4";
    };
    readonly production_bundle: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#24";
    };
    readonly fulfillment_quote: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#25";
    };
    readonly order_authorization: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#26";
    };
    readonly shipment_observation: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#27";
    };
    readonly operation_result: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#4";
    };
    readonly budget_reservation: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#12";
    };
    readonly fulfillment_usage: {
        readonly ownerRepository: "shared-contracts";
        readonly upstreamIssue: "#11";
    };
};
export declare const INPUT_SHAPES: Readonly<Record<Operation, readonly SharedShape[]>>;
export declare const AUXILIARY_SHAPES: Readonly<Record<Operation, readonly SharedShape[]>>;
export declare const OUTPUT_SHAPES: Readonly<Record<Operation, readonly SharedShape[]>>;
export declare const ALL_SHARED_SHAPES: SharedShape[];
export declare function uniqueShapes(shapes: readonly SharedShape[]): SharedShape[];
