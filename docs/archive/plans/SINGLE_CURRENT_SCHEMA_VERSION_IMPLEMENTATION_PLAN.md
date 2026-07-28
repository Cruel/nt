# Single Current Schema Version and Compatibility Elimination Implementation Plan

## Status

Complete and archived on 2026-07-28. Phases 1–8 are complete. Permanent certification is recorded at
`docs/architecture/certifications/SCHEMA_VERSION_POLICY_CERTIFICATION.md`.

This archived document is the complete implementation specification for removing pre-release schema
compatibility behavior from NovelTea. It is intentionally self-contained. An implementation agent
must not depend on the conversation that produced this plan or on archived plans to understand the
goal, the affected contracts, the required failure behavior, or the order of work.

The source inventory in this plan was reviewed on 2026-07-27. File contents may move before a phase
is implemented, so each phase begins with a narrow re-audit of the named symbols and call graph. A
moved symbol does not change the required contract.

Keep this plan under `docs/architecture/plans/` while implementation is active. After every phase is
complete, reconcile the stable policy into permanent documentation, archive the implementation
history, and remove this active plan from the normal documentation path.

## Product Context and Governing Decision

NovelTea is an unreleased engine and editor under active development. There is no installed user
base whose old project files, editor metadata, packages, preview messages, or cached state must
continue to load. Carrying old readers and alternate wire shapes at this stage adds branches,
weakens validation, expands test matrices, and encourages later work to build on accidental legacy
behavior.

Version tags are still required. They provide explicit contract identity and make future version
changes detectable. The governing decision is therefore:

> During pre-release development, every versioned schema, protocol, persisted state, package format,
> and generated manifest supports exactly its declared current version. A version change replaces
> the previous contract atomically across all producers, consumers, fixtures, tests, and development
> data. Normal readers reject or discard unsupported versions. Do not add migrations, upgrade
> decoders, missing-version defaults, legacy-field extraction, aliases, or alternate old shapes
> unless a separate importer is explicitly requested.

This policy applies equally when compatibility is hidden inside the same numeric version. A union of
an old and new representation, an optional field that exists only because older output omitted it,
or a decoder that silently fills a retired field is compatibility even when the outer version tag
does not change.

## Goal

At completion:

1. every normal NovelTea reader accepts one current version for its contract;
2. missing or unsupported version tags never select an older parser or default to an old version;
3. each current version has one canonical representation for every concept covered by this plan;
4. transient caches and editor-only state are discarded rather than upgraded when incompatible;
5. project, package, preview, and native wire payloads fail through their documented boundary rather
   than being silently repaired into another schema shape;
6. permanent repository instructions and automated checks make compatibility additions an explicit
   policy violation;
7. positive tests and checked-in fixtures contain only current shapes; old shapes remain only in
   focused negative rejection tests.

## How Implementation Agents Must Use This Plan

- Implement one numbered phase as one unit unless the task explicitly asks for more.
- Do not begin a phase until every dependency listed in its entry conditions is complete.
- Re-read `AGENTS.md`, `docs/OVERVIEW.md`, the relevant area overview, and the named permanent
  contract documents before editing code.
- Inspect `git status` before work. Do not overwrite unrelated staged or untracked work.
- Treat the canonical shapes and failure semantics in this document as decisions, not suggestions.
- Replace old positive fixtures; do not retain them as migration fixtures.
- Keep a minimal negative fixture for each retired version or shape so rejection stays intentional.
- Run focused tests first and the complete phase exit gate before marking a phase complete.
- Do not mark a phase complete when only producers or only consumers have changed.
- Do not introduce a temporary dual-read period. Temporary producer/consumer skew is permitted only
  inside the uncommitted implementation of a phase and must not survive its exit gate.

## Terminology

### Versioned contract

Any serialized or cross-process boundary with an explicit numeric version, schema tag containing a
version, protocol version, persisted-store version, package manifest version, or equivalent current
contract marker.

### Current version

The single version emitted and accepted by the repository after a phase completes. Different
contracts may have different current version numbers. “Single current version” means one accepted
version per contract, not one global NovelTea version.

### Compatibility behavior

Logic whose purpose is to accept, infer, upgrade, normalize, or preserve an earlier contract. This
includes:

- parsers for older numeric versions;
- a missing-version default to an older version;
- `migrate*`, `upgrade*`, or legacy extraction functions;
- old-field aliases;
- string-or-object, array-or-object, or renamed-field unions representing the same concept;
- defaults applied only because an earlier writer omitted a field;
- writing both old and new fields;
- preserving old browser-local or cached state across a version mismatch.

### Semantic optionality

An omission that is part of the current product model rather than support for old data. Examples
include an optional description, a nullable reference, or an authoring default intentionally chosen
by the current editor. Semantic optionality may remain, but every wire boundary must materialize any
field that its current canonical contract requires.

### Normal reader

The code path used to open projects, restore editor state, load packages, decode preview messages,
parse manifests, or consume runtime wire data. A future separately named conversion utility is not a
normal reader.

### Explicit importer

A separately invoked, separately tested conversion tool that reads an old format and writes a
current-format artifact. No importer is in scope for this plan.

## Scope

This plan covers both explicit multi-version readers and known same-version alternate shapes:

1. repository policy and automated enforcement;
2. ComfyUI workflow manifests;
3. embedded editor project metadata;
4. browser-local editor shell persistence;
5. the retired authoring field `settings.app.lastExportedIdentity`;
6. compiled-project and focused-preview image sampling;
7. authoring Shader compiled-output metadata;
8. runtime Shader compiled-output metadata and path identity;
9. runtime Shader roles and role-specific stage bindings;
10. current documentation, fixtures, package evidence, and repository-wide certification.

The final audit also re-verifies contracts that already appear current-only, including authoring
project V2, compiled project V2, runtime package manifest V2, player/bootstrap contracts, save state,
typed checkpoint bundles, runtime user settings, editor preview protocols, focused preview protocol,
Room preview V2, asset profiler telemetry, and platform-export contracts.

## Non-Goals and Preserved Behavior

The following must not be removed merely because they use the words “fallback,” “compatibility,” or
“version”:

- project/theme/system resource fallback;
- runtime non-failing preview swap behavior;
- RmlUi lifecycle `compatibility_group` behavior;
- explicit and possible Lua dependency handling;
- semantic defaults in the current authoring model;
- native revalidation of data received from the editor;
- version tags and unsupported-version diagnostics;
- current-only save/package rejection;
- enum repair explicitly documented for corrupt values inside the current authoring schema;
- source-to-runtime adapters that deliberately map different field names at different contracts.

This plan does not:

- add an old-project importer;
- support data produced by historical builds;
- preserve browser-local editor layout across incompatible store versions;
- change current version numbers solely to perform cleanup;
- redesign unrelated project validation, save-unit ownership, preview pooling, or package structure;
- require authoring fields to become mandatory when their current semantic model intentionally has a
  default. Instead, current wire producers materialize the value before crossing a strict boundary.

## Required Failure Semantics

Each boundary has one prescribed response to unsupported or malformed data. An implementation agent
must not choose a different recovery strategy locally.

| Boundary | Unsupported or malformed input | Required behavior |
| --- | --- | --- |
| Root authoring project | wrong/missing schema identity or version, unusable structural shape | fail project open through existing structural diagnostics; do not attempt migration |
| Embedded `/editor` metadata | metadata absent | create empty current editor metadata with the current content fingerprint; absence is not an error |
| Embedded `/editor` metadata | wrong/missing metadata schema identity or version, or malformed current top-level metadata | discard the entire editor metadata object, create empty current metadata, and emit the warning defined in Phase 3; project content still opens |
| Recovery entry inside otherwise valid current editor metadata | one malformed save-unit recovery entry | preserve existing per-entry isolation: ignore only that entry and emit the existing recovery warning |
| Browser-local shell session | persisted Zustand version mismatch or malformed state | discard the persisted shell session and initialize `shellSession: null`; no migration and no user-facing project diagnostic |
| ComfyUI workflow manifest | wrong/missing version or noncanonical shape | mark that workflow entry invalid through existing ComfyUI diagnostics; do not execute, copy, install, or silently repair it |
| Compiled project/package | wrong version or noncanonical resource | reject the complete compiled artifact/package through the existing decoder diagnostic path |
| Focused preview candidate | wrong protocol/schema or noncanonical resource | reject the candidate and preserve the last successfully committed preview |
| Shader/material runtime document | wrong schema or noncanonical Shader data | reject the complete candidate/document; do not partially accept alternate Shader records |
| Generated cache or compile output | incompatible metadata | discard or regenerate it; never migrate it |

## Current Repository Findings

The following findings are the reason this plan exists. They are current implementation facts, not
desired behavior.

