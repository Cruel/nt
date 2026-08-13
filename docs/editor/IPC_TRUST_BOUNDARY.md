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
a successful result may establish Project authority. Existing invoke channels are not described as
guarded until they are migrated through the registrar with their own runtime parsers.

## Editor document navigation

The owning editor window admits only its exact initial editor document:

- packaged: `noveltea-editor://app/index.html`;
- development: the normalized configured development-server URL.

Top-level navigation and top-level server redirects to any other document are prevented, including a
different same-origin path or query and `javascript:`, `data:`, and `file:` targets. Child-frame
redirects remain governed by their owning preview/iframe boundary. Window creation is denied.
Rejected top-level navigation never changes the approved document or origin.

## Verification

Focused tests in `editor/src/renderer/test/editor-ipc-trust-boundary.test.ts` use the guarded registrar
and navigation policy as public seams. They cover valid packaged and configured-development calls,
different or stale senders, child and remote frames, wrong origins, malformed requests, bounded app,
window, dialog, path, and external-URL contracts, extra arguments, blocked navigation and redirects,
denied window creation, and absence of downstream service calls after rejection. The packaged smoke
also invokes the representative channel with an
invalid request and verifies the renderer-visible `EditorIpcBoundaryError` contract through real
Electron IPC.
