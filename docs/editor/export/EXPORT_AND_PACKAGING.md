# Export and Packaging

Hotspot closure, built-in material resources, derived-mask treatment, and fixture materialization are
specified in `docs/architecture/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME.md`.

## One Gameplay Producer

The editor has one gameplay producer:

```text
Current AuthoringProject
  -> publishCompiledArtifact
  -> canonical noveltea.compiled.project v1 gameplay JSON
```

`prepareRuntimeArtifact` is the single host-neutral preparation interface used by Play, test
playback, `.ntpkg`, platform export, and the CLI. It returns `prepared`, `blocked`, or `cancelled`;
only `prepared` carries a current `noveltea.prepared-runtime-artifact` version-1 value. The module
does not lower gameplay fields. It attaches package file entries,
per-entry storage policy, required-seekable audio paths, display/platform options, shader/material
metadata, required shader binaries, normalized diagnostics, and a content/recovery source fingerprint
at their separate boundaries.

The result distinguishes compiled-artifact availability from diagnostics outside the
`runtime-package` boundary. Platform-only application identity, locale, signing, or deployment
errors do not suppress the compiled artifact or block Play/`.ntpkg`; platform export composes those
additional layers separately.

The deleted `buildAuthoringRuntimeExport`, `authoring-runtime-export.ts`, and
`runtime-project.ts` are not compatibility APIs.

## Export Profiles

The editor exposes one Export workbench tab. Its left sidebar pins the built-in Runtime Package
entry above alphanumerically sorted project profiles. Portable export configuration lives in the
top-level `/export` project subtree: `/export/runtime` is the built-in Runtime Package policy and
`/export/profiles` contains platform target recipes. `/export/assetMemoryPolicies` contains named
reusable memory policies managed from Project Settings. `/settings` remains reserved for ordinary
Project Settings data.
Profile creation chooses name and platform first, then enters the same target-specific editor used by
`Edit Profile`. Platform identity is immutable after creation. The currently selected profile, output
directory, installed-template selection, and signing identity are user-local execution state rather
than committed profile data.

Runtime Package is not an editable platform profile. Package-level behavior common to every export
lives on the normal Export pane. Normal exports exclude unused assets and strip shader source by
engine policy. Developer Mode exposes only the exceptional overrides `Exclude Unused Assets` and
`Include Shader Sources`; checksums, shader compilation, shader-variant closure, and other package
mechanics remain automatic.

Each platform profile selects a built-in Low/Balanced/High asset-memory policy or references one
named Project policy by stable ID. Named policies are edited only in Project Settings; the Export
editor shows the selected policy's base and concrete values resolved for the profile target and can
navigate to the canonical policy editor. Platform staging receives the named policy definitions only
to resolve the selected reference, then writes fully concrete memory limits into deployment/player
metadata. It never copies authoring policy IDs into the runtime contract.

Runtime-package compiler errors block package and platform export. Diagnostics retain compiler
codes, source paths, JSON pointers, owner paths, explicit boundaries, and deterministic ordering.
The complete producer and boundary inventory is maintained in
`docs/editor/project/PROJECT_VALIDATION_DIAGNOSTIC_MATRIX.md`.

Generated runtime metadata uses `[Unnamed Project]` and `0.0.0` when authored name/version values
cannot be used. These fallbacks exist only in the detached compiled artifact, manifest preview, and
package options; authoring content and recovery overlays are unchanged.

## Assets and Shaders

Runtime asset inclusion is audited from the authoring dependency graph. By default an authored asset
is retained when the graph has any runtime-relevant incoming usage, including conservative possible
source/Lua references; assets with no such usage are removed from both compiled gameplay resources
and package file entries. This is deliberately project-wide rather than entrypoint reachability: an
asset referenced by an otherwise unreachable Room is retained. Record-level tree shaking is not
performed. The same graph plumbing can support more aggressive record closure later without changing
the export contract.

Authoring asset metadata supplies source filesystem paths only after the asset survives that audit.
Shader/material assembly produces `shader-materials.json` and enumerates required platform binaries.
Normal runtime packages strip authored shader source while retaining all required binaries and
metadata; Developer Mode/CLI can explicitly preserve shader sources for diagnostic exports.

