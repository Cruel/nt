# RmlUi Data Model and Binder Refactor Implementation Plan

Date: 2026-08-08

## Status

Active implementation plan. Phases 0-7 are complete; Phase 8 is not started.

Phase 0-2 review completed 2026-08-08. The review found one Phase 1 callback-adapter defect:
malformed Save/Load slot-number arguments could be coerced by RmlUi to numeric zero before reaching
the typed gateway. Slot arguments now require an explicit numeric, finite, non-negative integral
value in the current manual-slot range, and focused integration coverage compares every model
callback with its equivalent retained Lua helper while proving malformed slot arguments dispatch no
typed shell command. No Phase 3-or-later work was pulled forward.

Review validation passes the focused UI suites (`noveltea_ui_tests`: 627 assertions/61 cases;
`noveltea_ui_backend_tests`: 1048 assertions/49 cases), full Linux build, Linux `cxx-policy`,
`format-check`, Web build, Web `cxx-policy`, and the prescribed sanitizer build plus sanitizer CTest
matrix (810/810). Full Linux CTest passes 819/827; the same eight graphics capture/dependent verifier
tests remain environment-limited by unavailable X11. Final `git diff --check` also passes.

Phase 3-5 review completed 2026-08-08. The review found no missing, incomplete, inconsistent, or
falsely marked-complete Phase 3-5 work. The phase commits form the direct chain `e2ca029c` (Phase 3)
-> `bf88f5c1` (Phase 4) -> `55d7cb57` (Phase 5), their file boundaries match the owning phases, and
no Phase 6-or-later implementation was pulled forward. The reduced `RuntimeUiDocumentBinder` and
`RuntimeUiBinder` remain in place for the explicitly deferred ActiveText/provisional-Map component
path, and no `RuntimeUiActionGateway` rename exists yet. Review validation passes
`noveltea_ui_tests` (644 assertions/61 cases), `noveltea_ui_backend_tests` (1079 assertions/48 cases),
the full Linux build, Linux `cxx-policy`, `format-check`, the full Web build, Web `cxx-policy`, and
commit/working-tree whitespace checks. Full Linux CTest passes 818/826; the same eight graphics
capture/dependent verifier tests remain environment-limited by unavailable X11, while
`noveltea_mandatory_asset_matrix` passes within the full run.

Standalone execution review completed 2026-08-08. The model name, field schema, callback names,
built-in migration boundaries, custom-component exceptions, lifecycle ordering, phase ownership, and
exit gates below are intentionally explicit so implementation agents do not need the originating
conversation. Treat those contracts as frozen unless concrete repository evidence requires a plan
amendment under the execution rules below.

This plan replaces the current direction in which system-Layout roles and native document binders
populate ordinary RML by element ID. The target is a declarative RmlUi data-model contract available
to authored runtime Layouts, with C++ custom elements retained only when ordinary RML/data binding is
insufficient.

Implementation must update the completion ledger in this file as each phase is completed. Keep this
plan under `docs/ui/plans/` while work is active. After the Definition of Done is satisfied, reconcile
the permanent UI/Layout documentation to implemented behavior and archive this plan under
`docs/archive/plans/`.

## Goal

Replace NovelTea's native DOM-population system with one stable RmlUi-facing data model so authored
RML owns normal UI structure, iteration, visibility, labels, classes, attributes, styles, and event
bindings.

The final architecture is:

```text
runtime publication / shell state / project presentation metadata
                         |
                         v
             RuntimeUI-facing projection
                         |
                         v
              RmlUi DataModel "noveltea"
                         |
            +------------+-------------+
            |                          |
            v                          v
    ordinary authored RML        specialized custom elements
    - title / status             - nt-active-text
    - choices                    - provisional nt-map-view
    - navigation
    - interactions
    - inventory
    - text log
    - settings
    - save/load
```

System Layout roles remain authoritative for mounting, lifecycle, input/pause policy, ordering,
ownership, and shell routing. They must no longer determine which ordinary element IDs receive game
or shell data.

## Decisions already made

These decisions are normative for this implementation plan.

1. RmlUi data binding is the default for ordinary state-driven runtime UI. Do not replace current
   binder slots with a proliferation of custom C++ elements.
2. Use one stable RmlUi model name, `noveltea`, in every runtime RmlUi context.
3. Built-in RML explicitly opts into the model with `data-model="noveltea"`. Project-authored
   documents/fragments may do the same wherever they want NovelTea state. Do not inject hidden
   `data-model` attributes into arbitrary authored DOM.
4. `nt-active-text` remains a real custom element. Its engine-owned shaping, playback, paging,
   direct rendering, font residency, and hit testing cannot be replaced by ordinary RmlUi data
   binding.
5. `nt-map-view` remains provisionally custom during this refactor. Map is not complete enough to
   justify redesigning its final authoring/runtime contract now. Preserve the current Map behavior
   through the smallest focused adapter needed after the generic document binder is removed.
6. Text Log moves to ordinary data-model-driven RML for now. Do not retain `nt-text-log` merely for
   compatibility. A future richer Text Log may introduce a custom component if later requirements
   actually need one.
7. Navigation is data-driven in this refactor. Do not introduce `nt-navigation` now. Future Room
   transition work may extend the model with source/target presentation state, but semantic
   transition completion must remain engine-authoritative rather than CSS-timer-authoritative.
8. Existing typed action validation remains mandatory. Data-model event callbacks and `Game.ui` /
   `Game.shell` Lua helpers must converge on the same validated native action paths rather than
   duplicating rules in RML.
9. NovelTea is unreleased and follows the single-current-contract policy. Do not preserve duplicate
   binder IDs, old custom tags, or alternate fallback contracts solely for compatibility.
10. The built-in documents must not gain new visible features merely because the data model exposes
    more state than they currently display. In particular, the current built-in Game HUD has no
    standalone Continue button, actor list, Text Log, Map, or runtime-mode label; this refactor must
    not add those controls. Dedicated data-model fixtures must exercise fields that the built-ins do
    not currently render.
11. RmlUi evaluates `{{ ... }}`, `data-if`, `data-for`, and `data-event-*` only inside a subtree with
    an active `data-model`. Creating the `noveltea` model in a context is necessary but does not
    implicitly opt arbitrary authored markup into it.
12. `refs/RmlUi/` is reference-only. The implementation may inspect its data-binding implementation
    and samples but must not modify the vendored reference snapshot.

## Execution contract and source map

This section exists so an implementation agent does not need the conversation that produced this
plan. The following current files are the principal owners and must be inspected before editing:

- `engine/src/ui/rmlui/rmlui_document_binder.{hpp,cpp}`: current ordinary gameplay DOM population;
- `engine/src/ui/rmlui/runtime_ui_binder.{hpp,cpp}`: revisioned gameplay view retention, typed action
  validation/dispatch, event capture, and `Game.ui.*`;
- `engine/src/ui/rmlui/runtime_ui.cpp`: title/shell DOM population, save-slot thumbnail virtual files,
  `Game.shell.*`, RuntimeUI lifecycle, ActiveText integration, and current binder refresh calls;
- `engine/src/ui/rmlui/rmlui_host.{hpp,cpp}`: lifecycle-context creation and destruction;
- `engine/src/ui/rmlui/rmlui_document_registry.{hpp,cpp}`: document load/reload/context recreation and
  virtual-file ownership;
- `engine/src/ui/rmlui/rmlui_custom_components.{hpp,cpp}`: ActiveText, provisional Map, and current
  Text Log custom elements/helpers;
- `cmake/NovelTeaModuleFileClassification.cmake`: explicit engine source/header classification that
  must be updated when the binder files are deleted/renamed and `runtime_ui_data_model.*` is added;
- `engine/include/noveltea/core/feature_view.hpp`: authoritative gameplay UI source view;
- `engine/include/noveltea/core/runtime_shell_contracts.hpp`: authoritative shell source view/commands;
- `engine/include/noveltea/runtime_ui_contracts.hpp`: RuntimeUI gameplay values/event/input-sink seam;
- `engine/assets/system/ui/title/default-title.rml`,
  `engine/assets/system/ui/runtime/runtime_game.rml`, and `engine/assets/system/ui/menu/*.rml`: built-in
  authored UI to cut over;
- `tests/ui/rmlui_document_binder_tests.cpp`, `tests/ui/runtime_ui_binder_tests.cpp`,
  `tests/ui/runtime_ui_lifecycle_integration_tests.cpp`, `tests/ui/rmlui_custom_components_tests.cpp`,
  and `tests/ui/title_layout_asset_tests.cpp`: existing focused regression owners; `tests/CMakeLists.txt`
  explicitly lists these tests and must track test-file additions/removals/renames.

Useful read-only RmlUi references are `refs/RmlUi/Source/Core/DataExpression.cpp`,
`refs/RmlUi/Source/Core/DataViewDefault.cpp`, `refs/RmlUi/Include/RmlUi/Core/DataModelHandle.h`, and
`refs/RmlUi/Samples/basic/data_binding/`. RmlUi callback function names are flat identifiers; dotted
state access such as `gameplay.room.available` is valid, but a callback name such as
`gameplay.navigate_room()` is not. This plan therefore specifies flat callback names below.

Implementation order is normative. Each phase must leave the repository buildable and its exit gate
satisfied before later phases rely on it. Temporary coexistence is allowed only where a phase says
so; do not add compatibility aliases that survive the phase which removes the old owner.

When an agent is asked to implement one phase, it must not opportunistically implement later phases.
It may repair an earlier phase only when concrete current-repository evidence shows the earlier exit
gate is not actually satisfied, and it must record that repair in the completion evidence. If the
repository has materially changed since this plan was written and an exact requirement can no longer
be satisfied as written, update this plan with the concrete cause before broadening scope; do not
silently substitute a different architecture.

## Current-state audit

### Ordinary gameplay DOM mutation

`RuntimeUiDocumentBinder::bind()` currently performs all of the following native DOM mutations:

- `rt_mode`: replaces inner RML with the current runtime mode.
- `rt_title`: replaces inner RML with the current Map title and toggles visibility.
- `rt_notification`: replaces inner RML with the effective output/interaction notification and
  toggles visibility.
