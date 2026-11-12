# #607: Project-wide editor control audit and coverage gate

This is the closed-world inventory of the editor's visible control callbacks
following the immediate-native-field migrations in #603–#606. Its machine-readable
counterpart is `editor/scripts/editor-control-coverage.json`. Every `.tsx` module
under `editor/src/renderer/editors/` is inventoried, including nested property,
selection, list, preview and import controls, whether or not it contains a JSX
callback. The inventory currently covers **55 modules and 1,284 JSX callback
sites** (`onChange`, `onBlur`, `onClick`, `onValueChange`, custom semantic callbacks,
etc.). This count is a *source coverage* measure, not a claim that there are
1,284 distinct native mutations.

The gate is run by `pnpm -C editor exec vp run check:editor-control-coverage` and by
`pnpm -C editor run check` (through `check:types`). It fails for a new or removed
editor module, an added/renamed route-to-component binding, and any changed
set/count of JSX callbacks in a known module. The route inventory covers **34
registered editor types**.
Each affected control must be reviewed for its owner, projection, command,
Save semantics, and test before updating the manifest. A same-count replacement
is **not** mechanically detected: code review and the per-family regression
tests remain necessary. The gate does not prove a physical desktop frame-time
bound. No renderer-owned authoritative Project or second YAML writer was added.

## Contract classifications

- **N — Native field draft.** Editable fields with a stable JSON Pointer and
  logical Save owner use `useProjectField`/`ProjectField*` and synchronous
  overlays. Native acknowledgments, Undo, validation, persistence and Save
  barriers remain authoritative. Errors and conflict resolution remain visible.
- **S — Semantic transaction.** Stable-ID list changes, reference moves,
  discriminated variants, structural edits and exact Instance edits use the
  shared semantic planner/command. Local member fields are projected when
  independently editable; multi-owner changes are never broken into unsafe
  scalar patches or array-index identities.
- **F — Explicit form or source buffer.** A transient input or multi-field form
  changes only a local staging buffer until a deliberate Apply, Save, Create,
  rename-on-blur, import or transaction commit. It does not await native ack to
  display entered text. A form's pending command must still obey the Save barrier
  and session boundary. This classification does **not** authorize a direct
  native-acknowledgment-gated controlled value.
- **O — Non-content.** Search, selection, diagnostics, preview navigation,
  zoom, playback and external-generator parameter controls do not mutate
  authored Project state during input.

## Per-route and nested-component crosswalk

Paths with `<id>` denote an exact stable record or item ID, not array indexes.
Each row represents the named control family/group; the full JSX callback
manifest enumerates every contributing file, including children with zero
callbacks. `record:<collection>:<id>` is the logical Save unit unless noted.

