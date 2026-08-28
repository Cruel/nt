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
| Project Settings | `project:settings` | `/project`, `/settings`, `/bootstrapModule`, `/entrypoint` | `manual-save` |
| Project-scoped editor/tool | Named `project:*` unit | The exact paths listed below | Listed per surface |
| Workflow/panel mutation | Named `workflow:*` unit | Canonical command-derived paths listed below | Listed per surface |
| Read-only/non-content tool | `tool:<editorType>` | None | No content mutation |

The Project Settings owned-path set is exactly:

```text
/project
/settings
/bootstrapModule
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
- Scoped commits send selected save-unit IDs plus the exact logical baseline/local values for the
  affected JSON paths. The main-owned active workspace session already owns the authoritative disk
  project and exact physical revisions. It overlays the selected logical mutation onto that cached
  state, validates the candidate in memory, derives the physical transaction targets from the files
  whose canonical workspace projection actually changes for those exact paths, then exact-CAS checks
  those targets immediately before replacement. Physical file ownership is therefore not inferred
  only from the visual tab: for example a Room-owned `/interactableInstances/<id>` edit also targets
  `project.json`, and the Traits collection targets `traits.json`. A disjoint external edit can
  therefore survive even when it shares a Room record file or `editor.json` with the local save; an
  overlapping path fails closed instead.
- A successful content write returns a targeted acknowledgement, not a reopened whole-workspace
  snapshot. It contains the committed logical units, exact revisions for physical authoring files
  actually changed by the transaction, authoritative recovery/editor state, any external logical
  delta discovered during the bounded CAS rebase, and source-ownership metadata when relevant. Main
  advances remaining dirty units' per-file recovery baselines before returning. Renderer reconciliation
  treats that returned recovery state as authoritative and never replaces it with the older pre-save
  recovery copy.
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
Content commits cross that boundary with selected save-unit IDs, affected logical paths, and their
baseline/local values; recovery ownership hints are included only where needed to establish a dirty
unit's physical baseline dependencies. The main-owned active workspace session performs final path
projection and exact target revision checks under the cross-process writer lock.
There is no renderer-accessible whole-document Save or old Save As branch. The retired whole-project
content fingerprint is not part of editor metadata, IPC responses, or conflict detection; persisted
concurrency is expressed through exact physical revisions at transaction, watcher, conflict, and
recovery boundaries. Aggregate `workspaceRevision` remains an internal stateless/cold-workspace
primitive where independently useful, not an active-editor synchronization token. External rebase/
conflict semantics are documented in `PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

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
| `traits` | Savable collection | `collection:traits` | `/traits`; physically projected to `traits.json` |
| `components` | Non-content | `tool:components` | Documentation/reference surface only |
| `settings` | Non-content | `tool:settings` | Editor preferences, not project content |
| `project-settings` | Savable project unit | `project:settings` | `/project`, `/settings`, `/bootstrapModule`, `/entrypoint` |
| `platform-export` | Savable project tool | `project:platform-export-profiles` | Export configuration owns top-level `/export`; output/template/signing selection and export execution remain user-local/non-content |
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
| Runtime/package and platform export-profile editing | `PackageExportDialog.tsx` / profile editor surface | `project:platform-export-profiles` | `manual-save` | `/export` |
| Shader compiled-output application | `ShaderCompilePanel.tsx`, `package-export-workflow.ts` | `workflow:shader-compiled-output` | `manual-save` | Exact compiled-output paths returned by the shader command; one atomic group when multiple paths change |
| Successful platform-export identity recording | `platform-export-workflow.ts` | Non-content metadata workflow | Metadata-only | `editor.lastSuccessfulPlatformExportIdentity`; written only after complete selected-target success |
| Play-recorder test creation/update | `FullGamePreviewEditor.tsx` | `workflow:play-recorder` | `manual-save` | `/tests/<testId>` |
| New Entity Wizard | `NewEntityWizardDialog.tsx` | `workflow:new-entity` | `auto-commit` | New record path; room creation plus `/entrypoint` is one command transaction and atomic group |
| Dirty-unit discard | `DirtyCloseDialog.tsx` | `workflow:discard-dirty-units` | `manual-save` | Registry-owned paths restored from the saved baseline; record discard also restores or removes the matching `editor.recordMetadata` entry; duplicate visual tabs are deduplicated by save-unit ID |
| Layout system-role assignment | `LayoutEditor.tsx` | `project:settings` | `manual-save` | `/settings/systemLayouts/<role>` within the Project Settings unit |
| Exact Interactable Instance editing | `RoomEditor.tsx`, `InteractableEditor.tsx` | Enclosing `record:rooms:*` or `record:interactables:*` authoring resource | `manual-save` | Exact `/interactableInstances/<id>` registry paths. The infrastructure registry has no standalone Explorer/tab save unit, so an embedded edit remains attributed to the record authoring surface that initiated it. Duplicate views of that same record still share one save-unit ID. |

Record editor mutations use their `record:*` unit. Collection-wide Variables, Traits, Assets, and Tests
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
other record's unit. The infrastructure-only `interactableInstances` registry is the explicit
exception: it has no standalone authoring tab/save unit, so an embedded exact-Instance edit remains
with the enclosing Room or Interactable record origin that exposed the editing surface. Saving either
member of an actual multi-unit atomic edit commits the entire atomic component. Transactions reject
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

Dirty state is computed by resolving the tab to its logical save unit, comparing every statically
owned path against `savedDocument`, and checking whether current recovery contains a dirty entry for
that same save-unit ID. The recovery check is required for explicitly attributed cross-path edits such
as exact Interactable Instance registry state authored from a Room or Interactable record surface.
The visual tab's `dirty` flag and command-history cursor are not authoritative. Open tabs may supply
fallback recovery ownership only for otherwise unattributed dirty paths; they never create a second
overlapping recovery owner for a path already attributed by a command, workflow, pending input,
repair, or persisted recovery entry. Discard restores both the registry-owned paths and the recovery
entry's actual affected paths. Recovery baseline hints likewise include physical files discovered by
projecting those affected paths, so a Room-owned Instance edit tracks `project.json` even though the
Room's static record descriptor does not claim the entire manifest. This prevents a structural
workflow such as New Entity or Asset Import
from being blocked merely because its resulting editor tab is already open when asynchronous
auto-commit snapshots recovery state.
Consequently, two tabs for the same record resolve to the same save-unit ID and cannot carry
independent persistent dirty state. Serializable local drafts that remain for other editors are
stored separately from project content; Project Settings uses authoritative commands plus
field-level pending input instead of a whole-form draft.

Persisted tab and draft payloads are independent current-only contracts. Their owner restores a
payload only when both the schema identity and `schemaVersion` exactly match its current declaration;
unsupported state is discarded without a migration path.
