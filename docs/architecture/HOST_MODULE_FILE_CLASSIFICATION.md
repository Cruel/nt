# Host Module File Classification

Date: 2026-07-18

Status: Phase 5A classification, Phase 5B target cutover, Phase 5E source organization, and Phase 5H
test ownership retargeting complete for
`docs/architecture/plans/HOST_AND_MODULE_BOUNDARY_IMPLEMENTATION_PLAN.md`.

## Purpose

This document records the semantic primary owner for every production C/C++ source and header in the
two broad pre-cutover implementation trees. The machine-readable source of truth is:

```text
cmake/NovelTeaModuleFileClassification.cmake
```

Phase 5A classified files only. Phase 5B created the six final libraries, resolved the mixed
dependency seams below, migrated consumers off the temporary broad targets, and deleted those broad
targets. Phase 5C completed link-visibility auditing, Phase 5D preserved miniz/bimg platform linkage,
and Phase 5E aligned runtime, presentation, and Lua implementation paths with their final owners.
Module policy, public-header probes, and fine-grained test ownership are complete. Asset/shader
staging remains ordered by Phase 5I.

## Classified universe

The inventory covers every `.h`, `.hpp`, `.c`, `.cc`, `.cpp`, and `.cxx` file under:

```text
engine/include
engine/src
```

This includes platform-conditional implementations such as both enabled and disabled developer-tool
variants, not merely the translation units selected by one configured build. Every one of the 289
current production files has exactly one primary target:

| Primary target | Files | Semantic authority |
| --- | ---: | --- |
| `noveltea_domain` | 43 | Backend-neutral IDs, definitions, state and Flow values, properties, diagnostics, shared presentation value contracts, geometry, and immutable material/shader definitions |
| `noveltea_content` | 41 | Loaded package/manifest/resource assembly, project/package/save/settings/rich-text/material codecs, compiled wire decoding, editor protocol, export/bootstrap, shader manifest, and shader compilation boundary logic |
| `noveltea_runtime` | 37 | Flow execution, runtime messages and ports, capabilities, commands, clocks, session restore/storage, checkpointing, `RuntimeSession`, `RuntimeExecutor`, and `RunningGame` |
| `noveltea_presentation` | 14 | Room resolution, presentation-operation target assembly, desired-presentation projection/publication, presentation coordination, and logical mounted-Layout/system-Layout management |
| `noveltea_script_lua` | 11 | Lua VM ownership, sol2 bindings, certification/invocation implementation, Lua value/result adaptation, and `RuntimeScriptApi` |
| `noveltea_engine` | 143 | Engine/GameHost/preview/devtools, SDL, bgfx, RmlUi, miniaudio, assets, text and ActiveText backends, tweening, concrete world realization, and runtime-facing backend adapters |

The relatively large engine classification is deliberate. It is the single concrete host/backend
target named by the plan, not a miscellaneous seventh library. Backend-neutral semantic owners are
classified inward; concrete platform, rendering, UI, audio, asset, preview, and host integration stay
together until a separately approved plan requires a narrower specialized target.

## Material and shader disposition

Material and shader files are classified by authority rather than their current path:

- `render/material.hpp`, `render/shader.hpp`, and `src/render/material.cpp` are domain-owned
  backend-neutral IDs, definitions, roles, uniforms, samplers, and material values;
- material JSON decoding, shader source compilation, compiled-variant manifest resolution, and their
  implementations are content-owned boundary behavior;
- bgfx shader loading, program caching, material binding, typed GPU asset loading, resources, and draw
  submission are engine-owned concrete realization.

This split does not make domain or runtime depend on bgfx, shaderc, JSON, or staged shader assets.

## Required cutover seams

Classification identified semantic ownership before the final targets compiled independently. Phase
5B resolved the mixed edges as follows:

- `presentation_operation_requests.*`, `runtime_presentation.*`, and `room_presentation.*` are
  presentation-owned assembly/resolver/projector implementations while domain `SessionState` and
  runtime execution consumed some records or helpers directly. Shared value/port contracts now live
  in domain-owned headers, while presentation implementation remains in `noveltea_presentation`.