| Routes/modules | Controls or groups and authoritative backing | Projection and commit boundary | Classification; regression evidence |
| --- | --- | --- | --- |
| Asset Detail (`assets/AssetEditor`) | Sampling `/assets/<id>/data/sampling`; Asset tag chips `/editor/recordMetadata/assets/<id>/tags` | N: `useProjectField`, native `addAtPath` for optional sampling, semantic `entity.updateMetadata` for tags plus registry. Alias rename/import and deletion are separate explicit commands | N/S/F; `asset-editor.test.tsx` (500/1,000-ms tag hold) |
| Asset Attachments (`assets/AssetAttachments`, `AssetEmbeddedMetadata`) | File paths, attachment-purpose, display names, sidecar metadata and preview | F/S: local relink/move/rename drafts; attachment purpose selection staged immediately across inspection/native acknowledgment with recoverable failure status; validated file transactions and typed attachment operations; inspection/preview is O. Do not turn a physical file or multi-asset operation into a field patch | F/S/O; `asset-attachments.test.ts`, `asset-editor.test.tsx` (500/1,000-ms purpose hold) |
| Asset Library (`assets/AssetLibraryEditor`, `AssetPreview`) | Search/filter, tag filters, browse/selection; inline rename | O for filters, F for staged rename followed by `entity.updateMetadata`, workflow for import/generation | O/F; `asset-library-editor.test.tsx` |
| Archetypes (`archetypes/ArchetypeEditor`) | Kind `/archetypes/<id>/data/instanceKind`, base `/archetypes/<id>/data/base`, inherited property and override configuration | N: immediate `useProjectField` with semantic `archetype.setKind`/`archetype.setBase` that atomically clear incompatible overrides; F: explicit configuration/Property Manager Apply | N/S/F; `archetype-editor.test.tsx` (500/1,000-ms hold), `archetype-semantics.test.ts` |
| Chapters (`project/ChaptersEditor`) | Existing chapter label and color `/editor/chapters/records/<id>/{label,color}`, chapter create/delete/assignment controls | N: `ProjectFieldInput` with `project.renameChapter`/`project.setChapterColor`; F/S: local create/assignment state until explicit structural command | N/F/S; `chapters-editor-buffering.test.tsx`, `project-chapters-operations.test.ts` |
| Tags (`project/TagsEditor`) | Registry color `/editor/tags/records/<key>/color`; unused-tag deletion | N: shared Project field plus `project.setTagColor` (creates missing registry entries); S: explicit unused-tag remove | N/S; `tags-editor-buffering.test.tsx`, `authoring-tags.test.ts` |
| Project Settings (`project/ProjectSettingsEditor`) | Project name, app, display, accessibility, audio, cursor, notices and individual selectors | N: narrow `/settings`, `/project`, `/entrypoint` and related owned paths via `useProjectField`/`ProjectField*`, with grouped semantic settings commands; F/S for resolution/asset/import dialogs and coordination | N/F/S; `project-settings-editor.test.tsx`, `native-field-drafts.test.tsx` |
| Localization (`localization/LocalizationEditor`) | `/localization` named messages, source, translations, usage notes, per-locale target, cue offsets, reconciliation and asset variants | F: uncontrolled local source/translation text held until blur; S: full target, locale, promotion/merge/demotion and reference rewrite transactions, with per-path Save ownership; O for filters. No controlled native-acknowledged textarea | F/S/O; `localization-editor.test.tsx`, `localization-message-operations.test.ts` |
| Platform export/workflow imports (`project/PlatformExportEditor`, `ComfyUiWorkflowImportDialog`) | Profiles, source files, validation and import options | F/S: locally staged settings until explicit Apply/import/export; export writes are not Project field keystrokes | F/O; `platform-export-contracts.test.ts`, `comfyui-workflow-import-service.test.ts` |
| Animation (`animations/AnimationEditor`, `MotionPlaybackEditor`) | `/animations/<id>` canvas/track metadata, clip values, local playback | N for scalar fields, S for stable-ID track/clip edits, O for player controls | N/S/O; `animation-editor.test.tsx` (500/1,000-ms hold) |
| Character (`characters/CharacterEditor`) | `/characters/<id>` scalar presentation, state, location, inventory, traits | N for scalar fields; S for coherent location/state and stable-ID inventory or reference transactions | N/S; `character-editor.test.tsx` |
| Room and nested composition (`rooms/*`) | `/rooms/<id>` metadata, exits, overlays, camera/visibility/material/condition properties and Room Composition Pane; `/interactableInstances/<id>` exact occurrences | N for ordinary text/selection; S for placement, exit IDs, instance owner moves, collections and gesture commits. `RoomSemanticInputs` / `RoomCollection*` are nested presenters, not separate Save owners | N/S/O; `room-editor.test.tsx`, `interactable-property-editors.test.tsx` |
| Interactable (`interactables/InteractableEditor`) | `/interactables/<id>` properties and traits; exact Instance fields with owner-resolved Save units | N for ordinary fields; S/F for Property Manager, nested definitions, exact Instance and graph-sensitive changes | N/S/F; `interactable-editor.test.tsx`, `interactable-property-editors.test.tsx` |
| Scene and shared Scene/Dialogue (`scenes/SceneEditor`, `scene-dialogue-fields`) | `/scenes/<id>` display/stage; stable-ID Event/track/terminal configuration | N for scalar/independent members; S for stable Event IDs, ordered timeline operations and referenced outcomes; O for scrub/preview | N/S/O; `scene-editor.test.tsx` and #604 audit below |
| Dialogue (`dialogues/DialogueEditor`, `DialogueGraph`) | `/dialogues/<id>` display and stage; stable-ID block, edge, media, cue and graph properties | N for independent fields; S for stable-ID membership, linked graph changes and semantic moves; O for graph viewport | N/S/O; `dialogue-editor.test.tsx`, #604 audit below |
| Test authoring (`tests/TestsEditor`, `TestSuiteEditor`) | `/tests/<id>` metadata, steps, assertions and run selection | N for independent fields; S for stable-ID step/expectation edits and structural test commits; O for run/diagnostics | N/S/O; `tests-editor.test.tsx`, #605 audit below |
| Interaction (`interactions/InteractionEditor`, `InteractionProgramEditor`, `SubjectSelectorEditor`) | `/interactions/<id>` typed rules, subjects and nested interaction program | N for independent values; S for typed rule/subject transitions and stable-ID arrays | N/S; `interaction-operations.test.ts`, #605 audit in the parent Save-unit documentation |
| Verb (`verbs/VerbEditor`) | `/verbs/<id>` labels, slot and interaction bindings | N for independent values; S for slot identity/ref changes and nested collections | N/S; `authoring-verbs.test.ts`, #605 audit in the parent Save-unit documentation |
| Layout/Map (`layouts/LayoutEditor`, `maps/MapEditor`) | `/layouts/<id>`, `/maps/<id>` scalar fields, geometry, nodes, locations | N for labels/scalars; S for stable-ID node/location changes and gestures, no positional-array native patches | N/S; `layout-editor.test.tsx`, `map-editor-buffering.test.tsx`, #606 audit below |
| Materials (`materials/MaterialEditor`, `MaterialsLibraryEditor`) | `/materials/<id>` sampler, shader path and parameter data | N for independent metadata; S/F for shader source, preset and compilation operations; O for list filters | N/S/F/O; `material-editor.test.tsx`, #606 audit below |
| Traits and Variables (`traits/TraitsEditor`, `variables/VariablesEditor`) | `/traits` and `/variables` entries, typed properties and IDs | F: form-local modal or Property Manager edits until Create/Apply; S: atomic entity rename, type and property-list operations | F/S; `traits-editor.test.tsx`, `variables-editor.test.tsx` |
| Scripts, raw JSON and source (`scripts/ScriptModuleEditor`, `raw-json/RawJsonEditor`, `source/*`) | Authored script/JSON or source-file text | F: local editor buffer and explicit Save/Apply; source-revision and compiler transactions retain their own lifecycle, no per-keystroke Project clone | F; `raw-json-editor.test.tsx`, `engine-shader-source-editor.test.tsx` |
| ComfyUI (`comfyui/*`) | Generator parameters, external workflows, generation instructions | F/O: local form and external service status; publication/import of produced assets is an explicit transaction | F/O; `comfyui-workflows-editor.test.tsx`, `comfyui-generation-service.test.ts` |
| Preview, utility and placeholder (`preview/*`, `utility/*`, `placeholder/*`) | Runtime controls, debugging, inspection, selection, saved test recorder, placeholder views | O: preview/selection does not change authored Project; F/S only for explicit recorder publish to Tests. Never treat runtime state as a Project field | O/F/S; `full-game-preview-editor.test.tsx`, `editor-registry.test.tsx` |

