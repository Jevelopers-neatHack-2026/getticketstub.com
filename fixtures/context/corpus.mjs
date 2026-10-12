// The malformed-shape corpus: validly signed contexts that must all be refused as `unknown`. It is data, not tokens,
// so each caller signs it with its own key: generate.mjs with the fixture key (-> v2/malformed-shapes.json), the
// unit tests with a throwaway key, and scripts/check-finance-context.mjs with the running server's CONTEXT_SECRET.
// The /1 cases open with the seven shapes the Finance receipt (GT-FIN-003) found passing the old offline verifier:
// missing actor id, missing or unknown environment, missing or unknown mode, malformed project kind or id, missing issuedAt.
import { CONTEXT_SCHEMA, CONTEXT_SCHEMA_V2, capabilitiesFor, toContextV2 } from "../../src/server/context-token.ts";

export const NOW = Date.parse("2026-10-10T12:00:00.000Z");
export const AUDIENCE = "ticketstub.finance";
const iso = (ms) => new Date(ms).toISOString();

/** A valid /1 context: an account owner on one stub. */
export function v1Base() {
  const project = { kind: "stub", id: "stub_fx_1" };
  return {
    schema: CONTEXT_SCHEMA,
    actor: { kind: "account", id: "acc_FIXTURE_owner1" },
    tenant: { id: "acc_FIXTURE_owner1" },
    project,
    role: "owner",
    capabilities: capabilitiesFor("account", "owner", project, false),
    membershipRevision: 3,
    revoked: false,
    environment: "development",
    mode: "fixture",
    issuedAt: iso(NOW),
    expiresAt: iso(NOW + 5 * 60_000),
  };
}

/** A valid /2 context. `over` replaces whole top-level fields. Default: an event captain, sandbox, fixture evidence. */
export function v2Base(over = {}, { staff = false } = {}) {
  const project = { kind: "event", id: "evt_fx_1" };
  const v1 = {
    ...v1Base(),
    actor: { kind: "account", id: "acc_FIXTURE_captain1" },
    tenant: { id: "acc_FIXTURE_captain1" },
    project,
    role: "captain",
    capabilities: capabilitiesFor("account", "captain", project, false),
  };
  return { ...toContextV2(v1, { staff, environment: "development", economicMode: "sandbox", evidenceMode: "fixture", audience: AUDIENCE }), ...over };
}

const drop = (o, ...path) => {
  const last = path.pop();
  const target = path.reduce((x, k) => x[k], o);
  delete target[last];
};
const put = (o, v, ...path) => {
  const last = path.pop();
  path.reduce((x, k) => x[k], o)[last] = v;
};

