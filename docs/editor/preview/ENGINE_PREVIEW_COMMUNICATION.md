# Engine Preview Communication

This document describes how the Electron editor communicates with the
Emscripten NovelTea engine preview, and what to change when adding new preview
commands or runtime events.

## Overview

The editor embeds the Web-only build of `apps/editor_preview` in an iframe. It does not
embed or reparent the native SDL window.

There are two Emscripten HTML hosts:

- `web/shell.html`: normal web sandbox/game shell. This remains the general web
  loading path and may expose normal runtime/demo boot options.
- `web/widget.html`: editor-only preview widget shell. This is used by
  `editor/scripts/build-engine-preview.mjs` through `NOVELTEA_WEB_SHELL_FILE`.
  It is intentionally narrow: canvas, MessageChannel handshake, resize, and
  typed preview-document application. It should not load default game/runtime UI
  or expose the full runtime demo toolbar.

There are two communication layers:

- Electron IPC: used for privileged preview setup and editor-tooling helper calls. Preview-session
  creation/reload is guarded by the owning editor-frame boundary and the current opaque
  `projectSessionId`; main derives the Project manifest from that session rather than accepting a
  renderer-selected Project root.
- MessageChannel: used for live editor-to-engine commands and engine-to-editor
  events.

Editor-owned keyboard shortcuts use Electron's
`webContents.before-input-event` hook rather than the preview MessageChannel.
When a preview iframe owns focus, the main process recognizes global editor
commands such as New, Open, Save, close/reopen tab, command palette, and panel
toggles, prevents delivery to the preview, and forwards a semantic command over
typed preload IPC. Normal keys and context-sensitive editing shortcuts remain
with the focused document.

Zustand remains the authoritative editor-side state. The engine owns runtime
state needed for rendering and hit testing.

Runtime debug snapshots are derived from the host-retained coherent `RuntimePublication`, not from a
RuntimeUI state lookup. They include the publication and presentation revisions, published
observation count, desired actor/interactable/prop/environment/Layout/audio counts, and the
publication's checkpoint observation. `gameplayPaused` comes from the publication's typed gameplay
view and represents semantic gameplay pause only; it is not iframe visibility, editor preview
suspension, audio-device pause, or a modal-layout heuristic. These fields are validated at the shared
preview-protocol boundary.

## Workbench Preview Lifetime

The Play editor is registered as a persistent workbench editor with a
`dedicated-while-open` preview. Its editor subtree, iframe, MessageChannel, and
runtime are owned by the stable workbench host layer rather than by the current
tab group. Moving or edge-docking the tab changes only measured placement and
explicit group location; it must not recreate the iframe or reload the preview
session.

Inactive Play hosts remain mounted but hidden, inert, and presentation-paused.
Closing the tab, closing or switching the project, or resetting the workbench
still tears the host down. Built-in derived entity editors remain active-only,
but each open tab retains one lazily created `dedicated-while-open` iframe in the
stable workbench preview layer. Switching tabs, moving between groups, and edge
docking remount the editor as needed without recreating that iframe. Explicit
`pooled-per-tab-group` previews remain supported for semantic host reuse; the
group is a logical pool key while the physical iframe remains workbench-owned.
The full lifecycle and placement contract is documented in
`docs/editor/workbench/PERSISTENT_EDITOR_HOSTS.md`.

A newly claimed lease must wait for that iframe's `ready` event before
sending its mode or typed document/environment payload. A warm host retains its
ready state while inactive, so returning to a tab does not introduce another
startup wait.

Play treats each native `ready` event as a bootstrap generation. The editor publishes its controls
context during the React layout phase, but the Play owner still queues a ready generation until a
ready controls context exists. It loads the current compiled runtime project first and requests a
debug snapshot only after that load succeeds. A missing or runtime-blocked project therefore reports
its actual compiler diagnostics instead of issuing a misleading snapshot request against an
unloaded runtime. Initial connection is not treated as a visibility reactivation; refresh-on-visible
commands run only after a host has actually transitioned from hidden to visible.

Runtime compilation uses a clone with editor-only state reset. Diagnostics under `/editor/**` remain
authoring diagnostics, but they do not prevent Play or runtime-package publication, consistent with
the validation-boundary matrix. Runtime-owned content errors continue to block normally.

