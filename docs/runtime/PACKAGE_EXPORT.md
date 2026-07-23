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

Audio residency captures the selected mounted source and logical path in an `AssetReaderFactory`.
Miniaudio's custom VFS maps its private resource name to that factory, opening a fresh independent
`AssetReader` for each long-form data source. Package-backed music and ambience therefore read and
seek directly inside the stored ZIP entry, retain no whole-entry encoded `AssetBlob`, and remain bound
to the source generation from which they were prepared even if the namespace is later replaced.
Miniaudio owns two one-second decoded stream pages at the configured 48 kHz stereo float format;
NovelTea charges 768,000 audio bytes per resident stream source and pins the resident asset for the
lifetime of playback.

Native and materialized Android package startup opens the `.ntpkg` through `AssetManager`, mounts a
path-backed `ZipAssetSource` as the `project:/` namespace, and reads only `manifest.json`, `game`, and
the optional manifest-declared `shader-materials.json` entry. Validation uses the indexed entry
inventory and central-directory CRC metadata, so unrequested payloads are neither decompressed nor
copied during startup. After decoding, the generic JSON documents are released and `RunningGame`
retains only the typed compiled project/package model.

Typed asynchronous preparation now exists for visual, font-source, and audio assets. Existing runtime
consumers may still use the synchronous per-entry compatibility methods until mandatory blocker
integration and final cleanup, but the compatibility path is still entry-at-a-time and long-form audio
uses the same seekable reader/VFS streaming boundary. The engine neither extracts a package into a
whole-package `MemoryAssetSource` nor materializes long-form audio as a whole-entry blob.

Web startup owns the full package download in the browser and reports one loading operation across
`DownloadingPackage`, `VerifyingPackage`, `OpeningPackageIndex`, and `LoadingStartupContent`.
Package-download progress uses response bytes when `Content-Length` is available and remains
indeterminate otherwise. Navigation cancels the active operation, retryable transport failures expose
retry with a new operation ID, and checksum/config/package failures remain fatal.

The browser verifies the configured SHA-256 before releasing Emscripten's run dependency. At runtime
initialization it copies the completed bytes directly into the final C++-owned immutable archive
allocation, clears the JavaScript reference immediately, and constructs a memory-backed
`ZipAssetSource`; the package is never written to Emscripten's virtual filesystem. The startup loader
then reads only package metadata and minimum startup entries, while later consumers open other entries
on demand through the mounted ZIP source. After handoff, Web retains one compressed package backing
plus the active decompressed working set rather than a VFS package copy or all decompressed entries.

## Player Export

Platform staging writes player-config version 2 using runtime-package API 2, the runtime package,
template files, and
platform-specific launch metadata. The player verifies config format, package API, checksum, and
capabilities before calling the shared compiled-project loader.

`player.json` carries reference resolution, world raster policy, accessibility policies, and the
fully resolved asset-memory policy selected by the platform export profile. That policy contains the
preset name, prepared-CPU/GPU/audio/temporary byte ceilings, and Warm-prefetch percentage; it never
uses zero or an omitted value to mean unlimited. Version-2 configs produced before this field existed
remain valid and resolve to the target's measured Balanced defaults. Desktop, Web, and Android staging
derive launch aspect/orientation from reference resolution at their platform boundary; those derived
values are not duplicated into the compiled project or canonical package display metadata. See
`docs/assets/ASSET_MEMORY_PROFILES.md` for measurements and exact defaults.

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
