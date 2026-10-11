"use client";
// Sandbox commerce for the hackathon build. Nothing here calls a payment, print or shipping API.
// A quote is not a purchase: quotes expire, and an "order" is a local sandbox record only.
import { EDITION_META } from "@/customer/studio/stub/editions";
import { MATERIALS, currentVersion, formatMoney, type Finish, type Material, type Stub } from "@/customer/studio/types";
import {
  CAPABILITY_VERSION,
  TIER_SIZES,
  orderGate,
  quoteIdFor,
  resolveSelection,
  runtimeMode,
  sizeLabel,
  statusMark,
  variantFor,
  type PrintSize,
  type SelectionState,
  type VariantStatus,
} from "@/customer/pages/capabilities";
import { storageFailure } from "@/customer/flows/events";

export { CAPABILITY_VERSION, type PrintSize, type VariantStatus };

export const ORDERS_KEY = "ticketstub.orders.v1";
export const CART_KEY = "ticketstub.cart.v1";
/** Fired on window after every cart write in this tab (the storage event only reaches other tabs). */
export const CART_EVENT = "ticketstub:cart";
export const SANDBOX_LABEL = "Sandbox · no real charge";

/** "Name · what it measures", from the capability map ("Frame 8 × 10 in" for framed, "2 × 5.5 in trim" for a stub). */
export const SIZE_LABEL: Record<PrintSize, string> = {
  classic: sizeLabel("classic"),
  stamp: sizeLabel("stamp"),
  framed: sizeLabel("framed"),
  file: sizeLabel("file"),
};

/** Which sizes a material can be printed at. */
export function sizesFor(material: Material): PrintSize[] {
  return TIER_SIZES[material];
}

/** The size a stub prints at by default: a portrait edition is a 2 x 3 stamp, a landscape one a classic stub. */
export function defaultSize(stub: Stub, material: Material = stub.material): PrintSize {
  const sizes = sizesFor(material);
  const portrait = EDITION_META[currentVersion(stub).edition]?.orientation === "portrait";
  return portrait && sizes.includes("stamp") ? "stamp" : sizes[0];
}

/** Sandbox retail fixtures, not supplier quotes. */
export const FINISHES: { id: Finish; label: string; upchargeMinor: number }[] = [
  { id: "matte", label: "Matte", upchargeMinor: 0 },
  { id: "foil", label: "Foil", upchargeMinor: 600 },
  { id: "holo", label: "Holo", upchargeMinor: 900 },
];

/** Estimated shipping, flat. A sandbox fixture, marked as an estimate until a real print partner quote exists. */
export const SHIPPING_ESTIMATE_MINOR = 600;

export function materialPrice(material: Material): number {
  return MATERIALS.find((m) => m.id === material)?.priceMinor ?? 0;
}

/** What each finish costs on this material, as the swatches say it. Holo is never printed, so it has no print price. */
export function finishPrices(material: Material): Record<Finish, string> {
  const physical = material !== "digital";
  const word = (f: (typeof FINISHES)[number]) => (f.id === "holo" && physical ? "Screen only" : !physical || f.upchargeMinor === 0 ? "Included" : `+${formatMoney(f.upchargeMinor)}`);
  return Object.fromEntries(FINISHES.map((f) => [f.id, word(f)])) as Record<Finish, string>;
}

/** The printer's mark each finish wears on this material and size. */
export function finishMarks(material: Material, size: PrintSize): Partial<Record<Finish, "preview" | "blocked">> {
  const out: Partial<Record<Finish, "preview" | "blocked">> = {};
  for (const f of FINISHES) {
    const v = variantFor(material, size, f.id);
    const mark = v ? statusMark(v.status) : "blocked";
    if (mark) out[f.id] = mark;
  }
  return out;
}

/** The gate for a choice, in this runtime's mode. */
export function gateFor(material: Material, finish: Finish, size: PrintSize) {
  return orderGate(variantFor(material, size, finish), runtimeMode());
}