- `rt_body`: legacy plain-text fallback when `nt-active-text` is absent.
- `rt_prompt`: creates/removes the Continue button and its `Game.ui.continue()` handler.
- `rt_options`: generates Scene or Dialogue choice buttons.
- `rt_text_panel`: toggles visibility and pointer events from text/choice state.
- `rt_actors`: generates visible Scene-actor metadata nodes.
- `rt_navigation` and `rt_nav_*`: resolves enabled Room exits, mutates button labels/exit IDs, and
  hides unavailable directions.
- `rt_objects`: generates selectable Room placement occupants.
- `rt_inventory`: generates selectable inventory items.
- `rt_actions`: generates clear-selection and available interaction actions.
- `rt_objects_group`, `rt_inventory_group`, `rt_actions_group`, `rt_interaction_dock`: toggles
  structural visibility based on generated content.
- `rt_log`: legacy generated Text Log RML fallback.
- `rt_map`: legacy generated Map RML fallback.
- `nt-active-text`, `nt-text-log`, and `nt-map-view`: pushes component snapshots when the bound
  document contains the corresponding custom tag.

All ordinary gameplay mutations above except ActiveText and the provisional Map component can be
represented with RmlUi data variables, arrays, expressions, `data-for`, `data-if`, `data-visible`,
`data-class-*`, `data-style-*`, `data-attr-*`, and data-model event callbacks.

### Shell/title DOM mutation

`RuntimeUI` currently performs additional role-specific DOM mutation outside
`RuntimeUiDocumentBinder`:

- title project label, subtitle, and Start label;
- shared shell status text across title/pause/save/load/settings/text-log/modal roles;
- settings UI/text scale current/minimum/maximum values and enabled visibility;
- checkpoint summary text;
- generated save/load slot markup, including thumbnails and Save/Load buttons;
- modal confirmation prompt.

These move to the data model. Save thumbnail byte materialization remains native resource work, but
the DOM must receive only a model-projected logical URL and author its own `<img>`.

### Existing custom components

The current custom elements are not equally justified:

- `nt-active-text`: keep. It participates in engine text layout/rendering and native hit testing.
  The current broad gameplay binder can incidentally call `set_snapshot()` on an `nt-active-text`
  placed in the `text-log` system document because that document is also passed through the gameplay
  binder. That is not a supported rendering contract: `refresh_active_text_layout()` derives the
  direct-render surface only from the active `game-hud` document. Phase 6 intentionally narrows
  ActiveText snapshot/surface ownership to the first `nt-active-text` in the active Game HUD rather
  than preserving this binder side effect.
- `nt-map-view`: keep provisionally to avoid redesigning incomplete Map behavior during this
  refactor. Its current inner-RML generation is explicitly not the final Map architecture.
- `nt-text-log`: remove from the current contract. Its current implementation is only generated RML
  wrapped in a custom tag and is better expressed with `data-for`.

### Current `RuntimeUiBinder` responsibilities that must survive

Removing document binding does **not** mean deleting all behavior currently stored in the class named
`RuntimeUiBinder`. The following responsibilities remain required:

- revisioned `RuntimeUiGameplayValues` application and stale-revision rejection;
- retention of the latest typed gameplay UI state;
- typed action validation against the current state;
- mounted-Layout gameplay-admission checks;
- typed runtime input and shell-command dispatch;
- RmlUi event capture/ordered result delivery;
- `Game.ui.*` Lua installation and validation.

The document-scanning/DOM-population responsibility is what must disappear. Phase 7 renames the
surviving class to `RuntimeUiActionGateway`; do not preserve a second `RuntimeUiBinder` compatibility
type after that rename.

### Built-in migration matrix

This matrix is normative for visible built-in behavior. It distinguishes actual shipped markup from
binder capabilities that exist only for replacement Layouts/tests.

| Built-in | Dynamic content after refactor | Built-in actions after refactor | Must not be added by this refactor |
| --- | --- | --- | --- |
| Title | `project.title`, `project.subtitle`, `project.start_label`, `shell.status` | `shell_start`, `shell_open_load`, `shell_open_settings` | New diagnostics/data panels |
| Game HUD | `gameplay.title`, `gameplay.notification`, ActiveText host, choices, Room objects, inventory, interaction actions, Room navigation | `shell_pause`, `ui_choose`, `ui_toggle_subject`, `ui_clear_selection`, `ui_invoke_interaction`, `ui_navigate_room`; ActiveText native click path remains | Runtime-mode label, standalone Continue button, actor metadata list, Text Log, Map |
| Pause | `shell.status` | `shell_resume`, `shell_open_save`, `shell_open_load`, `shell_open_text_log`, `shell_open_settings`, `shell_return_to_title`, `shell_quit` | New dynamic content |
| Settings | scale policy/value/min/default/max plus `shell.status` | `shell_set_ui_scale`, `shell_set_text_scale`, `shell_close` | New settings categories |
| Save | checkpoint summary, declarative manual slot list, thumbnails, `shell.status` | `shell_save_slot`, `shell_close` | Autosave entry |
| Load | checkpoint summary, declarative autosave/manual slot list, thumbnails, `shell.status` | `shell_load_slot`, `shell_close` | Load action for empty slots |
| Text Log | declarative `gameplay.text_log.entries`, empty state, `shell.status` | `shell_close` | New filtering/search behavior |
| Modal | confirmation prompt, `shell.status` | `shell_confirm`, `shell_cancel` | New confirmation variants |

Every full built-in document listed above must put `data-model="noveltea"` on its `<body>` when its
phase converts it. Project-authored full documents and Fragments opt in explicitly on their own
chosen subtree; assigning a system role never injects the attribute.

### Intentional contract changes

The following differences from the pre-refactor implementation are deliberate and must not be
treated as regressions during Phase 0 characterization or later review:

- clearing gameplay values clears all ordinary `gameplay.*` model state and therefore clears/hides
  declarative gameplay UI on the next RmlUi update. The old document binder could leave previously
  injected DOM stale because `bind_document()` became a no-op when no typed view was retained;
  preserving that stale-DOM side effect is explicitly forbidden;
- `set_runtime_notification()` while gameplay is unavailable leaves `gameplay.notification` empty;
  there is no model state to which a standalone output notification is attached until gameplay is
  available;
- `rt_body`, `rt_log`, and `rt_map` ordinary-ID fallbacks are removed rather than retained beside
  `nt-active-text`, data-driven Text Log, and provisional `nt-map-view`;
- `nt-text-log` is removed entirely in Phase 4;
- binder-only population IDs (`rt_mode`, `rt_prompt`, `rt_actors`, `rt_nav_*`, etc.) cease to be
  semantic engine contracts. An authored document may retain any of those IDs purely as normal
  styling/focus/test identifiers, but NovelTea no longer recognizes them for population;
- Text Log `kind` metadata becomes the readable string tokens `line`, `choice`, and `notification`
  rather than the old custom element's numeric enum value;
- the incidental ability of the broad gameplay binder to call `NtActiveTextElement::set_snapshot()`
  in the Text Log role is dropped; supported ActiveText direct-render ownership is the active Game
  HUD only, as specified in Phase 6.

All other user-visible built-in behavior is preserved unless a phase explicitly identifies another
intentional change and records it here before implementation.

## Target data-model contract

### Context ownership

RmlUi data models are context-local. NovelTea may have multiple lifecycle RmlUi contexts for
different planes, clocks, input modes, owners, scale domains, and compatibility groups. Therefore:

- every runtime RmlUi context must create a `noveltea` data model before documents using it are
  loaded;
- all contexts bind to stable RuntimeUI-owned projection storage;
- each context retains its own `Rml::DataModelHandle`;
- model handles and backing pointers remain private to the RmlUi runtime layer;
- context teardown removes the model before the backing RuntimeUI state is destroyed;
- no RmlUi pointer or model handle becomes an application-facing API.

Add a narrow context-created initialization seam to `RmlUiHost` rather than teaching the host about
gameplay/project/shell domain state. The required ordering is exact:

1. RuntimeUI creates its projection/model owner before `RmlUiHost::initialize()`.
   Before installing the first context model, seed that owner from any state already retained in
   `RuntimeUI::State`: title labels, current accepted gameplay view/revision, typed notification, and
   current shell view. Do not assume those values can only arrive after RmlUi initialization.
2. RuntimeUI installs a context-initializer callback/seam on the host.
3. `RmlUiHost::context_for()` calls that initializer immediately after `Rml::CreateContext()` and
   context environment setup, but before the new context is returned to any document-loading code.
4. The initializer creates and fully registers `noveltea` in that context.
5. Create the model with normal strict variable resolution; do not make model typos silently valid
   as part of this refactor. The production RmlUi 6.2 API actually built by NovelTea exposes only
   `Context::CreateDataModel(name, data_type_register)` and does not expose the reference-snapshot
   `allow_missing_variables` parameter, so use the production API's normal strict behavior rather
   than adding a compatibility patch solely for this refactor.
6. If model creation/registration fails, context creation removes the just-created RmlUi context and
   fails; do not return a context in which
   `data-model="noveltea"` documents can be parsed without the required contract.
7. Secondary/lazy contexts use the same path. Do not special-case only `primary_context()`.
8. During `RuntimeUI::cleanup_state()`, unload/clear documents first, then ask
   `RuntimeUiDataModel` to call `RemoveDataModel("noveltea")` for every live host context and clear
   its handles, then call `RmlUiHost::shutdown()`. The projection object is destroyed only after all
   context models are detached.
9. After model removal, clear the host's context-initializer callback before destroying
   `RuntimeUiDataModel`, so the host never retains a closure/reference to a destroyed model owner.

The host initializer seam itself remains optional and domain-neutral so standalone `RmlUiHost`
tests/users that are not RuntimeUI do not acquire a NovelTea data-model dependency. RuntimeUI is the
owner that installs the initializer. When that initializer is installed, its failure is fatal to that
context creation as described above.

The target private owner is one focused `RuntimeUiDataModel` in new
`engine/src/ui/rmlui/runtime_ui_data_model.{hpp,cpp}`. It owns the projection storage and
context-local model handles; it does not own gameplay state, shell state, RmlUi contexts, or typed
input sinks. Do not split it into namespace-specific model owners in this refactor.

