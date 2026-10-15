import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the real checkout initializer, including fromText/show, with an existing restored input value.
const source=ts.createSourceFile('landing.script.ts',readFileSync(new URL('../src/customer/landing/landing.script.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let initializer;
function find(node) {
  if (ts.isArrowFunction(node) && node.getText(source).includes("const form = byId('maker')") && node.getText(source).includes('const NOTE_DEFAULT')) initializer=node;
  ts.forEachChild(node,find);
}
find(source);
assert.ok(initializer,'landing has a checkout initializer');
const initialize=new Function('env',`with(env) { (${initializer.getText(source)})(); }`);
function maker(value) {
  const classes=new Set(), painted=[];
  let timers=0, buzzes=0, submitted=0;
  const st={ classList:{ remove(){},add(){ assert.fail('quiet draft restoration must not start a printing proof'); } },insertAdjacentHTML(){} };
  const nodes={ maker:{},ev:{value},finCard:{appendChild(){}},finNote:{textContent:'Ready'},finale:{classList:{add(name){classes.add(name);},toggle(name,on){if(on)classes.add(name);else classes.delete(name);}} },finStatus:{classList:{add(){assert.fail('draft restoration must not activate printing status');}},lastChild:{textContent:'Ready'}} };
  const TS={ NIGHTS:{},still:false,fine:false,card:()=>st,paint:(_,d)=>painted.push(d),buzz:()=>buzzes++ };
  initialize({TS,byId:id=>nodes[id],qsa:()=>[],listen(){},matchMedia:()=>({matches:false}),clearTimeout(){},setTimeout(){timers++;},ctx:{submit(){submitted++;}}});
  return { classes,painted,timers,buzzes,submitted,TS,input:nodes.ev };
}
test('landing checkout initializes a restored draft preview quietly',()=>{
  const value='Nova Riot, Dublin, July 12';
  const env=maker(value);
  assert.equal(env.input.value,value);
  assert.equal(env.painted.length,1);
  assert.deepEqual(env.painted[0],env.TS.fromText(value));
  assert.notEqual(env.painted[0].a,'Your night here');
  assert.ok(env.classes.has('typing'));
  assert.equal(env.timers,0);assert.equal(env.buzzes,0);assert.equal(env.submitted,0);
});
test('landing checkout leaves empty initial markup and its blank preview unchanged',()=>{
  const env=maker('');
  assert.equal(env.painted.length,0);assert.equal(env.classes.has('typing'),false);
  assert.equal(env.timers,0);assert.equal(env.buzzes,0);assert.equal(env.submitted,0);
});
