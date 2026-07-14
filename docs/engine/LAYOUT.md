# Layout Entity

## Purpose

Layout records define RmlUi runtime UI documents, fragments, styles, Lua event scripts, dependencies, mount behavior, sample preview state, and editor preview settings.

Layouts are the new engine's runtime UI authoring component. They should be referred to as Layouts, not UI Layouts. Legacy Qt/SFML widgets are useful workflow references only; the runtime UI layer is RmlUi.

## Current Status

Layouts are implemented as a typed authoring collection in the editor. The Layout editor supports inline or asset-backed RML, RCSS, and Lua sources; target selection; document/fragment modes; dependency lists; script metadata; mount metadata; default layout assignment; validation diagnostics; and live engine preview.

The engine has an RmlUi runtime UI integration with bgfx rendering, SDL3 input/system/file adapters, custom component hooks, document binding, and template resolution. The authoring layout preview path currently builds an editor preview document rather than exporting a complete final runtime UI package contract.

## Collection

Layout records live at:

```json
/layouts/{layoutId}
```

The record uses the standard authoring record wrapper. Layout-specific data lives in `record.data`.

```ts
interface LayoutData {
  kind: 'layout';
  layoutKind: 'document' | 'fragment';
  displayName?: string;
  target: LayoutTarget;
  rml: LayoutSourceData;
  rcss: LayoutSourceData;
  lua: LayoutSourceData;
  script: LayoutScriptData;
  mount: LayoutMountData;
  dependencies: LayoutDependencyData;
  sampleState: Record<string, unknown>;
  preview: {
    width: number;
    height: number;
    background: 'transparent' | 'checker' | 'dark' | 'light';
  };
}
```

## Identity Rules

