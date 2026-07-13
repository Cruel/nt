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
pass over authored references. Phase 4C lowers identity, runtime settings, localization, declarations,
resources, inheritance edges, authored property assignments, and every non-program definition into
`CompiledProjectSharedDraft`.

Phase 4D extends that deterministic, non-publishable draft with every Scene instruction and terminal
continuation plus the four ordered Room lifecycle hook programs. Scene comments and disabled steps
are omitted; branches and choices may target only retained executable instructions. Instruction-local
Character pose/expression and Dialogue start-block references are checked against their owning
records. Room hooks preserve before-enter, after-enter, before-leave, and after-leave ownership and
authored effect order, including empty programs.

The Scene lowering is one-to-one:

| Authoring step | Compiled instruction |
| --- | --- |
| `set-background` | `set-background` |
| `actor-cue` | `actor-cue` |
| `call-dialogue` | `call-dialogue` |
| `show-text` | `show-text` |
| `audio-cue` | `audio-cue` |
| `set-variable` | `set-variable` |
| `run-lua` | `run-lua` |
| duration `wait` | `wait-duration` |
| input `wait` | `wait-input` |
| `conditional-branch` | `conditional-branch` |
| `choice` | `choice` |
| `set-layout` | `set-layout` |
| `transition` | `transition` |
| `comment` or a disabled step | omitted |

Phase 4E completes specialized program lowering. Dialogue remains a graph: Sequence, Choice, and
Redirect blocks; Line and RunLua segments; Next and Choice edges; stable IDs; conditions, effects,
logging, show-once, safe-point, speaker, text, redirect, entry, and completion data lower directly.
Comment blocks and segments are omitted. Interaction rules retain authored order, exact or wildcard
operands, typed contexts, and all six closed instruction variants. Verb definitions retain their
`extends` edge, own availability condition, and own default program so the runtime can evaluate
availability root-to-child and attempt default programs child-to-root without flattening either
chain.

Interaction instructions now have authoritative stable authoring IDs matching the compiled contract.
The editor allocates collision-free IDs on creation and preserves them during editing and reordering;
validation rejects duplicates within each program.

Phase 4D and 4E use focused expected-output, malformed-input, and deterministic-order tests at their
draft boundaries and through `compileAuthoringProject`. The checked-in minimal, comprehensive, and
edge-case canonical wire corpus remains owned by Phase 4F, because only that slice performs resource
closure, final assembly, strict wire validation, and canonical serialization. Earlier program slices
must not establish competing partial-wire golden formats.

The complete-program draft deliberately remains unpublished until Phase 4F performs resource closure,
final assembly, strict wire validation, and canonical serialization. `compileAuthoringProject`
therefore reports `COMPILER_FINAL_ASSEMBLY_PENDING_PHASE_4F`; it does not fabricate final assembly or
publish partial gameplay JSON. Preview, playback, package export, and CLI remain on their explicitly
transitional runtime-project adapter until the Phase 4G cutover.
