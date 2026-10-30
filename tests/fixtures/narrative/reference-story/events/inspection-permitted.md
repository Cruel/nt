---
schema: '0.1'
type: event
id: event.inspection-permitted
title: Ivo permits an inspection
status: draft
decisions: []
participants: [character.mara, character.ivo]
arcs: [arc.stolen-warning, arc.earned-trust]
after: [event.bell-falls-silent]
prerequisites:
  any_of:
    - completed: [event.bell-falls-silent]
      not_completed: []
consequences:
  - Mara receives permission to inspect the bell mechanism with Ivo present.
  - Ivo accepts a limited cooperation without withdrawing his earlier accusation.
steps:
  - id: admit
    branches:
      - id: cooperate
        conditions: []
        effects:
          - {kind: relationship, relationship: relationship.mara-ivo, value: wary}
---
# Ivo permits an inspection

After the silent test, Mara asks Ivo to look at the cut strap himself. She
does not ask him to trust her account of the old wreck. She asks what he will
tell the fleet if he keeps the only available repairer outside.

Ivo opens the door but keeps the key. The concession gives the investigation
room to begin. The silent test is both an earlier occurrence and a required
predecessor here; those are separately declared relationships. This direct
appeal is an alternative to finding and presenting physical evidence. The
next playable actions remain to be designed.
