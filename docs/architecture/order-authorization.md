# Order authorization (`ticketstub.order-authorization/1`, GT-07 / #16)

A signed-in owner's explicit confirmation of one exact order, issued by the server, which the fulfillment consumer (fulfillment-connectors) verifies, claims once and revalidates at dispatch. Format, reasons, fixtures and the unsupported list are in `fixtures/order-authorization/README.md`. This page is the model and what is missing. It is an interface and fixtures: no provider is called, no payment is taken, no address is held.

## What it is, and is not

It binds: tenant, project, actor, the action (`fulfillment.submit` only), provider (`sandbox` or `prodigi`), SKU (null until one is confirmed), options (variant, material, finish, size, quantity), the quote id and the **maximum exact amount and currency**, a destination **reference** and its digest, the design version and the four artifact hashes, the referenced approval id, the capability version, the order reference, expiry (15 minutes) and the owner's issue idempotency key. Status is computed by the issuer, never stored: `active`, `claimed`, `revoked`, `expired`, `stale`.

It is not an artwork approval, a payment, or a promise a provider accepts anything. It **references** a current `print.compose` approval (`ticketstub.approval/1`) and is stale the moment that approval is revoked, expires or goes stale. It is never inferred from an approval: an approval token is `unknown` here, `notAuthorizes` in the approval says so, and no order, checkout, commerce or approval code reads an authorization (checked by `scripts/check-order-auth.mjs`).

## Flow

```
owner (signed in)                      server                                       consumer (fulfillment)
  POST /api/order-authorizations ───►  same-origin, rate limit, confirm: true
  { stubId, approvalId,                ctx = getRequestContext(stub:<id>)
    expectedVersionId, orderRef,       requireCapability("order.authorize")         404 if not theirs, 401 guest
    quote, destination{ref,digest},    BEGIN IMMEDIATE
    idempotencyKey }                     same key + same request -> the stored one; same key, other request -> 409
                                         stub from the owner's wall (never the body); expectedVersionId must be selected
                                         approval row must be this stub's, print.compose, and active NOW -> else 409 approval_invalid
                                         variant gate (authorizationGate) -> else 422 variant_not_orderable
                                         quote id must be the quote for this exact choice; order not already claimed
                                         INSERT order_authorizations (append-only)
                                       COMMIT; sign token (HMAC); event order_authorized
  ◄── { authorization, status, token }
                                                                                    holds token + its own terms
                                       ◄── POST .../verify      read only
                                       ◄── POST .../claim       { token, idempotencyKey, expect }  atomic, single use
                                       ◄── POST .../claims/lookup  after a lost response or restart
                                       ◄── POST .../revalidate  immediately before the provider call
  POST .../revoke ─────────────────►   INSERT revocation row (also after a claim); event authorization_revoked
```

## Claim protocol

One SQLite write lock (`BEGIN IMMEDIATE`) reads the authorization, its approval, the stub, the account and any claim, decides, and inserts the claim. `UNIQUE` on the authorization, on the logical action and on `(consumer, idem_key)` backs it across processes.

- First claim wins. Same key again: the same claim (`replayed: true`) while the authority holds. A different key after a claim: `already_claimed` (409). The same key on another authorization: `idempotency_conflict` (409).
- Claim committed, response lost: retry with the same key returns the committed claim; `claims/lookup` answers `found` with the claim and the authority a revalidate would give now. `found: false` is definitive (a claim commits in one transaction, nothing is in flight) and identical to a key that is another tenant's.
- A replay after the authority lapsed returns the lapse, not the claim: a consumer must not dispatch on a replay alone.
- `actionId` (tenant, project, action, `orderRef`) is stable across renewals. A renewal for the same `orderRef` supersedes the older authorization (it reads `stale`); once an order is claimed no renewal can be issued. A claim is never released.
- Dispatch time: `revalidate` re-checks scope and terms, revoked, expired, the approval current now, membership, capability version, the order gate, and that the claim reference is the committed one.

Reasons: `invalid_clock unknown forged unsupported_version wrong_scope changed_terms revoked expired stale_approval stale not_orderable already_claimed not_claimed idempotency_conflict`. Rejections are `{ ok:false, status:"rejected", reason, fields? }` with the one error envelope `authorization_invalid` (403, or 409 for the two claim conflicts); `fields` names changed terms by path, never values.

## Token signing keys (decision 0003 K4)

