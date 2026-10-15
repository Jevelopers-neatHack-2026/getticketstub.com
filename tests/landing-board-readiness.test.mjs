import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the actual board initializer and state reconciler before any static or 3D frame runs.
const source=ts.createSourceFile('landing.script.ts',readFileSync(new URL('../src/customer/landing/landing.script.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let run;
function find(node) { if (ts.isFunctionDeclaration(node) && node.name?.text==='run') run=node;ts.forEachChild(node,find); }
find(source);
const start=run.body.statements.find(node=>ts.isVariableStatement(node) && node.declarationList.declarations.some(d=>d.name.getText(source)==='root' && d.initializer?.getText(source)==='lpRoot'));
const reconcile=run.body.statements.find(node=>ts.isFunctionDeclaration(node) && node.name?.text==='boardState');
assert.ok(start && reconcile,'landing has a shared board initializer and reconciler');
const bindings=['root','boardEl','WALL','bhState'].map(name=>run.body.statements.find(node=>ts.isVariableStatement(node) && node.declarationList.declarations.some(d=>d.name.getText(source)===name)));
const firstState=run.body.statements.find(node=>ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source)==='boardState');
assert.ok(firstState,'board state is reconciled during initialization');
const fontWait=run.body.statements.find(node=>ts.isIfStatement(node) && node.thenStatement.getText(source).includes('await fontsReady'));
assert.ok(firstState.getStart(source)<fontWait.getStart(source),'board accessibility is established before font loading can suspend initialization');
const initialize=new Function('env',`with(env) { ${[...bindings,firstState,reconcile].map(node=>node.getText(source)).join('\n')};return boardState; }`);
const classes=(initial=[])=>{const values=new Set(initial);return {contains:v=>values.has(v),toggle(v,on){if(on)values.add(v);else values.delete(v);}};};
const visible={top:-4140,bottom:1460,height:5600};
const hidden={top:1500,bottom:7100,height:5600};
function board(bounds,{three=false}={}) {
  let inert=false,focused=false;const writes=[];
  const finale={classList:classes(),get inert(){return inert;},set inert(v){inert=v;writes.push(v);}};
  const nodes={wall:{getBoundingClientRect:()=>bounds},boardUI:{hidden:true,classList:classes()},finale,bh1:{classList:classes(),textContent:''}};
  const update=initialize({lpRoot:{classList:classes(three?[]:['no3d'])},byId:id=>nodes[id],innerHeight:1000});
  return {finale,writes,update,nodes,focus(){if(!inert)focused=true;},focused:()=>focused};
}
for (const three of [false,true]) test(`landing board visible maker is focusable synchronously before ${three?'3D':'static'} frames`,()=>{
  const env=board(visible,{three});
  assert.equal(env.finale.inert,false);assert.equal(env.finale.classList.contains('on'),true);
  env.focus();assert.equal(env.focused(),true);
  assert.ok(env.writes.every(v=>v===false),'visible initialization never temporarily makes the maker inert');
});
for (const bounds of [hidden,{top:-200,bottom:5400,height:5600}]) test(`landing board keeps an offscreen or early-board maker inert at top ${bounds.top}`,()=>{
  const env=board(bounds);
  assert.equal(env.finale.inert,true);assert.equal(env.finale.classList.contains('on'),false);
  env.focus();assert.equal(env.focused(),false);
});
test('landing board reconciles inert independently of whether the visibility class changed',()=>{
  const env=board(visible);env.finale.inert=true;env.update(visible,1000);
  assert.equal(env.finale.inert,false);
  env.update(hidden,1000);env.finale.inert=false;env.update(hidden,1000);
  assert.equal(env.finale.inert,true);
});

test('settled gallery layout is reconciled before the real board-ready callback, without waiting for renderer frames',()=>{
  const index=run.body.statements.findIndex(node=>ts.isIfStatement(node) && node.getText(source).includes('ctx.onBoardReady?.()'));
  assert.ok(index>0,'the initializer publishes board readiness');
  const settled=run.body.statements[index-1];
  assert.ok(settled.getText(source).startsWith('boardState('),'the current bounds are reconciled immediately before readiness');
  assert.ok(settled.getStart(source)>source.text.indexOf('fontsReady.then(refreshArt)'),'gallery art has been populated before the settled read');
  const notify=new Function('env',`with(env) { ${settled.getText(source)};${run.body.statements[index].getText(source)} }`);
  // The pre-font measurement hides the maker. Populating the ribbon subsequently moves it into view.
  const env=board(hidden);env.nodes.wall.getBoundingClientRect=()=>visible;let ready=0;
  const context={boardState:env.update,boardEl:env.nodes.wall,innerHeight:1000,disposed:false,ctx:{onBoardReady(){ready++;assert.equal(env.nodes.boardUI.hidden,false);assert.equal(env.finale.inert,false);env.focus();}}};
  notify(context);assert.equal(ready,1);assert.equal(env.focused(),true);
  context.disposed=true;notify(context);assert.equal(ready,1,'disposed initialization does not publish readiness');
});

test('landing board focus precedes the first static RAF and stopped queued frames leave state untouched',()=>{
  const declaration=run.body.statements.find(node=>ts.isFunctionDeclaration(node) && node.name?.text==='startStaticLoop');
  const startLoop=new Function('env',`with(env) { return (${declaration.getText(source)})(); }`);
  const env=board(visible);const frames=[],disposers=[];
  const context={ byId:()=>({classList:{add(){},remove(){}}}),scrollY:4140,qsa:()=>[],innerWidth:1280,innerHeight:1000,
    addEventListener(){},removeEventListener(){},requestAnimationFrame:fn=>frames.push(fn),STILL:false,navColour:()=>'',paintNav(){},
    boardEl:env.nodes.wall,fallbackBuilt:false,buildFallbackWall(){this.fallbackBuilt=true;},boardState:env.update,disposers };
  const control=startLoop(context);
  assert.equal(frames.length,1,'static motion schedules its first frame');
  env.focus();assert.equal(env.focused(),true,'the field is already focusable before that frame');
  const writes=env.writes.length;control.stop();frames[0]();
  assert.equal(env.writes.length,writes,'a queued frame after cleanup cannot rewrite inert or visibility');
  assert.equal(frames.length,1,'the stopped loop cannot schedule another frame');
});
