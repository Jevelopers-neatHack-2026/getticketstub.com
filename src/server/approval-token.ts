// The artwork approval record (ticketstub.approval/1), its signed token and its verifier. Pure (node:crypto only,
// no app imports) so the fixture generator, the unit tests and scripts/check-approval.mjs run this exact code
// under plain Node. Only server code imports it; the offline reference for consumers is fixtures/approval/verify.mjs.
//
// An approval says: this signed-in owner approved THIS exact design version, art, printed facts and composition
// for THIS purpose, until expiresAt. It is not a purchase authorization, a payment, an order or an asset-rights
// grant (notAuthorizes says so inside the signed record). Revocation and staleness are not in the token: they
// are the issuer's current answer, passed to the verifier as `state` (see verifyApproval).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const APPROVAL_SCHEMA = "ticketstub.approval/1";
/** `print.compose`: permission to compose the print preview. `artifact.download`: permission to hand the exact art to its owner. */
export const APPROVAL_PURPOSES = ["print.compose", "artifact.download"] as const;
export type ApprovalPurpose = (typeof APPROVAL_PURPOSES)[number];
/** What an approval never grants. Part of the signed record, so no consumer can read more into it. */
export const NOT_AUTHORIZED = ["purchase", "payment", "order", "asset_rights"] as const;
export const APPROVAL_TTL_MS = 7 * 24 * 3600_000;

export type ApprovalFailure = "unknown" | "forged" | "expired" | "revoked" | "stale" | "wrong_scope" | "wrong_purpose" | "content_mismatch" | "content_missing" | "invalid_clock" | "unsupported_version";
export const APPROVAL_FAILURES: readonly ApprovalFailure[] = ["unknown", "forged", "expired", "revoked", "stale", "wrong_scope", "wrong_purpose", "content_mismatch", "content_missing", "invalid_clock", "unsupported_version"];

/** The commitments a consumer must hold and compare for each purpose ("all that apply"). Others are optional but must match if supplied. */
export const REQUIRED_CONTENT: Record<ApprovalPurpose, readonly (keyof ApprovalHashes)[]> = {
  "print.compose": ["designHash", "artHash", "factsHash", "compositionHash"],
  "artifact.download": ["artHash"],
};
const CONTENT_KEYS = ["designHash", "artHash", "factsHash", "compositionHash"] as const;

/** The hashes an approval binds. All SHA-256, lower-case hex, over canonical JSON (see canonicalJson) except artHash for source "bytes". */
export interface ApprovalHashes {
  /** The selected DesignVersion, as canonical JSON. NOT the studio's versionHash, which is a short display checksum. */
  designHash: string;
  /** source "bytes": SHA-256 of the stored art file's bytes. source "ref": of the canonical art reference (procedural seed, or an image url we hold no bytes for). */
  artHash: string;
  /** The event facts printed on the stub (title, venue, date, seat and the kept facts), as canonical JSON. */
  factsHash: string;
  /** edition + material + finish + size + personalization (type, colour, foil, hidden fields, note, guest name), as canonical JSON. */
  compositionHash: string;
}

export interface ApprovalBinding extends ApprovalHashes {
  hashAlg: "sha256";
  versionId: string;
  artSource: "bytes" | "ref";
  composition: { edition: string; material: string; finish: string; size: string };
}

export interface ApprovalRecord {
  schema: typeof APPROVAL_SCHEMA;
  id: string;
  issuer: "ticketstub";
  tenant: { id: string };
  project: { kind: "stub"; id: string };
  purpose: ApprovalPurpose;
  /** The signed-in owner who clicked approve. */
  actor: { kind: "account"; id: string };
  binding: ApprovalBinding;
  /** The account's membershipRevision at issue. A later change (signed out everywhere, email change) makes the approval stale. */
  membershipRevision: number;
  notAuthorizes: typeof NOT_AUTHORIZED;
  environment: "development" | "preview" | "live";
  mode: "fixture" | "sandbox" | "live";
  issuedAt: string;
  expiresAt: string;
}