| Contract | Current version marker | Compatibility presently accepted | Primary implementation surfaces | Target phase |
| --- | --- | --- | --- | --- |
| ComfyUI workflow manifest | `schemaVersion: 2` is emitted by built-ins | type is `1 | 2`; missing version becomes `1`; both versions parse; `outputNodeIds` is a fallback; unknown nested fields are ignored | `editor/src/shared/comfyui-workflows.ts`, ComfyUI import/library/services, built-in manifests and tests | 2 |
| Embedded editor project state | `noveltea.editor.project-state`, version `2` | complete V1 schema and `migrateEditorProjectStateV1ToV2()` | `editor/src/shared/project-schema/editor-project-state.ts`, project-open service and tests | 3 |
| Browser-local editor shell session | Zustand persistence version `2` | `migrate` converts root `shellWorkbench` into `shellSession` | `editor/src/renderer/workbench/local-editor-session-store.ts` | 3 |
| Platform export identity history | current owner is editor metadata V2 | project open extracts retired `settings.app.lastExportedIdentity`; content stripping silently deletes it | `editor-project-state.ts`, `editor-tool-service.ts`, settings and state tests | 3 |
| Compiled image resource | compiled project V2 | image `sampling` is optional in TypeScript and missing native values become `linear` | `compiled-project.ts`, authoring compiler lowering, native compiled-project codec/model, wire docs and tests | 4 |
| Focused-preview authoring asset resource | focused preview protocol V1 | image `sampling` is optional and native behavior treats omission as linear | `focused-preview-contracts.ts`, preview adapters/builders, native preview contracts/decoder/presenter | 4 |
| Authoring Shader compiled output | authoring project V2 | output is a path string or partially populated metadata object; strings and missing fingerprints are treated as fresh | `authoring-shaders.ts`, Shader commands/store/editor, export overlay and tests | 5 |
| Runtime Shader compiled output | `noveltea.shader-materials.v1` | compiled variant is a string or metadata object; metadata fields are optional; namespaced and namespace-less paths coexist | `shader-material-project.ts`, `material_codec.cpp`, `shader.hpp`, compiler/package fixtures and tests | 6 |
| Runtime Shader roles | `noveltea.shader-materials.v1` | `roles` is either an array or an object whose values also encode stage bindings | TypeScript runtime schema/builder, `material_codec.cpp`, Shader manifest/material tests and fixtures | 7 |

### Contracts Already Expected To Be Current-Only

These contracts are not scheduled for behavioral redesign. Phase 1 records them in the permanent
inventory and Phase 8 verifies that they still accept only their current version:

- authoring project V2 in `authoring-collections.ts`, `authoring-project.ts`, and
  `decode-authoring-project.ts`;
- compiled project V2 in `compiled-project.ts` and the native compiled-project decoder;
- runtime package manifest V2 in `compiled_package_codec.cpp`;
- player configuration and runtime package API V2 in `player_bootstrap.*`;
- save format V6 in `save_state.*` and its codec;
- typed checkpoint bundle V1 in `typed_save_slot_store.cpp`;
- runtime user settings V2 in `runtime_user_settings_codec.cpp`;
- editor preview, focused preview, Layout preview, and Shader preview protocol V1;
- Room preview V2;
- asset-profiler schema V3;
- Shader/material document V1 outer tag;
- current platform-export template, registry, request, and certification literals.

## Locked Canonical Contracts

The following decisions remove ambiguity from later phases. Do not substitute another shape without
updating this plan through explicit design review first.

### ComfyUI Workflow Manifest V2

- `COMFYUI_WORKFLOW_SCHEMA_VERSION` is `2 as const`.
- `ComfyUiWorkflowSchemaVersion` is `typeof COMFYUI_WORKFLOW_SCHEMA_VERSION`, not a union.
- `schemaVersion` is mandatory and must equal `2`.
- The manifest parser is strict for every manifest-owned object. Unknown top-level or nested manifest
  keys fail parsing.
- The top-level current fields are: `schemaVersion`, `id`, `label`, `provider`, `role`, optional
  `description`, `workflowFile`, `contract`, optional `requiredNodeClasses`, `bindings`,
  `outputBindings`, and `defaults`.
- `outputNodeIds` is not a current field and must be rejected even when valid `outputBindings` also
  exists.
- `contract.inputs.<semanticInput>` contains only `type`, `required`, optional `editorField`, and
  optional `defaultValue`. Manifest copies of role-catalog `minBindings` and `maxBindings` are
  invalid and must be removed from built-ins and writers.
- `contract.outputs.images` contains only `type`, `required`, and `primary`.
- `outputBindings.images` is mandatory for the two current roles and contains exactly one binding,
  because the current role catalog has `minBindings: 1` and `maxBindings: 1`.
- An image output binding contains only optional `nodeId`, optional `nodeTitle`, optional `classType`,
  required `valueType: "image-list"`, and required `primary: "first"`.
- At least one of `nodeId`, `nodeTitle`, or `classType` must be present.
- The currently unused `outputName` field and accidental output-binding `inputName` field are not
  part of the canonical contract and must be removed.
- Input binding selector fields remain current semantic selector hints; they are not legacy aliases.

### Embedded Editor Metadata V2

- The outer current schema remains `noveltea.editor.project-state`, version `2`.
- Only the existing strict V2 schema is accepted.
- Absence of `/editor` means no saved editor metadata and produces a fresh empty V2 state.
- A present but wrong-version, wrong-schema, or malformed top-level `/editor` object is discarded in
  full. No workbench, draft, export identity, or recovery data is salvaged from it.
- Unsupported version warning:
  - code: `editor.metadata.schema-version.unsupported`;
  - path and owner path: `/editor/schemaVersion`;
  - severity: `warning`;
  - message must state the received value and expected version `2`.
- Other invalid top-level metadata warning:
  - code: `editor.metadata.invalid`;
  - path and owner path: `/editor`;
  - severity: `warning`.
- Existing per-save-unit recovery isolation remains only after the top-level V2 state has validated.
- `stripEditorProjectState()` removes only the top-level `editor` property. It must not know about or
  strip retired content fields.
- `settings.app.lastExportedIdentity` is not accepted or extracted. Because current project/settings
  objects are strict, its presence is invalid current authoring content.

### Browser-Local Editor Session V2

- The persistence key remains `noveltea-editor-session` and the current store version remains `2`.
- The current stored payload contains `shellSession`, whose value is null or contains
  `projectFilePath` and `shellWorkbench`.
- The retired root-level `shellWorkbench` payload is unsupported.
- Remove the Zustand `migrate` callback. A version mismatch initializes the current store state and
  does not rewrite the old value into a current shape.

### Image Resources At Compiled and Preview Boundaries

The authoring Asset model remains optional for `sampling`, with current semantic default `linear`. Every
compiled or preview wire producer must materialize that default.

The compiled TypeScript resource shape is a strict discriminated union:

```ts
type CompiledAssetResource =
  | {
      id: string;
      kind: "image";
      path: string;
      aliases: string[];
      sampling: "linear" | "nearest";
    }
  | {
      id: string;
      kind: "font" | "audio" | "script" | "shader-source" | "text" | "data" | "binary";
      path: string;
      aliases: string[];
    };
```

The focused-preview authoring asset resource follows the same rule: image entries require
`sampling`; non-image entries forbid it. Shader-binary entries remain a distinct resource variant.

The native `compiled::AssetResource` uses `std::optional<ImageSampling> sampling` with this invariant:

- `kind == AssetKind::Image` if and only if `sampling.has_value()`;
- native decoding requires `sampling` for images;
- native decoding rejects `sampling` for non-images;
- downstream code may dereference sampling only after confirming image kind.

This internal optional is a type-level representation of a discriminated union, not compatibility.
There is no missing-image default at a wire boundary.

### Authoring Shader Compiled Output

The only persisted authoring representation for each stage/variant is:

```ts
interface ShaderCompiledOutput {
  path: `project:/shaders/bgfx/${string}`;
  byteHash: `sha256:${string}`;
  byteSize: number;
  compileInputFingerprint: `sha256:${string}`;
}
```

All four fields are required and the object is strict.

- A bare string is invalid.
- A partial metadata object is invalid.
- `path` must already be a canonical namespaced project logical path. Validation must not prepend
  `project:/` to a namespace-less path.
- `compileInputFingerprint` is the editor/authoring freshness fingerprint produced by
  `shaderCompileInputFingerprint()` from current authoring inputs.
- A missing or mismatched fingerprint is stale; it is never treated as fresh.
- Compiler cache identity is a different concept. The existing `cacheKey` remains the public compile
  cache identity. Remove the native `compileInputFingerprint` field from `ShaderCompileOutput`; it
  must not be exposed or copied under the authoring `compileInputFingerprint` name.

### Runtime Shader Compiled Output

The only runtime `noveltea.shader-materials.v1` representation for each compiled variant is:

```ts
interface RuntimeShaderCompiledOutput {
  runtimePath: `project:/${string}` | `system:/${string}`;
  byteHash: `sha256:${string}`;
  byteSize: number;
}
```

All fields are required and the object is strict.

- Runtime data does not contain the editor-only `compileInputFingerprint`.
- Project-compiled binaries use `project:/shaders/bgfx/<variant>/...`.
- Engine-provided binaries use `system:/shaders/bgfx/<variant>/...` when represented as runtime
  logical references.
- Namespace-less `shaders/bgfx/...` values are invalid runtime logical paths.
- Package file tables remain project-relative (`shaders/bgfx/...`) because they are a separate
  package-entry contract. Compiler code must keep filesystem/package-relative paths separate from
  logical runtime paths rather than using one string for both.
