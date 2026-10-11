"use client";
// The route tree: one description of where every page lives, read by the sidebar (which nests it) and by
// the breadcrumbs (which print the chain from the root to the page you are on). Stub titles come from the store.
import { useEffect, useState } from "react";
import { WALL_CHANGED, decodeStub, loadWall } from "@/customer/studio/store";

export interface StubRow {
  id: string;
  title: string;
}

export type IconKey = "make" | "wall" | "cart" | "organizer" | "account" | "admin";

export interface RouteNode {
  key: string;
  label: string;
  /** Share rows carry no href here: the sidebar resolves it from the stub when the row is drawn. */
  href: string;
  icon?: IconKey;
  children?: RouteNode[];
  /** The cart count, shown on the row. */
  count?: number;
  /** A small dot on the row's icon in the rail: something here wants a look (unsaved stubs on the Account row). */
  dot?: boolean;
  /** Never marked as the current page (an anchor inside a page, or a link that only looks like a destination). */
  anchor?: boolean;
  /** In the tree for the breadcrumbs, but not drawn in the sidebar (the cart lives in the top-right corner). */
  hidden?: boolean;
}

/** The stub's own places, in the order of the flow. */
const STUB_PLACES = [
  { seg: "studio", label: "Style", path: (id: string) => `/studio/${id}` },
  { seg: "checkout", label: "Print", path: (id: string) => `/checkout/${id}` },
  { seg: "wallet", label: "Wallet", path: (id: string) => `/wallet/${id}` },
  { seg: "friends", label: "Friends", path: (id: string) => `/friends/${id}` },
  { seg: "gift", label: "Gift", path: (id: string) => `/gift/${id}` },
] as const;

/** What kind of place a sidebar row is, for analytics: never a stub's id or title. */
export type NavItem = "make" | "search" | "printing" | "wall" | "all_stubs" | "stub" | "studio" | "checkout" | "wallet" | "friends" | "gift" | "share_page" | "claim" | "public_wall" | "cart" | "unclaimed" | "organizer" | "guest_claims" | "account" | "orders" | "help" | "privacy" | "terms" | "admin" | "other";
const NAV_ITEMS: Record<string, NavItem> = {
  make: "make", search: "search", new: "printing", wall: "wall", all: "all_stubs", claim: "claim", public: "public_wall", share: "share_page",
  cart: "cart", unclaimed: "unclaimed", organizer: "organizer", guests: "guest_claims", account: "account", orders: "orders",
  help: "help", privacy: "privacy", terms: "terms", admin: "admin", stub: "stub",
  studio: "studio", checkout: "checkout", wallet: "wallet", friends: "friends", gift: "gift",
};
export function navItem(key: string): NavItem {
  const kind = key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
  if (kind === "share" && key.includes(":")) return "share_page";
  return Object.hasOwn(NAV_ITEMS, kind) ? NAV_ITEMS[kind] : "other";
}

/** Routes that sit on a route with no nav at all. */
export const NAV_FREE = ["/", "/parts"];

/** The most recent stubs the Wall group lists before "All stubs". */
export const WALL_LIST = 4;

/** Where the path sits: the keys from the root down to the page. Empty for a route we don't know. */
export function locate(path: string, stubs: StubRow[], shareStubId?: string): string[] {
  const seg = path.split("/").filter(Boolean);
  const id = seg[1] ? decodeURIComponent(seg[1]) : "";
  switch (seg[0]) {
    case "make":
      return ["make"];
    case "search":
      return ["make", "search"];
    case "new":
      return ["make", "new"];
    case "studio":
    case "checkout":
    case "wallet":
    case "friends":
    case "gift":
      return id ? ["wall", `stub:${id}`, `${seg[0]}:${id}`] : ["wall"];
    case "s":
      return shareStubId ? ["wall", `stub:${shareStubId}`, `share:${shareStubId}`] : ["wall", "share"];
    case "claim":
      return ["wall", "claim"];
    case "u":
      return ["wall", "public"];
    case "wall":
      return ["wall"];
    case "cart":
      return seg[1] === "unclaimed" ? ["cart", "unclaimed"] : ["cart"];
    case "map":
    case "help":
      return ["account", "help"];
    case "organizer":
      return seg[1] === "claim" ? ["organizer", "guests"] : ["organizer"];
    case "account":
      return ["account"];
    case "admin":
      return ["admin"];
    case "privacy":
    case "terms":
      return ["account", seg[0]];
    default:
      void stubs;
      return [];
  }
}

export interface TreeInput {
  keys: string[];
  stubs: StubRow[];
  cartCount: number;
  /** The current path: places that exist only while you're there link to themselves. */
  path: string;
  /** Signed out with stubs that live only on this device: the Account row carries a dot. */
  unsaved?: boolean;
  /** The server says this account is staff: the Admin row shows. Cosmetic; /admin checks on the server. */
  staff?: boolean;
}

