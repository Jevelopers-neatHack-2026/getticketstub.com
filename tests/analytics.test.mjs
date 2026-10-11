import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./analytics-hooks.mjs";

// The analytics core without a browser: catalog rules, runtime validation, route sanitization,
// configuration, and the runtime's consent / page-view / loading lifecycle against a fake transport.

const catalog = await import("../src/customer/analytics/catalog.ts");
const { validateEvent, validateInternalEvent } = await import("../src/customer/analytics/validate.ts");
const routes = await import("../src/customer/analytics/routes.ts");
const { analyticsConfigFromEnv, isAnalyticsConfig } = await import("../src/customer/analytics/config.ts");
const runtime = await import("../src/customer/analytics/runtime.ts");
const { track, trackOnce, toMajorUnits } = await import("../src/customer/analytics/track.ts");
const { toGaParams } = await import("../src/customer/analytics/gtag.ts");
const timing = await import("../src/customer/analytics/timing.ts");

const CONFIG = { measurementId: "G-TEST000000", environment: "preview", runtimeMode: "demo", debug: false };
const ORIGIN = "https://getticketstub.example";
const flush = () => new Promise((r) => setImmediate(r));

/** Private values seeded into URLs, referrers and params; none may appear in anything sent. */
const SEEDS = ["SEEDTOKEN7f3a", "SEEDQUERY19c", "Jane Doe", "jane.doe@example.com", "SEEDURL55e", "SEEDHASH0a1", "private_name_123", "jane_doe", "SEEDSTUBTITLE"];

/** A transport that records calls and whose load the test settles by hand. */
function fakeTransport() {
  const t = {
    loads: 0, sent: [], pauses: 0, resumes: 0, settle: null, fail: null, throwOnSend: false,
    loadedWith: null,
    load(page) {
      t.loads++;
      t.loadedWith = page;
      return new Promise((resolve, reject) => { t.settle = resolve; t.fail = reject; });
    },
    send(name, params) {
      if (t.throwOnSend) throw new Error("provider exploded");
      t.sent.push([name, structuredClone(params)]);
    },
    pause() { t.pauses++; },
    resume() { t.resumes++; },
  };
  return t;
}

let t;
let rejected;
function setup({ referrer = "", config = CONFIG } = {}) {
  runtime.resetAnalyticsForTests();
  timing.resetTimingForTests();
  t = fakeTransport();
  rejected = [];
  runtime.setRejectHandler((name, reason) => rejected.push(`${name}: ${reason}`));
  runtime.configureAnalytics({ config, transport: () => t, origin: ORIGIN, referrer });
}
async function grantAndLoad() {
  runtime.updateConsent("granted");
  t.settle?.();
  await flush();
}
/** Grant on a recorded page (the app always has one), load the tag, then forget that page's own view. */
async function loadOnPage(path = "/wall") {
  runtime.recordPageView(path);
  await grantAndLoad();
  t.sent.length = 0;
}
const names = () => t.sent.map(([n]) => n);
const views = () => t.sent.filter(([n]) => n === "page_view").map(([, p]) => p);
function assertNoSeeds(payload) {
  const s = JSON.stringify(payload);
  for (const seed of SEEDS) assert.ok(!s.includes(seed), `leaked ${seed} in ${s}`);
}

describe("catalog", () => {
  const all = { ...catalog.EVENTS, ...catalog.INTERNAL_EVENTS };

  test("names and parameters respect GA4 limits and the runtime's own fields", () => {
    for (const [name, spec] of Object.entries(all)) {
      assert.match(name, /^[a-z][a-z0-9_]{0,39}$/, name);
      assert.ok(!/^(ga_|google_|firebase_)/.test(name), name);
      const params = Object.keys(spec.params);
      // 7 runtime fields + fixed values + the caller's parameters stay within GA's 25 per event.
      assert.ok(params.length + 7 + Object.keys(spec.fixed ?? {}).length <= 25, name);
      for (const p of params) {
        assert.match(p, /^[a-z][a-z0-9_]{0,39}$/, `${name}.${p}`);
        assert.ok(!catalog.RESERVED_PARAMS.includes(p), `${name}.${p} is reserved`);
      }
    }
  });

  test("there is no free-text parameter: every value is an enum, bounded integer, money or boolean", () => {
    for (const [name, spec] of Object.entries(all)) {
      for (const [p, s] of Object.entries(spec.params)) {
        assert.ok(["enum", "int", "money", "bool"].includes(s.kind), `${name}.${p}`);
        if (s.kind === "enum") {
          assert.ok(s.values.length > 0 && s.values.length <= 100, `${name}.${p}`);
          for (const v of s.values) assert.match(v, /^[A-Za-z0-9_.-]{1,100}$/, `${name}.${p}=${v}`);
        }
        if (s.kind === "int") assert.ok(Number.isInteger(s.min) && Number.isInteger(s.max) && s.min <= s.max, `${name}.${p}`);
      }
    }
  });

  test("no parameter is named for personal or high-cardinality content", () => {
    const risky = /(^|_)(name|title|url|uri|href|email|mail|phone|token|message|note|query|text|prompt|address|path|referrer|location|id|ids)$/;
    const allowed = new Set(["item_id", "item_list_id", "metric_name"]); // closed enums of variants, lists and Web Vitals
    for (const [name, spec] of Object.entries(all)) {
      // A boolean (has_note) says whether something exists, not what it is.
      for (const [p, s] of Object.entries(spec.params)) if (!allowed.has(p) && s.kind !== "bool") assert.ok(!risky.test(p), `${name}.${p}`);
    }
  });

  test("purchase, login, sign-up and GA's automatic events are not in the catalog", () => {
    for (const bad of catalog.FORBIDDEN_EVENTS) {
      assert.ok(!(bad in catalog.EVENTS), bad);
      assert.equal(validateEvent(bad, {}).ok, false, bad);
    }
    for (const spec of Object.values(catalog.EVENTS)) assert.ok(!("transaction_id" in spec.params));
  });

  test("variant ids are the closed material_finish_size set", () => {
    assert.equal(catalog.VARIANT_IDS.length, 48);
    assert.ok(catalog.VARIANT_IDS.includes("print_foil_stamp"));
    assert.ok(catalog.VARIANT_IDS.every((v) => /^[a-z]+_[a-z]+_[a-z]+$/.test(v)));
  });

  test("error codes come from the bounded message catalog", () => {
    assert.ok(catalog.ERROR_CODE.values.includes("unknown"));
    assert.ok(catalog.ERROR_CODE.values.includes("network"));
    assert.equal(validateEvent("creation_error", { error_code: "TypeError: secret at /s/abc" }).ok, false);
  });
});

