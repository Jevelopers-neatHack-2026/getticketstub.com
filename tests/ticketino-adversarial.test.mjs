// Independently constructed adversarial inputs. These are not recordings of provider pages.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import "./analytics-hooks.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { parseTicketinoUrl, ticketinoEvent } = await import("../src/customer/studio/research/ticketino.ts");
const { findJsonLdEvents } = await import("../src/customer/studio/research/jsonLd.ts");
const { fetchPublic, setTransport } = await import("../src/server/intake-url.ts");
const link = parseTicketinoUrl("https://www.ticketino.com/de/Event/fixture/217466");
const node = {
  "@type": "Event", name: "Independent synthetic event", startDate: "2026-10-15T18:00",
  url: "https://www.ticketino.com/en/Event/other-slug/217466",
};
const script = (value = node, type = "application/ld+json") => `<script type="${type}">${JSON.stringify(value)}</script>`;
afterEach(() => setTransport());

test("commented-out event JSON-LD cannot make an inactive page into an event", () => {
  assert.deepEqual(findJsonLdEvents(`<!doctype html><!-- ${script()} --><title>Tickets unavailable</title>`), []);
  assert.deepEqual(findJsonLdEvents(`<!-- ${script()} -->${script({ ...node, name: "Visible event" })}`).map((event) => event.name), ["Visible event"]);
});

test("text inside another attribute cannot masquerade as the script's MIME type", () => {
  assert.deepEqual(findJsonLdEvents(`<script data-description=' type="application/ld+json"'>${JSON.stringify(node)}</script>`), []);
  assert.deepEqual(findJsonLdEvents(`<script data-description='example > text' type='text/javascript'>${JSON.stringify(node)}</script>`), []);
  assert.equal(findJsonLdEvents(`<script data-description='example > text' type='application/ld&#43;json'>${JSON.stringify(node)}</script>`).length, 1);
});

test("quoted and unquoted entity-encoded MIME values identify actual event scripts", () => {
  for (const attribute of [
    'type="application/ld&#x2b;json"', "type='application/ld&#43;json'",
    "TYPE = application/ld&#x2B;json", 'type="APPLICATION/LD+JSON"',
  ]) assert.equal(findJsonLdEvents(`<script ${attribute}>${JSON.stringify(node)}</script>`).length, 1, attribute);
});

test("invalid timestamps cannot be promoted to a dated TICKETINO event", () => {
  for (const startDate of [
    "2026-10-15T99:99", "2026-10-15T23:60", "2026-10-15T18:00garbage",
    "2026-10-15T18:00+25:00", "2026-10-15T18:00:99", "2026-02-29T18:00",
    "2026-10-15T18:00Zjunk", "2026-10-15T18:00:00.1.2Z",
  ]) assert.equal(ticketinoEvent([{ ...node, startDate }], link), undefined, startDate);
});

test("valid local calendar dates stay local across offsets and leap days", () => {
  for (const [startDate, expected] of [
    ["2026-10-15", "2026-10-15"], ["2026-10-15T00:30+14:00", "2026-10-15"],
    ["2026-10-15T23:30-12:00", "2026-10-15"], ["2028-02-29T18:00:00.123Z", "2028-02-29"],
  ]) assert.equal(ticketinoEvent([{ ...node, startDate }], link)?.dateISO, expected, startDate);
});

test("event identity stays textual for large ids and excludes path/query lookalikes", () => {
  const largeId = "900719925474099312345";
  assert.equal(parseTicketinoUrl(`ticketino.com/it/Event/title/${largeId}`).id, largeId);
  assert.equal(parseTicketinoUrl(`ticketino.com/fr/Event/title/${largeId}`).canonicalId, `ticketino:event:${largeId}`);
  for (const path of [
    "/de/Event/title/217466x", "/de/Event/title/0217466", "/de/Event/title/217466/extra",
    "/de/EventGroup/title/217466", "/de/Genre/title/217466", "/de/Event/title%00/217466",
  ]) assert.equal(parseTicketinoUrl(`https://ticketino.com${path}`)?.kind, "not_event", path);
  for (const host of ["ticketino.com.evil.example", "evil.ticketino.com", "ticketino.ch", "ticketino.de", "ticketino.at"]) {
    assert.equal(parseTicketinoUrl(`https://${host}/de/Event/title/217466`), undefined, host);
  }
});

test("multiple event candidates and mismatched explicit event identities never select an arbitrary stub", () => {
  assert.equal(ticketinoEvent([node, node], link), undefined);
  assert.equal(ticketinoEvent([node, { ...node, name: "Other", url: "https://ticketino.com/de/Event/other/42" }], link), undefined);
  for (const url of ["https://ticketino.com/de/Event/other/42", "https://other.example/event/217466", "https://ticketino.com/de/EventGroup/group/217466"]) {
    assert.equal(ticketinoEvent([{ ...node, url }], link), undefined, url);
  }
});

test("same event may change language and slug, but a later catalogue redirect stops before transport", async () => {
  const requests = [];
  const destinations = [
    "https://ticketino.com/fr/Event/nouveau/217466",
    "https://www.ticketino.com/fr/Genre/catalogue/217466",
  ];
  setTransport(async (url) => {
    requests.push(url.href);
    const location = destinations[requests.length - 1];
    assert.ok(location, "a refused destination must not reach transport");
    return new Response("redirect body", { status: 307, headers: { location } });
  });
  await assert.rejects(fetchPublic(link.url, {}, (url) => {
    const next = parseTicketinoUrl(url);
    return next?.kind === "event" && next.id === link.id;
  }), (error) => error.reason === "blocked_destination");
  assert.deepEqual(requests, [link.url, destinations[0]]);
});