/** The whole tree for this moment. Places that exist only while you're there (a claim, the printing stage) appear only then. */
export function buildTree({ keys, stubs, cartCount, path, unsaved, staff }: TreeInput): RouteNode[] {
  const has = (k: string) => keys.includes(k);
  const currentStub = keys.find((k) => k.startsWith("stub:"))?.slice(5);

  const stubNode = (id: string, title: string): RouteNode => ({
    key: `stub:${id}`,
    label: title,
    href: `/studio/${id}`,
    children: [
      ...STUB_PLACES.map((p) => ({ key: `${p.seg}:${id}`, label: p.label, href: p.path(id) })),
      { key: `share:${id}`, label: "Share page", href: "" },
    ],
  });

  const shown = stubs.slice(0, WALL_LIST);
  const rows = [...shown];
  if (currentStub && !shown.some((s) => s.id === currentStub)) {
    rows.push(stubs.find((s) => s.id === currentStub) ?? { id: currentStub, title: "Your stub" });
  }

  const wallKids: RouteNode[] = rows.map((s) => stubNode(s.id, s.title));
  if (stubs.length > 0) wallKids.push({ key: "all", label: stubs.length > WALL_LIST ? `All stubs (${stubs.length})` : "All stubs", href: "/wall", anchor: true });
  if (has("claim")) wallKids.push({ key: "claim", label: "Claim", href: path });
  if (has("public")) wallKids.push({ key: "public", label: "Public wall", href: path });
  if (has("share")) wallKids.push({ key: "share", label: "Share page", href: path });

  const makeKids: RouteNode[] = [{ key: "search", label: "Search for your show", href: "/search" }];
  if (has("new")) makeKids.push({ key: "new", label: "Printing", href: path });

  const cartKids: RouteNode[] = has("unclaimed") ? [{ key: "unclaimed", label: "Unclaimed seat", href: path }] : [];
  const orgKids: RouteNode[] = [{ key: "guests", label: "Guest claims", href: "/organizer/claim" }];
  const acctKids: RouteNode[] = [
    ...(has("account") ? [{ key: "orders", label: "Orders", href: "/account#acct-orders", anchor: true }] : []),
    { key: "help", label: "Help", href: "/help" },
    { key: "privacy", label: "Privacy", href: "/privacy" },
    { key: "terms", label: "Terms", href: "/terms" },
  ];

  return [
    { key: "make", label: "Make", href: "/make", icon: "make", children: makeKids },
    { key: "wall", label: "Wall", href: "/wall", icon: "wall", children: wallKids },
    { key: "cart", label: "Cart", href: "/cart", icon: "cart", count: cartCount, hidden: true, children: cartKids },
    { key: "organizer", label: "Organizer", href: "/organizer", icon: "organizer", children: orgKids },
    { key: "account", label: "Account", href: "/account", icon: "account", dot: unsaved, children: acctKids },
    ...(staff ? [{ key: "admin", label: "Admin", href: "/admin", icon: "admin" as const }] : []),
  ];
}

/** Find a node by walking the keys down from the roots. Sibling keys can repeat across groups (claim), so it follows the chain. */
export function chainOf(tree: RouteNode[], keys: string[]): RouteNode[] {
  const out: RouteNode[] = [];
  let level: RouteNode[] | undefined = tree;
  for (const k of keys) {
    const node: RouteNode | undefined = level?.find((n) => n.key === k);
    if (!node) break;
    out.push(node);
    level = node.children;
  }
  return out;
}

/** The wall's stubs, newest first, with only what the nav needs. Reloads on a wall change, a focus, and a route change. */
export function useStubRows(path: string): StubRow[] {
  const [rows, setRows] = useState<StubRow[]>([]);
  useEffect(() => {
    const read = () => {
      const next = loadWall().map((s) => ({ id: s.id, title: s.event.title || "Untitled stub" }));
      setRows((prev) => (prev.length === next.length && prev.every((r, i) => r.id === next[i].id && r.title === next[i].title) ? prev : next));
    };
    read();
    window.addEventListener(WALL_CHANGED, read);
    window.addEventListener("storage", read);
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener(WALL_CHANGED, read);
      window.removeEventListener("storage", read);
      window.removeEventListener("focus", read);
    };
  }, [path]);
  return rows;
}

/** Where the current path sits, with the stubs it needs. A /s/ link that carries one of your own stubs nests under it. */
export function useLocation(path: string): { keys: string[]; stubs: StubRow[] } {
  const stubs = useStubRows(path);
  let shareId: string | undefined;
  if (path.startsWith("/s/")) {
    const id = decodeStub(decodeURIComponent(path.slice(3)))?.id;
    if (id && stubs.some((s) => s.id === id)) shareId = id;
  }
  return { keys: locate(path, stubs, shareId), stubs };
}
