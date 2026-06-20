#include "ui/rmlui/rmlui_template_resolver.hpp"

#include "noveltea/assets/asset_manager.hpp"

#include <cstdio>

namespace noveltea::ui::rmlui {

RuntimeUiTemplateResolver::RuntimeUiTemplateResolver(const assets::AssetManager& assets)
    : m_assets(assets)
{
}

std::string RuntimeUiTemplateResolver::resolve_runtime_document() const
{
    return resolve_path("runtime_game.rml");
}

std::string RuntimeUiTemplateResolver::resolve_stylesheet(const std::string& name) const
{
    return resolve_path(name);
}

std::string RuntimeUiTemplateResolver::resolve_path(const std::string& name) const
{
    const std::string project_path = "project:/ui/runtime/" + name;
    if (m_assets.exists(project_path)) {
        return project_path;
    }

    if (m_assets.has_namespace("theme")) {
        const std::string theme_path = "theme:/ui/runtime/" + name;
        if (m_assets.exists(theme_path)) {
            return theme_path;
        }
    } else if (!m_logged_theme_missing) {
        std::printf("[runtime_ui] no theme namespace mounted; skipping theme:/ui/runtime/%s\n",
                    name.c_str());
        m_logged_theme_missing = true;
    }

    const std::string system_path = "system:/ui/runtime/" + name;
    if (m_assets.exists(system_path)) {
        return system_path;
    }

    const std::string old_compat_path = "project:/rmlui/" + name;
    if (m_assets.exists(old_compat_path)) {
        if (!m_logged_old_compat) {
            std::printf("[runtime_ui] using legacy compat path %s for %s\n",
                        old_compat_path.c_str(), name.c_str());
            m_logged_old_compat = true;
        }
        return old_compat_path;
    }

    std::fprintf(stderr, "[runtime_ui] runtime document '%s' not found at any fallback location\n",
                 name.c_str());
    return {};
}

} // namespace noveltea::ui::rmlui
