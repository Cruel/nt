# Authoring Dependency Graph and Live Entity Preview Implementation Plan

## Status

Archived on 2026-07-26 after implementation of all fifteen phases. A post-archive audit found and
corrected focused-resource, invalidation, and repair-workflow regressions; the correction record is in
the linked verification document. The literal human-operated Section 12.5 interaction matrix was not
performed in the noninteractive WSL/Xvfb environment, so this archive records implementation
completion rather than certification of that manual Definition-of-Done item. Automated results are
recorded in
`docs/editor/preview/AUTHORING_GRAPH_AND_FOCUSED_PREVIEW_VERIFICATION.md`.

The post-Phase 1 review found four concrete implementation details that the remaining phases must
absorb without changing their order: the initial fallback-owner validation is still a separate
path-regex registry; save-baseline publication can replace the project object without changing
authoring content; the focused native limit/manifest contracts are currently only partial
scaffolding; and the Room v2 schema still uses open JSON-object placeholders for its large native
sections. Phases 3, 4, 7, and 9 below now explicitly close those gaps before their first authoritative
consumer. No other remaining phase scope or sequencing changed.

The post-Phase 2 review found three additional concrete integration constraints, again without
requiring any phase reordering. First, the completed structural graph exposes deterministic bulk
contribution derivation and replacement, but not yet the keyed single-contribution derivation seam
required by the Phase 3 equivalence tests and the Phase 5 incremental service. Second, Phase 2's
current reverse-derivation declarations are too broad to become
authoritative Lua/RML work indexes: they currently include structurally referenced Shader/RCSS
sources, non-selected source-mode alternatives, and ordinary property assignments that do not by
themselves require source analysis or property-resolution rederivation. Third, the current field
metadata and adapter declarations are effective schema-drift/audit scaffolding, but their heuristic
effect assignment and collection-level summaries do not yet provide the exact no-default,
owner-resolving production classifier required by Phase 4. Phases 3 and 4 below now explicitly
promote those scaffolds into the required exact contracts before Phase 5 consumes them. No later
phase boundary or sequence changed.

The post-Phase 3 review found four concrete constraints and one blocking contract correction. First,
the registry is exhaustive for valid records, but its current top-level enumeration calls strict
whole-record parsers; an unrelated semantically invalid field can therefore hide a safely readable
Lua/RML source from a structurally admitted working document. Phase 4 must make registry enumeration
tolerant at the structurally admitted boundary before Phase 5 makes the graph authoritative. Second,
Phase 3 correctly excludes merely declared but unreached Layout scripts/templates from the reached
`source-asset` reverse index. Asset path/kind/extension changes can nevertheless change whether an
existing RML URI resolves, so Phases 4 and 5 must add a distinct declared-resolution-candidate index
rather than broadening `source-asset` again. Third, the canonical URI/dependency resolver is currently
private inside `authoring-source-analysis.ts`; Phase 7 must extract that implementation into one
shared pure module consumed by analysis, runtime Layout source realization, and focused Layout
realization rather than implementing a second resolver. Fourth, Phase 5 must retain a revision-gated
immutable source-analysis projection/query beside the graph snapshot so Phase 9 can consume exact
regions, completeness, reached sources, and owner provenance without rereading or reanalyzing source.

The blocking correction is that the completed Phase 3 code does not yet obey two fixed graph-edge
contracts: `lua-possible-reference` currently carries `tooling-reference`, and
`lua-explicit-reference` currently uses `warning-only` repair, while Section 5.2 requires possible
evidence to omit `tooling-reference` and explicit fallback repair to be `blocked`. In addition, the
new dedicated `property-value` target is currently materialized only for direct assignments even
though focused property resolution also admits inherited and definition-default values. Correct and
test those three Phase 3 contracts before starting Phase 4; do not defer them to Phase 6 preflight,
Phase 9 document building, or Phase 14 repair.

This plan replaces the reverted full-project native Room-preview design. It defines one shared
authoring dependency graph and one focused live-preview delivery system, with native Room preview as
the first complete native world consumer. The graph is incremental from its first renderer-backed
implementation: graph-stable editor changes reuse the current immutable graph, while graph-affecting
changes replace only complete affected contributions and retain a full pure build as the correctness
oracle and conservative fallback.

This archived plan is implementation history. Current behavior is defined by the permanent
documentation linked from `docs/editor/OVERVIEW.md`.

## 0. Authority, interpretation, and fixed terminology

### 0.1 Repository authority

An implementation agent must interpret this plan together with the current repository files. When a
concept in this plan names an existing type, path, or subsystem, the current repository definition is
authoritative unless this plan explicitly requires that definition to change.

The principal existing authorities are:

- authoring collections and project schema:
  `editor/src/shared/project-schema/authoring-collections.ts` and
  `editor/src/shared/project-schema/authoring-project.ts`;
- current reference scanning:
  `editor/src/shared/project-schema/authoring-references.ts`;
- Room, Character, Interactable, Layout, Material, Shader, Script, settings, localization, condition,
  and text schemas under `editor/src/shared/project-schema/`;
- current derived-preview protocol:
  `editor/src/shared/preview-protocol.ts`;
- current pooled host and derived pane:
  `editor/src/renderer/preview/preview-host-pool.tsx` and
  `editor/src/renderer/preview/DerivedPreviewPane.tsx`;
- current widget host:
  `web/widget.html`;
- current typed native editor documents:
  `engine/include/noveltea/core/editor_preview_contracts.hpp` and
  `engine/src/core/editor_runtime_protocol.cpp`;
- current preview owner:
  `engine/src/host/preview_host.*`;
- current world, Layout, RuntimeUI, asset-residency, Room-resolution, and scripting contracts under
  `engine/include/noveltea/` and `engine/src/`;
- permanent architectural rules in
  `docs/editor/preview/`, `docs/editor/workbench/`, `docs/editor/project/`,
  `docs/architecture/WORLD_AND_ROOM_PRESENTATION_SPEC.md`, `docs/engine/ROOM.md`,
  `docs/engine/LAYOUT.md`, and `docs/runtime/LUA_RUNTIME.md`.

The old archived Room-preview plan is historical only. It is not an implementation source.

### 0.2 Normative language

`must`, `must not`, and numbered phase requirements are completion gates. Type names shown in this
plan are the required contract names unless an existing repository convention requires a mechanical
name adjustment. Such an adjustment may not change ownership, data flow, or semantics.

An implementation agent must not substitute a different architecture merely because it appears
shorter. In particular, it must not substitute full project compilation, a temporary compiled
project, a runtime session, full semantic Lua parsing, or whole-project invalidation for the focused
contracts defined here. This plan does require the bounded lexical Lua/RML analysis service defined
in Section 7; that service is intentionally not a Lua AST, evaluator, or API-context-aware analyzer.

### 0.3 Fixed terms

- **Working project**: the current authoritative in-memory authoring-content document, including
  unsaved and recovered content represented by the project store. The separately persisted
  renderer-only `/editor` metadata channel is not authoring content and does not participate in
  project revisions, graph identity, or focused-preview freshness.
- **Derived preview**: an editor preview for one focused authoring target. It is not gameplay.
- **Play preview**: the dedicated compiled-project runtime preview.
- **Preview root**: `{ kind, recordId }`, for example
  `{ kind: "room-preview", recordId: "bedroom" }`.
- **Preview inputs**: adapter-specific editor or preference values that are not stored on the target
  record, such as the current preview display profile or a Character pose selection.
- **Authoring dependency graph**: an in-memory graph deterministically derived from the working
  project. It is never persisted and is never project authority.
- **Graph contribution**: the complete deterministic nodes, outgoing edges, diagnostics, derivation
  dependencies, and unprojected literal occurrences owned by one record, nested semantic owner, or
  fixed project-field owner. Full and incremental graph construction use the same contribution
  derivation and projection functions.
- **Graph input registry**: the positive, typed registry of authoring paths that can change graph
  contributions. Paths not matched by this registry do not trigger graph derivation or Lua/RML
  source analysis, though they may still invalidate focused preview content.
- **Source analysis artifact**: immutable lexical/RML extraction output split into an owner-neutral
  content artifact keyed by exact source bytes, URI-base inputs, and analyzer version, plus a cheap
  semantic-owner projection that binds authoring paths and provenance. It records decoded literal
  occurrences independently of the current project symbol table so target-ID or source-owner-ID
  changes can rebind/reproject evidence without rereading, reparsing, or relexing unchanged source.
- **Derivation dependency**: a deterministic reverse-index key recording non-owned inputs that can
  change one contribution, such as a source Asset, localization lookup, property-resolution chain,
  fixed project field, or lexical symbol value.
- **Preview closure**: records, nested targets, project fields, localization entries, and assets
  selected by an adapter for one preview root and its current inputs.
- **Focused preview document**: one complete immutable replacement payload for a preview root.
- **Resource manifest**: the explicit hash-verified project files whose bytes the document consumes.
  Entries are either authoring Asset records or generated compiled Shader outputs recorded by the
  authoring Shader workflow. Arbitrary recursively discovered `path` fields are never resources.
- **Freshness coordinator**: the renderer service that owns focused document building, coalescing,
  delivery ordering, applied-revision tracking, replay, and diagnostic scopes.
- **Focused native Room presentation**: native world, material, Layout, display, and RuntimeUI
  realization from a focused document, without a `CompiledProject`, `LoadedCompiledPackage`,
  `RunningGame`, `RuntimeExecutor`, `RuntimeSession`, `SessionState`, or gameplay entrypoint.

### 0.4 Session-local identifiers and revisions

The implementation must use these distinct values:

1. `projectInstanceId`
   - an opaque UUID allocated whenever a different project/root is opened, the active project session
     is closed and replaced, or a new unsaved project is created;
   - remains stable for in-session whole-document replacement, recovery application after the
     session is established, rollback, Undo/Redo, and migration-normalization publication;
   - not the authored project ID, filesystem path, preview session token, or save-unit ID;
   - not persisted;
   - used to partition graph snapshots, preview caches, and staged project assets.
2. `projectRevision`
   - a session-local monotonic positive integer;
   - the initial load/recovery reconstruction for a new `projectInstanceId` publishes revision `1`;
   - each subsequent successful authoritative authoring-content replacement caused by a command,
     transaction step, transaction cancellation, structural-persistence rollback, Undo, Redo, or
     explicit in-session document replacement increments it by one;
   - transaction commit itself does not increment the revision when it only finalizes history or
     persistence for content already published by transaction steps;
   - renderer-only `/editor` metadata publication does not increment it;
   - never equals the command-history cursor and never decreases during Undo.
3. `inputRevision`
   - `sha256:<64 lowercase hexadecimal characters>` over canonical JSON of validated preview inputs.
4. `resourceRevision`
   - the same hash format over the canonical sorted resource-manifest projection consumed by
     staging/native realization;
   - excludes diagnostic-only `usageRoles`, whose changes do not alter bytes, mount paths, sampling,
     or rendering.
5. `revision`
   - the focused document revision;
   - the same hash format over canonical JSON containing `kind`, `recordId`, `inputRevision`,
     `resourceRevision`, and `data`;
   - does not include `projectRevision`, timestamps, editor metadata, insertion order, or transport
     request IDs.
6. `resourceStageGeneration`
   - a widget-local monotonic unsigned integer scoped to one `projectInstanceId` and one widget/WASM
     lifetime;
   - starts at `0`;
   - increments once after each successful batch that writes one or more new/changed manifest entries
     into the widget filesystem;
   - is transport synchronization state, not document content, and is not included in `revision`.

Canonical JSON means recursively sorted object keys, preserved array order, standard JSON scalar
encoding, and UTF-8 bytes. Extract a small shared canonical-JSON/hash utility. Do not import the
compiled-project publisher or `compiled-runtime-export.ts` into focused-preview code.

## 1. Goal

Implement one architecture that provides all of the following:

1. One typed forward-and-reverse authoring dependency graph for references, impact analysis,
   preview closure, and safe repair.
2. Accurate Find Usages and deletion preflight, including typed relationships that are not encoded
   as `$ref`, such as Character/Interactable Room placement.
3. Atomic delete-and-repair behavior for explicitly supported relationship roles.
4. Incremental immutable graph refresh driven by required field-level graph-effect metadata plus
   colocated adapter dependency declarations, with zero graph or source-analysis work for explicitly
   graph-neutral editor changes.
5. Path-sensitive preview invalidation from project mutations and preview-input changes, independent
   of whether those changes alter the graph.
6. Small deterministic documents and explicit resource manifests.
7. A warm pooled preview host that applies only the newest requested document.
8. Existing Layout and Shader previews migrated to the common freshness path without changing their
   intended rendering semantics.
9. A native Room preview using the real world renderer, material/shader backend, Layout realization,
   reference-resolution/DPR pipeline, environment clocks, and RuntimeUI view binding.
10. Deterministic focused evaluation of Room presentation conditions, text expressions, and the
    restricted Room composition hook.
11. An adapter boundary that later preview kinds can join without changing graph, pooling,
    transport, staging, or ordering foundations.

The implementation is complete when continuous Room editing produces the latest correct native
result without iframe reload, project compilation, all-project diagnostics, stale completion,
partial world/UI/Layout publication, or project-session replacement.

## 2. Explicit non-goals and forbidden substitutions

This implementation does not add gameplay to Room preview. Room preview does not execute navigation,
interactions, lifecycle effects, startup hooks, saves, title flow, normal gameplay commands, or
runtime state mutation.

The following substitutions are forbidden:

- calling `buildCompiledRuntimeExport()` or `publishCompiledArtifact()` for a derived Room preview;
- requiring whole-project runtime-package validation before a Room preview can render;
- enumerating or staging every project asset;
- writing compiled-project JSON into the widget filesystem for Room preview;
- constructing a partial or complete `CompiledProject` solely for preview;
- calling `LayoutRealizer::bind_session()` for focused Room content;
- constructing `RunningGame`, `RuntimeExecutor`, `RuntimeSession`, or `SessionState` for Room preview;
- evaluating Lua or building a full Lua AST merely to infer referenced IDs;
- treating every project change as affecting every preview;
- introducing one iframe or engine per entity editor;
- using raw string-prefix checks for JSON-pointer overlap;
- storing graph or preview caches in `project.json` or editor recovery metadata;
- creating a field-level mutation protocol for Room preview;
- silently falling back to the prior generated-RML Room simulation after production cutover.

The prohibition on a focused preview `CompiledProject` does not prohibit reuse of existing
backend-neutral domain definitions, resolver views, value types, typed visual definitions, or pure
lowering/decoder helpers whose contracts match focused preview. Prefer reuse or extraction over a
parallel Room domain model. A helper is excluded only when it requires complete compiled-project
tables, runtime-session authority, gameplay mutation, package ownership, or wire semantics not
present in the focused document.

Thumbnail rendering, native cutovers for every other preview kind, arbitrary preview-camera tools,
automatic repair for every possible reference role, API-context-aware Lua analysis, and Lua source
rewriting for rename/delete are outside this plan.

Tracked files changed outside the editor are also outside automatic freshness in this plan. A
referenced tracked Asset becomes fresh through the existing import/reimport command path, which
updates its `contentHash`. The existing asset watcher continues detecting untracked files. A raw
filesystem overwrite that does not update the Asset record is not treated as a project mutation; if
the file is later fetched and its bytes do not match the recorded hash, staging fails with a focused
diagnostic and preserves the prior visual. Automatic reconciliation of tracked external changes is a
separate future feature.

## 3. Reviewed existing architecture

### 3.1 Preview ownership and transport

The existing high-level host lifetime is retained:

- `PreviewHostPoolProvider` owns warm iframe/WASM hosts per tab group.
- `PreviewPane` leases a host only for the active tab and releases the lease without destroying the
  host.
- lease sends wait for `ready` and reject after lease replacement;
- Play preview owns a separate dedicated host and compiled-artifact lifecycle;
- the protocol already provides document load/update, diagnostics, request IDs, activity, resize,
  and snapshots.

The missing behavior is centralized freshness. `DerivedPreviewPane` currently receives an already
built document, always sends `set-preview-mode`, always calls `loadPreviewDocument`, and reveals after
that command. It has no same-root update, revision deduplication, coalescing, or applied-revision
verification.

### 3.2 Current Room, Layout, and Shader paths

- Room sends `noveltea.room-preview.v1`; `web/widget.html` renders generated RML.
- Layout sends a focused document through `noveltea_preview_show_editor_document`; native code uses
  the authored environment and `LayoutRealizer::realize_authored_preview()`.
- Shader uses the same typed native boundary, installs shader/material metadata, and renders the
  actual RmlUi shader decorator.

The typed editor-document boundary is the extension point for Room. No Room-specific package loader
is added.

The widget currently scans arbitrary objects for a property named `path`, fetches each discovered
path with `cache: 'no-store'`, and writes it under `/assets/project`. This behavior is replaced for
all migrated preview kinds by the explicit resource manifest.

### 3.3 Existing reference behavior

`buildReferenceIndex()` currently indexes explicit `$ref` values, `$var` references,
same-collection `extends`, project entrypoint, project settings references, and Scene/Dialogue flow
targets. Compiler linking, project search, rename/delete, and usage UI consume that result.

The new graph must preserve those results while adding semantic relationships, nested targets,
preview impact paths, and repair policies. It is an evolution of this scanner, not a second system.

### 3.4 Existing Room and native presentation behavior

The engine already owns reusable final presentation contracts:

- `RoomPresentationDraft`, `ResolvedRoomPresentation`, and `RoomPresentationResolution`;
- `RuntimePresentationSnapshot`;
- `WorldPresentationBackend`;
- `RuntimeLayoutManager` and `LayoutRealizer`;
- `RuntimeUiGameplayValues`; and
- typed asset requests and leases.

`RoomPresentationResolver` currently resolves Room overlays, persistent Characters, Interactables,
Room cast, props, environments, description, placement labels, exits, and composition from a complete
compiled project and session state. `PresentationProjector` then maps resolved values into the final
snapshot. Focused preview must share or extract the mapping/evaluation logic that does not require
runtime authority; it must not manufacture runtime authority to call the current APIs unchanged.

Character `initialWorldState` and Interactable `initialState.location` already support
`room-placement`. They are required Room-preview inputs now, not future placeholders.

Room exit UI labels are authored on the source Room exit. The target Room label is not part of the
runtime Room exit view. Therefore target Room content edits do not visually invalidate a source Room
preview. Target deletion or ID rename remains a reference-integrity impact.

Room placement presentation Layouts are values in `RoomPlacementView`. They are not separate mounted
presentation Layouts in the current runtime. The preview includes their references and UI-view data,
but does not mount them independently unless runtime presentation is changed by another approved
plan.

### 3.5 Existing composition behavior

Room composition is synchronous, non-yielding, and restricted. It can currently change Character and
Interactable visibility in a temporary draft. Its query capability is read-only, but the current
capability plumbing is coupled to `RuntimeCommandGateway` and a complete runtime session.

Focused preview must introduce a read-only query-provider seam while preserving the current runtime
adapter and Lua API. The same draft access and no-yield rule are used in both paths.

## 4. Fixed architectural decisions

### 4.1 One pure contribution model, reusable source artifacts, one full builder, and one renderer cache

`buildAuthoringDependencyGraph(project, luaAnalysis)` is the authoritative pure derivation algorithm.
Shared compiler/search/test code calls the pure builder or its compatibility projection. It must have
no React, Zustand, DOM, Electron, filesystem, IPC, or native dependency. `luaAnalysis` is explicitly
either `{ mode: 'disabled' }` or `{ mode: 'enabled', sources: LuaSourceSnapshot }`; callers never
silently omit the choice. Compiler compatibility/linking uses `disabled`, while the renderer's
authoritative graph uses `enabled`.

The full builder is a deterministic fold over source-owned graph contributions. The same pure
contribution functions are the only functions the renderer may call for incremental replacement.
There must not be a whole-project implementation for compiler/tests and a separate hand-maintained
edge-mutation implementation for the renderer. Incremental refresh removes and rederives complete
affected contributions, then rebuilds immutable indexes from the retained and replaced contribution
set.

The shared implementation exposes these conceptual pure operations, using repository naming
conventions for exact module/function names:

```ts
enumerateAuthoringDependencyContributionKeys(project);
collectAuthoringSourceRequirements(project, contributionKey);
analyzeAuthoringSourceContent(sourceRequirement, sources);
bindAuthoringSourceOwner(project, contributionKey, contentArtifacts);
deriveAuthoringDependencyContribution(project, contributionKey, analysisArtifactOrDisabled);
projectAuthoringLiteralEvidence(contribution, currentSymbolIndex);
assembleAuthoringDependencyGraph(contributions);
buildAuthoringDependencyGraph(project, luaAnalysis);
```

The full builder is composition of those operations. The renderer service may invoke only the same
operations for selected keys and cached artifacts. `projectAuthoringLiteralEvidence()` must be
idempotent and must not modify the cached unprojected contribution/artifact.

Lua/RML processing is split into two pure stages:

1. byte-dependent source analysis produces immutable `AuthoringSourceContentArtifact` values that
   contain extracted executable regions, deterministic container/region provenance, decoded
   string-literal occurrences with decoded-region-local coordinates, and terminal analysis
   diagnostics without consulting the current authoring symbol table; and
2. contribution derivation projects those artifacts against the current symbol table, explicit
   fallback metadata, and other current project inputs.

The full builder computes both stages from supplied source snapshots. The renderer may reuse an
artifact only when its exact cache key matches project instance, source identity/path, content hash,
analysis configuration, and analyzer version. An eligible top-level record/property-definition ID
change therefore reprojects only semantic owners indexed under the affected decoded literal; it never
forces every source file to be reread or relexed merely because the candidate symbol table changed.
Owner-scoped placement/exit changes replace structural contributions without generic literal
reprojection.

The renderer owns one `AuthoringDependencyGraphService` that caches a graph snapshot for the current
`projectInstanceId` and updates it from project mutation facts. The renderer service does not become
an authority and is never imported by shared compiler code. It owns contribution storage, reverse
derivation indexes, and session-local source-artifact caches, but every published graph is still the
deterministic result of pure contribution derivation and assembly.

### 4.2 Preserve the existing tolerant working-document boundary

The graph reads the current authoritative working project, including unsaved and recovered values
already represented by the project store. Field-local raw input that cannot yet be represented in
the project model remains outside the graph until the owning editor commits a project value.

This plan must preserve the completed validation architecture. Structurally admitted but
semantically invalid authoring values remain publishable, dirty, recoverable, and diagnosable. A
temporarily empty required string, malformed version, missing reference, stale Shader output,
invalid condition, or other semantically invalid value must not be rejected merely because the
strict Zod schema rejects it. Save, runtime-package, and platform-export boundaries continue
deciding which operations those diagnostics block.

Every authoritative project-content candidate continues through the existing structural admission
path before replacing the working document. Reuse the existing shared decoder, command
`affectedPaths`, save-unit ownership, and recovery contracts; do not add a second strict/localized
validation framework. The existing path must:

1. separate renderer-only editor metadata from project content;
2. apply existing migrations and known safe repairs;
3. reject only content that cannot be represented safely by the authoring editor, such as an
   unusable root, collection, record-envelope, or identity shape or an unsupported schema version;
4. preserve semantically invalid but structurally representable values and their diagnostics;
5. restore separately admitted editor metadata; and
6. atomically publish the working document and its mutation fact.

This path covers initial load/migration, recovery reconstruction, each publicly visible command
step, transaction cancellation, Undo, Redo, structural-persistence rollback, and explicit document
replacement. Transaction commit publishes content only when it creates a working-document value not
already published by its steps. A structurally rejected candidate leaves the prior document,
history position, `projectRevision`, mutation stream, graph snapshot, and preview state unchanged
and emits the existing scoped structural diagnostics.

Command handlers and Undo/Redo patches cannot publish an intermediate document that violates the
existing structural-admission contract. An operation that cannot preserve structural
representability after each public step must construct and validate a private candidate or one
combined atomic patch set before publication. Opening a damaged file that cannot pass structural
admission does not establish an authoritative project session; raw-file recovery tooling may hold
and repair that JSON separately.

Introduce a distinct `StructurallyAdmittedAuthoringProject` type or equivalent documented contract
when practical instead of extending the existing semantic-only `as AuthoringProject` cast
indefinitely. This plan must not require a broad unrelated schema migration merely to introduce that
name, but graph and focused-preview code must not assume every semantic refinement encoded by the
strict schema currently holds.

Conceptually:

```ts
type StructurallyAdmittedAuthoringProject = AuthoringProject & {
  readonly __structurallyAdmittedBrand: unique symbol;
};
```

The exact representation may remain an alias initially, but the boundary and adapter obligations are
normative.

Each graph or preview adapter owns tolerant parsing of the record fragments and project fields it
consumes. It preserves every structurally readable generic `$ref`, `$var`, entrypoint, extends, and
flow-target relationship that can be identified safely. Semantically invalid roots or dependencies
produce owner-scoped graph or preview diagnostics. A focused builder failure preserves the previous
visual; one invalid record must not make the complete structural graph or unrelated previews
unavailable.

### 4.3 Semantic adapters upgrade generic edges

The generic scanner first creates reference-integrity relationships. A typed adapter that recognizes
the same `(sourcePath, target)` relationship upgrades that edge with its semantic role, facets,
impact paths, detail, and repair policy. It must not create a duplicate usage entry for the same
relationship.

### 4.4 Preview invalidation is path-sensitive

Edges describe both reference integrity and consumed target content. A changed path invalidates a
dependent preview only when:

- the changed record/project field is the preview root itself;
- target identity was created, removed, or renamed across a reference-integrity relationship; or
- the changed path overlaps a declared target impact path for an edge in the preview closure.

JSON-pointer overlap is segment-aware: two pointers overlap when either pointer's decoded segment
sequence is a prefix of the other. String `startsWith` is forbidden because `/rooms/a` must not match
`/rooms/ab`.

The current `JsonPointer` type and pure escape/unescape/build/parse/split helpers live under
`editor/src/renderer/project/json-pointer.ts`, which shared graph code may not import. Phase 1 must
move those pure contracts to `editor/src/shared/json-pointer.ts`. The renderer module becomes a thin
compatibility re-export plus its renderer-owned `JsonValue` traversal helpers
`getJsonAtPointer()`/`hasJsonAtPointer()`. Shared code imports only the shared module; duplicating
`type JsonPointer = string` or pointer parsing in the graph implementation is forbidden.

