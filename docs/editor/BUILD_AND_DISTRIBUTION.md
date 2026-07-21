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

`dev` builds the `web-release` engine preview before starting the editor.
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

The host `noveltea-editor-tool` must be built with the matching native release preset or supplied by
`NOVELTEA_EDITOR_TOOL_PATH`. The engine preview must exist at
`build/web-release/apps/sandbox`.

## Packaging and Security

`pnpm -C editor run package` creates and verifies an unpacked host application. `pnpm -C editor run artifact`
creates native host distributables. electron-builder receives only the staged application and
separate staged resources.

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
CI owns the targets unavailable on the current development host.

The artifact transaction writes `editor/out/electron-builder/latest-artifact.json`, including the
exact file names, sizes, and SHA-256 hashes. `cmake/PackageNovelTeaRelease.cmake` consumes that
manifest, verifies target identity and hashes, and stages deterministic release names under `dist/`.
It does not scan package directories recursively.

Ordinary local and CI smoke builds require no signing credentials. Windows Authenticode, macOS code
signing, and notarization remain release-infrastructure inputs. Provide electron-builder's signing
environment only in credentialed release jobs; do not place credentials in repository files or the
stage.
