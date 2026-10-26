import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Test the real pure validator; no provider, DNS, or network transport is used.
const source = readFileSync(new URL('../src/customer/studio/research/factEvidence.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { supportsEnrichedFact } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const opener = (changes = {}) => ({ id: 'opener', label: 'Opener: Example Band', value: 'Example Band', evidence: 'Opener: Example Band.', ...changes });

test('a named headliner cannot establish the same band as the opener', () => {
  assert.equal(supportsEnrichedFact('Headliner: Example Band.', opener({ evidence: 'Headliner: Example Band.' })), false);
});

test('correct values cannot rescue a falsely labelled role or different value', () => {
  const page = 'Opener: Example Band.';
  assert.equal(supportsEnrichedFact(page, opener({ label: 'Tour: Example Band' })), false);
  assert.equal(supportsEnrichedFact(page, opener({ value: 'Other Band', label: 'Opener: Other Band' })), false);
});

test('a quote cannot silently shorten a band name or retain a prefix of a number', () => {
  assert.equal(supportsEnrichedFact('Opener: Example Band Orchestra.', opener({ evidence: 'Opener: Example Band' })), false);
  assert.equal(supportsEnrichedFact('Capacity: 1200.', { id: 'other', label: 'Capacity: 12', value: '12', evidence: 'Capacity: 12' }), false);
  for (const evidence of ['Capacity: 12', 'Capacity: 12.']) {
    assert.equal(supportsEnrichedFact('Capacity: 12.50.', { id: 'other', label: 'Capacity: 12', value: '12', evidence }), false);
  }
});

test('date claims require the whole source value rather than a matching year or month', () => {
  assert.equal(supportsEnrichedFact('Run: 2026-12-31.', { id: 'run', label: 'Run: 2026', value: '2026', evidence: 'Run: 2026' }), false);
  assert.equal(supportsEnrichedFact('Run: 2026-12-31.', { id: 'run', label: 'Run: 2027-01-01', value: '2027-01-01', evidence: 'Run: 2026-12-31.' }), false);
});

test('omitted source evidence and a fabricated quote cannot establish a claim', () => {
  for (const evidence of [undefined, '', 'Opener: Imaginary Band.']) {
    assert.equal(supportsEnrichedFact('Opener: Example Band.', opener({ evidence })), false);
  }
});

test('a quote extracted from a negated sentence cannot establish a claim', () => {
  assert.equal(supportsEnrichedFact('We have not confirmed Opener: Example Band.', opener()), false);
  assert.equal(supportsEnrichedFact('Opener: Example Band is no longer performing.', opener({ evidence: 'Opener: Example Band' })), false);
});

test('conflicting assignments for the same role remain uncertain', () => {
  assert.equal(supportsEnrichedFact('Opener: Example Band. Opener: Other Band.', opener()), false);
});

for (const qualification of [
  'The lineup is tentative.',
  'This is subject to confirmation.',
  "They won't perform.",
]) {
  test(`a nearby qualification preserves uncertainty: ${qualification}`, () => {
    assert.equal(supportsEnrichedFact(`Opener: Example Band. ${qualification}`, opener()), false);
  });
}

test('an oversized evidence string is refused without dropping its conflicting tail', () => {
  const evidence = `Opener: Example Band${' '.repeat(2100)} is cancelled.`;
  assert.equal(supportsEnrichedFact(evidence, opener({ evidence })), false);
});

test('safe case changes and surrounding whitespace retain supported literal facts', () => {
  assert.equal(supportsEnrichedFact('OPENER: Example Band.', opener({ evidence: 'opener: example band.', label: ' OPENER: EXAMPLE BAND ', value: ' example band ' })), true);
});

test('complete date and decimal values retain their exact source meaning', () => {
  assert.equal(supportsEnrichedFact('Run: 2026-12-31.', { id: 'run', label: 'Run: 2026-12-31', value: '2026-12-31', evidence: 'Run: 2026-12-31.' }), true);
  assert.equal(supportsEnrichedFact('Price: 12.50.', { id: 'other', label: 'Price: 12.50', value: '12.50', evidence: 'Price: 12.50.' }), true);
});

test('a clear source value after independent sentence boundaries remains supported', () => {
  assert.equal(supportsEnrichedFact('Tickets available.\nOpener: Example Band.\nDoors open at 19:00.', opener()), true);
});
