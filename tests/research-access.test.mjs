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
const scratch = mkdtempSync(join(tmpdir(), 'ticketstub-access-'));
process.env.TICKETSTUB_DB = join(scratch, 'test.sqlite');
process.env.TICKETSTUB_FILES = join(scratch, 'files');
process.env.TICKETSTUB_RUNTIME_MODE = 'live';
process.env.TICKETSTUB_RESEARCH_PROVIDER = 'anthropic';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TICKETMASTER_API_KEY;
delete process.env.OPEN_METEO_API_KEY;
const { POST } = await import('../src/app/api/research/route.ts');
const { setTransport } = await import('../src/server/intake-url.ts');
const { providerForUrl, isRestrictedEvent, readManualFallback } = await import('../src/customer/studio/research/access.ts');
const { readManualDetails } = await import('../src/customer/studio/research/manual.ts');
const { memoryCollector, setOpsSink } = await import('../src/server/observability/sink.ts');
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/research/access-challenges.json', import.meta.url)));
const originalFetch = globalThis.fetch;
let calls, sink;
beforeEach(() => {
  calls = 0;
  process.env.TICKETSTUB_RUNTIME_MODE = 'live';
  sink = memoryCollector(); setOpsSink(sink);
  setTransport(async () => { calls++; throw new Error('Unexpected event-page request'); });
  globalThis.fetch = async () => { throw new Error('Unexpected upstream request'); };
});
afterEach(() => { globalThis.fetch = originalFetch; setOpsSink(undefined); });
const request = (body) => new Request('http://localhost/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const manual = { title: 'Our night', dateISO: '2024-10-12', venue: 'The Hall', city: '' };

test('provider recognition uses exact roots and subdomain boundaries', () => {
  for (const [host, id] of [['axs.com','axs'],['www.seatgeek.com','seatgeek'],['stubhub.com','stubhub'],['ra.co','ra'],['www.residentadvisor.net','ra'],['eventim.de','eventim'],['seetickets.us','see_tickets'],['shotgun.live','shotgun'],['etix.com','etix'],['www.tixr.com','tixr'],['www.skiddle.com','skiddle']]) {
    assert.equal(providerForUrl(new URL(`https://${host}/`))?.id, id);
    assert.equal(providerForUrl(new URL(`https://${host}.evil.example/`)), undefined);
  }
  for (const host of ['evilra.co','ra.co.evil.com','de.ra.co','notaxs.com']) assert.equal(providerForUrl(new URL(`https://${host}/`)), undefined);
});
test('RA numeric event paths are recognised, non-events are not', () => {
  for (const path of ['/events/2200000','/events/2200000/?ref=x']) assert.ok(isRestrictedEvent(new URL(`https://ra.co${path}`)));
  for (const path of ['/','/events/us/newyork','/dj/example','/events/2200000/extra','/events/not-an-id']) assert.equal(isRestrictedEvent(new URL(`https://ra.co${path}`)), false);
});
test('RA event requests return manual fallback without any fetch, including legacy host', async () => {
  for (const host of ['ra.co','www.ra.co','residentadvisor.net','www.residentadvisor.net','ra.co.']) {
    const res = await POST(request({url:`https://${host}/events/2200000?private=secret#fragment`}));
    assert.equal(res.status,422);
    const body=await res.json();
    assert.equal(body.error.code,'access_restricted'); assert.equal(body.fallback.provider,'ra');
    assert.equal(body.fallback.title,''); assert.ok(!body.fallback.url.includes('private'));
  }
  assert.equal(calls,0);
  assert.ok(sink.events.some(e=>e.fields.code==='access_restricted'&&e.fields.provider==='ra'));
  assert.ok(!JSON.stringify(sink.events).includes('secret'));
});
test('preview keeps demo-only outcome for RA and performs no fetch', async () => {
  process.env.TICKETSTUB_RUNTIME_MODE='demo';
  const res=await POST(request({url:'https://ra.co/events/2200000'}));
  assert.equal((await res.json()).error.code,'demo_only'); assert.equal(calls,0);
});
test('RA listing, profile and private API paths are rejected without fetching',async()=>{
  for (const path of ['/','/events/us/newyork','/dj/example','/api/events','/graphql']) {
    const res=await POST(request({url:`https://ra.co${path}`}));
    assert.equal((await res.json()).error.code,'unsupported_url');
  }
  assert.equal(calls,0);
});
for (const fixture of fixtures.cases) test(`${fixture.name} never reaches parsing or retry`, async () => {
  setTransport(async()=>{calls++;return new Response(fixture.body,{status:fixture.status,headers:fixture.headers});});
  const res=await POST(request({url:'https://www.axs.com/events/42/our-night?secret=value'}));
  const body=await res.json();
  assert.equal(res.status,422); assert.equal(body.error.code,'access_restricted');
  assert.equal(body.fallback.provider,'axs'); assert.equal(body.fallback.title,'our night');
  assert.equal(calls,1); assert.equal(sink.events.filter(e=>e.name==='source_parse').length,0);
  assert.ok(sink.events.some(e=>e.name==='source_fetch'&&e.fields.outcome==='access_restricted'));
  assert.ok(!JSON.stringify(sink.events).includes('our-night'));
});
test('unknown blocked provider gets a generic actionable fallback',async()=>{
  setTransport(async()=>new Response('<title>Access Denied</title>',{status:403}));
  const body=await (await POST(request({url:'https://example.com/event'}))).json();
  assert.equal(body.fallback.provider,'unknown'); assert.match(body.error.message,/This site/);
});
test('ordinary errors and timeouts stay distinct from access restrictions',async()=>{
  setTransport(async()=>{calls++;return new Response('missing',{status:404});});
  let body=await (await POST(request({url:'https://example.com/event'}))).json();
  assert.equal(body.error.code,'unreadable_link'); assert.equal(body.fallback,undefined);
  setTransport(async()=>{throw new DOMException('timeout','TimeoutError');});
  body=await (await POST(request({url:'https://example.com/event'}))).json();
  assert.equal(body.error.code,'unreadable_link');
  assert.ok(sink.events.some(e=>e.name==='source_fetch'&&e.fields.outcome==='timeout'));
});
test('normal HTML mentioning a security company still parses',async()=>{
  setTransport(async()=>new Response('<title>Cloudflare community meetup</title>'));
  const res=await POST(request({url:'https://example.com/event'}));
  assert.equal(res.status,200); assert.equal((await res.json()).title,'Cloudflare community meetup');
});
test('manual validation rejects absent, malformed, oversized and impossible values',()=>{
  for (const value of [null,{}, {...manual,title:' '},{...manual,dateISO:'2024-02-30'},{...manual,title:'a'.repeat(201)},{...manual,city:'x\n'},{...manual,extra:'x'}]) assert.equal(readManualDetails(value),undefined);
  assert.ok(readManualDetails({...manual,dateISO:'2024-02-29'}));
  assert.equal(readManualFallback({kind:'manual_event',url:'javascript:alert(1)',title:''}),undefined);
});
test('manual event never fetches the blocked page and preserves customer provenance',async()=>{
  const res=await POST(request({url:'https://ra.co/events/2200000',manual}));
  assert.equal(res.status,200); const event=await res.json();
  assert.equal(event.title,manual.title); assert.equal(calls,0);
  assert.ok(event.facts.filter(f=>f.id!=='weather').every(f=>f.provenance==='customer'&&f.source==='Entered by you'));
  assert.equal(event.facts.find(f=>f.id==='weather').provenance,'pending');
});
test('manual source URL still passes the public intake boundary',async()=>{
  for (const url of ['http://127.0.0.1/private','https://u:p@ra.co/events/1','file:///etc/passwd']) {
    const res=await POST(request({url,manual})); assert.equal(res.status,422); assert.equal((await res.json()).error.code,'unsupported_url');
  }
  const res=await POST(request({manual:{...manual,dateISO:'2024-02-30'}})); assert.equal(res.status,400);
});
test('weather uses supplied city/date and remains a separate live source',async()=>{
  const seen=[];
  const dateISO = new Date().toISOString().slice(0,10);
  globalThis.fetch=async(url)=>{
    seen.push(url);
    if (url.startsWith('https://geocoding-api.open-meteo.com/')) return Response.json({results:[{latitude:55.86,longitude:-4.25,name:'Glasgow'}]});
    assert.ok(url.startsWith('https://api.open-meteo.com/'));
    return Response.json({daily:{temperature_2m_max:[12],precipitation_sum:[1]}});
  };
  const res=await POST(request({url:'https://ra.co/events/2200000',manual:{...manual,city:'Glasgow',dateISO}}));
  const event=await res.json(); assert.equal(res.status,200); assert.equal(calls,0);
  assert.equal(seen.length,2); assert.match(seen[0],/name=Glasgow/); assert.ok(seen[1].includes(`start_date=${dateISO}`));
  assert.equal(event.facts.find(f=>f.id==='weather').provenance,'live');
  assert.equal(event.facts.find(f=>f.id==='date').provenance,'customer');
});
