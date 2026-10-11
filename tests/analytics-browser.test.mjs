import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import "./analytics-hooks.mjs";

// The real GA4 adapter and consent store in a fake browser: what is injected, pushed to the dataLayer
// and written to cookies before and after consent, on reload, on withdrawal and when the tag is blocked.
// No network: the "script" is an object the test loads or fails by hand.

const SEEDS = ["SEEDTOKEN7f3a", "SEEDQUERY19c", "Jane Doe", "jane.doe@example.com", "SEEDTITLE88", "SEEDHASH0a1", "private_name_123"];
const HREF = "https://getticketstub.example/s/SEEDTOKEN7f3a?from=SEEDTOKEN7f3a&to=Jane%20Doe&utm_campaign=private_name_123#SEEDHASH0a1";

/** A cookie jar with document.cookie semantics: "a=1; b=2" on read, one Set-Cookie per write. */
function cookieJar() {
  const jar = new Map();
  const writes = [];
  return {
    jar, writes,
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); },
    set cookie(line) {
      writes.push(line);
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const [k, v] = pair.split("=");
      if (attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(k);
      else jar.set(k, v);
    },
  };
}

let consentModule = null;

function fakeBrowser(storage = new Map()) {
  const listeners = new Map();
  const scripts = [];
  const cookies = cookieJar();
  const document = {
    title: "SEEDTITLE88 · Jane Doe's stub",
    referrer: "https://mail.example.com/inbox/SEEDTOKEN7f3a?to=jane.doe@example.com",
    get cookie() { return cookies.cookie; },
    set cookie(v) { cookies.cookie = v; },
    activeElement: null,
    createElement(tag) {
      assert.equal(tag, "script");
      return { tagName: "SCRIPT", dataset: {}, async: false, src: "", onload: null, onerror: null };
    },
    head: { appendChild(el) { scripts.push(el); return el; } },
  };
  const url = new URL(HREF);
  const window = {
    document,
    location: { href: HREF, origin: url.origin, hostname: url.hostname, pathname: url.pathname, search: url.search, hash: url.hash },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(e) { listeners.get(e.type)?.forEach((fn) => fn(e)); return true; },
  };
  globalThis.window = window;
  globalThis.document = document;
  consentModule?.resetConsentForTests(); // a new page load has no in-memory answer
  return { window, document, scripts, cookies, storage, listeners };
}

const flush = () => new Promise((r) => setImmediate(r));
const CONFIG = { measurementId: "G-TEST000000", environment: "preview", runtimeMode: "demo", debug: false };

// Modules read `window` lazily, so one import serves every fake browser.
fakeBrowser();
const runtime = await import("../src/customer/analytics/runtime.ts");
const consent = await import("../src/customer/analytics/consent.ts");
consentModule = consent;
const gtag = await import("../src/customer/analytics/gtag.ts");
const { track } = await import("../src/customer/analytics/track.ts");

/** dataLayer entries as plain arrays (gtag pushes Arguments objects). */
const layer = (w) => (w.dataLayer ?? []).map((a) => Array.from(a));
const events = (w) => layer(w).filter((a) => a[0] === "event");

/** What the Analytics component does on mount: configure, read the choice, follow it. */
function boot(b, config = CONFIG) {
  runtime.resetAnalyticsForTests();
  runtime.configureAnalytics({ config });
  runtime.updateConsent(consent.readConsent());
  const unsubscribe = consent.subscribeConsent(runtime.updateConsent);
  runtime.recordPageView(b.window.location.pathname, b.window.location.search);
  return unsubscribe;
}

function assertNoSeeds(b) {
  const everything = JSON.stringify({ layer: layer(b.window), scripts: b.scripts.map((s) => s.src), cookies: b.cookies.writes });
  for (const seed of SEEDS) assert.ok(!everything.includes(seed), `leaked ${seed}`);
}

let unsubscribe = () => {};
beforeEach(() => unsubscribe());

describe("before consent", () => {
  test("no script, no dataLayer, no cookie, even with events and navigations", async () => {
    const b = fakeBrowser();
    unsubscribe = boot(b);
    track("intake_submit", { entry: "home", input_source: "link", result: "accepted" });
    runtime.recordPageView("/new", "?url=SEEDQUERY19c");
    await flush();
    assert.equal(b.scripts.length, 0);
    assert.equal(b.window.dataLayer, undefined);
    assert.equal(b.window.gtag, undefined);
    assert.equal(b.cookies.writes.length, 0);
  });

  test("an unconfigured deployment never injects anything, whatever the stored choice", async () => {
    const b = fakeBrowser(new Map([[consent.CONSENT_KEY, JSON.stringify({ v: 1, decision: "granted" })]]));
    unsubscribe = boot(b, null);
    track("tear_start");
    await flush();
    assert.equal(b.scripts.length, 0);
    assert.equal(b.window.dataLayer, undefined);
  });
});

