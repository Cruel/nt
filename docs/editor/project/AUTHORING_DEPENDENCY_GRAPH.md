# Authoring Dependency Graph

## Native renderer consumers (#537; preparatory, not production)

When the **admitted native Project-session mode** is enabled, the guarded
`NATIVE_PROJECT_SEMANTIC_GRAPH` IPC channel requests the working revision from
`NativeEditorSessionController.semanticGraph()`. The renderer indexes the
returned native DTO in `native-authoring-graph-projection.ts` without re-running
TypeScript semantic derivation or source analysis. The
`native-authoring-graph-runtime.ts` service rejects superseded Project/session/
working-revision replies, retains the prior graph for old/new preview closure,
and publishes only a complete revision-matched projection.

The existing hook, command-bus, structural repair, editor reference panels,
Project Explorer, and focused Room preview receive indexed native edges and
source occurrences in the previous **presentation** shape. Physical source
occurrences are not JSON authoring patches: exact/native rewriteable evidence
remains manual pending an explicit source-transaction editor, and
`possible-lexical` findings remain warnings. Graph unavailability or
incomplete owner proof blocks destructive operations. Native-mode Project
sessions can safely rename confirmed structured `/$ref`, typed Variable `/$var`,
and Project entrypoint fields even if those references cannot be automatically
repaired for deletion. Native rename preflight is independent of deletion
repair policy: the rename command uses native structural edges and checks the
admitted field's actual reference encoding (typed `/$ref`, Variable `/$var`,
typed Flow targets and scalar IDs) before writing a patch. Unknown encodings
block the rename rather than silently dropping an edge or re-running
whole-Project TypeScript schema validation. Aggregate source-recognized edges
remain in the native DTO for preview impact, but Find Usages indexes physical
source occurrences only to prevent duplicate results. Physical source text
requires explicit confirmation and is never rewritten by a JSON patch.
Nullable Room
background/prop/environment references, composition Scripts and system Layouts
receive native `set-null` repair descriptors at the containing field; unsupported
references remain blocked, and physical source text is never implicitly
rewritten during a record rename. Exact source occurrences and localization
Message references retain the native physical URL and line/column evidence.
Native physical Asset changes trigger a fresh graph query even without an
authored Project mutation, so preview resources cannot reuse obsolete evidence.

Native-mode Project Search uses a revision-matched native-backed reference index instead of
re-deriving structural relationships; text matching, filters, alias UI, and
result sorting remain presentation algorithms. Changed on-disk resources
without a new structured Project revision conservatively invalidate focused
previews, while structured edits consider both the old and new native edge
closure.

Only native Project sessions use this reader. The existing TypeScript graph
runtime and old graph derivation remain active for the **legacy production
route**, pending the atomic production switch in #521. That switch must remove
the old `authoring-dependency-graph-service.ts` builder, the legacy branch of
`authoring-dependency-graph-runtime.ts`, and the legacy-only
`buildAuthoringStructuralDependencyGraph` search fallback after all callers
have moved to native session authority. Shared graph *contracts*, identity
serialization, traversal and UI-only projection helpers may remain if they
do not originate semantic relationships or external source interpretation.

### Legacy import inventory for #521

- `authoring-dependency-graph-runtime.ts` retains the legacy
  `AuthoringDependencyGraphService` publication, wait, subscription and
  source-analysis branches. Native mode bypasses these calls.
- `command-store.ts` retains legacy `waitForCurrentSnapshot` in its
  synchronous structural persistence queue. Admitted native commands use
  revisioned asynchronous admission instead.
- `DerivedPreviewPane.tsx` calls `currentSourceAnalysis` only in legacy mode;
  `focused-preview-coordinator.ts` retains a legacy traversal branch and uses
  native impact facets for native mode. `room-focused-preview-builder.ts`
  traverses supplied graph edges only to compose the focused UI display.
- `project-search-index.ts` and `project-schema/authoring-references.ts`
  retain non-native structural graph fallbacks. Native Explorer, Find Usages,
  and Asset Library explicitly supply native-backed reference indexes.
- Asset, Variable, Interactable, Localization, and Explorer editors retain
  the snapshot hook as a presentation boundary. Identity helpers imported
  from `authoring-dependency-graph.ts` do not build semantic edges.
