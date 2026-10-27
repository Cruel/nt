"""Executable cold/warm native runtime lifecycle, without a ScriptC artifact fixture."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


cli, generator, identity = map(str, sys.argv[1:4])
cli = str(Path(cli).resolve())
generator = str(Path(generator).resolve())
if not identity:
    print("SKIP: native compiler identity is not sealed for this build.")
    sys.exit(77)


with tempfile.TemporaryDirectory(prefix="noveltea-native-cold-runtime-") as temporary:
    base = Path(temporary)
    project = base / "game"
    created = subprocess.run(
        [generator, str(project), "--create-small"],
        text=True, capture_output=True, check=True, timeout=45,
    )
    assert json.loads(created.stdout)["created"]
    with (project / "project.yaml").open("a", encoding="utf-8") as source:
        source.write("\nentrypoint:\n  kind: room\n  id: starting-room\n")

    def run(*args, expected=None):
        invocation = subprocess.run(
            [cli, "--json", "--no-daemon", "--project", str(project), *args],
            text=True, capture_output=True, timeout=120,
        )
        assert invocation.stderr == "", invocation.stderr
        lines = invocation.stdout.splitlines()
        assert len(lines) == 1, invocation.stdout
        result = json.loads(lines[0])
        assert result["exitCode"] == invocation.returncode == expected, result
        assert result["protocolVersion"] == 1, result
        return result

    def current():
        return (project / ".noveltea/cache/runtime/current").read_text().strip()

    # A genuine cold Project must compile, prepare and publish before a named
    # authored Test can report that its requested ID is absent.
    cold = run("test", "run", "missing", expected=6)
    assert cold["runtimeCache"]["status"] == "miss", cold
    assert cold["runtimeCache"]["published"] is True, cold
    assert cold["diagnostics"][0]["code"] == "native.test.spec", cold
    first = current()

    warm = run("test", "run", "missing", expected=6)
    assert warm["runtimeCache"]["status"] == "hit", warm
    assert current() == first

    # The Test catalog is a separately refreshed generation. Adding only an
    # authored Test must leave the compiled gameplay wire unchanged, even
    # though the canonical pointer advances after executing that Test.
    run("entity", "create", "tests", "catalog-only", expected=0)
    refreshed = run("test", "run", "catalog-only", expected=0)
    assert refreshed["runtimeCache"]["status"] == "hit", refreshed
    assert refreshed["runtimeCache"]["testCatalogStatus"] != "hit", refreshed
    assert refreshed["runtimeCache"]["published"] is True, refreshed
    catalog_generation = current()
    assert catalog_generation != first
    generations = project / ".noveltea/cache/runtime/generations"
    assert json.loads((generations / first / "artifact.json").read_text()) == json.loads(
        (generations / catalog_generation / "artifact.json").read_text()
    )

    # An authored gameplay source edit invalidates the pointer, not the old
    # generation's durability, and invokes the same native cold compiler.
    with (project / "records/rooms/starting-room.yaml").open("a", encoding="utf-8") as source:
        source.write("\n# source metadata changed\n")
    stale = run("test", "run", "missing", expected=6)
    assert stale["runtimeCache"]["status"] == "stale", stale
    assert stale["runtimeCache"]["published"] is True, stale
    second = current()
    assert second != catalog_generation
    assert (generations / first / "manifest.json").is_file()

    # A damaged runtime artifact is not a cache hit and cannot be interpreted
    # as the current Compiled Project, even if the pointer still exists.
    artifact = project / ".noveltea/cache/runtime/generations" / second / "artifact.json"
    artifact.write_text("{malformed", encoding="utf-8")
    corrupted = run("test", "run", "missing", expected=6)
    assert corrupted["runtimeCache"]["status"] == "unusable", corrupted
    assert corrupted["runtimeCache"]["published"] is True, corrupted
    third = current()
    assert third != second

    # A deliberately rehashed but internally inconsistent runtime artifact
    # must also be rejected; a matching manifest SHA is not compilation proof.
    directory = project / ".noveltea/cache/runtime/generations" / third
    compiled_file = directory / "artifact.json"
    forged = json.loads(compiled_file.read_text())
    forged["compiledProject"]["project"]["name"] = "forged gameplay"
    forged_bytes = (json.dumps(forged, separators=(",", ":")) + "\n").encode()
    compiled_file.write_bytes(forged_bytes)
    manifest_file = directory / "manifest.json"
    manifest = json.loads(manifest_file.read_text())
    manifest["artifactSha256"] = "sha256:" + hashlib.sha256(forged_bytes).hexdigest()
    manifest_file.write_text(json.dumps(manifest))
    rehashed = run("test", "run", "missing", expected=6)
    assert rehashed["runtimeCache"]["status"] == "unusable", rehashed
    assert rehashed["runtimeCache"]["published"] is True, rehashed
    fourth = current()
    assert fourth != third

    # Force a rebuild without changing source inputs or exporting a different
    # profile; a new complete pointer must replace the previous generation.
    package = base / "game.ntpkg"
    forced = run("package", "export", "--output", str(package),
                 "--force-rebuild", expected=0)
    assert forced["runtimeCache"]["published"] is True, forced
    assert package.is_file() and package.stat().st_size > 1000
    assert current() != fourth

    # Export overrides are per-invocation only. They must not publish a
    # different-profile artifact over the canonical default cache generation.
    default_generation = current()
    custom_package = base / "custom.ntpkg"
    override = run("package", "export", "--output", str(custom_package),
                   "--include-unused-assets", "--include-shader-sources", expected=0)
    assert override["runtimeCache"]["published"] is False, override
    assert custom_package.is_file() and custom_package.stat().st_size > 1000
    assert current() == default_generation

    # Unsafe symlinked cache state fails Project admission before an attempt
    # to publish, and must never replace the pointer or steal a generation.
    pointer = project / ".noveltea/cache/runtime/current"
    pointer.unlink()
    pointer.symlink_to(base / "not-an-owned-generation")
    no_cache = run("test", "run", "missing", expected=4)
    assert no_cache["runtimeCache"]["status"] == "unusable", no_cache
    assert no_cache["runtimeCache"]["published"] is False, no_cache
    assert no_cache["diagnostics"][0]["code"] == "WORKSPACE_SOURCE_READ", no_cache
    assert pointer.is_symlink()
    assert (project / ".noveltea/cache/runtime/generations" / third / "manifest.json").is_file()

    print("Native runtime cold/warm, stale/corrupt recovery, forced build and cache safety passed.")
