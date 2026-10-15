import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import "./analytics-hooks.mjs";
registerHooks({resolve(spec,ctx,next){if(spec==="server-only")return {url:"data:text/javascript,export{}",shortCircuit:true};if(spec==="next/server")return next("next/server.js",ctx);return next(spec,ctx);}});
const store=await import("../src/customer/studio/store.ts");
const sync=await import("../src/customer/account/sync.ts");
const {newStub,PALE_HOURS}=await import("../src/customer/studio/fixtures.ts");
const {readGenerationStorage}=await import("../src/customer/studio/generation/storage-snapshot.ts");
const {openDatabase,SqliteStorage}=await import("../src/server/sqlite.ts");
const WALL="ticketstub.wall.v1",DELETED="ticketstub.wall.deleted.v1",JOURNAL="ticketstub.wall.mutation.v1",STATUS="ticketstub.generation.v1";
const stub=id=>{const s=newStub(structuredClone(PALE_HOURS),id);s.createdAt="2026-10-12T00:00:00Z";s.versions[0].createdAt=s.createdAt;s.wallAngle=0;s.updatedAt=1;return s;};
let bytes,events,requests,db,server,account,blockDeleted,blockWall,blockJournal,blockClear,failRollback,wallWrites,serverNow,blockStatus,blockFailureMark;
function storage(){return {getItem:k=>bytes.get(k)??null,setItem(k,v){if(k===STATUS&&blockStatus||k===DELETED&&blockDeleted||k===WALL&&(blockWall||failRollback&&wallWrites>0)||k===JOURNAL&&(blockJournal||blockFailureMark&&bytes.has(JOURNAL)))throw new DOMException("injected","SecurityError");bytes.set(k,String(v));if(k===WALL)wallWrites++;},removeItem(k){if(k===JOURNAL&&blockClear||k===WALL&&failRollback&&wallWrites>0)throw new DOMException("injected clear","SecurityError");bytes.delete(k);}};}
beforeEach(async()=>{
 bytes=new Map();events=[];requests=[];blockDeleted=blockWall=blockJournal=blockClear=failRollback=blockStatus=blockFailureMark=false;wallWrites=0;serverNow=2;
 globalThis.localStorage=storage();globalThis.window=new EventTarget();for(const e of [store.WALL_CHANGED,sync.WALL_SYNCED])window.addEventListener(e,()=>events.push(e));
 db=openDatabase(":memory:");server=new SqliteStorage(db);account=await server.findOrCreateAccount("recovery@example.test",1);await server.syncWall(account.id,[stub("x")],[],1);
 globalThis.fetch=async(url,init)=>{assert.equal(url,"/api/wall/sync");const body=JSON.parse(init.body);requests.push(body);return Response.json(await server.syncWall(account.id,body.stubs,body.deleted,serverNow++));};
});
afterEach(()=>db.close());
const row=async()=> (await server.syncWall(account.id,[],[],serverNow++)).stubs;

