import "server-only";
import { randomBytes } from "node:crypto";
import { TIER_SIZES } from "@/customer/pages/capabilities";
import type { Material, Stub } from "@/customer/studio/types";
import {
  APPROVAL_SCHEMA,
  APPROVAL_TTL_MS,
  NOT_AUTHORIZED,
  approvalIdOf,
  artRefHash,
  bindStub,
  canonicalJson,
  hashesOf,
  hashJson,
  sha256Hex,
  signApproval,
  verifyApproval,
  type ApprovalExpectation,
  type ApprovalFailure,
  type ApprovalPurpose,
  type ApprovalRecord,
  type ApprovalState,
  type ApprovalVerifyResult,
} from "./approval-token";
import { contextEnvironment, type RequestContext } from "./context";
import { readStoredFile } from "./files";
import { HttpError } from "./http";
import { parseSummary, printedSummary, type ApprovalDrift, type ApprovalSummary } from "@/customer/studio/approval/printed";
import { getStorage } from "./index";
import type { Keyring } from "./keyring";
import { approvalKeyring, requireApprovalKeyring } from "./signing-keys";
import type { ApprovalRow, NewApproval } from "./storage";

// Artwork approval, server side: builds the binding from the stub the server holds (never from a body), issues
// the record under the storage write lock, and answers the verifier with the issuer's current state. The record
// and token format live in approval-token.ts; docs/architecture/approval.md explains the model and its limits.

type Size = string;
const FILE_URL = /^\/api\/files\/([a-f0-9]{64}\.(?:png|jpg|webp))$/;

export type ApprovalStatus = "active" | "revoked" | "expired" | "stale";
/** A stored approval as the owner sees it: the signed record plus where it stands right now. */
export interface ApprovalView {
  approval: ApprovalRecord;
  status: ApprovalStatus;
  revokedAt: string | null;
  token: string;
  /** Owner-only, never in the token or the verifier: what was printed (null for an approval issued before this existed). */
  summary: ApprovalSummary | null;
  /** Owner-only: which parts of the stub differ from this approval right now (null when the stub can't be read). */
  drift: ApprovalDrift | null;
}

const unavailable = (message: string) => new HttpError(409, "approval_unavailable", message);

/** The art hash for a version: the SHA-256 of the stored file's bytes, or the reference hash when the studio holds no bytes. Null when a stored file is gone. */
function artFor(art: Stub["versions"][number]["art"]): { hash: string; source: "bytes" | "ref" } | null {
  const m = art.kind === "image" && art.src ? FILE_URL.exec(art.src) : null;
  if (m) {
    const file = readStoredFile(m[1]);
    return file ? { hash: sha256Hex(file.bytes), source: "bytes" } : null;
  }
  return { hash: artRefHash(art), source: "ref" };
}

/** The print size to bind: the one asked for if this material prints at it, else the material's first size. */
export function sizeFor(material: Material, asked: unknown): Size {
  const sizes: readonly string[] = TIER_SIZES[material] ?? [];
  if (asked === undefined || asked === null) return sizes[0] ?? "classic";
  if (typeof asked !== "string" || !sizes.includes(asked)) throw new HttpError(400, "bad_request", "That size isn't available for this material.");
  return asked;
}

/** The binding for the stub as it is now at `size`, or null when it cannot be bound (no selected version, art file gone). */
export function bindingNow(stub: Stub, size: Size) {
  const v = stub.versions.find((x) => x.id === stub.currentVersionId);
  const art = v && artFor(v.art);
  return art ? bindStub(stub, size, art) : null;
}

const newApprovalId = () => `apr_${randomBytes(12).toString("base64url")}`;

/**
 * Issues (or returns the live identical) approval for the stub's selected version. Atomic with the stub read:
 * `expectedVersionId` is what the owner was looking at; if the stub has moved on, nothing is issued (409).
 */
