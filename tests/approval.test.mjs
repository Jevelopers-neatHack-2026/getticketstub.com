import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { APPROVAL_FAILURES, APPROVAL_SCHEMA, NOT_AUTHORIZED, bindStub, canonicalJson, hashesOf, sha256Hex, signApproval, verifyApproval } from "../src/server/approval-token.ts";
import { contentHashes, verifyApproval as refVerify } from "../fixtures/approval/verify.mjs";

const KEY = "unit-test-key-not-a-secret-0000000000000000";
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const stub = () => ({
  event: { type: "concert", title: "T", venue: "V", facts: [{ id: "a", label: "L", value: "1", source: "s", provenance: "simulated", kept: true }, { id: "b", label: "M", value: "2", source: "s", provenance: "simulated" }] },
  versions: [{ id: "v1", edition: "classic", art: { kind: "procedural", seed: 1 } }],
  currentVersionId: "v1",
  personal: { titleFont: 0, titleColor: "#000", foilTitle: false, hiddenFields: ["b", "a"] },
  material: "print",
  finish: "matte",
});
const ART = { hash: sha256Hex("art"), source: "bytes" };
const bind = (s = stub(), size = "classic") => bindStub(s, size, ART);
const record = (over = {}) => ({
  schema: APPROVAL_SCHEMA, id: "apr_1", issuer: "ticketstub", tenant: { id: "t1" }, project: { kind: "stub", id: "s1" }, purpose: "print.compose",
  actor: { kind: "account", id: "t1" }, binding: bind(), membershipRevision: 2, notAuthorizes: NOT_AUTHORIZED, environment: "development", mode: "sandbox",
  issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3600_000).toISOString(), ...over,
});
const full = (b = bind()) => ({ designHash: b.designHash, artHash: b.artHash, factsHash: b.factsHash, compositionHash: b.compositionHash });
const expect = (over = {}) => ({ tenant: "t1", project: { kind: "stub", id: "s1" }, purpose: "print.compose", content: full(), ...over });
const live = (b = bind()) => ({ known: true, revoked: false, membershipRevision: 2, current: hashesOf(b) });
const reason = (token, e, state, now = NOW) => {
  const r = verifyApproval(token, KEY, e, now, state);
  return r.ok ? "ok" : r.reason;
};

test("canonical JSON ignores key order and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), canonicalJson({ a: [2, { c: undefined, d: 1 }], b: 1 }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test("the binding changes with every printed input and ignores what is not printed", () => {
  const base = bind();
  const hashes = (b) => JSON.stringify([b.designHash, b.factsHash, b.compositionHash, b.artHash]);
  const change = (fn, size) => {
    const s = stub();
    fn(s);
    return hashes(bind(s, size));
  };
  assert.equal(base.hashAlg, "sha256");
  assert.match(base.designHash, /^[a-f0-9]{64}$/);
  for (const [name, fn, size] of [
    ["venue", (s) => (s.event.venue = "W")],
    ["kept fact value", (s) => (s.event.facts[0].value = "9")],
    ["a fact kept", (s) => (s.event.facts[1].kept = true)],
    ["material", (s) => (s.material = "framed")],
    ["finish", (s) => (s.finish = "foil")],
    ["edition", (s) => (s.versions[0].edition = "letterpress")],
    ["title colour", (s) => (s.personal.titleColor = "#fff")],
    ["note", (s) => (s.personal.note = "hi")],
    ["art seed", (s) => (s.versions[0].art.seed = 2)],
    ["size", () => {}, "stamp"],
  ]) assert.notEqual(change(fn, size), hashes(base), `${name} must change the binding`);
  assert.equal(change((s) => (s.personal.hiddenFields = ["a", "b"])), hashes(base), "hidden field order is not content");
  assert.equal(change((s) => (s.event.facts[1].value = "other")), hashes(base), "a fact that is not kept is not printed");
  assert.equal(bindStub({ ...stub(), currentVersionId: "nope" }, "classic", ART), null);
});

test("the fixture verifier recomputes the same hashes as the server binding", () => {
  const content = JSON.parse(readFileSync(new URL("../fixtures/approval/content.json", import.meta.url), "utf8"));
  const b = bindStub(content.stub, content.size, { hash: sha256Hex(Buffer.from(content.artBase64, "base64")), source: "bytes" });
  const h = contentHashes(content.stub, content.size);
  assert.deepEqual([h.designHash, h.factsHash, h.compositionHash], [b.designHash, b.factsHash, b.compositionHash]);
  assert.deepEqual([h.designHash, h.factsHash, h.compositionHash, b.artHash], [content.bound.designHash, content.bound.factsHash, content.bound.compositionHash, content.bound.artHash]);
});

test("a good approval verifies, and every rejection reason is reachable", () => {
  const token = signApproval(record(), KEY);
  assert.equal(reason(token, expect(), live()), "ok");
  const cases = {
    unknown: [reason("junk", expect()), reason(token, expect(), { ...live(), known: false })],
    forged: [reason(signApproval(record(), "another-key-entirely-000000000000000"), expect())],
    unsupported_version: [reason(signApproval(record({ schema: "ticketstub.approval/2" }), KEY), expect())],
    wrong_scope: [reason(token, expect({ tenant: "t2" })), reason(token, expect({ project: { kind: "stub", id: "s2" } }))],
    wrong_purpose: [reason(token, expect({ purpose: "artifact.download" })), reason(token, expect({ purpose: "order.purchase" }))],
    expired: [reason(token, expect(), live(), NOW + 2 * 3600_000)],
    revoked: [reason(token, expect(), { ...live(), revoked: true })],
    stale: [reason(token, expect(), { ...live(), membershipRevision: 3 }), reason(token, expect(), { ...live(), current: null }), reason(token, expect(), live(bind({ ...stub(), finish: "foil" })))],
    content_mismatch: [reason(token, expect({ content: { ...full(), artHash: sha256Hex("other") } }), live())],
    content_missing: [reason(token, expect({ content: {} }), live())],
    invalid_clock: [reason(token, expect(), live(), Number.NaN)],
  };
  for (const [want, got] of Object.entries(cases)) for (const g of got) assert.equal(g, want);
  for (const r of APPROVAL_FAILURES) assert.ok(cases[r], `${r} has a case`);
});

