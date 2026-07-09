# Engine Documentation Overview

## Purpose

Use this entrypoint before changing authoring project/entity schemas, command behavior, validation, editor integration for project records, runtime/export status for entities, or component docs under `docs/engine/`.

The engine docs are current behavior documentation, not just planning notes. Update the relevant component document when code changes alter user-visible or agent-relevant behavior.

## Current Component Documents

Read the specific component doc before changing its schema, commands, editor UI, preview, runtime/export behavior, or validation:

- `docs/engine/PROJECT.md` — root project document, metadata, settings, runtime defaults, and project-wide references.
- `docs/engine/ASSET.md` — authoring assets, import metadata, asset editor/library behavior, runtime/export status.
- `docs/engine/ROOM.md` — rooms, backgrounds, scripts, paths, hotspots, overlays, room editor, and room preview.
- `docs/engine/CHARACTER.md` — characters, dialogue style, poses, expressions, character editor, and preview.
- `docs/engine/DIALOGUE.md` — dialogue graph/data model, blocks, segments, choices, preview, editor behavior, and runtime status.
- `docs/engine/SCENE.md` — scene sequence/timeline model, steps, preview approximation, editor behavior, and validation.
- `docs/engine/LAYOUT.md` — authored RmlUi layouts, system layout roles, source files, preview, export, and runtime mounting.
- `docs/engine/SHADER.md` — shader entity records, stages, roles, validation, editor/import compilation, runtime/export status.
- `docs/engine/MATERIAL.md` — material entity records, texture sources, shader references, preview, runtime/export status.
- `docs/engine/VARIABLE.md` — project variables, defaults, validation, commands, editor behavior, and runtime status.
- `docs/engine/TEST.md` — authoring tests, recorded/playback actions, assertions, test editor, and playback integration.

## Migration Context

- `docs/migration/PLAN.md` and `docs/migration/STATUS.md` provide migration context for broader runtime/editor work.
- `docs/migration/COMPATIBILITY.md` records historical import/export notes only. It is not a requirement to preserve old project formats.

## Code Areas

- Core engine/runtime C++ code lives under `engine/`.
- Authoring project schema, entity operations, validators, and export adapters live under `editor/src/shared/`.
- Entity editors live under `editor/src/renderer/editors/`.
- Command-bus-backed entity mutations live in shared/editor operation modules and must preserve undo/redo and dirty state.

## Agent Rules

When changing an entity shape, update the component doc's data model, validation, command behavior, editor behavior, runtime/export status, known gaps, and implementation-file list as needed.

Do not rely on `refs/NovelTea/` as a compatibility contract. If legacy reference behavior is intentionally preserved or rejected, document that decision in the component doc's legacy/reference or known-gaps section.

If a new entity or substantial component is added, create a matching component document under `docs/engine/` using the existing component document structure, then link it from this overview.
