# Layouts and RmlUi

For RML/RCSS syntax and the differences from browser HTML/CSS, read `.noveltea/agent/docs/RMLUI.md` first. This document covers NovelTea's Layout source and dependency rules.

Layouts use RmlUi RML/RCSS plus optional dedicated Lua. For file-mode Layout channels, edit the companion `layout.rml`, `layout.rcss`, or `layout.lua` file directly. Asset-mode and none-mode channels must not be replaced by companion files behind the workspace's back.

Use project asset/reference forms already present in the schemas and project docs. Validate after RML, RCSS, or Layout metadata changes so dependency and source diagnostics remain authoritative.
