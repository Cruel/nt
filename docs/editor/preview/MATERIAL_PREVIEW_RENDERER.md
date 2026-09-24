# Material Preview Renderer

## Purpose

Material libraries, selectors, source previews, and the Material editor use a lightweight renderer for live authoring previews. These previews are intentionally separate from the full engine preview: they provide fast, Web-backend-oriented Material feedback without creating an engine iframe or WebGL context per preview surface.

The ownership model has two levels:

- one Project-scoped CPU resource authority shared by the whole workbench;
- one WebGL2 renderer/context per workbench group, shared by every Material preview surface in that group.

A full engine preview remains authoritative when gameplay state, exact scene composition, text layout, RmlUi layout, postprocess ordering, or another contextual runtime contract matters.

## Project-Scoped Resources

`MaterialPreviewProjectResources` owns context-independent preview inputs. For one Project generation it:

- resolves effective Material inheritance, preset metadata, preview geometry/background, parameters, textures, and provenance;
- builds one derived shader/material Project snapshot for all Material previews;
- requests the `essl-300` browser shader variant once for the generation when custom source programs are present;
- exposes reflected Material interfaces and browser shader payloads without writing derived state into the Project;
- resolves Material texture Asset references, aliases, and `project:/` URIs to registered image Assets;
- decodes each referenced image once and shares that decoded CPU resource across groups;
- invalidates the derived snapshot and decoded resource cache when semantic Project authority advances; renderer-local/editor metadata object replacement does not advance preview authority or cancel in-flight Material builds.

This layer owns no WebGL handles. Side-by-side workbench groups therefore reuse the same resolved/decoded Project inputs while keeping their GPU state independent.

## Workbench-Group Renderer

Each rendered workbench group owns one `MaterialPreviewGroupRenderer`. Its WebGL2 backend is created lazily when the first Material preview surface registers. Persistent editors are physically hosted outside the group subtree, so the workbench's narrow group-service bridge publishes the owning group's renderer into those stable hosts without allocating a second renderer. All registered surfaces in the group share:

- one WebGL2 context and scratch render canvas;
- program, texture, and geometry-buffer caches;
- one requestAnimationFrame scheduler and animation clock;
- one context-loss/recovery boundary.

A `MaterialPreview` surface owns only its visible canvas, measured size, visibility, Material ID, and pointer state. It registers and unregisters with the group renderer; it never creates a WebGL context. The group renderer renders each visible surface into its shared WebGL scratch target and copies the resulting frame into that surface's canvas. This keeps independent surface sizing and interaction without requiring an atlas or an editor-wide overlay canvas.

Visible previews are live by default and receive the same group-frame timestamp. Compact thumbnail-style previews use intersection visibility to suspend offscreen surfaces. Full editor previews follow workbench visibility directly, and a preview inside a retained persistent editor is suspended whenever that editor host is not workbench-visible. When every registered surface is hidden, the group stops scheduling frames. Static-Material detection is intentionally not required.

Project invalidation clears the group's GPU caches before refreshed Project resources are consumed, preventing stale programs or textures from crossing generations.

## Shader Source Workspaces

Project shader source tabs reuse the normal editor preview split and the owning workbench group's shared WebGL renderer. Each tab owns only a local Material preview set and a CPU preview-resource authority; opening the same source normally reuses the canonical tab, while an explicit duplicate tab receives independent serialized preview-set state.

The editor discovers both direct Material entrypoint consumers and Materials affected transitively through `#include` edges from the current source buffers. Opening a Project shader from a Material seeds that Material into the source tab. A direct Files/quick-open navigation auto-seeds only when exactly one Material is affected; otherwise the tab starts with no arbitrary context and exposes **Add Preview** grouped by direct versus include-affected consumers. The source toolbar always reports the full affected-Material count independently from the attached preview set.

Source-tab compilation is preview-only. The renderer supplies every dirty shader buffer as a Project-scoped source overlay, and the main process materializes those buffers over a temporary copy of the Project shader tree before invoking the native compiler. Dirty included files therefore participate in the same compile generation as the edited entrypoint without being saved. Only programs required by the tab's attached Material previews are submitted, and only the `essl-300` browser variant is requested. Overlay paths remain constrained to Project `shaders/` paths at the IPC trust boundary, and compiler diagnostic source paths are remapped back to the real Project root.

Rapid edits are debounced. If a browser compile fails after a successful generation, preview resources retain that program's last successful browser payload, mark the surface stale, and expose the current compiler diagnostics. Source saving remains independent from preview validity: invalid shader text may still be saved through the ordinary source-file authority.

## Visual Material Selectors

`MaterialSelector` is the reusable visual replacement for name-only Material selection. Its collapsed trigger renders the current effective Material through `MaterialPreview`; opening it anchors a scrollable popover to that preview rather than reflowing the owning editor. Candidate previews register with the same workbench-group renderer as every other lightweight Material surface, so opening a selector does not allocate per-candidate WebGL contexts.

