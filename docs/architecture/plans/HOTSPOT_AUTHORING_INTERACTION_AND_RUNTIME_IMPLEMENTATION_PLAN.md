# Hotspot Authoring, Interaction, and Runtime Implementation Plan

## Status

Status: Active implementation plan

Created: 2026-08-05

Last architecture review: 2026-08-05

Last ambiguity audit: 2026-08-05

Ambiguity-audit result: complete. No known schema, ownership, lifecycle, coordinate, precedence,
resource, editor-command, protocol, or phase-sequencing choice remains open. Phase 1 contains two
evidence gates—cross-backend sampled `R8` support and package-binding-before-texture-request order.
Those are verification questions with prescribed failure handling, not implementation alternatives.

This plan implements image-relative hotspots for Rooms and Interactables, React-native Room
composition and hotspot authoring, runtime pointer hit testing, Interaction/Room-exit activation,
runtime-generated hotspot masks, and hotspot highlight materials. It incorporates the reviewed
decisions made before this document was created and is the authority for this implementation
workstream until it is completed and archived.

The plan deliberately reuses NovelTea's existing authoring command system, authoring dependency
graph, compiled-project boundary, asset request orchestration, structured prefetch planner, residency
manager, world presentation renderer, material/shader system, input projection, Flow executor, and
Interaction runtime. It must not introduce a parallel cache, job system, editor preview protocol, or
click-script subsystem.

## 0. Authority and implementation rules

### 0.1 Repository authority

Implementation must interpret this plan together with the current repository. Existing definitions
are authoritative unless this plan explicitly changes them. Principal current authorities include:

- `editor/src/shared/project-schema/authoring-rooms.ts`;
- `editor/src/shared/project-schema/authoring-interactables.ts`;
- `editor/src/shared/project-schema/authoring-interactions.ts`;
- `editor/src/shared/project-schema/compiled-project.ts`;
- `editor/src/shared/authoring-compiler-*.ts`;
- `editor/src/shared/project-schema/authoring-graph-*` and graph consumers;
- `editor/src/renderer/editors/rooms/RoomEditor.tsx`;
- `editor/src/renderer/editors/interactables/InteractableEditor.tsx`;
- `editor/src/renderer/commands/builtin-commands.ts` and the project command/transaction services;
- `engine/include/noveltea/core/compiled_project.hpp`;
- `engine/include/noveltea/core/flow.hpp`;
- `engine/include/noveltea/core/runtime_presentation_contracts.hpp`;
- `engine/include/noveltea/assets/typed_assets.hpp`;
- `engine/include/noveltea/assets/structured_prefetch.hpp`;
- `engine/src/assets/structured_prefetch.cpp`;
- `engine/src/render/bgfx/bgfx_typed_asset_loader.*`;
- `engine/src/render/bgfx/bgfx_material_binder.*`;
- `engine/src/world_presentation.cpp`;
- `engine/src/host/host_input_router.*`;
- `engine/src/runtime/runtime_executor_interaction.cpp`;
- `docs/architecture/SCHEMA_VERSION_POLICY.md`;
- `docs/architecture/WORLD_AND_ROOM_PRESENTATION_SPEC.md`;
- `docs/rendering/REFERENCE_RESOLUTION_AND_PRESENTATION_SPEC.md`;
- `docs/engine/ROOM.md`, `INTERACTABLE.md`, `INTERACTION.md`, `VERB.md`, `SHADER.md`, and
  `MATERIAL.md`;
- `docs/assets/OVERVIEW.md` and `docs/rendering/OVERVIEW.md`;
- `docs/editor/AGENT_GUIDE.md` and `docs/editor/TECH_STACK.md`.

### 0.2 Normative language

`must` and `must not` are completion requirements. This plan contains no advisory `should`
requirements. Code sketches define exact ownership and semantics; spelling may change only to match
an existing repository naming convention without changing the contract.

This document intentionally resolves every product-visible and cross-subsystem design choice needed
by the implementation phases. An implementation pass must not treat an unlisted alternative as
equally valid. When the current repository makes one written requirement impossible, the pass must
record the concrete conflict in this plan, replace the affected requirement with one exact decision,
and preserve every unaffected requirement before continuing.

Implementation must remain buildable after each phase. Each phase must update its completion entry,
record concrete downstream constraints discovered during implementation, and run every applicable
exit gate before the next phase begins. Later phase scope may be corrected only when a direct finding
makes the written plan inaccurate or unsafe; unaffected requirements must remain intact.

### 0.3 Fixed terminology

- **Hotspot owner**: one Room background or one Interactable definition with alpha or nonempty custom
  hotspot coverage. A custom-empty Interactable has no runtime hotspot surface.
- **Room hotspot**: a hotspot whose image coordinate space is the Room background image.
- **Interactable hotspot**: a hotspot whose image coordinate space is the Interactable sprite.
- **Default alpha mode**: the singular Interactable hotspot whose coverage is every sprite pixel with
  alpha greater than zero.
- **Custom mode**: zero or more explicitly authored rectangular hotspots belonging to the same
  Interactable; Rooms always use the equivalent explicit rectangular hotspot list.
- **Image UV space**: normalized source-image coordinates, with `(0, 0)` at the source image's upper
  left and `(1, 1)` at its lower right.
- **Room reference space**: the normalized project reference-resolution coordinate space already used
  by `RoomPlacement.bounds`.
- **Hotspot surface**: the runtime grouping of one source image, the owner's hotspot definitions, and
  any derived alpha coverage or custom GPU mask needed by those definitions. It is a conceptual
  dependency grouping, not a new persisted asset format or cache system.
- **Hotspot owner reference**: either `{ room }` or `{ interactable }`; owner kind is always retained
  and a bare record ID is never resolved across both collections.
- **Hotspot mask**: a runtime-generated owner-local binary coverage texture for the union of every
  custom hotspot rectangle owned by one Room or Interactable. A texel is `0` outside all rectangles
  and `255` inside at least one rectangle. The mask does not encode hotspot identity, priority,
  condition state, or activation.
- **Active hotspot bounds**: the exact image-UV rectangle of the one currently hovered or pressed
  custom hotspot. Custom highlight shaders receive these bounds in addition to the owner mask so
  overlapping hotspots and changing eligibility never require mask regeneration.
- **Hotspot activation**: one `ActivateHotspotInput` resolved authoritatively into either a Verb
  Interaction invocation or selected-exit navigation.
- **Hotspot invocation**: the Verb branch of hotspot activation, carrying the configured Verb,
  operands, active Room, and exact hotspot reference in `InteractionInvocationContext`.

### 0.4 Deliberate implementation freedom

Only these choices remain implementation-resolved:

- private helper/class names and file subdivision inside the exact ownership areas named by this
  plan, when public command/schema/protocol/type names fixed here remain unchanged;
- internal container choice where this plan does not prescribe serialized order, deterministic
  ordering, or a public semantic type;
- editor colors, handle size, icons, spacing, and responsive arrangement, provided the behavior,
  shared-component ownership, accessibility, and existing editor design-system rules remain intact;
- exact visual constants of the built-in sheen/border effect, provided alpha/custom built-ins expose
  the same required bindings, state response, and premultiplied-alpha behavior;
- diagnostic suffix spelling. New stable codes must use prefixes `hotspot.authoring.`,
  `hotspot.compiled.`, `assets.hotspot_mask.`, `runtime.hotspot.`, `presentation.hotspot.`, or
  `editor.hotspot.` according to the owning boundary and be documented with their tests;
- private row/tile iteration order inside mask preparation, provided output bytes and the per-step
  work limits are exact.

No other ownership, schema, lifecycle, precedence, coordinate, resource, input, phase, or cutover
choice is deliberately open.

### 0.5 No legacy compatibility or automatic conversion

This workstream provides no backwards compatibility for any contract replaced by this plan.

- Authoring project version 2 is rejected. The editor does not open it and rewrite it as version 3.
- Compiled project version 2 is rejected. The runtime does not decode, normalize, or relink it.
- `noveltea.shader-materials.v1` is rejected. No v1 reader, alias, inferred sampler binding, or
  dual-version Material loader remains.
- Save state version 6 is rejected after the version-7 cutover. Loading does not drop hotspot context,
  synthesize `hotspot: null`, or otherwise upgrade the save.
- No hidden importer, startup migration, one-time conversion prompt, compatibility CLI, recovery-path
  conversion, or development-only legacy reader is added by this plan.
- Checked-in examples, fixtures, templates, and development projects are replaced directly with the
  current forms. Retired artifacts remain only as explicit negative rejection fixtures.

The unchanged `noveltea.room-preview` version 2 contract remains the single current focused-preview
contract because this feature does not modify that boundary. Its version number does not represent
legacy support or coexistence with a newer Room-preview contract.

## 1. Goal and completion result

Implement all of the following as one coherent feature:

1. Rooms support multiple named rectangular hotspots over their background image.
2. Interactables default to one alpha-derived hotspot and can switch to multiple named rectangular
   custom hotspots.
3. Every hotspot can have its own condition, activation, input priority, and highlight policy.
4. Room hotspot activation can invoke a zero-operand Verb or activate an existing Room exit.
5. Interactable hotspot activation invokes a one-operand Verb with the owning Interactable as the
   subject.
6. Interaction rules can distinguish the exact Room or Interactable hotspot while generic existing
   Interactable rules continue to work.
7. The reusable hotspot editor and Room placement/manipulation tools are ordinary React editor
   components. They do not run inside the editor-preview engine and do not add preview manipulation
   commands or events.
8. Runtime pointer hit testing uses the exact same background-fit and world-geometry transforms as
   world rendering.
9. Default-alpha coverage is derived while the sprite texture is decoded and is stored with that
   loaded texture resource.
10. Binary custom hotspot masks are generated during existing structured prefetch or demand preparation,
    on worker threads where supported and through bounded cooperative work where threads are
    disabled.
11. No hotspot mask is written into the runtime package, project assets, editor metadata, recovery
    state, or a new persistent cache.
12. Active presentation retains all image, alpha-coverage, custom-mask, material, and shader leases
    required for correct input and rendering; existing residency policy owns their eventual eviction.
13. Default and custom hotspot highlight materials use explicit shader-role and sampler-binding
    contracts.
14. Mouse, touch, save/resume, test playback, debugger messages, Lua invocation, and RmlUi invocation
    paths preserve the same typed hotspot invocation context where those paths can initiate or retain
    an Interaction.

The feature is complete when a packaged game can prefetch a Room containing default-alpha and custom
Interactable hotspots plus multiple Room hotspots, accurately hover and activate the topmost eligible
target through the production input path, render the selected highlight material, yield/save/resume
the resulting Interaction safely, and release all resources through the existing residency system.

## 2. Fixed architectural decisions

### 2.1 Hotspots remain distinct from placements and Interactables

`RoomPlacement` remains an occupant-free Room reference-space anchor. It does not become inherently
clickable and does not own hotspot behavior. A Room hotspot is not converted into an Interactable.
An Interactable remains the unique mutable gameplay object; its hotspots are immutable presentation
and invocation definitions belonging to that Interactable.

### 2.2 Multiple hotspots are first-class for both owners

Rooms and custom-mode Interactables both support multiple hotspots. The runtime must identify the
specific hotspot, not merely the owning Room or Interactable. Overlap resolution must be stable and
deterministic.

Default-alpha Interactable mode is deliberately singular. Switching to custom mode replaces the
alpha-derived region with the custom hotspot list; it does not silently retain an overlapping hidden
alpha hotspot.

### 2.3 V1 authoring geometry is rectangular only

V1 custom hotspot geometry is a normalized rectangle. The reusable editor architecture must leave a
clean shape/tool seam for connected-point polygons, but the current schema must not include an
unimplemented polygon variant. Polygon support will be an atomic future current-schema change across
editor, compiler, runtime, mask generation, tests, and documentation.

### 2.4 Hotspot coordinates are image-relative

Room hotspots use Room-background image UV coordinates. Interactable hotspots use sprite image UV
coordinates. `RoomPlacement.bounds` continues using Room reference space. No schema field may be
described generically as screen-relative when it actually belongs to one of those two domains.

The editor and runtime must share pure transform semantics for:

- Room background `cover`, `contain`, `stretch`, and `center` behavior;
- crop UVs produced by `cover`;
- letterboxed/non-image areas produced by `contain` and by `center` when the native image is smaller
  than the reference viewport;
- viewport clipping produced by `center` when the native image is larger than the reference viewport;
- Room placement reference-space projection;
- Interactable placement-rect to sprite-UV projection.

### 2.5 Direct manipulation is React-native

Drawing hotspots, selecting them, dragging/resizing them, dragging/resizing Room placements, and
placing Interactables are renderer React responsibilities. Do not add selection handles, picking,
dragging, transient transforms, or authoring command transport to `noveltea-editor-preview`,
`FocusedPreviewPresenter`, `web/widget.html`, or the preview protocol.

The existing focused Room preview remains a passive engine-accurate visual preview. The Play preview
is the runtime path used to exercise hotspot interactions.

### 2.6 Runtime-generated data reuses the current asset pipeline

There is no new hotspot cache subsystem. Specifically, implementation must not add:

- a hotspot disk-cache service;
- a content-addressed mask cache beside `AssetManager`;
- generated mask files in `.ntpkg`;
- editor-authored mask image Assets;
- a mask-specific worker pool;
- a second residency manager;
- an independent eviction policy.

Default alpha coverage is part of the existing loaded image texture resource. Custom masks are a new
typed derived resource submitted through the existing `AssetManager`, request orchestrator,
`JobExecutor`, `PrefetchPlanner`, and `AssetResidencyManager`. The standard internal request identity
needed by those existing services is not a separate caching architecture.

### 2.7 CPU hit testing is authoritative

Shaders visualize hotspots; they do not decide clicks. Authoritative hit testing remains CPU-side:

- default alpha mode samples retained compact alpha occupancy;
- V1 custom rectangles use analytic rectangle tests;
- no GPU readback is allowed;
- visual-mask readiness cannot substitute for required CPU hit data.

### 2.8 One binary custom mask per owner

All custom hotspots for one Room or Interactable contribute to one owner-local binary union mask.
The mask exists only for shader visualization. CPU hit testing retains exact hotspot identity through
the compiled rectangle list and never attempts to recover identity from the mask.

This representation deliberately avoids a region-slot limit and correctly supports overlapping
hotspots whose conditions or priorities change at runtime. The selected hotspot is isolated in the
shader by combining the binary owner mask with the active hotspot's exact image-UV rectangle. Mask
bytes therefore remain immutable for one compiled owner definition and do not change when hover,
pressed state, conditions, Verb availability, or input priority changes.

### 2.9 Hotspot behavior routes through existing runtime systems

Hotspots do not contain arbitrary on-click Lua or effect arrays.

- A Room hotspot may bind to a zero-arity Verb or to an existing exit in the same Room.
- An Interactable hotspot binds to a one-arity Verb and invokes it with the owning Interactable as
  its single subject.
