---
schema: '0.1'
type: event
id: event.lift-clapper
title: Mara lifts the clapper with the sounding magnet
status: draft
decisions: []
participants: [character.mara]
arcs: [arc.stolen-warning]
after: [event.inspection-permitted, event.present-evidence]
prerequisites:
  any_of:
    - completed: [event.inspection-permitted]
      not_completed: [event.drain-well]
    - completed: [event.present-evidence]
      not_completed: [event.drain-well]
consequences:
  - The clapper is recovered dry and intact.
steps: []
---
# The answering knock

The line draws taut. Mara pulls sideways to free the magnet from the bracket, then lowers it until iron answers iron. She braces against the rail and winds the clapper up by hand. Fresh leather fibers cling to its eye; they show a cut, not a culprit.
