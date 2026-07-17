# Project Root

## Contract

The project root owns identity, runtime settings, feature flags, localization, startup hook,
entrypoint, collection indexes, and editor metadata. It is not an entity, property owner, or generic
mutation target.

Authoring uses strict `noveltea.authoring.project` version 2. The editor owns, reads, writes, and
validates it; native runtime code never parses it. Compilation emits strict canonical
`noveltea.compiled.project` version 1.

## Collections

V2 has collection-specific records for assets, variables, shaders, materials, layouts, characters,
rooms, interactables, verbs, interactions, dialogues, scenes, maps, script modules, and tests.
Stable record IDs are unique within a collection and nested IDs within their owner.

Property-bearing definitions may use same-collection `extends` and declared typed property
assignments. Categories, tags, record colors/order, notes, graph positions, selections, preview
state, and workbench state remain editor-only.

## Startup and Settings

Entrypoint is a strict Room, Scene, or Dialogue reference. Startup Lua is a separate synchronous
non-yielding hook and must succeed before the entrypoint starts. Typed settings include display/text,
system Layout roles, title behavior, default font, application icon, localization, and runtime
defaults. Presentation settings include the validated project-default Room navigation transition;
an explicit navigation request and then the selected exit override take precedence over it.

## Compilation

`compileAuthoringProject` is the sole semantic compiler. It validates schemas, inheritance,
properties, references, programs, resources, settings, and startup; lowers specialized
Room/Scene/Dialogue/Interaction content; removes tooling metadata; and emits deterministic canonical
gameplay bytes.

`publishCompiledArtifact` is the shared publication service used by preview, playback, package
export, and platform/CLI export. `buildCompiledRuntimeExport` only assembles file entries,
shader/material metadata, and package options around those exact bytes.

## Native Runtime

The native decoder validates and links untrusted compiled gameplay into immutable
`CompiledProject`. The running-game loader combines it with final package manifests/resources,
certifies Lua, and constructs one `runtime::RunningGame` containing one `runtime::RuntimeSession`.

Mutable values live only in typed `SessionState` and feature/flow state. JSON is not retained as
runtime truth. Unsupported authoring, compiled, or package schemas fail with structured diagnostics;
there is no legacy import/runtime fallback.

## Editor Commands

Project/entity mutations use the editor command and JSON-patch infrastructure so dirty state,
undo/redo, diagnostics, reference rewrites, and save remain coherent. Record rename rewrites indexed
references and deletion performs reference-use preflight.

Key implementation areas:

```text
editor/src/shared/project-schema/authoring-project.ts
editor/src/shared/project-schema/authoring-validation.ts
editor/src/shared/project-schema/authoring-compiler.ts
editor/src/shared/compiled-artifact-publication.ts
editor/src/shared/project-schema/compiled-runtime-export.ts
editor/src/renderer/project/project-store.ts
editor/src/renderer/project/entity-operations.ts
engine/include/noveltea/core/compiled_project.hpp
engine/include/noveltea/runtime/running_game.hpp
engine/include/noveltea/runtime/runtime_session.hpp
```

The collection relationship matrix is documented in
[`DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md`](../architecture/DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md).
