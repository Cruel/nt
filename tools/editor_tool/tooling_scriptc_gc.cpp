#include "tooling_native_c.h"

#include <cstddef>
#include <cstdint>

struct JSContext;
struct JSRuntime;

extern "C" void* scr_island_lre_opaque(void);
extern "C" JSRuntime* JS_GetRuntime(JSContext* context);
extern "C" void JS_RunGC(JSRuntime* runtime);
extern "C" void JS_SetGCThreshold(JSRuntime* runtime, std::size_t threshold);

namespace {

JSRuntime* scriptc_runtime()
{
    auto* context = static_cast<JSContext*>(scr_island_lre_opaque());
    return context == nullptr ? nullptr : JS_GetRuntime(context);
}

} // namespace

extern "C" void noveltea_tooling_scriptc_run_gc(void)
{
    if (auto* runtime = scriptc_runtime(); runtime != nullptr)
        JS_RunGC(runtime);
}

extern "C" void noveltea_tooling_scriptc_set_gc_threshold(std::uint32_t threshold_bytes)
{
    if (auto* runtime = scriptc_runtime(); runtime != nullptr)
        JS_SetGCThreshold(runtime, threshold_bytes);
}