- The TypeScript authoring-to-runtime builder deliberately maps authoring `path` to runtime
  `runtimePath`. That explicit adapter is not an alias reader.

For decoded runtime documents, native `ShaderCompiledBinaryRef` retains `variant`, logical `path`,
`byte_hash`, and `byte_size`, all populated. It drops the generic string-only constructor and the
editor-only freshness fingerprint. Directly constructed trusted system Shaders must use a separately
named factory or type that requires a `system:/` path and makes the absence of package integrity
metadata explicit; they must not reuse a generic constructor that could also accept project wire
data.

### Runtime Shader Roles

Every runtime Shader definition contains both fields:

```ts
interface RuntimeShaderDefinition {
  // other current fields omitted here
  roles: ShaderRole[];
  role_bindings: Partial<
    Record<ShaderRole, { vertex?: string; fragment?: string }>
  >;
}
```

- `roles` is always an array and contains no duplicates.
- `role_bindings` is always an object; it is `{}` when there are no bindings.
- Every binding key must also appear in `roles`.
- Each binding object is strict and must contain at least one of `vertex` or `fragment`.
- There is at most one binding per role because the object is keyed by role.
- The old object-shaped `roles` field is invalid.
- The authoring builder emits declared roles and role bindings independently; it must not replace the
  role list with binding keys.
- Existing recognized/deferred role policy, including current `rmlui-filter` disposition, is not
  changed by this phase.

## Version-Change Procedure After This Plan

The permanent policy must state the exact process for any future pre-release version bump:

1. increment the single current version constant or schema tag;
2. update every producer and consumer in the same change;
3. replace checked-in fixtures and development data with the new current form;
4. update permanent contract documentation;
5. replace positive old-version tests with a focused rejection test;
6. do not retain the previous decoder, migration, field alias, or dual writer;
7. use a separately requested importer only when conversion itself is a product requirement.

## Implementation Phases

The phases are sequential. A phase is complete only when every required implementation item, focused
test, debt removal, and exit gate passes.

### Phase Completion Ledger

| Phase | Scope | Complete | Notes |
| --- | --- | --- | --- |
| 1 | Permanent policy, contract inventory, automated guardrail, and temporary debt baseline | [x] | Completed 2026-07-27. Added permanent policy/instructions, authoritative inventory, exact debt baseline, root/editor integration, and checker self-tests. |
| 2 | Strict ComfyUI workflow manifest V2-only cutover | [x] | Completed 2026-07-27. Exact-key V2 parser, canonical writers/manifests, negative rejection coverage, and debt removal. |
| 3 | Editor metadata V2-only, local session V2-only, and legacy export-identity removal | [x] | Completed and audited 2026-07-27. Embedded metadata, legacy export identity, and browser-local shell persistence now accept only strict current contracts, including malformed-current-state rejection. |
| 4 | Explicit image sampling across compiled-project and focused-preview boundaries | [x] | Completed and audited 2026-07-27. Compiled and focused-preview image resources require explicit sampling; all producers materialize the authoring default, TypeScript/native resource-kind discrimination is aligned, non-image resources reject the field, and Phase 4 debt is removed. |
| 5 | Canonical authoring Shader compiled-output metadata | [x] | Completed 2026-07-27. Authoring outputs are one strict complete metadata object; compile requests capture and reverify authoring fingerprints; public/native compiler responses no longer expose the authoring fingerprint; all compile/export/preview producers and policy debt are cut over. |
| 6 | Canonical runtime Shader compiled-output metadata and logical paths | [x] | Completed 2026-07-27 |
| 7 | Canonical runtime Shader roles and role bindings | [x] | Completed 2026-07-27. Runtime role membership and role-specific stage bindings are separate required fields across TypeScript/native producers, decoders, package validation, fixtures, and tests; retired object-shaped roles are rejected and Phase 7 debt is removed. |
| 8 | Repository audit, documentation reconciliation, full certification, and archival | [x] | Completed 2026-07-28. Expanded the inventory and evidence requirements, corrected final strict-reader defects, reconciled current documentation, recorded certification, and archived this plan. |

### Phase 1 — Permanent Policy, Contract Inventory, and Automated Guardrail

#### Purpose

Make the pre-release current-version-only decision visible before any cleanup begins, and install a
guardrail that can operate while known compatibility debt still exists.

#### Entry conditions

- Read root and architecture instructions.
- Confirm all findings in the “Current Repository Findings” table still exist or record their new
  locations.
- Do not remove compatibility behavior in this phase except documentation-only contradictions.

#### Primary implementation surfaces

- `AGENTS.md`
- new `docs/architecture/SCHEMA_VERSION_POLICY.md`
- `docs/architecture/OVERVIEW.md`
- `docs/OVERVIEW.md`
- current project/export/wire documentation that misstates active versions
- `CMakeLists.txt`
- `editor/package.json`
- `editor/vite.config.ts`
- new `cmake/CheckSchemaVersionPolicy.cmake`
- new `cmake/VerifySchemaVersionPolicyChecker.cmake`
- new `cmake/schema_version_policy/contracts.tsv`
- new `cmake/schema_version_policy/rules.tsv`
- new `cmake/schema_version_policy/exceptions.tsv`
- new `cmake/schema_version_policy/temporary_debt.tsv`
- new positive and negative checker fixtures under `cmake/schema_version_policy/fixtures/`

#### Permanent documentation requirements

1. Add the governing policy text from this plan to `AGENTS.md` in a concise mandatory section and
   link the detailed permanent policy.
2. Create `SCHEMA_VERSION_POLICY.md` containing:
   - product context;
   - definitions of current version, compatibility, semantic optionality, and importer;
   - failure semantics by boundary;
   - future version-change procedure;
   - the rule that same-version alternate shapes are compatibility;
   - instructions for updating the checker inventory.
3. Route the policy from architecture and top-level overviews.
4. Correct obvious current documentation contradictions immediately, including active documents
   that call the compiled project V1 when the code is V2.
5. Add a clearly visible supersession note to any still-active historical plan that explicitly
   required V1-to-V2 migration, including
   `docs/editor/plans/PROJECT_VALIDATION_BOUNDARIES_AND_SETTINGS_EDITING_IMPLEMENTATION_PLAN.md` if
   that file remains active. Do not change unrelated completion records in that plan.

#### Machine-readable inventory

`contracts.tsv` is authoritative for the repository’s versioned-contract inventory. It uses one
tab-separated record per contract with exactly these columns:

```text
contract_id	current_marker	current_version	owner	producer_paths	consumer_paths	unsupported_input_action
```

- path lists use semicolons;
- every path must exist;
- `contract_id` is stable and unique;
- `unsupported_input_action` is one of `reject`, `discard`, or `regenerate`;
- outer tags such as `noveltea.shader-materials.v1` use the complete tag as `current_marker` and `1`
  as `current_version`;
- update this file whenever a new versioned contract is introduced.

#### Guardrail design

The checker is supplemental static enforcement, not a claim that regex can prove arbitrary parser
semantics. Behavioral tests remain mandatory.

`rules.tsv` defines narrowly scoped forbidden compatibility patterns. Each record has:

```text
rule_id	path_prefixes	regular_expression	explanation
```

`exceptions.tsv` defines permanent, reviewed non-compatibility uses with:

```text
rule_id	path	expected_count	rationale
```

`temporary_debt.tsv` defines compatibility that this plan has not removed yet:

```text
rule_id	path	expected_count	removal_phase	rationale
```

Requirements:

1. paths are exact repository-relative files, never directory globs;
2. counts must match exactly;
3. stale, duplicate, malformed, or unmatched debt/exception records fail;
4. an unlisted rule match fails;
5. a new debt entry fails review unless it names an active removal phase in this plan;
6. Phase 8 requires `temporary_debt.tsv` to be empty except for its header;
7. generated/build/vendor/history trees are excluded: `.git/`, `build/`, `editor/dist-electron/`,
   `editor/out/`, `node_modules/`, `vcpkg_installed/`, `refs/`, `docs/archive/`, Android build output,
   and managed external worktrees;
8. production source, checked-in manifests, and nonnegative fixtures remain in scope;
9. code-oriented identifier rules do not scan documentation; Phase 8 performs explicit normative-doc
   searches so this implementation plan can describe the debt without becoming an exception;
10. negative rejection fixtures may contain old versions/shapes and are exempt only by exact file and
    count, not by excluding the entire test tree.

The initial rules and debt baseline must cover at least:

- multi-version schema types and old-version parser branches;
- missing-version defaults;
- functions or schemas named for migration, upgrade, downgrade, or legacy extraction in schema
  boundary code;
- `outputNodeIds` in ComfyUI production manifests/code;
- `editorProjectStateV1Schema` and `migrateEditorProjectStateV1ToV2`;
- local-session migration from root `shellWorkbench`;
- `legacyLastSuccessfulPlatformExportIdentity` and content stripping of
  `lastExportedIdentity`;
- string-or-object Shader compiled-output schemas and native branches;
- array-or-object Shader role schemas and native branches;
- optional image sampling at compiled/preview wire boundaries.

#### Build and CI integration