Model event callbacks retain access to the current native action gateway. Therefore the current
`RuntimeUiBinder` (and, after Phase 7, `RuntimeUiActionGateway`) must outlive every installed
`noveltea` model. `cleanup_state()` must not reset/destroy that gateway before documents are cleared
and `RuntimeUiDataModel` has removed all context models. This lifetime rule is mandatory even if no
event is expected during shutdown; do not leave callback closures containing dangling references.

### Model name and authoring

The single model name is:

```rml
data-model="noveltea"
```

Built-in documents must use normal RmlUi data binding, for example:

```rml
<body data-model="noveltea">
    <h1>{{ project.title }}</h1>
    <p data-if="gameplay.notification != ''">{{ gameplay.notification }}</p>
</body>
```

An authored Fragment may opt in on any fragment root/subtree:

```rml
<section data-model="noveltea">
    <span>{{ gameplay.mode }}</span>
</section>
```

Do not make element IDs semantic data-binding hooks. IDs may remain for styling, focus restoration,
tests, or author convenience.

### Projection ownership

Do not bind `core::TypedRuntimeUIViewState`, `RuntimeShellViewState`, compiled project structs, typed
ID wrappers, `std::optional`, or variants directly into RmlUi.

Create RmlUi-private projection structs under `engine/src/ui/rmlui/`. They must use stable,
RmlUi-friendly values:

- strings for IDs/tokens/labels;
- booleans for availability/selection/enabled state;
- numbers for coordinates, scale, counters, and durations;
- vectors of registered RmlUi projection structs for repeated data;
- always-present nested structs with the explicit `available`/`active` booleans specified below,
  never optional nested projection objects.

The projection is a presentation/read-model contract, not a second gameplay model. It must contain
only values needed by runtime UI.

Numeric projection types must preserve the full range of the source values used by this contract.
Do not narrow `std::uint64_t` revisions/generation counts or millisecond counts to 32-bit integers for
binding convenience. If the RmlUi scalar adapter needs an explicit registered scalar/getter
conversion, add one that preserves all values representable by the source contract rather than
silently truncating them.

All state variables exposed through `noveltea` are read-only from authored RML. Do not register
writable scalar members merely because `Rml::DataModelConstructor::Bind()` and struct member
registration can support assignment. Prefer getter-only registered struct members/collections (or an
equivalent read-only variable definition) so expressions such as `foo = ...` cannot mutate the
RuntimeUI projection. Mutations happen only through the explicit event callbacks defined below.
Add a regression proving an attempted assignment cannot change a projected state value.

In the RmlUi version under `refs/RmlUi`, `StructHandle::RegisterMember` getter overloads require
non-`const` member-function signatures. If getter-only projection structs are used, implement the
required non-const getter signatures rather than falling back to writable public member bindings just
to satisfy that API quirk.

### Exact initial namespaces and fields

The model exposes these top-level namespaces:

```text
project.*
gameplay.*
shell.*
```

`presentation.*` must **not** be added by this refactor. It is reserved for later transient
presentation work such as the Room-navigation source/target transition discussed in the non-goals.

The following field names, types, tokens, filtering, ordering, and fallback rules are normative. Do
not rename them during implementation without first updating this plan and all already-written phase
tests.

#### `project`

| Field | Type | Exact meaning |
| --- | --- | --- |
| `project.title` | string | Effective title label. Use `"NovelTea"` when the value supplied to `RuntimeUI::bind_title_document()` is empty. |
| `project.subtitle` | string | Subtitle supplied to `RuntimeUI::bind_title_document()`, including empty string. |
| `project.start_label` | string | Effective Start label. Use `"Start"` when the supplied value is empty. |

Initial values before any project/title binding are `"NovelTea"`, `""`, and `"Start"` respectively.

#### `gameplay`

| Field | Type | Exact meaning |
| --- | --- | --- |
| `gameplay.available` | bool | `true` iff a nonzero accepted `RuntimeUiGameplayValues` is currently retained. |
| `gameplay.mode` | string | `TypedRuntimeUIViewState::mode`, else empty. |
| `gameplay.title` | string | Current Map title when `view.map->title` exists, else empty. This preserves current `rt_title` behavior. |
| `gameplay.notification` | string | When `gameplay.available=true`: `RuntimeUI::typed_notification` when nonempty; otherwise `view.interaction->notification` when present; otherwise empty. Always empty when gameplay is unavailable. |
| `gameplay.can_continue` | bool | Current typed `can_continue`, else `false`. |
| `gameplay.active_text_available` | bool | `true` iff the current ActiveText source text is nonempty, using the existing precedence Scene text, then Dialogue line, then Room description. This is for ordinary panel visibility only; ActiveText content/rendering remains custom. |
| `gameplay.choices` | array | Effective current choice list defined below. |
| `gameplay.actors` | array | Visible Scene actors only, source order. Empty when no Scene. |
| `gameplay.room.available` | bool | `true` iff `view.room` exists. |
| `gameplay.room.has_enabled_exits` | bool | `true` iff at least one Room exit has `enabled=true`. |
| `gameplay.room.exits` | array | All current Room exits in source order, including disabled exits. |
| `gameplay.room.objects` | array | Visible Room placement occupants flattened placement-order then occupant-order. |
| `gameplay.inventory.items` | array | Visible inventory items only, source order. |
| `gameplay.interaction.has_selection` | bool | `!view.selected_subjects.empty()`. |
| `gameplay.interaction.actions` | array | `room.controls` when a Room exists, otherwise `inventory.controls`; preserve source order and include disabled controls. |
| `gameplay.text_log.entries` | array | Current gameplay Text Log entries in source order. |

`gameplay.choices` has exactly these member fields:

| Member | Type | Meaning |
| --- | --- | --- |
| `kind` | string | Exactly `"scene"` or `"dialogue"`. |
| `id` | string | Scene choice option ID or Dialogue edge ID. |
| `label` | string | Current option label. |
| `enabled` | bool | Current enabled state. |

Choice precedence must match the current binder: if a Scene choice exists, project only its options;
otherwise project Dialogue choice options; never merge simultaneous Scene and Dialogue collections.

`gameplay.actors` has exactly `character_id` (string), `instance_id` (string), `pose_id` (string),
`expression_id` (string), and `presentation_complete` (bool). `instance_id` must preserve the current
`actor_instance_text()` conversion of the `ActorPresentationKey`; do not expose the variant itself.

`gameplay.room.exits` has exactly `id` (string), `target_id` (string), `direction` (string), `label`
(string), `enabled` (bool), and `glyph` (string). Direction tokens are exactly `northwest`, `north`,
`northeast`, `west`, `custom`, `east`, `southwest`, `south`, and `southeast`. `glyph` preserves the
current built-in abbreviations `NW`, `N`, `NE`, `W`, `GO`, `E`, `SW`, `S`, `SE` so the built-in
compass does not need a custom transform function merely for its current presentation.

`gameplay.room.objects` has exactly `subject_kind` (string: `"character"` or `"interactable"`),
`subject_id` (string), `label` (string), `enabled` (bool), and `selected` (bool). Filter out occupants
with `visible=false`. `label` is `RoomPlacementView::label` when present, otherwise the subject ID,
matching current binder behavior. Do not deduplicate subjects that appear in multiple placements.

`gameplay.inventory.items` has exactly `id` (string interactable ID), `display_name` (string),
`enabled` (bool), and `selected` (bool). Filter out items with `visible=false`.

`gameplay.interaction.actions` has exactly `verb_id` (string), `label` (string), `arity` (integer),
`quick_action` (bool), and `enabled` (bool).

`gameplay.text_log.entries` has exactly `sequence` (zero-based integer index), `kind` (string token
`"line"`, `"choice"`, or `"notification"`), `has_speaker` (bool), `speaker_id` (string, empty when
absent), `text` (plain source string), and `body_rml` (engine-generated sanitized rich RML described
in Phase 4). The new model contract intentionally uses readable string kind tokens rather than the
old custom element's numeric `data-kind` value; no numeric compatibility alias is allowed.

When gameplay values are cleared, reset `gameplay.available=false`, all strings/booleans to their
empty/false defaults, and all arrays to empty, then dirty the model. Do not leave the last published
ordinary data-model values visible.

#### `shell`

| Field | Type | Exact meaning |
| --- | --- | --- |
| `shell.available` | bool | `true` iff `RuntimeUI` currently retains a `RuntimeShellViewState`. |
| `shell.screen` | string | Exactly `none`, `title`, `pause`, `settings`, `save`, `load`, `text-log`, `confirmation`, or `debug`. |
| `shell.game_active` | bool | Current `RuntimeShellViewState::game_active`. |
| `shell.status` | string | Current shell status. |
| `shell.settings.ui_scale.enabled` | bool | Current project UI-scale policy enabled flag. |
| `shell.settings.ui_scale.value` | number | Current effective UI scale. |
| `shell.settings.ui_scale.minimum` | number | Current project minimum. |
| `shell.settings.ui_scale.default_value` | number | `RuntimeUserSettings::default_ui_scale`. |
| `shell.settings.ui_scale.maximum` | number | Current project maximum. |
| `shell.settings.text_scale.enabled` | bool | Current project text-scale policy enabled flag. |
| `shell.settings.text_scale.value` | number | Current effective text scale. |
| `shell.settings.text_scale.minimum` | number | Current project minimum. |
| `shell.settings.text_scale.default_value` | number | `RuntimeUserSettings::default_text_scale`. |
| `shell.settings.text_scale.maximum` | number | Current project maximum. |
| `shell.checkpoint.available` | bool | `true` iff shell view has a checkpoint observation. |
| `shell.checkpoint.ready` | bool | `checkpoint.readiness.can_capture()`, else `false`. |
| `shell.checkpoint.retained` | bool | Whether `retained_revision` exists. |
| `shell.checkpoint.retained_revision` | string | Decimal revision when retained, else empty. |
| `shell.checkpoint.replay_structural_generations` | integer | Current replay-distance structural generations, else `0`. |
| `shell.checkpoint.replay_time_generations` | integer | Current replay-distance time generations, else `0`. |
| `shell.checkpoint.replay_play_time_ms` | integer | Current replay-distance play time in milliseconds, else `0`. |
| `shell.checkpoint.thumbnail_available` | bool | Current observation value, else `false`. |
| `shell.checkpoint.thumbnail_capture_pending` | bool | Current observation value, else `false`. |
| `shell.checkpoint.summary` | string | Exact current human-readable checkpoint summary text; when unavailable, `"Checkpoint status unavailable."`. |
| `shell.save_slots` | array | Every slot in `RuntimeShellViewState::slots`, preserving source order and including autosave. |
| `shell.confirmation.active` | bool | Whether a confirmation exists. |
| `shell.confirmation.prompt` | string | Confirmation prompt, else empty. |

