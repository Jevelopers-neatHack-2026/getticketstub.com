import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The stub, server-rendered for every edition: live Open-Meteo weather carries its CC BY credit wherever it shows (#48).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".module.css")) return { url: "data:text/javascript,export default new Proxy({},{get:(_,k)=>String(k)})", shortCircuit: true };
    if (specifier.startsWith("@/")) {
      for (const ext of [".ts", ".tsx"]) {
        const url = new URL(`../src/${specifier.slice(2)}${ext}`, import.meta.url);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    if (specifier.startsWith(".") && context.parentURL) {
      for (const ext of [".ts", ".tsx"]) {
        const url = new URL(`${specifier}${ext}`, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts") || url.endsWith(".tsx")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { StubView } = await import("../src/customer/studio/stub/StubView.tsx");
const { newStub } = await import("../src/customer/studio/fixtures.ts");
const { EDITIONS } = await import("../src/customer/studio/types.ts");

const CREDIT = "Weather data by Open-Meteo.com";
const weather = (over = {}) => ({ id: "weather", label: "17°C · rain", value: "17.4°C max, 4 mm rain in Berlin", source: "Open-Meteo.com · place: GeoNames", sourceUrl: "https://open-meteo.com/", confidence: 0.9, provenance: "live", kept: true, ...over });
// A concert with a setlist: its back shows the setlist, not the facts, so only the front can carry weather.
const event = (facts, extra = {}) => ({ type: "concert", setlist: [{ title: "Opener" }], title: "Gig", dateISO: "2026-10-08", city: "Berlin", venue: "Hall", facts, ...extra });
const render = (ev, edition, flipped = false) => {
  const stub = newStub(ev, "credit");
  stub.versions[0].edition = edition;
  return renderToStaticMarkup(createElement(StubView, { stub, flipped }));
};
const count = (html) => html.split(CREDIT).length - 1;

test("every edition prints the credit right after the kept live weather on the front", () => {
  for (const edition of EDITIONS) {
    const html = render(event([weather()]), edition);
    assert.equal(count(html), 1, edition);
    // The hidden description names the facts first; the fact line is the last mention, and the credit follows it.
    const line = Math.max(html.lastIndexOf("17°C · rain"), html.lastIndexOf("17°C · RAIN"));
    assert.ok(line > html.indexOf("Facts on the stub"), `${edition}: found the fact line, not the description`);
    assert.ok(html.indexOf(CREDIT) > line, `${edition}: credit sits under the weather`);
  }
});

test("an unsure live weather chip also carries the credit", () => {
  assert.equal(count(render(event([weather({ confidence: 0.75, kept: false })]), "researched")), 1);
});

test("no credit without Open-Meteo weather on the stub: simulated, pending, hidden, or not kept", () => {
  for (const ev of [
    event([weather({ provenance: "simulated", source: "Open-Meteo" })]),
    event([weather({ provenance: "pending", label: "Weather: pending", confidence: 0.2, kept: false })]),
    event([weather({ kept: false })]),
    event([{ id: "venue", label: "Hall", value: "Hall", source: "event page", confidence: 0.9, provenance: "live", kept: true }]),
  ]) assert.equal(count(render(ev, "researched")), 0, JSON.stringify(ev.facts));
  const hidden = newStub(event([weather()]), "hidden");
  hidden.personal.hiddenFields = ["weather"];
  assert.equal(count(renderToStaticMarkup(createElement(StubView, { stub: hidden }))), 0);
});

test("a weather value the person corrected is not credited to Open-Meteo; a confirmation still is", async () => {
  const { applyCorrection, undoCorrection } = await import("../src/customer/studio/facts/corrections.ts");
  const stub = newStub(event([weather()]), "corrected");
  const show = (st) => count(renderToStaticMarkup(createElement(StubView, { stub: st })));
  const corrected = applyCorrection(stub, { factId: "weather", value: "Sunny, 25°C", now: new Date("2026-10-11T12:00:00Z") });
  assert.equal(show(corrected), 0);
  assert.equal(show(undoCorrection(corrected, "weather", new Date("2026-10-11T12:01:00Z"))), 1);
  assert.equal(show(applyCorrection(stub, { factId: "weather", value: weather().value })), 1);
});

test("the back's fact list credits the weather it lists, and not a programme", () => {
  const generic = { type: "generic", setlist: undefined };
  assert.equal(count(render(event([weather({ kept: false })], generic), "researched", true)), 1); // listed on the back only
  assert.equal(count(render(event([weather()], generic), "researched", true)), 2); // and on the front once kept
  assert.equal(count(render(event([weather({ kept: false })], { ...generic, programme: ["Doors", "Encore"] }), "researched", true)), 0);
  // A full list gives up its last row to the credit instead of clipping it (portrait cap 9).
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, label: `Fact ${i}`, value: `Fact ${i}`, source: "event page", confidence: 0.9, provenance: "live" }));
  const html = render(event([weather({ kept: false }), ...many], generic), "researched", true);
  assert.equal(count(html), 1);
  assert.ok(html.includes("Fact 6") && !html.includes("Fact 7"), "eight facts plus the credit");
  // Weather that would take the last row, with no room for its credit, stays off the back.
  const last = render(event([...many.slice(0, 8), weather({ kept: false })], generic), "researched", true);
  assert.equal(count(last), 0);
  assert.ok(!last.includes("17°C · rain") && last.includes("Fact 7"), "eight facts, no uncredited weather");
});
