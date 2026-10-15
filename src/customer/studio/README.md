# TicketStub studio (hackathon build)

The customer-facing studio. Give it an event link, watch the agent research the night, then shuffle styles, edit, tilt the foil, tear the stub off and pin it to your wall.

The studio is always cream paper. There is no dark stage: printing, the finish picker, the tear and a lifted stub all stay on the desk.

Design docs, wireframes and the coverage matrix are in [`docs/studio/`](../../../docs/studio/README.md). Adopted brand assets come from [brand-kit](https://github.com/Jevelopers-neatHack-2026/brand-kit) and are consumed in [`src/brand/tokens.css`](../../brand/tokens.css) and [`public/brand/`](../../../public/brand/). The [application README](../../../README.md#status) is the entry point for current implementation and release status.

## Run it

Run these commands from the **repository root**, using Node `22.23.3` and npm `11.16.0` from the application manifest:

```sh
npm ci
npm run dev          # http://localhost:3000
npm run build
npm start
```

The research/art/agent runtime defaults to demo mode with its external requests
disabled, even when keys exist. Live calls need both
`TICKETSTUB_RUNTIME_MODE=live` (set at build and start) and credentials for the provider each capability selects. Enabling calls requires the project's authorization and budget process. Mail and payment gates are separate from this research-mode setting; keep those credentials absent for an unconfigured demo.
Runtime versions, Plus Launch settings and the full provider reference are in
[Preview runtime, deployment and provider configuration](../../../docs/operations/preview-runtime.md).

Each capability picks its provider independently (`TICKETSTUB_RESEARCH_PROVIDER`,
`TICKETSTUB_AGENT_PROVIDER`, `TICKETSTUB_ART_PROVIDER`). With the default direct
providers, in live mode:

| Variable | Used for | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | One research call per event to pull extra facts from the page; free-text agent replies (`claude-sonnet-5-5`) | Facts come from the page's schema.org data and Open-Meteo only; the agent uses rule-based replies |
| `OPENAI_API_KEY` | Generated, text-free art (`gpt-image-1`) | Procedural art, labelled "Sample art" |
| `OPEN_METEO_API_KEY` | Weather and place lookups on the Open-Meteo customer endpoints (API Standard; no historical weather) | The free Open-Meteo endpoints, for evaluation only, not commercial use |

When a capability's provider is set to `openrouter`, it needs its own model and
key instead, with no shared `OPENROUTER_API_KEY` and no fallback to another key
or to simulated output:

| Capability | Model setting | Key setting |
|---|---|---|
| Research | `TICKETSTUB_RESEARCH_MODEL` | `TICKETSTUB_RESEARCH_OPENROUTER_API_KEY` |
| Agent | `TICKETSTUB_AGENT_MODEL` | `TICKETSTUB_AGENT_OPENROUTER_API_KEY` |
| Art (OpenAI image models only) | `TICKETSTUB_ART_MODEL` | `TICKETSTUB_ART_OPENROUTER_API_KEY` |

## Routes

| Route | What it does |
|---|---|
| `/` | Landing experience with studio event intake beneath the hero ([PR #104](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/104)) |
| `/make` | Dedicated event intake, search and demo shortcuts |
| `/search` | Search fallback (demo events) |
| `/new?url=` · `?q=` · `?demo=neathack\|pale\|harbour` | Printing reveal while the agent researches; tap facts to keep them |
| `/studio/[id]` | Editor: swipe styles, select and edit, fix unsure facts, remix, agent chat, flip, material, tear |
| `/wall` | Corkboard wall, lift a stub, public page toggle |
| `/s/[token]` | Memory page and friend landing; server-backed shares and legacy encoded-stub links have different persistence boundaries |
| `/u/[token]` | Public wall |
| `/claim/neathack` | Judge claim for the neatHack 2026 matching set |
| `/checkout/[id]`, `/cart`, `/cart/unclaimed/[id]` | Buy now, cart, unclaimed-seat decision |
| `/friends/[id]`, `/gift/[id]`, `/wallet/[id]` | Matching stubs, gifting, wallet pass |
| `/organizer`, `/organizer/claim` | Organizer design and guest list, attendee claim |
| `/account`, `/signin/confirm` | Account management and one-use magic-link confirmation |
| `/payment/return` | Hosted payment return; webhooks determine settlement |
| `POST /api/research`, `/api/art`, `/api/agent` | Event research, art generation, agent replies |

See the [route map](../../../docs/architecture/routes.md) for server and admin boundaries. The [download component](download/DownloadStub.tsx) exports the rendered front or back as a PNG; that local export does not establish paid-artifact or supplier-handoff acceptance.

## What's real and what's simulated (EVAL-03)

Every fact carries a `source` and a `provenance` label, shown in the UI.

- **Live (live mode only):** fetching and parsing the event page (schema.org JSON-LD, then title), and weather from Open-Meteo. Art and agent replies are live only when the selected provider is also configured (see above). In demo mode, arbitrary event links are not fetched and art and agent replies are always simulated.
- **Simulated:** demo research fixtures (neatHack 2026, The Pale Hours, Harbour FC), wallet passes and QR placeholders. Account sign-in is implemented; actual email delivery requires Resend, while sandbox mail is a separately configured development path.
- **Sandbox or provider-backed checkout:** an unconfigured checkout remains sandbox. Merged Dodo/Stripe adapters can create hosted checkout when their separate configuration and variant gates permit it; a client redirect is not proof of payment. Current physical variants remain preview-only or unavailable, and supplier fulfillment is not established by this UI. See [configuration](../../../README.md#configuration) and the [capability map](../pages/capabilities.ts).
- **Pending:** facts that aren't known yet, such as neatHack winners and team count.

## Storage

[`store.ts`](store.ts) keeps the browser cache and signed-out wall in `localStorage`. When signed in and server storage is available, [`account/sync.ts`](../account/sync.ts) merges changes with the account wall through `POST /api/wall/sync`. The server stores records in SQLite and artwork in content-hashed files. Server-backed shares coexist with legacy links that encode a compact stub; inline photos/art are not an unlimited durable share payload.

If server storage is unavailable, the application reports device-only saving. Cross-deploy durability and backup restoration depend on the host configuration and its evidence, documented in the [auth/storage runbook](../../../docs/operations/deployed-auth-storage-runbook.md). The local data model is not proof that every planned canonical `ProjectRequest` or `DesignVersion` integration is accepted.

## Validation

From the repository root, use `npm test`, `npm run lint`, `npm run typecheck` and `npm run build`. The [application checks](../../../README.md#checks) and `verify:product` suite table distinguish source fixtures, production-build checks and Chrome journeys. Keep actual command results tied to their tested revision; a design reference or simulated result does not satisfy the integrated release gate.

## Brand rules applied

- **Foil never pops:** eased per frame (`stub/useTilt.ts`, `stub/Foil.tsx`), following brand-kit `docs/material-foil.md`.
- **Sound is on by default.** Cues are synthesized in `feedback.ts` the way cuelume builds sounds (brand-kit `docs/motion-sound-haptics.md`). Audition them at `/parts`.
- **Mobile first,** with a desktop layout from 960 px.

### Fact inclusion

Facts uses **Add to stub** and **Remove from stub**, with a separate inclusion status. Title, date and venue map to `event.title`, `event.dateISO` and `event.venue`; the template includes these core details by default, so they have no optional inclusion toggle. Optional facts require selection on both faces, including unsure weather. Adding a hidden optional fact clears its hidden override and the facts-layer override. Removing it retains its source, uncertainty and correction history. The inspector counts selected extra facts; spatial fit is a separate requirement tracked in #95.

Legacy duplicate fact IDs are repaired when a wall is read or written. Every fact and individual selection survives; hidden overrides expand to the repaired IDs. Corrections whose original target is ambiguous remain in history with `unresolvedIdentity`, excluded from per-fact correction/undo authority and identified in Facts for review. IDs are allocated at ingestion and persisted, never generated during rendering.
