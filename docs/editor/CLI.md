# NovelTea CLI

> **Current architecture (#551):** The installed `noveltea` CLI is a direct
> C++ executable. ScriptC, QuickJS, the embedded TypeScript island, and the
> scripting host/FFI bridge have been retired. The editor still uses TypeScript
> and build-time Zod schemas; authoring, broker owners and disposable CLI
> workers execute native commands. Sections below describing the earlier
> ScriptC runtime, the unshipped native *candidate* or pre-#551 gates are
> historical design and certification records, not current build instructions.

NovelTea ships one public headless executable: `noveltea`. It is a natively
compiled C++ binary including Project authoring, daemon, shader, package,
platform, Agent Kit, ComfyUI and Test command families. The editor invokes
this installed binary for headless operations. The old
`noveltea-editor-tool`, ScriptC host and separately distributed bgfx
`shaderc` executable are retired.

## Current direct-C++ release and verification (#551)

Use `pnpm -C editor run noveltea:build` to build the native CLI for the
host, producing `build/cli/linux/noveltea`, `build/cli/windows/noveltea.exe`
or `build/cli/macos/noveltea`. The binary includes its UI Test runner, assets,
private FFmpeg tools and an SHA-256 build proof. Installed production checks
run through `pnpm -C editor run noveltea:certify`, including relocation,
CLI JSON/exit-code goldens, daemon/worker lifecycle, ComfyUI, platform,
package, and cross-system authoring assertions. Electron emitted-module
provenance is checked separately. The Node `noveltea-native.ts` entrypoint
is a development-only forwarder to an installed, authenticated C++ binary.
Neither the public CLI nor resident workers require Node at runtime.
Editor-only native tooling calls use the same installed executable through
the private `__editor-native <operation>` entry point: bounded JSON stdin,
native operation dispatch and JSON stdout. This is not part of the 39-path
public CLI inventory and does not start a ScriptC host or JavaScript runtime.

The next section is a historical record of the earlier C++ candidate, not
an alternate or supported release path.

## Direct C++ executable candidate (#542, #543)

### Cold compiled Project parity oracle (#552)

The unshipped C++ compiler is intentionally **partial**. Its standalone Linux
verification target compares native-admitted Project generations against a
separately executed TypeScript compiled-Project reference, rather than reading
`artifact.json` or other warmed ScriptC runtime-cache output:

```sh
cmake --build --preset linux-debug --target noveltea-runtime-cache-publish-certify
ctest --test-dir build/linux-debug -R '^native_compiled_project_parity$' --output-on-failure
# Or run the comparison directly (including per-family reports):
python3 tests/native_cli/compiled_project_parity.py \
  build/linux-debug/tools/editor_tool/noveltea-runtime-cache-publish-certify .
```

The harness copies Feature Lab **without** `.noveltea` artifacts and creates
focused small Project fixtures through the existing native Project/Entity
commands. It exercises native admission and native source-generation/revision
capture, including physical Asset source authority, Unicode labels, sorted
global Variables, missing entrypoints, and deterministically ordered invalid
Asset diagnostics. The reference process accepts *only* the admitted normalized
Project JSON over stdin and invokes
`compileAuthoringProjectValue`; it cannot reopen Project files or inspect
runtime cache. The C++ executable similarly uses the existing native Project
owner (`shader-preparation`) and the candidate lowering functions, without a
TypeScript process or fallback. Project source revisions include external
Asset source authority as captured by the native portable collector. Mismatch
reports contain a JSON pointer and owning family, including ordered-array
positions. Canonical Save Contract parity is certified independently by the
C++ hash projector against the reference compiler's computed value. The full
reference value is also admitted by the existing strict C++ Compiled Project
decoder; malformed wire must fail this independent native verifier.

**Mandatory parity in #552's original acceptance:** Project identity, bootstrap, entrypoint,
static Assets/Animations/Scripts and ordinary global Variables; Message Variables were explicitly
unresolved. **With #553, native Message IDs, Message-valued globals, source and translated Message
catalog entries, and managed inline Lua lowering are additional mandatory comparisons.**
**Still not implemented:** gameplay definitions, Layout/material resources, locale presentation
metadata and CLDR formatting, Traits, Archetypes as compiled gameplay definitions, Inventories,
Interactable Instances, Flow Prediction and native assembly of the final Save Contract.
Native archetype resolution used for Message identity does not constitute compiled gameplay
Archetype lowering. The cold suite is a Linux-native
verification target, independent of whether the production ScriptC cache is
present, and future compiler tickets must promote new families from the
unimplemented list into mandatory comparison. This test changes neither the
shipped ScriptC CLI nor the separate #545 platform export.

Linux verification on 2026-10-25: three cold supported-family cases passed
(Feature Lab, Unicode label, sorted Variable ordering); the missing-entrypoint
and invalid-Asset cases were rejected with owning-path diagnostics; two invalid
Asset paths remained in canonical order. The Feature Lab reference retained its
unresolved global Message identity, all three native Save Contract hash
projections matched the separately compiled reference, and the C++ decoder
admitted each full reference Compiled Project while rejecting malformed wire at
`/schemaVersion`.
The registered `native_runtime_cache_publish` and `native_compiled_project_parity`
CTest targets both passed (2/2) after a successful fresh `linux-debug` build of
`noveltea-runtime-cache-publish-certify`, using the otherwise-unset
`CMAKE_BUILD_PARALLEL_LEVEL=6` for bounded native compilation. Both registered
tests were run against the resulting CMake-built executable, not a manually
linked test substitute.
`pnpm -C editor run check` passed; `pnpm -C editor run test` passed with
2,221 tests passing and 133 pre-existing skips.

### Native Message and managed Lua projection (#553)

`native_authoring_messages.cpp` consumes only the C++ owner's normalized Project generation.
It inventories schema-owned structured text by semantic path, applies preserved
`structuredMessageIds`, resolves effective Archetype/instance content through the native
authoring semantic resolver, and combines named, structured, inline RML and managed Lua
sources before assigning deterministic package-local Message IDs. Settings Messages follow
other Messages; system Messages retain their reserved IDs. A single mapping lowers both
`$message` Property defaults and gameplay text references. Locale catalogs honor source
messages, translated values, parent-locale inheritance, typed arguments, nested selector
patterns and dialogue cue contracts. RML-local source placeholders carry the same compiled
argument contracts as structured text. Selector case ordering is canonical Unicode
scalar-value order (UTF-8 byte order) in both native and TypeScript lowering, not
environment-dependent locale collation. Inline managed `Text.tr`, `Text.msg`, `Text.plural`,
and `Text.select` Lua calls use the native lexical source analyzer and tracked source
identity, then lower to numeric `Text.__message` calls without executing or transpiling Lua.
Unrelated sources and the authoring Project on disk are not modified.

The differential acceptance is still `native_compiled_project_parity`: the test-only
TypeScript reference independently compiles the *same admitted value* and rejects
different Message IDs, catalog entries, rewritten Lua sources and Property defaults at
an owning JSON pointer. It is never invoked by production native CLI code. The Feature Lab
witness includes named Messages, plural/select patterns, RML-local text, inline managed
Lua, translated catalogs and the global `story-message` default. The partial candidate is
**not** a complete Compiled Project and must not publish a runtime cache based on this
projection alone. Subsequent shared and program lowerers (#554–#556) now cover
Room, Scene, Dialogue, Interaction and Verb programs, including their canonical
Command, Condition and Message references. The cold parity suite substitutes
these native gameplay families into a reference-compiled runtime document,
checks exact wire parity and executes representative Dialogue and Interaction
flows with the real runtime executor. Runtime locale metadata, Flow Prediction,
native assembly, and complete runtime cache/package preparation remain
separate work (#557 onward).

The native runtime-cache publisher requires preparation-time runtime and Test input
metadata snapshots. It refuses to certify previously compiled gameplay or a previously
lowered Test catalog against files that changed before publication began; its final
recheck still rejects changes during publication. The native CLI's catalog refresh uses
the cache probe's verified gameplay snapshot and obtains Test source metadata from its
admitted source generation. Publication failure is a reported cache-maintenance failure,
not a falsified Test execution verdict.

### Candidate executable status

`noveltea-native-cli` is an **unshipped** CMake target producing
`tools/editor_tool/native-cli/noveltea` under the build directory. Testing builds
include it by default; otherwise it requires an explicit target build. It does not
replace the ScriptC production CLI. Its entrypoint and command execution are
C++, with no QuickJS runtime, ScriptC compiler, Node launcher, or JavaScript
fallback. It reuses `noveltea_tooling_native`'s existing Project authority;
there is no second Project engine or daemon.

The candidate implements public global parsing, help/version, JSON protocol V1,
human diagnostics, Project selection/upward discovery, and direct native Project
commands: `validate`, `fmt`, `project create/import/export`, `entity create/inspect/rename/delete`,
`usages`, `asset audit/import`, and `localization sync/view/reconcile/accept/review`.
The mutation paths reuse native Project plans, exact revisions, source generation
proofs, comment impacts, safe filesystem transactions, and no-op detection. Reconciliation
requires explicit stdin decisions and expected workspace/fingerprint identity.
Validation checks the compiler entrypoint directly from its admitted native
Project generation, then checks localization font coverage, portable source
inventory, physical distribution-notice text, and native shader/material
compilation and reflected-interface validation. Shader requests are deduplicated
by complete program identity; reflected results are attributed back to each
Material. The candidate stages the trusted system font assets next to its
binary, matching installed font coverage resolution without source-checkout
paths. Compiler failure logs cannot escape onto the CLI's JSON stdout.
The unshipped standalone candidate also routes `shaders compile` through C++
Project/Material admission and the linked native shader compiler, using pinned
shader source overlays, variant/rebuild options, source-generation proofs,
and native reflected-interface checks. Raw `shaderc` and `texturec` forward
arguments to their linked native compilers without a JSON wrapper.
The direct C++ candidate also handles all four `test` invocation forms
against a verified current canonical runtime cache. It uses the verified Test
catalog where available and **rebuilds stale/missing authored Test catalogs**
from a native-admitted Project generation without invoking TypeScript. The
C++ catalog projection covers typed playback inputs, expectations, native
blocked-Test diagnostics, and UI runner selection. Rebuilt Test catalogs can
be published as a fresh canonical runtime-cache generation by the native
writer. The writer verifies the compiled gameplay via the engine decoder,
requires self-contained physical Asset sources, captures Project/Test input
metadata and checks discovery membership, rejects source drift, and updates
the active generation pointer only after durable artifact/manifest writes.
Single/suite/UI runners
read stdin playback specs and recheck both runtime and Test input source
generations before and after execution. The runtime compiler identity
must match the CMake-bound build identity; dirty-tree builds leave it unbound
unless a release builder supplies an explicitly pinned identity. Compiled
runtime cache misses and unbound identities fail explicitly without running
ScriptC.
The relocated candidate carries the native UI Test runner beside the binary.
The unshipped C++ `package export` candidate can likewise consume a verified
canonical compiled-runtime cache at its original Project root and invoke the
linked native package writer. It checks the requested profile, rejects
cache-incompatible export overrides, requires explicit acknowledgement of
localization warnings, rejects external/symlinked physical package sources,
and stages output before an atomic replacement. A relocated or stale cache
cannot publish the old Project's physical sources.
This remains an **unshipped candidate**, not a replacement for production
ScriptC: native authoring-to-gameplay lowering is currently incomplete. A
nonpublishable C++ partial compiler covers static Asset/Animation/Script
resources, Project identity, entrypoints, bootstrap references, and ordinary
global Variables; localized Message Variables and the remaining gameplay
definitions/programs are not yet lowered. The native Save Contract projection
has a separate canonical-hash certification. Cold compiled-gameplay creation,
uncached Runtime Package assembly, and full cache-rebuild recovery still
require native implementations in #544. The final cutover needs their certification
before public CLI replacement.
Help and collection names
are embedded from the canonical TypeScript declarations by CMake; no TypeScript
executes during this build. Inspection is local in this slice, both with and
without `--no-daemon` (including `NOVELTEA_NO_DAEMON=1`); native resident command
execution is future work using the existing broker, not a new daemon.
Unknown paths return usage exit 2. Recognized but unimplemented public paths
fail closed with `CLI_NATIVE_CANDIDATE_UNCLAIMED` / exit 70. Full help remains
the public completeness contract, **not a claim that this slice implements it**.

Build and exercise the relocated executable without invoking the production
CLI for shader generation:

```sh
cmake --preset linux-debug -DNOVELTEA_COMPILE_SHADERS=OFF \
  -DNOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS=OFF
cmake --build --preset linux-debug --target noveltea-native-cli
ctest --test-dir build/linux-debug -R '^native_cli_public_contract$' --output-on-failure
# Optional independent comparison with the installed production CLI:
python3 tests/native_cli/contract.py \
  build/linux-debug/tools/editor_tool/native-cli/noveltea . build/cli/linux/noveltea
node editor/scripts/certify-native-cli-inventory.mjs
```

The executable-seam test copies the binary and its required system fonts to a
temporary installation, removes external tools from `PATH`, and exercises static contracts, usage errors,
Project inspection/provenance, validation, physical mutation dry-runs and commits,
create/import/export roundtrips, missing/invalid distribution notices,
font-coverage failures, invalid shader programs, reflected Material orphan
warnings, malformed-source recovery and unsupported workspace
rejection. The existing **39 public paths / 28 native Project actions** inventory
remains the complete cutover gate; this focused test does not replace it. The
inventory now names the post-#521 owners and current editor IPC witnesses.
#522/#506/#474 and the final ScriptC/QuickJS retirement remain separate acceptance
work. Feature Lab already supplies the real inspection fixture; this candidate adds
no authorable or player-visible behavior.

## Native CLI cutover gate (#519)

The candidate remains isolated behind `NOVELTEA_CLI_CERTIFICATION=1` and
`NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE=1`; neither changes the normal
CLI/editor production authority. `editor/scripts/certify-native-cli-inventory.mjs`
derives 39 public paths from the canonical help contract, checks the router's
families and operations, compares the concrete command definitions and CLI
application/ScriptC special cases, and requires an explicit
native/retained-tool owner and an installed-CLI witness. It additionally checks
28 native C++ Project command actions, 10 native Project editor IPC endpoints
and the currently rejected unported legacy IPC endpoints. A native-only action
without a TypeScript caller must be exercised by the native command certifier.
Changes to the public routing surface that lack coverage fail this check.
The checked inventory classifies nonauthoring daemon, raw shader/texture and
media tools separately from native-authoritative Project commands. Private
editor/daemon bridge entrypoints remain governed by their own native worker
and IPC boundary tests; passing the public inventory alone is not evidence
that every private caller is certified.

The native candidate now returns `CLI_NATIVE_CANDIDATE_UNCLAIMED` (internal
exit 70) instead of silently falling through to retired TypeScript Project
handlers for an unclaimed non-preparation Project command. The isolated
`NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE=1` switch additionally
refuses construction of a retired TypeScript workspace both at the installed
ScriptC island factory and at the underlying `ProjectWorkspaceService`
constructor. The constructor's focused regression demonstrates that poison is
active for the candidate but does not disable the isolated TypeScript oracle.
This is an **execution** guard for the candidate, not a
replacement for the #521 production build/import graph removal proof; its owner/portable-snapshot
preparation and every command family must pass with poisoning enabled before
the independence gate can be considered closed.

`certify-native-cli-project-routing.mjs` compares the installed oracle and
candidate using separate disposable Projects/daemon roots, an enumerated
schema collection inventory, Feature Lab and non-record YAML owners. Its
normalization is limited to the distinct temporary Project/fixture root
spellings and the documented protocol-version field; it otherwise requires
equal JSON envelopes and diagnostics, including physical files in the Asset
import case. Dedicated scripts additionally exercise native validation,
transactional mutations, authored Tests, Runtime Package bytes, and platform
preflight/publication. Linux build CI runs these scripts; the release host
matrix runs native routing, validation, inspection, Tests, package and platform
checks on Linux, Windows and macOS. `certify-native-cli-transport.mjs` separately
checks usage errors, malformed source admission, daemon/local transport,
environment no-daemon override and JSON's single completion/empty stderr.
It also exercises recovery after malformed required YAML and unsupported
manifest schema admission; neither a warm owner nor a cached result may
authorize an invalid generation. Both the Linux build and the release-host
candidate matrix execute the native editable-Project lifecycle differential,
including rejected or traversing archives, alongside the routing and transport
checks. These scripts must execute against an installed binary from the same
commit as their tests, rather than an older downloaded host CLI.
`certify-native-cli-performance.mjs` records six process-wall-time stages:
cold standalone and daemon validation, unchanged warm validation, a changed
Room YAML, a changed Lua source, and Project export preparation. It removes
the standalone result cache before cold daemon admission so the two sides
perform equivalent work. It rejects a run only when the native path is both
over 3x slower and more than 500 ms slower than the TypeScript oracle; this
conservative dual threshold permits shared-runner jitter but catches a material
regression. The recorded numbers are workload-specific and are not a claim of
production throughput. A script's existence or a passing inventory
check is not a substitute for its executed host evidence.

The #506 deletion inventory includes the retired Project-admission, sparse
YAML codec/normalizer, cross-record validation/dependency analysis, workspace
writer and watcher authority under `editor/src/shared/`, and their legacy CLI
entrypoints (`semantic-project`, `fmt-command`, `project-bundle-cli`, and
TypeScript Project-preparation code). Audit references before removing shared
modules: downstream compiled-project lowering, ShaderC/FFmpeg/platform tooling,
Agent Kit generation, transport and native bridge glue may still need TypeScript
or QuickJS. #506 must not delete those merely because the **Project authoring
authority** has moved. Agent Kit and versioned schema inventories are unchanged
by this certification wiring; neither changes any authored/persisted shape.

### Outstanding certification gates (October 20, 2026)

The Linux installed-CLI transport comparison passed 21 cases, the routing
inventory passed 39 public commands / 28 native bridge actions / 10 editor IPC
endpoints, and the six-stage local timing check passed its regression threshold.
The narrow CLI routing, native lifecycle/validation and native IPC unit tests
passed (60 tests). The native CLI was rebuilt from this candidate with the
certification-only legacy workspace poison active.

Subsequent #505 integration repaired the optional Layout default projection:
`entity inspect layouts counter-fragment` now matches the legacy CLI without
inventing `dependencies.templates` when an explicit dependency object omits
that optional field. The C++ Layout regression covers both an explicit sparse
dependency map and an omitted map with a full default. The next discovered
family mismatch, a lexical `alpha-board` reference in `trigger-panel` RML,
was repaired using native RML/Lua source analysis. Both individual installed-CLI
oracle comparisons now pass with identical source evidence. Native Runtime
Package export also passed cold/daemon byte-level parity (default and developer
overrides) and rejected a pinned-worker Project source race without overwriting
an existing package. Pinned native sessions no longer eagerly construct the
retired TypeScript workspace service.

The complete local Feature Lab differential now **passes all 82 public command
comparisons** between native and legacy installed CLIs (including daemon and
local shader compilation after physical source changes). The **release-host
certification gate remains open** until Linux/Windows/macOS matrix results are
confirmed. #519's cross-host coverage and remaining downstream caller/retirement
gates require their own acceptance review. Neither #519 nor parent #505 should
be closed solely on the strength of the local Linux results.

The #512 installed-CLI routing differential now covers **82 comparisons**,
including scoped `platform profiles` under local and daemon authority and with
an unrelated malformed Room. Run `pnpm -C editor
noveltea:certify:native-cli-lifecycle` for the separate native-vs-reference
editable Project lifecycle proof: fresh create, deterministic local/daemon
exports, exact ZIP member hashes/inventory, local/session/VCS exclusions,
import/reopen, destination conflicts and invalid/traversal archive rejection.
The lifecycle comparison ignores only the independent temporary roots and
diagnostic prose for corrupt ZIP entries; stable error codes, paths and exit
classes still must match. This is candidate-stage #512 evidence; #519 owns
exhaustive all-family, negative, host and independence certification.

The #519 candidate audit expands installed-CLI transport to **27 local/daemon
comparisons**, including unsupported workspace versions across validation,
entity inspection and scoped platform profiles. The native result adapter maps
the top-level `/schemaVersion` const rejection to the established workspace
error category. Runtime poisoning of the retired workspace constructor exposed
and eliminated two unnecessary legacy constructions in resident Project export
and heavy-job snapshot preparation. The installed native candidate subsequently
passed the editable-Project lifecycle, Runtime Package byte/readback/source-drift
and platform Web publication differentials with poisoning enabled. These local
results are not a substitute for the release-host Linux/Windows/macOS matrix;
#519 and #505 require those executed results at the candidate commit.

## Parallel native daemon validation certification (#500)

The existing daemon's dedicated Project-owner worker can also retain a **separate,
read-only native C++ Project validation graph**, keyed by the canonical physical
Project root. It uses the native Project-session source authority and exact
physical source revisions; warm calls retain unaffected record and diagnostic
contributors, while physical edits, missing sources, and uncertain watcher
coverage revoke previous proof. A newly admitted malformed disk Project is
read through the certification-only cold validation entrypoint and cannot be
admitted as mutable native state. No tracked Project files are written.

For isolated daemon certification only, use
`NOVELTEA_CLI_CERTIFICATION=1` together with
`NOVELTEA_CLI_CERTIFICATION_NATIVE_DISK_VALIDATION=1`. Each Project-owner
`noveltea validate` then emits a `[native-disk-validation]` JSON diagnostic
observation to stderr, including the independent native result and the actual
TypeScript CLI oracle. The flag never creates another daemon or a second public
command. It is not a fallback: normal invocations, JSON protocol envelopes,
diagnostic presentation, exit statuses, editor behavior, and `--no-daemon`
continue to use the existing canonical CLI validator until the coordinated
native cutover under #474. Certification-only diagnostics are not persisted.

## Parallel native Project command certification (#501)

### Native public validation candidate (#513)

With `NOVELTEA_CLI_CERTIFICATION=1` and
`NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE=1`, `noveltea validate` uses
native disk-authoritative ProjectSession validation for the complete static
Project graph. A successful native diagnostic generation is matched to one
complete native preparation before downstream physical Asset, distribution
notice, native font-shaping, shader-compiler and reflection checks run.
Validation preserves the read-only/static execution boundary: it does not
execute gameplay Lua. The result requires a native source-generation proof,
including discovered Lua/RML/RCSS/shader inputs, and exact physical Asset and
notice checks before publication. Native diagnostic locations are resolved by
the native restricted-YAML source locator rather than a second TypeScript
Project admission. Native authority or transport errors fail closed without
falling back to TypeScript authoring. Resident validation results and native
font/shader stage caches remain optional and are validated against their
physical revision, schema and native-tool identities before reuse.

This is an isolated certification candidate. The default public CLI remains
unchanged until the coordinated editor/CLI production cutover in #506; the
remaining broad cross-command certification inventory belongs to #519.

### Native resident Project preparation (#514 candidate)

Under `NOVELTEA_CLI_CERTIFICATION=1` and
`NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE=1`, a cold resident Project owner
opens through native `ProjectSession` full validation/normalization. It reconstructs
the RAM source index from exact original bytes and native source revisions without
invoking the TypeScript YAML decoder or Project-admission validator; native source
and resident physical proofs must both succeed before the owner can publish its
portable immutable generation. Changed sources are re-admitted by the native
owner with a new generation, leaving already pinned workers unchanged.

The retained preparation includes the effective native Project, source-generation
identity, exact source revisions, native authoring warnings, captured shader
stage/include bytes, and the native-admitted sorted runtime Asset-reference inventory.
The portable Project value is native-owned, not the former
TypeScript Project projection. Captured Lua, Layout RML/RCSS/Lua, shader/include,
and supporting text inputs are retained for disposable downstream consumers.
An immutable disposable worker never reruns native Project admission or source
proof against newer live disk state. Missing or mismatched native preparation
fails closed; standalone `--no-daemon shaders compile` retains its native
prepare/compile/final-proof path. Shader includes outside `.sc` (such as `.sh`)
participate in source invalidation and portable capture.
The native preparation document is daemon-internal and has no separate persisted
version or compatibility fallback.

In the native-admitted candidate, the shared Prepared Runtime Artifact path
consumes the admitted validation result and native Asset-reference inventory,
skipping TypeScript Project normalization, semantic validation, structural linking,
and a second source/dependency graph traversal. TypeScript remains responsible for
downstream gameplay lowering, compiled-wire validation, Material/shader requests,
localization closure, and packaging glue; it is not a second saved-Project admission.
Shader compiler overlays and dependency-revision verification use captured
Project text, including non-`.sc` includes, rather than newer disk contents.
Pinned Runtime Package notices are published as captured text under their
`licenses/` archive paths. Native-owned reference inventories are internal
same-generation snapshot evidence, not a new published runtime schema.

These shared changes do not complete the separate public Test, Runtime Package,
platform, or ComfyUI policy tickets (#515–#518), or exhaustive installed CLI
integration certification (#519).

### Native platform export candidate (#517)

With the native lifecycle certification switch enabled, `platform export --check`
and `platform export` use the same resident native Project preparation and
generation-pinned disposable publication boundary as Runtime Package export.
The selected export profile, application identity, external Asset proof, and
captured authored shader source are native-owned; platform templates, signing,
collision handling, and recoverable multi-artifact activation remain in the
existing downstream platform service. The `--check` route is owner-short and
write-free. Successful publication alone updates ignored editor-local identity
metadata; any concurrent editor-local change is preserved.

The Linux installed-CLI regression is
`pnpm -C editor run noveltea:certify:native-cli-platform`. It creates a small
real authored Project and locally untrusted Web template in disposable roots,
compares legacy/native cold and daemon preflight, then compares real published
Web artifacts, collision and symlink refusal, signing/config errors, and identity
acknowledgement. It never uses external signing credentials and therefore
does **not** certify actual certificate signing. Other platform signing and
runtime execution remain subject to their target-specific release CI.

This certification candidate does **not** switch production routing or the
native-authoritative candidate for Runtime Package, Test, and platform preparation
to production. Those consumers continue to share `prepareRuntimeArtifact` and
the existing native compiler/package boundary, using the pinned native Project
when executing under the certification flags. #506 owns the coordinated production
switch and removal of superseded authoring code; the canonical production CLI
and daemon keep their existing semantics until that switch.

### Native scoped disk callers (#512, partial)

In the isolated native lifecycle candidate, `agent sync [--fix]` discovers the physical
`project.yaml` without decoding YAML in TypeScript, then calls native
`workspace-preflight`. The native boundary checks current workspace shape and generated
Project-identity schema, pending YAML/Asset-import transactions, and containment of the
manifest, local state, managed Agent Kit root, bootstrap and ignore paths. Unrelated
invalid record families do not block this preflight. A native rejection returns its
workspace/mutation diagnostic without a TypeScript retry or Agent Kit write. Agent Kit
content generation and bootstrap repair remain machine-tool services, not Project
semantic authority. Command-visible roots retain the caller's logical spelling.

Asset audit shares that scoped identity/transaction preflight. Its native inventory
follows contained directory symlinks under their logical paths, rejects ancestor cycles,
and checks declared Asset-source containment even outside `assets/`. Neither preflight
nor audit recovers pending transactions.

The native candidate also prepares scoped `platform profiles` (including effective
memory policies), and editable-Project export can consume a native-admitted pinned
Project generation with exact source-revision checks. Structural reference roles
are generated alongside the native contracts, and native entity operations cover
typed reference usages, repairs, and registered Lua source references. Native
command failure adapters retain structured workspace diagnostics and exit status.
Unrelated semantic-invalid record contributions do not by themselves prevent
native usages from reading a complete, physically certified reference inventory;
unadmitted or unparseable record contributors still fail closed rather than
publishing a potentially incomplete graph.

This is not completion evidence for #512: the full command/flag/domain parity
audit and installed-CLI differential certification remain outstanding. Broad
certification is deferred until the refactor is ready; no production authority
switch is enabled here.

The host-only native Project command adapter exposes `entity-inspect` (including
sparse-source provenance), `scoped-edit` (a generic patch batch with dry-run and
explicit working/source revisions), and `export-preparation` (a validated
effective Project and owned-source inventory). The adapter opens an independent
disk Project session for each command and uses the same native transaction and
dependent-source validation boundary as editor-native authoring. A write requires
exact disk preconditions for every affected owner; stale, invalid, or unsafe
mutations fail without permitting an implicit TypeScript fallback.

`NOVELTEA_CLI_CERTIFICATION=1` plus
`NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS=1` instructs the existing Project
daemon to compare read-only `entity inspect` results against the native adapter,
emitting `[native-cli-inspect]` observations to stderr. The authoritative CLI
JSON, exit codes, and edits are unchanged. The native adapter is not yet a
production replacement for `fmt`, localization sync/reconcile, portable bundle
import/export, or runtime package publication: those paths remain on their
existing implementation until corresponding native parity work and the #474
coordinated cutover. The host integration test is
`editor/scripts/certify-native-cli-commands.mjs`; the direct native test target
is `noveltea-cli-native-certify`.

The native Project command C entrypoint requires a preallocated response buffer
for mutating operations; a two-pass response-size probe must not execute a
transaction or write an archive. The installed `--no-daemon` capture path
reserves this buffer and invokes the command exactly once.

The #501 native adapter now certifies whole-source `fmt` and
`fmt --strip-defaults` against canonical YAML sources. Its emitter must
preserve comments and scalar semantics; sparse default omissions additionally
require identical effective native record validation before a revision-checked
atomic whole-source transaction. Native Message
`localization accept`/`review` certification uses source fingerprints for
named Messages and tracked managed Lua/RML Messages, with native
multi-source-safe YAML transactions. ActiveText object cues and shorthand
participate in the named Message fingerprint contract. The native editable Project `.ntproject` exporter
reconstructs all validated disk record contributors and uses the existing native
ZIP archiver; the importer verifies ZIP headers, CRC, manifest hashes, canonical
inventory, physical paths and workspace admission before activating the new
directory. The standalone certification compares the portable bundle's complete
bytes to the authoritative CLI export, and reopens the native-imported Project.

The native adapter now also certifies free-form Lua/RML `localization sync` using
the native source analyzer's shared structural/anchor fingerprints and six-stage
deterministic one-to-one identity matching. Dry runs report materialized,
preserved, and unresolved Message identities without writing; explicit sync
commits are exact-revision checked and use the native Project transaction
writer. Feature Lab tests include an unmodified tracked source and a newly
authored inline Lua Message. The CLI `--dry-run` result is compared field for
field to the installed-headless implementation in the same daemon's optional
`[native-cli-localization-sync]` certification observation.

The native adapter also exposes localization reconciliation planning and
decision-checked application with deterministic source fingerprints, stale-plan
and physical source-revision guards, and all affected locale/tracking/orphan
owners committed together. Schema-generated entity defaults produce native
create transactions; rename/delete operate on reference-free owners or
atomically rewrite known typed references, rejecting unclassified potential
references rather than silently producing a dangling graph. Canonical sparse
YAML scalar references are classified by their structural owner/target types:
the native adapter rewrites Room exits and known Room material references as
exact references, not ambiguous prose. `--allow-possible-source-references`
only acknowledges plausible lexical references in source/prose fields; it
does not override missing repairs for required typed references. The separate
`--force` deletion contract deliberately permits known incoming references to
remain dangling, as in the installed CLI; it does not authorize rename
without semantic repairs. Unforced delete automatically removes known Room
cast/overlay references and clears declared nullable Room references, using
source-aware sequence edits that refuse to silently discard YAML annotations.
Before a non-forced structural commit, the adapter validates the prospective
complete disk Project in an isolated staging root; invalid dependents block
publication of every changed source. Refusing an unsafe operation leaves
the original source files unchanged.
Structural renames also remap `i18n/messages.yaml` structured-Message paths
in the same revision-checked transaction, preserving existing derived or
explicit Message UUIDs (including defaulted Room descriptions) across multiple
renames. Deleting records with translated structured Messages is rejected
until a transaction can explicitly preserve that history.
Grouped Layout sources commit `layout.yaml` and their RML/RCSS/Lua companions together.
`runtime-package-preparation` verifies complete disk-owned record contributors,
the selected runtime profile, dependency-based Asset closure, and
content-revision-pinned inputs. The native-authoritative `package export`
candidate consumes that admitted generation locally and the owner-pinned
generation in disposable daemon execution. Final compiled artifact creation,
localization closure, shader/media preparation, and ZIP publication still use
the existing Prepared Runtime Artifact pipeline and native package exporter.
Before publication the candidate re-proves pinned source and Asset bytes and
uses the existing staging, backup, recovery-registration, acceptance, and
rollback transaction.

The certification-only `entity-usages` reader also projects typed reference
edges from validated native record snapshots, including Condition Variable,
Room, Material and Asset references, and builds Lua lexical evidence from
inline and Project-owned script sources. Canonical edge IDs, roles, source
paths and occurrence locations are compared against installed-headless CLI
`usages` results. Source references outside the currently certified paths
remain a graph-coverage gate for #501 and must not be silently treated as
reference-free by mutating operations.

The separate read-only `localization-view` adapter projects explicitly authored
named/local, structured, and managed-source Messages from an admitted disk Project. Its source,
presentation, and guidance fingerprints determine translation freshness and
attention without mutating translation or tracking sources. Status filtering,
locale inheritance, and per-usage notes are certified against the installed
headless `localization view` JSON, including a fixture with outdated
presentation/guidance acknowledgements. The installed CLI continues to own
the public response until the native cutover.

The native view now uses native effective-Archetype validation (including
instance overrides and inherited configurations), and traverses the Project's
`undefinedInteractionProgram` for structured fallback Messages. The native
sync, reconcile, accept, and review adapters return an internal
`sourceGeneration` identity in their read-only planning responses; a write
requires that value as `expectedSourceGeneration` in addition to any affected
YAML owner's exact source revision. The native generation covers the complete
physical tracked authoring-source inventory, including managed Lua/RML source
owners, and is independently rechecked before publication. This is an
internal native certification transaction precondition, not a new public CLI
flag or a replacement for the canonical workspace revision at cutover.
The test-only `noveltea-cli-native-certify --request-file` adapter enables
`editor/scripts/certify-native-cli-mutations.mjs` to compare actual persisted
files from two independent Project copies: installed-headless CLI mutations
versus native create/rename/delete, formatting, sync, reconcile and review.
The native certification executable is never shipped as a public CLI command.

Full parity remains a cutover gate: rich free-form/localization workflow
presentation and some semantic reference-repair/forced-delete cases still
require the established CLI oracle. Until #474's coordinated cutover, no
production CLI command delegates partially to this certification adapter.

## Private media-tool diagnosis

`noveltea [--json] media-tool check` checks the installation-relative private FFmpeg tool without
loading a Project. It reports executable, version, bundled/external selection, and release; installation
or capability failures return exit code 6 (`media.tool`). An absolute `NOVELTEA_FFMPEG` override
selects an external developer/distro build explicitly. See [Media Tools](MEDIA_TOOLS.md) for pin,
configuration, packaging, and shared Editor/headless invocation ownership. This command does not
add video playback or a Project media-transcoding policy.

## Project discovery and direct editing

A project is identified by its root directory and `<project-root>/project.yaml`. Use `--project <project-directory>` to select a project explicitly. Without it, the CLI walks upward from the current directory and stops at the first `project.yaml`. A malformed NovelTea manifest, wrong workspace identity, or unsupported workspace version is a terminal discovery error at that directory; discovery does not fall through to a parent project or accept a retired monolithic project file.

Ordinary authoring is file-first: edit tracked YAML, Lua, RML, and RCSS directly. After direct edits to managed localizable Lua/RML source, run `noveltea localization sync` to materialize only deterministic Message-tracking changes, then run `noveltea validate`. Passive validation, source analysis, preview, and editor watching never write localization tracking. Do not route ordinary field changes through invented setter commands. The CLI owns operations that need project-wide semantics, transactions, native tooling, or reproducible automation.

## Public command surface

The `fmt --strip-defaults` option compacts declared omission defaults in
records (including Layout metadata other than its required source selectors) and in eligible Project manifest,
editor organization, and localization owners while preserving annotated
explicit values. `--check` reports opportunities without writing; the
candidate must validate as semantically equivalent before any commit.
`entity inspect --provenance` distinguishes omitted and explicitly authored
empty collections as well as scalar shorthand and nested fields. Entity
renames return informational diagnostics for surviving distinct-token mentions
of the old ID in YAML comments, without modifying or blocking on the prose.
Successful editor structural saves also present those informational notices.
Test Step inputs and active payload identifiers must be explicitly authored;
the generated source schema encodes the same conditional requirements as YAML
admission, rather than editor-only placeholder defaults. Choosing Keep retains
annotations on changed default-valued Layout, manifest, and tracked-editor fields.

Core authoring commands are:

```text
noveltea project create <directory> --name <project-name>
noveltea project export --output <bundle.ntproject>
noveltea project import <bundle.ntproject> <destination-directory>
noveltea validate
noveltea entity inspect <collection> <id> [--provenance]
noveltea fmt [<tracked-yaml-path>] [--check] [--strip-defaults]
noveltea localization sync [--dry-run]
noveltea localization reconcile [--apply]
noveltea localization view <locale> [--status <missing|current|outdated|needs-review|reviewed|human|ai|imported|unknown|attention>]
noveltea localization accept <locale> <message-id>... [--dry-run]
noveltea localization review <locale> <message-id>... [--dry-run]
noveltea usages <collection> <id>
noveltea asset audit
noveltea asset import <path>... [--dry-run]
noveltea entity create <collection> <id> [--dry-run]
noveltea entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]
noveltea entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]
noveltea agent sync [--fix]
```

`project create` accepts a new destination path that does not exist, including paths containing spaces, and rejects every existing file, directory, or symlink. It assembles and validates the complete initial workspace in a sibling staging directory before atomic activation. The editor uses the same creation service and project defaults. Creation does not generate `.noveltea/agent/`; run `agent sync` afterward.

`project export` writes the current portable editable-Project artifact, `.ntproject`. The bundle is a deterministic ZIP with the current `noveltea.project.bundle` version-1 manifest, the canonical Project Workspace files, referenced Asset source bytes, and Project-owned `workflows/` files. It deliberately excludes `.noveltea/`, `dist/`, VCS metadata, `.gitignore`, agent bootstrap files, local/session state, transaction state, caches, and other files outside the current Project authoring contract. Export refuses an existing destination and fails if captured canonical source changes while the bundle is being prepared.

`project import` accepts only the current `.ntproject` contract and requires a destination that does not exist. The importer verifies the ZIP structure, safe normalized UTF-8 paths, regular-file entries, CRCs, manifest identity/version, exact sorted inventory, byte sizes, SHA-256 hashes, and the contained current Project Workspace before atomically activating the destination. Files outside the reconstructed Project-owned authoring inventory are rejected even when declared by the bundle manifest. The imported directory then opens and validates as an ordinary Project Workspace. `.ntproject` is editable-source transport only; Runtime Package `.ntpkg` behavior and contents are unchanged and remain runtime-only.

`entity inspect <collection> <id>` reads one effective record from the admitted Project snapshot and prints the expanded normalized record without writing files. Its `--json` response includes `collection`, `id`, and `record`; `--provenance` additionally includes a parallel nested `provenance` tree. A leaf marked `explicit` occurs in the authored source; `default` means that it was supplied by the source codec/schema. A source shorthand reference is represented as an `explicit` `$ref` in provenance and as the canonical typed reference in the effective record. Missing IDs and unknown collections fail instead of generating placeholder records. Inspection does not dump the Project or materialize expanded YAML.

`localization sync` is the explicit mutation boundary for durable local Message identity discovered in free-form Lua and RML. Structured schema-owned Messages use their semantic owner/field identity directly and need no free-form occurrence sidecar. Sync preserves an existing ID only for deterministic one-to-one matches, assigns IDs to definitely new managed occurrences, updates compact source/structural/anchor fingerprints plus the managed occurrence source/guidance snapshot, and leaves ambiguous duplicate/many-to-many cases unresolved for reconciliation instead of guessing. `--dry-run` reports the same deterministic plan without writing tracked files.

`localization reconcile` is read-only by default and emits a deterministic reconciliation plan. The plan includes the expected Project workspace revision, a source/tracking fingerprint, ambiguity groups, current occurrences, recoverable prior/orphaned Messages, and whether valuable work requires an explicit choice. `localization reconcile --apply` reads one JSON object from stdin containing `expectedWorkspaceRevision`, `expectedFingerprint`, and a `resolutions` object mapping current occurrence IDs to either a prior Message ID or `"new"`. A prior Message ID can be used at most once, so direct-file duplication can never silently share a local Message identity. Valueless weak matches and many-to-many ambiguity default to independent new identities; valuable abandoned work moves to `orphanedMessages` and leaves live target locale chunks, while valueless stale bookkeeping is removed. Relinking an Orphaned Message restores its target translation/review/provenance work. Apply refuses stale plans and commits through the normal Project Workspace transaction writer.

`localization view` joins canonical source and one target locale into a work queue suitable for humans or agents. Each row reports source/guidance/usages, target content, Current/Outdated/Missing freshness, Human/AI/Imported/Unknown origin, Needs review/Reviewed state, optional provider/model provenance, and derived presentation/guidance attention. `--status` filters the joined view without changing canonical storage. `localization accept` advances the stored semantic source fingerprint for selected existing targets without changing their text, origin, or review state. `localization review` marks selected Current, structurally valid targets human-reviewed; Missing, Outdated, and invalid targets are rejected, and a failed bulk review writes nothing. Both mutations support `--dry-run` and use the normal Project Workspace transaction boundary.

`asset import` accepts one or more files. Files already under the Project `assets/` directory are registered in place; other files are copied into the normal kind-specific Asset directory. Re-importing an already registered Project Asset path returns the existing Asset instead of creating a duplicate. Font imports are validated through the same native FreeType face/glyph inspector used by the editor; invalid fonts fail before the Project transaction, including with `--dry-run`. `--json` returns the Asset ID and source path plus image metadata when applicable. `asset audit` lists files under `assets/` that do not have Asset records. It uses the CLI's scoped read-only Project-preparation contract: only the current Project identity, Asset records and declared source routing, and the `assets/` filesystem inventory are loaded and validated. Malformed unrelated authoring domains therefore do not block an Asset audit, while current workspace identity, pending-transaction safety, Asset schema/path validity, and filesystem containment remain enforced. The inventory root must resolve inside the Project, directory cycles are rejected, and declared Asset source paths are checked for Project containment even outside the conventional `assets/` tree.

CLI audio/video imports also validate via the private FFmpeg binary already distributed alongside
the standalone CLI. Both normal imports and `--dry-run` require one successfully decoded audio
block or video frame; the probe has a bounded timeout and does not transcode the entire source.
Routine `asset audit` remains a filesystem inventory without decoder work.

ComfyUI workflow discovery is available headlessly:

```text
noveltea comfyui status [--server <url>]
noveltea comfyui workflows [--all]
noveltea comfyui workflows <id>
noveltea comfyui verify [<id>] [--server <url>]
noveltea comfyui run [<workflow-id> | --type <classification>] [--input <name=value>]... [--output <routing>]... [--server <url>] [--force]
```

These commands use the same catalog, machine configuration, and verification cache as the editor workflow manager.
Built-in and shared-user workflows are available without a Project; when `--project` selects a Project or upward
discovery finds one, project-local workflows are added. Source precedence is `project > user > built-in` by logical
workflow ID. Bare listing returns only the effective workflow set. `--all` is diagnostic and also exposes overridden or
invalid package copies without changing precedence. Inspection reports the selected workflow's source, classification,
description, public inputs/outputs and authoring metadata, offline validation/runnability, package hash, and cached
verification state relevant to the configured server.

`comfyui status` is deliberately Project-independent and rejects global `--project`. It resolves one server for the
invocation as `--server`, then the shared user configuration, then `http://127.0.0.1:8000`, and reports connection,
ComfyUI version, and queue information without exposing arbitrary response bodies. `comfyui verify <id>` verifies one
effective workflow; omitting the ID verifies the active workflow set in the optional-Project context. Verification checks
the manifest-required node classes and every mapped node input against `/object_info`. CLI verification is diagnostic
only except for updating the disposable shared verification cache; it never repairs or rewrites packages.

`comfyui run` accepts either an explicit workflow ID or `--type <classification>`. `--type` resolves the logical
workflow ID from the shared user configuration and then applies normal `project > user > built-in` source precedence.
The two selection forms are mutually exclusive, and omitting both is invalid; NovelTea never guesses a classification or
silently falls back to the first workflow. A configured default that is unavailable remains configured and fails with a
targeted diagnostic. Classifications use the same extensible dotted namespace as workflow manifests, so future values do
not require a runner enum change. Repeated `--input name=value` arguments bind through the manifest's public contract;
values split on the first `=`, duplicate/unknown names are rejected, required/default/type semantics are checked before
network work, and one public input may drive every graph binding declared for it. Scalar inputs support string, integer,
number, and boolean values.
An `image` input accepts an explicitly named local file; relative paths resolve from the invocation working directory.
The image media handler enforces the 32 MiB source ceiling and decodes the file through NovelTea's shared/native image
inspection capability before upload.

Local image bytes are disclosed only to credential-free plain-HTTP servers addressed by a literal loopback IP (including
IPv4, IPv6 loopback, and admitted IPv4-mapped IPv6 forms). `localhost`, HTTPS, credentials, arbitrary hostnames, and
non-loopback addresses are rejected before any upload. Text-only status/verification/execution remains usable with
ordinary configured HTTP/HTTPS servers. Upload names are generated uniquely, preserve the validated media extension,
and do not expose the local basename. Online verification completes before upload; an upload failure aborts before
`/prompt` and NovelTea does not claim to roll back already accepted remote uploads.

Execution submits one uniquely identified prompt, polls HTTP history without a fixed whole-job timeout, waits for terminal
completion, and validates every declared named output before local publication. Output cardinality is exact: required
`one` produces exactly one image, required `many` one or more, optional `one` zero or one, and optional `many` zero or
more. Every downloaded image is bounded and media-validated before any local result becomes visible.

Each output has exactly one publication target. With a Project available, an output without an explicit route becomes a
normal NovelTea Asset in `assets/generated/`; every image from a `many` output becomes a separate Asset. Use repeated
`--output name=<path>` options to route selected outputs to the filesystem while leaving the others as Assets. Bare
`--output <path>` is shorthand only when the workflow declares exactly one named output. Without a Project, every
declared output must have an explicit named filesystem route before upload or prompt submission.

A cardinality-`one` filesystem route names a file. A cardinality-`many` route names a directory, and NovelTea creates
validated generated filenames beneath it. Missing parent directories are created during publication. Existing files fail
unless `--force` is supplied; `--force` applies only to explicit filesystem files and never changes collision-safe Asset
naming. File extensions must match returned image formats because NovelTea does not transcode.

Local publication is prepared as one result set only after all remote outputs are present and valid. Filesystem results
are staged with atomic rename/backup primitives, while all generated Asset records and bytes are committed in one normal
Project transaction based on a freshly reopened Project. If mixed publication fails, staged filesystem outputs are rolled
back as far as those primitives allow and no partial Asset transaction is intentionally committed. Publication failures
are reported explicitly as occurring after successful remote generation. Structured results remain keyed by logical
output ID: cardinality-`one` outputs return one metadata object or `null`, while cardinality-`many` outputs return arrays.

Ctrl-C installs an invocation-scoped cancellation handler. Once a prompt exists, NovelTea attempts to delete only that
prompt from the ComfyUI queue and returns conventional exit status 130; it does not call the global `/interrupt` endpoint
or clear unrelated jobs. Independent `comfyui run` invocations remain concurrent and use distinct client/prompt IDs.
With `--json`, execution still produces exactly one final compact envelope on stdout and no stderr output.

Built-in ComfyUI packages are embedded directly into the self-contained standalone executable. A relocated `noveltea`
therefore retains the built-in workflow catalog and execution contracts without Electron resources, sibling workflow
files, project-local JavaScript, Node, or Sharp. User and Project packages remain external mutable sources layered over
those embedded built-ins by normal `project > user > built-in` precedence.

Shared user packages live under `<NovelTea user config>/comfyui/workflows/`. The versioned
`noveltea.user-config` document at `<NovelTea user config>/config.json` owns durable user preferences,
shared ComfyUI settings, and shared export configuration. Its ComfyUI section contains the server URL,
per-request timeout, and logical default-workflow mappings keyed by arbitrary valid dotted classifications;
editor enablement and periodic connection-check cadence live in the preferences section rather than the
ComfyUI machine-settings section. `NOVELTEA_USER_CONFIG_ROOT` therefore provides hermetic user configuration,
workflow, and cache storage for CI. An invocation `--server` override is ephemeral and does not rewrite the
shared configuration.

The editor's Generate Image and Edit Image surfaces are thin Project-session adapters over this same execution core.
They use the same catalog/default resolution, verification, public bindings, HTTP history polling, prompt-specific
cancellation, image validation, and publication preparation. Edit Image first reads the selected source Asset through
editor-owned Project authority, then hands a private temporary local image to the shared secure media handler. Therefore
`localhost` is not an editor exception: use a literal loopback server such as `http://127.0.0.1:<port>` when local image
bytes must be uploaded. The workflow manager retains image-specific automatic inference, while its strict current manual
manifest editor can author or repair arbitrary named generic contracts and future classifications.

## Resident daemon lifecycle

The **shipped direct C++ CLI** launches the native broker and one resident
**C++** Project-owner process per canonical Project root (#549/#551). Owner reads,
Project transactions, formatting, localization, validation, and Asset inspection/import
execute against the already-native Project services without a ScriptC host or QuickJS.
Broker-authoritative physical observations bracket owner work and advance the broker's
existing session-epoch/generation identity; Project source/Asset changes and watcher
reconciliation do not depend on a JavaScript engine. The native candidate forwards the
caller's cwd and scoped environment to the owner, retains exactly proven validation results
(including deterministic semantic failures) using the existing native cache, and safely
replays read-only requests locally after an uncertain daemon failure, but never mutations.
`--no-daemon` retains the same local C++ command execution.
The CLI routes shader compilation, cold authored/Test-spec execution, Runtime Package
export, platform export, and Project-backed ComfyUI generation through one-job native disposable
workers (#550). Projectless ComfyUI filesystem-only runs also use a one-job native
disposable process, without inventing a Project generation. The owner captures the native
Project preparation responses
(including normalized Project data and shader source overlays), brackets that capture with
physical authority observations, and publishes opaque chunks through the existing broker snapshot
store. Each capture has a distinct generation identity so a later workload cannot overwrite bytes
already pinned by another worker. Workers resolve semantic Project requests exclusively against
that capture; only a physical proof of a captured source generation may consult live disk. They
reject source drift rather than silently switching to a newer Project. A cold worker does not
probe a newer live runtime cache; complete warm runtime/Test-catalog hits still execute in the
caller. Stdin Test specs, cwd, and environment travel with the invocation. Unknown uncaptured
Project requests fail closed. Existing broker cancellation and child retirement isolate worker
failure from the resident Project owner.

ComfyUI workers register staged files with the broker before writing them. Generated Project
Assets are committed by the resident C++ owner against the captured generation; filesystem-only
outputs (including projectless outputs) use the broker's journaled activation/acceptance
transaction. A worker never issues a live Project mutation itself. The broker rolls back
registered outputs when a worker exits or
publication fails, while the owner retains its native Asset recovery journal. Direct local
execution remains native C++ for `--no-daemon`. Platform exports retain their distinct native
platform publication journal and do not pass it through ComfyUI's recovery protocol.

`tests/native_cli/daemon_owner.py` exercises the relocated native executable, cold/warm Test
routing, Test-spec stdin, real Feature Lab shader output, source drift after hydration, terminated
workers, caller cancellation, and owner restart. `tests/native_cli/comfyui_run.py` covers native
ComfyUI Project Assets, filesystem-only output, and mixed Asset/filesystem publication with and
without the broker. The deterministic hydration barrier is available
only with the explicit CLI certification environment and isolated daemon root; it is not a public
command option.

The older detailed ScriptC/QuickJS owner, cache and fallback paragraphs below
are retained as **historical architecture** and are not production operating
instructions. #551 retired those runtime paths. The native C++ owner and worker
contracts above and the production qualification ledger take precedence.

The standalone executable contains a native per-user daemon broker. The broker is keyed by the exact NovelTea build identity plus the independently versioned Daemon Protocol compatibility boundary. While NovelTea is unreleased that boundary remains development version `1`; incompatible development changes replace V1 atomically rather than incrementing it. Different build/protocol identities use different endpoints and may coexist. Linux uses a user-private Unix-domain socket under the platform runtime directory when suitable, with a private NovelTea fallback directory; the runtime directory is restricted to the current user and the socket is mode `0600`. Windows uses a named pipe whose ACL grants access only to the current user. The same `noveltea` executable launches the private daemon mode; NovelTea does not install an operating-system service.

Daemon transport frames are bounded at 16 MiB, including completion results. Full authored-suite
reports must travel intact through this same frame boundary; they are not truncated or retried as
individual Tests to fit a smaller response limit. An oversized worker completion is delivered as an
explicit transport-limit failure, not misreported as an unexpected worker exit.

The native broker begins listening before any QuickJS worker is started. The broker process itself does not host an authoring island: QuickJS exists only in dedicated Project-owner workers, one-job disposable workers, or the explicit local no-daemon fallback. Its externally visible lifecycle states are `starting`, `ready`, `draining`, and `stopped`; clients may connect and queue while it is `starting`. Startup is arbitrated per user/build/protocol so concurrent cold callers converge on one daemon. Stale Unix endpoints are removed only while holding startup ownership and after independently proving the daemon lifetime lock is unowned; a failed connection alone never authorizes endpoint deletion.

IPC uses bounded length-prefixed JSON frames shared by the Unix-socket and named-pipe transports. Requests carry request IDs, and the protocol admits stdout, stderr, progress, cancellation, and one final result event. Commands declared as streamed deliver their human stdout, stderr, and progress frames incrementally instead of replaying them only with the final result; JSON mode retains machine-readable output without injected human progress text. After the broker reaches `ready`, existing-Project reads and Project-affecting mutations are assigned to a dedicated long-lived ScriptC owner process for that canonical physical Project root, including opaque writes when a Project is explicitly named or discoverable. Project-independent QuickJS work is assigned to a one-job disposable worker and never executes inside the broker process. Each owner embeds its own QuickJS runtime, so unrelated active Projects do not serialize semantic work through one island. Caller cwd, environment, stdin when required, terminal metadata (TTY state plus terminal columns/rows when available), output mode, and replay-safety declaration travel with each request and are passed into the shared CLI command context. A single lightweight command-routing contract is evaluated before authoring initialization and declares static/native completion eligibility, one of the production daemon execution classes (`owner-short`, `owner-mutation`, or `disposable-heavy`) for a static miss, whether a static miss needs QuickJS, whether an existing Project is required, Project access/effect (`none`, read, transactional write, or opaque write), replay safety, stdin needs, and streamed-event/cancellation requirements. Bootstrap validation, standalone daemon dispatch, and resident Project handling all consume that contract rather than maintaining command-name routing tables. There is no `direct` resident execution class or shared broker QuickJS lane. The shared CLI receives cwd explicitly per request, and each ScriptC process applies caller environment only for the lifetime of that request, so caller context cannot leak across requests. The broker rejects new work during graceful drain, requests cancellation of queued or active work, retains daemon lifetime ownership until active requests settle, and does not complete shutdown while a registered Project transaction critical section is active. Project-owner idle eviction defaults to approximately five minutes and whole-daemon inactivity to approximately ten minutes; active or transaction-critical work is never treated as daemon inactivity. These are internal engineering defaults, not public user settings.

Heavy authored-Test preparation, Project-backed ComfyUI generation, portable Project export, shader compilation, and output-producing Runtime Package/platform publication use the `disposable-heavy` daemon execution class. Complete native runtime/Test-cache hits still finish in the calling process before daemon dispatch. On a heavy miss/request, the Project owner performs only the short authoritative reconciliation/preparation pass and publishes the exact resident generation as an opaque portable snapshot. Native scheduling pins that `(session epoch, generation)` while the owner remains free to reconcile newer edits and service short reads or mutations. A warm unassigned ScriptC disposable worker receives only the generic pinned snapshot plus the small original command descriptor; it hydrates its immutable Project view directly from those bytes and never consumes owner-only authority/reconciliation metadata or reopens authored Project source files. Portable Project export retains its stricter bundle rule: its final source/Asset revision checks can reject publication if physical inputs change after the captured generation. Owner replacement is a separate path that combines the portable snapshot with the retained native authority metadata and then re-proves disk before resuming ownership. Large external Asset payloads stay file-backed in that snapshot and carry their expected physical identity, byte size, and exact mtime (or fallback content hash). Output workers write to temporary/staging destinations and re-check those pinned Asset expectations immediately before publication. Runtime Package and multi-artifact platform activation then use broker-registered recovery records that describe staging, previous-output backups, final paths, and acceptance. If a disposable process is terminated between rename steps, broker cleanup deterministically restores the previous complete set unless acceptance was already recorded, in which case it keeps the verified new set and removes recovery debris. Project-backed ComfyUI likewise keeps remote generation in the disposable worker and returns immutable staged Asset results to the live Project owner; only that owner re-proves authority and commits the authored Project transaction. For mixed filesystem-plus-Asset results, the prepared filesystem transaction is transferred with that owner mutation. The broker activates the staged filesystem set while the journal is still rollback-capable, then lets the live owner perform the authoritative Project mutation; owner success records filesystem acceptance and removes recovery debris, while owner rejection or loss rolls the filesystem set back. Final mixed acceptance is therefore coordinated outside the disposable worker rather than left to a post-commit JavaScript `finally`. The disposable worker does not re-admit live Project state after that owner commit. Asset drift, cancellation, command failure, or worker failure therefore cannot make a partial/stale result appear as an accepted publication. Disposable workers execute exactly one heavy job and retire.

The portable resident snapshot and the separate owner-rehydration metadata are RAM-only documents
nested inside the exact daemon build/Daemon Protocol identity. They have no independent numeric
snapshot version or compatibility epoch. Producers and consumers move atomically with the daemon
build, validate the complete current document shape, and reject incompatible retained RAM state rather
than migrating, aliasing, or accepting a legacy shape. This is distinct from the public portable
`.ntproject` bundle compatibility boundary.

Project owners, disposable jobs, and warm standbys share one internal hard ScriptC-process admission budget. Starting and retiring workers continue to consume that budget until the child process has physically exited. Existing active owners and foreground Project admission/short owner work have priority over queued heavy work. A new Project uses free capacity when available; under pressure the scheduler may retire an inactive owner, but it never evicts an actively used owner merely to admit another Project. If no safe capacity exists, Project admission queues rather than spawning past the bound. The canonical Project-root reservation remains attached to a retiring owner until that process has exited, preventing replacement admission from creating two physically live owners for one Project. When capacity permits, the daemon keeps at least one warm unassigned disposable worker; consuming it triggers replenishment through the same global budget, and excess idle standbys expire back toward the baseline. Cooperative cancellation is attempted first, after which native scheduling may terminate only the disposable process; a disposable crash likewise fails only its request, releases the generation pin, and replenishes standby capacity without replacing the Project owner or daemon broker. `platform export --check` remains an owner-short, write-free preflight rather than disposable publication work. `daemon status` may expose additive engineering diagnostics for owners, disposable workers, queues, and current process occupancy in addition to its stable core fields. The admission bound and worker counts remain internal policy rather than user-configurable settings.

Read-only commands that need an existing authoring Project use a daemon-resident disk-authoritative Project session inside that Project's dedicated owner worker, keyed by the Project's canonical physical root. Logical aliases and symlinks therefore converge on one owner and one semantic authority while command-visible paths remain relative to the caller's logical Project root. A resident session retains the last coherent immutable Project generation together with the in-memory parsed source, validation, dependency/source-analysis state, and indexes needed for change-scoped work. Those semantic products are RAM-only owner state; they are not authoring-cache persistence artifacts. Resident generations have a process-local session epoch plus monotonic generation counter; the identity advances without deriving a new whole-Project token. Physical freshness comes from the broker's native Project-authority observation: native code owns conservative source discovery/watcher recovery and returns compact added/changed/removed paths, while the owning QuickJS runtime consumes only that delta for ordinary reconciliation instead of independently enumerating the Project. While an owner is otherwise idle, native watcher dirtiness causes the owner to reconcile its resident session; only a real semantic delta or invalid changed generation refreshes the owner activity clock, so watcher noise cannot keep an owner alive indefinitely. QuickJS collection follows the same foreground-priority rule: owner runtimes use a high emergency automatic-GC trigger during active bursts, then perform full collection after a real idle interval only after the broker rechecks that no foreground request has arrived. Existing-source edits build a separate candidate generation from the coherent base, reread and parse only changed sources, invalidate the affected semantic dependency closure, prove the physical generation again, and promote atomically. Unchanged record/source state is structurally shared rather than cloned or canonically reprojected; source-revision state advances from the changed source set instead of sorting/stringifying the complete source inventory. Stable existing-source mutations also retain canonical source membership, save-unit ownership, script routing, validation indexes, Lua/source descriptor indexes, and analyzed dependency state, replacing only the affected entries; source/routing membership changes conservatively widen to reconstruction. Localization/font-coverage preparation carries the revision identity of the latest coverage-relevant generation, so a later presentation-only edit cannot make a product from before an intervening Message/locale/font/semantic change eligible again. Structural source-set changes such as additions or deletions conservatively widen reconciliation. Reused Layout records preserve their authored source selectors: hydration of Lua `none` as an empty local source must not manufacture a file-backed companion requirement during a later structural edit. If disk changes race candidate construction, the final native proof discards the candidate and retries from the coherent base; if a post-command proof consumes a native delta, the resident owner retains that delta for the retry so the advanced native manifest cannot hide stale semantic state. External Asset payload deltas are retained independently from semantic-source deltas for the same reason: even when a final read proof is the first operation to consume one, the owner must advance to a distinct authority generation before publishing another portable snapshot, so refreshed file-backed Asset expectations can never be attached to an already-published generation identity. The owner retains external Asset source-path membership as an indexed set and checks compact native deltas against that set directly; ordinary proofs do not rebuild a QuickJS Set proportional to total Asset count. Transactional mutations use the same owner boundary: the owner first proves that no new semantic delta appeared after mutation admission, constructs and semantically admits the exact projected generation before publication, commits through the normal Project transaction writer, then requires native authority plus exact changed-file revisions to prove that committed generation before promotion. A transaction failure or failed post-write proof never promotes the candidate or evicts the coherent owner; any committed-but-unproven disk delta remains pending for ordinary reconciliation, while a source race before commit returns an explicit revision conflict. Owner processes are evicted only while inactive, using an internal idle cutoff plus a bounded resident-worker pressure policy; eviction stops watcher coverage and the worker cleanly. The broker may retain the owner's latest portable snapshot and exact validation result under independent byte-bounded RAM policies; eviction discards acceleration only, and native authority retained solely for an evicted exact result is released unless a portable snapshot still requires its checkpoint. An unexpected owner-process exit fails only that Project's in-flight request, leaves the broker and other Project owners alive, and lets the next request rehydrate or cold-admit that Project. Malformed current disk state is retained as an invalid overlay over the last coherent generation, allowing a later correction to resume from that coherent base rather than reopening cold. Read commands may declare the semantic Project paths they require; an invalid overlay outside that dependency domain can continue against the coherent generation, while an invalid required source still blocks with its normal diagnostic. Scoped Project-preparation commands keep their narrow direct loading boundary but now capture resident physical authority before preparation and perform the same bounded final authority proof/retry before exposing a result. Portable Project export consumes the resident Project snapshot, while its existing exact source-revision check remains the final publication authority for the archive.

`noveltea daemon status` and `noveltea daemon stop` are static/native diagnostics and do not require QuickJS. There is intentionally no public `daemon start`; the native broker exposes private startup arbitration to the standalone dispatch layer instead of requiring user-managed service startup. `noveltea --json daemon status` guarantees the stable core `running`, `state`, `build`, `protocol`, and `pid`; additional diagnostics may evolve. `daemon stop` is idempotent and performs graceful drain when a compatible daemon is running. On Windows, successful `daemon stop` additionally waits for the broker process to exit rather than treating a closed named pipe as proof of process termination; the broker finishes retiring its worker processes before exit. For ordinary standalone invocations, complete static/native answers still win first; otherwise the client forwards to the compatible resident daemon by default. `--no-daemon` and `NOVELTEA_NO_DAEMON=1` keep the same static/native fast paths but force any remaining work through the canonical local QuickJS path. Failure to establish daemon acceleration within the bounded startup window falls back locally. Both resident and local QuickJS execution receive cooperative Ctrl+C/termination cancellation so a correctness-preserving fallback can perform command-specific cleanup before returning the interrupted result. A mid-request daemon failure is replayed locally only for requests declared read-only/idempotent; side-effecting requests fail rather than risk duplicate effects.

Native functionality is exposed through the same executable for shader compilation, raw bgfx-compatible `noveltea shaderc ...` forwarding, raw bimg-compatible `noveltea texturec ...` forwarding, headless test/UI-test playback, and package export. `test run <test-id>` executes one authored Test, while bare `test run` executes the whole lowered authored suite through the shared native suite operation. Both reuse the disposable Project-local canonical runtime cache when its relevant persisted inputs, declared Asset sources, compiler identity, and runtime schema identities still match. The same generation also carries a lowered authored-test catalog with independent Test-source freshness, so a Test-only change can republish the catalog without rerunning canonical runtime preparation. Runnable catalog entries contain the native runner kind and lowered playback spec; blocked entries contain readiness diagnostics. Explicit single-test execution of a blocked entry fails because the requested Test did not run; suite execution records it as `blocked` without executing it and does not fail solely for blocked entries. Blocked and infrastructure-error suite entries preserve and surface their actionable readiness/execution diagnostics rather than replacing them with generic status text. Any `failed` or `error` suite entry makes the command exit nonzero; an empty or blocked-only suite succeeds. Suite JSON output preserves deterministic counts and ordered per-test `passed`/`failed`/`blocked`/`error` results, including complete playback reports for executed tests. In `--json` mode the command also includes a `runtimeCache` observation with runtime `status` (`hit`, `miss`, `stale`, or `unusable`) and reason plus `testCatalogStatus`/`testCatalogReason` when runtime reuse reached the catalog boundary; normal human output stays concise and silent about routine cache behavior. Cache persistence is never a prerequisite for playback. The cache is machine-local disposable build state: it is excluded from portable Project export, is not a cross-machine/cross-build compatibility artifact, and requires no user-facing clean or recovery workflow because incompatible or corrupt state simply falls back to canonical preparation. On the standalone ScriptC executable, the static host can conservatively admit a fresh canonical cache generation and execute all four test forms (`test run <id>`, bare `test run`, `test run-spec`, and `test run-ui-spec`) directly through native tooling without importing the QuickJS island. Authored single/suite execution requires both a fresh runtime artifact and Test catalog; stdin `run-spec`/`run-ui-spec` require only the runtime artifact, so Test-only staleness does not force QuickJS startup. The native probe validates cache identity, exact tracked-source mtime/size freshness, conservative source discovery, and artifact/catalog digests but does not parse authored Project/Test schema or hash authored source bytes during ordinary admission. A runtime miss, stale/unusable state, or conservative discovery uncertainty enters the resident daemon's disposable-heavy path when daemon acceleration is enabled: the owner reconciles and snapshots, then a generation-pinned one-job worker performs canonical preparation/playback. In that worker, cache admission is evaluated against the physical metadata carried by the pinned Project generation rather than newer live-disk metadata. Pinned runtime inputs include both canonical/declared Asset paths and all captured candidates in the runtime discovery scopes, including unreferenced Lua files; Test paths remain a separate inventory. Publication rechecks that same inventory against live disk and is declined without failing the command when it no longer matches the pinned inputs. `--no-daemon` retains the canonical local-island fallback. If native execution rejects an admitted cached payload, the host explicitly forces one canonical rebuild/retry through that fallback while leaving the published current generation intact until a replacement generation publishes successfully. Runtime Package export accepts `--allow-localization-warnings` as the explicit unattended acknowledgement for localization quality warnings, plus `--include-unused-assets` and `--include-shader-sources` as developer overrides of the normal pruning/source-stripping policy. The localization override is scoped: it does not bypass technical export errors. `noveltea --help` is authoritative for the installed version's exact syntax.

The #515 native-authoritative Test candidate is exercised under the existing isolated
`NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE=1` gate, not as a second production fallback.
Its local path consumes the C++ Project owner's `shader-preparation` generation and proves
that generation before and after playback. A daemon disposable worker instead consumes
the exact pinned `NativeResidentProjectPreparation` and never reopens the Project from disk.
Both paths use the shared Prepared Runtime Artifact, canonical runtime/Test cache, and
existing native Test/UI/suite runners; the native owner supplies the Project, source
revisions, shader overlays, and admitted Asset-reference closure. Cache hits verify
runtime-artifact evidence against that native Project, and Test-only changes can replace
the catalog without replacing gameplay. Stdin playback can reuse a runtime hit independently
of catalog freshness. A cold stdin build may publish the actual authored catalog but never
requires a runnable authored Test. Cache rejections rebuild and retry once, with publication
protected by live physical-input checks. Native Test failures preserve their per-step report
diagnostics, while malformed native transport or runner loss is an infrastructure failure.
The production cutover and removal of retired TypeScript callers remain under #506.
Run `pnpm -C editor run noveltea:certify:native-cli-tests` against a newly built
installed CLI to compare the native-authoritative candidate with the retired path
on disposable local and daemon Projects. The suite covers authored runtime/UI Tests,
stdin specs, native protocol rejection, Test-catalog-only refresh, corrupt runtime
cache recovery, blocked and failed Tests, failed suites, and empty suites.
It also certifies a daemon-worker source race after snapshot pinning, proving
that newer owner generations cannot change the in-flight Test or receive its
stale cache publication.

Platform publication is a separate command family from Runtime Package creation:

```text
noveltea platform profiles
noveltea platform export --output <path> [--profile <id>] [--template <id>@<build>]
                         [--signing-profile <id>] [--config <file>] [--sign]
                         [--allow-localization-warnings]
                         [--include-unused-assets] [--include-shader-sources]
                         [--check] [--force]
                         [--allow-untrusted-template] [--allow-identity-change]
noveltea platform template list
noveltea platform template inspect <id>@<build>
noveltea platform template install <archive> [--force]
noveltea platform template remove <id>@<build> --force
noveltea platform config init <path> [--force]
```

`platform profiles` prints the exact profile IDs accepted by `platform export`. The read-only query uses scoped Project preparation: it validates only Project identity plus export/profile settings, so malformed unrelated gameplay, localization, Project settings, or other authoring domains do not block profile inspection. Projects do not
store a selected platform profile. Omitting `--profile` is accepted only when exactly one platform
profile exists; when multiple profiles exist, pass `--profile <id>` explicitly. Template and config
commands are installation-scoped and reject global `--project`; profiles and export use normal
project discovery. Template identities use the exact copyable `<template-id>@<build-id>` form.
Automatic resolution succeeds only when exactly one compatible installed template exists.

`platform export --check` is write-free and evaluates the same profile, template, configuration,
identity acknowledgement, and output-collision policy as publication. Existing export-owned
artifacts require `--force`; symlink artifact paths are always refused. Locally sourced templates
require `--allow-untrusted-template`. Human mode reports progress on stderr and the final result on
stdout; `--json` preserves the single compact final-envelope contract without progress events.

Platform export produces the normal packaged artifact by default. The editor-created profile is the
portable target recipe; output path, installed-template choice, and signing identity are execution
choices. `--signing-profile <id>` selects a reusable signing configuration from the shared NovelTea
user export config and implies signing. Bare `--sign` is accepted when exactly one signing
configuration exists for the selected target; otherwise the CLI requires an explicit ID. Results
report whether signing was requested and applied. Publication/store upload is not supported.

Localization quality warnings block unattended Runtime Package and platform publication unless
`--allow-localization-warnings` is supplied. That flag acknowledges only localization quality
warnings for the current export; technical validation, package, template, signing, and staging errors
remain blocking. Unused assets are excluded by default using the same authoring dependency graph as
the editor. `--include-unused-assets` disables that pruning for diagnostic/developer exports, and
`--include-shader-sources` preserves authored shader sources that normal runtime packaging strips.
The latter two are the headless equivalents of the Export pane's Developer Mode options.

The editor and CLI share reusable machine-level state beneath the NovelTea user configuration root. Durable preferences,
export configuration, and shared ComfyUI configuration are sections of `~/.noveltea/config.json`; user ComfyUI workflows
and the disposable verification cache are under `~/.noveltea/comfyui/`.
Export configuration contains toolchain paths plus named Windows, macOS, and Android signing configurations. Signing
secrets remain explicit `env:NAME` references. `NOVELTEA_USER_CONFIG_ROOT` provides a hermetic override for the shared
NovelTea user-config directory, including both export and ComfyUI catalog state, in CI. The optional `--config` file continues to use the
`noveltea.editor-export-local-state` contract as an explicit per-command override; generate a safe,
secret-free skeleton with `platform config init`. `--config` does not combine with
`--signing-profile`.

The editor and CLI also share the per-user template registry at `~/.noveltea/templates`;
`NOVELTEA_TEMPLATE_REGISTRY_ROOT` provides a hermetic override for CI.

The installed Linux x64, Windows x64 and macOS arm64 CLI is compiled directly
from C++, with no Node, ScriptC or QuickJS dependency. The native broker and
Project owners/disposable workers are instances of the same C++ executable.
Agent Kit and built-in ComfyUI sources are embedded at build time, not loaded
from a TypeScript application at runtime. Native production certification
uses independently checked public command outputs, fake-server ComfyUI
effects, exact source/artifact readback and real editor-addon disk witnesses;
there is no longer a Node-versus-ScriptC oracle. See
[production qualification](../architecture/certifications/NATIVE_AUTHORING_PRODUCTION_QUALIFICATION.md)
for the final host-matrix gate.

The native Project lifecycle also handles Project-backed ComfyUI
catalog discovery and Project admission. `comfyui status` and Project-less catalog
operations still do not open Project authoring state. For generated images routed to
Project Assets, the disposable worker stages exact bytes and the resident owner
delegates publication to the native Asset importer. That native transaction validates
image bytes and expected source generation, allocates collision-safe IDs and paths,
and commits Asset source files and YAML records with journaled recovery. Mixed
filesystem-plus-Asset outputs retain the existing daemon broker activation,
rollback and acceptance coordinator. The installed-CLI fake-server certification
checks its own externally observable outputs, source revisions and rollback effects.

Rename/delete use the shared dependency graph and source recognizers. Proven rewriteable source ranges may be changed transactionally; exact manual references block unsafe rename; possible lexical references require explicit acknowledgement; delete's `--force` handling of exact blockers is independent from possible-source acknowledgement. `--dry-run` performs discovery, assembly, validation/preflight, graph/source analysis, and projected transaction planning without changing tracked or ignored project files.

## Validation and Test verdicts

`validate` checks Project authoring structure, references, and supported static semantic rules;
it does not execute Lua or guarantee successful runtime execution. Room pre-commit command eligibility
is a static rule and is checked during validation. Compiled Project admission remains a separate
runtime boundary, and dynamic hook/capability failures are diagnosed when exercised.

For single authored Tests and stdin `run-spec`/`run-ui-spec`, `native.report.passed` is the Test
verdict. A false verdict produces `success:false`, exit code `6`, and `native.test.failed`, while
retaining the full native report. Native `ok:true` means playback produced a report, not that the
Test passed. Cold, cached, daemon, JSON, and human paths share this status precedence; human output
must not print success for a failed Test. Warning diagnostics alone do not fail playback, and a
diagnostic expectation cannot turn a real runtime error into success. See the
[authored-Test contract](../public/concepts/authored-tests.md) for supported warning-path witnesses.

## Persistent validation cache

`validate` reports YAML source coordinates when a logical diagnostic can be attributed to
an authored source field. `--json` preserves the stable diagnostic `code` and logical
`path` while adding `sourceUrl`, `line`, and `column` where available; human-readable
diagnostics display the same location. Missing sparse fields point to the nearest
existing containing source field rather than to a fabricated location. Coordinates
are refreshed from current source on validation cache hits, without making comment-only
edits into semantic Project changes. Validation never edits the source.

`validate` can reuse an unchanged exact disk-authoritative validation result from
`.noveltea/cache/authoring/current.json`. This is deliberately a narrow restart accelerator, not a
persisted semantic Project generation. The strict current contract contains only the Project root,
the exact validation semantic key, the physical source/discovery manifest, and the structured
validation result. It persists no parsed source, validation-check contribution, dependency graph,
source-analysis product, portable Project snapshot, or resident generation identity. The cache has no
independent compatibility version or migration path; an incompatible current shape is simply ignored.

The semantic key explicitly binds every non-Project input that can affect validation: NovelTea/CLI
build identity, Workspace and authoring schema identities, compiler/runtime identity, and the current
validation profile/options/configuration contract. Project-controlled validation settings remain
covered by the physical Project authority itself. A result is reusable only when both that semantic
key and the exact physical authority match.

Freshness uses the shared Project source-inventory mechanism also used by the runtime/Test cache:
native physical file identity, exact byte size, and nanosecond mtime for canonical Workspace files
(including Tests and editor state), declared Asset sources, and conservative candidates under
`records/`, `scripts/`, and `i18n/`. Ordinary hits do not reread/hash authored source bytes. Unrelated
README files do not invalidate. Pending transaction state prevents admission/publication. A same-path
replacement with restored size/mtime is still rejected because its physical file identity changed.

Standalone root-level or explicit-Project hits run entirely in the static/native tier, before QuickJS.
The native probe shares metadata/discovery machinery with runtime-cache admission, verifies the
current contract and semantic key, and returns diagnostics rather than implementing validation.
Upward discovery, missing/stale/corrupt/incompatible state, unsafe paths, unavailable exact metadata,
and other uncertainty use normal TypeScript validation. Publication is best-effort; unwritable cache
state never changes freshly computed diagnostics. Native tooling failures are not memoized.

Cached semantic errors, warnings, informational findings, locations, ordering, exit status, and human
or JSON formatting retain ordinary validation semantics. There is no stale-generation partial semantic
reuse path: a persistent exact miss enters canonical cold admission, while a live Project owner uses
its RAM-resident incremental state. The daemon separately retains the latest exact validation result in
native memory together with the exact native authority checkpoint that produced it. A retained result
contains caller-independent structured validation data rather than already formatted output; the
short-lived caller formats it with that invocation's logical Project root, so aliases may share one
physical cache identity without leaking another caller's path. Every retained exact-result candidate,
including one associated with a live owner, performs a fresh native batched physical observation and
must exactly match its checkpoint before reuse. Watcher delivery can revoke or accelerate a proof but
is never sufficient authority for a hit. Ownerless hits suspend watcher coverage again after the proof;
an active owner may use the native hit only while it has no queued/active/reconciling or
transaction-critical work, so the fast path never overtakes owner serialization. Retained exact results
and their otherwise-unneeded dormant native authority are independently byte-bounded and LRU-evictable;
eviction affects performance only.

Non-resident validation captures source/Asset authority before semantic validation, verifies that
source discovery contains no files outside the assembled snapshot and declared Assets, and preserves
that baseline (including physical file identity) through publication. Later discovery must not attach
new, unvalidated records to an old result. A changed baseline skips cache publication.

After foreground validation is correct, optional exact-result publication is generation-tagged and
best-effort. The TypeScript clean-editor/no-daemon producer starts publication without awaiting it; the
resident daemon coalesces pending native publications and dispatches them only from its idle
maintenance path after a short foreground quiet period. The filesystem write then runs as an
unjoined self-contained best-effort task, so
graceful drain and process termination never wait for optional persistence. Publication writes a
private temporary file and atomically replaces `current.json` only after the new document is complete;
process exit may therefore abandon an incomplete temporary file without damaging the previous valid
cache. Foreground owner work never serializes or writes a semantic cache generation. Corrupt, stale,
incompatible, missing, unsafe, or unwritable persistent state changes only performance and falls back
to canonical resident/cold semantics.
The daemon may create the missing `.noveltea/cache/authoring` directory hierarchy for this optional
publication, but it refuses symlink or non-directory path components rather than following them.
`NOVELTEA_CLI_TRACE=1` exposes standalone admission/fallback and island-import traces without adding
routine cache fields to validation output; `NOVELTEA_CLI_VALIDATION_PROFILE=1` is an
engineering/certification-only trace that emits phase timings and useful-work counts on stderr and does
not alter normal validation output. `NOVELTEA_CLI_SCHEDULER_PROFILE=1` is the corresponding opt-in
resident-scheduler diagnostic surface. It emits one machine-readable `[scheduler-profile]` record for
daemon-routed commands, including the routing class, owner/exact-result/snapshot reuse, changed-path
and native physical-observation counts, generation promotion, worker spawn/queue/retirement deltas,
native boundary calls, retained snapshot bytes, and engineering-only owner/disposable process IDs.
Disposable workers additionally emit `[worker-profile]` with pinned-snapshot read bytes and elapsed
time. These records are stderr diagnostics only when explicitly enabled; normal public human/JSON
output and `daemon status` remain unchanged.
Clean saved editor validation uses this same disk-authoritative `validate` path, so an eligible editor
validation may consume or publish the same exact result used by later CLI validation. The renderer marks
validation session-local whenever Project content, draft state, or pending field input is dirty. The
main process independently requires a coherent active Workspace whose persisted Project content matches
the submitted Project, then captures the exact physical source inventory represented by that Workspace.
The shared CLI/cache path may consume or publish only that captured authority; a physical source change
before admission falls back to session-local validation instead of displaying diagnostics for a newer
disk state. A mismatched or unreconciled save therefore validates in memory only; the previous clean
exact result continues to describe disk until the active Workspace has reconciled the saved physical
state. The cache retains the rich editor diagnostic form, including owner/navigation
metadata, while the public CLI JSON envelope continues to expose its stable CLI diagnostic projection.
Unsaved editor drafts never publish to the persistent authoring cache. The cache is disposable and
excluded from portable Project bundles.

## Machine-readable protocol

Use `--json` on NovelTea command surfaces that support the structured protocol. Expected success and failure produce exactly one compact JSON object followed by one LF on stdout and keep stderr empty. The envelope includes `success`, `exitCode`, and deterministic `diagnostics`; source-aware diagnostics carry stable paths/codes and source locations when available.

Exit categories are:

```text
0   success
2   CLI usage
3   workspace/discovery
4   semantic/preflight
5   mutation/concurrency
6   native shader/tool failure
70  unexpected internal failure
130 interrupted by SIGINT during an active CLI operation
```

Raw `noveltea shaderc ...` intentionally preserves bgfx shaderc's argument/output/return-code behavior rather than wrapping it in NovelTea's JSON taxonomy.

Raw `noveltea texturec ...` preserves bimg texturec's argument/output/return-code behavior and supports the upstream bimg texture formats and conversion options.

## Concurrency and transactions

Non-dry-run structural operations write through the same workspace transaction service as editor structural mutations. NovelTea writers use the project writer lock and exact target revisions; stale or concurrent changes fail closed rather than overwrite. A pending transaction needing recovery also causes a dry run to fail rather than mutate recovery state.

The CLI does not require Electron or an open editor. If an editor is open, its workspace watcher observes the committed source-tree result and reconciles it using the normal external-change rules documented in `project/PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Build and release

The native C++ build identity, executable hash, UI Test runner hash and resource
closure are checked against the actual installed binary, independent of the
build-time JavaScript schema generator. Tagged releases publish `noveltea-<tag>-linux-x64.tar.gz` and
`noveltea-<tag>-windows-x64.zip`, include both in `SHA256SUMS`, and attest their build provenance.
Each archive contains the certified `noveltea` host plus the native UI-test runner and system assets
needed by `run-ui-test`; host editors embed the same certified native-tool closure. Release packages
contain no TypeScript source, first-party source maps, Node installation, sibling shaderc binary, or
retired editor helper. See `BUILD_AND_DISTRIBUTION.md` and the
[production qualification ledger](../architecture/certifications/NATIVE_AUTHORING_PRODUCTION_QUALIFICATION.md).
