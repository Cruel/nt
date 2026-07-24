# Project Validation Diagnostic Matrix

## Purpose

This matrix is the permanent inventory for project diagnostics that participate in authoring Save,
Play, runtime-package publication, or platform export. Display messages and categories are not part
of readiness classification. A diagnostic is classified only by its stable `code`, canonical JSON
pointer `path`, `ownerPaths`, severity, and normalized `boundaries`.

Boundary rules:

- `authoring` errors are authoring-content blockers. Warnings never block.
- `runtime-package` errors block Play and `.ntpkg`; every runtime-package boundary also implies
  `platform-export`.
- `platform-export` errors block only platform export.
- Boundary-specific filtering is enforced by the shared readiness and save coordinators.
- Unless a row says otherwise, `ownerPaths` contains the diagnostic's canonical `path`.

Generated authoring codes never use the message. They use the producer, normalized category, and a
canonical path rule. Dynamic record IDs become `record`, array indices become `item`, and localized
locale keys become `locale`. Thus messages may be translated without changing code identity.

## Authoring Schema and Project-Wide Validation

| Code or code family | Producer | Severity | Canonical path / owner paths | Authoring Save | Play / `.ntpkg` | Platform export | Target scope and permitted fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `authoring.schema.<zod-issue-code>` | `authoring-validation.ts` structural parse | error | Zod issue pointer | blocks | blocks | blocks | Whole project structure. No fallback. |
| `authoring.schema.unsupported` | `editor-tool-service.ts` open boundary | error | `/schema` | blocks | blocks | blocks | Unsupported authoring schema. No fallback. |
| `authoring.entrypoint.missing` | `authoring-validation.ts` | warning | `/entrypoint` | no | no | no | Project-wide guidance. Compiler still requires an entrypoint for publication; no authored fallback. |
| `authoring.entrypoint.target-missing` | `authoring-validation.ts` | error | `/entrypoint` | blocks | blocks | blocks | Missing Room, Scene, or Dialogue entrypoint target. No fallback. |
| `authoring.record.id.invalid` | `authoring-validation.ts` | error | `/<collection>/<record-id>` | blocks | blocks | blocks | Record identity. No fallback. |
| `authoring.record.id.key-mismatch` | `authoring-validation.ts` | error | `/<collection>/<record-id>/id` | blocks | blocks | blocks | Record identity. No fallback. |
| `authoring.record.label.required` | `authoring-validation.ts` | error | `/<collection>/<record-id>/label` | blocks | blocks | blocks | Record label. No fallback. |
| `authoring.project.validation.<canonical-path-rule>` | `authoring-validation.ts` project-wide checks | error or warning | `/entrypoint`, `/properties/**`, `/<collection>/**`, `/editor/recordMetadata/**` | error blocks | runtime-classified error blocks; `/editor/**` does not | runtime-classified error blocks | Extends cycles/targets, property ownership/value compatibility, metadata ownership, IDs, labels, and cross-record references. `/editor/**` is authoring-only. No content fallback. |
| `authoring.assets.<canonical-path-rule>` | `authoring-validation.ts` asset checks | error or warning | `/assets/<record-id>/data/**` | error blocks | error blocks | error blocks | Asset metadata, safe source paths, aliases, duplicate aliases. No fallback for errors. |

## Typed Project Settings

