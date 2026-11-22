# Atomic Build / Coverage / Extended / Release cutover — #646

Status: **pre-merge integration qualification; not production certified**. The
single combined branch is `ci/build-release-refactor-641`, based on the last
unmodified master commit `30d3bcd311b1ab84f3c3806f97ce3a742477750c`.
Commit `7b3b04630` implemented #645. Tickets #642–#645 are implementation
checkpoints; #646 alone owns the hosted campaign and coordinated master merge.

## Source-owned candidate acceptance matrix

Every listed artifact is a candidate from
`scripts/ci/release-candidates.json`. The Build producer stages exact
source/compiler/flags/ABI/schema/dependency checks, and Release restores
it from the selected Build run and verifies its original hashes. Stage
certification cannot substitute different binary builds. Status for the
following is **source-level checked, hosted cutover certification pending**.

| Candidate(s) | Build producer job | Release consumer | Independent Release qualification |
| --- | --- | --- | --- |
| `linux-host-cli-x64` (Ubuntu development CLI) | `linux-cli` | Development snapshot, examples, Extended CLI benchmark (not Linux release CLI) | Installed CLI public/runtime contracts, immutable snapshot input |
| `linux-release-cli-x64` (Debian 12) | `production-linux-release-cli` | `shader-assets`; `desktop-hosts`; Linux exports, Web/Android/release examples | glibc 2.36 ceiling, exact native export and package install |
| `windows-release-cli-x64` (GNU) | `production-other-host-clis` | `windows-cli`; `desktop-hosts` | PE import/static GNU runtime audit, portable export/launch, attested ZIP |
| `macos-release-cli-arm64` | `production-other-host-clis` | `macos-cli`; `macos-certify` | macOS 14 target, native export, app launch and report |
| `linux-player-x64-release` | `production-desktop-players` | `desktop-hosts` | glibc 2.28 dependency floor, X11/Wayland, portable/AppImage and runtime fixture |
| `linux-player-x64-devtools` | `production-desktop-players` | `desktop-hosts` | Same ABI and X11/Wayland, linked developer capability/export |
| `windows-player-x64-release` | `production-desktop-players` | `desktop-hosts` | MSVC dependency audit, real portable export and native CLI launch |
| `windows-player-x64-devtools` | `production-desktop-players` | `desktop-hosts` | MSVC audit, real developer export and launch |
| `macos-player-arm64-release` | `production-desktop-players` | `desktop-hosts`, `macos-certify` | macOS 14 framework/dependency/ABI audit, app bundle export and launch |
| `macos-player-arm64-devtools` | `production-desktop-players` | `desktop-hosts`, `macos-certify` | Same deployment floor and developer export/launch |
| `web-player-threads-release` | `web` | `web`, `release-examples` | WASM+JS boundary, separate DWARF, Chromium, pinned release examples |
| `web-player-no-threads-release` | `production-web-variants` | `web` | Non-threaded Chromium boot and nested export |
| `web-player-threads-devtools` | `production-web-variants` | `web` | Developer capability and Chromium export |
| `web-player-no-threads-devtools` | `production-web-variants` | `web` | Developer/non-threaded export and Chromium |
| `linux-editor-x64` | `production-editor-hosts` | `desktop-editor` | Original signed installer hashes, DEB/RPM install/use/uninstall, AppImage |
| `windows-editor-x64` | `production-editor-hosts` | `desktop-editor` | Exact original installer/setup hash and provenance |
| `macos-editor-arm64` | `production-editor-hosts` | `desktop-editor` | Actual signed DMG/ZIP identity and macOS 14 minimum |
| `android-player-arm64-release` | `production-android-arm64` | `android` | ARM64 release ABI/load alignment, unsigned APK and AAB exports |
| `android-player-arm64-devtools` | `production-android-arm64` | `android` | Same ABI/load alignment, developer APK and AAB |
| `android-player-x64-debug` (diagnostic-only) | `android` | `android` | x86_64 Debug ABI and APK smoke; **not** optimized production promotion |

Additional exact-Run Build inputs: `noveltea-shader-assets`,
`noveltea-web-editor-preview`, and two
`noveltea-build-windows-tooling-bridge-*` payloads.
No candidate is allowed to disappear from the Build run's required artifact
inventory. `release-inventory` requires all platform checks, examples,
notices/SBOM, detached symbols, hashed manifests and attestations before
`publish` becomes eligible.

## Trust, preview and publication boundaries

Production Release must receive an authenticated successful **master push**
Build run for the exact tag SHA; all required artifacts must be complete,
unexpired and independently verified. Exact-SHA Extended Qualification must
have a successful master run bound to the selected Build run. The authorization
records run ID and attempt and is independently rechecked before inventory and
publication. A missing/expired/incomplete candidate triggers no Release-only
rebuild; production must re-run the pinned canonical Build and Extended
qualifications on the exact source SHA or fail closed. The `VERSION` and
annotated version-tag rules remain authoritative. Only a tag push can publish.

A separate branch-only preview accepts **explicit** successful exact-source
Build and Extended run IDs from `ci/build-release-refactor-641`. It requires
a manually dispatched Release with both IDs; production validators reject
preview receipts. Preview uses the same payload checks and platform
certifications but records `canPublish: false`; the GitHub Release publisher
remains `if: github.event_name == 'push'` with a version-tag requirement.
A manually dispatched Release, even if every job succeeds, cannot publish.
Production promotion never accepts a preview receipt, PR artifact, fork artifact,
or branch source.

## Consumer isolation

- The existing workflow identity is still **Build**, and external candidate,
  snapshot, and development-example artifact names are preserved.
- `development-snapshot.yml` continues to consume exact successful master
  push Build CLI + Web artifacts and publish immutable SHA-addressed R2
  snapshots. No branch preview may write a public development snapshot.