Conservative stale marking is allowed when a changed path cannot be attributed precisely. Sending a
document whose `revision` is unchanged is not allowed.

### 4.5 Focused documents replace whole content

A meaningful Room edit may rebuild a small complete document. The system does not send field-level
patches. It optimizes by selecting only affected roots, hashing exact consumed values, staging only
changed resources, and reconciling into a warm host.

### 4.6 Inactive tabs do not apply intermediate revisions

An inactive tab owns no lease and performs no background native application. The graph service still
updates. When the tab becomes active and claims a lease, the coordinator builds one document from the
latest project revision and latest preview inputs.

Correctness must not depend on preserving a component-local stale flag while the component is
unmounted.

### 4.7 Same-root failures preserve the prior visual

For the same preview root, decode, staging, hash verification, asset residency, Lua evaluation,
Layout preparation, world reconciliation, or RuntimeUI failure leaves the previous committed visual
visible. A corrected later revision can apply without reloading the host.

For a newly claimed different root, the pooled DOM host remains hidden until that root commits. A
failure shows the editor-owned scoped failure state; it must never reveal content belonging to the
previous lease.

### 4.8 Preview diagnostics are scoped and replaced

Preview Diagnostics contains only focused builder, resource, decode, composition, and rendering
diagnostics for the current preview root/revision. Project-wide diagnostics remain in Problems.

Diagnostics from a superseded revision, released lease, prior root, or prior project instance are
discarded. A newer success clears the prior failed revision's diagnostics for that root.

## 5. Authoring dependency graph contract

### 5.1 Node keys

The graph supports these exact node families:

```ts
type AuthoringDependencyNodeKey =
  | {
      kind: 'record';
      collection: AuthoringCollectionKey;
      id: string;
    }
  | {
      kind: 'nested';
      ownerCollection: AuthoringCollectionKey;
      ownerId: string;
      family: 'room-placement' | 'room-exit';
      id: string;
    }
  | {
      kind: 'property-definition';
      id: string;
    }
  | {
      kind: 'localization-key';
      locale: string;
      key: string;
    }
  | {
      kind: 'project-field';
      path: JsonPointer;
    };
```

Required project-field roots are:

- `/startupHook`;
- `/entrypoint`;
- `/settings/display`;
- `/settings/accessibility`;
- `/settings/text/defaultFont`;
- one node for each `/settings/ui/systemLayouts/<role>` supported by
  `authoring-layouts.ts`;
- `/localization/defaultLocale`; and
- `/localization/fallbackLocale`.

Room placement and exit nodes are required because other records can target those nested IDs and
because deletion/repair must distinguish deleting one placement from deleting its owning Room.

The initial nested-node vocabulary is deliberately closed to those two families. Other current IDs
remain owner-local in this implementation unit:

- Scene steps, branch arms, and choice options are scoped to one Scene;
- Dialogue blocks, segments, and edges are scoped to one Dialogue;
- Map locations and connections are scoped to one Map;
- Character poses, expressions, and idles are scoped to one Character; and
- comparable instruction/control-flow IDs are scoped to their owning record.

Their existing strict collection validators continue checking uniqueness and internal targets. They
do not become generic Find Usages, delete-repair, or lexical-Lua target nodes in this plan. This is
not permission to ignore their effects:

- an adapter records owner-local target failures as graph diagnostics attributed to the owning
  record/source path when that collection is graph-derived;
- cross-record fields that select owner-local Character visuals, such as Room cast `poseId`,
  `expressionId`, and `idleId`, remain details on the Room-to-Character semantic relationship and
  use exact Character visual target-impact paths; and
- the Room builder validates and resolves those values from the Character record, so deletion,
  insertion, rename, or content change of a selected visual invalidates and rebuilds the Room even
  though the visual is not a separate graph node.

Promoting another owner-local family to first-class identity requires a future node-family, repair,
usage-label, mutation, and Lua-symbol decision. An implementation agent must not broaden the initial
node union merely because a schema contains an `id` field.

### 5.2 Edges

```ts
type DependencyImpactFacet =
  | 'reference-integrity'
  | 'tooling-reference'
  | 'preview-visual'
  | 'preview-ui'
  | 'resource'
  | 'validation'
  | 'runtime-only';

interface AuthoringDependencyEdge {
  id: string;
  source: AuthoringDependencyNodeKey;
  target: AuthoringDependencyNodeKey;
  sourcePath: JsonPointer;
  targetPath: JsonPointer;
  role: AuthoringDependencyRole;
  facets: readonly DependencyImpactFacet[];
  targetImpactPaths: readonly JsonPointer[];
  repair: AuthoringReferenceRepairPolicy;
  evidence?: readonly AuthoringDependencyEvidence[];
  detail?: Readonly<Record<string, string>>;
}

type AuthoringDependencyEvidence =
  | { kind: 'lua-occurrence'; occurrence: LuaReferenceOccurrence }
  | { kind: 'explicit-lua-fallback'; declarationPath: JsonPointer };
```

The shared module exports one stable `AUTHORING_DEPENDENCY_ROLES` constant and derives
`AuthoringDependencyRole` from its values. Adapters must use that registry; free-form role strings at
call sites are forbidden. Adding a new role requires a graph unit test and a human-readable usage
label in the same change.

`id` is a deterministic canonical encoding of source key, target key, source path, and role. It is
not random. Lua occurrence offsets do not enter the edge ID, so editing one source while preserving
the same semantic source/target relationship updates the edge's occurrence metadata instead of
creating a different usage identity.

`sourcePath`, `targetPath`, and `targetImpactPaths` are absolute canonical JSON pointers.
`targetImpactPaths` is empty when only target identity matters. A missing target still has a
deterministic expected `targetPath`; missing-target edges remain in the graph.

Target-impact selection is adapter policy, not an implementation guess. Use these initial rules:

- ordinary reference-integrity-only edges have no content-impact path;
- an authoring Asset consumed as bytes includes only `/data/source/path`, `/data/contentHash`,
  `/data/kind`, `/data/extension`, and, for images, `/data/sampling` beneath that Asset record;
- Material dependencies include `/extends` and `/data` because current Material inheritance,
  Shader binding, textures, uniforms, and sampling are all presentation inputs;
- Shader dependencies include `/data` because source/interface/binding/compiled-path/hash/fingerprint
  changes can alter preparation or renderability;
- a Layout consumed by standalone or Room preview includes `/data/layoutKind`, `/data/target`,
  `/data/scalePolicy`, `/data/rml`, `/data/rcss`, `/data/lua`, `/data/script`, `/data/mount`, and
  `/data/dependencies`; standalone Layout preview additionally includes `/data/sampleState` and
  `/data/preview`, while a Room closure does not;
- a Character entering a Room through initial location includes `/data/initialWorldState`,
  `/data/defaults`, `/data/poses`, `/data/expressions`, and `/data/idles`; a Room-cast relationship
  includes `/data/defaults`, `/data/poses`, `/data/expressions`, and `/data/idles` but not dialogue
  presentation fields;
- an Interactable entering a Room includes `/data/initialState` and `/data/presentation`;
- a Script source relationship includes exactly `/data/source` on the Script record plus the
  path/hash impact of its source Asset when Asset-backed;
- project display/accessibility/default-font/system-Layout edges use only the exact project-field
  nodes named in Section 5.1; and
- an exit target Room edge remains identity-only and never includes the target Room's label or visual
  data.

Adapters may narrow a listed collection path to a selected array item's exact current pointer when
that remains correct across insertion/removal; they may not broaden it to the complete record or
collection merely for convenience. Array-identity changes are also captured through the source
mutation path and old/new graph union. Tests must prove every listed consumed path invalidates and
representative sibling/unlisted paths do not.

The initial `AUTHORING_DEPENDENCY_ROLES` registry is exactly:

```ts
const AUTHORING_DEPENDENCY_ROLES = [
  'explicit-ref',
  'variable-ref',
  'condition-variable',
  'extends',
  'entrypoint',
  'flow-target',
  'property-assignment',
  'localization-text',
  'layout-rml-source',
  'layout-rcss-source',
  'layout-lua-source',
  'layout-image',
  'layout-font',
  'layout-stylesheet',
  'layout-script',
  'layout-template',
  'layout-material',
  'shader-source',
  'script-source',
  'material-base',
  'material-shader',
  'material-texture',
  'character-pose-sprite',
  'character-pose-material',
  'character-expression-sprite',
  'character-expression-material',
  'character-room-placement',
  'room-background',
  'room-background-material',
  'room-cast-character',
  'room-overlay-layout',
  'room-placement-layout',
  'room-prop-asset',
  'room-prop-material',
  'room-environment-asset',
  'room-environment-material',
  'room-compose-script',
  'room-exit-target',
  'interactable-sprite',
  'interactable-material',
  'interactable-room-placement',
  'lua-possible-reference',
  'lua-explicit-reference',
  'system-layout',
  'default-font',
] as const;
```

Use `detail.systemRole` to distinguish Game HUD and the other system Layout roles. Generic `$ref`
relationships not requiring a more specific role remain `explicit-ref`; generic variable references
remain `variable-ref`. A new role is permitted only when an existing or newly approved schema
relationship cannot be represented by this vocabulary without losing impact or repair semantics. It
requires a role-registry change, graph test, and human-readable usage label in the same implementation
unit. `lua-possible-reference` always carries warning confidence and one or more lexical
occurrences; `lua-explicit-reference` always represents confirmed fallback metadata and does not
claim an inferred source occurrence. Storage and traversal remain role-agnostic.

Lua edge facets and repair policies are fixed:

- `lua-possible-reference` carries `validation`, never `reference-integrity` or
  `tooling-reference`, and uses `warning-only` repair;
- `lua-explicit-reference` carries `tooling-reference` plus `validation`, never
  `reference-integrity`, and uses `blocked` repair;
- either role gains the appropriate preview facet and broad target owning path only when that target
  projects into a focused admission consumed by the owning preview; and
- non-query-capable lexical candidates remain usage evidence only and must not pull target record
  data into a focused document.

Focused-query target impact is also fixed:

- definition-summary admission for Room, Scene, Dialogue, Character, and Interactable records uses
  only the target record's `/data/displayName`; Verb, Interaction, and Map summaries expose no
  display name in the current runtime contract and remain identity-only;
- Variable admission uses `/data/type`, `/data/defaultValue`, and `/data/enumValues`; scope and record
  label are not observable through the focused read API;
- Interactable-location admission uses `/data/initialState/location` plus the referenced Room and
  placement identities needed by that location;
- composition draft Character/Interactable admission is driven by the current Room draft and the
  source Room/subject relationships, not by unrelated fields on the candidate record; and
- property-value admission uses the property definition plus the owner record's same-kind
  inheritance chain and `properties` assignments exactly as the existing property resolver does.

A `property-value` explicit target or API-context candidate therefore projects to two correlated
graph relationships sharing one evidence/declaration identity:

1. a source-to-`property-definition` edge targeting `/properties/<propertyId>`; and
2. a source-to-owner-record `lua-explicit-reference` or `lua-possible-reference` edge whose
   `detail.propertyId` names the property and whose impact paths include `/extends` and `/properties`
   on every record in the resolved same-kind inheritance chain.

The focused admission projector emits one `{ownerKind, ownerId, propertyId}` entry only when both
relationships are structurally valid. Missing definition or owner/inheritance data remains precise
graph evidence and causes the consuming focused lookup to fail; it never falls back to a whole
project resolver. Tests must prove changes to observable paths invalidate and changes to labels,
descriptions, or other non-observable sibling fields do not.

`validation` on a possible edge means the relationship participates in warning-style Find Usages and
rename/delete preflight. A successfully analyzed lexical match does not by itself create a Problems
diagnostic; doing so for every exact string would make ordinary strings project-wide warning noise.
Problems receives diagnostics only for analysis failure/incompleteness, unavailable or hash-mismatched
source, invalid/duplicate explicit fallback metadata, or a missing explicit target. Find Usages and
preflight still label every inferred occurrence **Possible Lua usage**.

An Asset record's `data.source.path` and `contentHash` are node content, not graph targets. They are
read when an adapter creates a resource manifest entry. The graph never creates a fake filesystem
node or `asset-source` edge.

Localized text edges follow the actual default/fallback lookup, not every catalog entry sharing the
key:

1. Every localized source depends on `/localization/defaultLocale` and the expected
   `localization-key` node for `(defaultLocale, key)`.
2. When that default-locale entry exists, it is the only catalog value edge; fallback locale and its
   entry are not preview dependencies.
3. When the default entry is missing, the source also depends on `/localization/fallbackLocale` and,
   when the fallback locale differs, the expected `(fallbackLocale, key)` node.
4. Missing expected nodes remain in the graph for precise diagnostics. Equal default/fallback locales
   deduplicate to one node/edge.

Changing fallback locale or fallback text therefore invalidates a focused preview only while that
source actually falls back. Structural usage/search may still query catalog entries directly, but
preview closure must use these resolved edges.

Graph derivation is contribution-based:

```ts
type AuthoringDependencyContributionKey = string;
type AuthoringDependencyDerivationKey = string;

interface AuthoringDependencyGraphContribution {
  key: AuthoringDependencyContributionKey;
  ownerPath: JsonPointer;
  nodes: readonly AuthoringDependencyNode[];
  edges: readonly AuthoringDependencyEdge[];
  diagnostics: readonly AuthoringDependencyGraphDiagnostic[];
  derivationDependencies: readonly AuthoringDependencyDerivationDependency[];
  literalOccurrences: readonly AuthoringLiteralOccurrence[];
}

type AuthoringDependencyDerivationDependency =
  | { kind: 'source-asset'; assetId: string }
  | { kind: 'source-resolution-asset'; assetId: string }
  | { kind: 'project-field'; path: JsonPointer }
  | { kind: 'localization-lookup'; key: string }
  | {
      kind: 'property-resolution';
      ownerCollection: AuthoringCollectionKey;
      ownerId: string;
      propertyId: string;
    };

interface AuthoringDependencyGraphContributionSet {
  byKey: ReadonlyMap<AuthoringDependencyContributionKey, AuthoringDependencyGraphContribution>;
  contributionKeysByDerivationKey: ReadonlyMap<
    AuthoringDependencyDerivationKey,
    readonly AuthoringDependencyContributionKey[]
  >;
  contributionKeysByDecodedLiteral: ReadonlyMap<
    string,
    readonly AuthoringDependencyContributionKey[]
  >;
}
```

Contribution keys are deterministic canonical owner identities, not array indexes or random IDs.
One record contribution owns that record's node, generic references, typed semantic upgrades,
owner-local diagnostics, and explicit fallback metadata. Fixed project-field, property-definition,
and localization owners use separate fixed keys. `AuthoringDependencyDerivationKey` is the canonical
encoding of one declared non-owned input. Lua/RML literal occurrences are attached to the semantic
owner whose executable source consumes the target, even when the text bytes live in an Asset; a
source Asset is never itself the usage owner.

`AuthoringLiteralOccurrence` is analyzer output before candidate-target projection. It retains the
decoded complete literal, source container/region identity, decoded-region-local coordinates,
source identity/hash, and confidence provenance but does not yet contain `candidateTargets`.
Assembly or owner rederivation projects only those literals whose decoded value exists in the current
typed symbol table into `LuaReferenceOccurrence` evidence and `lua-possible-reference` edges. This
separation is mandatory: adding, deleting, or renaming an eligible top-level record or property
definition must update exact-literal evidence without rereading or relexing unrelated sources.

The contribution set stored for a published graph contains complete projected contributions for the
current symbol table. The renderer separately caches unprojected literal/source artifacts. Symbol-only
refresh creates and replaces a new complete projected owner contribution from that cache; it never
patches inferred edges in place and never leaves prior-symbol candidate edges attached.

Derivation dependencies are also mandatory for non-owned current inputs. At minimum:

- Asset-backed source and transitive RML/template closures declare `source-asset` dependencies;
- every declared Layout script/template Asset declares a distinct `source-resolution-asset`
  dependency so source path/kind/extension changes can alter URI resolution without claiming that an
  unreached dependency's bytes were consumed; an external source that resolves, including one whose
  bytes are currently unavailable or hash-invalid, also declares `source-asset` so a later hash/read
  correction reanalyzes the exact reached owner;
- localized text owners declare the localization key they resolve and the exact default/fallback
  project fields currently involved;
- explicit or lexical property-value admissions declare their property-resolution dependency; and
- any contribution whose shape depends on a fixed project-field value declares that project field.

The renderer canonicalizes these declarations into `contributionKeysByDerivationKey`. Changing a
derivation input rederives only the indexed contributions. Adding a new cross-owner derivation input
without declaring its reverse key and equivalence test is forbidden.

The full builder enumerates every required contribution key, derives each contribution, and assembles
the immutable graph. Incremental refresh derives a strict subset of those same keys. Assembly:

- canonicalizes and upgrades duplicate generic/typed relationships exactly once;
- projects cached literal occurrences against the current typed symbol table for only newly derived
  or explicitly reprojected owners;
- derives missing-target diagnostics from the final combined node/edge set rather than baking target
  existence into every source contribution;
- rebuilds all immutable traversal indexes deterministically from the combined contributions; and
- rejects conflicting ownership or metadata for the same canonical node/edge identity.

This keeps add/remove target behavior correct without rederiving every incoming source contribution.
For example, creating a previously missing Character node can clear missing-target diagnostics during
assembly while retaining unchanged Room-to-Character edges.

The pure builder returns:

```ts
interface AuthoringDependencyGraph {
  nodesByKey: ReadonlyMap<string, AuthoringDependencyNode>;
  edgesById: ReadonlyMap<string, AuthoringDependencyEdge>;
  outgoingEdgeIdsByNodeKey: ReadonlyMap<string, readonly string[]>;
  incomingEdgeIdsByNodeKey: ReadonlyMap<string, readonly string[]>;
  sourceNodeKeysByOwnedPath: ReadonlyMap<JsonPointer, readonly string[]>;
  diagnostics: readonly AuthoringDependencyGraphDiagnostic[];
}

interface AuthoringDependencyNode {
  key: AuthoringDependencyNodeKey;
  keyText: string;
  owningPath: JsonPointer;
  label: string;
}

interface AuthoringDependencyGraphDiagnostic {
  severity: 'warning' | 'error';
  code: string;
  path: JsonPointer;
  message: string;
}

interface AuthoringDependencyGraphSnapshot {
  projectInstanceId: string;
  projectRevision: number;
  graphRevision: number;
  graph: AuthoringDependencyGraph;
}
```

`keyText` is the canonical serialization used by maps and sorting. `graphRevision` is a
renderer-service monotonic integer that increments only when the published graph contents change; it
is not used as a preview document revision.

### 5.3 Traversal and queries

The pure graph provides deterministic, cycle-safe operations for:

- `outgoing(node)`;
- `incoming(node)`;
- `findUsages(target)`;
- filtered forward closure;
- filtered reverse impact closure;
- source-path ownership lookup;
- nested target lookup;
- preview-root impact from changed paths; and
- missing-target reporting.

Results sort by canonical source key, source path, role, target key, and edge ID.

Room preview closure is not only a forward traversal. It starts with the Room record, follows its
outgoing visual/UI/resource edges, and also includes incoming `character-room-placement` and
`interactable-room-placement` edges that target one of that Room's placements.

### 5.4 Compatibility projection

`ReferenceIndex` and `ReferenceUsage` remain temporarily as compatibility views. Their public result
shape and ordering remain unchanged for confirmed structural references while callers migrate.
Possible Lua usages are exposed through the graph-aware usage UI and preflight contracts rather than
silently injected into legacy compiler-link projections.

`buildReferenceIndex(project)` becomes a thin projection over confirmed graph edges carrying
`reference-integrity`. The compiler, project search, ID rename, deletion preflight, Variables,
Assets, and existing tests must not retain a second confirmed-reference scanner after migration.
Compiler linking consumes only `reference-integrity` edges from the authoring schema; explicit Lua
fallbacks carry `tooling-reference` instead, and neither fallback nor warning-level lexical candidates
become link errors or compiled-project dependencies.

### 5.5 Mutation facts and graph refresh

Add these fields to the authoritative renderer project state or an immediately adjacent dedicated
store; do not use a custom `window` event:

```ts
interface ProjectMutationChangeSet {
  projectInstanceId: string;
  projectRevision: number;
  kind:
    | 'load'
    | 'command'
    | 'transaction-step'
    | 'transaction-cancel'
    | 'persistence-rollback'
    | 'undo'
    | 'redo'
    | 'replace';
  affectedPaths: readonly JsonPointer[];
}

interface ProjectMutationPublication {
  previousProject: StructurallyAdmittedAuthoringProject | null;
  project: StructurallyAdmittedAuthoringProject;
  changeSet: ProjectMutationChangeSet;
}
```

Publication is one atomic renderer-store event containing immutable normalized document identities,
not a custom DOM event and not serialized duplicate project JSON. For revision `n > 1`,
`previousProject` is the exact admitted document published at revision `n - 1`; initial load uses
`null`. The graph service classifies each publication synchronously or retains the minimal immutable
old/new document pair until classification completes. It must not attempt to reconstruct old values
from the latest mutable store after later revisions have already arrived.

Rules:

- a successful command outside a transaction publishes one `command` mutation with its canonical
  `affectedPaths`;
- each successful command inside the repository's currently active transaction publishes one
  `transaction-step` mutation because the command store already exposes that intermediate working
  document to editors and previews;
- transaction commit publishes no content mutation and does not increment `projectRevision` when it
  only converts already published steps into one history/persistence unit;
- transaction cancellation restores the base document as one `transaction-cancel` mutation using
  the canonical union of the active transaction's affected paths; cancellation of a transaction
  with no published content change is a no-op;
- structural-persistence failure rollback publishes the paths restored by the rollback as one
  `persistence-rollback` mutation rather than mutating the project store silently;
- Undo and Redo publish the affected paths of the history entry being reversed/reapplied;
- project load, recovery reconstruction, project switch, and explicit document replacement publish
  `/` as the affected path;
- accepted project content is published as a new immutable normalized document identity; in-place
  mutation of the authoritative document is forbidden;
- `/editor`-only changes are metadata publications, not `ProjectMutationPublication` values; they do
  not increment `projectRevision`, rebuild graph content, or invalidate previews;
- no-op mutations do not increment `projectRevision`.

Graph refresh is incremental from the beginning. Graph-input classification must be generated from
the authoring component/schema definitions plus colocated adapter dependency declarations; it must
not be maintained as a disjoint handwritten path list.

Every authoring field definition must explicitly declare one intrinsic graph effect. There is no
default:

```ts
type AuthoringFieldGraphEffect =
  | { kind: 'none' }
  | { kind: 'owner-contribution' }
  | { kind: 'source-analysis' }
  | { kind: 'symbol-definition' }
  | { kind: 'structural' }
  | {
      kind: 'value-dependent';
      classify: AuthoringFieldGraphValueClassifierId;
    };
```

The classification is tooling/schema metadata and is never persisted in project JSON. Component
definition helpers generate canonical path patterns and owner resolution from this metadata. A new
field cannot compile or pass the schema-definition audit until its intrinsic graph behavior is
chosen explicitly. Reusable discriminated schemas such as text sources may use a named pure
value-dependent classifier when different variants have different effects.

Intrinsic metadata cannot describe every cross-record effect. Each typed graph adapter therefore
declares, beside its edge/contribution derivation, the target fields and reverse derivation keys it
consumes. For example, an Asset `contentHash` is intrinsically graph-neutral, while a Layout adapter
that consumes that Asset as Lua/RML source declares the hash as a `source-analysis` dependency.

The graph-input classifier is the compiled result of field metadata, structural collection rules,
and adapter consumption declarations. Adding a field or relationship that creates, removes,
retargets, relabels, changes evidence, changes source closure, or changes a cross-owner derivation
requires updating the colocated declaration and full-build-equivalence fixture in the same change.

The initial graph-input registry must include:

- record creation/removal, `id`, graph-owned `label`, `extends`, property-definition identity, and
  only property-assignment paths whose schema can themselves contain a graph relationship;
- every structural `$ref`, `$var`, condition Variable reference, flow target, entrypoint, startup
  hook, system Layout, default-font, localization selection/entry-existence, material reference, Room
  placement/exit identity/reference, and subject-location field consumed by graph adapters;
- every inline Lua-bearing field, explicit fallback declaration, Layout dependency declaration,
  source-Asset reference, and RML/template relationship consumed by Section 7; and
- Asset `source.path`/`contentHash` only when that Asset participates in a registered Lua/RML source
  closure. Ordinary image/audio/font/binary hash changes remain graph-stable and are handled only by
  focused-preview resource invalidation.

Representative graph-stable paths include inline Room description text, display positions, opacity,
order, visibility, transition timing, preview sample values, and other consumed visual/UI values that
do not alter a node, edge, graph diagnostic, source closure, or graph-owned label. They may still
invalidate one or more preview roots through Section 4.4. A Room-description keystroke therefore does
not rebuild graph contributions and does not rescan Lua source.

Existing localization text values, Variable defaults, property-definition defaults/types/enums,
record property-assignment values, and ordinary Asset bytes/hash metadata are also graph-stable when
their identity, source-analysis role, and relationship shape are unchanged. Their existing graph
edges already carry the exact target-impact paths needed to invalidate consuming previews.

The graph-input registry and edge `targetImpactPaths` serve different purposes and must not be
collapsed. The registry answers whether the dependency graph itself must change. `targetImpactPaths`
answer whether an already known dependent preview consumes changed target content. Most visual/UI
impact paths are intentionally graph-stable: they reuse existing edges to select stale previews, then
rebuild only focused documents.

The positive registry governs precise admitted project mutations, not arbitrary JSON blobs. Mutation
publishers must report the narrowest canonical changed leaf paths plus any structural owner path
required for add/remove/reorder semantics. Classification uses the previous and current normalized
project values at each path:

- a precise scalar/null leaf path whose generated field metadata is `none` is graph-stable;
- a matched path triggers the exact adapter, derivation-key, symbol-projection, or source-analysis
  work declared by that rule;
- record/map/array item creation or removal, ID changes, array reordering, replacement of an object or
  array, a path whose old/new ownership cannot be resolved, or an imprecise ancestor path is
  structural and must resolve to exact contribution owners or use full-build fallback; and
