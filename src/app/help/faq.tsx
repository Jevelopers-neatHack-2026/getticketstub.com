// The help questions. Every price and number is read from the same constants the app uses, so an answer cannot drift from the screen.
import type { ReactNode } from "react";
import { MarkLegend } from "@/customer/desk/Desk";
import { FINISHES, SHIPPING_ESTIMATE_MINOR, sizesFor } from "@/customer/pages/commerce";
import { CAPABILITY_VERSION, SIZE_COPY, STATUS_WORDS, variantFor } from "@/customer/pages/capabilities";
import { TearAnchor } from "@/customer/pages/ui";
import { MATERIALS, formatMoney } from "@/customer/studio/types";

// Sign-in link life (src/server/auth.ts LINK_TTL_MS), quote life (commerce.ts quote()) and claim-link life (organizer copy).
// Those live in server or inline code, so they are named once here.
const SIGN_IN_MINUTES = 15;
const QUOTE_MINUTES = 15;
const CLAIM_DAYS = 30;

export interface Faq {
  id: string;
  q: string;
  a: ReactNode;
}

export interface FaqGroup {
  id: string;
  title: string;
  items: Faq[];
}

const money = (minor: number) => formatMoney(minor).replace(".00", "");
const materialLine = MATERIALS.map((m) => `${m.label} ${money(m.priceMinor)}`).join(" · ");
const printedFinishes = FINISHES.filter((f) => f.upchargeMinor > 0 && f.id !== "holo");

