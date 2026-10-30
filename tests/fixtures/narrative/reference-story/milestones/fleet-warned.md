---
schema: '0.1'
type: milestone
id: milestone.fleet-warned
title: The fleet returns to safety
status: draft
decisions: []
change: The warning reaches the fleet, either through shared repair or Mara's independent action.
arcs: [arc.stolen-warning, arc.earned-trust]
fulfillment:
  any_of:
    - [event.bell-restored]
    - [event.horn-warning]
---
# A complete small adventure

Both endings answer the immediate threat. Only one repairs Mara and Ivo's working trust. Neither erases the council's responsibility, and the optional logbook determines whether Mara can independently challenge the old accusation. The two endings are exclusive through the Choice Point outcome, not by duplicating that outcome on the Milestone.
