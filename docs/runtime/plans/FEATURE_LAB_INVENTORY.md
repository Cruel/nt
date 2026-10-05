# Feature Lab capability inventory

Delivery authority for #249 (parent #234), against repository `856cf6310b69464444b20f1363c39b30bedb02e1`, 2026-10-02.
Prerequisite #248 is closed: the owner completed #247 and the reconciliation reports no blocking pilot findings.

## Scope and lifetime

This is the **one-time population plan**, not a second coverage ledger. It specifies the final
scenario/check topology for #250–#258. It does not claim those checks are implemented or tested.
The registered [catalog](../../../tests/projects/feature-lab/assets/data/feature-lab.json) remains
sole authority for **implemented** content, status, instructions, timestamps, asset realizations,
and authored-Test links. Its three existing stations remain usable unchanged during population.

On implementing a station, transfer its remaining rows into catalog checks, validate the Project,
and **remove those rows from this plan**, leaving only a scenario-ID/catalog pointer. Never maintain
parallel status, timestamps, pass/fail history, or test links here. Transfer new asset requirements
only when used; remove their planning rows once all consumers have moved. At #259 certification,
archive the exhausted plan as implementation history and remove active routing links. Generate any
ongoing coverage report from the catalog and authored Tests, not from this document.

The current validator requires a real Room launch for every scenario. Do not create fake home
launches or mark an unbuilt station ready to make inventory rows fit that contract. Population
creates real launch paths. Missing media may permit technically adequate provisional content;
missing scenario implementation is not media provisionality. No catalog/schema change is needed
for this inventory ticket.

### Classification and granularity

- Every row in **Stations** is **Feature-Lab-applicable**: its action/result is the concrete reason
  it has a meaningful playable manifestation. IDs are `scenario-id/check-id`; check IDs are local
  to their scenario, as in the existing validator. These are the final population IDs.
- **Automation-only** below classifies candidates with no useful in-Project manual manifestation,
  including editor-only and build-only surfaces. This classification does not claim existing tests
  exhaustively cover them.
- Owner-deferred Map coverage is explicitly accounted for under **Deferred coverage**, not automation-only
  or ready coverage. Unsupported/deferred roadmap surfaces are excluded at the end.
- A row covers one distinct contract/path, sometimes using a small A/B sample for related variants.
  Do not multiply it by every owner × type × platform × input × locale × transition permutation.
  Host-specific paths (Scene Text versus Dialogue, alpha versus custom Hotspots, retained versus
  deferred save) remain separate. Exhaustive scalar/operator/codec permutations stay automated.
- `S`, `U`, `V`, `A`, `M` mean primary semantic, UI, visual, audio, and manual verification respectively.
  They become the existing catalog verification values; they are **not** promises of new automation.
  Prefer a shared authored flow Test and selected real UI inputs per station. Assert actual state,
  not Lab-only pass flags. Reserve readback for composition/pixels that are themselves the contract.
- Asset keys in the final column refer to **Asset requirements** below. `—` needs only normal authored
  records, text, source files, and built-in UI/fonts. An asset shared by many rows is not duplicated.
- Each station is a short workflow with ordinary Rooms, Scenes, Dialogues, Interactions, and Layouts.
  Lua is used for APIs genuinely under test or exceptional setup, not a generic capability dispatcher.
  Related checks execute inside one session; switching/restarting stations uses fresh-session launch.

## Discovery boundary and evidence

The sweep includes all current authoring families and their runtime projections: Project settings,
Rooms, Characters, Interactable Definitions/Instances, Archetypes, Features, Inventories, Traits,
Properties, Conditions, Gameplay Commands, Verbs, Interactions, Scenes, Dialogues, Maps, Layouts,
Materials, Assets, Script Modules, Messages/localized resources, authored Tests, saves, player shell,
input/display, and host-specific runtime behavior. Editor-only metadata is accounted for separately.

