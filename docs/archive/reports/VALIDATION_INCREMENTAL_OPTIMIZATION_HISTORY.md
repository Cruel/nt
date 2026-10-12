# Incremental Validation Optimization History

Historical record of the original audit and successive optimization passes.
Findings and timings below describe different stages, not the current contract.
Use [Incremental Validation: Contracts and Verification](../../editor/project/VALIDATION_INCREMENTAL_AUDIT.md)
for current ownership, correctness gates, and reproduction instructions.

## External-source verification evidence across warm generations

The incremental graph analysis revalidates only sources consumed by changed
contributions. A failed check (missing/unreadable file or an Asset declared-hash
mismatch) produces a source diagnostic but no current revision proof. Before
merging successful revisions, the incremental overlay now revokes old evidence
for rechecked paths that did not verify. Unchecked sources retain their
previous proof, and newly verified sources replace their previous revisions.
The same revocation applies when a full graph rebuild imports reusable source
revisions without reusable contributions. This prevents a partial graph from
being treated as complete by runtime artifact preparation. Warm/cold
regressions cover both a hash-mismatched and a removed Asset-backed RML source
alongside a Project display-name edit, plus full-graph reuse of stale evidence.

## Follow-up: cold graph and native coverage work

The structural graph walker now collects localization derivation inputs while
extracting reference edges, eliminating a redundant recursive data walk. It
also avoids descending into primitive values and only runs cursor-specific
path expressions at candidate cursor paths. JSON-pointer escaping returns
unchanged keys directly when no escaping is required. The original
missing-Interactable-instance early-return behavior and its localization
invalidation inputs remain intact.

Native font coverage now registers each distinct effective font file once
per request (rather than once for each locale), and memoizes complete
shaping gap results by locale, ordered effective font stack, and complete
text. Diagnostic paths and message identities are still generated separately.
There is a native test comparing combined multi-locale validation with
separate requests. This is request-local reuse, not a persistent assumption
that font files or text remain unchanged.

On the cold Feature Lab fixture, dependency graph analysis decreased from
about 1.91 s to about 1.79 s; a standalone idle run measured about 8.04 s
total (baseline roughly 8.12 s after the previous semantic admission work).
Native font coverage remained about 1.67 s on this fixture, meaning its
messages/font usage provide little within-request reuse. These single-run
figures are indicative only. A heavily CPU-contended concurrent test run
gave much worse results and must not be treated as a comparative benchmark.

Remaining large opportunities: optimize actual cold TextEngine shaping
cost, reduce per-record graph-edge construction (particularly Tests and
Rooms), and measure process startup separately before changing the native
bridge lifecycle.

## Cold semantic admission: shared Lua descriptors

On initial workspace admission, the native-source descriptor inventory now
gets prepared once and passed to the per-owner Lua fallback semantic checks
before the same immutable inventory is stored on the admitted snapshot.
This avoids re-extracting each owner's descriptors during validation and
rebuilding that inventory for subsequent dependency work. The per-owner
validation contribution still tracks its owning record, preserving targeted
invalidation and diagnostics.

In a one-run cold Feature Lab comparison, total `validate --no-daemon`
measured about 8.30 s after this change versus 8.5 s previously; workspace
admission measured 3.11 s versus 3.36 s. This is a modest improvement, not
a resolution of cold validation latency. Native coverage (~2.5 s total
native), dependency construction (~1.9 s), and other semantic checks remain
substantial and need separate optimization.

The same admitted *raw* Lua descriptor inventory is also supplied to the
localization source-view extractor, avoiding another Project-wide source
registry scan. Raw descriptors are used for semantic authoring parity;
resolved workspace descriptors retain their own file-source representation.
A subsequent single cold run measured 8.12 s total and 2.86 s admission,
with localization translation validation around 176 ms. The baseline had
been around 8.5 s total and 3.36 s admission.

## Font coverage repertoire reuse (follow-up)

The native font-coverage cache now retains the exact complete message texts
from a successful check with zero glyph diagnostics. Subsequent edits with
unchanged font revisions and effective font stacks send **only changed
messages** to the native shaper, reusing successful evidence for all unchanged
messages. When there are no new or edited messages, it skips native coverage.
A changed font or a previous glyph warning conservatively requires full
validation. This does **not** skip semantic Message/placeholder validation.

