import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { metadataPagePath, metadataPageStatus } from "../scripts/lib/landing-metadata-checks.mjs";

// Load the real layout metadata and hardened HTTP helper. Only unrelated rendered
// children and build-time font loading are replaced; no server or network is needed.
const renderedChildren = {
  "@/customer/analytics/Analytics": "Analytics",
  "@/customer/analytics/config": "analyticsConfigFromEnv",
  "@/customer/nav/DemoPill": "DemoPill",
  "@/customer/nav/NavFrame": "NavFrame",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only" || specifier.endsWith(".css")) {
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    }
    if (specifier === "next/font/google") {
      return { url: "data:text/javascript,export const Fraunces=()=>({variable:''});export const Inter_Tight=Fraunces", shortCircuit: true };
    }
    if (Object.hasOwn(renderedChildren, specifier)) {
      return { url: `data:text/javascript,export const ${renderedChildren[specifier]}=()=>null`, shortCircuit: true };
    }
    if (specifier === "@/server/http") return { url: new URL("../src/server/http.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (/\.tsx?$/.test(url)) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
const { generateMetadata } = await import("../src/app/layout.tsx");
const originalAppUrl = process.env.APP_URL;
afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
});

test("social metadata uses the production default for absent or rejected APP_URL values", () => {
  for (const value of [undefined, "", "not a URL", "http://untrusted.example", "javascript:alert(1)", "data:text/html,fixture", "https://user:password@example.com"]) {
    if (value === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = value;
    assert.equal(generateMetadata().metadataBase.href, "https://getticketstub.com/", String(value));
  }
});

test("social metadata reads current trusted configuration and strips path, query and fragment", () => {
  for (const [value, expected] of [
    [" https://getticketstub.com/path?private=fixture#private ", "https://getticketstub.com/"],
    ["https://preview.example:8443/path", "https://preview.example:8443/"],
    ["http://localhost:43123/path", "http://localhost:43123/"],
    ["http://127.0.0.1:43123/path", "http://127.0.0.1:43123/"],
  ]) {
    process.env.APP_URL = value;
    assert.equal(generateMetadata().metadataBase.href, expected);
  }
});

test("social descriptions retain the approved digital price and preview-only print scope", () => {
  const metadata = generateMetadata();
  assert.equal(metadata.title, "TicketStub");
  assert.equal(metadata.openGraph.type, "website");
  assert.equal(metadata.openGraph.siteName, "TicketStub");
  assert.equal(metadata.openGraph.locale, "en_US");
  assert.equal(metadata.twitter.card, "summary_large_image");
  assert.equal(metadata.twitter.description, metadata.openGraph.description);
  assert.match(metadata.openGraph.description, /Digital keepsake from \$9; printed editions in preview/);
});

test("both generic social assets are valid 1200 by 630 PNGs with meaningful matching alt text", () => {
  const images = [];
  for (const name of ["opengraph-image", "twitter-image"]) {
    const bytes = readFileSync(new URL(`../src/app/${name}.png`, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.subarray(12, 16).toString(), "IHDR");
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
    const alt = readFileSync(new URL(`../src/app/${name}.alt.txt`, import.meta.url), "utf8");
    assert.match(alt, /TicketStub: Keep the night/);
    assert.match(alt, /personalized keepsake ticket stub on an orange disc/);
    images.push(bytes);
  }
  assert.deepEqual(images[0], images[1]);
});

test("metadata route sweep renders dynamic and optional catch-all pages at valid paths", () => {
  assert.equal(metadataPagePath("/page"), "/");
  assert.equal(metadataPagePath("/s/[token]/page"), "/s/zq_private_metadata_127");
  assert.equal(metadataPagePath("/admin/[[...path]]/page"), "/admin/zq_private_metadata_127");
  assert.equal(metadataPagePath("/example/[...segments]/page"), "/example/zq_private_metadata_127");
});

test("metadata sweep requires anonymous admin concealment without accepting missing public pages", () => {
  for (const path of ["/admin", "/admin/", "/admin/zq_private_metadata_127", "/admin/x/y"]) {
    assert.equal(metadataPageStatus(path), 404, path);
  }
  for (const path of ["/", "/account", "/s/zq_private_metadata_127", "/administrator", "/admin-public"]) {
    assert.equal(metadataPageStatus(path), 200, path);
  }
});