| Code or code family | Producer | Severity | Canonical path / owner paths | Authoring Save | Play / `.ntpkg` | Platform export | Target scope and permitted fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `authoring.settings.schema.<zod-issue-code>` | `validateTypedProjectSettings` | error | `/settings/**` | blocks | blocks except application/platform-only paths | blocks | Structural typed-settings error. No fallback in authoring data. |
| `authoring.project.name.required` | `validateTypedProjectSettings` | error | `/project/name` | blocks | does not block by boundary | blocks | Common application identity. Later runtime generation may use `[Unnamed Project]` without mutating authoring content. |
| `authoring.project.version.required` | `validateTypedProjectSettings` | error | `/project/version` | blocks | does not block by boundary | blocks | Common application identity. Later runtime generation may use `0.0.0` without mutating authoring content. |
| `authoring.project.version.semver-recommended` | `validateTypedProjectSettings` | warning | `/project/version` | no | no | no | Identity quality warning. Authored value is retained. |
| `authoring.settings.asset.missing` | `validateTypedProjectSettings` | error | Referencing settings path plus `/$ref` | blocks | runtime settings references block; app-only references do not | blocks | Missing font, title image, app icon, or launch image. No fallback unless a later generated-artifact policy explicitly supplies one. |
| `authoring.settings.asset.kind-mismatch` | `validateTypedProjectSettings` | error | Referencing settings path plus `/$ref` | blocks | runtime settings references block; app-only references do not | blocks | Referenced asset has the wrong kind. No fallback. |
| `authoring.settings.ui.system-layout.missing` | `validateTypedProjectSettings` | error | `/settings/ui/systemLayouts/<role>/$ref` | blocks | blocks | blocks | Runtime UI layout role. No fallback. |
| `authoring.settings.presentation.<category>.<canonical-path-rule>` | Room transition validator adapted by `validateTypedProjectSettings` | error or warning | `/settings/presentation/roomNavigationTransition/**` | error blocks | error blocks | error blocks | Runtime presentation transition. No fallback. |
| `authoring.settings.app.locale.invalid` | `validateTypedProjectSettings` | error | `/settings/app/defaultLocale` or `/settings/app/localized/<locale>` | blocks | does not block by boundary | blocks | Platform/common identity localization. No fallback. |
| `authoring.settings.app.locale.not-normalized` | `validateTypedProjectSettings` | warning | `/settings/app/localized/<locale>` | no | no | no | Platform localization warning. Normalized suggestion only. |
| `authoring.settings.app.application-id.changed-after-export` | `validateTypedProjectSettings` | warning | `/settings/app/applicationId` | no | no | no, but later requires confirmation | Export identity migration warning. Authored value is retained. |
| `authoring.settings.app.save-namespace.changed-after-export` | `validateTypedProjectSettings` | warning | `/settings/app/saveNamespace` | no | no | no, but later requires confirmation | Save-data namespace migration warning. Authored value is retained. |

## Record-Family Semantic Validators

Each row below is a complete code family produced by the named validator. The concrete code is
`authoring.<normalized-category>.<canonical-path-rule>`; it is stable for a validation rule across
record IDs and localized messages.

| Code family | Producer | Severity | Canonical path / owner paths | Authoring Save | Play / `.ntpkg` | Platform export | Target scope and permitted fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `authoring.layouts.<canonical-path-rule>` | `authoring-layouts.ts` | error or warning | `/layouts/<record-id>/data/**`, `/settings/ui/**` | error blocks | error blocks | error blocks | RML/RCSS/Lua sources, dependency references, UI role shape. Warnings may describe non-fatal source/dependency quality. |
| `authoring.variables.<canonical-path-rule>` | `authoring-variables.ts` | error or warning | `/variables/<record-id>/data/**` | error blocks | error blocks | error blocks | Variable type/default/enum consistency. No error fallback. |
| `authoring.shaders.<canonical-path-rule>` | `authoring-shaders.ts` | error or warning | `/shaders/<record-id>/data/**` | error blocks | error blocks | error blocks | Shader stages, uniforms, samplers, roles, compiled paths. No error fallback. |
| `authoring.materials.<canonical-path-rule>` | `authoring-materials.ts` | error or warning | `/materials/<record-id>/data/**` | error blocks | error blocks | error blocks | Material inheritance, shader references, uniforms, textures. No error fallback. |
| `authoring.characters.<canonical-path-rule>` | `authoring-characters.ts` | error or warning | `/characters/<record-id>/data/**` | error blocks | error blocks | error blocks | Pose/expression/idle IDs, defaults, sprites, materials, preview selection. Preview-only warnings may fall back to no preview sprite. |
| `authoring.rooms.<canonical-path-rule>` | `authoring-rooms.ts` | error or warning | `/rooms/<record-id>/data/**` | error blocks | error blocks | error blocks | Room background, cast, props, placements, exits, transitions, effects. Empty-description and visual-quality warnings permit runtime continuation. |
| `authoring.interactables.<canonical-path-rule>` | `authoring-interactables.ts` | error or warning | `/interactables/<record-id>/data/**` | error blocks | error blocks | error blocks | Interaction subjects, visuals, and references. No error fallback. |
| `authoring.interactions.<canonical-path-rule>` | `authoring-interactions.ts` and interaction-program validation | error or warning | `/interactions/**`, `/verbs/**/defaultProgram/**` | error blocks | error blocks | error blocks | Rules, instructions, operands, variable values, targets. No error fallback. |
| `authoring.dialogues.<canonical-path-rule>` | `authoring-dialogues.ts` | error or warning | `/dialogues/<record-id>/data/**` | error blocks | error blocks | error blocks | Blocks, segments, edges, redirect targets, references, completion mode. No error fallback. |
| `authoring.scenes.<canonical-path-rule>` | `authoring-scenes.ts` | error or warning | `/scenes/<record-id>/data/**` | error blocks | error blocks | error blocks | Steps, branches, choices, presentation references, continuation. No error fallback. |
| `authoring.maps.<canonical-path-rule>` | `authoring-maps.ts` | error or warning | `/maps/<record-id>/data/**` | error blocks | error blocks | error blocks | Locations, connections, room targets, IDs. No error fallback. |
| `authoring.scripts.<canonical-path-rule>` | `authoring-script-modules.ts` | error or warning | `/scripts/<record-id>/data/**` | error blocks | error blocks | error blocks | Script module source shape. No error fallback. |
| `authoring.tests.<canonical-path-rule>` | `authoring-tests.ts` | error or warning | `/tests/<record-id>/data/**` | error blocks | does not block by boundary | does not block by boundary | Editor playback-test content only. No runtime-package fallback is needed because tests are excluded from gameplay publication. |
| `authoring.verbs.<canonical-path-rule>` | `authoring-validation.ts` verb checks | error or warning | `/verbs/<record-id>/data/**` | error blocks | error blocks | error blocks | Verb availability and default interaction program. No error fallback. |

