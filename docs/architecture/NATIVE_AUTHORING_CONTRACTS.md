# Native Project schema contracts

## Local authoring source-revision expand phase (#578)

Native authoring source revisions are **local byte-identity/CAS tokens**, not
cryptographic attestations. The native parser distinguishes `absent`, legacy
`sha256:` followed by 64 lowercase hexadecimal digits, and `xxh3-128:` followed
by 32 lowercase hexadecimal digits. Unknown algorithms, uppercase hexadecimal,
truncated digests, and malformed tokens fail closed; the algorithm tag is part
of the identity. The native YAML/text/Asset transaction journal verifies the
actual bytes against the supplied algorithm and still compares original bytes
at commit. It never treats equal-length hash strings from different algorithms
as interchangeable.

During expansion, the native source observer and session snapshots **continue
emitting SHA-256 revisions** for existing CLI/editor consumers, while transaction
preconditions can already accept either algorithm. `absent` continues to mean
physical nonexistence, never the digest of an empty source. The clean native
validation cache explicitly records `sourceRevisionAlgorithm: sha256` and
`assetProofAlgorithm: xxh3-128` and discards cache entries with missing or
mismatched algorithm identities. This is a disposable cache compatibility check,
not an authored Project format migration. The later source-revision cutover must
change the source algorithm and invalidate previous evidence before changing
default emission.

Cryptographic SHA-256 proofs for published bundles, exported packages, runtime
integrity, and other security-sensitive contracts remain separate and are **not**
replaced by XXH3. XXH3 is noncryptographic and must never authorize a trusted
download or package-integrity decision.

## Read-only native semantic graph projection (#536)

The host-only `ProjectSession::semantic_graph` is compiled into the resident native
session library and published through the certification Node-API addon. It consumes
the already-normalized native record and YAML/source-analysis contributors instead
of defining a new independent Project schema. This API is read-only and
revision-pinned; `sourceRevisions` reports observer proof (including physical
Asset references) and `textSourceRevisions` reports analyzer content hashes.
The independent `nativeSemanticGraphSchema` Zod DTO is strictly transport
validation, not a TypeScript Project-authoring validation or derivation fallback.
No generated Project operation contracts are introduced by this query, so no
change to `generated/contracts.json` is required. The endpoint is not exposed
on the ordinary CLI or production renderer. Production authority retirement and
the editor/CLI atomic transition remain the separate #521 delivery boundary.

## Ownership and scope

Zod 4 remains the authoritative declaration of Project shapes and Zod-level normalization and
refinements. `editor/scripts/native-schema/sources.ts` inventories the effective Project, every
record family, source-reference schemas, and the actual workspace manifest, Traits, tracked/local
editor, and split localization source schemas. These are not a second handwritten schema hierarchy.
One additional `ZodRecordKeyCertification` witness exists only to test normalized record-key collisions
while real localization key validation still has an unimplemented native operation.

`tools/project_authoring/` is a **parallel, certification-only host boundary** for #475 / #474.
It does not replace workspace admission, Project-wide semantic validation, editor working state,
CLI validation, or the authoring compiler. No production caller uses it. Later family tickets must
implement their registered native operations and cross-record validation before native admission can
be authoritative. The #475 schema-validation boundary accepts decoded JSON-shaped records.
The parallel source-aware YAML codec added in #476 does not change the TypeScript production
workspace's current parsing, default expansion, or comment-aware persistence ownership.

## Native YAML source round-trip certification (#476)

`tools/project_authoring/yaml_codec.hpp` exposes a host-only libfyaml reader and
source-aware edit API, with a pinned static libfyaml dependency. Opening a source retains its
exact bytes and returns the JSON representation of its **explicit** values plus physical JSON
Pointer locations, byte offsets, line/column, and comment presence. Omitted YAML fields are
not synthesized as JSON nulls: sparse default expansion and typed-reference normalization
remain the independent authoritative TypeScript reference until subsequent migration tickets.
The parser and its owned input bytes stay alive together for the full AST/token traversal.

For selected scalar field edits, the codec replaces only the original source token span,
reopens the resulting YAML, and preserves unrelated source bytes. Existing unannotated values
can be omitted when changed to a caller-supplied declared default; Keep retains explicitly
commented defaults, and Remove drops the selected comment with the affected default. Supported
insertion of missing mapping fields preserves their neighbors. Changes that would risk losing
comments on a complex subtree or require unsafe multiline source rewriting fail closed rather
than silently discard prose. Complete generic structural mutation, whole-Project admission,
transactional persistence, and user-visible editor/session integration belong to later tickets.
Every edit also verifies the reopened document has the requested target value and unchanged
sibling values, mapping/sequence container types, and array lengths. Omitting the first field
of a sequence mapping preserves its sequence marker. Root document-header comments are not
treated as annotations owned by the first field; omitting a field with Remove deletes its
owned preceding comments without transferring them to a neighbor. Explicit `!!str` tags
override implicit scalar typing in both the native and restricted TypeScript readers.

