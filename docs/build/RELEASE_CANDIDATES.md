# Source-owned CI release candidates and cache budget

This document records the **integration-branch implementation** introduced
by #642 and expanded in #643–#645. It is not yet the active production
Build → Release cutover. The shared inventory, provenance and ABI/variant
assertions are source-owned; #644 separates informational Coverage and exact-SHA
Extended Qualification, and #645 makes Release consume only the independently
trusted candidates and qualification receipts. **#646 still owns cross-platform
hosted GitHub Actions certification, performance measurements, coordinated
merge and post-cutover acceptance.** Do not promote the Ubuntu development
host CLI as the Debian Linux release CLI or treat integration-branch candidates
as trusted publication evidence.

## Candidate interface

`scripts/ci/release-candidates.json` is the source-owned candidate catalog.
The `linux-host-cli-x64` row remains the **Build** Ubuntu 24.04 development
CLI (`linux-authoring-release`, glibc <= 2.39), not the Release Debian glibc
<= 2.36 CLI or Linux glibc <= 2.28 player. The catalog now includes exact
production/diagnostic target, ABI, compiler and variant rows for the full
Build candidate producer matrix described below.

`node scripts/ci/release-candidate.mjs produce --candidate linux-host-cli-x64`
runs after the existing CLI's native correctness certification and ABI audit
in Build. It stages `candidate-generated-contracts.json` and
`noveltea-candidate.json` next to the CLI, so the existing named
`noveltea-host-cli-linux-x64` upload contains its manifest. The
`linux-cli-certify` Build job downloads those exact bytes and invokes
`verify --candidate linux-host-cli-x64 --stage qualify` before using the
binary. The manifest is format `noveltea-release-candidate`, version 1:
source SHA, producer repository/workflow/run/attempt/event/ref, target and
variant, exact build type/compiler/version/toolchain/preset/optimization flags,
ABI floor, SHA-256 hashes of pinned dependency inputs and source schema inputs,
generated schema bytes/digest, and a complete file size/hash inventory. Unknown
versions, path escapes, hidden files, symbolic links and extra/missing files
fail closed. Producers and consumers use the same script. The producer and consumer additionally execute the native
CLI's no-daemon JSON status probe to prove the executable's embedded build
identity is exactly `git:<source SHA>` (no dirty suffix or stale revision).
The CLI contract is exercised with
`node --test tests/ci/release_candidate_tests.mjs`.

A qualified candidate is not publishable solely because it passes qualification:
promotion uses `verify --candidate ... --stage promote` and requires
`GH_TOKEN` to independently retrieve the successful **master-push Build**
workflow run from GitHub. The exact repository, workflow path, source SHA,
run ID/attempt, branch, event and successful conclusion must match. Pull-request,
fork, manual/branch-only and unsuccessful runs cannot confer publication trust.
A tag-triggered Release selects the successful canonical Build candidate for
its **exact source SHA** and requires a successful Extended Qualification
receipt bound to that SHA and Build run. The integration branch now changes
the Release *definition* to restore those bytes, but actual publication remains
gated by the hosted qualification and coordinated merge tracked in #646.

## #645: Trusted Release promotion and complete platform certification

The Release metadata job runs `node scripts/ci/release-promotion.mjs authorize
<40-character-source-sha>`. The source-owned candidate catalog determines
the complete required Build artifact inventory, including the separately
qualified Web Editor preview, common shaders and Windows tooling bridges.
GitHub's authenticated Actions API must provide a successful **master push**
Build run with exactly the requested source SHA and all expected, unexpired
artifacts. No pull-request, fork, arbitrary manual, tag-only or unsuccessful
Build run is a publication authority. If no trusted producer exists, Release
fails rather than compiling an alternative binary.

Release also locates a completed, successful Extended Qualification receipt
with the same exact source SHA **and the selected Build run ID**. If one is
absent, the metadata job dispatches the master Extended workflow with the
requested SHA, waits for its receipt, and fails on an unsuccessful or timed-out
qualification. It writes `build/release-authority.json` recording pinned Build
and Extended run IDs and attempts. `release-inventory` and `publish` independently
re-fetch and revalidate **those same run IDs/attempts and receipts**, rather
than silently switching to newly available or unqualified evidence. Manual
workflow dispatch may qualify a Release but cannot publish. Only a push to a
matching `v*` version tag can publish; every checkout is pinned to the trigger
SHA, with the original tag and VERSION rules preserved.

