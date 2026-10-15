// Versioned signing keys (integration-evals decision 0003 K4): the keyring, and the approval verifier on top of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { KeyringError, loadKeyring, parseKeyset } from "../src/server/keyring.ts";
import { APPROVAL_SCHEMA, APPROVAL_TTL_MS, NOT_AUTHORIZED, sha256Hex, signApproval, verifyApproval } from "../src/server/approval-token.ts";
import { verifyApproval as refVerify } from "../fixtures/approval/verify.mjs";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const k = () => randomBytes(32).toString("base64url");
const NAME = "APPROVAL_SIGNING_KEYS";
const fallback = () => Buffer.alloc(32, 7);
const load = (doc, over = {}) =>
  loadKeyring({ name: NAME, raw: typeof doc === "string" ? doc : JSON.stringify(doc), live: true, retentionMs: APPROVAL_TTL_MS, fallback, now: NOW, ...over });
const ring = (doc, over) => {
  const r = load(doc, over);
  assert.ok(r.ok, `expected a keyring, got ${r.problem}`);
  return r.keyring;
};

const K1 = k();
const K2 = k();
const g1 = { kid: "approval-g1", state: "active", activatedAt: iso(NOW - 30 * DAY), key: K1 };
const rotated = () => ({
  v: 1,
  keys: [
    { kid: "approval-g2", state: "active", activatedAt: iso(NOW - DAY), key: K2 },
    { kid: "approval-g1", state: "retired", activatedAt: iso(NOW - 30 * DAY), retiredAt: iso(NOW - DAY), key: K1 },
  ],
});

const record = (over = {}) => ({
  schema: APPROVAL_SCHEMA, id: "apr_k4", issuer: "ticketstub", tenant: { id: "t1" }, project: { kind: "stub", id: "s1" }, purpose: "artifact.download",
  actor: { kind: "account", id: "t1" }, membershipRevision: 1, notAuthorizes: NOT_AUTHORIZED, environment: "live", mode: "live",
  binding: { hashAlg: "sha256", versionId: "v1", artSource: "bytes", designHash: sha256Hex("d"), artHash: sha256Hex("a"), factsHash: sha256Hex("f"), compositionHash: sha256Hex("c"), composition: { edition: "classic", material: "print", finish: "matte", size: "classic" } },
  issuedAt: iso(NOW), expiresAt: iso(NOW + APPROVAL_TTL_MS), ...over,
});
const expect = { tenant: "t1", project: { kind: "stub", id: "s1" }, purpose: "artifact.download", content: { artHash: sha256Hex("a") } };
const verifyWith = (keyring, token, now = NOW) => {
  const r = verifyApproval(token, (kid, issuedAt) => keyring.lookup(kid, now, issuedAt), expect, now); // as the server calls it
  return r.ok ? "ok" : r.reason;
};
const kidOf = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).kid;

test("sign with the active kid, and the kid is in the token header", () => {
  const kr = ring({ v: 1, keys: [g1] });
  assert.equal(kr.mode, "live");
  const s = kr.signer();
  assert.equal(s.kid, "approval-g1");
  const token = signApproval(record(), s);
  assert.equal(kidOf(token), "approval-g1");
  assert.equal(verifyWith(kr, token), "ok");
  // The offline reference verifier agrees, given the same kid -> key map.
  const r = refVerify(token, { "approval-g1": Buffer.from(K1, "base64url") }, expect, { now: NOW });
  assert.equal(r.ok, true);
});

test("rotation: new tokens use the new kid, and a token from the retired key keeps verifying through retention", () => {
  const before = ring({ v: 1, keys: [g1] }, { now: NOW - 2 * DAY });
  const old = signApproval(record({ issuedAt: iso(NOW - 2 * DAY), expiresAt: iso(NOW - 2 * DAY + APPROVAL_TTL_MS) }), before.signer(), NOW - 2 * DAY);
  const after = ring(rotated());
  assert.equal(after.signer().kid, "approval-g2");
  const fresh = signApproval(record(), after.signer());
  assert.equal(kidOf(fresh), "approval-g2");
  assert.equal(verifyWith(after, fresh), "ok");
  assert.equal(verifyWith(after, old), "ok", "the previous key still verifies its outstanding tokens");
  assert.deepEqual(after.status(NOW), { name: NAME, mode: "live", activeKid: "approval-g2", verifyingKids: ["approval-g1"], purgeableKids: [] });
  // retiredAt + retention + 5 min skew: from then on the retired key verifies nothing and is purgeable.
  const end = NOW - DAY + APPROVAL_TTL_MS + 5 * 60_000;
  assert.ok(after.lookup("approval-g1", end - 1));
  assert.equal(after.lookup("approval-g1", end), null);
  assert.deepEqual(after.status(end).purgeableKids, ["approval-g1"]);
  // A token made with the retired key after it was purged is refused as forged, not merely expired.
  assert.equal(verifyWith(after, signApproval(record({ expiresAt: iso(end + DAY) }), { kid: "approval-g1", key: Buffer.from(K1, "base64url") }), end), "forged");
});