1. Add a root target named `noveltea-schema-version-policy`.
2. Add a CTest named `noveltea_schema_version_policy`.
3. Include the target in `cxx-policy`.
4. Add a Vite+ run task named `check:schema-version-policy:run` in `editor/vite.config.ts`. It invokes
   the root CMake policy script with the repository root passed explicitly, has caching disabled, and
   declares the checker/configuration files as inputs. The `:run` suffix is required because Vite+
   rejects a run task whose identifier conflicts with a same-named `package.json` script.
5. Add package script `check:schema-version-policy` as
   `vp run check:schema-version-policy:run`.
6. Add `check:schema-version-policy` to the `check:all` dependency list alongside `check:types`, so
   `pnpm -C editor run check` always executes it.
7. Follow existing CMake checker conventions used by JSON-boundary and module policy checks.
8. Add checker self-tests proving:
   - a clean fixture passes;
   - undocumented migration code fails;
   - a missing-version fallback fails;
   - an alternate string/object decoder fails;
   - a stale debt record fails;
   - an overbroad or wrong-count exception fails.

#### Focused verification

```sh
cmake -S . -B build/schema-policy-check -G Ninja -DNOVELTEA_BUILD_TESTS=ON
cmake --build build/schema-policy-check --target noveltea-schema-version-policy
ctest --test-dir build/schema-policy-check -R noveltea_schema_version_policy --output-on-failure
pnpm -C editor run check:schema-version-policy
```

#### Exit gate

- permanent instructions unambiguously prohibit pre-release compatibility;
- the current contract inventory is complete for all known versioned boundaries;
- every known compatibility finding is represented by exact temporary debt;
- new unlisted compatibility patterns fail both root and editor policy checks;
- checker positive and negative fixtures pass;
- no runtime compatibility behavior has been removed yet.

#### Phase 1 implementation record (2026-07-27)

- The current repository findings remained present at their documented locations. No runtime or
  editor compatibility behavior was removed.
- The machine-readable baseline must include current positive tests and checked-in manifests that
  still exercise retired shapes, not only production readers. This is necessary because the checker
  deliberately scans nonnegative fixtures. Phase 2 and Phase 3 must remove or replace the associated
  exact debt records when those fixtures are cut over.
- `rules.tsv` uses comma-separated path prefixes. CMake treats unescaped semicolons as list
  separators while reading TSV records, so semicolon-separated rule prefixes cannot be represented
  reliably by the checker without a second escaping convention. This does not affect
  `contracts.tsv`, whose producer and consumer path-list contract remains semicolon-separated; its
  current entries each use one producer and one consumer path.
- Vite+ rejects a task graph when a run task and `package.json` script share the same identifier.
  Therefore the internal task is `check:schema-version-policy:run`, while the public package script
  remains `check:schema-version-policy`. Omitting the task's `cache` property is the supported way to
  disable caching; `cache: false` is not accepted by the installed task-schema version.
- The inventory paths were reconciled to current repository ownership: compiled-project native
  decoding is under `engine/src/core/compiled_project_codec/`, typed checkpoint storage is under
  `engine/src/runtime/`, and the editor asset-profiler contract is
  `editor/src/shared/asset-profiler-protocol.ts`.
- Later phase scope and sequencing remain accurate. No downstream phase boundary required a change.

### Phase 2 — Strict ComfyUI Workflow Manifest V2-Only Cutover

#### Purpose

Replace the permissive V1/V2 manifest reader with the single strict V2 contract defined above.

#### Entry conditions

- Phase 1 is complete.
- Confirm both built-in manifests and every import/repair writer are identified.

#### Primary implementation surfaces

- `editor/src/shared/comfyui-workflows.ts`
- `editor/src/shared/comfyui-workflow-inference.ts`
- `editor/src/main/services/comfyui-service.ts`
- `editor/src/main/services/comfyui-workflow-import-service.ts`
- `editor/src/main/services/comfyui-workflow-library-service.ts`
- built-in manifests under `editor/assets/comfyui/workflows/`
- ComfyUI workflow tests under `editor/src/renderer/test/`
- ComfyUI permanent documentation

#### Required implementation

1. Add `COMFYUI_WORKFLOW_SCHEMA_VERSION = 2 as const` and derive the version type from it.
2. Replace `parseSchemaVersion()` with an exact required-version check. Missing, nonnumeric, V1, and
   future versions fail.
3. Add one `assertExactKeys(record, allowedKeys, path)` helper and call it for every manifest-owned
   object before reading fields. Dynamic semantic maps such as `bindings`, `defaults`, and contract
   inputs still validate their keys against the current role/semantic key sets. Silent unknown-key
   dropping is not permitted.
4. Remove `outputNodeIds` from types, parsing, resolution, inference, validation, repair, import,
   serialization, UI warnings, and built-in manifests.
5. Remove unused `outputName` from output binding types/parser and remove accidental output-binding
   `inputName` from built-in manifests.
6. Remove ignored `minBindings`/`maxBindings` copies from built-in manifest contract objects. Keep
   those cardinalities only in the role catalog, which owns role-level validation.
7. Require exactly one `outputBindings.images` entry for current roles and enforce the locked locator
   and value/primary rules.
8. Ensure inference, import, repair, copy, starter-install, and manifest serialization always write
   the exact same V2 shape.
9. A V1 or noncanonical project/editor workflow remains visible as invalid through existing library
   diagnostics but cannot run, copy, or be repaired by silently interpreting old fields. Reimport or
   regenerate is the supported development workflow.
10. Replace all positive V1 tests with V2 tests. Keep focused negative tests for missing version, V1,
    `outputNodeIds`, unknown fields, bad output cardinality, and missing output locator.
11. Remove the Phase 2 entries from `temporary_debt.tsv` only after all production searches are clean.

#### Not in this phase

- changing ComfyUI server APIs;
- adding new workflow roles;
- changing input binding selector semantics;
- adding a V1 converter.

#### Focused verification

Run all ComfyUI workflow parsing, inference, import, library, execution, starter-install, copy,
repair, and project-validation suites, followed by:

```sh
pnpm -C editor run format:check
pnpm -C editor run typecheck
pnpm -C editor run check
pnpm -C editor run test
```

#### Exit gate

- every normal ComfyUI manifest reader requires exact V2;
- every writer emits the canonical strict V2 shape;
- no production reference to `outputNodeIds` or output `outputName` remains;
- built-in manifests contain no ignored keys;
- V1, missing-version, unknown-field, and old-output forms fail focused negative tests;
- all Phase 2 compatibility debt is removed.

#### Phase 2 implementation record (2026-07-27)

- Both built-in manifests and the import/repair writer were confirmed as the only manifest producers.
  They now emit the same canonical V2 shape with one `outputBindings.images` entry and no copied
  role-catalog cardinalities or retired output fields.
- Strictness applies recursively to every manifest-owned object. Dynamic semantic maps remain
  constrained by the role/semantic catalogs, while workflow graph payloads are outside the manifest
  contract and were not tightened.
- The focused retired-field rejection test remains in the repository as an exact-count permanent
  checker exception. All Phase 2 temporary debt entries were removed only after production and
  positive-fixture searches were clean.
- Existing invalid-library behavior already prevents a manifest that fails parsing from execution,
  copy, install, or repair. Removing the legacy repair warning therefore required no new invalid-entry
  state or service API.
- No concrete Phase 2 finding changed the scope, sequencing, boundary, or validation requirements of
  Phases 3–8.

### Phase 3 — Editor Metadata and Local Session Current-Only Cutover

#### Purpose

Remove both persisted-state migrations and the hidden authoring-content export-identity migration
while preserving current metadata recovery isolation.

#### Entry conditions

- Phase 2 is complete.
- Re-audit project open, metadata-only persistence, recovery reconstruction, Save As, and successful
  export identity writes before editing.

#### Primary implementation surfaces

- `editor/src/shared/project-schema/editor-project-state.ts`
- `editor/src/shared/project-schema/authoring-project.ts`
- `editor/src/shared/project-schema/authoring-project-settings.ts`
- `editor/src/main/services/editor-tool-service.ts`
- metadata persistence/open response code
- `editor/src/renderer/workbench/local-editor-session-store.ts`
- editor metadata, recovery, project-open, export-identity, and local-session tests
- current project/save/export documentation

#### Subphase 3A — Embedded editor metadata

Status: [x] Complete (2026-07-27).

1. Delete `editorProjectStateV1Schema`, `migrateEditorProjectStateV1ToV2()`, and the V1 dispatch
   branch.
2. Implement the locked absent/unsupported/invalid behavior and exact warning codes.
3. Do not copy any field from invalid top-level metadata into the fresh state.
4. Preserve current per-save-unit recovery isolation only after the top-level V2 base validates.
5. Add tests for:
   - absent metadata without warning;
   - valid V2 round trip;
   - V1 discard with unsupported-version warning;
   - missing/future version discard;
   - wrong schema discard;
   - malformed V2 top-level discard;
   - malformed one-entry recovery isolation inside otherwise valid V2;
   - content fingerprint replacement on accepted and fresh states.

Implementation record:

- Removed the V1 schema, migration function, and V1 dispatch branch. Present metadata now accepts
  only exact V2; absent metadata still creates an empty V2 state without a warning.
