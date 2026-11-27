# Standalone narrative validation

`noveltea [--json] narrative validate <catalog-root> [--base <commit>]` validates canonical Story
Markdown without a Project, engine compilation, runtime artifacts, daemon, Node,
network access, or installation-relative schema files. Supply the dedicated Story
directory (for example `game/story`), **not** the game directory. Recursive discovery
reads regular `.md` files only, in sorted root-relative path order; directory and
file symlinks are not followed. The root-level private `.story-inbox/` tree is
excluded before parsing, including nested `.md` files, for validation, readiness,
context manifests and Git-baseline protection. Private ideas remain available only
through their dedicated author-only channel, never ordinary Story diagnostics,
manifests, source witnesses or content. No catalog or user-configuration files are written.
Global `--project` and additional command arguments are usage errors.

Exit codes are `0` for a structurally valid catalog without pending protected-decision
changes, `1` for structural errors, invalid Git baselines, or approval-required findings,
and `2` for usage errors. Without `--base`, only structural diagnostics determine exit
status; a successful check still does not certify authorization. A structural pass does not
mean that the Story is complete, approved, editorially sound, or playable.

## JSON and diagnostics

The CLI uses the existing JSON protocol envelope: `success`, `exitCode`,
`diagnostics`, and `protocolVersion: 1`. `catalog` contains:

- `contractRevision`: the exact upstream contract commit;
- `records`: metadata-valid records, root-relative paths, and original Markdown bodies;
- `diagnostics`: structural errors, each with a stable `code`, `severity`,
  root-relative `path`, RFC 6901 `pointer`, 1-based `line`/`column`, and repair message;
- `reverseReferences`: derived typed edges with their source locations;
- `coverage`: Event, branch, Milestone-route, Puzzle-solution/clue-access and
  Narrative Position state findings, plus bounded-search status and explicit
  unverified obligations;
- `authorization.status: not-assessed`: structural validity is not evidence of
  permission to modify user-protected decisions.

Top-level diagnostics repeat the catalog errors for ordinary CLI consumers and
also include `sourceUrl` for human-mode location presentation. Root-wide failures
use `.:1:1`. Missing fields fall back to metadata start (`2:1`). Records rejected
by metadata admission are omitted; metadata-valid records with broken references
or empty prose remain visible. Do not treat records as validated canon while
there are diagnostics.

Stable diagnostic codes include `io`, `frontmatter`, `yaml`, `schema`, `body`,
`creative-direction-count`, `duplicate-id`, `broken-reference`, `chronology-cycle`,
`required-predecessor-cycle`, `contradictory-state`, `invalid-outcome`,
`invalid-position`, `impossible-prerequisite`, `impossible-fulfillment`,
`impossible-branch`, `unobtainable-puzzle-solution`, and `unobtainable-puzzle-clue`.

Coverage distinguishes `reachable`, `impossible`, `incomplete`, and `unverified`.
The native solver follows the upstream once-only, non-interleaving Event model,
separates partial chronology from enabling prerequisites, and searches complete
state (including in-Event steps) with a 4096-state budget per pass. It explores
known conditions, unknown prose assumptions, and unfinished partial Event effects
separately. Unknown prose, invalid input, unfinished execution and exhausted
search never become fabricated universal state or impossibility proofs.
Narrative Position predicates retain `guaranteed`, `conditional`, `unavailable`,
or `unverified`. Clue reachability proves only an opportunity for a linked
content Event to precede a solution, not actual player presentation or fairness.

All declared statuses participate in this structural coverage. The `minimumProgress`
field is only the declared-Milestone reachability summary, not a readiness gate.
Use `narrative readiness` for status-scoped staged minimums and planning obligations,
or add `--readiness` to `narrative validate` to return both from one analyzed catalog.
Git-baseline protected-decision comparison is opt-in via `--base`. The CLI does not
accept a permission acknowledgement as proof of human approval.
Narrative Events and predicates are not engine Scene Events or gameplay Conditions.
No engine linkage, project schema, compiler or runtime behavior is changed.

## Compact validation and readiness (`--summary`)

