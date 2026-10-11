"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ApiError, api } from "@/customer/account/api";
import { PaperButton } from "@/customer/desk/Desk";
import { messageFor } from "@/customer/feedback-messages/messages";
import type { Stub } from "@/customer/studio/types";
import { StubView } from "@/customer/studio/stub/StubView";
import { decodeWall, formatDate, memoryPath } from "@/customer/pages/share";
import { useMounted } from "@/customer/pages/useMounted";
import { StampLink } from "@/customer/pages/ui";
import { DeskPage, Pin, chrome as c } from "@/app/wall/chrome";
import { Canvas } from "@/app/wall/Canvas";
import { dealMissing } from "@/app/wall/placement";
import { flow } from "@/customer/flows/events";
import s from "./public.module.css";

export default function PublicWall({ token }: { token: string }) {
  const mounted = useMounted();
  // A short token is the account's public wall on the server; an old link carries the stubs themselves.
  const legacy = useMemo(() => (mounted ? decodeWall(token) : []), [mounted, token]);
  const [remote, setRemote] = useState<{ token: string; stubs: Stub[] | null; code?: string } | null>(null);
  useEffect(() => {
    if (!mounted || token.includes(".")) return;
    let live = true;
    api
      .publicWall(token)
      .then((r) => live && setRemote({ token, stubs: r.stubs }))
      .catch((e: ApiError) => live && setRemote({ token, stubs: null, code: e.status === 404 ? undefined : e.code }));
    return () => {
      live = false;
    };
  }, [mounted, token]);
  const asked = !token.includes(".");
  const settled = !asked || remote?.token === token;
  // each stub keeps the spot its owner gave it; a stub without one is dealt into the next free slot
  const stubs = useMemo(() => dealMissing(remote?.token === token && remote.stubs ? remote.stubs : legacy).stubs, [remote, token, legacy]);
  const cities = new Set(stubs.map((x) => x.event.city).filter(Boolean)).size;

  // The landing, once the link is read: whether it opened and how it was carried, never what is on it.
  const landed = useRef<string | null>(null);
  const ready = mounted && settled;
  useEffect(() => {
    if (!ready || landed.current === token) return;
    landed.current = token;
    const server = asked && remote?.token === token && !!remote.stubs;
    flow("share_landing", {
      surface: "public_wall",
      result: stubs.length ? "valid" : remote?.code ? "error" : asked ? "not_found" : "invalid",
      viewer: "visitor", // a public wall has no owner tools: everyone is a visitor here
      link_kind: server ? "server" : "encoded",
    });
  }, [ready, token, asked, remote, stubs.length]);

  if (!mounted || (stubs.length === 0 && !settled)) return <DeskPage>{null}</DeskPage>;
  if (stubs.length === 0) {
    return (
      <DeskPage>
        <div className={s.lost}>
          <h1 className={c.title}>We couldn&apos;t open this wall.</h1>
          <p className={s.lede}>{remote?.code ? messageFor(remote.code).message : "The link may be cut short. Ask for the link again, or make a wall of your own."}</p>
          {remote?.code ? (
            <PaperButton type="button" onClick={() => window.location.reload()}>
              Try again
            </PaperButton>
          ) : null}
          <StampLink href="/" onClick={() => flow("cta_select", { cta: "make_own", context: "public_wall" })}>
            Make your own wall
          </StampLink>
        </div>
      </DeskPage>
    );
  }

  return (
    <DeskPage>
      <div className={c.head}>
        <h1 className={c.title}>A TicketStub wall</h1>
        <p className={c.caption}>
          {stubs.length} {stubs.length === 1 ? "night" : "nights"}
          {cities > 0 ? ` · ${cities} ${cities === 1 ? "city" : "cities"}` : ""}
        </p>
      </div>
      <section className={s.board}>
        <Canvas
          label="A TicketStub wall. Drag the cork to move around, scroll to zoom. Plus and minus zoom, 0 fits, F is fullscreen."
          layoutKey={stubs.map((st) => st.id).join(",")}
          panOverStubs
        >
          {stubs.map((st, i) => (
            <div
              key={`${st.id}-${i}`}
              className={s.pinned}
              data-stub-area
              style={{ ["--x" as string]: `${st.wallX ?? 0}px`, ["--y" as string]: `${st.wallY ?? 0}px`, ["--angle" as string]: `${st.wallAngle ?? 0}deg`, ["--i" as string]: Math.min(i, 12) } as CSSProperties}
            >
              <Pin seed={`${st.id}-${i}`} />
              <Link
                href={memoryPath(st)}
                className={s.stubLink}
                onClick={() => flow("public_wall_select", { rank: i + 1 })}
                aria-label={`Open ${st.event.title}${st.event.dateISO ? `, ${formatDate(st.event.dateISO)}` : ""}`}>
                <StubView stub={st} size="sm" />
              </Link>
              <p className={s.label}>{st.event.title}</p>
            </div>
          ))}
        </Canvas>
      </section>
      <p className={s.note}>Only people with the link can see this.</p>
      <div className={s.cta}>
        <p className={s.ctaText}>Turn your ticket into a stub worth keeping.</p>
        <StampLink href="/" onClick={() => flow("cta_select", { cta: "make_own", context: "public_wall" })}>
          Make your own wall
        </StampLink>
      </div>
    </DeskPage>
  );
}
