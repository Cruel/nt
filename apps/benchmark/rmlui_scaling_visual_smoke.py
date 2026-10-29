#!/usr/bin/env python3
"""Untimed X11 presented-pixel RmlUi scaling check (not a GPU benchmark).

Run under xvfb-run; requires ImageMagick 'import' and xwininfo. The images
are sampled during warmup, before the first measured frame.
"""
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from dashboard_visual_smoke import sample_rgb, window_id


def text_pixels(title: str) -> int:
    # Scale fixture's first row is deliberately separate from rectangle tiles.
    raw = subprocess.check_output(
        ["import", "-window", window_id(title), "-crop", "220x24+24+12",
         "-depth", "8", "rgb:-"],
        stderr=subprocess.DEVNULL, timeout=9,
    )
    if len(raw) != 220 * 24 * 3:
        raise RuntimeError("unexpected RmlUi text-region pixel count")
    return sum(1 for i in range(0, len(raw), 3)
               if min(raw[i], raw[i + 1], raw[i + 2]) > 210)


def run_visible_fixture(exe: str, scenario: str, redraw: str,
                        report_path: Path) -> tuple[int, int, int]:
    argv = [
        exe, "--scenario", scenario, "--ui-elements", "1024",
        "--ui-text-lines", "64", "--ui-visible-contexts", "2",
        "--ui-empty-contexts", "1", "--ui-hidden-contexts", "1",
        "--ui-redraw", redraw, "--ui-text-mode", "static",
        "--warmup-seconds", "7", "--frames", "1",
        "--output", str(report_path),
    ]
    proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    title = ("NovelTea Benchmark: Integrated RmlUi"
             if scenario.startswith("integrated-")
             else "NovelTea Graphics Benchmark: Empty bgfx")
    # Tile #960 is at (20..35, 335..347); no text rows overlap it.
    expected_tile = (80, 120, 150)
    try:
        deadline = time.monotonic() + 5
        while True:
            if proc.poll() is not None:
                raise RuntimeError(f"{scenario} exited before visible warmup")
            try:
                tile = sample_rgb(title, 25, 341)
                background = sample_rgb(title, 4, 4)
                if (max(abs(a - b) for a, b in zip(tile, expected_tile)) <= 12
                        and max(abs(a - b) for a, b in zip(background, (17, 25, 36))) <= 6):
                    white = text_pixels(title)
                    if white >= 15:
                        break
            except (subprocess.CalledProcessError, RuntimeError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"{scenario} {redraw}: pixel mismatch tile={locals().get('tile')}, "
                    f"background={locals().get('background')} or missing text"
                )
            time.sleep(0.15)
        if proc.wait(timeout=13) != 0:
            raise RuntimeError(f"{scenario} {redraw} trial failed")
        with report_path.open() as f:
            result = json.load(f)
        params = result["configuration"]["parameters"]
        if (params["elements"] != 1024 or params["visible_contexts"] != 2
                or params["empty_contexts"] != 1 or params["hidden_contexts"] != 1
                or params["redraw"] != redraw):
            raise RuntimeError(f"{scenario}: incorrect scaling identity in JSON")
        print(f"{scenario} {redraw}: tile={tile} background={background} "
              f"text-white-pixels={white}", flush=True)
        return tile
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)


def main() -> None:
    exe = sys.argv[1]
    with tempfile.TemporaryDirectory(prefix="noveltea-rmlui-scaling-") as directory:
        results = {}
        for scenario in ("standalone-rmlui-scaling", "integrated-rmlui-scaling"):
            for redraw in ("continuous", "dirty-only"):
                results[(scenario, redraw)] = run_visible_fixture(
                    exe, scenario, redraw,
                    Path(directory) / f"{scenario}-{redraw}.json")
        base = results[("standalone-rmlui-scaling", "continuous")]
        for key, actual in results.items():
            if max(abs(a - b) for a, b in zip(actual, base)) > 12:
                raise RuntimeError(f"scaling pixel mismatch: {key}: {base} vs {actual}")
    print("standalone/integrated scaling visible output equivalent", flush=True)


if __name__ == "__main__":
    main()
