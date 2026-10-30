---
schema: '0.1'
type: event
id: event.find-cut-strap
title: Mara retrieves the cut strap
status: draft
decisions: []
participants: [character.mara]
arcs: [arc.stolen-warning, arc.earned-trust]
after: [event.bell-falls-silent]
prerequisites:
  any_of:
    - completed: [event.bell-falls-silent]
      not_completed: []
consequences:
  - Mara retrieves the discarded strap from the public service hatch.
  - A tangible basis for challenging Ivo's accusation becomes available.
steps: []
---
# Evidence outside the locked door

Mara reaches the service hatch from the quay, without entering the tower.
A strip of leather lies beneath it. Its clean edge contradicts Ivo's claim
that her careless repair simply wore through. Finding it provides evidence,
not permission and not automatic knowledge for Ivo. The tower-access Puzzle and
quay Authored Content provide the discovery, attempts, feedback and hints.
