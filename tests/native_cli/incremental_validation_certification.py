"""#594: public incremental validation parity, avoided work, and recovery.

Usage: python3 incremental_validation_certification.py <noveltea> <repo-root>

No wall-clock assertions. Every reference validation opens an independent,
cache-free copy of the identical saved Project through the public direct CLI.
"""

import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


cli = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()


with tempfile.TemporaryDirectory(prefix="noveltea-incremental-certify-") as directory:
    root = Path(directory)
    env = os.environ.copy()
    env.pop("NOVELTEA_NO_DAEMON", None)
    env.update(NOVELTEA_VALIDATION_WORK_PROFILE="1",
               NOVELTEA_CLI_CERTIFICATION="1",
               NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT=str(root / "daemon"))

    def invoke(*args):
        result = subprocess.run([str(cli), "--json", *map(str, args)], env=env,
                                text=True, capture_output=True, timeout=180)
        assert not result.stderr, (args, result.stderr)
        assert result.stdout, (args, "CLI emitted no JSON", result.returncode, result.stderr)
        payload = json.loads(result.stdout)
        assert payload["exitCode"] == result.returncode, (args, payload, result.returncode)
        return payload

    def stop():
        assert invoke("daemon", "stop")["success"]

    def validate(project, direct=False):
        return invoke(*(["--no-daemon"] if direct else []), "--project", project, "validate")

    def validate_after_membership_change(project):
        # A directory rename may race an inotify event and a pinned-generation
        # proof. A transient conflict is conservative, but stable bytes must
        # eventually converge without requiring a daemon restart.
        deadline = time.monotonic() + 10
        while True:
            observed = validate(project)
            if not any(issue.get("code") == "WORKSPACE_REVISION_CONFLICT"
                       for issue in observed.get("diagnostics", [])):
                return observed
            if time.monotonic() >= deadline:
                raise AssertionError(("Membership change did not converge", project))
            time.sleep(0.12)

    def public(result):
        # Counter and cache-admission metadata are intentionally not part of
        # the public diagnostic/exit contract. Preserve complete diagnostics,
        # including severity, source path, line, column, and ordering.
        return {field: result.get(field) for field in
                ("success", "exitCode", "diagnostics", "error", "code")}

    def fresh_parity(project, observed):
        reference = root / "reference"
        if reference.exists():
            shutil.rmtree(reference)
        # Retain symlinks as links: following them would silently erase the
        # very containment violation this fresh authority must detect.
        shutil.copytree(project, reference, symlinks=True,
                        ignore=shutil.ignore_patterns(".noveltea"))
        expected = validate(reference, direct=True)
        assert public(observed) == public(expected), (
            project.name, observed.get("exitCode"), expected.get("exitCode"),
            observed.get("diagnostics", [])[:3], expected.get("diagnostics", [])[:3])
        return expected

    def portable_export_parity(project):
        # Portable Project export is byte-deterministic and excludes caches.
        # Compare real public daemon and independent direct CLI outputs, not
        # another in-test Project serialization implementation.
        reference = root / "export-reference"
        if reference.exists():
            shutil.rmtree(reference)
        shutil.copytree(project, reference, symlinks=True,
                        ignore=shutil.ignore_patterns(".noveltea"))
        exported = root / "resident.ntproject"
        fresh = root / "fresh.ntproject"
        for path in (exported, fresh):
            path.unlink(missing_ok=True)
        resident = invoke("--project", project, "project", "export", "--output", exported)
        cold = invoke("--no-daemon", "--project", reference,
                      "project", "export", "--output", fresh)
        assert resident["success"] and cold["success"], (resident, cold)
        assert hashlib.sha256(exported.read_bytes()).digest() == \
            hashlib.sha256(fresh.read_bytes()).digest(), "Portable export bytes diverged"

    def work(result, key):
        return result["validationWork"].get(key, 0)

    def no_stages(result):
        assert "validationWork" in result, result
        counters = result["validationWork"]
        for key in ("recheckedRecords", "recheckedContributions", "globalStageExecutions",
                    "localizationRebuilds", "fontCoverageRuns", "materialInterfaceValidations",
                    "shaderCompileRuns", "completeProjectProjected"):
            assert counters.get(key, 0) == 0, (key, counters)
        end = counters["endToEnd"]
        for key in ("recordContributions", "dependencyContributions", "localizationChecks",
                    "fontPreparations", "materialShaderPreparations"):
            assert end[key] == 0, (key, end)
        # Only Linux has the watcher evidence needed to retain the portable
        # proof between warm requests. Other hosts conservatively rerun it.
        if sys.platform.startswith("linux"):
            assert end["portableSourceChecks"] == 0, end

    def set_label(path, value):
        source = path.read_text()
        assert re.search(r"^label: .*$", source, flags=re.M), path
        path.write_text(re.sub(r"^label: .*$", f"label: {value}", source,
                               count=1, flags=re.M))

    try:
        for size in ("feature-lab", 1, 101, 501):
            project = root / str(size)
            if size == "feature-lab":
                shutil.copytree(repo / "tests/projects/feature-lab", project,
                                ignore=shutil.ignore_patterns(".noveltea"))
                room = project / "records/rooms/feature-lab-home.yaml"
            else:
                assert invoke("--no-daemon", "project", "create", project,
                              "--name", "Certification")["success"]
                assert invoke("--no-daemon", "--project", project, "entity", "create",
                              "rooms", "entry")["success"]
                room = project / "records/rooms/entry.yaml"
                original = room.read_text()
                for index in range(size - 1):
                    (room.parent / f"room-{index}.yaml").write_text(
                        original.replace("id: entry", f"id: room-{index}"))
                with (project / "project.yaml").open("a") as manifest:
                    manifest.write("\nentrypoint: { kind: room, id: entry }\n")

            stop()
            initial = validate(project)
            assert initial["success"], (size, initial)
            expected_records = size if isinstance(size, int) else 2
            assert work(initial, "recheckedRecords") >= expected_records, (size, initial)
            fresh_parity(project, initial)
            for _ in range(2):
                unchanged = validate(project)
                assert public(unchanged) == public(initial), size
                no_stages(unchanged)

            for index in range(2):
                set_label(room, f"Certification label {index}")
                saved = validate(project)
                assert saved["success"], (size, saved)
                assert work(saved, "recheckedRecords") == 1, (size, saved["validationWork"])
                assert work(saved, "recheckedContributions") == 1, (size, saved["validationWork"])
                assert public(saved) == public(initial), (size, public(saved))
                for stage in ("fontPreparations", "materialShaderPreparations",
                              "localizationChecks"):
                    assert saved["validationWork"]["endToEnd"][stage] == 0, (size, stage)
                # Semantic reuse must not hide the physical font proof work.
                physical = saved["validationWork"]["endToEnd"]
                assert physical["fontProofReads"] > 0, (size, physical)
                assert physical["fontProofHashes"] > 0, (size, physical)
                assert physical["fontProofReads"] == physical["fontProofHashes"], physical
                assert physical["fontBytesRead"] > 0, (size, physical)
                assert physical["fontBytesHashed"] > 0, (size, physical)
                assert physical["fileBytesRead"] >= physical["fontBytesRead"], physical
                assert physical["contentBytesHashed"] >= physical["fontBytesHashed"], physical
                assert physical["sourceGenerationFences"] > 0, (size, physical)
                assert physical["validationResponseSerializations"] > 0, (size, physical)
                assert physical["deferredPublications"] == 1, (size, physical)
                assert physical["stageLedgerSerializations"] == 1, (size, physical)
                for timed in ("completeProjectPreparationMicros",
                              "portableInputPreparationMicros",
                              "noticeInputPreparationMicros",
                              "stageLedgerConstructionMicros",
                              "stageLedgerJsonSerializationMicros",
                              "deferredPublicationMicros",
                              "validationResponseSerializationMicros"):
                    assert timed in physical and physical[timed] >= 0, (size, timed, physical)
                broker = saved["validationWork"].get("brokerAuthority", {})
                assert broker.get("brokerAuthorityObservations", 0) == 2, (size, broker)
                assert broker.get("brokerAuthorityMicros", 0) > 0, (size, broker)
                if sys.platform.startswith("linux"):
                    assert saved["validationWork"]["endToEnd"]["portableSourceChecks"] == 0
                    assert saved["validationWork"]["endToEnd"]["directoryEnumerations"] == 0
                no_stages(validate(project))
            fresh_parity(project, saved)

            # A persisted ledger is exercised by a genuinely restarted owner,
            # not an unchanged request to the still-live daemon.
            stop()
            cached = validate(project)
            assert public(cached) == public(saved), size
            assert work(cached, "recheckedRecords") == 0, (size, cached["validationWork"])
            no_stages(cached)
            fresh_parity(project, cached)

            # Corrupt optional evidence cannot make validation succeed with a
            # stale result or change the public diagnostics.
            stop()
            ledger = project / ".noveltea/cache/authoring/native-clean-current.json"
            assert ledger.is_file(), (size, ledger)
            ledger.write_bytes(b"{truncated")
            recovered = validate(project)
            assert public(recovered) == public(saved), (size, recovered)
            assert work(recovered, "recheckedRecords") > 0, (size, recovered["validationWork"])
            fresh_parity(project, recovered)

            # An invalid saved source must carry the same complete diagnostic
            # coordinates as fresh native validation. Cache the deterministic
            # failure, then repair it without retaining invalid findings.
            good = room.read_text()
            set_label(room, "[unterminated")
            invalid = validate(project)
            assert not invalid["success"] and invalid["diagnostics"], (size, invalid)
            fresh_parity(project, invalid)
            repeated = validate(project)
            assert public(repeated) == public(invalid), (size, repeated)
            room.write_text(good)
            repaired = validate(project)
            assert public(repaired) == public(saved), (size, repaired)
            fresh_parity(project, repaired)

            # A negative lookup uses the same CLI authority independently of
            # daemon residence. It may not borrow positive cached evidence.
            missing = invoke("--project", project, "entity", "inspect", "rooms",
                             "certification-missing")
            direct_missing = invoke("--no-daemon", "--project", project,
                                    "entity", "inspect", "rooms", "certification-missing")
            assert public(missing) == public(direct_missing), (size, missing, direct_missing)

            if size == 101:
                removable = project / "records/rooms/room-0.yaml"
                moved = project / "records/rooms/room-relocated.yaml"
                removable.rename(moved)
                fresh_parity(project, validate_after_membership_change(project))
                moved.unlink()
                fresh_parity(project, validate_after_membership_change(project))
                removable.write_text(original.replace("id: entry", "id: room-0"))
                fresh_parity(project, validate_after_membership_change(project))

            if size == "feature-lab" and os.name != "nt":
                escaped = root / "outside.lua"
                escaped.write_text("return 1\n")
                unsafe = project / "scripts/certification-escape.lua"
                unsafe.symlink_to(escaped)
                rejected = validate(project)
                assert not rejected["success"], rejected
                fresh_parity(project, rejected)
                unsafe.unlink()
                fresh_parity(project, validate(project))

            portable_export_parity(project)

            print(f"PASS: {size}: warm/unchanged/cold, fresh parity, corruption, "
                  "invalid diagnostics, negative lookup, recovery, export parity", flush=True)
    finally:
        stop()

print("Public incremental native validation certification passed")
