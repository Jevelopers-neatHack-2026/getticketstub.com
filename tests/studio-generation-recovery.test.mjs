import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import "./analytics-hooks.mjs";

// Synthetic storage and producers around the REAL controller, store, and Editor commit ordering.
// No React/browser/provider acceptance is implied; all network access is disabled.
class FakeStorage {
  values = new Map();
  readBlocked = false;
  writeBlocked = false;
  getItem(key) {
    if (this.readBlocked) throw new DOMException("synthetic unreadable storage", "SecurityError");
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    if (this.writeBlocked) throw new DOMException("synthetic blocked write", "SecurityError");
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}
const storage = new FakeStorage();
globalThis.localStorage = storage;
globalThis.window = Object.assign(new EventTarget(), { localStorage: storage,
  location: { origin: "https://synthetic.invalid", hostname: "synthetic.invalid", pathname: "/", search: "" } });
globalThis.fetch = () => { throw new Error("This synthetic control must not access a network."); };
const store = await import("../src/customer/studio/store.ts");
const { GenerationController, editorHost } = await import("../src/customer/studio/generation/operations.ts");
const turn = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
const makeStub = (id = "generation-recovery") => ({
  id, createdAt: "2026-10-01T00:00:00.000Z", event: { type: "concert", title: "Synthetic fixture", facts: [] },
  versions: [{ id: "v0", edition: "researched", art: { kind: "procedural", seed: 1, provenance: "simulated" }, createdAt: "2026-10-01T00:00:00.000Z" }],
  currentVersionId: "v0", personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [], friends: [] },
  material: "card", finish: "matte", torn: false, wallAngle: 0, photos: [],
});
function openEditor() {
  const ed = { stub: makeStub(), revision: 0, commits: 0, requests: 0, pending: [], throwAt: null };
  storage.setItem(store.WALL_STORAGE_KEY, JSON.stringify([ed.stub]));
  ed.gen = new GenerationController(editorHost({ get current() { return ed.stub; } }, { get current() { return ed.revision; } }, (next, options) => {
    if (ed.throwAt === "before_live") throw new Error("synthetic host failure before its update");
    // Exactly the production Editor order: live ref/state first, then its real local save.
    ed.stub = next; ed.revision++; ed.commits++;
    if (ed.throwAt === "after_live") throw new Error("synthetic host failure after its update");
    const saved = options?.persist === false ? false : store.upsertStub(next);
    if (ed.throwAt === "after_save") throw new Error("synthetic host failure after its save");
    return saved;
  }, () => false, store.stubPresence), storage);
  ed.gen.attach();
  ed.start = () => {
    const result = { settled: false, value: null };
    result.promise = ed.gen.start({ via: "sheet", run: () => { ed.requests++; return new Promise((resolve, reject) => ed.pending.push({ resolve, reject })); } });
    result.promise.then((value) => { result.settled = true; result.value = value; });
    return result;
  };
  ed.succeed = () => ed.pending.shift().resolve({ art: { kind: "procedural", seed: 2, provenance: "simulated" } });
  return ed;
}
beforeEach(() => {
  storage.values.clear(); storage.readBlocked = false; storage.writeBlocked = false;
});