/** What the issuer says right now about an approval. Without it only signature, version, scope, purpose, content and expiry are checked. */
export interface ApprovalState {
  /** False when the issuer has no record of this id. */
  known?: boolean;
  /** True once a revocation row exists. */
  revoked?: boolean;
  /** The hashes of the project as it is now, computed from the stub (null: the project is gone or unreadable). A difference makes the approval stale. */
  current?: (ApprovalHashes & { versionId: string }) | null;
  /** The account's current membershipRevision. */
  membershipRevision?: number;
}

/** What the consumer says it is doing and holding. A consumer MUST pass tenant, project and purpose, and the hash of the content it holds. */
export interface ApprovalExpectation {
  tenant?: string;
  project?: { kind: string; id: string };
  purpose?: string;
  /** Hashes the consumer computed itself, from the bytes or inputs it holds. print.compose needs all four, artifact.download needs artHash; any it names must equal the bound one. */
  content?: Partial<ApprovalHashes>;
}

export type ApprovalVerifyResult = { ok: true; approval: ApprovalRecord } | { ok: false; reason: ApprovalFailure };

// ---------------------------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------------------------

/** Keys sorted, no whitespace, undefined dropped. The same value always gives the same string, whatever order its keys came in. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
export const hashJson = (v: unknown): string => sha256Hex(canonicalJson(v));

// A structural slice of the studio's Stub: only what is printed or composed. Photos, friends, wall position and
// timestamps are not bound (they do not change the printed stub), so editing them does not stale an approval.
export interface BindableStub {
  event: { type?: string; title?: string; subtitle?: string; venue?: string; city?: string; dateISO?: string; seat?: string; facts?: { id: string; label: string; value: string; source: string; provenance: string; kept?: boolean }[] };
  versions: { id: string; edition: string; art: { kind: string; seed?: number; src?: string; vibe?: string } }[];
  currentVersionId: string;
  personal: { titleFont: number; titleColor: string; foilTitle: boolean; hiddenFields: string[]; note?: string; guestName?: string };
  material: string;
  finish: string;
}

export const HEX64 = /^[a-f0-9]{64}$/;

/** The reference hash for art we hold no bytes of: a procedural seed, or an image url. */
export function artRefHash(art: BindableStub["versions"][number]["art"]): string {
  return hashJson({ kind: art.kind, seed: art.seed, src: art.src, vibe: art.vibe });
}

/**
 * The binding for the stub's selected version. `art` is what the caller could establish about the art:
 * the SHA-256 of the stored file's bytes (source "bytes"), or the reference hash (source "ref").
 * Returns null when currentVersionId names no version.
 */
