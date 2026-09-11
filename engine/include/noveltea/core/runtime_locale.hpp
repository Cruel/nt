#pragma once

#include "noveltea/core/feature_view.hpp"

#include <array>
#include <string>
#include <string_view>

namespace noveltea::core {

inline RuntimeLocaleOptionView runtime_locale_option(std::string_view locale)
{
    struct LanguageName {
        std::string_view language;
        std::string_view native_name;
        std::string_view display_name;
        bool right_to_left;
    };
    static constexpr std::array names{
        LanguageName{"ar", "العربية", "Arabic", true},
        LanguageName{"cs", "Čeština", "Czech", false},
        LanguageName{"de", "Deutsch", "German", false},
        LanguageName{"en", "English", "English", false},
        LanguageName{"es", "Español", "Spanish", false},
        LanguageName{"fa", "فارسی", "Persian", true},
        LanguageName{"fr", "Français", "French", false},
        LanguageName{"he", "עברית", "Hebrew", true},
        LanguageName{"it", "Italiano", "Italian", false},
        LanguageName{"ja", "日本語", "Japanese", false},
        LanguageName{"ko", "한국어", "Korean", false},
        LanguageName{"nl", "Nederlands", "Dutch", false},
        LanguageName{"pl", "Polski", "Polish", false},
        LanguageName{"pt", "Português", "Portuguese", false},
        LanguageName{"ru", "Русский", "Russian", false},
        LanguageName{"tr", "Türkçe", "Turkish", false},
        LanguageName{"uk", "Українська", "Ukrainian", false},
        LanguageName{"ur", "اردو", "Urdu", true},
        LanguageName{"zh", "中文", "Chinese", false},
    };

    const auto separator = locale.find('-');
    std::string language(locale.substr(0, separator));
    for (auto& ch : language)
        if (ch >= 'A' && ch <= 'Z')
            ch = static_cast<char>(ch - 'A' + 'a');

    std::string native_name(locale);
    std::string display_name(locale);
    bool right_to_left = false;
    for (const auto& entry : names) {
        if (entry.language != language)
            continue;
        native_name = std::string(entry.native_name);
        display_name = std::string(entry.display_name);
        right_to_left = entry.right_to_left;
        if (separator != std::string_view::npos && separator + 1 < locale.size()) {
            const std::string region(locale.substr(separator + 1));
            native_name += " (" + region + ")";
            display_name += " (" + region + ")";
        }
        break;
    }
    return {.locale = std::string(locale),
            .native_name = std::move(native_name),
            .display_name = std::move(display_name),
            .right_to_left = right_to_left};
}

} // namespace noveltea::core
