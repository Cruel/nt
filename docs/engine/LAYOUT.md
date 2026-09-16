# Layout Entity

## Purpose

Layout records define RmlUi runtime UI documents, fragments, styles, Lua event scripts, dependencies, mount behavior, sample preview state, and editor preview settings.

Layouts are the new engine's runtime UI authoring component. They should be referred to as Layouts, not UI Layouts. Legacy Qt/SFML widgets are useful workflow references only; the runtime UI layer is RmlUi.

## Current Status

Layouts are implemented as a typed authoring collection in the editor. The Layout editor supports
file-backed or asset-backed RML/RCSS and file-backed, asset-backed, or absent Lua through the
workspace-v1 persistence projection; its assembled internal model still uses the existing inline or
asset source union. It also supports target selection, document/fragment modes, dependency lists,
script metadata, mount metadata, default layout assignment, validation diagnostics, and live engine
preview.

The engine has an RmlUi runtime UI integration with bgfx rendering, SDL3 input/system/file adapters,
custom component hooks, document binding, and template resolution. Authoring Layout preview uses the
same focused-document coordinator and native Layout realization path as Room preview; it does not
export or load a complete runtime package.

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
  contract: LayoutContractData;
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

In workspace-v1 projects, file-backed channels are ordinary companion files beside the Layout record:
`layout.rml`, `layout.rcss`, and `layout.lua`. Layout JSON stores a strict `file`, `asset`, or (Lua
only) `none` selector and never duplicates file text. Assembly adapts those files to the existing
internal inline representation used by compiler and preview code. Dependency lists declare additional
assets/materials needed by the layout.

All Layout RCSS is authored above NovelTea's universal RuntimeUI baseline. RuntimeUI implicitly
applies the frozen RmlUi HTML4 baseline first, then the NovelTea-specific baseline, then template and
Layout-authored RCSS. Layouts must not explicitly import the engine baseline files. The same baseline
contract is used by built-in Layouts and focused previews, so preview and runtime element defaults do
not diverge.

See `docs/ui/RMLUI_RUNTIME_UI.md` for baseline ownership, provenance, cascade order, and update policy.

### Cursor semantics and Layout ownership

Layout RCSS uses the ordinary inherited `cursor` property. `auto` contributes no RmlUi cursor request;
`default` explicitly selects the Project Default cursor; `none` hides the native cursor; the canonical
system semantic names select their corresponding native shapes; and a Project named cursor ID selects
that reusable Project definition. Statically knowable unknown names are authoring errors. Named cursors
own their Project-global image dependency, so a Layout does not repeat that image in
`dependencies.images` merely to use `cursor: <named-id>`.

Layout Lua uses the same `noveltea.presentation.cursor.set`, `set_image`, `hide`, and `clear` surface
as gameplay Lua, but calls made from a Layout are owned by that exact live Mount occurrence. The
request remains stored while the Mount is hidden, is eligible whenever that occurrence is visible even
with `input: None`, follows front-to-back presentation order against other Layout Mounts, and is
removed automatically on unmount or occurrence replacement. `clear()` removes only that Mount's
request; it cannot clear a Runtime Session-owned gameplay cursor underneath it.

### RCSS cursor images

Layout RCSS may select a one-off native custom cursor with `cursor: image(source)`. The form accepts
exactly one quoted or unquoted RmlUi resource source; it does not add hotspot, scale, fallback, or
animation syntax. Relative paths use the Layout document's normal RmlUi resource resolution, and
`project:/` and `system:/` logical resources remain available under the same namespace rules as other
RmlUi assets. Filesystem and network URL schemes are not admitted.

A `project:/` cursor image must already be an Image Asset in that Layout's declared `dependencies.images`
closure. Cursor parsing never discovers or adds a dependency. The compiler diagnoses statically
resolvable missing dependencies, wrong Asset kinds, malformed `image(...)` forms, and unknown literal
cursor names; dynamic RCSS values are validated when RmlUi resolves them at runtime. Focused Layout
preview uses the same admitted resource manifest as runtime.

