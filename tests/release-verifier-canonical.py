"""Actual pinned canonical validators over constructed MOCK protocol controls.

No owner execution or accepted release is represented by these fabricated records.
Run explicitly with Python3.13+ and a clean pinned integration-evals checkout;
missing prerequisites fail instead of skipping the canonical controls.
"""

from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest

if len(sys.argv) != 2 or sys.version_info < (3, 13):
    raise SystemExit("usage: Python3.13+ -I -B tests/release-verifier-canonical.py <pinned-evaluator-checkout>")
EVALUATOR = Path(sys.argv.pop()).resolve()
APP = Path(__file__).resolve().parents[1]
# Match the public wrapper's existing Git scopes for this direct prerequisite.
# Repository-local, include/includeIf and worktree configuration remain effective.
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
os.environ["GIT_CONFIG_GLOBAL"] = "/dev/null"
spec = importlib.util.spec_from_file_location("actual_release_bridge", APP / "scripts/lib/verify_release.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
PIN = json.loads((APP / "scripts/lib/release-evaluator-pin.json").read_text())
bridge.evaluator_source(EVALUATOR, PIN)
bridge.locked_dependencies(EVALUATOR)
sys.path.insert(0, str(EVALUATOR / "src"))
from integration_evals.artifacts import digest
from integration_evals.history import History
from integration_evals.history_archive import Successor
from integration_evals.models import Assembly, CaseResult, Component, Evidence, Mode, Origin, Outcome, Run, Status, Suite
from integration_evals.validation import REQUIRED_COMPONENTS, source_fingerprint

DATE = datetime(2026, 10, 13, tzinfo=timezone.utc)
NOTICE = "Constructed synthetic protocol control; no owner/provider execution or acceptance."


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=Release verifier control", "-c", "user.email=control@example.invalid",
                           "-C", str(root), *args], check=True, capture_output=True, text=True).stdout.strip()


class CanonicalControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="ticketstub-release-recovery-controls-")
        cls.root = Path(cls.temp.name)
        cls.workspace = cls.root / "components"
        cls.workspace.mkdir()
        cls.suite = Suite.model_validate_json((EVALUATOR / "scenarios/suite.json").read_bytes())
        names = set(REQUIRED_COMPONENTS)
        for case in cls.suite.cases:
            names.update((case.component, *case.dependencies, *case.artifact_producers))
        cls.names = sorted(names)
        cls.original = {}
        for name in cls.names:
            repo = cls.workspace / name
            if name == "integration-evals":
                subprocess.run(["git", "clone", "--shared", "--no-hardlinks", str(EVALUATOR), str(repo)], check=True, capture_output=True)
                git(repo, "checkout", "--detach", PIN["revision"])
            else:
                repo.mkdir()
                git(repo, "init", "--initial-branch=main")
                lock = "package-lock.json" if name == "getticketstub.com" else "lock.json"
                (repo / lock).write_text(json.dumps({"constructedMockProtocolControl": True}))
                if name == "getticketstub.com":
                    for file in ("scripts/verify-release.mjs", "scripts/lib/verify_release.py", "scripts/lib/release-evaluator-pin.json"):
                        target = repo / file
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(APP / file, target)
                    (repo / "configuration.json").write_text(json.dumps({"mode": "mock-only", "notice": NOTICE}))
                if name == "shared-contracts":
                    (repo / "contract.json").write_text(json.dumps({"accepted": False, "notice": NOTICE}))
                git(repo, "add", ".")
                git(repo, "commit", "-m", "Constructed protocol control, not a component implementation")
            cls.original[name] = git(repo, "rev-parse", "HEAD")
        cls.evaluator = cls.workspace / "integration-evals"
        cls.app = cls.workspace / "getticketstub.com"
        cls.source_digest = source_fingerprint(cls.evaluator)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        for name, revision in self.original.items():
            repo = self.workspace / name
            subprocess.run(["git", "-C", str(repo), "config", "--unset", "core.fsmonitor"], capture_output=True)
            for key in ("filter.probe.clean", "include.path", f"includeIf.gitdir:{repo}/.git.path", "extensions.worktreeConfig"):
                subprocess.run(["git", "-C", str(repo), "config", "--unset-all", key], capture_output=True)
            (repo / ".git/config.worktree").unlink(missing_ok=True)
            (repo / ".git/info/attributes").unlink(missing_ok=True)
            if name == "integration-evals":
                git(repo, "update-index", "--no-assume-unchanged", "src/integration_evals/models.py")
                shutil.rmtree(repo / "src/integration_evals/__pycache__", ignore_errors=True)
            git(repo, "reset", "--hard", revision)
            (repo / "untracked-control.txt").unlink(missing_ok=True)
        self.reports = self.root / "reports"
        shutil.rmtree(self.reports, ignore_errors=True)
        self.directory = self.reports / "constructed-original"
        self.directory.mkdir(parents=True)
        self.manifest = self.root / "constructed-assembly.json"
        self.sentinel = self.root / "OWNER_COMMAND_MUST_NOT_RUN"
        self.sentinel.unlink(missing_ok=True)
        components = []
        for name in self.names:
            repo = self.workspace / name
            lock = "uv.lock" if name == "integration-evals" else "package-lock.json" if name == "getticketstub.com" else "lock.json"
            components.append(Component(repository=name, revision=git(repo, "rev-parse", "HEAD"), tree=git(repo, "rev-parse", "HEAD^{tree}"),
                                        lockfile_path=lock, lockfile_digest=digest((repo / lock).read_bytes()),
                                        command=(sys.executable, "-c", f"open({str(self.sentinel)!r}, 'w').write('unexpected execution')"),
                                        cleanup_command=(sys.executable, "-c", f"open({str(self.sentinel)!r}, 'w').write('unexpected cleanup')")))
        self.assembly = Assembly(owner="getticketstub.com", kind="composed", integration_revision=PIN["revision"], components=tuple(components),
                                 contract_digest=digest((self.workspace / "shared-contracts/contract.json").read_bytes()),
                                 contract_artifact_path="contract.json", fixture_digest=digest((self.evaluator / "fixtures/catalog.json").read_bytes()),
                                 runtime=sys.version, configuration_digest=digest((self.app / "configuration.json").read_bytes()),
                                 configuration_component="getticketstub.com", configuration_artifact_path="configuration.json")
        self.manifest.write_text(self.assembly.model_dump_json(indent=2))
        evidence, results = [], []
        revisions = {component.repository: component.revision for component in components}
        for index, case in enumerate(self.suite.cases):
            ids = []
            for kind in case.required_evidence_kinds:
                identity = f"constructed-{index}-{kind}"
                path = f"{identity}.json"
                data = json.dumps({"notice": NOTICE, "case": case.id, "kind": kind}).encode()
                (self.directory / path).write_bytes(data)
                producer = (case.artifact_producers or (case.component,))[0]
                evidence.append(Evidence(id=identity, requirement=case.requirements[0], case_id=case.id, run_id=self.directory.name,
                                         component=producer, revision=revisions[producer], created_at=DATE, original_cutoff=DATE,
                                         mode=Mode.MOCK, origin=Origin.SYNTHETIC, path=path, sha256=digest(data),
                                         permission_ref="constructed-control", redaction_ref="no-private-material", reviewer_access_ref="local-control",
                                         kind=kind, limitations=(NOTICE,)))
                ids.append(identity)
            results.append(CaseResult(case_id=case.id, requirements=case.requirements, outcome=Outcome.PASSED, criterion_status=Status.IN_PROGRESS,
                                      mode=Mode.MOCK, origin=Origin.SYNTHETIC, duration_seconds=0.0, evidence_ids=tuple(ids), exit_code=0, cleanup_status="passed"))
        self.run = Run(id=self.directory.name, started_at=DATE, context="local", selected_case_ids=tuple(case.id for case in self.suite.cases),
                       integration_revision=PIN["revision"], source_digest=self.source_digest, working_tree_dirty=False,
                       manifest_digest=digest(self.manifest.read_bytes()), suite_digest=digest(self.suite.model_dump_json().encode()),
                       fixture_digest=self.assembly.fixture_digest, configuration_digest=self.assembly.configuration_digest, runtime=sys.version,
                       seed=1, clock=DATE, components=tuple(components), providers=(), results=tuple(results), evidence=tuple(evidence), limitations=(NOTICE,))
        self.save()

    def save(self, history=None, directory=None):
        history = history or History(runs=(self.run,))
        directory = directory or self.directory
        (directory / "run.json").write_text(history.runs[-1].model_dump_json(indent=2))
        (directory / "history.json").write_text(history.model_dump_json(indent=2))

    def set_manifest(self, **changes):
        self.assembly = self.assembly.model_copy(update=changes)
        self.manifest.write_text(self.assembly.model_dump_json(indent=2))

    def invoke(self, code):
        result = subprocess.run(["node", str(self.app / "scripts/verify-release.mjs"), "--manifest", str(self.manifest),
                                 "--evidence-dir", str(self.directory), "--workspace", str(self.workspace), "--python", sys.executable], capture_output=True, text=True, timeout=70)
        receipt = json.loads(result.stdout)
        self.assertFalse(self.sentinel.exists(), "an owner, cleanup or repository-configured filter command was executed")
        self.assertEqual(receipt["code"], code, receipt)
        self.assertEqual(result.returncode, 0 if code == "release_evidence_consistent" else 2)
        self.assertEqual(receipt["passed"], code == "release_evidence_consistent")
        self.assertEqual(receipt["acceptance"], "not_recorded")
        self.assertNotIn(str(self.root), result.stdout, "private filesystem input echoed")
        return receipt

    def test_constructed_mock_consistency_is_not_acceptance_or_execution(self):
        receipt = self.invoke("release_evidence_consistent")
        self.assertEqual(receipt["requiredCases"], 42)
        self.assertEqual(receipt["modes"], ["mock-only"])
        self.assertEqual(receipt["app"]["revision"], self.original["getticketstub.com"])

    def test_missing_manifest(self):
        self.manifest.unlink()
        self.invoke("release_manifest_unavailable")

    def test_snapshot_is_not_canonical_manifest(self):
        self.manifest.write_text('{"schemaVersion":1,"executed":[],"acceptance":"not_accepted"}')
        self.invoke("release_manifest_schema_unsupported")

    def test_unsupported_schema(self):
        self.manifest.write_text('{"schema_version":"2.0"}')
        self.invoke("release_manifest_schema_unsupported")

    def test_malformed_manifest(self):
        self.manifest.write_text('{')
        self.invoke("release_manifest_json_invalid")

    def test_unknown_acceptance_field(self):
        value = json.loads(self.manifest.read_text())
        value["accepted"] = True
        self.manifest.write_text(json.dumps(value))
        self.invoke("canonical_validation_rejected")

    def test_missing_run(self):
        (self.directory / "run.json").unlink()
        self.invoke("release_composed_evidence_missing")

    def test_missing_history(self):
        (self.directory / "history.json").unlink()
        self.invoke("release_composed_evidence_missing")

    def test_stale_evaluator_revision_even_same_tree(self):
        git(self.evaluator, "commit", "--allow-empty", "-m", "Different evaluator identity control")
        self.invoke("release_evaluator_pin_mismatch")

    def test_dirty_evaluator(self):
        (self.evaluator / "untracked-control.txt").write_text("unclaimed source")
        self.invoke("release_evaluator_checkout_dirty")

    def test_evaluator_hidden_modified_index(self):
        git(self.evaluator, "update-index", "--assume-unchanged", "src/integration_evals/models.py")
        with (self.evaluator / "src/integration_evals/models.py").open("a") as output:
            output.write("\n# hidden source control\n")
        self.invoke("release_evaluator_index_flags")

    def test_ignored_import_bytecode(self):
        directory = self.evaluator / "src/integration_evals/__pycache__"
        directory.mkdir()
        (directory / "models.cpython-313.pyc").write_bytes(b"ignored stale bytecode")
        self.invoke("release_evaluator_ignored_import_input")

    def test_dirty_app(self):
        (self.app / "untracked-control.txt").write_text("unclaimed app source")
        self.invoke("release_app_checkout_dirty")

    def test_wrong_component_revision(self):
        changed = tuple(c.model_copy(update={"revision": "a" * 40}) if c.repository == "shared-contracts" else c for c in self.assembly.components)
        self.set_manifest(components=changed)
        self.invoke("checkout_pin_mismatch")

    def test_missing_component_pin(self):
        self.set_manifest(components=tuple(c for c in self.assembly.components if c.repository != "agent-harness"))
        self.invoke("missing_component_pin")

    def test_component_only_manifest(self):
        self.set_manifest(kind="component")
        self.invoke("release_composed_manifest_required")

    def test_selected_subset(self):
        self.set_manifest(selected_cases=(self.suite.cases[0].id,))
        self.invoke("release_full_selection_required")

    def test_wrong_fixture_catalog_digest(self):
        self.set_manifest(fixture_digest="a" * 64)
        self.invoke("catalog_pin_mismatch")

    def test_wrong_run_manifest_digest(self):
        self.run = self.run.model_copy(update={"manifest_digest": "a" * 64})
        self.save()
        self.invoke("release_run_manifest_digest_mismatch")

    def test_wrong_run_source_digest(self):
        self.run = self.run.model_copy(update={"source_digest": "a" * 64})
        self.save()
        self.invoke("release_run_source_digest_mismatch")

    def test_canonical_git_reads_do_not_execute_repository_fsmonitor(self):
        hook = self.root / "unexpected-fsmonitor"
        hook.write_text("#!/bin/sh\nprintf unexpected > " + shlex.quote(str(self.sentinel)) + "\n")
        hook.chmod(0o700)
        git(self.workspace / "shared-contracts", "config", "core.fsmonitor", str(hook))
        self.invoke("release_evidence_consistent")

    def configure_clean_filter(self, repository, *, configuration="local"):
        repo = self.workspace / repository
        relative = "configuration.json" if repository == "getticketstub.com" else "contract.json"
        hook = self.root / "unexpected-clean-filter"
        hook.write_text("#!/bin/sh\nprintf unexpected > " + shlex.quote(str(self.sentinel)) + "\ncat\n")
        hook.chmod(0o700)
        if configuration in {"include", "conditional"}:
            config = self.root / "included-filter-config"
            git(repo, "config", "--file", str(config), "filter.probe.clean", str(hook))
            key = "include.path" if configuration == "include" else f"includeIf.gitdir:{repo}/.git.path"
            git(repo, "config", key, str(config))
        elif configuration == "worktree":
            git(repo, "config", "extensions.worktreeConfig", "true")
            git(repo, "config", "--worktree", "filter.probe.clean", str(hook))
        else:
            git(repo, "config", "filter.probe.clean", str(hook))
        (repo / ".git/info/attributes").write_text(f"{relative} filter=probe\n")
        # Same committed bytes, different inode: status must compare content, not
        # trust the old stat cache. The original candidate runs the clean hook.
        target = repo / relative
        replacement = self.root / "same-bytes-new-inode"
        replacement.write_bytes(target.read_bytes())
        replacement.replace(target)

    def test_app_clean_filter_is_refused_before_status(self):
        self.configure_clean_filter("getticketstub.com")
        self.invoke("release_git_filter_configuration_rejected")

    def test_component_clean_filter_is_refused_before_canonical_status(self):
        self.configure_clean_filter("shared-contracts")
        self.invoke("release_git_filter_configuration_rejected")

    def test_included_clean_filter_is_refused_without_echo(self):
        self.configure_clean_filter("shared-contracts", configuration="include")
        self.invoke("release_git_filter_configuration_rejected")

    def test_conditional_clean_filter_is_refused_without_echo(self):
        self.configure_clean_filter("shared-contracts", configuration="conditional")
        self.invoke("release_git_filter_configuration_rejected")

    def test_worktree_clean_filter_is_refused_without_echo(self):
        self.configure_clean_filter("shared-contracts", configuration="worktree")
        self.invoke("release_git_filter_configuration_rejected")

    def test_gitlink_is_refused_before_recursive_submodule_status(self):
        git(self.app, "update-index", "--add", "--cacheinfo", f"160000,{self.original['getticketstub.com']},nested-owner")
        self.invoke("release_git_submodules_unsupported")

    def test_head_gitlink_removed_from_index_is_still_refused(self):
        git(self.app, "update-index", "--add", "--cacheinfo", f"160000,{self.original['getticketstub.com']},nested-owner")
        git(self.app, "commit", "-m", "Constructed HEAD gitlink control")
        git(self.app, "update-index", "--force-remove", "nested-owner")
        self.invoke("release_git_submodules_unsupported")

    def test_component_path_escape_is_refused_before_preflight(self):
        outside = self.assembly.components[0].model_copy(update={"repository": ".."})
        self.set_manifest(components=(*self.assembly.components, outside))
        self.invoke("unsafe_path")

    def test_archived_suite_cannot_replace_canonical_selection(self):
        fake = self.suite.model_copy(update={"cases": self.suite.cases[:1]})
        (self.directory / "suite.json").write_text(fake.model_dump_json())
        self.run = self.run.model_copy(update={"suite_digest": digest(fake.model_dump_json().encode())})
        self.save()
        self.invoke("archived_suite_pin_mismatch")

    def test_actual_artifact_hash_mismatch(self):
        (self.directory / self.run.evidence[0].path).write_text("changed evidence")
        self.invoke("evidence_digest_mismatch")

    def test_required_skip(self):
        result = self.run.results[0].model_copy(update={"outcome": Outcome.SKIPPED, "criterion_status": Status.BLOCKED, "reason": "Unavailable synthetic control"})
        self.run = self.run.model_copy(update={"results": (result, *self.run.results[1:])})
        self.save()
        self.invoke("release_required_case_not_passed")

    def test_unknown_cleanup(self):
        result = self.run.results[0].model_copy(update={"cleanup_status": "unknown"})
        self.run = self.run.model_copy(update={"results": (result, *self.run.results[1:])})
        self.save()
        self.invoke("release_required_cleanup_or_exit_failed")

    def test_nonzero_exit(self):
        result = self.run.results[0].model_copy(update={"exit_code": 1})
        self.run = self.run.model_copy(update={"results": (result, *self.run.results[1:])})
        self.save()
        self.invoke("release_required_cleanup_or_exit_failed")

    def test_missing_reserved_successor(self):
        (self.directory / "successor.json").write_text(Successor(run_id="constructed-missing", history_digest="a" * 64).model_dump_json())
        self.invoke("canonical_validation_rejected")

    def test_latest_only_history(self):
        self.run = self.run.model_copy(update={"attempt": 1, "parent_id": "omitted-original", "rationale": NOTICE})
        self.save()
        self.invoke("rerun_history_incomplete")

    def test_actual_failed_ancestor_still_blocks_after_saved_pass(self):
        failing = self.run.model_copy(update={"results": (self.run.results[0].model_copy(update={"outcome": Outcome.FAILED}), *self.run.results[1:])})
        self.save(History(runs=(failing,)))
        following = self.reports / "constructed-later-pass"
        following.mkdir()
        evidence = tuple(item.model_copy(update={"run_id": following.name}) for item in self.run.evidence)
        for item in evidence:
            shutil.copyfile(self.directory / item.path, following / item.path)
        succeeding = self.run.model_copy(update={"id": following.name, "parent_id": failing.id, "attempt": 1,
                                               "started_at": DATE + timedelta(seconds=1), "rationale": NOTICE, "evidence": evidence})
        history = History(runs=(failing, succeeding))
        self.save(history, following)
        (self.directory / "successor.json").write_text(Successor(run_id=following.name, history_digest=digest(history.model_dump_json().encode())).model_dump_json())
        self.invoke("release_required_case_not_passed")

    def test_sensitive_input_is_rejected_without_echo(self):
        self.manifest.write_text(self.manifest.read_text().replace('"composed"', '"IE_SECRET_CANARY_RELEASE_TEST"'))
        self.invoke("sensitive_content")

    def test_duplicate_manifest_keys(self):
        raw = self.manifest.read_text().replace('"owner": "getticketstub.com"', '"owner": "wrong", "owner": "getticketstub.com"')
        self.manifest.write_text(raw)
        # The pinned canonical leak policy deliberately groups ambiguous JSON
        # under this safe code; it never accepts the last duplicate value.
        self.invoke("sensitive_content")


if __name__ == "__main__":
    unittest.main(verbosity=2)
