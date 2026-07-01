# Dialogue Entity

Dialogue records define branching conversations for NovelTea projects. A dialogue is stored under the authoring project `dialogues` collection and uses schema-first authoring data. The current editor implementation is intentionally new-format only; the legacy NovelTea Qt editor is only a conceptual reference and is not a compatibility target.

The important design rule is that the graph is a branch map, not the transcript. Long conversations should remain readable as dense ordered dialogue segments inside larger dialogue blocks. The graph only shows blocks and transitions between blocks.

## Collection

Dialogue records live at:

```json
/dialogues/{dialogueId}
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
  data: DialogueData;
}
```

Dialogue-specific data lives in `record.data`.

## Identity Rules

Dialogue IDs, block IDs, segment IDs, and edge IDs use the project entity ID format:

```text
lowercase kebab-case, starts with a letter, contains only letters, numbers, and hyphens
```

Examples:

```text
intro
chapter-1-opening
asked-about-key
line-3
choice-2
```

## High-Level Model

A dialogue is composed of:

- Dialogue-level settings and defaults.
- `blocks`: graph-level authoring nodes, each containing ordered local segments.
- `segments`: dense line/comment/script entries inside a block.
- `edges`: transitions between blocks, including choices.
- `preview`: editor-only authoring preview state.

```ts
interface DialogueData {
  kind: 'dialogue';
  displayName: string;
  defaultSpeaker: DialogueCharacterRef | null;
  settings: DialogueSettingsData;
  entryBlockId: string;
  blocks: DialogueBlockData[];
  edges: DialogueEdgeData[];
  preview: DialoguePreviewData;
}
```

## Blocks Versus Segments

Dialogue uses a two-level structure because VN and adventure-game conversations often contain long linear stretches before an actual branch.

A block is a graph-level unit. It is the thing that appears in the branch map. A block might represent an opening exchange, a branch point, a response path, a cutaway comment, or a link to another block.

A segment is a transcript-level unit inside a block. It is usually a spoken line, but can also be a comment or local script marker.

Do not model every spoken line as a graph node. That makes even ordinary conversations unreadable. Prefer one block for a coherent beat and many ordered segments inside it.

Good structure:

```text
Block: start
  line: Iris says hello
  line: Player asks about the room
  line: Iris responds
  choice edge: Ask about the key -> key-branch
  choice edge: Leave -> exit-branch
```

Poor structure:

```text
Graph node: Iris says hello
Graph node: Player asks about the room
Graph node: Iris responds
Graph node: Ask about the key
Graph node: Leave
```

## Dialogue Data

### Fields

`kind`

Always `dialogue`.

`displayName`

Human-facing name for the dialogue. This may differ from the record label.

`defaultSpeaker`

Optional character reference used when a block or segment does not override the speaker.

`settings`

Runtime/editor behavior settings for choices and logging.

`entryBlockId`

ID of the first block for normal playback or preview fallback.

`blocks`

Ordered storage array of dialogue blocks. Graph layout is controlled by each block's `graph` position, not by array order.

`edges`

Transitions between blocks.

`preview`

Editor preview state. This should not be treated as runtime game state.

### Default Dialogue

Creating a dialogue through Project Explorer currently produces a minimal typed dialogue:

```json
{
  "kind": "dialogue",
  "displayName": "Dialogue",
  "defaultSpeaker": null,
  "settings": {
    "showDisabledChoices": true,
    "allowDisabledChoiceSelection": false,
    "logMode": "everything"
  },
  "entryBlockId": "start",
  "blocks": [
    {
      "id": "start",
      "type": "linear",
      "label": "Start",
      "defaultSpeaker": null,
      "segments": [
        {
          "id": "line-1",
          "type": "line",
          "speaker": null,
          "text": {
            "mode": "plain",
            "source": ""
          },
          "condition": {
            "enabled": false,
            "source": ""
          },
          "script": {
            "enabled": false,
            "source": ""
          },
          "flags": {
            "showOnce": false,
            "autosave": false,
            "logged": true
          }
        }
      ],
      "link": {
        "targetBlockId": null
      },
      "graph": {
        "x": 0,
        "y": 0
      }
    }
  ],
  "edges": [],
  "preview": {
    "selectedBlockId": "start",
    "selectedSegmentId": "line-1",
    "showConditions": true,
    "background": "dark"
  }
}
```

## Character References

Dialogue speaker references use the standard `$ref` shape and target the `characters` collection:

```json
{
  "$ref": {
    "collection": "characters",
    "id": "iris"
  }
}
```

A speaker may be specified at three levels:

1. Dialogue default speaker: `data.defaultSpeaker`.
2. Block default speaker: `block.defaultSpeaker`.
3. Segment speaker: `segment.speaker`.