The source set is the current [engine overview](../../engine/OVERVIEW.md) and its component documents,
[Lua API](../LUA_RUNTIME.md), [state/playback](../STATE_AND_PLAYBACK.md),
[UI components](../../ui/RMLUI_CUSTOM_COMPONENTS.md),
[Layout contract](../../engine/LAYOUT.md), [assets](../../assets/OVERVIEW.md),
[text implementation](../../rendering/TEXT_IMPLEMENTATION.md),
[reference presentation](../../rendering/REFERENCE_RESOLUTION_AND_PRESENTATION_SPEC.md), and
[localization certification](../../architecture/certifications/FIRST_CLASS_LOCALIZATION_ALIGNMENT_CERTIFICATION.md).

Code cross-checks, rather than old migration names, bound the inventory:

- `editor/src/shared/project-schema/authoring-scenes.ts`: Event, Stage, structural transaction,
  and terminal unions; `authoring-project-settings.ts`: display, scale, cursor and shell settings;
  `authoring-localization.ts`: Message patterns and locale policy.
- `editor/src/shared/project-schema/authoring-layouts.ts`: current State Shapes are scalar/array/object,
  not every shape mentioned in broader domain vocabulary. `engine/include/noveltea/script/runtime_script_api.hpp`
  and `engine/src/script/lua/bind_runtime_capabilities.cpp` distinguish callable APIs from backend-only
  presentation operations.
- `engine/include/noveltea/core/rich_text.hpp` and `engine/src/core/rich_text.cpp`: supported styles,
  effects, paging and object spans; `tests/runtime/runtime_world_tests.cpp`: exact identities,
  quantity operations, configuration changes and rejection contracts.
- `engine/src/platform/sdl/sdl_cursor_realizer.cpp`, `web/player_pre.js`, `web/shell.html`, and
  `engine/src/platform/sdl/sdl_platform.cpp`: native cursor fallback, browser storage and
  retained-canvas input/resize boundaries.
- The actual Lab catalog, README, four authored Tests, HUD Lua, and `tools/feature-lab/validate.mjs`
  establish what exists today; declarations elsewhere are not evidence of Lab coverage.

The older runtime migration disposition is only a discovery aid. In particular, its old separate
Property persistence families, definition-summary APIs, and direct shader terminology are not the
current contract. Current Properties all save; gameplay references retain identity; Materials own
shader source; runtime video is not supported. Likewise, an authored Asset kind does not imply a
runtime playback backend.

## Stations

### World & Interaction — #250

Transferred to the authoritative Feature Lab catalog in `tests/projects/feature-lab/assets/data/feature-lab.json`.
The implemented stations are `rooms-interactions`, `room-lifecycle`, and `world-composition`. Checks
whose complete inventory behavior lacks a normal authored invocation path remain explicitly `blocked`
in the catalog: `no-room-boundary`, `transition-selection`, `occurrences-and-location`,
`placement-resolution`, and `camera-views`. The catalog records those limitations instead of narrowing
or claiming coverage that the authored station cannot exercise.

### People & Conversation — #251

Transferred to the authoritative Feature Lab catalog in `tests/projects/feature-lab/assets/data/feature-lab.json`.
The existing seven-check `dialogue-presentation` pilot remains the shared Voice/SFX/camera-emphasis
witness. The implemented expansion adds `conversation-paths`, `character-studio`, and `active-text`,
covering the inventory's Dialogue policy/flow, Character presentation/animation, and ActiveText
contracts through ordinary authored records and authored semantic/UI Tests where those are the right
verification layer.

`media-slot-content` remains explicitly `blocked`: the runtime publishes Dialogue Media Slot state,
but the built-in Dialogue UI has no normal image/Character-snapshot realizer yet, so the catalog keeps
the intended contract without substituting a world actor. Cooperative Dialogue Handoff/Scene
`ResumeDialogue` remains intentionally shared with #254's `dialogue-handoff` check rather than being
duplicated here. Automatic Room-description diff generation remains automation-only as classified
below; `active-text/diff-style` covers the supported explicitly authored diff markup.

