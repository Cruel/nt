# Feature Lab CPU performance diagnosis

## Status

Fixed: Runtime Session now caches prediction requirement discovery by semantic frontier,
while refreshing authoritative values on every publication. The reported symptom was a saturated CPU
core and ~14 FPS after starting the Lab menu in WSL2, despite accelerated `glxinfo`.
The local reproduction showed the visible menu at ~39–43 FPS at 1280×720. The exact
14 FPS report was not reproduced, but a substantial independent main-thread bottleneck
was confirmed in the same Project/runtime path.

## GPU identity

`OpenGL / SDL3` identifies APIs, not acceleration. `glxinfo` checks a different
context from the application and is insufficient by itself.

With process-local settings:

```sh
export LD_LIBRARY_PATH=/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}
export GALLIUM_DRIVER=d3d12
export MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA
```

A debugger finish breakpoint on `bgfx::gl::getGLString`, when its `_name` argument
was `GL_RENDERER` (`0x1f01`), captured the sandbox's actual string:

```text
D3D12 (NVIDIA GeForce RTX 5070 Ti)
```

Thus this reproduction was hardware accelerated. The EGL/X11 initialization still
printed a DRI3 warning; that warning alone did not establish software fallback.
The renderer's trace callback currently discards bgfx trace messages, and its
ordinary API-name log does not expose the hardware renderer string.

## Reproduction

Use the existing package exported by `scripts/run-labs.sh`. From the repository
root, with the settings above:

```sh
build/linux-debug/apps/sandbox/noveltea-sandbox \
  --project-assets build/run-labs \
  --compiled-project project:/feature-lab.ntpkg \
  --run-runtime --skip-title-screen --frames 120 --render-perf \
  --screenshot build/labs-gpu-diagnosis/baseline.ppm
```

Build was Debug with render-perf enabled. The screenshot verified the Lab catalog
menu was visible. Logged FPS samples ranged from 39 to 43, with median 42.

## Main-thread evidence

Four debugger interruptions of the running app landed in runtime Flow prediction.
The deeper stacks included:

```text
Engine::Impl::tick
GameHost::advance
RuntimeSession::dispatch
RuntimeSession::project_publication
build_prediction_context
FlowPredictor::predict
PredictionTraversal / ordinary Room topology / Scene and Dialogue traversal
find_slice (linear comparison of prediction points)
```

This identifies prediction-context requirement collection as a strong CPU hotspot,
not a shader-conversion or software-rasterization problem. Sparse stack samples do
not quantify individual inner-function costs or establish that linear lookup is
itself the dominant part. Broader traversal and repeated recomputation both require
profiling before selecting an optimization.

## Controlled ablation

Without changing source, a debugger breakpoint at
the pre-fix `engine/src/runtime/runtime_session.cpp:89` jumped to the existing early return at
line 90 (these line numbers describe the pre-fix source only). At that location `context` has already been copied from
`navigation_context`; later requirement-discovery locals have not been constructed.
This skipped `build_prediction_context`'s speculative requirement traversal while
leaving normal rendering and mandatory asset publication in place.

**Do not ship or adopt this bypass.** It omits prediction facts and can change
speculative plans; it is an attribution experiment, not a correctness-preserving fix.

An initial 180-frame ablation finished too quickly for the menu to appear, so it
was not used as the final comparison. A 1,500-frame run allowed asynchronous work
to settle and captured the same visible Lab menu. Across that run, logged FPS had
median **218**, versus **42** in the ordinary run. It still used the accelerated
NVIDIA context. This strongly supports expensive requirement prediction as a major
cause of reduced frame rate in the reproduction.

Local debugger scripts, logs, and screenshots are in
`build/labs-gpu-diagnosis/`. The build directory is not a durable artifact; this
record preserves the bounded findings. The diagnostic phase introduced no source
instrumentation or production bypass. The subsequent source fix is described below.
The existing user change to `scripts/run-labs.sh` was left untouched.

## Fix and verification

The implemented fix separates requirement discovery from authoritative fact evaluation.
`RuntimeSession` retains one discovery result keyed by the normalized discovery context
and active semantic roots. The Compiled Project is immutable and belongs to the session;
no cache is shared across projects or persisted. Root equivalence is owned by runtime
and reused by the asset gate. See [Flow Prediction Boundary](OVERVIEW.md#flow-prediction-boundary)
for the current cache contract.

A normal run with prediction enabled, **without debugger bypass**, captured the same
visible menu over 1,500 frames: median **249 FPS**, range **235–282**. A separate
900-frame debugger-count run recorded **905 context builds but only one requirement
discovery**. This verifies the expensive prepass is reused rather than disabled.
Artifacts: `fixed.log`, `fixed.ppm`, and `discovery-count.log` in the local diagnosis directory.

Regression coverage verifies Scene-frontier invalidation, fresh global and non-global
Condition values across clock ticks, fresh slot-bound Interaction facts, and semantic
root equality (including reveal microstate versus cue/wait changes). Full native runtime,
Lua/script, and asset test suites passed, along with the production asset boundary policy
tests. Linux sandbox and Web-debug player compilation, Linux/Web C++ policy, and the
repository-pinned format check passed. Full repository-wide CTest and browser playback
were not run; verification stayed focused on the changed portable runtime boundary.
Android/editor verification is not applicable: no platform/build or editor code changed.

Feature Lab is **already covered** by its ordinary catalog/menu reproduction; no authored
Project behavior changed. Prediction remains enabled, mandatory publication is unchanged,
and no diagnostic bypass or source instrumentation is present in the fixed application.