The reusable `.github/actions/restore-release-candidate` action downloads
individual source-catalog artifacts only from the selected Build run, restores
executable permissions where necessary, and reruns the strict manifest, schema,
compiler, ABI and GitHub producer checks. Independent Release platform
certification remains mandatory: Linux/Windows/macOS native CLI ABI checks;
six desktop player variants with real export/launch, dependency checks and
platform reports; four Web variants with separate DWARF; Android optimized
ARM64 Release/devtools and separately authenticated x86_64 Debug-only ABI
coverage, plus native APK/AAB exports; and all three actual Editor installer
sets with Linux install/uninstall smoke. Release does not compile duplicate
CLI, player or Editor binaries; source-controlled CMake asset staging, export
fixtures, reports, checksums, attestations, and public release manifest still
run. `scripts/ci/promote-release-template.mjs` changes **only** release-tagged
descriptor/SBOM metadata and detached symbol BUILD_IDs while checking that all
compiled payloads and other original Build bytes retain their exact SHA-256
identities. Android Debug's diagnostic `ci-<SHA>` prefix is handled explicitly,
and diagnosis is not production promotion. `scripts/ci/promote-editor-candidate.mjs`
verifies and renames the exact original signed Build installers instead of
running Electron packaging twice.

Local source and synthetic-byte contracts:

```sh
node --test tests/ci/release_promotion_tests.mjs \\
  tests/ci/editor_promotion_tests.mjs \\
  tests/ci/android_release_promotion_tests.mjs
node --test tests/ci/*.mjs
```

These demonstrate fail-closed source/Build/Extended binding, missing and
substituted artifact rejection, unchanged player/Editor bytes, manual publish
exclusion, and the unchanged downstream platform gates. They **do not replace**
#646's genuine cross-platform hosted Actions and complete release/publication
certification before merging the one-time cutover. The rollback remains the
pre-migration master workflow. Feature Lab/runtime Project behavior is out
of scope for this CI-only change.

## #643: Release-critical Build candidate inventory

The Build workflow contains new, distinct producers for the production
configurations already found in Release. The authoritative inventory is
`scripts/ci/release-candidates.json`; all rows are test-enforced by
`tests/ci/production_candidate_tests.mjs`. Each Build producer runs native
compilation with its actual release preset and qualified dependency closure;
stages its complete player template/Editor distribution, not a substitute
debug executable; and invokes the same repository-owned
`.github/actions/produce-candidate` action. That action checks the
target/variant/ABI/compiler/schema/dependency identities and SHA-256 bytes
before uploading the corresponding candidate artifact.

| Build candidate IDs | Compiler / compatibility contract | Required qualification |
| --- | --- | --- |
| `linux-host-cli-x64` | Ubuntu 24.04 GCC; glibc <= 2.39; development snapshot tool only | Existing public native CLI and installed CLI cert |
| `linux-release-cli-x64` | Debian 12 GCC; glibc <= 2.36; GLIBCXX <= 3.4.30 | Standalone authoring CLI native certification and ELF audit |
| `windows-release-cli-x64` | MinGW GNU (not MSVC); Windows 10 | Standalone native CLI certification, PE static-runtime dependency audit |
| `macos-release-cli-arm64` | AppleClang; macOS >= 14 | Native CLI certification and Mach-O deployment check |
| `linux-player-x64-{release,devtools}` | Both in pinned glibc 2.28 container | Optimized player, SDL/native policies, ELF audit and devtools-symbol check |
| `windows-player-x64-{release,devtools}` | MSVC, Windows 10 1809 / RS5 floor | Optimized player, dependency audit, actual staged template |
| `macos-player-arm64-{release,devtools}` | AppleClang, deployment target 11 | Optimized player, dependency audit, Mach-O minOS and staged template |
| `web-player-{threads,no-threads}-{release,devtools}` | Emsdk 6.0.0, optimized MinSizeRel | WebAssembly module, forbidden debug/runtime APIs, CMake web template |
| `android-player-arm64-{release,devtools}` | NDK 28.2.13676358, Android API 24 floor | Actual Gradle Release native closure, 16 KiB ELF alignment, staged APK/AAB-capable source template |
| `android-player-x64-debug` | Android x86_64 Debug, **diagnostic only** | Existing Gradle debug/export/API 24/35 emulator job; promotion explicitly forbidden |
| `{linux,windows}-editor-x64`, `macos-editor-arm64` | Electron host packages, native addon at host ABI floor | Build-qualified CLI/Web preview, native addon/CLI authority, actual installers and independent distribution SHA checks |

