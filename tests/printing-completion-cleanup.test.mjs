import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the actual Printing lifecycle effect with controlled timers and its ordinary completion callback.
const source = ts.createSourceFile('Printing.tsx', readFileSync(new URL('../src/customer/studio/research/Printing.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let lifecycle;
function find(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source)==='useEffect' && node.arguments[0]?.getText(source).includes('const skipTimer')) lifecycle=node.arguments[0];
  ts.forEachChild(node,find);
}
find(source);
assert.ok(lifecycle,'Printing has one timed completion lifecycle');
const effect = ts.transpileModule(lifecycle.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const mount = new Function('env',`with(env) { return (${effect.replace(/;\s*$/,'')})(); }`);
function scenario() {
  let id=0, completion=0, navigation=0;
  const timers=new Map(), intervals=new Map(), scheduled=[];
  const window={ setTimeout(fn,ms) { scheduled.push(fn); timers.set(++id,{fn,ms}); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval(fn) { intervals.set(++id,fn); return id; }, clearInterval(id) { intervals.delete(id); } };
  const cleanup=mount({ window, Date, startRef:{current:0}, finishingRef:{current:false}, begunRef:{current:null}, clock:()=>0, flow(){}, entry:'home', source:'demo', play(){}, schedule:[], SKIP_AFTER_MS:3000, SETTLE_MS:750, MIN_MS:2500, DWELL_MS:1600,
    setShowSkip(){}, eventRef:{current:{title:'Night',facts:[]}}, keptRef:{current:{}}, keyOf:()=>'', stopPrint(){}, reducedRef:{current:false}, haptic(){}, setSettling(){}, since:()=>0, researchedAt:{current:null},
    onDoneRef:{current:()=>{completion++;navigation++;}}, skipRef:{current:true}, shownRef:{current:0}, deadlineRef:{current:null}, extendDeadline() {},
  });
  const tick=[...intervals.values()][0]; tick(); // A settled result is ready and the visitor chooses to finish.
  const settle=[...timers.entries()].find(([,timer])=>timer.ms===750);
  assert.ok(settle,'finish scheduled its normal settling delay');
  return { cleanup,tick,settle:()=>{ timers.delete(settle[0]); settle[1].fn(); },scheduled,timers,intervals,completion:()=>completion,navigation:()=>navigation };
}
test('Printing mounted completion invokes its callback exactly once and cleanup clears timers',()=>{
  const env=scenario();
  env.settle(); assert.equal(env.completion(),1); assert.equal(env.navigation(),1);
  env.tick(); assert.equal(env.completion(),1);
  env.cleanup(); assert.equal(env.timers.size,0); assert.equal(env.intervals.size,0);
});
test('Printing teardown during settling prevents completion or navigation, including queued callbacks',()=>{
  const env=scenario();
  env.cleanup(); assert.equal(env.timers.size,0); assert.equal(env.intervals.size,0);
  env.tick(); env.settle(); for (const fn of env.scheduled) fn();
  assert.equal(env.completion(),0); assert.equal(env.navigation(),0); assert.equal(env.timers.size,0); assert.equal(env.intervals.size,0);
});
