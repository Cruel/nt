# Architecture

## Purpose

Describe the current NovelTea runtime architecture at a durable, implementation-facing level.

## Scope

This document should cover the backend-neutral core boundary, platform/render/UI/script layering, data flow between runtime controllers and RmlUi, and ownership rules for assets, rendering resources, scripting state, and editor preview sessions.

Keep backend-neutral core free of SDL3, bgfx, RmlUi, ImGui, Lua, Electron, Android, Emscripten, SFML, and Qt types.
