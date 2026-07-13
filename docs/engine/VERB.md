# Verb Component

## Contract

A `VerbDefinition` describes an interaction verb with arity zero through two, ordered operand-role labels, action-text template, quick-action behavior, availability condition, and owned default `InteractionProgram`.

Verb is property-bearing and may `extends` another Verb. Declared custom properties use normal live property inheritance. Verb additionally has the only V1 behavioral inheritance rule.

## Behavioral inheritance

Availability conditions are evaluated root-to-child and all must pass. Default programs are attempted child-to-root:

- `Handled` stops successfully;
- `Unhandled` continues to the parent;
- `Failed` aborts without fallback.

`Handled` and `Unhandled` are explicit successful outcomes on the authored default Interaction Program. `Failed` is produced only by runtime execution failure.

Only after the root returns `Unhandled` does the project undefined-interaction fallback run. No program lists or structural fields merge, and editor categories/tags have no effect.

Phase 7E evaluates availability root-to-child and executes default programs child-to-root. Runtime
controls expose arity, resolved action text, inherited availability, and `quickAction` as typed data.
The current V1 fallback is the deterministic typed `Nothing happens.` notification; adding an
authorable project-level fallback would require an explicit future wire revision rather than a
generic JSON escape hatch.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Verb record, optional same-type `extends`, typed properties, arity/roles, text template, availability, and default program.
- **Compiled:** linked `VerbDefinition`, retained parent edge/index, typed condition and program, and property assignments.
- **Mutable:** only property overrides and execution frames/results in `SessionState`; the definition is immutable.
- **Tooling only:** labels/notes not explicitly runtime-visible, categories, tags, colors, sort keys, and editor preview state.

## Current authoring implementation

Phase 3E implements the strict V2 Verb schema and editor creation/detail path. A Verb records arity,
ordered role labels, action text, quick-action state, availability, and a closed default Interaction
Program whose instructions carry stable nested IDs. Validation rejects role-count/arity mismatches,
duplicate instruction IDs, and invalid program references. Phase 4E lowers each Verb's own
availability condition and default program while retaining the `extends` edge; this preserves the
root-to-child availability and child-to-root fallback order without flattening structural data. The
runtime export adapter still emits only its documented shallow transitional representation; Verb
fallback execution remains Phase 6--7 work.
