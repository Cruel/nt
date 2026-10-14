# Animation Resource

## Purpose and current status

Animation is immutable reusable raster content, separate from source Assets and gameplay identities.
Phase 1 established one canonical image/Animation Visual contract across Room Environments,
Interactable presentation, and Character visual layers. Phase-2 opaque-video playback is now
implemented on native runtime, Web players, and focused Room preview. Interactables use current-frame
`visual-alpha` hit testing for image/sprite realization; dynamic video alpha remains future work.
Character semantic composition and choreography remain separate from reusable Animation content.

## Authoring and validation

Records live in the `animations` collection and segmented workspace `records/animations/` directory.
The authoritative shape is
[`authoring-animations.ts`](../../editor/src/shared/project-schema/authoring-animations.ts).
An Animation owns one stable logical canvas, a default motion, and Animation-local unique motion IDs.
Each motion is either `sprite-sequence` or `video`. Sprite motions contain one or more Image Asset
frames with explicit positive integer millisecond durations; a one-frame motion is valid. Video
motions reference one semantic Video Asset and may specify an optional `{ startMs, endMs }` source
range with a positive extent. Video motions may also select an authoring-only `frameSampling` policy:
absent or `source` preserves presentation timestamps, `target-fps` selects a positive rational
numerator/denominator (for example 30000/1001) using FFmpeg's timestamp-directed constant-rate
resampling, and `retain-percent` samples an integer 1–100% of frames while preserving the first/last
source samples and their original VFR timestamps. Frame-sampling policy is preparation input, not
compiled Animation or gameplay time. The default and any use-site selected motion must exist. Asset
references participate in the ordinary dependency graph, rename/delete safety, validation,
compilation, and resource closure. Localization remains at the Asset layer.
Empty manual Animations start with a `default` motion with no frames. They are saveable authoring
drafts with a warning, omitted from compiled resources, and rejected when selected as a Visual.
Adding an Image frame in the timeline makes the draft usable; partially empty multi-motion resources
remain validation errors.

Generic video Animation is visual-only. Embedded audio in a referenced video is ignored during
canonical preparation and produces a warning rather than becoming synchronized Animation audio.
Movie/cutscene A/V synchronization remains a separate future layer.

## Raster import

The Animations category context menu offers **Import Animation…** beside ordinary **Create Animation**.
Select a naturally filename-ordered image sequence (equal oriented dimensions), one GIF, or one APNG
(`.png` or `.apng`). Sequence frames receive explicit 100 ms durations, editable in the timeline.
GIF frame delays are retained; APNG rational delays are rounded cumulatively to integer milliseconds,
with a 1 ms minimum. A zero source delay uses the sequence/fallback duration. Source loop counts do
not become runtime policy. Other animated containers are not admitted by this workflow.

Main-process import coalesces disposal/blending and normalizes every sample into a full-canvas RGBA
PNG. Existing Sharp handles still images and composited GIF pages; the bounded APNG adapter rebuilds
PNG subframes and composites them without a new dependency. Limits live in
`editor/src/main/services/raster-import-limits.ts`; source input is limited to 128 MiB.
All generated frames and original bytes are staged by one workspace transaction. The existing
`asset.importFiles` command inserts Image Assets, preserved binary source Assets, and the Animation
atomically, using ordinary structural persistence and file trash/restore on Undo/Redo.

The optional record-level `import` field (see `authoring-records.ts`) stores ordered original names,
project-relative preserved source paths and hashes, import time, format, and fallback duration. These
paths/bytes plus the canonical editable frame data support provenance and rerunning import; there is
no automatic source watcher/reimport overwrite. Provenance is not Animation runtime data or playback
authority. Original source Assets are excluded from default dependency-pruned packages; generated
Image Assets use ordinary localization, focused staging, dependency safety, and package preparation.
The timeline shows provenance and allows manual image-frame insertion and logical canvas editing.

## Runtime and preview

Compilation emits a separate Animation resource table, not an Asset kind. Room Environments select
an image or Animation Visual; a null motion selection uses the resource default. Placement, opacity,
Material remains a use-site concern. Animation Visuals carry required nullable `playback`: null
uses the use site's default loop, rate 1, semantic start, and clock (Environment clock or gameplay).
Explicit policy selects once/loop, positive finite rate, gameplay/unscaled-presentation clock, and
nullable semantic `initialMarker`, and optional `loopRange: { start, end }` naming markers.
A range is valid only with loop repetition and strictly increasing resolved marker times. Without a
range, looping wraps the whole motion. With a range, playback traverses any initial intro before the
exclusive range endpoint once, then wraps to its start. Once holds the final sample.
Motion-local `markers` are required arrays of unique non-reserved IDs and absolute integer `timeMs`
within the motion; `start` and `end` are implicit markers. Markers never invoke gameplay.