describe("validation", () => {
  test("a well-formed event passes unchanged", () => {
    const v = validateEvent("search_results", { result: "zero", result_count: 0, query_kind: "text" });
    assert.deepEqual(v, { ok: true, params: { result: "zero", result_count: 0, query_kind: "text" } });
  });

  test("undefined params are skipped and an event without params is fine", () => {
    assert.deepEqual(validateEvent("tear_start"), { ok: true, params: {} });
    assert.deepEqual(validateEvent("studio_flip", { method: undefined }), { ok: true, params: {} });
  });

  const bad = [
    ["unknown event", "made_up_event", {}],
    ["unknown parameter", "search_results", { result: "zero", search_term: "SEEDQUERY19c" }],
    ["free text where an enum belongs", "search_results", { result: "SEEDQUERY19c" }],
    ["title smuggled in", "creation_complete", { title: "SEEDSTUBTITLE" }],
    ["number as string", "search_results", { result_count: "3" }],
    ["fraction for an integer", "search_results", { result_count: 1.5 }],
    ["negative count", "search_results", { result_count: -1 }],
    ["count over the cap", "search_results", { result_count: 1001 }],
    ["NaN", "research_complete", { duration_ms: Number.NaN }],
    ["Infinity money", "view_cart", { value: Number.POSITIVE_INFINITY }],
    ["money over the cap", "view_cart", { value: 100_001 }],
    ["boolean as string", "reveal_fact_toggle", { kept: "true" }],
    ["nested object", "studio_flip", { method: { toString: () => "button" } }],
    ["array value", "studio_flip", { method: ["button"] }],
    ["reserved page_location", "studio_flip", { page_location: "https://x/s/SEEDTOKEN7f3a" }],
    ["reserved user_id", "studio_flip", { user_id: "jane.doe@example.com" }],
    ["reserved items", "add_to_cart", { items: [{ item_id: "SEEDTOKEN7f3a" }] }],
    ["arbitrary item id", "add_to_cart", { item_id: "stub-SEEDTOKEN7f3a" }],
    ["live commerce", "add_to_cart", { capability: "live" }],
    ["issued wallet", "wallet_select", { capability: "live" }],
  ];
  for (const [label, name, params] of bad) {
    test(`rejects ${label}`, () => {
      const v = validateEvent(name, params);
      assert.equal(v.ok, false);
      assertNoSeeds(v.reason);
    });
  }

  test("rejects non-plain parameter objects", () => {
    class Params { method = "button"; }
    assert.equal(validateEvent("studio_flip", new Params()).ok, false);
    assert.equal(validateEvent("studio_flip", Object.create({ method: "button" })).ok, false);
    assert.equal(validateEvent("studio_flip", "method=button").ok, false);
    assert.equal(validateEvent("studio_flip", [["method", "button"]]).ok, false);
  });

  test("a polluted prototype adds nothing", () => {
    const params = JSON.parse('{"__proto__": {"title": "SEEDSTUBTITLE"}, "method": "button"}');
    const v = validateEvent("studio_flip", params);
    assert.equal(v.ok, false); // __proto__ is an own key here, and not an allowed one
  });

  test("commerce and wallet events are stamped with their sandbox/simulated truth", () => {
    assert.equal(validateEvent("add_to_cart", { item_id: "card_matte_classic", quantity: 1 }).params.capability, "sandbox");
    assert.equal(validateEvent("sandbox_order", { result: "placed" }).params.capability, "sandbox");
    assert.equal(validateEvent("add_payment_info", { payment_type: "card" }).params.capability, "sandbox");
    assert.equal(validateEvent("wallet_select", { provider: "apple" }).params.capability, "simulated");
  });

  test("money is rounded to cents", () => {
    assert.equal(validateEvent("view_cart", { value: 12.3456 }).params.value, 12.35);
    assert.equal(toMajorUnits(4900), 49);
    assert.equal(toMajorUnits(Number.NaN), 0);
  });

  test("internal events cannot be sent through track()", () => {
    for (const name of Object.keys(catalog.INTERNAL_EVENTS)) assert.equal(validateEvent(name, {}).ok, false, name);
    assert.equal(validateInternalEvent("web_vital", { metric_name: "LCP", metric_value: 1200 }).ok, true);
  });
});