- Unsupported or missing versions discard the complete metadata object and emit
  `editor.metadata.schema-version.unsupported` at `/editor/schemaVersion`. Wrong schema identity and
  malformed current top-level metadata discard the complete object and emit
  `editor.metadata.invalid` at `/editor`.
- Top-level recovery structure is validated without repairing malformed envelope fields. A malformed
  `saveUnitsById` container discards the complete metadata object. Only entries inside a valid
  `saveUnitsById` record retain isolated parsing after the V2 base validates, and invalid entry IDs
  are ignored with the existing per-entry warning.
- The caller-supplied current content fingerprint still replaces persisted fingerprint data for
  both accepted and fresh states.
- Removed only the `editor-state-v1` temporary-debt record. Phase 3 debt for legacy export identity
  and browser-local session migration remains for Subphases 3B and 3C.
- No implementation finding changed the scope, sequencing, boundaries, or validation requirements
  of Subphases 3B–3C or Phases 4–8.

#### Subphase 3B — Legacy export identity removal

Status: [x] Complete (2026-07-27).

1. Make `stripEditorProjectState()` remove only top-level `/editor`.
2. Delete `legacyLastSuccessfulPlatformExportIdentity()` and its project-open call site.
3. Remove tests that expect `settings.app.lastExportedIdentity` to migrate into editor metadata.
4. Add a negative current-authoring test proving the retired field is rejected rather than stripped.
5. Keep current successful-export writes to
   `/editor/lastSuccessfulPlatformExportIdentity` unchanged.

Implementation record:

- `stripEditorProjectState()` now removes only the top-level `editor` property. It no longer inspects
  or mutates project settings.
- Removed `legacyLastSuccessfulPlatformExportIdentity()` and the project-open branch that copied the
  retired content value into editor metadata.
- Removed positive migration and retired-field stripping assertions. Added one focused negative
  authoring-schema test proving `settings.app.lastExportedIdentity` is rejected by the strict current
  project schema.
- Preserved successful platform-export writes to
  `/editor/lastSuccessfulPlatformExportIdentity` without changing their success-only behavior.
- Removed all `legacy-export-identity` temporary-debt entries and added an exact-count permanent
  checker exception for the focused negative rejection test.
- Updated current Project Settings documentation to state that the retired field is invalid and is
  neither migrated nor stripped.
- No concrete Subphase 3B finding changed the scope, sequencing, boundaries, or validation
  requirements of Subphase 3C or Phases 4–8.

#### Subphase 3C — Browser-local shell state

Status: [x] Complete (2026-07-27).

1. Remove the Zustand `migrate` callback.
2. Keep persistence key and version `2`.
3. Verify current V2 rehydration.
4. Verify V1/version-mismatch state and old root `shellWorkbench` state initialize
   `shellSession: null` and do not become a current shell session.
5. Verify a malformed current-version payload is discarded to `shellSession: null`; current-version
   rehydration must validate the complete persisted shape rather than relying on TypeScript types.

Implementation record:

- Removed the Zustand persistence `migrate` callback while retaining the
  `noveltea-editor-session` key and store version `2`.
- Added focused persistence tests proving current V2 `shellSession` data rehydrates unchanged, a V1
  version mismatch leaves the initialized `shellSession: null`, the retired root-level
  `shellWorkbench` shape is not promoted even when stored with version `2`, and malformed V2 state is
  discarded. A strict `merge` validator enforces the current payload without introducing a migration
  callback.
- Removed the final `local-session-migration` temporary-debt entry after the production search and
  focused negative tests were clean. Phase 3 now has no remaining compatibility debt.
- No concrete Subphase 3C finding changed the scope, sequencing, boundaries, or validation
  requirements of Phases 4–8.

#### Documentation reconciliation

Update current save/recovery/export documents so they no longer promise editor-state migration or
legacy identity extraction. Only archived historical records may state that migration once existed;
active instructions must mark it superseded by the permanent schema policy.

#### Debt removal

Remove all Phase 3 entries for V1 metadata, local-session migration, and legacy identity only after
production searches and negative tests pass.

#### Focused verification

Run editor project-state, recovery, project-file service, open-project, Save As, workbench restore,
local-session, platform-export identity, and validation-boundary suites, followed by the standard
editor checks and build because shared/main production code changes:

```sh
pnpm -C editor run format:check
pnpm -C editor run typecheck
pnpm -C editor run check
pnpm -C editor run test
pnpm -C editor run build
```

#### Exit gate

- only editor metadata V2 is parsed;
- invalid or unsupported metadata is discarded exactly as specified;
- valid V2 recovery isolation still works;
- no authoring-content identity migration remains;
- local shell persistence has no migration callback;
- malformed current local-shell state is discarded rather than merged into the live store;
- all Phase 3 compatibility debt is removed.

#### Phase 3 completion audit (2026-07-27)

- The audit found that `parseEditorProjectStateWithDiagnostics()` replaced any
  `recovery.saveUnitsById` value with an empty record before validating the V2 base. An array or other
  malformed container could therefore preserve unrelated metadata instead of discarding the complete
  object. The parser now isolates entries only when the container is a valid record and also rejects
  invalid save-unit IDs per entry.
- The audit found that removing Zustand's migration callback was insufficient to enforce the stated
  malformed-state failure behavior: a malformed version-2 `shellSession` could still be shallowly
  merged into the store. Current V2 payloads now pass a strict shape validator in `merge`; invalid
  payloads initialize `shellSession: null`.
- Subphase 3B remained complete as implemented. The retired authoring export-identity field is
  rejected, is neither extracted nor stripped, and successful export identity remains editor
  metadata written only by the existing success path.
- The focused Phase 3 suites, standard editor checks, complete editor test suite, and production
  editor build passed after these corrections. All Phase 3 temporary debt remains removed.
- These findings correct Phase 3 boundary enforcement only. They do not change the scope, sequencing,
  canonical contracts, or validation requirements of Phases 4–8; no downstream plan edits are
  justified.

### Phase 4 — Explicit Image Sampling Across Compiled and Preview Boundaries

#### Purpose

Remove the hidden “older omission means linear” rule wherever an image resource crosses a compiled
or focused-preview wire boundary.

#### Entry conditions

- Phase 3 is complete.
- Re-audit all producers of compiled `assets[]` and focused-preview resource manifests.

#### Primary implementation surfaces

- `editor/src/shared/project-schema/compiled-project.ts`
- `editor/src/shared/authoring-compiler-shared-lowering.ts`
- `editor/src/shared/project-schema/authoring-assets.ts`
- `editor/src/shared/focused-preview-contracts.ts`
- `editor/src/renderer/preview/focused-preview-adapters.ts`
- `editor/src/renderer/preview/room-focused-preview-builder.ts`
- native focused-preview contracts and protocol decoding
- `engine/include/noveltea/core/compiled_project.hpp`
- `engine/src/core/compiled_project_codec/project_fields.cpp`
- `engine/src/core/compiled_project.cpp`
- `engine/src/world_presentation.cpp`
- `engine/src/assets/structured_prefetch.cpp`
- compiled wire and focused-preview docs/tests/fixtures

#### Subphase 4A — TypeScript compiled project

**Status:** [x] Completed 2026-07-27.

1. Replace the flat asset schema with the locked strict discriminated union.
2. Ensure authoring compiler lowering emits `sampling: data.sampling ?? "linear"` for every image.
3. Ensure non-image resources never emit sampling.
4. Add positive tests for explicit linear and nearest values.
5. Add negative tests for a missing image sampling field and a non-image sampling field.

#### Subphase 4B — Native compiled project

**Status:** [x] Completed 2026-07-27.

1. Change the internal resource representation to the locked optional invariant.
2. Decode kind before selecting the permitted key set.
3. Require and parse sampling for images.
4. Reject sampling for non-images as an unknown/invalid field.
5. Remove the missing-value default to `ImageSampling::Linear`.
6. Update model validation and every sampling consumer to enforce image-kind access.
7. Update native wire tests so missing image sampling is a failure, not linear success.

Implementation record:

- `compiled::AssetResource::sampling` is now optional internally and model validation enforces the
  exact invariant that image kind has a valid sampling value while every non-image kind has none.
- Native decoding reads and validates `kind` first, then applies an image-specific or non-image key
  set. Images require and parse `sampling`; non-images report it through the existing unknown-field
  diagnostic path. The missing-value linear default was removed.
- Structured-prefetch and world-presentation consumers now assert image-kind access before
  dereferencing sampling. No non-image consumer or implicit fallback remains.
- Native wire coverage now proves explicit linear/nearest decoding, missing image sampling rejection,
  and non-image sampling rejection.
- The repository-wide format target exposed an unrelated existing clang-format violation in
  `engine/src/core/editor_runtime_protocol.cpp`; touched 4B files were formatted independently.
- No concrete 4B finding changed Subphase 4C or Phases 5–8. Focused-preview resources retain their
  separate string sampling representation until 4C as planned.

#### Subphase 4C — Focused preview resources

**Status:** [x] Completed and audited 2026-07-27.

1. Make TypeScript editor and native manifest schemas discriminate image and non-image entries.
2. Materialize the authoring default in every preview resource producer.
3. Require image sampling in native protocol decoding and reject it on non-images/shader binaries.
4. Preserve failed-candidate behavior: a bad manifest must not destroy the committed preview.
5. Add TypeScript/native parity fixtures for image linear, image nearest, missing image sampling, and
   illegal non-image sampling.

