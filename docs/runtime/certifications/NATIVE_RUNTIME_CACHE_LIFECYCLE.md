# Native Runtime cache lifecycle (#560)

The native Test and Runtime Package CLI commands are no longer dependent on a
precompiled TypeScript runtime generation. Their common path first probes the
canonical disposable runtime cache under `.noveltea/cache/runtime`. A hit uses
the existing verified artifact; a miss, stale generation or unusable artifact
triggers an entirely native rebuild. The C++ Project owner admits one disk
generation, the native compiler lowers gameplay, the artifact assembler builds
the package contract, physical preparation pins external inputs, and the Test
catalog is lowered from the same admitted Project. The cache remains optional:
an in-memory completed generation can be used when publication fails after
Project admission. Unsafe workspace state instead fails the admission itself.

The native cache publisher retains the **single** canonical runtime schema and
immutable generation directories, with `current` replaced atomically only
after durable generation files are installed. Native calls additionally pass
the exact admitted source-generation proof; publication checks it both before
preparation and before replacing `current`, alongside its physical input
metadata/discovery proofs and incumbent-pointer check. Source drift returns a
revision conflict to the CLI. The runtime inventory also tracks admitted
existing physical inputs (but not virtual/optional or editor-state sources).
Each package file entry pins its exact `expectedSha256`, including generated
WebM/WebP media. Warm admission verifies those bytes, invalidates old unpinned
caches, and rebuilds on physical mutation. The package writer rechecks each
pin while staging its ZIP; the CLI and cache publisher also re-prove the pinned
bytes immediately before their final atomic publication checks. A cross-process
OS file lock (`.publish.lock`)
serializes concurrent native publishers through the atomic pointer replacement;
the lock file remains in place so that later writers cannot acquire a different
inode, and an interrupted process automatically releases its lock. A cancelled
publication rejects without replacing `current`. A crash may leave orphan
generations or temporary pointers, but does not make them current; incomplete
staging is disposable. A corrupt `current` can be replaced if it is a regular
file; unsafe symlinks fail workspace preflight and are not overwritten. Warm
reads reject invalid compiled wire even if the forged runtime bytes were
rehashed to match their manifest.

The compiled Material `byteHash`/`byteSize` inventory is also authoritative for
required generated shader binaries, which live beneath `shaderAssetRoot` rather
than ordinary package `fileEntries`. Warm cache admission and both publication
boundaries verify the exact required path set and digest; missing, corrupt, or
unrecorded binaries cannot be packaged. Shader compiler cache hits likewise
require matching recorded bytes, so damaged disposable binaries are regenerated.
Unsafe symlinked compiler destinations block the rebuild without replacing the
incumbent package. `native_cli_shader_integrity` independently exercises the
warm repair, missing-file regeneration, direct writer rejection and blocked
publication cases without repeating the full Feature Lab suite.
For a focused shader repair gate, run `ctest --test-dir build/linux-debug
--output-on-failure -R '^native_cli_shader_integrity$'` after rebuilding
`noveltea-native-cli` and `noveltea-runtime-cache-publish-certify`.

Authored Test-only changes do not invalidate compiled gameplay. The CLI lowers
the new catalog from a fresh native source admission, retains the validated
runtime inputs from the cached manifest, and republishes a complete generation
after source/metadata checks. A failed catalog refresh does not change the Test
verdict. Package options with include-unused/keep-shader-source overrides are
prepared as in-memory custom builds, **not** installed as the canonical
default-profile cache. `package export --force-rebuild` explicitly prepares a
new canonical generation. Runtime Package output retains its independent
staged-file publication and rechecks Project authority before committing.

## Focused verification

With a compiler identity sealed at CMake configure time, run:

```
cmake --build --preset linux-debug --target noveltea-native-cli noveltea-runtime-cache-publish-certify
ctest --test-dir build/linux-debug --output-on-failure -R '^(native_cli_cold_runtime|native_runtime_cache_publish|native_runtime_physical)$'
```

`tests/native_cli/cold_runtime.py` constructs a fresh native Project, uses the
actual CLI with no TypeScript-produced cache, then verifies cold publication,
warm reuse, authored-source staleness, malformed and forged-digest artifact
rejection, explicit rebuild, and safe refusal to rewrite an unsafe cache
pointer. Existing C++ publisher tests additionally exercise revision races,
malformed inventories, cancellation, concurrent publication, source-generation
proofs, and atomic pointer behavior.
If the candidate binary has no exact compiler identity, this integration test
is explicitly skipped rather than forging a production cache identity.
The cold Feature Lab acceptance now also tests video-source mutation, damaged
prepared-media repair, incumbent ZIP preservation on failed exports, and real
child-process interruption during media preparation, cache staging, and ZIP
staging. Acceptance-only fault-injection knobs
`NOVELTEA_TEST_PAUSE_CACHE_COMMIT=1` and
`NOVELTEA_TEST_PAUSE_PACKAGE_COMMIT=1` provide a three-second kill window
before their respective atomic pointer/ZIP replacements.

The Feature Lab remains covered by the independent native compiled-project,
artifact and physical-preparation certifications; this ticket does not change
authored gameplay or Lab content. End-to-end player/Test performance and
qualification remain independently owned by #561, platform export by #545,
and the production ScriptC cutover by #551.
