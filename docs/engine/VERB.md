# Verb Component

## Contract

A `VerbDefinition` describes an interaction verb with arity zero through two, ordered operand-role labels, action-text template, quick-action behavior, availability condition, and owned default `InteractionProgram`.

Room Verb hotspots bind only zero-arity Verbs. Interactable hotspots bind only one-arity Verbs and use
their owner as the operand. Availability is resolved into immutable hotspot presentation eligibility,
then checked again by the canonical runtime activation transaction before execution.

Verb is property-bearing and may attach supported Traits backed by ordinary Properties. Traits do not merge availability, programs, arity, text, or any other Verb structure.

## Availability and default fallback

Each Verb owns exactly one availability condition and one default `InteractionProgram`. Runtime evaluates only the selected Verb's availability. If no Interaction rule handles the invocation, or a selected rule completes with `Unhandled`, runtime attempts that same Verb's default program once:

- `Handled` stops successfully;
- `Unhandled` continues to the project undefined-interaction fallback;
- `Failed` aborts without fallback.

`Handled` and `Unhandled` are explicit successful outcomes on the authored default Interaction Program. `Failed` is produced only by runtime execution failure. There is no parent-Verb traversal and no inherited availability.

Runtime controls expose arity, resolved action text, local availability, and `quickAction` as typed data. The current V1 undefined-interaction fallback is the deterministic typed `Nothing happens.` notification; adding an authorable project-level fallback would require an explicit future wire revision rather than a generic JSON escape hatch.

## Authoring, compiled, and state disposition

- **Authoring version 3:** collection-specific Verb record with Trait attachments, typed properties, arity/roles, text template, availability, and default program.
- **Compiled:** linked `VerbDefinition` with retained Trait IDs, typed condition/program, and property assignments.
- **Mutable:** only property overrides and execution frames/results in `SessionState`; the definition is immutable.
- **Tooling only:** labels/notes not explicitly runtime-visible, categories, tags, colors, sort keys, and editor preview state.

## Current authoring implementation

The editor implements the strict current Verb schema and creation/detail path. A Verb records arity,
ordered role labels, action text, quick-action state, availability, and a closed default Interaction
Program whose instructions carry stable nested IDs. Validation rejects role-count/arity mismatches,
duplicate instruction IDs, invalid Trait attachments, and invalid program references. The compiler lowers each Verb's own availability condition, default program, Trait IDs, and property assignments. `runtime::RuntimeExecutor` performs the local default/undefined-interaction fallback described above; no runtime export adapter exists.
