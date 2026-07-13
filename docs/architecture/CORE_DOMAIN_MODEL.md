# Core Domain Model

## Status and scope

This document is the current architecture contract for the typed NovelTea domain model. It fixes the
ownership and boundary decisions that later implementation phases must follow. The current
`ProjectDocument`/`ProjectModel`, `RuntimeProject`, numeric `EntityType`, generic JSON properties, and
controller hierarchy are migration scaffolding, not alternate contracts. No legacy project, save,
entity, or package compatibility is required.

## Ownership and lifetime

The editor owns `AuthoringProject` V2 and the pure TypeScript authoring compiler. Authoring data is
optimized for editing and may contain source organization and tooling metadata. The C++ runtime never
parses an authoring project.

The compiler emits strict, deterministic `noveltea.compiled.project` V1 gameplay JSON. The C++ package
boundary validates and links that untrusted document into an immutable native `CompiledProject`.
`RuntimeSessionHost` is the sole owner of the loaded `CompiledProject`, stored by value for the loaded
session's lifetime. Runtime services and execution frames use lifetime-bounded const references or
typed IDs; they do not share ownership or retain pointers into definition vectors.

`RuntimeSessionHost` also owns one `FlowExecutor` and mutable `SessionState`. Renderer, RmlUi, Lua,
platform, audio, debugger, and editor adapters do not own gameplay state. They receive typed commands
or views and return typed input at explicit boundaries.

## Authoring, definitions, programs, frames, and state

The model deliberately separates five concerns:

1. **Authoring records** preserve editable source structure, stable IDs, explicit ordering, and
   editor-only metadata.
2. **Compiled definitions** are immutable identity and configuration, linked by typed IDs.
3. **Compiled programs** are immutable executable content specialized by domain:
   `SceneProgram`, `DialogueProgram`, and `InteractionProgram`. Room lifecycle execution uses typed
   room-hook content; it is not a universal entity program.
4. **Flow frames** are mutable execution cursors. `FlowFrame` is a closed variant of Scene, Dialogue,
   Interaction, and RoomHook frames, run by one `FlowExecutor`. Child Scene or Dialogue calls push a
   frame and Return resumes the caller; terminal continuations tail-replace, enter Room mode, return,
   or end as their typed target specifies.
5. **Session state** is mutable game progress and presentation-independent logical state. It never
   mutates compiled definitions or stores decoded JSON as a secondary source of truth.

The top-level gameplay `RuntimeMode` is exactly Room, Flow, or Ended. Loading and error presentation
belong to host/UI boundaries and are not persisted gameplay modes. Closed definitions, instructions,
frames, modes, commands, and events use variants and exhaustive visitation, with no compiler RTTI,
downcasts, or entity base hierarchy.

## Definitions and resources

Runtime content definitions are Scene, Dialogue, Character, Room, Interactable, Verb, Interaction,
and Map. `CharacterDefinition` is immutable character data; a currently presented character is
mutable `ActorState`. An `InteractableDefinition` identifies one unique interactable. Its room
position and hit area are a nested `RoomPlacement`; its live location, visibility, and enabled state
are `InteractableState`.

Assets and aliases, layouts, shaders/materials, script modules, and localization catalogs are runtime
resources, not gameplay entities. They need no common entity interface. Script modules never autorun
because they are present in a collection or package.

The compiled project root owns project identity, runtime settings, feature flags, startup hook,
entrypoint, definition collections, resource IDs, and lookup indexes. It is not an entity and cannot
be addressed through property-owner APIs.

The Phase 5A native model lives in `core/compiled_project.hpp`. `CompiledProject` privately owns each
compiled collection in a vector and exposes only const collection views. It builds a distinct
ID-to-index map for variables, property declarations, gameplay resources, and every definition kind;
lookups use checked `find_*` functions and return null for missing IDs. Same-type `extends` IDs remain
on each property-bearing definition, while separate type-specific parent-index maps provide bounded
ancestor traversal without raw pointers. Construction publishes a value only after collection indexes
and inheritance indexes are coherent and all Phase 5A structural invariants have been checked,
including finite/ranged geometry and presentation values, declaration defaults, enum ranges, and
collection-shape constraints. Compiled Scene timing values use whole nonnegative milliseconds so the
wire contract maps losslessly to the shared `DurationWait` vocabulary. The transitional
`RuntimeProject` remains a separate, operational scaffold and has not been adapted to or rerouted
through this model.

## IDs and references

