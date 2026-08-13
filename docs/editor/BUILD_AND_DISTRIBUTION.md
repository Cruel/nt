# Editor Build and Distribution

## Authoritative Workspace

The repository root owns the JavaScript workspace, pnpm lockfile, Node version, and stable editor
commands. Install from the root with the exact toolchain pinned by `.node-version`, `package.json`,
and `pnpm-workspace.yaml`:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Do not create an editor-local workspace or lockfile. The editor package remains
`noveltea-editor` under the root workspace.

## Product Version and Release Identity

The repository-root `VERSION` file is the sole authored NovelTea product version. It uses
`MAJOR.MINOR.PATCH[-prerelease]`. Do not duplicate the product version in `editor/package.json`,
`vcpkg.json`, CMake source, CLI source, tests, or release-workflow inputs.

CMake reads `VERSION` before `project()`: `NOVELTEA_VERSION` retains the complete product version,
while the numeric `MAJOR.MINOR.PATCH` core is supplied to CMake's `project(VERSION ...)` field. Vite+
uses the same shared parser as release tooling and injects the value into editor and Node/ScriptC CLI
bundles, while ScriptC release staging embeds it into the standalone host. Release editor staging
writes the canonical product version into packaged application metadata. Non-release staging,
including ordinary local and CI builds, uses a derived development build identity instead: `1.0.0`
becomes `1.0.0-dev.<revision>`, and an existing prerelease such as `1.1.0-rc.1` becomes
`1.1.0-rc.1.dev.<revision>`. These development versions are derived from `VERSION`; they are not
independently authored product versions. Editor
runtime product-version reporting and release-matched template downloads use the injected canonical
product version rather than Electron's staged package version.

A manual `Release` workflow run uses GitHub's built-in **Use workflow from** selection as the source
revision and derives `v<VERSION>` automatically. It builds and qualifies the complete release
inventory but does not publish a GitHub Release. A pushed `v*` tag is authoritative external release
identity: `.github/validate-release-version.mjs` requires the pushed tag to equal `v<VERSION>` before
release work proceeds, and only a successful tag-triggered run reaches publication.

## Stable Commands

Run these from the `editor/` directory:

```sh
pnpm dev
pnpm dev:skip-preview
pnpm check
pnpm test
pnpm build
pnpm stage
pnpm package
pnpm artifact
pnpm package:smoke
```

`dev` builds the profiler-enabled `web-editor-preview` engine preview before starting the editor.
`dev:skip-preview` requires that preview to already exist. From the root, prefix with `pnpm -C editor run`.

## Vite+ Toolchain

Vite+ owns renderer development/build, Vitest, Oxlint, Oxfmt, the cacheable task graph, and the
main/preload/Node-tool executable bundles. `tsc --noEmit` remains an explicit independent check.

The Vite+, Vite core alias, and Vitest versions are one coordinated tuple in the root workspace
catalog. To upgrade it:

1. Run the current official Vite+ migration against the editor.
2. Update all three exact catalog versions together.
3. Regenerate only the root lockfile.
4. Run `pnpm -C editor run check`, `pnpm -C editor run test`, `pnpm -C editor run build`, compiler parity, staging, package
   verification, and package smoke before accepting the tuple.

Do not add a second version registry or an Electron/Vite integration framework.

## Development Coordinator

`editor/scripts/dev-editor.mjs` is the sole owner of Electron development processes. It selects a
stable loopback renderer origin at `http://localhost:5174`, starts the Vite+ renderer and pack
watchers, waits for renderer/main/preload
and engine-preview readiness, then launches the workspace Electron executable with
`NOVELTEA_EDITOR_DEV_SERVER_URL`.

The stable hostname and port are part of the editor settings contract because Chromium local
storage is origin-scoped. `NOVELTEA_EDITOR_DEV_PORT` and `--port` remain available for isolated
smokes, but changing the port intentionally selects a separate development storage origin.

Renderer changes use Vite HMR without restarting Electron. Successful main or preload rebuilds
trigger one debounced, serialized Electron restart. Failed initial builds and failed rebuilds are
surfaced rather than treated as successful output. After a failed pack rebuild, the coordinator keeps
the current Electron process alive, replaces the failed pack watcher after the next relevant source
or configuration change, and restarts Electron only after corrected output is written. Ctrl-C,
termination signals, child failure, and parent exit terminate the complete process tree on Linux,
macOS, and Windows.