- Verb activation uses normal availability, rule selection, fallback, FlowTarget, yielding, failure,
  and save behavior.
- Exit activation uses the existing `RoomExitRef` navigation path so exit conditions, selected-exit
  transition overrides, lifecycle ordering, commit semantics, and save behavior remain canonical.

### 2.10 Highlight materials are optional and per hotspot

Each hotspot selects exactly one policy:

- `default`: use NovelTea's built-in hotspot highlight material for that mode;
- `material`: use one authored Material with the hotspot-overlay role;
- `none`: produce no highlight draw.

The hit target remains functional when highlight policy is `none`, and that policy adds no mask,
Material, or Shader dependency. `default` and `material` are declared presentation requirements, not
best-effort effects: their image/mask/Material/Shader resources must participate in the normal
mandatory publication gate before a presentation containing that hotspot is committed. A candidate
resource failure preserves the prior presentation and cannot change hit testing or run gameplay.

## 3. Explicit non-goals and forbidden substitutions

The following are outside this plan:

- polygon authoring or runtime polygon masks;
- freehand mask painting;
- imported user mask-image assets as the hotspot definition;
- Character, Room prop, environment, Layout-element, or map-location hotspots;
- shader-deformed hit geometry that follows arbitrary vertex/fragment displacement;
- keyboard/gamepad hotspot navigation and accessibility focus order beyond retaining useful labels;
- a verb-selection radial menu or multi-step point-and-click verb UI;
- automatic computer-vision hotspot generation;
- persistent generated-mask caching;
- editor-preview manipulation tools;
- compatibility readers or migrations for retired project/compiled/save/material schema versions.

The following substitutions are forbidden:

- storing Room hotspots in `RoomPlacement`;
- creating a hidden Interactable for each Room hotspot;
- using draw-call inspection or GPU pixel reads for hit testing;
- rasterizing custom masks every frame or every pointer move;
- generating masks only after first hover;
- decoding the same sprite into a second duplicate GPU texture solely to retain alpha coverage;
- keying a custom mask only by source image path when different owners can define different regions;
- adding per-hotspot full-resolution textures when one owner-level region mask is sufficient;
- running Interaction programs directly from renderer input without the runtime command/Flow path;
- accepting missing new fields under the retired schema version as a same-version compatibility path.

## 4. Reviewed current architecture

### 4.1 Authoring and compiled records

Rooms currently own background presentation, exits, placements, cast, props, environments, overlays,
composition, and lifecycle. Interactables own sprite/material presentation and initial mutable state.
Neither schema owns hotspots. Compiled project wire version 2 mirrors those records strictly.

`RoomPlacement.bounds` is normalized to the project reference frame. `PresentationInteractable`
currently carries placement bounds and renders its sprite stretched over that rectangle with full UVs.
Room backgrounds already use the centralized `WorldPresentationLayoutPolicy::fit_background()`
contract.

### 4.2 Interaction invocation and persistence

`InteractionInvocationContext` currently carries a Verb, optional active Room, and Character or
Interactable operands. It is retained in `InteractionFrame`, which means any added hotspot context is
save-relevant. Interaction contexts currently support any, active Room, Room placement, and predicate
filters. Exact operands determine specificity; hotspot context does not yet exist.

### 4.3 Assets, jobs, and prefetch

`StructuredAssetRequest` currently includes font, texture, shader-program, material, and audio typed
requests. Texture preparation reads and decodes RGBA8 bytes on a worker/cooperative preparation task,
then creates the bgfx texture on the owner thread. Decoded pixels are currently discarded after
upload preparation. Structured prefetch already discovers current/direct-next/adjacent dependencies,
coalesces request identities, retains generation tickets, and promotes prefetched work to demand.

### 4.4 Materials and rendering

The material binder supports static package textures and one dynamic `$draw.texture` source. Shader
sampler declarations do not yet have standard engine bindings. Shader roles do not yet include a
hotspot overlay. World rendering already computes exact fitted background rect/UV data and ordered
Interactable draw rectangles, but it publishes no hit-target geometry or overlay draw state.

### 4.5 Host input

`HostInputRouter` already gives RmlUi and mounted Layout input priority and projects host pointer
coordinates into reference-resolution coordinates. No world input consumer currently receives that
projected pointer for hit testing. Focused Room preview deliberately installs passive input.

## 5. Authoring data contract

### 5.1 Shared V1 types

Create the shared hotspot schema module at
`editor/src/shared/project-schema/authoring-hotspots.ts`, plus the compiled/native types required by
Sections 6 and 7.

The semantic authoring shape is:

```ts
type HotspotHighlight =
  | { kind: 'default' }
  | { kind: 'material'; material: MaterialRef }
  | { kind: 'none' };

interface HotspotCommon {
  id: string;
  label: string;
  condition: Condition;
  inputOrder: number;
  highlight: HotspotHighlight;
}

interface RectHotspotShape {
  kind: 'rect';
  bounds: ImageNormalizedRect;
}

interface VerbHotspotActivation {
  kind: 'verb';
  verb: VerbRef | null;
}
```

Hotspot IDs use the existing project entity-ID syntax and are unique only within one owner. Labels
are trimmed, non-empty plain authoring strings used by editor lists, diagnostics, debugger output,
and future accessibility surfaces; they are not localized runtime text in V1. `inputOrder` is any
signed 32-bit integer. Larger values have higher pointer priority within one owner. Duplicate
`inputOrder` values are valid and use ascending `HotspotId` as the final deterministic tie-break.
Authored array order is editor list order only and has no interaction or rendering semantics.

`verb: null` is permitted in the editable authoring record so a newly created hotspot can exist while
the user selects behavior. Project validation must report it as an actionable error and the compiler
must not publish a runtime artifact until it is resolved. The compiled contract always contains a
valid `VerbId`.

`ImageNormalizedRect` must be a shared type distinct in naming from Room placement bounds even if its
numeric shape is currently identical. Persisted bounds must be finite, have `x`/`y` in `[0, 1]`, have
positive `width`/`height`, and satisfy `x + width <= 1` and `y + height <= 1`. Validators reject
out-of-range stored values; only editor gesture code clamps a draft before committing it.

Point containment uses a half-open rectangle on right and bottom edges so adjacent hotspots do not
both claim their shared boundary. The global image edge remains reachable: when `x + width == 1`,
`u == 1` is inside, and the equivalent rule applies to `v == 1`. TypeScript and C++ tests must use the
same fixture vectors for this rule.

### 5.2 Room hotspot shape

Add `hotspots` to `RoomData`:

```ts
type RoomHotspotActivation =
  | VerbHotspotActivation
  | { kind: 'exit'; exitId: string };

interface RoomHotspotData extends HotspotCommon {
  shape: RectHotspotShape;
  activation: RoomHotspotActivation;
}

interface RoomData {
  // existing fields
  hotspots: RoomHotspotData[];
}
```

Room hotspot IDs are unique only within their owning Room. Exit activation must reference an exit in
the same Room. A Room with hotspots must reference a valid image background. Color-only backgrounds
cannot own image-relative hotspots.

Verb activation must reference an existing zero-arity Verb. Exit activation uses the existing exit's
condition in addition to the hotspot's own condition.

The add-rectangle command creates the hotspot from the completed drag bounds with a unique generated
ID based on `hotspot`, label `Hotspot`, `always` condition, `inputOrder` one greater than the current
maximum or `0` when the list is empty, default highlight, and `{ kind: 'verb', verb: null }`
activation. Increment saturates at `INT32_MAX`; duplicate priorities are valid. A zero-area completed
drag creates no command. The user may rename the generated ID through the command-backed rename path.

### 5.3 Interactable hotspot modes

Add the discriminated hotspot mode at `InteractableData.presentation.hotspots`, alongside `sprite`
and `material`, with this exact semantic shape:

```ts
interface InteractableHotspotBehavior extends HotspotCommon {
  activation: VerbHotspotActivation;
}

type InteractableHotspots =
  | {
      kind: 'sprite-alpha';
      hotspot: InteractableHotspotBehavior;
    }
  | {
      kind: 'custom';
      hotspots: Array<
        InteractableHotspotBehavior & {
          shape: RectHotspotShape;
        }
      >;
    };
```

The default for a new Interactable is `sprite-alpha` with stable nested ID `primary`, label derived
from the Interactable label, `always` condition, `inputOrder: 0`, default highlight, and an unbound
Verb that produces a visible validation error until assigned.

The derived alpha-hotspot label is copied only at Interactable creation. Later Interactable label or
display-name edits do not silently rewrite an explicitly editable hotspot label.

The alpha hotspot ID and label remain editable. Renaming the ID rewrites exact Interaction hotspot
contexts atomically. Alpha-to-Custom mode switching removes the alpha hotspot and starts with an
empty custom list. Custom-to-Alpha removes every custom hotspot and creates a new alpha hotspot with
ID `primary` and the defaults above. Both directions must refuse the switch while any removed
hotspot has an exact Interaction reference; V1 performs no automatic semantic remap, including when
a removed custom hotspot was also named `primary`.

Default alpha coverage is exactly `alpha > 0`. Do not add an alpha-threshold control in V1.

Every bound Interactable hotspot Verb must have arity one. Custom mode may contain zero hotspots,
which intentionally makes the Interactable non-clickable. Custom-empty mode permits either a visual
sprite or `sprite: null`; it is the explicit current-model representation for logical/inventory-only
Interactables that own no clickable image surface.

The custom add-rectangle command uses the same defaults as the Room command except that the bound
Verb must ultimately have arity one. Custom hotspot IDs remain independently editable and unique
within the Interactable.

### 5.4 Image metadata requirements

Image import/reimport must populate exact positive pixel width and height plus source alpha-channel
presence in one required current-schema field:

```ts
interface AssetData {
  // existing fields
  imageMetadata: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  } | null;
}
```

`imageMetadata` is non-null exactly when `kind === 'image'` and null for every other Asset kind.
`width` and `height` are positive integers no greater than `65535`, matching the existing typed
texture dimension limit, and describe the encoded/base decode before EXIF
orientation. `hasAlpha` means the imported decoder reports an alpha channel; it does not claim that
any texel is actually transparent. `orientation` is Sharp's EXIF orientation, normalized to `1` when
the source has no orientation tag. The current
`preview.width`/`preview.height` fields are removed rather than retained as a second dimensions
authority. Thumbnail revision and media-preview-only metadata remain under `preview`.

V1 hotspot owners require `orientation === 1`. A Room background or Interactable sprite with another
orientation produces a compilation-blocking diagnostic instructing the author to normalize/reimport
the image. The current asset import service does not auto-rotate or re-encode project image bytes
because that would be a lossy and surprising source transformation. This is ordinary current-format
asset ingestion, not a legacy project importer. The restriction prevents browser EXIF presentation
and native base-pixel coordinates from disagreeing.

The compiled image resource must carry width and height copied from `imageMetadata`. `hasAlpha` stays
editor-side because runtime correctness scans decoded RGBA bytes and does not trust metadata.
Hotspot compilation must fail when the source image lacks valid dimensions. Runtime mask preparation
must not re-probe dimensions from a second independent metadata path.

Texture preparation must verify that decoded base-level dimensions exactly match the compiled
width/height before publishing either the texture, alpha occupancy, or a dependent mask. A mismatch
is a source-generation/package diagnostic and fails mandatory publication; runtime must not rescale a
mask or silently replace compiled dimensions. This check protects Sharp import metadata from decoder
or source-file drift.

Reimport must replace dimensions and alpha metadata together with the content hash while preserving
authored sampling. Existing development projects and fixtures must be rewritten to the new current
project schema; do not add a missing-dimensions compatibility fallback.

Hotspot rectangles remain unchanged normalized UV values when reimport changes image dimensions.
V1 does not attempt to preserve old source-pixel coordinates, rescale rectangles, or prompt for a
conversion. The editor immediately redraws the same UV regions over the new image and the next source
generation regenerates alpha/mask data.

`ImportedAssetMetadata` and `assetDataFromImportMetadata()` must require `imageMetadata` for image
records and null for non-images. Update every image-producing path, not only the file-picker service:

- manual import and reimport;
- ComfyUI generate/edit output ingestion;
- project/template and platform acceptance fixture builders;
- compiler golden-project builders;
- tests and tools that construct imported image metadata directly.

No producer may synthesize placeholder `1x1` dimensions merely to satisfy the schema. A producer
that has image bytes must inspect them through the existing Sharp dependency before creating the
current Asset record; a fixture that intentionally has no bytes must declare exact fixture dimensions
and identity orientation explicitly.

### 5.5 Validation

Validation must cover every item below:

- duplicate hotspot IDs within one owner;
- missing, zero, non-integer, or greater-than-65535 image dimensions;
- invalid image-relative bounds;
- Room hotspots without an image background;
- alpha mode without a valid image sprite;
- nonempty custom mode without a valid image sprite;
- default alpha on a non-image Asset;
- default alpha on an image without alpha as a warning that the full rectangle is clickable;
- hotspot ownership by an image with non-identity EXIF orientation;
- missing or wrong-arity hotspot Verb;
- missing or foreign Room exit;
- missing highlight Material;
- highlight Material with the wrong shader role;
- custom mode material/shader interfaces that cannot consume image plus mask;
- default-alpha material/shader interfaces that cannot consume the source image;
- Interaction rules referring to missing owner/hotspot pairs;
- exact hotspot Interaction contexts that reference exit-activated Room hotspots;
- exact hotspot Interaction contexts whose rule Verb differs from the referenced hotspot Verb;
- Room Verb-hotspot contexts whose rule has any operand;
- Interactable hotspot contexts whose one operand is `any-character` or an exact subject other than
  the owning Interactable; `any-interactable`, `any-subject`, and the exact owning Interactable are
  the only valid operand forms.

Diagnostics must use stable codes and JSON-pointer paths that navigate to the owner and exact hotspot.

## 6. Compiled and versioned contract changes

### 6.1 Current-only schema cutovers

The implementation changes strict versioned records and must follow the single-current-version
policy. The planned cutovers are:

- `noveltea.authoring.project`: version 2 to version 3;
- `noveltea.compiled.project`: version 2 to version 3;
- `noveltea.shader-materials.v1`: replace with `noveltea.shader-materials.v2`;
- `noveltea.save.state`: version 6 to version 7 when hotspot invocation is added to saved
  Interaction frames.

Before each cutover, verify the current constants in the repository. Update every producer, consumer,
fixture, negative rejection test, documentation marker, and
`cmake/schema_version_policy/contracts.tsv` row atomically. Remove retired readers and old positive
fixtures. Do not add migrations, default missing fields, dual writers, or same-version unions.

The cutover is destructive with respect to retired development data: rewrite checked-in/current
development files before validation, and reject any remaining retired artifact. Do not implement a
temporary bridge merely to make local files open during the transition.

The authoring-project version 3, compiled-project version 3, and shader/material v2 changes form one
atomic schema implementation unit. They may be developed internally in any order, but no phase may
finish with only one or two of those current contracts changed, and no checked-in producer may emit a
hotspot-bearing project that the current compiler/native consumer cannot represent. Save-state
version 7 remains a later independent atomic cutover because hotspot invocation frames are not
created until the runtime invocation phase.

