# Retired TypeScript authoring test evidence — #521

The native production cutover **does not retain a TypeScript Workspace,
semantic compiler, Project validator, dependency graph, cache, or Node CLI
oracle**. Tests constructing those deleted classes would recreate a competing
authoring authority solely to make tests pass; they are retired with the
implementation. Their prior assertions remain available from Git history.

This is a replacement-evidence ledger, not a waiver of native behavior.
Current, independently executable native witnesses must pass before #521
closes. No category below may be treated as qualified based only on a mock.

| Superseded test suites (basename without `.test.ts`) | Production replacement / independent evidence |
| --- | --- |
| `active-project-session`, `project-file-service`, `project-creation-service`, `project-authoring-source-freshness-service` | `native-editor-project-open`, `native-editor-project-handoff`, `native-editor-project-create`, `native-editor-session-controller`, `native-dirty-recovery`, C++ `native_authoring_project_session` |
| `project-workspace-file-system`, `project-workspace-service`, `project-workspace-transactions`, `project-workspace-yaml-owners` | C++ `native_authoring_yaml`, `native_authoring_yaml_transaction`, `native_authoring_invalid_manifest`, `native_authoring_clean_cache_recovery`; `native-project-source-transactions` and `native-cli-project-lifecycle` |
| `project-workspace-character-interactable-yaml`, `project-workspace-dialogue-scene-yaml`, `project-workspace-layout-archetype-script-yaml`, `project-workspace-resource-yaml`, `project-workspace-room-map-yaml`, `project-workspace-test-yaml`, `project-workspace-verb-interaction-yaml`, `project-workspace-localization-yaml`, `project-workspace-comment-preservation` | C++ `native_authoring_structural_records`, `native_authoring_character_archetype`, `native_authoring_dialogue_scene`, `native_authoring_room_map`, `native_authoring_tests`, `native_authoring_localization`, `native_authoring_verb_interaction`, `native_authoring_yaml_transaction`; native installed CLI roundtrip and recorded comment Save behavior |
| `resident-project-workspace-session`, `authoring-cache`, `editor-runtime-cache-service`, `runtime-build-cache` | `native-resident-project-owner`, `native-editor-session-controller`, `native-editor-runtime-equivalence`, C++ `native_authoring_clean_cache_correctness`, installed CLI daemon restart/cancellation and exact cache certifications |
| `authoring-dependency-graph`, `authoring-graph-service`, `authoring-source-analysis`, `current-behavior-characterization` | C++ `native_authoring_semantic_graph`, `native_authoring_source_analysis`; `native-semantic-graph-queries`, `native-renderer-graph-runtime`, native Find Usages / rename / stale-reference regressions |
| `authoring-compiler`, `compile-project-command`, `compiled-artifact-publication`, `compiled-project-golden-corpus`, `runtime-artifact-adapter-conformance`, `runtime-artifact-preparation` | `native-editor-runtime-equivalence`, `native-cli-package`, C++ `native_authoring_working_preparation`, installed native Feature Lab / authored Tests / exact Runtime Package bytes, Web publication |
| `authoring-validation`, `authoring-validation-input-equivalence`, `editor-authoring-validation-service`, `decode-authoring-project` | C++ `native_authoring_project_validation`, `native_authoring_project_record_differential`, `native_authoring_invalid_manifest`, `native-schema-generation`, native editor/CLI real malformed-data and diagnostic regressions |
| `project-workspace-watcher-service`, `project-asset-file-transaction` | `native-editor-observer-watch-service`, `native-project-source-transactions`, `native-asset-staging`, C++ `native_authoring_yaml_transaction`, independent editor/CLI watcher and competing-writer certification |
| `noveltea-cli`, `portable-project-bundle`, `platform-export-acceptance-fixture-service`, `platform-export-canonical-integration` | `native-cli-application`, `native-cli-project-lifecycle`, `native-cli-package`, `native-cli-platform`; installed production public JSON contracts, portable import/export bytes, Web publication and source-drift negatives |
| `native-editor-legacy-authority-guard` | Executable all-root `native-production-closure.test.mjs`, `native-production-qualification.test.mjs` and the SHA-bound emitted production/installed CLI closure guard; no legacy constructor remains to invoke |
| `project-save-request`, `reference-index`, `test-playback-project` | Retired renderer-side Workspace ownership hints, TS reference index and Project-to-playback converter; replaced by the native YAML save-owner transaction tests, C++ `native_authoring_semantic_graph` and `native_authoring_tests`, plus `native-semantic-graph-queries`, `native-editor-test-readiness`, and installed CLI Tests playback |
| `comfyui-cli-catalog`, `comfyui-cli-run` | These injected the deleted TypeScript CLI application's Project authority; installed-native CLI ComfyUI catalog/verification/publication and rollback are covered by `certify-native-cli-comfyui-contracts.mjs`, `certify-native-cli-comfyui-race.mjs`, and production-mode certification |
| `native-project-session-parity`, `scoped-read-authority-yaml` | Comparisons against the physically removed TypeScript Workspace and resident validation cache; native C++ session and clean-disk reconciliation tests, native daemon restart/cancellation and editor/CLI two-way disk witness replace the legacy authority-oracle dependency |
| `authoring-runtime-content-contracts` | Whole-Project TypeScript semantic validator authority; native C++ room/scene/interaction/variable/Map and Project Validation contract tests and installed CLI Feature Lab fixture cover equivalent runtime-authoring constraints |
| `structural-command-persistence`, `authoring-graph-consumers` | Retired TypeScript semantic graph publication/synchronous mutation bridge; replacement coverage is `native-command-store`, `native-semantic-graph-queries`, `native-renderer-graph-runtime`, native transactional Save/Undo/Redo and semantic graph C++ certification |

The current-format Web fixture is checked in at
`tests/fixtures/native-platform-export-web/`; its asset materializer is a
**test-only** source writer that never parses a Project or participates in a
distributed runtime. Native CLI validation of the fixture and the actual
published Web archive are mandatory; neither may be replaced by a TS
Project reader or a green mock.

Retained Zod build-time schema/test helpers, UI edit-intent tests, player
runtime tests, and native integration tests are **not** covered by the above
retirement. They must remain working and be migrated to native Project
admission where their test setup formerly constructed a TS Workspace.
