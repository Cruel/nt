# Development Policy

Apply this policy to every NovelTea implementation task, alongside upstream skills such as
`implement` and `tdd`. NovelTea-specific rules take precedence where generic guidance leaves room
or conflicts with a documented repository rule; do not fork upstream skills to encode this policy.

## Meaningful tests

- Add or update tests when they protect meaningful externally observable behavior, contracts,
  invariants, failure modes, or integration boundaries. Identify a plausible regression the test
  would catch; implementation changes alone do not warrant a test. There is no one-new-test-per-change rule.
- Use the lowest sufficient layer: unit/component → semantic integration → authored semantic Test
  → authored UI Test → selected visual/readback integration → manual Feature Lab. Prefer existing
  seams over parallel test infrastructure; use visual tests when appearance itself is the contract.
- Bug fixes normally gain regression coverage when the exact behavior is not already protected.
  Update the natural existing test instead of duplicating it; use test-first regression reproduction
  where practical.
- Source/configuration tests are appropriate when the artifact itself is the external contract,
  rather than a proxy for runtime behavior.
- Keep ordinary implementation work focused on directly affected tests. Unrelated test cleanup
  belongs in a separately scoped audit or follow-up.

## Feature Lab applicability

Feature Lab is the in-tree authored Project for runtime acceptance and working reference examples,
not a replacement for focused automated tests. For authorable/runtime-observable changes, explicitly
choose **added/updated**, **already covered**, or **not applicable**, with a brief reason or coverage
pointer. This is a judgment call, not a requirement to modify the Lab for every change.

Implementation-only invariants without a meaningful manual manifestation are automation-only;
editor-only capabilities are outside the runtime Lab. If applicable Lab coverage cannot yet be added
because the Lab or required infrastructure is unavailable, record that gap and its follow-up rather
than claiming coverage or silently treating it as not applicable.

## Documentation

Document architecture, ownership boundaries, non-obvious rationale, and working procedures. Keep
code, schemas, manifests, validators, and generated references authoritative for facts they can
express clearly; link to them instead of duplicating their contents. Prefer executable validation
or CI enforcement for cheap structural rules.

Follow [documentation maintenance and routing](../OVERVIEW.md#documentation-maintenance-rules)
for placement and behavior-change updates. Keep each rule in one authoritative document and use
agent guidance and overviews as pointers.

## Completion report

Briefly state:

- **Tests:** the layer and checks run, coverage added/updated/already sufficient, or why no test was
  warranted; identify skipped verification and its reason. Use the repository's
  [verification guidance](../build/BUILD_AND_VERIFY.md) for commands.
- **Feature Lab:** added/updated, already covered, or not applicable with a reason; disclose any
  applicable coverage gap and follow-up.
- **Documentation:** what changed, or why no update was needed.
