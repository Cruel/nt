# Dialogue Component

## Contract

Dialogue is a specialized conversation graph. A `DialogueDefinition` owns immutable settings and a `DialogueProgram`; a Dialogue frame owns the mutable cursor. Dialogue is not flattened into Scene text steps and does not use a universal entity program.

Dialogue may `extends` another Dialogue only for declared custom-property lookup. Blocks, segments, edges, settings, and completion behavior do not merge.

## Authoring V2 structure

- Sequence blocks contain ordered Line, RunLua, or Comment segments and at most one Next edge.
- Choice blocks contain ordered Choice edges and no transcript segments.
- Redirect blocks contain one target block and no outgoing edges.
- Comment blocks are editor-only and removed by compilation.

The old Link edge kind is removed; Redirect is the only authored redirect. Compilation rejects redirect-only cycles that cannot present or suspend. Stable Dialogue, block, segment, and edge IDs support references, diagnostics, history, and resume.

A line has typed text content, optional speaker, conditions/effects, show-once, logging, and autosave policy. Text source is Inline, Localized key, or synchronous Lua expression; markup is Plain or ActiveText. Show-once state is keyed by Dialogue ID plus Segment ID.

`showDisabledChoices` controls whether false-condition choices are hidden or disabled. Disabled choices cannot be selected. `allowDisabledChoiceSelection` does not exist in V2. `logMode` is Everything, Nothing, OnlyChoices, or OnlyLines; an item's `logged` flag can suppress but cannot force excluded logging.

## Calls and completion

Scene `CallDialogue` pushes a Dialogue frame and resumes the caller after Return. A direct Dialogue entrypoint must finish with Scene, Dialogue, Room, or End, never Return. Autosave after a line or choice occurs after effects complete and only at the resulting compiler-marked safe point.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific graph record, optional `extends`, typed properties, strict blocks/segments/edges, entry block, settings, and completion target.
- **Compiled:** linked `DialogueDefinition`/`DialogueProgram`, retained parent edge, redirects, ordered choices, property assignments, and safe points.
- **Mutable:** Dialogue frame cursor, show-once/history/visit state, waits, and property overrides in `SessionState`.
- **Tooling only:** graph coordinates, selected block/segment, preview settings, Comment blocks/segments, categories, tags, colors, and sort keys.

## Current implementation scaffold

Current editor schema, graph, preview, operation, and UI live in:

```text
editor/src/shared/project-schema/authoring-dialogues.ts
editor/src/shared/project-schema/dialogue-project.ts
editor/src/renderer/project/dialogue-operations.ts
editor/src/renderer/editors/dialogues/DialogueEditor.tsx
editor/src/renderer/editors/dialogues/DialogueGraph.tsx
```

The current linear/branch/link/comment schema, Link edges, disabled-choice-selection setting, embedded graph/preview state, and raw scripts are provisional. A transitional runtime-safe subset exists, but there is no final typed `DialogueProgram` executor. Phase 3 replaces the authoring shape; later phases compile and execute it. No compatibility conversion is required.

### Current V1 authoring shape

Dialogue records currently live under `/dialogues/{dialogueId}` and use the shared record wrapper.
Their payload contains settings, an entry block, blocks with dense ordered transcript segments, graph
edges, and embedded preview selection:

```ts
interface DialogueData {
  kind: 'dialogue';
  displayName: string;
  defaultSpeaker: DialogueCharacterRef | null;
  settings: {
    showDisabledChoices: boolean;
    allowDisabledChoiceSelection: boolean;
    logMode: 'everything' | 'nothing' | 'only-choices' | 'only-lines';
  };
  entryBlockId: string;
  blocks: DialogueBlockData[];
  edges: DialogueEdgeData[];
  preview: {
    selectedBlockId: string | null;
    selectedSegmentId: string | null;
    showConditions: boolean;
    background: 'dark' | 'light' | 'checker';
  };
}
```

The important current authoring insight is retained: the graph is a **branch map**, not the
transcript. A block represents a coherent conversational beat or branch point; ordered segments
inside it hold dense spoken/script/comment content. V2 changes block kinds and execution semantics,
but should not regress to one graph node per spoken line.

Current speaker resolution is segment override, then block default, then Dialogue default. V2 may
reshape the fields, but this layered authoring convenience remains useful and should be either
preserved explicitly or intentionally replaced.

### Current V1 blocks, segments, and edges

