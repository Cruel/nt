# Transparent-video integration tracer (#408)

This began as the #408 validation path for the selected **opaque VP9/WebM
color + one lossless animated WebP alpha** representation. #409 now reuses
that transport in its production prepared-media package and native player;
the sole authorable video source remains an Asset referenced by an Animation.
This document records the initial proof as well as subsequent implementation
and remaining qualification limits.

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
- Production Node/Electron and standalone ScriptC exports use one shared
  native C++ alpha preparation service (`tooling_alpha_encoder.cpp`). FFmpeg
  extracts the 8-bit alpha, normalizes RGB to white, and uses **lossless
  `libwebp_anim`** to produce one optimized animated WebP over a pipe. This
  permits cropped-frame compression instead of always storing full-canvas
  VP8L pages. Native code validates the finished stream with the *same*
  bounded persistent `AnimatedWebpAlpha` reader used by native/Web playback;
  it verifies the color-timeline boundaries and replays the masks to ensure
  coverage is nonopaque before publishing a sidecar. The original color and
  alpha sampling logs must agree. Neither raw R8 nor BGRA intermediates are
  written to disk. The immutable source snapshot and final compressed output
  remain file-backed. Sharp is test-only.
- The test-only `WebpAlphaTraceSession` reference helper holds the compressed
  WebP plus at most one decoded CPU alpha mask at a time and exposes the same
  R8 bytes to CPU hit queries (`alpha > 0`). Sharp is used only as an
  independent test reference, never in the production export pipeline.
  The independent test-only `tests/media/webp_alpha_persistent_probe.py` uses libwebp's actual
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

Run the traced-media and conditional large-mask checks with a local FFmpeg
that has `libwebp` enabled (using the pinned `ffmpeg-r3` toolchain):