When `shell.checkpoint.available=true`, `shell.checkpoint.summary` must preserve the exact existing
format:

```text
{Ready to capture|Capture blocked} · retained {revision|none} · replay distance {structural} structural / {time} time / {play_ms} ms · thumbnail {pending|available|unavailable}
```

`pending` takes precedence over `available`, exactly as the current native shell binder does.

Each `shell.save_slots` item has exactly `kind` (string `"autosave"` or `"manual"`), `number`
(integer; autosave is `0`), `label` (string, preserving current `Autosave` / `Slot N` presentation),
`occupied` (bool), `has_metadata` (bool), `play_time_ms` (integer, `0` when absent),
`project_version` (string, empty when absent), `detail` (string preserving current `Empty`, `Occupied`,
or `Play time N ms · version V` presentation), `thumbnail_available` (bool), and `thumbnail_url`
(string, empty when absent). For an available thumbnail, native virtual-file registration uses the
existing `project:/generated/shell/<fingerprinted-name>.png` key and `thumbnail_url` exposes that same
logical `project:/generated/shell/<fingerprinted-name>.png` URL. Unlike an authored RML attribute,
`data-attr-src` assigns the model string after XML parsing, so the source-only `project|/` encoding is
not decoded there and would be treated as document-relative by RmlUi's texture path join. The model
always contains autosave;
the Save document filters it with
`data-if`, while the Load document renders it.

When the shell view is cleared, reset `shell.available=false`, `screen="none"`, `game_active=false`,
`status=""`; reset both scale groups to `enabled=false`, `value=RuntimeUserSettings` default,
`minimum=1.0`, `default_value=RuntimeUserSettings` default, `maximum=1.0`; reset checkpoint fields to
their unavailable/false/zero/empty values with summary `"Checkpoint status unavailable."`; empty
`shell.save_slots`; reset confirmation to inactive/empty; then dirty the model.

### Projection update triggers

Projection refresh is event-driven from existing RuntimeUI entrypoints; do not add a per-frame copy
of the full model. At minimum, these calls must update the stated projection before dirtying every
live context model:

- `RuntimeUI::bind_title_document()` -> `project.*`;
- accepted `apply_gameplay_ui_values()` / `commit_gameplay_ui_values()` -> all `gameplay.*`, plus
  recomputation of effective `gameplay.notification`;
- `clear_gameplay_ui_values()` -> reset `gameplay.*`;
- `set_runtime_notification()` -> recompute only the effective gameplay notification value in
  storage, then dirty the model;
- `apply_runtime_shell_view()` -> all `shell.*`, including thumbnail URL materialization before slot
  projection is published;
- `clear_runtime_shell_view()` -> reset `shell.*`;
- document reload/context recreation -> do not rebuild state from DOM; a newly/recreated context
  binds the already-current projection and therefore renders the latest values on its first update.

`DirtyAllVariables()` on every live model handle after one coherent projection update is the initial
required strategy. Do not call it before the backing projection mutation is complete. Dirtying does
not mean synchronously mutating document DOM: RmlUi applies dirty data views during the context's next
normal `Context::Update()`. Do not call `Context::Update()` from RuntimeUI projection setters merely
to emulate the old binder's synchronous `SetInnerRML()` side effect. Integration tests that inspect
bound elements must advance the relevant context update before asserting the new value.

### Action callbacks

The `noveltea` model registers the following exact flat callback names in every context. RmlUi data
expressions do not support dotted function names, so do not rename these to `gameplay.foo` or
`shell.foo` forms.

```text
ui_continue()
ui_choose(kind, id)
ui_navigate_room(exit_id)
ui_toggle_subject(subject_kind, subject_id)
ui_clear_selection()
ui_invoke_interaction(verb_id)

shell_start()
shell_pause()
shell_resume()
shell_open_settings()
shell_open_save()
shell_open_load()
shell_open_text_log()
shell_open_debug()
shell_close()
shell_return_to_title()
shell_quit()
shell_save_slot(number)
shell_load_slot(kind, number)
shell_set_ui_scale(value)
shell_set_text_scale(value)
shell_confirm()
shell_cancel()
```

`ui_choose()` accepts only `kind == "scene"` or `"dialogue"` and then calls the same typed validation
used by the corresponding current `Game.ui.choose_scene()` / `choose_dialogue()` path.
`ui_toggle_subject()` accepts only `"character"` or `"interactable"` and delegates to the same
selection validation as the current two Lua helpers. `shell_load_slot()` accepts only `"autosave"`
or `"manual"`; `"autosave"` requires `number == 0`, while `"manual"` requires the same valid manual
slot number accepted by the current `Game.shell.load(number)` path and constructs the same
`TypedSaveSlotId`. `shell_save_slot()` accepts only a valid manual slot number and uses the current
`Game.shell.save(number)` path. Invalid kind/number/argument combinations produce a RuntimeUI
diagnostic and no typed shell command.

Do not add a model callback for Map connection navigation in this refactor. The provisional
`nt-map-view` keeps its current generated `Game.ui.navigate_map_connection()` activation until the
Map component is redesigned. Likewise, hotspot activation remains on the existing Lua/runtime API;
the data model does not expose hotspot controls in this plan.

Every callback is a thin adapter over one named native action path that is also called by the
equivalent existing Lua helper. Do not maintain one validation implementation for Lua and another for
the data model. Model callback dispatch occurs during the same RmlUi event capture/context dispatch as
other authored RML events; it must use the existing typed input/shell-command gateway rather than call
the runtime session or input sink directly. For every callback, focused tests must prove that invoking
the model callback from a given Layout context accepts/rejects the same request as the equivalent Lua
helper from that context. This plan does not tighten or broaden existing Layout authority as a side
effect of changing the binding mechanism.

Pass IDs/tokens to callbacks as RmlUi expression arguments (`ui_choose(choice.kind, choice.id)`,
etc.). Do not regenerate Lua source strings, `onclick` attribute strings, or quoting/escaping helpers
for data-driven controls. Eliminating that generated-command-string layer is part of this refactor.

All ordinary built-in system documents converted by this plan must use these `data-event-*`
callbacks instead of their current static `onclick="Game.*"` handlers, so the built-ins exercise the
new contract. The existing `Game.ui.*`, `Game.shell.*`, and `Game.start()` Lua APIs remain available
for authored Lua/RML compatibility with the current unreleased API surface; removing them is a
separate decision.

### Required authoring patterns

The exact surrounding built-in structure/classes may remain as currently authored, but dynamic
children must use normal RmlUi data views. These examples are the intended syntax and remove any need
for an implementation agent to invent a second templating mechanism.

Choice rendering:

```rml
<button data-for="choice : gameplay.choices"
        class="option"
        data-class-disabled="!choice.enabled"
        data-attrif-disabled="!choice.enabled"
        data-event-click="ui_choose(choice.kind, choice.id)">
    {{ choice.label }}
</button>
```

Room-object rendering follows the same pattern and uses
`ui_toggle_subject(object.subject_kind, object.subject_id)`. Inventory passes literal
`'interactable'` plus `item.id`. Action controls use `ui_invoke_interaction(action.verb_id)` and add
both disabled class and attribute from `!action.enabled`.

The built-in compass iterates `gameplay.room.exits`, filters disabled exits with `data-if`, binds
`data-exit-id` only as authored metadata if desired (never for native dispatch), calls
`ui_navigate_room(exit.id)`, and applies each existing `nav-slot-{direction}` class with
`data-class-*` expressions based on `exit.direction`. The container uses
`data-if="gameplay.room.has_enabled_exits"`.

Text Log rendering:

```rml
<div data-if="gameplay.text_log.entries.size == 0" class="nt-text-log__empty">No log entries</div>
<div data-for="entry : gameplay.text_log.entries"
     class="nt-text-log__entry"
     data-attr-data-sequence="entry.sequence"
     data-attr-data-kind="entry.kind">
    <span data-if="entry.has_speaker" class="nt-text-log__speaker">{{ entry.speaker_id }}</span>
    <div class="nt-text-log__body" data-rml="entry.body_rml"></div>
</div>
```

Save/Load rendering iterates the single `shell.save_slots` collection. Save slot sections use
`data-if="slot.kind != 'autosave'"`; Load renders both kinds. Thumbnail `<img>` uses
`data-if="slot.thumbnail_available"` plus `data-attr-src="slot.thumbnail_url"`, with the existing
missing-thumbnail paragraph under the inverse condition. Save always offers its action for rendered
manual slots. Load offers its action only when `slot.occupied`, exactly matching current behavior.

## Phase 0 - Characterize the current contract

### Work

- [x] Add focused tests that capture current user-visible behavior for every binder-produced value
      or control that will be cut over.
- [x] Cover Game HUD title/notification, Scene choices, Dialogue choices, Room exits, Room objects,
      inventory, actions, selection, and group visibility using the current built-in where those
      controls exist.
- [x] Cover binder-supported but not currently built-in slots (`rt_mode`, `rt_prompt`, `rt_actors`)
      in focused binder fixtures only. These tests characterize the state semantics being moved into
      the model; they must not cause those controls to be added to the built-in Game HUD later.
- [x] Cover title project/subtitle/start labels.
- [x] Cover shell status, settings scale values/visibility, checkpoint state, save/load slots,
      thumbnail presence, and modal prompt.
- [x] Cover typed stale/disabled action rejection independently from generated binder markup so later
      RML changes cannot accidentally weaken validation.
- [x] Characterize `nt-active-text` direct-render surface and native click behavior separately from
      ordinary document binding.
- [x] Characterize current `nt-map-view` behavior separately and mark it provisional.
- [x] Characterize Text Log entry ordering, speaker text, kind/sequence metadata, rich-text output,
      and empty state before replacing `nt-text-log`.

### Exit gate

