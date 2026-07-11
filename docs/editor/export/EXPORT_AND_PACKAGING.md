# Export and Packaging Workflow

## Purpose

The editor export workflow turns a NovelTea authoring project into a runtime package. It does not package the authoring project JSON directly. The workflow builds a runtime-shaped package input, collects package-safe assets, passes shader/material metadata when present, and calls the native package writer through the editor tool bridge.

## Current V1 Scope

The native `noveltea-player` target is the reusable player-template entrypoint. A staged desktop
player contains `player.json` and its referenced sidecar `game.ntpkg`; discovery does not depend on
the launch working directory. The player validates config format version 1, runtime-package API 1,
capabilities, package SHA-256, and the runtime package manifest before mounting content. Branding,
template staging and verified template installation are implemented; final per-game archives and
signing remain in later platform-export phases.

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
resources, Linux hicolor PNGs, Windows ICO, and macOS ICNS files. Platform override inputs bypass generation for their
target. Source dimension/color-space and adaptive or maskable safe-area problems are returned as
structured diagnostics; platform exporters will invoke this service when their staging workflows
are implemented.

Phase 4 adds unsigned platform staging. Callers provide an opaque token for a template installed by
the phase-5 registry, a completed `game.ntpkg`, a canonical icon, local output directory, and the
selected shareable platform profile. The shared deployment builder validates identity, package API, target,
architecture, build flavor, capabilities, host/toolchain requirements, and target path portability.

The main-process staging service builds a sibling temporary directory, rejects traversal, symlinks,
and sandbox/demo content, generates icons and `player.json`, and records deterministic file origins,
modes, sizes, and SHA-256 values in `export-manifest.json`. Completion atomically replaces the prior
staging directory; failure or cancellation preserves the prior successful output. Absolute template,
package, icon, system-asset, and output paths remain request-local and are not written to profiles or
provenance. Web, Windows, and Linux finalizers now publish platform-native artifacts; signing and
the remaining platform finalizers remain later work.

## Player Template Registry

The main process owns a versioned template registry under the editor user-data directory. Renderer
and headless callers see template IDs and opaque resolution tokens, never installed filesystem
paths. Local archives are installed transactionally after archive-path, entry-count, expanded-size,
symlink, collision, descriptor inventory, mode, size, and SHA-256 validation. Local archives are
reported as untrusted; a template is reported as official only when its archive and descriptor
digests match GitHub release provenance supplied by the registry index.

Compatibility evaluation covers target, architecture, build flavor, package access, runtime-package
and player-config APIs, graphics backends, shader variants, capabilities, compiled features, host,
and required tools. Staging repeats installed-file integrity verification immediately before copying
the template, so post-install changes block export with an actionable diagnostic.

Official desktop releases publish templates for Linux x64, Windows x64, and macOS arm64. Each
template has a canonical descriptor, exact file and native-dependency inventory, full vcpkg-derived
CycloneDX SBOM, collected third-party notices, separate build-ID-matched symbols, SHA-256 release
metadata, a release registry index, and GitHub artifact provenance attestations.

## Web Player Export

The Web exporter consumes the dedicated `web-wasm32-release` player template rather than the
sandbox or preview shell. The game package remains a separately fetched `.ntpkg`; the JavaScript
bootstrap loads `player.json`, downloads the declared package, verifies its SHA-256 through Web
Crypto, and only then allows the native player to start.

Web staging emits a deployment directory and ZIP. Engine JavaScript, Wasm, and `game.ntpkg` receive
content-hashed names. Generated output also includes an application-specific `index.html`, stable
`manifest.webmanifest`, icons, `DEPLOYMENT.md`, and an optional offline service worker. The shell
checks WebAssembly and WebGL 2 availability and waits for a user gesture before loading the player,
which keeps audio startup compatible with browser autoplay policy.

PWA cache names combine the application identity with one export-content hash. Service-worker
activation removes only older caches owned by that application, preventing mixed engine/package
updates and avoiding collisions between NovelTea games on one origin. IDBFS mounts below a sanitized
`saveNamespace`, so browser persistence is isolated independently of the deployment URL.

The default template is single-threaded and does not require cross-origin isolation. Threaded output
must resolve to a separately compiled compatible template; its generated deployment guide must call
out the required COOP and COEP headers.

## Linux Portable Export