The focused `noveltea.room-preview` version 2 contract does not change in this workstream. Focused
Room preview receives no hotspot definitions, masks, hover state, activation, or manipulation
commands. Its internal `RuntimePresentationSnapshot` construction must populate empty hotspot values
required by the new C++ type shape. Any future request to visualize hotspots in focused preview is a
separate current-schema change, not implementation freedom in this plan.

### 6.2 Native identities and references

Add a shared strong nested `HotspotId` plus typed refs:

```ts
type HotspotRefData =
  | {
      kind: 'room-hotspot';
      room: RoomRef;
      hotspotId: string;
    }
  | {
      kind: 'interactable-hotspot';
      interactable: InteractableRef;
      hotspotId: string;
    };
```

This is the canonical authoring/compiled/save/test semantic JSON projection whenever a hotspot
reference crosses a serialized boundary. Do not serialize owner and hotspot as an untyped pair or
infer owner kind from collection lookup.

```cpp
struct RoomHotspotRef {
    RoomId room;
    HotspotId hotspot;
};

struct InteractableHotspotRef {
    InteractableId interactable;
    HotspotId hotspot;
};

using HotspotRef = std::variant<RoomHotspotRef, InteractableHotspotRef>;

struct RoomHotspotOwnerRef {
    RoomId room;
};

struct InteractableHotspotOwnerRef {
    InteractableId interactable;
};

using HotspotOwnerRef = std::variant<RoomHotspotOwnerRef, InteractableHotspotOwnerRef>;
```

The owner kind remains part of every external reference. A bare `HotspotId` is never globally
resolved.

### 6.3 Compiled definitions

Compiled Room and Interactable definitions must contain the fully linked, non-null runtime forms:

- stable hotspot ID and label;
- condition;
- explicit `input_order`;
- highlight policy and linked optional Material ID;
- rectangle geometry for custom hotspots;
- linked Verb ID or same-Room `RoomExitId` activation;
- explicit Interactable hotspot mode.

The semantic native model is:

```cpp
struct ImageNormalizedRect {
    double x;
    double y;
    double width;
    double height;
};

struct DefaultHotspotHighlight {};
struct NoHotspotHighlight {};
struct MaterialHotspotHighlight { MaterialId material; };
using HotspotHighlight = std::variant<DefaultHotspotHighlight, MaterialHotspotHighlight,
                                      NoHotspotHighlight>;

struct HotspotCommonDefinition {
    HotspotId id;
    std::string label;
    Condition condition;
    std::int32_t input_order;
    HotspotHighlight highlight;
};

struct VerbHotspotActivation { VerbId verb; };
struct RoomExitHotspotActivation { RoomExitId exit; };

struct RoomHotspotDefinition {
    HotspotCommonDefinition common;
    ImageNormalizedRect bounds;
    std::variant<VerbHotspotActivation, RoomExitHotspotActivation> activation;
};

struct AlphaInteractableHotspotDefinition {
    HotspotCommonDefinition common;
    VerbHotspotActivation activation;
};

struct CustomInteractableHotspotDefinition {
    HotspotCommonDefinition common;
    ImageNormalizedRect bounds;
    VerbHotspotActivation activation;
};

struct AlphaInteractableHotspots {
    AlphaInteractableHotspotDefinition hotspot;
};

struct CustomInteractableHotspots {
    std::vector<CustomInteractableHotspotDefinition> hotspots;
};

using InteractableHotspotDefinitions =
    std::variant<AlphaInteractableHotspots, CustomInteractableHotspots>;
```

`RoomDefinition` owns `std::vector<RoomHotspotDefinition> hotspots`. `InteractablePresentation` owns
`InteractableHotspotDefinitions hotspots`. Mechanical type names may follow repository conventions,
but the variants, field ownership, and null-free compiled semantics are fixed.

Compiled arrays preserve authored list order for deterministic round-trip/golden output, but runtime
priority uses only `input_order` and `HotspotId`. No compiled region slot or 255-hotspot limit exists
in V1 because the custom GPU mask is binary and CPU hit testing retains exact rectangle identity.

### 6.4 Compiler and native decoder

Update TypeScript lowering, strict wire schemas, C++ wire DTOs, decoder key sets, linkers, validation,
and model lookup helpers together. The compiler must preserve authored hotspot array order and exact
image UV values. Native validation must independently reject malformed bounds, owner mismatches,
wrong Verb arity, missing exits, duplicate IDs, and invalid material roles even when the editor
compiler normally prevents them.

Exact hotspot Interaction contexts are valid only for Verb-activated hotspots. Native and editor
validation must reject a context that names a Room exit hotspot, a rule whose Verb differs from the
referenced hotspot's configured Verb, or an Interactable hotspot rule whose Verb/operand arity cannot
be one subject. These are invalid current data, not merely unreachable-rule warnings.

Compiled golden projects must contain representative:

- Room verb hotspot;
- Room exit hotspot;
- default-alpha Interactable hotspot;
- custom Interactable with multiple overlapping hotspots;
- per-hotspot default, custom, and no-highlight policies;
- hotspot-specific Interaction context.

## 7. Interaction and activation contract

### 7.1 Invocation context

Extend `InteractionInvocationContext` with:

```cpp
std::optional<compiled::HotspotRef> hotspot;
```

All non-hotspot invocations set it to `null`. Hotspot invocations set the exact owner and hotspot ID.

Room Verb hotspots invoke the configured zero-arity Verb with no operands. Interactable hotspots
invoke the configured one-arity Verb with one exact `InteractableInteractionSubject` operand.

Hotspot initiation uses one canonical semantic command rather than allowing callers to fabricate an
arbitrary `InteractionInvocationContext`:

```cpp
struct ActivateHotspotInput {
    compiled::HotspotRef hotspot;
};
```

The runtime gateway resolves that reference against the current active presentation, rechecks owner
presence, visibility/enabled state, hotspot condition, and activation availability, then either
submits the configured zero/one-operand Verb invocation or the configured selected-exit navigation.
Generic action APIs such as `Game.run_action` continue creating `hotspot = null`; they do not accept
an optional spoofable hotspot argument. Lua, RmlUi, debugger controls, authoring tests, and playback
that need semantic hotspot activation use the typed `ActivateHotspotInput` path.

The authoritative handler belongs to `RuntimeSession`/`RuntimeExecutor` behind the existing runtime
command gateway. It resolves compiled definitions plus current session/Room state; it does not trust
the renderer's hit target, mask, hover state, or material state. A Room hotspot requires that Room to
be the active Room. An Interactable hotspot requires the owning Interactable to be enabled, visible,
and currently located at a valid placement in the active Room. The host controller supplies only the
exact ref selected by geometry. Every non-pointer caller goes through the same handler.

### 7.2 Rule context

Add an exact hotspot Interaction context variant to authoring, wire, and native types:

```text
{ kind: 'hotspot', hotspot: RoomHotspotRef | InteractableHotspotRef }
```

It filters only invocations carrying that exact reference. Existing `any`, active-Room,
Room-placement, and predicate contexts remain available.

### 7.3 Matching precedence

The rule selector must extend its deterministic specificity tuple without changing existing operand
semantics:

1. more exact operands;
2. stronger existing operand wildcard specificity;
3. exact hotspot context over non-hotspot contexts when both otherwise match;
4. existing declared rule order as final tie-break.

An exact hotspot rule therefore wins over an otherwise identical generic Interactable rule. A more
specific exact-subject rule must not lose merely because another rule has a hotspot context.
Equal-specificity authoring warnings must include hotspot-context specificity.

The exact tuple is evaluated only after normal rule eligibility has passed. A hotspot context does
not make an unavailable Verb, false predicate, wrong active Room, or mismatched operand eligible.

### 7.4 Room exit activation

Room exit hotspots do not create Interaction frames. Pointer activation submits the same typed
selected-exit navigation input used by Map/player/Lua/test paths. The active Room, hotspot owner, and
referenced exit must still match at activation time. Conditions are rechecked through the canonical
navigation path rather than trusting stale hover state.

Hover eligibility for an exit hotspot requires the hotspot condition and the exit condition to be
true. `canLeave`, target `canEnter`, and lifecycle effects are not speculatively executed for hover;
the canonical navigation transaction evaluates them after activation. A failure there clears
pressed state and reports the ordinary navigation failure.

### 7.5 Persistence and external invocation surfaces

Because `InteractionFrame` retains `InteractionInvocationContext`, save-state version 7 must encode,
decode, validate, and restore the optional exact hotspot reference. Restore must reject missing owners
or hotspot IDs in the loaded current compiled project. When a saved frame carries a hotspot, restore
must also verify that the referenced hotspot is Verb-activated, its configured Verb equals the saved
invocation Verb, and its owner kind matches the saved operand shape: no operands for a Room hotspot,
or exactly the owning Interactable subject for an Interactable hotspot. Restore does not require the
owner to remain currently visible or in the active Room because a yielding program may already have
changed presentation state after invocation.

Audit and update every invocation surface that can create, display, record, or replay an Interaction:

- runtime messages and command gateway;
- Lua typed runtime API;
- RmlUi runtime bindings;
- authoring test actions and playback;
- debugger/recorder snapshots and invocation events;
- save-state codecs and validation;
- sandbox/demo harnesses;
- test fixtures.

Callers that do not support hotspot initiation must continue emitting `hotspot: null`; they must not
invent a default hotspot.

Recorded semantic actions store `ActivateHotspotInput`, not pointer coordinates. Any changed
versioned preview/debugger/test-playback protocol must receive its own current-version bump and
schema-policy inventory update in the same phase; an optional field added under an existing protocol
version is forbidden. Every unversioned debug display DTO that already projects an Interaction
invocation must add the nullable hotspot projection; unrelated display DTOs remain unchanged.

## 8. Authoring dependency graph and command behavior

### 8.1 Graph nodes and edges

Represent nested Room and Interactable hotspots as graph-addressable semantic owners. Add typed edges
for:

- hotspot to source image through its owner presentation;
- hotspot condition dependencies;
- hotspot to activation Verb;
- Room hotspot to Room exit;
- hotspot to custom highlight Material;
- Interaction hotspot context to exact hotspot owner;
- hotspot Material closure to Shader and static Material texture dependencies.

Graph projections used by Find Usages, delete preflight, compiler linking, and focused impact must
include these edges. Update field metadata hashes and exact graph-effect declarations.

Hotspot edits do not invalidate or extend focused Room preview version 2 because that preview does
not consume hotspots. They do invalidate the React editor projection, compiler output, Play preview,
graph usages, and any runtime-package build derived from the project.

### 8.2 Delete and rename behavior

Deleting a hotspot referenced by an Interaction rule is blocked in V1. The user must first update or
delete those rules; no automatic delete-and-repair policy is implemented by this workstream. Silent
deletion that leaves a stale context is forbidden.

Renaming a hotspot ID must atomically rewrite exact Interaction hotspot references in the same project
transaction. Room exit IDs retain their existing rename/delete behavior; Room hotspot exit activation
must participate in those usages.

Deleting or replacing the source image must report hotspot usages. Both Interactable mode-switch
directions preflight every hotspot identity removed by the switch and refuse while exact Interaction
references remain.

### 8.3 Fine-grained commands

Add these exact built-in command IDs rather than relying only on complete-record replacement:

- `room.addHotspot`;
- `room.deleteHotspot`;
- `room.renameHotspot`;
- `room.updateHotspot` for label, condition, activation, `inputOrder`, and highlight policy;
- `room.setHotspotBounds`;
- `room.reorderHotspots` for editor-list array order only;
- `interactable.addHotspot` for Custom mode;
- `interactable.deleteHotspot`;
- `interactable.renameHotspot`;
- `interactable.updateHotspot` for label, condition, activation, `inputOrder`, and highlight policy;
- `interactable.setHotspotBounds` for Custom mode;
- `interactable.reorderHotspots` for editor-list array order only;
- `interactable.setHotspotMode`;
- `room.setPlacementBounds`;
- `room.placeInteractable`;
- `room.moveInteractableToPlacement`;
- `room.detachInteractablePlacement`.

Room commands carry `roomId`; Interactable commands carry `interactableId`; nested edits carry
`hotspotId`. Add commands carry the complete new current hotspot value and reject duplicate IDs.
Update commands replace only their declared fields and validate the complete resulting current
record. `room.updateHotspot` and `interactable.updateHotspot` use the complete
`HotspotCommon`/activation/highlight replacement rather than an open arbitrary patch object.

Retain `room.replaceData` and `interactable.replaceData` for existing non-direct editor forms, but the
hotspot editor and Room composition gestures must use the commands above.

Pointer drags update local React draft state and commit one command on pointer-up. Escape cancels the
draft. Undo/Redo must treat one draw, move, or resize gesture as one history entry.

Cross-record Room placement operations must use one transaction when creating a placement and moving
an Interactable's initial location to it.

Hotspot and placement commands are manual-save project edits, not structural auto-commit commands.
Cross-record rename and placement transactions must declare every affected Room, Interactable, and
Interaction save unit so dirty state, Undo/Redo, recovery overlays, Save, and Save All remain
accurate.

## 9. React editor architecture

### 9.1 Shared image-stage foundation

Create reusable renderer components and pure geometry helpers under
`editor/src/renderer/components/image-stage/` and
`editor/src/renderer/components/hotspots/`.

The stage layers are:

```text
image/background layer
optional alpha-coverage visualization canvas
placed-object image layer
SVG geometry/selection layer
SVG handles and tool feedback layer
```

Editable rectangles, polygon-ready paths/vertices, handles, selection outlines, and pointer targets
belong in SVG. Canvas is used only for default-alpha coverage visualization and must not own
authoritative editable geometry. V1 does not generate a custom-mask preview in the editor.

The pure transform layer must expose forward and inverse conversions among:

- source image pixels;
- source image UVs;
- Room reference normalized coordinates;
- stage CSS pixels;
- current pan/zoom state;
- runtime background-fit rect/UV semantics.

Tests must cover resize, DPR-independent CSS geometry, `cover` crop, `contain` letterbox, `stretch`,
`center` with both smaller and larger native images, pointer clamping, and round-trip tolerances.

The hotspot-authoring canvas always exposes the complete source image. Its initial camera contains
the full image, then user zoom/pan changes only the editor camera. A Room wrapper must draw a
read-only runtime-visible-area guide for the current reference resolution and background fit, but it
must not crop inaccessible source pixels out of the authoring coordinate space. The separate Room
composition stage is the runtime-fit/reference-space surface used for placements.

### 9.2 Reusable `ImageHotspotEditor`

The shared editor must support:

- fit image to available area;
- zoom and pan without changing authored coordinates;
- select hotspot from canvas or list;
- draw rectangle by dragging;
- move rectangle;
- resize from handles;
- clamp geometry to image bounds;
- delete selected hotspot;
- edit ID, label, condition, activation, input order, and highlight policy through the owning wrapper;
- show overlap order and selected region clearly;
- expose a polygon-capable tool/controller interface without implementing polygon authoring;
- display default-alpha coverage for Interactables without writing a project mask asset;
- preserve tool, selection, pan, and zoom as versioned tab view state in both Room and Interactable
  hotspot surfaces.

It must not import Room/Interactable project operations directly. Wrappers provide validated records,
image URL/dimensions, mode capabilities, and commit callbacks.

The reusable view-state payload uses identity `noveltea.editor.hotspot-view`, current version 1, and
this exact shape:

```ts
interface HotspotEditorViewStateV1 {
  schema: 'noveltea.editor.hotspot-view';
  schemaVersion: 1;
  tool: 'select' | 'draw-rect' | 'pan';
  selectedHotspotId: string | null;
  zoom: number;
  panX: number;
  panY: number;
}
```

`zoom` is a multiplier over the current fit-complete-image scale, defaults to `1`, and is clamped to
`[0.1, 16]`. `panX`/`panY` are finite stage CSS pixels relative to the centered fit transform, not
source pixels or UVs. It is tab-scoped editor metadata, never project content. Add it to the
schema-policy inventory. Restore rejects a wrong identity/version, clamps zoom, clamps pan so at
least 32 CSS pixels of the image remain visible on each axis, and clears a selected ID that no longer
exists. Geometry drafts and active pointer captures are never persisted or recovered.

### 9.3 Room editor integration

The Room editor gains a background-hotspot authoring surface using the Room background image and the
shared hotspot editor. It supports multiple hotspots and Room-specific activation controls for Verb
or exit binding.

That hotspot surface edits the complete source image in image UV space. It must show the current
runtime-visible guide for `cover`, `contain`, and both smaller/larger `center` cases, but dragging a
hotspot never writes Room reference coordinates. The Room composition surface below is a different
mode/component and must not reuse placement bounds as hotspot bounds.

The Room editor also gains a React-native composition stage for existing placements and occupants:

- background rendered with the current Room fit mode;
- placement rectangles in Room reference space;
- current Room cast, props, and Interactables resolved from the working project/graph;
- clicking any occupant selects its owning placement; the composition stage's editable transform
  target is always the placement, not an independently offset occupant;
- selection and bounds manipulation of placements;
- drag/resize commits to `RoomPlacement.bounds`;
- place an existing Interactable by atomically creating a dedicated placement and updating its
  initial location;
- move an Interactable to another existing placement through one transaction;
- warn when a placement has multiple occupants;
- expose explicit detach/create-dedicated-placement for an Interactable before moving it without
  moving a shared anchor.

Newly placed Interactables use dedicated placements by default. Shared placements remain supported
but are explicit.

The Place Interactable tool requires the user to select one existing Interactable and drag a
non-zero Room-reference rectangle; V1 does not invent a click-only default size. On pointer-up one
transaction creates a placement ID based on `<interactable-id>-placement` with the normal unique-ID
suffixing rule, uses the dragged bounds, assigns `order` one greater than the current maximum with
`INT32_MAX` saturation, sets `presentation.label` to inline text copied from the Interactable display
name and `presentation.layout` to null, then updates that Interactable's initial location to the new
placement. Moving to an existing placement updates only the location in one transaction.

Resizing or moving a shared placement intentionally moves every occupant. The explicit Detach action
copies the current bounds into a newly generated dedicated placement, gives it the selected
Interactable label and the same order, and updates only that Interactable's initial location. The
editor must not perform this detach implicitly during a drag.

V1 does not add equivalent detach commands for Room cast entries, props, or Characters whose initial
world location points at a placement. Those occupants can select and move their shared placement, or
be reassigned through their existing Room/Character fields. Adding uniform per-occupant detach tools
for those record types is outside this workstream.

The existing focused engine preview remains separate and passive. It is not the selection or drag
surface.

### 9.4 Interactable editor integration

The Interactable editor gains:

- sprite image stage;
- Alpha/Custom hotspot mode selector;
- singular default-alpha hotspot behavior inspector;
- custom hotspot list and rectangle editor;
- warning when the sprite has no alpha channel;
- source image/dimension diagnostics;
- per-hotspot activation and highlight controls.

Changing Alpha to Custom starts with an empty custom list. V1 does not add an automatic full-image or
alpha-bounds conversion action. It must not silently approximate the alpha silhouette with a bounding
box. Both Alpha-to-Custom and Custom-to-Alpha must use the blocking reference preflight defined in
Section 5.3.

### 9.5 Interaction editor integration

The Interaction rule editor must add `hotspot` to its context-kind selector. The editor flow is:

1. select owner kind Room or Interactable;
2. select the owner through the existing searchable record selector;
3. select one hotspot from that owner by label and ID.

The hotspot selector lists only Verb-activated hotspots whose configured Verb equals the rule Verb.
For a Room hotspot the rule must have zero operands. For an Interactable hotspot the rule must have
one compatible operand as defined in Section 5.5. Invalid data inside an already decoded current-
version project remains visible with an actionable diagnostic rather than disappearing from the
field; this does not permit decoding a retired project version. The selected hotspot is a workbench
link to the owner editor and exact hotspot selection target.

Changing a rule Verb, operand, hotspot activation, or Interactable mode does not silently rewrite the
other record. The graph/validator reports the mismatch and blocks compilation until the author edits
or removes the rule.

### 9.6 Editor UI standards

Use shared shadcn/Base UI controls, existing searchable record selectors, Problems-panel diagnostics,
workbench navigation targets, and localized strings. Do not add record-body warning summaries that
duplicate Problems. Hotspot diagnostics must navigate to the exact owner and select the hotspot.

## 10. Runtime derived-resource architecture

### 10.1 No parallel cache

All derived hotspot work is scheduled and retained by existing asset infrastructure. The only new
runtime asset concept is a typed owner-derived custom hotspot-mask resource. It uses the current
request orchestrator, job executor, telemetry, residency accounting, prefetch tickets, demand
promotion, source-generation invalidation, and owner-thread finalization.

There is no filesystem persistence for generated data. Internal stable request identity uses the
typed owner reference and current source generation because the existing orchestrator must coalesce
prefetch and demand and distinguish two owners with different hotspot definitions. No additional
content-hash index or second cache is introduced.

The existing `AssetCacheKey` stable identity is exactly
`hotspot-mask:room:<room-id>` or `hotspot-mask:interactable:<interactable-id>` plus the normal
`AssetSourceGeneration`. The loaded compiled package is immutable within that generation, so no
hotspot hash, image hash, material ID, or persistent lookup table is added. The mask remains a normal
typed residency entry only because the existing orchestrator requires an entry to coalesce and pin
prepared work; its lease is retained by the owning Room/Interactable presentation resource set.

Replacing the loaded source generation invalidates and regenerates owner masks even when dimensions
or geometry happen to be unchanged. V1 deliberately performs no cross-generation content reuse; the
extra generation work is preferable to another hash/index/cache layer.

### 10.2 Default-alpha image preparation

The structured dependency index must derive an immutable per-source-generation image preparation
requirement map before the first production typed image request is submitted. Any image used by a
default-alpha Interactable is marked `retain_alpha_coverage` for the exact canonical
`TextureAssetRequest` produced from that compiled image resource's logical path and authored sampling.
Other sampler variants of the same path do not retain redundant alpha bits.

Use this exact owner-thread contract:

```cpp
struct TexturePreparationRequirements {
    bool retain_alpha_coverage = false;
};

using TexturePreparationRequirementMap =
    std::map<AssetCacheKey, TexturePreparationRequirements>;

core::DiagnosticResult<void>
AssetManager::install_texture_preparation_requirements_on_owner(
    AssetSourceGeneration generation,
    TexturePreparationRequirementMap requirements) noexcept;
```

`StructuredAssetDependencyIndex::build()` computes the map while it has the package, source
generation, image resources, and Interactable definitions. Package binding installs the map before
publishing the collector or allowing mandatory/prefetch/tooling requests. Installation rejects a
wrong generation, duplicate key, or any already-created request/cache entry for a listed key. Package
clear/source-generation replacement clears the prior map together with ordinary source invalidation.

Add `StructuredAssetDependencyIndex::texture_preparation_requirements()` returning a const reference
to its immutable map. `MandatoryAssetGate::bind_package_on_owner()` must build the index into a local
value, install a copy of that map into `AssetManager`, and only then move/copy the index into
`StructuredAssetDependencyCollector`. If installation fails, package binding fails and exposes no
collector.

Change `MandatoryAssetGate::bind_package_on_owner()` from `void` to
`core::DiagnosticResult<void>` and update all callers/tests. On failure it rolls back any candidate,
clears prefetch/collector/package state, leaves the gate unbound, and returns the installation/index
diagnostic. Do not convert this ordering failure into a later missing-lease error.

Each texture preparation snapshots its requirement at request creation. V1 does not implement
in-flight requirement upgrades; the fixed package-binding order makes them unnecessary and avoids
another mutable request-coordination path.

Texture preparation then performs:

```text
read encoded image
decode one RGBA8 base image
scan alpha into compact one-bit occupancy
prepare normal texture/mips
owner-thread texture finalization
retain occupancy in TextureAsset
discard decoded RGBA working bytes
```

The alpha scan must occur on the worker/cooperative preparation path. The retained occupancy is part
of `TextureAsset` residency accounting and is destroyed with that texture asset. Multiple
Interactables using the same image share the same texture and alpha occupancy.

Occupancy layout is fixed: row-major rows, byte stride `(width + 7) / 8`, and least-significant-bit
first within each byte (`1u << (x & 7)`). A bit is set exactly when decoded base-level RGBA8 alpha is
greater than zero. Residency charges exactly `stride * height` bytes plus the owning vector's
measured allocation overhead under the repository's existing accounting convention. No alpha mip
chain is retained.

Extend the existing resident type directly:

```cpp
struct TextureAlphaCoverage {
    std::uint16_t width;
    std::uint16_t height;
    std::uint32_t row_stride_bytes;
    std::vector<std::uint8_t> occupancy_bits;
};

struct TextureAsset {
    // existing fields
    std::optional<TextureAlphaCoverage> alpha_coverage;
};
```

The dimensions equal the resident base texture dimensions and
`occupancy_bits.size() == row_stride_bytes * height`. Ordinary textures store `nullopt`. Do not add
an `AlphaCoverageAsset`, lookup registry, raw pointer cache, or separately pinned lease.

The preparation-requirement map must be installed before texture requests for that source generation.
Do not create separate `with-alpha` and `without-alpha` texture entries. A production bootstrap that
submits a texture before installing requirements is an ordering error with a focused diagnostic/test,
not a reason to add duplicate resource variants.

The occupancy lookup clamps finite UVs to `[0, 1]`, maps with
`x = min(width - 1, floor(u * width))` and the equivalent `y`, and rejects a missing/zero-sized
coverage resource. Non-finite UVs are misses. This exact helper is the only production alpha lookup
path.

### 10.3 Custom hotspot-mask preparation

Add this typed request:

```cpp
struct HotspotMaskRegionInput {
    core::HotspotId hotspot;
    compiled::ImageNormalizedRect bounds;
};

struct HotspotMaskAssetRequest {
    compiled::HotspotOwnerRef owner;
    std::uint16_t width;
    std::uint16_t height;
    std::vector<HotspotMaskRegionInput> regions;
};

struct HotspotMaskAsset {
    compiled::HotspotOwnerRef owner;
    std::uint16_t handle;
    std::uint16_t width;
    std::uint16_t height;
};
```

Extend the existing typed asset interfaces with the same lifecycle shape as other prepared assets:

```cpp
core::Result<AssetRequestHandle<HotspotMaskAsset>, core::Diagnostic>
AssetManager::request_hotspot_mask(const HotspotMaskAssetRequest&, AssetRequestReason) noexcept;

core::Result<PrefetchTicket, core::Diagnostic>
AssetManager::prefetch_hotspot_mask(const HotspotMaskAssetRequest&, PrefetchGenerationId) noexcept;

const AssetLease<HotspotMaskAsset>*
AssetManager::leased_hotspot_mask_on_owner(const HotspotMaskAssetRequest&) const noexcept;
```

Add the corresponding `HotspotMaskAssetLoader`/preparation-task factory, cache-key helper,
`StructuredAssetRequest` variant dispatch, `StructuredAssetLeaseSet` storage, mandatory-group
request/take-ready handling, telemetry classification, and owner-thread destruction. Do not expose a
synchronous production `load_hotspot_mask()` fallback.

`StructuredAssetDependencyIndex::build()` creates exactly one canonical request for each nonempty
custom owner from the compiled owner definition and compiled source-image dimensions. Regions retain
authored array order only for deterministic request diagnostics; raster output is an order-independent
union. The collector copies that immutable request into mandatory/direct-next/adjacent descriptors.

The loader consumes only the request. It does not retain or query `LoadedCompiledPackage`,
`StructuredAssetDependencyIndex`, Room/Interactable definitions, or `AssetSource`. It rasterizes the
request's rectangles into one owner-local binary union mask on a worker or bounded cooperative task
and does not decode/read the source image.

`make_hotspot_mask_cache_key()` uses only owner kind/ID plus the normal source generation. Within one
generation, submitting the same key with dimensions or region data different from the first request
is an internal contract violation that returns a diagnostic; it must not silently coalesce different
requests or add a geometry hash to the key.

Preparation output contains:

- mask dimensions and format;
- tightly owned upload bytes;
- exact temporary and GPU residency cost;
- diagnostics with owner/hotspot context.

Mask dimensions equal the source image dimensions. The logical format is one unsigned 8-bit channel:
`0` outside every custom rectangle and `255` inside at least one. A texel is inside a rectangle when
its center UV `((x + 0.5) / width, (y + 0.5) / height)` satisfies the Section 5.1 containment rule.
Overlap is a union operation and does not consult condition, input order, authored array order, or
Hotspot ID.

The GPU mask is a source-pixel visualization raster, not the authoritative continuous rectangle.
Its edge may differ from analytic CPU containment by at most one-half source texel because coverage
uses texel centers. The custom shader must also clip samples against exact
`engine.hotspot_bounds`; input never uses the rasterized result.

Owner-thread finalization creates a bgfx `R8`, no-mipmap, clamp-nearest texture. Phase 1 must verify
2D sampled `R8` support for every supported renderer backend before mask implementation begins. If a
required backend lacks it, that is a plan blocker requiring one explicit replacement format across
all targets; implementations must not silently choose per-platform encodings. V1 CPU hit testing
remains analytic and does not retain a duplicate CPU mask after finalization.

`HotspotMaskAsset::handle` follows the existing typed-asset invalid-handle convention. The resident
asset stores no upload bytes after successful finalization and exposes no configurable sampler;
hotspot binding always uses clamp-nearest.

If every custom hotspot has `highlight: none`, the dependency collector must not request a GPU mask;
CPU rectangle hit testing remains available. A default or custom highlight material requires the
mask.

### 10.4 Structured dependency closure