The editor's per-session `LocalizationFontCoverageService` uses the same
exact-message proof for clean locale results and verifies font content identity
in addition to the logical font path. Native shaping is contextual (including
ligatures and joined scripts), so a previously seen character or grapheme set
alone is **not** sufficient evidence for an arbitrary new string. There are
focused CLI and editor regression tests for targeted edits, font changes,
and warning preservation.

On a warm workspace generation where `i18n/messages.json` is the only changed
physical source, the cached locale coverage requests can now be updated in
place for changed named Messages. This skips the Project-wide Script, Layout,
and structured-source extraction for font preparation. The updater falls
back to full preparation when Message IDs/ownership, other files, or source
authority change. A differential test compares its complete locale requests
with a cold rebuild.

The semantic `localization-translations` check now obtains its known identities
from the localization source views and tracking registry instead of rerunning
the already-separated structured ownership and Dialogue cue conflict analysis.
Those checks remain in `localization-identities`. Targeted validation tests
verify this separation.

The resident workspace also retains the admitted localization source views
across Message-only edits: provided `i18n/messages.json` is the only changed
physical source, Message membership and structured identity routing remain
stable, and prior source views exist, it replaces only edited explicit
Message views. The translation validator consumes these workspace-proven
views; it never trusts arbitrary serialized request input for reuse. Other
edits perform the original complete extraction. Cold/incremental source-view
and translation diagnostic parity are covered by a regression test.

On the Feature Lab fixture, consecutive named Message source edits improved
from ~1.69–1.71 s warm total and ~381–392 ms font preparation to ~1.34–1.37 s
warm total and ~19 ms font preparation, with ~51 ms native coverage for only
the changed message. This was a single local measurement, not a latency SLA;
further semantic contribution partitioning is still needed for consistently
subsecond meaningful text edits.

After the resident localization source-view handoff, the same local Feature
Lab fixture measured 875–922 ms warm end-to-end for named Message edits,
with translation validation down to 2–34 ms versus 443–454 ms in the prior
run. Full cold validation still takes several seconds. These measurements
include CLI/daemon and native round trips, not editor typing latency.

This reduces native invocations; it does not by itself eliminate the
Project-wide localization request preparation on edits that invalidate the
semantic source-view cache. Measure that stage separately before claiming
all meaningful Message edits meet a subsecond warm-validation budget.

Status: 2026-10-11, measured against the current dirty NovelTea checkout. This is a
performance/invalidation audit, **not** an instruction to skip checks or weaken disk authority.

## Optimization pass after the audit

The table below compares the original warm sweep with a rerun of the same Feature Lab
fixture after implementing narrowly scoped invalidation. These are individual runs,
not statistical estimates. All selected independent cold/warm diagnostic comparisons
in the rerun passed.

| Single-file edit | Original warm | Optimized warm | Graph contributions (original → optimized) |
| --- | ---: | ---: | --- |
| Shader stage comment | 3.07 s | 0.40 s | 431 → 0 |
| Layout JSON label | 2.99 s | 0.49 s | 431 → 1 |
| Room JSON label | 2.67 s | 0.50 s | 209 → 1 |
| Image payload bytes | 4.50 s | 0.41 s | 431 → 0 |
| Asset-backed RML payload bytes | 4.28 s | 0.54 s | 431 → 4 |
| Editor JSON whitespace | 1.54 s | 0.68 s | 0 → 0 |

Changes made:

- Physical Asset-only and shader-only native authority generations preserve
  unchanged semantic and dependency products; Asset-backed RML/RCSS consumers
  still reanalyze their own bytes and report fresh diagnostics.
- Asset source availability is explicitly checked by `noveltea validate` for
  every declared Asset, including cold/no-daemon validation. The previously
  reproducible missing-font diagnostic mismatch now agrees in both modes
  (validation exit 4); missing image/audio diagnostics are covered by a CLI
  test. This is an availability check, **not** a claim that all media bytes
  are fully decoded or that every content hash is rehashed on every warm run.