- `localization-message-operations.ts` retains separate managed-text
  localization source-refactoring analysis; this is outside graph building
  and its retirement must be separately reviewed in #521.

## Native replacement boundary (#536; preparatory, not production)

The existing TypeScript implementation described below remains the **pre-cutover production**
authority. Issue #536 introduces a separate read-only native Project-session query:
`ProjectSession::semantic_graph(expected_revision)` in
`tools/project_authoring/semantic_graph.cpp`. It derives records and reference evidence from
resident native normalized/working records, native localization contributors, and
`source_analyses()`. It does not call any TypeScript authoring graph or Project validator.

The opt-in Node-API method `semanticGraph(handle, revision)` is carried through
`native-authoring-worker.ts`, `NativeAuthoringSessionBridge`,
`NativeAuthoringWorkingProject.semanticGraph()`, and
`NativeEditorSessionController.semanticGraph(projectSessionId, expectedRevision)`.
The latter verifies the main-owned Project identity and revision both **before and after**
the worker response. `nativeSemanticGraphSchema` is a strict immutable-result DTO with
native node/edge identities, semantic roles, preview facets, target-impact paths,
source occurrences, source revisions, incomplete owners, and diagnostics.
`native-semantic-graph-queries.ts` only filters/projects that DTO; it must not use
the retired TypeScript derivation algorithms for fallback answers.

Native source evidence distinguishes schema-derived references from
`exact-rewriteable` managed literals (single-owned physical text with checked
UTF-16 range and expected text), `exact-manual` recognizer findings, and
`possible-lexical` matches. Generic ID-shaped strings do not become structural
edges. Unknown repair actions remain explicitly blocked. A graph can expose
valid owners' evidence alongside incomplete or invalid neighbors; destructive
preflight rejects incomplete or superseded generations. Exact physical observer
revisions and source-analyzer content hashes remain distinct evidence types.

Native token recognizers cover Script Module literal `import`, the module argument
of `hooks.register("room", …)`, typed `noveltea.project.room/character/interactable`
identity calls, and `noveltea.presentation.cursor.set`. The source scanner also
recognizes named Layout RML/RCSS cursor declarations and `Text.msg` source
keys. Comment/string imitations of APIs remain lexical, never exact references.
Only uniquely identified, single-owned physical literals may be auto-rewriteable;
the native DTO never grants write authority itself. No exception to native source
or Project semantics was approved for #536. Unsupported or ambiguous source
references stay manual/warning evidence and cannot silently qualify as repaired.

The #521 **switch-only handoff** now consists of activating the admitted native
renderer session mode as production, verifying that all native Project
references and previews use the #537 DTO projection, and removing retired
TypeScript graph/analysis authority and its legacy-only imports. The #536
methods were originally unexposed to the renderer; #537 exposes them only for
native sessions. Legacy production remains unchanged until the atomic switch.

This is **not** permission to swap the renderer graph service in isolation.
The native and TypeScript services coexist for certification only; #521 owns
the atomic editor/CLI authority switch and retirement of the old implementation.

The editor has one pure dependency graph for the current `AuthoringProject`. It is derived entirely
in shared TypeScript and is not persisted. Structural relationships and bounded Lua/RML evidence use
the same deterministic contribution model. The renderer-owned runtime service incrementally replaces
those pure contributions against the authoritative project publication stream.

## Authority and construction

`editor/src/shared/authoring-dependency-graph.ts` owns the graph model, structural contribution
derivation, deterministic assembly, traversal, path-impact queries, and compatibility projection
inputs. `editor/src/shared/project-schema/authoring-lua-source-registry.ts` owns the schema-derived
Lua execution-surface and explicit-fallback-owner registry.
`editor/src/shared/authoring-source-analysis.ts` owns source enumeration over that registry,
content artifacts, owner projection, external-source closure, and literal indexing.
`editor/src/shared/authoring-source-references.ts` owns the semantic source-reference recognizer
extension boundary. Its production registry contains only concrete designed APIs: Script Module
`import`, the Script Module argument of literal Room `hooks.register`, typed gameplay-identity lookup,
and named cursor selection. Adding another API-specific recognizer must not require changes to graph
assembly or mutation algorithms.
`buildAuthoringStructuralDependencyGraph(project)` is exactly the assembly of
`buildAuthoringStructuralDependencyGraphContributionSet(project)`.

