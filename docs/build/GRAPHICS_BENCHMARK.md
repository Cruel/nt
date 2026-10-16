# Graphics Benchmark (Linux, Android, and Web, #422–#439)

The dedicated `noveltea-benchmark-app` measures SDL3/bgfx, an empty Engine,
and RmlUi reference workloads. Raw and standalone RmlUi **do not instantiate**
the NovelTea Engine, while `engine-empty`, the Compiled Project workloads,
and the integrated RmlUi modes use the real Engine and production Renderer. The binary links the Engine library
for Engine-owned scenarios; standalone scenarios remain separately owned.
Interactive use adds a dedicated Dear ImGui frontend that is fully destroyed before
sampling. The no-UI path initializes no ImGui resources.
The original `noveltea-benchmark` JSON/Lua microbenchmark and release-report
collector are unaffected. The portable runner and JSON contracts cover Linux,
Android, and Web with distinct platform launchers and additional scenario hosts.

## Automatic capacity search (#439)

The benchmark can perform a **bounded search** for the largest tested workload
under a specified target. Search candidates use ordinary isolated scenario
trials: each candidate has its own preparation, warmup, repeated timed trials,
and cleanup. The search doubles geometry/UI counts until it finds a failing
candidate (or reaches the workload cap), then bisects the passing/failing
interval; pixel search visits 25%, 50%, 75%, then 100% of the actual host
framebuffer dimensions. The program never extrapolates beyond those bounds.

Select a supported scenario, then configure the search in the dashboard's
Run Settings tab, or pass four flags:

- `--capacity-dimension geometry|ui|pixels`: geometry scales raw indexed
  rectangles (1–256) or draw-call submissions (1–1024); UI scales RmlUi
  elements (1–2048) in standalone or integrated scaling scenarios; pixels
  scales the offscreen target of `raw-bgfx-offscreen` or offscreen
  `raw-bgfx-composition`.
- `--capacity-target cpu-ms|gpu-ms|presented-fps`: CPU and GPU budgets are
  milliseconds **p95**, conservatively taking the worst completed trial at each
  workload. FPS compares **observed host frame-loop cadence** against a minimum
  frequency. It is paced by requestAnimationFrame on Web and potentially by the
  compositor on Android; it is *not verified on-screen presentation FPS*.
  The GPU target requires `--profile diagnostic` and at least two matched
  completed GPU frame observations per trial; absent timestamps terminate as
  **inconclusive**, not as CPU-inferred GPU time.
- `--capacity-threshold N`: maximum milliseconds for CPU/GPU or minimum
  host-callback Hz for the FPS target, in (0, 1000].
- `--capacity-mode presented|offscreen`: the default measures the normal
  application frame path. `offscreen` is a separate experimental mode for
  `raw-bgfx-offscreen`, CPU/GPU budgets only, with VSync disabled. Each
  iteration submits exactly four actual raw bgfx draw units into a render
  target and advances bgfx once. The report distinguishes **work units** from
  the single **host frame callback**; it records estimated units/CPU second
  and amortized per-unit p95. It does not imply uncapped GPU frames, direct
  GPU throughput, or observed display presentation.

For short functional probes, not hardware comparisons:

```sh
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-draw-calls \
  --capacity-dimension geometry --capacity-target cpu-ms \
  --capacity-threshold 16.67 --frames 120 --warmup-seconds 0.25 \
  --repeats 2 --no-ui
./scripts/run-benchmark.sh --no-build --scenario integrated-rmlui-scaling \
  --capacity-dimension ui --capacity-target presented-fps \
  --capacity-threshold 60 --frames 120 --repeats 2 --no-ui
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-offscreen \
  --capacity-dimension pixels --capacity-mode offscreen \
  --capacity-target gpu-ms --profile diagnostic \
  --capacity-threshold 16.67 --frames 120 --repeats 2 --no-ui
```

The normal `--width`/`--height` controls determine the host window size on
Linux/Web. Use `--native-resolution` or the dashboard checkbox to request the
current display mode's pixel dimensions instead, including Engine-owned
scenarios. Integrated RmlUi reference scenarios explicitly reject non-16:9
native modes rather than falling back to the configured size. Android always
uses the actual fullscreen physical framebuffer. The report records the actual
SDL window framebuffer size after setup, which can differ from the request.
The search's 100% baseline is the **actual framebuffer size after host setup**,
rather than a hard-coded 1280×720 assumption. The JSON report contains
per-candidate `scenarios[].graphics.width_pixels/height_pixels` (host) and
`render_width_pixels/render_height_pixels` (offscreen), alongside requested
`target_scale`, exact `capacity_search.probes`, status, and highest tested
passing workload if known. With multiple candidates there is no single
top-level graphics owner and `graphics` can be null; use each candidate's
graphics. `bounded-maximum` means the configured maximum passed, **not**
the GPU's actual capacity. Failed/incomplete candidates remain
`inconclusive`; interrupted runs retain the runner's cancellation behavior.

