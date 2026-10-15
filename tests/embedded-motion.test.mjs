import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(new URL(`../src/customer/${file}`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function hooks(file, name, permission) {
  let index = 0, reduced = false, id = 0, events = 0, disconnected = 0;
  const windowListeners = new Map();
  const cells = [], pendingEffects = [], frames = new Map(), listeners = new Map(), values = new Map();
  const react = {
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial }; },
    useCallback(fn, deps) { const i = index++, old = cells[i]; if (!old || deps.some((v,j) => v !== old.deps[j])) cells[i] = { fn, deps }; return cells[i].fn; },
    useEffect(effect, deps) { const i = index++, old = cells[i]; if (!old || deps.some((v,j) => v !== old.deps[j])) { pendingEffects.push(() => { old?.cleanup?.(); cells[i] = { deps, cleanup: effect() }; }); } },
  };
  const node = {
    style: { setProperty(k,v) { values.set(k,v); } },
    addEventListener(k,v) { listeners.set(k,v); }, removeEventListener(k,v) { if (listeners.get(k) === v) listeners.delete(k); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    dispatchEvent() { events++; }, querySelector: () => node,
  };
  node.parentElement = node;
  const ref = { current: node }, exports = {};
  const window = { matchMedia: () => ({ matches: false }), removeEventListener(k) { windowListeners.delete(k); }, addEventListener(k,v) { windowListeners.set(k,v); } };
  vm.runInNewContext(compile(file), { exports, window, document: { hidden: false }, performance: { now: () => 0 },
    DeviceOrientationEvent: permission ? Object.assign(class {}, { requestPermission: permission }) : undefined,
    IntersectionObserver: class { observe() {} disconnect() { disconnected++; } }, PointerEvent: class {},
    requestAnimationFrame(cb) { frames.set(++id,cb); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    require(name) { return name === 'react' ? react : { useReducedMotion: () => reduced }; },
  });
  const render = v => { reduced = v; index = 0; const result = exports[name](ref, true); pendingEffects.splice(0).forEach(run => run()); return result; };
  const tick = now => { for (const [id, cb] of [...frames]) { frames.delete(id); cb(now); } };
  return { render, tick, frames, listeners, values, windowListeners, events: () => events, disconnected: () => disconnected,
    cleanup() { for (const c of cells) c?.cleanup?.(); }, pointer(x = 95, y = 10) { listeners.get('pointermove')?.({ pointerType:'mouse', clientX:x, clientY:y }); } };
}

test('embedded idle sway cancels RAF/listeners/observer when motion is reduced and restarts once', () => {
  const env = hooks('start/useIdleSway.ts','useIdleSway');
  env.render(false); assert.equal(env.frames.size,1); env.tick(100); assert.equal(env.events(),1);
  const queued = [...env.frames.values()][0];
  env.render(true);
  assert.equal(env.frames.size,0); assert.equal(env.listeners.size,0); assert.equal(env.disconnected(),1);
  queued(200); assert.equal(env.frames.size,0); assert.equal(env.events(),1);
  env.render(false); assert.equal(env.frames.size,1); env.tick(300); assert.equal(env.events(),2);
  env.cleanup(); assert.equal(env.frames.size,0); assert.equal(env.listeners.size,0); assert.equal(env.disconnected(),2);
});
test('embedded tilt snaps to static reduced light and cancels queued input motion', () => {
  const env = hooks('studio/stub/useTilt.ts','useTilt');
  env.render(false); env.pointer(); assert.equal(env.frames.size,1); env.tick(100);
  assert.notEqual(env.values.get('--ry'),'0.000deg');
  const queued = [...env.frames.values()][0];
  env.render(true);
  assert.equal(env.frames.size,0); assert.equal(env.listeners.size,0);
  assert.equal(env.values.get('--rx'),'0.000deg'); assert.equal(env.values.get('--ry'),'0.000deg'); assert.equal(env.values.get('--glow'),'0.4500');
  queued(200); assert.equal(env.frames.size,0); assert.equal(env.values.get('--ry'),'0.000deg');
  env.render(false); env.pointer(); assert.equal(env.frames.size,1); env.tick(300); assert.notEqual(env.values.get('--ry'),'0.000deg');
  env.cleanup(); assert.equal(env.frames.size,0); assert.equal(env.listeners.size,0);
});
test('shared reduction combines landing off with OS reduction without overriding standalone OS preference', () => {
  let localOff = false, os = false;
  const listeners = new Set(), media = { get matches() { return os; }, addEventListener(_, fn) { listeners.add(fn); }, removeEventListener(_, fn) { listeners.delete(fn); } };
  let unsubscribe;
  const exports = {};
  vm.runInNewContext(compile('landing/MotionContext.tsx'), { exports, window: { matchMedia: () => media }, require: () => ({
    createContext: value => ({ defaultValue:value }), useContext: () => localOff,
    useSyncExternalStore(subscribe, snapshot, server) { unsubscribe?.(); unsubscribe = subscribe(() => {}); assert.equal(server(),false); return snapshot(); },
  }) });
  assert.equal(exports.MotionOffContext.defaultValue,false);
  for (const [local, system, expected] of [[false,false,false],[true,false,true],[false,true,true],[true,true,true],[false,false,false]]) {
    localOff=local; os=system; assert.equal(exports.useReducedMotion(),expected); assert.equal(listeners.size,1);
  }
  unsubscribe(); assert.equal(listeners.size,0);
});

for (const end of ['unmount','motion off']) test(`pending gyro permission cannot add listeners after ${end}`, async () => {
  let allow;
  const env = hooks('studio/stub/useTilt.ts','useTilt', () => new Promise(resolve => { allow = resolve; }));
  const control = env.render(false);
  const pending = control.requestGyro();
  assert.equal(typeof allow,'function');
  if (end === 'unmount') env.cleanup(); else env.render(true);
  allow('granted'); await pending;
  assert.equal(env.windowListeners.size,0);
  assert.equal(env.frames.size,0);
  env.cleanup();
});

test('desk actions keep sound and clicks while suppressing haptics under reduction', () => {
  const source = ts.createSourceFile('Desk.tsx', readFileSync(new URL('../src/customer/desk/Desk.tsx', import.meta.url),'utf8'), ts.ScriptTarget.Latest,true);
  const press = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'usePress');
  const code = ts.transpileModule(press.getText(source) + '\nexports.usePress=usePress;', { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText;
  let reduced=false, sounds=0, buzzes=0;
  const exports={};
  vm.runInNewContext(code, { exports, useReducedMotion:()=>reduced, useState:()=>[false,()=>{}], useCallback:fn=>fn, play:()=>sounds++, haptic:()=>buzzes++ });
  exports.usePress('tap',6).fire(); assert.equal(sounds,1); assert.equal(buzzes,1);
  reduced=true; exports.usePress('tap',6).fire(); assert.equal(sounds,2); assert.equal(buzzes,1);
});
