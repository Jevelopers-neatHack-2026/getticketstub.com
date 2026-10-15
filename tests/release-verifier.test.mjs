import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseReleaseArgs, RECEIPT_SCHEMA } from "../scripts/verify-release.mjs";

const cli = fileURLToPath(new URL("../scripts/verify-release.mjs", import.meta.url));
const valid = ["--manifest", "assembly.json", "--evidence-dir", "reports/run", "--workspace", "components"];
for (const [name, args, code] of [
  ["missing manifest", [], "release_manifest_required"],
  ["missing evidence", ["--manifest", "assembly.json"], "release_evidence_dir_required"],
  ["missing workspace", valid.slice(0, 4), "release_workspace_required"],
  ["unknown approval switch", [...valid, "--approve", "yes"], "release_arguments_invalid"],
  ["dirty override", [...valid, "--allow-dirty", "yes"], "release_arguments_invalid"],
  ["selected subset", [...valid, "--suite", "one-case"], "release_arguments_invalid"],
  ["duplicate manifest", [...valid, "--manifest", "other.json"], "release_arguments_invalid"],
  ["missing Python value", [...valid, "--python"], "release_arguments_invalid"],
  ["switch as value", ["--manifest", "--workspace"], "release_arguments_invalid"],
  ["positional input", [...valid, "unexpected"], "release_arguments_invalid"],
]) {
  test(`release CLI rejects ${name} before executing a validator`, () => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stdout), { schema: RECEIPT_SCHEMA, passed: false, code, acceptance: "not_recorded" });
  });
}

test("release arguments preserve literal paths and reject oversized or NUL values", () => {
  assert.equal(parseReleaseArgs(["--manifest", "dir/$(never-execute) name.json", ...valid.slice(2)]).manifest, "dir/$(never-execute) name.json");
  for (const value of ["x\0y", "x".repeat(4097)]) {
    assert.throws(() => parseReleaseArgs(["--manifest", value, ...valid.slice(2)]), /release_arguments_invalid/);
  }
});

test("release help describes read-only scope without a passing receipt", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Read-only evidence consistency/);
  assert.doesNotMatch(result.stdout, /"passed"\s*:\s*true/);
});
