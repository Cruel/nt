# Map Component

## Contract

A `MapDefinition` is presentation and selection data over authoritative Room exits. It contains stable map-location IDs, typed Room IDs, authored display positions/shapes, presentation settings, and connections referencing `RoomExitRef { RoomId, RoomExitId }`.

The compiler derives each connection's target Room from the referenced exit and rejects inconsistent duplicate topology. Map never owns a second numeric-index navigation graph.

## Runtime behavior

Selecting a Room location changes map focus only. Selecting a connection navigates only when its exit belongs to the active Room and always uses the normal Room navigation pipeline. V1 grants no implicit fast travel. Minimap/full-map mode, pan, zoom, visibility, focus, and highlighting are presentation state, not alternate gameplay topology.

Map is property-bearing and may `extends` another Map only for declared custom-property lookup. Locations, connections, resources, and presentation settings do not merge.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Map record, optional `extends`, typed properties, locations, exit-backed connections, and presentation settings.
- **Compiled:** linked `MapDefinition`, validated Room/exit references, retained parent edge, resources, and property assignments.
- **Mutable:** property overrides plus logical map focus/visibility only when gameplay requires persistence.
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

`RuntimeUiDocumentBinder` and `nt-map-view` accept the typed Map record directly and emit strong-ID
`nt-map-location` and `nt-map-connection` targets. Phase 9 owns external typed input adapters and
Phase 10 owns the live shipped-consumer cutover. Legacy numeric map topology and visibility scripts
are not retained in the typed model.
