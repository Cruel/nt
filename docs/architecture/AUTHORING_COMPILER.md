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
draft boundaries and through `compileAuthoringProject`. Phase 4F completes resource closure and
assembly. Every authored runtime resource remains in the compiled tables because approved Lua APIs
may resolve stable IDs dynamically; the compiler also walks every typed Asset and Layout reference in
the assembled document and rejects an absent gameplay resource. Material references remain typed but
resolve through the separate authoritative shader/material manifest rather than being copied into
gameplay JSON.

`compileAuthoringProject` now strictly validates and publishes the complete wire value and canonical
JSON together. Definition/resource tables are stable-ID sorted while authored semantic sequences stay
in authored order. The checked-in corpus under
`editor/src/renderer/test/fixtures/compiled-project-golden/` contains seven exact decoder inputs:
minimal, comprehensive, inheritance/property/localization, resources, Scene program, Dialogue
program, and Interaction program. The corpus covers every top-level definition/declaration/resource
family, all specialized program discriminants, typed resource references, inline and asset-backed
resource sources, every variable/property scalar type, both persistence policies, inheritance edges,
and nested stable IDs. `pnpm goldens:compiled-project` regenerates the documents from the sole compiler
API; the test suite rejects byte drift and explicitly verifies the closed decoder vocabulary.

Tests also prove editor metadata and representative authoring collection insertion order cannot affect
bytes. Preview, playback, package export, and CLI remain on their explicitly transitional
runtime-project adapter until the atomic Phase 10 cutover.