- [x] Every behavior removed from native DOM mutation has a pre-cutover regression assertion or an
      explicitly documented intentional contract change.
- [x] Tests do not require preserving obsolete magic IDs after the cutover; they assert behavior,
      typed action admission, or current built-in presentation.
- [x] The characterization records which controls are actually present in the shipped built-ins so a
      later phase cannot accidentally add a visible feature while translating a binder capability.

## Phase 1 - Add the shared RmlUi data-model foundation

### Implementation findings

- Production RmlUi 6.2 in `build/linux-debug/_deps/rmlui-src` has the two-argument
  `Context::CreateDataModel(name, data_type_register)` API, not the three-argument reference-snapshot
  API. Phase 1 therefore uses the production API's existing strict variable-resolution behavior;
  no RmlUi patch is required or justified by this refactor.
- RmlUi's getter-only struct registration is not read-only when a scalar getter returns a mutable
  reference: `MemberGetFuncDefinition` exposes that referenced scalar to assignment. Phase 1 must
  expose scalar/string leaf getters by value while retaining reference getters only for nested
  struct/array traversal. The authored-assignment regression is required to preserve this invariant.
- RmlUi `data-for` retains its template element alongside instantiated rows, and `data-if=false`
  retains the authored node but hides it. Later migration tests must validate instantiated row
  content/cardinality and effective visibility rather than assuming class queries contain only
  generated rows or that a false `data-if` removes the element from the DOM.
- The current `RuntimeUiPlaybackDriver::click()` interaction preflight recognizes legacy `onclick`
  and registered native click listeners, but not RmlUi `data-event-click` bindings. Phase 1 therefore
  validates model callbacks with RmlUi `DispatchEvent()` directly. Later declarative-event playback
  validation must either use that same RmlUi event path or deliberately extend playback-driver
  interaction detection; a `TargetNotInteractive` result from the current driver is not evidence
  that a model callback failed to register.
- Data-model callbacks cannot reuse validation hidden inside the existing Lua closure bodies.
  Phase 1 therefore extracts the existing gameplay validation/dispatch into named native
  `RuntimeUiBinder` action methods and rewires the equivalent `Game.ui.*` Lua helpers to those same
  methods. This is required now to avoid introducing a second validation implementation; Phase 7
  retains these shared methods and only rehomes/renames the surviving action gateway.

### Work

- [x] Add `runtime_ui_data_model.{hpp,cpp}` with RmlUi-private projection structs implementing the
      exact field contract above.
- [x] Add the new files to `cmake/NovelTeaModuleFileClassification.cmake` in the same UI/runtime
      classification as the surrounding RmlUi RuntimeUI private sources.
- [x] Flatten backend-neutral typed IDs/variants/optionals into RmlUi-friendly presentation fields.
- [x] Add one RuntimeUI-owned projection instance with stable addresses for the entire RuntimeUI
      lifetime.
- [x] Construct the data-model owner and install the host context initializer before
      `RmlUiHost::initialize()` creates the primary context; use the same initializer for every later
      `context_for()` creation.
- [x] Seed the projection from any RuntimeUI state already retained before initialization, then prove
      with a focused lifecycle test that the first loaded model-bound document sees those values
      without requiring the source state to be republished.
- [x] Register required scalar/struct/array types in each context.
- [x] Bind the same stable projection storage into each context-local model.
- [x] Retain one model handle per live context and drop it with that context.
- [x] Do not key model handles by `RmlUiHost::contexts()` vector index because that vector is sorted.
      Retain an explicit context pointer/name/key with each handle so sorting cannot associate a
      handle with the wrong context.
- [x] Implement every projection update trigger listed above and call `DirtyAllVariables()` only
      after the coherent backing mutation completes.
- [x] Register projected state as read-only and register the exact callback names above.
- [x] Add headless tests proving `{{ ... }}`, `data-if`, `data-for`, attribute/class/style binding,
      and model callbacks work in NovelTea-loaded documents.
- [x] Add a headless regression proving `{{ 10 }}` remains literal outside an active `data-model`
      subtree and evaluates inside `data-model="noveltea"`; this captures the RmlUi opt-in rule that
      motivated the host initialization ordering.
- [x] Add a regression proving authored assignment cannot mutate a projected read-only value.
- [x] Prove the model works in at least two distinct lifecycle contexts, not only the primary GameUi
      context.
- [x] Prove an ordinary Lua-mounted/custom Layout can use `data-model="noveltea"` without a system
      role.

### Exit gate

- [x] A test Layout can render project/gameplay/shell scalar values and a repeated collection through
      RmlUi's native data binding with no `GetElementById()`/`SetInnerRML()` population.
- [x] A data-model event callback reaches the existing typed action gateway and preserves stale/
      disabled validation.
- [x] Primary and secondary contexts both fail closed if `noveltea` model initialization fails; no
      model-bound document is parsed in a partially initialized context.
- [x] No backend-neutral core header gains RmlUi types.
- [x] The existing negative public-API contract remains true: `RuntimeUI` does not expose generic
      borrowed RmlUi document/element/data-model handles or public `create_data_model` / `data_model`
      methods. The `noveltea` model is an authored-RML contract implemented entirely behind the
      private RuntimeUI adapter.

## Phase 2 - Cut over simple project and shell state

### Implementation findings

- RmlUi data binding is publication-driven rather than an authoritative repair loop for arbitrary
  direct DOM mutation. During Phase 2 validation, manually replacing a rendered `shell.status`
  node and then dirtying the model because an unrelated gameplay value changed did not restore the
  unchanged shell value. The old native binder incidentally did so because it repopulated IDs on
  each refresh. That side effect is not part of the declarative target contract. Cutover tests must
  validate source publication -> `Context::Update()` -> rendered value transitions rather than
  require recovery from unsupported external DOM mutation.
- Save/Load checkpoint/list generation and Text Log content binding still share
  `refresh_runtime_shell_documents()` after this phase because those are the explicit Phase 5 and
  Phase 4 migration owners respectively. Phase 2 removed only title/settings/modal/status scalar
  mutation and static authored shell event wiring; deleting or renaming the remaining refresh helper
  now would cross later-phase ownership boundaries.

### Work

- [x] Convert built-in Title RML to `data-model="noveltea"` and declarative project title, subtitle,
      Start label, and shell status values.
- [x] Convert Pause shell status to the model.
- [x] Convert Settings current/minimum/maximum UI/text scales and enabled visibility to model
      expressions.
- [x] Convert Modal confirmation prompt and shell status to the model.
- [x] Convert shared shell status in Save, Load, and Text Log documents to the model.
- [x] Replace all ordinary built-in Title/Pause/Settings/Save/Load/Text Log/Modal
      `onclick="Game.*"` handlers with the exact `data-event-*` callbacks defined above. Do not
      remove or rename the Lua APIs.
- [x] Settings minimum/default/maximum buttons call `shell_set_ui_scale(...)` or
      `shell_set_text_scale(...)` with the corresponding projected `minimum`, `default_value`, or
      `maximum`; do not add separate model callbacks for the three presets.
- [x] Remove native title/settings/modal/status DOM mutation once all built-in documents use the
      model.

### Exit gate

- [x] Title, Pause, Settings, Modal, Save, Load, and Text Log built-ins display their scalar shell
      state without native element lookup/population.
- [x] Project-authored system replacements can use the same `noveltea` model but receive no hidden
      role-specific DOM injection.
- [x] No ordinary shell built-in requires a native `GetElementById()` call for dynamic text,
      visibility, or event wiring after this phase. Save/load list generation remains the explicit
      Phase 5 exception.

## Phase 3 - Cut over Game HUD ordinary RML

### Implementation findings

- The Phase 3 exit gate requires `RuntimeUiDocumentBinder` to retain only ActiveText and provisional
  Map snapshot delivery. The pre-Phase-3 binder also delivered the still-Phase-4-owned
  `nt-text-log` snapshot as a side effect when the Text Log system document was refreshed. Phase 3
  therefore preserves that existing Text Log behavior with a temporary focused delivery branch in
  `RuntimeUI::State::refresh_runtime_shell_documents()` rather than leaving Text Log ownership in
  the general binder. Phase 4 must delete that temporary branch when it removes `nt-text-log`.
- RmlUi `data-if` owns conditional hiding by applying/removing its own display override; when the
  condition becomes true, the element falls back to its authored stylesheet display value. The old
  Game HUD stylesheet hard-coded `display: none` on title/notification, interaction dock, text panel,
  and navigation because the native binder later forced those elements visible. Those hard-hide
  baselines must be removed when the model becomes the visibility owner or a true `data-if` remains
  visually hidden.
- The focused Scene-to-Dialogue transition test confirms that shrinking multiple `data-for` arrays in
  one coherent publication converges to the correct DOM, but the current RmlUi implementation can
  emit transient `Data array index out of bounds` warnings while stale loop rows are being retired.
  Phase 4/5 repeated-list validation should continue to assert final add/remove/reorder convergence;
  this warning is not a reason to split coherent NovelTea publication or add native repair mutation.

### Work

- [x] Convert the built-in title and notification to model interpolation/conditions. Do not add a
      visible runtime-mode label to the built-in; exercise `gameplay.mode` in model tests/fixtures.
- [x] Keep `<nt-active-text>` as the authored ActiveText host; remove the `rt_body` ordinary-text
      fallback from the current contract.
- [x] Expose `gameplay.can_continue` and `ui_continue()` for authored Layouts, and migrate any focused
      `rt_prompt` fixture to declarative RML. Do **not** add a standalone Continue button to
      `runtime_game.rml`; the current built-in uses ActiveText click/continue behavior instead.
- [x] Flatten Scene/Dialogue choices into one RmlUi-facing collection with enough type/id information
      for one validated callback to select the correct typed action.
- [x] Author choices with `data-for`, disabled state, classes, labels, and model callbacks.
- [x] Project visible Scene actor metadata into `gameplay.actors` and migrate any focused `rt_actors`
      fixture to `data-for`. Do **not** add an actor metadata list to the current built-in Game HUD.
- [x] Project Room exits as a model array with stable exit ID, target ID, direction token, label, and
      enabled state.
- [x] Rebuild the built-in compass/navigation using `data-for` and authored classes/data attributes;
      do not depend on `rt_nav_*` magic IDs or native `data-exit-id` mutation.
