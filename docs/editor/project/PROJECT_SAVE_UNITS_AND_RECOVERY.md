# Project Save-Unit Map

This document is the permanent contract for logical content ownership, tab-scoped Save, recovery,
and structural persistence in the editor. A save unit is identified by the authoring resource it
owns, never by a visual tab instance. The registry source of truth is
`editor/src/renderer/project/save-unit-registry.ts`.

The recorded `persistencePolicy` and ownership model drive tab-scoped Save, Save All, recovery
rebasing, and structural auto-commit. See `PROJECT_STRUCTURAL_COMMAND_PERSISTENCE.md` for the
executable structural classification and safety policies.

## Save-unit identity and path rules

The renderer selects logical save-unit IDs according to the workbench/tab
registry. The native `ProjectSession::resolve_save_units` operation resolves
those IDs into physical owners and field scopes at the expected working
revision; Electron main does not independently reinterpret this mapping.
Structural operations with explicit native owners still pass their reviewed
transaction plan to the native Save boundary.

Native snapshots also include canonical `dirtyPatches` produced from native
saved/working source values. The Electron recovery checkpoint translates those
native deltas into owner-qualified replay instructions and retains exact source
preconditions; it no longer computes a second JSON diff to infer dirty native
record content. The renderer keeps separate tab histories, drafts and pending
invalid form input because those are UI state rather than Project authority.

| Unit family | Stable ID | Owned paths | Policy used by current editor mutations |
| --- | --- | --- | --- |
| Record | `record:<collection>:<entityId>` | `/<collection>/<entityId>` plus `/editor/recordMetadata/<collection>/<entityId>` | `manual-save` |
| Collection editor | `collection:<collection>` | The concrete collection root plus `/editor/recordMetadata/<collection>` | `manual-save` |
| Explorer structural operation | `structure:<collection>` | Canonical command-derived paths for create, rename, duplicate, or delete | `auto-commit` attribution only |
| Project Settings | `project:settings` | `/project`, `/settings`, `/bootstrapModule`, `/entrypoint`, `/export/assetMemoryPolicies` | `manual-save` |
| Project-scoped editor/tool | Named `project:*` unit | The exact paths listed below | Listed per surface |
| Source file | `source-file:<project-relative-path>` | The main-owned physical source file; no JSON pointer ownership | `manual-save` |
| Workflow/panel mutation | Named `workflow:*` unit | Canonical command-derived paths listed below | Listed per surface |
| Read-only/non-content tool | `tool:<editorType>` | None | No content mutation |

The Project Settings owned-path set is exactly:

```text
/project
/settings
/bootstrapModule
/entrypoint
/export/assetMemoryPolicies
```

Neither the empty JSON pointer nor `/` is a Project Settings path. Project Settings writes these
paths immediately through focused undoable commands; nonrepresentable numeric text is retained as
field-level pending input in recovery metadata.

## Unified Project editing API (#602, incremental rollout)

### Shared foundation hardening (#603)

`commands/project-field-identity.ts` validates the active Project session/instance,
canonical JSON Pointer and logical Save owner **before** a native field draft is
published. Paths under Record or Project Settings ownership cannot be staged
under another Save unit. Positional array paths are not field identities: list
editing must use a semantic command rather than buffer an unstable numeric
index. Save-unit identity is independent of the view currently rendering the
field. Active Save rejects unacknowledged field intents even when their only
remaining recovery entry is an unmounted serialized draft; Save All skips the
blocked owner's atomic group while still committing independently valid owners.
Invalid/unattributed field recovery entries fail closed rather than silently
disappearing from the Save result.
Incomplete numeric/raw inputs block content Save and dependent commands in
their logical owner; Undo/Redo cannot advance native history while any such
unrepresented input remains. **Save As is different:** it copies these inputs
as editor recovery without committing their content. Completing or discarding
an input clears the content-Save barrier without disturbing unrelated Save units.
For legacy semantic numeric editors, a completed number authorizes only the
specific pending-input path and exact raw value it is attempting to commit.
That one synchronous invocation captures its admission token before entering
the asynchronous native queue; the raw representation stays recoverable until
native acceptance. Other commands, changed raw values and unrelated pending
paths do not inherit this authorization.

The shared `gameplay-record-descriptors.ts` registry owns native command kind,
parser and defaults for Rooms, Characters and Interactables. The facade accepts
`recordField({record, field, value, label})` or
`recordData({record, before, after, label})` with an event-time delta. Composite
planners rebase against the latest acknowledged record only when their changed
paths have not been modified; overlapping edits fail explicitly. There is no
Room-only buffered-field adapter. `recordList({record, field, action, label})`
resolves list operations by stable item ID after the native command queue,
supporting insertion, removal, reorder and item replacement. It rejects missing
IDs, duplicate IDs, missing anchors and modified item baselines; Character
Expression editing is the initial production consumer. Other legacy list
editors are not migrated as part of this foundation ticket.
For dependent multi-step edits, `projectEdits.batch(transaction, () => requests)`
evaluates the synchronous request planner **inside** the native command queue,
after earlier acknowledgments. The resulting transaction is still submitted
atomically, and any planning or step failure rejects it before native mutation.

Native field transport remains trailing-150-ms/max-500-ms, but acknowledged
history from the same focused edit session is merged into one Undo step *after*
each native acknowledgment, preserving exact forward and inverse patches.
Blur, a dependent command, Save/Save All, Undo/Redo, discard, conflict adoption,
and Project replacement close the active session. This grouping is a renderer
history operation, not a speculative Project mutation or a native transport
batch, and never merges structural auto-commit or atomic transaction entries.

The workspace no longer serializes canonical Project content on every React
render to schedule recovery persistence. A bounded metadata debounce listens
to draft-payload store changes without subscribing the entire workspace to
each typed value. Native acknowledgment still updates the authoritative Project
snapshot and command store; input-to-paint-ready/flush-to-native-ack Performance
measures described below remain available for packaged Feature Lab comparison.
Automated tests cover Save-unit ownership, unmounted recovery, unrelated Save
All owners, recovery-preserving Save As with incomplete numeric input, composite conflict rejection,
two-native-ack Undo/Redo, and stable-ID
collection operations. Packaged Windows/Linux/macOS latency and recovery
acceptance are separate #602 gates, not implied by those tests.

On November 11, 2026, the real native authoring Node addon was exercised on
a disposable Feature Lab copy using `certify-native-editor-performance.mjs`
(Linux dev host, Node 24.16.0). Observed durations were 779 ms for cold Project
open, 358 ms for a one-owner YAML patch and scoped Save, 90 ms for one Lua
source stage/Save, 1,348 ms for saved Project semantic preparation, and
7,620 ms for end-to-end Runtime Package publication. The script's historical
native #520 references are from a different host and are not valid paired
before/after figures. This is real native-addon evidence, **not** a browser
input-to-paint benchmark. A paired packaged-editor baseline/after profile,
including unrelated component renders and 500/1,000 ms worker delays,
remains necessary before claiming the ≤16 ms input acceptance target.

### Packaged Linux UI latency harness (#603)

`pnpm -C editor run benchmark:packaged-fields` runs the **latest unpacked packaged
application**, not a mocked renderer. It copies `tests/projects/feature-lab` to
a disposable directory, opens it through the normal workspace UI event, and
types 20 characters into Project Settings using Electron/Chromium text insertion
at 30 ms intervals. The suite repeats for 0, 500, and 1,000 ms *artificial
native acknowledgment delay*, bounded exclusively by the benchmark flag.
This injects delay **after** native ProjectSession admission and before its IPC
acknowledgment; it is not a claim about native worker compute time. It records
input→next-renderer-frame readiness, idle frame cadence, native acknowledgement
latency, and real patch IPC counts without recording source text. The full
typed value must remain visible across delayed acknowledgments and must be
read back after an ordinary scoped Save from the disposable `project.yaml`.
The harness fails on lost or unmeasured input events, missing acknowledgments,
unbounded requests, or failed saved readback. It automatically removes the
temporary Project and profile, and does not modify the source fixture.

The first two successful Linux x64 / Xvfb software-display runs on November
11, 2026 used a **new package** containing this foundation refactor; each
case recorded 20 presentation samples and a bounded 2–4 native patches:

| Run | Simulated acknowledgment | Input median | Input p95 | Input max |
| --- | --- | ---: | ---: | ---: |
| 1 | 0 ms | 16.35 ms | 32.15 ms | 64.27 ms |
| 1 | 500 ms | 9.40 ms | 14.58 ms | 14.73 ms |
| 1 | 1,000 ms | 9.05 ms | 16.25 ms | 61.07 ms |
| 2 | 0 ms | 21.34 ms | 149.57 ms | 156.77 ms |
| 2 | 500 ms | 24.22 ms | 33.69 ms | 84.77 ms |
| 2 | 1,000 ms | 17.02 ms | 29.97 ms | 66.44 ms |

