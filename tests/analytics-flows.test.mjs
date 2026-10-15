import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import "./analytics-hooks.mjs";

// Customer flows through the real analytics pipeline, offline: the flow helpers and the screens' own modules
// (storage, sandbox orders, share links, sync, sign-in, cart, the editor's edit diff, the organizer's CSV)
// run against a fake browser, and everything the runtime would export is caught by a recording transport.
// Every test seeds private data (names, emails, notes, photos, tokens, URLs, CSV cells, error messages) and
// checks none of it is exported, that nothing was silently rejected by the catalog, and what was counted.

/* ---------- a small fake browser ---------- */

class FakeStorage {
  mode = "ok"; // "ok" | "quota" | "blocked"
  #m = new Map();
  getItem(k) {
    if (this.mode === "blocked") throw Object.assign(new Error("SEED blocked storage message"), { name: "SecurityError" });
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    if (this.mode === "quota") throw Object.assign(new Error("SEED quota message"), { name: "QuotaExceededError" });
    if (this.mode === "blocked") throw Object.assign(new Error("SEED blocked storage message"), { name: "SecurityError" });
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
  clear() {
    this.#m.clear();
  }
}
const localStorage = new FakeStorage();
const sessionStorage = new FakeStorage();
const win = new EventTarget();
Object.assign(win, { localStorage, sessionStorage, location: { origin: "https://getticketstub.example", hostname: "getticketstub.example", pathname: "/", search: "" }, matchMedia: () => ({ matches: false }) });
globalThis.window = win;
globalThis.localStorage = localStorage;
globalThis.sessionStorage = sessionStorage;
let nav = {};
Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => nav });

let fetches = [];
let reply = () => ({ status: 200, body: {} });
globalThis.fetch = async (path, init = {}) => {
  fetches.push({ path, method: init.method, body: init.body });
  const r = reply(path, init);
  if (r instanceof Error) throw r;
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};

/* ---------- the real analytics runtime, with a recording transport ---------- */

const runtime = await import("../src/customer/analytics/runtime.ts");
const { flow, errorCode, storageReason, artOutcome, vibeOf, resetStorageReports } = await import("../src/customer/flows/events.ts");
const store = await import("../src/customer/studio/store.ts");
const commerce = await import("../src/customer/pages/commerce.ts");
const share = await import("../src/customer/pages/share.ts");
const orders = await import("../src/customer/account/orders.ts");
const accountShare = await import("../src/customer/account/share.ts");
const sync = await import("../src/customer/account/sync.ts");
const signin = await import("../src/customer/account/signin.ts");
const saving = await import("../src/customer/account/saving.ts");
const cart = await import("../src/customer/cart/cartStore.ts");
const make = await import("../src/customer/start/make.ts");
const ops = await import("../src/customer/studio/editor/ops.ts");
const versions = await import("../src/customer/studio/versions/versions.ts");
const corrections = await import("../src/customer/studio/facts/corrections.ts");
const organizer = await import("../src/customer/pages/organizer.ts");
const { newStub } = await import("../src/customer/studio/fixtures.ts");
const routes = await import("../src/customer/nav/routes.ts");

const CONFIG = { measurementId: "G-TEST000000", environment: "preview", runtimeMode: "demo", debug: false };
const flush = () => new Promise((r) => setImmediate(r));

/** Private values. None may appear in anything the transport is handed. */
const SEEDS = {
  title: "SEED Jane's Secret Birthday Gig",
  venue: "SEED 12 Private Lane",
  name: "SEED Jane Doe",
  friend: "SEED Ravi Friend",
  email: "seed.jane.doe@example.com",
  note: "SEED we got engaged here",
  photo: "data:image/jpeg;base64,SEEDPHOTOBYTES",
  token: "SEEDTOKEN7f3a9",
  url: "https://tickets.example/SEEDURL55e?order=SEEDORDER",
  message: "SEED server said: account 42 is locked",
  csvHeader: "SEED_full_name",
  csvCell: "SEED Priya Private",
  fileName: "SEED-guests-of-jane.csv",
};
const seedValues = Object.values(SEEDS);

