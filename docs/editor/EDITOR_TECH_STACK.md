# Editor Tech Stack and Component Standards

## Purpose

This document is the canonical implementation guide for editor-side UI and
state-management dependencies. Before adding a new React/Electron component
library, table/grid package, graph editor, code editor, drag/drop system, schema
validator, or state manager, check this document first.

The goal is not to freeze every choice forever. The goal is to prevent each
editor slice from inventing its own UI stack and to make future implementation
agents aware of the libraries and patterns that already exist or are planned.

## Existing Baseline

The editor already uses:

- Electron Forge + Vite for desktop app packaging and dev server integration.
- React for renderer UI.
- TypeScript for editor/main/preload/shared code.
- TanStack Router for renderer routing.
- TanStack Query for async data/query orchestration where useful.
- Zustand for lightweight renderer state stores.
- Tailwind CSS for styling.
- shadcn-style local components under `editor/src/renderer/components/ui`.
- Base UI React primitives for accessible unstyled/low-level components.
- lucide-react for icons.
- Vitest + Testing Library for renderer/unit tests.
- The engine web preview iframe plus typed `MessageChannel` protocol.
- `noveltea-editor-tool` for privileged/native project, validation, shader,
  package, and playback operations.

Existing local UI components at the time this document was created:

```text
badge
button
card
dialog
dropdown-menu
input
label
select
separator
sidebar
skeleton
switch
tooltip
```

Prefer extending this local component set with shadcn/Base UI patterns before
adding one-off component libraries.

## General Dependency Policy

Add dependencies deliberately and close to the milestone that needs them.

A new dependency should usually satisfy at least one of these conditions:

- It provides a core primitive needed by many editor surfaces.
- It avoids a large amount of fragile custom UI/state logic.
- It is headless or style-neutral and composes with the existing design system.
- It improves correctness for hard UI behavior such as accessibility,
  virtualization, drag/drop, table state, graph editing, source editing, or
  runtime validation.

Avoid dependencies that:

- Bring a complete visual design system that competes with shadcn/Base UI.
- Own the whole app shell/workbench model unless explicitly chosen.
- Make project data mutation implicit or hard to route through the command bus.
- Are only useful for a single small widget that can be implemented locally.
- Force legacy compatibility assumptions into the new editor.

## UI Component Standard

Use shadcn-style local components and Base UI primitives as the default UI layer.

Rules:

- Put reusable UI wrappers in `editor/src/renderer/components/ui`.
- Keep domain/editor-specific components outside `components/ui`.
- Prefer headless primitives and local styling over pre-styled third-party UI.
- Keep component APIs narrow and typed.
- Avoid importing low-level third-party primitives directly throughout feature
  code when a stable local wrapper would make future replacement easier.
- Use Tailwind classes and the existing `cn` utility for composition.
- Use lucide-react for icons unless a domain-specific icon asset is required.

Recommended shadcn/Base UI additions as the workbench grows:

```text
tabs
context-menu
menubar
popover
scroll-area
checkbox
radio-group
textarea
slider
table
alert
progress
command
resizable wrappers, if backed by react-resizable-panels
```

### Command Palette

Use the shadcn `Command` component as the preferred command palette / quick-open
surface. shadcn's Command pattern is based on `cmdk`, so do not add direct `cmdk`
usage throughout the codebase unless the local `Command` wrapper is insufficient.
If direct `cmdk` access becomes necessary, keep it isolated behind the local
`components/ui/command` wrapper.

Command palette use cases:

- Run editor commands.
- Quick-open project records.
- Search actions/settings.
- Jump to diagnostics/usages.
- Trigger preview/test/export operations.

## Workbench Layout and Split Panels

Use `react-resizable-panels` for split panes.

Scope:

- Workbench editor group splits.
- Editor-local inspector/canvas/source splits.
- Bottom panel resizing.
- Side panel resizing if needed.

The editor should still own the tab/workbench model itself:

- Editor groups.
- Tabs.
- Active tab/group.
- Split tree.
- Dirty tab state.
- Recently closed tabs.
- Editor registry.

Do not adopt a full docking-layout framework until the custom workbench model has
been proven insufficient. Full docking frameworks tend to own persistence,
focus, drag/drop, and tab semantics in ways that can conflict with the editor's
command bus, preview pooling, editor-owned inspectors, and project session model.

