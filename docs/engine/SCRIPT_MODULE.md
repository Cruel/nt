# Script Module Component

## Contract

A Script Module is a runtime resource containing Lua source. Source is exactly inline Lua or a typed Asset reference. Script Modules are not entities, property owners, entrypoints, continuation targets, or mutable session records.

Modules never autorun because they exist in a collection or package. Lua executes only through the explicit synchronous project startup hook, a typed expression/effect/instruction reference, or an explicit host request. The startup hook must complete without yielding before the Room/Scene/Dialogue entrypoint begins.

## Execution and state

Conditions and text expressions are synchronous and cannot yield. Effect scripts and explicit script instructions may yield and return a closed Completed/Suspended outcome through `core::Result`. Every suspension has an engine-owned typed correlation handle bound to one flow frame.

Lua VM and coroutine state are never serialized. Saving is rejected while suspended unless an engine-defined serializable wait token represents that suspension. Lua reads/writes globals and definition properties only through declared typed APIs; it cannot inspect or replace generic property JSON.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Script Module record with inline or Asset source and editor-facing label/notes.
- **Compiled/package:** validated `ScriptId`, source/resource reference, and explicit call sites. Native package loading validates Lua syntax before use.
- **Mutable:** engine-owned invocation/correlation state only; serializable logical waits may enter `SaveState`, never VM state.
- **Tooling only:** categories, tags, colors, sort keys, source-editor selection, diagnostics display, and preview state.

The TypeScript compiler treats Lua as opaque text after structural validation. Preview/export certification and shipped package loading use the native Lua loader for syntax diagnostics; no JavaScript Lua parser dependency is introduced.

## Current implementation scaffold

The current editor exports broad script records and native `ScriptRuntime` supports restricted Lua plus transitional game bindings. Legacy Script/CustomScript numeric entities, implicit execution paths, optional-based script results, and generic property APIs are temporary migration debt. Phases 3, 4, 6, and 7 replace them without compatibility shims.
