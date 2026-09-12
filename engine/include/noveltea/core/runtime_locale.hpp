#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/feature_view.hpp"

#include <string>
#include <utility>
#include <vector>

namespace noveltea::core {

inline RuntimeLocaleOptionView runtime_locale_option(const compiled::LocaleDefinition& locale)
{
    std::vector<std::string> font_families;
    font_families.reserve(locale.font_stack.size());
    for (const auto& font : locale.font_stack)
        font_families.push_back(font.text());
    return {.locale = locale.locale,
            .native_name = locale.native_name,
            .display_name = locale.display_name,
            .right_to_left = locale.right_to_left,
            .font_families = std::move(font_families)};
}

} // namespace noveltea::core
