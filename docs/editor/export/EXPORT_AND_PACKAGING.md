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

Platform orchestration opens only AuthoringProject V2 or accepts an in-memory authoring project,
publishes the compiled artifact, writes the package, validates the player template, stages
`player.json`, and performs the platform-specific export. Project open does not attempt old-format
native import.

Progress uses the `compiling-project` stage before packaging. Cancellation and structured
diagnostics remain part of the platform export contract.

## Package Layout and Loading

See `docs/runtime/PACKAGE_EXPORT.md` for the final ZIP/manifest contract and native validation.
Unsupported gameplay or manifest schemas fail; no fallback loader exists.

## Verification

Run editor lint, typecheck, and tests. Native changes also require Linux/Web builds and tests; use
Android verification when the SDK is available and packaged-platform behavior changes.
