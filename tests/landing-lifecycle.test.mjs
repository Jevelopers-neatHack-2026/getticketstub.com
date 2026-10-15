import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Exercise the real nested initializer with controllable module loads. No WebGL or network is needed:
// the mounted control deliberately stops after renderer allocation, before unrelated scene setup.
const path = new URL("../src/customer/landing/landing.script.ts", import.meta.url);
const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const initializers = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "build3D") initializers.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(initializers.length, 1, "the landing has one 3D initializer");
const initializer = initializers[0].getText(source).replace(/\bimport\(/g, "load(");
const initialize = new Function("env", "load", `with (env) { return (${initializer})(); }`);
const MODULES = ["three", "three/addons/loaders/GLTFLoader.js", "three/addons/environments/RoomEnvironment.js"];
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function renderUntilBoundary(pauseAt = null) {
  let created = 0;
  let disposed = 0;
  let release;
  let reached = false;
  const pause = new Promise((resolve) => { release = resolve; });
  const env = {
    disposed: false,
    disposers: [],
    listen: () => {},
    release3D: () => {},
    idles: new Set(),
    byId: () => ({ addEventListener() {} }),
    devicePixelRatio: 1,
    innerWidth: 390,
    innerHeight: 844,
  };
  const modules = {
    three: {
      WebGLRenderer: class {
        constructor() { created++; this.shadowMap = {}; }
        setPixelRatio() {}
        dispose() { disposed++; }
        forceContextLoss() {}
      },
      Scene: class { constructor() { throw new Error("mounted renderer reached scene setup"); } },
    },
    [MODULES[1]]: { GLTFLoader: class {} },
    [MODULES[2]]: { RoomEnvironment: class {} },
  };
  const load = async (name) => {
    assert.ok(Object.hasOwn(modules, name), `unexpected module: ${name}`);
    if (name === pauseAt) { reached = true; await pause; }
    return modules[name];
  };
  const pending = initialize(env, load).catch((error) => error.message);
  await nextTurn();
  const cleanup = () => {
    env.disposed = true;
    env.disposers.splice(0).reverse().forEach((stop) => stop());
  };
  if (pauseAt) {
    assert.equal(reached, true, `reached the pending ${pauseAt} import`);
    cleanup();
    release();
  }
  const result = await pending;
  const lateDisposers = env.disposers.length;
  if (!pauseAt) cleanup();
  return { result, created, disposed, lateDisposers };
}

for (const name of MODULES) {
  test(`landing: unmount while ${name} loads allocates no renderer or late cleanup`, async () => {
    assert.deepEqual(await renderUntilBoundary(name), {
      result: "unmounted", created: 0, disposed: 0, lateDisposers: 0,
    });
  });
}

test("landing: a mounted initializer allocates a renderer and registers working cleanup", async () => {
  assert.deepEqual(await renderUntilBoundary(), {
    result: "mounted renderer reached scene setup", created: 1, disposed: 1, lateDisposers: 1,
  });
});

async function assetBoundary({ failFlight = false } = {}) {
  const counts = { renderer: 0, lost: 0, pmrem: 0, room: 0, environment: 0, geometry: 0, material: 0, aborted: 0 };
  let gltfDone;
  const vec = { set() {}, setScalar() {} };
  class Light { constructor() { this.position = vec; this.target = {}; this.shadow = { mapSize: vec, camera: {} }; } }
  const environment = { dispose() { counts.environment++; } };
  const modules = {
    three: {
      WebGLRenderer: class { constructor() { this.shadowMap = {}; } setPixelRatio() {} dispose() { counts.renderer++; } forceContextLoss() { counts.lost++; } },
      Scene: class { add() {} traverse() {} },
      PMREMGenerator: class { fromScene() { return { texture: environment }; } dispose() { counts.pmrem++; } },
      DirectionalLight: Light, HemisphereLight: Light,
      PerspectiveCamera: class { constructor() { this.position = vec; } },
    },
    [MODULES[1]]: { GLTFLoader: class { load(_, success) { gltfDone = success; } } },
    [MODULES[2]]: { RoomEnvironment: class { dispose() { counts.room++; } } },
  };
  const env = {
    disposed: false, disposers: [], release3D: () => {}, idles: new Set(),
    byId: () => ({}), listen() {}, devicePixelRatio: 1, innerWidth: 390, innerHeight: 844,
    window: { cancelIdleCallback() {} }, AbortController, setTimeout() {}, setProgress() {},
    fetch(_, { signal }) {
      signal.addEventListener('abort', () => { counts.aborted++; });
      return failFlight ? Promise.reject(new Error('asset failed')) : Promise.resolve({ ok: true, json: async () => ({}) });
    },
  };
  const pending = initialize(env, async name => modules[name]).catch(err => { env.release3D(); return err.message; });
  await nextTurn();
  assert.equal(typeof gltfDone, 'function', 'initializer reached both pending asset loads');
  if (!failFlight) { env.disposed = true; env.disposers.splice(0).reverse().forEach(stop => stop()); }
  assert.equal(await pending, failFlight ? 'asset failed' : 'unmounted', 'cancellation settles without waiting for GLTF');
  gltfDone({ scenes: [{ traverse(cb) { cb({ geometry: { dispose() { counts.geometry++; } }, material: { dispose() { counts.material++; } } }); } }] });
  await nextTurn();
  env.release3D();
  return counts;
}
for (const failFlight of [false, true]) test(`landing: ${failFlight ? 'failed asset' : 'unmount during assets'} releases early 3D resources and late GLTF exactly once`, async () => {
  assert.deepEqual(await assetBoundary({ failFlight }), {
    renderer: 1, lost: 1, pmrem: 1, room: 1, environment: 1, geometry: 1, material: 1, aborted: 1,
  });
});
