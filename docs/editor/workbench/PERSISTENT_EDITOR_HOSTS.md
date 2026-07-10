# Persistent Workbench Editor Hosts

## Purpose

Some workbench editors own live state that ordinary tab view-state restoration
cannot reconstruct safely. The Play editor is the primary example: it owns a
preview iframe, WASM runtime, MessageChannel transport, debugger and recorder
state, runtime mutations, and local React state.

Editors registered with `mountPolicy: 'keep-mounted-while-open'` use a
workbench-wide lifecycle:

```text
An open persistent editor is mounted exactly once beneath the stable Workbench
owner. Tab groups choose where it is displayed, not whether it is mounted.
```

Active-only editors remain group-owned and restore typed tab state after a real
remount.

## Ownership and Placement

`PersistentEditorHostLayer` renders one host for every open persistent tab. A
host is keyed by tab ID and remains under the same React and DOM parent while
the tab moves between groups, docks into a new split, or causes an empty source
group to be pruned.

An active group renders a `PersistentEditorSlot` instead of the editor subtree.
The slot registers its tab ID, group ID, DOM element, and generation. The host
is shown only when the tab's current workbench group, current slot, and measured
slot generation all agree. Missing or stale placement fails closed: the host is
hidden and noninteractive rather than remaining over its previous group.

The host layer measures slots relative to the workbench root. It responds to
slot/root resize observation, window and workbench layout notifications, and
continuously applies direct DOM placement during split-resize drags. The layer
stays below resize handles and drag overlays. Iframe-backed hosts disable
pointer input during split resize and tab drag so an iframe cannot intercept
the interaction.

Do not move persistent iframe nodes with DOM reparenting or a portal whose
target changes with the group. Either operation can replace or disturb the
browsing context that this contract exists to preserve.

## Visibility and Location

Inactive or temporarily unplaced persistent editors remain mounted. Their pane
is hidden, inert, marked `aria-hidden`, and has pointer input disabled. Hiding
is presentation state; it must not stop or reset the runtime. Existing preview
visibility/activity signaling may pause presentation and request a fresh debug
snapshot when the pane becomes visible again.

`WorkbenchEditorLocation` supplies the current tab ID, group ID, active state,
and visible state explicitly because a persistent editor is not physically
nested beneath its group. Pointer, focus, and preview-interaction events must
activate the location's current group, never a group captured before a move.

## Preview Ownership

Preview lifecycle and editor mount lifecycle are separate policies:

- Play uses `dedicated-while-open`; its iframe and runtime belong to the tab and
  remain in the persistent editor subtree.
- Derived previews use `pooled-per-tab-group`; each group registers its narrow
  preview-pool API with the workbench group-service registry.
- A persistent editor may use a pooled group preview. Moving it keeps the editor
  subtree mounted, releases the former group lease, claims the destination
  group lease, and sends a complete preview payload to that host.

The group-service registry is intentionally narrow. Do not turn it into a
general service locator; register another service only when a concrete
group-scoped dependency requires it.

## Teardown and State Restoration

Host existence is derived from open tabs, not group lifetime. Closing a tab,
closing its project, switching projects, or resetting the workbench removes the
host and tears down its live resources normally. Reopening a closed persistent
tab creates a new host and runtime; closed runtimes are not retained.

Cross-group moves may capture tab state for consistency, but must not restore
captured state over the still-mounted persistent editor. Initial mount may
restore state. Active-only editors continue to restore typed state after
remounting.

## Intentional Limitations

Persistence lasts only while the tab remains open in the current project and
renderer process. It does not serialize a runtime, retain it across tab close,
project close or switch, workbench reset, application restart, or renderer
failure. A briefly hidden frame is allowed while a destination slot is
registered and measured; displaying stale placement is not.

## Verification

Lifecycle changes should cover mount and iframe identity, moves to existing
groups, docking at every split edge, source-group pruning, hidden/inert state,
stale slot generations, continuous resize placement, group activation, teardown,
active-only restoration, and the persistent-plus-pooled preview bridge.

For a manual smoke test, start Play, make a debug mutation, begin recording,
move Play to an existing group, dock it at each edge, resize the split, switch
away and back, and confirm that runtime, iframe, mutation, recording, and local
state remain intact. Closing Play must still tear down the runtime.
