import assert from "node:assert/strict";
import { test } from "node:test";
import "./analytics-hooks.mjs";
const { uniqueFacts, normalizeStubFacts, factKey, sourceEvent } = await import("../src/customer/studio/facts/identity.ts");
const { newStub, PALE_HOURS } = await import("../src/customer/studio/fixtures.ts");
const { toggleKept, toggleProjectFact, setHidden, setFactValue } = await import("../src/customer/studio/editor/ops.ts");
const { activeCorrection, entries, applyCorrection, undoCorrection, openQuestions, unresolvedHistory, questionKey } = await import("../src/customer/studio/facts/corrections.ts");
const { loadWall, writeWall, encodeStub, decodeStub } = await import("../src/customer/studio/store.ts");
const { foldWall } = await import("../src/customer/account/sync.ts");
const { includedExtraFacts } = await import("../src/customer/studio/facts/inclusion.ts");
const { toCreativeBrief, toBriefCreatePayload, toEditPlan } = await import("../src/customer/studio/creative/adapter.ts");
const { studioControls } = await import("../src/customer/studio/creative/controls.ts");
const { summarize, describeAction, describeDone, parseRequest, AGENT_SCHEMA } = await import("../src/customer/studio/agent/protocol.ts");
const { applyToStub } = await import("../src/customer/studio/agent/apply.ts");
const { printedSummary, printedRowKeys } = await import("../src/customer/studio/approval/printed.ts");
const { bindStub } = await import("../src/server/approval-token.ts");
const fact = (id, label, kept = false) => ({ id, label, value: label, source: "fixture", sourceUrl: "https://example.org/evidence", confidence: .5, provenance: "simulated", kept });
const stub = (facts) => normalizeStubFacts({ ...newStub(structuredClone(PALE_HOURS), "identity-fixture"), event: { ...PALE_HOURS, facts } });
const scope = { tenantId: "tenant", projectId: "project", actorId: "actor", environment: "test", billingMode: "simulated" };

test("ingestion preserves source IDs/provenance and allocates independent persisted keys once", () => {
  const input = [fact("note", "same"), fact("note", "same"), fact("note-2", "third"), fact("", "fourth")];
  const result = uniqueFacts(input);
  assert.deepEqual(result.map(f => { const out = {...f}; delete out.clientEntityKey; return out; }), input);
  assert.equal(new Set(result.map(factKey)).size, 4);
  assert.deepEqual(uniqueFacts(result), result);
  assert.deepEqual(uniqueFacts([...result].reverse()).map(factKey), result.map(factKey).reverse());
  const bad = result.map(f => ({...f, clientEntityKey: result[0].clientEntityKey}));
  const repaired = uniqueFacts(bad);
  assert.equal(repaired.some(f => f.clientEntityKey === result[0].clientEntityKey), false, "no first-row winner for ambiguous local keys");
});

test("ambiguous immutable legacy history stays byte-identical and never attaches to either row", () => {
  const original = stub([fact("note", "same", true), fact("note", "same")]);
  original.personal.hiddenFields = ["note"];
  original.corrections = [{ id: "legacy", factId: "note", kind: "correct", corrected: { value: "same", label: "same" }, original: { ...original.event.facts[0] } }];
  const bytes = JSON.stringify(original.corrections);
  const fixed = normalizeStubFacts(original);
  assert.equal(JSON.stringify(fixed.corrections), bytes);
  assert.equal(unresolvedHistory(fixed), true);
  for (const f of fixed.event.facts) assert.equal(activeCorrection(fixed, factKey(f)), undefined);
  assert.equal(entries(fixed).length, 1);
  assert.equal(entries(fixed, "note").length, 0);
  assert.deepEqual(fixed.personal.hiddenFields, fixed.event.facts.map(factKey));
  assert.deepEqual(includedExtraFacts(fixed), []);
  const selected = toggleKept(fixed, factKey(fixed.event.facts[1]));
  assert.deepEqual(includedExtraFacts(selected).map(factKey), [factKey(fixed.event.facts[1])]);
});

