# Schema Version Policy

## Governing Rule

NovelTea is an unreleased engine and editor. Every versioned schema, protocol, persisted state,
package format, generated manifest, and cache contract supports exactly one declared current version.
A version change replaces the previous contract atomically across all producers, consumers,
fixtures, tests, documentation, and development data.

Normal readers must not contain migrations, upgrade decoders, missing-version defaults, retired-field
aliases, dual writers, or old/new representation unions. This includes accepting alternate historical
shapes under the same numeric version. Historical conversion is permitted only through an explicitly
requested, separately invoked importer; no such importer is implied by this policy.

Because NovelTea is unreleased, an explicitly scoped implementation may preserve an already-selected
numeric version while atomically replacing its one canonical contract shape. That is a contract rewrite,
not compatibility: every producer, consumer, fixture, test, and document must move together, and the
replaced shape must be rejected immediately by normal readers. Do not infer this exception merely from
pre-release status; the owning issue or implementation instruction must explicitly require preserving the
selected version.

ComfyUI workflow manifests are one such explicitly selected rewrite: current `schemaVersion: 2` means the
generic public-ID contract with optional dotted `classification`, typed per-input defaults and binding arrays,
and media/cardinality outputs. The retired same-version semantic `role`, top-level `defaults`, single binding
object, binding/output `valueType`, and `image-list`/`primary` representation are noncanonical V2 data and
must be rejected rather than upgraded or interpreted.

Issue #105 preserves the already-selected ComfyUI verification-cache `schemaVersion: 1` while moving
workflow source identity from the retired Electron-specific `editor:` key space to the shared `user:` source.
Issue #106 preserves that same cache version while adding normalized `serverIdentity` to every canonical record
so verification cannot be reused across servers. Current verification records use only `built-in:`, `user:`, or
`project:` workflow keys and require server identity, package hash, and observed ComfyUI version. Same-version
cache data with the retired `editor:` source or without server identity is discarded rather than migrated or aliased.

The shared `noveltea.comfyui-user-config` contract remains at `formatVersion: 1` under the general NovelTea user
configuration root. Issue #109 explicitly rewrites that selected V1 shape in place so defaults are represented only as
an extensible dotted-classification-to-logical-workflow-ID map. The retired singular `defaultWorkflowId` alias and the
closed image-only classification map are noncanonical V1 data and are discarded rather than migrated or dual-read. The
current contract contains server URL, per-request timeout, and generic default-workflow mappings only; editor enablement
and periodic connection cadence are intentionally outside this machine-level contract.

## Definitions

- **Current version:** the one version emitted and accepted for a particular contract. Different
  contracts may use different version numbers.
- **Compatibility behavior:** logic that accepts, infers, upgrades, normalizes, or preserves an older
  version or retired representation.
- **Semantic optionality:** omission or nullability that belongs to the current product model rather
  than support for historical data. Strict wire producers still materialize fields required by the
  canonical boundary contract.
- **Importer:** a separately named and invoked conversion utility that reads an old artifact and
  writes a current artifact. Importers are outside normal open/load/restore paths.

## Required Failure Semantics

| Boundary | Unsupported or malformed input | Required action |
| --- | --- | --- |
| Root authoring project | Wrong or missing identity/version, unusable shape | Reject project open through structural diagnostics. |
| Embedded editor metadata | Absent | Create empty current metadata with the current content fingerprint. |
| Embedded editor metadata | Wrong/missing identity or version, malformed top level | Discard the complete metadata object, create empty current metadata, and warn. |
| Recovery entry inside valid current metadata | Malformed entry | Ignore only that entry and emit the existing recovery warning. |
| Browser-local shell session | Version mismatch or malformed state | Discard and initialize `shellSession: null`. |
| Editor tab or draft state | Wrong identity/version for the owning editor | Discard that state; do not invoke the editor restore path. |
| ComfyUI workflow manifest | Wrong/missing version or noncanonical shape | Mark invalid; do not execute, copy, install, or repair by interpretation. |
| ComfyUI shared user config | Wrong/missing identity/version or noncanonical fields | Discard it and use the current machine-level defaults; do not infer editor-local fields. |
| ComfyUI verification cache | Wrong/missing identity/version or malformed record | Discard the cache and rebuild current verification records. |
| Compiled project or package | Wrong version or noncanonical resource | Reject the complete artifact through decoder diagnostics. |
| Focused preview candidate | Wrong protocol/schema or resource shape | Reject the candidate and preserve the last committed preview. |
| Shader/material runtime document | Wrong schema or noncanonical Shader data | Reject the complete candidate/document. |
| Resource-alias manifest | Wrong/missing identity/version or alternate entry shape | Reject the complete manifest. |
| Player, template, export, registry, certification, or editor-stage manifest | Wrong identity/version | Reject, discard, or regenerate according to the inventory row; never normalize the old artifact. |
| Generated cache or compile output | Incompatible metadata | Discard or regenerate; never migrate. |

## Future Pre-Release Contract Changes

By default, a contract-shape change increments the single current version constant or schema tag. When
an explicitly scoped implementation instead requires preserving an already-selected version, keep that
number and perform the same atomic replacement without accepting the prior shape.

In either case:

1. Update every producer and consumer in the same change.
2. Replace checked-in fixtures and development data with the current form.
3. Update permanent contract documentation.
4. Replace positive coverage for the retired shape with focused rejection coverage where useful.
5. Remove the previous decoder, migration, alias, and dual writer.
6. Add a separately requested importer only when conversion is itself a product requirement.

## Automated Inventory and Guardrail

`cmake/schema_version_policy/contracts.tsv` is the authoritative inventory of versioned contracts.
Update it whenever a contract is introduced, removed, renamed, or changes version, owner, producers,
consumers, or failure action. Every listed path must exist. Contract markers must have literal
evidence in an inventoried producer or consumer, declared versions must be positive integers with
producer/consumer evidence, and owners must use the closed build/editor/engine ownership vocabulary.

Every row also names positive and negative fixture paths. The checker rejects missing evidence paths,
so adding a reader without current-version acceptance and unsupported-version rejection coverage is
not a complete contract change.

`rules.tsv` defines focused forbidden compatibility patterns. `exceptions.tsv` records reviewed
current-model uses that match mechanically but are not compatibility. `temporary_debt.tsv` records
known compatibility scheduled for removal by an active phase of the implementation plan. Entries use
exact files and exact match counts. Unlisted matches, stale records, malformed records, duplicates,
and incorrect counts fail the checker.

Run the policy through either:

```sh
cmake --build <build-dir> --target noveltea-schema-version-policy
pnpm -C editor run check:schema-version-policy
```

Behavioral rejection tests remain mandatory; the checker is supplemental static enforcement.

The latest repository-wide review and command evidence is recorded in
`docs/architecture/certifications/SCHEMA_VERSION_POLICY_CERTIFICATION.md`.
