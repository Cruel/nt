# Authoring Compiler

`compileAuthoringProject` in `editor/src/shared/authoring-compiler.ts` is the sole public
current AuthoringProject to Compiled Project Format V1 compiler. It accepts an untrusted raw value, performs the
authoring-schema parse itself, and is a pure TypeScript module: it has no DOM, Electron, filesystem,
or native-addon dependency, parses a detached default-normalized copy, and does not mutate the
authored input.

`publishCompiledArtifact` in `editor/src/shared/compiled-artifact-publication.ts` is the production
publication boundary used by editor validation, preview/runtime export, package/platform export, and
the standalone project compiler. It delegates exclusively to `compileAuthoringProject` and publishes
the validated compiled object together with the exact canonical gameplay JSON. Production consumers
must not independently parse, lower, canonicalize, or serialize a compiled project.

The compiler always runs named stages: normalization, semantic validation, symbol linking, lowering,
resource collection, assembly, wire validation, and canonical serialization. During assembly it also
binds the complete runtime document to one deterministic `saveContract` identity. That identity is
derived only from state declarations and checkpoint-addressable executable structure: Property/Trait
and Inventory declarations, compiled gameplay definitions/programs, Bootstrap Module identity/source,
and referenced runtime resource identities. Project display metadata, localization text, runtime
settings, and asset/layout source details do not change the Save Contract by themselves. Diagnostics
use the closed `CompiledDiagnostic` shape with stable codes, source path, JSON pointer, deterministic
sort keys, and de-duplication. A compiled project and canonical JSON are published together only when
no error diagnostic exists.

The compiler builds complete collection and nested-ID symbol tables and runs a semantic link pass over
authored references. Before shared-definition lowering, declared Room, Character, and Interactable
records resolve their optional same-kind Archetype chain plus explicit instance overrides. Character
`initialWorldState` and Interactable `initialState` remain instance-local. Shared-definition lowering
then converts the resulting effective declared-instance configuration, identity, runtime settings,
localization, Property and Trait declarations, resources, Trait attachments, authored property assignments, and every non-program definition into `CompiledProjectSharedDraft`. Archetype records themselves are never emitted into the compiled-project wire.

Scene lowering extends that deterministic, non-publishable draft with every Scene instruction and
terminal continuation. Ordinary Scene gameplay mutation lowers through the shared Gameplay Command
compiler; Scene audiovisual/timeline orchestration and advanced gated Runtime World transactions
remain specialized Scene instructions. Room lowering keeps declarative `canEnter`/`canLeave` guards and emits the
canonical `scriptHooks` mappings used to seed the frozen Hook Registry; Room lifecycle handlers and
Compose are named Script Module exports rather than embedded effect programs or a standalone Compose
Script field. Scene comments and disabled steps are omitted; branches and choices may target only
retained executable instructions. Instruction-local Character pose/expression and Dialogue
start-block references are checked against their owning records.

Most Scene lowering remains one-to-one; the author-facing `set-variable` convenience Event is lowered
to the same compiled Gameplay Command batch used by explicit Scene mutation batches:

| Authoring step | Compiled instruction |
| --- | --- |
| `set-background` | `set-background` |
| `actor-cue` | `actor-cue` |
| `call-dialogue` | `call-dialogue` |
| `show-text` | `show-text` |
| `audio-cue` | `audio-cue` |
| `set-variable` | `gameplay-effect-batch` with one `set-global-property` command |
| `gameplay-effect-batch` | `gameplay-effect-batch` with shared Gameplay Commands |
| `run-lua` | `run-lua` |
| duration `wait` | `wait-duration` |
| input `wait` | `wait-input` |
| `conditional-branch` | `conditional-branch` |
| `choice` | `choice` with shared Gameplay Command effects |
| `set-layout` | `set-layout` |
| `transition` | `transition` |
| `comment` or a disabled step | omitted |

