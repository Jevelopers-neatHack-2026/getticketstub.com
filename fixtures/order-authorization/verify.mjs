// Reference verifier and reference issuer model for ticketstub.order-authorization/1. No dependencies: copy these functions into a consumer.
//   node fixtures/order-authorization/verify.mjs      checks every token fixture and every reference-driven scenario in this folder
// verifyOrderAuthorization(token, key, expect, { now, state, intent }) -> { ok: true, authorization } | { ok: false, reason, fields? }
// reason is one of: unknown | forged | unsupported_version | wrong_scope | changed_terms | revoked | expired | stale_approval | stale |
//                   not_orderable | already_claimed | not_claimed | idempotency_conflict
// expect MUST name { tenant, project: { kind, id }, action, provider, terms } with the FULL terms the consumer holds (orderRef, sku, options, quote,
// destination, design, approvalId, capabilityVersion); for intent "revalidate" also claimReference. A consumer never takes a term from the token it is
// checking. Without `state` only signature, version, scope, terms and expiry are checked; revoked, stale, claims and the rest need the issuer's
// current answer (README.md: the HTTP port). An authorization is NOT an artwork approval and is never inferred from one.
//
// This file also holds a ReferenceIssuer: an in-memory model of the atomic single-use claim, and runScenario, which drives any issuer (this model,
// or a live server through scripts/check-order-auth.mjs) through the same scenario files and compares the outcomes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "ticketstub.order-authorization/1";
export const ACTIONS = ["fulfillment.submit"];
export const PROVIDERS = ["sandbox", "prodigi"];
export const AUDIENCE = "fulfillment-connectors";
export const TTL_MS = 15 * 60_000;
const HEX64 = /^[a-f0-9]{64}$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const dec = (s) => Buffer.from(s, "base64url");
const enc = (v) => Buffer.from(v).toString("base64url");
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** Keys sorted, no whitespace, undefined dropped. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(",")}}`;
}
const hashJson = (v) => sha256Hex(canonicalJson(v));

/** The hash of the exact purchase: action, provider and every term. Recompute it from what you hold. */
export const commandHash = (action, provider, terms) => hashJson({ action, provider, terms });
/** The logical action: stable across renewals of the same orderRef. */
export const actionIdOf = (tenant, project, action, orderRef) => `act_${hashJson({ tenant, project, action, orderRef }).slice(0, 32)}`;

/** Dotted paths of the terms that differ. Names only, never values. */
export function termDiffs(held, bound, prefix = "") {
  if (!isObj(held) || !isObj(bound)) return canonicalJson(held) === canonicalJson(bound) ? [] : [prefix || "terms"];
  const out = [];
  for (const k of new Set([...Object.keys(held), ...Object.keys(bound)])) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObj(held[k]) && isObj(bound[k])) out.push(...termDiffs(held[k], bound[k], path));
    else if (canonicalJson(held[k]) !== canonicalJson(bound[k])) out.push(path);
  }
  return out;
}

export function signOrderAuthorization(record, key) {
  const head = enc(JSON.stringify({ alg: "HS256", typ: "ticketstub.order-authorization" }));
  const body = enc(JSON.stringify({ authorization: record }));
  return `${head}.${body}.${createHmac("sha256", key).update(`${head}.${body}`).digest("base64url")}`;
}

function shaped(v) {
  if (!isObj(v) || !isObj(v.tenant) || !isObj(v.project) || !isObj(v.actor) || !isObj(v.command) || !isObj(v.terms) || !isObj(v.approval)) return false;
  const t = v.terms;
  if (typeof v.id !== "string" || typeof v.tenant.id !== "string" || v.project.kind !== "stub" || typeof v.project.id !== "string") return false;
  if (v.actor.kind !== "account" || typeof v.actor.id !== "string" || typeof v.action !== "string" || typeof v.provider !== "string" || typeof v.actionId !== "string") return false;
  if (typeof v.command.hash !== "string" || !HEX64.test(v.command.hash) || typeof v.approval.id !== "string" || v.audience !== AUDIENCE) return false;
  if (typeof t.orderRef !== "string" || !(t.sku === null || typeof t.sku === "string") || !isObj(t.options) || !isObj(t.quote) || !isObj(t.destination) || !isObj(t.design)) return false;
  if (!Number.isInteger(t.quote.amountMinor) || typeof t.quote.id !== "string" || typeof t.quote.currency !== "string") return false;
  if (typeof t.destination.ref !== "string" || typeof t.destination.digest !== "string" || !HEX64.test(t.destination.digest)) return false;
  if (![t.design.designHash, t.design.artHash, t.design.factsHash, t.design.compositionHash].every((h) => typeof h === "string" && HEX64.test(h))) return false;
  if (!Number.isInteger(v.membershipRevision) || !Array.isArray(v.notAuthorizes) || !isIso(v.issuedAt) || !isIso(v.expiresAt) || typeof v.idempotencyKey !== "string") return false;
  return ["development", "preview", "live"].includes(String(v.environment)) && ["fixture", "sandbox", "live"].includes(String(v.mode));
}

/**
 * Checks in this order, first failure wins:
 *   invalid_clock (`now` is not a finite number > 0) -> unknown -> forged -> unsupported_version -> wrong_scope (tenant, project, audience, action, provider) -> changed_terms (any term differs)
 *   -> revoked -> expired -> stale_approval -> stale (renewed, membership or capability version moved) -> not_orderable
 *   -> claim rules by intent: verify refuses any claim (already_claimed); claim allows only a replay under the same key; revalidate needs the claim it was given (not_claimed).
 */
export function verifyOrderAuthorization(token, key, expect, { now = Date.now(), state, intent = "verify" } = {}) {
  const no = (reason, fields) => ({ ok: false, reason, ...(fields ? { fields } : {}) });
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) return no("invalid_clock");
  if (typeof token !== "string" || token.length > 8192) return no("unknown");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return no("unknown");
  let head, body;
  try {
    head = JSON.parse(dec(parts[0]).toString("utf8"));
    body = JSON.parse(dec(parts[1]).toString("utf8"));
  } catch {
    return no("unknown");
  }
  if (!isObj(head) || head.alg !== "HS256" || head.typ !== "ticketstub.order-authorization" || !isObj(body)) return no("unknown");
  const want = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const got = dec(parts[2]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return no("forged");
  const r = body.authorization;
  if (!isObj(r)) return no("unknown");
  if (r.schema !== SCHEMA) return no("unsupported_version");
  if (!shaped(r)) return no("unknown");
  if (state?.known === false) return no("unknown");
  const scopeOk = expect.tenant === r.tenant.id && expect.project?.kind === r.project.kind && expect.project?.id === r.project.id && expect.action === r.action && ACTIONS.includes(r.action) && expect.provider === r.provider && PROVIDERS.includes(r.provider);
  if (!scopeOk) return no("wrong_scope");
  const diffs = termDiffs(expect.terms, r.terms);
  if (diffs.length || commandHash(r.action, r.provider, r.terms) !== r.command.hash) return no("changed_terms", diffs.length ? diffs.sort() : ["command"]);
  if (state?.revoked) return no("revoked");
  if (Date.parse(r.expiresAt) <= now) return no("expired");
  if (state) {
    if (state.approval !== undefined && state.approval !== "active") return no("stale_approval");
    if (state.superseded) return no("stale");
    if (state.membershipRevision !== undefined && state.membershipRevision !== r.membershipRevision) return no("stale");
    if (state.capabilityVersion !== undefined && state.capabilityVersion !== r.terms.capabilityVersion) return no("stale");
    if (state.orderable === false) return no("not_orderable");
    const claim = state.claim ?? null;
    if (intent === "revalidate") {
      if (!claim || claim.reference !== expect.claimReference) return no("not_claimed");
    } else if (claim && (intent === "verify" || !claim.keyMatches)) return no("already_claimed");
  }
  return { ok: true, authorization: r };
}

/** HMAC-SHA256 (hex) over `<timestamp ms>\n<METHOD>\n<path>\n<sha256 of the exact body text>`. Sent as x-ticketstub-consumer-timestamp and x-ticketstub-consumer-signature. */
export const consumerSignature = (key, timestamp, method, path, bodyText) => createHmac("sha256", key).update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${sha256Hex(bodyText)}`).digest("hex");