- `/`, load/recovery/project switch, schema migration replacement, and explicit whole-document
  replacement always use the full builder.

Therefore the implementation still optimizes for the smaller set of paths that affect graph
derivation, but every schema field is explicitly classified. Unknown schema paths, missing metadata,
unresolved owners, broad object/array replacement, and unrecognized variants fail safe to owner or
full rebuild; they never silently default to graph-stable. Exhaustive schema and adapter fixtures plus
development assertions enforce that maintenance contract.

Add one shared differential audit helper, conceptually
`assertGraphInputRegistryComplete(fixture, validMutations)`. For each supplied valid precise or
structural mutation it compares the registry classification and incremental result with fresh full
builds before and after the mutation. It fails when a path classified graph-stable changes canonical
graph output, when a registered path cannot identify its required owner/reverse dependency, or when
incremental output differs from the full builder. Every collection/schema adapter must provide
representative valid alternates for all relationship-bearing variants and structural operations.
Adding a new graph-bearing schema variant without extending this audit fixture is forbidden.

The initial behavior must include these representative classifications:

| Mutation | Graph work | Preview impact |
| --- | --- | --- |
| Room inline description text | None; reuse graph. | Owning Room. |
| Room background fit/color | None; reuse graph. | Owning Room. |
| Room background Asset/Material reference | Replace Room contribution. | Owning Room and old/new closure as applicable. |
| Ordinary referenced image `contentHash` | None; reuse graph. | Every consuming preview through existing resource edge. |
| Lua/RML source Asset path/hash | Reanalyze and replace indexed consuming owners only. | Every consuming preview selected from old/new graph. |
| Eligible top-level record/property-definition ID change | Replace identity owner and reproject decoded-literal owners; source-owner changes may rebind only cheap provenance. | Old and new dependents. |
| Room placement/exit ID change | Replace the Room contribution; no generic lexical reprojection. | Old and new structural/explicit dependents. |
| Existing localization text value | None; reuse graph. | Sources using that selected entry. |
| Default/fallback locale or relevant entry add/remove | Replace indexed localization owners. | Sources whose resolved entry may change. |
| Variable/property scalar value | None; reuse graph. | Focused sources admitted to that value. |
| `extends` or property identity structure | Replace indexed property-resolution owners. | Focused sources whose resolved chain may change. |

```ts
type AuthoringDependencyGraphMutationImpact =
  | { kind: 'graph-stable' }
  | {
      kind: 'incremental';
      contributionKeys: readonly AuthoringDependencyContributionKey[];
      sourceAnalysisOwnerKeys: readonly AuthoringDependencyContributionKey[];
      symbolProjectionOwnerKeys: readonly AuthoringDependencyContributionKey[];
    }
  | { kind: 'full-rebuild'; reason: 'load' | 'replace' | 'root-change' | 'classifier-fallback' };
```

The classifier is segment-aware and evaluates the previous and current structurally admitted project. It maps
array-item changes to their stable record/semantic owner rather than treating array indexes as
contribution identity. Record creation/removal and target creation/removal update the affected record
contribution; final assembly recalculates missing-target diagnostics. A declaration change updates
the declaring owner and the derivation reverse indexes produced by its replacement contribution.

Cross-owner changes are resolved through indexes rather than whole-project rescans:

- a source Asset `contentHash`/verified-byte change adds every semantic owner indexed by its reached
  `source-asset` derivation key to both `contributionKeys` and `sourceAnalysisOwnerKeys`;
- a declared Layout script/template Asset path/kind/extension change adds owners indexed by its
  `source-resolution-asset` key, because the mutation can make a prior URI resolve, stop resolving,
  or become ambiguous even when the dependency was not previously reached;
- changing default/fallback locale or adding/removing a catalog entry can change which localization
  node a source resolves through, so it adds only owners indexed for the affected lookup keys and
  project fields; editing the value of an already selected catalog entry is graph-stable;
- changing an `extends` chain or creating/removing/renaming a property definition or property owner
  can change property-resolution structure, so it adds only owners indexed for affected
  property-resolution keys; editing defaults, types, enum values, or assignment values is
  graph-stable preview content unless that exact schema path is independently reference-bearing;
- a record/property/Room-placement/Room-exit identity addition, deletion, or rename computes the old
  and new symbol values and adds only owners found in `contributionKeysByDecodedLiteral` for those
  values to `symbolProjectionOwnerKeys`; their cached source artifacts are reused; and
- transitive RML script/template dependencies index every consuming semantic owner, so changing one
  reached source reanalyzes only those owners.

If any required metadata, reverse index, or stable owner cannot be established, the classifier uses
the explicit owner/full-build fallback and emits a development diagnostic. Only a field explicitly
classified `none` is graph-stable.

Incremental replacement is not in-place mutable edge surgery. It removes complete affected
contributions, derives their replacements from the latest structurally admitted project and required source
analysis, reprojects cached literal artifacts for symbol-only owners, retains every unaffected
contribution, and deterministically reassembles one new immutable graph. Source analysis runs only
for `sourceAnalysisOwnerKeys`; all other affected owners reuse exact cached artifacts. The full builder
remains the correctness oracle and uses the same source-analysis, contribution-derivation, projection,
and assembly functions.

Graph refresh order is fixed:

1. Add the mutation's paths to the canonical segment-aware union of every path changed since the
   last published graph snapshot for this project instance.
2. Classify the mutation using generated field effects, structural rules, and adapter declarations
   against the previous and current structurally admitted projects; accumulate contribution keys, source-analysis owner keys, symbol-projection
   owner keys, or a full-rebuild flag across every unpublished revision.
3. Capture impacted preview roots from the old graph and the complete unpublished-path union.
4. When the accumulated graph impact is `graph-stable`, atomically advance `projectRevision` in a
   new snapshot wrapper while reusing the same `snapshot.graph` object and `graphRevision`, publish
   the impacted roots captured in step 3, clear the accumulated work through that revision, and stop;
   do not resolve source files or run graph adapters.
5. Otherwise, enter `updating`, resolve and analyze only cache misses required by accumulated
   `sourceAnalysisOwnerKeys`, and discard stale completions by project instance/revision.
6. Against the latest structurally admitted project, perform the required full build or replace only the
   accumulated contributions; reproject symbol-only owners from cached literal artifacts; then
   assemble one immutable graph and rebuild its reverse derivation indexes.
7. Capture impacted preview roots from the new graph and the same complete unpublished-path union.
8. Union old and new impacts, publish the current project revision, increment `graphRevision` only
   when assembled graph contents changed, and clear only work accumulated through that published
   revision.

```ts
type AuthoringDependencyGraphServiceState =
  | {
      status: 'updating';
      projectInstanceId: string;
      projectRevision: number;
      pendingAffectedPaths: readonly JsonPointer[];
      pendingContributionKeys: readonly AuthoringDependencyContributionKey[];
      pendingSourceAnalysisOwnerKeys: readonly AuthoringDependencyContributionKey[];
      pendingSymbolProjectionOwnerKeys: readonly AuthoringDependencyContributionKey[];
      fullRebuildRequired: boolean;
      phase: 'classifying' | 'resolving-sources' | 'deriving';
      previousSnapshot?: AuthoringDependencyGraphSnapshot;
    }
  | { status: 'ready'; snapshot: AuthoringDependencyGraphSnapshot };
```

Consumers may display `previousSnapshot` while resolving, but must compare its project revision and
must not use it to confirm a mutation or build a new focused document.

If a newer mutation supersedes an in-flight source resolution, its paths and graph work are merged
with—not substituted for—the still-unpublished work. A graph-stable mutation does not erase pending
contribution replacements, source-analysis work, or symbol reprojection. Stale completion is
discarded without clearing any union. Project switch resets all unions and caches with the project
instance. This rule covers multiple synchronous mutations as well as asynchronous source reads and
prevents a relationship change in an abandoned intermediate revision from escaping old/new impact
calculation.

The old/new union is mandatory. Moving a Character or Interactable from Bedroom to Hall invalidates
both Rooms.

Add a representative structural large-project full-build benchmark in Phase 2 and an enabled
Lua/RML-evidence full-build benchmark in Phase 3. Phase 5 adds mutation-sequence benchmarks and
instrumented contribution/source-analysis counts. Every incremental fixture must compare its final
graph byte-for-byte/canonically with a fresh full build of the same project. The required hot-path
fixtures prove zero graph derivation and zero Lua/RML reads for Room-description typing and other
graph-stable visual edits, one-owner replacement for a local reference edit, cached symbol-only
reprojection for target-ID changes, exact reverse-dependency replacement for localization/property
changes, and source-owner-only analysis for a referenced Lua/RML source change.

### 5.6 Repair policies

Repair descriptors contain only data. They do not store closures.

```ts
type AuthoringReferenceRepairPolicy =
  | { kind: 'set-null'; path: JsonPointer }
  | { kind: 'clear-field'; path: JsonPointer }
  | { kind: 'remove-array-item'; itemPath: JsonPointer }
  | { kind: 'remove-map-entry'; entryPath: JsonPointer }
  | {
      kind: 'replacement-required';
      path: JsonPointer;
      collection: AuthoringCollectionKey;
    }
  | { kind: 'warning-only'; reason: string }
  | { kind: 'blocked'; reason: string };
```

All paths are absolute. A repair plan records the graph/project revision on which it was generated
and must be regenerated if that revision is no longer current before confirmation.

The repair registry converts descriptors to JSON Patch operations. Array removals sharing a parent
are applied in descending index order. All repairs, record/nested-record deletion, ID remaps, and
editor metadata cleanup execute as one command transaction and one structural persistence unit.
Partial repair is forbidden.

The initial required repair matrix is:

| Deleted target | Relationship | Required automatic action |
| --- | --- | --- |
| Character | Room cast entry | Remove the complete cast array item. |
| Layout | Room overlay | Remove the complete overlay array item. |
| Layout | Room placement presentation | Set the placement `presentation.layout` to `null`. |
| Layout | project system Layout, including Game HUD | Set that role to `null`. |
| Script | Room composition binding | Set `room.data.compose` to `null`. |
| Asset | nullable Room background/prop/environment asset | Set the owning asset field to `null`. |
| Material | nullable Room background/prop material | Set the owning material field to `null`. |
| Material | required Room environment material | `replacement-required`; do not delete automatically. |
| Room placement | Character initial location | Move the Character to `{ kind: 'nowhere' }`. |
| Room placement | Interactable initial location | Move the Interactable to `{ kind: 'nowhere' }`. |
| Room | Character/Interactable initial location in that Room | Move the subject to `nowhere`. |
| Room | another Room's required exit target | `replacement-required`; do not delete automatically. |
| Any target | possible lexical Lua usage | `warning-only`; show preflight warning and do not rewrite source. |
| Any target | explicit Lua fallback | `blocked`; ordinary delete cannot proceed because source repair is unavailable. |

Other relationships use an adapter-provided safe policy or fail closed as `blocked` or
`replacement-required`. Force Delete remains an explicit advanced action that leaves dangling
references for Problems; it is never labeled as repair.

On entity rename, possible lexical usages produce the agreed warning and do not block. Explicit Lua
fallbacks require an explicit “rename without rewriting Lua” confirmation and are left unchanged so
the resulting missing-target diagnostic is not hidden by changing metadata while dynamic source
still references the old ID.

Deleting a Room placement must use a structural command with graph preflight. A normal field edit
must not silently remove a placement while leaving occupants dangling.

## 6. Focused live-preview contract

### 6.1 Preview root and validated inputs

Editor components request a root and inputs; they do not build documents or sequence transport.

```ts
type FocusedPreviewDocumentKind =
  | 'layout-preview'
  | 'shader-preview'
  | 'room-preview';

interface PreviewRootKey {
  kind: FocusedPreviewDocumentKind;
  recordId: string;
}

interface FocusedPreviewRequest<TInputs = unknown> {
  root: PreviewRootKey;
  inputs: TInputs;
}

type RoomPreviewInputs = {
  displayPreference: PreviewDisplayPreference;
};

type LayoutPreviewInputs = {
  displayPreference: PreviewDisplayPreference;
};

type ShaderPreviewInputs = Record<string, never>;
```

Room and Layout normalize `displayPreference` with
`normalizePreviewDisplayPreference()` and derive the effective profile with
`effectivePreviewDisplay()`. Project display/accessibility values remain project dependencies rather
than preview inputs. Shader's empty object canonicalizes to one constant input revision.

Each adapter owns a strict input schema and canonicalization. Input arrays preserve order only when
the adapter declares order semantic. A changed `inputRevision` is a same-root update, not a new root.
Pane IDs, tab IDs, lease IDs, and host IDs are not preview content identity.

The initial registry contains Room, Layout, and Shader adapters. Existing Character, Material,
Scene, Dialogue, and symbolic previews remain on their current compatibility rendering paths for
this implementation unit. They continue using the shared pool and do not gain another freshness
system. A later plan can add adapters for them to this registry.

### 6.2 Adapter boundary

```ts
interface FocusedPreviewAdapter<TInputs, TData> {
  kind: FocusedPreviewDocumentKind;
  inputSchema: z.ZodType<TInputs>;
  rootNode(project: StructurallyAdmittedAuthoringProject, recordId: string): AuthoringDependencyNodeKey;
  build(context: FocusedPreviewBuildContext<TInputs>): FocusedPreviewBuildResult<TData>;
}

interface FocusedPreviewBuildContext<TInputs> {
  project: StructurallyAdmittedAuthoringProject;
  graph: AuthoringDependencyGraphSnapshot;
  projectInstanceId: string;
  projectRevision: number;
  root: PreviewRootKey;
  inputs: TInputs;
  hostCapabilities: {
    activeShaderVariant: ShaderVariant;
  };
}

type FocusedPreviewBuildResult<TData> =
  | {
      ok: true;
      document: FocusedRecordPreviewDocument & { data: TData };
      diagnostics: readonly PreviewDiagnosticMessage[];
    }
  | {
      ok: false;
      diagnostics: readonly PreviewDiagnosticMessage[];
    };
```

Define one shared closed Shader variant contract and reuse it across Shader authoring/export,
focused-preview protocol, manifests, and host capabilities:

```ts
const shaderVariantValues = ['glsl-120', 'essl-100', 'essl-300'] as const;
type ShaderVariant = (typeof shaderVariantValues)[number];

const focusedBuiltinTemplateIdValues = [
  'layout-fragment-host-v1',
  'shader-square-v1',
] as const;
type FocusedBuiltinTemplateId = (typeof focusedBuiltinTemplateIdValues)[number];
```

Do not retain separate open `string` variant types. Unknown values are rejected at shared protocol
and authoring-schema boundaries and are never interpolated into resource paths.

Host-static fragment and Shader-square templates remain owned by the widget/native preview build and
are selected by the closed identifiers above. Applicable Layout/Room/Shader focused documents carry
the identifier and include it in their document revision, but never carry template RML/RCSS bytes or
manifest entries. Template bytes load once per host build identity. After renderer initialization,
the preview ready handshake reports the value from
the native renderer's authoritative `Renderer::active_shader_variant()` result. It is not inferred
from project settings, export profiles, requested compile variants, or record contents. The lease
captures it with `hostGeneration`, and adapters filter Shader metadata/manifests to that variant. An
empty or unsupported native value means the focused custom-Shader capability is unavailable and
must produce a readiness/capability diagnostic rather than a constructed path. Host capability
changes invalidate and rebuild the active root. Adapters never fetch files or call Electron.

The Layout adapter uses `layout-fragment-host-v1` only for `layoutKind: 'fragment'`; document Layouts
carry no fragment template ID. The Shader adapter uses `shader-square-v1`. Unknown or mismatched
template IDs fail strict decode rather than falling back to supplied template text.

The builder is pure with respect to the project and React state. It returns either:

- success: one focused document plus focused warning/info diagnostics; or
- failure: focused diagnostics and no document.

Builder diagnostics are not embedded in `data` and are not emitted by recursive widget inspection.
Every completed build attempt replaces builder diagnostics for the current lease/root scope before
the coordinator decides whether the document revision requires a transport send. Diagnostic-only
changes—such as merged `usageRoles` provenance that does not alter consumed resources—therefore
update the Problems surface without forcing native staging/apply.

### 6.3 Transport document shape

Extend the existing record `PreviewDocument` outer shape rather than introducing a second nested
envelope:

```ts
interface FocusedRecordPreviewDocument {
  kind: FocusedPreviewDocumentKind;
  recordId: string;
  revision: `sha256:${string}`;
  projectInstanceId: string;
  projectRevision: number;
  inputRevision: `sha256:${string}`;
  resourceRevision: `sha256:${string}`;
  resources: readonly PreviewResourceManifestEntry[];
  data: Record<string, unknown>;
}
```

`data` contains the mode-specific `schema` and `schemaVersion`. The outer document is validated
strictly at the shared protocol boundary. Migrated documents carry their complete authored display
environment inside `data`; the command-level optional `environment` field is removed after all
migrated call sites are converted.

For migrated Layout, Shader, and Room documents, `load-preview-document` and
`update-preview-document` atomically select the content mode from `document.kind`. The coordinator
does not send a preceding `set-preview-mode`. `set-preview-mode` remains only for unmigrated or
symbolic compatibility paths until those paths are migrated.

### 6.4 Resource manifest

The manifest contains only explicitly resolved project files whose bytes are consumed. It supports
authoring Assets and generated compiled Shader binaries because current Shader stages store compiled
runtime paths directly rather than through Asset records:

```ts
interface PreviewResourceManifestEntryBase {
  usageRoles: readonly string[];
  fetchProjectRelativePath: string;
  logicalPath: string;
  contentHash: `sha256:${string}`;
  byteSize: number;
}

type PreviewResourceManifestEntry =
  | (PreviewResourceManifestEntryBase & {
      resourceId: `asset:${string}`;
      sourceKind: 'authoring-asset';
      assetId: string;
      kind: AssetKind;
      sampling?: 'linear' | 'nearest';
    })
  | (PreviewResourceManifestEntryBase & {
      resourceId: `shader:${string}:${'vertex' | 'fragment'}:${string}`;
      sourceKind: 'shader-compiled-output';
      shaderId: string;
      shaderStage: 'vertex' | 'fragment';
      shaderVariant: ShaderVariant;
      kind: 'shader-binary';
    });
```

The initial focused resource-staging limits are shared protocol constants:

```ts
const FOCUSED_PREVIEW_RESOURCE_LIMITS = {
  maxResourceBytes: 128 * 1024 * 1024,
  maxTotalResourceBytes: 512 * 1024 * 1024,
} as const;
```

These are candidate staging/transport limits, not project import or packaged-runtime limits. Changing
them is a reviewed protocol change with TypeScript/widget tests and editor memory-profile evidence.

Rules:

- authoring Asset entries use `assetKindValues` from `authoring-assets.ts` and carry `assetId`;
- compiled Shader entries use `kind: 'shader-binary'` and carry Shader ID, stage, and variant;
- `byteSize` is a non-negative safe integer and participates in the canonical resource projection;
- an authoring Asset must have a valid recorded `byteSize` equal to its imported/reimported source
  bytes; a missing/invalid size is a focused builder error requiring reimport;
- `resourceId` uses exactly `asset:<assetId>` or
  `shader:<shaderId>:<vertex|fragment>:<variant>`;
- tighten the existing compiled-path keys to `Partial<Record<ShaderVariant, runtimePath>>` and add
  defaulted `compiledContentHashes: Partial<Record<ShaderVariant, sha256>>` and
  `compiledByteSizes: Partial<Record<ShaderVariant, nonNegativeSafeInteger>>` and
  `compiledInputFingerprints: Partial<Record<ShaderVariant, sha256>>` metadata beside them; the
  Shader compile workflow writes path, byte hash, byte size, and compile-input fingerprint
  atomically, legacy path-only/hash-only entries remain readable but require recompilation before
  focused native preview can consume them, and gameplay lowering continues emitting only the
  existing runtime path so compiled-project bytes do not change;
- extend `ShaderCompileOutput` with a SHA-256 computed from the bytes at `outputPath` after both a
  successful compile and a cache hit, plus the exact output byte count from the same read/stat
  verification; `cacheKey` remains an input/cache identity and is explicitly not accepted as a
  content digest;
- define one canonical compile-input fingerprint over every compile-relevant authored stage value,
  resolved source Asset content hash, interface/binding/uniform/sampler metadata, compiler options,
  stage, and variant; focused preview accepts a compiled output only when the stored fingerprint
  equals the fingerprint recomputed from the current normalized Shader stage;
- the editor authoring compile workflow uses the canonical
  `<projectRoot>/.noveltea/build` output root, verifies each returned `outputPath` is under that root,
  and verifies its suffix equals the normalized compiler `runtimePath`;
- `fetchProjectRelativePath` is the actual safe path served relative to the project root and must
  pass `isSafeProjectAssetPath`;
- the main-owned `/project-assets/` server canonicalizes its active project root and rejects
  symlink/realpath escape for every requested file; lexical `path.resolve` containment alone is not
  sufficient because manifests may legitimately traverse project subdirectories containing
  symlinks;
- for an authoring Asset, `fetchProjectRelativePath` is the Asset source path and `logicalPath` is
  exactly `project:/` plus that path;
- for a compiled Shader output, `fetchProjectRelativePath` is
  `.noveltea/build/<normalized-runtime-path>` while `logicalPath` is
  `project:/<normalized-runtime-path>`; the compiler response may provide a relative runtime path or
  a `project:/` path, but the editor normalizes it once and rejects any other scheme or unsafe path;
- the path portion of `logicalPath` must pass the same segment-safe validation before it is mapped to
  the Web filesystem;
- image sampling is explicit and defaults to `linear` only through the authoring Asset schema;
- entries sort by `resourceId`, `fetchProjectRelativePath`, `logicalPath`, `kind`, and usage roles;
- one resource/path pair appears once with merged sorted roles;
- `usageRoles` are editor diagnostic/provenance metadata only; canonical `resourceRevision`, native
  catalog equality, and staging cache identity exclude them, while all byte/path/hash/kind/sampling
  fields, including `byteSize`, remain included;
- before emitting a focused document, the builder rejects any entry above
  `maxResourceBytes` or any canonical manifest whose summed `byteSize` exceeds
  `maxTotalResourceBytes`; this preflight occurs without fetching bytes;
- conflicting metadata for one resource ID, one fetch path, or one logical path is a builder error;
- inline Layout/Script/Shader content and built-in engine resources are not manifest entries;
- a referenced Asset without a valid recorded SHA-256 `contentHash` and exact `byteSize` is a focused
  builder error and requires import/reimport;
- a consumed compiled Shader output without matching valid recorded SHA-256 hash and byte size is a
  focused builder error and requires recompilation; and
- only the active host Shader variant reported by the ready handshake is included; staging every
  compiled platform variant is forbidden; and
- path-only fallback is forbidden for both source kinds.

The widget derives a candidate physical destination from the validated path portion of `logicalPath`,
not from `fetchProjectRelativePath`, and writes only beneath a widget-owned generation namespace such
as `/assets/preview-generations/<generation>/`. The document cannot choose a physical Web filesystem
path. Fetch location, candidate physical storage, and runtime logical mount location are deliberately
separate because generated Shader binaries live under `.noveltea/build`, are staged under an
immutable candidate generation, and are exposed to native code at their `project:/shaders/...`
logical paths.

For each manifest entry whose `(projectInstanceId, logicalPath, contentHash)` is not already staged,
the widget prepares one candidate batch:

1. verifies the manifest's recorded per-entry and aggregate sizes against the shared limits;
2. fetches `/project-assets/<encoded fetchProjectRelativePath>` with `cache: 'no-store'` and rejects
   a present `Content-Length` that differs from `byteSize` or exceeds the remaining candidate budget;
3. reads the body through a bounded stream accumulator, aborting before further allocation/write when
   actual bytes exceed `byteSize`, `maxResourceBytes`, or the remaining aggregate budget;
4. requires the final byte count to equal `byteSize` and computes SHA-256 over those exact bytes;
5. rejects the candidate when the computed hash differs from `contentHash`;
6. writes the bytes to the candidate generation's distinct physical path; and
7. records the successful write only in candidate-local staging state.

Missing or dishonest `Content-Length` does not bypass the stream cap. No resource byte is written to
the Web filesystem until that entry has passed exact size and hash verification.

Only after every fetch, hash verification, and candidate-generation write succeeds does the widget
publish that generation's complete logical-to-physical map and increment
`resourceStageGeneration` once. The native request carries or resolves that immutable generation map;
candidate preparation never overwrites physical bytes reachable by the currently committed preview.

A failed batch discards its candidate map and never makes that generation selectable. Partially
written candidate files may be deleted eagerly or garbage-collected later, but cannot satisfy the
committed generation or any later request. Unchanged hashes may be hard-linked, copied, or referenced
from an immutable prior generation through widget-owned deduplicated storage, but logical reuse must
remain generation-correct. A project-instance switch clears committed generation ownership, resets
the generation counter to `0`, and prevents files from another project instance from satisfying a
request without a newly committed map.

The old committed generation and all of its retained native leases remain valid until the new
document commits. Commit switches the focused resource catalog/root by a non-failing handle swap;
retired generations are reclaimed only after no committed or in-flight owner can reference them.

Internal widget templates are host-static resources, not project assets. The host loads and validates
the complete closed template set once during initialization before emitting `ready`; the resulting
template registry is immutable for that `hostGeneration`. Missing/invalid built-ins prevent the
corresponding focused-document capability from becoming ready. Document apply never fetches,
replaces, or stages built-in template bytes.

### 6.5 Freshness coordinator

The renderer owns one coordinator for derived previews. Per active lease/root it tracks:

```ts
interface LivePreviewState {
  root: PreviewRootKey;
  desiredProjectRevision: number;
  desiredInputRevision: string;
  desiredDocumentRevision?: string;
  appliedDocumentRevision?: string;
  status: 'unbuilt' | 'stale' | 'building' | 'applying' | 'fresh' | 'failed';
}
```

`PreviewHostLease` exposes a monotonic `hostGeneration` and immutable capabilities for the current
iframe/MessagePort connection, including closed `activeShaderVariant: ShaderVariant`. The generation
increments on host recreation or reconnect, is captured with every send, and is cleared/replaced
when readiness is lost. The current boolean `readyHostIds` cache is insufficient because it cannot
distinguish a reconnected transport from the connection that applied the prior revision.

Required ordering:

- coalesce project/input changes to one build on the next animation frame;
- allow at most one apply in flight per lease;
- retain at most one latest pending desired state while apply is in flight;
- after completion, discard an intermediate pending state and build directly from the newest project
  and inputs;
- use `load-preview-document` for the first document after lease acquisition, root change, reconnect,
  or project-instance change;
- use `update-preview-document` only for the same committed root on the same lease/host generation;
- replace the current builder diagnostics even when the built `revision` equals the applied revision,
  then do not send that unchanged document;
- use `AbortController` for widget fetches and an apply-sequence guard even when abort cannot stop a
  completed response;
- treat supersession as normal control flow, not a diagnostic;
- replay the latest complete document after host reconnect;
- reveal a newly claimed root only after its document commits;
- keep a same-root host visible while a replacement prepares.

Every active focused root observes authoritative `projectRevision` advancement. A current graph
impact result may prove that a mutation is unrelated and skip the build. A graph-stable root-owned or
target-impact mutation may schedule the affected build immediately without waiting for a new graph
object. When the current graph is stale, updating, unavailable, or cannot classify impact safely,
the coordinator conservatively schedules one build for the active root instead of making preview
freshness generally depend on graph availability.

An adapter may declare that a particular build requires current graph topology, such as reverse Room
occupant closure after a structural location change. In that case the coordinator keeps the previous
visual while waiting for the graph snapshot matching the desired project revision, then builds once
from the latest state. This is adapter-specific; graph readiness is not a universal prerequisite for
ordinary root-owned content builds.

The focused document revision is the final correctness and transport-deduplication authority. A
conservative build whose document revision equals the applied revision replaces current builder
diagnostics but sends no native command. Preview-input changes mark only roots whose adapter consumes
that input stale. Inactive roots are not built until lease acquisition and then build once from the
latest project, graph state when required, and inputs.

### 6.6 Protocol acknowledgement

Successful document commands return this payload inside the existing `command-result` message:

```ts
interface AppliedPreviewDocumentResult {
  disposition: 'applied' | 'unchanged' | 'superseded';
  projectInstanceId: string;
  kind: FocusedPreviewDocumentKind;
  recordId: string;
  revision: string;
  resourceStageGeneration: number;
}
```

The transport resolves `loadPreviewDocument()` and `updatePreviewDocument()` with this result. The
coordinator accepts it only when request ID, lease, host generation, project instance, root, and
revision still match the current desired transaction.

### 6.7 Diagnostic scopes

```ts
interface PreviewDiagnosticScope {
  hostId: string;
  leaseId: string;
  projectInstanceId: string;
  kind: FocusedPreviewDocumentKind;
  recordId: string;
  projectRevision: number;
  inputRevision: string;
  documentRevision?: string;
}
```

Preview Manager adds `replaceDiagnostics(scope, diagnostics)` and `clearDiagnostics(scope)`. Pooled
host messages are stamped with the current lease scope before entering the manager. The replacement
key is `(hostId, leaseId, projectInstanceId, kind, recordId)`; `revision` is retained as diagnostic
metadata as `documentRevision` when available, and replacing the key removes diagnostics from every
older attempt of that leased root. Builder failure occurs before a focused document/resource revision may exist, so it
uses the desired `projectRevision` and `inputRevision` with no fabricated `documentRevision`.
Widget/native diagnostics require the actual applied/rejected document revision. Lease release clears
that key. Do not create a second focused-preview session registry beside the existing pool: add one
bridge from pooled lease messages into the manager, while legacy additive session diagnostics remain
only for unmigrated/Play compatibility paths. Unscoped native or widget diagnostics from a migrated
document are protocol errors.

## 7. Lua and RML reference analysis plus explicit fallback dependencies

Focused preview cannot expose the complete project merely to make arbitrary Lua lookups succeed.
The editor therefore derives likely dependencies automatically from all authoring-owned Lua, while
also permitting explicit fallback declarations for dynamic references that lexical analysis cannot
discover. The derived analysis is tooling state; it is never persisted as project authority.

### 7.1 Scoped identity and confidence

Top-level authoring IDs remain collection-scoped. Nested IDs remain owner-scoped. This plan does not
introduce project-wide ID uniqueness. Existing references, compiler symbols, save units, tabs,
metadata, runtime APIs, and rename commands continue identifying top-level records as
`{ collection, id }`.

Until API-context-aware analysis exists, a decoded Lua string literal that exactly equals more than
one ID in the eligible projection symbol set from Section 7.2 produces one ambiguous occurrence with
every matching candidate target. Each inferred candidate is warning-level and has confidence
`lexical`; it is not a compiler-link error, structural admission error, blocking delete reference,
or automatically repairable edge. It does, however, participate in focused-preview admission and
invalidation. Explicit fallback dependencies have confidence `explicit` and are confirmed
dependencies.

### 7.2 Shared lexical analyzer

Add one pure `LuaLexicalReferenceAnalyzer`. It must lex enough Lua to identify comments and string
literals accurately without evaluating code or building a semantic AST. It must:

- recognize single-quoted, double-quoted, and all valid long-bracket strings;
- decode ordinary Lua escape sequences sufficiently to recover the complete literal value;
- ignore line comments, long comments, and string-like text inside comments;
- emit complete decoded literal occurrences independently of the current project symbol table;
- preserve case exactly and never emit substring or bare-identifier candidates;
- continue returning earlier valid occurrences after an unterminated later string/comment;
- emit a non-blocking analysis diagnostic for malformed or unsupported lexical constructs; and
- recognize direct string-code arguments to both RmlUi Element and Context `AddEventListener`
  overloads and direct string-code arguments to the bare global `load(...)`, then recursively analyze
  each decoded argument as embedded Lua.

Lexing follows the repository's required Lua 5.5 lexical rules, including quoted-string escapes,
decimal/hex/Unicode escapes, escaped newlines, `\z`, and arbitrary `[` `=`* `[` long-bracket
delimiters. The bounded `AddEventListener` recognizer operates on lexer tokens: the callee's terminal
member must be exactly `AddEventListener`, and the second positional argument must be one direct
string literal. It accepts both `receiver:AddEventListener(event, "code", ...)` and
`receiver.AddEventListener(event, "code", ...)`; indexed members such as
`receiver["AddEventListener"]` are deferred. The bounded `load` recognizer requires the callee to be
the bare identifier `load` and its first positional argument to be one direct string literal; member
calls such as `object.load` are not assumed to be Lua's loader. This lexical pass does not perform
binding/shadow analysis, so a locally shadowed bare `load` may conservatively produce possible
evidence. Concatenated, computed, table-provided, variable, aliased, or indirect code strings are
deferred.

The initial analysis limits are fixed shared constants:

```ts
const AUTHORING_SOURCE_ANALYZER_VERSION = 'lua-rml-v1' as const;

const LUA_REFERENCE_ANALYSIS_LIMITS = {
  maxSourceBytes: 4 * 1024 * 1024,
  maxSnapshotBytes: 64 * 1024 * 1024,
  maxSnapshotLiteralOccurrences: 1_048_576,
  maxTemplateDepth: 32,
  maxTemplatesPerLayout: 1024,
  maxEmbeddedListenerDepth: 8,
  maxLiteralOccurrencesPerSemanticOwner: 65_536,
} as const;
```

Any change that can alter extracted regions, decoded literal values, region provenance/local
coordinates, diagnostics, or template traversal must change `AUTHORING_SOURCE_ANALYZER_VERSION` and
its cache-key tests in the same implementation unit.

Limits count original UTF-8 bytes and unique resolved template Assets. Asset-backed bytes count once
per physical `(projectRelativePath, contentHash)` even when several Asset IDs or semantic owners
reuse them; inline bytes count per authored container. Literal occurrences count after owner
projection because each projected occurrence consumes graph memory/provenance independently.
`maxSnapshotBytes` and
`maxSnapshotLiteralOccurrences` apply to the complete logical source snapshot required by the target
project revision, including inline sources and source/cache hits; a cache-miss-only IPC request must
not reset either aggregate budget. Main-process per-request limits are defense in depth, not a
replacement for this renderer-owned complete-snapshot accounting. Exceeding a limit terminates only
the affected owner/closure with a stable analysis warning and marks that analysis incomplete; the
graph still publishes other structural/evidence results. A focused candidate that would execute an
incomplete source/closure fails locally and preserves the prior visual. Limits are not silently
raised per call. Complete snapshot candidates sort by canonical semantic owner/source identity before
the aggregate limits are applied; Asset load candidates additionally sort by
`(projectRelativePath, contentHash, readKey)`. Entries or owners beyond a limit become deterministic
`unavailable`/incomplete results rather than depending on cache state or filesystem completion order.

The graph projection target symbol set is exactly:

- every top-level authoring record in `authoringCollectionKeys`;
- every property-definition ID.

Localization keys and Asset aliases are excluded from generic lexical matching because they have
separate identity and rename semantics.

Room placement and exit IDs are also excluded from generic lexical matching. They are owner-scoped,
the focused Lua provider exposes no unqualified placement/exit lookup, and a bare decoded string
cannot identify the owning Room. Including every repeated `default`, `north`, or similar nested ID
would create noisy ambiguous usages and potentially project one literal to an unbounded number of
targets without enabling a valid focused query. Placement/exit nodes remain first-class structural
graph targets and can be declared only through the qualified `room-placement`/`room-exit` explicit
fallback forms in Section 7.6.

Construct one deterministic `ReadonlyMap<string, readonly AuthoringDependencyNodeKey[]>` from that
symbol set before projecting analyzed owners. Candidate arrays sort by canonical node key. Projection
is one decoded-value map lookup per cached literal occurrence; implementations must not rescan every
project record for every string literal. The source analyzer itself never receives this map. This
ensures target identity changes can reproject indexed owners without rereading or relexing source.

Source discovery is typed, not a recursive search for properties named `source`. One shared
`collectAuthoringLuaSources()` must cover exactly every current authoring execution surface:

- `/startupHook/source`;
- every Script record's inline or Asset-backed source;
- every Layout's dedicated Lua source and the RML-derived sources in Section 7.3;
- every `lua-predicate`, `lua-expression`, and `run-lua-effect` instance wherever the shared
  condition/text/effect schemas are embedded;
- every Scene `run-lua` step; and
- every Dialogue `run-lua` segment.

Tests and future collection adapters participate automatically only when their strict schema embeds
one of those shared variants or adds a newly registered typed Lua-source descriptor. Adding a new
Lua-bearing schema requires updating the central source registry and its exhaustive fixture in the
same change.

### 7.3 RML Lua source extraction

Add `saxes` version `6.0.0` as a direct editor development dependency, matching the version already
resolved in the repository lockfile, and use it for strict source-aware RML/XML parsing; do not rely
on a transitive dependency, browser `DOMParser`, or jsdom in shared code. Add one
`RmlLuaSourceExtractor` that extracts
executable Lua with deterministic source-container and decoded-region provenance from all currently
supported RmlUi locations:

- every RML event attribute recognized by the `on*` convention, including capture/custom-event
  variants;
- every inline `<script>` element body;
- every `<script src="...">` source resolved through declared Layout script dependencies;
- every transitively referenced RML template resolved through declared Layout template
  dependencies, including that template's event attributes and script elements; and
- direct string-code arguments to RmlUi Element/Context `AddEventListener`, through the lexical
  analyzer.

`saxes` is the structural parser and entity decoder. This implementation unit does not build a
rewrite-grade XML/entity offset map. Event attributes use the decoded values and line/column events
reported by the structural parser as navigation anchors. Pair `saxes` only with one narrow
deterministic raw-text masker needed for RmlUi's script/style parsing semantics; it must not
independently decide element nesting, template semantics, event attributes, or which sources execute
Lua. A second general-purpose RML parser or regex-only extraction path is forbidden.

RmlUi-specific CData-tag behavior is mandatory. RmlUi treats `<script>` and `<style>` body content as
raw text until the matching end tag, even without an XML `<![CDATA[...]]>` wrapper. Before structural
parsing, the raw-text masker creates a same-UTF-16-length parser view in which raw script/style body
characters are replaced with spaces while original CR/LF code units are preserved. `saxes` parses
that masked view and remains authoritative for document structure; extraction reads `<script>` bytes
from the original unmasked source. The masker records only deterministic raw-body boundaries and
line/column anchors, must recognize quoted `>` characters in the start tag, reject a
missing/malformed matching end tag, and never interpret tags, entities, or XML CDATA wrappers inside
the raw body. The Lua analyzer
receives those original body bytes exactly as pinned RmlUi 6.2 passes them to the document script
loader; `&quot;` remains six Lua-source characters and `<![CDATA[` remains literal Lua source when used
inside `<script>`. Tests must include Lua `<`, `>`, `&`, XML-looking strings/comments, literal CDATA
wrapper text, and multiple adjacent script/style tags.

Template traversal must be cycle-safe and hash-aware. Ordinary text, `data-*`, style attributes, and
arbitrary non-event attributes are not Lua. Dynamically generated RML, including strings assigned to
`inner_rml`, is a known limitation deferred to API-context-aware analysis.

Event-attribute names are normalized to lowercase and match `on` followed by at least one valid XML
name character; the optional terminal `capture` suffix remains part of the recognized RmlUi binding.
This intentionally supports custom event names without maintaining a hard-coded event list. XML
character/entity decoding is applied before Lua analysis. Navigation identifies the containing
source and extracted region; exact original entity spans are deferred with source rewriting.

Each extracted region records deterministic provenance back to the authoring field or verified
source Asset:

```ts
interface EmbeddedLuaSourceRegion {
  semanticOwner: AuthoringDependencyNodeKey;
  sourceKind:
    | 'lua-field'
    | 'rml-event-attribute'
    | 'rml-inline-script'
    | 'rml-script-src'
    | 'rml-template'
    | 'lua-listener-string'
    | 'lua-load-string';
  sourcePath: JsonPointer;
  sourceAssetId?: string;
  containerContentHash: `sha256:${string}`;
  regionOrdinal: number;
  parentRegionOrdinal?: number;
  containerLine: number;
  containerColumn: number;
  decodedSource: string;
}

interface AuthoringLiteralOccurrence {
  sourcePath: JsonPointer;
  sourceAssetId?: string;
  sourceContentHash: `sha256:${string}`;
  regionOrdinal: number;
  regionStartUtf16: number;
  regionEndUtf16: number;
  line: number;
  column: number;
  rawLiteral: string;
  decodedValue: string;
  literalKind: 'single-quoted' | 'double-quoted' | 'long-bracket';
  sourceKind: EmbeddedLuaSourceRegion['sourceKind'];
}

interface LuaReferenceOccurrence {
  sourcePath: JsonPointer;
  sourceAssetId?: string;
  sourceContentHash: `sha256:${string}`;
  regionOrdinal: number;
  regionStartUtf16: number;
  regionEndUtf16: number;
  line: number;
  column: number;
  rawLiteral: string;
  decodedValue: string;
  literalKind: 'single-quoted' | 'double-quoted' | 'long-bracket';
  sourceKind: EmbeddedLuaSourceRegion['sourceKind'];
  confidence: 'lexical' | 'api-context';
  candidateTargets: readonly AuthoringDependencyNodeKey[];
}
```

`AuthoringLiteralOccurrence` is the cacheable analyzer result. `LuaReferenceOccurrence` is the graph
projection produced only when `decodedValue` exactly matches one or more current typed target
symbols. Projection copies region provenance/local coordinates from the literal occurrence, adds
confidence and the sorted current candidate list, and never mutates the cached artifact.

`regionOrdinal` is assigned by deterministic extraction order within one source container.
`parentRegionOrdinal` links nested listener/load string regions to the decoded region that contained
their literal. `regionStartUtf16`/`regionEndUtf16`, `line`, and `column` are local to that region's
`decodedSource`; line and column are 1-based and the column counts UTF-16 code units. The container
line/column is an informational navigation anchor, not a rewrite contract. CRLF is one line break and
source newlines are never normalized. Inline source hashes are SHA-256 over original UTF-8 bytes;
Asset-backed hashes are the verified Asset `contentHash`. Asset text must be strict UTF-8 with an
optional UTF-8 BOM, which is excluded from decoded Lua/RML source.

`sourcePath` is the canonical authoring pointer that introduces the container: the exact inline
source field, source-Asset reference, or declared script/template dependency item. `sourceAssetId`
identifies the physical source when the container is Asset-backed. Find Usages opens that container
and identifies the deterministic region/local occurrence. Exact original byte spans, XML entity
mapping, nested decoded-to-container composition, encoding-preserving replacement, and overlap-safe
rewrite coordinates are explicitly deferred to the later script-refactoring plan.

One graph edge represents one `(semantic owner, sourcePath, target, role)` relationship. Repeated
mentions of that target within the same source path are retained as sorted `lua-occurrence` entries
inside the edge's `evidence` array rather than becoming duplicate Find Usages rows. An ambiguous
literal is copied as evidence onto each candidate-target edge and retains its complete sorted
`candidateTargets` list so the UI can group those edges back into one ambiguous source occurrence.
Evidence sorts by kind and canonical evidence path; Lua occurrence ties then sort by UTF-16 start/end
offset within `regionOrdinal`, decoded value, and canonical candidate-target list.

### 7.4 Source ownership and Script Assets

`kind: 'script'` Assets remain permitted only as source-file artifacts. They provide path,
content-hash, import/reimport, external-editor, package, and RmlUi `<script src>` support. They are not
independently executable Script components and do not become graph usage owners merely because the
file contains an ID.

The semantic consumer owns every occurrence:

- a Script record owns occurrences from its inline or Asset-backed source;
- the `/startupHook` project-field node owns occurrences from project startup Lua;
- a Layout owns occurrences from its dedicated Lua source, RML events, inline scripts, declared
  external scripts actually reached by `<script src>`, and declared templates actually reached by
  the RML template-link closure;
- a Room/Scene/Dialogue/Verb/Interaction/Test source location owns its inline Lua occurrence; and
- one shared source Asset consumed by several semantic owners is analyzed once and projected as one
  usage per consuming owner.

An unreferenced Script Asset contributes no entity usage. Removing Script Assets entirely is outside
this plan because existing Layout and RmlUi external-source behavior depends on source-file Assets.
Likewise, merely listing an Asset in `Layout.dependencies.scripts` or
`Layout.dependencies.templates` creates the normal Layout-to-Asset dependency but does not create
Lua occurrence edges or focused admission unless RML resolution actually reaches that source.

Layout execution gating follows current repository behavior and is not reinterpreted by this plan:

- `layout.script.enabled` gates only the dedicated `layout.lua` source component injected by
  `LayoutRealizer`;
- Lua embedded directly in authored RML through event attributes, inline/external `<script>`
  elements, templates, direct-string `AddEventListener`, or direct-string `load` remains part of the
  RML document and executes whenever that document is mounted; and
- lexical analysis still indexes disabled dedicated Lua for Find Usages, but disabled dedicated Lua
  contributes no focused-preview admission or preview invalidation facet until it is enabled.

The permanent Layout documentation must be corrected to state this exact distinction. Expanding
`script.enabled` into a whole-document RML Lua kill switch would require a separate runtime behavior
change and is not introduced here.

The pure analyzers consume supplied text only. Add a session-local `LuaSourceSnapshot`, built before
the graph snapshot is published, that eagerly reads every referenced textual Asset participating in
analysis: Script-record sources, Layout dedicated Lua sources, Layout RML sources, declared external
scripts, and declared RML templates. Reads use the safe project-file service and verify bytes against
the recorded `contentHash`.

```ts
interface LuaSourceSnapshot {
  entriesByAssetId: ReadonlyMap<string, LuaSourceSnapshotEntry>;
}

type LuaAnalysisInput =
  | { mode: 'disabled' }
  | { mode: 'enabled'; sources: LuaSourceSnapshot };

interface VersionedLuaSourceSnapshot {
  projectInstanceId: string;
  projectRevision: number;
  sources: LuaSourceSnapshot;
}

type OwnerNeutralEmbeddedLuaSourceRegion = Omit<
  EmbeddedLuaSourceRegion,
  'semanticOwner' | 'sourcePath' | 'sourceAssetId'
> & {
  sourceUrl: string;
};

type OwnerNeutralLiteralOccurrence = Omit<
  AuthoringLiteralOccurrence,
  'sourcePath' | 'sourceAssetId'
> & {
  sourceUrl: string;
};

interface OwnerNeutralSourceDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  sourceUrl: string;
  regionOrdinal?: number;
  line?: number;
  column?: number;
}

interface AuthoringSourceContentArtifact {
  analyzerVersion: string;
  sourceContentFingerprint: `sha256:${string}`;
  regions: readonly OwnerNeutralEmbeddedLuaSourceRegion[];
  literalOccurrences: readonly OwnerNeutralLiteralOccurrence[];
  diagnostics: readonly OwnerNeutralSourceDiagnostic[];
  complete: boolean;
}

interface AuthoringSourceAnalysisArtifact {
  semanticOwnerKey: AuthoringDependencyContributionKey;
  analyzerVersion: string;
  sourceContentFingerprints: readonly `sha256:${string}`[];
  ownerProjectionFingerprint: `sha256:${string}`;
  sourceAssetIds: readonly string[];
  regions: readonly EmbeddedLuaSourceRegion[];
  literalOccurrences: readonly AuthoringLiteralOccurrence[];
  diagnostics: readonly AuthoringDependencyGraphDiagnostic[];
  complete: boolean;
}

type LuaSourceSnapshotEntry =
  | {
      status: 'ready';
      assetId: string;
      projectRelativePath: string;
      contentHash: `sha256:${string}`;
      text: string;
      hadUtf8Bom: boolean;
    }
  | {
      status: 'unavailable';
      assetId: string;
      expectedContentHash: string | null;
      diagnostic: AuthoringDependencyGraphDiagnostic;
    };
```

The owner-neutral region/literal/diagnostic types contain source kind, canonical source URL/base,
content hash, region ordinals, decoded source, decoded-region coordinates, and parser/lexer messages,
but no semantic owner key, authoring JSON pointer, record ID, Asset ID, or graph diagnostic path.
`bindAuthoringSourceOwner()` converts them to the owner-projected types above by attaching exact
authoring provenance and graph diagnostics. This binding is deterministic and performs no XML parse
or Lua lex.

Filesystem ownership is exact. Add one batch IPC contract named
`READ_PROJECT_TEXT_SOURCES` across `editor/src/shared/ipc-channels.ts`,
`editor/src/shared/electron-api.ts`, `editor/src/preload.ts`, the main IPC registration, and
`editor/src/main/services/project-file-service.ts`:

```ts
interface ReadProjectTextSourcesRequest {
  projectReadSessionId: string;
  entries: Array<{
    readKey: string;
    projectRelativePath: string;
    expectedContentHash: `sha256:${string}`;
  }>;
}

interface ReadProjectTextSourcesResponse {
  entries: ProjectTextSourceReadEntry[];
}

type ProjectTextSourceReadEntry =
  | {
      status: 'ready';
      readKey: string;
      projectRelativePath: string;
      contentHash: `sha256:${string}`;
      text: string;
      hadUtf8Bom: boolean;
    }
  | {
      status: 'unavailable';
      readKey: string;
      projectRelativePath: string;
      expectedContentHash: string | null;
      code: string;
      message: string;
    };
```

The main process issues an opaque `projectReadSessionId` after a successful project open/create or
other explicit active-project-root assignment and binds it to the canonical active project root.
Ordinary Save and the current copy-style Save As do not rotate it because they do not change the
active root. The ID is renderer-visible but carries no path information, is invalidated on project
switch/close, and is never persisted. The new text read API must not accept a renderer-selected
project root or treat `projectFilePath` in a request as authority; otherwise it would add an
arbitrary-root text-read primitive that the existing project-asset server deliberately avoids by
owning its active root in main.

The renderer groups required Asset descriptors by exact
`(projectRelativePath, expectedContentHash)`, assigns one deterministic request-local `readKey` per
group, and submits one canonically sorted, duplicate-free physical-source batch for the current
project revision. The main process treats `readKey` only as an opaque response correlation value.
After response, the renderer fans one terminal physical result back out to every current Asset ID in
that group when constructing `LuaSourceSnapshot.entriesByAssetId`. Multiple Asset records that point
to the same verified source therefore cause one file read/decode without losing Asset-level graph
provenance.
Only Assets with a syntactically valid recorded SHA-256 hash enter the IPC batch. A referenced text
Asset with a missing/invalid `contentHash` becomes a renderer-created `unavailable` snapshot entry
with a stable reimport-required diagnostic and is never sent with a placeholder hash.
The main service validates each project-relative path with `isSafeProjectAssetPath`, resolves it
beneath the root bound to `projectReadSessionId`, rejects an unknown/stale session and
symlink/realpath escape, enforces the
shared per-source and aggregate byte limits before allocating decoded strings, computes SHA-256 from
the exact bytes, requires equality with `expectedContentHash`, and decodes with fatal UTF-8 plus an
optional BOM. It returns one terminal entry per request entry in request order; one failed entry does
not reject unrelated entries. The API never returns arbitrary absolute paths, data URLs, or binary
content, and shared graph/analyzer modules never call Electron directly.

The renderer graph service fans each `ProjectTextSourceReadEntry` out to the corresponding
`LuaSourceSnapshotEntry` values and owns construction of `AuthoringDependencyGraphDiagnostic` for
each affected Asset/semantic owner. Main-process file services do not import graph modules or graph
diagnostic types.

`resolveProjectAssetUrl` is not reused for this purpose. It is an image/URL presentation API and does
not provide the required byte-hash, UTF-8, batch, or revision semantics.

The renderer graph service rejects a versioned snapshot whose project instance/revision does not
match the requested graph build, then passes only `sources` to the pure builder. In enabled mode,
every Asset-backed source descriptor must find exactly one matching entry; missing entries are a
graph-service contract error rather than an implicit filesystem read. Disabled mode skips lexical
source discovery but still derives all structural and supported explicit-fallback edges from project
content.