let sent = [];
let rejected = [];
function setup() {
  runtime.resetAnalyticsForTests();
  sent = [];
  rejected = [];
  runtime.setRejectHandler((name, reason) => rejected.push(`${name}: ${reason}`));
  runtime.configureAnalytics({
    config: CONFIG,
    origin: "https://getticketstub.example",
    referrer: "",
    transport: () => ({ load: async () => {}, send: (name, params) => sent.push([name, structuredClone(params)]), pause() {}, resume() {} }),
  });
  runtime.recordPageView("/wall", "");
  runtime.updateConsent("granted");
}
/** The fields the runtime attaches to every event; checked once, then left out of the comparisons below. */
const RUNTIME_FIELDS = ["schema_version", "deployment_env", "runtime_mode", "route_template", "page_location", "page_referrer", "page_title"];
/** Product events only (page views are the runtime's own), as the caller's parameters. */
const events = (name) =>
  sent
    .filter(([n]) => n !== "page_view" && (!name || n === name))
    .map(([, p]) => Object.fromEntries(Object.entries(p).filter(([k]) => !RUNTIME_FIELDS.includes(k))));
const names = () => sent.filter(([n]) => n !== "page_view").map(([n]) => n);

function privateStub(id = "stub-seed-1") {
  const st = newStub(
    {
      type: "concert",
      title: SEEDS.title,
      venue: SEEDS.venue,
      city: "SEED Hometown",
      dateISO: "2026-05-01",
      sourceUrl: SEEDS.url,
      facts: [
        { id: "date", label: "Date", value: "2026-05-01", source: SEEDS.url, provenance: "live", confidence: 0.6, alternatives: ["2026-05-01", "2026-05-02"], kept: true },
        { id: "venue", label: "Venue", value: SEEDS.venue, source: "SEED source", provenance: "live", confidence: 0.9, kept: false },
      ],
    },
    id,
  );
  return { ...st, photos: [SEEDS.photo], personal: { ...st.personal, note: SEEDS.note, friends: [{ name: SEEDS.friend, seat: "Seat 2", claimed: false }] } };
}

beforeEach(async () => {
  localStorage.mode = "ok";
  localStorage.clear();
  sessionStorage.mode = "ok";
  sessionStorage.clear();
  resetStorageReports();
  nav = {};
  fetches = [];
  reply = () => ({ status: 200, body: {} });
  setup();
  await flush();
});

afterEach(() => {
  // nothing a flow sent was dropped by the catalog, and nothing private reached the exporter
  assert.deepEqual(rejected, [], "the catalog rejected a flow event");
  const all = JSON.stringify(sent);
  for (const seed of seedValues) assert.ok(!all.includes(seed), `leaked ${seed}`);
  assert.ok(!all.includes("SEED"), `leaked a seeded value: ${all}`);
  for (const forbidden of ["purchase", "refund", "login", "sign_up"]) assert.ok(!names().includes(forbidden), forbidden);
});

/* ---------- helpers ---------- */

describe("flow helpers", () => {
  test("errors become bounded catalog codes, never their message", () => {
    assert.equal(errorCode(Object.assign(new Error(SEEDS.message), { code: "network" })), "network");
    assert.equal(errorCode(Object.assign(new Error(SEEDS.message), { code: SEEDS.message })), "unknown");
    assert.equal(errorCode({ error: { code: "rate_limited", message: SEEDS.message } }), "rate_limited");
    assert.equal(errorCode(Object.assign(new Error(SEEDS.message), { name: "AbortError" })), "timeout");
    assert.equal(errorCode(new Error(SEEDS.message)), "unknown");
    assert.equal(errorCode("variant_not_orderable"), "variant_not_orderable");
    assert.equal(errorCode(undefined), "unknown");
  });

  test("storage errors, art and vibes map to their few words", () => {
    assert.equal(storageReason({ name: "QuotaExceededError", message: SEEDS.message }), "quota");
    assert.equal(storageReason({ name: "SecurityError" }), "unavailable");
    assert.equal(storageReason(new SyntaxError(SEEDS.message)), "parse");
    assert.equal(storageReason(new Error(SEEDS.message)), "unknown");
    assert.deepEqual(artOutcome({ kind: "image", provenance: "live" }), { art: "generated", capability: "live" });
    // estimated or pending art is never reported as live
    assert.deepEqual(artOutcome({ kind: "procedural", provenance: "estimated" }), { art: "procedural", capability: "simulated" });
    assert.equal(vibeOf("Neon"), "neon");
    assert.equal(vibeOf(SEEDS.note), "custom");
    assert.equal(vibeOf(null), "none");
  });

  test("a value outside the catalog drops the whole event; flow() still never throws", () => {
    runtime.setRejectHandler(null);
    assert.doesNotThrow(() => flow("search_results", { result: "results", result_count: 3, query_kind: SEEDS.title }));
    assert.doesNotThrow(() => flow("not_an_event", { anything: SEEDS.email }));
    assert.deepEqual(events(), []);
  });
});

