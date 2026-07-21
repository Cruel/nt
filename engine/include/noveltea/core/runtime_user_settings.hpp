#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

namespace noveltea::core {

class RuntimeUserSettings {
public:
    static constexpr double default_ui_scale = 1.0;
    static constexpr double default_text_scale = 1.0;

    [[nodiscard]] static RuntimeUserSettings defaults() noexcept;
    [[nodiscard]] static Result<RuntimeUserSettings, Diagnostics> create(double ui_scale,
                                                                         double text_scale);
    [[nodiscard]] static Result<RuntimeUserSettings, Diagnostics>
    load(double ui_scale, double text_scale, const compiled::AccessibilitySettings& accessibility);

    [[nodiscard]] Result<RuntimeUserSettings, Diagnostics>
    with_ui_scale(double ui_scale, const compiled::AccessibilitySettings& accessibility) const;
    [[nodiscard]] Result<RuntimeUserSettings, Diagnostics>
    with_text_scale(double text_scale, const compiled::AccessibilitySettings& accessibility) const;

    [[nodiscard]] double ui_scale() const noexcept { return m_ui_scale; }
    [[nodiscard]] double text_scale() const noexcept { return m_text_scale; }
    bool operator==(const RuntimeUserSettings&) const = default;

private:
    RuntimeUserSettings(double ui_scale, double text_scale) noexcept
        : m_ui_scale(ui_scale), m_text_scale(text_scale)
    {
    }

    double m_ui_scale;
    double m_text_scale;
};

} // namespace noveltea::core
