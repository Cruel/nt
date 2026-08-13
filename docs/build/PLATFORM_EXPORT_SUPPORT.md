# Platform Export Support Matrix

Cross-platform hotspot fixture and build certification is recorded in
`docs/architecture/certifications/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_CERTIFICATION.md`.

## Status

Support matrix version: **1**. Desktop, Web, and Android rows describe release-produced player
templates and their current host-side qualification. Android device install/launch remains a
separate certification workflow as described below.

| Target | Architecture / ABI | Initial artifact | Graphics and shaders | Assembly host | Compatibility floor |
| --- | --- | --- | --- | --- | --- |
| Windows | x64 | Portable ZIP | OpenGL; `glsl-120` | Any host for template assembly; Windows tooling for resource/signing work | Windows 10 1809 |
| Linux | x64 | tar archive; AppImage optional | OpenGL; `glsl-120` | Any host for template assembly; Linux for AppImage/tool-assisted audits | Ubuntu 22.04 / glibc 2.35 |
| macOS | arm64 | `.app` bundle | Metal; `metal` | macOS required for signing/notarization | macOS 13 |
| Web | wasm32; threaded canonical, single-threaded compatibility artifact | Deployment directory/ZIP | WebGL 2; `essl-100` | Any host with an installed matching template | Supported browser floor provisional; threaded Web requires `SharedArrayBuffer` plus COOP/COEP cross-origin isolation |
| Android release | arm64-v8a | APK/AAB | OpenGL ES/Vulkan as declared by template; `essl-300` | Template assembly may be host-independent; APK/AAB generation requires Android tooling | min API 24; compile API 35 |
| Android debug/emulator | x86_64 | APK | OpenGL ES/Vulkan as declared by template; `essl-300` | Android JDK/SDK/NDK/Gradle required | min API 24; compile API 35 |

The assembly-host column describes artifact mechanics, not standalone CLI release availability.
Verified template file modes are part of `template.json`. POSIX hosts verify extracted filesystem
modes against those declarations; Windows hosts use the verified descriptor modes as authoritative
because NTFS archive extraction cannot preserve POSIX permission bits. Staging carries those verified
modes forward so a Linux or macOS template assembled on Windows does not lose executable metadata.
The standalone CLI is certified independently on Linux x64 and Windows x64; additional host
binaries require their own scriptc/native-link certification before release.

Current release automation uses Emscripten 6.0.0 and an Android set certified together: Gradle 8.9,
Android Gradle Plugin 8.7.3, Java 17, API/target/compile SDK 35, build-tools 35.0.0,
NDK 28.2.13676358 (r28c), CMake 3.31.6, and bundletool 1.18.1. Those are template build inputs,
not implicit project-profile fields.

Template descriptors declare an inclusive runtime-package API range, build flavor, compiled
features, capability set, runtime dependencies, graphics backends, shader variants, and host tool
requirements. A template must reject a package outside its declared API or feature range.

The canonical `web-release` preset produces the `web-threads` template. The distributed
`web-release-no-threads` compatibility preset produces the `web-single-threaded` template. Threaded deployments must
serve every player response with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`; the generated `DEPLOYMENT.md` records this contract.

Release CI audits ELF dependencies and runtime paths with `readelf`/`ldd`, PE imports with
`dumpbin`, and Mach-O dependencies with `otool`. Template archives, symbols, canonical descriptors,
CycloneDX SBOMs, collected notices, checksums, the release registry index, and GitHub provenance
attestations are published as separate release assets.

### Release platform certification scope

Platform certification is the fail-closed qualification of a **specific published player template
and finalized export path**. It is deliberately narrower than the repository's complete engine QA
matrix. The canonical contract lives in
`editor/src/shared/project-schema/platform-certification-contract.json`; both the TypeScript
certifier and `scripts/platform-certification.mjs` consume that same list. The release workflow must
first run `scripts/platform-certification-results.mjs`, which verifies concrete artifacts and
produces one independently hashed proof file per required check. Missing, failed, duplicate,
out-of-scope, or reused evidence blocks report creation and publication. Raw results and the
per-check proof files are part of the qualified release inventory so the final publish job can
reverify the reports after artifact transfer.

Every template must prove the following universal release claims:

| Check | Release verifier / evidence |
| --- | --- |
| `artifact-claims` | Template archive identity matches the descriptor and its declared release archive. |
| `descriptor-file-integrity` | Every declared template file exists with the declared size and SHA-256; the archive inventory has no undeclared files. |
| `runtime-closure` | Every descriptor runtime dependency belongs to the immutable template inventory. |
| `template-install-integrity` | The canonical integration test securely installs and verifies the exact template before export. |
| `canonical-export` | The canonical project/profile fixture completes the public project/profile export workflow. |
| `runtime-package-integrity` | Canonical export evidence binds the emitted runtime package SHA-256 to the finalized export manifest. |
| `symbols-build-id` | The separately published symbol archive contains the exact template `buildId` in `BUILD_ID` and actual symbol payloads. |
| `third-party-notices` | The descriptor-declared notice artifact exists and is non-empty. |
| `sbom` | The descriptor-declared SBOM exists and parses as CycloneDX. |

Target-specific certification then binds the platform-specific behavior that the release runner can
actually observe:

| Target | Additional certified release behavior |
| --- | --- |
| Web | Chromium reaches player-ready for both `/` and `/nested/game/`. Threaded and single-threaded templates are exported, launched, and certified separately. |
| Windows | The finalized portable export launches natively, PE GUI/resource metadata is verified, and dependency audit rejects debug-runtime imports. |
| Linux | The finalized directory and AppImage launch, X11 and Wayland are exercised separately, desktop integration is verified, and ELF dependency/RPATH/glibc-baseline audit passes. |
| macOS | The finalized app launches through LaunchServices and its contained executable, and Mach-O install-name dependency closure passes. |
| Android | Final APK/AAB inspection verifies bootstrap/package integrity, exact ABI/native closure, signature policy and ZIP alignment; native PT_LOAD alignment is independently checked at 16 KiB. AAB templates additionally require successful pinned-bundletool APK-set generation. |

This platform report does **not** claim that each release job independently re-exercised every engine
feature or every template capability. Input, rendering semantics, RmlUi behavior, Lua behavior,
fonts/images/audio, navigation, save/reload, compatibility/update behavior, and other engine-level
contracts remain covered by the normal engine/editor/runtime suites and their dedicated
certifications. Likewise, Android device install/launch is exercised by the separate
`Android arm64 16 KiB certification` workflow; the ordinary release report does not claim a device
launch that did not occur on its runner. This separation prevents a green release report from
turning descriptor declarations into unsupported evidence claims.

The required release inventory is Linux and Windows x64 CLI/editor artifacts plus all six platform
rows above (including both Web threading modes and both Android testing/release ABIs). Manual
workflow dispatch qualifies a proposed tag against the same matrix without publishing. Tag builds
rebuild from the immutable tagged commit; final aggregation verifies the exact matrix, certification
set, release metadata, checksums, and provenance inputs before atomically creating the GitHub
Release. Partial releases are prohibited.
