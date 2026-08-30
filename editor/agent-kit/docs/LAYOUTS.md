# Layouts and RmlUi

For RML/RCSS syntax and the differences from browser HTML/CSS, read `.noveltea/agent/docs/RMLUI.md` first. For RML event Lua, `<script>`, or the dedicated Layout Lua source, read `.noveltea/agent/docs/RMLUI_LUA.md` together with `.noveltea/agent/docs/LUA.md`. This document covers NovelTea's Layout source and dependency rules.

Layouts use RmlUi RML/RCSS plus optional dedicated Lua. For file-mode Layout channels, edit the companion `layout.rml`, `layout.rcss`, or `layout.lua` file directly. Asset-mode and none-mode channels must not be replaced by companion files behind the workspace's back.

Use project asset/reference forms already present in the schemas and project docs. Validate after RML, RCSS, or Layout metadata changes so dependency and source diagnostics remain authoritative.

## Baseline RCSS applies to every Layout

All Layout RCSS is authored above NovelTea's universal RuntimeUI baseline. The engine applies the frozen RmlUi HTML4 baseline first, then the NovelTea-specific baseline, then template RCSS, then the Layout/document's own RCSS.

Do not add `<link>` entries or Layout stylesheet dependencies for the baseline files. They are implicit engine-owned layers and apply equally to built-in Layouts, project Layouts, hosted fragments, and focused previews. Project RCSS should contain only project-owned styling and intentional overrides of baseline defaults.

The installed CLI exports the exact baseline source together with its other internal Layout references:

```text
.noveltea/agent/system-layouts/ui/baseline/rmlui-html4.rcss
.noveltea/agent/system-layouts/ui/baseline/noveltea.rcss
```

Inspect those generated baseline files when an inherited/default style matters, but never edit or copy them wholesale merely to reproduce the runtime defaults.

## System Layout overrides

Project settings can replace the engine UI Layout assigned to each system role through `settings.ui.systemLayouts`. The roles are:

```text
title
game-hud
command-builder
pause-menu
save-menu
load-menu
settings-menu
text-log
modal
debug-overlay
scene-text
scene-choice
```

Leaving `title`, `game-hud`, `command-builder`, `pause-menu`, `save-menu`, `load-menu`, `settings-menu`, `text-log`, `modal`, `scene-text`, or `scene-choice` unassigned uses the engine's built-in fallback. `debug-overlay` has no built-in fallback; assign a project Layout if the project needs one.

A system Layout override is a behavioral replacement, not just a visual skin. Preserve or deliberately replace the built-in data-model bindings, callbacks, custom elements, focus behavior, and RmlUi Lua needed by that role.

Before authoring an override, inspect the exact built-in source exported by the installed CLI for that role:

```text
title          -> .noveltea/agent/system-layouts/ui/title/default-title.rml
                   .noveltea/agent/system-layouts/ui/title/default-title.rcss
game-hud       -> .noveltea/agent/system-layouts/ui/runtime/runtime_game.rml
                   .noveltea/agent/system-layouts/ui/runtime/runtime_game.rcss
command-builder -> .noveltea/agent/system-layouts/ui/runtime/command-builder.rml
                   .noveltea/agent/system-layouts/ui/runtime/command-builder.rcss
scene-text      -> .noveltea/agent/system-layouts/ui/runtime/scene-text.rml
                   .noveltea/agent/system-layouts/ui/runtime/scene-presentation.rcss
scene-choice    -> .noveltea/agent/system-layouts/ui/runtime/scene-choice.rml
                   .noveltea/agent/system-layouts/ui/runtime/scene-presentation.rcss
pause-menu     -> .noveltea/agent/system-layouts/ui/menu/pause-menu.rml
                   .noveltea/agent/system-layouts/ui/menu/pause-menu.rcss
save-menu      -> .noveltea/agent/system-layouts/ui/menu/save-menu.rml
load-menu      -> .noveltea/agent/system-layouts/ui/menu/load-menu.rml
settings-menu  -> .noveltea/agent/system-layouts/ui/menu/settings-menu.rml
text-log       -> .noveltea/agent/system-layouts/ui/menu/text-log.rml
modal          -> .noveltea/agent/system-layouts/ui/menu/modal.rml
```

The save/load/settings/text-log/modal documents share `.noveltea/agent/system-layouts/ui/menu/system-menu.rcss`. The Command Builder is gameplay-owned: runtime publishes its active occurrence, latest captured subject, and exact watched-reference snapshots, while the Layout owns transient Draft presentation/editing. Replacement Command Builder Layouts use the unique selected subject and Offer `slot_id` from the `noveltea` model plus the generic `Game.ui.begin_command_builder`, `set_command_builder_watch`, and complete `submit_command_builder` Lua transport; see `RMLUI_DATA_BINDING.md` and `LUA.md`. `debug-overlay` has no built-in source because it has no built-in fallback.

The generated `ui/` tree is copied byte-for-byte from the engine's shipped system UI assets. It is reference material under generated `.noveltea/` state, not project source: never edit it in place.

## Contextual Verb Menu and Inventory presentation

Verb Menu and ordinary Inventory presentation are contextual gameplay Layouts, not additional System Layout Roles. Project settings may choose `settings.interaction.defaultVerbMenuLayout` and `settings.inventory.defaultLayout`; each falls back to the corresponding built-in Layout when unset. `Present Inventory` may also supply an explicit Layout, which takes precedence over the Project default. `settings.inventory.playerInventory` designates the optional ordinary Project-owned Inventory used by Player Inventory operands/actions.

The Verb Menu is not the Command Builder. It presents resolved Verb Offers for one exact subject. A one-slot offer can complete directly; an offer that still needs bindings starts the separate Command Builder role.

Activation-triggered contextual Layouts may receive an immutable Trigger Context with pointer/source-bounds geometry. During a Layout event, use `Game.mount_context()` to transform that snapshot into the receiving Layout's logical coordinates and to access occurrence-safe contextual operations. `context:dismiss()` dismisses only the exact live occurrence; `context:present_child(...)` creates a child whose lifetime follows that exact parent occurrence; `context:present_child_inventory()` presents Player Inventory as a contextual child. Parent lifetime and captured activation geometry are intentionally separate, so source movement/disappearance does not invalidate the snapshot and parent dismissal still removes descendants.

Inventory UI rows represent exact Interactable Instance IDs with their quantity and presentation. Activating a row uses ordinary exact Interactable Primary Activate/Verb resolution. Do not create aggregate Item/Stack identities or infer gameplay identity from a row index.

When customizing a built-in, create or edit a tracked project Layout and assign that Layout to the role. Copy any RML/RCSS you want the project to own into tracked project source and update its URLs/dependencies accordingly. Keeping a documented `system|/...` reference means that resource remains engine-owned and can change when the installed NovelTea version changes.

For copied built-ins, read `.noveltea/agent/docs/RMLUI_DATA_BINDING.md`, `.noveltea/agent/docs/RMLUI_CUSTOM_COMPONENTS.md`, and `.noveltea/agent/docs/RMLUI_LUA.md` before changing their declarative or scripted behavior.
