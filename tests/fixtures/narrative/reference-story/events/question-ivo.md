---
schema: '0.1'
type: event
id: event.question-ivo
title: Mara decides whether to ask Ivo for the truth
status: draft
decisions: []
participants: [character.mara, character.ivo]
arcs: [arc.stolen-warning, arc.earned-trust]
after: [event.lift-clapper, event.drain-well, event.read-logbook]
prerequisites:
  any_of:
    - completed: [event.lift-clapper]
      not_completed: []
    - completed: [event.drain-well]
      not_completed: []
consequences:
  - Asking brings a confession and the possibility of shared repair; leaving preserves distance.
steps:
  - id: question
    branches:
      - id: ask
        conditions: []
        effects:
          - {kind: outcome, choice_point: choice-point.question-ivo, value: ask}
          - {kind: knowledge, character: character.mara, fact: fact.hidden-clapper, value: knows}
          - {kind: revealed, revelation: revelation.ivos-secret, value: true}
          - {kind: relationship, relationship: relationship.mara-ivo, value: trusting}
      - id: leave
        conditions: []
        effects:
          - {kind: outcome, choice_point: choice-point.question-ivo, value: leave}
          - {kind: relationship, relationship: relationship.mara-ivo, value: estranged}
  - id: answer
    branches:
      - id: confession-heard
        conditions:
          - {kind: knowledge, character: character.mara, fact: fact.hidden-clapper, value: knows}
        effects: []
      - id: no-answer
        conditions:
          - {kind: knowledge, character: character.mara, fact: fact.hidden-clapper, value: unknown}
        effects: []
---
# A question inside the Event

At entry Mara has recovered the clapper, not necessarily learned who hid it. The question step is the consequential Choice Point. In ask, Ivo admits his act and Mara learns it as the player hears it; their Relationship changes here, before the answer step. In leave, neither Mara nor the player receives that Revelation. Ivo's presence alone discloses nothing.

The answer step must use the appropriate text in the linked tower Authored Content. The optional logbook changes a separate line; it must never be treated as guaranteed knowledge. This is a compact dramatic exchange, not a NovelTea engine conversation graph.
