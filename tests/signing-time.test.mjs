import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadKeyring, DEFAULT_MAX_CLOCK_SKEW_MS } from "../src/server/keyring.ts";
import { signApproval, verifyApproval, APPROVAL_TTL_MS } from "../src/server/approval-token.ts";
import { signOrderAuthorization, verifyOrderAuthorization, ORDER_AUTH_TTL_MS } from "../src/server/order-auth-token.ts";
import { verifyApproval as referenceApproval } from "../fixtures/approval/verify.mjs";
import { verifyOrderAuthorization as referenceOrder } from "../fixtures/order-authorization/verify.mjs";

// Public synthetic fixture records and keys; no application storage or provider is used.
const CREATED = Date.parse("2026-10-12T12:00:00.000Z");
const RETIRED = CREATED + 60_000;
const LATE = RETIRED + DEFAULT_MAX_CLOCK_SKEW_MS + 60_000;
const iso = (time) => new Date(time).toISOString();
const oldKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const newKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 65));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const header = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
const payload = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));

for (const spec of [
  { name: "approval", env: "APPROVAL_SIGNING_KEYS", typ: "ticketstub.approval", field: "approval", file: "approval/valid-artifact-download.json", ttl: APPROVAL_TTL_MS, sign: signApproval, verify: verifyApproval, reference: referenceApproval },
  { name: "order", env: "ORDER_AUTH_SIGNING_KEYS", typ: "ticketstub.order-authorization", field: "authorization", file: "order-authorization/valid-submit.json", ttl: ORDER_AUTH_TTL_MS, sign: signOrderAuthorization, verify: verifyOrderAuthorization, reference: referenceOrder },
]) {
  const fixture = JSON.parse(readFileSync(new URL(`../fixtures/${spec.file}`, import.meta.url), "utf8"));
  const record = { ...payload(fixture.token)[spec.field], issuedAt: iso(CREATED), expiresAt: iso(CREATED + spec.ttl) };
  const expect = spec.field === "approval"
    ? { tenant: record.tenant.id, project: record.project, purpose: record.purpose, content: { artHash: record.binding.artHash } }
    : fixture.expect;
  const old = { kid: `${spec.name}-g1`, key: oldKey };
  const fresh = { kid: `${spec.name}-g2`, key: newKey };
  const result = loadKeyring({ name: spec.env, live: true, retentionMs: spec.ttl, now: LATE, fallback: () => newKey,
    raw: JSON.stringify({ v: 1, keys: [
      { ...fresh, key: newKey.toString("base64url"), state: "active", activatedAt: iso(RETIRED) },
      { ...old, key: oldKey.toString("base64url"), state: "retired", activatedAt: iso(CREATED - 86400_000), retiredAt: iso(RETIRED) },
    ] }),
  });
  assert.ok(result.ok);
  const keys = (kid, time) => result.keyring.lookup(kid, LATE, time);
  const verifyBoth = (token, lookup = keys, now = LATE) => {
    const actual = spec.verify(token, lookup, expect, now);
    const reference = spec.reference(token, lookup, expect, { now });
    assert.deepEqual(reference, actual, "offline consumer reference agrees with the application verifier");
    return actual;
  };
  const signedHeader = (head, body = { [spec.field]: record }) => {
    const h = encode(head), b = encode(body);
    return `${h}.${b}.${createHmac("sha256", oldKey).update(`${h}.${b}`).digest("base64url")}`;
  };

  test(`${spec.name}: a stale instance cannot re-sign an old record after retirement plus skew`, (t) => {
    let clock = CREATED;
    t.mock.method(Date, "now", () => clock);
    const before = spec.sign(record, old);
    clock = LATE;
    const late = spec.sign(record, old);
    const active = spec.sign(record, fresh);
    assert.equal(header(late).signedAt, iso(LATE), "default signing clock is read at the actual call, not record creation");
    assert.equal(header(before).signedAt, iso(CREATED));
    assert.notEqual(before, late);
    assert.deepEqual(payload(late), payload(before), "re-signing never changes the authorized record or expiry");
    assert.equal(verifyBoth(before).ok, true, "legitimate pre-retirement signature retains its lifetime");
    assert.equal(verifyBoth(late).reason, "forged", "late signing with the retired key is refused");
    assert.equal(verifyBoth(active).ok, true, "the current active key can refresh the same record");
    assert.equal(result.keyring.lookup(old.kid, LATE, LATE), null, "actual late signing time is outside the key cutoff");
  });

  test(`${spec.name}: the signed timestamp cannot be edited or downgraded to a malformed value`, () => {
    const good = spec.sign(record, old, CREATED);
    const [, body, signature] = good.split(".");
    const altered = `${encode({ ...header(good), signedAt: iso(CREATED + 1) })}.${body}.${signature}`;
    assert.equal(verifyBoth(altered).reason, "forged");
    for (const signedAt of [null, 0, {}, "not-a-date", "123", "2026-10-12", "1970-01-01T00:00:00.000Z"]) {
      const malformed = signedHeader({ alg: "HS256", typ: spec.typ, kid: old.kid, signedAt });
      assert.equal(verifyBoth(malformed).reason, "unknown", "a present invalid timestamp never gets legacy fallback");
    }
  });

  test(`${spec.name}: legacy no-timestamp tokens retain bounded rotation compatibility without a signing-time claim`, () => {
    const legacy = signedHeader({ alg: "HS256", typ: spec.typ, kid: old.kid });
    assert.equal(verifyBoth(legacy).ok, true, "legacy record issue time remains a compatibility fallback");
    const end = RETIRED + spec.ttl + DEFAULT_MAX_CLOCK_SKEW_MS;
    assert.equal(verifyBoth(legacy, (kid, time) => result.keyring.lookup(kid, end, time), end).reason, "forged");
    assert.deepEqual(payload(legacy)[spec.field], record);
    // An old-code late re-sign has these same bytes. Only an issuer rollout or key removal resolves that limitation.
    assert.equal(legacy, signedHeader({ alg: "HS256", typ: spec.typ, kid: old.kid }));
  });

  test(`${spec.name}: explicit fixture clocks are deterministic and invalid signing clocks fail`, () => {
    assert.equal(spec.sign(record, old, CREATED), spec.sign(record, old, CREATED));
    for (const time of [Number.NaN, Infinity, -1, 0]) assert.throws(() => spec.sign(record, old, time));
  });
}
