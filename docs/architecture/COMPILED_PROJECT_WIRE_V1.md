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
