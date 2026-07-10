# Persistent Workbench Editor Host Implementation Plan

## Status

Temporary active implementation plan.

Phases 1 through 4 are implemented. Persistent editor policy/location selection
is centralized, open persistent editors are owned by a stable workbench host
layer and displayed through generation-checked group slots, and cross-group
moves, edge docking, and source-group pruning preserve the mounted host without
restoring captured tab state over live state. Group preview-host pools now
register through a narrow workbench service registry, and persistent editors
with `pooled-per-tab-group` previews release and reclaim group leases without
remounting their editor subtree. Phases 5 and 6 remain open; in particular,
continuous resize-drag positioning polish is not part of the completed slice.
Slot and root resize observation is already in place because newly created split
panels settle after their first layout pass.

Delete this file after the implementation is complete, the acceptance criteria
are verified, and the durable behavior is documented in the editor workbench
and preview documentation.

## Purpose

Some workbench editors own live state that cannot be reconstructed safely from
ordinary tab view state. The Play/debugger/test-recorder tab is the initial
case: it owns a live preview iframe, a WASM runtime, MessageChannel transport,
debugger state, runtime mutations, recorder actions, replay state, and local UI
state.

The current `keep-mounted-while-open` implementation preserves such an editor
only while it remains in the same tab group. Moving the tab to another existing
group or docking it into a new split changes its React parent, so React unmounts
the editor subtree and mounts a replacement. The iframe and runtime session are
therefore recreated even though the tab itself remains open.

This plan changes `keep-mounted-while-open` from a group-local optimization into
a workbench-wide lifecycle contract:

```text
An open persistent editor is mounted exactly once beneath a stable workbench
owner. Tab groups control only where it is displayed, not whether it exists.
```

## Current Behavior and Root Cause

`Workbench.tsx` recursively renders the split layout. Each leaf renders a
`WorkbenchGroup`, and each group currently owns the React subtrees for its open
editors.

```text
Workbench
  WorkbenchLayoutRenderer
    WorkbenchGroup A
      FullGamePreviewEditor
```

`WorkbenchGroup.tsx` keeps editors with
`mountPolicy: 'keep-mounted-while-open'` mounted while another tab becomes active
in the same group. That works because the editor remains under the same
`WorkbenchGroup` parent.

Moving the tab to Group B changes the owner:

```text
WorkbenchGroup A / FullGamePreviewEditor
                    becomes
WorkbenchGroup B / FullGamePreviewEditor
```

React keys identify siblings under one parent. A stable `key={tab.id}` does not
preserve a component moved between different parents. React must unmount the old
subtree and mount a new one.

Creating or pruning a split can also change recursive layout ancestry around a
group. The solution must therefore remain stable even when the workbench layout
tree is structurally rewritten.

## Goals

1. Preserve the exact mounted editor subtree when a persistent tab moves between
   existing groups.
2. Preserve the exact mounted editor subtree when a persistent tab is docked
   into a newly created split.
3. Preserve iframe DOM identity, browsing context, MessageChannel transport,
   runtime memory, debugger state, recorder state, and local React state.
4. Continue hiding and presentation-pausing inactive persistent editors without
   semantically stopping or resetting their runtimes.
5. Keep ordinary `active-only` editors group-owned and remountable through typed
   tab state.
6. Preserve the valid policy combination of a persistent editor with a
   `pooled-per-tab-group` derived preview.
7. Make group activation and group-dependent services explicit instead of
   depending on the persistent editor being physically nested inside a group.
8. Avoid visible stale placement, one-frame flashes, resize lag, and iframe
   input interference during workbench layout changes.

## Non-Goals

This plan does not:

- serialize a live runtime so it can be recreated after unmount
- preserve a runtime after its tab is closed
- preserve a runtime across project close or project switch
- preserve open tabs across editor process termination beyond the existing
  workbench/session persistence rules
- move an iframe DOM node manually between group containers
- replace the iframe with Electron `WebContentsView`
- move FullGamePreviewEditor state into a new global store merely to survive tab
  movement
- change derived preview pooling semantics
- make every active-only editor persistently mounted

## Architectural Decisions

### 1. Workbench-level ownership

All tabs whose resolved mount policy is `keep-mounted-while-open` are rendered
under one stable host layer owned directly by `Workbench`.

```text
Workbench
  Workbench layout
    Group A
      PersistentEditorSlot(tab:play)
    Group B
  PersistentEditorHostLayer
    PersistentEditorHost(tab:play)
      FullGamePreviewEditor
```

The host component is keyed by tab ID and remains under the same React parent
for the entire open lifetime of the tab. A group move changes host metadata and
placement only.