Extend `StructuredAssetRequest` with `HotspotMaskAssetRequest`. Dispatch that request exactly when a
custom owner selected by the dependency view has at least one hotspot whose highlight policy is not
`none`. Dependency
selection follows the existing collector's two established Room views:

- mandatory dependencies use the exact `RuntimePresentationSnapshot` passed to
  `MandatoryAssetGate::begin_on_owner()`. During a transition/publication this is the uncommitted
  candidate snapshot, so its Room and enabled/visible Interactables obtain hotspot resources before
  commit; during steady-state replacement it is the proposed replacement snapshot;
- direct-next and adjacent Room dependencies use the compiled Room closure and the existing
  initial-occupant index, without inventing prediction of future mutable Interactable moves.

For either view, the collector must include:

- Room background image/material;
- Room custom hotspot mask when visual highlighting requires it;
- every authored Room hotspot `material` highlight plus its complete Shader and unbound static-texture
  closure;
- the Interactable sprite/material resources selected by that current or predicted view;
- default-alpha image preparation requirement;
- custom Interactable mask when visual highlighting requires it;
- every authored Interactable `material` highlight plus its complete Shader and unbound
  static-texture closure.

Built-in `default` hotspot programs are not structured asset requests. The bgfx renderer loads both
system hotspot programs during renderer initialization beside existing system programs and owns them
until renderer shutdown. A candidate using `default` validates the already-owned mode-appropriate
handle; missing/invalid system handles fail candidate preparation. Prefetch and residency telemetry
must not report them as package assets.

Direct-next prefetch must begin mask generation before Room entry. A later mandatory/demand request
must join or promote the same existing work. Speculative failure remains observable but must not
invalidate the current Room; mandatory failure must block unsafe destination publication through the
existing mandatory gate.

### 10.5 Threaded and cooperative execution

Native/threaded Web/Android preparation runs on the configured job workers. The mask task must never
create bgfx resources or mutate runtime state from a worker.

Cooperative preparation must rasterize at most 64 rows or 256 KiB of final mask bytes per `step()`,
whichever limit is reached first, and then yield. It must not
block a non-threaded Web frame by rasterizing an entire large Room mask in one call. Cancellation
must discard partial bytes and release temporary reservations.

### 10.6 Residency and lifecycle

Current presentation publication pins the source image, optional custom mask, and every authored
highlight Material/Shader/static-texture dependency together through the existing prepared world
resource set; renderer-owned built-in program handles are validated but not represented as asset
leases. Releasing or replacing the presentation releases the asset leases together. After release,
the existing Warm/Cold/LRU policy may retain or evict individual entries; no hotspot-specific
eviction policy is added.

Default alpha bytes are charged to image CPU asset residency. Custom mask uploads are charged to GPU
residency, with generation bytes charged as temporary preparation memory. Shared source images must
not be double-counted when several owner masks reference them.

Telemetry must identify alpha derivation and custom-mask preparation stages and preserve existing
prefetch late/miss/used/unused semantics.

## 11. Shader, material, and highlight rendering contract

### 11.1 Hotspot shader role

Add `hotspot-overlay` to authoring, compiled, and native `ShaderRole`. Materials selected by hotspot
highlight policy must use that role. They are not ordinary `engine-2d` sprite materials and must not
replace the Room background or Interactable base material.

The role and sampler-binding schema are introduced during the atomic project/compiled/material
cutover, not deferred until renderer implementation. Existing v2 material documents explicitly emit
`binding: null` for every ordinary sampler.

### 11.2 Standard sampler bindings

Extend every shader sampler declaration with one required nullable field in the new current
shader/material schema:

```ts
interface ShaderSamplerData {
  name: string;
  type: 'texture2d';
  binding: 'engine.hotspot_image' | 'engine.hotspot_mask' | null;
}
```

The two new bindings are:

- `engine.hotspot_image`;
- `engine.hotspot_mask`.

Static Material texture assignments must not be used to name these runtime-provided textures. The
material binder receives them through explicit hotspot bind inputs. A Material must not assign a
static texture to a sampler whose declaration has a non-null standard binding. Additional unbound
samplers are allowed and must have ordinary Material assignments and prefetch closure.

`engine.hotspot_image` binds the same resident source-image texture handle and authored sampler used
by the owner base visual. `engine.hotspot_mask` binds the owner `R8` mask with clamp-nearest sampling,
no mip selection, and coverage read from the red channel. The binder must not route either binding
through `$draw.texture` or material source strings.

Default-alpha hotspot shaders must declare exactly one `engine.hotspot_image` binding and no
`engine.hotspot_mask` binding. Custom hotspot shaders must declare exactly one of each. Duplicate
standard bindings are invalid. A single authored Material therefore cannot serve both alpha and
custom hotspot modes in V1 unless it is duplicated with mode-compatible Shader interfaces.
Validation must reject incompatible interfaces before runtime publication.

### 11.3 Standard hotspot uniforms

Add these exact standard uniform bindings:

- `engine.hotspot_bounds`: `vec4` containing image-UV `{ x, y, width, height }`; for default alpha it
  is `{ 0, 0, 1, 1 }`;
- `engine.hotspot_hovered`: `bool`;
- `engine.hotspot_pressed`: `bool`;
- `engine.hotspot_image_dimensions`: `vec2` source pixel dimensions;
- `engine.hotspot_mask_dimensions`: `vec2`, equal to source dimensions for custom mode and `{ 0, 0 }`
  for alpha mode.

Existing engine time, pointer, paint dimensions, and raster-scale inputs remain available. The
binding type must match the declared uniform type exactly.

Do not rely on reserved uniform names when a standard binding can express the contract.

### 11.4 Built-in materials

Ship two system fallback hotspot materials/shader programs:

1. `system/fallback/hotspot_alpha`: samples source image alpha and derives a moving border/sheen from
   neighboring alpha samples;
2. `system/fallback/hotspot_custom`: samples the binary owner mask, intersects it with
   `engine.hotspot_bounds`, and derives the same style from neighboring active-rectangle samples.

Both must support premultiplied-alpha composition and the current renderer variants. Built-ins must
be available without author-created Shader/Material records. Add explicit system shader-program enum
entries for alpha and custom hotspot overlays; do not encode their selection through authored
Material lookup. `highlight: default` selects exactly the mode-appropriate system Material ID above.

### 11.5 World overlay draws

World presentation must render highlight overlays only for the current hovered/pressed target and
only when its policy is not `none`.

- Room background hotspot overlays use the exact fitted background rect and UV crop, after the base
  background image but before world-content objects. They reuse the background draw key and use
  sublayer `2` after the existing color sublayer `0` and image sublayer `1`.
- Interactable overlays use the exact Interactable draw rect and full sprite UV, immediately after
  the owning base visual within stable world ordering. They reuse the owner draw key and use
  sublayer `1` after the base Interactable sublayer `0`.
- The overlay must not change hit order or base visual material state.
- Missing required leases must prevent committing the candidate snapshot rather than silently bind
  an unrelated fallback texture.

At most one hotspot overlay is active. While a primary pointer press is captured, the controller does
not hover or render a second target. The captured target may render `pressed = true, hovered = false`
after the pointer leaves it, until movement cancellation, release, or owner invalidation clears the
capture. Pressed state never remains active while an Interaction or navigation Flow executes.

Pointer movement must not republish or mutate `RuntimePresentationSnapshot`. Add this owner-thread
transient value:

```cpp
struct HotspotInteractionVisualState {
    std::optional<compiled::HotspotRef> hovered;
    std::optional<compiled::HotspotRef> pressed;
};
```

`WorldHotspotController` owns this state and passes replacements to the committed world backend
through one explicit update method. The backend validates the refs against its committed prepared
hotspot surfaces and rebuilds only the transient overlay draw/batch. It must not run Room resolution,
request assets, change gameplay state, or reconstruct base world draws on each pointer move. All
declared image/mask/authored-material/static-texture/program resources were already retained or
validated by candidate publication.

## 12. Presentation projection and hit testing

### 12.1 Presentation hotspot values

Extend Room resolution/runtime presentation with immutable hotspot values sufficient for input and
highlighting. The published snapshot must include:

- exact owner/hotspot ref;
- label;
- separately resolved hotspot-condition and activation-availability booleans;
- activation;
- image-relative rectangle or default-alpha marker;
- input order;
- highlight policy/material;
- source image identity and dimensions;
- Interactable placement bounds/order/plane where applicable.

The semantic snapshot type is one flat vector:

```cpp
struct AlphaHotspotShape {};

struct PresentationHotspot {
    compiled::HotspotRef ref;
    std::string label;
    bool condition_eligible;
    bool activation_available;
    std::variant<compiled::VerbHotspotActivation,
                 compiled::RoomExitHotspotActivation> activation;
    std::variant<AlphaHotspotShape, compiled::ImageNormalizedRect> shape;
    std::int32_t input_order;
    compiled::HotspotHighlight highlight;
    AssetId source_image;
    std::uint16_t source_width;
    std::uint16_t source_height;
    std::optional<compiled::RoomPlacementRef> interactable_placement;
    std::optional<compiled::NormalizedRect> interactable_bounds;
    PresentationPlane owner_plane;
    std::int32_t owner_order;
};
```

Room hotspots have no Interactable placement/bounds and use the current Room background as their
owner visual with `owner_plane = WorldBackground` and `owner_order = 0`. Interactable hotspots carry
both placement values plus their existing presentation plane/order. `RuntimePresentationSnapshot` owns
`std::vector<PresentationHotspot> hotspots`. The snapshot contains no leases, GPU handles, hover
state, mask bytes, or renderer-private sort keys.

Definitions remain immutable. Hover and pressed state are transient host/presentation-controller
state and do not enter `SessionState` or save bytes.

The snapshot retains every structurally valid hotspot for a presented owner, including currently
ineligible ones. A Room hotspot is activation-available when its configured Verb availability is true
or, for exit activation, when the selected exit condition is true. An Interactable hotspot is
activation-available when its configured Verb availability is true. `canLeave`, target `canEnter`,
Interaction rule predicates, and program effects are not evaluated to build hover eligibility. Hit
targets require both booleans; release activation rechecks them through `ActivateHotspotInput`.

`WorldPresentationBackend` prepares hotspot resources during the same candidate reconcile as base
world visuals. Its committed frame owns one prepared hotspot surface per owner, containing the
source-image lease, optional owner-mask lease, authored highlight Material/Shader/static-texture
leases, borrowed renderer-owned built-in system program handles for `default` policies, fitted owner
geometry, and immutable target metadata. Candidate failure releases only candidate resources and
preserves the prior complete world/hotspot frame.

The backend exposes an owner-thread `WorldHotspotFrameView` valid only until the next successful
reconcile, reset, or destruction. The view references the committed prepared surfaces and exact world
draw keys; it does not copy GPU resources or acquire resources on pointer events. The
`WorldHotspotController` obtains the current view for each event and stores only refs, pointer state,
host coordinates, and the committed backend generation. It must never retain a raw view or target
pointer across a generation change. Alpha lookup reads occupancy through the committed source-image
lease; custom lookup uses copied rectangle values.

### 12.2 Shared geometry policy

Extract or expose pure world geometry helpers so rendering and hit testing consume the same fitted
rect/UV results. Do not copy the formulas into a second input-only implementation.

For a Room hotspot:

```text
reference pointer
→ test fitted background draw rect
→ map draw position through fitted UV crop
→ background image UV
→ custom rectangle test
```

For an Interactable hotspot:

```text
reference pointer
→ test Interactable placement draw rect
→ sprite image UV
→ alpha occupancy or custom rectangle test
```

Letterboxed areas are not part of the image. Cropped `cover` UVs remain attached to the full source
image, so cropped hotspot portions are naturally unreachable. `center` retains full UVs on a
native-size centered rect; viewport clipping of an oversized rect makes the corresponding outer UV
areas unreachable, while margins around a smaller rect are non-image space.

Hotspot geometry follows the unmodified owner quad and source texture UVs before the owner's base
Material shader executes. Default-alpha hit testing and highlighting use the source texture alpha,
not the final shaded output alpha. Tinting, fragment discard, UV distortion, vertex displacement, or
other authored Material effects do not alter hit geometry in V1; this is the concrete meaning of the
shader-deformed-geometry non-goal in Section 3.

### 12.3 Hit-target ordering

Build backend-neutral immutable hit targets from the committed presentation snapshot. Only owners
that are currently presented, enabled where applicable, visible, and backed by a valid source image
contribute targets. Only hotspots whose condition and activation-availability booleans are true are
selectable; an ineligible overlapping hotspot does not occlude a lower eligible hotspot.

Cross-owner ordering reuses the owner's exact world draw sort tuple
`(plane, family, order, stable_identity, base_sublayer)` from `WorldPresentationBackend`; the tuple
drawn later wins input. Do not reconstruct a reduced plane/order approximation. Within one owner,
higher `inputOrder` wins; when equal, the lexicographically smallest `HotspotId` wins. Room background
hotspots use the image background draw as their owner key; Interactable hotspots use the owning
Interactable base draw key.

The resulting order mirrors visual stacking. Interactable hotspots normally outrank Room background
hotspots because their owner visual is drawn later. Alpha-transparent pixels and ineligible targets
pass through to the next target in this complete order.

World draws that do not own hotspots are pointer-transparent in V1. Characters, props,
environments, actor expressions, and custom-mode Interactable pixels outside every eligible rectangle
do not occlude a lower hotspot merely because they are rendered above it. An Interactable with an
empty custom hotspot list is entirely pointer-transparent. Future authored input-blocking visuals
require a separate explicit contract; do not infer blocking from color alpha or draw bounds.

### 12.4 Pointer lifecycle

Add a world pointer/input controller after RmlUi and mounted Layout admission:

```text
SDL event
→ HostInputRouter projection
→ RmlUi/Layout admission
→ WorldHotspotController
→ hover/press state
→ typed Verb or Room-exit runtime command on valid release
```

Required behavior:

- pointer move updates hover without running gameplay;
- only the primary mouse button and the first active touch pointer can capture; secondary mouse
  buttons and additional concurrent touches are ignored by world hotspots;
- pointer down captures one eligible target and consumes that pointer sequence;
- activation slop is exactly 8 host CSS pixels measured from pointer-down before reference-space
  projection, using Euclidean distance (`dx * dx + dy * dy > 64` cancels), so DPR and reference
  resolution do not change gesture classification;
- once movement exceeds slop, activation is permanently canceled for that pointer sequence, pressed
  visual state clears, and events remain captured until release/cancel;
- pointer up activates only when slop was not exceeded, the captured target still contains the
  release point, and `ActivateHotspotInput` revalidation succeeds;
- pointer up always clears capture and pressed visual state before submitting
  `ActivateHotspotInput`; accepted, rejected, yielding, and failed runtime work never owns pointer
  capture;
- after mouse release, hover is recomputed from the release position against the current committed
  backend generation; if activation synchronously replaces that generation, recomputation uses the
  replacement. Touch clears hover unconditionally;
