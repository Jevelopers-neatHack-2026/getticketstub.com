// A versioned HMAC key set for one token class (artwork approvals, order authorizations). Pure (node:crypto only, no
// app imports) so the unit tests and scripts run this exact code under plain Node; src/server/signing-keys.ts binds it
// to the environment. Decision: integration-evals planning/decisions/0003 row K4. Idioms follow fulfillment-connectors
// src/security.ts and docs/key-management.md (versioned JSON, one active key, retired keys verify through a retention
// window, fail closed, key bytes never leave this module).
//
// Encoding (one environment variable per token class):
//   {"v":1,"keys":[{"kid":"approval-g2","state":"active","activatedAt":"2026-10-12T00:00:00Z","key":"<base64url, >=32 bytes>"},
//                  {"kid":"approval-g1","state":"retired","activatedAt":"2026-07-14T00:00:00Z","retiredAt":"2026-10-12T00:00:00Z","key":"..."}]}
// Signing uses the one active key and puts its kid in the token header. Verification looks the kid up: the active key,
// or a retired key until retiredAt + retentionMs + maxClockSkewMs. An unknown kid, or a retired key past retention,
// verifies nothing.
import { randomBytes } from "node:crypto";

export const KEYSET_VERSION = 1;
/** kid: 1-64 of [A-Za-z0-9._-]. "fixture*" and "sandbox*" are reserved for the published fixtures and the per-process fallback. */
export const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED_KID = /^(fixture|sandbox)/i;
const B64URL = /^[A-Za-z0-9_-]+$/;
export const KEYRING_LIMITS = { minKeyBytes: 32, maxKeyBytes: 1024, maxKeys: 16, minDistinctBytes: 17 } as const;
export const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60_000;
const ENTRY_FIELDS = new Set(["kid", "state", "activatedAt", "retiredAt", "key"]);

/**
 * Why a key set is refused. A fixed vocabulary: none of these ever carries key material, a kid, or the raw value,
 * so it is safe to log and to put in an error.
 */
export type KeysetProblem =
  | "unconfigured"
  | "not_json"
  | "bad_shape"
  | "unsupported_version"
  | "too_many_keys"
  | "bad_kid"
  | "reserved_kid"
  | "duplicate_kid"
  | "bad_state"
  | "bad_time"
  | "future_time"
  | "bad_key"
  | "weak_key"
  | "fixture_key"
  | "duplicate_key"
  | "key_reused"
  | "active_count"
  | "active_not_newest";

export class KeyringError extends Error {
  readonly problem: KeysetProblem;
  constructor(name: string, problem: KeysetProblem) {
    super(`${name} is not usable (${problem})`); // the variable name and a fixed code, never a value
    this.name = "KeyringError";
    this.problem = problem;
  }
}

export interface SigningKey {
  kid: string;
  key: Buffer;
}

export interface KeyringStatus {
  name: string;
  mode: "sandbox" | "live";
  activeKid: string;
  /** Retired kids that still verify (inside retention). */
  verifyingKids: string[];
  /** Retired kids past retention: they verify nothing and can be removed from the secret. */
  purgeableKids: string[];
}

export interface Keyring {
  readonly name: string;
  /** "live" only for a configured key set in live runtime; the per-process fallback and any non-live runtime are "sandbox". */
  readonly mode: "sandbox" | "live";
  /** The active key. */
  signer(): SigningKey;
  /**
   * The key for `kid` if it may verify at `now`, else null. Never throws. With `issuedAt` (ms, from the token being verified),
   * a retired key also refuses a token issued after it was retired (plus skew), or with an unreadable issue time. That stops
   * accidental post-retirement signing (a process that missed the restart). It is not a defence against a compromised key,
   * whose holder can backdate issuedAt: delete a compromised entry from the set at once.
   */
  lookup(kid: unknown, now?: number, issuedAt?: number): Buffer | null;
  /** Versions and rotation state only, never key bytes. */
  status(now?: number): KeyringStatus;
}