/** The clocks a fixture may name by tag (`consumer.clock`), because JSON cannot hold NaN or Infinity. */
export const CLOCKS = { nan: Number.NaN, infinity: Number.POSITIVE_INFINITY, negative: -1, string: "1791633600000" };

/** The consumer's trusted clock for a fixture: a named bad clock, or `verifyAt`. */
export const fixtureNow = (fx) => (fx.consumer?.clock !== undefined ? CLOCKS[fx.consumer.clock] : Date.parse(fx.verifyAt));

/** Runs one token fixture the way a consumer would: its own terms, the issuer's state, the intent. */
export function runFixture(fx, key) {
  return verifyOrderAuthorization(fx.token, key, fx.expect, { now: fixtureNow(fx), state: fx.state, intent: fx.intent });
}

/** Does a result match the fixture's outcome (ok, or the reason, and the fields when it names them)? */
export function matchesOutcome(r, outcome) {
  if (r.ok !== outcome.ok) return false;
  if (r.ok) return true;
  return r.reason === outcome.reason && (outcome.fields === undefined || canonicalJson(r.fields ?? []) === canonicalJson(outcome.fields));
}

// ---------------------------------------------------------------------------------------------
// The reference issuer: the claim protocol as an in-memory model. A real issuer does the same under one write lock.
// ---------------------------------------------------------------------------------------------