describe("route sanitization", () => {
  const cases = [
    ["/", "/"],
    ["/make", "/make"],
    ["/search", "/search"],
    ["/new", "/new"],
    ["/wall", "/wall"],
    ["/wall/", "/wall"],
    ["/cart", "/cart"],
    ["/cart/unclaimed/SEEDTOKEN7f3a", "/cart/unclaimed/:id"],
    ["/checkout/SEEDTOKEN7f3a", "/checkout/:id"],
    ["/claim/SEEDTOKEN7f3a", "/claim/:set"],
    ["/claim/g/SEEDTOKEN7f3a", "/claim/g/:token"],
    ["/friends/SEEDTOKEN7f3a", "/friends/:id"],
    ["/gift/SEEDTOKEN7f3a", "/gift/:id"],
    ["/wallet/SEEDTOKEN7f3a", "/wallet/:id"],
    ["/studio/SEEDTOKEN7f3a", "/studio/:id"],
    ["/s/eyJ0aXRsZSI6IkphbmUgRG9lIn0SEEDTOKEN7f3a", "/s/:token"],
    ["/u/SEEDTOKEN7f3a", "/u/:token"],
    ["/organizer", "/organizer"],
    ["/organizer/claim", "/organizer/claim"],
    ["/account", "/account"],
    ["/signin/confirm", "/signin/confirm"],
    ["/admin", "/admin"],
    ["/admin/users/SEEDTOKEN7f3a", "/admin/*"],
    ["/help", "/help"],
    ["/map", "/map"],
    ["/privacy", "/privacy"],
    ["/terms", "/terms"],
    ["/parts", "/parts"],
    ["/api/auth/confirm", "/api"],
    ["/api/share/SEEDTOKEN7f3a", "/api"],
    ["/s", "/unknown"],
    ["/s/a/b", "/unknown"],
    ["/studio/SEEDTOKEN7f3a/extra", "/unknown"],
    ["/jane.doe@example.com", "/unknown"],
    ["//evil.example/SEEDURL55e", "/unknown"],
    ["/wall?from=SEEDTOKEN7f3a#SEEDHASH0a1", "/wall"],
    ["", "/"],
  ];
  for (const [path, template] of cases) {
    test(`${path || "(empty)"} -> ${template}`, () => {
      const safe = routes.sanitizePath(path);
      assert.equal(safe.template, template);
      assertNoSeeds(safe);
    });
  }

  test("every page in src/app has a known template", () => {
    const appDir = fileURLToPath(new URL("../src/app/", import.meta.url));
    const pages = [];
    (function walk(dir, rel) {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p, `${rel}/${f}`);
        else if (/^page\.tsx?$/.test(f)) pages.push(rel || "/");
      }
    })(appDir, "");
    assert.ok(pages.length > 20);
    for (const p of pages) {
      if (p.startsWith("/api")) continue;
      const sample = p.replace(/\[\[\.\.\.[^\]]+\]\]/, "x/y").replace(/\[[^\]]+\]/g, "sample");
      assert.notEqual(routes.sanitizePath(sample).template, routes.UNKNOWN_TEMPLATE, p);
    }
  });

  test("page_location keeps origin + template; queries and hashes go", () => {
    const loc = routes.sanitizeLocation(ORIGIN, "/new", "?url=https%3A%2F%2Fprivate.example%2FSEEDURL55e&q=SEEDQUERY19c&from=SEEDTOKEN7f3a&d=SEEDTOKEN7f3a&to=Jane%20Doe", { landing: true });
    assert.equal(loc, `${ORIGIN}/new`);
  });

  test("only allowlisted campaign values survive, and only on the landing view", () => {
    const search = "?utm_source=newsletter&utm_medium=email&utm_campaign=private_name_123&utm_term=jane_doe";
    assert.equal(routes.sanitizeLocation(ORIGIN, "/", search, { landing: true }), `${ORIGIN}/?utm_source=newsletter&utm_medium=email`);
    assert.equal(routes.sanitizeLocation(ORIGIN, "/", search), `${ORIGIN}/`);
    const shaped = "?utm_source=jane_doe&utm_medium=SEEDQUERY19c&utm_campaign=private_name_123";
    assert.equal(routes.sanitizeLocation(ORIGIN, "/", shaped, { landing: true }), `${ORIGIN}/`);
    assert.deepEqual(routes.CAMPAIGN_ALLOWLIST.utm_campaign, []);
  });

  test("referrers: same site becomes a template, another site keeps only its origin", () => {
    assert.equal(routes.sanitizeReferrer(`${ORIGIN}/s/SEEDTOKEN7f3a?from=SEEDTOKEN7f3a`, ORIGIN), `${ORIGIN}/s/:token`);
    assert.equal(routes.sanitizeReferrer("https://mail.example.com/inbox/SEEDTOKEN7f3a?to=jane.doe@example.com#SEEDHASH0a1", ORIGIN), "https://mail.example.com/");
    assert.equal(routes.sanitizeReferrer("https://user:SEEDTOKEN7f3a@evil.example/x", ORIGIN), "https://evil.example/");
    assert.equal(routes.sanitizeReferrer("android-app://com.example/SEEDTOKEN7f3a", ORIGIN), "");
    assert.equal(routes.sanitizeReferrer("not a url SEEDTOKEN7f3a", ORIGIN), "");
    assert.equal(routes.sanitizeReferrer("", ORIGIN), "");
  });
});

