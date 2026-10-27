# Platform Export Support Matrix

Cross-platform hotspot fixture and build certification is recorded in
`docs/architecture/certifications/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_CERTIFICATION.md`.

## Status

Support matrix version: **1**. Desktop, Web, and Android rows describe release-produced player
templates and their current host-side qualification. Android device install/launch remains a
separate certification workflow as described below.

| Target | Architecture / ABI | Initial artifact | Graphics and shaders | Assembly host | Compatibility floor |
| --- | --- | --- | --- | --- | --- |
| Windows | x64 | Portable ZIP | OpenGL; `glsl-330` | Any host for template assembly; Windows tooling for resource/signing work | Windows 10 1809 |
| Linux | x64 | tar archive; AppImage optional | OpenGL; `glsl-330` | Any host for template assembly; Linux for AppImage/tool-assisted audits | glibc 2.28 |
| macOS | arm64 | `.app` bundle | Metal; `metal` | macOS required for signing/notarization | macOS 11 |
| Web | wasm32; threaded canonical, single-threaded compatibility artifact | Deployment directory/ZIP | WebGL 2; `essl-300` | Any host with an installed matching template | Supported browser floor provisional; threaded Web requires `SharedArrayBuffer` plus COOP/COEP cross-origin isolation |
| Android release | arm64-v8a | APK/AAB | OpenGL ES/Vulkan as declared by template; `essl-300` | Template assembly may be host-independent; APK/AAB generation requires Android tooling | min API 24; compile API 35 |
| Android debug/emulator | x86_64 | APK | OpenGL ES/Vulkan as declared by template; `essl-300` | Android JDK/SDK/NDK/Gradle required | min API 24; compile API 35 |

The assembly-host column describes artifact mechanics, not standalone CLI release availability.
Verified template file modes are part of `template.json`. POSIX hosts verify extracted filesystem
modes against those declarations; Windows hosts use the verified descriptor modes as authoritative
because NTFS archive extraction cannot preserve POSIX permission bits. Staging carries those verified
modes forward so a Linux or macOS template assembled on Windows does not lose executable metadata.

Player compatibility is deliberately independent from editor/CLI compatibility. Exported games do
not link ScriptC or the authoring tooling closure, so authoring dependencies must never raise the
runtime floor of a player template. Current desktop compatibility contracts are:

| Platform | Player runtime floor | Authoring CLI/editor floor | Release enforcement |
| --- | --- | --- | --- |
| Linux x64 | glibc 2.28; GNU C++ runtime linked into the player | glibc 2.36 / GLIBCXX 3.4.30 | Player builds in the pinned `manylinux_2_28_x86_64` environment and receives an ELF ABI audit. The release CLI builds in a pinned Debian 12/glibc 2.36 container, and packaged editor ELF files are audited against the same ABI ceiling. |
| Windows x64 | Windows 10 1809 | Windows 10; exact Windows 10 build remains provisional | Player and vcpkg target compilation define `WINVER=0x0A00`, `_WIN32_WINNT=0x0A00`, and `NTDDI_VERSION=0x0A000006` (RS5/1809). Authoring remains on upstream ScriptC's Windows 10 contract until a narrower floor is qualified. |
| macOS arm64 | macOS 11 | macOS 14 | Player CMake/vcpkg deployment targets are 11.0. Authoring CMake/vcpkg targets and the packaged editor minimum are 14.0; release builds run on the newer macOS/Xcode host required by the toolchain. |

The Linux release runner version is intentionally not part of either compatibility contract. The
player userspace is a digest-pinned glibc 2.28 container, while Linux authoring is built in a
digest-pinned Debian 12 container. This prevents GitHub-hosted runner image upgrades from silently
raising either ABI floor. The standalone CLI is fully certified independently on Linux x64 and
Windows x64; the macOS host CLI is built for and package-smoked with the macOS editor, while complete
standalone CLI differential certification remains a separate admission gate.

