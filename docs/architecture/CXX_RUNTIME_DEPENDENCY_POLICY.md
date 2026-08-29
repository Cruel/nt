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
| nlohmann-json | 3.12.0 | Header-only consumers define `JSON_NOEXCEPTION=1` and compile without exceptions/RTTI. Raw library access is confined to approved JSON codec/adapter paths; shared decoding uses `JsonDecoder`/`json_access` checked operations rather than throwing convenience accessors. | Invalid external data is handled through non-throwing parse and checked access. Internal invariant violations are fatal under the library's no-exception mode. |
| sol2 | 3.5.0 | Header-only consumers define `SOL_NO_EXCEPTIONS=1` and `SOL_NO_RTTI=1` and compile without exceptions/RTTI. | Lua syntax, runtime, conversion, binding, and coroutine failures use protected-result/status paths. Lua panic remains fatal. |
| Lua | 5.5.0 | Built as C. No C++ Lua wrapper library is linked. | Ordinary script failures are protected Lua errors; panic and allocation exhaustion are fatal. |
| RmlUi Core / Lua / Debugger | Cruel/RmlUi `feature-calc` commit `c6744d15bda5e9df7ad9c1f8eae937157e7ed309` (6.3 development line); presentation revision `6a-feature-calc-presentation-1` (`95c2fdee763da0b2d87cf13e0ee9aac690d09d13e62069ccf0b0ecf87732cbc8`), font-raster revision `6b-feature-calc-font-raster-1` (`2e259f79b14f78ff37c868f23fca0c59a33dac0d35744c4e0eba2c96e7ac4f50`), and final Lua-listener revision `6c-feature-calc-lua-listener-state-1` (`b519e72f0dfe1666445dccfddedf9ebf884f48ecb61ecd2ce5cddeb71327ff27`) | Built statically with CSS math expressions from the same three-stage patched FetchContent source on Linux, Web, and Android. The entire family and every consumer define `RMLUI_CUSTOM_RTTI` and `ITLIB_FLAT_MAP_NO_THROW`, and compile without exceptions/RTTI. The vcpkg manifest contains no RmlUi dependency or override. The desktop installed-package fallback must report the exact final marker revision and expose the complete extension API. | Invalid authored resources use RmlUi return/logging paths. Failed checked casts return null. `itlib::flat_map::at()` invariant failures assert instead of throwing. Lua inline listeners retain and release callbacks against their creation state and listener table. |
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
| libpng | 1.6.58; vcpkg on desktop, Emscripten `-sUSE_LIBPNG=1` port on Web, pinned upstream archive on Android; `libpng-2.0` license | C-only runtime dependency with zlib 1.3.2 as its only runtime library dependency. It introduces no C++ objects, exception ABI, or compiler RTTI. `noveltea_engine` links `PNG::PNG` privately and remains compiled under the normal no-exceptions/no-RTTI policy. | Screenshot requests reject invalid dimensions/compression levels before encoding. libpng allocation/setup failures and libpng error callbacks become failed screenshot jobs; the adapter uses libpng's `setjmp`/`longjmp` error boundary and never exposes it outside the encoder. Allocation exhaustion in NovelTea/libpng storage remains process-fatal. |

## Platform build policy

- Linux uses `x64-linux-noveltea` for target libraries and `x64-linux` for host tools.
- Windows desktop player/editor builds use `x64-windows-static-noveltea` for target libraries and `x64-windows` for host tools. The standalone Windows CLI is a separate GNU-ABI artifact: its native FFI closure uses `x64-mingw-static-noveltea` with `x64-mingw-static-host`, then ScriptC/Zig links the final `x86_64-windows-gnu` executable.
- macOS arm64 uses `arm64-osx-noveltea` for target libraries and `arm64-osx` for host tools.
- Web and Android apply `-fno-exceptions -fno-rtti` to every source-built C++ dependency target.
- MSVC desktop target libraries use `/GR- /EHs-c- /D_HAS_EXCEPTIONS=0`; the Windows CLI GNU triplet applies the corresponding `-fno-exceptions -fno-rtti` dependency policy.

The host `noveltea` CLI statically links the pinned bgfx shaderc source closure, including its
SPIRV-Cross/glslang compiler stack. That build-host/editor tooling may use the normal host exception
and RTTI model because it is isolated from the player graph. NovelTea does not enable vcpkg
`bgfx[tools]` or build/package a separate shaderc executable.

## Verification

