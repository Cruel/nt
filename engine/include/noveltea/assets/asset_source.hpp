#pragma once

#include "noveltea/assets/asset_path.hpp"

#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::assets {

using AssetBytes = std::vector<std::uint8_t>;
using AssetText = std::string;

template<class T> struct AssetLoadResult {
    std::optional<T> value;
    std::string error;

    [[nodiscard]] explicit operator bool() const { return value.has_value(); }
};

template<> struct AssetLoadResult<void> {
    bool ok = false;
    std::string error;

    [[nodiscard]] explicit operator bool() const { return ok; }
};

namespace asset_source_error_code {
inline constexpr std::string_view not_found = "asset.source.not_found";
inline constexpr std::string_view unsafe_path = "asset.source.unsafe_path";
inline constexpr std::string_view open_failed = "asset.source.open_failed";
inline constexpr std::string_view read_failed = "asset.source.read_failed";
inline constexpr std::string_view seek_failed = "asset.source.seek_failed";
inline constexpr std::string_view corrupt = "asset.source.corrupt";
inline constexpr std::string_view unsupported_storage = "asset.source.unsupported_storage";
inline constexpr std::string_view invalidated = "asset.source.invalidated";
} // namespace asset_source_error_code

struct AssetSourceError {
    std::string code;
    std::string message;
    AssetPath logical_path;
    std::string source_description;
};

template<class T> struct AssetResult {
    std::optional<T> value;
    AssetSourceError error;

    [[nodiscard]] explicit operator bool() const { return value.has_value(); }
};

template<> struct AssetResult<void> {
    bool ok = false;
    AssetSourceError error;

    [[nodiscard]] explicit operator bool() const { return ok; }
};

enum class AssetSeekOrigin : std::uint8_t {
    Begin,
    Current,
    End,
};

struct AssetEntryMetadata {
    std::uint64_t uncompressed_size = 0;
    std::optional<std::uint64_t> compressed_size;
    bool seekable = false;
};

class AssetReader {
public:
    virtual ~AssetReader() = default;
    [[nodiscard]] virtual AssetResult<std::size_t> read(void* buffer,
                                                        std::size_t bytes) noexcept = 0;
    [[nodiscard]] virtual AssetResult<void> seek(std::int64_t offset,
                                                 AssetSeekOrigin origin) noexcept = 0;
    [[nodiscard]] virtual AssetResult<std::uint64_t> tell() const noexcept = 0;
    [[nodiscard]] virtual AssetResult<std::uint64_t> size() const noexcept = 0;
    [[nodiscard]] virtual std::optional<std::filesystem::path> native_path() const
    {
        return std::nullopt;
    }
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
    [[nodiscard]] virtual AssetResult<AssetEntryMetadata> stat(const AssetPath& path) const = 0;
    [[nodiscard]] virtual AssetResult<AssetReaderPtr> open(const AssetPath& path) const = 0;
    [[nodiscard]] virtual AssetResult<AssetBlob> read_binary(const AssetPath& path) const;
    [[nodiscard]] virtual bool exists(const AssetPath& path) const = 0;
    [[nodiscard]] virtual std::string describe() const = 0;
    [[nodiscard]] virtual bool writable() const
    {
        return false;
    } // Capability metadata; writes are exposed by WritableAssetSource.
    [[nodiscard]] virtual const char* kind() const = 0;
};

class WritableAssetSource : public AssetSource {
public:
    [[nodiscard]] virtual AssetResult<void> write_binary(const AssetPath& path,
                                                         const AssetBytes& bytes) = 0;
    [[nodiscard]] virtual AssetResult<void> remove(const AssetPath& path) = 0;
};

class DirectoryAssetSource final : public AssetSource {
public:
    explicit DirectoryAssetSource(std::filesystem::path root, bool writable = false);

    [[nodiscard]] AssetResult<AssetEntryMetadata> stat(const AssetPath& path) const override;
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

    [[nodiscard]] AssetResult<AssetEntryMetadata> stat(const AssetPath& path) const override;
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

    [[nodiscard]] AssetResult<AssetEntryMetadata> stat(const AssetPath& path) const override;
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
    struct EntryInventory {
        std::string path;
        AssetEntryMetadata metadata;
        std::uint32_t crc32 = 0;
    };

    explicit ZipAssetSource(std::filesystem::path archive_path);
    explicit ZipAssetSource(AssetBytes archive_bytes);
    explicit ZipAssetSource(std::shared_ptr<const AssetBytes> archive_bytes);

    ~ZipAssetSource() override;

    ZipAssetSource(const ZipAssetSource&) = delete;
    ZipAssetSource& operator=(const ZipAssetSource&) = delete;
    ZipAssetSource(ZipAssetSource&&) noexcept;
    ZipAssetSource& operator=(ZipAssetSource&&) noexcept;

    [[nodiscard]] AssetResult<AssetEntryMetadata> stat(const AssetPath& path) const override;
    [[nodiscard]] AssetResult<AssetReaderPtr> open(const AssetPath& path) const override;
    [[nodiscard]] bool exists(const AssetPath& path) const override;
    [[nodiscard]] std::string describe() const override;
    [[nodiscard]] const char* kind() const override { return "ZIP"; }

    [[nodiscard]] AssetResult<std::vector<EntryInventory>> inventory() const;

    [[nodiscard]] AssetResult<void>
    validate_long_form_audio(std::span<const AssetPath> paths) const;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

using AssetSourcePtr = std::shared_ptr<const AssetSource>;

} // namespace noveltea::assets
