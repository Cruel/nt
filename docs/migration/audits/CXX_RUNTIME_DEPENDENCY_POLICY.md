# C++ Runtime Dependency Policy Audit

This is the phase-0 audit baseline. “Pending” items are migration work, not approval to ship an
exception- or compiler-RTTI-enabled object. The required end state is defined by the architecture plan.

| Dependency | Language | Error mechanism used by NovelTea | No-exception / no-RTTI direction | Status |
|---|---|---|---|---|
| nlohmann-json | C++ | parse sentinel plus validated access (target) | `JSON_NOEXCEPTION=1`, `-fno-exceptions`, `-fno-rtti` | Pending phase 3 |
| sol2 | C++ headers | protected Lua results | `SOL_NO_EXCEPTIONS=1`, `SOL_NO_RTTI=1` | Pending phase 4 |
| Lua | C | status codes, protected calls, panic for fatal misuse | Build as C | Audit in phase 4 |
| RmlUi / Lua / Debugger | C++ | return values, logs; custom RTTI | `RMLUI_CUSTOM_RTTI`, compiler features disabled consistently | Pending phases 2A/6 |
| rmlui-bgfx | C++ | renderer return values and diagnostics | Same RmlUi ABI policy | Pending phase 6 |
| bgfx / bx / bimg | C++ | handles, assertions, fatal callback | compiler features disabled; classify fatal callbacks | Pending phase 6 |
| twink | C++ | callback/state API | compiler features disabled; callbacks cannot throw | Pending phase 6 |
| Dear ImGui | C++ | assertions / return values | compiler features disabled | Pending phase 6 |
| SDL3, miniaudio, FreeType, HarfBuzz, SheenBidi, libunibreak, miniz | C | status codes / null values | Keep C; audit adapters and substituted platform objects | Pending phases 5/6 |

Every update must record the exact version, transitive C++ objects, compile definitions/options,
replacement failure behavior, ABI impact, and a representative failure-path test before changing a
row to verified.