- Presentation-only record changes now invalidate their own graph contribution,
  not the entire preview-style reverse dependency closure. Semantically
  unchanged record JSON can reuse even that contribution.
- Layout `layout.json` enters the normal resident existing-record reconciliation
  path instead of falling back to cold Project hydration.
- Unowned `shaders/**/*.sc` sources are tracked by native physical authority
  and native compiler inputs, without treating them as semantic graph owners.
  Shader bytes are still refreshed in pinned portable Project snapshots.
- Editor-only changes no longer trigger localization validation and locale/font
  coverage input construction. Physical-only generation work counters now
  correctly report zero semantic checks instead of replaying cold counters.

Remaining targets: exact shader compilation/reflection result reuse (roughly
210–260 ms per unrelated warm validation), wider localization dependency
partitioning for RML/RCSS/Lua changes (roughly 440 ms), font preparation for
localization-related updates (roughly 400 ms), and broader root/Trait/Archetype
semantic-check invalidation. These must retain missing-target and source
content dependency parity.

## Batch A — Native stages, font inputs, and zero-change graph reuse

Follow-up optimization pass, same Feature Lab fixture. Standalone CLI validation
uses one-job disposable workers: memory-only caches would not survive between
commands. The native-stage cache therefore persists *successful* shader compilation
and font coverage results in `.noveltea/cache/authoring/native-stages.json`, with
an explicit cache schema and build/native identity. Cache publication failure does
not fail validation.

The shader cache key covers all discovered project `shaders/**/*.sc` source/include
byte hashes and the normalized compilation request. Cached compiled outputs are
accepted only while each generated binary still has its expected exact SHA-256
and size. Reflection and shader/material diagnostics are regenerated using the
current semantic Project. Failed native operations are not reused.

The font cache checks exact byte revisions of all effective referenced font
sources plus the localization coverage dependency revision. If the latter
changes, it recomputes effective locale fingerprints and may still reuse
the native result if the **SHA-256 of the effective coverage request** matches.
In particular, the cache does not persist megabytes of full locale input text;
doing so initially incurred approximately 200 ms of cross-worker transfer per
warm invocation. The compact cache requires approximately 11 ms to read.

Coverage dependency invalidation no longer advances for CSS-only Layout edits,
Layout RML with no `<nt-tr>` content, Layout Lua without `Text` calls, editor
organization, tracking/orphans/usage notes, localized Asset mapping, and
semantically unchanged relevant manifest/localization fragments. Actual RML
translatable markup and Lua Message calls still invalidate coverage.

The existing empty-set incremental graph seed is now also reached for formatting-only
`project.json`, `traits.json`, `editor.json`, and localization JSON changes,
so no graph derivation, graph assembly, or source owner analysis is performed for
those physical-only revisions.

| Edited file | Previous warm | Batch A warm | Native shader / font time |
| --- | ---: | ---: | --- |
| Lua comment | 424 ms | **187 ms** | 0 / 0 ms |
| RML comment | 1,254 ms | **680 ms** | 0 / 0 ms |
| RCSS comment | 1,296 ms | **724 ms** | 0 / 0 ms |
| Layout Lua comment | 1,322 ms | **690 ms** | 0 / 0 ms |
| Project JSON whitespace | 3,233 ms | **1,241 ms** | 0 / 0 ms |
| Traits JSON whitespace | 3,467 ms | **1,459 ms** | 0 / 0 ms |
| Editor JSON whitespace | 1,541 ms | **224 ms** | 0 / 0 ms |
| Localization policy whitespace | 3,500 ms | **693 ms** | 0 / 0 ms |
| Localization tracking whitespace | 1,563 ms | **690 ms** | 0 / 0 ms |
| Shader stage comment | 399 ms | 426 ms | ~254 / 0 ms |

The shader edit is an intentional **cache miss** and correctly recompiles;
the small additional cost comes from independent native stage input proofs.
The first six selected cold/warm diagnostic comparisons from this batch all
agreed; the subsequent six-case run (including editor and localization JSON)
also matched cold diagnostics. Timings are one-run observations, not
statistical estimates. The final run measured the shader-source cache miss
at 390 ms, consistent with the above estimate.