The native-authoritative platform-export candidate (#517) is also checked on
the Linux installed CLI build, with an isolated, generated Web Project and
template: `editor/scripts/certify-native-cli-platform.mjs`. This exercises
the real native preparation and publication path alongside the legacy oracle,
including cold and daemon preflight, retained output collision/force/symlink
policy, template trust, and local application identity. The script reports
explicitly that private certificate credentials are not provided, so passing
does not claim real signing, Android SDK packaging, or macOS notarization.
Those remain certified only by the appropriate target-specific release jobs.

The Windows native C++ exporter certification is integrated into the existing
Windows jobs instead of a parallel Windows workflow: `build.yml` builds
`noveltea-native-cli` with MSVC, runs the native PE, publication, platform
command and public-contract tests, and generates a current Windows template for
an independent exported-player launch smoke, retaining JSON evidence; `release.yml` also builds the same C++ CLI alongside
the release player and runs `tests/native_cli/windows_release_smoke.py` using
the actual release Windows template. That smoke checks manifest/archive byte
identity and starts the resulting executable from an unrelated working
directory on the Windows host. Linux can run the same script with a trusted
local template for cross-host assembly/readback, but only the Windows runner
can certify launch. Synthetic per-binary signing/verification is exercised in
the native CLI regression suite, while publicly trusted Authenticode signing,
timestamp-chain validation, and production certificate credentials require
separate signer/credential evidence (not included in CI fixtures).

The direct C++ Linux exporter consumes the same verified template and pinned
native runtime preparation as Windows and Web. It validates the actual x86_64
ELF program-header/dynamic string-table closure against `linuxNeeded` and
`linuxRpaths`, accepts only portable `$ORIGIN` library search paths, and
checks that non-system NEEDED libraries are shipped in the template. Its
directory contains the executable under `bin/`, adjacent `game.ntpkg` and
`player.json`, a root launcher, hicolor icons and freedesktop `.desktop`
metadata. It publishes a ZIP or deterministic tar.gz, with optional separate
debug symbols; the opt-in AppImage uses an existing host-installed
`appimagetool`, selectable via `NOVELTEA_LINUX_APPIMAGE_TOOL`. AppImage is
not a new mandatory build dependency, and AppImage assembly is Linux-only.

`tests/native_cli/platform.py` certifies Linux export with freshly built ELF
and bundled native-library fixtures, independent-working-directory execution,
unsafe/colliding outputs, and failure rollback. Release CI builds the direct
C++ CLI and uses `tests/native_cli/linux_release_smoke.py` to install the actual
release template and launch both its portable directory and optional AppImage
under Xvfb, independently of the existing TypeScript exporter certification.
CI emits `dist/noveltea-native-linux-release-certification.json` as separate
native-export evidence. This does not replace the existing X11/Wayland release
matrix or claim that AppImage building works without host tooling.

The direct C++ macOS exporter (#567) assembles an arm64 `.app` from the verified
template using `Contents/MacOS`, `Contents/Frameworks`, and `Contents/Resources`.
It reads the actual arm64 Mach-O load commands, UUIDs, and portable dependency
closure (including universal binaries), compares them with the template's
certified metadata, and rejects missing/unsafe libraries and install names.
The runtime package and `player.json` are in Resources, alongside a generated
`AppIcon.icns`, bundle `Info.plist`, localization metadata, and mounted engine
licenses. The distribution ZIP retains the `<Name>.app/` root, a separate
`<Name>-symbols.zip` contains requested debug symbols, and
`<Name>-export-manifest.json` records final bundle file hashes. The manifest
is a *sidecar*, not a post-signing bundle resource, because changing any bundle
resource after codesign invalidates the signature.

Unsigned app/ZIP assembly and readback are cross-host. On macOS, `--sign`
requires a locally configured macOS signing identity, uses the installed Apple
`codesign` tool to sign nested dependencies before the hardened-runtime app,
and verifies the sealed bundle. Configured notarization invokes the selected
command and verifies ticket stapling with `xcrun stapler`. Opt-in `--dmg`
uses macOS `hdiutil`; it is unavailable on other hosts. No third-party signer
or DMG dependency is bundled. The signing report is a separate sidecar, and
old symbols, DMG, and signing reports are retired transactionally when disabled
in a later export. `native_cli_macos_export` runs real native staging/ZIP
readback and Mach-O corruption tests on cross-host CI; the macOS release runner
also executes `tests/native_cli/macos_release_smoke.py` with its real release
template, checks direct executable and LaunchServices launch, and exercises
ad-hoc codesign/verification. Production notarization and trusted-identity
signing still require private credentials and are not claimed by this smoke.

The native C++ Android exporter (#568) now assembles APK/AAB distributions from an
installed, verified Android player template. It copies the immutable Gradle
project, prebuilt native libraries, engine shaders, runtime assets and notices;
generates the game bootstrap, manifest, portrait/landscape configuration,
launcher icons and SDK/version/resource metadata; and invokes the pinned Gradle
wrapper using a separately configured local JDK/SDK. A signed release requires
an explicit local keystore/alias and `env:`-referenced signing secrets (never
project-authored credentials). The exporter checks APK manifest identity,
toolchain versions, native ABI closure, license bytes, signatures, alignment,
runtime package hashes and AAB-to-universal-APK derivation before installing the
complete artifact set with the same recoverable publication journal as other
native exporters. Android tooling is mandatory for APK/AAB production, but no
new Android runtime or build dependency is introduced by the C++ exporter.
`native_cli_android_export` exercises cross-host staged Gradle behavior with
hermetic fixtures and negative failure/rollback paths. The arm64 certification
workflow independently inspects the real artifacts and boots two AAB-derived
package revisions in the emulator. Publicly trusted release signing remains
dependent on external private keystore credentials and is not claimed by CI.

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

Desktop, Web, and Android template generation uses `cmake/generate-player-template-metadata.mjs`
over the resolved vcpkg, CMake FetchContent, and Emscripten-port inventories.
It preserves upstream license bytes in individual `licenses/*.txt` files and
emits a deterministic `licenses/index.json` with component/display identities,
versions, paths, sizes, and SHA-256 digests. The template's `artifacts.notices`
points to that index; `<templateId>.licenses.index.json` is the independent
release sidecar, while the indexed texts remain in the template archive.
The SBOM covers exactly the same component/version pairs.

FetchContent notices are attested against resolved download metadata and the declared
URL/checksum or Git revision. Extracted notice bytes must match the verified archive or
pinned commit; missing metadata, stale pins, and modified notices abort generation.
The editor's `player-template-license-generator.test.ts` exercises this boundary with
hermetic source archives and Git repositories plus matching synthetic CMake declarations,
without network downloads or a pre-existing native build.

`cmake/player-license-sources.json` records target applicability and targeted
exceptions for composite bgfx/bx/bimg, upstream license locations, Emscripten
ports, and the hash-pinned legacy Liberation Sans system font. The font's
original upstream GPL/exception texts are held under `cmake/licenses/`.
Android resolves the matching ABI/flavor Gradle CMake source tree, includes the
prebuilt SDL3 AAR and native shared-library closure, and checks the staged system
font. The packaged SDL3 license is pinned to the SDL3 AAR version; unexpected
shipped native libraries require an explicit verified source mapping before
packaging can succeed. The Android descriptor and release sidecar use the same
named index and byte-level certification as desktop and Web. Installing or
revalidating an Android template also applies the same license-index, named-text,
inventory, runtime-dependency, and SBOM consistency checks as other platforms.
Host-only tools/tests are excluded. Missing/ambiguous sources, placeholder
licenses, or an unrecognized source layout abort generation; do not add
hand-maintained copies of ordinary vcpkg copyrights.
Installed vcpkg feature dependencies are included in the player notice closure
(for example FreeType's Brotli/BZip2 support). Original license formatting,
including page-break form feeds in vcpkg's FreeType copyright text, is preserved.
Generation also verifies that the hash-pinned system font reached the staged
runtime assets (and the desktop template payload), so an absent/stale font
cannot produce a successful license catalog for an incomplete player template.
All engine license texts are limited to 1 MiB each, and the viewer inventory to
512 entries. The generator, template installer, and release sidecar verifier reject
invalid UTF-8 or disallowed controls. Genuine upstream engine notices may retain
form-feed page separators; Project-authored notices cannot use that control.

Final Android APKs and AABs are inspected for the **exact** certified engine
license file set, including `index.json`, beneath
`assets/system/licenses/`. Actual packaged bytes and SHA-256 digests
must match the installed template, not just Gradle's build-time staging folder.
The AAB is checked both directly and via the universal APK generated by the
pinned bundletool. The Android player reads those resources through `system:/`;
the separately bundled game `.ntpkg` provides Project notices through `project:/`.
Web exports carry original notices under `licenses/` and a matching copy in
`assets/system/licenses/` for runtime preload and offline caching. Desktop
distributions keep the original notices under `licenses/` and mount the target's
certified copies from `assets/system/licenses/` (within app resources on macOS).

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
| `third-party-notices` | All platforms: the exact named license set, index, text bytes, hashes, and descriptor notice dependencies must agree; placeholders and incomplete/ambiguous catalogs fail. |
| `sbom` | CycloneDX SBOM parses, and Desktop/Web component/version identities exactly match the license index. |

Target-specific certification then binds the platform-specific behavior that the release runner can
actually observe:

| Target | Additional certified release behavior |
| --- | --- |
| Web | Chromium reaches player-ready for both `/` and `/nested/game/`. Threaded and single-threaded templates are exported, launched, and certified separately. |
| Windows | The finalized portable export launches natively, PE GUI/resource metadata is verified, and dependency audit rejects debug-runtime imports. |
| Linux | The finalized directory and AppImage launch, X11 and Wayland are exercised separately, desktop integration is verified, and ELF dependency/RPATH/glibc-baseline audit passes. |
| macOS | The finalized app launches through LaunchServices and its contained executable, and Mach-O install-name dependency closure passes. |
| Android | Final APK/AAB inspection verifies bootstrap/package integrity, exact ABI/native closure, **physical engine notice file/index inventory and bytes**, signature policy and ZIP alignment; native PT_LOAD alignment is independently checked at 16 KiB. AAB templates additionally require successful pinned-bundletool APK-set generation and inspection of its derived APK. |

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