/* ---------- storage outcomes ---------- */

describe("storage outcomes", () => {
  test("a stored stub says so, and nothing is reported", () => {
    assert.equal(store.upsertStub(privateStub()), true);
    assert.equal(store.getStub("stub-seed-1")?.event.title, SEEDS.title);
    assert.equal(store.removeStub("stub-seed-1"), true);
    assert.deepEqual(names(), []);
  });

  test("a full quota is a false result and one failure report, whatever was in the record", () => {
    localStorage.mode = "quota";
    assert.equal(store.upsertStub(privateStub()), false);
    assert.equal(store.upsertStub(privateStub("stub-seed-2")), false);
    assert.equal(store.saveWall([privateStub()]), false);
    assert.deepEqual(events("storage_failure"), [{ store: "wall", op: "write", reason: "quota" }]);
  });

  test("an unreadable wall is reported as a parse failure and reads empty", () => {
    localStorage.setItem("ticketstub.wall.v1", `{"title":"${SEEDS.title}"`);
    assert.deepEqual(store.loadWall(), []);
    assert.deepEqual(events("storage_failure"), [{ store: "wall", op: "read", reason: "parse" }]);
  });

  test("keeping a finished print reports whether it was really stored", () => {
    const event = privateStub().event;
    assert.deepEqual(make.keepStubResult(event, "fresh-1"), { id: "fresh-1", created: true, stored: true });
    assert.deepEqual(make.keepStubResult(event, "fresh-2"), { id: "fresh-1", created: false, stored: true }); // the same night reopens
    localStorage.clear();
    localStorage.mode = "quota";
    assert.deepEqual(make.keepStubResult(event, "fresh-3"), { id: "fresh-3", created: true, stored: false });
    assert.equal(make.inputSource({ url: SEEDS.url }), "link");
    assert.equal(make.inputSource({ query: SEEDS.title }), "query");
    assert.equal(make.inputSource({ event }, true), "picked");
    assert.equal(make.inputSource({ event }), "demo");
  });

  test("an add that storage refused is not an add to cart", () => {
    const st = privateStub();
    localStorage.mode = "quota";
    assert.equal(cart.addToCartAndFly(commerce.cartItemFromStub(st, "print", "foil", "classic"), st, null, "checkout"), false);
    assert.deepEqual(events("add_to_cart"), []);
    assert.deepEqual(events("storage_failure"), [{ store: "cart", op: "write", reason: "quota" }]);
  });

  test("a stored add is one sandbox add_to_cart with a closed variant id and seat count", () => {
    const st = privateStub();
    const item = commerce.cartItemFromStub(st, "print", "foil", "classic");
    assert.equal(cart.addToCartAndFly(item, st, null, "friends"), true);
    const [add] = events("add_to_cart");
    assert.deepEqual(add, { currency: "USD", value: (item.unitMinor * 2) / 100, item_id: "print_foil_classic", quantity: 2, context: "friends", capability: "sandbox" });
    assert.equal(events().length, 1);
  });
});

/* ---------- sandbox orders ---------- */

const draft = () => ({
  stubIds: ["stub-seed-1"],
  lines: [{ title: SEEDS.title, material: "print", finish: "foil", size: "classic", totalMinor: 6100 }],
  totalMinor: 6100,
  currency: "USD",
  method: "card",
  email: SEEDS.email,
});

// a digital file, matte: orderable, so the server may charge for it
const payable = () => ({ ...draft(), lines: [{ title: SEEDS.title, material: "digital", finish: "matte", size: "file", totalMinor: 900 }], totalMinor: 900 });

