"use client";
import Link from "next/link";
import { useId, useState, type ComponentProps, type JSX, type ReactNode } from "react";
import d from "@/customer/desk/Desk.module.css";
import { PaperButton, Stamped } from "@/customer/desk/Desk";
import { Breadcrumbs, useCrumbs } from "@/customer/nav/Breadcrumbs";
import { play, haptic, type Cue } from "@/customer/studio/feedback";
import { SANDBOX_LABEL } from "./commerce";
import { absoluteUrl, copyLink } from "./share";
import type { ShareContent, ShareContext } from "./share";
import s from "./ui.module.css";

export { s as ui };

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

function BackArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.5 6 8.5 12l6 6" />
    </svg>
  );
}

/** The small → that marks a control which leaves the screen. Drawn at the icons' weight; never decoration. */
export function LeavesMark(): JSX.Element {
  return (
    <svg className={s.leaves} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h13M13 6.5 18.5 12 13 17.5" />
    </svg>
  );
}

export function PageShell({
  title,
  back: backProp,
  right,
  narrow,
  children,
  className,
}: {
  title?: string;
  back?: { href: string; label: string };
  right?: ReactNode;
  narrow?: boolean;
  children: ReactNode;
  className?: string;
}) {
  // A child route shows its breadcrumbs; `back` stays as the fallback for a route the tree doesn't know.
  let back = backProp;
  const known = useCrumbs().length;
  const crumbs = known > 1;
  if (known > 0) back = undefined; // the tree knows this route: no back link needed
  return (
    <div className={cx("desk-surface", s.shell, className)} data-theme="light">
      <header className={cx(s.top, !crumbs && !back && !title && !right && s.logoOnly)} style={{ paddingRight: "max(16px, var(--corner-reserve, 0px))" }}>
        {crumbs ? (
          <Breadcrumbs />
        ) : back ? (
          <Link className={s.back} href={back.href}>
            <BackArrow />
            <span className={s.backText}>{back.label}</span>
          </Link>
        ) : (
          <Link className={s.home} href="/" aria-label="TicketStub home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/lockup-horizontal.svg" alt="TicketStub" />
          </Link>
        )}
        {title && !crumbs ? <span className={s.topTitle}>{title}</span> : null}
        {right ? <div className={s.topRight}>{right}</div> : null}
      </header>
      <main className={cx(s.main, narrow && s.narrow)}>{children}</main>
    </div>
  );
}

/** Pointer-following pressed state for link-shaped desk buttons (the desk parts are <button> only). A caller's onClick still runs. */
function useLinkPress(cue: Cue, buzz: number, onClick?: React.MouseEventHandler<HTMLAnchorElement>) {
  const [pressed, setPressed] = useState(false);
  return {
    "data-pressed": pressed,
    onPointerDown: () => setPressed(true),
    onPointerUp: () => setPressed(false),
    onPointerLeave: () => setPressed(false),
    onPointerCancel: () => setPressed(false),
    onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      play(cue, cue === "tap" ? { emphasis: "subtle" } : undefined);
      haptic(buzz);
    },
  };
}

type LinkProps = Omit<ComponentProps<typeof Link>, "className"> & {
  block?: boolean;
  className?: string;
  /** Set when the link acts in place (a hash or the same page): drops the leaves-the-screen → mark. */
  noMark?: boolean;
};

/** The one main action, when it goes to another page. Looks and sounds exactly like Stamp. */
export function StampLink({ children, price, block, className, noMark, onClick, ...rest }: LinkProps & { price?: string }) {
  const press = useLinkPress("stamp", 12, onClick);
  return (
    <Link {...rest} {...press} className={cx(d.stamp, block && d.block, s.linkReset, className)}>
      <span className={d.stampLabel}>
        {children}
        {noMark ? null : <LeavesMark />}
      </span>
      {price ? <span className={d.stampStub}>{price}</span> : null}
    </Link>
  );
}

/** Secondary action to another page: card stock, same as PaperButton. */
export function PaperLink({ children, block, className, noMark, onClick, ...rest }: LinkProps) {
  const press = useLinkPress("tap", 6, onClick);
  return (
    <Link {...rest} {...press} className={cx(d.paper, block && d.block, s.linkReset, className)}>
      {children}
      {noMark ? null : <LeavesMark />}
    </Link>
  );
}

/** Tertiary link: plain text on a dotted tear line. */
export function TearAnchor({ children, className, noMark, onClick, ...rest }: LinkProps) {
  return (
    <Link
      {...rest}
      className={cx(d.tearLink, s.linkReset, s.anchorMark, className)}
      onClick={(e) => {
        onClick?.(e);
        play("tap", { emphasis: "subtle" });
      }}
    >
      {children}
      {noMark ? null : <LeavesMark />}
    </Link>
  );
}

/** Quiet sandbox note for screens that already carry a SandboxStrip elsewhere (header only). */
export function SandboxBadge({ text = SANDBOX_LABEL }: { text?: string }) {
  return (
    <span className={s.sandbox} role="note">
      {text}
    </span>
  );
}

