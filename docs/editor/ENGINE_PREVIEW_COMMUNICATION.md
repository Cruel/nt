# Engine Preview Communication

This document describes how the Electron editor communicates with the
Emscripten NovelTea engine preview, and what to change when adding new preview
commands or runtime events.

## Overview

The editor embeds the web build of `apps/sandbox` in an iframe. It does not
embed or reparent the native SDL window.

There are two communication layers:

- Electron IPC: used for privileged preview setup and editor-tooling helper calls.
- MessageChannel: used for live editor-to-engine commands and engine-to-editor
  events.

Zustand remains the authoritative editor-side state. The engine owns runtime
state needed for rendering and hit testing.

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
helper's JSON response through typed preload IPC. This keeps Electron and Node
dependencies out of `noveltea_core`.

## MessageChannel Handshake

`web/shell.html` reads `sessionToken` from the iframe URL and sends a bootstrap
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
-> web/shell.html
-> Module._noveltea_preview_set_demo_position(x, y)
-> C++ Engine::set_demo_position()
-> bgfx renders the triangle at the new transform
```

The editor updates Zustand first. If the iframe reloads, the current Zustand
state is replayed when the preview sends `ready`.

## Engine To Editor Flow

Example: clicking the demo triangle.

```text
SDL mouse event
-> Engine::handle_mouse_down()
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
- Emscripten shell bridge:
  - `web/shell.html`
- C++ preview event bridge:
  - `engine/include/noveltea/preview_bridge.hpp`
  - `engine/src/preview/preview_bridge.cpp`
- C exports used by JavaScript:
  - `engine/src/app.cpp`
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
- `runtime-continue`
- `runtime-dialogue-option`
- `runtime-navigate`
- `runtime-select-object`
- `runtime-clear-object-selection`
- `runtime-run-action`
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
The `set-demo-position` and `reset-demo` commands remain compatibility commands
for the current sandbox preview. New editor UI should prefer runtime-named
commands.

The renderer-side `PreviewManager` owns preview session records, bounded entity
preview requests, manager diagnostics, replay state, and thumbnail request/cache
state. The low-level hook remains the MessageChannel transport adapter; React
editor tabs should request preview ownership through the manager instead of
creating arbitrary iframe transports.

Authoring-preview messages are explicit typed protocol messages. Engines or
shells that do not yet implement a mode should return a failed `command-result`
or a `preview-diagnostic`; they should not accept generic eval or arbitrary JSON
commands.

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

4. Handle the command in `web/shell.html`.

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