Resolution order is segment, then block, then dialogue default. If all are null, the segment has no explicit speaker.

Because references use `$ref`, the existing reference index can discover character usage automatically.

## Settings

```ts
interface DialogueSettingsData {
  showDisabledChoices: boolean;
  allowDisabledChoiceSelection: boolean;
  logMode: 'everything' | 'nothing' | 'only-choices' | 'only-lines';
}
```

`showDisabledChoices`

Whether disabled or unavailable choices should be visible.

`allowDisabledChoiceSelection`

Whether disabled choices can still be selected. Current editor preview does not execute choice conditions, so this is mostly a runtime-facing setting.

`logMode`

Default logging policy. Current values are:

- `everything`
- `nothing`
- `only-choices`
- `only-lines`

Current editor quirk: changing `logMode` does not bulk rewrite existing segment `flags.logged` values. It only updates the setting. If bulk rewrite behavior is wanted later, implement it as an explicit command or modal-confirmed editor action.

## Blocks

```ts
interface DialogueBlockData {
  id: string;
  type: 'linear' | 'branch' | 'link' | 'comment';
  label: string;
  defaultSpeaker: DialogueCharacterRef | null;
  segments: DialogueSegmentData[];
  link: {
    targetBlockId: string | null;
  };
  graph: {
    x: number;
    y: number;
  };
}
```

### Block Types

`linear`

Normal conversation block. This is the default for authored dialogue beats.

`branch`

A block intended to represent a branch point. Branching is still represented by outgoing `choice` edges. This type is an authoring hint, not a separate execution model yet.

`link`

A block that links to another block through `link.targetBlockId`. Link blocks may have no segments.

`comment`

Authoring comment block. Comment blocks may have no segments.

### Block Graph Position

`graph.x` and `graph.y` store editor graph coordinates for the branch map. They are not runtime spatial positions.

Current editor quirk: block movement commits a full `dialogue.replaceData` command on drag stop. The editor deliberately avoids committing while dragging to avoid noisy undo history.

## Segments

```ts
interface DialogueSegmentData {
  id: string;
  type: 'line' | 'comment' | 'script';
  speaker: DialogueCharacterRef | null;
  text: {
    mode: 'plain' | 'active-text' | 'lua';
    source: string;
  };
  condition: {
    enabled: boolean;
    source: string;
  };
  script: {
    enabled: boolean;
    source: string;
  };
  flags: {
    showOnce: boolean;
    autosave: boolean;
    logged: boolean;
  };
}
```

### Segment Types

`line`

A normal dialogue line. Empty line text is allowed by the command layer, but validation reports a warning.

`comment`

Authoring note or non-spoken comment.

`script`

Script-focused segment. Current editor defaults script segments to text mode `lua`.

### Text Modes

`plain`

Normal literal dialogue text.

`active-text`

Text intended to use NovelTea's active text features. Exact runtime interpretation belongs to the text/runtime systems, not the editor schema.

`lua`

Text source is Lua-backed. Current authoring preview does not execute Lua text.

### Conditions

Each segment has a condition object:

```json
{
  "enabled": false,
  "source": ""
}
```

If `enabled` is true and `source` is empty, validation reports a warning. Current editor preview displays condition indicators but does not execute condition scripts.

### Scripts

Each segment has a script object:

```json
{
  "enabled": false,
  "source": ""
}
```

If `enabled` is true and `source` is empty, validation reports a warning. Current editor preview displays script indicators but does not execute scripts.

### Flags

`showOnce`

Intended runtime hint that the segment should only be shown once.

`autosave`

Intended runtime hint that this segment should trigger autosave.

`logged`

Whether the segment should be included in dialogue history/logging.

Current editor quirk: these are stored per segment but are not yet interpreted by preview runtime.

## Edges

```ts
interface DialogueEdgeData {
  id: string;
  fromBlockId: string;
  toBlockId: string;
  kind: 'next' | 'choice' | 'link';
  label: string;
  order: number;
  condition: {
    enabled: boolean;
    source: string;
  };
  script: {
    enabled: boolean;
    source: string;
  };
}
```

### Edge Kinds

`next`

Normal flow to another block.

`choice`

Player-visible choice. The label should be non-empty; validation warns when it is empty.

`link`

Transition used for link-like flow. Link blocks also have `block.link.targetBlockId`; prefer ordinary edges for normal branching and use links when authoring reuse/jump behavior is needed.

### Edge Order

`order` controls display ordering for outgoing edges of the same block and kind. The current preview sorts by `order`, then by edge ID.

Validation warns on duplicate `order` values for the same source block and edge kind.

## Preview State

```ts
interface DialoguePreviewData {
  selectedBlockId: string | null;
  selectedSegmentId: string | null;
  showConditions: boolean;
  background: 'dark' | 'light' | 'checker';
}
```

