# RmlUi Runtime UI

## Purpose

Describe how NovelTea runtime views are built with RmlUi and driven by backend-neutral controller/view-state data.

## Current Direction

RmlUi is the general runtime UI layer. Generic screens should use RML/RCSS and ordinary controls where sufficient. Complex game widgets should be C++-backed RmlUi components when they need custom layout, rendering, hit testing, or animation behavior.
