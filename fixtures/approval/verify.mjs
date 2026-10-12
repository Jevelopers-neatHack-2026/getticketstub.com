// Reference verifier for a ticketstub.approval/1 token. No dependencies: copy these functions into a consumer.
//   node fixtures/approval/verify.mjs        checks every fixture in this folder against its expected outcome
// verifyApproval(token, key, expect, { now, state }) -> { ok: true, approval } | { ok: false, reason }
// reason is one of: unknown | forged | expired | revoked | stale | wrong_scope | wrong_purpose | content_mismatch | content_missing
//   | invalid_clock | unsupported_version
// expect MUST name { tenant, project: { kind, id }, purpose, content } where content holds the hashes the consumer computed
// from what it holds (hashBytes(art bytes) for artHash, contentHashes(stub, size) for the rest). The consumer must hold and compare
// EVERY commitment that applies: print.compose needs designHash, artHash, factsHash and compositionHash; artifact.download needs
// artHash. A missing one is content_missing, a malformed or different one is content_mismatch, and content = {} never passes.
// `now` must be a finite number > 0 (ms since epoch) or the answer is invalid_clock. Without `state` it proves signature, version, scope, purpose, content
// and expiry only. revoked, stale and unknown need the issuer's current answer (README.md: POST /api/approvals/verify).
// An approval is NOT a purchase authorization: no purpose here authorizes buying anything.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "ticketstub.approval/1";
const PURPOSES = ["print.compose", "artifact.download"];
const HEX64 = /^[a-f0-9]{64}$/;
const HASH_KEYS = ["designHash", "artHash", "factsHash", "compositionHash"];
/** The commitments each purpose requires the consumer to supply and compare ("all that apply"). */
const REQUIRED_CONTENT = { "print.compose": HASH_KEYS, "artifact.download": ["artHash"] };
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const dec = (s) => Buffer.from(s, "base64url");
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
/** SHA-256 of the art bytes: the artHash of a binding whose artSource is "bytes". */
export const hashBytes = (bytes) => sha256Hex(bytes);

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

/** Recomputes designHash, factsHash and compositionHash from a stub shaped like content.json's, so a consumer holding the inputs can check them. */
export function contentHashes(stub, size) {
  const version = stub.versions.find((v) => v.id === stub.currentVersionId);
  const e = stub.event;
  const p = stub.personal;
  const composition = { edition: version.edition, material: stub.material, finish: stub.finish, size };
  return {
    designHash: hashJson(version),
    factsHash: hashJson({
      event: { type: e.type, title: e.title, subtitle: e.subtitle, venue: e.venue, city: e.city, dateISO: e.dateISO, seat: e.seat },
      kept: (e.facts ?? [])
        .filter((f) => f.kept)
        .map((f) => ({ id: f.id, label: f.label, value: f.value, source: f.source, provenance: f.provenance }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }),
    compositionHash: hashJson({ composition, personal: { titleFont: p.titleFont, titleColor: p.titleColor, foilTitle: p.foilTitle, hiddenFields: [...p.hiddenFields].sort(), note: p.note, guestName: p.guestName } }),
  };
}

export function verifyApproval(token, key, expect, { now = Date.now(), state } = {}) {
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) return { ok: false, reason: "invalid_clock" };
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
  if (!isObj(head) || head.alg !== "HS256" || head.typ !== "ticketstub.approval" || !isObj(body)) return { ok: false, reason: "unknown" };
  const want = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const got = dec(parts[2]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "forged" };
  const r = body.approval;
  if (!isObj(r)) return { ok: false, reason: "unknown" };
  if (r.schema !== SCHEMA) return { ok: false, reason: "unsupported_version" };
  const b = r.binding;
  const shaped =
    isObj(r.tenant) && typeof r.tenant.id === "string" && typeof r.id === "string" && isObj(r.project) && r.project.kind === "stub" && typeof r.project.id === "string" &&
    typeof r.purpose === "string" && isObj(r.actor) && r.actor.kind === "account" && isObj(b) && b.hashAlg === "sha256" && typeof b.versionId === "string" &&
    [b.designHash, b.artHash, b.factsHash, b.compositionHash].every((h) => typeof h === "string" && HEX64.test(h)) &&
    Number.isInteger(r.membershipRevision) && Array.isArray(r.notAuthorizes) && isIso(r.issuedAt) && isIso(r.expiresAt);
  if (!shaped) return { ok: false, reason: "unknown" };
  if (state?.known === false) return { ok: false, reason: "unknown" };
  if (expect.tenant !== r.tenant.id || expect.project?.kind !== r.project.kind || expect.project?.id !== r.project.id) return { ok: false, reason: "wrong_scope" };
  if (expect.purpose !== r.purpose || !PURPOSES.includes(r.purpose)) return { ok: false, reason: "wrong_purpose" };
  const expiresMs = Date.parse(r.expiresAt);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(Date.parse(r.issuedAt))) return { ok: false, reason: "unknown" };
  if (expiresMs <= now) return { ok: false, reason: "expired" };
  if (state?.revoked) return { ok: false, reason: "revoked" };
  if (state) {
    if (state.membershipRevision !== undefined && state.membershipRevision !== r.membershipRevision) return { ok: false, reason: "stale" };
    if (state.current !== undefined) {
      const c = state.current;
      if (!c || c.versionId !== b.versionId || c.designHash !== b.designHash || c.artHash !== b.artHash || c.factsHash !== b.factsHash || c.compositionHash !== b.compositionHash) return { ok: false, reason: "stale" };
    }
  }
  const content = isObj(expect.content) ? expect.content : {};
  if (REQUIRED_CONTENT[r.purpose].some((k) => content[k] === undefined)) return { ok: false, reason: "content_missing" };
  for (const k of HASH_KEYS) {
    if (content[k] === undefined) continue;
    if (typeof content[k] !== "string" || !HEX64.test(content[k]) || content[k] !== b[k]) return { ok: false, reason: "content_mismatch" };
  }
  return { ok: true, approval: r };
}

