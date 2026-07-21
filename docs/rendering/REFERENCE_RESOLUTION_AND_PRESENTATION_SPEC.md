# Reference Resolution and Presentation Specification

Status: Normative

Date: 2026-07-21

## Purpose

This specification defines NovelTea's authored coordinate system, host/output presentation model,
world and UI raster domains, RmlUi layout and media environments, input projection, raster snapping,
transition composition, postprocess scopes, and capture bounds.

The contracts in this document are the implementation authority for the reference-resolution and
native-UI work. Later implementation phases may choose different concrete type or function names,
but they must preserve the domain separation and formulas defined here.

## Normative language

The words **must**, **must not**, **required**, **shall**, and **shall not** are normative. **May**
describes an allowed implementation choice. Examples are illustrative unless explicitly declared as
a required value.

## Coordinate and raster domains

NovelTea has the following distinct domains. A value in one domain must not be passed as another
without an explicit named projection.

### Project reference frame

The project reference frame is the sole authored geometric display authority.

- Every project has exactly one canonical reference resolution.
- The default reference resolution is `1920x1080`.
- Reference width and height are positive integers within renderer and platform limits.
- One author-facing RML/RCSS `px` equals one reference-frame pixel at 100% player UI scale.
- World coordinates and screen-UI coordinates use the same reference dimensions even when they are
  rasterized at different resolutions.
- Aspect ratio is the normalized greatest-common-divisor reduction of reference width and height.
- Orientation is `landscape` when reference width is greater than or equal to reference height and
  `portrait` otherwise.
- Aspect ratio and orientation are derived values and are not independently editable project
  settings.
- Changing the reference resolution redefines the authored coordinate system. The initial operation
  must not heuristically rewrite RML, RCSS, Lua, world positions, offsets, bounds, or font sizes.

The normative authoring shape is:

```ts
interface ProjectDisplaySettings {
  referenceResolution: {
    width: number;
    height: number;
  };
  worldRasterPolicy: 'capped' | 'native';
  barColor: string;
}

interface ProjectAccessibilityScalePolicy {
  enabled: boolean;
  minimum: number;
  maximum: number;
}

interface ProjectAccessibilitySettings {
  uiScale: ProjectAccessibilityScalePolicy;
  textScale: ProjectAccessibilityScalePolicy;
}
```

Required defaults are:

```ts
display: {
  referenceResolution: { width: 1920, height: 1080 },
  worldRasterPolicy: 'capped',
  barColor: '#000000',
}
accessibility: {
  uiScale: { enabled: true, minimum: 1.0, maximum: 2.0 },
  textScale: { enabled: true, minimum: 1.0, maximum: 2.0 },
}
```

The world raster policy is closed to `capped | native`. Bar colors remain six-digit RGB authoring
values. Accessibility ranges must be finite and positive. When enabled,
`minimum <= 1.0 <= maximum`. A disabled policy has effective runtime value `1.0` without deleting its
configured range. Loaded runtime values are clamped to the active project range.

### Host surface

The host surface describes the output supplied by SDL, the browser, Electron, or another platform.
It contains two different sizes:

- **host logical size**: the platform's window or canvas size in host logical units;
- **host framebuffer size**: the actual drawable backing-buffer size in pixels.

The host logical-to-framebuffer scale is derived independently per axis:

```text
host_logical_to_framebuffer_scale_x = host_framebuffer_width  / host_logical_width
host_logical_to_framebuffer_scale_y = host_framebuffer_height / host_logical_height
```

This scale describes only the host surface conversion. It is not the project reference scale, world
raster scale, RmlUi layout scale, RmlUi media resolution, text scale, or a generic game DPI value.

Operating-system desktop scale and browser device-pixel ratio contribute only to the host
framebuffer dimensions supplied by the platform. They must not independently change authored game
composition.

### Fitted game viewport

The game viewport is the project-aspect rectangle centered and aspect-fitted inside the complete host
surface. Presentation bars occupy all host output outside it.

- The project aspect remains locked at runtime.
- Fitting uses the aspect derived from the reference resolution.
- The viewport has both a host-logical rectangle and a host-framebuffer rectangle.
- Viewport rectangles use half-open bounds: `[left, right)` and `[top, bottom)`.
- Integer contain fitting floors the constrained dimension.
- Centering floors the leading margin. When spare pixels are odd, the extra pixel belongs to the
  trailing bar: right for horizontal bars or bottom for vertical bars.
- The framebuffer viewport must be derived from fitted logical edges, not by independently rounding
  an origin and size that can drift from the opposite edge.
