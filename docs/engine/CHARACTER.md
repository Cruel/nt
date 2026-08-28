# Character Component

## Contract

A `CharacterDefinition` is immutable runtime content describing authored identity, dialogue presentation, Presentation Profiles, profile-specific Poses, semantic Expressions, optional Appearances, profile-local animation clips, semantic Gestures, reconstructible idle/automatic-animation definitions, default visual selections, owner-local Inventory declarations, and an initial world declaration. The declaration is `Unplaced` or a validated `RoomLocation { RoomId }`, plus enabled and visible defaults. It never contains current on-screen state, Room-local presentation placement, renderer resources, or backend animation phase.

Character is a Property-bearing definition kind and may declare an ordered set of owner-local typed Properties directly on the Character authoring record. Those Properties belong to the exact Character identity, carry their own type/nullability/enum contract plus concrete authored Value, and do not require a project-wide identity Property declaration. The same Property key may therefore use an unrelated schema on another Character. Characters may also attach compatible Traits; Trait-backed Properties still use the transitional shared identity Property registry until their later migration slice. Poses, expressions, dialogue style, and other structural fields never merge through Traits. Editor categories and tags are unrelated to Trait attachment.

A declared Character authoring record may attach one same-kind Archetype. Archetype chains contribute immutable Character configuration, Trait attachments, and Property assignments, while `initialWorldState` remains local to the declared Character and is never inherited. The editor resolves effective configuration for editing and preview, and the compiler flattens it into the single `CharacterDefinition`; no Archetype identity or mutable state reaches runtime.

## Identity and references

`CharacterId`, Presentation Profile IDs, profile-local Pose and animation-clip IDs, layer IDs, Expression IDs, Appearance IDs, Gesture/cue/event IDs, and idle IDs are stable lowercase kebab-case IDs. Character references are typed by their field. Scene actor cues address scene-local `ActorSlotId` values; each slot references one `CharacterId`, allowing the same semantic Character to have multiple simultaneous visual occurrences with independent Profile/Pose/Expression/Appearance/placement state. Room cast entries and scoped presentation actors likewise have occurrence identity separate from semantic Character identity. Dialogue speaker fields reference `CharacterId` directly and do not duplicate gameplay state.

## Authoring, compiled, and state disposition

- **Authoring:** a collection-specific Character record with label/notes as editor metadata, explicit runtime-visible identity/dialogue fields, one or more Presentation Profiles, profile layer declarations, profile-local Poses and animation clips, semantic Expressions, optional Appearances, semantic Gestures and restricted cue events, idle/automatic-animation definitions, Trait attachments, and ordered owner-local typed Properties with concrete Values.
- **Compiled:** `CharacterDefinition`, retained Trait attachments, owner-local Inventory declarations, validated Profile/Pose/layer/Expression/Appearance/animation/Gesture/idle/resource and initial Room references, authored Property assignments, and exact-owner Property declarations keyed by Character identity plus Property ID. The compiled format retains the already-selected schema version; this owner-local Property extension does not increment it.
- **Mutable:** each desired actor occurrence stores its stable presentation key, semantic Character ID, selected Profile, Pose, Expression, optional Appearance and idle ID, logical placement, visibility, completed-presentation state, and whether that occurrence is currently speaking. Character property overrides remain semantic gameplay state in `SessionState` by `(PropertyOwnerRef, PropertyId)` and are not copied per visual occurrence. Animation frame/loop phase and an in-flight Gesture are not durable Character state.
- **Tooling only:** preview Profile/Pose/Expression/Appearance selection, preview background, graph/selection state, categories, tags, colors, and sort keys.

## Runtime rules

Actor cues change desired actor-occurrence state; they do not mutate `CharacterDefinition` or Character gameplay state. An omitted Profile, Pose, Expression, or Appearance selection preserves the current compatible desired value for an existing occurrence; changing Profile falls back to that Profile's default Pose when no Pose is supplied. An explicit Appearance action may clear Appearance. New occurrences start from Character defaults.

Each Presentation Profile declares an ordered list of named layers and an optional semantic role for each layer. A Pose supplies the Profile's base composition for those layers: sprite/material, transform, anchor, scale, and visibility. An Expression supplies sparse per-Profile layer overrides. If the selected Expression has no override set for the active Profile, resolution deliberately falls back to the Character's default Expression for that Profile. Appearance is an independent optional axis whose sparse per-Profile layer overrides are applied after Expression overrides; omitted layer fields leave the previously resolved layer field unchanged. The renderer consumes the resulting ordered layer vector directly, so trivial one-layer and arbitrary multi-layer Profiles use the same path. Material occurrence addressing uses stable layer IDs rather than hard-coded pose/expression sublayers.

