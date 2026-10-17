#!/usr/bin/env python3
"""Untimed X11 framebuffer equivalence check for raw composition references.

Captures the real SDL window during warmup, never during measurement.
Requires ImageMagick import and xwininfo; run under xvfb-run.
"""
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TITLE = "NovelTea Graphics Benchmark: Empty bgfx"
WIDTH, HEIGHT = 640, 360


def capture(exe: str, directory: Path, name: str, offscreen: bool,
            overlay: bool) -> bytes:
    report = directory / f"{name}.json"
    args = [exe, "--scenario", "raw-bgfx-composition", "--width", str(WIDTH),
            "--height", str(HEIGHT), "--warmup-seconds", "5", "--frames", "1",
            "--texture-size", "64", "--coverage", "0.75",
            "--output", str(report)]
    if offscreen:
        args += ["--composition-path", "offscreen", "--composite-passes", "2"]
    if not overlay:
        args += ["--no-transparent-overlay"]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 4
        while True:
            if proc.poll() is not None:
                raise RuntimeError(f"{name} terminated before capture")
            try:
                info = subprocess.check_output(["xwininfo", "-name", TITLE],
                                               stderr=subprocess.DEVNULL,
                                               text=True, timeout=2)
                match = re.search(r"Window id: (0x[0-9a-fA-F]+)", info)
                if match:
                    break
            except subprocess.CalledProcessError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError(f"{name} did not create an SDL window")
            time.sleep(0.1)
        time.sleep(1.0)
        pixels = subprocess.check_output(
            ["import", "-window", match.group(1), "-crop",
             f"{WIDTH}x{HEIGHT}+0+0", "-depth", "8", "rgb:-"],
            stderr=subprocess.DEVNULL, timeout=10)
        if len(pixels) != WIDTH * HEIGHT * 3:
            raise RuntimeError(f"{name}: unexpected screenshot size {len(pixels)}")
        if proc.wait(timeout=12) != 0:
            raise RuntimeError(f"{name}: run failed")
        graphics = json.loads(report.read_text())["graphics"]
        workload = graphics["raw_workload"]
        if not workload["semantically_equivalent_to_direct"]:
            raise RuntimeError(f"{name}: falsely labels comparable scene incompatible")
        if workload["composite_passes"] != (2 if offscreen else 0):
            raise RuntimeError(f"{name}: wrong composite count in report")
        if workload["transparent_overlay"] != overlay:
            raise RuntimeError(f"{name}: wrong overlay state in report")
        return pixels
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def differing_pixels(a: bytes, b: bytes, tolerance: int) -> int:
    return sum(
        any(abs(a[i + c] - b[i + c]) > tolerance for c in range(3))
        for i in range(0, len(a), 3)
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="noveltea-composition-visual-") as tmp:
        directory = Path(tmp)
        direct = capture(sys.argv[1], directory, "direct", False, True)
        composed = capture(sys.argv[1], directory, "composed", True, True)
        plain = capture(sys.argv[1], directory, "no-overlay", False, False)
        mismatch = differing_pixels(direct, composed, 4)
        if mismatch > WIDTH * HEIGHT // 100:
            raise RuntimeError(f"direct/offscreen visually diverge: {mismatch} pixels")
        affected = differing_pixels(direct, plain, 16)
        if affected < WIDTH * HEIGHT // 20:
            raise RuntimeError(f"transparent overlay not visibly affecting world: {affected}")
        print(f"composition: direct/offscreen mismatches {mismatch} pixels "
              f"(<=1% at >4 RGB tolerance); overlay changes {affected} pixels")


if __name__ == "__main__":
    main()
