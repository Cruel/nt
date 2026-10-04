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

This means a Test should normally say, in effect, "choose this authored branch" or "run this Verb with
these subjects," not "click the third button" or "click at these coordinates." Labels and list indexes
are not stable Test identities. The one admitted UI seam is `ui-click`: it names a visible RuntimeUI
document plus an authored selector and dispatches normal RmlUi pointer input. Prefer stable element IDs
or explicit test-oriented attributes for that selector; coordinate clicks are not the current contract.

The current typed step families are: logical-time `tick`, `continue`, Dialogue and Scene choice,
Room `navigate`, subject selection/primary activation/Verb-menu opening/selection clearing,
`run-interaction`, save/load, and `ui-click`. Only the payload selected by a step's input kind is active;
disabled steps remain authored but are omitted from playback. Save/load steps use exactly `autosave` or
`slot-N` (for example `slot-3`) as their authored `slotId`; bare numbers and runtime transport names
such as `manual-3` are not authored save-slot identities.

Every enabled input step ends at an engine-owned settled semantic boundary. Playback performs a
zero-duration runtime drain after the authored input before it accepts the next authored input or
evaluates that step's expectations. Authors must not insert `tick` merely to make a resumed Dialogue,
Scene continuation, transaction sequence, or other deterministic zero-time work become ready. Use
`tick` only when the behavior itself depends on advancing logical game time; a zero-duration settle is
playback machinery, not an authored timing convention.

## Tests do not define another game setup

A Test runs the Project's ordinary entrypoint and runtime content. It does not provide a private
Room/Scene/Dialogue entrypoint, an alternate starting inventory, arbitrary initialization Lua, or a
parallel state model. Setup that matters to game behavior belongs in ordinary authoring content or in
the supported semantic flow that the Test drives. Test records themselves are tooling-only: runtime
compilation excludes them, and Test playback lowers them separately into the Runtime Test Catalog. An
invalid Test can therefore be blocked without making otherwise valid game content unplayable.

The current Test model is also not an arbitrary assertion DSL. Verification comes from the supported
playback report and public runtime observations/diagnostics. If a behavior cannot be exercised through
the admitted semantic inputs, do not encode private UI automation or implementation hooks merely to
force it into an authored Test.

Each enabled step may carry typed semantic expectations, and a Test may also carry
`finalExpectations`. The supported expectation families cover Properties, current Room,
Character/Interactable Location, Interactable quantity, Trait presence, enabled/visible entity state,
active Scene/Dialogue identity, mounted Layout presence/state, notification/save outcomes, and
diagnostic codes. Operators are intentionally closed to equality/inequality, presence/absence, and
numeric comparisons where the target admits them. Expectations observe settled authoritative runtime
state; they do not execute arbitrary assertion Lua or inspect private RuntimeSession state.

Stable step IDs are useful because diagnostics, playback reports, and tooling can refer to the
authored action without depending on array position.

For the exact supported step families and payloads, use the generated Project schema reference. Test
execution commands and machine-readable report details are operational tooling guidance rather than
part of the Test concept itself.
