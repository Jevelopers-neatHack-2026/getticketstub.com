<!-- entire-graph:begin -->
This repo has the entire-graph code graph installed. Before exploring code with
grep/find/whole-file reads, read .entire/graph-agent.md — resolution-first guidance
for using graph retrieval, focused source inspection, and verification.
@.entire/graph-agent.md
<!-- entire-graph:end -->

## Deployment-completion gate (GoDaddy publication)

A required **manual** deployment gate, not an automated restore. After **every** GoDaddy publication, follow the
restore procedure in [docs/operations/analytics-rollout.md](docs/operations/analytics-rollout.md#after-every-publish-restore-and-verify-preview):

- Restore **only** the four public Preview overrides (`TICKETSTUB_ANALYTICS_ENV`, `TICKETSTUB_GA_MEASUREMENT_ID`,
  `TICKETSTUB_GA_DEBUG`, `TICKETSTUB_OPS_ENVIRONMENT`) in **two saves**, then restart Preview. Preserve every
  unrelated secret and setting (Neatlogs, backups, AI runtime and the rest); never bulk-sync, open, copy or reveal them.
- Verify in fresh browser sessions: Production sends only `G-RVV7ZNF463`, `deployment_env=production`, debug `0`;
  Preview sends only `G-M2ELMGCNKW`, `deployment_env=preview`, debug `1`. `TICKETSTUB_OPS_ENVIRONMENT` matches
  (`production` / `preview`).

Never consider a release complete until this hosted check proves the environments are isolated.
