import assert from "node:assert/strict";
import { test } from "node:test";
import "./analytics-hooks.mjs";
import { captureFocusHandoff } from "../src/customer/studio/generation/focus-handoff.ts";

// Deterministic DOM protocol controls of the actual helper. These do not claim native browser/AT behavior.
class DocumentFixture {
  listeners = new Map();
  defaultView = { getComputedStyle: (element) => element.computed };
  constructor() { this.body = new ElementFixture(this); this.activeElement = this.body; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, target) { for (const callback of [...this.listeners.get(type) ?? []]) callback({ type, target }); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
}
class ElementFixture {
  isConnected = true; disabled = false; unavailable = false; blockedAncestor = false;
  parentElement = null; rect = { width: 140, height: 44 };
  computed = { display: "block", visibility: "visible", opacity: "1" };
  focusCalls = []; refuseFocus = false;
  constructor(doc) { this.ownerDocument = doc; }
  matches(selector) { return this.disabled || (selector.includes("aria-disabled") && this.unavailable); }
  closest() { return this.blockedAncestor ? this : null; }
  getBoundingClientRect() { return this.rect; }
  focus(options) {
    this.focusCalls.push(options);
    if (!this.refuseFocus) {
      this.ownerDocument.activeElement = this;
      this.ownerDocument.emit("focusin", this);
    }
  }
}
function fixture() {
  const doc = new DocumentFixture(), origin = new ElementFixture(doc), target = new ElementFixture(doc);
  doc.activeElement = origin;
  return { doc, origin, target };
}
function capture(f) {
  const intent = captureFocusHandoff(f.origin);
  assert.ok(intent); assert.equal(f.doc.listenerCount(), 3);
  return intent;
}
function lost(f, kind = "disabled") {
  if (kind === "removed") f.origin.isConnected = false;
  else f.origin.disabled = true;
  // Browser control removal/disablement can fall back to BODY without a new focusin event.
  f.doc.activeElement = f.doc.body;
}
function noMove(f, intent) {
  const previous = f.doc.activeElement;
  assert.equal(intent.finish(f.target), false);
  assert.equal(f.doc.activeElement, previous); assert.equal(f.target.focusCalls.length, 0);
  assert.equal(f.doc.listenerCount(), 0);
}

for (const kind of ["disabled", "removed"]) test(`${kind} focused control hands focus to the succeeding action once`, () => {
  const f = fixture(), intent = capture(f); lost(f, kind);
  assert.equal(intent.finish(f.target), true); assert.equal(f.doc.activeElement, f.target);
  assert.deepEqual(f.target.focusCalls, [{ preventScroll: true }]); assert.equal(f.doc.listenerCount(), 0);
  assert.equal(intent.finish(f.target), false); assert.equal(f.target.focusCalls.length, 1);
});
test("a disabled control that retains native focus can hand off locally", () => {
  const f = fixture(), intent = capture(f); f.origin.disabled = true;
  assert.equal(intent.finish(f.target), true); assert.equal(f.doc.activeElement, f.target); assert.equal(f.doc.listenerCount(), 0);
});
test("a still-usable initiating control keeps its focus", () => { const f = fixture(); noMove(f, capture(f)); });
test("capture refuses unfocused, disconnected, disabled and absent origins without listeners", () => {
  for (const kind of ["unfocused", "disconnected", "disabled", "absent"]) {
    const f = fixture();
    if (kind === "unfocused") f.doc.activeElement = f.doc.body;
    if (kind === "disconnected") f.origin.isConnected = false;
    if (kind === "disabled") f.origin.disabled = true;
    assert.equal(captureFocusHandoff(kind === "absent" ? null : f.origin), null); assert.equal(f.doc.listenerCount(), 0);
  }
});
test("intentional later focus is preserved even without a focusin observation", () => {
  const f = fixture(), intent = capture(f); lost(f); f.doc.activeElement = new ElementFixture(f.doc); noMove(f, intent);
});
for (const kind of ["focusin-other", "focusin-body", "pointerdown", "keydown"]) test(`later ${kind} cancels even if focus subsequently returns to BODY`, () => {
  const f = fixture(), intent = capture(f);
  f.doc.emit(kind.startsWith("focusin") ? "focusin" : kind, kind === "focusin-other" ? new ElementFixture(f.doc) : f.doc.body);
  assert.equal(f.doc.listenerCount(), 0); lost(f); noMove(f, intent);
});
test("a redundant focusin on the original control does not invent user movement", () => {
  const f = fixture(), intent = capture(f); f.doc.emit("focusin", f.origin); lost(f);
  assert.equal(intent.finish(f.target), true); assert.equal(f.doc.listenerCount(), 0);
});
for (const fault of ["disabled", "aria-disabled", "inert-or-hidden", "disconnected", "zero-width", "zero-height", "unknown-width", "infinite-height", "other-document", "no-view", "display-none", "visibility-hidden", "transparent", "transparent-ancestor"]) {
  test(`an unavailable ${fault} successor cannot take focus`, () => {
    const f = fixture(), intent = capture(f); lost(f);
    if (fault === "disabled") f.target.disabled = true;
    if (fault === "aria-disabled") f.target.unavailable = true;
    if (fault === "inert-or-hidden") f.target.blockedAncestor = true;
    if (fault === "disconnected") f.target.isConnected = false;
    if (fault === "zero-width") f.target.rect.width = 0;
    if (fault === "zero-height") f.target.rect.height = 0;
    if (fault === "unknown-width") f.target.rect.width = NaN;
    if (fault === "infinite-height") f.target.rect.height = Infinity;
    if (fault === "other-document") f.target.ownerDocument = new DocumentFixture();
    if (fault === "no-view") f.doc.defaultView = null;
    if (fault === "display-none") f.target.computed.display = "none";
    if (fault === "visibility-hidden") f.target.computed.visibility = "hidden";
    if (fault === "transparent") f.target.computed.opacity = "0";
    if (fault === "transparent-ancestor") { f.target.parentElement = new ElementFixture(f.doc); f.target.parentElement.computed.opacity = "0"; }
    noMove(f, intent);
  });
}
test("adopting the origin into another document invalidates the handoff", () => {
  const f = fixture(), intent = capture(f); lost(f); f.origin.ownerDocument = new DocumentFixture(); noMove(f, intent);
});
test("a missing successor still cleans up the one-use intent", () => {
  const f = fixture(), intent = capture(f); lost(f); assert.equal(intent.finish(null), false); assert.equal(f.doc.listenerCount(), 0);
});
test("an actual focus refusal is returned truthfully and never retried", () => {
  const f = fixture(), intent = capture(f); lost(f); f.target.refuseFocus = true;
  assert.equal(intent.finish(f.target), false); assert.equal(intent.finish(f.target), false);
  assert.equal(f.target.focusCalls.length, 1); assert.equal(f.doc.activeElement, f.doc.body); assert.equal(f.doc.listenerCount(), 0);
});
test("unmount/no-op cancellation releases every listener without a later move", () => {
  const f = fixture(), intent = capture(f); intent.cancel(); intent.cancel(); lost(f); noMove(f, intent);
});