- `running_game.cpp` is runtime-owned but currently performs certification through concrete
  `script::ScriptRuntime`. Certification now crosses a runtime-owned abstract contract implemented by
  `noveltea_script_lua`; runtime does not link Lua.
- session restore, checkpoint, and runtime-session implementation currently call content save codecs.
  A domain-owned codec port now separates runtime from the content-owned JSON save adapter.
- `script_runtime.cpp` currently obtains authored script bytes through concrete `AssetManager`.
  A runtime-owned script-source port now lets `noveltea_script_lua` obtain source without depending on
  engine; `AssetManager` provides the engine adapter.
- editor protocol code is content-owned but references runtime request/publication contracts. Its
  JSON framing and limits are now content-owned, while runtime request/publication adaptation is
  engine-owned.
- the running-game loader remains engine-owned because its current public contract composes concrete
  assets, content decoding, Lua certification, and runtime construction. Later cutover may split a
  content decoder from the host composition adapter, but it was not moved wholesale into runtime.

`LoadedCompiledPackage` and its assembly remain content-owned: they combine the separately decoded
project, package manifest, optional material project, archive inventory, and prepared resource
registries. Runtime owns the resulting value through `RunningGame`, but does not gain authority over
package validation or resource-registry construction.

No catch-all target or reversed dependency was introduced to conceal these edges. The six final
targets compile in dependency order, and the temporary broad targets were removed without aliases.

## Phase 5E source organization

Runtime implementation that had remained physically mixed into `engine/src/core` now lives under
`engine/src/runtime`: Flow execution, runtime clock, session restore, shared primitive evaluation, and
typed save-slot storage. Existing domain/shared contract headers remain under `noveltea/core`; the
plan explicitly does not require a mass rename of every `core` header, and the final runtime owner
classes were already under `noveltea::runtime`.

Presentation implementation headers and sources now live under `engine/include/noveltea/presentation`
and `engine/src/presentation`. Shared value contracts remain domain-owned under `noveltea::core`, while
logical Layout management moved from the root namespace to `noveltea::presentation`. All Lua adapter
implementation, including `RuntimeScriptApi`, now lives under `engine/src/script/lua` and remains in
`noveltea::script`.

All repository consumers use the final paths directly. Phase 5E introduced no forwarding headers,
legacy namespace aliases, duplicate source ownership, or temporary compatibility targets.

## Phase 5H test ownership

Lower-layer tests now mirror the production module graph instead of sharing one broad executable.
`noveltea_domain_tests`, `noveltea_content_tests`, `noveltea_runtime_tests`,
`noveltea_presentation_tests`, and `noveltea_script_lua_tests` link their owning module plus only the
lower NovelTea contracts and direct test dependencies required by their sources. None links
`noveltea_engine`. Content-owned material/shader/package tests run in the content suite, and logical
Layout-manager tests run in the presentation suite without RmlUi, SDL, or rendering backends.

Engine-owned host, asset, text, and tween tests remain separate owner-specific executables. Concrete
render/world tests are grouped under `noveltea_render_backend_tests`. Engine UI behavior that does
not directly call RmlUi API is grouped under `noveltea_ui_tests` without RmlUi include or direct
backend-link configuration; direct RmlUi and RuntimeUI native lifecycle coverage remains under
`noveltea_ui_backend_tests`. A shared RuntimeUI lifecycle fixture owns only project assets,
ScriptRuntime, and RuntimeUI, so native host coverage does not duplicate backend setup or absorb
GameHost/LayoutRealizer ownership. Capture/readback verifiers stay separate from both UI suites.
Private source include access is limited to suites that intentionally exercise their owner's
implementation internals: content for compiled-wire internals, script_lua for Lua runtime internals,
and engine/backend suites for private adapters. The content suite links standalone miniz because it
has no bimg provider; engine-linked integration suites do not add another miniz archive.

## Validation

Run the classification-only validator from the repository root:

```sh
cmake -DNOVELTEA_SOURCE_ROOT="$PWD" \
  -P cmake/ValidateNovelTeaModuleFileClassification.cmake
```

The validator rejects an altered target set, nonexistent or out-of-scope entries, duplicate primary
owners, and any production source/header omitted from the manifest. It is intentionally not the
Phase 5F `module-boundary-policy` target and does not enforce include or target dependency direction.