These experiments are **not** added to the six-scenario Quick Suite. Do not
compare a Web rAF-limited result with Android presentation timing as if they
were unpaced GPU benchmarks; use the same dimensions, scenario, profile,
timing budget, and render path for paired comparisons. CPU and GPU diagnostic
sources retain the instrumentation limitations described below.

## Production Compiled Project workloads (#438)

Three additional, opt-in Engine workloads compare application frames with real
Compiled Project and Runtime Session ownership. They share the same Engine
initialization, production renderer, frame loop, and teardown as `engine-empty`;
no benchmark-only game simulation or alternate Runtime Session is introduced.
The existing six-scenario Quick Suite remains unchanged.

- `engine-compiled-empty` loads the deterministic, minimal compiled-project
  golden fixture (one empty entry Room, no gameplay graphics) and enters its
  real Runtime Session without displaying the title screen.
- `engine-compiled-menu` loads that same project but displays NovelTea's
  production default, static title-menu document instead of entering gameplay.
- `engine-feature-lab` loads an **optional** exported Feature Lab runtime
  `.ntpkg`, enters the actual authored Feature Lab Runtime Session, and
  displays its game UI. An absent/unreadable package is a preparation **failure**
  with zero measurements, not a substituted minimal project.

The two built-in Compiled Project presets are checked in at
`apps/benchmark/stage2-compiled-empty.json` (fixed-step) and
`apps/benchmark/stage2-compiled-menu.json` (real-time). Each specifies a
1280×720 Clean run, 0.5 s warmup, two 60-frame trials, and raw CPU samples:

```sh
./scripts/run-benchmark.sh -- --config apps/benchmark/stage2-compiled-empty.json
./scripts/run-benchmark.sh -- --config apps/benchmark/stage2-compiled-menu.json
```

Alternatively select the scenario in the dashboard or by `--scenario` and
choose `--clock-policy fixed-step|realtime` (default: `realtime`). Fixed-step
submits 1/60 s to the **production** Engine simulation each tick for repeatable
isolated update patterns; it does *not* disable normal bgfx presentation or
make wall-clock frame timing deterministic. Real-time ticks advance from the
platform clock. `configuration.clock_policy` records the actual selection;
non-Compiled-Project references reject fixed-step to prevent misleading
comparisons. CPU timing and framebuffer presentation are measured normally
under either clock policy. Creation, project staging, asset loads, Engine
initialization, initial four settling ticks, and cleanup are outside timed
measurements. Each trial creates and destroys a fresh Engine/Runtime Session.

Feature Lab is opt-in. Export it from the normal CLI **before** running; no
Feature Lab files are required to build or run the other benchmarks:

```sh
build/cli/linux/noveltea --project tests/projects/feature-lab package export \
  --output build/linux-debug/benchmarks/feature-lab.ntpkg \
  --include-unused-assets --allow-localization-warnings
./scripts/run-benchmark.sh -- --scenario engine-feature-lab \
  --feature-lab-package build/linux-debug/benchmarks/feature-lab.ntpkg \
  --smoke --profile clean
```

The packaged project is loaded through Engine's normal `project:/` source and
contains its own compiled runtime/assets. The benchmark copies it into its
private fixture directory during preparation. The path is included in the
canonical `configuration.parameters.package_path`, making accidental use of
a different exported package visible; record and preserve the actual `.ntpkg`
artifact for comparisons. On Android, stage a readable local path in app-private
storage before passing `--feature-lab-package`; on Web, the file must already
be available inside Emscripten's virtual filesystem (a host filesystem path
or URL is not automatically mounted). The built-in projects are packaged in
the benchmark's own native/Web/Android assets and need no external staging.

For cross-host comparisons keep the compiled content revision, clock policy,
width, VSync, frame count, warmup, build profile, and runtime package constant.
These are full Engine workloads, **not** CPU-only Runtime Session microbenchmarks;
RmlUi/bgfx costs and ordinary host presentation remain included. The
`noveltea_benchmark_engine_compiled-*_graphics_smoke` CTests exercise repeated
real startup/tick/shutdown, and the Engine integration test checks the missing
Feature Lab package failure; successful opt-in Feature Lab reproduction is
verified by explicitly exporting and running its `.ntpkg`.

## RmlUi element, text, and context scaling (#436)