- [x] Preserve the current compass visual order/placement by using the projected direction token and
      the existing `nav-slot-{direction}` positioning classes. The built-in renders only exits with
      `enabled=true`, and the navigation
      container is hidden when `gameplay.room.has_enabled_exits=false`, matching current behavior.
- [x] Route navigation activation through the same validated native action path as
      `Game.ui.navigate_room()`.
- [x] Flatten visible Room placement occupants into an RmlUi-facing object list with subject kind,
      ID, label, enabled state, and selected state.
- [x] Project visible inventory items with ID, display name, enabled state, and selected state.
- [x] Project current interaction controls with verb ID, label, arity/quick-action metadata where
      useful, and enabled state.
- [x] Author Room objects, inventory, clear-selection, and actions with `data-for`, `data-if`,
      `data-class-*`, and data-model callbacks.
- [x] Preserve current object/inventory/action ordering and visibility semantics exactly as specified
      by the projection contract; do not sort or deduplicate, and keep disabled action controls
      rendered with disabled state as the current binder does.
- [x] Replace `rt_text_panel`, group, and dock native visibility/pointer mutations with authored data
      expressions/classes/styles.
- [x] `rt_text_panel` equivalent visibility is
      `gameplay.active_text_available || gameplay.choices.size > 0`; its pointer admission is
      `gameplay.can_continue || gameplay.choices.size > 0`. Objects and inventory groups are visible
      when their arrays are nonempty. The actions group is visible when
      `gameplay.interaction.has_selection || gameplay.interaction.actions.size > 0`; the interaction
      dock is visible when any of those three groups is visible.
- [x] Remove the RuntimeUI native listener's special traversal of `data-exit-id` once navigation is
      model-callback-driven. Retain only native event handling that is still required for specialized
      components such as ActiveText.

### Exit gate

- [x] `RuntimeUiDocumentBinder` no longer generates or mutates ordinary Game HUD controls.
- [x] A temporarily reduced `RuntimeUiDocumentBinder` may still exist after this phase solely to
      deliver `nt-active-text` and provisional `nt-map-view` snapshots. It must contain no ordinary
      ID-based state injection; Phase 6 removes those remaining component deliveries.
- [x] Built-in Game HUD behavior remains equivalent for current gameplay flows.
- [x] The same gameplay collections can be rendered from an ordinary non-system Layout using
      `data-model="noveltea"`.
- [x] Invalid/stale/hidden/disabled actions are still rejected by native typed validation.

## Phase 4 - Move Text Log to the data model

### Implementation findings

- The existing Text Log rich-text serializer used the ActiveText frame/glyph projection utilities
  for its sanitized presentation output. Phase 4 moves the Text Log-only paragraph/glyph/style-to-RML
  serialization into `runtime_ui_data_model.cpp` while retaining the shared `escape_rml()` helper in
  `rmlui_custom_components.*`, where the provisional Map and existing native Save/Load generation
  still use it. Phase 6 must not treat this data-model rich-text projection dependency as custom-
  element snapshot delivery to remove.
- Removing the temporary direct `NtTextLogElement` update does not yet permit removing the Text Log
  role's reduced `RuntimeUiBinder::bind_document()` call: until Phase 6, that retained binder remains
  the planned ActiveText/provisional-Map snapshot delivery path for system documents. Phase 4 removes
  only the Text Log-specific branch and leaves that later-phase scaffolding intact.

### Work

- [x] Expose Text Log entries as an ordered model collection with sequence, kind, optional speaker,
      and body presentation data.
- [x] Preserve current rich-text rendering with the required `body_rml` field specified above and
      use RmlUi `data-rml`; do not generate the entire Text Log document/list in C++.
- [x] Build `body_rml` only from the existing parsed `core::RichTextDocument` path and existing
      escaping/style serialization. It must never contain raw unescaped `TextLogEntry::text` or
      arbitrary user-authored RML. Move the Text Log-only rich-text-to-RML serialization into
      `runtime_ui_data_model.cpp`; do not keep Text Log snapshot/RML helpers in
      `rmlui_custom_components.*` after the custom element is removed.
- [x] Convert the built-in Text Log Layout to ordinary RML with `data-for`.
- [x] Provide authored empty-state markup with `data-if` rather than `NtTextLogElement::SetInnerRML`.
- [x] Remove `nt-text-log` registration, snapshot types/helpers that exist only for that component,
      and the `rt_log` legacy fallback.
- [x] Remove the temporary `RuntimeUI::State::refresh_runtime_shell_documents()` direct
      `NtTextLogElement` snapshot-delivery branch introduced by Phase 3 once the Text Log document is
      fully data-driven.
- [x] Update focused preview/tests so Text Log markup is treated as ordinary data-driven RML.

### Exit gate

- [x] Text Log no longer requires a C++ custom element or document binder.
- [x] Entry order, speaker, kind/sequence metadata, rich text, and empty state remain correct.
- [x] The built-in Text Log uses `gameplay.text_log.entries`; do not introduce a duplicate
      `shell.text_log` alias solely because `RuntimeShellViewState` also carries a copy of the log.

## Phase 5 - Move Save/Load list presentation to the data model

### Implementation findings

- RmlUi's `data-attr-src` applies the evaluated model string directly to the image element after XML
  parsing. The `project|/` namespace spelling is an authored-source escape and is not decoded on this
  dynamic path; RmlUi consequently joined it relative to the owning document. Phase 5 therefore
  publishes the already-logical `project:/generated/shell/...` URL in `thumbnail_url`, while native
  virtual-file registration continues to use the identical `project:/...` key. This is a correction
  to the pre-implementation contract, not a new resource ownership path.

### Work

- [x] Project the exact `shell.checkpoint.*` and `shell.save_slots[]` fields defined above; do not
      invent a second slot shape for Save versus Load.
- [x] Keep thumbnail bytes and virtual-file publication native. Convert each available thumbnail into
      a stable model `thumbnail_url`; never expose raw bytes through the data model.
- [x] Keep that byte-to-virtual-file preparation in RuntimeUI/document-registry resource code, not
      inside `RuntimeUiDataModel`. The model owner receives only the already-materialized URL plus
      ordinary slot metadata; it must not gain `RmlUiDocumentRegistry` or asset-byte ownership.
- [x] Preserve the current content-fingerprinted generated filename semantics under
      `project:/generated/shell/`. Materialize/register the virtual file before publishing the slot's
      nonempty `thumbnail_url`, so RmlUi cannot observe a URL before its bytes are available.
- [x] Convert built-in Save and Load documents to `data-for` slot markup.
- [x] Author Save-menu autosave omission through `data-if` rather than native filtering.
- [x] In Load, render slot metadata/thumbnail for every projected slot but author the Load button
      only under `data-if="slot.occupied"`; do not render a disabled Load button for empty slots,
      because the current native binder omits the action entirely.
- [x] Route Save/Load activation through `shell_save_slot(number)` and
      `shell_load_slot(kind, number)` using the same typed shell command paths as `Game.shell.*`.
- [x] Delete native C++ generation of `section.nt-save-slot`, thumbnail `<img>`, and Save/Load buttons.

### Exit gate

- [x] Save and Load menus contain no C++-generated RML.
- [x] Thumbnail refresh still changes the resource URL when bytes change, and no thumbnail bytes are
      stored in ordinary RML/model string values.
- [x] Autosave/manual slot behavior and typed shell validation remain correct.

## Phase 6 - Isolate the custom-component path

### ActiveText

- [x] Remove ActiveText snapshot delivery from the general document binder.
- [x] Keep `nt-active-text` and `ActiveTextPresenter` as the specialized integration path.
- [x] Preserve the existing supported host scope: the first `<nt-active-text>` in the active
      `game-hud` system Layout is the direct-render/input surface. Do not make arbitrary mounted
      Layouts or multiple simultaneous ActiveText elements independently rendered in this refactor.
- [x] Give RuntimeUI one focused ActiveText refresh path that updates that element's current snapshot
      by calling the existing `NtActiveTextElement::set_snapshot(make_active_text_snapshot(...))`
      semantics for the first Game HUD tag and refreshes `ActiveTextPresenter`. The focused path
      searches by the `nt-active-text` custom tag; it must not search ordinary population IDs or resurrect the
      general binder.
- [x] When no gameplay view is retained, do not synthesize a fake ActiveText gameplay snapshot merely
      to update the element. Preserve the current presenter behavior by refreshing
      `ActiveTextPresenter` with `nullptr`, which clears the direct-render layout. Host-element
      diagnostic attributes are non-authoritative and must not become a replacement state source.
- [x] Preserve the existing RmlUi-derived surface contract: content bounds, computed color,
      `rmlui-language`, text scale, and font raster scale.
- [x] Preserve engine-owned shaping, font leases, reveal/page/fade state, direct rendering, object hit
      testing, and typed Continue/selection input.
- [x] Keep ActiveText's native event handling explicit and separate from ordinary model callbacks.
- [x] Do not broaden ActiveText to arbitrary simultaneous multi-document instances in this refactor.
      If that capability is desired later, record it as a separate component-lifecycle follow-up.

### Provisional Map

- [x] Retain `nt-map-view` during this refactor.
- [x] Replace its dependence on the general document binder with one focused tag-based snapshot
      updater. Preserve the current binding scope exactly: update the first `<nt-map-view>` in the
      active `game-hud` document and, because the current Text Log role is passed through the gameplay
      binder, the first one in the active `text-log` system document if present. Do not make Map state
      automatically populate arbitrary non-system Layouts in this plan.
- [x] Invoke that Map updater only when a current gameplay view exists, matching the current
      `RuntimeUiBinder::bind_document()` behavior. Do not invent a new empty/unavailable Map reset
      contract as part of this provisional isolation work.
- [x] Keep the current `NtMapViewElement::set_snapshot()` / `map_view_rml()` style of provisional
      inner-RML generation in `rmlui_custom_components.*`. Removing Text Log helpers must not be used
      as a reason to redesign or relocate Map internals. This phase is isolation, not Map redesign.
- [x] Do not redesign Map markup, pan/zoom, graph rendering, connection geometry, or final component
      authoring contract here.