export interface KeyringOptions {
  /** The environment variable name, for errors and status. */
  name: string;
  /** The raw environment value (undefined or blank: unconfigured). */
  raw: string | undefined;
  /** True in live runtime: an unconfigured set then fails closed. */
  live: boolean;
  /** How long a retired key keeps verifying after retiredAt: the token class's longest lifetime. */
  retentionMs: number;
  maxClockSkewMs?: number;
  /**
   * Secrets no key in this set may reuse (CONTEXT_SECRET, ORDER_AUTH_CONSUMER_KEY, the other class's key strings), so one
   * secret never signs two classes. Give the raw environment strings: each is compared in both readings (its UTF-8 text,
   * and its base64url decoding) against both readings of every entry (the decoded key bytes, and the key string's text).
   * So the same string pasted into two variables is caught, and so is one variable holding the other's encoding.
   */
  forbidden?: readonly (string | Buffer)[];
  /** The per-process fallback key outside live mode. The caller keeps it for the process lifetime. */
  fallback: () => Buffer;
  now?: number;
}

interface Entry {
  kid: string;
  state: "active" | "retired";
  activatedAt: number;
  retiredAt: number | null;
  key: Buffer;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const parseTime = (v: unknown): number | null => (typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

function decodeKey(name: string, v: unknown): Buffer {
  if (typeof v !== "string" || v.length > 2048 || !B64URL.test(v)) throw new KeyringError(name, "bad_key");
  const bytes = Buffer.from(v, "base64url");
  if (bytes.toString("base64url") !== v) throw new KeyringError(name, "bad_key"); // canonical base64url only
  if (v.includes("FIXTURE-ONLY") || bytes.includes("FIXTURE-ONLY")) throw new KeyringError(name, "fixture_key");
  if (bytes.length < KEYRING_LIMITS.minKeyBytes || bytes.length > KEYRING_LIMITS.maxKeyBytes) throw new KeyringError(name, "weak_key");
  // Degenerate keys only: a repeated byte or a tiny alphabet (fewer than 17 distinct byte values). This is NOT an entropy
  // test: a passphrase or hex text read as base64url passes it. The control is the documented generator (32 random bytes).
  if (new Set(bytes).size < KEYRING_LIMITS.minDistinctBytes) throw new KeyringError(name, "weak_key");
  return bytes;
}

/** Parses and checks the versioned JSON. Throws KeyringError; never returns a partial set. */
/** Both readings of a secret: its text as UTF-8, and its base64url decoding. Readings under 16 bytes are dropped (never a key). */
function readings(secret: string | Buffer): Buffer[] {
  if (Buffer.isBuffer(secret)) return secret.length >= 16 ? [secret] : [];
  const t = secret.trim();
  return [Buffer.from(t), Buffer.from(t, "base64url")].filter((b) => b.length >= 16);
}

/** True when two single-key secrets share a value in either reading (the same string, or one is the other's base64url). */
export function secretsCollide(a: string, b: string): boolean {
  const ra = readings(a);
  return readings(b).some((x) => ra.some((y) => x.equals(y)));
}

export function parseKeyset(name: string, raw: string, opts: { now: number; maxClockSkewMs: number; forbidden?: readonly (string | Buffer)[] }): Entry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new KeyringError(name, "not_json");
  }
  if (!isObj(doc) || Object.keys(doc).some((k) => k !== "v" && k !== "keys")) throw new KeyringError(name, "bad_shape");
  if (doc.v !== KEYSET_VERSION) throw new KeyringError(name, "unsupported_version");
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) throw new KeyringError(name, "bad_shape");
  if (doc.keys.length > KEYRING_LIMITS.maxKeys) throw new KeyringError(name, "too_many_keys");
  const latest = opts.now + opts.maxClockSkewMs;
  const forbidden = (opts.forbidden ?? []).flatMap(readings);
  const entries: Entry[] = doc.keys.map((e: unknown) => {
    if (!isObj(e) || Object.keys(e).some((k) => !ENTRY_FIELDS.has(k))) throw new KeyringError(name, "bad_shape");
    if (typeof e.kid !== "string" || !KID_RE.test(e.kid)) throw new KeyringError(name, "bad_kid");
    if (RESERVED_KID.test(e.kid)) throw new KeyringError(name, "reserved_kid");
    if (e.state !== "active" && e.state !== "retired") throw new KeyringError(name, "bad_state");
    const activatedAt = parseTime(e.activatedAt);
    const retiredAt = e.retiredAt === undefined ? null : parseTime(e.retiredAt);
    if (activatedAt === null || (e.retiredAt !== undefined && retiredAt === null)) throw new KeyringError(name, "bad_time");
    if ((e.state === "retired") !== (retiredAt !== null)) throw new KeyringError(name, "bad_time"); // retiredAt iff retired
    if (retiredAt !== null && retiredAt < activatedAt) throw new KeyringError(name, "bad_time");
    if (activatedAt > latest || (retiredAt !== null && retiredAt > latest)) throw new KeyringError(name, "future_time");
    const key = decodeKey(name, e.key);
    // The entry in both readings (decoded bytes, and the key string as typed) against every reading of every forbidden secret.
    const mine = [key, Buffer.from(e.key as string)];
    if (forbidden.some((f) => mine.some((m) => m.equals(f)))) throw new KeyringError(name, "key_reused");
    return { kid: e.kid, state: e.state, activatedAt, retiredAt, key };
  });
  if (new Set(entries.map((e) => e.kid)).size !== entries.length) throw new KeyringError(name, "duplicate_kid");
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) if (entries[i].key.equals(entries[j].key)) throw new KeyringError(name, "duplicate_key");
  }
  const active = entries.filter((e) => e.state === "active");
  if (active.length !== 1) throw new KeyringError(name, "active_count");
  if (entries.some((e) => e !== active[0] && (e.activatedAt >= active[0].activatedAt || (e.retiredAt ?? 0) > active[0].activatedAt))) throw new KeyringError(name, "active_not_newest");
  return entries;
}

