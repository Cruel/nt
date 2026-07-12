# C++ Runtime Dependency Policy

NovelTea ships C++ runtime code with C++ exceptions and compiler RTTI disabled. This document records
the Phase 0 dependency audit baseline. A dependency is not considered compliant merely because one
NovelTea target compiles with `-fno-exceptions` or `-fno-rtti`; its own C++ objects and transitive C++
objects must be built and tested under the same policy.

| Dependency | Language | No-exception direction | RTTI direction | Failure behavior / remaining proof |
| --- | --- | --- | --- | --- |
| nlohmann-json | Header-only C++ | Enable `JSON_NOEXCEPTION=1` after Phase 3 removes throwing access | Compile consumers without RTTI | Non-throwing parse is available; extraction and lookup paths remain under the policy ceiling |
| sol2 | Header-only C++ | `SOL_NO_EXCEPTIONS=1` after Phase 4 protected-result conversion | `SOL_NO_RTTI=1` plus compiler flags | Lua syntax/runtime/conversion failures need explicit result-path tests |
| Lua | C | Protected calls and status codes | Not applicable | Panic remains fatal; ordinary script errors must not reach panic |
| RmlUi / Lua / Debugger | C++ | Rebuild all selected targets without exceptions | `RMLUI_CUSTOM_RTTI` consistently across the family and all consumers | Invalid authored resources require failure-path verification |
| rmlui-bgfx | C++ | Rebuild without exceptions | Rebuild without compiler RTTI using the same RmlUi custom RTTI ABI | Renderer callbacks and resource failures require explicit audit |
| bgfx / bx / bimg | C++ | Rebuild source targets without exceptions | Rebuild without compiler RTTI | Assertions/fatal callbacks are retained; recoverable asset failures must be handled by NovelTea |
| twink | C++ | Rebuild without exceptions | Rebuild without compiler RTTI | Callback and allocation behavior require verification |
| Dear ImGui | C++ | Rebuild without exceptions when enabled | Rebuild without compiler RTTI | Debug-only, but still part of the linked runtime graph |
| SDL3 | C | Status-code integration | Not applicable | Audit NovelTea callback and return-value handling |
| miniaudio | C | Status-code integration | Not applicable | Audit backend return values and callback boundaries |
| FreeType | C | Status-code integration | Not applicable | Audit loader error propagation |
| HarfBuzz | C/C++ build-dependent | Verify selected package objects | Verify any C++ objects | Current integration must be inspected per platform package |
| SheenBidi | C | Status-code integration | Not applicable | Audit adapter return values |
| libunibreak | C | Status-code integration | Not applicable | Audit adapter return values |
| miniz | C | Status-code integration | Not applicable | ZIP/package errors must remain recoverable |

## Admission checklist

Any new shipped runtime dependency must record its language, exact no-exception configuration, exact
no-RTTI or custom-RTTI configuration, transitive C++ graph, replacement failure mechanism, recoverable
API subset, platform availability, and representative failure-path tests before it is admitted.
