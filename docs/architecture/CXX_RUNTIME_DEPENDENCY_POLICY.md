# C++ Runtime Dependency Policy

NovelTea ships C++ runtime code with C++ exceptions and compiler RTTI disabled. A dependency is not
considered compliant merely because one NovelTea target compiles with `-fno-exceptions` or
`-fno-rtti`; its own C++ objects and transitive C++ objects must be built under the same policy.

Desktop target libraries are rebuilt through NovelTea vcpkg triplets. Build-host executables are kept
on the ordinary host triplet because they do not enter the shipped runtime link graph. Web and Android
C++ dependencies are built from source and receive the policy directly on their CMake targets.

| Dependency | Version / source | Policy configuration | Failure behavior |
| --- | --- | --- | --- |
| nlohmann-json | 3.12.0 | Header-only consumers define `JSON_NOEXCEPTION=1` and compile without exceptions/RTTI. | Invalid external data is handled through non-throwing parse and checked access. Internal invariant violations are fatal under the library's no-exception mode. |
| sol2 | 3.5.0 | Header-only consumers define `SOL_NO_EXCEPTIONS=1` and `SOL_NO_RTTI=1` and compile without exceptions/RTTI. | Lua syntax, runtime, conversion, binding, and coroutine failures use protected-result/status paths. Lua panic remains fatal. |
| Lua | 5.5.0 | Built as C. No C++ Lua wrapper library is linked. | Ordinary script failures are protected Lua errors; panic and allocation exhaustion are fatal. |
| RmlUi Core / Lua / Debugger | 6.2 | Entire family and every consumer define `RMLUI_CUSTOM_RTTI` and `ITLIB_FLAT_MAP_NO_THROW`, and compile without exceptions/RTTI. | Invalid authored resources use RmlUi return/logging paths. Failed checked casts return null. `itlib::flat_map::at()` invariant failures assert instead of throwing. |
| rmlui-bgfx | configured Git ref/local checkout | Built from source without exceptions/RTTI under the same RmlUi custom-RTTI ABI. | Recoverable renderer/resource failures are returned or logged; renderer assertions and impossible-state failures remain fatal. |
| bgfx / bx / bimg | vcpkg `1.129.8940-496#1`; source build on Web/Android | Runtime libraries compile without exceptions/RTTI. | Assertions and fatal callbacks remain intentional process-fatal boundaries. NovelTea handles recoverable shader, texture, and asset failures before reaching those boundaries. |
| twink | commit `ea488b2d6a0c032ffefdeb0e5e064749706e29fd` | Built from source without exceptions/RTTI. | Invalid runtime inputs are constrained by NovelTea's typed tween boundary. Allocation exhaustion and violated internal contracts are fatal. |
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
on RmlUi and `rmlui-bgfx` commands. On Linux it inspects the final player link command and rejects any
ordinary `x64-linux` target archive.

Phase 6 verification covers clean Linux, Web, and Android builds. Windows and macOS triplets are
defined but require their native builders before they can be marked validated.

## Admission checklist

Any new shipped runtime dependency must record its language, exact no-exception configuration, exact
no-RTTI or custom-RTTI configuration, transitive C++ graph, replacement failure mechanism, recoverable
API subset, platform availability, and representative failure-path tests before it is admitted.