### 2. Groups render slots, not persistent editor subtrees

When the active tab in a group is persistent, `WorkbenchGroup` renders a normal
layout slot representing the group body. The slot registers:

- tab ID
- owning group ID
- DOM element
- visibility/activation generation

The persistent host layer measures that slot and positions the already-mounted
editor over it.

Inactive persistent tabs do not need visible slots. Their hosts remain mounted
but hidden and inert.

### 3. Stable DOM placement for the live iframe

The persistent editor host itself never changes React parent or DOM parent. It
is absolutely positioned within a stable workbench overlay.

Do not use a portal whose target changes from one group to another. Changing a
portal target recreates the portal subtree and therefore does not solve the
lifecycle problem.

Do not call `appendChild`, `replaceChild`, or similar DOM APIs to move an iframe
owned by React. Manual iframe reparenting is browser-sensitive and breaks clear
React ownership.

### 4. Group location is explicit context

Persistent editors can no longer infer all workbench location from physical DOM
ancestry. Add an editor location context with at least:

```ts
interface WorkbenchEditorLocation {
  tabId: string;
  groupId: string;
  isActiveInGroup: boolean;
  isVisible: boolean;
}
```

The context provider remains mounted with the editor. Moving the tab updates the
value without replacing the child subtree.

The persistent host wrapper should also expose the current
`data-workbench-group-id` for existing DOM-based helpers during migration.

### 5. Group services use a bridge, not physical nesting

The existing preview host pool is scoped to a `WorkbenchGroup` through React
context. A future or existing editor may legitimately combine:

```ts
mountPolicy: 'keep-mounted-while-open'
previewHostPolicy: 'pooled-per-tab-group'
```

The persistent host architecture must not silently make that combination
invalid.

Add a workbench-level group-service registry. Each group registers the public
API of its `PreviewHostPoolProvider` under its group ID. A persistent editor host
uses its current group ID to bridge the corresponding preview-pool context into
the stable editor subtree.

When the tab moves:

- the editor subtree remains mounted
- a derived `PreviewPane` releases any old-group lease
- it claims a new-group lease
- it sends a complete derived preview payload
- the old group may destroy its warm hosts if the group itself is removed

The Play tab uses `dedicated-while-open`, so its iframe is owned directly by the
persistent editor and does not transfer through this pool bridge.

### 6. Visibility is presentation state, not runtime state

An inactive or temporarily unplaced persistent host remains mounted with:

```text
aria-hidden=true
inert
visibility=hidden
pointer-events=none
data-hidden=true
```

Do not use runtime stop/reset commands to reduce hidden activity. Existing
preview activity/visibility messages should continue to pause presentation and
request a fresh runtime-debug snapshot when shown again.

Avoid `display: none` for iframe-backed persistent editors unless testing proves
that it preserves all required browser and layout behavior. The existing
invisible absolute-pane approach should remain the baseline.

### 7. Placement must fail closed

When a tab changes group, the host must never remain visible at the old slot
while the new slot is being registered.

The host should become hidden immediately when any of these do not agree:

- the tab's current group in workbench state
- the registered slot's group
- the slot registration generation
- the currently measured placement generation

Only reveal the editor after a valid current slot has been measured. A brief
hidden frame is preferable to a stale-position flash over another editor.

## Proposed Components and Modules

The exact file split may be adjusted during implementation, but the boundaries
should remain explicit.

```text
editor/src/renderer/workbench/
  persistent-editor-host.tsx
  workbench-editor-location.tsx
  workbench-group-services.tsx
```

### `PersistentEditorSlot`

Rendered by `WorkbenchGroup` when its active tab resolves to
`keep-mounted-while-open`.

Responsibilities:

- render a full-size group-body placeholder
- register and unregister the slot element
- identify the current tab and group
- trigger placement measurement before paint
- expose test attributes for tab ID, group ID, and placement generation

It must not render the editor component itself.

### `PersistentEditorHostLayer`

Rendered exactly once by `Workbench` beneath a stable relative-positioned root.

Responsibilities:

- derive all open persistent tabs from `tabsById` and `groupsById`
- resolve each tab's current group
- mount one `PersistentEditorHost` per open persistent tab
- retain hosts for inactive persistent tabs
- remove a host only when its tab is actually closed/discarded
- own the slot registry and placement scheduler

### `PersistentEditorHost`

Responsibilities:

- resolve the editor registration once per current editor type
- render the editor under a stable tab-keyed owner
- provide `WorkbenchEditorLocation`
- bridge group-scoped preview services
- expose the same `data-workbench-editor-pane` contract used by existing editor
  visibility code