Both runs passed exact presentation and saved YAML readback. They show
substantial **run-to-run variance**, and the ≤16 ms acceptance target is
**not consistently met** on this virtual-display host. No pre-#603
same-host baseline package was recorded, and these figures are not a
before/after improvement claim. Neither an idle-frame comparison, unrelated
React component render count, actual physical scanout, nor multi-platform
interactive recovery verification is established by the first two runs.
The harness now also captures the idle Chromium frame cadence to help
separate headless frame scheduling from editor work on future runs.

The third pass, with the idle-frame measurement and dedicated Electron
application profile, also passed saved readback. On the same Linux x64 host
(AMD Ryzen 7 5700G, Node 24.18.0, Electron 43.1.1, Chromium 150.0.7871.114)
the input median/p95 was **14.90/34.33 ms** at 0 ms delay,
**8.51/15.45 ms** at 500 ms delay and **8.88/16.25 ms** at 1,000 ms
delay; three, two and two native patch calls respectively. Idle-frame median
was ~16.67 ms for every case, but the first case's **idle p95 was 83.33 ms**
even without editing. Software Xvfb frame pacing is therefore demonstrably
variable on this host; that does **not** prove all editing-path outliers are
display scheduling, since later cases still had long maximum input samples.
No release latency pass or paired baseline is asserted. The explicit
benchmark profile is isolated from the normal appData/userData directory.

The next #602 migration increment, `99ae37c4`, produced a fresh Linux x64
unpacked Electron package with the new Room camera, Character initial-state and
Project transition field adapters. Its packaged smoke suite passed. The
unmodified packaged **Project-title** typing harness passed for 20 insertions
per delay, with exact visible text and saved `project.yaml` readback:

| Simulated acknowledgment | Input median | Input p95 | Input max | Native patch calls | Idle-frame p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 14.51 ms | 32.31 ms | 138.76 ms | 3 | 83.34 ms |
| 500 ms | 8.78 ms | 15.76 ms | 74.07 ms | 2 | 16.67 ms |
| 1,000 ms | 10.26 ms | 15.41 ms | 61.31 ms | 2 | 16.67 ms |

Host: AMD Ryzen 7 5700G, Node 24.18.0, Electron 43.1.1, Chromium
150.0.7871.114, Linux Xvfb software display. These numbers exercise the
existing Project-title path in the **new package**, not separate packaged
input traces for every newly migrated camera/state control; those were covered
by delayed-native React/component tests instead. The p95 does not uniformly
meet 16 ms, especially when idle Xvfb frame pacing degrades; this neither
establishes physical scanout latency nor passes the required human Feature Lab
matrix on Windows/Linux/macOS. #602 and #522 remain open for those gates and
the remaining legacy form/list/geometry editor surfaces.

The next nested-editor migration, `aa98bc80`, also built and passed the Linux
x64 packaged smoke suite. The same **Project-title** typing benchmark passed
all 0/500/1,000 ms acknowledgment-delay cases, with exact presentation,
bounded requests and saved YAML readback:

| Simulated acknowledgment | Input median | Input p95 | Input max | Native patch calls | Idle-frame p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 14.63 ms | 102.24 ms | 130.51 ms | 3 | 83.34 ms |
| 500 ms | 10.02 ms | 16.20 ms | 83.20 ms | 2 | 16.67 ms |
| 1,000 ms | 10.90 ms | 17.13 ms | 68.61 ms | 2 | 16.67 ms |

Environment: Linux x64/Xvfb software display, Ryzen 7 5700G, Node 24.18.0,
Electron 43.1.1, Chromium 150.0.7871.114. The benchmark measures
input-to-next-renderer-frame readiness, not physical screen scanout. Variable
idle Xvfb frame pacing and input outliers mean **the strict ≤16 ms p95 target
is not certified**. This harness covers Project-title typing only; the newly
migrated Room/Character/Interactable nested controls were exercised through
blocked-native-acknowledgment component tests, not this packaged input loop.
Cross-platform interactive certification and remaining #602 surfaces stay open.

All migrated renderer content mutations enter through `commands/project-editing.ts`:
`projectEdits.execute(request)` for semantic/structural commands, `projectEdits.batch(...)`
for transactions, and `projectEdits.field(intent)` for high-frequency field edits. This
facade delegates to the existing native ProjectSession command queue; it is **not** a second
Project authority or a speculative Project document. Source-code editing retains its dedicated
buffered staging protocol, because Lua source is not an ordinary JSON Project field. The
low-level command store is an implementation detail; editor controls must use the facade.

For an interactive field, `commands/native-field-drafts.ts` retains a transient,
session-scoped optimistic value keyed by Project session, Project instance and exact JSON Pointer.
The field paints from that value on the same input event; it does **not** publish a speculative
Project document or command-history revision. The shared scheduler sends a trailing native command
after 150 ms of idle input, bounded to 500 ms during continuous typing. It retains only the latest
field value while a native acknowledgment is outstanding; native commands remain serialized, with
their payloads constructed against the last acknowledged Project and checked for native parity.

`use-project-field.tsx` exposes `useProjectField` for structured editors and standard
`ProjectFieldInput`, `ProjectFieldTextarea`, `ProjectFieldSwitch`, `ProjectFieldSelect`, and
`ProjectFieldNumber` controls. The controls share the same intent/acknowledgment contract;
incomplete numeric text remains recoverable in `pending-input-store`, not coerced to an invalid
numeric Project value. The initial migration covers Room display name and description,
Character summary fields and some default selectors, Interactable display name, stackability and
stack limit, Project metadata, Title Screen, and many App Identity text fields. The former
Room-display-name-specific component has been deleted, including its replacement wrapper.

The subsequent #602 field rollout also uses `commands/gameplay-record-fields.tsx`:
`gameplayFieldOptions` derives canonical ownership, paths and an archetype-aware
native planner from a Room/Character/Interactable reference. Its Input, Number,
Select and Checkbox adapters reuse `useProjectField` rather than introducing
per-control schedulers. Only stable object paths are accepted; positional list
items must instead use `recordList` or an explicit semantic transaction.
Room World Presentation Space dimensions, edge policy, bounds and default Camera
View values, Character initial enabled/visible flags, and Project navigation
transition duration/skippable/fade color have moved onto the shared immediate
field projection. Room Description's structured editor uses the same derived
binding. The semantic kind-switch for Project transitions remains separate
because it initializes related duration state. Tests cover blocked native
acknowledgments and concurrent edits across independent owner records; no new
renderer-owned authoritative Project snapshot is introduced.

In the following #602 nested-editor migration, the Room background Material,
fallback color and image fit controls and all eight Room lifecycle hook editors
also derive owner-scoped optimistic values from `useGameplayRecordField`.
Each lifecycle condition or command-list hook is an independent field; its
shared list editor operates on the optimistic whole-hook value, never a stale
array-index pointer. The Character initial-location selector now paints its
selected Room before native acknowledgment. Interactable Animation motion
selection, playback policy, Material Application and cursor controls use the
same field lifecycle and keep dependent playback options visible while queued.
Representative actual Room, Character and Interactable editor component tests
hold the first native patch acknowledgment, assert immediate independent
presentations and verify final native working data after release. These are
additional migrated surfaces, **not** proof that every nested collection,
geometry gesture, custom property editor or cross-platform recovery workflow
has passed #602's final acceptance gate.

The next Room Camera collection migration uses
`editors/rooms/RoomCameraCollections.tsx`. Named Camera Views and Anchors
stage one owner-scoped, recoverable **collection field** each, never a JSON
Pointer into an array index. Child edits, renames, insertions and removals
look up entries by stable semantic ID and read the latest staged array at the
input event boundary. Native field-baseline CAS rejects concurrent structural
changes to that array; it does not silently overwrite a newer order or
deletion. Selected entries are tracked by ID across Room category changes.
Add View copies the current *optimistic* default framing, including unacknowledged
numeric edits. Incomplete collection-item numeric text and in-progress ID
renames use existing pending-input recovery keyed by semantic item ID and logical
Save owner; invalid or duplicate IDs are never submitted to native. Pending
raw inputs transfer on rename and are cleared when an item is deleted. The
unit's pending-input Save barrier remains authoritative. This deliberately
uses collection-level CAS: it does **not** claim independent item-level external
merging, and an overlapping external edit requires explicit conflict resolution.
Room component regressions exercise blocked native acknowledgment, independent
item edits, exact incomplete numeric text, collision rejection, rename on blur
and Add View against staged Default Camera framing.

