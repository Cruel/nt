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

## IPC and lifecycle

The preload exposes narrow guarded operations to ensure the host, create/select/close/relaunch a
session, write terminal data, and resize the PTY. Creation never accepts a renderer-selected shell or
cwd. Session IDs are opaque UUIDs and lifecycle/write/dimension requests are strictly bounded. Main
emits typed output/exit/error events to the renderer. Spawn/native/cwd failures remain represented as
an actionable terminal tab with Retry rather than removing the session.

A shell exit retains its tab, buffered scrollback, exit status, and immutable identity. Relaunch keeps
the same session identity and uses its last known cwd when available, otherwise the immutable initial
cwd. Shell integration is implemented by the later lifecycle slice; until semantic command state is
available, a live shell is conservatively `unknown`, so closing it requires confirmation. Exited/error
sessions close immediately. The close IPC is two-phase: an unforced close reports whether confirmation
is required, and only an explicitly forced follow-up terminates a risky PTY.

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