Direct image cursors use hotspot `(0,0)`. Source images up to 128×128 retain their authored pixel
size; larger images are fitted within 128×128 while preserving aspect ratio and use the Image Asset's
nearest/linear sampling policy when available. Cursor pixels remain in the native cursor domain and
are not affected by Project reference resolution or UI/text accessibility scale. Resolution failures
or native cursor-realization failures diagnose and fall through the centralized cursor
arbitration path rather than failing gameplay.

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

### Layout Contract and Mount Context

A reusable Layout resource declares a typed `contract`. The resource is not itself a runtime
occurrence. Each runtime occurrence is an engine-owned **Layout Mount** identified semantically by the
pair `(PresentationOwner, MountedLayoutPresentationKey)` and carrying a separate occurrence token for
stale-event rejection.

The contract contains named scalar inputs, named semantic signals, and an optional recursive State
Shape. Input and signal-field types are `boolean`, `integer`, `number`, and `string`; declarations also
state nullability, input defaults, and whether each signal field is required. State Shapes add arrays
and strict objects recursively. A State Shape default must itself be a valid Persistable Value for the
whole shape. Layout-local contract identifiers (input IDs, signal IDs, signal-field IDs, and object
field IDs in State Shapes) begin with a lowercase letter and may use lowercase letters, numbers,
hyphens, and underscores. This deliberately differs from project/domain entity IDs, which remain
kebab-case only; script-facing names such as `saved_count` and `item_selected` are therefore valid.
Empty contracts are the implicit compiled default so existing Layouts do not acquire wire noise merely
by being compiled.

Mount inputs are read-only. A Mount may supply an input from a literal value, a global Variable, an
identity Property, or a standard engine facet. The current standard facets are runtime mode, current
Room, and gameplay-paused state. Binding sources remain authoritative until the Mount is updated or
removed; presentation projection reevaluates them after settled gameplay changes rather than copying a
mutable value into Layout Lua.

A custom Lua mount uses `noveltea.layouts.mount(instance, layout, options)`. `options.inputs` is keyed
by contract input ID. A scalar value is a literal; binding tables use `{ variable = "id" }`,
`{ property = "id", target = { ... } }`, or `{ facet = "runtime-mode" }`. `options.signals` is the
array of signal IDs that the owner connects for that Mount. All assignments and connections validate
atomically against the target Layout contract; a failed update leaves the prior Mount untouched.

During a realized Layout input event, `Game.mount_context()` returns the exact occurrence context.
`context:input(name)` reads the resolved typed input and `context:signal(name, payload)` submits a
connected Layout Signal. A stateful Layout additionally uses `context:state(scope)`,
`context:commit_state(scope, value)`, and `context:clear_state(scope)`, where `scope` is `visit`,
`room`, `flow`, or `session` when that scope is valid for the Mount owner. Signals and Slot commits are
semantic runtime inputs, not DOM events: the runtime validates the owner-qualified Mount identity and
occurrence token before accepting them into the ordered input pipeline.

`context:dismiss()` is the generic occurrence-safe self-dismiss primitive. The runtime accepts it only while the exact owner/key/occurrence tuple is still live, so stale document events cannot dismiss a replacement Mount. `context:present_child(layoutId, instanceId?)` presents another Layout as an explicit child of this exact Mount occurrence and carries the same immutable Trigger Context. The optional instance ID gives authored code a stable scoped key; when omitted, runtime allocates a unique contextual key. Presentation parentage is separate from activation source geometry: removing the parent cascades through its children, while movement or disappearance of the original geometry source does not invalidate the captured snapshot. `context:present_child_inventory()` is the Player Inventory convenience form and opts into contextual coexistence rather than the ordinary Inventory replacement group.

Activation-triggered Mounts may carry an immutable engine-owned **Trigger Context** containing canonical normalized pointer and source-bounds geometry. The snapshot contains no DOM, renderer, Hotspot, or world-object handles. `context:trigger()` transforms that snapshot into the receiving Layout's current logical coordinate space. `context:position_hint()` derives a recommended Layout origin from that same snapshot as plain logical `x`/`y` numbers and never changes DOM or RCSS state. It uses the pointer when present, otherwise the source-bounds center, otherwise the viewport center. A Mount without Trigger Context returns `nil`.