### Objects & State — #252

Transferred to the Feature Lab catalog on 2026-10-02:

- `inventory-workbench`
- `properties-and-traits`
- `runtime-workshop`

The catalog is now authoritative for these checks. `inventory-workbench/inventory-presentation` records the remaining Project-default-versus-built-in-fallback Layout limitation, `inventory-workbench/containment-context` records the authored-Test limitation around expected cyclic-containment error diagnostics, `properties-and-traits/owner-local-values` records the runtime's current inability to overlap one Property ID between Global and identity-local namespaces, and `properties-and-traits/trait-capabilities` records the remaining runtime-added Trait selector/Condition authority gaps. Interactable hotspot-mode comparison remains intentionally shared with #255 `hotspots-and-cursors/alpha-versus-custom`, and Map projection/navigation for `runtime-workshop/retarget-exit` remains owner-deferred by #252.

### Commands & Discovery — #253

Transferred to the Feature Lab catalog on 2026-10-03:

- `verbs-and-offers`
- `interaction-rules`

The catalog is now authoritative for these checks. The `verbs-and-offers-*-ui` witnesses isolate
Primary activation, the real built-in Verb Menu, ambiguous Primary choice, and Command Builder
submit/Rebind/Cancel in fresh UI runtimes, while `verbs-and-offers-flow` keeps
complete-command authority at the semantic command seam. Direct `run-interaction` success is not
an Offer-discovery assertion; presentation witnesses use semantic Verb/slot IDs rather than positional
menu selectors (see the public Agent Kit Layout technical reference).
`interaction-rules-flow` covers the green selector, Guard-tier, and fallback paths. Same-tier
priority and equal-winner ambiguity are intentionally shared with the focused native resolver tests
in `tests/script/typed_interaction_execution_tests.cpp`; duplicating the ambiguous resolver shape in
the canonical Lab would intentionally make authoring validation non-clean. The station keeps
immediate-atomicity rejection and observable-boundary failure as deliberate manual semantic controls
because authored Test playback correctly treats their real runtime error diagnostics as failures
rather than allowing expected-error assertions to suppress them. Canonical Lab configurations must
remain validation/diagnostic clean: statically disjoint, permanently dominated, and unconditional
equal-tier/equal-priority rules belong in focused validation/native negative tests. Runtime-dependent
ambiguity also belongs at an executable negative seam when it emits error diagnostics; analyzer
uncertainty is not a reason to weaken diagnostics. Manual coverage is retained only for the stated
authored-Test expected-error limitation, complementary to native failure-path coverage.

### Stories & Scripting — #254

Transferred to the Feature Lab catalog on 2026-10-03:

- `scene-director`
- `background-stories`
- `script-and-data`

The catalog is now authoritative for all 20 #254 checks. `scene-director-flow` protects the green
staging, Scene Choice, nested-call, Dialogue Handoff/ResumeDialogue, gameplay transaction, directed
Room-change, and navigation path. Deliberate terminal variants, exact Layout-signal lifetime negatives,
and fast-forward barrier detail remain manual/shared with focused native execution coverage where an
authored smoke path would either be destructive or duplicate lower-level cursor/lifetime matrices.

`background-stories-flow` proves independent detached progress plus flow/active-Room/session owner
cleanup. The deliberate detached runtime fault remains a manual control because authored Test playback
correctly treats the real runtime diagnostic as test failure; deterministic native failure-path coverage
supplies the negative automation.

`script-and-data-flow` protects module/On Game Ready reconstruction, exact-versus-catchall hook
selection, synchronous/yielding Lua use, structured `Data.load`, save/load random replay, and rejected
random ranges that do not consume a draw. Bootstrap also registers the public qualified-prefix hook
form; longest-prefix competition remains intentionally shared with the native Hook Registry resolver
because authoring entity IDs do not admit dotted qualified targets. Wall-clock assertions remain native
with an injected fixed clock rather than real-time sleeps. Restart startup-context and host-owned
preference persistence remain manual/host-integration coverage, while the station itself exercises a
copied nested typed context and fresh Project defaults. The `structured-data` asset requirement is
realized by `notice-board-data` in the catalog and shared with #255's Layout examples; its procurement
row is retired.

