# Character Component

## Contract

A `CharacterDefinition` is immutable runtime content describing authored identity, dialogue presentation, poses, expressions, reconstructible idle-loop definitions, default visual selections, and an initial world declaration. The declaration is `Nowhere` or a validated generic `RoomPlacementRef`, plus enabled and visible defaults. It never contains current on-screen state or backend animation phase.

Character is a property-bearing definition kind. It may `extends` another Character only for declared custom-property lookup. Poses, expressions, dialogue style, and other structural fields do not merge or inherit. Editor categories and tags are unrelated to `extends`.

## Identity and references

`CharacterId`, pose IDs, expression IDs, and idle IDs are stable lowercase kebab-case IDs. Character references are typed by their field. Scene actor cues address scene-local `ActorSlotId` values; each slot references one `CharacterId`, allowing the same definition in multiple slots. Dialogue speaker fields reference `CharacterId` directly.

## Authoring, compiled, and state disposition

- **Authoring V2:** a collection-specific Character record with label/notes as editor metadata, explicit runtime-visible identity/dialogue fields, poses, expressions, idle definitions, optional default idle selection, optional `extends`, and typed property assignments.
- **Compiled:** `CharacterDefinition`, retained same-type parent ID, validated pose/expression/idle/resource and initial-placement references, and authored property assignments. Empty idle collections and absent default idle selections are omitted from canonical wire output.
- **Mutable:** desired actor presentation stores character ID, pose, expression, optional selected idle ID, logical placement, visibility, and completed presentation state. Character property overrides live in `SessionState` by `(PropertyOwnerRef, PropertyId)`.
- **Tooling only:** preview pose/expression, preview background, graph/selection state, categories, tags, colors, and sort keys.

## Runtime rules

Actor cues change desired actor state; they do not mutate `CharacterDefinition`. Presentation projection resolves the selected idle definition into the immutable snapshot. The world backend realizes `bob`, `sway`, and `pulse` loops against the selected gameplay or unscaled-presentation clock. Save format V5 stores only the selected idle ID; loop epoch, phase, renderer resources, transitions, and tween internals are excluded. A fresh backend therefore restarts the loop at phase zero after load or reset.

## Current implementation scaffold

The editor currently has typed Character authoring, validation, editing, and preview in:

```text
editor/src/shared/project-schema/authoring-characters.ts
editor/src/shared/project-schema/character-project.ts
editor/src/renderer/editors/characters/CharacterEditor.tsx
editor/src/renderer/project/character-operations.ts
```

The V2 editor schema keeps immutable Character identity, dialogue presentation, poses, expressions,
idle definitions, and defaults in the authoring record. Preview selection belongs to editor tab state, not authored
runtime content. `CompiledProject` provides the immutable `CharacterDefinition`; `SessionState` owns
`ActorState` and validates every `{ SceneId, ActorSlotId }` against the compiled ActorCue, Character,
pose, expression, and idle before publication. Scene execution produces the typed Scene view.

### Pre-3D authoring shape (historical migration reference)

The former editor schema is retained here only as migration documentation. Character records formerly
live under `/characters/{characterId}` and use the shared authoring wrapper. Character-specific data
is stored in `record.data`:

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
    poseId: string;
    expressionId: string;
  };
  poses: CharacterPoseData[];
  expressions: CharacterExpressionData[];
  preview: {
    poseId: string;
    expressionId: string;
    background: 'transparent' | 'checker' | 'dark' | 'light';
  };
}
```

A pose currently stores a stable local ID, label, optional sprite and material references, offset,
scale, and anchor. An expression stores a stable local ID, label, optional pose restriction, and
optional sprite/material overrides. Expression sprite/material data takes precedence over the
selected pose in the authoring preview.

`defaultCharacterData()` currently creates one `default` pose and one `neutral` expression, sets
both as defaults and preview selections, initializes dialogue colors to null, and uses a checker
preview background. These defaults are current editor behavior; Phase 3 may reshape their storage
without discarding the workflow.

### Current V1 validation and editor behavior

Current validation checks:

- schema shape and same-collection inheritance target validity;
- at least one pose and expression;
- unique local pose, expression, and idle IDs;
- valid default pose, expression, and optional idle selections plus preview selections;
- valid asset/material references and image-asset suitability;
- valid expression pose restrictions;
- whether the selected preview combination resolves a sprite.

The Character editor currently exposes dialogue display styling, default and preview selectors,
pose, expression, and idle-loop lists, sprite/material references, idle kind/amplitude/period/clock,
transform data, preview background, and
validation diagnostics. Deleting a pose or expression repairs defaults/preview selections and clears
expression restrictions that referred to a deleted pose.

Edits use `character.replaceData`, which validates a complete replacement value before patching
`/characters/{characterId}/data`. Creation, rename, duplicate, delete, metadata, and inheritance
operations preserve typed references, undo/redo, and validation before publication.

### Current preview, export, and runtime status

`buildCharacterPreviewDocumentData()` emits the `noveltea.character-preview.v1` document with the
selected pose/expression, resolved sprite/material metadata, dialogue style, preview settings, and
diagnostics. Its revision includes referenced asset hashes/paths and material data so dependency
changes invalidate preview output.

Characters are emitted in the compiled definition table and decoded into the native immutable model.
Room-local cast declarations can select a Character, placement, compatible pose/expression/idle,
condition, visibility, and order. Room and authoritative Character world-state resolution project the
same typed actor target, including the selected reconstructible idle definition.

### Current files and retained gaps

```text
editor/src/shared/project-schema/authoring-characters.ts
editor/src/shared/project-schema/character-project.ts
editor/src/renderer/editors/characters/CharacterEditor.tsx
editor/src/renderer/project/character-operations.ts
editor/src/renderer/commands/builtin-commands.ts
```

Voice profiles, Live2D, layered outfits, and lip sync remain intentionally outside V1.

## Non-goals

Legacy dialogue/cutscene speaker fields are workflow references only. They are not compatibility requirements. V1 does not define Live2D, layered outfits, lip sync, or a mutable generic character entity.
