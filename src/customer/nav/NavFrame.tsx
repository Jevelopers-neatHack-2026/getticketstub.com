"use client";
// One frame for every screen but the landing page and the parts board: a paper sidebar that is always
// there. On the desktop it is open or folded to a rail; on the phone it is a thin rail, and » opens the
// same sidebar over the content as a drawer. Every route is in it, nested by parent (see routes.ts).
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { LiveRegion } from "@/customer/a11y/announce";
import a11y from "@/customer/a11y/a11y.module.css";
import { SoundIcon } from "@/customer/desk/icons";
import { AccountLine } from "@/customer/account/AccountLine";
import { AccountRoot } from "@/customer/account/AccountRoot";
import { useAccount } from "@/customer/account/useAccount";
import { sharePath } from "@/customer/account/share";
import { CartCorner } from "@/customer/cart/CartCorner";
import { memoryPath } from "@/customer/pages/share";
import { getStub } from "@/customer/studio/store";
import { play, useMuted } from "@/customer/studio/feedback";
import { AccountIcon, AdminIcon, CartIcon, ChevronIcon, HandleIcon, MakeIcon, OrganizerIcon, WallIcon } from "./icons";
import { useDesktop, useNavOpen } from "./navState";
import { useStaff } from "./useStaff";
import { NAV_FREE, buildTree, chainOf, navItem, useLocation, type IconKey, type RouteNode } from "./routes";
import { flow } from "@/customer/flows/events";
import f from "./NavFrame.module.css";

const ICONS: Record<IconKey, ComponentType> = {
  make: MakeIcon,
  wall: WallIcon,
  cart: CartIcon,
  organizer: OrganizerIcon,
  account: AccountIcon,
  admin: AdminIcon,
};

/** The widths the CSS gives the sidebar (open, folded, the phone's rail); --nav-w on <html> follows them. */
const WIDTHS = { open: 244, rail: 68, phone: 56 };

/** The depth-first order of the visible-or-not tree: the direction a navigation sounds in. */
function order(nodes: RouteNode[], out: RouteNode[] = []): RouteNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children) order(n.children, out);
  }
  return out;
}

