// The versioned capability map: what each material tier x size x finish really is, and whether it can be ordered.
// Pure data and pure functions (no React, no storage), so the UI, the order gate and scripts/check-capabilities.mjs all read one source.
// Nothing here is a supplier catalog. A physical variant stays "preview" until print-production and fulfillment-connectors
// hand us an accepted SKU and template (print-production #6, fulfillment-connectors #8 and #9). Swapping in real SKUs means
// editing the rows below and bumping CAPABILITY_VERSION; every quote, cart item and order names the version it was made under.
//
// When to bump CAPABILITY_VERSION: only when what a quote or cart line means changes, i.e. a VARIANTS row, its SKU, dims,
// status, finish or finish note, a price, or SIZE_COPY. A saved cart line whose version differs is sent to "Choose again"
// (resolveSelection) and blocks payment, and quote ids embed the version, so a bump resets every customer's cart and quotes.
// Do not bump it for anything a customer cannot see. Supplier products used only to validate the Prodigi sandbox live in
// src/server/fulfillment/sandbox-products.ts with their own revision, not here.
import type { Finish, Material } from "@/customer/studio/types";

export const CAPABILITY_VERSION = "2026-10-11.1";
/** The day the Prodigi pages below were read (issue #23). No authenticated lookup, quote or order was made. */
export const CAPABILITY_REVIEWED = "2026-10-10";

export type PrintSize = "classic" | "stamp" | "framed" | "file";
export type VariantStatus = "orderable" | "preview" | "unavailable";
export type CapabilityProvenance = "confirmed" | "published-docs" | "assumed";
export type Unit = "in" | "px";

/** A measurement is known (with units and where we learned it), not applicable, or unknown. Unknown is never filled in. */
export type Dim =
  | { state: "known"; w: number; h: number; unit: Unit; basis: CapabilityProvenance }
  | { state: "n/a" }
  | { state: "unknown" };

export interface Dims {
  /** The edge of the piece: the trim (cut) size of a card or print, or the image of a digital file. */
  trim: Dim;
  bleed: Dim;
  safeArea: Dim;
  /** The opening a mat leaves for the image. Depends on the mat chosen. */
  matWindow: Dim;
  /** The glass size. This is the number a frame is sold by. */
  glazing: Dim;
  /** The outside of the frame, frame width included. Depends on the frame profile. */
  exterior: Dim;
}

export interface Variant {
  id: string;
  material: Material;
  size: PrintSize;
  finish: Finish;
  status: VariantStatus;
  /** The supplier that has confirmed this variant. Null while unconfirmed. */
  supplier: string | null;
  /** The confirmed supplier SKU. Null while unconfirmed. Never guessed. */
  sku: string | null;
  /** The supplier we are checking against, kept apart from `supplier` so a candidate never reads as a confirmation. */
  candidateSupplier: string | null;
  provenance: CapabilityProvenance;
  reviewed: string;
  sources: string[];
  dims: Dims;
  /** Plain language: what the displayed measurements measure. */
  measures: string;
  /** What the finish is, and whether it is printed. */
  finishNote: string;
}

export const SOURCES = {
  frameFaq: "https://support.prodigi.com/hc/en-us/articles/13137070879772-Can-you-tell-me-more-about-your-frames",
  classicFrames: "https://www.prodigi.com/products/wall-art/framed-prints/classic-frames/",
  apiReference: "https://www.prodigi.com/print-api/docs/reference/",
  metallicFoil: "https://www.prodigi.com/products/prints-and-posters/specialist-prints/metallic-foil-prints/",
  framedFoil: "https://www.prodigi.com/products/wall-art/framed-prints/classic-framed-metallic-foil-prints/",
} as const;

/** Which sizes each tier is sold at. Four tiers, kept as they are. */
export const TIER_SIZES: Record<Material, PrintSize[]> = {
  digital: ["file"],
  card: ["classic", "stamp"],
  print: ["classic", "stamp"],
  framed: ["framed"],
};
export const FINISH_IDS: Finish[] = ["matte", "foil", "holo"];

const known = (w: number, h: number, unit: Unit, basis: CapabilityProvenance): Dim => ({ state: "known", w, h, unit, basis });
const UNKNOWN: Dim = { state: "unknown" };
const NA: Dim = { state: "n/a" };

