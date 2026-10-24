# Native Project cutover readiness / deletion plan (#520)

The main-process caller/authority matrix, native-session tripwire and
remaining #521 deletion registrations are maintained in
[Native editor main-process authority ledger](NATIVE_EDITOR_MAIN_AUTHORITY_BOUNDARY.md).

Status: **pre-cutover readiness accepted** (2026-10-23; production routing unchanged).

## #521 current integration gate (2026-10-24)

### Retained runtime-tool separation (pre-cutover)

Compiled-runtime Test transport, package publication/diagnostic projection and media
operations now live in `main/services/native-runtime-tool-service.ts`, not the retired
`editor-tool-service.ts`. Main-process publication/compiled playback, package-smoke
media checks and native package equivalence witnesses import the retained service
directly. Shader callers use `native-shader-compiler-service.ts`; the Node media-tool
entrypoint resolves the installed CLI directly without loading the old Project service.
The candidate import-closure test includes the retained runtime-tool entrypoint.

This is **not the atomic cutover**: `editor-tool-service.ts` still owns production
legacy Open/validation/Project-to-Test routes. The package-smoke thumbnail fixture
still uses legacy Create/Open/Save and must be replaced before claiming execution
with the old engine absent. Ordinary editor and CLI selectors remain unchanged.
A fresh normal build still fails strict production closure with 67 reported retired
module occurrences. No closure assertion was removed or waived.

Verification for this separation: editor `check` and `build` passed; full editor
suite **3,112 passed / 166 skipped**; focused platform/shader tests **9 passed /
1 skipped**; real-addon native runtime/Test/package equivalence **1/1 passed**;
candidate import-closure tests **3/3 passed**. Existing equivalence coverage checks
compiled/package output, authored Test execution and clean/dirty separation; no
new authored Feature Lab content is required for this import-only change. The
complete flag-free installed/packaged-host lifecycle, physical retirement and
release-host matrix remain unexecuted for #521 because the switch is incomplete.

### Rebuilt pre-cutover production-closure audit (October 24, 2026)

The actual *ordinary* Electron and ScriptC build at `013d3d50` still fails
native production closure. The retirement guard now also covers the legacy
editor validator, legacy runtime cache and artifact preparation, and the
comparison-only native/legacy preview adapter. Failure messages identify their
output root rather than deduplicating different roots that happen to have the
same chunk name. The resulting strict report is **67 emitted violations from
22 distinct retired modules**, grouped as **main 21, renderer 9, shipped Node
tools 19, and ScriptC island 18**. These counts supersede the narrower 38-hit
baseline below; they are not a claim of 67 independent features or fixes.

An experiment replacing the editor certification selector with unconditional
native enablement did **not** eliminate the main-process legacy dependencies.
It was reverted, and the ordinary production editor and CLI remain on their
pre-cutover, coherent routes. Physically retiring and replacing all shipped
legacy consumers, removing the CLI/renderer legacy branches, and exercising
the installed native editor+CLI together are **still required**. A candidate
pass or a flag-only switch must never be treated as #521 acceptance.

During #521 integration, the native renderer Save/Save All paths now delegate
semantic rejection exclusively to the native revision-scoped transaction; the
remaining editor checks cover pending input, external conflicts, and atomic
Save-unit selection. Native rejection diagnostics are forwarded to the
renderer rather than replaced unconditionally by a generic error. The shared
watch-event payload and its view-only reconciliation predicate have been
separated into `project-watch-events.ts`, so the eventual retirement of the
TypeScript watcher does not require dropping the renderer's event contract.
These changes **do not** constitute the production switch; the renderer's
remaining legacy graph and other Project routes still require reconciliation.
The edited workspace passed the complete editor suite (**3,080 passed, 165
skipped** across 362 files), `pnpm -C editor run check`, Electron pack, and a
fresh renderer build. The focused native Save/command suite passed 50/50 after
the native rejection detail and fallback-error regression cases were added.
The strict emitted production closure gate still fails with 38 retired edges;
therefore neither native production certification nor #521's completion
acceptance has been established. The normal `noveltea:certify` command and CI
routing remain untouched until the coordinated production switch.

The standalone #534 suite now supports **`--production`** on the same
reference-independent public CLI, Feature Lab, cache, Tests, package, Web
platform, ComfyUI publication/race and editor/CLI disk witnesses as its
native-only candidate mode. It first requires SHA-bound provenance over all
six emitted Electron/ScriptC roots, and rejects every retired Project module.
The ordinary CLI builder also emits `native-production-build.json` with
installed-executable SHA256 and production ScriptC-island provenance SHA256;
candidate builds replace that record with the separate candidate identity.
The build record proves **which executable was built**, not native authority;
full bundle closure and the public lifecycle remain separate requirements.

After the *atomic* native cutover, run the ordinary build and then:

```sh
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" \
  pnpm -C editor run noveltea:certify:native-candidate -- \
    "$PWD/build/cli/linux/noveltea" --production
```

**Current blocker: production retirement is incomplete.** On the rebuilt
pre-cutover Electron outputs `check:native-production-closure` still finds **38**
retired module edges (39 before the watch-event DTO separation). Production `editor/src/main.ts` still
uses the opt-in editor lifecycle/mutation flags and old tool/runtime-cache/
workspace watcher imports. Separately, the renderer eagerly starts the
TypeScript `authoring-dependency-graph-runtime.ts` service, whose direct
imports include `authoring-dependency-graph`, `authoring-source-analysis` and
`project-workspace-service`. Real consumers include Project Explorer,
command history, focused preview, asset/interactable/variable/localization
editors and `DerivedPreviewPane`. Native Save and structural-persistence
control flow additionally retains calls to the TypeScript authoring validator.
Merely activating native Open/Edit/CLI flags would leave duplicate authority
and fail the executable retirement guard. The native CLI candidate is clean,
but the ordinary ScriptC island still imports the old application/Workspace.

The next **single atomic** #521 delivery must replace those renderer graph/
validation/Save dependencies with native-authoritative projections, remove
superseded main/CLI/renderer imports and physical TypeScript implementations,
activate the native editor and CLI together, then enforce bundle and packaged
closure in CI. No partial routing, dropped workbench behavior or weakened
guard is an acceptable interim state; #521 stays open until the cutover itself
and its production-path verification are complete.

Local preparatory verification at `95b9dc27` plus the #521 working changes:
the native-only CLI build and standalone candidate suite passed **9/9**
stages, including real Electron worker/CLI clean-cache and Save, Feature Lab
runtime and UI Tests, Package output, Web preflight, ComfyUI and daemon/Asset
races. The ordinary CLI build generated a matching SHA-bound production
executable/island record, but its production suite correctly rejected all
39 retired emitted module edges **before** Project execution. The complete
editor suite passed 3,077 tests (165 skipped); editor check, schema and
lint passed; native qualification/closure tests passed 17/17, including
mutated executable, stale module provenance and missing candidate proof.
None of these results proves the missing switched/retired production build
or substitutes for #522's packaged and host-matrix certification.

