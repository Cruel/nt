# Native editor main-process authority ledger (#539, pre-cutover)

This ledger tracks the **ordinary Electron main-process call sites**, including
lazy entrypoints. Native-session certification is not production selection.
Until #521 atomically switches editor and CLI, the ordinary editor intentionally
retains the legacy path. No native failure may fall back to that path.

## IPC and service call-site matrix

| Main owner / service | Retired Project dependency and live legacy caller | Native owner or retained non-authoritative utility | #521 remaining work |
| --- | --- | --- | --- |
| `main.ts`, `OPEN_PROJECT`, `CREATE_PROJECT`, `COMPLETE_PROJECT_IMPORT`, `CLOSE_ACTIVE_PROJECT` | `editor-tool-service.openProject`, `project-file-service.createProject`, `desktop-project-import-service.importDesktopProject`, `ActiveProjectSessionService.attachToSuccessfulResult` | `NativeEditorProjectHandoff` / `openNativeEditorProject`; `createNativeEditorProject`; `native-desktop-project-import-service`; controller disposal and staged-session promotion | Delete legacy Open/Create/Import branches, test-only selector, old result/snapshot admission |
| `active-project-session-service.ts` | `createNodeProjectWorkspaceService` and `ActiveProjectWorkspaceSession` for legacy Open/reload; parser used for legacy Asset capabilities | Native staging/promotion and `acceptNativeProject` admit worker-provided identity and Asset capabilities; physical read/list are session-scoped | Separate remaining legacy attachment, eliminate runtime source/writer import dependency, keep narrow capability/metadata service |
| `project-file-service.ts` | Legacy Workspace save, transaction writer, editor metadata, old recovery, create/copy | Native controller `saveUnit` and `saveText`; `saveNativeProjectCopyAs`; editor-local state writes can remain after removing Project writer | Remove legacy content writes/create/copy, rehome metadata-only persistence |
| `project-source-file-service.ts` | Legacy Project source writes, structural edits and `ProjectWorkspaceTransactionService` | `native-project-source-transactions.ts` plans with `project-source-planning-helpers.ts` + `project-source-usage-reader.ts`; native controller commits via worker; physical shader reads no longer import legacy writer | Remove old write/structural service; keep shared non-authoritative physical/source-planning helpers |
| `desktop-project-import-service.ts` | `createNodeProjectWorkspaceService` + portable legacy bundle writer | `native-desktop-project-import-service.ts`, `verified-project-bundle-download.ts` and CLI native import transaction | Delete legacy import implementation/re-export, preserve HTTPS size/digest protection |
| `project-asset-audit-service.ts`, Asset IPC | Physical audit, untracked import, legacy file-move/restore/purge transactions | Native controller stages/imports/moves/trashes/restores referenced Asset sources; physical audit/inspection and attachment picking are retained as non-Project operations | Audit every untracked/trash action for native journal/recovery parity; remove legacy mutation calls, including indirect helpers |
| `asset-import-service.ts` | Legacy `ProjectWorkspaceTransactionTargetInput` value/type imports used for Asset publication | Native Asset staging and worker journal own writes; common file-byte/path inspection may remain | Drop legacy Asset transaction DTO and send native journal targets only |
| `project-workspace-watcher-service.ts` | Chokidar watcher, legacy source/Asset reconciliation, Workspace snapshot and revision cache | `NativeEditorObserverWatchService` subscribes to the native worker; event DTO stays in `project-watch-events.ts`; only one watcher per native session | Delete legacy watcher imports/registration and cleanup path; preserve renderer event contract |
| `editor-tool-service.ts` | Legacy Workspace Open, project validator, runtime Test and export preparation | `NativeEditorSessionController` provides native Test catalog, revisioned native preparation/Tests; native downstream package/shader utilities are separately owned | Remove legacy Open/Validate/Test/export routes and old authoring validation |
| `editor-runtime-cache-service.ts` | Workspace reopen on cache misses and native-operation-independent TypeScript validation | `NativeWorkingRuntimePreparationCache` in native controller; physical shader/runtime artifact tools remain legitimate | Remove legacy cache service and old cache publications from native route |
| `editor-authoring-validation-service.ts`, `legacy-native-authoring-preview.ts` | Legacy validation adapter and parity-only Workspace snapshot type | Native controller validation and runtime preparation; view/diagnostic DTOs are non-authoritative | Remove validator/preview compare adapter and any legacy normalization invocation |
| `main.ts`, `VALIDATE_PROJECT`, `PREPARE_EDITOR_RUNTIME`, playback IPC | `EditorAuthoringValidationService`, `EditorRuntimeCacheService`, `editor-tool-service` | `NATIVE_PROJECT_VALIDATE`, `NATIVE_PROJECT_PREPARE_RUNTIME`, native Tests; independent font-check presentation remains non-authoritative | Replace legacy IPC handlers and all renderer callers before removing old validation/cache services |
| `platform-export-orchestration-service.ts`, `platform-export-acceptance-fixture-service.ts` | Lazy old Workspace service/Project metadata and legacy package builders | Native `prepareCleanExport` plus native-admitted downstream package and platform tools | Eliminate lazy workspace reopen, rehome physical inputs and package-only DTOs |
| `project-authoring-source-freshness-service.ts`, `portable-project-bundle-service.ts` | Legacy Workspace source metadata and bundled writer | Native observer revisions and native import/export transactions | Delete old Project preparation/persistence; retain non-authoritative bundle transport |
| `active-project-workspace-session.ts`, `project-asset-file-transaction.ts` | Resident Workspace authority / TS transaction writer | Native worker session/journal; retained physical file/path utilities only | Delete old authority, rehome narrow file-system/path contracts |
| `comfyui-editor-run-adapter.ts` and incidental service imports | Legacy Workspace reopen reachable from auxiliary workflow | Native-admitted Asset publication and physical ComfyUI tooling | Remove reopened Project authority even on cache-miss / workflow lazy paths |