/** Our nominal trim sizes: what the app has always called a Classic stub and a Stamp. Not yet matched to a printer template. */
const TRIM: Partial<Record<PrintSize, Dim>> = {
  classic: known(2, 5.5, "in", "assumed"),
  stamp: known(2, 3, "in", "assumed"),
};

export const variantId = (material: Material, size: PrintSize, finish: Finish) => `${material}.${size}.${finish}`;

function dimsFor(material: Material, size: PrintSize): Dims {
  if (material === "digital") return { trim: UNKNOWN, bleed: NA, safeArea: NA, matWindow: NA, glazing: NA, exterior: NA };
  if (material === "framed") {
    // Prodigi lists a frame by its glazing size; the mat and the frame profile decide the rest.
    return { trim: UNKNOWN, bleed: UNKNOWN, safeArea: UNKNOWN, matWindow: UNKNOWN, glazing: known(8, 10, "in", "published-docs"), exterior: UNKNOWN };
  }
  return { trim: TRIM[size] ?? UNKNOWN, bleed: UNKNOWN, safeArea: UNKNOWN, matWindow: NA, glazing: NA, exterior: NA };
}

function measuresFor(material: Material, size: PrintSize): string {
  if (material === "digital") return "A PNG and a wallet pass drawn on screen. The pixel size isn't fixed yet.";
  if (material === "framed") {
    return "8 × 10 in is the glazing size: the glass, with the frame width left out. That is how Prodigi lists a frame. A mat shrinks the image window, and the outside size depends on the frame profile, so both stay unknown until a frame is chosen.";
  }
  const [name, trim] = size === "stamp" ? ["Stamp", "2 × 3 in"] : ["Classic stub", "2 × 5.5 in"];
  const on = material === "card" ? "card stock" : "art paper";
  return `${name} is ${trim} trim: the cut edge of the ${on}, our nominal size. It isn't matched to a printer template yet, so bleed and safe area are unknown.`;
}

function build(material: Material, size: PrintSize, finish: Finish): Variant {
  const digital = material === "digital";
  const framed = material === "framed";
  const base = { id: variantId(material, size, finish), material, size, finish, supplier: null, sku: null, reviewed: CAPABILITY_REVIEWED, dims: dimsFor(material, size), measures: measuresFor(material, size) };
  const frameSources = framed ? [SOURCES.frameFaq, SOURCES.classicFrames, SOURCES.apiReference] : [SOURCES.apiReference];

  if (digital) {
    const screenOnly = finish === "holo";
    return {
      ...base,
      status: screenOnly ? "preview" : "orderable",
      supplier: "TicketStub",
      candidateSupplier: null,
      provenance: screenOnly ? "assumed" : "confirmed",
      sources: [],
      finishNote:
        finish === "matte"
          ? "Plain. Included."
          : finish === "foil"
            ? "A foil sheen drawn on screen. Included."
            : "Holo is a screen effect. Nothing is printed. It is still a preview on screen.",
    };
  }
  if (finish === "holo") {
    return {
      ...base,
      status: "unavailable",
      candidateSupplier: "Prodigi",
      provenance: "assumed",
      sources: [SOURCES.metallicFoil],
      finishNote: "Screen effect · not printed. The pages we reviewed confirm no printed holographic product.",
    };
  }
  if (finish === "foil") {
    return {
      ...base,
      status: "preview",
      candidateSupplier: "Prodigi",
      provenance: framed ? "published-docs" : "assumed",
      sources: framed ? [...frameSources, SOURCES.framedFoil] : [SOURCES.metallicFoil, SOURCES.apiReference],
      finishNote: framed
        ? "Prodigi sells framed metallic foil prints. The 8 × 10 size and its mat options aren't verified."
        : "Prodigi sells foil as a separate metallic substrate, published from 4 × 6 in. Foil at 2 × 3 and 2 × 5.5 in is unverified.",
    };
  }
  return {
    ...base,
    status: "preview",
    candidateSupplier: "Prodigi",
    provenance: framed ? "published-docs" : "assumed",
    sources: frameSources,
    finishNote: "Matte. Included.",
  };
}

