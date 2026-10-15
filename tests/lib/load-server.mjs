// Loads a real server module (server-only, "@/" aliases, TypeScript) under plain Node with a resolve/load hook: no mocks,
// only module resolution and type stripping. The same hook tests/order-authorization.test.mjs uses for readConsumerJson.
import { register } from "node:module";

let registered = false;
export async function loadServerModule(rel) {
  if (!registered) {
    const hook = `
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = ${JSON.stringify(`${process.cwd()}/src/`)};
export async function load(url, ctx, next) {
  if (url.startsWith("file:") && url.endsWith(".ts")) return { format: "module", source: (await import("node:module")).stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }), shortCircuit: true };
  return next(url, ctx);
}
export async function resolve(spec, ctx, next) {
  if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  if (spec === "next/server") return next("next/server.js", ctx);
  let p = null;
  if (spec.startsWith("@/")) p = root + spec.slice(2);
  else if (spec.startsWith(".") && ctx.parentURL?.startsWith("file:")) p = fileURLToPath(new URL(spec, ctx.parentURL));
  if (p) for (const c of [p + ".ts", p + ".tsx", p + "/index.ts"]) if (existsSync(c)) return next(pathToFileURL(c).href, ctx);
  return next(spec, ctx);
}`;
    register(`data:text/javascript,${encodeURIComponent(hook)}`);
    registered = true;
  }
  return import(new URL(`../../${rel}`, import.meta.url).href);
}

const ENV_NAMES = ["NODE_ENV", "TICKETSTUB_RUNTIME_MODE", "APPROVAL_SIGNING_KEYS", "ORDER_AUTH_SIGNING_KEYS", "CONTEXT_SECRET", "ORDER_AUTH_CONSUMER_KEY"];

/** Runs fn(signingKeysModule, loggedLines) with exactly `env` set for the signing-key variables, then restores them. */
export async function withSigningEnv(env, fn) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  for (const n of ENV_NAMES) if (env[n] === undefined) delete process.env[n]; else process.env[n] = env[n];
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return await fn(await loadServerModule("src/server/signing-keys.ts"), lines);
  } finally {
    console.error = orig;
    for (const n of ENV_NAMES) if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
  }
}
