# Order authorization fixtures (`ticketstub.order-authorization/1`)

> **FIXTURE ONLY. NEVER PRODUCTION.** `fixture-key.json` holds the HMAC key these authorizations are signed with, and a consumer key for the signed-request example. Both are public on purpose. Records made with them say `"mode": "fixture"`. Every token here names kid `fixture`. The server refuses any `ORDER_AUTH_SIGNING_KEYS` entry whose key contains `FIXTURE-ONLY` or whose kid starts with `fixture`, and any `ORDER_AUTH_CONSUMER_KEY` containing `FIXTURE-ONLY`, so a production verifier rejects every token here as `forged`, and the consumer port answers 503 rather than accept the fixture consumer key. Fixture success shows a consumer reads the format and the protocol. It does not show integration with the live issuer, it is not a consumer-conformance receipt, and no fixture is authority for a paid action.

Everything is synthetic and **by reference**: opaque ids, SHA-256 digests, a destination *reference* and its digest. There is no address, name, email, phone, payment detail or art in any file. Regenerate with `node fixtures/order-authorization/generate.mjs` (deterministic). Check with `node fixtures/order-authorization/verify.mjs`, which has no dependencies: copy `verifyOrderAuthorization` into a consumer. It also holds `ReferenceIssuer` (the claim protocol as an in-memory model) and `runScenario`, which `scripts/check-order-auth.mjs` reuses to drive the same scenarios against a real server.

An order authorization says: this signed-in owner confirmed **this exact action** (submit one order to one provider) for **this exact SKU, options, quote, maximum amount, destination reference, design and approval**, **once**, until `expiresAt` (fifteen minutes). It **references** a current `print.compose` artwork approval (`ticketstub.approval/1`) and its binding hashes. It is never inferred from one: an approval token is `unknown` here (`unknown-approval-token`), and the signed record says it never authorizes `payment`, `refund`, `other_orders`, `destination_change` or `asset_rights`.

## The token

`header.body.signature`, three base64url parts, HMAC-SHA256 over `header.body`. Header `{"alg":"HS256","typ":"ticketstub.order-authorization","kid":"<key id>"}`, where `kid` (1-64 of `[A-Za-z0-9._-]`, `fixture` here) names the signing key (an approval token has `typ` `ticketstub.approval`, a context token `ticketstub.context`: none verifies as another). Body `{"authorization": <record>}`.

| Field | Meaning |
| --- | --- |
| `schema` | `ticketstub.order-authorization/1` |
| `id` | `oau_...`, unique, never reused |
| `issuer`, `audience` | `ticketstub`; `fulfillment-connectors` (the one consumer this version addresses) |
| `tenant.id`, `project`, `actor` | the owning account; `{ kind: "stub", id }`; the signed-in account that confirmed |
| `action` | `fulfillment.submit`. The only action. Cancel, refund and reship are unsupported |
| `provider` | `sandbox` or `prodigi` |
| `actionId` | `act_...`: the logical action, a hash of tenant, project, action and `terms.orderRef`. Stable across renewals of the same order, so a renewal never opens a second dispatch. Maps to the connector's `actionId` |
| `command` | `{ name: "submit_order", hash }`: SHA-256 over canonical JSON of `{ action, provider, terms }` |
| `terms.orderRef` | the customer's opaque order reference |
| `terms.sku` | the confirmed supplier SKU, or `null` (no SKU is confirmed for any variant yet; never guessed) |
| `terms.options` | `{ variantId, material, finish, size, quantity }` |
| `terms.quote` | `{ id, amountMinor, currency }`: the quote the owner saw and the maximum exact amount they confirmed |
| `terms.destination` | `{ ref, digest }`: an opaque reference to the destination the connector holds, and its digest. Never an address |
| `terms.design` | `{ versionId, designHash, artHash, factsHash, compositionHash }`: the artifact hashes, copied from the approval |
| `terms.approvalId`, `approval` | the referenced approval (`purpose: print.compose`) |
| `terms.capabilityVersion` | the capability map the terms were priced under |
| `idempotencyKey` | the owner's key for **issuing** (a retry of the same request returns the same record). Not the consumer's claim key |
| `membershipRevision` | the account's revision at issue |
| `notAuthorizes`, `environment`, `mode`, `issuedAt`, `expiresAt` | as in the approval record |

Canonical JSON: keys sorted, no whitespace, `undefined` dropped. `content.json` holds the synthetic terms, the command hash and the action id.

Revocation, staleness and claims are **not** in the token. They are the issuer's current answer.

## Verifying

