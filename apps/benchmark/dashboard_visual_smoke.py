#!/usr/bin/env python3
"""Untimed X11 screenshot regression for bgfx preview -> ImGui ordering.

Requires ImageMagick 'import'. Captures the actual presented window, not
ImGui draw lists, and runs no benchmark sampling. Run under xvfb-run.
"""
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def window_id(title: str) -> str:
    info = subprocess.check_output(
        ["xwininfo", "-name", title], stderr=subprocess.DEVNULL,
        text=True, timeout=2,
    )
    match = re.search(r"Window id: (0x[0-9a-fA-F]+)", info)
    if not match:
        raise RuntimeError(f"missing X11 window: {title}")
    return match.group(1)


def sample_rgb(title: str, x: int, y: int) -> tuple[int, int, int]:
    out = subprocess.check_output(
        ["import", "-window", window_id(title), "-crop", f"1x1+{x}+{y}", "txt:-"],
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=8,
    )
    match = re.search(r"srgb\((\d+),(\d+),(\d+)\)", out)
    if not match:
        raise RuntimeError(f"cannot decode screenshot pixel {x},{y}: {out!r}")
    return tuple(map(int, match.groups()))


def contrast_from_reference(rgb: tuple[int, int, int]) -> int:
    # Solid opaque RmlUi reference background. If view 1 draws *before*
    # views 2..63 then the reference covers all dashboard pixels.
    return sum(abs(a - b) for a, b in zip(rgb, (17, 25, 36)))


def white_text_bounds(title: str) -> tuple[int, int, int, int]:
    # No colored rectangles overlap this upper-left text region. Analyze
    # actual window RGB pixels, not markup or layout declarations.
    width, height = 550, 140
    raw = subprocess.check_output(
        ["import", "-window", window_id(title), "-crop", f"{width}x{height}+50+100",
         "-depth", "8", "rgb:-"],
        stderr=subprocess.DEVNULL,
        timeout=9,
    )
    if len(raw) != width * height * 3:
        raise RuntimeError(f"unexpected screenshot length: {len(raw)}")
    xs, ys = [], []
    for y in range(height):
        for x in range(width):
            offset = (y * width + x) * 3
            if all(channel > 213 for channel in raw[offset:offset + 3]):
                xs.append(x)
                ys.append(y)
    if len(xs) < 100:
        raise RuntimeError(f"reference text is missing: {title} ({len(xs)} pixels)")
    return min(xs), min(ys), max(xs), max(ys)


def assert_text_equivalent(exe: str) -> None:
    # Screenshots are captured strictly during warmup, before the single
    # measured frame. The application itself performs no readbacks.
    bounds = {}
    with tempfile.TemporaryDirectory(prefix="noveltea-benchmark-visual-") as directory:
        for scenario in ("standalone-rmlui-simple",
                         "integrated-rmlui-controlled",
                         "integrated-rmlui-production"):
            report_path = Path(directory) / (scenario + ".json")
            proc = subprocess.Popen(
                [exe, "--scenario", scenario, "--warmup-seconds", "8",
                 "--frames", "1", "--output", str(report_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                title = ("NovelTea Benchmark: Integrated RmlUi"
                         if scenario.startswith("integrated-")
                         else "NovelTea Graphics Benchmark: Empty bgfx")
                end = time.monotonic() + 5
                # Some hosts take time to create their SDL window. Once it
                # exists, wait for the first RmlUi frame to be presented.
                while True:
                    if proc.poll() is not None:
                        raise RuntimeError(f"{scenario} exited before visual warmup")
                    try:
                        bounds[scenario] = white_text_bounds(title)
                        break
                    except (subprocess.CalledProcessError, RuntimeError):
                        if time.monotonic() >= end:
                            raise
                        time.sleep(0.15)
                box = bounds[scenario]
                if box[3] - box[1] > 45:
                    raise RuntimeError(f"multiline reference text in {scenario}: {box}")
                print(f"{scenario}: one-line reference text bounds {box}", flush=True)
                if proc.wait(timeout=13) != 0:
                    raise RuntimeError(f"{scenario} timed benchmark did not complete")
                with report_path.open() as f:
                    graphics = json.load(f)["graphics"]
                if graphics["ui_reference_msaa_samples"] != 2 or (
                    graphics["ui_base_presentation_policy"] != "offscreen-required-by-msaa"
                ):
                    raise RuntimeError(f"{scenario} misreports effective MSAA routing")
                expect_integrated = scenario.startswith("integrated-")
                if graphics["ui_preserve_backbuffer"] != expect_integrated:
                    raise RuntimeError(f"{scenario} misreports backend preserve_backbuffer")
                if graphics["ui_base_direct_compat"] != (
                    scenario == "integrated-rmlui-controlled"
                ):
                    raise RuntimeError(f"{scenario} misreports direct-base request")
                if graphics["ui_offscreen_rendering_observed"] is not None:
                    raise RuntimeError(f"{scenario} fabricates measured offscreen count")
                print(f"{scenario}: live backend settings and offscreen policy verified",
                      flush=True)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=8)
    reference = bounds["standalone-rmlui-simple"]
    for scenario in ("integrated-rmlui-controlled", "integrated-rmlui-production"):
        box = bounds[scenario]
        if any(abs(a - b) > 10 for a, b in zip(box, reference)):
            raise RuntimeError(f"rendered text differs: standalone={reference} {scenario}={box}")
    print("standalone and integrated text visibly equivalent", flush=True)


def main() -> None:
    exe = sys.argv[1]
    process = subprocess.Popen(
        [exe, "--scenario", "standalone-rmlui-simple", "--dashboard-visual-smoke"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    try:
        assert process.stdout is not None
        for phase, points in [
            ("dashboard", [(35, 180), (130, 100)]),
            ("inspection", [(1120, 32), (1170, 34)]),
        ]:
            for line in process.stdout:
                if f"[benchmark] visual {phase} ready" in line:
                    break
            else:
                raise RuntimeError(f"preview exited before {phase} fixture")
            pixels = [sample_rgb("NovelTea Graphics Benchmark: Empty bgfx", x, y)
                      for x, y in points]
            if max(map(contrast_from_reference, pixels)) < 40:
                raise RuntimeError(
                    f"{phase} control not visible over RmlUi preview; pixels={pixels}"
                )
            print(f"{phase} controls visible, window pixels: {pixels}", flush=True)
        if process.wait(timeout=10) != 0:
            raise RuntimeError(f"preview fixture failed with status {process.returncode}")
        assert_text_equivalent(exe)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)


if __name__ == "__main__":
    main()