`noveltea-yaml-certify` provides a native CTest and an isolated `--open` / `--edit` JSON
certification interface. `editor/src/renderer/test/native-yaml-parity.test.ts` compares it
with the #449 restricted YAML reader and sparse Room codec, including an actual Feature Lab
Room, nested typed reference edits, comments, retained defaults, unsafe scalars, and source
reopen equivalence. The existing TypeScript implementation remains authoritative.

## Native resident Room session proof (#477)

`room_session.hpp` adds a **parallel single-Room Project session** opened from an existing
`records/rooms/<id>.yaml` file. It owns the admitted physical disk bytes/revision and a
separate dirty working JSON record plus monotonically increasing working revision. Generic
RFC 6901 add/replace/remove batches are applied transactionally to a copied working value:
bad pointers, malformed JSON, missing targets, and stale working revisions leave state
unchanged. A successful change publishes the affected `rooms/<id>` owner and a diagnostic
addition/removal delta; read-only validation never rewrites source. Representable invalid
IDs remain in working state with a scoped `room.id_mismatch` diagnostic.
Such a mismatch is not writable: Save rejects it without changing disk, even though
dirty working state and the repair diagnostic remain available.

Explicit single-Room Save checks the caller's admitted disk revision and compares complete
source bytes against the baseline, then applies queued edits with the #476 source-aware
codec. The source must reopen with the exact intended **explicit** values or Save fails
without discarding dirty state. Supported map-field insertions, scalar replacements and
safe map-field removals preserve other YAML fields and comments. Complex annotated subtree
rewrites and structural sequence insertions/removals fail closed rather than risking source
corruption. Since #495, this one-source Save uses the shared transactional writer, rather than
performing a direct unjournaled rename. The remaining editor conflict/reconciliation coordinator
is a later #474 responsibility.
Source revisions use the same `sha256:<hex>` byte digest as the TypeScript
Project Workspace; exact disk CAS authorization also depends on the full byte comparison.

For #477, the generator imports the existing TypeScript Room sparse-source omission
defaults into committed `contracts.json`. The native source projection uses the generated
schema graph for typed references, Condition scalar shorthand, family-inferred `data.kind`,
nested omissions and variant branches before validating the expanded record. The native
registry implements the Room-reachable semantic operations for local/default Property
declarations, Hotspot bounds, loop playback and Material parameter literals. Valid Rooms
return their actual native normalized values; invalid Room fields produce scoped native
diagnostics and remain editable without forced Save. This is **Room-only** source admission:
other Project families and cross-record analysis await later #474 tickets. The existing
TypeScript/Zod path remains authoritative in production. `noveltea-room-session-certify`
exercises a real Feature Lab Room through open, dirty patching, semantic diagnostics,
scoped save, reopen, removal, revision rejection, and byte-preserving comments; the
optional `native-room-session-parity.test.ts` compares the actual native normalized
saved result to TypeScript/Zod normalization and checks the session's actual affected-record
delta. No editor, CLI or runtime path uses the native session yet.

## Native Room, Map, and Hotspot domain certification (#480)

The host-only sparse-source projector now expands the generated **Room and Map**
omission defaults, inferred `data.kind`, scalar `always` Conditions, and bare
typed references. `RoomSession::open_map` exposes the same versioned working
state, source-aware transactional Save, exact disk revisions, and normalized
reopen guarantee as the Room adapter. Generic JSON Pointers support
`@<id>` array segments, resolved against unique current IDs before each patch;
ambiguous or missing targets reject the entire edit batch.

`validate_room_map_local` checks locally provable invariants on normalized
single-record working values without treating unrelated missing Project records
as errors. `validate_room_map_project` accepts an assembled effective Project
to check cross-record references, exits, reciprocal Map connections, duplicate
Map locations, placement and camera geometry, presentation order, lifecycle
command eligibility, Hotspot image and subject/feature/exit ownership, and
Interactable hotspot source and highlight constraints. Its diagnostic paths
use Project-absolute JSON Pointers and errors are separated from informational
or warning diagnostics. The native schema registry also validates strictly
increasing hotspot motion-keyframe times. Resolved Material roles and Hotspot
sampler-interface requirements follow the same generated engine Material preset
registry as the TypeScript validator, including inherited Material bases.
Room cast references resolve the Character's selected/default Profile and Pose,
as well as explicitly selected Expression, Appearance, and Idle; environment
Animation motions resolve against the referenced Animation. Room lifecycle and
Map visibility Conditions compare values against the referenced Variable's
declared type, nullability, and normalized Enum membership.

