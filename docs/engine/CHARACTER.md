# Character Entity

## Purpose

Character records define visual-novel character metadata for NovelTea projects. A character owns display/dialogue style defaults, poses, expressions, sprite assets, optional material overrides, and preview selection state.

Characters are a new first-class authoring component. The legacy engine did not have an exact equivalent; old dialogue speaker and cutscene behavior are useful workflow references only.

## Current Status

Characters are implemented as a typed authoring collection in the editor. The Character editor supports dialogue style metadata, default pose/expression, preview pose/expression, pose and expression lists, sprite refs, material refs, transform metadata, validation diagnostics, and live engine preview.

There is not yet a dedicated native runtime `CharacterModel` equivalent in the engine core. Current character support is primarily authoring/editor/preview-facing and is expected to feed scene/dialogue runtime systems as those mature.

## Collection

Character records live at:

```json
/characters/{characterId}
```

The record uses the standard authoring record wrapper. Character-specific data lives in `record.data`.

```ts
interface CharacterData {
  kind: 'character';
  displayName: string;
  dialogue: CharacterDialogueStyle;
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

## Identity Rules

Character IDs, pose IDs, and expression IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
iris
pose-default
neutral
surprised
```

Pose and expression IDs are local to the character record. They are not top-level project entity IDs, but they use the same format to keep branch/scene references stable and readable.

## High-Level Model

A character has a default pose and expression. Poses define primary sprite placement/rendering data. Expressions optionally override sprite/material and may be scoped to a pose. The preview state selects a pose/expression combination for editor preview only.

Dialogue style data is stored on the character so dialogue and scene editors can reuse the display name, color defaults, and optional CSS/style class.

## Data Model

### Dialogue Style

```ts
interface CharacterDialogueStyle {
  name: string;
  nameColor: string | null;
  textColor: string | null;
  styleClass: string;
}
```

`name` defaults to the character label. Colors are optional strings. `styleClass` can be used by runtime UI/layout systems.

### Poses

```ts
interface CharacterPoseData {
  id: string;
  label: string;
  sprite: CharacterAssetRef | null;
  material: CharacterMaterialRef | null;
  offset: { x: number; y: number };
  scale: number;
  anchor: { x: number; y: number };
}
```

A pose can provide a sprite image asset and material override. `offset`, `scale`, and `anchor` are editor/runtime placement hints.

### Expressions

```ts
interface CharacterExpressionData {
  id: string;
  label: string;
  poseId: string | null;
  sprite: CharacterAssetRef | null;
  material: CharacterMaterialRef | null;
}
```

If an expression supplies a sprite or material, it overrides the selected pose for preview/runtime resolution. If `poseId` is null, the expression applies to all poses.

## References

Character sprite refs point to assets:

```ts
{ $ref: { collection: 'assets', id: 'iris-neutral-image' } }
```

Character material refs point to materials:

```ts
{ $ref: { collection: 'materials', id: 'character-sprite-material' } }
```

Dialogues and scenes are expected to reference characters as speakers/scene actors. Those references are documented in their own component docs.

## Defaults

`defaultCharacterData()` creates:

- kind `character`;
- display name from the record label;
- dialogue name from the record label;
- null dialogue colors;
- empty style class;
- default pose ID `default`;
- default expression ID `neutral`;
- one pose labeled `Default` with no sprite/material, offset `{ x: 0, y: 0 }`, scale `1`, and anchor `{ x: 0.5, y: 1 }`;
- one expression labeled `Neutral` with no sprite/material and no pose restriction;
- preview set to default/neutral with checker background.

## Validation

Character validation checks:

- `record.data` parses as `CharacterData`;
- character inheritance targets another character when set;
- inherited character exists;
- at least one pose exists;
- at least one expression exists;
- pose IDs are unique;
- expression IDs are unique;
- default pose exists;
- default expression exists;
- preview pose exists;
- preview expression exists;
- pose sprite refs point to existing assets;
- sprite asset data is valid;
- non-image sprite assets produce warnings;
- material refs point to existing materials;
- material data is valid;
- expression `poseId` refers to an existing pose when set;
- selected preview pose/expression has at least one resolved sprite asset, otherwise a warning is emitted.

## Command Behavior

Character-specific command:

- `character.replaceData` for validated full data replacement.

The Character editor currently performs pose/expression edits by creating updated `CharacterData` objects and dispatching `character.replaceData`.

