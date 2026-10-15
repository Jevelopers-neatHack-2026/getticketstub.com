#!/usr/bin/env node
// GT-10B assembly-evidence manifest: an offline, reproducible SNAPSHOT of what this checkout actually contains
// (app git SHA, lockfile hash, declared vs runtime toolchain, vendored modules, tracked fixture identities) and
// which required component pins are still pending. It is tooling output, not integration, build, release or
// acceptance evidence: it records no command results and never reports a pending component as pinned.
//
//   node scripts/assembly-evidence.mjs build  [--out <file>] [--allow-dirty]
//   node scripts/assembly-evidence.mjs verify [<manifest>] [--allow-dirty]
//
// The default output (out/assembly-evidence/manifest.json) is git-ignored, so the app SHA is never committed into
// the app itself. No network, no provider calls; identities are read only from committed HEAD blobs (so no .env, ignored,
// untracked or locally modified content is ever opened), and the manifest digest is unkeyed, not an authenticity proof.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "ticketstub.assembly-evidence/1";
export const MODE = "snapshot-tooling";
export const FIXTURE_SUITES = ["fixtures/approval", "fixtures/context", "fixtures/order-authorization"];
const VENDOR_DIR = "src/server/vendor";
const DEFAULT_OUT = "out/assembly-evidence/manifest.json";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Local refs/replace objects and inherited GIT_* location variables must not change what "HEAD" means.
const gitEnv = () => {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[name];
  return env;
};
const gitBytes = (root, ...args) => execFileSync("git", ["--no-replace-objects", ...args], { cwd: root, env: gitEnv(), maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
const git = (root, ...args) => gitBytes(root, ...args).toString("utf8");

// Every identity below is read from committed HEAD blobs (never the working tree), so ignored, untracked,
// skip-worktree or locally modified content cannot become a pin, and no path outside the tracked tree is opened.
function headTree(root) {
  const tree = new Map();
  for (const entry of git(root, "ls-tree", "-r", "-z", "--full-tree", "HEAD").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    tree.set(entry.slice(tab + 1), { mode, type, oid });
  }
  return tree;
}

function plainPath(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || rel.includes("\\") || isAbsolute(rel)) throw new Error(`unsafe path: ${JSON.stringify(rel)}`);
  if (rel.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error(`unsafe path: ${rel}`);
  if (/(^|\/)\.env/i.test(rel) || /\.pem$/i.test(rel)) throw new Error(`secret-like path refused: ${rel}`);
  return rel;
}

// A path must be a plain relative path to a regular, tracked HEAD blob; returns its bytes.
function readTracked(root, tree, rel) {
  const entry = tree.get(plainPath(rel));
  if (!entry) throw new Error(`not tracked at HEAD: ${rel}`);
  if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) throw new Error(`not a regular tracked file (mode ${entry.mode}): ${rel}`);
  return gitBytes(root, "cat-file", "blob", entry.oid);
}

function requireTracked(root, tree, rel) {
  try { return readTracked(root, tree, rel); }
  catch (error) { throw new Error(`required input missing or unsafe: ${rel} (${error.message})`); }
}

function appState(root) {
  const sha = git(root, "rev-parse", "HEAD").trim();
  if (!HEX40.test(sha)) throw new Error("could not read app git SHA");
  const dirtyPaths = new Set();
  const status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0");
  for (let i = 0; i < status.length; i += 1) {
    const entry = status[i];
    if (!entry) continue;
    dirtyPaths.add(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") i += 1; // skip the rename/copy source token
  }
  // skip-worktree / assume-unchanged entries hide edits from `git status`; treat them as dirty.
  for (const entry of git(root, "ls-files", "-v", "-z").split("\0").filter(Boolean)) {
    if (entry[0] !== "H") dirtyPaths.add(entry.slice(2));
  }
  const sorted = [...dirtyPaths].sort();
  return { sha, dirty: sorted.length > 0, dirtyPaths: sorted };
}

const NODE_VERSION = /^\d+\.\d+\.\d+$/;

function toolchain(root, tree) {
  const pkg = JSON.parse(requireTracked(root, tree, "package.json").toString("utf8"));
  const declared = { nodeRange: pkg.engines?.node ?? null, npmRange: pkg.engines?.npm ?? null, packageManager: pkg.packageManager ?? null };
  // Runtime is whatever this process reports about itself; verify cannot prove it for a past build.
  const runtime = { node: process.versions.node, npm: execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim() };
  return { declared, runtime, runtimeMatchesPackageManager: runtimeMatches(declared, runtime) };
}

function runtimeMatches(declared, runtime) {
  const pinnedNpm = /^npm@(\d+\.\d+\.\d+)$/.exec(declared.packageManager ?? "")?.[1] ?? null;
  return pinnedNpm !== null && pinnedNpm === runtime.npm;
}

// Repository identity is derived from the planning inventory's organization and the module name, never copied.
function trustedRepository(map, name) {
  const entry = map.repositories.find((repo) => repo.name === name);
  if (!entry || typeof map.organization !== "string" || !/^[A-Za-z0-9._-]+$/.test(map.organization) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`vendored module ${name} is not in the repository inventory`);
  }
  const url = `https://github.com/${map.organization}/${name}`;
  if (entry.supplied_url !== undefined && entry.supplied_url !== url) throw new Error(`inventory URL for ${name} is not the plain organization URL`);
  return url;
}

function vendored(root, tree, map) {
  const prefix = `${VENDOR_DIR}/`;
  const byModule = new Map();
  for (const path of tree.keys()) {
    if (!path.startsWith(prefix)) continue;
    const [name] = path.slice(prefix.length).split("/");
    byModule.set(name, [...(byModule.get(name) ?? []), path.slice(prefix.length + name.length + 1)]);
  }
  const out = [];
  for (const name of [...byModule.keys()].sort()) {
    const base = `${prefix}${name}`;
    const tracked = byModule.get(name).filter((rel) => rel !== "");
    const manifestBytes = requireTracked(root, tree, `${base}/MANIFEST.json`);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!HEX40.test(manifest.commit ?? "")) throw new Error(`${base}/MANIFEST.json has no 40-hex commit`);
    const repository = trustedRepository(map, name);
    if (manifest.repository !== repository) throw new Error(`${base}/MANIFEST.json repository is not ${repository}`);
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error(`${base}/MANIFEST.json lists no files`);
    const listed = Object.keys(manifest.files).map(plainPath).sort();
    if (!listed.length) throw new Error(`${base}/MANIFEST.json lists no files`);
    const extra = tracked.filter((rel) => rel !== "MANIFEST.json" && !listed.includes(rel));
    if (extra.length) throw new Error(`tracked vendored files not listed in ${base}/MANIFEST.json: ${extra.join(", ")}`);
    const files = {};
    for (const rel of listed) {
      const actual = sha256(readTracked(root, tree, `${base}/${rel}`));
      if (actual !== manifest.files[rel]) throw new Error(`vendored file drifted from MANIFEST.json: ${base}/${rel}`);
      files[rel] = actual;
    }
    out.push({ name, status: "installed-vendored", repository, commit: manifest.commit, manifestSha256: sha256(manifestBytes), files });
  }
  if (!out.length) throw new Error(`no tracked vendored modules under ${VENDOR_DIR}`);
  return out;
}

