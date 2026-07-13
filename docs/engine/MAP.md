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

## Current authoring implementation

Phase 3E implements strict V2 map presentation records with locations, display positions/shapes, and
exit-backed connections. Validation resolves each connection through the authoritative Room exit and
rejects endpoints that disagree with its source or target Room. Native compiled linking and map runtime
presentation remain Phases 4--7 work; no legacy numeric Map topology is retained.
