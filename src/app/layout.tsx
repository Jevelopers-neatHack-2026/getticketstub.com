import type { Metadata, Viewport } from "next";
import { Fraunces, Inter_Tight } from "next/font/google";
import { Analytics } from "@/customer/analytics/Analytics";
import { analyticsConfigFromEnv } from "@/customer/analytics/config";
import { DemoPill } from "@/customer/nav/DemoPill";
import { NavFrame } from "@/customer/nav/NavFrame";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-display",
  display: "swap",
});

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

// TICKETSTUB_RUNTIME_MODE is a runtime secret on the host, so render per request instead of
// baking the demo banner into the build. Analytics settings are read the same way: one build can run
// as production, preview or with analytics off.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "TicketStub",
  description: "Turn your ticket into a stub worth keeping.",
  icons: { icon: "/brand/favicon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F4ECDD", // paper by day: the OS theme never flips the chrome
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${fraunces.variable} ${interTight.variable}`}>
      <body>
        <NavFrame notice={process.env.TICKETSTUB_RUNTIME_MODE !== "live" ? <DemoPill /> : null}>
          {children}
        </NavFrame>
        <Analytics config={analyticsConfigFromEnv(process.env)} />
      </body>
    </html>
  );
}
