"""Optional Linux mount-namespace certification of native Project source containment.

Usage: python3 tests/native_cli/source_observation_mount.py <noveltea> <repo-root>

Requires unprivileged user/mount namespaces and bind mounts. Unsupported hosts
print SKIP; a host that grants mounts must pass every asserted source fence.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    if sys.platform != "linux" or not shutil.which("unshare") or not shutil.which("mount"):
        print("SKIP: Linux user/mount namespaces and mount utility are required")
        return

    binary = Path(sys.argv[1]).resolve()
    repo = Path(sys.argv[2]).resolve()
    if "--inside" not in sys.argv:
        probe = subprocess.run(
            ["unshare", "--user", "--map-root-user", "--mount", "true"],
            capture_output=True,
            text=True,
        )
        if probe.returncode:
            print(f"SKIP: cannot create a user/mount namespace: {probe.stderr.strip()}")
            return
        with tempfile.TemporaryDirectory(prefix="nt-574-mount-") as folder:
            base = Path(folder)
            project = base / "project"
            shutil.copytree(repo / "tests/projects/feature-lab", project)
            (project / "scripts/mounted").mkdir()
            outside = base / "outside"
            outside.mkdir()
            (outside / "allowed.lua").write_text("return {}\n")
            (base / "escaped.lua").write_text("return 123\n")
            result = subprocess.run(
                ["unshare", "--user", "--map-root-user", "--mount", "--",
                 sys.executable, str(Path(__file__).resolve()), str(binary), str(repo), "--inside",
                 str(project), str(outside), str(base / "escaped.lua")],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode:
                raise AssertionError(f"mount containment regression: {result.stdout}\n{result.stderr}")
            print(result.stdout.strip())
        return

    project, outside, escaped = map(Path, sys.argv[-3:])
    mount = subprocess.run(
        ["mount", "--bind", str(outside), str(project / "scripts/mounted")],
        capture_output=True,
        text=True,
    )
    if mount.returncode:
        if "permission denied" in mount.stderr.lower() or "operation not permitted" in mount.stderr.lower():
            print(f"SKIP: bind mounts unavailable in namespace: {mount.stderr.strip()}")
            return
        raise RuntimeError(f"Cannot bind-mount test source: {mount.stderr.strip()}")

    def validate():
        result = subprocess.run(
            [str(binary), "--no-daemon", "--json", "--project", str(project), "validate"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return result.returncode, json.loads(result.stdout)

    try:
        status, accepted = validate()
        assert status == 0 and accepted["success"], (status, accepted)
        (outside / "bad.lua").symlink_to(escaped)
        status, rejected = validate()
        assert status != 0 and not rejected["success"], (status, rejected)
        (outside / "bad.lua").unlink()
        status, recovered = validate()
        assert status == 0 and recovered["success"], (status, recovered)
        print("PASS: contained bind-mounted source, escaping symlink rejected, recovery accepted")
    finally:
        subprocess.run(["umount", str(project / "scripts/mounted")], check=True,
                       capture_output=True)


if __name__ == "__main__":
    main()
