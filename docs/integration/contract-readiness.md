# Contract and consumer readiness

This is the application reporting convention for [GT-10A.4](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/8):
“Define readiness separately as schema-ready, fixture-ready, implementation-ready and integrated-evidence-ready.
Fixture-backed UI can start before upstream completion; release claims require actual consumer conformance.”

Record these facts **per operation, consumer surface, exact version and execution mode**. They are independent
evidence categories, not an automatic promotion sequence or a whole-repository completion flag. A reviewed schema
can precede an implementation. The UI can use clearly labelled proposal fixtures while the corresponding canonical
contract or producer implementation is pending; that work must retain the proposal's limits.

| Readiness | What the evidence establishes | What it does not establish |
| --- | --- | --- |
| **schema-ready** | The affected producer/consumer roles have recorded the selected contract/version, field meanings, identity and authority derivation, unknown/optional values, compatibility policy and exact generated types/runtime-validator artifact. Outstanding disagreements remain named. | Package availability, similar local types or an upstream source merge do not elect a Product pin or prove actual caller conformance. |
| **fixture-ready** | Named credential-free fixture bytes and digests, expected positive/negative outcomes and their schema/proposal version are available for the selected boundary. Actual app fixture checks record supported versions, malformed/unknown values, scope denial, stale references and recovery outcomes. Record separately which producer and consumer checks ran. | Synthetic fixtures do not prove a provider run, accepted producer implementation, shared identity semantics or a composed journey. Unaccepted proposal fixtures remain explicitly proposed. |
| **implementation-ready** | A specific implementation revision/package and its owned operations exist, with meaningful producer checks and usable app adapter entry points for the selected scope. Required configuration, migrations, grants, runtime/peer versions and unsupported operations are explicit. | Importing or vendoring source, a producer unit pass, a declaration file or a successful fixture replay does not prove the app called that implementation correctly. |
| **integrated-evidence-ready** | The real app caller/adapters and selected pinned implementations have executed the agreed boundary assertions. Retained results join the exact app/component/schema/fixture pins, input identities, mode, commands, positive/negative/recovery outcomes, cleanup and accountable consumer review. Missing required cases and prior failures stay visible. | One passing boundary does not certify the whole journey, a different version/mode, paid provider authority, physical fulfillment or master acceptance. |

Use `pending` when the required fact is unavailable and identify the owner role, precise upstream issue/PR and next
input. `Not applicable` needs the documented product/admin rationale required by GT-10A.1; lack of an implementation
does not make a needed integration inapplicable. A required skip is not a pass. Unknown cost, finality and supplier
status remain unknown. Correlation references identify work and never grant permission.

## Current supplied evidence and limits

**Source snapshot:** app main [`5e991cd9571cf740e72dceeb446777e2bf730bdd`](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/tree/5e991cd9571cf740e72dceeb446777e2bf730bdd),
reviewed 2026-10-13. This table classifies existing inputs; it neither changes a pin nor records acceptance.
The current manifest files are source declarations whose upstream commits must still be joined to actual executed
consumer receipts; the [assembly snapshot](assembly-evidence.md) explains that distinction.