- `site-after-build.yml` consumes exact successful Build examples in a
  **separate** workflow_run. Cloudflare/site failure must not fail Build.
  Internal PR preview and trusted master site publication remain separate.
- `site-release.yml` may consume only exact successful master push Build
  examples for a published tag, and ignores nonpublishing manual Release
  completion. This prevents a green branch preview from publishing Site.
- `release-examples` remains a required Release inventory predecessor;
  its catalog/source/player/CLI identities must match the selected release.

## Hosted acceptance — do not mark complete without evidence

The premerge Extended workflow uses a narrowly scoped integration-branch
`push` trigger only when this acceptance document changes. A branch-only
workflow cannot otherwise be manually dispatched before its definition exists
on GitHub's default branch. The Extended source job waits for a successful
**exact same-SHA branch Build** and seals a distinctly named preview receipt;
this cannot satisfy the trusted-master production Release gate. This document
change is the deliberate trigger for the single coordinated campaign.

1. Verify repository settings and required statuses. On 2026-11-20 the GitHub
   API reported **no classic branch protection for master**, and the
   `rulesets` endpoint returned an empty list. There are no required status
   checks to preserve automatically; decide/check intended required statuses
   before the production merge.
2. Push the complete single integration branch and run **one** representative
   multi-platform Build plus separate Coverage and Extended Qualification.
   Record actual run links and SHA; do not use preview artifacts as trusted
   master authority.
3. On exact successful Build and Extended preview, manually dispatch Release
   against the same branch with `preview_build_run_id` and
   `preview_extended_run_id`. The run must fully qualify but never publish.
4. Confirm all 20 candidate rows above have producer artifacts, accepted
   manifests, actual downstream platform smokes, and complete Release
   inventory. Exercise bad SHA/runner/attempt, expiry/tampering, wrong variant,
   missing candidate, invalid tag, manual publication rejection and cache
   scope mismatch.
5. Confirm immutable snapshot/R2, public pinned examples and separately
   verified Site. Observe that Site-only failure cannot turn Build red.
6. Record pre-cutover `origin/master` SHA, preserve this rollback target,
   and merge **once** only after the full green campaign. If a trust or
   platform parity regression remains, **do not merge**.
7. After merge: collect at least **three first-attempt successful trusted
   master Build runs**, each with a successful same-SHA manual Release
   qualification. Collect **five warm-cache Build measurements** across
   representative distinct commits plus cold/invalidation; include queue
   separately, p50/p90/max, critical path, restore/save phases, hit/miss,
   and actual repository occupancy <=10 GiB. Use the read-only report
   `node scripts/ci/cutover-metrics.mjs --branch master --warm id,id,id,id,id
   --cold id --invalidate id` with actual GitHub run IDs, and inspect the
   ccache logs for hit/miss (the cache-action hit flag is not a compiler
   hit-rate measurement). Do not present a single warm run or cached
   estimate as evidence of the p90 <20 min target.
8. Keep old and new full matrices from running concurrently. Revert the
   single master merge to the captured previous master SHA if trust,
   publication or parity checks regress.

## Hosted qualification attempts and failure attribution