For Room Contents and Navigation, `projectEdits.recordItem` now provides a
late-bound semantic-ID operation for editing an existing Exit, Overlay, Cast,
Prop, Environment, Interactable occurrence, or Placement. It captures the
field-level event-time difference, locates the item by ID in the latest
native-acknowledged collection and applies **only** nonconflicting changed
fields. Reorders, unrelated items and disjoint nested fields are preserved;
deletion, duplicate target ID, and overlapping field modifications fail
closed rather than overwriting newer edits. The existing collection list
insert/remove/reorder planners remain separate.

Selected Room Overlay, Cast, Prop and Environment visibility checkboxes
now use the same recoverable owner-scoped optimistic field contract across
the Contents list and Composition inspector. Different checkbox edits in
one collection read the latest staged array, combine before native dispatch,
and paint immediately. Other editors in those sections still rely on native
acknowledgment and require further #602 migration; the shared semantic item
planner itself is a correctness layer, not a second optimistic scheduler.

Room Contents conditions for Overlay, Cast, Prop and Environment, and Material
Applications for Prop and Environment, now join those visibility controls on a
single `useRoomCollectionItem` optimistic owner-scoped collection binding. The
recursive condition and Material Application editors render from the latest
staged collection member and target edits by stable semantic item ID, even
while native dispatch is blocked. A delayed-native test confirms that a
condition change on one Overlay and visibility change on another are both
visible and acknowledged. Environment Material clearing remains disallowed.
This migration does not imply that all contents IDs, placements, numeric
geometry, assets, and other nested editor surfaces have completed #602.

The next #602 implementation pass also migrates the Room Navigation exit
inspector to a single owner-scoped `/exits` optimistic collection field.
Directions, labels, nested conditions, transitions, add/remove, and the
separately mounted destination selector read/update the same latest staged
array by semantic exit ID. ID renames share the pending/validated-on-blur
input with Camera View and Anchor IDs; raw incomplete/duplicate IDs are
recoverable and blocked from native submission. The common ID/number raw
input UI moved into `RoomSemanticInputs.tsx` without changing its Save unit.
The Navigation add/direction menus derive from optimistic rather than
acknowledged exit choices. Cross-Room reciprocal-exit repairs still execute
their original stable-ID semantic native commands.

Character Inventory declarations, presentation profile/pose hierarchies,
expressions, appearances, idles and gestures now render from the existing
owner-scoped optimistic field projections. Same-collection edits read the
latest staged array at input time; structural operations that also rewrite
defaults, cross-profile references or gestures remain atomic native semantic
commands. Character and Interactable Definition Inventory declarations share
one `GameplayInventoriesField` control. Interactable Definition Feature
authoring is optimistic for edits and additions; deleting a Feature retains
the coordinated native transaction that removes exact-Instance overrides.
Dedicated blocked-native UI regressions verify immediate Character Inventory
and pose changes, Room exit edits, and Interactable Definition Inventory and
Feature changes, followed by native acknowledgment and readback.

The next #602 Property Manager and exact-Instance pass gives Room and Character
local Property collections, and Interactable Definition Property Defaults,
the same owner-scoped field projection. Property row creation, deletion and
ordinary schema/value updates publish immediately, while reference-remapping
Property renames and multi-path Trait changes retain their atomic semantic
commands. The Property Manager dialog itself still owns unsubmitted form text;
only accepted edits become native field intents.

Exact Interactable Instance Property, Trait, Feature Override and Material
collections now use separate field drafts under their exact
`/interactableInstances/<id>` paths, without replacing a stale whole Instance
on every change. Definition Instance labels and quantities are buffered too;
Project Settings starting-Inventory quantities and removals use the same
native scheduler. The scoped identity resolver **does not** extend ordinary
`fieldSaveUnitForPath` to this infrastructure registry. It verifies the actual
presenting owner: the Instance's Definition record, a Room whose composition
references that exact Instance, or Project Settings for quantities/locations
inside its starting Inventory. Owner-specific serialized recovery validation
uses the same identity check. A subsequent edit of the same exact path from
another *valid* enclosing owner now transfers the transient draft and its
single recovery record to the newest owner. If the earlier native command was
already dispatched, it retains its original Save attribution and later input
replays against its acknowledged path baseline; if it was queued but not yet
dispatched, its obsolete planner is skipped before native execution and
replanned under the new owner's identity. No edit runs with a contradictory
owner, and sibling views subscribe to the same latest field value. Identity changes and
Property-reference rewrites remain coordinated atomic commands, not scalar
drafts. Test fixtures hold the first native acknowledgment while two distinct
fields or owners are edited; the overlay and latest native readback remain
correct, and clearing an optional Instance label leaves its quantity intact.

**Still requiring #602 certification:** Room geometry/drag, hotspot semantic edits and source editors retain
their respective atomic interaction/source-buffer contracts; the remaining
Project Settings, Character, asset and other nested editor controls still
need a complete field-by-field audit and interactive acceptance. The Save,
Undo/recovery, worker-failure and external-conflict matrix has additional
blocked-native, restart/reopen, cross-owner and synthetic overlap/disjoint
regression coverage, but still needs interactive confirmation on the newly
migrated Property and Instance surfaces. Native-addon and
Xvfb-packaged smoke tests alone cannot certify physical desktop input latency
or the eight human Feature Lab cases. Neither #602 nor #522 may close based
solely on the automated tests reported here.

The subsequent #602 pass also moves the Project Settings Asset Memory Policy
collection and the Display, Accessibility, Audio and Cursor groups onto the
same field scheduler. Existing native semantic commands remain authoritative
for the multi-value Display/Accessibility/Audio validations, with cursor
identity renames/deletions still atomic. The Project app identity retains
field-scoped scalar buffering and its original whole-App command for the
optional settings that require semantic handling; a second `/settings/app`
parent draft would overlap its independently edited child paths and is
intentionally forbidden. Async distribution-notice inspection and numeric
pending-input commits retain explicit native acknowledgment barriers while
their field/list presentation is immediate. All newly buffered groups show
recoverable field errors and conflict resolution. Native field timing now
includes `flush-barrier` and `scoped-save` Performance measures in addition
to the existing input-to-frame and acknowledgment measures. No authored
property values or field source contents are recorded in metrics.

The incremental real-addon full editor regression run passed **303 test files,
2,278 tests**, with **94 skipped**, and zero failures. New tests cover both
queued and dispatched exact-Instance owner transfers, native worker rejection
followed by recovery, disjoint and overlapping restart/reconciliation (including
explicit Keep mine), immediate Asset Memory creation/duplication with native
held, and simultaneous Display/Accessibility edits under a blocked worker.
This is an automated integration result, not the human Feature Lab gate.

The fresh Linux x64 packaged Electron distribution at **`69eb83560d9c`**
passed `package`, `package:smoke` (including native addon/CLI, preload,
production protocols, media, node-pty and security checks), and
`benchmark:packaged-fields`. The unmodified Project-title typing harness
typed 20 characters in each case, asserted exact renderer presentation,
and verified native YAML saved readback after 2–3 patches:

| Simulated native acknowledgment | Input median | Input p95 | Input max | Patch calls | Xvfb idle-frame p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 15.57 ms | 27.88 ms | 30.47 ms | 3 | 66.66 ms |
| 500 ms | 11.32 ms | 15.86 ms | 20.74 ms | 2 | 16.67 ms |
| 1,000 ms | 9.29 ms | 15.89 ms | 80.73 ms | 2 | 16.67 ms |

Environment: Linux x64, AMD Ryzen 7 5700G, Node 24.18.0,
Electron 43.1.1, Chromium 150.0.7871.114, Xvfb software display;
`XDG_SESSION_TYPE=tty`, no interactive physical desktop session. These
measure next-frame presentation **only for Project title**, not physical
scan-out nor the new exact-Instance/Property/Settings controls. The
zero-delay p95 exceeds the 16 ms target amid Xvfb idle-frame stalls.
The eight human-driven Feature Lab cases, a physical <16 ms measurement,
and Windows/macOS/Linux desktop-host qualification remain **unaccepted**.

#### Remaining direct-input editor audit for #602

The final source-level inventory found additional editable surfaces still
bound to native-acknowledged record data. This prevents declaring the requested
**project-wide** migration complete, independent of the human test blockers:

| Editor family | Direct write path still present | Required treatment |
| --- | --- | --- |
| Scene | `SceneEditor.tsx`, `scene.replaceData`; e.g. the display-name input directly invokes `commit({...data, displayName})` | Field-scoped immediate text plus stable-ID event/step deltas; preserve coordinated owner moves |
| Dialogue | `DialogueEditor.tsx`, `dialogue.replaceData`, including numerous block/cue controls | Immediate block/cue projections and late-bound semantic mutations; retain reference/graph transaction atomicity |
| Authored Tests | `TestsEditor.tsx`, `test.replaceData` | Buffered editable metadata/steps, without changing execution/preview authority |
| Layout and Map | `LayoutEditor.tsx` / `MapEditor.tsx`, `*.replaceData` | Separate ordinary scalar controls from geometry/drag and semantic structural commands |
| Material | `MaterialEditor.tsx`, `material.replaceData` | Immediate scalar/selector presentation; preserve shader source-buffer and compilation contract |
| Interaction and Verb | `InteractionEditor.tsx` / `VerbEditor.tsx`, `*.replaceData` | Scope nested rule/value controls independently of structural and reference-remapping commands |
| Other custom editors | Animation, asset/attachment, localization, chapter, source, and specialized preview/export editors retain direct controls | Complete a per-control owner/path inventory; source buffers, stage gestures and generated/preview tools require documented distinct lifecycles |

##### Scene and Dialogue control inventory (#604)

The Scene and Dialogue editor migration uses the ordinary `useProjectField`
native field lifecycle through `editors/scene-dialogue-fields.tsx`. The projected
values are **not** a renderer-owned Project document: they are narrowly keyed
transient drafts, with the native ProjectSession retaining the working/saved
revisions, validation and YAML ownership. Both editor instances subscribe by
Project session and exact field path, independently of tab identity.

| Surface | Control/action inventory | Native owner and editing treatment |
| --- | --- | --- |
| Scene metadata | Display name text | `record:scenes:<id>`, `/scenes/<id>/data/displayName`; immediate scalar draft |
| Scene Stage | Kind, staged Room, blank background/Material/layout, asset, color and fit selectors | Same owner, `/scenes/<id>/data/stage` composite draft; dependent variant initialization stays together |
| Scene inputs and outcomes | Member labels and type selectors; add/remove; stable IDs | Same owner, `/inputs` or `/outcomes` semantic-ID collection draft. Add/remove and rename use atomic commands; ID text is staged until blur and includes the exact semantic owner move. Rename of a referenced return outcome includes the terminal change |
| Scene terminal | Kind, target, return outcome and continuation bindings | Same owner, `/terminal` field; changing discriminated target initializes its complete typed variant. Contained input binding arrays are not addressed by positional patches |
| Scene Events | Labels, track and timing, enabled/status, cues, conditions, gameplay batches, transitions, dependencies, material options and specialized event parameters | Same owner, `/events` semantic-ID collection draft. Every ordinary nested edit merges by stable item ID, including independent sibling fields. Add/duplicate/delete/reorder, type changes and IDs remain atomic; rename retains owner-move attribution |
| Scene local-only | Timeline scrub/play/reset, Event selection, material/preview loading, diagnostics, JSON source parse buffer | Not native Project fields until an explicitly valid editor commit; scrub, selection, preview and parsing text are transient |
| Dialogue metadata | Display name, speaker, log settings, completion and entry-block selector | `record:dialogues:<id>`, corresponding `/dialogues/<id>/data/<field>` drafts. Completion/type variants are coherent objects |
| Dialogue Stage and Media Slots | Labels, initial state, visibility, speaker sync, Character/profile/pose/appearance, content/position/scale and selectors | Same owner, `/stageSlots` and `/mediaSlots` stable-ID collection drafts. Add/remove and dependent cue rewrites are atomic; individual member updates never use array-index pointers |
| Dialogue Blocks | Labels, default speakers, redirect/comment content, line/source/markup, cues, conditions, commands, presentation mutations, choice parameters and nested segment controls | Same owner, `/blocks` stable-ID drafts. Segment and cue edits resolve semantic IDs from the latest staged collection, while graph-changing add/remove/type/rename/reorder operations remain atomic and preserve owner moves |
| Dialogue edges | Choice/next-edge label, target, condition, effects, logging/safe-point controls | Same owner, `/edges` stable-ID draft for ordinary member fields; graph membership, ID, reorder and target rewrites remain semantic transactions |
| Dialogue local-only | Graph positioning/pan/selection, transcript collapsing, preview settings, source editor view state, diagnostics | Locally staged editor view state or read-only. In-line source changes become typed, recoverable `/blocks` intents, not a second YAML writer |

Scene/Dialogue numeric inputs use raw, recoverable synthetic `@<semantic-id>`
paths in the pending-input store, **never** as native JSON Pointers. Incomplete
text, including temporary signs and decimal separators, blocks dependent
commands and content Save rather than being coerced to zero. Identity inputs
similarly keep invalid/in-progress text and only invoke a rename on blur; a
rejected native rename remains available to correct or retry. The shared
trailing-150-ms/max-500-ms scheduler and native queue remain unchanged, and
there is no per-editor debounce. Ordinary typing does not submit stale
`scene.replaceData` or `dialogue.replaceData`; those commands are retained only
for native-atomic semantic transactions.

Native patch locality is required for **physical** Save as well as fast input.
In a real Feature Lab Project, replacing the entire normalized Dialogue
`/data/blocks` array was accepted into the native working state but rejected
by physical Save (`Save projection differs from the working Project at
/data/blocks`). Sparse YAML can intentionally omit references/default values
that an expanded normalized array would re-serialize. The Scene/Dialogue
`useProjectField` command adapter therefore uses the shared
`nativeFieldJsonPatches` planner at **native dispatch**, deriving leaf-level
JSON patches from the latest acknowledged field and current draft. It never
submits a normalized array snapshot just to update one Event or Block label.
The same planner is shared with Authored Test/Interaction/Verb fields to avoid
divergent patch semantics. Semantic IDs determine member identity, while
numeric patch offsets are resolved only after queued native acknowledgments.
The real-addon certification now invokes this exact planner against normalized
Feature Lab Scene and Dialogue lists, verifies it emits only leaf patches,
and validates independent owner Saves by decoding their resulting YAML.

**Final #604 acceptance (November 12, 2026):** `pnpm -C editor run check`
passed with TypeScript, formatting, schema/graph contract checks and zero lint
warnings/errors. The full editor Vitest suite passed **2,312 tests** across
306 passing files, with 94 tests/9 files skipped by their existing markers;
the earlier concurrent Test-editor regression was no longer reproducible.
The real native C++ addon `certify-native-scene-dialogue-save.mjs` passed
again with the extracted dispatch-time native field patch planner, verifying
owner isolation and exact physical YAML readback. The additional sibling
format/lint repairs were left in their existing uncommitted workstream rather
than bundled into #604. The parent #602 packaged/human-display acceptance
remains a separate milestone.

Focused component and semantic tests cover 500/1,000 ms withheld native patches,
same-collection sibling edits, ID-based reordering, invalid raw input, native
rejection and retry, duplicate views, exact acknowledged document contents,
active owner Save and Dialogue Undo/Redo. Native addon YAML readback and full
editor test-suite results are separately recorded with the #604 completion
evidence; these component tests do not claim physical scanout timing or final
multi-platform #602 acceptance.

On November 12, 2026, the #604 focused Vitest suites passed **25/25 tests**
covering the Scene and Dialogue editors and stable semantic merging, including
synthetic 500/1,000 ms acknowledgment holds, bounded requests and caret
retention. The real Linux native Node addon independently passed
`node editor/scripts/certify-native-scene-dialogue-save.mjs` using a disposable
Feature Lab copy: both owner-qualified patch sets were acknowledged, a Scene
scoped Save left Dialogue YAML untouched, and a subsequent Dialogue scoped
Save produced exact decoded physical record values for both owners. This is
native source readback, not a claim that fake Vitest workers wrote YAML.
The first full editor suite run passed 2,307 tests and failed one concurrently
under-development **Authored Test** field regression in
`authored-record-fields.test.tsx`; that failure was reproduced in isolation.
The repo-wide check was also blocked by formatter issues in eight concurrent
non-#604 editor files. Both are outstanding integration gates, not #604
acceptance passes. The #604 files' own lint check passed with zero warnings
and errors; TypeScript passed separately.

##### Authored Test, Interaction and Verb controls (#605)

The `authored-record-fields.tsx` adapter uses `useProjectField` and the shared
`nativeFieldJsonPatches` planner for field-scoped native commands; the native
working/saved Project, revision and validation remain authoritative. Rendered
values are transient recoverable fields shared by session, record and path,
not per-tab whole-record drafts. There is no additional per-editor scheduler.