export function NavFrame({ children, notice }: { children: ReactNode; notice?: ReactNode }) {
  const path = usePathname() ?? "/";
  const router = useRouter();
  const show = !NAV_FREE.includes(path);
  const inStudio = path.startsWith("/studio");
  const desktop = useDesktop();
  const [open, toggleOpen] = useNavOpen(inStudio);
  const [muted, setMuted] = useMuted();
  const { keys, stubs } = useLocation(path);
  // The drawer belongs to the route it was opened on, so any navigation closes it.
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const drawer = drawerPath === path;
  const full = desktop ? open : drawer;
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const navRef = useRef<HTMLElement>(null);

  // Groups open for the route you're on; the chevron overrides by hand until you go somewhere new inside them.
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const [manualPath, setManualPath] = useState(path);
  if (manualPath !== path) {
    setManualPath(path);
    setManual((m) => {
      const next = { ...m };
      keys.forEach((k) => delete next[k]);
      return next;
    });
  }
  const isOpen = (key: string) => manual[key] ?? keys.includes(key);

  // The rail's flyout: the children of a folded group, on hover or focus.
  const [fly, setFly] = useState<{ key: string; top: number } | null>(null);
  const flyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeDrawer = () => {
    if (!drawer) return;
    setDrawerPath(null);
    play("close", { emphasis: "subtle" });
  };

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerPath(null);
        play("close", { emphasis: "subtle" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // --nav-w on <html>: how much of the left edge the nav takes, so full-screen stages start at its right edge.
  useEffect(() => {
    const w = !show ? 0 : desktop ? (open ? WIDTHS.open : WIDTHS.rail) : WIDTHS.phone;
    document.documentElement.style.setProperty("--nav-w", `${w}px`);
  }, [show, desktop, open]);

  // --corner-reserve on <html>: how much of the top-right corner the cart button takes (its width, its inset
  // and a gap), so a header's right-side content never sits under it. 0 where there is no button.
  useEffect(() => {
    document.documentElement.style.setProperty("--corner-reserve", show ? "calc(72px + 12px + 12px + env(safe-area-inset-right, 0px))" : "0px");
  }, [show]);

  const { status: accountStatus, savingOff } = useAccount();
  const unsaved = accountStatus === "out" && !savingOff && stubs.length > 0;
  const staff = useStaff();
  const tree = useMemo(() => buildTree({ keys, stubs, cartCount: 0, path, unsaved, staff }), [keys, stubs, path, unsaved, staff]);
  const chain = useMemo(() => chainOf(tree, keys), [tree, keys]);
  const current = chain[chain.length - 1];
  const trail = new Set(chain.slice(0, -1));
  const flat = useMemo(() => order(tree), [tree]);

  const hrefOf = (n: RouteNode): string => {
    if (!n.key.startsWith("share:")) return n.href;
    const stub = getStub(n.key.slice(6));
    return stub ? memoryPath(stub) : "/wall";
  };

  const select = (n: RouteNode) => {
    const from = current ? flat.indexOf(current) : -1;
    play("select", { emphasis: "subtle", direction: flat.indexOf(n) >= from ? "forward" : "back" });
    if (drawer) setDrawerPath(null);
  };

  const rowKey = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape") return setFly(null);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = [...(navRef.current?.querySelectorAll<HTMLElement>("[data-row-link]") ?? [])].filter((el) => el.offsetParent !== null);
      const i = rows.indexOf(t);
      if (i < 0) return;
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const chev = t.closest("[data-row]")?.querySelector<HTMLButtonElement>("button[data-chev]");
      if (!chev) return;
      const expanded = chev.getAttribute("aria-expanded") === "true";
      if ((e.key === "ArrowRight") !== expanded) {
        e.preventDefault();
        chev.click();
      }
    }
  };

  const openFly = (key: string, el: HTMLElement) => {
    if (full) return;
    if (flyTimer.current) clearTimeout(flyTimer.current);
    setFly({ key, top: Math.min(el.getBoundingClientRect().top, window.innerHeight - 80) });
  };
  const closeFly = () => {
    if (flyTimer.current) clearTimeout(flyTimer.current);
    flyTimer.current = setTimeout(() => setFly(null), 120);
  };

  const linkFor = (n: RouteNode, depth: number, withIcon: boolean) => {
    const Icon = n.icon ? ICONS[n.icon] : null;
    const href = hrefOf(n);
    const here = n === current;
    return (
      <Link
        href={href}
        className={f.item}
        data-depth={depth}
        data-row-link
        data-trail={trail.has(n) ? "true" : undefined}
        aria-current={here ? "page" : undefined}
        title={full ? undefined : n.dot ? `${n.label}: save your wall` : n.label}
        onClick={(e) => {
          // the kind of place, and whether this device already has a wall (a returning visitor), never which stub
          flow("nav_select", { item: navItem(n.key), has_stubs: stubs.length > 0 });
          select(n);
          if (n.key.startsWith("share:") && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
            // A server token is shorter and prettier than the encoded stub; use it when there is one.
            const stub = getStub(n.key.slice(6));
            if (stub) {
              e.preventDefault();
              void sharePath(stub).then((p) => router.push(p));
            }
          }
          setFly(null);
        }}
      >
        {withIcon && Icon ? (
          <span className={f.icon}>
            <Icon />
            {n.count || n.dot ? <span className={f.dot} aria-hidden /> : null}
          </span>
        ) : null}
        <span className={f.label}>{n.label}</span>
        {n.count ? (
          <span className={f.count} aria-label={`${n.count} in your cart`}>
            {n.count}
          </span>
        ) : null}
      </Link>
    );
  };

  /** The nested tree, drawn when the sidebar is open. */
  const nodeBody = (n: RouteNode, depth: number) => {
    const kids = n.children ?? [];
    const expandable = kids.length > 0;
    const expanded = expandable && isOpen(n.key);
    return (
      <>
        <div className={f.row} data-row data-kid={depth > 0 ? "true" : undefined}>
          {linkFor(n, depth, depth === 0)}
          {expandable ? (
            <button
              type="button"
              data-chev
              className={f.chev}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Fold" : "Open"} ${n.label}`}
              onClick={() => {
                setManual((m) => ({ ...m, [n.key]: !expanded }));
                play("toggle", { emphasis: "subtle", direction: expanded ? "back" : "forward" });
              }}
            >
              <ChevronIcon />
            </button>
          ) : null}
        </div>
        {expanded ? <ul className={f.kids}>{kids.map((k) => renderNode(k, depth + 1))}</ul> : null}
      </>
    );
  };
  const renderNode = (n: RouteNode, depth: number) => (
    <li key={n.key} className={f.node}>
      {nodeBody(n, depth)}
    </li>
  );

  /** The flyout card: a folded group's places, flattened, with the rail's hover and focus. */
  const flyRows = (n: RouteNode, depth = 1): ReactNode[] =>
    (n.children ?? []).flatMap((k) => [
      <li key={k.key} className={f.flyRow}>
        {linkFor(k, depth, false)}
      </li>,
      ...(k.children && isOpen(k.key) ? flyRows(k, depth + 1) : []),
    ]);

  // The skip link moves focus to the content, and the next Tab starts inside it (a plain #hash jump would not).
  const skipToContent = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById("content");
    if (!target) return;
    e.preventDefault();
    target.focus({ preventScroll: false });
  };

  const places = tree.filter((n) => !n.hidden);
  const rule = places.findIndex((n) => n.key === "organizer");

  return (
    <div className={f.frame} data-nav={show ? "on" : "off"} data-full={show ? full : undefined} data-drawer={drawer}>
      <a href="#content" className={a11y.skip} onClick={skipToContent}>
        Skip to content
      </a>
      {show ? (
        <>
          <button type="button" className={f.scrim} aria-label="Close menu" tabIndex={-1} onClick={closeDrawer} />
          <aside
            className={f.side}
            aria-label="TicketStub"
            onKeyDown={rowKey}
            onPointerDown={(e) => {
              swipe.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerMove={(e) => {
              const s = swipe.current;
              if (!s || !drawer) return;
              if (e.clientX - s.x < -56 && Math.abs(e.clientY - s.y) < 40) {
                swipe.current = null;
                closeDrawer();
              }
            }}
            onPointerUp={() => (swipe.current = null)}
            onPointerCancel={() => (swipe.current = null)}
          >
            <div className={f.head}>
              <Link href="/" className={f.mark} aria-label="TicketStub home" onClick={() => play("select", { emphasis: "subtle", direction: "back" })}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={f.wordmark} src="/brand/wordmark.svg" alt="" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={f.stampMark} src="/brand/ts-stamp.svg" alt="" />
              </Link>
              <button
                type="button"
                className={f.handle}
                aria-label={full ? (desktop ? "Fold the sidebar to a rail" : "Close the menu") : desktop ? "Open the sidebar" : "Open the menu"}
                title={full ? (desktop ? "Fold to a rail" : "Close the menu") : desktop ? "Open the sidebar" : "Open the menu"}
                aria-expanded={full}
                onClick={() => {
                  if (desktop) {
                    play("toggle", { emphasis: "subtle", direction: open ? "back" : "forward" });
                    toggleOpen();
                  } else if (drawer) closeDrawer();
                  else {
                    setDrawerPath(path);
                    play("open", { emphasis: "subtle" });
                  }
                }}
              >
                <HandleIcon open={full} />
              </button>
            </div>
            <nav className={f.list} ref={navRef} aria-label="Places">
              <ul className={f.tree}>
                {places.map((n, i) => {
                  const hasFly = !full && !!n.children?.length;
                  return (
                    <Fragment key={n.key}>
                      {i === rule ? <li className={f.rule} role="presentation" aria-hidden="true" /> : null}
                    <li
                      className={f.top}
                      onPointerEnter={(e) => {
                        if (e.pointerType === "mouse" && hasFly) openFly(n.key, e.currentTarget);
                      }}
                      onPointerLeave={(e) => e.pointerType === "mouse" && closeFly()}
                      onFocus={(e) => hasFly && openFly(n.key, e.currentTarget)}
                      onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeFly();
                      }}
                    >
                      {full ? (
                        nodeBody(n, 0)
                      ) : (
                        <>
                          <div className={f.row} data-row>
                            {linkFor(n, 0, true)}
                          </div>
                          {hasFly && fly?.key === n.key ? (
                            <div className={f.fly} style={{ top: fly.top }} role="group" aria-label={n.label}>
                              <p className={f.flyHead}>{n.label}</p>
                              <ul>{flyRows(n)}</ul>
                            </div>
                          ) : null}
                        </>
                      )}
                    </li>
                    </Fragment>
                  );
                })}
              </ul>
            </nav>
            <div className={f.foot}>
              {full ? <AccountLine /> : null}
              <button
                type="button"
                className={f.item}
                title={full ? undefined : muted ? "Sound is off. Press to turn it on" : "Sound is on. Press to turn it off"}
                aria-label={muted ? "Sound off. Press to turn it on" : "Sound on. Press to turn it off"}
                onClick={() => {
                  setMuted(!muted);
                  if (muted) play("toggle", { emphasis: "subtle", direction: "forward" });
                }}
              >
                <span className={f.icon}>
                  <SoundIcon muted={muted} />
                </span>
                <span className={f.label}>{muted ? "Sound off" : "Sound on"}</span>
              </button>
            </div>
          </aside>
        </>
      ) : null}

      {/* The cart sits top right but comes right after the sidebar in Tab order, before the page it belongs to. */}
      {show ? <CartCorner /> : null}

      <div className={f.content} id="content" tabIndex={-1} inert={!desktop && drawer}>
        {notice}
        {children}
      </div>
      <AccountRoot />
      <LiveRegion />
    </div>
  );
}
