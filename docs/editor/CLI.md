# NovelTea CLI

NovelTea ships one public headless executable: `noveltea`. It is a scriptc-built standalone binary containing the shared TypeScript authoring/workspace implementation in an embedded QuickJS-ng island plus a narrow statically linked host/native tooling boundary. The editor invokes this same installed binary for native/headless operations; `noveltea-editor-tool` and a separately distributed bgfx `shaderc` executable are retired.

## Project discovery and direct editing

A project is identified by its root directory and `<project-root>/project.json`. Use `--project <project-directory>` to select a project explicitly. Without it, the CLI walks upward from the current directory and stops at the first `project.json`. A malformed NovelTea manifest, wrong workspace identity, or unsupported workspace version is a terminal discovery error at that directory; discovery does not fall through to a parent project or accept a retired monolithic project file.

Ordinary authoring is file-first: edit tracked JSON, Lua, RML, and RCSS directly and then run `noveltea validate`. Do not route ordinary field changes through invented setter commands. The CLI owns operations that need project-wide semantics, transactions, native tooling, or reproducible automation.

## Public command surface

Core authoring commands are:

```text
noveltea project create <directory> --name <project-name>
noveltea validate
noveltea usages <collection> <id>
noveltea entity create <collection> <id> [--dry-run]
noveltea entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]
noveltea entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]
noveltea agent sync [--fix]
```

`project create` accepts a new destination path that does not exist, including paths containing spaces, and rejects every existing file, directory, or symlink. It assembles and validates the complete initial workspace in a sibling staging directory before atomic activation. The editor uses the same creation service and project defaults. Creation does not generate `.noveltea/agent/`; run `agent sync` afterward.

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

Shared user packages live under `<NovelTea user config>/comfyui/workflows/`. The strict
`noveltea.comfyui-user-config` version 1 document at `<NovelTea user config>/comfyui/config-v1.json` owns the server URL,
per-request timeout, and logical default-workflow mappings keyed by arbitrary valid dotted classifications. The canonical
V1 config has no singular default-workflow alias. Editor enablement and periodic connection-check cadence are
editor-local preferences and are not part of that shared file. `NOVELTEA_USER_CONFIG_ROOT` therefore provides hermetic
ComfyUI configuration, workflow, and cache storage for CI. An invocation `--server` override is ephemeral and does not
rewrite the shared configuration.

The editor's Generate Image and Edit Image surfaces are thin Project-session adapters over this same execution core.
They use the same catalog/default resolution, verification, public bindings, HTTP history polling, prompt-specific
cancellation, image validation, and publication preparation. Edit Image first reads the selected source Asset through
editor-owned Project authority, then hands a private temporary local image to the shared secure media handler. Therefore
`localhost` is not an editor exception: use a literal loopback server such as `http://127.0.0.1:<port>` when local image
bytes must be uploaded. The workflow manager retains image-specific automatic inference, while its strict V2 manual
manifest editor can author or repair arbitrary named generic contracts and future classifications.

Native functionality is exposed through the same executable for shader compilation, raw bgfx-compatible `noveltea shaderc ...` forwarding, headless test/UI-test playback, and package export. Runtime Package export also accepts `--include-unused-assets` and `--include-shader-sources` as explicit developer overrides of the normal pruning/source-stripping policy. `noveltea --help` is authoritative for the installed version's exact syntax.

Platform publication is a separate command family from Runtime Package creation:

```text
noveltea platform profiles
noveltea platform export --output <path> [--profile <id>] [--template <id>@<build>]
                         [--signing-profile <id>] [--config <file>] [--sign]
                         [--include-unused-assets] [--include-shader-sources]
                         [--check] [--force]
                         [--allow-untrusted-template] [--allow-identity-change]
noveltea platform template list
noveltea platform template inspect <id>@<build>
noveltea platform template install <archive> [--force]
noveltea platform template remove <id>@<build> --force
noveltea platform config init <path> [--force]
```

`platform profiles` prints the exact profile IDs accepted by `platform export`. Projects do not
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

Unused assets are excluded by default using the same authoring dependency graph as the editor.
`--include-unused-assets` disables that pruning for diagnostic/developer exports, and
`--include-shader-sources` preserves authored shader sources that normal runtime packaging strips.
These are the headless equivalents of the Export pane's Developer Mode options.

The editor and CLI share reusable machine-level state beneath the NovelTea user configuration root. Export configuration
is stored at `~/.noveltea/export-config-v1.json`; shared ComfyUI configuration, workflows, and disposable verification
cache are under `~/.noveltea/comfyui/`.
Export configuration contains toolchain paths plus named Windows, macOS, and Android signing configurations. Signing
secrets remain explicit `env:NAME` references. `NOVELTEA_USER_CONFIG_ROOT` provides a hermetic override for the shared
NovelTea user-config directory, including both export and ComfyUI catalog state, in CI. The optional `--config` file continues to use the
`noveltea.editor-export-local-state` contract as an explicit per-command override; generate a safe,
secret-free skeleton with `platform config init`. `--config` does not combine with
`--signing-profile`.

The editor and CLI also share the per-user template registry at `~/.noveltea/templates/v1`;
`NOVELTEA_TEMPLATE_REGISTRY_ROOT` provides a hermetic override for CI.

The Node reference/editor-hosted command and Linux x64 and Windows x64 self-contained scriptc
commands are implemented. Every standalone host binary remains subject to the cross-host
certification gate in `SCRIPTC_COMPATIBILITY.md`.

The standalone release keeps operating-system/native capabilities in a small statically compiled scriptc host and executes the shared authoring application in the embedded QuickJS-ng island. Stdin and process-liveness checks cross the host boundary explicitly; shader/runtime/package operations cross the existing NovelTea C ABI. `agent sync` embeds the checked-in agent-kit source texts as build-time package data and generates the schema portion only when that command runs.

Rename/delete use the shared dependency graph and source recognizers. Proven rewriteable source ranges may be changed transactionally; exact manual references block unsafe rename; possible lexical references require explicit acknowledgement; delete's `--force` handling of exact blockers is independent from possible-source acknowledgement. `--dry-run` performs discovery, assembly, validation/preflight, graph/source analysis, and projected transaction planning without changing tracked or ignored project files.

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

## Concurrency and transactions

Non-dry-run structural operations write through the same workspace transaction service as editor structural mutations. NovelTea writers use the project writer lock and exact target revisions; stale or concurrent changes fail closed rather than overwrite. A pending transaction needing recovery also causes a dry run to fail rather than mutate recovery state.

The CLI does not require Electron or an open editor. If an editor is open, its workspace watcher observes the committed source-tree result and reconciles it using the normal external-change rules documented in `project/PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Build and release

The exact scriptc version and native ABI are pinned and certified against the Node reference
implementation. Tagged releases publish `noveltea-<tag>-linux-x64` and
`noveltea-<tag>-windows-x64.exe`, include both in `SHA256SUMS`, and attest their build provenance.
Each host editor embeds that exact certified binary. Release packages contain no TypeScript source,
first-party source maps, Node installation, sibling shaderc binary, or retired editor helper. See
`SCRIPTC_COMPATIBILITY.md` and `BUILD_AND_DISTRIBUTION.md`.