Two opt-in scenarios extend the original fixed RmlUi baseline without changing
its Quick Suite or the production Engine/player/sandbox contracts:
`standalone-rmlui-scaling` creates a benchmark-owned RmlUi renderer and
contexts; `integrated-rmlui-scaling` uses the actual Engine, RuntimeUI,
RmlUiHost, bgfx, and SDL lifecycle. The shared, deterministic fixture contains
colored rectangles and real, font-rendered text, sized to the same physical
viewport (1280×720 reference units standalone; 1920×1080 Engine layout units
scaled by 1.5). Each **visible** scaling context shows an identical fixture.
**Empty** contexts still run Update but own no loaded document (the integrated
host exercises its ordinary unload lifecycle); **hidden** contexts have a
loaded but hidden document. The Engine may also own other internal contexts,
which are not counted as fixture contexts.

The fixed, reproducible reference for both new IDs is **512 rectangles, 64
text lines, one visible context, zero empty/hidden contexts, static text, and
continuous redraw**. The named `--ui-preset` selections are `balanced`
(the default), `elements-heavy` (2048 rectangles), `text-heavy` (all 256 lines
changed every frame), `contexts-heavy` (4 visible + 8 empty + 8 hidden
contexts), and `dirty-static` (cached layout, static text). The dashboard
exposes the same preset selector. The last named preset is applied first;
explicit element/text/context/redraw flags override its individual values
regardless of argument order, including through the Web URL transport.
Independently change `--ui-elements` (1–2048),
`--ui-text-lines` (0–256), `--ui-dynamic-lines` (0–256, no more than total
lines in dynamic mode), `--ui-visible-contexts` (1–8),
`--ui-empty-contexts` and `--ui-hidden-contexts` (0–16 each; 24 total at most),
`--ui-text-mode static|dynamic`, and `--ui-redraw continuous|dirty-only`.
The dashboard exposes the same independent controls and a Restore RmlUi
reference action. The Web launcher forwards the matching flags as URL
parameters; canonical JSON `--config` works on all three targets. The strict JSON `configuration.parameters` object records
all eight settings (scaling scenario version 2); version 1 presets are read
with the prior single-changing-line behavior. Arbitrary runs are reproducible and not mistaken
for fixed reference comparisons. Out-of-bounds counts and incompatible flags
are rejected rather than silently clamped by the runner.

For an equivalent pair of measured application-frame workloads:

```sh
./scripts/run-benchmark.sh --no-build --scenario standalone-rmlui-scaling \
  --ui-elements 1024 --ui-text-lines 128 --ui-visible-contexts 2 \
  --ui-empty-contexts 3 --ui-hidden-contexts 3 --ui-text-mode dynamic \
  --ui-redraw continuous --frames 300 --profile diagnostic
./scripts/run-benchmark.sh --no-build --scenario integrated-rmlui-scaling \
  --ui-elements 1024 --ui-text-lines 128 --ui-visible-contexts 2 \
  --ui-empty-contexts 3 --ui-hidden-contexts 3 --ui-text-mode dynamic \
  --ui-redraw continuous --frames 300 --profile diagnostic
```

Static text never changes. Dynamic mode replaces the first `--ui-dynamic-lines`
real text nodes in every visible document on each submitted frame with
fixed-width, per-line deterministic changing content. The default changes one
line (retaining the original experiment), while the text-heavy preset changes
all 256. Changing 0 lines is allowed. Both adapters perform equivalent mutations. In **continuous** mode the first rectangle's equivalent
CSS width spelling alternates each frame to force actual layout invalidation
without changing its pixels. In **dirty-only** mode the application leaves
static layout unmodified; dynamic text still invalidates its content. Both
modes render and present the **complete frame every tick**, preserving visible
output on backbuffers that do not retain previous contents. In particular,
"dirty-only" does **not** skip the whole SDL/bgfx/Engine frame, and it must
not be read as zero GPU rendering work. Changing redraw mode changes layout
recomputation, not the scene's pixel coverage.

Clean runs accumulate only their existing application-frame/CPU operation
metrics. In Diagnostic mode, `cpu_update_ms` measures the combined RmlUi
contexts' Update stage and `cpu_submission_ms` measures the RmlUi Render
stage. The integrated implementation measures these stages inside the
**production** host, with conditional clocks disabled in Clean mode. These
are per-application-frame aggregate UI stages, not per-context FPS; they
exclude other Engine stages and do not approximate GPU execution. For
fairness, compare reports at the same device, physical dimensions, VSync,
profile, content parameters and renderer path; the Engine case includes
production composition and is not a pure RmlUi microbenchmark. CLI previews,
cleanup, and font/resource generation stay outside measurement, with a new
Engine and fresh contexts for every trial.

