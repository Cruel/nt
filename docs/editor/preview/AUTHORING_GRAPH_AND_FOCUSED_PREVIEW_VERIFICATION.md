# Authoring Graph and Focused Preview Verification

Date: 2026-07-26

Status: Automated regression correction verified; the human-operated interaction matrix remains
unverified in this noninteractive environment.

## Current corrected contracts

The editor has one immutable authoring dependency graph for structural references, bounded Lua/RML
evidence, usage queries, mutation impact, structural preflight, repair planning, and focused-preview
closure. Focused invalidation evaluates the union of the previous and current graphs so removal or
movement of a relationship invalidates both its old and new preview roots.

Ordinary delete is graph- and project-revision gated. The Project Explorer shows planned repairs,
warnings, and required replacement selectors before confirmation. The command revalidates the current
revision and applies delete plus repairs as one transaction. Room-placement occupants are moved to
`{ kind: 'nowhere' }`; array removals use deterministic descending-index ordering. Force Delete
remains an explicit bypass.

Room, Layout, and Shader use one focused-preview coordinator, one pooled-host generation model, one
strict focused envelope, and hash-verified resource staging. All three native document kinds pass
their candidate resources through the mandatory typed-asset gate. Material and Shader-program tasks
resolve against the candidate material project, and focused fonts retain a direct staged source path.
The previous committed visual and leases remain live until the complete candidate succeeds.

Compiled Shader metadata is rejected when its compile-input fingerprint no longer matches the
normalized authoring input. Shader runtime/fetch paths are canonicalized, and authoring validation
rejects non-canonical or shared per-variant stage outputs. Focused Room construction fails closed when
its root is absent from the current graph and validates the final document only after material and
Shader closure is populated. Adapter/build failures are published as targeted preview diagnostics.

Permanent contract documentation:

- `docs/editor/project/AUTHORING_DEPENDENCY_GRAPH.md`
- `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md`
- `docs/engine/ASSET.md`
- `docs/engine/ROOM.md`
- `docs/engine/LAYOUT.md`

## Post-archive correction

A post-archive review found that the earlier certification language overstated the implementation.
The correction addressed:

1. invalid Room compiled-Shader fetch/logical paths;
2. stale compiled Shader admission and late output-path uniqueness checks;
3. invalidation that considered only the new graph;
4. repair previews and required replacements that were not reachable from the primary delete UI;
5. placement repairs, deterministic patch ordering, and stale-plan confirmation;
6. partial Room graphs and swallowed focused-build diagnostics;
7. missing Asset `byteSize` invalidation and leftover coordinator debug logging;
8. native focused Layout/Shader resource staging, candidate material binding, Shader-program requests,
   and direct focused-font loading;
9. Room document validation occurring before material/Shader closure was inserted; and
10. stale editor/native fixtures that prevented the relevant suites from exercising these paths.

The archived plan now explicitly records that implementation completion did not certify the
human-operated manual Definition-of-Done item.

## Automated validation

The correction must keep these checks green:

```text
pnpm -C editor run format:check
pnpm -C editor run typecheck
pnpm -C editor run check
pnpm -C editor run test
pnpm -C editor run engine:preview:build
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --build --preset linux-debug --target format-check
```

The handoff response records the exact commands completed for this correction and any environmental
limitation. Test counts are intentionally not frozen in this document because adding regression
coverage changes them; the command result is the authority.

## Manual-smoke disposition

The noninteractive WSL/Xvfb environment cannot certify a human-operated real-project session
involving continuous typing, picker interaction, tab/split dragging, live DPR movement between
displays, or visual judgment of diagnostic replacement. Automated tests and launch/build checks are
evidence for the underlying contracts, but they are not represented as a substitute for that manual
matrix.

## Final disposition

The implementation is considered automated-regression verified only when the command set above is
green. Human interaction certification remains a separate outstanding activity.