Remaining priority is *semantic localization validation*, which still
consumes ~440–470 ms for RML/RCSS/Layout Lua source edits, and broad semantic
checks on Project/Trait/Archetype changes. These belong to the dependency
precision and cold-start passes, not native-stage caching.

## Batch B — Semantic and graph dependency precision

The next pass targeted unnecessary validation and graph work on *already
admitted* changes. No validator was globally disabled. The implementation
compares schema-projected JSON fragments before invalidating semantic checks,
and independently retains the physical file revision and normal source
authority verification. Repaired diagnostics remain returned along with those
from unchanged checks.

Changes:

- A format-only Project, Trait, record, editor or localization JSON edit now
  reuses all existing semantic check results and graph contributions. Changed
  source revisions are still tracked; structural/membership edits do not take
  this shortcut.
- A Project display-name-only edit runs only checks that actually tracked
  `/project`, without invalidating the gameplay/locale graph.
- A record label/description-only edit executes just that record's direct
  identity/definition validators. Previously an Archetype label edit could
  reexecute ~476 semantic checks despite no underlying gameplay change.
- An additional schema-reviewed field classifier recognizes owner-only and
  graph-stable leaf changes. Unclassified/structural/source/symbol changes
  still use the conservative dependency closure.
- Localization validation is partitioned into three independently reusable
  contributions: **named-reference/font-stack**, **Message identity/Cue
  ownership**, and **translation contracts**. Changes to unrelated RML/RCSS
  without localization constructs do not run the global localization scans.
  Locale translation edits retain the independent reference and identity
  contributions. Message key rebinding and structural membership changes still
  invalidate the appropriate source and graph consumers.
- Named Message source-text changes with the same lookup key and in-place
  translation edits with unchanged Message membership now retain unrelated
  dependency graph contributions, without suppressing text/translation or
  native font/glyph checking.
- CLI physical Asset availability proof is parallelized in bounded groups of
  16 with deterministic diagnostic order. Missing and repaired registered
  Assets are still reported in both daemon and cold modes.

| Edited input | After Batch A | After Batch B | Semantic checks | Graph contributions |
| --- | ---: | ---: | ---: | ---: |
| RML comment (no `nt-tr`) | 680 ms | **194 ms** | 4 | 1 |
| RCSS comment | 724 ms | **247 ms** | 4 | 1 |
| Layout Lua comment (no `Text`) | 690 ms | **225 ms** | 4 | 1 |
| Project JSON whitespace | 1,241 ms | **276 ms** | 0 | 0 |
| Project display-name edit | ~3,260 ms (pre-Batch A) | **309 ms** | 2 | 0 |
| Traits JSON whitespace | 1,459 ms | **220 ms** | 0 | 0 |
| Archetype record label | 1,185 ms | **256 ms** | 2 | 1 |
| Room record label | 423 ms | **249 ms** | 2 | 1 |
| Image payload bytes | 367 ms | **166 ms** | 0 | 0 |
| Localization policy JSON whitespace | 693 ms | **227 ms** | 0 | 0 |
| Locale translation JSON whitespace | ~1,760 ms (pre-Batch A) | **219 ms** | 0 | 0 |
| Localization tracking JSON whitespace | 690 ms | **220 ms** | 0 | 0 |
| Named Message source edit | ~4,590 ms (pre-Batch A) | **3,370 ms** | 2 | 0 |

The last case still legitimately invokes native font coverage for changed
glyph requirements, and the present native implementation costs approximately
1.7 s. The graph changed from 218 contributions to zero on this source-only
edit. These figures are individual measurements on the same Feature Lab
fixture, not formal confidence intervals.

Eight selected end-to-end cold/warm diagnostic comparisons passed in the
initial Batch B sweep; an independent Project-display-name benchmark also
matched cold validation. In-process tests independently verify complete graph
node/edge and diagnostic parity for translated text, named Message sources,
Project renames, and changed gameplay fields. Further per-field property-based
parity and cold performance work remain useful.

Remaining performance work not claimed by Batch B: meaningful Trait definition
edits affecting effective gameplay, genuine broad Project setting changes,
localization edits introducing or changing translatable `nt-tr`/`Text`
content, and native coverage deltas. In those cases a conservative
revalidation remains preferable to incorrectly retained diagnostics.

