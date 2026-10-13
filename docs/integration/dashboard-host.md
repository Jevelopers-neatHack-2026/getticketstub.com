# App-owned Dashboard host boundary

Refs [GT-08 #9](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/9),
[setup #27](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/27),
[TD-07 #11](https://github.com/Jevelopers-neatHack-2026/team-dashboard/issues/11).
This slice establishes app-owned current authority and display boundaries. It does
not complete actual Dashboard package adoption or Finance consumer acceptance.

## Current source and ownership

The producer inspected on 2026-10-13 is Team Dashboard
[`eeefeb3497f3ce43fb9cc456ca67e5bbbe3b1a0f`](https://github.com/Jevelopers-neatHack-2026/team-dashboard/tree/eeefeb3497f3ce43fb9cc456ca67e5bbbe3b1a0f),
tree `75df49586fe6fb18acf6c74f99861247c7d880a6`. Its
[trusted-host seam](https://github.com/Jevelopers-neatHack-2026/team-dashboard/blob/eeefeb3497f3ce43fb9cc456ca67e5bbbe3b1a0f/docs/integration/TD-07-trusted-host.md)
requires a server-held credential and in-process live verification. Its package
declares Node `>=24.15.0 <25`; this app declares Node `>=22.23.3 <23`.
Those support declarations remain unchanged. A compatible owner-accepted artifact
or app runtime decision is needed before installing and mounting the package.
No Node 22 experiment is called a supported production adoption.

`src/app/admin/contract.ts` is the app's display schema, now
`ticketstub.admin-mount/2`. It is not the producer's `HostAccess`,
`HostSessionVerifier`, `RouteProvider`, or a new Finance interface. The existing
fixture component remains an explicitly unavailable shell. No vendor dependency,
engine override or provider credential is introduced.

## Request and read boundaries

`src/server/dashboard-host.ts` derives authority from the request's existing
httpOnly session and current app storage. Every `/admin` page and
`GET /api/admin/dashboard` retains `requireStaff`; nonstaff, guests and anonymous
callers receive the same 404 as an unknown route. The selected `?project=kind:id`
is only a question. It cannot set tenant, actor, membership, capabilities or modes.
Duplicate, empty or malformed selectors deny. Foreign and missing projects have
the same public answer. Staff without a project use platform scope. The internal
nonstaff no-project state exists for future composition and does not open `/admin`.

Each request issues a fresh `/2` and invokes `verifyContextTokenLive` in process
with the fixed audience `ticketstub.finance`. It checks the current session,
membership revision, project ownership and modes. Remaining lifetime must be
positive and at most 360,000 ms. Issuer configuration failures refuse access.
The credential lives only in a module-private WeakMap keyed by a frozen handle;
copying or serializing a handle does not copy authority. The client receives a
fixed display projection with no token, session reference or email.

`src/server/finance-scope.ts` extracts the existing fixture mapping unchanged for
valid contexts: development/preview/live to development/test/production;
none/sandbox/paid_test/live to simulated/sandbox/live/live. Evidence travels beside
the exact five-field scope. Kind prefixes remain intact; identifiers over 128
characters refuse rather than truncate. Malformed input and prototype-property
enum names now refuse explicitly. Mapping alone authenticates nothing. The
reference fixture re-exports this one production mapping.

The app-owned `guardDashboardRead` requires explicit `finance.read`, supplies only
the frozen server-derived scope, and repeats live verification after the awaited
read. Revoked, stale, expired, aborted, unknown and foreign handles cannot disclose
the returned value. Read/storage exceptions return fixed unavailable state without
raw error text. Callers still need an accepted minimal-field projection; the guard
is not a financial report schema or a durable cross-database disclosure fence.
It is not the Dashboard package's bounded reader and does not replace that
package's timeout/abort policy. The residual window after the final app check is
not claimed atomic with a separate Finance database or durable custody protocol.

The actual production response currently contains only the display projection
and an explicit Finance `restricted` or `unavailable` state. Missing Finance
configuration never becomes empty/zero reports, a synthetic fallback or an
enabled export/command. Responses are `no-store`. No production route accepts an
injected reader, authority token or synthetic configuration. The generic server
read fence's positive test reader is explicitly constructed test data.

## Remaining owner inputs

| Input | Accountable owner and required action |
| --- | --- |
| Supported Dashboard mount | Product/Dashboard owners provide an accepted compatible package/runtime and pin; implement its actual host interface without changing the foreign contract. |
| Finance data port | Finance/Product owners supply and accept the actual reader, finite field/purpose policy, actor/session/grant mapping, scoped data source and post-await disclosure/custody fence. |
| Consumer evidence | Run the accepted producer's actual currentness, mounted state, keyboard/accessibility, abort/timeout and private-field controls on the final assembly; return exact evidence for ACK. |
| Live enablement | Deployment owners provide actual allowed configuration and grants; source merge alone does not grant Finance, providers, production publication or paid execution. |

The inspected installed Finance archive is pinned to
`a08760e9ea65bda1e116867ac00b3e03d737bb7e` and exposes `querySummary`, not a
`queryV2` alias. The producer's integrated v2 port remains unaccepted; this host
does not invent that alias. The later
[Finance handoff](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/3#issuecomment-6132284704)
lists the actual issuer registry, grant, source, projection and custody inputs.
Its source/test results do not supply this app's missing consumer inputs.

## Scoped checks

`node --test tests/dashboard-host.test.mjs tests/finance-context.test.mjs` exercises
the actual app issuer/live verifier and local SQLite with synthetic identities,
plus shared mapping/parity controls. It does not import the Dashboard package or
claim a Finance consumer pass. `verify:product --suite foundation` retains real
HTTP staff/nonstaff, reload, deep-link and error-boundary checks, and checks the
rendered `/2` projection for absence of a signed credential. Required build, types,
lint and affected access/finance-context/message suites remain current-candidate
qualification gates. Actual package mount, AT and live provider acceptance remain
separate outcomes.
