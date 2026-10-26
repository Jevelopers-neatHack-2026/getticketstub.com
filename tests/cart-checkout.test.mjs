import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import "./analytics-hooks.mjs";
const commerce = await import("../src/customer/pages/commerce.ts");
const capabilities = await import("../src/customer/pages/capabilities.ts");

// Execute the complete production component and its callbacks with a small hook host.
// UI primitives, storage and transport are synthetic; arithmetic and capability gates are real.
// No browser, payment provider or hosted acceptance is implied.
const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const jsx = (type, props) => ({ type, props });
const primitives = new Proxy({}, { get: (_, name) => name === "ui" ? {} : name });
const seat = (decision) => ({ name: "Guest", claimed: false, ...(decision ? { decision } : {}) });
const item = (id, material = "digital", seats = [seat()]) => ({
  id, stubId: id, title: id, material, finish: "matte", size: material === "digital" ? "file" : "classic",
  unitMinor: material === "digital" ? 900 : 4900, seats, capabilityVersion: capabilities.CAPABILITY_VERSION,
  quoteId: `quote-${id}`, addedAt: "2026-10-25T00:00:00Z",
});
function host(initialItems, { signedIn = true, mode = "demo", mini = false } = {}) {
  let stored = initialItems, index = 0, dirty = false, pendingGuest;
  const cells = [], effects = [], listeners = new Map(), orders = [], torn = [], events = [], signIns = [], navigations = [];
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in cells)) cells[i] = typeof initial === "function" ? initial() : initial;
      return [cells[i], (next) => { cells[i] = typeof next === "function" ? next(cells[i]) : next; dirty = true; }];
    },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial }; },
    useMemo(fn) { return fn(); },
    useEffect(fn, deps) {
      const i = index++, previous = cells[i];
      if (!previous || !deps || deps.some((v, j) => previous.deps?.[j] !== v)) {
        effects.push(() => { previous?.cleanup?.(); cells[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  const receipt = { email: "guest@example.invalid", signedIn, problem: "" };
  const modules = {
    react,
    "next/navigation": { usePathname: () => "/", useRouter: () => ({ push: (path) => navigations.push(path) }) },
    "./cartStore": { useMiniCartOpen: () => true, useCartItems: () => stored, closeMiniCart() {} },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "@/customer/pages/commerce": { ...commerce, loadCart: () => stored, saveCart: (items) => { stored = items; return true; } },
    "@/customer/pages/capabilities": { ...capabilities, runtimeMode: () => mode },
    "@/customer/studio/types": { formatMoney: (minor) => `$${(minor / 100).toFixed(2)}` },
    "@/customer/studio/store": { getStub: (id) => ({ id }), upsertStub: (stub) => torn.push(stub.id) },
    "@/customer/studio/feedback": { haptic() {}, play() {} },
    "@/customer/pages/useMounted": { useMounted: () => true },
    "@/customer/account/Receipt": { ...primitives, useReceiptEmail: () => receipt,
      askToSignIn: (_, continuation) => { signIns.push(continuation); if (signedIn) return false; pendingGuest = continuation; return true; } },
    "@/customer/account/useOrderFlow": { useOrderFlow: () => ({ placed: null, progress: {}, retry() {},
      place: (draft, after) => orders.push({ draft, after }) }) },
    "@/customer/flows/events": { flow: (name, data) => events.push({ name, data }), major: (n) => n / 100, variantId: (...v) => v.join("_") },
  };
  const exported = {};
  vm.runInNewContext(compile(mini ? "../src/customer/cart/MiniCart.tsx" : "../src/app/cart/CartClient.tsx"), {
    exports: exported,
    require: (name) => modules[name] ?? (name.endsWith(".css") ? { default: {} } : primitives),
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) },
    document: { getElementById: () => ({ focus() {} }), querySelector: () => ({ focus() {} }) },
  });
  function render() {
    let tree;
    do { dirty = false; index = 0; tree = mini ? exported.MiniCart() : exported.default(); effects.splice(0).forEach((fn) => fn()); } while (dirty);
    return tree;
  }
  return { render, orders, torn, events, signIns, navigations,
    update(items) { stored = items; listeners.get(commerce.CART_EVENT)?.(); return render(); },
    continueAsGuest() { pendingGuest?.(); },
  };
}
function descendants(node) {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!node || typeof node !== "object") return [];
  return [node, ...descendants(node.props?.children)];
}
const find = (tree, type) => descendants(tree).find((node) => node.type === type);

for (const seats of [[seat("drop")], [], undefined, null]) test(`cart with no retained seats has an empty state and no Pay action (${JSON.stringify(seats)})`, () => {
  const line = item("cancelled"); line.seats = seats;
  const env = host([line]);
  const tree = env.render();
  assert.equal(find(tree, "EmptyState")?.props.title, "No seats left to check out.");
  assert.equal(find(tree, "Stamp"), undefined);
  assert.equal(env.orders.length, 0);
  assert.equal(env.signIns.length, 0);
  assert.equal(env.events.filter((e) => e.name === "begin_checkout").length, 0);
});

test("mixed cart places only retained lines and never tears a fully dropped stub", () => {
  const dropped = { ...item("dropped-physical", "print", [seat("drop")]), capabilityVersion: "legacy" };
  const kept = item("retained-digital", "digital", [seat(), seat("drop"), seat("gift")]);
  const env = host([dropped, kept], { mode: "live" });
  const pay = find(env.render(), "Stamp");
  assert.equal(pay.props.disabled, false, "a dropped physical preview must not block the retained digital line");
  pay.props.onClick();
  assert.equal(env.orders.length, 1);
  const { draft, after } = env.orders[0];
  assert.deepEqual(Array.from(draft.stubIds), [kept.stubId]);
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0].title, kept.title);
  assert.equal(draft.lines[0].totalMinor, 1800);
  assert.equal(draft.totalMinor, 1800);
  assert.equal(draft.quoteId, kept.quoteId);
  assert.equal(env.events.find((e) => e.name === "begin_checkout").data.item_count, 1);
  after();
  assert.deepEqual(env.torn, [kept.stubId]);
  // The callback cannot create another order after placement.
  pay.props.onClick();
  assert.equal(env.orders.length, 1);
});

