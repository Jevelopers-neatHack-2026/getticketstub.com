const SHA = /^[0-9a-f]{7,40}$/i;

/** Host variables checked at runtime, in order; the first hex value wins. */
const ENV_KEYS = ["SOURCE_COMMIT", "GIT_COMMIT", "COMMIT_SHA", "GIT_SHA", "GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA", "SOURCE_VERSION"] as const;

/** The deployed commit as lowercase hex, or null. Only hex is returned, never arbitrary env text. `built` is the SHA resolved at build time. */
export function deployedCommit(env: Record<string, string | undefined>, built?: string): string | null {
  for (const v of [...ENV_KEYS.map((k) => env[k]), built]) {
    const s = v?.trim();
    if (s && SHA.test(s)) return s.toLowerCase();
  }
  return null;
}
