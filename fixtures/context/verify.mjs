// Reference verifier for ticketstub.context/1 and /2 tokens. The scope projection is shared with
// src/server/finance-scope.ts; consumers copying this fixture must include that pure module.
//   node fixtures/context/verify.mjs        checks every fixture in this folder (and v2/) against its expected outcome
// verifyContext(token, key, { now, state, audience }) -> { ok: true, ctx } | { ok: false, reason }
// toFinanceScope(ctx) -> versioned adapter result for cost-intelligence's TrustedScope (see its comment).
// reason is one of: unknown | forged | stale | revoked | expired | unsupported_version | wrong_audience
// Without `state` it proves signature, version, shape and expiry only. Stale and revoked need the issuer's current
// answer: { membershipRevision, sessionLive, projectMember? } for the token's account (see README.md).
// The shape rules are the same ones src/server/context-token.ts runs; tests/finance-context.test.mjs holds the two
// to identical answers on every malformed input, and scripts/check-finance-context.mjs does so against the live route.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCHEMA_V1 = "ticketstub.context/1";
const SCHEMA_V2 = "ticketstub.context/2";
const ROLES = ["owner", "captain", "member", "viewer", "staff", "none"];
const ENVIRONMENTS = ["development", "preview", "live"];
const MODES_V1 = ["fixture", "sandbox", "live"];
const ECONOMIC = ["none", "sandbox", "paid_test", "live"];
const EVIDENCE = ["fixture", "synthetic", "live"];
export const FINANCE_CAPS = [
  "finance.read",
  "finance.export",
  "finance.command.budget_change",
  "finance.command.expense_adjust",
  "finance.command.reservation",
  "finance.command.reconcile",
  "finance.command.recovery",
];
const ID_RE = /^[\w.:-]{1,128}$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v !== "";
// An enum member. A value must BE a string first: an array or object that would stringify to a member is not one.
const oneOf = (list, v) => typeof v === "string" && list.includes(v);
const dec = (s) => Buffer.from(s, "base64url");

const modesConsistent = (environment, economic) => (environment === "live" ? economic !== "paid_test" : economic !== "live");

function shapedCommon(c) {
  if (!isObj(c.tenant) || !nonEmpty(c.tenant.id) || !oneOf(ROLES, c.role)) return false;
  if (!Array.isArray(c.capabilities) || !c.capabilities.every((x) => typeof x === "string")) return false;
  if (!Number.isInteger(c.membershipRevision) || typeof c.revoked !== "boolean") return false;
  return typeof c.issuedAt === "string" && typeof c.expiresAt === "string" && !Number.isNaN(Date.parse(c.issuedAt)) && !Number.isNaN(Date.parse(c.expiresAt));
}

function shapedV1(c) {
  if (!isObj(c.actor) || !shapedCommon(c)) return false;
  if (!oneOf(["account", "guest", "anonymous"], c.actor.kind)) return false;
  if (c.actor.kind !== "anonymous" && !nonEmpty(c.actor.id)) return false;
  if (!oneOf(ENVIRONMENTS, c.environment) || !oneOf(MODES_V1, c.mode)) return false;
  return c.project === undefined || (isObj(c.project) && typeof c.project.id === "string" && ID_RE.test(c.project.id) && oneOf(["stub", "event"], c.project.kind));
}

function shapedV2(c) {
  if (!isObj(c.actor) || !shapedCommon(c) || !nonEmpty(c.issuer) || !nonEmpty(c.audience) || c.audience.length > 128) return false;
  const kind = c.actor.kind;
  if (kind !== "account" && kind !== "guest" && kind !== "anonymous") return false;
  // Injective: the id carries its kind, and the tenant is the same string.
  const id = c.actor.id;
  const idOk = kind === "anonymous" ? id === "anonymous:0" : typeof id === "string" && id.startsWith(`${kind}:`) && ID_RE.test(id.slice(kind.length + 1));
  if (!idOk || c.tenant.id !== id) return false;
  if (!oneOf(ENVIRONMENTS, c.environment) || !oneOf(ECONOMIC, c.economicMode) || !oneOf(EVIDENCE, c.evidenceMode)) return false;
  if (!modesConsistent(c.environment, c.economicMode)) return false;
  const fin = c.capabilities.filter((x) => x.startsWith("finance."));
  if (fin.length > 0 && (kind !== "account" || !fin.every((x) => FINANCE_CAPS.includes(x)))) return false;
  const p = c.project;
  return p === undefined || (isObj(p) && typeof p.id === "string" && ID_RE.test(p.id) && (p.kind === "stub" || p.kind === "event") && p.ref === `${p.kind}:${p.id}`);
}