Generic entity commands handle record creation, rename, deletion, metadata edits, duplication, parent assignment, and inheritance relationships.

## Editor Behavior

The Character editor exposes:

- display name;
- dialogue display name/color/style metadata;
- default pose and expression selectors;
- preview pose and expression selectors;
- pose list with ID, label, sprite, material, offset, scale, and delete controls;
- expression list with ID, label, optional pose restriction, sprite, material, and delete controls;
- preview background selection;
- validation summary.

Deleting a pose or expression updates defaults and preview selection to a fallback and clears expression pose restrictions that target a deleted pose.

## Editor Preview

Character preview uses `buildCharacterPreviewDocumentData()` and the `noveltea.character-preview.v1` preview schema. The payload includes:

- character ID and label;
- display name and dialogue style;
- selected pose/expression IDs;
- selected pose payload;
- selected expression payload;
- resolved sprite metadata;
- resolved material metadata;
- preview settings;
- validation diagnostics.

The preview resolves expression sprite/material over pose sprite/material. The revision includes character data plus referenced asset content hashes/paths and material data.

## Runtime Status

There is no dedicated native `CharacterModel` in the current engine core. Character authoring data is expected to feed scene orchestration, dialogue speaker metadata, active text styling, and runtime UI preview systems as those features mature.

At present, character runtime behavior is best described as authoring/editor preview support plus future runtime intent.

## Export / Package Status

Characters are not currently converted into a dedicated runtime character table by `buildAuthoringRuntimeExport()`. Referenced sprite assets and materials may be included only if they are collected through supported export paths or if the export profile includes all project assets.

Scene export will likely become the main path that makes character data runtime-relevant.

## Scripting Status

Character records do not currently define a direct Lua script surface. Scripts may eventually set active character pose/expression through scene/runtime APIs, but that contract is not finalized.

## Relationship To Other Entity Types

Characters depend on assets and materials. Dialogues use characters as speakers/default speakers. Scenes use characters for show/hide/move/pose/expression steps. Layouts can use character dialogue style classes. Tests may eventually assert character/scene state once runtime support exists.

## Legacy Reference Notes

Legacy NovelTea did not expose a direct first-class character entity matching this schema. Study old dialogue speaker fields and cutscene segment behavior only to understand workflow needs.

Do not turn old cutscene or dialogue data shapes into character compatibility requirements.

## Recommended Authoring Patterns

Create one character record per story character. Use stable pose IDs such as `default`, `side`, `closeup`, and stable expression IDs such as `neutral`, `happy`, `angry`, or `surprised`.

Use pose sprites for full-body/base artwork. Use expression sprites for overrides where expression art is separate. Use material overrides only when a pose/expression needs a special render effect.

Keep dialogue style defaults simple and let layouts decide final rendering.

## Current Implementation Files

Primary editor files:

```text
editor/src/shared/project-schema/authoring-characters.ts
editor/src/shared/project-schema/character-project.ts
editor/src/renderer/editors/characters/CharacterEditor.tsx
editor/src/renderer/project/character-operations.ts
editor/src/renderer/commands/builtin-commands.ts
```

Related engine files:

```text
engine/include/noveltea/render/material.hpp
engine/include/noveltea/assets/asset_manager.hpp
engine/include/noveltea/core/runtime_controller.hpp
engine/include/noveltea/core/runtime_ui_view.hpp
```

Useful legacy references:

```text
refs/NovelTea/include/NovelTea/Dialogue.hpp
refs/NovelTea/include/NovelTea/Cutscene.hpp
refs/NovelTea/src/editor/Widgets/DialogueWidget.cpp
refs/NovelTea/src/editor/Widgets/CutsceneWidget.cpp
```

## Known Gaps

- No dedicated native runtime character model exists yet.
- Character export is not implemented as a standalone runtime table.
- Scene/dialogue runtime consumption of character records is still future work.
- No voice profile, Live2D, layered outfit/accessory, or lip-sync model is implemented.
- Material/sprite preview is still basic and editor-preview-focused.

## Future Work

- Define runtime character state as scene playback matures.
- Add scene steps for character pose/expression changes and verify export behavior.
- Add dialogue speaker integration and layout styling hooks.
- Add optional voice profile and Live2D scaffolding when required.
- Add richer previews for layered/animated character art.

## Verification

This doc was written from the current character authoring schema, character preview builder, character operation helper, Character editor, validation aggregator, and related engine asset/material/runtime headers. No build is required for this documentation-only change.