The Linux finalizer consumes an immutable Linux player template and publishes a normalized portable
application directory plus a `.tar.gz` archive. The template descriptor records the player's ELF
`NEEDED` entries and runtime paths. Finalization rejects undeclared non-system dependencies,
nonportable absolute/build-tree RPATHs, non-executable player inputs, and bundled libraries without
an `$ORIGIN`-relative lookup path.

The portable tree retains the template's `bin/` layout. A root launcher resolves the export directory
independently of the current working directory, while `bin/player.json` references the root
`game.ntpkg` through a normalized relative path. Generated desktop integration consists of a
validated reverse-DNS desktop ID, a freedesktop `.desktop` entry, and hicolor icons from 16 through
512 pixels. The desktop entry and generated metadata carry the same application ID and save
namespace as `player.json`.

Profiles selecting `appimage` still receive the portable tarball. AppImage is an additional artifact
built from the same finalized tree through machine-local `appimagetool`; a missing tool blocks only
an AppImage-requesting profile. AppImage, directory, tarball, and optional symbols are built before
publication and replaced as one rollback-safe artifact set. Build-ID-matched `.debug` files are
removed from the player tree and emitted separately when the profile requests symbols.

Official Linux x64 templates are built on Ubuntu 22.04 and audited against a maximum glibc 2.35
symbol baseline. Release CI packages the real template, finalizes both the portable tree and
AppImage under a Unicode/space-containing path, and launches both artifacts from an unrelated
working directory under X11 and headless Wayland. The smoke also verifies that `game.ntpkg` and
packaged `system:/` assets resolve relative to the installed player rather than the build tree.

### macOS app bundles

macOS profiles finalize the immutable player template into a conventional `.app` tree. The player
is installed under `Contents/MacOS`, while `player.json`, `game.ntpkg`, system assets, notices,
localized `InfoPlist.strings`, the generated ICNS icon, and the export manifest are installed under
`Contents/Resources`. Bundled dylibs are placed in `Contents/Frameworks`; template-recorded Mach-O
dependencies and rpaths are rejected when they point to build-tree or other nonportable absolute
locations, and install names are normalized to `@rpath` on macOS hosts.

`Info.plist`, entitlements, and privacy-purpose strings are derived from the normalized deployment
model. Capabilities that do not require macOS metadata add nothing; microphone access emits only the
audio-input entitlement as an external signing input and an explicitly supplied user-facing purpose
string. Entitlement source files are not shipped inside the application bundle. Bundle mutation
finishes before optional signing, notarization, stapling, archive, or DMG hooks run. Nested dylibs
are signed before the sealed application bundle, and post-staple verification checks the staple,
signature, and Gatekeeper assessment. Unsigned `.app` and ZIP artifacts remain available without
secrets.

Template descriptors record dependencies, rpaths, and UUIDs for every staged Mach-O binary rather
than only the main executable. Finalization validates and rewrites that complete closure. The ZIP
contains the named `.app` wrapper instead of a bare `Contents` directory. Generated dSYMs are
UUID-checked against the player, removed from the application, and published separately with the
template build ID when symbols are requested.

The in-bundle export manifest describes the finalized unsigned payload. Signing and notarization are
sealed distribution transformations over that payload; signature blobs are intentionally not folded
back into the signed manifest because doing so would invalidate the bundle signature. Phase 9 owns
the external signing/notarization report and signed-artifact provenance.

Release CI builds the real arm64 template on macOS, finalizes an unsigned bundle in a Unicode/space
path, validates `Info.plist` and Mach-O dependency closure, launches the `.app` through
LaunchServices, then launches its executable from an unrelated working directory and verifies that
the packaged runtime project reaches the engine main loop.

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

When project-level settings block export, such as a missing entrypoint, icon, or a non-room entrypoint, the Export workbench tab keeps the workflow in preflight, disables export, shows the diagnostics inline, and exposes `Open Project Settings` so the user can fix the project setup without editing JSON.

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

Runtime package profile parsing supports `project.settings.export`. Playable platform profiles are managed separately under `project.settings.platformExport` through the command-backed Export workbench tab.

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

Project Settings is accessible from `Project > Project Settings…` and from the Export tab when project settings block export.

Export workbench tab:

```text
editor/src/renderer/editors/project/PlatformExportEditor.tsx
editor/src/renderer/export/PackageExportDialog.tsx
```