/** The clocks a fixture may name by tag, because JSON cannot hold NaN or Infinity. */
export const CLOCKS = { nan: Number.NaN, infinity: Number.POSITIVE_INFINITY, negative: -1, string: "1791633600000" };

/**
 * Runs one fixture the way a consumer would: hash the bytes it holds, recompute the other commitments from the stub it holds
 * (content.json), name its scope, ask. A fixture may carry `consumer` to change what the consumer supplies:
 *   { omit: [hash names left out], override: { hash name: value }, empty: true, clock: a key of CLOCKS }
 */
export function consumerInputs(fx, contentDoc) {
  const c = contentDoc ?? JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "content.json"), "utf8"));
  const content = { ...contentHashes(c.stub, c.size), artHash: hashBytes(Buffer.from(fx.held.artBase64, "base64")), ...(fx.consumer?.override ?? {}) };
  for (const k of fx.consumer?.omit ?? []) delete content[k];
  if (fx.consumer?.empty) for (const k of Object.keys(content)) delete content[k];
  const now = fx.consumer?.clock !== undefined ? CLOCKS[fx.consumer.clock] : Date.parse(fx.verifyAt);
  return { expect: { ...fx.expect, content }, now };
}

export function runFixture(fx, key, contentDoc) {
  const { expect, now } = consumerInputs(fx, contentDoc);
  return verifyApproval(fx.token, key, expect, { now, state: fx.state });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const key = JSON.parse(readFileSync(join(here, "fixture-key.json"), "utf8")).key;
  const index = JSON.parse(readFileSync(join(here, "index.json"), "utf8"));
  let bad = 0;
  for (const f of index.fixtures) {
    const fx = JSON.parse(readFileSync(join(here, f), "utf8"));
    const r = runFixture(fx, key);
    let ok = r.ok === fx.outcome.ok && (r.ok ? true : r.reason === fx.outcome.reason);
    // Revoked, but the stored bytes stay: authority ends, the bytes are kept and still match the binding, and they may not be used.
    if (ok && fx.retained) ok = hashBytes(Buffer.from(fx.retained.artBase64, "base64")) === fx.retained.mustStillHashTo && fx.retained.mayUse === false && !r.ok;
    // Never a purchase authorization: the record says what it does not authorize, and nothing buys with it.
    if (ok && fx.notAuthorizes) ok = ["purchase", "payment", "order", "asset_rights"].every((x) => fx.notAuthorizes.includes(x)) && !r.ok;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${fx.fixture}: ${r.ok ? "ok" : r.reason}`);
  }
  process.exit(bad ? 1 : 0);
}
