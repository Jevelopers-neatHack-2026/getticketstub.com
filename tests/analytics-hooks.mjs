// Shared loader for the analytics tests: maps the "@/" alias to src/, resolves extensionless relative
// imports to .ts, and transpiles TypeScript on the fly (same approach as tests/feedback.test.mjs).
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const src = new URL("../src/", import.meta.url);

function tsFile(url) {
  for (const ext of [".ts", ".tsx"]) {
    const u = new URL(`${url.href}${ext}`);
    if (existsSync(fileURLToPath(u))) return u;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const u = tsFile(new URL(specifier.slice(2), src));
      if (u) return { url: u.href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const u = tsFile(new URL(specifier, context.parentURL));
      if (u) return { url: u.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.tsx?$/.test(new URL(url).pathname)) {
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
          fileName: fileURLToPath(url),
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

export const srcUrl = src;
export const toFileUrl = (p) => pathToFileURL(p).href;