/** Read-only link with a copy button. `path` is site-relative; the absolute URL is shown and copied. `context` and `content` name the copy for analytics (never the link). */
export function CopyField({
  path,
  label = "Link",
  context,
  content,
}: {
  path: string;
  label?: string;
  context: ShareContext;
  content: ShareContent;
}) {
  const id = useId();
  const [status, setStatus] = useState<"" | "copied" | "failed">("");
  const [stampKey, setStampKey] = useState(0);
  const url = absoluteUrl(path);
  return (
    <div className={s.stack} style={{ gap: 6 }}>
      <div className={s.copy}>
        <div className={s.copyField}>
          <label htmlFor={id} className="desk-label">
            {label}
          </label>
          <input id={id} className={s.copyInput} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        </div>
        <PaperButton
          type="button"
          onClick={async () => {
            const ok = await copyLink(url, context, content);
            setStatus(ok ? "copied" : "failed");
            setStampKey((k) => k + 1);
          }}
        >
          Copy link
        </PaperButton>
      </div>
      <div className={s.status} data-announce>
        {status === "copied" ? <Stamped key={stampKey}>Copied</Stamped> : status === "failed" ? "Couldn't copy. Select the link and copy it." : ""}
      </div>
    </div>
  );
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** QR-like placeholder (no QR library): deterministic modules plus three finder squares. Not scannable. */
export function QrPlaceholder({ value, caption, size = 25 }: { value: string; caption?: string; size?: number }) {
  let seed = hash(value) || 1;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const inFinder = (x: number, y: number) => (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);
  const cells: ReactNode[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const r = rand();
      if (!inFinder(x, y) && r > 0.52) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />);
    }
  const finder = (x: number, y: number) => (
    <g key={`f${x}${y}`}>
      <rect x={x} y={y} width={7} height={7} />
      <rect x={x + 1} y={y + 1} width={5} height={5} fill="var(--desk-paper-raised)" />
      <rect x={x + 2} y={y + 2} width={3} height={3} />
    </g>
  );
  return (
    <figure className={s.qrWrap} style={{ margin: 0 }}>
      <svg className={s.qr} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={caption ?? "QR code placeholder"} shapeRendering="crispEdges" fill="#17140F">
        {cells}
        {finder(0, 0)}
        {finder(size - 7, 0)}
        {finder(0, size - 7)}
      </svg>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export type EmptyKind = "cart" | "stub" | "seat" | "set";

/** Small drawn illustrations in the desk's line language: a stub, a tray, a chair, a row of stubs. */
export function EmptyArt({ kind }: { kind: EmptyKind }) {
  const common = { viewBox: "0 0 140 112", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: s.emptyArt };
  if (kind === "cart")
    return (
      <svg {...common}>
        <path className={s.draw} d="M14 60h112l-10 38a4 4 0 0 1-4 3H28a4 4 0 0 1-4-3Z" />
        <path d="M14 60 22 44h96l8 16" />
        <g transform="rotate(-7 70 40)">
          <rect x="52" y="8" width="36" height="52" rx="2" style={{ fill: "var(--desk-paper-raised)" }} />
          <path d="M52 40h36" strokeDasharray="1.5 3.5" />
          <path stroke="var(--desk-stamp)" d="M60 20h20M60 27h12" />
        </g>
        <path d="M14 60h112" />
      </svg>
    );
  if (kind === "seat")
    return (
      <svg {...common}>
        <path d="M44 20h52a6 6 0 0 1 6 6v34H38V26a6 6 0 0 1 6-6Z" style={{ fill: "var(--desk-paper-raised)" }} />
        <path d="M32 60h76v16a6 6 0 0 1-6 6H38a6 6 0 0 1-6-6Z" style={{ fill: "var(--desk-paper-raised)" }} />
        <path d="M44 82v16M96 82v16" />
        <path d="M54 40h32" strokeDasharray="1.5 3.5" stroke="var(--desk-stamp)" />
      </svg>
    );
  if (kind === "set")
    return (
      <svg {...common}>
        <g transform="rotate(-10 40 60)">
          <rect x="22" y="22" width="40" height="62" rx="2" style={{ fill: "var(--desk-paper-raised)" }} />
          <path d="M22 62h40" strokeDasharray="1.5 3.5" />
        </g>
        <g transform="rotate(4 80 56)">
          <rect x="58" y="18" width="40" height="62" rx="2" style={{ fill: "var(--desk-paper-raised)" }} />
          <path d="M58 58h40" strokeDasharray="1.5 3.5" />
        </g>
        <g transform="rotate(14 112 60)">
          <rect x="92" y="24" width="40" height="62" rx="2" strokeDasharray="4 4" />
        </g>
        <path d="M104 96h24" stroke="var(--desk-stamp)" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="40" y="10" width="60" height="92" rx="3" strokeDasharray="5 5" />
      <path d="M40 72h60" strokeDasharray="1.5 3.5" />
      <path d="M62 36l16 16M78 36 62 52" stroke="var(--desk-stamp)" />
    </svg>
  );
}

/** An empty or missing state that says what is missing, what to do, and carries a small drawing. */
export function EmptyState({ kind, title, body, children }: { kind: EmptyKind; title: string; body: string; children?: ReactNode }) {
  return (
    <div className={cx(s.empty, s.enter)}>
      <EmptyArt kind={kind} />
      <h1 className={s.h2}>{title}</h1>
      <p className={s.muted}>{body}</p>
      {children ? <div className={s.emptyActions}>{children}</div> : null}
    </div>
  );
}

export function FriendlyError({ title, body }: { title: string; body: string }) {
  return (
    <EmptyState kind="stub" title={title} body={body}>
      <StampLink href="/make">Make your own stub</StampLink>
    </EmptyState>
  );
}

/** Stub on the paper desk with a contact shadow, so it reads as an object resting there. */
export function OnDesk({ children }: { children: ReactNode }) {
  return <div className={s.deskStub}>{children}</div>;
}
