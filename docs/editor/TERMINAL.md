# Embedded Terminal

## Current ownership

The embedded Terminal is a globally available bottom-panel surface. The renderer uses xterm.js only as
the terminal emulator/view; Electron main owns the PTY through `TerminalService` and `node-pty`.
Unmounting the Terminal view, collapsing the bottom panel, switching bottom-panel surfaces, or
switching/closing a Project does not terminate or retarget the PTY.

The first PTY is created lazily when the Terminal surface first mounts. Reopening the view asks main
for the existing session and reconstructs xterm from main's bounded in-memory output buffer. Terminal
state is window-lifetime state and is not serialized into Project editor metadata; a Project may still
persist `terminal` as its active bottom-panel identity.

## Creation authority

Terminal creation IPC has no renderer-provided shell or cwd arguments. Main resolves a new session cwd
in this order:

1. the main-owned active Project root, when a Project is open;
2. the editor-wide Terminal fallback cwd stored in user preferences when it exists and resolves to a
   directory; and
3. NovelTea's effective default Project directory (`Documents/NovelTea` by built-in default).

Existing sessions keep their original cwd when Project context changes. On POSIX, main prefers the
user's existing `SHELL` when it resolves to an executable path, then zsh/bash/sh fallbacks. On Windows,
main prefers `pwsh.exe` from `PATH`, then Windows PowerShell. The shell inherits the ordinary editor
process environment; NovelTea does not inject tool-specific PATH entries.

## IPC and lifecycle

The preload exposes narrow guarded operations to ensure/retry the current session, write terminal data,
and resize the PTY. Session IDs are opaque UUIDs and write/dimension requests are strictly bounded.
Main emits typed output/exit/error events to the renderer. Spawn/native/cwd failures remain represented
as a visible terminal error with Retry rather than removing the surface.

`TerminalService` buffers output independently from the mounted xterm view and disposes the PTY on
window teardown. Multi-session ownership, command-state-aware close confirmation, shell-integration
metadata, and application-exit aggregation are later Terminal lifecycle work rather than part of this
initial single-session slice.

## Distribution

`node-pty` 1.1.0 is an explicitly admitted MIT-licensed native production dependency. Its production
package closure includes `node-addon-api` 7.1.1 and platform-native node-pty objects; Vite preserves
`node-pty` as an external runtime package, pnpm's native-build allowlist admits its install step,
production staging verifies the exact dependency and loads its native module, and electron-builder
unpacks the `node-pty` tree from ASAR. This Electron-main native module stays outside NovelTea's
engine/player C++ target graph; the boundary is documented in
`docs/architecture/CXX_RUNTIME_DEPENDENCY_POLICY.md`. Cross-platform PTY package smoke is qualified
separately from this initial slice.
