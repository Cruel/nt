---
schema: '0.1'
type: milestone
id: milestone.accept-investigation
title: The investigation becomes possible
status: draft
decisions:
  - id: permission-threshold
    statement: The investigation begins through permission rather than trespass.
    origin: agent
    authority: delegated
change: Ivo permits Mara to investigate the missing clapper rather than locking her out.
arcs: [arc.stolen-warning, arc.earned-trust]
fulfillment:
  any_of:
    - [event.inspection-permitted]
    - [event.find-cut-strap, event.present-evidence]
---
# The investigation becomes possible

The opening threshold is permission to act, not a solved mystery or restored
friendship. This Milestone affects both Arcs and belongs to neither. Mara can
win permission through a direct appeal, or combine finding the discarded strap
with presenting it to Ivo. Finding evidence alone does not open the tower.
These routes need not be exclusive; either is sufficient.
