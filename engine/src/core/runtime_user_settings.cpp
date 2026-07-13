#include "noveltea/core/runtime_user_settings.hpp"

#include <cmath>

namespace noveltea::core {

RuntimeUserSettings RuntimeUserSettings::defaults() noexcept
{
    return RuntimeUserSettings(default_text_scale);
}

Result<RuntimeUserSettings, Diagnostics> RuntimeUserSettings::create(double text_scale)
{
    if (!std::isfinite(text_scale) || text_scale <= 0.0) {
        return Result<RuntimeUserSettings, Diagnostics>::failure(Diagnostics{Diagnostic{
            .code = "runtime_user_settings.invalid_text_scale",
            .message = "Runtime text scale must be a positive finite number.",
        }});
    }
    return Result<RuntimeUserSettings, Diagnostics>::success(RuntimeUserSettings(text_scale));
}

} // namespace noveltea::core
