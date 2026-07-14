# Migration Status

## Current State

The new NovelTea runtime is fully cut over to the typed runtime model for the repository target.
AuthoringProject V2 compiles deterministically to `noveltea.compiled.project` V1; native
`CompiledProject`, `CompiledRuntime`, `TypedRuntimeSession`, `SessionState`, typed saves,
typed messages, and `RuntimeScriptApi` are the only shipped gameplay path.

Phase 10C of the typed runtime/JSON-boundary plan is complete:

- provisional runtime-project TypeScript/native schemas and exporters are deleted;
- legacy project/document/model/entity/import/package APIs are deleted;
- the superseded controller/session/shell/generic-message graph is deleted;
- JSON-backed saves and controller snapshots are deleted;
- dispatcher-backed Lua compatibility bindings and the old script executor are deleted;
- editor native legacy import/edit/load commands are deleted;
- preview, playback, package/platform export, sandbox, player, Web, and Android source paths converge
  on the compiled artifact;
- the JSON allowlist and parser fuzz targets contain only current boundaries.

## Runtime and Editor Direction

Continue work on runtime/presentation capability, RmlUi components, ActiveText/map/text-log
presentation, preview/debugger/recorder UX, packaging/export, real project fixtures, and component
documentation. New behavior must enter through typed definitions/programs/state/messages and stable
IDs.

Do not restore old NovelTea formats or APIs. `refs/NovelTea/` remains read-only behavioral reference
only.

## Presentation Follow-up

Functional low-level presentation remains:

- `RuntimeUI`/RmlUi binding;
- ActiveText/layout/direct rendering;
- audio backends consuming typed operations;
- `TweenService`;
- bgfx/RmlUi rendering adapters.

`RuntimeLayoutManager` and `RuntimeTransitionManager` remain tested transitional scaffolding.
Their orchestration replacement belongs to
`docs/rendering/plans/PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md`. None of
the retained presentation code owns gameplay flow, session state, or saves.

## Verification Baseline

For typed runtime or package changes, run:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug --parallel "$(nproc)"
ctest --test-dir build/linux-debug --output-on-failure
cmake --build --preset linux-debug --target format-check cxx-policy --parallel "$(nproc)"

cmake --preset web-debug
cmake --build --preset web-debug --parallel "$(nproc)"
cmake --build --preset web-debug --target cxx-policy --parallel "$(nproc)"

cd editor
pnpm lint
pnpm typecheck
pnpm test
```

Run the Android debug build when the SDK is available and package/platform behavior changes.

## Next Work

Use the relevant area overview and active plan rather than class-parity migration:

1. presentation-coordinator/runtime-layout implementation;
2. remaining runtime UI component and direct-render capability;
3. preview/debugger/recorder and export polish;
4. representative real-project fixtures and component documentation;
5. later JSON boundary isolation work owned by Phase 11 of the typed runtime plan.
