---
title: Verbs and interactions
description: Semantic subjects, Verb slots, selectors, Interaction Rules, Offers, Conditions, and the separation between selection and behavior.
---

NovelTea models interaction as semantic command resolution. Input first identifies semantic subjects;
the interaction system then resolves authored **Verbs** and **Interaction Rules** that apply to those
subjects. Pointer geometry is only one way to select the same subjects.

## Subjects and selectors

Interaction subjects are Characters, exact live Interactable Instances, and owner-qualified
Features. The exact identity matters: an Interactable Definition is reusable configuration, while an
Interactable Instance is the subject that can participate in a live command.

**Subject Selectors** describe what a Verb slot or Interaction Rule accepts. Selectors can match broad
subject families, Traits, Interactable Definitions, qualified identity patterns, or exact subjects.
Selector unions describe admission; relationship restrictions between already-bound subjects belong
in guards/Conditions rather than in presentation or slot ordering.

## Verbs define command vocabulary

A **Verb** defines a stable command identity and its required named subject slots. Slot IDs and the
Verb's binding order are semantic; localized labels or command wording can change or reorder visible
text without changing which subject fills which role.

The named-slot model lets one Verb express commands such as using an object on a target or showing an
object to a Character without relying on positional array meaning. A completed command binds exact
live subjects to those stable slot IDs.

## Interaction Rules define applicability and behavior

An **Interaction Rule** associates a Verb with selector unions for its named slots, semantic context,
a guard, priority, optional offer metadata, and a program. The program uses the shared gameplay
command vocabulary and has an explicit completion/outcome.

Optional **Offer** metadata controls how an applicable rule is exposed for subject-first discovery,
including the offered slot, availability condition, rank, and primary-action status. Runtime resolved
offers are a view of authored interaction behavior for the current state; they are not independent
gameplay records or identities.

The same interaction can therefore be reached through different input surfaces—Room selection,
Inventory activation, a Verb menu, a command builder, or a direct semantic test—without changing the
underlying command identity.

## Conditions and gameplay commands are shared vocabulary

Interactions reuse the same recursive **Condition** model used by other authoring domains. Conditions
can compose boolean logic and inspect admitted semantic state such as Properties, Traits, Location,
Inventory quantity, global state, or supported Lua predicates.

Interaction programs likewise use the shared gameplay-command vocabulary for state mutation, exact
Interactable movement/quantity operations, story calls, UI presentation such as Inventory, Lua, and
conditional branches. These commands are not Interaction-private effect shapes; Scenes, Dialogue
effects, and Room lifecycle behavior reuse the same semantics where their host admits them.

## Hotspots select; they do not define behavior

A Hotspot owns pointer geometry, input ordering, highlight presentation, a Condition, and a semantic
target. It does not own a Verb or Interaction program. Multiple Hotspots may select the same Feature,
and keyboard/controller/UI paths can select that same Feature without touching Hotspot geometry.

This separation keeps behavior stable when presentation changes. If a meaningful sub-part needs its
own Traits, Properties, or interaction identity, model it as a Feature and let one or more Hotspots
target it.

For exact Verb slot forms, selector variants, Offer fields, Interaction Rule structure, Conditions,
and gameplay commands, use the generated Project schema reference.
