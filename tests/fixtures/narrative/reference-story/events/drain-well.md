---
schema: '0.1'
type: event
id: event.drain-well
title: Mara drains the inspection shelf
status: draft
decisions: []
participants: [character.mara]
arcs: [arc.stolen-warning]
after: [event.inspection-permitted, event.present-evidence]
prerequisites:
  any_of:
    - completed: [event.inspection-permitted]
      not_completed: [event.lift-clapper]
    - completed: [event.present-evidence]
      not_completed: [event.lift-clapper]
consequences:
  - The clapper is recovered from the exposed shelf.
steps: []
---
# Water remembers its level

Mara shuts the inlet and hauls the lever down, securing its loop over the mooring pin. Water drops below the painted service mark. She lifts the clapper from the dry shelf without entering the shaft, then releases the lever. The next tide erases the impression it left in the mud.
