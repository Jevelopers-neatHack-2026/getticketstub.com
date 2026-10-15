# Canonical release-evidence consistency gate

`npm run verify:release` fills the manifest-checker part of [GT-01.4](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/7).
It reads an existing app-owned composed **Assembly1.0** and its retained canonical run directory. It checks that the
manifest, actual clean component checkouts, canonical fixture/selection bytes, every retained run and every evidence
artifact agree. Missing inputs and required failures, skips or incomplete cleanup exit nonzero.

This command does not execute a product journey. A successful receipt says **`release_evidence_consistent`** and
**`acceptance: "not_recorded"`**. Accountable app/producer review and integration-evals master acceptance are separate.
It makes no provider request, invokes no manifest `command` or `cleanup_command`, writes no tracker and deploys nothing.

## Input contract

Run from the exact clean app checkout named `getticketstub.com` within a common component workspace:

```sh
npm run verify:release -- \
  --manifest /path/to/assembly.json \
  --evidence-dir /path/to/retained-reports/original-run-id \
  --workspace /path/to/components \
  --python /path/to/release-validator/bin/python
```

The `--python` option is optional when the `python3` on PATH is the prepared Python3.13+ runtime. The canonical
manifest's `runtime` must equal that interpreter's actual `sys.version`; a different runtime fails. The manifest
and evidence must already exist. Paths are passed as argument arrays, without shell expansion. Unknown arguments,
subsets, dirty overrides, missing values and unsupported schema versions are rejected.

| Input | Required evidence |
| --- | --- |
| `--manifest` | The canonical Assembly1.0 record, `owner: getticketstub.com`, `kind: composed`, full selection, exact component/contract/configuration/catalog pins. |
| `--workspace` | Actual clean repositories at the manifest's revisions, trees and lockfile digests. The app is this command's own checkout; the evaluator is the exact reviewed source below. No inventory-derived or moving-ref pin substitutes. |
| `--evidence-dir` | A directory named for its saved run, containing matching `run.json` and `history.json`, accessible hash-matched evidence files, retained ancestors and any reserved successors. The canonical history loader follows successors and rejects omissions, divergence and incomplete writes. |
| Validator runtime | Python3.13+ with the evaluator's frozen `uv.lock` dependencies. Import-affecting environment overrides are not inherited. |

The current canonical suite contains 42 required cases. The wrapper uses the pinned suite and independent selection
registry, not a `suite.json` supplied beside an archive. Every retained run must cover the full canonical selection,
use owner-execution rather than recorded-evaluation replay, match this manifest/source/runtime/configuration, and
record a passing result, exit0 and confirmed cleanup for every required case. A later pass does not clear an earlier
failure. Required quarantine or skip blocks the gate. Recorded, mock, sandbox and live modes remain explicitly named;
the gate never upgrades one into another.

## Exact canonical source and setup