test("an unknown kid, a missing kid and a malformed kid verify nothing", () => {
  const kr = ring(rotated());
  const right = Buffer.from(K2, "base64url");
  assert.equal(verifyWith(kr, signApproval(record(), { kid: "approval-g9", key: right })), "forged", "right bytes, unknown kid");
  assert.equal(kr.lookup("approval-g9"), null);
  for (const bad of ["", "../x", "a".repeat(65), "__proto__ x", 7, null, undefined]) assert.equal(kr.lookup(bad), null);
  // A plain-object key map is looked up by own property only: kid "constructor" or "__proto__" never reaches a prototype.
  const tok = signApproval(record(), { kid: "constructor", key: right });
  assert.equal(verifyApproval(tok, { "approval-g2": right }, expect, NOW).reason, "forged");
  assert.equal(refVerify(tok, { "approval-g2": right }, expect, { now: NOW }).reason, "forged");
  const [, p, s] = signApproval(record(), kr.signer()).split(".");
  const noKid = Buffer.from(JSON.stringify({ alg: "HS256", typ: "ticketstub.approval" })).toString("base64url");
  assert.equal(verifyWith(kr, `${noKid}.${p}.${s}`), "unknown");
  const numKid = Buffer.from(JSON.stringify({ alg: "HS256", typ: "ticketstub.approval", kid: 2 })).toString("base64url");
  assert.equal(verifyWith(kr, `${numKid}.${p}.${s}`), "unknown");
});

test("no key confusion: a token signed with CONTEXT_SECRET is refused by the approval verifier", () => {
  const contextSecret = randomBytes(32).toString("base64url"); // shaped like a real CONTEXT_SECRET
  const kr = ring(rotated(), { forbidden: [Buffer.from(contextSecret)] });
  // Under the active approval kid, but keyed with CONTEXT_SECRET.
  assert.equal(verifyWith(kr, signApproval(record(), { kid: kr.signer().kid, key: contextSecret })), "forged");
  // A context-token-shaped header never reads as an approval.
  const [, p, s] = signApproval(record(), { kid: kr.signer().kid, key: contextSecret }).split(".");
  const ctxHead = Buffer.from(JSON.stringify({ alg: "HS256", typ: "ticketstub.context" })).toString("base64url");
  assert.equal(verifyWith(kr, `${ctxHead}.${p}.${s}`), "unknown");
  // And the key set itself may not reuse CONTEXT_SECRET's bytes (encoded as a key entry), in any mode.
  const reused = { v: 1, keys: [{ ...g1, key: Buffer.from(contextSecret).toString("base64url") }] };
  for (const live of [true, false]) assert.deepEqual(load(reused, { live, forbidden: [Buffer.from(contextSecret)] }), { ok: false, problem: "key_reused" });
});

test("fail closed when unconfigured in live mode; per-process sandbox key elsewhere", () => {
  for (const raw of [undefined, "", "   "]) {
    assert.deepEqual(load(raw ?? undefined, { raw }), { ok: false, problem: "unconfigured" });
    const demo = load(undefined, { raw, live: false });
    assert.ok(demo.ok);
    assert.equal(demo.keyring.mode, "sandbox");
    assert.equal(demo.keyring.signer().kid, "sandbox");
    assert.ok(demo.keyring.signer().key.equals(fallback()));
  }
  // A configured set outside live mode signs, but its records say sandbox.
  assert.equal(ring({ v: 1, keys: [g1] }, { live: false }).mode, "sandbox");
  // The server's own sandbox kid is never accepted inside a configured set (reserved), nor the fixture kid.
  for (const kid of ["sandbox", "fixture", "Fixture-g1"]) assert.equal(load({ v: 1, keys: [{ ...g1, kid }] }).problem, "reserved_kid");
});

