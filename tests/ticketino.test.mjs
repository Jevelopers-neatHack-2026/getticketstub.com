import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    if (specifier.startsWith('@/')) {
      const file = fileURLToPath(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url));
      if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
    return nextLoad(url, context);
  },
});
const scratch = mkdtempSync(join(tmpdir(), 'ticketstub-ticketino-'));
process.env.TICKETSTUB_DB = join(scratch, 'test.sqlite');
process.env.TICKETSTUB_FILES = join(scratch, 'files');
process.env.TICKETSTUB_RUNTIME_MODE = 'live';
process.env.TICKETSTUB_RESEARCH_PROVIDER = 'anthropic';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.TICKETMASTER_API_KEY;
const { parseTicketinoUrl, ticketinoEvent } = await import('../src/customer/studio/research/ticketino.ts');
const { findJsonLdEvents } = await import('../src/customer/studio/research/jsonLd.ts');
const { POST } = await import('../src/app/api/research/route.ts');
const { setTransport, INTAKE_LIMITS } = await import('../src/server/intake-url.ts');
const fixture = (name) => readFileSync(new URL(`../fixtures/research/ticketino/${name}.synthetic.html`, import.meta.url), 'utf8');
const oldFetch = globalThis.fetch;
const request = (url) => new Request('http://localhost/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
let pageCalls;
beforeEach(() => {
  pageCalls = [];
  process.env.TICKETSTUB_RUNTIME_MODE = 'live';
  setTransport(async (url) => { pageCalls.push(url.href); throw new Error('Unexpected page request'); });
  globalThis.fetch = async (url) => {
    // Weather lookups are harmless mocked misses. No real fetch is ever permitted.
    assert.match(String(url), /^https:\/\/(?:customer-)?geocoding-api\.open-meteo\.com\//);
    return Response.json({ results: [] });
  };
});
afterEach(() => { globalThis.fetch = oldFetch; });

test('exact hosts and all language prefixes normalize numeric identity and strip tracking', () => {
  for (const host of ['ticketino.com', 'www.ticketino.com', 'WWW.TICKETINO.COM']) for (const lang of ['de', 'en', 'fr', 'it']) {
    const link = parseTicketinoUrl(`https://${host}/${lang}/Event/old-slug/217466/?token=private#fragment`);
    assert.equal(link.kind, 'event'); assert.equal(link.id, '217466');
    assert.equal(link.canonicalId, 'ticketino:event:217466');
    assert.equal(link.url, `https://www.ticketino.com/${lang}/Event/old-slug/217466`);
    assert.equal(parseTicketinoUrl(`ticketino.com/${lang}/Event/new-slug/217466`).canonicalId, link.canonicalId);
  }
});
test('groups, genres, unsupported language and malformed paths are not events', () => {
  for (const path of ['/', '/de', '/de/EventGroup/a/1', '/en/Genre/Musik/1', '/de/Event/a/no', '/de/Event/a/0', '/es/Event/a/1', '/de/Event/a/1/extra', '/de/Event/a%2Fb/1']) {
    assert.equal(parseTicketinoUrl(`https://www.ticketino.com${path}`)?.kind, 'not_event', path);
  }
});
test('unverified TLDs, lookalikes, private credentials and unsupported ports are not recognized', () => {
  for (const url of ['https://ticketino.ch/de/Event/a/1', 'https://ticketino.de/de/Event/a/1', 'https://ticketino.at/de/Event/a/1', 'https://ticketino.com.evil.example/de/Event/a/1', 'https://notticketino.com/de/Event/a/1', 'https://events.ticketino.com/de/Event/a/1', 'https://u:p@ticketino.com/de/Event/a/1', 'ftp://ticketino.com/de/Event/a/1', 'https://ticketino.com:8443/de/Event/a/1']) assert.equal(parseTicketinoUrl(url), undefined, url);
});
for (const [name, id, title, date, venue, city, country] of [
  ['ch', '217466', 'Zurich Wine Festival 2026', '2026-10-15', 'Papiersaal Zürich', 'Zurich', 'CH'],
  ['de', '217797', 'German event fixture', '2026-12-01', 'Synthetic German Hall', 'Kempten', 'DE'],
  ['at', '214753', 'Austrian event fixture', '2027-02-01', 'Synthetic Austrian Hall', 'Dornbirn', 'AT'],
]) test(`synthetic ${country} fixture maps local dates, venue and country through the route`, async () => {
  setTransport(async (url) => { pageCalls.push(url.href); return new Response(fixture(name)); });
  const response = await POST(request(`https://ticketino.com/fr/Event/different-slug/${id}?token=private`));
  assert.equal(response.status, 200);
  const event = await response.json();
  assert.equal(event.title, title); assert.equal(event.dateISO, date); assert.equal(event.venue, venue); assert.equal(event.city, city);
  assert.equal(event.facts.find((f) => f.id === 'country').value, country);
  assert.ok(event.facts.filter((f) => f.id !== 'weather').every((f) => f.source === 'TICKETINO' && f.provenance === 'live'));
  assert.deepEqual(pageCalls, [`https://www.ticketino.com/fr/Event/different-slug/${id}`]);
  assert.ok(!JSON.stringify(event).includes('private'));
  if (country === 'CH') assert.equal(event.facts.find((f) => f.id === 'date_range').value, '2026-10-15 – 2026-10-18');
});
test('entity-encoded MIME also works on the generic page path', async () => {
  setTransport(async () => new Response(fixture('ch')));
  const response = await POST(request('https://example.com/event'));
  const event = await response.json();
  assert.equal(response.status, 200); assert.equal(event.dateISO, '2026-10-15'); assert.equal(event.venue, 'Papiersaal Zürich');
  assert.equal(event.facts.find((f) => f.id === 'date').source, 'event page (schema.org)');
});
test('script type is decoded; unrelated attributes and malformed JSON are ignored', () => {
  const node = '{"@type":"Event","name":"Example"}';
  for (const type of ['application/ld+json', 'application/ld&#43;json', 'application/ld&#x2B;json']) assert.equal(findJsonLdEvents(`<script TYPE = '${type}'>${node}</script>`).length, 1);
  assert.equal(findJsonLdEvents(`<script data-type="application/ld+json">${node}</script>`).length, 0);
  assert.equal(findJsonLdEvents('<script type="application/ld&#43;json">{oops}</script>').length, 0);
});
for (const [name, path] of [['event-group', '/de/EventGroup/Schneewittchen/1'], ['genre', '/de/Genre/Musik/1']]) test(`synthetic ${name} is refused before fetching`, async () => {
  setTransport(async (url) => { pageCalls.push(url.href); return new Response(fixture(name)); });
  const response = await POST(request(`https://www.ticketino.com${path}`));
  assert.equal(response.status, 422); assert.equal((await response.json()).error.code, 'unsupported_url'); assert.equal(pageCalls.length, 0);
});
test('missing, malformed, multiple, undated and wrong-identity event data never becomes a title-only stub', async () => {
  const base = findJsonLdEvents(fixture('ch'))[0];
  const wrong = { ...base, url: 'https://www.ticketino.com/de/Event/other/42' };
  const badDate = { ...base, startDate: '2026-02-30T00:30' };
  for (const html of ['<title>Catalogue</title>', '<script type="application/ld+json">oops</script>', `<script type="application/ld+json">${JSON.stringify([base, base])}</script>`, ...[{ ...base, startDate: undefined }, wrong, badDate].map((x) => `<script type="application/ld+json">${JSON.stringify(x)}</script>`)]) {
    setTransport(async () => new Response(html));
    const response = await POST(request('https://ticketino.com/de/Event/example/217466'));
    assert.equal(response.status, 422); assert.equal((await response.json()).error.code, 'unreadable_link');
  }
});
test('scoped redirects reject another event, host or catalogue before requesting it', async () => {
  for (const destination of ['/de/EventGroup/a/217466', '/de/Event/a/42', 'https://example.com/event', 'http://127.0.0.1/private']) {
    pageCalls = [];
    setTransport(async (url) => { pageCalls.push(url.href); return new Response(null, { status: 302, headers: { location: destination } }); });
    const response = await POST(request('https://ticketino.com/de/Event/example/217466'));
    assert.equal(response.status, 422); assert.equal((await response.json()).error.code, 'unsupported_url'); assert.equal(pageCalls.length, 1);
  }
});
test('same-id slug redirect is allowed within unchanged safe hop limits', async () => {
  assert.equal(INTAKE_LIMITS.redirects, 3);
  setTransport(async (url) => {
    pageCalls.push(url.href);
    return pageCalls.length === 1 ? new Response(null, { status: 302, headers: { location: '/de/Event/canonical-slug/217466' } }) : new Response(fixture('ch'));
  });
  const response = await POST(request('https://ticketino.com/de/Event/old-slug/217466'));
  assert.equal(response.status, 200); assert.equal(pageCalls.length, 2);
});
test('demo mode keeps the demo-only result and performs no page fetch', async () => {
  process.env.TICKETSTUB_RUNTIME_MODE = 'demo';
  const response = await POST(request('https://ticketino.com/de/Event/example/217466'));
  assert.equal((await response.json()).error.code, 'demo_only'); assert.equal(pageCalls.length, 0);
});
test('a negative end-date range is not emitted', () => {
  const base = findJsonLdEvents(fixture('ch'))[0];
  const event = ticketinoEvent([{ ...base, endDate: '2026-10-14T12:00' }], parseTicketinoUrl('https://ticketino.com/de/Event/a/217466'));
  assert.ok(!event.facts.some((f) => f.id === 'date_range'));
});

test('declared identities must agree on the numeric event, including @id', () => {
  const base = findJsonLdEvents(fixture('ch'))[0];
  const link = parseTicketinoUrl('https://ticketino.com/fr/Event/example/217466');
  for (const node of [
    { ...base, '@id': 'https://www.ticketino.com/de/Event/other/42' },
    { ...base, url: 'https://www.ticketino.com/de/Event/other/42', '@id': '#event' },
    { ...base, '@id': 'https://evil.example/de/Event/example/217466' },
    { ...base, '@id': { malformed: true } },
  ]) assert.equal(ticketinoEvent([node], link), undefined);
  for (const identity of ['#event', 'https://ticketino.com/en/Event/new-slug/217466#event']) {
    assert.equal(ticketinoEvent([{ ...base, '@id': identity }], link).title, base.name);
  }
});
test('multiple declared locations require a choice instead of silently selecting the first', () => {
  const base = findJsonLdEvents(fixture('ch'))[0];
  const link = parseTicketinoUrl('https://ticketino.com/de/Event/example/217466');
  assert.equal(ticketinoEvent([{ ...base, location: [base.location, { '@type': 'Place', name: 'Another hall' }] }], link), undefined);
});
test('full schema.org event IRIs map through the same typed adapter', () => {
  const base = findJsonLdEvents(fixture('ch'))[0];
  const link = parseTicketinoUrl('https://ticketino.com/de/Event/example/217466');
  for (const prefix of ['http://schema.org/', 'https://schema.org/']) {
    const nodes = findJsonLdEvents(`<script type="application/ld&#43;json">${JSON.stringify({ ...base, '@type': `${prefix}MusicEvent` })}</script>`);
    assert.equal(nodes.length, 1); assert.equal(ticketinoEvent(nodes, link).type, 'concert');
  }
});
