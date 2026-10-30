# Native CLI cold Feature Lab and Runtime Package acceptance (#561)

The public native CLI executes the normal authored Test catalog and prepares a
Runtime Package from the **same cold, native-admitted Project generation**.
It does not require a warmed TypeScript/ScriptC cache. The reference CLI remains
the shipped executable until the separate #551 cutover.

## Full-stack certification

The integration test `native_cli_feature_lab_cold` copies the C++ CLI, native
UI runner, system assets and pinned media binary to a disposable installation, and separately copies
the real Feature Lab Project **without `.noveltea`**. Its subprocess PATH
contains only that installation; Node, pnpm, ScriptC and the source checkout's
CLI are not available. Video preparation is still a native host-tool operation
and requires NovelTea's pinned `ffmpeg-r3` (FFmpeg 9.0.1) via `NOVELTEA_FFMPEG`.
That binary is an explicit prerequisite, not a system FFmpeg substitute.

Run the native candidate build and certification on Linux:

```sh
cmake --build --preset linux-debug --target noveltea-native-cli
ctest --test-dir build/linux-debug --output-on-failure \
  -R '^native_cli_(feature_lab_cold|cold_runtime|public_contract)$'
```

Set `NOVELTEA_NATIVE_CLI_CERTIFY_FFMPEG` at CMake configure time if the pinned
media tool is not at `build/cli/linux/tools/ffmpeg/bin/ffmpeg`. A build without
an exact bound compiler identity or pinned FFmpeg reports a **skipped** cold
integration test (exit 77), not successful certification. For a dirty local
checkout, explicitly configure a unique development identity with
`-DNOVELTEA_NATIVE_CLI_BUILD_IDENTITY=dev:<unique-identity>`; the production
identity must always be derived from its own exact build.

The test asserts the complete **43/43** Feature Lab semantic/UI suite, a warm
catalog hit, named Test execution (including an audio-dependent Test), direct
semantic and UI stdin specs, a deliberately failed runnable assertion, and
human/JSON verdicts. JSON output must be a
single parseable line with empty stderr even during cold shader compilation.
It independently opens a default `.ntpkg` ZIP and checks compiled gameplay,
manifest, shader/material metadata, required shader binaries, private prepared
media, distribution notice index and audio files. It also exercises the
include-unused-assets and include-shader-sources overrides without replacing
the canonical cache, and checks that rejected profile and symlinked-output
exports preserve the previous complete package. A changed physical Asset is
not allowed to silently publish bytes from a stale generation.
When a Linux player and `xvfb-run` are built/available, the integration test
also boots the **same cold-exported Feature Lab `.ntpkg`** in the real player
and requires its runtime-ready signal. Otherwise this additional player gate
is explicitly reported as skipped, rather than claiming runtime startup.

The native authored-Asset closure is conservative for **audio**. The Lua audio
APIs accept Asset IDs as runtime strings; therefore a typed `$ref` traversal
alone cannot prove audio is unused. All admitted audio Assets remain eligible
for a Runtime Package even when `excludeUnusedAssets` is selected. Other
statically unreachable Assets still obey that option. The same native owner
supplies this reference closure to both native and reference preparation; no
Lua parsing heuristic or TypeScript-only substitute is introduced.

Embedded shaderc is compiled without upstream bx debug tracing for native CLI
consumption, because its successful shader reflection trace otherwise writes
to stdout and violates the machine-readable one-envelope protocol. This does
not change shader outputs or the runtime renderer's debug configuration.

## Related independent gates

- `native_compiled_project_parity`: independently compares the complete cold
  Compiled Project against the TypeScript reference wire and Save Contract.
- `native_runtime_artifact_parity` and `native_runtime_physical`: verify profile,
  localization, shader, media and prepared artifact parity and source proofs.
- `native_runtime_cache_publish` and `native_cli_cold_runtime`: cover stale
  revisions, corrupt/forged caches, cancellation, concurrent publication,
  symlinked pointers and forced generation replacement.
- `noveltea_player_runtime_compiled_package_smoke` (where a Linux player and
  graphical smoke environment are configured): loads and presents a generated
  Runtime Package in the actual player. The Feature Lab acceptance fixture's
  own ZIP readback is not substituted for player startup.

These checks supplement rather than replace the broader Linux/Web/Android
qualification gates. Platform-specific export orchestration belongs to #545;
installing the native CLI as the production replacement and removing ScriptC
belong to #551.

## Host verification status (26 October 2026)

- **Linux (verified):** Debug C++ CLI rebuilt; relocated Feature Lab Tests
  43/43, independent cold package export, warm/default and override ZIP
  inspection, failure preservation, runtime artifact reference parity,
  physical preparation, public CLI contract and cold cache lifecycle pass.
  The same exported Feature Lab package was booted in the Linux player with
  staged system fonts/shaders and Xvfb, reaching `NOVELTEA_PLAYER_READY` and
  completing its five-frame run. The media prerequisite was pinned FFmpeg r3.
- **Windows (not verified by #561):** No Windows native CLI build or relocated
  playback/export certification was run. The Python certification skips the
  symlink-attack subcase explicitly if the host cannot create a symlink.
  Windows packaging, host subprocess/FFmpeg behavior and player startup remain
  a separate host CI/release gate; Linux success is not Windows evidence.
- **macOS (not verified by #561):** No native CLI build, FFmpeg-r3 media prep,
  Test playback, package export or player startup was performed on macOS.
  These remain host release/portability gates, not a claimed pass.

Canonical Test/compiled wire and artifact differential checks against the
current TypeScript reference are owned by
`native_compiled_project_parity` and `native_runtime_artifact_parity`. The
historical ScriptC Feature Lab baseline is 43/43 in
`docs/runtime/certifications/FEATURE_LAB_BASELINE.md`. No claim is made that
every Test execution trace is byte-identical between the unshipped native CLI
and the production ScriptC executable; acceptance compares deterministic
compiled outputs and the full authored suite verdict.
