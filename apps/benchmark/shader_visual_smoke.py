#!/usr/bin/env python3
"""Check real Renderer Material and Postprocess GPU output outside timed sampling.

Uses the benchmark's own inspection PNG and ImageMagick; no FPS thresholds.
"""
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

WIDTH, HEIGHT = 320, 240


def capture(executable: str, directory: Path, name: str, scenario: str,
            *extra: str) -> bytes:
    output = directory / f"{name}.json"
    arguments = [executable, "--scenario", scenario, "--width", str(WIDTH),
                 "--height", str(HEIGHT), "--native-quads", "64",
                 "--native-texture-size", "128", "--inspection-smoke",
                 "--output", str(output), *extra]
    subprocess.run(arguments, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.PIPE, timeout=40)
    matches = sorted((directory / "screenshots").glob(f"{scenario}-*.png"))
    if len(matches) != 1:
        raise RuntimeError(f"{name}: expected one PNG, got {len(matches)}")
    return subprocess.check_output(["convert", str(matches[0]), "-depth", "8",
                                    "rgb:-"], timeout=20)


def mismatch_count(a: bytes, b: bytes, threshold: int) -> int:
    if len(a) != WIDTH * HEIGHT * 3 or len(b) != len(a):
        raise RuntimeError("inspection PNG has unexpected dimensions")
    return sum(any(abs(a[i + channel] - b[i + channel]) > threshold
                   for channel in range(3))
               for i in range(0, len(a), 3))


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: shader_visual_smoke.py /path/to/noveltea-benchmark-app")
    with tempfile.TemporaryDirectory(prefix="noveltea-shader-visual-") as tmp:
        # Each run has its own directory; captures never collide.
        root = Path(tmp)

        def take(name: str, scenario: str, *extra: str) -> bytes:
            directory = root / name
            (directory / "screenshots").mkdir(parents=True)
            return capture(sys.argv[1], directory, name, scenario, *extra)

        legacy = take("plain", "native-2d-geometry")
        material = take("material", "native-shader-material")
        direct = take("direct", "native-postprocess")
        world = take("world", "native-postprocess", "--composition-path",
                     "offscreen", "--composite-passes", "1")
        full = take("full", "native-postprocess", "--composition-path",
                    "offscreen", "--composite-passes", "1", "--shader-scope",
                    "full-game-viewport")
        tinted = take("tinted", "native-postprocess", "--composition-path",
                      "offscreen", "--composite-passes", "1",
                      "--shader-tint", "0.5")
        stacked = take("stacked", "native-postprocess", "--composition-path",
                       "offscreen", "--composite-passes", "3",
                       "--shader-tint", "0.5", "--shader-scope",
                       "full-game-viewport")
        blackout = take("blackout", "native-postprocess", "--composition-path",
                        "offscreen", "--composite-passes", "1", "--shader-tint", "0")

        for name, capture_bytes in (("material", material), ("direct", direct),
                                    ("world neutral", world), ("full neutral", full)):
            mismatches = mismatch_count(legacy, capture_bytes, 8)
            if mismatches > WIDTH * HEIGHT // 50:
                raise RuntimeError(f"{name} diverges from fixed reference: "
                                   f"{mismatches} pixels (>2%)")
        tinted_pixels = mismatch_count(world, tinted, 24)
        stacked_pixels = mismatch_count(full, stacked, 24)
        if tinted_pixels < WIDTH * HEIGHT // 4:
            raise RuntimeError(f"tint material appears bypassed: {tinted_pixels} pixels")
        if stacked_pixels < WIDTH * HEIGHT // 4:
            raise RuntimeError(f"full-game effect stack appears bypassed: "
                               f"{stacked_pixels} pixels")
        if mismatch_count(tinted, stacked, 24) < WIDTH * HEIGHT // 4:
            raise RuntimeError("pass complexity did not change real postprocess output")
        if any(blackout):
            raise RuntimeError("zero-tint inspection accepted non-black output")

        diagnostic_report = root / "diagnostic.json"
        diagnostic_width, diagnostic_height = 480, 300
        subprocess.run([sys.argv[1], "--scenario", "native-postprocess",
                        "--composition-path", "offscreen", "--composite-passes", "2",
                        "--shader-tint", "0.8", "--profile", "diagnostic", "--frames", "12",
                        "--warmup-seconds", "0", "--width", str(diagnostic_width),
                        "--height", str(diagnostic_height), "--output", str(diagnostic_report)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       timeout=40)
        report = json.loads(diagnostic_report.read_text())
        if report["outcome"] != "complete":
            raise RuntimeError("diagnostic shader workload did not complete")
        if (report["graphics"]["width_pixels"] != diagnostic_width or
                report["graphics"]["height_pixels"] != diagnostic_height):
            raise RuntimeError("render-target size does not match configured viewport")
        diagnostic = report["scenarios"][0]["trials"][0]["diagnostic"]
        for metric in ("cpu_submission_ms", "bgfx_frame_cpu_ms"):
            samples = diagnostic[metric]
            if samples is None or samples["samples"] != 12:
                raise RuntimeError(f"diagnostic metric {metric} missing measured frames")
        # Compare direct versus composed through the production A/B/A runner contract.
        # Both arms use neutral tint, so the composition work changes but visuals do not.
        baseline = copy.deepcopy(report["configuration"])
        baseline["parameters"].update(composition_path="direct", passes=0,
                                      tint=1.0, scope="world")
        candidate = copy.deepcopy(baseline)
        candidate["parameters"].update(composition_path="offscreen", passes=2)
        baseline["alternate"] = candidate
        config_path = root / "aba.json"
        config_path.write_text(json.dumps(baseline))
        aba_report = root / "aba-result.json"
        subprocess.run([sys.argv[1], "--config", str(config_path),
                        "--output", str(aba_report)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=40)
        comparison = json.loads(aba_report.read_text())
        trials = comparison["scenarios"][0]["trials"]
        if (comparison["outcome"] != "complete" or
                [trial["arm"] for trial in trials] != ["A", "B", "A"]):
            raise RuntimeError("neutral direct/composed A/B/A did not complete")
        # Unsupported GPU timers must remain null; never substitute bgfx CPU wait times.
        print(f"shader visuals: material/direct/neutral scopes equivalent; "
              f"tint {tinted_pixels} changed pixels; 3-pass stack "
              f"{stacked_pixels} changed pixels")


if __name__ == "__main__":
    main()
