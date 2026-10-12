import test from "node:test";
import assert from "node:assert/strict";
import { lstat, rm } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDownloadProfile } from "../scripts/lib/download-profile-cleanup.mjs";

async function withProfile(run) {
  const profile = mkdtempSync(join(tmpdir(), "ticketstub-chrome-"));
  writeFileSync(join(profile, "synthetic-profile.txt"), "synthetic fixture, no customer data");
  try { return await run(profile); }
  finally { rmSync(profile, { recursive: true, force: true }); }
}
const error = (code) => Object.assign(new Error("PRIVATE_PATH_CANARY SECRET_CANARY"), { code });

test("actual temporary profile removal proves absence and records one bounded attempt without its path", async () => {
  await withProfile(async (profile) => {
    const result = await cleanupDownloadProfile(profile);
    assert.equal(result.status, "confirmed_absent"); assert.equal(result.complete, true);
    assert.equal(result.timeoutMs, 2000); assert.equal(result.maxAttempts, 4);
    assert.deepEqual(result.attempts, [{ ordinal: 1, remove: { status: "completed" }, absence: { status: "confirmed_absent" } }]);
    await assert.rejects(lstat(profile), { code: "ENOENT" });
    assert.ok(!JSON.stringify(result).includes(profile));
  });
});

test("a transient failure is retained before a subsequent actual removal and absence check", async () => {
  await withProfile(async (profile) => {
    let calls = 0; const delays = [];
    const result = await cleanupDownloadProfile(profile, {
      async remove(path, options) { calls++; assert.deepEqual(options, { recursive: true, force: true, maxRetries: 0 });
        if (calls === 1) throw error("ENOTEMPTY"); return rm(path, options); },
      async wait(ms) { delays.push(ms); },
    });
    assert.equal(result.complete, true); assert.equal(calls, 2);
    assert.deepEqual(delays, [100]);
    assert.deepEqual(result.attempts[0], { ordinal: 1, remove: { status: "failed", code: "ENOTEMPTY" }, absence: { status: "still_present" }, retryDelayMs: 100 });
    assert.equal(result.attempts[1].absence.status, "confirmed_absent");
    await assert.rejects(lstat(profile), { code: "ENOENT" });
    assert.doesNotMatch(JSON.stringify(result), /CANARY/);
  });
});

test("permanent and unknown filesystem errors stay incomplete without retry or raw error leakage", async () => {
  await withProfile(async (profile) => {
    for (const code of ["EACCES", "SECRET_CANARY"]) {
      let calls = 0;
      const result = await cleanupDownloadProfile(profile, { async remove() { calls++; throw error(code); },
        async wait() { assert.fail("non-transient errors must not retry"); } });
      assert.equal(result.complete, false); assert.equal(result.status, "incomplete");
      assert.equal(calls, 1); assert.equal(result.attempts[0].remove.code, code === "EACCES" ? code : "OTHER");
      assert.equal(result.attempts[0].absence.status, "still_present");
      assert.doesNotMatch(JSON.stringify(result), /CANARY/);
    }
  });
});

test("documented transient errors stop at four attempts with all requested cleanup delays retained", async () => {
  await withProfile(async (profile) => {
    for (const code of ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]) {
      const delays = [];
      const result = await cleanupDownloadProfile(profile, { async remove() { throw error(code); }, async wait(ms) { delays.push(ms); } });
      assert.equal(result.complete, false); assert.equal(result.reason, "attempt_limit");
      assert.equal(result.attempts.length, 4); assert.deepEqual(delays, [100, 200, 300]);
      assert.ok(result.attempts.every((attempt) => attempt.remove.code === code && attempt.absence.status === "still_present"));
    }
  });
});

test("a successful removal return cannot substitute for actual absence, and unavailable stat fails closed", async () => {
  await withProfile(async (profile) => {
    const remains = await cleanupDownloadProfile(profile, { async remove() {} });
    assert.equal(remains.complete, false); assert.equal(remains.reason, "removal_unconfirmed");
    assert.equal(remains.attempts[0].absence.status, "still_present");
    const unavailable = await cleanupDownloadProfile(profile, { async remove() {}, async inspect() { throw error("EIO"); } });
    assert.equal(unavailable.complete, false); assert.equal(unavailable.reason, "absence_unavailable");
    assert.deepEqual(unavailable.attempts[0].absence, { status: "unavailable", code: "EIO" });
  });
});

test("held removal reaches the actual default deadline once and late completion cannot revise evidence", { timeout: 4000 }, async () => {
  await withProfile(async (profile) => {
    let release, calls = 0;
    const result = await cleanupDownloadProfile(profile, { remove(path, options) { calls++;
      return new Promise((resolve) => { release = async () => { await rm(path, options); resolve(); }; }); } });
    assert.equal(calls, 1); assert.equal(result.complete, false); assert.equal(result.reason, "cleanup_deadline");
    assert.equal(result.timeoutMs, 2000); assert.equal(result.attempts[0].remove.status, "timed_out");
    assert.equal(result.attempts[0].absence.status, "not_checked");
    const before = JSON.stringify(result);
    await release();
    assert.equal(JSON.stringify(result), before);
    await assert.rejects(lstat(profile), { code: "ENOENT" });
  });
});

test("held absence inspection is bounded by the same deadline and late ENOENT cannot revise failure", { timeout: 4000 }, async () => {
  await withProfile(async (profile) => {
    let rejectInspection, calls = 0;
    const result = await cleanupDownloadProfile(profile, { inspect() { calls++;
      return new Promise((_, reject) => { rejectInspection = reject; }); } });
    assert.equal(calls, 1); assert.equal(result.complete, false); assert.equal(result.reason, "cleanup_deadline");
    assert.equal(result.attempts[0].remove.status, "completed");
    assert.equal(result.attempts[0].absence.status, "timed_out");
    const before = JSON.stringify(result);
    rejectInspection(error("ENOENT"));
    await Promise.resolve();
    assert.equal(JSON.stringify(result), before);
    await assert.rejects(lstat(profile), { code: "ENOENT" });
  });
});