Dedicated derived hosts also retain the identity of their last successfully committed preview
content. Editor remount is not itself a replay boundary: when the rebuilt desired document has the
same identity, reclaim reveals the existing frame without another document load, focused apply, or
asset-staging pass. A changed desired revision or an actual iframe/transport replacement remains a
replay boundary.

Focused apply sequence ownership is host-scoped rather than editor-scoped. Every lease obtains its
next sequence from its host, so reconnect and reclaim remain strictly monotonic against the native
presenter even though each editor mount owns a separate freshness coordinator.

A claimed derived-preview host remains browser-visible while its first focused candidate is being
prepared, but is rendered transparent and rejects pointer input until publication. Do not hide that
iframe with CSS `visibility: hidden`: Chromium suspends its animation-frame loop, which prevents Web
native owner-thread asset finalization from advancing and deadlocks the first candidate before
`focused-document-applied`. During this unpublished interval the activity contract is
`active=true, visible=false`; active hosts retain their configured frame cadence so preparation can
complete. Successful publication changes the host to opaque and interactive. A rejected new-root
candidate remains transparent.

When a dedicated derived host becomes inactive, the editor releases its lease and sends
`set-preview-activity(active=false, visible=false)`. The Web shell pauses the Emscripten main loop,
so the retained iframe performs no native simulation, asset pumping, or rendering. MessageChannel
delivery and the browsing context remain available for later reclaim. The host remains offscreen at
its last measured dimensions rather than collapsing to zero; otherwise the widget would publish a
real `1x1` resize and replace the retained bgfx/RmlUi presentation surface. Reactivation resumes on
the next animation frame and force-reapplies the current surface tuple even when its dimensions did
not change, keeping RmlUi centering and native pointer transforms synchronized with the restored
on-screen iframe. This is distinct from `active=true, visible=false`, which is reserved for candidate
preparation and must continue ticking.

Focused Layout pointer events are dispatched through the committed focused Lua environment rather
than through a running game session. Gameplay-owned Layout callbacks receive the restricted
`GameplayLayoutEvent` capability profile used during focused realization. Gameplay-state inputs and
shell commands remain passive or blocked in focused preview.

## Electron IPC

The renderer asks the Electron main process for a preview session through the
typed preload API:

```ts
window.noveltea.getEnginePreviewSession();
window.noveltea.reloadEnginePreview();
window.noveltea.openProject(projectPath);
window.noveltea.validateProject(project);
window.noveltea.listPlaybackTests(project);
window.noveltea.runPlaybackTest(project, testId);
window.noveltea.exportPackage(project, outputPath, options);
```

The main process starts a loopback-only HTTP server bound to `127.0.0.1` on an
OS-assigned port. In development it serves:

```text
build/web-editor-preview/apps/editor_preview
```

The main process returns:

```ts
interface EnginePreviewSession {
  url: string;
  origin: string;
  sessionToken: string;
}
```

The token is included in the iframe URL. The renderer does not receive generic
IPC, filesystem access, or arbitrary server controls.

Project load, import, validation, playback, raw entity edits, and package
export are handled by the bundled standalone `noveltea` executable through its private native bridge. The
Electron main process spawns the helper with JSON on stdin and returns the
helper's JSON response through typed preload IPC. This keeps Electron and Node dependencies out of
the backend-neutral runtime modules; the helper uses the explicit engine/content protocol boundary.

## MessageChannel Handshake

`web/widget.html` reads `sessionToken` from the iframe URL and sends a bootstrap
hello to the parent window:

```ts
{
  type: 'noveltea-preview-hello',
  version: 1,
  sessionToken
}
```

The React editor validates:

- `event.source === iframe.contentWindow`
- `event.origin === session.origin`
- protocol version
- session token

After validation, React creates a `MessageChannel`, transfers one port to the
iframe, and keeps the other. All live communication after that uses the
dedicated port.

The initial hello may use `'*'` as the bootstrap target origin because the
iframe does not know the Electron parent origin. The editor must continue to
validate source, origin, version, and token before accepting it. After the
preview origin is known, do not use wildcard origins for further messages.

## Editor And Engine Flow

The renderer sends typed runtime, document-preview, activity, resize, audio, and profiler commands
over the dedicated `MessagePort`. `web/widget.html` validates and translates each command to a
narrow export owned by `apps/editor_preview`. Engine events return over the same port and update the
relevant editor store or preview session. No sandbox demo state participates in this protocol.

## Important Files

- Protocol types and validators:
  - `editor/src/shared/preview-protocol.ts`