`noveltea-room-map-certify` and the optional
`native-room-map-parity.test.ts` compare sparse Map and Room effective values
and representative domain diagnostics with the current TypeScript validators.
The Map session test patches an ID-keyed nested field, transactionally saves
commented YAML and checks normalized values on reopen. Compiled-value
equivalence is checked through the existing TypeScript authoring compiler
against the native-reopened normalized record, rather than introducing a
second gameplay or presentation compiler. These boundaries remain **parallel
and certification-only**: the editor, CLI, runtime and TypeScript semantic
validator have not cut over to them.

The certification-only Node-API worker adapter of #496 is documented in
`docs/editor/project/NATIVE_AUTHORING_WORKER.md`. It consumes the native
`ProjectSession` and its verified physical source observations without
replacing the authoritative TypeScript editor Project session or CLI daemon.

## Native physical source authority (#494)

The certification-only `ProjectSession` now owns its own `SourceAuthority` under
`tools/project_authoring/`. `observe_sources()` reports added, changed and removed
Project-relative physical sources independently of dirty working-state revisions.
An exact SHA-256 digest of on-disk bytes, not a watcher notification, determines
whether a tracked physical source changed. The Project's own scoped Save adopts
its verified new manifest revision so the subsequent watcher observation is a
no-op for that file. An independently opened Project session still sees the
same Save as an external change.

Discovery walks only tracked `records/`, `scripts/`, `shaders/`, and localization
source directories, plus canonical fixed fragments. Asset record references,
attachments and manifest distribution notices add **exact referenced paths**
to physical observation, even when their binary bytes live outside `assets/`.
Unrelated Project-root documents and binary files do not enter the inventory.
Linux owns per-session inotify directory registrations as hints; on other hosts
explicit observation remains safe without relying on native notifications.
The observer verifies candidate source bytes rather than treating a quiet
watcher, unchanged timestamp, or cached semantic snapshot as proof. Watcher
overflow/lost coverage, system resume and directory replacement trigger
conservative rescan. A failed or uncertain scan retains the previous authority
baseline and cannot declare the old snapshot current.

Known, malformed `records/assets/<id>.yaml` files are attributed to their
physical Asset owner rather than promoting an otherwise provable source tree to
global watcher uncertainty. The observer still hashes those exact invalid bytes
and retains their last verified Asset source associations for watcher coverage.
It reports `scoped_authority` and per-path invalid-source errors but does not
claim full-Project `authoritative` or `unchanged` status while such errors exist.
Structural/discovery failures without a safe owner still invalidate global
authority; subsequent repair restores complete proof.

This ticket publishes **physical path deltas only**. Reconciliation of those
verified changes into the dirty native working Project, multi-file transaction
coordination and CLI/editor production cutover remain separate follow-on work.
The native Project session fixture exercises missed events, dynamic Asset paths,
byte changes with restored timestamps, missing files and recovery, independent
session ownership, directory replacement, and own-write suppression without Electron.

## Native transactional YAML persistence (#495)

`yaml_transaction.hpp` adds `YamlTransactionService`, used by both the parallel
Room and Project manifest Save paths and available to later multi-record native
sessions. Each scoped operation supplies exact admitted baseline bytes/revision
and one or more source-aware YAML edits (or an explicit YAML create/delete).
`prepare` compares current disk bytes with only the selected targets and returns
a physical-revision-bound review of the proposed bytes and affected comments.
Disjoint external changes within a YAML mapping can be rebased by comparing
edited JSON Pointer values against the original source; overlapping paths,
sequence changes, unavailable targets and malformed sources fail closed.
The editor's Keep/Remove/Cancel decision must match the preflight decision at
`commit`; Keep retains intentional commented source defaults. Existing native
Room per-edit Keep/Remove semantics also pass through this writer.

`commit` uses `.noveltea/transactions/.writer-lock` and the same v1 journal
shape as the existing TypeScript transaction service. Before/after exact bytes
are staged and durably synced in an unpublished preparation directory before
atomically publishing the journal; an interrupted unpublished staging area can
be discarded without touching source files. The journal records `prepared`, `writing`,
`committed` and `rolled-back` states and a per-target completion list. A
multi-file Save is one recoverable group, not an unsafe unjournaled series of
renames. Only a proven-dead writer owner can be reclaimed under an exclusive
reclaim guard. Recovery validates every observed physical revision against
the recorded before/after states *before* rolling back an incomplete group or
finishing a committed one. Malformed journals, an unverifiable lock, or an
unknown concurrent revision remain in place for explicit intervention.