`buildAuthoringDependencyGraph(project, luaAnalysis)` remains pure. Snapshot text and analysis
results are not persisted. The pure full builder may construct both content artifacts and
owner-projected `AuthoringSourceAnalysisArtifact` values internally, while the renderer service
caches them only for the current project instance. `sourceContentFingerprint` is canonical over
analyzer version, source kind, exact inline/source-Asset bytes, canonical logical source URL/path and
URI-base inputs, content hashes, and the ordered transitive RML/template closure. It excludes
semantic-owner identity, record/Asset IDs, authoring JSON-pointer paths, and graph diagnostics.
`ownerProjectionFingerprint` adds the semantic owner, current source Asset IDs, canonical introducing
paths, and execution provenance needed to bind content artifacts into one contribution. Both exclude
the current target symbol table, explicit fallback metadata, execution-gating values such as
`layout.script.enabled`, and unrelated project values. Those values may rederive/project a
contribution while reusing the same content artifacts. An unreadable or hash-mismatched source emits
an analysis warning and cannot satisfy a focused candidate that consumes that source.

Asset-source resolution is asynchronous and its physical byte result is cached by
`(projectInstanceId, projectRelativePath, contentHash)`. Asset IDs remain in snapshot/provenance
records but not the physical byte key, so renaming an Asset record with the same verified path/hash
does not reread the file. The path is required even when bytes are unchanged because it is the base
for relative RML script/template resolution. Project publication is not blocked on filesystem I/O.
Owner-neutral content analysis is cached by
`(projectInstanceId, sourceContentFingerprint, analyzerVersion)`. Asset-backed content additionally
uses the file-level key
`(projectInstanceId, projectRelativePath, contentHash, analyzerVersion, sourceKind)` so one
physical source is parsed/lexed once and composed into every consuming semantic-owner projection.
Inline sources use the same owner-neutral content cache rather than baking a record ID or JSON pointer
into the expensive parse/lex key. Owner projections are cached separately by
`(projectInstanceId, semanticOwnerKey, ownerProjectionFingerprint, analyzerVersion)` and retain their
own source paths, closure, URI resolution, and execution provenance. Complete content-cache hits
perform no filesystem read, XML parse, or Lua lex; rebinding an unchanged source after its owning
record ID/path changes may rebuild only the cheap owner projection. A target symbol
addition/removal/rename reuses the artifacts and only reprojects owners indexed by the affected
decoded literal.
After a graph-stable mutation, the service advances the graph snapshot to the matching project
revision without reading any source or running any analyzer. After a graph-affecting mutation, it
enters the Section 5.5 `updating` state only when contribution replacement cannot publish
synchronously. It preserves the prior immutable graph only for display and prevents new graph-backed
rename/delete/repair confirmation or focused document building until a graph snapshot for the current
`projectRevision` is published. The coordinator may retain the prior visual but marks affected
previews stale independently of whether the graph changed.

Source resolution requests contain only cache misses required by accumulated
`sourceAnalysisOwnerKeys`. Once all requested reads succeed or produce terminal diagnostics, the
service rebuilds only invalidated source artifacts, rederives/reprojects the accumulated owners, and
publishes the incrementally assembled snapshot. Stale source-resolution or analysis completions are
discarded by project instance/revision. Inline-only graph changes, symbol-only reprojection, and
complete cache hits may finish synchronously.

### 7.5 Layout external dependencies

Retain `Layout.dependencies.scripts` for external Lua sources. Add
`Layout.dependencies.templates`, restricted to appropriate RML/text Asset records. Every
`<script src>` must resolve through `dependencies.scripts`; every external template link must resolve
through `dependencies.templates`. An undeclared, ambiguous, unsafe, unreadable, or hash-mismatched
external source is a focused builder error. The widget never fetches a path solely because it appears
inside RML.

URI resolution is deterministic and shared by analysis and native realization:

- XML-decode and trim the URI, reject an empty value, query/fragment suffix, backslash, authority,
  drive letter, unsupported scheme, or path escaping the project root;
- accept only a relative URI or a normalized `project:/` URI; normalize relative `.` and `..`
  segments with POSIX semantics against the containing source directory, then require the resulting
  project-relative path to pass `isSafeProjectAssetPath`;
- parent-relative forms such as `../scripts/hud.lua` are valid when normalization remains inside the
  project root; leading/excess `..` that escapes the root is invalid;
- for Asset-backed RML/template content, resolve a relative URI against the directory of that
  containing Asset's project-relative source path;
- for inline Layout RML, resolve a relative URI against the project root;
- match the normalized project-relative path against exactly one declared Asset of the required
  dependency class; duplicate declared Assets resolving to the same path are an ambiguity error;
- `<script src>` requires a `kind: 'script'` Asset;
- `<link type="text/template" href="...">` requires a declared template Asset with `kind: 'text'`
  and `.rml` extension; and
- `<template src="name">` and `<body template="name">` resolve a template name already introduced
  by a declared `text/template` link and never perform another filesystem lookup.

Template definitions use `<template name="...">`; duplicate names in one transitive closure are an
error. The extractor analyzes the complete declared linked-template closure, including headers,
regardless of whether a particular injection site is conditionally reachable, because RmlUi loads
template resources through the document header and this lexical phase does not perform control-flow
analysis.

Template-local relative script/template links use the containing template Asset's directory as
their base. All transitive source Assets enter the explicit resource manifest through their declared
Asset IDs and verified hashes.

The focused Layout `sourceUrl` makes native RmlUi resolution identical to these rules. Asset-backed
RML uses its exact `project:/<asset-source-path>` logical path. Inline RML uses the synthetic root-level
URL `project:/__noveltea_inline_layout_<layoutId>.rml`; it is a base URL only and is not a manifest
entry or filesystem file. Fragment wrapping preserves the authored RML source URL rather than using
the built-in host template's path as the relative-resource base.

Runtime `ProjectLayoutRealizationSource` must use this same source-URL helper instead of the current
unconditional `project://generated/layouts/<id>.rml` URL. The helper selects the authored RML Asset's
logical path for Asset-backed RML and the synthetic root-level URL above for inline RML. This is a
runtime/focused fidelity correction, not a compiled-wire change. Characterization and parity tests
must cover relative `<script src>`, template links, stylesheet/image URLs, and fragment wrapping from
both source modes.

These dependency arrays participate in graph traversal, resource manifests, freshness, diagnostics,
and Asset usage. Extracted Lua occurrences remain attributed to the Layout semantic owner, with the
underlying Asset ID and deterministic container/region provenance retained as occurrence metadata.

`dependencies.templates` is authoring/tooling/preview metadata in this implementation unit. It is
not added to Compiled Project V2 `LayoutDependencies`, does not bump the compiled schema version, and
is omitted by gameplay lowering. Current compiled publication already emits and packages every
authored Asset record, so RmlUi template files remain available by their existing project path; this
plan only makes their authoring relationship explicit for validation, analysis, focused manifests,
and editor freshness. Adding template-specific gameplay prefetch/residency metadata is a separate
compiled-wire change.

### 7.6 Explicit fallback dependencies

Add one shared tooling-only declaration schema usable by future analysis/refactoring consumers:

```ts
type LuaExplicitDependencyTarget =
  | {
      kind: 'record';
      collection: AuthoringCollectionKey;
      id: string;
    }
  | { kind: 'property-definition'; propertyId: string }
  | {
      kind: 'property-value';
      owner: {
        kind:
          | 'room'
          | 'scene'
          | 'dialogue'
          | 'character'
          | 'interactable'
          | 'verb'
          | 'interaction'
          | 'map';
        id: string;
      };
      propertyId: string;
    }
  | { kind: 'room-placement'; roomId: string; placementId: string }
  | { kind: 'room-exit'; roomId: string; exitId: string };

interface LuaExplicitDependencies {
  targets: LuaExplicitDependencyTarget[];
}
```

`targets` defaults to an empty array through one shared `emptyLuaExplicitDependencies()` value. The
field is optional-on-input/defaulted by Zod, so existing Authoring Project V2 files remain readable
without a schema-version bump. Parsed working data always contains `targets`.

Targets must be unique by typed identity. Duplicate declarations are authoring errors. Targets sort
by canonical typed identity when building graph edges or focused admission.

Use the persisted field name `additionalDependencies` to distinguish explicit fallbacks from
automatically inferred dependencies. Because `conditionSchema` and `textSourceSchema` are shared,
their Lua variants mechanically accept/default the field everywhere. Semantic support in this
implementation unit is restricted as follows:

- `roomCompositionHookSchema`;
- `conditionSchema` when `kind === 'lua-predicate'`;
- `textSourceSchema` when `kind === 'lua-expression'`; and
- `layoutScriptDataSchema`, once per Layout, covering every executable Lua region owned by that
  Layout.

Supported Room condition/text owners are exactly:

- `/rooms/<roomId>/data/overlays/<index>/condition`;
- `/rooms/<roomId>/data/cast/<index>/condition`;
- `/rooms/<roomId>/data/props/<index>/condition`;
- `/rooms/<roomId>/data/environments/<index>/condition`;
- `/rooms/<roomId>/data/exits/<index>/condition`;
- `/rooms/<roomId>/data/description/source`; and
- `/rooms/<roomId>/data/placements/<index>/presentation/label/source` when the label is non-null.

Room lifecycle conditions/effects are not preview-relevant and are not supported fallback owners in
this unit. Non-empty `additionalDependencies` anywhere else in the shared condition/text variants,
including Room lifecycle, produces an editor validation warning that the fallback is not yet
consumed; the values are preserved by round-trip parsing but do not create confirmed graph edges.
This prevents hidden hand-authored fallbacks from being silently treated as supported while avoiding
a duplicate Room-only condition or text schema. Layout-level fallbacks are supported on every Layout
because any Layout may later be assigned as Game HUD or Room overlay.

These declarations must be authorable. Add one shared compact dependency editor used by the Room
composition binding, every Room-relevant Lua-predicate condition editor, every Room-relevant
Lua-expression text editor, and Layout script settings. It
must provide typed collection/record/Variable/property/Interactable selectors, prevent duplicate
typed identities, preserve deterministic ordering, surface missing targets inline, and participate
in the owning editor's normal command/Undo/Redo/save path. Shipping hidden schema-only metadata that
can be created only by hand-editing `project.json` is forbidden. Preview diagnostics for unadmitted
lookups link to the owning source and dependency editor. Other Lua surfaces still receive automatic
lexical analysis and occurrence reporting, but their manual fallback UI is deferred.

These declarations are tooling/preview metadata. Authoring compilation must continue producing the
same gameplay wire semantics; golden compiled-project bytes must remain unchanged except where an
explicit compiled schema change is independently approved.

The graph indexes inferred candidate edges and every supported explicit declaration. A focused
builder projects lexical candidates and explicit fallbacks into one candidate-wide focused Lua read
admission. Only target kinds readable through the current focused query API are copied into that
admission; other candidate targets remain Find Usages/invalidation evidence and do not cause
unrelated record tables to enter the document. For one ambiguous literal, all current candidate
targets are retained as one occurrence and every query-capable candidate enters the union.
False-positive lexical candidates may broaden this small focused admission but may not broaden it to
the whole project.

Candidate-wide read admission is deliberate. Room predicates, text expressions, composition, and
mounted Layout scripts/events execute in one shared candidate Lua environment so authored globals
and functions have runtime-compatible visibility. A strict per-source read boundary would be
illusory: a function or API table can cross source/Layout boundaries through those shared globals,
and RmlUi later invokes callbacks at document scope without lexical-region provenance. Enforcing
per-source reads would require isolated environments that change runtime semantics or
provenance-aware Lua values/call frames outside this plan. Source-specific graph evidence and
explicit-fallback ownership are still retained for Find Usages, invalidation, and diagnostics.

Room-composition draft mutation remains separately constrained because it has a real enforceable
boundary: `RoomCompositionDraftAccess` exists only during the composition call. Character and
Interactable draft IDs admitted to that object are derived only from composition-source lexical and
explicit dependencies, not from the candidate-wide read union.

This plan does not add a Script-module import system. A Lua predicate/expression executes its own
inline source. A Room composition hook executes its referenced Script source exactly as the runtime
hook does. Startup hooks and unrelated Script resources are not preloaded to satisfy inferred or
explicit dependencies.

The focused query provider also exposes fixed context facts without declarations:

- current Room and visit context from the preview document;
- gameplay paused is `false`;
- text log is empty; and
- no mutable command capability.

The complete entity-ID-bearing read surface supported by this focused provider is exactly the
currently bound authored Lua methods:

- `noveltea.project.room|scene|dialogue|character|interactable|verb|interaction|map(id)`;
- `noveltea.variables.get(id)`;
- `noveltea.properties.get(ownerKind, ownerId, propertyId)`; and
- `noveltea.interactables.location(id)`.

Gateway methods not currently exposed through `RuntimeScriptApi`/`bind_typed_script_host`, including
full Character or Interactable state, are not invented for focused preview. The fixed Room/visit,
paused, and empty-text-log facts above support their existing non-ID context queries. Every executed
Room or Layout source sees the same candidate-wide read provider and admission. This matches the
shared candidate environment and avoids unsupported source-provenance plumbing.
Map, save, audio, presentation, mounted-Layout, random, and other full-session queries are unavailable
without a runtime session and return capability-denied; every command also returns capability-denied.

Any supported definition, Variable, property, or Interactable-location lookup not admitted by
lexical analysis or explicit fallback fails with a stable focused diagnostic. Unsupported query
families fail as capabilities, not as undeclared IDs. Neither case triggers a whole-project fallback.

### 7.7 Diagnostics, rename/delete preflight, and deferred refactoring

Possible lexical usages appear in Find Usages and delete/rename preflight as warnings. They do not
block ordinary deletion or rename. Rename continues rewriting confirmed typed references, then warns
that possible Lua references were not rewritten. Force Delete does not rewrite or remove inferred
Lua occurrences.

Explicit fallback dependencies are confirmed references. Missing explicit targets remain visible as
structured diagnostics after Force Delete. Ordinary deletion is blocked because no safe source
repair exists. Rename requires explicit “rename without rewriting Lua” confirmation, leaves the
fallback unchanged, and therefore surfaces a missing-target diagnostic until the author updates both
the dynamic Lua and its fallback. This plan does not rewrite Lua source or silently remove/change the
fallback.

Automatic source rewriting, source-encoding preservation, overlap-safe replacement transactions,
exact XML/entity/nested-string mapping, rewrite-grade original byte ranges, and deleted-ID tombstones
belong to a later script-refactoring plan. The pre-mutation graph and recorded container/region
occurrences identify what must be revisited, but that later plan must add and validate the precise
encoding-preserving coordinate map before rewriting any source.

## 8. `noveltea.room-preview` version 2 contract

### 8.1 Document ownership

The Room adapter emits `kind: 'room-preview'` with:

```ts
interface RoomPreviewDocumentV2 {
  schema: 'noveltea.room-preview';
  schemaVersion: 2;
  environment: FocusedRoomPreviewEnvironment;
  room: FocusedRoomIdentityAndVisit;
  luaAdmission: FocusedLuaAdmission;
  queryState: FocusedRoomQueryState;
  shaderMaterials: FocusedShaderMaterialProject;
  world: FocusedRoomWorldDefinition;
  layouts: FocusedRoomLayoutDefinition[];
  ui: FocusedRoomUiDefinition;
  composition: FocusedRoomCompositionDefinition | null;
}

type FocusedShaderMaterialProject = ShaderMaterialProjectBuildResult['project'];
```

The outer focused document carries resources and revisions. The Room data contains no complete
project collection tables.

All Room v2 objects are strict and reject unknown fields. The named members above have these exact
wire responsibilities:

```ts
interface FocusedRoomPreviewEnvironment {
  profile: {
    name: string;
    nativeResolution: { width: number; height: number };
  };
  project: {
    referenceResolution: { width: number; height: number };
    worldRasterPolicy: 'capped' | 'native';
    barColor: string;
    accessibility: {
      uiScale: { enabled: boolean; minimum: number; maximum: number };
      textScale: { enabled: boolean; minimum: number; maximum: number };
    };
  };
}

interface FocusedRoomIdentityAndVisit {
  roomId: string;
  recordLabel: string;
  displayName: string;
  visit: {
    visitIndex: 1;
    sourceRoomId: null;
    entryExitId: null;
  };
}

interface FocusedLuaAdmission {
  definitions: Array<{
    collection:
      | 'rooms'
      | 'scenes'
      | 'dialogues'
      | 'characters'
      | 'interactables'
      | 'verbs'
      | 'interactions'
      | 'maps';
    id: string;
  }>;
  variableIds: string[];
  properties: Array<{
    ownerKind:
      | 'room'
      | 'scene'
      | 'dialogue'
      | 'character'
      | 'interactable'
      | 'verb'
      | 'interaction'
      | 'map';
    ownerId: string;
    propertyId: string;
  }>;
  interactableLocationIds: string[];
  compositionDraftCharacterIds: string[];
  compositionDraftInteractableIds: string[];
}

```

Admission projection is exact:

- Room/Scene/Dialogue/Character/Interactable/Verb/Interaction/Map record candidates enter
  `definitions`;
- Variable record candidates enter `variableIds`;
- explicit `property-value` targets enter `properties`; a bare property-definition candidate remains
  usage evidence because no owner is known;
- Interactable record candidates enter `interactableLocationIds` when any executable candidate
  source can call the read-only Interactable-location query;
- Character/Interactable candidates from the Room composition source enter the corresponding draft
  arrays; candidates from other sources never enter composition mutation admission; and
- Assets, Shaders, Materials, Layouts, Scripts, Tests, Room placements, and Room exits remain graph
  evidence unless a later focused API explicitly admits them.

Every array is unique and canonically sorted. The single `luaAdmission` is the canonical union of
query-capable lexical/explicit dependencies from every executable source in the candidate. Its two
composition draft arrays are the narrower composition-only mutation subset described above.
`FocusedRoomQueryState` contains exactly the actual values required by the read-admission arrays.

```ts

type FocusedCondition =
  | { kind: 'always' }
  | {
      kind: 'variable-comparison';
      variableId: string;
      operator:
        | 'equal'
        | 'not-equal'
        | 'less'
        | 'less-equal'
        | 'greater'
        | 'greater-equal'
        | 'truthy'
        | 'falsy';
      value?: null | boolean | number | string;
    }
  | {
      kind: 'lua-predicate';
      source: string;
    };

type FocusedText = {
  markup: 'plain' | 'active-text';
  source:
    | { kind: 'resolved'; text: string }
    | {
        kind: 'lua-expression';
        source: string;
      };
};

interface FocusedRoomQueryState {
  variables: Array<{
    id: string;
    type: 'boolean' | 'integer' | 'number' | 'string' | 'enum';
    value: null | boolean | number | string;
  }>;
  properties: Array<{
    ownerKind:
      | 'room'
      | 'scene'
      | 'dialogue'
      | 'character'
      | 'interactable'
      | 'verb'
      | 'interaction'
      | 'map';
    ownerId: string;
    propertyId: string;
    result:
      | { kind: 'value'; value: null | boolean | number | string }
      | { kind: 'missing' };
  }>;
  definitions: Array<{
    collection:
      | 'rooms'
      | 'scenes'
      | 'dialogues'
      | 'characters'
      | 'interactables'
      | 'verbs'
      | 'interactions'
      | 'maps';
    id: string;
    displayName: string | null;
  }>;
  interactableLocations: Array<{
    interactableId: string;
    location:
      | { kind: 'inventory' }
      | { kind: 'nowhere' }
      | { kind: 'room-placement'; roomId: string; placementId: string };
  }>;
}
```

`ShaderMaterialProjectBuildResult` is imported from
`editor/src/shared/project-schema/shader-material-project.ts`. `FocusedShaderMaterialProject` is not
a new shader/material schema. It is the existing `noveltea.shader-materials.v1` JSON contract accepted
by `parse_shader_material_project_json_value`, filtered to the Room closure after Material inheritance
resolution.

```ts
interface FocusedVector2 {
  x: number;
  y: number;
}

interface FocusedNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FocusedCharacterVisual {
  requestedPoseId: string;
  resolvedPoseId: string;
  expressionId: string;
  idleId: string | null;
  pose: {
    spriteAssetId: string | null;
    materialId: string | null;
    offset: FocusedVector2;
    scale: number;
    anchor: FocusedVector2;
  };
  expression: {
    spriteAssetId: string | null;
    materialId: string | null;
  };
  idle:
    | {
        kind: 'bob' | 'sway' | 'pulse';
        amplitude: number;
        periodMs: number;
        clock: 'gameplay' | 'unscaled-presentation';
      }
    | null;
}

interface FocusedRoomWorldDefinition {
  background: {
    assetId: string | null;
    materialId: string | null;
    fit: 'cover' | 'contain' | 'stretch' | 'center';
    color: string | null;
  };
  placements: Array<{
    id: string;
    bounds: FocusedNormalizedRect;
    order: number;
    label: FocusedText | null;
    layoutId: string | null;
  }>;
  persistentCharacters: Array<{
    characterId: string;
    placementId: string;
    enabled: boolean;
    visible: boolean;
    order: 0;
    visual: FocusedCharacterVisual;
  }>;
  cast: Array<{
    entryId: string;
    characterId: string;
    condition: FocusedCondition;
    placementId: string;
    visible: boolean;
    order: number;
    visual: FocusedCharacterVisual;
  }>;
  interactables: Array<{
    interactableId: string;
    placementId: string;
    spriteAssetId: string | null;
    materialId: string | null;
    enabled: boolean;
    visible: boolean;
    order: number;
  }>;
  props: Array<{
    propId: string;
    condition: FocusedCondition;
    placementId: string;
    assetId: string | null;
    materialId: string | null;
    visible: boolean;
    order: number;
  }>;
  environments: Array<{
    environmentId: string;
    condition: FocusedCondition;
    assetId: string | null;
    materialId: string;
    bounds: FocusedNormalizedRect;
    plane: 'world-background' | 'world-content' | 'world-overlay';
    order: number;
    clock: 'gameplay' | 'unscaled-presentation';
    scrollPerSecond: FocusedVector2;
    opacity: number;
    visible: boolean;
  }>;
  overlays: Array<{
    overlayId: string;
    condition: FocusedCondition;
    layoutId: string;
    visible: boolean;
    order: number;
  }>;
}
```

`resolvedPoseId` accounts for an expression's optional `poseId` override. The builder resolves and
validates the visual records, but native Room resolution still owns condition admission and final
presentation construction. References are lowered to stable ID strings; the wire never embeds
arbitrary authoring records.

`FocusedRoomLayoutDefinition` contains:

```ts
interface FocusedRoomLayoutDefinition {
  instanceId: string;
  layoutId: string | null;
  mount:
    | { kind: 'game-hud' }
    | { kind: 'room-overlay'; overlayId: string; order: number; visible: boolean };
  source:
    | { kind: 'builtin-game-hud' }
    | {
        kind: 'authored';
        layoutKind: 'document' | 'fragment';
        templateId: 'layout-fragment-host-v1' | null;
        sourceUrl: string;
        defaultParent: string | null;
        scopedStyles: boolean;
        scriptNamespace: string | null;
        rml: FocusedLayoutSourceComponent;
        rcss: FocusedLayoutSourceComponent;
        lua: FocusedLayoutSourceComponent;
      };
  scriptEnabled: boolean;
  containsDedicatedLuaSource: boolean;
  containsExecutableRmlLua: boolean;
  scalePolicy: { ui: 'inherit' | 'ignore'; text: 'inherit' | 'ignore' };
}

type FocusedLayoutSourceComponent =
  | { kind: 'inline'; text: string }
  | { kind: 'asset'; logicalPath: string };
```

Native code derives mount policy and composition group; they are not supplied by the document.
For authored fragments `templateId` is exactly `layout-fragment-host-v1`; for document Layouts it is
exactly `null`. Fragment-host RML/RCSS text is not document content.
`containsExecutableRmlLua` is derived from the complete analyzed RML/template closure and is `true`
when that closure contains any event attribute, inline/external `<script>`, direct-string
`AddEventListener`, or direct-string `load` execution site. It is independent of `scriptEnabled`,
which gates only the dedicated `lua` component. `containsDedicatedLuaSource` is `true` when the
resolved dedicated Lua component contains at least one UTF-8 source byte after removing an optional
BOM; whitespace is still source and is not trimmed for this flag. All three values participate in
the document revision.
Game HUD uses the current reserved Game HUD policy and Interface composition group. Room overlays use
the current `room_overlay_policy(order, visible)` semantics and World composition group. Both have no
entrance/exit operation. Extract/reuse those policy helpers rather than duplicating their constants in
the preview decoder.

```ts
interface FocusedRoomUiDefinition {
  description: FocusedText;
  exits: Array<{
    exitId: string;
    label: string;
    direction:
      | 'northwest'
      | 'north'
      | 'northeast'
      | 'west'
      | 'east'
      | 'southwest'
      | 'south'
      | 'southeast'
      | 'custom';
    targetRoomId: string;
    condition: FocusedCondition;
  }>;
}

interface FocusedRoomCompositionDefinition {
  scriptId: string;
  source:
    | { kind: 'inline'; text: string }
    | { kind: 'asset'; logicalPath: string };
}
```

The document-level `luaAdmission` is derived content: its read arrays are the canonical projection of
lexical candidates plus supported `additionalDependencies` from every executable candidate source,
while its composition draft arrays use only the composition source. Persisted authoring fields are
never copied under their original names into the focused wire, and the focused document does not
expose whether an admitted target came from inference or fallback except through
diagnostics/evidence retained by the editor graph.

Placement UI data is derived from `world.placements` and resolved occupants; it is not duplicated.
Every overlay has exactly one matching authored Layout definition by `overlayId`, even when its
condition later resolves false. Native condition admission selects the final mounted set.

Document array order follows current runtime semantics:

- persistent Characters and Interactables use the stable compiled-definition order, which the
  authoring builder reproduces by stable record ID;
- Room placements, overlays, cast, props, environments, and exits preserve authored array order;
- condition-admitted overlays enter the draft first, followed by persistent Characters,
  Interactables, admitted Room cast, props, and environments, matching
  `RoomPresentationResolver`;
- composition executes before the resolver's final actor/prop/environment sorting;
- focused Layout definitions sort by mount identity after they have been correlated to overlay IDs;
- query-state set arrays sort by typed identity.

These semantic orders are included in `revision`. Object-key order and unrelated project collection
insertion order are not.

### 8.2 Environment

`FocusedRoomPreviewEnvironment` contains:

- the current editor preview profile name and native resolution;
- project reference resolution, world-raster policy, and bar color;
- project accessibility UI/text scale policies; and
- no global Layout scale policy.

