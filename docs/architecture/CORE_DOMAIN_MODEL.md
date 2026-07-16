# Core Domain Model

## Status and scope

This document is the current architecture contract for the typed NovelTea domain model. It fixes the
ownership and boundary decisions that later implementation phases must follow. The provisional
project/controller/save graph has been deleted. No legacy project, save, entity, or
package compatibility is part of this contract.

## Ownership and lifetime

The editor owns `AuthoringProject` V2 and the pure TypeScript authoring compiler. Authoring data is
optimized for editing and may contain source organization and tooling metadata. The C++ runtime never
parses an authoring project.

The compiler emits strict, deterministic `noveltea.compiled.project` V1 gameplay JSON. The C++ package
boundary validates and links that untrusted document into an immutable native `CompiledProject`.
`runtime::RunningGame` owns the loaded `CompiledProject` by value inside `LoadedCompiledPackage` and
one `runtime::RuntimeSession` for the loaded session's lifetime. Runtime services and execution frames use lifetime-bounded const
references or typed IDs; they do not share ownership or retain pointers into definition vectors.

`runtime::RuntimeSession` owns one `runtime::RuntimeExecutor`, one `FlowExecutor`, and mutable
`SessionState`. `SessionState` owns the
authoritative flow stack, blocker, and mutable frame positions; `FlowExecutor` is the sole mutation
service and retains no duplicate controller stack or hidden continuation state. Renderer, RmlUi, Lua,
platform, audio, debugger, and editor adapters do not own gameplay state. They receive typed commands
or one coherent `RuntimePublication`, consume ordered `RuntimeEvent` values, and return typed input at
explicit boundaries.

## Authoring, definitions, programs, frames, and state

The model deliberately separates five concerns:

1. **Authoring records** preserve editable source structure, stable IDs, explicit ordering, and
   editor-only metadata.
2. **Compiled definitions** are immutable identity and configuration, linked by typed IDs.
3. **Compiled programs** are immutable executable content specialized by domain:
   `SceneProgram`, `DialogueProgram`, and `InteractionProgram`. Room lifecycle execution uses typed
   room-hook content; it is not a universal entity program.
4. **Flow frames** are mutable execution cursors. `FlowFrame` is a closed variant of Scene, Dialogue,
   Interaction, and RoomTransition frames, run by one `FlowExecutor`. A RoomTransition frame owns the
   complete enter/leave transaction and executes the immutable Room hook programs at explicit stages.
   Child Scene or Dialogue calls push a frame and Return resumes the caller; terminal continuations
   tail-replace, begin a Room transition, return, or end as their typed target specifies.
5. **Session state** is mutable game progress and presentation-independent logical state. It never
   mutates compiled definitions or stores decoded JSON as a secondary source of truth.

The top-level gameplay `RuntimeMode` is exactly Room, Flow, or Ended. Room and Ended modes require an
empty flow stack; Flow mode requires a non-empty stack. Loading, execution faults, and error
presentation belong to host/kernel/UI status and are not persisted gameplay modes. Closed
definitions, instructions, frames, blockers, modes, commands, and events use variants and exhaustive
visitation, with no compiler RTTI, downcasts, or entity base hierarchy.

Every live frame has a session-local `FlowFrameId`, stable definition/nested-program position, and a
closed return destination: Caller, ResumeRoom, or NoReturn. Child calls advance the caller before
pushing a fresh Scene or Dialogue frame. Return pops a child, resumes the captured Room for a transient
root flow, or fails for a direct-entry NoReturn root. Scene/Dialogue terminal targets tail-replace at
the same depth while preserving the return destination and allocating a fresh frame ID. Room targets
replace the current chain with a RoomTransition frame; they never bypass Room conditions/hooks or
assign Room mode directly. End clears the stack and blockers.

The executor advances iteratively until blocked, a mode transition completes, an instruction budget
yields, or typed diagnostics fault the kernel. One blocker may belong to the active frame and is bound
to its exact frame ID and typed operation handle. Stale or wrong-frame resumes fail without mutation.
Faulted execution is fail-stop until abort/reload; completed earlier instructions are not rolled back,
and the failing instruction does not advance.

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
wire contract maps losslessly to the shared `DurationWait` vocabulary.

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
the audited nonthrowing helpers. `decode_compiled_project` is the Phase 5D public gameplay boundary.
It strictly decodes schema identity/version, root settings, declarations, resources, shared
primitives, every definition field, and the complete Scene, Dialogue, Interaction, Verb-default, and
Room-hook program vocabulary into internal DTOs. A distinct semantic pass then validates typed and
owner-scoped references, inheritance, declarations and assignments, variable usage, graph/program
targets, gameplay Asset/Layout closure, and Map topology before building indexes and atomically
publishing `CompiledProject`. Failed linking publishes no partial model, Material IDs remain typed for
the separate Phase 5E manifest path, and neither successful nor failed decoding retains source JSON.

Phase 5E adds separate strict decoders for `noveltea.runtime-package` V1 and
`noveltea.shader-materials.v1`. `LoadedCompiledPackage` owns the already-decoded gameplay project,
typed package manifest, optional JSON-free shader/material model, and checked Asset/Layout/Script/
Material registries. Assembly verifies actual archive inventory against declared paths, sizes, and
optional CRC32 checksums; requires gameplay assets and shader binaries; validates project identity,
shader role bindings and selected variants; and closes every gameplay Material reference before
publication. The manifest does not retain archive bytes or boundary JSON. Material inheritance
remains an authoring concern: the authoritative editor builder validates its graph and emits each
runtime material as a flattened complete definition, which the native decoder then validates against
its shader interface. Platform capabilities remain in the separate player bootstrap contract rather
than being duplicated in the package manifest.

Unsupported schemas, including the removed provisional schema, are rejected by the gameplay decoder
with structured diagnostics and no fallback. The runtime is built on
the completed no-exceptions/no-compiler-RTTI policy; user-authored input must never reach assertion,
termination, throwing access, or unchecked lookup paths.
