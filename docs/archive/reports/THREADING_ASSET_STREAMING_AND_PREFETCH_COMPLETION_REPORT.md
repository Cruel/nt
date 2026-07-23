# Threading, Asset Streaming, and Prefetch Completion Report

Status: Complete
Date: 2026-07-23
Archived plan: `docs/archive/plans/THREADING_ASSET_STREAMING_AND_PREFETCH_IMPLEMENTATION_PLAN.md`

## Scope completed

The plan's production concurrency, indexed package access, asynchronous typed-asset requests,
residency, structured prefetch, mandatory publication gates, telemetry, and production-path cleanup
are complete. The final review also closed eight defects found after the initial Phase 9B commit:

1. ActiveText now reacquires its asynchronous system-font request whenever project/font configuration
   advances the asset source generation.
2. Package entries carry explicit ZIP storage intent. Authored audio is stored and validated as
   seekable independently of filename, extension, or directory conventions.
3. Native path-backed ZIP sources retain one open archive identity, so old leases and reader
   factories cannot observe a replacement archive renamed onto the same pathname.
4. Web executor shutdown is event-loop-driven and never spins or sleeps the browser owner thread.
5. Repository diff hygiene is clean.
6. Texture preparation parses dimensions and expands its temporary reservation before decode and mip
   allocation.
7. Decoded audio expands its temporary reservation for complete PCM before allocating that cache.
8. Candidate project publication binds the mandatory asset gate before the initial presentation
   snapshot reaches rendering backends.

## Final architecture

- Production uses one platform-selected `JobExecutor`: SDL thread pool by default on native,
  Android, and threaded Web; cooperative execution for the supported no-thread fallback.
- Worker jobs perform bounded source reads, decoding, shaping, compilation, and preparation. Backend
  creation, publication, lease transitions, and destruction remain owner-thread work.
- Runtime packages remain indexed ZIP sources. Native mounts retain a file identity; Web retains the
  downloaded immutable package buffer without a virtual-filesystem copy.
- Typed `request_*()`/`prefetch_*()` APIs, move-only request handles, copyable leases, source
  generations, coalescing, cancellation, priority recomputation, and retry are the sole production
  prepared-asset path.
- `AssetResidencyManager` owns temporary reservations, final admission, Pinned/Warm/Cold state,
  deterministic eviction, per-domain current/high-water accounting, and pressure diagnostics.
- Texture and decoded-audio tasks may checkpoint after metadata discovery, atomically resize their
  existing reservation on the owner thread, and resume only after admission.
- Structured dependency collection and prefetch generations use typed semantic descriptors. Mandatory
  publication gates block candidate world/Layout/audio publication until required leases are ready;
  speculative work remains non-blocking and evictable.
- Telemetry observes scheduler and residency behavior without controlling it. The editor boundary is
  an immutable owning profiler snapshot; transport and profiler UI remain separate future work.

## Resolved memory defaults

All byte values are exact powers-of-two profile ceilings. Windows, Linux, and macOS use Desktop.

| Target | Preset | Prepared CPU | GPU | Audio | Temporary | Warm |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Desktop | Low | 67,108,864 | 134,217,728 | 33,554,432 | 33,554,432 | 20% |
| Desktop | Balanced | 134,217,728 | 268,435,456 | 67,108,864 | 67,108,864 | 30% |
| Desktop | High | 268,435,456 | 536,870,912 | 134,217,728 | 134,217,728 | 40% |
| Android | Low | 50,331,648 | 100,663,296 | 25,165,824 | 25,165,824 | 15% |
| Android | Balanced | 100,663,296 | 201,326,592 | 50,331,648 | 50,331,648 | 25% |
| Android | High | 201,326,592 | 402,653,184 | 100,663,296 | 100,663,296 | 35% |
| Web | Low | 33,554,432 | 67,108,864 | 16,777,216 | 16,777,216 | 10% |
| Web | Balanced | 67,108,864 | 134,217,728 | 33,554,432 | 33,554,432 | 20% |
| Web | High | 134,217,728 | 268,435,456 | 67,108,864 | 67,108,864 | 30% |

