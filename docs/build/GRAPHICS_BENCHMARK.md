# Graphics Benchmark (Linux, Android, and Web, #422–#431)

The dedicated `noveltea-benchmark-app` measures SDL3/bgfx, an empty Engine,
and RmlUi reference workloads. Raw and standalone RmlUi **do not instantiate**
the NovelTea Engine, while `engine-empty` and the integrated RmlUi modes use
the real Engine and production Renderer. The binary links the Engine library
for Engine-owned scenarios; standalone scenarios remain separately owned.
Interactive use adds a dedicated Dear ImGui frontend that is fully destroyed before
sampling. The no-UI path initializes no ImGui resources.
The original `noveltea-benchmark` JSON/Lua microbenchmark and release-report
collector are unaffected. The portable runner and JSON contracts cover Linux,
Android, and Web with distinct platform launchers and additional scenario hosts.

## Standalone Web benchmark (#431)

Run the optimized WebGL2 benchmark using Emscripten's SDK environment:

```sh
./scripts/run-benchmark-web.sh
./scripts/run-benchmark-web.sh --debug
./scripts/run-benchmark-web.sh --no-build --no-ui --scenario raw-bgfx-geometry --frames 300
./scripts/run-benchmark-web.sh --no-build --ui --scenario raw-bgfx-geometry
./scripts/run-benchmark-web.sh --no-build --dashboard-smoke --smoke
```

The launcher configures and builds only `noveltea-benchmark-app` using the
`web-benchmark-release` preset (optimized, single-threaded) or
`web-benchmark-debug` with `--debug`; it then serves
`build/<preset>/apps/benchmark/benchmark.html` from a local HTTP server.
`--port N` changes the default port (8000), `--no-browser` disables
automatic browser opening, and `--no-build` reuses an existing artifact.
Command-line run flags become URL parameters (`?noUi=1&scenario=raw-bgfx-geometry&frames=300`);
the page also accepts `ui=1`, `vsync=1`, `smoke=1`, `rawSamples=1`,
`profile=diagnostic`, `warmup=N`, `seconds=N`, `repeats=N`, `readyTimeout=N`,
`rectCount=N`, `rectScale=N`, and `output=filename.json`. Explicit `ui=1`
retains the dashboard when scenario settings are supplied; otherwise CLI
run settings follow the native no-UI default.
The Debug build is **not** comparable to optimized performance results.

Web Stage 1 supports `raw-bgfx-empty`, `raw-bgfx-geometry`, and
`standalone-rmlui-simple`. Engine-owned scenarios are not exposed on Web
at this stage. The Emscripten host uses SDL3 and bgfx OpenGLES/WebGL2;
the ImGui dashboard is the real benchmark frontend, not a JavaScript
replacement. Its resources and preview resources are destroyed and GPU
deletion drained outside sampling, then reconstructed for the Results
tab. A browser callback advances at most one workload frame per
`requestAnimationFrame` to keep the event loop responsive, including
when the dashboard is closed and after an unattended run completes.
A latched browser visibility event invalidates a background-tab trial even
if rAF never fires while the page is hidden. The Web runner
records both callback-to-callback wall cadence and the CPU operation
duration; **rAF-paced cadence is not uncapped GPU throughput or
independently verified presented FPS**.

Reports are written to Web MEMFS and offered immediately as local
`.json` downloads after each run. The page retains the latest report
behind the **Download last JSON** button. Nothing is uploaded or
committed, and downloading/exporting is outside measured frames.
The existing native JSON schema and raw sample option are reused.

Browser correctness/visual smoke (no FPS thresholds):

```sh
node scripts/benchmark-web-smoke.mjs build/web-benchmark-release/apps/benchmark
# On Linux without an accelerated interactive X display, Firefox may need
# a software WebGL2 context in a graphical Xvfb session:
xvfb-run -a env NOVELTEA_BENCHMARK_FIREFOX_HEADFUL=1 \
  node scripts/benchmark-web-smoke.mjs build/web-benchmark-release/apps/benchmark
```

The smoke runs in Chromium and Firefox, compares untimed reference-preview
pixels to the empty reference, checks a no-ImGui geometry trial and browser
JSON download, verifies that hidden-tab sampling fails, confirms event-loop
progress, and exercises three dashboard teardown/recreate cycles crossing raw
bgfx and standalone RmlUi scenes. It verifies completion and sample counts, never
hardware FPS. A browser that does not expose WebGL2 fails the check
rather than being misrepresented as a performance result.

