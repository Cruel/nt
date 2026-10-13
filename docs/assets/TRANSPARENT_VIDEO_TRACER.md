# Transparent-video integration tracer (#408)

This is a validation path for the selected **opaque VP9/WebM color + one
lossless animated WebP alpha** representation, not a new authoring format or
a production transparent-video package reader. The sole authorable video
source remains an Asset referenced by an Animation. #409 owns transparent
runtime package/lease publication, native/Web player decoders, authored
Material integration, and Interactable visual-alpha parity.

## Implemented evidence

- `editor/src/main/services/transparent-video-tracer.ts` invokes the **production**
  `prepareOpaqueVideoMotion` for source-timed VP9 color. For alpha, FFmpeg
  explicitly selects the libvpx VP8/VP9 decoder for WebM, checks the **decoded
  pre-conversion pixel format** for alpha rather than trusting WebM metadata,
  and refuses fully opaque decoded coverage as proof of a transparent
  source. It reuses the color preparer's source-range and frame-sampling
  filter planners and normalizes the alpha plane into the same scaled,
  centered, zero-padded canvas. Both paths consume one validated immutable
  source-byte snapshot even if the original Project file changes during
  preparation. Frame durations and endpoint must match the production
  color representation exactly or tracing fails.
- Alpha is extracted as 8-bit gray and encoded by the editor's existing
  Sharp/libwebp dependency into **one lossless animated WebP**, with
  millisecond page durations. Identical consecutive masks are coalesced
  into one timed hold, not duplicated to align with video color frames.
  WebP metadata, delays, all page pixels, and byte-for-byte alpha
  round-tripping are verified. The temporary raw masks are removed. The
  tracer refuses raw decoded alpha exceeding 64 MiB, rather than trying
  to materialize unlimited video samples in memory.
- `WebpAlphaTraceSession` holds the compressed WebP plus at most one
  decoded CPU alpha mask at a time, reuses that mask for held intervals,
  and exposes the same R8 bytes to CPU hit queries (`alpha > 0`). Sharp
  opens a new decoder for each changed page and is intentionally **not**
  proposed as the #409 runtime decoder. Independent test-only
  `tests/media/webp_alpha_persistent_probe.py` uses libwebp's actual
  `WebPAnimDecoder` to decode all pages using **one retained decoder**,
  repeatedly reset/replay and seek backward/forward, check presentation
  millisecond durations and exact R8 bytes, and report peak/steady RSS.
  The native GPU trace now accepts *those same persistent-decoder R8 bytes*
  for `WorldVideoStream` presentation when the probe is available; it
  checks their equality to the Sharp reference. This verifies decoder
  feasibility without introducing #409's runtime decoder owner.
- The real native `WorldVideoStream` VP9 texture lease can be drawn
  through an R8 GPU mask using the `video_alpha` built-in quad shader.
  The baseline native GPU smoke uploads a controlled 0/128/255 R8 plane,
  submits an ordinary video color lease against green, and checks readback
  for fully transparent, blended, and opaque output. An additional real
  transport trace sends **the WebP-decoded 8-bit pixels** for two timed
  alpha pages into bounded double-buffered R8 GPU textures and draws them
  with the actual production `WorldVideoStream` VP9 color at time 0 and
  125 ms. The native trace also tests repeated color-frame holds at 25/75
  and 125/175 ms and backwards/forwards presentation at 25/175/0 ms,
  reusing the same two R8 textures. That trace verifies the held prior
  mask is not overwritten by the next deliberately paired color/alpha
  sample, including partially covered edge pixels against green, black,
  and white backdrops. Updating the
  currently sampled R8 texture in-place produced stale alpha in a
  native capture; #409 must retain the prior complete color/mask pair
  while preparing an independent replacement. A mask-bearing draw with
  a custom author Material is **explicitly unsupported**, rather than
  silently replacing the Material.

### Automated checks

Run the traced-media and conditional large-mask checks using the pinned
Linux FFmpeg tool distributed with the built CLI:

```sh
pnpm -C editor exec vp test run src/renderer/test/transparent-video-tracer.test.ts
NOVELTEA_ALPHA_STRESS=1 pnpm -C editor exec vp test run src/renderer/test/transparent-video-tracer.test.ts --reporter=verbose --silent=false
NOVELTEA_ALPHA_QUALIFY=1 pnpm -C editor exec vp test run src/renderer/test/transparent-video-qualification.test.ts --reporter=verbose --silent=false --testTimeout=480000
cmake --build --preset linux-debug --target noveltea_native_video_texture_smoke
ctest --test-dir build/linux-debug -R '^noveltea_native_video_texture_smoke$' --output-on-failure
```

