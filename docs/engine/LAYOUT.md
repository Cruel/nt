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
  scalePolicy?: {
    ui: 'inherit' | 'ignore';
    text: 'inherit' | 'ignore';
  };
  rml: LayoutSourceData;
  rcss: LayoutSourceData;
  lua: LayoutSourceData;
  script: LayoutScriptData;
  mount: LayoutMountData;
  dependencies: LayoutDependencyData;
  sampleState: Record<string, unknown>;
  preview: {
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

### Layout kind, target, slot, and runtime plane are different

Four Layout-related concepts serve different purposes and must not be used interchangeably:

- `layoutKind` (`document` or `fragment`) describes source/document structure.
- `target` describes the reusable Layout resource's intended presentation role.
- a Scene `LayoutSlot` (`hud`, `dialogue-box`, `overlay`, or `custom`) is a logical one-per-slot key in
  runtime desired state.
- `PresentationPlane` belongs to a mounted Layout instance and determines cross-backend composition
  order and transition capture.

The current compiled-Layout target mapping is:

| Authored target | Current runtime plane |
| --- | --- |
| `default-ui` | `GameUi` |
| `dialogue-ui` | `GameUi` |
| `scene-overlay` | `WorldOverlay` |
| `room-overlay` | `WorldOverlay` |
| `custom-overlay` | `WorldOverlay` |
| `menu-ui` | `MenuOverlay` |

The mounted-instance policy is authoritative at runtime. An authorized custom mount may eventually
choose a plane explicitly without changing the reusable Layout resource. Consequently, neither a
Layout's document/fragment kind nor a Scene slot name determines whether it appears above or below
other presentation.

Presentation plane remains the sole coordinate-space authority. Scale inheritance is a separate
Layout policy and does not alter plane, input, pause, visibility, clock, or ordering semantics.

### Accessibility Scale Policy

`scalePolicy.ui` and `scalePolicy.text` independently choose whether a Layout inherits the player UI
and text accessibility scales. Each value is `inherit` or `ignore`. When `scalePolicy` is omitted,
the authored target resolves these defaults:

| Resolved plane | UI scale | Text scale |
| --- | --- | --- |
| `WorldOverlay` | `ignore` | `inherit` |
| screen-space planes | `inherit` | `inherit` |

The native compiled Layout type carries the resolved policy. Until the Phase 2 wire cutover is
completed, the provisional decoder derives that native field from the existing target; Workstream 2D
will publish explicit authored policy through the versioned compiled wire. Per-instance custom mounts
may override either field without mutating the reusable Layout resource.

`TransitionGroup` validation uses the resolved mounted plane as its inclusion rule. The initial
compiled child contract admits Layout mutations only for `overlay` and `custom` slots whose referenced
Layout target resolves to `scene-overlay`, `room-overlay`, or `custom-overlay`; the wire records the
resolved participation as `plane: "world-overlay"`. `WorldOverlay` Layouts transition together with
`WorldBackground` and `WorldContent`, even though the overlay is rendered by RmlUi rather than engine
quads. `GameUi`, ActiveText, `MenuOverlay`, `Modal`, `Debug`, and letterbox bars remain outside the
group and reconcile independently.

The shared finite Layout-operation contract is `LayoutFinitePresentationOperation`. It carries the
common operation identity, gameplay clock, duration, skippability, source/target publication
revisions, exact `MountedLayoutPresentationKey` target, optional Flow completion owner, and derived
checkpoint class. The admitted animated kind is `Fade`; immediate changes allocate no operation.
Runtime publishes the target mounted record before the coordinator starts realization. The engine
retains the exact source document as hidden, inputless, and non-pausing while opacity moves from
source to target, then unmounts it after terminal completion. The current target document remains the
authoritative input/pause owner throughout.

Layout finite operations replace only another operation for the same mounted key. Different Layout
keys and actor operations may run concurrently. Skip, reset, load, owner termination, and project
reload clear backend progress and converge to the current target snapshot; no CSS animation or
serialized RmlUi state owns semantic completion.

Scene `SetLayout` authoring now states the requested entrance/exit policy explicitly: `none` is
immediate and requires zero duration with no wait, while `fade` requires positive duration and carries
wait-for-completion and skippable intent. Hide requires no Layout reference; show and swap require one.
The compiler and native decoder preserve these fields without converting them into CSS animation.

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
- target-derived UI/text scale inheritance;
- empty dependency lists;
- `sampleState.projectTitle` set to `NovelTea Layout`;
- dark preview background.

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
- `project.setSystemLayout` for setting or clearing named engine UI roles under
  `settings.ui.systemLayouts` (`title`, `game-hud`, `pause-menu`, `save-menu`, `load-menu`,
  `settings-menu`, `text-log`, `modal`, and `debug-overlay`).

Generic entity commands handle creation, rename, deletion, metadata, duplication, parent assignment, and inheritance fields.

## System Layout Roles

At runtime, `RuntimeSystemLayouts` resolves each requested system role from the compiled project.
When no project Layout is assigned, the engine uses a built-in fallback only for title, game HUD,
pause, save, load, settings, text log, and modal/confirmation. Debug overlay has no built-in fallback;
projects that open it must assign a Layout.

Authored and built-in system Layouts both mount through `RuntimeLayoutManager` with the same policy:

| Role | Plane | Clock | Input | Gameplay pause |
| --- | --- | --- | --- | --- |
| title | `MenuOverlay` | unscaled | modal | while visible |
| game HUD | `GameUi` | gameplay | normal | continue |
| pause/settings/save/load | `MenuOverlay` | unscaled | modal | while visible |
| text log | `MenuOverlay` | unscaled | block gameplay | continue |
| modal/confirmation | `Modal` | unscaled | modal | while visible |
| debug overlay | `Debug` | unscaled | normal | continue |

The shell owns the nested menu stack and resets it on return-to-title, project reload, and shutdown.
Pause is derived from visible mounted policy; it is not written into save state.

The layout replace operation rejects invalid data when validation returns an error.

## Editor Behavior

The Layout editor provides source panes for RML, RCSS, and Lua; metadata controls for layout kind,
target, UI/text scale inheritance, preview background, script enablement, namespace, mount settings,
dependencies, and default-layout assignment. The scale controls show the resolved target defaults and
can store explicit overrides or return the Layout to target-derived defaults.

Diagnostics are shown near the source panes and in a summary list. The editor uses command-backed updates, so undo/redo should treat layout edits as explicit command transactions.

Asset-backed sources show a message indicating source is loaded from an asset and the inline draft is preserved for switching back.

## Editor Preview

Layout preview uses `buildLayoutPreviewDocumentData()` and the `noveltea.layout-preview.v1` preview schema. The preview payload includes:

- layout ID and label;
- layout kind and target;
- resolved UI/text scale policy;
- source payloads for RML, RCSS, and Lua;
- script and mount metadata;
- dependency metadata for assets/materials;
- sample state;
- preview background;
- internal fragment-host templates when the layout is a fragment;
- validation diagnostics.

The revision includes the Layout data's preview-relevant fields, source asset content hashes/paths,
and material dependency data so preview refreshes when dependencies change. Per-Layout preview
dimensions are not authored or hashed; the preview host owns its current surface size.

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

Runtime presentation materializes both document and fragment resources from inline or asset-backed
RML, RCSS, and enabled Lua. Reserved Layout-slot shorthands, Room overlays, Map Layouts, and stable
owner-scoped custom Layouts all reconcile into mounted gameplay instances. Gameplay-owned mounted
intent follows its typed save disposition; the title, pause/settings/save/load/text-log,
modal/confirmation, and debug workflows are shell-owned ephemeral state managed by
`RuntimeSystemLayouts` through the same mounted-policy model.

At runtime, each mounted Layout has a strong instance ID, owner, and complete policy independent of
the reusable `LayoutResource`. Visible input policies are evaluated with `Modal` stronger than
`BlockGameplay`, then `Normal`; `None` does not participate. Equal modes use presentation plane,
signed local order, and instance identity. Escape dismisses the topmost eligible mount by owner and
does not pass through a higher non-dismissible modal. RmlUi groups compatible mounts by presentation
plane, contiguous composition group, gameplay/unscaled clock domain, and input mode. Contiguous
groups preserve interleaved mounted ordering when the same lifecycle policy appears on both sides of
a different policy. Policy replacement moves realization between contexts without changing mounted
identity and preserves visibility, listeners, and focused element identity.

## Export / Package Status

The compiler emits typed Layout resources and references; package assembly collects their source
assets and separate shader/material metadata. Layout data is part of the compiled resource contract,
not a provisional runtime-project manifest.

## Scripting Status

Layouts can carry Lua source as inline text or an asset reference. Runtime interaction uses ordinary
RmlUi events such as `onclick`. Gameplay document handlers use the typed `Game.ui.*` input surface,
shell documents use `Game.shell.*`, and authored gameplay presentation uses the typed
`noveltea.layouts.*` and `noveltea.presentation.*` modules backed by `RuntimeScriptApi` and
engine-selected capability profiles.

Lua is the only runtime scripting target. Layout script execution is controlled by `script.enabled`,
and namespace metadata participates in the compiled Layout script contract.

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
engine/include/noveltea/runtime_ui_contracts.hpp
engine/include/noveltea/core/runtime_presentation_contracts.hpp
engine/src/host/layout_realizer.hpp
engine/src/host/presentation_layout_reconciler.hpp
engine/src/ui/rmlui/runtime_ui.cpp
engine/src/ui/rmlui/runtime_ui_binder.cpp
engine/src/ui/rmlui/rmlui_document_registry.cpp
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
```

Useful legacy references:

```text
refs/NovelTea/src/core/GUI/
refs/NovelTea/src/editor/Widgets/RichTextEditor.cpp
refs/NovelTea/res/forms/RichTextEditor.ui
```

## Known Gaps

- Visual element selection and property inspection are future editor features.
- Lua diagnostics for Layout scripts are not yet equivalent to full script compilation/runtime
  diagnostics.
- Dependency lists currently rely on manual authoring and validation rather than full source parsing.
- Dialogue-specific authoring conveniences remain narrower than the generic mounted-Layout runtime
  capability.

## Future Work

- Add visual element selection and inspector tooling.
- Improve RML/RCSS/Lua diagnostics from live RmlUi parsing and script execution.
- Add template/component browser integration.
- Improve Dialogue-specific Layout authoring on top of the existing generic mount model.

## Verification

This doc was written from the current layout authoring schema, layout preview builder, layout operations, Layout editor, validation aggregator, and runtime RmlUi engine files. No build is required for this documentation-only change.
