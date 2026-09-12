# First-Class Game Localization Alignment Certification

Certification date: 2026-09-12.

Certification status: **aligned for the #175 localization scope**. The current repository is aligned
across canonical Message ownership, translation workflow, locale metadata and font validation, CLDR
realization, export/package partitioning, runtime locale switching, localized Asset selection, and
future exchange integration. Active localized **video** replacement is explicitly delegated to the
separate video-playback feature and is outside this certification; the shared locale-media generation
seam remains ready for that work without requiring another localization lifecycle.

## Canonical authoring storage

Localization remains one logical `/localization` Project Workspace save unit but is no longer one
physical `localization.json` document. Git-facing source is partitioned under `i18n/`:

- `i18n/project.json` owns Source/Default locale policy, locale definitions, and the managed Source-locale lock;
- `i18n/messages.json` owns explicit/named Message records and structured identity overrides;
- `i18n/usage-notes.json` owns occurrence-specific translator guidance separately from derived
  `Used in` locations;
- `i18n/tracking.json` owns managed Lua/RML source-family tracking;
- `i18n/orphans.json` owns disappeared source work retained for reconciliation;
- `i18n/locales/<locale>.json` owns sparse target Message work;
- `i18n/assets/<locale>.json` owns sparse localized Asset work.

The workspace service assembles those fragments into the current in-memory `AuthoringLocalization`
contract and projects mutations back to deterministic physical chunks in one normal Project Workspace
transaction. Empty locale chunks are removed rather than retained as placeholder catalogs. Passive
validation/source watching remains read-only.

Canonical locale IDs are validated as canonical BCP 47 tags at the authoring-schema boundary, so
editor, CLI, direct-file, and agent edits receive the same validation. Once substantive target
translation or localized-Asset work exists, the authoring parser materializes `sourceLocaleLock` to
the current Source locale; subsequent file-first changes to `sourceLocale` that disagree with that
lock are rejected. Locale definitions support a Project display-name override independently of the
native locale name and font stack.

## Translation workflow and guidance

The Localization workspace exposes target-locale filters for Missing, Outdated, Needs review, AI,
Reviewed, Current, and Attention. Bulk review operates transactionally over the filtered work queue
and uses the same structural Project validation as individual review, so stale or invalid targets
cannot be promoted to Reviewed through a weaker editor-only path.

Message Context and Translator note remain Message-level guidance. Occurrence-specific Usage notes are
persisted independently from automatically derived `Used in` paths. Free-form named Lua/RML usages use
content/anchor-based semantic usage identities rather than byte offsets, so unrelated prefix edits do
not detach their notes. Demotion transfers an occurrence note onto the resulting local Message
identity, while promotion/merge remaps a local note onto the resulting named usage when that usage is
unambiguous. Local and named usages can therefore carry guidance without abusing source locations as
translator prose.

The vendor-neutral localization exchange seam operates on the canonical localization workflow Message
set rather than only explicit Message records. It therefore exposes structured and managed local
Messages by stable Message identity as well as named Messages. Exchange adapters do not own Message
identity, Project persistence, reconciliation, freshness, review policy, or canonical storage; future
XLIFF/TMS integrations remain adapters over the NovelTea model.

## Compiled locale semantics

Each compiled locale carries the presentation/runtime metadata required to realize language options
without a native hard-coded language-name table:

- canonical locale tag;
- native display name plus optional Project display-name override;
- RTL/LTR direction;
- locale font stack;
- CLDR cardinal categories and compiled cardinal rule program;
- locale number-format metadata including decimal/group separators, primary/secondary grouping widths,
  and digit strings;
- optional detached runtime-catalog package path.

The compiler obtains display/number metadata from the build host's standards-backed `Intl` APIs.
Unicode CLDR cardinal rules are vendored as declarative data under the Unicode-3.0 license and lowered
into a compact condition program; no ICU or new shipped C++ localization dependency is linked into a
player.

`MessageRealizer` evaluates that compiled rule program natively. Cardinal selection no longer branches
on a fixed C++ language list, and number punctuation/grouping no longer branches on hand-written
French/German/etc. cases. The conformance test compares NovelTea's vendored rule evaluator with
`Intl.PluralRules` over representative rule families, integer values, fractional values, large values,
and regional behavior such as `pt-PT`.

The built-in language selector consumes each option's own compiled display name, direction, and font
families, rather than rendering all choices with the currently active locale typography.