Layout code owns how a Position Hint becomes presentation. Lua may assign the returned numbers directly to element properties or publish them as RCSS custom properties such as `element.style["--menu-x"] = hint.x .. "px"` for declarative `var()`/`calc()` styling. Hints may intentionally resolve outside the viewport. A Layout that needs size-aware alignment, flipping, or viewport-safe repositioning may instead use `context:anchor(width, height, source?, side?, alignment?, gap?, padding?, offsetX?, offsetY?)`, which resolves pointer, source-bounds, or nearest-source-point anchoring with preferred side/alignment and the Layout-supplied dimensions. `gap` remains the distance away from the selected source along the chosen side axis. Because Trigger Context geometry is immutable, directly called Interaction/Scene/Dialogue presentation can reuse it without retaining a live activation element.

The global `Layout` Lua namespace contains reusable Layout-authoring helpers. `Layout.clamp_to_viewport(element, x, y, padding?)` returns `{x, y, clamped_x, clamped_y}` without mutating the element. It uses the element's laid-out width and height plus its owning RmlUi context dimensions to shift the requested origin only as far as necessary to remain inside the viewport. Padding defaults to `0` and must be finite and non-negative. If an element is larger than the available padded extent on an axis, that axis resolves to the padding edge and the helper does not resize the element.

NovelTea defines the pure-Lua `Layout` toolbox in the engine-owned `system:/scripts/bootstrap.lua`. The engine executes this system bootstrap once in the stable frontend/RmlUi Lua VM before RuntimeUI initialization, so `Layout.*` is available to Layout scripts without adding an RML `<script>` dependency. Gameplay sessions use separate Project Lua VMs and execute their authored Bootstrap Module there; Project-bootstrap globals are therefore not visible to Layout scripts. Native/runtime capabilities remain C++ bindings, while pure-Lua frontend helpers belong in the system bootstrap rather than embedded C++ script strings.

Contextual Mounts may also carry an explicit presentation parent and replacement group. Parent identity is `(owner, key, occurrence)`, so a child may only attach to the exact live parent occurrence and stale parents are rejected. Parent dismissal removes all descendants deterministically. Replacement groups remove other members of the same group and their descendants; ordinary Inventory presentation uses this to replace its prior default occurrence, while explicitly contextual Inventory presentation can coexist.

Layout Slot state is explicit engine-owned checkpoint state. A Slot is addressed by its semantic Mount
key inside the selected lifetime scope, and a successful commit atomically replaces the prior value.
Clearing removes the value so the State Shape default becomes visible again; unmounting a Layout does
not clear a Slot whose scope still exists. Visit Slots expire with the Active Room Context, Room and
Flow Slots expire with their semantic owners, and Session Slots expire with the runtime session.

Lua values cross the Slot boundary only through the declared State Shape. The conversion accepts the
supported scalar/array/object tree and rejects cycles, metatables, functions, coroutines, userdata and
DOM objects, sparse or mixed tables, undeclared or invalid object keys, and non-finite numbers. A
persisted `null` is exposed as `context.null` so null values remain representable inside Lua arrays and
objects without collapsing into Lua `nil`; `nil` may still be committed for a nullable root/member when
Lua can represent that position directly. The engine therefore never treats arbitrary Lua tables,
RmlUi DOM/focus state, animations, or backend handles as save state.

Updating inputs, order, visibility, or compatible policy keeps the Mount occurrence and does not imply
UI replacement. Replacing the referenced Layout recreates the realized UI and allocates a fresh
occurrence token while retaining the owner-qualified semantic key; unmount ends the occurrence.
Runtime Session, Active Room Context, and Flow ownership continue to remove their Mounts
 deterministically when the owner ends.

