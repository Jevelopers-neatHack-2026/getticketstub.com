# Studio ↔ architecture alignment

How the ticket studio design (`product-spec.md`, `flow.md`, `stub-system.md`) fits the architecture kit (`../architecture-kit/v1.0/`) and the contract catalog maintained in `shared-contracts`. Decided 2026-10-10.

> **Design-intent record, not an implementation map.** The decisions and ownership assignments below capture the studio proposal as of 2026-10-10. The current app still owns local research and creative adapters, and not every proposed repository or contract is connected at runtime. Use the source-pinned [current architecture and integration state](../architecture/CURRENT-STATE.md) for what `main` implements and the master checklist it links for acceptance. Keep this dated design record as historical intent; do not use its tables as proof that a component, contract or workflow has shipped.

## Decisions

| Topic | Architecture kit says | Studio decision |
|---|---|---|
| Interaction model | ChatKit conversation plus a design canvas | **The studio is the design canvas.** A ChatKit side chat is where the research agent narrates facts and takes "describe it" remixes. Swipe, tap, flip and tear stay as designed. |
| Input | `ProjectRequest` with a source URL | **URL first** for the 48-hour build (the neatHack page is the demo event). Ticket screenshot parsing is a stretch goal that feeds the same `EventIntelligencePackage`. |
| Versions | "Edits create new versions; approval binds the displayed immutable version" | **Only art changes create a new `DesignVersion`:** style swipe, remix, new generated art. Type tweaks, chip picks and material choice are print-production personalization on the same version, so editing stays instant. The composed preview is what gets approved (ART-02). |
| Demo scope | One event source, one template, one edit, one personalized output | Printing reveal with fact cards; swiping styles plus one edit; tilt and foil preview; tear, wall and memory page. |

## Where each studio piece lives

| Studio piece | Repo / path | Contract |
|---|---|---|
| Editor, gestures, wall, memory page, share, checkout UI | `getticketstub.com` `src/customer/`, `src/orders/` | `DesignControlSchema` (the allowlisted controls the editor exposes) |
| Fact cards during printing | `event-intelligence` (facts + provenance), `agent-harness` (orchestration) | `EventIntelligencePackage`: every card shows its source or an explicit "unsure" (AGT-01). The pulsing low-confidence chip is the UI for that uncertainty. |
| Generated art layer (text-free) | `creative-engine` | `CreativeBrief` → `DesignVersion`. The "no text in art" rule matches the kit: exact text belongs to print-production. |
| Live type, chips, layout slots | `print-production` `src/composition/` | `ProductionBundle` (fonts, exact text, template). Snap-to-slot positions are template data. |
| Foil and holo, on screen | `getticketstub.com` frontend | None needed. Technique: `research/holo-foil-technique.md`, rules in brand-kit `docs/material-foil.md`. |
| Foil and holo, in print | `print-production` (special-finish layer in the template) | `ProductionBundle.print_spec`: **gap**, needs a finish field. |
| Material tiers ($9 / $29 / $49 / $89) | Quotes in `fulfillment-connectors`, price in `cost-intelligence` | `FulfillmentQuote`, `OrderAuthorization`. P0 is sandbox only, so label prices "sandbox" or "simulated" in the demo (EVAL-03). |
| Organizer CSV merge | `print-production` (P1 in the kit) | Not P0. The organizer wireframes are the target design. |
| Brand tokens, logo, voice | `brand-kit` | n/a |

## Gaps to raise with contract owners

1. **`ProjectRequest`** needs an upload input type (screenshot, PDF, email, wallet pass) next to the source URL.
2. **`DesignControlSchema`** needs controls for style family, font pair, colour swatch, foil toggle, slot position and chip visibility.
3. **`ProductionBundle` / print spec** needs finishes (foil, holo stock, emboss) and stub shapes (classic 2 × 5.5 in, stamp 2 × 3 in, framed 8 × 10).
4. **Event types:** the facts package should carry `event_type` (concert, game, show, generic), so the back side and the memory page know what to show: setlist, score and moments, or cast.
5. **Several SKUs:** the kit's P0 assumes one product. The material toggle needs at least a quote per tier, even if only one tier is fulfilled in the sandbox.
6. **Not in the kit at all:** wall, memory page, matching sets and claim links, wallet pass, share images. All are owned by `getticketstub.com` and need no new contracts for the demo.

## Wireframes

Lo-fi, mobile first with a desktop version of every screen: drop zone, printing reveal, editor (rest, selected, back), tear, wall, memory page, buy-now and cart, and organizer. Canvas: [Ticket Studio Editor Wireframe](https://claude.ai/artifact/UtqYmCtBT1Chnh9bGEJ2d9) (private link; needs team access).