Layout IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
main-dialogue
default-ui
room-overlay
pause-menu
```

Lua namespaces, when present, should be dot-separated Lua identifier paths, for example `layout_preview` or `ui.dialogue_box`.

## High-Level Model

A layout is either a full RmlUi document or a reusable fragment. Documents should include document-level RML structure. Fragments are mounted into an internal host during preview and should not include `<rml>`, `<head>`, or `<body>` tags.

Each layout owns three source channels:

- `rml` for RmlUi markup;
- `rcss` for RmlUi styles;
- `lua` for layout-local event script code.

Each source channel can be inline or asset-backed. Dependency lists declare additional assets/materials needed by the layout.

## Data Model

### Layout Kind

`layoutKind` is either:

```text
document
fragment
```

### Targets

`target` is one of:

```text
default-ui
dialogue-ui
scene-overlay
room-overlay
menu-ui
custom-overlay
```

The target describes intended use. It does not by itself mount the layout into the runtime until the relevant runtime/editor adapter uses it.

### Sources

A source has:

```ts
interface LayoutSourceData {
  sourceMode: 'inline' | 'asset';
  sourceText: string;
  sourceAsset: { $ref: { collection: 'assets'; id: string } } | null;
}
```

In asset mode, the selected asset is used as the source. Inline text is preserved so users can switch back without losing a draft.

### Dependencies

Dependencies are grouped by kind:

```ts
interface LayoutDependencyData {
  images: LayoutAssetRef[];
  fonts: LayoutAssetRef[];
  stylesheets: LayoutAssetRef[];
  materials: LayoutMaterialRef[];
  scripts: LayoutAssetRef[];
}
```

### Script Metadata

`script.enabled` controls whether layout Lua should execute. `script.namespace` is optional and should be a valid Lua namespace path.

### Mount Metadata

`mount.defaultParent` names the default mount target. `mount.scopedStyles` indicates whether styles should be scoped when mounted.

### Sample State

`sampleState` is editor preview data injected for testing layout behavior. It must not be interpreted as saved runtime game state.

## References

Layouts can reference:

- assets for RML, RCSS, Lua source files;
- image assets;
- font assets;
- stylesheet/text assets;
- script assets;
- material records;
- other layout records through project settings such as `settings.ui.systemLayouts.title` or `settings.ui.systemLayouts.game-hud`.

Layout refs use:

```ts
{ $ref: { collection: 'layouts', id: 'layout-id' } }
```

Asset and material refs use the standard `$ref` collection/id shape.

## Defaults

`defaultLayoutData()` creates a fragment layout by default. It includes:

- sample RML fragment with a heading, paragraph, and button;
- sample RCSS styling;
- sample Lua click counter script;
- script namespace `layout_preview`;
- mount parent `nt-layout-preview-mount`;
- empty dependency lists;
- `sampleState.projectTitle` set to `NovelTea Layout`;
- preview size `1280x720` and dark background.

Document layout defaults include a full `<rml>`, `<head>`, and `<body>` wrapper.

## Validation

Layout validation checks:

- `record.data` parses as `LayoutData`;
- inline RML source is not empty;
- inline RCSS emptiness is warned;
- asset source mode requires a source asset;
- referenced source assets exist;
- source asset extensions look appropriate for RML, RCSS, or Lua;
- source asset kinds are text-like;
- fragment RML should not include document tags;
- document RML should include `<rml>` and `<body>`;
- Lua namespace shape;
- Lua present while script execution disabled is informational;
- duplicate dependency refs produce warnings;
- image/font/stylesheet/script dependency kind or extension mismatches produce warnings;
- missing material dependencies are errors;
- default layout setting points to an existing layout when configured.

## Command Behavior

Layout-specific commands include:

- `layout.replaceData` for validated full data replacement;
- `project.setSystemLayout` for setting or clearing named engine UI roles under `settings.ui.systemLayouts` (`title`, `game-hud`, `pause-menu`, `load-menu`, `settings-menu`, `modal`, and `debug-overlay`).

Generic entity commands handle creation, rename, deletion, metadata, duplication, parent assignment, and inheritance fields.

The layout replace operation rejects invalid data when validation returns an error.

## Editor Behavior

The Layout editor provides source panes for RML, RCSS, and Lua; metadata controls for layout kind, target, preview size/background, script enablement, namespace, mount settings, dependencies, and default-layout assignment.

Diagnostics are shown near the source panes and in a summary list. The editor uses command-backed updates, so undo/redo should treat layout edits as explicit command transactions.

Asset-backed sources show a message indicating source is loaded from an asset and the inline draft is preserved for switching back.

## Editor Preview

Layout preview uses `buildLayoutPreviewDocumentData()` and the `noveltea.layout-preview.v1` preview schema. The preview payload includes:

- layout ID and label;
- layout kind and target;
- source payloads for RML, RCSS, and Lua;
- script and mount metadata;
- dependency metadata for assets/materials;
- sample state;
- preview size/background;
- internal fragment-host templates when the layout is a fragment;
- validation diagnostics.

The revision includes the layout data, source asset content hashes/paths, and material dependency data so preview refreshes when dependencies change.

## Runtime Status

Native runtime UI support is implemented through RmlUi integration. Relevant runtime pieces include:

- `RuntimeUI` for RmlUi lifecycle and document loading;
- `TypedRuntimeUIViewState` for runtime UI state exposed to documents;
- bgfx RmlUi render interface;
- SDL3 input and system interfaces;
- file interface for asset-backed loading;
- RmlUi document binder;
- custom component support;
- template resolver.

The current authoring layout schema is ahead of some runtime mounting/export behavior. Layout docs should distinguish editor preview behavior from finalized runtime package behavior.

## Export / Package Status

The compiler emits typed Layout resources and references; package assembly collects their source
assets and separate shader/material metadata. Layout data is part of the compiled resource contract,
not a provisional runtime-project manifest.

## Scripting Status

Layouts can carry Lua source as inline text or an asset reference. Runtime interaction should use
ordinary RmlUi events such as `onclick` and Lua handlers that call the typed `Game.ui.*` surface
backed by `RuntimeScriptApi`.

Lua is the only runtime scripting target. Layout script execution is controlled by `script.enabled`, and namespace metadata is available for future runtime binding discipline.

## Relationship To Other Entity Types

Layouts depend on assets and materials. Project settings can reference a default layout. Rooms can reference layout overlays. Scenes can add/remove/swap layouts. Dialogue can use a dialogue UI layout. Runtime UI/custom components consume layout documents.

## Legacy Reference Notes

Legacy GUI code and the old rich text editor can be studied for workflow ideas, but the new layout component is RmlUi-based. Do not model this component on Qt `.ui` files or old SFML widgets.

The old project did not have an equivalent RmlUi layout authoring model; this is a new-engine component.

## Recommended Authoring Patterns

Use document layouts for standalone screens such as menus. Use fragment layouts for overlays, dialogue UI pieces, and reusable components mounted into a host.

Use direct asset refs for source/dependencies that should participate in validation and packaging. Keep sample state small and editor-focused.

Keep Lua handlers namespaced to avoid accidental global collisions.

## Current Implementation Files

Primary editor files:

```text
editor/src/shared/project-schema/authoring-layouts.ts
editor/src/shared/project-schema/layout-project.ts
editor/src/renderer/editors/layouts/LayoutEditor.tsx
editor/src/renderer/project/layout-operations.ts
editor/src/renderer/commands/builtin-commands.ts
```

Primary engine files:

```text
engine/include/noveltea/ui_runtime.hpp
engine/include/noveltea/core/runtime_ui_view.hpp
engine/src/ui_runtime_rmlui.cpp
engine/src/ui/rmlui/rmlui_bgfx_noveltea_adapter.cpp
engine/src/ui/rmlui/rmlui_custom_components.cpp
engine/src/ui/rmlui/rmlui_document_binder.cpp
engine/src/ui/rmlui/rmlui_file_interface.cpp
engine/src/ui/rmlui/rmlui_input_sdl3.cpp
engine/src/ui/rmlui/rmlui_render_interface_bgfx.hpp
engine/src/ui/rmlui/rmlui_system_interface_sdl3.cpp
engine/src/ui/rmlui/rmlui_template_resolver.cpp
```

Related docs:

```text
docs/ui/RMLUI_RUNTIME_UI.md
docs/ui/RMLUI_CUSTOM_COMPONENTS.md
docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md
a future editor RmlUi layout preview/template-system plan
```

Useful legacy references:

```text
refs/NovelTea/src/core/GUI/
refs/NovelTea/src/editor/Widgets/RichTextEditor.cpp
refs/NovelTea/res/forms/RichTextEditor.ui
```

## Known Gaps

- Runtime export does not yet emit a complete layout/UI manifest.
- Visual element selection and property inspection are future features.
- Runtime mounting semantics for every layout target are still evolving.
- Lua diagnostics for layout scripts are not yet equivalent to full script compilation/runtime diagnostics.
- Dependency lists currently rely on manual authoring and validation rather than full source parsing.

## Future Work

- Define the runtime layout package manifest and mounting rules.
- Add visual element selection and inspector tooling.
- Improve RML/RCSS/Lua diagnostics from live RmlUi parsing and script execution.
- Add template/component browser integration.
- Expand layout target runtime behavior for dialogue UI, room overlays, scene overlays, and menus.

## Verification

This doc was written from the current layout authoring schema, layout preview builder, layout operations, Layout editor, validation aggregator, and runtime RmlUi engine files. No build is required for this documentation-only change.