describe("sandbox orders", () => {
  test("a draft that could be paid for keeps no local record when the server doesn't take it, whatever the error", async () => {
    assert.equal(orders.isPayable(payable()), true);
    assert.equal(orders.isPayable(draft()), false, "a preview variant is a sandbox order");
    assert.equal(orders.isPayable({ ...payable(), method: "gift-print" }), false);
    for (const code of ["amount_mismatch", "rate_limited", "internal"]) {
      reply = () => ({ status: 500, body: { error: { code, message: SEEDS.message } } });
      const placed = await orders.placeOrder(payable());
      assert.equal(placed.code, code);
      assert.deepEqual(commerce.loadOrders(), []);
    }
    reply = () => new TypeError(SEEDS.message);
    assert.equal((await orders.placeOrder(payable())).code, "network");
    assert.deepEqual(commerce.loadOrders(), []);
  });

  test("a server receipt is one sandbox_order, never a purchase", async () => {
    reply = () => ({ status: 200, body: { order: { ...draft(), id: "sbx_server", mode: "sandbox", createdAt: "x" } } });
    const placed = await orders.placeOrder(draft());
    assert.equal(placed.receipt, true);
    assert.deepEqual(events(), [{ method: "card", result: "placed", receipt: "server", line_count: 1, value: 61, currency: "USD", capability: "sandbox", storage: "ok" }]);
  });

  test("a refused request keeps the order on this device and says why, by code", async () => {
    reply = () => ({ status: 500, body: { error: { code: "internal", message: SEEDS.message } } });
    const placed = await orders.placeOrder(draft());
    assert.equal(placed.receipt, false);
    assert.deepEqual(events("sandbox_order"), [{ method: "card", result: "placed", receipt: "local", line_count: 1, value: 61, currency: "USD", capability: "sandbox", storage: "ok", error_code: "internal" }]);
    reply = () => new TypeError(SEEDS.message);
    await orders.placeOrder(draft());
    assert.equal(events("sandbox_order")[1].error_code, "network");
    // a retry is its own outcome, and makes no second order
    reply = () => ({ status: 200, body: { order: { ...draft(), id: "sbx_retry", mode: "sandbox", createdAt: "x" } } });
    await orders.resendOrder(placed);
    assert.deepEqual(events("sandbox_order_retry"), [{ result: "server", capability: "sandbox" }]);
    assert.equal(events("sandbox_order").length, 2);
  });

  test("a full quota with a server receipt is still placed: the server keeps it, and storage says this device didn't", async () => {
    localStorage.mode = "quota";
    reply = () => ({ status: 200, body: { order: { ...draft(), id: "sbx_q", mode: "sandbox", createdAt: "x" } } });
    await orders.placeOrder(draft());
    assert.deepEqual(events("sandbox_order"), [{ method: "card", result: "placed", receipt: "server", line_count: 1, value: 61, currency: "USD", capability: "sandbox", storage: "failed" }]);
    assert.deepEqual(events("storage_failure"), [{ store: "orders", op: "write", reason: "quota" }]);
  });

  test("a started provider checkout is not a placed order: no sandbox_order, no local record, and a retry keeps the checkout", async () => {
    const checkoutUrl = "https://checkout.example.test/session";
    reply = () => ({ status: 200, body: { order: { ...draft(), id: "ord_pay", mode: "sandbox", createdAt: "x" }, checkoutUrl } });
    const placed = await orders.placeOrder(draft());
    assert.deepEqual([placed.checkoutUrl, placed.receipt], [checkoutUrl, false]);
    assert.deepEqual(events("sandbox_order"), []);
    assert.deepEqual(commerce.loadOrders(), []);
    // the first request couldn't start the payment: nothing is placed, then the retry is sent to the checkout
    reply = () => ({ status: 502, body: { error: { code: "payment_unavailable", message: SEEDS.message } } });
    const failed = await orders.placeOrder(payable());
    assert.equal(failed.code, "payment_unavailable");
    assert.deepEqual(commerce.loadOrders(), []);
    assert.equal(events("sandbox_order")[0].result, "not_persisted");
    const sent = [];
    reply = (path, init) => (sent.push(JSON.parse(init.body).attemptId), { status: 200, body: { order: { ...payable(), id: "ord_pay2", mode: "sandbox", createdAt: "x" }, checkoutUrl } });
    const retried = await orders.resendOrder(failed);
    assert.deepEqual([retried.checkoutUrl, retried.receipt], [checkoutUrl, false]);
    // the retry carries the attempt id the first request did, so the server can tell it is the same attempt
    assert.match(failed.attemptId, /^[A-Za-z0-9_-]{16,64}$/);
    assert.deepEqual(sent, [failed.attemptId]);
  });

  test("a full quota and a refused server is not_persisted, with no value: nothing kept the order", async () => {
    localStorage.mode = "quota";
    reply = () => ({ status: 500, body: { error: { code: "internal", message: SEEDS.message } } });
    const placed = await orders.placeOrder(draft());
    assert.equal(placed.receipt, false);
    localStorage.mode = "ok";
    assert.deepEqual(commerce.loadOrders(), [], "no record exists on the device");
    assert.deepEqual(events("sandbox_order"), [{ method: "card", result: "not_persisted", receipt: "local", line_count: 1, capability: "sandbox", storage: "failed", error_code: "internal" }]);
    assert.equal(events("sandbox_order").filter((e) => e.result === "placed").length, 0);
  });

  test("a live-mode block is reported as blocked, with no record and no order", async () => {
    const before = process.env.NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE;
    process.env.NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE = "live";
    try {
      await assert.rejects(() => orders.placeOrder(draft()), commerce.OrderBlocked);
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE;
      else process.env.NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE = before;
    }
    assert.deepEqual(events(), [{ method: "card", result: "blocked", line_count: 1, capability: "sandbox", error_code: "variant_not_orderable" }]);
    assert.deepEqual(commerce.loadOrders(), []);
  });
});

