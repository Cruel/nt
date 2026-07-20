# Project Structural Command Persistence Map

This document is the Phase 4 classification contract for editor mutations that may bypass normal
tab-scoped Save. `STRUCTURAL_AUTO_COMMIT_RULES` in
`editor/src/renderer/project/structural-command-persistence.ts` is the executable registry. An
`auto-commit` request that does not match a command type and allowed logical origin in that registry
is rejected before its working-document patches are applied.

## Auto-commit contract

Every eligible command produces one `AutoCommitPlan` containing patches calculated against the
saved baseline, the working-document patches, persisted forward and inverse baseline patches,
complete affected paths, any identity remap, any coordinated filesystem operations, and one declared
unsafe-rebase policy. The command store serializes structural persistence and blocks another command,
Undo, or Redo while the write is pending. Persisted Undo and Redo reuse the stored inverse or forward
baseline patches and rebase recovery overlays again.

`reject-command` restores the pre-command working document and removes the failed history entry when
overlap, precondition, remap, filesystem, or content-write safety cannot be proved.
`convert-to-manual-save` retains the working mutation as an ordinary dirty save unit and removes its
auto-commit plan; it never writes the complete working document.

## Classified auto-commit mutations

| Surface | Command / origin | Persistence target | Complete affected-path rule | Filesystem operation | Identity remap | Unsafe policy |
| --- | --- | --- | --- | --- | --- | --- |
| New Entity Wizard record creation | `entity.createRecord`; `workflow:new-entity` | Project content | `/<collection>/<entityId>` plus every actual patch path emitted by the handler | None | None | `convert-to-manual-save` |
| New room plus entrypoint transaction | transaction containing `entity.createRecord` and `project.setEntrypoint`; `workflow:new-entity` | Project content | `/rooms/<entityId>` and `/entrypoint`, retained as one atomic command group | None | None | `reject-command` for the committed transaction |
| Explorer duplicate | `entity.duplicateRecord`; `structure:<collection>` | Project content | `/<collection>/<targetId>` and every actual handler patch path | None | None | `convert-to-manual-save` |
| Explorer rename | `entity.renameId`; `structure:<collection>` | Project content | Source remove path, destination add path, record `id`, and every rewritten entrypoint, reference, and editor-metadata path emitted by the handler | None | `record:<collection>:<fromId>` and every descendant path remap to `record:<collection>:<toId>` | `reject-command` |
| Explorer delete | `entity.deleteRecord`; `structure:<collection>` | Project content | `/<collection>/<entityId>` plus any record-metadata path emitted by the handler; forced deletion does not silently rewrite remaining references | None | None | `reject-command` |
| File-dialog asset import from Explorer or the workspace | `asset.importFiles`; `workflow:asset-import`; `fileOrigin: copied-by-import` | Project content | One `/assets/<assetId>` add path per imported asset | The import service copied each declared `projectRelativePath` before command execution. Handler failure or content-write failure moves those copies to project trash; Undo trashes them; Redo restores them. | None | `convert-to-manual-save` |
| Untracked-project-file registration | `asset.importFiles`; `workflow:asset-import`; `fileOrigin: existing-project-file` | Project content | One `/assets/<assetId>` add path per registered asset | The file predates the command and remains in place after failure or Undo. | None | `convert-to-manual-save` |
| Generated-image asset insertion | `asset.importFiles`; `workflow:image-generation-assets`; `fileOrigin: generated-project-file` | Project content | One `/assets/<assetId>` add path per inserted revision | The generated revision predates asset registration and remains available to the generation workflow after failure or Undo. | None | `convert-to-manual-save` |
| Asset deletion | `asset.deleteAsset`; `structure:assets` | Project content | `/assets/<assetId>` and every actual alias/reference cleanup patch emitted by the handler | Move the project-owned source file to project trash before the content write; restore it on failed write or Undo; trash it again on Redo | None | `reject-command` |
| Explorer presentation options | `project.setExplorerOptions`; `project:explorer-options` | Editor metadata | Exact changed descendants under `/editor/explorer` | None | None | `convert-to-manual-save` |
| Explorer hidden collections | `project.setHiddenCollections`; `project:explorer-options` | Editor metadata | `/editor/explorer/hiddenCollectionKeys` | None | None | `convert-to-manual-save` |
| Successful-export identity compatibility write | `project.replaceAtPath`; `workflow:successful-export-identity` | Project content until the Phase 7 metadata-only cutover | `/settings/app` as emitted by the current compatibility command | None | None | `convert-to-manual-save` |

`project.applyPatch` with a `workflow:*` origin is registered only for explicit workflow-owned atomic
patch commands and contract tests. Its affected set is exactly the canonical union of every JSON
Patch path. Production tab edits and dirty-unit discard remain `manual-save`; an arbitrary
`project.applyPatch` origin is not eligible for auto-commit.

## Structural mutations that remain normal save units

| Surface | Commands | Save unit / policy | Affected paths and notes |
| --- | --- | --- | --- |
| Record label, description, tags, and color | `entity.updateMetadata` | `record:<collection>:<entityId>` / `manual-save` | The record path and `/editor/recordMetadata/<collection>/<entityId>` paths emitted by the handler. These are content edits, not Explorer auto-commit structure. |
| Chapters: create, rename, color, delete, assign | `project.createChapter`, `project.renameChapter`, `project.setChapterColor`, `project.deleteChapter`, `project.assignChapters` | `project:chapters` / `manual-save` | `/editor/chapters/records/<chapterId>`, `/editor/chapters/order`, and assignment paths under `/editor/recordMetadata/<collection>/<entityId>/chapterIds` as emitted by each handler. |
| Tags: color and unused-tag removal | `project.setTagColor`, `project.removeAtPath` | `project:tags` / `manual-save` | `/editor/tags/records/<tagKey>` or the exact remove path. Record tag assignment remains owned by the edited record save unit. |
| Entrypoint edits outside New Entity Wizard | `project.setEntrypoint` | `project:settings` / `manual-save` | `/entrypoint`. Only the New Entity Wizard's create-plus-entrypoint transaction is structural auto-commit. |
| Explorer move or reorder | No current content command | Not applicable | The current Explorer has no record move/reorder persistence command. Tab movement and tree presentation are workbench/editor state, not project structure. Adding such a command requires a registry entry and this map update before using `auto-commit`. |

## Classification verification

`structural-command-persistence.test.ts` verifies the complete executable rule set, rejects an
unclassified auto-commit command, exercises identity remapping, preserves unrelated recovery,
exercises both unsafe policies, and verifies persisted forward/Undo/Redo behavior. When a new
Explorer or workflow mutation is introduced, update the rule registry, this map, and the exact rule
set assertion in the same change.
