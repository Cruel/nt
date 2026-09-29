# Authoring WebGL Renderer

## Purpose

Browser-native editor rendering that needs WebGL2 shares one GPU authority per workbench group. The
authority is deliberately below any one editor feature: Material thumbnails, Room Edit, and future
authoring surfaces register scene work against the same context, caches, and animation clock instead
of allocating parallel WebGL renderers.

The authority is for authoring rendering only. Full engine previews retain their separate runtime
ownership and remain authoritative for gameplay state and complete player presentation.

## Workbench-Group Ownership

`AuthoringWebGlGroupRenderer` owns the group-level scheduling and lifecycle contract. Its backend owns:

- one WebGL2 context and scratch canvas;
- shader-program and failed-program caches, including per-Material last-good programs;
- decoded GPU texture objects and sampling variants;
- shared geometry buffers;
- Material binding and role-owned pipeline state;
- one `requestAnimationFrame` scheduler and animation timestamp;
- one WebGL context-loss and restoration boundary.

The normal workbench creates one `AuthoringWebGlGroupProvider` around each rendered group. The
authority is lazy: no WebGL context is requested until the first scene consumer registers. The
authority is recreated when active Project-session authority changes and is disposed with the group.

Persistent editors are physically hosted outside the group subtree. `workbench-group-services.tsx`
therefore publishes the owning group's authoring renderer and bridges that exact renderer into the
persistent host. Moving a persistent editor does not justify a second GPU authority.

## Scene Work Interface

Consumers register `AuthoringWebGlSceneWork` with:

- an explicit numeric order;
- current visibility;
- a render callback receiving the shared frame object;
- a required consumer-local error callback.

Visible work is sorted by order, with registration sequence as the deterministic tie-breaker. Every
consumer in one animation frame receives the same `timeSeconds`. When no registered work is visible,
the group stops scheduling frames.

The frame interface exposes target setup/copy plus shared Material drawing. Material drawing accepts
an authoring Material resource, common geometry, an optional model-view-projection matrix, texture
overrides, renderer-owned textures, and uniform/parameter overrides. It does not know about Material
preview backgrounds, hotspot fixtures, thumbnail visibility, or other preview-harness semantics.
Room Edit can therefore submit ordered scene draws through this interface without importing the
Material preview renderer or allocating its own program/texture caches.

## GPU Invalidation and Recovery

Project-resource invalidation clears Project-derived GPU textures while retaining reusable shader
programs and last-good-program state. Consumers are responsible for refreshing their CPU-side inputs
for the new Project generation before they submit new work.

WebGL context loss is owned once at the group authority. Pending animation work stops and the
authority reports `authoring-webgl.context-lost`. On restoration, shared programs, textures, and
geometry buffers are reset centrally, the existing authority becomes available again, and visible
scene work resumes on the same group scheduler. Intentional disposal marks the authority disposed
before releasing WebGL, so the resulting browser context-loss event cannot publish a false retained
status.

If WebGL2 cannot be created, the authority reports `authoring-webgl.webgl2-unavailable` and does not
schedule scene work. Feature adapters translate that group-level state into their own user-facing
diagnostics where necessary.

## Material Preview Adapter

Material previews are the first consumer of the generalized authority. `MaterialPreviewGroupRenderer`
still owns Material-surface registration, Project-resource lookup, visibility suspension, preview
fixtures, checker/light/dark backgrounds, hotspot pointer uniforms, standard-facet preview values,
and per-surface shader diagnostics. It no longer owns a WebGL context, animation scheduler, or GPU
caches.

The Material adapter registers one group scene-work item regardless of how many Material surfaces are
mounted. Within that item it renders each visible surface through the shared frame and copies the
scratch result to the surface's ordinary canvas. This preserves the existing lightweight-preview
lifecycle while leaving the lower-level authority reusable by Room Edit and other scene renderers.

## Implementation

Primary files:

```text
editor/src/renderer/authoring-renderer/authoring-webgl-renderer.ts
editor/src/renderer/authoring-renderer/authoring-webgl-backend.ts
editor/src/renderer/authoring-renderer/authoring-webgl-provider.tsx
editor/src/renderer/material-preview/material-preview-renderer.ts
editor/src/renderer/material-preview/material-preview-provider.tsx
editor/src/renderer/workbench/workbench-group-services.tsx
```

The group authority contract is covered by `authoring-webgl-renderer.test.ts`. Material binding,
preview lifecycle, invalidation, and recovery remain covered by `material-preview-renderer.test.ts`,
while `shader-material-preview-pooling.test.tsx` proves that a Material preview and a second authoring
scene consumer share one provider-owned GPU authority.
