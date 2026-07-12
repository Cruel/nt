#!/usr/bin/env python3
"""Collect reproducible release artifact and native microbenchmark measurements."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def file_record(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    record: dict[str, Any] = {
        "name": path.name,
        "path": str(path),
        "bytes": len(data),
        "gzip_bytes": len(gzip.compress(data, compresslevel=9, mtime=0)),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    if data.startswith(b"\x7fELF"):
        with tempfile.TemporaryDirectory() as temporary_directory:
            stripped = Path(temporary_directory) / path.name
            stripped.write_bytes(data)
            subprocess.run(["strip", "--strip-all", str(stripped)], check=True)
            stripped_data = stripped.read_bytes()
            record["stripped_bytes"] = len(stripped_data)
            record["stripped_gzip_bytes"] = len(
                gzip.compress(stripped_data, compresslevel=9, mtime=0)
            )
    return record


def benchmark_records(path: Path, iterations: int, samples: int) -> list[dict[str, Any]]:
    completed = subprocess.run(
        [str(path), str(iterations), str(samples)], check=True, capture_output=True, text=True
    )
    return [json.loads(line) for line in completed.stdout.splitlines() if line.startswith("{")]


def existing_artifacts(linux_build: Path, web_build: Path | None) -> list[Path]:
    candidates = [
        linux_build / "apps/player/noveltea-player",
        linux_build / "apps/sandbox/noveltea-sandbox",
    ]
    if web_build is not None:
        candidates.extend(
            [
                web_build / "apps/player/player.wasm",
                web_build / "apps/player/player.js",
                web_build / "apps/player/player.data",
                web_build / "apps/sandbox/index.wasm",
                web_build / "apps/sandbox/index.js",
                web_build / "apps/sandbox/index.data",
            ]
        )
    return [path for path in candidates if path.exists()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--revision", default="")
    parser.add_argument("--linux-build", type=Path, required=True)
    parser.add_argument("--web-build", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--samples", type=int, default=11)
    args = parser.parse_args()

    linux = args.linux_build.resolve()
    web = args.web_build.resolve() if args.web_build else None
    benchmark = linux / "tools/benchmark/noveltea-benchmark"
    if not benchmark.is_file():
        raise SystemExit(f"benchmark executable not found: {benchmark}")

    result = {
        "schema": 2,
        "label": args.label,
        "revision": args.revision,
        "environment": {
            "platform": os.uname().sysname + " " + os.uname().release,
            "machine": os.uname().machine,
            "python": os.sys.version.split()[0],
        },
        "artifacts": [file_record(path) for path in existing_artifacts(linux, web)],
        "microbenchmarks": benchmark_records(benchmark, args.iterations, args.samples),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
