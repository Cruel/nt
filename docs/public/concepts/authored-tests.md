---
title: Authored Tests
description: Semantic playback tests that drive the normal Project through stable gameplay identities rather than UI coordinates.
---

An authored **Test** is a repeatable sequence of semantic player/runtime inputs against the Project's
normal compiled content and normal entrypoint. It is intended to remain meaningful when presentation
or editor UI changes.

## Tests use game identities, not screen positions

Test steps address stable semantic identities such as Dialogue choice edge IDs, Scene choice option
IDs, Room Exit IDs, exact Interaction subjects, Verb IDs with named slot bindings, and save slots.
Logical-time advancement is explicit when behavior genuinely depends on time.

This means a Test should say, in effect, "choose this authored branch" or "run this Verb with these
subjects," not "click the third button" or "click at these coordinates." Labels, list indexes, DOM
selectors, and pointer positions are presentation and are intentionally not the test contract.

## Tests do not define another game setup

A Test runs the Project's ordinary entrypoint and runtime content. It does not provide a private
Room/Scene/Dialogue entrypoint, an alternate starting inventory, arbitrary initialization Lua, or a
parallel state model. Setup that matters to game behavior belongs in ordinary authoring content or in
the supported semantic flow that the Test drives.

The current Test model is also not an arbitrary assertion DSL. Verification comes from the supported
playback report and public runtime observations/diagnostics. If a behavior cannot be exercised through
the admitted semantic inputs, do not encode private UI automation or implementation hooks merely to
force it into an authored Test.

Stable step IDs are useful because diagnostics, playback reports, and tooling can refer to the
authored action without depending on array position.

For the exact supported step families and payloads, use the generated Project schema reference. Test
execution commands and machine-readable report details are operational tooling guidance rather than
part of the Test concept itself.