- apply visible, hidden, inert, and pointer-event states
- activate the current group from pointer/focus interaction
- position itself over the current slot without remounting children

### `WorkbenchGroupServicesRegistry`

Responsibilities:

- register group-scoped services by group ID
- notify bridge consumers when a service becomes available, changes, or is
  removed
- avoid requiring persistent editor children to remount during a transient
  group-layout update
- allow ordinary group-nested editors to continue using the existing local
  provider path

The first registered service is the preview host pool. Do not turn this into an
unbounded service locator; add only services that are genuinely group-scoped and
needed by editors rendered outside the group subtree.

## Workbench Rendering Rules

For every group:

```text
if no active tab:
  render the existing empty/dashboard state
else if active tab mount policy is active-only:
  render the editor component inside WorkbenchGroup
else:
  render PersistentEditorSlot for the active tab
```

For every open tab in the workbench:

```text
if mount policy is keep-mounted-while-open:
  PersistentEditorHostLayer renders one stable host
```

Visibility is based on whether the tab is the active tab of its current group,
not whether the group is the globally focused group. Multiple split groups may
therefore display different persistent editors simultaneously.

## Placement and Resize Strategy

The overlay should be positioned relative to the stable `Workbench` root.
Measure the slot and root with `getBoundingClientRect()` and calculate:

```ts
{
  left: slot.left - root.left,
  top: slot.top - root.top,
  width: slot.width,
  height: slot.height,
}
```

Use the following update sources:

1. `useLayoutEffect` when a slot registers, unregisters, or changes generation.
2. `ResizeObserver` on the active slot and stable workbench root.
3. Window resize events.
4. An explicit workbench layout-change notification after split sizes change.
5. A request-animation-frame measurement loop while a panel resize drag is in
   progress, ending on pointer up, pointer cancel, or window blur.
6. A final synchronous measurement before revealing a newly placed host.

Apply placement styles directly to the host DOM element during continuous panel
resizing. React state may retain the canonical rect for diagnostics and tests,
but should not be the only per-frame positioning path if it introduces visible
lag.

The host layer itself should use `pointer-events: none`. Only a valid visible
host enables pointer events.

While a workbench resize or relevant drag is active, disable pointer events on
iframe-backed hosts so the iframe cannot swallow pointer movement or pointer-up
events.

## Activation and Input Behavior

The persistent host wrapper must activate its current group on:

- `pointerdown` capture in ordinary editor DOM
- focus capture
- preview-originated interaction messages from inside the iframe

`EnginePreview` and `EnginePreviewHost` currently locate
`[data-workbench-group-id]` ancestors. Preserve that attribute on the persistent
host wrapper initially, then prefer the explicit editor-location context in new
code.

Keyboard shortcuts should continue to be handled by the editor shell rather than
the iframe according to the existing preview input protocol.

## Tab-State Interaction

Typed tab state remains necessary for:

- active-only editor remounts
- closing and reopening tabs where supported
- restoring editor sessions after process restart or project reopen
- convenience state that should survive a deliberate persistent-host teardown

However, moving a live persistent editor must not restore a captured snapshot
over its authoritative mounted state.

Audit `moveTab`, `dockTabToGroupEdge`, and `splitGroup` store operations. For a
currently mounted persistent tab:

- capturing convenience state may remain allowed
- restoration must be idempotent or skipped during a pure group move
- the move must not clear registered tab-state handles
- no close/reopen semantics may be used internally to implement movement

The persistent host should restore saved tab state only on its initial mount or
when explicitly restoring a previously discarded session, not merely because
its group ID changed.

## Project and Close Lifecycle

The persistent host is removed when:

- the tab is closed
- close-all/close-others removes the tab
- project close removes project-scoped tabs
- project switch discards the old project's tabs
- the workbench is reset

The host is not removed when:

- another tab becomes active in the same group
- the tab moves to another group
- the tab creates a new split
- its original empty group is pruned
- split sizes change
- another group becomes globally active

Closing the tab should unmount the editor exactly once and perform the existing
preview transport/runtime cleanup.

## Implementation Phases

### Phase 1: Pure policy and location selectors

Add pure helpers that derive persistent editor ownership without changing
rendering yet.

Deliverables:

1. Resolve a tab's editor policies through one shared helper rather than
   duplicating registry lookup logic in group and host components.
2. Add a pure `tabId -> groupId` location selector over workbench state.
3. Add a pure selector for all open `keep-mounted-while-open` tabs.
4. Define `WorkbenchEditorLocation` and its context/hook.
5. Add focused unit tests for multiple groups, inactive persistent tabs, missing
   registrations, and moved tabs.

This phase should not alter visible behavior.

