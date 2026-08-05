# Archive Documentation Overview

## Purpose

`docs/archive/` contains historical plans and reports. These files help explain why earlier decisions were made, but they are not current implementation requirements unless a current document explicitly references them.

## Rules For Agents

- Do not start implementation work from an archive document alone.
- Prefer current docs under `docs/OVERVIEW.md` and the relevant area overview.
- If an archive report contains still-relevant information, copy or summarize the current requirement into an active doc instead of linking agents directly to stale history.
- Keep new historical deep-dive reports under `docs/archive/reports/` when they are not intended to guide active implementation.

## Current Contents

- Bootstrap and legacy-core plans from earlier migration work.
- Completed typed-asset architecture implementation plans.
- The completed threading, asset-streaming, residency, prefetch, and telemetry plan plus its final
  cross-platform completion report.
- The completed host/module-boundary plan and its pre-cutover ownership/dependency inventories.
- The completed authoring dependency graph, graph-backed repair, and unified focused Room/Layout/Shader
  preview implementation plan.
- `docs/archive/plans/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_IMPLEMENTATION_PLAN.md` is the
  completed hotspot authoring, exact Interaction activation, generated-mask, world rendering/input,
  and cross-platform verification plan. Its current contract and certification are
  `docs/architecture/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME.md` and
  `docs/architecture/certifications/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_CERTIFICATION.md`.
- The runtime capability cutover baseline and pre-consolidation presentation/checkpoint history.
- The no-exceptions/no-RTTI migration benchmark comparison.
- Reports mapping old NovelTea systems and current framework state.
- Historical text/rendering/web sampling notes.
