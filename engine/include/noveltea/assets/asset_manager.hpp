#pragma once

#include "noveltea/assets/asset_source.hpp"

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
    void mount_directory(std::string namespace_name, std::filesystem::path root);

    [[nodiscard]] std::optional<AssetReadResult> read_binary(std::string_view logical_path) const;
    [[nodiscard]] std::optional<AssetText> read_text(std::string_view logical_path) const;
    [[nodiscard]] bool exists(std::string_view logical_path) const;

    [[nodiscard]] const std::string& last_error() const { return m_last_error; }
    [[nodiscard]] std::vector<std::string> describe_mounts() const;

private:
    [[nodiscard]] const std::vector<AssetSourcePtr>* sources_for(const AssetPath& path) const;
    void set_error(std::string message) const;

    std::unordered_map<std::string, std::vector<AssetSourcePtr>> m_mounts;
    mutable std::string m_last_error;
};

} // namespace noveltea::assets
