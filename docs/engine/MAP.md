# Map Component

## Contract

A `MapDefinition` is presentation and navigation affordance data projected over authoritative Room topology. A Map never owns a second navigation graph.

Each Map Location has a stable `MapLocationId`, references exactly one Room, and may contain multiple normalized polygon regions in Map canvas coordinates. A Room may appear at most once in a Map. Location presentation may additionally provide a label, icon, style ID, label anchor, connection anchor, visibility condition, pointer pick order, and semantic logical order.

Each Map Connection has a stable `MapConnectionId` and references either one directed `RoomExitRef` or exactly two reciprocal exits. The compiler derives the source and target Map Locations from the referenced Room exits; authors do not store connection endpoints separately. A two-exit Connection is valid only when the exits point to each other's Rooms. Connection presentation may provide a label, icon, style ID, visibility condition, logical order, a visual path, and optional normalized polygon hit regions.

The compiler and native validator reject missing/duplicate Room projection, missing exits, malformed reciprocal pairs, non-normalized geometry, and connection topology that cannot be derived from the authoritative Room exits.

## Runtime behavior

`MapView` is a pure projection of immutable Map data plus current authoritative runtime state. Runtime publication resolves localized labels, location/connection visibility, the current Room, the active directional exit for each Connection, semantic actionability, and the unique actionable Room-region convenience exit when one exists.

Visibility and actionability are distinct. A visible Connection is actionable only when the active Room owns one of its exits, no Flow transition is already active, the source and target Rooms still exist, and the same declarative and script guard checks used by normal Room navigation currently permit the attempt. Rejection hooks are not run during this preflight. Activation itself submits the exact ordinary Navigation Attempt, so exit selection, rejection handling, before/after lifecycle hooks, Room switching, visits, presentation, and failures remain owned by the normal Room pipeline.

A Location convenience action is published only when exactly one visible actionable Connection reaches that Location's Room from the active Room. The convenience carries that exact `RoomExitRef`; it never becomes fast travel or a direct Room change. Ambiguous or unavailable routes leave the Location non-actionable while it remains a semantic focus target.

Pointer geometry is separate from semantic navigation. Polygon regions and Connection hit regions are used for pointer picking only. The RmlUi component also emits ordinary semantic button targets for Locations and Connections in logical order, so keyboard, controller/focus navigation, and assistive technology do not depend on polygon hit testing.

## Per-occurrence view state

Open/closed state, minimap/full-map mode, focused Location, pan, and zoom belong to each individual `<nt-map-view>` element occurrence. They are not `SessionState`, Map definition state, desired presentation state, or implicit save state. Multiple Map elements therefore retain independent view state while consuming the same projected Map.

The element mirrors its local state through `open`, `mode`, `focus`, `pan-x`, `pan-y`, and `zoom` attributes and emits `mapstatechange` when user interaction changes it. Layout Lua may explicitly persist such a value only by committing it through the owning mounted Layout's declared Layout State Slot via `Game.mount_context():commit_state(...)`. Without an authored Slot/commit, the state is occurrence-local and disposable. Save bytes contain only validated Layout State Slots, never arbitrary RmlUi DOM/component state.

## Authoring, compiled, and state disposition

- **Authoring:** collection-specific Map record with one-Room Locations, normalized polygon geometry, exit-backed Connections, visibility, presentation metadata, pick/logical ordering, and Map presentation defaults.
- **Compiled:** immutable `MapDefinition` with resolved derived source/target Location IDs, validated Room/Exit/resource references, compiled conditions/text, and normalized geometry.
- **Runtime projection:** `TypedRuntimeUIViewState.maps` contains one `MapView` per authored Map. It carries semantic current/visible/actionable state but no per-element focus/pan/zoom/open state.
- **Mutable presentation state:** owned by each `<nt-map-view>` occurrence; persistence is available only through an explicitly authored Layout State Slot.
- **Tooling only:** editor selection and ordinary editor viewport state remain editor metadata rather than gameplay state.

## Runtime UI and scripting

RuntimeUI refreshes every `<nt-map-view>` in supported system documents and mounted gameplay Layout documents. A component may select a specific Map with its `map` attribute; when the project has exactly one Map, omission selects that sole Map. Different occurrences can show the same Map with independent local state.

The component creates semantic Location and Connection targets with strong Map/Room/Location/Connection/Exit IDs. Pointer selection uses normalized polygons and configured pick order, then transfers focus/activation to the same semantic target used by non-pointer input. Logical order is independent of pick order.

Authored runtime Lua does not own Map presentation state. `noveltea.map.activate(map_id, connection_id)` validates the authored Map/Connection relationship against the active Room and queues the exact normal Navigation Attempt. It deliberately does not synchronously run Lua navigation predicates from inside an already executing Lua invocation; the canonical navigation attempt performs the authoritative guard/rejection lifecycle. Layout-side `Game.ui.navigate_map_connection(map_id, connection_id)` and `Game.ui.navigate_map_location(map_id, location_id)` operate on the currently published semantic Map view and reject stale or disabled targets.