test("an invalid key set fails closed in every mode, with a fixed problem code", () => {
  const cases = [
    ["not json", "not_json"],
    [{ v: 2, keys: [g1] }, "unsupported_version"],
    [{ v: 1, keys: [] }, "bad_shape"],
    [{ v: 1, keys: [g1], extra: 1 }, "bad_shape"],
    [{ v: 1, keys: [{ ...g1, note: "x" }] }, "bad_shape"],
    [{ v: 1, keys: [{ ...g1, kid: "bad kid" }] }, "bad_kid"],
    [{ v: 1, keys: [{ ...g1, state: "pending" }] }, "bad_state"],
    [{ v: 1, keys: [{ ...g1, activatedAt: "yesterday" }] }, "bad_time"],
    [{ v: 1, keys: [{ ...g1, retiredAt: iso(NOW) }] }, "bad_time"],
    [{ v: 1, keys: [{ ...g1, activatedAt: iso(NOW + DAY) }] }, "future_time"],
    [{ v: 1, keys: [{ ...g1, key: "c2hvcnQ" }] }, "weak_key"],
    [{ v: 1, keys: [{ ...g1, key: Buffer.from("ab".repeat(32)).toString("base64url") }] }, "weak_key"],
    [{ v: 1, keys: [{ ...g1, key: `${K1}=` }] }, "bad_key"],
    [{ v: 1, keys: [{ ...g1, key: Buffer.from("FIXTURE-ONLY-NEVER-PRODUCTION--ticketstub-approval-key-v1").toString("base64url") }] }, "fixture_key"],
    [{ v: 1, keys: [g1, { ...g1, kid: "approval-g2" }] }, "duplicate_key"],
    [{ v: 1, keys: [g1, { ...g1, key: K2, state: "retired", retiredAt: iso(NOW) }] }, "duplicate_kid"],
    [{ v: 1, keys: [{ ...rotated().keys[1] }] }, "active_count"],
    [{ v: 1, keys: [g1, { ...rotated().keys[0] }] }, "active_count"],
    [{ v: 1, keys: [{ ...rotated().keys[1], activatedAt: iso(NOW - 2 * DAY), retiredAt: iso(NOW) }, { ...rotated().keys[0], kid: "approval-g3", activatedAt: iso(NOW - 3 * DAY) }] }, "active_not_newest"],
    [{ v: 1, keys: Array.from({ length: 17 }, (_, i) => ({ ...g1, kid: `a-g${i}`, key: k() })) }, "too_many_keys"],
  ];
  for (const [doc, problem] of cases) {
    for (const live of [true, false]) assert.deepEqual(load(doc, { live }), { ok: false, problem }, `${JSON.stringify(doc).slice(0, 80)} (${live ? "live" : "demo"})`);
  }
});

test("errors and status never carry key material or the raw value", () => {
  const raw = JSON.stringify({ v: 1, keys: [{ ...g1, key: "c2hvcnQta2V5" }] });
  try {
    parseKeyset(NAME, raw, { now: NOW, maxClockSkewMs: 0 });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof KeyringError);
    assert.equal(e.message, `${NAME} is not usable (weak_key)`);
    assert.ok(!e.message.includes("c2hvcnQta2V5") && !String(e.stack).includes("c2hvcnQta2V5"));
  }
  const kr = ring(rotated());
  const shown = JSON.stringify([kr, kr.status(NOW), kr.mode]);
  for (const secret of [K1, K2]) assert.ok(!shown.includes(secret));
});

test("the published approval fixtures carry kid fixture, which no server key set accepts", () => {
  const kf = JSON.parse(readFileSync(new URL("../fixtures/approval/fixture-key.json", import.meta.url), "utf8"));
  const fx = JSON.parse(readFileSync(new URL("../fixtures/approval/valid-print-compose.json", import.meta.url), "utf8"));
  assert.equal(kf.kid, "fixture");
  assert.equal(kidOf(fx.token), "fixture");
  assert.equal(load({ v: 1, keys: [{ ...g1, kid: kf.kid, key: Buffer.from(kf.key).toString("base64url") }] }).problem, "reserved_kid");
  assert.equal(load({ v: 1, keys: [{ ...g1, key: Buffer.from(kf.key).toString("base64url") }] }).problem, "fixture_key");
});

// ---- Review fixes (#75 review M1, L3, N2)
import { withSigningEnv } from "./lib/load-server.mjs";

const oneKey = (key, kid = "approval-g1") => JSON.stringify({ v: 1, keys: [{ kid, state: "active", activatedAt: iso(Date.now() - DAY), key }] });

