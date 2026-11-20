# Source-owned CI release candidates and cache budget

This document records the **integration-branch implementation** introduced by #642.
It is not yet the active production Build → Release cutover. Issue #641 owns the
complete platform inventory, independent Coverage/Extended workflows, and the
one-time coordinated merge. Do not promote the current Ubuntu-built host CLI as
the Debian-built Linux release CLI or assume an integration-branch run is trusted
release evidence.

## Candidate interface

`scripts/ci/release-candidates.json` is the source-owned candidate catalog.
Its initial `linux-host-cli-x64` row identifies the **Build** Ubuntu 24.04
optimized host CLI (`linux-authoring-release`, glibc <= 2.39), not the
separate Release Debian glibc <= 2.36 CLI or Linux glibc <= 2.28 player.

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

This first candidate is not publishable solely because it passes qualification:
promotion uses `verify --candidate ... --stage promote` and requires
`GH_TOKEN` to independently retrieve the successful **master-push Build**
workflow run from GitHub. The exact repository, workflow path, source SHA,
run ID/attempt, branch, event and successful conclusion must match. Pull-request,
fork, manual/branch-only and unsuccessful runs cannot confer publication trust.
A tag-triggered Release must select the Build candidate for its exact source
SHA and satisfy the separately planned Extended Qualification contract before
publication. The integration branch deliberately does **not** yet change
Release to consume candidate bytes or activate a publication path.

## Cache identity, publication and maintenance

`.github/actions/setup-ccache` and `save-ccache` use a stable, rotating
weekly key composed of runner OS/architecture, purpose/target/build mode,
detected compiler identity and source-controlled CMake/vcpkg compatibility
inputs. Different compilation modes do not use each other's fallback cache.
The exact-week key is immutable; it is created only on a trusted push and
restored read-only by pull requests. Compiler cache size is limited to
256 MiB per job, with actual restore time, hit/matched key, size, compiler
hit statistics and save time emitted to the Actions summary. The
`scripts/ci/time-command.mjs` wrapper records elapsed build-and-link phases
and propagates failures without retrying or suppressing them.

Linux vcpkg binary cache writers rotate weekly per configuration rather than
saving a large immutable entry per commit. All Build and Release vcpkg
bootstraps using the shared helper verify an exact detached SDK commit from
the pinned builtin-registry revision in `vcpkg-configuration.json`. Cache
restore is a performance optimization; cached state cannot override the SDK
source pin. Future CI tickets must pin any remaining mutable upstream downloads
before treating them as canonical production inputs.

`node scripts/ci/cache-budget.mjs report` inspects Actions cache occupancy,
printing a safe deletion plan without mutating state.
`node scripts/ci/cache-budget.mjs apply` is the explicit maintenance
operation. It removes **only superseded SHA/weekly generations**, preserving
the newest available generation for each recognized compatible scope and
every unique/unrecognized cache. It fails visibly if conservative pruning
cannot reach its 9.5 GiB internal ceiling (leaving headroom under GitHub's
10 GiB limit); it never deletes unique configurations to satisfy a number.
The maintenance workflow runs daily on trusted master with `actions:write`;
it will not start until the complete integration branch is merged. For a
genuine cold-cache benchmark, deliberately invalidate a pinned scope on a
separate development run and measure restore/compile time; do not delete
unrelated production caches in an uncontrolled experiment.

Observed on 2026-11-19, the repository held 11,920,810,128 bytes of Actions
cache (~11.10 GiB). The safe prune deleted six older compatible generations,
leaving ~9.37 GiB, with all latest-per-family entries preserved. This is a
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
