# Application documentation map

Start with [CURRENT-STATE.md](architecture/CURRENT-STATE.md) for the host's source-pinned architecture and verified cross-repository connections. The immutable [architecture kit v1.0](architecture-kit/v1.0/docs/architecture.md) is dated design intent; it is not a description of the current runtime. The [master integration-evals checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md) owns integration acceptance and evidence state.

## Application interfaces and security

- [HTTP API reference](api/HTTP-API.md): method/path inventory, caller checks, request and response shapes, limits, errors, retries and synthetic examples for the implemented route handlers.
- [Identity and signed-context model](architecture/identity.md): sessions, capability checks, trust boundaries, token versions and source-level limitations.
- [Trust boundaries and types](architecture/boundaries.md): browser claims, server-derived authority and app-local adapter boundaries.
- [Approval](architecture/approval.md) and [order authorization](architecture/order-authorization.md): separate decisions and the present issuer/consumer limits.
- [Route inventory](architecture/routes.md): customer, admin and API route ownership.

## Setup and operations

- [Preview runtime](operations/preview-runtime.md): local and hosted configuration requirements and known runtime constraints.
- [HTTP origin boundaries](operations/http-boundaries.md): exact trusted-origin selection and failure behavior.
- [Deployed auth-storage runbook](operations/deployed-auth-storage-runbook.md): durable paths, health checks, backup and restore steps.
- [Operations and observability](operations/observability.md): runtime telemetry and scoped operational evidence.
- [Analytics](operations/analytics.md), [instrumented flow map](operations/analytics-flow-coverage.md), and [journey validation](operations/analytics-journey-validation.md): configuration, consent, known event coverage and dated offline browser evidence. The flow/journey records predate the app-native landing merged in PR [#104](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/104); their current coverage boundary is called out in those documents.

## Integration and product references

- [Event-intelligence adapter](integration/event-intelligence.md) and [creative-engine adapter](integration/creative-engine.md): app-owned mappings, fixtures and compatibility limits.
- [Assembly evidence](integration/assembly-evidence.md): local inventory and claim checks; a local pass is not master acceptance.
- [Product capabilities](product/capabilities.md) and [accessibility](product/accessibility.md): implemented behavior and documented limitations.
- [Studio documents](studio/README.md): studio flow, product intent, research notes and design references.

For clean local setup, supported scripts and test commands, see the root [README](../README.md). Historical reports and source snapshots remain dated evidence; read their source revision and scope before treating them as current behavior.