The persistent libwebp proof requires Linux, Python 3 (stdlib only) and an
installed `libwebpdemux.so` (test machine only; **not** linked into NovelTea or
required by exported players). If absent, the original native GPU test still
runs with Sharp's reference R8 masks and explicitly reports the skipped probe.
The optional high-resolution qualification requires that test-only library.

The real-media test synthesizes alpha-bearing ProRes 4444 MOV,
VP8-alpha WebM, and VP9-alpha WebM sources with the pinned encoder, runs the true VP9 color
preparer, checks pixel-exact 8-bit WebP round trips, 2 mask holds across
4 color frames, padding, CPU hits, holds, and end-of-motion rejection.
It also covers 20 FPS and 30000/1001 FPS conversion, Retain 50%, source-range cropping,
a genuinely VFR alpha stream, a source-replacement race, and fail-closed
alpha decoding of an opaque VP9 source. Tests are skipped when the pinned FFmpeg executable is not
present. No separate authored hit-mask sidecar is generated.

### Illustrative stress observation (2026-10-13, Linux)

Two extremely compressible synthetic alpha pages at each resolution,
using Sharp/libwebp in the editor test process:

| Canvas | One decoded R8 mask | Encoded WebP | Encode | Decode 2 pages | Process RSS after step |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1920×1080 | 2,073,600 bytes | 350 bytes | 55.9 ms | 47.1 ms | 394.1 MiB |
| 3840×2160 | 8,294,400 bytes | 894 bytes | 257.9 ms | 184.6 ms | 624.6 MiB |

These numbers include the Vitest/Node/Sharp process and caching; they
are **not a video playback, representative-content, runtime-memory, or
GPU-throughput benchmark**, and do not establish a numerical acceptance
gate. Real footage, motion complexity, seeking costs, edge halos, and
platform/device memory still require production player qualification.

## #408 qualification and #409 boundary

The selected **one lossless animated WebP alpha + prepared VP9 color**
transport has been validated against the real encoder, a persistent native
libwebp decoder, source-timestamp variations, R8 GPU upload, straight-alpha
composition, held masks, seek/loop/reset traces, and CPU alpha-hit bytes.
The optional 1080p/4K qualification encodes generated **source MOV media**
with moving textured color and irregular antialiased/holed alpha, rather
than testing only constant-color synthetic masks. It measures preparation,
trace decode, persistent native decoder memory and repeated seeks. These are
real end-to-end encode/decode workloads, **not** a sample of actual filmed
footage or a target-device performance certification. Visual inspection with
real original footage and different GPUs remains part of #409 certification.

Measured Linux observations (Oct 13, 2026; three source frames, two
coalesced alpha pages, 10 FPS, generated moving antialiased coverage):

| Canvas | Prepared alpha WebP | One R8 mask | Real prepare | Sharp 0→1→0 sample | Persistent libwebp steady RSS (after replay) | Persistent libwebp peak RSS | Node/test RSS after run |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1920×1080 | 3,290 bytes | 2.1 MB | 2.9 s | 2.7 s | ~55 MB | ~315 MB | ~1.17 GB |
| 3840×2160 | 10,380 bytes | 8.3 MB | 9.8 s | 12.1 s | ~177 MB | ~852 MB | ~3.14 GB |

Steady and peak RSS are **whole-process** measurements from an isolated
Python/libwebp probe; the last column covers Node/Vitest/Sharp, source buffers,
FFmpeg subprocesses, and test allocations. These are not decoder-specific
costs or runtime memory guarantees. Large transient allocations, especially
4K, are a design and profiling constraint for #409, not a numerical gate
invented by #408. Both 1080p/4K probes stabilized across repeated resets and
random seeks instead of growing once per replay. The generated source's
compressed alpha is highly compressible; more varied real-world footage
can have substantially larger encoded WebP sizes.

**Owned by #409, not #408:** publish the alpha sidecar in private prepared
media; implement persistent **production** native and Web/WASM decoder owners
with explicit budgets/disposal; automatically synchronize color + R8 mask
publication and retain the last complete pair; project GPU/current-frame mask
into Interactable hit tests; integrate authored Materials, focused Room preview,
background/foreground lifecycle, and packaged/Web platform parity. The
current GPU tracer deliberately pairs samples at test time and does **not**
pretend these production features exist. Keep the one-WebP transport decision
fixed.