| Authoring surface | Native Save owner | Ordinary buffered fields and semantic boundaries |
| --- | --- | --- |
| Test metadata | `record:tests:<id>` | `/tests/<id>/data/displayName`; immediate text, separate from playback reports and native run results |
| Test steps, expectations and preview selection | Same Test owner | `/steps`, `/finalExpectations`, `/preview` independently buffered. Step IDs and expectation IDs select stable members; step append/duplicate/remove/reorder and selection updates are rebased into the latest draft. A step plus preview change uses one late-bound atomic native `project.applyPatch` transaction |
| Interaction rules | `record:interactions:<id>` | `/rules` is the transient stable-ID collection. Rule label/verb, priority, selectors, guard, Offer, nested program, conditions and ordering are projected without a stale whole-record acknowledgment. Structural/multi-field changes remain atomic |
| Verb text and program | `record:verbs:<id>` | `/actionText`, `/completedCommandText`, `/availability`, `/defaultProgram` are independent native field drafts. Inline text source, localized key, Lua expression, markup, conditions, and programs update the selected field |
| Verb slots, order and Offers | Same Verb owner | `/slots`, `/bindingOrder`, `/offers` retain stable IDs. A slot rename updates slot identity, binding order, Offer references, nested conditions/program slot operands and named inline text placeholders together via late-bound atomic `project.applyPatch`; associated Interaction rules and Test `run-interaction` step bindings referring to that Verb are remapped in the same multi-owner native transaction. Selector, rank and boolean controls use field drafts |

Numeric step and rule controls retain incomplete text in the shared pending-input
store under *synthetic*, stable-ID `@...` paths, never native positional
JSON Pointers; invalid text blocks Save and dependent operations. Rule, slot,
Offer and expectation IDs similarly retain raw values until blur, enforce
unique lowercase kebab-case identities, and do not remount keyed rows on
each keystroke. A native rejection keeps its edit and error in recoverable
field state. `TestsEditor` flushes its own dirty fields before asking native
readiness to run a Test. Test execution, observations, diagnostic reports and
non-content preview UI do not become Project field drafts.
Empty Lua expression text stays visible and recoverable as pending raw input;
the schema's `additionalDependencies` survives ordinary source edits. Explicit
native command rejection of a coordinated semantic edit retains the whole
before/after intent with a Retry/Discard action. Ambiguous transport failures
remain fail-closed at the ProjectSession boundary; they cannot be blindly
retried until the authoritative native state is reconciled.

Native physical YAML is sparse: older Interaction Rules may store typed
collection references as bare IDs rather than expanded `$ref` objects.
Replacing entire normalized lists can be accepted as a working edit but break
Save or produce YAML that does not decode. The shared patch planner uses
late-bound leaf patches for changed members; same-length renames/reorders use
atomic positional leaf transactions rather than remove/reinsert of normalized
members. `RoomSession::patch` also projects newly added typed collection refs
in Test/Interaction/Verb record source to bare IDs even if the *intermediate*
union variant is not valid while a multi-patch transaction is underway.
Explicit registry refs remain objects. This is native source projection,
not an editor-side YAML writer.

`NOVELTEA_AUTHORING_NODE_ADDON=... node editor/scripts/certify-native-authored-record-save.mjs`
copies the canonical Feature Lab Project, executes the **same planner** used
by the editors against real normalized native Test, Interaction and Verb data,
then checks physical scoped Saves, unchanged unrelated-owner YAML, and a
fresh native open/record inspection plus sparse YAML decoding. It covers a
Test label/step edit, an Interaction rule rename/reorder/priority change and
a Verb action-text edit. The disposable Project is removed afterward.
An isolated additional Verb fixture also exercises an actual multi-field
slot/template/Offer rename, physical scoped Save and fresh native reopen;
the fixture source is not modified. Linked Interaction/Test slot remapping and
rejected-transaction retry are covered by the renderer command regression.
Renderer regression tests separately cover withheld native acknowledgments,
same-owner duplicate tabs, Undo/Redo, rejected draft retention, semantic
member merges, raw invalid numbers and an atomic Verb slot/reference rename.
Neither these tests nor native source readback establish physical input-to-paint
latency or complete the parent #602's platform/human gates.

##### Layout, Map, Material and Animation authoring (#606)

The `useBufferedRecordData` adapter projects each selected **top-level record
data field** from its own native draft subscription and the record's existing
`record:<collection>:<id>` Save owner. It is only transient presentation and
recoverable intent: native ProjectSession owns the working/saved Project,
revisions, native validation and disk YAML. `projectEdits.field` coalesces
ordinary edits; the dispatch-time `nativeFieldJsonPatches` planner submits
narrow changes to existing sparse source, not a normalized whole-record
replacement. Stable-ID collection edits merge with the latest optimistic
member (including insertions and reorderings); coordinated changes issue an
atomic, late-bound native `project.applyPatch` after the normal field barrier.
An overlapping native change is rejected, not silently overwritten.

| Editor | Save owner | Optimistic native field paths and exceptions |
| --- | --- | --- |
| Layout | `record:layouts:<id>` | `/data/layoutKind`, `/target`, `/scalePolicy`, `/preview`, `/script`, `/mount`, `/dependencies`, `/contract`, `/sampleState`. Layout source selections and dependencies are ordinary metadata. Physical RML/RCSS/Lua companions read/write the same session-matched `ProjectSourceStore` buffer used by Files/source tabs, with its separate source Save and native staging; only inline data without a companion retains its CodeMirror/native semantic edit fallback. The system Title Layout role still has its coordinated Project Settings command. Invalid contract/sample-state JSON stays in local editable source draft rather than being submitted. |
| Map | `record:maps:<id>` | `/data/presentation`, `/locations`, `/connections`. Semantic location/connection IDs edit on blur with stable-ID recovery paths. Location/connection numeric order fields retain incomplete raw text. All nested region, anchor, path and hit-region edits immediately project from the latest member; the geometry preview is read-only SVG, **not** a pointer-drag session. Deletion/pruning and reciprocal-exit selections commit as one native transaction. |
| Material | `record:materials:<id>` | `/data/base`, `/displayName`, `/shader`, `/parameters`, `/textures`, `/preview`. Uniform/texture controls read the latest material override rather than stale resolved preview values. Numeric float/integer uniform input retains partial raw strings with synthetic per-parameter recovery paths. Shader **source text** belongs to the separate source-file store and compile/Save flow; shader identity/path and Material override metadata are record fields, not source-file buffers. |
| Animation | `record:animations:<id>` | `/data/motions` and `/defaultMotionId` project stable motion/marker edits. Canvas `/data/canvas/width` and `/height` use separate exact native number fields. Frame and marker timing retain edit-on-blur numeric controls; marker IDs commit on blur through stable member identity. Scrub, play, loop-range selection, seek, media probing and pending target-FPS confirmation stay transient playback/approval state, not authored Project fields. `MotionPlaybackEditor` edits the supplied caller-owned policy; it does not own a second Animation Save unit. |

The native worker's sparse-source projector now materializes *only* validated
schema-default parent containers when an effective `Replace` targets an
omitted source parent (notably default Map `presentation`). This is required
for exact-field patches and does not clone or persist unrelated defaults.

Held-native 500 ms and 1,000 ms renderer tests in `layout-editor.test.tsx`,
`material-editor.test.tsx`, `animation-editor.test.tsx` and
`map-editor-buffering.test.tsx` assert immediately rendered independent
edits, final acknowledged values and bounded patch counts. Additional Map
tests cover duplicate views, rejected native work retained for recovery,
invalid numeric text, member rename and sibling edits behind a held worker.
A Layout companion-source regression confirms that consecutive RML edits
paint from the source buffer without invoking a Project content patch.
The final four focused component suites passed **29 tests** after this source
handoff and the numeric/semantic-field changes.
The native-addon-backed editor suite passed **306 files, 2,323 tests**
with **94 skips** before the final incremental raw-number changes. Two
subsequent complete runs each passed **305 files and 2,325 tests**, but
each had one different failure outside #606: a temporary-directory
`ENOTEMPTY` in native editor-session cleanup and a workspace Preview-locale
metadata-save timing assertion. Both failing tests passed in isolation;
there is **not yet a clean full-suite pass against the final tree**. Final
editor formatting, lint (zero warnings), TypeScript, schema policy and
generated contract checks passed. The disposable native test
`editor/scripts/certify-native-layout-map-material-animation-save.mjs`
passed physical owner-scoped YAML Save/readback and a fresh Project reopen
for all four editor families. Native Room/Map, ProjectSession, Layout and YAML
transaction CTests also passed (4/4). No checked-in Feature Lab source was
modified. These are automated tests, **not** a hand-driven Feature Lab or
physical input-to-display latency pass: parent #602/#522 manual certification
and cross-platform packaged verification remain open.

This inventory identifies **entrypoints**, not a claim that every occurrence
is defective: many Character, Room, Project Settings and other controls already
use optimistic collection adapters, while read-only inputs and locally staged
dialog/source tools have separate contracts. Nonetheless the unconverted
`*.replaceData` paths and directly bound text fields above are concrete
examples that still require migration and delayed-native regression coverage.
Do not close #602 on the strength of the existing native-addon/Xvfb tests.

