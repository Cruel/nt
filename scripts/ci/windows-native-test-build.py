#!/usr/bin/env python3
"""Transport the exact MSVC test/runtime closure to independent Windows consumers."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile

BUILD = Path("build/windows-release")
SHADERS = Path("build/prebuilt-shader-assets")
SUITES = {
    "lightweight": ["-L", "early-windows"],
    "transactions": ["-R", "^native_authoring_(yaml_transaction|room_session|room_map|project_session)$"],
    "platform": ["-R", "^native_cli_(windows_pe_resources|platform_publication|platform_commands|public_contract|macos_export)$"],
    "repair": ["-R", "^native_cli_repair_project$"],
    "validation": ["-R", "^native_cli_(incremental_validation_certification|shader_validation_cache|portable_validation_cache)$"],
}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def identity():
    return {
        "kind": "windows-msvc-release-test-build",
        "checkout": os.path.normcase(str(Path.cwd().resolve())),
        "machine": platform.machine(),
        **{key: os.environ[key] for key in
           ("GITHUB_REPOSITORY", "GITHUB_WORKFLOW", "GITHUB_SHA", "GITHUB_RUN_ID")},
    }


def template(source_sha=None):
    sha = source_sha if source_sha is not None else os.environ["GITHUB_SHA"]
    return Path("dist") / f"noveltea-player-template-ci-{sha}-windows-x64-release.zip"


def inventory(suite):
    data = json.loads(subprocess.check_output(
        ["ctest", "--test-dir", str(BUILD), "--show-only=json-v1", *SUITES[suite]],
        text=True))
    tests = data["tests"]
    if not tests or any(not test.get("command") for test in tests):
        raise ValueError(f"Missing runnable tests for {suite}")
    # Paths and selected registration properties must agree at both ends.
    return hashlib.sha256(json.dumps(tests, sort_keys=True).encode()).hexdigest()


def required(source_sha=None):
    for path in (BUILD / "CMakeCache.txt", BUILD / "CTestTestfile.cmake",
                 BUILD / "tools/editor_tool/native-cli/noveltea.exe", template(source_sha)):
        if not path.is_file():
            raise ValueError(f"Missing native build input: {path}")
    if not SHADERS.is_dir():
        raise ValueError("Missing prebuilt shaders")
    if "CMAKE_BUILD_TYPE:STRING=Release" not in (BUILD / "CMakeCache.txt").read_text():
        raise ValueError("Expected Release CMake configuration")


def excluded(path):
    # Prune before tarfile stats or dereferences the path. In particular, the
    # pinned LIEF examples contain source-only symlinks which are inaccessible
    # on some Windows runners. libfyaml's documentation is similarly unused.
    unused_source_trees = (
        BUILD / "_deps/noveltea_lief-src/examples",
        BUILD / "_deps/noveltea_libfyaml-src/doc",
    )
    return (any(part == ".git" or part.endswith("-subbuild") or part == "Testing"
                for part in path.parts)
            or any(path == root or root in path.parents for root in unused_source_trees)
            or path.suffix.lower() in
            {".obj", ".o", ".lib", ".a", ".pdb", ".pch", ".ipdb", ".iobj", ".ilk"})


def add_tree(tar, path):
    if excluded(path):
        return
    # Do not suppress unexpected filesystem errors: a missing runtime input
    # must still fail the producer. Prune only explicitly non-runtime paths.
    tar.add(path, arcname=path.as_posix(), recursive=False)
    if path.is_dir():
        for child in sorted(path.iterdir()):
            add_tree(tar, child)


def pack(dest):
    required()
    dest.mkdir(parents=True, exist_ok=True)
    archive = dest / "native.tar.gz"
    inventories = {suite: inventory(suite) for suite in SUITES}
    with tarfile.open(archive, "w:gz", compresslevel=1, dereference=True) as tar:
        for root in (BUILD, SHADERS, template()):
            add_tree(tar, root)
    manifest = {"identity": identity(), "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
                "sha256": sha256(archive), "inventories": inventories}
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"MSVC native test closure: {archive.stat().st_size:,} bytes")


def restore(dest, authorized_build=None):
    expected = identity()
    source_sha = expected["GITHUB_SHA"]
    if authorized_build is not None:
        source_sha, run_id, attempt = authorized_build
        # Extended's dispatch SHA/attempt need not be the selected Build's.
        # Bind the archive to the independently authorized producer AND the
        # actual immutable checkout, never substitute the consumer identity.
        if (expected["GITHUB_WORKFLOW"] != "Extended Qualification" or
                expected["GITHUB_REPOSITORY"] != "Cruel/nt" or
                subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != source_sha or
                not run_id.isdecimal() or int(run_id) <= 0 or attempt <= 0):
            raise ValueError("Invalid Extended Build authority")
        expected.update(GITHUB_WORKFLOW="Build", GITHUB_SHA=source_sha, GITHUB_RUN_ID=run_id)
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    archive = dest / "native.tar.gz"
    valid_attempt = (0 < manifest["attempt"] <= int(os.environ["GITHUB_RUN_ATTEMPT"])
                     if authorized_build is None else manifest["attempt"] == attempt)
    if (manifest["identity"] != expected or not valid_attempt or
            manifest["sha256"] != sha256(archive)):
        raise ValueError("Native test artifact identity or archive digest mismatch")
    for root in (BUILD, SHADERS, template(source_sha)):
        if root.exists() or root.is_symlink():
            raise ValueError(f"Refusing to overlay {root}")
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(filter="data")
    required(source_sha)
    for suite in SUITES:
        if inventory(suite) != manifest["inventories"][suite]:
            raise ValueError(f"Restored CTest inventory changed: {suite}")


def main():
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "pack":
        pack(Path(args[1]))
    elif len(args) == 2 and args[0] == "restore":
        restore(Path(args[1]))
    elif len(args) == 5 and args[0] == "restore-build":
        restore(Path(args[1]), (args[2], args[3], int(args[4])))
    else:
        raise ValueError("Expected pack/restore <dir> or restore-build <dir> <sha> <run-id> <attempt>")


if __name__ == "__main__":
    main()
