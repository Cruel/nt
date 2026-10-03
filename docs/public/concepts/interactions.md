---
title: Verbs and interactions
description: Subjects, named bindings, Offer discovery, Interaction resolution, fallback, and Command Builder lifecycle.
---

NovelTea resolves semantic commands independently of the input geometry used to select their subjects.
A **Verb** defines vocabulary and required named slots; an **Interaction Rule** supplies behavior for
a complete command. Offers help players discover Verbs from a starting subject.

## Subjects and selectors

Subjects are Characters, exact live Interactable Instances, and owner-qualified Features. Interactable
Definitions are reusable configuration and selector concepts, not live command subjects. A Feature
reference names its Room or exact Interactable Instance owner plus its local Feature ID. That Feature
must actually exist on the effective/live owner configuration; a bare Feature ID is insufficient.

Room subjects must be eligible in the active Room. Visible, enabled Inventory-held Interactable
Instances are also supported subjects, including for Command Builder capture. An Interactable Feature
follows its owner's eligibility, including Inventory eligibility; a Room Feature belongs to its
named Room and is eligible in that active Room context. A visual occurrence does not create another
subject or change Location. Liveness and availability are checked again at command submission.

**Subject Selectors** admit a finite union: any-subject, family, Trait, Interactable Definition,
reusable Interactable Feature, qualified identity pattern, or exact identity. Traits come from the
live effective configuration. Definition selectors use the Instance's immutable origin Definition;
reusable Feature selectors match that Definition's named Feature across its Instances. Qualified
patterns use one trailing `*` against `character:<id>`, `interactable:<instance-id>`,
`room:<room-id>#<feature-id>`, or `interactable:<instance-id>#<feature-id>`.
Runtime-created Instances participate in the same selector model.

## Named slots and binding order

Final command identity uses exact `{slotId, subject}` named bindings. Rule slot array position is not
semantic. Each rule and complete command binds every Verb slot exactly once. `bindingOrder` also
contains every slot once, but controls **progressive selection and presentation order**, not binding
identity. Localized text can reorder `{slot-id}` placeholders without changing the command.

The same live subject may bind multiple slots unless a Guard rejects that relationship. Slot
selector unions express admission; relationship restrictions belong in Guards, not array ordering.

## Discovery is not execution authority

Explicit Verb Offers own their starting-slot selectors. Rule-derived Offers reuse the selectors of
the rule's named starting slot. Both control **subject-first discovery/presentation**, not authority
to execute a complete command. `offer: null` opts a rule out of discovery only. No matching published
Offer, or a suppressed Offer, does not by itself forbid Verb-first/direct complete-command submission.

Rule Guards and Interaction priority affect execution, never Offer discovery. Offer Conditions are
independent pure discovery predicates: they may inspect the offered starting slot, not the other
unbound slots. Guards may inspect all bound slots. A successful direct `run-interaction` is therefore
not evidence that an Offer was discoverable, or that the rule supplying an Offer won execution.

## Offer specificity and primary activation

Discovery resolves independently for each Verb. Matching declarations are ordered structurally:

1. Exact subject identity.
2. Qualified identity pattern; longer prefixes are more specific.
3. Trait, Interactable Definition, or reusable Interactable Feature class.
4. Subject family.
5. `any-subject`.

Within equal specificity, lower authored rank wins; stable declaration identity resolves the
remaining per-Verb tie. Only the winning declaration's Offer Condition is evaluated. A false winning
condition **suppresses that Verb**; discovery does not fall back to a broader Offer. Published Offers
are ordered by rank and then stable Verb ID. Rank does not override structural specificity.

**Open Verb Menu** opens the ordinary resolved menu and never auto-selects a primary Offer.
**Primary Activate** executes a unique immediately-complete primary Offer. With no unique executable
primary, it opens the ordinary menu instead. Multiple primary candidates produce an ambiguity
diagnostic and leave the player at the menu; declaration order does not select a winner. The ordinary
pointer policy maps left-click/tap to Primary Activate and right-click to Open Verb Menu.