Implementation record:

- The authoring and native TypeScript manifest schemas are now strict discriminated unions: image
  Asset entries require `sampling`, non-image Asset entries omit it, and Shader-binary entries remain
  a separate strict variant that forbids it.
- Layout/Shader-focused adapters and the Room focused-preview builder now materialize authoring image
  omission as explicit `linear`; non-image producers never emit sampling. Native manifest projection
  preserves the same discrimination.
- Native focused-preview envelope decoding now rejects missing image sampling, invalid sampling
  values, sampling on non-image Assets, and sampling on Shader binaries before a candidate reaches
  staging or presenter application. The existing transactional candidate path therefore continues
  to preserve the last committed preview on rejection.
- TypeScript and native tests cover explicit linear, explicit nearest, missing image sampling, and
  illegal non-image/Shader-binary sampling. Existing focused-preview pooling, staging, coordinator,
  and presenter tests remained green.
- The Linux configure initially failed because `VCPKG_ROOT` was absent from the tool environment;
  rerunning with the repository's existing `/home/thomas/dev/vcpkg` installation restored the
  configured build. This is an environment invocation constraint, not a product or later-phase
  contract change.
- No concrete 4C finding changed Phases 5–8. Shader compiled-output work remains scoped to Phase 5 as
  planned.

Phase completion audit record:

- The native focused-preview decoder's non-image Asset kind list had drifted from the TypeScript
  `assetKindValues` contract: it rejected current `script`, `text`, and `binary` resources while
  accepting retired or foreign `video`, `rml`, `rcss`, and `lua` spellings. The decoder and native
  parity coverage now use the exact current Asset kind set.
- The two Phase 4 `wire-optional-sampling` temporary-debt rows remained after the schemas became
  strict. A direct policy-checker invocation correctly rejected those stale rows, while the editor
  wrapper replayed an older cached success because its task inputs did not include the source trees
  scanned by the policy rules. The stale debt rows are removed and the wrapper cache key now includes
  every current scanned source surface, so source changes invalidate the result.
- Focused TypeScript tests, the complete editor suite and production build, Linux debug
  configure/build, the mandatory C++ policy target, focused native CTest, the complete 768-test Linux
  CTest suite under the documented headless display environment, and Web debug configure/build and
  C++ policy passed after these corrections.
- These findings complete Phase 4 contract and guardrail enforcement only. They do not change the
  scope, sequencing, canonical contracts, or validation requirements of Phases 5–8; no downstream
  plan edits are justified.

#### Documentation

Update `docs/architecture/COMPILED_PROJECT_WIRE_V2.md` to remove language that older V2 documents may
omit sampling. Document the discriminated image shape and focused-preview parity.

#### Debt removal

Remove all Phase 4 optional-sampling debt only after compiled and preview boundaries are both strict.

#### Focused verification

- editor compiled schema/compiler golden and parity tests;
- focused-preview contract, resource staging, Room builder, coordinator, and protocol tests;
- native compiled-project wire/model tests;
- structured-prefetch, world-presentation, focused presenter, and protocol tests;
- standard editor checks/build;
- Linux debug configure/build and focused CTest.

#### Exit gate

- authoring omission still semantically becomes explicit linear at every wire producer;
- compiled and preview image resources require sampling;
- non-image resources forbid sampling;
- native code has no missing-image fallback;
- failed focused candidates preserve the prior preview;
- all Phase 4 compatibility debt is removed.

### Phase 5 — Canonical Authoring Shader Compiled-Output Metadata

#### Purpose

Make persisted authoring Shader outputs complete, verifiable objects and separate editor freshness
identity from native compiler cache identity.

#### Entry conditions

- Phase 4 is complete.
- Re-audit every producer and consumer of `ShaderCompileOutput`, `ShaderCompiledOutput`, and
  `shaderCompileInputFingerprint()`.
- Do not change runtime Shader wire parsing yet; that occurs in Phase 6.

#### Primary implementation surfaces

- `editor/src/shared/project-schema/authoring-shaders.ts`
- `editor/src/shared/editor-tooling.ts`
- `editor/src/renderer/shaders/shader-compile-store.ts`
- `editor/src/renderer/editors/shaders/ShaderEditor.tsx`
- `editor/src/renderer/project/shader-material-operations.ts`
- `editor/src/renderer/commands/builtin-commands.ts`
- package/platform export compile overlay code
- focused-preview Shader resource builders
- native Shader compiler response serialization where it exposes output metadata
- related editor and native compiler tests

#### Required implementation

1. Replace the authoring string/object union with the locked strict object schema.
2. Make all metadata fields required in types, command payloads, and authoring writes.
3. Make `canonicalRuntimeShaderOutputPath()` validate an already namespaced canonical project path;
   remove implicit `project:/` prepending.
4. Make freshness return true only when complete metadata exists and the stored authoring fingerprint
   equals the freshly calculated authoring fingerprint.
5. Remove string branches from path extraction, required-binary collection, preview resource
   discovery, validation, and tests.
6. Make every successful public `ShaderCompileOutput` contain exactly the existing identity/path/cache
   fields plus required integrity evidence:
   `shader`, `stage`, `variant`, `sourcePath`, `outputPath`, `runtimePath`, `cacheKey`, `byteHash`,
   `byteSize`, and `cacheHit`. Remove public `compileInputFingerprint`.
7. Capture the authoring fingerprint for each requested stage/variant before invoking the compiler.
   Immediately before applying returned output, recompute it against the current project. If it no
   longer equals the captured value, reject that output as stale and do not persist it.
8. Use the verified captured authoring fingerprint in the authoring metadata object. Do not trust a
   native field with the same or similar name.
9. Remove the editor store’s fallback that substitutes a native fingerprint when the caller did not
   supply one. Missing request fingerprint evidence is an error.
10. Retain `cacheKey` as the public compiler-cache identity. Remove the native serialized
    `compileInputFingerprint`; internal compiler calculations must not leave the compiler boundary
    under the authoring field name.
11. Ensure interactive compile, recorded compiled-output command, Play/package ephemeral overlay,
    platform export, and focused preview all produce the same authoring metadata object.
12. Replace all positive string-output fixtures. Keep focused negative tests for string output,
    missing hash, missing size, missing fingerprint, stale fingerprint, invalid hash, and
    namespace-less path.
13. Remove Phase 5 debt entries after production searches are clean.

#### Not in this phase

- changing runtime Shader `compiled` objects;
- changing role representation;
- changing shaderc cache behavior beyond naming/separation required above.

#### Focused verification

Run authoring Shader schema, operations, command, editor, compile store, package workflow, platform
export, focused Room/Shader preview, compiler cache, and freshness tests, followed by standard editor
checks/build and the native Shader compiler suite.

#### Exit gate

- persisted authoring output has exactly one complete object shape;
- no authoring string or partial metadata path remains;
- project logical paths are explicitly namespaced;
- authoring and native cache fingerprints are no longer conflated;
- every compile/export/preview producer agrees;
- all Phase 5 compatibility debt is removed.

#### Completion record — 2026-07-27

- Replaced the authoring Shader compiled-output string/object union with one strict object requiring
  canonical `project:/shaders/bgfx/...` `path`, `byteHash`, `byteSize`, and
  `compileInputFingerprint`. Namespace-less paths, strings, partial objects, invalid hashes, and
  unknown fields now fail schema validation.
- Added one shared compile-request fingerprint capture helper. Interactive Shader compile, package
  export, platform export, and Android staging capture fingerprints before invoking the compiler,
  recompute them against current authoring state before applying output, and reject missing, stale,
  or invalid evidence instead of persisting it.
- Split public compiler output from persisted authoring metadata. Public TypeScript and native tool
  responses retain `cacheKey`, `byteHash`, and `byteSize` but no longer expose
  `compileInputFingerprint`; verified authoring metadata is assembled only at the editor boundary
  from the captured authoring fingerprint.
- Updated command payloads, ephemeral package overlays, focused Shader/Material preview fixtures,
  required-binary discovery, Android staging, and platform export to consume the canonical object.
  Removed legacy string branches and the Phase 5 `authoring-shader-union` temporary-debt row.
- Removing the union eliminated one authoring-schema leaf. The reviewed dependency-graph field
  sequence and the pinned Shader-root fingerprint were updated to reflect that concrete schema
  change; no graph behavior or later-phase scope changed.
- Validation passed: standard editor check, full editor test suite (1,029 passed, 4 skipped), editor
  production build and bundle policy, Linux debug configure/build, and all 28 Shader-matching CTest
  cases. The local Node runtime was 22.22.1 while the repository declares 24.18.0; all invoked editor
  checks, tests, and builds nevertheless completed successfully.

#### Concrete downstream findings

- The existing authoring-to-runtime Shader material builder currently carries the complete
  authoring metadata object into `noveltea.shader-materials.v1` until the runtime adapter is cut over.
  Therefore Phase 6 item 3 is not optional cleanup: that adapter must explicitly emit only
  `{runtimePath, byteHash, byteSize}` and must prove that `compileInputFingerprint` cannot appear in
  runtime metadata or package JSON.
