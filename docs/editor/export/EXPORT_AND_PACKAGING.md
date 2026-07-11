# Export and Packaging Workflow

## Purpose

The editor export workflow turns a NovelTea authoring project into a runtime package. It does not package the authoring project JSON directly. The workflow builds a runtime-shaped package input, collects package-safe assets, passes shader/material metadata when present, and calls the native package writer through the editor tool bridge.

## Current V1 Scope

The native `noveltea-player` target is the reusable player-template entrypoint. A staged desktop
player contains `player.json` and its referenced sidecar `game.ntpkg`; discovery does not depend on
the launch working directory. The player validates config format version 1, runtime-package API 1,
capabilities, package SHA-256, and the runtime package manifest before mounting content. Branding,
template staging, archives, and signing remain in later platform-export phases.

Milestone 17 implements a first vertical slice:

- export profile defaults for runtime packages;
- native save dialog for selecting `.ntpkg` output paths;
- validation-before-export;
- pure authoring-to-runtime export builder;
- room-entrypoint runtime conversion for simple text-room projects;
- deterministic explicit package file entries for referenced assets;
- native package writer support for explicit file entries;
- shader/material metadata handoff and required shader binary path derivation;
- optional shader compile-before-export orchestration;
- structured Package Export bottom panel;
- reveal-in-folder support;
- explicit unsupported diagnostic for preview-from-exported-package.

The runtime conversion is intentionally narrow. Room entrypoints are supported. Scene and dialogue entrypoints are blocked with precise diagnostics because those authoring records do not yet have complete runtime export semantics.

App-icon generation is available as a headless main-process service in
`editor/src/main/services/icon-generation-service.ts`. It accepts a canonical image and staging
root, emits a typed output manifest, and generates Web PNG/favicons, Android density/adaptive
resources, Windows ICO, and macOS ICNS files. Platform override inputs bypass generation for their
target. Source dimension/color-space and adaptive or maskable safe-area problems are returned as
structured diagnostics; platform exporters will invoke this service when their staging workflows
are implemented.

Phase 4 adds unsigned platform staging. Callers provide an unpacked player-template root containing
`template.json`, a completed `game.ntpkg`, a canonical icon, local output directory, and the selected
shareable platform profile. The shared deployment builder validates identity, package API, target,
architecture, build flavor, capabilities, host/toolchain requirements, and target path portability.

The main-process staging service builds a sibling temporary directory, rejects traversal, symlinks,
and sandbox/demo content, generates icons and `player.json`, and records deterministic file origins,
modes, sizes, and SHA-256 values in `export-manifest.json`. Completion atomically replaces the prior
staging directory; failure or cancellation preserves the prior successful output. Absolute template,
package, icon, system-asset, and output paths remain request-local and are not written to profiles or
provenance. Template discovery/install, final archives, signing, and runnable certification remain
phase 5 and later work.

## Workflow Stages

Renderer workflow files:

```text
editor/src/renderer/export/package-export-workflow.ts
editor/src/renderer/export/package-export-store.ts
```

Stages:

```text
idle
validating
building-runtime-project
compiling-shaders
writing-package
previewing-package
complete
failed
```

Validation errors stop the workflow before shader compilation or native package writing. Runtime export conversion errors stop the workflow before native package writing. Shader compile errors stop the workflow before package writing. Native package diagnostics are merged into the final export result.

When project-level settings block export, such as a missing entrypoint or a non-room entrypoint, the Package Export dialog keeps the workflow in preflight, disables `Export Package`, shows the diagnostics inline, and exposes `Open Project Settings` so the user can fix the project setup without editing JSON.

## Export Profiles

Export profile helpers live in:

```text
editor/src/shared/project-schema/authoring-export.ts
```

Default runtime package profile:

```ts
{
  id: 'runtime-default',
  label: 'Runtime Package',
  kind: 'runtime',
  outputPath: '',
  includeChecksums: true,
  stripEditorData: true,
  stripShaderSources: true,
  compileShadersBeforeExport: true,
  shaderVariants: ['glsl-120', 'essl-100', 'essl-300'],
  includeAllProjectAssets: false,
  includeOnlyReferencedAssets: true,
  includeTests: false,
  previewAfterExport: false,
}
```

Profile parsing supports `project.settings.export`, but V1 does not yet include a full command-backed export profile editor. The dialog uses the selected/default profile and lets the user adjust output path, shader variants, and key toggles for the current export run.

Phase 0 also defines strict, versioned platform-export contracts in
`editor/src/shared/project-schema/platform-export-contracts.ts`. Platform profiles are a separate
union from the existing runtime-package profile and contain only shareable policy. Absolute output,
template, SDK, signing, and credential references are accepted only by the separately parsed
editor-local state contract and must not be written into project settings.

The same module defines version 1 of `player.json`, player-template descriptors, and the closed
normalized capability vocabulary. Target artifact paths are checked by
`target-path-portability.ts` for traversal, target naming rules, length hazards, case collisions,
and Unicode-normalization collisions before later packaging phases stage files.

The canonical cross-platform acceptance fixture lives under `editor/src/renderer/test/fixtures/`.
It intentionally records RmlUi mounting, audio playback, and save/reload as certification blockers
until those reachable behaviors have complete runtime conversion and artifact smoke coverage.