For a handoff, start with:

```sh
noveltea --no-daemon --json narrative validate story --base HEAD --readiness \
  --stage composition --view design --milestone milestone.warning --summary
```

`--summary` is a presentation option for `validate` (with or without `--readiness`) and
standalone `readiness`. The protocol-1 envelope keeps the same `success`, `exitCode`, and
**all** top-level diagnostics, including their locations. Instead of `catalog` or `readiness`
at the top level it returns `summary`, a projection of the same analysis. Read the process
exit status even when piping JSON to another tool (e.g. `set -o pipefail` in Bash).

- `summary.contractRevision` and `authorization` identify the contract and authorization
  assessment. Validation adds `recordCount` and `coverage`: `minimumProgress`, `search`
  (including solver truncation), `unverified`, `unverifiedBranches`, and `statusCounts`
  for `eventProgress`, `branchProgress`, `routes`, `solutions`, `clueAccess`, `narrativeState`
  (position reachability), and `predicates` (state classifications). Counts describe the
  declared evidence; an empty group does not mean the Story is complete.
- With `validate --summary`, pass `--position <narrative-position-id>` up to 16 times
  with distinct IDs to add `summary.coverage.positions`. In request order, each selected
  entry contains `id`, reachability `status`, and its full `state[]` predicate classifications.
  The counts still describe the whole Story. Unknown, malformed, or ambiguous IDs produce
  `invalid-position-id` diagnostics and exit 1; valid selections are still returned.
- With `--base`, `summary.protection` retains the baseline check and every protected decision
  finding, including before/after evidence. Its `impact` samples `changed` and `moved` and
  reports `affectedCount`, analysis bounds and unverified categories. Exit 1 with no diagnostics
  can mean approval is required. A summary does not verify consent.
- `summary.readiness.wholeStoryMinima[view][stage]` gives minima for **both** views and all
  stages. `wholeStoryFocus` describes just the selected whole-Story gate. Inspect
  `clusters[].minimum` for each requested Milestone **at the selected view and stage**;
  a scoped pass and a whole-Story gap can coexist. Only one `--view` may be supplied;
  it does not filter out the other view's whole-Story minima. `wholeStoryFocus.blockingGaps`
  and each valid cluster's `blockingGaps` include cumulative, source-located obligations;
  `outstanding` is the separate whole-Story planning queue. Retain `qualitative` uncertainty
  and each cluster's `bounded` flag. Exit 0 does not imply a passed minimum.
- Sampled lists (`blockingGaps`, `outstanding`, `unverifiedBranches`, `impact.changed`,
  `impact.moved`) have `{total, truncated, items}`. They return the first eight entries at
  most, without witness arrays. This display truncation is independent of analysis bounds.
  Diagnostics and protection findings are intentionally uncapped, even for large broken Stories.
- `summary.fullDetail` gives the drill-down: remove `--summary` and any `--position` selectors.
  Use `catalog.records`, `catalog.coverage.narrativeState[].state[]` (`predicate` and `status`),
  `catalog.protection.impact.affected[].witnesses`, and the full stage/cluster findings there.
  Human output prints the diagnostic count, protection verdict if requested, and separate
  whole-Story and Milestone minima when readiness is requested.

### Reproducing the payload comparison

`python3 tests/native_cli/narrative.py /path/to/noveltea "$PWD"` generates a Story from
`planning-stages/04-composition` with two composed Milestones and two future partial ones,
then adds 128 partial Milestones. It measures stdout bytes (including newline) from
`noveltea --no-daemon --json narrative validate <root> --readiness --stage composition
--view design --milestone milestone.warning --milestone milestone.second`, changing only
`--summary` within each pair:

| Records | Full bytes | Summary bytes |
| ---: | ---: | ---: |
| 8 | 39,327 | 3,745 |
| 136 | 669,855 | 6,943 |

At both scales the whole Story needs work and both selected clusters pass. At the larger
scale the summary explicitly truncates its planning queue. These are payload measurements,
not solver performance or a bound on diagnostics or authored string lengths.

## Git-baseline protection and change impact

