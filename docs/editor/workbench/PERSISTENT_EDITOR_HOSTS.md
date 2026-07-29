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
  remain in the persistent editor subtree together with the editor's React state.
- Built-in derived previews also use `dedicated-while-open`, but their editor remains
  `active-only`. Each group retains one lazily created iframe per open preview tab while the editor
  subtree may unmount and restore typed tab state normally. Returning to a tab reclaims the same
  iframe, MessageChannel, WebAssembly instance, and committed preview state.
- `pooled-per-tab-group` remains an explicit supported policy for editors that intentionally reuse a
  host across semantic owners. Pool allocation is synchronously authoritative rather than derived
  from pending React state, so StrictMode effect replay cannot create hidden orphan engine hosts.
- A persistent editor may use a pooled group preview. Moving it keeps the editor
  subtree mounted, releases the former group lease, claims the destination
  group lease, and sends a complete preview payload to that host.

Room, Layout, and Shader use one focused-preview freshness coordinator above the host abstraction. A lease is
identified by project instance, host generation, root, and apply sequence. The coordinator coalesces
changes to one in-flight apply plus one latest pending state, replays the complete current document
after reconnect or host reclaim, and rejects stale build, staging, native-completion, and diagnostic
results. Same-root failures retain the prior committed visual; a new root remains hidden until its
first complete native apply succeeds. Inactive dedicated hosts stay warm but have no active lease,
input route, native engine tick, or render submission.

Each dedicated host retains an editor-side key for its last successfully committed preview content.
Reclaiming a tab whose rebuilt desired document still matches that key reveals the retained frame
immediately and skips another focused apply, legacy document load, and asset-staging pass. If content
changed while the tab was inactive, the prior committed frame stays visible until replacement
publication succeeds. A real iframe or transport-generation change clears the key and forces replay.

Lease transfer conceals the pooled host synchronously before React publishes the new owner, clears
the old placeholder route, and cancels the former lease's editor-side commands even when an
underlying transport promise is still unresolved. The web widget reserves a newer focused apply at
MessageChannel ingress and aborts obsolete resource staging before the sequential command drain
reaches the replacement command. A current apply failure is reported and remains stable until a new
publication, ready event, or lease replay requests another apply; it is not retried every animation
frame.

The native document lifecycle remains valid after a lease transfer. In particular, deferred RmlUi
destruction of the previous Layout document can run after the next focused Lua environment is active.
NovelTea's dedicated RmlUi Lua-listener lifetime patch makes inline listeners release callback
references against their creation state and table, not mutable process-global interpreter lookup
state. A failure here terminates the shared Electron renderer and makes every pooled preview in that
renderer appear grey at once.

Derived hosts start with native audio disabled. They are visual authoring surfaces, not independent
playback runtimes, and multiple WebAudio/miniaudio devices inside the shared Chromium renderer can
make every group fail together. The dedicated Play host explicitly opts into audio. The shared
preview server session is process-scoped; a single-host reload remounts only that iframe and does not
rotate the session token for other groups.

An inactive dedicated derived host is retained with no lease, moved far offscreen, and kept at its
last measured dimensions. Collapsing it to zero dimensions would make the iframe publish a real
`1x1` surface resize and destroy the retained bgfx/RmlUi presentation targets. The editor sends
`set-preview-activity(active=false, visible=false)`, and the Web shell pauses the Emscripten main loop
rather than merely lowering the configured frame cap. Its MessageChannel, iframe browsing context,
canvas dimensions, and committed frame remain alive so the host can be reclaimed. Reactivation
resumes on the next animation frame and force-reapplies the unchanged surface tuple before normal
rendering, so Layout presentation centering and pointer transforms cannot remain stale until an
external resize. An active but not-yet-published candidate uses `active=true, visible=false`; it must
continue ticking until mandatory asset preparation and owner-thread finalization complete.

The group-service registry is intentionally narrow. Do not turn it into a
general service locator; register another service only when a concrete
group-scoped dependency requires it.

## Teardown and State Restoration

Host existence is derived from open tabs, not active editors. Closing a tab, closing its project,
switching projects, or resetting the workbench removes the host and tears down its live resources
normally. Moving an active-only derived tab between groups destroys the source group's iframe and
creates a destination-group iframe; persistence currently covers ordinary tab switches inside a
group, not cross-group browsing-context migration. Reopening a closed tab creates a new host and
runtime; closed runtimes are not retained.

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

Lifecycle changes should cover editor remount versus iframe identity, inactive suspension, tab-close
teardown, moves to existing groups, docking at every split edge, source-group pruning, hidden/inert
state, stale slot generations, continuous resize placement, group activation, active-only
restoration, and the persistent-plus-pooled preview bridge.

For a manual smoke test, start Play, make a debug mutation, begin recording,
move Play to an existing group, dock it at each edge, resize the split, switch
away and back, and confirm that runtime, iframe, mutation, recording, and local
state remain intact. Closing Play must still tear down the runtime.
