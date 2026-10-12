"use client";
// The landing page: the hero, then `children` (the studio start, on the paper desk), then the rest of the page.
// The markup is the landing page's own (markup.ts), rendered as HTML so its script can drive it exactly as built;
// landing.script.ts runs on mount and stops everything on unmount. The studio start stays a React child in the middle.
import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { looksLikeLink } from "@/customer/start/make";
import { CHROME_HTML, FOOT_HTML, HERO_HTML, REST_HTML } from "./markup";
import { mountLanding } from "./landing.script";
import "./landing.css";

/** Where the "Make yours" form sends a night: a pasted link is researched (?url=), anything typed is searched (?q=). */
export function newStubHref(text: string): string {
  const v = text.trim();
  if (looksLikeLink(v)) return `/new?url=${encodeURIComponent(/^https?:\/\//i.test(v) ? v : `https://${v}`)}`;
  return `/new?q=${encodeURIComponent(v)}`;
}

const PARTS = [CHROME_HTML, HERO_HTML, REST_HTML, FOOT_HTML];

export function Landing({ children }: { children: ReactNode }) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // the four landing parts, in page order (the studio start between the hero and the rest is not one of them)
    const hosts = Array.from(el.querySelectorAll<HTMLElement>(".lp-host"));
    if (hosts.length !== PARTS.length) return;
    const stop = mountLanding({ root: el, hosts, submit: (text: string) => router.push(newStubHref(text)) });
    return () => {
      stop();
      // the script rebuilt parts of the DOM; hand it back as served so a remount (strict mode, back navigation) starts clean
      hosts.forEach((h, i) => {
        h.innerHTML = PARTS[i];
      });
      el.classList.remove("ready", "no3d");
    };
  }, [router]);

  return (
    <div className="lp" ref={root}>
      <div className="lp-host" dangerouslySetInnerHTML={{ __html: PARTS[0] }} />
      <main id="top">
        <div className="lp-host" dangerouslySetInnerHTML={{ __html: PARTS[1] }} />
        {children}
        <div className="lp-host" dangerouslySetInnerHTML={{ __html: PARTS[2] }} />
      </main>
      <div className="lp-host" dangerouslySetInnerHTML={{ __html: PARTS[3] }} />
    </div>
  );
}
