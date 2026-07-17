# Migration Status

## Typed-runtime migration: complete

NovelTea has one shipped gameplay path:

```text
AuthoringProject V2 -> compileAuthoringProject -> noveltea.compiled.project V1
  -> LoadedCompiledPackage -> RunningGame -> RuntimeSession
```

`SessionState`, `SaveState`, the closed runtime message vocabulary, and `RuntimeScriptApi` are the
only gameplay state, persistence, communication, and Lua mutation surfaces. Preview, playback,
package/platform export, sandbox, player, Web, and Android consume the same canonical compiled
artifact.

The final capability dispositions and behavioral evidence live in
[`docs/architecture/RUNTIME_CAPABILITY_DISPOSITION.md`](../architecture/RUNTIME_CAPABILITY_DISPOSITION.md).

## Presentation migration: complete

The shipped host, sandbox, player, RuntimeUI, editor preview/debugger, recorder/playback, and editor
runtime protocol consume the final coherent `RuntimePublication`, targeted finite operations, scoped
desired state, and typed system/custom Layout APIs. RuntimeUI is a one-way adapter rather than a
snapshot or operation broker. Generic targetless transition/Layout operations, RuntimeUI state
read-back, detached playback `finalView`, and duplicate Room-overlay/Layout-slot runtime ownership are
absent from the production path.

The final ownership and deletion evidence lives in
[`docs/architecture/PRESENTATION_AND_CHECKPOINT_OWNERSHIP.md`](../architecture/PRESENTATION_AND_CHECKPOINT_OWNERSHIP.md).

## Deliberately absent

There is no shipped old-project importer, legacy package reader, dual authoring/runtime schema,
`ProjectDocument`/`ProjectModel`/controller path, JSON-backed save or message state, generic entity
property bag, JavaScript/Duktape runtime, or compatibility Lua binding. Unsupported schemas and
versions fail through strict diagnostics.

## Independently deferred work

- Font-family resolution and multilingual text assets:
  `docs/rendering/plans/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md`.
- Platform identity, signing, and export certification:
  `docs/editor/plans/PLATFORM_EXPORT_AND_APP_IDENTITY_IMPLEMENTATION_PLAN.md`.

These plans consume typed runtime views or compiled-package contracts and do not reopen the completed
runtime-model migration.

## Verification baseline

For engine/runtime changes, run Linux and Web builds, `cxx-policy`, `json-boundary-policy`, Linux
tests, and formatting. Run editor lint/typecheck/tests for editor changes, and Android when the SDK
is available for shared CMake/runtime/package changes. See `docs/build/BUILD_AND_VERIFY.md` for the
commands.