## Safety and acceptance invariants

1. **Synchronous presentation:** a controlled value changes in the same input
   event without waiting for `nativeProjectPatch`; a test may hold native
   acknowledgment 500/1,000 ms. A local-only source/form buffer also paints
   without native acknowledgment, but only its explicit commit is authored.
2. **Native authority:** one native ProjectSession working revision and one
   native patch/Save pipeline. Field commands are prepared from the latest
   acknowledged Project, with field-granular CAS; no full normalized Project
   replacement on a single keystroke.
3. **Owner and identity:** Save unit checks on every native field path;
   projected exact Instance fields must pass concrete Room/Definition ownership.
   IDs, graph refs, order, type variants and source-owned file operations remain
   semantic and atomic. Invalid raw input is recoverable and blocks its owner.
4. **Barriers and recovery:** Save/Undo/close/Use Disk wait for or resolve
   pending native fields; failures and concurrent changes do not silently
   discard drafts. Source, import and structural forms preserve their separate
   review, validation and publish boundaries.
5. **Future changes:** any JSX callback change must update the generated
   inventory **after** per-control classification, relevant 500/1,000-ms
   regression tests for controlled native inputs, and review of YAML source
   locality. A passing source snapshot is not a substitute for those tests.

## #607 focused automated evidence (2026-11-12)

- All field/ownership paths added here are covered in
  `project-field-identity-607.test.ts`: allowed exact paths reject mismatched
  Save owners; chapter/tag structural paths remain semantic-only.
- `asset-editor.test.tsx` covers 500/1,000-ms native holds for tag additions,
  optional image sampling and attachment-purpose selection; a native rejection
  persists across two views with explicit retry. `archetype-editor.test.tsx`,
  `chapters-editor-buffering.test.tsx`, and `tags-editor-buffering.test.tsx`
  cover 500/1,000-ms holds and native readback for independent fields.
- The control gate and its rejection test pass with 55 inventoried TSX modules,
  34 registered editor routes and 1,284 JSX callback sites. The complete
  editor `check` pipeline (format/lint/type/schema/coverage) passes without
  warnings or errors.
- The addon-backed full renderer suite was run on Linux x86_64 with Node
  24.16.0 and a native addon SHA-256 beginning
  `ec7b029a2e478a486aaec9f3bf3c26b24ca2`. Final verification passed:
  **310 test files / 2,352 tests passed**, 9 files / 94 tests skipped.
  An earlier full run had one `native-editor-session-controller.test.ts`
  source-transaction failure amid concurrent preview work; its standalone
  32-test rerun and the final full rerun both passed. This is automated
  evidence only, not physical interaction/packaged approval for #608/#609.

The host-specific physical next-frame target and human Feature Lab checks in
`PROJECT_SAVE_UNITS_AND_RECOVERY.md` are separate certification items and must
not be presented as passed merely because this source gate passes.
