# Project Explorer

The Explorer has two peer navigation modes selected from the bottom-level mode control: **Project** and **Files**. Project remains the semantic authoring view described below. Files is a physical-source view for author-managed Project content and is not a raw filesystem browser.

## Files mode

Files exposes the author-facing `scripts/`, `shaders/`, `assets/`, and logical `layouts/` roots. It deliberately omits workspace implementation files such as `records/`, tracked JSON fragments, `.noveltea/`, build/export output, caches, and other internal state. Layout-owned RML, RCSS, and Lua appear as `layouts/<layout-id>/layout.<type>` even though the workspace persists those companions under the Layout record directory; the renderer receives the logical path and a privileged Project-relative read target rather than direct Project-root access.

Shader and Lua files are source resources whose canonical workbench identity is their normalized Project-relative path. Normal opening reuses the canonical source tab; **Open in New Tab** creates a separate tab instance for the same resource. Asset files remain distinct from Asset records: the collective Assets destination stays in Project mode, while an individual Asset source can be located in Files. Built-in or otherwise non-Project source is not represented as a Files node merely because a source editor can display it.

Quick Open includes source files as results distinct from semantic records and matches both filename and displayed path. Files search uses the shared Project search machinery and indexes readable source contents, including unreferenced Lua helpers and shader include files. Project search continues to operate on semantic records and metadata.

Following the active workbench resource changes navigation mode only when the active tab changes. Source-backed tabs select Files; semantic record/project resources select Project, with source-backed Asset details able to reveal their admitted physical source. A manual Project/Files switch is therefore respected while the same tab stays active. The selected mode is serialized in editor-local Explorer state and restored with the rest of the local workspace UI.

The Project Explorer is the left workbench sidebar for navigating and organizing authoring project content. It is intentionally an editor UI surface: hidden categories, expanded nodes, and chapters are saved under `project.editor` and are stripped from runtime package export.

The empty-project sidebar lists recent projects. Their labels are refreshed from the current project
name when a project opens, closes, or is saved as a copy. A failed attempt to open a recent project
reports the failure and removes its stale entry.

## Persistence

Explorer UI state is stored under:

```ts
project.editor.explorer
```

This includes:

```ts
expandedNodeIds: string[]
hiddenCollectionKeys: AuthoringCollectionKey[]
organizeByChapter: boolean
groupUnassignedItems: boolean
```

Chapter organization is stored under:

```ts
project.editor.chapters
```

This includes:

```ts
records: Record<string, { id: string; label: string; color?: string | null }>
assignments: Record<'collection:id', string[]>
```

Because this state lives in `project.editor`, it is project-specific but not runtime data.

## Ordering

The explorer sorts alphabetically at every visible level:

- collection categories by label;
- hidden categories by label under `Hidden`;
- chapter folders by chapter label;
- records by label, then ID.

The `Project` heading is fixed at the top. The `Hidden` root is fixed at the bottom when any category is hidden.

## Collective Categories

Assets, Tests, and Variables are global pools in V1. They are not expandable in the sidebar and are not assignable to chapters.

Clicking these categories opens a collective tab:

- Assets opens the asset library tab.
- Tests opens the test suite tab.
- Variables opens the variables tab.

Existing per-record asset/test detail tabs remain available and can be launched from collective tabs or direct links.

## Hidden Categories

Categories can be hidden from the main explorer through the category context menu. Hidden categories move under a dimmed `Hidden` node at the bottom of the sidebar.

Hidden categories remain fully interactable. Their nested rows can be right-clicked and unhidden through `Unhide Category`.

Hiding affects only sidebar placement. It does not affect validation, references, search, quick-open, or future command-palette behavior.

## Chapters

Chapters are editor-only organizational folders. They are not core engine entities and are not exported.

Records from non-collective categories can be assigned to multiple chapters. Assets, Tests, and Variables are collective pools and are not assignable to chapters in V1.

When `Organize by Chapter` is enabled, categories show chapter folders only when that category has records in that chapter. If `Group Unassigned Items` is enabled and the category has at least one assigned record, the category also shows:

- `All`: every record in that category.
- `Unassigned`: records in that category with no chapter assignment.

When `Organize by Chapter` is disabled, assignments remain stored but are ignored for display.

## Context Menus

Most row actions are right-click context menus. The only remaining sidebar `...` control is the Project heading menu.

The Project heading menu provides:

- Project Settings…
- Manage Chapters…
- Organize by Chapter
- Group Unassigned Items

Collection rows provide creation/import/hide actions depending on the collection type. Record rows provide open, metadata, rename, duplicate, assign chapters, find usages, and delete actions. Confirming a record deletion discards drafts for that record and closes all of its open detail tabs without placing them in Recently Closed, so a stale editor cannot restore the deleted record.

## Visual Identity

Collection rows and workbench tab icons use the same collection visual identity. Each collection has a distinct icon and light/dark color pair. These colors are intentionally editor-selected and can be adjusted later without changing project data.