Use `noveltea --json narrative validate story --base <verified-commit>` to compare the
working Story with an explicitly selected commit in the same Git worktree. The
Story may be a standalone Git repository or a directory inside a monorepo or
game Project. The command reads committed blobs directly through Git; it neither
checks out the baseline nor updates Git state or Story files. Historical Markdown
is discovered with one Git tree read and fetched with a single binary-safe
`git cat-file --batch` request rather than one Git subprocess per record. This
preserves original committed contents even when export attributes would omit or
rewrite files; missing, non-blob or malformed batch responses fail closed. Current working
files are read as they are, including staged, unstaged and untracked Markdown.
Git must be installed and the commit must resolve to a commit object. A valid
commit with no tracked Story Markdown at the selected root (including a commit
from before that root existed) is checked as an empty baseline: it has zero
historical records and protected decisions, and new Story IDs appear in
`impact.changed`. This does not establish human authorization. Absent commits,
unreadable Git objects, unsupported historical record metadata, invalid baseline
records or unsupported Git tree entries fail closed with a `baseline-invalid`
structural error. Validation without `--base` retains its ordinary standalone behavior.

The ordinary `catalog.diagnostics` array remains **structural errors only**.
`catalog.protection` has `status: checked|unavailable`, the verified `base`
commit SHA, `checkedDecisions`, `findings`, `impact` and
`authorizationVerified: false` on successful inspection. The additional
`protection.complete` flag is false if current structural errors make the
comparison incomplete; without a positive finding this yields
`authorization.status: indeterminate`, never a misleading clean verdict. Each
`protected-decision-change` finding contains a stable
`record-id#decision-id`, `severity: approval-required`, a category
(`changed`, `demoted`, `removed`, `record-deleted`, or `record-retired`),
old/new decision metadata, before/after source positions, and baseline SHA.
A structurally rejected working record is not automatically a deleted record.
The native reader retains its parsed metadata outside the admitted catalog and
checks its original identity, schema, type, status and decisions against the
baseline. If those fields are unchanged, unrelated schema errors do not fabricate
a protected-deletion finding. If the protected source is ambiguous, unreadable,
or its protected metadata cannot be attested unchanged, the validator emits the
structural error `protected-record-unverified` rather than asserting deletion
or granting permission. A genuinely absent record still yields `record-deleted`.
Rejected records never enter the typed graph; the comparison remains incomplete
and validation fails until all structural and protection checks pass.
Path moves without metadata changes are not protected-decision violations.
Record `status` and decision `authority` remain independent: a previously
protected decision stays protected in draft records; a user-approved
agent-origin decision is protected even if its origin remains `agent`.

`impact.changed` lists stable IDs whose parsed metadata or Markdown body
changed (including additions/deletions). `impact.moved` records unchanged
identities with new locations. `impact.affected` supplies conservative
linked-dependency review candidates with IDs, current or historical locations,
types, statuses and source-located `witnesses` from the same parsed typed
reference graphs as validation, including edges removed since the baseline.
This is a bounded, undirected relationship review queue, not a proof of
causality, prose consistency, creative correctness or author approval.
`impact.bounded.truncated` signals the 2048-ID limit;
`impact.unverified` lists unprovable aspects. Direct changes may have no
relationship witnesses; linked candidates have at least one.

A protected change returns exit 1 with `catalog.authorization.status:
approval-required` even if `diagnostics` is empty. These findings
**do not establish that the author did or did not authorize the change**.
The CLI deliberately has no `--allow-protected-change` bypass. Independent
human review or a separately trusted GitHub review workflow must establish
permission; the current CLI cannot certify it.

## Read-only Story planning metrics

`noveltea --json narrative metrics <catalog-root>` validates the native canonical
Story catalog and returns a read-only, `metricsVersion: 1` envelope, independent
of an engine Project, Room/Asset inventory, runtime package, daemon, Node or a
Git checkout. Unsupported fields, incompatible planning dimensions, negative
counts/durations, reversed ranges, and duplicate or undeclared route estimates
are errors. Source revision evidence includes the pinned upstream
`contractRevision`, deterministic `catalogSourceRevision`, and per-record
`sourceRevisions`. An unchanged source tree yields byte-equivalent JSON.