describe("configuration", () => {
  const env = { TICKETSTUB_ANALYTICS_ENV: "production", TICKETSTUB_GA_MEASUREMENT_ID: "G-ABC123XYZ9" };

  test("both the environment and a well-formed id are required", () => {
    assert.deepEqual(analyticsConfigFromEnv(env), { measurementId: "G-ABC123XYZ9", environment: "production", runtimeMode: "demo", debug: false });
    assert.equal(analyticsConfigFromEnv({}), null);
    assert.equal(analyticsConfigFromEnv({ TICKETSTUB_GA_MEASUREMENT_ID: "G-ABC123XYZ9" }), null);
    assert.equal(analyticsConfigFromEnv({ ...env, TICKETSTUB_ANALYTICS_ENV: "staging" }), null);
    for (const id of ["", "UA-12345-1", "G-abc123", "G-ABC123XYZ9\"><script>", "G-", "GT-ABC123", "G-ABC123XYZ9 "]) {
      const c = analyticsConfigFromEnv({ ...env, TICKETSTUB_GA_MEASUREMENT_ID: id });
      assert.ok(c === null || c.measurementId === "G-ABC123XYZ9", id);
    }
  });

  test("tests and the kill switch never collect", () => {
    assert.equal(analyticsConfigFromEnv({ ...env, NODE_ENV: "test" }), null);
    assert.equal(analyticsConfigFromEnv({ ...env, TICKETSTUB_ANALYTICS_DISABLED: "1" }), null);
  });

  test("runtime mode and debug come from the server's settings", () => {
    assert.equal(analyticsConfigFromEnv({ ...env, TICKETSTUB_RUNTIME_MODE: "live" }).runtimeMode, "live");
    assert.equal(analyticsConfigFromEnv({ ...env, TICKETSTUB_RUNTIME_MODE: "LIVE" }).runtimeMode, "demo");
    assert.equal(analyticsConfigFromEnv({ ...env, TICKETSTUB_GA_DEBUG: "1" }).debug, true);
    assert.equal(analyticsConfigFromEnv({ ...env, TICKETSTUB_ANALYTICS_ENV: "preview" }).environment, "preview");
  });

  test("client props are checked before use", () => {
    assert.equal(isAnalyticsConfig(CONFIG), true);
    for (const junk of [null, undefined, "G-TEST000000", {}, { ...CONFIG, measurementId: "x" }, { ...CONFIG, environment: "dev" }, { ...CONFIG, debug: "no" }]) {
      assert.equal(isAnalyticsConfig(junk), false);
    }
  });

  test("the config module reads no secrets and no NEXT_PUBLIC_ settings", () => {
    const source = readFileSync(new URL("../src/customer/analytics/config.ts", import.meta.url), "utf8");
    assert.ok(!/NEXT_PUBLIC_/.test(source));
    assert.ok(!/API_KEY|SECRET|TOKEN/.test(source));
  });
});

describe("runtime: unconfigured, failures", () => {
  test("with no configuration everything is a silent no-op", () => {
    runtime.resetAnalyticsForTests();
    runtime.configureAnalytics({ config: null, transport: () => assert.fail("no transport without config") });
    runtime.updateConsent("granted");
    assert.doesNotThrow(() => {
      track("tear_start");
      track("made_up", { x: 1 });
      runtime.recordPageView("/s/SEEDTOKEN7f3a");
    });
  });

  test("a throwing provider never reaches the caller", async () => {
    setup();
    runtime.recordPageView("/wall");
    await grantAndLoad();
    t.throwOnSend = true;
    assert.doesNotThrow(() => track("tear_start"));
    assert.doesNotThrow(() => runtime.recordPageView("/cart"));
  });

  test("a transport whose load throws synchronously leaves analytics off", async () => {
    runtime.resetAnalyticsForTests();
    const sent = [];
    runtime.configureAnalytics({
      config: CONFIG, origin: ORIGIN, referrer: "",
      transport: () => ({ load() { throw new Error("csp"); }, send: (n) => sent.push(n), pause() {}, resume() {} }),
    });
    assert.doesNotThrow(() => runtime.updateConsent("granted"));
    track("tear_start");
    await flush();
    assert.deepEqual(sent, []);
  });

  test("track() is safe during SSR (no window)", () => {
    assert.equal(typeof globalThis.window, "undefined");
    setup();
    assert.doesNotThrow(() => track("tear_start"));
  });
});

