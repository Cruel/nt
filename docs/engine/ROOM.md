# Room Entity

## Purpose

Room records define explorable spaces for NovelTea projects. A room owns display metadata, background data, description text, enter/leave Lua hooks, navigation paths, object hotspots, overlay layouts, and editor preview state.

Rooms bridge visual-novel presentation and adventure-game navigation. The new room schema is schema-first and does not preserve the old room serialization as a compatibility contract.

## Current Status

Rooms are implemented as a typed authoring collection in the editor. The Room editor supports background metadata, description text, enter/leave scripts, navigation paths, hotspots, overlays, validation diagnostics, preview settings, and a live engine preview with hotspot overlay visualization.

Authoring runtime export currently converts room records into the native runtime room array shape. Room entrypoints are currently the only runtime-exportable project entrypoint type.

## Collection

Room records live at:

```json
/rooms/{roomId}
```

The record uses the standard authoring record wrapper. Room-specific data lives in `record.data`.

```ts
interface RoomData {
  kind: 'room';
  displayName: string;
  background: RoomBackgroundData;
  description: RoomDescriptionData;
  scripts: RoomScriptsData;
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

## Identity Rules

Room IDs, path IDs, hotspot IDs, and overlay IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
atrium
north-exit
key-hotspot
inventory-overlay
```

Path, hotspot, and overlay IDs are local to the room record but use stable entity-style IDs for validation, preview selection, and future script/test references.

## High-Level Model

A room has visible presentation data, navigation data, and interaction data.

Presentation data includes background asset/material/color, description text, and optional layout overlays.

Navigation data is stored as ordered paths pointing to other room records.

Interaction data is stored as hotspots. Hotspots can be free-standing or associated with object records from the `objects` collection.

## Data Model

### Background

```ts
interface RoomBackgroundData {
  asset: RoomAssetRef | null;
  material: RoomMaterialRef | null;
  fit: 'cover' | 'contain' | 'stretch' | 'center';
  color: string | null;
}
```

`asset` normally points to an image asset. `material` optionally overrides how the background is rendered. `color` can provide a fallback or tint-style value as the renderer/editor evolves.

### Description

```ts
interface RoomDescriptionData {
  format: 'active-text' | 'plain';
  source: string;
}
```

`active-text` is the default because room descriptions may eventually share rich text/ActiveText behavior.

### Scripts

```ts
interface RoomScriptsData {
  beforeEnter: string;
  afterEnter: string;
  beforeLeave: string;
  afterLeave: string;
}
```

Scripts are Lua source snippets. They are stored as raw strings and are not currently statically analyzed for variable/object references.

### Paths

```ts
interface RoomPathData {
  id: string;
  label: string;
  direction: RoomPathDirection;
  target: RoomRoomRef | null;
  enabled: boolean;
  condition: string;
  order: number;
}
```

Directions are:

```text
northwest
north
northeast
west
east
southwest
south
southeast
custom
```

`condition` is a Lua condition string for future runtime behavior.

### Hotspots

```ts
interface RoomHotspotData {
  id: string;
  label: string;
  object: RoomObjectRef | null;
  bounds: { x: number; y: number; width: number; height: number };
  placeInRoom: boolean;
  description: string;
  script: string;
}
```

Bounds are normalized to the room preview area. `placeInRoom` controls whether the referenced object is exported as present in the room.

### Overlays

```ts
interface RoomOverlayData {
  id: string;
  label: string;
  layout: RoomLayoutRef | null;
  enabled: boolean;
}
```

Overlays attach layout records to a room.

## References

Rooms can reference:

- image assets for backgrounds;
- materials for background rendering;
- other rooms as path targets;
- objects as hotspot targets;
- layouts as room overlays.

Reference helpers are:

```ts
roomAssetRef(id)
roomMaterialRef(id)
roomLayoutRef(id)
roomObjectRef(id)
roomRoomRef(id)
```

## Defaults

`defaultRoomData()` creates:

- kind `room`;
- display name from the record label;
- null background asset/material/color;
- background fit `cover`;
- empty active-text description;
- empty before/after enter/leave scripts;
- no paths;
- no hotspots;
- no overlays;
- preview with hotspots shown, no selected hotspot, and dark background.

## Validation

Room validation checks:

- `record.data` parses as `RoomData`;
- room inheritance targets another room when set;
- inherited room exists;
- empty description emits a warning;
- background asset exists;
- background asset data is valid;
- non-image background asset emits a warning;
- background material exists and has valid material data;
- path IDs are unique;
- hotspot IDs are unique;
- overlay IDs are unique;
- path target room exists;
- path target does not point to current room without warning;
- hotspot object exists when set;
- hotspot bounds have non-zero width and height;
- overlay layout exists and has valid layout data;
- selected preview hotspot exists when set.

## Command Behavior

Room-specific command:

- `room.replaceData` for validated full data replacement.

The Room editor edits paths, hotspots, overlays, scripts, and preview state by constructing updated `RoomData` and dispatching `room.replaceData`.

Generic entity commands handle creation, rename, deletion, metadata edits, duplication, parent assignment, and inheritance relationships.

## Editor Behavior

The Room editor exposes:

- display name;
- background asset/material/fit/color fields;
- room description format and source;
- before/after enter/leave scripts;
- path list with direction, target, enabled, condition, and order;
- hotspot list with object link, normalized bounds, placement flag, description, and script;
- overlay layout list;
- embedded engine preview;
- editor-side hotspot rectangle overlay;
- preview background and hotspot visibility controls;
- validation summary.

