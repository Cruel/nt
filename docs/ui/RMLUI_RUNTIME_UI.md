# RmlUi Runtime UI

## Role

RmlUi is the general runtime UI layer. `RuntimeUI` is an engine-private publication adapter and
action gateway host for the shared `noveltea` data model, typed Layout events, and specialized custom
elements; applications use the public `Engine` facade instead.
Its private `RmlUiHost` owns RmlUi initialization and shutdown, system/file/render interfaces,
lifecycle-keyed contexts, clocks, SDL input translation, resize, and render submission. `RuntimeUI`
remains a presentation adapter only and is declared under `engine/src/ui/rmlui/` rather than the
application-facing include tree.

The backend-neutral runtime publishes one coherent `runtime::RuntimePublication`. `RuntimeUI` binds
its gameplay-UI view to RmlUi, consumes ordered runtime events, and sends closed
`RuntimeInputMessage` values through a host-provided callback. It never stores a runtime-session
pointer or owns Flow state, mutable gameplay state, compiled gameplay JSON, saves, presentation
operations, or completion queues.

RuntimeUI is a one-way publication consumer. It has no public typed-view or diagnostic read-back
API. Engine shell, preview, recorder, debugger, and protocol consumers retain the final
`RuntimePublication` at the host boundary and consume its gameplay view, presentation snapshot, and
observations directly.

Borrowed RmlUi document, element, and data-model pointers are not part of any application-facing API.
Backend-native inspection is limited to the private playback/test adapter; production engine callers
use stable document IDs and typed adapter operations.

## Data Model, Typed Views, and Inputs

`RuntimeUiDataModel` owns stable RmlUi-private projection storage for `project.*`, `gameplay.*`, and
`shell.*`. Every RuntimeUI-created RmlUi context attaches a context-local model named `noveltea`
before any document in that context is loaded. Full documents and Fragments opt in explicitly with
`data-model="noveltea"`; system role is not required and does not inject hidden model attributes.

The private `RuntimeUiActionGateway` consumes exactly one revisioned `RuntimeUiGameplayValues`
subview plus the current published shell-slot availability summary. It owns stale-revision rejection,
current gameplay-view retention, `Game.ui.*` installation, typed action validation (including exposed
save-slot membership and occupied load targets), mounted-Layout gameplay admission, ordered event
capture, and typed gameplay input/shell-command dispatch through the host-provided seam. RmlUi model
callbacks and equivalent Lua helpers converge on these same named native action methods rather than
duplicating validation.

RuntimeUI projects Scene/Dialogue choices, Room exits/placements/controls, inventory, Text Log,
selection, Continue state, title metadata, settings/checkpoint/save-slot shell state, and other
ordinary UI values through the data model. RML authors its own loops, visibility, labels, classes,
attributes, styles, and callback bindings. There is no selector/index compatibility protocol or
generic controller-command adaptation; invalid or stale IDs/messages fail at the typed boundary.

The exact field and callback schema is defined in `docs/ui/RMLUI_DATA_MODEL_CONTRACT.md`.

## Custom Components

C++-backed custom elements are limited to the cases where ordinary data binding is insufficient:

- ActiveText keeps parsed rich text/data for the direct text renderer;
- MapView preserves strong Map/Room/Location/Connection/Exit IDs through an explicitly provisional
  focused adapter.

Text Log is ordinary data-driven RML over `gameplay.text_log.entries`; there is no current
`nt-text-log` component. Complex runtime widgets should use C++-backed RmlUi components only when
generic RML/data binding is insufficient.

## Rendering and Assets

The RmlUi bgfx adapter owns texture/material/render submission details. The asset-backed file
interface resolves logical paths through `AssetManager`. Runtime layouts and their referenced
assets/materials are collected by the compiled resource/package path.

Each rendered context has one explicit logical/raster contract. `RmlUiHost` owns the authoritative
`ResolvedContextMetrics` and passes the active context record's exact metrics to its plane adapter
immediately before `Context::Render()`. The adapter never independently derives a baseline context.
At the 100% baseline, RmlUi receives reference-sized logical dimensions, actual native UI
framebuffer dimensions for media queries, the native logical-to-raster ratio as its DP ratio, text
scale `1.0`, and the same scalar as the context-local font raster scale.

Font raster scale changes only glyph resources. The NovelTea RmlUi extension keeps logical font
metrics, advances, wrapping, and hit-test geometry at the authored size while the default FreeType
engine keys exact handles by logical and raster size and builds atlas pixels at the requested native
density. Density changes use `ReleaseFontRasterResources()` to discard stale density-specific font
resources without semantically dirtying text layout. This bounds exact-size cache growth to the
currently active density set.

