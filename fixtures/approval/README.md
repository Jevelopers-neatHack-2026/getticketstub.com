# Artwork approval fixtures (`ticketstub.approval/1`)

> **FIXTURE ONLY. NEVER PRODUCTION.** `fixture-key.json` holds the HMAC key these approvals are signed with. It is public on purpose. Records made with it say `"mode": "fixture"`. The server refuses any `CONTEXT_SECRET` containing `FIXTURE-ONLY`, so a production verifier rejects every one of them as `forged`. Fixture success shows a consumer reads the format. It does not show integration with the live issuer, and it is not a consumer-conformance receipt.

Synthetic stub, synthetic art bytes, synthetic ids. Regenerate with `node fixtures/approval/generate.mjs` (deterministic). Check with `node fixtures/approval/verify.mjs`, which has no dependencies: copy `verifyApproval` and `contentHashes` into a consumer.

An approval says: this signed-in owner approved this exact design version, art, printed facts and composition, for one purpose, until `expiresAt`. **It is not a purchase authorization, a payment, an order or an asset-rights grant.** The signed record carries `notAuthorizes: ["purchase","payment","order","asset_rights"]`, and there is no purchase purpose: asking for one is `wrong_purpose`. Purchase authorization is a separate, later record (GT-07 / issue #16).

## The token

`header.body.signature`, three base64url parts, HMAC-SHA256 over `header.body`.

- header: `{"alg":"HS256","typ":"ticketstub.approval"}` (a context token has `typ` `ticketstub.context`, so one never passes as the other)
- body: `{"approval": <record>}`

The record:

| Field | Meaning |
| --- | --- |
| `schema` | `ticketstub.approval/1` |
| `id` | `apr_...`, unique, never reused |
| `issuer` | `ticketstub` |
| `tenant.id` | the owning account |
| `project` | `{ kind: "stub", id }` |
| `purpose` | `print.compose` or `artifact.download` |
| `actor` | the signed-in account that clicked approve |
| `binding.versionId` | the selected DesignVersion |
| `binding.designHash` | SHA-256 of that version as canonical JSON. Not the studio's short `versionHash`, which is a display checksum |
| `binding.artHash`, `binding.artSource` | `bytes`: SHA-256 of the stored art file's bytes. `ref`: SHA-256 of the canonical art reference (procedural seed, or an image url with no bytes held) |
| `binding.factsHash` | SHA-256 of the printed event facts (title, venue, date, seat) and the kept facts, canonical JSON |
| `binding.compositionHash` | SHA-256 of edition, material, finish, size and personalization (type, colour, foil, hidden fields, note, guest name), canonical JSON |
| `binding.composition` | `{ edition, material, finish, size }` in the clear, so a person can read what was approved |
| `membershipRevision` | the account's revision at issue; a later change makes the approval stale |
| `notAuthorizes` | what it never grants (above) |
| `environment`, `mode` | `development / preview / live`; `fixture / sandbox / live` |
| `issuedAt`, `expiresAt` | ISO times. The lifetime is seven days |

Canonical JSON: keys sorted, no whitespace, `undefined` dropped. `content.json` holds the synthetic stub, size and bytes behind every fixture so a consumer can recompute the hashes itself.

Revocation and staleness are **not** in the token. They are the issuer's current answer.

## Verifying

`verifyApproval(token, key, expect, { now, state })`. A consumer MUST pass `expect = { tenant, project: { kind, id }, purpose, content }`, where `content` has the hashes the consumer computed itself from what it holds (`artHash` = SHA-256 of the bytes it is about to use, the rest from `contentHashes(stub, size)`). Never take a hash from the token to compare with the token.

**The content rule: print must hold and compare every applicable commitment.** The consumer supplies, and the verifier compares, every commitment that applies to the purpose:

| Purpose | Required in `content` | Optional |
| --- | --- | --- |
| `print.compose` | `designHash`, `artHash`, `factsHash` and `compositionHash`, all four | none |
| `artifact.download` | `artHash` | the other three, but each one supplied must match |

A required hash that is not supplied is `content_missing`. A supplied hash that is not 64 lower-case hex characters, or differs from the bound one, is `content_mismatch`. `content = {}` (or no `content`) never passes. One matching hash is not enough for `print.compose`: a consumer that only checks the art would print facts or a composition nobody approved.

**The clock rule.** `now` is the consumer's trusted clock, milliseconds since the epoch. It must be a finite number above zero (`Number.isFinite(now) && now > 0`). `NaN`, `Infinity`, `-1`, `0`, a string or anything else is `invalid_clock`: a verifier that cannot read the time cannot say the approval has not expired, so it refuses before judging anything. An `issuedAt` or `expiresAt` that does not parse is `unknown`. The server uses its own clock and applies the same guards.

Checks run in this order, and the first failure wins (`invalid_clock` first of all):

| Reason | Meaning |
| --- | --- |
| `invalid_clock` | checked first: `now` is not a finite number above zero. Nothing else is judged |
| `unknown` | not a token, malformed, wrong header, or (with `state.known === false`) the issuer has no such record, or `issuedAt` / `expiresAt` is not a date |
| `forged` | the HMAC does not match: wrong key, edited payload, the fixture key against a production verifier |
| `unsupported_version` | correctly signed, but a `schema` this verifier does not know |
| `wrong_scope` | tenant or project differs from the consumer's |
| `wrong_purpose` | purpose differs, or is not one of the two this version knows (any purchase purpose lands here) |
| `expired` | `expiresAt` has passed |
| `revoked` | `state.revoked`: the owner revoked it |
| `stale` | `state.current` differs from the bound hashes or version (the owner changed art, facts, type, chip, material, size, edition or selected version), or `state.membershipRevision` moved |
| `content_missing` | a hash this purpose requires (see the content rule) was not supplied, or `content` is empty |
| `content_mismatch` | a supplied hash is malformed (not 64 lower-case hex) or differs from the bound one (the bytes changed after approval) |

Without `state`, only signature, version, scope, purpose, expiry and content are checked. `revoked`, `stale` and `unknown` need the issuer. Ask it with `POST /api/approvals/verify` (`{ token, expect }`, no cookie and no Origin needed, rate limited): `200 { ok: true, approval }`, or `403 { ok: false, reason, error }`. A request whose `content` is empty, not an object, or holds a hash that is not 64 lower-case hex is `400` (never ok); a missing required hash is `403 content_missing`. Fail closed: if the issuer cannot be reached, do not use the approval.

An approval that is `stale` becomes valid again if every edit is undone, because the binding is the content, not a time. A re-approval after a change is always a new record; the old one stays, read as `stale`.

## Revocation keeps the bytes

Revocation ends authority. It never deletes stored art: the app keeps the file, and a consumer keeps whatever it already stored. `revoked-bytes-retained` shows it: the verdict is `revoked`, the retained bytes still hash to the bound `artHash`, and `mayUse` is `false`. Do not compose, export or download with them until a new approval exists.

## Fixtures

| File | Outcome |
| --- | --- |
| `valid-print-compose`, `valid-artifact-download` | ok (controls) |
| `unknown-malformed`, `unknown-no-record` | `unknown` |
| `forged`, `forged-edited-binding` | `forged` |
| `unsupported-version` | `unsupported_version` |
| `wrong-scope-tenant`, `wrong-scope-project` | `wrong_scope` |
| `wrong-purpose` | `wrong_purpose` |
| `not-a-purchase-authorization` | `wrong_purpose` (a valid approval presented as authority to buy) |
| `expired` | `expired` |
| `revoked`, `revoked-bytes-retained` | `revoked` |
| `stale-facts`, `stale-composition`, `stale-membership` | `stale` |
| `content-mismatch` | `content_mismatch` (the consumer holds different bytes than the ones bound) |
| `content-empty` | `content_missing` (print.compose, `expect.content = {}`) |
| `content-missing-design`, `content-missing-art`, `content-missing-facts`, `content-missing-composition` | `content_missing` (print.compose with that one hash left out) |
| `content-missing-art-download` | `content_missing` (artifact.download without `artHash`) |
| `content-art-only-download` | ok (artifact.download with `artHash` only: all that purpose requires) |
| `content-malformed-hash`, `content-uppercase-hash` | `content_mismatch` (a supplied hash is not 64 lower-case hex) |
| `clock-nan`, `clock-infinity`, `clock-negative`, `clock-string` | `invalid_clock` (the trusted clock is `NaN`, `Infinity`, `-1`, a string) |

Each fixture carries `token`, `verifyAt`, `held` (the bytes the consumer has), `expect` (the scope it names), `state` (the issuer's answer, where the case needs it) and `outcome`. The runner (`runFixture`) supplies what a print consumer would compute: `contentHashes(stub, size)` from `content.json` plus `hashBytes(held art)`, so every purpose's required hashes are present. A fixture with a `consumer` field changes that supply: `omit` (hash names left out), `override` (hash name to value), `empty` (supply nothing) or `clock` (a tag for a clock JSON cannot hold: `nan`, `infinity`, `negative`, `string`). The expired case is unchanged: an ordinary clock past `expiresAt` is still `expired`.

## Not supported

- A canonical shared-contracts `ApprovalReceipt` schema. This record is the app's own `ticketstub.approval/1`; mapping to the canonical receipt is open (shared-contracts #22, #23).
- Issuer, audience and consumer identity beyond the HMAC key: no per-consumer credentials, no audience claim, no key rotation or `kid` lookup, no asymmetric signatures. Any holder of a token can ask the verify port.
- A composed front/back preview id or hash. `compositionHash` covers the composition inputs, not rendered pixels.
- Purchase authorization, payment, asset-rights approval, order, quote or supplier handoff.
- Consumer adoption: nothing in print-production, creative-engine or the harness verifies these yet.
