import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// The server wall sync against a real (in-memory) SQLite: a device that had to release an older picture must not
// take it from the account's copy, even when one request carries the same stub more than once.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const file = fileURLToPath(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url));
      if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
    }
    return nextLoad(url, context);
  },
});

const { openDatabase, SqliteStorage } = await import("../src/server/sqlite.ts");

const FILE = (c) => `/api/files/${c.repeat(64)}.png`;
const version = (id, n, art) => ({ id, edition: "researched", art: { kind: "image", src: FILE(String(n)), seed: n, provenance: "live", ...art }, createdAt: `2026-10-01T00:0${n}:00.000Z` });
const stub = (updatedAt, arts = {}) => ({
  id: "s1",
  createdAt: "2026-10-01T00:00:00.000Z",
  event: { type: "concert", title: "T", facts: [] },
  versions: [version("v0", 0, arts.v0), version("v1", 1, arts.v1), version("v2", 2, arts.v2)],
  currentVersionId: "v2",
  personal: { titleFont: 0, titleColor: "", foilTitle: false, hiddenFields: [], friends: [] },
  material: "card",
  finish: "matte",
  torn: false,
  wallAngle: 0,
  photos: [],
  updatedAt,
});
const released = { kind: "procedural", src: undefined, unavailable: true };

async function fresh() {
  const storage = new SqliteStorage(openDatabase(":memory:"));
  const account = await storage.findOrCreateAccount("sync@example.com", 1);
  await storage.syncWall(account.id, [stub(10)], [], 10);
  return { storage, id: account.id };
}

test("a released picture does not overwrite the account's copy", async () => {
  const { storage, id } = await fresh();
  const w = await storage.syncWall(id, [stub(20, { v0: released })], [], 20);
  assert.equal(w.stubs[0].versions[0].art.src, FILE("0"));
  assert.equal(w.stubs[0].versions[0].art.unavailable, undefined);
  assert.equal(w.stubs[0].updatedAt, 20);
});

test("two entries for the same stub in one request: the later one is filled from the earlier write, not stale data", async () => {
  const { storage, id } = await fresh();
  // the first entry replaces v1's picture; the newer second entry has released v1: it must get the first entry's picture
  const w = await storage.syncWall(id, [stub(20, { v1: { src: FILE("5") } }), stub(30, { v0: released, v1: released })], [], 30);
  const [s] = w.stubs;
  assert.equal(s.updatedAt, 30);
  assert.equal(s.versions[0].art.src, FILE("0"));
  assert.equal(s.versions[1].art.src, FILE("5"));
});