The inventory includes value imports, type-only contracts, lazy imports,
re-exports and indirect constructor reachability. Type-only `AuthoringProject`
and schema/view models are not themselves a second disk authority; the full
`LoadedProjectWorkspaceSnapshot` and broad Workspace barrel are retirement
targets. The main bundle's remaining static/lazy legacy imports are explicitly
**not yet clean**. `check:native-production-closure` must continue to reject
them until #521's atomic replacement and physical deletion.

## Implemented pre-cutover safeguards

- `native-project-source-transactions.ts` no longer loads
  `project-source-file-service.ts` and its Workspace/validator/graph imports.
  Shared planning helpers do not construct a Workspace or transaction writer;
  the worker remains the sole source mutation authority.
- Native desktop import no longer imports the legacy importer. Transport-only
  download verification is shared without sharing Project admission.
- `guardNativeEditorProjectAuthority()` is enabled by the native lifecycle
  certification launch before a Project is admitted. Direct
  `ProjectWorkspaceService`, both Workspace factories, a legacy transaction
  writer and old watcher startup fail immediately on that process. It also
  catches lazy caller paths; the legacy authoring validator and runtime-cache
  constructors also fail, and neither is eagerly created in native lifecycle
  main. A runtime failure is **not** a completed import graph or
  production-closure proof.
- The native candidate import-closure test now traverses the actual
  `NativeEditorSessionController`, source-transaction planner and desktop
  importer, rather than only the downstream preparation facade. The native
  physical shader copy path rejects symlink/traversal sources.

## Verification and switch-only handoff

Execute `node --test editor/scripts/native-candidate-closure.test.mjs`,
the native source, worker, lifecycle, observer, recovery and import focused
tests, then `pnpm -C editor run check`, `pnpm -C editor run test` and the
real addon/Electron-worker certification witnesses. The last two proof layers
are separate: mocked unit tests do not establish multi-process disk
coherence, journal recovery or packaged authority.

The real-worker verification from the repository root uses the configured
native addon, not mock fallback:

```sh
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" \
  pnpm -C editor exec vp test run \
    src/renderer/test/native-editor-project-handoff.test.ts \
    src/renderer/test/native-editor-candidate-ipc.test.ts \
    src/renderer/test/native-authoring-reconciliation.test.ts \
    src/renderer/test/native-editor-observer-watch-service.test.ts --maxWorkers=2
ctest --test-dir build/native-authoring-host --output-on-failure \
  -R 'native_authoring_(project_session|working_preparation|yaml_transaction|clean_cache_recovery|source_analysis|project_validation|tests|room_session)$'
pnpm -C editor run test:native-production-closure
pnpm -C editor run check:native-production-closure  # EXPECTED FAIL until #521
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" \
  node editor/scripts/certify-native-authoring-cross-system.mjs \
    "$PWD/build/cli/linux/noveltea"
```

Run the cross-system script with **matching native builds**: it tests real
daemon-originated writes and the editor's observer and Save, including
two-way clean-cache exchange, preservation of an unsaved editor draft and
concurrently submitted native-editor and CLI-daemon writes. Either writer may
win; a CLI `WORKSPACE_BUSY` rejection must leave no partial owner, and a
subsequent post-commit retry publishes both edits without loss.
Using an older CLI than the addon can produce semantic-fingerprint divergence
that is a build-version mismatch, not a coherent-cache pass. Crash-injected
broken journal, unknown external target and stale revision checks are covered
by `native_authoring_yaml_transaction`; superseded candidate/disposal and
in-flight cancellation by `native-editor-project-handoff.test.ts`. The
real-addon IPC witness also checks stale session rejection after reopen.
Actual write overlap is nondeterministic: an observed BUSY denial must be
treated as safe transaction locking, not an unconditional failure.