## Interactive Linux dashboard (#424)

Launch with no CLI arguments to open the standalone SDL3/bgfx Dear ImGui
dashboard, or use `--ui` with CLI run settings or a configuration containing
`"no_ui": false`. The dashboard has Scenarios, Run Settings, Results,
and Advanced tabs. Preview shows the selected reference content without contributing
to measurements; Clean and Diagnostic runs are separate actions. The scenario
selector includes `raw-bgfx-empty`, `raw-bgfx-geometry`,
`standalone-rmlui-simple`, `integrated-rmlui-controlled`,
`integrated-rmlui-production`, and `engine-empty`; other workloads are separate tickets.
The **Inspect full scene** control hides the large dashboard panel and leaves a small **Return to dashboard** button at the
top-right, so the fixed reference rectangles can be viewed unobscured.
Inspection is outside timed sampling.

Changing resolution or VSync applies at the next run. Before the runner
enters Preparation, the dashboard completely releases its ImGui context, SDL
input binding, GPU font atlas, sampler, and shader program, then drains
pending GPU deletion frames **outside** timing. Raw bgfx and standalone
RmlUi trials retain the SDL/bgfx host between repeats. Engine-owned scenarios
instead fully release the dashboard SDL/bgfx host, create and destroy a fresh
Engine-owned host for every trial, then recreate the dashboard's SDL/bgfx host
on completion. The application restores the dashboard after completion/failure,
automatically showing the Results tab.
No ImGui frames, HUD, counters or dashboard rendering occur during strict
Warmup or Measurement. Cleanup and results encoding happen afterward.

Results retain the **completed run's configuration** independently of
currently editable dashboard settings. They label the run as **Clean
(authoritative)** or **Diagnostic (non-authoritative)** and show the
completed scenario, rectangle count/scale when applicable, requested
resolution and VSync. Switching the editable profile or workload without
running again never relabels old results. Results also show individual
failures, CPU operation/wall-frame distributions, measured work-unit
cadence (not confirmed display FPS), and the JSON report path. Diagnostic
trials additionally display CPU stages, bgfx wait/render-thread statistics,
draw/view/resource snapshots, and **identified** GPU completed-frame timing
where supported. Missing observations are labeled unavailable; confirmed
presentation FPS and driver version remain unavailable. A bad run setting
is reported in the dashboard instead of silently corrected.

The lifecycle regression smoke exercises three dashboard
create/render/destroy → no-ImGui run → recreate cycles while retaining the
SDL/bgfx host, switching between raw bgfx and standalone RmlUi:

```sh
./build/linux-benchmark-debug/apps/benchmark/noveltea-benchmark-app \
    --dashboard-smoke --output build/linux-benchmark-debug/benchmarks/dashboard-smoke.json
```

This also runs as the `noveltea_benchmark_dashboard_lifecycle_smoke`
CTest under Xvfb for functional coverage. Use a verified real GPU for
hardware smoke. Shader resources are generated by the repository's ordinary
`noveltea-shaders` build target; no Engine devtools are linked into this app.

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
without clearing, geometry, UI, or Engine activity. The Clean profile does
**not** establish GPU-execution time or independently confirmed presented-frame
counts; Diagnostic may yield frame-ID-attributed GPU timestamps on supported
backends.

`--warmup-seconds` defaults to 3, `--seconds` to 10, `--repeats` to 1,
`--ready-timeout-seconds` to 5. `--frames` selects a fixed count
instead of a measurement duration. For each trial the runner executes
Preparation, explicit readiness polling, Warmup, Measurement, Completion,
Results, and Cleanup. It begins timing only after the scenario reports Ready.
All scenarios clean up even if preparation, readiness, a frame, or completion
fails, and independent suite scenarios continue after failure. A CPU-only
scenario may implement the same interface without initializing graphics.
The Linux app supports the raw bgfx, standalone RmlUi, empty Engine, and integrated NovelTea RmlUi scenarios, using the same runner in CLI and interactive modes.

CLI run-setting invocations still default to no-UI, with `--no-ui` explicit.
An unqualified invocation opens the dashboard. The `--profile diagnostic`
option selects a separate, non-authoritative Diagnostic run with additional
optional bgfx statistics. `--smoke` requests 30 measured frames without warmup. At most 20 trials and 300,000 measured
frames per trial are accepted. Duration runs also use a fixed 300,000-sample
capacity; exceeding it fails with an explicit error rather than allocating
during sampling or silently dropping samples. No logger or JSON encoder runs
inside the measurement loop.