/* ---------- sharing and copying ---------- */

describe("share outcomes", () => {
  const data = { title: SEEDS.title, url: `https://getticketstub.example/s/${SEEDS.token}` };
  const clipboard = (ok) => ({ writeText: async () => (ok ? undefined : Promise.reject(new Error(SEEDS.message))) });

  test("a finished share sheet is one native share", async () => {
    nav = { share: async () => {} };
    assert.equal(await share.shareLink(data, "memory", "stub"), "shared");
    assert.deepEqual(events(), [{ method: "native", content_type: "stub", context: "memory", result: "success" }]);
  });

  test("closing the sheet is a cancel, not a failure, and copies nothing unless asked", async () => {
    let copied = 0;
    nav = { share: async () => Promise.reject(Object.assign(new Error(SEEDS.message), { name: "AbortError" })), clipboard: { writeText: async () => void copied++ } };
    assert.equal(await share.shareLink(data, "memory", "stub"), "cancelled");
    assert.equal(copied, 0);
    assert.deepEqual(events(), [{ method: "native", content_type: "stub", context: "memory", result: "cancel" }]);
    // the wall copies the link after a cancel: one event, the copy
    assert.equal(await share.shareLink(data, "wall", "stub", { copyOnCancel: true }), "copied");
    assert.deepEqual(events()[1], { method: "copy", content_type: "stub", context: "wall", result: "success" });
    assert.equal(events().length, 2);
  });

  test("a blocked sheet falls back to copying, and a failed copy is a failure", async () => {
    nav = { share: async () => Promise.reject(Object.assign(new Error(SEEDS.message), { name: "NotAllowedError" })), clipboard: clipboard(false) };
    // no clipboard and no document: copyText's fallback can't work either
    assert.equal(await share.shareLink(data, "lamp", "stub"), "failed");
    nav = { clipboard: clipboard(true) };
    assert.equal(await share.copyLink(`https://getticketstub.example/u/${SEEDS.token}`, "wall", "wall"), true);
    assert.deepEqual(events(), [
      { method: "copy", content_type: "stub", context: "lamp", result: "failure" },
      { method: "copy", content_type: "wall", context: "wall", result: "success" },
    ]);
  });
});

/* ---------- account: share links, sync, sign-in ---------- */

