#include "host/runtime_ui_asset_service.hpp"

#include "noveltea/core/compiled_project.hpp"

#include <algorithm>

namespace noveltea::host {

void RuntimeUiProjectAssetService::install(const core::CompiledProject& project,
                                           std::string_view active_locale)
{
    m_assets.clear();
    m_assets.reserve(project.assets().size());
    for (const auto& resource : project.assets()) {
        const auto* resolved = project.resolve_asset(resource.id, active_locale);
        if (resolved != nullptr)
            m_assets.push_back({resource.id, "project:/" + resolved->path});
    }
}

std::optional<std::string> RuntimeUiProjectAssetService::resolve(const core::AssetId& asset) const
{
    const auto found = std::find_if(m_assets.begin(), m_assets.end(),
                                    [&](const auto& entry) { return entry.id == asset; });
    return found == m_assets.end() ? std::nullopt : std::optional<std::string>{found->logical_path};
}

} // namespace noveltea::host
