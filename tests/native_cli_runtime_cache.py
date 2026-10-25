"""Relocated C++ CLI playback against a genuinely produced canonical cache.

The reference fixture's compiler identity is deliberately not forged by default:
the warm-path test runs only when the native candidate is built explicitly with
that exact identity. Cold/mismatched and input tampering are checked independently.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


binary, source, identity_option = sys.argv[1:4]
assert identity_option.startswith("--compiler-identity=")
compiler_identity = identity_option.partition("=")[2]
binary = Path(binary).resolve()
source = Path(source).resolve()
fixture = source / "tests/projects/feature-lab"
cache = fixture / ".noveltea/cache/runtime"
if not (cache / "current").is_file():
    print("SKIP native warm cache certification: generated fixture was not supplied.")
    sys.exit(77)
original_generation = (cache / "current").read_text().strip()
original_manifest = json.loads(
    (cache / "generations" / original_generation / "manifest.json").read_text())
original_identity = original_manifest["compilerIdentity"]

with tempfile.TemporaryDirectory(prefix="noveltea-native-runtime-cache-") as temporary:
    root = Path(temporary)
    installed = root / "noveltea"
    shutil.copy2(binary, installed)
    shutil.copytree(binary.parent / "assets/system", root / "assets/system")
    runner_name = "noveltea-ui-test-runner.exe" if os.name == "nt" else "noveltea-ui-test-runner"
    shutil.copy2(binary.parent / runner_name, root / runner_name)
    project = root / "feature-lab"
    shutil.copytree(fixture, project, symlinks=True)
    environment = {**os.environ, "PATH": str(root), "NOVELTEA_NO_DAEMON": "1"}

    def call(*command, input_text=None, timeout=100):
        result = subprocess.run(
            [str(installed), "--json", "--no-daemon", "--project", str(project),
             "test", *command], cwd=root, env=environment,
            text=True, capture_output=True, input=input_text, timeout=timeout)
        assert result.stderr == "", result.stderr
        lines = result.stdout.splitlines()
        assert len(lines) == 1, result.stdout
        response = json.loads(lines[0])
        assert response["exitCode"] == result.returncode
        assert response["protocolVersion"] == 1
        return response

    if compiler_identity != original_identity:
        print("SKIP native warm cache certification: producer identity differs from candidate.")
        sys.exit(77)
    else:
        # An actual compiled Project, authored catalog, and production-generated
        # runtime input manifest are required; no empty substitute Test spec.
        unknown = call("run", "nonexistent-test")
        assert unknown["exitCode"] == 6, unknown
        assert unknown["diagnostics"][0]["code"] == "native.test.spec", unknown
        assert unknown["runtimeCache"]["status"] == "hit", unknown
        selected = next(entry for entry in json.loads(
            (project / ".noveltea/cache/runtime/generations"
             / original_generation / "tests.json").read_text())["entries"]
            if entry["id"] == "active-text-flow")
        execution = call("run", "active-text-flow")
        assert execution["exitCode"] == 0, execution
        assert execution["runtimeCache"]["status"] == "hit", execution
        assert execution["native"]["report"]["passed"], execution
        direct_spec = call("run-spec", input_text=json.dumps(selected["spec"]))
        assert direct_spec["exitCode"] == 0, direct_spec
        assert direct_spec["native"]["report"]["passed"], direct_spec
        print("Native CLI directly runs a cached authored Test and stdin Test spec.")

        ui_entry = next(entry for entry in json.loads(
            (project / ".noveltea/cache/runtime/generations"
             / original_generation / "tests.json").read_text())["entries"]
            if entry["id"] == "conversation-paths-ui")
        ui = call("run-ui-spec", input_text=json.dumps(ui_entry["spec"]), timeout=130)
        assert ui["exitCode"] == 0, ui
        assert ui["native"]["report"]["passed"], ui
        print("Relocated native UI Test runner executed a cached UI playback spec.")

        # A canonical cached artifact may be published only from its actual
        # source tree, not the otherwise byte-identical relocated Project copy.
        copied_package = root / "should-not-publish.ntpkg"
        copied = subprocess.run(
            [str(installed), "--json", "--project", str(project),
             "package", "export", "--output", str(copied_package),
             "--allow-localization-warnings"], cwd=root, env=environment,
            text=True, capture_output=True, timeout=90)
        copied_result = json.loads(copied.stdout)
        assert copied_result["exitCode"] == 70, copied_result
        assert copied_result["diagnostics"][0]["code"] == "CLI_NATIVE_RUNTIME_CACHE_INVALID"
        assert not copied_package.exists()

        # The reference artifact carries physical source paths bound to the
        # original owner. Exercise the native package writer on that exact
        # tree, with explicit acknowledgement of localization warnings.
        actual_package = root / "native-runtime.ntpkg"
        package_command = [str(installed), "--json", "--no-daemon",
                           "--project", str(fixture), "package", "export",
                           "--output", str(actual_package)]
        blocked = subprocess.run(package_command, cwd=root, env=environment,
                                 text=True, capture_output=True, timeout=90)
        blocked_result = json.loads(blocked.stdout)
        assert blocked_result["exitCode"] == 4, blocked_result
        assert any(d["code"] == "localization.export.warning_override_required"
                   for d in blocked_result["diagnostics"]), blocked_result
        assert not actual_package.exists()
        published = subprocess.run(package_command + ["--allow-localization-warnings"],
                                   cwd=root, env=environment,
                                   text=True, capture_output=True, timeout=130)
        published_result = json.loads(published.stdout)
        assert published_result["exitCode"] == 0, published_result
        assert published_result["native"]["manifest"], published_result
        assert actual_package.is_file() and actual_package.stat().st_size > 1000
        assert "runtimeCache" not in published_result
        original_size = actual_package.stat().st_size
        republished = subprocess.run(package_command + ["--allow-localization-warnings"],
                                     cwd=root, env=environment,
                                     text=True, capture_output=True, timeout=130)
        assert json.loads(republished.stdout)["exitCode"] == 0, republished
        assert actual_package.stat().st_size == original_size
        unsafe_output = root / "symlink-output.ntpkg"
        try:
            unsafe_output.symlink_to(actual_package)
        except (OSError, NotImplementedError):
            pass
        else:
            # An actual symlink destination must be rejected before writing.
            symlink_command = [
                *package_command[:-1], str(unsafe_output), "--allow-localization-warnings"]
            symlinked = subprocess.run(symlink_command, cwd=root, env=environment,
                                       text=True, capture_output=True, timeout=90)
            symlink_result = json.loads(symlinked.stdout)
            assert symlink_result["exitCode"] == 4, symlink_result
            assert symlink_result["diagnostics"][0]["code"] == "export.output_invalid"
            assert actual_package.stat().st_size == original_size
        print("Native CLI published a real current-generation Runtime Package.")

        # A minimal valid catalog exercises native suite dispatch and report
        # projection without launching unrelated UI/video tests in headless CI.
        generation = project / ".noveltea/cache/runtime/generations" / original_generation
        catalog_file = generation / "tests.json"
        catalog = json.loads(catalog_file.read_text())
        catalog["entries"] = [selected]
        catalog_bytes = json.dumps(catalog, separators=(",", ":")).encode()
        catalog_file.write_bytes(catalog_bytes)
        manifest_file = generation / "manifest.json"
        manifest = json.loads(manifest_file.read_text())
        manifest["testCatalog"]["catalogSha256"] = "sha256:" + hashlib.sha256(catalog_bytes).hexdigest()
        manifest_file.write_text(json.dumps(manifest))
        suite = call("run")
        assert suite["exitCode"] == 0, suite
        assert suite["native"]["report"]["counts"] == {
            "total": 1, "passed": 1, "failed": 0, "blocked": 0, "error": 0
        }, suite
        print("Native CLI directly executes cached authored Test suite.")

        # A corrupted cached Test catalog must be rebuilt from the current
        # native Project owner rather than reused or sent through ScriptC.
        catalog_file.write_text(catalog_file.read_text() + " ")
        corrupted = call("run", "active-text-flow")
        assert corrupted["exitCode"] == 0, corrupted
        assert corrupted["native"]["report"]["passed"], corrupted
        assert corrupted["runtimeCache"]["testCatalogStatus"] != "hit", corrupted
        ui_rebuilt = call("run", "conversation-paths-ui", timeout=130)
        assert ui_rebuilt["exitCode"] == 0, ui_rebuilt
        assert ui_rebuilt["native"]["report"]["passed"], ui_rebuilt
        print("Native CLI rebuilt an unusable authored Test catalog directly in C++.")
        manifest["testCatalog"]["catalogSha256"] = "sha256:" + hashlib.sha256(
            catalog_file.read_bytes()).hexdigest()
        manifest_file.write_text(json.dumps(manifest))
        changed = project / "project.yaml"
        changed.write_bytes(changed.read_bytes() + b"\n")
        stale = call("run-spec", input_text=json.dumps(selected["spec"]))
        assert stale["exitCode"] == 70, stale
        assert stale["diagnostics"][0]["code"] == (
            "CLI_NATIVE_RUNTIME_PREPARATION_REQUIRED"), stale
        print("Native CLI rejects stale runtime source revisions after catalog recovery.")
