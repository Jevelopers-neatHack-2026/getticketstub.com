import type { Metadata, Viewport } from "next";
import { Analytics } from "@/customer/analytics/Analytics";
import { analyticsConfigFromEnv } from "@/customer/analytics/config";
import { DemoPill } from "@/customer/nav/DemoPill";
import { NavFrame } from "@/customer/nav/NavFrame";
import { configuredOrigin } from "@/server/http";
import "./globals.css";

// TICKETSTUB_RUNTIME_MODE is a runtime secret on the host, so render per request instead of
// baking the demo banner into the build. Analytics settings are read the same way: one build can run
// as production, preview or with analytics off.
export const dynamic = "force-dynamic";

const DESCRIPTION = "Paste your event link and we design a personalized keepsake stub of the night. Digital keepsake from $9; printed editions in preview.";

// Every page shares one link preview (Open Graph + X card); the image is app/opengraph-image.png and twitter-image.png.
// Absolute image URLs need the public origin: APP_URL on the host, getticketstub.com otherwise.
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(configuredOrigin() ?? "https://getticketstub.com"),
    title: "TicketStub",
    description: "Turn your ticket into a stub worth keeping.",
    icons: { icon: "/brand/favicon.svg" },
    openGraph: {
      type: "website",
      siteName: "TicketStub",
      locale: "en_US",
      title: "TicketStub: keep the night",
      description: DESCRIPTION,
    },
    twitter: {
      card: "summary_large_image",
      title: "TicketStub: keep the night",
      description: DESCRIPTION,
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F4ECDD", // paper by day: the OS theme never flips the chrome
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" data-runtime-mode={process.env.TICKETSTUB_RUNTIME_MODE === "live" ? "live" : "demo"}>
      <body>
        <NavFrame notice={process.env.TICKETSTUB_RUNTIME_MODE !== "live" ? <DemoPill /> : null}>
          {children}
        </NavFrame>
        <Analytics config={analyticsConfigFromEnv(process.env)} />
      </body>
    </html>
  );
}