test("second-row actions, questions, correction and undo retain identity after reorder; stale/foreign/ambiguous refs refuse", () => {
  const initial = stub([fact("note", "one"), fact("note", "two")]);
  const [a,b] = initial.event.facts.map(factKey);
  assert.deepEqual(openQuestions(initial).filter(q => questionKey(q) === a || questionKey(q) === b).map(questionKey), [a,b]);
  const reordered = {...initial,event:{...initial.event,facts:[...initial.event.facts].reverse()}};
  const selected = toggleProjectFact(reordered, initial.id, b);
  assert.deepEqual(selected.event.facts.map(f => [factKey(f),f.kept]), [[b,true],[a,false]]);
  const corrected = applyCorrection(selected, {factId:b,value:"corrected"});
  assert.deepEqual(corrected.event.facts.map(f => [f.id,f.value]), [["note","corrected"],["note","one"]]);
  assert.equal(corrected.corrections[0].factId, "note");
  assert.equal(corrected.corrections[0].clientEntityKey, b);
  assert.equal(activeCorrection(corrected,a),undefined);
  assert.equal(openQuestions(corrected).some(q => questionKey(q) === b),false);
  assert.equal(undoCorrection(corrected,b).event.facts[0].value,"two");
  for (const ref of ["note","ce_missing","missing"]) {
    assert.equal(toggleKept(corrected,ref),corrected);
    assert.equal(setFactValue(corrected,ref,"wrong"),corrected);
  }
  assert.equal(toggleProjectFact(corrected,"another-project",b),corrected);
  const foreign = stub([fact("note","foreign")]);
  assert.equal(toggleKept(corrected,factKey(foreign.event.facts[0])),corrected);
});

