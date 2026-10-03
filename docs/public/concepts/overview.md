---
title: Authoring model overview
description: The major NovelTea authoring concepts and the boundaries between model, state, presentation, and behavior.
---

NovelTea separates durable game meaning from its presentation and from the mutable state of one
playthrough. Keeping those layers distinct is the main key to choosing the right authoring concept.

## The model in one pass

- A **Project** owns game-wide settings, startup, localization policy, reusable records, and the
  declared identities that exist when a playthrough starts.
- **Rooms** describe explorable places and their navigation topology. **Maps** present that Room
  topology; they do not define a second navigation graph.
- **Characters** are persistent semantic people or actors. Their visual occurrences in Rooms,
  Dialogues, and Scenes do not create new Character identities.
- **Interactable Definitions** describe reusable object kinds. **Interactable Instances** are exact
  gameplay identities with Location, quantity, enabled/visible state, Traits, and Properties.
- **Inventories** are owner-local containers. Membership comes from an exact Interactable Instance's
  Location rather than from a second inventory-row identity.
- **Traits** describe reusable Property-backed capabilities. **Properties** hold typed semantic state
  on their owning identity. **Archetypes** reuse larger same-kind structural configuration.
- **Verbs** define command vocabulary and required subject roles. **Interaction Rules** decide when
  those commands apply and what they do. Runtime **Offers** expose currently available authored
  interactions without becoming a separate gameplay identity.
- **Dialogues** own conversation graphs. **Scenes** own ordered story/presentation orchestration.
- **Layouts** own authored runtime UI presentation. **Materials** own reusable rendering appearance;
  neither should be used as a substitute for gameplay state.
- **Localization** preserves semantic Message and Asset identity across locales rather than creating
  locale-specific gameplay objects.
- **Authored Tests** drive the normal game through stable semantic inputs. They are not UI automation
  scripts or a parallel game setup format.

## Authored model, runtime state, and presentation

Project source declares definitions, relationships, initial state, and programs. During play, mutable
state such as Properties, Locations, quantities, current Room, and story progress evolves in the
runtime session. Runtime changes do not rewrite the authored Project.

Presentation is a third concern. A Character can be staged in a Dialogue without changing its world
Location. A Scene can visually stage a Room without entering it. A Room occurrence can present an
exact Interactable Instance at Room-local geometry without owning that Instance's Location or other
state. A Layout can render projected state without becoming the authority for it.

When a distinction is unclear, ask which identity should survive presentation changes and which
object owns the mutable gameplay value. That usually identifies the correct authoring boundary.

## Stable identity and exact structure

Authoring references use stable semantic IDs. Collection identity, nested owner-local identity, and
exact live Instance identity are intentionally distinct; labels and screen order are presentation and
must not be treated as identity.

These concept documents describe meaning and composition, not every serialized field. Use the
generated Project schema reference for the exact current record shapes, variants, defaults,
constraints, semantic annotations, and checked examples.
