# NovelTea CLI

> **Current architecture (#551):** The installed `noveltea` CLI is a direct
> C++ executable. ScriptC, QuickJS, the embedded TypeScript island, and the
> scripting host/FFI bridge have been retired. The editor still uses TypeScript
> and build-time Zod schemas; authoring, broker owners and disposable CLI
> workers execute native commands. The earlier candidate and ScriptC runtime
> records are in the [migration archive](../archive/reports/NATIVE_CLI_CUTOVER_HISTORY.md).

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
native operation dispatch and JSON stdout. This is not part of the 42-path
public CLI inventory and does not start a ScriptC host or JavaScript runtime.

## Completed migration history

The pre-#551 direct-C++ candidate, partial compiler parity, native mutation trials,
ScriptC/QuickJS cutover gates, and dated certification notes are preserved in the
[Native CLI cutover archive](../archive/reports/NATIVE_CLI_CUTOVER_HISTORY.md).
Those candidate-only switches and historical acceptance states are not supported
production operation. The current 42-path public command contract is verified by
`node editor/scripts/certify-native-cli-inventory.mjs`, sourcing the canonical C++ help
contract at `tools/editor_tool/native_cli_help.txt`. The obsolete `editor/src/cli`
TypeScript command engine and its differential CI oracle are retired; Electron
TypeScript UI and build-time Agent Kit/schema generation remain supported. Production qualification
runs `pnpm -C editor run noveltea:certify` with the real native authoring addon.

## Standalone narrative catalogs

`noveltea [--json] narrative validate <catalog-root>` reads a canonical Story
Markdown root without Project discovery, compilation, daemon or file mutation.
It emits source-located structural diagnostics and bounded narrative coverage;
structural success does not prove completeness, engine behavior, or revision
authorization. See [Narrative CLI](NARRATIVE_CLI.md) for the command, report,
upstream contract ownership, partial/unverified semantics and refresh procedure.

`noveltea [--json] narrative context <catalog-root> --kind <task-kind>
--id <typed-id> [--position <narrative-position-id>] [--scope focused|related]`
returns a deterministic, status-aware Context Manifest containing prioritized
Markdown paths, source fingerprints and typed relationship evidence, not narrative
prose. See [Narrative CLI](NARRATIVE_CLI.md#task-scoped-context-manifest).

The read-only `narrative readiness` CLI reports status-scoped minimum requirements
and bounded Milestone handoff clusters. A `passed` minimum does not establish
creative quality, VN production feasibility, asset availability, or engine
playability. See [Narrative CLI](NARRATIVE_CLI.md#native-narrative-readiness-and-milestone-handoff).

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
native authoring validates semantic equivalence before any commit.
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
noveltea narrative validate <catalog-root>
noveltea narrative context <catalog-root> --kind dialogue --id <event-id> [--position <position-id>]
noveltea narrative readiness <catalog-root> [--stage interactive] [--view design|approved]
                           [--milestone <milestone-id>]...
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

## Native daemon lifecycle

The installed CLI defaults to a native C++ per-user broker for Project work.
The broker uses one resident native owner per canonical Project root and
one-job native disposable workers for heavy shader, Test, export and ComfyUI
operations. The broker's protocol/build identity isolates incompatible
instances; owners hold source-generation authority, while heavy jobs receive
pinned snapshots and reject stale publication. CLI reads and transactional
edits share this authority with the editor through physical disk revisions,
not an in-process editor Project. Broker failure can fall back to local C++
execution for replay-safe commands; uncertain mutations are never replayed.

`noveltea daemon status` reports running state, protocol, build identity and
process information. `noveltea daemon stop` drains the broker; no public
`daemon start` command is required. `--no-daemon` or `NOVELTEA_NO_DAEMON=1`
selects the native local execution path. Both execution paths accept the same
stdin contracts: `test run-spec`, `test run-ui-spec` and
`localization reconcile --apply` (one UTF-8 JSON value). See
[production qualification](../architecture/certifications/NATIVE_AUTHORING_PRODUCTION_QUALIFICATION.md)
for restart, cancellation, source-race and editor/CLI independence evidence.

The retired QuickJS worker architecture, earlier performance notes and
candidate-only routing are in the [migration archive](../archive/reports/NATIVE_CLI_CUTOVER_HISTORY.md).

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

## Native validation and runtime caches

The native C++ Project owner retains exact physical source generations and
scoped validation state in memory; unchanged source can reuse its current
validation evidence across ordinary CLI requests. The disposable on-disk
native clean-validation cache is a restart accelerator only: missing, invalid,
incompatible or corrupt entries trigger fresh native reconciliation, never a
legacy ScriptC fallback. Source and Asset changes must be re-proven before a
cached result or heavy-output publication can be accepted.

Runtime and authored-Test caches are separate from editor dirty state. Native
Test catalog entries have their own freshness checks; source changes invalidate
the affected runtime or catalog evidence. Runtime Packages, editable Project
bundles and game-player exports exclude disposable authoring cache state.
See [native cache and source authority](project/NATIVE_AUTHORING_WORKER.md)
and [production certification](../architecture/certifications/NATIVE_AUTHORING_PRODUCTION_QUALIFICATION.md)
for the current detailed contracts. Retired ScriptC cache implementation
notes are preserved in the [migration archive](../archive/reports/NATIVE_CLI_CUTOVER_HISTORY.md).

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