describe("accept", () => {
  test("injects gtag.js once, configured for manual sanitized page views with ads off", async () => {
    const b = fakeBrowser();
    unsubscribe = boot(b);
    track("intake_submit", { entry: "home", input_source: "link", result: "accepted" }); // before consent: gone
    consent.setConsent("granted");
    assert.equal(b.scripts.length, 1);
    const [script] = b.scripts;
    assert.equal(script.src, "https://www.googletagmanager.com/gtag/js?id=G-TEST000000");
    assert.equal(script.async, true);

    const l = layer(b.window);
    const consentDefault = l.find((a) => a[0] === "consent" && a[1] === "default")[2];
    assert.equal(consentDefault.analytics_storage, "granted");
    assert.equal(consentDefault.ad_storage, "denied");
    assert.equal(consentDefault.ad_user_data, "denied");
    assert.equal(consentDefault.ad_personalization, "denied");
    const config = l.find((a) => a[0] === "config");
    assert.equal(config[1], "G-TEST000000");
    assert.equal(config[2].send_page_view, false);
    assert.equal(config[2].allow_google_signals, false);
    assert.equal(config[2].allow_ad_personalization_signals, false);
    assert.equal(config[2].page_location, "https://getticketstub.example/s/:token");
    assert.equal(config[2].page_referrer, "https://mail.example.com/");
    assert.equal(config[2].page_title, "Share page");
    assert.equal(config[2].debug_mode, undefined);
    assert.deepEqual(events(b.window), []); // nothing until the tag has loaded

    script.onload();
    await flush();
    const ev = events(b.window);
    assert.deepEqual(ev.map((a) => a[1]), ["page_view"]); // the current page; the earlier intake is not replayed
    assert.equal(ev[0][2].page_location, "https://getticketstub.example/s/:token");

    // page views also update the tag-wide page so gtag's own hits never fall back to document.location
    const sets = layer(b.window).filter((a) => a[0] === "set" && typeof a[1] === "object");
    assert.ok(sets.length >= 1);
    assert.ok(sets.every((a) => a[1].page_location?.startsWith("https://getticketstub.example/")));

    runtime.recordPageView("/studio/SEEDTOKEN7f3a");
    track("studio_open", { status: "ready", device: "phone" });
    track("add_to_cart", { currency: "USD", value: 49, item_id: "print_matte_classic", quantity: 1, context: "checkout" });
    const last = events(b.window).at(-1)[2];
    assert.deepEqual(last.items, [{ item_id: "print_matte_classic", item_category: "print", item_variant: "matte_classic", quantity: 1 }]);
    assert.equal(last.capability, "sandbox");
    assert.equal(last.item_id, undefined);
    assertNoSeeds(b);
  });

  test("debug mode only when configured for DebugView", async () => {
    const b = fakeBrowser();
    unsubscribe = boot(b, { ...CONFIG, debug: true });
    consent.setConsent("granted");
    assert.equal(layer(b.window).find((a) => a[0] === "config")[2].debug_mode, true);
  });

  test("the choice survives a reload: the next page load starts the tag without asking", async () => {
    const storage = new Map();
    let b = fakeBrowser(storage);
    unsubscribe = boot(b);
    consent.setConsent("granted");
    unsubscribe();
    assert.equal(consent.readConsent(), "granted");

    b = fakeBrowser(storage); // reload: fresh window, same storage
    unsubscribe = boot(b);
    assert.equal(b.scripts.length, 1);
    b.scripts[0].onload();
    await flush();
    assert.deepEqual(events(b.window).map((a) => a[1]), ["page_view"]);
  });
});

