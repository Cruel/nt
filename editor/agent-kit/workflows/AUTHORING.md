# File-first authoring workflow

Use this page for coding-agent operating procedure. Domain meaning belongs in `concepts/`; exact
serialized structure and non-obvious schema semantics belong in the generated `reference/` pages.

## Inspect before editing

Start from the installed contract, not assumptions:

1. Read the relevant concept page.
2. Read the matching generated reference page.
3. Inspect nearby project records for local conventions and existing IDs/references.
4. For a new top-level record, use `noveltea entity create <collection> <id>` when practical and edit
   the initialized result.

Raw JSON Schema under `.noveltea/agent/schemas/` is an exhaustive fallback. It is not the preferred
way to learn NovelTea semantics when the compact reference already explains them.

## Edit tracked source, not generated state

The project root contains `project.json`. Editable source lives in the tracked Project workspace:
`project.json`, `traits.json`, `editor.json`, `i18n/`, `records/`, `scripts/`, `shaders/`, and `assets/`.
Never author against `.noveltea/`.

Stable top-level record IDs determine canonical record paths. Non-Layout records use
`records/<collection>/<id>.json`; Layouts use `records/layouts/<id>/layout.json` plus their admitted
companion source files. Do not rename a file independently of its record identity.

Script Module project-file paths stay under `scripts/` and must retain one canonical owner. Do not
use absolute paths, parent traversal, or symlink escapes. Tracked JSON is UTF-8, LF, two-space
indented, and ends with one newline; avoid unrelated formatting churn.

## Direct edits versus semantic CLI operations

Ordinary field changes are direct source edits. Do not invent field-level setter commands.

Use the CLI when the operation needs canonical initialization, whole-project reference knowledge,
transactions, external tooling, or execution. Common examples are entity create/rename/delete/usages,
Asset import/audit, localization workflows, shader compilation, authored Tests, Project transport,
and package/platform export. Use `noveltea --help` for the installed command surface and `--json`
where supported when deterministic machine-readable output is useful.

Use `--dry-run` on semantic mutations when the command supports it. A semantic command evaluates the
current project, so diagnostics produced while a multi-record edit is only half complete are not the
final verdict on the intended coherent change.

## Complete coherent edits

Many operations span multiple records. For example, presenting a new exact Interactable in a Room
can involve a Definition, a declared Instance in `project.json`, Room placement/presentation linkage,
and Interaction/Verb support. The shared concepts explain those ownership boundaries and the generated
reference provides the current fields; do not keep a private template that may drift from either.

Finish the complete logical relationship, then run:

```sh
noveltea validate
```

Run relevant authored Tests when the behavior is covered by semantic playback. Validation proves
structural/semantic validity, not visual quality of placement, hotspot geometry, styling, or art.

Layout records are directories. In `records/layouts/<layout-id>/layout.json`, a persisted
`sourceMode: "file"` selector means the channel source lives beside the record as `layout.rml`,
`layout.rcss`, or `layout.lua`. Do not leave one of those companion files present when its selector is
`asset` or `none`; workspace loading treats that as an ownership error rather than an alternate source.

## Prove Interaction behavior at the right surface

Read `concepts/interactions.md` first, then generated `reference/records/verbs.md`,
`reference/records/interactions.md`, and `reference/records/tests.md`. Do not infer discovery from
execution: successful direct `run-interaction` is not proof of Offer discovery.

- Prefer semantic authored Test inputs for command resolution, Guard fallthrough, fallback, named
  bindings, and authoritative state changes.
- Use actual RuntimeUI automation when proving menu presentation, selection, or Command Builder
  interaction. Open the menu and click the intended semantic action; use the built-in selectors in
  `technical/LAYOUTS.md`, not positional `nth-child`/`nth-of-type` selectors. A semantic Primary input
  can set up capture, but is not a witness that a particular rendered control works.
- For specificity, ranking, and suppression, make competing outcomes observably distinct or assert
  the actual presentation path. Running the same complete command cannot distinguish which Offer
  was published. Use a Layout/presentation assertion when the absence or presence of a menu matters.
- Prefer authoritative Property, Location, quantity, Flow, Layout, event, or diagnostic expectations
  over marker variables whose only purpose is to say “the test passed.”

Keep canonical Feature Lab examples validation/diagnostic clean. Disjoint Verb/rule selector spaces,
unconditional equal-tier/equal-priority conflicts, and equivalent spaces permanently dominated by an
unconditional higher-priority rule are static errors, not canonical demonstrations. Put deliberately
invalid/unreachable/ambiguous configurations in focused validation/native negative tests. Guarded
overlap, live Traits/identities, and Lua predicates may be runtime-dependent; analyzer warnings or
conditional analysis are not proof that a command will succeed or fail.

Authored Test playback currently treats runtime error diagnostics as test errors, even with a matching
diagnostic expectation. Intentional runtime ambiguity, immediate rejection, and failure after an
observable boundary therefore need a focused executable negative-test surface, or a precisely recorded
manual gap when that surface is unavailable. Do not invent Lab-only success flags or private hooks to
turn expected failures green, and do not weaken analyzer diagnostics to admit a demonstration.

## Localization is an explicit mutation workflow

Direct edits to managed localizable Lua/RML do not update tracking as a side effect of validation or
preview. Run `noveltea localization sync` after those edits. If sync reports ambiguous identity, use
`noveltea localization reconcile --json`, resolve the returned revision/fingerprint-bound plan
explicitly, then apply it. Do not choose Message identity by textual similarity alone.

Use `noveltea localization view <locale>` for the joined source/target queue. `localization accept`
acknowledges source freshness; `localization review` records review of a Current valid target. These
operations preserve localization identity and provenance rather than treating target files as an
unstructured string dump.
