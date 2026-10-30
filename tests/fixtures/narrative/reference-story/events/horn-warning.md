---
schema: '0.1'
type: event
id: event.horn-warning
title: Mara warns the fleet from the quay
status: draft
decisions: []
participants: [character.mara, character.nessa]
arcs: [arc.stolen-warning, arc.earned-trust]
after: [event.question-ivo]
prerequisites:
  any_of:
    - completed: [event.question-ivo]
      not_completed: []
      conditions:
        - {kind: outcome, choice_point: choice-point.question-ivo, value: leave}
consequences:
  - The fleet turns back on hearing the emergency horn; the bell and the broken trust remain unrepaired.
steps: []
---
# A warning without reconciliation

Mara sets the recovered clapper on the harbor steps and takes the emergency horn from its public hook. Three long blasts: return to shelter. Nessa repeats the signal down the quay until the fleet answers. Above her, Ivo stands in a silent tower. She has saved the people who needed saving. She owes him no easy ending. If she read the logbook, she carries the signed order to the council herself; otherwise the older accusation remains unresolved.
