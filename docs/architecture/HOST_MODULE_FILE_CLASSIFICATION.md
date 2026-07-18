# Host Module File Classification

Date: 2026-07-18

Status: Phase 5A complete for
`docs/architecture/plans/HOST_AND_MODULE_BOUNDARY_IMPLEMENTATION_PLAN.md`.

## Purpose

This document records the semantic primary owner for every production C/C++ source and header in the
two broad pre-cutover implementation trees. The machine-readable source of truth is:

```text
cmake/NovelTeaModuleFileClassification.cmake
```

Phase 5A classifies files only. It does not create the six final libraries, move sources, change
namespaces, alter link visibility, enforce module include policy, retarget tests, or change asset and
shader staging. Those actions remain ordered by Phase 5B and later.

## Classified universe

The inventory covers every `.h`, `.hpp`, `.c`, `.cc`, `.cpp`, and `.cxx` file under:

```text
engine/include
engine/src
```

This includes platform-conditional implementations such as both enabled and disabled developer-tool
variants, not merely the translation units selected by one configured build. Every one of the 277
current production files has exactly one primary target:

| Primary target | Files | Semantic authority |
| --- | ---: | --- |
| `noveltea_domain` | 39 | Backend-neutral IDs, definitions, state and Flow values, properties, diagnostics, shared presentation value contracts, geometry, and immutable material/shader definitions |
| `noveltea_content` | 41 | Loaded package/manifest/resource assembly, project/package/save/settings/rich-text/material codecs, compiled wire decoding, editor protocol, export/bootstrap, shader manifest, and shader compilation boundary logic |
| `noveltea_runtime` | 37 | Flow execution, runtime messages and ports, capabilities, commands, clocks, session restore/storage, checkpointing, `RuntimeSession`, `RuntimeExecutor`, and `RunningGame` |
| `noveltea_presentation` | 12 | Room resolution, presentation-operation target assembly, desired-presentation projection/publication, presentation coordination, and logical mounted-Layout/system-Layout management |
| `noveltea_script_lua` | 11 | Lua VM ownership, sol2 bindings, certification/invocation implementation, Lua value/result adaptation, and `RuntimeScriptApi` |
| `noveltea_engine` | 137 | Engine/GameHost/preview/devtools, SDL, bgfx, RmlUi, miniaudio, assets, text and ActiveText backends, tweening, concrete world realization, and runtime-facing backend adapters |

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

Classification identifies semantic ownership but does not pretend the current broad targets already
compile independently. Before Phase 5B can create and enforce the final graph, these current mixed
edges require explicit cutovers:

- `presentation_operation_requests.*`, `runtime_presentation.*`, and `room_presentation.*` are
  presentation-owned assembly/resolver/projector implementations while domain `SessionState` and
  runtime execution currently consume some of their records or helpers directly. Shared value/port
  contracts must move inward without moving presentation implementation into domain or runtime.
- `running_game.cpp` is runtime-owned but currently performs certification through concrete
  `script::ScriptRuntime`. Certification must cross an abstract runtime-owned contract implemented by
  `noveltea_script_lua`, rather than making runtime link Lua.
- session restore, checkpoint, and runtime-session implementation currently call content save codecs.
  Codec adaptation must move to an approved content/storage boundary before runtime target
  enforcement.
- `script_runtime.cpp` currently obtains authored script bytes through concrete `AssetManager`.
  `noveltea_script_lua` needs a backend-neutral script-source port so it does not depend on engine.
- editor protocol code is content-owned but references runtime request/publication contracts. Its
  dependency must remain limited to approved typed contracts or be split into protocol DTO and
  runtime adaptation pieces.
- the running-game loader remains engine-owned because its current public contract composes concrete
  assets, content decoding, Lua certification, and runtime construction. Later cutover may split a
  content decoder from the host composition adapter, but it must not be moved wholesale into runtime.

`LoadedCompiledPackage` and its assembly remain content-owned: they combine the separately decoded
project, package manifest, optional material project, archive inventory, and prepared resource
registries. Runtime owns the resulting value through `RunningGame`, but does not gain authority over
package validation or resource-registry construction.

These are Phase 5B prerequisites, not incomplete Phase 5A work. No catch-all target or reversed
dependency was introduced to conceal them.

## Validation

Run the classification-only validator from the repository root:

```sh
cmake -DNOVELTEA_SOURCE_ROOT="$PWD" \
  -P cmake/ValidateNovelTeaModuleFileClassification.cmake
```

The validator rejects an altered target set, nonexistent or out-of-scope entries, duplicate primary
owners, and any production source/header omitted from the manifest. It is intentionally not the
Phase 5F `module-boundary-policy` target and does not enforce include or target dependency direction.
