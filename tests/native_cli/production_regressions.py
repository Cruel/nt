#!/usr/bin/env python3
"""Real installed C++ CLI regression witnesses for #522 review findings."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


cli = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()

with tempfile.TemporaryDirectory(prefix="noveltea-522-regression-") as scratch:
    # Apple's TemporaryDirectory commonly lives under /var/folders, where
    # /var is an OS-owned alias of /private/var. Keep the primary fixture
    # canonical, then exercise /var and /tmp aliases explicitly below.
    original_root = Path(scratch)
    root = original_root.resolve()
    home = root / "home"
    home.mkdir()
    environment = {**os.environ, "HOME": str(home), "USERPROFILE": str(home),
                   "NOVELTEA_USER_CONFIG_ROOT": str(home),
                   "XDG_CONFIG_HOME": str(home / "config"),
                   "XDG_CACHE_HOME": str(home / "cache"),
                   "XDG_STATE_HOME": str(home / "state"),
                   "XDG_RUNTIME_DIR": str(home / "runtime")}
    (home / "runtime").mkdir(mode=0o700)
    environment.pop("NOVELTEA_NO_DAEMON", None)

    def command(*args, env=environment, stdin=None, expected=0, timeout=120):
        result = subprocess.run([str(cli), "--json", *map(str, args)],
                                env=env, cwd=root, input=stdin, text=True,
                                capture_output=True, timeout=timeout)
        assert result.returncode == expected, (args, result.returncode,
                                               result.stdout, result.stderr)
        assert not result.stderr, (args, result.stderr)
        parsed = json.loads(result.stdout)
        assert parsed["exitCode"] == expected, (args, parsed)
        return parsed

    # The daemon must receive the exact JSON stdin required by --apply; local
    # execution and an attempted broker route with no listening daemon agree.
    for local in (True, False):
        project = root / ("reconcile-local" if local else "reconcile-daemon")
        command("project", "create", project, "--name", "Reconcile")
        arguments = (["--no-daemon"] if local else []) + ["--project", project]
        plan = command(*arguments, "localization", "reconcile")["plan"]
        value = json.dumps({"expectedWorkspaceRevision": plan["expectedWorkspaceRevision"],
                            "expectedFingerprint": plan["expectedFingerprint"],
                            "resolutions": {}})
        applied = command(*arguments, "localization", "reconcile", "--apply",
                          stdin=value)
        assert applied["success"] and applied["writes"] == [], applied
        missing = command(*arguments, "localization", "reconcile", "--apply",
                          stdin="", expected=2)
        assert "stdin" in missing["diagnostics"][0]["message"], missing
    command("daemon", "stop")
    print("Default daemon and --no-daemon reconciliation stdin agree.")

    # This regression is about output parents and symlink safety, not media
    # preparation. Use a fresh playable Project so the cold native package
    # build exercises real publication without requiring Feature Lab's FFmpeg.
    project = root / "export-project"
    command("project", "create", project, "--name", "Native Export Path")
    command("--no-daemon", "--project", project, "entity", "create", "rooms", "start")
    with (project / "project.yaml").open("a", encoding="utf-8") as manifest:
        manifest.write("\nentrypoint:\n  kind: room\n  id: start\n")
    destination = root / "nonexistent" / "child" / "nested" / "game.ntpkg"
    package_args = ("--no-daemon", "--project", project, "package", "export",
                    "--allow-localization-warnings", "--output")
    output = command(*package_args, destination, timeout=180)
    assert output["success"] and zipfile.is_zipfile(destination), output
    assert output["runtimeCache"]["status"] == "miss" and output["runtimeCache"]["published"], output
    assert not list(destination.parent.glob("*.tmp-*"))
    # An existing symlink in a parent component must never be followed, even
    # when the final destination is otherwise a replaceable regular file.
    if os.name != "nt":
        alias = root / "alias"
        alias.symlink_to(destination.parent, target_is_directory=True)
        unsafe = command(*package_args, alias / "unsafe.ntpkg", expected=4, timeout=180)
        assert unsafe["diagnostics"][0]["code"] == "export.output_invalid", unsafe
        assert not (destination.parent / "unsafe.ntpkg").exists()
    if sys.platform == "darwin":
        # Exercise the actual OS aliases, not a fabricated user-controlled
        # symlink. The latter must still fail beneath either trusted prefix.
        assert Path("/tmp").resolve() == Path("/private/tmp")
        assert Path("/var").resolve() == Path("/private/var")
        with (tempfile.TemporaryDirectory(prefix="noveltea-macos-tmp-", dir="/tmp") as temp_tmp,
              tempfile.TemporaryDirectory(prefix="noveltea-macos-var-", dir="/var/tmp") as temp_var):
            mac_targets = [Path(temp_tmp) / "nested" / "game.ntpkg",
                           Path(temp_var) / "nested" / "game.ntpkg"]
            if original_root.parts[:2] == ("/", "var"):
                mac_targets.append(original_root / "mac-var-folders-output" / "game.ntpkg")
            for alias_target in mac_targets:
                accepted = command(*package_args, alias_target, timeout=180)
                assert accepted["success"] and zipfile.is_zipfile(alias_target), accepted
            user_link = Path(temp_tmp) / "user-link"
            user_link.symlink_to(destination.parent, target_is_directory=True)
            rejected = command(*package_args, user_link / "unsafe.ntpkg",
                               expected=4, timeout=180)
            assert rejected["diagnostics"][0]["code"] == "export.output_invalid", rejected
            assert not (destination.parent / "unsafe.ntpkg").exists()
        print("macOS /tmp and /var system aliases accepted; nested user symlink rejected.")
    print("Runtime Package export creates safe missing parents and rejects symlinks.")

    if os.name != "nt":
        # curl is replaced only in this disposable PATH. It returns a valid
        # object_info GET response but exits before reading any POST payload.
        (home / "config.json").write_text(json.dumps({
            "format": "noveltea.user-config", "formatVersion": 1,
            "preferences": {},
            "comfyui": {"serverUrl": "https://example.com", "requestTimeoutMs": 4000,
                        "defaultWorkflows": {"image.generate": "flux2-klein-text-to-image"}},
        }))
        manifests = [json.loads(file.read_text()) for file in
                     (repo / "editor/assets/comfyui/workflows").glob("*.manifest.json")]
        node_inputs = {}
        for definition in manifests:
            for bindings in definition["bindings"].values():
                for binding in bindings:
                    node_inputs.setdefault(binding["classType"], set()).add(binding["inputName"])
            for name in definition["requiredNodeClasses"]:
                node_inputs.setdefault(name, set())
        object_info = {name: {"input": {"required": {field: ["STRING"] for field in fields}}}
                       for name, fields in node_inputs.items()}
        shim_dir = root / "shim"
        shim_dir.mkdir()
        shim_log = root / "curl-requests.log"
        curl = shim_dir / "curl"
        curl.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                        "method = sys.argv[sys.argv.index('--request') + 1]\n"
                        "with open(os.environ['NOVELTEA_SHIM_LOG'], 'a') as log: log.write(method + '\\n')\n"
                        f"if method == 'GET': print({json.dumps(json.dumps(object_info))})\n"
                        "else: sys.exit(7)\n")
        curl.chmod(0o755)
        shim_env = {**environment, "PATH": f"{shim_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
                    "NOVELTEA_SHIM_LOG": str(shim_log)}
        output_dir = root / "https-output"
        output_dir.mkdir()
        for attempt, prompt in enumerate(("short", "long-" + "x" * 100_000), start=1):
            rejected = command("--no-daemon", "comfyui", "run", "--type", "image.generate",
                               "--input", f"prompt={prompt}", "--output", output_dir,
                               "--server", "https://example.com", env=shim_env,
                               expected=4, timeout=45)
            assert any(item["code"] == "COMFYUI_SERVER_UNAVAILABLE"
                       for item in rejected["diagnostics"]), rejected
            assert shim_log.read_text().splitlines().count("POST") == attempt, (
                "The request never exercised an early-exiting POST helper.",
                shim_log.read_text())
        assert not list(output_dir.iterdir())
        print("Early HTTPS curl exit returns JSON for small and 100 KB POST payloads.")

print("Native CLI post-cutover production regression contracts passed.")