/** A stored cart line resolved through the current capability map. */
export function cartItemState(item: CartItem): SelectionState {
  return resolveSelection(item);
}

/** The order marks a set of cart lines needs in its legend: a line to choose again or a preview wears "preview", an unavailable one "blocked". */
export function cartMarks(items: CartItem[]): ("preview" | "blocked")[] {
  const marks = new Set<"preview" | "blocked">();
  for (const i of items) {
    const res = cartItemState(i);
    if (res.state === "choose-again") marks.add("blocked");
    else {
      const mark = statusMark(res.variant.status);
      if (mark) marks.add(mark);
    }
  }
  return [...marks];
}

export interface Quote {
  /** Stable for the same choice (capability version, material, finish, size, quantity), so every screen can name the quote it priced. Reference only: the platform's FulfillmentQuote is not wired in. */
  quoteId: string;
  /** The capability map this quote was priced under. A new version is a new quote. */
  capabilityVersion: string;
  /** The variant's status when quoted. A preview is a sandbox fixture, not a supplier quote. */
  variantStatus: VariantStatus;
  /** The confirmed supplier SKU. Null until one is confirmed. */
  sku: string | null;
  currency: "USD";
  material: Material;
  finish: Finish;
  size: PrintSize;
  itemMinor: number;
  finishMinor: number;
  shippingMinor: number; // estimated
  totalMinor: number;
  expiresAt: number; // quotes expire after 15 min; a quote is not an authorization
}

export function quote(material: Material, finish: Finish, size: PrintSize, qty = 1): Quote {
  const physical = material !== "digital";
  const itemMinor = materialPrice(material) * qty;
  const finishMinor = physical && finish !== "holo" ? (FINISHES.find((f) => f.id === finish)?.upchargeMinor ?? 0) * qty : 0;
  const shippingMinor = physical ? SHIPPING_ESTIMATE_MINOR : 0;
  const variant = variantFor(material, size, finish);
  const quoteId = quoteIdFor(material, finish, size, qty);
  return { quoteId, capabilityVersion: CAPABILITY_VERSION, variantStatus: variant?.status ?? "unavailable", sku: variant?.sku ?? null, currency: "USD", material, finish, size, itemMinor, finishMinor, shippingMinor, totalMinor: itemMinor + finishMinor + shippingMinor, expiresAt: Date.now() + 15 * 60_000 };
}

export interface Order {
  id: string;
  mode: "sandbox";
  createdAt: string;
  stubIds: string[];
  lines: { title: string; material: Material; finish: Finish; size: PrintSize; totalMinor: number; /** The variant's status when ordered. Absent on receipts from before the capability map. */ variantStatus?: VariantStatus }[];
  /** The capability map the order was placed under. Absent on historical sandbox receipts, which are kept as they were. */
  capabilityVersion?: string;
  totalMinor: number;
  currency?: "USD"; // filled by addOrder
  quoteId?: string; // the quote the order was priced from, when there is one
  method: "apple-pay" | "google-pay" | "card" | "gift-print" | "organizer-print";
  email?: string;
}

export interface CartItem {
  id: string;
  stubId: string;
  title: string;
  material: Material;
  finish: Finish;
  size: PrintSize;
  unitMinor: number; // item + finish, per stub
  quoteId?: string; // the single-stub quote this unit price came from
  /** The capability map this line was chosen under. Absent on lines saved before the map: those are asked to choose again. */
  capabilityVersion?: string;
  variantStatus?: VariantStatus;
  seats: CartSeat[]; // matching set: one stub per seat
  addedAt: string;
}

/** Unclaimed seats get a decision after 7 days (simulated): print seat-only, gift by name, or drop for a refund. */
export type SeatDecision = "seat-only" | "gift" | "drop";
export interface CartSeat {
  name: string;
  seat?: string;
  claimed: boolean;
  decision?: SeatDecision;
}

