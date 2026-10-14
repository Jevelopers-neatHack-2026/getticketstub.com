import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

// The commit being built, inlined for /api/health. Never fails the build: without git or .git it is empty.
function buildCommit(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : "";
  } catch {
    return "";
  }
}

// The studio keeps stubs in the browser (localStorage + share-link tokens), so routes render on
// request; Cache Components prerendering adds nothing here yet.
const nextConfig: NextConfig = {
  env: { TICKETSTUB_BUILD_COMMIT: buildCommit() },
  // Owned runtimes load their pinned contract catalogs/native codecs from
  // package resources. Preserve those server package boundaries in builds.
  serverExternalPackages: ["creative-engine", "@jevelopers/cost-intelligence", "pg", "sharp"],
  // One canonical origin: localStorage is per-origin, so stubs made on www would not show on the
  // apex (and vice versa).
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.getticketstub.com" }],
        destination: "https://getticketstub.com/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
