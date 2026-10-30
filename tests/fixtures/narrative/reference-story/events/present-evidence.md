---
schema: '0.1'
type: event
id: event.present-evidence
title: Ivo accepts the physical evidence
status: draft
decisions: []
participants: [character.mara, character.ivo]
arcs: [arc.stolen-warning, arc.earned-trust]
after: [event.find-cut-strap, event.inspection-permitted]
prerequisites:
  any_of:
    - completed: [event.find-cut-strap]
      not_completed: []
consequences:
  - Ivo recognizes the deliberate cut and permits a joint inspection.
  - Their dispute shifts from blame toward investigating interference.
steps:
  - id: admit
    branches:
      - id: cooperate
        conditions: []
        effects:
          - {kind: relationship, relationship: relationship.mara-ivo, value: wary}
---
# A cut, not a failure

Mara puts the strap on the quay between them. Ivo bends it against the light
and tests the edge with his thumb. He opens the tower, not because Mara has
won an argument about the wreck, but because someone has endangered the fleet.

If the direct appeal also occurs, it occurs before this presentation. It is
not a prerequisite: the evidence route works without the appeal. This partial
chronology deliberately does not order the appeal relative to finding the strap.
The quay Authored Content supplies the exchange's dialogue. This Event models
an occurrence in the fiction, not a NovelTea engine Scene operation.