## Drag and Drop

Use `@dnd-kit` for editor drag/drop interactions.

Recommended packages:

```text
@dnd-kit/core
@dnd-kit/sortable
@dnd-kit/modifiers
```

Use cases:

- Reordering tabs.
- Moving tabs between editor groups.
- Reordering scene steps.
- Reordering dialogue options.
- Moving graph nodes where the graph library does not own the behavior.
- Reparenting or reordering project explorer nodes.
- Reordering material uniforms/texture slots.
- Reordering test steps.

File import drag/drop is a special case. Native file drops may need Electron or
browser file APIs at the boundary, but project mutations resulting from file
drops must still go through explicit commands.

## Project Schema and Runtime Validation

Use `zod` for runtime validation.

Primary use cases:

- New project schema validation in TypeScript.
- Command payload validation.
- Preview protocol message validation.
- Electron IPC request/response validation.
- `noveltea-editor-tool` JSON response validation.
- Import/export profile validation.
- Editor session state validation.

TypeScript types alone are not enough at these boundaries because project files,
preview messages, IPC payloads, and helper-tool JSON are runtime data.

Schema definitions should live near the boundary or model they validate. Shared
schemas used by multiple editor services should go under an explicit shared
schema/model directory rather than being hidden inside UI components.

## Project State, Commands, and Undo/Redo

Keep Zustand as the lightweight renderer state store, but do not use it as an
implicit project mutation mechanism.

Persistent project edits must go through the command bus described in
`docs/editor/EDITOR_IMPLEMENTATION_PLAN.md`.

Recommended division:

- Zustand stores hold current project document, workbench state, selection,
  preview state, bottom panel state, and transient UI state.
- Command handlers produce explicit project changes and undo/redo metadata.
- Editor components dispatch commands; they do not directly mutate persistent
  project data.
- Dirty state derives from command history relative to the last saved revision.

### Immer

`immer` is optional and should not be added until the command bus design proves
that draft-style immutable updates or patch generation would reduce complexity.

Good reasons to add `immer` later:

- Command handlers are becoming verbose because of nested immutable updates.
- Inverse patches can be generated reliably from command application.
- It stays hidden inside command/project services and does not leak into every
  component.

Do not add Redux, XState, Jotai, Valtio, MobX, or another app-wide state manager
unless there is a specific, documented architectural reason.

## Tables, Grids, Lists, and Virtualization

Use TanStack libraries for complex data surfaces.

### Tables

Use `@tanstack/react-table` for real table/grid state.

Use cases:

- Variables editor.
- Asset list/details table.
- Problems/diagnostics table.
- Test list and assertion table.
- Material uniforms table.
- Shader variants table.
- Reference/usages results.
- Package export manifest table.

Do not build custom sorting/filtering/selection/pagination state for each editor
unless the surface is trivial.

The visual table components should still be local shadcn-style components. Use
TanStack Table for state and row/column modeling, not for styling.

### Virtualization

Use `@tanstack/react-virtual` for large or potentially large scrollable surfaces.

Use cases:

- Large asset lists.
- Large project trees.
- Long diagnostics/output logs.
- Material/asset thumbnail grids.
- Search results.
- Test playback timelines.
- Scene step lists when projects become large.

Virtualization should be considered early for surfaces that may contain hundreds
or thousands of rows/items. Avoid adding virtualization to tiny static lists
where it adds complexity without benefit.

## Forms

Use plain controlled React state for small forms and `@tanstack/react-form` for
large, nested, or heavily validated forms.

Good candidates for TanStack Form:

- Project settings.
- Asset import options.
- Material/shader records.
- Character pose/expression records.
- Export/package profiles.
- Complex action/interaction editors.
- Test assertion editors.

Form validation should reuse zod schemas where possible. Do not duplicate schema
rules across form components and command handlers.

## Source and Code Editing

Use CodeMirror 6 for source/code editor surfaces unless a later decision
explicitly replaces it.

Initial source editor use cases:

- Lua scripts.
- RML.
- RCSS/CSS.
- Shader source.
- JSON/raw project records.
- Dialogue/script snippets.

Why CodeMirror first:

- Lighter than Monaco.
- Modular and embeddable inside custom editor layouts.
- Good fit for custom diagnostics and preview feedback.
- Easier to theme alongside the existing UI.
- Adequate for v1 shader/RML/RCSS/Lua editing.