Callers can attribute invalid sources to their affected save targets or report
unattributable structural uncertainty to fail all writes closed. The Project
manifest session also blocks Save while its owned watcher authority is
uncertain, but passes attributable invalid-source paths to the transaction
writer so independent manifest edits remain savable and affected targets fail
closed. Windows durability flush handles require write access; the Windows CI
native authoring certification now exercises grouped commits and recovery.
Normal Save performs neither a Project-wide open nor hashing of
unrelated binary Assets. This is certification-only and does not cut over
the production editor/CLI transaction or conflict-resolution code.

`native_authoring_yaml_transaction` tests same-file external rebase, stale
review rejection, commenter choices, commented defaults, scoped invalidity,
target create/delete, grouped Save/rollback, writer contention, real Linux
process-death recovery, unknown third-party bytes, repeated recovery, and
malformed journals. Runtime Feature Lab is not applicable to this
host-only persistence invariant; the existing Feature Lab Project provides
the full Project/Room source certification fixtures.

## Recursive Conditions and Gameplay Commands (#484)

The host-only contract generator exposes `Condition` and `GameplayCommand` as
standalone roots from `authoring-flow.ts`. Native parsing traverses their
recursive branches without executing a command. For ordinary `z.union` command
variants, the generated literal `kind` (and `mode` when needed) determines the
branch before validating its fields. This produces diagnostics on the actual
nested field instead of reporting an unrelated union alternative. The same
generated branch selection drives sparse Room YAML normalization; scalar
`always` Conditions remain source shorthand only.

`native_authoring_flow` compares accepted/invalid Condition and Command cases,
all admitted Command variants, recursive `if` programs, selected diagnostic
codes/paths and normalized values with the authoritative Zod schemas.
`native_authoring_flow_contract_generation` fails the CTest gate when generated
artifacts or native-operation registrations are stale. The Node-backed
differential runs when Node is installed; the Node-independent
`native_authoring_flow_operations` gate always checks both complete native
contract graphs. Every operation reachable from either root is checked by the
native validator before parsing, including operations on branches not exercised
by a specific fixture. The Room/Project
session certification exercises a nested authored command edit, invalid working
diagnostics, recovery, comment-preserving Save/reopen and Project-absolute owner
paths against the existing Feature Lab source.

The #476 YAML codec continues to fail closed for unsafe wholesale multi-line
mapping replacements; #484 certifies supported nested edits rather than
introducing a second YAML rewrite path. No editor/CLI runtime cutover or native
Gameplay Command execution is introduced. Feature Lab authoring coverage is
already provided by its Room lifecycle and Interaction programs; these tests
add validation coverage without changing runtime-visible fixtures.

## Generation

Native host CMake configuration generates contracts automatically into
`<cmake-build-dir>/tools/project_authoring/generated/` (or
`<cmake-build-dir>/generated/` for standalone host CMake configuration).
Node 24 and the pinned pnpm dependencies are required on the **host** for
the initial generation; subsequent native compilation uses only generated data.
For constrained compiler containers, pre-generate all three files in the target CMake
binary directory and configure with `-DNOVELTEA_NATIVE_SCHEMA_PREGENERATED=ON`.
Release CI verifies the host-generated outputs before mounting them into its Linux
ABI-floor container. That opt-in is not the default for ordinary native builds.
Schema source changes automatically trigger CMake reconfiguration. The generator
does not rewrite unchanged outputs, preserving incremental C++ builds.

For an independent generation/reproducibility check from the repository root:

```sh
node editor/scripts/generate-native-schema.mjs
node editor/scripts/generate-native-schema.mjs --check
```

Those direct commands use the ignored `build/native-schema/generated/` directory.

The generator is tested against the lockfile's Zod **4.4.3**; changing that version fails generation
until the visitor and differential tests are reviewed. Structural JSON Schema comes from Zod's
public `toJSONSchema` API, with input semantics and explicit tuple cardinality. A narrow visitor over
the documented Zod Core definition/check interfaces inventories semantics and generates traversal
metadata. Recursive lazies use the public cached `unwrap()` interface rather than invoking getters
independently. Generation therefore does not rely solely on private Zod representations or the
reference-document exporter's deliberately permissive `unrepresentable: 'any'` behavior.

Ignored build-tree outputs are deterministic:

- `contracts.json`: structural JSON Schemas, node/child relationships, ordered check stages, roots,
  semantic operation references, literal defaults, Room/Map sparse-source omissions,
  and Material preset roles/sampler contracts;
- `project_types.hpp`: C++20 structural records, enums (with exact numeric/boolean literal values), tagged `std::variant` unions, optional fields,
  arrays, maps, and boxed recursive nodes, without a JSON-library dependency;
- `operations.hpp`: stable native operation IDs and kinds.