Order-authorization tokens sign with **their own versioned key set, `ORDER_AUTH_SIGNING_KEYS`**, never `CONTEXT_SECRET` and never the approval keys ([integration-evals decision 0003](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/decisions/0003-owner-delegated-decisions-2026-10-12.md), row K4). The header names the key: `{"alg":"HS256","typ":"ticketstub.order-authorization","kid":"order-auth-g1"}`. The active key signs; a retired key keeps verifying for the 15-minute token lifetime plus 5 minutes, so a rotation never fails tokens in flight, provided `retiredAt` is the restart time and the retired entry stays 20 minutes after it (see identity.md for why). A retired key refuses a token that claims an `issuedAt` after its `retiredAt` + 5 minutes. That catches accidental late signing only: whoever holds a leaked key can backdate `issuedAt`, so delete a compromised entry at once. An unknown `kid` is `forged`, a missing one `unknown`. In live mode without a usable key set, issuing and listing answer 503 `signing_unavailable` and every consumer route answers `forged`; outside live mode an unset set falls back to a per-process random key (kid `sandbox`, records say `mode: "sandbox"`). An invalid set fails closed in every mode, and so does a set that reuses `CONTEXT_SECRET`, `ORDER_AUTH_CONSUMER_KEY` or an `APPROVAL_SIGNING_KEYS` entry, whether as the same string or as its base64url encoding. Format, rotation and failure modes: [identity.md, Signing keys](identity.md#signing-keys-decision-0003-k4).

`ORDER_AUTH_CONSUMER_KEY` is a different thing: it signs consumer **requests** only (below), never tokens.

## Consumer authentication (a stopgap)

Consumer routes carry no cookie and no Origin. Each request is signed: `x-ticketstub-consumer-timestamp` and `x-ticketstub-consumer-signature` = HMAC-SHA256 hex over `timestamp \n METHOD \n path \n sha256(body)` with `ORDER_AUTH_CONSUMER_KEY` (32+ characters, not `CONTEXT_SECRET` as the same string or its base64url encoding, and not a token signing key), within a five minute window. Unset key: 503 `consumer_unavailable` in **every** mode. A key containing `FIXTURE-ONLY` is treated as unset, and a request signed with the fixture key is 401. The token alone is not enough to claim: the signature is a second credential the owner never holds.

## Gate

`authorizationGate` (capabilities.ts) starts from `orderGate` and adds provider rules: `sandbox` only outside live mode; a real provider needs a live runtime, status `orderable`, and a confirmed SKU from that supplier. No variant has a SKU, so **nothing can be issued in live mode and `prodigi` can never be issued today**. In demo mode a preview variant yields a `sandbox` authorization (as the existing order route does for a sandbox order); an unavailable variant never does.

## Storage, events, capability

Migration adds `order_authorizations`, `order_authorization_revocations`, `order_authorization_claims`, append-only by trigger (UPDATE refused; DELETE refused while the account exists; rows leave with the account). New capability `order.authorize` (stub owner, signed-in account only). Events: `order_authorized`, `authorization_claimed`, `authorization_revoked`, `authorization_refused` (provider, a 16-hex ref, a reason code, an op, flags: never ids, tokens, hashes or references).

## Limitations (read these)

- **Not the canonical `OrderAuthorization`.** shared-contracts #26 has no schema or pin yet; no mapping is accepted. The claim response follows fulfillment-connectors' `AuthorizationClaimResult` shape and `actionId`/`claimReference` names as read from its types, which is not an agreed protocol.
- **Limited simulated consumer coverage; no app-server conformance.** The `fulfillment-connectors` main source contains a fixture-tested simulated protocol consumer that uses a fake issuer/HTTP port. It has not run against this app server. The app has no runtime import of that package; there is no accepted shared-contracts #26 mapping or pin, cross-repository conformance, runtime adoption, or integration-evals acceptance.
- **No real quote.** The amount is the maximum the owner confirmed for a sandbox quote id; the studio does not re-price it and the real `FulfillmentQuote` (shared-contracts #25) is not wired. The destination is a reference the studio does not hold or validate against anything.
- **No payment or budget.** Nothing here captures money or reserves budget; cost-intelligence is separate.
- **Stopgap consumer auth**: one shared key, one consumer id, no rotation, signed requests replayable for five minutes (claims are idempotent; the rest are read only). The unset-key 503 is confirmed by source check only, because the suite's server has the key.
- **Live gate not exercised end to end**: the live-mode refusals are unit-tested on `authorizationGate`; no server was run in live mode.
- **Expiry on a live server** is exercised with a directly inserted row (the server cannot be moved forward in time); everything else runs through the API.
- **Only `fulfillment.submit`.** No cancel, refund, reship, address change, release of a claim, or push of a revocation.
- **Single host SQLite**, as approvals. A server that is down at dispatch means the consumer must not send.
- **No UI.** Issuing is API only; no confirmation screen exists yet.
- **Membership staleness** is covered by a suite step (sign out everywhere) and fixtures; it also trips the approval's own staleness, so the reported reason there is `stale_approval` or `stale`.