Font coverage validation uses the same native `TextEngine` shaping/fallback machinery as runtime text
rather than a code-point approximation. Editor Project validation and `noveltea validate` send each
locale's effective Message text, native/display locale names, Project font stack, and safe system
fallback through the native text-tooling path embedded in the `noveltea` CLI. `noveltea validate` runs the check automatically, while the editor uses the private `noveltea __editor-native font-coverage` operation with per-locale caching. Unresolved shaped clusters are attributed
to locale, stable Message/source path, offending cluster, and effective font stack; Supported locales
produce errors while work-in-progress locales produce warnings. The editor validator caches results
per locale using effective target text plus font-asset content hashes, so unchanged locales reuse their
coverage result while changed translations or font bytes invalidate only the affected locale.

## Runtime package residency and switching

Multilingual runtime packages no longer require every Message catalog to remain resident inside
`CompiledProject::Localization`. Export leaves Source plus the startup/default catalog in `game` and
writes other selected catalogs as deterministic `localization/<locale>.json` package entries. Locale
definitions carry the entry path needed for demand loading.

Package startup validates detached catalogs against Source Message contracts without retaining them all
simultaneously. Locale negotiation may select a persisted preference such as `es-MX -> es`; startup
then retains Source plus that negotiated active catalog. Locale switching loads and validates the
candidate catalog before visible semantic commit, transiently permits the old/candidate pair, and
collapses back to Source plus active after success or failure. Text, fonts, current visual resources,
and normal runtime publication retain the existing atomic locale-change boundary.

Localized streaming audio replacement remains post-commit and generation-aware. The presentation
bridge also publishes the same monotonically increasing locale-media generation through a
supplemental streaming-media hook. A future video backend can therefore join the existing transaction
without creating a second localization lifecycle.

## Delegated video integration

Active localized video replacement is owned by the separately planned video-playback feature rather
than this localization alignment pass. This certification therefore makes no claim about video seek,
replacement, or playback-progress behavior. Localized video Assets compile/export normally and the
locale transaction exposes the same post-commit streaming-media generation used by audio, so the video
feature can bind to the existing localization seam when its real playback backend lands.

## Verification

The following verification was completed against this alignment work:

| Check | Result |
| --- | --- |
| `pnpm -C editor run check` | PASS: formatting, lint with denied warnings, TypeScript, and schema-version policy. |
| `pnpm -C editor run test` | PASS: 247 files passed, 2 skipped; 1,922 tests passed, 5 skipped. |
| CLDR cardinal conformance | PASS across 35 representative locale families against `Intl.PluralRules`, including integer, fractional, large-number, and regional samples. |
| Linux full build | PASS: `cmake --build --preset linux-debug`, including the `noveltea` native text-tooling path and `noveltea-tooling-bridge`. |
| Domain/content/runtime/presentation native binaries | PASS. |
| Asset native binary | PASS: 220 cases, 4,671 assertions. |
| Host native binary | PASS: 120 cases, 2,171 assertions. |
| Script Lua, UI, and UI-backend native binaries | PASS after current locale-metadata fixture expectations were updated. |
| Asset telemetry/render/text/tween and RmlUi patch binaries | PASS. |
| Runtime package focused suite | PASS: 11/11 package/export/startup tests. |
| Locale streaming-media transition tests | PASS, including shared supplemental-media generation. |
| Native font coverage | PASS: real `TextEngine` shaping reports unresolved clusters with locale/Message/font-stack attribution; `noveltea validate` invokes it and the private editor-native operation exposes the same implementation; focused cache/request tests pass. |
| Production CLI build | PASS: release-mode `noveltea` contains the native font-coverage operation and stages the system fallback font under `build/cli/linux/assets/system/`. |

A monolithic `ctest` invocation does not finish inside the available five-minute tool execution window,
so the compiled Catch2 binaries were run directly to avoid CTest's per-test-process overhead. The
readback capture tests remain environment-dependent on an available X11 display, as in prior
repository verification.

`cmake --build build/linux-debug --target cxx-policy` passes after bringing the RmlUi dynamic-fallback patch test under the same runtime compiler policy as the other first-party tests. The aggregate verifies runtime, dependency, JSON-boundary, module-boundary, schema-version, and public-header policy gates without a localization-specific suppression.

## Schema/version policy

No authoring workspace, Compiled Project, save-state, or player-runtime version was advanced for this
pre-release convergence. No dual reader/writer, legacy `localization.json` compatibility path, locale
alias reader, or alternate Message realization implementation was introduced. Current-only strict
wire fixtures were migrated to the expanded locale metadata contract instead of weakening native
validation.