test("keys and local references survive persistence, account fold, and share roundtrip", () => {
  const memory = new Map();
  globalThis.localStorage = {getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
  const initial = stub([fact("note","one"),fact("note","two")]);
  const key = factKey(initial.event.facts[1]);
  const fixed = setHidden(applyCorrection(initial,{factId:key,value:"new"}),key,true);
  assert.equal(writeWall([fixed]),true);
  assert.deepEqual(loadWall()[0],fixed);
  assert.equal(writeWall(foldWall(loadWall(),[{...fixed,updatedAt:1}],[],2)),true);
  assert.deepEqual(loadWall()[0].event.facts,fixed.event.facts);
  assert.deepEqual(decodeStub(encodeStub(fixed)),fixed);
  assert.equal(activeCorrection(loadWall()[0],key).factId,"note");
});

test("failed legacy migration keeps memory-only keys stable and reports failed persistence", () => {
  const legacy = stub([fact("note","one"),fact("note","two")]);
  legacy.event.facts.forEach(f=>delete f.clientEntityKey);
  const raw = JSON.stringify([legacy]);
  globalThis.localStorage = {getItem:()=>raw,setItem:()=>{throw new DOMException("full","QuotaExceededError");}};
  const first = loadWall();
  assert.equal(writeWall(first),false);
  assert.deepEqual(loadWall(),first);
});

test("creative DTOs refuse ambiguous source IDs instead of inventing canonical mappings", () => {
  const ambiguous = stub([fact("note","one",true),fact("note","two",true)]);
  for (const make of [()=>toCreativeBrief(ambiguous,scope),()=>toBriefCreatePayload(ambiguous),()=>studioControls(ambiguous),()=>toEditPlan(ambiguous,{type:"setFactValue",factId:factKey(ambiguous.event.facts[1]),value:"new"},scope)]) {
    assert.throws(make,e=>e.code === "fact_identity_mapping_required");
  }
  assert.deepEqual(ambiguous.event.facts.map(f=>f.id),["note","note"]);
  assert.deepEqual(summarize(ambiguous).facts,[]);
  assert.equal(applyToStub(ambiguous,{type:"set_fact",field:"keep",value:"note"}).ok,false);
});

test("explicit unique-source creative mapping and provider projections omit local keys", () => {
  const local = stub([fact("note","one",true)]);
  const key = factKey(local.event.facts[0]);
  const hidden = setHidden(local,key,true);
  hidden.versions[0].context = { personal: {hiddenFields:[key]} };
  const brief = toCreativeBrief(local,scope);
  const controls = studioControls(hidden);
  const edit = toEditPlan(local,{type:"setFactValue",factId:key,value:"new"},scope);
  assert.equal(edit.plan.steps[0].parameters.fact_id,"note");
  assert.deepEqual(controls.find(c=>c.id==="hidden_facts").default_value,["note"]);
  for (const dto of [brief,controls,edit,sourceEvent(local.event),summarize(local)]) {
    assert.equal(JSON.stringify(dto).includes(key),false);
    assert.equal(JSON.stringify(dto).includes("clientEntityKey"),false);
  }
  const legacyHidden = structuredClone(hidden);
  delete legacyHidden.event.facts[0].clientEntityKey;
  legacyHidden.personal.hiddenFields = ["note"];
  legacyHidden.versions[0].context.personal.hiddenFields = ["note"];
  const rebound = structuredClone(hidden);
  rebound.event.facts[0].clientEntityKey = "ce_reallocated";
  rebound.personal.hiddenFields = ["ce_reallocated"];
  rebound.versions[0].context.personal.hiddenFields = ["ce_reallocated"];
  const art = {hash:"a".repeat(64),source:"ref"};
  assert.deepEqual(bindStub(hidden,"classic",art),bindStub(legacyHidden,"classic",art),"unique legacy binding survives key allocation");
  assert.deepEqual(bindStub(hidden,"classic",art),bindStub(rebound,"classic",art),"random local identity never enters approval binding");
});


test("unique legacy history binds without mutation, while inconsistent source/key history stays unresolved", () => {
  const s = stub([fact("note","one")]);
  const c = {id:"old",factId:"note",kind:"confirm",original:{...s.event.facts[0]},corrected:{value:"one",label:"one"}};
  s.corrections=[c];
  assert.equal(activeCorrection(s,factKey(s.event.facts[0])),c);
  assert.equal(unresolvedHistory(s),false);
  const foreign = {...c,factId:"other",clientEntityKey:factKey(s.event.facts[0])};
  const bad = {...s,corrections:[foreign]};
  assert.equal(activeCorrection(bad,factKey(s.event.facts[0])),undefined);
  assert.equal(unresolvedHistory(bad),true);
});

test("required duplicate-source questions also address distinct entities, and static title hiding stays static", () => {
  const s = stub([fact("date","2026-10-10"),fact("date","2026-10-11"),fact("title","Show")]);
  const dates = openQuestions(s).filter(q=>q.factId==="date");
  assert.deepEqual(dates.map(questionKey),s.event.facts.slice(0,2).map(factKey));
  const hidden = normalizeStubFacts({...s,personal:{...s.personal,hiddenFields:["title"]}});
  assert.deepEqual(hidden.personal.hiddenFields,["title"]);
});


test("approval review rows use local keys while their serialized summary omits client identity", () => {
  const s = stub([fact("note","one",true),fact("note","two",true)]);
  const keys = printedRowKeys(s);
  assert.equal(new Set(keys).size,keys.length);
  assert.deepEqual(keys.slice(-2),s.event.facts.map(factKey));
  const wire = JSON.stringify(printedSummary(s));
  assert.equal(wire.includes("clientEntityKey"),false);
  for (const key of s.event.facts.map(factKey)) assert.equal(wire.includes(key),false);
});


test("agent summary, proposal description and apply agree for empty/malformed IDs beside literal fact", () => {
  for (const id of ["", " ", "bad.id", "bad id", "<bad>", "x".repeat(41), "ce_local-looking", null, undefined, 17, {}, []]) {
    for (const reverse of [false,true]) {
      const incoming = [fact(id,"Unavailable row"),fact("fact","Literal source row")];
      const s = stub(reverse ? incoming.reverse() : incoming);
      const before = structuredClone(s);
      const unavailable = s.event.facts.find(f=>f.label==="Unavailable row");
      const literal = s.event.facts.find(f=>f.label==="Literal source row");
      const state = summarize(s);
      assert.deepEqual(state.facts.map(f=>[f.id,f.label]),[["fact","Literal source row"]]);
      assert.equal(parseRequest({schema:AGENT_SCHEMA,state,message:"Keep Literal source row"}).ok,true);
      const action = {type:"set_fact",field:"keep",value:"fact"};
      assert.equal(describeAction(action,state),"Keep Literal source row on the stub");
      const applied = applyToStub(s,action);
      assert.equal(applied.ok,true);
      assert.equal(applied.stub.event.facts.find(f=>factKey(f)===factKey(literal)).kept,true);
      assert.deepEqual(applied.stub.event.facts.find(f=>factKey(f)===factKey(unavailable)),unavailable);
      assert.equal(describeDone(action,summarize(applied.stub)),"Literal source row kept");
      assert.deepEqual(s,before,"boundary does not rewrite source IDs, provenance or local identity");
      assert.equal(openQuestions(s).some(q=>questionKey(q)===factKey(unavailable)),true,"omitted source remains discoverable in local review");
      assert.equal(toggleKept(s,factKey(unavailable)).event.facts.find(f=>factKey(f)===factKey(unavailable)).kept,true,"local entity control remains available");
    }
  }
});

test("unusable or duplicate source IDs create no agent aliases and refuse actions without changing local entities", () => {
  const s = stub([fact("","Empty row"),fact("bad.id","Malformed row"),fact("note","First note"),fact("note","Second note")]);
  const before = structuredClone(s);
  assert.deepEqual(summarize(s).facts,[]);
  for (const value of ["fact","bad.id","", "note", factKey(s.event.facts[0])]) assert.equal(applyToStub(s,{type:"set_fact",field:"keep",value}).ok,false);
  assert.deepEqual(s,before);
  const capped = stub([...Array.from({length:20},()=>fact("", "Unavailable")),fact("fact","Visible literal")]);
  assert.deepEqual(summarize(capped).facts.map(f=>f.id),["fact"],"omission happens before the summary cap");
});
