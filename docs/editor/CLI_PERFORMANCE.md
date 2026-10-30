# Native CLI validation performance investigation

## Scope and status

Active optimization follow-up for daemon-backed `noveltea validate`. The first implementation
slice removes fresh Project admission from validation's final source-generation proof; the second
reuses the clean-validation snapshot during compiler-input preparation and eliminates redundant
large response-buffer initialization. See [Slice 1](#slice-1-retained-validation-freshness-proof)
and [Slice 2](#slice-2-reuse-validated-preparation-and-client-resources). The original investigation below
records baseline evidence from `4e0dcdfc`, not performance guarantees. See
[CLI contracts](CLI.md) before changing validation or source-authority behavior.

The problem is **repeated whole-Project work around an incremental validator**, not an
unoptimized compiler build or failure to retain the primary validation session.

### #574: capture-local filesystem component evidence (2026-10-30)

**Attribution and change.** A targeted Release `strace -f` of two successive
changed-label, `--no-daemon` Feature Lab validations, with
`NOVELTEA_NATIVE_PROOF_TRACE=1`, confirmed six complete source captures per
measured edit. The repeated `/tmp`, Project root, `records`, and
`records/layouts` `readlink` calls come primarily from prefix walks by
`SourceAuthority::capture` (`secure()` and its publication recheck). The same
capture also performed a redundant follow-status of every non-symlink leaf,
checked already-resolved source parents for directory watches, and checked
scanned source directories twice. Separately, native source generation and
clean-cache Asset exact proof used two file-type checks to establish a
single no-follow regular-file requirement. The attribution combines syscall
path histograms, the exact source call sites, and the opt-in capture/proof
events; it is **not** an unwound stack count for every syscall.

The observer now resolves each unique parent component once per capture:
ordinary POSIX directory components extend their verified parent path without
repeating a full canonical walk, and symlink components still use
`weakly_canonical`. A **new** component map at the end of the capture checks
both resolved targets and entry types before authority is published. The
Project root is independently re-canonicalized. The already-observed
`symlink_status` proves an ordinary leaf's type without a second `status`;
contained symlinks still need following checks. Parent evidence is reused
only within that capture for watcher registration. Windows retains full
`weakly_canonical` resolution for each component because reparse points and
junctions are not equivalent to POSIX directory entries. Two independent
source-generation/cache proof sites now use one no-follow type query each.

| Changed-label direct CLI, six captures | Before | After | Delta |
|---|---:|---:|---:|
| `newfstatat` | 26,039 | 19,932 | −6,107 (−23.5%) |
| `readlink` | 9,110 | 6,578 | −2,532 (−27.8%) |
| `openat` | 5,074 | 5,074 | 0 |
| `getdents64` | 828 | 828 | 0 |
| `readlink` of `/tmp` | 2,351 | 1,763 | −588 |
| `readlink` of Project root | 2,351 | 1,763 | −588 |
| `readlink` of `records` | 825 | 381 | −444 |
| `readlink` of `records/layouts` | 357 | 93 | −264 |

The traces used the same temporary Feature Lab Project, equivalent warm
changed-label requests, and successive Release builds. Each compared sample
had exactly six `complete-capture` events; `openat` and `getdents64` being
unchanged corroborates that source membership scans and physical reads were
not eliminated. Other checks continue outside `capture`: `exact_proof`,
`native_project_source_generation`, portable `project_paths`, disk safety,
and clean-cache operations enforce different admission/preparation/publication
boundaries. The trace's opt-in *completion* events cannot precisely assign
all intervening syscalls to a single phase, and the total count must not be
called six identical per-capture costs.

Uninstrumented `validation_performance.py` used the persistent native daemon
owner and disposable Project fixtures, with the same three changed-label
sequence per size. All values are milliseconds, with warm changed results
reported as medians of three edits, not stability guarantees.

| Project | Before cold / unchanged / changed | After cold / unchanged / changed |
|---|---|---|
| Feature Lab | 3,100.45 / 13.63 / 368.35 | 3,118.61 / 13.00 / 362.48 |
| 1 Room | 104.04 / 5.77 / 13.77 | 101.03 / 6.26 / 13.12 |
| 101 Rooms | 203.27 / 9.20 / 48.66 | 196.37 / 10.03 / 49.81 |
| 501 Rooms | 609.93 / 21.44 / 208.27 | 605.74 / 21.58 / 190.49 |

The Feature Lab changed-label median fell **5.87 ms (1.6%)** in this matched,
small-sample run; one after-request took 509.51 ms, so the result is noisy.
An intermediate observer-only build measured 352.17 ms, also illustrating
run-to-run variation. Do **not** translate the much larger traced syscall
reductions into equivalent wall-time percentages, and do not add them to the
already-realized #571–#573 savings. The exploratory 200 ms target is still
unmet. The Linux `strace` numbers are for direct CLI, whereas the untraced
latencies include native daemon/broker overhead; the two modes are not
interchangeable.

Containment and correctness are unchanged in intent: prefix evidence lasts
only through one capture, watcher hints remain non-authoritative, no source
membership or byte-exact Asset digest pass was suppressed, and independent
pre/post validation fences are preserved. Tests cover in-root directory
aliases, escaping parent/leaf replacement and recovery, recursive aliases,
source deletion/recreation, watcher-loss recovery, and same-size Asset edits
with restored timestamps. Linux descriptor-relative `openat2` could provide a
stronger atomic containment boundary but was not mixed into this portable
optimization: preserving admitted in-root symlink aliases, mount behavior,
cross-platform semantics, and all read/commit fences requires a separate
design and acceptance matrix. This change makes no claim to eliminate all
filesystem TOCTOU windows or to reject bind mounts already accepted by the
existing `std::filesystem` path contract.

**Qualification:** Linux Debug source-hash, Project-session,
Project-validation and three clean-cache CTests passed (six tests); the
native-disk validation regression passed 425 assertions across seven cases.
The relocated Release daemon-owner certification and six-stage native CLI
performance gate passed. The editor check and full editor test suite passed
(2,103 tests passed; 135 skipped), as did clang-format and Release/Debug
build targets. The initial local certification did not exercise other host
platforms or an intentional concurrent symlink-swap TOCTOU harness; the
cross-host matrix and subsequent Linux stress tests are noted below.

**Completion qualification:** The Linux mount-namespace fixture in
`tests/native_cli/source_observation_mount.py` passed with an actual bind
mount: a contained mounted Lua source was accepted, a symlink from the
mounted directory to an outside file was rejected, and removal restored
valid admission. Bind mounts themselves retain the preexisting lexical
Project-root policy; this does not establish a new physical-filesystem
boundary. The companion `source_observation_race.py` performed **276 source
creates/deletes during three direct CLI validations**. All three ongoing
observations rejected the continuously unstable source state; both settled
membership states subsequently validated. The race harness asserts recovery
and protocol consistency rather than requiring a machine-dependent number
of rejected requests. Both scripts are wired into Linux host CLI CI; the
mount test skips on Linux agents without user/mount namespace privileges.
Native authoring host CI now also executes the complete Project-session and
clean-cache-correctness certifications on Windows, macOS, and Linux. This
adds cross-host execution coverage to the existing ordinary-source tests;
Windows symlink creation remains guarded when permissions or native APIs
do not support it. No claim is made that this stress harness atomically
prevents all concurrent symlink-swap TOCTOU windows; that would require a
separately designed descriptor-relative source-reading boundary.

### #573: eliminate per-Message translation DOM copies (2026-10-30)

**Confirmed allocation source.** Heaptrack was attached to the **persistent native
daemon Project-owner PID**, not to the short-lived CLI client, on the Linux
Release (`-O3`) executable. The owner was warmed with a disposable Feature Lab
copy and then received ten distinct `records/rooms/feature-lab-home.yaml` label
edits and validations, with an isolated certification daemon runtime root.
The before and after runs used the same checkout, fixture and request sequence,
with the CLI rebuilt between runs. Release function symbols resolved the
dominant stack through `native_font_coverage_inputs` to `effective_translation`:

`effective_translation` used `localization.value("translations", Json::object())`,
**copying the whole translation map for each Message and locale lookup**. This
was independent of whether any individual Message actually had a translation.
The replacement borrows the request-local immutable DOM and uses an empty
fallback only for absent translations. It retains the same locale-parent
lookup, source fallback, Message ordering and output shapes; no view or new
cache survives the call.

| Heaptrack owner, ten edits | Before | After | Change |
|---|---:|---:|---:|
| Allocation calls | 36,546,671 | 20,287,073 | -44.5% |
| Bytes requested by allocations | 3,869,844,241 | 3,035,744,947 | -21.6% |
| Highest allocation-call stack (all call sites, calls) | `std::_Rb_tree::_M_copy`, 9,544,539 | `std::_Rb_tree::_M_copy`, 1,866,514 | -80.4% |
| Heaptrack-reported peak heap | 27.55 MB | 27.55 MB | no observed change |

The before stack includes `nlohmann::json` copy construction inside
`effective_translation`; after the change it is no longer among the dominant
allocation stacks. The raw heaptrack `a` allocation definitions and `+`
events were used to sum requested bytes, independent of allocation-call counts.
The attach/detach streams reported incomplete final compressed trailers; the
event data was recoverable by `heaptrack_print`, but the attach-time *leaked*
bytes metric is not an owner-lifetime leak or retained-cache measurement. No
cache was introduced. Source-level DWARF line attribution was unnecessary for
this symbolized, confirmed call-site copy; no claim is made that the top
allocator alone identified the problem before its callers were inspected.

Uninstrumented, same-owner changed-label validations (excluding the first
owner-admission call) yielded medians of **393.11 ms before** and **353.84 ms
after**, a **39.27 ms / 10.0% improvement** over seven warm changed-label
requests in each run. The after-only reproducible
`tests/native_cli/validation_performance.py` run reported:

| Project | Cold (ms) | Unchanged (ms) | Changed label median (ms) |
|---|---:|---:|---:|
| Feature Lab | 3,101.67 | 13.15 | 357.27 |
| 1 Room | 106.53 | 5.58 | 15.58 |
| 101 Rooms | 203.91 | 9.08 | 50.57 |
| 501 Rooms | 616.37 | 21.48 | 197.20 |

The 1/101/501-Room figures are **after-only scaling checks**, not A/B speedup
estimates. Exclusive stage attribution is limited to the confirmed translation
copy inside `native_font_coverage_inputs` (called from validation after
`prepare_complete_working` and `native_project_localization_view`): source
observation/proof, clean-cache validation, Project assembly, Material request
projection, response serialization and daemon IPC were not modified by this
slice. Their independent JSON and snapshot-copy costs remain potential future
profiling targets, not measured gains attributed to this fix.

The regression `warm font coverage matches cold recomputation after a
translation edit` compares unchanged and cross-localization-dependency
responses, including font coverage, Material inputs, diagnostics and source
generation; the existing native disk suite covers a Room edit, stale proof,
invalid sources and restarted owners. The original 200 ms Feature Lab target
remains exploratory, not a CI gate.

Verification: the rebuilt Debug `noveltea_tooling_tests '[native-disk-validation]'`
passed **425 assertions in seven cases**; the relocated Release
`tests/native_cli/daemon_owner.py` passed owner lifecycle, replacement,
reconciliation, concurrent operations and restart; the six-stage native CLI
performance gate passed. The CLI behavior change is internal to the C++
authoring tool, not runtime gameplay, so Feature Lab needs no new authored
scenario; its existing fixture serves the regression and profiling workload.

**Final Debug integration qualification (2026-10-30):**
`ctest --test-dir build/linux-debug --output-on-failure -R '^native_cli_feature_lab_cold$'`
passed after rebuilding `noveltea-player` from the current checkout. The
previous run had passed all 43 authored Tests, ZIP/package validation and CLI
entrypoints but failed at the player startup smoke with prepared-media schema
errors; its local player executable dated from October 10 while the CLI had
been rebuilt on October 30. Rebuilding the player resolved that mismatch.
The full rerun passed in 605.34 seconds, including player startup. The Debug
public-contract, daemon-owner and font-coverage bridge CTests also passed in
the same qualification cycle.

### #571: XXH3-128 physical-Asset proofs and shared hashing (2026-10-30)

**Decision:** Use XXH3-128 for internal, independently repeated binary Asset
fingerprints during native CLI validation, while preserving SHA-256 for
externally visible source revisions, text revisions, authored Asset hashes,
Project bundle manifests and player/package integrity. ZIP still uses CRC32.
The public source-generation identity remains SHA-256, but its material now
contains XXH3-128 binary member digests, so the canonical domain separator
was advanced to `native-project-source-generation-v2` to invalidate old
generation/cache entries. None of the three independent byte-exact physical
Asset proof boundaries from #572 were removed or replaced by metadata hints.

The selected XXH3-128 implementation is xxHash v0.8.4, pinned at
`c87183a77d67f7d37e3d2d1b7eaac5e7c695e4f0` through
`cmake/NovelTeaXxhash.cmake`, header-only, with no runtime linker dependency.
`noveltea::core::Xxh3Hasher` provides incremental hashing without copying
large binary sources, and uses upstream canonical digest byte order.
The same wrapper is available to host authoring and engine code; runtime UI
thumbnail filenames now use XXH3-64 rather than FNV-1a. No cryptographic
digest in player/package verification or in externally trusted downloads
was replaced.

**Why not change every `sha256:` string?** These are not all local
fingerprints. Several are persisted/editor-visible revision contracts, while
others certify package, shader, or downloaded bytes. In particular, the
editor's source buffers and native transaction preconditions still speak
`sha256:<64 lowercase hex>`; changing only one side would make saves and
recovery inconsistent. A full editor protocol/format migration is a
separate atomic change, not hidden behind this performance optimization.

The original #571 measurement on the Ryzen 7 5700G showed XXH3-128 at
**21,425 MiB/s** on Feature Lab's 6,235,344-byte `ipag.ttf` input, versus
**331 MiB/s** for the portable scalar SHA-256 and **754 MiB/s** for
SHA-NI. That is 0.278 ms for XXH3 versus 17.95 ms for scalar SHA-256
or 7.88 ms for SHA-NI (one-shot benchmark; excludes disk I/O).
The committed SHA-NI specialization was removed in favor of XXH3 on the
hot binary proof path. These are isolated hashing measurements, not an
end-to-end validation speedup claim.

The revised `tests/native_cli/source_hash_benchmark.cpp` compares XXH3
streaming, independent libxxhash XXH3, and pinned libfyaml BLAKE3. The
`native_authoring_source_hash` certification covers upstream reference
vectors, binary data and incremental hashing across small and large
chunk boundaries. Other source/cache/daemon and Feature Lab qualification
still applies: the decision changes digest cost, not trust boundaries.
The revised Release benchmark (same Ryzen 7 5700G, GCC `-O3`) measured
the selected header-only XXH3-128 stream at **30,196 MiB/s** for 64 KiB
updates on `ipag.ttf` (0.197 ms), compared with **21,751 MiB/s**
for the independent one-shot libxxhash reference (0.273 ms).
With 1 KiB updates the header-only stream measured 18,843 MiB/s.
These measurements exclude disk reads, other proof work and CLI startup.

**Qualification (Linux Debug, 2026-10-30):** The pinned XXH3 vectors and
streaming tests, native Project session and validation certifications,
clean-cache correctness, Feature Lab public validation, native daemon-owner
relocation/concurrency/restart certification, clang-format, schema-version
policy, and C++ module/dependency/compiler policy checks passed. The
candidate native CLI performance gate passed its six stages
(cold standalone 488 ms, cold daemon 505 ms, warm unchanged 12 ms, changed
record 42 ms, changed Lua 38 ms, export preparation 479 ms). These six
small-fixture stage timings are not an A/B comparison to the former SHA-NI
code; the original hash microbenchmarks isolate the byte-digest gain.
The daemon test required an explicit temporary build identity on the dirty
test checkout; production cache admission still requires a build-bound
compiler identity. Web, Android and Windows/macOS certification were not
run in this Linux qualification.

#### Post-#572 XXH3 qualification and matched Release A/B (2026-10-30)

The existing `tests/native_cli/validation_performance.py` driver was
repeated on the same Linux Ryzen 7 5700G host with two saved Release CLI
executables and disposable fixture copies. The earlier executable
(`e446b3521bba24553bba33ed891f0a6c34cfadd74f9bb68b4b229205b4f3df16`)
already had SHA-NI-accelerated binary proofs; the XXH3 executable
(`0b152cb46f801fe73975af6f85f47d00eea290393074daf659590a00efefad94`)
replaces that path with XXH3-128. The runs alternated SHA-NI, XXH3,
XXH3, SHA-NI to limit ordering effects. Each run measured cold and
unchanged validation followed by three changed Room-label validations
with a fresh isolated native daemon owner and cleared validation cache.
Numbers below are the **median changed-label latency per run in ms**.

| Project | SHA-NI run 1 | XXH3 run 1 | XXH3 run 2 | SHA-NI run 2 |
|---|---:|---:|---:|---:|
| Feature Lab | 427.83 | 398.55 | 394.74 | 408.92 |
| 1 Room | 13.91 | 14.11 | 13.76 | 13.41 |
| 101 Rooms | 50.71 | 50.55 | 48.97 | 48.29 |
| 501 Rooms | 197.54 | 196.88 | 203.62 | 200.07 |

Feature Lab's mean of per-run medians improved from **418.38 to 396.65 ms**
(**21.73 ms / 5.2%**). The small Room-only cases showed no consistent
benefit, as expected when large physical binary digests are absent. Cold
Feature Lab admission remained around 3.2 s; unchanged validations were
around 13 ms. These are local, small-sample measurements, not a
machine-independent CI performance budget. The 200 ms exploratory Feature
Lab goal remains unmet and is outside this hashing ticket.

For a comparable CPU attribution check, `perf record -e cycles:u -F 599
-p <resident-owner-pid>` sampled 12 successive changed-label validations
per variant. Baseline: **2,542 samples**, zero lost;
SHA `message_schedule` **10.22%** and `compress_sha_ni` **4.48%** exclusive
samples. XXH3 candidate: **2,436 samples**, zero lost;
the retained scalar `exact_source_revision` SHA used for text contracts
accounted for **7.74%** exclusive samples, while
`XXH3_hashLong_128b_default` was **0.17%** and
`XXH3_update_regular` **0.09%**. The named symbols are not a complete
partition of total hash cycles, and changed sampling profiles must not be
interpreted as additive latency savings. This is a post-#572 and post-#571
profile of resident owner work, not the original pre-deduplication 29.52%
SHA-256 profile.

Additional regression qualification used the rebuilt current-code Debug
`noveltea_tooling_tests '[native-disk-validation]'` suite:
**396 assertions across six test cases passed** (same-size Asset mutations
with restored mtime, intervening edits, symlink substitution, source
membership changes, and stale-generation rejection). Five focused
`native_authoring_*` source-hash, Project-session and clean-cache CTests
passed. The daemon broker/lifecycle regression and six-stage CLI
performance gate also passed, preserving independent pre/post byte-exact
fences and the `native-project-source-generation-v2` cache invalidation.

The GitHub Build qualification on
`qualification/571-xxh3` (run
`41023248720`) passed native Project authoring on **Linux, Windows and
macOS**, and Android cooperative compilation. Web/Emscripten compiled
but its template packaging rejected the newly fetched xxHash source
because its license/SBOM applicability was unclassified. Commit
`905097c3` explicitly classifies the pinned xxHash BSD-2-Clause
license for player targets, including Android; the metadata generator
passed against the Linux dependency inventory and captured the actual
license bytes. Follow-up cross-platform verification was dispatched on
`qualification/571-xxh3-webfix` (run `41024794114`): its
**Web/Emscripten** player build and template packaging both passed with
xxHash's required notice included, and its macOS native-authoring job
passed. The preceding run also passed Linux/Windows/macOS native authoring
and Android cooperative compilation. This verifies native authoring on
all three host platforms and runtime compilation on Web and Android.
Standalone Windows player/Android emulator/runtime functional testing is
not a hash-algorithm-specific requirement of #571; full Build workflow
jobs may continue beyond this targeted qualification.

### #572: exact Asset proof boundaries and diagnostics

The native owner retains these distinct byte-exact fingerprint checks on a successful
changed-label public validation:

1. Clean-validation pre-proof: checks the physical Asset bytes alongside the
   exact text revisions captured at request admission.
2. Preparation source generation: rehashes binary Assets **after** semantic
   validation and complete Project/font/Material source preparation, and
   binds those inputs to the public `sha256:` generation identity. Its exact
   path/digest map is compared to the pre-proof and, only on a match, reused
   to publish the durable clean cache. A standalone editor validation still
   publishes with its own independent post-validation proof; it never trusts
   metadata-only `physical:size:mtime` hints.
3. Final public proof: independently rehashes the same Assets after external
   font coverage and shader processing. Its pre/post physical observations
   check source membership and containment. This second generation cannot
   reuse preparation digests, even when size and mtime are unchanged.

For a warm label edit, the standalone post-validation cache-publication
digest pass is no longer needed by the public native owner: it is merged into
the later preparation proof only while both checks are inside the same
serialized request. On a **valid public native clean-cache hit**, the initial
exact cache proof is retained as provisional digest evidence; the later
independent preparation source-generation proof must match its complete
path/digest map before the owner returns success. This avoids the separate
`cache-final` Asset pass. The post-font/shader final proof remains independent.
Standalone/editor consumers and invalid cached results still perform
`cache-final` immediately because they have no guaranteed later generation
proof. A mismatch revokes source authority and fails closed rather than
accepting the cache or rewriting it.
The revision map is consumed through an observation-scoped read-only view
rather than copied merely to iterate; it must not be retained across source
observation.
On a cache miss in the same request, the exact cache-admission map is also the
pre-validation digest evidence; it does not need a second immediately adjacent
binary pass. The independently re-observed post-preparation generation must
still match that pre-validation map. Any uncertain/rejected cache hydration
revokes this evidence and falls back to a full physical observation.
Native generation uses bounded bulk reads rather than allocating its entire
file one byte at a time. The resulting source generation string, SHA-256
algorithm and durable clean-cache format remain unchanged.

Set `NOVELTEA_NATIVE_PROOF_TRACE=1` **on the native owner process** for
debugging. Its stderr reports `[native-proof]` records for each physical
Asset read/hash (`phase`, `asset`, `bytes`, `hashes=1`, `reads=1`), each complete
source capture, text SHA reuse within the immediately observed generation,
and selected conflicts/recovery. Group records by phase and sum `bytes` to
reconstruct the source-work timeline. Use `noveltea --no-daemon` to capture
stderr directly: detached daemon-owner stderr may be redirected and is not
guaranteed to appear in the client output. Ordinary Release requests do not emit
these records; this opt-in trace is not a public CLI diagnostic or a cache.
It does not authorize reusing digest evidence across external operations,
between distinct requests, or after any uncertainty about source authority.

#### Reproduced proof-work reduction (2026-10-29)

On this Linux dev-lawdeep checkout, two successive local Release CLI builds
were run against identical disposable Feature Lab copies. Each copy was first
validated with `--no-daemon`, then the home Room's `label` was changed and a
second direct validation ran with `NOVELTEA_NATIVE_PROOF_TRACE=1`. The earlier
build included the post-preparation publication consolidation but still
performed a separate second pre-proof after a cold cache miss. The later
build reuses that already verified cache-admission proof:

| Changed-label `--no-daemon` trace | Before final pre-proof reuse | After |
|---|---:|---:|
| Referenced physical binary Assets | 25 | 25 |
| Byte-exact pre-proof passes | 2 | 1 |
| Byte-exact preparation-generation passes | 1 | 1 |
| Byte-exact final-generation passes | 1 | 1 |
| Complete source captures | 7 | 7 |
| Asset digest reads/hashes | 100 | 75 |
| Asset bytes read/hashed | 35,604,788 | 26,703,591 |

Each full pass reads 8,901,197 Asset bytes, including `ipag.ttf` (6,235,344),
`DejaVuSans.ttf` (759,720), and `DejaVuSans-Bold.ttf` (708,920). The later
generation phases each reuse 370 observed exact text revisions but **never**
reuse a binary Asset digest across the shader/compiler boundary. This is a
25% reduction in direct-route physical Asset digest work for this edit, not
a 25% expected wall-clock reduction. On a resident warm owner, cache-admission
is normally skipped; the pre, preparation and final passes remain independent.

#### Additional valid cache-hit consolidation

A further check of the same Release direct-route binary found that a fresh
process reloading an unchanged durable clean cache still hashed all Assets in
`cache-final`, even though its public validation owner would independently
hash them again at `validation-preparation-generation`. For valid hydrated
cache hits only, `cache-final` is now deferred to that later mandatory proof.
An opt-in trace against disposable Feature Lab copies measured:

| Unchanged `--no-daemon` clean-cache hit | Before | After |
|---|---:|---:|
| Referenced physical Assets | 25 | 25 |
| Asset digest passes | 4 | 3 |
| Asset read/hash operations | 100 | 75 |
| Asset bytes read/hashed | 35,604,788 | 26,703,591 |

Cold clean-cache misses continue to require three passes. The independent
post-font/shader proof is unchanged. A focused native certification checks
standalone immediate verification, valid public deferred-cache acceptance,
no unnecessary cache rewrite, restored-size/mtime font mutation between
admission and preparation proof (must reject), and fresh-owner recovery.
The relocated CLI daemon-owner lifecycle suite and all six stages of native
CLI performance certification pass. A fresh four-project daemon benchmark
reported Feature Lab cold 3,230.28 ms, unchanged 13.19 ms, and median
changed-label 471.90 ms; 1/101/501-Room changed-label medians were 14.21,
49.09, and 228.95 ms. These are small observational samples, not a controlled
same-host A/B latency claim; the trace above measures the exact proof-work
reduction.

The final Release CLI was also measured using
`python3 tests/native_cli/validation_performance.py build/cli/linux/noveltea .`
with an isolated native daemon runtime and three changed-label validations
per project, following cold and unchanged validations:

| Project | Cold (ms) | Unchanged (ms) | Median changed label (ms) |
|---|---:|---:|---:|
| Feature Lab | 3,332.80 | 13.24 | **476.93** |
| 1 Room | 106.41 | 5.83 | **14.18** |
| 101 Rooms | 202.13 | 9.09 | **52.25** |
| 501 Rooms | 632.09 | 22.01 | **204.02** |

The earlier #572 ticket recorded ~522.2 ms for the Feature Lab changed-label
median on `e1de9493`; this newer 476.93 ms observation is directionally lower,
but the two measurements were not made as a controlled same-host A/B. The
investigative Feature Lab target below 200 ms is still unmet and is not a CI
acceptance threshold. The direct-route proof counters above *were* measured
in matched before/after runs on the same checkout and machine.

An independent **post-change resident daemon-owner CPU profile** sampled
12 successive Feature Lab label edits using
`perf record -e cycles:u -F 599 -p <owner-pid>` with the Release CLI and a
disposable isolated native daemon. Its 3,068 samples had zero reported losses;
the 12 edits had a 480.13 ms wall-time median (range 470.74–502.15 ms).
`exact_source_revision()` still contributed **27.86%** of exclusive sampled
user-mode cycles and `__memcmp_avx2_movbe` **5.85%**. This is remaining
CPU work, not the performance savings from eliminating a duplicate pass.
The earlier ticket's 29.52% SHA-256 profile used a different build/session,
so those sample percentages are directional, not a controlled before/after
CPU improvement claim. Source-authority fences and independent final physical
digests remain potential optimization costs, not redundant work to remove.

Regression qualification in this checkout: Linux Release CLI build and its
relocation smoke, the Debug native Project-session certification, the Debug
native CLI Project certification, `tests/native_cli/daemon_owner.py`, the
six-stage `editor/scripts/certify-native-cli-performance.mjs`, and the
1/101/501-Room and Feature Lab benchmark all passed. A disposable Feature Lab
validation compared `--no-daemon` and daemon routes on unchanged and edited
Room sources and observed equal public diagnostics and exit status. The added
native certifications independently overwrite an image, a font, and a shader
with original size/mtime retained between generation creation and final proof;
all old-generation proofs reject, followed by successful recovery. The clean
cache certification independently rejects an overwritten binary Asset with
its original size/mtime restored. These checks exercise fixed source-boundary
mutations rather than depending on scheduler-sensitive timing.

## Reproduction and build identity

The measured installed executable was `build/cli/linux/noveltea`, SHA-256
`edc9feacd5d58bb811478adadc799eed246b06a86cda24efe6b1a0aaaa34cfb5`.
It exactly matched `build/linux-authoring-release/tools/editor_tool/native-cli/noveltea`.
The Ninja compilation rules for both `native_cli.cpp` and `room_session.cpp` specify
`-O3 -DNDEBUG`. The handoff's formerly dirty macOS path fix was already committed.

All measurements used disposable copies, normal daemon routing, and successful JSON validation
responses. A cold admission was followed by an unchanged request and three distinct edits to
only the Room's top-level `label`. Source files in the repository were not changed.
The Feature Lab copy's `.noveltea/cache` was removed before admission; other copied local state
was left as-is. “Cold” therefore means new owner/no validation cache, not a cold OS page cache
or necessarily empty shader build outputs.

| Project | Cold admission | Unchanged | Median changed label (3 edits) |
|---|---:|---:|---:|
| Feature Lab, uninstrumented | 3,740 ms | 16 ms | 1,124 ms |
| Feature Lab, detailed probes | 3,826 ms | 16 ms | 1,139 ms |
| Generated Project, 1 simple Room | 92 ms | 11 ms | 26 ms |
| Generated Project, 101 simple Rooms | 234 ms | 12 ms | 118 ms |
| Generated Project, 501 simple Rooms | 827 ms | 24 ms | 483 ms |

The synthetic Projects duplicate the default Room from `entity create rooms performance`,
changing each duplicate's ID and filename, with `performance` as the manifest entrypoint.
The same `performance` label is edited in all sizes. This isolates approximately linear
Project-size growth without Feature Lab's shader/localization complexity.

The existing `editor/scripts/certify-native-cli-performance.mjs` passed all six stages:
candidate cold standalone 108 ms, cold daemon 113 ms, unchanged 13 ms, YAML edit 27 ms,
Lua edit 27 ms, Project export 77 ms. Its YAML edit appends a **comment**, not a label.
Both its “oracle” and “candidate” are the same native executable, not a historical baseline;
that gate does not detect this shared Project-size cost.

### Repeat the Feature Lab measurement

Run from the repository root after building the CLI. This intentionally fails while the
symptom remains; 200 ms is an investigative budget, **not** a portable CI threshold.

```sh
python3 - <<'PY'
import json, pathlib, shutil, statistics, subprocess, tempfile, time
binary = str(pathlib.Path('build/cli/linux/noveltea').resolve())
with tempfile.TemporaryDirectory(prefix='nt-cli-perf-') as tmp:
    project = pathlib.Path(tmp) / 'project'
    shutil.copytree('tests/projects/feature-lab', project)
    shutil.rmtree(project / '.noveltea/cache', ignore_errors=True)
    def validate():
        start = time.perf_counter()
        result = subprocess.run(
            [binary, '--json', '--project', str(project), 'validate'],
            capture_output=True, text=True, check=True)
        assert json.loads(result.stdout)['success'] and not result.stderr
        return (time.perf_counter() - start) * 1000
    cold, warm = validate(), validate()
    room = project / 'records/rooms/feature-lab-home.yaml'
    original = room.read_text()
    assert 'label: Feature Lab Home' in original
    changed = []
    for index in range(3):
        room.write_text(original.replace('label: Feature Lab Home',
                                         f'label: Feature Lab Home Bench {index}'))
        changed.append(validate())
    print({'cold_ms': cold, 'warm_ms': warm, 'changed_ms': changed})
    assert statistics.median(changed) < 200, 'Local edit exceeds investigative budget'
PY
```

## Slice 1: retained validation freshness proof

Implemented on top of `79a89a51`. Only public validation's final check now dispatches
`validation-source-generation-proof` to the existing native disk-validation owner. Other commands'
`source-generation-proof` and `native_project_source_generation_is_current` behavior is unchanged.
There is no label-specific fast path, semantic-validation skip, font/shader bypass, or new cache.

The proof requires the retained session for the same canonical root. It brackets the existing exact
all-source hash (including physical binary Asset bytes) with two retained source observations and
read-only disk-safety checks. Those observations rediscover source membership, validate containment,
and hash text bytes; they do not trust watcher events or metadata as exact content evidence.
Pending transaction/import state rejects publication without recovery. A changed or unavailable
authority returns a conflict and drops the retained session, so consuming a membership delta in a
failed proof cannot conceal it from the next validation. The proof never opens a replacement session.
This deliberately retains repeated physical reads; consolidating them is a separate slice.

### Controlled before/after measurements

Both binaries were rebuilt from the same Release tree, with only the three production files in this
slice applied/reverted. The baseline executable SHA-256 was
`edc9feacd5d58bb811478adadc799eed246b06a86cda24efe6b1a0aaaa34cfb5`; the candidate was
`cdf39c780c50a69d47fbfb8379781a67756622f4297edeb238fe38891b21cf14`.
Run the new manual measurement driver from the repository root:

```sh
python3 tests/native_cli/validation_performance.py \
  build/linux-authoring-release/tools/editor_tool/native-cli/noveltea .
```

The driver uses normal daemon routing with a unique certification broker directory, disposable
Projects, successful JSON responses, and three distinct top-level label edits. It stops the broker
and removes `.noveltea/cache` before each Project's first validation, including after synthetic
Project creation, so all rows start with a new owner. Other copied local state remains unchanged;
this is not a cold OS-page-cache measurement. Synthetic Rooms come from ordinary `entity create`,
with unique IDs/filenames and a normal Room entrypoint. Timings are wall-clock milliseconds.

| Project | Cold before → after | Unchanged before → after | Median label edit before → after | Reduction |
|---|---:|---:|---:|---:|
| Feature Lab | 3,714 → 3,522 | 16.8 → 16.9 | 1,123.8 → 946.6 | 15.8% |
| 1 Room | 112.5 → 117.3 | 11.3 → 10.8 | 26.01 → 25.96 | ~0% |
| 101 Rooms | 249.1 → 244.6 | 12.0 → 11.4 | 122.45 → 112.42 | 8.2% |
| 501 Rooms | 823.2 → 782.0 | 24.1 → 24.2 | 493.03 → 462.93 | 6.1% |

Feature Lab changed samples were `[1118.68, 1124.82, 1123.80]` before and
`[976.54, 943.87, 946.63]` after. The 501-Room samples were
`[493.03, 492.61, 493.06]` before and `[462.99, 453.42, 462.93]` after.
The 200 ms investigative budget is **not met**; size-dependent preparation remains substantial.
These small samples are local evidence, not statistical or portable CI guarantees.

An earlier non-isolated rerun after replacing the executable encountered a broker owner exit and
lost warm reuse. It is excluded from the table. The committed driver isolates broker state and
stops it on completion; do not benchmark across a rebuild using an already-running broker.

### Regression and verification evidence

- `noveltea_tooling_tests '[native-disk-validation]'`: **289 assertions, 2 cases passed**.
  The new case calls the actual native command dispatch used by public validation, including
  `includeFontCoverageInputs`, followed by its final proof. It asserts one changed record and no
  additional retained-validator admissions after a label edit or final proof. Internal
  `work.sessionAdmissions` counts this owner's admission attempts over its process lifetime;
  it is not a global counter for all CLI ProjectSession users.
- Final-proof rejection covers intervening valid/invalid record edits, added/deleted membership,
  same-size Asset byte changes with restored timestamps, pending transaction state, a source-file
  symlink escape, and an Asset-directory symlink escape even with identical target bytes.
  Existing boundary coverage also exercises invalid-source diagnostics, removal/restoration,
  unchanged contribution reuse, and release/restart behavior.
- Release `noveltea-native-cli` and Debug `noveltea_tooling_tests` built successfully. Repository-pinned
  `format-check` passed after formatting the touched test.
- `tests/native_cli/daemon_owner.py` passed against the rebuilt Release binary: relocated public
  broker, resident/local result parity, edits, invalid diagnostics, concurrency, replacement/restart.
- Existing six-stage performance certification passed: candidate standalone cold 94 ms, daemon cold
  118 ms, unchanged 12 ms, YAML-comment edit 27 ms, Lua edit 32 ms, export 84 ms. This remains a
  same-binary comparison, not the historical baseline measurement above.
- Feature Lab: **already covered**; its real Project is measured via disposable copies. No authored
  content or runtime behavior changed. Full engine/Web/Android, Electron checks, and graphical
  smoke were not run: this slice changes host CLI validation only, not runtime, build wiring, or UI.

Capture/read totals and unrelated font/shader preparation counts were not re-instrumented in this
slice. The original 11-capture profile below must not be interpreted as a post-change count.
Next: consolidate request-scoped proofs without removing external-boundary observations, then
narrow the broad preparation work. Keep this slice independently testable before pursuing either.

## Slice 2: reuse validated preparation and client resources

Public validation's clean Project validation already produces a resident, revision-pinned
diagnostic snapshot. The subsequent `prepare_complete_working()` formerly ran
`validate_project()` again before assembling compiler inputs. The public-validation owner now
opts into reusing that snapshot, if it remains valid, has the expected working revision, has no
pending physical source changes, and has no Test-specific preparation scope. It performs another
exact-content source observation before assembly and retains the existing end-of-preparation
observation. If the resident snapshot is not suitable (including legacy result-only cache reuse),
it falls back to full validation. An intervening physical change fails closed rather than treating
the previously validated snapshot as new authority. All other preparation callers keep the
original full-validation path.

The CLI client and native command dispatcher also retain their fixed 16 MiB response buffers
within their respective process/thread rather than repeatedly zero-initializing them. The
dispatcher parses only the valid returned byte range **without shrinking** its reusable buffer.
The signal/cancellation watcher retains five-millisecond polling but uses an interruptible
`stop_token` wait, avoiding an extra polling delay when a request completes. Neither optimization
changes command dispatch or response limits.

`SourceAuthority` now counts full physical source captures; the native disk-validation response
exposes the request delta as `work.sourceCaptures`, alongside the Slice 1 owner-admission count.
The native boundary regression checks a bounded number of captures for a changed Room and
requires unchanged font-coverage and Material compiler inputs across the label edit. This is
diagnostic work accounting, **not** a cache or an alternative to physical-source proof.

### Release measurements after Slice 2

Built `noveltea-native-cli` in the Linux authoring Release configuration with **no temporary
profiling instrumentation**. The same `tests/native_cli/validation_performance.py` driver used
in Slice 1 ran with normal daemon routing, disposable Projects, a fresh owner per Project, and
three distinct Room-label edits. The median is for those three changes, not cold admission.

| Project | Slice 1 median edit | Slice 2 median edit | Reduction |
|---|---:|---:|---:|
| Feature Lab | 946.6 ms | 937.65 ms | 0.9% |
| 1 Room | 25.96 ms | 19.07 ms | 26.5% |
| 101 Rooms | 112.42 ms | 106.92 ms | 4.9% |
| 501 Rooms | 462.93 ms | 429.24 ms | 7.3% |

Slice 2 cold admissions were 3548.87, 108.88, 241.71, and 771.30 ms respectively;
unchanged validations were 13.63, 5.85, 9.73, and 22.42 ms. Full changed-label samples were
`[954.22, 930.64, 937.65]`, `[20.48, 19.07, 18.46]`, `[106.92, 107.32, 105.58]`, and
`[429.24, 424.95, 442.71]` ms in the same Project order. These are local samples without
statistical error bounds; the 200 ms Feature Lab investigative budget is **still unmet**.

### Verification and remaining work

- The Debug native disk-validation boundary passed **321 assertions in 2 test cases**, including
  exact source-generation conflicts, same-size binary Asset edits with restored timestamps,
  source additions/removals, transaction state, symlink escapes, and retained-owner admission.
- The relocated public daemon-owner suite passed its mutation, disk reconciliation, concurrency,
  restart, and ownership cases. The existing six-stage native CLI performance certification passed;
  its oracle and candidate are still the same native executable, so it is not a historical speedup
  comparison.
- The pinned `format-check` passed (719 C/C++ files). Feature Lab is already covered by its
  disposable Project measurement; no runtime-authored fixture change is appropriate for host-only
  CLI preparation behavior.

Next, focus on repeated whole-Project work during each successful validation: exact source scans
across nested proof boundaries, full Project assembly, portable-source projection, localization/font
coverage collection, and Material compiler evidence. Reuse *already observed* request-scoped
source identity only when the required pre/post external-boundary proofs stay intact. Avoid
independent freshness caches, watcher-only certification, or presentation-label special cases.

### Deep current-path profile: why a one-Room edit takes ~0.94 seconds

Follow-up investigation instrumented the **Slice 2 Release binary** with temporary per-process
wall-clock and thread-CPU phase timers. The same disposable Project/daemon benchmark ran again
with three successive Room-label edits per Project. The profiler was removed after collecting
the results. Feature Lab changed-label medians were **937.56 ms** in the first instrumented run,
**933.07 ms** after deeper localization instrumentation, and **933.14 ms** with filesystem-read
breakdown; instrumentation did not materially change the ~938 ms uninstrumented result. The
CLI's synchronous `project_read` median was **901.68 ms wall / 900.23 ms thread CPU**: the work
is mostly CPU and filesystem metadata/byte processing, not blocked on slow disk I/O or daemon
startup. Ordinary daemon/process overhead accounts for the difference from end-to-end time.

The first table is a **non-overlapping decomposition** of a single changed-label CLI call.
Values are medians of three edits; numbers are approximate and separately computed medians may
not sum precisely.

| Top-level operation | Median |
|---|---:|
| Public native Project validation including compiler-input preparation | 686 ms |
| Native font coverage execution after preparation | 16 ms |
| Shader tool invocation, compiler-cache verification, and material result handling | 107 ms |
| Final retained-session exact source-generation proof | 89 ms |
| Additional CLI/daemon/process overhead | ~40 ms |

Within the **686 ms native-validation request**, nested phases were:

| Validation phase | Median |
|---|---:|
| Initial retained authority observation | 19 ms |
| `validate_clean_project` | 230 ms |
| Complete Project preparation | 60 ms |
| Portable-source preparation and notice validation | 83 ms |
| Font-input localization projection | 177 ms |
| Material/Shader request preparation | 23 ms |
| Source-generation calculation | 60 ms |
| Other work around those phases | ~34 ms |

Inside `validate_clean_project`, a **pre-validation exact proof** takes ~47 ms, actual
`validate_project` ~89 ms, and **two post-validation exact proofs** plus cache publication
~94 ms. Within that ~89 ms validation, reconciling changed records consumes ~1.7 ms, while
~44 ms constructs a complete normalized Project snapshot and ~42 ms is spent in initial/final
source observation. The semantic contributor reuse is effective; repeated whole-Project
observations and reassembly are not.

Inside **177 ms of font-input projection**, `native_project_localization_view` consumes
~133 ms and the subsequent per-locale message projection ~44 ms. The localization view
calls `validate_project` **again** (~23 ms), prepares a working view (~5 ms), iterates all
validated record snapshots to extract structured messages/usages (~54 ms), and reprocesses
script/RML text sources (~43 ms). These operations are performed even for edits that leave
most records and script sources unchanged. Material input preparation adds another ~23 ms.

Inside **83 ms of portable preparation**, `native_project_bundle` takes ~64 ms: gathering
source paths ~6.5 ms and checking/reopening/reading/hashing the portable sources ~51 ms.
This is part of public `validate`, **not an export request**. Complete preparation (~60 ms)
does another source observation at both ends of its retained-snapshot route and still assembles
the full Project. Source generation hashes every admitted source again (~47 ms per invocation).
The final proof brackets another such generation hash with two membership observations.

#### Exact physical workload, per edit

`SourceAuthority::capture` performs **12 full scans per changed-label request**.
Each scan touches **370 non-binary source files / ~1,364,378 bytes**, even though only one
Room's semantic record/contribution is rechecked. That is approximately **4,440 file reads
and 16.4 MB of rehashed source bytes per edit** from SourceAuthority alone, excluding
generation hashing, portable-source checking, compiler/source analyses, and the broker's
own authority observations. The 49 captures logged across one cold and three changed
validations performed 18,130 source-file reads.

| Work inside one source capture | Median (49 scans) |
|---|---:|
| Canonical path/containment checking | 6.85 ms |
| Reading source bytes | 3.98 ms |
| Hashing source bytes | 4.27 ms |
| Directory traversal, other checks, and bookkeeping | ~3.8 ms |
| **Total per full capture** | **18.9 ms** |

The repeated 12 captures alone account for **~227 ms** per edit. Two generation hashes
cost approximately **94 ms** more, portable-source read/hash adds **~51 ms**, and the
shader-tool call adds **~103 ms**. These are distinct operations, but do **not** add them to
the nested tables above: they are already included in the corresponding top-level phases.
The shader stage's measured time is inside `noveltea_tooling_compile_shaders_json`; it
does not establish whether cached outputs were verified or actual shaderc compilation occurred
on those requests.

Cold Feature Lab validation in the same profile took ~3.55 s. The CLI request accounted for
~1.40 s of native Project preparation, **~1.57 s of font coverage execution**, ~0.44 s of
shader processing, and ~0.09 s for the final proof. Cold font and shader work are separate
optimization opportunities; they do not explain warm label-edit scaling.

**Conclusion and recommended next experiment:** This is *not* slow YAML parsing or a missed
incremental record-validator cache. First design a request-scoped immutable source identity
and prepared data view shared by clean-validation proofs, portable preparation, localization,
and final generation checking. Retain authoritative membership and transaction/symlink
observations bracketing publication, and retain byte-exact checks (especially same-size Asset
changes with restored timestamps). Then make localization messages/usages and shader validation
dependent on their actual per-record/source fingerprints. Instrument **capture count,
source-file reads, localization record walks, shader-tool invocations, and cache-hit counts**
at the real daemon boundary before claiming savings. Do not eliminate final external-change
checking or replace it with watcher/mtime hints.

### Exact duplicate-call accounting and shader cache-hit experiment

A follow-up source-level trace established the **12 source-capture calls** for a warm,
single-Room edit. All are complete source-inventory captures, not changed-path observations:

| Caller | Captures per changed validation |
|---|---:|
| `tooling_native_project_validation.cpp::validate` initial `observe_sources` | 1 |
| `clean_validation_cache.cpp::validate_clean_project` initial `proof` | 1 |
| `room_session.cpp::validate_project` initial and final `observe_sources` | 2 |
| `clean_validation_cache.cpp::validate_clean_project` two post-validation `proof` calls | 2 |
| `preview_preparation.cpp::prepare_complete_working` pre/post observations | 2 |
| `tooling_native_project_localization.cpp::native_project_localization_view` nested `validate_project` | 1 |
| `tooling_native_project_sync.cpp::current_sources` nested `validate_project` | 1 |
| `tooling_native_project_validation.cpp::validate` final source-generation proof's pre/post observations | 2 |
| **Total** | **12** |

The two nested localization `validate_project` calls return early from semantic validation
when the resident contribution snapshot is unchanged, but still perform a full physical
`observe_sources` each. The first validates the localization view; the second comes from
`native_project_localization_sources(session)` → `current_sources(session)`. Also,
`current_sources` reconstructs every Layout's inline Lua/RML analysis directly with
`analyze_project_text`, bypassing the session's already revision-keyed
`text_analysis_cache_` for those inputs. It re-parses normalized records and builds a
fresh source/occurrence list on each invocation.

`native_project_bundle(action="test-source-preparation")` returns the whole prepared
Project, the portable source-path list, and a complete map of exact source revisions, but
public validation only checks its `ok` or failure result. No consumer uses that newly
computed revision map. Rebuilding and hashing this map nevertheless costs ~64 ms
(~51 ms in checked reads/hashes). Similarly, `native_project_source_generation` rereads
and rehashes every source **twice** per public validation—at initial generation publication
and again during the final proof (~47 ms each)—without accepting the already verified revisions
from `SourceAuthority`.

The shader tool was investigated separately using **temporary audit instrumentation**, which
was removed afterward. On two consecutive warm, label-edited disposable Feature Lab requests,
the compiler returned **90 cache hits and 0 misses** on each. Yet its tool call still cost
~103–107 ms. Within a single cached request, **48 calls to
`run_embedded_shaderc(..., true)` consumed 76.9 ms**. This is the cache-hit path in
`ShaderCompilerService::compile_source_program`:
`cache_entry_matches` → `append_output(true)` → sampler-stage reflection preprocessing.
The compiled binary is cached, but its derived reflected interface/sampler evidence is
reconstructed through embedded shaderc. The remaining tool time includes file validation,
binary reflection, request/result processing, and other compile-service operations.

**Concrete next implementation boundaries:** (1) a byte-exact request-scoped Project
observation/proof context shared across outer validation and preparation, with re-observation
at genuine external boundaries; (2) persistent normalized/localization-message contributions
by record/source revision rather than independent full-project passes; (3) shader
reflection/sampler-stage evidence cached by compiler, binary and source-dependency identity,
with corruption and same-byte-change rejection; (4) a portable-source *check-only* interface
for public `validate` that does not build unused exported revision maps. Keep adversarial race
tests in each optimization. Do not equate a shader binary cache hit with having cached the
shader's derived validation evidence.

### External CPU profiler and syscall corroboration (2026-10-29)

The Debian 12 workspace now has `perf`, `valgrind`, `strace`, and `heaptrack` installed,
with `kernel.perf_event_paranoid=1`. All measurements below were made on **temporary
Feature Lab copies** with the actual resident native CLI owner attached, not on the user
Project or a short-lived client proxy. No production-source instrumentation was added.

**Baseline under sampling:** ten successive Room-label edits with the owner observed by
`perf record -e cycles:u -F 399 -p <owner-pid> --call-graph dwarf,8192` had a **933.565 ms
median**, recording 3,474 samples. Deep DWARF-stack report generation was prohibitively slow
on this release build, so a second eight-edit run used **flat** owner CPU sampling:
`perf record -F 599 -e cycles:u -p <owner-pid>`. It recorded 3,954 samples. The top
exclusive **sampled user-CPU cycle** percentages were:

| Symbol or category | User CPU cycles |
|---|---:|
| `noveltea::authoring::exact_source_revision` | **28.17%** |
| `native_project_source_generation` itself (excluding callees) | 2.85% |
| `__memcmp_avx2_movbe` | 3.85% |
| `_int_malloc`, `_int_free`, `malloc`, `malloc_consolidate`, `cfree` combined | **~13.2%** |
| `__memmove_avx_unaligned_erms` | 2.53% |
| `shaderc::PreprocessorImpl::pushFrame`, `expand`, `run` combined | ~3.44% |

These are *self* CPU samples, not inclusive call-path attribution or guaranteed end-to-end
latency reductions. In particular, `cycles:u` excludes kernel work. Hashing is the single
largest directly identifiable hot symbol.

**System-call counts:** `strace -c -f -p <owner-pid>` over **two** successful Room-label
edits reported 147,084 `readlink`, 93,234 `newfstatat`, 17,032 `openat`, 27,942
`read`, 16,488 `close`, and 3,564 `getdents64` calls. Tracing increased validation
latency to ~3.15 seconds per edit; do not compare those timings to untraced benchmarks.
To identify path multiplicity, a second `strace -e readlink -p <owner-pid>` captured
**73,542 `readlink` calls during one label edit**, for only 475 distinct paths.
**73,541** returned `EINVAL` (the expected no-symlink result), showing that the same
non-symlink path components are checked repeatedly rather than following useful links:

| Repeated path component | `readlink` calls, one edit |
|---|---:|
| `/tmp` | 12,810 |
| Disposable Project's temporary parent directory | 12,810 |
| Disposable Project root | 12,810 |
| `.../project/records` | 9,820 |
| `.../project/records/layouts` | 2,374 |
| `.../project/records/rooms` | 1,350 |

This validates the prior timing probes: whole-source `capture()` rehashing and repeated
`std::filesystem::canonical` / containment checks are real hot-path costs. Before optimizing
paths, preserve the security requirement that source inventory changes, symlink substitution
and concurrent replacements must not be mistaken for the same admitted bytes. A safe
architecture can hold verified directory handles / safely reuse common prefixes *within
an immutable observation* and recheck at meaningful external mutation boundaries, rather
than re-resolving each root component thousands of times.

**Callgrind feasibility:** `valgrind --tool=callgrind` successfully profiled a standalone
`--no-daemon` single-Room validation and counted 635,970,416 simulated instructions, but
the current Release build (`-O3 -DNDEBUG`, no `-g`) did not provide useful C++ source-level
names to `callgrind_annotate`. Source-annotated Callgrind analysis requires a separate
symbols-enabled optimized build; the single-Room direct CLI is **not** the daemon-backed warm
Feature Lab workload. The `perf` and `strace` conclusions above do not depend on that
extra build.

**Prioritization updated by independent profiler evidence:** first collapse redundant
source-generation/source-authority byte hashing and repeated containment resolution; then
fix the verified shader cache-hit preprocessing (~76.9 ms), and introduce incremental
localization projections. Continue testing with the exact daemon-owner benchmark, especially
same-size timestamp-restored Asset edits, source additions/removals and symlink substitutions.

### Source-authority and exact-proof deduplication implementation

The native validation owner now reuses exact source evidence at **explicit,
serialized internal boundaries**. An authoritative initial observation may be
supplied to `validate_clean_project`; its `validate_project` consumes observed
revisions, and still performs a real final observation when rebuilding semantic
contributions. Successful internal localization/font-input consumers reuse the
resident semantic snapshot instead of independently reentering `validate_project`.
Complete preparation still performs a fresh post-assembly observation. Public
validation observes sources again after deriving font and Material inputs; its
final source-generation proof continues to bracket byte-exact verification with
fresh external observations.

`native_project_source_generation` has an explicit observed-at-entry mode. It
reuses exact SHA-256 identities for source bytes hashed by the immediately
preceding authoritative observation, while **always rereading and rehashing
binary Assets**. Independent callers retain physical rereads. The clean
validation proof similarly reuses fresh text-source observations while
retaining a byte-exact binary Asset comparison before and after validation,
including same-size edits with restored timestamps.

Within `SourceAuthority::capture`, the path-containment check resolves
canonical parent directories once per capture, checks leaf symlinks
individually, and rechecks each cached parent and the Project root before
publishing a capture. No verified directory prefix is trusted across captures;
watcher events remain scheduling hints, not proof.

Disposable **daemon-backed Release** benchmarks (median of three changed
Room labels for each Project):

| Project | Before | After source-proof optimization | Reduction |
|---|---:|---:|---:|
| Feature Lab | ~934 ms | **743.19 ms** | ~20% |
| 1 Room | ~19 ms | **14.94 ms** | ~21% |
| 101 Rooms | ~99 ms | **66.93 ms** | ~32% |
| 501 Rooms | ~430 ms | **282.97 ms** | ~34% |

The 200 ms Feature Lab investigative budget is **not yet met**. Full
localization/font-input projection, portable-source preparation, and cache-hit
shader preprocessing remain outside this slice.

### Incremental localization projections and shared inline analysis

After committing the exact source-authority optimization as `b23227a7`,
localization preparation was profiled and optimized independently:

- `native_project_localization_view` retains **per-record source messages,
  named usages, presentation fingerprints, and guidance fingerprints** in
  the resident Project session. A record's normalized JSON is its local
  revision. Named Message key/ID bindings, structured Message ID overrides,
  and cross-record Archetype/Trait/Variable inputs are included in the
  dependency identity, so their edits invalidate affected projections. A
  Room-label change rebuilds the changed Room contribution but reuses the
  remaining records. The final translation/freshness projection still uses
  the current target locale and current localized messages.
- Native managed-source discovery separately retains the set of registered
  inline Lua text paths for each normalized record. It does not reparse
  hundreds of unchanged records to rediscover those fields.
- Localization's inline Lua named-usage scan and Layout Lua/RML source
  extraction now reuse `ProjectSession`'s exact-text source analysis.
  Reindexing an unchanged inline source no longer discards its existing
  lexical analysis. Changed source text reanalyzes from its new exact bytes;
  RML sources not in the main Lua index have a separate exact-text cache.
- The two redundant nested `validate_project()` calls in the internal
  localization view/source-discovery path were already removed in the
  source-authority optimization; they remain bypassed only for a prior,
  same-owner validated snapshot, with a final physical-generation proof
  performed by the outer validation.

The same disposable daemon-backed Release driver reports these medians:

| Project | Source-proof baseline | Localization optimized | Reduction |
|---|---:|---:|---:|
| Feature Lab | 743.19 ms | **691.71 ms** | 6.9% |
| 1 Room | 14.94 ms | **14.17 ms** | 5.2% |
| 101 Rooms | 66.93 ms | **52.93 ms** | 20.9% |
| 501 Rooms | 282.97 ms | **209.19 ms** | 26.1% |

The benchmark includes the original source-authority improvements, and
changed-label speedups are not a substitute for correctness. Dedicated
regression coverage checks that warm localization views are byte-identical
to fresh Project views after unrelated and localization-relevant edits,
that unchanged record/source-path projections are reused, and that altered
inline Lua text receives a new lexical analysis. The 200 ms Feature Lab
investigative budget remains unmet: portable-source preparation and
shader-cache preprocessing are still independently expensive.

### Shader cache-hit sampler evidence and portable validation check-only path

The native source-program shader compiler now stores the preprocessor-derived
sampler-stage map beside each cached shader binary in
`shader-cache/manifest.json` (`samplerStageSchema: preprocessed-v1`). The
metadata proof binds that map to the compiler/source/variant cache key and the
**freshly verified binary SHA-256**; malformed, absent, or stale metadata
falls back to real shaderc preprocessing and repairs the manifest. Reflected
binary inputs, video-alpha reservations, contract validation, browser shader
payloads, and byte-exact binary-cache corruption checks retain their original
paths. A separate shader compilation regression verifies initial, cached,
and corrupted-metadata reflection equality.

The portable source collector has a separate internal
`validation-source-check` action for **public validation only**.
`project_paths()` continues to check source membership, containment, and
ordinary-file safety; the check-only path also verifies stream readability,
then returns only success/failure instead of reopening and SHA-256 hashing
every source to construct an unused Project/revision-map response. Public
validation still requires fresh exact source-generation proof after derived
work. Crucially, **`test-source-preparation` is unchanged**: the daemon
shader/runtime/package worker uses its pinned full source revisions and would
abort if it received the check-only response. Regression coverage proves both
action contracts, including missing-source rejection. During verification,
that shared-action assumption caused a reproducible owner SIGABRT; it was
diagnosed under gdb and fixed by giving the lightweight operation a distinct
action, after which relocated daemon-owner certification passed.

Disposable daemon-backed Release benchmark (three changed-label edits per
Project; numbers are local observations, not a portable performance gate):

| Project | After localization optimization | After shader + portability changes |
|---|---:|---:|
| Feature Lab | 691.71 ms | **543.39 ms** |
| 1 Room | 14.17 ms | **14.70 ms** |
| 101 Rooms | 52.93 ms | **55.18 ms** |
| 501 Rooms | 209.19 ms | **217.25 ms** |

The Feature Lab reduction is approximately **148 ms / 21%** on this slice.
The small synthetic-Project changes are within run-to-run noise; their
shader/portable workload is far smaller. The 200 ms investigative Feature
Lab goal remains unmet. Remaining work includes complete Project assembly,
JSON allocations, Material compiler request preparation, and outer protocol
overhead.

### Incremental complete Project assembly and Material request reuse

After `06f77864`, native complete-Project preparation was changed to
retain a **session-local jsoncons complete Project DOM** and exact per-owner
normalized/source-text identities. A repeated call with the identical
prepared base Project, authored overrides, and test-error policy reuses the
existing DOM; it inserts only changed validated record contributors and
removes contributors deleted from the authoritative inventory. Any changed
base/override policy reconstructs the Project, and every call still runs
the existing post-assembly physical source observation and revision proof
before publishing a complete Project. The same byte-exact record identity
also guards the Layout-specific dependency shape fixup.

The serialized complete Project and its runtime Asset-reference closure are
still recomputed, as is the physical proof. Consequently this is a targeted
reduction in **record parse and materialization** work, not a blanket skip of
all preparation. No globally shared caches or timestamp-based assumptions
were introduced. Direct disk-authoritative validation reuses the immediately
preceding validated semantic snapshot for preparation only when its working
revision matches and a fully accepted localization model is already
available. Cold/independent preparations fall back to ordinary `snapshot()`.

The public Material compiler-input projection now uses
`material_shader_program_request` on the effective Material it just
resolved, avoiding an identical second `resolve_material` traversal.
Effective Material projection and the shader compiler's physical verification
remain unchanged.

An early build exposed an invalid `WorkingPreparation` destructor after
adding fields to the public preparation structure. Those fields were
removed and the instrumentation moved into the private complete-Project
cache; Valgrind and gdb identified the invalid free, and subsequent Release
validations and daemon certification no longer reproduce it. The
new regression compares repeated assembly, a Room-label edit, and a
fresh-session complete Project, and asserts that the warm edit projects
only its changed contributor.

Disposable Release daemon-backed benchmark medians:

| Project | Prior batch | After incremental assembly |
|---|---:|---:|
| Feature Lab | 543.39 ms | **530.10 ms** |
| 1 Room | 14.70 ms | **15.34 ms** |
| 101 Rooms | 55.18 ms | **49.51 ms** |
| 501 Rooms | 217.25 ms | **206.28 ms** |

Two runs of this slice measured Feature Lab medians of **517.72 ms** and
**530.10 ms**, compared to 543.39 ms before this slice. The difference is
modest and partly subject to measurement noise; the latter measurement is
shown above because it reflects the final overlay-precedence safeguard.
The total reduction from the original ~934 ms warm-label baseline is
approximately **43%**. The broader
200 ms investigative target remains open; further JSON and allocation
profiling is warranted rather than assuming all remaining time is spent in
Project assembly.

## Measured critical path (original baseline)

Temporary `steady_clock` phase probes wrote to a separate file, not CLI stdout/stderr.
No sampling profiler was available (`perf`, `gdb`, and Valgrind were absent).
These are wall-clock boundary measurements, not CPU attribution. Probes were removed and
the Release CLI rebuilt after measurement. Instrumented total time remained close to baseline.

Median exclusive top-level phases for the three changed-label requests:

| Phase | Time | Relevant implementation |
|---|---:|---|
| Native validation request, total | 701 ms | `native_cli.cpp::project_read` |
| Font coverage execution | 17 ms | `native_font_coverage` |
| Shader/material compile path and reflection | 113 ms | `native_material_compile`, `append_material_reflection_diagnostics` |
| Final source-generation proof | 265 ms | `native_project_source_generation_is_current` |
| Final response processing | 3 ms | `project_read` |

The remaining roughly 40 ms includes outer command/daemon routing and uninstrumented request
setup; it is not precisely attributed. Independently computed medians need not sum exactly.
The shader row measures the compile/cache path; it does **not** establish that shader machine
code is regenerated on each edit.

Breakdown within the native validation request (nested, **do not add to the table above**):

| Phase | Time |
|---|---:|
| Observe retained session | 19 ms |
| Admission | ~0 ms |
| `validate_clean_project` | 232 ms |
| Complete Project preparation | 67 ms |
| Portable-source preparation and distribution notices | 86 ms |
| Font coverage input projection | 174 ms |
| Material input preparation | 24 ms |
| Source generation identity and adjacent final preparation | 62 ms |

`validate_clean_project` itself spends approximately **48 ms in pre-proof**, **88 ms in
`validate_project`**, **94 ms in two post-proofs**, and **1.2 ms publishing the cache**.
Within the changed full snapshot, localization rebuilding takes approximately 35 ms;
record/project semantic checks take approximately 2 ms, inventory checks 4 ms.
Cache serialization/write is not the significant cache-related cost.

Cold validation has an additional major cost: **font coverage execution ~1,569 ms**.
That is separate from the 174 ms font-input projection and warrants a cold-path investigation
if startup becomes the next priority.

## Actual work and causal code paths

### Incremental record reuse is working

`tooling_native_project_validation.cpp::validate` reports, on each label edit:

- warm retained session: true;
- rechecked records/contributions: **1 / 1**;
- retained records/contributions: **305 / 305**.

`ProjectSession::validate_project` recognizes presentation-only updates and does not invalidate
the Room's entire dependency closure. Replacing this mechanism is not the first optimization.

The ~16 ms unchanged request is a broker-level exact-result hit. It does not run the same
validation stack cheaply: no corresponding inner validation probe appears. See
`native_cli_daemon.cpp::owner_process` and its bracketed source observations/result publication.

### Repeated source captures, then fresh admission

Across one changed-label CLI request, `SourceAuthority::capture` runs **11 times**:

- each capture reads/hashes **370 non-binary source files**, totaling about **1.36 MB**;
- each capture also observes **25 physical Asset entries**;
- aggregate: **4,070 source reads**, **15,008,213 bytes**, **275 physical Asset observations**;
- nine captures decode no YAML, one decodes the single changed YAML, and one decodes **307 YAML
  sources** from scratch.

These counters cover this source-authority implementation only. They exclude additional reads
from generation hashes, portable-source preparation, clean-cache binary proofs, font/shader
operations, and broker-side authority. They are not total filesystem syscall counts.

The full decode is explained by
`tools/editor_tool/tooling_native_project_generation.cpp::native_project_source_generation_is_current`:
it calls **`ProjectSession::open(root, error)`**, then computes a generation hash.
Measured time is **213 ms for fresh open**, then about **48 ms for the all-source hash**, plus
cleanup/dispatch. A supposedly cheap final freshness check recreates substantial Project state.

`native_project_source_generation` also rereads/hashes every present admitted source rather
than consuming already-computed exact identities. `clean_validation_cache.cpp::exact_proof`
rehashes physical binary Assets; its caller observes all text sources before each proof.
Those correctness obligations are real, but their repeated implementation is expensive.

### Broad preparation behind `includeFontCoverageInputs`

`tooling_native_project_validation.cpp::validate` does all of the following for public validate:

1. `prepare_complete_working` (another validation call and complete Project assembly).
2. `native_project_bundle(action="test-source-preparation")`, which collects portable paths
   and rereads/hashes their bytes, even though this command is not exporting a bundle.
3. `native_font_coverage_inputs`, which calls `native_project_localization_view`.
4. That localization view calls `validate_project`, `prepare_working`, collects record snapshots
   and builds the full message/usages projection.
5. Material owner inspection/resolution, followed by the CLI shader compile/cache path.
6. Another source-generation hash, then the fresh-session final proof described above.

A Room label is not a font or shader input, but it changes the all-Project generation and exits
the broker's exact-result fast path. These broader operations lack equivalent scoped reuse.

## Recommended optimization order and acceptance constraints

1. **Remove semantic re-admission from final freshness checking.** Verify the retained authority's
   current exact source generation without constructing another mutable ProjectSession. Keep
   root containment, membership, transaction, deletion, symlink, and concurrent-change checks.
   The measured final proof offers a roughly 265 ms opportunity, not a promise of saving all of it.
2. **Consolidate request-scoped physical proofs.** Identify which nested operations consume one
   already-pinned generation and which genuinely require a new external-boundary observation.
   Eliminate redundant capture/hash passes while preserving before/after publication checks.
   Never substitute size/mtime or an unverified watcher hint for exact binary content evidence.
3. **Make validation preparation narrow.** Reuse admitted normalized records/localization inputs
   rather than rebuilding a complete Project, portable bundle projection, and localization UI view.
   Cache font/shader evidence by the actual dependency inputs; invalidate font bytes, locale/text/
   font-stack changes, shader includes, interfaces, and Material changes correctly.
4. **Then refine the remaining core passes.** Localization currently rebuilds for a label change;
   source observation and normalized-index iteration also scale with total Project size.
   These are smaller than the surrounding repeated preparation but become important afterward.

Do not implement a label-only bypass that hides these costs for one benchmark. Add work-count
regressions at the actual daemon/public-validation boundary: retained session admission count,
source captures/reads, changed contribution count, and unrelated font/shader preparation count.
Existing contribution-reuse tests alone miss this problem. Compare fresh and resident diagnostic
results across valid, invalid, removed/restored, same-size Asset changes, and source races.
Re-run both Feature Lab and independent-Room scaling after each optimization slice.

## Original investigation verification and limitations

- Reproduced the slow path with a red-capable local budget assertion; it remains slow because
  this pass deliberately makes no production behavior change.
- Rebuilt `noveltea-native-cli` in the Release tree for probes, then rebuilt after removing them.
- Ran the existing native CLI performance certification: all six stages passed.
- Feature Lab: already covers the authored behavior; only temporary copies were edited.
- No permanent test changes: this is diagnosis, not a fix. Full engine/Web/editor suites and
  graphical smoke checks were not run because no engine/editor behavior remains changed.
- Next investigation can use the named boundaries above without relying on temporary logs or
  the original chat. No reduction in freshness/correctness guarantees is authorized by this report.

## 2026-10-30 continuation: retained localization invalidation

The native CLI still exhibited project-size-dependent latency after the earlier
hashing, file-cache and YAML-cache changes. On this Linux Release host,
`tests/native_cli/validation_performance.py` measured a median of approximately
**349 ms** for one changed Feature Lab Room label and **192 ms** for a changed
label in a synthetic 501-Room Project; unchanged requests took about 16 ms
and 23 ms respectively. The driver uses disposable Projects and three distinct
label edits, with resident daemon routing.

Temporary opt-in wall-clock probes identified several distinct phases for the
changed Feature Lab request: native validation ~220 ms; outer font coverage
~17-28 ms, Material compiler/cache checks ~15-22 ms, and final source-generation
proof ~33-34 ms. Within native validation, clean Project validation cost
~65-70 ms; ~41 ms of that was `ProjectSession::snapshot()`. The snapshot's
apparent Asset-alias validation block consumed ~35 ms, but more granular probes
and an independently verified alias-cache hit demonstrated the time was spent
**before** alias checking, in `validate_working_localization()`.

Root cause: `ProjectSession::observe_sources()` revoked the entire localization
cache whenever *any* `records/` YAML changed. The subsequently refreshed
Room also called `index_text_owner()`, which reset localization again for
any source-JSON change, even a top-level `label` edit. Both paths discarded
a valid full-Project localization generation for presentation-only changes.

The targeted fix recognizes a top-level label/description-only Room/Map edit
using the retained admitted record, a newly decoded source and the **exact**
revision from `SourceAuthority`. It preserves localization and text-source
analysis only when all other decoded fields match. A malformed, missing,
inexact, or non-presentation source change continues to invalidate both.
Complete source observation and final generation proofs remain unchanged.
The normalized-reference index also skips re-reading unchanged retained
records. Work counters (`localizationRebuilds`,
`referenceIndexedRecords`) now provide deterministic regression assertions
instead of a flaky time limit.

With instrumentation still enabled, median changed-label validation decreased
from approximately **344 to 309 ms** for Feature Lab and **193 to 175 ms**
for 501 independent Rooms. The localization rebuild phase itself disappeared
from the changed-label critical path; these are small samples and should not
be treated as hard performance budgets. The cold/unchanged paths remained
approximately comparable.

After removing all timing probes and rebuilding the Release executable,
the repeat run measured **306.12 ms** for Feature Lab and **182.96 ms** for
501 Rooms, versus the initial uninstrumented baselines of approximately
**349 ms** and **192 ms**. The remaining linear growth is real; a scoped
localization fix is not sufficient by itself.

This solves **one** invalidation error, not incremental performance in general.
The broader resident path still performs complete working-Project assembly
(~24 ms on Feature Lab), portable source preparation (~33 ms), font input
projection (~29 ms), Material preparation (~22 ms), initial/final physical
observation and the outer compiler/final proof. Prioritize bounded,
dependency-keyed preparation and reducing redundant physical reads, while
continuing to reject byte-exact source races. The editor addon
patch/save/Lua stage/save timings from the handoff were not remeasured here
and remain a separate, open investigation.

### Further continuation: cached complete-Project contributor snapshots

The `prepare_complete_working` path previously called `snapshot()` on **every**
validated record on every request even when its complete-Project assembly cache
reused those contributors. It now reads cached normalized/source JSON directly
for unchanged owners, and obtains existing exact record revisions from the
clean validator's admitted revision table. A monotonic validation-generation
counter prevents stale invalidation sets from forcing another full snapshot
pass when complete preparation is requested repeatedly without revalidation.
The test seam `complete_project_snapshot_reads()` confirms a cold Project
requires full snapshots, an unchanged repeat requires **zero**, and a changed
Room label requires **one**. Cold vs warm normalized complete Project content
is compared in the native disk validation test.

The change reduces actual repeated work but is **not** an end-to-end latency
breakthrough. With Release CLI on the same host, the manual daemon benchmark
measured median **311.15 ms** for a Feature Lab Room-label edit and **179.32 ms**
for a 501-Room label edit (compared with 313.29/179.26 ms before this slice).
An added Feature Lab Layout Lua comment-edit case measured **362.94 ms**. No
hard speedup claim is warranted from these small samples. The Lua case uses
three distinct comment edits of `records/layouts/feature-lab-hud/layout.lua`
in a disposable copy, leaving source project data unchanged.

Remaining validation performs several complete physical source observations
and generation proofs and broad portable/font/material preparation. Further
reductions require tracing these bounded phases and preserving the exact
same-size/same-timestamp edit and containment-race guarantees. A per-owner
snapshot count is a regression guard, not evidence the public CLI is fast.

### Deferred intermediate observation in native public validation

`prepare_complete_working()` normally performs an authoritative post-assembly
source observation. The native public disk-validation caller additionally
performs a later authoritative observation **after** preparing font inputs,
portable source inputs, and Material compiler inputs, followed by its final
exact source-generation proof. It now requests deferred intermediate
observation; other preparation consumers retain their original immediate
observation. Any physical change during preparation still prevents the native
validation response from succeeding at the later mandatory fence.

After rebuilding the Release CLI, the median Room-label edit fell from
**311.15 to 292.40 ms** on Feature Lab; the 501-Room label edit measured
**177.07 ms** (previously 179.32 ms), and the Feature Lab Layout Lua comment
edit measured **356.70 ms** (previously 362.94 ms). The isolated gain is
small and project-dependent. The native test directly checks that deferred
preparation performs no further source capture and that a subsequent edit is
detected by an authoritative observation. Broader scaling and the editor
addon Save/patch stage remain unresolved.

### Follow-up root-cause audit: current Release, warm single-Room edit

Re-profiled the current `1d421c27` native Release CLI with short-lived opt-in
wall-clock probes in both `project_read` and the resident disk validator. The
probes have been removed; no production behavior was changed by this audit.
The benchmark remains `tests/native_cli/validation_performance.py`, running
three distinct Room-label edits in disposable Projects through the real daemon.
Measured medians: Feature Lab **291.89 ms**; Feature Lab Layout Lua comment
**343.36 ms**; 1 Room **13.17 ms**; 101 Rooms **43.85 ms**; 501 Rooms
**162.46 ms**. Small sample sizes and variance preclude hard latency budgets.

Feature Lab Room-label edit, medians in milliseconds:

| Work | Median |
| --- | ---: |
| Native Project validation plus compiler input preparation | 192.45 |
| Font coverage execution | 16.92 |
| Shader compiler/cache verification | 15.47 |
| Final source-generation proof | 32.59 |
| CLI/daemon and other overhead, by difference | ~35 |

Within the **192.45 ms** native request (non-overlapping probes):

| Work | Median ms |
| --- | ---: |
| Initial complete physical source observation | 13.86 |
| Clean validation, including its own final observation | 30.49 |
| Complete Project assembly | 9.41 |
| Portable-source path checks | 32.33 |
| Font/localization input projection | 29.49 |
| Material/compiler input projection | 22.09 |
| Final physical observation | 20.04 |
| Exact generation computation | 3.28 |
| Response bookkeeping and other native work | ~32 |

The observed source-verification multiplication is structural, not a timing
accident. On this warm path there are **five** complete `SourceAuthority`
captures: the initial observed source delta, `validate_project()`'s final
observation, the validation request's final observation, and the two observations
bracketing `source-generation-proof`. Each `SourceAuthority::capture()` traverses
the same source directories and reads/hashes **all** tracked text sources,
not merely the changed Room. Feature Lab's earlier per-capture audit counted
370 such sources (~1.36 MB) plus 25 physical Asset references, implying
roughly **1,850 redundant-or-repeated text-source reads across the five
captures**, if that inventory remains unchanged. These are physical reads, not
1,850 semantic Room validations. The authoritative daemon owner additionally
performs **two** distinct broker authority observations, each of which begins
with `owner_authority_configuration()` recursively enumerating the entire
Project and then `ProjectAuthorityManager::observe()` traversing its manifest.
On this Linux host broker evidence normally uses size/inode/mtime rather than
rehashing every file; do not conflate it with the five native byte-exact scans.

Additionally, public `validate` always requests `includeFontCoverageInputs`.
Thus a changed Room's presentation label causes an entirely new portable source
check, localization/font-input projection, Material program projection and
shader compile/cache validation. The CLI's binary shader cache hits do not
mean its derived evidence is free. For unrelated Room labels, these
authoritative inputs should be reusable under their own exact dependency keys,
with invalidation for actual localization, font, shader or Material changes.

**Root cause:** semantic record invalidation is already scoped (one Room), but
the outer **certification and source-authority pipeline is keyed to the entire
Project**. Every legitimate single-record edit misses the whole-Project exact
result cache and redoes several full-source proofs plus independently scoped
global compiler/input checks. It is wrong to call this a cold validation:
the mutable Project and its unchanged semantic contributions remain resident.

**Next required engineering work:** consolidate the native and broker authority
around request-scoped immutable source evidence with a bounded pre-/post-
publication fence; avoid re-reading the same exact text generation at every
internal boundary; build and retain independent portable path/font/localization/
Material/shader validation contributions keyed by their *actual* dependencies.
When authority is uncertain, fall back to a complete physical scan. Preserve
symlink/replacement checks, additions/deletions, same-size edits with restored
timestamps and concurrent mutations. A valid production optimization must
include an outer daemon/public-CLI work-count regression for source captures,
source reads and unrelated compiler/preparation calls—not merely
`recheckedRecords == 1`. Do not replace exact physical authority with
size/mtime-only cache hits.
