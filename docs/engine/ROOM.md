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

## Typed runtime execution

The additive typed kernel executes initial entry, selected-exit navigation, and Room flow targets
through the shared `RoomTransitionFrame`. `FlowExecutor` is the sole owner of transition stage,
indexed-effect, blocker, mode, and fault mutation. The Room visitor composes it with the shared
Condition/Effect evaluators and `SessionState`; it does not maintain a second lifecycle state machine.

The target Room becomes active only after source `canLeave`, the selected exit Condition, target
`canEnter`, before-leave effects, and before-enter effects complete. The commit atomically publishes
the target background, authored overlay defaults, and visit increment. After-leave and after-enter
effects then complete before `RoomMode` is exposed. Yielding effects preserve the exact lifecycle
stage and effect index. Rejection resumes the source without hooks; fault discard resumes the source
before the commit point and the target after it.

`RoomView` exposes the current visit count, resolved description text and markup, background
presentation, overlay layouts and visibility, placement bounds/labels/layouts plus live Interactable
enabled/visible state, and resolved exit labels/conditions. Room-mode operations provide typed navigation and transient Scene/Dialogue
starts. Room properties use the shared live `PropertyResolver`; an ancestor runtime override changes
every unshadowed descendant immediately, while authored or nearer runtime values continue to shadow
it. Categories and tags are editor metadata and are not present in the runtime definition or lookup
chain.

## Transitional implementation scaffold

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

The V2 editor schema has replaced paths/hotspots/objects, raw Lua hooks, and embedded preview state
with strict exits, `RoomPlacement` records, and typed conditions/effects. The typed compiler, native
model, Room lifecycle executor, live state, and `RoomView` are complete. `ProjectModel::RoomModel`,
the one-way runtime export adapter, and controller-backed shipped consumers remain temporary loading
and cutover scaffolding. Legacy Room/Object/Map authoring formats are not preserved.

### Pre-3D authoring shape (historical migration reference)

Rooms formerly used this payload under `/rooms/{roomId}`:

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

Historically, paths had stable local IDs, labels, compass/custom directions, target Room refs, enabled
flags, raw Lua conditions, and explicit order. Hotspots had stable local IDs, optional Object refs,
normalized bounds, a `placeInRoom` export flag, description, and raw Lua script. Overlays pointed to
Layouts and had enabled flags.

These details are not the V2 storage contract, but they identify behavior that the migration must
either retain or deliberately replace:

- path ID/order/direction/target become typed Room exits;
- object-linked hotspot placement becomes `RoomPlacement` plus unique `InteractableState.location`;
- normalized bounds and presentation data remain useful placement/hit-test authoring data;
- overlays remain typed Room presentation resources;
- raw lifecycle and path scripts become typed Conditions/Effects or explicit Lua forms.

`defaultRoomData()` now creates an empty active-text description, null background asset/material/color,
`cover` fit, Always enter/leave conditions, empty lifecycle effects, and no exits, placements, or
overlays.

### Current V2 validation and commands

Current validation checks:

- Room payload and same-collection inheritance shape;
- background asset/material validity and image suitability;
- non-empty-description warning;
- unique exit, placement, and overlay IDs;
- valid exit target Rooms and self-target warnings;
- valid Interactable placement refs and normalized nonzero bounds;
- valid lifecycle variable references and effects;
- valid overlay Layout refs;
- valid selected preview hotspot.

Room edits use `room.replaceData`: the editor builds a complete typed payload, validates it, rejects
errors, permits warnings, and patches the Room data through the command bus. This full-replacement
pattern, undo/redo integration, and validation-before-publication are useful seams even though the
payload and generic parent operations will change.

### Current editor and preview behavior

The Room editor exposes background presentation, typed description source and markup, typed lifecycle
conditions/effects, exits, Interactable placements and bounds, placement presentation, overlays,
validation, and an embedded engine preview. Preview selection and layout remain editor-only state.

`buildRoomPreviewDocumentData()` emits `noveltea.room-preview.v1` with resolved background
asset/material data, typed description and lifecycle data, exit target labels, placement Interactable
metadata, overlays, and diagnostics. Its dependency revision includes referenced resources, target
Room labels, and linked Interactables/Layouts.

### Current runtime/export bridge

The current native `ProjectModel::RoomModel` stores metadata, raw description, four hook scripts,
Room Objects and name. The authoring runtime exporter lowers the currently supported Room subset into
that representation, including description, placement-derived legacy Object IDs, and display name.

Background rendering metadata, overlay Layouts, placement bounds, and the typed Interactable location
model are available on the additive typed path but are not fully represented by that bridge. The
bridge remains only until the Phase 10 atomic consumer cutover; it is not an authoritative Room model
or a compatibility requirement.

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

Retained gaps include final shipped-consumer/RmlUi cutover, concrete placement hit testing,
Interactable/Interaction execution, Map integration, persistence, and external adapters. Typed exit
execution, lifecycle ordering, visits, overlay/background state, placement presentation, transient
flows, and live Room property inheritance are implemented on the additive path. The old generic
inheritance implementation is not retained.