describe("runtime: consent", () => {
  beforeEach(() => setup());

  test("nothing loads or sends before consent", async () => {
    runtime.recordPageView("/");
    track("intake_submit", { entry: "home", input_source: "demo", result: "accepted" });
    await flush();
    assert.equal(t.loads, 0);
    assert.deepEqual(t.sent, []);
  });

  test("denial loads nothing and sends nothing", async () => {
    runtime.updateConsent("denied");
    runtime.recordPageView("/");
    track("tear_start");
    await flush();
    assert.equal(t.loads, 0);
    assert.deepEqual(t.sent, []);
  });

  test("accepting measures the current page once; nothing from before is replayed", async () => {
    runtime.recordPageView("/");
    track("intake_submit", { entry: "home", input_source: "demo", result: "accepted" });
    runtime.recordPageView("/new", "?url=SEEDURL55e");
    track("creation_start", { entry: "home", input_source: "demo" });
    runtime.updateConsent("granted");
    track("reveal_skip", { entry: "home" }); // after consent, while the tag loads: kept
    assert.equal(t.loads, 1);
    assert.deepEqual(t.sent, []); // nothing goes before the tag has loaded
    t.settle();
    await flush();
    assert.deepEqual(names(), ["page_view", "reveal_skip"]);
    assert.equal(views()[0].page_location, `${ORIGIN}/new`);
    assertNoSeeds(t.sent);
  });

  test("withdrawal stops sending at once and pauses the tag", async () => {
    runtime.recordPageView("/wall");
    await grantAndLoad();
    track("wall_banner_dismiss");
    runtime.updateConsent("denied");
    track("tear_start");
    runtime.recordPageView("/cart");
    await flush();
    assert.deepEqual(names(), ["page_view", "wall_banner_dismiss"]);
    assert.equal(t.pauses, 1);
  });

  test("withdrawing while the tag loads drops everything buffered", async () => {
    runtime.recordPageView("/wall");
    runtime.updateConsent("granted");
    track("wall_banner_dismiss");
    runtime.updateConsent("denied");
    t.settle();
    await flush();
    assert.deepEqual(t.sent, []);
    track("tear_start");
    assert.deepEqual(t.sent, []);
  });

  test("grant, withdraw, grant while loading: the current page is sent exactly once, nothing stale", async () => {
    runtime.recordPageView("/wall");
    runtime.updateConsent("granted");
    track("wall_banner_dismiss"); // first grant: dropped by the withdrawal
    runtime.updateConsent("denied");
    runtime.updateConsent("granted");
    track("tear_start");
    t.settle();
    await flush();
    assert.deepEqual(names(), ["page_view", "tear_start"]);
    assert.equal(t.loads, 1);
  });

  test("granting again after a withdrawal resumes the loaded tag and measures the current page", async () => {
    runtime.recordPageView("/wall");
    await grantAndLoad();
    runtime.updateConsent("denied");
    runtime.recordPageView("/cart");
    runtime.updateConsent("granted");
    await flush();
    assert.equal(t.loads, 1);
    assert.equal(t.resumes, 1);
    assert.deepEqual(views().map((v) => v.route_template), ["/wall", "/cart"]);
  });

  test("a blocked tag drops the buffer and everything after it, even a fresh grant", async () => {
    runtime.recordPageView("/wall");
    runtime.updateConsent("granted");
    track("wall_banner_dismiss");
    t.fail(new Error("blocked"));
    await flush();
    track("tear_start");
    runtime.recordPageView("/cart");
    runtime.updateConsent("denied");
    runtime.updateConsent("granted");
    await flush();
    assert.deepEqual(t.sent, []);
    assert.equal(t.loads, 1);
  });

  test("a failed load shuts the transport down; withdrawal after it pauses again; a regrant does not revive it", async () => {
    runtime.recordPageView("/wall");
    runtime.updateConsent("granted");
    t.fail(new Error("timeout"));
    await flush();
    assert.equal(t.pauses, 1, "fail closed on load failure");
    runtime.updateConsent("denied");
    assert.equal(t.pauses, 2, "withdrawal in the failed phase still pauses");
    runtime.updateConsent("granted");
    track("tear_start");
    await flush();
    assert.equal(t.resumes, 0);
    assert.equal(t.loads, 1);
    assert.deepEqual(t.sent, []);
  });

  test("a load that throws synchronously also shuts the transport down", () => {
    runtime.resetAnalyticsForTests();
    let pauses = 0;
    runtime.configureAnalytics({
      config: CONFIG, origin: ORIGIN, referrer: "",
      transport: () => ({ load() { throw new Error("csp"); }, send() {}, pause() { pauses++; }, resume() {} }),
    });
    runtime.recordPageView("/wall");
    runtime.updateConsent("granted");
    assert.equal(pauses, 1);
    runtime.updateConsent("denied");
    assert.equal(pauses, 2);
  });

  test("a remembered grant before the first page waits: the tag is configured only with a sanitized page", async () => {
    // Analytics.tsx's runtime effect runs before the page-view observer: consent arrives first.
    runtime.updateConsent("granted");
    track("tear_start"); // a page's mount effect before the page-view observer: held, unstamped
    assert.equal(t.loads, 0, "no tag without a page");
    runtime.recordPageView("/new", "?url=https%3A%2F%2Fprivate.example%2FSEEDURL55e");
    assert.equal(t.loads, 1);
    assert.deepEqual(t.loadedWith, { page_location: `${ORIGIN}/new`, page_referrer: "", page_title: "Printing" });
    track("tear_cancel"); // after the page, while loading: buffered with the sanitized page
    assert.deepEqual(t.sent, []);
    t.settle();
    await flush();
    assert.deepEqual(names(), ["page_view", "tear_start", "tear_cancel"]);
    assert.ok(t.sent.every(([, p]) => p.page_location === `${ORIGIN}/new` && p.route_template === "/new"));
    assertNoSeeds(t.sent);
  });

  test("events before consent are never held for the first page, even if consent follows", async () => {
    track("tear_start"); // no consent yet
    runtime.updateConsent("granted");
    track("studio_flip", { method: "button" }); // after consent, before the page: held
    runtime.recordPageView("/studio/SEEDTOKEN7f3a");
    t.settle();
    await flush();
    assert.deepEqual(names(), ["page_view", "studio_flip"]);
    assert.equal(t.sent[1][1].route_template, "/studio/:id");
    assertNoSeeds(t.sent);
  });

  test("what is held before the first page is bounded and never sent with empty page fields", async () => {
    runtime.updateConsent("granted");
    for (let i = 0; i < 100; i++) track("tear_start");
    runtime.recordPageView("/wall");
    t.settle();
    await flush();
    assert.equal(names().filter((n) => n === "tear_start").length, runtime.MAX_PENDING);
    assert.equal(names()[0], "page_view");
    assert.ok(t.sent.every(([, p]) => p.page_location === `${ORIGIN}/wall` && p.page_title === "Wall"));
  });

  test("a blocked tag on the first page drops what was held for it", async () => {
    runtime.updateConsent("granted");
    track("tear_start");
    runtime.recordPageView("/wall");
    t.fail(new Error("blocked"));
    await flush();
    assert.deepEqual(t.sent, []);
    assert.equal(t.pauses, 1);
  });

  test("withdrawing before the first page loads nothing, and a later page does not start the tag", async () => {
    runtime.updateConsent("granted");
    track("tear_start");
    runtime.updateConsent("denied");
    runtime.recordPageView("/wall");
    await flush();
    assert.equal(t.loads, 0);
    assert.equal(t.pauses, 0);
    runtime.updateConsent("granted"); // a page is known now: load with it
    assert.equal(t.loads, 1);
    assert.equal(t.loadedWith.page_location, `${ORIGIN}/wall`);
    t.settle();
    await flush();
    assert.deepEqual(names(), ["page_view"]); // the event from the withdrawn grant is gone
  });

  test("the buffer while loading is bounded", async () => {
    runtime.recordPageView("/wall");
    runtime.updateConsent("granted"); // the page view is the first of the bounded buffer
    for (let i = 0; i < 100; i++) track("tear_start");
    t.settle();
    await flush();
    assert.equal(t.sent.length, runtime.MAX_PENDING);
  });

  test("a loader from a replaced deployment cannot change the new one", async () => {
    runtime.recordPageView("/wall");
    runtime.updateConsent("granted");
    const stale = t;
    const fresh = fakeTransport();
    runtime.configureAnalytics({ config: { ...CONFIG, measurementId: "G-OTHER00000" }, transport: () => fresh });
    assert.equal(stale.pauses, 1);
    assert.equal(fresh.loads, 1);
    stale.settle(); // the old tag finishes loading late
    await flush();
    track("tear_start");
    assert.deepEqual(fresh.sent, []); // the new tag is still loading: buffered, not sent through the old one
    assert.deepEqual(stale.sent, []);
    fresh.settle();
    await flush();
    assert.deepEqual(fresh.sent.map(([n]) => n), ["page_view", "tear_start"]);
    assert.ok(fresh.sent.every(([, p]) => p.deployment_env === "preview"));
  });

  test("configuring twice with the same settings (Strict Mode) changes nothing", async () => {
    runtime.recordPageView("/wall");
    await grantAndLoad();
    runtime.configureAnalytics({ config: { ...CONFIG }, transport: () => assert.fail("must not rebuild") });
    track("tear_start");
    assert.deepEqual(names(), ["page_view", "tear_start"]);
    assert.equal(t.loads, 1);
  });
});

