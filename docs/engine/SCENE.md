# Scene Component

## Contract

Scene is the canonical visual-novel orchestration component; new code never uses Cutscene. A `SceneDefinition` owns immutable metadata and a specialized flat `SceneProgram`. Scene is not a universal command stream, graph VM, keyframe timeline, or polymorphic controller.

Scene may `extends` another Scene only for declared custom-property lookup. Steps, defaults, programs, resources, and continuations remain local and do not merge.

## Program

Authoring V2 uses the strict step union: SetBackground, ActorCue, CallDialogue, ShowText, AudioCue, SetVariable, RunLua, Wait, ConditionalBranch, Choice, SetLayout, Transition, and Comment. Comment is editor-only and removed by compilation. Each step contains only fields valid for its variant, including condition, wait, and safe-point data where meaningful. Stable step IDs support diagnostics and save/resume.

A Scene frame holds the mutable instruction cursor and wait/correlation state. `CallDialogue` pushes a Dialogue frame and resumes at the next Scene step after Return. A final Scene/Dialogue continuation tail-replaces; Room enters Room mode; Return pops; End clears execution and enters Ended mode. Return is invalid for a direct project entrypoint.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Scene record, optional `extends`, typed property assignments, strict ordered steps, and explicit terminal continuation.
- **Compiled:** `SceneDefinition` plus `SceneProgram`, linked typed references, retained parent edge, property assignments, and compiler-marked safe points.
- **Mutable:** Scene `FlowFrame`, actor state, logical waits, visit/history data, and property overrides in `SessionState`.
- **Tooling only:** comments, selected step, timeline/graph coordinates, preview playback/background, categories, tags, colors, and sort keys.

Conditions and Lua text expressions are synchronous. RunLua may yield through an engine-owned handle bound to the Scene frame. Lua coroutine state is never saved. Autosaves occur only at compiler-marked safe points.

## Current implementation scaffold

Current editor schema, validation, preview, operations, and UI live in:

```text
editor/src/shared/project-schema/authoring-scenes.ts
editor/src/shared/project-schema/scene-project.ts
editor/src/renderer/project/scene-operations.ts
editor/src/renderer/editors/scenes/SceneEditor.tsx
```

The current schema is provisional: it initializes inactive payloads, embeds preview state, uses broad references and raw Lua fields, and has legacy-shaped export/runtime gaps. These are scaffolding to replace in Phases 3--7, not contracts to preserve. A transitional Scene V0 export/progression path currently lowers its supported subset through the old cutscene-shaped controller; there is no final typed `SceneProgram` executor yet.

### Current V1 authoring shape

Scene records currently live under `/scenes/{sceneId}` and use the broad shared record wrapper. Their
payload contains scene settings, initial defaults, an ordered step array, and embedded preview state:

```ts
interface SceneData {
  kind: 'scene';
  displayName: string;
  settings: {
    fullScreen: boolean;
    canFastForward: boolean;
    speedFactor: number;
    next: SceneNextTarget | null;
  };
  defaults: {
    background: {
      asset: SceneAssetRef | null;
      material: SceneMaterialRef | null;
      color: string | null;
      fit: 'cover' | 'contain' | 'stretch' | 'center';
    };
    layout: SceneLayoutRef | null;
  };
  steps: SceneStepData[];
  preview: {
    selectedStepId: string | null;
    playback: 'from-start' | 'from-selected';
    showDisabledSteps: boolean;
    background: 'dark' | 'light' | 'checker';
  };
}
```

Scene V1 deliberately uses an ordered stable-ID sequence rather than a keyframe timeline or a graph.
That user-facing model remains useful. Phase 3 changes the storage from one object containing every
possible payload to a strict discriminated union; it does not discard ordered steps, stable IDs, or
the ability to derive timeline/branch visualizations later.

The current step object stores common `id`, `type`, label, enabled, condition, timing, and autosave
fields, plus initialized payload objects for every type. Only the selected payload is semantically
active. This preserves drafts when changing type but also permits invalid combinations and is the
specific behavior the strict V2 union replaces.

### Current V1 step capabilities

The existing editor supports these useful authoring concepts:

| Current type | Current payload and behavior to retain or migrate |
| --- | --- |
| `background` | Asset/material/color/fit plus none/fade/cut transition. |
| `character` | Character ref; show/hide/move/pose/expression; pose/expression IDs; coarse position, offset, scale, transition. |
| `dialogue` | Dialogue ref, optional starting block, play/preview-block mode. Dialogue data remains owned by Dialogue. |
| `audio` | Asset, logical sound-effect/music/voice/ambient channel, play/stop/fade actions, loop, volume, fade duration. |
| `variable` | Variable ref, set/check operation, value, comparison. V2 separates assignment from typed branch conditions. |
| `script` | Lua source and author comment. V2 represents this as explicit `RunLua`. |
| `wait` | Duration or player-input wait. |
| `branch` | Ordered local choices with stable IDs, labels, target step IDs, and conditions. |
| `layout` | Show/hide/swap a Layout in a logical slot. |
| `transition` | Fade/cut/dissolve with duration and optional color. |
| `comment` | Editor-only planning/section note. |

