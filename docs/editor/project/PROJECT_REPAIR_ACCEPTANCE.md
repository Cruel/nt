# Project repair and offline recovery acceptance — #622

Date: 2026-11-13. Parent contract: [#610](https://github.com/Cruel/nt/issues/610);
integration gate: [#622](https://github.com/Cruel/nt/issues/622).

## Certification boundary

The #611–#621 vertical slices are closed. This ledger records the cross-boundary
checks for the **shipped native CLI and Electron editor**, and keeps interactive
requirements separate from automated evidence. It does not add a second source,
checkpoint, watcher, or Project authority. An automated service or packaged IPC
test is **not** a claim that a person observed the complete UI journey.

The native Project and CLI contracts remain authoritative; consult
[workspace format](PROJECT_WORKSPACE_FORMAT.md),
[external changes/conflicts](PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md),
[CLI](../CLI.md), [Agent Kit](../AGENT_KIT.md), and
[Terminal](../TERMINAL.md) for the current supported behavior.
The accepted design is [ADR 0001](../../adr/0001-editor-admission-preserves-repairable-sources.md).
The older [Project saving certification](PROJECT_VALIDATION_AND_SAVING_CERTIFICATION.md)
has its own outstanding human acceptance; its automation must not be
misrepresented as human acceptance here.

## Acceptance matrix

The **Automated evidence** column points to existing owned test seams, not
another integration runner. All **manual** items still need a recorded desktop
pass or failure using the recipe below. A passing package smoke uses the real
main/preload/renderer/native worker but invokes guarded IPC programmatically;
it does not test click placement, dialogs, editor focus, or text usability.

| Journey | Automated evidence | Interactive acceptance |
| --- | --- | --- |
| Canonical Project, damaged Room/owner, malformed/missing manifest, partial repair | `native-candidate-repair-reopen.test.ts`, `project-candidate-repair.test.ts`, `native-authoring-reconciliation.test.ts`, native CLI repair suite | **Pending**: normal desktop Open, Fix it, raw Save, diagnostics, explicit Open Project |
| Incumbent/terminal/buffers survive failed candidate, late changes cannot activate it | Packaged `candidateRepair` smoke, `project-candidate-revalidation.test.ts`, `candidate-repair-store.test.ts` | **Pending**: active tabs, two candidates, late watch/agent output, Terminal session identity |
| Standalone relocated `repair project`, strong/weak evidence, atomic Agent Kit, custom AGENTS and ignore preservation, malformed markers, symlinks, rollback | `tests/native_cli/repair_project.py`, `certify-native-cli-public-contracts.mjs` | CLI automation sufficient for this sub-contract; inspect generated files on disposable copy if needed |
| Scoped Fix/All/All Errors prompt, copy without agent, diagnostic source navigation | `repair-prompt.test.ts`, `repair-prompt-dialog.test.tsx` | **Pending**: visible scopes, editable prompt, Copy when no agent |
| Installed Claude/Codex/OpenCode launch, authenticated cwd, defaults/model override, exit/retry/cancel | `repair-harness-service.test.ts`, `repair-model-catalog-service.test.ts`, `terminal-service.test.ts`, `terminal-package-smoke.test.ts` | **Pending**: actual installed authenticated harness invocation and output/cancel in real Terminal |
| Dirty YAML offline disjoint merge, overlap, deletion, independent Save, strict CAS and field-scoped Use Disk | Packaged `offlineRecovery` smoke, `native-authoring-reconciliation.test.ts`, `native-save-integration-608.test.ts`, `native-editor-session-controller.test.ts`, `project-external-conflict-dialog.test.tsx` | **Pending**: close application, external edit, reopen; Continue Editing, Use Disk, stale Keep Mine |
| Freeform source overlays, deletion and repeated restart without fatal replay | `native-dirty-recovery.test.ts`, `editor-project-recovery.test.ts` | **Pending**: real source editor, repeated close/reopen and Save |
| Corrupt/foreign/partially recoverable checkpoint quarantine and trustworthy disk | Native checkpoint/worker reconciliation tests under `editor/src/renderer/test/` | **Pending**: inject disposable corrupt and foreign evidence; verify warning and retained archived bytes |
| Symlink elsewhere allowed; unsafe targeted editor-owned write refused | CLI repair Python acceptance and `project-candidate-repair.test.ts` | **Pending**: separate irrelevant symlink from targeted unsafe source Save |
| Old/newer unsupported format AI warning/consent and no legacy normal-open fallback | CLI repair Python acceptance, candidate/prompt/IPC tests | **Pending**: older conversion and prominent newer-format warning |
| Strict dependency validation, runtime Tests, export/package, single authority | `native-editor-candidate-ipc.test.ts`, strict native CLI contract and existing export/runtime suites | **Pending**: malformed dependent Project, preview/Test/export refusal without blocking independent authoring |
| Native/editor/package/host delivery | Native CLI build, relocated public contract, full editor tests and packaged native IPC/PTY smoke | **Pending**: human desktop workflow and non-Linux host-specific UI verification |

## Reproduction on an interactive host

Use a disposable copy, never change `tests/projects/feature-lab/` in place.
Retain a byte-for-byte backup of each authored source and the ignored
`.noveltea/` recovery evidence before testing. Start an unmodified Feature
Lab copy as the incumbent and make a second copy for each destructive case.
Reset between cases rather than trying to infer a valid baseline from already
repaired files.

1. Open the incumbent and start at least one Terminal session. Damage the
   second copy's `project.yaml` (malformed syntax); separately delete the
   manifest, damage a Room's YAML syntax, and make a recognizable owner
   semantically invalid. Open each candidate normally. Assert source-located
   diagnostics, Fix it, raw source exactness, source Save, settled recheck, and
   **explicit** Open Project only when ready. Confirm incumbent tabs and
   existing PTY are unchanged until explicit activation.
2. In a valid-but-partly-invalid Project, edit and Save an independent Room
   and an invalid source. Reopen; inspect exact authored bytes and diagnostics.
   Confirm dependent validation, Play, authored Test and runtime package/export
   refuse invalid inputs without making unrelated owners uneditable.
3. From one diagnostic run Fix, Fix All Errors and Fix All separately. Check
   included warning/error scopes and referenced file/line. Copy the prompt
   with no harness installed. With a genuinely installed and authenticated
   Codex/OpenCode/Claude (as available), check Default and explicit model,
   candidate cwd, ordinary permission policy, safe prompt characters, output,
   exit, retry and cancel. Check missing/disappearing model behavior; do not
   assume a successful executable probe means an authenticated account.
4. Stage a dirty Room field, **quit the editor**, edit a different field in its
   YAML externally and reopen. Save and verify **both** edits on disk. Repeat
   with an overlapping edit: verify native conflict dialog, Continue Editing
   and changed local field, ordinary Save refusal, path-only Use Disk and other
   dirty paths preserved. For Keep Mine, edit disk *again* after the displayed
   comparison but before Save; verify stale CAS refusal and retained local work.
   Save a different Room while this conflict is still unresolved.
5. Repeat after an already-detected live conflict and with a deleted Room,
   structural array change, shared `editor.yaml` owner, and unsaved Lua/RML
   buffer. Repeat reopen twice without resolving; original evidence must
   survive and no automatic overwrite or fatal checkpoint replay may occur.
6. Inject (only into a disposable copy) wholly unreadable, foreign Project-ID,
   partial, unsupported and unsafe/symlinked recovery checkpoints. Check one
   quarantine/archival per bad checkpoint, nonblocking warning, preservation
   of recoverable independent entries and ability to create a fresh checkpoint.
7. Add a harmless symlink to a candidate unrelated to the repair target; Run
   remains available. Separately target a symlink that leaves the candidate
   root with an editor-owned raw source Save: it must reject precisely and
   leave the outside file unchanged.
8. Test weak manifest-only consent, older unsupported format requiring
   explicit conversion, and newer format requiring a prominent AI modification
   warning. Neither normal Open nor validate may silently accept old/new
   schemas. Check a late watcher event or completed harness edit cannot
   activate a superseded candidate.

Record the exact editor package identity/commit, host OS/architecture, installed
harness versions and authentication availability, file hashes before/after,
screenshots or session logs for each nontrivial transition, and pass/fail for
each item. If any is not executable, record it as **not run**, not passed.

## Verification log

Source checkout at start of work: `a36445522ca792cc62c697ff8e65e76698977b1e`
(`master`; no preexisting modifications). Linux x64, tty-only host with
Xvfb; Node 24.18.0 selected explicitly for build/verification.

- `pnpm -C editor run check`: **pass** (format, lint, typecheck, schema policy).
- `pnpm -C editor run test`: **pass** — 314 test files / 2,369 tests,
  14 files / 198 tests skipped, many of them conditional on native addon.
- `pnpm -C editor run noveltea:build` (with `VCPKG_ROOT` configured):
  **pass** — fresh native executable and relocated CLI smoke.
- `python3 tests/native_cli/repair_project.py build/cli/linux/noveltea`:
  **pass** — relocated repair/Agent Kit/path/rollback contract.
- `node editor/scripts/certify-native-cli-public-contracts.mjs build/cli/linux/noveltea --production`:
  **pass** — 27 native public JSON contract commands.
- `pnpm -C editor run build`: **pass** — main, preload, renderer and native worker.
- Real-addon targeted integration with `NOVELTEA_AUTHORING_NODE_ADDON` pointing to
  the freshly rebuilt native module: **pass** — 7 suites, 133 tests passed,
  2 skipped. Includes malformed Room Save/reopen, first-discovered offline
  conflicts and field-scoped Use Disk, native renderer/main IPC, and recovery
  quarantine cases.
- `ctest --test-dir build/native-authoring-host --output-on-failure`: **pass**
  — 45/45 native CTests. The first attempt used an out-of-date
  `noveltea-project-session-certify` executable (built before the `--repairable-records`
  case was added), yielding a zero-output failure for that one case. After
  rebuilding this CTest target, the focused repairable-record case and all 45
  tests passed. This was stale test build state, not a production behavior fix.
- `pnpm -C editor run package` with the built addon and `VCPKG_ROOT`:
  **pass** — production dependency/ASAR/native resource verification on Linux x64.
- `pnpm -C editor run package:smoke`: **pass** — all packaged checks,
  including `candidateRepair` and `offlineRecovery`. The Xvfb Electron
  renderer exercised guarded preload IPC, failed candidate Open, incumbent
  protection, raw source CAS Save, revalidation and explicit Open. It also
  closed a dirty native Project session, modified YAML on disk while the
  session was closed, reopened the Project with the recovered path conflict,
  verified ordinary Save refusal, applied path-scoped Use Disk, and verified
  that both the external disk field and unrelated local field survived the
  subsequent native Save. Existing packaged CLI, preview, sharp, ffmpeg,
  protocol and Terminal node-pty checks also passed. This run used an uncommitted
  development package identity `1.0.0-dev.a36445522ca7` and does not
  constitute an immutable release qualification.

**Real harness limitation:** Codex CLI 0.162.1 and OpenCode 1.18.35 are on
this host; Claude Code is not. `codex login status` reported an existing
ChatGPT login, but a harmless headless Codex prompt run in an isolated temporary
Git directory timed out after 120 seconds (exit 124), without completing a turn.
OpenCode reports zero configured credentials. No live authenticated harness
completion, model-catalog success or user permission interaction is certified.
The shipped invocation argv/model/IPC trust and packaged Terminal PTY behavior
have separate passing automated checks.

**Host limitations:** The Linux machine exposes no interactive physical
desktop session (`XDG_SESSION_TYPE=tty`). Xvfb drives real Electron IPC and
native code, but not manual GUI focus/dialog acceptance. Windows and macOS
packaged editor interaction was not run on this Linux host. All interactive
checks above remain **not run**. Keep #622 open until required interactive
integration checks complete or failures are routed to the responsible
vertical tickets.

## November 13 interactive follow-up: invalid native recovery and repair UI

A user Project failed Open with
`Native Project recovery cannot prepare dirty content: Cannot prepare invalid working
record rooms/director-completion-demo`. The **disk manifest was not invalid**.
The native dirty checkpoint carried two unsaved Room changes: a normal display
name and an unfinished text-source switch to `localized` with an empty key.
The failed native replay preparation was misclassified as a damaged pre-admission
Project Candidate, and **Fix it** consequently opened the unrelated
`project.yaml` source (at a locale-list line).

Native editor projection now retains an invalid dirty Room in the native
journal without publishing an unvalidated record as typed editor content.
The saved effective Room remains the structured display fallback until the
draft becomes valid; the restored native working snapshot reports the offending
Room diagnostic. On Open, main publishes **replayed** validation diagnostics
rather than stale saved-source diagnostics. Runtime/Test/export strict
validation is unchanged. The regression reproduces the exact two-owner
checkpoint pattern on a disposable Feature Lab copy and verifies successful
Open, recovered valid owner, native recovery retention, Room-owned diagnostics
and unchanged physical YAML.

The embedded Terminal may load additional PATH entries from a user's shell
startup files that the Electron main process never sees. Repair discovery,
model lookup, and launch now query the same selected shell used by Terminal
for its effective PATH, using a fixed, bounded shell command. No user
installation directories are hardcoded; if shell startup fails, the inherited
environment remains in force. The independent probe regression demonstrates
discovery from a custom tool directory absent from the GUI PATH and validates
`opencode v2.0.28` as well as bare-version formats. A second
repair UI problem was an auto-sized CodeMirror host inside an overflow-clipped
candidate panel; the candidate editor now supplies a full-height, minimum-zero
host so CodeMirror's own scrolling element receives the bounded viewport.

**Limits requiring interactive confirmation:** The structured form shows the
last valid saved representation of a schema-invalid recovered Room; invalid
unsaved fields remain in native recovery and are not silently written to
physical YAML. Verify the workflow for editing or explicitly discarding these
fields, rather than assuming an AI tool's disk edits also resolve an unsaved
native draft. Recheck candidate YAML scrolling by mouse wheel, trackpad and
scrollbar, and confirm Codex/OpenCode appear and can launch via the **Fix**
prompt in a real desktop session. The `Fix it` action for malformed physical
candidates remains a raw-source editor, not an automatic AI invocation; scoped
Fix/Run or Copy is the separate diagnostic action.

**Verification:** Native addon integration (including the new exact checkpoint
reproduction) and repair harness host tests: 51 passed. Native
`native_authoring_project_session`, `invalid_manifest`, `repairable_records`,
and `working_preparation` CTests: 4/4 passed on the locally rebuilt
`linux-debug` target. The first full editor run reached 2,365 passed and four
failures in Character editor and workspace recovery debounce; rerunning both
affected suites in isolation passed 48/48. A second full run reached 2,368
passed and one remaining workspace recovery-debounce failure; that entire
41-test suite passed again in isolation. This is an unresolved aggregate-run
intermittence, not a passing full-suite certification. Editor
`check` (format, lint, typechecking and schema policy) passed. The pinned C++
format-check target was attempted but the developer machine lacks `uv`,
required by the repository's clang-format 18.1.8 runner. This does not certify
formatter success. Do not close #622 on these automated results alone.

## Feature Lab and documentation

Feature Lab: **already covered as a valid authored reference**; use only a
disposable deliberately damaged copy for this acceptance. Committing broken
source into the canonical Lab would make runtime acceptance unreliable.

The existing current Project, CLI, Agent Kit, Terminal and conflict docs were
reviewed against the #610 contract and remain the behavioral references.
This evidence ledger and the status correction in ADR 0001 reconcile the
certification state. No editor localization string changes are needed because
the new smoke proof is non-user-facing and introduces no new visible copy.
