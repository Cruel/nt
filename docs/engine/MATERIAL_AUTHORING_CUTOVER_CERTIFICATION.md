# Material Authoring Cutover Certification

## Purpose

This document records the final #292 cutover boundary. The canonical authoring model has one semantic rendering resource: the Material. Materials derive from engine-owned Material Presets or from another Material and may opt into project-owned shader source files. Shader source under `shaders/` and Lua source under `scripts/` are physical Project source, not Asset kinds or authored Shader records.

Internal runtime/compiler shader definitions, deterministic source-program identities, compiled shader binaries, and prepared `shader-source` / `script-source` artifact classifications remain implementation details. They are derived from canonical authoring inputs and are not compatibility authoring shapes.

## Certified Boundaries

### Project Workspace and canonical authoring

The workspace/schema seam rejects retired authored Shader collections and script/shader-source Asset shapes while accepting Material Presets, Material inheritance, Script Module project-file sources, Layout companion source, and freeform `scripts/` / `shaders/` trees. High-level coverage includes:

- `editor/src/renderer/test/project-workspace-service.test.ts` for the final workspace-v1 source tree, retired-shape rejection, projected source ownership, and source search;
- `editor/src/renderer/test/active-project-session.test.ts` for usage-aware source operations and path repair;
- `editor/src/renderer/test/project-workspace-watcher-service.test.ts` for external source reconciliation without guessed rename identity;
- `editor/src/renderer/test/authoring-script-modules.test.ts` for strict rejection of obsolete Asset-backed Script Module source.

Derived build output remains under `.noveltea/` and is not canonical authoring source.

### Runtime artifact preparation and lowering

`editor/src/renderer/test/shader-material-project.test.ts` covers preset-backed Materials, inheritance safety, custom source-backed Materials, reflected interfaces, and derived source-program output without authored Shader records. `editor/src/renderer/test/runtime-artifact-preparation.test.ts` covers ephemeral shader preparation without authoring mutation, requested target/source packaging, reflected Material parameters, source-revision invalidation, and ActiveText direct source pairs.

Runtime wire structures may still contain internal shader/program objects. Those objects are generated from effective Material/source inputs and do not restore a user-authored Shader identity.

### Workbench/editor integration

Files navigation and source-tab behavior are covered by the Project Files/workbench tests, including physical source reveal, quick-open/search, canonical source-tab reuse, explicit duplicate tabs, and active-resource following. Material library/focused editing is covered by the Material editor/library tests. Shader source preview sets, originating-Material seeding, dirty-buffer compilation, and independent duplicate-tab state are covered by `shader-source-preview.test.ts` and `shader-source-overlay-compilation.test.ts`.

Built-in preset source is engine-owned and opens through the read-only engine-source editor rather than masquerading as Project Files content.

### Lightweight Material preview provider

`editor/src/renderer/test/material-preview-renderer.test.ts` and `shader-material-preview-pooling.test.tsx` establish one renderer/context per workbench group, many surfaces sharing that renderer, independent side-by-side groups, shared scheduling/clock behavior, source-authority invalidation, last-good stale previews, context loss/restoration, and a representative many-preview workload. `material-selector.test.tsx` covers visual selection with compatibility and occurrence override previews.

### Native shader compiler

`tests/render/shader_compiler_tests.cpp` covers supported target variants, explicit varying definitions, contained project/engine include resolution, rejection of include escapes, transitive dependency fingerprints, compiler-reflected uniforms/samplers, browser preview payloads, deterministic source-program identity, and absence of silently-created authored varying files. Tooling-level variant admission is additionally covered by `tests/tooling/native_shader_compile_tests.cpp`.

## Removed Compatibility Surface

The canonical dependency graph no longer carries authored-Shader or source-Asset roles such as `material-shader`, `shader-source`, `script-source`, Asset-backed Layout Lua, or Asset-backed Layout script dependencies. Compiled Script references must resolve to compiled Script Module resources rather than being satisfied by an Asset with the same ID. The retired Shader record editor shim and its user-facing fallback message are removed.

Historical schema-effect bookkeeping may still name retired paths solely to preserve review-sequence alignment. Such metadata is not a reader, migration, dependency edge, editor surface, or supported authoring shape.

## Terminology

Use these terms in current documentation and UI:

- **Material** — semantic Project rendering record;
- **Material Preset** — engine-owned root rendering contract;
- **Shader Source** — source file under `shaders/` or an engine-owned source stage;
- **Customize Shader** — operation that creates Project-owned shader source for a Material;
- **Shader Preview** / **Material Preview** — lightweight editor rendering from derived browser shader output.

Do not present Shader Definition as a Project resource, or Lua/shader source as Asset kinds.