The `metrics.foundation` object carries Creative Direction pacing and production
budgets, reusable illustration concepts (not counts of engine Rooms), and an
`approvedFirstPlaythroughMinutes` range only when the direction is approved and
defines a target. `metrics.milestones` reports Narrative/Exploration and total
minute ranges separately; missing category estimates are `null`, never zero.
For a Milestone with one declared fulfillment alternative, a matching optional
route estimate overrides only the supplied duration categories. Milestones
with multiple alternatives retain their common/base estimates but do not
contribute to the legacy single-route aggregate. The `metrics.route` sums
Milestones only when each active Milestone has one alternative and is marked
`provisional-single-alternative`; shared fulfillment Events are deduplicated
when the bounded route analysis can establish their identity. The single-route
summary is derived from route accounting only when declared route coverage is
complete and the supported routes agree; otherwise its duration fields are
`null` rather than reverting to a naive sum. `coverage.routeTotalAvailable`
reflects the final reconciled summary. Every range is an authored planning estimate,
not proof that content is independent, the route is realizable, the player will
spend that long reading or solving Puzzles, or that production art exists.
Coverage exposes counts of missing categories, unresolved alternatives,
truncated bounded search, and availability of the approved target and aggregate.

### Route-specific estimates and Story-wide production footprint

`metrics.routes` extends the single-route summary using the same native
bounded Event/branch/typed-state progression solver as validation. Each
`structurally-reachable` route reports a stable fingerprint ID, completed Event
IDs, chosen step-branch IDs, typed Facts/Relationships/outcomes, its Milestone
fulfillment-alternative selectors, and separately estimated Narrative,
Exploration and total minutes. A route-specific `duration_minutes` overrides
only its declared categories. Event-order permutations with the same declared
content, branch choices and typed state are deduplicated; mutually exclusive
Milestone alternatives are **not** added together. A shared Event set with an
identical estimate can contribute only once per route (`accounting:
shared-deduplicated`). Overlapping but nonidentical selectors cannot be safely
apportioned and yield an unknown total (`accounting: unverified-overlap`).
The `difference` field remains the author's explanation, not another edge.
Route identity intentionally preserves branch choices and typed state even
after a shared reconvergence Event; counting Choice frequency is not a proxy
for a number of authored scenes.

`metrics.routeBounds.observedMinutes` encloses only the enumerated route
estimates (minimum of minimums, maximum of maximums), never a fabricated
average. `guaranteedMinutes` is withheld (`null`) whenever a contributing
category is missing or any route classification is ambiguous, incomplete or
truncated. `metrics.routeCoverage` reports up to 4096 search states and 128
reported route histories; its `bounded-complete` label applies only to the
*declared Story model*, not arbitrary player behavior. Optional unmodeled
playtime, prose-only conditions, unmeasured Puzzle solving, and actual runtime
branch choices always remain qualitative uncertainty. Ordinary
`narrative validate` does not pay for this optional history trace.

`metrics.contentFootprint` counts distinct **Authored Content records**
Story-wide by their typed IDs, not by their Event count or by a route's
duration. Per-route `authoredContentIds` are included once when the route
contains any Event declared by that Content record. With complete declared
coverage, Content records are labeled `shared`, `route-exclusive` or
`unassigned`; otherwise classification is `unverified`, and the complete
shared/exclusive lists are withheld.

Each `authoredContent[]` entry includes `wordCount`: the number of nonempty tokens in the raw
Markdown body, split on ASCII whitespace (space, tab, line endings, form feed, vertical tab).
This excludes YAML frontmatter but counts Markdown markers, headings, speaker labels and all
branch-local sections. `totalWordCount` sums the distinct non-superseded records, including
unassigned records. `sharedWordCount` and `routeExclusiveWordCount` sum only their respective
classifications and are `null` if classification coverage is unverified. Each witnessed route's
`wordCount` sums its distinct `authoredContentIds` once. `routeBounds.observedWordCount` reports
`{min, max}` across those routes, even if no duration estimate is available; it is `null` if no
routes were witnessed. These are pacing inputs, not measurements of reading speed or playtime.