`buildAuthoringDependencyGraph(project, luaAnalysis)` is the final wrapper. Disabled mode preserves
the structural compatibility graph while adding supported explicit tooling fallbacks. Enabled mode
adds warning-level lexical evidence and source diagnostics without adding `reference-integrity`
facets or changing compiled gameplay bytes.

Compiler linking uses `missingAuthoringStructuralReferences(project)`, a reference-integrity-only
projection of the same structural traversal. It retains top-level, project-field, Trait, and nested
target checks without building editor indexes, localization workflow nodes, source-occurrence
metadata, or incremental impact dependencies. Localization realization edges do not carry the
`reference-integrity` facet; translation/source contracts remain owned by semantic validation.
Full graph construction remains authoritative for editor and source-analysis consumers.

Each record, property definition, localization Message realization, or fixed project field owns one
complete `AuthoringDependencyGraphContribution`. Replacing a contribution replaces its nodes,
outgoing edges, diagnostics, derivation dependencies, and literal-occurrence storage as one unit.
Assembly rebuilds immutable forward, reverse, ownership, derivation-key, and decoded-literal indexes
in canonical order.

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
- localization-message nodes keyed by locale plus stable authoring Message identity for exact
  Source/target realization dependencies;
- fixed project-field nodes for startup, entrypoint, display, accessibility, default font, every
  system Layout role, and Source/Default localization selection.

Semantic adapters upgrade current Asset, Variable, Shader, Material, Layout, Character, Room,
Interactable, Script, settings, properties, localization, Scene, Dialogue, Map, Verb, Interaction,
and Test relationships. Room contributions also consume the exact display, accessibility, default
font, and Game HUD project-field nodes required by Room preview closure.

Source discovery is registry-driven and covers startup, Script records, Layout Lua/RML/RCSS,
condition/text/effect variants, Scene and Dialogue `run-lua`, Verbs, Interactions, Tests, and the
other schemas that embed those shared variants. Shader and ordinary Asset source text are not Lua
owners. Layout RCSS participates in the same bounded source snapshot specifically for exact cursor
reference analysis; it is not treated as executable Lua. Content analysis is owner-neutral and cached
by exact content plus URI base; semantic-owner binding supplies authoring paths and ownership without
relexing.

File-backed Layout and Script Module occurrences retain a canonical
`project:/<project-relative-path>` source URL through content analysis, owner binding, graph evidence,
diagnostics, Find Usages, and Project Search. Host absolute paths are never graph/search identities.
Asset-backed Layout/Script sources retain the canonical `project:/` URL of the referenced Asset
source and are never relabeled as owning-record companion files.
Source diagnostics retain their source URL and exact line/column when the analyzer has a concrete
source location.

Every source occurrence admitted as reference evidence is classified as exactly one of
`exact-rewriteable`, `exact-manual`, `possible-lexical`, or `unrelated`. Recognizers run before the
generic lexical symbol projection. An ID-shaped string match alone remains `possible-lexical`; only
an explicitly registered semantic recognizer may promote it to an exact typed edge. An
`exact-rewriteable` recognizer must supply an exact UTF-16 source range plus expected text so rename
can fail closed if the analyzed source no longer matches.

The same registry classifies the limited authoring locations that support
`additionalDependencies`. Validation, explicit graph-edge derivation, and focused-preview facets do
not maintain separate path lists. Duplicate explicit targets are invalid. Unsupported metadata is
preserved with a warning but does not create tooling-confirmed dependency edges.

RML analysis uses `saxes` plus a same-length RmlUi raw-text masker. It indexes event attributes,
inline scripts, declared external scripts, cycle-safe transitive template closures, and literal
`cursor:` declarations in embedded `<style>` blocks and `style` attributes. Dedicated inline and
Asset-backed Layout RCSS use the same literal cursor scanner. Unknown static cursor names become exact
source diagnostics; Project named cursor references become exact graph edges with source locations and
rewrite ranges where the source is project-document-owned. Relative and `project:/` URIs are
normalized deterministically against the containing source Asset and must match exactly one declared
dependency. Template names are resolved from linked template definitions. Fixed source, snapshot,
owner-occurrence, template-depth, and template-count limits produce warning diagnostics while
preserving unrelated graph content.