/** Seats that are still paid for (dropped seats are refunded). */
export function billableSeats(item: CartItem): number {
  return Math.max(1, item.seats.filter((x) => x.decision !== "drop").length);
}

export function cartTotals(items: CartItem[]) {
  const itemsMinor = items.reduce((sum, i) => sum + i.unitMinor * billableSeats(i), 0);
  const shippingMinor = items.some((i) => i.material !== "digital") ? SHIPPING_ESTIMATE_MINOR : 0;
  return { itemsMinor, shippingMinor, totalMinor: itemsMinor + shippingMinor };
}

export function updateSeat(itemId: string, seatIndex: number, patch: Partial<CartSeat>): boolean {
  return saveCart(loadCart().map((c) => (c.id === itemId ? { ...c, seats: c.seats.map((x, i) => (i === seatIndex ? { ...x, ...patch } : x)) } : c)));
}

const storeOf = (key: string) => (key === CART_KEY ? "cart" : "orders");
function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch (e) {
    storageFailure(storeOf(key), "read", e);
    return [];
  }
}
/** True when stored. A failure is reported (store and reason only, never the records). */
function write<T>(key: string, value: T[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    /* storage unavailable */
    storageFailure(storeOf(key), "write", e);
    return false;
  }
}

/** Thrown when an order names a variant the gate won't let through (live mode and a preview, or an unavailable finish). */
export class OrderBlocked extends Error {}

export const loadOrders = () => read<Order>(ORDERS_KEY);
/** The sandbox record, as addOrder() returns it, and whether it reached this device's storage. */
export function addOrderStored(order: Omit<Order, "id" | "mode" | "createdAt">): { order: Order; stored: boolean } {
  const mode = runtimeMode();
  const lines = order.lines.map((l) => {
    const v = variantFor(l.material, l.size, l.finish);
    // The screens already hold back an unavailable choice in demo mode; live mode is blocked here too, whatever called us.
    const gate = orderGate(v, mode);
    if (mode === "live" && !gate.ok) throw new OrderBlocked(gate.message);
    return { ...l, variantStatus: v?.status };
  });
  const full: Order = { currency: "USD", ...order, lines, capabilityVersion: CAPABILITY_VERSION, id: `sbx_${Math.random().toString(36).slice(2, 10)}`, mode: "sandbox", createdAt: new Date().toISOString() };
  const stored = write(ORDERS_KEY, [full, ...loadOrders()]);
  return { order: full, stored };
}
export function addOrder(order: Omit<Order, "id" | "mode" | "createdAt">): Order {
  return addOrderStored(order).order;
}

export const loadCart = () => read<CartItem>(CART_KEY);
/** True when the cart was stored. */
export function saveCart(items: CartItem[]): boolean {
  const ok = write(CART_KEY, items);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CART_EVENT));
  return ok;
}

/** Put a removed line back where it was (the mini cart's undo). */
export function restoreCartItem(item: CartItem, index: number): boolean {
  const cart = loadCart().filter((c) => c.id !== item.id);
  cart.splice(Math.min(index, cart.length), 0, item);
  return saveCart(cart);
}

export function cartItemFromStub(stub: Stub, material: Material, finish: Finish, size: PrintSize): CartItem {
  const q = quote(material, finish, size);
  const seats = [{ name: "You", claimed: true }, ...stub.personal.friends.map((f) => ({ name: f.name, seat: f.seat, claimed: f.claimed }))];
  return {
    id: `c_${Math.random().toString(36).slice(2, 10)}`,
    stubId: stub.id,
    title: stub.event.title,
    material,
    finish,
    size,
    unitMinor: q.itemMinor + q.finishMinor,
    quoteId: q.quoteId,
    capabilityVersion: q.capabilityVersion,
    variantStatus: q.variantStatus,
    seats,
    addedAt: new Date().toISOString(),
  };
}

/** True when the cart was stored. */
export function addToCart(item: CartItem): boolean {
  return saveCart([...loadCart().filter((c) => c.stubId !== item.stubId), item]);
}
