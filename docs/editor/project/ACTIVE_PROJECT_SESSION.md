# Active Project Session

## Purpose

The Electron main process owns the authority for the active Project. Renderer state receives only an
opaque `projectSessionId`; it does not establish Project filesystem authority by sending a Project
path back to the main process.

## Lifecycle

A successful current-schema Project open or saved-Project creation canonicalizes the returned
`project.json` path and activates its canonical Project Workspace root. A successful content save
does not nominate or replace authority; session-bound persistence refresh belongs to the persistence
boundary. Refreshing the same canonical root retains the session id; activating a different root
replaces it with a new cryptographically random id. Canonicalization or manifest file failure leaves
the service's existing authority unchanged and does not publish a session id for the failed result.

Choosing to switch Projects explicitly closes the previous main-owned session before the new open.
Closing the active Project uses the same guarded capability. Window destruction and application
shutdown also revoke the session, including teardown paths that do not complete renderer cleanup.
Save As remains a copy operation and does not change the active Project identity.

## Project-scoped reads

Project text-source requests carry `projectSessionId` and Project-relative source entries. The main
process compares the id with the current session before resolving or reading any filesystem path.
Random, stale, closed, and prior-Project ids therefore fail as `stale-session` without filesystem
access. A rotation or revocation that occurs while a read is in flight invalidates the entire batch
before any Project A bytes can be published after Project B becomes active.

After session admission, text-source reads retain deterministic request ordering, fatal UTF-8
decoding with BOM reporting, content-hash verification, safe Project-relative paths, symlink
containment, regular-file checks, and the declared per-file, aggregate, and batch limits in
`editor/src/shared/project-text-sources.ts`. File handles read at most the remaining limit plus one
sentinel byte, so file growth after metadata admission cannot bypass the actual-byte ceilings. The
opened descriptor is no-follow where the platform exposes that flag, rechecked against the canonical
root, and compared with the reopened path identity before its bytes are admitted.

There is one current contract name: `projectSessionId`. Do not add the retired text-read-specific
name as an alias or secondary reader.

## Verification

`editor/src/renderer/test/active-project-session.test.ts` uses real temporary Project Workspaces to
cover canonical activation, same-root refresh, root rotation, activation failure, close and teardown
revocation, Project A-to-B isolation before filesystem access, and the retained text-source rules.
