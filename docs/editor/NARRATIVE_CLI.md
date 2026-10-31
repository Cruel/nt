# Standalone narrative validation

`noveltea [--json] narrative validate <catalog-root>` validates canonical Story
Markdown without a Project, engine compilation, runtime artifacts, daemon, Node,
network access, or installation-relative schema files. Supply the dedicated Story
directory (for example `game/story`), **not** the game directory. Recursive discovery
reads regular `.md` files only, in sorted root-relative path order; directory and
file symlinks are not followed. No catalog or user-configuration files are written.
Global `--project` and additional command arguments are usage errors.

Exit codes are `0` for structurally valid input, `1` for catalog diagnostics
(including root I/O failures), and `2` for usage errors. A structural pass does not
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
Use `narrative readiness` for status-scoped staged minimums and planning obligations.
Git-baseline protected-decision comparison and deterministic impact are follow-up
#535; this command accepts neither `--base` nor permission acknowledgements.
Narrative Events and predicates are not engine Scene Events or gameplay Conditions.
No engine linkage, project schema, compiler or runtime behavior is changed.

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

For example:

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
as `readiness.focus`.

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

Requested `readiness.clusters` select each target Milestone plus bounded
declarative Event prerequisites, references, linked Authored Content and
related Puzzle dependencies. Typed prerequisite and branch conditions also select
Events declaring effects on the same state slots, recursively within the same bounds.
This conservative dependency selection includes potential state writers, not just
initial Fact/Relationship declarations; unmodeled prose effects remain unverified.
Cluster selection deliberately excludes arbitrary
future Arc siblings; it exposes sorted `recordIds`, the selected stage
minimum, findings and `bounded` parameters (at most 128 records and 6
reference hops). Truncation is `unverified`, never `passed`. A later
unfinished Milestone can block whole-Story interactive readiness without
invalidating an earlier independent cluster; changing the earlier Milestone's
own fulfillment requirement invalidates its handoff.

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
At most 16 explicitly resolved IDs may be supplied per request. Both commands
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

Selection always includes explicitly requested records and the positioned
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
