import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, verifyManifest, FIXTURE_SUITES } from "../scripts/assembly-evidence.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REAL_ROOT, "scripts", "assembly-evidence.mjs");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

// A tiny committed repo shaped like the real inputs, so tamper cases never touch the working checkout.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "assembly-evidence-"));
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  put(".gitignore", "/out/\n");
  put("package.json", JSON.stringify({ engines: { node: ">=22.23.3 <23", npm: ">=11.16.0 <12" }, packageManager: "npm@11.16.0" }));
  put("package-lock.json", "{\"lock\":1}\n");
  put("integration/repository-map.json", JSON.stringify({
    organization: "acme",
    integration_root: "REPO-03",
    repositories: [
      { id: "REPO-03", name: "app", planned_package_dependencies: ["agent-harness", "event-intelligence", "shared-contracts"] },
      { id: "REPO-02", name: "agent-harness", supplied_url: "https://github.com/acme/agent-harness" },
      { id: "REPO-08", name: "event-intelligence", supplied_url: "https://github.com/acme/event-intelligence" },
    ],
  }));
  const harness = "module.exports = 1;\n";
  put("src/server/vendor/agent-harness/src/a.js", harness);
  put("src/server/vendor/agent-harness/MANIFEST.json", JSON.stringify({
    repository: "https://github.com/acme/agent-harness", commit: "a".repeat(40), files: { "src/a.js": sha(harness) },
  }));
  for (const suite of FIXTURE_SUITES) {
    put(`${suite}/index.json`, `{"suite":"${suite}"}\n`);
    put(`${suite}/scenarios/one.json`, "{}\n");
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const withRepo = (fn) => () => { const root = makeRepo(); try { return fn(root); } finally { cleanup(root); } };

test("clean build records real identities, labels, and leaves unpinned components pending", withRepo((root) => {
  const manifest = buildManifest(root);
  assert.equal(manifest.app.sha, git(root, "rev-parse", "HEAD").trim());
  assert.equal(manifest.app.reproducible, true);
  assert.equal(manifest.lockfile.sha256, sha("{\"lock\":1}\n"));
  assert.equal(manifest.mode, "snapshot-tooling");
  assert.equal(manifest.acceptance.status, "not_accepted");
  assert.deepEqual(manifest.executed, []);
  assert.equal(manifest.toolchain.declared.packageManager, "npm@11.16.0");
  assert.equal(manifest.toolchain.runtime.node, process.versions.node);
  assert.equal(manifest.vendored[0].status, "installed-vendored");
  const status = Object.fromEntries(manifest.components.required.map((c) => [c.name, c]));
  assert.equal(status["agent-harness"].status, "installed-vendored");
  assert.equal(status["agent-harness"].commit, "a".repeat(40));
  for (const name of ["event-intelligence", "shared-contracts"]) {
    assert.equal(status[name].status, "pending");
    assert.equal(status[name].commit, undefined);
  }
  assert.equal(manifest.fixtures["fixtures/approval"].fileCount, 2);
  assert.deepEqual(verifyManifest(root, manifest), []);
}));

test("dirty tree is refused, or recorded as non-reproducible and rejected by verify", withRepo((root) => {
  writeFileSync(join(root, "stray.txt"), "x");
  assert.throws(() => buildManifest(root), /dirty/);
  const manifest = buildManifest(root, { allowDirty: true });
  assert.equal(manifest.app.dirty, true);
  assert.equal(manifest.app.reproducible, false);
  assert.deepEqual(manifest.app.dirtyPaths, ["stray.txt"]);
  assert.ok(verifyManifest(root, manifest).some((p) => /dirty/.test(p)));
  assert.equal(verifyManifest(root, manifest, { allowDirty: true }).length, 0);
}));

test("tampered manifest content fails the digest even when fields stay well-formed", withRepo((root) => {
  const manifest = buildManifest(root);
  const edited = structuredClone(manifest);
  edited.components.required.find((c) => c.name === "event-intelligence").status = "installed-vendored";
  edited.components.required.find((c) => c.name === "event-intelligence").commit = "b".repeat(40);
  const problems = verifyManifest(root, edited);
  assert.ok(problems.some((p) => /manifestDigest/.test(p)));
  assert.ok(problems.some((p) => /components differs/.test(p)));
}));

const commit = (root, message = "change") => { git(root, "add", "-A"); git(root, "commit", "-q", "-m", message); };
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const VENDOR = "src/server/vendor/agent-harness";
const readManifest = (root) => JSON.parse(readFileSync(join(root, VENDOR, "MANIFEST.json"), "utf8"));

function digestFor(manifest) {
  const body = { ...manifest };
  delete body.manifestDigest;
  const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
    : JSON.stringify(v);
  return sha(canonical(body));
}

// The digest is unkeyed, so an attacker can always recompute it; verify must still reject every false claim.
const reseal = (root, manifest, mutate, options) => {
  const copy = structuredClone(manifest);
  mutate(copy);
  copy.manifestDigest = digestFor(copy);
  return verifyManifest(root, copy, options);
};

test("resealed false acceptance, executed, mode and pin claims are rejected", withRepo((root) => {
  const manifest = buildManifest(root);
  assert.deepEqual(reseal(root, manifest, () => {}), []); // control: an unchanged reseal is consistent
  const cases = {
    acceptance: (m) => { m.acceptance.status = "accepted"; },
    executed: (m) => { m.executed = [{ command: "npm test", exit: 0 }]; },
    mode: (m) => { m.mode = "release"; },
    "unknown status": (m) => { m.components.required[0].status = "pinned"; },
    "pending with commit": (m) => { m.components.required.find((c) => c.status === "pending").commit = "c".repeat(40); },
    "extra release claim": (m) => { m.release = { certified: true, executedEvidence: "all green" }; },
    "extra acceptance criteria": (m) => { m.acceptance.criteria = { "GT-10B.1": "met" }; },
    "rewritten statement": (m) => { m.acceptance.statement = "All builds, integration and journeys executed and passed."; },
    "forged toolchain.declared": (m) => { m.toolchain.declared.nodeRange = ">=1"; },
    "forged match flag": (m) => { m.toolchain.runtime = { node: "99.0.0", npm: "99.0.0" }; m.toolchain.runtimeMatchesPackageManager = true; },
    "extra toolchain key": (m) => { m.toolchain.verifiedInstall = true; },
    "forged fileCount": (m) => { m.fixtures["fixtures/approval"].fileCount = 999; },
    "extra fixture key": (m) => { m.fixtures["fixtures/approval"].signedOff = true; },
    "extra app key": (m) => { m.app.signedOff = true; m.app.branch = "release/v1"; },
    "forged app sha": (m) => { m.app.sha = "d".repeat(40); },
    "lockfile path": (m) => { m.lockfile.path = "other.lock"; m.lockfile.verifiedInstall = true; },
    "inconsistent dirty flags": (m) => { m.app.dirtyPaths = ["x"]; },
    "forged vendored url": (m) => { m.vendored[0].repository = "https://evil.invalid/x"; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    assert.ok(reseal(root, manifest, mutate).length > 0, `resealed claim accepted: ${name}`);
  }
}));

test("a dirty build relabelled clean after the fact is not provable; the dirty flags are documented self-reports", withRepo((root) => {
  writeFileSync(join(root, "stray.txt"), "x");
  const manifest = buildManifest(root, { allowDirty: true });
  rmSync(join(root, "stray.txt"));
  // dirtyPaths cannot be recomputed later, so this passes only as an internally consistent self-report,
  // never as a reproducibility proof; the unrelabelled dirty manifest is still rejected by default.
  assert.ok(verifyManifest(root, manifest).some((p) => /dirty/.test(p)));
  assert.deepEqual(reseal(root, manifest, (m) => { m.app.dirty = false; m.app.reproducible = true; m.app.dirtyPaths = []; }), []);
}));

test("lockfile, fixture and vendored drift committed after the manifest was built are detected", withRepo((root) => {
  const manifest = buildManifest(root);
  put(root, "package-lock.json", "{\"lock\":2}\n");
  commit(root);
  assert.ok(verifyManifest(root, manifest).some((p) => /lockfile differs/.test(p)));
  git(root, "reset", "-q", "--hard", manifest.app.sha);

  put(root, "fixtures/approval/index.json", "{\"changed\":true}\n");
  commit(root);
  assert.ok(verifyManifest(root, manifest).some((p) => /fixtures differs/.test(p)));
  git(root, "reset", "-q", "--hard", manifest.app.sha);

  put(root, `${VENDOR}/src/a.js`, "module.exports = 2;\n");
  commit(root);
  assert.throws(() => buildManifest(root), /drifted from MANIFEST/);
}));

test("working-tree edits never change recorded hashes; they only make the build dirty", withRepo((root) => {
  const clean = buildManifest(root);
  put(root, "package-lock.json", "{\"lock\":2}\n");
  put(root, "fixtures/approval/index.json", "{\"changed\":true}\n");
  assert.throws(() => buildManifest(root), /dirty/);
  const dirty = buildManifest(root, { allowDirty: true });
  assert.equal(dirty.lockfile.sha256, clean.lockfile.sha256);
  assert.equal(dirty.fixtures["fixtures/approval"].digest, clean.fixtures["fixtures/approval"].digest);
  assert.deepEqual(dirty.app.dirtyPaths, ["fixtures/approval/index.json", "package-lock.json"]);
}));

test("skip-worktree and assume-unchanged edits are surfaced as dirty and hashed from HEAD", withRepo((root) => {
  const clean = buildManifest(root);
  git(root, "update-index", "--skip-worktree", "fixtures/approval/index.json");
  git(root, "update-index", "--assume-unchanged", "package-lock.json");
  put(root, "fixtures/approval/index.json", "{\"hidden\":true}\n");
  put(root, "package-lock.json", "{\"lock\":9}\n");
  assert.throws(() => buildManifest(root), /dirty/);
  const dirty = buildManifest(root, { allowDirty: true });
  assert.deepEqual(dirty.app.dirtyPaths, ["fixtures/approval/index.json", "package-lock.json"]);
  assert.equal(dirty.fixtures["fixtures/approval"].digest, clean.fixtures["fixtures/approval"].digest);
  assert.equal(dirty.lockfile.sha256, clean.lockfile.sha256);
  assert.ok(verifyManifest(root, clean).some((p) => /checkout is dirty/.test(p)));
}));

test("renames are reported by their new path only", withRepo((root) => {
  git(root, "mv", "fixtures/context/index.json", "fixtures/context/renamed.json");
  assert.deepEqual(buildManifest(root, { allowDirty: true }).app.dirtyPaths, ["fixtures/context/renamed.json"]);
}));

test("added, removed or unlisted tracked fixtures are detected", withRepo((root) => {
  const manifest = buildManifest(root);
  put(root, "fixtures/context/extra.json", "{}\n");
  commit(root, "more");
  const problems = verifyManifest(root, manifest);
  assert.ok(problems.some((p) => /fixtures differs/.test(p)));
  assert.ok(problems.some((p) => /not this checkout's HEAD/.test(p)));
}));

test("missing required inputs fail the build instead of producing a partial manifest", () => {
  for (const [rel, pattern] of [
    ["package-lock.json", /package-lock\.json/],
    ["integration/repository-map.json", /repository-map/],
    [`${VENDOR}/MANIFEST.json`, /MANIFEST/],
    ["fixtures/order-authorization", /no tracked files/],
  ]) {
    const root = makeRepo();
    try {
      git(root, "rm", "-rq", rel);
      git(root, "commit", "-q", "-m", "rm");
      assert.throws(() => buildManifest(root), pattern, rel);
    } finally { cleanup(root); }
  }
});

test("a repository map without composition-root dependencies gives a clear error", withRepo((root) => {
  put(root, "integration/repository-map.json", JSON.stringify({ organization: "acme", integration_root: "REPO-03", repositories: [{ id: "REPO-03", name: "app" }] }));
  commit(root);
  assert.throws(() => buildManifest(root), /planned_package_dependencies/);
}));

test("vendored paths: traversal, absolute, backslash, untracked, ignored and secret-like entries are refused", withRepo((root) => {
  const original = readManifest(root);
  put(root, "outside.txt", "o");
  commit(root);
  for (const bad of ["../../../../../outside.txt", "/etc/hosts", "src/../src/a.js", "src\\a.js", ".env", "x/.env.local", "key.pem"]) {
    put(root, `${VENDOR}/MANIFEST.json`, JSON.stringify({ ...original, files: { [bad]: sha("o") } }));
    commit(root);
    assert.throws(() => buildManifest(root), /unsafe path|secret-like/, bad);
  }
  // Ignored, untracked secret file listed by a tracked MANIFEST: never opened, so never hashed.
  put(root, ".gitignore", "/out/\n.env*\n");
  put(root, `${VENDOR}/.env.local`, "SECRET=hunter2\n");
  put(root, `${VENDOR}/MANIFEST.json`, JSON.stringify({ ...original, files: { ...original.files, ".env.local": sha("SECRET=hunter2\n") } }));
  commit(root);
  assert.throws(() => buildManifest(root), /secret-like/);
  // Untracked, non-ignored file listed by a tracked MANIFEST: not at HEAD, so refused.
  put(root, `${VENDOR}/src/ghost.js`, "g");
  put(root, `${VENDOR}/MANIFEST.json`, JSON.stringify({ ...original, files: { ...original.files, "src/ghost.js": sha("g") } }));
  git(root, "add", `${VENDOR}/MANIFEST.json`);
  git(root, "commit", "-q", "-m", "ghost");
  assert.throws(() => buildManifest(root, { allowDirty: true }), /not tracked at HEAD/);
}));

test("tracked vendored files that MANIFEST does not list are refused", withRepo((root) => {
  put(root, `${VENDOR}/src/unlisted.js`, "u");
  commit(root);
  assert.throws(() => buildManifest(root), /not listed/);
}));

test("an ignored untracked fake vendor module never becomes a pin", withRepo((root) => {
  put(root, ".gitignore", "/out/\nsrc/server/vendor/event-intelligence/\n.DS_Store\n");
  put(root, "src/server/vendor/event-intelligence/src/x.js", "x");
  put(root, "src/server/vendor/event-intelligence/MANIFEST.json", JSON.stringify({
    repository: "https://github.com/acme/event-intelligence", commit: "e".repeat(40), files: { "src/x.js": sha("x") },
  }));
  put(root, "src/server/vendor/.DS_Store", "junk");
  commit(root, "ignore");
  const manifest = buildManifest(root);
  assert.equal(manifest.components.required.find((c) => c.name === "event-intelligence").status, "pending");
  assert.deepEqual(manifest.vendored.map((v) => v.name), ["agent-harness"]);
  assert.deepEqual(verifyManifest(root, manifest), []);
}));

test("vendored repository identity must be exactly the inventory organization URL, with no credentials", withRepo((root) => {
  const original = readManifest(root);
  for (const repository of [
    "https://evil.invalid/agent-harness",
    "https://user:token@github.com/acme/agent-harness",
    "https://github.com/acme/agent-harness.git",
    "https://github.com/other/agent-harness",
    "http://github.com/acme/agent-harness",
    undefined,
  ]) {
    put(root, `${VENDOR}/MANIFEST.json`, JSON.stringify({ ...original, repository }));
    commit(root);
    assert.throws(() => buildManifest(root), /repository is not/, String(repository));
  }
  put(root, `${VENDOR}/MANIFEST.json`, JSON.stringify(original));
  put(root, "integration/repository-map.json", JSON.stringify({
    organization: "acme", integration_root: "REPO-03",
    repositories: [{ id: "REPO-03", name: "app", planned_package_dependencies: ["agent-harness"] },
      { id: "REPO-02", name: "agent-harness", supplied_url: "https://user:pw@github.com/acme/agent-harness" }],
  }));
  commit(root);
  assert.throws(() => buildManifest(root), /not the plain organization URL/);
}));

test("a tracked symlink or non-regular entry in vendor or fixture suites is refused, not followed", withRepo((root) => {
  symlinkSync("/etc/hosts", join(root, "fixtures/context/leak.json"));
  commit(root, "link");
  assert.throws(() => buildManifest(root), /not a regular tracked file/);
  git(root, "reset", "-q", "--hard", "HEAD~1");
  const original = readManifest(root);
  symlinkSync("/etc/hosts", join(root, VENDOR, "src/link.js"));
  put(root, `${VENDOR}/MANIFEST.json`, JSON.stringify({ ...original, files: { ...original.files, "src/link.js": sha("x") } }));
  commit(root, "vendor link");
  assert.throws(() => buildManifest(root), /not a regular tracked file/);
}));

test("CLI: writes only to ignored or external paths and verify exits non-zero on tamper", withRepo((root) => {
  // The CLI resolves its own repo root, so exercise it against a copy of the script inside the temp repo.
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/assembly-evidence.mjs"), readFileSync(CLI));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "script");
  const run = (...args) => {
    try { return { code: 0, out: execFileSync("node", [join(root, "scripts/assembly-evidence.mjs"), ...args], { encoding: "utf8", stdio: "pipe" }) }; }
    catch (error) { return { code: error.status, out: `${error.stdout}${error.stderr}` }; }
  };
  assert.equal(run("build").code, 0);
  assert.equal(run("verify").code, 0);
  const refused = run("build", "--out", "docs/manifest.json");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /non-ignored path/);
  assert.equal(run("build", "--out", "package.json").code, 1);
  assert.equal(run("build", "--out").code, 1);
  assert.equal(run("build", "--out", "--allow-dirty").code, 1);
  assert.equal(run("build", "--out", "..foo.json").code, 1); // inside the repo (not an escape) and not ignored
  symlinkSync(join(root, "docs"), join(root, "out", "linked"));
  assert.equal(run("build", "--out", "out/linked/m.json").code, 1);
  const external = join(root, "..", `external-${process.pid}.json`);
  try {
    assert.equal(run("build", "--out", external).code, 0);
    assert.equal(run("verify", external).code, 0);
    const text = readFileSync(external, "utf8").replace("not_accepted", "accepted");
    writeFileSync(external, text);
    const bad = run("verify", external);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /FAIL/);
    assert.equal(run("verify", join(root, "missing.json")).code, 1);
  } finally { rmSync(external, { force: true }); }
}));

test("local git replace refs cannot substitute HEAD content", withRepo((root) => {
  const clean = buildManifest(root);
  const original = git(root, "rev-parse", "HEAD:fixtures/approval/index.json").trim();
  const forged = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "{\"forged\":true}\n", encoding: "utf8" }).trim();
  git(root, "replace", original, forged);
  assert.equal(git(root, "status", "--porcelain").trim(), ""); // replace refs are invisible to status
  const replaced = buildManifest(root);
  assert.equal(replaced.fixtures["fixtures/approval"].digest, clean.fixtures["fixtures/approval"].digest);
  assert.deepEqual(verifyManifest(root, clean), []);
}));