- [x] Do not add a parallel full Map data-model contract solely to make this refactor look uniform.
- [x] Keep map navigation actions on the existing validated typed path.
- [x] Mark the current `nt-map-view` inner-RML generation as provisional in permanent docs after the
      refactor.

### Exit gate

- [x] The only custom runtime element required by current mature functionality is `nt-active-text`;
      `nt-map-view` remains an explicitly provisional exception.
- [x] No ordinary data-driven widget is routed through a custom component merely to preserve the old
      binder architecture.
- [x] `RuntimeUiComponentRegistry` contains ActiveText and Map only; Text Log is no longer registered.

## Phase 7 - Remove the document binder and reconcile RuntimeUI ownership

### Work

- [x] Delete `RuntimeUiDocumentBinder` after all ordinary DOM population and custom-component snapshot
      delivery have moved to their new owners.
- [x] Remove `bind_document()` and the document-binder member from the current `RuntimeUiBinder`.
- [x] Remove obsolete RML generation helpers used only by deleted binder paths.
- [x] Retain/rehome revision gating, latest-view ownership, typed action validation, Layout gameplay
      admission, typed input dispatch, event capture, and `Game.ui.*` installation.
- [x] Preserve the named native action methods introduced in Phase 1 as the shared implementation
      used by Lua and RmlUi model callbacks; rehome them with the surviving action-gateway
      responsibilities rather than recreating or duplicating stale/enabled validation during the
      binder deletion/rename.
- [x] Rename the surviving `RuntimeUiBinder` to `RuntimeUiActionGateway` and rename its source files to
      `runtime_ui_action_gateway.{hpp,cpp}`. Keep its current cohesive responsibilities together:
      revisioned latest gameplay view, typed validation/dispatch, Layout gameplay admission, event
      capture, and `Game.ui.*` installation. Do not split those into trivial one-method owners as part
      of this refactor.
- [x] Update `cmake/NovelTeaModuleFileClassification.cmake` atomically with deletion of
      `rmlui_document_binder.*` and the `runtime_ui_binder.*` -> `runtime_ui_action_gateway.*` rename;
      no stale classified path may remain.
- [x] Remove semantic reliance on the old `rt_*`, `nt-title-*`, `nt-settings-*`, `nt-save-slots`, and
      related population IDs. Built-in RML may retain useful IDs/classes strictly as authored styling
      hooks.
- [x] Remove generated-navigation `data-exit-id` native click routing if no remaining component uses
      it.
- [x] Verify reload/context recreation reuses current projection state and reattaches `noveltea`
      before the recreated documents bind.
- [x] Remove now-dead title/shell refresh functions whose only purpose was ordinary DOM mutation.
      Retain narrowly named refresh helpers only for ActiveText, provisional Map, and native virtual
      resource preparation.

### Exit gate

- [x] No production code searches ordinary authored documents by magic population ID in order to
      inject gameplay/project/shell state.
- [x] No production code generates whole choice/navigation/object/inventory/action/save/load/text-log
      UI subtrees with `SetInnerRML()`.
- [x] Remaining `SetInnerRML()` use is limited to explicitly justified specialized/provisional
      component behavior or unrelated RmlUi infrastructure.
- [x] No type or function remaining in production uses `Binder` terminology for ordinary RML state
      population; the deleted `RuntimeUiDocumentBinder` has no compatibility wrapper or alias.

## Phase 8 - Documentation, validation, and archival

### Permanent documentation

- [ ] Replace `docs/ui/SYSTEM_LAYOUT_RML_CONTRACT.md` with
      `docs/ui/RMLUI_DATA_MODEL_CONTRACT.md`. The new file is the authoritative contract for the
      exact `noveltea` fields/callbacks in this plan and applies to any opted-in Layout, not only
      system roles. Do not leave a duplicate active contract under the old filename.
- [ ] Update `docs/ui/RMLUI_RUNTIME_UI.md` so RuntimeUI is described as a data-model publication
      adapter/action gateway rather than a document-slot binder.
- [ ] Update `docs/ui/RMLUI_CUSTOM_COMPONENTS.md` to retain ActiveText, mark Map provisional, remove
      Text Log as a current custom component, and state the rule that ordinary RmlUi data binding is
      preferred whenever sufficient.
- [ ] Update `docs/ui/OVERVIEW.md` routing after archival so permanent docs, not this plan, are the
      authority.
- [ ] Update `docs/engine/LAYOUT.md` with `data-model="noveltea"` availability for document and
      Fragment Layouts, including the fact that model availability is context-wide and independent of
      system role.
- [ ] Update any built-in Layout audit/docs that still describe binder-owned generated controls.
- [ ] Update all active links/references to `SYSTEM_LAYOUT_RML_CONTRACT.md` to the new data-model
      contract filename; historical archive documents may retain historical references.

### Validation

- [ ] Add `tests/ui/runtime_ui_data_model_tests.cpp` to `noveltea_ui_tests` or
      `noveltea_ui_backend_tests` according to whether each test needs direct RmlUi API access; do not
      hide data-model coverage inside an unrelated test file.
- [x] By Phase 7, delete `tests/ui/rmlui_document_binder_tests.cpp` after its retained behavioral
      assertions have moved to data-model/integration tests, and rename
      `tests/ui/runtime_ui_binder_tests.cpp` to `tests/ui/runtime_ui_action_gateway_tests.cpp` with the
      production class rename. Update `tests/CMakeLists.txt` in the same phase.
- [ ] Run focused RmlUi data-model/unit tests.
- [ ] Run RuntimeUI lifecycle/integration tests.
- [ ] Run system Layout asset/contract tests.
- [ ] Run input-policy and typed-action regression tests.
- [ ] Run ActiveText custom-component/presenter/render tests.
- [ ] Run provisional Map tests.
- [ ] Run save/load shell tests including thumbnail refresh.
- [ ] Run Linux engine build and full CTest suite.
- [ ] Run Web build and `cxx-policy`.
- [ ] Run the Linux sandbox/runtime UI smoke for title, gameplay HUD, pause/settings, save/load,
      Text Log, and modal flows where the environment permits.
- [ ] Run focused Web/editor player smoke if current runtime UI behavior is exercised through the
      editor preview harness.
- [ ] Run `format-check` and `git diff --check`.

The minimum command-level final evidence is, sequentially and without overriding
`CMAKE_BUILD_PARALLEL_LEVEL`:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --build --preset linux-debug --target format-check

cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset web-debug --target cxx-policy