Preview state is editor state embedded in the dialogue data for authoring convenience. It should not be treated as runtime save data.

Current editor behavior:

- Clicking a graph block updates `selectedBlockId` and selects the first segment in that block.
- Clicking a transcript segment updates `selectedSegmentId`.
- If selected preview IDs become invalid, preview building falls back to entry block, then first block, then first segment.

## Validation

Dialogue validation is implemented by `validateDialogueData(project, dialogueId, record)` and is included in full project validation.

### Errors

Validation reports errors for:

- Invalid zod/schema shape.
- Dialogue inheritance targeting a non-dialogue collection.
- Missing inherited dialogue.
- Missing default speaker, block speaker, or segment speaker character refs.
- No blocks.
- Duplicate block IDs.
- Duplicate segment IDs within a block.
- Duplicate edge IDs.
- Missing `entryBlockId`.
- Edges whose source or target block does not exist.
- Link blocks with missing `link.targetBlockId` when set.

The `dialogue.replaceData` command rejects data with error diagnostics.

### Warnings

Validation reports warnings for:

- Empty line segment text.
- Non-link/non-comment blocks with no segments.
- Enabled condition with empty source.
- Enabled script with empty source.
- Choice edge with empty label.
- Self-edge.
- Duplicate edge order for a source/kind pair.
- Blocks unreachable from the entry block.
- Detected cycles.

The `dialogue.replaceData` command allows warning-only data.

### Cycles

Cycles are warnings, not errors. Dialogue loops can be intentional. Runtime behavior should eventually decide how to handle loop guards, visited choices, and show-once semantics.

## Command Behavior

Dialogue data edits currently use one coarse command:

```text
dialogue.replaceData
```

Payload:

```ts
interface ReplaceDialogueDataPayload {
  dialogueId: string;
  data: DialogueData | unknown;
}
```

The command:

1. Requires the current document to be an authoring project.
2. Requires the dialogue record to exist.
3. Parses proposed dialogue data.
4. Runs dialogue validation.
5. Rejects error diagnostics.
6. Allows warning-only diagnostics.
7. Replaces `/dialogues/{dialogueId}/data`.

Current editor quirk: most field edits dispatch full-data replacement immediately, following the existing Character/Room editor pattern. This means undo entries may be relatively coarse and frequent. Graph drag commits only on drag stop.

## Editor Behavior

Dialogue records open in the `dialogue-detail` editor.

The editor has three conceptual surfaces:

1. Dialogue settings and metadata.
2. Branch map graph.
3. Dense block transcript and selected segment inspector.

### Branch Map

The branch map uses `@xyflow/react`. It renders dialogue blocks as graph nodes and dialogue edges as graph edges. It does not render every dialogue segment as a graph node.

Supported V1 interactions:

- Select a block.
- Move a block.
- Connect two blocks, creating a choice edge.
- Add linear blocks.
- Add branch blocks.

Current editor quirks:

- The graph is a branch map only. Transcript editing happens outside the graph.
- The graph currently uses basic XYFlow nodes, not custom block cards.
- Connecting blocks currently creates a `choice` edge by default.
- Automatic graph layout is not implemented.
- Minimap, graph search, multi-select, and bulk graph operations are not implemented.

### Block Transcript

The selected block shows an ordered list of segments. This is the primary writing surface for dense dialogue.

Supported V1 interactions:

- Add line segment.
- Add script segment.
- Select segment.
- Move segment up/down.
- Delete segment, except when it is the final segment in the block.

Current editor quirks:

- Segment reordering is via Up/Down buttons, not drag-and-drop.
- Deleting the final segment of a block is blocked by the UI.
- Empty lines are allowed but shown as diagnostics.

### Block Inspector

The selected block inspector edits:

- Block ID.
- Block label.
- Block type.
- Block default speaker.
- Link target for link blocks.

Current editor quirk: editing a block ID does not automatically rewrite edges, entry block, link targets, or preview selection that refer to the old ID. Validation will surface broken references. A future refinement should provide a dedicated rename operation for block IDs.

### Segment Inspector

The selected segment inspector edits:

- Segment ID.
- Segment type.
- Speaker override.
- Text mode.
- Text source.
- Condition enabled/source.
- Script enabled/source.
- Flags: show once, autosave, logged.

Current editor quirk: editing a segment ID does not automatically rewrite preview selection. A future refinement should either prevent direct ID edits or add a dedicated rename operation.

### Outgoing Choices

The outgoing choice list edits edges whose `fromBlockId` is the selected block.

Supported V1 interactions:

- Add choice.
- Edit label.
- Edit target block.
- Edit edge kind.
- Edit order.
- Delete choice.

Current editor quirks:

