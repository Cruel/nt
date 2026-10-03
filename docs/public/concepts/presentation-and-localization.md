---
title: Layouts, materials, and localization
description: Runtime UI, reusable rendering appearance, Assets, and the identity model used for localized text and media.
---

Presentation is authored separately from gameplay authority. **Layouts** present runtime UI and
projected game state, **Materials** describe reusable rendering appearance, and **Localization**
changes language/media realization while preserving semantic identity.

## Layouts present projected state

A **Layout** is an authored RmlUi document with RML/RCSS and optional Lua, plus NovelTea metadata about
its source, dependencies, state, and intended use. Layouts can be used by gameplay content or assigned
to engine-defined system UI roles.

The runtime projects semantic game state into Layout-facing models and callbacks. A Layout can hold
declared local state and can present contextual child UI, but arbitrary DOM/component state is not
automatically gameplay or save state. When Layout interaction should change the game, it goes through
the admitted semantic action boundary rather than mutating the projected model as if it were the
authority.

System Layout replacements are behavioral UI replacements, not merely skins: an override is
responsible for the bindings, focus/input behavior, custom components, and callbacks needed by that
role. Exact built-in source and RmlUi/RCSS behavior are technical reference material rather than part
of this concept layer.

## Assets, shaders, and Materials have different identities

An **Asset** is imported media/resource identity such as an image, audio file, video, or font. An
Asset does not become a Room Prop or Interactable merely because it can be rendered.

A **Material** is reusable semantic rendering appearance rooted in an engine Material Preset or
another Material. Gameplay/presentation records apply Materials and may supply the admitted parameter
or texture overrides for that occurrence. Material state controls appearance, not semantic object
identity or gameplay Properties.

Project-owned shader code is source used by Materials; it is not itself an Asset or gameplay object.
The selected Material role defines renderer-owned inputs and pipeline expectations. Use the generated
reference and shader/material technical documentation when exact roles, parameters, sampler rules, or
output conventions matter.

## Localization preserves semantic identity

NovelTea localization is based on stable **Message** identity rather than on matching source prose.
Player-facing structured text can derive identity from its semantic owner/field, while explicitly
named Messages provide reusable identities. Managed free-form Lua/RML occurrences also receive durable
Message identity without inserting tracking IDs into authored source text.

The Project declares one Source locale, a supported/default locale policy, and optional parent-locale
inheritance. Target translations are sparse: absence means no target at that locale, and inheritance
can provide an effective parent target. Translation freshness/review/provenance metadata describes the
target work without changing the underlying Message identity.

Localized media follows the same principle. A semantic base Asset can have sparse locale-specific
realizations, but gameplay and presentation continue to reference the base Asset identity. Locale
selection chooses the physical realization; it does not create a locale-specific gameplay reference.

Engine-owned player text uses a reserved Message namespace with built-in source/target values. Project
content may override defined system Messages through the same localization model, but does not create
unrelated Project-owned identities inside that reserved namespace.

For exact Layout source modes/state declarations, Material records/applications, localization policy,
Message/target records, and localized Asset mappings, use the generated Project schema reference.