function fixtures(root, tree) {
  const suites = {};
  for (const suite of FIXTURE_SUITES) {
    const tracked = [...tree.keys()].filter((path) => path.startsWith(`${suite}/`)).sort();
    if (!tracked.length) throw new Error(`required fixture suite has no tracked files: ${suite}`);
    const files = {};
    for (const rel of tracked) files[rel] = sha256(readTracked(root, tree, rel));
    suites[suite] = { fileCount: tracked.length, digest: digestOf(files), files };
  }
  return suites;
}

// Required component pins come from the planning inventory's composition root; the inventory itself is never a pin.
function loadMap(root, tree) {
  const bytes = requireTracked(root, tree, "integration/repository-map.json");
  const map = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(map.repositories)) throw new Error("repository map has no repositories array");
  const rootRepo = map.repositories.find((repo) => repo.id === map.integration_root || repo.name === map.integration_root);
  if (!rootRepo || !Array.isArray(rootRepo.planned_package_dependencies)) throw new Error("repository map has no integration root with planned_package_dependencies");
  return { map, rootRepo, sha256: sha256(bytes) };
}

function components({ rootRepo, sha256: inventoryHash }, vendoredModules) {
  const byName = new Map(vendoredModules.map((entry) => [entry.name, entry]));
  return {
    plannedInventorySha256: inventoryHash,
    note: "planned_inventory is not a tested dependency pin",
    required: rootRepo.planned_package_dependencies.map((name) => {
      const entry = byName.get(name);
      return entry
        ? { name, status: "installed-vendored", commit: entry.commit, source: `${VENDOR_DIR}/${name}/MANIFEST.json` }
        : { name, status: "pending", reason: "no installed or vendored revision in this checkout; planned inventory only" };
    }),
  };
}

