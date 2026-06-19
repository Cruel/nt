# NovelTea Compatibility Contract

Last updated: 2026-06-19.

This document defines the current compatibility boundary for the migrated `nt` runtime.

## Legacy `game` JSON Import

- Legacy project `game` JSON can be imported through the backend-neutral legacy importer and editor-facing tooling.
- Supported legacy shapes are preserved at the project/import boundary, including unknown top-level extension keys.
- Import is separate from validation: malformed shapes produce diagnostics, while graph/reference checks happen in validation/model layers.

## Legacy Package Import

- Legacy packages are supported as read-only imports.
- Current package import covers `game`, cover `image`, `fonts/*`, `textures/*`, and safe project-relative auxiliary entries under paths such as `audio/`, `data/`, `music/`, `resources/`, `scripts/`, `shaders/`, `sounds/`, `text/`, and `texts/`.
- Package writing/export is not part of the current compatibility promise.

## Save JSON Preservation

- Save JSON import/export preserves recognized runtime fields and unknown extra keys when parsed through the save document APIs.
- Save parsing preserves the compatibility boundary; runtime mutation policy, autosave behavior, and object placement application are still active work.

## Runtime Controller Coverage

Current backend-neutral controller coverage includes:

- room entry and room navigation
- room object and starting-inventory views
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
- Package writing is not implemented.
- Runtime autosave and save-slot mutation policy are incomplete.
- Persisted object-location application beyond the currently modeled room/inventory behavior is incomplete.
- Rich-text semantics are backend-neutral, but full visual parity for old ActiveText/effect rendering is not complete.
- RmlUi runtime components for complex widgets such as ActiveText, MapView, and TextLog are still active work.