export function bindStub(stub: BindableStub, size: string, art: { hash: string; source: "bytes" | "ref" }): ApprovalBinding | null {
  const version = stub.versions.find((v) => v.id === stub.currentVersionId);
  if (!version) return null;
  const e = stub.event;
  const composition = { edition: version.edition, material: stub.material, finish: stub.finish, size };
  const p = stub.personal;
  return {
    hashAlg: "sha256",
    versionId: version.id,
    artSource: art.source,
    artHash: art.hash,
    designHash: hashJson(version),
    factsHash: hashJson({
      event: { type: e.type, title: e.title, subtitle: e.subtitle, venue: e.venue, city: e.city, dateISO: e.dateISO, seat: e.seat },
      kept: (e.facts ?? [])
        .filter((f) => f.kept)
        .map((f) => ({ id: f.id, label: f.label, value: f.value, source: f.source, provenance: f.provenance }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }),
    composition,
    compositionHash: hashJson({
      composition,
      personal: { titleFont: p.titleFont, titleColor: p.titleColor, foilTitle: p.foilTitle, hiddenFields: [...p.hiddenFields].sort(), note: p.note, guestName: p.guestName },
    }),
  };
}

/** The four hashes and version of a binding, for the stale comparison. */
export const hashesOf = (b: ApprovalBinding): ApprovalHashes & { versionId: string } => ({
  versionId: b.versionId,
  designHash: b.designHash,
  artHash: b.artHash,
  factsHash: b.factsHash,
  compositionHash: b.compositionHash,
});

// ---------------------------------------------------------------------------------------------
// Signing and verifying
// ---------------------------------------------------------------------------------------------

const MAX_TOKEN_CHARS = 8192;
const HEADER = { alg: "HS256", typ: "ticketstub.approval" } as const;
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** The key that signs: its `kid` goes in the header. On the server it is the active key of APPROVAL_SIGNING_KEYS. */
export interface ApprovalSigningKey {
  kid: string;
  key: string | Buffer;
}
/**
 * The keys a verifier accepts, by kid: a lookup function (the server's keyring) or a plain { kid: key } map (a consumer,
 * the fixtures). A kid the lookup does not know verifies nothing.
 */
export type ApprovalKeys = ((kid: string, issuedAtMs: number) => string | Buffer | null | undefined) | Readonly<Record<string, string | Buffer>>;
const KID = /^[A-Za-z0-9._-]{1,64}$/;

/** issuedAtMs: the token's claimed issue time (NaN when unreadable), so a keyring can refuse a retired key signing after retirement. */
function keyFor(keys: ApprovalKeys, kid: string, issuedAtMs: number): string | Buffer | null {
  const k = typeof keys === "function" ? keys(kid, issuedAtMs) : Object.hasOwn(keys, kid) ? keys[kid] : null;
  return (typeof k === "string" && k.length > 0) || (Buffer.isBuffer(k) && k.length > 0) ? k : null;
}

/** Signs a record. The token is derived, never stored: the same record and key always give the same token. */
export function signApproval(record: ApprovalRecord, signer: ApprovalSigningKey): string {
  if (!KID.test(signer.kid)) throw new Error("approval signing key has an invalid kid");
  const head = b64(JSON.stringify({ ...HEADER, kid: signer.kid }));
  const body = b64(JSON.stringify({ approval: record }));
  const sig = createHmac("sha256", signer.key).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function shaped(v: unknown): v is ApprovalRecord {
  if (!isObj(v) || !isObj(v.tenant) || !isObj(v.project) || !isObj(v.actor) || !isObj(v.binding)) return false;
  const b = v.binding;
  if (typeof v.id !== "string" || typeof v.tenant.id !== "string" || v.project.kind !== "stub" || typeof v.project.id !== "string") return false;
  if (typeof v.purpose !== "string" || v.actor.kind !== "account" || typeof v.actor.id !== "string") return false;
  if (b.hashAlg !== "sha256" || typeof b.versionId !== "string" || !["bytes", "ref"].includes(String(b.artSource)) || !isObj(b.composition)) return false;
  if (![b.designHash, b.artHash, b.factsHash, b.compositionHash].every((h) => typeof h === "string" && HEX64.test(h))) return false;
  if (!Number.isInteger(v.membershipRevision) || !Array.isArray(v.notAuthorizes) || !isIso(v.issuedAt) || !isIso(v.expiresAt)) return false;
  return ["development", "preview", "live"].includes(String(v.environment)) && ["fixture", "sandbox", "live"].includes(String(v.mode));
}

/** The record inside a token, without checking anything. For reading ids; never for trusting. */
export function approvalIdOf(token: string): string | null {
  try {
    const id = (JSON.parse(unb64(token.split(".")[1] ?? "").toString("utf8")) as { approval?: { id?: unknown } }).approval?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Checks in this order, first failure wins:
 *   invalid_clock (`now` is not a finite number > 0: the verifier's own clock is bad, nothing can be judged)
 *   -> unknown (not a token, no or malformed kid, or the issuer has no such record) -> forged (unknown kid, or HMAC, constant time) -> unsupported_version
 *   -> wrong_scope (tenant or project differs from the consumer's) -> wrong_purpose -> expired -> revoked
 *   -> stale (the stub or the account moved on since) -> content_missing (a hash this purpose requires was not supplied)
 *   -> content_mismatch (a supplied hash is malformed or differs from the bound one).
 * revoked, stale and `known` need `state`; without it they are not checked, so a consumer that wants them asks the issuer
 * (POST /api/approvals/verify) or supplies state it got from the issuer.
 */
export function verifyApproval(token: string, keys: ApprovalKeys, expect: ApprovalExpectation, now = Date.now(), state?: ApprovalState): ApprovalVerifyResult {
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) return { ok: false, reason: "invalid_clock" };
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "unknown" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "unknown" };
  let head: unknown;
  let body: unknown;
  try {
    head = JSON.parse(unb64(parts[0]).toString("utf8"));
    body = JSON.parse(unb64(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, reason: "unknown" };
  }
  if (!isObj(head) || head.alg !== HEADER.alg || head.typ !== HEADER.typ || typeof head.kid !== "string" || !KID.test(head.kid) || !isObj(body)) return { ok: false, reason: "unknown" };
  const claimedIssue = isObj(body.approval) && typeof body.approval.issuedAt === "string" ? Date.parse(body.approval.issuedAt) : Number.NaN;
  const key = keyFor(keys, head.kid, claimedIssue);
  if (!key) return { ok: false, reason: "forged" }; // an unknown kid, or a retired key past retention: no key we hold signed it
  const want = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const got = unb64(parts[2]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "forged" };
  const rec = body.approval;
  if (!isObj(rec)) return { ok: false, reason: "unknown" };
  if (rec.schema !== APPROVAL_SCHEMA) return { ok: false, reason: "unsupported_version" };
  if (!shaped(rec)) return { ok: false, reason: "unknown" };
  if (state?.known === false) return { ok: false, reason: "unknown" };
  if (expect.tenant !== rec.tenant.id || expect.project?.kind !== rec.project.kind || expect.project?.id !== rec.project.id) return { ok: false, reason: "wrong_scope" };
  if (expect.purpose !== rec.purpose || !(APPROVAL_PURPOSES as readonly string[]).includes(rec.purpose)) return { ok: false, reason: "wrong_purpose" };
  const issuedMs = Date.parse(rec.issuedAt);
  const expiresMs = Date.parse(rec.expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) return { ok: false, reason: "unknown" };
  if (expiresMs <= now) return { ok: false, reason: "expired" };
  if (state?.revoked) return { ok: false, reason: "revoked" };
  if (state) {
    if (state.membershipRevision !== undefined && state.membershipRevision !== rec.membershipRevision) return { ok: false, reason: "stale" };
    if (state.current !== undefined) {
      const c = state.current;
      const b = rec.binding;
      if (!c || c.versionId !== b.versionId || c.designHash !== b.designHash || c.artHash !== b.artHash || c.factsHash !== b.factsHash || c.compositionHash !== b.compositionHash) return { ok: false, reason: "stale" };
    }
  }
  // Every commitment this purpose applies to must be supplied; any supplied hash must be 64 lower-case hex and equal the bound one.
  const content: Record<string, unknown> = isObj(expect.content) ? expect.content : {};
  const need = REQUIRED_CONTENT[rec.purpose];
  if (need.some((k) => content[k] === undefined)) return { ok: false, reason: "content_missing" };
  for (const k of CONTENT_KEYS) {
    const held = content[k];
    if (held === undefined) continue;
    if (typeof held !== "string" || !HEX64.test(held) || held !== rec.binding[k]) return { ok: false, reason: "content_mismatch" };
  }
  return { ok: true, approval: rec };
}
