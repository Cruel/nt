# Editor IPC Trust Boundary

## Purpose

Privileged renderer-to-main invocations must not treat possession of the preload API as proof that a
caller is the editor. The main process owns sender authorization, argument admission, and the window
navigation policy.

## Sender authorization

`editor/src/main/editor-ipc-trust-boundary.ts` provides the guarded invoke registrar. Before parsing
arguments or running a handler, it requires all of the following:

- the owning `BrowserWindow` and its `WebContents` are still live;
- the event sender is that exact owning `WebContents`;
- the event sender frame is the owning `WebContents`' current `mainFrame`; and
- the sender frame URL has the exact approved scheme, host, and port.

The packaged origin is `noveltea-editor://app`. Development uses only an HTTP loopback origin derived
from the explicit `NOVELTEA_EDITOR_DEV_SERVER_URL`; it does not admit remote hosts, HTTPS, alternate
ports relative to that configured origin, file URLs, or malformed URLs. A same-origin child frame
and a prior main frame after reload remain untrusted because frame identity is checked independently
of origin.

Authorization failure rejects with the stable `untrusted-sender` boundary code. The preload wrapper
normalizes Electron's serialized main-process error into an `EditorIpcBoundaryError` before it
crosses the context bridge. Renderer callers receive that exact machine-readable code as the error
message rather than Electron's transport-prefixed message; they must not depend on custom Error
properties, which Electron does not preserve across the bridge. Authorization runs before request
parsing and handler execution, and rejection detail must not include request values or local paths.

## Runtime request admission

A guarded registration receives IPC arguments as `unknown[]` and declares one exact runtime parser.
Parsing failure rejects with the stable `invalid-request` boundary code before its service runs.
Strict objects reject unknown keys, tuples reject missing or additional positional arguments, and
scalar fields must carry explicit bounds appropriate to the capability.

Application, window, dialog, and shell capabilities now use the guarded registrar. App information,
the default Project directory, zoom/window lifecycle state, and the Project/template selection dialogs
use exact no-argument tuples. Directory selection keeps its strict bounded options object; package
output selection accepts exactly one bounded path-or-null value; item reveal accepts exactly one
bounded path; native-frame changes accept exactly one boolean. External opening accepts exactly one
bounded absolute HTTP(S) URL and rejects malformed values and other schemes before `shell.openExternal`
runs. Window handlers operate on the main-owned editor window after sender authorization rather than
selecting a window from renderer-supplied event identity.

The active-Project close capability also uses the registrar with an exact no-argument tuple so only
the trusted editor frame can revoke the main-owned Project session. Project text-source reads use a
strict bounded request object through the same registrar before the active-session service can resolve
a path. Project open and saved-Project creation likewise use strict bounded path/request tuples before
a successful result may establish Project authority.

Every channel invoked by `editor/src/preload.ts` now has exactly one registration through this guarded
registrar and an explicit runtime argument parser. This includes Project content persistence,
editor-metadata persistence, Save As, workspace watcher start/stop, thumbnail/cache operations,
preview/playback/shader operations, export/template operations, Asset operations, and ComfyUI. Direct
channel-specific `ipcMain.handle(IPC_CHANNELS.*)` registrations are prohibited; there is no alternate
unguarded compatibility path.

## Editor document navigation

The owning editor window admits only its exact initial editor document:

- packaged: `noveltea-editor://app/index.html`;
- development: the normalized configured development-server URL.

Top-level navigation and top-level server redirects to any other document are prevented, including a
different same-origin path or query and `javascript:`, `data:`, and `file:` targets. Child-frame
redirects remain governed by their owning preview/iframe boundary. Window creation is denied.
Rejected top-level navigation never changes the approved document or origin.

## D-001, D-002, and D-014 closure

The three discovery findings are treated as one boundary rather than independent mitigations:

- **D-001 — renderer sender trust:** main accepts privileged invokes only from the owning live top-level
  editor document at the exact approved origin, with unexpected navigation/redirects prevented.
- **D-002 — unchecked privileged request forms / renderer-selected Project authority:** every preload
  invoke is parsed from `unknown` through a strict bounded tuple/object contract, and Project-scoped
  filesystem work derives its root from the current opaque `projectSessionId` instead of a renderer
  root or manifest path.
- **D-014 — Asset/source exfiltration:** original media is authorized by active-session Asset identity,
  canonical containment, regular-file/revision/size checks, and bounded streaming. ComfyUI edit upload
  additionally requires an admitted image and a pinned loopback HTTP destination with redirects
  disabled and a 32 MiB upload ceiling.

The current security invariant is therefore: a renderer invocation can affect Project files only when
it comes from the owning top-level editor document, parses against its declared current contract,
presents the current Project session where required, names an admitted capability, and passes the
operation's containment and resource limits.

## Verification

Focused tests in `editor/src/renderer/test/editor-ipc-trust-boundary.test.ts` use the guarded registrar
and navigation policy as public seams. They cover valid packaged and configured-development calls,
different or stale senders, child and remote frames, wrong origins, malformed requests, bounded app,
window, dialog, path, Project, export, Asset, and ComfyUI contracts, extra arguments, blocked
navigation and redirects, denied window creation, and absence of downstream service calls after
rejection.

`editor/src/renderer/test/ipc-boundary-inventory.test.ts` mechanically inventories preload invoke
channels against main registration source. It requires one guarded registration with a declared parser
for every preload invoke and fails if a channel-specific direct `ipcMain.handle` is added. Real
filesystem/session tests cover Project switching, lexical and symlink escape, non-regular/changed
sources and limits; ComfyUI tests add pinned-loopback upload and redirect/rebinding defenses. The
packaged smoke verifies the production editor origin plus the bounded original-Asset protocol through
real Electron IPC.