- Choice condition and script source exist in the schema but are not exposed in the V1 outgoing choice editor yet.
- Choice reordering is numeric through `order`, not drag-and-drop.
- Adding a choice uses the first available different block as a target when possible.

## Editor Preview

Dialogue editor preview uses a deterministic authoring preview document:

```text
dialogue-preview
```

Schema marker:

```text
noveltea.dialogue-preview.v1
```

Preview data is built by `buildDialoguePreviewDocumentData(project, dialogueId)`.

The preview includes:

- Dialogue ID and label.
- Display name.
- Entry block ID.
- Selected block ID.
- Selected segment ID.
- Selected block data.
- Selected segment data.
- Speaker metadata resolved from character refs.
- Ordered outgoing choices.
- Settings.
- Preview settings.
- Dialogue diagnostics.

The web widget renders this as simple RML. It shows the selected block's ordered segments and outgoing choices.

Current preview quirks:

- Preview does not execute Lua text, conditions, or scripts.
- Preview does not simulate disabled choices.
- Preview does not run the real dialogue runtime/VM.
- Preview is an authoring visualization, not a gameplay-accurate runtime simulation.
- Preview background currently supports `dark`, `light`, and `checker` in schema, but widget rendering only distinguishes light versus non-light.

## Runtime Status

Dialogue V1 is currently editor/schema/preview oriented. It defines enough structure for future runtime integration, but it does not yet define the final runtime dialogue VM behavior.

Runtime work still needs to decide:

- How Lua conditions are evaluated.
- How script segments and edge scripts execute.
- How `showOnce` and choice visitation are tracked.
- How autosave triggers map to the save/session system.
- How dialogue logs consume `logged` and `logMode`.
- How `active-text` mode maps into runtime text rendering.
- How link blocks and link edges differ during execution.
- How disabled choices are represented to the player.
- How dialogue hands control back to scenes, rooms, or other entities.

Until runtime support lands, treat DialogueData as the authoring contract and not as a complete runtime execution spec.

## Relationship To Other Entity Types

Characters

Dialogue speaker references target `characters`. Character dialogue style metadata is included in preview data when available.

Scenes

Scenes are expected to orchestrate dialogues later, but Scene Editor/runtime integration is not part of Dialogue V1.

Rooms

Rooms may eventually launch or reference dialogues through interactions/hotspots, but that link is not implemented by Dialogue V1.

Variables and scripts

Conditions and scripts are Lua source strings for future runtime integration. The editor stores and validates them structurally but does not execute them.

## Legacy Editor Notes

The old NovelTea Qt editor had a tree-oriented `DialogueWidget`, `DialogueTreeModel`, and `DialogueTreeItem`. It supported useful concepts such as:

- Text segments.
- Option/choice branches.
- Link segments.
- Condition scripts.
- Per-segment scripts.
- Show-once/autosave/logging flags.
- Default speaker/name behavior.
- Preview from selected segment.

The new editor keeps those concepts but does not preserve old serialization. New projects should use `DialogueData` with blocks, segments, and edges.

## Recommended Authoring Patterns

### Linear Conversation With One Branch

Use one `linear` block for the opening exchange, with several line segments. Add two or more `choice` edges to response blocks.

### Long Conversation With Several Branches

Split the conversation into blocks at meaningful branch boundaries, not every speaker change.

### Reused Response

Use a `link` block or an edge targeting an existing block. Prefer explicit edges unless the authoring intent is clearly a reusable jump/link.

### Non-Spoken Notes

Use comment segments inside a block for localized notes. Use comment blocks for graph-level planning notes.

## Current Implementation Files

Schema and validation:

```text
editor/src/shared/project-schema/authoring-dialogues.ts
```

Preview document builder:

```text
editor/src/shared/project-schema/dialogue-project.ts
```

Command operation:

```text
editor/src/renderer/project/dialogue-operations.ts
```

Editor:

```text
editor/src/renderer/editors/dialogues/DialogueEditor.tsx
editor/src/renderer/editors/dialogues/DialogueGraph.tsx
```

Preview widget:

```text
web/widget.html
```

Tests:

```text
editor/src/renderer/test/authoring-dialogues.test.ts
editor/src/renderer/test/dialogue-operations.test.ts
editor/src/renderer/test/dialogue-editor.test.tsx
```

## Known Gaps

- No runtime dialogue VM yet.
- No scene integration yet.
- No automatic graph layout.
- No dedicated block/segment/edge granular commands.
- No safe block ID rename operation.
- No safe segment ID rename operation.
- Choice conditions/scripts are stored but not fully exposed in the V1 choice editor.
- Preview is not gameplay-accurate.
- Editor preview state is stored inside dialogue data and may later need separation from runtime/project data if it becomes noisy.