test("control: actual SQLite deletion wins when row and same-ID tombstone are both sent",async()=>{
 assert.deepEqual((await server.syncWall(account.id,[{...stub("x"),updatedAt:100}],["x"],100)).stubs,[]);
});
for(const op of ["recreate","remove"])test(`${op}: failed tombstone write restores exact wall and follow-up actual SQLite sync is coherent`,async()=>{
 const wall=JSON.stringify(op==="remove"?[stub("x")]:[]),deleted=JSON.stringify(op==="recreate"?["x"]:[]);
 bytes.set(WALL,wall);bytes.set(DELETED,deleted);bytes.set(STATUS,"retained-status");blockDeleted=true;
 const incoming={...stub("x"),event:{...PALE_HOURS,title:"Recreated work"}};
 assert.equal(op==="recreate"?store.upsertStub(incoming):store.removeStub("x"),false);
 assert.equal(bytes.get(WALL),wall);assert.equal(bytes.get(DELETED),deleted);assert.equal(bytes.get(STATUS),"retained-status");assert.deepEqual(events,[]);
 assert.equal(bytes.has(JOURNAL),false,"successful compensation clears preparation");
 blockDeleted=false;assert.equal((await sync.syncNow()).ok,true);
 assert.equal(requests[0].stubs.some(s=>s.id==="x"),op==="remove");assert.equal(requests[0].deleted.includes("x"),op==="recreate");
 assert.equal((await row()).some(s=>s.id==="x"),op==="remove");
 // An explicit retry, not false success, performs the intended operation.
 assert.equal(op==="recreate"?store.upsertStub(incoming):store.removeStub("x"),true);
 assert.equal((await sync.syncNow()).ok,true);assert.equal((await row()).some(s=>s.id==="x"),op==="recreate");
 if(op==="recreate")assert.equal((await row())[0].event.title,"Recreated work");
});
for(const fault of ["prepare","wall","clear"])test(`failure at ${fault} preserves primary bytes or durable quarantine and blocks unsafe publication`,async()=>{
 bytes.set(WALL,"[]");bytes.set(DELETED,'["x"]');blockJournal=fault==="prepare";blockWall=fault==="wall";blockClear=fault==="clear";
 assert.equal(store.upsertStub(stub("x")),false);assert.equal(bytes.get(WALL),"[]");assert.equal(bytes.get(DELETED),'["x"]');assert.deepEqual(events,[]);
 if(fault==="clear"){assert.equal(store.readWall().status,"unknown");assert.equal((await sync.syncNow()).ok,false);assert.deepEqual(requests,[]);}
 blockJournal=blockWall=blockClear=false;assert.equal((await sync.syncNow()).ok,true);assert.equal(requests[0].stubs.length,0);assert.deepEqual(await row(),[]);
});
test("failed compensation survives a new Storage wrapper; pending data never reaches remote sync",async()=>{
 bytes.set(WALL,"[]");bytes.set(DELETED,'["x"]');blockDeleted=true;failRollback=true;
 assert.equal(store.upsertStub(stub("x")),false);assert.ok(bytes.has(JOURNAL));assert.equal(JSON.parse(bytes.get(WALL))[0].id,"x");
 globalThis.localStorage=storage();assert.equal(store.readWall().status,"unknown");assert.equal(store.readDeleted().status,"unknown");assert.equal(store.stubPresence("x"),"unknown");
 assert.equal(store.saveWall([]),false);assert.equal(store.saveDeleted([]),false);assert.equal((await sync.syncNow()).ok,false);assert.deepEqual(requests,[]);
 failRollback=blockDeleted=false;assert.equal((await sync.syncNow()).ok,true);assert.equal(bytes.has(JOURNAL),false);assert.equal(requests[0].stubs.length,0);assert.deepEqual(await row(),[]);
});
test("recovery refuses a different peer value rather than choosing a merge or overwriting it",async()=>{
 bytes.set(WALL,"[]");bytes.set(DELETED,'["x"]');blockDeleted=true;failRollback=true;assert.equal(store.upsertStub(stub("x")),false);
 const peer=JSON.stringify([stub("peer")]);bytes.set(WALL,peer);blockDeleted=failRollback=false;
 assert.equal((await sync.syncNow()).ok,false);assert.deepEqual(requests,[]);assert.equal(bytes.get(WALL),peer);assert.ok(bytes.has(JOURNAL));
});
test("malformed recovery bytes are unknown and not erased",async()=>{
 bytes.set(WALL,"[]");bytes.set(DELETED,"[]");bytes.set(JOURNAL,"{}");assert.equal(store.upsertStub(stub("x")),false);assert.equal(store.removeStub("x"),false);
 assert.equal((await sync.syncNow()).ok,false);assert.deepEqual(requests,[]);assert.equal(bytes.get(JOURNAL),"{}");
});

test("status reminder write failure does not reverse a completed wall/tombstone deletion",async()=>{
 bytes.set(WALL,JSON.stringify([stub("x")]));bytes.set(DELETED,"[]");
 const reminder=JSON.stringify({x:{runId:"run",stubId:"x",sourceVersionId:"v1-x",sourceRevision:0,via:"sheet",phase:"failed",startedAt:1,message:"Reminder"}});
 bytes.set(STATUS,reminder);blockStatus=true;
 assert.equal(store.removeStub("x"),true);assert.equal(bytes.get(STATUS),reminder);assert.equal(bytes.get(WALL),"[]");assert.deepEqual(JSON.parse(bytes.get(DELETED)),["x"]);
 assert.equal(bytes.has(JOURNAL),false);assert.equal((await sync.syncNow()).ok,true);assert.deepEqual(await row(),[]);
});

test("an in-flight or unclassified preparation is held, never inferred failed by a new reader",async()=>{
 bytes.set(WALL,"[]");bytes.set(DELETED,'["x"]');blockDeleted=failRollback=blockFailureMark=true;
 assert.equal(store.upsertStub(stub("x")),false);assert.equal(JSON.parse(bytes.get(JOURNAL)).phase,"prepared");
 blockDeleted=failRollback=blockFailureMark=false;globalThis.localStorage=storage();
 assert.equal(store.readWall().status,"unknown");assert.equal(readGenerationStorage("x").status,"unknown");
 assert.equal((await sync.syncNow()).ok,false);assert.deepEqual(requests,[]);assert.ok(bytes.has(JOURNAL));
});
