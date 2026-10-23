# Native Project production qualification (#522)

Status: **blocked by #521 atomic cutover**. This is the post-retirement
qualification plan and pre-cutover test harness; it is **not** evidence of a
complete native-authoritative production release. #520's matrix and baselines
in [NATIVE_AUTHORING_CUTOVER_READINESS.md](NATIVE_AUTHORING_CUTOVER_READINESS.md)
remain the entry contract. Do not close #522/#506 without reproducing the
required real-host results **on the exact switched/retired commit**.

## Pre-cutover deliverables

- `editor/scripts/native-production-qualification.mjs` provides strict public
  CLI completion/exit checking, isolated ordinary host state, and an
  independent portable ZIP readback. Its negative fixtures are run with
  `pnpm -C editor run noveltea:certify:native-production-unit`.
- `editor/scripts/certify-native-production-lifecycle.mjs` fails before any
  CLI invocation if the installed binary is missing, any candidate-only
  certification environment is present, required build provenance is absent,
  or any retired Project authority occurs in Electron main/preload/renderer,
  the native worker, Node CLI-tools or ScriptC bundle closure. It never turns
  on native certification routing, invokes the installed public CLI without
  hidden flags, and copies Feature Lab to a disposable writable Project.
- That public CLI smoke verifies cold and reused native clean validation,
  independent local/daemon diagnostics, public record inspection for every
  *present* schema-derived fixture family, editable `.ntproject` export with
  exact source hashes and private-state exclusion, import/reopen, actual
  `.ntpkg` compiled gameplay readback, real authored runtime/UI Test execution,
  corrupted-cache regeneration, exact one-record YAML and tracked Lua
  invalidation, invalid-required-source rejection after cache warmup, and
  exact-source repair. It emits a source-SHA / installed-binary-SHA and
  host-stamped stage-timing JSON
  record with `status: passed-smoke-not-complete-qualification`. It reports
  families missing from Feature Lab rather than counting them as tested.
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

Both production entrypoints deliberately **fail on the present pre-cutover
build**, with substantive retired-authority findings. Do not bypass the guard
to obtain a passing output. Do not wire them into mandatory pre-cutover CI;
activate them on the final atomic production commit, once the superseded
authoring implementation has actually been deleted and the CLI rebuilt.

## After #521: reproducible production gates

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
  node editor/scripts/certify-native-authoring-cross-system.mjs \
  "$PWD/build/cli/linux/noveltea" --production
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
| All 16 families and all public/private CLI routes | Generated schema/native inventory and native CLI command matrix; negative fixtures for absent Feature Lab families (notably Maps), command options/transport/daemon/static/heavy paths | **pending #521** |
| Editor workflows | Real packaged Open/Inspect/Edit/Undo/Redo/Save/Save All/Save As/Play/Preview/Test/Export/Reopen; Project Settings, text/Asset edits, working/recovery journal, Chapter/Tag/Layout changes; follow `docs/editor/project/PROJECT_VALIDATION_AND_SAVING_CERTIFICATION.md` | **pending #521** |
| Editor/CLI independence and negative source races | Production-mode cross-system worker/addon plus real main/renderer IPC, dirty-only/private recovery, Comment Keep/Remove/Cancel, overlapping vs disjoint changes, invalid unrelated source, exact SHA conflict, writer/transaction recovery | **pending #521** |
| Runtime correctness and host failures | Feature Lab authored semantic *and UI* Tests, preview/gameplay readback, pinned daemon generation and cancellation, corrupted caches, daemon restart/eviction, Asset/Project mutation race and output rollback | **pending #521** |
| Host distribution / isolation | Linux installed CLI plus green Windows/macOS exact-SHA release matrix using real addon, watcher, CAS and daemon; editor package smoke, relocated CLI/media/shader tools; host-only addon absent from all game players | **pending #521** |
| Performance/regressions | Cold admission, warm cache, YAML/Lua scope, Save, actual export preparation, elapsed + useful work vs #520 baseline | **pending #521** |
| Generated contracts and docs | Agent Kit/schema/defaults, current-only cache and protocol inventory, production ownership docs, bundle closure and independent published-archive smoke | **pending #521** |
| Review/sign-off | Standards + #474/#506 spec review on final diff, link exact platform jobs; record missing manual/OS/signing credentials without silently passing | **pending #521** |

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