Representative measurements used to select the profiles include 44,236,220 GPU bytes for a 4K
RGBA8 full mip chain, 11,520,000 audio bytes for 30 seconds of 48 kHz stereo float PCM, and 768,000
audio bytes for the two-page long-form stream charge. Current detail remains in
`docs/assets/ASSET_MEMORY_PROFILES.md`.

## Validation results

### Linux

- Threaded `linux-debug` build: passed.
- Threaded full CTest under Xvfb: **740/740 passed**.
- Cooperative `linux-debug-no-threads` build: passed.
- Cooperative full CTest under Xvfb: **740/740 passed**.
- Readback, compiled-package, scheduler, residency, prefetch, telemetry, and production-path policy
  tests passed in both matrices.

### Web

- Threaded `web-debug` configure/build: passed.
- Cooperative `web-debug-no-threads` configure/build: passed.
- The only toolchain messages were the existing Emscripten SDL3 experimental warning and the
  threaded memory-growth performance warning.

### Android

- Threaded x86_64 `:app:assembleDebug`: passed.
- Cooperative x86_64 `:app:externalNativeBuildDebug -PnovelteaEnableThreads=false`: passed.
- Exact exported-package lifecycle smoke passed on **API 24** and **API 35**, including cold install,
  package-backed startup, relaunch, APK update, and save-state persistence.

### Editor and policy

- `pnpm -C editor run check`: passed formatting, lint, and TypeScript; 287 pre-existing warnings and
  zero errors. The active Node version was 22.22.1 while the package requests 24.18.0.
- Editor Vitest: **150 test files passed, 1 platform-integration file skipped; 883 tests passed,
  4 skipped**.
- `cxx-policy`, module/dependency/JSON/public-header policy probes, and `format-check`: passed.
- `git diff --check`: passed.

The commands above reproduce the repository CI jobs locally, including the repository's exact Android
emulator smoke script. A remote GitHub Actions run was not created because the completed work remains
intentionally uncommitted; this is a validation-venue limitation, not an untested platform path.

## Approved deviations

- The final matrix was executed locally rather than as a remote workflow run because no commit or
  push was requested. The same build presets, Gradle modes, tests, policy targets, and Android smoke
  script were used.
- The Android package lifecycle was exercised with an x86_64 template on API 24 and API 35, matching
  the emulator workflow. ARM64 remains covered by the repository's Android build wiring rather than
  this local emulator run.

No architecture or behavior requirement was waived.

## Known limitations

- Web still downloads and retains the complete package archive before indexed access; segmented or
  range-based package transport remains future work.
- ZIP-deflated entries are not directly seekable. Assets that may stream must retain explicit stored
  package policy; export validation now enforces that contract for authored audio.
- The profiler handoff is an immutable engine snapshot only. Editor IPC, polling, stores, and UI are
  intentionally outside this completed plan.
- Cooperative execution preserves correctness but does not provide native parallelism. Long tasks
  must continue to yield in bounded steps.
- Mandatory single assets may exceed a configured temporary or final residency ceiling and are
  admitted serially with pressure telemetry; budgets remain cache-control targets, not correctness
  limits.

## Removed and retained surfaces

Removed production surfaces include synchronous prepared-asset facade methods and aliases,
path-based/raw audio playback, eager full-package extraction/copies, obsolete Web-only thread option
names, and audited synchronous fallbacks in world, material, Layout/font, ActiveText, and preview-audio
consumers. Synchronous byte/text reads remain only at explicit startup, tooling, and test boundaries.

## Recommended production defaults

- Use the threaded executor on Desktop, Android, and threaded Web.
- Keep the cooperative Web template available for hosts without cross-origin isolation.
- Default each target to the Balanced asset-memory profile unless product telemetry justifies another
  preset.
- Treat music, ambience, voice, and any other potentially streamed audio as stored ZIP entries.
- Preserve mandatory-gate publication and retained leases; never reintroduce synchronous loading as a
  fallback for a missing lease.
