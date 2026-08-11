# Project Save-Unit Map

This document is the permanent contract for logical content ownership, tab-scoped Save, recovery,
and structural persistence in the editor. A save unit is identified by the authoring resource it
owns, never by a visual tab instance. The registry source of truth is
`editor/src/renderer/project/save-unit-registry.ts`.

The recorded `persistencePolicy` and ownership model drive tab-scoped Save, Save All, recovery
rebasing, and structural auto-commit. See `PROJECT_STRUCTURAL_COMMAND_PERSISTENCE.md` for the
executable structural classification and safety policies.

## Save-unit identity and path rules

| Unit family | Stable ID | Owned paths | Policy used by current editor mutations |
| --- | --- | --- | --- |
| Record | `record:<collection>:<entityId>` | `/<collection>/<entityId>` plus `/editor/recordMetadata/<collection>/<entityId>` | `manual-save` |
| Collection editor | `collection:<collection>` | The concrete collection root plus `/editor/recordMetadata/<collection>` | `manual-save` |
| Explorer structural operation | `structure:<collection>` | Canonical command-derived paths for create, rename, duplicate, or delete | `auto-commit` attribution only |
| Project Settings | `project:settings` | `/project`, `/settings`, `/startupHook`, `/entrypoint` | `manual-save` |
| Project-scoped editor/tool | Named `project:*` unit | The exact paths listed below | Listed per surface |
| Workflow/panel mutation | Named `workflow:*` unit | Canonical command-derived paths listed below | Listed per surface |
| Read-only/non-content tool | `tool:<editorType>` | None | No content mutation |

The Project Settings owned-path set is exactly:

```text
/project
/settings
/startupHook
/entrypoint
```

Neither the empty JSON pointer nor `/` is a Project Settings path. Project Settings writes these
paths immediately through focused undoable commands; nonrepresentable numeric text is retained as
field-level pending input in recovery metadata.

## File menu and close contract

- Save and `Ctrl+S` commit only the active tab's logical save unit.
- Save All attempts every dirty unit, writes the maximal independently valid set once, and leaves
  blocked units dirty with their recovery overlays intact. It intentionally has no shortcut that
  conflicts with Save As.
- Scoped commits resolve each selected unit to its canonical JSON/source file set and carry the
  loaded exact-byte revision for each target. The renderer also supplies the exact JSON paths changed
  by the selected recovery component. The main process verifies those paths against the saved
  baseline, rebases the selected paths onto the newest disk snapshot, and writes only the selected
  physical files. A disjoint external edit can therefore survive even when it shares a Room record
  file or `editor.json` with the local save; an overlapping path fails closed instead.
- After a successful content write, the main process returns the authoritative post-commit workspace
  snapshot. The renderer reconciles that snapshot with any remaining local dirty units before it
  adopts the returned workspace/file revisions. A watcher event can therefore never be skipped merely
  because Save advanced the revision before adopting a concurrent external change.
- Save As and `Ctrl+Shift+S` create a copy from the saved content baseline plus complete editor
  metadata, recovery overlays, and dirty-only project asset files. The active project identity and
  dirty state do not change. Unrelated files may already exist at the chosen destination, but Save As
  rejects pre-existing NovelTea canonical source/state namespaces and exact Asset-path collisions so
  the copy cannot silently merge stale records, Layout/Script sources, recovery state, or unrelated
  destination bytes into the copied workspace.
- Closing the project, switching projects, and normal editor exit flush ignored local editor metadata
  and recovery only. They never pass the complete working document to a content-save API. Metadata-
  only writes never advance `savedDocument` or adopt newer tracked-file revisions. A scheduled recovery
  debounce is canceled/settled before Save, Save All, Save As, or Keep Mine so it cannot race a content
  commit and overwrite the new recovery-baseline marker.
- Closing a non-final duplicate view never prompts. Closing the final dirty view uses the shared
  Save / Don't Save / Cancel dialog for the logical save unit.