const corruptions = {
  "selected history is not an array": (wall) => { wall[0].versions = {}; },
  "selected matching version has no art": (wall) => { delete wall[0].versions[0].art; },
  "another project's history is not iterable": (wall) => { wall.push({ ...makeStub("other"), versions: {} }); },
  "another project is null": (wall) => { wall.push(null); },
  "another version's source is not a string": (wall) => {
    const other = makeStub("other");
    other.versions.push({ ...other.versions[0], id: "old", art: { kind: "image", src: 42, seed: 3, provenance: "simulated" } });
    wall.push(other);
  },
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`completed generation holds without writing when ${name}`, async () => {
  const ed = openEditor();
  try {
    const result = ed.start(), wall = [structuredClone(ed.stub)]; corrupt(wall);
    const raw = JSON.stringify(wall), draft = JSON.stringify(ed.stub);
    storage.setItem(store.WALL_STORAGE_KEY, raw);
    ed.succeed(); await turn();
    assert.equal(result.settled, true, "the completed producer must settle the operation");
    assert.equal(result.value.op.phase, "ready");
    assert.match(result.value.op.message, /storage can't be read/);
    assert.equal(ed.commits, 0); assert.equal(JSON.stringify(ed.stub), draft);
    assert.equal(storage.getItem(store.WALL_STORAGE_KEY), raw, "never normalize or replace unknown stored bytes");
    const applied = ed.gen.apply(result.value.op.runId);
    assert.equal(applied.phase, "applied"); assert.equal(applied.saved, false);
    assert.equal(ed.commits, 1); assert.equal(ed.stub.versions.length, 2);
    assert.equal(storage.getItem(store.WALL_STORAGE_KEY), raw, "explicit memory-only Apply still cannot write that wall");
    ed.gen.apply(result.value.op.runId); assert.equal(ed.commits, 1);
  } finally { ed.gen.detach(); }
});

test("valid storage recovery preserves the memory-only version and performs one new explicit request", async () => {
  const ed = openEditor();
  try {
    const original = structuredClone(ed.stub), held = ed.start();
    storage.setItem(store.WALL_STORAGE_KEY, JSON.stringify([{ ...original, versions: {} }]));
    ed.succeed(); await turn();
    assert.equal(held.settled, true); assert.equal(held.value.op.phase, "ready");
    ed.gen.apply(held.value.op.runId);
    const unsaved = structuredClone(ed.stub.versions[1]);
    storage.setItem(store.WALL_STORAGE_KEY, JSON.stringify([original, makeStub("other")]));
    const next = ed.start(); ed.succeed(); await turn();
    assert.equal(next.value.op.phase, "applied"); assert.equal(next.value.op.saved, true);
    assert.equal(ed.requests, 2);
    const saved = JSON.parse(storage.getItem(store.WALL_STORAGE_KEY));
    assert.deepEqual(saved.find((s) => s.id === original.id).versions[1], unsaved);
    assert.equal(saved.find((s) => s.id === original.id).versions.length, 3);
    assert.ok(saved.some((s) => s.id === "other"));
  } finally { ed.gen.detach(); }
});

test("a valid legacy history without context and a retained unavailable picture remain usable", async () => {
  const ed = openEditor();
  try {
    const other = makeStub("other");
    other.versions.push({ id: "released", parentId: "v0", edition: "researched", createdAt: "2026-09-01T00:00:00.000Z",
      art: { kind: "procedural", seed: 3, provenance: "live", unavailable: true } });
    storage.setItem(store.WALL_STORAGE_KEY, JSON.stringify([ed.stub, other]));
    const result = ed.start(); ed.succeed(); await turn();
    assert.equal(result.value.op.phase, "applied"); assert.equal(result.value.op.saved, true);
    assert.deepEqual(JSON.parse(storage.getItem(store.WALL_STORAGE_KEY)).find((s) => s.id === "other"), other);
  } finally { ed.gen.detach(); }
});

for (const throwAt of ["before_live", "after_live", "after_save"]) test(`a ${throwAt} host failure settles with no false unchanged/saved claim and no replayable request`, async () => {
  const ed = openEditor();
  try {
    ed.throwAt = throwAt;
    const result = ed.start(); ed.succeed(); await turn();
    assert.equal(result.settled, true);
    const op = result.value.op;
    assert.equal(op.phase, "interrupted"); assert.equal(op.code, "commit_unknown");
    assert.match(op.message, /couldn't confirm whether.*applied or saved/i);
    assert.doesNotMatch(op.message, /unchanged|not saved|was saved|not made|cancelled|canceled/i);
    assert.equal(op.saved, undefined);
    assert.equal(ed.stub.versions.length, throwAt === "before_live" ? 1 : 2);
    assert.equal(JSON.parse(storage.getItem(store.WALL_STORAGE_KEY))[0].versions.length, throwAt === "after_save" ? 2 : 1);
    const before = JSON.stringify(ed.stub), raw = storage.getItem(store.WALL_STORAGE_KEY), commits = ed.commits;
    assert.equal(ed.gen.canRetry(op.runId), false); assert.equal(ed.gen.retry(op.runId), null);
    ed.gen.apply(op.runId); ed.gen.cancel(op.runId); ed.gen.discard(op.runId);
    assert.equal(ed.requests, 1); assert.equal(ed.commits, commits);
    assert.equal(JSON.stringify(ed.stub), before); assert.equal(storage.getItem(store.WALL_STORAGE_KEY), raw);
  } finally { ed.gen.detach(); }
});

test("a retained ready candidate is invalidated when explicit Apply cannot confirm its host commit", async () => {
  const ed = openEditor();
  try {
    const result = ed.start(); storage.readBlocked = true;
    ed.succeed(); await turn(); storage.readBlocked = false;
    assert.equal(result.value.op.phase, "ready");
    ed.throwAt = "after_live";
    const op = ed.gen.apply(result.value.op.runId);
    assert.equal(op.phase, "interrupted"); assert.equal(op.code, "commit_unknown");
    assert.equal(ed.gen.canRetry(op.runId), false); assert.equal(ed.gen.retry(op.runId), null);
    const commits = ed.commits; ed.gen.apply(op.runId);
    assert.equal(ed.commits, commits); assert.equal(ed.stub.versions.length, 2);
  } finally { storage.readBlocked = false; ed.gen.detach(); }
});

test("an unexpected settlement error cannot leave a pending or replayable operation", async () => {
  const ed = openEditor();
  try {
    const result = ed.start(), raw = storage.getItem(store.WALL_STORAGE_KEY);
    // Explicit transport-contract fault injection: a fulfilled producer supplies no usable result.
    ed.pending.shift().resolve(null); await turn();
    assert.equal(result.settled, true); assert.equal(result.value.op.phase, "interrupted");
    assert.equal(result.value.op.code, "commit_unknown");
    assert.equal(ed.gen.canRetry(result.value.op.runId), false); assert.equal(ed.gen.retry(result.value.op.runId), null);
    assert.equal(ed.commits, 0); assert.equal(storage.getItem(store.WALL_STORAGE_KEY), raw);
    assert.doesNotMatch(result.value.op.message, /art finished|was saved|not saved|unchanged/i);
  } finally { ed.gen.detach(); }
});

test("blocked writes on a readable valid wall still report applied-in-memory and unsaved", async () => {
  const ed = openEditor();
  try {
    const raw = storage.getItem(store.WALL_STORAGE_KEY), result = ed.start();
    storage.writeBlocked = true; ed.succeed(); await turn(); storage.writeBlocked = false;
    assert.equal(result.value.op.phase, "applied"); assert.equal(result.value.op.saved, false);
    assert.match(result.value.op.message, /could not be saved/);
    assert.equal(ed.stub.versions.length, 2); assert.equal(storage.getItem(store.WALL_STORAGE_KEY), raw);
  } finally { storage.writeBlocked = false; ed.gen.detach(); }
});
