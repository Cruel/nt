# Editor admission preserves repairable Project sources

Implementation specification: [#610](https://github.com/Cruel/nt/issues/610).

The follow-on working-source projection decision is documented in
[ADR 0002](0002-agent-editable-working-sources.md). It supersedes any implication
that agents should modify native recovery JSON or that a headless harness is
necessary to repair unsaved Project edits.

Status: design decisions accepted; implementation slices #611–#621 landed; final
cross-boundary and interactive certification tracked in [#622](https://github.com/Cruel/nt/issues/622)
and [the acceptance ledger](../editor/project/PROJECT_REPAIR_ACCEPTANCE.md). The agreed design
covers invalid-source editing, pre-admission candidate repair, CLI/AI assistance, conflict and
recovery handling, safe editor-owned writes, and format migration.

The editor distinguishes **editable Project source** from **runtime-valid Project content**. An invalid or malformed individual record is not grounds to reject the entire Project: its original source remains available for repair, its diagnostics identify the affected owner, and unrelated authoring and focused previews remain available when their dependencies are valid. The editor does not manufacture canonical replacement values.

Unsaved native recovery is a distinct source of user-owned work. A checkpoint containing recognizable unsaved edits, even invalid Project content, should restore that work. If it conflicts with changed disk content, preserve both versions and resolve only the affected owner. For a checkpoint that is wholly unreadable, archive its original bytes once as a last-resort manual-recovery fallback, remove it from active recovery, open the saved Project normally, show a nonblocking warning, and allow a fresh checkpoint to be created. Partially readable checkpoints should recover attributable valid entries without treating unparseable fragments as authoritative writes. A checkpoint whose recorded canonical Project root or Project ID does not match the selected Project must likewise be preserved as an archived copy, reported in a warning, and excluded from automatic replay; the saved Project opens normally. No corrupt or mismatched checkpoint should silently replace Project source.

Saving structurally identifiable but semantically invalid source content is allowed, with visible diagnostics; runtime compilation, packaging and export continue to require strict valid inputs. Source-level editing may preserve malformed YAML bytes, but structured field mutation must not pretend malformed content has been normalized. Safe project identity and filesystem/source ownership remain preconditions for privileged writes.

A failed Project candidate remains separate from the active Project. A pre-admission repair tab belongs to that verified candidate root and source revision, not to a fabricated active Project; source editing must use compare-and-swap and must not promote the candidate or replace an incumbent until admission succeeds. The normal diagnostic-to-field/source navigation contract should also be usable from a common **Fix it** workflow.

For individual diagnostics, **Fix** is scoped to the selected error or warning and its necessary dependencies. **Fix All** addresses all current errors and warnings; **Fix All Errors** includes errors only. There is no dedicated **Fix All Warnings** action. An AI repair run is an explicit user action with the selected candidate root, an editable and copyable prompt, an optional per-harness model override, and the selected harness's ordinary sandbox/permissions rather than an unrestricted override. The native editor host, not an arbitrary renderer-provided path, must authorize a candidate-scoped terminal cwd. The preferred model setting belongs to editor-wide user preferences per harness, with `default` omitting model flags. Each Run selector is populated only from detected installed executables (Claude, Codex, and OpenCode), using a quick host-side probe; when none exists, Run is disabled with an explanatory tooltip while Copy remains usable. Model lists are discovered per harness when available; discovery failure retains Default and optional manual model ID instead of blocking Run. A previously selected missing model is visibly flagged, not silently replaced.

A pre-admission repair session watches candidate source changes without adopting the candidate. Settled filesystem updates (including external AI writes) and manual source saves trigger debounced, read-only re-admission and diagnostic refresh. When admission becomes possible, the editor offers **Open Project** explicitly; it never automatically replaces an incumbent Project. These choices deliberately favor non-destructive editing and recovery over a whole-Project semantic-validity gate, while preserving strict runtime and mutation trust boundaries.

`noveltea repair project` prepares a selected candidate for repair even when its manifest is invalid. It may safely install or refresh the generated Agent Kit and NovelTea-managed `AGENTS.md` bootstrap instructions (preserving user-authored text), but never guesses or overwrites `project.yaml` or other authored Project content. Launching an AI Run explicitly authorizes that safe preparation without an extra confirmation; malformed or duplicate managed markers require manual resolution. Preflight uses independent candidate evidence instead of requiring normal Project admission.

Candidate evidence has two tiers: a recognizable `noveltea.project.workspace` discriminator in `project.yaml`, NovelTea-managed markers in `AGENTS.md`, or at least two independently recognizable canonical NovelTea sources suffice for strong recognition. A lone `project.yaml` without recognizable NovelTea markers permits manual inspection and requires explicit user authorization before AI writes; without recognizable evidence, AI repair is not automatically authorized. A missing `project.yaml` does not block candidate repair when independent evidence establishes a NovelTea Project; the user or agent can reconstruct the manifest from available source and current schema, but the CLI must not invent manifest content automatically. Generic `.gitignore`, empty record/Asset directories, and filename existence alone do not count as strong corroboration. Both tiers require independent containment, path and source-revision safety checks for editor-owned writes. Damaged identity must never be fabricated from incidental files.

A malformed Room or other individual YAML source may be saved as exact raw source bytes even if syntax errors remain, provided a trustworthy source path and revision-based compare-and-swap are available. The structured editor must not claim that invalid raw content is normalized or runtime-ready.

AI repair runs do not require a dedicated post-run diff/reviewer UI. **Run** is only a convenience launcher: start the installed Claude, Codex, or OpenCode **interactive TUI** in the candidate/active Project root with its usual user-configured defaults and optional explicitly selected model override. The generated **Copy prompt** also works without an installed harness or open editor. For unsaved native edits, the editor flushes the working-file publication first; the agent edits only the published working file and can independently verify it with `noveltea validate --working`. NovelTea does not implement an agent-specific sandbox, permissions layer, or provider integration and does not imply that setting `cwd` restricts all writes to the Project. Native main still authenticates the Project directory passed to the terminal launcher. Changes flow through existing observation, diagnostics and reconciliation; they do not automatically Save or activate a different Project. Users configure stronger agent protections in their chosen harness.

External saved edits to the same fields as unsaved editor changes retain local working values,
record a conflict, and require explicit **Use Disk** or **Keep Mine**. Disjoint field changes
merge automatically. #611 and #612 extended native first-open recovery to discover external
changes made *while the editor was closed*: replay supplies the saved base, local working state,
and current disk state to the resident reconciler, retaining both sides of overlaps and
reconciling independent paths. The renderer receives recovered conflicts on Open, rather than
treating them as a fatal Project admission failure. Affected owners remain blocked for ordinary
Save until resolved, while unrelated owners stay writable. This is the implementation contract;
see [external changes and conflicts](../editor/project/PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md)
for the current authoritative mechanics and #622 for certification evidence.

### Conflict resolution UX (accepted)

Before #614, the dialog's **Cancel** merely dismissed the unresolved prompt and **Use Disk**
discarded the whole save unit, even when only one Room field conflicted. This was replaced with
**Continue Editing** and path-scoped native **Use Disk**. The native per-path reconciliation
authority remains the same; no parallel conflict engine is introduced.

**Continue Editing** dismisses the dialog but leaves local working edits and
the conflict recorded, allowing further field edits. Ordinary Save requires
explicit resolution before overwriting overlapping external content; reopening
or later saves must not silently discard local work. **Use Disk** applies only
to conflicting paths and preserves unrelated dirty fields within the same
save unit. **Keep Mine** authorizes committing the user's current locally
edited result against a freshly verified disk revision; a subsequent disk
change requires a new decision. Unaffected save units remain editable and
savable. The native per-path Use Disk support is reused rather than introducing
a second conflict engine. #622 certifies edit-after-deferral, save-time
resolution, per-path preservation, and cross-restart persistence.

Both older and newer unsupported workspace versions can enter AI-assisted migration/repair. An older version may be migrated when the necessary source format can be established. A newer-than-supported version requires a prominent explicit warning before AI modification, because the installed editor/CLI schemas may not represent its data and `noveltea validate` may be unavailable until compatibility is restored. Do not silently reinterpret newer Project data as the current format or automatically downgrade its schema. Normal editor admission remains version-gated pending successful migration.

### Symlinks and candidate repair (accepted)

Do not require a whole-Project symlink safety scan before offering **Fix it** or **Run**; the user's chosen CLI harness operates with its normal user-configured defaults, and opening a repair candidate need not mean the editor has admitted every authored source. In particular, a symlink elsewhere in a broken Project should not automatically disable AI-assisted repair. Existing native containment checks for editor-owned source saves, transaction journals, Asset operations and local recovery paths should remain in force. A repair tab must only perform writes the native editor can verify and attribute to a selected Project source path with exact revision preconditions. If a specific target resolves outside the Project root, reject that editor-owned write with a targeted explanation rather than blocking the whole repair session. The user may use external tools (including a harness launched in the Project root) under their own permission configuration; cwd by itself does not confine its writes. This permission boundary is accepted; no additional whole-Project symlink scan or harness-specific sandbox is required.

Implementation must certify the agreed native recovery/repair paths, including offline conflicts, malformed and missing manifests, independent save-unit preservation, symlink-targeted rejection of unsafe editor-owned writes, and quarantine of unreadable or mismatched checkpoints. A dedicated AI review UI and NovelTea-specific harness sandbox/permissions integration are explicitly out of scope.
