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