- Presentation bars are outside game input, world rendering, runtime UI rendering, transition
  surfaces, and game-viewport postprocessing.

The viewport framebuffer size is the native game-output size for the frame.

### Reference projection

Reference-space composition is independent from output size. A host resize changes presentation and
rasterization, not authored positions, widths, wrapping, or relative composition, except where an
authored media query or player accessibility scale intentionally changes layout.

For a point inside the fitted host-logical viewport:

```text
normalized_x = (host_x - viewport_logical_left) / viewport_logical_width
normalized_y = (host_y - viewport_logical_top)  / viewport_logical_height

reference_x = normalized_x * reference_width
reference_y = normalized_y * reference_height
```

Input projection preserves fractions. A point outside the half-open fitted viewport is rejected.

## World raster contract

World raster policy is project-wide in the initial implementation. It applies to
`WorldBackground` and `WorldContent`.

Given fitted game framebuffer size `V` and reference size `R`:

```text
native:
    world_raster_size = V

capped:
    if V.width <= R.width and V.height <= R.height:
        world_raster_size = V
    else:
        world_raster_size = R
```

The aspect-fit stage already constrains `V` to the project aspect. Host logical size, operating-system
scale, and browser DPR must not be applied as additional world-raster multipliers.

The default policy is `capped`. Arbitrary fixed sizes, percentages, fractional policies, and dynamic
resolution scaling are outside this specification.

## Native UI raster contract

The UI raster size is always the fitted game framebuffer viewport size:

```text
ui_raster_width  = game_viewport_framebuffer_width
ui_raster_height = game_viewport_framebuffer_height
```

RmlUi, ActiveText, menus, modals, and all other runtime UI render at this native UI raster size.
Ordinary native UI is rendered directly into the final game viewport; it is not rendered as a
completed lower-resolution UI texture and stretched.

There is no capped, reduced, retro, fixed, percentage, or fractional UI raster policy in the initial
implementation.

## RmlUi context layout contract

RmlUi layout dimensions are independent from output framebuffer dimensions.

Runtime user settings have the normative shape:

```cpp
struct RuntimeUserSettings {
    double ui_scale = 1.0;
    double text_scale = 1.0;
};
```

For a context whose resolved UI policy either inherits or ignores player UI scale:

```text
effective_ui_scale = runtime_ui_scale when inherited, otherwise 1.0

layout_width  = reference_width  / effective_ui_scale
layout_height = reference_height / effective_ui_scale

ui_raster_scale_x = ui_raster_width  / layout_width
ui_raster_scale_y = ui_raster_height / layout_height
```

At 100% UI scale, ordinary screen-space context dimensions equal the project reference resolution.
UI scale causes a true RmlUi relayout; it is not a post-render zoom.

`px`, `%`, `em`, and `rem` participate in ordinary RmlUi layout in the effective logical context.
`vw` and `vh` use the effective context layout dimensions.

Reference-to-context projection is:

```text
context_x = reference_x / effective_ui_scale
context_y = reference_y / effective_ui_scale
```

The inverse multiplies by `effective_ui_scale`. World-space anchors are resolved in reference space
first and then projected into the target context. Therefore changing UI scale must not move a world
anchor on screen.

The project aspect is fixed, so x and y UI raster scales should agree apart from integer viewport
rounding. Both values must remain available in diagnostics. Material disagreement must be diagnosed
or rejected rather than silently treated as ordinary DPI.

### Layout scale policy and context sharing

The normative Layout scale policy is:

```ts
interface LayoutScalePolicy {
  ui: 'inherit' | 'ignore';
  text: 'inherit' | 'ignore';
}
```

Defaults are:

- `WorldOverlay`: `{ ui: 'ignore', text: 'inherit' }`;
- screen-space planes: `{ ui: 'inherit', text: 'inherit' }`.

The compiled Layout carries the resolved policy. A Lua custom mount may override either field for
that mounted instance without mutating the reusable Layout definition.

Contexts continue to be shared by Layouts with compatible presentation plane, lifecycle, ordering,
event-owner, and effective scale domains. NovelTea must not create one RmlUi context per Layout by
default. A change that moves a document to a different compatible-context key recreates the document
in the destination context while preserving supported lifecycle state such as visibility, listeners,
and focus by element ID.

## RmlUi media-query environment

RmlUi uses a separate media-query environment from ordinary layout dimensions.

- Media-query `width`, `height`, `aspect-ratio`, and `orientation` use the actual fitted game viewport
  in framebuffer pixels, excluding presentation bars.
- Media-query `resolution` uses the native UI raster scale relative to the effective context layout
  viewport.