This is the pre-switch evidence ledger for #506/#521, not a claim that production
has changed. #504 (editor) has been accepted and closed. The #505 CLI/daemon
children #512–#518, #519, and #505 are closed. Release-host run
[39997369942](https://github.com/Cruel/nt/actions/runs/39997369942),
attempt 2, passed at SHA `399b899c8a1b399e75871968f727d3e46dcea5f9`.
Linux/Windows/macOS editor jobs exercised real native addon, installed CLI
candidate, cross-system exact-cache, separate worker/daemon, dirty isolation,
watcher and Save. Windows standalone CLI also passed. Later branch changes
removed diagnostic instrumentation; they were not run at this exact SHA.
**No unresolved required row below may be waived by opening #521.** The issue
tracker is the authority for blocker closure; review current issue state and
current CI run SHA, not merely this dated snapshot.

## Executable inventory, not a representative collection sample

- The complete schema-derived record family set is
  `editor/src/shared/project-schema/authoring-collections.ts` (16 keys:
  Assets, Animations, Variables, Materials, Layouts, Archetypes, Characters,
  Rooms, Interactables, Verbs, Interactions, Dialogues, Scenes, Maps, Scripts,
  Tests). Keep this checked against `editor/scripts/generate-native-schema.mjs`,
  `tools/project_authoring/generated/contracts.json`, native session admission,
  and `editor/scripts/certify-native-cli-project-routing.mjs`. Collection-count
  agreement alone does not establish record-specific diagnostics or caller parity.
- Non-record tracked owners: `project.yaml` (identity/settings/export),
  `traits.yaml`, `editor.yaml` (Chapters, Tags, record metadata), split
  `i18n/{project,messages,usage-notes,tracking,orphans}.yaml`, per-locale
  translation and localized-Asset fragments; tracked Lua/RML/RCSS/shader
  source files; Layout companion files, referenced binary Assets and
  supporting files. The native workspace/session, snapshot inventory and
  source-generation proof must agree on these paths and exact bytes.
- CLI coverage is *derived and enforced* by
  `editor/scripts/certify-native-cli-inventory.mjs`: public help definitions,
  concrete parser commands, routing, special CLI/ScriptC dispatch, C++ native
  bridge actions, and native editor IPC endpoints. At this baseline the checked
  list covers **39 public paths, 28 C++ actions and 10 editor native IPC
  endpoints**. The inventory classifies daemon-control/raw shader/texture/
  media/template commands separately from Project-authoritative paths. The
  script's static witness mapping is only a completeness check; the installed
  CLI differentials, real addon and runtime tests are separate requirements.
- Editor caller coverage must be checked against `editor/src/main.ts` guarded
  IPC registration, `editor/src/shared/ipc-channels.ts`, renderer command
  registry, `native-editor-ipc-routing.ts`, `NativeEditorSessionController`,
  Save coordination, external-change publication, preview/Test and export
  consumers, plus `#504`'s whole-workbench parity suite. A small worker fixture
  cannot replace the full editor registry/corpus. Changes to any of these
  inventories require updating its executable guard and witnesses together.

## Acceptance matrix / responsibility

Statuses: **candidate** = implemented/tested in a limited certification mode;
**open** = required gate not yet fully witnessed or signed off; **proved-local**
= executable local result on the current checkout. CI-host evidence must be for
the same commit and artifact generation as the eventual switch.

| #474 / #506 obligation | Owner; code seam | Evidence / reproduction | Readiness |
| --- | --- | --- | --- |
| Whole-schema family/default/ref/diagnostic coverage | #504 + #505; generated contracts, native `ProjectSession`, inspector/CLI router | schema generation, native CTest, `native-project-session-parity.test.ts`, `certify-native-cli-project-routing.mjs` on Feature Lab and negative fixtures | **accepted candidate**: #504/#505 closed; 82-command parity on three release hosts |
| Every editor caller, generic mutations, structural persistence/undo | #504 (#508/#511); `native-editor-session-controller.ts`, command store, native Save | `native-command-store`, `native-project-session-parity`, `native-project-source-transactions`, `native-project-copy-service`, full editor suite | **accepted**: #504 closed; production activation remains #521 |
| Conflict/Use Disk, invalid owner isolation, Comment Keep/Remove/Cancel, scoped Save/Save All | #504 (#509/#511); native working project, Save coordinator | `native-authoring-reconciliation`, `native-external-projection`, `project-save-coordinator`, C++ YAML transaction CTest and negative revisions | **accepted-candidate**: #504 closed; post-switch whole-lifecycle exercise #522 |
| Durable dirty/text recovery, cold reopen, transaction uncertainty | #504 (#510) and native transaction foundation; `.noveltea/editor/native-dirty-state.json`, native worker journal | `native-dirty-recovery`, `native-project-source-transactions`, `native-authoring-worker`, C++ transaction CTest | **accepted candidate**: #504 closed; post-switch user lifecycle remains #522 |
| Source/Asset races, untracked/attached files, shader copies, Save Project Copy As | #504 (#511); native Project file operations, Asset staging, copy service | `native-asset-staging`, `native-project-copy-service`, `native-project-source-transactions` and native addon tests | **accepted candidate**: #504/#511 closed |
| Public Project CLI/daemon commands, options and private transport | #505 (#512–#519); native CLI candidates, ScriptC island, native bridge | `certify-native-cli-inventory`, installed routing/transport/mutations/commands; native lifecycle/validation/tests/package/platform suites | **accepted candidate**: #512–#519 closed; cross-host CI passed |
| Full validation, source locations, invalid required/unrelated sources, native warm/cold evidence | #505 (#513/#519); native Project validation, staged font/shader checks | `certify-native-daemon-validation`, `native-cli-validation.test.ts`, invalid-source fixtures, native clean-cache CTest | **accepted candidate**: negative suite and host validation passed |
| Authored Tests, preview, working export and native runtime preparation | #504/#505 (#514–#517); native preparation, downstream compiler/runner | `native-authoring-runtime-preparation`, `native-cli-tests`, `native-cli-package`, `native-cli-platform`, Feature Lab authored Tests, package/export witnesses | **accepted candidate**: package/platform/Test host cert passed; post-switch lifecycle remains #522 |
| Optional-Project ComfyUI, source/reference/Asset publication | #505 (#518); native ComfyUI admission and Asset publication | `certify-native-cli-inventory`, ComfyUI tests and exact-source publication races | **accepted candidate**: #518 closed |
| Separate editor/CLI session and cache interoperability in both directions | **#520**; shared native clean-cache contract and independent editor worker/installed CLI | `certify-native-authoring-cross-system.mjs`: exact source hashes and semantic fingerprint, cache hit without republishing, concurrent dirty working state, daemon and local CLI, watcher, editor Save | **accepted**: Linux/Windows/macOS host matrix passed |
| Performance before switching | #519 CLI; **#520** editor/cross-system | `certify-native-cli-performance.mjs` (six phases) and `certify-native-editor-performance.mjs` (five paired real-addon/legacy phases including downstream Runtime Package preparation), both flag only slowdown exceeding **3x and 500 ms** | **proved-local**; post-switch production comparison belongs to #522 |
| Real addon, watcher, transaction, CLI on Linux/Windows/macOS | #503 foundations, #504/#505 and **#520** for integration | `release.yml` run 39997369942 at 399b899c, real addon + installed CLI and cross-system checks on Linux, Windows and macOS | **accepted** |
| Feature Lab/examples manual Open/Edit/Save/Save As/Play/Test/Export/Reopen | #504 + #522 (production qualification); runtime Lab and examples | focused native regression suites plus `PROJECT_VALIDATION_AND_SAVING_CERTIFICATION.md` manual checklist | **post-switch #522**: manual production lifecycle is deliberately not a pre-switch #520 gate |
| Physical retirement, version policy, import guards and docs | **#521**, scoped by inventory below | production-only import/build/run assertions; published package inspection; `check:schema-version-policy`, Agent Kit/schema generation | **not started**: prohibited under #520 |

The **#520** row for clean interoperability is incremental coverage, not a
substitute for the #504/#505 suites. Its test starts a real Electron worker
and the independently launched installed CLI, validates in both orders,
proves exact hashes in `.noveltea/cache/authoring/native-clean-current.json`,
asserts no cache republish on a hit, retains an editor-only dirty Project,
observes CLI disk writes, and then verifies a native editor Save through the
CLI. The daemon has its own resident owner/runtime root; the test does not
share a worker handle, TypeScript mutable Project service or dirty journal.
Both candidate switches and poisoning are **test-only**. No production flag
is set by normal users.

## Coordinated #521 deletion and retention inventory

Classify by *function/import edge*, not by a filename prefix. A shared
module may contain both retired authority and still-needed downstream glue;
split it before deletion rather than removing a needed compiler or leaving a
second active Project reader hidden behind a generic name.

Concrete production transition roots: `editor/src/main.ts` presently selects
`nativeEditorMutationEnabled`/`nativeEditorAdmission` by certification argv
and registers authenticated native `NATIVE_PROJECT_*` alongside legacy IPC.
`editor/src/renderer/commands/native-command-execution.ts` and the command
store select async acknowledged native edits, while Project Save coordination,
Project Explorer/source buffers, preview/Test and exports select their
respective candidate transports. On the CLI side, `editor/src/cli/application.ts`,
`editor/src/cli/command-routing.ts`, `editor/scripts/noveltea-scriptc-island.ts`,
the daemon resident owner and `tools/editor_tool/tooling_native_scriptc.cpp`
decide Project authority and bridge operations. Their private consumers must
move in the same change as the public entrypoints; removing only a high-level
flag is not a completed switch.

| Boundary | Retire/replace atomically in #521 | Retain or audit carefully |
| --- | --- | --- |
| Editor production routes | `--certify-native-authoring-open`, `--certify-native-authoring-edit` test gate as a production selector; legacy `SAVE_PROJECT_CONTENT`, `WRITE_PROJECT_SOURCE`, fallback source/Asset mutation/writer and old validation/preview/Test/export Project preparation routes; duplicate Project authority in `active-project-session-service`, `project-file-service`, `project-source-file-service`, `editor-runtime-cache-service`, `editor-tool-service`, legacy `project-workspace-watcher-service` | authenticated IPC transport and per-project identity/session checks, source-buffer UX, command intent/history, Save-unit selection, local-only drafts and presentation; move to unconditional native service |
| TS workspace engine | `project-workspace-service.ts`, `node-project-workspace-service.ts`, `resident-project-workspace-session.ts`, `resident-project-workspace-service.ts`, `project-workspace-source-codec.ts`, workspace transaction/writer, `project-workspace-watch.ts`, duplicate Project parsing, default expansion, validation/analyzers, source rewrite and authoritative caches where their exports are replaced by native | file-system/path containment and session/transaction safety utilities only if still independently needed by native adapters; generated schema types, UI/input parsers, export policy types |
| CLI/daemon | legacy Project command implementations in `semantic-project.ts`, `fmt-command.ts`, `project-bundle-cli.ts`, old Project handlers in `application.ts`, dynamic TypeScript Project-authority branches in `noveltea-scriptc-island.ts` and resident daemon owner; `NOVELTEA_CLI_CERTIFICATION*` authority-selection/fallback branches | public command/parser/transport envelope/exit-code logic, native bridge, raw shader/texture/media controls, platform/signing/template tooling, compiled runtime/test runners, appropriately scoped ScriptC/QuickJS embedding |
| Semantic analyzers | TS *authoritative* `authoring-source-analysis`, `authoring-dependency-graph`, `authoring-validation`/`project-validation`, runtime-preparation revalidation, old localization/Asset source authority and cache contributor graphs | Zod schema generation, transient inspector/UI parsing, generated field metadata, post-admission compiled-project lowering, shader/reflection, FFmpeg/texture tools, runtime consumers and legitimate Test UI predicates |
| Cached state | legacy `.noveltea/cache/authoring` result manifests and redundant workspace/validation-stage readers; obsolete watchers and invalidation registrations | native exact-source `native-clean-current.json`, native downstream stage cache if still required, compiled/runtime binary cache with its own authority; dirty `native-dirty-state.json`, transaction journal and local editor recovery are **not** disposable |
| Build/distribution | stale ScriptC imports/chunks, TS Project engine from editor main/preload/renderer/CLI distributions and obsolete watcher bundles, candidate-only launch flags, obsolete parity-only production imports | Node addon and installed CLI with independent per-host workers, native C++ schema/runtime tooling, source-generation scripts and Agent Kit packaging that remains intentional |
| Tests/docs | runtime fallbacks that compare old/new; production imports of old differential oracle | isolate TypeScript oracle strictly under certification tooling until the switch test is done, then delete/retire differential-only test dependencies; update `docs/editor/CLI.md`, `NATIVE_AUTHORING_WORKER.md`, Project Save/external docs, build/distribution/export docs and schema-version inventory, regenerate Agent Kit/provenance |

Audit generated/published artifacts specifically at
`tools/project_authoring/generated/{contracts.json,operations.hpp,project_types.hpp}`,
`editor/src/shared/project-schema/authoring-graph-field-metadata.generated.ts`,
`editor/agent-kit/`, `editor/agent-kit-provenance.json`,
`cmake/schema_version_policy/{contracts.tsv,rules.tsv,exceptions.tsv}`,
the ScriptC CLI and Electron `dist-*` bundles, and the
`resources/authoring/noveltea-authoring-node.node` package resource. Regenerate
only when inputs/contracts actually change; check all generated artifacts
against the same commit and do not gratuitously rename current serialized
contracts in #520.

Audit the import graph and assembled **bundles** after these deletions; a
source grep alone is not proof. A Project command absent from the native
router must fail internally, not silently fall back. A production editor
mutation must have exactly one acknowledged native authority, even when an
old TypeScript form/parser still generates transient UI intent.

The executable `check:native-production-closure` gate requires a SHA-256-bound
module provenance manifest for **each** Vite-generated editor and ScriptC island
output root, including the renderer and lazy/worker chunks. Missing manifests
must fail rather than silently falling back to source annotations; the latter
remain useful only for isolated single-module test fixtures. This gate is
expected to reject the **pre-cutover** production bundles until the complete
switch/deletion boundary is delivered. It is not a substitute for inspecting
the installed CLI and packaged editor closures in #521/#522.

### #531 native-candidate import boundary (pre-cutover)

This preparatory extraction changes **imports**, not the authority selected by
the shipped editor, CLI, or daemon. The older route remains in use until #521
switches editor and CLI together. Run
`pnpm -C editor run test:native-candidate-closure` to traverse source imports,
including exports and statically named dynamic imports, from the native editor,
CLI Test/package, compiler, source utility, and runtime-preparation entrypoints.
Its negative fixture injects retired authority through an indirect adapter and
asserts that the full provenance chain is reported. This is a *candidate-only*
check; it does not weaken or replace the existing production bundle gate.

| Affected import family | Native candidate/downstream use | Pre-#521 legacy use / #521 deletion target |
| --- | --- | --- |
| Compiled Project and gameplay lowering | `authoring-compiler-lowering.ts` accepts native-admitted records without TS normalization, validation, or linking | `authoring-compiler.ts` injects legacy Zod admission, TS dependency linker, and semantic validator; remove that legacy adapter and its only-old callers |
| Lua/RML and source graph | `authoring-source-downstream.ts` provides lexical/RML/localization utilities; `authoring-native-lua-sources.ts` selects source surfaces from native-admitted record values **without TS record parsing**. The native CLI supplies admitted Runtime Asset references | `authoring-source-analysis.ts` retains the parser-based source selector, old semantic source tracking, and analyzer cache; `authoring-dependency-graph.ts` retains old graph contributors. Remove those old authority modules, caches, and validators |
| Runtime assembly and verification | `runtime-artifact-preparation.ts` consumes admitted native authoring diagnostics, validated contribution marker and native Asset-reference set, projects already-admitted Asset/Animation/Script/Layout packaging fields without TS record parsing, and cannot silently invoke an old analyzer | `legacy-runtime-artifact-preparation.ts` and `legacy-runtime-source-graph.ts` inject obsolete validators/graph and compilation only for pre-switch callers; delete adapters and redirect remaining production callers |
| Runtime/Test cache, Test projection | `runtime-build-cache.ts` requires native admission proof or an explicitly injected legacy validator; `test-playback-projection.ts` constructs typed playback steps without compiling/admitting a Project | `legacy-runtime-build-cache.ts` retains TS validation for old publication; `test-playback-project.ts` retains old runtime preparation / test readiness (delete old-authority portion and wrapper) |
| Project Workspace helpers | `project-asset-source-paths.ts`, `workspace-codepoint-order.ts` and direct `project-workspace-file-system.ts` imports avoid broad Workspace barrels for downstream physical inventory and sorting | `project-workspace/index.ts`, `project-workspace-service.ts`, node/resident service, source codec and associated watchers, source transaction writers remain old authority to remove in #521. Rehome downstream types/contracts before deletion |
| Native CLI and editor adapters | `native-command-results.ts`, `native-package-publication.ts`, `native-shader-compiler-service.ts`, native runtime preparation and native typed Test projection have candidate-only import closure. ScriptC `native-runtime-compile-certify` now consumes the admitted Project/Asset inventory without Zod Project readmission | `cli/commands/native-commands.ts`, `editor-tool-service.ts`, `legacy-native-authoring-preview.ts` retain production/legacy routing and saved-baseline Zod projection; old `FullGamePreviewEditor`, `PackageExportDialog`, and performance-certification preparation use the temporary legacy adapter. Delete obsolete routes and preview bridge in #521, retaining publication/shader utilities |
| Native complete working preparation | C++ `prepare_complete_working` now includes native Runtime Asset-reference IDs; addon exposes these alongside effective native records and source revision proof | Do not reconstruct native source/reference authority in TS. Old CLI/editor candidate comparisons and legacy saved Workspace fallback must be retired during coordinated switch |

The native candidate graph does not import the old Project graph, source
analysis, validator, Workspace service/barrel, or legacy compatibility adapters.
Generated schema types, nonauthoritative projection utilities and native
transport can be retained. Runtime cache publication still uses physical
input inventory checks and must not be substituted for native Project
validation. **#521 still owns production routing, old-authority deletion,
packaged bundle closure and concurrent editor/daemon cutover.** No production
selection was changed for #531. Both native runtime preparation and its
Test playback adapter consume native-admitted record data without running
TypeScript authoring record parsers; the legacy preview adapter retains its
own Test parser until #521. Legacy nested symbol tables are separately held
in `legacy-authoring-symbol-tables.ts`, not in compiler lowering.

### #531 verified evidence (2026-10-23)

- `pnpm -C editor run check`: passed, including schema policy, generated contracts,
  format, lint (zero warnings/errors) and TypeScript typecheck.
- `pnpm -C editor exec vp test run --silent --maxWorkers=4`: **3,059 passed,
  160 skipped; 346 test files passed, 11 skipped**. The prior unconstrained run
  revealed legacy preview/export consumers of the native-only preparation
  entrypoint; those were redirected to the legacy adapter and the full suite
  rerun passed. The previously timed-out Project Explorer test also passed.
- `pnpm -C editor run build:electron`: passed Electron main/preload, native
  worker, tools and ScriptC outputs without changing production routing.
- `pnpm -C editor run noveltea:certify:native-production-unit`: **16 passed**,
  including three new candidate/provenance guard assertions and unchanged
  production bundle-closure fixture tests.
- `node editor/scripts/certify-noveltea-cli.mjs --only=differential` and
  `--only=native-project-export-smoke`: both passed with installed native CLI
  and prepared ScriptC bundle.
- `ctest --test-dir build/native-authoring-host --output-on-failure -j 2 -R '^native_authoring_(working_preparation|asset_animation|tests|source_analysis)$'`:
  **4/4 passed**.
- `NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" pnpm -C editor exec vp test run src/renderer/test/native-authoring-runtime-preparation.test.ts`:
  **8/8 passed** against real Feature Lab, covering dirty Room/Test/RML,
  complete native Project, exact revision and admitted Runtime Asset evidence.
  No authored Feature Lab content change was needed: the existing fixture
  exercises the affected runtime/reference boundary.

No #531 blocker remains. The independent production bundle gate remains a
post-#521 cutover gate and is intentionally **not** relaxed by this work.

### #533 CLI/daemon native handoff preparation (2026-10-23)

The ScriptC island now defers the legacy Workspace service and transaction imports
to the **legacy-only** execution branch. Native certification uses a fail-closed
Workspace factory instead of constructing retired Project authority. The installed
CLI transport witness traces both branches and checks that the candidate never
initializes the legacy writer, without changing the production route. This is a
runtime-import invariant, **not** proof of a native-only packaged closure.

Initial Linux evidence against the rebuilt standalone `build/cli/linux/noveltea`:

- `pnpm -C editor run check`, `pnpm -C editor run build:electron` and
  `pnpm -C editor run noveltea:build` (with required Node 24.18.0 and
  `VCPKG_ROOT`): passed; the installed binary also passed its bundled media
  and ScriptC smoke.
- `node editor/scripts/certify-native-cli-inventory.mjs`: **39** public paths,
  **28** native Project bridge actions and **10** native editor IPC entries.
- `node editor/scripts/certify-native-cli-transport.mjs build/cli/linux/noveltea`:
  **27** paired local/daemon cases passed, plus the new explicit legacy-import
  exclusion witness on the native CLI candidate.
- `node editor/scripts/certify-native-cli-project-routing.mjs build/cli/linux/noveltea`:
  **82** public command comparisons passed, including Feature Lab records,
  scoped reads and unrelated malformed owner isolation. The subsequent
  `node editor/scripts/certify-native-cli-lifecycle.mjs build/cli/linux/noveltea`
  passed local/daemon Create/Export/Import, deterministic ZIP bytes, full
  source manifest/hashes and rejected-import isolation.
- `node editor/scripts/certify-native-cli-package.mjs build/cli/linux/noveltea`:
  passed Runtime Package artifact/manifest parity and pinned owner source-drift
  rollback; `node editor/scripts/certify-native-cli-tests.mjs build/cli/linux/noveltea`:
  **33** public local/daemon Test calls passed.
- `node editor/scripts/certify-native-cli-platform.mjs build/cli/linux/noveltea`:
  passed local/daemon preflight and publication differential; actual credentialed
  signing was not exercised.
- `node editor/scripts/certify-native-daemon-validation.mjs build/cli/linux/noveltea`:
  passed native Project cold/warm validation, cache/source revision invalidation,
  local and resident candidate comparison and invalid manifest repair.
- `pnpm -C editor run noveltea:certify:native-production-unit`: **16/16** passed.
- `pnpm -C editor exec vp test run --silent --maxWorkers=4`: **3,062 passed,
  165 skipped; 347 files passed, 13 skipped** (environment-disabled native and
  optional UI/GPU cases are not native candidate coverage).
- `ctest --test-dir build/native-authoring-host --output-on-failure -j 2 -R '^native_authoring_(working_preparation|asset_animation|tests|source_analysis)$'`:
  **4/4** passed.

The initial emitted-island gap **has since been resolved for the independently
built candidate**. `NOVELTEA_CLI_BUILD_NATIVE_CANDIDATE=1` produces
`editor/dist-scriptc-native-island` with native `native-application.ts`
dispatch instead of the retired `application.ts`. The native resident
Project generation, source-hash admission, physical observer, scoped read
authority, immutable heavy-worker snapshot and pinned Asset/text hydration now
live in `native-resident-project-owner.ts`, which does not inherit or import
the retired TypeScript Workspace implementation at runtime. The candidate also
uses the native ComfyUI Asset publisher and export admission paths; unsupported
Project routes fail closed. The legacy ScriptC island remains the production
output, with no candidate flag enabled by default.

`node editor/scripts/check-native-cli-candidate-closure.mjs` verifies the
**actual emitted SHA-bound module provenance** and fails on retired Project
authority or missing manifests. It is mandatory inside the native-candidate
build, distinct from the deliberately unsatisfied pre-#521 whole-production
closure gate. The native CLI inventory continues to require every C++ bridge
action to have a declared owner (39 public paths, 28 native bridge actions,
10 editor IPC entrypoints); `comfyui-assets` is owned by the separate native
publisher, with no duplicated native transaction interpreter. Project-less
ComfyUI/other static tools continue without a resident Project, while explicit
invalid Projects do not silently fall back.

**Installed Linux native-only candidate verification, after the independent
island build** (`PATH` using pinned Node 24.18.0,
`VCPKG_ROOT=/home/dev/dev/vcpkg`):

- `NOVELTEA_CLI_BUILD_NATIVE_CANDIDATE=1 pnpm -C editor run noveltea:build`:
  passed native-only emitted closure, bundled media check, relocated executable
  with system fonts, cold Project creation and compiler-entrypoint diagnostic.
- `node editor/scripts/certify-native-cli-project-routing.mjs build/cli/linux/noveltea`:
  **82** public command differential cases on Feature Lab passed, including
  resident post-mutation scoped reads and unrelated malformed source isolation.
- `node editor/scripts/certify-native-cli-lifecycle.mjs build/cli/linux/noveltea`:
  passed local/daemon create/export/import, exact ZIP inventory/bytes and
  negative rollback/isolation cases.
- `node editor/scripts/certify-native-cli-package.mjs build/cli/linux/noveltea`:
  passed native Runtime Package bytes, preparation and pinned source-drift
  rejection; `certify-native-cli-tests.mjs`: **33** public Test calls passed;
  `certify-native-cli-platform.mjs`: preflight/publication differential
  passed, without unavailable real signing credentials;
  `certify-native-cli-commands.mjs`: headless command/provenance parity passed.
- `pnpm -C editor run check`: passed, including formatting, lint,
  typecheck, schema policy and generated metadata; full `vp test run`
  **3,077 passed, 165 skipped** (some environment-disabled native/UI/GPU
  tests do not constitute executed native-candidate evidence).
  `ctest --test-dir build/native-authoring-host --output-on-failure -j 2
  -R '^native_authoring_(working_preparation|asset_animation|tests|source_analysis)$'`:
  **4/4** passed. `noveltea:certify:native-production-unit`: **16/16** passed.
- Native resident owner tests separately cover tampered snapshots, altered
  authored bytes, generation-proof failure, stable post-mutation read admission,
  concurrent scoped-read edits, worker metadata mismatch and eviction.
  Native ComfyUI tests exercise Project-less filesystem output, rollback of
  overwritten output on Asset admission conflict and no retry of uncertain
  native commits.
- The installed candidate additionally passed
  **certify-native-cli-owner-lifecycle.mjs** against the Feature Lab fixture:
  a fresh daemon's first scoped platform profile read, repeated warm read,
  stop/restart with identical output, and interrupted generation-pinned
  disposable Test execution without completed-run publication. This uncovered
  and resolved a cold-owner false revision conflict: the ScriptC scoped
  observation bridge must maintain the *same nonempty native observer
  configuration* across capture and verification and settle any initial
  observer-baseline delta only before issuing the native read. Post-read
  verification does not rebaseline concurrent edits.

The independent package comparison used **two actual installed executables**:
the native-only build was retained before rebuilding the current legacy
production CLI. Passing invocations were:

- certify-native-cli-project-routing.mjs with native candidate executable,
  Feature Lab fixture, then legacy oracle executable: **82/82** passed.
- certify-native-cli-transport.mjs with native candidate executable followed by
  legacy oracle executable: **27/27** passed.
- certify-native-daemon-validation.mjs with native candidate executable,
  Feature Lab fixture, then legacy oracle executable: passed cold/warm,
  changed-source, invalid/repair and independent resident-owner comparisons.

Those comparisons did not rely on certification flags to conjure a retired
TypeScript oracle inside the compiled native-only bundle. Production routing
is **not switched by #533**.

The #521 deletion boundary must remove `application.ts`'s legacy
`workspaceServices`/semantic Project fallback, the production CLI `fmt-command`
and `project-bundle-cli` dispatch, the current ScriptC island's legacy writer
factory/transaction import and its `ResidentProjectWorkspaceService` dependency,
and the associated old compiler/validation/authoring-cache chunk entries.
Replace the existing production `dist-scriptc-island` build entrypoint with
the proven native-only candidate, retire the temporary dual-island build option
and certification-only routing, and remove unused legacy service/session/writer
types only after the editor and CLI both switch in one commit boundary.
The `native-project-*` command adapters, native owner, static completion,
broker protocol, publication infrastructure and native compiler lowering
are retained. The old ScriptC host's orchestration and snapshot transport do
not constitute a second semantic Project admission authority.

## Atomic protocol/cache/state disposition


- `native-clean-current.json` is native `noveltea.native-clean-validation.v1`,
  with native `semanticKey`, `semanticFingerprint`, exact Project root,
  SHA-256 file `revisions` (and explicit `absent` for missing fixed owners),
  result and resident contributions. The editor
  worker and disk-only CLI must read/write the **same current native format**
  from independent sessions. A missed fingerprint/old cache is disposable and
  regenerated, never migrated or accepted as an alternate shape. The legacy
  `noveltea.authoring-cache` manifest is not this native contract.
- Keep `noveltea.native-validation-stages.v2` only as an independently valid
  *downstream* shader/font tool-result cache: `nativeIdentity`, source and
  semantic fingerprints must be re-proved. It may be discarded/regenerated;
  it cannot become a backup TypeScript Project validation authority. Audit
  compiled/runtime-cache owners the same way.
- Replace candidate routing (renderer/native `NATIVE_PROJECT_*` IPC,
  `NativeAuthoringWorkingProject`, ScriptC native Project command owner) in
  one build. Synchronize worker request/reply/snapshot schema, preload/main
  IPC types, CLI bridge framing and daemon pinned inputs; update fixtures and
  packaged resource paths in the same commit. No historical reader, old-shape
  alias, per-family toggle or alternate writer.
- **Do not discard user data:** `.noveltea/editor/native-dirty-state.json`,
  `.noveltea/editor/state.json`, `.noveltea/transactions`, Source/Asset
  staging/trash and external conflict preconditions have their own exact
  current version, committed/durable-state and failure policy. Preserve
  acknowledged dirty replay and transaction recovery; reject ambiguous
  identity, revision or malformed state without deleting or adopting it.
  Scoped Save keeps Comment Keep/Remove/Cancel semantics. Distinguish a stale
  *result cache* from an uncertain *physical transaction* at every reader.

## One switch, then qualification (no switch-only shipping phase)

1. **Readiness gate (#520):** close and review #504/#505/#519 with full
   generated family/caller and negative-case witnesses; get cross-host
   addon/CLI tests green at one candidate SHA; record editor/CLI/cross-system
   timings and no-material-regression thresholds. Review both standards
   (single current schema, host build parallelism, security, semantic test
   quality) and #474/#506 coverage. Do **not** flip production now.
2. **Atomic edit (#521):** default editor main/preload/renderer and public
   CLI/daemon together to native Project authority. Remove old workspace
   parsers/normalizers/validators/analyzers/writers/watchers and fallback
   imports **within the same delivery**. Replace stage/cache/contracts and
   generated/build/Agent Kit inputs atomically; no separately shipped mode.
3. **Executable independence gate (#521):** assert every production Project
   entrypoint is routed to native (editor IPC registry + CLI inventory), and
   fail a production build or startup if retired workspace-authority modules
   occur in the main, preload, worker, ScriptC or installed CLI dependency
   graph/bundles. Prove real execution with legacy Project imports removed,
   not only `NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE=1`.
4. **Production qualification (#522):** remove all certification routing
   flags from invocations, exercise independent editor and CLI/daemon as
   installed on the **same tracked Project**, then run Feature Lab/examples
   full manual lifecycle, invalid-source and race fixtures, cold/warm cache
   checks, preview/Tests and package/platform export. Repair any regression
   before shipping. #474 stays open for user sign-off.

Useful exact commands (with host CLI and addon built for the **same** tree):

```sh
node editor/scripts/certify-native-cli-inventory.mjs
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" \
  node editor/scripts/certify-native-authoring-cross-system.mjs "$PWD/build/cli/linux/noveltea"
node editor/scripts/certify-native-cli-project-routing.mjs "$PWD/build/cli/linux/noveltea"
node editor/scripts/certify-native-cli-performance.mjs "$PWD/build/cli/linux/noveltea"
node editor/scripts/certify-native-editor-performance.mjs "$PWD/build/native-authoring-host/noveltea-authoring-node.node"
pnpm -C editor run check
pnpm -C editor run test
pnpm -C editor run check:schema-version-policy
ctest --test-dir build/native-authoring-host --output-on-failure
```

The pre-switch `release.yml` Linux/Windows/macOS host matrix builds the real
addon and downloads installed CLIs for native validation, routing, Tests,
package, platform, **and the cross-system gate**. Require green jobs for the
exact commit; a locally passing Linux candidate and a green older release do
not satisfy this. `build.yml` additionally checks native source transactions,
real worker/reconciliation and Electron addon loading. Long full CLI
certification is not replaced by the quick cross-system gate.

## Evidence and unavailable gates at the recorded baseline

### #521 preparatory bundle-closure enforcement (no authority switch)

`editor/scripts/check-native-production-closure.mjs` is a strict **post-cutover**
check. It inspects emitted Electron, worker, renderer, Node CLI-tool and
ScriptC-island JS chunks, including lazy chunks, using build-emitted
per-output module manifests with code hashes (with module-region/source-map
fallback for independent fixtures). It rejects the retired Project workspace,
validation, dependency/source analysis and watcher modules inventoried above.
Missing bundles or untraceable executable chunks fail closed; pure ESM
forwarders are permitted because their imported chunks are inspected too.
Run `pnpm -C editor run test:native-production-closure` for fixture coverage,
and `pnpm -C editor run check:native-production-closure` **after** the
coordinated #521 code/deletion/build change. The check is intentionally not
part of the pre-cutover `check`/`build` target: it correctly fails against
today's legacy production authority and must be enabled by the atomic cutover
commit, not bypassed or declared passed while old modules still ship.

`editor/scripts/native-production-provenance.ts` now emits the required
verifiable module map at the existing renderer/pack build seams. It covers
otherwise anonymous/minified production output and rejects stale artifacts
when a hash changes without a new manifest. The manifest is build-only
verification metadata and is excluded from the packaged Electron application,
not an authoring cache or runtime schema. The strict guard is not a substitute
for running the installed CLI and packaged
editor with the old engine physically absent; those integration witnesses
must still be added at the same cutover boundary. This preparation changes
neither production routing nor the #520/#519 readiness dependencies.

- Cross-system certification: locally executed on Linux, real rebuilt addon,
  installed CLI and Electron worker; verifies both cache directions, exact
  source revisions, dirty isolation, native editor scoped Save and CLI edits.
  Re-run after any native semantic/host-build change.
- #519 records Linux installed CLI 82/82 Feature Lab public command
  comparisons, 27 transport negative cases and six-stage timing coverage. The
  authoritative raw timing numbers and pass/fail threshold belong to the
  executed `certify-native-cli-performance.mjs` output; do not infer an
  editor baseline from those numbers.
- #520 editor local paired real-addon versus existing TypeScript authority
  comparison, copied Feature Lab on Linux (Node 24.16, single sample; ms):

  | Comparable phase | Legacy | Native | Native / legacy |
  | --- | ---: | ---: | ---: |
  | Cold Project open | 5090 | 679 | 0.13x |
  | One-owner YAML patch + scoped Save, same resulting name | 4737 | 216 | 0.05x |
  | One-source Lua file journal transaction, exact resulting bytes | 7 | 256 | 34.88x |
  | Saved Project semantic preparation (TS workspace open + dependency graph vs native complete working preparation) | 5081 | 3964 | 0.78x |

  These are **pre-cutover baselines**, not production latency claims. The
  single-source Lua case is substantially slower in ratio, but its 249 ms
  absolute delta is below the existing conservative 500 ms and 3x *combined*
  material-regression threshold. The last phase compares corresponding
  Project-admission/semantic preparation responsibilities, **not** the entire
  downstream packaged export. The test uses the native binding and the real
  TypeScript Workspace and source transaction service, not a mock adapter.
  It asserts persisted YAML/source bytes and equal prepared Project identity;
  full editor mixed YAML/text Save and downstream package export timings must
  be measured on the post-switch production lifecycle by #522.
- **Candidate negative-path coverage reconciled:** #504 native renderer and
  real-addon tests cover external disjoint/overlapping edits, conflict choices,
  comment dispositions, typed/structural undo, dirty recovery, revisioned
  source Save, Project Copy As and Asset/file transactions. #512/519 CLI
  standalone/daemon installed tests cover invalid/unsupported source and
  archive, traversal and occupied destination, public JSON/error/exit
  classification, unavailable/broken caches, source/Asset replacement,
  transaction/source races and CLI authoring-engine poison; #514–#518 tests
  cover pinned worker crashes/cancellation, stale Runtime Package/platform
  output rejection and rollback, authored Tests, and ComfyUI owner isolation.
  The reproducible tests/scripts and their case inventories remain with their
  owners (see the matrix above), rather than duplicating their test harness in
  #520. #520's independent cross-system script was rerun locally after
  `e16d42e0`: **PASS** for two-way cache, dirty isolation, native observer and
  scoped native Save.
- **Updated #520 sign-off (2026-10-23):** #519 and #505 closed against successful
  [release run 39997369942](https://github.com/Cruel/nt/actions/runs/39997369942).
  The paired editor performance script now measures the *complete saved editor
  Runtime Package export preparation* on copied Feature Lab projects, using
  the same real downstream `prepareRuntimeArtifact`, shader compiler and source
  path adapter for each candidate. Native preparation uses complete native
  owners; legacy preparation uses the TypeScript Workspace and dependency graph.
  Both outputs were prepared, and compiled Project, gameplay JSON and manifest
  preview compared equal. One Linux run: **legacy 7398 ms, native 2627 ms
  (0.36x)**; cold open 4762/682, scoped YAML Save 4477/203, one-source Lua
  Save 7/253, semantic preparation 4836/3920 ms (legacy/native). All five
  pass the dual 3x-and-500ms material-regression gate. This is a single
  pre-cutover sample, not a repeated performance distribution or actual
  packaged export publication latency. Real post-switch UI and package
  lifecycles remain **#522**, not a missing #520 candidate gate.
- The #512 `platform profiles` exit 70 was fixed in `eef9b50a` (targeted
  regression and full editor suite **3,033 passed, 157 skipped**). #504 was
  independently accepted after **3,096 editor tests passed**, with the sole
  then-failing CLI test subsequently fixed. The legacy test and production
  authority are still present by design until #521. Repository-wide editor
  `check` has 28 pre-existing formatting violations outside this scope.

## Two-axis change review (pre-switch)

- **Repository standards:** Uses authenticated native worker and installed
  CLI test seams, real exact bytes/revisions, scoped temporary roots, existing
  build/release matrix and single-current native cache; no production switch,
  new migration shape, extra daemon or external test dependency. Pinned JS
  formatting, schema-policy check and no-unrelated-source-edit policy apply.
  Cross-host CI completion and the repository-wide existing format debt remain
  explicit unresolved verification, not a claimed green standard gate.
- **#474/#506 specification:** Two-way cache reuse, external watcher,
  private working-state isolation and cross-system Save are directly exercised.
  The original acceptance matrix and cutover/retirement sequence are
  inventoried above. Native editor acceptance #504 is closed, and native
  CLI implementation children, #519, and #505 are closed, and the specified
  release-host acceptance has passed. #520 is now eligible for closure; #521
  is the separate atomic production-switch boundary and remains untouched.

Feature Lab: the real addon/CLI integration test uses a small generated Project
to isolate source/cache proof; full gameplay/UI verification remains covered
by Feature Lab's authored content and the #504/#505/#522 suites, not by this
smoke. No new authored Feature Lab content is necessary for the disk-cache
invariant itself.

### #534: Reference-independent native CLI certification, staged for #521

The pre-cutover certification inventory is deliberately split between the
**retired Project oracle** and legitimate tooling which survives the switch:

| Current dependency | Disposition at the #521 atomic boundary |
| --- | --- |
| `editor/scripts/certify-noveltea-cli.mjs`: `nodeCli` at `dist-electron/tools/noveltea.mjs`, `runNode*`, `differentialCases`, Test/cache/resident/performance/ComfyUI comparisons and Node-backed Project fixtures | Delete or replace **Project-oracle comparisons**. Native candidate contracts and public filesystem readback, not two wrappers of the same Project engine, become mandatory assertions. Keep independent raw `shaderc`/`texturec`, bundled media, host relocation, ScriptC transport and useful non-Project tests. |
| `certify-native-cli-project-routing`, `certify-native-cli-transport`, `certify-native-cli-lifecycle`, `certify-native-cli-tests`, `certify-native-cli-platform`, `certify-native-daemon-validation`, `certify-native-cli-performance` | Historical *differential evidence*, not post-switch tests. Retire their Node/legacy lanes and preserve public routing/errors/negative/source/daemon/platform/Tests/performance invariants in independent contracts. Do not turn comparisons into native-vs-native authority tests. |
| `certify-native-cli-commands`, `certify-native-cli-mutations`, `certify-native-project-command-differential`, `certify-native-editor-performance` | Historical editor/CLI/native-bridge or Test-only parity; retain distinct editor and native addon/worker tests and any independent semantic/readback/transaction coverage. Avoid shipping old authority solely for a test. |
| `certify-native-cli-package`, `certify-native-cli-owner-lifecycle`, `certify-native-authoring-cross-system` | Already assert native result/physical output and independent editor/CLI behavior; support a **native-only installed candidate** with no selection of retired authority. Race interlocks use test-only snapshot instrumentation, not authority selection. |
| `.github/workflows/build.yml`, `release.yml`, `recertify-artifacts.yml` | Legacy certification remains mandatory **before** the cutover. Build also certifies a separate native-only CLI **after uploading** the current production artifact. #521 replaces legacy Project CI steps, updates the release-host and recertify matrix and enforces `check:native-production-closure` in the normal build/package flow. |
| `build.yml` direct `dist-electron/tools/noveltea.mjs` Feature Lab invocation, `release.yml` Node `noveltea:certify`, and scripts invoking bundled reference fixtures | Switch Project commands to the installed native executable and native public contracts; leave intentional tool-only fixture builders and compiler/shader machinery in place. |
| `docs/editor/CLI.md`, `docs/editor/SCRIPTC_COMPATIBILITY.md`, `docs/build/BUILD_AND_VERIFY.md`, `docs/editor/project/PROJECT_VALIDATION_AND_SAVING_CERTIFICATION.md`, this readiness document | Replace oracle-as-required and candidate flag descriptions **with** the #521 production authoring route. Do not delete Zod schema generation or transient UI/transport instructions. |
| `tests/projects/feature-lab`, generated malformed YAML/unsupported-version owners, new disposable Project/ZIP/Runtime Package and Test fixtures | Retain as stable, independently readback-testable fixtures. Native warm/cold and source revisions, JSON diagnostics, errors and files are inspected without running a TypeScript reference Project validator. |

**Exact additional call sites to reconcile with the #521 change:**

- `.github/workflows/release.yml` has two `noveltea:certify` invocations;
  `.github/workflows/build.yml` has the separate `linux-cli-certify`
  section matrix and a direct `dist-electron/tools/noveltea.mjs`
  coverage run; `.github/workflows/recertify-artifacts.yml` has the
  installed CLI comparison list and hosted editor qualification.
  Replace Project oracles/coverage invocation at the switch, preserving
  native coverage collection and non-Project shader/compiler witnesses.
- `scripts/diagnostics/run-cli-diagnostics.mjs` invokes the full old
  certification for Windows diagnostics. Redirect its certification scenario
  to the native suite, retaining the diagnostic trace and artifact capture.
  `scripts/certify-transparent-video-package-scenarios.mjs` defaults to the
  old Node bundled CLI and still edits historical JSON fixture owners; fix
  its current-format Project fixture and switch its default public CLI as
  part of replacing that separate media scenario, rather than enshrining
  its old fixture as a new oracle.
- `tests/ci/cli_certification_synchronization_tests.mjs` asserts section
  labels and method bodies *inside* the old monolithic runner. Retain the
  daemon/scheduling postcondition tests while retargeting the source shape
  assertions to the new suite when that runner is deleted.
- `editor/scripts/certify-native-cli-inventory.mjs` still maps legacy tool,
  ComfyUI, Test, platform and agent command ownership to
  `certify-noveltea-cli.mjs` and earlier parity scripts. Keep its public
  command completeness check, but update every owner to surviving native
  contract/test files at #521. Don't silently shrink the 39-path inventory.
- `docs/editor/CLI.md`, `docs/editor/SCRIPTC_COMPATIBILITY.md`,
  `docs/editor/project/NATIVE_AUTHORING_WORKER.md`,
  `docs/architecture/NATIVE_AUTHORING_CONTRACTS.md`,
  `docs/build/COVERAGE.md`, `docs/build/BUILD_AND_VERIFY.md`, and
  `docs/engine/TEST.md` describe prior candidate flags, Node parity,
  certification or test commands. Reconcile those specific assertions with
  the installed-native production workflow at #521; preserve unaffected
  editor/YAML/schema and Engine Test runner documentation.

**Non-Project coverage to preserve independently:** `raw-shaderc`,
`typed-shaders`, private shaderc batching, texture compiler, media-tool
bundling/relocation, `bootstrap-island`, ScriptC CLI host transport,
independent template registry/config and executable platform dependency/ABI
inspection do **not** depend semantically on a Node Project validator. Do
not drop their goldens and diagnostics along with `differential`, Project
test/cache/resident, mutation or ComfyUI Project-oracle lanes. The native
candidate suite covers built-in media/ComfyUI and platform-publication
behavior; raw shader/compiler and ABI coverage remains in existing required
jobs pending deliberate relocation when #521 removes the monolithic runner.

The new executable suite is `editor/scripts/certify-native-candidate-contracts.mjs`
(`pnpm -C editor run noveltea:certify:native-candidate`). It requires an
**installed native-only candidate** from the current tree plus SHA-bound
`dist-scriptc-native-island` provenance. A generated
`build/cli/<host>/native-candidate-build.json` binds the installed executable
SHA256 to the island provenance SHA256; legacy rebuilds delete this proof,
and the candidate runner rejects absent or stale proof. The public-contract fixture asserts
exact usage/error categories, diagnostics, semantic defaults, formatting,
ComfyUI workflow inventory, author-edit/delete reference safety, physical
owners, both daemon modes, native cache proof and rejection of corrupt cache
and malformed source. The Feature Lab suite asserts native semantic/readback
and package ZIP hashes, all available record families, authored runtime/UI
Tests, Project export/import, source mutation and cache invalidation. The
package and resident tests exercise byte-equivalent local/daemon output,
stale source rejection and pinned worker interruption. Native ComfyUI
contracts use a deterministic local HTTP witness for workflow inspection,
verification, execution, tracked Asset publication and local/daemon rejection
of source changes while a remote request remains in flight. With
`NOVELTEA_AUTHORING_NODE_ADDON`, the suite additionally executes a separate
native Electron worker against the independently launched CLI and verifies
bidirectional exact-source cache reuse, private unsaved edits, watcher and
scoped Save. The native addon is never replaced with an adapter to the CLI.

Run on a host with the pinned CLI build toolchain and real addon:

```sh
NOVELTEA_CLI_BUILD_NATIVE_CANDIDATE=1 pnpm -C editor run noveltea:build
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" \
  pnpm -C editor run noveltea:certify:native-candidate -- "$PWD/build/cli/linux/noveltea"
# Linux CI also runs the independently valid CLI-only subset:
pnpm -C editor run noveltea:certify:native-candidate -- "$PWD/build/cli/linux/noveltea" --cli-only
```

#541 additionally splits the three reference-dependent fixture/compiled-project
generators into unshipped `dist-build-tools` and stages a native candidate
Node-tool forwarding graph with SHA256 installed CLI/island binding. After a
candidate pack, `pnpm -C editor run check:native-node-candidate` checks both
emitted roots and negative tamper cases; Linux CI runs it after candidate
rebuild. The complete producer/entrypoint classification, typed contract
relocations, unchanged production boundary and #521 deletion/CI order are in
`docs/editor/NATIVE_CLI_CUTOVER_HANDOFF.md`.

No production authority changed. `NOVELTEA_CLI_BUILD_NATIVE_CANDIDATE=1`
selects the **build output**, not a runtime fallback. Ordinary public suite
invocations have certification routing unset; special race tests temporarily
enable `NOVELTEA_CLI_CERTIFICATION=1` *solely* to expose the snapshot interlock
and do not select a legacy authoring path. The strict multi-root production
closure gate **still fails** against pre-#521 artifacts and must not be
weakened. At #521 replace the candidate island with native production in the
same edit as editor/CLI switch and retirement; run
`pnpm -C editor run check:native-production-closure` plus the public and
cross-system suite **without** the candidate build flag, and inspect the
installed CLI and packaged resources for the retired engine. Enable this
guard and corresponding Linux/Windows/macOS release/recertify steps as
mandatory, not optional. Do not infer packaged-provenance or host-completeness
from a passing Linux CLI-only stage.
