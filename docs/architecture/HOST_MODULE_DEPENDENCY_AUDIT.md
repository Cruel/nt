# Final Host and Module Dependency Audit

Date: 2026-07-18

Status: Final Phase 6F/6H conformance record for
`docs/architecture/plans/HOST_AND_MODULE_BOUNDARY_IMPLEMENTATION_PLAN.md`.

## Scope

This audit records the post-cutover production target graph, third-party visibility, public-header
closure, application/tool/test links, platform differences, policy exceptions, forbidden-edge
searches, and final source-size review. The pre-cutover evidence remains in
[`HOST_MODULE_DEPENDENCY_INVENTORY.md`](HOST_MODULE_DEPENDENCY_INVENTORY.md); this document is the
current architecture record.

The exact configured reports are generated from CMake target properties:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug --target module-dependency-inventory
cmake --preset web-debug
cmake --build --preset web-debug --target module-dependency-inventory
```

They are written to `build/<preset>/reports/module-dependency-inventory.txt`.

## Final production graph

| Target | Public NovelTea edges | Private compile/link ownership | Public contract |
| --- | --- | --- | --- |
| `noveltea_domain` | none | no third-party runtime dependency | Immutable model, strong IDs, state/value contracts, Flow and presentation contracts |
| `noveltea_content` | `noveltea_domain` | nlohmann-json and miniz headers | Package/model/bootstrap/shader contracts; named JSON codec/adapter headers remain explicit boundary APIs |
| `noveltea_runtime` | `noveltea_domain`, `noveltea_content` | none | Running-game/session execution, commands, ports, checkpoint and save-slot services |
| `noveltea_presentation` | `noveltea_domain`, `noveltea_runtime` | none | Presentation projection, coordinator operations, mounted-Layout policy and system-layout services |
| `noveltea_script_lua` | `noveltea_domain`, `noveltea_runtime` | Lua and sol2 | Lua implementation of runtime script ports and the typed `RuntimeScriptApi` adapter |
| `noveltea_engine` | `noveltea_domain`, `noveltea_content`, `noveltea_runtime`, `noveltea_presentation` | SDL, bgfx/bimg/bx, RmlUi/RmlUi Lua/rmlui-bgfx, miniaudio, text libraries, Twink, ImGui when enabled, nlohmann-json, miniz headers, Lua/sol2 and `noveltea_script_lua` | Application lifecycle facade plus engine/tooling contracts |

All backend, JSON, Lua, and adapter dependencies owned privately by a static library appear in
CMake's configured `INTERFACE_LINK_LIBRARIES` as `$<LINK_ONLY:...>` where final-link closure requires
them. They do not propagate include directories, compile definitions, or backend types into lower
module or application-facing compile surfaces.

The enforced include/link direction is exactly:

```text
presentation -> runtime -> content -> domain
script_lua   -> runtime ------------> domain
engine       -> presentation, runtime, content, domain
engine       -private-> script_lua and concrete backends
```

`runtime` depends on `content` only for approved typed save/package boundary services. Presentation
does not depend on content, script, or host backends. Script depends inward on runtime/domain and
does not own runtime execution.

## Public-header closure

`public-header-probes` compiles:

- every classified domain header without external backends;
- the dependency-clean content consumer surface without nlohmann-json leakage;
- every runtime header with fake ports and no Lua or host backend;
- every presentation header without host backends;
- every script header while Lua/sol2 remain private implementation requirements; and
- a consumer that includes only `noveltea/engine.hpp` and its required facade headers.

Named JSON codec/adapter declarations are intentional external-boundary APIs under
[`JSON_BOUNDARY_POLICY.md`](JSON_BOUNDARY_POLICY.md). Their callers explicitly declare JSON when they
use those source-facing boundaries; JSON is not propagated through `noveltea_content`. The probe also
fails configuration if the deleted public `noveltea/ui_runtime.hpp` reappears.

## Applications, tools, and tests

| Consumer | Direct links and rationale |
| --- | --- |
| `noveltea-player` | `noveltea_engine`, SDL; final application owns runtime-asset staging |
| `noveltea-sandbox` | `noveltea_engine`, SDL, bgfx, JSON; deliberate demo/readback/tooling consumer with private engine test seams |
| `noveltea-editor-tool` | `noveltea_engine`, JSON; uses the final engine/runtime protocol entry path |
| `noveltea-benchmark` | `noveltea_script_lua`, `noveltea_content`, JSON; measures only the Lua/content boundaries it exercises |
| Domain/content/runtime/presentation/script tests | Link their owning modules plus only the adjacent typed dependencies and explicit boundary libraries used by fixtures |
| Host/text/assets/tween tests | Link `noveltea_engine`; private-source access is limited to the owning engine subsystem under test |
| Render backend tests | Link `noveltea_engine` and bgfx; own generated-shader staging only |
| UI tests | Non-backend tests link only `noveltea_engine`; backend integration tests alone link RmlUi/rmlui-bgfx directly |
| Readback verifiers | Standalone image verifiers link Catch2 only; capture is performed by the sandbox |

The content test binary intentionally links standalone `miniz::miniz` because it has no bimg
provider. Engine/player/shared links use bimg's single `mz_*` provider and must not add the standalone
archive.

## Platform differences

- Linux uses NovelTea's target vcpkg triplet and ordinary host tools. Configured backend libraries
  are private or link-only under `noveltea_engine`.
- Web builds the dependency stack from source, substitutes Web bgfx/bimg/bx target names, defines
  `NOVELTEA_PLATFORM_WEB`, and keeps the same six-module direction and public-header closure.
- Android builds final applications as shared libraries, defines `NOVELTEA_PLATFORM_ANDROID`, and
  adds `EGL`, `GLESv2`, `android`, `log`, and `OpenSLES` privately to `noveltea_engine`. Gradle owns
  runtime-asset/shader staging.
- Desktop defines `NOVELTEA_PLATFORM_DESKTOP`; optional ImGui remains an engine-private debug
  dependency. Disabling devtools replaces it with the stub without changing the public graph.

## Policy and forbidden-edge result

There are no approved entries in the C++ runtime, JSON-boundary, or module-boundary allowlists.
The repository checker rejects stale, duplicate, wildcard, hidden dynamic, and undocumented module
exceptions.

The final manual audit found:

- no SDL, bgfx/bimg/bx, RmlUi, ImGui, miniaudio, Twink, text-backend, Lua/sol2, or nlohmann includes
  in runtime or presentation source/public-header trees;
- no obsolete `engine` or `noveltea_core` target declaration or consumer edge;
- no production use of the retired `script::CompiledRuntime`, `script::TypedRuntimeSession`, or
  `script::TypedExecutionKernel` names;
- no RuntimeUI runtime-session binding, transaction control, presentation acceptance/brokerage, or
  generic native RmlUi pointer API;
- no Engine-owned realized-Layout map, old preview friendship, raw preview JSON/RML/Lua production
  entrypoint, or demo update/render branch; and
- no stale module-policy exception.

`RuntimeSession::settle_transaction()` and `RuntimeSession::accept_presentation()` remain the
intentional runtime authority. The prohibited condition was those operations being exposed or
duplicated by RuntimeUI.

## Final source-size review

The implementation baseline is commit `dbfea6f58648e6845e2f79f3bdfede5ffa075a9d`, immediately before
the host/module-boundary implementation began. Counts include production `.c/.h/.cpp/.hpp` files
under `engine/src`, `engine/include`, and `apps`, excluding generated trees.

| Tree | Baseline lines/files | Final lines/files | Change |
| --- | ---: | ---: | ---: |
| `engine/src` | 54,686 / 132 | 59,927 / 173 | +5,241 lines, +41 files |
| `engine/include` | 11,777 / 110 | 11,700 / 116 | -77 lines, +6 files |
| `apps` | 224 / 2 | 1,569 / 6 | +1,345 lines, +4 files |
| Total | 66,687 lines | 73,196 lines | +6,509 lines (+9.8%) |

The increase is reasonable for the completed extraction: formerly implicit host behavior now has
typed contracts, focused owners, policy/probe infrastructure, and app-owned sandbox/demo behavior.
The public include surface did not grow in aggregate. The two original concentration points shrank:

- `engine/src/engine.cpp`: 2,691 to 1,755 lines (-936, -34.8%);
- `engine/src/ui_runtime_rmlui.cpp`: 2,511 lines, deleted and replaced by the grouped
  `engine/src/ui/rmlui/` backend files; the remaining `runtime_ui.cpp` facade is 1,077 lines.

Remaining files above roughly 1,000 lines were reviewed by responsibility, not split mechanically:

| File | Lines | Cohesive reason to retain |
| --- | ---: | --- |
| `engine/src/engine.cpp` | 1,755 | Private application composition, load/init/shutdown and frame sequencing; runtime dispatch, Layout realization, input, preview, debug, screenshot, and backend details already have owners |
| `engine/src/core/session_state.cpp` | 1,615 | Single authoritative domain-state mutation/invariant implementation |
| `engine/src/script/lua/bind_runtime_capabilities.cpp` | 1,561 | One Lua-backend capability registration adapter; it owns no runtime semantics |
| `engine/src/runtime/runtime_session.cpp` | 1,477 | Sole transaction, dispatch, publication, command-drain and settlement authority |
| `engine/src/runtime/runtime_executor.cpp` | 1,257 | Typed runtime feature execution with family-specific implementations already split where useful |
| `engine/src/text/text_engine.cpp` | 1,249 | One backend-specific shaping/rasterization owner |
| Codec/validation files | 1,003-1,206 | Boundary-local schema decoding/validation, already split by package/project/scene/save families |
| `engine/src/ui/rmlui/runtime_ui.cpp` | 1,077 | Private RmlUi facade and shell glue; host lifecycle, contexts, documents, binding, input, ActiveText, playback and renderer integration are separate files |

Runtime and presentation implementation now resides under `engine/src/runtime/` and
`engine/src/presentation/` and is classified into the matching targets. Concrete adapters are grouped
under `audio/miniaudio`, `platform/sdl`, `render/bgfx`, `script/lua`, and `ui/rmlui`. No additional
split is justified by line count alone.

## Validation result

The final Phase 6 validation passed on 2026-07-18:

- Linux Debug configured and built completely; all 544 CTest cases passed serially under Xvfb,
  including RmlUi/presentation/world GPU readbacks and staged player/sandbox package smoke.
- Linux formatting, C++ runtime/dependency, JSON-boundary, module-boundary, public-header, and
  configured dependency-inventory targets passed.
- Web Debug player and sandbox built; Web C++/JSON/module policies, public-header probes, configured
  dependency inventory, and the browser RmlUi/compiled-world smoke passed.
- Editor lint and TypeScript checking passed; Vitest passed 139 files and 733 tests with two files
  and five tests intentionally skipped. Existing React `act(...)` warnings remain non-failing test
  noise.
- Android arm64-v8a Debug APK assembly, runtime-asset staging, shader staging, and native build
  passed. Runtime device smoke was unavailable because `adb` is not installed in this environment.
- The devtools-disabled ASan/LeakSanitizer/UBSan build passed 71 host, 55 backend-free UI, and 22
  RmlUi backend test cases with strict halt-on-error settings.
- Final documentation stale-name checks, exact deletion searches, lower-module forbidden-include
  searches, and `git diff --check` passed.
