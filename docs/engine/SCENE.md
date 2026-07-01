# Scene Entity

Scene records define ordered visual-novel orchestration for NovelTea projects. A scene is the authoring entity that coordinates backgrounds, characters, dialogue playback, audio cues, variables, Lua scripts, waits, local branches, layout changes, transitions, and comments.

The current implementation is schema-first and new-format only. The legacy NovelTea cutscene editor is a conceptual reference for authoring workflow, timing flags, preview controls, and segment concepts; it is not a compatibility target, and the new scene schema does not preserve the old cutscene array serialization.

The important design rule is that Scene V1 is an ordered sequence of stable steps. It is not yet a full timeline package, keyframe editor, graph editor, or runtime scene VM. Later timeline or graph views should derive from the ordered step data instead of replacing it prematurely.

## Collection

Scene records live at:

```json
/scenes/{sceneId}
```

The record uses the standard authoring record wrapper:

```ts
interface AuthoringRecordBase {
  id: string;
  label: string;
  description?: string;
  parent?: ReferenceTarget | null;
  inherits?: ReferenceTarget | null;
  tags: string[];
  color?: string | null;
  sortKey?: string | null;
  data: SceneData;
}
```

Scene-specific data lives in `record.data`.

## Identity Rules

Scene IDs, step IDs, and branch choice IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
opening
chapter-1-arrival
start
show-iris
choice-2
fade-to-black
```

The Scene Editor currently generates step and branch choice IDs automatically. Step IDs are not exposed as direct text fields in the V1 inspector because careless ID edits would break branch targets and preview selection.

## High-Level Model

A scene is composed of:

- Scene-level settings.
- Scene-level defaults.
- `steps`: an ordered sequence of scene operations.
- `preview`: editor-only preview state.

```ts
interface SceneData {
  kind: 'scene';
  displayName: string;
  settings: SceneSettingsData;
  defaults: SceneDefaultsData;
  steps: SceneStepData[];
  preview: ScenePreviewData;
}
```

## Sequence Versus Timeline

Scene V1 intentionally stores a plain ordered `steps` array. This keeps the first editor slice practical while the engine schema is still being refined.

The ordered list is suitable for common VN flow:

```text
Step: set opening background
Step: show Iris at center
Step: start intro dialogue
Step: play music
Step: branch on player choice
Step: fade out
```

This is different from a multi-track cinematic timeline:

```text
Track: background keyframes
Track: Iris transform keyframes
Track: audio waveform
Track: script markers
```

NovelTea may eventually add track/keyframe views, but Scene V1 does not store or edit that model yet.

## Scene Data

### Fields

`kind`

Always `scene`.

`displayName`

Human-facing name for the scene. This may differ from the record label.

`settings`

Scene-level playback and handoff settings.

`defaults`

Initial authoring/runtime context before steps are applied.

`steps`

Ordered storage array of scene steps. Array order is semantically meaningful in V1.

`preview`

Editor preview state. This should not be treated as runtime game state.

### Default Scene

Creating a scene through Project Explorer currently produces a minimal typed scene:

```json
{
  "kind": "scene",
  "displayName": "Scene",
  "settings": {
    "fullScreen": true,
    "canFastForward": true,
    "speedFactor": 1,
    "next": null
  },
  "defaults": {
    "background": {
      "asset": null,
      "material": null,
      "color": "#0f172a",
      "fit": "cover"
    },
    "layout": null
  },
  "steps": [
    {
      "id": "start",
      "type": "comment",
      "label": "Start",
      "enabled": true,
      "condition": {
        "enabled": false,
        "source": ""
      },
      "timing": {
        "delayMs": 0,
        "durationMs": 1000,
        "waitForInput": false,
        "canSkip": true
      },
      "autosave": {
        "before": false,
        "after": false
      },
      "background": {
        "asset": null,
        "material": null,
        "color": null,
        "fit": "cover",
        "transition": "fade"
      },
      "character": {
        "character": null,
        "action": "show",
        "poseId": null,
        "expressionId": null,
        "position": "center",
        "offset": {
          "x": 0,
          "y": 0
        },
        "scale": 1,
        "transition": "fade"
      },
      "dialogue": {
        "dialogue": null,
        "startBlockId": null,
        "mode": "play"
      },
      "audio": {
        "asset": null,
        "channel": "sound-effect",
        "action": "play",
        "loop": false,
        "volume": 1,
        "fadeMs": 0
      },
      "variable": {
        "variable": null,
        "operation": "set",
        "value": false,
        "comparison": "equals"
      },
      "script": {
        "source": "",
        "comment": ""
      },
      "wait": {
        "mode": "duration",
        "durationMs": 1000
      },
      "branch": {
        "choices": []
      },
      "layout": {
        "layout": null,
        "action": "show",
        "slot": "overlay"
      },
      "transition": {
        "kind": "fade",
        "durationMs": 1000,
        "color": null
      },
      "comment": {
        "source": ""
      }
    }
  ],
  "preview": {
    "selectedStepId": "start",
    "playback": "from-start",
    "showDisabledSteps": true,
    "background": "dark"
  }
}
```

## Reference Shape

Scene references use the standard `$ref` object shape so the generic reference index can discover scene dependencies automatically:

```json
{
  "$ref": {
    "collection": "characters",
    "id": "iris"
  }
}
```

Scene V1 uses references to these collections:

```text
assets
materials
characters
dialogues
layouts
variables
rooms
scenes
```

The most common references are background/audio assets, background materials, characters, dialogues, layouts, and variables. Rooms and scenes are used by the `settings.next` handoff target.

## Settings

```ts
interface SceneSettingsData {
  fullScreen: boolean;
  canFastForward: boolean;
  speedFactor: number;
  next: SceneNextTarget | null;
}
```

`fullScreen`

Intended runtime hint for whether the scene should take over the game view.

`canFastForward`

Intended runtime hint for whether the scene can be fast-forwarded.

`speedFactor`

Positive playback speed multiplier. Validation rejects non-positive values at the schema level.

`next`

Optional target to hand off to after the scene completes. Current allowed targets are scenes, rooms, and dialogues:

```ts
type SceneNextTarget =
  | { $ref: { collection: 'scenes'; id: string } }
  | { $ref: { collection: 'rooms'; id: string } }
  | { $ref: { collection: 'dialogues'; id: string } };