export const VARIANTS: Variant[] = (Object.keys(TIER_SIZES) as Material[]).flatMap((m) => TIER_SIZES[m].flatMap((s) => FINISH_IDS.map((f) => build(m, s, f))));
const BY_ID = new Map(VARIANTS.map((v) => [v.id, v]));

export function variantFor(material: Material, size: PrintSize, finish: Finish): Variant | undefined {
  return BY_ID.get(variantId(material, size, finish));
}

/** The documented frame example, kept as a geometry fixture. It is Prodigi's illustration, not a launch SKU. */
export const GEOMETRY_FIXTURES = [
  {
    id: "prodigi-frame-faq-18x24-2in-mount",
    note: "Documented example, not a launch SKU.",
    source: SOURCES.frameFaq,
    glazing: { w: 18, h: 24, unit: "in" as const },
    mountPerSide: 2,
    imageWindow: { w: 14, h: 20, unit: "in" as const },
  },
];

/** The image window a mat leaves inside a glazing size: each side loses the mount width. */
export function imageWindow(glazing: { w: number; h: number }, mountPerSide: number): { w: number; h: number } {
  return { w: glazing.w - 2 * mountPerSide, h: glazing.h - 2 * mountPerSide };
}

// ---- Words the screens use ----

export const STATUS_WORDS: Record<VariantStatus, string> = {
  orderable: "Orderable in the sandbox",
  preview: "Preview, not yet orderable",
  unavailable: "Not orderable",
};

export const HOLO_WORDS = "Screen effect · not printed";

export function statusLine(v: Variant): string {
  if (v.finish === "holo" && v.material !== "digital") return HOLO_WORDS;
  return STATUS_WORDS[v.status];
}

/** The printer's mark a status wears, or null when it needs none. */
export function statusMark(status: VariantStatus): "preview" | "blocked" | null {
  return status === "orderable" ? null : status === "preview" ? "preview" : "blocked";
}

export interface SizeCopy {
  name: string;
  /** What the number measures, in a short phrase. */
  measure: string;
  /** The one-line explanation shown under it. */
  caption: string;
}

export const SIZE_COPY: Record<PrintSize, SizeCopy> = {
  classic: { name: "Classic stub", measure: "2 × 5.5 in trim", caption: "Trim is the cut edge. Nominal size, not yet matched to a printer template." },
  stamp: { name: "Stamp", measure: "2 × 3 in trim", caption: "Trim is the cut edge. Nominal size, not yet matched to a printer template." },
  framed: { name: "Framed print", measure: "Frame 8 × 10 in", caption: "Frame 8 × 10 in · image window depends on the mat" },
  file: { name: "Digital file", measure: "PNG and wallet pass", caption: "Drawn on screen. The pixel size isn't fixed yet." },
};

export const sizeLabel = (size: PrintSize) => `${SIZE_COPY[size].name} · ${SIZE_COPY[size].measure}`;

export function dimText(d: Dim): string {
  if (d.state === "known") return `${d.w} × ${d.h} ${d.unit}`;
  return d.state === "n/a" ? "Not applicable" : "Unknown";
}

// ---- Ordering gate ----

export type RuntimeMode = "live" | "demo";

/**
 * `TICKETSTUB_RUNTIME_MODE=live` is the only live mode. It is a runtime secret on the host, so the browser can't read it: the root
 * layout (rendered per request) writes the server's real mode to `<html data-runtime-mode>`, and the browser reads that first.
 * Without it the browser fell back to a build-time NEXT_PUBLIC_ mirror that the host never sets, so a live site treated previews
 * as orderable and only the server's /api/orders refused them.
 */
export function runtimeMode(env?: Record<string, string | undefined>): RuntimeMode {
  if (!env && typeof document !== "undefined") {
    const shown = document.documentElement?.dataset.runtimeMode;
    if (shown === "live" || shown === "demo") return shown;
  }
  const e = env ?? { NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE: process.env.NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE, TICKETSTUB_RUNTIME_MODE: process.env.TICKETSTUB_RUNTIME_MODE };
  return (e.NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE ?? e.TICKETSTUB_RUNTIME_MODE) === "live" ? "live" : "demo";
}

export type OrderGate = { ok: true; sandbox: boolean } | { ok: false; reason: "unavailable" | "preview-in-live" | "unknown-variant"; message: string };

