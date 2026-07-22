# Engine Preview Communication

This document describes how the Electron editor communicates with the
Emscripten NovelTea engine preview, and what to change when adding new preview
commands or runtime events.

## Overview

The editor embeds the web build of `apps/sandbox` in an iframe. It does not
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

- Electron IPC: used for privileged preview setup and editor-tooling helper calls.
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
still tears the host down. Derived entity previews remain pooled per tab group;
a persistent editor using such a preview transfers only its pool lease when it
moves. The full lifecycle and placement contract is documented in
`docs/editor/workbench/PERSISTENT_EDITOR_HOSTS.md`.

A newly claimed pooled lease must wait for that iframe's `ready` event before
sending its display, mode, or document payload. A warm host retains its ready
state across lease changes, so switching between widget tabs does not introduce
another startup wait.

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
build/web-debug/apps/sandbox
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
export are handled by a separate `noveltea-editor-tool` helper executable. The
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

## Editor To Engine Flow

Example: moving the demo triangle.

```text
React control
-> Zustand update
-> useEnginePreview().setPosition()
-> MessagePort postMessage({ type: 'set-demo-position' })
-> web/widget.html
-> Module._noveltea_preview_set_demo_position(x, y)
-> C++ SandboxDemoHarness::set_position()
-> bgfx renders the triangle at the new transform
```

The editor updates Zustand first. If the iframe reloads, the current Zustand
state is replayed when the preview sends `ready`.

## Engine To Editor Flow

Example: clicking the demo triangle.

```text
SDL mouse event
-> SandboxDemoHarness hit testing
-> point-in-triangle hit test
-> preview_bridge::emit_object_clicked()
-> EM_JS calls NovelTeaPreviewBridge.send(...)
-> MessagePort postMessage({ type: 'object-clicked' })
-> React hook receives event
-> Zustand updates selectedRuntimeObjectId
-> inspector and status bar re-render
```

Clicks outside the triangle produce no event.

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
- Editor helper service:
  - `editor/src/main/services/editor-tool-service.ts`
  - `tools/editor_tool/main.cpp`
- Emscripten normal web shell:
  - `web/shell.html`
- Emscripten editor preview widget shell:
  - `web/widget.html`
- C++ preview event bridge:
  - `engine/include/noveltea/preview_bridge.hpp`
  - `engine/src/preview/preview_bridge.cpp`
- C exports used by JavaScript:
  - `apps/sandbox/sandbox_app.cpp`
- Emscripten exported symbols:
  - `apps/sandbox/CMakeLists.txt`

## Current Protocol

Editor to preview:

- `set-demo-position`
- `reset-demo`
- `play`
- `stop`
- `request-state`
- `runtime-reset`
- `runtime-load-compiled-project`
- `runtime-continue`
- `runtime-dialogue-option`
- `runtime-navigate`
- `runtime-select-subjects`
- `runtime-clear-subject-selection`
- `runtime-run-interaction`
- `load-preview-document`
- `update-preview-document`
- `set-preview-mode`
- `request-preview-state`
- `request-preview-snapshot`

Preview to editor:

- `ready`
- `command-result`
- `state`
- `object-clicked`
- `runtime-error`
- `capabilities`
- `preview-state`
- `preview-snapshot`
- `preview-diagnostic`
- `preview-object-selected`
- `preview-object-hovered`

Coordinates are normalized from `0` to `1`, independent of canvas pixel size.

Authored Layout preview display configuration is part of the atomic `load-preview-document` or
`update-preview-document` command. Its typed environment carries the effective profile name and
native resolution, the authored Layout scale policy, and the current project reference resolution,
world-raster policy, bar color, and accessibility policy. The widget forwards that environment to
the native typed decoder. The engine uses the effective profile native resolution as the authored
preview presentation reference, retains the project display and accessibility policy from the same
environment, and transactionally commits presentation and RuntimeUI context metrics before
`LayoutRealizer` loads the document in its resolved `LayoutScaleDomain`. Non-Layout previews do not
carry this environment. The previous `set-preview-display-profile` command was removed because it
only acknowledged requests without changing runtime state.

The authored environment is temporary to the Layout preview. The engine snapshots the prior
presentation and runtime user scales before the first authored load, reuses that baseline across
authored updates, and restores it transactionally before a generic preview document is loaded.

Custom profile controls remain editor-owned inputs to the authored environment. The iframe still
fills its current preview placeholder without React-side aspect fitting or transforms. The widget
reports its actual surface, coalesces resize observations to the latest complete tuple, suppresses
duplicate engine resizes, and leaves viewport fitting and presentation bars to the engine.
The `set-demo-position` and `reset-demo` commands remain compatibility commands
for the current sandbox preview. New editor UI should prefer runtime-named
commands.

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

The embedded engine iframe should be treated as a neutral rendering surface. In
practice this is handled by `web/widget.html`, not `web/shell.html`:

```text
Editor tab
-> builds typed PreviewDocument from current editor state
-> EnginePreview(chrome="minimal", previewDocument=..., previewMode=...)
-> useEnginePreview().setPreviewMode(mode)
-> useEnginePreview().loadPreviewDocument(document)
-> web/widget.html validates the document kind
-> web/widget.html converts the document into narrow runtime calls
-> C++ preview bridge applies the RmlUi/shader/runtime preview
```

Layout editor previews send source text directly:

```ts
{
  kind: 'layout-preview',
  recordId: layoutId,
  revision,
  data: {
    layoutKind: 'document' | 'fragment',
    rml: { sourceMode: 'inline', sourceText: '...' },
    rcss: { sourceMode: 'inline', sourceText: '...' },
    lua: { sourceMode: 'inline', sourceText: '...' },
    script: { enabled: true, namespace: 'layout_preview' },
    mount: { defaultParent: 'nt-layout-preview-mount' },
    dependencies: { images: [], fonts: [], stylesheets: [], scripts: [], materials: [] },
    preview: { background: 'dark' }
  }
}
```

The Layout payload does not carry authored preview dimensions. The iframe/canvas follows the current
preview host size, and the engine owns presentation fitting inside that surface.

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
`load-preview-document` / `update-preview-document`.

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

6. Add the exported symbol in `apps/sandbox/CMakeLists.txt`.

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
