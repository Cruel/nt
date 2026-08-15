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

## Project-scoped persistence and watching

Project content saves, editor-recovery metadata writes, Save As source selection, and Project
workspace watcher start/stop requests carry `projectSessionId` instead of a renderer-selected Project
root or manifest path. The main process resolves the canonical root from the current session and
rejects random, stale, closed, or prior-Project ids before Project filesystem work begins. Content and
metadata persistence re-check that authority at the write boundary so a Project switch or close that
wins while validation or reconciliation is in flight cannot redirect or complete the old write.

A successful content save is reopened and refreshed against the same main-owned canonical root before
its authoritative result is exposed to the renderer. Successful metadata persistence likewise
refreshes that same authority before returning. A refresh that resolves to another root, a missing or
non-file manifest, or a session that became stale fails without rotating authority. Save As is the
explicit exception for choosing a new destination: the native directory dialog selects only the copy
destination, while the source root, default directory, assets, workflows, scripts, and agent bootstrap
are derived from the active session. Save As never changes the active Project identity.

The Project workspace watcher is admitted and torn down by session id. Watch batches retain the
main-owned root internally but publish only the session id plus Project-relative changed paths and the
assembled candidate. A successful assembled candidate refreshes the same active authority before the
event is sent; malformed or failed candidates do not mutate authority. The renderer accepts an event
only when its `projectSessionId` is still current, so a delayed Project A batch cannot reconcile into
Project B. Closing the active Project force-stops its watcher in main before revoking the session.

## Project-scoped Asset authority

The active session also owns the admitted Asset snapshot from the last successful main-owned Project
lifecycle result. Asset import, reimport, audit, untracked-file admission, trash, restore, and purge
requests carry `projectSessionId`; renderer-selected Project roots and manifest paths are not accepted.
Main derives the Project root from the session and re-checks authority at dialog/filesystem mutation
boundaries so a close or switch cannot redirect an in-flight Asset operation.

Successful Project content publication and successful external reconciliation refresh the admitted
Asset identities and source metadata before their results become current. A malformed candidate or
failed refresh leaves the previous snapshot unchanged. Image-thumbnail requests additionally name an
Asset id. Main verifies that the id is an admitted image Asset and that its Project-relative source,
content revision when supplied, intrinsic dimensions, orientation, and sampling agree with the active
snapshot before source filesystem access. Session authority is re-checked after asynchronous path
resolution, so Project A thumbnail work cannot continue reading after Project B replaces it.

## Preview, validation, playback, and shader boundaries

Preview-session access, preview reload, exported-package preview admission, and Project shader
compilation are privileged renderer-to-main capabilities. Their IPC handlers use the shared guarded
registrar and strict bounded runtime argument parsers. Preview and shader requests carry the opaque
`projectSessionId`; main rejects a stale or prior-Project session before mutating preview state,
starting a compiler/tool operation, or resolving Project filesystem paths.

The engine preview server receives its Project manifest path only after main resolves the current
session's canonical root. Shader compilation similarly derives `projectRoot`, `.noveltea/build`, and
`.noveltea/cache` in main. The renderer can select compile controls such as the requested shader
variants, but it cannot nominate a Project root, output root, or cache root through the preload
contract.

Project validation and playback requests that operate only on supplied in-memory data do not require
filesystem authority, but they still cross the same guarded IPC boundary. Their authoring/compiled
Project payloads and playback specs are admitted through current strict schemas with bounded ids,
arrays, numeric controls, and argument counts before the validation or native playback service is
called. Extra fields and alternate request shapes are rejected rather than treated as compatibility
forms.

## Export and player-template authority

Runtime package export, direct platform staging, platform export orchestration, and cancellation are
admitted through the trusted editor IPC boundary. Project-derived export operations require the
current `projectSessionId`; main resolves the canonical Project root from that session before any
package, staging, signing, subprocess, or Project filesystem work begins. Platform export IPC no
longer accepts `projectRoot` or `projectPath` from the renderer. Main supplies both from active
authority, and prepared package sources, shader build roots, icon sources, and other Project-derived
filesystem inputs are checked against that root before native work starts.

Output files and output directories remain explicit user-selected destinations rather than Project
authority. Player-template registry operations likewise remain explicit non-Project capabilities,
but list, inspect, install, download, remove, and resolve requests now cross the trusted IPC seam with
strict bounded schemas for identifiers, archive paths, hashes, collections, and options. Export
cancellation is session-bound so a stale Project cannot cancel work owned by the current Project.
Malformed or untrusted requests are rejected by the IPC registrar before export, download, signing,
staging, or template services run.

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
cover canonical activation, same-root refresh, rejected cross-root refresh, root rotation, activation
failure, close and teardown revocation, Project A-to-B isolation before filesystem access, and the
retained text-source rules. Persistence, Asset, thumbnail, and watcher tests additionally cover
authority loss before mutation/source access, Save As revocation after destination selection,
session-tagged reconciliation, admitted-Asset matching, and watcher routing. Project content save,
metadata save, Save As, and watcher start/stop are themselves guarded IPC registrations with strict
runtime argument parsers; `ipc-boundary-inventory.test.ts` certifies that there is no direct invoke
registration bypass for these or any other preload channel.
