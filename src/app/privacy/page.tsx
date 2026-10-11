import type { Metadata } from "next";
import Link from "next/link";
import { analyticsConfigFromEnv } from "@/customer/analytics/config";
import { ConsentChoicesButton } from "@/customer/analytics/ConsentChoicesButton";
import { CONTACT, LegalPage } from "@/customer/pages/Legal";

export const metadata: Metadata = { title: "Privacy · TicketStub", description: "What TicketStub keeps, where it lives, and how to delete it." };

export default function PrivacyPage() {
  // The choices button only where analytics is configured: elsewhere there is no card to open.
  const analyticsOn = analyticsConfigFromEnv(process.env) !== null;
  return (
    <LegalPage
      kicker="Privacy"
      title="Your stubs are yours."
      lede="Here is what we keep, where it lives, and how to make it all go away."
      updated="11 Oct 2026"
      other={{ href: "/terms", label: "Read the terms." }}
      sections={[
        {
          title: "What we store",
          body: (
            <>
              <p>When you sign in, we keep your email address. We also keep what you save to your wall: your stubs and their art, your orders, and the guest names (and seats) an organizer adds to an event.</p>
              <p>We keep a sign-in cookie so you stay signed in for 90 days, and a second cookie that tells this device apart, so we can cap how much art one device makes in a day.</p>
            </>
          ),
        },
        {
          title: "Where it lives",
          body: <p>On our own server, in a SQLite database. Art you save is stored as files next to it. Nothing is sold, and nothing is used for ads.</p>,
        },
        {
          title: "What stays on your device",
          body: <p>Signed out, your stubs live only in this browser. Photos you add to a stub never leave your device. Your cart, sound setting and drafts stay here too.</p>,
        },
        {
          title: "Payments",
          body: <p>Payments are a sandbox. Nothing is charged, and we never ask for card details.</p>,
        },
        {
          title: "Optional analytics",
          body: (
            <>
              <p>
                Where analytics is switched on, we ask first. Until you choose &ldquo;Allow analytics&rdquo;, Google Analytics is not loaded, no analytics cookie is set and nothing is sent. If you say no, it stays that way.
              </p>
              <p>
                If you allow it, Google Analytics counts which kinds of pages and steps get used and how fast pages load: for example &ldquo;a share page was opened&rdquo; or &ldquo;a stub was torn&rdquo;. We send the kind of page, not its address, so your share links, stubs, names, notes, photos, searches and anything you type are left out. Google receives this along with what any browser sends a website, such as its address on the internet and browser type. Nothing is used for ads.
              </p>
              <p>
                To count visits, Google Analytics keeps a random identifier in a cookie in this browser. It belongs to this browser profile, not to you: another browser or device counts as someone new, and it is not linked to your TicketStub account.
              </p>
              <p>
                Your choice is saved in this browser. Change it any time with the <strong>Analytics</strong> tag at the bottom of the screen. Turning it off stops sending straight away and removes the Google Analytics cookies from this browser; what was already sent stays with Google for the time set in our Analytics settings.
              </p>
              {analyticsOn ? <ConsentChoicesButton /> : null}
            </>
          ),
        },
        {
          title: "Who else sees something",
          body: (
            <ul>
              <li>Resend sends our email, so it sees your address and the message.</li>
              <li>OpenAI makes the art, so it sees the show details we turn into a prompt (title, venue, date, vibe), not your email.</li>
              <li>When we read a show&apos;s page or write the margin notes, the show details go to Anthropic. Lookups can also reach Ticketmaster and public weather and map services.</li>
              <li>Google Analytics, only if you allow analytics: the kind of page and step, as described above.</li>
            </ul>
          ),
        },
        {
          title: "Delete everything",
          body: (
            <p>
              Open <Link href="/account">your account</Link> and choose &ldquo;Delete my account&rdquo;. Your wall, share links and organizer events are removed from our server, and your receipts are kept without your email. Stubs on this device stay until you clear them here. To ask for anything else, write to{" "}
              <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
            </p>
          ),
        },
      ]}
    />
  );
}