For Editor, `scripts/ci/stage-editor-candidate.mjs` consumes
`editor/out/electron-builder/latest-artifact.json`, verifies its canonical
VERSION release tag and exact per-host installer set and digests, and stages
the complete installer inventory. This deliberately uses the distribution
library's existing version/tag policy: no synthetic tag or replacement
signed binary is introduced. Candidate metadata binds the installers to the
precise Build source SHA; Release-specific installer/signing checks remain
Release responsibilities.

`scripts/ci/release-candidate.mjs` supports both `describe` (source-owned
artifact paths/names for workflow configuration) and `produce`/`verify`
(the same manifest verifier for every kind). It independently checks PE,
ELF, Mach-O, WebAssembly and Android ELF ABI identity, configured compiler
and optimization mode (including Web MinSizeRel and MSVC), and a complete
artifact byte inventory; diagnostic Android Debug cannot be promoted.
For Android, Gradle may choose `Release`, `RelWithDebInfo` or `MinSizeRel`
for its optimized native build. The candidate validator inspects real engine
compiler commands for NDEBUG, effective -O2/-O3/-Os/-Oz optimization and the
ABI/API 24 target; it does not assume CMake's desktop `-O3` Release flags.
Debug or unoptimized Android native compilation cannot be promoted.
Each producer also records bounded compilation timings and variant-isolated
compiler-cache scopes. The dependent `production-desktop-launch-smoke` matrix
independently downloads both the exact manifest-qualified player template and
the platform's separately qualified native CLI, verifies both, reconstructs
a template archive **without** candidate-only provenance metadata, and runs
the existing real Linux (Xvfb), Windows (software OpenGL) or macOS C++
platform export/launch smoke. The runtime check is mandatory for each of the
six standard/devtools desktop rows; no alternate binary is rebuilt in the
launch job.

The original exact-run artifacts `noveltea-host-cli-linux-x64`,
`noveltea-web-player-threads-release` and
`noveltea-development-examples` are preserved; examples still require
their exact Build CLI and threaded Web source, while Site retains its existing
separate dependency. The independent `editor-preflight` TypeScript/unit
job has no native CLI or Web artifact dependency, so fast Editor feedback
starts before production compilation. The existing Editor packaging and
functional tests are retained rather than reclassified as a cheaper
replacement.

**Qualification boundary:** These jobs are local-contract-tested and
source-reviewed on the integration branch. They are not yet green
cross-platform hosted GitHub runs. #646 must prove that every compiled
version/runner/toolchain and platform package passes its recorded floor,
meets exact-run consumer contracts and stays inside the 10 GiB cache budget
before the one coordinated merge. No release/publication is authorized by
this implementation checkpoint.

## Cache identity, publication and maintenance

`.github/actions/setup-ccache` and `save-ccache` use a stable compatibility
prefix composed of runner OS/architecture, purpose/target/build mode,
detected compiler identity and source-controlled CMake/vcpkg compatibility
inputs. Different compilation modes do not use each other's fallback cache.
A new immutable run/attempt generation is published only after a successful
trusted compilation with actual misses: a missing cache, at least eight
misses, or a miss rate of at least five percent. The exact prefix can restore
older compatible weekly generations during the transition. A cache hit is
not a reason to freeze an inadequate cache for an entire week. Pull requests
restore read-only; already warm or empty compilations do not publish a
redundant generation. Statistics are reset after restore so reported compiler
hits/misses belong to the current job.

The default compiler-object limit is 256M; the Windows GNU production CLI
uses 512M, Windows release/devtools players 384M each, Windows C++ policy
768M, and Linux Debug correctness and native GCC Coverage 1536M each.
These are ccache size limits, not guarantees of actual cache residency.
Coverage uses checksum-pinned ccache 4.14.3 and a compile-twice probe that
requires byte-identical object/coverage notes and a real cache hit while
retaining `-fprofile-update=atomic`. Ubuntu's older ccache does not support
that option. Only compiler outputs are stored by ccache, not whole CMake
directories or multi-gigabyte static archives. Actual restore time, hit/matched
key, size, compiler hit statistics and save time are emitted to the Actions
summary. The `scripts/ci/time-command.mjs` wrapper records elapsed
build-and-link phases and propagates failures without retrying or suppressing
them.

Host Linux prerequisites use `scripts/ci/install-apt-packages.sh`: installed
packages require no network access. Hosted Ubuntu 24.04 x64 uses an explicit
HTTPS Ubuntu archive and an independent mirror on failure, with the normal
Ubuntu archive signature and freshness checks. Each bounded attempt refreshes
indexes and downloads missing packages before the single offline package
installation. Source selection is invocation-local; the runner's source
configuration is not edited. No compilation or test failure is retried.