## Diagnostic measurement (#429)

Select `--profile diagnostic` or the dashboard's Diagnostic profile. Diagnostic
runs remain **non-authoritative**, separate from minimal Clean runs. Sampling
retains the Clean wall and CPU operation boundaries and adds, when available:

- CPU RmlUi Update and Render submission stages, raw geometry/draw submission,
  and CPU time blocked in `bgfx::frame()`, **never** called GPU execution time.
- bgfx render-thread CPU duration, `waitRender`, `waitSubmit`, plus observed
  draw/compute/blit and texture/framebuffer/program counts. The dedicated
  raw/standalone host enables `BGFX_DEBUG_PROFILER` **only** for Diagnostic runs
  to collect the number of per-view profiler records where the backend supports
  view timing; it is not an unconditional rendered-view count. Unsupported or
  absent view records are `null`, not zero. Clean and dashboard frames keep
  profiler instrumentation off. Engine-owned scenarios retain their production
  debug settings and report unavailable view counts.
- Actual GPU timestamp durations only for unique `gpuFrameNum` values that
  match the benchmark's measured `bgfx::frame()` submission IDs.

`bgfx::getStats()` observes **asynchronous completed-frame snapshots**. Snapshot
draw/view/resource and wait distributions are **not paired** with CPU frame
samples by index and may repeat, lag or include nearby warmup work. The raw
bgfx and standalone hosts additionally advance three untimed frames during
Completion, collecting late GPU timestamps without inserting GPU fences in the
measured loop; only identified measured submissions count as GPU durations.
The Engine-hosted scenarios do not export submitted bgfx IDs and therefore
leave their GPU execution fields unavailable rather than guessing. A backend
that does not provide positive-frequency, valid GPU timestamp pairs also
reports GPU timing as unavailable.

JSON stores Diagnostic detail **per successful trial** at
`scenarios[].trials[].diagnostic`, including observation counts and explicit
scope strings; aggregate Clean wall/operation distributions remain unchanged.
The report's top-level timing fields are descriptions/availability markers,
not made-up global GPU measurements. Raw CPU samples remain optional.
An isolated 20,000-iteration **two-clock-read versus four-clock-read control**
runs after the suite in Diagnostic mode and records nanosecond costs under
`timing.instrumentation_control`; it characterizes lower-bound timer overhead,
not GPU-query cost or the full instrumentation penalty.

For a functional (non-performance) smoke test:

```sh
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-geometry \
  --profile diagnostic --frames 300 --output /tmp/diagnostic.json
```

Use the same workload separately under `--profile clean` for authoritative
comparisons. GPU timing/counter availability varies by backend. Never compare
Debug, Xvfb or software-rendered numbers as real-device performance.

## Standalone RmlUi reference (#426)

`--scenario standalone-rmlui-simple` uses the same Scenario lifecycle and
runner as raw geometry. It creates a benchmark-owned RmlUi Core context,
a standalone rmlui-bgfx RenderInterface (views 2–63), and a small document
with the fixed shared reference rectangles and a text label. The common
Liberation Sans font is staged next to the benchmark executable; the shader
provider loads the same generated system shaders used by the runtime.
The standalone adapter constructs neither Engine, RuntimeUI nor the Engine
asset manager; the combined executable does link Engine for integrated modes.

Preparation compiles shaders and rasterizes initial text before Ready.
Measured frames submit RmlUi Update, Render and bgfx frame handoff.
Clean runs collect no RmlUi stage timings. Diagnostic reports RmlUi Update
and Render submission independently of the CPU time spent in bgfx::frame().
ImGui and the RmlUi debugger are absent during measurement.

The dashboard orders all RmlUi preview views (2–63) before ImGui view 1,
including the final UI composition pass, then restores default view order
before measurement. An optional untimed X11/ImageMagick CTest verifies
that normal dashboard controls and the return-from-inspection button
remain visible above the preview. It also captures all three RmlUi variants
during warmup, compares one-line text pixels, and verifies their live render
settings in the output JSON.
The dashboard previews and inspects the reference outside measurement.
Its lifecycle smoke switches raw bgfx → standalone RmlUi → raw bgfx (or the
reverse), destroying RmlUi context, RmlUi Core, backend and GPU resources
between scenarios while keeping SDL/bgfx alive. Shader/font failure is a
preparation failure rather than a fabricated timing result.

