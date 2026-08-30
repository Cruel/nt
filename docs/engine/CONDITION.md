# Conditions

Conditions are NovelTea's pure boolean gameplay expression contract. The same recursive Condition
shape is used by Room lifecycle/eligibility, Verb availability and Offers, Interaction Guards,
Dialogue and Scene condition sites, Maps, Hotspots, and other hosts that admit a Condition. Hosts
filter which dynamic operands are legal; they do not define private Condition languages.

## Boolean composition

Conditions compose recursively with `All`, `Any`, and `Not`. Evaluation short-circuits in authored
order. The existing unconditional `Always`, Global Property/Variable comparisons, and synchronous
Lua predicate escape hatch remain available. Conditions never mutate gameplay state.

Typed leaf predicates additionally support:

- identity Property comparison and Boolean truthiness;
- Trait presence or absence;
- Character or Interactable Location equality/inequality; and
- direct Inventory quantity comparison through the reusable conjunctive `InteractableMatcher`.

Inventory quantity observation is direct-membership only. It sums the quantity of every live
matching Interactable Instance in the selected exact Inventory, including runtime-created Instances,
without applying mutation compatibility-class restrictions.

## Shared typed operands

Conditions consume the shared gameplay operand vocabulary used by Gameplay Commands. Depending on
the host, operands may name an exact authored/runtime identity, an Interaction slot binding, an
earlier command-result binding, Current Room, an exact Inventory, an owner-local Inventory, Player
Inventory when configured, or an exact/unplaced/dynamic Location operand.

Interaction Guards receive all bound rule slots. An Offer Condition receives only its offered
starting slot. Command-program Conditions may receive earlier result bindings once that program has
produced them. Hosts that do not own those contexts reject such operands during authoring and
compiled-project validation; runtime resolution also fails closed if a stale or mistyped dynamic
operand reaches execution.

Player Inventory is a typed operand for the Project's single canonical Inventory, not a hidden or
separately selected container.

## Validation and preview

Authoring, compiled-project validation, and runtime evaluation all enforce reference and operand
scope. Property comparison values/operators are checked against Property declarations where the
owner is statically knowable, while runtime-bound owners are checked when resolved.

Focused Room preview preserves recursive boolean structure. Leaves that require live runtime-bound
identity, Trait, Property, Location, or Inventory state report that full Play preview is required
rather than approximating an incorrect result.
