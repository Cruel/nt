# CompiledProject Wire V1

`editor/src/shared/project-schema/compiled-project.ts` is the sole executable contract for
`noveltea.compiled.project` version 1. Phase 5's native decoder consumes this contract and may add
defensive validation, but must not invent a second wire shape.

The document contains immutable gameplay definitions (Characters, Rooms, Interactables, Verbs,
Interactions, Scenes, Dialogues, and Maps), typed properties and variables, typed runtime resources
(assets, layouts, and scripts), localization, runtime settings, startup hook, and one Room/Scene/
Dialogue entrypoint. Cross-references, including references into separately versioned material data,
are typed discriminated references; generic collection/id
references, authoring collection maps, legacy Object/Action names, comments, categories, tags, and
editor state are not legal fields.

The wire contains closed `SceneProgram`, `DialogueProgram`, `InteractionProgram`, and Room hook
representations. Program and nested IDs remain stable. Definition arrays are compiler-sorted by ID;
the compiler preserves the authored order of all semantically ordered arrays inside a definition.

`serializeCompiledProjectWireV1` is the only Phase 4 serializer. It validates the strict wire shape,
serializes compact UTF-8 JSON without a BOM or insignificant whitespace, orders object keys by Unicode
code point recursively, normalizes negative zero to zero, rejects non-finite values through schema
validation, and never reorders arrays. Package manifests and shader/material metadata remain separate
versioned documents.

This is a TypeScript-owned contract. The native decoder consumes it defensively, and preview,
playback, package, and CLI consumers receive its canonical publication; no alternate runtime wire
cutover slice.

Phase 4C uses a separate `CompiledProjectSharedDraft` implementation type while specialized programs
are still incomplete. That draft contains all shared declarations, resources, definitions,
inheritance edges, and authored assignments, but omits program-owned fields entirely. It is never
accepted by `compiledProjectWireV1Schema`, serialized as gameplay JSON, or exposed to consumers.

## Cross-language decoder corpus

The exact Phase 5 decoder inputs live under
`editor/src/renderer/test/fixtures/compiled-project-golden/`:

- `minimal.json`;
- `comprehensive.json`;
- `inheritance-properties-localization.json`;
- `resources.json`;
- `scene-program.json`;
- `dialogue-program.json`;
- `interaction-program.json`.

They are generated only through `compileAuthoringProject` by running
`pnpm goldens:compiled-project` in `editor/`. Tests require byte-identical regeneration and verify that
the corpus collectively covers the closed Scene, Dialogue, Interaction, text, condition, effect,
flow-target, resource-source, location, matching, variable, property, and persistence vocabulary.

`decode_compiled_project` is the Phase 5D public native gameplay boundary. It consumes all seven
canonical documents through strict internal DTOs, reuses the native strong-ID and closed primitive
vocabulary, and returns `core::Diagnostics` for structural or semantic failures. Scene instructions,
Dialogue blocks/segments/edges, Interaction rules/instructions/contexts/operands, Verb default
programs, and Room hooks decode losslessly with owner-scoped nested IDs. A separate linker validates
all gameplay references, declarations, inheritance, nested targets, resource closure, and topology,
then publishes one immutable indexed `CompiledProject` only after every check passes. Source JSON is
never retained. Material references remain typed IDs until the separately versioned material manifest
is validated and assembled with the compiled package.

`noveltea_fuzz_compiled_project_decoder` is the dedicated Phase 5F decoder fuzz target. Its
non-libFuzzer smoke run feeds malformed JSON and all seven canonical documents through the same
nonthrowing parser and `decode_compiled_project` boundary under the Linux sanitizer preset. A
failed parse is passed to the decoder as its discarded JSON value, so the same Result/diagnostic path
is exercised without an assertion or exception.
