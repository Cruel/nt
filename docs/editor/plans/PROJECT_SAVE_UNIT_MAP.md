# Project Save-Unit Map

This document began as the Phase 2 inventory for logical content ownership in the editor. A save unit is
identified by the authoring resource it owns, never by a visual tab instance. The registry source of
truth is `editor/src/renderer/project/save-unit-registry.ts`.

Phase 4 now uses the recorded `persistencePolicy` and ownership model for tab-scoped Save, Save All,
recovery rebasing, and structural auto-commit. See
`PROJECT_STRUCTURAL_COMMAND_PERSISTENCE_MAP.md` for the executable structural classification and
safety policies.

## Save-unit identity and path rules

| Unit family | Stable ID | Owned paths | Policy used by current editor mutations |
| --- | --- | --- | --- |
| Record | `record:<collection>:<entityId>` | `/<collection>/<entityId>` | `manual-save` |
| Collection editor | `collection:<collection>` | The concrete collection root listed below | `manual-save` |
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

Neither the empty JSON pointer nor `/` is a Project Settings path. Applying the current whole-form
draft emits one atomic `project.applyPatch` history entry covering those four paths; Phase 5 will
replace the whole-form draft with authoritative field commands.

## Registered editor mapping

Every editor registered in `default-editors.tsx` has one explicit registry outcome.

| Editor type | Registry result | Save-unit ID | Owned paths / notes |
| --- | --- | --- | --- |
| `engine-preview` | Non-content | `tool:engine-preview` | No authoring-content ownership |
| `full-game-preview` | Non-content | `tool:full-game-preview` | Preview state is non-content; recorder mutations use a workflow unit below |
| `asset-library` | Savable collection | `collection:assets` | `/assets` |
| `asset-detail` | Savable record | `record:assets:<entityId>` | `/assets/<entityId>` |
| `image-generation` | Non-content | `tool:image-generation` | Generated-asset insertion uses a workflow unit below |
| `comfyui-workflows` | Non-content | `tool:comfyui-workflows` | Workflow-library changes are external editor tooling, not project content |
| `shader-detail` | Savable record | `record:shaders:<entityId>` | `/shaders/<entityId>` |
| `material-detail` | Savable record | `record:materials:<entityId>` | `/materials/<entityId>` |
| `layout-detail` | Savable record | `record:layouts:<entityId>` | `/layouts/<entityId>`; system-role changes are attributed to Project Settings |
| `character-detail` | Savable record | `record:characters:<entityId>` | `/characters/<entityId>` |
| `room-detail` | Savable record | `record:rooms:<entityId>` | `/rooms/<entityId>` |
| `interactable-detail` | Savable record | `record:interactables:<entityId>` | `/interactables/<entityId>` |
| `dialogue-detail` | Savable record | `record:dialogues:<entityId>` | `/dialogues/<entityId>` |
| `scene-detail` | Savable record | `record:scenes:<entityId>` | `/scenes/<entityId>` |
| `test-suite` | Savable collection | `collection:tests` | `/tests` |
| `test-detail` | Savable record | `record:tests:<entityId>` | `/tests/<entityId>` |
| `placeholder-entity` | Savable record | `record:<collection>:<entityId>` | Concrete resource path; missing collection/ID is explicitly unsupported |
| `verb-detail` | Savable record | `record:verbs:<entityId>` | `/verbs/<entityId>` |
| `interaction-detail` | Savable record | `record:interactions:<entityId>` | `/interactions/<entityId>` |
| `map-detail` | Savable record | `record:maps:<entityId>` | `/maps/<entityId>` |
| `script-module-detail` | Savable record | `record:scripts:<entityId>` | `/scripts/<entityId>` |
| `variables` | Savable collection | `collection:variables` | `/variables` |
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
| Explorer options and hidden categories | `ProjectExplorer.tsx` | `project:explorer-options` | `auto-commit` | Current `/editor/explorer` metadata paths; temporary content location pending Phase 3 migration |
| Asset import | `workspace.tsx`, `ProjectExplorer.tsx` | `workflow:asset-import` | `auto-commit` | Added `/assets/<id>` paths from the import command |
| Generated-image asset insertion | `ImageGenerationEditor.tsx` | `workflow:image-generation-assets` | `auto-commit` | Added `/assets/<id>` path |
| Platform export-profile editing | `PackageExportDialog.tsx` / profile editor surface | `project:platform-export-profiles` | `manual-save` | `/settings/platformExport` |
| Shader compiled-output application | `ShaderCompilePanel.tsx`, `package-export-workflow.ts` | `workflow:shader-compiled-output` | `manual-save` | Exact compiled-output paths returned by the shader command; one atomic group when multiple paths change |
| Successful platform-export identity recording | `platform-export-workflow.ts` | `workflow:successful-export-identity` | `auto-commit` | `/settings/app`; temporary content location pending the Phase 3 metadata channel |
| Play-recorder test creation/update | `FullGamePreviewEditor.tsx` | `workflow:play-recorder` | `manual-save` | `/tests/<testId>` |
| New Entity Wizard | `NewEntityWizardDialog.tsx` | `workflow:new-entity` | `auto-commit` | New record path; room creation plus `/entrypoint` is one command transaction and atomic group |
| Dirty-unit discard | `DirtyCloseDialog.tsx` | `workflow:discard-dirty-units` | `manual-save` | Registry-owned paths restored from the saved baseline; duplicate visual tabs are deduplicated by save-unit ID |
| Layout system-role assignment | `LayoutEditor.tsx` | `project:settings` | `manual-save` | `/settings/systemLayouts/<role>` within the Project Settings unit |

Record editor mutations use their `record:*` unit. Collection-wide Variables, Assets, and Tests
mutations use their `collection:*` unit unless the action is a structural workflow explicitly listed
above. Project Chapters and Project Tags mutations use their named project units.

## Command-history and dirty-state contract

Every mutating `CommandRequest` must provide `originSaveUnitId` and `persistencePolicy`. Missing
ownership is rejected before a command handler runs. Every committed history entry retains those
fields, the canonical deduplicated union of actual patch paths and handler-declared semantic
`affectedPaths`, and an `atomicTransactionGroupId` whenever a command or transaction spans multiple
owned paths. Transactions reject missing ownership and conflicting origin, persistence-policy, or
atomic-group attribution rather than silently weakening the initiating transaction.

Static non-tab mutation entrypoints consume `MUTATION_SURFACE_ATTRIBUTIONS` directly so the checked-in
inventory is the executable source of truth for both logical ownership and persistence policy rather
than a documentation-only list that can drift from production call sites.

Dirty state is computed by resolving the tab to its logical save unit and comparing every owned path
against `savedDocument`. The visual tab's `dirty` flag and `savedHistoryCursor` are not authoritative.
Consequently, two tabs for the same record resolve to the same save-unit ID and cannot carry
independent persistent dirty state. Local draft state remains tab-associated until the later recovery
and Project Settings phases.