Hotspot selection is editor preview state. Changing or deleting hotspots updates `preview.selectedHotspotId` to remain valid where possible.

## Editor Preview

Room preview uses `buildRoomPreviewDocumentData()` and the `noveltea.room-preview.v1` preview schema. The payload includes:

- room ID and label;
- display name;
- background data plus resolved background asset/material metadata;
- description;
- scripts;
- paths with target labels;
- hotspots with object metadata;
- overlays with layout metadata;
- preview settings;
- validation diagnostics.

The preview revision includes room data plus dependency revisions for background assets/materials, hotspot objects, overlays, and path target room labels.

The editor also overlays normalized hotspot rectangles over the engine preview to support placement debugging even before full runtime interactivity is complete.

## Runtime Status

Rooms currently have a native runtime model in `ProjectModel`:

```cpp
struct RoomModel {
  EntityMetadata metadata;
  std::string description_raw;
  std::string script_before_enter;
  std::string script_after_enter;
  std::string script_before_leave;
  std::string script_after_leave;
  std::vector<RoomObjectModel> objects;
  std::vector<RoomPathModel> paths;
  std::string name;
};
```

`RuntimeController` and `GameSession` provide the broader runtime/session boundary. Room export currently maps authoring room data into the runtime room array format consumed by current native project loading.

## Export / Package Status

`buildAuthoringRuntimeExport()` currently converts rooms into runtime room records. Exported room fields include:

- room ID;
- description source;
- before/after enter/leave scripts;
- placed hotspot object IDs where `placeInRoom` is true;
- ordered path targets;
- display name or record label.

Room entrypoints are currently accepted as runtime-exportable. Non-room entrypoints produce export errors.

Room background assets/materials, overlays, hotspot bounds, and rich visual preview metadata are not fully represented in the current runtime room array export. Referenced background assets may be included in file entries through export asset discovery.

## Scripting Status

Room scripts are raw Lua source strings stored on the room:

- `beforeEnter`;
- `afterEnter`;
- `beforeLeave`;
- `afterLeave`.

Path conditions and hotspot scripts are also stored as raw strings. Static validation does not yet parse or bind these strings to variables, objects, actions, or Lua APIs.

## Relationship To Other Entity Types

Rooms depend on assets, materials, layouts, objects, and other rooms. Maps can reference rooms. Project entrypoint can point to a room and currently must do so for runtime export. Tests can navigate to rooms. Scenes can hand off to rooms or use rooms as context as runtime orchestration matures.

## Legacy Reference Notes

Legacy room, object, and map files are useful for understanding adventure navigation and room-object behavior. The old serialization and Qt widget layout are not new-format requirements.

Use legacy `Room`, `Object`, `Map`, and `RoomWidget` behavior as migration reference when filling in runtime semantics for paths, objects, and maps.

## Recommended Authoring Patterns

Use one room record per navigable location. Keep path IDs stable and directional where possible. Use object-linked hotspots when the interaction should connect to inventory/actions; use free-standing hotspots for decorative or one-off interactions.

Use normalized hotspot bounds so placement remains independent of preview resolution. Keep room scripts small and move larger reusable logic into script assets/records once the script component stabilizes.

## Current Implementation Files

Primary editor files:

```text
editor/src/shared/project-schema/authoring-rooms.ts
editor/src/shared/project-schema/room-project.ts
editor/src/renderer/editors/rooms/RoomEditor.tsx
editor/src/renderer/project/room-operations.ts
editor/src/renderer/commands/builtin-commands.ts
editor/src/shared/project-schema/authoring-runtime-export.ts
```

Primary engine files:

```text
engine/include/noveltea/core/project_model.hpp
engine/include/noveltea/core/runtime_controller.hpp
engine/include/noveltea/core/game_session.hpp
engine/include/noveltea/core/runtime_ui_view.hpp
engine/src/core/project_model.cpp
engine/src/core/runtime_controller.cpp
engine/src/core/game_session.cpp
```

Useful legacy references:

```text
refs/NovelTea/include/NovelTea/Room.hpp
refs/NovelTea/include/NovelTea/Object.hpp
refs/NovelTea/include/NovelTea/Map.hpp
refs/NovelTea/src/core/Room.cpp
refs/NovelTea/src/core/Object.cpp
refs/NovelTea/src/core/Map.cpp
refs/NovelTea/src/editor/Widgets/RoomWidget.cpp
refs/NovelTea/res/forms/RoomWidget.ui
```

## Known Gaps

- Visual room background/material/overlay data is not fully exported to runtime room records yet.
- Object records are not yet documented as a fully typed new component, though room hotspots can reference the `objects` collection.
- Hotspot bounds are editor/preview data and are not yet full runtime hit-test behavior.
- Path conditions and scripts are raw Lua strings without static reference analysis.
- Room inheritance is validated but not yet documented as a runtime merge contract.

## Future Work

- Define runtime room rendering and hotspot hit-testing semantics.
- Complete object/action integration for room interactions.
- Export overlay layouts and background material data into runtime packages.
- Add script diagnostics for room hooks, path conditions, and hotspot scripts.
- Integrate maps and navigation UI more deeply with room paths.

## Verification

This doc was written from the current room authoring schema, room preview builder, room operation helper, Room editor, validation aggregator, authoring runtime export adapter, and native project/runtime headers. No build is required for this documentation-only change.