### Phase 2: Stable persistent host and slots

Introduce the stable host path and migrate `keep-mounted-while-open` rendering
out of `WorkbenchGroup`.

Deliverables:

1. Add a relative stable root and one `PersistentEditorHostLayer` to
   `Workbench.tsx`.
2. Add the slot registry and `PersistentEditorSlot`.
3. Make `WorkbenchGroup` render active-only editors normally and persistent
   slots for persistent active tabs.
4. Mount every open persistent editor once in the host layer.
5. Preserve current hidden/inert attributes and
   `data-workbench-editor-pane` behavior.
6. Keep the host hidden until a current valid slot rect exists.
7. Add component tests proving same-group switching still keeps one mount.

At the end of this phase, moving the Play tab between already-rendered groups
should preserve its React subtree and iframe identity under normal layout
conditions.

### Phase 3: Cross-group moves, docking, and group pruning

Harden lifecycle behavior around the workbench model's structural operations.

Deliverables:

1. Preserve the same host through `moveTab` between existing groups.
2. Preserve the same host through `dockTabToGroupEdge` and new split creation.
3. Preserve the same host when the source group becomes empty and is removed.
4. Add placement generations so old slots cannot reveal a host after a move.
5. Ensure move operations do not restore stale tab state over live state.
6. Verify multiple persistent tabs can remain mounted and one can be visible in
   each split group.

### Phase 4: Group-service bridge and pooled-preview compatibility

Preserve the complete editor policy matrix.

Deliverables:

1. Add a narrowly scoped workbench group-service registry.
2. Register each group's preview host pool API under its group ID.
3. Bridge the current group's preview pool context into persistent editor hosts.
4. Update `PreviewPane` handling so a transient unavailable group pool releases
   or waits without unmounting the editor subtree.
5. Verify that a persistent editor using a derived pooled preview releases the
   old group lease, claims a new group host, and sends a complete payload.
6. Verify the dedicated Play runtime does not interact with or migrate through
   the derived pool.

Do not generalize the registry beyond the actual group-scoped services needed by
this architecture.

### Phase 5: Placement, resize, and interaction polish

Deliverables:

1. Add ResizeObserver and explicit layout-change scheduling.
2. Add continuous direct positioning during panel resize drags.
3. Disable iframe pointer interception during resize/drag operations.
4. Verify there is no stale-position flash when moving or splitting.
5. Verify there is no visible one-to-several-pixel lag while dragging split
   separators.
6. Ensure host layering does not cover tab strips, resize handles, dialogs, or
   DnD overlays incorrectly.
7. Preserve group activation from DOM and iframe interactions after every move.

### Phase 6: Cleanup, documentation, and final verification

Deliverables:

1. Remove the old group-owned hidden persistent-pane path.
2. Remove obsolete comments describing cross-group recreation as expected.
3. Update durable workbench/tab-state/preview documentation with the implemented
   ownership contract.
4. Document any remaining intentional limitation precisely.
5. Delete this temporary plan after the durable documentation is complete.
6. Run all required editor verification.

## Required Tests

### Mount identity

- Opening Play mounts `FullGamePreviewEditor` exactly once.
- Switching to another tab in the same group does not unmount Play.
- Moving Play to another existing group does not unmount or remount it.
- Docking Play into a newly created split does not unmount or remount it.
- Pruning the now-empty source group does not unmount Play.
- Closing Play unmounts it exactly once.

### DOM and runtime identity

- The same editor pane DOM node remains after a group move.
- The same iframe DOM node remains after a group move.
- The iframe key/source is not regenerated merely because group ownership
  changes.
- `loadSession()` is not called again for a pure tab move.
- A runtime/debug value set before the move remains after the move.
- Recorder actions and trace events remain after the move.
- An unsaved local control value remains after the move.

### Visibility

- An inactive persistent host remains mounted, hidden, inert, and noninteractive.
- Reactivating the tab reveals the existing host rather than creating another.
- A host with no current valid slot remains hidden.
- A stale old-group slot cannot reveal the host after the tab moves.

### Placement

- Moving between groups positions the host at the target group body.
- Docking to left, right, top, and bottom positions the host correctly.
- Split resizing updates host position and size continuously.
- Window resizing updates placement.
- No host overlaps the target group's tab strip.
- No stale placement is visible during move transitions.

### Activation

- Pointer interaction in a moved persistent editor activates its new group.
- Focus inside a moved persistent editor activates its new group.
- An iframe `preview-interacted` message activates the new group.
- Interaction never reactivates the former group.

### Policy compatibility