test("a purchase can't be authorized with an approval, and the record says so", () => {
  const token = signApproval(record(), KEY);
  for (const p of ["order.purchase", "payment.authorize", "order.create", "asset.use", "*", ""]) assert.equal(reason(token, expect({ purpose: p }), live()), "wrong_purpose");
  assert.deepEqual([...NOT_AUTHORIZED], ["purchase", "payment", "order", "asset_rights"]);
  // Even a signed record that claims a purchase purpose is refused: the verifier only knows the two approval purposes.
  assert.equal(reason(signApproval(record({ purpose: "order.purchase" }), KEY), expect({ purpose: "order.purchase" }), live()), "wrong_purpose");
});

test("a tampered or re-typed token never verifies", () => {
  const [h, p, s] = signApproval(record(), KEY).split(".");
  const body = JSON.parse(Buffer.from(p, "base64url").toString());
  body.approval.binding.artHash = sha256Hex("evil");
  assert.equal(reason(`${h}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${s}`, expect({ content: { artHash: sha256Hex("evil") } })), "forged");
  const none = Buffer.from(JSON.stringify({ alg: "none", typ: "ticketstub.approval" })).toString("base64url");
  assert.equal(reason(`${none}.${p}.${s}`, expect()), "unknown");
  const ctxHead = Buffer.from(JSON.stringify({ alg: "HS256", typ: "ticketstub.context" })).toString("base64url");
  assert.equal(reason(`${ctxHead}.${p}.${s}`, expect()), "unknown");
  assert.equal(reason(`${h}.${p}.`, expect()), "unknown");
  assert.equal(reason("a".repeat(9000), expect()), "unknown");
});

test("the published fixture key is marked fixture-only so the server can refuse it", () => {
  const k = JSON.parse(readFileSync(new URL("../fixtures/approval/fixture-key.json", import.meta.url), "utf8"));
  assert.ok(k.key.includes("FIXTURE-ONLY") && /never production/i.test(k.warning));
});

const without = (...ks) => Object.fromEntries(Object.entries(full()).filter(([k]) => !ks.includes(k)));
const both = (token, e, state, now = NOW) => {
  const a = verifyApproval(token, KEY, e, now, state);
  const b = refVerify(token, KEY, e, { now, state });
  assert.deepEqual([a.ok, a.reason], [b.ok, b.reason], "server verifier and reference helper agree");
  return a.ok ? "ok" : a.reason;
};

test("print.compose must supply and match every commitment; empty or partial content never passes", () => {
  const token = signApproval(record(), KEY);
  assert.equal(both(token, expect(), live()), "ok");
  assert.equal(both(token, expect({ content: {} }), live()), "content_missing");
  assert.equal(both(token, expect({ content: undefined }), live()), "content_missing");
  assert.equal(both(token, expect({ content: null }), live()), "content_missing");
  assert.equal(both(token, expect({ content: { artHash: ART.hash } }), live()), "content_missing");
  for (const k of ["designHash", "artHash", "factsHash", "compositionHash"]) assert.equal(both(token, expect({ content: without(k) }), live()), "content_missing", `${k} missing`);
  assert.equal(both(token, expect({ content: { ...full(), factsHash: sha256Hex("other") } }), live()), "content_mismatch");
  // Without state the same rule holds.
  assert.equal(both(token, expect({ content: {} })), "content_missing");
});

test("artifact.download needs the art hash; the others are optional but must match when supplied", () => {
  const token = signApproval(record({ purpose: "artifact.download" }), KEY);
  const dl = (content) => expect({ purpose: "artifact.download", content });
  assert.equal(both(token, dl({ artHash: ART.hash }), live()), "ok");
  assert.equal(both(token, dl(full()), live()), "ok");
  assert.equal(both(token, dl({}), live()), "content_missing");
  assert.equal(both(token, dl(without("artHash")), live()), "content_missing");
  assert.equal(both(token, dl({ artHash: ART.hash, designHash: sha256Hex("x") }), live()), "content_mismatch");
});

test("a supplied hash must be 64 lower-case hex, else it is refused", () => {
  const token = signApproval(record(), KEY);
  for (const bad of ["", "nothex", ART.hash.toUpperCase(), ART.hash.slice(1), `${ART.hash}0`, 7, null, {}, [ART.hash]]) assert.equal(both(token, expect({ content: { ...full(), artHash: bad } }), live()), "content_mismatch", JSON.stringify(bad));
});

test("an invalid trusted clock is refused, never treated as not expired", () => {
  const token = signApproval(record(), KEY);
  assert.equal(both(token, expect(), live(), NOW + 2 * 3600_000), "expired", "the ordinary expired control is unchanged");
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, String(NOW), null, {}, [NOW]]) assert.equal(both(token, expect(), live(), now), "invalid_clock", `now=${String(now)}`);
  assert.equal(both("junk", expect(), undefined, Number.NaN), "invalid_clock", "a bad clock is refused before anything else is judged");
});

test("an unparseable issuedAt or expiresAt is unknown, not valid", () => {
  for (const over of [{ expiresAt: "not a date" }, { issuedAt: "not a date" }]) assert.equal(both(signApproval(record(over), KEY), expect(), live()), "unknown");
});