## Reproduce

The repeatable end-to-end harness is
`editor/scripts/audit-validation-invalidation.mjs`. It copies the supplied Project to a
temporary directory, changes one file twice, measures the second warm `validate`, restores the
file, and can compare the result with an independent `--no-daemon` cold validation. It never
modifies the supplied Project. For example:

```sh
node editor/scripts/audit-validation-invalidation.mjs \
  --project /path/to/feature-lab-project \
  --cli build/cli/linux/noveltea \
  --cases lua,rml,shader,record-rooms,editor-whitespace,asset-bytes-image \
  --parity rml,shader,record-rooms,asset-bytes-image \
  --output /tmp/noveltea-validation-audit.json
```

The measured Project was the Feature Lab export fixture (601 files on disk). Cold validation
was approximately 7–8 s, with 1,222 semantic checks, 431 graph contributions, and 54 analyzed
source owners. The 37-scenario warm sweep selected representative members of all 16 record
collections, the source channels, localization fragments, and all six physical Asset kinds
present in the fixture. Nine selected cases compared complete CLI diagnostics against a fresh
cold execution; **9/9 agreed**, including source and binary Asset edits.

A separate seven-case adversarial sweep tested named Lua Message diagnostics, missing Lua,
missing RML, deleted Rooms, missing font payloads, and whitespace-only Room/Asset edits.
**6/7 matched** cold diagnostics; the missing font case did not. See the correctness issue below.

Times are representative *individual measurements*, not multi-run confidence intervals.
Recomputation counts and repeated-work identity are the more reliable signals.

## Warm recomputation matrix

| Edited input | Warm wall time | Semantic checks | Graph contributions derived (out of 431) | Major repeated work |
| --- | ---: | ---: | ---: | --- |
| Lua comment | 0.42 s | 5 | 1 | ~213 ms native shader call |
| RML comment / RCSS comment | 1.25 / 1.30 s | 5 / 5 | 1 / 1 | ~440 ms localization; ~390 ms font input preparation |
| Layout Lua comment | 1.32 s | 5 | 1 | Same localization / font preparation |
| Shader comment | 3.07 s | 2 | **431** | ~1.64 s complete graph rebuild |
| Project name / JSON whitespace | 3.26 / 3.23 s | 287 / 287 | 234 / 234 | Semantic revalidation, reverse graph closure, ~410 ms font preparation |
| Editor JSON whitespace | 1.54 s | 2 | 0 | ~445 ms localization; ~395 ms font preparation |
| Traits JSON whitespace | 3.47 s | 482 | 216 | Broad semantic and graph invalidation |
| Asset / Animation / Variable / Material record label | 2.16–2.45 s | 3–10 | 210–214 | Broad reverse graph closure |
| Archetype record label | 3.29 s | 476 | 211 | Effective gameplay/project revalidation |
| Character / Room / Interactable record label | 2.51–2.67 s | 9–23 | 209–210 | Broad reverse graph closure |
| Dialogue / Scene record label | 2.15–2.43 s | 4 | 209–211 | Broad reverse graph closure |
| Verb / Interaction / Script / Test record label | 0.50–0.69 s | 3–5 | 1–3 | Relatively good graph reuse |
| Layout record label | 2.99 s | 6 | **431** | Complete graph rebuild/fallback |
| Image / Font / Audio / Video / Data / Text Asset source bytes | 3.77–4.50 s | 3 | **431** | Entire graph rebuilt on changed physical Asset authority |
| Localization policy JSON whitespace | 3.50 s | 2 | 218 | Localization, graph reverse closure, font preparation |
| Locale translation JSON whitespace | 1.76 s | 2 | 3 | ~443 ms localization; ~590 ms graph update |
| Localized Asset mapping JSON whitespace | 1.86 s | 2 | 0 | ~443 ms localization; ~688 ms font preparation |
| Localization tracking/orphans/usage-notes whitespace | 1.56–1.58 s | 2 | 0 | ~445 ms localization; ~395 ms font preparation |
| Named Message source edit | 4.59 s | 2 | 218 | Graph reverse closure and ~1.73 s native font coverage |