Every authored audio entry is exported with explicit `stored` ZIP policy and included in the
required-seekable list. This is semantic rather than path- or extension-based: an asset at
`assets/audio/theme.wav`, FLAC, M4A, or another arbitrary path may be used later as music, ambience,
or voice and therefore must remain directly seekable. The native writer rejects the package if any
required-seekable entry is absent or compressed.

Shader compilation performed for package publication is side-effect-free. Its outputs are applied
to detached export metadata and required-binary lists; package export does not execute
`shader.applyCompiledOutputs`, mutate the authoritative project, dirty a save unit, or change the
readiness fingerprint captured from authoring content and recovery state.

These manifests do not get merged into gameplay JSON.

## Native Package Boundary

The editor invokes the native package writer with:

- canonical compiled gameplay JSON;
- package kind/name/version/creator;
- explicit file entries;
- explicit per-entry ZIP storage and required-seekable paths;
- display and platform launch metadata;
- optional shader/material metadata and required binaries;
- checksum/source-stripping options.

The writer has no project import, legacy game parsing, entity editing, or `ProjectDocument`
overload. The editor native tool remains responsible for package writing, shader compilation, and
typed playback/UI-test execution only.

## Platform Export

The public headless entrypoint is `noveltea platform export`. `noveltea package export` remains the
Runtime Package (`.ntpkg`) command and is not an alias for platform publication. Electron has no
headless export, template-install, or low-level staging arguments; the editor UI and CLI invoke the
same orchestration and template-registry services through their respective host adapters.

Platform publication requires an explicit output path. It refuses every planned artifact collision
unless replacement is acknowledged, refuses symlink publication paths even when replacement is
acknowledged, and publishes through temporary/backup paths so failure or cancellation preserves the
previous complete output. Template replacement and removal similarly require explicit force. A
locally sourced template requires per-export acknowledgement in both the editor and CLI.

`platform export` produces the normal packaged artifact by default. Reusable signing configurations
are machine-level NovelTea user settings shared by the editor and CLI, not project-profile fields.
The editor selects a compatible signing identity in the Export pane and remembers that selection
locally per profile. The CLI uses `--signing-profile <id>` (which implies signing), or bare `--sign`
when exactly one signing configuration exists for the selected target. Results report whether
signing was requested and applied. Store publication is not supported.

When automatic template resolution finds more than one compatible installation it fails with the
exact `<template-id>@<build-id>` choices; no lexical or inferred-version winner is selected. The
editor shows a template selector only when there is a real choice, and when no compatible template
exists it offers Download and Install actions in place. Editor Settings has a separate installed
Template manager with Install/Delete only. The editor and CLI share `~/.noveltea/templates`.

Export profiles do not expose capabilities. NovelTea derives the fixed requirements consumed by
template compatibility and platform packaging: external-URL launching is required where supported,
and Android additionally requires vibration/haptics. Network access, clipboard, gamepad,
microphone, notifications, custom URL schemes, and billing are not requested. External-URL support
does not grant Android INTERNET permission because navigation is delegated to the system browser.

`platform export --check` performs a no-write preflight and never compiles shaders, creates caches,
writes output, changes the registry, or updates successful-export identity. A completed publication
records application ID and save namespace in ignored project editor state; a later identity change
requires explicit acknowledgement.

The editor composes platform readiness from four explicit groups: current runtime-package readiness,
common application identity, selected-target metadata, and template/toolchain/signing environment.
Only the selected Desktop, Web, or Android target contributes target-specific diagnostics. Blockers
retain their stable code, canonical path, owner paths, severity, and boundary metadata so the Export
surface can navigate directly to project settings, the selected profile, editor-wide
Toolchains/Signing settings, template selection, or output controls.