- Active-only editors still unmount and restore typed tab state normally.
- Derived pooled previews remain group-scoped.
- A synthetic persistent editor with `pooled-per-tab-group` changes pool leases
  without remounting its editor subtree.
- Dedicated Play preview ownership remains tab-scoped and is not leased from a
  group pool.

### Lifecycle

- Close-all and close-others tear down removed persistent hosts.
- Project close tears down project-scoped persistent hosts and runtimes.
- Project switch does not retain the previous project's Play runtime.
- Workbench reset clears all persistent hosts and slot registrations.
- Reopening a closed tab creates a new host rather than reviving the closed
  runtime implicitly.

## Likely Files to Change

Core workbench:

- `editor/src/renderer/workbench/Workbench.tsx`
- `editor/src/renderer/workbench/WorkbenchGroup.tsx`
- `editor/src/renderer/workbench/workbench-store.ts`
- `editor/src/renderer/workbench/editor-registry.tsx`
- new persistent host, editor location, and group-service modules

Preview integration:

- `editor/src/renderer/preview/preview-host-pool.tsx`
- `editor/src/renderer/components/engine-preview.tsx`
- `editor/src/renderer/components/engine-preview-host.tsx`

Tests:

- `editor/src/renderer/test/workbench-group.test.tsx`
- `editor/src/renderer/test/workbench-model.test.ts`
- new persistent editor host integration tests
- preview host pool tests for the group-service bridge
- FullGamePreviewEditor tests for runtime/editor state retention where practical

Documentation:

- `docs/editor/AGENT_GUIDE.md`
- `docs/editor/OVERVIEW.md`
- the durable workbench/tab-state/preview documentation established by the
  implementation

## Risks and Mitigations

### Visible placement lag

Risk: React state-driven rect updates can trail split resizing.

Mitigation: use direct DOM style application during active resizing, with React
state used for canonical bookkeeping and tests.

### Stale old-group flash

Risk: effect cleanup and new slot registration may occur in an order that leaves
the old rect visible for one frame.

Mitigation: tie visibility to current workbench group identity plus slot and
measurement generations. Hide on any mismatch before measuring the new slot.

### Iframe pointer capture

Risk: a visible iframe can swallow pointer movement or pointer-up while resizing
or docking.

Mitigation: disable host pointer events for the duration of relevant drag
operations and restore them on pointer up, pointer cancel, or blur.

### Lost group context

Risk: moving the editor outside `WorkbenchGroup` removes group-scoped React
providers.

Mitigation: provide explicit editor location and a narrow group-service registry
bridge. Test the persistent-plus-pooled policy combination.

### Duplicate editor mounting during migration

Risk: both `WorkbenchGroup` and the host layer render the same persistent tab.

Mitigation: centralize resolved policy helpers and make the rendering branches
mutually exclusive. Add a test that queries exactly one pane for each persistent
tab.

### Incorrect teardown

Risk: a group disappearing could be mistaken for the tab closing.

Mitigation: derive host existence solely from open tabs in `tabsById`, not from
the lifetime of a particular group component or slot registration.

### Over-generalized infrastructure

Risk: a group-service registry becomes a broad service locator.

Mitigation: keep its API private to workbench rendering and register only the
preview pool until another concrete group-scoped dependency requires extension.

## Acceptance Criteria

The implementation is complete when all of the following are true:

1. A Play tab can move between existing groups without recreating its editor,
   iframe, transport, or runtime.
2. A Play tab can be docked into a new split without recreating its editor,
   iframe, transport, or runtime.
3. The source group can be removed after the move without affecting the Play
   session.
4. Play debugger, recorder, local UI, and runtime state survive the move.
5. Inactive Play tabs remain mounted, hidden, inert, and presentation-paused.
6. Closing or project teardown still destroys the Play runtime exactly once.
7. Active-only editor behavior and typed tab-state restoration do not regress.
8. Derived preview pooling remains group-scoped and compatible with persistent
   editor mounting.
9. Resizing and docking show no stale-placement flash or perceptible host lag.
10. Group activation works from both ordinary editor interaction and iframe
    interaction after a move.
11. Relevant unit and integration tests pass.
12. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass from `editor/`.

## Verification Commands

Run focused tests during implementation, then finish with:

```sh
cd editor
pnpm lint
pnpm typecheck
pnpm test
```

Also run the Electron editor and manually verify:

1. Start a Play session and make an observable debug mutation.
2. Begin a recording and add at least one recorded action.
3. Move Play to an existing group.
4. Dock Play to each split edge.
5. Resize the split continuously across the preview.
6. Switch away from and back to Play.
7. Confirm the runtime, mutation, recording, and iframe session remain intact.
8. Close Play and confirm the runtime is torn down normally.