Consumers supply compatibility context instead of forking selector UI. A required Material role can be declared directly, and consumers may add a compatibility predicate for context-specific constraints. Compatible candidates are shown by default. **Show incompatible** reveals the remaining Materials with a mismatch explanation, but incompatible candidates remain non-selectable.

Material Application occurrence context is preview-only selector state. Parameter entries keep their semantic name and logical type; literals use their value directly, resolvable Property bindings use the current/default Property value, and standard facets are evaluated against the live preview surface (including occurrence time and paint/viewport dimensions). Author-owned texture entries carry their Asset identity into the preview and replace the candidate's compatible sampled image. A candidate receives an entry only when its reflected author-settable uniform/sampler has the same name and compatible contract; renderer-owned texture inputs are never replaced. Missing, unresolved, or incompatible saved entries remain part of the total override count, so partial application metadata reflects the complete Material Application rather than only the subset that happened to render. Candidate override previews default on and may be toggled off to compare canonical Material values. The collapsed selected preview always applies compatible occurrence context.

Selection remains ordinary authoring state: hover/focus and preview toggles do not mutate the Project, while clicking a compatible candidate invokes the consumer's one assignment callback and immediately closes the popover. Interactable authoring is the first production integration and constrains candidates to the `engine-2d` role.

## Preview Harnesses

The effective Material `preview.geometry` and `preview.background` metadata selects the representative harness. Preset defaults currently provide `quad`, `rounded-rect`, `sprite`, and `glyphs` geometries plus transparent, checker, dark, and light backgrounds. Material overrides flow through normal inheritance resolution.

Custom source-backed Materials use the compiler's `essl-300` browser payload when available, so their shader source runs through the same Web shader compilation path used for browser-facing derived artifacts. Native browser payloads are normalized with the required `#version 300 es` directive before WebGL2 compilation when the compiler payload omits it. The lightweight harness supplies effective author-settable values plus common engine inputs such as time, preview bounds, and hotspot pointer state.

Built-in/common 2D Materials use the lightweight WebGL harness with the canonical sampler, uniform, texture, effective-value, and role-owned pipeline semantics. Engine2D preview binds the fixture texture through the same renderer-owned `engine.draw_texture` contract used at runtime; it does not synthesize an authored `s_texColor` source or Material blend override. Its Material-selected clamp/repeat address and inherit/nearest/linear filter policy are applied independently, with `inherit` taking the fixture/source image's nearest/linear choice. Context-heavy roles deliberately use representative fixtures:

- ActiveText uses the glyphs harness; it does not reproduce shaping, dialogue state, or the full text renderer.
- RmlUi decorator Materials use a rounded-rectangle fixture rather than an RmlUi document/layout pass. The fixture still follows the generated `rmlui-decorator` contract: it supplies the contract-owned projection/transform/translation uniforms and renderer-owned decorator texture at the reserved stage with clamp/linear sampling, then composites with premultiplied-alpha blending.
- hotspot Materials use the sprite fixture and per-surface pointer state for hover/press inputs.
- postprocess Materials use a representative quad rather than the complete composed game viewport and postprocess chain.

Add new role-specific fixtures by extending the harness selection from effective Material metadata. Do not move runtime/game state ownership into this preview subsystem merely to make a thumbnail more realistic.

## Failure and Recovery

WebGL2 initialization failure is stable for the owning group and surfaces a `material-preview.webgl2-unavailable` diagnostic state. A render failure surfaces `material-preview.render-failed`. Neither case automatically launches a full engine preview.

WebGL context loss is handled once by the group renderer. The surface canvases and editor/tab state remain mounted. On restoration, shared GPU state is rebuilt centrally and live surfaces resume on the existing group clock. The temporary state uses `material-preview.context-lost`. Intentional renderer disposal may release its WebGL context, but that teardown must not publish context-loss status to retained or transitioning editor surfaces.

## Implementation

Primary files:

```text
editor/src/renderer/material-preview/material-preview-resources.ts
editor/src/renderer/material-preview/material-preview-renderer.ts
editor/src/renderer/material-preview/material-preview-provider.tsx
editor/src/renderer/material-preview/MaterialPreview.tsx
editor/src/renderer/components/materials/MaterialSelector.tsx
editor/src/renderer/workbench/Workbench.tsx
editor/src/renderer/editors/materials/MaterialEditor.tsx
editor/src/renderer/editors/interactables/InteractableEditor.tsx
```

Provider-level coverage is in `editor/src/renderer/test/material-preview-renderer.test.ts`; Material-editor surface integration is covered by `shader-material-preview-pooling.test.tsx`. Reusable selector behavior is covered by `material-selector.test.tsx`, with the representative production seam covered by `interactable-editor.test.tsx`.
