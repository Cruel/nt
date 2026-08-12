# Export and Packaging

Hotspot closure, built-in material resources, derived-mask treatment, and fixture materialization are
specified in `docs/architecture/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME.md`.

## One Gameplay Producer

The editor has one gameplay producer:

```text
AuthoringProject V2
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

Runtime and editable profiles control packaging choices such as checksums, shader variants/source
stripping, and file inclusion. Both profiles use identical canonical gameplay bytes for identical
authoring input/settings.

Runtime-package compiler errors block package and platform export. Diagnostics retain compiler
codes, source paths, JSON pointers, owner paths, explicit boundaries, and deterministic ordering.
The complete producer and boundary inventory is maintained in
`docs/editor/project/PROJECT_VALIDATION_DIAGNOSTIC_MATRIX.md`.

Generated runtime metadata uses `[Unnamed Project]` and `0.0.0` when authored name/version values
cannot be used. These fallbacks exist only in the detached compiled artifact, manifest preview, and
package options; authoring content and recovery overlays are unchanged.

## Assets and Shaders

Compiled resource records determine runtime asset closure. Authoring asset metadata supplies source
filesystem paths only after a compiled resource is present. Shader/material assembly produces
`shader-materials.json` and enumerates required platform binaries. Runtime packages may strip
shader source while retaining all required binaries and metadata.

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

`platform export` produces the normal packaged artifact by default. `--sign` applies configured
platform signing and fails preflight when signing is unsupported or its configuration is incomplete.
Signing configuration alone never activates signing. Results report whether signing was requested
and applied. Store publication is not supported.

When automatic template resolution finds more than one compatible installation it fails with the
exact `<template-id>@<build-id>` choices; no lexical or inferred-version winner is selected.
`platform export --check` performs a no-write preflight and never compiles shaders, creates caches,
writes output, changes the registry, or updates successful-export identity. A completed publication
records application ID and save namespace in ignored project editor state; a later identity change
requires explicit acknowledgement.

The editor composes platform readiness from four explicit groups: current runtime-package readiness,
common application identity, selected-target metadata, and template/toolchain/signing environment.
Only the selected Desktop, Web, or Android target contributes target-specific diagnostics. Blockers
retain their stable code, canonical path, owner paths, severity, and boundary metadata so the Export
surface can navigate directly to project settings, export profiles, editor-wide toolchain/signing
settings, template selection, or output controls.

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
normally carry precompiled players. Android uses the source-template form: it carries a Gradle
project and structured Android descriptor while retaining precompiled native player libraries.
The exporter runs its declared build workflow with an already installed compatible toolchain; it
never installs SDKs or silently builds NovelTea itself.

Android player templates are prebuilt native distribution inputs. Template production builds the
ABI-specific native player once, then stores the resulting shared-library closure and system assets
in the template archive. Project export does not require the NovelTea source tree,
CMake, the Android NDK, or a C/C++ compiler. Template installation uses the host archive utility,
and Gradle only merges generated game inputs and resources, packages the prebuilt libraries, and
signs the requested APK or AAB. Release CI performs one narrow `llvm-readelf` assertion that the
template libraries retain at least 16 KiB `LOAD` alignment. Architecture and dependency behavior are
covered by the actual Android build and install/launch certification rather than duplicate ELF
metadata reports. Per-project export verifies the APK/AAB native-library and ABI closure while
retaining final ZIP-alignment, manifest, bootstrap, and signing checks.

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
