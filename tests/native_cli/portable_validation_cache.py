"""Public CLI certification of retained portable/external validation inputs."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile


cli = Path(sys.argv[1]).resolve()
fixture = Path(sys.argv[2]).resolve()

with TemporaryDirectory(prefix="noveltea-portable-validation-") as temporary:
    root = Path(temporary)
    project = root / "project"
    shutil.copytree(fixture, project, ignore=shutil.ignore_patterns(".noveltea"))
    env = {
        **os.environ,
        "NOVELTEA_VALIDATION_WORK_PROFILE": "1",
        "NOVELTEA_CLI_CERTIFICATION": "1",
        "NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT": str(root / "daemon"),
    }
    env.pop("NOVELTEA_NO_DAEMON", None)

    def validate(success=True, direct=False):
        process = subprocess.run(
            [str(cli), "--json", *(["--no-daemon"] if direct else []),
             "--project", str(project), "validate"],
            env=env, capture_output=True, text=True, timeout=180)
        assert not process.stderr, process.stderr
        response = json.loads(process.stdout)
        assert response["success"] is success, (process.returncode, response)
        assert (process.returncode == 0) is success, (process.returncode, response)
        return response

    def assert_public_parity(daemon, direct):
        # Work counters and cache-hit metadata are expected to differ between
        # resident and direct CLI clients; user-visible failures must not.
        for key in ("success", "diagnostics", "error", "code"):
            assert daemon.get(key) == direct.get(key), (key, daemon, direct)

    def work(response, name):
        return response["validationWork"].get(name, 0)

    def export(name, success=True):
        destination = root / name
        process = subprocess.run(
            [str(cli), "--json", "--project", str(project),
             "project", "export", "--output", str(destination)],
            env=env, capture_output=True, text=True, timeout=180)
        assert not process.stderr, process.stderr
        response = json.loads(process.stdout)
        assert response["success"] is success, (process.returncode, response)
        return destination

    initial = validate()
    diagnostics = initial["diagnostics"]
    # The elected daemon writer debounces disk publication for five seconds.
    # A direct client must not expect an immediate cold ledger while that
    # resident still owns the lease. Graceful stop flushes its validated
    # generation and makes cold-stage restoration deterministic.
    stop = subprocess.run([str(cli), "--json", "daemon", "stop"], env=env,
                          capture_output=True, text=True, timeout=30)
    assert stop.returncode == 0, (stop.stdout, stop.stderr)
    restarted = validate(direct=True)
    assert_public_parity(initial, restarted)
    for counter in ("globalStageExecutions", "fontCoverageRuns", "shaderCompileRuns",
                    "materialInterfaceValidations", "completeProjectProjected"):
        assert work(restarted, counter) == 0, (counter, restarted["validationWork"])
    for counter in ("recordContributions", "dependencyContributions", "localizationChecks",
                    "fontPreparations", "materialShaderPreparations", "portableSourceChecks"):
        assert restarted["validationWork"]["endToEnd"][counter] == 0, (
            counter, restarted["validationWork"])
    assert initial["validationWork"]["endToEnd"]["portableSourceChecks"] == 1
    cache_file = project / ".noveltea/cache/authoring/native-clean-current.json"
    saved_ledger = cache_file.read_text()
    malformed_ledger = json.loads(saved_ledger)
    malformed_ledger["stages"]["projection"]["fontCoverageInputs"] = "invalid"
    cache_file.write_text(json.dumps(malformed_ledger))
    recovered = validate(direct=True)
    assert_public_parity(initial, recovered)
    assert work(recovered, "globalStageExecutions") == 0
    assert recovered["validationWork"]["endToEnd"]["fontPreparations"] > 0
    cache_file.write_text(saved_ledger)
    malformed_fonts = json.loads(saved_ledger)
    for entry in malformed_fonts["stages"]["fonts"]:
        if not entry["failure"]:
            entry["response"] = "[1]"
            cache_file.write_text(json.dumps(malformed_fonts))
            assert_public_parity(initial, validate(direct=True))
            cache_file.write_text(saved_ledger)
            break
    malformed_reflections = json.loads(saved_ledger)
    reflections = malformed_reflections["stages"]["shaders"]["reflections"]
    if reflections:
        first = next(iter(reflections.values()))
        first["diagnostics"] = [1]
        cache_file.write_text(json.dumps(malformed_reflections))
        assert_public_parity(initial, validate(direct=True))
        cache_file.write_text(saved_ledger)

    # The daemon must also load the ledger in a new process rather than
    # inheriting process-local fonts, shaders, or source projections.
    stop = subprocess.run([str(cli), "--json", "daemon", "stop"], env=env,
                          capture_output=True, text=True, timeout=30)
    assert stop.returncode == 0, (stop.stdout, stop.stderr)
    daemon_cold = validate()
    assert_public_parity(initial, daemon_cold)
    for counter in ("globalStageExecutions", "fontCoverageRuns", "shaderCompileRuns",
                    "materialInterfaceValidations", "completeProjectProjected"):
        assert work(daemon_cold, counter) == 0, (counter, daemon_cold["validationWork"])
    unchanged = validate()
    # All hosts retain exact source-proven inputs. A missing platform watcher
    # requires a full physical observation, not a repeated portable stage.
    assert work(unchanged, "portableSourceReuses") == 1
    assert work(unchanged, "noticeValidationReuses") == 1
    assert unchanged["validationWork"]["endToEnd"]["portableSourceChecks"] == 0

    # An actual saved Room label changes its YAML source revision but no
    # external-source identity. No portable check or notice scan is allowed.
    room = project / "records/rooms/feature-lab-home.yaml"
    room.write_text(room.read_text().replace(
        "label: Feature Lab Home", "label: Feature Lab Home - external cache"))
    label = validate()
    assert label["diagnostics"] == diagnostics
    assert work(label, "portableSourceReuses") == 1, label["validationWork"]
    assert work(label, "noticeValidationReuses") == 1
    assert label["validationWork"]["endToEnd"]["portableSourceChecks"] == 0
    assert_public_parity(label, validate(direct=True))

    # Workflows are portable without appearing in Asset YAML. Create, modify,
    # rename and remove a member, then ensure each membership generation is
    # actually observed rather than borrowing a successful prior stage.
    workflows = project / "workflows"
    workflows.mkdir(exist_ok=True)
    workflow = workflows / "source.json"
    workflow.write_text('{"value":1}\n')
    added = validate()
    assert added["diagnostics"] == diagnostics
    assert work(added, "portableSourceReuses") == 0
    with ZipFile(export("workflow-present.ntproject")) as archive:
        assert archive.read("workflows/source.json") == b'{"value":1}\n'
    assert work(validate(), "portableSourceReuses") == 1
    workflow.write_text('{"value":2}\n')
    changed = validate()
    assert work(changed, "portableSourceReuses") == 0, changed["validationWork"]
    renamed = workflows / "renamed.json"
    workflow.rename(renamed)
    assert work(validate(), "portableSourceReuses") == 0
    renamed.unlink()
    assert work(validate(), "portableSourceReuses") == 0
    with ZipFile(export("workflow-removed.ntproject")) as archive:
        assert "workflows/renamed.json" not in archive.namelist()

    # A binary Asset is a watched physical input, but unrelated Room edits
    # above must not cause its portable path to be opened again.
    media = project / "assets/audio/notification.mp3"
    media.write_bytes(media.read_bytes() + b"\x00")
    binary = validate()
    assert work(binary, "portableSourceReuses") == 0, binary["validationWork"]
    assert binary["diagnostics"] == diagnostics
    assert work(validate(), "portableSourceReuses") == 1

    # Restored timestamps and unchanged size cannot hide an external edit:
    # either the synchronous watcher observes it or the full scan hashes it.
    original_binary = media.read_bytes()
    timestamp = media.stat()
    media.write_bytes(original_binary[:-1] + b"\x01")
    os.utime(media, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns))
    equal_metadata = validate()
    assert equal_metadata["diagnostics"] == diagnostics
    assert work(equal_metadata, "portableSourceReuses") == 0
    assert work(validate(), "portableSourceReuses") == 1

    manifest = project / "project.yaml"
    notice = project / "assets/notices/legal.txt"
    notice.parent.mkdir(parents=True, exist_ok=True)
    notice.write_text("A valid distribution notice.\n")
    manifest.write_text(manifest.read_text().replace(
        "  distributionNotices: []",
        "  distributionNotices:\n"
        "    - path: assets/notices/legal.txt\n"
        "      displayName: Legal notice"))
    configured = validate()
    assert work(configured, "noticeValidationRuns") == 1
    assert work(validate(), "noticeValidationReuses") == 1

    # An invalid UTF-8/control-bearing notice cannot yield a trustworthy
    # clean hit; changing or repairing those bytes must rerun the stage.
    notice.write_bytes(b"Invalid\x01notice\n")
    invalid = validate(False)
    assert invalid["success"] is False
    assert work(invalid, "noticeValidationRuns") == 1
    assert_public_parity(invalid, validate(False, direct=True))
    assert work(validate(False), "noticeValidationRuns") == 1
    notice.write_text("Repaired notice.\n")
    repaired = validate()
    assert repaired["diagnostics"] == diagnostics
    assert work(repaired, "noticeValidationRuns") == 1
    assert work(validate(), "noticeValidationReuses") == 1
    assert validate(direct=True)["diagnostics"] == diagnostics

    # A valid, same-size write with restored mtime must not reuse the old
    # notice content proof merely because metadata happened to match.
    previous = notice.stat()
    notice.write_bytes(notice.read_bytes().replace(b".", b"!"))
    os.utime(notice, ns=(previous.st_atime_ns, previous.st_mtime_ns))
    same_metadata = validate()
    assert same_metadata["diagnostics"] == diagnostics
    assert work(same_metadata, "noticeValidationRuns") == 1
    assert work(validate(), "noticeValidationReuses") == 1

    # An escaping symlink must never inherit the previous success. Both the
    # daemon and direct CLI fail, then a repaired file is admitted again.
    other = root / "outside.json"
    other.write_text("outside\n")
    workflow.symlink_to(other)
    unsafe_daemon = validate(False)
    assert_public_parity(unsafe_daemon, validate(False, direct=True))
    export("unsafe-workflow.ntproject", success=False)
    workflow.unlink()
    assert validate()["diagnostics"] == diagnostics

    # Empty optional record families are ordinary valid Projects. The
    # external-stage projection must not require Asset/Layout/Material maps.
    project = root / "minimal-project"
    for arguments in (
        ("project", "create", str(project), "--name", "Minimal"),
        ("--project", str(project), "entity", "create", "rooms", "entry"),
    ):
        completed = subprocess.run([str(cli), "--json", "--no-daemon", *arguments],
                                   env=env, capture_output=True, text=True, timeout=60)
        assert completed.returncode == 0, (arguments, completed.stdout, completed.stderr)
    with (project / "project.yaml").open("a", encoding="utf-8") as manifest:
        manifest.write("\nentrypoint:\n  kind: room\n  id: entry\n")
    minimal = validate()
    assert minimal["success"] is True
    assert work(validate(), "portableSourceReuses") == 1
    assert validate(direct=True)["diagnostics"] == minimal["diagnostics"]

    print("Portable and external validation cache certification passed")