describe("account outcomes", () => {
  test("a share link says whether the server kept the snapshot", async () => {
    reply = () => ({ status: 200, body: { token: "abc123" } });
    assert.equal(await accountShare.sharePath(privateStub()), "/s/abc123");
    reply = () => ({ status: 413, body: { error: { code: "too_large", message: SEEDS.message } } });
    assert.match(await accountShare.sharePath(privateStub()), /^\/s\/[A-Za-z0-9_-]+$/); // the encoded link still works
    assert.deepEqual(events("server_save"), [
      { kind: "share", result: "saved" },
      { kind: "share", result: "failed", error_code: "too_large" },
    ]);
    // the encoded stub rides only in the link, never in an event
    assert.equal(JSON.stringify(sent).includes("stub-seed-1"), false);
  });

  test("sync reports its first success, every failure, and the success after a failure", async () => {
    store.upsertStub(privateStub());
    reply = () => ({ status: 200, body: { stubs: [], deleted: [], now: 1 } });
    assert.equal((await sync.syncNow()).ok, true);
    assert.equal((await sync.syncNow()).ok, true);
    reply = () => ({ status: 502, body: { error: { code: "unavailable", message: SEEDS.message } } });
    assert.equal((await sync.syncNow()).ok, false);
    reply = () => ({ status: 200, body: { stubs: [], deleted: [], now: 2 } });
    await sync.syncNow();
    assert.deepEqual(events("server_save"), [
      { kind: "sync", result: "saved" },
      { kind: "sync", result: "failed", error_code: "unavailable" },
      { kind: "sync", result: "saved" },
    ]);
  });

  test("sync retains the local wall and deletion queue after failed persistence, then recovers", async () => {
    const local = privateStub();
    store.upsertStub(local);
    store.saveDeleted(["deleted-stub"]);
    const remote = { ...local, id: "remote-stub" };
    reply = () => ({ status: 200, body: { stubs: [remote], deleted: ["deleted-stub"], now: 3 } });
    const notices = [];
    const onSync = (e) => notices.push(e.detail);
    window.addEventListener(sync.WALL_SYNCED, onSync);
    try {
      localStorage.mode = "quota";
      const failed = await sync.syncNow();
      assert.equal(failed.ok, false);
      assert.equal(failed.localPersistenceFailed, true);
      assert.deepEqual(store.loadWall().map((s) => s.id), [local.id]);
      assert.deepEqual(store.loadDeleted(), ["deleted-stub"]);
      assert.deepEqual(notices, []);
      assert.equal(sync.isOnServer(local.id), true);
      localStorage.mode = "ok";
      assert.equal((await sync.syncNow()).ok, true);
      assert.deepEqual(store.loadWall().map((s) => s.id), [remote.id, local.id]);
      assert.deepEqual(store.loadDeleted(), []);
      assert.deepEqual(notices, [{ count: 2 }]);
    } finally {
      localStorage.mode = "ok";
      window.removeEventListener(sync.WALL_SYNCED, onSync);
    }
  });

  test("opening the sign-in sheet is a choice, once per opening; 'not now' is a skip; neither is a login", () => {
    signin.openSignIn({ reason: "claim", email: SEEDS.email, returnTo: `/claim/g/${SEEDS.token}` });
    signin.updateSignIn({ sent: { email: SEEDS.email } });
    signin.openSignIn({ reason: "claim" }); // already open: not a second choice
    signin.closeSignIn();
    signin.dismissSavePrompt();
    assert.deepEqual(events("signin_choice"), [
      { choice: "sign_in", reason: "claim" },
      { choice: "skip", reason: "save" },
    ]);
  });

  test("with saving off, an order is local and a share link is encoded, and both say so", async () => {
    // a 503 storage_unavailable anywhere turns saving off for the page (this test runs last in the file's account block)
    reply = () => ({ status: 503, body: { error: { code: "storage_unavailable", message: SEEDS.message } } });
    await accountShare.sharePath(privateStub());
    assert.equal(saving.isSavingOff(), true);
    fetches = [];
    sent = [];
    await orders.placeOrder(draft());
    await accountShare.sharePath(privateStub());
    assert.deepEqual(fetches, [], "nothing is sent to a server that can't save");
    assert.deepEqual(events(), [
      { method: "card", result: "placed", receipt: "local", line_count: 1, value: 61, currency: "USD", capability: "sandbox", storage: "ok", error_code: "storage_unavailable" },
      { kind: "share", result: "off" },
    ]);
    // saving off and a full quota (Astra's case): no server, no local record, so not placed and no value
    sent = [];
    localStorage.mode = "quota";
    await orders.placeOrder(draft());
    localStorage.mode = "ok";
    assert.equal(commerce.loadOrders().length, 1, "only the earlier order is on the device");
    assert.deepEqual(events("sandbox_order"), [{ method: "card", result: "not_persisted", receipt: "local", line_count: 1, capability: "sandbox", storage: "failed", error_code: "storage_unavailable" }]);
  });

  test("a print gift that storage refused is not_persisted (the gift path uses the same report)", () => {
    orders.reportOrder({ stubIds: ["g"], lines: [{ title: SEEDS.title, material: "print", finish: "foil", size: "classic", totalMinor: 4900 }], totalMinor: 4900, method: "gift-print" }, "local", false);
    orders.reportOrder({ stubIds: ["g"], lines: [{ title: SEEDS.title, material: "print", finish: "foil", size: "classic", totalMinor: 4900 }], totalMinor: 4900, method: "gift-print" }, "local", true);
    assert.deepEqual(events("sandbox_order"), [
      { method: "gift_print", result: "not_persisted", receipt: "local", line_count: 1, capability: "sandbox", storage: "failed" },
      { method: "gift_print", result: "placed", receipt: "local", line_count: 1, value: 49, currency: "USD", capability: "sandbox", storage: "ok" },
    ]);
  });
});

/* ---------- the editor's committed edits ---------- */