The `noveltea_benchmark_reference_scene`, `noveltea_benchmark_options`, and
`noveltea_benchmark_report` tests check fixture determinism, bounds, and JSON
contract. The scaling Xvfb smoke tests run both real hosts with multiple
visible/empty/hidden contexts and Diagnostic stage timing. This validates
Linux functional rendering under a software/virtual display, **not hardware
performance**. Android and Web renderer, font and context-loss visual behavior
require their own target-specific certification.

## Unattended Stage 1 certification (#433)

The same byte-for-byte canonical configuration is checked in at
`apps/benchmark/stage1-unattended.json`. It selects a Clean, fixed-geometry
reference, a bounded warmup, two measured 60-frame trials, raw CPU samples,
and **no ImGui**. To reproduce it:

```sh
./scripts/run-benchmark.sh --no-build --config apps/benchmark/stage1-unattended.json
./scripts/run-benchmark-web.sh --no-build --config apps/benchmark/stage1-unattended.json
./scripts/run-benchmark-android.sh --device DEVICE --no-build -- --config apps/benchmark/stage1-unattended.json
./scripts/run-benchmark-android.sh --device DEVICE --no-build --pull
```

Linux reads `--config` directly. The Web launcher transports exact JSON
bytes as a Base64 URL value; the shell stages them into Emscripten's virtual
filesystem **before** the native configuration decoder runs. The Android
launcher passes the same bytes in a bounded Activity intent extra; the
Activity writes them into app-private storage **before SDL_main** and
passes `--config` to the native binary. Both transports permit up to 8192
bytes, reject conflicting run flags, and never parse, normalize, or silently
replace invalid configuration. The Web URL contains the encoded settings,
so these benchmark configurations should not contain secrets.

Reports remain local: Linux writes beneath the benchmark build directory,
Android uses app-private results retrievable with `--pull`, and Web offers
the downloaded report through the page. An optional `--output` override is
supported by Linux and Web; the Android launcher keeps the private default.
Validate any resulting report without requiring or comparing GPU FPS:

```sh
node scripts/benchmark-stage1-validate.mjs \
  --config apps/benchmark/stage1-unattended.json \
  --report path/to/retrieved-report.json --platform Linux
```

Use `--platform Android` for the physical Android report or
`--platform Emscripten` for Web. The validator checks the canonical run
identity, renderer/framebuffer metadata, exact successful trial counts and
raw-sample counts, available CPU metrics, and null GPU/presentation metrics
for Clean mode. It checks correctness, **not minimum performance**.
Linux CTest exercises the canonical launch and report validation under Xvfb;
the Chromium/Firefox smoke executes the same JSON through the browser's
actual WebGL2 renderer. Launcher unit tests cover exact transport and
malformed/mixed flag handling. CI runs launcher transport tests without
hardware thresholds. Optimized hardware smoke on WSLg's D3D12-backed
NVIDIA GeForce RTX 5070 Ti also completed the 120-frame canonical run
and all six Quick Suite reference cases (30 frames each). Functional
certification does not assert or benchmark a minimum throughput.
Native GPU performance remains hardware-specific; an emulator or software
WebGL/Xvfb result is not a hardware baseline.

## Expanded raw bgfx reference workloads (#434)

In addition to the empty and fixed three-rectangle geometry baselines, the
standalone application exposes five raw bgfx workloads on Linux, Android, and
Web. All use real bgfx submission and actual SDL framebuffer dimensions; their
reference settings are deterministic, and no Engine or RmlUi resources are
created by these scenarios:

- `raw-bgfx-clear`: clear the backbuffer then present, with no geometry.
- `raw-bgfx-single-quad`: one indexed quad using a 1×1 reference texture.
- `raw-bgfx-textured`: one textured quad; default 256×256 RGBA8 source,
  full reference-scene coverage.
- `raw-bgfx-offscreen`: the same textured quad into an RGBA8 framebuffer
  matching the *actual* host pixel dimensions, then a second fullscreen
  composite pass to the backbuffer (two bgfx views, two draw submissions).
  This remains a **presented-frame** benchmark, not offscreen capacity mode.
- `raw-bgfx-draw-calls`: 64 separate indexed draw submissions by default.
  Each draw contains one quad. The texture and drawn region are shared;
  repeated calls intentionally produce overdraw, not 64 unique textures.