`verifyOrderAuthorization(token, keys, expect, { now, state, intent })`, where `keys` maps kid to HMAC key (`{ fixture: key }` here, or a function `kid => key | null`; look the kid up by own property only, and during an issuer rotation hold the previous kid's key until its tokens expire). A consumer MUST pass `expect = { tenant, project: { kind, id }, action, provider, terms }` with the **full terms it holds** (every key of `terms`), taken from its own quote, bundle and destination, never from the token. `intent` is `verify` (read only), `claim` or `revalidate` (then `expect.claimReference` too).

Checks run in this order and the first failure wins:

| Reason | Meaning |
| --- | --- |
| `invalid_clock` | checked first of all: `now` (the consumer's trusted clock, ms since the epoch) is not a finite number above zero (`NaN`, `Infinity`, `-1`, `0`, a string). A verifier that cannot read the time cannot say the authorization has not expired, so it refuses before judging anything |
| `unknown` | not a token, malformed, wrong header (including a missing or malformed `kid`) or audience, or (with `state.known === false`) the issuer has no such record. Includes an approval token |
| `forged` | no key for the token's `kid`, or the HMAC does not match: wrong key, a token keyed with the context or approval key, edited payload, the fixture key against a production verifier |
| `unsupported_version` | correctly signed, but a `schema` this verifier does not know |
| `wrong_scope` | tenant, project, action or provider differs from the consumer's (cross-tenant, cross-project, cancel, another provider) |
| `changed_terms` | any term the consumer holds differs from the bound one (`fields` lists dotted names, never values): SKU, options, quote id, amount, currency, destination, design hashes, approval, order, capability version. A quote, budget hold or approval never substitutes: renewed authorization is required |
| `revoked` | `state.revoked`: the owner revoked it (also after a claim) |
| `expired` | `expiresAt` has passed (checked again at dispatch) |
| `stale_approval` | `state.approval` is not `active`: the referenced approval was revoked, expired, went stale (the art or a printed fact changed) or is missing |
| `stale` | `state.superseded` (renewed for the same order), the account's `membershipRevision` moved, or the capability version moved |
| `not_orderable` | `state.orderable === false`: the variant or provider no longer passes the order gate |
| `already_claimed` | a claim exists and this is `verify`, or a `claim` under a different key |
| `not_claimed` | `revalidate` with no committed claim, or a claim reference that is not the committed one |
| `idempotency_conflict` | the claim key is already bound to a different authorization (issuer-side; not produced by the pure function) |

## The protocol

HTTP, signed consumer requests (stopgap, see the doc): `POST /api/order-authorizations/verify | claim | revalidate | claims/lookup` with headers `x-ticketstub-consumer-timestamp` and `x-ticketstub-consumer-signature`; `fixture-key.json` has a worked signature example. Responses mirror the connector's `AuthorizationClaimResult`: `{ ok: true, status: "claimed", replayed, authorizationId, actionId, claimReference, claimedAt }` or `{ ok: false, status: "rejected", reason, fields? }`.

1. **verify**: read only. ok leaves it claimable.
2. **claim** `{ token, idempotencyKey, expect }`: atomic and single use. First claim wins. The same key replays the same claim (`replayed: true`). A different key after a claim is `already_claimed`. The same key on another authorization is `idempotency_conflict`.
3. **lookup** `{ tenant, project, idempotencyKey, authorizationId? }`: after a lost response or restart. `found: true` returns the committed claim and `authority` (what a revalidate says now). `found: false` is definitive: a claim commits in one write lock, so nothing is in flight; retry the claim with the same key. A claim under another key shows only as `authorizationClaimed: true`.
4. **revalidate** `{ token, expect: { ..., claimReference } }`: immediately before the provider call. Re-checks everything now. A claim is not a promise that the authority holds at dispatch.

If a claim replay arrives after the authority lapsed, the answer is the lapse (`revoked`, `expired`, `stale_approval`...), not the claim: a consumer must not dispatch on a replay alone. The claim fact stays visible through lookup.

## Fixtures

Token fixtures (`<name>.json`: `token`, `intent`, `verifyAt`, `expect`, `state`, `outcome`):

| Case | Outcome |
| --- | --- |
| `valid-submit`, `valid-claim`, `valid-claim-replay-same-key`, `valid-revalidate` | ok (controls) |
| `unknown-malformed`, `unknown-no-record`, `unknown-approval-token`, `unknown-wrong-audience` | `unknown` |
| `forged`, `forged-edited-terms` | `forged` |
| `forged-unknown-kid` | `forged` (the right key bytes under a kid the verifier holds no key for) |
| `forged-context-key`, `forged-approval-key` | `forged` (key confusion: signed with the context or approval fixture key) |
| `unknown-no-kid` | `unknown` (a header with no `kid`, the pre-K4 format) |
| `unsupported-version` | `unsupported_version` |
| `wrong-scope-tenant`, `-project`, `-provider`, `-action` | `wrong_scope` |
| `changed-terms-amount`, `-currency`, `-quote-id`, `-quantity`, `-sku`, `-finish`, `-destination`, `-destination-digest`, `-art`, `-design-version`, `-approval`, `-order`, `-capability-version` | `changed_terms` |
| `expired` | `expired` |
| `clock-nan`, `clock-infinity`, `clock-negative`, `clock-string` | `invalid_clock` (the trusted clock is `NaN`, `Infinity`, `-1`, a string; named by `consumer.clock`) |
| `revoked` | `revoked` |
| `stale-approval-revoked`, `-expired`, `-changed`, `-missing` | `stale_approval` |
| `stale-superseded`, `stale-membership`, `stale-capability-version` | `stale` |
| `not-orderable` | `not_orderable` |
| `already-claimed-verify`, `already-claimed-other-key` | `already_claimed` |
| `revalidate-not-claimed`, `revalidate-wrong-claim-reference` | `not_claimed` |
| `revalidate-revoked-after-claim`, `-expired-after-claim`, `-approval-revoked-after-claim`, `-changed-terms-after-claim`, `-membership-moved-after-claim` | `revoked`, `expired`, `stale_approval`, `changed_terms`, `stale` |

Scenarios (`scenarios/<name>.json`: ordered steps over labelled authorizations and keys; `drivers` says where each runs):

`first-claim-wins-and-replays`, `replay-under-distinct-key`, `concurrent-claim-distinct-keys` (eight keys race one authorization: exactly one wins), `concurrent-claim-same-key` (one commits, the rest replay), `claim-committed-response-lost`, `unknown-claim-lookup-reconciliation`, `same-key-different-authorization`, `revoke-after-claim-before-dispatch`, `approval-revoked-after-claim`, `art-changed-after-claim`, `changed-terms-after-claim`, `revalidate-before-claim`, `claim-after-revoke`, `renewal-supersedes-older`, `claimed-order-cannot-be-renewed` run on the reference model **and** a live server. `expires-after-claim-before-dispatch` and `expires-before-claim` run on the reference model only: a live server cannot be moved forward in time here (the unit and token fixtures cover expiry, and the live suite covers it with a directly inserted expired row).

## Supported and unsupported

Supported by the standalone fixtures and the `order-auth` product suite: valid; wrong scope; changed terms; expired and revoked; replay under distinct keys; concurrent claim; claim committed with the response lost; unknown-claim lookup and reconciliation; dispatch-time revalidation after revoke, expiry, approval revoked, art changed and terms changed. Use the [application toolchain](../../README.md#quickstart) and run from the repository root after installing dependencies:

```sh
npm run build
npm run verify:product -- --suite order-auth --mode fixture --evidence-dir out/evidence
```

The product suite starts an isolated production-build fixture server. The dependency-free `node fixtures/order-authorization/verify.mjs` command checks the local token fixtures and reference model without starting that server.

**Unsupported, stated plainly:**

- **No real provider, payment or address.** `provider: prodigi` can never be issued today: no variant carries a confirmed SKU, and the gate refuses it. `sandbox` is the only issuable provider, and only outside live mode.
- **Application-local `OrderAuthorization` boundary.** [shared-contracts #26](https://github.com/Jevelopers-neatHack-2026/shared-contracts/issues/26) owns the canonical contract. Its unmerged candidate and any scoped private-development approval do not establish adoption of this app's `ticketstub.order-authorization/1` record or release acceptance. These fixtures check the [application issuer](../../src/server/order-authorization.ts) and its reference verifier; accepted cross-repository mapping remains separate.
- **No cancel, refund, reship or change-of-destination action.** Only `fulfillment.submit`.
- **No consumer adoption.** fulfillment-connectors has not run against this port. Its in-memory fixtures are not this protocol, and these fixtures are not its conformance receipt.
- **Consumer authentication is a stopgap**: one shared HMAC key, one consumer id, no audience separation per consumer, no rotation, no mTLS. A captured signed request can be replayed for five minutes (claims are idempotent per key; verify, lookup and revalidate are read only).
- **The amount is not re-priced by the studio.** It is the maximum the owner confirmed for a quote id; the quote itself is a sandbox fixture, and the real `FulfillmentQuote` (shared-contracts #25) is not wired.
- **No release of a claim.** A claim is never released. If the connector learns for certain that nothing was dispatched, a new order needs a new `orderRef`; there is no "claim failed, try again" state.
- **No push.** Nothing tells a consumer about a revocation; it learns at revalidate.
- **Single host.** Atomicity is one SQLite write lock plus uniqueness constraints; a different database needs the same constraints.