The current generic timing block supplies delay, duration, wait-for-input, and can-skip values to all
steps. The target schema narrows wait/timing fields to the variants for which they are meaningful,
but the workflow requirements—delays, durations, input gates, skippability, and autosave markers—must
not be lost during that narrowing.

`settings.next` currently accepts Scene, Room, or Dialogue refs and is not fully exposed by the
editor. V2 replaces it with the explicit terminal `FlowTarget` semantics documented above.

### Current V1 validation

Current Scene validation rejects malformed data, invalid same-collection inheritance, missing
terminal/default references, empty step arrays, duplicate step IDs, empty labels, missing active
asset/material/Character/Dialogue/Variable/Layout references, invalid Dialogue start blocks,
duplicate branch-choice IDs, empty choice labels, and missing branch targets. Numeric schema checks
also enforce positive speed/scale, nonnegative durations, and normalized audio volume.

Warnings currently cover self-targeting next refs, invalid referenced component payloads, wrong media
asset kinds, missing Character pose/expression IDs, stale preview selection, empty enabled conditions,
empty script source, and duplicate branch-choice order. These diagnostics and their source paths are
valuable compiler requirements even when the underlying schema changes.

### Current command and editor behavior

Scene edits currently use `scene.replaceData`. The operation validates a complete proposed payload,
rejects errors, permits warnings, then patches `/scenes/{sceneId}/data` through the command bus. The
full-replacement granularity may change, but validation-before-publication, undo/redo, dirty tracking,
and deterministic record replacement should remain.

The current editor provides:

- scene settings and initial background/Layout defaults;
- add/select/duplicate/delete/reorder for every current step type;
- common label, enabled, condition, timing, and autosave controls;
- payload editors for background, Character, Dialogue, audio, variable, Lua, wait, branch, Layout,
  transition, and comment data;
- ordered branch choices with local step targets;
- diagnostics and embedded `scene-preview` output.

Reordering currently uses Up/Down controls rather than drag-and-drop. Step IDs are generated and not
directly editable because branch targets and preview selection depend on them. Changing a step type
currently preserves inactive payload drafts. These are deliberate current editor behaviors, not
accidental omissions.

### Current preview behavior

`buildScenePreviewDocumentData()` emits `noveltea.scene-preview.v1`. In `from-start` mode it starts
from scene defaults and applies visible effects through the selected step; `from-selected` applies
only the selected step. The approximation currently tracks background, visible Characters,
Dialogue summary, audio cues, variable operations, script comments, and active Layout.

The preview intentionally does not execute Lua, conditions, Dialogue playback, branch selection,
wait timing, autosaves, audio, transitions, or terminal handoff. It is a deterministic authoring
visualization. That distinction should survive the runtime migration: editor preview may eventually
use the real compiler/executor, but it must not silently pretend unsupported behavior is accurate.

### Current runtime/export bridge

The transitional exporter can lower a safe Scene subset into current `cutscene` records and launch it
through the cutscene-shaped runtime controller. Supported behavior includes text-like steps,
continue/page-break waits, dispatcher-backed Dialogue/Layout hooks, and simple next targets;
unsupported steps produce export diagnostics. This bridge should remain until the typed Scene slice
provides equivalent preview/package execution, then be deleted together with Cutscene terminology.

### Current files and retained gaps

```text
editor/src/shared/project-schema/authoring-scenes.ts
editor/src/shared/project-schema/scene-project.ts
editor/src/renderer/project/scene-operations.ts
editor/src/renderer/editors/scenes/SceneEditor.tsx
editor/src/shared/project-schema/authoring-runtime-export.ts
editor/src/renderer/test/authoring-scenes.test.ts
editor/src/renderer/test/scene-operations.test.ts
editor/src/renderer/test/scene-editor.test.tsx
web/widget.html
```

Retained gaps include the strict union, safe step-ID rename, type-aware Variable editing, branch
visualization, final audio/transition execution, real condition/Lua handling, autosave-safe points,
typed Character actor slots, compiled continuation behavior, and complete replacement of the
cutscene-shaped runtime bridge.

## Non-goals

Do not restore legacy cutscene arrays or compatibility APIs. V1 does not provide parallel tracks, keyframes, or a general graph VM.