Raster-origin snapping is owned by the NovelTea adapter submission boundary after logical-to-raster
transformation. It may snap a submitted run/geometry origin as one unit; it does not round glyph
advances or alter input coordinates. `rmlui-bgfx` remains generic and receives the configured
logical dimensions, framebuffer dimensions, projection scale, viewport, and scissor mapping.

The host also supplies an explicit final-output framebuffer for capture frames. During an ordinary
frame, non-debug RmlUi planes resolve to the normal final presentation target unless a transition or
postprocess surface has more specific ownership. During a screenshot capture frame, those same
non-debug planes resolve to the screenshot scene target so the captured presentation includes runtime
UI exactly once. Transition-local and postprocess-local targets retain precedence. The Debug plane is
never redirected into the screenshot target, so host/debug overlays remain outside captured game
content.

ActiveText may use the direct bgfx text renderer while remaining driven by the same typed published
state.

The ActiveText presenter obtains its system font exclusively through the asynchronous typed asset
path. It records the source generation for its pending request or retained lease, compares that value
with `AssetManager` during refresh, and releases/reissues the request after compiled-project font
configuration or project replacement advances the generation. Initialization order is therefore not
relied upon to keep the font alive.

## Universal RCSS Baseline

Every RmlUi `ElementDocument` instantiated through NovelTea's RuntimeUI document registry receives
two engine-owned baseline stylesheet layers before any template or document-authored RCSS:

1. `system:/ui/baseline/rmlui-html4.rcss` is a frozen verbatim copy of the stylesheet block from
   RmlUi's recommended HTML style sheet documentation.
2. `system:/ui/baseline/noveltea.rcss` contains NovelTea-specific universal defaults layered above
   that imported baseline.

The resulting cascade order is `RmlUi HTML4 -> NovelTea -> template RCSS -> document RCSS`. This
applies equally to built-in system documents, project Layouts, fragments after hosting, focused
previews, and internal RuntimeUI utility documents. Authors do not need to and should not explicitly
link either baseline file; ordinary authored RCSS overrides the baseline normally.

RuntimeUI parses the two immutable baseline assets once per UI session. Each loaded document receives
a fresh combined `StyleSheetContainer`, so media-query compilation remains document/context-local.
Failure to obtain or parse either required baseline prevents RuntimeUI document loading rather than
silently rendering without the contract.

The imported RmlUi file comes from
`https://github.com/mikke89/RmlUiDoc/blob/23cc335d8c67c12c706dee4b8ddec9416e4c4280/pages/rml/html4_style_sheet.md`
(the stylesheet code block; upstream file commit dated 2024-06-06). Its NovelTea copy has SHA-256
`6d29abc4a959f14dac3041ecce498c0aac98cbd9e141951c5749e12a02542d05`, enforced by a CTest check.
Do not modify that file for engine-specific styling; put such changes in `noveltea.rcss`. Refreshing
the upstream baseline is an explicit compatibility change and requires updating the pinned
provenance and hash together.

## Layout Events and Lua

Layout events use Lua and the single `RuntimeScriptApi` gateway. Do not expose arbitrary project or
save JSON, dispatcher/controller pointers, or a second gameplay binding table.

Each realized document retains its typed mounted owner. RuntimeUI isolates gameplay-owned and
shell-owned documents into distinct authority contexts even when plane, clock, and input policy are
otherwise identical. While RmlUi dispatches an event for one context, RuntimeUI installs the
engine-issued `GameplayLayoutEvent` or `ShellLayoutEvent` capability set into the existing
`RuntimeScriptApi`, then clears it immediately after dispatch. The sets are reissued after runtime
generation changes such as reset or load. Gameplay Layout events may use the admitted scoped
presentation, audio, state, and input commands without yielding. Shell Layout events remain
restricted to shell-safe game/save commands and cannot mutate gameplay presentation or variables.

System Layouts use the typed `Game.shell` table. It provides start/pause/resume, settings, save/load,
text-log, confirmation, return-to-title, quit, and optional debug-overlay commands. UI and text scale
have independent `set_ui_scale(value)` and `set_text_scale(value)` bindings; built-in settings Layouts
also use typed minimum/default/maximum bindings backed by the loaded project's exact policy ranges.
`Game.shell.state()` returns a read-only typed projection containing the current shell screen,
effective `ui_scale` and `text_scale`, the loaded-project accessibility policy, checkpoint readiness
and replay distance, retained-checkpoint/thumbnail status, and typed save-slot metadata. It does not
expose encoded save bytes, checkpoint ownership, a mutable JSON document, or a runtime-session
pointer. Built-in menu documents hide a scale control when its project policy disables it.
Project-authored system Layouts are resolved and mounted through the same policy path.

