# NovelTea Historical Import/Export Notes

Last updated: 2026-06-29.

This document records old-format import/export work and runtime data behavior that
was implemented while bootstrapping the new `nt` engine. It is not a requirement
to preserve old NovelTea project formats, entity layouts, APIs, or editor
workflows. The new engine and editor should make new-engine-first design choices.
The old `refs/NovelTea` repository is reference material only.

## Compatibility Is Not The Design Target

- New project schemas should not preserve old collection names, array layouts, or
  JSON shapes merely for compatibility.
- New editor features should not add legacy fallback paths unless a task
  explicitly scopes an import/migration tool.
- Existing old-format helper code may remain while actively useful for smoke
  tests or fixtures, but it is transitional and should not constrain new schema
  or editor architecture.
- Runtime package/export formats may change when the new authoring/runtime split
  is designed.

## Existing Historical Import Work

Some old-format import/runtime scaffolding exists in the repository:

- Old `game` JSON import can be handled by backend-neutral importer/tooling code.
- Some old package entries can be read for migration/reference use.
- Imported script text is treated as Lua. Invalid imported script text must fail
  as Lua with diagnostics. JavaScript, Duktape, dukglue, embedded JS engines, and
  JavaScript compatibility shims are explicitly out of scope.

These capabilities are optional migration aids, not active product requirements.
Do not expand them unless the user explicitly asks for old-project import or a
narrow migration workflow.

## Runtime Save Notes

Save JSON behavior is runtime state behavior, not old project-format
compatibility:

- Runtime save snapshots preserve save-backed mutations, object locations, text
  logs, visited rooms, current runtime state, and namespaced controller state.
- Manual save/load/autosave are implemented through a backend-neutral slot-store
  contract.
- Platform-specific save-slot persistence remains separate platform work.

## Current Runtime Controller Coverage

Backend-neutral controller coverage currently includes:

- room entry and room navigation;
- room object and starting-inventory views;
- save-backed object placement and inventory views;
- verb/action resolution;
- dialogue traversal, options, and logging;
- cutscene page expansion and continuation;
- timer progression and text-log events;
- save entrypoint restoration;
- backend-neutral command capture for UI/editor preview.

## Known Limits

- Old-project fixture coverage is not a goal unless a task explicitly scopes old
  project import/migration.
- Platform-specific save-slot persistence is not implemented.
- Rich-text semantics are backend-neutral, but exact visual parity with old
  ActiveText/effect rendering is not a requirement.
- RmlUi runtime components for complex widgets such as ActiveText, MapView, and
  TextLog are still active work.
