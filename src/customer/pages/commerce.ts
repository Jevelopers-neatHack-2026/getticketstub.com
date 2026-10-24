"use client";
// Sandbox commerce for the hackathon build. Nothing here calls a payment, print or shipping API.
// A quote is not a purchase: quotes expire, and an "order" is a local sandbox record only.
import { MATERIALS, type Finish, type Material, type Stub } from "@/customer/studio/types";

export const ORDERS_KEY = "ticketstub.orders.v1";
export const CART_KEY = "ticketstub.cart.v1";
export const SANDBOX_LABEL = "Sandbox · no real charge";

export type PrintSize = "classic" | "stamp" | "framed" | "file";

export const SIZE_LABEL: Record<PrintSize, string> = {
  classic: "Classic stub · 2 × 5.5 in",
  stamp: "Stamp · 2 × 3 in",
  framed: "Framed print · 8 × 10 in",
  file: "Digital file · PNG and wallet pass",
};

/** Which sizes a material can be printed at. */
export function sizesFor(material: Material): PrintSize[] {
  if (material === "digital") return ["file"];
  if (material === "framed") return ["framed"];
  return ["classic", "stamp"];
}

export const FINISHES: { id: Finish; label: string; upchargeMinor: number }[] = [
  { id: "matte", label: "Matte", upchargeMinor: 0 },
  { id: "foil", label: "Foil", upchargeMinor: 600 },
  { id: "holo", label: "Holo", upchargeMinor: 900 },
];

/** Estimated shipping, flat. Shown as [estimated] until a real print partner quote exists. */
export const SHIPPING_ESTIMATE_MINOR = 600;

export function materialPrice(material: Material): number {
  return MATERIALS.find((m) => m.id === material)?.priceMinor ?? 0;
}

export interface Quote {
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
  const finishMinor = physical ? (FINISHES.find((f) => f.id === finish)?.upchargeMinor ?? 0) * qty : 0;
  const shippingMinor = physical ? SHIPPING_ESTIMATE_MINOR : 0;
  return { material, finish, size, itemMinor, finishMinor, shippingMinor, totalMinor: itemMinor + finishMinor + shippingMinor, expiresAt: Date.now() + 15 * 60_000 };
}

export interface Order {
  id: string;
  mode: "sandbox";
  createdAt: string;
  stubIds: string[];
  lines: { title: string; material: Material; finish: Finish; size: PrintSize; totalMinor: number }[];
  totalMinor: number;
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
  seats: CartSeat[]; // matching set: one stub per seat
  addedAt: string;
}

/** Manual sandbox choices for unclaimed seats; no seven-day timer or real refund is implemented. */
export type SeatDecision = "seat-only" | "gift" | "drop";
export interface CartSeat {
  name: string;
  seat?: string;
  claimed: boolean;
  decision?: SeatDecision;
}

/** Count seats not marked "drop", with a minimum charge of one seat per cart item. */
export function billableSeats(item: CartItem): number {
  return Math.max(1, item.seats.filter((x) => x.decision !== "drop").length);
}

export function cartTotals(items: CartItem[]) {
  const itemsMinor = items.reduce((sum, i) => sum + i.unitMinor * billableSeats(i), 0);
  const shippingMinor = items.some((i) => i.material !== "digital") ? SHIPPING_ESTIMATE_MINOR : 0;
  return { itemsMinor, shippingMinor, totalMinor: itemsMinor + shippingMinor };
}

export function updateSeat(itemId: string, seatIndex: number, patch: Partial<CartSeat>): void {
  saveCart(loadCart().map((c) => (c.id === itemId ? { ...c, seats: c.seats.map((x, i) => (i === seatIndex ? { ...x, ...patch } : x)) } : c)));
}

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}
function write<T>(key: string, value: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export const loadOrders = () => read<Order>(ORDERS_KEY);
export function addOrder(order: Omit<Order, "id" | "mode" | "createdAt">): Order {
  const full: Order = { ...order, id: `sbx_${Math.random().toString(36).slice(2, 10)}`, mode: "sandbox", createdAt: new Date().toISOString() };
  write(ORDERS_KEY, [full, ...loadOrders()]);
  return full;
}

export const loadCart = () => read<CartItem>(CART_KEY);
export const saveCart = (items: CartItem[]) => write(CART_KEY, items);

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
    seats,
    addedAt: new Date().toISOString(),
  };
}

export function addToCart(item: CartItem): void {
  saveCart([...loadCart().filter((c) => c.stubId !== item.stubId), item]);
}