The renderer exposes only scoped content Save, metadata-only persistence, and Save As copy IPC.
Content commits cross that boundary with selected save-unit IDs, their saved baseline, and per-file
revisions. The main-process workspace service performs the final path projection and revision check
under the cross-process writer lock.
There is no renderer-accessible whole-document Save or old Save As branch. The retired whole-project
content fingerprint is not part of editor metadata, IPC responses, or conflict detection; persisted
concurrency is expressed only through `workspaceRevision` plus exact owned-file revisions. External
rebase/conflict semantics are documented in `PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Registered editor mapping

Every editor registered in `default-editors.tsx` has one explicit registry outcome.

| Editor type | Registry result | Save-unit ID | Owned paths / notes |
| --- | --- | --- | --- |
| `engine-preview` | Non-content | `tool:engine-preview` | No authoring-content ownership |
| `full-game-preview` | Non-content | `tool:full-game-preview` | Preview state is non-content; recorder mutations use a workflow unit below |
| `asset-library` | Savable collection | `collection:assets` | `/assets` plus `/editor/recordMetadata/assets` |
| `asset-detail` | Savable record | `record:assets:<entityId>` | `/assets/<entityId>` plus matching record metadata |
| `image-generation` | Non-content | `tool:image-generation` | Generated-asset insertion uses a workflow unit below |
| `comfyui-workflows` | Non-content | `tool:comfyui-workflows` | Workflow-library changes are external editor tooling, not project content |
| `shader-detail` | Savable record | `record:shaders:<entityId>` | `/shaders/<entityId>` plus matching record metadata |
| `material-detail` | Savable record | `record:materials:<entityId>` | `/materials/<entityId>` plus matching record metadata |
| `layout-detail` | Savable record | `record:layouts:<entityId>` | `/layouts/<entityId>` plus matching record metadata; system-role changes are attributed to Project Settings |
| `character-detail` | Savable record | `record:characters:<entityId>` | `/characters/<entityId>` plus matching record metadata |
| `room-detail` | Savable record | `record:rooms:<entityId>` | `/rooms/<entityId>` plus matching record metadata |
| `interactable-detail` | Savable record | `record:interactables:<entityId>` | `/interactables/<entityId>` plus matching record metadata |
| `dialogue-detail` | Savable record | `record:dialogues:<entityId>` | `/dialogues/<entityId>` plus matching record metadata |
| `scene-detail` | Savable record | `record:scenes:<entityId>` | `/scenes/<entityId>` plus matching record metadata |
| `test-suite` | Savable collection | `collection:tests` | `/tests` plus `/editor/recordMetadata/tests` |
| `test-detail` | Savable record | `record:tests:<entityId>` | `/tests/<entityId>` plus matching record metadata |
| `placeholder-entity` | Savable record | `record:<collection>:<entityId>` | Concrete resource path; missing collection/ID is explicitly unsupported |
| `verb-detail` | Savable record | `record:verbs:<entityId>` | `/verbs/<entityId>` plus matching record metadata |
| `interaction-detail` | Savable record | `record:interactions:<entityId>` | `/interactions/<entityId>` plus matching record metadata |
| `map-detail` | Savable record | `record:maps:<entityId>` | `/maps/<entityId>` plus matching record metadata |
| `script-module-detail` | Savable record | `record:scripts:<entityId>` | `/scripts/<entityId>` plus matching record metadata |
| `variables` | Savable collection | `collection:variables` | `/variables` plus `/editor/recordMetadata/variables` |
| `components` | Non-content | `tool:components` | Documentation/reference surface only |
| `settings` | Non-content | `tool:settings` | Editor preferences, not project content |
| `project-settings` | Savable project unit | `project:settings` | `/project`, `/settings`, `/startupHook`, `/entrypoint` |
| `platform-export` | Non-content | `tool:platform-export` | Export execution is non-content; success identity recording uses a workflow unit |
| `platform-export-profiles` | Savable project tool | `project:platform-export-profiles` | `/settings/platformExport` |
| `project-chapters` | Savable project tool | `project:chapters` | `/editor/chapters` |
| `project-tags` | Savable project tool | `project:tags` | `/editor/tags` |

An unregistered editor type or a record editor without a concrete collection and entity ID resolves
to an explicit `unsupported` result. A collection-specific record editor also resolves to
`unsupported` when its resource names a different collection, preventing restored or malformed tab
metadata from attributing edits and dirty state to the wrong record path. The registry coverage test
fails when a registered editor is missing from this map.

## Non-tab and cross-unit mutation inventory

| Mutation surface | Current entrypoints | Logical origin | Policy | Path ownership / atomicity |
| --- | --- | --- | --- | --- |
| Explorer create/rename/duplicate/delete and asset deletion | `ProjectExplorer.tsx`, `AssetLibraryEditor.tsx`, `AssetEditor.tsx` | `structure:<collection>` | `auto-commit` | Command-derived collection and reference paths; multi-path results receive one atomic group |
| Explorer options and hidden categories | `ProjectExplorer.tsx` | `project:explorer-options` | `auto-commit` | Exact `/editor/explorer` metadata paths persisted through the editor-metadata channel |
| Asset import | `workspace.tsx`, `ProjectExplorer.tsx` | `workflow:asset-import` | `auto-commit` | Added `/assets/<id>` paths from the import command |
| Generated-image asset insertion | `ImageGenerationEditor.tsx` | `workflow:image-generation-assets` | `auto-commit` | Added `/assets/<id>` path |
| Platform export-profile editing | `PackageExportDialog.tsx` / profile editor surface | `project:platform-export-profiles` | `manual-save` | `/settings/platformExport` |
| Shader compiled-output application | `ShaderCompilePanel.tsx`, `package-export-workflow.ts` | `workflow:shader-compiled-output` | `manual-save` | Exact compiled-output paths returned by the shader command; one atomic group when multiple paths change |
| Successful platform-export identity recording | `platform-export-workflow.ts` | Non-content metadata workflow | Metadata-only | `editor.lastSuccessfulPlatformExportIdentity`; written only after complete selected-target success |
| Play-recorder test creation/update | `FullGamePreviewEditor.tsx` | `workflow:play-recorder` | `manual-save` | `/tests/<testId>` |
| New Entity Wizard | `NewEntityWizardDialog.tsx` | `workflow:new-entity` | `auto-commit` | New record path; room creation plus `/entrypoint` is one command transaction and atomic group |
| Dirty-unit discard | `DirtyCloseDialog.tsx` | `workflow:discard-dirty-units` | `manual-save` | Registry-owned paths restored from the saved baseline; record discard also restores or removes the matching `editor.recordMetadata` entry; duplicate visual tabs are deduplicated by save-unit ID |
| Layout system-role assignment | `LayoutEditor.tsx` | `project:settings` | `manual-save` | `/settings/systemLayouts/<role>` within the Project Settings unit |

Record editor mutations use their `record:*` unit. Collection-wide Variables, Assets, and Tests
mutations use their `collection:*` unit unless the action is a structural workflow explicitly listed
above. Project Chapters and Project Tags mutations use their named project units.

## Command-history and dirty-state contract

Every mutating `CommandRequest` must provide `originSaveUnitId` and `persistencePolicy`. Missing
ownership is rejected before a command handler runs. Every committed history entry retains those
fields, the canonical deduplicated union of actual patch paths and handler-declared semantic
`affectedPaths`, and an `atomicTransactionGroupId` whenever a command or transaction spans multiple
owned paths. For manual commands, a patch that leaves the initiating record/collection is reassigned
to its actual logical save unit during recovery construction while retaining the same atomic group.
For example, adding a previously unknown tag to a Room yields a Room record-metadata unit plus a
`project:tags` unit, and a Variables rename that rewrites another record gives that rewrite to the
other record's unit. Saving either member commits the entire atomic component. Transactions reject
missing ownership and conflicting origin, persistence-policy, or atomic-group attribution rather
than silently weakening the initiating transaction.

Static non-tab mutation entrypoints consume `MUTATION_SURFACE_ATTRIBUTIONS` directly so the checked-in
inventory is the executable source of truth for both logical ownership and persistence policy rather
than a documentation-only list that can drift from production call sites.

Every Explorer content mutation is either represented by a rule in
`STRUCTURAL_AUTO_COMMIT_RULES` or remains an explicitly visible manual-save unit. The current
auto-commit set is record create/duplicate/rename/delete, asset import/delete, Explorer presentation
metadata, the New Entity Wizard transaction, and explicitly registered workflow patch transactions.
Successful platform-export identity is not a content command; it is metadata-only and therefore has
no structural auto-commit compatibility rule.

Dirty state is computed by resolving the tab to its logical save unit and comparing every owned path
against `savedDocument`. The visual tab's `dirty` flag and command-history cursor are not
authoritative. Open tabs may supply fallback recovery ownership only for otherwise unattributed dirty
paths; they never create a second overlapping recovery owner for a path already attributed by a
command, workflow, pending input, repair, or persisted recovery entry. This prevents a structural
workflow such as New Entity or Asset Import from being blocked merely because its resulting editor
tab is already open when asynchronous auto-commit snapshots recovery state.
Consequently, two tabs for the same record resolve to the same save-unit ID and cannot carry
independent persistent dirty state. Serializable local drafts that remain for other editors are
stored separately from project content; Project Settings uses authoritative commands plus
field-level pending input instead of a whole-form draft.

Persisted tab and draft payloads are independent current-only contracts. Their owner restores a
payload only when both the schema identity and `schemaVersion` exactly match its current declaration;
unsupported state is discarded without a migration path.
