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

The editor and CLI share reusable machine-level export configuration at
`~/.noveltea/export-config-v1.json`: toolchain paths plus named Windows, macOS, and Android signing
configurations. Signing secrets remain explicit `env:NAME` references. `NOVELTEA_USER_CONFIG_ROOT`
provides a hermetic override for the shared NovelTea user-config directory in CI. The optional `--config` file continues to use the
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