Illustration concepts and their
meaningful variants have separate global IDs/counts; they are not physical
Assets or engine Rooms. Character `artwork_tier` counts are reported by
`main`, `supporting`, `extra`, `none`, and `unclassified`. There is no canonical
Content-to-illustration or route-to-illustration link, so per-route artwork
assignments are explicitly **unverified**. Omitted illustration concepts or
unclassified Character tiers must not be treated as confirmed zero use.

`metrics.stateDivergences` reports typed predicates with different witnessed
values across routes, including Facts and Relationships after convergence.
`metrics.budgetFindings` compares approved `first_playthrough` ranges with
each route and production counts with declared Creative Direction budgets.
Stable codes/statuses distinguish `budget-hard-violation` (error),
`budget-soft-overage` (warning), `budget-unverified`, and `duration-target-risk`/
`duration-target-overrun`/`duration-target-underrun`; source pointers identify
the relevant budget. Duration targets do not have a hard/soft field in the
canonical schema, so these are warnings, not invented hard limits. Unknown
routes are never reported as within target. Hard illustration-cap conflicts
already forbidden by the upstream planning schema remain source validation
errors; hard Character tier overages are surfaced in `budgetFindings`.
These findings diagnose planned production risk, **not** creative quality,
permissions, a verified production asset inventory, or actual elapsed playtime.

Malformed catalogs fail with exit code 1 and source-located diagnostics; they
do not return partial route estimates. Usage errors (extra arguments, `--base`,
`--project`) fail with exit code 2. This command observes the working filesystem,
including dirty or uncommitted Story files, and reports a source fingerprint;
it neither verifies human authorization nor changes Git protected-decision
status. For baseline protection use `narrative validate --base` separately.
The ordinary `narrative validate` path never computes metrics.

## Native narrative readiness and Milestone handoff

`noveltea [--json] narrative readiness <catalog-root>` computes deterministic
Story minimum requirements from the same read-only canonical catalog and
progression model as `narrative validate`. No NovelTea Project, game compilation,
SQLite, Node, Git, daemon or source mutation is necessary. Options:

- `--stage foundation|architecture|interactive|composition|review` selects the
  focus gate, default `interactive`;
- `--view design|approved` selects the focus status scope, default `design`;
- repeated `--milestone <milestone-id>` (up to 16, unique) requests bounded
  downstream implementation-handoff clusters.

For callers that need structural validation, Git protection and readiness
together, `narrative validate` accepts `--readiness` plus optional `--stage`,
`--view` and `--milestone` selectors. Its combined default is
`--stage review --view design` (the standalone readiness default remains
`--stage interactive`). The JSON envelope then includes both `catalog`
and `readiness`, computed from one canonical catalog read and full analysis;
`catalog` retains its existing shape. Readiness diagnostics participate in the
top-level exit status; duplicate catalog errors are not repeated. A protected
change still returns exit 1 without an authorization bypass.

```sh
noveltea --json narrative validate story --base <verified-commit> --readiness
```

For standalone readiness, for example:

```sh
noveltea --json narrative readiness story --stage interactive \
  --view design --milestone milestone.accept-investigation
```

The JSON envelope includes `readiness.design.stages` for
proposed/draft/approved records excluding superseded, and
`readiness.approved.stages` for approved records only. Each of the
five stages contains `minimum` (`passed`, `needs-work`, `unverified`),
`requirements`, current-stage `findings`, cumulative `blockingGaps`, and
qualitative `unverified` categories. The selected stage/view appears again
as `readiness.focus`: this is always a **whole-Story** gate, not the selected cluster.