Development and packaged launches share the explicit application-data namespace
`noveltea-editor`. On Linux this resolves under `~/.config/noveltea-editor`; equivalent platform
application-data roots are used on Windows and macOS. The generic Electron application-data
directory is not used.

## Production Stage

`pnpm -C editor run stage` builds a fresh application under `editor/out/electron-builder/stages/`. The
published stage is created transactionally from a temporary directory and verified again after
relocation.

```text
stage/
  app/
    package.json
    dist-electron/
    node_modules/
  resources/
    engine-preview/
    editor-assets/
    bin/
  stage-manifest.json
```

`stage-manifest.json` uses the exact `noveltea.editor-stage-manifest` identity and version 1. Package
verification rejects a missing or unsupported identity/version instead of treating an older stage as
current.

The application closure comes from the root lockfile through
`pnpm -C editor --prod deploy`. The only top-level production dependency is the exact
`sharp` version; its platform-specific `@img` packages and libvips closure are transitive. The
deployed metadata contains no workspace/catalog protocols, scripts, development dependencies, or
source paths.

The stage manifest records application identity, release tag/version, source revision, target
platform/architecture, Electron and embedded Node versions, installed production packages, every
staged file hash/mode/size, aggregate resource hashes, and relocation validation. Stage verification
also executes a real `sharp` encode/decode operation and rejects undeclared files, source trees,
tests, caches, type-only packages, private keys, and checkout-path leaks.

The standalone `noveltea` CLI must be built for the release-admitted host or supplied by
`NOVELTEA_CLI_PATH`. Normal staging refreshes the repository CLI automatically and copies it to
`resources/bin/noveltea`; that directory contains no `noveltea-editor-tool` compatibility frontend
and no sibling bgfx `shaderc` executable. Linux builds use the native host toolchain. Windows CLI
builds use a dedicated MinGW GNU native-tooling/vcpkg closure plus ScriptC's
`x86_64-windows-gnu` Zig target; the ordinary Windows desktop player/editor remains an independent
MSVC build. CLI certification rejects MinGW runtime DLL dependencies so the published executable
remains relocatable. Shader compilation and raw shaderc forwarding use the statically linked native
tooling inside `noveltea`. Packaged native operations resolve the installation-relative CLI and do
not depend on `PATH`. The profiler-enabled engine preview must exist at
`build/web-editor-preview/apps/editor_preview`; `pnpm -C editor run engine:preview:build` produces it.

Linux DEB and RPM packages install their application closure under `/opt/noveltea-editor` and expose
both public commands through the ordinary system command path:

```text
/usr/bin/noveltea-editor -> /opt/noveltea-editor/noveltea-editor
/usr/bin/noveltea        -> /opt/noveltea-editor/resources/bin/noveltea
```

The editor continues to invoke its installation-relative CLI so its native operations cannot select
an unrelated `noveltea` from `PATH`. The public link exposes that same bundled, certified binary to
terminal users. Package removal unregisters only these package-owned alternatives. AppImage remains
portable and does not mutate `/usr/bin`; users choose its location or use desktop/AppImage integration.

The Windows NSIS installer exposes its bundled `resources\\bin\\noveltea.exe` through the selected
installation scope's `PATH`. Per-user installs update the user environment; per-machine installs
update the machine environment. The installer records the exact entry it owns, broadcasts the
environment change, and removes only that entry on uninstall. If another `noveltea.exe` is already
available, interactive installation preserves it by default and offers an explicit choice to prefer
the editor CLI; silent installation preserves the existing command.

## Packaging and Security

`pnpm -C editor run package` creates and verifies an unpacked host application. `pnpm -C editor run artifact`
creates native host distributables. electron-builder receives only the staged application and
separate staged resources.

Production staging prunes JavaScript source maps from the deployed application closure and package
verification rejects remaining `.map` files, raw first-party `.ts`/`.tsx`, embedded TypeScript source,
or source-checkout path leakage. Development Electron/Vite outputs may retain source maps; they are
not public release contents.

