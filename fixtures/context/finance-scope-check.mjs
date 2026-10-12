// Checks a toFinanceScope() scope against cost-intelligence's TrustedScope. Two legs:
//   1. Always: the vendored schema (finance-trusted-scope.schema.json, source SHA in its $comment) through the small
//      JSON Schema subset the schema uses (object, required, additionalProperties, string min/max length, anyOf const).
//      It never skips, so a mapper regression fails everywhere.
//   2. When FINANCE_CONSUMER_DIR names a cost-intelligence checkout: the consumer's own TypeBox Value.Check, plus a
//      check that the vendored file still equals the consumer's TrustedScopeSchema (drift). If the variable is set and
//      the consumer cannot be loaded, that is an error, not a skip.
// Needs Node with TypeScript type stripping (22.18+) for leg 2, because the consumer's contracts are .ts.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { $comment, ...VENDORED } = JSON.parse(readFileSync(join(here, "finance-trusted-scope.schema.json"), "utf8"));
export const VENDORED_SCHEMA = VENDORED;

function check(schema, v) {
  if (schema.anyOf) return schema.anyOf.some((s) => check(s, v));
  if ("const" in schema) return v === schema.const;
  if (schema.type === "string") return typeof v === "string" && (schema.minLength === undefined || v.length >= schema.minLength) && (schema.maxLength === undefined || v.length <= schema.maxLength);
  if (schema.type === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if ((schema.required ?? []).some((k) => !(k in v))) return false;
    if (schema.additionalProperties === false && Object.keys(v).some((k) => !(k in schema.properties))) return false;
    return Object.entries(schema.properties).every(([k, s]) => !(k in v) || check(s, v[k]));
  }
  throw new Error(`finance-scope-check: unsupported schema keyword in ${JSON.stringify(schema)}`);
}

/** True when `scope` satisfies the vendored TrustedScope schema. */
export const checkVendored = (scope) => check(VENDORED, scope);

/**
 * Loads the consumer's TypeBox check from a cost-intelligence checkout (its node_modules must hold @sinclair/typebox).
 * Returns { check(scope), drift } where drift is true when the vendored file no longer equals the consumer's schema.
 * Throws when the checkout cannot be loaded.
 */
export async function loadConsumer(dir) {
  const contracts = join(dir, "src", "shared", "contracts.ts");
  if (!existsSync(contracts)) throw new Error(`FINANCE_CONSUMER_DIR ${dir}: no src/shared/contracts.ts`);
  const { Value } = createRequire(join(dir, "package.json"))("@sinclair/typebox/value");
  const { TrustedScopeSchema } = await import(pathToFileURL(contracts).href);
  return { check: (scope) => Value.Check(TrustedScopeSchema, scope), drift: !isDeepStrictEqual(JSON.parse(JSON.stringify(TrustedScopeSchema)), VENDORED) };
}
