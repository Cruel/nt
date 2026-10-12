# CLI Validate and Export: shared validation contracts

## Intent

Agent-facing `noveltea validate` must remain change-proportional and return
all diagnostics, including those retained from unchanged inputs. Runtime
Package and Platform export need additional compilation, packaging, asset,
target, signing and publication proofs. They should **reuse common validation
products**, not call the entire `validate` command and then independently
repeat its work.

## Implemented reuse

### Workspace admission

Both CLI exports already use the same Project Workspace admission service
as `validate`. The admitted diagnostics and individual validation
contributions are now passed into **both** Runtime Package and Platform
export. Previously the Platform orchestration reparsed and revalidated the
same admitted Project. The Platform evidence is supplied as an out-of-band
tool-service argument, never as user-controlled serialized request fields;
other callers still parse and validate their Projects normally.

### Runtime compilation validation

The runtime compiler applies deliberate normalization (empty editor and
Tests, runtime project identity defaults, app identity normalization).
Instead of invalidating every check under a fixed list of root paths, it
proves each admitted contribution's **actual tracked input path** is
unchanged in the normalized Project. Unresolved/root-enumerating inputs
are always rechecked. The compiler's own link, lower, wire and
serialization checks are not skipped.

### Dependency/source analysis

Runtime Package and Platform export now accept the current admitted
dependency analysis (graph plus exact external source revisions). A shared
runtime assessment consumes this graph only if **every** external source
necessary for graph completeness is represented by matching evidence:

- Required source-backed Assets must have declared SHA-256 hashes that
  match the admitted read revision.
- File-backed Script Modules and Layout script dependencies must have
  admitted read revisions.

When this proof is incomplete, the old export source-read and fresh graph
path runs. This preserves conservative Asset inclusion on missing/unreadable
sources, rather than silently pruning dependencies.

### Native shaders

Both export paths can reuse the exact native shader validation cache shared
with CLI `validate`. Reuse requires matching native identity, shader
declarations, source hashes, default three-variant target, and verified
compiled output bytes. Custom target variants, forced rebuilds, pinned
source overlays and nonstandard compiler roots bypass the cache.
Export **still** verifies the target's required shader binaries, reflected
interfaces, and package artifact completeness. No export-specific
diagnostics are taken from an unrelated `validate` result.

## Intentionally separate validation

- **Native font coverage:** agent-facing `validate` currently checks it.
  Runtime export performs localization closure/quality checks, but does not
  execute this exact native font-coverage operation. This is not duplicate
  work. Whether missing glyph coverage blocks a particular target must be
  established as a separate product policy before imposing it on export.
- **Physical Asset proof:** validate checks registered Asset availability;
  export must prove the exact included payload revisions and package
  publication. A checked declaration is not proof that a later packaged
  file is unchanged. The existing native/pinned Asset proofs remain.
- **Distribution notices:** already use the same notice collector.
  Validation checks declarations while export requires notices for the
  actual included Asset closure. Their scope-specific final verification
  remains essential.
- **Platform-only constraints:** template provenance/compatibility, icons,
  output collisions, signing, player staging, certification and publication
  remain in Platform orchestration.

## Verification

Tests cover a trusted Platform admission handoff versus mismatched Project
identity, compile cache hits and misses (source revision/variant/force),
runtime output and diagnostics parity under admitted validation products,
and source-graph reuse with a deliberately failing source reader. A missing
source-read revision separately proves the cold graph fallback is exercised.

Follow-on optimization opportunities: move the general shader compile/reuse
orchestrator out of the CLI package for editor-host reuse; profile export
stages using the fixture after these changes; consider a shared memoized
verified-file product if packaging can prove identity without rereading
those bytes. Such changes must not relax final packaged-byte checks.

## Correctness hardening

- Admitted graph reuse additionally requires identity with the exact
  admitted Project object, not only a graph and external source revision map.
  A stale or cloned Project causes the existing conservative fresh source
  analysis to run. Workspace admission and the graph are bound together in
  the internal trusted export handoff; request JSON cannot set this evidence.
- Runtime normalization contribution matching now uses a dedicated
  `authoring-validation-input-equivalence` utility instead of private export
  path traversal. It compares concrete tracked inputs conservatively,
  including path presence, record removal, array order and unknown/root
  dependencies. These checks have independent regression tests.
- Export parity testing compares runtime compiled Project values,
  diagnostic sets and complete prepared package options with and without
  admitted evidence; source-backed packaging additionally checks the reused
  graph against the cold source-read path and proves the fallback for missing
  revisions or mismatched Project identity.
