# Native CLI incremental validation: decisions and remaining architecture

Date: 2026-10-30

Status: Four source-tracking decisions accepted; full validation-orchestration
design proposed, not yet implemented. See [measured root causes](CLI_PERFORMANCE.md).

## Accepted source-tracking decisions

1. **Use XXH3-128 for local source-revision identities.** Migrate the entire
   `sha256:` authoring-source revision contract, including YAML transactions,
   editor/native preconditions, revision validators, caches, and tests.
   Invalidate incompatible persisted evidence. Keep cryptographic hashes where
   separate external/security contracts require them. XXH3 protects against
   accidental collisions, not deliberate adversarial collisions.
2. **Use compiler-style metadata reuse during warm source observation.** Retain
   per-file identity, size, high-resolution mtime and other available metadata.
   If unchanged with healthy watcher coverage, reuse the previous bytes,
   digest and parsed source. Rehash changed or suspicious paths; watcher-reported
   paths remain suspicious even if metadata matches. This *deliberately relaxes*
   the previous ability to discover an unreported, same-size, timestamp-restored
   edit during every warm validation. Recover conservatively after watcher loss.
3. **Keep symlink safety but eliminate redundant path checks.** Allow in-root
   aliases and reject Project-root escapes, symlink cycles and replacement
   races. Prefer verified parent evidence and platform-appropriate handle-
   relative operations instead of repeatedly resolving each pathname.
4. **Reuse one resident directory inventory.** Update cached directory
   membership from watcher events and rescan affected directories on membership
   changes; perform a full directory inventory on cold admission or recovery
   from uncertainty. Directory mtime does not reflect child-file content edits.

These decisions optimize source tracking but **do not solve end-to-end warm
validation**. They supersede the earlier blanket requirement to reread and
rehash every source on each warm request. Explicit transaction CAS and
publication consistency retain appropriate independent safeguards: metadata
reuse alone is not a byte-exact proof of unchanged contents.

## Existing caches and the remaining gap

- Resident `ProjectSession` retains parsed records, reverse reference edges
  and semantic diagnostic contributions. A presentation-only Room label edit
  already rechecks **one** record and **one** contribution.
- `.noveltea/cache/authoring/native-clean-current.json` stores a whole-
  Project revision map, diagnostics and optional resident contributions. It
  does not persist independently keyed font, localization, portable, Material
  or shader validation outputs.
- The daemon caches the complete public `validate` result for an unchanged
  Project identity. A single source change misses that whole-result cache.

The changed-source path still always requests `includeFontCoverageInputs`,
assembles a complete Project, validates portable source paths, projects
localization/font inputs, prepares Material programs, runs font coverage and
shader/cache verification, and performs additional source-generation proofs.
The font/shader caches can hit without avoiding their **preparation work**.
Unrelated Room edits should not invoke those stages.

Current Release measurements for a changed Feature Lab Room label: ~289-292 ms
end-to-end; ~192 ms for native validation/preparation; ~17 ms for font
coverage execution; ~15 ms for shader/cache verification; ~33 ms for a final
generation proof. The resident validator performs **five** complete
`SourceAuthority::capture()` operations. These are measured pre-optimization
costs, not accepted performance budgets.

## Remaining architecture proposal (not yet accepted/implemented)

**A. One request-scoped source generation.** Keep one resident source ledger
containing admitted paths, metadata, revision, parsed bytes and watcher epoch.
Advance it once for each request, pin that generation and reuse it in all
native/CLI validation stages. Final publication verifies that the generation
is still current without re-opening or rebuilding all source evidence. Retry
on concurrent change or lost watcher coverage. Avoid separate broker/native
authority traversals where the same scoped evidence can be safely shared.

**B. One dependency-keyed validation ledger.** Store per-owner and per-stage
diagnostics and derived outputs with their actual input identities, rather
than keying everything to one Project revision. Link source/record changes
through the existing reverse-dependency information to affected consumers.
Stage dependencies must include portable path membership; effective
localization/message text; fonts and font stacks; Material inheritance;
shader sources/includes, interfaces, variants and compiler options.

**C. Reuse the complete public validation result incrementally.** Reassemble
the final diagnostics, including source locations, from retained contributions.
Recompute only missing/stale stages, including cached **invalid** findings.
Avoid blanket `includeFontCoverageInputs` preparation and unconditional
font/shader/compiler invocations on unrelated edits.

**D. Persist the stage ledger for cold restarts.** Extend/replace the clean
validation cache with a versioned per-path metadata/revision manifest and
independent contributor/stage results and dependency keys. Reconcile source
membership and metadata on restart, load compatible results, then recompute
invalidated stages. A cold cached restart needs distinct benchmarks from an
unchanged same-daemon result-cache hit.

**E. Separate editor and public-CLI latency.** In-memory single-Record
validation should not wait for disk authority. Saved-file CLI validation
includes dispatch and filesystem work; report both separately. Target
approximately **1-2 ms** for a simple in-memory single-owner change, pending
measured certification rather than assuming the same for an entire CLI call.

## Required evidence before declaring completion

- Assert **outer daemon/public-CLI** directory enumerations, file metadata
  reads/hashes, source captures, changed contributions, stage executions, and
  session admissions. `recheckedRecords == 1` alone is insufficient.
- An unrelated Room label edit must not rerun translation/font/shader/Material/
  portable validation. Dependency-related edits must invalidate exactly the
  consumers they affect, including transitive changes and negative findings.
- Cover added/removed/moved files, replaced symlinks, escaping/cyclic links,
  watcher uncertainty/overflow, concurrent writes, transaction CAS, stale or
  malformed caches, and same-size timestamp-restored edits both with and
  without delivered watcher notifications.
- Compare cold clean rebuild and warm/cached diagnostics for parity within
  the explicitly accepted metadata-coherency policy.
- Benchmark editor in-memory patch, warm daemon saved edit, unchanged public
  CLI hit, cached daemon restart and uncached cold start on Feature Lab and
  1/101/501 Rooms. Record both work counters and wall time.

No production implementation is claimed by this decision record.