const CAP = "2026-10-11.1";
export class ReferenceIssuer {
  constructor({ key, baseTerms, tenant, project, scenario }) {
    this.key = key;
    this.base = baseTerms;
    this.tenant = tenant;
    this.project = project;
    this.scenario = scenario;
    this.now = Date.parse("2026-10-10T12:00:00.000Z");
    this.auths = new Map(); // label -> { record, token, revoked }
    this.claimsByAuth = new Map(); // record id -> claim
    this.claimsByKey = new Map(); // key -> claim
    this.claimedActions = new Set();
    this.approval = "active";
    this.seq = 0;
  }
  keyOf(label) {
    return `idem_${this.scenario}_${label}`;
  }
  expectOf(a) {
    return { tenant: a.record.tenant.id, project: a.record.project, action: a.record.action, provider: a.record.provider, terms: a.record.terms };
  }
  stateOf(a, idemKey) {
    const claim = this.claimsByAuth.get(a.record.id);
    const newer = [...this.auths.values()].some((o) => o.record.actionId === a.record.actionId && o.n > a.n);
    return {
      known: true,
      revoked: a.revoked,
      superseded: newer,
      approval: this.approval,
      membershipRevision: a.record.membershipRevision,
      capabilityVersion: CAP,
      orderable: true,
      claim: claim ? { reference: claim.ref, keyMatches: idemKey !== undefined && claim.key === idemKey } : null,
    };
  }
  async issue(label, { orderOf } = {}) {
    const orderRef = orderOf ? this.auths.get(orderOf).record.terms.orderRef : `ord_${this.scenario}_${label}`.slice(0, 64);
    const terms = { ...structuredClone(this.base), orderRef };
    const actionId = actionIdOf(this.tenant, this.project, "fulfillment.submit", orderRef);
    if (this.claimedActions.has(actionId)) return { ok: false, code: "authorization_conflict" };
    const n = ++this.seq;
    const record = {
      schema: SCHEMA, id: `oau_REF_${this.scenario}_${n}`, issuer: "ticketstub", audience: AUDIENCE, tenant: { id: this.tenant }, project: this.project, actor: { kind: "account", id: this.tenant },
      action: "fulfillment.submit", provider: "sandbox", actionId, command: { name: "submit_order", hash: commandHash("fulfillment.submit", "sandbox", terms) }, terms,
      approval: { id: terms.approvalId, purpose: "print.compose" }, idempotencyKey: `issue_${this.scenario}_${label}`, membershipRevision: 3,
      notAuthorizes: ["payment", "refund", "other_orders", "destination_change", "asset_rights"], environment: "development", mode: "fixture",
      issuedAt: new Date(this.now).toISOString(), expiresAt: new Date(this.now + TTL_MS).toISOString(),
    };
    this.auths.set(label, { record, token: signOrderAuthorization(record, this.key), revoked: false, n });
    return { ok: true };
  }
  async claim(label, keyLabel) {
    const a = this.auths.get(label);
    const idemKey = this.keyOf(keyLabel);
    const r = verifyOrderAuthorization(a.token, this.key, this.expectOf(a), { now: this.now, state: this.stateOf(a, idemKey), intent: "claim" });
    if (!r.ok) return { ok: false, reason: r.reason };
    const byKey = this.claimsByKey.get(idemKey);
    if (byKey && byKey.authId !== a.record.id) return { ok: false, reason: "idempotency_conflict" };
    const had = this.claimsByAuth.get(a.record.id);
    if (had) return { ok: true, replayed: true, ref: had.ref };
    const claim = { authId: a.record.id, actionId: a.record.actionId, key: idemKey, ref: `clm_REF_${this.scenario}_${a.n}` };
    this.claimsByAuth.set(a.record.id, claim);
    this.claimsByKey.set(idemKey, claim);
    this.claimedActions.add(a.record.actionId);
    return { ok: true, replayed: false, ref: claim.ref };
  }
  /** The model is sequential, so this is a loop; the claim itself is the unit that must be atomic. */
  async parallelClaim(label, keyLabels) {
    const out = [];
    for (const k of keyLabels) out.push(await this.claim(label, k));
    return out;
  }
  async lookup(keyLabel, label) {
    const claim = this.claimsByKey.get(this.keyOf(keyLabel));
    if (!claim) return { found: false, authorizationClaimed: !!label && this.claimsByAuth.has(this.auths.get(label).record.id) };
    const a = [...this.auths.values()].find((x) => x.record.id === claim.authId);
    const r = verifyOrderAuthorization(a.token, this.key, { ...this.expectOf(a), claimReference: claim.ref }, { now: this.now, state: this.stateOf(a, claim.key), intent: "revalidate" });
    return { found: true, ref: claim.ref, authority: r.ok ? "ok" : r.reason };
  }
  async revoke(label) {
    this.auths.get(label).revoked = true;
  }
  async revokeApproval() {
    this.approval = "revoked";
  }
  async changeDesign() {
    this.approval = "stale";
  }
  async revalidate(label, claimRef, mutate) {
    const a = this.auths.get(label);
    const expect = { ...this.expectOf(a), claimReference: claimRef };
    for (const [path, value] of Object.entries(mutate ?? {})) {
      expect.terms = structuredClone(expect.terms);
      const ks = path.split(".");
      let o = expect.terms;
      for (const k of ks.slice(0, -1)) o = o[k];
      o[ks.at(-1)] = value;
    }
    const claim = this.claimsByAuth.get(a.record.id);
    const r = verifyOrderAuthorization(a.token, this.key, expect, { now: this.now, state: this.stateOf(a, claim?.key), intent: "revalidate" });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, fields: r.fields };
  }
  async advance(minutes) {
    this.now += minutes * 60_000;
  }
}