### Layouts & Interfaces — #255

Transferred to the authoritative Feature Lab catalog on 2026-10-04:

- `layout-counter`
- `menus-and-input`
- `hotspots-and-cursors`

The catalog retains every non-Map inventory check and adds explicit shared Trigger Context,
scale-policy, and supported-custom-element checks. `layout-counter-flow` protects owner cleanup and
named-Room projection; the three station UI smoke Tests use the real catalog category/launch controls
and realize the authored resources. Stateful custom-Mount interaction remains manual/shared with
focused native Slot, contract, reconstruction and parentage tests: current custom-document IDs contain
realization counters, and authored state expectations cannot select among multiple scope Slots for one
Layout. Shell commands are not implemented by the headless UI runner, so shell-role/stack checks remain
manual plus native shell/action-gateway coverage, not falsely passing UI clicks. The deliberate invalid
input update is opt-in because ordered mutation errors correctly fail authored playback.

ActiveText and Inventory behavior remain intentionally shared with their existing stations; broader
localization/display/save workflows remain #257-owned. No Map records, focus targets or media are added.

### Sound & Presentation — #256

Transferred to the authoritative Feature Lab catalog:

- `materials-engine2d` (preserving the three original check IDs and history)
- `presentation-effects`
- `sound-desk`

The catalog owns implemented/shared coverage, explicit integration gaps and pending perceptual
acceptance. See the Project README for authoring/verification procedures; do not duplicate statuses
or Test links here.

### Language, Display & Persistence — #257

Transferred to the authoritative Feature Lab catalog:

- `localized-story`
- `display-and-accessibility`
- `save-and-resume`

The catalog owns every assigned check, intentional sharing, language-review provisionality and the
remaining blocked localized-audio procurement/listening workflow. The Project README documents the
semantic checkpoint and UI Slot round-trip witnesses and actual-player requirements. No headless
launch witness claims shell preference, HiDPI, perceptual or localized-media acceptance.

### Edge Cases, Host Behavior & Stress — #258

Transferred to the authoritative Feature Lab catalog:

- `runtime-diagnostics`
- `host-behavior`
- `stress-content`

The catalog owns every assigned check and intentional sharing. See the Project README for opt-in
failure controls, generated workload provenance, actual-host prerequisites and verification limits.
Real error-emitting branches remain manual/native negatives rather than falsely passing authored
Tests. No corrupt Project/parser/compiler fixtures or owner-deferred Maps were added.

## Deferred coverage

**Maps — owner-deferred from this Feature Lab expansion.** The owner considers current Map
implementation too immature for useful Lab acceptance/reference checks. This is an explicit scope
deferral, not a claim that Maps lack a manual manifestation, are automation-only, or are covered.

Do not implement the proposed `map-navigation` station (topology projection, visibility/actionability,
polygon picking, independent minimap/full-map state or explicit Map-state persistence). Also defer
Map-specific Lua/Layout activation, semantic focus targets, exit-retarget projection, platform cases,
large-Map stress and Map-specific assets. No surrogate Lab controls or placeholder checks are needed.
Existing engine/Map tests and implementation are unchanged; this decision does not delete them or
request new Map automation.

#252 retains ordinary Room exit retargeting; #255 retains non-Map Layout/UI/custom-element work;
#258 retains non-Map subject/input stress. #259 must report Map coverage as owner-deferred and must
not block certification on it. Ordinary Room exits, navigation and lifecycle remain in scope.
Revisit Map Lab coverage only after the owner explicitly reopens it when the implementation is mature
enough for meaningful checks; reassess topology/IDs/assets then rather than freezing unbuilt checks.

