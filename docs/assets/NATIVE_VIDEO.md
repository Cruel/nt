# Native opaque Animation video

Native players sample the prepared VP9/WebM representation through libwebm and persistent
per-occurrence decoder sessions. Preparation emits a single encoded WebM per motion, without
intermediate PNG frames or a raster decoding fallback.
The existing private `PreparedBrowserVideo` field names the same encoded representation for both
native players and browser preview; it is not a second authoring contract. Unsupported or missing
encoded media fails through typed asset/presentation diagnostics.

## Boundaries and ownership

- `media/native_video_decoder.*` indexes a shared immutable WebM byte source and advances one
  packet per decode step. NovelTea's gameplay/unscaled clocks select the semantic sample; a backend
  clock, decoder EOF, or a decoder's arrival time never advances gameplay.
- `native_video_hardware.*` selects a usable platform decoder. Linux uses dynamically loaded VA-API
  on DRM render nodes; macOS uses hardware-required VideoToolbox; Windows uses hardware MFTs with
  D3D11 NV12 staging; Android selects hardware MediaCodec entries and accepts supported mapped YUV
  layouts. Native interfaces are private and use platform status/error returns, not C++ exceptions
  or compiler RTTI. Backend names are logged at admission and exposed by the stream. Software
  fallback reasons are retained with decoder/session diagnostics. The shared Devtools Snapshot and
  native ImGui Render section separate GPU rendering acceleration, hardware-decoder availability,
  and selected per-occurrence decoding; see `docs/runtime/DEVELOPER_DEBUGGING.md`.
- If selection or first-sample realization cannot provide usable YUV output, libvpx decodes the
  **same prepared VP9 stream**. Once an occurrence publishes a decoded sample, later backend errors
  are terminal rather than an invisible backend/content substitution. Linux's VP9 header adapter
  conservatively declines unsupported segmentation/profile features before selecting hardware.
- `render/bgfx/native_video_texture.*` uses normal typed requests/residency for immutable source
  bytes, packet indexes, shader resources, and bounded session allocations. Source dependency
  interest follows the parent request's Startup/Demand/Prefetch classification, including promotion.
  A source lease is acquired before decoding; source waiting and decoder allocation do not bypass
  temporary-reservation arbitration.
- Initial samples are shared immutable GPU seeds. Their temporary decoders are released after
  realization. Each active occurrence owns its own persistent decoder, three YUV textures, and two
  RGBA render surfaces. The first admitted occurrence allocation carries the cost; later sample
  aliases retain its allocation lease so neither source nor surfaces can outlive accounting.
  Occurrence samples are lease-bound, not reusable cache residents: their last pin release retires
  the alias immediately, and request/progress servicing prunes terminal sample cache entries.
  Unique request revisions therefore do not accumulate history across loops. Immutable source and
  initial-seed assets retain normal cache residency.
- Hardware output is mapped/copied as YUV, not converted to CPU RGBA. bgfx uploads the planes and
  converts to opaque RGBA with `video_yuv`; ordinary quad/Material rendering consumes the result.
  This is not a zero-copy hardware-surface import. The previously complete sample remains visible
  until a replacement sample is published. A completed late forward sample is published while the
  next request catches up to semantic time; loop/rewind invalidates pending results from the prior
  timeline. Uploads always avoid the currently presented surface, including when a completed
  result is discarded. Readiness still requires the exact semantic sample, not merely a late one.
- A held semantic sample reuses its GPU texture. A repeated request for the session's already
  converted packet also reuses the output, without pixel comparison, hashing, or duplicate-frame
  provenance. GPU plane updates are serialized per session and bgfx frame. Native conversion views
  precede presentation views; native bgfx builds have 512 views, while Web retains its existing
  presentation-view layout.
- Hidden occurrences cancel pending work without changing their playback epoch. Resuming samples
  the current NovelTea time. Removal, source invalidation, cancellation, and residency eviction
  destroy decoder/GPU resources through their owning worker/owner boundaries. Reusing a stream
  after its asset source generation expires is a typed failure.

## Web browser GPU realization

Web players reuse the prepared opaque VP9/WebM and the `WorldVideoStream` timing contract,
but use independent, persistent paused browser video elements rather than native libvpx or
platform YUV decoders. Browser-native decoding feeds a WebGL RGBA texture directly with
`texSubImage2D(video)`; no canvas frame extraction, full-video preload, or PNG fallback occurs.
Each active occurrence retains its media element, Blob URL, and two bgfx-imported presentation
textures. The immutable initial seed retains encoded source bytes but disposes its temporary
decoder after publication. Subsequent samples are lease-bound aliases of the occurrence's first
resident allocation. At most two directed browser seeks run concurrently, with bounded queued
interest; cancellation drops callbacks before its WASM completion storage is released.

