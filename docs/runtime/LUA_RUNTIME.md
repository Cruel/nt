# Lua Runtime

## Purpose

Define the Lua-only scripting runtime contract for NovelTea.

## Current Direction

Lua is the only runtime scripting target. Imported script text is treated as Lua. Invalid script text should fail as Lua and surface diagnostics to runtime/editor users.

JavaScript, Duktape, dukglue, embedded JS engines, and JS compatibility shims are not runtime goals.