- leaving the target clears hover but does not retarget an active press; while captured, no other
  hotspot becomes hovered;
- a committed presentation revision that removes or makes the captured target ineligible cancels
  pressed state immediately; hover is recomputed from the last mouse position after every committed
  revision;
- touch has no persistent hover and uses the same capture/activation semantics;
- the RmlUi/Layout admission result is passed explicitly to the world controller. A blocked pointer
  with no world capture clears hover and cannot start capture. If UI becomes blocking during an
  existing world capture, the host delivers a cancel to the world controller so it releases state
  without activation; it must not simply swallow the release and leave capture stuck;
- SDL pointer/touch cancel, window focus loss, window leave during capture, preview/runtime reset,
  and engine shutdown all cancel hover/pressed/capture state without activation;
- a blocked/failed runtime command reports its ordinary diagnostic/outcome without fabricating
  success; pointer state is already clear;
- editor focused Room preview keeps passive input and does not install this controller.

A pointer down that finds no eligible target is not captured or consumed by the world controller.

## 13. Preview, debugger, tests, and tooling boundaries

### 13.1 Focused Room preview

Do not add editor manipulation, hotspot definitions, runtime hotspot input, masks, or hotspot
highlight rendering to the engine focused preview in this workstream. It remains a passive visual of
the existing Room presentation fields. The focused presenter initializes the new internal hotspot
snapshot collections empty. Any later focused-preview hotspot feature requires a separate plan and
an atomic preview-schema decision.

### 13.2 Play preview

Play preview uses the production runtime hotspot path. It must support hover, highlight, activation,
yielding Interaction programs, Room exit navigation, reload/restart, and current asset telemetry.

### 13.3 Debugger and recorder

Invocation/debug records must display owner kind, owner ID, and hotspot ID when present. Recorded
test/playback actions must be able to replay an exact hotspot invocation independently of pointer
coordinates so tests remain stable across viewport sizes. This workstream does not add recorded
pointer-coordinate hotspot actions; UI/input-level pointer tests remain direct host tests.

## 14. Phased implementation

### Phase 1: Characterization and contract fixtures

#### Completion record (2026-08-05)

Status: complete.

Phase 1 introduced no production behavior or schema changes. The current-contract fixture added at
`editor/src/renderer/test/hotspot-phase-one-characterization.test.ts` locks the strict hotspot-free
Room/Interactable authoring shapes, the four Room background-fit vectors already asserted by
`tests/render/world_presentation_tests.cpp`, and normalized Room-placement projection. Existing
focused tests remain the named characterization seams for the other required boundaries:

- compiled wire: `editor/src/renderer/test/compiled-project-wire-v2.test.ts` and
  `editor/src/renderer/test/compiled-project-golden-corpus.test.ts`;
- Interaction selection: `tests/script/typed_interaction_execution_tests.cpp` and
  `editor/src/renderer/test/authoring-interactions.test.ts`;
- persisted Interaction frames: `tests/core/save_state_tests.cpp`;
- texture preparation: `engine/src/render/bgfx/bgfx_typed_asset_loader.cpp`, exercised through the
  asset-manager and renderer test targets;
- structured prefetch and mandatory publication: `tests/assets/structured_prefetch_tests.cpp`;
- world geometry: `tests/render/world_presentation_tests.cpp`;
- dynamic draw textures and material binding: `tests/render/material_binder_tests.cpp`;
- host input admission and reference projection: `tests/host/host_input_router_tests.cpp`.

Versioned contracts and fixtures affected by later phases are: authoring project v2; compiled project
v2; `noveltea.shader-materials.v1`; save state v6; debugger/runtime messages that serialize
Interaction invocation context; authoring-test and test-playback project records; recorded-test draft
and recorder action records; editor hotspot-view tab state (new v1 contract); runtime package
manifest/package fixtures and compiled goldens; Room preview v2 only where fixture records embed
changed Room/asset data (the preview protocol itself remains v2); and shader/material, project
recovery, Web fixture, Android fixture, stage, and package-smoke fixtures. Phase 2 owns the project,
compiled, material, package, and graph cutovers. Phase 6 owns save, invocation-bearing debugger,
test-playback, and recorder cutovers. Phase 3 owns the new editor tab-state contract.

Representative source sizes and exact uncompressed derived-memory costs are fixed as follows:

| Asset class | Dimensions | RGBA8 decode/upload | One-bit alpha occupancy | R8 custom mask |
| --- | ---: | ---: | ---: | ---: |
| character/interactable sprite | 1024 x 2048 | 8,388,608 bytes | 262,144 bytes | 2,097,152 bytes |
| reference background | 1920 x 1080 | 8,294,400 bytes | 259,200 bytes | 2,073,600 bytes |
| 4K background | 3840 x 2160 | 33,177,600 bytes | 1,036,800 bytes | 8,294,400 bytes |

Bootstrap characterization found one valid installation point and one bypass that later work must
close. In normal game startup, `Engine::load_game()` calls
`MandatoryAssetGate::bind_package_on_owner()` after the compiled package is available and before the
first mandatory world request, so package-derived image preparation requirements can be installed
there. `FocusedPreviewPresenter` can issue `TextureAssetRequest` directly without binding a compiled
package. Phase 7 must therefore install generation-scoped image requirements through a shared
pre-request registry used by both package-backed runtime and focused-preview requests; it must not
make alpha coverage depend solely on `MandatoryAssetGate` binding. This is a direct sequencing
constraint, not a blocker, because the shared request path exists before texture task creation.

The repository's supported Linux renderer is bgfx OpenGL; Web and Android use bgfx OpenGLES
auto-detection. bgfx exposes `TextureFormat::R8` for sampled 2D textures on both OpenGL and OpenGLES,
and these targets do not request render-target, storage-image, mip, or filtering capabilities for
the mask. Phase 8 must still perform the normal runtime `bgfx::isTextureValid(0, false, 1,
TextureFormat::R8, flags)` guard before creation and surface an `assets.hotspot_mask.*` diagnostic if
the active device rejects it. No replacement format or platform-specific encoding is required by
the characterized target set.

#### Required work

- Add focused characterization tests for current Room/Interactable schema, compiled wire, Interaction
  selection, save Interaction frames, texture preparation, structured prefetch, world geometry,
  material dynamic textures, and host input admission.
- Add pure editor transform tests that capture current Room background fit and placement semantics.
- Inventory every versioned contract and fixture affected by this plan, including preview/debugger,
  authoring-test playback, recorder, editor tab state, shader/material, package, and save boundaries.
- Record measured representative sprite/background dimensions and expected alpha/mask memory costs.
- Confirm the runtime bootstrap point where image preparation requirements can be installed before
  first typed texture request.
- Verify sampled bgfx `R8` 2D texture support for the Linux, Web, and Android renderer backends used
  by the repository. Record the exact capability evidence in this plan.

#### Exit gate

- No production behavior changes.
- Every later phase has a named test seam.
- Any ordering issue that prevents pre-load preparation requirements is resolved in this plan before
  Phase 7 begins.
- Lack of required cross-platform `R8` support is resolved by one documented replacement format
  before Phase 8; no platform-specific mask formats remain open.

### Phase 2: Atomic project, compiled, material, and graph contract cutover

#### Required work

- Add shared hotspot authoring schemas/types and exact defaults.
- Add Room hotspot arrays and the Interactable alpha/custom mode.
- Replace preview dimensions with required `AssetData.imageMetadata`; update import/reimport using the
  existing Sharp dependency.
- Add `hotspot-overlay`, required sampler `binding`, hotspot sampler/uniform binding enums, and strict
  authoring validation.
- Add strong hotspot IDs/refs and compiled definitions.
- Add hotspot reference forms to Interaction context schema.
- Add width/height to compiled image resources.
- Extend compiler lowering, graph nodes/edges, Find Usages, delete/rename preflight, and blocking mode
  switch behavior.
- Update strict TypeScript/C++ project, compiled-project, and shader/material DTOs, codecs, linker,
  native model, and independent native validation.
- Atomically bump authoring project 2 to 3, compiled project 2 to 3, and replace
  `noveltea.shader-materials.v1` with `noveltea.shader-materials.v2`.
- Rewrite all templates, examples, development fixtures, project recovery fixtures, compiled goldens,
  package metadata fixtures, shader/material fixtures, and negative-version fixtures.
- Update defaults, diagnostics/navigation metadata, graph field hashes/effects, documentation markers,
  and every affected schema-policy inventory row.
- Keep the current v2 behavior for non-hotspot shader roles operational; this is continued current
  functionality, not support for v1 Material documents. Hotspot runtime binding remains Phase 9.

#### Exit gate

- Editor opens and writes only authoring project version 3; version 2 is rejected.
- The only compiler output is compiled project version 3 plus shader/material v2; retired compiled
  version 2 and shader/material v1 are rejected by current native consumers.
- Compiler output preserves all hotspot semantics and exact UV rectangles.
- Room/Interactable records, image metadata, shader sampler bindings, and compiled definitions
  round-trip their exact current shapes without missing-field defaults.
- Graph queries identify activation Verb, exit, Material, source image, and exact hotspot-context
  usages.
- The editor build, compiler goldens, native decoder tests, schema-policy checker, and package smoke
  all pass before Phase 3 begins.

### Phase 3: Shared React image stage and hotspot editor

#### Required work

- Implement pure image/stage/reference transform helpers.
- Implement reusable layered image stage.
- Implement rectangle draw/select/move/resize/delete behavior with local gesture drafts.
- Implement hotspot list/selection and alpha visualization mode.
- Add `noveltea.editor.hotspot-view` version-1 tab state for tool, pan, zoom, and selection in both
  owner editors.
- Add component and interaction tests without Room/Interactable wrappers.

#### Exit gate

- Rectangles remain image-relative across resize, zoom, pan, and DPR changes.
- One drag produces one commit callback.
- No engine preview or project command dependency exists in the shared component.

#### Phase 3 implementation findings and validation

- The reusable image-stage foundation is implemented under
  `editor/src/renderer/components/image-stage/`. Pure helpers now cover source pixels, image UVs,
  stage CSS pixels, Room reference-normalized rectangles, pan/zoom, and the runtime background-fit
  image/visible-UV transforms for `cover`, `contain`, `stretch`, and `center`.
- `ImageHotspotEditor`/`HotspotImageStage` owns image, optional alpha-canvas, placed-object, SVG
  geometry, and SVG handle/tool-feedback layers. Rectangle draw, select, move, resize, delete, pan,
  zoom, and Escape cancellation use local gesture drafts and emit one owner callback only when a
  gesture completes. The shared component imports neither project commands nor engine-preview code.
- The workbench exposes one registered state handle per tab rather than independently composable
  sub-view handles. Therefore the exact `noveltea.editor.hotspot-view` version-1 object is nested in
  each owner tab payload. Room tab state advanced from version 2 to version 3, and Interactable gained
  `noveltea.editor.tab-state.interactable` version 1. Phase 4 must bind its owner wrappers to these
  existing nested objects rather than introduce a second tab-state registration for the same tab.
  This is a direct integration constraint; it does not change Phase 4 feature scope.
- The schema-policy inventory now includes Room tab-state version 3, Interactable tab-state version
  1, and hotspot-view version 1. Wrong hotspot-view identity/version is discarded; restore clamps
  zoom and pan and clears stale selection without persisting gesture drafts.
- Validation completed on 2026-08-05: focused Phase 3/editor integration tests passed (33 tests),
  `pnpm -C editor run check` passed formatting, lint with zero warnings, TypeScript, and schema-policy
  checks, and `pnpm -C editor run test` passed 181 files with 1122 tests (1 file and 4 tests skipped).
  The environment reported Node 22.22.1 while `editor/package.json` requests Node 24.18.0; the complete
  gates nevertheless passed. Existing unrelated React test `act(...)` warnings remain outside this
  phase.

### Phase 4: Room and Interactable hotspot authoring

#### Required work

- Add command-backed hotspot operations and transactions.
- Integrate Room hotspot editor with background image and Room activation controls.
- Integrate Interactable Alpha/Custom modes and custom hotspot editor.
- Integrate exact hotspot context selection and navigation into the Interaction rule editor.
- Add Problems navigation, i18n, record selectors, Material role filtering, and wrong-arity Verb
  filtering/diagnostics.
- Add blocking mode-switch preflight in both directions.

#### Exit gate

- Multiple Room and Interactable custom hotspots can be authored and undone/redone.
- Default alpha remains singular.
- All edits use project commands/save units; no direct project mutation occurs.

#### Phase 4 implementation findings and validation

- The compiled-project contract requires every compiled Verb activation to contain a concrete Verb,
  while the current authoring contract intentionally permits `verb: null` so a newly created hotspot
  can remain visibly incomplete. Shared lowering now preflights every Room and Interactable hotspot,
  reports `hotspot.compiled.unbound_verb` at the exact authoring path, and returns no draft when one is
  unbound. It no longer dereferences a nullable authoring Verb or manufactures a compiled fallback.
  This preserves the existing Phase 6 activation boundary and requires no downstream scope change.
- Exact hotspot Problems navigation reuses the existing workbench reveal-target mechanism. Room and
  Interactable owner editors register target handlers that select the nested hotspot in their
  Phase-3 tab-state payload, while Interaction hotspot fields link through the same owner-specific
  target. No parallel navigation event or editor-local protocol was introduced.
- The Room authoring surface continues to expose the complete source image. Its read-only runtime
  visible-area guide is derived from the Phase-3 `roomBackgroundTransform()` helper using project
  reference resolution, source image dimensions, and the current background fit. The guide therefore
  reflects cover cropping and center clipping without changing hotspot UV coordinates or reusing
  Room placement bounds.
- Searchable owner, Verb, and Material selection reuses the existing command-palette selector item
  source. Owner lists are collection-filtered, hotspot Verbs are additionally arity-filtered, and
  highlight Materials are additionally filtered to the `hotspot-overlay` role. Invalid decoded
  Interaction hotspot selections remain visible until explicitly repaired.
- Room and Interactable hotspot changes use the fine-grained manual-save commands declared by this
  plan. Draw, move, and resize gestures still commit exactly once through the shared Phase-3 stage;
  hotspot rename rewrites exact Interaction references atomically, and deletion or either mode-switch
  direction is blocked while removed hotspot identities remain referenced. Default-alpha mode
  retains exactly one behavior record and Custom mode may remain empty.
- Validation completed on 2026-08-05. Focused compiler, command, diagnostic-navigation, owner-editor,
  and image-stage tests passed. `pnpm -C editor run check` passed formatting, lint with zero warnings,
  TypeScript, and schema-policy checks. `pnpm -C editor run test` passed 182 files with one skipped
  file: 1,134 tests passed and four were skipped. `pnpm -C editor run build` passed Electron
  main/preload/tools packaging, renderer production build, bundle policy, and all prerequisite checks.
  The unpacked editor package was built and `pnpm -C editor run package:smoke` passed every main,
  renderer, preload, packaged-protocol, engine-preview, editor-asset, native-tool, and Sharp check.
  The Linux smoke emitted the existing non-fatal DBus, GLib, GPU, and Sharp/Electron warnings. The
  environment used Node 22.22.1 while `editor/package.json` declares Node 24.18.0; every gate passed.