The artifacts are same-build generated implementation data, not an independently versioned protocol.
`--check` rejects changed, missing, or unexpected artifacts. `--output <directory>` supports isolated
regeneration/staleness tests. The editor `check` task and Build CI verify reproducibility.
CMake generates these artifacts during native host configuration and embeds only the generated
build-tree copies; the subsequent C++ compilation does not execute Node or Zod.

## Semantic registration and failure policy

`native-schema-operations.ts` owns the explicit operation-ID/kind catalog. Schema declarations attach
named registrations to the exact Zod refinement, overwrite, or transform, preserving the original
instance and inferred TypeScript shape. Built-in JSON literal defaults use `value.default`, with
values recorded per node. Non-JSON or observably dynamic defaults fail generation.

Trimming and UTF-16 string length are explicit operations. JSON Schema measures Unicode code points,
whereas Zod/JavaScript length measures UTF-16 units: generated structural schemas therefore carry
`x-native-utf16-length` metadata instead of misleading `minLength`/`maxLength` keywords. The ordered
native check stages enforce the original trim-versus-length order. Arbitrary transforms,
super-refinements, overwrites, unsupported nodes/checks, and unknown operation IDs fail generation
rather than silently weakening the contract.
Coercing primitives (`z.coerce.*`) fail generation until explicitly supported by registered
native normalization operations; JSON Schema input types alone would lose coercion semantics.

Registration is **not** an assertion that a native implementation exists. Native validation first
walks every reachable branch and rejects a contract requiring an unimplemented operation, even if the
provided value does not exercise that branch. This prevents a partially ported Project family from
appearing admitted. The implemented representative operations are literal defaulting, ECMAScript
Unicode whitespace trimming, UTF-16 length, empty Lua dependencies, and duplicate Lua dependency
rejection. Other catalog operations belong to the follow-on family migration tickets.

## Native structural validation and diagnostics

Pinned jsoncons 1.10.0, commit `d273865feb0d7e35a757c805dc4d1d9320eb6b72`, validates the
Zod-exported local structural stages. The adapter navigates generated recursive/discriminated-union
branches before invoking those validators, so a bad nested Condition reports its JSON Pointer rather
than a generic root `oneOf` error. Missing values remain distinct from explicit JSON null. Union
candidates and normalized output are isolated; opening/validation never rewrites source input.
Record parsing reproduces JavaScript's array-index-first key enumeration and rebuilds output using
normalized keys, including Zod's last-write-wins behavior when input keys normalize to one name.
Explicit Lua dependency uniqueness uses the kind-specific semantic-field tuple from
`serializeLuaExplicitDependencyTarget`, including nested owner fields, rather than JSON object order.

The public certification boundary in `contracts.hpp` exchanges serialized records/results and typed
diagnostics, without leaking jsoncons types. It reports unsupported operations, malformed input,
structural errors, and traversal limits as failed results. Diagnostic prose need not match Zod; the
parity matrix compares admission, effective values, and useful nested ownership paths. Unknown-key
errors name the offending key (Zod itself reports the containing object).

The host-only library is not linked, installed, copied, or packaged into any engine/player/export
template. It deliberately uses the normal host C++ exception model and catches failures at its public
boundary. Its dependency and exemption are recorded in `CXX_RUNTIME_DEPENDENCY_POLICY.md`.

## Staged CLI and daemon command authority (#505)

The installed standalone CLI and existing daemon still use their public routing and JSON envelopes.
The candidate native Project command transport is enabled **only** when both
`NOVELTEA_CLI_CERTIFICATION=1` and `NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE=1` are set.
The candidate is deliberately not production-authoritative until #506 completes the coordinated
cutover; no permanent legacy fallback is intended. Native Project commands handle Project lifecycle,
entity inspection and mutations, usages, Assets, formatting, and localization workflows. Native
Project admission and source edits do not go through the TypeScript Project writer in this mode.

Native mutation planning supplies exact source revisions and source-generation proofs for follow-up
commits. The caller passes these back unchanged; native transactions recheck authority. Transport
errors never trigger replay of a possibly completed write. Native Project sessions are retained within
the existing daemon Project-owner process and revalidate physical source revisions; the editor's dirty
working Project remains independent of the CLI disk authority. The downstream compiled-Project,
shader, Runtime Package, authored Test, and platform export stages must retain their established
semantics during the coordinated cutover. Public validation/compiler diagnostics and full command
family parity remain explicit certification gates, not assumed consequences of native YAML admission.

The targeted adapter regression suite is
`editor/src/renderer/test/native-cli-project-lifecycle.test.ts`. The physical Project command
differential is `editor/scripts/certify-native-project-command-differential.mjs`; its native CLI
counterpart is `noveltea-cli-native-certify`. The installed transport differential is
`editor/scripts/certify-native-cli-project-routing.mjs`: it compares public envelopes and exit
codes for native and legacy Project commands, plus separate daemon owners and malformed sources.
These do not replace the full CLI/daemon certification suite or Windows/macOS release verification.