- React MessageChannel controller:
  - `editor/src/renderer/hooks/use-engine-preview.ts`
- Preview manager/session policy:
  - `editor/src/renderer/preview/preview-types.ts`
  - `editor/src/renderer/preview/preview-manager.ts`
  - `editor/src/renderer/preview/preview-manager-store.ts`
- Preview iframe component:
  - `editor/src/renderer/components/engine-preview.tsx`
- Editor state:
  - `editor/src/renderer/stores/workspace-store.ts`
- Electron preview server:
  - `editor/src/main/engine-preview-server.ts`
- Typed Electron API:
  - `editor/src/shared/electron-api.ts`
  - `editor/src/shared/ipc-channels.ts`
  - `editor/src/preload.ts`
- Editor helper service and native CLI boundary:
  - `editor/src/main/services/editor-tool-service.ts`
  - `editor/src/shared/noveltea-cli-subprocess.ts`
  - `tools/editor_tool/tooling_native.cpp`
- Emscripten normal web shell:
  - `web/shell.html`
- Emscripten editor preview widget shell:
  - `web/widget.html`
- C++ preview event bridge:
  - `engine/include/noveltea/preview_bridge.hpp`
  - `engine/src/preview/preview_bridge.cpp`
- C exports used by JavaScript:
  - `apps/editor_preview/editor_preview_app.cpp`
- Emscripten exported symbols:
  - `apps/editor_preview/CMakeLists.txt`

## Current Protocol

Editor to preview:

- `play`
- `stop`
- `runtime-reset`
- `runtime-load-compiled-project`
- `runtime-start`
- `runtime-stop`
- `runtime-step`
- `runtime-continue`
- `runtime-fast-forward-to-input`
- `runtime-dialogue-option`
- `runtime-navigate`
- `runtime-select-subjects`
- `runtime-clear-subject-selection`
- `runtime-run-interaction`
- `runtime-request-debug-snapshot`
- `runtime-request-asset-profiler`
- `runtime-set-variable`
- `runtime-reset-variable`
- `runtime-give-object`
- `runtime-remove-inventory-object`
- `runtime-teleport-room`
- `runtime-create-instance`
- `runtime-replace-instance-configuration`
- `runtime-clear-instance-configuration`
- `runtime-destroy-instance`
- `runtime-retarget-room-exit`
- `load-preview-document`
- `update-preview-document`
- `set-preview-mode`
- `request-preview-state`
- `set-engine-settings`
- `set-preview-activity`
- `set-preview-wheel-routing`
- `request-preview-snapshot`

`runtime-navigate` carries the exact current `exitId`, not a direction ordinal. Runtime debug
snapshots expose each available navigation input as `{ exitId, direction, label, enabled }`. The
preview validates that the identified exit still belongs to the active Room and is enabled before
submitting `NavigateRoomInput`; direction remains presentation and recorded-test metadata only.

Runtime Gameplay Instance tooling uses the same semantic gateway as authored Lua. Create and
configuration-replacement messages identify `instanceKind`, one source kind (`archetype`, `compiled`,
or `effective`), and a stable source ID. Clear, destroy, and Room-exit retarget commands address exact
typed identities. Successful commands settle the Runtime Session before the preview publishes the
result; failed validation leaves the prior session world unchanged.

The Play preview loads the normal title screen. Starting the preview runtime is routed through the
runtime shell's `StartGameShellCommand`, which starts gameplay, hides the modal title Layout, and
shows the Game HUD as one operation. Native preview commands report success only for `Handled`
runtime input; `Unhandled` is a rejected command rather than a successful no-op.

Focus moving between the embedded game canvas and editor-owned inspector controls does not suspend
the preview host. Preview suspension is controlled explicitly through `set-preview-activity`; SDL
focus loss inside the embedded widget is not equivalent to a standalone player losing platform
focus. Standalone runtime hosts retain the normal focus-loss suspension behavior.

Preview to editor:

- `ready`
- `capabilities`
- `command-result`
- `state`
- `preview-state`
- `preview-snapshot`
- `runtime-debug-snapshot`
- `runtime-asset-profiler`
- `runtime-debug-event`
- `runtime-fast-forward-result`
- `preview-diagnostic`
- `preview-object-selected`
- `preview-object-hovered`
- `preview-interacted`
- `preview-wheel`
- `fps-counter`
- `object-clicked`
- `runtime-error`

Coordinates are normalized from `0` to `1`, independent of canvas pixel size.

