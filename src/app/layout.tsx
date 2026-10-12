import type { Metadata, Viewport } from "next";
import { Analytics } from "@/customer/analytics/Analytics";
import { analyticsConfigFromEnv } from "@/customer/analytics/config";
import { DemoPill } from "@/customer/nav/DemoPill";
import { NavFrame } from "@/customer/nav/NavFrame";
import "./globals.css";

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