export async function issueApproval(ctx: RequestContext, stubId: string, purpose: ApprovalPurpose, expectedVersionId: string, askedSize: unknown): Promise<{ view: ApprovalView; created: boolean }> {
  if (ctx.actor.kind !== "account") throw new HttpError(401, "unauthorized", "Sign in with an emailed link to do that.");
  const keys = requireApprovalKeyring(); // 503 in live mode without APPROVAL_SIGNING_KEYS (or with an invalid set), before anything is written
  const actorId = ctx.actor.id;
  const now = Date.now();
  const res = await getStorage().issueApproval(ctx.tenant.id, stubId, now, (stub): NewApproval => {
    if (stub.currentVersionId !== expectedVersionId) throw new HttpError(409, "approval_conflict", "The stub changed while you were approving.");
    const size = sizeFor(stub.material, askedSize);
    const binding = bindingNow(stub, size);
    if (!binding) throw unavailable("We can't read this stub's art right now.");
    const record: ApprovalRecord = {
      schema: APPROVAL_SCHEMA,
      id: newApprovalId(),
      issuer: "ticketstub",
      tenant: { id: ctx.tenant.id },
      project: { kind: "stub", id: stubId },
      purpose,
      actor: { kind: "account", id: actorId },
      binding,
      membershipRevision: ctx.membershipRevision,
      notAuthorizes: NOT_AUTHORIZED,
      environment: contextEnvironment(),
      mode: keys.mode,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    return { id: record.id, purpose, idemKey: hashJson({ purpose, binding, membershipRevision: ctx.membershipRevision }), record: canonicalJson(record), summary: JSON.stringify(printedSummary(stub)), issuedAt: now, expiresAt: now + APPROVAL_TTL_MS };
  });
  if (!res) throw new HttpError(404, "not_found", "We couldn't find that.");
  return { view: await viewOf(res.row, keys, now), created: res.created };
}

/** What the issuer says right now about a stored approval. */
async function stateOf(row: ApprovalRow, record: ApprovalRecord): Promise<ApprovalState> {
  const storage = getStorage();
  const [stub, acct] = await Promise.all([storage.getWallStub(record.tenant.id, record.project.id), storage.getAccountState(record.actor.id)]);
  const now = stub ? bindingNow(stub, record.binding.composition.size) : null;
  return {
    known: true,
    revoked: row.revokedAt !== null,
    current: now ? hashesOf(now) : null,
    membershipRevision: acct ? acct.membershipRevision : -1,
  };
}

const STATUS_OF: Partial<Record<ApprovalFailure, ApprovalStatus>> = { expired: "expired", revoked: "revoked", stale: "stale" };

async function viewOf(row: ApprovalRow, keys: Keyring, now: number): Promise<ApprovalView> {
  const record = JSON.parse(row.record) as ApprovalRecord;
  // Re-signed on demand with the active key: after a rotation the owner's list hands out tokens under the new kid,
  // while tokens already handed out keep verifying under the retired kid until they expire.
  const token = signApproval(record, keys.signer());
  // The record checked against its own scope: only expiry, revocation and staleness can fail here.
  const state = await stateOf(row, record);
  // The issuer's own view of its record: the content it holds is the binding itself, so only expiry, revocation and staleness can fail.
  const { designHash, artHash, factsHash, compositionHash } = record.binding;
  const r = verifyApproval(token, (kid, keyTime) => keys.lookup(kid, now, keyTime), { tenant: record.tenant.id, project: record.project, purpose: record.purpose, content: { designHash, artHash, factsHash, compositionHash } }, now, state);
  const status: ApprovalStatus = r.ok ? "active" : (STATUS_OF[r.reason] ?? "stale");
  const b = record.binding;
  const c = state.current;
  const drift: ApprovalDrift | null = c ? { version: c.versionId !== b.versionId, art: c.artHash !== b.artHash, design: c.designHash !== b.designHash, facts: c.factsHash !== b.factsHash, composition: c.compositionHash !== b.compositionHash } : null;
  return { approval: record, status, revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt).toISOString(), token, summary: parseSummary(row.summary), drift };
}

/** Every approval for the owner's stub, newest first, each with its current status. */
export async function listApprovals(tenant: string, stubId: string): Promise<ApprovalView[]> {
  const keys = requireApprovalKeyring();
  const now = Date.now();
  const rows = await getStorage().listApprovals(tenant, stubId);
  return Promise.all(rows.map((r) => viewOf(r, keys, now)));
}

/** Adds the revocation row. The approval and the art bytes stay: only its authority ends. */
export async function revokeApproval(tenant: string, stubId: string, approvalId: string): Promise<"revoked" | "already" | "missing"> {
  return getStorage().revokeApproval(tenant, stubId, approvalId, Date.now());
}

/**
 * The verifier behind POST /api/approvals/verify: signature, version, scope, purpose and expiry from the token, then the issuer's
 * records for revoked, stale and unknown. A token no approval key can verify (no key set, unknown or purged kid, wrong key, a
 * CONTEXT_SECRET signature, the published fixture key) is forged.
 */
export async function verifyApprovalLive(token: string, expect: ApprovalExpectation, now = Date.now()): Promise<ApprovalVerifyResult> {
  const keyring = approvalKeyring();
  if (!keyring) return { ok: false, reason: "forged" }; // no usable key set, nothing can be valid
  const keys = (kid: string, keyTime: number) => keyring.lookup(kid, now, keyTime);
  const first = verifyApproval(token, keys, expect, now);
  if (!first.ok && (first.reason === "invalid_clock" || first.reason === "unknown" || first.reason === "forged" || first.reason === "unsupported_version")) return first;
  // Past here the signature and shape are good, so the id is the issuer's own.
  const id = approvalIdOf(token);
  const row = id ? await getStorage().getApproval(id) : null;
  if (!row) return { ok: false, reason: "unknown" };
  const record = JSON.parse(row.record) as ApprovalRecord;
  // A signed record that differs from what we stored under that id is not something we issued.
  if (canonicalJson(record) !== canonicalJson(tokenRecord(token))) return { ok: false, reason: "forged" };
  return verifyApproval(token, keys, expect, now, await stateOf(row, record));
}

function tokenRecord(token: string): unknown {
  try {
    return (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { approval?: unknown }).approval;
  } catch {
    return null;
  }
}
