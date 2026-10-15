// Prices shared by the browser and the server. No browser APIs here: the server re-derives a paid order's amount
// from these and never charges a total the browser sent without checking it.
import { MATERIALS, type Finish, type Material } from "@/customer/studio/types";

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

/** One stub of this material and finish, before shipping. Holo is never printed, so it adds nothing to a print. */
export function unitPriceMinor(material: Material, finish: Finish): number {
  const physical = material !== "digital";
  const finishMinor = physical && finish !== "holo" ? (FINISHES.find((f) => f.id === finish)?.upchargeMinor ?? 0) : 0;
  return materialPrice(material) + finishMinor;
}
