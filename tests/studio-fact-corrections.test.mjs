import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// GT-05 date corrections: only real calendar dates are accepted, and a refused answer changes nothing.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL) {
      for (const ext of [".ts", ".tsx"]) {
        const url = new URL(`${specifier}${ext}`, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const { applyCorrection, undoCorrection, isIsoDate } = await import("../src/customer/studio/facts/corrections.ts");
const NOW = new Date("2026-10-11T12:00:00Z");

function stub() {
  return {
    id: "s1",
    event: {
      title: "Show", venue: "Hall", dateISO: "2026-03-14",
      facts: [{ id: "date", label: "14 Mar", value: "2026-03-14", source: "event page", confidence: 0.4, provenance: "live" }],
    },
  };
}

test("isIsoDate accepts real dates and rejects impossible ones, leap years included", () => {
  for (const ok of ["2026-01-31", "2026-02-28", "2024-02-29", "2000-02-29", "2026-04-30", "2026-12-31"]) assert.equal(isIsoDate(ok), true, ok);
  for (const bad of ["2026-02-31", "2026-02-29", "2100-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-1-5", "26-01-01", "2026-01-01T00:00", "", "not a date"]) assert.equal(isIsoDate(bad), false, bad);
});

test("an impossible date leaves the stub, fact, event and history unchanged", () => {
  const s = stub();
  const before = JSON.stringify(s);
  for (const bad of ["2026-02-31", "2026-02-29", "2026-04-31", "2026-13-01", " 2026-02-31 "]) {
    assert.equal(applyCorrection(s, { factId: "date", value: bad, now: NOW }), s, bad);
  }
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.corrections, undefined);
});

test("a valid date, including 29 February in a leap year, is recorded and shown", () => {
  const out = applyCorrection(stub(), { factId: "date", value: "2024-02-29", now: NOW });
  assert.equal(out.event.dateISO, "2024-02-29");
  const fact = out.event.facts[0];
  assert.equal(fact.value, "2024-02-29");
  assert.equal(fact.label, "29 Feb");
  assert.equal(fact.confidence, 1);
  assert.equal(out.corrections.length, 1);
  assert.equal(out.corrections[0].corrected.value, "2024-02-29");
  assert.equal(out.corrections[0].original.value, "2026-03-14");
});

test("a month-end date is not shifted by timezone normalisation", () => {
  const out = applyCorrection(stub(), { factId: "date", value: "2026-12-31", now: NOW });
  assert.equal(out.event.dateISO, "2026-12-31");
  assert.equal(out.event.facts[0].label, "31 Dec");
});

test("a refused date after a valid one keeps the earlier history byte-identical and undo still works", () => {
  const first = applyCorrection(stub(), { factId: "date", value: "2026-03-15", now: NOW });
  const snapshot = JSON.stringify(first);
  const again = applyCorrection(first, { factId: "date", value: "2026-02-30", now: NOW });
  assert.equal(again, first);
  assert.equal(JSON.stringify(first), snapshot);
  const undone = undoCorrection(again, "date", new Date("2026-10-11T12:01:00Z"));
  assert.equal(undone.event.dateISO, "2026-03-14");
  assert.equal(undone.corrections.length, 2);
});

test("other facts are not affected by the date check", () => {
  const out = applyCorrection(stub(), { factId: "venue", value: "2026-02-31", now: NOW });
  assert.equal(out.event.venue, "2026-02-31");
});

test("undo of a newly supplied missing date clears the printed date and preserves prior history", () => {
  const original = stub();
  original.event.facts = [];
  delete original.event.dateISO;
  const originalBytes = JSON.stringify(original);
  const corrected = applyCorrection(original, { factId: "date", value: "2026-05-19", now: NOW });
  const historyBytes = JSON.stringify(corrected.corrections);
  const undone = undoCorrection(corrected, "date", new Date("2026-10-11T12:01:00Z"));
  assert.equal(undone.event.facts[0].value, "");
  assert.equal(Object.hasOwn(undone.event, "dateISO"), false);
  assert.equal(JSON.stringify(undone.corrections.slice(0, -1)), historyBytes);
  assert.equal(undone.corrections.at(-1).kind, "undo");
  assert.equal(JSON.stringify(original), originalBytes);
});

test("a date without a fact row retains its actual original value through correction and undo", () => {
  const original = stub();
  original.event.facts = [];
  const corrected = applyCorrection(original, { factId: "date", value: "2026-05-19", now: NOW });
  assert.equal(corrected.corrections[0].original.value, "2026-03-14");
  const undone = undoCorrection(corrected, "date", new Date("2026-10-11T12:01:00Z"));
  assert.equal(undone.event.dateISO, original.event.dateISO);
  assert.equal(undone.event.facts[0].value, original.event.dateISO);
});

test("successive undo restores the prior date then the missing original", () => {
  const original = stub();
  original.event.facts = [];
  delete original.event.dateISO;
  const first = applyCorrection(original, { factId: "date", value: "2026-05-19", now: NOW });
  const second = applyCorrection(first, { factId: "date", value: "2026-05-20", now: new Date("2026-10-11T12:01:00Z") });
  const secondBytes = JSON.stringify(second.corrections);
  const oneBack = undoCorrection(second, "date", new Date("2026-10-11T12:02:00Z"));
  assert.equal(oneBack.event.dateISO, "2026-05-19");
  assert.equal(JSON.stringify(oneBack.corrections.slice(0, 2)), secondBytes);
  const allBack = undoCorrection(oneBack, "date", new Date("2026-10-11T12:03:00Z"));
  assert.equal(Object.hasOwn(allBack.event, "dateISO"), false);
  assert.equal(allBack.event.facts[0].value, "");
  assert.equal(JSON.stringify(allBack.corrections.slice(0, 3)), JSON.stringify(oneBack.corrections));
});

test("a non-calendar date answer replaces a stale date projection and undo restores it", () => {
  const original = stub();
  const corrected = applyCorrection(original, { factId: "date", value: "Late spring", now: NOW });
  assert.equal(corrected.event.facts[0].value, "Late spring");
  assert.equal(Object.hasOwn(corrected.event, "dateISO"), false);
  const undone = undoCorrection(corrected, "date", new Date("2026-10-11T12:01:00Z"));
  assert.equal(undone.event.dateISO, original.event.dateISO);
  assert.equal(undone.event.facts[0].value, original.event.facts[0].value);
});

test("a venue without a fact row also retains its actual original value on undo", () => {
  const original = stub();
  const corrected = applyCorrection(original, { factId: "venue", value: "Another hall", now: NOW });
  assert.equal(corrected.corrections[0].original.value, original.event.venue);
  const undone = undoCorrection(corrected, "venue", new Date("2026-10-11T12:01:00Z"));
  assert.equal(undone.event.venue, original.event.venue);
  assert.equal(undone.event.dateISO, original.event.dateISO);
  assert.deepEqual(undone.event.facts[0], original.event.facts[0]);
});
