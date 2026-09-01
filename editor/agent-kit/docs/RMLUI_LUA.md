# RmlUi Lua in NovelTea Layouts

Use this guide when Lua is invoked from authored RML or when a Layout's dedicated Lua source manipulates its RmlUi document. Read `.noveltea/agent/docs/LUA.md` for NovelTea's Lua sandbox and game APIs, `.noveltea/agent/docs/RMLUI.md` for RML/RCSS differences, and `.noveltea/agent/docs/RMLUI_DATA_BINDING.md` before imperatively changing data-model-controlled markup.

NovelTea uses RmlUi's Lua binding inside the same NovelTea Lua runtime. Do not treat it as browser JavaScript and do not treat the upstream RmlUi host-management API as game-authoring authority.

## Three authored Lua sources can participate in one Layout

A Layout can execute Lua from three distinct places:

1. **Dedicated Layout Lua**: the Layout's `layout.lua` source (or Lua Asset source).
2. **RML scripts**: inline `<script>...</script>` and declared external `<script src="..."></script>` content in the RML/template closure.
3. **RML event code**: static `on*` event attributes such as `onclick`, plus code installed from Lua with `Element:AddEventListener(...)` or `Context:AddEventListener(...)`.

These sources share the RmlUi/NovelTea Lua environment for that mounted runtime UI. Keep handler functions namespaced so unrelated Layout scripts do not accidentally overwrite globals.

The RmlUi/NovelTea environment is the stable frontend Lua VM, which is separate from the fresh Project Lua VM used by gameplay Script Modules and the Project Bootstrap Module. NovelTea initializes the frontend VM with its engine-owned Lua system bootstrap, so documented standard helpers such as `Layout.clamp_to_viewport(...)` are already available to Layout scripts. Project-bootstrap globals are not visible here. Do not add a `<script src>` solely to load NovelTea's standard toolbox; see `.noveltea/agent/docs/LUA.md` for exact NovelTea API signatures.

### What `script.enabled` actually controls

`layout.script.enabled` controls **only the dedicated Layout Lua source**. When it is enabled, NovelTea injects the dedicated Layout Lua as a `<script>` into the realized RML document. When it is disabled, NovelTea does not inject that source.

It is **not** a document-wide scripting switch. These remain active independently of `script.enabled` whenever the authored RML/template closure contains them:

- `onclick`, `onchange`, and other static RML event attributes;
- inline `<script>` elements;
- external `<script src="...">` elements;
- Lua contained in linked RmlUi templates;
- string-code listeners installed with `AddEventListener`;
- direct-string `load(...)` calls reached by those scripts.

Therefore, setting `script.enabled: false` does not make an RML document "no-Lua". Remove or disable the actual RML scripting sites if that is the desired behavior.

`script.namespace` is validated Layout metadata, not an automatic Lua module wrapper. Do not assume NovelTea creates the table for you. If the Layout declares a namespace such as `inventory_ui`, define/use that table explicitly in Lua:

```lua
inventory_ui = inventory_ui or {}

function inventory_ui.close(event, element, document)
    return Game.ui.clear_selection()
end
```

## `<script>` execution

Inline and external RmlUi `<script>` elements execute as ordinary top-level Lua chunks when the document is loaded. They do not automatically receive `event`, `element`, or `document` parameters.

Typical use is to define namespaced helpers that event handlers call later:

```xml
<head>
  <script>
    inventory_ui = inventory_ui or {}

    function inventory_ui.select(event, element, document)
      local id = element:GetAttribute("data-item-id")
      return Game.ui.toggle_interactable(id)
    end
  </script>
</head>
```

External scripts use normal RmlUi resource loading:

```xml
<script src="project|/ui/inventory.lua"></script>
```

For NovelTea authoring, the referenced script Asset must also be present in the Layout's declared script dependencies. A source URL in RML does not by itself add the resource to the validated/package dependency graph. Relative script URLs resolve relative to the containing RML/template resource; mounted `project|/` URLs use the same resource spelling as other authored RML resources.

The dedicated `layout.lua` source is different from an authored `<script src>` dependency: it is a dedicated Layout source channel selected by the Layout record and gated by `script.enabled`.

## Inline RML event handlers

RmlUi compiles string event code as a Lua function with exactly these arguments:

```lua
function(event, element, document)
    -- authored handler code
end
```

For a static RML event attribute:

- `event` is the current RmlUi `Event`;
- `element` is the element the listener is attached to;
- `document` is that element's owner document.

Example:

```xml
<button id="close"
        onclick="inventory_ui.close(event, element, document)">
  Close
</button>
```

Do not assume browser globals such as `window`, a JavaScript `this`, or a global browser `document`. Use the explicit Lua parameters RmlUi supplies.