/**
 * Can this variant become an order? A preview variant can be shown and quoted as a sandbox fixture, never as a real order.
 * Unavailable variants never become orders. In live mode only an orderable variant gets through.
 */
export function orderGate(v: Variant | undefined, mode: RuntimeMode): OrderGate {
  if (!v) return { ok: false, reason: "unknown-variant", message: "That combination isn't on our list. Choose the material, finish and size again." };
  if (v.status === "unavailable") {
    return {
      ok: false,
      reason: "unavailable",
      message: v.finish === "holo" ? "Holo is a screen effect and isn't printed. Choose Matte or Foil to print it, or get it as a digital file." : "This variant can't be ordered.",
    };
  }
  if (v.status === "preview" && mode === "live") {
    return { ok: false, reason: "preview-in-live", message: "This is a preview. We haven't confirmed a printer SKU for it yet, so it can't be ordered." };
  }
  return { ok: true, sandbox: v.sku === null };
}

export type AuthorizationGate = { ok: true; sku: string | null } | { ok: false; message: string };

/**
 * May a purchase authorization be issued, or still honoured, for this variant with this provider? It starts from orderGate (so a
 * preview never passes in live mode and an unavailable variant never passes at all) and adds the provider rule: "sandbox" exists
 * only outside live mode and carries no SKU; a real provider needs a confirmed SKU from that supplier and a live runtime.
 * No variant carries a confirmed SKU today, so no live authorization can be issued yet.
 */
export function authorizationGate(v: Variant | undefined, provider: string, mode: RuntimeMode): AuthorizationGate {
  const gate = orderGate(v, mode);
  if (!gate.ok || !v) return { ok: false, message: gate.ok ? "That combination isn't on our list." : gate.message };
  if (provider === "sandbox") {
    return mode === "live" ? { ok: false, message: "Sandbox orders can't be authorized on a live server." } : { ok: true, sku: v.sku };
  }
  if (mode === "live" && v.status === "orderable" && v.sku !== null && v.supplier?.toLowerCase() === provider) return { ok: true, sku: v.sku };
  return { ok: false, message: "We haven't confirmed a printer SKU for that choice with this provider, so it can't be authorized." };
}

// ---- Stored selections ----

export interface StoredSelection {
  material: Material;
  finish: Finish;
  size: PrintSize;
  capabilityVersion?: string;
  quoteId?: string;
}

export type SelectionState =
  | { state: "current"; variant: Variant }
  | { state: "choose-again"; variant?: Variant; reason: "no-mapping" | "old-version" | "unknown-variant" };

/**
 * Resolve a stored cart item through the current map. An item from before the map (no capabilityVersion) only carries
 * over when its variant is confirmed orderable; anything else, "framed" included, is never reinterpreted as a new spec.
 */
export function resolveSelection(sel: StoredSelection): SelectionState {
  const variant = variantFor(sel.material, sel.size, sel.finish);
  if (!variant) return { state: "choose-again", reason: "unknown-variant" };
  if (sel.capabilityVersion === undefined) {
    return variant.status === "orderable" && variant.provenance === "confirmed" ? { state: "current", variant } : { state: "choose-again", variant, reason: "no-mapping" };
  }
  if (sel.capabilityVersion !== CAPABILITY_VERSION) return { state: "choose-again", variant, reason: "old-version" };
  return { state: "current", variant };
}

/** The quote id for a choice. It names the capability version, so any change to SKU, dimensions or finish is a different quote. */
export function quoteIdFor(material: Material, finish: Finish, size: PrintSize, qty = 1): string {
  return `qt_${CAPABILITY_VERSION}_${material}_${finish}_${size}_x${qty}`;
}

/** Is a stored quote still the quote for this choice under the current map? */
export function quoteStillHolds(sel: StoredSelection): boolean {
  return !!sel.quoteId && sel.quoteId.startsWith(`qt_${CAPABILITY_VERSION}_${sel.material}_${sel.finish}_${sel.size}_x`);
}

export const CHOOSE_AGAIN_WORDS = "Choose again";
export const CHOOSE_AGAIN_BODY = "We've updated what each size and finish really is. Pick it again to get a new quote.";
