// Credential-free check of the capability map (GT-07A): every tier x size x finish is present and honest, no dimension is
// invented, the documented 18 x 24 / 14 x 20 frame example holds as geometry, old carts are told to choose again, and live
// mode blocks anything that is not orderable. No network, no provider call.
// Run: node scripts/check-capabilities.mjs   (Node 22.15+; uses module.registerHooks to run the .ts sources directly)
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

process.removeAllListeners("warning"); // the .ts sources have no package "type"; the reparse warning is noise here
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

// Node's type stripping needs explicit extensions; the Next sources use extensionless and "@/" imports.
registerHooks({
  resolve(specifier, context, next) {
    let spec = specifier;
    if (spec.startsWith("@/")) spec = pathToFileURL(join(src, spec.slice(2))).href;
    try {
      return next(spec, context);
    } catch (err) {
      if (!/^(\.|file:)/.test(spec)) throw err;
      for (const ext of [".ts", "/index.ts"]) {
        try { return next(spec + ext, context); } catch { /* try the next one */ }
      }
      throw err;
    }
  },
});

// The commerce module stores carts and orders in localStorage: give it an in-memory one.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
globalThis.fetch = () => { throw new Error("check-capabilities must not use the network"); };

const cap = await import(pathToFileURL(join(src, "customer/pages/capabilities.ts")).href);
const commerce = await import(pathToFileURL(join(src, "customer/pages/commerce.ts")).href);
const sandbox = await import(pathToFileURL(join(src, "server/fulfillment/sandbox-products.ts")).href);

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

const MATERIALS = ["digital", "card", "print", "framed"];
const FINISHES = ["matte", "foil", "holo"];
const SIZES = { digital: ["file"], card: ["classic", "stamp"], print: ["classic", "stamp"], framed: ["framed"] };
const get = (m, s, f) => cap.variantFor(m, s, f);

// CAPABILITY_VERSION is bumped only when what a quote or cart line means changes (see the capabilities.ts header). The sandbox
// validation product has its own revision, so adding or editing it must not move this pin.
check("the version is pinned", () => assert.equal(cap.CAPABILITY_VERSION, "2026-10-11.1"));