For the textured and offscreen cases, `--texture-size` (power of two,
1–2048 pixels) and `--coverage` (linear fraction, 0.125–1) independently
control texture allocation and quad coverage. `raw-bgfx-draw-calls` also
accepts `--draw-calls` (1–1024) and `--quad-count` (1–512 quads per draw)
to separate CPU draw submission pressure from indexed geometry volume.
The quads partition the **same full covered rectangle** for every quad count,
including incomplete final grid rows (e.g. 3 versus 4 quads); geometry count
therefore does not implicitly change covered pixel area.
The same controls are available in the dashboard; the fixed clear/single-quad
references reject incompatible parameters. The stable default parameter
set is 64 draws, 1 quad/draw, 256 texture pixels, coverage 1.0, even for
scenarios that do not use all four knobs.

For example:

```sh
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-offscreen --smoke
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-draw-calls \
  --draw-calls 7 --quad-count 9 --texture-size 64 --coverage 0.375 --smoke
```

Each scenario's result carries actual `graphics.width_pixels` and
`height_pixels`, effective render dimensions, and `graphics.raw_workload`
with the scenario identity, configured resource footprint, views, draw
submissions, vertices, and triangles **per frame**. These counters describe
the operations submitted by the workload, not GPU profiler readings,
confirmed presentation counts, or exact driver memory residency. Preparation
uploads buffers and compiles shaders outside timing; the inspection preview
is visualized outside measurement, and all workload resources are released
between trials. The Stage 1 Quick Suite intentionally retains its original
six-item comparison order; run these extra workloads individually.

## Controlled framebuffer composition (#435)

`raw-bgfx-composition` is a benchmark-owned reference scene, available through
Linux, Android, and Web raw-bgfx hosts. The **direct** path clears the
backbuffer, draws the textured world quad, and optionally blends a translucent
patterned overlay over the world. The **offscreen** path draws the *same* world
into an RGBA8 render target, executes 1–4 actual fullscreen textured composite
draws (with ping-pong intermediate targets as needed), and blends the *same*
overlay onto the backbuffer *after* the final composite. Each stage has a
separate ordered bgfx view. This preserves the background and alpha-blending
semantics of the direct path; the overlay never replaces or discards world
content. The controlled workload uses the existing benchmark-only shader and
has no Engine or RmlUi side effects.

Example controlled, like-content runs:

```sh
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-composition \
  --texture-size 256 --coverage 0.75 --frames 300
./scripts/run-benchmark.sh --no-build --scenario raw-bgfx-composition \
  --composition-path offscreen --composite-passes 1 \
  --texture-size 256 --coverage 0.75 --frames 300
```

`--composition-path` is `direct` (the default) or `offscreen`; direct requires
`--composite-passes 0`, `--target-scale 1.0`, and `--msaa-samples 0`.
Offscreen requires 1–4 composites and permits target scales 0.25–1.0 and
MSAA 0, 2, or 4 samples on the first target. `--no-transparent-overlay`
removes the transparent blend draw from **both** paths; it is not an implicit
optimization of just one path. `--coverage` controls the world quad’s
linear screen-space extent (approximate covered pixel fraction is its
square); source-texture size is independent. Target scale changes the
*actual allocated* intermediate dimensions, not the host window or
backbuffer size; composite draws still cover the final full screen.
Multi-pass composition maintains independent ping-pong targets and never
samples from its active write target. Unsupported MSAA framebuffer **formats**
fail preparation. The bgfx API cannot portably confirm the exact effective
sample count: a driver can clamp a supported format to fewer samples. The
JSON therefore separates `requested_msaa_samples` from
`effective_msaa_samples` (null for MSAA requests), sets
`msaa_sample_count_verified` to false, and marks the extra-MSAA byte estimate
as based on **requested** samples, not observed allocation. Do not treat a
successful MSAA run as proof that the requested sample count was used.
MSAA on the direct backbuffer is intentionally **unsupported** in this
comparison: it would require a different host reset/swapchain setup.

The report records host dimensions separately from effective render-target
dimensions, composite draw/view count, transparent overlay presence, MSAA
sample count, target count, RGBA8 resolved-color bytes, and an *estimate* of
additional MSAA storage. These numbers describe intended resources, not
measured VRAM residency, GPU execution time, or actual transferred bandwidth.
`semantically_equivalent_to_direct` is true for unscaled, non-MSAA offscreen
runs and direct runs using otherwise identical scene settings. Downscaled
or multisampled targets change rasterization, and the report explicitly marks
them **not** like-content comparisons. Comparing multi-pass vs single-pass
at native resolution still compares the same output scene, though the
intermediate passes entail different GPU work. Do not use CPU `bgfx::frame()`
wait as an estimate of GPU cost or treat the different pipelines as proof of
a NovelTea Engine bottleneck.