Each focused Layout carries its own authored scale policy and mount overrides. Changing the selected
preview profile is an input change. Changing project display/accessibility is an authoritative
project mutation and invalidates previews that consume the corresponding project-field nodes, but
ordinary scalar changes under those fields are graph-stable and do not rederive the graph.

### 8.3 Deterministic preview state

The default state is fixed:

- Room visit index `1`;
- no source Room and no entry exit;
- every Variable at its authoring default;
- every declared property resolved from the authoring property definition, same-kind `extends`, and
  record assignment using existing pure authoring/property helpers;
- Characters at `initialWorldState`;
- Interactables at `initialState`;
- default locale with fallback locale;
- empty text log;
- gameplay paused `false`; and
- no Room lifecycle condition or effect is executed.

Room structural collections do not inherit or merge. Same-kind record `extends` affects only
properties as defined by current architecture.

### 8.4 Conditions and text

Room preview evaluates exactly the presentation-relevant conditions used by the runtime Room
resolver:

- overlay conditions;
- cast conditions;
- prop conditions;
- environment conditions; and
- exit conditions.

It does not evaluate `lifecycle.canEnter`, `lifecycle.canLeave`, or lifecycle effects.

Condition behavior:

- `always` resolves `true`;
- `variable-comparison` uses deterministic default state;
- `lua-predicate` executes synchronously through the candidate-wide focused query provider and
  `FocusedLuaAdmission` from Section 7.

Text behavior for Room description and placement labels:

- inline text is used directly;
- localized text resolves through the current default locale and fallback locale and adds precise
  localization-key/project-field graph dependencies;
- `lua-expression` executes synchronously through the candidate-wide admission.

One candidate uses one isolated preview Lua environment and this exact evaluation order:

1. overlay conditions in authored overlay order;
2. cast conditions in authored cast order;
3. prop conditions in authored prop order;
4. environment conditions in authored environment order;
5. the Room composition Script;
6. Room description text;
7. placement labels in authored placement order; and
8. exit conditions in authored exit order.

`always`, structured comparisons, inline text, and localized text do not execute Lua, but their place
in this order remains fixed. Lua global changes inside the isolated environment are therefore
deterministic and match the same resolver call order in runtime fixtures.

Room exit labels remain the current authoring-schema plain non-empty strings. The builder copies them
directly and does not reinterpret them as `TextContent`, localization, or Lua expressions. Adding
rich exit-label authoring is a separate schema/editor/compiler change and is not smuggled into this
preview plan. The target Room label is not used as an exit label. Editing a target Room's label or
visual content does not change the source Room document revision. Deleting or renaming the target
still affects reference integrity.

### 8.5 World definition and closure

The focused world definition includes:

- background asset, color, fit, and material;
- every Room placement needed for bounds and UI view construction;
- persistent Characters whose current deterministic initial world location targets the Room;
- Room-local cast candidates, with resolved/default pose, expression, and idle;
- Interactables whose current deterministic initial location targets the Room;
- Room props;
- Room environments;
- Room overlays; and
- stable identities, ordering, visibility/enabled state, bounds, transforms, asset IDs, and material
  IDs needed to produce `ResolvedRoomPresentation` and `RuntimePresentationSnapshot`.

Candidates remain in the base draft until their condition and composition visibility are applied.
Composition does not introduce undeclared arbitrary world entries under the current runtime contract.

The Room closure includes incoming Character and Interactable placement edges, their selected/default
visual records, transitive material/shader/texture dependencies, the Game HUD, visible-capable Room
overlays, condition/text dependencies, composition dependencies, display/accessibility settings,
default font, and required localization entries.

### 8.6 Materials and shaders

`shaderMaterials` contains only the resolved Material inheritance chains, Shader definitions, texture
assignments, and existing compiled shader outputs required by world visuals and focused Layouts.

Room preview does not compile shaders. It uses only authoring Shader compiled outputs whose recorded
byte hash and compile-input fingerprint both match the current normalized stage and active host
variant. Missing, unhashed, stale, or incompatible outputs produce a focused failure and preserve the
prior visual. Shader compilation remains owned by the Shader editor/helper workflow.

### 8.7 Layouts

The focused Layout set contains:

- the authored Game HUD assigned at `/settings/ui/systemLayouts/game-hud`, or the existing built-in
  Game HUD when the setting is null;
- one authored Layout candidate for every Room overlay in the document, retaining authored
  visibility and overlay identity; native condition admission mounts only the candidates whose
  conditions resolve true;
- no separately mounted Room placement presentation Layouts.

Each authored Layout is fully resolved to one admitted source:

- built-in Game HUD; or
- one authored Layout carrying independent inline-or-Asset components for RML, RCSS, and Lua.

Mixed source modes are valid because `layoutSourceDataSchema` defines each component independently.
The focused wire must not require all three components to use the same source mode. A fragment
carries its authored content, authored default parent, and fixed built-in fragment-template
identifier; it does not carry internal fragment-host RML/RCSS bytes.

Each entry carries stable focused instance identity, mount descriptor, source URL/logical path,
independent RML/RCSS/Lua source components, dedicated-Lua enabled/presence state,
RML-embedded-Lua presence, authored scale policy, and explicit resource dependencies. Native derives
mount policy, composition group, and Game HUD system role as specified in Section 8.1.

The dedicated Layout Lua component loads only when `scriptEnabled && containsDedicatedLuaSource`.
RML event attributes and inline/external/template `<script>` content execute whenever the document is
mounted, regardless of `scriptEnabled`, matching the current runtime distinction in Section 7.4.
DOM-local event handlers execute in the committed focused environment. The focused RuntimeUI input
sink admits pointer/focus handling but rejects gameplay and shell commands with a capability-denied
diagnostic. It never dispatches into `GameHost`.

Layout source or Lua load failure blocks the candidate and preserves the previous visual.

### 8.8 UI values

The focused resolver produces the existing typed Room view and `TypedRuntimeUIViewState` data needed
by `RuntimeUiGameplayValues`, including description, placement labels/occupants, and authored exit
labels/enabled state. The preview must not create a parallel ad hoc HUD JSON model.

Static gameplay UI values are applied before the new root is revealed.

### 8.9 Composition

The document identifies the compose Script and resolved inline or asset-backed source. The Script
uses the candidate-wide read admission and the composition-only draft IDs from Section 7 before
invoking:

```lua
room.compose(context, presentation)
```

Composition runs after base draft construction and condition admission, before final resolution and
snapshot construction. It uses the existing `RoomCompositionDraftAccess`, may not yield, and closes
draft access on every success/failure path.

Preserve current draft mutation semantics exactly: `set_character_visible(characterId, value)`
changes the first draft actor with that Character ID in draft construction order, and
`set_interactable_visible(interactableId, value)` changes the matching Interactable. A parity test
must cover a persistent Character and Room-cast entry sharing one Character ID so focused preview
cannot accidentally broaden the mutation to all matches.

## 9. Native focused-preview architecture

### 9.1 Single content owner

`PreviewHost` owns exactly one active content kind:

```cpp
enum class EditorPreviewContentKind {
    None,
    GeneratedRmlCompatibility,
    AuthoredLayout,
    ShaderOrMaterialRml,
    FocusedRoom,
};
```

A candidate prepares while the current owner remains committed. Commit occurs on the owner thread
between frames. Exactly one owner can be visible in a frame.

On root-kind transition, preparation retains the prior owner intact. The final non-failing commit
swaps to the prepared new owner between frames; only afterward may the prior owner's world, focused
Layouts, RuntimeUI values, RML documents, system bindings, material/catalog ownership, and leases be
retired.

Entering `FocusedRoom` binds the passive focused input sink. Leaving `FocusedRoom` restores the exact
input sink captured before entry, including `nullptr` when no sink was bound. The presenter must not
assume that `GameHost` is loaded.

### 9.2 Shared focused-document transport and kind-specific native application

Use one versioned request envelope and acknowledgement contract for migrated kinds. It may use one
native export:

```c
int noveltea_preview_apply_editor_document(const char* request_json);
```

The strict request envelope includes request ID, monotonic widget `applySequence`,
`projectInstanceId`, `resourceStageGeneration`, kind, record ID, revision, resource revision, and
the complete validated resource-manifest projection plus data. Native needs that manifest to build
the focused world catalog and typed Asset/Shader requests; `resourceRevision` alone cannot
reconstruct it. The native projection contains resource ID/source kind, logical path, content hash,
byte size, kind/sampling, and typed Asset or Shader identity/stage/variant. It omits widget-only
`fetchProjectRelativePath` and diagnostic-only `usageRoles` after staging. The widget registers the
sequence before the call. Native code captures its current host generation when it accepts the
request; the widget does not supply a native host generation.

Use one focused-document limit contract rather than the old single-document defaults:

```cpp
struct FocusedEditorDocumentLimits {
    std::size_t max_request_bytes = 16 * 1024 * 1024;
    std::size_t max_source_bytes = 4 * 1024 * 1024;
    std::size_t max_string_bytes = 16 * 1024;
    std::size_t max_json_depth = 64;
    std::size_t max_layouts = 512;
    std::size_t max_resources = 16'384;
    std::size_t max_items_per_array = 8'192;
    std::size_t max_admission_items_per_source = 8'192;
};
```

The 16 MiB limit is checked before JSON parsing. `max_source_bytes` applies independently to every
inline RML, RCSS, Lua, Script, and generated focused source string. Those explicitly source-bearing
fields are exempt from the generic `max_string_bytes` limit; all other strings remain bounded by
`max_string_bytes`. `max_items_per_array` applies to every wire array without a smaller named limit.
JSON nesting is checked during parsing/decoding.

Mirror these constants in the strict shared TypeScript protocol and validate the exact UTF-8 encoded
native request before any manifest fetch/hash/write begins. Native remains authoritative and repeats
the checks, but a request known to exceed native limits must fail in the widget without staging bytes
or advancing `resourceStageGeneration`. Limit failure is a synchronous scoped rejection and cannot
refresh resources or alter committed content. Phase 1 tests pin both representations and a parity
test prevents drift; changing them later is a reviewed protocol change.

The integer return means only accepted or synchronously rejected. It is not the applied result. On a
synchronous rejection, the widget sends a failed `command-result` using the diagnostics emitted for
that request. On acceptance, native completion emits an internal preview-bridge event containing
request ID, captured host generation, apply sequence, project instance, resource-stage generation,
kind, record ID, revision, disposition, and diagnostics. The widget sends the editor
`command-result` only after receiving that completion.

Dispatch remains kind-specific behind the envelope. Layout and Shader may continue applying through
their existing synchronous typed-document owners and can emit completion during the call. They must
not be routed through `FocusedPreviewPresenter`, world-resource ownership, or Room candidate state
unless an independently required behavior justifies it. Room routes to the asynchronous focused-world
presenter and may complete later after asset requests. A completion whose sequence is no longer
current is reported as `superseded` internally and cannot become the editor's applied revision.

Remove `noveltea_preview_show_editor_document` in Phase 8 after its existing Layout/Shader callers,
tests, and CMake export lists use the unified export. Production Room v1 does not become a temporary
caller of the old editor-document ABI; Phases 10–13 add Room only to the unified export.

### 9.3 `FocusedPreviewPresenter`

Add one private engine-owned presenter behind `PreviewHost`. It owns:

- current root/revision and apply sequence;
- candidate and committed focused display environments;
- candidate and committed focused material metadata;
- focused world resource catalog;
- candidate `MandatoryAssetRequestGroup` and committed typed leases;
- committed focused world snapshot/revision;
- focused Layout realization set;
- static RuntimeUI gameplay values;
- the passive focused RuntimeUI input sink and the previously bound input-sink baseline;
- focused query state and composition execution; and
- rollback state for the last valid focused owner.

It borrows renderer, AssetManager, ScriptRuntime, world backend, RuntimeUI, authored environment
application, and Layout backend. It does not own or ask `GameHost` for a runtime session.

### 9.4 Focused world resource catalog

Add a backend-neutral `WorldPresentationResourceCatalog` containing image Asset ID, logical path, and
sampling entries. Change `AssetWorldPresentationResourceResolver` to bind that catalog. Preserve
`bind_project(const CompiledProject&)` only as a runtime convenience adapter that constructs and
binds a catalog; it must not remain the resolver's internal source of truth. Focused Room constructs
and binds a catalog from its decoded manifest. Catalog binding itself does not require
`CompiledProject`.

Add the exact operation
`AssetManager::refresh_namespace_on_owner(std::string_view namespace_name)`. For the mounted
`project` namespace it:

- validates that the namespace is mounted;
- advances source generation once for one staged candidate batch;
- invalidates old-generation asynchronous cache entries through existing generation behavior; and
- does not destroy leases retained by the currently committed preview.

`FocusedPreviewPresenter` tracks the last synchronized `(projectInstanceId,
resourceStageGeneration)`. For an accepted request:

- a new project instance clears focused resource ownership and resets synchronized generation to
  `0`;
- a request generation lower than the synchronized generation is stale and rejected;
- a request generation equal to the synchronized generation performs no refresh;
- a request generation greater than the synchronized generation refreshes the `project` namespace
  once, then records that generation as synchronized even if later candidate preparation fails.

Strict envelope/path/schema validation occurs before refresh. Therefore a synchronously rejected
request does not mark a staged generation synchronized, and the next valid request with the same
generation still refreshes correctly. Text-only document edits do not increment the widget staging
generation and do not bump native source generation.

Candidate typed requests are created only after the refresh. Candidate leases become supplemental or
focused-owned committed leases atomically; prior leases remain until commit or rollback.

### 9.5 Editor-preview Layout realization scope

Generalize `LayoutRealizer` with a second explicit realization set independent of the runtime project
session and independent of the existing single authored-Layout preview document.

The focused set must:

- accept only built-in, memory, fragment, and validated logical-asset sources;
- reject project-source descriptors;
- realize multiple documents under stable focused instance IDs;
- stage replacements under namespaced hidden document IDs before commit;
- retain candidate font leases;
- publish focused Game HUD system-document binding;
- apply ordering/policy/visibility atomically;
- reuse unchanged instance/source content;
- remove obsolete focused instances at commit;
- clear only focused instances on focused owner teardown; and
- never call or require `bind_session()`.

The existing runtime realization set and single authored Layout preview remain separate scopes.

### 9.6 Shared Room resolution/mapping

Extract one `RoomPresentationResolverCore` with backend-neutral inputs:

- `RoomPresentationDefinitionView`: Room background, placements, overlays, cast, props,
  environments, exits, description, and optional compose binding;
- `RoomPresentationStateView`: visit context, persistent Character locations/state,
  Interactable locations/state, mounted Room-overlay visibility overrides, and deterministic query
  values;
- condition and text evaluator callbacks; and
- optional restricted composition callback.

The core owns base draft admission, stable identity validation, canonical ordering, Room view
construction, interaction-subject derivation, and `RoomPresentationResolution` creation.

`RoomPresentationResolver::resolve()` becomes the runtime adapter that constructs the two views from
`CompiledProject` and `SessionState`, then calls the core. Focused Room constructs the same views from
the decoded v2 document. Runtime authority and mutation remain only in the runtime adapter.

Extract one `RoomPresentationSnapshotProjector` that consumes a `RoomPresentationResolution` plus a
typed `RoomPresentationVisualCatalog` containing placement bounds, Character pose/expression/idle
visuals, Interactable visuals, and resolved Asset/Material IDs. It returns the Room baseline portion
of `RuntimePresentationSnapshot`. Existing `PresentationProjector` delegates its Room-baseline work
to this projector; focused Room uses it directly and then adds its focused Layout set.

The runtime and focused adapters must produce byte/field-equivalent resolution and Room-baseline
snapshot fixtures from equivalent inputs. Copying a second independent resolver or projector is
forbidden.

### 9.7 Prepared candidate and no-fail Room commit

Applying candidate N uses this order:

1. Reject stale host generation or obsolete apply sequence.
2. Strictly decode exact fields, IDs, enums, finite values, limits, and paths.
3. Prepare the focused display environment without publishing it.
4. Prepare focused material/shader metadata without replacing committed metadata.
5. Synchronize `resourceStageGeneration` and refresh the project asset source generation when required
   by Section 9.4.
6. Build typed Asset requests from the decoded manifest/catalog.
7. Start one `MandatoryAssetRequestGroup`; keep prior content committed while pending.
8. After leases are ready, create one isolated candidate preview Lua environment.
9. Evaluate conditions, composition, and text in the exact Section 8.4 order.
10. Produce `RoomPresentationResolution`, `RuntimePresentationSnapshot`, and
    `RuntimeUiGameplayValues`.
11. Prepare the complete focused Layout candidate set and execute enabled Layout Lua in the same
    candidate environment after Room resolution.
12. Prepare or stage every remaining world, Layout, RuntimeUI, input-sink, and owner object needed by
    the candidate without discarding or mutating the prior committed owner.
13. Verify that every subsystem now exposes a prepared handle/state whose final publication cannot
    fail. If a subsystem still requires a fallible publication operation, move that operation into
    preparation or narrow the atomicity contract explicitly before implementation proceeds.
14. On the owner thread between frames, atomically commit by non-failing swaps of the prepared
    display environment, immutable resource generation/catalog, material metadata, retained leases,
    world revision, focused Layout realization set, system bindings, UI values, preview Lua
    environment, passive input sink, and content owner.
15. Emit the applied completion and retire the previous owner only after no in-flight work can
    reference it.

Any failure before the swap destroys candidate-owned state and leaves the prior committed owner
unchanged. The final commit boundary itself must not fail and therefore requires no deep rollback
transaction. Do not claim atomicity by taking mutable snapshots of every subsystem and attempting to
reverse partially published operations. Where an existing subsystem cannot yet provide a prepared
handle plus non-failing swap, add that seam or state the narrower guaranteed boundary precisely.

### 9.8 Isolated preview Lua environment and read-only query provider

Extend `ScriptRuntime` with private/internal environment-scoped execution used by editor preview:

```cpp
struct ScriptEnvironmentHandle;

create_environment();
destroy_environment(handle);
execute_in_environment(handle, source, chunk_name);
evaluate_bool_in_environment(handle, source, chunk_name);
evaluate_string_in_environment(handle, source, chunk_name);
invoke_in_environment(handle, request, capabilities);
```

Use repository result/error conventions for the exact C++ return types, but preserve this ownership
contract. An environment is a Lua `_ENV` table with the current ScriptRuntime-approved standard
library profile and NovelTea API lookup, no fallback to globals created by another preview document,
one immutable candidate-wide read provider/admission, and one additional call capability binding
active only for operations such as composition draft access. `_G` inside focused code resolves to
the focused environment itself. Standard-library and NovelTea tables exposed to the environment are
environment-local copies/proxies, so assignments such as `math.helper = ...` or mutation of a nested
API table cannot alter the ScriptRuntime global tables or another candidate. It lives in the existing
ScriptRuntime Lua state so RmlUi can execute event handlers without a second global Lua VM.

Each focused environment installs an environment-local wrapper for the exposed base-library
`load(...)`. When the optional environment argument is absent, the wrapper compiles the chunk against
that focused `_ENV`, not the ScriptRuntime global table. Supplying a different explicit environment
is rejected in focused preview. Returned functions retain the focused environment for later event
execution. Runtime/global execution keeps its current effective global environment and restricted
library profile. Focused execution does not re-enable `require`, `dofile`, `loadfile`, package, IO,
OS, debug, or disabled random functions, and it does not broaden coroutine/yield behavior. This is
an isolation seam, not a new module loader or a different gameplay Lua policy.

`FocusedPreviewPresenter` owns one candidate environment and one committed focused environment. The
candidate environment is created fresh for every candidate, so prior Room, Layout, or Shader globals
cannot affect evaluation. It is retained after commit because focused Game HUD/overlay event handlers
need their functions. Supersession, failure, owner transition, project switch, and shutdown destroy
the applicable environment.

Extend the RuntimeUI/RmlUi document backend with an optional editor-preview environment handle per
focused document ID. The dedicated Layout Lua component executes in the candidate environment only
when `scriptEnabled && containsDedicatedLuaSource`. RML inline/external/template scripts execute in
that environment whenever present, and RmlUi event-attribute/function dispatch for that document
uses the same environment regardless of `scriptEnabled`. Documents without an editor-preview
environment continue using the current runtime/global behavior; packaged runtime Layout semantics
are unchanged apart from the shared source-URL fidelity correction in Section 7.5.

Do not manually replay extracted RML scripts in analyzer order. The existing Layout realization path
remains execution authority: dedicated Layout Lua is injected using its current ordering semantics,
then RmlUi executes inline/external/template scripts and event bindings in normal document/template
order. The analyzer discovers evidence and builds the candidate admission only; it must not create a
second script loader or alter execution order.

Introduce a query-provider interface for the read methods used by synchronous expressions and Room
composition. `RuntimeCommandGateway` implements the runtime adapter. Focused Room preview implements
an adapter over the document's deterministic query state and single candidate-wide
`FocusedLuaAdmission`. Every Room and Layout call through that environment uses this same read
provider; the provider rejects a target absent from the candidate admission even when unrelated
project data exists outside the focused document.

Capability generation and active/stale checks remain enforced. The command provider is absent for
focused conditions, text, and composition. `RoomCompositionDraftAccess` remains the only mutation
surface and validates IDs against the composition-only draft arrays. Focused Layout event dispatch
receives the passive focused input/capability adapter and the candidate-wide exact read-only method
set from Section 7.6. It cannot acquire
gameplay or shell command authority, and session-dependent read groups return capability-denied.

Runtime tests must prove the refactor does not change existing capability profiles, query results,
command admission, generation invalidation, RuntimeUI document execution, or Room composition
behavior.

## 10. Required project-wide freshness behavior

These are acceptance requirements.

### 10.1 Edit graph-stable Room content

Typing or replacing an admitted Room description, changing bounds/order/opacity/clock values, or
editing another registered graph-stable visual/UI leaf increments `projectRevision`, reuses the exact
current `snapshot.graph` object and `graphRevision` in a new snapshot wrapper, performs zero source
reads/parses/lexing, and invalidates only preview roots whose focused documents consume the changed
paths.

For an active Room description editor, rapid keystrokes are coalesced by the freshness coordinator
into the newest complete focused document. They do not queue graph rebuilds. An inactive Room tab
performs no native apply and builds once from latest state when leased again.

### 10.2 Add an unreferenced Asset

Importing an Asset creates/changes its Asset record and updates selectors and graph state. Existing
Room previews remain fresh because no Room closure reaches the new Asset.

When the Asset is selected as a Room background, the Room changes, its closure includes the Asset,
the document/resource revisions change, the widget stages that Asset only, and the native candidate
replaces the Room atomically.

If the Room tab is inactive, it builds once from the latest state when reopened.

### 10.3 Reimport a referenced Asset

The existing reimport command updates Asset metadata and `contentHash`, increments project revision,
and invalidates only preview closures consuming that Asset. The widget fetches and verifies the new
bytes, refreshes native source generation once, and issues new typed requests.

A raw external overwrite without reimport is governed by Section 2 and is not an automatic project
mutation in this plan.

### 10.4 Change Game HUD assignment

Changing `/settings/ui/systemLayouts/game-hud` rewires the project-field edge. Every active Room
preview using Game HUD becomes stale. Inactive Room previews update once when next leased.

Null assignment uses the current built-in Game HUD fallback.

### 10.5 Edit the assigned Game HUD

Changing its Layout kind, RML, RCSS, Lua, script settings, mount/default-parent/scoped-style settings,
scale policy, or transitive Asset/Material/Shader dependency invalidates consuming Room previews.
World data may remain identical, but the focused document revision and Layout set update coherently.

### 10.6 Add or move a Character or Interactable

Character `initialWorldState.location` and Interactable `initialState.location` create semantic edges
to a Room placement. Their visual records are transitive Room dependencies.

Moving a subject from Bedroom to Hall invalidates both Rooms using old/new graph impact union.
Moving it to inventory/nowhere removes it from the prior Room only.

### 10.7 Edit Room cast, props, or environments

Changes to admission conditions, selected Character pose/expression/idle, visuals, placements,
bounds, order, visibility, materials, environment clock/scroll/opacity, and transitive resources
invalidate the owning Room.

Editor tags and other `/editor` metadata do not.

### 10.8 Edit exits or target Rooms

Editing a source Room exit label, direction, condition, or target ID invalidates the source Room.
Transition data is not consumed by passive Room preview and therefore does not invalidate it.

Editing the target Room's label, background, cast, props, environments, or description does not
visually invalidate the source Room. Target deletion/rename affects reference integrity and
deletion/rename preflight.

### 10.9 Edit localization

Changing the default locale or the exact default-locale entries used by Room description or
placement labels invalidates the Room. Fallback locale and fallback entries invalidate only sources
whose default-locale entry is currently missing, exactly as Section 5.2 specifies. Room exit labels
are plain authored strings and do not create localization dependencies. Editing an unrelated or
unconsumed localization key does not invalidate the Room. Editing the text value of an already
selected localization entry is graph-stable and rebuilds only affected focused documents; changing
default/fallback selection or adding/removing the relevant entry rederives only indexed localization
owners because the graph edge target may change.

### 10.10 Edit Lua dependencies or composition

Changing a Lua predicate/expression source, inferred occurrence set, explicit fallback declaration,
consumed Script module/source, admitted Variable default, admitted property definition/value,
admitted Interactable location, Layout Lua/RML/template source, or compose Script invalidates the
owning Room.

A lookup not admitted by lexical analysis or explicit fallback fails locally. It never broadens
dependency to the whole project.

## 11. Phased implementation

Execute phases in order. Each phase is one implementation unit, must update completion tracking, and
must leave the repository buildable. Do not implement a later phase to mask an earlier phase's failed
exit gate. When a phase establishes or cuts over a permanent contract, update the corresponding
permanent documentation in that same phase; Phase 15 audits and reconciles the complete documentation
set rather than deferring all documentation until the end.

### Phase 1: Characterization and shared contracts

#### Required work

1. Add characterization tests for current ReferenceIndex output, delete preflight, Room v1 generated
   RML, Layout/Shader native routing, pooled host reuse, stale lease rejection, duplicate diagnostics,
   recursive path staging, project changes missed by current Room revisions, and every current route
   that can replace or patch the authoritative working document.
2. Add shared types/schemas for graph nodes, edges, facets, contributions, derivation dependencies,
   required authoring-field graph effects, generated graph-input classifications, repair descriptors,
   mutation facts, preview roots/inputs, the closed
   `ShaderVariant` contract, focused documents, manifests/native manifest projections, apply results,
   pre-document/document diagnostic scopes, and shared TypeScript/native request limits.
