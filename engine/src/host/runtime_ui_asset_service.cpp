#include "noveltea/runtime_ui_contracts.hpp"

#include "noveltea/core/compiled_project.hpp"

#include <algorithm>

namespace noveltea {

void RuntimeUiProjectAssetService::install(const core::CompiledProject& project)
{
    m_assets.clear();
    m_assets.reserve(project.assets().size());
    for (const auto& resource : project.assets())
        m_assets.push_back({resource.id, "project:/" + resource.path});
}

std::optional<std::string> RuntimeUiProjectAssetService::resolve(const core::AssetId& asset) const
{
    const auto found = std::find_if(m_assets.begin(), m_assets.end(),
                                    [&](const auto& entry) { return entry.id == asset; });
    return found == m_assets.end() ? std::nullopt : std::optional<std::string>{found->logical_path};
}

} // namespace noveltea
