# RmlUi Runtime UI

## Role

RmlUi is the general runtime UI layer. `RuntimeUI` owns RmlUi lifecycle, document loading, input
translation, document binding, and custom elements. It is a presentation adapter only.

The backend-neutral runtime publishes one coherent `runtime::RuntimePublication`. `RuntimeUI` binds
its gameplay-UI view to RmlUi, consumes ordered runtime events, and sends closed
`RuntimeInputMessage` values through a host-provided callback. It never stores a runtime-session
pointer or owns Flow state, mutable gameplay state, compiled gameplay JSON, saves, presentation
operations, or completion queues.

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

Each realized document retains its typed mounted owner. RuntimeUI isolates gameplay-owned and
shell-owned documents into distinct authority contexts even when plane, clock, and input policy are
otherwise identical. While RmlUi dispatches an event for one context, RuntimeUI installs the
engine-issued `GameplayLayoutEvent` or `ShellLayoutEvent` capability set into the existing
`RuntimeScriptApi`, then clears it immediately after dispatch. The sets are reissued after runtime
generation changes such as reset or load. Gameplay Layout events may use the admitted scoped
presentation, audio, state, and input commands without yielding. Shell Layout events remain
restricted to shell-safe game/save commands and cannot mutate gameplay presentation or variables.

System Layouts use the typed `Game.shell` table. It provides start/pause/resume, settings, save/load,
text-log, confirmation, return-to-title, quit, and optional debug-overlay commands. `Game.shell.state()`
returns a read-only typed projection containing the current shell screen, runtime user settings,
checkpoint readiness and replay distance, retained-checkpoint/thumbnail status, and typed save-slot
metadata. It does not expose encoded save bytes, checkpoint ownership, a mutable JSON document, or a
runtime-session pointer. Built-in menu documents consume this same API; project-authored system
Layouts are resolved and mounted through the same policy path.

`RuntimeLayoutManager::evaluate_input_policy()` selects the strongest visible mounted input policy,
using plane, local order, and instance identity to break equal-policy ties. RuntimeUI groups mounted
documents by presentation plane, contiguous composition group, clock domain, input mode, and mounted
owner authority. SDL events route from the top visible context downward. A consumed event or modal context stops lower
presentation delivery; a block-gameplay context still permits lower presentation handling but blocks
later gameplay fallthrough through the mounted-policy admission result. Layout-originated
`Game.ui.*` gameplay commands use that same admission result; trusted lifecycle and acknowledgement
paths do not. Escape unmounts the topmost dismissible instance through its recorded owner, while a
higher non-dismissible modal shields lower Layouts.

## Lifecycle Domains

`RuntimeLayoutManager` owns typed mounted-instance policy and deterministic plane/local ordering.
RuntimeUI creates contexts only for compatible plane/clock/input runs. A new composition group is
created when a different lifecycle policy is interleaved between otherwise compatible documents, so
the final context order can still reproduce arbitrary mounted order without creating one context per
document by default. RuntimeUI selects the engine's gameplay or unscaled absolute clock before every
update, render, and routed input dispatch. Frozen gameplay documents retain their animation time while
unscaled menus continue. Each presentation plane has a reserved bgfx view range; direct ActiveText
sits above GameUi documents and below menu/modal planes.

Compiled Layout documents and fragments from the presentation snapshot are materialized through
`AssetManager` and reconciled idempotently. Policy replacement recreates realization in the target
context while retaining NovelTea identity, visibility, callback listeners, and focus by element ID.
Document/style reload recreates every built-in, custom, fragment, and memory-backed document in its
recorded lifecycle context, restores ordering and visibility, rebinds listeners, and then rebinds the
authoritative runtime view. RmlUi pointers remain borrowed backend state.
## Phase 4 presentation boundary

`RuntimeUI` is not the presentation/audio operation broker. It remains the RmlUi publication/event
consumer and typed input source. Engine host orchestration dispatches the runtime session, routes the
desired presentation snapshot to `RuntimePresentationBridge`, applies the gameplay UI view, delivers
events, flushes backend work, and queues exact completion inputs for a later non-recursive dispatch.
Lifecycle, total ordering, checkpoint barriers, backend retry, and terminal decisions belong to the
coordinator. ActiveText reveal and fade are coordinator-owned causal phases advanced from gameplay
time; local hover/focus/CSS animation remains disposable.
