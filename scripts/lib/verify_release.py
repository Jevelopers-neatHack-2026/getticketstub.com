"""Thin, read-only adapter to an exact canonical integration-evals checkout.

Canonical schemas, coverage, artifact and complete-history rules are imported, not
reimplemented. This gate checks consistency, not authenticity or owner acceptance.
"""

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tomllib

SCHEMA = "ticketstub.release-verification/1"
MAX_BYTES = 8 * 1024 * 1024


class Rejected(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise Rejected(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path, code):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source:
            require(stat.S_ISREG(os.fstat(source.fileno()).st_mode), code)
            data = source.read(MAX_BYTES + 1)
    except OSError as error:
        raise Rejected(code) from error
    require(len(data) <= MAX_BYTES, "release_input_oversized")
    return data


def git(root, *args, no_match_ok=False):
    try:
        result = subprocess.run([
            "git", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
            "-C", str(root), *args,
        ], capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as error:
        raise Rejected("release_git_unavailable") from error
    require(max(len(result.stdout), len(result.stderr)) <= MAX_BYTES, "release_git_output_oversized")
    # git config --get-regexp reports no matching keys as exit1 with no output.
    # Other errors, including configuration parse errors, must remain failures.
    if no_match_ok and result.returncode == 1 and not result.stdout and not result.stderr:
        return ""
    require(result.returncode == 0, "release_git_unavailable")
    value = result.stdout.decode("utf-8")
    return value if "-z" in args else value.strip()


def safe_status_configuration(root):
    # Status can execute a clean filter while comparing unchanged working bytes.
    # Query effective keys (including conditional includes/worktree config), never values.
    # Do not alter another owner's configuration or silently ignore dirty inputs.
    require(not git(root, "config", "--includes", "--name-only", "--get-regexp", r"^filter\.", no_match_ok=True),
            "release_git_filter_configuration_rejected")
    # Status can recurse into a submodule's separately configured repository.
    # Reject both staged gitlinks and HEAD gitlinks removed from the index.
    for args in (("ls-files", "--stage", "-z"), ("ls-tree", "-r", "-z", "HEAD")):
        require(not any(record.startswith("160000 ") for record in git(root, *args).split("\0")),
                "release_git_submodules_unsupported")


def clean_checkout(root, label):
    require(root.is_dir() and not root.is_symlink(), f"release_{label}_checkout_missing")
    require(Path(git(root, "rev-parse", "--show-toplevel")).resolve() == root.resolve(), f"release_{label}_checkout_invalid")
    revision, tree = git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD^{tree}")
    require(re.fullmatch(r"[a-f0-9]{40}", revision) and re.fullmatch(r"[a-f0-9]{40}", tree), "release_git_identity_invalid")
    safe_status_configuration(root)
    require(not git(root, "status", "--porcelain", "--untracked-files=all"), f"release_{label}_checkout_dirty")
    # Ordinary status alone cannot detect assume-unchanged / skip-worktree inputs.
    require(all(item.startswith("H ") for item in git(root, "ls-files", "-v", "-z").split("\0") if item), f"release_{label}_index_flags")
    return {"revision": revision, "tree": tree}


def evaluator_source(root, pin):
    state = clean_checkout(root, "evaluator")
    require(state == {"revision": pin["revision"], "tree": pin["tree"]}, "release_evaluator_pin_mismatch")
    require(digest(read_regular(root / "uv.lock", "release_evaluator_lock_missing")) == pin["lockfileSha256"], "release_evaluator_lock_mismatch")
    require(not git(root, "ls-files", "--others", "--ignored", "--exclude-standard", "--", "src/integration_evals"), "release_evaluator_ignored_import_input")
    # Verify imported working bytes against immutable Git blobs before Python sees them.
    for record in git(root, "ls-tree", "-r", "-z", "HEAD", "--", "src/integration_evals").split("\0"):
        if not record:
            continue
        metadata, name = record.split("\t", 1)
        mode, kind, oid = metadata.split()
        require(mode in {"100644", "100755"} and kind == "blob", "release_evaluator_source_type_invalid")
        data = read_regular(root / name, "release_evaluator_source_unavailable")
        actual = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        require(actual == oid, "release_evaluator_source_mismatch")
    return state


def locked_dependencies(root):
    packages = {entry["name"]: entry.get("version") for entry in tomllib.loads(read_regular(root / "uv.lock", "release_evaluator_lock_missing").decode())["package"]}
    for name in ("pydantic", "pydantic-core", "annotated-types", "typing-extensions", "typing-inspection"):
        try:
            installed = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as error:
            raise Rejected("release_validator_dependency_missing") from error
        require(installed == packages[name], "release_validator_dependency_mismatch")


def composed_outcomes(assembly, history, suite, manifest_digest, source_digest):
    required_cases = {case.id for case in suite.cases}
    require(assembly.kind == "composed" and assembly.owner == "getticketstub.com", "release_composed_manifest_required")
    require(assembly.selected_cases is None or set(assembly.selected_cases) == required_cases, "release_full_selection_required")
    require(not history.quarantines and not any(case.quarantined for case in suite.cases if case.mandatory), "release_required_case_quarantined")
    for run in history.runs:
        require(run.scope == "composed" and not run.working_tree_dirty, "release_composed_clean_run_required")
        require(run.execution_kind == "owner-execution", "release_owner_execution_required")
        require(set(run.selected_case_ids) == required_cases, "release_full_run_required")
        for field, expected in {
            "integration_revision": assembly.integration_revision,
            "source_digest": source_digest, "manifest_digest": manifest_digest,
            "fixture_digest": assembly.fixture_digest, "configuration_digest": assembly.configuration_digest,
            "runtime": assembly.runtime, "components": assembly.components, "providers": assembly.providers,
        }.items():
            require(getattr(run, field) == expected, f"release_run_{field}_mismatch")
        outcomes = {result.case_id: result for result in run.results}
        for case in suite.cases:
            if not case.mandatory:
                continue
            result = outcomes.get(case.id)
            require(result is not None and result.outcome.value == "passed", "release_required_case_not_passed")
            require(result.exit_code == 0 and result.cleanup_status == "passed", "release_required_cleanup_or_exit_failed")


def verify(app, manifest, evidence, workspace):
    require(sys.version_info >= (3, 13), "release_python_313_required")
    raw = read_regular(manifest, "release_manifest_unavailable")
    try:
        shape = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise Rejected("release_manifest_json_invalid") from error
    require(isinstance(shape, dict) and shape.get("schema_version") == "1.0", "release_manifest_schema_unsupported")
    require(evidence.is_dir() and not evidence.is_symlink(), "release_composed_evidence_missing")
    for name in ("run.json", "history.json"):
        read_regular(evidence / name, "release_composed_evidence_missing")
    require(workspace.is_dir(), "release_workspace_missing")
    app_state = clean_checkout(app, "app")
    require((workspace / "getticketstub.com").resolve() == app.resolve(), "release_app_checkout_mismatch")
    pin = json.loads(read_regular(app / "scripts/lib/release-evaluator-pin.json", "release_evaluator_pin_missing"))
    evaluator = workspace / "integration-evals"
    evaluator_state = evaluator_source(evaluator, pin)
    locked_dependencies(evaluator)
    sys.path.insert(0, str(evaluator / "src"))
    # No runner, owner, provider or history-write API is called.
    from integration_evals.artifacts import confined_path, load_record, reject_leaks
    from integration_evals.history import summarize_history
    from integration_evals.history_archive import load_history
    from integration_evals.models import Assembly, Catalog, Selection, Suite
    from integration_evals.report_models import Tracker
    from integration_evals.specifications import Requirements
    from integration_evals.validation import source_fingerprint, validate_assembly, validate_catalog, validate_suite

    reject_leaks(raw, "assembly")
    assembly = Assembly.model_validate_json(raw)
    require(assembly.kind == "composed" and assembly.owner == "getticketstub.com", "release_composed_manifest_required")
    require(assembly.integration_revision == pin["revision"], "release_manifest_evaluator_pin_mismatch")
    for component in assembly.components:
        expected = {"getticketstub.com": "package-lock.json", "integration-evals": "uv.lock"}.get(component.repository)
        require(expected is None or component.lockfile_path == expected, "release_component_lockfile_invalid")
    tracker = load_record(evaluator / "planning/acceptance-checklist.json", Tracker)
    local = load_record(evaluator / "planning/requirements.json", Requirements)
    requirements = frozenset(item.id for item in tracker.criteria) | frozenset(item.id for item in local.leaves)
    catalog_file = evaluator / "fixtures/catalog.json"
    catalog = load_record(catalog_file, Catalog)
    suite = load_record(evaluator / "scenarios/suite.json", Suite)
    selection = load_record(evaluator / "scenarios/selection.json", Selection)
    validate_catalog(catalog, evaluator / "fixtures", requirements)
    validate_suite(suite, catalog, requirements, selection)
    require(assembly.selected_cases is None or set(assembly.selected_cases) == {case.id for case in suite.cases}, "release_full_selection_required")
    # Canonical validate_component performs its own status call. Preflight every
    # component before entering that foreign validator, not only afterwards.
    states = {}
    for component in assembly.components:
        # Preserve canonical confinement before moving Git reads ahead of it.
        confined_path(workspace, component.repository)
        states[component.repository] = clean_checkout(workspace / component.repository, "component")
    validate_assembly(assembly, workspace, digest(read_regular(catalog_file, "release_catalog_missing")))
    require(states["getticketstub.com"] == app_state, "release_app_changed_during_validation")
    history = load_history(evidence, suite)
    composed_outcomes(assembly, history, suite, digest(raw), source_fingerprint(evaluator))
    require(not any(row.release_blocked for row in summarize_history(history, suite)), "release_history_blocked")
    # A later history append, changed source or replaced manifest cannot become this pass.
    require(read_regular(manifest, "release_manifest_unavailable") == raw, "release_manifest_changed_during_validation")
    require(load_history(evidence, suite) == history, "release_history_changed_during_validation")
    for repository, state in states.items():
        require(clean_checkout(workspace / repository, "component") == state, "release_component_changed_during_validation")
    require(evaluator_source(evaluator, pin) == evaluator_state, "release_evaluator_changed_during_validation")
    return {
        "schema": SCHEMA, "passed": True, "code": "release_evidence_consistent", "acceptance": "not_recorded",
        "app": app_state, "evaluator": evaluator_state, "manifestSha256": digest(raw),
        "historySha256": digest(history.model_dump_json().encode()), "requiredCases": sum(case.mandatory for case in suite.cases),
        "retainedRuns": len(history.runs), "requiredPassedSamples": sum(case.mandatory for case in suite.cases) * len(history.runs),
        "evidenceItems": sum(len(run.evidence) for run in history.runs),
        "modes": sorted({result.mode.value for run in history.runs for result in run.results}),
        "limits": ["Evidence consistency is not authenticity or accountable acceptance.",
                   "No assembly commands, provider requests, deployment or tracker updates were executed."],
    }


def main(argv):
    try:
        require(len(argv) == 4, "release_arguments_invalid")
        result = verify(*(Path(value) for value in argv))
    except Exception as error:
        code = getattr(error, "code", None)
        if not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code):
            code = "canonical_validation_rejected"
        result = {"schema": SCHEMA, "passed": False, "code": code, "acceptance": "not_recorded"}
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
