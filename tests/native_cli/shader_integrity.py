"""Focused warm Runtime Package shader corruption and recovery acceptance."""

import hashlib
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
writer = Path(sys.argv[3]).resolve()
ffmpeg = Path(sys.argv[4]).resolve()
if not ffmpeg.is_file():
    print("SKIP: pinned FFmpeg media tool is unavailable")
    sys.exit(77)


with TemporaryDirectory(prefix="noveltea-shader-integrity-") as temporary:
    base = Path(temporary)
    project = base / "project"
    shutil.copytree(fixture, project, ignore=shutil.ignore_patterns(".noveltea"))
    package = base / "game.ntpkg"
    environment = {**os.environ, "NOVELTEA_FFMPEG": str(ffmpeg),
                   "NOVELTEA_NO_DAEMON": "1"}

    def export(*options, exit_code=0):
        process = subprocess.run([
            str(cli), "--json", "--no-daemon", "--project", str(project),
            "package", "export", "--output", str(package),
            "--allow-localization-warnings", *options,
        ], env=environment, text=True, capture_output=True, timeout=240)
        assert process.returncode == exit_code, (
            process.stdout[-3000:], process.stderr[-2000:])
        assert not process.stderr, process.stderr
        return json.loads(process.stdout)

    def generation():
        return (project / ".noveltea/cache/runtime/current").read_text().strip()

    def artifact():
        return json.loads((project / ".noveltea/cache/runtime/generations" /
                           generation() / "artifact.json").read_text())

    def binary_revisions(value):
        options = value["packageOptions"]
        expected = {}
        for shader in options["shaderMaterialMetadata"]["shaders"].values():
            for stage in shader["stages"].values():
                for compiled in stage["compiled"].values():
                    path = compiled["runtimePath"]
                    if path.startswith("project:/"):
                        relative = path[len("project:/"):]
                        revision = (compiled["byteHash"], compiled["byteSize"])
                        assert relative not in expected or expected[relative] == revision
                        expected[relative] = revision
        assert expected and set(expected) == set(options["requiredShaderBinaryPaths"])
        return expected

    def assert_package_shaders(value):
        expected = binary_revisions(value)
        with ZipFile(package) as archive:
            for path, (digest, size) in expected.items():
                data = archive.read(path)
                assert len(data) == size and "sha256:" + hashlib.sha256(data).hexdigest() == digest

    cold = export()
    assert cold["success"] and cold["runtimeCache"]["status"] == "miss", cold
    first = generation()
    compiled = artifact()
    assert_package_shaders(compiled)
    binaries = binary_revisions(compiled)
    shader_root = Path(compiled["packageOptions"]["shaderAssetRoot"])
    target_name = next(iter(binaries))
    target = shader_root / target_name
    previous_zip = hashlib.sha256(package.read_bytes()).hexdigest()

    # The writer must reject altered shader bytes even when called directly
    # with the already admitted artifact and its recorded byteHash metadata.
    original_shader = target.read_bytes()
    target.write_bytes(b"\xA5" * len(original_shader))
    direct_output = base / "rejected.ntpkg"
    attempt = subprocess.run([str(writer), "--write-native-package-stdin"],
                             input=json.dumps({"project": compiled["compiledProject"],
                                               "options": compiled["packageOptions"],
                                               "outputPath": str(direct_output)}),
                             capture_output=True, text=True, timeout=60)
    assert attempt.returncode == 0, attempt.stderr
    rejected = json.loads(attempt.stdout)
    assert not rejected["success"] and any(
        d.get("category") == "shader" or d.get("code") == "shader"
        for d in rejected.get("diagnostics", [])), rejected
    assert hashlib.sha256(package.read_bytes()).hexdigest() == previous_zip

    warm = export()
    assert warm["success"] and warm["runtimeCache"]["status"] == "stale", warm
    assert generation() != first
    repaired = artifact()
    assert_package_shaders(repaired)
    assert target.read_bytes() == original_shader

    # A missing binary is also regenerated; mere existence of a source
    # manifest/cache generation cannot suffice for warm publication.
    previous = generation()
    unrecorded = target.parent / "unrecorded-stale.fs.bin"
    unrecorded.write_bytes(original_shader)
    target.unlink()
    missing = export()
    assert missing["success"] and missing["runtimeCache"]["status"] == "stale", missing
    assert generation() != previous and target.is_file()
    assert_package_shaders(artifact())
    with ZipFile(package) as archive:
        assert unrecorded.relative_to(shader_root).as_posix() not in archive.namelist()

    # Unsafe output cannot be repaired by writing through a symlink. This
    # failure must retain both the incumbent complete package and cache.
    last = generation()
    incumbent = hashlib.sha256(package.read_bytes()).hexdigest()
    external = base / "outside-shader.bin"
    external.write_bytes(b"external invariant")
    target.unlink()
    try:
        target.symlink_to(external)
    except (OSError, NotImplementedError):
        print("SKIP symlink failure-path case: host disallows symlinks")
    else:
        blocked = export(exit_code=4)
        assert not blocked["success"], blocked
        assert target.is_symlink() and external.read_bytes() == b"external invariant"
        assert generation() == last
        assert hashlib.sha256(package.read_bytes()).hexdigest() == incumbent

    print("Warm shader digest/missing repair, direct writer rejection and incumbent safety passed.")
