# Lua Source

Lua is the only runtime scripting language. Only explicitly owned Script Module or Layout Lua sources participate; the presence of an arbitrary `.lua` file does not make it executable. Keep source files under their declared ownership and validate after changes. OS, IO, debug, package loading, `require`, `dofile`, and `loadfile` are not part of the normal authored runtime sandbox.

Current public runtime surfaces include `noveltea.random.seed/integer/number`, `noveltea.map.present/hide/select/activate/state`, `noveltea.layouts.get/set/clear/mount/unmount/mounted`, `noveltea.presentation` background/actor/prop/environment operations, `Game.pause/resume/paused`, transient and desired-state `audio.*` operations, and `noveltea.text_log.append/clear`. Gameplay Layout handlers use `Game.ui.*`; shell documents use `Game.shell.*`. Mutation calls return `ok, error`; query calls return `value, error` and use stable project IDs rather than filesystem paths.

Do not invent additional future `Game.*` APIs or rewrite lexical occurrences as semantic references. The CLI rewrites source only when the current recognizer can prove an exact rewriteable reference; possible lexical evidence is reported separately.
