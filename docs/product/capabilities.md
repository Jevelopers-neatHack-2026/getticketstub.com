# Material, size and finish capabilities

Capability map version `2026-10-12.1`, supplier pages reviewed `2026-10-10` (the sandbox validation product below: `2026-10-12`) (GitHub issue GT-07A, getticketstub.com #23).
The map is `src/customer/pages/capabilities.ts`. This page is its reviewed matrix. If the two disagree, one of them is stale: the check does not compare this page with the code, so update both together.

No authenticated supplier lookup, quote or order was made. Nothing below is a supplier quote. Retail prices in the studio ($9 / $29 / $49 / $89, foil +$6, shipping $6) are local sandbox fixtures.

## Status words

| Status | What the studio says | What it allows |
| --- | --- | --- |
| `orderable` | Orderable in the sandbox | Sandbox order. Allowed in live mode. |
| `preview` | Preview, not yet orderable | Shown and quoted as a sandbox fixture. Never a real order: blocked when `TICKETSTUB_RUNTIME_MODE=live`. |
| `unavailable` | Not orderable. Holo reads "Screen effect · not printed" | Never ordered, in any mode. |

Provenance says how we know: `confirmed` (we or a supplier confirmed it), `published-docs` (a supplier's public page says so, the exact SKU is not mapped), `assumed` (our own claim, nothing checked).

A variant is `orderable` only with a confirmed supplier SKU. Nothing physical has one yet, so every physical variant is `preview` or `unavailable`. Digital has no supplier: it is drawn by TicketStub (`supplier: TicketStub`, `sku: null`).

## Reviewed matrix (tier × size × finish)

Dimensions are kept apart and `unknown` stays unknown. `n/a` means the measurement does not exist for that product. The columns are trim, glazing, mat window and frame exterior. Bleed and safe area are `unknown` for every physical variant, because there is no accepted print template yet. No physical variant has a supplier or SKU (`null`).

| Tier | Size | Finish | Status | Supplier | SKU | Provenance | Trim | Glazing | Mat window | Exterior |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| digital | Digital file | matte | Orderable (sandbox) | TicketStub | null | confirmed | Unknown | n/a | n/a | n/a |
| digital | Digital file | foil | Orderable (sandbox) | TicketStub | null | confirmed | Unknown | n/a | n/a | n/a |
| digital | Digital file | holo | Preview, not yet orderable | TicketStub | null | assumed | Unknown | n/a | n/a | n/a |
| card | Classic stub | matte | Preview, not yet orderable | null | null | assumed | 2 × 5.5 in | n/a | n/a | n/a |
| card | Classic stub | foil | Preview, not yet orderable | null | null | assumed | 2 × 5.5 in | n/a | n/a | n/a |
| card | Classic stub | holo | Not orderable (screen effect only) | null | null | assumed | 2 × 5.5 in | n/a | n/a | n/a |
| card | Stamp | matte | Preview, not yet orderable | null | null | assumed | 2 × 3 in | n/a | n/a | n/a |
| card | Stamp | foil | Preview, not yet orderable | null | null | assumed | 2 × 3 in | n/a | n/a | n/a |
| card | Stamp | holo | Not orderable (screen effect only) | null | null | assumed | 2 × 3 in | n/a | n/a | n/a |
| print | Classic stub | matte | Preview, not yet orderable | null | null | assumed | 2 × 5.5 in | n/a | n/a | n/a |
| print | Classic stub | foil | Preview, not yet orderable | null | null | assumed | 2 × 5.5 in | n/a | n/a | n/a |
| print | Classic stub | holo | Not orderable (screen effect only) | null | null | assumed | 2 × 5.5 in | n/a | n/a | n/a |
| print | Stamp | matte | Preview, not yet orderable | null | null | assumed | 2 × 3 in | n/a | n/a | n/a |
| print | Stamp | foil | Preview, not yet orderable | null | null | assumed | 2 × 3 in | n/a | n/a | n/a |
| print | Stamp | holo | Not orderable (screen effect only) | null | null | assumed | 2 × 3 in | n/a | n/a | n/a |
| framed | Framed print | matte | Preview, not yet orderable | null | null | published-docs | Unknown | 8 × 10 in | Unknown | Unknown |
| framed | Framed print | foil | Preview, not yet orderable | null | null | published-docs | Unknown | 8 × 10 in | Unknown | Unknown |
| framed | Framed print | holo | Not orderable (screen effect only) | null | null | assumed | Unknown | 8 × 10 in | Unknown | Unknown |

Per-variant notes:

- **Foil** is a separate metallic-foil substrate at Prodigi (gold or silver), published from 4 × 6 in. Foil at 2 × 3 in and 2 × 5.5 in is unverified, so Card + Foil and Print + Foil stay `preview`. Prodigi does not have "no foil products": framed metallic foil prints also exist, but 8 × 10 and its mat options are unverified.
- **Holo** is a screen effect on every tier. Digital Holo is a preview on screen. As a printed finish it is `unavailable`: the reviewed pages do not establish a holographic SKU. That is "unverified", not "proven impossible at every supplier". Print + Holo, Card + Holo and Framed + Holo are all `unavailable`.
- **Framed 8 × 10** is the glazing (glass) size, with the frame width left out. A mat shrinks the image window and the frame profile decides the outside size, so mat window and exterior are `unknown`. The studio says: "Frame 8 × 10 in · image window depends on the mat".
- **Digital** has no fixed pixel size yet (`unknown`).

## What each measurement means

| Measurement | Meaning |
| --- | --- |
| Trim | The cut edge of the card or print. Classic stub 2 × 5.5 in and Stamp 2 × 3 in are our nominal sizes, `assumed`, not matched to a printer template. |
| Bleed | Artwork that runs past the trim so a cut never leaves a white edge. Unknown until a template is accepted. |
| Safe area | The inside margin where text and the tear edge stay clear of the cut. Unknown until a template is accepted. |
| Glazing | The size of the glass. Prodigi lists a frame by this number. It excludes the frame width. |
| Mat window | The opening a mat leaves for the image: glazing minus the mount on each side. Depends on the mat. |
| Exterior | The outside of the frame, frame width included. Depends on the frame profile. Unknown. |

Geometry fixture (Prodigi's own example, not a launch SKU): 18 × 24 in glazing with a 2 in mount on each side leaves a 14 × 20 in image window. It is `GEOMETRY_FIXTURES` in the map and is asserted by the check.

## Sources

- Frame sizing FAQ (listed size is glazing, mounts, the 18 × 24 example): https://support.prodigi.com/hc/en-us/articles/13137070879772-Can-you-tell-me-more-about-your-frames
- Classic frames (mounted and unmounted variants, regional sizing): https://www.prodigi.com/products/wall-art/framed-prints/classic-frames/
- API reference (product details, dimensions with units, print areas, fill/fit/stretch resizing): https://www.prodigi.com/print-api/docs/reference/
- Metallic foil prints (ART-FOIL gold and silver, 4 × 6 to 40 × 80 in): https://www.prodigi.com/products/prints-and-posters/specialist-prints/metallic-foil-prints/
- Framed metallic foil prints: https://www.prodigi.com/products/wall-art/framed-prints/classic-framed-metallic-foil-prints/

## Sandbox validation product (not customer-facing)

`SANDBOX_VALIDATION_PRODUCTS` in the map names the one supplier product used to validate the Prodigi sandbox. The owner-delegated decision is integration-evals [`planning/decisions/0003-owner-delegated-decisions-2026-10-12.md`](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/decisions/0003-owner-delegated-decisions-2026-10-12.md), rows R1-R3. Version `2026-10-12.1` adds it.

| Field | Value |
| --- | --- |
| Supplier, SKU | Prodigi `GLOBAL-PHO-4X6` |
| Product | 4 × 6 in (102 × 152 mm) lustre C-type (silver-halide) photo print |
| Print area, orientation | `default`, landscape 6 × 4 in |
| Artwork | 1800 × 1200 px at 300 dpi, full bleed, sRGB, JPG, sizing `fillPrintArea` |
| Destination, shipping | `US`, `Standard` (`standard` in quotes) |
| Provenance | `published-docs`. No authenticated product-details read, quote or order has been made. |

It is used **only** for the first owner-approved sandbox product-details read, quote and test order. It is **not** a customer-facing mapping:

- No tier, size or finish points at it. It is not in `VARIANTS`, no variant carries its SKU, and every physical variant stays `preview` or `unavailable`.
- No price, finish or size claim in the studio changes. The `print` tier is still sold as matte, foil or holo, in Classic stub (2 × 5.5 in) or Stamp (2 × 3 in).
- **Open product decision:** the customer-facing `print`-tier mapping. Lustre is not matte, the SKU has no foil or holo option, and a customer would get a 6 × 4 sheet with the stub composed on it (a 5.5 × 2 in stub is 1650 × 600 px, which fits), not a trimmed stub. Finish naming, which variants map, and trim still need a decision. Until then the tier stays `preview`.

Checked on Prodigi's public pages on 2026-10-12, with WebFetch and no API call:

- The [C-types page](https://www.prodigi.com/products/prints-and-posters/photo-prints/c-types/) lists `GLOBAL-PHO-4X6` at 102x152mm, shipped from UK, EU, US, MX, AU, NZ and LV. It gives the optimal DPI as 300 and the file format as jpg or pdf.
- The same page lists lustre, high gloss and metallic for the C-type family, not per SKU. Only the product-details read (`GET /v4.0/products/GLOBAL-PHO-4X6`) confirms the finish attribute and US `shipsTo`.
- Neither the C-types page nor the [API reference](https://www.prodigi.com/print-api/docs/reference/) states sRGB. The C-types page offers an ICC profile download. sRGB is the decision's artwork policy, not a published Prodigi requirement.
- The API reference lists `Standard` (orders) and `standard` (quotes) as shipping methods, `fillPrintArea` as a sizing option, and `default` as the default print area.

## Ordering gate, quotes and old carts

- `orderGate(variant, mode)`: `unavailable` never passes. A `preview` passes in demo mode as a sandbox fixture and is refused in live mode. Live mode is `TICKETSTUB_RUNTIME_MODE=live`. The browser can only read a `NEXT_PUBLIC_TICKETSTUB_RUNTIME_MODE` mirror, which the deployment has to set alongside it. The server order route should call `orderGate` too, since the browser is not a boundary.
- `quoteId` is `qt_<capabilityVersion>_<material>_<finish>_<size>_x<qty>`. A new version, SKU, size or finish is a different quote id, so a stored quote stops holding.
- Cart items and orders carry `capabilityVersion` and the variant status.
- Old localStorage carts and orders: historical sandbox receipts are never rewritten. A cart item with no `capabilityVersion` resolves through the map. Only a confirmed-orderable one (digital Matte or Foil) carries over. Everything else, including every old "framed" item, is shown as "Choose again" and cannot be paid until picked again and re-quoted. It is never read as a new spec.

## Still blocked upstream

Final physical verification waits on accepted fixtures from other repositories. None of these exist yet:

- print-production #6: accepted SKU and template fixtures (trim, bleed, safe area, print-area pixels, crop/fit policy for ticket-shaped art).
- fulfillment-connectors #8: supported variants per SKU, attributes and destinations, with sanitized authenticated product-detail evidence.
- fulfillment-connectors #9: quote projection (shipping, tax, currency, expiry) for the selected SKU, attributes, destination and quantity.

Until then: no physical variant is `orderable`, destinations are not modeled (the issue's matrix asks for tier × size × finish × destination; destination is not covered here), mat and frame exterior stay `unknown`, and no preview is checked against a production template. Swapping in real SKUs is an edit to `capabilities.ts` plus a `CAPABILITY_VERSION` bump.

## Check

`node scripts/check-capabilities.mjs` (Node 22.15+, no network, no credentials) covers: every tier × size × finish present, the sandbox validation product's spec and that it maps to no customer variant, Card + Foil, Print + Holo and Framed + Holo explicit, no fabricated dimension, the 18 × 24 / 14 × 20 fixture, quote ids that name the version, a stale cart item flagged, historical receipts untouched, and live mode blocking preview variants.