```sh
./scripts/run-benchmark.sh --scenario standalone-rmlui-simple --smoke
./scripts/run-benchmark.sh --no-build --scenario standalone-rmlui-simple --dashboard-smoke
```

The native smoke checks successful GPU execution and backend transitions,
but do not inspect actual pixels. Visual equivalence should be inspected
interactively until the later screenshot/readback stage. Xvfb functional
tests are not authoritative GPU performance measurements.

## Empty NovelTea Engine baseline (#427)

`--scenario engine-empty` initializes the actual production Engine with its
Renderer, SDL window, Lua bootstrap, empty RuntimeUI host, asset services, and
regular frame/tick path. **It does not load a Compiled Project, gameplay session,
title screen, or authored RmlUi document.** Audio, devtools UI, FPS counters,
frame limiting and per-frame performance logging are disabled. The app uses
`EngineTooling::initialize` with ordinary Engine-owned renderer initialization
and a zero FPS cap; it does not bypass production frame orchestration or claim
to be an SDL/bgfx-only workload. Four Engine ticks outside sampling settle
initial work before Ready. Each repeated trial constructs a fresh Engine,
calls `Engine::tick()` once per measured work unit, and verifies renderer
shutdown before reusing bgfx.

Compare it against the independent `raw-bgfx-empty` baseline using identical
resolution, VSync, measurement duration/count, and build/hardware conditions:

```sh
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-empty --frames 300 --warmup-seconds 3 --output build/linux-benchmark-release/benchmarks/raw-empty.json
./scripts/run-benchmark.sh --no-build --scenario engine-empty --frames 300 --warmup-seconds 3 --output build/linux-benchmark-release/benchmarks/engine-empty.json
```

Compare `scenarios[0].aggregate.cpu_operation_ms` and
`scenarios[0].aggregate.frame_wall_ms` distributions and measured cadence,
rather than comparing one FPS number. The reports record
`graphics.frame_path` as `bgfx-frame` versus `engine-tick`, the actual bgfx
renderer/device and framebuffer dimensions, and—when present—the Engine's
effective UI/world raster metrics, RmlUi backend settings, and observed
postprocess-surface state. These are **different workloads and rendering
configurations**, not an apples-to-apples raw GPU draw comparison: the
standalone path only touches a bgfx view; the Engine processes its host
services, UI and renderer composition even with no gameplay. A difference in
CPU operation time can indicate framework/frame-path overhead, but includes
CPU-side waits and must never be called GPU execution time. No timing
threshold is imposed in CI.

`noveltea_benchmark_empty_engine_integration` runs real repeated Engine trials,
a missing-bootstrap initialization failure, and recovery in one process.
The empty-Engine graphics smoke checks repeated measured runs; the dashboard
lifecycle smoke switches Engine → standalone bgfx → Engine, verifying exclusive
graphics ownership. These are correctness tests under Xvfb, not performance
claims. Feature Lab is not applicable: no authorable gameplay is loaded.

## Integrated NovelTea RmlUi (#428)

Use either `--scenario integrated-rmlui-controlled` or
`--scenario integrated-rmlui-production`. Both initialize the **actual**
Engine/Renderer/RuntimeUI/RmlUiHost stack, load the same semantic UI reference
(rectangles, text, opaque background) as standalone RmlUi, then advance one
real `Engine::tick()` for each runner frame. The common markup generator
maps coordinates from the standalone 1280×720 reference into the Engine's
1920×1080 reference domain, preserving relative positions and sizes. Only
16:9 windows and the current Engine reference size are supported by this fixed
visual-equivalence fixture; others fail with a diagnostic.

Controlled mode requests the Engine's base-direct compatibility behavior
and disables raster snapping. Production mode retains the Engine default
compositor and raster snapping. **Neither mode is actually direct-base with
the current RmlUi backend: its effective reference MSAA request is two
samples, which requires an offscreen base layer.** Standalone likewise
uses two-sample MSAA and offscreen base presentation. These scenarios
share the same fixed markup and now explicitly set text display, no-wrap,
line height, width, font family and size, independent of production baseline
styles. The controlled and standalone cases are still not rendering-path
identical: Engine sets preserve-backbuffer while standalone leaves it off;
production also enables raster snapping. **Neither mode bypasses or substitutes the real Engine renderer.**
They are independent timing scenarios, not simultaneous contexts or samples
derived from RmlUi context-render completion counts.