- The native compiler still uses an internal authoring-like fingerprint while populating the current
  runtime `ShaderCompiledBinaryRef`. Phase 5 removed it only from the public compiler response, as
  required. Phase 6 must remove that field from the runtime model/codec and retain any compiler-cache
  identity only under its separate `cacheKey` contract.

### Phase 6 — Canonical Runtime Shader Compiled Outputs and Logical Paths

#### Purpose

Cut the Shader/material runtime wire to one strict metadata object and one logical-path vocabulary.

#### Entry conditions

- Phase 5 is complete.
- Re-audit runtime Shader producers, native parser/model, package required-binary collection, system
  Shader construction, and checked-in runtime fixtures.

#### Primary implementation surfaces

- `editor/src/shared/project-schema/shader-material-project.ts`
- `editor/src/shared/project-schema/compiled-runtime-export.ts`
- package/export Shader path collection
- `engine/include/noveltea/render/shader.hpp`
- `engine/src/render/material_codec.cpp`
- `engine/src/render/shader_compiler.cpp`
- runtime Shader manifest/resolver/package code
- system Shader construction in engine initialization
- sandbox package fixtures and render/core/script/asset tests
- Shader/material permanent documentation

#### Required implementation

1. Replace the runtime string/object union with the locked strict metadata object.
2. Make `runtimePath`, `byteHash`, and `byteSize` required; exclude authoring fingerprint.
3. Make the authoring-to-runtime adapter map `path` to `runtimePath` and copy hash/size.
   Assert in TypeScript and native parity tests that the resulting runtime object has no
   `compileInputFingerprint` field and that package JSON cannot serialize one.
4. Update ephemeral export overlays to write the same runtime object, not a path string.
5. Update required-binary collection to read only `runtimePath` from the canonical object and convert
   `project:/...` to package-relative form only at the package boundary.
6. Make native parsing reject:
   - path strings;
   - partial objects;
   - unknown object fields;
   - namespace-less runtime paths;
   - invalid hash/size;
   - stage/extension mismatches.
7. Remove the generic native path-only constructor and editor freshness field from
   `ShaderCompiledBinaryRef`. Add an explicitly named `trusted_system(...)` factory or a separate
   trusted-system type for direct C++ system Shader construction; it accepts only a `system:/` path
   and cannot be called by JSON decoding.
8. Separate native compiler outputs:
   - logical `runtime_path` is `project:/shaders/bgfx/...`;
   - filesystem/package relative path remains `shaders/bgfx/...` in a separately named value.
9. Convert engine/system Shader definitions to `system:/` logical paths. A system Shader represented
   in a decoded runtime document must carry required hash/size metadata. A trusted system Shader
   constructed directly in typed C++ uses only the dedicated trusted-system factory/type from item 7
   and is never a precedent for accepting incomplete JSON wire metadata.
10. Update every checked-in runtime Shader fixture and all positive tests to object metadata.
11. Keep negative tests for string output, partial metadata, extra field, bad namespace, wrong stage
    suffix, invalid hash, and invalid size.
12. Remove Phase 6 debt entries only after TypeScript and native parsers accept the same shape.

#### Important path distinction

Do not mechanically replace all `shaders/bgfx/...` strings. Package-entry names and filesystem paths
are intentionally relative. Only Shader logical references in runtime documents and typed program
resolution are namespaced. Tests must assert both representations at the appropriate boundaries.

#### Focused verification

- editor Shader material project and compiled runtime export tests;
- package export and platform-export acceptance/certification tests;
- native material codec, Shader manifest/resolution/compiler/package tests;
- compiled package, compiled runtime, structured prefetch, and sandbox runtime package tests;
- standard editor checks/build;
- Linux debug build and complete affected CTest labels/targets.

#### Exit gate

- one runtime compiled-output object is emitted and accepted;
- no runtime string or partial-object decoder remains;
- all runtime logical Shader paths are explicitly `project:/` or `system:/`;
- package-relative paths remain confined to package/filesystem contracts;
- TypeScript/native parity fixtures agree exactly;
- all Phase 6 compatibility debt is removed.

#### Completion record — 2026-07-27

- Replaced the runtime Shader compiled-output string/object union with one strict object containing
  exactly `runtimePath`, `byteHash`, and `byteSize`. TypeScript and native readers reject strings,
  partial objects, unknown fields, invalid hashes or sizes, namespace-less paths, and stage-suffix
  mismatches.
- Added an explicit authoring-to-runtime adapter that strips `compileInputFingerprint`; runtime
  metadata and package JSON now contain only runtime integrity evidence. Required package paths are
  derived from `runtimePath` only at the package boundary.
- Split compiler path identities: public/runtime metadata uses canonical
  `project:/shaders/bgfx/...` logical paths, while filesystem output and package cache keys use
  package-relative `shaders/bgfx/...` paths.
- Removed `compile_input_fingerprint` and the generic path-only constructor from
  `ShaderCompiledBinaryRef`. Directly typed built-in system resources use the dedicated
  `trusted_system(...)` factory and cannot be constructed through the JSON decoder without complete
  metadata.
- Updated native, editor, package, preview, sandbox, and compiled-project fixtures to the canonical
  object shape. Removed the native Phase 6 temporary-debt row while preserving the Phase 7 roles
  debt.
- No concrete implementation finding required changing Phase 7 or Phase 8 scope, sequencing, or
  validation.

### Phase 7 — Canonical Runtime Shader Roles and Role Bindings

#### Purpose

Separate role membership from role-specific stage selection so one field no longer has two unrelated
wire types.

#### Entry conditions

- Phase 6 is complete.
- Re-audit every runtime Shader producer and every native role/binding consumer.

#### Primary implementation surfaces

- `editor/src/shared/project-schema/shader-material-project.ts`
- authoring-to-runtime Shader builder
- `engine/include/noveltea/render/shader.hpp`
- `engine/src/render/material_codec.cpp`
- Shader manifest/program resolution and material binding code
- Shader/material fixtures and TypeScript/native tests
- Shader/material permanent documentation

#### Required implementation

1. Make runtime `roles` an array only.
2. Add required `role_bindings`, always emitted as an object and `{}` when empty.
3. Validate unique roles, binding-key membership, strict binding fields, and at least one stage per
   binding.
4. Emit declared authoring roles unchanged and emit authoring role bindings separately.
5. Do not derive role membership only from binding keys and do not discard declared roles when one
   binding exists.
6. Replace native `parse_shader_roles()` with separate exact parsers for `roles` and
   `role_bindings`.
7. Reject object-shaped `roles`, missing `role_bindings`, duplicate roles, unknown binding roles,
   empty binding objects, and invalid stage Shader IDs.
8. Preserve current program-resolution behavior for:
   - direct Shader pairs;
   - role-specific vertex/fragment selection;
   - one fragment Shader reused with different role-specific vertex stages;
   - recognized but deferred roles.
9. Update all runtime fixtures and positive tests to contain both fields.
10. Keep focused negative tests for the retired object-shaped roles form and every invariant above.
11. Remove Phase 7 debt entries after production searches are clean.

#### Focused verification

Run editor Shader builder/schema tests and native material codec, Shader manifest, Shader program
resolution, material asset/binder, package, compiled runtime, and structured-prefetch suites, then
the standard editor checks/build and Linux debug affected tests.

#### Exit gate

- role membership and role bindings have separate required fields;
- object-shaped `roles` is rejected;
- producers preserve declared roles independently from bindings;
- native and TypeScript validation enforce the same invariants;
- all Phase 7 compatibility debt is removed.

#### Completion record — 2026-07-27

- Replaced the TypeScript runtime `roles` union with an array-only schema and added required
  `role_bindings`, including uniqueness, known-role, membership, strict-field, and non-empty-binding
  validation.
- Changed the authoring-to-runtime builder to preserve all declared roles independently and emit
  role bindings as a separate object, including `{}` when no binding exists.
- Replaced the native combined role parser with separate `roles` and `role_bindings` parsers. Native
  decoding now rejects object-shaped roles, missing bindings, duplicate roles, undeclared or unknown
  binding keys, empty bindings, unknown fields, and invalid stage Shader IDs while preserving the
  existing deferred-role diagnostics and program-resolution model.
- Updated package shape validation, runtime package evidence, and all affected native fixtures to
  require both fields. Added focused TypeScript and native rejection coverage plus a positive case
  proving declared roles survive independently from bindings.
- Removed the final temporary compatibility-debt row and updated permanent Shader documentation.
- Concrete implementation finding affecting Phase 8: because Phase 7 removed the final debt row,
  Phase 8's existing entry condition that `temporary_debt.tsv` contain no legitimate entries is now
  satisfied. No Phase 8 scope, sequencing, boundary, or validation change was required.

### Phase 8 — Repository Audit, Documentation Reconciliation, and Certification

#### Purpose

Prove the policy is complete across the repository, reconcile durable documentation, remove the
temporary debt mechanism, and archive this plan.

#### Entry conditions

- Phases 1–7 are complete and their focused exit gates pass.
- `temporary_debt.tsv` has no remaining legitimate entries.

#### Phase 8 implementation findings (2026-07-27)