function digestOf(value) { return sha256(canonical(value)); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const ACCEPTANCE = {
  status: "not_accepted",
  statement: "Snapshot of checkout identities only. No lint, typecheck, build, integration suite, journey, provider or release check was executed or implied; pending pins mean GT-10B.1 is unmet.",
};

export function buildManifest(root, { allowDirty = false } = {}) {
  const app = appState(root);
  if (app.dirty && !allowDirty) {
    throw new Error(`working tree is dirty (${app.dirtyPaths.length} paths); commit first or pass --allow-dirty for a non-reproducible snapshot`);
  }
  const tree = headTree(root);
  const inventory = loadMap(root, tree);
  const vendoredModules = vendored(root, tree, inventory.map);
  const body = {
    schema: SCHEMA,
    mode: MODE,
    app: { ...app, reproducible: !app.dirty },
    lockfile: { path: "package-lock.json", sha256: sha256(requireTracked(root, tree, "package-lock.json")) },
    toolchain: toolchain(root, tree),
    vendored: vendoredModules,
    components: components(inventory, vendoredModules),
    fixtures: fixtures(root, tree),
    executed: [],
    acceptance: ACCEPTANCE,
  };
  return { ...body, manifestDigest: digestOf(body) };
}

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (value, keys) => isPlain(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());

// Returns a list of problems (empty = every claim matches what this checkout derives from HEAD). Never throws on bad
// manifest content. manifestDigest is an UNKEYED hash: it detects accidental edits only and does not authenticate the
// manifest. Safety comes from recomputing every claim; the only claims that cannot be recomputed are build-time
// self-reports (toolchain.runtime and the app dirty/reproducible flags), which are checked for internal consistency only.
export function verifyManifest(root, manifest, { allowDirty = false } = {}) {
  const problems = [];
  const fail = (message) => problems.push(message);
  if (!isPlain(manifest)) return ["manifest is not an object"];
  if (!sameKeys(manifest, ["schema", "mode", "app", "lockfile", "toolchain", "vendored", "components", "fixtures", "executed", "acceptance", "manifestDigest"])) {
    fail("manifest has missing or unknown top-level keys");
  }
  const { manifestDigest, ...body } = manifest;
  if (!HEX64.test(manifestDigest ?? "") || manifestDigest !== digestOf(body)) fail("manifestDigest does not match manifest content (unkeyed; detects accidental edits only)");
  if (manifest.schema !== SCHEMA) fail(`unsupported schema: ${manifest.schema}`);
  if (manifest.mode !== MODE) fail(`unexpected mode label: ${manifest.mode}`);

  const app = manifest.app;
  if (!sameKeys(app, ["sha", "dirty", "dirtyPaths", "reproducible"])
    || typeof app.dirty !== "boolean" || !Array.isArray(app.dirtyPaths) || !app.dirtyPaths.every((p) => typeof p === "string")
    || app.dirty !== app.dirtyPaths.length > 0 || app.reproducible !== !app.dirty) {
    fail("app block is malformed or internally inconsistent");
  } else if (app.dirty && !allowDirty) fail("manifest was produced from a dirty tree (self-reported; not reproducible)");

  const tc = manifest.toolchain;
  if (!sameKeys(tc, ["declared", "runtime", "runtimeMatchesPackageManager"]) || !sameKeys(tc.runtime, ["node", "npm"])
    || !NODE_VERSION.test(tc.runtime.node ?? "") || !NODE_VERSION.test(tc.runtime.npm ?? "")) {
    fail("toolchain block is malformed");
  }

  let expected = null;
  try {
    const current = appState(root);
    if (app?.sha !== current.sha) fail(`app SHA ${app?.sha} is not this checkout's HEAD ${current.sha}`);
    if (current.dirty && !allowDirty) fail("checkout is dirty");
    expected = buildManifest(root, { allowDirty: true });
  } catch (error) { fail(`cannot derive expected identities from HEAD: ${error.message}`); }
  if (!expected) return problems;

  if (canonical(tc?.declared) !== canonical(expected.toolchain.declared)) fail("toolchain.declared differs from package.json at HEAD");
  if (tc?.runtimeMatchesPackageManager !== runtimeMatches(expected.toolchain.declared, tc?.runtime ?? {})) fail("runtimeMatchesPackageManager is inconsistent with the recorded runtime");
  for (const key of ["lockfile", "vendored", "components", "fixtures", "executed", "acceptance"]) {
    if (canonical(manifest[key]) !== canonical(expected[key])) fail(`${key} differs from what HEAD derives`);
  }
  const required = Array.isArray(manifest.components?.required) ? manifest.components.required : [];
  for (const component of required) {
    if (component?.status === "pending" && (component.commit || component.sha256)) fail(`pending component ${component.name} carries a pin`);
  }
  return problems;
}

function parseArgs(argv) {
  const args = { positional: [], allowDirty: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--allow-dirty") args.allowDirty = true;
    else if (argv[i] === "--out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--out requires a file path");
      args.out = value;
      i += 1;
    } else if (argv[i].startsWith("--")) throw new Error(`unknown option: ${argv[i]}`);
    else args.positional.push(argv[i]);
  }
  return args;
}