The widget also publishes `runtime-debug-snapshot` without a request ID whenever the active,
visible runtime's semantic debugger state changes. The comparison covers current entity/Room,
runtime mode, waiting and available-input state, variables, inventory, selection, and diagnostics;
publication-only revision churn does not produce debugger traffic. The publication summary also
contains `gameplayInstances`, a stable list of live Room, Character, and Interactable identities with
declared/runtime ownership and provenance (`declared`, `archetype`, `compiled-definition`, or
`clone`) plus optional source metadata. This lets editor tooling inspect runtime-created identities
without treating renderer occurrences as gameplay authority. Explicit `runtime-request-debug-snapshot`
remains available for initial synchronization and manual refresh.

`set-engine-settings` applies editor-wide preview diagnostics and rendering preferences to an
already-running host. Its optional settings are `showFpsCounter`, `fpsCap`, and
`rmluiRasterSnap`. Raster snapping accepts `all`, `geometry`, `text`, or `none`; changing it updates
the existing RmlUi render interfaces without rebuilding or reloading the preview iframe. These are
editor preferences and do not modify project data or exported player defaults.

### Asset profiler transport

Editor preview builds compiled with `NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=1` advertise
`asset-profiler-v1`. The capability is omitted unless both native exports exist. Ordinary Web/player
builds therefore expose neither profiler commands nor a misleading empty profiler state.

The editor requests either a complete owning snapshot or a sequence-based delta:

```ts
type AssetProfilerRequest =
  | {
      version: 1;
      type: 'runtime-request-asset-profiler';
      requestId: string;
      mode: 'full';
    }
  | {
      version: 1;
      type: 'runtime-request-asset-profiler';
      requestId: string;
      mode: 'delta';
      sessionId: string;
      afterSequence: string;
    };
```

Delta cursors are canonical unsigned-decimal strings. Full requests forbid cursor fields. Successful
requests emit `runtime-asset-profiler` with the same `requestId`, followed by the normal successful
`command-result`. Native unavailable/session/cursor/validation failures use only the failed
`command-result` path and emit a preview diagnostic; they do not emit a partial profiler payload.

The widget calls only the two narrow native exports
`noveltea_asset_profiler_snapshot()` and `noveltea_asset_profiler_delta(session, sequence)`. It parses
their typed `{ok,payload|error}` JSON envelope, verifies schema version 3 and the full/delta outer
shape, and then posts the owning payload. The shared renderer protocol performs the exact recursive
validation before data can reach editor profiler state. All `uint64_t` values remain decimal strings
through this boundary, including values larger than JavaScript's safe-integer range. The complete
wire DTO and retained-event rules are documented in `ASSET_PROFILER_HANDOFF.md`.

The renderer controller owns request cadence and permits only one profiler request in flight. Opening
or revealing Asset Performance requests a full snapshot when no cursor exists, then polls deltas from
the last accepted sequence. Hiding the panel stops polling but leaves the engine session intact.
Responses are accepted only when their preview instance, request ID, session, and sequence are still
current. A session change, stale cursor failure, or `historyGap` discards derived editor history and
requests a replacement full snapshot. Preview replacement, project closure, and host teardown cancel
the controller and clear the store so a late iframe response cannot repopulate a new session.

Authored Layout preview display configuration is part of the atomic `load-preview-document` or
`update-preview-document` command. The `environment` field is a sibling of `document`, not metadata
inside the authored Layout record. It carries the effective profile name and native resolution, the
authored Layout scale policy, and the current project reference resolution, world-raster policy, bar
color, and accessibility policy. The widget forwards the document kind, document data, and
environment to the native typed decoder. The engine uses the effective profile native resolution as
the authored preview presentation reference, retains the project display and accessibility policy
from the same environment, and transactionally commits presentation and RuntimeUI context metrics
before `LayoutRealizer` loads the document in its resolved `LayoutScaleDomain`. Layout loads without
the complete environment are rejected; non-Layout previews must not carry it.

There is no separate display-profile command. Project/custom profile controls are editor-owned and
affect an authored Layout only by rebuilding the environment sent with that Layout load or update.
The command succeeds only after the environment and document have been accepted together.

The authored environment is temporary to the Layout preview. The engine snapshots the prior
presentation and runtime user scales before the first authored load, reuses that baseline across
authored updates, and restores it transactionally before a non-Layout preview document is loaded.