`data-event-*` is a different mechanism: it is RmlUi data-model expression syntax, not Lua source. Use `.noveltea/agent/docs/RMLUI_DATA_BINDING.md` for those callbacks.

## Event propagation and listeners

RmlUi Lua exposes normal RmlUi event propagation rather than browser JavaScript event objects.

Useful `Event` members are:

```text
event.type
event.target_element
event.current_element
event.parameters

event:StopPropagation()
event:StopImmediatePropagation()
```

`target_element` is the original target. `current_element` is the element currently receiving the event as it propagates.

`StopPropagation()` prevents the event from continuing through later propagation targets. `StopImmediatePropagation()` additionally stops remaining listeners on the current target.

Lua can add listeners directly:

```lua
element:AddEventListener("click", function(event, element, document)
    inventory_ui.close(event, element, document)
end)
```

The optional third argument is the capture-phase flag:

```lua
element:AddEventListener("click", handler, true)
```

`Element:AddEventListener` accepts either a Lua function or a string of Lua code. Prefer functions for authored dynamic listeners when practical; string listeners are still executable Lua and are also tracked by NovelTea's source analysis only when the string is statically recognizable.

RmlUi also exposes `Context:AddEventListener(event, listener, element?, capture?)`. Game Layout code normally does not need context-wide listeners; prefer element-scoped listeners unless an existing NovelTea Layout requires context-level propagation behavior.

## Element API: useful authored operations

RmlUi's Lua API is DOM-like in purpose, but its names and semantics are RmlUi's own. Methods are capitalized and many properties use `snake_case`; do not translate browser JavaScript spellings mechanically.

Common lookup/testing methods:

```text
element:GetElementById(id)
element:GetElementsByTagName(tag)
element:QuerySelector(selector)
element:QuerySelectorAll(selector)
element:Matches(selector)
element:GetAttribute(name)
element:HasAttribute(name)
element:IsClassSet(name)
element:HasChildNodes()
```

`GetElementsByTagName` and `QuerySelectorAll` return ordinary 1-based Lua tables.

Common mutation/input methods:

```text
element:SetAttribute(name, value)
element:RemoveAttribute(name)
element:SetClass(class_name, enabled)
element:Focus()
element:Blur()
element:Click()
element:ScrollIntoView(...)
element:DispatchEvent(type, parameters)
```

Common readable properties include:

```text
attributes
child_nodes
class_name
client_left / client_top / client_width / client_height
first_child / last_child
id
inner_rml
next_sibling / previous_sibling
offset_left / offset_top / offset_width / offset_height / offset_parent
owner_document
parent_node
scroll_left / scroll_top / scroll_width / scroll_height
style
tag_name
```

Writable element properties are limited to:

```text
class_name
id
inner_rml
scroll_left
scroll_top
```

### Local styles

`element.style` accesses the element's local RCSS properties using strings:

```lua
element.style["display"] = "none"
element.style["margin-left"] = "12dp"
element.style["display"] = nil -- remove the local property
```

The property/value must still be valid for NovelTea's pinned RCSS implementation. Use `.noveltea/agent/docs/RCSS_REFERENCE.md` rather than browser CSS vocabulary.

### Creating and moving nodes

The owner document can create elements/text nodes:

```lua
local row = document:CreateElement("div")
row.id = "runtime-row"
row.inner_rml = "Generated text"
element:AppendChild(row)
```

Other structural methods are:

```text
AppendChild
InsertBefore
RemoveChild
ReplaceChild
```

RmlUi element ownership is move-like for newly created `ElementPtr` values: after appending/inserting/replacing a created node, do not assume the original owning wrapper can be reused as another unattached node.

Prefer declarative RML and data binding for repeatable game-state-driven structure. Use imperative creation mainly for local UI behavior that is not better represented by `data-for`, `data-if`, or the NovelTea data model.

## `document` is an RmlUi document, not a browser document

The event-handler `document` is an RmlUi `ElementDocument`. It inherits the Element lookup/mutation API above and adds:

```text
document:CreateElement(tag)
document:CreateTextNode(text)
document.title
document.context
```

Upstream RmlUi also exposes document lifecycle/z-order methods such as `Show`, `Hide`, `Close`, `PullToFront`, and `PushToBack`. Do not use those to manage NovelTea Layout lifecycle or presentation order. NovelTea owns mounting, visibility, plane/order, input policy, transitions, and unmounting through its Layout/presentation contracts. Use `noveltea.layouts.*`, `Game.ui.*`, `Game.shell.*`, or the declarative Layout model as appropriate.

## Data-model-controlled markup: do not fight the owner

