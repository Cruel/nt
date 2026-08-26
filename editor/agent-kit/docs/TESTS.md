# Semantic Tests

Test records describe repeatable semantic player/runtime inputs. They run against the Project's normal compiled content and normal Project entrypoint; a Test does not define its own Scene/Room/Dialogue entrypoint or a parallel setup model.

Use Tests for behavior that can be stated in game terms: continue Dialogue, choose an authored branch, navigate through a particular Exit, select subjects, activate an Interaction, advance logical time, save, or load. Do not encode mouse coordinates, DOM selectors, button positions, or other UI gestures as gameplay tests.

## Stable identities

Playback identities are semantic authored IDs:

- Dialogue choices use the exact Dialogue Edge ID.
- Scene choices use the exact Scene Choice Option ID.
- Room navigation uses the exact Room Exit ID.
- Interaction subjects are Characters, Interactables, exact Item Stacks, or owner-qualified Features.
- Interaction commands use the exact Verb ID and named slot bindings.
- Save/load steps identify a save slot.

Never record a choice by list index or navigation by compass/direction ordinal. Labels and screen order are presentation and may change without changing the test's meaning.

## Supported step families

Current semantic steps are `tick`, `continue`, `dialogue-choice`, `scene-choice`, `navigate`, `select-subjects`, `primary-activate`, `open-verb-menu`, `clear-subject-selection`, `run-interaction`, `save`, and `load`.

`tick` advances logical time. Use it only when the authored behavior actually depends on time; do not add arbitrary frame ticks to imitate UI timing.

`primary-activate` requests the subject's ordinary primary action. `open-verb-menu` explicitly opens the subject's resolved Verb offers. `run-interaction` supplies a complete Verb command with named bindings and is appropriate when the test is about the command itself rather than subject-first discovery.

## What Tests do not contain

The current Test record has no Test-local init/check Lua, starting-inventory override, UI-click action, arbitrary save payload, or assertion DSL. Do not restore or invent those older shapes.

Verification comes from the playback report and public runtime observations/diagnostics. Keep authored Tests semantic and durable; if an invariant cannot be expressed through supported gameplay inputs, do not invent UI gestures, scripts, or private assertion mechanics to force it into a Test record.

## Authoring workflow

Use `noveltea entity create tests <id>` to obtain the current initialized shape, then consult `schemas/records/tests.schema.json` for exact payload fields. Keep step IDs stable and descriptive. Run `noveltea validate`, then use the installed CLI's test command for headless execution. Generated `.noveltea/build` output is disposable and must not be tracked.