NovelTea production-path comparisons remain the separate
`integrated-rmlui-controlled` and `integrated-rmlui-production` scenarios:
those use actual Engine ticks, RmlUi MSAA/base-layer routing and Engine
compositing, not the raw checkerboard reference scene. Their real backend
configuration, raster snapping and postprocess metadata are reported
separately. They are **not** semantically identical to raw bgfx composition
samples, and this ticket does not change the production renderer to emulate
the benchmark. For any A/B run, also confirm renderer, device, VSync,
resolution, scene parameters and profile in the reports.

`noveltea_benchmark_composition_direct_smoke` and
`noveltea_benchmark_composition_offscreen_smoke` exercise repeated real bgfx
resource creation, render and cleanup under Xvfb. The optional
`noveltea_benchmark_composition_visual_smoke` captures the *presented X11
window during warmup*, outside measurements, and compares direct versus
two-pass offscreen output at equal dimensions while separately checking that
transparent overlays visibly change world pixels. It is a functional visual
regression, **not** a GPU performance measurement or proof of cross-driver
pixel identity. Check visual output and capability support on actual Android
and Web hardware before treating those platforms as visually certified.

## Advanced RmlUi effects (#437)

`standalone-rmlui-effects` and `integrated-rmlui-effects` exercise the
**same deterministic RML/CSS fixture** through the standalone bgfx renderer
and the production Engine/RuntimeUI renderer, respectively. They each have
six independently adjustable counts: clipping, 2D rotation transforms,
linear-gradient decorators, drop-shadow filters, radial-gradient mask images,
and nested blur/opacity layers. Every dimension has its own visible column,
so changing one dimension does not replace another with a cheaper effect.
The integrated renderer applies the normal reference-to-raster scale; the
strict frame-sampling lifecycle is unchanged. Both scenarios alternate equivalent
CSS width spellings on the shared background element each frame, preserving
all pixels while invalidating cached UI layout so the measured workload
continuously submits advanced effects instead of timing an idle retained layer.

```sh
./scripts/run-benchmark.sh --no-build --no-ui --scenario standalone-rmlui-effects \
  --ui-clipping 2 --ui-transforms 2 --ui-gradients 2 \
  --ui-filters 2 --ui-masks 2 --ui-nested-layers 2 --frames 300
./scripts/run-benchmark.sh --no-build --no-ui --scenario integrated-rmlui-effects \
  --ui-clipping 2 --ui-transforms 2 --ui-gradients 2 \
  --ui-filters 2 --ui-masks 2 --ui-nested-layers 2 --frames 300
```

Each count is 0–16; at least one must be nonzero. The default is 2 per
dimension. Combinations also obey a conservative, cross-renderer pass-range
safety budget (units: clipping + transforms + 2×gradients + 5×filters +
7×masks + 7×nested layers, maximum 54). An invalid or over-budget request
is rejected, **not** silently reduced to a smaller workload. This guard
protects the standalone renderer's smaller view range; it is a conservative
estimate, not a claim to predict each backend pass. Select smaller counts
when a platform or renderer cannot execute the requested workload.

The canonical JSON configuration preserves the six counts as exact
`parameters` for A/B comparisons. The report field
`graphics.ui_effect_backend_callbacks` contains actual, preparation-time
renderer callback activity: clipping operations, transform submissions,
linear-gradient draws, **drop-shadow-specific** filter composites, mask
saves, layer pushes and maximum nesting. This probe is **disabled before
timed frames**; the strict timing samples do not include callback bookkeeping.
Requested effects that generate no corresponding callbacks cause a failed
trial with an explicit unsupported-feature reason. Adapter-reported errors
are captured separately. These callback counts show that RmlUi reached
the backend; they are **not** measurements of GPU time or conclusive proof
that every submitted draw succeeded, and an upstream renderer may emit
internal pass-scheduler errors directly to stderr without routing through
its diagnostic callback. The pass budget avoids the reproducible overload
of the default renderer view ranges, but backends should still be visually
inspected on target hardware.

Both scenarios work through the normal CLI, native dashboard, Android host
and Web host. The Web launcher accepts the same six count flags. Tests
`noveltea_benchmark_standalone_rmlui_effects_smoke` and
`noveltea_benchmark_integrated_rmlui_effects_smoke` run repeated native
frame collections to exercise resource creation and teardown. Both CTest
checks are serialized against other GPU benchmarks to keep resource contention
from spuriously suppressing the advanced-effect submissions. Like all
extra Stage 2 workloads, they are run separately, not in the fixed
six-scenario Stage 1 Quick Suite.

## Scenario switching and Quick Suite (#432)

