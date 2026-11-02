"""#600: elected quiet-window writer proactively publishes exact public CLI results."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
if os.name != "nt":
    import fcntl


binary = Path(sys.argv[1]).resolve()

with tempfile.TemporaryDirectory(prefix="nt-600-") as directory:
    root = Path(directory)
    installed = root / binary.name
    shutil.copy2(binary, installed)
    shutil.copytree(binary.parent / "assets/system", root / "assets/system")
    project = root / "project"
    env = {**os.environ, "NOVELTEA_CLI_CERTIFICATION": "1",
           "NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT": str(root / "daemon")}
    env.pop("NOVELTEA_NO_DAEMON", None)

    def cli(*arguments, expected=0, local=False):
        command = [str(installed), "--json"]
        if local:
            command.append("--no-daemon")
        command += list(map(str, arguments))
        started = time.monotonic()
        process = subprocess.run(command, cwd=root, env=env, capture_output=True,
                                 text=True, timeout=50)
        elapsed = 1000 * (time.monotonic() - started)
        assert process.returncode == expected and not process.stderr, (command, process)
        response = json.loads(process.stdout)
        assert response["exitCode"] == expected, response
        return response, elapsed

    def validate(expected=0, *, local=False, target=project):
        return cli("--project", target, "validate", expected=expected, local=local)

    def status():
        return cli("daemon", "status")[0]["daemon"]

    def hits():
        return status()["engineeringCounters"]["exactResultHits"]

    def publications():
        return status()["engineeringCounters"]["idleValidationPublications"]

    def await_publication(previous, *, since, timeout=14):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            count = publications()
            if count > previous:
                elapsed = 1000 * (time.monotonic() - since)
                assert elapsed >= 4900, ("quiet-window publication was premature", elapsed)
                return elapsed
            time.sleep(.08)
        raise AssertionError("No proactive broker publication after quiet-window maintenance")

    def first_hit(expected, target=project):
        before = hits()
        result, elapsed = validate(expected=expected, target=target)
        assert hits() == before + 1, (before, status(), result)
        reference, _ = validate(expected=expected, local=True, target=target)
        assert result == reference, (result, reference)
        return elapsed

    def edit_room(label, target=project):
        path = target / "records/rooms/entry.yaml"
        content = path.read_text(encoding="utf-8")
        path.write_text(re.sub(r"(?m)^label: .*", f"label: {label}", content),
                        encoding="utf-8")

    try:
        cli("project", "create", project, "--name", "Idle Publication", local=True)
        cli("--project", project, "entity", "create", "rooms", "entry", local=True)
        config = project / "project.yaml"
        authored = config.read_text(encoding="utf-8")
        config.write_text(authored + "\nentrypoint:\n  kind: room\n  id: entry\n",
                          encoding="utf-8")
        authored = config.read_text(encoding="utf-8")

        # Start the owner. It must not require any subsequent public validate
        # command to publish a newly edited generation.
        validate()
        before = publications()
        edit_room("Changed Quietly")
        changed_at = time.monotonic()
        saved_ms = await_publication(before, since=changed_at)
        assert status()["exactValidationResults"] >= 1
        valid_ms = first_hit(0)

        # Edits overlap the point when the initial idle maintenance would
        # have become due. No intermediate generation may be published.
        before = publications()
        edit_room("Maintenance Race Start")
        time.sleep(3.5)
        for index in range(6):
            edit_room(f"Maintenance Race {index}")
            last_changed_at = time.monotonic()
            time.sleep(.4)
        time.sleep(2)
        assert publications() == before, "Maintenance published during live source edits"
        await_publication(before, since=last_changed_at)
        first_hit(0)

        # A burst of edits must restart, not shorten, the five-second clock.
        before = publications()
        edit_room("Burst One")
        time.sleep(2)
        edit_room("Burst Two")
        time.sleep(3)
        assert publications() == before, "Rapid edits must reset the idle timer"
        before = hits()
        transient, _ = validate()
        assert hits() == before, ("premature background publication", transient)
        # Foreground result above is itself retained; invalidate it again, then
        # certify another untouched quiet interval.
        edit_room("Burst Three")
        changed_at = time.monotonic()
        burst_saved_ms = await_publication(before, since=changed_at)
        rapid_ms = first_hit(0)

        # A deterministic semantic error has the same complete public result
        # and exit code when obtained from a quiet-window exact hit.
        before = publications()
        config.write_text(re.sub(r"(?m)^entrypoint:\n(?:[ \t]+[^\n]*\n)*", "",
                                 authored, count=1), encoding="utf-8")
        await_publication(before, since=time.monotonic())
        invalid_ms = first_hit(4)
        before = publications()
        config.write_text(authored, encoding="utf-8")
        await_publication(before, since=time.monotonic())
        repaired_ms = first_hit(0)

        # Malformed physical source must not be promoted to a public exact
        # generation; repair must restore idle publication.
        room = project / "records/rooms/entry.yaml"
        intact = room.read_bytes()
        before = publications()
        room.write_text("not: a valid Room\n", encoding="utf-8")
        time.sleep(7)
        assert publications() == before, "Malformed physical source was published"
        before = hits()
        invalid, _ = validate(expected=3)
        assert hits() == before and invalid["diagnostics"][0]["code"] == "WORKSPACE_SOURCE_READ"
        before = publications()
        room.write_bytes(intact)
        await_publication(before, since=time.monotonic())
        recovery_ms = first_hit(0)

        # Unknown watcher coverage takes the physical fallback path; a change
        # must never receive the previous exact result solely from watcher state.
        edit_room("Uncertain Watcher")
        before = hits()
        fallback_env = {**env, "NOVELTEA_CLI_CERTIFICATION_FORCE_AUTHORITY_UNKNOWN": "1"}
        fallback = subprocess.run([str(installed), "--json", "--project", str(project),
                                   "validate"], cwd=root, env=fallback_env,
                                  capture_output=True, text=True, timeout=50)
        assert fallback.returncode == 0 and not fallback.stderr, fallback
        assert json.loads(fallback.stdout) == validate(local=True)[0]
        assert hits() == before, "Uncertain changed source incorrectly reused exact result"

        if os.name != "nt":
            # Competing OS-process writer must suppress idle broker publication.
            # Elect an unrelated OS writer before admitting a fresh daemon
            # owner for this copied Project.
            competing = root / "competing"
            shutil.copytree(project, competing, ignore=shutil.ignore_patterns(".noveltea"))
            lease_path = competing / ".noveltea/cache/authoring/native-clean-writer.lock"
            lease_path.parent.mkdir(parents=True)
            with lease_path.open("w+b") as lease:
                fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                cli("--project", competing, "entity", "inspect", "rooms", "entry")
                edit_room("Other Writer Holds Lease", target=competing)
                last_changed_at = time.monotonic()
                time.sleep(7)
                cache = competing / ".noveltea/cache/authoring"
                assert not (cache / "native-clean-current.json").exists(), (
                    "Non-elected resident published the native cache")
                assert not (cache / "current.json").exists(), (
                    "Non-elected resident published the broker public cache")
                before = publications()
                fcntl.flock(lease.fileno(), fcntl.LOCK_UN)
                # The shared broker can also publish a different Project's
                # result during this test, so require the competing Project's
                # own cache and first public result after the lock is released.
                await_publication(before, since=last_changed_at)
                first_hit(0, target=competing)

        print(json.dumps({"saveToDiagnosticsMs": saved_ms,
                          "burstSaveToDiagnosticsMs": burst_saved_ms,
                          "firstReadMs": valid_ms, "burstFirstReadMs": rapid_ms,
                          "invalidFirstReadMs": invalid_ms,
                          "repairFirstReadMs": repaired_ms,
                          "sourceRecoveryFirstReadMs": recovery_ms}))
    finally:
        try:
            cli("daemon", "stop")
        except (AssertionError, subprocess.TimeoutExpired):
            pass