The Linux x64 packaged Electron distribution built from `71e3e703da0b`
also passed packaged smoke and the existing Project-title typing benchmark.
The benchmark typed 20 characters per run and verified exact renderer
presentation and native YAML saved readback for all simulated acknowledgment
delays, with only 2–3 native patch calls per burst:

| Simulated acknowledgment | Input median | Input p95 | Input max | Native patch calls | Idle-frame p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 14.66 ms | 37.14 ms | 143.69 ms | 3 | 83.34 ms |
| 500 ms | 10.71 ms | 15.65 ms | 75.24 ms | 2 | 16.67 ms |
| 1,000 ms | 9.16 ms | 14.99 ms | 70.47 ms | 2 | 16.67 ms |

Host: Ryzen 7 5700G, Node 24.18.0, Electron 43.1.1, Chromium
150.0.7871.114, Linux x64 with Xvfb software display. This is the
Project-title **next-frame proxy** on the package containing the migration,
not a physical scanout measurement of the newly migrated Room/Character/
Interactable controls. The 0 ms p95 exceeds 16 ms amid Xvfb idle-frame
stalls; the human interactive and cross-platform acceptance gates remain open.

#### #602 owner-scoped Property/Instance regression and package evidence (2026-11-12)

The Property/Instance increment was committed as `bd73c748dcdf` and tested
with the real Linux native authoring addon. `pnpm -C editor run check` passed
(format, lint with no warnings, TypeScript, schema policy and generated
metadata). The full `vp test run --testTimeout=30000 --reporter=dot` with
`NOVELTEA_AUTHORING_NODE_ADDON` passed **303 test files, 2,271 tests**, with
94 skipped and zero failures. Delayed-native component regressions include
two independent Property fields, Room/Character separate Save owners,
exact-Instance optional label/quantity and Project Inventory authoring.

The fresh Linux x64 Electron package `1.0.0-dev.bd73c748dcdf` passed
`package`, `package:smoke` and `benchmark:packaged-fields`. The Project-title
bench again verified exact 20-character presentation and native saved YAML
readback with 2–3 patch calls across all simulated delays:

| Native acknowledgment delay | Input median | Input p95 | Input max | Native patch calls | Idle-frame p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 14.65 ms | 100.72 ms | 136.27 ms | 3 | 83.34 ms |
| 500 ms | 9.63 ms | 16.08 ms | 62.61 ms | 2 | 16.67 ms |
| 1,000 ms | 10.10 ms | 16.28 ms | 65.70 ms | 2 | 16.67 ms |

Environment: AMD Ryzen 7 5700G, Linux x64 Xvfb software display,
Node 24.18.0, Electron 43.1.1, Chromium 150.0.7871.114. The idle-frame
stalls and above-16-ms p95 values **do not certify** the target physical
input-to-visible-paint latency, even though synchronization remained correct
with 1,000 ms native delays. This harness covers Project-title typing rather
than the new Property/Instance controls. Repeat the full eight-case Feature
Lab matrix, including Save/recovery/conflict and physical display timing, on
the exact packaged binary before closing #602/#522.

The default field operation chooses a narrow native add/replace patch against the **current**
acknowledged Project. Fields with schema-specific initialization (such as Title Screen) supply
their existing semantic command instead. Reusable gameplay-record planners handle archetyped
Room, Character, and Interactable fields. Legacy whole-data controls must use
`recordData` with an explicit event-time before/after delta, rebased at native
queue dispatch. Ready-made `*.replaceData` requests are not implicitly rewritten.
Room placement rename and reciprocal-exit operations now use explicit delta or
stable-ID collection planning rather than stale whole-Room snapshots.

The shared controls and scheduler emit bounded, value-free browser Performance measures named
`noveltea.project-edit.input-to-paint-ready` and
`noveltea.project-edit.flush-to-native-ack`. The former measures from input event to the
next animation-frame opportunity after React committed its overlay; it is a paint-readiness
proxy, **not** an OS-compositor scan-out measurement. The latter measures the time from a
field flush to its native command acknowledgment, including queue wait. Each measure's
`detail` contains only JSON path, sequence and (for acknowledgments) success. In packaged
Electron DevTools:

```js
performance.getEntriesByType('measure')
  .filter((entry) => entry.name.startsWith('noveltea.project-edit.'))
  .map((entry) => ({ name: entry.name, milliseconds: entry.duration, detail: entry.detail }))
```

The per-name Performance entries are cleared after exceeding 256 samples so long editing
sessions do not accumulate an unbounded telemetry buffer. These timings provide objective
traces for the packaged Feature Lab acceptance gate; they do not constitute that acceptance
on their own.

Buffered values register one serializable **Save-unit/field-owned** recovery entry synchronously
with the field event, not only after a React effect. Duplicate tabs subscribe to the same pending
field; closing a non-final view reassigns the recovery reference to a surviving view without
discarding the edit. Only closing the final dirty view prompts for owner-level Save/Don't Save.
An already dispatched native field cannot be synchronously revoked: direct discard reports
failure rather than dropping the overlay, and final-view Don't Save first awaits any in-flight
field acknowledgments, then restores the logical owner from the current acknowledged state.

Text and numeric presentation are separate from acknowledged values. Valid intermediate numeric
text such as `1.0`, `+1`, or `01` is preserved until blur; representable values are submitted
without replacing the text under the cursor. A nullable `null` is an explicit draft payload, not
an absent entry. Native commands read the newest queued value **at command planning**, rather than
freezing it when the native queue becomes busy. Pending fields record a narrow acknowledged
path baseline; if that path changes before dispatch, the queued edit remains visible as an error
instead of silently overwriting the newer value. Changes to other paths do not block the field.

The recovery schema `noveltea.editor.draft.native-field.v2` stores both the authored value
(including an explicit `null`) and the original acknowledged-path baseline (`exists`, value when
present, and editor revision). Restoring after a restart reuses that captured baseline rather than
inventing a new one from the reopened document. Earlier value-only v1 drafts cannot establish
their precondition and are not treated as v2 field intents. An overlapping native/external change
exposes localized **Use current** (discard the pending field) and **Keep mine** (explicitly adopt
the latest acknowledged baseline and submit through the revision-checked native queue). Retry is
reserved for non-conflict failures. Merely typing more into a conflicted field never resets its
baseline, and an explicit rebase is still checked again when the queue actually dispatches.

Exact numeric presentation is confined to the current editing interaction. Once a numeric input
blurs, invalid text remains in the shared pending-input store, while representable text is shown
from the shared overlay. A different view's newer field generation or raw-input update supersedes
any local numeric presentation, avoiding stale values across duplicate views. Field generations
increase monotonically for the renderer lifetime; the last generation for each Project-session/
instance/path identity remains available even after native acknowledgment removes its overlay.
The retained generation is cleared when the Project identity changes. A control retains an exact
number string only while it owns that generation *and* field identity, so an earlier `1.0` cannot
reappear after another view edits and acknowledges the same field, even if the value later returns
to `1`.

Native failures
leave the draft visible with an actionable error and do not advance Project authority. Active Save
flushes its logical save unit, Save All flushes current buffered fields, and ordinary dependent
commands, transactions, Undo and Redo flush before planning. Save As snapshots serializable
pending field intents and incomplete input **without** requiring native acknowledgment; invalid
field attribution and unrecordable drafts still block the copy. Save All may save independent valid units while excluding
units whose buffered field failed native acknowledgment, respecting atomic transaction groups.
A recovered draft whose editor is not
mounted has no live apply callback, so Save is blocked rather than silently pretending it saved that
field; opening its editor reattaches the apply callback.

The 150 ms trailing/500 ms maximum wait remains a **native synchronization** policy, not an
authoring Undo-session boundary. Field commands still dispatch and receive native acknowledgments
individually; focused edit-session history grouping, rather than transport batching, provides
the Undo boundary. Definitive external Use Disk/Keep Mine resolution for pending overlays and
multi-platform packaged certification are still open #602 work.

This is **not** yet project-wide certification: the remaining non-migrated entity controls, numeric
and nested controls, source-stage interoperability, more discrete selectors and geometry/drag
operations, and interactive packaged Feature Lab latency/close/external-conflict acceptance still
need coverage. The Project facade centralizes writes but cannot make an old control immediately
responsive until that control uses the field hook for its rendered value.
The #522 manual acceptance cases remain separate and open.

## File menu and close contract

- Save and `Ctrl+S` commit only the active tab's logical save unit. Source-file tabs participate in
  this same coordinator through `source-file:<path>` units rather than a toolbar-only save path.
- Save All attempts every dirty unit, including dirty source-file buffers, writes the maximal
  independently valid set, and leaves
  blocked units dirty with their recovery overlays intact. It intentionally has no shortcut that
  conflicts with Save As.
  A pending invalid input or external conflict blocks its entire transitive atomic transaction
  group, not unrelated Save units. A partial Save does not clear the blocked group's dirty state.
