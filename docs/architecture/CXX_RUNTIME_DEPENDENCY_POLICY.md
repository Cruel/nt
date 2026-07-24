# C++ Runtime Dependency Policy

NovelTea ships C++ runtime code with C++ exceptions and compiler RTTI disabled. A dependency is not
considered compliant merely because one NovelTea target compiles with `-fno-exceptions` or
`-fno-rtti`; its own C++ objects and transitive C++ objects must be built under the same policy.

Most desktop target libraries are rebuilt through NovelTea vcpkg triplets. RmlUi is the deliberate
exception: Linux, Web, and Android all build the same pinned archive and repository-owned patch through
FetchContent. Build-host executables are kept on the ordinary host triplet because they do not enter
the shipped runtime link graph. Other Web and Android C++ dependencies are built from source and
receive the policy directly on their CMake targets.

| Dependency | Version / source | Policy configuration | Failure behavior |
| --- | --- | --- | --- |
| nlohmann-json | 3.12.0 | Header-only consumers define `JSON_NOEXCEPTION=1` and compile without exceptions/RTTI. | Invalid external data is handled through non-throwing parse and checked access. Internal invariant violations are fatal under the library's no-exception mode. |
| sol2 | 3.5.0 | Header-only consumers define `SOL_NO_EXCEPTIONS=1` and `SOL_NO_RTTI=1` and compile without exceptions/RTTI. | Lua syntax, runtime, conversion, binding, and coroutine failures use protected-result/status paths. Lua panic remains fatal. |
| Lua | 5.5.0 | Built as C. No C++ Lua wrapper library is linked. | Ordinary script failures are protected Lua errors; panic and allocation exhaustion are fatal. |
| RmlUi Core / Lua / Debugger | 6.2 archive SHA-256 `814c3ff7b9666280338d8f0dda85979f5daf028d01c85fc8975431d1e2fd8e8b`; base patch revision `3c-text-scale-1` (`d212928a876e0409ded399d93a85177c00f1ed387ca45411e9baa356f18e6d22`), followed by final font-raster patch revision `5e-font-raster-scale-1` (`992c411472df8491b79a7ea847bfdea9a69122a458092b7b59add75eb2b4fa88`) | Built statically from the same two-stage patched FetchContent source on Linux, Web, and Android. The entire family and every consumer define `RMLUI_CUSTOM_RTTI` and `ITLIB_FLAT_MAP_NO_THROW`, and compile without exceptions/RTTI. The vcpkg manifest contains no RmlUi dependency or override. | Invalid authored resources use RmlUi return/logging paths. Failed checked casts return null. `itlib::flat_map::at()` invariant failures assert instead of throwing. |
| rmlui-bgfx | configured Git ref/local checkout | Built from source without exceptions/RTTI under the same RmlUi custom-RTTI ABI. | Recoverable renderer/resource failures are returned or logged; renderer assertions and impossible-state failures remain fatal. |
| bgfx / bx / bimg | vcpkg `1.129.8940-496#1`; source build on Web/Android | Runtime libraries compile without exceptions/RTTI. | Assertions and fatal callbacks remain intentional process-fatal boundaries. NovelTea handles recoverable shader, texture, and asset failures before reaching those boundaries. |
| Twink | commit `ea488b2d6a0c032ffefdeb0e5e064749706e29fd` | Built from source without exceptions/RTTI and linked privately behind `animation::TweenService`. | Invalid track specifications are rejected by NovelTea's typed adapter. Twink allocation exhaustion and violated internal contracts are fatal. |
| Dear ImGui | 1.92.8 desktop; fetched source on Web/Android | When enabled, compiles without exceptions/RTTI. | Debug-only UI. Assertions and allocation exhaustion are fatal; it is not used as a recoverable authored-data boundary. |
| HarfBuzz | 14.2.1 | Desktop archives use policy triplets. Web and Android use the source CMake build with both compiler features disabled. | Shaping APIs report status/empty results; allocation exhaustion and internal assertions are fatal. |
| SDL3 | 3.4.10 desktop; Emscripten/Android platform build | C/status-code integration; no substituted C++ runtime archive is linked. | API failures are checked by NovelTea. SDL assertion/fatal platform failures remain fatal. |
| miniaudio | 0.11.25 | C implementation. | Backend and decoding failures use `ma_result`; callback contract violations and allocation exhaustion are fatal. |
| FreeType | 2.14.3 desktop; source/platform library elsewhere | C/status-code integration. | Font loading and glyph failures return `FT_Error`; NovelTea propagates recoverable failures. |
| SheenBidi | 3.0.0 | C/status-code integration. | Invalid/unsupported text input is handled by the adapter; allocation exhaustion is fatal. |
| libunibreak | 7.0 | C/status-code integration. | Break computation is non-throwing; allocation exhaustion is fatal. |
| miniz | 3.1.1 | C/status-code integration. | ZIP/package errors are recoverable and translated into NovelTea diagnostics. |

