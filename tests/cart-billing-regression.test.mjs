import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./analytics-hooks.mjs";

const {
  addToCart, billableSeats, CART_KEY, cartTotals, loadCart, restoreCartItem,
  saveCart, SHIPPING_ESTIMATE_MINOR, updateSeat,
} = await import("../src/customer/pages/commerce.ts");

const originalStorage = globalThis.localStorage;
afterEach(() => {
  if (originalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalStorage;
});

function item(id, material, seats, unitMinor = material === "digital" ? 900 : 4900) {
  return {
    id, stubId: `stub-${id}`, title: `Event ${id}`, material, finish: "matte",
    size: material === "digital" ? "file" : "classic", unitMinor, seats,
    addedAt: "2026-10-25T00:00:00.000Z",
  };
}
const seat = (name, decision, claimed = false) => ({ name, claimed, ...(decision ? { decision } : {}) });
const retained = (count) => Array.from({ length: count }, (_, i) => seat(`Retained ${i}`, undefined, true));
const dropped = (count) => Array.from({ length: count }, (_, i) => seat(`Dropped ${i}`, "drop", true));

function memoryStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  return values;
}

test("independent billing matrix excludes dropped seats regardless of claim status or line order", () => {
  for (let physicalCount = 0; physicalCount <= 3; physicalCount++) {
    for (let digitalCount = 0; digitalCount <= 3; digitalCount++) {
      const physical = item("physical", "print", [...dropped(2), ...retained(physicalCount)]);
      const digital = item("digital", "digital", [...retained(digitalCount), ...dropped(2)]);
      const expected = {
        itemsMinor: physicalCount * 4900 + digitalCount * 900,
        shippingMinor: physicalCount > 0 ? SHIPPING_ESTIMATE_MINOR : 0,
        totalMinor: physicalCount * 4900 + digitalCount * 900 + (physicalCount > 0 ? SHIPPING_ESTIMATE_MINOR : 0),
      };
      assert.deepEqual(cartTotals([physical, digital]), expected, `retained physical=${physicalCount}, digital=${digitalCount}`);
      assert.deepEqual(cartTotals([digital, physical]), expected, "line ordering does not change the bill");
      assert.equal(billableSeats(physical), physicalCount);
      assert.equal(billableSeats(digital), digitalCount);
    }
  }
});

test("seat-only, gift and undecided seats remain billable while drop always removes a seat", () => {
  const line = item("mixed-decisions", "card", [
    seat("Claimed", undefined, true), seat("Unclaimed", undefined, false),
    seat("Seat only", "seat-only"), seat("Named gift", "gift"),
    seat("Dropped claimed", "drop", true), seat("Dropped unclaimed", "drop", false),
  ], 2900);
  const before = structuredClone(line);
  assert.equal(billableSeats(line), 4);
  assert.deepEqual(cartTotals([line]), { itemsMinor: 11600, shippingMinor: 600, totalMinor: 12200 });
  assert.deepEqual(line, before, "pricing must not rewrite claims or seat decisions");
});

test("empty and missing legacy seat arrays contribute zero quantity, zero charges and no shipping", () => {
  const empty = item("empty", "print", []);
  const missing = item("missing", "print", []);
  delete missing.seats;
  const nullSeats = item("null", "print", null);
  const sparse = item("sparse", "print", new Array(3));
  const nullEntries = item("null-entries", "print", [null, undefined]);
  for (const line of [empty, missing, nullSeats, sparse, nullEntries]) {
    assert.equal(billableSeats(line), 0, line.id);
    assert.deepEqual(cartTotals([line]), { itemsMinor: 0, shippingMinor: 0, totalMinor: 0 }, line.id);
    assert.deepEqual(cartTotals([line, item("file", "digital", retained(2))]), {
      itemsMinor: 1800, shippingMinor: 0, totalMinor: 1800,
    }, `${line.id} must not turn a digital-only purchase into a shipment`);
  }
  assert.deepEqual(cartTotals([]), { itemsMinor: 0, shippingMinor: 0, totalMinor: 0 });
});

test("dropping the last physical seat through persisted cart updates removes shipping without losing digital seats", () => {
  const values = memoryStorage();
  const physical = item("physical", "print", [seat("A", undefined, true), seat("B", "gift")]);
  const digital = item("digital", "digital", [seat("C", "seat-only")]);
  assert.equal(saveCart([physical, digital]), true);
  assert.deepEqual(cartTotals(loadCart()), { itemsMinor: 10700, shippingMinor: 600, totalMinor: 11300 });
  assert.equal(updateSeat("physical", 0, { decision: "drop" }), true);
  assert.deepEqual(cartTotals(loadCart()), { itemsMinor: 5800, shippingMinor: 600, totalMinor: 6400 });
  assert.equal(updateSeat("physical", 1, { decision: "drop" }), true);
  const saved = JSON.parse(values.get(CART_KEY));
  assert.deepEqual(cartTotals(saved), { itemsMinor: 900, shippingMinor: 0, totalMinor: 900 });
  assert.deepEqual(saved[1], digital, "dropping a physical seat must not rewrite the digital line");
  assert.equal(saved[0].seats.length, 2, "dropped seat history remains available");
  assert.equal(updateSeat("physical", 1, { decision: "gift" }), true);
  assert.deepEqual(cartTotals(loadCart()), { itemsMinor: 5800, shippingMinor: 600, totalMinor: 6400 }, "restoring one physical seat restores one charge and one shipment estimate");
});

test("reloading and undoing removal of a fully dropped line never revives its charge", () => {
  memoryStorage();
  const cancelled = item("cancelled", "print", dropped(3));
  const file = item("file", "digital", retained(1));
  assert.equal(addToCart(cancelled), true);
  assert.equal(addToCart(file), true);
  assert.deepEqual(cartTotals(loadCart()), { itemsMinor: 900, shippingMinor: 0, totalMinor: 900 });
  assert.equal(saveCart(loadCart().filter((line) => line.id !== cancelled.id)), true);
  assert.equal(restoreCartItem(cancelled, 0), true);
  assert.deepEqual(loadCart().map((line) => line.id), ["cancelled", "file"]);
  assert.deepEqual(cartTotals(loadCart()), { itemsMinor: 900, shippingMinor: 0, totalMinor: 900 });
  assert.equal(updateSeat("file", 0, { decision: "drop" }), true);
  assert.deepEqual(cartTotals(loadCart()), { itemsMinor: 0, shippingMinor: 0, totalMinor: 0 });
});