Linux vcpkg binary cache writers rotate weekly per configuration rather than
saving a large immutable entry per commit. Cache the compiled vcpkg binary
packages and compatible installed trees, not the vcpkg Git SDK/source checkout.
Windows policy and production players share a compressed compiled-package
cache with the same MSVC/ABI/pin identity; they do not archive the derived
uncompressed vcpkg installed tree. The MinGW production CLI uses its own
compressed compiled-package and compiler-object scopes, never MSVC outputs.
The macOS CLI has its own compiled-package writer; the qualified standard
macOS player and Linux glibc 2.28 player each publish one compiled-package
cache consumed by their matching devtools variant. These writers run only
after successful trusted master builds, and do not save downloaded SDK trees.
All Build and Release vcpkg bootstraps using the shared helper verify an exact detached
SDK commit from
the pinned builtin-registry revision in `vcpkg-configuration.json`. Cache
restore is a performance optimization; cached state cannot override the SDK
source pin. Future CI tickets must pin any remaining mutable upstream downloads
before treating them as canonical production inputs.

`node scripts/ci/cache-budget.mjs report` inspects Actions cache occupancy,
printing a safe deletion plan without mutating state.
`node scripts/ci/cache-budget.mjs apply` is the explicit maintenance
operation. It removes **only superseded SHA/weekly/run generations on the same
GitHub ref**, preserving the newest published master compiler generation for
each compatibility prefix and every unique/unrecognized cache. Master compiler
generations are compacted even below the budget; other duplicate generations
are pruned only as necessary. Other refs are never treated as interchangeable
merely because their keys match. It fails visibly if conservative pruning
cannot reach its 9.5 GiB internal ceiling (leaving headroom under GitHub's
10 GiB limit); it never deletes unique configurations to satisfy a number.
The maintenance workflow runs daily and after completed trusted-master push
Build/Coverage runs with `actions:write`. It does not execute maintenance code
from PRs or foreign repositories. For a
genuine cold-cache benchmark, deliberately invalidate a pinned scope on a
separate development run and measure restore/compile time; do not delete
unrelated production caches in an uncontrolled experiment.

The independent Coverage job restores shared pinned compiled vcpkg caches
read-only and has one 1536M instrumented compiler-object allowance. Extended
Qualification restores compiled dependency and compiler caches without
publishing new entries.
`node scripts/ci/cache-budget.mjs allocation` models occupancy, new Coverage
allocation, a 128 MiB safety reserve and remaining production headroom below
10 GiB; see [Extended Qualification](EXTENDED_QUALIFICATION.md). The
canonical Build remains the only routine source of production compiler-cache
writes. Actual production cache residency is still a #646 acceptance gate.

Observed on 2026-11-19, the repository held 11,920,810,128 bytes of Actions
cache (~11.10 GiB). The safe prune deleted six older compatible generations,
leaving ~9.37 GiB, with all latest-per-family entries preserved. On
2026-11-22, live occupancy had reached **10.03 GiB**: an obsolete Nov. 18
compatibility branch held six independently scoped caches totaling **3.60 GiB**.
Deleting only those expired-use cache entries (no branch/source/artifact deletion)
reduced observed cache occupancy to **6.43 GiB**. This is a
point-in-time occupancy measurement, not proof that future cross-platform
Build/Release warm runs meet a <20-minute target. Cache performance and
complete release-candidate parity require new workflow-run evidence on the
integration branch and, following the atomic cutover, trusted master runs.

## Acceptance and rollback boundary

Use `node --test tests/ci/*.mjs` for the existing workflow contract suite
and `node --test tests/ci/release_candidate_tests.mjs
tests/ci/cache_budget_tests.mjs tests/ci/vcpkg_pin_tests.mjs` for focused
contracts. Full CI requires pinned `uv` for native gcov report tests; a local
machine without it cannot certify that slice. Build's existing native/public
CLI tests remain mandatory; no retries were introduced for deterministic
validation failures.

The old `master` Build/Release workflows remain the rollback target until
#641's coordinated migration is verified, with required branch-protection
status names checked before merging. Rollback means reverting the complete CI
cutover, not accepting a cheaper Release rebuild or weakening provenance
checks. None of these changes affect authored runtime Project behavior or
Feature Lab, which is not applicable to this CI-only contract.
