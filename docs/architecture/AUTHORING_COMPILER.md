# Authoring Compiler

`compileAuthoringProject` in `editor/src/shared/authoring-compiler.ts` is the sole public
AuthoringProject V2 to CompiledProject V1 boundary. It is a pure TypeScript module: it has no DOM,
Electron, filesystem, or native-addon dependency, parses a detached default-normalized copy, and
does not mutate the authored input.

The compiler always runs named stages: normalization, semantic validation, symbol linking, lowering,
resource collection, assembly, wire validation, and canonical serialization. Diagnostics use the
closed `CompiledDiagnostic` shape with stable codes, source path, JSON pointer, deterministic sort
keys, and de-duplication. A compiled project and canonical JSON are published together only when no
error diagnostic exists.

Phase 4B establishes the pipeline, complete collection/nested-ID symbol tables, and a semantic link
pass over authored references. Definition
lowering intentionally reports `COMPILER_LOWERING_PENDING_PHASE_4C` until Phase 4C supplies the
shared-definition lowerer. This safe failure prevents a partial authoritative compiled document or
an alternate consumer-specific compilation path. Preview, playback, package export, and CLI remain
on their explicitly transitional runtime-project adapter until the Phase 4G cutover.
