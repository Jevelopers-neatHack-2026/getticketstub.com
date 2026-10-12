# Teardown of the current TicketStub builder

Source: getticketstub.com, reviewed by the team on 2026-10-09. TicketStub is our own product; this is what the redesign fixes.

## What it is today

A tool that turns event emails or screenshots into commemorative stub art. It has three entry points:
- a free builder
- a paid personal print: $9 digital, $29 card, $49 print, $89 framed
- organizer bulk runs, from $8/stub at 50+

**Builder flow:** upload a screenshot, OCR fills the template, edit fields, view a live SVG preview, then export PNG/SVG or print on Letter.

## What we're fixing

| Today | Redesign |
|---|---|
| The form is the product: about 24 text fields (event code left/right, left aux, right aux, CN, barcode digits…) | Almost no fields. Smart chips on the stub, and search only as a fallback |
| One fixed layout (a classic Ticketmaster-style stub) | Five editions plus a generative remix, explored by swiping |
| The preview is output only; you can't touch it | Direct manipulation: tap to edit, a floating toolbar, tilt, flip, tear |
| No emotional layer | Setlist, note, who you were with, photo, night-of research facts |
| Paid personalization happens offline through email revisions | The material toggle is on the stub, and the tear-off is checkout |

## What we keep

**Ingestion** (forward an email or screenshot and get a populated stub) is the strongest idea. It becomes the default first screen.