function makeKeyring(name: string, mode: "sandbox" | "live", entries: Entry[], retentionMs: number, skew: number): Keyring {
  const active = entries.find((e) => e.state === "active")!;
  const verifies = (e: Entry, now: number) => e.state === "active" || (e.retiredAt !== null && now < e.retiredAt + retentionMs + skew);
  return {
    name,
    mode,
    signer: () => ({ kid: active.kid, key: active.key }),
    lookup(kid, now = Date.now(), issuedAt) {
      if (typeof kid !== "string" || !KID_RE.test(kid)) return null;
      const e = entries.find((x) => x.kid === kid);
      if (!e || !verifies(e, now)) return null;
      if (issuedAt !== undefined && e.retiredAt !== null && !(Number.isFinite(issuedAt) && issuedAt <= e.retiredAt + skew)) return null;
      return e.key;
    },
    status(now = Date.now()) {
      const retired = entries.filter((e) => e.state === "retired");
      return {
        name,
        mode,
        activeKid: active.kid,
        verifyingKids: retired.filter((e) => verifies(e, now)).map((e) => e.kid),
        purgeableKids: retired.filter((e) => !verifies(e, now)).map((e) => e.kid),
      };
    },
  };
}

/**
 * The keyring for one token class, or the reason it can't be had.
 *   unset or blank, live runtime      -> { ok: false, problem: "unconfigured" } (fail closed: refuse to sign, verify nothing)
 *   unset or blank, any other runtime -> a one-key "sandbox" keyring around the caller's per-process random key
 *   set but invalid, any runtime      -> { ok: false, problem } (a misconfigured secret is never silently replaced)
 *   set and valid                     -> mode "live" in live runtime, else "sandbox"
 */
export function loadKeyring(o: KeyringOptions): { ok: true; keyring: Keyring } | { ok: false; problem: KeysetProblem } {
  const skew = o.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  if (!Number.isFinite(o.retentionMs) || o.retentionMs <= 0) throw new Error(`${o.name}: retentionMs must be a positive number`);
  const now = o.now ?? Date.now();
  const raw = o.raw?.trim();
  if (!raw) {
    if (o.live) return { ok: false, problem: "unconfigured" };
    const key = o.fallback();
    return { ok: true, keyring: makeKeyring(o.name, "sandbox", [{ kid: "sandbox", state: "active", activatedAt: 0, retiredAt: null, key }], o.retentionMs, skew) };
  }
  try {
    return { ok: true, keyring: makeKeyring(o.name, o.live ? "live" : "sandbox", parseKeyset(o.name, raw, { now, maxClockSkewMs: skew, forbidden: o.forbidden }), o.retentionMs, skew) };
  } catch (e) {
    if (e instanceof KeyringError) return { ok: false, problem: e.problem };
    return { ok: false, problem: "bad_shape" };
  }
}

/** A fresh key for a new set entry: 32 random bytes, base64url. For operators and tests; the server never generates a set. */
export const generateKeyMaterial = () => randomBytes(32).toString("base64url");
