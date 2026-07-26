# Authoring Dependency Graph

The editor has one pure structural dependency graph for the current `AuthoringProject`. It is
derived entirely in shared TypeScript and is not persisted. Phase 2 establishes non-Lua structural
relationships only; lexical Lua/RML evidence and the renderer-owned incremental service are later
layers over the same contribution model.

## Authority and construction

`editor/src/shared/authoring-dependency-graph.ts` owns the graph model, structural contribution
derivation, deterministic assembly, traversal, path-impact queries, and compatibility projection
inputs. `buildAuthoringStructuralDependencyGraph(project)` is exactly the assembly of
`buildAuthoringStructuralDependencyGraphContributionSet(project)`.

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
- localization-key nodes for exact default/fallback resolution;
- fixed project-field nodes for startup, entrypoint, display, accessibility, default font, every
  system Layout role, and localization selection.

Semantic adapters upgrade current Asset, Variable, Shader, Material, Layout, Character, Room,
Interactable, Script, settings, properties, localization, Scene, Dialogue, Map, Verb, Interaction,
and Test relationships. Room contributions also consume the exact display, accessibility, default
font, and Game HUD project-field nodes required by Room preview closure. Lua strings are not inferred
by this structural layer.

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