All WebGL operations, imports and retirement run on the renderer owner. bgfx destroys its handle
but does not delete external GL names, so deletion follows deferred bgfx frame processing;
shutdown retires remaining sessions before the context is destroyed. Web residency reserves
encoded-source/Blob memory, decoder-frame estimates, and GPU surfaces; an unchanged semantic
sample causes no GPU update. Invalid media, unsupported codec/extent/GPU path, upload errors,
and seek timeouts report typed failures rather than silently falling back to CPU rasterization.
Browser codec and seek latency depend on the browser/device and are not real-time guarantees.

## Readiness and limits

Publication and finite named-motion startup require the correct initial/marker sample and Material,
not every semantic frame. Loop/restart/seek can reuse the immutable initial seed immediately.
Finite completion waits for the actual required endpoint sample; typed sample failure fails the
operation. Browser preview retains browser decoding and the same semantic timing contract.

The current native adapter accepts a single visual VP9 track, no audio, increasing timestamps,
visible unlaced packets, a keyframe at time zero, and 8-bit profile-0 I420/NV12 output. Its safety
limits are 128 MiB encoded source, 32 MiB packet, 8192 pixels per axis, 65,536 packets, and 250,000
libwebm reader operations. These are resource-admission limits, not historical-format compatibility.
libvpx has one decoding thread and twelve bounded external reference buffers. CPU/GPU estimates
include codec/reference storage and hardware metadata; actual completed costs distinguish software,
hardware, and immutable seed allocations. Oversized preparations still follow the repository's
exclusive temporary-memory arbitration; speculative interest cannot masquerade as current Demand.

## Verification and manual reference

- `noveltea_asset_tests '[native-decoder]'`: real lossless VP9, held sampling, independent decoder
  positions, keyframe seeks, malformed/truncated source, dimension mismatch, corrupt final packet.
- `noveltea_asset_tests '[video]'`: startup/marker/Material closure, time/rate/loop/seek semantics,
  hidden suspension, finite play/transition endpoints, pending holds, terminal operation failure.
- `tests/web/video_texture_tests.mjs --request-build-dir build/web-debug`: directed WebGL
  red/green/blue samples, independent persistent browser decoders, repeated holds, cancellation,
  bounded queue, typed failures, and the actual threaded WASM request boundary. GPU-backend selection
  can be forced with `NOVELTEA_WEB_SMOKE_ANGLE_BACKEND=gl` on the WSL GPU host.
- `scripts/web-player-package-smoke.mjs --build-dir build/web-release --video
  --start-via-title --package /path/to/video.ntpkg`: the optimized Web player reaches all three
  colors through its ordinary raster Visual. The unoptimized debug direct-start tracer can skip the
  authored half-second blue interval when browser seeks take roughly as long; its screenshot sequence
  is not a valid three-color throughput certification. The release raster and directed WebGL checks
  cover these separate boundaries without altering gameplay timing.
- `noveltea_native_video_texture_smoke` (CTest uses `xvfb-run` when available): real native YUV GPU
  conversion and red/blue readback, independent occurrences, no held uploads, bounded reused
  surfaces, late-sample progress under an advancing playhead, held-pixel readback across discarded
  seeks, canceled hidden work, source sharing, prefetch-budget promotion, and source expiry.
- Asset request/residency tests cover lease-bound sample destruction, retained pins, cancellation,
  and bounded cache metadata across repeated revisions.
- Feature Lab **already covers** authorable video behavior in `world-composition`:
  `opaque-color-loop`, `video-gameplay`, and `video-unscaled`. Decoder allocation, hardware choice,
  and held-upload invariants are automation/diagnostic checks, not new authored semantics.

Hardware acceleration is optional: absence of a supported GPU/driver must select libvpx and cannot
cause CI failures by itself. Device-specific hardware paths require separate manual certification.
Local Linux verification exercised libvpx and OpenGL. This host exposes no DRM render node; usable
VA-API hardware was not exercised. macOS/Windows SDK builders and an Android SDK/device were not
available locally, so their adapter compilation and hardware playback require platform CI/device
verification. Do not interpret those implementation paths as locally verified hardware support.
See `docs/architecture/CXX_RUNTIME_DEPENDENCY_POLICY.md` for dependency admission and licensing.
