import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { submitSheetEmail } from "../scripts/lib/analytics-sheet-readiness.mjs";

const EMAIL = "synthetic-private@example.test";
const PRIVATE = "data:image/png;base64,PRIVATE_CANARY https://private.invalid/?token=PRIVATE_CANARY";

// Synthetic DOM/protocol controls execute the actual serialized browser probe and driver. They do
// not replace readiness results with predetermined pass values and do not claim native coverage.
function harness(options = {}) {
  const nodes = [], trace = [], groups = new Map();
  let animationReads = 0, probes = 0, scrolled, document;
  function node(name, parentElement = null) {
    const item = { name, parentElement, isConnected: true, disabled: false, readOnly: false, inert: false,
      style: { display: "block", visibility: "visible", opacity: "1" }, attributes: {}, textContent: "",
      contains(other) { for (let n = other; n; n = n.parentElement) if (n === item) return true; return false; },
      getAttribute(key) { return item.attributes[key] ?? null; },
      setAttribute(key, value) { item.attributes[key] = value; },
      removeAttribute(key) { delete item.attributes[key]; },
      closest(selector) { for (let n = item; n; n = n.parentElement) if (selector === "[inert]" && n.inert) return n; return null; },
      getAnimations() {
        if (item !== sheet) return [];
        animationReads++;
        return options.animating || animationReads <= (options.animationReads ?? 0) ? [{ pending: false, playState: "running" }] : [];
      },
      scrollIntoView() { scrolled = item; trace.push(["scroll", name]); },
      getBoundingClientRect() { return { x: 10, y: options.offscreen || animationReads < (options.animationReads ?? 0) ? 1000 : (item === field ? 40 : 100), width: 200, height: 40 }; },
      focus() { trace.push(["focus", name]); if (!options.focusFails) document.activeElement = item; },
      select() { trace.push(["select", name]); },
    };
    nodes.push(item); return item;
  }
  const html = node("html"), body = node("body", html), sheet = node("sheet", body), form = node("form", sheet);
  const field = node("field", form), button = node("button", form), cover = node("cover", body);
  field.form = form; button.form = form; field.value = ""; button.textContent = "Email me a link";
  form.querySelectorAll = () => [button];
  document = { documentElement: html, activeElement: null, fields: [field], sheets: [sheet],
    querySelectorAll(selector) {
      if (selector === "#signin-email") return document.fields;
      if (selector === '[role="dialog"][aria-modal="true"]') return document.sheets;
      if (selector === '[role="dialog"] form button[type="submit"]') return [button];
      if (selector === "[data-journey-target]") return nodes.filter((n) => "data-journey-target" in n.attributes);
      return [];
    },
    querySelector(selector) { return document.querySelectorAll(selector)[0]; },
    elementFromPoint() { return options.covered ? cover : scrolled; },
  };
  for (const item of nodes) item.ownerDocument = document;
  const globals = { document, innerWidth: 390, innerHeight: 844, getComputedStyle: (item) => item.style, console: { log() {} } };
  const page = {
    async send(method, params) {
      trace.push(["send", method]);
      if (options.throws === method) throw new Error(PRIVATE);
      if (options.holds === method) return new Promise((resolve) => { page.release = resolve; });
      if (method === "Runtime.evaluate") {
        const state = vm.runInNewContext(params.expression, globals);
        groups.set(params.objectGroup, state);
        return { result: { objectId: params.objectGroup } };
      }
      if (method === "Runtime.callFunctionOn") {
        options.onProbe?.(++probes, { field, form, button, sheet, document, node });
        const fn = vm.runInNewContext(`(${params.functionDeclaration})`, globals);
        const value = fn.apply(groups.get(params.objectId), params.arguments.map((item) => item.value));
        return options.invalidProbe ? { result: { value: { state: "wait", code: PRIVATE } } } : { result: { value } };
      }
      if (method === "Runtime.releaseObjectGroup") { groups.delete(params.objectGroup); return {}; }
      throw new Error("unexpected synthetic protocol method");
    },
    async type(value) {
      trace.push(["type"]); field.value = value; options.onType?.({ field, form, button, sheet, document, node });
      if (options.holdType) return new Promise((resolve) => { page.release = resolve; });
    },
    async click(x, y) {
      trace.push(["click", x, y]);
      if (options.holdClick) return new Promise((resolve) => { page.release = resolve; });
      if (options.clickThrows) throw new Error(PRIVATE);
    },
    async eval(expression) { return vm.runInNewContext(expression, globals); },
  };
  return { page, field, form, button, sheet, body, document, trace, groups, globals };
}

