---
schema: '0.1'
type: event
id: event.read-logbook
title: Mara reads the previous sailing order
status: draft
decisions: []
participants: [character.mara]
arcs: [arc.earned-trust]
after: [event.inspection-permitted, event.present-evidence]
prerequisites:
  any_of:
    - completed: [event.inspection-permitted]
      not_completed: [event.question-ivo]
    - completed: [event.present-evidence]
      not_completed: [event.question-ivo]
consequences:
  - Mara learns that the wreck report blamed her unjustly; the player sees the signed order.
steps:
  - id: read-order
    branches:
      - id: inspect
        conditions: []
        effects:
          - {kind: knowledge, character: character.mara, fact: fact.false-report, value: knows}
          - {kind: revealed, revelation: revelation.cleared-name, value: true}
---
# An optional older truth

The logbook lies open beside the service diagram. Reading it costs no mechanical time, but Mara may choose to focus on the missing clapper instead. The dated sailing order shows who sent the last ship out against the warning. Ivo's signature on the later report is smaller, almost illegible.
