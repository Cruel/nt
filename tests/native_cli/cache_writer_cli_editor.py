"""#593: real daemon Project owner competes with the native Electron addon.

Usage: python3 cache_writer_cli_editor.py <noveltea-cli> <node-addon> <repo-root>
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


cli = Path(sys.argv[1]).resolve()
addon = Path(sys.argv[2]).resolve()
repository = Path(sys.argv[3]).resolve()
fixture = repository / "editor/src/renderer/test/fixtures/project-compiler-cli/minimal-project"
host = repository / "tests/native_cli/cache_writer_editor_host.mjs"


class Editor:
    def __init__(self, project):
        self.child = subprocess.Popen(
            ["node", str(host), str(addon), str(project)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        assert self.read().get("ready")

    def read(self):
        line = self.child.stdout.readline()
        assert line, (self.child.poll(), self.child.stderr.read())
        return json.loads(line)

    def command(self, action):
        self.child.stdin.write(action + "\n")
        self.child.stdin.flush()
        response = self.read()
        assert response.get("ok"), response
        return response

    def close(self):
        if self.child.poll() is None:
            self.command("close")
            self.child.communicate(timeout=15)
            assert self.child.returncode == 0

    def kill(self):
        if self.child.poll() is None:
            self.child.kill()
            self.child.communicate(timeout=15)


def until(callback, predicate, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = callback()
        if predicate(result):
            return result
        time.sleep(0.14)
    raise AssertionError("Native host writer election timed out")


def change_label(project, label):
    path = project / "records/rooms/unrelated.yaml"
    source = path.read_text(encoding="utf-8")
    import re
    assert re.search(r"^label: .*", source, re.M)
    path.write_text(re.sub(r"^label: .*", f"label: {label}", source, count=1, flags=re.M),
                    encoding="utf-8")


with tempfile.TemporaryDirectory(prefix="noveltea-cache-real-hosts-") as directory:
    temp = Path(directory)
    env = os.environ.copy()
    env.pop("NOVELTEA_NO_DAEMON", None)
    env.update(NOVELTEA_CLI_CERTIFICATION="1",
               NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT=str(temp / "daemon"))
    editors = []

    def run(*argv, expected=0):
        finished = subprocess.run([str(cli), "--json", *map(str, argv)],
                                  env=env, text=True, capture_output=True, timeout=90)
        assert finished.returncode == expected and not finished.stderr, (argv, finished)
        return json.loads(finished.stdout)

    def validate(project, local=False):
        response = run(*(["--no-daemon"] if local else []), "--project", project, "validate")
        assert response["success"], response
        return response

    def editor(project):
        result = Editor(project)
        editors.append(result)
        return result

    try:
        # Editor first: the CLI daemon opens and validates independently, but
        # cannot publish its clean result while the addon owns the lock.
        project = temp / "editor-first"
        shutil.copytree(fixture, project, ignore=shutil.ignore_patterns(".noveltea"))
        ledger = project / ".noveltea/cache/authoring/native-clean-current.json"
        e = editor(project)
        first = validate(project)
        assert not ledger.exists(), "Daemon must not publish over editor writer"
        assert e.command("validate")["valid"]
        until(lambda: e.command("tick"), lambda _: ledger.exists())
        assert validate(project, local=True)["diagnostics"] == first["diagnostics"]
        baseline = ledger.read_bytes()
        change_label(project, "Edited while both hosts are active")
        assert e.command("validate")["valid"]
        assert validate(project)["success"]
        assert ledger.read_bytes() == baseline, "Simultaneous debounce must not publish early"
        run("daemon", "stop")
        e.close()
        assert ledger.read_bytes() != baseline, "Editor graceful shutdown flushes"

        # Daemon first: its resident owns the writer lock, while an editor
        # validates and observes without changing the persisted ledger.
        project = temp / "daemon-first"
        shutil.copytree(fixture, project, ignore=shutil.ignore_patterns(".noveltea"))
        ledger = project / ".noveltea/cache/authoring/native-clean-current.json"
        validate(project)
        e = editor(project)
        assert e.command("validate")["valid"]
        # Daemon may have published during idle, but the editor cannot mutate
        # a ledger whose ownership belongs to the daemon.
        old = ledger.read_bytes() if ledger.exists() else None
        change_label(project, "Change observed by nonowner editor")
        assert e.command("validate")["valid"]
        assert (ledger.read_bytes() if ledger.exists() else None) == old
        assert validate(project)["success"]
        run("daemon", "stop")
        # The editor can acquire only after its five-second nonowner retry,
        # then prove physical bytes and publish without daemon assistance.
        until(lambda: e.command("tick"), lambda _: ledger.exists() and
              (old is None or ledger.read_bytes() != old))
        assert validate(project, local=True)["success"]
        e.close()
        assert not run("daemon", "status")["daemon"]["running"]

        # Large, real authored Projects exercise a slower shutdown flush than
        # the minimal fixture. The broker must not terminate the owner before
        # its native destructor publishes the disk-only ledger.
        project = temp / "feature-lab"
        shutil.copytree(repository / "tests/projects/feature-lab", project,
                        ignore=shutil.ignore_patterns(".noveltea"))
        large_ledger = project / ".noveltea/cache/authoring/native-clean-current.json"
        validate(project)
        run("daemon", "stop")
        assert large_ledger.is_file(), "Large Project graceful shutdown lost its cache flush"
        assert validate(project, local=True)["success"]
    finally:
        for e in editors:
            e.kill()
        run("daemon", "stop")

print("Real daemon/editor cross-process cache ownership passed.")