describe("editor edit diff", () => {
  const base = privateStub();

  test("a style, a version pick and stock choices are named; their values are not", () => {
    const styled = ops.setEdition(base, "minimal");
    assert.deepEqual(ops.editChanges(base, styled), ["edition"]);
    assert.deepEqual(ops.editChanges(styled, versions.restoreVersion(styled, base.currentVersionId)), ["edition"]); // back to another style
    const remixed = ops.addArtVersion(base, { kind: "procedural", seed: 7, provenance: "simulated" });
    assert.deepEqual(ops.editChanges(base, remixed), [], "new art is reported by its remix result, not again here");
    assert.deepEqual(ops.editChanges(remixed, versions.restoreVersion(remixed, base.currentVersionId)), ["version_select"]);
    assert.deepEqual(ops.editChanges(base, ops.setFinish(ops.setMaterial(base, "framed"), "holo")), ["material", "finish"]);
    assert.deepEqual(ops.editChanges(base, ops.toggleFoil(ops.setFont(base, 2))), ["font", "foil"]);
    assert.deepEqual(ops.editChanges(base, ops.setTitleColour(base, "#E4572E")), ["title_color"]);
    assert.deepEqual(ops.editChanges(base, ops.hideSelection(base, "subtitle")), ["visibility"]);
  });

  test("facts: keep, correct, confirm and undo; the note, photos and friends are left to their own events", () => {
    const optional = { ...base, event: { ...base.event, facts: [...base.event.facts, { id: "extra", label: "Extra", value: "Extra", source: "fixture", provenance: "simulated", confidence: .9 }] } };
    assert.deepEqual(ops.editChanges(optional, ops.toggleKept(optional, "extra")), ["fact_kept"]);
    assert.equal(ops.toggleKept(base, "venue"), base, "core venue is included by default");
    const corrected = corrections.applyCorrection(base, { factId: "date", value: "2026-05-02", reason: SEEDS.message });
    assert.deepEqual(ops.editChanges(base, corrected), ["fact_correct"]);
    assert.deepEqual(ops.editChanges(base, corrections.applyCorrection(base, { factId: "date", value: "2026-05-01" })), ["fact_confirm"]);
    assert.deepEqual(ops.editChanges(corrected, corrections.undoCorrection(corrected, "date")), ["fact_undo"]);
    const personal = { ...base, photos: [...base.photos, SEEDS.photo], personal: { ...base.personal, note: `${SEEDS.note}!`, friends: [] } };
    assert.deepEqual(ops.editChanges(base, personal), []);
  });

  test("each named change goes out as a studio_edit the catalog accepts", () => {
    for (const change of ops.editChanges(base, ops.setMaterial(ops.setEdition(base, "classic"), "card"))) {
      flow("studio_edit", { change, method: change === "edition" ? "keyboard" : undefined, edition: change === "edition" ? "classic" : undefined, material: change === "material" ? "card" : undefined, storage: "ok" });
    }
    assert.deepEqual(events("studio_edit"), [
      { change: "edition", method: "keyboard", edition: "classic", storage: "ok" },
      { change: "material", material: "card", storage: "ok" },
    ]);
  });
});

/* ---------- organizer CSV ---------- */

describe("organizer guest list", () => {
  test("a guest list is counted, never read out", () => {
    const list = organizer.parseCsv(`${SEEDS.csvHeader},seat,team\n${SEEDS.csvCell},A1,SEED Team\n,A2,\n"${SEEDS.name}, Jr",A3,x\n`);
    const summary = organizer.csvSummary(list);
    assert.deepEqual(summary, { result: "parsed", row_count: 3, column_count: 3 });
    assert.deepEqual(organizer.mappedCounts(list, 0), { row_count: 3, missing_name_count: 1 });
    assert.deepEqual(organizer.csvSummary(organizer.parseCsv("")), { result: "empty", row_count: 0, column_count: 0 });
    assert.deepEqual(organizer.csvSummary(organizer.parseCsv(`${SEEDS.csvHeader}\n`)), { result: "no_rows", row_count: 0, column_count: 1 });
    flow("organizer_csv", { source: "file", ...summary });
    flow("organizer_check", organizer.mappedCounts(list, 0));
    assert.deepEqual(events(), [
      { source: "file", result: "parsed", row_count: 3, column_count: 3 },
      { row_count: 3, missing_name_count: 1 },
    ]);
  });
});

/* ---------- the organizer wizard's steps ---------- */