/** [name, schema version, mutation]. Every one must verify as { ok: false, reason: "unknown" } once correctly signed. */
export const MALFORMED_BASE = [
  // ---- /1: the seven from the Finance receipt, plus the rest of the shape ----
  ["v1 missing account actor id", 1, (c) => drop(c, "actor", "id")],
  ["v1 empty account actor id", 1, (c) => put(c, "", "actor", "id")],
  ["v1 missing environment", 1, (c) => drop(c, "environment")],
  ["v1 unknown environment", 1, (c) => put(c, "production", "environment")],
  ["v1 missing mode", 1, (c) => drop(c, "mode")],
  ["v1 unknown mode", 1, (c) => put(c, "paid_test", "mode")],
  ["v1 malformed project kind", 1, (c) => put(c, "wall", "project", "kind")],
  ["v1 malformed project id", 1, (c) => put(c, "a b/../c", "project", "id")],
  ["v1 project id too long", 1, (c) => put(c, "x".repeat(129), "project", "id")],
  ["v1 missing issuedAt", 1, (c) => drop(c, "issuedAt")],
  ["v1 issuedAt not a date", 1, (c) => put(c, "yesterday-ish", "issuedAt")],
  ["v1 missing tenant id", 1, (c) => drop(c, "tenant", "id")],
  ["v1 unknown role", 1, (c) => put(c, "finance-admin", "role")],
  ["v1 capabilities not strings", 1, (c) => put(c, ["stub.read", 7], "capabilities")],
  ["v1 revision not an integer", 1, (c) => put(c, 1.5, "membershipRevision")],
  ["v1 revoked not a boolean", 1, (c) => put(c, "no", "revoked")],
  // ---- /2 ----
  ["v2 actor id not kind-prefixed", 2, (c) => put(c, "acc_FIXTURE_captain1", "actor", "id")],
  ["v2 actor id carries another kind's prefix", 2, (c) => put(c, "guest:acc_FIXTURE_captain1", "actor", "id")],
  ["v2 tenant differs from actor", 2, (c) => put(c, "account:acc_someone_else", "tenant", "id")],
  ["v2 anonymous actor with a raw id", 2, (c) => {
    c.actor = { kind: "anonymous", id: "anonymous:somebody" };
    c.tenant = { id: "anonymous:somebody" };
  }],
  ["v2 actor kind unknown", 2, (c) => put(c, "service", "actor", "kind")],
  ["v2 missing environment", 2, (c) => drop(c, "environment")],
  ["v2 unknown environment", 2, (c) => put(c, "production", "environment")],
  ["v2 missing economic mode", 2, (c) => drop(c, "economicMode")],
  ["v2 unknown economic mode", 2, (c) => put(c, "paid-test", "economicMode")],
  ["v2 missing evidence mode", 2, (c) => drop(c, "evidenceMode")],
  ["v2 unknown evidence mode", 2, (c) => put(c, "mocked", "evidenceMode")],
  ["v2 carries the v1 mode field and no mode axes", 2, (c) => {
    drop(c, "economicMode");
    drop(c, "evidenceMode");
    c.mode = "fixture";
  }],
  ["v2 paid_test from a live environment", 2, (c) => {
    c.environment = "live";
    c.economicMode = "paid_test";
  }],
  ["v2 live money from a development environment", 2, (c) => put(c, "live", "economicMode")],
  ["v2 missing audience", 2, (c) => drop(c, "audience")],
  ["v2 missing issuer", 2, (c) => drop(c, "issuer")],
  ["v2 project ref missing", 2, (c) => drop(c, "project", "ref")],
  ["v2 project ref not kind-prefixed", 2, (c) => put(c, "evt_fx_1", "project", "ref")],
  ["v2 project ref names another kind", 2, (c) => put(c, "stub:evt_fx_1", "project", "ref")],
  ["v2 malformed project kind", 2, (c) => {
    c.project = { kind: "wall", id: "evt_fx_1", ref: "wall:evt_fx_1" };
  }],
  ["v2 malformed project id", 2, (c) => {
    c.project = { kind: "event", id: "a b", ref: "event:a b" };
  }],
  ["v2 missing issuedAt", 2, (c) => drop(c, "issuedAt")],
  ["v2 finance grant held by a guest", 2, (c) => {
    c.actor = { kind: "guest", id: "guest:fxguest0000000001" };
    c.tenant = { id: "guest:fxguest0000000001" };
    c.capabilities = [...c.capabilities, "finance.read"];
  }],
  ["v2 finance grant not in the grant list", 2, (c) => put(c, [...c.capabilities, "finance.command.delete_everything"], "capabilities")],
];

