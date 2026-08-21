# Verb Component

## Contract

A `VerbDefinition` describes an interaction verb with arity zero through two, ordered operand-role labels, action-text template, quick-action behavior, availability condition, and owned default `InteractionProgram`.

Verbs do not bind to Hotspots. Hotspots resolve pointer geometry to semantic subjects or Room Exits;
when a Verb is invoked, its normal arity and subject matching rules apply regardless of how those
subjects were selected. Verb availability is checked by the canonical Interaction invocation path,
not by a Hotspot-specific activation transaction.

Verb is immutable interaction vocabulary, not a stateful Property or Trait owner. Availability, programs, arity, text, and quick-action policy are compiled definition data rather than mutable gameplay identity state.

## Availability and default fallback

Each Verb owns exactly one availability condition and one default `InteractionProgram`. Runtime evaluates only the selected Verb's availability. If no Interaction rule handles the invocation, or a selected rule completes with `Unhandled`, runtime attempts that same Verb's default program once:

- `Handled` stops successfully;
- `Unhandled` continues to the project undefined-interaction fallback;
- `Failed` aborts without fallback.

`Handled` and `Unhandled` are explicit successful outcomes on the authored default Interaction Program. `Failed` is produced only by runtime execution failure. There is no parent-Verb traversal and no inherited availability.

Runtime controls expose arity, resolved action text, local availability, and `quickAction` as typed data. The current V1 undefined-interaction fallback is the deterministic typed `Nothing happens.` notification; adding an authorable project-level fallback would require an explicit future wire revision rather than a generic JSON escape hatch.

## Authoring, compiled, and state disposition

- **Authoring version 3:** collection-specific Verb record with arity/roles, text template, availability, and default program.
- **Compiled:** linked immutable `VerbDefinition` with typed condition/program.
- **Mutable:** only interaction execution frames/results in `SessionState`; the Verb definition itself has no Property/Trait state.
- **Tooling only:** labels/notes not explicitly runtime-visible, categories, tags, colors, sort keys, and editor preview state.

## Current authoring implementation

The editor implements the strict current Verb schema and creation/detail path. A Verb records arity,
ordered role labels, action text, quick-action state, availability, and a closed default Interaction
Program whose instructions carry stable nested IDs. Validation rejects role-count/arity mismatches,
duplicate instruction IDs and invalid program references. The compiler lowers each Verb's own availability condition and default program. `runtime::RuntimeExecutor` performs the local default/undefined-interaction fallback described above; no runtime export adapter exists.