```

The current Scene Editor does not expose `settings.next` yet. It is schema and validation ready, but the runtime handoff semantics are still incomplete.

## Defaults

```ts
interface SceneDefaultsData {
  background: {
    asset: SceneAssetRef | null;
    material: SceneMaterialRef | null;
    color: string | null;
    fit: 'cover' | 'contain' | 'stretch' | 'center';
  };
  layout: SceneLayoutRef | null;
}
```

Defaults define the initial state before any step is applied. The authoring preview starts with these defaults and then applies visible effects from steps.

`defaults.background.asset`

Optional image asset used as the starting background.

`defaults.background.material`

Optional material applied to the starting background.

`defaults.background.color`

Fallback background color.

`defaults.background.fit`

How the background should fit the viewport. Valid values are `cover`, `contain`, `stretch`, and `center`.

`defaults.layout`

Optional starting layout.

## Steps

Each scene step has common fields and one active payload selected by `type`:

```ts
interface SceneStepData {
  id: string;
  type: SceneStepType;
  label: string;
  enabled: boolean;
  condition: SceneConditionData;
  timing: SceneTimingData;
  autosave: SceneAutosaveData;
  background: SceneBackgroundStepData;
  character: SceneCharacterStepData;
  dialogue: SceneDialogueStepData;
  audio: SceneAudioStepData;
  variable: SceneVariableStepData;
  script: SceneScriptStepData;
  wait: SceneWaitStepData;
  branch: SceneBranchStepData;
  layout: SceneLayoutStepData;
  transition: SceneTransitionStepData;
  comment: SceneCommentStepData;
}
```

Only the payload matching `type` is semantically active. All payload objects are initialized anyway. This keeps full-data replacement simple, preserves draft payload data when changing step type, and avoids destructive resets during early schema iteration.

### Common Fields

`id`

Stable local step ID. Branch choices target this field.

`type`

One of:

```text
background
character
dialogue
audio
variable
script
wait
branch
layout
transition
comment
```

`label`

Human-facing step label. Validation requires a non-empty label.

`enabled`

Whether this step should be included by runtime playback. The authoring preview can show or skip disabled steps depending on preview settings.

`condition`

Lua condition source. Conditions are currently stored and validated, but not executed in authoring preview.

```ts
interface SceneConditionData {
  enabled: boolean;
  source: string;
}
```

`timing`

Timing and input behavior shared by all steps:

```ts
interface SceneTimingData {
  delayMs: number;
  durationMs: number;
  waitForInput: boolean;
  canSkip: boolean;
}
```

`delayMs` and `durationMs` are non-negative. `waitForInput` is a runtime input gate hint. `canSkip` is a runtime skip/fast-forward hint.

`autosave`

Autosave hints around the step:

```ts
interface SceneAutosaveData {
  before: boolean;
  after: boolean;
}
```

Runtime autosave integration is not implemented yet.

## Background Step

A `background` step changes the scene background.

```ts
interface SceneBackgroundStepData {
  asset: SceneAssetRef | null;
  material: SceneMaterialRef | null;
  color: string | null;
  fit: 'cover' | 'contain' | 'stretch' | 'center';
  transition: 'none' | 'fade' | 'cut';
}
```

`asset`

Optional image asset. Validation warns if the referenced asset exists but is not an image.

`material`

Optional material reference.

`color`

Fallback or solid background color.

`fit`

Viewport fit mode.

`transition`

Simple background transition hint.

Current editor fields: asset, material, color, fit, transition.

## Character Step

A `character` step shows, hides, moves, or updates a character.

```ts
interface SceneCharacterStepData {
  character: SceneCharacterRef | null;
  action: 'show' | 'hide' | 'move' | 'pose' | 'expression';
  poseId: string | null;
  expressionId: string | null;
  position: 'left' | 'center' | 'right' | 'custom';
  offset: { x: number; y: number };
  scale: number;
  transition: 'none' | 'fade' | 'slide';
}
```

`character`

Optional character reference. Validation errors if the referenced character is missing.

`action`

Runtime action hint. `show` and `hide` are used by authoring preview to approximate visible characters.

`poseId` and `expressionId`

Optional IDs from the referenced character. Validation warns if the referenced character does not contain the selected pose or expression.

`position`

Coarse placement: `left`, `center`, `right`, or `custom`.

`offset`

Fine local offset in scene coordinates.

`scale`

Positive scale multiplier.

`transition`

Simple character transition hint.

Current editor fields: character, action, pose, expression, position, transition, scale, offset X, offset Y.

## Dialogue Step

A `dialogue` step starts or previews a referenced dialogue.

```ts
interface SceneDialogueStepData {
  dialogue: SceneDialogueRef | null;
  startBlockId: string | null;
  mode: 'play' | 'preview-block';
}
```

`dialogue`

Optional dialogue reference. Validation errors if the referenced dialogue is missing.

`startBlockId`

Optional block ID inside the referenced dialogue. When set, validation errors if the dialogue has no matching block.

`mode`

`play` indicates normal dialogue playback. `preview-block` is a useful editor/debug hint while runtime semantics are still forming.

A scene references dialogue by ID. It does not copy dialogue blocks or dialogue segments into the scene.

Current editor fields: dialogue, start block, mode.

## Audio Step

An `audio` step stores an audio cue.

```ts
interface SceneAudioStepData {
  asset: SceneAssetRef | null;
  channel: 'sound-effect' | 'music' | 'voice' | 'ambient';
  action: 'play' | 'stop' | 'fade-in' | 'fade-out';
  loop: boolean;
  volume: number;
  fadeMs: number;
}
```

`asset`

Optional audio asset. Validation warns if the referenced asset exists but is not audio.

`channel`

Logical audio channel.

`action`

Audio command hint.

`loop`

Looping hint for music or ambient audio.

`volume`

Normalized volume from 0 to 1.

`fadeMs`

Non-negative fade duration.

The authoring preview summarizes audio cues but does not play audio.

Current editor fields: asset, channel, action, loop, volume, fade.

## Variable Step

A `variable` step stores a variable operation.

```ts
interface SceneVariableStepData {
  variable: SceneVariableRef | null;
  operation: 'set' | 'check';
  value: unknown;
  comparison: 'equals' | 'not-equals' | 'greater-than' | 'less-than' | 'truthy' | 'falsy';
}
```

`variable`

Optional variable reference. Validation errors if the referenced variable is missing.

`operation`

`set` stores a new value. `check` is intended for conditional runtime logic, but full check/branch semantics are not final in V1.

`value`

Stored value. The editor currently treats this as a simple input value and does not yet enforce variable type-specific editing.

`comparison`

Comparison operator for `check` semantics.

Current editor fields: variable, operation, comparison, value.

## Script Step

A `script` step stores Lua source.

```ts
interface SceneScriptStepData {
  source: string;
  comment: string;
}
```

`source`

Lua source to run at runtime. Empty script source is a warning for script steps.

`comment`

Author-facing note about what the script does.

The authoring preview never executes script source.

Current editor fields: comment, source.

## Wait Step

A `wait` step represents a time or input pause.

```ts
interface SceneWaitStepData {
  mode: 'duration' | 'input';
  durationMs: number;
}
```

`mode`

`duration` waits for time. `input` waits for player input.

`durationMs`

Non-negative duration used by `duration` mode.

Current editor fields: mode, duration.

## Branch Step

A `branch` step stores local choices that target scene step IDs.

```ts
interface SceneBranchStepData {
  choices: SceneBranchChoiceData[];
}

