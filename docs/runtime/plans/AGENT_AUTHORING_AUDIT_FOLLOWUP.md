# Agent authoring audit follow-up

Source: the consumer audit of Feature Lab issue #257, implementation commit `4412ed4b`
(starting revision `c5b8856f`). The original report was handed off as
`/tmp/noveltea-agent-audit-20261004T204502Z-4412ed4b.md`; this page retains actionable status
without depending on that temporary file.

## Refinement status

All four outstanding tooling/documentation follow-ups are addressed. Finding IDs refer to the
consumer audit. Historical observations are not all attributed to one cause merely because the
current regression is repaired.

| Finding | Resolution and regression witness |
| --- | --- |
| F1: daemon observations disagreed with disk | Reproduced against the rebuilt standalone CLI: coherent Scene/Variable additions caused daemon-backed playback to report a missing `effects-panel/layout.lua`, while the same binary with `--no-daemon` passed. Workspace hydration exposed Lua `none` as empty inline source; reusable record projection then incorrectly made it a file selector. Source-contribution projection now preserves the absence of the authored companion while retaining normalized record defaults. The resident-workspace regression covers structural addition, normalized defaults, portable snapshot hydration, and continued companion absence. Standalone Feature Lab certification also checks playback after adding a Room to a warm daemon Project containing Lua-less Layouts. This explains the isolated companion-source failure; the audit's other historical stale-reference observations were not independently attributed. |
| F2: handled load did not restore dirty state | Repaired in `4412ed4b`; `save-and-resume-flow` passes. Dirty Property, quantity, Location and continuation assertions remain intact. |
| F3: UI preparation omitted declared locale catalogs | Repaired in `4412ed4b`; multilingual Project UI Tests pass. No authored package artifacts are required. |
| F4: default Mount state versus persisted Slot | Clarified in `docs/engine/LAYOUT.md` and the shared Agent Kit/human concept `docs/public/concepts/authored-tests.md`: reading the default does not create a persisted Slot, clear removes rather than commits the default, and state expectations require exactly one committed Slot. `save-and-resume-ui` remains the checked explicit-commit/save/change/load and clear/save/recreate/load example. |
| F5: committed/cleared Slot absent from retained save | Repaired in `4412ed4b`; committed-tree and clear/save/load assertions pass in `save-and-resume-ui`. |
| F6: startup context lost after load/publication | Repaired in `4412ed4b`; restart and retained-save assertions pass in `save-and-resume-ui`. |
| F7: Layout notifications absent from playback events | The UI Test frontend Lua VM lacked the Project localization catalog, so lowered `Text.msg` failed after the Property mutation and before `notify`. The runner now initializes frontend localization and active runtime locale. `localized-story-ui` asserts both Layout count notifications as well as Scene notifications. There is no intentional Layout-versus-Scene notification event distinction. |
| F8: development bridge cannot locate fallback font | The CMake development bridge supplies its configured runtime system-asset root in font-coverage requests when the caller does not select one. The native library retains executable-adjacent lookup for standalone distributions; a development path is not embedded into that library. Explicit roots remain authoritative. Failure identifies the logical fallback font and selected root. CTest exercises default/empty/invalid bridge roots, native tests exercise shaping and invalid-root attribution, and standalone certification verifies missing assets after relocation followed by success with executable-adjacent assets. Full Feature Lab validation through the development bridge passes. |

The callback diagnostic gap exposed by F7 is also repaired. RmlUi Lua call/load-string errors are
reported at error severity by the repository's `6f-lua-error-severity-1` patch. A devtools-independent
RuntimeUI error sink lets playback collect `tooling.ui_test_rmlui_error` diagnostics and tracebacks
at startup and settled input boundaries. A `ui-click` can still be `handled` because pointer dispatch
succeeded, but an uncaught callback error fails playback even with no expectations. Previously
committed mutations are not rolled back. Native coverage checks the error followed by a healthy
callback; standalone certification injects a post-mutation error into a copied Project and removes
all expectations to prove that diagnostics alone fail the Test.

## Completed verification

- Editor: `pnpm -C editor run check`; full tests with four workers: 2,556 passed, five skipped.
  Initial default-concurrency runs hit a Feature Lab compile timeout and a localization UI timing
  failure; both passed on focused rerun and in the full reduced-concurrency run, without unrelated
  test edits.
- Linux: full build, repository-pinned formatting, C++ policy, and 1,328 CTests passed under Xvfb.
  An earlier run outside an isolated Xvfb session timed out in presentation readback; the capture
  and verifier passed on isolated rerun and in the subsequent complete run.
- Web: full debug build and C++ policy passed. Linux/Web/sanitizer dependency reports agree on
  final RmlUi revision `6f-lua-error-severity-1` and its patch hash.
- Standalone CLI: rebuilt; `feature-lab-tests` certification passed, including the 38 authored
  Tests and new daemon/callback regressions. `native-operations` certification passed, including
  relocation-safe default font lookup.
- Development bridge: full Feature Lab validation passed without changing Project fonts.
- ASan/UBSan with leak detection, devtools disabled: all 91 UI-backend test cases passed, the four
  focused font/bridge/callback regressions passed, and `localized-story-ui` passed.
- Linux sandbox: compiled-package five-frame smoke completed successfully.

## Remaining acceptance and verification limits

No open code-direction decision remains from this refinement. Android verification could not run:
the environment has no configured Android SDK and the checkout has no `android/local.properties`.
Android, Windows, and macOS acceptance must not be inferred from the Linux/Web results. Perceptual
player locale/scale/thumbnail/audio acceptance and localized-audio procurement remain separate manual
Feature Lab work; passing authored Tests does not close those checks.
