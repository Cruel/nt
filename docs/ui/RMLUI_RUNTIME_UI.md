# RmlUi Runtime UI

## Role

RmlUi is the general runtime UI layer. `RuntimeUI` owns RmlUi lifecycle, document loading, input
translation, document binding, and custom elements. It is a presentation adapter only.

The backend-neutral runtime publishes `TypedRuntimeUIViewState`. `RuntimeUI` binds that state to
RmlUi and sends closed `RuntimeInputMessage` values back through `TypedRuntimeSession`. It never
owns Flow state, mutable gameplay state, compiled gameplay JSON, or saves.

## Typed Views and Inputs

The binder presents typed Scene/Dialogue text and choices, Room exits/placements/controls,
inventory, Map locations/connections, text log entries, selection, and continue state. Click targets
carry stable IDs and call approved `Game.ui.*` helpers backed by `RuntimeScriptApi`.

There is no selector/index compatibility protocol or generic controller-command adaptation. Missing
optional document slots are tolerated and logged once; invalid IDs/messages fail at the typed
boundary.

## Custom Components

C++-backed custom elements include ActiveText, MapView, and TextLog. Their snapshots are derived only
from `TypedRuntimeUIViewState`:

- ActiveText keeps parsed rich text/data for the direct text renderer;
- MapView preserves strong Map/Room/Location/Connection/Exit IDs;
- TextLog escapes user text and emits typed entry metadata.

Complex runtime widgets should continue to use C++-backed RmlUi components where generic RML is
insufficient.

## Rendering and Assets

The RmlUi bgfx adapter owns texture/material/render submission details. The asset-backed file
interface resolves logical paths through `AssetManager`. Runtime layouts and their referenced
assets/materials are collected by the compiled resource/package path.

ActiveText may use the direct bgfx text renderer while remaining driven by the same typed published
state.

## Layout Events and Lua

Layout events use Lua and the single `RuntimeScriptApi` gateway. Do not expose arbitrary project or
save JSON, dispatcher/controller pointers, or a second gameplay binding table.

## Presentation Debt

`RuntimeLayoutManager` now owns typed mounted-instance policy and deterministic plane/local ordering,
while its document host still realizes all documents in the transitional single RmlUi context.
The engine derives effective gameplay pause from visible mounted policy alongside explicit session
pause and platform suspension. Phase 3D adds deterministic input/Escape routing; Phase 5 adds
lifecycle-domain contexts.
`RuntimeTransitionManager`, `TweenService`, ActiveText, audio, RmlUi, and bgfx adapters otherwise
remain transitional presentation scaffolding/backends whose coordination belongs to the
presentation-coordinator plan.
