# Extended Qualification (CI integration branch)

The independent `Extended Qualification` GitHub Actions workflow runs nightly
and by manual dispatch from `master`. It is **not** a PR gate. Its workload
is deliberately separate from the required `Build`: sanitizers and parser
fuzz smoke, repeated Windows daemon/source-cache and native worker lifetime
checks, cooperative Linux/Android builds, Chromium/Firefox benchmark smoke,
Android API 24/35 emulator export/update smoke, and native CLI performance
diagnostics. Required production-target compilation, public/native CLI
correctness, ordinary CTest, Feature Lab, and package/export correctness remain
in `Build`.

## Selecting a revision

A manual dispatch accepts an exact lowercase 40-character `sha`; if omitted,
it uses `master`'s triggering SHA. The authorization job verifies that the
commit exists and is an ancestor of the trusted master branch, then identifies
a successfully completed **master-push Build** workflow run for that SHA.
It rechecks the candidate Build run's repository, branch, event, path, status,
conclusion and source commit via the authenticated GitHub API. A PR, integration
branch, or merely manually dispatched Build cannot authorize Extended.

All Extended jobs check out the selected SHA. Android emulator smoke downloads
the two exported APK fixtures from the selected trusted Build run; native CLI
performance reuses its exact candidate artifact and verifies the candidate's
production-promotion trust contract. Other compatibility jobs reuse their
existing source-owned tests and pinned tools at that SHA.

## Qualification evidence

The workflow's final job uses `if: always()` and refuses to seal a receipt if
**any** required job failed, was skipped, was cancelled, or was omitted. A source
authorization failure also prevents certification. It then writes the
`noveltea-extended-qualification` artifact containing a current-contract
`receipt.json`. That receipt records the qualified source SHA (which may
differ from the workflow-definition SHA), workflow run ID/attempt, event,
repository/ref/path, trusted Build run ID, source-owned contract SHA-256, and
the complete successful job set. Its contract and verifier live at
`scripts/ci/extended-qualification-contract.json` and
`scripts/ci/extended-qualification.mjs`.

**The receipt alone is not release authority.** Before relying on it, Release
must download it from the exact Actions run, call
`verifyTrustedQualificationRun(receipt, authenticatedRun, sourceSha)` and
independently establish that the enclosing run is a completed success, with
matching repository, workflow path, source selection, workflow SHA, run ID and
attempt. It must also establish the corresponding trusted Build run and its
candidate artifacts; #645 integrates those checks and the missing-evidence
dispatch/retry policy. If any selected-SHA evidence is missing or invalid,
publication fails closed.

## Cache budget and completion boundary

Coverage retains a 1536M instrumented compiler-object cache allowance; Extended
restores compiled dependency and compiler caches **read-only**, rather than
introducing competing compiler cache generations. Downloaded vcpkg source/SDK
checkouts are pinned and bootstrapped but are not cached. The shared vcpkg bootstrap
continues to pin its source regardless of a cache hit. Run
`node scripts/ci/cache-budget.mjs allocation` for the current occupancy,
Coverage allowance, 128 MiB safety reserve and remaining capacity before the
10 GiB limit. The snapshot recorded on 2026-11-20 was 9.37 GiB; it predated
the higher instrumented allowance and is not an allocation estimate for the
new policy. On 2026-11-22, six obsolete branch-specific cache entries were
reclaimed, lowering observed repository occupancy from 10.03 to 6.43 GiB.
The next exact-SHA hosted campaign must verify that new Windows GNU/MSVC
compiler-object and compiled-vcpkg cache generations fit after population.
This is a **local capacity model**, not a claim that the complete canonical
Build matrix will remain resident: #646 measures
actual hosted cache residency, workflow success, warm/cold timings and
cross-platform reliability through post-cutover acceptance.

Local validation: `node --test tests/ci/extended_qualification_tests.mjs
tests/ci/cache_budget_tests.mjs`. The full integrated hosted nonpublishing
campaign is intentionally deferred to #646; this branch must not be merged
or used to publish in isolation. Feature Lab is not changed by these CI
workflow contracts (the existing authored Lab suite remains covered).