The local (`--no-daemon`) `shaders compile` candidate now consumes a native complete Project plus
captured shader/include text through the same downstream shader compilation and reflection pipeline
as the current CLI. Native source-generation proofs bracket preparation and command completion;
a changed, added, or removed source refuses the result rather than retrying through TypeScript.
Compiler outputs remain disposable content-addressed build/cache products, not accepted publication
when the final proof fails. The daemon shader path deliberately remains on the established pinned
snapshot transport: native shader preparation must be carried in that immutable owner generation
before that transport can be staged, rather than reopening newer live disk in a disposable worker.
The adapter regression seam is `editor/src/renderer/test/native-cli-shaders.test.ts`; the installed
routing differential compares blank-Project and Feature Lab local shader results and invalid options.

The disk-only native command owner also discards sessions after writes or generic scoped-edit
planning/rejection, and reopens after physical deltas/uncertain coverage. This prevents either dirty
working patches or stale inspected-record baselines from leaking into the next disk command while
unchanged read commands retain their owner. The native CLI certification covers sequential scoped
edit failures/commit and formatting/reinspection on one owner.

Remaining #505 gates: native-authoritative public `validate` with its complete font-coverage,
distribution-notice, dependency and shader/reflection stages; immutable native preparation transport
for daemon heavy jobs; authored Test, Runtime Package and platform-export staging; wider error/exit
and all-family parity; full cross-platform certification. Production cutover and removal of the old
TypeScript authoring dependency remain coordinated with #506.

## Native CLI Agent Kit and Projectless Tools (#546)

The unshipped `noveltea-native-cli` now owns `agent sync [--fix]`, raw `shaderc` /
`texturec`, `media-tool check`, and `daemon status|stop` without invoking ScriptC or
JavaScript at runtime. `agent sync` first uses native Project workspace preflight, then
installs a complete, hashed Agent Kit from its embedded build-time payload. The payload is generated
by the authoritative TypeScript/Zod `createNovelTeaAgentKitPayload()` as part of the **native
CLI build**; no runtime source-tree lookup, generated-file re-derivation, or TS schema traversal is
required. The embedded manifest retains schema references, compact references with IDs/defaults,
system Layout assets, and authoring provenance. Synchronization detects missing, changed, or extra
files and replaces the directory through staging and a rollback backup. `--fix` manages only the
AGENTS.md bootstrap block using atomic file replacement, preserving other user instructions;
creation of the Project's missing `.gitignore` also uses atomic replacement.

The native FFmpeg check resolves an installed pinned binary relative to the relocated executable,
or uses an absolute `NOVELTEA_FFMPEG` override, and verifies identity, configuration, encoders,
and protocols before returning the existing public tool envelope. Native daemon status/stop use
the existing daemon broker protocol and its build identity, never a second daemon implementation.
Raw shaderc/texturec continue forwarding arguments and process exit status to the embedded tools.

Run `cmake --build --preset linux-debug --target noveltea-native-cli` and
`ctest --test-dir build/linux-debug -R 'native_cli_(agent_tools|public_contract)' --output-on-failure`
to certify the relocated candidate, including hash/provenance parity, bootstrap repair,
idempotence, and Projectless command errors. This does not ship the candidate as the production
CLI or close the remaining #506 coordination gates.

## Native CLI Platform Commands (#545, partial)

The unshipped C++ CLI candidate now handles `platform profiles` through the
native scoped Project export preflight. It does not use a second YAML reader or
invoke the TypeScript CLI. The candidate also handles the machine-local
`platform template list|inspect|install|remove` and `platform config init` commands.
Template installation verifies archive entry paths and links, descriptor
inventory and SHA-256 bytes, named engine license index and SBOM, and publishes
using a staged directory with previous-installation rollback on ordinary errors.
Installed templates are reverified on inspection and corrupt entries are not
considered compatible. The template registry remains compatible with the editor's
existing `~/.noveltea/templates` layout and its test-only registry-root override.

Windows player resource customization has begun as a dedicated, host-portable
C++ component (`native_cli_windows_pe.*`) built into the unshipped candidate.
It uses Apache-2.0-licensed LIEF (minimum 0.17.3, with a SHA-256-pinned source
fallback) rather than `resedit` or Win32 `UpdateResource`. The component
replaces `RT_ICON` / `RT_GROUP_ICON`, creates a complete `VS_VERSIONINFO`
resource with UTF-16 localized strings and numeric versions, and writes the
Windows application manifest. It preserves other PE sections and imported
DLLs; the unsigned native Windows export command now invokes it. Its initial
cross-host validation used a real Windows player executable only in a local
temporary workspace, not a committed fixture or permanent test.
The permanent `native_cli_windows_pe_resources` regression instead builds a
small synthetic PE and ICO at test runtime, then independently reads back the
resulting icon, version and manifest resources.

