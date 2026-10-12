// Only the download launcher's own temporary profile reaches this helper, after
// confirmed process exit. Retries concern filesystem teardown, never captures.
import { lstat, rm } from "node:fs/promises";

const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 2000;
const RETRY_DELAY_MS = 100;
const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const SAFE_CODES = new Set([...RETRYABLE, "EACCES", "ENOENT", "ENOTDIR", "EIO", "EINVAL"]);
const DEADLINE = Symbol("profile_cleanup_deadline");
const safeCode = (error) => SAFE_CODES.has(error?.code) ? error.code : "OTHER";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function cleanupDownloadProfile(profile, { remove = rm, inspect = lstat, wait = sleep } = {}) {
  const startedAt = performance.now(), deadline = startedAt + TIMEOUT_MS, attempts = [];
  const finish = (status, reason) => ({ schema: "ticketstub.download-profile-cleanup.v1", status, reason,
    complete: status === "confirmed_absent", maxAttempts: MAX_ATTEMPTS, timeoutMs: TIMEOUT_MS,
    retryDelayMs: RETRY_DELAY_MS, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), attempts });
  async function bounded(call) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw DEADLINE;
    let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(call), new Promise((_, reject) => { timer = setTimeout(() => reject(DEADLINE), remaining); })]);
      if (performance.now() >= deadline) throw DEADLINE;
      return result;
    } catch (error) {
      // Promise completion and timer delivery can be scheduled in either order.
      // An absence result arriving after the overall deadline still cannot pass.
      if (performance.now() >= deadline) throw DEADLINE;
      throw error;
    }
    finally { clearTimeout(timer); }
  }
  for (let ordinal = 1; ordinal <= MAX_ATTEMPTS; ordinal++) {
    if (performance.now() >= deadline) return finish("incomplete", "cleanup_deadline");
    const attempt = { ordinal, remove: { status: "not_attempted" }, absence: { status: "not_checked" } };
    attempts.push(attempt);
    try {
      // Count every outer attempt ourselves; do not hide retries inside Node's rm.
      await bounded(() => remove(profile, { recursive: true, force: true, maxRetries: 0 }));
      attempt.remove = { status: "completed" };
    } catch (error) {
      attempt.remove = error === DEADLINE ? { status: "timed_out" } : { status: "failed", code: safeCode(error) };
      if (error === DEADLINE) return finish("incomplete", "cleanup_deadline");
    }
    try {
      await bounded(() => inspect(profile));
      attempt.absence = { status: "still_present" };
    } catch (error) {
      attempt.absence = error === DEADLINE ? { status: "timed_out" }
        : error?.code === "ENOENT" ? { status: "confirmed_absent" }
          : { status: "unavailable", code: safeCode(error) };
      if (error === DEADLINE) return finish("incomplete", "cleanup_deadline");
    }
    if (attempt.absence.status === "confirmed_absent") return finish("confirmed_absent", "absence_verified");
    if (attempt.absence.status !== "still_present") return finish("incomplete", "absence_unavailable");
    if (!RETRYABLE.has(attempt.remove.code)) return finish("incomplete", "removal_unconfirmed");
    if (ordinal === MAX_ATTEMPTS) return finish("incomplete", "attempt_limit");
    attempt.retryDelayMs = ordinal * RETRY_DELAY_MS;
    try { await bounded(() => wait(attempt.retryDelayMs)); }
    catch { return finish("incomplete", "cleanup_deadline"); }
  }
  return finish("incomplete", "attempt_limit");
}