- Media-query resolution is independent from world raster policy.
- Changing output size must reevaluate media queries even when reference and logical layout
  dimensions remain unchanged.
- Responsive styling is opt-in through authored RmlUi media queries. NovelTea has no separate generic
  responsive-layout mode.

For a `1920x1080` reference and a `3840x2160` fitted game viewport:

- at 100% UI scale, `100vw == 1920`, media width is `3840`, and media resolution is `2dppx`;
- at 125% UI scale, `100vw == 1536`, media width remains `3840`, and media resolution is `2.5dppx`.

## Text scale and ActiveText contract

Player UI scale and player text scale are independent. Both default to `1.0`.

- Text scale multiplies authored text metrics before RmlUi text layout so text is remeasured and
  reflowed.
- Relative and inherited typography must not receive the context text factor more than once.
- Fixed-width panels, icons, padding, and buttons do not automatically grow only because text scale
  changes. Authored RML/RCSS remains responsible for wrapping, clipping, scrolling, expansion,
  overflow, and alternate large-text layouts.

ActiveText remains on its current direct-render architecture during this implementation plan:

- the RmlUi content box remains the authoritative fixed layout box;
- the base authored default text size remains `17px`;
- player text scale multiplies the base size before shaping, wrapping, and clipping;
- glyphs are rasterized for the native UI output scale;
- no intrinsic sizing, computed-RCSS typography extraction, or text-shaper-to-RmlUi feedback loop is
  introduced by this work.

## Input contract

Input domains are explicit:

- Gameplay and world pointer APIs receive project reference coordinates.
- Each RmlUi context receives pointer coordinates in that context's effective logical space.
- Layout Lua events observe coordinates in the mounted Layout's logical context.
- World anchors are resolved in reference space before context projection.
- Pointer events outside the fitted game viewport are rejected from gameplay and runtime-UI routing.
- Moving into a presentation bar must route pointer-leave behavior where required by the active UI
  input implementation.
- Hit testing preserves fractional logical coordinates and must not use raster snapping.

For a `1920x1080` project, the viewport center maps to approximately `(960, 540)` in an unscaled
context and `(768, 432)` in a context inheriting 125% UI scale.

Named projection helpers must exist for:

- host logical point to normalized game-viewport point;
- normalized game-viewport point to reference point;
- reference point or rectangle to world raster;
- reference point or rectangle to native UI raster;
- reference point to a specific RmlUi context's logical coordinates;
- context logical point to native UI raster;
- native UI raster point to context logical coordinates;
- world raster rectangle to native game viewport;
- fitted viewport crop in host framebuffer coordinates.

Each helper must document whether it preserves fractions, rounds edges, snaps, or rejects
out-of-range input.

## Raster snapping and texture filtering

Pixel snapping occurs after layout and after logical-to-raster transformation.

- Snapping is centralized in a renderer-owned `RasterizationPolicy` or equivalently named owner.
- New world, text, UI, or input code must not scatter ad hoc `round()` calls.
- Axis-aligned geometry and scissors may snap to raster edges where beneficial.
- Input and hit testing must not use raster snapping.
- Text shaping, kerning, and glyph advances remain fractional.
- A text run origin or baseline may be snapped as one unit. Individual glyph advances must not be
  rounded independently.
- Ordinary art and UI raster images use linear filtering.
- Meaningful downscaling uses mipmaps where the texture pipeline supports them.
- Pixel-art assets use explicit nearest sampling.
- `rmlui-bgfx` remains application-neutral. NovelTea-specific snapping must not become its default
  behavior. Any required reusable-renderer option must be opt-in and disabled by default.

## Ordinary composition contract

`WorldBackground`, `WorldContent`, and `WorldOverlay` remain one semantic transition group.

An ordinary frame is composed in this order:

1. Render `WorldBackground` and `WorldContent` at the configured world raster size.
2. Scale that result into the native fitted game viewport.
3. Render `WorldOverlay` RmlUi at native game-viewport resolution.
4. Render `GameUi`, ActiveText, menus, and modals afterward at native resolution.
5. Keep presentation bars on the full host output and editor/debug overlays outside game
   composition.

## Transition contract

During a grouped world transition:

1. Render source and target `WorldBackground`/`WorldContent` states at world raster resolution.
2. Upscale each world result into its own temporary native-resolution scene target.
3. Render the matching source or target `WorldOverlay` contexts into that scene target.
4. Perform the transition between the two completed native-resolution scene targets.

Source overlay content must never be routed to the target scene target, and target overlay content
must never be routed to the source scene target.

