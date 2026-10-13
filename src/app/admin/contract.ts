// App-owned display projection only. This is not the team-dashboard package's
// HostSessionVerifier or Finance interface. No serialized field is authority.

/** Bump when a field is removed or changes meaning; adding an optional field is not a bump. */
export const ADMIN_MOUNT_CONTRACT = "ticketstub.admin-mount/2";

/** Where the host owns the URL space. The dashboard routes live below it and never above it. */
export const ADMIN_BASE_PATH = "/admin";

export interface AdminNavItem {
  label: string;
  /** Absolute path under the base path. */
  href: string;
}

/** What the host injects so the dashboard prints our navigation, not its own shell. */
export interface AdminNavInjection {
  base: typeof ADMIN_BASE_PATH;
  /** The first crumb of every dashboard page. */
  root: { label: "Admin"; href: typeof ADMIN_BASE_PATH };
  /** Host-owned entries for the dashboard's local menu; the dashboard adds its own routes beneath. */
  items: AdminNavItem[];
}

/** The server's current, minimal display projection. Credentials stay server-only. */
export interface AdminContextSummary {
  schema: string;
  actorKind: "account";
  role: string;
  tenantId: string;
  environment: "development" | "preview" | "live";
  economicMode: "none" | "sandbox" | "paid_test" | "live";
  evidenceMode: "fixture" | "synthetic" | "live";
  projectRef: string | null;
  revision: string;
  capabilities: readonly string[];
  expiresAt: string;
  /** The server verified its own token before rendering. */
  verified: boolean;
}

export interface AdminContextInjection {
  summary: AdminContextSummary;
  finance: "restricted" | "unavailable";
  mount: "runtime-pending";
}

export interface AdminMountProps {
  context: AdminContextInjection;
  nav: AdminNavInjection;
  /** The path below the base: `/admin/x/y` is ["x", "y"], `/admin` is []. */
  path: string[];
}

/** What the mount gets from the host at run time (functions cannot cross the server boundary). */
export interface AdminHostBridge {
  /** Client-side navigation to an absolute path under the base path. */
  navigate: (href: string) => void;
}
