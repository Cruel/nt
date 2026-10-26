"""Standalone native CLI Feature Lab certification from a real cold Project.

No node, ScriptC, TypeScript, daemon or precompiled runtime cache is available
to the child CLI. The pinned host FFmpeg is the one permitted media tool.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from zipfile import ZipFile


candidate = Path(sys.argv[1]).resolve()
fixture = Path(sys.argv[2]).resolve() / "tests/projects/feature-lab"
identity = sys.argv[3]
ffmpeg = Path(sys.argv[4]).resolve()
player = Path(sys.argv[5]).resolve() if len(sys.argv) > 5 and sys.argv[5] else None
if not identity or not ffmpeg.is_file():
    print("SKIP: native compiler identity or pinned FFmpeg 9.0.1 is unavailable.")
    sys.exit(77)


with tempfile.TemporaryDirectory(prefix="noveltea-native-feature-lab-cold-") as temporary:
    root = Path(temporary)
    install = root / "install"
    install.mkdir()
    binary = install / candidate.name
    shutil.copy2(candidate, binary)
    ui_runner = candidate.parent / ("noveltea-ui-test-runner.exe" if os.name == "nt"
                                    else "noveltea-ui-test-runner")
    assert ui_runner.is_file(), "Relocated CLI must ship its native UI runner."
    shutil.copy2(ui_runner, install / ui_runner.name)
    shutil.copytree(candidate.parent / "assets/system", install / "assets/system")
    media_tool = install / "tools/ffmpeg/bin" / ffmpeg.name
    media_tool.parent.mkdir(parents=True)
    shutil.copy2(ffmpeg, media_tool)
    project = root / "feature-lab"
    shutil.copytree(fixture, project, ignore=shutil.ignore_patterns(".noveltea"))
    assert not (project / ".noveltea/cache/runtime").exists()
    # Deliberately remove Node, ScriptC, pnpm and the source-tree CLI from PATH.
    environment = {**os.environ, "PATH": str(install), "NOVELTEA_NO_DAEMON": "1",
                   "NOVELTEA_FFMPEG": str(media_tool)}
    for key in ("NODE_PATH", "NODE_OPTIONS", "TS_NODE_PROJECT"):
        environment.pop(key, None)

    def run(*command, stdin=None, json_mode=True, exit_code=0, timeout=200,
            project_override=None):
        args = [str(binary)]
        if json_mode:
            args.append("--json")
        args += ["--no-daemon", "--project", str(project_override or project), *command]
        outcome = subprocess.run(args, input=stdin, cwd=root, env=environment,
                                 text=True, capture_output=True, timeout=timeout)
        assert outcome.returncode == exit_code, (command, outcome.stdout[-4000:],
                                                 outcome.stderr[-1000:])
        if not json_mode:
            # Human mode intentionally emits nonblocking authoring findings
            # to stderr instead of embedding them in a JSON envelope.
            assert "[error]" not in outcome.stderr, (command, outcome.stderr)
            return outcome.stdout
        assert not outcome.stderr, (command, outcome.stderr)
        lines = outcome.stdout.splitlines()
        assert len(lines) == 1, (command, lines[:3], lines[-3:])
        response = json.loads(lines[0])
        assert response["protocolVersion"] == 1
        assert response["exitCode"] == exit_code
        return response

    def current():
        return (project / ".noveltea/cache/runtime/current").read_text().strip()

    def catalog():
        return json.loads((project / ".noveltea/cache/runtime/generations" /
                           current() / "tests.json").read_text())

    def assert_package(package, include_unused=False, shader_sources=False):
        with ZipFile(package) as archive:
            paths = set(archive.namelist())
            assert "game" in paths and "manifest.json" in paths
            assert "shader-materials.json" in paths
            assert "licenses/index.json" in paths
            assert "assets/.prepared-media/manifest.json" in paths
            gameplay = json.loads(archive.read("game"))
            manifest = json.loads(archive.read("manifest.json"))
            materials = json.loads(archive.read("shader-materials.json"))
            notices = json.loads(archive.read("licenses/index.json"))
            media = json.loads(archive.read("assets/.prepared-media/manifest.json"))
            assert gameplay["schema"] == "noveltea.compiled.project"
            assert manifest["format"] == "noveltea.runtime-package"
            assert materials["materials"]["lab-pattern"]
            assert notices["schema"] == "noveltea.project-notices"
            assert media["schema"] == "noveltea.private.prepared-media"
            assert any(m["browserVideo"]["path"] in paths for m in media["motions"])
            # Lua resolves these audio assets by string ID: they are genuinely
            # reachable even though authored references are not typed $refs.
            audio = {asset["id"] for asset in gameplay["resources"]["assets"]
                     if asset["kind"] == "audio"}
            assert "music-loop" in audio and "pilot-cue-audio" in audio
            assert "assets/audio/music_loop.mp3" in paths
            assert any(path.startswith("shaders/") and path.endswith(".bin")
                       for path in paths)
            available = {asset["id"] for asset in gameplay["resources"]["assets"]}
            assert ("stress-image-1" in available) == include_unused
            if shader_sources:
                assert any(path.startswith("shaders/") and path.endswith(".sc")
                           for path in paths), "Source override must include shader source."
            else:
                assert not any(path.startswith("shaders/") and path.endswith(".sc")
                               for path in paths), "Default profile strips shader source."

    # Cold compile + all authored semantic and UI Tests, not a warm-cache-only
    # sample or an empty generated Test. One JSON envelope and no debug traces.
    suite = run("test", "run", timeout=330)
    assert suite["runtimeCache"]["status"] == "miss", suite["runtimeCache"]
    assert suite["runtimeCache"]["published"] is True
    counts = suite["native"]["report"]["counts"]
    assert counts == {"total": 43, "passed": 43, "failed": 0, "blocked": 0, "error": 0}, (
        counts, [(entry["id"], entry["status"]) for entry in
                 suite["native"]["report"]["entries"] if entry["status"] != "passed"])
    print("Cold Feature Lab authored suite: 43/43 passed.", flush=True)
    first = current()
    entries = {entry["id"]: entry for entry in catalog()["entries"]}
    assert len(entries) == 43 and all(entry["status"] == "runnable" for entry in entries.values())
    # A package command must independently bootstrap cold authoring and
    # physical Shader/Media preparation; a prior Test run must not be required.
    package_cold_project = root / "package-cold-project"
    shutil.copytree(fixture, package_cold_project,
                    ignore=shutil.ignore_patterns(".noveltea"))
    cold_package = root / "package-cold.ntpkg"
    cold_export = run("package", "export", "--output", str(cold_package),
                      "--allow-localization-warnings", timeout=300,
                      project_override=package_cold_project)
    assert cold_export["success"] and cold_export["runtimeCache"]["status"] == "miss"
    assert cold_export["runtimeCache"]["published"]
    assert_package(cold_package)
    print("Independent cold Runtime Package export and ZIP readback passed.", flush=True)
    selected = run("test", "run", "sound-desk-flow")
    assert selected["runtimeCache"]["status"] == "hit"
    assert selected["native"]["report"]["passed"]
    assert run("test", "run", "presentation-effects-ui", timeout=180)["native"]["report"]["passed"]
    spec = run("test", "run-spec", stdin=json.dumps(entries["sound-desk-flow"]["spec"]))
    ui = run("test", "run-ui-spec", stdin=json.dumps(entries["sound-desk-ui"]["spec"]),
             timeout=180)
    assert spec["native"]["report"]["passed"] and ui["native"]["report"]["passed"]
    assert "succeeded" in run("test", "run", "sound-desk-flow", json_mode=False)
    missing = run("test", "run", "nonexistent", exit_code=6)
    assert missing["diagnostics"][0]["code"] == "native.test.spec"
    # A valid, runnable authored spec whose expected state is wrong must be
    # reported as a failed Test (not a native error or successful dispatch).
    wrong = json.loads(json.dumps(entries["active-text-flow"]["spec"]))
    expected_flow = next(expectation for step in wrong["steps"]
                         for expectation in step["expectations"]
                         if expectation["type"] == "active-flow")
    expected_flow["flowId"] = "never-the-active-flow"
    failed = run("test", "run-spec", stdin=json.dumps(wrong), exit_code=6)
    assert failed["native"]["report"]["passed"] is False, failed["native"]["report"]
    assert any(d["code"] == "native.test.failed" for d in failed["diagnostics"])
    assert failed["runtimeCache"]["status"] == "hit"
    print("Authored named, UI, stdin and human Test entrypoints passed.", flush=True)

    package = root / "game.ntpkg"
    default = run("package", "export", "--output", str(package),
                  "--allow-localization-warnings", timeout=240)
    assert default["success"] and current() == first
    assert_package(package)
    print("Cold runtime package ZIP readback passed.", flush=True)
    old_hash = hashlib.sha256(package.read_bytes()).hexdigest()
    staged_system = player.parents[2] / "runtime-assets/system" if player else None
    player_ready = bool(
        player and player.is_file() and os.name != "nt" and shutil.which("xvfb-run")
        and (staged_system / "scripts/bootstrap.lua").is_file()
        and (staged_system / "shaders/bgfx/glsl-330/rmlui.fs.bin").is_file())
    if player_ready:
        # Load the package written by THIS cold CLI, not a separate build-tree
        # runtime fixture. The production player bootstrap verifies its hash,
        # opens the ZIP and renders the initial Feature Lab frames.
        smoke = subprocess.run(
            [shutil.which("cmake"), f"-DPLAYER={player}", f"-DPACKAGE={package}",
             f"-DWORK_DIR={root / 'player-smoke'}",
             f"-DXVFB_RUN={shutil.which('xvfb-run')}", "-P",
             str(Path(sys.argv[2]).resolve() /
                 "tests/cmake/player_runtime_package_smoke.cmake")],
            text=True, capture_output=True, timeout=75,
        )
        assert smoke.returncode == 0 and "NOVELTEA_PLAYER_READY" in (
            smoke.stdout + smoke.stderr), (smoke.stdout[-2000:], smoke.stderr[-2000:])
    else:
        print("SKIP cold Feature Lab player smoke: built Linux player, Xvfb or "
              "staged runtime bootstrap/shaders unavailable.")
    # Failed export policy and unsafe output must preserve existing complete ZIP.
    rejected = run("package", "export", "--output", str(package),
                   "--profile", "nonexistent-profile", exit_code=4)
    assert rejected["diagnostics"][0]["code"] == "export.profile_missing"
    assert hashlib.sha256(package.read_bytes()).hexdigest() == old_hash
    warnings = run("package", "export", "--output", str(package), exit_code=4)
    assert any(item["code"] == "localization.export.warning_override_required"
               for item in warnings["diagnostics"])
    assert hashlib.sha256(package.read_bytes()).hexdigest() == old_hash
    symlink = root / "output-link.ntpkg"
    try:
        symlink.symlink_to(package)
    except (OSError, NotImplementedError):
        # Windows without Developer Mode/symlink privilege cannot establish
        # this precondition. Record an explicit skipped *subcase*.
        print("SKIP symlink-output case: host does not permit symlinks.", flush=True)
    else:
        blocked = run("package", "export", "--output", str(symlink),
                      "--allow-localization-warnings", exit_code=4)
        assert blocked["diagnostics"][0]["code"] == "export.output_invalid"
        assert hashlib.sha256(package.read_bytes()).hexdigest() == old_hash

    custom = root / "custom.ntpkg"
    custom_result = run("package", "export", "--output", str(custom),
                        "--include-unused-assets", "--include-shader-sources",
                        "--allow-localization-warnings", timeout=240)
    assert custom_result["runtimeCache"]["published"] is False
    assert current() == first
    assert_package(custom, include_unused=True, shader_sources=True)
    print("Profile overrides and failure-preserving outputs passed.", flush=True)

    # Missing physical source cannot silently reuse the previously prepared
    # Asset or truncate an already successful output package.
    source = project / "assets/audio/music_loop.mp3"
    source.unlink()
    failure = run("package", "export", "--output", str(package),
                  "--allow-localization-warnings", exit_code=70, timeout=220)
    assert not failure["success"] and any(
        item["code"] == "CLI_NATIVE_RUNTIME_CACHE_INVALID"
        for item in failure["diagnostics"])
    assert hashlib.sha256(package.read_bytes()).hexdigest() == old_hash
    print("Cold relocated native Feature Lab: 43/43, all Test forms, ZIP readback, "
          "profile overrides and failed-output preservation passed.")
