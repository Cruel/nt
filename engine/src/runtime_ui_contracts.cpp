#include "noveltea/runtime_ui_contracts.hpp"

#include "noveltea/core/compiled_project.hpp"

namespace noveltea {

std::optional<std::string> CompiledRuntimeUiAssetService::resolve(const core::AssetId& asset) const
{
    if (!m_project)
        return std::nullopt;
    const auto* resource = m_project->find_asset(asset);
    if (!resource)
        return std::nullopt;
    return "project:/" + resource->path;
}

} // namespace noveltea