Recommended implementation approach:

- Create a local source editor wrapper component.
- Keep CodeMirror extensions and language configuration centralized.
- Feed diagnostics from validation/preview/shader compiler into the wrapper.
- Use editor drafts for typing, then commit persistent changes through commands
  on debounce, blur, explicit save, or transaction completion.

Monaco can be reconsidered later if the editor needs deeper VS Code-style
behavior, language server integration, or richer debugging features.

## Graphs, Node Editors, and Timelines

Use `@xyflow/react` when implementing node/graph editors.

Use cases:

- Dialogue graph editor.
- Map graph editor.
- Scene branch graph view.
- Future visual scripting or action-flow surfaces.

Do not add React Flow/XYFlow during the workbench milestone unless a graph editor
is being implemented in the same slice. The workbench shell does not need it.

Scene timelines should start as command-backed ordered lists/tracks using local
components plus dnd-kit. Add a specialized timeline package only after the scene
editor's requirements are concrete enough to evaluate.

## Preview and Thumbnails

Do not use a generic React canvas/WebGL preview library for engine previews. The
engine web build is the source of truth for runtime visuals.

Rules:

- Use the existing iframe/MessageChannel preview boundary.
- Route preview ownership through `PreviewManager` once implemented.
- Do not let arbitrary components create unlimited preview iframes.
- Use cached thumbnail requests for asset/material/layout cards.
- Store generated thumbnails in editor cache/session data, not runtime project
  data.
- Keep preview protocol messages typed and validated.

## Editor Localization

Use `i18next` and `react-i18next` for editor UI localization when the editor
starts supporting multiple interface languages. Follow
`docs/editor/EDITOR_LOCALIZATION_IMPLEMENTATION_PLAN.md` for the implementation
order, resource layout, language preference model, and separation between editor
UI localization and future game-content localization.

Localization scope:

- Editor menus, settings, workbench labels, command palette metadata, dialogs,
  validation prose, and other user-facing UI text.
- The selected editor interface language belongs in editor preferences, not in
  project documents.
- Game/runtime content localization is a separate project-schema and engine
  feature and should not be mixed into the editor UI translation files.

Avoid adding browser language-detector or HTTP backend packages in the initial
localization slice. The editor can use Electron's preferred system languages and
bundle JSON resources through Vite.

## Testing Standards

Use Vitest and Testing Library for renderer/editor TypeScript tests.

Recommended test coverage as new libraries are introduced:

- Pure state/model tests for workbench split/tab logic.
- Command bus apply/undo/redo/transaction tests.
- zod schema validation tests for project/command/protocol payloads.
- Component tests for high-value UI behavior where practical.
- Preview protocol validator tests.
- Table/form adapter tests for complex reusable wrappers.

Avoid screenshot-heavy tests for ordinary editor UI until visual baselines are
worth the maintenance burden.

## Dependency Timing Summary

Add soon, during workbench/command/schema foundations:

```text
react-resizable-panels
@dnd-kit/core
@dnd-kit/sortable
@dnd-kit/modifiers
zod
@tanstack/react-virtual
```

Add when the first matching editor needs them:

```text
@tanstack/react-table
@tanstack/react-form
CodeMirror 6 packages / local CodeMirror wrapper
@xyflow/react
i18next / react-i18next
```

Optional later:

```text
immer
```

Avoid for now unless a later plan explicitly changes direction:

```text
full docking-layout framework
heavy pre-styled data grid
second app-wide state manager
visual rich-text editor framework
Monaco as the default source editor
generic WebGL/canvas preview framework for runtime previews
```

## Agent Checklist Before Adding a Dependency

Before adding a new editor dependency, answer these questions in the commit or
implementation notes:

1. Is an existing dependency or local UI wrapper already intended for this job?
2. Is the new dependency headless/style-neutral enough to fit the design system?
3. Does it work cleanly in Electron + Vite + React + TypeScript?
4. Will persistent project changes still route through the command bus?
5. Does it duplicate TanStack, shadcn/Base UI, dnd-kit, CodeMirror, or XYFlow?
6. Is the dependency needed for the current milestone, or can it wait?
7. Are tests or wrappers being added so feature code does not depend on scattered
   low-level third-party APIs?
