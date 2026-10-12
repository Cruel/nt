# Incremental Validation: Contracts and Verification

## Ownership

`editor/src/shared/project-workspace/workspace-edit-effects.ts` classifies an
admitted edit batch once for semantic checks, localization phases, font-coverage
inputs, membership changes, and graph derivation. It also selects graph consumers
of external Asset changes. Workspace reconciliation supplies the canonical
fragment-equality proof; the classifier does not inspect live disk or publish
state. The workspace service owns source reads, revision proofs, retained
contributions, conservative dependency closure, and atomic generation promotion.

Schema-reviewed graph effects live in
`project-schema/authoring-graph-field-metadata-review.ts`. Build-time generation
checks every field and emits `authoring-graph-field-metadata.generated.ts`.
Runtime lookup indexes by schema root and depth, lazily parsing each queried
root's patterns once; it preserves wildcard matching, ordering, and structural
fallback for known parent paths without scanning the complete schema inventory
for each edited field.

## Reuse invariants

- A semantic no-op still advances the physical source revision and receives the
  normal authority proof. It does not remove retained diagnostics.
- Presentation-only record edits validate their local identity/definition and
  replace only their own graph contribution. Unknown fields, array changes,
  structural membership, and lookup rebinding retain conservative invalidation.
- Source-only edits reanalyze indexed consumers, not a preview-style reverse
  impact closure. External Asset changes augment any authored-file work in the
  same generation; they must not be lost when semantic reconciliation runs.
- Localization reference, identity/Cue, and translation checks remain separate
  contributions. CSS and demonstrably non-localizing Layout source edits can
  retain those contributions. Tracking changes can rebind Message identities
  and must invalidate coverage even when source text is unchanged.
- Failed source revalidation supplies no current revision proof. Both incremental
  overlays and full rebuilds revoke old evidence for rechecked paths that failed.
  Untouched proofs remain reusable and successful new proofs replace old ones.
- Runtime export can consume an admitted graph only with the exact Project
  identity and complete matching external-source proof. Incomplete evidence
  takes the conservative fresh-read path rather than pruning from a partial graph.

## Native stages

`editor/src/cli/validation-stage-cache.ts` owns verified shader compilation for
both validation and export. Validation batches its font/shader publication;
export uses the same operation independently. Reuse checks compiler/build
identity, compilation declarations, all files under the shader tree (including
non-`.sc` includes), standard target variants, and exact output hashes/sizes.
Forced rebuilds, pinned source overlays, custom roots and variants bypass reuse.
Reflection and target/package completeness checks remain consumer-owned.

Font coverage proves effective font revisions and exact locale requests. A
successful result without glyph diagnostics may prove unchanged **complete
Message strings**, not arbitrary recombinations of previously seen characters.
Font changes or prior glyph diagnostics require conservative checking. Cache
publication failure never fails validation.

See [export validation sharing](EXPORT_VALIDATION_SHARING_AUDIT.md) for the
additional export-specific proofs that remain intentionally separate.

## Verification

The resident workspace tests compare cold and incremental graph output,
diagnostics, and external-source evidence, including mixed edits, missing
sources, hash mismatches, tracking rebinding, and repaired lookup identities.
Metadata tests compare indexed classification with the schema reviewer for
wildcards, escaped IDs, parent paths, unknown fields, and repeated queries.
CLI/native-stage and runtime-artifact tests cover cache hits/misses, output
verification, and admitted-evidence versus cold preparation parity.

The end-to-end diagnostic/performance harness is
`editor/scripts/audit-validation-invalidation.mjs`. It copies its input to a
disposable Project, changes one file twice, measures warm validation, restores
the input, and optionally compares diagnostics against `--no-daemon` validation:

```sh
node editor/scripts/audit-validation-invalidation.mjs \
  --project tests/projects/feature-lab \
  --cli build/cli/linux/noveltea \
  --cases lua,rml,shader,record-rooms,project-name,i18n-messages,editor-whitespace \
  --parity lua,rml,shader,record-rooms,project-name,i18n-messages,editor-whitespace \
  --output /tmp/noveltea-validation-audit.json
```

CLI diagnostic parity is not a complete graph proof; in-process tests supply
that coverage. Compare timings under the same load/build/fixture and use
work-count ceilings rather than wall-clock assertions in ordinary tests.
Deterministic Runtime Package SHA-256 comparisons additionally protect complete
exported bytes during refactors.

## Simplification verification against `45b854ed`

A disposable copy of `tests/projects/feature-lab` was measured before and after
consolidating edit classification, shader orchestration, and metadata lookup.
The standalone CLI was rebuilt for each implementation. Three runs per stage
produced these median wall times:

| Stage | Before | After |
| --- | ---: | ---: |
| No-daemon validation, authoring/native-stage cache reset | 7.989 s | 8.047 s |
| Unchanged resident validation | 0.033 s | 0.033 s |
| No-daemon Runtime Package export | 13.161 s | 12.556 s |

All validation/export diagnostics matched. All six exported packages had SHA-256
`a868f5d4dd1e3023555bb31d198717b69df58d513fa5d2367d875c46faf3ca05`.
The seven-case harness command above passed cold/warm diagnostic parity before
and after, with identical semantic-check and graph-contribution counts in every
case. Warm edit times remained comparable (Lua 341→343 ms, RML 389→385 ms,
shader 852→763 ms, Project name 505→498 ms, editor whitespace 377→391 ms,
Room label 391→397 ms, Message source 1,357→1,383 ms). These small samples
establish output preservation and no material regression, not a statistical
speedup. Initial native shader build products remained available during the
validation cache resets; these are not measurements of first-ever compilation.

Earlier optimization stages, superseded findings, and individual-run timings are
preserved as [historical evidence](../../archive/reports/VALIDATION_INCREMENTAL_OPTIMIZATION_HISTORY.md),
not current requirements.
