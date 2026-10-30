---
schema: '0.1'
type: event
id: event.restore-bell
title: Restore the warning bell
status: draft
completeness: complete
decisions: []
participants: []
arcs: [arc.warning]
consequences:
  - The harbor bell rings again.
after: []
prerequisites:
  any_of:
    - completed: []
      not_completed: []
steps:
  - id: repair
    branches:
      - id: succeed
        conditions: []
        effects: []
---
# Restore the bell

The apprentice reattaches the clapper and tests the audible warning.