### Phase 5: React Room composition and placement tools

#### Required work

- Add Room reference-space composition stage over the current background fit.
- Render placement bounds and current cast/prop/Interactable occupants.
- Move/resize placements with one-command gesture commits.
- Atomically place an existing Interactable using a new dedicated placement.
- Add shared-placement warnings and explicit detach/create-dedicated-placement behavior.
- Preserve focused engine preview as a separate passive surface.

#### Exit gate

- Interactable placement can be completed without opening the Interactable tab.
- Shared placement behavior is explicit and tested.
- No preview manipulation protocol was added.

#### Phase 5 implementation findings and validation

- The existing Room placement contract is already reference-normalized, so the composition surface
  can edit `RoomPlacementData.bounds` directly without introducing a second coordinate contract or
  converting through background-image UVs. The stage renders the configured Room background fit as
  passive context while placement geometry remains tied to the full reference viewport.
- `RoomCompositionStage` owns only local pointer gesture drafts. Move and southeast-resize gestures
  publish one `room.setPlacementBounds` command on pointer completion; selection and in-progress
  geometry remain editor-local state. Placement mode similarly keeps the candidate rectangle local
  until pointer-up, clamps reference-normalized coordinates, rejects zero-area commits, and supports
  Escape cancellation. Current cast, prop, and persistent Interactable occupants are rendered as
  placement labels so shared anchors are visible before editing.
- Placing an existing Interactable from the Room editor uses the shared searchable record selector,
  then requires an explicit drag before `room.placeInteractable` atomically creates the dedicated
  placement and updates the Interactable initial location in one undo entry. The remaining command
  boundary is `room.moveInteractableToPlacement` for reassignment and
  `room.detachInteractablePlacement` for explicit dedicated-placement creation. Dedicated creation
  clones the current bounds/order and reassigns only the chosen Interactable; it never silently moves
  the record to `nowhere`.
- The focused engine preview remains the existing passive `DerivedPreviewPane`. Phase 5 added no
  preview command, input, manipulation, or protocol message, and no later-phase runtime behavior was
  implemented.
- New Room-composition copy is localized in `en-US`, `pt-BR`, and the pseudo locale. Validation on
  2026-08-05 passed the focused Phase 5 suites (15 tests), `pnpm -C editor run check`, the full
  editor suite (183 files passed and one skipped; 1,136 tests passed and four skipped), and
  `pnpm -C editor run build`. Existing unrelated React `act(...)` warnings remain. The environment
  used Node 22.22.1 while `editor/package.json` declares Node 24.18.0; all gates passed.
- The 2026-08-05 Phases 4-6 review found the committed Phase 5 implementation had bypassed the
  specified fine-grained command boundary, created hard-coded placement bounds immediately after
  selector choice, and treated detach as `nowhere`. The review replaced those shortcuts with the
  command and gesture model above and added command atomicity, drag/cancel, exact-default, shared
  placement, Room-editor integration, and undo coverage. This finding changes no later-phase scope.

### Phase 6: Hotspot activation, Interaction context, and save-state version 7

#### Required work

- Extend `InteractionInvocationContext` and rule context.
- Implement matching specificity and authoring warnings.
- Implement canonical `ActivateHotspotInput`; keep generic action APIs hotspot-null.
- Implement Room-exit hotspot activation through the selected-exit path.
- Update runtime messages, Lua, RmlUi, tests, playback, debugger, and recorder.
- Atomically bump save state 6 to 7 and every changed versioned preview/debugger/test-playback
  contract identified in Phase 1; update codecs, validation, schema-policy rows, and fixtures.
- Delete the save-state-6 positive decoder path. Retain save-state-6 bytes only in the negative
  rejection fixture; do not add a converter or a `hotspot: null` upgrade rule.

#### Exit gate

- Direct tests can invoke each hotspot type and select the correct rule/program.
- Generic Interactable rules still work.
- Yield/save/restore preserves exact hotspot context.
- Exit hotspot navigation preserves exit transition and lifecycle semantics.
- External callers cannot spoof a hotspot context through generic Verb invocation.

### Phase 7: Alpha coverage in existing image preparation

#### Required work

- Build/install image preparation requirements before first typed request for a source generation.
- Mark only the canonical image request and derive the fixed-layout one-bit alpha occupancy during
  the existing RGBA decode.
- Retain/account occupancy inside `TextureAsset`.
- Add exact UV sampling helpers and tests.
- Extend structured dependency collection for default-alpha Interactable usage.
- Add cancellation, invalidation, telemetry, memory-accounting, threaded, and cooperative tests.

#### Exit gate

- One image decode produces one GPU texture and shared alpha coverage.
- No duplicate texture entry or alpha side-cache exists.
- Multiple Interactables sharing a sprite share the same coverage.
- Texture eviction releases coverage.

#### Phase 7 implementation findings

- The preparation requirement is a task-creation snapshot and is deliberately excluded from
  `TextureAssetRequest` cache identity. Package-backed mandatory/prefetch requests and focused Room
  preview requests install the same generation-scoped requirement before submitting the canonical
  texture request, so no `with-alpha` texture variant or side registry was introduced.
- Focused Room preview manifests previously carried image identity and sampling but no indication
  that a sprite participates in a default-alpha Interactable. The current manifest now carries the
  derived `retainAlphaCoverage` marker for those exact canonical image resources, allowing the
  existing focused-preview request path to obey the same pre-request ordering contract.
- The retained coverage uses the fixed row-major, least-significant-bit-first layout and charges the
  resident vector's measured allocation through prepared-CPU residency accounting. It is owned by
  `TextureAsset`, so ordinary typed texture eviction destroys the coverage without a separate lease
  or invalidation path.
- Exercising the current structured dependency fixture exposed two stale fixture/codec assumptions:
  ad-hoc image resources lacked the now-required dimensions, and strict runtime-package shader
  manifest shape validation omitted the v2 sampler `binding` field already required by the material
  codec. The fixture was updated to current contracts and strict package validation now accepts that
  existing v2 field; no downstream hotspot scope changed.

### Phase 8: Binary custom-mask preparation and prefetch

#### Required work

- Add typed custom hotspot-mask preparation to the existing AssetManager.
- Add deterministic source-resolution binary-union rectangle rasterization.
- Add bounded cooperative row/tile steps and worker-thread execution.
- Add owner-thread bgfx `R8` finalization and destruction.
- Extend structured prefetch/mandatory gates and exact residency accounting.
- Skip masks when all custom hotspots use no highlight.

#### Exit gate

- Direct-next prefetch produces ready custom masks before Room publication in the deterministic test.
- Demand promotes/joins prefetched work.
- Cancellation releases temporary bytes.
- No generated files or separate cache service exist.

#### Phase 8 implementation findings and validation

- Custom masks now use one typed `HotspotMaskAssetRequest`/`HotspotMaskAsset` path through the
  existing request orchestrator, mandatory lease set, prefetch planner, residency manager, telemetry,
  and profiler. The cache identity remains exactly owner kind plus owner ID plus source generation;
  because that identity intentionally excludes dimensions and rectangle payloads, `AssetManager`
  records the first immutable request for each key and rejects any later mismatch before work can
  coalesce. This is the concrete enforcement seam required by the Phase-1 cache contract and does
  not change later-phase scope.
- The structured dependency index retains immutable Room and Interactable definitions so collection
  can construct complete source-resolution mask requests without querying runtime loaders or mutable
  editor state. Room masks use the compiled Room background image dimensions; custom Interactable
  masks use the compiled sprite dimensions. Material highlights remain in the same dependency closure,
  and owners whose custom hotspots are all `none` produce no mask request.
- Preparation rasterizes the binary union at texel centers with half-open normalized rectangles and
  yields after at most 64 rows or 256 KiB of output per step. Cancellation discards the temporary
  vector before owner finalization. The existing orchestrator therefore supplies worker/cooperative
  execution, priority promotion, prefetch-to-demand joining, invalidation, and reservation release;
  no synchronous fallback, generated file, or cache service was introduced.
- Owner-thread finalization validates sampled `R8` support with `bgfx::isTextureValid`, uploads one
  clamp-nearest non-mipmapped texture, charges the measured temporary allocation and exact
  `width * height` GPU residency, and destroys the bgfx handle through the residency-owned owner-thread
  callback. The existing bgfx typed loader is bound as the mask loader alongside texture loading, so
  no parallel renderer resource owner was added.
- Focused tests prove exact 4x4 union bytes, source dimensions, one finalization for prefetch joined by
  demand, cancellation without finalization, residency-owned destruction, all-`none` omission, and a
  direct-next structured prefetch becoming immediately ready in the mandatory publication group.
  Validation completed on 2026-08-05 with the Linux build, focused hotspot-mask and structured-prefetch
  suites, the full asset suite, formatting/policy gates, and the applicable cross-platform builds
  recorded below. No implementation finding required a Phase 9-12 scope or sequencing change.

### Phase 9: Hotspot material binding and built-in overlays

#### Required work

- Consume the Phase-2 `hotspot-overlay` role and standard sampler/uniform bindings in runtime
  resolution and binding.
- Extend material binder for dynamic hotspot image/mask inputs.
- Add built-in alpha and custom hotspot shaders/materials for every renderer variant.
- Add native runtime role/interface validation; editor filtering already exists from Phase 4.
- Reject static Material assignments for bound samplers and retain additional unbound sampler closure.

#### Exit gate

- Default alpha material binds only source image.
- Custom material binds source image plus the binary owner mask and active bounds.
- v2 interface validation distinguishes alpha-compatible and custom-compatible hotspot materials.
- Built-ins render in Linux and Web shader/material tests.

### Phase 10: Presentation hotspot projection and overlay rendering

#### Required work

- Evaluate hotspot conditions in Room presentation resolution.
- Evaluate Verb/exit hover availability and publish immutable Room/Interactable hotspot values,
  including ineligible definitions and separate eligibility booleans.
- Retain mandatory image/mask/authored-material/Shader/static-texture leases and validate required
  built-in system program handles with the world candidate.
- Extract shared fitted geometry used by drawing and hit testing.
- Add the owner-thread transient `HotspotInteractionVisualState` update seam that rebuilds only the
  hotspot overlay draw/batch against a committed world frame.
- Render Room and Interactable hotspot overlays in stable order.
- Preserve candidate atomicity and prior presentation on resource failure.

#### Exit gate

- Presentation tests cover all modes, overlaps, materials, no-highlight, and failed candidates.
- Renderer and geometry tests prove overlay rect/UV identity with owner visuals.
- Replacing hover/pressed state does not republish the snapshot, request resources, or rebuild base
  world draws.

### Phase 11: World hit testing and host pointer activation

#### Required work

- Build deterministic backend-neutral hit targets.
- Add alpha and analytic rectangle hit tests.
- Add world controller after UI/Layout admission.
- Implement exact draw-key ordering, 8-CSS-pixel slop, primary-pointer capture, release containment,
  touch semantics, and presentation-revision invalidation.
- Implement UI-admission cancellation, SDL/window/focus/reset/shutdown cancellation, and hover
  recomputation after committed presentation changes.
- Submit `ActivateHotspotInput` through the normal runtime gateway.
- Keep focused preview passive.

#### Exit gate

- UI prevents world click-through.
- Topmost eligible hotspot wins deterministically.
- Default alpha ignores fully transparent pixels.
- Room background crop/letterbox behavior matches rendering.
- Mouse and touch activate once and only once.

### Phase 12: Cross-platform verification, documentation, and archival

#### Required work

- Run the full automated and manual matrix in Sections 15 and 16.
- Measure alpha/mask preparation time, cooperative step duration, CPU/GPU residency, and prefetch
  late/miss behavior on representative assets.
- Fix every correctness, policy, or material validation issue found.
- Update permanent Room, Interactable, Interaction, Verb, Asset, Shader, Material, rendering, input,
  runtime, editor, export, and package documentation.
- Add a durable verification/certification record with command results and environment limitations.
- Move this completed plan to `docs/archive/plans/` and replace overview links with permanent docs.

#### Exit gate

- Every Definition-of-Done item is verified or explicitly blocked by an environment limitation.
- No active-plan-only architectural knowledge remains undocumented.

## 15. Required test and manual-smoke matrix

### 15.1 Authoring and editor

- Room with zero, one, and multiple hotspots.
- Interactable default alpha and custom modes.
- Multiple overlapping custom hotspots and input-order changes.
- Draw, move, resize, delete, undo, redo, cancel.
- Zoom/pan/resize/DPR coordinate stability.
- Room `cover`, `contain`, `stretch`, and `center` editing transforms.
- Missing image, missing dimensions, wrong asset kind, no-alpha warning.
- Wrong Verb arity, missing exit, missing/wrong-role Material.
- Mode-switch reference preflight.
- Hotspot rename rewriting Interaction context.
- Placement creation/move/shared-placement detach transaction.
- Save-unit dirty state and recovery/current-schema rejection.

### 15.2 Compiler, graph, and schemas

- Version-3 authoring and compiled positive fixtures.
- Version-2 rejection fixtures.
- Graph forward/reverse edges for every hotspot dependency.
- Native malformed bounds/owner/arity/material/binding rejection.
- Exact authored array preservation with semantic priority independent of array order.
- Compiled golden replacement.
- Shader/material v2 acceptance and v1 rejection.
- Save state 7 acceptance and save state 6 rejection.

### 15.3 Assets and prefetch

- Alpha occupancy for transparent, opaque, edge, and one-pixel images.
- Shared sprite coverage across multiple Interactables.
- Texture residency accounting includes alpha bits exactly.
- Custom owner masks differ for owners sharing one image.
- Binary mask texel-center rasterization and overlap union are independent of input order/conditions.
- CPU overlap selection follows owner draw key, `inputOrder`, and `HotspotId` while allowing
  ineligible regions to pass through.
- No-highlight custom owner does not request a mask.
- Direct-next/adjacent prefetch, demand promotion, cancellation, invalidation, and eviction.
- Worker-thread confinement and owner-thread bgfx finalization.
- Cooperative task yields within budget.
- No package mask entries and no filesystem writes.

### 15.4 Interaction, save, and runtime

- Room zero-arity Verb hotspot.
- Room exit hotspot.
- Interactable one-arity Verb hotspot.
- Exact hotspot rule versus generic rule precedence.
- Hotspot conditions and Verb availability changes.
- Yielding Interaction save/restore with hotspot context.
- Missing hotspot on restore rejection.
- Lua/RmlUi/test playback `ActivateHotspotInput` plus generic Verb invocation that remains
  hotspot-null.
- Debugger and recorder representation.

### 15.5 Rendering and input