## Automation-only candidates

Each row is explicitly **automation-only**. A representative observable consequence may already be
assigned above; this section excludes the internal or tooling mechanism, not that consequence.
Use existing suite boundaries, never invent a native-test stable-ID registry for the inventory.

| Candidate family | Concrete exclusion reason and natural verification boundary |
| --- | --- |
| Workspace/schema versions, parsing, strict unions, stale references, malformed Project/compiled/save/package data | Invalid content cannot be a canonical playable station. Validate/compiler/decoder and malformed-fixture suites own rejection, including historical-shape rejection. |
| Editor entity creation/rename/delete, undo/redo, graph/timeline/Hotspot Focus editing, previews, Problems, localization review/exchange, import/reimport and ComfyUI | Editor-only workflows are not observable through an authored runtime Project; use editor service/component/browser tests. Runtime results of their valid content are assigned above. |
| App identity, icon/launch asset generation, signing, templates, export profile resolution, asset pruning/compression/transcode, deterministic package/archive and Project round trips | Build/installation artifacts and tooling transactions require package/export/CLI certification, not gameplay UI. Reuse Lab as input without adding an in-game packaging station. |
| Authored Test schema, typed expectation operators, recorder begin/end/undo/replay, semantic/UI driver discrimination and report counts | Acceptance infrastructure is not a gameplay feature to imitate. Test/playback integration exercises the real runtime seam; Lab Tests refer to check consequences. |
| Lab catalog references/timestamps/search/Recent/status derivation and fresh launch dispatcher | Existing Feature Lab validator, contract Tests and owner usability checkpoint are framework coverage; do not list the navigator as a game capability station. General Data/time/restart APIs have explicit checks above. |
| Full scalar/type/operator/matcher combinations, selector containment proofs and malformed named bindings | Exhaustive combinatorics do not add a distinct manual workflow. Core/schema/semantic tests supplement representative state, Offer and resolver checks. |
| Native allocator overflow, ID remapping, stale operation/occurrence tokens, command budgets and reentrancy | Exact boundary values/order/forged tokens are not naturally authored player actions. Runtime/world/Flow/host integration tests prove them; observable stale identity and cancellation remain in Lab. |
| Save byte canonicalization/Save Contract mismatch, write failure/retry and failure-atomic candidate hydration | Corrupt saves and injected storage/realizer failures need isolated stores/load tests. Lab covers valid resume and actual host persistence without shipping broken saves. |
| Lua certification, missing exports, frozen Hook Registry collisions, bootstrap authority, sandbox escape and cyclic/nonpersistable cross-VM values | These are admission/security negatives or internal lifecycle invariants. Script/runtime tests inject them without making a normal Project unlaunchable. Runtime fault/pure-context behavior remains applicable above. |
| Wall-clock DST/range/overflow/format rejection and frozen timezone provider behavior | Host-time variation is not a portable manual expected result. Clock binding tests inject epoch/timezone; Lab demonstrates wall/gameplay separation. |
| JSON parser limits, malformed numeric/UTF-8/JSON data and internal parsed cache identity | Parser/resource tests are the lowest seam; no corrupt data Asset needed. Independent loaded-tree/null semantics remain a playable API check. |
| Request coalescing, worker/finalizer scheduling, cancellation races, reservations/LRU, leases, generation isolation and focused/runtime publication swaps | Internal concurrency/accounting invariants lack a truthful ordinary gameplay UI. Asset/publication tests plus profiler inspection cover them; loading under stress is applicable. |
| Automatic Flow Prediction Index, speculative ranking/horizon/provenance, authored supplemental prefetch hints and Warm budgets | Hints are author-facing optimization intent but have no guaranteed player-visible result. Compiler/predictor/residency tests and editor profiler verify contribution; never add a fake “prefetched” gameplay flag. |
| Native GPU handles, shader reflection/fingerprints/ABI certification, backend binary variants, material interface rejection and asset cache identity | Compiler/binder/readback tests own these internal contracts. All six supported Material roles and visible application/texture/alpha behavior are in stations. |
| Core-only Camera Pan/Focus operations, runtime selection of named Views, automatic `diff_room_description`, and native save-store delete | These implemented lower-level primitives have no current ordinary Scene/Lua/shell authoring route (`authoring-scenes.ts`, `runtime_script_api.hpp`, `bind_runtime_capabilities.cpp`, UI action gateway). Keep core/render/store tests; do not add privileged Lab hooks. Room default Views/Anchors, Dialogue emphasis and explicit diff markup remain applicable. |
| Rich-text parser recovery, every easing alias/equation, atlas packing, glyph-ID registry and font-coverage diagnostics | Exact parser/numeric/resource correctness belongs in core/text tests. ActiveText representative styles/effects, multilingual shaping and real font fallback remain applicable. Internal `test` effect is not a reference showcase. |
| Capped versus native world raster policy; Project reference resolution, disabled scale policy and entrypoint variants requiring Project-wide reconfiguration | One canonical Project cannot switch immutable compile settings per station using ordinary runtime APIs. Use temporary Project variants in display/compile/player tests; the Lab still covers resize and admitted live scale changes. |
| Forced device loss, unavailable audio/font/image backends, cursor API rejection and failed localized-asset publication | Deterministic faults require injected adapters or damaged packages; adapter/host tests own atomic fallback. Real host restrictions and their diagnostics remain manual host checks when encountered. |
| CLDR rule conformance, translation freshness/parent-cycle errors, detached catalog residency and locale-generation races | Combinatorial language/tooling/cache contracts need compiler/MessageRealizer/locale tests. Representative grammar, negotiation, cue remapping and live media switches remain in Lab. |
| Image/audio format decoder permutations, malformed streams, mip generation and export-only SVG/transcode handling | Byte-format admission is an asset/decoder/export contract, not a new gameplay station per extension. Use the minimal image/audio sources above to exercise runtime consumers; add media only when decoded properties select a materially different path. |
| Opaque binary/text/video Asset packaging without an admitted runtime consumer | Exporting bytes does not create an interactive feature. Asset/package tests prove retention/resolution; JSON data, RML/RCSS, images/fonts/audio have real consumers above. |
| CMake/platform ABI, dependency/no-exceptions/no-RTTI policies, sanitizers, coverage reports, Web threading/worker flags and devtools-off symbol stripping | Build/runtime admission and tooling contracts are verified by policy/build/artifact tests, not authored gameplay. No per-build-mode copies of ordinary Lab checks. |

