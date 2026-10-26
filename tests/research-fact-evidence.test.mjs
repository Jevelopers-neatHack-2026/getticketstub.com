import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
    if (url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const scratch = mkdtempSync(join(tmpdir(), 'ticketstub-evidence-'));
process.env.TICKETSTUB_DB = join(scratch, 'test.sqlite');
process.env.TICKETSTUB_FILES = join(scratch, 'files');
process.env.TICKETSTUB_RUNTIME_MODE = 'live';
process.env.TICKETSTUB_RESEARCH_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'offline-test-placeholder';
delete process.env.TICKETMASTER_API_KEY;
delete process.env.TICKETSTUB_OPS_TELEMETRY;
const { POST } = await import('../src/app/api/research/route.ts');
const { setTransport } = await import('../src/server/intake-url.ts');
const originalFetch = globalThis.fetch;
const sourceUrl = 'https://example.com/evidence-regression';
let pageCalls, providerCalls;

beforeEach(() => {
  pageCalls = providerCalls = 0;
  setTransport(async () => { throw new Error('Unexpected event-page request'); });
  globalThis.fetch = async () => { throw new Error('Unexpected upstream request'); };
});
afterEach(() => { globalThis.fetch = originalFetch; });

async function enrich(pageText, changes = {}) {
  const claim = { id: 'opener', label: 'Opener: Example Band', value: 'Example Band', evidence: 'Opener: Example Band.', confidence: 0.99, ...changes };
  setTransport(async (url) => {
    pageCalls++;
    assert.equal(url.href, sourceUrl);
    // Synthetic fixture: no personal data, rights-sensitive assets or live network.
    return new Response(`<script type="application/ld+json">{"@type":"MusicEvent","name":"Evidence regression"}</script><p>${pageText}</p>`);
  });
  globalThis.fetch = async (url, init) => {
    providerCalls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.match(JSON.parse(init.body).messages[0].content, /Evidence regression/);
    return Response.json({ content: [{ type: 'text', text: JSON.stringify([claim]) }] });
  };
  const response = await POST(new Request('http://localhost/api/research', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: sourceUrl }),
  }));
  assert.equal(response.status, 200);
  const event = await response.json();
  assert.equal(pageCalls, 1);
  assert.equal(providerCalls, 1);
  const fact = event.facts.find((entry) => entry.id === 'opener');
  assert.ok(fact);
  assert.equal(fact.sourceUrl, sourceUrl);
  assert.match(fact.source, /event page \(read by /);
  assert.equal(fact.value, 'Example Band');
  return fact;
}

test('a real but unrelated quote cannot promote an invented opener to live', async () => {
  const fact = await enrich('Doors open at 19:00. Support act to be announced.', { evidence: 'Doors open at 19:00.' });
  assert.equal(fact.provenance, 'estimated');
  assert.equal(fact.confidence, 0.5);
});

test('a contradictory opener value remains uncertain', async () => {
  const fact = await enrich('Opener: Another Band.', { evidence: 'Opener: Another Band.' });
  assert.equal(fact.provenance, 'estimated');
  assert.equal(fact.confidence, 0.5);
});

for (const evidence of [undefined, '', 'Opener: Fabricated Band.']) {
  test(`a missing or fabricated quote remains uncertain: ${String(evidence)}`, async () => {
    const fact = await enrich('Doors open at 19:00.', { evidence });
    assert.equal(fact.provenance, 'estimated');
    assert.equal(fact.confidence, 0.5);
  });
}

test('a supported affirmative field/value retains live source provenance', async () => {
  const fact = await enrich('Doors open at 19:00. Opener: Example Band. Tickets available.');
  assert.equal(fact.provenance, 'live');
  assert.equal(fact.confidence, 0.85);
});

test('an unrelated role cannot borrow a literal named band', async () => {
  const fact = await enrich('Headliner: Example Band.', { evidence: 'Headliner: Example Band.' });
  assert.equal(fact.provenance, 'estimated');
});

test('a chopped quote cannot remove a preceding negation', async () => {
  const fact = await enrich('Not Opener: Example Band.', { evidence: 'Opener: Example Band.' });
  assert.equal(fact.provenance, 'estimated');
});

test('a chopped quote cannot remove a cancellation suffix', async () => {
  const fact = await enrich('Opener: Example Band is cancelled.', { evidence: 'Opener: Example Band' });
  assert.equal(fact.provenance, 'estimated');
});

test('a matching value does not validate a contradictory printed label', async () => {
  const fact = await enrich('Opener: Example Band.', { label: 'Opener: Invented Band' });
  assert.equal(fact.provenance, 'estimated');
});

test('supported source provenance does not raise the model confidence', async () => {
  const fact = await enrich('Opener: Example Band.', { confidence: 0.3 });
  assert.equal(fact.provenance, 'live');
  assert.equal(fact.confidence, 0.3);
});