```sh
export NOVELTEA_FFMPEG="$HOME/dev/nt-tools/ffmpeg-build/stage/bin/ffmpeg"
pnpm -C editor exec vp test run src/renderer/test/animated-webp-alpha-encoder.test.ts
pnpm -C editor exec vp test run src/renderer/test/native-alpha-encoder.test.ts
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
alpha decoding of an opaque VP9 source. Tests requiring the new encoder
are skipped if FFmpeg lacks `libwebp`. No separate authored hit-mask sidecar
is generated.

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

## #409 production runtime playback

The editor/CLI export adapter prepares VP9 color and, when the original source
has nonopaque pixels, a lossless WebP alpha sidecar from the same immutable source
snapshot with exact matching color-sample timestamps. The private package
manifest carries `alphaWebp.path`; package assembly verifies its inventory and
colocation with `opaque.webm`. Opaque videos still have no sidecar. The focused
Room preview now admits the same alpha resource and binds it to the prepared
motion; the preview does not synthesize a separately authored mask.

The production player now includes a bounded persistent `AnimatedWebpAlpha`
reader using the already-linked bimg lossless VP8L decoder on native and Web.
It validates the RIFF animation, frame extents, duration and full color timeline;
retains one compressed source and one R8 composited CPU mask; and handles held
pages and rewind/replay. A single unchanged alpha mask uses a still WebP page,
which has no WebP ANIM duration metadata; the paired color motion supplies its
hold duration. `VideoAlphaSession` owns three independent R8 GPU textures per
active video occurrence, uploads only when a page changes, exposes the
last-presented CPU alpha for visual-alpha Hotspots, and releases its resources
at occurrence teardown. `PreparedVideoStream` lazily creates this session on
first demand, so an unused or superseded candidate snapshot does not allocate
textures. Completed color samples publish their matching alpha page first;
late color samples retain the previous displayed color/alpha pair. A missing
alpha texture suppresses rendering instead of silently treating the video as
opaque. The built-in video quad shader composites this pair without chroma key.

Production alpha preparation runs one native-owned FFmpeg subprocess.
`libwebp_anim` optimizes/reuses consecutive masks and emits one lossless
animated WebP through a pipe, without raw-alpha scratch files. The native
service checks its frame rectangles, compositing, exact 8-bit decoded coverage,
color-frame boundaries, and final duration using the engine-owned
`AnimatedWebpAlpha` decoder. `-enc_time_base 1:1000` prevents FFmpeg from
rounding source-range boundaries to an integer source-frame timebase. For an
end range cutting through the final source frame, the native service corrects
*only the final ANMF duration metadata* to the authoritative color endpoint;
no image pages or rectangles are manually assembled.

Node/Electron call the service through the static `__editor-native alpha-encode`
operation; standalone ScriptC uses its existing native FFI host. Neither path
requires QuickJS-specific binary streaming. The injected test-runner fallback
retains the prior manual VP8L page assembler for isolated tests. Compressed
output is capped at 128 MiB; FFmpeg stderr capture and subprocess lifetime are
bounded. Because `libwebp_anim` assembles internally, its working memory is
not bounded by the compressed-output cap: long-duration profiling remains a
release qualification requirement. Raw video is never sent through JSON.

On the same synthetic 36-frame/20 FPS sparse-motion fixtures as the earlier
comparison, the **production native operation** now produces 1,498 bytes at
854×480 and 1,842 bytes at 1920×1080, matching FFmpeg directly (previous
manual assembly: 2,160 / 4,624 bytes). On detailed-motion fixtures, the two
methods both produce 1,006,270 / 1,179,424 bytes. The native size-budget
regression in `native-alpha-encoder.test.ts` checks those sparse-motion limits
and matches FFmpeg's compressed frames. All benchmark outputs independently
pass exact-alpha and timeline decoding. The reproducible local benchmark is
`build/benchmark-alpha-webp.py`.

Engine2D Materials now retain their authored fragment output before the
renderer-owned compositor multiplies their premultiplied RGBA by the actual
WebP mask. The Material source compiler wraps the fragment entry point without
modifying the authored source or losing Metal's entry-point varyings; the
reserved sampler is on stage 15 and is hidden from author-facing reflection.
Opaque Materials receive a white mask. The built-in quad preset uses the
existing native `video_alpha` shader at stage 1 for transparent videos.
Missing masks are not replaced with opaque draws.

`scripts/certify-transparent-video-package-scenarios.mjs --native --web`
synthesizes a ProRes 4444 MOV with a changing alpha strip, exports it using
the Node CLI by default or standalone ScriptC with
`NOVELTEA_ALPHA_STANDALONE_CLI=1`, and verifies the single animated-WebP
sidecar and shared 2-second color timeline in the package, then launches
native and Web players. The Web
smoke instruments R8 GPU uploads and compares transparent/half/opaque strips
within rendered WebGL screenshots **with an authored Engine2D Material**. It
proves startup, source packaging, repeated alpha uploads, and actual
post-Material compositing. The native smoke exercises R8 GPU readback under
Xvfb/llvmpipe; the native packaged player exercises initial playback/shutdown.
Shaderc builds the wrapped Material for GLSL 330, WebGL2 ESSL 300 and Metal.
The native and Web decoder reuse identical animated-WebP logic.

The standalone ScriptC CLI uses the same canonical transparency preparation
without loading Sharp or Node streams. Its `scr:import-trap:0` error was
resolved by removing production Sharp imports; the rebuilt standalone CLI and
Node CLI each successfully export transparent MOV to native and Web packages
with the local FFmpeg override. The native service survives any future QuickJS
removal unchanged. Windows and macOS process-path qualification is still due.
The `ffmpeg-r3` toolchain includes the `libwebp_anim` encoder required by
production transparent-video preparation. The exact endpoint is corrected and
validated by the native alpha-encoding service. Developers can still select
an external FFmpeg executable with `NOVELTEA_FFMPEG`.
Real Mac/Windows/Android device execution, hardware GPU timings and
unbounded-duration memory profiling are additional release certification,
not claims made by the Linux/Web tests.

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
| 1920×1080 | 4,134 bytes | 2.1 MB | 3.0 s | 2.6 s | ~54 MB | ~286 MB | ~1.15 GB |
| 3840×2160 | 13,640 bytes | 8.3 MB | 10.1 s | 12.0 s | ~173 MB | ~930 MB | ~3.66 GB |

Steady and peak RSS are **whole-process** measurements from an isolated
Python/libwebp probe; the last column covers Node/Vitest/Sharp, source buffers,
FFmpeg subprocesses, and test allocations. These are not decoder-specific
costs or runtime memory guarantees. Large transient allocations, especially
4K, are a design and profiling constraint for #409, not a numerical gate
invented by #408. Both 1080p/4K probes stabilized across repeated resets and
random seeks instead of growing once per replay. The generated source's
compressed alpha is highly compressible; more varied real-world footage
can have substantially larger encoded WebP sizes.

**Qualification boundary:** Native/Web production playback, authored
Engine2D Material alpha, and actual package inventory are now covered by
automated tests; 1080p/4K generated-source export and bounded decoder replay
have also been exercised. Native GPU tests under Xvfb use llvmpipe, not the
end-user GPU. Mac/Windows/Android hardware and longer real-footage sessions
remain device-release qualification. Keep the one-WebP transport decision
fixed.