## Asset requirements before curation

The matrix is an **incremental procurement plan**, not a second Asset database. Existing requirement
IDs/realizations live only in the catalog. Keys below are shorthand for transferring requirements;
scenario asset closure will continue to derive from its check references. Reuse media across all
stations. Source code (Lua, shader files, RML/RCSS) is not a request for new media Assets.

| Key | Minimal requirement / distinct path | Reuse or acquisition decision |
| --- | --- | --- |
| `backdrop` | One opaque landmark-rich Room background | Reuse catalog `pilot-room-backdrop`; no new per-Room backgrounds. |
| `button` | One transparent silhouette with inspectable alpha and world/Inventory utility | Reuse `pilot-button-sprite` for Instances, Props, overlap, placement and alpha Hotspots. |
| `character-pair` | Baseline and visibly different expression for the same Character | Reuse `pilot-character-neutral` and `pilot-character-smile`; Profile changes alone do not justify another person. |
| `sfx` | Short distinguishable causal/disposable cue, also usable as a deliberately synthetic Ambience loop | Reuse `pilot-dialogue-sfx`; perceived natural ambience quality is not the contract. |
| `voice` | Short intelligible speech with silence after it for completion/duck checks | Reuse `pilot-dialogue-voice`; do not re-curate the working reference line. |
| `music` | A loop long enough to hear replacement/fade/pause/duck without immediate natural end | Reuse existing `music-loop` Asset record and `assets/audio/music_loop.mp3`; verify loop suitability before ready perceptual acceptance. No second track unless replacement cannot be distinguished by gain/pan/owner. |
| `pattern` | Small synthetic opaque/alpha regions, thin lines, repeated edges, orientation labels and two visibly different texture regions | Reuse catalog `ui-pattern`, introduced by #255, for remaining fitting/camera/Material consumers at different crops/transforms; add a second texture only for replacement distinction. |
| `character-layers` | Minimal synthetic transparent base/overlay and visibly distinct blink/speaking/Gesture frames for two Profiles | Reuse base Character art when feasible; generate simple overlay frames. Required to prove sparse multi-layer composition and finite animation, not a demand for a full curated sprite set. Mark aesthetic claims provisional until deliberately reviewed. |
| `font-set` | License-cleared regular plus real bold/italic faces and a complementary CJK/RTL fallback covering chosen samples | Reuse shipped/test fonts if redistributable and sufficient; add only uncovered face/cluster paths. Real-face selection versus synthetic fallback is a meaningful A/B check; no font per language. |