git diff --check
```

If a configured build already exists and the phase only needs a focused test loop, agents may run
the relevant `noveltea_ui_tests` / `noveltea_ui_backend_tests` Catch2 cases first, but the final phase
must still produce the full evidence above.

### Archival

- [ ] Confirm permanent docs describe implemented behavior rather than future intent.
- [ ] Confirm no active documentation treats system-role binder slots as the current authoring
      contract.
- [ ] Move this completed plan to `docs/archive/plans/` and remove the active-plan link from
      `docs/ui/OVERVIEW.md`.

### Exit gate

- [ ] All validation required by the touched engine/UI surface passes or exact environment-limited
      commands are recorded.
- [ ] The active UI documentation has one coherent data-model/component architecture with no stale
      binder authority.

## Testing requirements by behavior

The implementation must include focused coverage for these invariants.

### Data model lifecycle

- model exists before a `data-model="noveltea"` document is parsed;
- strict model creation does not enable missing-variable tolerance;
- model is present in newly created lifecycle contexts;
- model variables update without reloading the document;
- document reload/context recreation displays the latest values immediately;
- unloading a document/context leaves no dangling projection/model pointers;
- project replacement/reset cannot make an older gameplay revision overwrite newer model state.
- rejected `apply_gameplay_ui_values()` and `prepare_gameplay_ui_values()` do not mutate projected
  state; only accepted apply/commit paths publish a new projection.
- clearing gameplay or shell state empties the corresponding arrays/scalars instead of leaving stale
  declarative UI values.

### Declarative rendering

- string escaping in `{{ ... }}` remains safe;
- `{{ 10 }}` and other expressions remain literal outside a `data-model` subtree and evaluate inside
  `data-model="noveltea"`;
- projected variables are read-only from RML assignment expressions;
- arrays add/remove/reorder correctly through `data-for`;
- `data-if` and disabled/class/attribute expressions converge after state changes;
- empty-state markup is authored rather than injected;
- no duplicate IDs are required for repeated data-driven controls.
- exact direction/kind/subject/save-slot tokens match this plan and have no compatibility aliases.
- Text Log `body_rml` escapes user text and is the only model field intentionally consumed with
  `data-rml`.

### Typed actions

- Scene/Dialogue choices reject stale and disabled IDs;
- Room navigation rejects stale/disabled exits;
- Room/inventory selection rejects hidden/disabled subjects;
- interaction verbs reject stale/disabled controls;
- Layout gameplay-admission policy still blocks disallowed data-model callbacks;
- Save/Load/settings/modal callbacks use the same shell command validation as Lua helpers;
- event capture preserves ordered delivery semantics.
- each exact model callback accepts/rejects the same request as its corresponding Lua helper from the
  same Layout event context.

### Multi-context behavior

- two documents in distinct lifecycle contexts can bind the same projection coherently;
- top-to-bottom input/context routing remains unchanged;
- data models do not merge contexts or alter plane/clock/input/owner/scale identity;
- a non-system mounted Layout can read opted-in model data, and model callbacks do not bypass the
  typed action/admission path used by the equivalent existing Lua helper.

Data visibility and command authority are separate concerns: exposing a read-only UI projection in a
context must not grant gameplay/shell mutation authority beyond the existing typed action/admission
gateways.

## Explicit non-goals

- Do not redesign the final Map component in this refactor.
- Do not implement the future Room-navigation source/target crossfade or add `presentation.*` fields
  here. If implementation discovers that the current refactor cannot be correct without that work,
  stop and record the blocker/update this plan rather than silently expanding scope. A future design
  must still avoid adding a second transition clock.
- Do not redesign ActiveText rendering, rich-text syntax, font resolution, or effect semantics.
- Do not introduce a generic arbitrary-runtime-object reflection layer into RmlUi.
- Do not expose raw compiled project/runtime/save JSON through the data model.
- Do not make the data model writable as a bypass around typed runtime/shell commands.
- Do not remove the existing authored Lua capability surface merely because RmlUi model callbacks
  become available.
- Do not add role-specific model names or alternate field sets. Every context creates the same
  `noveltea` state/callback schema; existing typed dispatch remains the mutation authority boundary.
- Do not preserve obsolete binder IDs/tags through compatibility aliases.

## Risks and implementation constraints

### Stable bound storage

RmlUi binds variables by pointer. Projection objects and vector containers must have stable object
addresses for as long as any context model references them. Update their contents in place; do not
bind pointers into temporary publication objects.

### Context-local type registration

Struct/array registration belongs to each RmlUi context's type register. A model working in the
primary context is insufficient evidence. Tests must exercise lazily created secondary contexts.

### Model callback authority

RmlUi data-model callbacks are an authoring convenience, not a new authority boundary. Every
gameplay/shell mutation must still pass through NovelTea's typed validation/admission paths.

### Dirtying strategy

Use `DirtyAllVariables()` on every live model handle after each coherent projection update in this
refactor. Do not introduce targeted dirty-variable bookkeeping in these phases; that is a later
profiling-driven optimization.

### Save thumbnails

The data model exposes a URL/availability signal only. Keep thumbnail byte ownership,
fingerprinting, and virtual-file publication in the native resource path.

### Rich Text in Text Log

Text Log becoming data-driven does not require solving a general RmlUi representation of NovelTea
rich text. This refactor uses the sanitized per-entry `body_rml` projection defined above; do not
replace it with structured runs or a new rich-text custom element inside this plan.

### Map deferral

Do not let the provisional Map exception keep the broad binder alive. Phase 6 introduces the one
narrow tag-based Map updater specified there and no broader Map architecture.

## Definition of Done

This refactor is complete only when all of the following are true:

- [ ] Every live RuntimeUI RmlUi context exposes the `noveltea` model before model-bound documents
      load.
- [ ] The data model remains private implementation state; no new application-facing RmlUi pointer,
      model constructor, or model handle API exists.
- [ ] Ordinary authored Layouts, including non-system Lua-mounted Layouts, can opt into the model.
- [ ] Built-in Title/Game HUD/Pause/Settings/Save/Load/Text Log/Modal documents use declarative RmlUi
      data binding for their ordinary dynamic content.
- [ ] Choices, navigation, actors, Room objects, inventory, interaction actions, settings, save/load,
      and Text Log are not generated/populated by native document binders.
- [ ] Text Log no longer depends on `nt-text-log`.
- [ ] ActiveText remains a specialized custom element with its existing renderer/input lifecycle.
- [ ] Map remains functional through an explicitly provisional focused custom-component path.
- [ ] `RuntimeUiDocumentBinder` is deleted.
- [ ] Remaining gameplay/shell action validation is shared between RmlUi data-model callbacks and Lua
      helpers.
- [ ] Old population IDs/tags are not retained as parallel compatibility contracts.
- [ ] Reload/context recreation/project replacement keep model state coherent and pointer-safe.
- [ ] Permanent UI/Layout docs describe the data-model architecture and current custom-component
      exceptions.
- [ ] Relevant Linux/Web/unit/integration/smoke/format validation is green or precisely recorded as
      environment-limited.

## Completion ledger

| Phase | Status | Completion evidence |
| --- | --- | --- |
| 0. Characterize current contract | Complete | Focused gameplay/shell binder characterization, independent typed-action rejection, ActiveText click/direct-render, provisional Map, Text Log, and shipped built-in feature-inventory coverage are green in `noveltea_ui_tests` and `noveltea_ui_backend_tests` (2026-08-08). |
| 1. Shared RmlUi data-model foundation | Complete | Private `noveltea` projection/model ownership, per-context fail-closed initialization, stable context-local handles, read-only state, shared validated callbacks, seeded-state/update propagation, and two-context headless binding coverage are implemented. The 2026-08-08 review corrected malformed Save/Load slot arguments being coercible to slot `0` and added exact model-callback/Lua-helper parity coverage for every Phase 1 callback plus no-dispatch malformed-slot regressions. Review validation passes `noveltea_ui_tests` (627 assertions/61 cases), `noveltea_ui_backend_tests` (1048 assertions/49 cases), full Linux build, Linux/Web `cxx-policy`, `format-check`, Web build, and sanitizer build/CTest (810/810); full Linux CTest passes 819/827 with the same eight X11-unavailable capture/dependent readback failures. |
| 2. Simple project and shell cutover | Complete | Title/Pause/Settings/Save/Load/Text Log/Modal built-ins opt into `noveltea` for Phase 2 scalar state and static shell callbacks; native title/settings/modal/status population is removed while Phase 4 Text Log and Phase 5 Save/Load generation remain scoped to their owning phases. Authored system replacement coverage proves model opt-in works without magic-ID injection. `noveltea_ui_tests` passes 627 assertions/61 cases and `noveltea_ui_backend_tests` passes 814 assertions/48 cases; Linux build passes; full Linux CTest has only the existing X11-unavailable capture/dependent-verifier environment failures; `format-check`, Web build, Web `cxx-policy`, and `git diff --check` pass (2026-08-08). |
| 3. Game HUD ordinary RML cutover | Complete | Built-in Game HUD title/notification, choices, compass exits, Room objects, inventory, interaction controls, group/dock visibility, pointer admission, and shell pause wiring are declarative `noveltea` bindings; the native `data-exit-id` traversal is removed and `RuntimeUiDocumentBinder` is reduced to ActiveText/Map snapshot delivery only. A focused ordinary non-system Layout renders the same gameplay collections, and built-in SDL navigation plus ActiveText integration remain green. Validation passes `noveltea_ui_tests` (633 assertions/61 cases), `noveltea_ui_backend_tests` (1055 assertions/49 cases), `format-check`, full Linux build, Web `cxx-policy`, full Web build, and `git diff --check` (2026-08-08). The Phase 3-5 review on 2026-08-08 reconfirmed this exit gate and commit boundary. |
| 4. Text Log data-model cutover | Complete | `gameplay.text_log.entries` now supplies ordered sequence/kind/speaker/text plus sanitized `body_rml`; the built-in Text Log authors its list, metadata, rich body, and empty state with `data-for`/`data-if`/`data-rml`; `nt-text-log`, its registry/snapshot/RML helpers, and the Phase 3 direct snapshot-delivery branch are removed while the reduced binder scaffolding for Phase 6 is retained. Focused Text Log integration passes 30 assertions/1 case; `noveltea_ui_tests` passes 636 assertions/61 cases and `noveltea_ui_backend_tests` passes 1068 assertions/48 cases; `format-check`, Linux build, Linux `cxx-policy`, Web configure/build, Web `cxx-policy`, and `git diff --check` pass. Full Linux CTest passes 818/826; the same eight X11-unavailable graphics capture/dependent verifier tests remain environment-limited (2026-08-08). The Phase 3-5 review on 2026-08-08 reconfirmed this exit gate and commit boundary. |
| 5. Save/Load list data-model cutover | Complete | Built-in Save/Load now author checkpoint summary, one shared `shell.save_slots` loop, thumbnail/missing-thumbnail state, Save autosave omission, empty-slot Load omission, and typed Save/Load callbacks declaratively. RuntimeUI retains only content-fingerprinted thumbnail virtual-file preparation and publishes the resulting logical URL; native slot subtree generation is removed. Focused integration proves final autosave/manual visibility, empty Load-action visibility, metadata, and a changed fingerprinted URL after thumbnail bytes change. `noveltea_ui_tests` passes 644 assertions/61 cases and `noveltea_ui_backend_tests` passes 1079 assertions/48 cases; `format-check`, full Linux build, Linux `cxx-policy`, Web configure/build, Web `cxx-policy`, and focused callback validation pass. Full Linux CTest initially passes 817/826 because `noveltea_mandatory_asset_matrix` transiently misses one threaded finalization in addition to the same eight X11-unavailable graphics capture/dependent verifier failures; the mandatory asset matrix passes immediately when rerun in isolation, leaving only the known eight environment-limited graphics tests (2026-08-08). The Phase 3-5 review on 2026-08-08 reconfirmed this exit gate and commit boundary; its full Linux CTest passes 818/826 with the mandatory asset matrix green and only the same eight X11-limited graphics tests failing. |
| 6. Isolate custom-component path | Complete | `RuntimeUiDocumentBinder` no longer delivers custom-component snapshots. RuntimeUI now owns focused tag-based delivery: ActiveText updates only the first `nt-active-text` in the active Game HUD and refreshes `ActiveTextPresenter`, while provisional Map updates only the first `nt-map-view` in Game HUD and Text Log system documents and only while a gameplay view exists. Focused lifecycle coverage proves arbitrary mounted component tags are untouched and Map is not reset after gameplay clear. `noveltea_ui_tests` passes 644 assertions/61 cases and `noveltea_ui_backend_tests` passes 1101 assertions/49 cases; `format-check`, full Linux build, Linux `cxx-policy`, full Web build, Web `cxx-policy`, and `git diff --check` pass. Full Linux CTest passes 819/827; the same eight X11-unavailable graphics capture/dependent verifier tests remain environment-limited (2026-08-08). |
| 7. Remove document binder/reconcile ownership | Complete | `RuntimeUiDocumentBinder` and its tests are deleted; the surviving revision/action/input/Lua owner is renamed atomically to `RuntimeUiActionGateway`, including RuntimeUI/data-model ownership, source classification, and focused test naming. RuntimeUI's remaining refresh helpers are narrowed to Game HUD Map and Text Log Map delivery, with ActiveText and thumbnail preparation already independently named. Repository scans find no production `RuntimeUiBinder`, document-binder, `bind_document()`, or ordinary magic-ID population lookup; the only `SetInnerRML()` calls left are the Phase 6-approved provisional `nt-map-view` implementation. `noveltea_ui_tests` passes 634 assertions/59 cases and `noveltea_ui_backend_tests` passes 1101 assertions/49 cases; `format-check`, full Linux build, Linux `cxx-policy`, full Web build, Web `cxx-policy`, and `git diff --check` pass. Full Linux CTest passes 817/825; the same eight X11-unavailable graphics capture/dependent verifier tests remain environment-limited (2026-08-08). No Phase 8 implementation or scope change was required. |
| 8. Documentation, validation, archival | Not started | - |
