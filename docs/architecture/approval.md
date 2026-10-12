# Artwork approval (`ticketstub.approval/1`, GT-06B)

A signed-in owner's explicit approval of one exact design, issued by the server, verifiable by a consumer (print-production first), and kept apart from purchase. Format, reasons and fixtures are in `fixtures/approval/README.md`; this page is the model and what is missing.

## What it is, and is not

An approval binds, for one purpose and until it expires: the tenant, the stub, the selected DesignVersion, the art (bytes or reference), the printed facts, and the composition inputs (edition, material, finish, size, personalization), each as a SHA-256, plus the account's `membershipRevision`. Purposes: `print.compose` (permission to compose the print preview) and `artifact.download`.

It is **not** a purchase authorization, a payment, an order, or an asset-rights grant. Those are separate purposes with their own records (GT-07 / #16, #8). The signed record says so (`notAuthorizes`), no purchase purpose exists, and no order, checkout or commerce code reads an approval (checked by `scripts/check-approval.mjs`). A click on Select, Apply or the tear animation is not an approval either: only `POST /api/approvals` from a signed-in owner makes one.

## Flow

```
owner (signed in)                server                                   consumer (print)
  POST /api/approvals ───────►  same-origin check, rate limit
  { stubId, purpose,            ctx = getRequestContext(stub:<id>)
    expectedVersionId, size? }  requireCapability("stub.approve")         404 if not theirs
                                BEGIN IMMEDIATE
                                  read the stub from the owner's wall (never the body)
                                  expectedVersionId != selected? -> 409 approval_conflict
                                  hash version, art bytes, facts, composition
                                  same live approval already? -> return it (idempotent)
                                  else INSERT approvals (append-only)
                                COMMIT; sign token (HMAC); event approval_issued
  ◄── { approval, status, token, created }
                                                                         holds token + the bytes it will use
                                ◄── POST /api/approvals/verify { token, expect: { tenant, project, purpose, content } }
                                    token checks, then the issuer's records:
                                    revoked? stale (stub or account moved on)? unknown?
                                ──► 200 { ok, approval } | 403 { ok:false, reason }
  POST /api/approvals/revoke ─►  INSERT approval_revocations (a new row); event approval_revoked
```

States an approval reads as (computed, never stored): `active`, `expired`, `revoked`, `stale`. The history is kept: a re-approval after any change is a new record and the old one reads `stale`. A revocation is a row in its own table. `UPDATE` is refused by trigger on both tables, and `DELETE` is refused while the owning account exists; rows go only with account deletion.

## What invalidates one

`stale`: a change to the selected version, the art, any printed fact (title, venue, date, seat, kept facts), edition, material, finish, size, type font or colour, foil, hidden fields, note or guest name; or a `membershipRevision` change (signed out everywhere, email change, staff flip). Friends, wall position, photos and timestamps are not printed and do not stale it. Undoing every edit makes the original binding valid again, since the binding is content. `revoked`: the owner revoked it. `expired`: seven days.

## What a consumer must hold and compare

An approval is only as good as the comparison behind it. `print.compose` must supply and match all four commitments (`designHash`, `artHash`, `factsHash`, `compositionHash`); `artifact.download` must supply and match `artHash`, and anything else it supplies must match too. A missing required hash is `content_missing`, a malformed (not 64 lower-case hex) or different one is `content_mismatch`, and empty content never passes. The verifier's clock must be a finite number above zero or the answer is `invalid_clock`; an unparseable `issuedAt` or `expiresAt` is `unknown`. The offline reference (`fixtures/approval/verify.mjs`) and the server apply the same rules, and `scripts/check-approval.mjs` checks they agree. The reasons, in order: `invalid_clock`, `unknown`, `forged`, `unsupported_version`, `wrong_scope`, `wrong_purpose`, `expired`, `revoked`, `stale`, `content_missing`, `content_mismatch`.

## Trust and keys

HMAC-SHA256 with the same key handling as context tokens (`CONTEXT_SECRET`, at least 32 characters). In live mode without it the server refuses to issue (503 `context_unavailable`) and the verify port answers `forged`; outside live mode a per-process random key is used and records say `mode: "sandbox"`. A `CONTEXT_SECRET` containing `FIXTURE-ONLY` is treated as unset, so the published fixture key never works on a server. The token is derived from the stored record on demand and is never stored. The header `typ` differs from a context token's, so neither verifies as the other.

## API

| Route | Capability | Notes |
| --- | --- | --- |
| `POST /api/approvals` | `stub.approve` on `stub:<id>` (signed-in account only) | body `{ stubId, purpose, expectedVersionId, size? }`; Origin required; 404 for a stub the caller can't see; guest owner 401 |
| `GET /api/approvals?project=stub:<id>` | `stub.approve` | owner's history, newest first, each with `status`, `revokedAt`, `token`, and the owner-only `summary` and `drift` (see Review sheet) |
| `POST /api/approvals/revoke` | `stub.approve` | body `{ stubId, approvalId }`; idempotent; another account's id is 404 |
| `POST /api/approvals/verify` | none (the signed token is the capability) | body `{ token, expect }`; no cookie, no Origin; 120/min per address |

Errors use `{ error: { code, message } }`: `approval_conflict` (409), `approval_unavailable` (409, a stored art file is missing), `approval_invalid` (403, verify). Events: `approval_issued`, `approval_revoked` (a purpose, a 16-hex ref and flags; never ids, tokens or hashes).

## UI

The Versions panel's "Selected for print" spot shows the approval state of the selected version and an Approve for print / Revoke action (see `VersionsPanel.tsx`). Approving is an explicit button, shows what is being approved, and sends the selected version id so a stale view is refused.

### Review sheet (GT-06B.1)

"Approve for print" opens a paper sheet (`src/customer/studio/approval/ApproveSheet.tsx`) instead of approving at once. It shows the stub front and back (the editor's `StubView`, static), the printed facts exactly as `bindStub` hashes them (event fields and kept facts, each kept fact with its provenance mark), the composition in words, what changed since the last approval, and a line that approving is not an order or a payment. "Approve this version" calls the same approve API with `expectedVersionId`; on `approval_conflict` it shows the catalog message and re-reads.

What changed is computed in `printed.ts` from two owner-only additions to the list and issue responses, never to the token, the record or `/verify`:

- `summary`: the printed lines at issue time, stored in `approval_summaries` (append-only, one row per approval, written in the same transaction as the approval). Null for an approval issued before it existed.
- `drift`: booleans comparing the approval's version, art, design, facts and composition hashes with the stub the server holds now.

It can say: art changed, a different version with the same art, style, material, finish and size changes (`Finish: Matte → Foil`), and which printed facts were added, removed or changed (`Facts: Date changed`). It cannot say what changed inside the title font and colour, hidden fields, note or guest name (only "Title style, hidden fields or note changed"), art detail beyond "Art changed", or which fact changed for an approval with no stored summary ("Facts changed"). `check-approval.mjs` fails if the sheet's printed lines and `factsHash` ever stop moving together.

## Limitations (read these)

- **No consumer adoption.** print-production, creative-engine and agent-harness do not verify these yet. The fixtures and the offline verifier prove the format, not any consumer's conformance or the canonical protocol (shared-contracts #22 and #23 are open).
- **Not the canonical `ApprovalReceipt`.** No issuer or audience claim, no per-consumer credentials, no key rotation (`kid`), symmetric HMAC only: anyone holding a token can ask the verify port, and anyone holding the key could mint one.
- **No composed-preview binding.** There is no real front/back preview id or hash. `compositionHash` covers the composition inputs, not rendered pixels. GT-06B.7 (an earlier artwork or asset-use receipt permitting composition, a distinct stage from final-use approval) is only partly modelled by the two purposes; final export or order approval of the composed output does not exist.
- **Image bytes are bound only for files the studio stores** (`/api/files/<sha256>`). Procedural art and an image url with no stored file are bound by reference.
- **Server-side checks happen only if the stub is on the account's wall** (`wall_stubs`). A stub that exists only as a share or on a device cannot be approved.
- **Size is chosen by the client** (validated against the material's allowed sizes), since the studio does not store a print size on the stub.
- **No rights approval.** `asset_rights` is named in `notAuthorizes`; nothing here reviews whether an asset may be used.
- **The review sheet shows the studio's own render.** The front and back are the editor's `StubView` of the stub on the device; there is no server-rendered composed preview or hash of it. A device with edits the server has not received yet can show a stub that differs from what the server binds until the next save (the sheet re-reads on every save).
- **Concurrent tabs:** two simultaneous identical approvals collapse to one (storage lock); a selection change during approval is refused (409). There is no cross-tab live notification.
- **SQLite on one host.** The append-only guarantee is enforced by triggers in the one database; a Postgres storage would need the same constraints.
- **Staleness is checked at verify and list time.** Nothing pushes a revocation to a consumer; a consumer that does not call the verify port will not learn of one.
