# Verb Component

## Contract

A `VerbDefinition` describes immutable interaction vocabulary through stable required named subject slots. Each slot has a stable ID, localized label, localized prompt, and a finite union of `SubjectSelector` variants. The Verb also stores one locale-independent `bindingOrder`, action text, a completed-command text template, zero or more explicit `VerbOffer` declarations, availability, and one owned default `InteractionProgram`.

Numeric arity and positional operand-role contracts are not part of the current authoring, compiled, runtime, preview, Lua, or test path. The number of required subjects is the number of declared slots, and binding identity is always the slot ID rather than an array position.

Completed-command templates use named placeholders such as `Show {object} to {recipient}`. Placeholder names must be stable Verb slot IDs. Inline templates are validated directly; localized templates are validated against authored localization catalog values. Locale changes may reorder words freely without changing slot identity or `bindingOrder`.

Verbs do not bind to Hotspots. Hotspots resolve pointer geometry to semantic subjects or Room Exits; when a Verb is invoked, its slot and selector rules apply regardless of how subjects were selected. Verb availability is checked by the canonical Interaction invocation path, not by a Hotspot-specific activation transaction.

Verb is immutable interaction vocabulary, not a stateful Property or Trait owner. Slots, selectors, binding order, text, Offers, availability, and programs are compiled definition data rather than mutable gameplay identity state.

## Subject Selectors

`SubjectSelector` is shared authoring, compiled-wire, and runtime vocabulary. A slot contains one or more selectors; the selector list is a finite union and a subject is admitted when any selector matches.

Supported selectors are:

- `any-subject` — any admitted Character, Interactable, Feature, or Item Stack;
- `family` — one exact subject family;
- `trait` — any live subject whose effective runtime configuration provides the referenced Trait;
- `item-definition` — an Item Stack whose live definition is the referenced Item Definition;
- `qualified-pattern` — a family plus a stable qualified-identity prefix pattern with exactly one trailing `*`;
- `exact` — one exact semantic subject identity.

Qualified identity matching uses a family-qualified stable identity: `character:<id>`, `interactable:<id>`, `item-stack:<id>`, `room:<room-id>#<feature-id>`, or `interactable:<owner-id>#<feature-id>`. It is based on live semantic identity, not Archetype provenance. Runtime-created subjects therefore match the same family, Trait, Item Definition, qualified-pattern, and exact-identity selectors as declared subjects when their live effective configuration and identity satisfy the selector.

## Verb Offers and subject-first discovery

A `VerbOffer` says that a Verb is discoverable from one semantic subject. An explicit Offer owns a stable Offer ID, one starting `slotId`, one or more Subject Selectors for that starting subject, an optional pure Offer Condition, an authored integer rank, and a `primary` flag. An Interaction Rule may also opt in to a rule-derived Offer; its starting-slot selectors come from the named rule slot while its Offer declaration supplies the optional condition, rank, and primary intent. Rules with `offer: null` do not participate in discovery.

Discovery is resolved independently for each Verb. For the selected subject, runtime gathers matching explicit and rule-derived Offers and gives control to the most-specific matching declaration: exact identity, then qualified identity pattern, then Trait or Item Definition, then subject family, then `any-subject`. Longer qualified prefixes are more specific than shorter prefixes. Within equal specificity, authored rank is deterministic and stable declaration identity breaks the remaining per-Verb tie.

Only the winning declaration's Offer Condition is evaluated. If that most-specific condition is false, the Verb is suppressed; runtime does not fall back to a broader Offer. Interaction Rule context and Interaction Guards are execution concerns and are never reused as discovery conditions.

Published Offers are ordered by authored rank and then stable Verb ID. Absence of an Offer means only “not discoverable from this subject”; it does not prohibit Verb-first UX or direct submission of a complete command.

`Primary Activate` and `Open Verb Menu` are distinct semantic runtime requests. Open Verb Menu publishes the ordinary resolved Offer menu and never auto-selects the primary Offer. Primary Activate executes a unique immediately-complete primary Offer; if there is no unique executable primary Offer, runtime opens the ordinary menu instead. Multiple primary Offers produce a typed ambiguity observation rather than being resolved by declaration order.

## Binding order and exact command bindings

`bindingOrder` contains every Verb slot exactly once. It is the locale-neutral order used by selection-oriented UIs and test/editor conveniences when progressively filling a command. Final command submission is not positional: it carries exact `{slotId, subject}` bindings.

The same exact live subject may bind multiple slots in one command. #83 does not impose subject-distinctness. A later Guard contract may reject relationships such as `{first} == {second}`, but binding itself remains valid and exact.

## Availability and default fallback

Each Verb owns exactly one availability condition and one default `InteractionProgram`. Runtime evaluates only the selected Verb's availability. If no Interaction rule handles the invocation, or a selected rule completes with `Unhandled`, runtime attempts that same Verb's default program once:

- `Handled` stops successfully;
- `Unhandled` continues to the project undefined-interaction fallback;
- `Failed` aborts without fallback.

`Handled` and `Unhandled` are explicit successful outcomes on the authored default Interaction Program. `Failed` is produced only by runtime execution failure. There is no parent-Verb traversal and no inherited availability.

Runtime controls expose the stable `bindingOrder`, resolved action text, and local availability as typed data. Subject-first discovery is published separately as resolved `VerbOfferView` values so direct complete-command submission remains independent. If a complete command has no handled Interaction Rule, fallback proceeds through that Verb's default program, the optional Project undefined-Interaction behavior, and finally the engine's localized undefined-Interaction response.

## Authoring, compiled, and state disposition

- **Current authoring schema:** collection-specific Verb record with named slots, selector unions, `bindingOrder`, localized slot label/prompt text, completed-command template, explicit Offers, availability, and default program. #84 adds Offers without changing the already-selected authoring schema version.
- **Compiled V4:** linked immutable `VerbDefinition` with the same named-slot/selector vocabulary, typed Offers and Offer Conditions, availability condition, and typed default program. #84 does not change compiled schema version 4.
- **Mutable:** only interaction execution frames/results in `SessionState`; the Verb definition itself has no Property/Trait state.
- **Tooling only:** labels/notes not explicitly runtime-visible, categories, tags, colors, sort keys, and editor preview state.

## Current authoring implementation

The editor authors slots, slot selector unions, stable binding order, action text, completed-command text, explicit Offers, availability, and the closed default Interaction Program. Validation rejects duplicate slot or Offer IDs, Offers that name missing slots, incomplete or duplicate binding-order entries, malformed selector contracts, invalid selector references, invalid named placeholders, duplicate instruction IDs, and invalid program references.

The compiler lowers each slot, selector, and Offer without collapsing them to positional roles. Native decoding is strict about the current fields and selector variants. Runtime invocation, preview, Lua direct interaction submission, authored tests, and recorded-test playback submit exact named bindings, while preview/default UI also expose semantic Primary Activate and Open Verb Menu requests.