Each finding carries stable `requirementId`, `code`, `status` (`satisfied`, `missing`,
`blocked`, `unverified`), `subjectId`, `requiredBy`, `message`,
`witnesses` and canonical `path`/`pointer`/`line`/`column`.
Puzzle requirement IDs include both the owning Puzzle and its solution Event, so
shared solutions do not collapse independent obligations. Milestone summaries preserve
unknown route evidence as `unverified` and unfinished evidence as `missing`; absence of
a proven route alone is not proof that the requirement is blocked.
The `readiness.outstanding` array separately identifies partial-record
obligations by ID, field, code, location and earliest due stage. It is derived
from current Markdown metadata, not a stored checklist or a document-count
proxy. Typical fixed finding codes include `creative-direction-required`,
`arc-milestone-binding`, `milestone-fulfillment`,
`milestone-alternative`, `event-access`, `event-branch`,
`choice-outcome`, `puzzle-solution`, `puzzle-clue-access`,
`position-continuity`, `event-authored-content` and `search-limit`.

The native minimum policy follows the upstream experimental Story catalog:

- `foundation`: one valid, completed Creative Direction;
- `architecture`: an Arc and Milestone, with each Arc affected by a
  Milestone; complete Milestones need a reachable fulfillment route, while
  explicitly partial ones can defer route binding;
- `interactive`: reachable declared Events, Milestone alternatives and
  Event branches, realized Choice Point outcomes, Puzzle clue access and
  solutions, verified classifications of Narrative Position state, and
  resolved interactive-due planning obligations;
- `composition`: each declared Event linked to completed Authored Content,
  with composition-due obligations resolved;
- `review`: always `unverified` at best; independent editorial quality,
  agreed scope and the VN presentation/production envelope cannot be
  automatically certified.

A `passed` design minimum is not approved canon. Each status scope recomputes
its own progression and detects missing cross-status dependencies. An
unrelated, admitted draft/superseded Event does not invalidate approved-canon evidence.
A file rejected during source/YAML/schema admission has no trustworthy status and
remains a readiness blocker, including for requested clusters, rather than silently
disappearing from the gate. Unresolved typed dependencies, partial records and
search-budget exhaustion never become affirmative proof.

Requested `readiness.clusters` select each target Milestone plus declarative
Event prerequisites, references, linked Authored Content and related Puzzle
dependencies. Typed prerequisite and branch conditions also select Events that
write to the same state slots, recursively; unmodeled prose effects remain
unverified. Selection excludes arbitrary future Arc siblings. A later unfinished
Milestone can block whole-Story interactive readiness without invalidating an
independent earlier cluster.

Clusters expose sorted `recordIds`, stage minima and findings. Traversal has no
hop limit (`bounded.maxDepth: 0`) but reports at most 128 records. If the record
cap is reached and dependencies are omitted, cluster minima are `unverified`.
Findings then come from the whole-Story assessment for the requested status view,
filtered to selected records and catalog-level findings (including rejected
files). A dependency omitted from `recordIds` by the cap is not itself a gap.

Structural diagnostics and invalid target IDs produce exit code 1 while
retaining available readiness evidence; CLI option errors produce 2. An
incomplete but structurally valid catalog may return exit 0 with one or more
`needs-work` gates. Callers must check the selected minimum, **not just the
process exit code**. Neither a structurally reachable Story nor a ready
cluster proves its gameplay staging, asset availability, cost, accessibility,
or engine playability. Qualitative review is independent; do not invent
production budgets, game component mappings, or authorization decisions.

## Task-scoped Context Manifest

`noveltea [--json] narrative context <catalog-root> --kind <kind>`
accepts one or more `--id <typed-id>` options and/or a
`--position <narrative-position-id>` option, plus optional
`--scope focused|related` (default: `focused`). The supported kinds are
`dialogue`, `event`, `character`, `puzzle`, `milestone`, and `review`.
Only `review` permits omitting both IDs and position. For example,
`noveltea --no-daemon --json narrative context "$PWD/story" --kind review` selects
unique admitted records from the Story root in path order (including superseded records),
with inclusion code `whole-story-review`, no graph expansion and the same 128-file cap.
Check `manifest.bounded.truncated`; to request a particular record use `--id`. Explicit
`--scope related` does not widen a whole-Story selection. All other kinds require an
ID or position. At most 32 explicit `--id` options may be supplied per request. Both commands
use the same pinned upstream contract, native Markdown parser, relationship
index and structural analysis. Neither requires a Project, Git, daemon,
compilation, network access or any source mutation.