Custom profile controls remain editor-owned inputs to the authored environment. The iframe still
fills its current preview placeholder without React-side aspect fitting or transforms. The widget
reports its actual surface, coalesces resize observations to the latest complete tuple, suppresses
duplicate engine resizes, and leaves viewport fitting and presentation bars to the engine.
CSS-size-stable DPR changes are genuine resize transactions: the widget keeps the same iframe,
document, and runtime state, updates the backing buffer and host framebuffer metrics, and lets RmlUi
and ActiveText rerasterize against the newly committed context environment.
`runtime-load-compiled-project` carries the canonical `noveltea.compiled.project` value and may
include preview-only asset mappings with a project-relative
source path and the runtime package path. `web/widget.html` fetches those files from
the loopback server and stages them into the Emscripten `project:/` mount before
loading the compiled project. This keeps the live Play tab's asset layout identical
to exported packages, where referenced images are stored under paths such as
`textures/<asset>.<ext>`.

The renderer-side `PreviewManager` owns preview session records, bounded entity
preview requests, manager diagnostics, replay state, and thumbnail request/cache
state. The low-level hook remains the MessageChannel transport adapter.

Authoring-preview messages are explicit typed protocol messages. Engines or
shells that do not yet implement a mode should return a failed `command-result`
or a `preview-diagnostic`; they should not accept generic eval or arbitrary JSON
commands.

Full-game preview does not transport presentation interpolation state. Background/actor/Layout and
world-composition operations are engine-owned, revision-bound coordinator work. `runtime-reset` and
successful project replacement terminate transient realization and reconcile the current target
snapshot. Backend validation or resource failures are forwarded through `runtime-error` or
`preview-diagnostic`; preview transport must not fabricate a completed acknowledgement.

## Editor-Managed Authoring Previews

Editor-authored preview content is sent over the MessageChannel protocol. It is
not passed through startup arguments such as `--rmlui-document` and it is not
looked up from project assets unless the preview document explicitly references
an asset-mode source.

Room, Layout, and Shader editor previews use the focused-document path. The renderer sends
`apply-focused-editor-document` with an immutable document revision and an explicit resource
manifest. `web/widget.html` validates and stages the manifest, projects only native-visible fields,
and calls the typed `noveltea_preview_apply_editor_document` boundary. The older
`load-preview-document` / `update-preview-document` bridge remains only for preview kinds that have
not migrated; Room, Layout, and Shader code must not add dependencies on it. Room preview has no
generated-RML fallback, Room-v1 builder, recursive
project-object asset scan, compiled-project load, or iframe reload path.

Authoring hosts are visual-only engine instances. Their iframe URL includes `audio=0`, which
`web/widget.html` translates to the native `--no-audio` run argument. This prevents every open
preview tab from opening a separate miniaudio/WebAudio output device while preserving audio in the
Play preview through its explicit opt-in. All preview iframes share one loopback server session;
reloading one iframe remounts that iframe against the stable session and must not rotate the token
used by peer hosts.

The focused Room environment carries project reference resolution, world-raster policy, bar color,
and accessibility scale policies through native decoding and environment preparation. The built-in
focused Game HUD resolves from the canonical packaged path
`system:/ui/runtime/runtime_game.rml`.

`FocusedPreviewCoordinator` is the sole freshness owner for migrated roots. It consumes immutable
project publications, the previous/current graph union, adapter inputs, lease
generation/capabilities, and resource staging state. The graph union preserves invalidation when a
relationship was removed or moved and therefore exists only in the previous graph. The coordinator
coalesces updates to one in-flight apply and one latest pending state, deduplicates canonical
revisions, replays after reconnect, and accepts completion or diagnostics only for the current
project/root/lease/apply sequence. Adapter/build failures publish a manager diagnostic for the
focused target. Same-root failure keeps the committed visual; new-root failure keeps the host hidden.
Current apply failures do not automatically resubmit the identical document every animation frame;
the next immutable publication, ready event, or lease replay is the retry boundary. Focused applies
use a 30-second transport timeout rather than the generic five-second command timeout because native
mandatory-asset preparation completes asynchronously.

Native Layout and Shader application uses the same prepared-publication rule as Room. Candidate RML
documents are realized under hidden, generation-scoped IDs while the committed documents stay
visible. Layout display-environment changes and Shader environment restoration are prepared as
commit closures; candidate materials are bound only during preparation. After every fallible source,
Lua, document, material, Shader-program, and resource step succeeds, publication consists only of
non-failing environment/material/document/lease swaps. A rejected candidate unloads only its hidden
documents and leaves the prior environment, Lua environment, material project, virtual-file state,
and visual owner unchanged. The focused path must not call the legacy mutating standalone document
routine as its final commit.

