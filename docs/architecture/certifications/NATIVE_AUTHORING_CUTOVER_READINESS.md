# Native Project cutover readiness / deletion plan (#520)

Status: **not approved for cutover** (2026-10-20, candidate baseline `35e0b2f1`).
This is the pre-switch evidence ledger for #506/#521, not a claim that production
has changed. #504 (editor) and #505 (CLI/daemon) are blocking integration owners;
both are still open. #519 and its host certification have not yet been signed off.
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
| Whole-schema family/default/ref/diagnostic coverage | #504 + #505; generated contracts, native `ProjectSession`, inspector/CLI router | schema generation, native CTest, `native-project-session-parity.test.ts`, `certify-native-cli-project-routing.mjs` on Feature Lab and negative fixtures | **open**: parent acceptance sign-off |
| Every editor caller, generic mutations, structural persistence/undo | #504 (#508/#511); `native-editor-session-controller.ts`, command store, native Save | `native-command-store`, `native-project-session-parity`, `native-project-source-transactions`, `native-project-copy-service`, full editor suite | **open**: #504 acceptance |
| Conflict/Use Disk, invalid owner isolation, Comment Keep/Remove/Cancel, scoped Save/Save All | #504 (#509/#511); native working project, Save coordinator | `native-authoring-reconciliation`, `native-external-projection`, `project-save-coordinator`, C++ YAML transaction CTest and negative revisions | **open**: final integrated acceptance |
| Durable dirty/text recovery, cold reopen, transaction uncertainty | #504 (#510) and native transaction foundation; `.noveltea/editor/native-dirty-state.json`, native worker journal | `native-dirty-recovery`, `native-project-source-transactions`, `native-authoring-worker`, C++ transaction CTest | **open**: independent-host/user lifecycle qualification |
| Source/Asset races, untracked/attached files, shader copies, Save Project Copy As | #504 (#511); native Project file operations, Asset staging, copy service | `native-asset-staging`, `native-project-copy-service`, `native-project-source-transactions` and native addon tests | **open**: #504 sign-off |
| Public Project CLI/daemon commands, options and private transport | #505 (#512–#519); native CLI candidates, ScriptC island, native bridge | `certify-native-cli-inventory`, installed routing/transport/mutations/commands; native lifecycle/validation/tests/package/platform suites | **open**: #505/#519 + cross-host results |
| Full validation, source locations, invalid required/unrelated sources, native warm/cold evidence | #505 (#513/#519); native Project validation, staged font/shader checks | `certify-native-daemon-validation`, `native-cli-validation.test.ts`, invalid-source fixtures, native clean-cache CTest | **open**: cross-host and negative suite review |
| Authored Tests, preview, working export and native runtime preparation | #504/#505 (#514–#517); native preparation, downstream compiler/runner | `native-authoring-runtime-preparation`, `native-cli-tests`, `native-cli-package`, `native-cli-platform`, Feature Lab authored Tests, package/export witnesses | **open**: final cross-host/editor workflow |
| Optional-Project ComfyUI, source/reference/Asset publication | #505 (#518); native ComfyUI admission and Asset publication | `certify-native-cli-inventory`, ComfyUI tests and exact-source publication races | **open**: #518 parent acceptance |
| Separate editor/CLI session and cache interoperability in both directions | **#520**; shared native clean-cache contract and independent editor worker/installed CLI | `certify-native-authoring-cross-system.mjs`: exact source hashes and semantic fingerprint, cache hit without republishing, concurrent dirty working state, daemon and local CLI, watcher, editor Save | **proved-local** on rebuilt matching Linux binaries; host matrix pending |
| Performance before switching | #519 CLI; **#520** editor/cross-system | `certify-native-cli-performance.mjs` (six timed phases; slowdown must exceed **3x and 500 ms** to fail); editor Open/one-owner YAML Save/mixed text Save/export timings still need comparable old/new samples and justified thresholds | **open**: editor baseline and host evidence |
| Real addon, watcher, transaction, CLI on Linux/Windows/macOS | #503 foundations, #504/#505 and **#520** for integration | `build.yml` native-authoring-hosts, `release.yml` installed CLI host matrix and new cross-system step; no build-only or skipped run counts | **open**: matching green CI |
| Feature Lab/examples manual Open/Edit/Save/Save As/Play/Test/Export/Reopen | #504 + #522 (production qualification); runtime Lab and examples | focused native regression suites plus `PROJECT_VALIDATION_AND_SAVING_CERTIFICATION.md` manual checklist | **open**: manual production lifecycle after #521 |
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

- Cross-system certification: locally executed on Linux, real rebuilt addon,
  installed CLI and Electron worker; verifies both cache directions, exact
  source revisions, dirty isolation, native editor scoped Save and CLI edits.
  Re-run after any native semantic/host-build change.
- #519 records Linux installed CLI 78/78 Feature Lab public command
  comparisons, 21 transport checks and six-stage timing coverage. The
  authoritative raw timing numbers and pass/fail threshold belong to the
  executed `certify-native-cli-performance.mjs` output; do not infer an
  editor baseline from those numbers.
- **Not yet available for sign-off:** final #504/#505 closure, on-commit
  Linux/Windows/macOS host results, comparable editor Save/export baselines,
  full negative-case reconciliation, and manual end-to-end Feature Lab/example
  workflow. These are **blocking**, not post-cutover waivers. The existing
  save/validation manual-acceptance checklist is also open.
- Full editor test run on this candidate: **339 files passed, 1 failed,
  11 skipped; 3,032 tests passed, 1 failed, 157 skipped**. The failure
  reproduces in isolation: `src/renderer/test/noveltea-cli.test.ts` test
  `lists native-admitted platform profiles without TypeScript Project source
  reads` returned internal exit **70** instead of **0**. This is a **#505**
  platform-profiles gate, not a #520 cache-interoperability exception. No
  workaround or cross-ticket rewrite has been applied here. Editor TS
  typecheck and schema-version policy pass. Aggregate editor `check` is
  blocked by pre-existing repository formatting failures in 28 unrelated
  files; the two new #520 scripts pass their targeted pinned formatter check.

## Two-axis change review (pre-switch)

- **Repository standards:** Uses authenticated native worker and installed
  CLI test seams, real exact bytes/revisions, scoped temporary roots, existing
  build/release matrix and single-current native cache; no production switch,
  new migration shape, extra daemon or external test dependency. Pinned JS
  formatting, schema-policy check and no-unrelated-source-edit policy apply.
  Cross-host CI execution and the repository-wide existing format debt remain
  explicit unresolved verification, not a claimed green standard gate.
- **#474/#506 specification:** Two-way cache reuse, external watcher,
  private working-state isolation and cross-system Save are directly exercised.
  The original acceptance matrix and cutover/retirement sequence are
  inventoried above. Required editor/CLI feature and performance/CI evidence
  remains blocked by #504/#505/#519; it must be fixed or signed off in those
  owners **before** #520 can be marked complete and #521 may begin.

Feature Lab: the real addon/CLI integration test uses a small generated Project
to isolate source/cache proof; full gameplay/UI verification remains covered
by Feature Lab's authored content and the #504/#505/#522 suites, not by this
smoke. No new authored Feature Lab content is necessary for the disk-cache
invariant itself.