- The source-derived audit found that the Phase 1 inventory was not exhaustive after later platform
  export and editor-state work. Current-only player/bootstrap, platform-template/export,
  editor-preview subprotocol, certification, and editor tab-state contracts must be added to the
  permanent inventory before certification.
- Several editor tab-state readers persisted an explicit `schemaVersion` but restored state after
  checking only the schema identity, and the Room editor restored the payload without checking
  either identity or version. Phase 8 must make every such normal reader reject unsupported tab-state
  versions and add focused negative coverage; this is final-audit defect correction, not a new
  compatibility feature.
- The shader draft recovery helper also matched only its schema identity and ignored the persisted
  `schemaVersion`. Phase 8 must require the exact current draft identity/version before restoring the
  payload and cover the shared draft-state boundary in certification evidence.
- The ComfyUI workflow verification cache was an unversioned generated-state array whose reader
  accepted arbitrary record shapes and whose key path retained a missing-version `legacy` branch.
  Phase 8 must replace it with one strict current cache document, require a current ComfyUI version
  on every record, and discard incompatible cache files rather than upgrading them.
- The native `resources/aliases.json` reader was an unversioned generated-manifest boundary with
  wrapped/unwrapped roots, string/object entry unions, duplicate field names, and casing aliases.
  Phase 8 must define one strict current resource-alias manifest identity/version, update the shipped
  fixture, reject retired alternate shapes, and add the contract to the permanent inventory.
- The editor distribution stage manifest writer emitted only a numeric version while its verifier
  ignored that version entirely. Phase 8 must add a stable manifest identity, require the exact
  current identity/version during verification, and inventory the build artifact contract.
- Expanding the inventory with mandatory positive/negative evidence columns made the checker
  self-test's synthetic seven-column contract row invalid. Phase 8 must update that fixture so the
  permanent checker continues to prove both positive acceptance and negative enforcement against
  the same inventory schema used by the repository.
- The full verification command shown below with an inline
  `CMAKE_BUILD_PARALLEL_LEVEL=8` conflicts with the repository-wide requirement to preserve an
  existing `CMAKE_BUILD_PARALLEL_LEVEL`. Phase 8 validation must use the inherited value and record
  it in the certification evidence rather than overriding it.
- Phase 8 completed on 2026-07-28. The permanent command results, 42-contract inventory summary,
  compatibility-removal list, exception disposition, and environment details are recorded in
  `docs/architecture/certifications/SCHEMA_VERSION_POLICY_CERTIFICATION.md`.

#### Primary implementation surfaces

- all production TypeScript/C++ schema, protocol, persistence, package, and manifest readers/writers
- checked-in project/package/preview/Shader/ComfyUI fixtures
- current documentation under `docs/`
- root and editor policy targets
- CI workflows and certification records

#### Required repository audit

1. Rebuild the full contract inventory from source, not from the initial table alone.
2. For every contract, record and verify:
   - current identity and version;
   - all producers;
   - all normal consumers;
   - unsupported-input action;
   - positive current fixture;
   - negative unsupported-version fixture.
3. Search production code for:
   - version unions;
   - missing-version defaults;
   - migration/upgrade/downgrade/legacy helpers;
   - old/new field aliases;
   - same-concept string/object or array/object unions;
   - comments documenting old-version acceptance;
   - write-both-old-and-new logic;
   - optional wire fields justified only by older output;
   - broad passthrough schemas at versioned boundaries;
   - namespace normalization that silently accepts an old path vocabulary.
4. Classify every search hit as:
   - current semantic behavior;
   - exact negative rejection evidence;
   - narrowly documented permanent exception;
   - defect that must be removed before completion.
5. Empty `temporary_debt.tsv` except for its header. Do not convert unresolved debt into permanent
   exceptions.
6. Verify permanent exceptions are exact, still necessary, and not schema compatibility.
7. Verify no current positive fixture uses a retired version or shape.
8. Verify generated package/export evidence uses only current contracts.

#### Documentation reconciliation

Update at least the documents governing:

- architecture and domain model;
- compiled project wire V2;
- authoring compiler;
- editor project opening, saving, recovery, and settings;
- ComfyUI workflows;
- preview communication/resources;
- package export and platform export;
- Shader/material authoring and runtime format;
- agent instructions and area overviews.

Current documentation must describe only current behavior. Historical migration records belong under
`docs/archive/` and must be marked historical. Do not leave an active plan that instructs agents to
restore V1 migration or legacy fields.

Create a permanent certification record under the narrowest appropriate architecture documentation
directory containing:

- reviewed commit/HEAD;
- contract inventory summary;
- removed compatibility list;
- permanent exceptions, if any;
- exact validation commands and results;
- any environment limitations;
- results for every manual smoke item listed below.

#### Full verification matrix

##### Policy and repository hygiene

```sh
cmake --build --preset linux-debug --target noveltea-schema-version-policy cxx-policy
ctest --preset linux-debug -R 'schema_version_policy|policy' --output-on-failure
pnpm -C editor run check:schema-version-policy
git diff --check
```

##### Editor

```sh
pnpm -C editor run format:check
pnpm -C editor run typecheck
pnpm -C editor run check
pnpm -C editor run test
pnpm -C editor run build:renderer
pnpm -C editor run build:electron
pnpm -C editor run engine:preview:build
```

Run the complete ComfyUI, project schema/open/recovery/session, authoring compiler, focused preview,
Shader/material, package export, platform export, and cross-language parity matrices even when the
aggregate editor suite passes.

##### Linux native

```sh
cmake --preset linux-debug
CMAKE_BUILD_PARALLEL_LEVEL=8 cmake --build --preset linux-debug
ctest --preset linux-debug --output-on-failure
```

Run all compiled-project/package, save/settings/protocol, focused-preview, Shader/material/compiler,
structured-prefetch, world-presentation, runtime, and package-export tests.

##### Web/editor preview

Run the current Web debug/editor-preview build and focused Web preview smoke defined in build and
editor preview documentation. Confirm strict current payloads load and rejected candidates preserve
the last committed preview.

##### Manual smoke

At minimum:

- open and save a current project with current editor metadata;
- open a project with no `/editor` object;
- verify unsupported editor metadata is discarded with warning and content remains editable;
- verify a current ComfyUI workflow loads/runs and a V1 manifest is invalid;
- preview a Room using image resources with linear and nearest sampling;
- compile a Shader, persist its authoring metadata, reopen it, and verify freshness;
- run Room/Layout/Shader transitions after canonical runtime Shader cutover;
- produce a runtime package and a Linux Desktop platform export with all required Shader variants.

#### Exit gate

- every inventoried normal reader accepts exactly one current version;
- every affected current version has one canonical shape;
- no unresolved temporary debt remains;
- policy checkers and negative fixtures prevent regression;
- current docs contain no instruction to preserve old schema compatibility;
- complete editor/native/Web verification passes or an explicit blocking environment issue is
  recorded without marking the phase complete;
- permanent certification is checked in;
- this plan is archived and removed from active architecture plans.

## Phase Ordering and Cutover Safety

The order is mandatory for these reasons:

1. Phase 1 installs policy and a debt-aware checker before cleanup, avoiding a period where future
   agents can reintroduce removed branches.
2. Phases 2–4 remove independent manifest/persistence/resource fallbacks in numbered order after
   the guardrail exists, keeping each completed cutover as the baseline for the next phase.
3. Phase 5 canonicalizes authoring Shader evidence first so every later runtime producer receives one
   complete source representation.
4. Phase 6 then cuts all runtime Shader producers and consumers to one metadata/path contract.
5. Phase 7 changes role shape only after compiled-output churn is complete, keeping each native
   Shader phase reviewable.
6. Phase 8 audits the final graph rather than trusting the initial findings.

Do not combine Phases 5–7 into one agent task. They touch many of the same files but have different
invariants and failure modes. Separate phases reduce the chance that a passing end-to-end test hides
an unreviewed compatibility branch.

## Review Requirements Per Phase

Every implementation report must include:

1. exact compatibility branches and alternate shapes removed;
2. canonical producer and consumer paths changed;
3. negative rejection tests added;
4. temporary debt records removed or changed;
5. focused and aggregate validation results;
6. remaining compatibility debt by later phase;
7. any deliberate semantic optionality or permanent exception retained and why it is not backward
   compatibility;
8. confirmation that unrelated working-tree changes were not modified.

## Completion Criteria

This plan is complete only when all of the following are true:

- the permanent schema policy is authoritative and routed from agent documentation;
- `contracts.tsv` accounts for every versioned normal-read boundary;
- `temporary_debt.tsv` is empty;
- ComfyUI accepts exact strict V2 only;
- editor metadata accepts exact V2 only and local shell state has no migration;
- legacy export identity is neither stripped nor extracted from authoring content;
- compiled and preview image resources require explicit sampling;
- authoring Shader outputs use one complete metadata object and one authoring freshness identity;
- runtime Shader outputs use one strict metadata object and explicitly namespaced logical paths;
- runtime Shader roles and bindings use separate canonical fields;
- positive fixtures contain only current formats;
- old versions/shapes exist only in narrow negative rejection fixtures or archived history;
- policy, editor, native, Web, package/export, and manual certification gates pass;
- current documentation contains no compatibility promise contradicted by this policy.