The interface authority remains [integration-evals](https://github.com/Jevelopers-neatHack-2026/integration-evals/tree/13bde39399a09d4a14cc97d72cd769b51da83e00),
not a second application schema library. The reviewed pin in `scripts/lib/release-evaluator-pin.json` records:

| Identity | Pin |
| --- | --- |
| Evaluator revision | `13bde39399a09d4a14cc97d72cd769b51da83e00` |
| Evaluator tree | `75b427dea98677445bf2c8e18beef87c403eb92a` |
| Assembly1.0 schema blob | `550b16acb281692ee2d6d2ba1b6e4dfa7c92d522` |
| OwnerResponse schema blob | `fe13602bf86e33f94256c1efeb702e0b126f2a12` |
| `uv.lock` SHA-256 | `03bb0e809c8ec40c4682f0214cf77af9750f4920cb91c19cbe86cd03fa5488ff` |

Use an isolated virtual environment outside all source checkouts. From the pinned evaluator checkout:

```sh
UV_PROJECT_ENVIRONMENT=/path/to/release-validator \
PYTHONDONTWRITEBYTECODE=1 \
uv sync --frozen --no-dev --no-install-project --python 3.13.16
```

The wrapper verifies the evaluator's revision/tree/lock and every imported tracked source blob before importing its
schemas and validators. Dirty trees, skip-worktree/assume-unchanged entries and ignored import inputs such as stale
bytecode are rejected. Required installed parser dependencies must match the frozen lock. A canonical update needs
a reviewed pin change and new compatibility evidence; do not silently use the latest evaluator.

Use isolated checkouts whose source and Git configuration remain fixed for this inspection. Before any working-tree
status read, the wrapper rejects every effective `filter.*` configuration key, including keys inherited through
`include`, `includeIf` and worktree configuration. Git can execute clean filters while comparing otherwise unchanged
files; the gate reads key names only and never prints values. Submodules are unsupported: a gitlink in either HEAD
or the index fails before status can recurse into a separately configured repository. All components receive this
preflight before the canonical validator performs its own status checks, and the wrapper repeats it during final
source validation. Dirty-state checks remain active. These checks do not protect against a concurrent hostile process
replacing configuration or source during validation; use owned, fixed checkouts rather than treating the gate as an
operating-system sandbox. See Git's [configuration](https://git-scm.com/docs/git-config) and
[recursive status](https://git-scm.com/docs/git-status) documentation.

## Results and limits

Exit0 emits the app/evaluator revisions and trees, manifest/history digests, case/run/evidence counts and observed
modes. Exit2 emits a fixed code and `acceptance: "not_recorded"`; it does not echo input records, commands, filesystem
paths, credentials or canonical exception text. The validator process is bounded to60seconds. Missing Python,
dependencies, manifest, composed records, stale pins and malformed evidence remain failures.

Hashes demonstrate byte consistency. They are unkeyed and do not authenticate a producer, witness an execution or
supply an owner ACK. Constructed mock records can be internally consistent; that fact cannot prove a product journey.
Retain the actual command/results, original failed runs and accountable review with the source pins. Publication,
provider grants and the deployment-completion instructions remain independent applicable requirements.

The existing [assembly snapshot tool](assembly-evidence.md) remains unchanged. Its planning inventory, vendored
source declarations, empty `executed` list and `not_accepted` marker are useful preparation inputs; that format is
deliberately rejected as a canonical release manifest. `verify:product` runs application fixture checks;
`verify:release` checks previously retained canonical composed evidence. Neither aliases the missing correlated
GT-10B journey or elects the private shared-contracts caller package.

## Meaningful controls

```sh
node --test tests/release-verifier.test.mjs
/path/to/release-validator/bin/python -I -B \
  tests/release-verifier-canonical.py /path/to/components/integration-evals
```

The Node controls exercise actual CLI refusal. The Python controls import the real pinned validator and invoke the
actual application CLI using disposable Git repositories and explicitly **constructed synthetic/mock** records.
They cover missing/wrong manifests, stale/dirty/hidden evaluator source, missing composed receipts, wrong components,
catalog/source joins, tampered artifact bytes, omitted history, a saved failed ancestor followed by a passing run,
required skips, incomplete cleanup, nonzero exits, unknown fields and sensitive/ambiguous input. Command and cleanup
sentinels prove that inspection does not execute those manifest arrays. Actual same-byte clean-filter controls cover
the app, component and inherited configuration boundaries; HEAD/index gitlink controls require refusal before nested
status. The positive protocol control always asserts
`acceptance: "not_recorded"`. Missing canonical prerequisites fail these controls rather than skip them. The separate
`Canonical release evidence gate` workflow performs these controls with the same source/runtime pins and retains logs.

Actual app-owned composed manifest, complete canonical runs, selected private caller custody/compatibility, required
provider inputs and accountable acceptance remain owned dependencies of [GT-10A](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/8)
and [GT-10B](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/19). This implementation does not close
those issues, the release gate or the epic.
