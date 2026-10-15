# Product fixture verification

The product dispatcher runs the application's declared leaf checks in offline
fixture mode. Run it from a clean checkout with the recorded Node/npm versions,
lockfile installation and a fresh production build:

```sh
npm ci
npm run lint
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
npm run verify:product -- --suite all --mode fixture --evidence-dir out/gt-evidence
```

`all` selects every leaf in the dispatcher's current catalog, including browser
and recovery checks. It runs them serially in their declared order. It does not
silently omit a suite because a browser, build, fixture or other input is missing.
The existing leaf wrappers keep their provider network guard and fixture setup.
Run a single leaf with its existing name when diagnosing an individual failure.

## Results and recovery

Each invocation creates a fresh `all-<random>` directory beneath the requested
evidence directory. Each required leaf gets its own directory and keeps the
original wrapper receipt and any browser or file artifacts it produces. The
aggregate `all.json` records the exact commands, child exits, source/runtime,
receipt paths, byte sizes, SHA-256 digests and observed assertion counts.

An aggregate pass requires every selected child to exit successfully and produce
exactly one fresh, matching fixture receipt. Required failures, skips, missing or
malformed receipts, contradictory step counts, nonzero exits, network attempts,
and source/runtime mismatches fail the aggregate. A clean, pinned source must
remain unchanged through the run. The `out/` directory is ignored by Git so these
retained outputs do not themselves dirty a normal checkout.

Later suites still run after an earlier failure, retaining independent diagnostic
results. A suite with unavailable counts appears in `unreportedSuites`; its
missing result is never counted as a pass. `counts` sums only reported assertions,
while `faults` and each result's `faults` explain qualification failures. Inspect
the actual exit code and all fault fields rather than treating a positive count
as success. Keep a failed invocation when rerunning; the new directory preserves
both attempts.

## Acceptance boundary

This command reports the complete **declared app fixture catalog**. It does not
claim that the catalog implements every product requirement, a correlated journey
through every specialist, consumer acceptance, or an integrated release. The
correlated integration journey required by [GT-10B](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/19) remains
a separate implementation and evidence requirement. The canonical release
manifest and retained owner evidence must also pass the release verifier required
by [GT-12](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/6). Missing specialist inputs or accountable
acceptance remain blockers even when every local fixture passes.

The aggregate control tests use explicitly synthetic child receipts, including
failed, skipped, stale and missing results, to test the dispatcher. Those controls
are not product journey or provider evidence. No deployment, paid request,
credential provisioning, consumer acknowledgement or acceptance status follows
from adding or running this command.
