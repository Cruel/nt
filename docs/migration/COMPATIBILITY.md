# NovelTea Compatibility Notes

Last updated: 2026-06-19.

This note describes the compatibility boundary for the migrated `nt` runtime as of Phase 11.

## Supported Compatibility

- Legacy `game` JSON can be imported through `legacy::ProjectImporter` and editor-facing `ProjectTooling`.
- Imported project JSON is preserved losslessly for supported shapes, including unknown top-level extension keys.
- Normalized project JSON can be loaded, validated, edited at raw legacy entity-record granularity, and serialized through backend-neutral editor APIs.
- Legacy ZIP project packages can be read in read-only mode. Supported entries are `game`, cover `image`, `fonts/*`, `textures/*`, and safe auxiliary project-relative entries under `audio/`, `data/`, `music/`, `resources/`, `scripts/`, `shaders/`, `sounds/`, `text/`, and `texts/`.
- Save JSON import/export preserves recognized runtime fields and unknown extra keys when parsed through `SaveDocument`.
- Runtime controllers cover room entry, room navigation, room objects, starting inventory, verb/action resolution, dialogue traversal/options/logging, cutscene page expansion/continue, timers, text-log events, save entrypoint restore, and backend-neutral command capture.
- Editor preview tooling can start, stop, reset, override entrypoints, step/tick, inspect state, inject navigation/dialogue/continue/action input, and collect emitted controller commands.

## Known Limits

- Package writing is not implemented. Legacy package support is read-only.
- Old JavaScript script bodies are not executed. Script hooks and action/dialogue/cutscene script points emit `ScriptDeferred` commands or run through the newer Lua compatibility layer where bindings exist.
- Duktape, dukglue, SFML, and Qt editor runtime behavior are not part of the new runtime.
- Runtime autosave policy is not fully implemented. Autosave flags are parsed and surfaced in controller command data where currently modeled, but save-slot mutation is still separate from controller progression.
- Object location persistence beyond starting inventory and current room object visibility is not fully applied to runtime object placement.
- Real-project fixture coverage is still limited to reduced synthetic compatibility fixtures in this repository. Add private or redistributable old project fixtures before claiming broad project corpus compatibility.
- Rich-text rendering effects are parsed into backend-neutral semantics, but full visual parity for old shader/effect rendering is not yet promised.

## Phase 11 Fixture Coverage

The current compatibility completion tests cover:

- Legacy project import and editor save round-trip for a reduced old-style project.
- Save JSON parse/dump preservation for runtime fields, object locations, log, properties, room descriptions, visited rooms, and unknown extra save keys.
- Legacy ZIP package import and preservation of supported package entries while ignoring unsupported safe-but-unmounted notes.
- Runtime command goldens for cutscene continuation, room entry, action resolution, navigation, dialogue text/options/logging, text-log events, timers, save entrypoint restore, and inventory/object view derivation.