The result `graphics` metadata reads settings from the **initialized**
standalone or Engine-owned RmlUi adapter: effective render-path selection,
reference MSAA samples, requested base-direct compatibility, preserve-backbuffer,
actual bound output target, viewport size and raster snapping. The report also
records Engine UI/world raster sizes and observed postprocess-surface status.
`ui_base_presentation_policy=offscreen-required-by-msaa` documents the
deterministic backend decision for MSAA-enabled base layers. The backend does
not expose an independently measured per-frame offscreen counter without
activating diagnostic performance logging, so
`ui_offscreen_rendering_observed` remains `null` rather than fabricating a
measurement. The integrated scenario always runs the
production Engine compositor. Its costs are **not identical** to a standalone
backbuffer UI render. The Engine-owned host does not expose its submitted bgfx
frame IDs at the scenario boundary, so GPU execution timing remains
unavailable there even when bgfx reports GPU timestamps. Independently
verified displayed frames also remain unavailable.

During each trial, the standalone dashboard releases all ImGui and bgfx
resources before the Engine initializes. Engine owns its SDL window and bgfx
device exclusively, and `Engine::shutdown()` destroys these before the
standalone dashboard recreates its own host. Every repeated trial receives
a fresh Engine. The integrated Engine system asset mount is staged from
production Lua/UI/fonts and generated shaders alongside the benchmark,
without requiring prior sandbox installation. No screenshot readback, ImGui,
on-screen counter, or debugger runs in measured frames. An explicit
read-only Engine tooling check requires the expected RuntimeUI document to
be live, so a degraded Engine UI initialization cannot yield false success. The dashboard cannot
provide an integrated live preview while it holds the standalone bgfx
context; actual Engine content is visible when running the benchmark.

```sh
./scripts/run-benchmark.sh --scenario integrated-rmlui-production --smoke
./scripts/run-benchmark.sh --scenario integrated-rmlui-controlled --smoke
./scripts/run-benchmark.sh --no-build --scenario integrated-rmlui-production --dashboard-smoke
```