`cxx-dependency-policy` reads the generated compile database and requires both compiler-policy flags on
all recognized source-built C++ dependency objects. It additionally requires the RmlUi ABI definitions
on RmlUi and `rmlui-bgfx` commands, requires fetched RmlUi compile commands on every platform, and on
Linux requires fetched RmlUi archives in the final player link while rejecting vcpkg RmlUi archives.
The configure report at `reports/rmlui-dependency.txt` records the source and patch identity.

### libpng admission evidence

The screenshot encoder admits libpng 1.6.58 as a direct runtime dependency. Desktop resolves the
vcpkg `libpng` 1.6.58 port, sourced from `pnggroup/libpng`, through the NovelTea target triplet. Web
resolves Emscripten's maintained 1.6.58 port with `-sUSE_LIBPNG=1`; Emscripten 6.0.0 fetches
`https://storage.googleapis.com/webassembly/emscripten-ports/libpng-1.6.58.tar.gz` and declares zlib
1.3.2 as the port dependency. Android fetches
the upstream `https://github.com/pnggroup/libpng/archive/refs/tags/v1.6.58.tar.gz` archive and builds
`png_static` against `ZLIB::ZLIB`. The upstream/vcpkg license is SPDX `libpng-2.0` (PNG Reference
Library License version 2). Release metadata explicitly inventories libpng 1.6.58 and zlib 1.3.2 for
Emscripten and Android instead of assuming CMake `_deps` or vcpkg status will discover platform
ports.

The complete new runtime library closure is therefore `noveltea_engine -> libpng (C) -> zlib (C)`:
desktop resolves `libpng16.a -> libz.a`, Web resolves Emscripten `libpng[-mt].a -> libz.a`, and
Android resolves `png_static -> ZLIB::ZLIB`. There are no transitive C++ objects and thus no
dependency-side compiler-exception or RTTI ABI to configure. The C++ caller remains under NovelTea's
normal `-fno-exceptions -fno-rtti` policy (or the MSVC equivalents). Desktop already contained the
same libpng/zlib archives transitively through FreeType's PNG support before the screenshot encoder
linked libpng directly.

The adapter validates requested PNG compression levels and bounded screenshot dimensions before
invoking the library. `png_create_write_struct`/`png_create_info_struct` failure, libpng write errors,
and output callback errors terminate the encode job with `screenshot.encode_failed`; libpng's C error
mechanism is contained by `png_jmpbuf`/`png_longjmp` inside each encoder operation. The host tests
`screenshot service rejects invalid compression and capture extents` and `screenshot RGBA allocation
arithmetic enforces the capture budget` exercise malformed adapter input and allocation limits.
Native and Web screenshot smokes exercise successful libpng output, including the cooperative
no-pthread Web executor. Allocation exhaustion remains fatal under the runtime's no-exception model.

Local admission verification completed Linux `cxx-policy`, Web no-thread `cxx-policy`, a Web
no-pthread screenshot smoke, and Android `assembleDebug`. Windows static and macOS arm64 resolve the
same vcpkg 1.6.58 port through their existing NovelTea triplets; those native builders remain the
platform-specific availability check. In the 2026-08-16 admission measurement, the Linux Release
player's pre-change `HEAD` executable
was 25,411,048 bytes with 21,239,288 bytes of text, while the complete screenshot/libpng change is
25,431,256 bytes with 21,257,140 bytes of text. The net feature delta is therefore 20,208 bytes on
disk and 17,852 bytes of text. Because the baseline already linked libpng through FreeType, these
figures are a conservative upper bound for the direct libpng admission rather than an isolated
libpng-only cost.

Fresh verification completed RmlUi dependency population and production builds on Linux,
Web, and Android before the Lua-listener follow-up. The three configure reports agreed on the
RmlUi source commit, presentation revision `6a-feature-calc-presentation-1`, and font-raster revision
`6b-feature-calc-font-raster-1`. The current final revision is `6c-feature-calc-lua-listener-state-1`; its focused
Linux tests cover the exact patch marker, creation-state listener teardown, and rejection of the
outdated installed-package marker. Full cross-platform recertification of that follow-up remains
required. Windows and macOS triplets are defined but require their native builders before they can
be marked validated.

## Host-tool exemption

A native-only build tool may use exceptions or compiler RTTI only when all of the following are true:

- it executes on the build host and is never loaded by the runtime;
- it is resolved through the host dependency graph or an explicitly supplied executable path;
- none of its C++ objects or transitive archives appear in a shipped target's link command;
- it is not copied into desktop, Web, Android, or editor-export player templates;
- the exemption and graph boundary are documented in this file.

The current approved example is the embedded shaderc/compiler closure linked only into the standalone
host `noveltea` CLI. The Linux link audit rejects host-tool archives in `noveltea-player`. A tool
becoming runtime-linked automatically voids the exemption and requires full admission review.

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