test("verify never throws on malformed components.required", withRepo((root) => {
  const manifest = buildManifest(root);
  for (const required of [5, null, "x", {}, [null], [5], [{}]]) {
    let problems;
    assert.doesNotThrow(() => { problems = reseal(root, manifest, (m) => { m.components.required = required; }); }, JSON.stringify(required));
    assert.ok(problems.length > 0, JSON.stringify(required));
  }
}));

function cli(root) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/assembly-evidence.mjs"), readFileSync(CLI));
  commit(root, "script");
  return (...args) => {
    try { return { code: 0, out: execFileSync("node", [join(root, "scripts/assembly-evidence.mjs"), ...args], { encoding: "utf8", stdio: "pipe" }) }; }
    catch (error) { return { code: error.status, out: `${error.stdout}${error.stderr}` }; }
  };
}

test("--out never clobbers existing secrets, tracked files (including via aliases) or non-manifest files", withRepo((root) => {
  put(root, ".gitignore", "/out/\n.env*\nnotes.txt\n");
  commit(root, "ignore");
  const run = cli(root);
  put(root, ".env.local", "SECRET=hunter2\n");
  put(root, "out/keep.pem", "PEM\n");
  put(root, "notes.txt", "mine\n");
  const trackedBefore = readFileSync(join(root, "package.json"), "utf8");
  for (const target of [".env.local", "out/keep.pem", "out/.env", "notes.txt"]) {
    const result = run("build", "--out", target);
    assert.equal(result.code, 1, target);
  }
  assert.equal(readFileSync(join(root, ".env.local"), "utf8"), "SECRET=hunter2\n");
  assert.equal(readFileSync(join(root, "out/keep.pem"), "utf8"), "PEM\n");
  assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "mine\n");

  // A symlinked alias of the repo directory must still be recognised as in-repo, and the tracked file left alone.
  const alias = join(tmpdir(), `assembly-alias-${process.pid}`);
  symlinkSync(root, alias);
  try {
    const result = run("build", "--out", join(alias, "package.json"));
    assert.equal(result.code, 1);
    assert.match(result.out, /tracked file/);
    assert.equal(run("build", "--out", join(alias, "docs-out.json")).code, 1); // in-repo, not ignored
    assert.equal(run("build", "--out", join(alias, ".env.local")).code, 1);
  } finally { rmSync(alias, { force: true }); }
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), trackedBefore);
  assert.equal(readFileSync(join(root, ".env.local"), "utf8"), "SECRET=hunter2\n");

  // A previous manifest may be replaced; no stray temp files remain.
  assert.equal(run("build").code, 0);
  assert.equal(run("build").code, 0);
  assert.equal(run("verify").code, 0);
  assert.deepEqual(execFileSync("ls", ["-A", join(root, "out/assembly-evidence")], { encoding: "utf8" }).trim().split("\n"), ["manifest.json"]);
}));

