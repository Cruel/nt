# Compatibility Version Policy

## Governing Rule

NovelTea versions **compatibility boundaries**, not schemas merely because they are serialized,
persisted, validated, or represented as JSON.

A contract earns an independent compatibility version only when one build, installation, process,
or durable artifact may be produced independently and consumed later by another compatible build,
installation, or process. Nested implementation state inherits the compatibility boundary that owns
it. Disposable state, caches, generated reports, and same-build internal documents remain strictly
validated but are not independently versioned.

NovelTea is unreleased. Every compatibility boundary is currently in the `development` lifecycle and
is fixed at version **1**. Incompatible development changes replace the current V1 shape atomically;
they do **not** increment a version. A version may begin advancing only after that boundary is
explicitly promoted to `stable`.

Agents and contributors must never infer a compatibility-version bump from a schema edit. A bump is
an explicit compatibility/release decision.

## Current Compatibility Boundaries

`cmake/schema_version_policy/contracts.tsv` is the authoritative inventory. The current boundaries
are:

| Boundary | Version | Meaning |
| --- | ---: | --- |
| Project Workspace Format | 1 | Authored project files on disk. |
| Compiled Project Format | 1 | Compiler output consumed by a compatible runtime. |
| Save File Format | 1 | Physical `.ntsav` representation. |
| Player Template Format | 1 | Installable/downloadable player-template package and descriptor. |
| Player Runtime API | 1 | Editor-generated bootstrap/package metadata consumed by the player. |
| NovelTea User Config Format | 1 | Shared `~/.noveltea/config.json` for editor and CLI. |
| ComfyUI Workflow Manifest | 1 | Importable/shareable ComfyUI workflow package manifest. |
| Editor Runtime Protocol | 1 | Editor/runtime preview, playback, profiling, and related IPC. |
| Runtime User Settings Format | 1 | Player-side user settings that survive game/runtime updates. |
| CLI JSON Protocol | 1 | Machine-readable `noveltea --json` interface. |

No other current schema has an independent compatibility epoch unless it is first added to this
inventory by an explicit architecture decision.

## What Is Not Independently Versioned

Examples include the assembled `AuthoringProject`, editor project/local/session state, individual tab
and draft payloads, preview documents nested inside Editor Runtime Protocol, shader/material preview
documents, prepared runtime artifacts, workspace transaction journals, verification caches, export
profiles and generated export manifests, template registry records, certification/build reports,
resource-alias manifests, generated Agent Kit manifests, and the runtime-package manifest itself.

These contracts should still use strict schemas, discriminators, validation, hashes, or regeneration
rules where useful. Removing a numeric version does not make them loosely typed.

For disposable or regenerable data, incompatibility means discard/regenerate. For authored project
records, compatibility inherits Project Workspace Format. For compiled runtime records, compatibility
inherits Compiled Project Format. For preview/runtime messages, compatibility inherits Editor Runtime
Protocol. Runtime-package/bootstrap metadata crossing the editor-to-player seam inherits Player
Runtime API.

## Development and Stable Lifecycles

### `development`

- The compatibility version must remain `1`.
- The canonical shape may change incompatibly at any time.
- Producers, consumers, fixtures, tests, and documentation move together.
- Normal readers support only the current shape; do not add migrations, aliases, dual readers, or
  missing-version fallbacks for replaced development shapes.

### `stable`

Promotion to `stable` is an explicit release/architecture decision recorded in the inventory. After
promotion, an incompatible boundary change requires an explicit version bump and an explicit decision
about compatibility/import behavior. Source API names still remain stable; version suffixes are used
only for deliberately coexisting historical decoders/types.

## Stable Source Naming

Current source APIs and filenames do not carry their serialized compatibility number. Prefer:

```text
CompiledProjectWire
compiledProjectWireSchema
parseCompiledProjectWire()
serializeCompiledProjectWire()
compiled-project.ts
COMPILED_PROJECT_WIRE.md
```

Do not use current-only names such as `CompiledProjectWireV1`, `foo-v2.ts`, or schema identities such
as `noveltea.foo.v2`. A `V1`/`V2` source suffix is justified only when multiple historical versions
intentionally coexist in the same source tree.

Likewise, current user/config/cache paths should be stable (`config.json`, `templates/`,
`verification-cache.json`) instead of embedding the current compatibility number.

## Boundary-Specific Notes

### Project authoring

Project Workspace Format owns authored-project persistence. The assembled `AuthoringProject` is an
in-memory validated aggregate and has no independent version.

### Save files

Save File Format owns the physical `.ntsav` envelope. The inner runtime save-state document is not
independently versioned. `saveContract` is deliberately separate: the file-format version answers
whether the runtime can decode the save file, while `saveContract` answers whether a particular
compiled game can safely consume its contents.

### Player templates

A template records three independent compatibility facts:

- Player Template Format version;
- Compiled Project Format version;
- Player Runtime API version.

Do not split Player Runtime API into per-document `runtimePackageApi`, `playerConfigApi`, or similar
epochs when those documents cross the same editor-to-player seam.

The `.ntpkg` manifest therefore carries `runtime_api_version`, not its own package-format epoch. That
field is the Player Runtime API version and must use the same constant as player bootstrap/config
validation.

### User configuration

Durable editor and CLI settings share `~/.noveltea/config.json`. Consumers may use only the sections
they need. Subsections such as ComfyUI or export/signing configuration do not have independent format
versions; they inherit NovelTea User Config Format.

### Editor/runtime communication

Preview documents, playback messages, profiler payloads, and related packets inherit one Editor
Runtime Protocol version. Individual packet/document schemas may have discriminators but not separate
numeric compatibility epochs.

## Failure Semantics

- Wrong/malformed durable boundary input: reject it rather than guessing or migrating it implicitly.
- Invalid disposable/local/cache state: discard or regenerate it.
- Invalid nested authored state: fail according to the owning Project Workspace validation policy.
- Wrong editor/runtime protocol: reject the message/candidate and preserve the last valid runtime or
  preview state when applicable.
- Wrong template compatibility declarations: keep the descriptor parseable when practical so the
  editor can report a precise compatibility mismatch, but do not use the incompatible template.

Historical conversion is permitted only through a separately named/imported conversion path when it
becomes a product requirement.

## Automated Guardrails

The schema-version policy checker validates the authoritative compatibility inventory and rejects
development rows whose version is not `1`. It also scans production source for common accidental
version-proliferation patterns such as version-suffixed NovelTea schema identities, current model/type
names ending in `Vn`, and version-numbered user/config/cache paths.

`rules.tsv`, `exceptions.tsv`, and `temporary_debt.tsv` continue to enforce focused compatibility-debt
patterns. Exceptions must be narrow and reviewed; temporary debt must name its planned removal phase.

Run the policy with either:

```sh
cmake --build <build-dir> --target noveltea-schema-version-policy
pnpm -C editor run check:schema-version-policy
```

Behavioral tests remain mandatory. Static policy checks supplement rather than replace producer/
consumer and rejection coverage.