For example, to prepare the post-trial dialogue concerning Maya:

```sh
noveltea --json narrative context story --kind dialogue \
  --id character.maya --id event.post-trial \
  --position narrative-position.post-trial --scope related
```

The `manifest.files` array contains **paths, not narrative text**. Each
entry has the stable `id`, root-relative `path`, exact source-byte
`sourceRevision` (`xxh3-128:<hex>`), declared `status` and `completeness`,
derived `dependency` (`resolved`, `incomplete` or `indeterminate`),
`priority` (`direct`, `conditional`, `supplementary`) and
`inclusions`. Each inclusion has a fixed `code` and a typed
`sourceId`/`targetId` witness, plus the canonical source `pointer` for
relationship edges. Codes include `requested-id`, `requested-position`,
`position-event`, `event-participant`, `event-state-reference`,
`chronological-predecessor`, `declared-prerequisite`,
`character-relationship`, `content-at-event`, `puzzle-clue`,
`puzzle-solution`, `milestone-realization` and `story-direction`.
These describe **declared structural links**, not an LLM judgment of
creative importance.

Targeted selection always includes explicitly requested records and the positioned
Event, then one neighborhood of typed source/reference edges. The
`related` scope permits only one additional hop from non-Arc sources,
selectively avoiding broad transitive expansion from Characters, Arcs or
chronology. `related` also supplies a supplementary Creative Direction.
Results are stably ordered by priority then path, with a 128-file ceiling.
`manifest.bounded` exposes the scope, cap and truncation. Task kind controls
which relationship backlinks are included; it does not deduce target IDs from
prose or claim that omitted records are irrelevant.

`manifest.unresolved` reports unresolved references, partial artifacts and
explicitly unverified conditions. Draft/proposed/approved/superseded status is
reported as authored; the resolver never promotes a draft to approved canon.
`coverageStatus` distinguishes structural assessment from indeterminate
coverage. Catalog structural diagnostics and unresolved/ambiguous requested
IDs produce exit code 1, returning available manifest evidence alongside
diagnostics. Invalid command syntax or options produce exit code 2.
A successful manifest is **not** permission to edit protected decisions or
proof that a branch occurs in gameplay. Upstream source changes generate a
different source fingerprint; consumers compare these with their already-loaded
versions and read all missing/changed Markdown paths in one filesystem/tool
batch. The CLI cannot inspect an agent's context and never returns prose.

## Native Story-to-Project implementation coverage (#530)

`noveltea --json narrative coverage <catalog-root> --project <project-root>`
reads the canonical Story catalog alongside the **saved** native-admitted
NovelTea Project. It does not write mapping sidecars, modify Story Markdown,
compile gameplay, execute Tests, invoke a daemon, or change either source tree.
The command accepts up to 16 optional `--test-report <suite.json>` files from
earlier `noveltea --json test run` suite invocations.

```sh
noveltea --json narrative coverage ./story --project ./game
noveltea --json narrative coverage ./story --project ./game \
  --test-report ./evidence/native-test-suite.json
```

`coverage.contractRevision` is the same pinned Story contract revision as
`narrative validate`, `context`, and `readiness`.
`coverage.requirements` is sorted by canonical Story ID, and each entry
contains the Story source path, type, authoring status and reverse-linked
`claims` from engine records. Claims retain engine collection/record identity,
the nested Scene operation, Dialogue block/segment/edge or Interaction rule
identity, relative tracked YAML source path, source pointer, and one-based
line/column. A single requirement may have many engine claims, and one engine
element may claim several requirements. A Scene operation is **not** a narrative
Event; a linked Dialogue choice edge is not proof that the branch is reachable.

`association` is `unmapped`, `draft-only` for an unapproved Story record
with claims, `claimed-unverified` for a claim of an approved record, or
`ambiguous` for non-unique Story IDs. `dangling` contains links whose Story
ID does not resolve; `duplicate` contains repeated IDs at one source element;
`ambiguous` contains links to multiply declared Story IDs. All contain
source locations. These are *report findings*, not automatic Story rewrites,
permission to override protected decisions, or hard authoring validation rules
for projects without Story catalogs. Invalid Project/Story sources or attached
report inputs produce diagnostics and exit code 1; command usage errors return 2.

