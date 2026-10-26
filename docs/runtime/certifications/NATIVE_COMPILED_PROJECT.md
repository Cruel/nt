# Native Compiled Project certification (#557)

## Ownership and boundary

The native C++ compiler entrypoint is
`tools/editor_tool/native_compiled_project.cpp::compile_native_compiled_project`.
It consumes **one already-admitted, normalized Project value**. Its shared,
Room/Scene, and Dialogue/Interaction lowerers all use the same native Message
projection; the compiler assembles the current `noveltea.compiled.project`
schema v1, full resources and locale catalogs, the Flow Prediction Index, and
the compiler-owned Save Contract. It checks resource closure (Materials are
resolved by the separate shader manifest) and submits the complete value to
the actual engine Compiled Project decoder. An error produces **no** compiled
value.

The native flow prediction implementation is
`tools/editor_tool/native_flow_prediction.cpp`. Its slice/dependency graph
is derived from the compiled definitions, not from TypeScript data or an
existing runtime cache. Save Contract hashing is owned by
`native_compiled_project_save_contract.cpp`. The authoritative reference
remains `editor/src/shared/flow-prediction-index-compiler.ts` and
`editor/src/shared/authoring-compiler-lowering.ts` until coordinated
replacement; reference compilation is used **only** by differential tests.

This issue does **not** publish a Prepared Runtime Artifact or export a
package. Those are #558–#560; independent end-to-end cold acceptance is #561.
The production ScriptC CLI remains in service until #551. The compiler's
unshipped C++ candidate and certification binary have no runtime dependency
on ScriptC/Node or a TypeScript-produced cache.

## Cold certification

From the repository root:

```sh
cmake --build --preset linux-debug --target noveltea-runtime-cache-publish-certify
build/linux-debug/tools/editor_tool/noveltea-runtime-cache-publish-certify \
  tests/projects/feature-lab --emit-native-compiled > /tmp/noveltea-native-compiled.json
python3 tests/native_compiled_project_parity.py \
  build/linux-debug/tools/editor_tool/noveltea-runtime-cache-publish-certify .
```

`--emit-native-compiled` invokes **native Project admission** from disk,
compiles using only that admitted generation, and re-admits source before
returning. It checks the source generation, all source revisions, and the
normalized Project have not changed; any mismatch rejects output. It writes
the complete compiled wire to stdout inside a JSON result and does not
create a runtime cache or modify the Project. For a genuinely cold check,
run it on a copy without `.noveltea/cache/runtime`; the differential suite
creates precisely such isolated Project copies itself.

`tests/native_compiled_project_parity.py` also supplies the admitted Project
directly to the C++ compiler for full recursive JSON semantic comparison,
including every ordered field, all Message IDs, locale metadata, prediction
slices/edges/dependencies/hints, and the persistent Save Contract. It tests
invalid authored input separately and checks direct engine decoder and
Flow-execution witnesses. The Node reference compiler runs in the **test
process only**, never in the C++ production/compiler process.

Feature Lab is already covered by this source/compilation parity suite:
there are no new authored player interactions or UI visuals in #557. Runtime
package load, UI/playback, and cross-host coverage remain separate parent
acceptance gates; do not infer those from this compiler test.