test("M1: the same string pasted into CONTEXT_SECRET and a key entry is refused, in both readings", () => {
  const s = k(); // the documented generator's output: base64url of 32 random bytes
  // The same string in both places (the copy-paste case), and each variable holding the other's encoding.
  for (const [forbidden, key] of [
    [s, s],
    [s, Buffer.from(s).toString("base64url")],

  ]) {
    for (const live of [true, false]) assert.deepEqual(load({ v: 1, keys: [{ ...g1, key }] }, { live, forbidden: [forbidden] }), { ok: false, problem: "key_reused" });
  }
  // A secret whose text is the base64url decoding of nothing in particular, but whose bytes equal the key's bytes.
  const bytes = randomBytes(32);
  assert.equal(load({ v: 1, keys: [{ ...g1, key: bytes.toString("base64url") }] }, { forbidden: [bytes.toString("base64url")] }).problem, "key_reused");
  // A different secret is fine.
  assert.ok(load({ v: 1, keys: [g1] }, { forbidden: [k(), "a-context-secret-that-is-plain-text-000000"] }).ok);
});

test("M1: through the env binding, every pair that could share a string is refused for APPROVAL_SIGNING_KEYS", async () => {
  const s = k();
  const other = (key) => oneKey(key, "order-auth-g1");
  for (const [label, env] of [
    ["CONTEXT_SECRET", { CONTEXT_SECRET: s }],
    ["ORDER_AUTH_CONSUMER_KEY", { ORDER_AUTH_CONSUMER_KEY: s }],
    ["ORDER_AUTH_SIGNING_KEYS", { ORDER_AUTH_SIGNING_KEYS: other(s) }],
  ]) {
    await withSigningEnv({ TICKETSTUB_RUNTIME_MODE: "live", APPROVAL_SIGNING_KEYS: oneKey(s), ...env }, async ({ approvalKeyring }, lines) => {
      assert.equal(approvalKeyring(), null, `${label} reused as an approval key must be refused`);
      assert.ok(lines.every((l) => !l.includes(s)), "the log never carries the value");
    });
  }
  await withSigningEnv({ TICKETSTUB_RUNTIME_MODE: "live", APPROVAL_SIGNING_KEYS: oneKey(s), CONTEXT_SECRET: k(), ORDER_AUTH_CONSUMER_KEY: k(), ORDER_AUTH_SIGNING_KEYS: other(k()) }, async ({ approvalKeyring }) => {
    assert.equal(approvalKeyring()?.mode, "live", "distinct secrets load");
  });
});

test("L3: a production build outside live runtime warns once when it falls back to a per-process approval key", async () => {
  await withSigningEnv({ NODE_ENV: "production" }, async ({ approvalKeyring }, lines) => {
    assert.equal(approvalKeyring().signer().kid, "sandbox");
    approvalKeyring();
    const warned = lines.filter((l) => l.includes("APPROVAL_SIGNING_KEYS") && /not "live" in a production build/.test(l));
    assert.equal(warned.length, 1, lines.join("\n"));
  });
  await withSigningEnv({ NODE_ENV: "production", TICKETSTUB_RUNTIME_MODE: "live", APPROVAL_SIGNING_KEYS: oneKey(k()) }, async ({ approvalKeyring }, lines) => {
    assert.equal(approvalKeyring().mode, "live");
    assert.equal(lines.length, 0, "a configured live set says nothing");
  });
});

test("N2: a retired key refuses signing after its retirement (plus skew), and one with no readable time", () => {
  const kr = ring(rotated());
  const retiredAt = NOW - DAY;
  const g1Signer = { kid: "approval-g1", key: Buffer.from(K1, "base64url") };
  const at = (issued) => signApproval(record({ issuedAt: iso(issued), expiresAt: iso(issued + APPROVAL_TTL_MS) }), g1Signer, issued);
  assert.equal(verifyWith(kr, at(retiredAt - 3600_000)), "ok", "issued before retirement: verifies through retention");
  assert.equal(verifyWith(kr, at(retiredAt + 5 * 60_000)), "ok", "inside the skew: still accepted");
  assert.equal(verifyWith(kr, at(retiredAt + 5 * 60_000 + 1)), "forged", "a token claiming issue after retirement is refused (accidental late signing; a leaked key could backdate)");
  assert.equal(kr.lookup("approval-g1", NOW, Number.NaN), null, "an unreadable issue time is refused for a retired key");
  // Documented limit: a holder of the retired key can backdate signedAt, and the token then verifies until retention ends.
  // Only deleting the entry stops that.
  assert.equal(verifyWith(kr, signApproval(record({ issuedAt: iso(retiredAt), expiresAt: iso(NOW + APPROVAL_TTL_MS) }), g1Signer, retiredAt)), "ok");
  const deleted = ring({ v: 1, keys: [rotated().keys[0]] });
  assert.equal(verifyWith(deleted, signApproval(record({ issuedAt: iso(retiredAt), expiresAt: iso(NOW + APPROVAL_TTL_MS) }), g1Signer)), "forged");
  assert.ok(kr.lookup("approval-g2", NOW, Number.NaN), "the active key is not affected");
});
