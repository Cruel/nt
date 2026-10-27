# Native platform export final gate (#569)

Status as of 2026-10-27: **in progress; not a five-platform certification**.
Parent #545 and production CLI cutover #551 remain separate decisions.

## Scope and evidence rules

The reference implementation is the retained TypeScript platform export and
template/config services, not a second invocation of the new C++ binary. The
earlier `certify-native-cli-platform.mjs` compared two authorities inside the
ScriptC CLI. Since the #521 cutover removed that old CLI entrypoint, running it
against a direct-C++ binary cannot establish reference-versus-native parity.
Mark that historical evidence separately from fresh post-cutover differentials.

For every target, final qualification needs independently captured evidence of:

1. The actual *same* fixture, template bytes, configuration, profile and CLI
   flags consumed by the TypeScript reference and direct-C++ exporter.
2. Result/exit-code/diagnostic comparison including `--check`, malformed
   inputs, signed and unsigned configuration, and cancellation. Normalize
   only nondeterministic paths, timestamps and transaction identifiers.
3. Published directory/archive/member-by-member readback against both
   manifests, verified template inputs, runtime package hashes and signature
   reports; an envelope reporting `success: true` without the required complete
   artifact set **fails** qualification.
4. Failed/mutated/corrupt/unsafe-template attempts that prove the previous
   distribution remains complete, an interrupted publication is recovered,
   stale source/physical Asset proof is rejected, and successful identity
   metadata is never falsely advanced.
5. The real published template's application launch or browser/device smoke
   on the applicable host, tied to the same commit/template identity.

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
export target staging outputs; the remaining differential is a blocker.

## Outstanding final acceptance

| Requirement | Current evidence | Outstanding |
| --- | --- | --- |
| Shared templates, config, trust and recovery | #563 and Linux native CTest; new direct/TS command differential | Broader real-export differential and explicit config/secret permutations |
| Windows x64 | #564 C++ PE tests and Windows CI configured for real release launch | Confirm CI run results, complete TS comparison and real signing/timestamp credential evidence if available |
| Web wasm32 | #565 C++ Web publication and release browser harness | Direct/TS full output, manifest and `--check` differential for threaded, single-threaded and nested-path cases |
| Linux x64 | #566 installed native ELF/archives/symbols tests and release smoke wiring | Direct/TS complete archive/profile/option differential; AppImage host evidence when tool available |
| macOS arm64 | #567 Mach-O/ZIP C++ tests and macOS release smoke wiring | Actual macOS runner results, direct/TS differential; private notarization credentials unavailable locally |
| Android arm64/x86_64 | #568 cross-host C++ tests and Android release/emulator workflows | Actual Gradle/SDK/emulator results, APK/AAB direct/TS differential, arm64 device workflow evidence |
| #545 parent | No ScriptC/QuickJS/player rewrite in these export changes | Reevaluate all public options/errors, output manifests, asset drift, signing, recovery and host limits after sibling tickets pass |

The GitHub child issues #564, #567 and #568 were still open during this local
gate review. Their existence does not invalidate passing *individual* tests,
but the final gate must not close on the assumption that configured CI jobs or
synthetic tests already supplied their missing host evidence. Keep #569 open
until the above conditions are checked and recorded at concrete revision IDs.

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