check("the sandbox validation products live outside the versioned customer map, with their own revision", () => {
  assert.equal(cap.SANDBOX_VALIDATION_PRODUCTS, undefined, "capabilities.ts must not carry sandbox validation products");
  assert.equal(sandbox.SANDBOX_PRODUCTS_REVISION, "2026-10-12.1");
  assert.match(sandbox.SANDBOX_PRODUCTS_REVISION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

check("every tier x size x finish is present, once", () => {
  let count = 0;
  for (const m of MATERIALS) for (const s of SIZES[m]) for (const f of FINISHES) {
    const v = get(m, s, f);
    assert.ok(v, `${m}.${s}.${f} is missing`);
    assert.equal(v.id, `${m}.${s}.${f}`);
    count++;
  }
  assert.equal(cap.VARIANTS.length, count, "the map holds a variant that no tier offers");
  assert.equal(new Set(cap.VARIANTS.map((v) => v.id)).size, count, "duplicate ids");
  assert.equal(count, 18);
  assert.deepEqual(commerce.sizesFor("framed"), ["framed"]);
});

check("every variant records status, provenance, date and valid sources", () => {
  for (const v of cap.VARIANTS) {
    assert.ok(["orderable", "preview", "unavailable"].includes(v.status), v.id);
    assert.ok(["confirmed", "published-docs", "assumed"].includes(v.provenance), v.id);
    assert.match(v.reviewed, /^\d{4}-\d{2}-\d{2}$/, v.id);
    assert.ok(v.measures.length > 20, `${v.id} needs a plain-language measures line`);
    assert.ok(v.finishNote.length > 0, v.id);
    for (const url of v.sources) assert.match(url, /^https:\/\/(www|support)\.prodigi\.com\//, v.id);
    assert.deepEqual(Object.keys(v.dims).sort(), ["bleed", "exterior", "glazing", "matWindow", "safeArea", "trim"], v.id);
  }
});

check("nothing physical has a confirmed SKU: every physical variant is a preview or unavailable", () => {
  for (const v of cap.VARIANTS.filter((x) => x.material !== "digital")) {
    assert.equal(v.sku, null, `${v.id} has a SKU nobody confirmed`);
    assert.equal(v.supplier, null, `${v.id} names a supplier nobody confirmed`);
    assert.notEqual(v.status, "orderable", v.id);
    assert.notEqual(v.provenance, "confirmed", v.id);
  }
});

check("the sandbox validation product is GLOBAL-PHO-4X6, 6 × 4 in at 300 dpi, US Standard, and not customer-facing", () => {
  assert.equal(sandbox.SANDBOX_VALIDATION_PRODUCTS.length, 1);
  const p = sandbox.SANDBOX_VALIDATION_PRODUCTS[0];
  assert.equal(p.purpose, "sandbox-validation");
  assert.equal(p.customerFacing, false);
  assert.equal(p.supplier, "Prodigi");
  assert.equal(p.sku, "GLOBAL-PHO-4X6");
  assert.equal(p.printArea, "default");
  assert.equal(p.orientation, "landscape");
  assert.deepEqual(p.size, { w: 6, h: 4, unit: "in" });
  assert.deepEqual(p.artwork, { w: 1800, h: 1200, unit: "px", dpi: 300, colorSpace: "sRGB", format: "jpg", sizing: "fillPrintArea", pixelBasis: "derived" });
  assert.equal(p.artwork.w, p.size.w * p.artwork.dpi);
  assert.equal(p.artwork.h, p.size.h * p.artwork.dpi);
  assert.equal(p.finish, "lustre");
  assert.equal(p.destinationCountry, "US");
  assert.deepEqual(p.shippingMethod, { order: "Standard", quote: "standard" });
  assert.notEqual(p.provenance, "confirmed", "no authenticated product-details read has been made");
  assert.match(p.decision, /0003-owner-delegated-decisions-2026-10-12/);
  assert.match(p.reviewed, /^\d{4}-\d{2}-\d{2}$/);
  for (const url of p.sources) assert.match(url, /^https:\/\/(www|support)\.prodigi\.com\//);
  assert.ok(p.sources.includes(sandbox.SANDBOX_SOURCES.cTypes));
  // The pixel size is derived (size x dpi), not published: it stays open until the product-details read confirms it.
  assert.ok(p.open.some((line) => /1800 × 1200/.test(line) && /derived/.test(line) && /printAreaSizes/.test(line)));
  assert.ok(p.open.some((line) => /customer-facing print-tier mapping/.test(line) && /open product decision/.test(line)));
  // A Classic stub (5.5 × 2 in at 300 dpi) fits on the sheet; it is composed on it, not trimmed to it.
  assert.ok(5.5 * 300 <= p.artwork.w && 2 * 300 <= p.artwork.h);
});

check("the sandbox validation SKU maps to no customer variant and changes no customer claim", () => {
  for (const p of sandbox.SANDBOX_VALIDATION_PRODUCTS) {
    assert.ok(!cap.VARIANTS.some((v) => v.sku === p.sku), `${p.sku} must not be a customer variant's SKU`);
    assert.ok(!cap.VARIANTS.some((v) => v.id === p.id), `${p.id} must not be a variant`);
  }
  for (const v of cap.VARIANTS.filter((x) => x.material === "print")) {
    assert.notEqual(v.status, "orderable", v.id);
    assert.ok(!/lustre/i.test(v.finishNote), `${v.id} must not claim lustre`);
  }
  assert.ok(!Object.values(cap.SIZE_COPY).some((c) => /6 × 4|4 × 6 in photo/.test(c.measure)), "no size copy names the validation sheet");
});

check("digital is orderable in the sandbox; digital Holo is a screen-effect preview", () => {
  assert.equal(get("digital", "file", "matte").status, "orderable");
  assert.equal(get("digital", "file", "foil").status, "orderable");
  assert.equal(get("digital", "file", "holo").status, "preview");
  assert.equal(get("digital", "file", "matte").sku, null);
});

check("Holo is never a printed finish", () => {
  for (const m of ["card", "print", "framed"]) for (const s of SIZES[m]) assert.equal(get(m, s, "holo").status, "unavailable", `${m}.${s}.holo`);
  for (const m of ["card", "print", "framed"]) assert.equal(cap.statusLine(get(m, SIZES[m][0], "holo")), "Screen effect · not printed");
});

check("Card+Foil, Print+Holo and Framed+Holo are represented explicitly", () => {
  const cardFoil = get("card", "classic", "foil");
  assert.equal(cardFoil.status, "preview");
  assert.match(cardFoil.finishNote, /4 × 6/);
  assert.match(cardFoil.finishNote, /unverified/);
  assert.equal(get("card", "stamp", "foil").status, "preview");
  for (const s of ["classic", "stamp"]) assert.equal(get("print", s, "holo").status, "unavailable");
  const framedHolo = get("framed", "framed", "holo");
  assert.equal(framedHolo.status, "unavailable");
  assert.match(framedHolo.finishNote, /Screen effect/);
  const framedFoil = get("framed", "framed", "foil");
  assert.equal(framedFoil.provenance, "published-docs");
  assert.ok(framedFoil.sources.some((u) => u.includes("framed-metallic-foil")));
});

check("no unknown dimension is fabricated", () => {
  for (const v of cap.VARIANTS) {
    for (const [name, d] of Object.entries(v.dims)) {
      assert.ok(["known", "unknown", "n/a"].includes(d.state), `${v.id}.${name}`);
      if (d.state === "known") {
        assert.ok(Number.isFinite(d.w) && Number.isFinite(d.h) && d.w > 0 && d.h > 0, `${v.id}.${name} needs real numbers`);
        assert.ok(["in", "px"].includes(d.unit), `${v.id}.${name} needs units`);
        assert.ok(["confirmed", "published-docs", "assumed"].includes(d.basis), `${v.id}.${name} needs a basis`);
      } else {
        assert.deepEqual(Object.keys(d), ["state"], `${v.id}.${name} is ${d.state} but carries values`);
      }
    }
    // Nothing is unit-confirmed without a confirmed SKU.
    if (v.sku === null) for (const d of Object.values(v.dims)) if (d.state === "known") assert.notEqual(d.basis, "confirmed", v.id);
  }
  const framed = get("framed", "framed", "matte").dims;
  assert.equal(framed.exterior.state, "unknown", "the frame's outside size depends on the profile");
  assert.equal(framed.matWindow.state, "unknown", "the image window depends on the mat");
  assert.equal(framed.bleed.state, "unknown");
  assert.equal(framed.safeArea.state, "unknown");
  assert.deepEqual(framed.glazing, { state: "known", w: 8, h: 10, unit: "in", basis: "published-docs" });
  const classic = get("card", "classic", "matte").dims;
  assert.deepEqual(classic.trim, { state: "known", w: 2, h: 5.5, unit: "in", basis: "assumed" });
  assert.equal(classic.bleed.state, "unknown", "no accepted template yet");
  assert.equal(get("digital", "file", "matte").dims.trim.state, "unknown", "no pixel size is fixed");
  assert.equal(cap.dimText(framed.exterior), "Unknown");
});

check("the frame size copy says what 8 × 10 measures", () => {
  assert.equal(cap.SIZE_COPY.framed.caption, "Frame 8 × 10 in · image window depends on the mat");
  assert.match(get("framed", "framed", "matte").measures, /glazing/);
  assert.match(commerce.SIZE_LABEL.framed, /Frame 8 × 10 in/);
  assert.match(commerce.SIZE_LABEL.classic, /2 × 5\.5 in trim/);
});

check("the 18 × 24 glazing / 14 × 20 mat example is a geometry fixture", () => {
  const fx = cap.GEOMETRY_FIXTURES.find((f) => f.id === "prodigi-frame-faq-18x24-2in-mount");
  assert.ok(fx, "fixture missing");
  assert.deepEqual(fx.glazing, { w: 18, h: 24, unit: "in" });
  assert.equal(fx.mountPerSide, 2);
  assert.deepEqual(cap.imageWindow(fx.glazing, fx.mountPerSide), { w: 14, h: 20 });
  assert.deepEqual(fx.imageWindow, { w: 14, h: 20, unit: "in" });
  assert.match(fx.note, /not a launch SKU/);
  assert.ok(!cap.VARIANTS.some((v) => v.dims.glazing.state === "known" && v.dims.glazing.w === 18), "the example must not leak into a variant");
});

check("a quote id names the capability version, so any change is a new quote", () => {
  const a = commerce.quote("print", "foil", "classic");
  assert.ok(a.quoteId.includes(cap.CAPABILITY_VERSION));
  assert.equal(a.capabilityVersion, cap.CAPABILITY_VERSION);
  assert.equal(a.variantStatus, "preview");
  assert.equal(a.sku, null);
  const ids = new Set([a.quoteId, commerce.quote("print", "matte", "classic").quoteId, commerce.quote("print", "foil", "stamp").quoteId, commerce.quote("card", "foil", "classic").quoteId, commerce.quote("print", "foil", "classic", 3).quoteId]);
  assert.equal(ids.size, 5);
  assert.ok(cap.quoteStillHolds({ material: "print", finish: "foil", size: "classic", quoteId: a.quoteId }));
  assert.ok(!cap.quoteStillHolds({ material: "print", finish: "matte", size: "classic", quoteId: a.quoteId }), "a finish change must void the quote");
  assert.ok(!cap.quoteStillHolds({ material: "print", finish: "foil", size: "classic", quoteId: "qt_print_foil_classic_x1" }), "a pre-map quote id must not hold");
});

check("prices stay explicit sandbox fixtures: finish included or extra, Holo never charged for print", () => {
  assert.equal(commerce.quote("print", "matte", "classic").finishMinor, 0);
  assert.equal(commerce.quote("print", "foil", "classic").finishMinor, 600);
  assert.equal(commerce.quote("print", "holo", "classic").finishMinor, 0);
  assert.equal(commerce.quote("digital", "foil", "file").finishMinor, 0);
  assert.deepEqual(commerce.finishPrices("print"), { matte: "Included", foil: "+$6", holo: "Screen only" });
  assert.deepEqual(commerce.finishPrices("digital"), { matte: "Included", foil: "Included", holo: "Included" });
});

check("the gate: a preview is a sandbox fixture, never a live order; unavailable never orders", () => {
  const preview = get("print", "classic", "foil");
  assert.deepEqual(cap.orderGate(preview, "demo"), { ok: true, sandbox: true });
  const live = cap.orderGate(preview, "live");
  assert.equal(live.ok, false);
  assert.equal(live.reason, "preview-in-live");
  assert.match(live.message, /preview/i);
  const holo = get("framed", "framed", "holo");
  for (const mode of ["demo", "live"]) assert.equal(cap.orderGate(holo, mode).ok, false, `holo in ${mode}`);
  assert.equal(cap.orderGate(get("digital", "file", "matte"), "live").ok, true, "digital stays orderable in live");
  assert.equal(cap.orderGate(undefined, "demo").ok, false);
});

check("live mode is TICKETSTUB_RUNTIME_MODE=live and nothing else", () => {
  assert.equal(cap.runtimeMode({ TICKETSTUB_RUNTIME_MODE: "live" }), "live");
  assert.equal(cap.runtimeMode({ NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE: "live" }), "live");
  assert.equal(cap.runtimeMode({ TICKETSTUB_RUNTIME_MODE: "preview" }), "demo");
  assert.equal(cap.runtimeMode({}), "demo");
  // In the browser the server's real mode arrives on <html data-runtime-mode>; it wins over the build-time mirror.
  {
    const saved = globalThis.document;
    try {
      globalThis.document = { documentElement: { dataset: { runtimeMode: "live" } } };
      assert.equal(cap.runtimeMode(), "live", "browser reads data-runtime-mode=live");
      globalThis.document = { documentElement: { dataset: { runtimeMode: "demo" } } };
      assert.equal(cap.runtimeMode(), "demo", "browser reads data-runtime-mode=demo");
      globalThis.document = { documentElement: { dataset: {} } };
      assert.equal(cap.runtimeMode(), cap.runtimeMode({ NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE: process.env.NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE, TICKETSTUB_RUNTIME_MODE: process.env.TICKETSTUB_RUNTIME_MODE }), "no attribute falls back to env");
      globalThis.document = { documentElement: { dataset: { runtimeMode: "live" } } };
      assert.equal(cap.runtimeMode({}), "demo", "an explicit env (the server's call sites) ignores the page attribute");
    } finally {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    }
  }
});

const legacyOrder = { id: "sbx_legacy01", mode: "sandbox", createdAt: "2026-10-09T10:00:00.000Z", stubIds: ["s1"], lines: [{ title: "Old night", material: "framed", finish: "holo", size: "framed", totalMinor: 9500 }], totalMinor: 9500, currency: "USD", quoteId: "qt_framed_holo_framed_x1", method: "card" };

check("live mode blocks ordering a preview variant; demo records a sandbox order", () => {
  const draft = { stubIds: ["s2"], lines: [{ title: "Tonight", material: "print", finish: "foil", size: "classic", totalMinor: 5500 }], totalMinor: 5500, method: "card" };
  store.set(commerce.ORDERS_KEY, JSON.stringify([legacyOrder]));
  const before = store.get(commerce.ORDERS_KEY);
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  assert.throws(() => commerce.addOrder(draft), commerce.OrderBlocked);
  assert.equal(store.get(commerce.ORDERS_KEY), before, "a blocked order must not be written");
  assert.throws(() => commerce.addOrder({ ...draft, lines: [{ ...draft.lines[0], material: "framed", size: "framed", finish: "holo" }] }), commerce.OrderBlocked);
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  const digital = commerce.addOrder({ ...draft, lines: [{ title: "Tonight", material: "digital", finish: "matte", size: "file", totalMinor: 900 }], totalMinor: 900 });
  assert.equal(digital.capabilityVersion, cap.CAPABILITY_VERSION);
  assert.equal(digital.lines[0].variantStatus, "orderable");
  delete process.env.TICKETSTUB_RUNTIME_MODE;
  const sandbox = commerce.addOrder(draft);
  assert.equal(sandbox.mode, "sandbox");
  assert.equal(sandbox.capabilityVersion, cap.CAPABILITY_VERSION);
  assert.equal(sandbox.lines[0].variantStatus, "preview");
});

check("migration: historical sandbox receipts are kept exactly as they were", () => {
  const orders = commerce.loadOrders();
  const old = orders.find((o) => o.id === "sbx_legacy01");
  assert.deepEqual(old, legacyOrder, "the legacy receipt changed");
  assert.equal(old.capabilityVersion, undefined);
  assert.equal(old.lines[0].variantStatus, undefined);
  assert.equal(old.quoteId, "qt_framed_holo_framed_x1");
});

const cartLine = (over) => ({ id: "c_1", stubId: "s1", title: "Old night", material: "framed", finish: "matte", size: "framed", unitMinor: 8900, quoteId: "qt_framed_matte_framed_x1", seats: [{ name: "You", claimed: true }], addedAt: "2026-10-09T10:00:00.000Z", ...over });

check("migration: a stale cart item is flagged Choose again, never reinterpreted", () => {
  const framed = commerce.cartItemState(cartLine());
  assert.equal(framed.state, "choose-again");
  assert.equal(framed.reason, "no-mapping");
  for (const [m, s] of [["card", "classic"], ["card", "stamp"], ["print", "classic"], ["print", "stamp"]]) {
    assert.equal(commerce.cartItemState(cartLine({ material: m, size: s, finish: "foil" })).state, "choose-again", `${m}.${s}`);
  }
  // an unknown pairing (an old size enum on the wrong tier) has no mapping at all
  const odd = commerce.cartItemState(cartLine({ material: "framed", size: "classic" }));
  assert.equal(odd.state, "choose-again");
  assert.equal(odd.reason, "unknown-variant");
  // an item from an older map version is asked again too
  assert.equal(commerce.cartItemState(cartLine({ capabilityVersion: "2026-01-01.0" })).reason, "old-version");
  // the stored item is untouched (the receipt data stays as it was)
  const stored = cartLine();
  commerce.cartItemState(stored);
  assert.deepEqual(stored, cartLine());
});

check("migration: a legacy digital line carries over, and a fresh line from today's map is current", () => {
  assert.equal(commerce.cartItemState(cartLine({ material: "digital", size: "file", finish: "matte" })).state, "current");
  assert.equal(commerce.cartItemState(cartLine({ material: "digital", size: "file", finish: "holo" })).state, "choose-again", "digital Holo is only a preview");
  const q = commerce.quote("print", "foil", "classic");
  const fresh = cartLine({ material: "print", size: "classic", finish: "foil", quoteId: q.quoteId, capabilityVersion: q.capabilityVersion });
  const res = commerce.cartItemState(fresh);
  assert.equal(res.state, "current");
  assert.equal(res.variant.status, "preview");
  assert.deepEqual(commerce.cartMarks([cartLine(), fresh]), ["blocked", "preview"]);
});

console.log(`\n${passed} checks passed${process.exitCode ? ", some failed" : ""}.`);