NovelTea's dedicated RmlUi Lua-listener lifetime patch makes inline event listeners retain the Lua
state and listener-function table from document creation.
Focused Layout publication may replace the active Lua global environment before RmlUi performs its
deferred destruction of an unloaded document. Listener dispatch and destruction therefore must not
look up `EVENTLISTENERFUNCTIONS` through the mutable current environment; doing so can address the
wrong table or pass a non-table to `luaL_unref`, corrupting the WebAssembly renderer process.

RmlUi memory-document base URLs use parser-compatible `scheme://path` syntax even though canonical
engine asset identities remain `scheme:/path`. This conversion is presentation-boundary-only and
must not alter manifest identities or asset-manager paths.

A successful focused Room, Layout, or Shader publication also retires the legacy standalone preview
document used by Character, Dialogue, Scene, and Material previews. This retirement happens only at
the non-failing publication boundary, after focused candidate preparation succeeds. Without it, a
host can correctly apply Room state while the previously loaded legacy RML document remains above
the focused world and HUD, making the stale preview appear to persist.

The focused native envelope is closed and versioned:

```ts
{
  protocol: 'noveltea.focused-editor-document',
  protocolVersion: 2,
  requestId,
  applySequence,
  projectInstanceId,
  resourceStageGeneration,
  kind: 'room-preview' | 'layout-preview' | 'shader-preview',
  recordId,
  revision: 'sha256:...',
  resourceRevision: 'sha256:...',
  resources: [
    {
      resourceId: 'asset:background',
      sourceKind: 'authoring-asset',
      logicalPath: 'project:/assets/background.png',
      contentHash: 'sha256:...',
      byteSize: 1234,
      kind: 'image',
      assetId: 'background',
    },
  ],
  data: {},
}
```

The editor-facing manifest carries semantic usage roles plus one source-owned fetch authority.
Authoring Assets require the main-owned `noveltea-asset://source/` URL in `fetchUrl`; compiled Shader
outputs require `fetchProjectRelativePath`. These fields are used only by the web staging layer and
are omitted from the native projection.
Compiled Shader entries identify the stage and one closed renderer variant (`glsl-120`, `essl-100`,
or `essl-300`) and carry verified binary hash, byte size, and compile-input fingerprint metadata in
the authoring record/cache output. Metadata-bearing outputs are admitted only when their fingerprint
matches the current normalized authoring input. Runtime paths are canonicalized once: the native
logical path remains `project:/shaders/...`, while the web fetch path is
`.noveltea/build/shaders/...`. Authoring validation rejects non-canonical paths and two stages that
claim the same output path for one variant.

Resource staging is generation-based and fail closed. Every fetched response is bounded while
streaming, checked against declared `Content-Length` when present, checked for exact byte count, and
SHA-256 verified before publication. Candidate files live under a project-instance/generation root.
Logical `project:/` links are prepared first and published as one rollback-capable transaction; a
failed multi-resource swap restores all previously reachable links and leaves the committed map and
generation unchanged. A successful publication removes resources omitted by the new manifest. The
native apply is attempted only after staging commits. Room, Layout, and Shader candidates all pass
their resources through the mandatory typed-asset gate before changing visuals. Candidate material
definitions are bound while material and Shader-program preparation tasks are created, so a Room
candidate cannot resolve against the previously committed material project. Only native `applied` or
`unchanged` completion confirms the editor command.

Focused command supersession begins at MessageChannel ingress. The widget assigns the next apply
sequence and aborts the prior staging fetch before the command enters the sequential drain. This is
required because a slow Layout fetch must not prevent a newer Room command from establishing itself
as the latest desired owner; publication itself remains sequential and rollback-capable.

The ready handshake includes a positive host generation and the active closed Shader variant. A
host lease accepts completions only from its current generation. Focused request limits are
shared between TypeScript and C++: 16 MiB request bytes, 4 MiB source strings, 16 KiB ordinary
strings, JSON depth 64, 512 Layouts, 16,384 resources, 8,192 array items, and 8,192 admission items per
source. Resource bytes are separately limited to 128 MiB per resource and 512 MiB in aggregate.

