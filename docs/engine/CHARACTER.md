# Character Component

## Contract

A `CharacterDefinition` is immutable runtime content describing authored identity, dialogue presentation, poses, expressions, and default visual resources. It never contains current on-screen state. A currently presented character is an `ActorState` in `SessionState`.

Character is a property-bearing definition kind. It may `extends` another Character only for declared custom-property lookup. Poses, expressions, dialogue style, and other structural fields do not merge or inherit. Editor categories and tags are unrelated to `extends`.

## Identity and references

`CharacterId`, pose IDs, and expression IDs are stable lowercase kebab-case IDs. Character references are typed by their field. Scene actor cues address scene-local `ActorSlotId` values; each slot references one `CharacterId`, allowing the same definition in multiple slots. Dialogue speaker fields reference `CharacterId` directly.

## Authoring, compiled, and state disposition

- **Authoring V2:** a collection-specific Character record with label/notes as editor metadata, explicit runtime-visible identity/dialogue fields, poses, expressions, optional `extends`, and typed property assignments.
- **Compiled:** `CharacterDefinition`, retained same-type parent ID, validated pose/expression/resource references, and authored property assignments.
- **Mutable:** `ActorState` stores character ID, pose, expression, logical placement, visibility, and completed presentation state. Character property overrides live in `SessionState` by `(PropertyOwnerRef, PropertyId)`.
- **Tooling only:** preview pose/expression, preview background, graph/selection state, categories, tags, colors, and sort keys.

## Runtime rules

Actor cues change `ActorState`; they do not mutate `CharacterDefinition`. Presentation backends consume logical actor state but do not own it. Save data contains only the logical actor state needed to restore gameplay; renderer resources, transitions, and tween internals are excluded.

## Current implementation scaffold

The editor currently has typed Character authoring, validation, editing, and preview in:

```text
editor/src/shared/project-schema/authoring-characters.ts
editor/src/shared/project-schema/character-project.ts
editor/src/renderer/editors/characters/CharacterEditor.tsx
editor/src/renderer/project/character-operations.ts
```

The V2 editor schema keeps immutable Character identity, dialogue presentation, poses, expressions,
and defaults in the authoring record. Preview selection belongs to editor tab state, not authored
runtime content. `CompiledProject` provides the immutable `CharacterDefinition`; `SessionState` owns
`ActorState` and validates every `{ SceneId, ActorSlotId }` against the compiled ActorCue, Character,
pose, and expression before publication. Scene execution produces the typed Scene view.

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
- unique local pose and expression IDs;
- valid default and preview selections;
- valid asset/material references and image-asset suitability;
- valid expression pose restrictions;
- whether the selected preview combination resolves a sprite.

The Character editor currently exposes dialogue display styling, default and preview selectors,
pose and expression lists, sprite/material references, transform data, preview background, and
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
The final typed runtime owns validated live actor state, Scene/Dialogue presentation, and persistence.

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