Machine-checkable requirement properties should stay small (kind, alpha, dimensions where actually
validated); perceptual/linguistic quality is not inferred from file metadata. Acquisition/licensing
checks precede adding any media. Do not rename or replace existing curated files just to remove
“pilot” from internal Asset IDs. No new media is required by #249 itself.

## Pilot reconciliation and delivery

- Keep the workshop as the compact entry station; put comprehensive lifecycle/composition elsewhere
  so the successful pilot does not become a 40-step tutorial. Its real world-pointer sequence remains
  manual until a meaningful pointer/hit-test integration is added; semantic input is not that proof.
- Keep the neutral checkpoint and the seven cue/choice checks in the Dialogue station. Extend
  conversation policy and Character animation in separate coherent workflows, not by appending every
  variation to that line. Do not duplicate Voice/SFX onset checks in the sound desk.
- Keep the Material station's three distinct accepted checks, including the newer cross-family
  ordering witness. World composition expands it to cast/environment rather than repeating it.
- Preserve `created` only for these same conceptual checks; update `modified` when guidance/behavior
  meaningfully changes. New checks receive actual implementation timestamps, not this inventory date.
- Preserve the four working authored Tests. Add stable Test references only when those Tests exist;
  no invented visual checkpoint IDs or copied native suite names as coverage claims.
- #250 owns Room/world checks; #251 people/conversation/text; #252 objects/state/world creation;
  #253 discovery/resolution; #254 Scene/Flow/Lua/data; #255 Layout/input/cursor (Maps deferred);
  #256 audio/presentation/Materials; #257 localization/display/save; #258 intentional diagnostics,
  materially different hosts and stress. Shared checks have one catalog home; owning tickets coordinate
  prerequisites rather than duplicate entries. #259 certifies composition and retires this plan.

## Explicit non-candidates

Do not populate roadmap entries for Layout State Shape Map/Tuple/One Of/Any nodes beyond the current
scalar/array/object schema, runtime video/seek, Live2D, skeletal deformation/lip sync,
3D/spatial-audio simulation, animation graphs, SDF/MSDF/color-emoji rendering, dictionary hyphenation,
Arabic kashida, text editing/caret/selection, or a Lua API for the standalone boxed Text primitive.
Do not invent unsupported controller/accessibility platform integrations merely because a widget has
semantic focus targets; test the admitted input route on the actual host. General OS/IO/network Lua,
JavaScript scripting, old Item Stack/Action/Object APIs, direct authored Shader records, generic JSON
entity mutation, arbitrary render graphs and compatibility import/migration are not current features.

A future admitted capability follows normal development policy: add/update an authoritative catalog
check or justify automation-only at completion. Do not reopen this one-time plan as an evergreen
spreadsheet.
