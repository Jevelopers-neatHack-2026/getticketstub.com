import assert from "node:assert/strict";
import { test } from "node:test";
import "./analytics-hooks.mjs";
const { uniqueFacts, normalizeStubFacts } = await import("../src/customer/studio/facts/identity.ts");
const { newStub, PALE_HOURS } = await import("../src/customer/studio/fixtures.ts");
const { toggleKept, toggleProjectFact } = await import("../src/customer/studio/editor/ops.ts");
const { activeCorrection, entries } = await import("../src/customer/studio/facts/corrections.ts");
const { loadWall, writeWall } = await import("../src/customer/studio/store.ts");
const { foldWall } = await import("../src/customer/account/sync.ts");

const fact = (id, label, kept = false) => ({ id, label, value: label, source: "fixture", confidence: .9, provenance: "simulated", kept });
const stub = (facts) => ({ ...newStub(structuredClone(PALE_HOURS), "identity-fixture"), event: { ...PALE_HOURS, facts } });

test("batch identities reserve existing IDs, repeated categories, missing IDs and future suffixes", () => {
  const result = uniqueFacts([fact("note", "one"), fact("note", "two"), fact("note-2", "three"), fact("", "four"), fact("run", "five"), fact("run", "six")], [fact("note", "existing"), fact("run", "existing run")]);
  assert.equal(new Set(result.map((f) => f.id)).size, 6);
  assert.equal(result.some((f) => ["note", "run"].includes(f.id)), false);
  assert.equal(result[2].id, "note-2");
  assert.deepEqual(uniqueFacts(result), result);
  assert.deepEqual(uniqueFacts([...result].reverse()).map((f) => f.id), result.map((f) => f.id).reverse());
});

test("legacy collisions preserve every record, selection and hidden choice without assigning ambiguous history", () => {
  const original = stub([fact("note", "same text", true), fact("note", "same text", false), fact("date", "2026-10-10")]);
  original.personal.hiddenFields = ["note"];
  original.corrections = [{ id: "legacy-correction", factId: "note", kind: "correct", corrected: { value: "same text", label: "same text" }, original: { ...original.event.facts[0] } }];
  const bytes = JSON.stringify(original);
  const fixed = normalizeStubFacts(original);
  assert.equal(JSON.stringify(original), bytes);
  assert.deepEqual(fixed.event.facts.map((f) => f.kept), [true, false, false]);
  assert.deepEqual(fixed.event.facts.map((f) => f.id), ["note", "note-2", "date"]);
  assert.deepEqual(fixed.personal.hiddenFields, ["note", "note-2"]);
  assert.equal(entries(fixed).length, 1);
  assert.equal(entries(fixed, "note").length, 0);
  assert.equal(activeCorrection(fixed, "note"), undefined);
  assert.equal(fixed.corrections[0].unresolvedIdentity, true);
  assert.equal(normalizeStubFacts(fixed), fixed);
});

test("one action changes one fact, uses current state, and refuses stale, ambiguous or foreign targets", () => {
  const initial = normalizeStubFacts(stub([fact("note", "same"), fact("note", "same")]));
  const first = toggleProjectFact(initial, initial.id, "note");
  const both = toggleProjectFact(first, initial.id, "note-2");
  assert.deepEqual(both.event.facts.map((f) => f.kept), [true, true]);
  const twice = toggleProjectFact(both, initial.id, "note");
  assert.deepEqual(twice.event.facts.map((f) => f.kept), [false, true]);
  assert.equal(toggleProjectFact(twice, "another-project", "note"), twice);
  assert.equal(toggleKept(twice, "missing"), twice);
  const ambiguous = stub([fact("note", "one"), fact("note", "two")]);
  assert.equal(toggleKept(ambiguous, "note"), ambiguous);
});

test("normalization and independent choices survive persisted reload and account fold", () => {
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  const fixed = toggleKept(normalizeStubFacts(stub([fact("note", "one"), fact("note", "two")])), "note-2");
  assert.equal(writeWall([fixed]), true);
  const restored = loadWall()[0];
  assert.deepEqual(restored.event.facts, fixed.event.facts);
  const merged = foldWall([restored], [{ ...restored, updatedAt: 1 }], [], 2);
  assert.equal(writeWall(merged), true);
  assert.deepEqual(loadWall()[0].event.facts.map((f) => [f.id, f.kept]), [["note", false], ["note-2", true]]);
});
