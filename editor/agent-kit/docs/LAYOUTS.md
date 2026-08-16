# Layouts and RmlUi

For RML/RCSS syntax and the differences from browser HTML/CSS, read `.noveltea/agent/docs/RMLUI.md` first. For RML event Lua, `<script>`, or the dedicated Layout Lua source, read `.noveltea/agent/docs/RMLUI_LUA.md` together with `.noveltea/agent/docs/LUA.md`. This document covers NovelTea's Layout source and dependency rules.

Layouts use RmlUi RML/RCSS plus optional dedicated Lua. For file-mode Layout channels, edit the companion `layout.rml`, `layout.rcss`, or `layout.lua` file directly. Asset-mode and none-mode channels must not be replaced by companion files behind the workspace's back.

Use project asset/reference forms already present in the schemas and project docs. Validate after RML, RCSS, or Layout metadata changes so dependency and source diagnostics remain authoritative.

## System Layout overrides

Project settings can replace the engine UI Layout assigned to each system role through `settings.ui.systemLayouts`. The roles are:

```text
title
game-hud
pause-menu
save-menu
load-menu
settings-menu
text-log
modal
debug-overlay
```

Leaving `title`, `game-hud`, `pause-menu`, `save-menu`, `load-menu`, `settings-menu`, `text-log`, or `modal` unassigned uses the engine's built-in fallback. `debug-overlay` has no built-in fallback; assign a project Layout if the project needs one.

A system Layout override is a behavioral replacement, not just a visual skin. Preserve or deliberately replace the built-in data-model bindings, callbacks, custom elements, focus behavior, and RmlUi Lua needed by that role.

Before authoring an override, inspect the exact built-in source exported by the installed CLI:

```text
.noveltea/agent/system-layouts/manifest.json
.noveltea/agent/system-layouts/ui/
```

`manifest.json` maps each role to its built-in document, authored `system|/` URL, and supporting RCSS files. The `ui/` tree is copied byte-for-byte from the engine's shipped system UI assets during agent-kit generation. It is reference material under generated `.noveltea/` state, not project source: never edit it in place.

When customizing a built-in, create or edit a tracked project Layout and assign that Layout to the role. Copy any RML/RCSS you want the project to own into tracked project source and update its URLs/dependencies accordingly. Keeping a documented `system|/...` reference means that resource remains engine-owned and can change when the installed NovelTea version changes.

For copied built-ins, read `.noveltea/agent/docs/RMLUI_DATA_BINDING.md`, `.noveltea/agent/docs/RMLUI_CUSTOM_COMPONENTS.md`, and `.noveltea/agent/docs/RMLUI_LUA.md` before changing their declarative or scripted behavior.
