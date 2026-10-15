import assert from "node:assert/strict";
import { test } from "node:test";
import { deployedCommit } from "../src/server/commit.ts";

const sha = "a".repeat(40);

test("commit comes from a host variable before the build value", () => {
  assert.equal(deployedCommit({ SOURCE_COMMIT: "1234567" }, sha), "1234567");
  assert.equal(deployedCommit({ GIT_COMMIT: "ABCDEF1" }, sha), "abcdef1");
});

test("commit falls back to the build value, then to null", () => {
  assert.equal(deployedCommit({}, sha), sha);
  assert.equal(deployedCommit({}, ""), null);
  assert.equal(deployedCommit({}), null);
});

test("commit never exposes non-hex or out-of-range text", () => {
  assert.equal(deployedCommit({ SOURCE_COMMIT: "latest", GIT_COMMIT: "abc123", COMMIT_SHA: "g".repeat(40) }), null);
  assert.equal(deployedCommit({ SOURCE_COMMIT: "a".repeat(41) }, "main"), null);
  assert.equal(deployedCommit({ SOURCE_COMMIT: "secret=1" }, sha), sha);
});
