# Standalone Graphics Benchmark (Linux runner, #422–#423)

The dedicated `noveltea-benchmark-app` measures an SDL3/bgfx reference workload
without creating a NovelTea Engine, sandbox, player, RmlUi, or ImGui frontend.
The original `noveltea-benchmark` JSON/Lua microbenchmark and release-report
collector are unaffected. The portable runner and JSON contracts now provide
the foundation for later Android/Web ports and additional scenario hosts.

## Running Clean reference trials

From the repository root:

```sh
./scripts/run-benchmark.sh --smoke
./scripts/run-benchmark.sh --warmup-seconds 3 --seconds 10 --repeats 3
./scripts/run-benchmark.sh --no-build --frames 300 --vsync --raw-samples
./scripts/run-benchmark.sh --no-build --config my-run.json --output /tmp/run.json
./scripts/run-benchmark.sh --debug --smoke
```

The script defaults to the optimized `linux-benchmark-release` preset and
builds only `noveltea-benchmark-app`. `--debug` selects a separate Debug
preset (do not use its results as optimized comparisons); `--no-build` uses
the existing binary. CMake build concurrency honors
`CMAKE_BUILD_PARALLEL_LEVEL`. Reports default to the Git-ignored
`build/linux-benchmark-release/benchmarks/` or the chosen preset's equivalent.

The reference workload touches one empty bgfx view and advances one frame
without clearing, geometry, UI, or Engine activity. It does **not** establish
GPU-execution time or independently confirmed presented-frame counts.

`--warmup-seconds` defaults to 3, `--seconds` to 10, `--repeats` to 1,
`--ready-timeout-seconds` to 5. `--frames` selects a fixed count
instead of a measurement duration. For each trial the runner executes
Preparation, explicit readiness polling, Warmup, Measurement, Completion,
Results, and Cleanup. It begins timing only after the scenario reports Ready.
All scenarios clean up even if preparation, readiness, a frame, or completion
fails, and independent suite scenarios continue after failure. A CPU-only
scenario may implement the same interface without initializing graphics.
The Linux app currently supports only the `raw-bgfx-empty` scenario.

Clean/no-UI operation is the only implemented profile in this ticket; `--no-ui`
is explicit but also the default. No ImGui or debugger resources are created.
Diagnostic mode and a dashboard are later tickets. `--smoke` requests
30 measured frames without warmup. At most 20 trials and 300,000 measured
frames per trial are accepted. Duration runs also use a fixed 300,000-sample
capacity; exceeding it fails with an explicit error rather than allocating
during sampling or silently dropping samples. No logger or JSON encoder runs
inside the measurement loop.

## Current JSON contracts

The accepted standalone configuration is the *single* current
`noveltea.benchmark.configuration` shape, version 1, with an exact field
inventory (no legacy aliases or unknown fields):

```json
{
  "format": "noveltea.benchmark.configuration",
  "version": 1,
  "scenario": "raw-bgfx-empty",
  "scenario_version": 1,
  "parameters": {},
  "clock_policy": "realtime",
  "settings": {
    "width": 1280,
    "height": 720,
    "warmup_seconds": 3,
    "measurement_seconds": 10,
    "measurement_frames": 0,
    "repeats": 1,
    "ready_timeout_seconds": 5,
    "profile": "clean",
    "no_ui": true,
    "raw_samples": false,
    "vsync": false,
    "output": ""
  }
}
```

The `--config` file is validated before graphics init and cannot be mixed
with run-setting flags; `--output` can override the file's destination.
The raw empty workload has a fixed scenario version (1), no parameters,
and real-time wall-clock policy; alternative values are rejected until an
owning scenario implements them.
All configurations emitted in reports use exactly this shape.

Results use `noveltea.benchmark.result` version 1, containing the full
configuration, source commit, tracked-source dirty flag, source fingerprint SHA-256,
build type/compiler, platform/SDL video driver, bgfx backend and available GPU
identifiers, workload description and
per-trial phase/outcome/reason, measured counts and duration, and aggregate
statistics. They distinguish `complete`, `partial`, and `failed` suites.
Each successful trial and aggregate has mean/min/max/p50/p95/p99/standard
deviation for CPU frame-operation duration and wall-frame intervals.
Percentiles use sorted samples and linear rank interpolation; aggregate
percentiles use all successful measured frames, not averages of trial
percentiles. Raw sample pairs are emitted only with `--raw-samples`.

A wall-frame interval is the elapsed CPU clock time from the preceding
measured frame's end to this frame's end (for the first sample, from
measurement start). `cpu_operation_ms` measures the scenario's frame
operation, including SDL event polling and bgfx frame submission/wait.
`frame_loop_cadence_hz` is measured completed work units divided by
measured wall seconds, **not independently verified display FPS**.
GPU execution, bgfx synchronization counters, driver version, and displayed
frame count are `null` where unavailable, never inferred from the
duration of `bgfx::frame()`. Cleanup and any asynchronous completion work
are excluded from measured samples. Incomplete trials retain their actual
observed frame counts but do not contribute to successful aggregates. Scenario
cleanup returns an explicit success/failure and diagnostic. If teardown fails,
the trial fails even if measurement completed; prior preparation/frame errors
remain in the reason, followed by the cleanup error. Failed trials do not
publish successful distributions or contribute to aggregates.

Source identity is generated into a build-local header **at build time** and
compiled into the binary. Building again after advancing HEAD or modifying
tracked sources regenerates the header only if its content changes; CMake
reconfiguration is not required. The fingerprint hashes the commit identity
and tracked diff, distinguishing successive dirty builds of the same commit.
These fields identify the binary as built, not the checkout at report export
time. Git-unavailable builds label their revision/fingerprint unavailable and
the tracked-source dirty value `null`, rather than claiming a clean build.

## Validation and GPU requirements

```sh
cmake --preset linux-benchmark-debug -DBUILD_TESTING=ON
cmake --build --preset linux-benchmark-debug --target noveltea-benchmark-app \
  noveltea-benchmark-runner-tests noveltea-benchmark-report-tests noveltea-benchmark-options-tests
ctest --test-dir build/linux-benchmark-debug -R '^noveltea_benchmark_' --output-on-failure
```

Deterministic runner tests use synthetic scenarios/clock to validate readiness
timeouts, phase boundaries, repeats, cleanup errors, original-error preservation,
and continuation. The source-identity test uses an isolated Git fixture to
exercise tracked modifications, HEAD changes without a reconfigure, and stable
header timestamps on unchanged builds. Report/config tests validate exact
current-only input, failure/null metadata,
and statistics independent of GPU performance. The Linux graphics CTest
uses Xvfb when available for functional smoke **only**, never a hardware
performance baseline. No FPS thresholds are imposed.

For real WSL2 NVIDIA measurements, ensure these variables are set first
(they are not automatically set by the launcher):

```sh
export DISPLAY="${DISPLAY:-:0}"
export LD_LIBRARY_PATH="/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GALLIUM_DRIVER=d3d12
export MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA
glxinfo -B
```

Verify that the renderer is `D3D12 (NVIDIA GeForce RTX 5070 Ti)` with
`Accelerated: yes`. Do not classify Xvfb or llvmpipe as GPU performance
qualifications. SDL window close, focus loss, and surface-size changes fail
the current trial with an explicit reason rather than exporting fabricated
successful measurements.

**Feature Lab:** not applicable: the baseline intentionally has no
authorable runtime behavior.
