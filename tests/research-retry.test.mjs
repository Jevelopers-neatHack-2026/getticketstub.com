import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier === 'server-only') return {url:'data:text/javascript,export{}',shortCircuit:true};
    if (specifier.startsWith('@/')) {
      const file = fileURLToPath(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url));
      if(existsSync(file)) return {url:pathToFileURL(file).href,shortCircuit:true};
    }
    if(specifier.startsWith('.') && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if(existsSync(fileURLToPath(url))) return {url:url.href,shortCircuit:true};
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if(url.endsWith('.ts')) return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
    return nextLoad(url,context);
  }
});
const scratch=mkdtempSync(join(tmpdir(),'ticketstub-pr78-data-'));
process.env.TICKETSTUB_DB=join(scratch,'review.sqlite');
process.env.TICKETSTUB_FILES=join(scratch,'files');
process.env.TICKETSTUB_RUNTIME_MODE='live';
process.env.TICKETSTUB_RESEARCH_PROVIDER='anthropic';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.TICKETSTUB_OPS_TELEMETRY;
const {POST}=await import('../src/app/api/research/route.ts');
const {setTransport,createPinnedTransport}=await import('../src/server/intake-url.ts');
// Offline: the pinned socket transport is replaced by a stub of globalThis.fetch (redirects are followed by fetchPublic itself).
setTransport((url,init)=>globalThis.fetch(url.href,{...init,redirect:'manual'}));
const {POST: artPost}=await import('../src/app/api/art/route.ts');
const {buildArtPrompt}=await import('../src/customer/studio/research/artPrompt.ts');
const {memoryCollector,setOpsSink}=await import('../src/server/observability/sink.ts');
const {resetOpsStats}=await import('../src/server/observability/measure.ts');
const oldFetch=globalThis.fetch, oldTimeout=AbortSignal.timeout;
const html='<script type="application/ld+json">{"@type":"MusicEvent","name":"Retry recovery"}</script>';
const req=(body)=>new Request('http://localhost/api/research',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
let sink;
beforeEach(()=>{sink=memoryCollector();setOpsSink(sink);resetOpsStats();});
afterEach(()=>{globalThis.fetch=oldFetch;AbortSignal.timeout=oldTimeout;setOpsSink(undefined);});
const outcomes=()=>sink.events.filter(e=>e.name==='source_fetch').map(e=>e.fields.outcome);
async function run(sequence,{status=200,expectedOutcomes,timeoutMs=[8000,8000]}={}) {
  let calls=0;const seen=[];const signals=[];
  AbortSignal.timeout=ms=>{seen.push(ms);return oldTimeout(ms);};
  globalThis.fetch=async (url,init)=>{
    assert.equal(url,'https://example.com/review');
    assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');
    signals.push(init.signal);
    const step=sequence[calls++];
    assert.ok(step,`unexpected fetch ${calls}`);
    if(step instanceof Error) throw step;
    return typeof step==='function'?step():step;
  };
  const res=await POST(req({url:'https://example.com/review'}));
  assert.equal(res.status,status);
  assert.equal(calls,sequence.length);
  assert.deepEqual(outcomes(),expectedOutcomes);
  assert.deepEqual(seen,timeoutMs);
  if(signals.length===2) assert.notEqual(signals[0],signals[1]);
  const payload=await res.json();
  if(status===200) assert.equal(payload.title,'Retry recovery');
  else assert.equal(payload.error.code,'unreadable_link');
}
test('network reset retries once and recovers with two telemetry events',()=>run([new TypeError('fetch failed'),new Response(html)],{expectedOutcomes:['network_error','ok']}));
test('503 retries once and recovers',()=>run([new Response('busy',{status:503}),new Response(html)],{expectedOutcomes:['http_error','ok']}));
test('network errors stop after second attempt',()=>run([new TypeError('fetch failed'),new TypeError('fetch failed')],{status:422,expectedOutcomes:['network_error','network_error']}));
test('HTTP 5xx stops after second attempt',()=>run([new Response('busy',{status:500}),new Response('busy',{status:503})],{status:422,expectedOutcomes:['http_error','http_error']}));
for(const status of [400,401,403,404,429]) test(`HTTP ${status} has no retry`,()=>run([new Response('rejected',{status})],{status:422,expectedOutcomes:['http_error'],timeoutMs:[8000]}));
for(const name of ['TimeoutError','AbortError']) test(`${name} during fetch has no retry`,()=>run([new DOMException('expired',name)],{status:422,expectedOutcomes:['timeout'],timeoutMs:[8000]}));
test('response body network failure retries once and recovers',()=>run([()=>new Response(new ReadableStream({start(c){c.error(new TypeError('terminated'));}})),new Response(html)],{expectedOutcomes:['network_error','ok']}));
test('response body timeout has no retry',()=>run([()=>new Response(new ReadableStream({start(c){c.error(new DOMException('expired','AbortError'));}}))],{status:422,expectedOutcomes:['timeout'],timeoutMs:[8000]}));
test('503 response is cancelled before the second fetch',async()=>{
  let cancelled=false,calls=0;
  globalThis.fetch=async()=>{
    if(++calls===1) return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('busy'));},cancel(){cancelled=true;}}),{status:503});
    assert.equal(cancelled,true,'first 503 body must be released before retry');
    return new Response(html);
  };
  const res=await POST(req({url:'https://example.com/review'}));
  assert.equal(res.status,200);
  assert.equal(cancelled,true);
});
test('real loopback 503 stream is closed after recovery',async()=>{
  let calls=0,firstClosed=false,firstResponse;
  const server=createServer((_req,res)=>{
    if(++calls===1){firstResponse=res;res.on('close',()=>{firstClosed=true;});res.writeHead(503,{'content-type':'text/plain'});res.write('busy');}
    else {res.writeHead(200,{'content-type':'text/html'});res.end(html);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  // Real sockets: the pinned transport, with a local name and loopback allowed for this test only.
  const pinned=createPinnedTransport({resolver:()=>async()=>['127.0.0.1'],allowed:a=>a==='127.0.0.1'});
  setTransport((url,init)=>pinned(new URL(`http://loopback.example.com:${server.address().port}${url.pathname}`),init));
  try{
    const res=await POST(req({url:'http://loopback.example.com/review'}));
    assert.equal(res.status,200);assert.equal(calls,2);
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(firstClosed,true,`retry succeeded while discarded 503 stream remains live; writableEnded=${firstResponse.writableEnded}`);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
const badFields=[undefined,null,1,true,'oops',{},[null,1,'bad',{}, {id:'weather',label:{},value:7}]];
for(const facts of badFields) test(`art prompt tolerates malformed facts ${JSON.stringify(facts)}`,()=>{
  const prompt=buildArtPrompt({title:'Review event',facts,dateISO:{bad:true},city:55,venue:[]});
  assert.match(prompt,/Illustration only, no text/);assert.ok(!prompt.includes('[object Object]'));
});
test('valid weather, season, city, venue and vibe remain in prompt',()=>{
  const prompt=buildArtPrompt({title:'Review event',type:'concert',city:'Glasgow',venue:'Royal Concert Hall',dateISO:'2026-12-20',facts:[{id:'weather',label:'Weather',value:'Snow -2°C'}]},'moodier');
  assert.match(prompt,/cold snowy winter evening in Glasgow/);assert.match(prompt,/Royal Concert Hall/);assert.match(prompt,/Mood: moodier/);assert.match(prompt,/summer clothing/);assert.match(prompt,/summer heat/);
});
test('partial art API event reaches image provider with sanitized prompt',async()=>{
  process.env.TICKETSTUB_ART_PROVIDER='openrouter';
  process.env.TICKETSTUB_ART_MODEL='openai/pr78-offline-image';
  process.env.TICKETSTUB_ART_OPENROUTER_API_KEY='offline-review-key';
  let calls=0;
  globalThis.fetch=async(url,init)=>{
    calls++;
    if(url.endsWith('/models'))return Response.json({data:[{id:'openai/pr78-offline-image',architecture:{output_modalities:['image']}}]});
    const body=JSON.parse(init.body);assert.match(JSON.stringify(body),/Illustration only, no text/);assert.ok(!JSON.stringify(body).includes('[object Object]'));
    return Response.json({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=',media_type:'image/png'}]});
  };
  const res=await artPost(req({event:{title:'Review event',facts:null,dateISO:{bad:true},city:44,venue:[],type:{bad:true}},vibe:{bad:true}}));
  assert.equal(res.status,200);const body=await res.json();assert.equal(body.provenance,'live');assert.match(body.src,/^data:image\/png;base64,/);assert.equal(calls,2);
});
