# TicketStub studio (hackathon build)

The customer-facing studio. Give it an event link, watch the agent research the night, then shuffle styles, edit, tilt the foil, tear the stub off and pin it to your wall.

The studio is always cream paper. There is no dark stage: printing, the finish picker, the tear and a lifted stub all stay on the desk.

Design docs, wireframes and the coverage matrix are in [`docs/studio/`](../../../docs/studio/README.md). Brand assets come from the `brand-kit` repo (`src/brand/tokens.css`, `public/brand/`).

## Run it

```sh
npm ci
npm run dev          # http://localhost:3000
npm run build && npm start
```

The deployment defaults to demo mode with external research/provider requests
disabled, even when keys exist. Live calls need both
`TICKETSTUB_RUNTIME_MODE=live` (set at build and start; separately authorized
development only) and credentials for the provider each capability selects.
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
| `/` | Paste an event link (main path), search, demo shortcuts |
| `/search` | Search fallback (demo events) |
| `/new?url=` · `?q=` · `?demo=neathack\|pale\|harbour` | Printing reveal while the agent researches; tap facts to keep them |
| `/studio/[id]` | Editor: swipe styles, select and edit, fix unsure facts, remix, agent chat, flip, material, tear |
| `/wall` | Corkboard wall, lift a stub, public page toggle |
| `/s/[token]` | Memory page and friend landing (the share link carries the stub itself) |
| `/u/[token]` | Public wall |
| `/claim/neathack` | Judge claim for the neatHack 2026 matching set |
| `/checkout/[id]`, `/cart`, `/cart/unclaimed/[id]` | Buy now, cart, unclaimed-seat decision |
| `/friends/[id]`, `/gift/[id]`, `/wallet/[id]` | Matching stubs, gifting, wallet pass |
| `/organizer`, `/organizer/claim` | Organizer design and guest list, attendee claim |
| `POST /api/research`, `/api/art`, `/api/agent` | Event research, art generation, agent replies |

## What's real and what's simulated (EVAL-03)

Every fact carries a `source` and a `provenance` label, shown in the UI.

- **Live (live mode only):** fetching and parsing the event page (schema.org JSON-LD, then title), and weather from Open-Meteo. Art and agent replies are live only when the selected provider is also configured (see above). In demo mode, arbitrary event links are not fetched and art and agent replies are always simulated.
- **Simulated:** demo fixtures (neatHack 2026, The Pale Hours, Harbour FC), sign-in on the claim page, wallet passes, and QR codes (placeholders that don't scan).
- **Sandbox:** all prices, quotes, payments, shipping and refunds. Nothing is charged.
- **Pending:** facts that aren't known yet, such as neatHack winners and team count.

## Storage

Stubs live in the browser (`localStorage`). Share links encode the stub in the URL, so memory pages work without a backend. Inline AI images are dropped from older versions and from share links to stay inside storage limits. This stands in for the planned server records (`ProjectRequest`, `DesignVersion`) in the architecture kit.

## Brand rules applied

- **Foil never pops:** eased per frame (`stub/useTilt.ts`, `stub/Foil.tsx`), following brand-kit `docs/material-foil.md`.
- **Sound is on by default.** Cues are synthesized in `feedback.ts` the way cuelume builds sounds (brand-kit `docs/motion-sound-haptics.md`). Audition them at `/parts`.
- **Mobile first,** with a desktop layout from 960 px.