- Scoped commits send selected save-unit IDs plus the exact logical baseline/local values for the
  affected JSON paths. The main-owned active workspace session already owns the authoritative disk
  project and exact physical revisions. It overlays the selected logical mutation onto that cached
  state, validates the candidate in memory, derives the physical transaction targets from the files
  whose canonical workspace projection actually changes for those exact paths, then exact-CAS checks
  those targets immediately before replacement. Physical file ownership is therefore not inferred
  only from the visual tab: for example a Room-owned `/interactableInstances/<id>` edit also targets
  `project.yaml`, and the Traits collection targets `traits.yaml`. A disjoint external edit can
  therefore survive even when it shares a Room record file or `editor.yaml` with the local save; an
  overlapping path fails closed instead.
- A successful content write returns a targeted acknowledgement, not a reopened whole-workspace
  snapshot. It contains the committed logical units, exact revisions for physical authoring files
  actually changed by the transaction, authoritative recovery/editor state, any external logical
  delta discovered during the bounded CAS rebase, and source-ownership metadata when relevant. Main
  advances remaining dirty units' per-file recovery baselines before returning. Renderer reconciliation
  treats that returned recovery state as authoritative and never replaces it with the older pre-save
  recovery copy.
- Save As and `Ctrl+Shift+S` create a copy from the saved content baseline plus complete editor
  metadata, recovery overlays (including unmounted native field drafts and incomplete numeric input),
  and dirty-only project asset files. An already acknowledged native edit that is not yet content-saved
  stays in recovery, rather than being copied as committed YAML. The active project identity and
  dirty state do not change. Unrelated files may already exist at the chosen destination, but Save As
  rejects pre-existing NovelTea canonical source/state namespaces and exact Asset-path collisions so
  the copy cannot silently merge stale records, Layout/Script sources, recovery state, or unrelated
  destination bytes into the copied workspace.
- Dirty source buffers are serialized into editor recovery metadata with their submitted disk
  baseline revision. Reopening restores the local buffer when the baseline still matches, or surfaces
  an external conflict when disk changed or the file disappeared. A successful source save advances
  the buffer baseline while newer typing remains dirty, and a subsequent metadata flush removes stale
  source recovery.
- Closing the project, switching projects, and normal editor exit flush ignored local editor metadata
  and recovery only. They never pass the complete working document to a content-save API. Metadata-
  only writes never advance `savedDocument` or adopt newer tracked-file revisions. A scheduled recovery
  debounce is canceled/settled before Save, Save All, Save As, or Keep Mine so it cannot race a content
  commit and overwrite the new recovery-baseline marker.
- Closing a non-final duplicate view does not prompt for shared save-unit dirtiness alone. A
  tab-local dirty draft still requires resolution before that visual view can close. Closing the
  final dirty view uses the shared Save / Don't Save / Cancel dialog for the logical save unit.

In native editor sessions, metadata-only persistence uses
`main/services/project-editor-metadata-service.ts` directly. It validates only the editor-state
contract and atomically writes ignored `.noveltea/editor/state.json`; it must not instantiate a
TypeScript Project Workspace. As with native Open, linked recovery directories/documents are
rejected, including links whose targets are inside the Project. Revoked session authority and
unreadable existing state fail without replacing the recovery file. The writer never touches
tracked Project files or the independently owned `native-dirty-state.json` checkpoint.

Native Project Copy As copies the saved source bytes and preserves an independently acknowledged,
unsaved native recovery checkpoint in `.noveltea/editor/native-dirty-state.json`. The checkpoint is
rebased to the destination Project root, and the native working revision is checked before and after
the copy to avoid publishing mixed generations. Reopening the destination replays those edits in
memory; its tracked source files remain saved-baseline copies. The original Project and its dirty
journal remain unchanged. A failed native candidate Open likewise leaves the incumbent native
session and workbench in place until admission succeeds.
Native Copy As retains `.noveltea/trash/{assets,layouts}` so archived sources remain available for
native recovery and Undo. It excludes `.noveltea/transactions`, cache/build output, and existing
editor-local journals, replacing the last with the destination-bound checkpoint only.

Localization preview locale is ignored editor metadata, not tracked localization content or a
native authoring patch. A preview passes the selected locale explicitly through the revision-bound
native runtime preparation request; selecting another preview language does not create a dirty
content Save unit.