Save data retains reconstructible Mount intent plus validated Layout Slot records. It does not retain
the occurrence token, DOM/focus state, animation progress, or arbitrary Lua state. Restore first
reconstructs gameplay and Slot state, allocates fresh Mount occurrences, and reevaluates bindings.
Realization stages each candidate hidden, input-disabled, non-pausing, and non-dismissible while its
Mount context is already available to synchronous Layout Lua. Only a candidate whose Slot values,
bindings, and synchronous local reconstruction all succeed is admitted with the authored policy and
visibility. Before a hidden Layout is shown, NovelTea updates the receiving RmlUi context so current
data-model views are materialized and laid out. The document's `show` event therefore observes settled
element dimensions; after `onshow` handlers run, NovelTea performs one document update to commit any
size-dependent style changes before the first visible render. A reconstruction failure while loading rejects the candidate session; an ordinary later
remount failure leaves the existing Slot untouched and diagnoses the Mount.

The Layout editor exposes the contract as validated JSON alongside RML/RCSS/Lua and includes it in the
focused-preview input/revision. Preview sample state remains editor-owned test data; it is not saved
runtime Mount state.

### Accessibility Scale Policy

`scalePolicy.ui` and `scalePolicy.text` independently choose whether a Layout inherits the player UI
and text accessibility scales. Each value is `inherit` or `ignore`. When `scalePolicy` is omitted,
the authored target resolves these defaults:

| Resolved plane | UI scale | Text scale |
| --- | --- | --- |
| `WorldOverlay` | `ignore` | `inherit` |
| screen-space planes | `inherit` | `inherit` |

The current compiled Layout wire carries the fully resolved policy. Per-instance Scene or Lua
mounts may override either field without mutating the reusable Layout resource; omitted override
fields retain the compiled Layout policy.

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