The #521 atomic operation still must replace and delete the remaining main
legacy imports, all renderer callers, and CLI/ScriptC Project authority,
remove `--certify-native-authoring-lifecycle` / edit test selectors, remove
old watcher/transaction services and cache, enforce the SHA-bound full
production closure, and confirm separately running CLI-daemon/editor
disk/recovery witnesses. No pre-cutover work should flip ordinary routing,
weaken the closure guard or close #521 on candidate-only evidence.

## #540 runtime, Test, and export preparation (pre-cutover)

The native lifecycle and edit candidate routes are now bounded by the same
admitted worker session, but **ordinary editor routing is not switched**:

| Consumer | Native candidate admission | Remaining legacy path until #521 |
| --- | --- | --- |
| Validate Project | `NATIVE_PROJECT_VALIDATE` + independent font presentation | `VALIDATE_PROJECT` / `EditorAuthoringValidationService` |
| Play | `NATIVE_PROJECT_PREPARE_RUNTIME` on the current working revision; acknowledged dirty YAML, Lua, shader overlays stay session-local | `PREPARE_EDITOR_RUNTIME` / `EditorRuntimeCacheService` |
| Test catalog and single/suite | Native complete working Project catalog; `NATIVE_PROJECT_RUN_TEST` / `NATIVE_PROJECT_RUN_SUITE` reuse native session-local compiled runtime | `LIST_PLAYBACK_TESTS` / legacy Test compiler and cache |
| Runtime package | `NATIVE_PROJECT_PREPARE_EXPORT` for clean readiness; `NATIVE_PROJECT_EXPORT_PACKAGE` for a clean native Project and verified saved-source inventory | Renderer `legacy-runtime-artifact-preparation`, `EXPORT_PACKAGE` with renderer-provided compiled gameplay |
| Platform profile | Native export assessment for the selected profile; main `EXPORT_PROJECT_TO_PLATFORM` ignores renderer compilation and passes exact native diagnostics and Asset references to retained staging | Renderer legacy platform preflight and legacy workspace/validator imports in the orchestration service |
| Template selection/staging | Existing template registry, signing, platform staging and native package writer retained after native admission; source generation rechecked before output activation | Standalone staging and template management are physical-only tools and must not open another Project authority |

Export admission rejects any dirty YAML, staged source text, unresolved conflict,
invalid Project, unsafe/symlinked tracked file or changed saved bytes. It
projects diagnostics and referenced Asset IDs supplied by the worker, not a
separately parsed TypeScript `AuthoringProject`. Compilation retains the
host-neutral downstream runtime compiler, Asset packager, shader service,
localization closure, and platform/template tools. Runtime-package publication
uses a sibling private staging path, verifies the **same** source inventory and
working revision before and after the native package writer, and only then
replaces the final path. Platform publication checks the same pinned admission
at the staging boundary; check-only preflight checks it as well. Invalidation
or an intervening editor Save/CLI write fails closed without returning to a
legacy validator. Preview and Tests remain allowed against acknowledged dirty
working snapshots and retain their source-overlay cache lifecycle.

The native-only IPC channels are revisioned, session-scoped and registered in
`editor/scripts/certify-native-cli-inventory.mjs`. The renderer chooses them
only for an admitted native command session; ordinary exports still use the
legacy preparer until #521. Candidate-only tests include clean/dirty rejection,
stale-revision and mid-publication drift, prior archive preservation, native
platform admission versus legacy tripwires, and renderer native dispatch.
These mocked tests do not substitute for the real-addon/Electron worker and
platform/toolchain template witnesses.

**Atomic #521 deletion checklist:** remove `EditorRuntimeCacheService`,
`EditorAuthoringValidationService`, `legacy-native-authoring-preview.ts`,
`legacy-runtime-artifact-preparation.ts`, `legacy-runtime-build-cache.ts`,
legacy Test/Workspace implementations and their old IPC handler routes; replace
the dual-mode renderer Export and Preview branches and remove the test-only
launch selection. Delete legacy on-disk runtime cache publication only when
native working/runtime cache plus CLI source-generation authority are the sole
owners. Keep the retained host-neutral runtime compiler, native shader compiler,
package writer, template registry, platform staging/signing, physical Asset
packaging and session-local native runtime cache. The documented
`check:native-production-closure` must continue to fail until those removals.