Presentation projection resolves the selected Profile/Pose/Expression/Appearance composition and selected idle definition into the immutable runtime snapshot. The world backend realizes `bob`, `sway`, and `pulse` loops against the selected gameplay or unscaled-presentation clock. Save state stores only admitted logical desired state: Profile, Pose, Expression, optional Appearance, optional idle, logical placement, visibility, and occurrence identity/ownership. Layer resources are reconstructed from immutable Character content after load. Loop epoch, phase, resolved renderer resources, transitions, and tween internals are excluded, so a fresh backend restarts reconstructible loops at phase zero.

### Animation clips and automatic behavior

Animation clips are Profile-local, named finite frame sequences. A frame has a positive duration and sparse layer overrides for sprite, material, offset, scale, anchor, and visibility. A clip may affect one layer or several layers; it does not introduce an animation graph, state machine, skeletal rig, or renderer-owned semantic state. Any layer/field omitted by a frame continues to use the underlying resolved Pose/Expression/Appearance composition.

Profiles may configure automatic `blink` and `speaking` behavior. Each automatic behavior names an animation clip and a semantic layer role. Blink additionally declares the interval before the finite blink clip is replayed. Speaking is activated by the actor occurrence's semantic `speaking` flag and loops the configured finite clip while that flag is true. Speaking takes precedence over blinking for the same occurrence. These clocks and phases are backend-local presentation state: reset/load/reconstruction starts a fresh phase from the immutable Profile configuration rather than persisting a frame index or elapsed loop time.

### Gestures and synchronized cues

A Gesture is a Character-level semantic action with one optional mapping per Presentation Profile. Each mapping selects one Profile-local animation clip, so `desk-slam`, `point`, or similar actions keep one stable semantic Gesture ID even when different Profiles need different sprites or layer compositions. Starting a Gesture creates a typed finite `CharacterGestureOperation` targeted at one stable actor occurrence and bound to exact presentation revisions. During the operation the clip temporarily overrides admitted layers; completion returns immediately to the underlying desired Pose/Expression/Appearance without writing those semantic selections.

Gesture cues are deliberately restricted. A cue may be a typed presentation event or a semantic sound-effect request; it cannot execute Lua, mutate Properties, select dialogue branches, or otherwise call gameplay from the renderer. Cue IDs are tracked per finite Gesture operation and fire only when their authored timestamp is crossed. Cancellation, skipping, target replacement, or backend reconstruction discards un-crossed cues rather than replaying them. Audio cues are routed through the ordinary typed audio operation path as disposable synchronized sound effects, while presentation cues leave the backend as typed presentation facts for higher-level presentation integration.

Dialogue integration should therefore address semantic intent, not frames: Dialogue selects the speaking occurrence and/or requests a Gesture through the Character/Profile resolver. It never chooses a raw renderer frame or installs a callback in the world renderer.

## Current implementation scaffold

The editor currently has typed Character authoring, validation, editing, and preview in:

```text
editor/src/shared/project-schema/authoring-characters.ts
editor/src/shared/project-schema/character-project.ts
editor/src/renderer/editors/characters/CharacterEditor.tsx
editor/src/renderer/project/character-operations.ts
```

The current editor schema keeps immutable Character identity, dialogue presentation, Presentation
Profiles, ordered layer declarations, profile-local Poses, semantic Expressions, optional Appearances,
idle definitions, defaults, owner-local Inventories, and the initial Room/Unplaced world Location in
the authoring record. Preview selection belongs to editor tab state, not authored runtime content.
`CompiledProject` provides the immutable `CharacterDefinition`; `SessionState` owns persistent
`CharacterWorldState` plus Scene `ActorState`. Room cast occurrences supply visual placement separately
from world Location, while Scene actor slots remain presentation-only. Scene execution produces the
typed Scene view.

### Current presentation authoring shape

Character records live under `/characters/{characterId}` and use the shared authoring wrapper.
Character-specific presentation data in `record.data` has this conceptual shape:

