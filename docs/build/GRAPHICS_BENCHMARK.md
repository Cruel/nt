# Standalone Graphics Benchmark (Linux baseline, #422)

This is the first runnable slice of [benchmark spec #421](https://github.com/Cruel/nt/issues/421).
The optional `noveltea-benchmark-app` target links **SDL3 and bgfx only**; it does not
initialize or link NovelTea Engine, the sandbox, a player, RmlUi, or ImGui. Later tickets
add portable scenario orchestration and cross-platform frontends. The existing
`NOVELTEA_BUILD_BENCHMARKS` flag and `noveltea-benchmark` JSON/Lua executable remain independent.

## Run an optimized measurement

From the repository root on Linux with a working X11 or Wayland desktop:

```sh
./scripts/run-benchmark.sh --seconds 10 --warmup-seconds 3
./scripts/run-benchmark.sh --no-build --frames 300 --vsync
./scripts/run-benchmark.sh --debug --smoke
```

The launcher configures the isolated `linux-benchmark-release` preset with `NOVELTEA_BUILD_BENCHMARK_APP=ON`,
devtools off, and the ordinary sandbox/player/host-tool targets off; it builds **only**
`noveltea-benchmark-app`. It honors `CMAKE_BUILD_PARALLEL_LEVEL`. Debug launches are
explicit and should **not** be compared against optimized measurements. `--no-build`
uses the most recently built app in that preset. These dedicated preset directories do not
change the cached production player or sandbox configurations. Any unrecognized launcher argument is
passed to the app; run `./scripts/run-benchmark.sh --no-build --help` for the full CLI.
To configure directly:

```sh
cmake --preset linux-benchmark-release -DNOVELTEA_BUILD_BENCHMARK_APP=ON -DNOVELTEA_ENABLE_DEVTOOLS=OFF
cmake --build --preset linux-benchmark-release --target noveltea-benchmark-app
./build/linux-benchmark-release/apps/benchmark/noveltea-benchmark-app --smoke
```

The baseline workload is a touched **empty bgfx view** with no clear, geometry, UI,
Engine, overlays, or per-frame logging. The fixed-size SDL window is created once;
X11/Wayland native handles are passed to bgfx for an OpenGL swapchain. This is a
CPU frame-loop/handoff baseline, **not** a confirmed presented-frame count, GPU
execution benchmark, or backbuffer-clear test. Its `frame_loop_cadence_hz` includes
polling and wall time between the first and last measured frames.
`bgfx_frame_call_*_ms` measures the CPU wall duration of `bgfx::frame()` and may
include synchronization/pacing wait. GPU timing and presented-frame count are
explicitly `null`, not inferred from CPU time. VSync is off unless `--vsync` is passed.

Warmup and measured intervals are separate, with optional fixed measured-frame count.
The JSON result and concise terminal summary are written **after** measurement.
Default reports are kept under the Git-ignored
`build/linux-benchmark-release/benchmarks/raw-bgfx-empty-<timestamp>.json`; pass
`--output /path/to/file.json` to select a report. Reports include workload, video
driver/renderer, dimensions, VSync request, measured frames/seconds and CPU call
statistics. SDL window-close/focus-loss/surface-change events abort the run with a
nonzero exit instead of producing an apparently valid result.

## Smoke/verification

```sh
./scripts/run-benchmark.sh --smoke
# Inspect the generated report (do not enforce machine-specific FPS thresholds):
# jq -e '.result == "complete" and .measured_frames == 30 and .gpu_execution_ms == null' build/linux-benchmark-release/benchmarks/*.json
```

For a physical-GPU smoke, run the command on the real desktop/session and inspect
its renderer and result. Xvfb with Mesa software rendering validates the Linux
OpenGL path but is **not** a physical GPU performance qualification. In a CI
installation with working Xvfb and Mesa OpenGL, invoke the binary with
`xvfb-run -a .../noveltea-benchmark-app --smoke --output /tmp/benchmark-smoke.json`
and validate its exit code/report. `BUILD_TESTING=ON` registers display-independent
options/statistics and `--help` CTests, plus an Xvfb graphics smoke CTest when
`xvfb-run` is installed. Neither hardware nor CI tests impose any FPS
threshold. A failed graphics initialization must fail the run; no fabricated timings
are emitted. For platform comparability record driver/device outside this minimal
first-slice result if needed; richer run metadata belongs to the later runner tickets.

**Feature Lab:** not applicable. This raw graphics baseline has no authorable
runtime behavior and deliberately must not load a Project.