The renderer exposes only scoped content Save, metadata-only persistence, and Save As copy IPC.
For YAML owners, Save and Save All first perform a non-mutating source-aware comment preflight
in main. Changed comments offer Save and keep, Save and remove, or Cancel; deletion offers Delete
including comments or Cancel. The grouped dialog shows affected files, paths and prose. Cancel
leaves the selected units dirty and never submits a write. Approval is bound to the reviewed source
revisions and semantic operation, so agent edits during review invalidate the decision. Keep retains
commented explicit defaults even when sparse YAML encoding would ordinarily omit them. This requires
no per-field comment controls and does not change headless CLI deletion behavior.
Content commits cross that boundary with selected save-unit IDs, affected logical paths, and their
baseline/local values; recovery ownership hints are included only where needed to establish a dirty
unit's physical baseline dependencies. The main-owned active workspace session performs final path
projection and exact target revision checks under the cross-process writer lock.
There is no renderer-accessible whole-document Save or old Save As branch. The retired whole-project
content fingerprint is not part of editor metadata, IPC responses, or conflict detection; persisted
concurrency is expressed through exact physical revisions at transaction, watcher, conflict, and
recovery boundaries. Aggregate `workspaceRevision` remains an internal stateless/cold-workspace
primitive where independently useful, not an active-editor synchronization token. External rebase/
conflict semantics are documented in `PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Registered editor mapping

Every editor registered in `default-editors.tsx` has one explicit registry outcome.

| Editor type | Registry result | Save-unit ID | Owned paths / notes |
| --- | --- | --- | --- |
| `engine-preview` | Non-content | `tool:engine-preview` | No authoring-content ownership |
| `full-game-preview` | Non-content | `tool:full-game-preview` | Preview state is non-content; recorder mutations use a workflow unit below |
| `asset-library` | Savable collection | `collection:assets` | `/assets` plus `/editor/recordMetadata/assets` |
| `asset-detail` | Savable record | `record:assets:<entityId>` | `/assets/<entityId>` plus matching record metadata |
| `image-generation` | Non-content | `tool:image-generation` | Generated-asset insertion uses a workflow unit below |
| `comfyui-workflows` | Non-content | `tool:comfyui-workflows` | Workflow-library changes are external editor tooling, not project content |
| `source-file` | Savable source | `source-file:<project-relative-path>` | Physical source buffer owned by the main Project source authority; dirty text is included in editor recovery metadata |
| `engine-shader-source` | Non-content | `tool:engine-shader-source` | Read-only engine-owned source inspection |
| `material-detail` | Savable record | `record:materials:<entityId>` | `/materials/<entityId>` plus matching record metadata |
| `layout-detail` | Savable record | `record:layouts:<entityId>` | `/layouts/<entityId>` plus matching record metadata; system-role changes are attributed to Project Settings |
| `character-detail` | Savable record | `record:characters:<entityId>` | `/characters/<entityId>` plus matching record metadata |
| `room-detail` | Savable record | `record:rooms:<entityId>` | `/rooms/<entityId>` plus matching record metadata |
| `interactable-detail` | Savable record | `record:interactables:<entityId>` | `/interactables/<entityId>` plus matching record metadata |
| `dialogue-detail` | Savable record | `record:dialogues:<entityId>` | `/dialogues/<entityId>` plus matching record metadata |
| `scene-detail` | Savable record | `record:scenes:<entityId>` | `/scenes/<entityId>` plus matching record metadata |
| `test-suite` | Savable collection | `collection:tests` | `/tests` plus `/editor/recordMetadata/tests` |
| `test-detail` | Savable record | `record:tests:<entityId>` | `/tests/<entityId>` plus matching record metadata |
| `placeholder-entity` | Savable record | `record:<collection>:<entityId>` | Concrete resource path; missing collection/ID is explicitly unsupported |
| `verb-detail` | Savable record | `record:verbs:<entityId>` | `/verbs/<entityId>` plus matching record metadata |
| `interaction-detail` | Savable record | `record:interactions:<entityId>` | `/interactions/<entityId>` plus matching record metadata |
| `map-detail` | Savable record | `record:maps:<entityId>` | `/maps/<entityId>` plus matching record metadata |
| `script-module-detail` | Savable record | `record:scripts:<entityId>` | `/scripts/<entityId>` plus matching record metadata |
| `variables` | Savable collection | `collection:variables` | `/variables` plus `/editor/recordMetadata/variables` |
| `traits` | Savable collection | `collection:traits` | `/traits`; physically projected to `traits.yaml` |
| `components` | Non-content | `tool:components` | Documentation/reference surface only |
| `settings` | Non-content | `tool:settings` | Editor preferences, not project content |
| `project-settings` | Savable project unit | `project:settings` | `/project`, `/settings`, `/bootstrapModule`, `/entrypoint` |
| `platform-export` | Savable project tool | `project:platform-export-profiles` | Owns `/export/runtime` and `/export/profiles`; reusable `/export/assetMemoryPolicies` belong to Project Settings; output/template/signing selection and export execution remain user-local/non-content |
| `project-chapters` | Savable project tool | `project:chapters` | `/editor/chapters` |
| `project-tags` | Savable project tool | `project:tags` | `/editor/tags` |

An unregistered editor type or a record editor without a concrete collection and entity ID resolves
to an explicit `unsupported` result. A collection-specific record editor also resolves to
`unsupported` when its resource names a different collection, preventing restored or malformed tab
metadata from attributing edits and dirty state to the wrong record path. The registry coverage test
fails when a registered editor is missing from this map.

## Non-tab and cross-unit mutation inventory

| Mutation surface | Current entrypoints | Logical origin | Policy | Path ownership / atomicity |
| --- | --- | --- | --- | --- |
| Explorer create/rename/duplicate/delete and asset deletion | `ProjectExplorer.tsx`, `AssetLibraryEditor.tsx`, `AssetEditor.tsx` | `structure:<collection>` | `auto-commit` | Command-derived collection and reference paths; multi-path results receive one atomic group |
| Explorer options and hidden categories | `ProjectExplorer.tsx` | `project:explorer-options` | `auto-commit` | Exact `/editor/explorer` metadata paths persisted through the editor-metadata channel |
| Asset import | `workspace.tsx`, `ProjectExplorer.tsx` | `workflow:asset-import` | `auto-commit` | Added `/assets/<id>` paths from the import command |
| Generated-image asset insertion | `ImageGenerationEditor.tsx` | `workflow:image-generation-assets` | `auto-commit` | Added `/assets/<id>` path |
| Runtime/package and platform export-profile editing | `PackageExportDialog.tsx` / profile editor surface | `project:platform-export-profiles` | `manual-save` | `/export/runtime`, `/export/profiles` |
| Reusable asset-memory policy editing | `ProjectSettingsEditor.tsx` | `project:settings` | `manual-save` | `/export/assetMemoryPolicies` |
| Shader compiled-output application | `ShaderCompilePanel.tsx`, `package-export-workflow.ts` | `workflow:shader-compiled-output` | `manual-save` | Exact compiled-output paths returned by the shader command; one atomic group when multiple paths change |
| Successful platform-export identity recording | `platform-export-workflow.ts` | Non-content metadata workflow | Metadata-only | `editor.lastSuccessfulPlatformExportIdentity`; written only after complete selected-target success |
| Play-recorder test creation/update | `FullGamePreviewEditor.tsx` | `workflow:play-recorder` | `manual-save` | `/tests/<testId>` |
| New Entity Wizard | `NewEntityWizardDialog.tsx` | `workflow:new-entity` | `auto-commit` | New record path; room creation plus `/entrypoint` is one command transaction and atomic group |
| Dirty-unit discard | `DirtyCloseDialog.tsx` | `workflow:discard-dirty-units` | `manual-save` | Registry-owned paths restored from the saved baseline; record discard also restores or removes the matching `editor.recordMetadata` entry; duplicate visual tabs are deduplicated by save-unit ID |
| Layout system-role assignment | `LayoutEditor.tsx` | `project:settings` | `manual-save` | `/settings/systemLayouts/<role>` within the Project Settings unit |
| Exact Interactable Instance editing | `RoomEditor.tsx`, `InteractableEditor.tsx` | Enclosing `record:rooms:*` or `record:interactables:*` authoring resource | `manual-save` | Exact `/interactableInstances/<id>` registry paths. The infrastructure registry has no standalone Explorer/tab save unit, so an embedded edit remains attributed to the record authoring surface that initiated it. Duplicate views of that same record still share one save-unit ID. |

Record editor mutations use their `record:*` unit. Collection-wide Variables, Traits, Assets, and Tests
mutations use their `collection:*` unit unless the action is a structural workflow explicitly listed
above. Project Chapters and Project Tags mutations use their named project units.

## Command-history and dirty-state contract

Every mutating `CommandRequest` must provide `originSaveUnitId` and `persistencePolicy`. Missing
ownership is rejected before a command handler runs. Every committed history entry retains those
fields, the canonical deduplicated union of actual patch paths and handler-declared semantic
`affectedPaths`, and an `atomicTransactionGroupId` whenever a command or transaction spans multiple
owned paths. For manual commands, a patch that leaves the initiating record/collection is reassigned
to its actual logical save unit during recovery construction while retaining the same atomic group.
For example, adding a previously unknown tag to a Room yields a Room record-metadata unit plus a
`project:tags` unit, and a Variables rename that rewrites another record gives that rewrite to the
other record's unit. The infrastructure-only `interactableInstances` registry is the explicit
exception: it has no standalone authoring tab/save unit, so an embedded exact-Instance edit remains
with the enclosing Room or Interactable record origin that exposed the editing surface. Saving either
member of an actual multi-unit atomic edit commits the entire atomic component. Transactions reject
missing ownership and conflicting origin, persistence-policy, or atomic-group attribution rather
than silently weakening the initiating transaction.

Static non-tab mutation entrypoints consume `MUTATION_SURFACE_ATTRIBUTIONS` directly so the checked-in
inventory is the executable source of truth for both logical ownership and persistence policy rather
than a documentation-only list that can drift from production call sites.

Every Explorer content mutation is either represented by a rule in
`STRUCTURAL_AUTO_COMMIT_RULES` or remains an explicitly visible manual-save unit. The current
auto-commit set is record create/duplicate/rename/delete, asset import/delete, Explorer presentation
metadata, the New Entity Wizard transaction, and explicitly registered workflow patch transactions.
Successful platform-export identity is not a content command; it is metadata-only and therefore has
no structural auto-commit compatibility rule.

Dirty state is computed by resolving the tab to its logical save unit, comparing every statically
owned path against `savedDocument`, and checking whether current recovery contains a dirty entry for
that same save-unit ID. The recovery check is required for explicitly attributed cross-path edits such
as exact Interactable Instance registry state authored from a Room or Interactable record surface.
The visual tab's `dirty` flag and command-history cursor are not authoritative. Open tabs may supply
fallback recovery ownership only for otherwise unattributed dirty paths; they never create a second
overlapping recovery owner for a path already attributed by a command, workflow, pending input,
repair, or persisted recovery entry. Discard restores both the registry-owned paths and the recovery
entry's actual affected paths. Recovery baseline hints likewise include physical files discovered by
projecting those affected paths, so a Room-owned Instance edit tracks `project.yaml` even though the
Room's static record descriptor does not claim the entire manifest. This prevents a structural
workflow such as New Entity or Asset Import
from being blocked merely because its resulting editor tab is already open when asynchronous
auto-commit snapshots recovery state.
Consequently, two tabs for the same record resolve to the same save-unit ID and cannot carry
independent persistent dirty state. Serializable local drafts that remain for other editors are
stored separately from project content; Project Settings uses authoritative commands plus
field-level pending input instead of a whole-form draft.

Hotspot Focus is one such tab-local serializable draft. Its strictly validated current-shape payload retains the Focus
owner/source identity—including the referenced image Asset and source-image revision facts—initial
and current geometry, selection/tool, and camera state. Recovery restores it only when the current
draft schema/shape and owning tab identity still match and the complete owner-specific Hotspot records
validate at the runtime boundary, then reattaches its live apply/discard callbacks. Applying the draft
revalidates the current Room-background or Interactable-sprite relationship, source identity, and
Hotspot mode before publishing geometry. A valid dirty draft whose owner later changes Hotspot mode is
retained as unresolved work rather than discarded, while apply remains blocked until its saved source
and mode identities are compatible with the current owner. Likewise, a stale source leaves the draft
unresolved instead of projecting old image-space coordinates onto a replacement image. Because that
draft belongs to a visual Focus session rather
than the record save unit itself, closing that tab requires draft resolution even when another
duplicate view of the same record remains open. In that duplicate-view case, Apply/Don't Save resolve
only the tab-local draft; they do not save or roll back the shared record state still owned by the
remaining view.

Persisted tab and draft payloads are independent current-only contracts. Their owner restores a
payload only when both the schema identity and `schemaVersion` exactly match its current declaration;
unsupported state is discarded without a migration path.