describe("runtime: page views", () => {
  beforeEach(() => setup({ referrer: "https://mail.example.com/inbox/SEEDTOKEN7f3a?to=jane.doe@example.com" }));

  test("initial view: template location, origin-only external referrer, fixed title", async () => {
    runtime.recordPageView("/s/SEEDTOKEN7f3a", "?from=SEEDTOKEN7f3a&utm_source=newsletter&utm_campaign=private_name_123");
    await grantAndLoad();
    const [v] = views();
    assert.equal(v.page_location, `${ORIGIN}/s/:token?utm_source=newsletter`);
    assert.equal(v.page_referrer, "https://mail.example.com/");
    assert.equal(v.page_title, "Share page");
    assert.equal(v.route_template, "/s/:token");
    assert.equal(v.schema_version, catalog.SCHEMA_VERSION);
    assert.equal(v.deployment_env, "preview");
    assert.equal(v.runtime_mode, "demo");
    assertNoSeeds(t.sent);
  });

  test("push, replace, back and forward each count once; the referrer is the previous template", async () => {
    runtime.recordPageView("/");
    await grantAndLoad();
    runtime.recordPageView("/new", "?url=SEEDURL55e"); // push
    runtime.recordPageView("/studio/SEEDTOKEN7f3a"); // replace (new URL)
    runtime.recordPageView("/new", "?url=SEEDURL55e"); // back
    runtime.recordPageView("/studio/SEEDTOKEN7f3a"); // forward
    const v = views();
    assert.deepEqual(v.map((p) => p.route_template), ["/", "/new", "/studio/:id", "/new", "/studio/:id"]);
    assert.deepEqual(v.map((p) => p.page_referrer), ["https://mail.example.com/", `${ORIGIN}/`, `${ORIGIN}/new`, `${ORIGIN}/studio/:id`, `${ORIGIN}/new`]);
    assertNoSeeds(t.sent);
  });

  test("Strict Mode double effects and remounts on the same URL count once", async () => {
    assert.equal(runtime.recordPageView("/wall"), true);
    await grantAndLoad();
    assert.equal(runtime.recordPageView("/wall"), false);
    assert.equal(runtime.recordPageView("/wall", ""), false);
    assert.equal(runtime.recordPageView("/wall", "?"), false);
    assert.equal(views().length, 1);
  });

  test("same template, different id or query: separate views with the same safe location", async () => {
    runtime.recordPageView("/studio/aaaSEEDTOKEN7f3a");
    await grantAndLoad();
    runtime.recordPageView("/studio/bbbSEEDTOKEN7f3a");
    runtime.recordPageView("/search", "?q=SEEDQUERY19c");
    runtime.recordPageView("/search", "?q=SEEDQUERY19c2");
    const v = views();
    assert.equal(v.length, 4);
    assert.deepEqual(v.map((p) => p.page_location), [`${ORIGIN}/studio/:id`, `${ORIGIN}/studio/:id`, `${ORIGIN}/search`, `${ORIGIN}/search`]);
    assertNoSeeds(t.sent);
  });

  test("tear → wall: push /wall?pinned=<id> then the wall's replace to /wall is one view, without the id", async () => {
    runtime.recordPageView("/studio/SEEDTOKEN7f3a");
    await grantAndLoad();
    assert.equal(runtime.recordPageView("/wall", "pinned=SEEDTOKEN7f3a"), true); // router.push from TearFlow
    assert.equal(runtime.recordPageView("/wall", ""), false); // WallClient's history.replaceState cleanup
    assert.equal(runtime.recordPageView("/wall", "?"), false); // a Strict Mode re-run on the cleaned address
    const v = views();
    assert.deepEqual(v.map((p) => p.route_template), ["/studio/:id", "/wall"]);
    assert.equal(v[1].page_location, `${ORIGIN}/wall`);
    assert.equal(v[1].page_referrer, `${ORIGIN}/studio/:id`);
    assertNoSeeds(t.sent);
  });

  test("a landing on /wall?pinned=<id> keeps no id and its cleanup is not a second view", async () => {
    runtime.recordPageView("/wall", "pinned=SEEDTOKEN7f3a&utm_source=newsletter");
    await grantAndLoad();
    assert.equal(runtime.recordPageView("/wall", "utm_source=newsletter"), false);
    assert.equal(runtime.recordPageView("/wall", "pinned=other&pinned=SEEDTOKEN7f3a&utm_source=newsletter"), false); // any pinned value(s)
    const v = views();
    assert.equal(v.length, 1);
    assert.equal(v[0].page_location, `${ORIGIN}/wall?utm_source=newsletter`);
    assertNoSeeds(t.sent);
  });

  test("only /wall's pinned is ignored: real back/forward, other /wall params and other routes still count", async () => {
    runtime.recordPageView("/wall", "pinned=SEEDTOKEN7f3a");
    await grantAndLoad();
    assert.equal(runtime.recordPageView("/wall"), false);
    assert.equal(runtime.recordPageView("/studio/SEEDTOKEN7f3a"), true); // open a stub
    assert.equal(runtime.recordPageView("/wall"), true); // back: a real return to the wall
    assert.equal(runtime.recordPageView("/wall", "view=grid"), true); // another /wall parameter is real state
    assert.equal(runtime.recordPageView("/wall", "view=grid&pinned=SEEDTOKEN7f3a"), false); // ... pinned alone is not
    assert.equal(runtime.recordPageView("/wall", "view=list"), true);
    assert.equal(runtime.recordPageView("/search", "q=SEEDQUERY19c&pinned=a"), true);
    assert.equal(runtime.recordPageView("/search", "q=SEEDQUERY19c"), true); // pinned matters off /wall
    assert.equal(runtime.recordPageView("/studio/SEEDTOKEN7f3a", "pinned=a"), true);
    assert.equal(runtime.recordPageView("/studio/SEEDTOKEN7f3a"), true);
    assert.equal(runtime.recordPageView("/studio/bbbSEEDTOKEN7f3a"), true); // same template, different id
    assert.equal(views().length, 10);
    assertNoSeeds(t.sent);
  });

  test("the internal page key never leaves the runtime", async () => {
    runtime.recordPageView("/studio/SEEDTOKEN7f3a", "?from=SEEDTOKEN7f3a");
    await grantAndLoad();
    track("studio_open", { status: "ready", device: "phone" });
    assertNoSeeds(t.sent);
    assert.ok(t.sent.every(([, p]) => !("key" in p)));
  });

  test("every event carries the sanitized page and deployment labels", async () => {
    runtime.recordPageView("/checkout/SEEDTOKEN7f3a");
    await grantAndLoad();
    track("begin_checkout", { currency: "USD", value: 49, item_id: "print_matte_classic", item_count: 1, context: "checkout" });
    const [, p] = t.sent.at(-1);
    assert.equal(p.route_template, "/checkout/:id");
    assert.equal(p.page_location, `${ORIGIN}/checkout/:id`);
    assert.equal(p.capability, "sandbox");
    assert.equal(p.deployment_env, "preview");
  });
});

