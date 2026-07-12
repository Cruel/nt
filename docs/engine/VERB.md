# Verb Component

## Contract

A `VerbDefinition` describes an interaction verb with arity zero through two, ordered operand-role labels, action-text template, quick-action behavior, availability condition, and owned default `InteractionProgram`.

Verb is property-bearing and may `extends` another Verb. Declared custom properties use normal live property inheritance. Verb additionally has the only V1 behavioral inheritance rule.

## Behavioral inheritance

Availability conditions are evaluated root-to-child and all must pass. Default programs are attempted child-to-root:

- `Handled` stops successfully;
- `Unhandled` continues to the parent;
- `Failed` aborts without fallback.

Only after the root returns `Unhandled` does the project undefined-interaction fallback run. No program lists or structural fields merge, and editor categories/tags have no effect.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Verb record, optional same-type `extends`, typed properties, arity/roles, text template, availability, and default program.
- **Compiled:** linked `VerbDefinition`, retained parent edge/index, typed condition and program, and property assignments.
- **Mutable:** only property overrides and execution frames/results in `SessionState`; the definition is immutable.
- **Tooling only:** labels/notes not explicitly runtime-visible, categories, tags, colors, sort keys, and editor preview state.

## Current implementation scaffold

The current authoring project has a broad `verbs` collection and the legacy runtime uses numeric Verb entities and Action lookup. It does not implement this typed arity, program, or fallback contract. Those paths are migration scaffolding for Phases 3--7 and receive no compatibility guarantees.
