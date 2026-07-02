# Project Explorer

The Project Explorer is the left workbench sidebar for navigating and organizing authoring project content. It is intentionally an editor UI surface: hidden categories, expanded nodes, and chapters are saved under `project.editor` and are stripped from runtime package export.

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

Collection rows provide creation/import/hide actions depending on the collection type. Record rows provide open, metadata, rename, duplicate, assign chapters, find usages, and delete actions.

## Visual Identity

Collection rows and workbench tab icons use the same collection visual identity. Each collection has a distinct icon and light/dark color pair. These colors are intentionally editor-selected and can be adjusted later without changing project data.