export function verifyContext(token, key, { now = Date.now(), state, audience } = {}) {
  if (typeof token !== "string" || token.length > 8192) return { ok: false, reason: "unknown" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "unknown" };
  let head, body;
  try {
    head = JSON.parse(dec(parts[0]).toString("utf8"));
    body = JSON.parse(dec(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, reason: "unknown" };
  }
  if (!isObj(head) || head.alg !== "HS256" || head.typ !== "ticketstub.context" || !isObj(body)) return { ok: false, reason: "unknown" };
  const want = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const got = dec(parts[2]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "forged" };
  const c = body.ctx;
  if (!isObj(c)) return { ok: false, reason: "unknown" };
  if (c.schema !== SCHEMA_V1 && c.schema !== SCHEMA_V2) return { ok: false, reason: "unsupported_version" };
  if (c.schema === SCHEMA_V1 ? !shapedV1(c) : !shapedV2(c)) return { ok: false, reason: "unknown" };
  const v2 = c.schema === SCHEMA_V2;
  if (Date.parse(c.expiresAt) <= now) return { ok: false, reason: "expired" };
  if (v2 && (typeof audience !== "string" || audience === "" || c.audience !== audience)) return { ok: false, reason: "wrong_audience" };
  if (c.revoked || state?.sessionLive === false || (v2 && state?.projectMember === false)) return { ok: false, reason: "revoked" };
  if (state?.membershipRevision !== undefined && state.membershipRevision !== c.membershipRevision) return { ok: false, reason: "stale" };
  return { ok: true, ctx: c };
}

/** The check a consumer runs on every request: the token must be for THIS tenant and THIS project. */
export function authorizes(ctx, { tenant, project, capability }) {
  return ctx.tenant.id === tenant && ctx.project?.kind === project.kind && ctx.project?.id === project.id && ctx.capabilities.includes(capability);
}

/**
 * The check a finance consumer runs: a /2 context only, the grant explicitly in ctx.capabilities (a role name is
 * never read), the tenant matching, and the scope matching exactly. With `project` the context must be for that
 * project. Without it the context must have none (the platform scope, held by staff). `expect` pins the three
 * mode axes the consumer is about to act under; any mismatch denies, so a sandbox token cannot authorize a
 * paid-test command or the reverse.
 */
export function authorizesFinance(ctx, { tenant, project, capability, expect }) {
  if (ctx.schema !== SCHEMA_V2 || !FINANCE_CAPS.includes(capability) || !ctx.capabilities.includes(capability)) return false;
  if (ctx.tenant.id !== tenant) return false;
  if (project ? !(ctx.project?.kind === project.kind && ctx.project?.id === project.id) : ctx.project !== undefined) return false;
  if (expect) for (const k of ["environment", "economicMode", "evidenceMode"]) if (expect[k] !== undefined && expect[k] !== ctx[k]) return false;
  return true;
}

// The projection is app-owned and shared with the server; it does not verify or grant authority.
// Run this reference verifier with the repository's declared Node 22 runtime.
import { FINANCE_SCOPE_ADAPTER, FINANCE_ID_MAX, toFinanceScope } from "../../src/server/finance-scope.ts";
export { FINANCE_SCOPE_ADAPTER, FINANCE_ID_MAX, toFinanceScope };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const key = JSON.parse(readFileSync(join(here, "fixture-key.json"), "utf8")).key;
  const skip = ["fixture-key.json", "index.json", "finance-trusted-scope.schema.json"];
  const files = [
    ...readdirSync(here).filter((n) => n.endsWith(".json") && !skip.includes(n)).map((n) => join(here, n)),
    ...(existsSync(join(here, "v2")) ? readdirSync(join(here, "v2")).filter((n) => n.endsWith(".json") && n !== "malformed-shapes.json").map((n) => join(here, "v2", n)) : []),
  ];
  let bad = 0;
  const report = (ok, line) => {
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  };
  for (const f of files) {
    const fx = JSON.parse(readFileSync(f, "utf8"));
    const r = verifyContext(fx.token, key, { now: Date.parse(fx.verifyAt), state: fx.state, audience: fx.audience ?? "ticketstub.finance" });
    let ok = r.ok === fx.expect.ok && (r.ok ? r.ctx.role === fx.expect.role && r.ctx.tenant.id === fx.expect.tenant : r.reason === fx.expect.reason);
    if (ok && r.ok && fx.expect.grants) {
      ok = fx.expect.grants.allow.every((c) => r.ctx.capabilities.includes(c)) && fx.expect.grants.deny.every((c) => !r.ctx.capabilities.includes(c));
    }
    if (ok && r.ok && fx.expect.modes) ok = ["environment", "economicMode", "evidenceMode"].every((k) => r.ctx[k] === fx.expect.modes[k]);
    if (ok && r.ok && fx.expect.financeAdapter) ok = isDeepStrictEqual(toFinanceScope(r.ctx), fx.expect.financeAdapter);
    report(ok, `${fx.fixture}: ${r.ok ? `ok role=${r.ctx.role}` : r.reason}`);
  }
  const shapes = join(here, "v2", "malformed-shapes.json");
  if (existsSync(shapes)) {
    const list = JSON.parse(readFileSync(shapes, "utf8")).cases;
    for (const c of list) {
      const r = verifyContext(c.token, key, { now: Date.parse(c.verifyAt), audience: "ticketstub.finance" });
      report(!r.ok && r.reason === c.expect.reason, `malformed ${c.name}: ${r.ok ? "ok (should be rejected)" : r.reason}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