| Boundary | Existing source/fixture evidence | Remaining consumer or acceptance input |
| --- | --- | --- |
| Shared contracts | [The current owner update](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/8#issuecomment-6132762476) records merged shared-contracts 0.10.2 source. This removes the former unmerged-source prerequisite. | Product package election, the existing private caller writer's terminal custody/handoff, affected parser repair and actual caller compatibility remain pending. The [private caller lease](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/8#issuecomment-6124877484) remains with its owner; no SDK bytes or new adoption are supplied here. |
| Harness | The app vendors [`fd4eaf2a54cb68740c960d5e061d4c4b11e79251`](https://github.com/Jevelopers-neatHack-2026/agent-harness/tree/fd4eaf2a54cb68740c960d5e061d4c4b11e79251), recorded in `src/server/vendor/agent-harness/MANIFEST.json`. The scoped Creative host evidence below includes that pin. | This is not complete `ProjectRequest` create/status/cancel/correct/resume consumer conformance or the correlated GT-10B journey. Selected canonical caller and workflow-owner inputs remain required. |
| Event intelligence | The [research adapter record](event-intelligence.md) identifies the saved Ticketmaster fixture, local mapper and proposal-shaped output. These support labelled app fixture work. | A locally assembled `EventIntelligencePackage` is not a canonical accepted package call. The selected runtime validator, trusted identity joins, real event-intelligence caller and producer/consumer agreement remain required. |
| Creative | The app vendors [`e4fa66488f31577f516b27238e945a1fb3c2143f`](https://github.com/Jevelopers-neatHack-2026/creative-engine/tree/e4fa66488f31577f516b27238e945a1fb3c2143f) and has the [actual host adapter](creative-engine.md). The retained [scoped consumer receipt](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/19#issuecomment-6132762845) names its exact prior candidate, real PostgreSQL checks and synthetic/intercepted transport. | Those checks establish the described blocked/recovery boundary. `generate` and `edit` remain blocked by `creative_finance_lifecycle_unavailable`. The separate studio `/api/art` path is not a completed canonical Creative migration; paid lifecycle and selected caller acceptance remain open. |
| Print production | App approval, screen/export comparison and download fixtures exercise the application surfaces. There is no print-production source pin in this snapshot's vendored manifest set. | Those results do not prove a canonical `ProductionBundle`, deterministic print render, preflight or final-use receipt. Print/contract owners supply the matching accepted artifacts and bindings; [the physical mapping](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/23) still governs enablement. |
| Fulfillment | The app vendors [`64b52c4f39d4946a4c47086d4a5df1ef3860dad5`](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/tree/64b52c4f39d4946a4c47086d4a5df1ef3860dad5) with app-owned durable callback storage and scheduling. [The callback runbook](../operations/prodigi-callbacks-runbook.md) defines its disabled-by-default setup and owned scope. | Callback/storage readiness does not enable supplier requests or establish quote/order authorization/normalized-status conformance for the whole journey. Accepted SKU/spec/template mapping, current supplier permission and exact handoff evidence remain separate. |
| Cost/Finance | The app vendors [`a08760e9ea65bda1e116867ac00b3e03d737bb7e`](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/tree/a08760e9ea65bda1e116867ac00b3e03d737bb7e). The [Creative host record](creative-engine.md) documents actual pinned PostgreSQL blocked/replay recovery and the Finance-first admission barrier. | Producer/runtime presence and local blocked recovery do not establish the accepted full paid lifecycle, final settlement/release or reporting consumer ACK. A `FinancialSummary`/budget read requires its documented product/admin need and real scoped read-side adapter; no ledger authority is created here. |

The linked Creative/Finance receipt is **historical exact-candidate evidence**, not a relabelled test of every later
main commit. It preserves its default SQL skip separately from the mandatory actual PostgreSQL result, and names
the later browser-identity failure on that later candidate. A source merge or successful unrelated check does not
erase those records or turn a scoped blocked/recovery result into positive paid-journey acceptance.

## Recording a boundary handoff

For each applicable operation, record the producer and consumer owner roles; source/package/schema versions and
digests; the actual app entry point; fixture IDs/bytes and expected negative outcomes; commands, revisions, mode and
results; retained failures/skips; required cleanup; explicit accept/reject/defer disposition; and the next missing
input. Keep proposed schema, local fixture, producer implementation and real app-consumer evidence in separate
fields. A current generic “green” label cannot replace these facts.

`verify:product` executes application fixture checks. The [canonical release-evidence checker](release-verifier.md)
validates an existing composed manifest/history and returns consistency with `acceptance: not_recorded`; it does
not execute the missing journey or provide an owner ACK. GT-10B remains responsible for the correlated app assembly.
Integration-evals retains canonical master acceptance. These definitions and this snapshot do not close #8, #19,
the release gate or the epic, or authorize providers, publication or a shared-contracts repin.
