"use client";
// "Analytics choices" for pages that explain analytics (the privacy page). Render it only where analytics is
// configured: it opens the card that <Analytics> mounts, so with analytics off there would be nothing to open.
import { PaperButton } from "@/customer/desk/Desk";
import { openConsentPreferences } from "./consent";

export function ConsentChoicesButton() {
  return (
    <PaperButton type="button" onClick={openConsentPreferences}>
      Analytics choices
    </PaperButton>
  );
}