System role owns lifecycle, mounting, input/pause policy, and shell routing, not a separate DOM
population contract. Built-in and project-authored documents in any RuntimeUI context can read the
same `noveltea` projection when they explicitly opt in. Copying a built-in RML/RCSS document into a
project Layout therefore preserves its declarative behavior as long as the copied model bindings and
typed callback expressions are retained; changing or removing an authored ID has no native
population consequence.

The world renderer remains the sole owner of Room and Scene backgrounds. Ordinary runtime UI state
does not use native `GetElementById()` population or generated choice/navigation/object/inventory/
save/load/text-log subtrees. Document reload and lifecycle-context recreation attach `noveltea`
before document load and reuse the latest projection state.

RmlUi source URLs use the mounted logical asset namespaces. Engine-owned fallback resources use
`system|/path`, which the file interface resolves to `system:/path`. Project Layout resources use
`project|/path`, which resolves to `project:/path`. A project image referenced from RML must also be
declared in the Layout's image dependencies so focused preview and package assembly include it. The
dependency declaration closes the resource graph; it does not rewrite an Asset ID into a URL inside
the RML source.

`docs/ui/RMLUI_DATA_MODEL_CONTRACT.md` is the authoritative inventory of the exact `noveltea` field
schema, model callbacks, projection semantics, and current custom-element exceptions.

Changing effective runtime scale values updates existing RmlUi contexts in place. The host applies
layout dimensions, media dimensions, DP ratio, text factor, and font raster scale before the next
context update and releases global font raster resources at most once. It does not recreate mounted
documents, reset gameplay, replace Layout identities, clear focus, or replace native document
listeners. Context scale-domain inheritance is added separately by the scale-domain workstream.

`RuntimeLayoutManager::evaluate_input_policy()` selects the strongest visible mounted input policy,
using plane, local order, and instance identity to break equal-policy ties. RuntimeUI groups mounted
documents by presentation plane, semantic composition group, contiguous compatibility run, clock
domain, input mode, mounted-owner authority, and effective UI/text scale domain. SDL events route
from the top visible context downward. A consumed event or modal context stops lower presentation
delivery; a block-gameplay context still permits lower presentation handling but blocks later
gameplay fallthrough through the mounted-policy admission result. Layout-originated
`Game.ui.*` gameplay commands use that same admission result; trusted lifecycle and acknowledgement
paths do not. Escape unmounts the topmost dismissible instance through its recorded owner, while a
higher non-dismissible modal shields lower Layouts.

## Lifecycle Domains

`RuntimeLayoutManager` owns typed mounted-instance policy and deterministic plane/local ordering. The
private RmlUi host creates contexts only for compatible plane/clock/input/owner/scale-domain runs
requested by RuntimeUI's document policy path. A new contiguous compatibility group is created when
a different lifecycle or scale policy is interleaved between otherwise compatible documents, while
the semantic composition group remains unchanged. The final context order can therefore reproduce
arbitrary mounted order without creating one context per document by default. Scale domain is an
identity discriminator only and is excluded from presentation sorting. The host
selects the engine's gameplay or unscaled absolute clock before every update, render, and routed input
dispatch. Frozen gameplay documents retain their animation time while unscaled menus continue. Each
presentation plane has a reserved bgfx view range; direct ActiveText sits above GameUi documents and
below menu/modal planes.

`PresentationLayoutReconciler` maps presentation-snapshot records to logical mounted instances, and
`LayoutRealizer` alone materializes compiled Layout documents and fragments through `AssetManager`.
The Layout `script.enabled` setting controls only the dedicated `layout.lua` component injected by
`LayoutRealizer`. It is not a whole-document script kill switch: authored RML event attributes,
inline or external `<script>` elements, templates, and their listener/load strings remain part of
the RML document whenever that document is mounted.
Policy replacement recreates realization in the target context while retaining NovelTea identity,
visibility, callback listeners, and focus by element ID.
Document/style reload recreates every built-in, custom, fragment, and memory-backed document in its
recorded lifecycle context, restores ordering and visibility, rebinds listeners, and renders from the
already-current `noveltea` projection. Borrowed RmlUi pointers remain private backend state rather
than facade contracts.
## Presentation boundary

`RuntimeUI` is not the presentation/audio operation broker. It remains the RmlUi publication/event
consumer and typed input source. `GameHost` dispatches the runtime session, routes the desired
presentation snapshot to `RuntimePresentationBridge`, applies the gameplay UI view, delivers events,
flushes backend work, and queues exact completion inputs for a later non-recursive dispatch.
Lifecycle, total ordering, checkpoint barriers, backend retry, and terminal decisions belong to the
coordinator. ActiveText reveal and fade are coordinator-owned causal phases advanced from gameplay
time; local hover/focus/CSS animation remains disposable.
