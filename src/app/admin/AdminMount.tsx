"use client";
// The one place the dashboard renders into. The server page decides who may be here; this component only
// receives a display projection. Actual team-dashboard adoption requires its own
// accepted runtime and host interface; this fixture is not that package's mount.
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { AdminHostBridge, AdminMountProps } from "./contract";
import { FixtureMount } from "./fixture/FixtureMount";

export function AdminMount(props: AdminMountProps) {
  const router = useRouter();
  const host = useMemo<AdminHostBridge>(
    () => ({
      navigate: (href) => {
        // Only paths below the base: a mount can't send the browser anywhere else through us.
        if (href === props.nav.base || href.startsWith(`${props.nav.base}/`)) {
          const url = new URL(href, window.location.origin);
          if (url.origin !== window.location.origin || !(url.pathname === props.nav.base || url.pathname.startsWith(`${props.nav.base}/`))) return;
          // Carry only the validated selected project, never browser-supplied authority.
          if (props.context.summary.projectRef) url.searchParams.set("project", props.context.summary.projectRef);
          router.push(`${url.pathname}${url.search}`);
        }
      },
    }),
    [router, props.nav.base, props.context.summary.projectRef],
  );
  return <FixtureMount {...props} host={host} />;
}
