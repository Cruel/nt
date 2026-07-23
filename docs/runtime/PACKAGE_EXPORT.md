# Runtime Package Export

## Final Package Contract

Runtime exports are ZIP-based `.ntpkg` files with safe relative paths. The authoritative documents
are separate:

- `gameplay.json`: canonical `noveltea.compiled.project` version 2.
- `manifest.json`: runtime-package format version 2 with package identity, canonical reference
  resolution, world raster policy, accessibility policies, platform launch data, inventory, sizes, and
  optional checksums.
- `shader-materials.json`: optional shader/material manifest.
- referenced assets and required compiled shader binaries.

Gameplay JSON never embeds package inventory or shader/material manifests.

## Production

The editor calls `buildCompiledRuntimeExport`, which wraps the single
`publishCompiledArtifact` compiler publication service. That assembly adds file entries,
shader/material metadata, required shader binaries, and package options without rebuilding gameplay
properties.

Preview, playback, package export, and platform export consume the exact canonical gameplay bytes
from publication. Runtime-package-classified compiler/readiness errors block publication and export;
platform-only deployment errors do not block Play or `.ntpkg`.

Blank or malformed authored project name/version values remain visible authoring diagnostics, while
detached runtime output deterministically uses `[Unnamed Project]` and `0.0.0`. Those fallbacks never
rewrite authoring content or recovery metadata.

The native `ProjectPackageWriter` accepts the compiled gameplay JSON plus package options. It has no
`ProjectDocument` overload and no old-format writer.

Runtime media that already has its own compression (`.ogg`, `.opus`, `.mp3`, `.png`, `.jpg`,
`.jpeg`, and `.webp`) is written as a ZIP stored entry rather than being deflated again. Entries under
the conventional `music/`, `ambience/`, `audio/music/`, and `audio/ambience/` paths are also always
stored, including formats such as WAV, so long-form audio can be decoded through direct random access.

## Loading and Validation

The engine package loader rejects:

- unsafe, duplicate, missing, or unmanifested archive entries;
- unsupported manifest/gameplay schema or version;
- mismatched project identity;
- checksum or declared-size mismatches;
- malformed shader/material metadata or absent required shader binaries;
- invalid compiled references/resources;
- Lua that fails certification.

No legacy package reader or fallback exists. A package is assembled into
`LoadedCompiledPackage` only after all validation succeeds.

`ZipAssetSource` supports either a package path or immutable package bytes. Path-backed construction
indexes the central directory without materializing the complete archive, and every opened entry owns
its archive/decompression cursor. Stored entries report direct seekability and read from their package
range; deflated entries report non-seekability and use independent streaming decompression state.
Archive indexing rejects unsafe or duplicate paths, supports ZIP64 metadata, and preserves typed source
error codes and package/entry context. Music and ambience validation rejects any classified entry that
is not directly seekable.

Native and materialized Android package startup opens the `.ntpkg` through `AssetManager`, mounts a
path-backed `ZipAssetSource` as the `project:/` namespace, and reads only `manifest.json`, `game`, and
the optional manifest-declared `shader-materials.json` entry. Validation uses the indexed entry
inventory and central-directory CRC metadata, so unrequested payloads are neither decompressed nor
copied during startup. After decoding, the generic JSON documents are released and `RunningGame`
retains only the typed compiled project/package model.

Until the typed asynchronous loaders in the later residency phase replace it, prepared-asset consumers
continue to use the existing synchronous per-entry `AssetManager` path. This is intentionally an
entry-at-a-time compatibility bridge; the engine no longer extracts a package into a whole-package
`MemoryAssetSource`. Sources without a native backing path may use one immutable compressed archive
buffer, which is the required handoff shape for the later Web bootstrap work.

## Player Export

Platform staging writes player-config version 2 using runtime-package API 2, the runtime package,
template files, and
platform-specific launch metadata. The player verifies config format, package API, checksum, and
capabilities before calling the shared compiled-project loader.

`player.json` carries reference resolution, world raster policy, and accessibility policies. Desktop,
Web, and Android staging derive launch aspect/orientation from reference resolution at their platform
boundary; those derived values are not duplicated into the compiled project or canonical package
display metadata.

The renderer prepares one current-revision runtime artifact and source fingerprint. Main-process
orchestration reparses the request, recomputes the source fingerprint, hashes the produced package,
and requires matching package evidence before staging. A stale renderer result or mismatched package
bytes cannot bypass readiness.

## Verification

Relevant coverage includes deterministic compiler publication, gameplay-byte equivalence across
consumers, shader/package inventory and storage-policy tests, ZIP path-safety/ZIP64/corruption and
concurrent-reader tests, malformed package/schema tests, player bootstrap tests, Desktop/Web/Android
staging matrices, current-revision evidence checks, packaged-editor smoke, and Linux/Web/Android
builds.
