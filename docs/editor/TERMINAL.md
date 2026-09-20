# Embedded Terminal

## Current ownership

The embedded Terminal is a globally available bottom-panel surface. The renderer uses xterm.js only as
the terminal emulator/view; Electron main owns the PTY through `TerminalService` and `node-pty`.
Unmounting the Terminal view, collapsing the bottom panel, switching bottom-panel surfaces, or
switching/closing a Project does not terminate or retarget the PTY.

The first PTY is created lazily when the Terminal surface first mounts. Main owns a window-lifetime
multi-session host with a selected session identity, stable monotonic `Terminal N` labels, and bounded
per-session output buffers. Reopening/remounting the view asks main for the current host snapshot and
reconstructs the selected xterm view from that buffer. Terminal host state is not serialized into
Project editor metadata; a Project may still persist `terminal` as its active bottom-panel identity.
Once Terminal has been used, closing the final session immediately creates a fresh replacement using
the current new-terminal creation rules so the host never becomes empty during that window lifetime.

## Creation authority

Terminal creation IPC has no renderer-provided shell or cwd arguments. Main resolves a new session cwd
in this order:

1. the main-owned active Project root, when a Project is open;
2. the editor-wide Terminal fallback cwd stored in user preferences when it exists and resolves to a
   directory; and
3. NovelTea's effective default Project directory (`Documents/NovelTea` by built-in default).

Existing sessions keep their original cwd when Project context changes. Each session captures immutable
creation metadata: initial cwd, creation time, and the Project's durable id/name when a Project was the
creation context. The opaque active-Project session capability is never stored as terminal origin
metadata. New sessions after a Project switch use the new current Project context, while existing
sessions are never implicitly moved, restarted, renamed, or terminated. On POSIX, main prefers the
user's existing `SHELL` when it resolves to an executable path, then zsh/bash/sh fallbacks. On Windows,
main prefers `pwsh.exe` from `PATH`, then Windows PowerShell. The shell inherits the ordinary editor
process environment; NovelTea does not inject tool-specific PATH entries.

## Settings and keyboard behavior

Terminal settings are editor-wide resettable user preferences, not Project state. The current surface
stores a free-form CSS font stack (default `JetBrains Mono, monospace`), bounded 8–32 px font size,
nullable fallback cwd, bounded 100–100,000 line scrollback (default 10,000), and a desktop-notification
toggle that defaults enabled. Font family, font size, and scrollback changes update mounted xterm views
live and refit/resize the PTY; they never restart or retarget a running shell. Typed fallback cwd values
are admitted only after guarded main-process validation confirms an existing directory. Spaces are
allowed. Browse uses the native directory picker, and Reset restores automatic cwd resolution. The
fallback affects only terminals created with no open Project.

Ctrl/Cmd+` is the dedicated Terminal shortcut. It shows Terminal and selects it when another bottom
panel is active or the panel is hidden; invoking it again while Terminal is active hides the bottom
panel. The existing Ctrl/Cmd+J bottom-panel toggle is unchanged. While focus is inside xterm, ordinary
editor shortcuts such as Ctrl/Cmd+P are not claimed by the workspace so shell/TUI bindings reach the
PTY. Explicit application-level Terminal/bottom-panel shortcuts remain global. xterm selection copy is
handled without stealing Ctrl+C interrupt: Windows/Linux Ctrl+C copies only when a selection exists and
otherwise reaches the PTY; on macOS Cmd+C/Cmd+V retain clipboard semantics while Ctrl+C remains the
terminal interrupt.

## IPC and lifecycle

The preload exposes narrow guarded operations to ensure the host, create/select/close/relaunch a
session, write terminal data, and resize the PTY. Creation never accepts a renderer-selected shell or
cwd. Session IDs are opaque UUIDs and lifecycle/write/dimension requests are strictly bounded. Main
emits typed output/exit/error events to the renderer. Spawn/native/cwd failures remain represented as
an actionable terminal tab with Retry rather than removing the session.

A shell exit retains its tab, buffered scrollback, exit status, and immutable identity. Relaunch keeps
the same session identity and uses its last known cwd when available, otherwise the immutable initial
cwd. Main adds non-destructive shell integration for bash, zsh, and PowerShell without modifying user
startup/profile files. The integration reports semantic command start/completion, optional command exit
status, and live cwd through private terminal control sequences that are removed from visible output.
Preparation is fail-open: unsupported shells or unavailable integration continue as ordinary PTYs with
command state conservatively `unknown`, while BEL handling remains available. Runtime-only metadata
keeps the current command start, latest command timing/status, live cwd, and latest attention event; it
is never persisted as shell history. Exited/error sessions close immediately. The close IPC is
two-phase: an unforced close reports whether confirmation is required, and only an explicitly forced
follow-up terminates a risky PTY.

Terminal attention is renderer-window state rather than Project state. A semantic command completion
that occurs while its terminal is unseen becomes unread only when the command ran for at least three
seconds; BEL marks an unseen terminal unread independently of command lifecycle. Events on the exact
selected, visible terminal do not create unread state. Terminal tabs show running activity separately
from unread attention, with unread taking precedence, and the outer Terminal bottom-panel entry shows
one aggregate unread dot while any session remains unread. Reopening Terminal onto an already-selected
unread session waits about three seconds before beginning its fade; hiding Terminal before that delay
cancels passive acknowledgment. Directly selecting an unread terminal, or switching away from an unread
selected terminal, begins its fade immediately. Repeated events update the latest attention metadata
without multiplying unread state.

Native desktop notification projection is optional and privacy-safe. Renderer attention state requests
at most one notification for each unread period and only while the Terminal desktop-notification
preference is enabled. The guarded request carries only the opaque terminal session id plus the semantic
attention kind; renderer-provided titles, bodies, commands, cwd values, prompts, or output are never
accepted. Electron main independently suppresses requests while NovelTea is focused or when native
notifications are unsupported, resolves the stable `Terminal N` label from its own terminal host, and
generates generic notification text. Notification construction/show failures are fail-silent and never
affect PTY behavior. Clicking a notification restores/shows/focuses NovelTea, sends a typed session-id
click event to the renderer, opens Terminal, selects the originating session, and immediately begins its
unread acknowledgment fade. macOS signing/notification availability therefore cannot gate terminal
functionality.

Application/window close uses the existing renderer close handshake. Main reports one aggregate count
of running/unknown terminal sessions; the renderer asks for one confirmation before metadata cleanup
and confirmed shutdown. Completing the handshake disposes every window-owned PTY/process tree
best-effort before closing. Windows shutdown/logoff (`query-session-end`) and macOS/Linux system
shutdown (`powerMonitor`'s `shutdown` event) bypass the interactive terminal confirmation, do not call
`preventDefault()`, and perform immediate best-effort PTY cleanup rather than blocking the operating
system.

## Distribution

`node-pty` 1.1.0 is an explicitly admitted MIT-licensed native production dependency. Its production
package closure includes `node-addon-api` 7.1.1 and platform-native node-pty objects; Vite preserves
`node-pty` as an external runtime package, pnpm's native-build allowlist admits its install step,
production staging verifies the exact dependency and loads its native module, and electron-builder
unpacks the `node-pty` tree from ASAR. This Electron-main native module stays outside NovelTea's
engine/player C++ target graph; the boundary is documented in
`docs/architecture/CXX_RUNTIME_DEPENDENCY_POLICY.md`. Cross-platform PTY package smoke is qualified
separately from this initial slice.
