// Supplier products used only to validate the Prodigi sandbox: the first owner-approved product-details read, quote and test
// order (integration-evals decision 0003, rows R1-R3). This is NOT the customer capability map and is deliberately kept out of
// src/customer/pages/capabilities.ts: no tier, size or finish points at anything here, nothing here is in VARIANTS, and nothing
// here makes a variant orderable or changes a price, finish or size claim.
//
// It has its own revision, SANDBOX_PRODUCTS_REVISION. Bump that when an entry below changes. Do NOT bump CAPABILITY_VERSION for
// a change here: CAPABILITY_VERSION is named by every quote id and cart line, so bumping it sends every saved cart line to
// "Choose again". Mapping a customer variant to one of these products is a change to capabilities.ts (and its version), not here.
//
// Pure data, no "server-only" import, so scripts/check-capabilities.mjs can read it under plain Node.
import { SOURCES, type CapabilityProvenance } from "@/customer/pages/capabilities";

/** The revision of this list. Independent of CAPABILITY_VERSION. */
export const SANDBOX_PRODUCTS_REVISION = "2026-10-12.1";

export const SANDBOX_SOURCES = {
  cTypes: "https://www.prodigi.com/products/prints-and-posters/photo-prints/c-types/",
  apiReference: SOURCES.apiReference,
} as const;

/** How a single fact is known. "derived" means computed from published facts, not published itself. */
export type SandboxFactBasis = CapabilityProvenance | "derived";

/**
 * A supplier product used only to validate the Prodigi sandbox. Deciding which customer variants (Classic 2 × 5.5 in, Stamp
 * 2 × 3 in; matte, foil, holo) map to a supplier product, and how they are trimmed, is a separate, open product decision.
 */
export interface SandboxValidationProduct {
  id: string;
  purpose: "sandbox-validation";
  customerFacing: false;
  supplier: "Prodigi";
  sku: string;
  description: string;
  /** Where the decision is recorded. */
  decision: string;
  /** How we know the product facts as a whole. No authenticated product-details read has been made. */
  provenance: CapabilityProvenance;
  reviewed: string;
  sources: string[];
  printArea: "default";
  orientation: "landscape";
  /** The physical print, landscape. */
  size: { w: number; h: number; unit: "in" };
  /**
   * The artwork to send. The pixel size is not published by Prodigi: it is derived (size × dpi), and only the product-details
   * read (variants[].printAreaSizes.default.{horizontalResolution,verticalResolution}) confirms it.
   */
  artwork: { w: number; h: number; unit: "px"; dpi: number; colorSpace: "sRGB"; format: "jpg"; sizing: "fillPrintArea"; pixelBasis: SandboxFactBasis };
  finish: string;
  destinationCountry: string;
  shippingMethod: { order: string; quote: string };
  /** What is still unconfirmed or undecided. */
  open: string[];
}

export const SANDBOX_VALIDATION_PRODUCTS: readonly SandboxValidationProduct[] = [
  {
    id: "prodigi-sandbox-validation-global-pho-4x6",
    purpose: "sandbox-validation",
    customerFacing: false,
    supplier: "Prodigi",
    sku: "GLOBAL-PHO-4X6",
    description: "4 × 6 in (102 × 152 mm) lustre C-type (silver-halide) photo print, printed landscape as 6 × 4 in.",
    decision: "integration-evals planning/decisions/0003-owner-delegated-decisions-2026-10-12.md, rows R1-R3",
    provenance: "published-docs",
    reviewed: "2026-10-12",
    sources: [SANDBOX_SOURCES.cTypes, SANDBOX_SOURCES.apiReference],
    printArea: "default",
    orientation: "landscape",
    size: { w: 6, h: 4, unit: "in" },
    artwork: { w: 1800, h: 1200, unit: "px", dpi: 300, colorSpace: "sRGB", format: "jpg", sizing: "fillPrintArea", pixelBasis: "derived" },
    finish: "lustre",
    destinationCountry: "US",
    shippingMethod: { order: "Standard", quote: "standard" },
    open: [
      "The customer-facing print-tier mapping (finish naming, Classic 2 × 5.5 in and Stamp 2 × 3 in on a 6 × 4 sheet, trim) is an open product decision.",
      "Lustre is listed for the C-type family, not per SKU: only the owner-approved product-details read confirms the finish attribute and US shipsTo.",
      "The 1800 × 1200 px print-area size is derived (6 × 4 in × 300 dpi), not published: the product-details read (variants[].printAreaSizes.default) must confirm it.",
      "sRGB is the decision's artwork policy, not a published Prodigi requirement (the C-types page offers an ICC profile instead).",
      "Bleed, safe area and stub layout belong to print-production's PP-03 template (print-production #6).",
    ],
  },
];
