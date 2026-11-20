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

The next cohort must rerun the complete Build, Coverage and Extended workflows
on a **new, identical exact source SHA**, followed by the full manual
nonpublishing Release. Running or cancelled cohorts do not count as success.

## Current evidence and limitations

- Local complete CI contracts: all tests except native coverage's external
  `uv` dependency pass in this checkout; GitHub CI installs `uv` through
  pinned `astral-sh/setup-uv`.
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