`StructuredPrefetch` expands sprite motions into ordinary Image Asset dependencies. Mandatory
publication pins selected sprite frames and the Engine2D Material before realization.
`AssetWorldPresentationResourceResolver` resolves those leases, and `WorldPresentationBackend`
samples the texture through the existing raster quad/Engine2D Material path. Source frame dimensions
do not change occurrence placement.

For a video motion, runtime-artifact preparation invokes the pinned private FFmpeg tool while keeping
the creator Video Asset intact. Preparation normalizes the selected source/range to the Animation
logical canvas and emits a muted VP9/WebM stream with private prepared-media metadata. Native and
Web players consume that encoded stream. Preparation and package export no longer generate or ship
private PNG frames. The private
manifest's `browserVideo` field names the packaged WebM and canvas dimensions for both targets,
never an authored Video/Animation field. Package paths and metadata shape are deliberately private;
Animation authoring/compiled semantics name the Video Asset and range, not a codec or generated file.
Preparation probes decoded source presentation timestamps before encoding; its output uses
explicitly monotonic timestamp records and does not force 30 FPS. Prepared frame durations close
exactly on the authored source-range endpoint when one is given; unranged video obtains its semantic
endpoint from prepared media. Source and retained frames keep their VFR presentation spacing;
Target FPS may duplicate or discard samples to occupy the chosen rational clock. Embedded audio is
stripped and warned about; HDR PQ/HLG BT.2020 source undergoes linear-light
float RGB Hable tone mapping before BT.709 SDR conversion. High-bit-depth/HDR sources
warn about reduced precision when quantized to 8-bit BT.709 prepared output. An authoring-time confirmation accompanies Target FPS selections and edits because
upsampling may increase decode and GPU work. The player does not ship or
invoke FFmpeg.

At package load the private metadata is strictly validated against the semantic Animation table and
archive inventory. `StructuredPrefetch` requests only the video sample selected by the initial marker,
so mandatory publication establishes one drawable seed plus the Material. `WorldVideoStream` is the
time-directed media boundary; native occurrences maintain persistent VP9 decoder sessions and
convert decoded YUV planes to an RGBA GPU surface. Each occurrence holds a current decoded frame
and at most one pending request, skips intervening frames when catching up, and lets slow work finish
rather than continually canceling it as time advances. Pending samples retain the last ready image;
terminal resource failures produce a diagnostic once and do not retry every render frame. A loop returning to its currently held sample does not cancel unfinished preparation, preventing
slow browser seeks from starving on every wrap. Retiring or
hiding an occurrence cancels pending decode interest; hidden epochs still advance and reappearance
samples the requested time. A retained transition predecessor remains a live presentation consumer.
Logical bounds remain the Animation canvas and rendering continues through the existing
quad/Engine2D Material path.
Sampling is driven only by NovelTea gameplay or unscaled-presentation time; no platform media clock
enters semantic playback. Existing occurrence epochs therefore provide default/loop playback,
hidden-time catch-up, compatible-publication phase retention, reset/load/reconstruction restart, and
independent phase for shared Animation occurrences.

On Web, `assets::prepared_video_texture_request` uses the same semantic sample/lease contract
through a paused, persistent `HTMLVideoElement` for each active occurrence. The browser decodes and
seeks the packaged WebM, then `web/video_texture.js` uploads its media element directly to an
imported bgfx/WebGL RGBA texture using `texSubImage2D(video)`, without canvas readback or a
browser playback clock. Decoder and Blob URL survive between directed samples; there are at most
two active seeks and a bounded queue. The initial seed releases its temporary browser decoder and
retains the shared encoded source for subsequent occurrence sessions. Samples pin the occurrence's
first allocation; two presentation surfaces prevent a discarded seek from overwriting the image
currently held by the World. One held sample does not trigger GPU uploads on render ticks.

