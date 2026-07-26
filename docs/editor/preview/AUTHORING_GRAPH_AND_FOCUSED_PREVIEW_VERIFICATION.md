# Authoring Graph and Focused Preview Verification

Date: 2026-07-26

Status: Implemented and certified, with the human-operated manual interaction matrix recorded as an
environment limitation below.

## Certified contracts

The editor has one immutable authoring dependency graph for structural references, bounded Lua/RML
evidence, usage queries, mutation impact, structural preflight, repair planning, and focused-preview
closure. The renderer service incrementally replaces complete contributions from authoritative
project mutation publications and rejects stale source, analysis, projection, and build results.

Delete-and-repair is graph- and project-revision gated. Confirmation regenerates stale plans, and
application is one command transaction and one structural persistence unit. Unsupported or explicit
Lua repairs fail closed; possible Lua evidence remains warning-only. Undo, Redo, transaction
cancellation, persistence rollback, and recovery preserve that atomic boundary.

Room, Layout, and Shader use one focused-preview coordinator, one pooled-host generation model, one
strict focused envelope, and explicit hash-verified resource staging. Derived Room preview does not
compile or load a complete project or runtime package. Native Room preview prepares real world,
material, Layout, Game HUD, RuntimeUI, display/DPR, passive input, clock, typed-asset, and isolated Lua
state and publishes them through one complete focused-owner swap.

Permanent contract documentation:

- `docs/editor/project/AUTHORING_DEPENDENCY_GRAPH.md`
- `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md`
- `docs/editor/workbench/PERSISTENT_EDITOR_HOSTS.md`
- `docs/architecture/WORLD_AND_ROOM_PRESENTATION_SPEC.md`
- `docs/rendering/PRESENTATION_STATE_AND_TRANSITION_SPEC.md`
- `docs/engine/ROOM.md`
- `docs/engine/LAYOUT.md`
- `docs/engine/ASSET.md`
- `docs/runtime/LUA_RUNTIME.md`

## Phase 15 defects corrected

Final certification found and corrected three substantive defects:

1. Room baseline snapshot projection overwrote higher-precedence session, Room, and Scene background
   overrides. Effective background selection now occurs after baseline Room projection.
2. The new runtime query-provider header was absent from module classification, and the focused Room
   decoder had five direct `nlohmann::json::get` calls outside the owned JSON-access boundary. The
   header is classified and all five reads use `json_access`.
3. Production focused Room commit was still guarded by a Phase 10 fixture-only flag whose default
   rejected every Room candidate. The temporary gate and API were removed, and failure preservation
   is now tested using a real RuntimeUI preparation failure before successful production Room commit.

The cleanup audit also renamed the remaining internal non-Room callback so the production focused
presenter no longer describes its Layout/Shader route as a legacy document path.

## Automated validation

### Editor and focused matrices

The exact editor command set passed:

```text
pnpm -C editor run format:check
pnpm -C editor run typecheck
pnpm -C editor run check
pnpm -C editor run test
pnpm -C editor run build:renderer
pnpm -C editor run build:electron
pnpm -C editor run engine:preview:build
```

The final editor suite reported 166 passing test files and 1,006 passing tests, with four intentional
skips. It includes the graph, source-analysis, incremental-service, mutation-publication, repair,
Undo/Redo, recovery, coordinator, widget, protocol, resource staging, Room builder, and pooled
Room/Layout/Shader transition matrices.

### Linux native matrix

Linux debug configure and build passed. The complete CTest matrix passed under Xvfb: 766 of 766
tests. It includes focused-envelope decoding, native presenter, world and transition readbacks,
Layout realization, RuntimeUI, typed assets, Lua runtime/equivalence, Room resolution, package and
sandbox smokes, and presentation failure-atomicity coverage.

All Linux policy/probe targets passed:

```text
cxx-policy
json-boundary-policy
module-boundary-policy
public-header-probes
module-dependency-inventory
format-check
```

Running graphical CTest without a display cannot initialize X11. The identical full suite passes
under `xvfb-run -a`, which is the repository's available headless display environment.

### Web and packaged editor

The Web debug build, Web C++ policy, public-header probes, and module inventory passed. The focused
editor-preview Web build passed. `scripts/run-web-smoke.sh --debug --no-build` passed in Chromium,
including the expected compiled-world readback and the full RmlUi gallery threshold matrix.

The packaged Linux Electron editor was built using the validated Linux debug `noveltea-editor-tool`
as the explicit host tool because the shell's release preset had no configured `VCPKG_ROOT`.
`package:smoke` then passed every reported check: main process, application/user-data identity,
renderer, preload, packaged protocol and headers, traversal rejection, engine preview and headers,
editor assets, native editor tool, and Sharp loading.

The shell used Node 22.22.1 while `package.json` requests Node 24.18.0. pnpm reported that mismatch,
but all required editor commands, builds, tests, packaging, and smoke checks completed successfully.

## Section 12.5 manual-smoke disposition

The noninteractive WSL/Xvfb execution environment cannot perform or honestly certify a human-operated
real-project session involving continuous typing, picker interaction, tab dragging, split dragging,
live DPR movement between displays, or visual inspection of diagnostic replacement. That is the
concrete environment blocker for the literal manual matrix.

The underlying behavior is covered by automated tests and launch smokes for:

- graph-stable Room description edits and selective graph/source work;
- background selection/reimport, Character/cast, Interactable, prop, and environment changes;
- Game HUD and live RML/RCSS/Lua dependency updates;
- localization, placement, and exit-label invalidation;
- Lua condition/text/composition success, failure preservation, correction, and query admission;
- Room-to-Room, Room/Layout, and Room/Shader switching, inactive return, lease transfer, reconnect,
  resize, DPR, and pooled-host replay;
- possible-Lua warning, explicit-fallback block, Force Delete, rename confirmation, atomic repair,
  Undo, Redo, recovery, and diagnostic-scope isolation.

The Chromium Web smoke and packaged Electron Xvfb smoke prove that the built hosts launch and expose
their validated preview resources, but they are not represented as a substitute for human visual and
interaction judgment.

## Final disposition

All automated required validation passes. Permanent documentation describes the final contracts.
The obsolete generated-RML/Room-v1/recursive-staging/compiled-project Room preview paths and the
fixture-only production gate are absent. The implementation plan is archived under
`docs/archive/plans/`.