Native scene targets are allocated only while required and may use a bounded cache. Specialized
transitions, including fade-to-color, may avoid two full native scene targets when their semantics
permit it. Existing source/target revision binding, acknowledgement, skip, cancel, reset, and
reconstruction contracts remain authoritative.

## Postprocess contract

Postprocess scope is closed to `world` and `full-game-viewport`.

- `world` is the default scope.
- A `world` effect applies after low-resolution `WorldBackground`/`WorldContent` and native
  `WorldOverlay` are composed into a native world-scene surface.
- A `world` effect therefore affects the full semantic world group but not later `GameUi`,
  ActiveText, menus, or modals.
- A `full-game-viewport` effect is explicit and applies after native runtime UI composition.
- Presentation bars and editor/debug overlays remain outside both scopes.
- When no world effect is active, the implementation may avoid a permanent extra native world
  target.

## Screenshot and checkpoint-thumbnail contract

File screenshots and checkpoint thumbnails capture only the fitted game viewport.

- Capture bounds are exactly the fitted host-framebuffer viewport rectangle.
- Presentation bars are excluded.
- Host debug UI and editor chrome are excluded.
- The output dimensions equal the fitted game framebuffer viewport width and height.
- Barred and unbarred hosts use the same capture path.
- Existing asynchronous capture IDs, revision binding, readiness, and checkpoint attachment rules
  remain unchanged.

## Editor preview and Web player host contract

Every pooled editor preview and the Play preview use the same runtime presentation pipeline as an
exported player.

- A pooled host follows the active tab's current preview placeholder rectangle.
- The shared host is moved and genuinely resized whenever ownership or group geometry changes.
- The iframe and canvas fill the preview widget; the engine owns aspect fitting and bars.
- A fixed-size iframe plus CSS transform is not a valid presentation path.
- Embedded previews use Electron's actual `devicePixelRatio`; no `maxDpr=1` cap applies.
- The preview backing buffer is the actual host framebuffer supplied to the engine.
- Web canvas CSS size controls presentation; its DPR-scaled backing buffer is the actual output
  surface.
- Browser zoom must not introduce an additional internal game-layout scale.
- A future locked-output emulation tool is separate from the shared preview host.

## Terminology and API naming rules

New APIs, fields, diagnostics, variables, and documentation must name their domain. Ambiguous
unqualified names are forbidden when they can represent more than one domain.

Forbidden examples include:

- `logical`, `logical_size`, or `logical_scale` without a `host`, `reference`, or `context` qualifier;
- `physical`, `physical_size`, or `pixel_size` when `framebuffer`, `world_raster`, `ui_raster`, or
  glyph-raster size is intended;
- `dpi`, `dpi_scale`, or `device_scale` as a shared game/rendering value;
- `game_size`, `game_scale`, `canvas_size`, or `viewport_size` without a domain qualifier;
- `scale_x` and `scale_y` when the owner is not explicitly the host logical-to-framebuffer transform
  or another single named projection;
- `screen_width` and `screen_height` when they could mean host logical, host framebuffer, fitted
  viewport, reference, world raster, UI raster, context layout, or media dimensions.

Acceptable names include:

- `host_logical_size`;
- `host_framebuffer_size`;
- `host_logical_to_framebuffer_scale`;
- `reference_size`;
- `game_viewport_host_logical_rect`;
- `game_viewport_host_framebuffer_rect`;
- `world_raster_size`;
- `ui_raster_size`;
- `context_layout_size`;
- `media_query_size`;
- `reference_to_context_scale`;
- `context_logical_to_ui_raster_scale`.

A type may use shorter member names only when the enclosing type makes exactly one domain
unambiguous, such as `HostSurfaceMetrics::logical_size`. A generic `scale` or `size` must never
silently serve multiple domains.

## Required verification properties

Implementation and regression tests must preserve these properties:

- centered aspect-fit and deterministic trailing ownership of odd spare pixels;
- host logical-edge to framebuffer-edge conversion;
- preview pool lease reuse and current-placeholder move/resize behavior;
- RmlUi compatible-context sharing and document recreation when context keys change;
- source/target transition surfaces receive their matching WorldOverlay contexts;
- the pre-cutover full-host screenshot behavior remains characterized until capture cutover;
- ActiveText uses its RmlUi content box and current raster-size inputs until its scoped bridge phase;
- reference-derived aspect and orientation formulas;
- capped and native world raster formulas;
- effective context dimensions and native UI raster scales;
- media dimensions independent from layout dimensions;
- reversible reference/context and host/reference projections within floating-point tolerance;
- presentation-bar pointer rejection.
