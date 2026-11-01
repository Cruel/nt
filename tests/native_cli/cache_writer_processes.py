"""OS-process election, idle debounce, private overlay, and crash handoff for #593."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


binary = Path(sys.argv[1]).resolve()
fixture = Path(sys.argv[2]).resolve()


class Resident:
    def __init__(self, root):
        self.process = subprocess.Popen(
            [str(binary), "--cache-writer-probe", str(root)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.status = self.read()

    def read(self):
        line = self.process.stdout.readline()
        assert line, (self.process.poll(), self.process.stderr.read())
        return json.loads(line)

    def send(self, command):
        assert self.process.poll() is None, (command, self.process.returncode)
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()
        self.status = self.read()
        return self.status

    def close(self):
        if self.process.poll() is None:
            self.send("close")
            self.process.communicate(timeout=15)
            assert self.process.returncode == 0, self.process.returncode

    def kill(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.communicate(timeout=15)


def until(action, predicate, *, timeout=9):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = action()
        if predicate(state):
            return state
        time.sleep(0.12)
    raise AssertionError("Timed out waiting for native validation cache election/debounce")


with tempfile.TemporaryDirectory(prefix="noveltea-cache-election-") as directory:
    temp = Path(directory)
    project = temp / "project"
    shutil.copytree(fixture, project, ignore=shutil.ignore_patterns(".noveltea"))
    cache_dir = project / ".noveltea/cache/authoring"
    ledger = cache_dir / "native-clean-current.json"
    lock = cache_dir / "native-clean-writer.lock"
    alias = temp / "alias"
    if os.name != "nt":
        alias.symlink_to(project, target_is_directory=True)
    residents = []

    def start(path):
        resident = Resident(path)
        residents.append(resident)
        return resident

    try:
        # Two independently opened native residents, one entered via an alias,
        # elect precisely one OS-held writer even before either validates.
        a = start(project)
        b = start(project)
        c = start(alias if os.name != "nt" else project)
        assert a.status["writer"] is True
        assert b.status["writer"] is False
        assert c.status["writer"] is False
        assert lock.is_file() and lock.stat().st_size == 0
        lock_identity = (lock.stat().st_dev, lock.stat().st_ino)
        assert b.send("validate")["valid"], "Nonowner must validate independently"
        assert not ledger.exists(), "Nonowner direct validation cannot publish"

        # Idle owner publishes without a user request. The write is stable if
        # the same source generation is polled repeatedly.
        until(lambda: a.send("tick"), lambda _: ledger.is_file())
        initial = ledger.read_bytes()
        modified = ledger.stat().st_mtime_ns
        # The previously validated nonowner retains its own resident result.
        # A newly admitted nonowner can instead cold-import the elected ledger.
        cold = start(project)
        assert not cold.status["writer"]
        assert cold.send("validate")["cacheHit"], "Nonowner may read the elected ledger"
        cold.close()
        for _ in range(4):
            assert a.send("tick")["writer"]
            assert not b.send("tick")["writer"]
        assert ledger.stat().st_mtime_ns == modified and ledger.read_bytes() == initial

        # Source edits cannot trigger an early publication. Polls while the
        # source is busy reset the quiet window instead of writing snapshots.
        room = project / "records/rooms/unrelated.yaml"
        source = room.read_text(encoding="utf-8")
        assert "label: Unrelated Room" in source
        room.write_text(source.replace("label: Unrelated Room", "label: First Edit"),
                        encoding="utf-8")
        a.send("observe")
        a.send("tick")
        assert ledger.read_bytes() == initial
        assert b.send("validate")["valid"]
        assert ledger.read_bytes() == initial, "A nonowner cannot race the current writer"
        until(lambda: a.send("tick"), lambda _: ledger.read_bytes() != initial)
        first_edit = ledger.read_bytes()
        assert json.loads(first_edit)["sources"]["records/rooms/unrelated.yaml"] != \
            json.loads(initial)["sources"]["records/rooms/unrelated.yaml"]

        # Flush immediately on graceful close, even inside a new quiet period.
        room.write_text(source.replace("label: Unrelated Room", "label: Second Edit"),
                        encoding="utf-8")
        a.send("observe")
        assert ledger.read_bytes() == first_edit
        a.close()
        flushed = ledger.read_bytes()
        assert flushed != first_edit, "Shutdown must flush the latest physical generation"
        assert (lock.stat().st_dev, lock.stat().st_ino) == lock_identity

        # The surviving nonowner retries, then becomes the writer. It must not
        # publish an unsaved editor overlay after winning the lease.
        until(lambda: b.send("tick"), lambda reply: reply["writer"])
        before_private = ledger.read_bytes()
        b.send("dirty")
        b.send("tick")
        assert ledger.read_bytes() == before_private

        # An unfinished disk generation cannot be published by an owner with
        # private edits. If that owner dies, the waiting canonical alias must
        # reprove and publish the new physical bytes itself.
        room.write_text(source.replace("label: Unrelated Room", "label: Third Edit"),
                        encoding="utf-8")
        b.send("observe")
        assert ledger.read_bytes() == before_private
        # A SIGKILL-like death releases OS ownership without deleting the
        # stable inode. A waiting canonical alias takes over and reconciles.
        b.kill()
        until(lambda: c.send("tick"), lambda reply: reply["writer"])
        assert (lock.stat().st_dev, lock.stat().st_ino) == lock_identity
        assert c.send("validate")["valid"]
        until(lambda: c.send("tick"), lambda _: ledger.read_bytes() != flushed)
        assert json.loads(ledger.read_bytes())["sources"]["records/rooms/unrelated.yaml"] != \
            json.loads(flushed)["sources"]["records/rooms/unrelated.yaml"]
        c.close()

        # Broken optional cache storage must not poison authoritative reads.
        shutil.rmtree(cache_dir)
        cache_dir.write_text("storage unavailable\n", encoding="utf-8")
        d = start(project)
        assert not d.status["writer"]
        assert d.send("validate")["valid"]
        d.close()
    finally:
        for resident in residents:
            resident.kill()

print("Native cross-process cache writer election and handoff passed.")
