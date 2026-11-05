"""#594: public incremental validation parity, avoided work, and recovery.

Usage: python3 incremental_validation_certification.py <noveltea> <repo-root>
       [feature-lab|1|101|501 ...]

No wall-clock assertions. Every reference validation opens an independent,
cache-free copy of the identical saved Project through the public direct CLI.
"""

import json
import hashlib
from contextlib import contextmanager
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
selected = set(sys.argv[3:]) if len(sys.argv) > 3 else {"feature-lab", "1", "101", "501"}
assert selected and selected <= {"feature-lab", "1", "101", "501"}, selected


# macOS temp paths usually live under /var/folders/<hash>/T. Adding the
# daemon's endpoint identity can exceed Darwin's 104-byte sun_path limit.
# Keep the private Project and runtime under a short, mode-0700 /tmp root.
macos = sys.platform == "darwin"
with tempfile.TemporaryDirectory(
        prefix="nt-inc-" if macos else "noveltea-incremental-certify-",
        dir="/tmp" if macos else None) as directory:
    root = Path(directory)
    env = os.environ.copy()
    env.pop("NOVELTEA_NO_DAEMON", None)
    env.update(NOVELTEA_VALIDATION_WORK_PROFILE="1",
               NOVELTEA_CLI_CERTIFICATION="1",
               NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT=str(root / ("d" if macos else "daemon")))

    def invoke(*args):
        result = subprocess.run([str(cli), "--json", *map(str, args)], env=env,
                                text=True, capture_output=True, timeout=180)
        assert not result.stderr, (args, result.stderr)
        assert result.stdout, (args, "CLI emitted no JSON", result.returncode, result.stderr)
        payload = json.loads(result.stdout)
        assert payload["exitCode"] == result.returncode, (args, payload, result.returncode)
        return payload

    def stop():
        stopped = invoke("daemon", "stop")
        assert stopped["success"], ("Daemon shutdown failed", stopped)
        # A cache-corruption test must not accidentally exercise a still-live
        # resident owner (or race its final clean-ledger publication).
        status = invoke("daemon", "status")["daemon"]
        assert not status["running"], ("Daemon survived stop", status)

    def validate(project, direct=False):
        return invoke(*(["--no-daemon"] if direct else []), "--project", project, "validate")

    def validate_without_profile(project):
        # Exercise the broker's public exact-result shortcut, which profiling disables.
        plain_env = {key: value for key, value in env.items()
                     if key != "NOVELTEA_VALIDATION_WORK_PROFILE"}
        result = subprocess.run([str(cli), "--json", "--project", str(project), "validate"],
                                env=plain_env, text=True, capture_output=True, timeout=180)
        assert not result.stderr, result.stderr
        payload = json.loads(result.stdout)
        assert payload["exitCode"] == result.returncode, payload
        assert "validationWork" not in payload, payload
        return payload

    @contextmanager
    def exclusive_cache_lease(project):
        # The daemon's stop acknowledgement can precede its owner's final
        # shutdown flush. Hold its stable OS lock so a late writer cannot
        # replace the deliberately corrupted ledger during the direct test.
        lock = project / ".noveltea/cache/authoring/native-clean-writer.lock"
        deadline = time.monotonic() + 15
        with lock.open("a+b") as stream:
            while True:
                try:
                    stream.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise AssertionError(("Departing cache writer retained lease", project))
                    time.sleep(.05)
            try:
                yield
            finally:
                stream.seek(0)
                if os.name == "nt":
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

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
        if public(observed) != public(expected) and any(
                issue.get("code") == "WORKSPACE_REVISION_CONFLICT"
                for issue in observed.get("diagnostics", [])):
            # A source-generation conflict is a safe response during a
            # background cache-writer publication, not the final diagnostics
            # for a stable malformed Project. Demand convergence to the fresh
            # cold authority within the same 10-second bound used after
            # membership changes, including on macOS full-scan fallback.
            observed = validate_after_membership_change(project)
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
        # Reliable monitors retain the watched generation. Unsupported
        # monitors instead re-prove exact source bytes by full observation.
        # Neither situation requires rebuilding the complete Project.
        assert end["portableSourceChecks"] == 0, end
        for key in ("completeProjectPreparations", "completeProjectPhysicalProjections",
                    "completeProjectSerializationMicros", "completeProjectBytesSerialized"):
            assert end[key] == 0, (key, end)

    def warm_stage_proofs(result):
        """Reused semantic stages must also avoid physical proof/rebuild work."""
        counters = result["validationWork"]
        physical = counters["endToEnd"]
        for key in ("fontPreparations", "materialShaderPreparations",
                    "portableSourceChecks", "fullResultAssemblies",
                    "completeProjectPreparations", "completeProjectPhysicalProjections",
                    "completeProjectBytesSerialized", "stageLedgerSerializations",
                    "stageLedgerBytesSerialized", "stageLedgerConstructionMicros",
                    "stageLedgerJsonSerializationMicros"):
            assert physical[key] == 0, (key, physical)
        for key in ("fontCoverageRuns", "shaderCompileRuns"):
            assert work(result, key) == 0, (key, counters)
        for key in ("fontInputReuses", "materialInputReuses", "portableSourceReuses",
                    "noticeValidationReuses"):
            assert work(result, key) == 1, (key, counters)
        if sys.platform.startswith("linux") and "shaderStageReuses" in counters:
            # Watched source generations permit reuse with zero physical
            # cache proofs, not merely zero shader/coverage semantic runs.
            assert work(result, "shaderStageReuses") == 1, counters
        if work(result, "shaderStageReuses"):
            for key in ("shaderOutputProofs", "shaderValidationCalls",
                        "materialInterfaceValidations"):
                assert work(result, key) == 0, (key, counters)
            assert physical["shaderValidationMicros"] == 0, physical
            for key in ("shaderProofReads", "shaderProofHashes", "shaderBytesRead",
                        "shaderBytesHashed"):
                assert physical[key] == 0, (key, physical)
        elif "shaderStageReuses" not in counters:
            # A minimal Room-only fixture has no shader stage to reuse.
            assert physical["shaderProofReads"] == physical["shaderProofHashes"] == 0
        if sys.platform.startswith("linux"):
            for key in ("fontProofReads", "fontProofHashes", "fontBytesRead",
                        "fontBytesHashed"):
                assert physical[key] == 0, (key, physical, counters.get("sessionAdmissions"),
                                            counters.get("semanticFallbackReasons"),
                                            counters.get("coldValidationFallback"))
        # A healthy resident source generation must not reread unchanged
        # binary Assets merely to validate a Room presentation-only edit.
        # Transaction CAS, uncertain watcher recovery and cold admission
        # retain their independently stricter integrity contracts.
        if sys.platform.startswith("linux"):
            assert physical["generationAssetProofReads"] == 0, physical
            assert physical["generationAssetBytesRead"] == 0, physical
            # Inode notifications can arrive after the edited Room has
            # already been reconciled. Two unchanged text sources may then
            # require an additional exact-byte proof, but not extra YAML
            # record reparses, broad directory scans, or downstream stages.
            # The saved-record assertions above impose the same bounded
            # three-read budget; do not contradict them in this helper.
            assert physical["fileByteReads"] <= 3, physical
            assert physical["parsedYaml"] <= 1, physical
            assert physical["directoryEnumerations"] == 0, physical
            assert physical["fontCoverageMicros"] == 0, physical

    def certify_unchanged_resident(project, result):
        # A retained ProjectSession does not necessarily mean its external
        # stage projections survived host watcher recovery. On Windows and
        # macOS, an unchanged request can conservatively rebuild that input
        # once even though the semantic session is resident. Require public
        # parity and a truly stage-free subsequent request, rather than
        # treating residentWarm alone as a complete-stage cache-hit flag.
        physical = result["validationWork"]["endToEnd"]
        stages_readmitted = (not sys.platform.startswith("linux") and
                            physical["completeProjectPreparations"] != 0)
        if stages_readmitted:
            # Rebuilding *only* external stages while the semantic owner is
            # retained must never reparse or reevaluate unchanged records.
            # But a lost Windows USN epoch can retire the entire owner before
            # the quiet-window clean ledger exists. Its replacement must
            # validate the complete inventory from authoritative bytes; a
            # fresh cold readmission is not a warm-cache performance claim.
            if work(result, "residentWarm"):
                assert work(result, "recheckedRecords") == 0, result["validationWork"]
                assert work(result, "recheckedContributions") == 0, result["validationWork"]
            elif work(result, "recheckedRecords") != 0:
                assert sys.platform == "win32", result["validationWork"]
                assert "source-authority-recovery" in work(
                    result, "semanticFallbackReasons"), result["validationWork"]
                # Only the explicitly recovered cold source inventory may
                # be revalidated; no silent partial owner reuse is accepted.
                assert work(result, "recheckedRecords") == len(
                    work(result, "recheckedRecordOwners")), result["validationWork"]
                assert work(result, "recheckedContributions") == len(
                    work(result, "recheckedContributionOwners")), result["validationWork"]
        if not work(result, "residentWarm") or stages_readmitted:
            # A retired owner or conservatively readmitted watcher may serve
            # a cold, unchanged Project from the persistent ledger. Cold
            # admission can reconstruct downstream inputs and reprove font
            # bytes without reparsing any YAML. Those physical admission
            # proofs are not healthy *warm* request work and must not be
            # subjected to no_stages() before the owner has been retained.
            # Recheck the full public result independently. An NTFS USN
            # journal can become unprovable immediately after a fresh owner
            # opens: that first observation retires the journal-backed owner
            # and switches to conservative full physical scans for the
            # remaining daemon lifetime. Permit exactly one attributable
            # Windows readmission, never an unbounded series of cold owners.
            fresh_parity(project, result)
            repeated = validate(project)
            if not work(repeated, "residentWarm") and sys.platform == "win32":
                reasons = work(repeated, "semanticFallbackReasons")
                assert "source-authority-recovery" in reasons, (
                    project, "Unexpected cold Windows readmission", repeated["validationWork"])
                assert work(repeated, "recheckedRecords") == 0, repeated["validationWork"]
                assert work(repeated, "recheckedContributions") == 0, repeated["validationWork"]
                assert public(repeated) == public(result), (project, repeated)
                fresh_parity(project, repeated)
                repeated = validate(project)
            assert work(repeated, "residentWarm"), (
                project, "Owner failed to remain resident", repeated["validationWork"])
            assert public(repeated) == public(result), (project, repeated)
            no_stages(repeated)
            warm_stage_proofs(repeated)
        else:
            no_stages(result)
            warm_stage_proofs(result)

    def set_label(path, value):
        source = path.read_text()
        assert re.search(r"^label: .*$", source, flags=re.M), path
        path.write_text(re.sub(r"^label: .*$", f"label: {value}", source,
                               count=1, flags=re.M))

    try:
        for size in ("feature-lab", 1, 101, 501):
            if str(size) not in selected:
                continue
            print(f"START: {size}: incremental validation certification", flush=True)
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
            # Arming a quiet-window cache write must not construct or serialize
            # external stage evidence on the public validation request.
            initial_work = initial["validationWork"]["endToEnd"]
            assert initial_work["completeProjectPreparations"] > 0, (size, initial_work)
            assert initial_work["completeProjectBytesSerialized"] > 0, (size, initial_work)
            assert initial_work["stageLedgerSerializations"] == 0, (size, initial_work)
            assert initial_work["stageLedgerBytesSerialized"] == 0, (size, initial_work)
            assert initial_work["stageLedgerConstructionMicros"] == 0, (size, initial_work)
            assert initial_work["stageLedgerJsonSerializationMicros"] == 0, (size, initial_work)
            expected_records = size if isinstance(size, int) else 2
            assert work(initial, "recheckedRecords") >= expected_records, (size, initial)
            fresh_parity(project, initial)
            for _ in range(2):
                unchanged = validate(project)
                # A watcher recovery can conservatively return a temporary
                # generation conflict when another process has just admitted
                # the newly created Project. Do not accept a different public
                # result; require convergence to the exact cold baseline.
                if public(unchanged) != public(initial) and any(
                        diagnostic.get("code") == "WORKSPACE_REVISION_CONFLICT"
                        for diagnostic in unchanged.get("diagnostics", [])):
                    unchanged = validate_after_membership_change(project)
                assert public(unchanged) == public(initial), (
                    size, public(unchanged), public(initial))
                certify_unchanged_resident(project, unchanged)

            if size == 1:
                # Exercise the cold-owner branch deterministically on every
                # host, instead of relying on Windows watcher recovery or
                # runner pressure to evict the resident owner between calls.
                stop()
                readmitted = validate(project)
                assert not work(readmitted, "residentWarm"), readmitted["validationWork"]
                assert public(readmitted) == public(initial), (
                    size, public(readmitted), public(initial))
                certify_unchanged_resident(project, readmitted)

            for index in range(2):
                set_label(room, f"Certification label {index}")
                saved = validate(project)
                assert saved["success"], (size, saved)
                assert work(saved, "recheckedRecords") == 1, (size, saved["validationWork"])
                assert work(saved, "recheckedContributions") == 1, (size, saved["validationWork"])
                if sys.platform.startswith("linux"):
                    physical = saved["validationWork"]["endToEnd"]
                    # The broker may have one or two pending inode notifications
                    # for unchanged text sources when the resident first takes
                    # ownership on a loaded CI host. Permit their bounded exact
                    # byte reproof, but never additional YAML reparses, broad
                    # directory scans, or semantic contributor invalidations.
                    assert 1 <= physical["fileByteReads"] <= 3, (size, physical)
                    assert physical["parsedYaml"] == 1, (size, physical)
                    assert physical["directoryEnumerations"] == 0, (size, physical)
                assert public(saved) == public(initial), (size, public(saved))
                for stage in ("fontPreparations", "materialShaderPreparations",
                              "localizationChecks"):
                    assert saved["validationWork"]["endToEnd"][stage] == 0, (
                        size, stage, saved["validationWork"], saved.get("semanticFallbackReasons"))
                warm_stage_proofs(saved)
                # Linux's pinned Project and system-font watchers prove this
                # stage without rereading unchanged font bytes. Other hosts
                # deliberately retain conservative full-byte verification.
                physical = saved["validationWork"]["endToEnd"]
                # The retained downstream projection must avoid full Project
                # reconstruction on all hosts, including full-scan fallback.
                assert work(saved, "retainedStageProjections") == 1, (size, saved)
                for key in ("completeProjectPreparations",
                            "completeProjectPhysicalProjections",
                            "completeProjectSerializationMicros",
                            "completeProjectBytesSerialized", "fullResultAssemblies",
                            "completeProjectPreparationMicros"):
                    assert physical[key] == 0, (size, key, physical)
                if sys.platform.startswith("linux"):
                    assert physical["fontProofReads"] == 0, (size, physical)
                    assert physical["fontProofHashes"] == 0, (size, physical)
                    assert physical["fontBytesRead"] == 0, (size, physical)
                    assert physical["fontBytesHashed"] == 0, (size, physical)
                else:
                    assert physical["fontProofReads"] > 0, (size, physical)
                    assert physical["fontProofHashes"] > 0, (size, physical)
                    assert physical["fontBytesRead"] > 0, (size, physical)
                    assert physical["fontBytesHashed"] > 0, (size, physical)
                assert physical["fontProofReads"] == physical["fontProofHashes"], physical
                assert physical["fileBytesRead"] >= physical["fontBytesRead"], physical
                assert physical["contentBytesHashed"] >= physical["fontBytesHashed"], physical
                assert physical["sourceGenerationFences"] > 0, (size, physical)
                assert physical["validationResponseSerializations"] > 0, (size, physical)
                assert physical["deferredPublications"] == 1, (size, physical)
                assert physical["stageLedgerSerializations"] == 0, (size, physical)
                assert physical["stageLedgerBytesSerialized"] == 0, (size, physical)
                assert physical["stageLedgerConstructionMicros"] == 0, (size, physical)
                assert physical["stageLedgerJsonSerializationMicros"] == 0, (size, physical)
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
                    assert broker["directoryEnumerations"] == 0, (size, broker)
                    assert broker["statReadlinkCalls"] <= 12, (size, broker)
                    assert saved["validationWork"]["endToEnd"]["portableSourceChecks"] == 0
                    assert saved["validationWork"]["endToEnd"]["directoryEnumerations"] == 0
                unchanged = validate(project)
                certify_unchanged_resident(project, unchanged)
            fresh_parity(project, saved)

            # #599: changing one physical script/companion must not cause
            # preparation to re-read or re-hash every unrelated text source.
            # Room-only fixtures supply 1/101/501 independent YAML owners;
            # Feature Lab also covers the RML and RCSS companion surfaces.
            if size == "feature-lab":
                edited_texts = [
                    (project / "records/layouts/feature-lab-hud/layout.lua", "\n-- scoped-proof\n"),
                    (project / "records/layouts/feature-lab-hud/layout.rml", "\n<!-- scoped-proof -->\n"),
                    (project / "records/layouts/feature-lab-hud/layout.rcss", "\n/* scoped-proof */\n"),
                ]
            else:
                scripts = project / "scripts"
                scripts.mkdir(exist_ok=True)
                source = scripts / "scoped-proof.lua"
                source.write_text("-- Added script source for scoped validation\n")
                assert validate_after_membership_change(project)["success"], size
                edited_texts = [(source, "-- scoped-proof\n")]
            for path, comment in edited_texts:
                path.write_text(path.read_text() + comment)
                changed_text = validate(project)
                assert changed_text["success"], (size, path, changed_text)
                fresh_parity(project, changed_text)
                assert public(changed_text) == public(saved), (size, path, changed_text)
                if sys.platform.startswith("linux"):
                    physical = changed_text["validationWork"]["endToEnd"]
                    assert physical["fileByteReads"] <= 12, (size, path, physical)
                    assert physical["fileBytesRead"] <= (100_000 if size == "feature-lab" else 65_536), (
                        size, path, physical)
                    assert physical["contentHashes"] <= (160 if size == "feature-lab" else 40), (
                        size, path, physical)
                    # The in-memory source-generation identity includes every
                    # admitted revision; its tiny metadata hash grows with the
                    # 501-owner inventory, unlike physical file hashing.
                    assert physical["contentBytesHashed"] <= 300_000, (
                        size, path, physical)
                    assert physical["directoryEnumerations"] == 0, (size, path, physical)
                    assert physical["generationAssetProofReads"] == 0, (size, path, physical)
                    assert physical["generationTextProofReads"] == 0, (size, path, physical)
                    assert physical["shaderProofReads"] == 0, (size, path, physical)
                    assert physical["shaderBytesRead"] == 0, (size, path, physical)
                    assert physical["fontProofReads"] == 0, (size, path, physical)
                    assert physical["fontBytesRead"] == 0, (size, path, physical)
                    assert physical["sourceGenerationFences"] > 0, (size, path, physical)
                    assert physical["materialShaderPreparations"] == 0, (size, path, physical)
                    stages = changed_text["validationWork"].get("physicalStages", {})
                    assert "sessionAndSourceAuthority" in stages, (size, path, stages)
                    # A fully retained downstream projection skips this
                    # stage altogether; an executed stage must have bounded
                    # physical reads. Missing is stronger than zero reads.
                    if "completePreparation" in stages:
                        assert stages["completePreparation"]["fileByteReads"] <= 10, (
                            size, path, stages)
                    else:
                        assert changed_text["validationWork"].get(
                            "retainedStageProjections") == 1, (size, path, stages)
                    assert "sourceGeneration" in stages, (size, path, stages)
                    assert "finalPublicationProof" in stages, (size, path, stages)
                    assert stages["sourceGeneration"]["fileByteReads"] == 0, (
                        size, path, stages)
                    assert stages["finalPublicationProof"]["fileByteReads"] == 0, (
                        size, path, stages)
                    if size == "feature-lab":
                        assert stages["sessionAndSourceAuthority"]["contentHashes"] <= 12, (
                            size, path, stages)
                        # The cached external projection may now reprove
                        # a Lua/RML/RCSS source without entering the font or
                        # material stage at all. A missing stage is stronger
                        # than an executed stage with no physical reads; it
                        # must still identify the certified reused inputs.
                        if "materialsAndShaders" in stages:
                            assert stages["materialsAndShaders"]["fileByteReads"] == 0, (
                                size, path, stages)
                        else:
                            assert work(changed_text, "materialInputReuses") == 1, (
                                size, path, changed_text["validationWork"])
                        if "fonts" in stages:
                            assert stages["fonts"]["fileByteReads"] == 0, (
                                size, path, stages)
                        else:
                            assert work(changed_text, "fontInputReuses") == 1, (
                                size, path, changed_text["validationWork"])
                    assert changed_text["validationWork"].get("shaderCompileRuns", 0) == 0, (
                        size, path, changed_text["validationWork"])
                    assert changed_text["validationWork"].get("materialInterfaceValidations", 0) == 0, (
                        size, path, changed_text["validationWork"])
                unchanged_text = validate(project)
                certify_unchanged_resident(project, unchanged_text)

            if size == 1 and sys.platform.startswith("linux"):
                # Cached exact diagnostics cannot survive a same-inode edit whose size and
                # mtime are restored. This exercises the broker shortcut, not only the
                # profiled native owner path.
                assert validate_without_profile(project)["success"]
                original = room.read_text()
                label = re.search(r"^label: (.*)$", original, re.M)
                assert label and len(label.group(1)) >= 2
                timestamp = room.stat()
                broken = "[" + " " * (len(label.group(1)) - 1)
                room.write_text(original[:label.start(1)] + broken + original[label.end(1):])
                os.utime(room, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns))
                assert room.stat().st_size == timestamp.st_size
                invalid_shortcut = validate_without_profile(project)
                assert not invalid_shortcut["success"] and invalid_shortcut["diagnostics"], invalid_shortcut
                fresh_parity(project, invalid_shortcut)
                room.write_text(original)
                os.utime(room, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns))
                repaired_shortcut = validate_without_profile(project)
                assert public(repaired_shortcut) == public(saved), repaired_shortcut

            if size == "feature-lab" and sys.platform.startswith("linux"):
                # An external hard link bypasses Project directory watches.
                # Inode-level fencing must still revoke a restored-mtime font
                # mutation without checking its bytes on unrelated Room edits.
                font = project / "assets/fonts/DejaVuSans.ttf"
                external_alias = root / "external-font-hardlink.ttf"
                os.link(font, external_alias)
                original_font = font.read_bytes()
                timestamp = font.stat().st_mtime_ns
                with external_alias.open("r+b") as stream:
                    stream.seek(128)
                    byte = stream.read(1)
                    assert byte
                    stream.seek(128)
                    stream.write(bytes([byte[0] ^ 0x01]))
                os.utime(font, ns=(timestamp, timestamp))
                changed_font = validate_after_membership_change(project)
                assert changed_font["validationWork"]["endToEnd"]["fontProofReads"] > 0, changed_font
                fresh_parity(project, changed_font)
                external_alias.write_bytes(original_font)
                os.utime(font, ns=(timestamp, timestamp))
                restored_font = validate_after_membership_change(project)
                assert public(restored_font) == public(saved), (saved, restored_font)
                fresh_parity(project, restored_font)
                # Leave the alias until the fixture is torn down. Unlinking it
                # would emit a *new* inode metadata event after certification,
                # so shutdown must conservatively defer publication rather
                # than claim the just-tested generation stayed unchanged.

            # A persisted ledger is exercised by a genuinely restarted owner,
            # not an unchanged request to the still-live daemon.
            stop()
            published = json.loads((project / ".noveltea/cache/authoring/"
                                    "native-clean-current.json").read_text())
            assert published["stages"] is not None, (size, "Missing shutdown stage evidence")
            assert set(published["stages"]) == {
                "projection", "portable", "notices", "materials", "assets", "materialSources",
                "fonts", "shaders"
            }, (size, published["stages"].keys())
            # Material/Asset YAML membership is an independent provenance key,
            # not an optional cache implementation detail. Missing or stale
            # membership must prevent restoration of compiled Material stages.
            sources = published["stages"]["materialSources"]
            expected_sources = {
                path.relative_to(project).as_posix()
                for collection in ("materials", "assets")
                for path in (project / "records" / collection).glob("*.yaml")
            }
            assert isinstance(sources, dict) and set(sources) == expected_sources, (size, sources)
            assert all(isinstance(revision, str) and revision and revision != "absent"
                       for revision in sources.values()), (size, sources)
            # A deferred writer must publish the latest changed Room source,
            # not preserve the pre-edit contributor bundle from a cache hit.
            expected_owner = "rooms/" + room.stem
            # Resident cache bytes are the *raw disk source*, including CRLF
            # on Windows. Path.read_text() performs universal-newline decoding
            # and would report LF even for a correct raw source snapshot.
            assert (published["resident"]["contributions"][expected_owner]["record"]["bytes"] ==
                    room.read_bytes().decode("utf-8")), (size, "Stale cached Room after shutdown")
            cached = validate(project)
            assert public(cached) == public(saved), size
            assert work(cached, "recheckedRecords") == 0, (size, cached["validationWork"])
            if size == "feature-lab" and sys.platform.startswith("linux") and (
                work(cached, "fontCoverageRuns") or work(cached, "shaderCompileRuns")
            ):
                # The external hard-link write above advanced the resident
                # physical-generation event nonce even after restoring bytes
                # and mtime. A fresh owner cannot inherit that watcher proof;
                # its independently re-proved font/shader stages are a safe
                # cache miss, not a semantic or diagnostic regression.
                physical = cached["validationWork"]["endToEnd"]
                assert physical["fontProofReads"] > 0, physical
                assert physical["shaderProofReads"] > 0, physical
                assert work(cached, "localizationRebuilds") == 0, cached["validationWork"]
                assert physical["sourceGenerationFences"] > 0, physical
            else:
                no_stages(cached)
            fresh_parity(project, cached)

            # Prove that a truncated ledger cannot be admitted as clean evidence
            # in a fresh, foreground-only CLI process. A resident daemon is
            # tested separately: its elected writer may rebuild the corrupted
            # ledger during idle maintenance before the first public command.
            for recovery_attempt in range(3 if size == 101 else 1):
                stop()
                ledger = project / ".noveltea/cache/authoring/native-clean-current.json"
                assert ledger.is_file(), (size, recovery_attempt, ledger)
                with exclusive_cache_lease(project):
                    ledger.write_bytes(b"{truncated")
                    assert ledger.read_bytes() == b"{truncated"
                    direct_recovery = validate(project, direct=True)
                    assert public(direct_recovery) == public(saved), (
                        size, recovery_attempt, direct_recovery)
                    assert work(direct_recovery, "recheckedRecords") >= expected_records, (
                        size, recovery_attempt, "Direct validation admitted corrupt evidence",
                        direct_recovery["validationWork"])
                    assert ledger.read_bytes() == b"{truncated", (
                        size, recovery_attempt, "Nonowner rewrote the cache")

                # Start a new daemon against the *same corrupt ledger*, not
                # evidence regenerated by the foreground direct command.
                stop()
                ledger.write_bytes(b"{truncated")
                assert ledger.read_bytes() == b"{truncated", (
                    size, recovery_attempt, "Ledger republished after stop")
                recovered = validate(project)
                assert public(recovered) == public(saved), (size, recovery_attempt, recovered)
                if work(recovered, "recheckedRecords") < expected_records:
                    # The writer can proactively repair an old, quiet Project
                    # before the queued foreground request. It must have
                    # published a complete current snapshot, not reused the
                    # truncated bytes or a stale diagnostics-only payload.
                    repaired = json.loads(ledger.read_text())
                    contributors = repaired["resident"]["contributions"]
                    assert len(contributors) >= expected_records, (
                        size, recovery_attempt, "Idle repair did not rebuild contributors",
                        recovered["validationWork"])
                    assert (contributors[expected_owner]["record"]["bytes"] ==
                            room.read_text()), (size, recovery_attempt, "Stale idle repair")
                    assert repaired["result"]["valid"] == saved["success"], (
                        size, recovery_attempt, "Stale idle diagnostics")
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
                assert rejected["exitCode"] == 4 and not rejected["success"], rejected
                assert rejected["diagnostics"][0]["code"] == "WORKSPACE_SOURCE_READ", rejected
                fresh_parity(project, rejected)
                unsafe.unlink()
                fresh_parity(project, validate(project))

            portable_export_parity(project)

            print(f"PASS: {size}: warm/unchanged/cold, fresh parity, corruption, "
                  "invalid diagnostics, negative lookup, recovery, export parity", flush=True)
    finally:
        # A teardown failure must not replace the original certification
        # exception. Windows previously reported only the final daemon-stop
        # assertion, hiding the validation step that actually failed first.
        if sys.exc_info()[0] is None:
            stop()
        else:
            try:
                stop()
            except Exception as cleanup_error:
                print(f"Daemon cleanup also failed: {cleanup_error!r}", file=sys.stderr)

print("Public incremental native validation certification passed")
