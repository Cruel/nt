# Map Component

## Contract

A `MapDefinition` is presentation and selection data over authoritative Room exits. It contains stable map-location IDs, typed Room IDs, authored display positions/shapes, presentation settings, and connections referencing `RoomExitRef { RoomId, RoomExitId }`.

The compiler derives each connection's target Room from the referenced exit and rejects inconsistent duplicate topology. Map never owns a second numeric-index navigation graph.

## Runtime behavior

Selecting a Room location changes map focus only. Selecting a connection navigates only when its exit belongs to the active Room and always uses the normal Room navigation pipeline. V1 grants no implicit fast travel. Minimap/full-map mode, pan, zoom, visibility, focus, and highlighting are presentation state, not alternate gameplay topology.

Map is immutable presentation/selection vocabulary over authoritative Room topology, not a stateful Property or Trait owner. Runtime map focus, visibility, mode, pan, and zoom are presentation/session state rather than custom Property state on the Map definition.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Map record with locations, exit-backed connections, and presentation settings.
- **Compiled:** linked immutable `MapDefinition` with validated Room/exit references and resources.
- **Mutable:** logical map focus/visibility and other presentation state only when gameplay requires persistence; the Map definition has no Property/Trait state.
- **Tooling only:** editor pan/zoom, selection, graph coordinates distinct from authored display positions, categories, tags, colors, and sort keys.

## Current implementation

The strict V2 authoring/compiler/native path is complete. Compiled validation resolves each
connection through the authoritative Room exit and rejects missing locations, missing exits, source
Rooms that do not own the exit, and targets that disagree with the exit target.

The additive typed runtime owns `MapPresentationState` in `SessionState`. `MapView` resolves localized
title/location labels, background/layout resources, current Room, focus, visibility, mode, and
connection selectability. Location selection changes focus only. Connection activation calls the
normal typed Room navigation operation, so can-leave, exit condition, can-enter, lifecycle hooks, the
room-switch commit, visits, and fault recovery cannot be bypassed.

RuntimeUI keeps `nt-map-view` on an explicitly provisional focused custom-component path. The first
Map tag in the active Game HUD and active Text Log system documents receives the current typed Map
snapshot while gameplay state exists and emits strong-ID `nt-map-location` and
`nt-map-connection` targets. External inputs lower through the same typed session API as Lua and
player interactions. Ordinary runtime UI uses the shared `noveltea` data model; Map is the current
documented exception rather than a reason to retain a general document binder. Legacy numeric map
topology and visibility scripts are not retained in the typed model.
