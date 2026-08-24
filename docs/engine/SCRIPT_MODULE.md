# Script Module Component

## Contract

A Script Module is a runtime resource containing Lua source. In the assembled internal authoring model,
source is exactly inline Lua or a typed Asset reference. Workspace-v1 persistence never stores that
inline Lua text in the record JSON: file-backed modules store an explicit safe `scripts/*.lua` path and
the source bytes live in that file. Script Modules are not entities, property owners, entrypoints,
continuation targets, or mutable session records.

Modules never autorun because they exist in a collection or package. Every Project names one Bootstrap Module by stable Script Module ID. A fresh Project VM imports that module synchronously before the Room/Scene/Dialogue entrypoint begins; other modules execute only when the Bootstrap Module, another explicit runtime reference, or a compiled hook mapping imports them. Bootstrap and module initialization cannot yield.

Bootstrap may register engine-defined hooks through `hooks.register(semantic_kind, hook_kind, selector, module_id, export_name)`. The current registry admits only the closed Room hook family. Selectors are typed as exact identity, a trailing qualified-prefix wildcard such as `chapter.*`, or catchall `*`; resolution is exact, then longest matching qualified prefix, then catchall. Direct Room mappings from the compiled Project and Bootstrap registrations share one registry. Duplicate mappings for the same semantic kind, hook kind, and selector are errors. Before On Game Ready, NovelTea imports every referenced handler module, validates the named export as a function, and freezes the registry. On Game Ready and later runtime code cannot mutate it.

A loaded module opts into **On Game Ready** by exporting `on_ready` as a function. After authoritative runtime state exists, NovelTea runs all loaded handlers synchronously: imported dependencies first, then stable Script Module ID order. This lifecycle runs for initial session creation, reset, and successful restoration. It may read authoritative gameplay state and rebuild module-local/transient Lua state, but its dedicated capability profile admits no gameplay mutation and no yielding. It also cannot initialize a module that was not already loaded during Bootstrap/module initialization. Invalid `on_ready` exports or handler failures reject the lifecycle operation. There is no separate effectful New Game Hook.

## Execution and state

Conditions and text expressions are synchronous and cannot yield. Effect scripts and explicit script instructions may yield and return a closed Completed/Suspended outcome through `core::Result`. Every suspension has an engine-owned typed correlation handle bound to one flow frame.

Lua VM and coroutine state are never serialized. Saving is rejected while suspended unless an engine-defined serializable wait token represents that suspension. Lua reads/writes globals and definition properties only through declared typed APIs; it cannot inspect or replace generic property JSON.

## Authoring, compiled, and state disposition

- **Authoring:** collection-specific Script Module record with file or Asset source in tracked workspace-v1 persistence and editor-facing label/notes. A file source is an explicit safe project-relative `scripts/*.lua` path; assembly restores the existing internal inline representation for compiler/editor consumers. File presence never changes explicit execution/autorun rules.
- **Compiled/package:** validated `ScriptId`, source/resource reference, explicit call sites, and direct definition hook mappings as stable `{Script Module, named export}` references. Native package loading validates Lua syntax before use.
- **Mutable:** engine-owned invocation/correlation state only; serializable logical waits may enter `SaveState`, never VM state.
- **Tooling only:** categories, tags, colors, sort keys, source-editor selection, diagnostics display, and preview state.

The TypeScript compiler treats Lua as opaque text after structural validation. For inline modules, lightweight tooling metadata recognizes literal `import('module-id')` calls, `on_ready` declarations, and literal Bootstrap `hooks.register(...)` calls without pretending to parse arbitrary Lua. Statically knowable missing literal imports, literal import cycles, invalid hook kinds/selectors, missing hook modules, and duplicate literal mappings are authoring errors. Registry analysis can explain the winning exact/prefix/catchall mapping, fallbacks, conflicts, capability profile, and source for a target; dynamic registration or asset-backed source is reported as uncertainty rather than guessed. Preview/export certification and shipped package loading remain runtime-authoritative and use the native Lua loader for syntax and handler validation; no JavaScript Lua parser dependency is introduced.

## Implementation

The editor's assembled model supports a strict mutually exclusive source union: inline Lua or a typed
script Asset. The workspace codec maps the inline branch only to/from its explicit file source and
rejects persisted Script Module `inline-lua` JSON. Validation confirms that an asset-backed source is
a script asset. The compiler preserves either assembled source in the canonical compiled artifact and
emits the Project's stable `bootstrapModule` reference and Room `scriptHooks` mappings in the current compiled-project format.

The native Project loader gives every Script Module a module-local environment with an `import(id, export?)`
function. First import executes the target once in the current Project VM, requires the module to return an
exports table, caches that table, records the import dependency for deterministic On Game Ready ordering, and
returns either the table or the requested named export. Repeated imports return the cached object. Missing
modules, missing named exports, import cycles, yielded initialization, and failed initialization are hard errors;
a failed module is not retried in the same VM. `package`, `require`,
`dofile`, `loadfile`, and unrestricted filesystem loaders remain unavailable. There is no legacy
Script/CustomScript entity path, implicit collection execution, or generic property API.