Xvfb CTests exercise both UI modes, repeated Engine lifetimes, and an
integrated → raw bgfx → integrated lifecycle for functional correctness only. Performance measurements require
a verified accelerated GPU. The empty Engine baseline is available separately as `engine-empty` (#427);
#428 uses the same production initialization/tick path while loading an
RmlUi reference scene.

## Raw bgfx geometry and shared reference scenes (#425)

The new `raw-bgfx-geometry` scenario draws solid-color rectangular geometry
using bgfx directly, without initializing NovelTea Engine/Renderer or RmlUi.
A deliberately small renderer-neutral scene description in
`apps/benchmark/reference_scene.hpp` defines identified colored rectangles,
optional text descriptors, a 1×1 white texture with sampling options,
reference-space dimensions (1280×720), and a background clear color. The first
three rectangles are a stable fixed reference; additional deterministic tiles
and uniform rectangle scale support basic exploration. All GPU resources and
initial shader compilation are prepared before Ready; measured frames only
submit an indexed draw and advance bgfx. The scene definition is
benchmark-only, not a general production rendering abstraction. Text descriptors
are available for later RmlUi scenes, but this geometry workload draws no text.

Scene coordinates scale to actual host framebuffer pixels. Result JSON records
`graphics.width_pixels` and `height_pixels` together with
`render_width_pixels`, `render_height_pixels`, and
`internal_render_scale` (currently 1.0). These are effective framebuffer
dimensions, not requested logical window dimensions.

```sh
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-geometry \
    --rect-count 3 --rect-scale 1.0 --smoke
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-geometry \
    --rect-count 64 --rect-scale 0.5 --frames 300
```

The dashboard can preview the geometry without contaminating benchmark samples.
A real-GPU `--dashboard-smoke --scenario raw-bgfx-geometry` checks three
preview → teardown → run → restore cycles, alternating ordinary dashboard
and full-scene inspection frames. The `noveltea_benchmark_completed_run`
CTest protects the Results identity against subsequent setting edits.
The `noveltea_benchmark_reference_scene` CTest covers reference geometry and
parameter bounds; additional geometry GPU CTTests cover direct drawing and
dashboard resource lifetimes, not performance thresholds.

## Android standalone benchmark APK (#430)

The `android/benchmark` Gradle module packages `libnoveltea-benchmark-app.so`
with its own `org.noveltea.benchmark` application ID and launcher. It is
**not** the player, sandbox, game export template, or native JSON/Lua
microbenchmark. It shares SDL3, bgfx, the NDK and compiler/link policy with
the Android player without enabling NovelTea devtools. Release is optimized,
debug-key signed and explicitly debuggable so `adb run-as` can retrieve
reports from app-private storage without root access. Debug is opt-in.

With an Android device connected (or select an emulator interactively):

```sh
./scripts/run-benchmark-android.sh
./scripts/run-benchmark-android.sh --debug
./scripts/run-benchmark-android.sh -- --scenario raw-bgfx-geometry --smoke --no-ui
./scripts/run-benchmark-android.sh --no-build --pull
adb -s DEVICE logcat -s SDL:V | grep '\[benchmark\]'
```

The default launch opens the touch-scaled ImGui dashboard. Stage 1 Android
supports `raw-bgfx-empty` and `raw-bgfx-geometry`: both render directly
through a separate SDL3/bgfx OpenGLES host with the native fullscreen
framebuffer; their shader binaries are packaged as `essl-300` APK assets.
The dashboard releases ImGui, SDL input binding and associated bgfx objects
before strict warmup/sampling, then recreates them afterwards. On Android,
`raw-bgfx-empty` still swaps EGL buffers but intentionally submits no clear or
draw. Since Android need not preserve contents across swaps, a static opaque
Android Activity view covers previously presented dashboard pixels for this
**empty-only** run, installed on the UI thread before the strict runner starts.
No ImGui, bgfx clear, overlay updates, or JNI calls occur within measurement.
The dashboard submits a fresh complete frame before the Activity cover is
removed. The view is a display-only measure against stale swap-chain contents,
not a GPU timing instrument; use Clean CPU timings as specified and do not
interpret the black screen as evidence of GPU clear or rendering.
Backgrounding interrupts a measured trial instead of silently keeping stale
frames. On foreground or surface resize the dashboard recreates its SDL/bgfx host and
ImGui resources, rather than reusing an obsolete `ANativeWindow`. An ADB launch
while the phone is asleep can start SDL's native thread after Android has
already paused the Activity and invalidated its surface. Before SDL window
creation (and again before bgfx initialization), the benchmark now waits for
an interactive, focused Activity instead of initializing EGL against a
stale native window. The Android native-window reference is held until bgfx
shutdown to prevent concurrent surface destruction from freeing the pointer
mid-initialization. Device sleep does not run benchmarks in the background;
after wake/unlock the app may initialize its dashboard normally.
Standalone/integrated RmlUi and Engine-owned scenarios are **not**
advertised as supported by this Android Stage 1 slice.

Run summaries appear once per completed run in logcat (not once per frame).
Each run writes JSON under the benchmark app's `SDL_GetPrefPath`/results
directory. `--pull` retrieves every report by `run-as` and writes it
locally to `build/benchmark-android-results/DEVICE/`; it does not use
shared Android storage or add storage permissions. The build uses
`:app:compileNovelTeaShaderAssets` solely to produce the shared ESSL
shader outputs, not to build/install or export a player APK.

**Hardware verification gap:** An Android arm64 APK build and packaging
inspection do not establish real GPU rendering or lifecycle correctness.
On a physical device, verify the raw geometry is visibly rendered, a
30-frame strict no-UI run produces nonzero measurements and retrievable
JSON, the ImGui dashboard disappears completely during a Clean run and
returns afterwards, and repeated home/return or rotate/resume cycles
preserve surface recreation and work controls. Record actual device
and driver metadata before making performance claims; emulator timings
are not authoritative.

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
The raw and Engine-empty workloads have a fixed scenario version (1), no parameters,
and real-time wall-clock policy. The geometry workload also has scenario
version 1, with a strict `parameters` object containing `rect_count` (integer
1..256, default 3) and `rect_scale` (finite number 0.25..1.0, default 1.0).
Unknown scenario IDs and parameters are rejected.
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
Clean reports keep GPU execution and bgfx synchronization counters `null`.
Diagnostic trial objects expose separately labeled CPU stages and asynchronous
bgfx snapshots; absent fields remain `null`. Driver version and independently
confirmed displayed-frame counts remain `null`. None of these infer GPU time
from the duration of `bgfx::frame()`. Cleanup and any asynchronous completion work
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