The optional `coverage.routeCandidates` array contains bounded (up to 256)
structural witnesses: the same Choice Point and Event claimed on a Dialogue
choice edge, the Dialogue's explicit completion Scene and an Event-linked
Scene gameplay mutation operation. The `choiceEdge` and `sceneEffect`
entries retain exact locations and stable nested IDs. These candidates are
`declared-unverified`, with `reachabilityVerified: false` and
`stateEffectVerified: false`; an edge's presence does not establish that a
player can select it or that an effect actually executes. A truncated report
sets `routeCandidatesTruncated: true`.

Tests are **not** implementation claims. `requirements[].tests` shows
separately linked authored headless Test definitions as `not-observed`. When
an external suite JSON report lists that same Test ID and the same Project
root, its observed result appears as `externally-reported`, with the report
path, reported status and `provenanceVerified: false`. Imported report files
are untrusted: neither their authenticity nor the current executable/source
generation is certified. Even a passed Test does not establish that its asserted
state change, the requested narrative branch, or the player's perception
fulfills the Story requirement. `behaviorVerified` stays false, and the
qualitative assessment explicitly lists unverified behavior, test provenance,
state changes, and presentation feasibility. Use the actual headless Test
runner and editorial review to establish those separately.

For planning, consumers can join this report to the existing Context Manifest
(`manifest.files[].id`) and stage/Milestone readiness outputs using the
canonical typed Story ID. Coverage never changes readiness gates or narrative
approval. No Story catalog is required to compile/play an unlinked Project.

## One upstream contract, reproducible native distribution

`Cruel/noveltea-skills` owns the evolving experimental `schema: '0.1'` contract:
[`src/schema.ts`](https://github.com/Cruel/noveltea-skills/blob/688758b03f22a80635def8b385859e3a03263f4a/src/schema.ts)
and its representation/tooling documents. The checked-in
`tools/narrative/generated/contract.json` records the exact revision and source
hashes; `contract.hpp` embeds the same generated input in the host CLI. Neither is
a separately editable schema. `tools/narrative/` is the native execution adapter;
there is no engine-side narrative schema or old/current compatibility reader.
No third-party dependency is added: libfyaml and the existing JSON libraries stay
on the host tooling graph, not in players.

Refresh deliberately from a clean upstream checkout, after inspecting contract
changes and installing that checkout's pinned dependencies:

```sh
pnpm -C ../noveltea-skills install --frozen-lockfile --ignore-scripts
node scripts/generate-narrative-contract.mjs ../noveltea-skills
cmake --build --preset linux-debug --target noveltea-native-cli
ctest --test-dir build/linux-debug -R native_cli_narrative --output-on-failure
```

The exporter runs **at maintenance time only**, using upstream Zod. It exports
structural constraints and interpretable annotations for trim, uniqueness,
decision-authority implication, and complete-record relationship minima. Those
minima are probed through the upstream executable schema, not independently
listed in C++. Unknown refinements fail export. The nonserializable root
refinement is hash-gated for explicit review before repinning. State enum domains
also come from upstream. Generated inputs and canonical fixtures are committed,
so normal native builds and acceptance tests need no sibling checkout or Node.

`tests/fixtures/narrative/conformance.json` contains edits and compact expected
results generated by the pinned upstream public `readCatalog` boundary. Tests
invoke only the public **native CLI**, compare diagnostics/locations and hashes
of parsed records and coverage, and intentionally exclude witness ordering and
repair-message wording. Regenerate both schemas and fixture expectations together.
Any semantic change in upstream progression/state code requires review of the
native adapter, not just a pin update. New regressions belong in the public
fixture generator or CLI acceptance test, not private parser-helper tests.

Installed production qualification invokes the same standalone CLI acceptance
suite. Feature Lab is not applicable: this capability reads narrative authoring
files without any gameplay manifestation.