```ts
interface CharacterData {
  kind: 'character';
  displayName: string;
  dialogue: {
    name: string;
    nameColor: string | null;
    textColor: string | null;
    styleClass: string;
  };
  defaults: {
    profileId: string;
    expressionId: string;
    appearanceId: string | null;
    idleId: string | null;
  };
  profiles: Array<{
    id: string;
    label: string;
    layers: Array<{ id: string; label: string; role: string | null }>;
    defaultPoseId: string;
    poses: CharacterPoseData[];
    animationClips: CharacterAnimationClipData[];
    automaticAnimations: {
      blink: { clipId: string; role: string; intervalMs: number } | null;
      speaking: { clipId: string; role: string } | null;
    };
  }>;
  expressions: CharacterExpressionData[];
  appearances: CharacterAppearanceData[];
  gestures: CharacterGestureData[];
  idles: CharacterIdleData[];
}
```

A Profile owns its ordered layer vocabulary, Poses, animation clips, and automatic blink/speaking
configuration. Each Pose has one composition record per layer. Expressions and Appearances contain sparse Profile-specific layer overrides. Expression
overrides are applied to the Pose base, then Appearance overrides are applied. Layer order comes from
the selected Pose/Profile composition and is preserved through preview, compiled content, runtime
projection, prefetch, transitions, and rendering.

`defaultCharacterData()` creates a trivial `stage` Profile with one semantic `body` layer, one
`default` Pose, no animation clips/automatic behaviors, one `neutral` Expression, no Appearance,
Gesture, or idle. This makes the simplest sprite
Character use exactly the same model as a multi-layer Character.

### Current V1 validation and editor behavior

Current validation checks:

- schema shape and Trait attachment/property compatibility;
- at least one Presentation Profile, at least one Pose per Profile, and at least one Expression;
- unique Profile, Profile-layer, profile-local Pose, Expression, Appearance, and idle IDs;
- unique animation-clip, Gesture, Gesture-profile mapping, and cue IDs;
- complete Pose layer coverage of the owning Profile with no duplicate or unknown layer IDs;
- valid default Profile, default Pose per Profile, default Expression, and optional Appearance/idle selections;
- valid Expression and Appearance Profile/layer override references;
- valid sparse animation-frame layer/resource overrides and automatic behavior clip/semantic-role references;
- valid Gesture Profile/clip mappings, cue timestamps, and audio cue asset types;
- valid asset/material references and image-asset suitability;
- whether the selected preview composition resolves useful visible layers.

The Character editor exposes dialogue display styling, default and preview selectors, Profile and
layer management, profile-local Poses and animation clips, automatic blink/speaking behavior,
Expression overrides, Appearance overrides, Gesture mappings/cues, idle-loop lists, sprite/material
references, idle kind/amplitude/period/clock, per-layer transform data, preview
background, and validation diagnostics. Destructive edits repair affected defaults and strip stale
Profile/layer overrides rather than leaving dangling presentation references.

Edits use `character.replaceData`, which validates a complete replacement value before patching
`/characters/{characterId}/data`. Creation, rename, duplicate, delete, and metadata operations preserve
typed references, undo/redo, and validation before publication. Trait attachments are ordinary typed
record data validated through the shared Trait/Property contract.

### Current preview, export, and runtime status

`buildCharacterPreviewDocumentData()` emits the current `noveltea.character-preview` document with the
selected Profile/Pose/Expression/Appearance, Profile animation/automatic configuration, Gestures, and
its ordered resolved layer array, dialogue style, preview settings, and diagnostics. Its revision
includes every referenced Pose/Expression/Appearance/animation/Gesture-cue asset hash/path and
Material value so dependency changes invalidate preview output. Focused Room
preview transports the same resolved layered composition instead of rebuilding a legacy two-layer
pose/expression approximation on the native side.

Characters are emitted in the compiled definition table and decoded into the native immutable model.
Room-local cast declarations can select a Character, placement, optional Profile/Pose/Expression/
Appearance/idle overrides, condition, visibility, and order. Scene actor cues support the same visual
axes. Room, Scene, persistent Character, and scoped actor occurrences all resolve through the same
typed actor target while retaining independent stable presentation identity and sharing the semantic
Character's gameplay state.

### Current files and retained gaps

```text
editor/src/shared/project-schema/authoring-characters.ts
editor/src/shared/project-schema/character-project.ts
editor/src/renderer/editors/characters/CharacterEditor.tsx
editor/src/renderer/project/character-operations.ts
editor/src/renderer/commands/builtin-commands.ts
```

Voice profiles, Live2D, skeletal deformation, and lip sync remain intentionally outside this contract.

## Non-goals

Legacy dialogue/cutscene speaker fields are workflow references only. They are not compatibility requirements. This contract does not define Live2D, skeletal rigs, lip sync, or a mutable generic character entity.
