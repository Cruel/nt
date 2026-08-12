# NovelTea

NovelTea is a visual-novel engine and editor. This glossary fixes cross-cutting project language; detailed architecture and behavior remain in the current documentation hierarchy rooted at `docs/OVERVIEW.md`.

## Project artifacts

**Project**:
A NovelTea game in its editable source form. Use **editor project** only when it must be distinguished from a runtime artifact.
_Avoid_: Authoring project in product-facing language
_See_: `docs/engine/PROJECT.md`

**Project Workspace**:
The directory-backed on-disk representation of a Project: its editable filesystem source tree rather than a runtime artifact.
_See_: `docs/editor/project/PROJECT_WORKSPACE_FORMAT.md`

**Compiled Project**:
The generated gameplay representation produced from a Project for consumption by the native runtime. It is neither editable project source nor the distributable package around that runtime data.
_See_: `docs/architecture/COMPILED_PROJECT_WIRE_V2.md`

**Runtime Package**:
The distributable `.ntpkg` artifact containing a Compiled Project and the runtime resources needed to run it.
_See_: `docs/runtime/PACKAGE_EXPORT.md`

## Gameplay

**Room**:
A gameplay location that groups Room-local composition, lifecycle behavior, placements, and exits.
_See_: `docs/engine/ROOM.md`

**Character**:
An authored character identity and definition used by dialogue, world state, and presentation. A Scene actor is a presentation instance and is not itself the Character.
_See_: `docs/engine/CHARACTER.md`

**Interactable**:
A uniquely identified gameplay object that can occupy the world or inventory and participate in Interactions.
_Avoid_: Object, Item
_See_: `docs/engine/INTERACTABLE.md`

**Verb**:
A named interaction intent that defines how many subjects an Interaction takes and how that intent is presented and made available.
_See_: `docs/engine/VERB.md`

**Interaction**:
A rule that matches a Verb, subjects, and relevant context to an interaction program and outcome.
_Avoid_: Action
_See_: `docs/engine/INTERACTION.md`

**Scene**:
The canonical visual-novel orchestration component for authored presentation and gameplay steps.
_Avoid_: Cutscene
_See_: `docs/engine/SCENE.md`

**Dialogue**:
A specialized conversation graph with its own authored flow and mutable execution position.
_See_: `docs/engine/DIALOGUE.md`

**Map**:
Presentation and selection data over authoritative Room exits; it does not define a second navigation topology.
_See_: `docs/engine/MAP.md`

## Resources and UI

**Layout**:
An authored runtime UI document or fragment.
_Avoid_: UI Layout
_See_: `docs/engine/LAYOUT.md`

**Asset**:
An imported project resource such as an image, font, audio file, script, shader source, data file, or opaque binary, addressed through stable project asset identity and metadata.
_See_: `docs/engine/ASSET.md`

## Runtime

**Running Game**:
The lifetime owner that joins one loaded immutable runtime package with one mutable Runtime Session.
_See_: `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`

**Runtime Session**:
The authoritative mutable gameplay execution context for one Running Game.
_See_: `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`

**Runtime Publication**:
An immutable coherent set of runtime projections derived from one settled logical state revision for consumers such as presentation and runtime UI.
_See_: `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`
