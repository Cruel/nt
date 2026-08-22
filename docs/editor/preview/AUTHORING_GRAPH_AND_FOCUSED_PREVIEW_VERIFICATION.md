# Authoring Graph and Focused Preview Verification

Date: 2026-07-27

Status: Automated regression correction verified; the human-operated interaction matrix remains
unverified in this noninteractive environment.

## Current corrected contracts

The editor has one immutable authoring dependency graph for structural references, bounded Lua/RML
evidence, usage queries, mutation impact, structural preflight, repair planning, and focused-preview
closure. Focused invalidation evaluates the union of the previous and current graphs so removal or
movement of a relationship invalidates both its old and new preview roots.

Ordinary delete is graph- and project-revision gated. The Project Explorer shows planned repairs,
warnings, and required replacement selectors before confirmation. The command revalidates the current
revision and applies delete plus repairs as one transaction. Room placements are presentation
anchors, so deleting one never rewrites a Character or Interactable's authoritative Location; only
actual presentation/context references to that placement participate in repair. Array removals use
deterministic descending-index ordering. Force Delete remains an explicit bypass. The dialog uses the
semantic repair-edge closure rather than the legacy
reference-index projection, so explicit/possible Lua evidence and Room-placement descendant repairs
remain visible. Generic relationships without a role-specific authoring value encoding fail closed
instead of constructing a guessed replacement payload.

Room, Layout, and Shader use one focused-preview coordinator, one pooled-host generation model, one
strict focused envelope, and hash-verified resource staging. All three native document kinds pass
their candidate resources through the mandatory typed-asset gate. Material and Shader-program tasks
resolve against the candidate material project, and focused fonts retain a direct staged source path.
The previous committed visual and leases remain live until the complete candidate succeeds.
Claimed but unpublished Web hosts remain browser-visible and transparent so their native main loop can
finish owner-thread asset work; activity distinguishes an active candidate from a published visual.
Layout and Shader documents are prepared under hidden generation-scoped IDs, with environment changes
prepared as commit closures and candidate materials bound only during fallible preparation. Their
final publication does not call the legacy mutating standalone-document routine. Room state releases
its prepared Lua environment when resource-request construction rejects the candidate. Focused Room
environment decoding and adaptation preserve accessibility policy, and the built-in Game HUD uses the
canonical packaged system path.

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
10. stale editor/native fixtures that prevented the relevant suites from exercising these paths;
11. fallible Layout/Shader loading occurring after the previous document, environment, Lua state,
    virtual files, or materials had already been mutated;
12. graph-only blockers, warnings, and Room-placement descendant repairs being hidden by a
    compatibility-index UI branch, which also made Force Delete unreachable;
13. generic replacement repairs guessing `$ref` object encoding for string and flow-shaped authoring
    fields; and
14. a Room resource-request rejection path retaining its prepared Lua environment;
15. CSS-hiding an unpublished pooled Web host, which suspended its animation-frame loop and left
    mandatory Room assets permanently waiting for owner-thread finalization;
16. the focused built-in Game HUD loading `system:/ui/runtime_game.rml` instead of the packaged
    `system:/ui/runtime/runtime_game.rml`; and
17. focused Room environment decoding/adaptation validating but discarding project accessibility
    scale policy, causing valid real projects to fail environment preparation.

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

The 2026-07-26 post-archive correction run completed with:

- editor format, lint/check, and typecheck green;
- 1,015 editor tests passed with four intentional skips;
- threaded Web editor-preview configure/build green;
- Linux debug build green;
- all 766 CTest cases green under `xvfb-run -a`;
- C++ format check and `git diff --check` green.

A subsequent real-project pooled-host smoke found two Layout-specific handoff omissions. Focused apply
sequences had been owned by each editor coordinator instead of by the pooled native host, allowing a
new Layout coordinator to restart at sequence one after a Room preview. Layout authoring records also
permit an omitted scale policy, but the focused adapter forwarded that omission rather than resolving
the target-specific default required by the native contract. The corrected pool allocates one
monotonic focused sequence per host, and the Layout adapter transports the resolved scale policy in
both the Layout and environment fields. The `new-project3` Room → Layout smoke subsequently completed
with the Layout host revealed and no native failure overlay.

The same real-project Layout smoke then exposed an input-publication omission: RmlUi hit testing
reached the focused input sink, but that sink rejected every Layout event callback. Focused Layout
callbacks now execute in the committed focused ScriptRuntime environment with the restricted
gameplay-layout capability profile, while runtime gameplay inputs and shell commands remain blocked.
The focused presenter fixture covers accepted gameplay-owned callbacks and rejected shell-owned
callbacks.

A direct headless CTest invocation without Xvfb predictably failed the ten SDL/X11 capture and smoke
cases because no display server was available. Re-running the complete, unchanged matrix under Xvfb
passed all 766 cases; this is an environment requirement for the GPU/readback tests, not a waived
failure.

The 2026-07-27 real-project correction was additionally exercised by launching the production
Electron renderer and threaded Web editor-preview build under Xvfb against
`/home/thomas/NovelTea/new-project3/project.json`. The Home Room candidate fetched and finalized its
authored PNG, loaded the built-in Game HUD, retained the project's `1.0` to `2.0` accessibility
policies, emitted `focused-document-applied` with `status=applied`, and changed the pooled host from
transparent to visible. The asset-profiler snapshot showed the Room image and HUD font `in-use` with
zero loading or finishing entries.

## Manual-smoke disposition

The noninteractive WSL/Xvfb environment cannot certify a human-operated real-project session
involving continuous typing, picker interaction, tab/split dragging, live DPR movement between
displays, or visual judgment of diagnostic replacement. Automated tests and launch/build checks are
evidence for the underlying contracts, but they are not represented as a substitute for that manual
matrix.

## Final disposition

The implementation is considered automated-regression verified only when the command set above is
green. Human interaction certification remains a separate outstanding activity.