3. Move the pure JSON-pointer type and segment utilities to `editor/src/shared/json-pointer.ts`, keep
   renderer traversal helpers behind the existing compatibility module, and add segment-overlap
   tests covering escaped segments and `/rooms/a` versus `/rooms/ab`.
4. Add shared Lua lexical-analysis, RML extraction, cacheable literal/source-analysis artifact,
   owner-neutral content artifact, semantic-owner projection, projected occurrence/evidence,
   complete source-snapshot limits, candidate-wide focused read/composition-draft admission, and explicit-fallback
   contracts. Add/default `additionalDependencies` on Room
   composition and Layout script settings and mechanically on shared Lua condition/text variants;
   add semantic validation proving non-Room condition/text fallbacks remain unsupported in this unit.
5. Add `Layout.dependencies.templates` and characterize every current Lua/RML execution source,
   including Script records, Asset-backed sources, Layout event attributes, inline/external scripts,
   templates, startup hooks, Scene/Dialogue Lua, effects, Verbs, Interactions, and Tests.
6. Update compiler/lowering tests to prove analysis/fallback metadata does not change compiled
   gameplay bytes.
7. Add strict Room v2 TypeScript schema tests, but keep production Room on v1.
8. Consolidate duplicate renderer-local preview type definitions onto
   `editor/src/shared/preview-protocol.ts` where behavior is unchanged.
9. Add an import-boundary regression proving focused preview modules do not import compiled-runtime
   export/publication modules.

#### Main surfaces

- `editor/src/shared/preview-protocol.ts`
- `editor/src/shared/json-pointer.ts`
- `editor/src/renderer/project/json-pointer.ts`
- `editor/src/shared/project-schema/authoring-flow.ts`
- `editor/src/shared/project-schema/authoring-rooms.ts`
- `editor/src/shared/project-schema/authoring-layouts.ts`
- new shared graph/preview contract modules
- current reference, Room, Layout, Shader, widget, and pool tests

#### Exit gate

- all contracts are strict and tested;
- TypeScript/native focused-request limits and manifest projections are contract-tested for parity;
- compiled golden bytes remain unchanged;
- production rendering behavior is unchanged; and
- forbidden full-project Room dependencies are machine-tested.

### Phase 2: Pure authoring dependency graph

#### Required work

1. Implement deterministic source-owned graph contributions, immutable contribution assembly,
   `buildAuthoringStructuralDependencyGraph(project)`, and graph queries in shared code. This phase
   establishes every non-Lua node/edge and the reusable contribution/storage/query core; the final
   `buildAuthoringDependencyGraph(project, luaAnalysis)` wrapper is Phase 3 work.
2. Convert the current generic reference scanner into source-owner contribution derivation rather
   than retaining one independent whole-project scanner.
3. Add semantic adapters for every current collection needed to preserve existing reference results,
   and complete adapters for Asset, Variable, Shader, Material, Layout, Character, Room,
   Interactable, Script, settings, properties, localization, Scene, Dialogue, Map, Verb, Interaction,
   and Test relationships. Generate intrinsic graph-input paths from required field metadata. Each
   adapter declares every cross-owner consumed field and derivation dependency in the same module as
   its contribution derivation.
4. Add Room placement/exit nested nodes, property-definition nodes, localization-key nodes,
   `/startupHook`, material-base edges, subject Room-placement edges, Game HUD, default font, and
   Layout script/template declaration edges. Do not infer Lua string references in this phase.
5. Implement typed edge upgrading without duplicate compatibility usages.
6. Implement deterministic cycle-safe forward/reverse traversal and segment-aware path impact.
7. Make `buildReferenceIndex()`/`findUsages()` structural graph projections.
8. Migrate shared compiler linking and project search to the structural graph projection without
   changing their result contracts.
9. Add full structural graph, contribution assembly/replacement, reverse derivation-key,
   missing-target, tolerant structurally admitted input-boundary, deterministic order,
   compatibility, required-field-metadata, generated-classifier, structural-fallback, shared differential
   registry-audit helper, and representative large-project full-build benchmark tests.

#### Exit gate

- one pure structural graph reproduces every existing reference usage;
- all required non-Lua semantic/nested/project-field relationships exist;
- compiler/search have no independent whole-project reference scan;
- the full builder is exactly the deterministic assembly of the same contributions later replaced
  incrementally;
- every authoring field has an explicit intrinsic graph effect, every cross-owner derivation input
  has a colocated adapter declaration/index, and representative `none` fields are proven graph-stable;
- structural graph output is insertion-order independent and cycle-safe;
- the informational full-build structural benchmark result is recorded as the correctness/performance
  baseline for Phase 5;
- existing rename/delete/compiler/search tests pass unchanged.

Phase 2 revalidation benchmark baseline (2026-07-26, Node 22.22.1): a representative project with
500 Rooms, one shared background Asset, 517 graph nodes, and 2,501 graph edges completed a fresh
structural full build in 96.77 ms during the focused test run. The four project-field dependency
edges per Room account for the increased edge count. This result is informational and is not a
timing gate.

Phase 2 revalidation also passed the editor check, 45 focused structural/reference/compiler/search
tests, 160 passing editor test files plus one existing skipped file, 951 passing tests plus four
existing skips, and the production editor build.

### Phase 3: Pure Lua/RML analysis and graph evidence

#### Required work

1. Add `saxes` as a direct editor dependency and implement the Lua 5.5 lexer, bounded embedded-code
   recognizers, strict RML parser integration, narrow RmlUi raw-text masker, deterministic
   container/decoded-region provenance, and fixed analysis limits from Section 7. Do not implement
   rewrite-grade XML/entity offset mapping in this phase.
2. Implement the exhaustive typed `collectAuthoringLuaSources()` registry for startup, Script,
   Layout, shared condition/text/effect, Scene, and Dialogue sources.
3. Replace the Phase 1 path-regex implementation of supported explicit-fallback ownership with one
   typed semantic-owner classification derived from the same source registry. Validation, explicit
   graph-edge derivation, focused admission, and later dependency-editor availability must consume
   that classification; do not retain a separate list of Room/Layout JSON-pointer regexes. Use the
   shared decoded JSON-pointer utilities when mapping concrete source paths to semantic owners.
4. Implement the pure `LuaSourceSnapshot` consumer, byte-dependent
   owner-neutral content-artifact construction plus cheap semantic-owner projection, cycle-safe
   template traversal, deterministic URI resolution, decoded-region coordinates, decoded-literal
   indexing, and semantic-owner provenance. Artifacts must not consult the current project symbol table. Use
   supplied hash-verified fixture text only; filesystem/IPC resolution belongs to Phase 5. Replace
   Phase 2's provisional broad reverse-derivation declarations with exact semantic-owner
   dependencies produced by this typed registry and its focused-admission projection. In particular,
   structurally referenced Shader sources, RCSS-only sources, non-selected Layout source-mode
   alternatives, and ordinary record property assignments must not remain `source-asset` or
   `property-resolution` dependencies merely because the generic structural graph can see them.
   Disabled dedicated Layout Lua remains analyzed for Find Usages as required by Section 7.4, but
   receives no focused-preview facet while disabled.
5. Implement `buildAuthoringDependencyGraph(project, luaAnalysis)` as the final pure wrapper over the
   Phase 2 contribution model. First expose the keyed pure contribution operations required by
   Section 4.1, including deterministic contribution-key enumeration and derivation/reprojection of
   one requested record, fixed project-field, property-definition, localization, or semantic-source
   owner without building every contribution. Refactor the full structural/evidence builder to call
   those same keyed operations; a selected-owner derivation path may not duplicate the Phase 2 bulk
   logic or discover its result by full before/after contribution-set comparison. Add deterministic
   current-symbol projection from cached literal artifacts to ambiguous/exact
   `LuaReferenceOccurrence` evidence and possible-reference edges.
   Both modes add supported explicit fallback edges directly from project metadata. `disabled` emits
   no lexical edges; `enabled` additionally adds projected Lua evidence and source-analysis
   diagnostics to owning contributions. Neither mode changes structural compatibility projections.
6. Add all Lua source/evidence roles and prove warning-level candidates never enter compiler linking,
   while explicit fallbacks remain tooling-confirmed and omitted from compiled gameplay bytes.
7. Add exhaustive lexer, malformed-source, region-provenance, XML entity, event attribute, inline/external
   script, template/body-template, direct listener/load string, nested region provenance, XML entity
   decoding without rewrite-grade original spans, ambiguity, limits, deterministic
   ordering, semantic-owner rebinding, complete-snapshot byte/occurrence budgets, exclusion of
   owner-scoped Room placement/exit IDs from generic lexical projection, and source-Asset projection
   tests.
8. Record a representative enabled full-graph benchmark using both inline and supplied Asset-backed
   sources. Prove pure rederivation of one Lua/RML semantic owner produces the same contribution as
   that owner in a fresh full build, and prove target-symbol additions/deletions/renames can reproject
   cached literals without source reanalysis. Prove changing only a source-owning record ID/path
   reuses the owner-neutral content artifact and rebuilds only its owner projection. Also prove the
   exact reverse-derivation indexes exclude the Phase 2 provisional false positives listed in item 4
   while retaining selected RML, dedicated Lua, Script, reached external-script/template,
   localization, and explicit property-value dependencies.

#### Exit gate

- every current authoring Lua execution surface is discovered by the typed registry;
- supported explicit-fallback ownership, validation, graph evidence, focused admission, and editor
  availability derive from that registry with no independent path-regex registry;
- lexical/RML analysis is pure, bounded, container/region-provenanced, deterministic, and
  filesystem-free;
- source content artifacts are symbol-table/owner-identity-independent and deterministic by exact
  content/URI-base fingerprint, while owner projections are deterministic by exact provenance;
- deterministic keyed derivation is the sole implementation used by both full construction and
  selected-owner replacement, including fixed and semantic-source owners;
- reverse derivation indexes contain only exact graph-shape/source-evidence dependencies rather than
  structurally convenient Shader, RCSS, inactive-source-alternative, or ordinary-property false
  positives;
- possible and explicit Lua evidence obey the exact confidence/facet/repair contracts;
- disabled analysis preserves the Phase 2 structural compatibility graph and compiler/search
  behavior exactly while adding only non-compiler tooling fallback edges;
- enabled analysis adds no compiled-project dependency or byte change;
- malformed/incomplete sources warn without suppressing unrelated graph content; and
- all Phase 3 analyzer/evidence/contribution-equivalence tests and the informational enabled
  full-build benchmark pass.

Phase 3 enabled benchmark baseline (2026-07-26, Node 22.22.1): a representative project with 300
Rooms, inline Lua-bearing Room text, startup Lua, and a supplied Asset-backed Script produced 320
nodes and 1,209 edges in 95.60 ms during the final full editor test run. This is informational and
is not a timing gate.

### Phase 4: Authoritative project publication and precise mutation facts

#### Required work

1. Add `projectInstanceId`, monotonic `projectRevision`, mutation change sets, and the atomic
   `ProjectMutationPublication` old/new immutable document envelope to the project/command store
   path. Authoritative project content must never be mutated in place.
2. Preserve the existing tolerant structural-admission path from Section 4.2. Add revision and
   immutable publication metadata adjacent to it without changing which semantically invalid values
   may remain in the authoritative working document. Introduce or document the
   `StructurallyAdmittedAuthoringProject` contract where practical, and keep damaged raw-file
   recovery outside the authoritative project store until structural admission succeeds.
3. Publish correct mutation facts for load, ordinary command, every publicly visible transaction
   step, transaction cancellation, structural-persistence rollback, Undo, Redo, and replacement.
   Transaction commit publishes no second content revision when it only finalizes already published
   steps. Commands and transactions must report the narrowest canonical leaf paths plus required
   structural owner paths; no public mutation may silently replace broad project subtrees without
   either precise facts or an explicit full-rebuild classification.
4. Promote the Phase 2 graph-field metadata and adapter-declaration scaffolds into the authoritative
   pure segment-aware graph-input classifier generated from required field metadata, structural
   collection rules, and exact adapter dependency declarations. The current schema fingerprint
   remains a shape-drift gate, but heuristic leaf-name assignment, a catch-all implicit `none`, and
   collection-level dependency-kind summaries are not authoritative classification. Every concrete
   schema leaf must resolve through one explicitly reviewed effect declaration, and every
   cross-owner rule must identify its exact owner/reverse key beside the derivation that consumes it.
   The classifier must distinguish explicit `none` fields, owner/source/symbol/structural effects,
   reverse derivation dependencies, structural add/remove/reorder/replacement, and explicit
   full-build fallback. It must distinguish similarly named fields with different semantics, such as
   Layout RML/Lua `sourceText` versus Layout RCSS and Shader source text.
5. Add mutation-publication characterization for every current command/store path, including no-op,
   rejected candidate, active-transaction intermediate steps, transaction commit/cancellation,
   rollback, Undo/Redo, recovery, record creation/removal, ID rename, array item mutation, and
   `/editor`-only updates. Include `markSaved`/save-baseline completion and project-path metadata
   updates, which currently clone or replace the project object even when authoring content is
   unchanged. Prove each content publication carries the exact prior admitted document identity
   needed for classification even when later revisions publish immediately, and prove save-baseline,
   metadata-only, and other content-equal identity replacements publish no content revision.
6. Keep `assertGraphInputRegistryComplete()` and any fresh full-build/contribution-diff logic as test
   oracles only. Production classification must resolve exact work from the mutation, old/new
   admitted projects, keyed owner rules, and current reverse indexes; it must not run a fresh full
   graph or compare complete contribution sets to discover which owners changed.
7. Make the Phase 3 typed Lua/RML source registry operate over structurally admitted record fragments
   without requiring an unrelated complete record to pass its strict semantic parser. Reuse the same
   schema-owned descriptors and discriminants; do not replace them with a recursive `source` search.
   Safely readable sources remain registered and malformed/unsupported local variants produce
   owner-scoped diagnostics without hiding unrelated sources in the same record.
8. Extend the exact adapter/derivation contract with the distinct
   `source-resolution-asset` reverse key for every declared Layout script/template dependency. Path,
   kind, and extension changes use that key; reached-source hash/read changes use `source-asset`.
   URI resolution must record a reached `source-asset` dependency even when the terminal source entry
   is unavailable, so reimport/hash correction can recover without a full build.

#### Exit gate

- no structurally invalid project candidate can reach the authoritative project store;
- rejected command/Undo/Redo/rollback/recovery candidates leave document, history, revision, and
  mutation state unchanged;
- every accepted content replacement—including transaction steps/cancellation—increments
  `projectRevision` exactly once and publishes precise canonical affected paths plus the exact
  immutable previous/current normalized documents; metadata-only updates and commit-only transaction
  finalization do not increment it;
- save completion, save-baseline refresh, and path-only metadata changes do not increment
  `projectRevision` merely because the current store implementation clones the document object;
- ordinary semantically invalid but structurally representable commands remain publishable under
  the existing validation boundary;
- explicitly `none` fields classify graph-stable, while missing metadata, unknown variants, and
  broad/structural ambiguity fail safe to owner replacement or full rebuild;
- field effects have no heuristic/default assignment path, exact adapter consumption declarations
  drive owner/reverse-key resolution, and the production classifier performs no full graph build or
  complete contribution-set diff;
- every registered structural/source/symbol/derivation path produces the expected pure impact;
- tolerant source discovery cannot be suppressed by an unrelated semantically invalid sibling field,
  and declared-resolution versus reached-source Asset changes select the exact distinct owner sets;
- visible preview and reference behavior remain unchanged.

### Phase 5: Incremental renderer graph service and source resolution

#### Required work

1. Implement the exact bounded `READ_PROJECT_TEXT_SOURCES` batch IPC and main-service session,
   containment, hash, UTF-8, ordering, complete-snapshot/per-request limit, and partial-failure rules
   from Section 7.4. Group cache misses by physical `(path, hash)`, use opaque `readKey` correlation,
   and fan one result back to every matching Asset ID; do not accept a renderer-selected root and do
   not reuse `resolveProjectAssetUrl`.
2. Implement one renderer `AuthoringDependencyGraphService` with immutable contribution storage,
   reverse derivation indexes, decoded-literal owner index, source-byte and source-analysis artifact
   caches split into owner-neutral content analysis and semantic-owner projection, graph-stable
   revision advancement, incremental contribution replacement, cached symbol-only reprojection, and
   load/replace/classifier-fallback full builds.
3. Implement the explicit phased `updating` state, stale completion rejection, accumulated
   unpublished affected paths/contribution/source-analysis/symbol-projection work, project-instance
   reset, old/new impact union, immutable snapshot publication, and `/editor`-only suppression.
4. Resolve/read/parse/lex only cache misses for `sourceAnalysisOwnerKeys`. Enforce complete logical
   snapshot byte/occurrence budgets across inline sources and cache hits before issuing cache-miss
   reads. Reuse cached content artifacts for graph-stable, structural-only,
   localization/property derivation, symbol-only projection, and source-owner identity/path rebinding.
5. Rebuild reverse derivation and decoded-literal indexes atomically from every published
   contribution set. Missing index/owner attribution must use full-build fallback with a development
   diagnostic rather than publishing a potentially stale graph.
6. Add instrumentation and mutation-sequence equivalence tests proving every incremental result
   equals a fresh full build, including the shared differential registry audit and several mutations
   superseding one another during async source work.
7. Retain and publish through a revision-gated service query the immutable owner-projected
   `AuthoringSourceAnalysisArtifact` values, completeness state, and exact reached source Asset IDs
   associated with the current contribution set. This is renderer tooling state, not part of the pure
   assembled graph contract. Focused adapters must be able to query it only when its project instance
   and revision match the graph snapshot; stale or missing analysis fails closed rather than causing
   a second source read/parser/lexer path.

#### Exit gate

- every project mutation deterministically advances the current graph snapshot, replaces/reprojects
  the exact affected owner set, or uses explicit full-build fallback;
- Room-description typing and representative visual-only edits preserve `snapshot.graph` identity
  and `graphRevision` while advancing only the snapshot wrapper's `projectRevision` and performing
  zero contribution, source-read, XML-parse, or Lua-lex work;
- local relationship edits replace only their owning contribution;
- source changes analyze only indexed consuming owners;
- path/kind/extension changes on declared Layout script/template candidates re-resolve only declaring
  owners through `source-resolution-asset`, while byte/hash changes reanalyze only owners that reached
  the source through `source-asset`;
- multiple Asset IDs sharing one verified physical `(path, hash)` cause one main-process read/decode
  and retain distinct Asset-level provenance after renderer fan-out;
- top-level record/property target-ID additions/deletions/renames reproject only owners containing
  the affected decoded literals and perform zero source read/XML parse/Lua lex work; renaming a
  source-owning record may rebuild only its cheap owner projection;
- owner-scoped Room placement/exit IDs never enter generic lexical projection and remain available
  through qualified explicit dependencies;
- localization selection/entry-existence and property-chain structural changes replace only owners
  found through exact reverse derivation keys, while selected localization values and property/
  Variable values remain graph-stable;
- moved relationships affect old and new dependents;
- stale async completions cannot clear accumulated work or publish an older revision;
- the current graph is unavailable for authoritative consumers while its `projectRevision` is stale;
  and
- every instrumented incremental graph matches a fresh full build canonically.

### Phase 6: Graph consumer migration and structural preflight

#### Required work

1. Migrate References, entity usages, Explorer delete preflight, Variable/Asset usages, rename, and
   structural operations to current graph snapshots.
2. Add a revision-gated graph preflight result consumed by rename/delete command dispatch. It must
   reject a stale/non-ready graph, warn without blocking for `lua-possible-reference`, require
   explicit “rename without rewriting Lua” confirmation for `lua-explicit-reference`, block ordinary
   deletion for explicit fallbacks, and preserve the existing separate Force Delete path.
3. Add semantic usage labels, ambiguous-occurrence grouping, source locations, and precise nested
   target labels.
4. Add structural Room-placement deletion preflight and fail closed where the current command cannot
   safely preserve integrity.
5. Keep current confirmed-reference delete behavior through the graph compatibility projection. Do
   not add the new repair registry or automatic delete-and-repair UI in this phase; Lua warning/block
   rules are preflight policy, not automatic repair.
6. Remove renderer-side legacy confirmed-reference scanners only after every migrated consumer and
   direct command-dispatch path is covered by regression tests.

#### Exit gate

- Find Usages and structural preflight are graph-backed;
- no direct rename/delete/structural command path can bypass a current revision-gated graph preflight;
- possible Lua usages warn, explicit fallbacks enforce the agreed confirmation/block policy, and
  Force Delete remains explicit;
- structural-persistence rollback cannot leave project, history, graph, and usages out of sync;
- existing confirmed-reference behavior remains compatible; and
- unsafe new structural deletion fails closed without introducing automatic repair yet.

### Phase 7: Focused preview protocol, resources, and unified native transport

#### Required work

1. Extend shared protocol and transport contracts with strict focused documents, manifests, apply
   results, pre-document and document-revision diagnostic scopes, closed template IDs, canonical
   revisions, and TypeScript/native limit parity. Replace the Phase 1 resource-only native limit
   scaffold with the complete Section 9.2 request/decoder contract (`max_request_bytes`,
   `max_source_bytes`, `max_string_bytes`, `max_json_depth`, `max_layouts`, `max_resources`,
   `max_items_per_array`, and `max_admission_items_per_source`), mirror every value in shared
   TypeScript, and parity-test the exact constants and UTF-8 request-size preflight.
2. Expose monotonic host/transport generation through pooled leases and report the closed active
   Shader variant from the initialized native renderer through the ready
   handshake; reject empty/unknown variants and never infer the value from project or export settings.
3. Add the versioned focused-document request envelope and applied-completion bridge from Section
   9.2. Dispatch by document kind. Layout and Shader may remain synchronously applied by their
   existing native owners while returning the common acknowledgement; Room may complete
   asynchronously. Do not force Layout/Shader through `FocusedPreviewPresenter` or Room world-owner
   state merely to share transport. Expand the Phase 1 native manifest projection from its current
   logical-path/hash/size/kind/sampling scaffold to the complete Section 9.2 typed projection,
   including resource ID, source kind, authoring Asset identity, and compiled Shader
   identity/stage/variant. Include that native-consumed projection in the request.
4. Replace recursive path staging behind the new transport with transactional hash-verified manifest
   staging into immutable generation-specific physical storage, committed generation maps,
   abort/apply-sequence
   guards, project-instance reset, shared request/resource-size preflight, bounded streaming fetches
   with exact byte-count verification before Web filesystem writes, project-asset server realpath
   containment, and exact diagnostic replacement.
5. Resolve Layout asset-backed RML/RCSS/Lua sources, declared external scripts, and declared template
   closure through explicit Asset records/manifests and the shared URI rules from Section 7.5.
   Extract the Phase 3 URI normalization, declared-dependency matching, template-name resolution, and
   Layout source-URL behavior into one shared pure module; keep the analyzer as a consumer of that
   module, then migrate runtime `ProjectLayoutRealizationSource` and focused Layout realization to
   the same module so relative-resource bases and ambiguity/unsafe-path decisions are identical.
6. Add defaulted compiled-Shader byte-hash, exact byte-size, and compile-input-fingerprint metadata and
   extend `ShaderCompileOutput` with a digest and byte count verified from `outputPath` for both
   compile and cache-hit results. Canonicalize authoring compilation under `.noveltea/build`, write
   each runtime path, SHA-256, byte size, and input fingerprint together, keep legacy path-only/hash-
   only projects readable, and require recompile when focused preview consumes incomplete or stale
   output metadata. Prove `cacheKey` is not used as a byte digest and compiled gameplay bytes are
   unchanged.
7. Stage required compiled Shader outputs through explicit manifest entries with separate
   `fetchProjectRelativePath` and `logicalPath`; never treat their direct runtime paths as authoring
   Asset IDs or mount `.noveltea/build` into the runtime logical path.
8. Keep built-in fragment/Shader templates host-owned and add hidden integration fixtures proving
   Layout and Shader preserve their intended native visual output through the shared envelope and
   their kind-specific native application paths.
9. Preserve existing production Layout/Shader behavior in this phase; do not introduce the freshness
   coordinator or remove `set-preview-mode` from production callers yet.

#### Exit gate

- unchanged resources are not fetched;
- compiled Shader outputs fetch from `.noveltea/build/...`, mount at `project:/shaders/...`, and are
  rejected when their compile-input fingerprint is stale;
- the host-reported closed Shader variant alone selects the staged binary;
- inline and Asset-backed Layout relative resources resolve from the same canonical base in runtime
  and focused preview, including fragment wrapping;
- partial staging failure cannot overwrite bytes reachable by the committed generation or publish a
  candidate generation map;
- manifest-recorded and actual fetched bytes obey the pinned per-resource/aggregate limits; missing
  or dishonest `Content-Length` cannot bypass the bounded body reader, and size/hash mismatch writes
  no resource bytes or staging state;
- requests outside native limits fail before resource fetch/write, and TypeScript/native limit
  constants remain pinned by parity tests;
- the complete typed native manifest projection round-trips authoring Asset and compiled Shader
  entries without reconstructing identity from logical paths;
- native Layout/Shader fixtures receive the manifest projection required for catalog/request
  construction rather than attempting to reconstruct it from `resourceRevision`;
- hidden Layout/Shader fixtures complete through the common request/acknowledgement contract without
  requiring Room presenter ownership;
- compiled gameplay bytes and visible production preview behavior remain unchanged; and
- the old ABI remains only as the explicitly temporary production bridge removed in Phase 8.

### Phase 8: Freshness coordinator and Layout/Shader production migration

#### Required work

1. Implement the focused adapter registry, strict input validation/canonical input revisions, and one
   renderer freshness coordinator.
2. Change `DerivedPreviewPane` to submit root+inputs and a lease, not a prebuilt document.
3. Connect every authoritative project revision, graph impact when current, graph-stable target
   impacts, preview input changes, host capabilities, and lease acquisition/release to stale/fresh
   state. When graph impact is unavailable or uncertain, conservatively rebuild the active focused
   document; wait for a matching graph only for adapter-declared topology-dependent builds.
