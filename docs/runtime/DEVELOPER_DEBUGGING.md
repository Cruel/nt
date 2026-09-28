# Developer Debugging

## Purpose

NovelTea developer builds expose one engine-owned debugging data plane. Native Dear ImGui, the
editor Play inspector, the editor Console and Trace panes, the RmlUi Debugger controls, and exported
debug reports are presentations over that shared state; they must not grow independent runtime state,
pointer-routing logs, or mutation paths.

`NOVELTEA_ENABLE_DEVTOOLS` is the compile-time boundary for this developer surface. It is not a
runtime preference and it is independent from ordinary runtime diagnostics and logging.

## Build capability matrix

| Host/build | Devtools instrumentation | RmlUi Debugger | Dear ImGui frontend | Editor devtools transport |
| --- | --- | --- | --- | --- |
| Native sandbox, normal developer build | yes | yes | yes when the native ImGui dependency is available | no |
| Native player with `NOVELTEA_ENABLE_DEVTOOLS=ON` | yes | yes | yes when the native ImGui dependency is available | no |
| Optimized `web-editor-preview` | yes | yes | no | yes |
| Production player / `NOVELTEA_ENABLE_DEVTOOLS=OFF` | no | no | no | no |

The optimized Web editor preview deliberately keeps engine instrumentation while omitting Dear ImGui.
Production player presets disable developer instrumentation and link `RmlUi::Core` without
`RmlUi::Debugger`. CI verifies both the Web export surface and the linked native developer-component
surface from built artifacts rather than inferring the result only from option declarations.

## Shared observation surfaces

The **Devtools Snapshot** is the current-state view. It contains host/tooling state, pointer
projection and admission, public RmlUi context/hover/focus information, canonical world Hotspot
observation, and the existing Runtime Debug Snapshot as its runtime section. The runtime section is
not a second gameplay model.

The **Console** is the bounded structured log stream. Records have monotonic sequence IDs, severity,
category, generation identity, and optional Lua source information. Runtime-generation boundaries are
records rather than implicit clears. `Debug.info(...)`, `Debug.warn(...)`, and `Debug.error(...)`
publish here when a developer sink is attached; `print(...)` keeps its normal host logging and is
also mirrored as an informational Lua record in developer builds. In devtools-off builds the `Debug`
table remains source-compatible but has no developer sink.

The **Trace** is the bounded causal routing stream. Pointer records correlate host coordinates,
reference projection, RmlUi processing/consumption, governing Layout admission, gameplay admission,
world hit testing, and Hotspot hover. Equivalent pointer motion may coalesce while state transitions,
buttons, wheel input, generation changes, and debugger mutations remain explicit records. Use the
Trace for "why did this input stop here?" and the Devtools Snapshot for "what is true now?".

The **Export Debug Report** action serializes those same engine-owned values: build identity,
capabilities, current Devtools Snapshot, diagnostics, public RmlUi/debugger summary, and retained
Console/Trace envelopes including retention-gap metadata. It does not scrape editor or ImGui UI.

## RmlUi Debugger and native shortcuts

Developer builds initialize RmlUi's built-in Debugger against the persistent primary context. The
editor controls only its visibility and inspected context; React does not reproduce its element,
style, or data-model inspector. Hiding the debugger preserves the selected context.

On a native developer host, `F10` toggles the NovelTea Dear ImGui debugger frontend and
`Shift+F10` resets its window layout. These shortcuts are intercepted at the host-input layer before
RmlUi, Layout, or gameplay admission. The Dear ImGui frontend consumes the same Devtools Snapshot,
Console, and Trace contracts as editor tooling.

## Diagnosing Rooms & Interactions Hotspots

The existing Feature Lab **Rooms & Interactions** scenario is the canonical manual pointer-routing
acceptance surface. It includes the wall-button Interactable Hotspot and the bedroom-door Feature
Hotspot, so no debugger-specific Project fixture is required.

Launch Feature Lab, open **Rooms & Interactions**, and move the pointer over the wall button or the
bedroom door. In a developer host, inspect the current Devtools Snapshot and Trace while reproducing
the hover/click. A successful world path should show all of the following in order:

1. host coordinates project into a valid reference-space point;
2. RmlUi either does not consume the event or reports a click-through element whose effective
   `pointer-events` allows gameplay to continue;
3. the host admits the event to gameplay rather than reporting a UI/modal/presentation block reason;
4. world hit testing is evaluated and reports the expected owner-qualified Hotspot identity;
5. current-state observation reports that Hotspot as hovered, with its cursor/highlight intent.

If the hover or highlight fails, stop at the first stage whose evidence differs. For example, an
RmlUi element with consuming pointer behavior explains a stop before world evaluation; an admitted
event with `world_evaluated=true` but no `world_hit` points instead at world geometry/mask/input-order
resolution. This distinction is the reason routing evidence lives in Trace rather than in a separate
Hotspot-specific logger.

The authored flow remains unchanged for acceptance: **Try Bedroom Door**, **Press wall button**, then
**Try Bedroom Door** again. The first attempt exercises rejection, the button mutates authoritative
state through the normal Interaction path, and the second attempt exercises successful navigation.
Use the Console for authored/runtime messages, Trace for causal pointer routing, the RmlUi Debugger for
element/style inspection, and the Devtools Snapshot for current world/Hotspot state.

## Verification

The main acceptance checks are:

```sh
bash scripts/check-native-devtools-symbols.sh build/linux-debug/apps/sandbox/noveltea-sandbox on
bash scripts/check-native-devtools-symbols.sh build/linux-debug/apps/player/noveltea-player on
bash scripts/check-native-devtools-symbols.sh build/linux-release/apps/player/noveltea-player off
node scripts/check-web-editor-preview-exports.mjs build/web-editor-preview/apps/editor_preview/index.js on
build/cli/linux/noveltea --project tests/projects/feature-lab test run rooms-interactions-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run rooms-interactions-ui
```

The Web export checker covers the Devtools Snapshot, debug report, RmlUi Debugger control,
Console/Trace transport, runtime debug snapshot, debugger mutations, and fast-forward tooling. CI
runs it against both devtools-off and devtools-on editor-preview builds.