**Quick Suite** runs `raw-bgfx-empty`, `raw-bgfx-geometry` (the fixed
three-rectangle reference), `standalone-rmlui-simple`, `engine-empty`,
`integrated-rmlui-controlled`, and `integrated-rmlui-production` in that
order. Select **Quick Suite** in the dashboard, or launch without ImGui:

```sh
./scripts/run-benchmark.sh --no-build --quick-suite --smoke
./scripts/run-benchmark.sh --debug --dashboard-smoke --quick-suite
./scripts/run-benchmark-web.sh --no-build --quick-suite --smoke
```

The suite freezes the selected run settings, using a shared canonical
reference-preset normalizer for geometry, draw, texture, and **all composition**
parameters, regardless of the previously selected scenario. This prevents an
offscreen composition preview from invalidating the fixed Quick Suite cases.
It releases preview and ImGui GPU
resources once before the first trial and does not re-create the dashboard
between scenarios. The raw bgfx and standalone RmlUi cases retain the shared
SDL window/bgfx host but release each scenario's resources between runs.
On Android, recoverable interruptions of shared-host Quick Suite trials
wait for foreground restoration and rebuild SDL/bgfx before fresh warmup,
with bounded retries; failed recovery blocks subsequent ownership changes.
Engine-owned Android trials additionally detect Activity backgrounding and
reject skipped production Engine ticks as valid benchmark samples. A physical
Pixel 6a foreground/background/resume test of `engine-empty` completed a
15-second trial with `interruption_retries: 1`, confirming fresh preparation
and measurement after the interrupted attempt. Equivalent interruption testing
of both integrated RmlUi modes remains a separate verification gap. On Linux and Android, the benchmark destroys the shared host
before an Engine-owned scenario initializes its own SDL window/bgfx device.
Web performs the same transfer between rAF callbacks, without unregistering
the browser main loop. All three platforms restore the benchmark host before
returning to dashboard rendering. A cleanup failure blocks unsafe subsequent
ownership transfers. A failed preparation or unsupported scenario records
its own failed trial and does not discard successful independent cases.

A mixed-host JSON report contains the ordered `scenarios[]` with per-scenario
`graphics` metadata, measured trials, and failures. Top-level `graphics`
is `null` when different hosts were used; no single renderer or framebuffer
describes the collection. The outcome is `complete` only if every case
completed, otherwise `partial` when some measurements succeeded, or
`failed` when none succeeded. Linux, Android, Chromium and Firefox execute
all six Stage 1 references with real, mutually exclusive renderer hosts.
Web executes them on successive animation callbacks without blocking the
browser event loop. Android keeps its Activity and native window lifecycle
while Engine scenarios independently initialize and shut down their own
bgfx device. If a host transition fails, that scenario records a failure
rather than fabricated CPU/GPU samples.

`noveltea_benchmark_suite` tests ordering, cleanup-before-next-preparation
and independent failures. The two Linux Quick Suite GPU smoke tests run the
collection unattended and through three dashboard teardown/recreate cycles,
respectively. Web browser smoke verifies all six scenario measurements,
Engine-to-raw transitions, no-UI individual Engine runs, browser context-loss
recovery, and canonical configuration normalization; these are correctness
tests without performance thresholds.

## Standalone Web benchmark (#431)

Run the optimized WebGL2 benchmark using Emscripten's SDK environment:

```sh
./scripts/run-benchmark-web.sh
./scripts/run-benchmark-web.sh --debug
./scripts/run-benchmark-web.sh --no-build --no-ui --scenario raw-bgfx-geometry --frames 300
./scripts/run-benchmark-web.sh --no-build --ui --scenario raw-bgfx-geometry
./scripts/run-benchmark-web.sh --no-build --dashboard-smoke --smoke
./scripts/run-benchmark-web.sh --no-build --quick-suite --smoke
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

Web Stage 1 supports the full six-scenario reference suite, including
`engine-empty`, `integrated-rmlui-controlled`, and
`integrated-rmlui-production`. The Web package stages production Engine
system assets alongside the independent dashboard assets. The Emscripten
host uses SDL3 and bgfx OpenGLES/WebGL2;
the ImGui dashboard is the real benchmark frontend, not a JavaScript
replacement. Its resources and preview resources are destroyed and GPU
deletion drained outside sampling, then reconstructed for the Results
tab. A browser callback advances at most one workload frame per
`requestAnimationFrame` to keep the event loop responsive, including
when the dashboard is closed and after an unattended run completes.
A latched browser visibility event invalidates a background-tab trial even
if rAF never fires while the page is hidden. A canvas `webglcontextlost`
event similarly invalidates the active attempt: rendering and sampling stop
until `webglcontextrestored`, when SDL/bgfx and their GPU resources are
recreated outside the timed interval. Incomplete attempts are discarded and
retried after fresh preparation and warmup (up to three retries per trial).
Previously completed repeats remain in the report; `interruption_retries`
records the retries on each logical trial. A persistent interruption or failed
recovery produces an explicit incomplete result. Escape cancels an active
collection instead of starting the remaining repeats. Cancellation during
WebGL context loss exports its terminal JSON immediately without waiting for
restoration; GPU cleanup and dashboard recreation remain deferred until WebGL
returns. The Web runner records both callback-to-callback wall cadence and the CPU operation
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
bgfx and standalone RmlUi scenes, plus all Engine-owned scenarios and their
exclusive renderer ownership transitions. It also interrupts an active
Engine-owned trial with WebGL context loss, then checks fresh-warmup recovery.
It verifies completion and sample counts, never hardware FPS. A browser that does not expose WebGL2 fails the check
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
adb -s DEVICE logcat -s 'SDL/APP:V' | grep '\[benchmark\]'
```

