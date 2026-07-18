#pragma once

#include "noveltea/runtime_ui_contracts.hpp"

#include <string>
#include <vector>

namespace noveltea::core {
class CompiledProject;
}

namespace noveltea::host {

class RuntimeUiProjectAssetService final : public RuntimeUiAssetService {
public:
    RuntimeUiProjectAssetService() = default;
    ~RuntimeUiProjectAssetService() override = default;

    RuntimeUiProjectAssetService(const RuntimeUiProjectAssetService&) = delete;
    RuntimeUiProjectAssetService& operator=(const RuntimeUiProjectAssetService&) = delete;
    RuntimeUiProjectAssetService(RuntimeUiProjectAssetService&&) = delete;
    RuntimeUiProjectAssetService& operator=(RuntimeUiProjectAssetService&&) = delete;

    void install(const core::CompiledProject& project);
    void clear() noexcept { m_assets.clear(); }

    [[nodiscard]] std::optional<std::string> resolve(const core::AssetId& asset) const override;

private:
    struct AssetEntry {
        core::AssetId id;
        std::string logical_path;
    };

    std::vector<AssetEntry> m_assets;
};

} // namespace noveltea::host
