"use client";
// App-owned unavailable shell, not the team-dashboard package. It exercises the
// route/display boundary while supported-runtime and Finance consumer inputs remain pending.
import Link from "next/link";
import type { AdminHostBridge, AdminMountProps } from "../contract";

export const FIXTURE_REVISION = "admin-fixture/1";

export function FixtureMount({ context, nav, path, host }: AdminMountProps & { host: AdminHostBridge }) {
  const { summary } = context;
  const selectedHref = (href: string) => summary.projectRef ? `${href}?project=${encodeURIComponent(summary.projectRef)}` : href;
  const crumbs = [{ label: nav.root.label, href: nav.root.href }, ...path.map((seg, i) => ({ label: seg, href: `${nav.base}/${path.slice(0, i + 1).join("/")}` }))];
  return (
    <div data-admin-fixture={FIXTURE_REVISION} data-admin-host="trusted-context/1" data-admin-path={path.join("/")} data-admin-root={nav.root.label}>
      <ol data-admin-crumbs aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <li key={c.href}>
            {i > 0 ? <span aria-hidden>› </span> : null}
            {i === crumbs.length - 1 ? <span aria-current="page">{c.label}</span> : <Link href={selectedHref(c.href)}>{c.label}</Link>}
          </li>
        ))}
      </ol>
      <h1>Admin</h1>
      <p style={{ margin: "var(--ts-space-2) 0 var(--ts-space-4)", color: "var(--admin-ink-soft)" }}>
        Dashboard reporting is not available yet. Your current account and selected project are checked on the server.
      </p>
      <p role="status" data-finance-state={context.finance}>
        {context.finance === "restricted" ? "This project does not grant access to financial reports." : "Financial reports are unavailable. No reporting data has been loaded."}
      </p>
      <section data-admin-card aria-label="Context">
        <dl>
          <dt>Path</dt>
          <dd>
            {nav.base}/{path.join("/")}
          </dd>
          <dt>Actor</dt>
          <dd>
            {summary.actorKind}, role {summary.role}
          </dd>
          <dt>Tenant</dt>
          <dd>{summary.tenantId}</dd>
          <dt>Environment</dt>
          <dd>
            {summary.environment}, economy {summary.economicMode}, evidence {summary.evidenceMode}
          </dd>
          <dt>Project</dt>
          <dd>{summary.projectRef ?? "Platform"}</dd>
          <dt>Capabilities</dt>
          <dd>{summary.capabilities.join(", ") || "none"}</dd>
          <dt>Context</dt>
          <dd>
            {summary.schema}, {summary.verified ? "verified by the server" : "NOT verified"}, expires {summary.expiresAt}
          </dd>
        </dl>
      </section>
      <nav aria-label="Admin" style={{ marginTop: "var(--ts-space-4)", display: "flex", gap: "var(--ts-space-4)", flexWrap: "wrap" }}>
        {nav.items.map((item) => (
          <Link key={item.href} href={selectedHref(item.href)}>
            {item.label}
          </Link>
        ))}
        <button type="button" onClick={() => host.navigate(`${nav.base}/fixture/client-navigation`)}>
          Client navigation
        </button>
      </nav>
    </div>
  );
}
