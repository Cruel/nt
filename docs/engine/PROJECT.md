# Project Root

## Contract

The project root owns identity, runtime settings, feature flags, localization, the stable Bootstrap Module reference,
entrypoint, collection indexes, and editor metadata. It is not an entity, property owner, or generic
mutation target.

Tracked authoring uses workspace v1 (`noveltea.project.workspace` version 1) rooted at a project
directory with `project.json` plus segmented record/source files. `ProjectWorkspaceService` strictly
assembles that tree into the current internal `noveltea.authoring.project` model used by editor,
compiler, graph, preview, and tests. That internal identity is not a persisted monolithic project
format. Native runtime code never parses authoring workspace source. Compilation emits strict
canonical `noveltea.compiled.project` format version 1.

## Collections

The current authoring model has collection-specific records for assets, variables, shaders,
materials, layouts, characters, rooms, interactables, verbs, interactions, dialogues, scenes, maps,
script modules, and tests, plus top-level Trait declarations backed by ordinary Properties.
Workspace-v1 persistence stores each record at its canonical stable-ID path; Layouts use an owning
directory for their companion source files and Traits are stored in `traits.json`.
Stable record IDs are unique within a collection and nested IDs within their owner.

Room, Character, and Interactable Gameplay Instances may attach compatible Traits and carry declared
typed Property assignments. Scene, Dialogue, Verb, Interaction, and Map are immutable program or
vocabulary definitions and are not Property/Trait owners. Universal same-type gameplay `extends` is
retired. Categories, tags, record colors/order, notes, graph positions, selections, preview state, and
workbench state remain editor-only.

## Startup and Settings

Entrypoint is a strict Room, Scene, or Dialogue reference. The Project also names one Bootstrap Module by stable Script Module ID. Each fresh Project VM imports that module synchronously without gameplay-state authority; its initialization and any modules it explicitly imports must complete without yielding before the entrypoint starts. Typed settings include display/text,
system Layout roles, title behavior, default font, application icon, localization, and runtime
defaults. Presentation settings include the validated project-default Room navigation transition;
an explicit navigation request and then the selected exit override take precedence over it.

## Compilation

`compileAuthoringProject` is the sole semantic compiler. It validates schemas, Traits and Property
requirements, references, programs, resources, settings, and startup; lowers specialized
Room/Scene/Dialogue/Interaction content; removes tooling metadata; and emits deterministic canonical
gameplay bytes.

`publishCompiledArtifact` is the shared gameplay publication module. The deep
`prepareRuntimeArtifact` module is the sole preparation interface used by preview, playback,
Runtime Package export, and platform/CLI export; it assembles file entries, shader/material metadata,
diagnostics, source identity, and package options around those exact bytes.

## Native Runtime

The native decoder validates and links untrusted compiled gameplay into immutable
`CompiledProject`. The running-game loader combines it with final package manifests/resources,
certifies Lua, and constructs one `runtime::RunningGame` containing one `runtime::RuntimeSession`.

Mutable values live only in typed `SessionState` and feature/flow state. JSON is not retained as
runtime truth. Unsupported authoring, compiled, or package schemas fail with structured diagnostics;
there is no legacy import/runtime fallback.

## Editor Commands

Ordinary fields and source are file-first. Editor saves operate on logical save units and exact file
revisions; external source changes reconcile against the saved baseline without silent overwrite.
Project/entity structural mutations use the shared command/graph/transaction infrastructure so dirty
state, undo/redo, diagnostics, reference rewrites, and filesystem changes remain coherent. The public
`noveltea` CLI uses the same workspace and transaction services for headless create/rename/delete and
usages operations.

Key implementation areas:

```text
editor/src/shared/project-schema/authoring-project.ts
editor/src/shared/project-schema/authoring-validation.ts
editor/src/shared/project-schema/authoring-compiler.ts
editor/src/shared/compiled-artifact-publication.ts
editor/src/shared/runtime-artifact-preparation.ts
editor/src/renderer/project/project-store.ts
editor/src/renderer/project/entity-operations.ts
engine/include/noveltea/core/compiled_project.hpp
engine/include/noveltea/runtime/running_game.hpp
engine/include/noveltea/runtime/runtime_session.hpp
```

The collection relationship matrix is documented in
[`DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md`](../architecture/DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md).