`File > Package Export…` and `Project > Package Export…` open a stable project-scoped **Export**
workbench tab. The tab is scrollable, resizable with the workbench, and supports two explicit modes:

- **Runtime Package (`.ntpkg`)** writes the data-only runtime package.
- **Playable Platform Export** selects a committed platform profile and runs runtime-package export,
  compatible-template resolution, platform staging/finalization, and verification as one workflow.

Platform profiles are stored under `project.settings.platformExport`. **Settings → Export** links to
a separate project-scoped **Export Profiles** workbench tab for profile creation, duplication,
deletion, renaming, target selection, debug/release flavor, debug-symbol policy, architecture/ABI,
artifact format, package-access mode, compression, capabilities, and target-specific
Web/Android/Desktop settings. Profile changes use the command bus and are committed with the
project so CI and other contributors can reference stable profile IDs. The main Export tab only
selects a profile and links to this manager; it does not duplicate profile creation or editing.

Machine-specific export configuration is editor-wide under **Settings → Export**. This includes the
default output root, Android SDK/NDK, Java, CMake, signing identity, and credential-store reference.
These values are persisted in the editor preferences store and are never serialized into a project.
The last chosen output directory and explicit compatible-template choice are typed
per-project/per-profile local preferences; the output falls back to the editor-wide default output
root when no project-specific choice exists.

The platform preflight shows target, architecture, artifact kind, application identity, and the
resolved template/build ID. Installed templates are labeled by trust/compatibility status and only
compatible, non-corrupt templates are selectable. When no compatible template is installed, export
is blocked and the tab provides **Install Template…**. Template archives are verified by the
template registry before they become eligible for export.

Main-process orchestration emits operation-scoped progress for validation, shader compilation,
runtime conversion, template resolution, package writing, metadata/icon generation, staging,
finalization, and verification. Cancellation is checked throughout orchestration and staging,
removes temporary output, and preserves any previously published artifact.

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
  exportProjectToPlatform(request: ProjectPlatformExportRequest): Promise<PlatformStageResult>
  cancelPlatformExport(operationId: string): Promise<{ cancelled: boolean }>
  listPlayerTemplates(query?: TemplateRegistryQuery): Promise<InstalledTemplate[]>
  inspectPlayerTemplate(templateId: string, buildId: string): Promise<InstalledTemplate | null>
  installPlayerTemplate(request: TemplateInstallRequest): Promise<TemplateInstallResult>
  removePlayerTemplate(templateId: string, buildId: string): Promise<{ removed: boolean }>
  resolvePlayerTemplate(request: TemplateResolveRequest): Promise<TemplateResolveResult>
```

Packaged editor builds expose the project/profile workflow noninteractively without opening an
editor window:

```sh
noveltea-editor --export-project \
  --project /path/to/project.json \
  --profile linux-release \
  --output /path/to/dist/game \
  --config /path/to/editor-local-export.json \
  --json
```

The command loads and validates the project, selects the committed platform profile, builds the
runtime package, resolves a compatible installed template, runs the same staging/finalization
service used by the editor, prints structured diagnostics/provenance, and returns stable exit codes:

- `0`: success;
- `2`: invalid project/profile or runtime conversion failure;
- `3`: missing/incompatible/corrupt template;
- `4`: unavailable host toolchain;
- `5`: packaging/finalization failure;
- `6`: cancellation;
- `64`: invalid command arguments.

The lower-level staging contract remains available for service tests and advanced integration:

```sh
noveltea-editor --stage-platform-export < request.json
```

The request must include `runtimePackageReadiness` with `validated: true` and a zero
`blockingDiagnosticCount`. The complete UI workflow supplies this only after authoring validation,
runtime conversion, shader compilation, and `.ntpkg` writing have succeeded. Direct/headless callers
must run the same package-export checks first; the staging service rejects requests without that
readiness result rather than treating an arbitrary existing package path as certified.

The low-level command writes a structured, recursively redacted result to stdout and returns a
nonzero status for invalid requests or unsuccessful staging. It is not the normal user-facing CLI.

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

- Add full scene and dialogue runtime export conversion.
- Add package preview loading through the engine preview server.
- Add shader tool path preferences or better automatic shaderc discovery.
- Add more granular asset reachability based on runtime-converted records.
