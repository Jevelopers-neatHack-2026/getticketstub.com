import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const file = readFileSync(new URL('../src/customer/landing/landing.script.ts', import.meta.url), 'utf8');
// Keep the real mount's resource wrappers and cleanup, exposing their handles instead of constructing the art/scene.
const isolated = file.slice(0, file.indexOf('  async function run() {')) +
  `  ctx.expose({ M, nativeAnimate, listen, requestAnimationFrame, requestIdleCallback, setTimeout, setInterval });\n` +
  file.slice(file.indexOf('  return () => {\n    disposed = true;'));
const code = ts.transpileModule(isolated, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function ownedEnv(mode = {}) {
  let handles, id = 0, updates = 0, stops = 0, canceled = 0;
  const pending = { raf: new Map(), idle: new Map(), timer: new Map() }, canceledIds = [];
  const makeScheduler = kind => cb => { pending[kind].set(++id, cb); return id; };
  const mediaStops = [];
  const window = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: makeScheduler('raf'), requestIdleCallback: makeScheduler('idle'),
    setTimeout: makeScheduler('timer'), setInterval: makeScheduler('timer'),
    cancelAnimationFrame: n => canceledIds.push(n), cancelIdleCallback: n => canceledIds.push(n), clearTimeout: n => canceledIds.push(n), clearInterval() {},
  };
  const controls = [];
  const animate = (...args) => {
    const callbacks = [];
    const control = { stop() { stops++; }, then(cb) { callbacks.push(cb); }, finish() { callbacks.forEach(cb => cb()); }, args };
    controls.push(control); return control;
  };
  const loader = { hidden: false, classList: { add() {} } }, classes = new Set();
  const root = { classList: { toggle() {}, add(...v) { v.forEach(c => classes.add(c)); } }, querySelector: () => loader };
  const exports = {};
  vm.runInNewContext(code, { exports, window, require: () => ({ animate, stagger() {}, inView: () => () => mediaStops.push('inView'), scroll: () => () => mediaStops.push('scroll') }) });
  const stop = exports.mountLanding({ root, hosts: [], mode, expose(v) { handles = v; } });
  return { handles, stop, pending, controls, loader, classes, canceledIds, mediaStops, onUpdate: () => { updates++; }, updates: () => updates, stops: () => stops, canceled: () => canceled,
    native: { animate: () => ({ cancel() { canceled++; }, finished: new Promise(() => {}) }) } };
}
test('landing owned work: cleanup stops animation controllers, native animations, scheduled work and observers', () => {
  const env = ownedEnv();
  const h = env.handles;
  h.M.animate(0, 1, { onUpdate: env.onUpdate });
  h.nativeAnimate(env.native, [], {});
  h.M.inView({}); h.M.scroll({});
  h.requestAnimationFrame(env.onUpdate); h.requestIdleCallback(env.onUpdate); h.setTimeout(env.onUpdate, 1); h.setInterval(env.onUpdate, 1);
  env.stop();
  assert.equal(env.stops(), 1);
  assert.equal(env.canceled(), 1);
  assert.equal(env.canceledIds.length, 4);
  assert.deepEqual(env.mediaStops.sort(), ['inView', 'scroll']);
  for (const map of Object.values(env.pending)) for (const cb of map.values()) cb(0);
  env.controls[0].args[2].onUpdate(1);
  assert.equal(env.updates(), 0, 'late queued callbacks cannot change the disposed landing');
  h.M.animate(0, 1, {}); h.setTimeout(env.onUpdate, 1); h.requestIdleCallback(env.onUpdate);
  assert.equal(env.controls.length, 1, 'late continuations cannot start more animations');
  assert.equal(env.pending.timer.size, 2);
});
test('landing owned work: completed animation controls leave the cleanup set', () => {
  const env = ownedEnv();
  env.handles.M.animate(0, 1, {});
  env.controls[0].finish(); env.stop();
  assert.equal(env.stops(), 0);
});
test('landing owned work: every DOM listener is removed on cleanup', () => {
  const env = ownedEnv(); let add, remove;
  const target = { addEventListener(...a) { add = a; }, removeEventListener(...a) { remove = a; } };
  env.handles.listen(target, 'load', env.onUpdate, { once: true }); env.stop();
  assert.deepEqual(remove, add);
});
for (const mode of [{ no3d: true }, { still: true }]) test(`landing owned work: ${JSON.stringify(mode)} is ready and hides its loader synchronously`, () => {
  const env = ownedEnv(mode);
  assert.ok(env.classes.has('ready')); assert.ok(env.classes.has('no3d')); assert.equal(env.loader.hidden, true);
  env.stop();
});
