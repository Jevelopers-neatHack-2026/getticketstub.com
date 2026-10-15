import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import "./analytics-hooks.mjs";

const runtime = await import("../src/customer/analytics/runtime.ts");
const { track } = await import("../src/customer/analytics/track.ts");
const base = "http://127.0.0.1:43100";
const named = (events, name) => events.filter((event) => event.name === name);
const pick = (params, keys) => Object.fromEntries(keys.map((key) => [key, params[key]]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Execute the actual browser-suite assertions, without starting its server or Chrome. This keeps the
// negative controls tied to the CI gate rather than a second implementation of the expected behavior.
const path = new URL("../scripts/check-analytics-journeys.mjs", import.meta.url);
const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
function entryCheck(label) {
  const checks = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "check") {
      const title = node.arguments[0];
      if (title && ts.isCallExpression(title) && title.arguments[0]?.text === label) checks.push(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(checks.length, 1, `one browser assertion for ${label}`);
  const evaluate = new Function("ev", "base", "named", "pick", "same", `return (${checks[0].getText(source)});`);
  return (events) => evaluate(events, base, named, pick, same);
}
const sourceReady = entryCheck("entry: one initial home page_view before the search action");
const searchTransition = entryCheck("entry: cta_select(search, home) on / before the /search page_view");

// A remembered grant arrives before hydration, while the synthetic tag is still loading. A fixed-delay
// mark here is zero even though the first measured page will be home. Release the real runtime's queue
// only when the source page is available, then perform exactly the StudioStart search action.
const events = [];
let finishTag;
runtime.resetAnalyticsForTests();
runtime.configureAnalytics({
  config: { measurementId: "G-TEST000000", environment: "preview", runtimeMode: "demo", debug: false },
  origin: base,
  referrer: "",
  transport: () => ({
    load: () => new Promise((resolve) => { finishTag = resolve; }),
    send: (name, p) => events.push({ name, p: structuredClone(p) }),
    pause() {}, resume() {},
  }),
});
runtime.updateConsent("granted");
const prematureMark = events.length;
const beforeHydration = structuredClone(events);
runtime.recordPageView("/");
finishTag();
await new Promise((resolve) => setImmediate(resolve));
const sourceViews = structuredClone(events);
const readyMark = events.length;
track("cta_select", { cta: "search", context: "home" });
runtime.recordPageView("/search");
const transition = events.slice(readyMark);

test("landing analytics: readiness rejects an unhydrated home and accepts its one measured view", () => {
  assert.equal(sourceReady(beforeHydration), false);
  assert.equal(sourceReady(sourceViews), true);
  assert.equal(sourceReady([...sourceViews, ...sourceViews]), false);
});

test("landing analytics: a delayed initial view cannot be mistaken for the search destination", () => {
  assert.deepEqual(events.map((event) => [event.name, event.p.route_template]), [
    ["page_view", "/"], ["cta_select", "/"], ["page_view", "/search"],
  ]);
  assert.equal(searchTransition(events.slice(prematureMark)), false, "an initial home view is not a destination view");
  assert.equal(searchTransition(transition), true, "marking after source readiness preserves the real search contract");
  assert.deepEqual(pick(transition[0].p, ["cta", "context", "route_template", "page_location"]), {
    cta: "search", context: "home", route_template: "/", page_location: `${base}/`,
  });
});

const invalid = [
  ["missing CTA", (trace) => trace.slice(1)],
  ["duplicate CTA", (trace) => [trace[0], ...trace]],
  ["wrong CTA", (trace) => { trace[0].p.cta = "make"; return trace; }],
  ["wrong entry context", (trace) => { trace[0].p.context = "make"; return trace; }],
  ["CTA attributed to the destination", (trace) => { trace[0].p.route_template = "/search"; return trace; }],
  ["missing destination view", (trace) => trace.slice(0, 1)],
  ["duplicate destination view", (trace) => [...trace, trace[1]]],
  ["wrong destination route", (trace) => { trace[1].p.route_template = "/wall"; return trace; }],
  ["wrong destination location", (trace) => { trace[1].p.page_location = `${base}/wall`; return trace; }],
  ["destination view before CTA", (trace) => trace.reverse()],
];
for (const [name, mutate] of invalid) {
  test(`landing analytics: the browser gate rejects ${name}`, () => {
    assert.equal(searchTransition(mutate(structuredClone(transition))), false);
  });
}
