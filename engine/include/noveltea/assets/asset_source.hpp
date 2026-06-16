#pragma once

#include "noveltea/assets/asset_path.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::assets {

using AssetBytes = std::vector<std::uint8_t>;
using AssetText = std::string;

struct AssetReadResult {
    AssetBytes bytes;
    std::filesystem::path physical_path;
};

class AssetSource {
public:
    virtual ~AssetSource() = default;
    [[nodiscard]] virtual std::optional<AssetReadResult> read_binary(const AssetPath& path) const = 0;
    [[nodiscard]] virtual bool exists(const AssetPath& path) const = 0;
    [[nodiscard]] virtual std::string describe() const = 0;
};

class DirectoryAssetSource final : public AssetSource {
public:
    explicit DirectoryAssetSource(std::filesystem::path root);

    [[nodiscard]] std::optional<AssetReadResult> read_binary(const AssetPath& path) const override;
    [[nodiscard]] bool exists(const AssetPath& path) const override;
    [[nodiscard]] std::string describe() const override;
    [[nodiscard]] const std::filesystem::path& root() const { return m_root; }

private:
    [[nodiscard]] std::filesystem::path resolve(const AssetPath& path) const;

    std::filesystem::path m_root;
};

// Future ZipAssetSource should expose the same read-only interface for .ntzip
// packages; runtime code should not care whether bytes came from a directory
// tree or package index.
using AssetSourcePtr = std::shared_ptr<const AssetSource>;

} // namespace noveltea::assets
