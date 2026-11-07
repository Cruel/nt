# Native platform export final gate (#569)

Status as of 2026-11-06: **accepted; owner-revised #569 gate satisfied** by
real Linux native export/launch evidence and a fully successful Build and Release
on the **same qualifying source revision**. Parent #545 and the shipped-CLI
retirement #551 are independently assessed issues; this report does not close
either by implication. #522, #506 and #474 retain their own final gates.

## Verified qualifying CI (2026-11-06)

The GitHub Actions run metadata and **individual jobs** were inspected for the
following completed workflows, rather than inferring success from workflow
configuration or the earlier 2026-11-02 issue comments:

| Workflow | Source revision | Outcome | Evidence |
| --- | --- | --- | --- |
| Build 42149583199 | `6eefa101c67398495fa38600e8e8a5b04eff400b` | Success, all 23 jobs succeeded | [Build run](https://github.com/Cruel/nt/actions/runs/42149583199) |
| Release 42149611086 (manual qualification) | `6eefa101c67398495fa38600e8e8a5b04eff400b` | Success: 20 qualifying jobs succeeded; **Publish GitHub Release** skipped intentionally | [Release run](https://github.com/Cruel/nt/actions/runs/42149611086) |
| Later Build 42183326370 | `5295064f0f856235097a25f0027d3a1eb21b8b77` | Success, all 23 jobs succeeded | [Build run](https://github.com/Cruel/nt/actions/runs/42183326370) |

`git merge-base --is-ancestor 6eefa101 5295064f` succeeds, as does
`git merge-base --is-ancestor 5295064f 98c32ec0` (the checkout HEAD during this
acceptance review). The complete Build/Release pair qualifies **6eefa101**;
the later Build confirms additional changes on that lineage, not an unobserved
Release run on the later HEAD. The skipped publication step is expected for
manual release qualification and is not a skipped required verification job.

Key successful job-level evidence:

| Target / boundary | Qualifying jobs and actual behavior |
| --- | --- |
| Linux x64 | [Release desktop hosts (linux-x64-release)](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736880478): pinned glibc-2.28 player, real native C++ portable/AppImage export and launches, X11 and Wayland launches, dependency audit and platform certification; [Build Linux native production CLI](https://github.com/Cruel/nt/actions/runs/42149583199/job/127673818351). |
| Windows x64 | [Release desktop hosts (windows-x64-release)](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736880544) and [Windows standalone CLI certification](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736880773); real portable player launch, PE/resource/dependency checks, installed CLI contracts, recovery and export tests. |
| Web wasm32 | [Web release](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736880514): canonical threaded and compatibility single-threaded export/browser qualification; [Build Web/Emscripten](https://github.com/Cruel/nt/actions/runs/42149583199/job/127669603434) and [Build browser qualification](https://github.com/Cruel/nt/actions/runs/42149583199/job/127669603653). |
| macOS arm64 | [Release desktop hosts (macos-arm64-release)](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736880398), [native export and app launch certification](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736881984), and [macOS host CLI build](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736880175). |
| Android | [Android release](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736913913) with real APK/AAB, signature/alignment, ABI, package and release-report checks; [Build Android](https://github.com/Cruel/nt/actions/runs/42149583199/job/127673818261) and [API 24](https://github.com/Cruel/nt/actions/runs/42149583199/job/127680262415)/[API 35](https://github.com/Cruel/nt/actions/runs/42149583199/job/127680262547) emulator tests. |
| Packaged hosts / inventory | [Linux editor](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736880992), [Windows editor](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736881270), [macOS editor](https://github.com/Cruel/nt/actions/runs/42149611086/job/127736879991), and [exact release inventory](https://github.com/Cruel/nt/actions/runs/42149611086/job/127740320982). Previous Linux/Windows packaged-editor failures are superseded. |

All required platform-specific Release jobs passed. Conditional, inapplicable
matrix steps (for example, Linux-only steps in Windows jobs) were skipped as
designed, not failed. Required release-inventory qualification completed.

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
The original `build/nt569-smoke/certification.json` was untracked and is **not
present in this later checkout**. This section records the earlier completed
local run, its original procedure and verified observations; it is not a claim
to have re-executed the untracked local run during this review. The Release
job above independently supplies the production pinned-glibc/player/template
launch evidence that the earlier stripped-debug local fixture did not provide.

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

## Final acceptance disposition and limits

| Requirement | Disposition |
| --- | --- |
| Real direct-C++ Linux export, `--check`, template install, hashes/readback, unrelated working-directory portable/AppImage launch | **Passed** in the previously recorded local 149-file smoke, independently qualified with the real pinned release player in successful Release CI. |
| Windows, Web, Linux, macOS, Android Build/Release platform jobs and actual host/export/browser/emulator evidence | **Passed** at `6eefa101` (job links above); later Build also passed at descendant `5295064f`. |
| Template trust/corruption, signing-profile failures, localization warnings, custom profiles, source/physical Asset drift, identity-change acknowledgment, cancellation, output collision, recovery/rollback, options and diagnostics | **Covered** by native platform-command/publication CTests, installed-CLI platform certification and per-platform release jobs; see `tests/native_cli/platform.py`, `tests/tooling/native_cli_platform_publication_tests.cpp`, `editor/scripts/certify-native-cli-platform.mjs`, and `tests/native_cli/*_release_smoke.py`. The existing command differential remains optional extra coverage; no new TypeScript-vs-C++ export-output comparison is required. |
| All #563–#568 implementation children | **Closed**, verified against GitHub on 2026-11-06. |
| #545 and #551 | **Separate acceptance decisions**; neither is implicitly accepted by this gate. |

**Credential and host limitations:** CI's signing-profile/error-path tests,
artifact signature-policy checks, and mock/synthetic signing are **not**
production Windows Authenticode signing, certificate-chain validation, or
timestamp-service certification. No private production signing certificates,
macOS Developer ID/notarization credentials or Apple notarization result,
or Android production keystore identity is asserted. The Android release
qualifies real APK/AAB artifacts, and Build qualifies emulators; neither is a
physical Android arm64 device install/launch. Cross-host assembly and CI
launches also do not imply exhaustive real customer-machine/OS/device coverage.
These credential/device limitations were expressly allowed as documented
unavailable checks by the owner's revised #569 gate, and are **not** reported
as passes. The manual Release run did not publish a GitHub Release.

**Decision for #569:** Accept and close on the verified `6eefa101` Build/Release
pair plus the documented local Linux export, with the explicit exclusions
above. Earlier failed November 2 workflows and October's pending-CI status
are superseded by this newer completed evidence, not hidden or treated as
successful runs.

Feature Lab: already a valid end-to-end Project input for packaging smoke; this
certification task changes no authorable runtime behavior, and does not add a
new in-game Feature Lab scenario.
