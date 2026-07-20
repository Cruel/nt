# Runtime Package Export

## Final Package Contract

Runtime exports are ZIP-based `.ntpkg` files with safe relative paths. The authoritative documents
are separate:

- `gameplay.json`: canonical `noveltea.compiled.project` version 1.
- `manifest.json`: package identity, kind, display/platform launch data, inventory, sizes, and
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

## Player Export

Platform staging writes a versioned `player.json`, the runtime package, template files, and
platform-specific launch metadata. The player verifies config format, package API, checksum, and
capabilities before calling the shared compiled-project loader.

The renderer prepares one current-revision runtime artifact and source fingerprint. Main-process
orchestration reparses the request, recomputes the source fingerprint, hashes the produced package,
and requires matching package evidence before staging. A stale renderer result or mismatched package
bytes cannot bypass readiness.

## Verification

Relevant coverage includes deterministic compiler publication, gameplay-byte equivalence across
consumers, shader/package inventory tests, malformed package/schema tests, player bootstrap tests,
Desktop/Web/Android staging matrices, current-revision evidence checks, packaged-editor smoke, and
Linux/Web/Android builds.