`layout.script.enabled` gates only the dedicated `layout.lua` source. Disabled dedicated Layout Lua
remains indexed for Find Usages but contributes no focused-preview facet. Event attributes, inline
or declared external scripts, templates, direct-string `AddEventListener`, and direct-string `load`
belong to the mounted RML document and remain analyzable independently of that flag.

Graph derivation tolerates structurally admitted but semantically invalid record fragments. Safely
readable `$ref`, `$var`, flow, Room placement, and Room exit relationships remain available, while
owner-local failures such as invalid Room placement selections, Dialogue block targets, and Scene
step targets become graph diagnostics instead of suppressing unrelated graph content. Map topology
is derived from authoritative Room/Exit references and validated by the Map schema rather than by
retired authored source/target Location fields.

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

`editor/src/shared/project-schema/authoring-graph-field-metadata-review.ts` derives the complete
authoring field-path set from `authoringProjectSchema` and assigns every leaf an explicit intrinsic
graph effect. Build-time generation emits the checked runtime table; `authoring-graph-field-metadata.ts`
queries it through lazy root/depth indexes rather than walking schemas at startup. A per-schema-root fingerprint is pinned in source. Adding, removing, or reshaping an
authoring field therefore fails the graph metadata audit until its effect is reviewed and the
fingerprint is deliberately updated. There is no implicit graph-stable default for new schema
fields.

The generated classifier supports concrete wildcard matching and conservative structural fallback
for known parent paths. Workspace edit batches share one semantic/localization/graph classification
through `project-workspace/workspace-edit-effects.ts`; source authority and conservative graph closure
remain workspace-owned. See [incremental validation contracts](VALIDATION_INCREMENTAL_AUDIT.md). `assertGraphInputRegistryComplete()` compares fresh full construction,
contribution-set assembly, and incremental contribution replacement for representative mutations.
It also proves declared `none` fields leave graph output unchanged.

## Authoritative mutation publication

The project store admits candidates through the tolerant structural decoder before publication. A
successfully admitted working document has a stable `projectInstanceId`, a monotonic
`projectRevision`, and a frozen `StructurallyAdmittedAuthoringProject` projection. Each accepted
content change publishes one atomic `ProjectMutationPublication` containing the exact immutable
previous/current admitted projects and a canonical affected-path change set. Structurally rejected
candidates do not change the document, history cursor, revision, or last publication.

Ordinary commands, visible transaction steps, transaction cancellation, persistence rollback,
Undo, and Redo identify their publication kind and narrow affected paths. Transaction commit only
finalizes already published steps and therefore does not create a second content revision. Save
baseline refresh, project path changes, saving state, and `/editor` metadata persistence are
metadata-only and do not advance `projectRevision`.

`editor/src/shared/authoring-graph-input-classifier.ts` classifies those canonical paths without a
fresh graph build or contribution-set diff. Explicit `none` fields are graph-stable; exact source,
symbol, owner, and structural effects select indexed owner work; missing attribution and ambiguous
root changes fail safe to full rebuild. Layout declaration resolution uses the distinct
`source-resolution-asset` reverse dependency for Asset path/kind/extension changes, while reached
source read/hash changes use `source-asset`.

## Incremental graph runtime

An existing semantic binding can change without adding or removing a record. In particular,
renaming a named localization Message key or a Project cursor ID can resolve a previously missing
source reference. Such references have no prior dependency edge to traverse, so resident admission
widens semantic derivation when these lookup identities change, even with unchanged registry
cardinality. Ordinary edits to the target content continue to use bounded dependency invalidation.