describe("track helpers", () => {
  beforeEach(() => setup());

  test("trackOnce sends a key once per page load, even across consent", async () => {
    trackOnce("creation:1", "creation_complete", { result: "created" }); // before consent: dropped, key spent
    await loadOnPage();
    trackOnce("creation:1", "creation_complete", { result: "created" });
    trackOnce("creation:2", "creation_complete", { result: "created" });
    trackOnce("creation:2", "creation_complete", { result: "created" });
    assert.deepEqual(names(), ["creation_complete"]);
  });

  test("rejections are reported by key, never by value", async () => {
    await grantAndLoad();
    track("search_results", { result: "SEEDQUERY19c" });
    track("purchase", { value: 10 });
    assert.equal(rejected.length, 2);
    assertNoSeeds(rejected);
    assert.deepEqual(t.sent, []);
  });

  test("no purchase, login, sign-up or wallet issuance is ever sent", async () => {
    await loadOnPage();
    for (const name of ["purchase", "refund", "login", "sign_up", "wallet_pass_issued"]) track(name, { value: 10, currency: "USD" });
    track("sandbox_order", { method: "card", result: "placed", receipt: "local", line_count: 1, value: 49, currency: "USD" });
    track("wallet_select", { provider: "apple" });
    track("sign_in_link", { reason: "save", result: "sandbox" });
    assert.deepEqual(names(), ["sandbox_order", "wallet_select", "sign_in_link"]);
    assert.equal(t.sent[0][1].capability, "sandbox");
    assert.equal(t.sent[1][1].capability, "simulated");
  });
});

