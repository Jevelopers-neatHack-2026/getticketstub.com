import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
    };
    return nextLoad(url, context);
  },
});
const { planArtFetch } = await import("../src/customer/studio/download/artSource.ts");
const BASE = "https://getticketstub.com/studio";

test("our own /api/art is fetched with credentials", () => {
  for (const src of ["/api/art", "/api/art/abc.png", "/api/art?id=1", "https://getticketstub.com/api/art/x"])
    assert.deepEqual(planArtFetch(src, BASE), { fetch: true, credentials: "same-origin" }, src);
});

test("public https pictures are fetched without credentials", () => {
  assert.deepEqual(planArtFetch("https://images.example.com/a.png", BASE), { fetch: true, credentials: "omit" });
});

test("a protocol-relative url to another host is an https picture, never ours: no credentials", () => {
  assert.deepEqual(planArtFetch("//evil.example/api/art", BASE), { fetch: true, credentials: "omit" });
});

test("data: urls, other same-origin paths, traversal, http and odd schemes are skipped", () => {
  for (const src of ["", "data:image/png;base64,AAAA", "/api/me", "/api/artifacts", "/api/art/../me", "/api/art/%2e%2e/me", "http://images.example.com/a.png", "javascript:alert(1)", "blob:https://getticketstub.com/x", "file:///etc/passwd", "relative/path.png"])
    assert.deepEqual(planArtFetch(src, BASE), { fetch: false }, src);
});