`authoring-dependency-graph-runtime.ts` subscribes to authoritative mutation publications and
publishes revision-matched immutable graph snapshots. Persistent content-analysis artifacts are
cached by project instance and exact logical source identity; semantic owner projection is cached
separately so symbol-table changes can reproject affected owners without rereading or relexing
unchanged bytes. Source reads are bounded across inline text and cache hits before new IPC work is
issued. Physical source artifacts are deduplicated while retaining distinct owner provenance. The same
source-analysis artifact also records direct managed Lua `Text.tr`/`Text.msg` occurrences separately
from generic string literals. Named `Text.msg` calls project exact `localization-text` edges to the
resolved Message/locale records, while their key literals are excluded from ambiguous lexical-reference
evidence; local `Text.tr` occurrences remain first-class analysis data for localization status/sync
without inventing durable free-form identity in the dependency graph.

Overlapping asynchronous mutations accumulate old/new path impact and indexed owner work until one
current snapshot can be published. Stale reads, source analysis, owner projection, and whole-build
results are discarded. Every incremental result is compared by contract to the same canonical graph
that a fresh pure build would produce. Missing reverse attribution emits a development diagnostic and
uses an explicit full-build fallback instead of publishing a partial graph.

## Current consumers

`buildReferenceIndex()` and `findUsages()` are compatibility projections over confirmed
`reference-integrity` graph edges. Shared compiler linking and project search use the same structural
graph projection; they do not run a second whole-project reference scan. Their public result shapes
and ordering remain compatible with the pre-graph contracts.

Renderer consumers obtain the current revision through
`authoring-dependency-graph-runtime.ts`. Variable and Asset usage views project their confirmed
references from that snapshot rather than rebuilding a graph during render. Semantic usage queries
also expose role labels, precise nested-target labels, Lua source locations, and stable grouping for
ambiguous lexical occurrences.

Workspace-backed Project Search adds materialized Layout RML/RCSS/Lua and Script Module Lua files as
ordinary source subdocuments using the same canonical `project:/` identities. This keeps editor
search and future headless consumers on one search implementation instead of introducing a second
grep/index path.

Rename, ordinary delete, Force Delete, Room-placement deletion, and delete-and-repair are
revision-gated at command dispatch. A missing, updating, stale, or wrong-project snapshot fails
closed. Possible Lua references produce warnings without blocking. Exact inline RML/RCSS cursor-name
occurrences are rewriteable through their verified UTF-16 ranges; Asset-backed RCSS/RML cursor-name
occurrences are exact-manual because the referenced Asset source is not owned by the project-document
patch transaction, so rename requires explicit confirmation and ordinary deletion blocks rather than
silently missing the reference. Explicit Lua fallback references likewise require explicit
confirmation for rename-without-source-rewrite and block ordinary deletion; Force Delete remains a
separate explicit path. Ordinary deletion presents its planned repairs and warnings
in the Project Explorer. That dialog is driven by the complete semantic repair-edge closure, including
Lua-only evidence and Room-placement descendants; the compatibility reference-index projection is
not an admission or visibility gate. Required references must have a valid user-selected replacement
before confirmation. Character and Interactable Location is independent of Room placement identity:
removing a placement or a Room placement descendant never synthesizes a Location change. Only actual
presentation or Interaction-context references to that placement are repaired or blocked.

The graph-backed repair registry converts confirmed repair descriptors into a previewable repair
plan. It covers nullable references, nested-record removal, shared-parent array-item removal,
replacement-required relationships, Room-placement presentation/context references, editor metadata
cleanup, and ID remaps. The confirmation command revalidates both project and graph revisions; a stale plan is
rejected and the UI derives a new plan from the current publication. Applying a plan is one command
transaction and one structural persistence unit; shared arrays are edited in descending index order,
partial repair is rejected, and Undo, Redo, cancellation, persistence rollback, and recovery overlays
observe the same atomic publication boundary. Possible Lua evidence remains warning-only and explicit
Lua fallbacks remain blocked rather than being rewritten. Replacement patches are emitted only by a
role-specific repair descriptor whose path and value encoding are known. A generic reference role
without an explicit safe encoding is `blocked`; it must never guess a `$ref`, string, flow-target, or
other authoring value shape.

Recognized exact source references participate in the same revision-gated preflight. Rename rewrites
only `exact-rewriteable` source ranges and structured references; it verifies the expected source text
again before emitting patches. `exact-manual` source references require explicit
rename-without-rewrite confirmation and ordinary-delete protection. `possible-lexical` references are
surfaced with canonical file/line evidence but are never rewritten or treated as exact ownership.
