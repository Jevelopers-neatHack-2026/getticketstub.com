# Analytics live validation — 2026-10-11

Root orchestration exercised a local production build on Node 22.23.3 in Chrome using the real **Preview** measurement ID `G-M2ELMGCNKW`, demo runtime, debug enabled. This is local-build evidence, not evidence of a deployed release. No personal visitor data or raw network trace is attached.

## Observed

- First visit and persisted denial: zero requests to Google Analytics or Google Tag Manager.
- After consent: the preview tag loaded and sent product events.
- Creation demo → studio style change/flip → automatic tear → wall → sandbox checkout → local saved order completed. Google DebugView displayed intake, creation, reveal, studio, tear, wall, checkout, sandbox order, route timing and Web Vitals events. No `purchase` or `login` was emitted.
- The fresh tag configuration sent studio and checkout locations as `/studio/:id` and `/checkout/:id`; a fresh wall-to-studio navigation had one manual page view. Google DebugView event detail independently confirmed stored `page_location=http://127.0.0.1:43139/studio/:id` and `deployment_env=preview`.
- Phone viewport 390 × 844: consent choices readable, buttons usable, focus on withdrawal when reopened. Withdrawal persisted after reload, and subsequent wall navigation made zero Google requests. Viewport override reset.

## Google configuration readbacks

Both properties have enhanced measurement disabled on the saved stream, email redaction active and nine query redaction keys (`url`, `q`, `from`, `d`, `to`, `token`, `email`, `name`, `note`). Both exclude ads personalization in all 307 regions, have signals and user-provided collection off, and granular location/device collection off. Two-month event and user retention with activity reset off saved for both; preview retention verified after reload.

14 event dimensions, two metrics and the `tear_complete` key event were created on both. The key event has no default monetary value. The full public property/stream/measurement identifiers are recorded in [analytics.md](analytics.md).

## Discovery and resolution

Disabling enhanced measurement during stream creation did not persist. Earlier test traffic included automatic scroll and unsanitized history page views. Root disabled it on each **saved** stream, confirmed the change after reload, then disabled browser cache and reloaded the tag. Fresh requests had only the application's manual page views. The earlier test events remain in Preview DebugView; they must not be mistaken for the corrected configuration. Verify fresh requests before enabling any deployed collection: cached Google configuration can outlive an admin change.

## Remaining release validation

Final source checks/build and Astra review are tracked in the implementation PR. Full phone and desktop coverage of sharing, claims, organizer import/publish, all option handlers, same-template navigation and deployed-host behavior remains to be exercised. Internal/developer traffic filters, saved explorations, access ownership review and deployment variables remain external rollout work. Keep issue #39 open until its release acceptance evidence is complete.

Final build regression: production smoke passed all eight pages/assets and demo API/blocked external research/art/agent/404 checks. Gift wrap/delivery choices and wallet provider choice were clicked in Chrome; the real preview transport emitted `gift_option`, `wallet_option`, and `nav_select` with safe template locations. Collection was turned off again after QA. Full tests passed 240/240 twice each on Node 22.23.3 and Node 24.15.0 after isolating provider test storage; lint/typecheck and production build passed.