// Resolves symlinks in every existing ancestor, so /tmp vs /private/tmp style aliases compare by real location.
function realTarget(full) {
  const missing = [];
  let current = full;
  while (!existsSync(current) && dirname(current) !== current) { missing.unshift(current.slice(dirname(current).length + 1)); current = dirname(current); }
  return join(realpathSync(current), ...missing);
}

// Default/explicit output must not land on a tracked path or inside an un-ignored part of the repo, must never be a
// secret-like name, and may only replace a regular file that is itself a previous assembly-evidence manifest.
function checkOutputPath(root, out) {
  const full = resolve(root, out);
  if (/^\.env/i.test(basename(full)) || /\.pem$/i.test(full)) throw new Error(`refusing secret-like output name: ${basename(full)}`);
  const lexical = relative(root, full);
  if (lexical === "") throw new Error("--out must be a file path");
  if (!(lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical))) {
    let current = root;
    for (const part of lexical.split(sep)) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${relative(root, current)}`);
    }
  }
  const real = realTarget(full);
  const rel = relative(realpathSync(root), real);
  if (rel === "") throw new Error("--out must be a file path");
  if (!(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    if (git(root, "ls-files", "--", rel).trim()) throw new Error(`refusing to overwrite tracked file: ${rel}`);
    try { gitBytes(root, "check-ignore", "-q", "--", rel); }
    catch { throw new Error(`refusing to write inside the repo to a non-ignored path: ${rel} (the app SHA must not be committed)`); }
  }
  const replacing = existsSync(real);
  if (replacing) {
    let previous = null;
    if (lstatSync(real).isFile()) { try { previous = JSON.parse(readFileSync(real, "utf8")); } catch { previous = null; } }
    if (previous?.schema !== SCHEMA) throw new Error(`refusing to overwrite an existing file that is not an assembly-evidence manifest: ${real}`);
  }
  return { target: real, replacing };
}

// Write to a private temp file, then link (fails if the target appeared) or, for a validated previous manifest, rename.
function writeOutput(target, text, replacing) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
  try {
    if (replacing) renameSync(temp, target);
    else linkSync(temp, target);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const [command, ...rest] = process.argv.slice(2);
  try {
    const args = parseArgs(rest);
    if (command === "build") {
      const { target, replacing } = checkOutputPath(root, args.out ?? DEFAULT_OUT);
      const manifest = buildManifest(root, { allowDirty: args.allowDirty });
      writeOutput(target, `${JSON.stringify(manifest, null, 2)}\n`, replacing);
      const pending = manifest.components.required.filter((c) => c.status === "pending").map((c) => c.name);
      console.log(`wrote ${target}\napp ${manifest.app.sha} dirty=${manifest.app.dirty} mode=${MODE} acceptance=not_accepted\npending pins: ${pending.join(", ") || "none"}`);
    } else if (command === "verify") {
      const file = resolve(root, args.positional[0] ?? DEFAULT_OUT);
      let manifest;
      try { manifest = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new Error(`cannot read manifest ${file}: ${error.message}`); }
      const problems = verifyManifest(root, manifest, { allowDirty: args.allowDirty });
      if (problems.length) { for (const p of problems) console.error(`FAIL ${p}`); process.exit(1); }
      console.log(`manifest consistent with checkout (${MODE}; not an acceptance result)`);
    } else {
      console.error("usage: node scripts/assembly-evidence.mjs build [--out file] [--allow-dirty] | verify [manifest] [--allow-dirty]");
      process.exit(2);
    }
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
