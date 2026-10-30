---
schema: '0.1'
type: event
id: event.bell-restored
title: Mara and Ivo ring the repaired bell
status: draft
decisions: []
participants: [character.mara, character.ivo]
arcs: [arc.stolen-warning, arc.earned-trust]
after: [event.question-ivo]
prerequisites:
  any_of:
    - completed: [event.question-ivo]
      not_completed: []
      conditions:
        - {kind: outcome, choice_point: choice-point.question-ivo, value: ask}
consequences:
  - The fleet turns back on hearing the bell; Ivo agrees to correct the public record.
steps: []
---
# The shared warning

Ivo brings the spare retaining pin from his coat. Mara fits it without taking his offered hand; then she gives him the rope's other end. Their first pull is ragged. The second carries over the breakwater. One sail turns, then another. Ivo says he will speak to the harbor council in the morning. Mara answers that she will be there to hear him, not to speak for him. Repair has begun, not erased the harm.