4. Implement animation-frame coalescing, one in-flight apply, one latest pending state, first-load
   versus same-root update, reconnect replay, revision deduplication, supersession, and new-root
   reveal rules.
5. Migrate production Layout and Shader adapters to strict focused documents, explicit manifests,
   the common request/acknowledgement contract, and scoped diagnostics while retaining their
   appropriate kind-specific native application owners.
6. Stop sending separate `set-preview-mode` and command-level environment for Layout/Shader after all
   their callers use document-selected content mode. Remove their old ABI call sites and temporary
   production bridge.
7. Preserve iframe identity, pool lease semantics, resize, DPR, activity, visibility, pointer, wheel,
   focus, and input across same-root updates and Layout↔Shader transitions.

#### Exit gate

- unrelated project edits send no Layout/Shader command;
- rapid same-root edits settle on the latest revision;
- inactive tabs build/apply once on return;
- unchanged document revisions do not send and unchanged resources do not fetch;
- diagnostics replace by exact lease/root scope;
- reconnect and host-capability changes replay the latest complete desired document;
- Layout/Shader switching keeps one warm host with correct resize/DPR/input behavior; and
- no production Layout/Shader caller uses the obsolete ABI or recursive staging.

### Phase 9: Graph-driven Room v2 builder

#### Required work

1. Add the shared typed explicit-fallback editor required by Section 7 to Room composition,
   Room-relevant Lua-predicate conditions, Room-relevant Lua-expression text sources, and Layout
   script settings.
2. Replace the Phase 1 Room v2 schema's open JSON-object placeholders for `shaderMaterials`, `world`,
   `layouts`, `ui`, and `composition` with the exact strict typed schemas from Section 8, including
   nested unknown-key and missing-required-field rejection tests. Then implement the Room adapter and
   strict Room v2 builder from Sections 7, 8, and 10.
3. Query the Room closure, including incoming Character/Interactable placement relationships.
4. Resolve Character defaults/overrides, materials, Shader outputs, Layout/script/template sources,
   localization, property defaults/inheritance, deterministic Variable state, lexical occurrences,
   explicit fallbacks, one candidate-wide read admission, and the narrower composition-only draft
   admission. Consume the current revision-gated source-analysis projection from Phase 5 for regions,
   completeness, reached external/template sources, and semantic-owner provenance; do not rerun
   source reads, URI traversal, XML parsing, or Lua lexing in the Room adapter.
5. Build exact focused material metadata and resource manifest.
6. Preserve presentation conditions/text sources needed by native evaluation and pre-resolve only
   inline/localized values whose semantics are fixed in Section 8.4.
7. Emit only closure diagnostics.
8. Produce canonical input/resource/document revisions.
9. Add all Section 10 invalidation and insertion-order tests.
10. Keep Room v1 as the production visual path. Phase 9 adds no widget dispatch or user-facing mode
   switch for Room v2; it validates the builder, shared protocol decoder, and fixtures only.

#### Exit gate

- the document is self-contained and contains no complete project;
- every Room v2 section is structurally typed and strict; arbitrary JSON objects cannot satisfy the
  world, Layout, UI, material, or composition contracts;
- every supported explicit fallback is authorable through normal editor commands and Undo/Redo,
  while automatic occurrences require no authored metadata;
- persistent Characters, Interactables, Game HUD, overlays, props, environments, localization, and
  transitive resources are present;
- target Room visual data is absent from exit dependencies;
- unrelated project diagnostics/records are absent; and
- all revision/invalidation tests pass.

### Phase 10: Native focused-preview foundation

#### Required work

1. Add strict native Room v2 typed contracts and decoder limits.
2. Extend the Phase 7 unified editor-document dispatcher and completion bridge with strict
   `room-preview` routing; do not add a Room-specific export or second acknowledgement model.
3. Add `FocusedPreviewPresenter` and the single content-owner state behind `PreviewHost`.
4. Add focused world catalog binding and AssetManager namespace refresh.
5. Add focused candidate/committed typed lease ownership using `MandatoryAssetRequestGroup`.
6. Add the multi-document focused Layout realization scope without binding a runtime session.
7. Implement Room request acceptance, immutable resource-generation synchronization, asynchronous
   supersession, candidate ownership, prepared-state/no-fail commit scaffolding, and completion semantics. Keep successful Room visual
   commit behind native fixture/test seams until Phase 11 supplies complete resolution/world/UI
   content; production Room remains v1 and the widget must not expose a partial Room mode.
8. Re-run Layout/Shader unified-transport fixtures through the expanded content-owner state and prove
   adding Room support does not change their committed ownership or completion behavior.

#### Exit gate

- strict Room requests can be decoded, staged, superseded, and failed through the shared lifecycle,
  while fixture-only candidate commits prove prepared-owner/non-failing-swap mechanics without publishing partial
  production Room content;
- no compiled project or runtime Layout session is created;
- changed assets prepare through a new source generation;
- Layout/Shader continue rendering through the common envelope and their kind-specific native owners;
- candidate resource/lease failure preserves the prior complete owner;
- owner transitions clear only their own state; and
- completion ordering is correct under supersession.

### Phase 11: Shared Room resolution and native baseline

#### Required work

1. Extract/shared-map Room resolution and projection logic as required by Section 9.6.
2. Implement focused Room definition/state views for `always` and structured Variable comparisons.
3. Resolve inline/localized Room description and placement labels without Lua.
4. Prepare world, focused Layouts without any consumed executable Lua, Game HUD binding, static
   RuntimeUI values, passive input sink, display environment, immutable resource catalog, and clocks
   without mutating the committed owner; publish them through one non-failing owner-thread swap.
5. Add the necessary prepared-handle/swap seams so all fallible world/Layout/UI work completes before
   commit. Do not implement deep rollback of partially published subsystem mutations.
6. Add hidden widget/native Room integration fixtures with no consumed executable Lua, no
   composition, and no compiled project bound.
7. Add explicit failure fixtures proving a Phase 11 candidate fails closed when it consumes any
   `lua-predicate`, `lua-expression`, Room composition Script, mounted Layout with
   `scriptEnabled && containsDedicatedLuaSource`, or mounted Layout with
   `containsExecutableRmlLua`. The RML-embedded case blocks regardless of `scriptEnabled`. Lua in an
   overlay rejected by its Room condition and therefore not mounted does not block the candidate.
   Preserve the prior visual until Phase 12.

#### Exit gate

- a non-Lua Room v2 fixture renders through actual world/material/Layout/RuntimeUI paths;
- runtime and focused adapters produce equivalent Room resolution/baseline snapshots for structured
  fixtures;
- no compiled project or runtime Layout session is created;
- failure preserves the prior complete owner; and
- candidates requiring any of the exact Phase 12 Lua features listed above fail closed without
  exposing a partial production path.

### Phase 12: Focused Lua conditions, text, and Room composition

#### Required work

1. Add ScriptRuntime environment handles and RuntimeUI per-document preview-environment dispatch,
   including focused `_G`, environment-local standard/API table isolation, the current restricted
   library profile, and environment-bound `load` behavior from Section 9.8.
2. Extract the read-only query-provider seam and adapt `RuntimeCommandGateway` without runtime
   behavior change.
3. Implement the focused provider over the candidate-wide lexical-plus-explicit read-admission union
   and deterministic query state. Keep Room-composition draft mutation IDs as the separately enforced
   composition-source subset.
4. Execute Room Lua predicates and text expressions synchronously with exact admitted-dependency
   enforcement.
5. Execute the compose Script with the same function contract, capability profile,
   `RoomCompositionDraftAccess`, and no-yield enforcement as runtime.
6. Execute the focused Layout dedicated Lua component only when
   `scriptEnabled && containsDedicatedLuaSource`; execute inline/external/template `<script>` content,
   static `on*` handlers, direct-string `AddEventListener`, and direct-string `load` code whenever
   those RML-owned execution sites are present. All execute in the same isolated committed
   environment.
7. Close capabilities/draft access on every path and reject queries not admitted by lexical analysis
   or explicit fallback.
8. Preserve prior visual on any Lua/composition/Layout-Lua failure and prove failed/superseded
   candidates cannot leak globals or mutate ScriptRuntime/other-preview standard and API tables.
9. Add runtime/focused equivalence fixtures for condition results, text results, and visibility
   composition.

#### Exit gate

- current supported Room Lua presentation behavior executes without `RuntimeSession`;
- runtime capability and composition behavior is unchanged;
- focused behavior is deterministic and admitted-dependency-limited;
- unadmitted queries fail locally; and
- equivalence tests pass.

### Phase 13: Production Room cutover and pooled-host hardening

#### Required work

1. Route production Room preview through the coordinator and unified native document path.
2. Remove `buildRoomPreviewRml()`, Room generated-RML CSS/markup, Room v1 builder, and ad hoc
   `dependencyRevision()`.
3. Remove Room's remaining recursive `collectProjectAssetPaths()`/compatibility staging path; Layout
   and Shader recursive staging and obsolete ABI callers were already removed in Phase 8.
4. Remove any temporary Room-only widget/native compatibility branches introduced by Phases 9–12.
5. Harden Room A→Room B, Room↔Layout, Room↔Shader, rapid same-root updates, lease transfer,
   tab-group move, reconnect, and project switch.
6. Verify reveal/hidden rules, resize, DPR, pointer, wheel, activity, visibility, Game HUD input,
   and environment clocks after every transition.
7. Run mounted editor integration tests for every Section 10 change.
8. Verify scoped diagnostics never contain unrelated Problems warnings.
9. Remove temporary compatibility branches only after production assertions exist.

#### Exit gate

- production Room preview is focused and native;
- no Room edit compiles/loads a project or reloads the iframe;
- every transition ends on the latest correct root/revision;
- no old-root content is revealed under a new lease;
- no unrelated diagnostics accumulate; and
- Room v1/generated RML is absent.

### Phase 14: Graph-backed atomic repair

#### Required work

1. Implement repair-plan generation and preview from the graph descriptors in Section 5.6.
2. Implement the complete initial repair matrix, including Room-placement and Room deletion effects.
3. Revalidate project and graph revision immediately before confirmation and regenerate stale plans.
4. Apply repairs, record/nested-record deletion, editor metadata cleanup, and ID remaps as one
   command transaction and one structural persistence unit.
5. Remove shared-parent array items in descending index order and reject partial repair.
6. Integrate Undo, Redo, recovery, and structural-persistence rollback mutation facts.
7. Keep Force Delete explicit and separate; unsupported or replacement-required relationships fail
   closed without deleting the target.
8. Implement warning-only lexical Lua preflight and blocked explicit-fallback deletion exactly as
   Section 5.6 specifies. Do not add Lua source rewriting.

#### Exit gate

- supported repairs are previewed, revision-safe, atomic, undoable, and recoverable;
- unsupported/replacement-required repairs fail closed without deletion;
- possible Lua usages warn without blocking, while explicit Lua fallbacks block ordinary deletion
  and remain diagnostic after Force Delete;
- failed persistence restores project, history, graph, and preview freshness coherently; and
- no repair behavior is required by or coupled into the Room preview apply path.

### Phase 15: Verification, permanent documentation, and archival

#### Required work

1. Run all focused graph, repair, coordinator, widget, protocol, native presenter, world, Layout,
   RuntimeUI, asset, Lua, and Room test matrices.
2. Run the exact editor commands in Section 13.
3. Run Linux debug configure/build/full CTest and policy/probe targets.
4. Run Web debug/editor-preview build and focused Web smoke.
5. Run format checks and `git diff --check`.
6. Perform the manual smoke matrix in Section 12.
7. Audit and reconcile the permanent docs already updated by the implementation phases under editor
   preview/workbench/project, architecture, Room, Layout, Asset, Lua, and rendering/presentation
   areas. Add any missing final-state documentation discovered during certification.
8. Remove/correct permanent text that says derived Room preview uses a compiled package.
9. Mark every phase complete and move this plan to `docs/archive/plans/`.

#### Exit gate

- every required validation passes or a concrete environment blocker is recorded;
- permanent docs fully describe the implemented contracts without relying on this plan;
- no superseded path or temporary compatibility branch remains; and
- the plan is archived.

## 12. Required test and manual-smoke matrix

### 12.1 Graph and repair tests

Cover all current generic reference kinds, semantic role upgrades, nested Room placements/exits,
property definitions, localization keys, material inheritance, typed Lua-source discovery,
lexical/evidence edges, explicit fallbacks, forward/reverse
closure, cycles, path overlap, missing targets, deterministic order, old/new impact union,
compatibility projection, repair generation, revision revalidation, atomic delete+repair, Undo/Redo,
Force Delete, and recovery overlays. Cover the existing tolerant structural-admission boundary for initial load,
migration, recovery reconstruction, ordinary commands, active-transaction steps, transaction
cancellation, commit-only finalization, Undo, Redo, structural-persistence rollback, and explicit
replacement. Prove semantically invalid but structurally representable commands remain publishable,
commit-only transaction finalization publishes no second content revision, and
`/editor`-only metadata publication publishes no content mutation. For every rejected malformed
candidate, prove the prior document, history position, project revision, mutation facts, graph
snapshot, and preview freshness remain unchanged. Prove damaged raw-file recovery remains outside
the authoritative store until structural admission succeeds. Cover required field-effect metadata,
generated graph-input classification, missing-metadata failure, broad/structural fallback,
record/array/map ownership, graph-stable object identity, contribution replacement, reverse
derivation keys, decoded-literal owner indexes, symbol-only reprojection, and canonical equivalence to
a fresh full build after every mutation sequence. Cover Room-description typing with zero contribution
or source-analysis work; local relationship edits with exact owner replacement; localization and
property-chain edits with exact reverse-dependent owner replacement; target-ID add/delete/rename with
zero reread/relex, source-owner rename/path rebinding with only cheap owner projection, and
shared/transitive source changes with only consuming owners reanalyzed. Cover complete logical
snapshot byte/occurrence limits across inline sources and cache hits, asynchronous source-byte and
source-artifact cache hits, duplicate Asset IDs sharing one physical path/hash with one IPC read and
distinct renderer fan-out provenance, stale/unknown project read sessions, hash
mismatch/unreadable/invalid-UTF-8 diagnostics, every `updating` phase, stale source/analysis
completion, accumulated superseding work, and refusal to confirm graph-backed mutations against a
stale graph revision.

### 12.2 Preview builder/coordinator tests

Cover canonical hashes, input revisions, manifest deduplication/conflict/hash absence, unreferenced
Asset addition, background selection, Asset reimport, Game HUD assignment/edit, Character and
Interactable moves, Room visuals, localization filtering, exit target filtering, lexical Lua
occurrences, explicit fallbacks, RML event/script/template extraction,
first load/update, coalescing, out-of-order fetches, reconnect replay, inactive tabs, stale leases,
same-root failure retention, new-root hiding, builder-failure diagnostic scopes before a document
revision exists, document-revision widget/native scopes, cache hits, compiled Shader-output
hashes, byte sizes, and input fingerprints computed/validated on compile and cache-hit paths,
rejection of `cacheKey` as a digest,
ordinary Asset fetch/logical path equivalence, compiled Shader
`.noveltea/build/...` fetch versus `project:/shaders/...` mount separation, unsafe or mismatched
`outputPath` rejection, relative and `project:/` runtime-path normalization, closed Shader-variant
validation, native-authoritative active-variant selection, unknown/empty active-variant rejection,
host-generation/capability changes, partial staging failure followed by a subset request, and
project-instance reset. Cover native manifest projection, `usageRoles` changes that leave resource
and document revisions unchanged, missing/invalid imported Asset byte sizes, per-resource/aggregate
manifest limit rejection before fetch, absent/dishonest `Content-Length`, bounded-body overflow,
exact byte-count/hash mismatch before Web filesystem write, TypeScript/native limit parity, oversized
request rejection before fetch/write/generation advance, and project-asset server symlink/realpath
escape rejection. Cover
relative versus `project:/` RML URI bases, undeclared/ambiguous
script/template paths, template cycles and nested relative links, closed built-in template IDs, and
the rule that no path discovered only from RML is fetched.

### 12.3 Native tests

Cover strict decoder failures/limits, required native manifest projection, source-bearing versus
generic string limits, focused catalog, source refresh, typed texture/material/font/Shader requests,
lease retention/rollback, real draws for every Room world family, draw identity/order,
multiple focused Layouts, Game HUD binding, static UI values, passive input, clocks, resize/DPR,
content-owner transitions, supersession, rollback, and ready-handshake reporting of the initialized
renderer's closed active Shader variant.

### 12.4 Lua equivalence tests

Cover Lua 5.5 quoted/long strings and comments, exact/case-sensitive ID matching, ambiguous
top-level collection candidates and explicit qualified nested targets, inline
predicates/expressions, inline and Asset-backed
composition Scripts, dedicated Layout Lua, static `on*` attributes, inline/external `<script>`,
transitive template Lua, direct-string Element/Context `AddEventListener`, direct-string bare
`load(...)`, lexical-plus-explicit
candidate-wide read admission across shared Room/Layout globals, composition-only draft admission,
definition/Variable/property/Interactable queries,
Character/Interactable draft visibility, condition and text results, missing and unadmitted queries,
capability denial, malformed lexical source, Lua traceback, yield rejection, draft closure,
generation staleness, focused `_G`, standard/API table mutation isolation, disabled-library/random
preservation, and runtime/focused parity. Prove failed/superseded candidates cannot leak globals or
nested table mutations. Prove computed/aliased dynamic code and dynamically generated RML remain
explicit unsupported analysis cases rather than being falsely reported as covered.

### 12.5 Manual smoke

Use a real project and verify:

- Room description typing does not flicker or reload and development instrumentation reports zero
  graph contribution/source-analysis work;
- background selection and reimport;
- persistent Character and Room-cast visual edits;
- Interactable add/move/remove;
- prop and environment edits;
- Game HUD assignment and live RML/RCSS/Lua edit;
- localized description/placement edit and plain exit-label edit;
- Lua condition/text success, failure, and correction;
- composition success, unadmitted-query failure, and correction;
- Room A/B, Room/Layout, and Room/Shader switching;
- tab-group move, split resize, and DPR change;
- inactive-tab changes followed by return;
- host reconnect/replay;
- possible-Lua delete warning, explicit-fallback delete block/Force Delete diagnostic, rename warning
  without Lua rewriting, delete-and-repair, Undo, and Redo; and
- Preview Diagnostics replacement and Problems isolation.

## 13. Exact validation commands

Run builds sequentially and preserve `CMAKE_BUILD_PARALLEL_LEVEL`.

Editor:

```sh
pnpm -C editor run format:check
pnpm -C editor run typecheck
pnpm -C editor run check
pnpm -C editor run test
pnpm -C editor run build:renderer
pnpm -C editor run build:electron
pnpm -C editor run engine:preview:build
```

Linux and policies:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --build --preset linux-debug --target cxx-policy
cmake --build --preset linux-debug --target json-boundary-policy
cmake --build --preset linux-debug --target module-boundary-policy
cmake --build --preset linux-debug --target public-header-probes module-dependency-inventory
cmake --build --preset linux-debug --target format-check
```

Web:

```sh
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset web-debug --target cxx-policy
cmake --build --preset web-debug --target public-header-probes module-dependency-inventory
```

Finish with:

```sh
git diff --check
```

Run narrower focused tests during each phase. Phase 15 owns the complete command set above.

## 14. Cutover safety

1. Phases 1–3 preserve visible preview behavior.
2. The ReferenceIndex compatibility projection remains until all compiler/search/rename/delete/usage
   callers and tests are graph-backed.
3. Phase 4 preserves tolerant structural admission while establishing precise mutation facts before any
   renderer graph service or graph-backed structural command becomes authoritative.
4. Phase 5 proves incremental graph equivalence, graph-stable zero-work behavior, selective source
   analysis, and stale-completion safety before consumers migrate.
5. Phase 6 migrates usage/preflight consumers only after the current-revision graph contract is
   established.
6. Phase 7 establishes strict focused transport, immutable generation staging, and the common native
   request/acknowledgement contract using
   hidden Layout/Shader fixtures while production preview behavior remains unchanged.
7. Phase 8 migrates production Layout/Shader freshness before native Room is combined with that path.
8. Room v1 remains the production Room visual through Phase 12.
9. No intermediate phase binds a partial project or runtime session to `LayoutRealizer` merely to
   make Room preview work.
10. Native Room prepared-state/no-fail commit, supersession, non-Lua baseline, and focused Lua equivalence pass before
    cutover.
11. Phase 13 removes Room v1 only after v2 covers resources, conditions/text, composition, UI,
    diagnostics, invalidation, and pooled-host transitions.
12. Phase 14 adds automatic repair only after preview cutover, so repair implementation cannot block
    or distort the focused-preview architecture.
13. Each phase updates permanent documentation for contracts it establishes or cuts over; Phase 15
    performs the final cross-document audit and archives the plan.

At every intermediate commit, either production Room v1 remains complete or production native v2 is
complete. Do not commit a state that routes users to a partial native path.

## 15. Completion tracking

- [x] Phase 1: Characterization and shared contracts (revalidated 2026-07-26)
- [x] Phase 2: Pure authoring dependency graph (revalidated 2026-07-26)
  - [x] Subpart 1: Contribution storage and deterministic assembly (2026-07-26)
  - [x] Subpart 2: Structural adapters and semantic edge upgrades (2026-07-26)
  - [x] Subpart 3: Compatibility projections for references, compiler linking, and search (2026-07-26)
  - [x] Subpart 4: Traversal, path-impact, registry-audit, and structural benchmark tests (2026-07-26)
  - [x] Subparts 5-9: Remaining validation, audits, and benchmark coverage (2026-07-26)
- [x] Phase 3: Pure Lua/RML analysis and graph evidence (revalidated 2026-07-26)
  - [x] Post-Phase 3 correction gate: possible/explicit edge metadata and resolvable
    `property-value` target semantics (revalidated 2026-07-26)
- [x] Phase 4: Authoritative project publication and precise mutation facts (revalidated 2026-07-26)
- [x] Phase 5: Incremental renderer graph service and source resolution (revalidated 2026-07-26)
- [x] Phase 6: Graph consumer migration and structural preflight (revalidated 2026-07-26)
- [x] Phase 7: Focused preview protocol, resources, and unified native transport (revalidated 2026-07-26)
- [x] Phase 8: Freshness coordinator and Layout/Shader production migration
- [x] Phase 9: Graph-driven Room v2 builder
- [x] Phase 10: Native focused-preview foundation
- [x] Phase 11: Shared Room resolution and native baseline
- [x] Phase 12: Focused Lua conditions, text, and Room composition
- [x] Phase 13: Production Room cutover and pooled-host hardening
- [x] Phase 14: Graph-backed atomic repair
- [x] Phase 15: Verification, permanent documentation, and archival (2026-07-26)

Phase 15 certification:

- editor format, typecheck, lint/check, 1,006-test suite, renderer build, Electron build, and
  editor-preview Web build passed;
- Linux debug configure/build and all 766 CTest cases passed under Xvfb;
- Linux and Web C++ policy, JSON-boundary, module-boundary, public-header, and dependency-inventory
  gates passed;
- Web debug build and Chromium focused smoke passed;
- packaged Electron build and Xvfb package smoke passed;
- final certification corrected Room background precedence, JSON/module policy defects, and the
  remaining fixture-only production Room commit gate;
- permanent graph, preview, workbench, architecture, Room, Layout, Asset, Lua, and rendering docs were
  reconciled; and
- the human-operated Section 12.5 matrix is recorded as blocked by the noninteractive execution
  environment, with its underlying contracts covered by automated matrices and host launch smokes.

## 16. Definition of done

The implementation is complete only when:

- one pure graph backs compatibility references, usages, structural impact, repair, and preview
  dependency selection;
- every authoritative working project preserves the existing structural-versus-semantic validation
  boundary, and structurally rejected candidates cannot displace the prior valid document, graph, or
  preview state;
- renderer graph state is deterministic and updated from monotonic project mutations;
- graph refresh uses required field-level graph effects, colocated adapter dependency declarations,
  and immutable contribution replacement from the beginning; explicit `none` fields reuse the same
  `snapshot.graph` object in a new revision wrapper and perform zero source work;
- source analysis artifacts are cached independently of the current symbol table, target identity
  changes reproject only owners indexed by the affected decoded literal, and localization/property/
  source changes use exact reverse derivation dependencies;
- every incremental graph result is canonically equal to a fresh full build, with explicit full-build
  fallback for structural ambiguity rather than stale partial publication;
- every current authoring Lua/RML execution source is discovered through the typed source registry,
  with bounded exact-literal evidence, deterministic container/decoded-region provenance, ambiguous
  candidate grouping, and source-only Script Asset ownership;
- possible Lua usages warn without becoming compiler errors or automatic repairs, while supported
  explicit fallbacks are tooling-confirmed and enforce preflight policy;
- Room placement and exit nested targets are first-class and safely repairable;
- supported delete repairs are atomic and unsupported repairs fail closed;
- Layout, Shader, and Room use one freshness coordinator and one pooled-host ordering model;
- focused document/resource revisions reflect exactly consumed values;
- the widget stages only explicit hash-verified changed authoring Assets and compiled Shader outputs,
  with physical fetch paths separate from runtime logical mount paths;
- compiled Shader hashes are derived from output bytes rather than compile cache keys, compile-input
  fingerprints reject stale binaries, and the initialized native renderer's closed Shader variant is
  the sole active-variant authority;
- native source generations advance exactly when staged referenced bytes change;
- Room preview uses real native world, material, Layout, Game HUD, RuntimeUI, display/DPR, input, and
  clock paths;
- Room presentation conditions, text, composition, and mounted Layout Lua use one deterministic
  candidate-wide lexical-plus-explicit read admission compatible with their shared Lua environment;
  composition draft mutation remains restricted to its composition-source subset;
- Lua rename/delete source rewriting and rewrite-grade original-byte/entity mapping remain explicitly
  deferred while the required container/region occurrence provenance is retained;
- no derived Room edit compiles or loads a complete project;
- same-root failures preserve the prior visual and new-root failures never reveal old content;
- stale requests, leases, diagnostics, resources, and native completions cannot become current;
- project-wide behavior matches every Section 10 requirement;
- Room generated-RML simulation, ad hoc Room dependency fingerprints, recursive staging for migrated
  kinds, and obsolete editor-document ABI are removed;
- all automated and manual validation passes;
- permanent documentation is current; and
- this plan is archived.