interface SceneBranchChoiceData {
  id: string;
  label: string;
  targetStepId: string | null;
  condition: SceneConditionData;
  order: number;
}
```

`choices`

List of local branch choices. Choices are sorted and interpreted by runtime later; the editor currently stores explicit `order` values.

`targetStepId`

Local step target. Validation errors if the target is set and no matching scene step exists.

`condition`

Lua condition source for whether the choice is available. Choice conditions are stored and validated, but not executed in authoring preview.

`order`

Non-negative ordering value. Duplicate order values are warnings.

Branch V1 is list-based. There is no visual branch graph yet.

Current editor fields: label, target step, order, condition toggle, condition source.

## Layout Step

A `layout` step shows, hides, or swaps an RmlUi layout.

```ts
interface SceneLayoutStepData {
  layout: SceneLayoutRef | null;
  action: 'show' | 'hide' | 'swap';
  slot: 'hud' | 'dialogue-box' | 'overlay' | 'custom';
}
```

`layout`

Optional layout reference. Validation errors if action is `show` or `swap` and the referenced layout is missing. `hide` can be used without a layout reference.

`action`

Layout command hint.

`slot`

Runtime slot hint.

Current editor fields: layout, action, slot.

## Transition Step

A `transition` step stores simple scene transition data.

```ts
interface SceneTransitionStepData {
  kind: 'fade' | 'cut' | 'dissolve';
  durationMs: number;
  color: string | null;
}
```

`kind`

Transition type.

`durationMs`

Non-negative transition duration.

`color`

Optional transition color.

Current editor fields: kind, duration, color.

## Comment Step

A `comment` step is an authoring-only note.

```ts
interface SceneCommentStepData {
  source: string;
}
```

Comment steps are allowed to be empty. They are useful for planning, section breaks, and schema experiments.

Current editor fields: source.

## Preview Data

```ts
interface ScenePreviewData {
  selectedStepId: string | null;
  playback: 'from-start' | 'from-selected';
  showDisabledSteps: boolean;
  background: 'dark' | 'light' | 'checker';
}
```

`selectedStepId`

The currently selected step in the editor and preview fallback target.

`playback`

Controls authoring preview state approximation. `from-start` walks steps from the beginning through the selected step. `from-selected` only applies the selected step.

`showDisabledSteps`

Whether disabled steps are included in the authoring preview approximation.

`background`

Preview widget background style. The current widget differentiates dark/light enough for authoring preview; checker behavior is represented as a value but not fully styled like a production checkerboard yet.

## Validation

Scene validation is implemented in:

```text
editor/src/shared/project-schema/authoring-scenes.ts
```

Validation returns diagnostics with:

```ts
interface SceneSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}
```

Diagnostics use `category: 'authoring-scenes'`.

### Errors

Errors block `scene.replaceData`.

Current errors include:

- Invalid schema shape.
- Scene inheritance targeting a non-scene collection.
- Missing inherited scene.
- Missing `settings.next` target.
- Missing default background asset, material, or layout reference when set.
- Missing required step label.
- Empty `steps` array.
- Duplicate step IDs.
- Missing active background asset reference.
- Missing active background material reference.
- Missing active character reference.
- Missing active dialogue reference.
- Missing dialogue start block when `startBlockId` is set.
- Missing active audio asset reference.
- Missing active variable reference.
- Duplicate branch choice IDs.
- Empty branch choice labels.
- Missing branch choice target step when `targetStepId` is set.
- Missing active layout reference for `show` or `swap` layout actions.

Some numeric constraints, such as positive speed factor, non-negative durations, audio volume range, and positive character scale, are enforced by zod schema parsing.

### Warnings

Warnings do not block `scene.replaceData`.

Current warnings include:

- Scene next target points to itself.
- Referenced asset data is invalid.
- Referenced material data is invalid.
- Referenced layout data is invalid.
- Referenced variable data is invalid.
- Referenced character data is invalid.
- Referenced dialogue data is invalid.
- Background asset exists but is not an image.
- Audio asset exists but is not audio.
- Character pose ID missing on referenced character.
- Character expression ID missing on referenced character.
- Preview selected step is missing.
- Step condition is enabled but source is empty.
- Script step has no source.
- Branch choice condition is enabled but source is empty.
- Duplicate branch choice order.

## Command Behavior

Scene edits use the command:

```text
scene.replaceData
```

The command is implemented in:

```text
editor/src/renderer/project/scene-operations.ts
```

The operation:

1. Confirms the current document is a NovelTea authoring project.
2. Confirms the scene record exists.
3. Parses the proposed scene data.
4. Runs scene validation.
5. Rejects error diagnostics.
6. Allows warning-only data.
7. Replaces `/scenes/{sceneId}/data` with a JSON patch.

This follows the current Character, Room, and Dialogue editor pattern. It participates in dirty state, undo, redo, and save through the command bus.

Scene V1 uses full-data replacement. More granular commands can be added later if the editor becomes too noisy or if concurrent editing requirements become relevant.

## Editor Behavior

Scene records open in `scene-detail` tabs.

The editor is implemented in:

```text
editor/src/renderer/editors/scenes/SceneEditor.tsx
```

Current editor layout:

- Header with scene record label and ID badge.
- Scene-level settings/defaults panel.
- Ordered step list with add buttons for all step types.
- Embedded scene preview panel.
- Selected step inspector.
- Active payload inspector.
- Diagnostics panel.

Current editor capabilities:

- Create typed scene data through generic `entity.createRecord`.
- Open scenes through the typed `scene-detail` editor.
- Edit display name.
- Edit full-screen, fast-forward, speed factor.
- Edit default background asset, material, color, fit, and default layout.
- Add all V1 step types.
- Select steps.
- Duplicate steps.
- Delete steps except the final step.
- Move steps up/down.
- Edit step label and type.
- Edit enabled state.
- Edit condition enabled/source.
- Edit timing delay, duration, wait-for-input, and can-skip.
- Edit autosave before/after hints.
- Edit active payload fields for every V1 step type.
- Edit branch choice label, target, order, condition enabled/source.
- Show scene diagnostics from validation.
- Pass a `scene-preview` document to `EnginePreview`.

## Editor Quirks

Step reorder is currently Up/Down buttons, not drag-and-drop. This was intentional for V1. The editor stack has dnd-kit available, but a specialized timeline or drag system should wait until the schema and UI needs are more refined.

Changing a step type does not clear payloads for other step types. This is intentional. It preserves draft values when experimenting and keeps the full-data replacement command simple.

Step IDs are generated and not directly editable in the inspector. This avoids accidental breakage of branch targets and preview selection. If direct step ID editing is later needed, it should be implemented as a safe rename operation that rewrites branch choice targets and preview selection.

Branch choices target local step IDs. There is no branch graph. This means complex branching can become difficult to read in V1; a future branch graph can be derived from branch choice targets.

`settings.next` is schema-ready but not exposed by the current Scene Editor. Runtime handoff semantics are not complete yet.

Variable values are edited through a simple input. There is no type-aware variable editor inside scene steps yet.

Source fields commit through the same full-data command path as other editor fields. If editing Lua source becomes too noisy, add draft/local dirty state around `SourceEditor` in a later refinement.

The preview state is stored inside scene data. This is consistent with current Dialogue and Room editor patterns, but it may be separated later if preview-only changes become too noisy for project diffs.

## Preview Behavior

Scene preview uses the preview document kind:

```text
scene-preview
```

The preview schema marker is:

```text
noveltea.scene-preview.v1
```

The preview document builder is implemented in:

```text
editor/src/shared/project-schema/scene-project.ts
```

The preview widget is implemented in:

```text
web/widget.html
```

The widget advertises:

```text
scene-preview-v1
```

The preview builder returns a deterministic authoring approximation. It resolves record metadata, picks the selected step, and constructs a shallow state summary.

The preview document includes:

- `schema`
- `sceneId`
- record label
- display name
- selected step ID
- selected step index
- selected step data
- active payload summary for selected step
- ordered step summaries
- approximated authoring state
- settings
- defaults
- preview settings
- scene diagnostics

### Preview State Approximation

For `preview.playback === 'from-start'`, the preview builder starts from scene defaults and walks from the first step through the selected step.

For `preview.playback === 'from-selected'`, the preview builder applies only the selected step.

The preview approximation currently understands these visible effects:

- Background steps update the background summary.
- Character show/move/pose/expression steps update visible character summaries.
- Character hide steps remove visible character summaries.
- Dialogue steps update the dialogue summary.
- Audio steps append audio cue summaries.
- Variable steps append variable operation summaries.
- Script steps append script comment summaries.
- Layout steps update layout summary.

### Preview Limitations

Authoring preview does not execute runtime behavior.

Current limitations:

- Lua scripts are not executed.
- Conditions are not evaluated.
- Dialogue runtime is not executed.
- Audio is summarized but not played.
- Branch choice execution is not simulated.
- Wait/input timing is not simulated.
- Autosave flags are not executed.
- Transitions are summarized by data, not animated.
- `settings.next` is not executed.
- Preview is not gameplay-accurate; it is an authoring visualization.

## Relationship To Other Entity Types

Assets

Background steps and defaults reference image assets. Audio steps reference audio assets.

Materials

Background defaults and background steps can reference materials.

Characters

Character steps reference characters and optionally choose pose/expression IDs from character data.

Dialogues

Dialogue steps reference dialogue records and optional dialogue block IDs. Dialogue data remains owned by the Dialogue entity.

Layouts

Scene defaults and layout steps reference RmlUi layouts.

Variables

Variable steps reference variable records for set/check operations.

Rooms

Scenes can target rooms through `settings.next`. Room integration is not runtime-complete yet.

Scenes

Scenes can target other scenes through `settings.next`. Self-targets are warnings.

Scripts

Scene conditions, branch choice conditions, and script steps store Lua source. The editor treats source as data and does not execute it.

Audio

Scene audio steps model audio cues in a way that should eventually connect to the engine's audio/track system. The current preview only summarizes cues.

## Legacy Cutscene Notes

The legacy editor files are useful context:

```text
refs/NovelTea/src/editor/Widgets/CutsceneWidget.cpp
refs/NovelTea/src/editor/Widgets/CutsceneWidget.hpp
refs/NovelTea/src/core/Cutscene.cpp
refs/NovelTea/src/core/CutsceneSegment.cpp
refs/NovelTea/src/core/CutsceneTextSegment.cpp
refs/NovelTea/src/core/CutscenePageSegment.cpp
refs/NovelTea/src/core/CutscenePageBreakSegment.cpp
refs/NovelTea/src/core/CutsceneScriptSegment.cpp
```

Useful concepts from the legacy system:

- Ordered cutscene segments.
- Segment insertion after the selected segment.
- Segment reorder in a list model.
- Text/page/page-break/script segment ideas.
- Per-segment delay and duration.
- Wait-for-click and can-skip flags.
- Autosave-before and autosave-after flags.
- Per-segment conditions.
- Script/comment fields.
- Preview play/pause/stop/seek controls.
- Loop selected segment preview.
- Next entity/action selection.

Scene V1 preserves the useful authoring concepts but intentionally uses a new typed schema.

Do not reintroduce legacy serialization or old compatibility constraints when evolving scenes. The old files should answer “what authoring concepts mattered?” rather than “what format must we keep?”

## Recommended Authoring Patterns

Use one scene for a coherent VN sequence or cinematic beat.

Good scene boundaries:

```text
opening-intro
chapter-1-arrival
iris-room-confrontation
ending-good
```

Prefer dialogue steps for conversation content. Do not put long branching dialogue directly into scene script fields. Store conversation structure in Dialogue records and reference those records from scene steps.

Use branch steps for scene-level routing: picking the next local beat, skipping optional animation, or jumping to alternate step sequences.

Use comments to divide long scenes into authoring sections:

```text
Start
Set room mood
Iris enters
Conversation
Choice result
Exit transition
```

Use variables for state changes that need to be visible to project diagnostics and future tooling. Use script steps for behavior that genuinely cannot be represented by typed fields yet.

Use default background/layout for stable scene context. Use steps only for changes from that initial context.

## Current Implementation Files

Schema and validation:

```text
editor/src/shared/project-schema/authoring-scenes.ts
```

Preview document builder:

```text
editor/src/shared/project-schema/scene-project.ts
```

Command operation:

```text
editor/src/renderer/project/scene-operations.ts
```

Generic scene creation wiring:

```text
editor/src/renderer/project/entity-operations.ts
```

Project validation wiring:

```text
editor/src/shared/project-schema/authoring-validation.ts
```

Command registration:

```text
editor/src/renderer/commands/builtin-commands.ts
```

Editor:

```text
editor/src/renderer/editors/scenes/SceneEditor.tsx
```

Workbench registration:

```text
editor/src/renderer/workbench/editor-registry.tsx
editor/src/renderer/workbench/default-editors.tsx
```

Preview target mapping:

```text
editor/src/renderer/components/engine-preview.tsx
```

Preview widget:

```text
web/widget.html
```

Tests:

```text
editor/src/renderer/test/authoring-scenes.test.ts
editor/src/renderer/test/scene-operations.test.ts
editor/src/renderer/test/scene-editor.test.tsx
editor/src/renderer/test/editor-registry.test.tsx
editor/src/renderer/test/preview-protocol.test.ts
```

## Known Gaps

Runtime gaps:

- No runtime scene VM yet.
- No runtime execution of Lua scene scripts.
- No runtime evaluation of conditions.
- No runtime branch choice resolution.
- No scene-to-scene or scene-to-room handoff execution.
- No autosave integration for scene step autosave flags.
- No runtime transition animation from scene data.
- No runtime audio cue execution from scene steps.

Editor gaps:

- No drag-and-drop reorder yet.
- No timeline tracks or keyframes.
- No branch graph view.
- No visual condition builder.
- No type-aware variable value editor.
- No direct safe step rename operation.
- No specialized audio cue browser/track editor.
- No coverage overlay.
- No localization tooling.
- No split local components for `SceneStepList` or `SceneStepInspector` yet; the current implementation is consolidated in `SceneEditor.tsx`.

Preview gaps:

- Preview is deterministic authoring visualization only.
- Preview does not execute runtime systems.
- Preview does not animate transitions.
- Preview does not play audio.
- Preview does not simulate dialogue VM playback.
- Preview does not simulate branch choice selection.

Schema gaps likely to revisit:

- Whether scenes should eventually use nested blocks instead of only a flat step sequence.
- Whether timing belongs on every step or only on time-aware step types.
- Whether payloads should remain all-initialized or move to a discriminated union after the schema stabilizes.
- Whether `settings.next` should target actions as well as entities.
- Whether scene-level branch/control-flow should become a graph entity separate from step order.