async function run(h, options = {}) {
  // Drive readiness deadlines deterministically. Held protocol operations still exercise real bounded timers.
  let time = 0;
  const result = await submitSheetEmail(h.page, EMAIL, { timeoutMs: 100, pollMs: 1, cleanupMs: 10,
    clock: () => time, pause: async (ms) => { time += ms; }, ...options });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY|synthetic-private|data:image|https?:|token=/);
  return result;
}

test("the existing instantaneous strict press refuses a synthetic entrance frame; the new driver waits before its one insertion/click", async () => {
  const source = readFileSync(new URL("../scripts/check-analytics-journeys.mjs", import.meta.url), "utf8");
  const unchangedPress = source.slice(source.indexOf("  async function press("), source.indexOf("  const clickText ="));
  const h = harness({ animationReads: 2 });
  const press = vm.runInNewContext(`(${unchangedPress.trim()})`, { ...h.globals, page: h.page, vp: { name: "synthetic" },
    norm: "(s) => (s || '').replace(/\\s+/g, ' ').trim()", sleep: async () => {}, realClicks: 0, fallbacks: new Set() });
  assert.equal(await press('[role="dialog"] form button[type="submit"]', "Email me a link", { strict: true }), false);
  assert.equal(h.trace.filter(([kind]) => kind === "click").length, 0);
  const result = await run(h);
  assert.equal(result.ok, true); assert.equal(result.probes.field, 3);
  assert.equal(result.typeAttempts, 1); assert.equal(result.clickAttempts, 1);
  assert.equal(h.trace.filter(([kind]) => kind === "type").length, 1);
  assert.equal(h.trace.filter(([kind]) => kind === "click").length, 1);
  assert.equal(result.cleanup, "released"); assert.equal(h.groups.size, 0);
});

test("already ready controls need one probe per phase and retain actual field focus before insertion", async () => {
  const h = harness(), result = await run(h);
  assert.equal(result.ok, true); assert.deepEqual(result.probes, { field: 1, submit: 1 });
  assert.ok(h.trace.findIndex(([kind]) => kind === "focus") < h.trace.findIndex(([kind]) => kind === "type"));
  assert.ok(h.trace.findIndex(([kind]) => kind === "type") < h.trace.findIndex(([kind]) => kind === "click"));
});

for (const [label, options, mutate, code] of [
  ["running ancestor animation", { animating: true }, () => {}, "animating"],
  ["offscreen target", { offscreen: true }, () => {}, "offscreen"],
  ["covered target", { covered: true }, () => {}, "covered"],
  ["disabled button", {}, (h) => { h.button.disabled = true; }, "disabled"],
  ["read-only field", {}, (h) => { h.field.readOnly = true; }, "disabled"],
  ["hidden ancestor", {}, (h) => { h.sheet.style.opacity = "0"; }, "hidden"],
  ["aria-hidden ancestor", {}, (h) => { h.sheet.attributes["aria-hidden"] = "TRUE"; }, "hidden"],
  ["inert ancestor", {}, (h) => { h.body.inert = true; }, "hidden"],
  ["missing field", {}, (h) => { h.document.fields = []; }, "missing_field"],
]) test(`permanent ${label} times out without typing or clicking`, async () => {
  const h = harness(options); mutate(h); const result = await run(h, { timeoutMs: 25 });
  assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.equal(result.code, code);
  assert.equal(result.typeAttempts, 0); assert.equal(result.clickAttempts, 0);
  assert.equal(h.trace.filter(([kind]) => kind === "type" || kind === "click").length, 0);
  assert.equal(result.cleanup, "released");
});

for (const [label, mutate, code] of [
  ["duplicate field", (h) => { h.document.fields = [h.field, h.field]; }, "ambiguous_field"],
  ["foreign form", (h) => { h.field.form = null; }, "unowned_form"],
  ["changed submit label", (h) => { h.button.textContent = PRIVATE; }, "submit_label_changed"],
  ["failed focus", null, "focus_failed"],
]) test(`${label} is rejected and never creates an action`, async () => {
  const h = harness({ focusFails: !mutate }); mutate?.(h); const result = await run(h);
  assert.equal(result.ok, false); assert.equal(result.code, code); assert.equal(result.clickAttempts, 0);
});

for (const [label, onType, code] of [
  ["node replacement", ({ field, document, node }) => { const other = node("replacement", field.parentElement); other.ownerDocument = document; document.fields = [other]; }, "identity_changed"],
  ["another modal", ({ sheet, document, node }) => { document.sheets.push(node("another-sheet", sheet.parentElement)); }, "sheet_changed"],
  ["changed input", ({ field }) => { field.value = PRIVATE; }, "input_changed"],
]) test(`${label} after insertion cannot substitute a submit target`, async () => {
  const h = harness({ onType }), result = await run(h);
  assert.equal(result.ok, false); assert.equal(result.typed, true); assert.equal(result.code, code);
  assert.equal(result.clickAttempts, 0); assert.equal(result.cleanup, "released");
});

