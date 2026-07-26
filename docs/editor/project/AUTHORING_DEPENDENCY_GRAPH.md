# Authoring Dependency Graph

The editor has one pure dependency graph for the current `AuthoringProject`. It is derived entirely
in shared TypeScript and is not persisted. Structural relationships and bounded Lua/RML evidence use
the same deterministic contribution model; the renderer-owned incremental service is a later layer.

## Authority and construction

`editor/src/shared/authoring-dependency-graph.ts` owns the graph model, structural contribution
derivation, deterministic assembly, traversal, path-impact queries, and compatibility projection
inputs. `editor/src/shared/project-schema/authoring-lua-source-registry.ts` owns the schema-derived
Lua execution-surface and explicit-fallback-owner registry.
`editor/src/shared/authoring-source-analysis.ts` owns source enumeration over that registry,
content artifacts, owner projection, external-source closure, and literal indexing.
`buildAuthoringStructuralDependencyGraph(project)` is exactly the assembly of
`buildAuthoringStructuralDependencyGraphContributionSet(project)`.

`buildAuthoringDependencyGraph(project, luaAnalysis)` is the final wrapper. Disabled mode preserves
the structural compatibility graph while adding supported explicit tooling fallbacks. Enabled mode
adds warning-level lexical evidence and source diagnostics without adding `reference-integrity`
facets or changing compiled gameplay bytes.

Each record, property definition, localization key, or fixed project field owns one complete
`AuthoringDependencyGraphContribution`. Replacing a contribution replaces its nodes, outgoing
edges, diagnostics, derivation dependencies, and literal-occurrence storage as one unit. Assembly
rebuilds immutable forward, reverse, ownership, derivation-key, and decoded-literal indexes in
canonical order.

Canonical edge identity includes the source node, source path, target node, and semantic role.
Generic and typed derivation of the same source/target relationship is merged once, with the typed
role and facets winning deterministically. Missing targets remain represented by their expected
node key and produce final-assembly diagnostics.

## Nodes and relationships

The structural graph contains:

- top-level records for every authoring collection;
- Room placement and Room exit nested nodes;
- property-definition nodes;
- owner/property-value nodes used by explicit Lua fallback declarations;
- localization-key nodes for exact default/fallback resolution;
- fixed project-field nodes for startup, entrypoint, display, accessibility, default font, every
  system Layout role, and localization selection.

Semantic adapters upgrade current Asset, Variable, Shader, Material, Layout, Character, Room,
Interactable, Script, settings, properties, localization, Scene, Dialogue, Map, Verb, Interaction,
and Test relationships. Room contributions also consume the exact display, accessibility, default
font, and Game HUD project-field nodes required by Room preview closure.

Lua source discovery is registry-driven and covers startup, Script records, Layout Lua/RML,
condition/text/effect variants, Scene and Dialogue `run-lua`, Verbs, Interactions, Tests, and the
other schemas that embed those shared variants. Shader and ordinary Asset source text are not Lua
owners. Content analysis is owner-neutral and cached by exact content plus URI base; semantic-owner
binding supplies authoring paths and ownership without relexing.

The same registry classifies the limited authoring locations that support
`additionalDependencies`. Validation, explicit graph-edge derivation, and focused-preview facets do
not maintain separate path lists. Duplicate explicit targets are invalid. Unsupported metadata is
preserved with a warning but does not create tooling-confirmed dependency edges.

RML analysis uses `saxes` plus a same-length RmlUi raw-text masker. It indexes event attributes,
inline scripts, declared external scripts, and cycle-safe transitive template closures. Relative and
`project:/` URIs are normalized deterministically against the containing source Asset and must match
exactly one declared dependency. Template names are resolved from linked template definitions.
Fixed source, snapshot, owner-occurrence, template-depth, and template-count limits produce warning
diagnostics while preserving unrelated graph content.

`layout.script.enabled` gates only the dedicated `layout.lua` source. Disabled dedicated Layout Lua
remains indexed for Find Usages but contributes no focused-preview facet. Event attributes, inline
or declared external scripts, templates, direct-string `AddEventListener`, and direct-string `load`
belong to the mounted RML document and remain analyzable independently of that flag.

Graph derivation tolerates structurally admitted but semantically invalid record fragments. Safely
readable `$ref`, `$var`, flow, Room placement, and Room exit relationships remain available, while
owner-local failures such as invalid Room placement selections, Dialogue block targets, Scene step
targets, and Map location targets become graph diagnostics instead of suppressing unrelated graph
content.

## Path-sensitive impact

Preview impact is segment-aware and never uses string-prefix matching. A preview root is affected
when its own path changes, referenced target identity changes, or a changed path overlaps an edge's
declared `targetImpactPaths`.

Semantic edges deliberately consume only observable target fields. Examples include Asset source
path/hash/kind/extension/sampling, Material and Shader presentation data, selected Layout runtime
content, Character Room visuals, Interactable Room presentation/state, Script source, and exact
project settings. Unlisted sibling fields do not invalidate a dependent root. Old/new graph impact
queries union both closures so rewired relationships invalidate both prior and current dependents.

Room closure additionally follows incoming Character and Interactable Room-placement relationships.
This allows movement or initial-state changes on a subject record to invalidate the affected Room
without making Room placement IDs project-wide record nodes.

## Field metadata and audits

`editor/src/shared/project-schema/authoring-graph-field-metadata.ts` derives the complete authoring
field-path set from `authoringProjectSchema` and assigns every leaf an explicit intrinsic graph
effect. A per-schema-root fingerprint is pinned in source. Adding, removing, or reshaping an
authoring field therefore fails the graph metadata audit until its effect is reviewed and the
fingerprint is deliberately updated. There is no implicit graph-stable default for new schema
fields.

The generated classifier supports concrete wildcard matching and conservative structural fallback
for known parent paths. `assertGraphInputRegistryComplete()` compares fresh full construction,
contribution-set assembly, and incremental contribution replacement for representative mutations.
It also proves declared `none` fields leave graph output unchanged.

## Current consumers

`buildReferenceIndex()` and `findUsages()` are compatibility projections over confirmed
`reference-integrity` graph edges. Shared compiler linking and project search use the same structural
graph projection; they do not run a second whole-project reference scan. Their public result shapes
and ordering remain compatible with the pre-graph contracts.