- Alpha default overlay from source image.
- Custom overlay from image plus binary owner mask and active bounds.
- Per-hotspot default/custom/none policies.
- Room background overlay order.
- Interactable overlay order.
- Same geometry used by renderer and hit tester.
- Alpha holes pass through to lower targets.
- Overlapping owner and hotspot order.
- UI/Layout click admission.
- Primary-pointer capture, exact 8-CSS-pixel slop, release containment, additional-touch rejection,
  and visibility/state changes during press.
- Resize/reference-resolution/DPR behavior.

### 15.6 Manual smoke

Run every scenario below in the editor and Play preview:

1. Import a transparent Interactable sprite, place it in a Room from the Room composition editor, and
   verify transparent pixels do not hover or click.
2. Switch the Interactable to custom mode, draw two overlapping rectangles with different Verbs and
   Materials, and verify the configured priority and behavior.
3. Draw several Room hotspots over a `cover` background, including one partly in the cropped source
   area, and verify only the visible portion is reachable.
4. Bind one Room hotspot to an exit and verify the exit's transition and lifecycle hooks.
5. Bind a custom no-highlight hotspot and verify it remains clickable without a visual overlay.
6. Place two Interactables sharing one sprite but defining different custom hotspots and verify one
   shared source texture with distinct owner masks.
7. Navigate between Rooms repeatedly while observing asset telemetry for prefetch, demand promotion,
   and eventual residency release.
8. Repeat representative input on Linux desktop, threaded Web, non-threaded Web, and Android when the
   environment permits.

## 16. Exact validation commands

Run narrow tests during each phase, then the applicable final commands sequentially while respecting
`CMAKE_BUILD_PARALLEL_LEVEL`:

```sh
pnpm -C editor run format:check
pnpm -C editor run typecheck
pnpm -C editor run check
pnpm -C editor run test
pnpm -C editor run build
pnpm -C editor run check:schema-version-policy
pnpm -C editor run web:fixture
pnpm -C editor run android:fixture
pnpm -C editor run stage
pnpm -C editor run package:smoke

cmake --preset linux-debug
cmake --build --preset linux-debug
cmake --build --preset linux-debug --target format-check
cmake --build --preset linux-debug --target cxx-policy
ctest --test-dir build/linux-debug --output-on-failure

cmake --preset linux-debug-no-threads
cmake --build --preset linux-debug-no-threads
ctest --test-dir build/linux-debug-no-threads --output-on-failure

cmake --preset web-debug
cmake --build --preset web-debug

cmake --preset web-debug-no-threads
cmake --build --preset web-debug-no-threads

cd android
./gradlew :app:assembleDebug
cd ..

git diff --check
```

Use the exact current preset names from `CMakePresets.json` if a planned name changed before the
phase. Record unavailable Android/Web/manual environments precisely rather than claiming coverage.

The four editor fixture/stage/smoke commands above are mandatory after the atomic schema phase and in
the final phase. If an implementation pass changes their names, it must update this command block and
the owning build/export documentation before using replacements.

## 17. Risks and required mitigations

### 17.1 Mask memory for large Room backgrounds

The first implementation uses one source-resolution, no-mipmap binary `R8` texture per
active/prefetched custom owner that needs highlighting. Residency must record exact GPU bytes, and
Phase 12 measurements must include representative
1080p and 4K backgrounds. A lower-resolution/capped mask policy may be introduced only if measured
memory requires it and the plan is updated with exact hit/render alignment semantics before changing
the implementation.

### 17.2 Bootstrap ordering for alpha requirements

Default alpha must not create duplicate texture variants. The package/dependency index must install
image preparation requirements before typed texture requests. Phase 1 must characterize current
startup order; a discovered early request is a blocker for Phase 7 until ownership/order is corrected.

### 17.3 Divergent editor/runtime transforms

Room fit and image UV math can easily drift. Pure fixture vectors must be shared semantically and
tested in both TypeScript and C++. The renderer and runtime hit tester must call one C++ geometry
implementation.

### 17.4 Material interface ambiguity

Do not infer dynamic hotspot samplers from names. Shader/material v2 adds explicit bindings and strict
role/interface validation.

### 17.5 Interaction selection regressions

Hotspot context adds specificity without replacing operand precedence. Characterization and additive
tests must protect all existing generic/exact/wildcard behavior.

### 17.6 Editor performance

Pointer movement must not dispatch project commands or rebuild full records. Local SVG drafts update
at interaction rate; commits occur once per completed gesture. Large Room lists and hotspot lists must
use existing memoized selectors/graph queries rather than scanning the project on every move.

## 18. Completion tracking

- [x] Phase 1: Characterization and contract fixtures
- [x] Phase 2: Atomic project, compiled, material, and graph contract cutover
- [x] Phase 3: Shared React image stage and hotspot editor
- [x] Phase 4: Room and Interactable hotspot authoring
- [x] Phase 5: React Room composition and placement tools
- [x] Phase 6: Hotspot activation, Interaction context, and save-state version 7
- [x] Phase 7: Alpha coverage in existing image preparation
- [x] Phase 8: Binary custom-mask preparation and prefetch
- [ ] Phase 9: Hotspot material binding and built-in overlays
- [ ] Phase 10: Presentation hotspot projection and overlay rendering
- [ ] Phase 11: World hit testing and host pointer activation
- [ ] Phase 12: Cross-platform verification, documentation, and archival

### Phase 2 implementation findings

- **Graph field-effect sequence is positional.** The reviewed graph field metadata sequence preserves
  the existing effect codes for unaffected fields. Retiring asset preview width/height therefore
  required filtering those exact legacy positions and assigning explicit classifications to the new
  Phase 2 hotspot, image-metadata, and shader-binding leaves rather than renumbering the remaining
  sequence. The current fingerprints and graph audit tests lock that result.
- **Exact hotspot runtime context remains intentionally inactive until Phase 9.** Phase 2 adds the
  strict authoring, compiled, native DTO, decoder, linker, and reference shape. Generic runtime
  Interaction matching explicitly rejects the exact-hotspot context so the new variant cannot be
  mistaken for an already-supported predicate before the planned runtime binding work.
- **Mandatory image metadata required repository-wide fixture migration.** Making
  `AssetData.imageMetadata` strict at persisted and IPC boundaries affected import, reimport, audit,
  ComfyUI generation, authoring fixtures, editor recovery/persistence fixtures, compiled-project
  fixtures, package fixtures, and goldens. The migration uses `null` for non-image assets and
  canonical decoded metadata for images; no missing-field default or compatibility reader remains.
- **Shader sampler binding was an atomic TypeScript/native cutover.** The authoring schema, compiler,
  shader/material v2 manifest, native codec/model, renderer declarations, package fixtures, native
  tests, and demo records all require an explicit binding value, including explicit `null` for
  ordinary samplers. Hotspot sampler and uniform semantics are declared and validated now, while
  renderer value/resource binding remains deferred to Phase 9.
- **Semantic validation must remain outside schema construction.** Graph metadata introspects the
  fully constructed authoring schema during module initialization. Importing project-wide semantic
  validation into the shared hotspot schema created an initialization cycle, so strict structural
  parsing remains dependency-light and project-aware ownership, arity, interface, and reference
  checks run in the post-parse authoring validator.

### Phase 2 final validation

- `cmake --build --preset linux-debug`: passed; all native libraries, tools, applications, public
  header probes, and test executables completed.
- `ctest --test-dir build/linux-debug --output-on-failure -R 'compiled_project|material'`: passed,
  26/26 tests, including compiled-project/package decoding and shader/material v2 parsing,
  validation, resolution, export, and renderer-facing material behavior.
- `pnpm -C editor run build`: passed formatting, Electron/main/preload/tool packaging, renderer
  production build, lint with zero warnings, bundle policy, and TypeScript typecheck. The local Node
  runtime was 22.22.1 while the package declares 24.18.0; the command completed successfully.
- `pnpm -C editor run test`: passed 179 files with one skipped file; 1,111 tests passed and four were
  skipped. This includes strict schema, semantic hotspot, graph rename/delete/replacement/mode-switch,
  compiler, exact goldens, shader/material, persistence, export, and package fixture coverage.
- `pnpm -C editor run package:smoke`: passed every packaged application check, including main,
  renderer, preload, packaged protocol and traversal protections, engine preview, editor assets,
  native editor tool, and Sharp. The Linux environment emitted non-fatal DBus/GLib/GPU warnings.
- `pnpm -C editor run check:schema-version-policy`: passed after updating the authoring-project,
  compiled-project, and shader-material-document inventory rows.
- Compiled-project goldens were regenerated from the current compiler and verified byte-for-byte by
  the full golden corpus.

### Phase 6 implementation findings

- **Exact hotspot context is runtime invocation identity, not a caller-supplied matching hint.** The
  generic `RuntimeExecutor::interact` and script/gateway `run_interaction` paths remain hotspot-null.
  Exact context is constructed only through the canonical activation path. Native runtime input,
  Lua `Game.activate_hotspot`, RmlUi `Game.ui.activate_hotspot`, editor preview/debugger controls,
  recorder output, and persisted test playback all route through that path with an owner-qualified
  `HotspotRef`; none can inject hotspot context through generic Verb invocation.
- **Specificity includes typed wildcard strength.** Exact operands outrank wildcard operands;
  `any-character` and `any-interactable` outrank `any-subject`; exact hotspot context then outranks
  generic context; declaration order remains the final deterministic tie-break. Direct runtime
  coverage now exercises the typed-wildcard/any-subject boundary in addition to exact operands.
- **The resolved Room presentation is the existing activation admission boundary.** Interactable
  activation can validate active-Room ownership plus current enabled/visible state against the
  existing `RoomPresentationResolution`; Room hotspot ownership is validated against the active
  Room. Phase 10 still owns immutable hotspot projection, hover eligibility, and overlay publication,
  and Phase 11 still owns pointer hit testing, so their scope and sequencing did not change.
- **Room-exit hotspots reuse canonical navigation without a parallel flow.** Activation resolves the
  authored hotspot and calls the existing `navigate(RoomExitId)` path. The resulting
  `RoomTransitionFrame` therefore retains the exact selected-exit reference and existing exit
  condition, transition, and lifecycle processing.
- **The editor runtime protocol has one shared version across runtime input, playback, and debugger
  snapshots.** Adding `ActivateHotspotInput` and exact hotspot projection required an atomic protocol
  v1-to-v2 cutover. The test-playback producer, native decoder, fixtures/tests, and schema-policy
  inventory now agree on v2; no same-version optional compatibility field was added.
- **Save restoration validates durable identity, not transient eligibility.** Save state v7 persists
  explicit `hotspot: null` for generic invocations or an exact owner-qualified hotspot reference.
  Linking verifies owner kind, hotspot identity, activation Verb, and canonical operands while not
  requiring the owner to remain currently visible or enabled, allowing a yielded interaction to
  restore after its initiating world state changes.

### Phase 6 final validation

- `cmake --build --preset linux-debug`: passed for all native libraries, applications, tools, public
  header probes, and test executables.
- Focused native hotspot, generic-Interaction, runtime-protocol, and save-state-v7 tests passed,
  including Room Verb, Interactable Verb, Room exit, selected rule/program, non-spoofing generic
  invocation, strict protocol-v1 rejection, exact save round-trip, stale-reference rejection, Verb
  mismatch rejection, and save-state-v6 rejection.
- `pnpm -C editor run check:schema-version-policy`: passed with editor playback v2 and save state v7
  as the sole current contract versions.
- `pnpm -C editor run test -- src/renderer/test/test-playback-project.test.ts
  src/renderer/test/authoring-interactions.test.ts`: passed the focused playback and Interaction
  authoring suites.
- `clang-format --dry-run --Werror` passed for every Phase 6-touched C++ file, and
  `git diff --check` passed. The 2026-08-05 review also applied formatter-equivalent fixes to the four
  inherited hotspot-contract files identified by the repository-wide gate; `cmake --build --preset
  linux-debug --target format-check` now passes.
- The review completed the external activation boundary that the original Phase 6 delta had left
  only at the executor/runtime-message level. Lua, RmlUi, native/web editor preview transport,
  manual debugger controls, recorder lowering, authoring-test editing, semantic validation, and
  playback lowering now preserve exact hotspot identity end-to-end. Focused editor coverage passed
  39 tests, direct native activation/specificity coverage passed, the full editor suite passed 184
  files with one skipped file (1,139 tests passed and four skipped), and the editor preview WASM
  build passed.
- Native review validation exposed stale repository smoke inputs rather than a later hotspot design
  dependency: compiled-runtime and layout-realizer fixtures still declared shader/material v1, the
  staged runtime package did not depend on the current compiled-project golden, and sandbox smoke
  tests did not use the available Xvfb wrapper. The fixtures/staging dependency/smoke wrapper were
  updated to current contracts. This does not change Phase 7 or later implementation scope.
- Final review validation passed the complete Linux debug build and all 764 non-readback native
  tests. The 18 hardware readback capture/verify tests were excluded because the current headless
  environment cannot initialize the required X11/DRI rendering path; this is an environment
  limitation rather than an unresolved hotspot implementation dependency. Editor schema policy,
  production build, package smoke, formatting, lint, typecheck, full test suite, preview WASM build,
  and `git diff --check` all passed. Package smoke emitted the existing non-fatal Linux
  DBus/GLib/GPU and Sharp/Electron warnings. The local Node runtime remained 22.22.1 while the package
  declares 24.18.0.

## 19. Definition of done

This workstream is complete only when all of the following are true:

- Room and Interactable hotspots support the approved V1 modes and multiple custom regions.
- Custom-empty Interactables remain valid, non-clickable, and may have no sprite.
- The shared React editor is used by both owner editors.
- The Interaction editor authors exact hotspot contexts and links back to the selected owner/hotspot.
- Room placement/manipulation is React-native and command-backed.
- No editor preview manipulation feature was added.
- Focused Room preview remains version 2 and contains no hotspot data or runtime hotspot input.
- Authoring project 3 and compiled project 3 are the only accepted current forms.
- Authoring project 2, compiled project 2, shader/material v1, and save state 6 are rejected with no
  migration, importer, automatic rewrite, compatibility reader, or dual-version path.
- Save state 7 preserves hotspot Interaction invocation context.
- Shader/material v2 explicitly binds hotspot image and mask resources.
- Default alpha coverage is generated once with the shared texture and evicted with it.
- Custom masks are generated through existing prefetch/jobs/residency and are not exported or
  persistently cached.
- Custom masks are binary owner-union `R8` resources; no region slots, identity texture, or
  cross-generation content cache exists.
- Multiple owners sharing one source image do not duplicate the source texture and can still have
  different custom masks.
- CPU hit testing and visual overlays use the same owner geometry.
- UI admission, pointer capture, overlap priority, conditions, and state changes are deterministic.
- Room exit hotspots use canonical selected-exit navigation.
- `ActivateHotspotInput` is the sole semantic hotspot-activation path and generic Verb APIs cannot
  spoof exact hotspot context.
- Interaction rules can match exact hotspots without regressing generic rules.
- Linux, Web threaded/non-threaded, and available Android verification pass.
- Documentation and schema-policy inventory are current.
- The plan is archived with durable verification evidence.