Every project and nested ID is a validated owned string matching
`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. Native code uses a non-default-constructible `StrongId<Tag>` family,
including distinct Room, Scene, Dialogue, Character, Interactable, Verb, Interaction, Map, Script,
Layout, Asset, and Property IDs, plus scoped IDs for Scene steps, Dialogue blocks/segments/edges, Room
placements/exits, and actor slots.

Homogeneous references retain their strong type. Heterogeneous references use explicit closed
variants such as `Entrypoint`, `FlowTarget`, and `PropertyOwnerRef`; they never use generic
`{ collection, id }`, numeric entity tags, raw pointers, or wire-visible process indexes. The decoder
validates every reference before publishing `CompiledProject` and builds type-specific ID-to-index
lookup tables.

A project entrypoint is exactly Room, Scene, or Dialogue. A continuation/flow target is exactly Scene,
Dialogue, Room, Return, or End. Script is neither an entrypoint nor a continuation target; the
non-yielding startup hook runs successfully before the entrypoint starts.

## Properties and runtime inheritance

Project globals are declared typed variables. Definition-scoped extensibility uses declared typed
properties, never arbitrary JSON fields. A `PropertyDefinition` owns a globally unique `PropertyId`,
scalar type, nullability, optional default, allowed property-owner kinds, and Session or Save
persistence. Values use the closed `RuntimeValue` scalar set: null, boolean, signed integer,
floating-point number, and string. Absence and explicit nullable null are distinct.

Room, Scene, Dialogue, Character, Interactable, Verb, Interaction, and Map may carry typed authored
assignments and an optional same-collection `extends` edge. Categories and tags are editor-only and
have no inheritance meaning. The compiler rejects missing parents, self-parenting, cycles, and
collection mismatches; it retains valid edges rather than flattening them. The graph is immutable
during a session.

Property lookup for definition `D` is exactly:

1. `D`'s runtime override in `SessionState`;
2. `D`'s authored assignment in `CompiledProject`;
3. those two locations on each same-type ancestor, nearest first;
4. the property's declared default;
5. a typed missing-value result.

Overrides are stored once by `(PropertyOwnerRef, PropertyId)`. Setting an ancestor override therefore
immediately affects unshadowed descendants; unsetting removes only that override. The initial runtime
must use bounded direct chain traversal rather than an invalidatable resolved-value cache.

Only declared custom properties inherit by default. Structural fields, programs, graphs, placements,
exits, and resources remain local. Verb alone has V1 behavioral inheritance: availability conditions
all pass root-to-child; default programs are attempted child-to-root; `Unhandled` falls back,
`Handled` stops, and `Failed` aborts. The project undefined-interaction fallback runs only after the
root is `Unhandled`.

## Variables, session state, and saves

Variable declarations define globally scoped typed variables and initial values. `SessionState` owns
live variables, property overrides, active flow frames and logical positions, visits/history,
show-once markers, actor state, unique-interactable location/state, queues, timers, and other mutable
progress. Backend resources, renderer state, RmlUi state, audio internals, tween internals, and Lua VM
or coroutine state are excluded.

`SaveState` is the explicitly versioned persisted subset of `SessionState`. Save-policy property
overrides are serialized once on their actual owner; inherited values and Session-policy overrides
are never materialized into a save. Stable flow positions and remaining logical duration waits may be
saved. Visual/audio operations restore to documented logical post-step state rather than backend
snapshots. Saving fails with structured diagnostics at nonserializable suspension points; autosaves
occur only at compiler-marked safe points.

Lua accesses variables and definition properties only through typed host APIs. Conditions and text
expressions are synchronous and cannot yield. Effect scripts and explicit script instructions may
yield through engine-owned typed correlation handles bound to a flow frame. Native coroutine state is
never serialized; only an engine-defined serializable wait token can make a suspended script
save-safe.

## Package and JSON boundaries

A package is not one monolithic JSON document. `noveltea.compiled.project` contains gameplay
definitions, programs, state declarations, localization, resource IDs, and runtime settings. The
package manifest and shader/material metadata are separate versioned boundary documents. Package
loading independently decodes these untrusted documents and assembles one native `CompiledProject`
plus prepared resource registries.

JSON ends at codecs and external adapters. It is permitted for compiled-project decoding, package
manifests/build metadata, dedicated shader/material metadata, saves, debugger/editor-preview/external
protocols, and diagnostic serialization. Domain definitions, programs, frames, session state,
resolved properties, and internal commands/events contain no JSON and expose no generic serialization
base or mutable JSON root.

All recoverable decoding, construction, linking, lookup, execution, and save failures use
`core::Result` with typed errors or canonical `core::Diagnostics`. Untrusted nlohmann-json input uses
the audited nonthrowing helpers. The Phase 5B compiled-project boundary now strictly decodes schema
identity/version, root settings, declarations, resources, shared primitives, and every non-program
definition field into internal DTOs. It rejects unknown fields and variants, malformed IDs, invalid
numbers, and directly decoded duplicate IDs with source-aware diagnostics. Program payloads remain
unpublished and are deliberately owned by Phase 5C; semantic linking and immutable
`CompiledProject` publication remain owned by Phase 5D. The runtime is built on the completed
no-exceptions/no-compiler-RTTI policy; user-authored input must never reach assertion, termination,
throwing access, or unchecked lookup paths.
