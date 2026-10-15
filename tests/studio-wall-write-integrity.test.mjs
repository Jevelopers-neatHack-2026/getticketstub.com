import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import "./analytics-hooks.mjs";
const store = await import("../src/customer/studio/store.ts");
const sync = await import("../src/customer/account/sync.ts");
const { newStub, PALE_HOURS } = await import("../src/customer/studio/fixtures.ts");
const { saveStatus } = await import("../src/customer/studio/generation/status-store.ts");
const WALL="ticketstub.wall.v1", DELETED="ticketstub.wall.deleted.v1", STATUS="ticketstub.generation.v1";
let bytes, writes, events, readsThrow, blocked, reply, requests;
const stub = id => { const s = newStub(structuredClone(PALE_HOURS),id); s.createdAt="2026-10-12T00:00:00.000Z"; s.versions[0].createdAt=s.createdAt; s.wallAngle=0; return s; };
beforeEach(()=>{
  bytes=new Map(); writes=[]; events=[]; readsThrow=false; blocked=new Set(); requests=[];
  globalThis.localStorage={getItem(k){if(readsThrow)throw new DOMException("denied","SecurityError");return bytes.get(k)??null;},setItem(k,v){writes.push(k);if(blocked.has(k))throw new DOMException("full","QuotaExceededError");bytes.set(k,String(v));},removeItem(k){bytes.delete(k);}};
  globalThis.window=new EventTarget();
  for(const e of [store.WALL_CHANGED,sync.WALL_SYNCED,"ticketstub:wall-sync-result"])window.addEventListener(e,ev=>events.push({type:e,detail:ev.detail}));
  reply=async body=>({stubs:body.stubs,deleted:body.deleted,now:1});
  globalThis.fetch=async (url,init)=>{assert.equal(url,"/api/wall/sync");const body=JSON.parse(init.body);requests.push(body);return Response.json(await reply(body));};
  saveStatus({runId:"run",stubId:"a",sourceVersionId:"v0",sourceRevision:0,via:"sheet",phase:"failed",startedAt:1,message:"Retained failure"},"a");
  bytes.set(DELETED,JSON.stringify(["older"]));writes=[];
});
const malformed=["", "{broken", "null", "{}", "[null]", "[42]", JSON.stringify([{id:"peer",versions:{}}]),JSON.stringify([{...stub("peer"),versions:[{id:"bad",art:null}]}])];
for(const raw of malformed) for(const op of ["remove","upsert","save","write"])test(`${op} refuses unknown raw wall ${raw.slice(0,45)}`,()=>{
  bytes.set(WALL,raw);const before=new Map(bytes);
  const act=()=>op==="remove"?store.removeStub("a"):op==="upsert"?store.upsertStub(stub("a")):op==="save"?store.saveWall([]):store.writeWallDetailed([]).ok;
  let result;assert.doesNotThrow(()=>{result=act();});assert.equal(result,false);
  assert.deepEqual(bytes,before,"wall/tombstones/status bytes remain exact");assert.deepEqual(writes,[]);assert.deepEqual(events,[]);
});
test("read throws with a writable sink cannot authorize any mutation",()=>{
 bytes.set(WALL,JSON.stringify([stub("peer")]));const before=new Map(bytes);readsThrow=true;
 for(const act of [()=>store.removeStub("a"),()=>store.upsertStub(stub("a")),()=>store.saveWall([]),()=>store.writeWall([])])assert.equal(act(),false);
 assert.deepEqual(bytes,before);assert.deepEqual(writes,[]);assert.deepEqual(events,[]);
});
test("malformed incoming history is refused before retaining peer art or clearing tombstones",()=>{
 bytes.set(WALL,JSON.stringify([stub("peer")]));bytes.set(DELETED,JSON.stringify(["a"]));const before=new Map(bytes);
 assert.equal(store.upsertStub({...stub("a"),versions:[null]}),false);assert.equal(store.writeWall([null]),false);
 assert.deepEqual(bytes,before);assert.deepEqual(writes,[]);
});
test("failed writes do not queue/clear tombstones, forget status or announce a saved wall",()=>{
 bytes.set(WALL,JSON.stringify([stub("a"),stub("peer")]));bytes.set(DELETED,JSON.stringify(["a"]));const before=new Map(bytes);blocked.add(WALL);
 assert.equal(store.removeStub("a"),false);assert.equal(store.upsertStub(stub("a")),false);assert.equal(store.saveWall([]),false);
 assert.deepEqual(bytes,before);assert.deepEqual(events,[]);
});
test("absence and known empty permit first use, deletion and same-ID recreation",()=>{
 for(const raw of [null,"[]"]){if(raw===null)bytes.delete(WALL);else bytes.set(WALL,raw);
 assert.equal(store.upsertStub(stub("a")),true);assert.equal(store.removeStub("a"),true);assert.ok(store.loadDeleted().includes("a"));
 assert.equal(store.upsertStub(stub("a")),true);assert.ok(!store.loadDeleted().includes("a"));assert.equal(store.getStub("a").id,"a");}
});
for(const raw of malformed)test(`sync refuses unreadable local wall before remote call: ${raw.slice(0,40)}`,async()=>{
 bytes.set(WALL,raw);const before=new Map(bytes);const r=await sync.syncNow();assert.equal(r.ok,false);assert.equal(r.localReadFailed,true);
 assert.deepEqual(requests,[]);assert.deepEqual(bytes,before);assert.deepEqual(writes,[]);assert.equal(events.some(e=>e.type===sync.WALL_SYNCED),false);
});
test("remote acknowledgement is distinct from failed local persistence, with retry recovery",async()=>{
 const a=stub("acked");bytes.set(WALL,JSON.stringify([a]));const before=new Map(bytes);blocked.add(WALL);
 const r=await sync.syncNow();assert.equal(r.ok,false);assert.equal(r.remoteAcknowledged,true);assert.equal(r.localPersistenceFailed,true);
 assert.equal(sync.isOnServer(a.id),true,"real reply acknowledged; failure is not remote rollback");assert.deepEqual(bytes,before);
 assert.equal(events.some(e=>e.type===sync.WALL_SYNCED),false);assert.equal(events.at(-1).detail.localPersistenceFailed,true);
 blocked.clear();assert.equal((await sync.syncNow()).ok,true);assert.equal(events.filter(e=>e.type===sync.WALL_SYNCED).length,1);
 assert.deepEqual(store.loadDeleted(),[]);assert.equal(events.some(e=>e.type===store.WALL_CHANGED),false,"sync must not echo");
});
test("fresh-read fold preserves in-flight edits, photos/art and newly queued deletion IDs",async()=>{
 const a=stub("fresh");bytes.set(WALL,JSON.stringify([a]));bytes.set(DELETED,JSON.stringify(["sent"]));
 reply=async body=>{const latest={...a,updatedAt:Date.now()+1000,event:{...a.event,title:"Edited during request"},photos:["local-photo"]};bytes.set(WALL,JSON.stringify([latest]));bytes.set(DELETED,JSON.stringify(["sent","new"]));return {stubs:body.stubs,deleted:body.deleted,now:1};};
 assert.equal((await sync.syncNow()).ok,true);assert.equal(store.getStub("fresh").event.title,"Edited during request");assert.equal(store.getStub("fresh").photos[0],"local-photo");assert.deepEqual(store.loadDeleted(),["new"]);
});
test("wall becoming unknown during API await is retained without local side effects",async()=>{
 bytes.set(WALL,JSON.stringify([stub("a")]));reply=async body=>{bytes.set(WALL,"[null]");return{stubs:body.stubs,deleted:body.deleted,now:1};};
 const r=await sync.syncNow();assert.equal(r.ok,false);assert.equal(r.remoteAcknowledged,true);assert.equal(r.localReadFailed,true);
 assert.equal(bytes.get(WALL),"[null]");assert.deepEqual(store.loadDeleted(),["older"]);assert.deepEqual(writes,[]);assert.equal(events.some(e=>e.type===sync.WALL_SYNCED),false);
});
for(const raw of ["", "null", "{}", "[null]"])test(`unknown deletion queue refuses mutation and sync: ${raw}`,async()=>{
 bytes.set(WALL,JSON.stringify([stub("a")]));bytes.set(DELETED,raw);const before=new Map(bytes);
 assert.equal(store.removeStub("a"),false);assert.equal(store.upsertStub(stub("a")),false);assert.equal((await sync.syncNow()).ok,false);
 assert.deepEqual(requests,[]);assert.deepEqual(writes,[]);assert.deepEqual(bytes,before);
});
test("sync read throws before the request, even when local writes would work",async()=>{
 bytes.set(WALL,JSON.stringify([stub("a")]));const before=new Map(bytes);readsThrow=true;
 const r=await sync.syncNow();assert.equal(r.localReadFailed,true);assert.equal(r.ok,false);assert.deepEqual(requests,[]);assert.deepEqual(writes,[]);assert.deepEqual(bytes,before);
});
test("failed tombstone write reports partial local handling without claiming a sync or forgetting status",async()=>{
 bytes.set(WALL,JSON.stringify([stub("a")]));const priorStatus=bytes.get(STATUS),priorDeleted=bytes.get(DELETED);blocked.add(DELETED);
 assert.equal(store.removeStub("a"),false);assert.equal(bytes.get(DELETED),priorDeleted);assert.equal(bytes.get(STATUS),priorStatus);assert.deepEqual(events,[]);
 const r=await sync.syncNow();assert.equal(r.ok,false);assert.equal(r.remoteAcknowledged,true);assert.equal(r.localPersistenceFailed,true);assert.equal(bytes.get(DELETED),priorDeleted);assert.equal(events.some(e=>e.type===sync.WALL_SYNCED),false);
});
test("recreate does not clear its tombstone when the wall write fails",()=>{
 bytes.set(WALL,"[]");bytes.set(DELETED,JSON.stringify(["a"]));blocked.add(WALL);
 assert.equal(store.upsertStub(stub("a")),false);assert.deepEqual(store.loadDeleted(),["a"]);assert.deepEqual(events,[]);
});
test("same-version retention preserves selected art bytes, identity and seed",()=>{
 const original=stub("art");original.versions[0].art={kind:"image",src:"data:image/png;base64,retained",seed:123,provenance:"live"};bytes.set(WALL,JSON.stringify([original]));
 const released=structuredClone(original);released.versions[0].art={kind:"procedural",seed:123,provenance:"live",unavailable:true};
 assert.equal(store.upsertStub(released),true);assert.deepEqual(store.getStub("art").versions,original.versions);
});