Texture creation/upload and retirement occur on the WebGL renderer owner; bgfx owns imported
texture handles but not the underlying GL names. Names are deleted only after deferred bgfx
frame processing; renderer shutdown retires surviving sessions before destroying its GL context.
Source, browser Blob/decoder estimates, temporary decode storage, and GPU surfaces go through
normal asset residency. Browser callbacks publish atomic task readiness; cancellation detaches
callbacks before pending WASM task storage can be released. Corrupt/unsupported codecs, dimensions,
GPU imports, uploads, and timeouts fail through typed resource diagnostics instead of a CPU fallback.
A first/finite endpoint sample still gates readiness. Focused Room previews stage the same encoded
stream under `prepared-media` authority, with the same canvas dimensions.

For native decoder selection, GPU conversion, residency, and platform limits, see
[Native opaque Animation video](../assets/NATIVE_VIDEO.md).

See [Animation and Tweening](../rendering/ANIMATION_AND_TWEENING.md#raster-animation-realization)
for epoch ownership and reconstruction, and
[preview communication](../editor/preview/ENGINE_PREVIEW_COMMUNICATION.md#editor-managed-authoring-previews)
for focused publication (the focused-document section describes the owning transport).

## Editor behavior and known gaps

The source-timed VP9 preparation path is in use for both current runtime targets. Native decoding
supports VP9, and Web's certified baseline is VP9; neither currently has a production AV1 decoder,
so export selects only VP9 rather than packaging an unusable alternative. The editor probes the
admitted source's presentation timestamps, including VFR gaps, and confirms Target FPS only when
nearest-timestamp mapping duplicates samples. Range clipping retains the sample covering the
range start and shifts subsequent timestamps to that boundary inside FFmpeg's filtergraph;
packaged WebM decoding is re-checked for authoritative timestamps and a zero-origin first frame.
Retain % can keep only the first frame for very short clips, holding it to the full source endpoint.
The pinned FFmpeg r2 build provides `zscale` and `tonemap` for tagged BT.2020
PQ/HLG sources. Incomplete or unsupported HDR color metadata is rejected rather
than silently retagged as BT.709; ordinary tagged SDR still uses FFmpeg's
colorspace conversion. The same canonical output serves native, Web, and focused preview.

Animation records open a specialized timeline editor with motion selection, absolute-time markers,
frame-duration editing, scrub/play/pause/restart, and sprite frame stepping. Video motions use their
semantic source/range on the shared timeline while frame stepping remains sprite-only in the editor.
The labeled source preview is muted and seeks from the shared playhead, including range offset,
markers, loop bounds, scrub, and restart; it does not expose independent browser playback controls.
Unranged video obtains its timeline duration from loaded source metadata.
Reserved start/end
markers are shown but cannot be edited. Preview-only loop ranges use the same canonical sampling
rules as runtime through `editor/src/shared/animation-timeline.ts`. This lightweight source-image
preview is explicitly labeled, not certified runtime rendering. Interactable Visual editing also
exposes durable playback policy, initial marker, rate/clock, and marker-bounded loop selection;
loop policy is never stored on the reusable Animation resource. Project edits use the normal command
bus, undo/redo, and manual-save record unit. Tab restoration keeps authoring view position but never
a running playback anchor. Focused Room preview stages the referenced Environment, Interactable, and
Character-layer Animations and their resources through production focused resource preparation, not a
browser animation interpreter. Video motions invoke the same canonical opaque-video preparation job
and stage the encoded WebM stream as a bounded focused-preview resource before the native presenter
receives it. The focused native manifest preserves `prepared-media` authority rather than aliasing
the private stream to authored Image Assets. Only selected seed samples join mandatory texture readiness;
subsequent samples use the same `WorldVideoStream` as runtime. Room Environments author and compile only nullable `visual`; the temporary image
`asset` expand-contract field is retired and rejected rather than aliased.

Interactable Definition and exact Instance targets admit owner-scoped `DesiredMotionSelection`,
through the Presentation command gateway and Lua `set_motion_selection` / `clear_motion_selection`.
An exact Instance selection precedes the Definition selection; within a target, active owner scope
uses the same precedence as Material selection. Invalid targets, motions, policies, and markers fail
without mutating prior intent. Owner expiry removes its records. Character Profile/Pose/Expression/
Appearance/idle state remains unchanged; no universal motion state is added to gameplay instances.

Save/checkpoint records contain only admitted owner, target, motion, and policy. Immutable snapshots
carry the selected Animation Visual/policy, never phase, frame, pause/seek anchors, or decoder state.
Compatible occurrences retain backend epochs across unrelated and prepared publications. Motion or
policy replacement, Room re-entry, reset/load, and reconstruction start at semantic start/marker.

Explicit reusable playback policy is admitted on ordinary Environment, Interactable, and resolved
Character-layer Visuals, not Character clip-frame Visual overrides: those retain choreography timing
and require null playback until an explicit coordination contract is implemented.

Finite named motion is coordinated through the ordinary Presentation Operation lifecycle. `PlayMotion`
temporarily replaces one exact Environment, Interactable-placement, or Character-layer occurrence
with a named motion and leaves the underlying desired Visual/motion/policy untouched.
`TransitionMotion` requires its durable target motion to already be present in the exact target
snapshot revision, then realizes an operation-local transition motion over that committed target.
Finite motion is once-only, uses gameplay or unscaled-presentation time, admits a positive rate and
optional initial marker, and derives its deterministic duration from the selected motion endpoint.
Loop ranges are not finite-operation semantics.

The runtime command gateway derives finite video duration from package-owned prepared-media
metadata (not the empty sprite frame list), including on reset and save-load reconstruction.
The coordinator remains authoritative for replacement, skip/cancel, checkpoint barriers, and
terminal acknowledgement. The world backend owns only prepared temporary samples and progress.
Required finite-motion initial samples join the existing mandatory publication gate before delivery,
so a causal operation cannot begin with an unprepared motion. Native video sessions decode later
samples on demand rather than preparing every frame at startup. The world backend follows the operation's canonical
once-only timeline; it waits for the required video sample to be actually realized at the authored
endpoint before acknowledging completion, and reports media failure rather than treating decoder EOF
or a stale prior frame as success. While a finite motion owns an occurrence, transient
pause/restart/seek controls are rejected rather than mutating the underlying playback anchor.

`WorldPresentationBackend::control_motion` targets one live `WorldVisualOccurrence` with typed
pause, resume, restart, seek-time, or seek-frame commands; `motion_position` exposes motion time
and frame index/count when the concrete representation supports frame addressing. The current
prepared-video representation supports indexed frame seek and introspection; future opaque
video representations may expose only time-based seeking. Deferred video endpoints are accepted
by semantic motion selection, snapshot projection, and save-state validation so unranged video can
select known markers and `end`; the backend checks actual timing when media is prepared.
Static Visuals fail with `Unsupported`, absent occurrences with
`MissingOccurrence`, and non-finite/out-of-bounds addressing with `InvalidPosition`, without
mutating prior realization. Restart uses the authored initial marker and preserves pause status.
Compatible publication/prepared swaps retain control anchors; selection replacement, disposal,
reset/load/reconstruction discard them. These are host/backend controls, not new durable Lua
commands. Finite named-motion operations are separate coordinator-owned requests and transient
controls cannot override them.

Custom Interactable Hotspots may own motion-local normalized rectangle tracks without putting
interaction data on the reusable Animation resource. Runtime samples those tracks from the same
backend-local motion phase used for the realized raster frame: missing tracks use static bounds,
`hold` and `linear` are the initial interpolation modes, and inactive samples do not hit. Hotspot
Focus uses the shared authoring timeline helpers for play/pause/scrub/frame-step/marker inspection and
can author keys for any motion in the selected Animation.

Native video Animation uses persistent per-occurrence VP9 decoding with GPU YUV conversion,
including finite named-motion operation parity and representation-derived frame addressing. Web
realizes the same prepared encoded stream through its browser media adapter. Transparent video
uses one additional lossless animated WebP sidecar from the production media preparer, with
on-demand decoding, a retained CPU R8 mask for Interactable `visual-alpha` Hotspots, and an
R8 GPU texture composited **after** the authored Engine2D fragment shader. Color and alpha
publish together; delayed decoding retains the previous displayed pair and hit coverage.
Opaque video omits the WebP and does not provide dynamic alpha coverage. True codec-level
frame introspection, movies, and animated Inventory icons remain follow-up work.
The Phase 1 world-presentation sprite-to-Visual cutover remains complete.

## Verification

Feature Lab's **World Composition → Reusable Animation occurrences** check shows two Environment
occurrences sharing `guide-expression-loop`, using gameplay and unscaled clocks. Its `still` motion
is a one-frame source example. The catalog carries the manual procedure; added coverage is not a claim
that every interactive check has been performed.

Feature Lab's Hotspots & Cursors contextual Inventory exposes once/rate/clock/initial-marker
selection and clearing for the alpha board (`desired-motion`), including an authored marker-bounded
range that excludes the first/last half-frame segments. This is a manual procedure, not a
claim of completed save/load or player interaction certification.

- Editor schema/compiler/dependency/Room-preview tests cover authoring and focused staging.
- `raster-animation-import.test.ts` covers sequence ordering, GIF timing, APNG poster/blend/disposal,
  invalid-input atomicity, source preservation, imported/manual compiled equivalence, focused closure,
  localized frames, and dependency-pruned package preparation. Editor component/command tests cover
  import entry points, empty manual creation, frame insertion, and atomic Undo. Existing Feature Lab
  sprite-motion checks cover the normalized runtime result; import itself is editor-only.
- Native preview protocol tests reject malformed resources and missing motion selections.
- `tests/assets/structured_prefetch_tests.cpp` exercises selected-frame mandatory publication,
  production lease resolution, and raster texture sampling.
- `tests/host/layout_realizer_tests.cpp` exercises focused publication, republish phase retention,
  and missing-manifest rejection through the real resolver/backend.
- `tests/render/world_presentation_tests.cpp` covers independent occurrences, retained incompatible
  revisions, prepared publication, clocks, and reconstruction.
- `tests/render/world_transition_tests.cpp` covers finite play/transition realization, endpoint
  completion, desired-state restoration, backend failure, reset, and transient-control exclusion.
- `tests/core/presentation_coordinator_tests.cpp` covers finite-motion target replacement,
  placement identity, skip/cancel, barrier classification, and clock/policy validation.
- `tests/assets/structured_prefetch_tests.cpp` covers exact-target-revision mandatory preparation,
  missing motion rejection, and asynchronous readiness before finite delivery. Video sampling tests
  additionally cover seed-only readiness, time-directed decode, hidden catch-up/cancellation,
  reconstruction, terminal frame failure without request churn, marker-bounded loop and frame-seek
  controls, all-frame causal preparation and failure, and native finite play/transition endpoint
  realization. Render-backend tests exercise delayed video endpoint acknowledgement and failure.
- `noveltea_focused_video_sampling` explicitly exercises focused prepared-media publication and
  demand sampling through the native presenter. Widget/TypeScript contract tests cover the matching
  private authority and reject the replaced authored-Image alias.
- `tests/core/compiled_package_tests.cpp` covers strict private prepared-media decoding, rejection of
  unknown representation metadata, failure when a semantic video motion lacks prepared media, and
  successful assembly when the prepared inventory matches.
- `tests/web/prepared_video_texture_tests.cpp` runs under WebAssembly to protect focused encoded-video
  transport, fractional interval sampling, and distinct video sample cache identities.
- `tests/web/video_texture_tests.mjs` exercises real browser directed color decoding, independent
  samples, bounded queue cancellation, corrupt media, and dimension failure. Its 96×64, two-second
  VP9 fixture is generated by the pinned preparer from Feature Lab's `opaque-color-loop` range.
  `scripts/web-player-package-smoke.mjs --video --package <prepared-package>` additionally proves
  red/green/blue output reaches the ordinary raster Visual panel through the actual Web player.
  With `--start-via-title`, the optimized player also exercises its actual title-screen start.
- `scripts/certify-video-package-scenarios.mjs --web --native` exports ten disposable Feature Lab
  variants through the standalone CLI and checks canonical VP9, positive sample holds, exact source
  endpoints, rational FPS, Retain %, source VFR, source revisions, locale-independent video bytes,
  and 10-bit PQ/HLG tone mapping. Web runs screenshot-based raster verification; Linux native runs
  the actual player with a persistent software VP9 session. A repeated export checks deterministic
  media bytes, and corrupt input must fail with a typed diagnostic and no partial package.
  These are platform-level behavioral checks, not a substitute for UI interaction tests.
- `tests/tooling/playback_expectation_tests.cpp` covers prepared-media handoff during normal
  package export certification and rejection of absent private media files.
- Runtime-artifact preparation tests cover deterministic private video lowering and audio-ignore
  diagnostics, while focused Room preview tests cover canonical preparation/staging of the encoded
  representation. Native decoder and GPU smoke tests cover held-frame reuse and decoder lifetimes.

The earlier raster-tracer acceptance included Linux CTest, Linux/Web C++ policy checks, Web
structural smoke, and a 300-frame native World Composition rendering capture using a disposable
direct-start Feature Lab package. Issue #419 replaces its native PNG-frame decoding with the
persistent VP9/WebM path and adds separate native-decoder and GPU smoke coverage described in
[Native opaque Animation video](../assets/NATIVE_VIDEO.md). Platform-specific hardware playback
and manual focused Room preview interaction still require verification; acceptance of the earlier
tracer does not establish those newer guarantees.
