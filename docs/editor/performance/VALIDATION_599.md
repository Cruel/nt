# #599: resident changed-source physical proof and preparation

The native clean-validator maintains independent proof boundaries: `SourceAuthority`
pins exact authored-source revisions, external stage caches retain their own
inputs, compiled shader outputs and materialized engine includes have separate
watched SHA-256 proofs, and final publication independently fences the source
generation. A clean, resident validation may reuse the pinned revisions in
`prepare_working()` and the unchanged in-memory text analyses. An uncertain
watch or a preparation outside the validated generation falls back to direct
source reads. Unchanged shader artifacts can keep their individually watched
proofs even when another shader program is recompiled; watch loss and disk-ledger
restoration cannot authorize those proofs.

On Linux, a changed physical Asset re-arms its current inode before retiring
an obsolete watch, preserving the existing descriptor for an in-place write;
the former remove/re-add sequence could cause an unnecessary whole-Project
watcher recovery. A shader-only observed delta also preserves independently
certified localization/font inputs. Independently unchanged font inputs are
also retained for opaque audio/video Asset mutations; the binary Asset's own
content proof and portable/publication checks are not skipped. Asset-backed
Lua/RML/RCSS files are admitted as exact text revisions (rather than binary
size/mtime hints), and their inode watches cover changes through external
hard links.

For profiling, `validationWork.endToEnd` reports the full request and
`validationWork.physicalStages` reports read/hash counts, bytes, YAML parses,
and elapsed microseconds for executed stages, including session/source authority, complete
preparation, portable inputs and validation, notice inputs and validation,
fonts, Materials/shaders, source generation, deferred publication and final
publication proof. A skipped stage is absent; stage scopes are not additive to
`endToEnd`. The broker authority counters remain separately reported.

## Matched Release measurement

The raw, profiled, all-four-fixture measurements are retained as
[`validation-2026-11-02-599-before.json`](baselines/validation-2026-11-02-599-before.json)
and [`validation-2026-11-02-599-after.json`](baselines/validation-2026-11-02-599-after.json).
Both were captured on dev-lawdeep (AMD Ryzen 7 5700G) using the Release build
with native validation counters enabled, the same Feature Lab source fixture,
and `subprocess.run()` to wait for each completed public CLI request. The
benchmark harness gained an optional `--size` selector between captures; it
did not change the all-fixture scenario. Wall times are informational, never
CI thresholds. The first Lua sample is a cold downstream-stage warm-up; the
comparison below uses the subsequent two samples in each capture.

| Feature Lab warmed saved Lua edit | Before | After |
| --- | ---: | ---: |
| File-byte reads | 286 | 4 |
| File bytes read | 260,201 | 25,884 |
| Content hashes | 658 | 6 |
| Content bytes hashed | 427,286 | 149,000 |
| Median end-to-end CLI time | 166.0 ms | 74.1 ms |

The warmed single-Room-label case retains one physical read and six content
hashes on both builds. The 1-, 101- and 501-room cases also retain those same
counts; their latency differences are small and not treated as reliable
speedups. The first Lua edit after cold re-admission still executes external
font/shader work. The regular warm path no longer repeats that work for each
unchanged program or source.

## Regression coverage

`tests/native_cli/incremental_validation_certification.py` verifies scoped
Lua/RML/RCSS edits on Feature Lab and Lua edits with 1/101/501 independent
Room owners, with byte/read/hash budgets, fresh-diagnostics parity and intact
final-generation fences. `tests/native_cli/shader_validation_cache.py` verifies
nested shader include changes, unaffected program and Material reuse, bounded
artifact proof reads, and corrupted binary/engine include detection even with
restored timestamps. `tests/native_cli/dependency_mutation_certification.py`
also covers shader edits, Asset-backed shared RCSS, Lua imports and binary
Asset changes without wholesale resident readmission.
The incremental suite additionally checks that a restart after an external
hard-link font mutation restores semantic contributors without granting
unproven persisted font/shader stage reuse; an exact stage reproof is allowed
there. No new authored Feature Lab content was required: its existing Layout,
Lua, RML, RCSS, shader and Material fixtures exercise the affected validation
paths.