The embedded engine iframe should be treated as a neutral rendering surface. In
practice this is handled by `web/widget.html`, not `web/shell.html`:

```text
Editor tab
-> builds typed PreviewDocument from current editor state
-> EnginePreview(chrome="minimal", previewDocument=..., previewMode=...)
-> useEnginePreview().setPreviewMode(mode)
-> useEnginePreview().loadPreviewDocument(document, environment)
-> web/widget.html validates the document kind
-> web/widget.html forwards document kind/data and the optional typed environment
-> C++ preview decoder validates the boundary payload
-> PreviewHost applies the RmlUi/shader/runtime preview
```

The legacy-shaped example below illustrates the Layout data carried inside the focused document's
`data` field; the outer command is `apply-focused-editor-document`, not a startup argument:

```ts
{
  version: 1,
  type: 'load-preview-document',
  requestId,
  document: {
    kind: 'layout-preview',
    recordId: layoutId,
    revision,
    data: {
      layoutKind: 'document' | 'fragment',
      scalePolicy: { ui: 'inherit' | 'ignore', text: 'inherit' | 'ignore' },
      rml: { sourceMode: 'inline', sourceText: '...' },
      rcss: { sourceMode: 'inline', sourceText: '...' },
      lua: { sourceMode: 'inline', sourceText: '...' },
      script: { enabled: true, namespace: 'layout_preview' },
      mount: { defaultParent: 'nt-layout-preview-mount' },
      dependencies: { images: [], fonts: [], stylesheets: [], scripts: [], materials: [] },
      preview: { background: 'dark' },
    },
  },
  environment: {
    profile: {
      name: 'project',
      nativeResolution: { width: 1920, height: 1080 },
      scalePolicy: { ui: 'inherit', text: 'inherit' },
    },
    project: {
      referenceResolution: { width: 1920, height: 1080 },
      worldRasterPolicy: 'capped',
      barColor: '#000000',
      accessibility: {
        uiScale: { enabled: true, minimum: 0.75, maximum: 2 },
        textScale: { enabled: true, minimum: 0.75, maximum: 2 },
      },
    },
  },
}
```

The Layout record does not carry authored preview dimensions. The iframe/canvas follows the current
preview host size, and the engine owns presentation fitting inside that surface. The command-level
environment must agree with the Layout's authored `scalePolicy`; the editor derives both from the
same current record before transport.

For `layoutKind: 'document'`, the shell/runtime uses the supplied RML as the
preview document and injects the inline RCSS into the document head for the
current bridge. For `layoutKind: 'fragment'`, the shell/runtime wraps the
fragment in an internal host document and injects the RCSS there. Lua source is
part of the preview document shape and should be applied by the runtime bridge;
until that bridge is complete, the source should still be transported in the
same document rather than moved to startup flags.

Shader previews use the same pattern: the shader editor builds a
`shader-preview` document and the runtime bridge applies it to an internal
centered-square RmlUi template. Internal templates may be bundled under
`editor/assets/internal-preview`, but those templates are implementation
details. User-edited RML/RCSS/Lua remains data owned by the editor and sent over
the focused document path.

Embedded authoring previews should use `EnginePreview` with `chrome="minimal"`.
That variant has no runtime demo toolbar, no global latest-preview replay, and
no shared editor-preview document state. Each layout/shader editor passes its
own `previewDocument` directly so switching tabs does not replay a previous
shader or layout document. The full runtime preview tab may still use the default
`chrome="runtime"` variant with runtime controls and primary preview replay.

### Embedded preview wheel ownership

Pooled derived authoring previews use `wheelPolicy="editor-scroll"` by default.
Their iframe hosts live in an absolute preview layer rather than inside the
editor's logical scroll hierarchy, so ordinary browser scroll chaining cannot
identify the correct editor container.

`web/widget.html` installs a capture-phase, non-passive wheel listener before
the generated Emscripten script. For `editor-scroll` previews, that listener
calls `preventDefault()` and `stopImmediatePropagation()` before SDL's canvas
listener runs, then sends a typed `preview-wheel` event over the existing
preview `MessageChannel`.

Each pooled claim configures the iframe with `set-preview-wheel-routing`, which
includes the current lease ID as the wheel route ID. The iframe includes that
route ID in every `preview-wheel` event. This lets the pool reject messages
queued by a previous owner after a warm host has been reassigned.