## Authoring-to-Runtime Export Builder

The pure builder lives in:

```text
editor/src/shared/project-schema/authoring-runtime-export.ts
```

It produces a runtime-shaped project object, explicit package file entries, shader/material metadata, required shader binary paths, manifest preview metadata, and export diagnostics.

It strips editor-only data by construction. The authoring `editor` state and `tests` collection are not included in runtime package output.

Supported runtime conversion in V1:

- project name/version/author;
- room collection;
- room descriptions;
- room path targets to other rooms;
- room hotspot object placements where representable;
- room entrypoint.

Project Settings currently stores additional package-facing values such as default layout/font, title-screen options, project icon, and startup init script. These settings are validated in the authoring project and exposed by the editor, but only the fields already supported by the runtime export adapter are mapped into the runtime package. Default layout/font have built-in fallbacks and do not block export when unset.

Unsupported V1 conversion:

- scene entrypoints;
- dialogue entrypoints;
- full scene runtime semantics;
- full dialogue runtime semantics;
- authored map/inventory/action runtime semantics beyond data already representable by the room slice.

Unsupported records should produce blocking diagnostics only when they are needed for the runtime entrypoint or exported flow. Extra scene/dialogue records produce warnings because they are not included in the V1 runtime package output.

## Asset Packaging

The editor export builder emits explicit package file entries instead of broad asset roots. This avoids accidentally packaging unreferenced authoring files.

Native support is implemented in:

```text
engine/include/noveltea/core/package_export.hpp
engine/src/core/package_export.cpp
tools/editor_tool/main.cpp
```

Native export options accept:

```json
{
  "fileEntries": [
    { "source": "/absolute/project/assets/images/foyer.png", "packagePath": "textures/foyer.png" }
  ]
}
```

The package writer validates source existence, package path safety, allowed package prefixes, duplicate paths, and checksums. Existing `assetRoots` remain available for lower-level/native workflows, but the authoring export workflow uses explicit entries.

## Shader Packaging

Shader/material metadata is built with:

```text
editor/src/shared/project-schema/shader-material-project.ts
```

When shader or material records exist, the export workflow can compile shaders before writing the package. Compile outputs are applied through `shader.applyCompiledOutputs` before package writing, then shader/material metadata is rebuilt so compiled runtime paths are present.

Required shader binary paths are passed to native export as `requiredShaderBinaryPaths`. Missing required binaries fail the package export instead of silently producing a package that cannot render material-backed content.

## UI Surfaces

Project Settings:

```text
docs/editor/project/PROJECT_SETTINGS.md
editor/src/renderer/editors/project/ProjectSettingsEditor.tsx
```

Project Settings is accessible from `Project > Project Settings…` and from the Package Export dialog when project settings block export.

Export dialog:

```text
editor/src/renderer/export/PackageExportDialog.tsx
```

Structured bottom panel:

```text
editor/src/renderer/export/PackageExportPanel.tsx
```

The Package Export panel shows workflow status, profile/output path, manifest summary, diagnostics, asset file entries, shader outputs, byte count, checksums, raw JSON, reveal-in-folder, and preview package actions.

## IPC Surface

The renderer uses narrow Electron APIs:

```ts
selectPackageOutputPath(defaultPath?: string | null): Promise<string | null>
showItemInFolder(path: string): Promise<void>
previewExportedPackage(packagePath: string): Promise<PackagePreviewResponse>
stagePlatformExport(request: PlatformStageRequest): Promise<PlatformStageResult>
cancelPlatformExport(operationId: string): Promise<{ cancelled: boolean }>
```

Packaged editor builds also expose the same service noninteractively without opening a window:

```sh
noveltea-editor --stage-platform-export < request.json
```

The request must include `runtimePackageReadiness` with `validated: true` and a zero
`blockingDiagnosticCount`. The complete UI workflow supplies this only after authoring validation,
runtime conversion, shader compilation, and `.ntpkg` writing have succeeded. Direct/headless callers
must run the same package-export checks first; the staging service rejects requests without that
readiness result rather than treating an arbitrary existing package path as certified.

The command writes a structured, recursively redacted result to stdout and returns a nonzero status
for invalid requests or unsuccessful staging. This is the phase-4 headless editor-tool entrypoint;
release automation may provide a `noveltea-editor-tool stage-platform-export` launcher alias when
the platform templates are published in phase 5.

`previewExportedPackage` currently returns a precise unsupported diagnostic. Actual package preview should be connected to the engine preview server once loading exported `.ntpkg` files through the preview session is safe.

## Verification

Editor checks:

```sh
cd editor
pnpm typecheck
pnpm test
pnpm lint
```

Native checks:

```sh
cmake --build --preset linux-debug --target noveltea_core_tests noveltea_render_tests noveltea-editor-tool
build/linux-debug/tests/noveltea_core_tests
build/linux-debug/tests/noveltea_render_tests
```

## Known Follow-Up Work

- Persist export profile edits through command-backed project settings updates.
- Add full scene and dialogue runtime export conversion.
- Add package preview loading through the engine preview server.
- Add shader tool path preferences or better automatic shaderc discovery.
- Add more granular asset reachability based on runtime-converted records.
- Add platform-specific packaging workflows after runtime package export is stable.
