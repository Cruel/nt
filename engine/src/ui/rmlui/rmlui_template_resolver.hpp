#pragma once

#include <string>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea::ui::rmlui {

class RuntimeUiTemplateResolver {
public:
    explicit RuntimeUiTemplateResolver(const assets::AssetManager& assets);

    [[nodiscard]] std::string resolve_runtime_document() const;

    [[nodiscard]] std::string resolve_stylesheet(const std::string& name) const;

private:
    [[nodiscard]] std::string resolve_path(const std::string& name) const;

    const assets::AssetManager& m_assets;
    mutable bool m_logged_theme_missing = false;
    mutable bool m_logged_old_compat = false;
};

} // namespace noveltea::ui::rmlui
