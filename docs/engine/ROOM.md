# Room Component

## Contract

A `RoomDefinition` is an optional exploration context with presentation resources, description, placements, exits, and lifecycle conditions/effects. Room is property-bearing and may `extends` another Room only for declared custom-property lookup. Exits, placements, hooks, descriptions, and resources never merge.

## Placements, exits, and interactables

A nested `RoomPlacement` has a stable `RoomPlacementId`, one `InteractableId`, bounds, and presentation data. It describes an authored place, not ownership of mutable interactable state. A live unique interactable location is Inventory, Nowhere, or `RoomPlacementRef { RoomId, RoomPlacementId }`; only one location may be active.

Room exits are the authoritative navigation topology. Each stable `RoomExitId` has a target Room and condition. Maps reference exits rather than maintaining duplicate topology.

## Navigation pipeline

Navigation runs exactly:

1. current Room `canLeave`;
2. selected exit condition;
3. target Room `canEnter`;
4. current before-leave effects;
5. target before-enter effects;
6. switch active Room and increment target visits;
7. previous after-leave effects;
8. target after-enter effects.

Initial entry omits current-room and exit stages. A false condition changes no state. Effect failure stops with diagnostics; failure after stage 6 leaves the new Room active. Yielding effects suspend a RoomHook frame at the exact stage.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Room record, optional `extends`, typed properties, presentation/description, conditions/effects, placements, and exits.
- **Compiled:** linked `RoomDefinition`, retained parent edge, typed hooks, placements, exits, resources, and property assignments.
- **Mutable:** active Room, visits, RoomHook frames, interactable locations/state, and property overrides in `SessionState`.
- **Tooling only:** hotspot selection/overlays used only for editing, preview background, categories, tags, colors, and sort keys.

A Room is a valid project entrypoint and continuation target. Entering it clears flow execution and enters Room mode.

## Current implementation scaffold

Current authoring, preview, operations, UI, provisional export, and legacy-shaped runtime live in:

```text
editor/src/shared/project-schema/authoring-rooms.ts
editor/src/shared/project-schema/room-project.ts
editor/src/renderer/project/room-operations.ts
editor/src/renderer/editors/rooms/RoomEditor.tsx
editor/src/shared/project-schema/authoring-runtime-export.ts
engine/include/noveltea/core/project_model.hpp
engine/include/noveltea/core/runtime_controller.hpp
```

Current paths/hotspots/objects, raw Lua hooks, broad references, embedded preview state, and `ProjectModel::RoomModel` are migration scaffolding. Phase 3 replaces them with exits, placements, typed conditions/effects, and Interactable references; later phases compile and execute them. Legacy Room/Object/Map formats are not preserved.

### Current V1 authoring shape

Rooms currently live under `/rooms/{roomId}` using the shared authoring wrapper. Their typed payload is:

```ts
interface RoomData {
  kind: 'room';
  displayName: string;
  background: {
    asset: RoomAssetRef | null;
    material: RoomMaterialRef | null;
    fit: 'cover' | 'contain' | 'stretch' | 'center';
    color: string | null;
  };
  description: {
    format: 'active-text' | 'plain';
    source: string;
  };
  scripts: {
    beforeEnter: string;
    afterEnter: string;
    beforeLeave: string;
    afterLeave: string;
  };
  paths: RoomPathData[];
  hotspots: RoomHotspotData[];
  overlays: RoomOverlayData[];
  preview: {
    showHotspots: boolean;
    selectedHotspotId: string | null;
    background: 'checker' | 'dark' | 'light';
  };
}
```

Current paths have stable local IDs, labels, compass/custom directions, target Room refs, enabled
flags, raw Lua conditions, and explicit order. Current hotspots have stable local IDs, optional Object
refs, normalized bounds, a `placeInRoom` export flag, description, and raw Lua script. Overlays point
to Layouts and have enabled flags.

These details are not the V2 storage contract, but they identify behavior that the migration must
either retain or deliberately replace:

- path ID/order/direction/target become typed Room exits;
- object-linked hotspot placement becomes `RoomPlacement` plus unique `InteractableState.location`;
- normalized bounds and presentation data remain useful placement/hit-test authoring data;
- overlays remain typed Room presentation resources;
- raw lifecycle and path scripts become typed Conditions/Effects or explicit Lua forms.

`defaultRoomData()` currently creates an empty active-text description, null background
asset/material/color, `cover` fit, empty hooks, no paths/hotspots/overlays, and preview with hotspots
shown on a dark background.

### Current V1 validation and commands

Current validation checks:

- Room payload and same-collection inheritance shape;
- background asset/material validity and image suitability;
- non-empty-description warning;
- unique path, hotspot, and overlay IDs;
- valid path target Rooms and self-target warnings;
- valid hotspot Object refs and nonzero bounds;
- valid overlay Layout refs;
- valid selected preview hotspot.

Room edits use `room.replaceData`: the editor builds a complete typed payload, validates it, rejects
errors, permits warnings, and patches the Room data through the command bus. This full-replacement
pattern, undo/redo integration, and validation-before-publication are useful seams even though the
payload and generic parent operations will change.

### Current editor and preview behavior

The current Room editor exposes background asset/material/fit/color, description format/source,
four lifecycle scripts, path list, hotspot list and bounds, overlays, preview controls, validation,
an embedded engine preview, and editor-side hotspot rectangles. Hotspot selection is preview state;
deleting a hotspot repairs `preview.selectedHotspotId`.

`buildRoomPreviewDocumentData()` emits `noveltea.room-preview.v1` with resolved background
asset/material data, description, scripts, path target labels, hotspot Object metadata, overlays,
preview settings, and diagnostics. Its dependency revision includes referenced resources, target
Room labels, and linked Objects/Layouts. The rectangle overlay is useful placement tooling even before
final runtime hit testing exists.

### Current runtime/export bridge

The current native `ProjectModel::RoomModel` stores metadata, raw description, four hook scripts,
Room Objects, paths, and name. The authoring runtime exporter lowers the currently supported Room
subset into that representation, including description, hooks, placed hotspot Object IDs, ordered
path targets, and display name.

Background rendering metadata, overlay Layouts, hotspot bounds, and the final typed Interactable
location model are not fully represented by that bridge. The bridge should remain until Phase 7's
Room slice provides equivalent loading, navigation, placement, and presentation behavior.

### Current files and retained gaps

```text
editor/src/shared/project-schema/authoring-rooms.ts
editor/src/shared/project-schema/room-project.ts
editor/src/renderer/editors/rooms/RoomEditor.tsx
editor/src/renderer/project/room-operations.ts
editor/src/shared/project-schema/authoring-runtime-export.ts
engine/include/noveltea/core/project_model.hpp
engine/include/noveltea/core/runtime_controller.hpp
engine/include/noveltea/core/game_session.hpp
```

Retained gaps include final Room rendering, runtime hotspot hit testing, typed exit conditions,
Interactable/Interaction integration, overlay/background export, Map integration, and native live
property inheritance. The old generic inheritance implementation is not retained, but the behavior
demonstrated by inherited Room properties such as `map` is explicitly required by the target contract.