/**
 * Drives a scenario file through an issuer driver (the ReferenceIssuer above, or a live adapter with the same methods) and returns the
 * failures, as strings. Labels (auth names, key names, claim names) are the scenario's; the driver makes real ones.
 */
export async function runScenario(driver, scn) {
  const failures = [];
  const claims = {}; // claim label -> claim reference, as the scenario names it
  const refsByKey = {}; // key label -> the reference the consumer actually saw
  const same = (a, b) => canonicalJson(a) === canonicalJson(b);
  let i = 0;
  for (const step of scn.steps) {
    i++;
    const where = `${scn.scenario} step ${i} (${step.op})`;
    const fail = (why) => failures.push(`${where}: ${why}`);
    if (step.op === "issue") {
      const r = await driver.issue(step.auth, { orderOf: step.orderOf });
      if (step.expect?.refused) {
        if (r.ok || r.code !== step.expect.refused) fail(`expected refusal ${step.expect.refused}, got ${JSON.stringify(r)}`);
      } else if (!r.ok) fail(`issue refused: ${JSON.stringify(r)}`);
    } else if (step.op === "claim") {
      const r = await driver.claim(step.auth, step.key);
      const e = step.expect;
      if (r.ok !== e.ok) fail(`expected ok ${e.ok}, got ${JSON.stringify(r)}`);
      else if (r.ok) {
        if (e.replayed !== undefined && r.replayed !== e.replayed) fail(`expected replayed ${e.replayed}, got ${r.replayed}`);
        if (e.as) claims[e.as] = r.ref;
        if (e.is && claims[e.is] !== r.ref) fail(`expected the claim ${e.is}, got a different one`);
        if (!step.dropResponse) refsByKey[step.key] = r.ref;
      } else if (r.reason !== e.reason) fail(`expected reason ${e.reason}, got ${r.reason}`);
    } else if (step.op === "parallel") {
      const results = await driver.parallelClaim(step.auth, step.keys);
      const okCount = results.filter((r) => r.ok).length;
      const created = results.filter((r) => r.ok && !r.replayed).length;
      const reasons = {};
      for (const r of results.filter((x) => !x.ok)) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      const e = step.expect;
      if (okCount !== e.ok) fail(`expected ${e.ok} ok, got ${okCount}`);
      if (created !== e.created) fail(`expected ${e.created} created, got ${created} (exactly one claim may commit)`);
      if (!same(reasons, e.reasons)) fail(`expected reasons ${JSON.stringify(e.reasons)}, got ${JSON.stringify(reasons)}`);
      if (e.sameClaim && new Set(results.filter((r) => r.ok).map((r) => r.ref)).size !== 1) fail("expected every ok result to carry the same claim");
      const win = results.find((r) => r.ok && !r.replayed) ?? results.find((r) => r.ok);
      if (win) for (const [j, r] of results.entries()) if (r.ok) refsByKey[step.keys[j]] = r.ref;
    } else if (step.op === "lookup") {
      const r = await driver.lookup(step.key, step.auth);
      const e = step.expect;
      if (r.found !== e.found) fail(`expected found ${e.found}, got ${JSON.stringify(r)}`);
      else if (r.found) {
        if (e.is && claims[e.is] !== r.ref) fail(`expected the claim ${e.is}, got a different one`);
        if (e.authority !== undefined && r.authority !== e.authority) fail(`expected authority ${e.authority}, got ${r.authority}`);
        refsByKey[step.key] = r.ref;
      } else if (!!r.authorizationClaimed !== !!e.authorizationClaimed) fail(`expected authorizationClaimed ${!!e.authorizationClaimed}, got ${!!r.authorizationClaimed}`);
    } else if (step.op === "revalidate") {
      const r = await driver.revalidate(step.auth, refsByKey[step.key] ?? "clm_never_issued_0000", step.mutate);
      const e = step.expect;
      if (r.ok !== e.ok) fail(`expected ok ${e.ok}, got ${JSON.stringify(r)}`);
      else if (!r.ok && r.reason !== e.reason) fail(`expected reason ${e.reason}, got ${r.reason}`);
      else if (!r.ok && e.fields && !same(r.fields, e.fields)) fail(`expected fields ${JSON.stringify(e.fields)}, got ${JSON.stringify(r.fields)}`);
    } else if (["revoke", "revokeApproval", "changeDesign"].includes(step.op)) {
      await driver[step.op](step.auth);
    } else if (step.op === "advance") {
      await driver.advance(step.minutes);
    } else fail("unknown op");
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const keyFile = JSON.parse(readFileSync(join(here, "fixture-key.json"), "utf8"));
  const index = JSON.parse(readFileSync(join(here, "index.json"), "utf8"));
  const content = JSON.parse(readFileSync(join(here, "content.json"), "utf8"));
  let bad = 0;
  for (const f of index.fixtures) {
    const fx = JSON.parse(readFileSync(join(here, f), "utf8"));
    const r = runFixture(fx, keyFile.key);
    const ok = matchesOutcome(r, fx.outcome);
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${fx.fixture}: ${r.ok ? "ok" : r.reason}${ok ? "" : ` (wanted ${fx.outcome.ok ? "ok" : fx.outcome.reason})`}`);
  }
  for (const f of index.scenarios) {
    const scn = JSON.parse(readFileSync(join(here, f), "utf8"));
    if (!scn.drivers.includes("reference")) continue;
    const issuer = new ReferenceIssuer({ key: keyFile.key, baseTerms: content.terms, tenant: content.tenant, project: content.project, scenario: scn.scenario });
    const failures = await runScenario(issuer, scn);
    if (failures.length) bad++;
    console.log(`${failures.length ? "FAIL" : "ok  "} scenario ${scn.scenario}${failures.length ? `: ${failures.join("; ")}` : ""}`);
  }
  process.exit(bad ? 1 : 0);
}
