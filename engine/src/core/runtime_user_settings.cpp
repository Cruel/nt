#include "noveltea/core/runtime_user_settings.hpp"

#include <algorithm>
#include <cmath>
#include <string>
#include <string_view>

namespace noveltea::core {
namespace {

enum class PolicyApplication {
    Clamp,
    Reject,
};

Result<void, Diagnostics> validate_scale(double scale, std::string_view field)
{
    if (std::isfinite(scale) && scale > 0.0)
        return Result<void, Diagnostics>::success();
    return Result<void, Diagnostics>::failure(Diagnostics{Diagnostic{
        .code = "runtime_user_settings.invalid_" + std::string(field),
        .message = "Runtime " + std::string(field) + " must be a positive finite number.",
    }});
}

Result<void, Diagnostics> validate_policy(const compiled::AccessibilityScalePolicy& policy,
                                          std::string_view field)
{
    if (std::isfinite(policy.minimum) && std::isfinite(policy.maximum) && policy.minimum > 0.0 &&
        policy.maximum > 0.0 && policy.minimum <= policy.maximum &&
        (!policy.enabled || (policy.minimum <= 1.0 && policy.maximum >= 1.0))) {
        return Result<void, Diagnostics>::success();
    }
    return Result<void, Diagnostics>::failure(Diagnostics{Diagnostic{
        .code = "runtime_user_settings.invalid_" + std::string(field) + "_policy",
        .message =
            "Runtime " + std::string(field) +
            " policy must have a positive ordered finite range and include 1.0 when enabled.",
    }});
}

Result<double, Diagnostics> apply_policy(double requested,
                                         const compiled::AccessibilityScalePolicy& policy,
                                         std::string_view field, PolicyApplication application)
{
    auto valid_policy = validate_policy(policy, field);
    if (!valid_policy)
        return Result<double, Diagnostics>::failure(std::move(valid_policy).error());
    if (!policy.enabled)
        return Result<double, Diagnostics>::success(1.0);
    auto valid_scale = validate_scale(requested, field);
    if (!valid_scale)
        return Result<double, Diagnostics>::failure(std::move(valid_scale).error());
    if (application == PolicyApplication::Clamp)
        return Result<double, Diagnostics>::success(
            std::clamp(requested, policy.minimum, policy.maximum));
    if (requested < policy.minimum || requested > policy.maximum) {
        return Result<double, Diagnostics>::failure(Diagnostics{Diagnostic{
            .code = "runtime_user_settings." + std::string(field) + "_out_of_range",
            .message = "Runtime " + std::string(field) + " must be between " +
                       std::to_string(policy.minimum) + " and " + std::to_string(policy.maximum) +
                       ".",
        }});
    }
    return Result<double, Diagnostics>::success(requested);
}

Result<RuntimeUserSettings, Diagnostics>
apply_accessibility(double ui_scale, double text_scale,
                    const compiled::AccessibilitySettings& accessibility,
                    PolicyApplication application)
{
    auto effective_ui = apply_policy(ui_scale, accessibility.ui_scale, "ui_scale", application);
    if (!effective_ui)
        return Result<RuntimeUserSettings, Diagnostics>::failure(std::move(effective_ui).error());
    auto effective_text =
        apply_policy(text_scale, accessibility.text_scale, "text_scale", application);
    if (!effective_text)
        return Result<RuntimeUserSettings, Diagnostics>::failure(std::move(effective_text).error());
    return RuntimeUserSettings::create(*effective_ui.value_if(), *effective_text.value_if());
}

} // namespace

RuntimeUserSettings RuntimeUserSettings::defaults() noexcept
{
    return RuntimeUserSettings(default_ui_scale, default_text_scale);
}

Result<RuntimeUserSettings, Diagnostics> RuntimeUserSettings::create(double ui_scale,
                                                                     double text_scale)
{
    auto valid_ui = validate_scale(ui_scale, "ui_scale");
    if (!valid_ui)
        return Result<RuntimeUserSettings, Diagnostics>::failure(std::move(valid_ui).error());
    auto valid_text = validate_scale(text_scale, "text_scale");
    if (!valid_text)
        return Result<RuntimeUserSettings, Diagnostics>::failure(std::move(valid_text).error());
    return Result<RuntimeUserSettings, Diagnostics>::success(
        RuntimeUserSettings(ui_scale, text_scale));
}

Result<RuntimeUserSettings, Diagnostics>
RuntimeUserSettings::load(double ui_scale, double text_scale,
                          const compiled::AccessibilitySettings& accessibility)
{
    return apply_accessibility(ui_scale, text_scale, accessibility, PolicyApplication::Clamp);
}

Result<RuntimeUserSettings, Diagnostics>
RuntimeUserSettings::with_ui_scale(double ui_scale,
                                   const compiled::AccessibilitySettings& accessibility) const
{
    return apply_accessibility(ui_scale, m_text_scale, accessibility, PolicyApplication::Reject);
}

Result<RuntimeUserSettings, Diagnostics>
RuntimeUserSettings::with_text_scale(double text_scale,
                                     const compiled::AccessibilitySettings& accessibility) const
{
    return apply_accessibility(m_ui_scale, text_scale, accessibility, PolicyApplication::Reject);
}

} // namespace noveltea::core
