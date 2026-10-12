# GT-10B assembly-evidence manifest (snapshot tooling)

`scripts/assembly-evidence.mjs` writes an offline **snapshot** of what this checkout actually contains. It is
tooling for GT-10B.1/GT-10B.6 inputs. It is **not** an executed build, integration run, journey result, release
certification, or acceptance of any criterion. It makes no network or provider calls and reads no `.env` or data files.

```sh
node scripts/assembly-evidence.mjs build  [--out <file>] [--allow-dirty]
node scripts/assembly-evidence.mjs verify [<manifest>] [--allow-dirty]
```

Default output is `out/assembly-evidence/manifest.json` (git-ignored). `--out` accepts an explicit path outside the
repo, or inside it only if git ignores it and it is not tracked, so the app SHA is never committed into the app
(no recursive self-pin). There is deliberately no `package.json` script entry; run the file directly.

## Trust model and limits (read first)

- `manifestDigest` is an **unkeyed** SHA-256 of the canonical JSON. It catches accidental edits only and proves nothing
  about who produced the manifest; anyone can recompute it. Do not treat it as a signature or authenticity claim.
- `verify` therefore **recomputes every claim from the committed HEAD** and rejects any difference, any unknown key and
  any extra claim (a resealed "release certified" manifest fails).
- Two things cannot be recomputed later and are **build-time self-reports**: `toolchain.runtime` (whatever the building
  process said about itself) and `app.dirty` / `app.dirtyPaths` / `app.reproducible` (a dirty build relabelled clean
  after cleaning the tree is not detectable). `verify` checks only that they are well-formed and internally consistent.
- A vendored `commit` is copied from the tracked `MANIFEST.json`; it is **not** verified against the upstream repository
  (impossible offline). The repository URL is derived from the inventory, the commit is what the committed manifest says.
- Git is run with `--no-replace-objects` and without inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`, so local
  `refs/replace` objects cannot substitute HEAD content.
- Snapshot only: no command results, no acceptance, no release claim.

## What is recorded (all from committed HEAD blobs)

Everything below is read with `git ls-tree`/`git cat-file` from HEAD, never from the working tree. Ignored, untracked,
`.env*`, skip-worktree or locally modified files can never be opened or become a pin.

| Field | Source |
| --- | --- |
| `app` | `git rev-parse HEAD`, dirty path names (status, including untracked, plus skip-worktree/assume-unchanged entries) |
| `lockfile` | SHA-256 of `package-lock.json` at HEAD |
| `toolchain.declared` / `.runtime` | `package.json` engines and `packageManager` at HEAD vs the running Node and `npm --version` (self-reported), kept separate |
| `vendored` | each tracked `src/server/vendor/<name>/MANIFEST.json`: commit, per-file SHA-256. The repository must be exactly `https://github.com/<inventory organization>/<name>` (no credentials, no `.git`), `<name>` must be in the inventory, every tracked file in the module must be listed, and listed files must be regular tracked blobs |
| `components.required` | dependencies of the composition root in `integration/repository-map.json`: `installed-vendored` only if a tracked vendored module exists, otherwise `pending` with no commit or hash |
| `fixtures` | HEAD blobs under `fixtures/approval`, `fixtures/context`, `fixtures/order-authorization` with SHA-256 and a per-suite digest |
| `executed` | always `[]`; this tool records no command results |
| `acceptance` | always the fixed `not_accepted` object |

`integration/repository-map.json` is hashed only as planning inventory; it never counts as a pin. Components absent
from the checkout remain `pending` (GT-10B.1 is unmet until they have real revisions).

## Dirty-tree policy

`build` refuses a dirty tree (untracked files included, and skip-worktree/assume-unchanged paths). `--allow-dirty`
records `dirty: true`, `reproducible: false` and the dirty path names (hashes still come from HEAD); `verify` rejects
such manifests unless `--allow-dirty` is passed.

## Path safety

Vendored paths must be plain relative paths (no `..`, backslash, absolute, NUL, `.env*` or `.pem`) naming regular
tracked HEAD blobs; symlinks and submodules are refused. `--out` must have a value, may not go through a symlink, may not be named `.env*`/`*.pem`, and is compared by real
location (so `/tmp` vs `/private/tmp` aliases of the repo count as in-repo): in-repo targets must be git-ignored and
untracked. An existing target is overwritten only if it is a regular file that is itself an assembly-evidence manifest;
new files are created exclusively (temp file + link), previous manifests replaced by atomic rename.

## Verify

`verify` fails on: unknown or missing keys at any level, a digest mismatch, any claim differing from what HEAD derives
(lockfile, vendored, components, fixtures, acceptance, executed, declared toolchain), a wrong mode or app SHA, a pending
component carrying a pin, and inconsistent dirty/runtime self-reports. A pass means "consistent with this HEAD", nothing more.

Tests: `node --test tests/assembly-evidence.test.mjs` (synthetic temp git repos plus one check against this checkout).
