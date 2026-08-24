# Character Component

## Contract

A `CharacterDefinition` is immutable runtime content describing authored identity, dialogue presentation, Presentation Profiles, profile-specific Poses, semantic Expressions, optional Appearances, reconstructible idle-loop definitions, default visual selections, owner-local Inventory declarations, and an initial world declaration. The declaration is `Unplaced` or a validated `RoomLocation { RoomId }`, plus enabled and visible defaults. It never contains current on-screen state, Room-local presentation placement, renderer resources, or backend animation phase.

Character is a Property-bearing definition kind and may attach compatible Traits. Trait members remain ordinary Properties; poses, expressions, dialogue style, and other structural fields never merge through Traits. Editor categories and tags are unrelated to Trait attachment.

A declared Character authoring record may attach one same-kind Archetype. Archetype chains contribute immutable Character configuration, Trait attachments, and Property assignments, while `initialWorldState` remains local to the declared Character and is never inherited. The editor resolves effective configuration for editing and preview, and the compiler flattens it into the single `CharacterDefinition`; no Archetype identity or mutable state reaches runtime.

## Identity and references

`CharacterId`, Presentation Profile IDs, profile-local Pose IDs, layer IDs, Expression IDs, Appearance IDs, and idle IDs are stable lowercase kebab-case IDs. Character references are typed by their field. Scene actor cues address scene-local `ActorSlotId` values; each slot references one `CharacterId`, allowing the same semantic Character to have multiple simultaneous visual occurrences with independent Profile/Pose/Expression/Appearance/placement state. Room cast entries and scoped presentation actors likewise have occurrence identity separate from semantic Character identity. Dialogue speaker fields reference `CharacterId` directly and do not duplicate gameplay state.

## Authoring, compiled, and state disposition

- **Authoring:** a collection-specific Character record with label/notes as editor metadata, explicit runtime-visible identity/dialogue fields, one or more Presentation Profiles, profile layer declarations, profile-local Poses, semantic Expressions, optional Appearances, idle definitions, Trait attachments, and typed Property assignments.
- **Compiled:** `CharacterDefinition`, retained Trait attachments, owner-local Inventory declarations, validated Profile/Pose/layer/Expression/Appearance/idle/resource and initial Room references, and authored Property assignments. The compiled format retains the selected schema version; #91 changes the current schema shape without incrementing it.
- **Mutable:** each desired actor occurrence stores its stable presentation key, semantic Character ID, selected Profile, Pose, Expression, optional Appearance and idle ID, logical placement, visibility, and completed-presentation state. Character property overrides remain semantic gameplay state in `SessionState` by `(PropertyOwnerRef, PropertyId)` and are not copied per visual occurrence.
- **Tooling only:** preview Profile/Pose/Expression/Appearance selection, preview background, graph/selection state, categories, tags, colors, and sort keys.

## Runtime rules

Actor cues change desired actor-occurrence state; they do not mutate `CharacterDefinition` or Character gameplay state. An omitted Profile, Pose, Expression, or Appearance selection preserves the current compatible desired value for an existing occurrence; changing Profile falls back to that Profile's default Pose when no Pose is supplied. An explicit Appearance action may clear Appearance. New occurrences start from Character defaults.

Each Presentation Profile declares an ordered list of named layers and an optional semantic role for each layer. A Pose supplies the Profile's base composition for those layers: sprite/material, transform, anchor, scale, and visibility. An Expression supplies sparse per-Profile layer overrides. If the selected Expression has no override set for the active Profile, resolution deliberately falls back to the Character's default Expression for that Profile. Appearance is an independent optional axis whose sparse per-Profile layer overrides are applied after Expression overrides; omitted layer fields leave the previously resolved layer field unchanged. The renderer consumes the resulting ordered layer vector directly, so trivial one-layer and arbitrary multi-layer Profiles use the same path. Material occurrence addressing uses stable layer IDs rather than hard-coded pose/expression sublayers.

Presentation projection resolves the selected Profile/Pose/Expression/Appearance composition and selected idle definition into the immutable runtime snapshot. The world backend realizes `bob`, `sway`, and `pulse` loops against the selected gameplay or unscaled-presentation clock. Save state stores only admitted logical desired state: Profile, Pose, Expression, optional Appearance, optional idle, logical placement, visibility, and occurrence identity/ownership. Layer resources are reconstructed from immutable Character content after load. Loop epoch, phase, resolved renderer resources, transitions, and tween internals are excluded, so a fresh backend restarts reconstructible loops at phase zero.

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
  }>;
  expressions: CharacterExpressionData[];
  appearances: CharacterAppearanceData[];
  idles: CharacterIdleData[];
}
```

A Profile owns its ordered layer vocabulary and its Poses. Each Pose has one composition record per
layer. Expressions and Appearances contain sparse Profile-specific layer overrides. Expression
overrides are applied to the Pose base, then Appearance overrides are applied. Layer order comes from
the selected Pose/Profile composition and is preserved through preview, compiled content, runtime
projection, prefetch, transitions, and rendering.

`defaultCharacterData()` creates a trivial `stage` Profile with one semantic `body` layer, one
`default` Pose, one `neutral` Expression, no Appearance, and no idle. This makes the simplest sprite
Character use exactly the same model as a multi-layer Character.

### Current V1 validation and editor behavior

Current validation checks:

- schema shape and Trait attachment/property compatibility;
- at least one Presentation Profile, at least one Pose per Profile, and at least one Expression;
- unique Profile, Profile-layer, profile-local Pose, Expression, Appearance, and idle IDs;
- complete Pose layer coverage of the owning Profile with no duplicate or unknown layer IDs;
- valid default Profile, default Pose per Profile, default Expression, and optional Appearance/idle selections;
- valid Expression and Appearance Profile/layer override references;
- valid asset/material references and image-asset suitability;
- whether the selected preview composition resolves useful visible layers.

The Character editor exposes dialogue display styling, default and preview selectors, Profile and
layer management, profile-local Poses, Expression overrides, Appearance overrides, idle-loop lists,
sprite/material references, idle kind/amplitude/period/clock, per-layer transform data, preview
background, and validation diagnostics. Destructive edits repair affected defaults and strip stale
Profile/layer overrides rather than leaving dangling presentation references.

Edits use `character.replaceData`, which validates a complete replacement value before patching
`/characters/{characterId}/data`. Creation, rename, duplicate, delete, and metadata operations preserve
typed references, undo/redo, and validation before publication. Trait attachments are ordinary typed
record data validated through the shared Trait/Property contract.

### Current preview, export, and runtime status

`buildCharacterPreviewDocumentData()` emits the current `noveltea.character-preview` document with the
selected Profile/Pose/Expression/Appearance and its ordered resolved layer array, dialogue style,
preview settings, and diagnostics. Its revision includes every referenced Pose/Expression/Appearance
asset hash/path and Material value so dependency changes invalidate preview output. Focused Room
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
