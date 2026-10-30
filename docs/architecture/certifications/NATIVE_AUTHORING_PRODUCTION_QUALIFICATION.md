# Native Project production qualification (#522)

Status: **post-cutover qualification in progress (#522)**. #521 switched the
editor Project authority and #551 replaced the shipped CLI/daemon/worker host
with direct C++ without ScriptC/QuickJS. The repository now has the production
implementation, but that is **not** evidence of a completely certified release.
#520's matrix and baselines
in [NATIVE_AUTHORING_CUTOVER_READINESS.md](NATIVE_AUTHORING_CUTOVER_READINESS.md)
remain the entry contract. Do not close #522/#506 without reproducing the
required real-host results **on the exact switched/retired commit**.

## Post-#551 required production command

`pnpm -C editor run noveltea:certify` is the ordinary production gate. It
requires a built native CLI, all five editor emitted roots, and the actual
`NOVELTEA_AUTHORING_NODE_ADDON` to certify independent editor/CLI disk behavior.
It **fails** if the addon is missing; it must not silently downgrade to a
CLI-only pass. Standalone CLI builder jobs without the addon explicitly run
`pnpm -C editor run noveltea:certify -- --cli-only`, which is a declared
subset and is not a replacement for full host certification.

The release editor-host matrix builds the renderer and Electron bundles and
executes the full ten-stage production suite with the native addon on Linux,
Windows and macOS. The standalone Linux and Windows builder jobs execute the
explicit CLI-only subset. Existing independent 82-case command, native
watcher/revision, package, export and relocated application checks remain
separate matrix gates. A passing check on an earlier native *candidate* or
ScriptC build must not be substituted for the final direct C++ executable.

The full issue additionally requires actual interactive editor lifecycle
verification, same-SHA cross-host artifacts, a measured like-for-like
performance comparison against #519/#520 baselines, review of all original
#506 criteria and explicit sign-off. Tests alone do not satisfy those rows.

## Linux post-#551 implementation evidence (2026-10-29)

The local Linux x64 checkout was at `84a2a5f7d28570d04c8b7ed8049d20dfdbe086d5`
with uncommitted #522 changes, so the development CLI identity included a
dirty-worktree suffix. This is **local implementation evidence**, not an
exact-final-commit release certificate or Windows/macOS acceptance.

- Pinned Node 24.18.0; `pnpm -C editor run noveltea:build` rebuilt the direct
  C++ CLI and passed relocation, bundled FFmpeg and Project-create smokes.
  The rebuilt Electron native addon, `vp pack`, `vp build`, bundle policy and
  installed executable closure check all passed. Native binary verification
  is now required by every production entrypoint, not just the auxiliary CLI
  checker: build SHA, ELF/PE/Mach-O header and retired-runtime markers are
  checked together, with negative tampering regressions.
- `NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" pnpm -C editor run noveltea:certify`
  passed **9/9** production stages without candidate routing: independent
  command diagnostics, all **16** public record families (Maps in a disposable
  supplemental Project), native cache/source repair, real authored Feature Lab
  runtime and UI Tests, editable Project/Runtime Package readback, restart and
  pinned worker cancellation, Web export/publication, ComfyUI source-drift
  rollback and native editor/CLI two-way disk/dirty/Save interaction.
- The full editor suite passed **2,182 tests / 135 skipped** after the
  packaged-smoke repair; focused real-addon Create/Import/Open regression tests
  passed **4/4**. Strict formatter/lint/typecheck/schema checks and **80/80**
  focused production/CI tests also passed after the repair.
- The actual Linux editor directory package passed stage/relocation/native
  dependencies/ASAR/fuse verification. Initial packaged launch failed the
  **production thumbnail protocol**: the editor still invoked
  `native-project-create`, an operation the post-#551 C++ private bridge did
  not recognize. The same defect affected desktop `native-project-import`.
  Both now call the existing `native-project-commands` dispatcher with
  `project-create`/`project-import` actions. Actual private import proved
  name override and native source publication; **packaged smoke now passes
  every reported check**, including production thumbnail protocol, Project
  creation, native CLI resolution, media tools and PTY. No alternate editor
  writer or compatibility path was introduced.
- The production lifecycle measured individual CLI calls while the full
  editor suite was concurrently running: initial Feature Lab validation
  5,268 ms, unchanged exact cached validation later 12 ms, package export
  9,211 ms. Those figures are **not comparable** to #520's native-addon-only
  editor cold Open/Save/preparation baselines: they include CLI process/Project
  preparation and concurrent host load. The required like-for-like production
  cold, warm, YAML/Lua, scoped Save and export comparisons and changed-work
  observations remain open; no performance exception is assumed.

Feature Lab was exercised unchanged, including actual authored runtime and UI
Tests. Maps is absent from its fixture and was covered at the public native
create/inspect layer, not misrepresented as an authored gameplay/UI Test.
Windows/macOS host CI, signing credentials, interactive editor workflows and
final #506/#474 sign-off remain required before claiming #522 complete.

## Review remediation after `aab14f26` (2026-10-29)

The risk-based #506/40-child review identified three reproducible C++ behavior
regressions. These are now exercised by
`tests/native_cli/production_regressions.py`, registered as CTest
`native_cli_production_regressions`, and in the **ordinary production**
`noveltea:certify` runner as the tenth independent stage (also in the
explicit CLI-only subset). The test invokes the actual native executable:

- Default daemon and `--no-daemon` both accept a native generated
  `localization reconcile --apply` JSON plan on stdin. Empty stdin remains a
  structured usage failure; pre-dispatch broker fallback replays the bytes
  through the localization handler, not the Test handler.
- Native Runtime Package export creates a missing nested output directory and
  publishes a real `.ntpkg`; user-controlled symlinked output-parent
  components are rejected before staged publication. The final target remains
  subject to the existing replacement and publication checks.
- The controlled POSIX curl helper returns valid GET verification data then
  exits before reading a POST request. Both short and 100 KB ComfyUI prompts
  must return `COMFYUI_SERVER_UNAVAILABLE` with exit 4 and a single JSON
  envelope, rather than SIGPIPE or partial output. The caller consumes its own
  pending SIGPIPE with a thread-local signal mask and reaps the child.

The completed candidate, retired ScriptC daemon/cache text and dated
implementation status were moved from the current CLI reference to
[`docs/archive/reports/NATIVE_CLI_CUTOVER_HISTORY.md`](../../archive/reports/NATIVE_CLI_CUTOVER_HISTORY.md).

This is **regression remediation, not #522/#506 sign-off**. The local regressions
were run against a development worktree. Comparable production performance,
manual interactive editor lifecycle, exact-commit Linux/Windows/macOS release
artifacts and signing evidence remain unverified until separately recorded.

**Post-review Linux execution:** With the repository at `aab14f26` plus the
uncommitted review patch, the rebuilt C++ CLI passed **10/10** full native
production stages, the focused native/CI checks passed **78/78**, and the
complete editor suite passed **2,182/2,182** runnable tests (135 skipped).
Pinned clang-format 18.1.8 `format-check` passed all 719 selected C/C++ files;
`pnpm -C editor run check` passed strict lint, formatting, typecheck and
generated contracts. Repacked Linux Electron with the rebuilt CLI: the
directory-package verification and packaged-app launch smoke passed every
reported check, including the production thumbnail protocol and native CLI.
The controlled curl shim confirmed actual early-exiting **POST** invocations,
not a GET-only failure. These results are local, non-signing evidence.

The pre-cutover comparison runner
`editor/scripts/certify-native-editor-performance.mjs` itself can no longer
execute: it imports the removed
`src/shared/project-workspace/node-project-workspace-service.ts` and fails
with `ERR_MODULE_NOT_FOUND`. Its earlier figures remain historical baseline
evidence, not a passing post-cutover measurement. #522 needs a replacement
production-owned benchmark for comparable cold/warm, scoped Save, YAML/Lua and
full export work before the dual slowdown threshold can be evaluated. No
equivalence or waiver has been inferred from unrelated process-wall timings.

### macOS Runtime Package output-path portability follow-up

The #522 regression review identified that rejecting every symlink component
of an output parent also rejected macOS's standard `/tmp` and `/var` aliases
to `/private/tmp` and `/private/var`. The path normalizer now resolves **only**
these two aliases, and only when their actual canonical destinations exactly
match the known macOS system locations. The rest of the output-directory walk
still rejects symlinks, including user-controlled symlinks below an approved
alias. The regression harness resolves its primary system-provided temporary
root and explicitly exercises output through macOS `/tmp`, `/var/tmp`, and
`/var/folders` (when used by the system temp directory), as well as a nested
user symlink. Linux checks do not certify the macOS-specific branch; the
exact-revision macOS certification run remains required before sign-off.

Local Linux evidence at `ca4e3d92` with the uncommitted portability patch:
the rebuilt installed native CLI passed the full **10/10-stage** production
certification, including the existing path/symlink regression cases, and the
focused qualification/CI checks passed **12/12**. Repository-pinned
clang-format 18.1.8 passed its 719-file check. The release CMake build had
`BUILD_TESTING` disabled, so the native path regression was run by the
production certification runner rather than claimed as a local CTest pass.
The macOS-specific positive alias cases were not executable on this Linux
host, and no final host certification or performance sign-off is inferred.

## Reusable acceptance harness (originally prepared before cutover)

- `editor/scripts/native-production-qualification.mjs` provides strict public
  CLI completion/exit checking, isolated ordinary host state, and an
  independent portable ZIP readback. Its negative fixtures are run with
  `pnpm -C editor run noveltea:certify:native-production-unit`.
- `editor/scripts/certify-native-production-lifecycle.mjs` fails before any
  CLI invocation if the installed binary is missing, any candidate-only
  certification environment is present, required build provenance is absent,
  or any retired Project authority occurs in Electron main/preload/renderer,
  the native worker or Node CLI-tools bundle closure. It never turns
  on native certification routing, invokes the installed public CLI without
  hidden flags, and copies Feature Lab to a disposable writable Project.
- That public CLI smoke verifies cold and reused native clean validation,
  independent local/daemon diagnostics, public record inspection for all 16
  generated families (supplemental native create/inspect for absent Feature Lab
  families), editable `.ntproject` export with
  exact source hashes and private-state exclusion, import/reopen, actual
  `.ntpkg` compiled gameplay readback, real authored runtime/UI Test execution,
  corrupted-cache regeneration, exact one-record YAML and tracked Lua
  invalidation, invalid-required-source rejection after cache warmup, and
  exact-source repair. It emits a source-SHA / installed-binary-SHA and
  host-stamped stage-timing JSON
  record with `status: passed-smoke-not-complete-qualification`. It reports
  missing Feature Lab fixture families separately from the complete exercised
  list; supplemental inspection is not authored-runtime gameplay acceptance.
  An unavailable UI Test runner is a failure to resolve or record explicitly,
  not a reason to skip the native authored Test invocation.
- The existing `certify-native-authoring-cross-system.mjs` also accepts
  **`--production`**. In this mode it requires the same retirement/manifest
  proof, launches the real Electron worker/addon and independently installed
  CLI with certification routing **unset**, and isolates its temporary daemon
  home. It reuses #520's exact cache-source and semantic key, unsaved draft,
  disk-watcher and scoped-Save assertions; it is not a fake two-host mock or
  a stand-in for real editor UI acceptance. The old candidate mode remains
  unchanged until the #521 switch removes its need.

The production entrypoints intentionally rejected the retired pre-cutover
build. On the switched branch they must instead verify the installed native
binary and SHA-bound emitted editor closure without candidate-only flags.

## Reproducible production gates

Use a freshly built editor bundle and an *installed* standalone CLI built
from the **same Git SHA**, with real host addon resources and no local
TypeScript-authoring installation dependency. Do not set any
`NOVELTEA_CLI_CERTIFICATION*` variable or editor `--certify-*` launch flag.
On Linux, for example:

```sh
pnpm -C editor exec vp pack
pnpm -C editor exec vp build
pnpm -C editor run bundle:policy
pnpm -C editor run check:native-production-closure
node editor/scripts/certify-native-cli-inventory.mjs
node editor/scripts/certify-native-production-lifecycle.mjs "$PWD/build/cli/linux/noveltea"
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" \
  pnpm -C editor run noveltea:certify
pnpm -C editor run check:schema-version-policy
pnpm -C editor run test
ctest --test-dir build/native-authoring-host --output-on-failure
```

The smoke is a **subset** of final acceptance. Collect its machine-readable
timings as evidence, and compare corresponding actual production cold/warm,
YAML/Lua, scoped Save and full export preparation timings with #519/#520's
recorded comparable baselines. The agreed **both 3x and 500 ms** material
slowdown criterion is evaluated only against like-for-like phases; no
unmeasured phase is silently accepted. Record useful changed-owner work,
cache-hit/source hashes, process identities, CPU/host context and any
owner-approved exceptions. The smoke's invocation measurements are not yet
an independent full export-performance certificate.

## Required post-cutover evidence not supplied by the preparation

| Qualification | Reusable seams / evidence to collect | Status |
| --- | --- | --- |
| All 16 families and all public/private CLI routes | Generated schema/native inventory and native CLI command matrix; negative fixtures for absent Feature Lab families (notably Maps), command options/transport/daemon/static/heavy paths | **post-#551 certification pending** |
| Editor workflows | Real packaged Open/Inspect/Edit/Undo/Redo/Save/Save All/Save As/Play/Preview/Test/Export/Reopen; Project Settings, text/Asset edits, working/recovery journal, Chapter/Tag/Layout changes; follow `docs/editor/project/PROJECT_VALIDATION_AND_SAVING_CERTIFICATION.md` | **manual host UI acceptance pending** |
| Editor/CLI independence and negative source races | Production-mode cross-system worker/addon plus real main/renderer IPC, dirty-only/private recovery, Comment Keep/Remove/Cancel, overlapping vs disjoint changes, invalid unrelated source, exact SHA conflict, writer/transaction recovery | **production host matrix pending** |
| Runtime correctness and host failures | Feature Lab authored semantic *and UI* Tests, preview/gameplay readback, pinned daemon generation and cancellation, corrupted caches, daemon restart/eviction, Asset/Project mutation race and output rollback | **production host matrix pending** |
| Host distribution / isolation | Linux installed CLI plus green Windows/macOS exact-SHA release matrix using real addon, watcher, CAS and daemon; editor package smoke, relocated CLI/media/shader tools; host-only addon absent from all game players | **exact-SHA release results pending** |
| Performance/regressions | Cold admission, warm cache, YAML/Lua scope, Save, actual export preparation, elapsed + useful work vs #520 baseline | **comparison pending** |
| Generated contracts and docs | Agent Kit/schema/defaults, current-only cache and protocol inventory, production ownership docs, bundle closure and independent published-archive smoke | **final audit pending** |
| Review/sign-off | Standards + #474/#506 spec review on final diff, link exact platform jobs; record missing manual/OS/signing credentials without silently passing | **pending** |

Record executed stage, project fixture, SHA, host, result, and any unavailable
manual/CI evidence in this ledger after the cutover. The certification-only
candidate scripts from #519/#520 are *not* substitutes for these ordinary
production commands. #506 remains open until every required row is satisfied;
#474 remains open for user sign-off even after #522 passes.

Feature Lab applicability: the prepared smoke reads and copies the current
Feature Lab; it does **not** modify authored Lab tests. Runtime/preview/UI
acceptance must still run the existing authored Lab tests on the post-cutover
build and record any coverage gap; static schema or ZIP checks cannot replace
gameplay playback.