Across unrelated warm edits the shader stage alone takes ~210–260 ms for native compilation
and cache interaction, plus ~4–5 ms preparation and ~7–10 ms reflection. Compiled-Project
preflight and distribution notice validation each took approximately 1–2 ms on this fixture.
Native font coverage is ~65–80 ms when its exact inputs are unchanged, but ~1.7 s when
the measured named Message source changes.

## Confirmed invalidation mechanisms and waste

### P0 correctness: cold validation accepts missing registered Asset payloads

Removing a registered font file produced a resident warm validation workspace failure
(exit code 3) but a fresh `--no-daemon validate` succeeded (exit code 0) with only the
existing unrelated hotspot informational diagnostics. Independent cold checks also succeeded
when a registered image or audio source was missing. By contrast, missing Lua and
Layout RML files produced matching failures in warm and cold validation.

Cold `ProjectWorkspaceService.open()` currently validates declared Asset source **path
syntax** using `assetSourcePaths()`, but does not require every binary Asset payload to exist.
`captureAuthoringValidationAuthorityInputs()` can reject an unsafe/incomplete input set
for cache publication without necessarily surfacing a validation diagnostic. Native font
coverage is not a substitute for checking every registered physical Asset: an unselected
font may not be read at all.

**Fix this before performance changes to external Asset authority.** Cold and warm validation
must agree on whether a referenced/registered Asset source exists and satisfies its declared
integrity contract. Add missing/restore and byte-change parity tests for image, font, audio,
video, data and source-text Assets; ensure source read/hash failures remain visible even if
no particular runtime subsystem decodes that Asset.

### A. Ordinary JSON edits use preview-style reverse graph closure

`incrementalDependencyContributionKeys()` in
`editor/src/shared/project-workspace/project-workspace-service.ts` walks
`authoringDependencyReverseImpactClosure()` from the physical file's semantic owner.
That graph closure follows reference relationships even if the changed field cannot affect
their *definition or graph edges*. A record label edit can consequently rederive hundreds of
unrelated contributions and source analyses. It should generally update the owner's
contribution, then only consumers whose derivation depends on the affected semantic
fields or lookup results. Preview invalidation and graph *derivation* are different operations.

The already-existing `authoring-graph-input-classifier.ts` has field-level graph effects,
including `none`, `source-analysis`, `symbol-definition`, and value-dependent cases.
Use the appropriate input/dependency classification in the workspace reconciliation path,
preserving conservative fallback for unknown or structural changes.

### B. Physical Asset generations lose graph reuse

`ResidentProjectWorkspaceSession.advanceAuthorityGeneration()` clones a snapshot when only
external Asset authority changes, but `ProjectWorkspaceService` associates derived graph and
source-analysis caches with **snapshot object identity** in WeakMaps. The cloned snapshot
does not inherit those products. The next `buildDependencyGraphAnalysis()` therefore performs
the entire 431-contribution build. This affects ordinary audio/video/image/font bytes, even
when they are not analyzable Lua/RML sources.

Transfer reusable graph state to the new generation, and invalidate only indexed
`source-asset` / `source-resolution-asset` consumers of the changed Asset bytes. Physical
hashes, source availability and failures must still be rechecked; retaining a previous
diagnostic result without reproving its exact inputs is not acceptable.

### C. Shader and some Layout edits fall back to full graph construction

Shader source is tracked by native Project authority but is not a graph record owner.
The generic incremental owner traversal cannot attribute an affected node for that file
and falls back to full graph construction. Unrelated authored gameplay relationships do
not depend on the contents of every shader include or stage file. Shader input validation
should use its own exact dependency closure and only touch gameplay graph contributors if
semantic Shader/Material relationships actually change.

Layout JSON label edits also produced a full 431-contribution derivation; specifically
trace the existing-source/descriptor reconciliation fallback before changing it. Do not
assume this case has exactly the same cause as shader or Asset payload changes.

### D. Localization validation has unresolved root/editor inputs

`trackInputs()` records `/` for root enumeration and `/editor` for editor-state access.
Direct in-process profile tracing confirmed that `workspace:localization` has **both**
of these unresolved paths; `workspace:editor-metadata` has `/editor`. The incremental
planner therefore includes `workspace:localization` in `state.unresolvedKeys`, and skips it
only through narrow special-case predicates. Ordinary Layout, editor metadata, and
localization bookkeeping edits reexecute the entire ~440 ms localization validator.

