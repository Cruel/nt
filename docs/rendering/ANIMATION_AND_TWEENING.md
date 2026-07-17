# Animation and Tweening

## Purpose

NovelTea retains a reusable tween facility for presentation realization. Fades, actor transforms,
Layout effects, ActiveText effects, material parameters, and similar visual behavior should share
interpolation and easing infrastructure rather than each implementing private timing math.

Tweening is not a second presentation lifecycle system. `PresentationCoordinator` remains the sole
owner of semantic finite-operation identity, target replacement, checkpoint barriers, cancellation,
and terminal acknowledgement. Runtime/session state remains the sole owner of durable gameplay truth.

## Placement

The public interpolation primitive is `noveltea::animation::TweenService` in
`engine/include/noveltea/animation/tween_service.hpp`. It is an engine animation-layer utility, not a
core-domain service and not an `Engine`-global broker.

Each realization backend owns the service instances it needs. `WorldTransitionBackend` currently owns
one instance for the gameplay clock and one for the unscaled-presentation clock. This arrangement
means gameplay-paused animation freezes without pausing menu/UI animation, while no string owner or
global channel registry is required.

Future realization backends may own their own instances when their lifetime and clock policy differ:

- ActiveText finite reveal/fade realization may use a service owned by its playback/render backend;
- actor-local idle, emphasis, shake, tint, scale, or material effects may use tracks owned by the world
  or actor realization backend;
- mounted Layout entrance/exit effects may use tracks owned by Layout realization;
- procedural glyph waves and continuously evaluated shader effects may reuse easing/sample helpers
  but should not allocate one coordinator operation per glyph or frame;
- audio ramps may continue using the audio backend's native ramping unless a shared scalar track gives
  a concrete benefit.

Do not create one application-wide tween service. Backend-local ownership keeps reset, device rebuild,
clock selection, and resource lifetime aligned with the realization that consumes the values.

## Service contract

`TweenService` exposes opaque `TweenHandle` values and retains scalar samples internally. A caller
starts a typed `ScalarTweenSpec`, advances the owning service with an explicit duration, samples the
current value, and releases or cancels the handle. The service validates finite endpoints and
non-negative duration.

The boundary deliberately excludes:

- references or pointers to caller-owned mutable values;
- string owner IDs or string channels;
- public completion callbacks;
- gameplay commands, Flow continuation, checkpoint mutation, or presentation acknowledgement;
- serialization of handles, elapsed time, Twink objects, or interpolation samples.

A backend polls `ScalarTweenSample::completed` and then emits its own typed acknowledgement through the
coordinator-owned operation contract. Reset/load/project replacement cancels backend tracks and
reconstructs realization from current desired state.

## Twink integration

Twink is a mandatory private dependency of the engine animation layer. NovelTea maps its own
`TweenEasing` enum to Twink equations, so Twink types do not leak into public engine APIs. Twink owns
the low-level equation evaluation; `TweenService` owns stable track storage, typed validation,
microsecond clock adaptation, handle lookup, and safe cancellation/retirement.

NovelTea source-builds the pinned Twink commit so the dependency receives the no-exceptions/no-RTTI
compiler policy. Local Twink development can use CMake's standard
`FETCHCONTENT_SOURCE_DIR_TWINK=/path/to/twink` override without adding a second dependency mode.

The current Twink API is sufficient for this boundary. NovelTea uses Twink's manager auto-removal and
an internal completion callback; no caller-supplied callback crosses the service boundary.

Before NovelTea depends on advanced timelines, high-volume glyph tracks, or arbitrary per-track
removal, the preferred Twink improvements are:

1. add a manager-owned creation API that returns an opaque handle instead of a heap-owned reference;
2. add explicit manager removal/retirement for one tween;
3. expose completion/status through a stable handle after auto-removal;
4. consider a `double` or chrono-based update overload for long-running precision.

These are API/lifetime improvements, not blockers for the current backend-local scalar service.

## Current use

`WorldTransitionBackend` uses linear `0..1` tracks for complete world transitions and targeted
background, actor, and Layout operations. Rendering maps the sampled scalar to opacity, rectangle
interpolation, and transition composite progress. The backend advances each track from the operation's
declared gameplay or unscaled-presentation clock and reports completion through the existing typed
presentation acknowledgement path.

## Persistence and diagnostics

Tween state is disposable realization. Saves and checkpoints contain committed desired targets and
stable logical state, never tween handles or Twink internals. Invalid tween specifications return
`animation.tween_spec_invalid`; a realization backend that loses an expected track reports a
backend-domain diagnostic and terminates the affected coordinated operation rather than silently
continuing.
