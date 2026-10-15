import pkg from "../../../../package.json";
import { json, route } from "@/server/http";
import { deployedCommit } from "@/server/commit";
import { persistence, storageAvailable } from "@/server/index";

/** Deploy-time revision, from the first variable the platform sets; the package version is the fallback. */
const REVISION = [process.env.GIT_SHA, process.env.GITHUB_SHA, process.env.VERCEL_GIT_COMMIT_SHA, process.env.SOURCE_VERSION]
  .map((v) => v?.trim())
  .find((v) => v && /^[0-9a-f]{7,40}$/i.test(v));

/** Commit of the running build: a host variable if one is set, else the SHA next.config.ts read from git at build time. */
const commit = () => deployedCommit(process.env, process.env.TICKETSTUB_BUILD_COMMIT);

/** Liveness for the platform and for verify:product. The first call runs the storage probe (a write and read in a scratch table); no key or header is read. */
export const GET = route(async () =>
  json({
    ok: true,
    version: REVISION ?? pkg.version,
    commit: commit(),
    mode: process.env.TICKETSTUB_RUNTIME_MODE === "live" ? "live" : "demo",
    storage: storageAvailable() ? "ok" : "unavailable",
    persistence: persistence(),
    time: new Date().toISOString(),
  }),
);