The native CLI now runs `platform export --check` through native scoped
Project preparation, profile/template compatibility, trust and collision
acknowledgements, source-generation proof, and editor-local identity checks.
It never invokes compilation or publication in check mode. The non-check
Windows path can produce an **unsigned** portable output directory, ZIP,
optional symbols ZIP, customized GUI executable, `game.ntpkg`, player config,
license mount, and export file-inventory manifest. The only compiler and
package writer used are the existing native authoring and package components;
archive and icon generation reuse the host-native tooling APIs. The staged
artifact set is activated with a recoverable native publication journal, and
the previous complete set is restored after interruption before any subsequent
mutating export. The success identity is merged with the current ignored
editor-local state after accepted publication; source changes or concurrent
editor-state writes are not silently accepted.

During development, a real local Windows devtools player template was
imported into an isolated registry and exported from a Linux native CLI.
Independent inspection verified the PE resources, package SHA-256, all 223
distribution manifest file hashes, and both ZIP archives. The user-provided
template ZIP is neither tracked nor used by any permanent test. Existing
permanent synthetic-PE and native template/preflight/recovery tests are the
repeatable coverage; actual Windows player **execution** and signed-export
acceptance remain outstanding.

This is **not completion of #545**. Direct C++ `platform export` still needs the
remaining Linux/macOS/Web/Android target staging, Windows and other platform
signing/configuration semantics, cancellation integration, full profile-policy
and CLI diagnostic parity, and cross-host platform output witnesses before
closure. Windows output already uses native generation-pinned compilation and
multi-artifact publication but has not been qualified as production-ready.

Run `cmake --build --preset linux-debug --target noveltea-native-cli` and
`ctest --test-dir build/linux-debug -R 'native_cli_(platform_commands|public_contract)' --output-on-failure`
to exercise the currently migrated public command surface. The platform command
test uses a relocated native executable and isolated registry/config roots.
The PE resource test additionally runs with
`ctest --test-dir build/linux-debug -R native_cli_windows_pe_resources --output-on-failure`.

## Verification

A standalone host build avoids the renderer and all runtime dependencies:

```sh
cmake -S tools/project_authoring -B build/native-authoring -DCMAKE_BUILD_TYPE=Debug
cmake --build build/native-authoring
ctest --test-dir build/native-authoring --output-on-failure
NOVELTEA_SCHEMA_CERTIFY="$PWD/build/native-authoring/noveltea-schema-certify" \
NOVELTEA_YAML_CERTIFY="$PWD/build/native-authoring/noveltea-yaml-certify" \
NOVELTEA_ROOM_SESSION_CERTIFY="$PWD/build/native-authoring/noveltea-room-session-certify" \
NOVELTEA_ROOM_MAP_CERTIFY="$PWD/build/native-authoring/noveltea-room-map-certify" \
  pnpm -C editor exec vp test run \
  src/renderer/test/native-schema-generation.test.ts \
  src/renderer/test/native-schema-parity.test.ts \
  src/renderer/test/native-yaml-parity.test.ts \
  src/renderer/test/native-room-session-parity.test.ts \
  src/renderer/test/native-room-map-parity.test.ts
```

The normal host-tools graph also builds the library and certification executable. Web, Android, and
other cross-compiles cannot build this directory. `types_compile.cpp` compiles the committed complete
C++ type artifact. The real Map fixture exercises recursive Conditions, default arrays, a nullable
trimmed style, and Lua dependency overwrites/refinement. Negative variants cover nested scalar and
discriminator errors, explicit-null rejection, strict keys, and duplicate semantic targets.
The certification-only record fixture verifies normalized keys and collision order; generator
tests also verify literal projections and plural/select operation-ID registration.

The native differential tests skip explicitly when `NOVELTEA_SCHEMA_CERTIFY` is not supplied; Build
CI always supplies it after building the executable. Generator/staleness tests run without a C++
build. Feature Lab is not applicable: this foundation has no runtime-observable or editor UI behavior.

## Native validation performance audit (October 2026)

`contracts.cpp` now uses one immutable `Contracts` instance. Its generated schema nodes are
indexed once with pointers into its unmodified JSON document; the compiled structural validators
and generated-root operation-support diagnostics are also reused. Unsupported generated operations
still fail closed, including operations in branches not selected by the input. Source projection,
union selection, defaults, normalization, and diagnostic ordering follow the original paths.

For repeatable read-only cold Project timing, build the standalone authoring Release target and run:

