#pragma once

#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/legacy/project_package_reader.hpp"

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace noveltea::assets {

class AssetManager {
public:
    void mount(std::string namespace_name, AssetSourcePtr source);
    void mount_directory(std::string namespace_name, std::filesystem::path root,
                         bool writable = false);
    void mount_legacy_package(std::string namespace_name,
                              const ::noveltea::core::legacy::ProjectPackage& package);

    [[nodiscard]] AssetResult<AssetReaderPtr> open(std::string_view logical_path) const;
    [[nodiscard]] AssetResult<AssetBlob> read_binary(std::string_view logical_path) const;
    [[nodiscard]] AssetResult<AssetText> read_text(std::string_view logical_path) const;
    [[nodiscard]] bool exists(std::string_view logical_path) const;
    [[nodiscard]] bool has_namespace(std::string_view namespace_name) const;

    [[nodiscard]] std::vector<std::string> describe_mounts() const;

private:
    [[nodiscard]] const std::vector<AssetSourcePtr>* sources_for(const AssetPath& path) const;
    [[nodiscard]] std::string namespace_for(const AssetPath& path) const;

    std::unordered_map<std::string, std::vector<AssetSourcePtr>> m_mounts;
};

} // namespace noveltea::assets
