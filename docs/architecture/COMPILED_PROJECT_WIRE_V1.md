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

This is a TypeScript-only contract in Phase 4A. It does not add C++ decoding or change preview,
playback, package, or CLI consumers; those remain on the transitional path until the later atomic
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

Phase 5B's native boundary is internal to `noveltea_core`. It consumes the minimal, comprehensive,
inheritance/property/localization, and resource documents into strict shared DTOs, reuses the native
strong-ID and closed primitive vocabulary, and returns `core::Diagnostics` for structural failures.
It intentionally does not retain or publish specialized program payloads; Phase 5C owns their typed
decoding, and Phase 5D owns semantic linking and the first public `CompiledProject` result.
