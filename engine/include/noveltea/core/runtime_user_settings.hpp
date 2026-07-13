#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

namespace noveltea::core {

class RuntimeUserSettings {
public:
    static constexpr double default_text_scale = 1.0;

    [[nodiscard]] static RuntimeUserSettings defaults() noexcept;
    [[nodiscard]] static Result<RuntimeUserSettings, Diagnostics> create(double text_scale);

    [[nodiscard]] double text_scale() const noexcept { return m_text_scale; }

private:
    explicit RuntimeUserSettings(double text_scale) noexcept : m_text_scale(text_scale) {}

    double m_text_scale;
};

} // namespace noveltea::core