test("a cart emptied while sign-in is open cannot place the old order on guest continuation", () => {
  const env = host([item("initial")], { signedIn: false });
  find(env.render(), "Stamp").props.onClick();
  assert.equal(env.signIns.length, 1);
  assert.equal(env.orders.length, 0);
  const tree = env.update([item("initial", "digital", [seat("drop")])]);
  assert.ok(find(tree, "EmptyState"));
  env.continueAsGuest();
  assert.equal(env.orders.length, 0);
  assert.equal(env.events.filter((e) => e.name === "begin_checkout").length, 0);
});

for (const retained of [false, true]) test(`mini cart ${retained ? "allows retained seats" : "blocks checkout when every seat is dropped"}`, () => {
  const env = host([item("mini", "digital", [seat(retained ? undefined : "drop")])], { mini: true });
  const pay = find(env.render(), "Stamp");
  assert.equal(pay.props.disabled, !retained);
  pay.props.onClick();
  assert.deepEqual(env.navigations, retained ? ["/cart#pay"] : []);
});

test("mixed malformed seat entries render safely and preserve the retained seat's original update index", () => {
  const env = host([item("mixed", "digital", [null, seat(), 42, undefined])]);
  const tree = env.render();
  assert.equal(find(tree, "TearAnchor")?.props.href, "/cart/unclaimed/mixed?seat=1");
  find(tree, "Stamp").props.onClick();
  assert.equal(env.orders[0].draft.lines[0].totalMinor, 900);
});

test("mini cart counts only the valid retained seat in a mixed malformed array", () => {
  const env = host([item("mixed-mini", "digital", [null, seat(), 42, undefined])], { mini: true });
  const tree = env.render();
  assert.equal(find(tree, "Stamp").props.disabled, false);
  assert.equal(commerce.billableSeats(item("mixed-mini", "digital", [null, seat(), 42, undefined])), 1);
});