The first source-locked cohort at SHA
`7e1a31dc7090c2bddc6c22f3c1c77aa3ea81fc65` launched concurrently:
[Build #44702945648](https://github.com/Cruel/nt/actions/runs/44702945648),
[Coverage #44702945493](https://github.com/Cruel/nt/actions/runs/44702945493),
and [Extended #44702945581](https://github.com/Cruel/nt/actions/runs/44702945581).
The Build was **not green** and therefore could not authorize its Extended
premerge receipt; Extended was cancelled, not counted as qualified.
Observed failures and source-owned fixes in the next branch revision:

- Windows production CLI: `spawn pnpm ENOENT` in the portable timing helper;
  allow Windows package-manager command shims only, preserving direct native
  spawning and rejecting shell control characters.
- Web threaded/nonthreaded release and devtools **and Android ARM64**:
  `Toolchain identity is missing` in the candidate manifest producer.
  Recover the actual configured compiler path from
  `CMakeCXXCompiler.cmake` when the toolchain deliberately does not cache it.
  Do not synthesize/ignore a missing compiler identity.
- Windows native authoring: one `Use Disk` reconciliation test exceeded its
  5-second generic timeout on the hosted runner; apply an explicit 30-second
  budget to that test only while retaining all behavioral assertions.
- Editor V8 coverage: native CLI integration tests were executing with an
  absent `build/cli/linux/noveltea` (ENOENT). Depend on the **same Coverage
  workflow's** already instrumented native build and download its native CLI
  artifact instead of dropping integration coverage or compiling an unrelated
  CLI a second time.
- Branch-only Release must use `verify --stage preview` to authenticate and
  checksum the **original completed branch Build** via GitHub API; Build-only
  `qualify` cannot be reused as a consumer stage. Production `promote`
  remains master-only and rejects all preview authorities.

No failure above is represented as a qualification success.

The second exact-SHA campaign at `3d618fa273e9b0a24ab054d383b28572af05885c`
started [Build #44706213718](https://github.com/Cruel/nt/actions/runs/44706213718),
[Coverage #44706213788](https://github.com/Cruel/nt/actions/runs/44706213788),
and [Extended #44706213748](https://github.com/Cruel/nt/actions/runs/44706213748).
The Web release/devtools matrix and Windows/Linux/macOS native authoring
passed their previously failing source and toolchain gates. Android ARM64
Release also passed. Android ARM64 devtools encountered an **independent
external Maven Central HTTP 429** fetching dependency POMs. A bounded,
source-owned Gradle wrapper retries **only** verified repository 429 errors
(up to three attempts), never compilation/test failures, without adding long-
lived Gradle dependency caches. Synthetic Release packaging now also tests
Linux/Windows/macOS executable and detached-symbol SHA-256 identity and
archive shape. This cohort cannot qualify if Build remains unsuccessful.

Observed second-cohort per-compiler timing, **not** a certified warm Build
sample: [Linux standard player job #136186930301](https://github.com/Cruel/nt/actions/runs/44706213718/job/136186930301)
compiled for 1,582.906 s (26.38 min) with **87/1,892 cache hits (4.60%)**;
[Linux devtools player job #136186930112](https://github.com/Cruel/nt/actions/runs/44706213718/job/136186930112)
compiled for 332.146 s (5.54 min) with **1,982/3,800 hits (52.16%)**.
These rates come from actual `ccache --show-stats` output, not cache-action
hit/miss values. They illustrate cold vs partially warm behavior but do not
satisfy the post-cutover p50/p90/5-sample target.

The second campaign completed red with **7 failed Build jobs** and
**Editor V8 coverage failing 1 of 2,774 tests**. Extended correctly refused
qualification because Build failed. The failures and repairs are recorded in
[#646's hosted investigation](https://github.com/Cruel/nt/issues/646#issuecomment-7046703540).

The next revision contains targeted source fixes, **not yet hosted-certified**:

- macOS CLI malformed managed marker negative: a structured `malformed` status
  stops mutation before an exception crosses the native CLI execution boundary;
  both `repair project` and `agent sync --fix` return the documented exit 5.
- Debian 12 container: authorize **only** `$GITHUB_WORKSPACE` as a Git safe
  directory, then verify its canonical root and checked-out commit against
  `GITHUB_SHA` before the Build candidate producer runs.
- Windows native CLI and player candidates: bind Release mode during Ninja
  configuration and, if cache build type is absent, independently require
  effective optimized `build.ninja` C++ compile flags and NDEBUG. Never infer
  Release solely from the candidate name; Debug or unverifiable builds fail.
- Windows notice cache: retain warm external-stage reuse only when an
  independently observed NTFS notice-file change-time fence also matches;
  restored-mtime writes must invalidate the stage and run the original notice
  validation rather than satisfying the stale source-revision hint.
- Editor Vitest: native Project handoff waits for worker exit and serialized
  runtime-cache cleanup before callers remove Project files; its 1/2,774
  `ENOTEMPTY` cleanup race is not hidden by a test skip or blanket retry.
- Extended: failed source/Build admission skips receipt sealing instead of
  generating a secondary empty-SHA error. Failure still blocks release.

Local verification: **184/184 CI contract tests**, Editor TypeScript
`tsc --noEmit`, targeted Editor handoff/controller tests, the locally rebuilt
native CLI repair-project negative suite, and native portable-validation cache
certification passed. Windows/macOS-specific behavior must still pass their
real hosted suites. The next campaign must rerun complete Build, Coverage and
Extended on a **new identical source SHA**, then full manual nonpublishing
Release. Failed or cancelled cohorts do not count as successful qualification.

## Third hosted campaign: remaining fixes pending qualification

The exact-SHA campaign at `b14012b7e27e84f4b5d60d499be45681f8bd5fc2`
completed with [Coverage #44793667326](https://github.com/Cruel/nt/actions/runs/44793667326)
**passing all three jobs**. [Build #44793667692](https://github.com/Cruel/nt/actions/runs/44793667692)
failed **8 jobs**; [Extended #44793667385](https://github.com/Cruel/nt/actions/runs/44793667385)
correctly denied source authority after Build failed, and did not attempt to
seal an empty-SHA receipt. Debian production CLI, macOS/Linux desktop players,
Web candidates, Android ARM64 devtools, and Linux/Windows/macOS native
authoring passed in this campaign.

New fixes for the remaining 8 Build failures, still requiring hosted acceptance:

- **Windows production CLI:** the CMakeCache parser's anchored regex ignored
  **CRLF-terminated cache lines**. Normalize CRLF before parsing and require
  the real CMAKE_BUILD_TYPE, compiler path and optimization flags; drop the
  previous missing-build-type Ninja fallback. Debug and missing build types
  remain rejected. Tests use CRLF cache fixtures.
- **macOS production CLI:** the malformed-marker case passed, but the next
  public negative for a symlinked AGENTS.md aborted from an uncaught native
  runtime_error. The native Agent Kit preparation boundary now catches its
  filesystem/rollback errors and returns an explicit result; CLI repair emits
  exit 5 with REPAIR_PREPARATION_FAILED while preserving all negative
  assertions, without relying on matching exception-message text.
- **Windows native policy + both Windows production players:** the pinned
  bgfx.cmake/dav1d header evaluates Clang's `__has_include_next` under MSVC
  14.52, causing C7780/C1017 before the actual player tests. A strict,
  idempotent FetchContent patch nests that builtin behind a Clang-only
  preprocessor conditional, preserving the actual native MSVC atomic path.
  A fixture test verifies idempotence and rejects upstream source drift.
- **Editor unit and Electron checks:** the prior handoff changes failed
  formatting on three TypeScript files. Run the repository's actual `vp fmt`
  and full `vp run check:all`; no tests or lint rules were disabled.
- **Android ARM64 Release:** while Devtools succeeded, its separate job
  reported an entire Gradle plugin classpath containing numerous previously
  available Maven modules missing across Google and Maven Central (not an
  explicit 429). Add a bounded retry only when five or more distinct Maven
  coordinates disappear from the entire plugin classpath across both repos;
  a single genuinely missing coordinate, compile failure and arbitrary 5xx
  still fail immediately. Subsequent retries use `--refresh-dependencies`.
  No long-lived dependency cache is introduced.

Local checks: `node --test tests/ci/*.mjs` **187/187**, the full Editor
`pnpm -C editor run check` including formatting, lint and TypeScript,
targeted Editor tests, native Linux CLI rebuilt and complete repair-project
certification. This is local evidence only; do not close #646 until the new
exact-SHA Build, Coverage and Extended host jobs and the downstream Release
qualification are actually successful.

## Fourth hosted campaign: final direct CLI safety negatives

On exact SHA `b8bdd945c3dfee297f1266fdd4ad6504d4301cb7`,
[Build #44808380464](https://github.com/Cruel/nt/actions/runs/44808380464)
completed with only two failing jobs: **C++ formatting** (one comment in
`native_cli_agent.hpp`) and **Production host CLI (macos)** (the public
`repair_project.py` negative for a symlinked `AGENTS.md` still aborted
with `libc++abi` and return code -6 instead of structured exit 5).
Several dependent Build jobs were **skipped**, not individually certified.
[Extended #44808380268](https://github.com/Cruel/nt/actions/runs/44808380268)
correctly denied authority because Build failed. At triage time
[Coverage #44808380542](https://github.com/Cruel/nt/actions/runs/44808380542)
was still running; do not count it as success before completion.

New fix: restore the exact pinned clang-format check for **all 733 C++
sources**, and replace the four predictable Agent Kit owner-path exceptions
(`AGENTS.md`, `.gitignore`, `.noveltea`, `.noveltea/agent`) with
**non-throwing, error-code-based preflight** that rejects symlinks, files in
directory positions, and directories in file positions before any mutation.
The deliberately injected swap-failure certification now performs its own
rollback and returns a failure result without throwing across the macOS native
CLI boundary. Unexpected failures remain reported rather than silently
accepted. This is not an exception-message-matching workaround.

Local verification: exact `clang-format==18.1.8` repository check passed
733/733 C++ sources; 187/187 CI contracts, native Release CLI rebuild,
`repair_project.py` full unsafe-path/rollback suite, and `agent_tools.py`
public Agent Kit/daemon suite passed. **No macOS acceptance is claimed**
until the next exact-SHA hosted run completes its negative suite.

## Fifth hosted campaign: Editor installers and installed-smoke failures

At exact SHA `136e0069c2ed9e150f9ab7205537e36f408289bc`,
[Build #44819491114](https://github.com/Cruel/nt/actions/runs/44819491114)
completed with **all source builds, policies, production host CLIs,
desktop player configurations/launches, Web/Android candidates, and ordinary
Editor tests passing**. Only the three production Editor host jobs failed:
Linux, Windows, and macOS. No downstream jobs were skipped.
[Coverage #44819491117](https://github.com/Cruel/nt/actions/runs/44819491117)
**passed** and [Extended #44819491256](https://github.com/Cruel/nt/actions/runs/44819491256)
correctly rejected the failed exact-SHA Build authority.

The remaining failures are in distinct packaging smoke gates:

- **Linux Editor:** the production package smoke passed, but the
  `stage-editor-candidate.mjs` CLI destructured `process.argv[1]` (the
  script path) as the catalog ID instead of `process.argv[2]`, rejecting the
  installer as an unknown candidate. Use the actual explicit ID and add a
  CLI-argument regression test, keeping the source-owned candidate checks.
- **Windows Editor:** **every** installed package smoke assertion passed and
  emitted a success result, but the harness attempted `rm` of its temporary
  directory on child `exit`, before the Electron helper handles closed;
  Node rejected the recursive removal with `EBUSY`. Await the child's
  `close` event and use bounded, Windows-only `rm` retries for transient
  locks; persistent lock failures still fail the gate. New tests cover both
  Windows retry options and failure propagation.
- **macOS Editor:** all smoke checks passed **except candidate repair**. Its
  diagnostic proof showed the repaired original bytes had been saved and
  the incumbent remained usable, but the test invoked
  `observeRepairCandidate` directly after Save, before asynchronous
  native revalidation/watch settlement had published `ready: true`. The
  smoke now subscribes to the **real renderer IPC readiness event** before
  observing and waits, with a bounded timeout, for a verified ready revision
  before explicitly opening the candidate. The negative/admission and
  preservation assertions remain mandatory; future failure logs include
  the actual native readiness diagnostics and Open error.

Local verification: **191/191 CI contract tests**, the full Editor
format/lint/typecheck task, targeted candidate-repair and native handoff
tests, and Electron main/preload/worker bundle pack. These are not substitutes
for hosted Windows/macOS package runs; do not count the fixes as qualified
until their exact-SHA Build completes successfully. Issue #646 stays open.

## Sixth hosted campaign: independent Windows cache proof and cold-run completion

At exact SHA `c71fb6e44249aaf1423e9732927470c3507e8239`,
[Coverage #44833506523](https://github.com/Cruel/nt/actions/runs/44833506523)
passed all three jobs. [Build #44833506303](https://github.com/Cruel/nt/actions/runs/44833506303)
completed as **cancelled**, with all Linux/macOS production Editor installers
passing, every platform player launch passing, and one failed Windows
production Editor qualification. [Extended #44833506550](https://github.com/Cruel/nt/actions/runs/44833506550)
remained unqualified. The Build's Linux desktop correctness job reached
its **90-minute job timeout** after all 1,474 native correctness CTests passed
and 22 of 24 representative CLI tests completed or were explicitly skipped;
the final two had not yet finished.

The Windows Editor failure occurred in
`certify-native-authoring-cross-system-worker.cjs`: the new session's
`validateClean` reported `cacheHit: false` even though the persisted cache
had been published. This was an **ambiguous test of two valid paths**:
the production worker starts cache maintenance and an 80ms source poller
immediately; that idle worker can import the same cache before the
test's explicit `validateClean` call. A warmed resident session's
`cacheHit: false` is not proof that disk-cache import failed.

The revised certification uses a separate, freshly opened, independent
worker with only **background polling disabled** to require `cacheHit: true`
against the **real** persisted Editor/CLI cache, and verifies that its
revision inventory is unchanged. The next Editor worker retains normal
background polling for the concurrent CLI/editor mutation and Save checks.
No cache correctness or simultaneous-write invariants are waived.

An initial repeated real cross-system run also exposed another independent
writer-lock publication race: a competing CLI could fail to read a newly
created `.writer-lock/owner.json` during publication, then mistake that
transient absence for an arbitrary invalid transaction source. The native
transaction service now re-reads a newly visible owner once; missing owners
remain `WORKSPACE_BUSY`, valid live owners remain busy, and persistently
malformed records are still rejected. It never retries a Save or reclaims
an owner without the existing dead-PID and guard proofs. The rebuilt native
CLI and native addon passed **three consecutive** real Editor/CLI disk-cache,
daemon and concurrent mutation certifications. Native CLI Project certification,
**195/195 CI contracts**, full Editor checks, and pinned C++ formatting
also pass locally.

The Linux cold-debug correctness job now has a 150-minute timeout without
removing or skipping tests. This is **headroom, not a claim of a faster
cached Build**; the cached Build under-20-minute target remains a separate
optimization goal.

Extended preview selection now inspects the newest Build's exact SHA,
status, and conclusion. It waits while queued/running, accepts only
completed success, and **immediately rejects every completed non-success**
including cancelled and timed-out Builds, rather than polling for two hours.
Its source authorization has 210-minute headroom and a 190-poll cap for
cold Build qualification. Executable mocked-`gh` tests prove success,
pending, failure, cancellation and timeout behavior.

The next exact-SHA push must confirm hosted Windows/macOS/Linux Editor
qualification, Linux native correctness, and Build/Extended completion;
none of these changes alone constitutes hosted acceptance.

## Seventh hosted campaign: complete Build/Coverage, Windows Extended shell mismatch

Commit `85ce35c3a1b3d874b64bf9dabb5c16e67b80b695` achieved a fully
successful [Build #44867752563](https://github.com/Cruel/nt/actions/runs/44867752563):
**38 of 38 Build jobs passed**, including the three production Editor
installer hosts, all native authoring and CLI certifications, player
launches, Android, and Web. [Coverage #44867752459](https://github.com/Cruel/nt/actions/runs/44867752459)
passed all three jobs.

[Extended #44867752555](https://github.com/Cruel/nt/actions/runs/44867752555)
authorized that exact Build and passed **10 of its 11 required qualification
jobs**: both Android emulators, Linux and Android cooperative no-threads,
Linux sanitizer, Web benchmark, Windows native CLI daemon/cache stress,
source/shader qualification, and native CLI performance. The remaining
`windows-worker-stress` job passed its native Project CTests, offline
source-cache repetition, packaged worker tests, real reconciliation, and
Electron worker certification. Its final **repeat native worker lifetime**
step failed *before running a single repeat*: GitHub launched PowerShell on
`windows-2025`, but the step contained Bash `for attempt in ...; do` syntax,
which PowerShell rejected. No observed native worker failure occurred.
The Extended receipt correctly failed closed because that job failed.

The fix explicitly sets `shell: pwsh` and uses a three-iteration PowerShell
`foreach` loop with immediate nonzero process-exit propagation on each
`pnpm` invocation. A workflow regression checks that the Windows step
continues to run three full iterations, preserves the real native-worker
test, and cannot silently accept a failing command.

This result establishes complete hosted **premerge Build and Coverage**
acceptance at the old SHA, but **not** exact-SHA Extended or Release
acceptance. Qualification must rerun after the workflow fix on a new SHA.

## Eighth hosted campaign: exact-SHA Extended qualified; Release Linux CLI path

At exact SHA `b9bf656c594796a164cd8920b4f7cd91633eb374`,
[Build #44881006403](https://github.com/Cruel/nt/actions/runs/44881006403)
passed **38/38 jobs**, and
[Coverage #44881006395](https://github.com/Cruel/nt/actions/runs/44881006395)
passed **3/3 jobs**. [Extended #44881006372](https://github.com/Cruel/nt/actions/runs/44881006372)
completed **successfully on attempt 2**, with all 12 jobs (including the
qualification receipt) passing. Attempt 1's only substantive failure was
Maven Central HTTP 429 throttling in Android cooperative Gradle dependency
resolution; a failed-jobs-only rerun resolved it without bypassing the test.
Windows worker lifetime repetition passed on this SHA.

The explicitly nonpublishing
[Release preview #44937874307](https://github.com/Cruel/nt/actions/runs/44937874307),
dispatched against the exact Build and Extended run IDs, authenticated
source authority successfully. Its Windows, macOS, Web, Android, and examples
qualification passed. **Both Linux desktop matrix variants failed** at
`linux_release_smoke.py` when attempting to execute nonexistent
`build/native-export-cli-linux/noveltea`. The Linux desktop job had already
restored and authenticated the `linux-release-cli-x64` candidate at its
catalog-defined `build/cli/linux` root. The smoke step alone retained an
obsolete executable location for both native CLI and license viewer, before
any export or AppImage launch could execute.

The corrected Linux Release smoke references exactly
`build/cli/linux/noveltea` and
`build/cli/linux/noveltea-ui-test-runner`. A CI contract checks that
these paths match the restored catalog candidate and that the obsolete
directory is not used in the Linux smoke step. No additional native build,
untrusted CLI, test reduction, or publication path is introduced.

Because the qualified candidate records pin `.github/workflows/release.yml`,
**changing the Release workflow requires a fresh exact-SHA Build and Extended
qualification** before a new nonpublishing Release preview. Never rerun the
old Release against previously qualified bytes with altered sources.
The first preview is not accepted as a complete release; downstream Editor
installer and inventory gates were skipped after Linux failed.

## Ninth hosted campaign: Windows daemon shutdown race and warm-cache evidence

Commit `61c5553680e2b0797dd0c80a753e9620a267bae8` achieved a complete
[Build #44939457143](https://github.com/Cruel/nt/actions/runs/44939457143)
(38/38 jobs), [Coverage #44939457199](https://github.com/Cruel/nt/actions/runs/44939457199)
(3/3 jobs), and eventually
[Extended #44939457096](https://github.com/Cruel/nt/actions/runs/44939457096)
(all 12 jobs on attempt 2). **Extended attempt 1 was not deterministic**:
the repeatedly exercised Windows CLI incremental-validation test returned
`DAEMON_BROKER` / `daemon process did not exit after stop`, although the
logical broker state was already `stopped`, with zero sessions/workers.
The test is correct to require actual Windows process termination, and the
exact-SHA Extended receipt correctly failed closed. Retrying passed but is
not a resolution of the underlying Windows shutdown hazard.

Code inspection identified a concrete deadlock possibility: a Windows
`ClientConnection::send` holds its write mutex during overlapped named-pipe
`WriteFile`. The old `close` acquired that **same mutex before**
calling `CancelIoEx`. Under a nonreading or stalled owner/control client,
the writer can hold the mutex until cancellation while cancellation cannot
start until the writer releases it. The change publishes a closing state and
cancels pending Windows I/O **before** acquiring the writer mutex, then
serializes the final disconnect/handle release. It preserves draining of the
stop response and strict process-exit verification. A Windows-only native
test deliberately leaves a named-pipe reader idle with a tiny output quota,
waits until an actual overlapped write is pending, and requires close to
abort the write without deadlocking. A second repeated test exercises
concurrent queued clients and true broker join. Any remaining process
termination timeout now includes PID and Win32 wait status for diagnosis.
This removes a specific shutdown deadlock; hosted Windows repetition must
still verify whether it accounts for the observed intermittent failure.

The same campaign took ~91 minutes for Build. This was **not warm**
compilation: Windows release CLI and desktop producers had vcpkg misses
and no effective compiler-object reuse; Linux native correctness restored
all main archives but achieved only **12/3,740 ccache hits (0.32%)**.
Windows CLI compiled 1,693 targets; Windows release player compiled 1,438.
Do not classify the campaign as a successful warm-cache measurement or
claim the under-20-minute target. A separate cache redesign is still needed
within the 10 GiB aggregate budget.

A second explicitly nonpublishing
[Release preview #44956993507](https://github.com/Cruel/nt/actions/runs/44956993507)
was dispatched against that exact SHA's successful Build and Extended IDs
before the Windows shutdown change was pushed. Its outcome is independent
of any later source revision; a new exact-SHA campaign is required for
the final cutover acceptance.

## Tenth hosted campaign: exact Windows regression passes; Linux first-start race reproduced

At exact SHA `c91adc354b22f578e580ef2257e17d74760510b5`,
[Build #44964272114](https://github.com/Cruel/nt/actions/runs/44964272114)
passed all 38 jobs, and manually dispatched
[Extended #44978762356](https://github.com/Cruel/nt/actions/runs/44978762356)
passed **all 12 jobs on the first attempt**, including the sealed exact-SHA
receipt. In hosted Windows, the new blocked named-pipe cancellation regression
and concurrent-client shutdown regression both passed. The native incremental
validation certification also passed its baseline and three stress repeats.
This verifies the specific deadlock correction under Windows. It does not
prove that unrelated Windows process-exit faults can no longer occur.

[Coverage #44964272199](https://github.com/Cruel/nt/actions/runs/44964272199)
failed in the Linux CTest stage: the daemon lifecycle test at
`tests/tooling/daemon_broker_tests.cpp:1356` saw `serve-start` return
`ok=false` during `ctest --parallel 2`, without reporting the underlying
error. The full CTest stage ran 1,474 tests with this single failed test; the
subsequent 24-case native CLI coverage stage passed. The downstream Editor
coverage job was skipped. Coverage is **not** acceptable on this SHA.

A code inspection of Unix `ensure_private_runtime_directory` found a
first-start race: after `lstat` observes `ENOENT`, another broker can
create the same per-user directory before `mkdir`, yielding `EEXIST`.
The original code treated that harmless race as fatal. A new Linux
regression launches **12 simultaneous real broker processes per fresh runtime
directory, over six independent rounds**; it reproduced exactly
`{"error":"failed to create private daemon runtime directory","ok":false}`
with the original implementation (50 child failures on the first run).
The fix accepts `EEXIST` **only as a reason to inspect the final directory**;
the existing owner, directory type, and private-permission checks remain
mandatory. After the fix, the 72-process case passed ten consecutive complete
executions, 48/48 local daemon tests passed, 197/197 Node CI contracts passed,
and pinned clang-format 18.1.8 checked all 733 C++ source files. The
original hosted Coverage failure omitted its error text, so matching the
precise observed CI failure remains a strong, reproducible hypothesis rather
than proven historical attribution. The failing lifecycle test now records
the actual startup response on future failures.

The successful nonpublishing Release preview
[#44956993507](https://github.com/Cruel/nt/actions/runs/44956993507)
still qualifies only earlier SHA `61c555368`. The Linux race correction
requires another exact-SHA Build/Coverage/Extended and Release preview.
No postmerge acceptance or warm-cache improvement is claimed.

## Eleventh hosted campaign: daemon race cleared, Gradle bootstrap reset

At exact SHA `42624cb1d8c5ad97742387903eefe9214b9106d8`,
[Build #44988656272](https://github.com/Cruel/nt/actions/runs/44988656272)
passed all 38 jobs, and
[Coverage #44988656268](https://github.com/Cruel/nt/actions/runs/44988656268)
passed all three jobs **on their first attempts**. This includes Linux's
parallel native daemon CTest suite with the new concurrent runtime-root
creation regression, resolving the prior demonstrated first-start race.

[Extended #44988656229](https://github.com/Cruel/nt/actions/runs/44988656229)
failed due to exactly one independently failed qualification:
`Android cooperative no-threads compatibility`. The failed step was
`Build Android cooperative native target`, **before native compilation**.
The Gradle wrapper attempted to fetch pinned
`https://services.gradle.org/distributions/gradle-8.9-bin.zip`, got a
`java.net.SocketException: Connection reset`, and exited. The existing
`retry-gradle-network.sh` classified this pre-build download interruption
as non-throttling and did not retry. Both Android emulator jobs, Windows
daemon/source-cache and worker lifetime stress, Linux cooperative,
Linux ASan/UBSan, Web benchmark, and source/asset jobs passed. The
qualification receipt correctly failed closed. This is an external Gradle
distribution transport failure, **not** a native no-threads compilation
regression, and a workflow rerun alone would not resolve the resilience
gap.

The follow-up enables bounded native Gradle wrapper distribution retries
(`retries=2`, `retryBackOffMs=1000`) and extends the source-owned
bounded CI retry helper to recognize **only** a proven GradleWrapperMain
download `SocketException: Connection reset` with no task/build execution.
The existing Maven 429 and missing-classpath guard remains; actual task,
compiler, linker and validation failures never become retryable.
New positive and negative contract fixtures cover recovery, persistence,
generic network resets, and task failures. Before hosted qualification,
10/10 focused retry tests, 201/201 CI contracts, and shell syntax/diff
checks passed. Since the source-owned pinned wrapper properties changed,
the amended SHA requires fresh exact-commit Build, Coverage, Extended
and a nonpublishing Release preview.

## Twelfth hosted campaign: independent Windows cache and Linux gcov failures

At exact SHA `d84897a4b63057156494ac7a678bac615dfb4d7a`,
[Build #44999094016](https://github.com/Cruel/nt/actions/runs/44999094016)
failed **only** in `Production Editor host (windows-x64)`, during
the independent native Editor/CLI disk cache certification. A fresh native
worker returned a valid result but `cacheHit=false` with 11 records and
11 contributions rechecked, instead of importing the exact on-disk ledger.
The recorded error lacked physical cache-admission details. Linux and other
Windows build producers passed. Separate native regression demonstrated that
`read_clean_cache` rejects a still-valid exact source generation when only
`project.yaml` metadata/mtime changes. The source cache now compares
byte-exact saved/current revisions for **all** files, independent of metadata,
and retains the full physical-source proof and rejection on changed bytes.
Before this fix, the new metadata-only cold-import test failed; afterward,
path-alias, correctness, recovery, and offline cache tests passed. This is a
real cache false-miss defect, but the original Windows CI log omitted source
metadata, so it cannot conclusively establish that defect as that run's
specific cause. The cross-system certification failure now reports whether
persisted source revisions and fingerprint remained exact.

[Coverage #44999094043](https://github.com/Cruel/nt/actions/runs/44999094043)
failed in the isolated native CLI CTest phase. All 1,475 ordinary CTests
passed, but `native_cli_daemon_owner` emitted
`libgcov profiling error ... linker.cpp.gcda: Merge mismatch for function 4548`.
The offline `gcov-tool merge` subsequently rejected that corrupted profile
(`5695 functions vs 5563 functions`). The existing CMake coverage contract
isolated **tests**, not simultaneously live CLI, broker, and owner/disposable
worker **processes** of the same test. An instrumented daemon can outlive a
foreground CLI that is exiting and updating the same .gcda file. The follow-up
gives instrumented broker/owner/disposable processes their own per-PID sibling
`GCOV_PREFIX` roots, while preserving ordinary foreground CLI per-test
roots and the existing offline merge. Production/normal CLI behavior is
unmodified. Coverage fixture now certifies an additional process-specific
sibling root is merged. This is a concrete shared-profile hazard; hosted
repetition is required to verify it resolves the observed intermittent merge
mismatch.

[Extended #44999094055](https://github.com/Cruel/nt/actions/runs/44999094055)
failed closed in source authorization because the exact-SHA Build had
failed. It did **not** rerun the Android cooperative job on this SHA; the
previous Gradle wrapper transport retry remains unqualified. No Release
preview or master merge is supported on this run.

## Thirteenth hosted campaign: verified coverage, two independent Windows defects

On `151b31352c735dfa809b95a95dfd38354da096f7`,
[Coverage #45019015276](https://github.com/Cruel/nt/actions/runs/45019015276)
passed all three jobs for the second consecutive exact-commit campaign, while
[Build #45019015161](https://github.com/Cruel/nt/actions/runs/45019015161)
failed two of 38 jobs, both on Windows. The previous formatting failure is
resolved: independent Editor checks, Editor/Electron, and Linux/macOS installers
passed.

In Windows C++ policy, `native_cli_portable_validation_cache` reproduced a
**stale distribution-notice stage**: an in-place same-size rewrite followed
by restored mtime reported `noticeValidationReuses=1` and
`noticeValidationRuns=0`. The independent Windows `FileBasicInfo.ChangeTime`
fence is insufficient for this particular immediately restored-mtime write.
The follow-up queries the synchronous per-file NTFS USN through
`FSCTL_READ_FILE_USN_DATA`; when unavailable or unsupported it uses a
bounded, same-handle exact hash for notices up to the validated 1 MiB cap.
Reparse points and unreadable files never receive reusable proof. The test
now checks two further immediate same-size restored-mtime rewrites without
sleeping or weakening correctness expectations. The normal incremental CLI
certification and shader validation cache both passed in that failed job.

In the Windows production Editor host, a fresh Electron native worker
still returned `cacheHit=false`, rechecking 11 records, despite persisted
source revisions, semantic fingerprint, valid result and resident ledger
all matching. This proves the previous metadata-only cache fix was
insufficient. The follow-up compares the persisted `projectRoot` to the
**actual same physical directory** using `std::filesystem::equivalent` on
Windows rather than bytewise path spelling; the existing narrow 8.3 alias
test is extended with a different-case same-directory ledger and a
recomputed-digest different-directory rejection test. This is an independently
valid path-identity fix; the old log does **not** prove path identity was
the specific rejecting condition. Opt-in native cold-cache admission
checkpoints are enabled only for the certification's cold worker so that a
subsequent hosted miss will identify the gate instead of forcing another
guess.

[Extended #45019063161](https://github.com/Cruel/nt/actions/runs/45019063161)
was dispatched manually before Build had completed; its provenance check
correctly rejected the in-progress Build immediately, and no qualification
tests ran. The next automatic path-triggered Extended run must wait for the
exact completed successful Build and fail closed otherwise. No successful
full premerge, postmerge, or nonpublishing Release acceptance is claimed.

## Fourteenth campaign: distinguish correctness from collector/readmission races

The previously qualified integration SHA `61c555368` has **first-attempt**
[Build #44939457143](https://github.com/Cruel/nt/actions/runs/44939457143),
[Coverage #44939457199](https://github.com/Cruel/nt/actions/runs/44939457199),
[Extended #44939457096](https://github.com/Cruel/nt/actions/runs/44939457096),
and nonpublishing
[Release preview #44956993507](https://github.com/Cruel/nt/actions/runs/44956993507)
all successful. Preserve that as a rollback and behavior reference.

On `83d678e29ba8196d9b8a88573d927d65e3db138d`,
[Build #45055118154](https://github.com/Cruel/nt/actions/runs/45055118154)
passed 37/38 jobs, including production Windows Editor/CLI interop; the
Windows C++ policy job failed only two native validation certifications.
`native_cli_portable_validation_cache` observed `noticeValidationReuses=1`
rather than a public `noticeValidationRuns=1` after a **valid-to-valid**
same-size, restored-mtime rewrite. That public counter alone cannot prove
stale content: a resident maintenance validator may have completed the work
before the public request. The invalid/control-bearing, restored-mtime,
missing and escaping notice negative checks remain strict and must still
reject stale success. For valid-to-valid writes, certify one stage proof
(reused or run) and subsequent warm reuse; do not demand work be accounted
to a particular observer. `native_cli_incremental_validation_certification`
observed a one-program shader recompile on otherwise semantically resident
Windows input. Permit at most one **explicitly logged** Windows shader stage
readmission per Project; the next request and every subsequent truly warm
sample must have no shader compilation or other stage rework. A diagnostic
rerun of only the failing Windows policy job on the **same SHA** passed both
previously failed certification tests without source changes (step success
verified while the rest of that job was still running). This establishes
nondeterministic test-stage timing, not a first-attempt qualifying Build.

[Coverage #45055117971](https://github.com/Cruel/nt/actions/runs/45055117971)
passed all **1,475 ordinary CTests and 24 CLI CTests**. Its failure was an
offline GCC `gcov-tool` merge of a daemon PID-specific profile containing
incompatible `material_semantics.cpp.gcda` function counts (831 vs 438).
The collector copied each root immediately after CTest, without awaiting
instrumented background owners' final libgcov writes. Coverage-only native
broker/owner/disposable startup now creates its PID-specific root **before**
doing work; the collector waits for all those processes to have exited
(or returns a bounded, actionable timeout) before snapshotting. A focused
instrumented delayed-worker regression proves the old collector silently
merged 3 of 4 roots, while the corrected collector waits and merges all 4.
This directly proves a collection race, but hosted execution must confirm
it also resolves the original GCC function-count mismatch.

[Extended #45055118030](https://github.com/Cruel/nt/actions/runs/45055118030)
correctly denied qualification following the failed exact-SHA Build and did
not run platform tests. Do not count rerun-only or manually premature
qualifications as first-attempt success. Do not advance to master or publish
a Release until coordinated acceptance is satisfied.

## Current evidence and limitations

- Local complete CI contracts: **201/201 pass**, including the native coverage
  fixture via the installed `/home/thomas/.local/bin/uv`. GitHub CI provisions
  `uv` via pinned `astral-sh/setup-uv`.
- Authenticated GitHub inspection of branch protection/rulesets performed;
  current protected status inventory: none.
- 2026-11-20 initial Actions cache sample:
  **10,066,130,683 bytes** (~9.37 GiB) with 34 cache entries. During the
  second hosted Build, transient occupancy reached **10.03 GiB**, above the
  10 GiB target. Source-owned `node scripts/ci/cache-budget.mjs apply`
  removed **three safely superseded cache generations**, preserving the last
  compatible cache per family and restoring observed inventory to **9.05 GiB**.
  Do not misreport the transient overshoot as continuously within budget.
  Measure the final occupancy again after the next hosted campaign; workflow
  artifacts remain separate from the compiler-cache budget.
- No hosted premerge or postmerge success is implied by local tests. Add
  direct run links, full job results and measured wall times here as they
  become available; #646 remains open until all acceptance conditions pass.
