# Platform Export Support Matrix

## Status

Support matrix version: **1**. Phase 5 publishes and dependency-audits the native desktop player
templates. Web and Android rows remain forward contracts for their platform vertical slices.

| Target | Architecture / ABI | Initial artifact | Graphics and shaders | Assembly host | Compatibility floor |
| --- | --- | --- | --- | --- | --- |
| Windows | x64 | Portable ZIP | D3D11; template-declared shader set | Any host for template assembly; Windows tooling for resource/signing work | Windows 10 1809 |
| Linux | x64 | tar archive; AppImage optional | OpenGL; `glsl-120` | Any host for template assembly; Linux for AppImage/tool-assisted audits | Ubuntu 22.04 / glibc 2.35 |
| macOS | arm64 | `.app` bundle | Metal | macOS required for signing/notarization | macOS 13 |
| Web | wasm32; single-threaded default, threaded optional | Deployment directory/ZIP | WebGL 2; `essl-300` (legacy variants remain template-declared) | Any host with an installed matching template | Supported browser floor provisional; threaded Web additionally requires `SharedArrayBuffer` plus COOP/COEP cross-origin isolation |
| Android release | arm64-v8a | APK/AAB | OpenGL ES/Vulkan as declared by template; `essl-300` | Template assembly may be host-independent; APK/AAB generation requires Android tooling | min API 24; compile API 35 |
| Android debug/emulator | x86_64 | APK | OpenGL ES/Vulkan as declared by template; `essl-300` | Android JDK/SDK/NDK/Gradle required | min API 24; compile API 35 |

Current release automation uses Emscripten 6.0.0 and an Android set certified together: Gradle 8.9,
Android Gradle Plugin 8.7.3, Java 17, API/target/compile SDK 35, build-tools 35.0.0,
NDK 28.2.13676358 (r28c), CMake 3.31.6, and bundletool 1.18.1. Those are template build inputs,
not implicit project-profile fields.

Template descriptors declare an inclusive runtime-package API range, build flavor, compiled
features, capability set, runtime dependencies, graphics backends, shader variants, and host tool
requirements. A template must reject a package outside its declared API or feature range.

The canonical `web-release` preset and default Web profile are single-threaded. The
`web-release-threads` preset produces a distinct `web-threads` template. Threaded deployments must
serve every player response with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`; the generated `DEPLOYMENT.md` records this contract.

Release CI audits ELF dependencies and runtime paths with `readelf`/`ldd`, PE imports with
`dumpbin`, and Mach-O dependencies with `otool`. Template archives, symbols, canonical descriptors,
CycloneDX SBOMs, collected notices, checksums, the release registry index, and GitHub provenance
attestations are published as separate release assets.
