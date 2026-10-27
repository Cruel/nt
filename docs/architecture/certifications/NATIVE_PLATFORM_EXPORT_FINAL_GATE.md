# Native platform export final gate (#569)

Status as of 2026-10-27: **in progress; final CI evidence pending**.
Parent #545 and production CLI cutover #551 remain separate decisions.

## Scope and evidence rules

The project owner revised #569's completion threshold on 2026-10-27: **a
successful end-to-end Linux export certification plus passing existing GitHub
Build and Release platform workflows is sufficient**. Explicit TypeScript vs
C++ *export-output* differential testing is no longer required for #569.
The existing platform-command differential is retained as additional coverage,
not as a prerequisite for comprehensive exporter parity.

The final CI run must be tied to the qualifying source revision, and its
platform-specific evidence must establish:

1. Real direct-C++ CLI invocation using the generated player template and
   authored fixture, including `--check`, archive/output inspection and a
   complete success envelope. A successful command without complete readback
   is not sufficient.
2. Portable Linux export **and actual player launch** from an unrelated
   working directory, with ZIP/tar integrity and AppImage launch/extraction
   where the CI-provisioned tool is available.
3. Windows, Web, macOS and Android CI checks covering their real export,
   packaging, host-specific launch/browser/emulator when available, plus the
   existing focused negative-path, recovery, signing/config and drift tests.
4. No failed, cancelled, skipped-required, or still-running platform jobs in
   the qualifying CI workflows; report credential-dependent limitations as
   unavailable, not passed.
5. Completion status of #563-#568 and explicit disposition of #545, without
   activating #551 or closing #545 automatically.

Host-only checks may be recorded as unavailable **with reasons**, but may not
be represented as passed. Without real signing credentials, tests of a mock
signer are evidence of the signing pipeline only, not of production certificate
chains, notarization or timestamp services. Android emulator and arm64 device
qualification are separate from cross-host artifact assembly.

## Current local evidence

The Linux checkout successfully built `noveltea-native-cli`,
`noveltea-cli-platform-publication-certify`,
`noveltea-cli-macos-export-certify` and
`noveltea-cli-android-export-certify` with `linux-debug`. Then:

```
ctest --test-dir build/linux-debug --output-on-failure \
  -R '^native_cli_(platform_commands|platform_publication|macos_export|android_export|windows_pe_resources)$'
```

passed **5/5** tests on Linux. This certifies the synthetic direct-C++
template/config, Windows PE, cross-host macOS/Android staging and publication
failure/recovery seams. `native_cli_platform_commands` also runs a local ELF
fixture from an unrelated working directory and verifies Web/Linux manifest
and archive bytes. It is not evidence that actual release binaries have launched
on Windows/macOS or been installed on an Android device.

### End-to-end Linux export: passed locally

On revision `d80e3368`, the real `linux-debug` player was packaged into a
Linux x64 template. The initial unstripped template (775 MiB player) exceeded
the release smoke harness's 240-second template-install deadline. For the
successful run, a temporary, **uncommitted** copy of the same ELF was stripped
of debug sections, the template file size/SHA-256 descriptor was regenerated,
and the template's standalone symbol entries were omitted. This is a local
test fixture, **not** a qualified production glibc-2.28 release template.

The existing `tests/native_cli/linux_release_smoke.py` then **passed** using
the direct C++ `build/linux-debug/tools/editor_tool/native-cli/noveltea`, a
real authored Project fixture, Xvfb, and the existing upstream AppImage tool.
It verified successful `--check` without publishing, Linux export, manifest
hashes and tar.gz member readback for **149 files**, a real portable player
launch from an unrelated working directory, plus AppImage creation, launch,
extraction and member-by-member readback. Both launch paths entered their
player runtime rather than failing startup. The harness intentionally sends
SIGTERM to a player still running after its observation window; an AppImage
return code of `-15` therefore indicates a successful live-launch smoke, not a
crash. Evidence: `build/nt569-smoke/certification.json` (local, untracked).

This satisfies the owner-requested **local Linux export certification**.
Release runner evidence for the actual optimized, pinned-glibc release binary
and the remaining four platform hosts is still required from passing CI.

The additional installed-C++ differential is:

```
NOVELTEA_NATIVE_CLI_BINARY="$PWD/build/linux-debug/tools/editor_tool/native-cli/noveltea" \
  pnpm -C editor exec vp test \
    src/renderer/test/native-platform-command-differential.test.ts
```

It passes using independent, freshly created registries for the established
TypeScript platform command service and the relocated direct-C++ executable.
It compares empty/installed/corrupted/missing template projections, install,
inspect, list, remove, missing-template diagnostics and `config init` output
including forced replacement. The Linux Build workflow repeats this check
against the installed release native binary. This **does not** compare the five
export target staging outputs; **that comparison is no longer required for
closure under the revised acceptance criteria**.

## Outstanding final acceptance

| Requirement | Current evidence | Outstanding |
| --- | --- | --- |
| Shared templates, config, trust and recovery | #563 and Linux native CTest; direct/TS command differential | Qualifying Build CI results and any remaining reported failures |
| Windows x64 | #564 C++ PE tests and Windows CI configured for real release launch | Qualifying Windows CI evidence; report credential-only signing/timestamp limits |
| Web wasm32 | #565 C++ Web publication and release browser harness | Qualifying Web CI evidence for supported builds |
| Linux x64 | #566 native ELF/archives/symbols tests; local real portable and AppImage smoke passed (149 manifest-verified files) | Qualifying production release CI evidence against pinned glibc baseline |
| macOS arm64 | #567 Mach-O/ZIP C++ tests and macOS release smoke wiring | Qualifying macOS CI evidence; report notarization credential limits |
| Android arm64/x86_64 | #568 cross-host C++ tests and Android release/emulator workflows | Qualifying Android CI evidence; report any physical device limitations |
| #545 parent | No ScriptC/QuickJS/player rewrite in these export changes | Evaluate parent requirements separately; do not close automatically |

The GitHub child issues #564, #567 and #568 were still open during this local
gate review. Their existence does not invalidate passing *individual* tests,
but the final gate must not close on the assumption that configured CI jobs or
synthetic tests already supplied their missing host evidence. Keep #569 open
until the required workflows pass at a concrete revision and host limits and
child-ticket status are recorded.

The most recent completed Build run visible during this review was
[`40453558771`](https://github.com/Cruel/nt/actions/runs/40453558771),
for **`8a0209cc`**, not this checkout revision. It failed in several jobs,
including Windows native authoring, Linux host CLI, and native C++ policy/build
checks; its macOS native-authoring job passed. Neither that partial/failed run
nor earlier release reports qualify the final platform matrix at the current
revision. The new installed-binary differential is wired into Linux Build,
but its current-revision CI execution remains pending.

Feature Lab: already a valid end-to-end Project input for packaging smoke; this
certification task changes no authorable runtime behavior, and does not add a
new in-game Feature Lab scenario.