The renderer verifies that the route ID still identifies the current, visible,
active `editor-scroll` lease. It then resolves the corresponding `PreviewPane`
placeholder and applies the delta to its nearest eligible scroll
ancestor, chaining residual movement outward at scroll boundaries. Routing must
start from the placeholder, never from the absolute iframe host. Pixel deltas
remain fractional; line and page deltas are normalized in the renderer.

Dedicated full-game/runtime previews use `preview-input`, so their wheel input
continues to reach SDL/RmlUi normally. Ctrl/Meta-modified wheel gestures are
left on the preview input path instead of being converted into editor scrolling.

Do not route embedded-preview wheel input through Electron's
`webContents.before-mouse-event`. That event was not delivered consistently for
wheel input under the supported WSLg development environment. The iframe-side
listener avoids native coordinate hit testing and does not depend on iframe
focus.

Startup flags remain valid for coarse engine boot configuration only, such as
`--preview-widget`, `--demo none`, `--no-imgui`, or test fixtures. They should
not be used for editor owned content like the current layout's RML, RCSS, or Lua
source. The `--preview-widget` flag suppresses automatic loading of the default
runtime UI so the widget does not flicker from the game/sandbox layout to the
editor-provided preview document.

## Adding Editor To Engine Commands

Example: add `set-background-color`.

1. Add the typed message to `EditorToPreviewMessage` in
   `editor/src/shared/preview-protocol.ts`.

```ts
| {
    version: 1;
    type: 'set-background-color';
    requestId: string;
    color: { r: number; g: number; b: number };
  }
```

2. Update the runtime validator in `preview-protocol.ts`. Do not rely only on
   TypeScript; iframe messages are untrusted at runtime.

3. Add a method in `use-engine-preview.ts`.

```ts
setBackgroundColor: (color) =>
  send({ type: 'set-background-color', color })
```

4. Handle the command in `web/widget.html`.

```js
} else if (message.type === 'set-background-color') {
  Module._noveltea_preview_set_background_color(
    message.color.r,
    message.color.g,
    message.color.b
  );
  send({
    version: 1,
    type: 'command-result',
    requestId: message.requestId,
    ok: true
  });
}
```

5. Add a narrow exported C function.

```cpp
extern "C" EMSCRIPTEN_KEEPALIVE
void noveltea_preview_set_background_color(float r, float g, float b)
{
    if (noveltea::g_preview_engine) {
        noveltea::g_preview_engine->set_background_color(r, g, b);
    }
}
```

6. Add the exported symbol in `apps/editor_preview/CMakeLists.txt`.

```cmake
'_noveltea_preview_set_background_color'
```

7. Implement the engine method and renderer behavior.

Keep commands explicit. Do not add a generic JSON command interpreter.

## Adding Engine To Editor Events

Example: add `object-hovered`.

1. Add the event type to `PreviewToEditorMessage` in
   `editor/src/shared/preview-protocol.ts`.

2. Update `isPreviewToEditorMessage()`.

3. Add a C++ bridge declaration.

```cpp
void emit_object_hovered(
    const char* object_id,
    preview_bridge::NormalizedPosition pointer_position);
```

4. Implement the bridge in `engine/src/preview/preview_bridge.cpp` with
   `EM_JS`, `EM_ASM`, or an equivalent Emscripten mechanism.

Use `UTF8ToString` for C strings. Do not interpolate JSON manually from
arbitrary string data.

5. Call the bridge from engine logic.

6. Handle the event in React and/or Zustand.

```ts
if (message.type === 'object-hovered') {
  setLastPreviewEvent(message);
}
```

## Security Rules

- Use Electron IPC only for privileged setup, such as preview session creation.
- Use MessageChannel for live preview commands and events.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and Electron
  sandboxing enabled.
- Do not expose `ipcRenderer`, generic `send`, generic `invoke`, filesystem
  APIs, or arbitrary HTTP server controls.
- Bind the preview server only to `127.0.0.1`.
- Do not use Electron `webview`, `BrowserView`, `WebContentsView`, native
  child-window embedding, WebSockets, or a separate backend service for this
  preview path.
- Validate all incoming protocol messages at runtime.

## WSL2 And WebGL Notes

When running the editor from WSL2, Electron may blocklist hardware WebGL or use
a weak GPU path. The editor main process currently opts into Chromium fallback
paths with:

```ts
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
```

These are for the local development editor preview. The engine preview still
uses the normal Emscripten/bgfx canvas path.