Application identity is defined in authoritative metadata rather than main-process constants:

- `editor/package.json` owns the internal package name, human-facing `productName`, and Linux
  `desktopName`;
- `editor/electron-builder.config.mjs` owns the reverse-domain application ID, executable name,
  artifact naming, and native target settings;
- `editor/build-resources/icon.svg` is the scalable master icon converted by electron-builder for
  Linux, Windows, and macOS;
- `editor/src/main.ts` only overrides the runtime user-data directory to the stable lowercase
  `noveltea-editor` namespace.

Linux packaging enables `syncDesktopName` so the installed desktop entry, Electron application ID,
window class, launcher highlighting, and dock/taskbar grouping share the same identity.

The application is ASAR-only. The complete `node_modules/sharp` and `node_modules/@img` trees are
explicitly unpacked. Engine preview, editor assets, and native tools are outside ASAR under
`process.resourcesPath`. Package verification inspects ASAR contents, native binding/libvips
closure, metadata, resources, executable identity, and Electron fuses.

Required fuse values are:

```text
RunAsNode=false
EnableCookieEncryption=true
EnableNodeOptionsEnvironmentVariable=false
EnableNodeCliInspectArguments=false
EnableEmbeddedAsarIntegrityValidation=true
OnlyLoadAppFromAsar=true
LoadBrowserProcessSpecificV8Snapshot=false
GrantFileProtocolExtraPrivileges=false
WasmTrapHandlers=true
```

`pnpm -C editor run package:smoke` launches the latest unpacked application under a temporary profile. On
Linux it uses Xvfb. The smoke verifies main startup, renderer load, preload API, packaged custom
protocol and traversal rejection, isolation headers, engine-preview serving, editor assets, native
tool presence, a real packaged `sharp` operation, and clean exit.

## Native Artifacts and Release Collection

Artifacts are native-host only:

| Host | Target architecture | Artifacts |
| --- | --- | --- |
| Linux | x64 | AppImage, DEB, RPM |
| Windows | x64 | NSIS installer |
| macOS | arm64 | DMG, ZIP |

Linux packaging requires the ordinary Electron desktop libraries plus `rpm` and `fakeroot`.
Windows NSIS validation must run on Windows, and DMG/ZIP validation must run on Apple Silicon macOS.
CI owns the targets unavailable on the current development host. Desktop release certification also
builds the host-native `noveltea-tooling-bridge`; the canonical export fixture uses that bridge to
exercise the real native shader/package operations without assuming a Linux CLI can execute on
Windows or macOS. Native-player smoke tests may set `NOVELTEA_PLAYER_HEADLESS_ERRORS=1` so startup
failures are reported on stderr instead of blocking CI behind a modal error dialog; shipped players
retain the normal dialog behavior when that variable is absent.

Tagged and manually qualified releases require Linux x64 and Windows x64 editor artifacts. The
standalone Linux and Windows CLIs are built and certified once per host; the exact same bytes are
published independently and embedded in that host's editor. Release aggregation rejects a missing
or unexpected CLI, editor, or player-template platform artifact before a GitHub Release can be
created.

The editor does not bundle player templates. When the selected export profile has no compatible
installed template, the Export surface can explicitly download the one matching the running
editor's release, target, architecture, and build flavor. It accepts only the official GitHub
release hosts, cross-checks the registry entry with `SHA256SUMS`, streams with bounded size, verifies
the archive and descriptor hashes, and installs through the transactional per-user template
registry. Offline users can continue to use `noveltea platform template install <archive>`.

The artifact transaction writes `editor/out/electron-builder/latest-artifact.json`, including the
exact file names, sizes, and SHA-256 hashes. `cmake/PackageNovelTeaRelease.cmake` consumes that
manifest, verifies target identity and hashes, and stages deterministic release names under `dist/`.
It does not scan package directories recursively.

Ordinary local and CI smoke builds require no signing credentials. Windows Authenticode, macOS code
signing, and notarization remain release-infrastructure inputs. Provide electron-builder's signing
environment only in credentialed release jobs; do not place credentials in repository files or the
stage.