describe("GA shaping, vitals and timing", () => {
  test("a cart variant becomes GA's items array; nothing else changes", () => {
    const out = toGaParams("add_to_cart", { currency: "USD", value: 49, item_id: "print_foil_stamp", quantity: 2, capability: "sandbox" });
    assert.deepEqual(out, { currency: "USD", value: 49, capability: "sandbox", items: [{ item_id: "print_foil_stamp", item_category: "print", item_variant: "foil_stamp", quantity: 2 }] });
    assert.deepEqual(toGaParams("select_item", { item_list_id: "search_results", index: 2 }), { item_list_id: "search_results", index: 2 });
    assert.deepEqual(toGaParams("view_cart", { value: 9 }), { value: 9 });
  });

  test("web vitals: known metrics only, CLS scaled, the per-load id dropped", () => {
    assert.deepEqual(timing.vitalParams({ id: "v4-SEEDTOKEN7f3a", name: "CLS", value: 0.123, rating: "needs-improvement", navigationType: "navigate" }), {
      metric_name: "CLS", metric_value: 123, metric_rating: "needs-improvement", navigation_type: "navigate",
    });
    assert.deepEqual(timing.vitalParams({ name: "LCP", value: 2400.4, rating: "good", navigationType: "weird" }), { metric_name: "LCP", metric_value: 2400, metric_rating: "good", navigation_type: "unknown" });
    assert.equal(timing.vitalParams({ name: "FID", value: 10 }), null);
    assert.equal(timing.vitalParams({ name: "LCP", value: Number.NaN }), null);
    assert.equal(timing.vitalParams({ name: "LCP", value: 9e9 }), null);
    for (const metric of ["CLS", "FCP", "INP", "LCP", "TTFB"]) {
      assert.equal(validateInternalEvent("web_vital", timing.vitalParams({ name: metric, value: 1 })).ok, true);
    }
  });

  test("route timing is taken once, after a router start, and keeps no URL", () => {
    timing.resetTimingForTests();
    assert.equal(timing.takeRouteTiming(), null);
    timing.markRouteStart("traverse");
    const r = timing.takeRouteTiming();
    assert.equal(r.navigation_type, "traverse");
    assert.ok(Number.isInteger(r.duration_ms) && r.duration_ms >= 0);
    assert.equal(timing.takeRouteTiming(), null);
    timing.markRouteStart("anything-else");
    assert.equal(timing.takeRouteTiming().navigation_type, "push");
    assert.equal(validateInternalEvent("route_timing", r).ok, true);
  });

  test("route timing and vitals respect consent like every other event", async () => {
    setup();
    runtime.trackInternal("web_vital", { metric_name: "LCP", metric_value: 1000 });
    await loadOnPage();
    runtime.trackInternal("route_timing", { duration_ms: 120, navigation_type: "push" });
    assert.deepEqual(names(), ["route_timing"]);
  });
});

describe("source guards", () => {
  const dir = fileURLToPath(new URL("../src/customer/analytics/", import.meta.url));
  // Code only: comments explain what is avoided and may name it.
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => [f, code(readFileSync(join(dir, f), "utf8"))]);

  test("analytics never reads the raw URL, title or query from the browser", () => {
    for (const [f, s] of sources) {
      assert.ok(!/location\.(href|search|hash|pathname)/.test(s), `${f} reads the raw location`);
      assert.ok(!/document\.title/.test(s), `${f} reads document.title`);
      assert.ok(!/document\.URL/.test(s), `${f} reads document.URL`);
    }
    const referrerReaders = sources.filter(([, s]) => /document\.referrer/.test(s)).map(([f]) => f);
    assert.deepEqual(referrerReaders, ["runtime.ts"]); // read once, then sanitized to an origin or template
  });

  test("no hashing of user data into identifiers, no user_id", () => {
    for (const [f, s] of sources) {
      assert.ok(!/crypto\.subtle|createHash|sha256|md5/i.test(s), f);
      assert.ok(!/user_id\s*:/.test(s), f);
    }
  });

  test("no product code calls track/flow with a forbidden event", () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const offenders = [];
    (function walk(d) {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) {
          const s = readFileSync(p, "utf8");
          for (const bad of catalog.FORBIDDEN_EVENTS) if (new RegExp(`(track|trackOnce|flow)\\(\\s*["'\`]${bad}["'\`]`).test(s)) offenders.push(`${p}: ${bad}`);
        }
      }
    })(root);
    assert.deepEqual(offenders, []);
  });

  test("every catalogued event has a call site and a dictionary entry", () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const called = new Set();
    (function walk(d) {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !p.includes("/customer/analytics/")) {
          for (const m of readFileSync(p, "utf8").matchAll(/(?:track|trackOnce|flow)\(\s*(?:`[^`]*`,\s*)?["']([a-z_]+)["']/g)) called.add(m[1]);
        }
      }
    })(root);
    const doc = readFileSync(new URL("../docs/operations/analytics.md", import.meta.url), "utf8");
    for (const name of Object.keys(catalog.EVENTS)) {
      assert.ok(called.has(name), `${name} is catalogued but never emitted`);
      assert.ok(doc.includes(`| \`${name}\` |`), `${name} is missing from docs/operations/analytics.md`);
    }
    for (const name of called) assert.ok(name in catalog.EVENTS, `${name} is emitted but not catalogued`);
  });

  test("the root layout mounts analytics from server settings", () => {
    const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
    assert.match(layout, /<Analytics config=\{analyticsConfigFromEnv\(process\.env\)\} \/>/);
    assert.match(layout, /export const dynamic = "force-dynamic"/);
  });

  test("no measurement id is hardcoded: collection needs explicit server settings", () => {
    const ids = /G-(RVV7ZNF463|M2ELMGCNKW|YBRK8129PK)|GT-M3L6XD84/;
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    (function walk(d) {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|css|json)$/.test(f)) assert.ok(!ids.test(readFileSync(p, "utf8")), p);
      }
    })(root);
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    assert.match(example, /^TICKETSTUB_ANALYTICS_ENV=$/m);
    assert.match(example, /^TICKETSTUB_GA_MEASUREMENT_ID=$/m);
    assert.ok(!ids.test(example));
  });

  test("the privacy page explains opt-in analytics and offers choices only where it is configured", () => {
    const page = readFileSync(new URL("../src/app/privacy/page.tsx", import.meta.url), "utf8");
    assert.match(page, /title: "Optional analytics"/);
    for (const words of ["Allow analytics", "Google Analytics is not loaded", "random identifier", "browser profile", "Turning it off", "Nothing is used for ads"]) {
      assert.ok(page.includes(words), words);
    }
    assert.match(page, /analyticsConfigFromEnv\(process\.env\) !== null/);
    assert.match(page, /\{analyticsOn \? <ConsentChoicesButton \/> : null\}/);
  });
});