test("--out preserves a non-manifest created after output validation", withRepo((root) => {
  cli(root);
  const target = join(root, "out/assembly-evidence/manifest.json");
  const contents = "concurrent writer's non-manifest\n";
  const preload = join(root, "out/create-late-output.mjs");
  // The real CLI has validated --out before buildManifest asks for npm's version. Create the competing
  // file at that existing subprocess boundary, without timers, sleeps, or changes to the production API.
  put(root, "out/create-late-output.mjs", `
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
const original = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  if (command === "npm" && args.length === 1 && args[0] === "--version") {
    const target = ${JSON.stringify(target)};
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, ${JSON.stringify(contents)}, { flag: "wx" });
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--import", preload, join(root, "scripts/assembly-evidence.mjs"), "build", "--out", target], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(readFileSync(target, "utf8"), contents);
  assert.deepEqual(readdirSync(dirname(target)), ["manifest.json"]); // failed exclusive creation cleans up its temp file
}));

test("the real checkout's inputs build a manifest whose pending pins stay pending", () => {
  const manifest = buildManifest(REAL_ROOT, { allowDirty: true });
  const pending = manifest.components.required.filter((c) => c.status === "pending").map((c) => c.name);
  assert.ok(pending.includes("event-intelligence"));
  assert.equal(manifest.components.required.find((c) => c.name === "creative-engine").status, "installed-vendored");
  assert.equal(manifest.components.required.find((c) => c.name === "cost-intelligence").status, "installed-vendored");
  assert.equal(manifest.components.required.find((c) => c.name === "agent-harness").status, "installed-vendored");
  assert.equal(manifest.acceptance.status, "not_accepted");
});