Resolve *why* localization's call tree enumerates the root/reads editor state. Replace
implicit whole-root input attribution with explicit, complete source/canonical locale/
message dependencies, ideally partitioning the large validator into independent contributions.
Do not simply remove `/` or `/editor` from the tracked paths without proving parity.

### E. Font-input invalidation uses Project identity, not coverage dependencies

`localizationCoverageInputsChanged()` treats most newly projected Project objects as changed
coverage inputs, except the presentation-only record special case. Whitespace-only edits to
`editor.json`, `project.json`, Layout channels, and localization bookkeeping can therefore
recompute `localizationMessageSourceViews()` and locale coverage fingerprints at a cost of
~380–400 ms. Split message text, translation, locale name, and effective font-stack inputs
from unrelated metadata; retain byte/hash authority on referenced font files.

### F. Native shader validation runs on unrelated edits

`validateCliProject()` invokes `buildShaderMaterialProject()` and
`nativeTools.compileShaders()` whenever the Project has Materials and there are no previous
blocking errors, even for a comment-only Lua change. The native compiler cache helps but
does not eliminate a ~210–260 ms call. A verified shader validation product should be
reused by exact shader source/include tree, Material declarations, compiler identity,
target variants and reflection-output dependencies, including previous diagnostics.

### G. Cold derived work remains duplicated

Cold validation's `lua-fallback-owner` checks invoke `collectAuthoringLuaSources()`
separately per owner (about 236 ms in the observed run). Localization source-message
view construction was ~260 ms after prior improvements. A cold graph build separately
performs ~450 ms source analysis and ~1.2 s contribution derivation. Interaction record
validation, the interaction resolver, effective gameplay derivation, and source projection
have overlapping parse/derived-data work. Profile shared intermediate creation before
introducing a persistent cross-run cache; reuse within one admitted snapshot is preferable.

## Proposed order and correctness gates

1. **P0 correctness:** Close the cold/daemon physical-Asset validation gap and add
   missing/repair diagnostics parity for all Asset kinds.
2. **P0 performance:** Preserve exact graph/source-analysis reuse through external Asset
   authority generations, invalidating only dependencies of changed bytes.
3. **P0:** Separate graph derivation from preview reverse-impact closure. Classify exact
   semantic field changes, and index dependencies on missing targets and symbol lookup
   identities. Test label/no-op vs changed reference, membership, and target repair.
4. **P0:** Resolve Layout JSON and shader-source full-graph fallback cases without losing
   source or include diagnostics.
5. **P0:** Partition localization semantic validation and fix root/editor unresolved
   input attribution. Verify `Text.tr`, `Text.msg`, structured text and RML ownership,
   locales, names, orphan work and cross-file error repairs.
6. **P0:** Narrow font-coverage preparation to actual message, locale, font, and Asset
   dependencies. Keep native glyph coverage checks and exact byte/hash validation.
7. **P1:** Cache exact shader compiler/reflection outcomes across unrelated validation
   generations. Never return stale compilation or warning diagnostics.
8. **P1:** Short-circuit JSON semantic no-ops after comparing normalized, admitted
   fragments, while still advancing physical revisions and safety proofs.
9. **P1:** Share cold Lua descriptor and interaction-analysis intermediate products,
   then profile cold graph derivation again.

The invariant is **full diagnostic parity with cold validation after every edit**, including
retention of unchanged diagnostics and removal of repaired ones. Work-count ceilings for
unrelated edits should accompany parity assertions; time-only tests are too flaky.
Source additions/deletions, missing-file transitions, changed Asset bytes, and
named-target appearance/disappearance must also be included.

## Limitations

The CLI benchmark currently compares returned authoring/graph/native **diagnostics**, not the
entire internal graph node/edge set. In-process resident tests separately compare exact graph
nodes and edges. The CLI's sandboxed resident worker does not surface all console-based
invalidator trace lines: in-process unit/integration execution is required to inspect them.
This audit is not yet an exhaustive field-by-field property-based parity proof and should not
be mistaken for one.