## Authoring Compiler and Compiled Publication

Compiler diagnostics have explicit codes before entering `project-validation.ts`. Diagnostics
adapted from authoring validation retain the boundary classification of their authoring path;
compiler-native normalization, linking, lowering, resource-closure, and wire errors are authoring
plus runtime-package blockers and therefore also platform-export blockers.

| Code or code family | Producer | Severity | Canonical path / owner paths | Authoring Save | Play / `.ntpkg` | Platform export | Target scope and permitted fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AUTHORING_SCHEMA_<ZOD_CODE>` | compiler normalize stage | error | Authoring issue pointer | no separate Save decision; corresponding authoring schema error blocks | blocks | blocks | Structural compiler input. No fallback. |
| `AUTHORING_<NORMALIZED_PROJECT_VALIDATION_CODE>` | compiler semantic stage | error or warning | Original authoring pointer | underlying authoring error blocks | blocks only when the underlying authoring boundary includes runtime-package | blocks when the underlying authoring boundary includes platform-export | Preserves the project diagnostic rule. No error fallback. |
| `AUTHORING_LINK_MISSING_TARGET` | compiler link stage | error | Reference usage pointer | no separate Save decision | blocks | blocks | Missing linked symbol. No fallback. |
| `runtime-package.entrypoint.required` | `buildCompiledRuntimeExport` readiness composition | error | `/entrypoint` | no separate Save decision | blocks | blocks | Explicit project-derived runtime-package readiness blocker used consistently by Play and `.ntpkg`; no fallback. |
| `COMPILER_ENTRYPOINT_REQUIRED` | shared lowering | error | `/entrypoint` | no separate Save decision | blocks | blocks | Executable entrypoint required. No fallback. |
| `COMPILER_VALIDATED_DATA_MISSING` | shared lowering | error | Owning record data pointer | no separate Save decision | blocks | blocks | Internal validated-data precondition. No fallback. |
| `COMPILER_ROOM_DATA_MISSING` | room lowering | error | `/rooms/<record-id>/data` | no separate Save decision | blocks | blocks | Room lowering precondition. No fallback. |
| `COMPILER_SCENE_DATA_MISSING` | scene lowering | error | `/scenes/<record-id>/data` | no separate Save decision | blocks | blocks | Scene lowering precondition. No fallback. |
| `COMPILER_DIALOGUE_DATA_MISSING` | dialogue lowering | error | `/dialogues/<record-id>/data` | no separate Save decision | blocks | blocks | Dialogue lowering precondition. No fallback. |
| `COMPILER_INTERACTION_DATA_MISSING` | interaction lowering | error | `/interactions/<record-id>/data` | no separate Save decision | blocks | blocks | Interaction lowering precondition. No fallback. |
| `COMPILER_VERB_DATA_MISSING` | interaction lowering | error | `/verbs/<record-id>/data` | no separate Save decision | blocks | blocks | Verb lowering precondition. No fallback. |
| `COMPILER_SCENE_TARGET_NOT_EXECUTABLE` | scene lowering | error | Scene step target pointer | no separate Save decision | blocks | blocks | Unsupported/non-executable scene target. No fallback. |
| `COMPILER_SCENE_POSE_MISSING` | scene lowering | error | Scene character pose pointer | no separate Save decision | blocks | blocks | Missing character pose. No fallback. |
| `COMPILER_SCENE_EXPRESSION_MISSING` | scene lowering | error | Scene character expression pointer | no separate Save decision | blocks | blocks | Missing character expression. No fallback. |
| `COMPILER_SCENE_DIALOGUE_BLOCK_MISSING` | scene lowering | error | Scene dialogue block pointer | no separate Save decision | blocks | blocks | Missing dialogue block. No fallback. |
| `COMPILER_SCENE_TRANSITION_GROUP_POSE_MISSING` | scene lowering | error | Transition-group pose pointer | no separate Save decision | blocks | blocks | Missing transition-group pose. No fallback. |
| `COMPILER_SCENE_TRANSITION_GROUP_EXPRESSION_MISSING` | scene lowering | error | Transition-group expression pointer | no separate Save decision | blocks | blocks | Missing transition-group expression. No fallback. |
| `COMPILER_RESOURCE_ASSET_MISSING` | compiler resource closure | error | `/resources/assets` | no separate Save decision | blocks | blocks | Missing compiled asset closure entry. No fallback. |
| `COMPILER_RESOURCE_LAYOUT_MISSING` | compiler resource closure | error | `/resources/layouts` | no separate Save decision | blocks | blocks | Missing compiled layout closure entry. No fallback. |
| `COMPILER_RESOURCE_SCRIPT_MISSING` | compiler resource closure | error | `/resources/scripts` | no separate Save decision | blocks | blocks | Missing compiled script closure entry. No fallback. |
| `COMPILED_WIRE_<ZOD_CODE>` | compiler wire validation | error | Compiled-project issue pointer | no | blocks | blocks | Invalid compiled wire artifact. No fallback. |
| `compiled_project.missing_field`, `compiled_project.type`, `compiled_project.unknown_field`, `compiled_project.unknown_value`, `compiled_project.unknown_variant`, `compiled_project.invalid_id`, `compiled_project.duplicate_id`, `compiled_project.invalid_number`, `compiled_project.unsupported_provisional_schema`, `compiled_project.unsupported_schema`, `compiled_project.unsupported_version`, `compiled_project.unresolved_reference`, `compiled_project.invalid_variable_declaration` | native compiled-project decoder/linker through `noveltea-editor-tool` | error | Native compiled-project JSON pointer | no | blocks | blocks | Native validation of the compiled wire artifact before publication. No fallback. |
| `compiled.duplicate_id`, `compiled.invalid_inheritance`, `compiled.invalid_model`, `domain.invalid_id`, `domain.invalid_diagnostic_code`, `domain.invalid_json_pointer`, `domain.invalid_source_location`, `domain.invalid_property_definition`, `domain.invalid_property_assignment`, `domain.invalid_property_override` | native compiled-project model construction through `noveltea-editor-tool` | error | Native compiled-project JSON pointer when available | no | blocks | blocks | Typed model and domain-invariant failures reached while decoding the compiled artifact. No fallback. |

## Shader, Material, Asset, and Runtime-Package Publication

| Code or code family | Producer | Severity | Canonical path / owner paths | Authoring Save | Play / `.ntpkg` | Platform export | Target scope and permitted fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `shader.material.shader.material.project.<canonical-path-rule>` | `shader-material-project.ts` | error or warning | `/shaders/**` or `/materials/**` | error blocks through authoring/runtime readiness | error blocks | error blocks | Shader/material runtime manifest conversion. No error fallback. |
| `invalid_variant`, `missing_shaderc`, `missing_bgfx_include`, `missing_source`, `source_read_failed`, `source_write_failed`, `compiler_failed` | native shader compiler through `noveltea-editor-tool` | error | Compiler path, output path, source path, or `/shaders` | no direct Save decision | blocks | blocks | Current native shader compilation failures. Stable native code is preserved; no fallback. |
| `cache_read_failed`, `cache_write_failed` | native shader compiler through `noveltea-editor-tool` | warning | Shader cache manifest path | no | no | no | Cache is ignored or rebuilt; warning is preserved with its stable native code. |
| `invalid_shader_id`, `invalid_material_id`, `invalid_json`, `invalid_schema`, `missing_required_field`, `invalid_field_type`, `unknown_shader_role`, `deferred_shader_role`, `invalid_shader_source_ref`, `invalid_compiled_binary_ref`, `invalid_uniform_declaration`, `invalid_uniform_value`, `invalid_sampler_declaration`, `invalid_texture_slot_name`, `invalid_texture_source`, `unsupported_sampler`, `unknown_input_binding`, `unsupported_blend_policy`, `unknown_shader_ref`, `undeclared_uniform`, `undeclared_sampler`, `incompatible_shader_role` | native shader/material project parser through `noveltea-editor-tool` | error or warning | Native shader/material JSON pointer | error blocks through authoring/runtime readiness | error blocks | error blocks | All current native material diagnostic codes. Warnings permit parsing to continue; errors have no fallback. |
| `shader.compile.shader.<canonical-path-rule>` | adapter for uncoded native shader diagnostics | error, warning, or info | Compiler path, output path, source path, or `/shaders` | no direct Save decision | error blocks | error blocks | Deterministic fallback code based on producer/category/path, never message. |
| `runtime-export.shader-command.<category>.<canonical-path-rule>` | package workflow command application | error or warning | Command-owned shader path | no direct Save decision | error blocks | error blocks | Failure applying compiled outputs. No fallback. |
| Native package/asset publication code, when supplied | `noveltea-editor-tool` through `editor-tool-service.ts` | error, warning, or info | Native package/asset path | no | error blocks | error blocks | Stable native code is preserved. No error fallback. |
| `export.asset_read_failed` | native compiled-export certification | error | Requested package entry path | no | blocks | blocks | Source asset could not be read. No fallback. |
| `runtime.lua_initialization_failed` | native compiled-export certification | error | Failing Lua chunk path | no | blocks | blocks | Runtime scripting environment could not initialize. No fallback. |
| `runtime_package.checksum_mismatch`, `runtime_package.duplicate`, `runtime_package.duplicate_asset_alias`, `runtime_package.duplicate_entry`, `runtime_package.duplicate_material`, `runtime_package.duplicate_shader`, `runtime_package.identity_mismatch`, `runtime_package.incomplete_material_variant`, `runtime_package.inconsistent_platform`, `runtime_package.invalid_asset_path`, `runtime_package.invalid_checksum`, `runtime_package.invalid_path`, `runtime_package.missing_asset`, `runtime_package.missing_checksum`, `runtime_package.missing_entry`, `runtime_package.missing_field`, `runtime_package.missing_game`, `runtime_package.missing_gameplay_material`, `runtime_package.missing_shader_binary`, `runtime_package.missing_shader_manifest`, `runtime_package.orphan_checksum`, `runtime_package.runtime_shader_sources`, `runtime_package.shader_manifest_mismatch`, `runtime_package.size_mismatch`, `runtime_package.type`, `runtime_package.undeclared_entry`, `runtime_package.undeclared_shader_variant`, `runtime_package.unknown_field`, `runtime_package.unknown_shader_binding`, `runtime_package.unknown_value`, `runtime_package.unsafe_path`, `runtime_package.unstripped_shader_source`, `runtime_package.unsupported_schema`, `runtime_package.unsupported_version` | native runtime-package decoder/assembler during compiled-export certification | error | Runtime manifest, entry, resource, shader, or material pointer | no | blocks | blocks | The package assembled from the current compiled artifact is not internally loadable. No fallback. |
| `shader_material.<native-material-code>` | native runtime-package shader/material decoder during compiled-export certification | error | Shader/material manifest pointer | no | blocks | blocks | Uses the complete native material-code set listed above with a `shader_material.` prefix. No fallback. |
| `runtime.lua_certification_failed`, `execution.invalid_entrypoint`, `runtime.presentation_identity_exhausted`, `runtime.duplicate_variable`, `runtime.invalid_interactable_location`, `runtime.invalid_character_location` | native running-game construction during compiled-export certification | error | Script chunk or owning compiled-project path when available | no | blocks | blocks | Headless runtime certification could not construct a valid initial game. No fallback. |
| `package.publication.<category>.<canonical-path-rule>` | adapter for uncoded package/asset diagnostics | error, warning, or info | Native package/asset path | no | error blocks | error blocks | Deterministic fallback code based on producer/category/path, never message. |

## Platform Export Orchestration, Deployment, and Staging

All rows in this section have only the `platform-export` boundary. They do not block authoring Save,
Play, or `.ntpkg` by contract.

| Code | Producer | Severity | Canonical path / owner paths | Target scope and permitted fallback |
| --- | --- | --- | --- | --- |
| `project-load-failed` | platform orchestration | error | Source load path or `/projectPath` | All platform targets. Reopen/fix the project; no fallback. |
| `invalid-request` | headless platform-staging CLI boundary | error | `/` | All platform targets. Correct the serialized staging request; no fallback. |
| `invalid-project` | platform orchestration | error | `/` | All platform targets. No fallback. |
| `profile-missing` | platform orchestration | error | `/profileId` | Selected target profile. Select/create a profile. |
| `icon-missing` | platform orchestration | error | `/settings/app/icon` | Playable platform export. No platform artifact fallback. |
| `android-signing-configuration-invalid` | platform orchestration/signing | error | `/localState/signing` | Android signed release. Correct secret references; no fallback. |
| `export-cancelled` | orchestration/Android export | warning | `/` | Selected target. Cancellation is non-fatal and publishes nothing. |
| `invalid-app-identity` | `platform-deployment.ts` | error | `/identity/applicationId` or `/identity/displayName` | Selected target. No fallback. |
| `missing-icon` | deployment/staging | error | `/iconSourcePath` | Selected target. No fallback. |
| `runtime-package-evidence-invalid` | platform staging | error | `/runtimePackageEvidence` | Selected target. Supply concrete current-revision source and package fingerprints. |
| `runtime-package-fingerprint-stale` | platform orchestration | error | `/preparedRuntimeExport/sourceFingerprint`; owners also include `/project` | Selected target. Rebuild readiness for the current working revision. |
| `runtime-package-fingerprint-mismatch` | platform staging | error | `/runtimePackageEvidence/packageSha256` | Selected target. The staged package bytes must match the package verified by readiness. |
| `invalid-installed-template` | platform staging | error | `/templateToken` | Selected target. Reinstall/select a verified template. |
| `missing-package` | platform staging | error | `/packagePath` | Selected target. No fallback. |
| `missing-template-dependency` | platform staging | error | Template dependency path | Selected target. Use a complete template. |
| `sandbox-content` | platform staging | error | Staged path | Selected target. Remove unsafe staged content. |
| `insufficient-disk-space` | platform staging | error | Output/staging path | Selected target. Free space or choose another output. |
| `staging-failed` | platform staging | error | `/` or failing staging path | Selected target. No fallback. |
| `cancelled` | platform staging | warning | `/` | Selected target. Cancellation publishes nothing. |

## Template Compatibility

All template codes are errors at a failed resolve/install boundary and warnings when returned as
non-selected compatibility guidance. Owner paths are the descriptor/requirement paths shown.

| Code | Canonical path | Target scope and permitted fallback |
| --- | --- | --- |
| `template-install-failed` | `/archive` | Template installation. Correct or replace the archive; no installation fallback. |
| `template-corrupted` | `/template` | Installed template registry. Reinstall or select a verified template. |
| `template-missing` | `/template` | Selected target. Install a matching template. |
| `template-untrusted` | `/template` | Selected target. Warning only; explicit use of the locally installed template is permitted. |
| `template-platform-mismatch` | `/platform` | Selected target; choose a matching template. |
| `template-architecture-mismatch` | `/architecture` | Selected target architecture; choose a matching template. |
| `template-flavor-mismatch` | `/buildFlavor` | Debug/release flavor; choose a matching template. |
| `template-package-access-mismatch` | `/packageAccessModes` | Package access mode; choose a compatible template/profile. |
| `template-runtime-package-api-mismatch` | `/runtimePackageApi` | Runtime package API; choose/rebuild a compatible template. |
| `template-player-config-api-mismatch` | `/playerConfigApi` | Player config API; choose/rebuild a compatible template. |
| `template-shader-variant-mismatch` | `/shaderVariants` | Required shader variant; choose/rebuild a compatible template. |
| `template-renderer-mismatch` | `/graphicsBackends` | Graphics backend; choose/rebuild a compatible template. |
| `template-capability-mismatch` | `/capabilities` | Requested capability; remove it or choose a compatible template. |
| `template-feature-mismatch` | `/compiledFeatures` | Required compiled feature; choose/rebuild a template. |
| `template-web-threading-mismatch` | `/compiledFeatures` | Web threading mode; choose the matching Web template/profile. |
| `template-android-contract-missing` | `/android` | Android target; choose a valid Android template. |
| `template-android-abi-mismatch` | `/android/supportedAbis` | Android ABI; choose a compatible template/profile. |
| `template-android-artifact-mismatch` | `/android/artifactKinds` | APK/AAB selection; choose a compatible template/profile. |
| `template-android-package-access-mismatch` | `/android/packageAccessModes` | Android package access; choose a compatible template/profile. |
| `template-android-sdk-mismatch` | `/android/minimumSdk` | Android minimum SDK; adjust profile or template. |
| `template-host-mismatch` | `/host/assembly` | Host platform; use a compatible build host/template. |
| `template-toolchain-missing` | `/host/tools` | Host toolchain; configure the required tool. |

## Target Path Portability and Icon Generation

All rows are platform-export-only. There is no fallback for path errors. Target-path diagnostics use
`/staging/targets/<escaped-target-path>` as their canonical path; collision diagnostics list every
colliding target in `ownerPaths`. Icon warnings permit export using generated normalization/padding;
icon errors block generation.

| Code | Producer | Severity | Canonical path / owner paths | Target scope and permitted fallback |
| --- | --- | --- | --- | --- |
| `absolute-path` | target path portability | error | `/staging/targets/<escaped-target-path>` | All target archives. No fallback. |
| `archive-traversal` | target path portability | error | `/staging/targets/<escaped-target-path>` | All target archives. No fallback. |
| `invalid-segment` | target path portability | error | `/staging/targets/<escaped-target-path>` | All target archives. No fallback. |
| `windows-invalid-name` | target path portability | error | `/staging/targets/<escaped-target-path>` | Windows-compatible outputs. No fallback. |
| `windows-reserved-name` | target path portability | error | `/staging/targets/<escaped-target-path>` | Windows-compatible outputs. No fallback. |
| `path-too-long` | target path portability | error | `/staging/targets/<escaped-target-path>` | Target-specific path limit. No fallback. |
| `case-collision` | target path portability | error | First colliding target; all colliding targets in `ownerPaths` | Case-insensitive targets. No fallback. |
| `unicode-collision` | target path portability | error | First colliding target; all colliding targets in `ownerPaths` | Unicode-normalizing targets. No fallback. |
| `unreadable-source` | icon generation | error | `/iconSourcePath` after staging adaptation | Selected target icon set. No fallback. |
| `missing-dimensions` | icon generation | error | `/iconSourcePath` after staging adaptation | Selected target icon set. No fallback. |
| `non-square-source` | icon generation | warning | `/iconSourcePath` after staging adaptation | Transparent padding is permitted. |
| `undersized-source` | icon generation | warning | `/iconSourcePath` after staging adaptation | Upscaling is permitted with warning. |
| `color-space-conversion` | icon generation | warning | `/iconSourcePath` after staging adaptation | Conversion to sRGB is permitted. |
| `missing-alpha` | icon generation | warning | `/iconSourcePath` after staging adaptation | Opaque adaptive foreground is permitted with warning. |
| `unsafe-icon-content` | icon generation | warning | `/iconSourcePath` after staging adaptation | Potential platform-mask clipping is permitted with warning. |

## Android Build and Artifact Inspection

All Android rows are platform-export-only errors except `android-signing-debug-profile`, which is a
warning. No artifact is published after an error.

| Code | Producer | Canonical path / owner paths | Target scope and permitted fallback |
| --- | --- | --- | --- |
| `android-export-failed` | Android export | `/android` or failing operation path | Android. No fallback. |
| `android-gradle-failed` | Android export | `/gradle` | Android. No fallback. |
| `android-signing-debug-profile` | Android export | `/localState/signing` | Android debug profile may use debug signing with warning. |
| `android-archive-unreadable` | artifact inspection | Artifact path | Android APK/AAB. No fallback. |
| `android-manifest-unreadable` | artifact inspection | Manifest path | Android APK/AAB. No fallback. |
| `android-package-id-mismatch` | artifact inspection | Manifest package path | Android identity. No fallback. |
| `android-version-mismatch` | artifact inspection | Manifest version path | Android identity. No fallback. |
| `android-sdk-mismatch` | artifact inspection | Manifest SDK path | Android SDK contract. No fallback. |
| `android-orientation-mismatch` | artifact inspection | Manifest orientation path | Android display contract. No fallback. |
| `android-backup-policy-mismatch` | artifact inspection | Manifest backup policy path | Android metadata. No fallback. |
| `android-game-classification-mismatch` | artifact inspection | Manifest category path | Android metadata. No fallback. |
| `android-permission-closure-mismatch` | artifact inspection | Manifest permissions path | Android capability closure. No fallback. |
| `android-feature-closure-mismatch` | artifact inspection | Manifest features path | Android capability closure. No fallback. |
| `android-component-closure-mismatch` | artifact inspection | Manifest components path | Android component closure. No fallback. |
| `android-bootstrap-assets-missing` | artifact inspection | Bootstrap assets path | Android runtime bootstrap. No fallback. |
| `android-package-checksum-mismatch` | artifact inspection | Packaged runtime path | Android package integrity. No fallback. |
| `android-aab-package-checksum-mismatch` | artifact inspection | AAB packaged runtime path | Android bundle integrity. No fallback. |
| `android-native-library-closure-mismatch` | artifact inspection | Native library path | Android ABI/runtime closure. No fallback. |
| `android-abi-closure-mismatch` | artifact inspection | ABI path | Android APK ABI closure. No fallback. |
| `android-aab-abi-closure-mismatch` | artifact inspection | ABI path | Android AAB ABI closure. No fallback. |
| `android-zip-alignment-mismatch` | artifact inspection | APK path | Android APK alignment. No fallback. |
| `android-artifact-size-limit` | artifact inspection | Artifact path | Android size policy. No fallback. |
| `android-debug-signature-missing` | artifact inspection | Signature path | Android debug artifact. No fallback. |
| `android-release-signature-missing` | artifact inspection | Signature path | Android release artifact. No fallback. |
| `android-release-signature-unexpected` | artifact inspection | Signature path | Android unsigned/release policy. No fallback. |
| `android-aab-signature-missing` | artifact inspection | AAB signature path | Android bundle signing. No fallback. |
| `android-aab-signature-unexpected` | artifact inspection | AAB signature path | Android bundle signing policy. No fallback. |
| `android-bundletool-verification-failed` | artifact inspection | AAB verification path | Android bundle verification. No fallback. |

## Platform Certification

Certification diagnostics are platform-export-only errors used by the permanent target matrix and
release certification. Their owner path is the report/evidence/check path emitted by
`platform-export-certification.ts`; none permits publication fallback.

`certification-report-invalid`, `certification-template-mismatch`,
`certification-package-api-unexercised`, `certification-player-config-api-unexercised`,
`certification-capability-unexercised`, `certification-graphics-backend-unexercised`,
`certification-shader-variant-unexercised`, `certification-compiled-feature-unexercised`,
`certification-package-access-unexercised`, `certification-artifact-unexercised`,
`certification-evidence-duplicate`, `certification-evidence-artifact-reused`,
`certification-evidence-target-mismatch`, `certification-evidence-missing`,
`certification-check-not-passed`, and `certification-host-gap`.

## Deduplication and Ordering Contract

`collectProjectValidationDiagnostics()` sorts by `code`, then `path`, followed by deterministic
tie-breakers. It deduplicates on exactly:

1. `code`;
2. `path`;
3. normalized `ownerPaths`;
4. severity;
5. normalized boundaries.

Message and category are intentionally absent from the key. This prevents localization or display
copy changes from altering readiness identity.