export const FAQ_GROUPS: FaqGroup[] = [
  {
    id: "making",
    title: "Making a stub",
    items: [
      {
        id: "ticketmaster-links",
        q: "Which links work?",
        a: (
          <>
            <p>Paste a Ticketmaster or Live Nation link, or any event page with event data, and we read the show for you. No link? Search for your show.</p>
            <p>
              <TearAnchor href="/make">Paste a link</TearAnchor> <TearAnchor href="/search">Search for your show</TearAnchor>
            </p>
          </>
        ),
      },
      {
        id: "blocked-event-links",
        q: "What if a ticket site blocks the link?",
        a: <><p>Some ticket sites block automated reads. When we detect that, you can enter the event name and date, with an optional venue and city, and still make your stub. Those details are marked “Entered by you”. Weather is looked up separately when a city is supplied and live research is available.</p><p>You can also open the event in your own browser to check the details. The site may show a verification step there too.</p></>,
      },
      {
        id: "where-facts-come-from",
        q: "Where do the facts come from?",
        a: (
          <>
            <p>The agent looks up the venue, the date, the weather and the story of the night. Every fact carries a printer&apos;s mark that says where it came from.</p>
            <MarkLegend marks={["live", "estimated", "pending"]} />
            <p>Live came from a real source. An estimate is our best guess. Not known yet means we have not found it.</p>
          </>
        ),
      },
      {
        id: "fix-a-fact",
        q: "A fact is wrong. How do I fix it?",
        a: <p>Tap the fact on your stub and type the right one. Check the facts before you print, because a lookup can be wrong.</p>,
      },
      {
        id: "change-style",
        q: "How do I change the style?",
        a: (
          <>
            <p>On a phone, swipe the stub for another style, or press the All styles button (or press and hold) to browse them. On desktop, pick one from the styles column.</p>
            <p>
              <TearAnchor href="/make">Make a stub</TearAnchor>
            </p>
          </>
        ),
      },
      {
        id: "zoom-the-mat",
        q: "How do I zoom the mat?",
        a: <p>On desktop, scroll to zoom, drag with the middle button to move around, and press 0 to fit the stub back in view.</p>,
      },
      {
        id: "tear-the-stub",
        q: "What does tearing the stub do?",
        a: (
          <>
            <p>Tearing it off along the dotted line finishes the stub and sets it on your wall. You can still open it again to change it.</p>
            <p>
              <TearAnchor href="/wall">Open your wall</TearAnchor>
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "printing",
    title: "Printing and prices",
    items: [
      {
        id: "materials-and-prices",
        q: "What can I print on, and what does it cost?",
        a: (
          <>
            <p>{materialLine}</p>
            <p>These are sandbox prices, not printer quotes. Digital is the file and your wallet pass, and you can get it in the sandbox. Card, Print and Framed are previews: we have not confirmed a printer SKU for them yet, so none can be ordered for real. {STATUS_WORDS.preview} is marked with a printer&apos;s mark wherever you pick one.</p>
          </>
        ),
      },
      {
        id: "finishes",
        q: "What finishes and add-ons are there?",
        a: (
          <p>
            Matte is included. {printedFinishes.map((f) => `${f.label} adds ${money(f.upchargeMinor)}`).join(", ")} on each printed stub, as a sandbox price. Digital includes Matte and Foil, drawn on screen. Foil is a separate metallic stock at the printer we are checking, published from 4 × 6 in, so Foil on a 2 × 3 or 2 × 5.5 in stub is unverified.
          </p>
        ),
      },
      {
        id: "holo",
        q: "Can Holo be printed?",
        a: <p>No. Holo is a screen effect and is not printed. You can see it on your stub, and on your wall, and it is included on every stock as a preview. The printed finishes are Matte and Foil. A printed holographic finish has not been confirmed with any printer.</p>,
      },
      {
        id: "sizes",
        q: "What sizes are there?",
        a: (
          <ul>
            {MATERIALS.map((m) => (
              <li key={m.id}>
                {m.label}: {sizesFor(m.id).map((s) => `${SIZE_COPY[s].name} (${SIZE_COPY[s].measure})`).join(" or ")}
                {variantFor(m.id, sizesFor(m.id)[0], "matte")?.status === "preview" ? `. ${STATUS_WORDS.preview}` : ""}
              </li>
            ))}
          </ul>
        ),
      },
      {
        id: "what-sizes-measure",
        q: "What do the size numbers measure?",
        a: (
          <>
            <p>
              A Classic stub (2 × 5.5 in) and a Stamp (2 × 3 in) are trim sizes: the cut edge of the card or print. They are our nominal sizes and are not matched to a printer template yet, so bleed and safe area are unknown.
            </p>
            <p>
              A Framed print is listed by its frame size, 8 × 10 in. That is the glazing, the glass, and it leaves out the frame width. A mat shrinks the image window, so the picture is smaller than 8 × 10. For example, 18 × 24 in glazing with a 2 in mat gives a 14 × 20 in image. The outside size depends on the frame, and we have not picked one.
            </p>
            <p>Capability map {CAPABILITY_VERSION}.</p>
          </>
        ),
      },
      {
        id: "shipping",
        q: "Is shipping included?",
        a: (
          <p>
            Shipping is an estimate: {money(SHIPPING_ESTIMATE_MINOR)} flat, shown before you pay. Digital stubs do not ship.
          </p>
        ),
      },
      {
        id: "sandbox",
        q: "Will I be charged?",
        a: <p>No. Checkout is a sandbox, so nothing is charged and we never ask for card details.</p>,
      },
      {
        id: "quotes",
        q: "How long does a price hold?",
        a: <p>A quote holds for {QUOTE_MINUTES} minutes. Change the material, finish or size and you get a new quote. After the time is up, check the price again before you print.</p>,
      },
    ],
  },
  {
    id: "wall-account",
    title: "Your wall and account",
    items: [
      {
        id: "magic-link",
        q: "How do I sign in?",
        a: (
          <>
            <p>No password. We email you a link that works once and expires in {SIGN_IN_MINUTES} minutes.</p>
            <p>
              <TearAnchor href="/signin">Save to your wall</TearAnchor>
            </p>
          </>
        ),
      },
      {
        id: "across-devices",
        q: "Will my stubs follow me?",
        a: <p>Yes. Saved stubs show up on every device you sign in on. Signed out, they stay in this browser only.</p>,
      },
      {
        id: "wall-moves",
        q: "How do I move stubs around my wall?",
        a: (
          <>
            <p>Drag a stub to set it down where you want it. Scroll or pinch to zoom, and use the fullscreen button for the whole wall.</p>
            <p>
              <TearAnchor href="/wall">Open your wall</TearAnchor>
            </p>
          </>
        ),
      },
      {
        id: "public-wall",
        q: "Can I share my wall?",
        a: <p>Turn on your public wall for one link anyone can open. Each stub also has its own share page, ready to send anywhere.</p>,
      },
      {
        id: "change-email",
        q: "How do I change my email?",
        a: (
          <>
            <p>Enter the new address in your account. We email a link there, and the change lands when you open it.</p>
            <p>
              <TearAnchor href="/account">Open your account</TearAnchor>
            </p>
          </>
        ),
      },
      {
        id: "delete-account",
        q: "How do I delete my account?",
        a: (
          <>
            <p>Choose Delete my account in your account. Your wall, share links and organizer events leave our server, and receipts stay without your email.</p>
            <p>
              <TearAnchor href="/account">Open your account</TearAnchor>
            </p>
          </>
        ),
      },
      {
        id: "what-we-store",
        q: "What do you store?",
        a: (
          <>
            <p>Your email, your saved stubs and art, your orders, and any guest names an organizer adds. Nothing is sold or used for ads.</p>
            <p>
              <TearAnchor href="/privacy">Read the privacy page</TearAnchor>
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "organizers",
    title: "Organizers",
    items: [
      {
        id: "print-a-run",
        q: "Can I print a run for my guests?",
        a: (
          <>
            <p>Yes. Upload your guest list and every guest gets their own stub, printed in one run.</p>
            <p>
              <TearAnchor href="/organizer">Start a run</TearAnchor>
            </p>
          </>
        ),
      },
      {
        id: "guest-names",
        q: "Can guest names go on the front?",
        a: <p>Yes. Each stub carries its guest&apos;s name on the front, and a seat when you add one.</p>,
      },
      {
        id: "claim-links",
        q: "How do guests get their stub?",
        a: <p>Each guest has their own claim link that puts their named stub on their wall. Links last {CLAIM_DAYS} days.</p>,
      },
      {
        id: "organizer-pricing",
        q: "What does a run cost?",
        a: (
          <p>
            Fan prices, per guest ({materialLine}), plus finish add-ons. Shipping is {money(SHIPPING_ESTIMATE_MINOR)}, charged once for the run.
          </p>
        ),
      },
    ],
  },
];
