#pragma once

#include "noveltea/assets/asset_path.hpp"

#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::assets {

using AssetBytes = std::vector<std::uint8_t>;
using AssetText = std::string;

template<class T>
struct AssetResult {
    std::optional<T> value;
    std::string error;

    [[nodiscard]] explicit operator bool() const { return value.has_value(); }
};

class AssetReader {
public:
    virtual ~AssetReader() = default;
    [[nodiscard]] virtual std::size_t read(void* buffer, std::size_t bytes) = 0;
    [[nodiscard]] virtual bool seek(std::int64_t offset, int origin) = 0;
    [[nodiscard]] virtual std::uint64_t tell() const = 0;
    [[nodiscard]] virtual std::uint64_t size() const = 0;
};

struct AssetBlob {
    AssetBytes bytes;
    AssetPath logical_path;
    std::string source_description;
    std::optional<std::filesystem::path> native_path;
};

using AssetReaderPtr = std::unique_ptr<AssetReader>;

class AssetSource {
public:
    virtual ~AssetSource() = default;
    [[nodiscard]] virtual AssetResult<AssetReaderPtr> open(const AssetPath& path) const = 0;
    [[nodiscard]] virtual AssetResult<AssetBlob> read_binary(const AssetPath& path) const;
    [[nodiscard]] virtual bool exists(const AssetPath& path) const = 0;
    [[nodiscard]] virtual std::string describe() const = 0;
    [[nodiscard]] virtual bool writable() const { return false; }
    [[nodiscard]] virtual const char* kind() const = 0;
};

class DirectoryAssetSource final : public AssetSource {
public:
    explicit DirectoryAssetSource(std::filesystem::path root, bool writable = false);

    [[nodiscard]] AssetResult<AssetReaderPtr> open(const AssetPath& path) const override;
    [[nodiscard]] AssetResult<AssetBlob> read_binary(const AssetPath& path) const override;
    [[nodiscard]] bool exists(const AssetPath& path) const override;
    [[nodiscard]] std::string describe() const override;
    [[nodiscard]] bool writable() const override { return m_writable; }
    [[nodiscard]] const char* kind() const override { return "directory"; }
    [[nodiscard]] const std::filesystem::path& root() const { return m_root; }

private:
    [[nodiscard]] std::filesystem::path resolve(const AssetPath& path) const;

    std::filesystem::path m_root;
    bool m_writable = false;
};

class SdlPackagedAssetSource final : public AssetSource {
public:
    explicit SdlPackagedAssetSource(std::string internal_prefix = {});

    [[nodiscard]] AssetResult<AssetReaderPtr> open(const AssetPath& path) const override;
    [[nodiscard]] AssetResult<AssetBlob> read_binary(const AssetPath& path) const override;
    [[nodiscard]] bool exists(const AssetPath& path) const override;
    [[nodiscard]] std::string describe() const override;
    [[nodiscard]] const char* kind() const override { return "SDL packaged"; }

private:
    [[nodiscard]] std::string map_path(const AssetPath& path) const;

    std::string m_internal_prefix;
};

class MemoryAssetSource final : public AssetSource {
public:
    void add(AssetPath path, AssetBytes bytes, std::string description = {});
    void add(std::string_view logical_path, AssetBytes bytes, std::string description = {});

    [[nodiscard]] AssetResult<AssetReaderPtr> open(const AssetPath& path) const override;
    [[nodiscard]] AssetResult<AssetBlob> read_binary(const AssetPath& path) const override;
    [[nodiscard]] bool exists(const AssetPath& path) const override;
    [[nodiscard]] std::string describe() const override;
    [[nodiscard]] const char* kind() const override { return "memory"; }

private:
    struct Entry {
        AssetBytes bytes;
        std::string description;
    };
    std::map<std::string, Entry> m_entries;
};

class ZipAssetSource : public AssetSource {
public:
    [[nodiscard]] AssetResult<AssetReaderPtr> open(const AssetPath& path) const override;
    [[nodiscard]] bool exists(const AssetPath& path) const override;
    [[nodiscard]] std::string describe() const override;
    [[nodiscard]] const char* kind() const override { return "ZIP"; }
};

using AssetSourcePtr = std::shared_ptr<const AssetSource>;

} // namespace noveltea::assets
