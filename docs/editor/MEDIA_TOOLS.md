# Private media-preparation tooling

FFmpeg is a separate-process authoring tool, never a player dependency. This boundary establishes
installation, diagnosis, and trusted host invocation only: Video import normalization, representation
policy, and runtime playback are not implemented here.

## Ownership and installation

`editor/src/shared/media-tool-pin.json` is the authoritative release/version/archive-hash pin for
[the nt-tools release](https://github.com/Cruel/nt-tools/releases/tag/ffmpeg-r1).
`editor/scripts/private-media-tools.mjs` downloads the host archive, verifies its pinned SHA-256 before
extraction, validates provenance and file checksums, and stages the **entire** bundle. Corresponding
sources, build recipe, configuration, provenance, and licenses travel with the executable; do not
redistribute only its `bin/` directory.

The existing release host CLI builds run this staging on Linux x64, Windows x64, and macOS arm64.
Each build executes the CLI's media-tool check from a relocated installation with spaces in its path.
Editor staging copies that verified tool bundle (or downloads the same pin when an explicitly supplied
CLI has no sibling bundle), then existing stage/package verification and relocation checks validate it.
The electron-builder resource declaration includes private tools separately from public CLI binaries.

Layouts:

- Standalone CLI: `<cli-directory>/tools/ffmpeg/bin/ffmpeg[.exe]`.
- Editor: `<resources>/tools/ffmpeg/bin/ffmpeg[.exe]`, beside—not inside—`<resources>/bin/`.

Only the existing public CLI directory participates in installer PATH integration. FFmpeg is not
added to PATH, game packages, or player templates. Resolution follows the real CLI executable,
including when the public CLI is a symlink, rather than the working directory or ambient PATH.

## Shared service and diagnostics

`editor/src/main/services/media-preparation-service.ts` owns the resolver, identity/capability checks,
and argv-based separate-process invocation. It is compiled into both the standalone ScriptC host
and Node/Electron tooling. Editor composition uses `checkMediaTools`/`prepareMedia` in
`editor-tool-service.ts`; headless host jobs use the same service. This synchronous host boundary is
for trusted tooling jobs; future long-running preparation should execute in disposable workers,
not directly in the interactive main loop. Do not expose raw arguments from authored data or IPC.

```sh
noveltea --json media-tool check
```

This Project-independent, read-only command returns the executable, bundled/external selection,
version, and bundled release. Missing/unexecutable tools, a wrong bundled version/configuration, or
missing AV1/VP9 encoders or local-file/pipe protocols return exit code 6 with a `media.tool` diagnostic.
It does not transcode Project media or add runtime video support.

Set `NOVELTEA_FFMPEG` to an **absolute executable path** for a developer/distro/modified external
build. External builds must identify as FFmpeg and provide the required encoders/protocols, but need
not match the official version or license configuration. There is no automatic PATH fallback. Official
package qualification clears this override so a local tool cannot mask a broken bundle.

For offline builds, `NOVELTEA_FFMPEG_ARCHIVE` names a downloaded release archive. This build-only
input still has to match the checked-in archive hash; it is not an arbitrary-tool override.

## Verification

Focused tests cover resolver relocation on the three desktop hosts, explicit external selection,
identity/configuration/capability failures, admitted target selection, and checksum rejection.
The CLI build checks actual relocated tool identity on each native host. Editor package smoke invokes
the shared service on a small deterministic source, encodes VP9 WebM, decodes it, and checks the
resulting pixels. Full Windows/macOS executable smokes require their native release runners.
Feature Lab is not applicable: this is host-tool installation, not runtime-observable authoring behavior.
