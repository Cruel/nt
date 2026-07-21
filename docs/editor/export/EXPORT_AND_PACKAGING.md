# Export and Packaging

## One Gameplay Producer

The editor has one gameplay producer:

```text
AuthoringProject V2
  -> publishCompiledArtifact
  -> canonical noveltea.compiled.project v1 gameplay JSON
```

`buildCompiledRuntimeExport` is the single project-derived compilation and runtime-readiness result
used by Play and `.ntpkg` export. It does not lower gameplay fields. It attaches package file entries,
display/platform options, shader/material metadata, required shader binaries, normalized diagnostics,
and a content/recovery source fingerprint at their separate boundaries.

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
- display and platform launch metadata;
- optional shader/material metadata and required binaries;
- checksum/source-stripping options.

The writer has no project import, legacy game parsing, entity editing, or `ProjectDocument`
overload. The editor native tool remains responsible for package writing, shader compilation, and
typed playback/UI-test execution only.

## Platform Export

The editor composes platform readiness from four explicit groups: current runtime-package readiness,
common application identity, selected-target metadata, and template/toolchain/signing environment.
Only the selected Desktop, Web, or Android target contributes target-specific diagnostics. Blockers
retain their stable code, canonical path, owner paths, severity, and boundary metadata so the Export
surface can navigate directly to project settings, export profiles, editor-wide toolchain/signing
settings, template selection, or output controls.

The renderer prepares one runtime artifact for the current in-memory project revision and sends its
source fingerprint, compiled project, package options, and normalized diagnostics across the IPC
boundary. Main-process orchestration strictly parses that serialized request, reconstructs the
current authoring project, recomputes the expected source fingerprint, and rejects stale or
mismatched evidence instead of recompiling a second hidden runtime revision. The headless CLI keeps
a single main-process compilation path because it has no renderer preparation stage.

After the native package writer succeeds, main hashes the actual package bytes. Staging accepts only
the matching source fingerprint and package SHA-256 evidence; a caller-supplied readiness boolean is
not trusted. Platform orchestration then verifies the player template, stages `player.json`, and
performs the selected target export. Project open does not attempt old-format native import.

Android player templates are prebuilt distribution inputs. Template production builds the
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