Specialized program lowering completes the draft. Dialogue remains a graph: Sequence, Choice, and
Redirect blocks; Line and RunLua segments; Next and Choice edges; stable IDs; conditions, shared Gameplay Command effects,
logging, show-once, safe-point, speaker, text, redirect, entry, and completion data lower directly.
Comment blocks and segments are omitted. Interaction rules retain stable IDs, named slot selector unions, pure Guards, explicit priorities, nullable Offers, and the same shared Gameplay Command vocabulary used by Dialogue and Scene mutation surfaces; authored list order is not a runtime resolver tie-break. Verb definitions retain named slots, locale-neutral `bindingOrder`, localized slot label/prompt and completed-command text, availability, and default program, but carry no Property assignments or Trait attachments. Runtime evaluates the selected Verb's local availability and resolves matching Interaction Rules by structural selector containment, Guard result, and priority. An empty unhandled result falls through to that Verb's default program, then the optional Project undefined-Interaction behavior, then the localized engine response.

Assembly also generates resident-action prediction slices from those already-lowered programs rather
than asking runtime prediction to traverse Interaction definitions. Each Interaction Rule, Verb
default, and optional Project undefined-Interaction program receives a semantic prediction point; its
program summary includes any terminal Scene, Dialogue, or Room handoff. Compiled Layouts receive
resident Layout points that carry their Layout dependency. These slices do not imply adjacency:
runtime admits them only from a Current-Room resident prediction root.

Gameplay Commands have authoritative stable authoring IDs matching the compiled contract.
The editor allocates collision-free IDs on creation and preserves them during editing and reordering;
validation rejects duplicates within each program.

Focused expected-output, malformed-input, and deterministic-order tests cover each draft boundary and
`compileAuthoringProject`. Resource closure and assembly retain every authored runtime resource in the
compiled tables because approved Lua APIs
may resolve stable IDs dynamically; the compiler also walks every typed Asset and Layout reference in
the assembled document and rejects an absent gameplay resource. Material references remain typed but
resolve through the separate authoritative shader/material manifest rather than being copied into
gameplay JSON.

`compileAuthoringProject` now strictly validates and publishes the complete wire value and canonical
JSON together. Definition/resource tables are stable-ID sorted while authored semantic sequences stay
in authored order. The checked-in corpus under
`editor/src/renderer/test/fixtures/compiled-project-golden/` contains seven exact current-format decoder inputs:
minimal, comprehensive, Trait/property/localization, resources, Scene program, Dialogue program, and Interaction program. The corpus covers every top-level definition/declaration/resource family, all specialized program discriminants, typed resource references, inline and asset-backed resource sources, every variable/property scalar type, Trait attachment/configuration, and nested stable IDs. `pnpm goldens:compiled-project` regenerates the documents from the sole compiler
API; the test suite rejects byte drift and explicitly verifies the closed decoder vocabulary.

Tests also prove editor metadata and representative authoring collection insertion order cannot affect
bytes, and that metadata-only project changes leave `saveContract` stable while executable changes
change it deterministically. Preview, playback, package export, and CLI consume the published
canonical artifact; no runtime-project adapter remains.

## Standalone Project Compilation

A saved project can be compiled without launching Electron or building the native editor tool. From
the repository root, run:

```sh
pnpm project:compile -- \
  --project path/to/project \
  --output path/to/compiled-project.json
```

The equivalent editor-package invocation is:

```sh
cd editor
pnpm project:compile -- \
  --project path/to/project \
  --output path/to/compiled-project.json
```

Paths are resolved relative to the directory where the pnpm command was invoked, including through
the repository-root forwarding target. The command opens one explicit workspace-v1 project directory
through its `project.json` manifest and writes the canonical compact gameplay bytes returned by
`publishCompiledArtifact`; it does not append a newline, build a `.ntpkg`, copy assets, compile
shaders, or perform platform export.

Use `--json` for one structured report on stdout. Human-readable compiler diagnostics are written to
stderr and preserve their severity, stable code, JSON pointer, message, and compiler stage reports.
The command publishes atomically and leaves an existing output unchanged when reading, parsing,
compilation, or publication fails.

Stable exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Help or successful compilation |
| `2` | Invalid or missing arguments |
| `3` | Input read or JSON parse failure |
| `4` | Compiler diagnostics prevented publication |
| `5` | Output conflict or output publication failure |

`editor/src/renderer/test/fixtures/project-compiler-cli/minimal-project/` is the checked-in
workspace-v1 process/CI fixture. Its output is compared byte-for-byte with the canonical minimal
compiled-project golden; normal CI never regenerates either fixture implicitly.
`pnpm goldens:compiled-project` regenerates both from the shared minimal authoring fixture.