The following is the assembled internal authoring model consumed by editor/compiler code. It is not
the workspace-v1 JSON shape for file-backed source. On disk, file-backed RML/RCSS/Lua is selected by
`file` and stored in the canonical companion file; asset-backed source stores only its typed asset
selector; Layout Lua additionally permits `none`.

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
  data?: LayoutAssetRef[];
}
```

### Script Metadata

`script.enabled` controls whether layout Lua should execute. `script.namespace` is optional and should be a valid Lua namespace path.

### Mount Metadata

`mount.defaultParent` names the default mount target. `mount.scopedStyles` indicates whether styles should be scoped when mounted.

### Sample State

`sampleState` is editor-only data used to seed a standalone Layout preview. `sampleState.inputs` supplies values for declared Mount Contract inputs, while `sampleState.state` seeds the preview's synthetic `session` Layout State Slot. Missing input samples use declared input defaults; inputs with neither a sample nor a default make focused preview invalid. Missing state uses the State Shape default when one exists.

Focused Layout preview publishes a preview-only semantic Mount, so normal `Game.mount_context()` APIs work without a preview-specific Lua path. State commits and clears update an editor-local Slot that survives ordinary source/document rebuilds for the same Layout. Changing the State Shape or `sampleState.state`, clearing focused preview, or changing projects resets that preview Slot. Shape and seed changes take effect only when the candidate preview commits; rejected or superseded candidates leave the committed Slot untouched. The committed Mount, input route, and Slot are active before the document's `show` handlers run, so those handlers can commit or clear state. Each rebuilt document receives a fresh occurrence token. This state is never runtime save data.

When an authored Layout is mounted inside focused Room preview, it uses that mount's semantic identity rather than standalone sample identity. Room overlays use the Layout Contract defaults and expose preview-local `room` and `session` State scopes through `Game.mount_context()`; standalone `sampleState` does not seed a Room mount. Ordinary rebuilds preserve state for the same Room/overlay identity, while removing or replacing that mount retires its preview state. Gameplay actions emitted by the Layout remain passive.

## References

Layouts can reference:

- assets for RML, RCSS, Lua source files;
- image assets;
- font assets;
- stylesheet/text assets;
- script assets;
- JSON-backed data assets used through `Data.load(assetId)`;
- material records;
- other layout records through project settings such as `settings.ui.systemLayouts.title` or `settings.ui.systemLayouts.game-hud`.

Layout refs use:

```ts
{ $ref: { collection: 'layouts', id: 'layout-id' } }
```

Asset and material refs use the standard `$ref` collection/id shape.

## Defaults

`defaultLayoutData()` still creates a fragment layout by default for shared/schema callers. The editor New Layout wizard selects the document starter by default. Shared defaults include:

- sample RML with a heading and explanatory text;
- sample RCSS styling for the content panel; NovelTea's universal baseline already makes the document `body` click-through while restoring normal pointer events on authored elements;
- script namespace `layout_preview`;
- mount parent `nt-layout-preview-mount`;
- target-derived UI/text scale inheritance;
- empty dependency lists, including data dependencies;
- document `sampleState.state` seeded to `{ saved_count: 0 }` (fragment sample state is empty);
- dark preview background.

The document starter includes two counters. The Lua-global counter survives ordinary remounts only as frontend Lua state and is not serialized into NovelTea saves. The saved counter declares a Layout State Shape with `saved_count`, commits it in `session` scope through `Game.mount_context():commit_state(...)`, and reconstructs both button labels from current state in the document `show` lifecycle event. The same semantic Mount API works in focused Layout preview using its editor-local State Slot, while gameplay uses the runtime save-backed Slot.

Explicit fragment defaults remain a simpler fragment-local click-counter example mounted into the internal preview host.

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
- data dependencies must resolve to JSON-backed `data` Assets;
- missing material dependencies are errors;
- default layout setting points to an existing layout when configured.

## Command Behavior

Layout-specific commands include:

- `layout.replaceData` for validated full data replacement;
- `project.setSystemLayout` for setting or clearing named engine UI roles under
  `settings.ui.systemLayouts` (`title`, `game-hud`, `command-builder`, `pause-menu`, `save-menu`,
  `load-menu`, `settings-menu`, `text-log`, `modal`, and `debug-overlay`).

Generic entity commands handle creation, rename, deletion, metadata, and duplication. Layouts do not participate in gameplay Trait attachments or universal record inheritance.

## System Layout Roles

At runtime, `RuntimeSystemLayouts` resolves each requested system role from the compiled project.
When no project Layout is assigned, the engine uses a built-in fallback for title, game HUD,
Command Builder, pause, save, load, settings, text log, and modal/confirmation. Debug overlay has no
built-in fallback; projects that open it must assign a Layout.

System roles use fixed engine contracts and cannot accept Layouts that declare custom inputs,
signals, or a State Shape. Project Settings and the Layout editor offer only empty-contract Layouts
for these roles. The stateful document starter is intended for custom Mounts; its Title UI assignment
is disabled with guidance to remove its custom contract and update dependent Lua first.

Authored and built-in system Layouts both mount through `RuntimeLayoutManager` with the same policy:

| Role | Plane | Clock | Input | Gameplay pause |
| --- | --- | --- | --- | --- |
| title | `MenuOverlay` | unscaled | modal | while visible |
| game HUD | `GameUi` | gameplay | normal | continue |
| Command Builder | `GameUi` | gameplay | normal | continue |
| pause/settings/save/load | `MenuOverlay` | unscaled | modal | while visible |
| text log | `MenuOverlay` | unscaled | block gameplay | continue |
| modal/confirmation | `Modal` | unscaled | modal | while visible |
| debug overlay | `Debug` | unscaled | normal | continue |

A project-assigned system Layout is a behavioral replacement, not only a visual or policy
replacement. Every RuntimeUI-owned RmlUi context exposes the same read-only `noveltea` data model
before documents load. A full document or Fragment can opt any subtree into it explicitly with
`data-model="noveltea"`; model availability is context-wide and independent of system role. System
role continues to determine lifecycle, mounting, input/pause policy, and shell routing, but it does
not trigger native population of element IDs.

Copying a built-in RML/RCSS document into a project Layout preserves its declarative behavior when
the copied `data-model`, `data-*` bindings, and typed callbacks are retained. IDs may be changed or
omitted unless the authored stylesheet, focus logic, or project code itself depends on them. Current
projection state is reused after document reload or lifecycle-context recreation.

The `command-builder` role is gameplay-owned and replaceable. Runtime owns its occurrence identity,
semantic subject capture, exact watched-reference snapshots, forced lifecycle termination, and final
complete-command validation. The Layout owns the transient partial Command Draft, focused slot,
backtracking/rebinding UX, confirmation, and cancellation. The built-in document submits one-slot
Offers directly; multi-slot Offers create a Layout-local Draft and progressively bind subject presses.
Project-authored replacements derive the unique selected subject and Offer starting slot from the
`noveltea` projection, then use the generic occurrence-bound `Game.ui` Builder transport to begin,
replace the exact watch set, and submit their own complete named bindings. Each built-in bound-slot
button can drop that binding for recapture, immediately resynchronizing the exact watched-reference
set. Draft state is never part of Session/Save state or recorded playback. While an
occurrence is active, world and inventory subject activation is captured for the Builder instead of
executing the normal subject-first action. Runtime accepts watches and final bindings only for subjects
semantically captured for that occurrence, rejects stale occurrence-bound updates/submissions, and
revalidates the complete command against current control authority, live subject eligibility, Verb
availability, and named-slot selectors before Interaction Flow begins. Losing Room/Flow ownership or
accepting another direct control command terminates the occurrence.

See `docs/ui/RMLUI_DATA_MODEL_CONTRACT.md` for the exact `project.*`, `gameplay.*`, and `shell.*`
field schema, callbacks, projection semantics, and custom-element exceptions.

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

Layout preview uses the focused Layout adapter and the `noveltea.layout-preview` preview schema.
The pure adapter reads the current graph closure and produces a canonical document revision, resource
revision, and explicit resource manifest. The preview payload includes:

- layout ID and label;
- layout kind and target;
- resolved UI/text scale policy;
- source payloads for RML, RCSS, and Lua;
- script and mount metadata;
- dependency metadata for assets/materials;
- sample state;
- preview background;
- the closed `layout-fragment-host-v1` template identifier when the Layout is a fragment.

Host template RML/RCSS bytes are build-owned and are never transported as project resources.
Builder diagnostics are published in the focused diagnostic scope rather than embedded in document
data. Relative RML script/template links are resolved only through declared graph dependencies; a
path discovered only by parsing RML is never fetched implicitly.

The revision includes exactly consumed Layout fields, source bytes/hashes, material metadata, authored
display environment, and closed host-template identity. Per-Layout preview dimensions are not
authored or hashed; the preview host owns its current surface size. Same-root failures retain the
prior document, while root changes remain hidden until native commit succeeds.

Native focused Layout preparation resolves inline or asset-backed RML, RCSS, and enabled dedicated
Lua before publication, then loads the candidate under hidden generation-scoped document IDs. A full
document without an explicit `<head>` retains the standalone preview compatibility behavior: the
candidate builder synthesizes a head before injecting resolved RCSS. The authored display environment
is prepared separately and committed only after the candidate document is known to load. A source,
Lua, policy, ordering, or document-load failure rolls back the hidden candidate without hiding,
unloading, or mutating the previously committed Layout, Room, or Shader visual.

## Runtime Status

Native runtime UI support is implemented through RmlUi integration. Relevant runtime pieces include:

- `RuntimeUI` for RmlUi lifecycle and document loading;
- `TypedRuntimeUIViewState` for runtime UI state exposed to documents;
- `RuntimeUiDataModel` for the context-local `noveltea` read model;
- `RuntimeUiActionGateway` for revision gating, typed action validation, Layout admission, and Lua/
  model-callback dispatch;
- bgfx RmlUi render interface;
- SDL3 input and system interfaces;
- file interface for asset-backed loading;
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

Layouts can carry Lua source as inline text or an asset reference. Runtime interaction can use
`noveltea` model callbacks through `data-event-*` or ordinary Lua-backed RmlUi events. Gameplay Lua
handlers use the typed `Game.ui.*` input surface, shell documents use `Game.shell.*`, and authored
gameplay presentation uses the typed
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
engine/src/ui/rmlui/runtime_ui_data_model.cpp
engine/src/ui/rmlui/runtime_ui_action_gateway.cpp
engine/src/ui/rmlui/rmlui_document_registry.cpp
engine/src/ui/rmlui/rmlui_bgfx_noveltea_adapter.cpp
engine/src/ui/rmlui/rmlui_custom_components.cpp
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