Current blocks use `linear`, `branch`, `link`, or `comment`, include a label, optional default
speaker, ordered segments, optional link target, and editor graph coordinates. Current segments use
`line`, `comment`, or `script`, with optional speaker, plain/active-text/Lua text source, optional raw
condition and script source, and show-once/autosave/logged flags.

Current edges store stable ID, source/target block IDs, `next`/`choice`/`link` kind, label, explicit
order, condition, and script. Outgoing edges are ordered by `order`, then edge ID. V2 deliberately
replaces these overlapping link representations with:

- Sequence blocks containing Line/RunLua/Comment segments and at most one Next edge;
- Choice blocks containing ordered Choice edges and no transcript segments;
- Redirect blocks containing one target and no outgoing edges;
- editor-only Comment blocks.

The old fields still identify required migration behavior: dense ordered lines, speaker resolution,
plain/ActiveText/Lua-backed text, conditions/effects, show-once, autosave, logging, ordered choices,
and reusable redirects.

### Current V1 validation

Current validation rejects malformed data, invalid same-collection inheritance, missing speakers,
empty block sets, duplicate block/segment/edge IDs, missing entry block, broken edge endpoints, and
invalid link targets. The replacement compiler should preserve equivalent source-specific errors.

Warnings currently cover empty line text, empty ordinary blocks, enabled-but-empty conditions or
scripts, unlabeled choices, self-edges, duplicate edge order, unreachable blocks, and cycles. V2
changes one important policy: redirect-only cycles that cannot present or suspend are errors, while
other intentional conversational loops may remain valid subject to runtime progress semantics.

### Current commands and editor behavior

Dialogue edits use `dialogue.replaceData`, validating and replacing the full Dialogue payload through
the command bus. Graph movement commits only on drag stop to avoid noisy undo history.

The current editor has three useful surfaces:

1. Dialogue settings and metadata.
2. An `@xyflow/react` branch-map graph showing blocks and transitions, not transcript lines.
3. A dense selected-block transcript plus block, segment, and outgoing-choice inspectors.

Current interactions include selecting/moving/connecting blocks, adding linear and branch blocks,
adding/selecting/reordering/deleting line and script segments, editing block and segment data, and
adding/editing/deleting outgoing choices. Segment reorder is currently Up/Down; choice ordering is
numeric. Direct block/segment ID edits are not safe rename operations and may leave validation
errors—stable-ID rename support remains a useful future editor improvement.

Choice condition/script fields exist in V1 but are not fully exposed by the outgoing-choice editor.
Automatic graph layout, minimap, search, multi-select, and bulk graph operations are also absent.

### Current preview behavior

`buildDialoguePreviewDocumentData()` emits `noveltea.dialogue-preview.v1` with the selected block and
segment, resolved speaker metadata, ordered outgoing choices, settings, preview state, and
diagnostics. Invalid selection falls back to the entry block, then first block/segment.

The preview renders a deterministic authoring view. It does not execute Lua text, conditions,
scripts, disabled-choice policy, show-once state, logging, autosaves, or the real Dialogue flow. The
target runtime may eventually back preview through compiled programs, but unsupported behavior must
remain explicit.

### Current runtime/export bridge

The current safe runtime subset can export Dialogue records into the legacy-shaped runtime arrays,
load Dialogue entrypoints, and route `Game.start_dialogue` through the dispatcher into
`RuntimeSessionHost`/`RuntimeController`. Continue and choice selection operate through generated
controls while preserving temporary compatibility attributes.

This is valuable functional coverage, not the final model. The Phase 7 Dialogue slice must preserve
the supported behavior while replacing positional arrays, compatibility attributes, raw JSON
controller state, and legacy flow ownership with `DialogueProgram` plus a typed frame.

### Current files and retained gaps

```text
editor/src/shared/project-schema/authoring-dialogues.ts
editor/src/shared/project-schema/dialogue-project.ts
editor/src/renderer/project/dialogue-operations.ts
editor/src/renderer/editors/dialogues/DialogueEditor.tsx
editor/src/renderer/editors/dialogues/DialogueGraph.tsx
editor/src/shared/project-schema/authoring-runtime-export.ts
editor/src/renderer/test/authoring-dialogues.test.ts
editor/src/renderer/test/dialogue-operations.test.ts
editor/src/renderer/test/dialogue-editor.test.tsx
web/widget.html
```

Retained gaps include strict V2 block variants, safe ID rename operations, full choice
condition/effect editing, runtime condition/Lua evaluation, show-once/history state, logging policy,
autosave-safe points, Redirect progress validation, Scene call/return, and removal of the
legacy-shaped runtime bridge.