## Complete-command resolution

1. Validate the selected Verb's availability and complete named bindings, including live subject
   eligibility and each Verb slot's selector union.
2. Match Interaction Rules by Verb and named slot selectors.
3. Order matching rules by structural containment: a strictly narrower selector space precedes a
   broader space. Runtime context such as Current Room is not a hidden matching dimension; use a
   Condition when context matters.
4. Evaluate Guards in the current narrowest tier. A Guard error faults the command before behavior.
5. If no Guard in that tier passes, fall through to the next broader tier.
6. Among passing rules in one tier, the greatest `priority` wins.
7. Multiple passing rules at that winning priority are an ambiguity fault and execute nothing.

Priority is **tier-local**, not a global override: a broad high-priority rule cannot beat a passing
narrower tier. Declaration order is never an execution tie-break.

## Fallback and outcomes

Execute the selected rule's program. If no rule handles the command, try the selected Verb's
`defaultProgram`, then the optional Project `undefinedInteractionProgram`, then the engine's localized
undefined-interaction response (English: “Nothing happens.”). There is no parent-Verb traversal.
A selected rule returning Unhandled advances to the Verb default, not another rule.

- **Handled** ends the chain successfully.
- **Unhandled** permits fallback only for empty behavior, before any committed work or terminal
  handoff. It is not a way to undo work and try another rule.
- **Runtime failure** aborts without fallback; it is not an authored successful outcome.

Consecutive immediate mutations are atomic: a failing group commits none of its changes. Observable
or yielding commands (such as notification, Inventory presentation, or story calls) establish
boundaries. Failure after such a boundary does **not** rewind already committed gameplay state.

## Command Builder lifecycle

For example, a two-slot “Show {object} to {recipient}” Verb may have serialized slots in either order,
with `bindingOrder: ["object", "recipient"]`:

1. Open a subject's Verb Menu and choose its Show Offer. The Offer's starting slot is seeded with
   that subject. A one-slot Offer can submit immediately; a multi-slot Offer starts a Builder draft.
2. Focus the next unbound slot in `bindingOrder`. Starting from an Offer for `recipient` still seeds
   `recipient`; it does not reinterpret the subject as `object`.
3. While the Builder occurrence is active, semantic subject activation in the world or Inventory is
   capture input for the focused slot, not ordinary Primary activation. This also admits eligible
   owner-qualified Features.
4. Rebind a previously filled slot to focus it, then capture a replacement subject.
5. Submit the complete named bindings. They receive the same validation and resolution as a direct
   complete command. Previously captured subjects may have become unavailable in the meantime.
6. Cancel to discard the draft without executing it.

Drafts are transient, not save state. Stop/reset/load, Room or Flow ownership loss, Project replacement,
and accepted direct control commands can end the occurrence. Replacement Layouts own draft
presentation/repair but cannot fabricate capture authority. The Verb Menu and Command Builder are
separate replaceable Layout surfaces; exact built-in automation selectors belong in the Layout
technical reference, not in this semantic lifecycle.

## Conditions and gameplay commands are shared vocabulary

Pure recursive Conditions compose boolean logic and inspect admitted Properties, Traits, Location,
Inventory quantity, global state, or Lua predicates. Interaction programs use shared Gameplay Commands
for mutation, exact Instance movement/quantity operations, story calls, Inventory presentation, Lua,
and branches. These are not Interaction-private effect shapes.

## Hotspots select; they do not define behavior

A Hotspot owns pointer geometry, input ordering, highlight presentation, a Condition, and a semantic
target. It does not own a Verb or program. Multiple Hotspots can target one Feature; pointer, keyboard,
Inventory, and test inputs still identify the same subject. Activation geometry can anchor contextual
presentation without becoming command identity.

Use the generated Project schema reference for exact records, Conditions, and checked examples.
Use the authored-Test concept and agent authoring workflow for choosing semantic versus UI witnesses.