describe("organizer steps", () => {
  test("a fresh wizard reports Design once, even when Strict Mode runs the opening effect twice", () => {
    const seen = { current: false };
    organizer.reportOpeningStep(seen, false);
    organizer.reportOpeningStep(seen, false); // Strict Mode's second run
    organizer.reportStepMove(0, 1);
    organizer.reportStepMove(1, 2);
    organizer.reportStepMove(2, 2); // the step already shown is not a move
    organizer.reportStepMove(2, 1); // Back
    assert.deepEqual(events("organizer_step"), [
      { step: "design", via: "open" },
      { step: "guests", via: "nav" },
      { step: "check", via: "nav" },
      { step: "guests", via: "nav" },
    ]);
  });

  test("a draft restored after sign-in opens on Publish once; the second Strict Mode run (draft already taken) adds no Design", () => {
    const seen = { current: false };
    organizer.reportOpeningStep(seen, true); // first run took the draft
    organizer.reportOpeningStep(seen, false); // second run finds none
    organizer.reportStepMove(3, 2);
    assert.deepEqual(events("organizer_step"), [
      { step: "publish", via: "restore" },
      { step: "check", via: "nav" },
    ]);
    // a remount (a new visit) is a new opening
    organizer.reportOpeningStep({ current: false }, false);
    assert.equal(events("organizer_step").length, 3);
  });
});

/* ---------- choices before a commit: options, positions, navigation ---------- */

describe("bounded choices", () => {
  test("a sidebar row is reported by its kind, never by the stub it names", () => {
    const tree = routes.buildTree({ keys: ["wall", `stub:${SEEDS.token}`], stubs: [{ id: SEEDS.token, title: SEEDS.title }], cartCount: 0, path: "/wall", unsaved: false });
    const keys = [];
    const walk = (nodes) => nodes.forEach((n) => (keys.push(n.key), walk(n.children ?? [])));
    walk(tree);
    const items = keys.map((k) => routes.navItem(k));
    assert.ok(!items.includes("other"), `every row in the tree has a kind: ${keys.join(" ")}`);
    assert.equal(routes.navItem(`stub:${SEEDS.token}`), "stub");
    assert.equal(routes.navItem(`gift:${SEEDS.token}`), "gift");
    assert.equal(routes.navItem(`share:${SEEDS.token}`), "share_page");
    assert.equal(routes.navItem(SEEDS.title), "other");
    for (const item of new Set(items)) flow("nav_select", { item, has_stubs: true });
    assert.equal(events("nav_select").length, new Set(items).size);
  });

  test("option toggles, contact-sheet positions, the attendee photo and the home search link are accepted as bounded values", () => {
    flow("cta_select", { cta: "search", context: "home" });
    flow("cta_select", { cta: "search", context: "make" });
    flow("gift_option", { option: "delivery", delivery: "print", wrap: true });
    flow("gift_option", { option: "wrap", delivery: "link", wrap: false });
    flow("wallet_option", { provider: "google" });
    flow("organizer_contact_select", { action: "inspect", rank: 7, shown_count: 12, row_count: 40 });
    flow("organizer_contact_select", { action: "show_more", shown_count: 36, row_count: 40 });
    flow("photo_add", { via: "organizer_claim", result: "success", photo_count: 1 });
    assert.deepEqual(names(), ["cta_select", "cta_select", "gift_option", "gift_option", "wallet_option", "organizer_contact_select", "organizer_contact_select", "photo_add"]);
    // the wallet tab is a preference; only "Add" is wallet_select (still simulated)
    assert.equal(events("wallet_select").length, 0);
  });

  test("a position outside the catalog's range is dropped, not clamped into a false rank", () => {
    runtime.setRejectHandler(null);
    flow("organizer_contact_select", { action: "inspect", rank: 5000, row_count: 40 });
    flow("gift_option", { option: "delivery", delivery: SEEDS.name, wrap: true });
    assert.deepEqual(events(), []);
  });
});

/* ---------- off means off ---------- */

describe("analytics off", () => {
  test("unconfigured, or before consent, flows send nothing, change nothing, and nothing is replayed", async () => {
    runtime.resetAnalyticsForTests();
    sent = [];
    runtime.configureAnalytics({ config: null, transport: () => assert.fail("no transport without config") });
    flow("wall_view", { state: "loaded", stub_count: 2 });
    assert.equal(store.upsertStub(privateStub()), true);
    // configured but undecided: dropped, and not replayed once consent arrives
    runtime.configureAnalytics({ config: CONFIG, origin: "https://getticketstub.example", referrer: "", transport: () => ({ load: async () => {}, send: (n, p) => sent.push([n, p]), pause() {}, resume() {} }) });
    flow("wall_view", { state: "loaded", stub_count: 2 });
    runtime.recordPageView("/wall", "");
    runtime.updateConsent("granted");
    await flush();
    assert.deepEqual(names(), []);
    flow("wall_filter", { filter: "concert" });
    assert.deepEqual(names(), ["wall_filter"]);
  });
});