```sh
cmake -S tools/project_authoring -B build/native-authoring-host -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build/native-authoring-host --target noveltea-project-session-certify
build/native-authoring-host/noveltea-project-session-certify --profile-cold-validation tests/projects/feature-lab
```

The profiler reports Project opening, cold `validate_project`, total elapsed milliseconds, valid
status, diagnostic count, and rechecked record count. Feature Lab contains 294 record YAML files
and 306 checked owners. Four sequential fresh-process Release runs after indexing measured
**543–560 ms opening**, **815–842 ms validating**, and **1,358–1,402 ms combined**. This benchmark
is not directly comparable to the earlier approximately 58-second *Debug* shader-preparation
certification, which performs additional work and uses a different build mode.

In the standalone Debug build, two fresh-process runs measured **4,379–4,462 ms opening** and
**7,496–7,615 ms validating** (11.87–12.08 seconds combined). The earlier Debug shader-preparation
instrumentation measured about 4.9 seconds opening and 36.9–37.8 seconds validating, implying an
approximately 80% reduction in the validation stage. These are the same *stages* but not an
identical executable/entry point, and should not be presented as a controlled end-to-end comparison.

Temporary phase probes attributed approximately 205 ms of opening to manifest admission/inventory,
165 ms to source-authority initialization, 74 ms to text-source digesting and indexing, and 102 ms
to localization admission. Within validation, about 500 ms was source-record admission, 222 ms
semantic snapshot computation, 70 ms spatial graph validation, and 38 ms diagnostics/final source
observation. Instrumentation was removed.

The follow-up deep profile measured **1,557** libfyaml decodes on 307 YAML files (about 567 ms
inside decoding): 307 inventory, 354 source authority, 346 localization, 157 initial text-owner
indexing, 360 record opens, and 33 other. The native Project session now owns a bounded **16 MiB
exact-byte YAML decode cache** shared by these synchronous operations. It caches physical source
locations and failed parses as well as accepted sparse JSON; equal bytes may share a decode across
paths, but a different byte sequence cannot. The cache never supplies filesystem authority:
`SourceAuthority` still independently reads/hashes source files, checks source membership, catches
watcher overflow, and performs its final generation check before publishing validation results.
Standalone YAML reads remain uncached, and nested Project decode scopes restore the previous cache.

`index_text_owner` tracks last indexed source content so an unchanged reindex no longer evicts the
localization validation cache. Referenced Asset normalization is keyed by a fresh disk YAML hash,
with dirty editor records preferred. Asset snapshots are cached only while their physical source
and attachment **membership/containment** proofs stay identical; Layout snapshots include the
exact current companion RML, RCSS, and Lua contents. Physical media changes propagate from
`SourceAuthority`'s reverse Asset-reference map to resident validation contributors even if Asset
YAML remains unchanged. The complete-Project spatial validator consumes already-normalized Room
and Map data without validating their structural schema again; its independent public entrypoint
retains full malformed-input checks.

Three fresh-process Release runs after the initial integrated changes measured **808–814 ms**
combined opening and validation (approximately 301–306 ms opening, 504–509 ms validation), with
the original 27 diagnostics and 306 rechecked owners. These figures are not a substitute for a
Debug end-to-end shader preparation benchmark or for a post-merge reprofile on the final build.
The cache also intentionally does not persist normalized JSON or depend on mtime-only identities.

### Project generation source registry and normalized dependency index

The subsequent consolidation makes `SourceAuthority` own immutable
`VerifiedProjectSource` entries: exact observed bytes, their SHA-256 revision,
and the YAML decode (including invalid-source errors and locations). On each
physical observation it **re-reads and rehashes** every relevant text source,
reusing a prior decoded entry only when the exact revision matches. Binary Asset
sources still use their separate physical membership/change identity and are
never read into this registry. New or changed source entries replace their
predecessors; `acknowledge_own_write` never makes stale source evidence current.

Scoped admission uses this registry for tracked records, source text indexing,
localization fragments, structured messages, and Dialogue Cue scans. Outside a
Project's verified generation, standalone/editor paths retain their regular
disk reads. Scoped reads cannot establish currentness on their own: the native
Project always reobserves physical authority **after** semantic validation and
rejects publication if sources changed. Invalid YAML remains attributable to
its precise physical owner; working overlays always take precedence.

`ProjectSession` also retains each validated owner's normalized result and
its conservative scalar/property-key reference tokens. Updating or removing a
record withdraws its old reverse edges; transitive invalidation follows the
reverse index rather than parsing and searching every normalized record on
each change. The internal working Project resolver uses these accepted values
only while the validation view is active. Missing, invalid, and unsaved records
continue through the existing scoped resolution/conflict rules. The Explorer's
independent inventory walk remains necessary to include **untracked files**;
the source registry is deliberately limited to physical authoring inputs.