The default launch opens the touch-scaled ImGui dashboard. Stage 1 Android
supports all six Quick Suite scenarios: raw bgfx, standalone RmlUi, empty
production Engine, and both integrated production RmlUi reference paths.
The APK stages its own independent shader/font assets and the real Engine's
system assets. The standalone RmlUi font is loaded from APK bytes rather
than a filesystem path. Raw scenarios render through the SDL3/bgfx
OpenGLES host with the native fullscreen framebuffer.
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
Backgrounding or a significant surface resize invalidates the in-progress
trial; the runner discards its partial samples, waits for Activity foreground,
recreates the SDL/bgfx graphics host, and retries the trial after fresh warmup
(up to three retries). Completed repeats remain valid and a retry count is
recorded in JSON. Android Back or a close request cancels the collection rather
than retrying. On foreground or surface resize the dashboard recreates its SDL/bgfx host and
ImGui resources, rather than reusing an obsolete `ANativeWindow`. An ADB launch
while the phone is asleep can start SDL's native thread after Android has
already paused the Activity and invalidated its surface. Before SDL window
creation (and again before bgfx initialization), the benchmark now waits for
an interactive, focused Activity instead of initializing EGL against a
stale native window. The Android native-window reference is held until bgfx
shutdown to prevent concurrent surface destruction from freeing the pointer
mid-initialization. Device sleep does not run benchmarks in the background;
after wake/unlock the app may initialize its dashboard normally.
The benchmark Activity also exposes the production Engine's foreground
readiness contract so ownership transitions cannot initialize EGL on an
unfocused Activity. Engine-owned trials check foreground state around each
tick and discard an interrupted attempt rather than counting suspended ticks;
recovery waits for foreground restoration and begins a new warmup. On
non-16:9 Android displays, the production Engine applies its normal
letterboxed presentation: compare actual reported viewport and UI raster
settings before treating standalone and integrated frame times as visually
equivalent.

Run summaries appear once per completed run in logcat (not once per frame).
Each run writes JSON under the benchmark app's `SDL_GetPrefPath`/results
directory. `--pull` retrieves every report by `run-as` and writes it
locally to `build/benchmark-android-results/DEVICE/`; it does not use
shared Android storage or add storage permissions. The build uses
`:app:compileNovelTeaShaderAssets` solely to produce the shared ESSL
shader outputs, not to build/install or export a player APK.

**Physical-device certification (#433):** The Pixel 6a (Android arm64,
OpenGL ES 3.0) completed repeated optimized unattended runs from the shared
canonical JSON: two successful 60-frame trials (120 samples) per run, raw
CPU samples, and a retrievable app-private JSON report validated by the
same Stage 1 report checker as Linux/Web. The Pixel 6a also completed a
six-of-six 30-frame Quick Suite, including the two integrated Engine modes.
The app waited correctly when initially launched onto a sleeping device,
then initialized after
Activity focus returned. An additional 5,000-frame physical run interrupted
by Home and resumed the Activity, completed 5,000 valid frames with one
recorded interruption retry. This verifies actual GPU-host execution,
report retrieval, and that specific lifecycle transition, **not**
screenshot-level visual equivalence or a general performance baseline.
Independently verify geometry pixels, ImGui disappearance/return, and
rotate/resume recovery before claiming those manual presentation checks.
Debug/emulator timings are not authoritative.

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
    "quick_suite": false,
    "raw_samples": false,
    "vsync": false,
    "output": ""
  }
}
```

The `--config` file is validated before graphics init and cannot be mixed
with run-setting flags; `--output` can override the file's destination on
Linux and Web. The `quick_suite` field selects sequential reference scenarios
when enabled, with fixed reference geometry and separately recorded outcomes.
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
