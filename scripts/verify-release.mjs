// Read-only consistency gate for the pinned canonical evaluator's composed receipts.
// This does not execute an assembly or record product/master acceptance.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RECEIPT_SCHEMA = "ticketstub.release-verification/1";
const rejected = (code) => ({ schema: RECEIPT_SCHEMA, passed: false, code, acceptance: "not_recorded" });

export function parseReleaseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const allowed = new Set(["--manifest", "--evidence-dir", "--workspace", "--python"]);
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!allowed.has(key) || Object.hasOwn(out, key.slice(2)) || typeof value !== "string" ||
        !value || value.startsWith("--") || value.includes("\0") || value.length > 4096) {
      throw new Error("release_arguments_invalid");
    }
    out[key.slice(2)] = value;
  }
  for (const key of ["manifest", "evidence-dir", "workspace"]) {
    if (!out[key]) throw new Error(`release_${key.replaceAll("-", "_")}_required`);
  }
  return out;
}

export function verifyRelease(argv) {
  let args;
  try { args = parseReleaseArgs(argv); } catch (error) { return rejected(error.message); }
  if (args.help) return { help: true };
  const child = spawnSync(args.python ?? "python3", [
    "-I", "-B", resolve(ROOT, "scripts/lib/verify_release.py"), ROOT,
    resolve(args.manifest), resolve(args["evidence-dir"]), resolve(args.workspace),
  ], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
    // No inherited credentials, Python import overrides, Git locations, or provider settings.
    env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
      // Also protects Git reads made inside the canonical validator from a repo-local executable fsmonitor.
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" },
  });
  if (child.error) return rejected(child.error.code === "ETIMEDOUT" ? "release_validation_timeout" : "release_python_unavailable");
  let receipt;
  try { receipt = JSON.parse(child.stdout); } catch { return rejected("release_validator_protocol_invalid"); }
  if (receipt?.schema !== RECEIPT_SCHEMA || receipt.acceptance !== "not_recorded" ||
      typeof receipt.passed !== "boolean" || !/^[a-z][a-z0-9_]{0,79}$/.test(receipt.code ?? "")) {
    return rejected("release_validator_protocol_invalid");
  }
  if (child.status !== 0) return rejected(receipt.passed ? "release_validator_nonzero" : receipt.code);
  if (!receipt.passed || receipt.code !== "release_evidence_consistent") return rejected("release_validator_protocol_invalid");
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = verifyRelease(process.argv.slice(2));
  if (result.help) {
    console.log("npm run verify:release -- --manifest <Assembly1.0.json> --evidence-dir <canonical-run-directory> --workspace <component-checkout-parent> [--python <Python3.13+>]");
    console.log("Read-only evidence consistency. No owner commands, provider requests, deployment or acceptance mutation.");
  } else {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 2;
  }
}