describe("reject and withdraw", () => {
  test("rejecting persists across reload and never loads the tag", async () => {
    const storage = new Map();
    let b = fakeBrowser(storage);
    unsubscribe = boot(b);
    consent.setConsent("denied");
    unsubscribe();
    b = fakeBrowser(storage);
    unsubscribe = boot(b);
    track("tear_start");
    await flush();
    assert.equal(consent.readConsent(), "denied");
    assert.equal(b.scripts.length, 0);
    assert.equal(b.window.dataLayer, undefined);
  });

  test("withdrawal disables the tag, updates consent, clears GA cookies and sends nothing more", async () => {
    const b = fakeBrowser();
    unsubscribe = boot(b);
    consent.setConsent("granted");
    b.scripts[0].onload();
    await flush();
    // what gtag.js would have written
    b.cookies.jar.set("_ga", "GA1.1.123.456");
    b.cookies.jar.set("_ga_TEST000000", "GS1.1.789");
    b.cookies.jar.set("ticketstub_keep", "1");
    const before = events(b.window).length;

    consent.setConsent("denied");
    assert.equal(b.window["ga-disable-G-TEST000000"], true);
    const update = layer(b.window).filter((a) => a[0] === "consent" && a[1] === "update").at(-1);
    assert.deepEqual(update[2], { analytics_storage: "denied" });
    assert.equal(b.cookies.jar.has("_ga"), false);
    assert.equal(b.cookies.jar.has("_ga_TEST000000"), false);
    assert.equal(b.cookies.jar.has("ticketstub_keep"), true);
    assert.ok(b.cookies.writes.some((w) => w.includes("domain=.getticketstub.example")));

    track("tear_start");
    runtime.recordPageView("/wall");
    await flush();
    assert.equal(events(b.window).length, before);
  });

  test("granting again in the same page re-enables the loaded tag without a second script", async () => {
    const b = fakeBrowser();
    unsubscribe = boot(b);
    consent.setConsent("granted");
    b.scripts[0].onload();
    await flush();
    consent.setConsent("denied");
    runtime.recordPageView("/wall");
    consent.setConsent("granted");
    assert.equal(b.scripts.length, 1);
    assert.equal(b.window["ga-disable-G-TEST000000"], false);
    assert.deepEqual(events(b.window).map((a) => a[2].route_template), ["/s/:token", "/wall"]);
  });

  test("a withdrawal in another tab reaches this one", async () => {
    const storage = new Map();
    const b = fakeBrowser(storage);
    unsubscribe = boot(b);
    consent.setConsent("granted");
    b.scripts[0].onload();
    await flush();
    storage.set(consent.CONSENT_KEY, JSON.stringify({ v: 1, decision: "denied" }));
    b.window.dispatchEvent({ type: "storage", key: consent.CONSENT_KEY });
    assert.equal(b.window["ga-disable-G-TEST000000"], true);
    const n = events(b.window).length;
    track("tear_start");
    assert.equal(events(b.window).length, n);
  });

  test("leftover GA cookies are cleared when the visitor has not agreed", () => {
    const b = fakeBrowser(new Map([[consent.CONSENT_KEY, JSON.stringify({ v: 1, decision: "denied" })]]));
    b.cookies.jar.set("_ga", "GA1.1.1.1");
    unsubscribe = boot(b);
    assert.equal(b.cookies.jar.has("_ga"), false);
  });
});

describe("blocked or slow tag", () => {
  test("a blocked script drops what waited and queues nothing after", async () => {
    const b = fakeBrowser();
    unsubscribe = boot(b);
    consent.setConsent("granted");
    track("tear_start");
    b.scripts[0].onerror();
    await flush();
    track("tear_cancel");
    runtime.recordPageView("/wall");
    b.scripts[0].onload?.(); // a late arrival after failure
    await flush();
    assert.deepEqual(events(b.window), []);
  });

  test("a tag that never loads times out and drops its buffer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const b = fakeBrowser();
    unsubscribe = boot(b);
    consent.setConsent("granted");
    track("tear_start");
    t.mock.timers.tick(gtag.LOAD_TIMEOUT_MS + 1);
    t.mock.timers.reset();
    await flush();
    b.scripts[0].onload();
    await flush();
    track("tear_cancel");
    assert.deepEqual(events(b.window), []);
  });
});

describe("consent store", () => {
  test("defaults to unset and ignores malformed or foreign records", () => {
    for (const raw of [null, "", "granted", "{", JSON.stringify({ decision: "granted" }), JSON.stringify({ v: 2, decision: "granted" }), JSON.stringify({ v: 1, decision: "yes" })]) {
      const b = fakeBrowser(new Map(raw === null ? [] : [[consent.CONSENT_KEY, raw]]));
      assert.equal(consent.readConsent(), "unset", String(raw));
      void b;
    }
  });

  test("stores only the decision and a version", () => {
    const b = fakeBrowser();
    consent.setConsent("granted");
    assert.deepEqual(JSON.parse(b.storage.get(consent.CONSENT_KEY)), { v: 1, decision: "granted" });
  });

  test("works for the page when storage is unavailable, and asks again next visit", () => {
    const b = fakeBrowser();
    b.window.localStorage.getItem = () => { throw new Error("SecurityError"); };
    b.window.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    assert.doesNotThrow(() => consent.setConsent("denied"));
    assert.equal(consent.readConsent(), "denied");
    fakeBrowser(); // next visit: nothing was stored, so the question comes back
    assert.equal(consent.readConsent(), "unset");
  });

  test("openConsentPreferences asks the panel to open", () => {
    const b = fakeBrowser();
    let opened = 0;
    b.window.addEventListener(consent.CONSENT_OPEN_EVENT, () => opened++);
    consent.openConsentPreferences();
    assert.equal(opened, 1);
  });

  test("a failing listener does not stop the others", () => {
    fakeBrowser();
    const heard = [];
    const a = consent.subscribeConsent(() => { throw new Error("boom"); });
    const c = consent.subscribeConsent((s) => heard.push(s));
    consent.setConsent("granted");
    a(); c();
    assert.deepEqual(heard, ["granted"]);
  });
});