test("a throwing protocol and an untrusted probe value expose fixed diagnostics only", async () => {
  for (const options of [{ throws: "Runtime.callFunctionOn" }, { invalidProbe: true }]) {
    const h = harness(options), result = await run(h);
    assert.equal(result.ok, false); assert.equal(result.clickAttempts, 0); assert.equal(result.cleanup, "released");
  }
});

test("held readiness is bounded, releases the remote group, and a late reply cannot start an action", async () => {
  const h = harness({ holds: "Runtime.callFunctionOn" }), result = await run(h, { timeoutMs: 25 });
  assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.equal(result.clickAttempts, 0);
  h.page.release({ result: { value: { state: "ready", code: "ready", x: 20, y: 20 } } });
  await Promise.resolve(); assert.equal(h.trace.filter(([kind]) => kind === "type" || kind === "click").length, 0);
  assert.equal(result.cleanup, "released");
});

test("held insertion records its uncertain outcome and cannot dispatch a submit", async () => {
  const h = harness({ holdType: true }), result = await run(h, { timeoutMs: 25 });
  assert.equal(result.ok, false); assert.equal(result.code, "input_outcome_unknown");
  assert.equal(result.typeAttempts, 1); assert.equal(result.typed, false); assert.equal(result.clickAttempts, 0);
  h.page.release(); await Promise.resolve(); assert.equal(h.trace.filter(([kind]) => kind === "click").length, 0);
});

test("lost or rejected click acknowledgement is failed with one attempt and no retry", async () => {
  for (const options of [{ holdClick: true }, { clickThrows: true }]) {
    const h = harness(options), result = await run(h, { timeoutMs: 25 });
    assert.equal(result.ok, false); assert.equal(result.code, "click_outcome_unknown");
    assert.equal(result.clickAttempts, 1); assert.equal(h.trace.filter(([kind]) => kind === "click").length, 1);
    h.page.release?.(); await Promise.resolve(); assert.equal(h.trace.filter(([kind]) => kind === "click").length, 1);
  }
});

test("remote cleanup failure is bounded and cannot be reported as a fully qualified operation", async () => {
  const h = harness({ holds: "Runtime.releaseObjectGroup" }), result = await run(h);
  assert.equal(result.clicked, true); assert.equal(result.ok, false); assert.equal(result.cleanup, "unconfirmed");
  assert.equal(result.clickAttempts, 1); h.page.release();
});

test("replacement while the entrance is pending cannot acquire the original field's authority", async () => {
  const h = harness({ animationReads: 2, onProbe(count, { field, document, node }) {
    if (count === 2) { const replacement = node("replacement", field.parentElement); replacement.ownerDocument = document; document.fields = [replacement]; }
  } });
  const result = await run(h);
  assert.equal(result.ok, false); assert.equal(result.code, "identity_changed");
  assert.equal(result.typeAttempts, 0); assert.equal(result.clickAttempts, 0); assert.equal(result.cleanup, "released");
});

test("a deadline between the loop condition and the next probe preserves only the actual prior observation", async () => {
  let armed = false, reads = 0;
  const h = harness({ offscreen: true });
  const result = await run(h, { clock: () => !armed ? 0 : (++reads === 1 ? 0 : 100), pause: async () => { armed = true; } });
  assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.equal(result.code, "offscreen");
  assert.deepEqual(result.lastReadiness, { field: "offscreen", submit: null });
  assert.equal(h.trace.filter(([kind, method]) => kind === "send" && method === "Runtime.callFunctionOn").length, 1);
  assert.equal(result.typeAttempts, 0); assert.equal(result.clickAttempts, 0);
});

test("a deadline before the first observation does not invent a readiness diagnosis", async () => {
  let time = 0;
  const h = harness(), send = h.page.send;
  h.page.send = async (method, params) => { const value = await send(method, params); if (method === "Runtime.evaluate") time = 100; return value; };
  const result = await run(h, { clock: () => time });
  assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.equal(result.code, "deadline_before_observation");
  assert.deepEqual(result.lastReadiness, { field: null, submit: null }); assert.equal(result.clickAttempts, 0);
});

test("a real protocol error stays distinct from a deadline even after an earlier readiness observation", async () => {
  let time = 0;
  const h = harness({ offscreen: true, onProbe(count) { if (count === 2) { time = 100; throw new Error(PRIVATE); } } });
  const result = await run(h, { clock: () => time, pause: async (ms) => { time += ms; } });
  assert.equal(result.ok, false); assert.equal(result.timedOut, false); assert.equal(result.code, "protocol_unavailable");
  assert.deepEqual(result.lastReadiness, { field: "offscreen", submit: null }); assert.equal(result.clickAttempts, 0);
});
