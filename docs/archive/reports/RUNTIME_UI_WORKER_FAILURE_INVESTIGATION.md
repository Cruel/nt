# RuntimeUI worker failure investigation — 2026-10-04

Historical verification record for the remaining F6 handoff at `a386f9ab`.
Current contracts live in `docs/ui/RMLUI_RUNTIME_UI.md` and `docs/editor/CLI.md`.

## Two distinct reproduced failures

### Inner RuntimeUI runner SIGSEGV

Repeated `verbs-and-offers-{rank,ambiguity,builder,rebind}-ui` invocations in an isolated
Feature Lab copy failed on iteration 10 of the rank Test (36 preceding successful Tests).
The CLI reported status 139 / signal 11, with both runtime and Test-catalog cache hits.
Retained evidence: `/tmp/noveltea-ui-test-30463541660299388-1/{request.json,runner.log}`.
The log ended with RmlUi's data-expression empty-stack warning, not a Lua VM error.

Replaying that exact request directly with the optimized runner crashed on iteration 6;
removing the initial zero-duration tick still crashed on iteration 5. LLDB symbolized the
core against the matching unstripped `linux-authoring-release` binary. The stack was
`DataExpression::Run → DataControllerEvent::ProcessEvent → EventDispatcher::DispatchEvent
→ Context::ProcessMouseButtonUp → RuntimeUiPlaybackDriver::click`.

Selector playback lacked SDL input's action capture. Immediate host submission could
reconcile/remove the originating Layout, context and executing event controller. Playback
now captures typed inputs until event dispatch and the Layout capability scope return.
A deterministic backend regression detects premature submission without deliberately
executing a use-after-free; its post-dispatch sink removes the originating document and
receives both captured commands in order. It failed before the change and passes afterward.

### Outer disposable worker completion loss

With the fixed inner runner, a cold full-suite daemon invocation still returned exit 70:
`DAEMON_EXECUTION: daemon disposable worker exited unexpectedly`. Focused cold Tests passed,
but repeated full-suite runs reproduced the failure. No core was produced even with core
limits lifted. Attaching LLDB to the disposable worker proved normal process exit, status 0.

The complete CLI report was 1,109,352 bytes. Its completion JSON was approximately
1,264,233 bytes, exceeding the daemon's former 1,048,576-byte frame limit. Completion
submission failed; the one-job worker exited normally, and the broker later diagnosed its
remaining active request as worker loss. A cached/static suite bypassed this transport,
explaining why reruns through different cache states could pass.

Daemon frames now admit 16 MiB. Both worker-control completion and broker-to-client
completion replace oversized results with an explicit transport-limit failure. They do
not retry computation or truncate passing reports. Native regressions protect fragmented
large-report framing, the upper bound, and caller-visible oversized-completion failure.
Both new regression paths failed before their fixes.

## Verification

- Optimized fixed runner: 100 successful replays of the exact crashing request.
- Fixed ASan/UBSan runner: 30 successful request replays. The original sanitizer runner
  also passed 20 minimized replays, so sanitizer silence alone was not root-cause evidence.
- Public CLI using the fixed optimized runner: 150 focused interaction UI Tests passed.
- Rebuilt standalone CLI, without runner overrides: three consecutive cold full-suite
  daemon/disposable executions passed, 34 Tests each. Explicit no-daemon preparation and
  the subsequent static/cache-hit suite also passed, 34 Tests each.
- Linux focused CTest matrix: 147 passed, including daemon, RuntimeUI/RmlUi, native UI
  playback and external-worker evidence preservation.
- ASan/UBSan with leak detection: all 90 UI backend cases and all 46 daemon cases passed.
- Linux sandbox `--frames 3`, Linux C++ policy, Web engine and Web C++ policy passed.
- Feature Lab validator: 21 scenarios / 145 checks valid. Existing authored Tests already
  cover the affected gameplay paths; no Lab-only flags or authored-content workarounds.
- Editor check/build passed; full suite: 2,554 passed, five existing skipped Tests. The
  independent raster-policy recovery regression now preserves invalid strings while
  rejecting missing/non-string values; strict saving/export validation is unchanged.
- Repository format-check still encounters pre-existing formatting errors in
  `engine/src/core/editor_runtime_protocol.cpp`. Touched engine/test files pass the
  repository-pinned formatter; unrelated formatting was not retained.

Original CLI SHA-256: `022844d19199abdd8860dcd20ecbb3d8448e66003efcb425f7669d2693fb6954`.
Original inner runner SHA-256: `a69e56d65c5378cef97fa65ceed15578daef0c8d62278166d54f60ca971f188b`.
Detailed session artifacts and final binary hashes were retained under `/tmp/nt-f6/`.

## Scope and remaining observations

These fixes explain the reproduced inner SIGSEGV and outer normal-exit completion loss.
They are not proof that every historical abort or stall shared those causes. Retain
`runner.log` and exact binary/cache/invocation identity on any recurrence.

The isolated daemon preparation runs repeatedly declined cache publication with
`inputs-changed-during-preparation` despite no intentional Project edits. Playback still
passed, and explicit no-daemon preparation published a reusable cache. That non-fatal cache
publication observation is outside these crash/transport fixes and remains a follow-up.