## Platform build policy

- Linux uses `x64-linux-noveltea` for target libraries and `x64-linux` for host tools.
- Windows uses `x64-windows-static-noveltea` for target libraries and `x64-windows` for host tools.
- macOS arm64 uses `arm64-osx-noveltea` for target libraries and `arm64-osx` for host tools.
- Web and Android apply `-fno-exceptions -fno-rtti` to every source-built C++ dependency target.
- MSVC target libraries use `/GR- /EHs-c- /D_HAS_EXCEPTIONS=0`.

The `shader-tools` vcpkg feature deliberately declares `bgfx[tools]` as a host dependency. Its
SPIRV-Cross/glslang toolchain may use exceptions because those executables run during the build and are
not linked or packaged into NovelTea players.

## Verification

`cxx-dependency-policy` reads the generated compile database and requires both compiler-policy flags on
all recognized source-built C++ dependency objects. It additionally requires the RmlUi ABI definitions
on RmlUi and `rmlui-bgfx` commands, requires fetched RmlUi compile commands on every platform, and on
Linux requires fetched RmlUi archives in the final player link while rejecting vcpkg RmlUi archives.
The configure report at `reports/rmlui-dependency.txt` records the source and patch identity.

Fresh verification completed RmlUi dependency population and production builds on Linux,
Web, and Android. The three configure reports agreed on the RmlUi 6.2 source hash, base revision
`3c-text-scale-1` and hash, and final revision `5e-font-raster-scale-1` and font-raster patch hash.
The Linux patch suite covered the patch marker, media-query dimension override, context text-scale
factor, context font-raster scale, and installed-package extension probe. `cxx-policy` passed on all three platforms and
verified 236 fetched RmlUi C++ compile commands per platform. The desktop installed-package probe
rejected pristine RmlUi 6.2 and accepted a package exposing the complete media-query and text-scale
Context API. Windows and macOS triplets are defined but require their native builders before they can
be marked validated.

## Host-tool exemption

A native-only build tool may use exceptions or compiler RTTI only when all of the following are true:

- it executes on the build host and is never loaded by the runtime;
- it is resolved through the host dependency graph or an explicitly supplied executable path;
- none of its C++ objects or transitive archives appear in a shipped target's link command;
- it is not copied into desktop, Web, Android, or editor-export player templates;
- the exemption and graph boundary are documented in this file.

The current approved example is `bgfx[tools]` for `shaderc` and its host-side compiler stack. The Linux
link audit rejects ordinary host-triplet archives in `noveltea-player`. A tool becoming runtime-linked
automatically voids the exemption and requires full admission review.

## Admission gate

Any pull request or implementation that adds or materially upgrades a shipped C++ dependency must add
or update its row in the matrix above and provide all of the following evidence:

1. Exact version, source, license, and acquisition path.
2. Complete transitive C++ target/archive graph for every supported platform.
3. Exact compiler flags and library macros that disable exceptions and compiler RTTI, or the documented
   custom RTTI mechanism used consistently across the ABI.
4. Recoverable API subset and the status/result mechanism NovelTea uses instead of exceptions.
5. Explicit classification of fatal assertions, panic callbacks, allocation exhaustion, and other
   process-fatal behavior.
6. Representative malformed-input or runtime-failure tests at the NovelTea adapter boundary.
7. Linux, Web, and Android build availability, plus Windows/macOS availability when those platforms are
   supported by the dependency.
8. `cxx-policy` results proving the dependency objects receive the required compiler policy.
9. Binary-size impact for a meaningful new or upgraded runtime dependency.

Admission is rejected when the only evidence is that headers compile under `-fno-exceptions`, when a
transitive C++ archive is unaudited, when recoverable authored input can reach an abort-only API, or
when custom RTTI is enabled on only part of a dependency family.

## Contributor checklist

Any new shipped runtime dependency must record its language, exact no-exception configuration, exact
no-RTTI or custom-RTTI configuration, transitive C++ graph, replacement failure mechanism, recoverable
API subset, platform availability, and representative failure-path tests before it is admitted.
