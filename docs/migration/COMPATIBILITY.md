# NovelTea Compatibility Contract

Last updated: 2026-06-20.

This document defines the current compatibility boundary for the migrated `nt` runtime.

## Legacy `game` JSON Import

- Legacy project `game` JSON can be imported through the backend-neutral legacy importer and editor-facing tooling.
- Supported legacy shapes are preserved at the project/import boundary, including unknown top-level extension keys.
- Import is separate from validation: malformed shapes produce diagnostics, while graph/reference checks happen in validation/model layers.

## Legacy Package Import

- Legacy packages are supported as read-only imports.
- Current package import covers `game`, cover `image`, `fonts/*`, `textures/*`, and safe project-relative auxiliary entries under paths such as `audio/`, `data/`, `music/`, `resources/`, `scripts/`, `shaders/`, `sounds/`, `text/`, and `texts/`.

## Runtime Package Export

- Runtime export writes ZIP-based `.ntpkg` packages with legacy-compatible entries plus additive `manifest.json` metadata.
- Exported runtime packages contain `game`, optional `image`, safe `fonts/*`, `textures/*`, auxiliary resources, and compiled shader binaries under `shaders/bgfx/<variant>/*.bin`.
- Public export APIs expose options, results, checksums, and diagnostics; ZIP/miniz types remain private implementation details.
- `manifest.json` uses format `noveltea.runtime-package` with `format_version` 1. It records project metadata, package kind, shader variants, entries, and per-entry checksums where enabled.

## Save JSON Preservation

- Save JSON import/export preserves recognized runtime fields and unknown extra keys when parsed through the save document APIs.
- Runtime save snapshots preserve save-backed mutations, object locations, text logs, visited rooms, current runtime state, and namespaced controller state.
- Manual save/load/autosave are implemented through a backend-neutral slot-store contract; platform-specific persistence is outside this compatibility layer.

## Runtime Controller Coverage

Current backend-neutral controller coverage includes:

- room entry and room navigation
- room object and starting-inventory views
- save-backed object placement and inventory views
- verb/action resolution
- dialogue traversal, options, and logging
- cutscene page expansion and continuation
- timer progression and text-log events
- save entrypoint restoration
- backend-neutral command capture for UI/editor preview

## Scripts

Lua is the only runtime scripting target.

Imported script text is treated as Lua. Invalid imported legacy script text must fail as Lua and surface diagnostics to runtime/editor users. JavaScript, Duktape, dukglue, embedded JS engines, and JS compatibility shims are explicitly out of scope.

## Known Limits

- Real-project fixture coverage is still limited; broad compatibility claims need private or redistributable old-project fixtures.
- Platform-specific save-slot persistence is not implemented.
- Persisted object-location application currently covers room and inventory behavior.
- Rich-text semantics are backend-neutral, but full visual parity for old ActiveText/effect rendering is not complete.
- RmlUi runtime components for complex widgets such as ActiveText, MapView, and TextLog are still active work.
