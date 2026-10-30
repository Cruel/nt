"""Exercise changing source membership during a native CLI physical observation.

Usage: python3 tests/native_cli/source_observation_race.py <noveltea> <repo-root>

This is a stress/qualification test, not a timing-based CI performance gate.
Concurrent validation may legitimately report a conflict or a stable snapshot;
once mutations stop, both membership states must validate successfully.
"""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading


binary = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()

with tempfile.TemporaryDirectory(prefix="nt-574-observation-race-") as directory:
    project = Path(directory) / "project"
    shutil.copytree(repo / "tests/projects/feature-lab", project)
    changing = project / "scripts/observation-race.lua"
    stop = threading.Event()
    operations = [0]

    def mutate():
        while not stop.wait(0.01):
            changing.write_text("return {}\n")
            operations[0] += 1
            if stop.wait(0.01):
                break
            changing.unlink()
            operations[0] += 1

    def validate():
        result = subprocess.run(
            [str(binary), "--no-daemon", "--json", "--project", str(project), "validate"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        payload = json.loads(result.stdout)
        assert result.returncode == payload["exitCode"], (result, payload)
        return payload

    worker = threading.Thread(target=mutate)
    worker.start()
    try:
        # Start cold, then repeat while files are actively created and deleted.
        observed = [validate() for _ in range(3)]
    finally:
        stop.set()
        worker.join()
    assert operations[0] >= 10, f"Insufficient overlapping source mutations: {operations[0]}"
    changing.write_text("return {}\n")
    assert validate()["success"], "Stable newly created source must validate"
    changing.unlink()
    assert validate()["success"], "Stable source removal must validate"
    print(f"PASS: {operations[0]} source creates/deletes during three validations, "
          f"{sum(item['success'] for item in observed)} stable responses, recovered both states")