// GT-V2-FIN-003: every enum-valued field, set to a value of the wrong type. Each valid member is wrapped in an array
// (which String() would have turned back into the member), then an object, null, a number and a boolean.
const WRONG_TYPES = [
  ["as an array", (v) => [v]],
  ["as an object", (v) => ({ value: v })],
  ["as null", () => null],
  ["as a number", () => 7],
  ["as a boolean", () => true],
];
// [label, schema version, path, a valid member]. `schema` is covered separately: a wrong-typed schema is unsupported_version.
const ENUM_FIELDS = [
  ["v1 environment", 1, ["environment"], "development"],
  ["v1 mode", 1, ["mode"], "fixture"],
  ["v1 project.kind", 1, ["project", "kind"], "stub"],
  ["v1 actor.kind", 1, ["actor", "kind"], "account"],
  ["v1 role", 1, ["role"], "owner"],
  ["v2 environment", 2, ["environment"], "development"],
  ["v2 economicMode", 2, ["economicMode"], "sandbox"],
  ["v2 evidenceMode", 2, ["evidenceMode"], "fixture"],
  ["v2 project.kind", 2, ["project", "kind"], "event"],
  ["v2 actor.kind", 2, ["actor", "kind"], "account"],
  ["v2 role", 2, ["role"], "captain"],
];
/** The retained rows first, in their original order, then the wrong-type negatives. */
export const MALFORMED_WRONG_TYPE = ENUM_FIELDS.flatMap(([label, version, path, valid]) =>
  WRONG_TYPES.map(([how, wrap]) => [`${label} ${how}`, version, (c) => put(c, wrap(valid), ...path)]),
);
export const MALFORMED = [...MALFORMED_BASE, ...MALFORMED_WRONG_TYPE];

/** `schema` of the wrong type: not a known version at all, so unsupported_version rather than unknown. [name, version, ctx]. */
export const WRONG_TYPE_SCHEMAS = [1, 2].flatMap((version) =>
  WRONG_TYPES.map(([how, wrap]) => [`v${version} schema ${how}`, version, wrap(version === 1 ? CONTEXT_SCHEMA : CONTEXT_SCHEMA_V2)]),
);
export function wrongTypeSchemaContexts() {
  return WRONG_TYPE_SCHEMAS.map(([name, version, schema]) => ({ name, ctx: { ...structuredClone(version === 1 ? v1Base() : v2Base()), schema } }));
}

// GT-V2-FIN-002: identifier length at Finance's 128 limit, after the kind prefix. `actor.id` and `tenant.id` are the same
// string by construction, so the actor case is the tenant case too (the adapter checks each field on its own, and the
// unit tests build a context where only the tenant is long). `account:` is 8 characters, `event:` is 6.
export const FINANCE_ID_MAX = 128;
const fill = (n) => "a".repeat(n);
const accountCtx = (raw) => v2Base({ actor: { kind: "account", id: `account:${raw}` }, tenant: { id: `account:${raw}` } });
const eventCtx = (raw) => v2Base({ project: { kind: "event", id: raw, ref: `event:${raw}` } });
/** [fixture name, description, ctx, field(s) that are too long, or null when it must be accepted] */
export const BOUNDARY = [
  ["boundary-actor-128", "Account actor and tenant are exactly 128 characters after the kind prefix (120 raw): accepted, and a valid TrustedScope.", accountCtx(fill(120)), null],
  ["boundary-actor-129", "Account actor and tenant are 129 characters after the prefix (121 raw): the producer accepts it, the Finance adapter refuses identifier_too_long.", accountCtx(fill(121)), ["tenantId", "actorId"]],
  ["boundary-actor-raw-128", "The reviewer's case: a 128-character raw account id is 136 prefixed. Valid /2, refused by the Finance adapter.", accountCtx(fill(128)), ["tenantId", "actorId"]],
  ["boundary-project-128", "Event project ref is exactly 128 characters (122 raw id): accepted, and a valid TrustedScope.", eventCtx(fill(122)), null],
  ["boundary-project-129", "Event project ref is 129 characters (123 raw id): refused identifier_too_long.", eventCtx(fill(123)), ["projectId"]],
  ["boundary-project-raw-128", "The reviewer's case: a 128-character raw event id is a 134-character ref. Refused identifier_too_long.", eventCtx(fill(128)), ["projectId"]],
];

/** The malformed contexts, ready to sign: [{ name, schema, ctx }]. */
export function malformedContexts() {
  return MALFORMED.map(([name, schema, mutate]) => {
    const ctx = structuredClone(schema === 1 ? v1Base() : v2Base());
    mutate(ctx);
    return { name, schema: schema === 1 ? CONTEXT_SCHEMA : CONTEXT_SCHEMA_V2, ctx };
  });
}