RmlUi data binding may own element state or document structure. Imperative Lua changes can be overwritten or can invalidate the assumptions of the binding controller.

In particular:

- Do not manually add/remove/reparent repeated children inside a `data-for` region.
- Do not assign `inner_rml` inside a subtree whose children are owned by `data-rml`.
- Avoid imperatively changing an attribute/class/style that a `data-attr-*`, `data-attrif-*`, `data-class-*`, or `data-style-*` binding owns; the next model update may replace your value.
- Do not dynamically add a `data-*` binding attribute and expect RmlUi to instantiate a new binding controller for it.
- Keep imperative local UI state in markup that is not structurally owned by `data-for`/`data-rml`, or express the state through the data model when it represents game/runtime state.

`data-if` and `data-visible` change display/visibility rather than owning child structure, but an imperative write to the same display/visibility property still competes with the binding and should be avoided.

## NovelTea APIs from Layout Lua

RmlUi scripts execute inside NovelTea's Lua sandbox and can see the NovelTea API tables installed for their invocation context. The exact API and capability rules are in `.noveltea/agent/docs/LUA.md`.

Important Layout-specific rules:

- Gameplay Layout events are non-yielding. Do not call `audio.play_and_wait`, `audio.stop_and_wait`, or manually `coroutine.yield()` from RML event code.
- `Game.ui.*` is the typed input surface for gameplay Layout interaction and validates against the current published gameplay view.
- `Game.shell.*` and `Game.start()` are for shell/system Layout contexts and are not a general gameplay-script control API.
- General `noveltea.*`, `audio.*`, and `Game.*` calls remain subject to the capability profile of the current Layout invocation. A globally visible function is not proof that the current Layout has authority to use it.
- Prefer stable NovelTea IDs from current model/markup state rather than display text or DOM position.

For purely declarative UI actions, prefer the `noveltea` data model's `data-event-*` callbacks. Use Lua when the handler needs RmlUi element/event behavior or more involved authored logic.

## Host-owned RmlUi APIs: do not use in game Layouts

The upstream Lua binding exposes several APIs because RmlUi can be embedded by arbitrary applications. NovelTea is that embedding application, so these are host responsibilities, not game-authoring facilities.

Do not use:

```text
rmlui:CreateContext(...)
rmlui:LoadFontFace(...)
rmlui:RegisterTag(...)
```

Do not use `rmlui.contexts` to discover/manage NovelTea's internal context topology.

Likewise, do not use `document.context` to perform host lifecycle/input work such as:

```text
Context:CreateDocument
Context:LoadDocument
Context:UnloadDocument
Context:UnloadAllDocuments
Context:Update
Context:Render
Context:ProcessMouseMove
Context:ProcessMouseButtonDown / ProcessMouseButtonUp
Context:ProcessMouseWheel
Context:ProcessMouseLeave
Context:ProcessKeyDown / ProcessKeyUp
Context:ProcessTextInput
Context:OpenDataModel
Context:CloseDataModel
```

Do not assign context dimensions or density-independent pixel ratio. NovelTea owns context creation/grouping, dimensions, UI/text scaling, clocks, input routing, data-model registration, fonts, and custom `nt-*` element registration.

If authored behavior requires another Layout, font, custom component, scale policy, or input mode, express that through NovelTea's corresponding project/Layout/runtime contract rather than configuring the RmlUi host from Lua.

## Reload and lifetime assumptions

Mounted documents can be recreated during authored source/style reload or policy/context changes while NovelTea preserves logical Layout identity. Do not retain an RmlUi Element/Document object as durable game state outside the lifetime of the document that produced it.

Prefer stable element IDs and reacquire elements from the current `document` when needed. Keep persistent gameplay state in NovelTea Variables/Properties or other typed runtime state, not in Lua references to RmlUi objects.

Dynamically added RmlUi Lua event listeners are owned by their attached element and disappear when that element/document is destroyed. Reinstall dynamic listeners as part of the document/script initialization that creates the relevant current elements.

## Minimal pattern

Dedicated `layout.lua`:

```lua
inventory_ui = inventory_ui or {}

function inventory_ui.select(event, element, document)
    local id = element:GetAttribute("data-item-id")
    if not id then
        return false
    end
    return Game.ui.toggle_interactable(id)
end
```

RML:

```xml
<section data-model="noveltea">
  <button data-for="item : gameplay.inventory.items"
          data-attr-data-item-id="item.id"
          data-attrif-disabled="!item.enabled"
          onclick="inventory_ui.select(event, element, document)">
    {{ item.display_name }}
  </button>
</section>
```

This keeps repeatable structure and enabled state under the data model, uses Lua only for local event/element behavior, and sends gameplay interaction through NovelTea's validated Layout input API.