The renderer prepares one Prepared Runtime Artifact for the current in-memory Project revision and
sends that exact current-version contract across IPC. Main-process orchestration strictly parses
every field, verifies profile and source identity against the current Project, checks gameplay
identity, re-derives the packaged asset inventory from Compiled Project resources plus current asset
records, and verifies storage/seekability, shader-binary closure, manifest preview, and deterministic
package options before exposing a distinct verified representation to package writing and staging.
It rejects stale, malformed, omitted, substituted, or internally inconsistent evidence instead of
compiling a second hidden runtime revision. This guards normal process coordination mistakes; it is
not a security proof against a compromised renderer. The headless CLI enters the same preparation
module through its native shader compiler and Node path adapters.

Preparation owns required shader variants, captured input fingerprints, output-integrity checks,
diagnostic classification, cancellation checkpoints, and detached application of verified output
metadata. A successful shader compile must return exactly one valid output for every requested
shader/stage/variant key; missing, duplicate, extra, malformed, or stale output evidence blocks
preparation. Renderer and native/CLI adapters validate the complete native shader response before it
enters preparation, then perform the shader compiler and filesystem effects. Play, test playback, and
preflight intents prohibit those effects. Package writing, template resolution, signing, and target
staging remain outside preparation.

After the native package writer succeeds, main hashes the actual package bytes. Staging accepts only
the matching source fingerprint and package SHA-256 evidence; a caller-supplied readiness boolean is
not trusted. Platform orchestration then verifies the player template, stages `player.json`, and
performs the selected target export. Project open does not attempt old-format native import.

Templates may carry a precompiled player or a platform build project. Desktop and Web templates
normally carry precompiled players. Template installation verifies the descriptor and file byte
inventory; target file modes come from that verified descriptor rather than host extraction
permissions. Their final ZIP/TAR publication is assembled by the editor/CLI without CMake or another
build toolchain, honors the profile compression policy, and writes those target modes into archive
metadata so cross-host publication does not depend on the host filesystem preserving POSIX
permissions. Android uses the source-template form: it carries a Gradle
project and structured Android descriptor while retaining precompiled native player libraries.
The exporter runs its declared build workflow with an already installed compatible toolchain; it
never installs SDKs or silently builds NovelTea itself.

Android player templates are prebuilt native distribution inputs. Template production builds the
ABI-specific native player once, then stores the resulting shared-library closure and system assets
in the template archive. Project export does not require the NovelTea source tree,
CMake, the Android NDK, or a C/C++ compiler. Template installation uses the host archive utility,
and Gradle only merges generated game inputs and resources, packages the prebuilt libraries, and
signs the requested APK or AAB. Release CI records a narrow `llvm-readelf` certification artifact
showing that the template libraries retain at least 16 KiB `PT_LOAD` alignment. Per-project release
qualification verifies APK/AAB bootstrap/package integrity, native-library and ABI closure,
ZIP alignment, manifest data, signing policy, and pinned-bundletool handling where applicable.
Actual arm64 device install/launch is a separate `Android arm64 16 KiB certification` workflow and
is not claimed by the ordinary release platform report unless that device workflow itself ran.

Changing the effective application ID or save namespace after a previous successful platform export
shows a warning and requires an explicit confirmation before staging. Cancellation performs no
publication. Only complete target success records
`editor.lastSuccessfulPlatformExportIdentity`; failure, cancellation, partial publication, or a
metadata write conflict retains the prior identity. This metadata-only flush never marks project
content dirty.

Platform export has no compatibility content command for successful-export identity. The durable
record is written directly through the conflict-checked editor-metadata channel after final target
success.

Progress uses the `compiling-project` stage before packaging. Cancellation and structured
diagnostics remain part of the platform export contract.

## Package Layout and Loading

See `docs/runtime/PACKAGE_EXPORT.md` for the final ZIP/manifest contract and native validation.
Unsupported gameplay or manifest schemas fail; no fallback loader exists.

## Verification

Run editor formatting, typecheck, checks, tests, renderer/electron builds, project compiler
parity/goldens, runtime-package and Desktop/Web/Android export suites, and packaged-editor smoke.
Native changes also require Linux/Web builds and tests; use Android verification when the SDK is
available and packaged-platform behavior changes.
