#include "noveltea/assets/asset_source.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <utility>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

namespace noveltea::assets {
namespace {

struct PathZipBacking {
    explicit PathZipBacking(const std::filesystem::path& path) : stream(path, std::ios::binary)
    {
        if (!stream)
            return;
        stream.seekg(0, std::ios::end);
        const auto end = stream.tellg();
        if (end < 0)
            return;
        size = static_cast<std::uint64_t>(end);
        stream.seekg(0, std::ios::beg);
        ready = !stream.fail();
    }

    [[nodiscard]] bool read_at(std::uint64_t offset, void* destination,
                               std::size_t count) const noexcept
    {
        if (!ready || (count != 0 && destination == nullptr) || offset > size ||
            count > size - offset ||
            offset > static_cast<std::uint64_t>(std::numeric_limits<std::streamoff>::max()) ||
            count > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max())) {
            return false;
        }
        std::scoped_lock lock(mutex);
        stream.clear();
        stream.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
        if (stream.fail())
            return false;
        stream.read(static_cast<char*>(destination), static_cast<std::streamsize>(count));
        return static_cast<std::size_t>(stream.gcount()) == count;
    }

    mutable std::mutex mutex;
    mutable std::ifstream stream;
    std::uint64_t size = 0;
    bool ready = false;
};

struct ZipBacking {
    std::shared_ptr<PathZipBacking> file;
    std::shared_ptr<const AssetBytes> bytes;
    std::string description;
};

struct ZipEntry {
    std::uint32_t file_index = 0;
    std::uint64_t compressed_size = 0;
    std::uint64_t uncompressed_size = 0;
    std::uint64_t data_offset = 0;
    std::uint32_t crc32 = 0;
    std::uint16_t method = 0;
    bool supported = false;
    bool encrypted = false;
    bool seekable = false;
};

AssetSourceError make_error(std::string_view code, std::string message, const AssetPath& path,
                            const std::string& source_description)
{
    return AssetSourceError{.code = std::string(code),
                            .message = std::move(message),
                            .logical_path = path,
                            .source_description = source_description};
}

template<class T>
AssetResult<T> fail(std::string_view code, std::string message, const AssetPath& path,
                    const std::string& source_description)
{
    return {std::nullopt, make_error(code, std::move(message), path, source_description)};
}

std::string miniz_error(mz_zip_archive& archive)
{
    const auto error = mz_zip_peek_last_error(&archive);
    const char* text = mz_zip_get_error_string(error);
    return text ? std::string(text) : std::string("unknown miniz error");
}

size_t read_path_archive(void* opaque, mz_uint64 offset, void* buffer, size_t count)
{
    const auto* backing = static_cast<const PathZipBacking*>(opaque);
    return backing != nullptr && backing->read_at(offset, buffer, count) ? count : 0;
}

bool initialize_archive(mz_zip_archive& archive, const ZipBacking& backing)
{
    if (backing.file) {
        if (!backing.file->ready)
            return false;
        archive.m_pRead = read_path_archive;
        archive.m_pIO_opaque = backing.file.get();
        return mz_zip_reader_init(&archive, backing.file->size,
                                  MZ_ZIP_FLAG_DO_NOT_SORT_CENTRAL_DIRECTORY) != 0;
    }
    if (!backing.bytes)
        return false;
    return mz_zip_reader_init_mem(&archive, backing.bytes->data(), backing.bytes->size(),
                                  MZ_ZIP_FLAG_DO_NOT_SORT_CENTRAL_DIRECTORY) != 0;
}

std::optional<std::uint64_t> checked_seek_target(std::uint64_t current, std::uint64_t size,
                                                 std::int64_t offset, AssetSeekOrigin origin)
{
    std::uint64_t base = 0;
    switch (origin) {
    case AssetSeekOrigin::Begin:
        break;
    case AssetSeekOrigin::Current:
        base = current;
        break;
    case AssetSeekOrigin::End:
        base = size;
        break;
    }

    std::uint64_t target = base;
    if (offset < 0) {
        const auto magnitude = static_cast<std::uint64_t>(-(offset + 1)) + 1u;
        if (magnitude > base)
            return std::nullopt;
        target -= magnitude;
    } else {
        const auto magnitude = static_cast<std::uint64_t>(offset);
        if (magnitude > std::numeric_limits<std::uint64_t>::max() - base)
            return std::nullopt;
        target += magnitude;
    }
    if (target > size)
        return std::nullopt;
    return target;
}

std::uint16_t little_u16(const std::uint8_t* bytes)
{
    return static_cast<std::uint16_t>(bytes[0]) |
           static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[1]) << 8u);
}

std::uint32_t little_u32(const std::uint8_t* bytes)
{
    return static_cast<std::uint32_t>(bytes[0]) | (static_cast<std::uint32_t>(bytes[1]) << 8u) |
           (static_cast<std::uint32_t>(bytes[2]) << 16u) |
           (static_cast<std::uint32_t>(bytes[3]) << 24u);
}

std::optional<std::string> entry_filename(mz_zip_archive& archive, mz_uint index)
{
    const mz_uint required = mz_zip_reader_get_filename(&archive, index, nullptr, 0);
    if (required == 0)
        return std::nullopt;
    std::vector<char> buffer(static_cast<std::size_t>(required) + 1u, '\0');
    if (mz_zip_reader_get_filename(&archive, index, buffer.data(),
                                   static_cast<mz_uint>(buffer.size())) == 0) {
        return std::nullopt;
    }
    return std::string(buffer.data());
}

std::optional<AssetPath> safe_entry_path(std::string_view filename, bool directory)
{
    while (directory && !filename.empty() && filename.back() == '/')
        filename.remove_suffix(1);
    if (filename.empty())
        return std::nullopt;
    auto parsed = AssetPath::parse(filename);
    if (!parsed || parsed->has_namespace())
        return std::nullopt;
    return parsed;
}

bool conventional_long_form_path(std::string_view path)
{
    constexpr std::array prefixes = {std::string_view{"music/"}, std::string_view{"ambience/"},
                                     std::string_view{"audio/music/"},
                                     std::string_view{"audio/ambience/"}};
    return std::any_of(prefixes.begin(), prefixes.end(),
                       [path](std::string_view prefix) { return path.starts_with(prefix); });
}

class StoredZipReader final : public AssetReader {
public:
    StoredZipReader(std::shared_ptr<const ZipBacking> backing, ZipEntry entry, AssetPath path)
        : m_backing(std::move(backing)), m_entry(entry), m_path(std::move(path))
    {
        if (m_backing->file) {
            m_valid = m_backing->file->ready && m_entry.data_offset <= m_backing->file->size &&
                      m_entry.uncompressed_size <= m_backing->file->size - m_entry.data_offset;
        } else {
            m_valid = m_backing->bytes && m_entry.data_offset <= m_backing->bytes->size() &&
                      m_entry.uncompressed_size <=
                          m_backing->bytes->size() - static_cast<std::size_t>(m_entry.data_offset);
        }
    }

    [[nodiscard]] bool valid() const { return m_valid; }

    AssetResult<std::size_t> read(void* buffer, std::size_t bytes) noexcept override
    {
        if (bytes > 0 && !buffer) {
            return fail<std::size_t>(asset_source_error_code::read_failed,
                                     "ZIP stored reader received a null destination", m_path,
                                     m_backing->description);
        }
        const auto remaining = m_entry.uncompressed_size - m_position;
        const auto requested = static_cast<std::uint64_t>(bytes);
        const auto count64 = std::min(requested, remaining);
        const auto count = static_cast<std::size_t>(count64);
        if (count == 0)
            return {std::size_t{0}, {}};

        if (m_backing->file) {
            if (!m_backing->file->read_at(m_entry.data_offset + m_position, buffer, count)) {
                return fail<std::size_t>(asset_source_error_code::corrupt,
                                         "ZIP stored entry ended before its indexed size", m_path,
                                         m_backing->description);
            }
        } else {
            const auto absolute = m_entry.data_offset + m_position;
            if (!m_backing->bytes || absolute > m_backing->bytes->size() ||
                count > m_backing->bytes->size() - static_cast<std::size_t>(absolute)) {
                return fail<std::size_t>(asset_source_error_code::corrupt,
                                         "ZIP stored entry points outside the archive buffer",
                                         m_path, m_backing->description);
            }
            std::memcpy(buffer, m_backing->bytes->data() + static_cast<std::size_t>(absolute),
                        count);
        }

        if (m_crc_contiguous) {
            m_crc = mz_crc32(m_crc, static_cast<const mz_uint8*>(buffer), count);
        }
        m_position += count;
        if (m_position == m_entry.uncompressed_size && m_crc_contiguous && m_crc != m_entry.crc32) {
            return fail<std::size_t>(asset_source_error_code::corrupt,
                                     "ZIP stored entry CRC check failed", m_path,
                                     m_backing->description);
        }
        return {count, {}};
    }

    AssetResult<void> seek(std::int64_t offset, AssetSeekOrigin origin) noexcept override
    {
        const auto target =
            checked_seek_target(m_position, m_entry.uncompressed_size, offset, origin);
        if (!target) {
            return {false, make_error(asset_source_error_code::seek_failed,
                                      "ZIP stored seek is outside the entry", m_path,
                                      m_backing->description)};
        }
        if (*target == 0) {
            m_crc = MZ_CRC32_INIT;
            m_crc_contiguous = true;
        } else if (*target != m_position) {
            m_crc_contiguous = false;
        }
        m_position = *target;
        return {true, {}};
    }

    AssetResult<std::uint64_t> tell() const noexcept override { return {m_position, {}}; }
    AssetResult<std::uint64_t> size() const noexcept override
    {
        return {m_entry.uncompressed_size, {}};
    }

private:
    std::shared_ptr<const ZipBacking> m_backing;
    ZipEntry m_entry;
    AssetPath m_path;
    std::uint64_t m_position = 0;
    mz_ulong m_crc = MZ_CRC32_INIT;
    bool m_crc_contiguous = true;
    bool m_valid = false;
};

class CompressedZipReader final : public AssetReader {
public:
    CompressedZipReader(std::shared_ptr<const ZipBacking> backing, ZipEntry entry, AssetPath path)
        : m_backing(std::move(backing)), m_entry(entry), m_path(std::move(path))
    {
        m_archive_initialized = initialize_archive(m_archive, *m_backing);
        if (m_archive_initialized) {
            m_iterator = mz_zip_reader_extract_iter_new(&m_archive, m_entry.file_index, 0);
        }
    }

    ~CompressedZipReader() override
    {
        if (m_iterator)
            mz_zip_reader_extract_iter_free(m_iterator);
        if (m_archive_initialized)
            mz_zip_reader_end(&m_archive);
    }

    [[nodiscard]] bool valid() const { return m_archive_initialized && m_iterator; }

    AssetResult<std::size_t> read(void* buffer, std::size_t bytes) noexcept override
    {
        if (bytes > 0 && !buffer) {
            return fail<std::size_t>(asset_source_error_code::read_failed,
                                     "ZIP compressed reader received a null destination", m_path,
                                     m_backing->description);
        }
        if (bytes == 0 || m_position == m_entry.uncompressed_size)
            return {std::size_t{0}, {}};
        const auto remaining = m_entry.uncompressed_size - m_position;
        const auto request = static_cast<std::size_t>(
            std::min<std::uint64_t>(remaining, static_cast<std::uint64_t>(bytes)));
        const auto count = mz_zip_reader_extract_iter_read(m_iterator, buffer, request);
        if (count == 0) {
            return fail<std::size_t>(asset_source_error_code::corrupt,
                                     "ZIP compressed entry decompression failed: " +
                                         miniz_error(m_archive),
                                     m_path, m_backing->description);
        }
        if (count > request) {
            return fail<std::size_t>(asset_source_error_code::corrupt,
                                     "ZIP compressed reader exceeded the indexed entry size",
                                     m_path, m_backing->description);
        }
        m_position += count;
        const auto error = mz_zip_peek_last_error(&m_archive);
        if (error != MZ_ZIP_NO_ERROR) {
            return fail<std::size_t>(asset_source_error_code::corrupt,
                                     "ZIP compressed entry failed validation: " +
                                         miniz_error(m_archive),
                                     m_path, m_backing->description);
        }
        return {count, {}};
    }

    AssetResult<void> seek(std::int64_t offset, AssetSeekOrigin origin) noexcept override
    {
        const auto target =
            checked_seek_target(m_position, m_entry.uncompressed_size, offset, origin);
        if (!target || *target < m_position) {
            return {false, make_error(asset_source_error_code::seek_failed,
                                      "ZIP compressed readers support forward seek only", m_path,
                                      m_backing->description)};
        }
        std::array<std::uint8_t, 8192> scratch{};
        while (m_position < *target) {
            const auto count = static_cast<std::size_t>(
                std::min<std::uint64_t>(scratch.size(), *target - m_position));
            auto skipped = read(scratch.data(), count);
            if (!skipped)
                return {false, std::move(skipped.error)};
            if (*skipped.value == 0) {
                return {false, make_error(asset_source_error_code::seek_failed,
                                          "ZIP compressed forward seek reached EOF", m_path,
                                          m_backing->description)};
            }
        }
        return {true, {}};
    }

    AssetResult<std::uint64_t> tell() const noexcept override { return {m_position, {}}; }
    AssetResult<std::uint64_t> size() const noexcept override
    {
        return {m_entry.uncompressed_size, {}};
    }

private:
    std::shared_ptr<const ZipBacking> m_backing;
    ZipEntry m_entry;
    AssetPath m_path;
    mz_zip_archive m_archive{};
    mz_zip_reader_extract_iter_state* m_iterator = nullptr;
    std::uint64_t m_position = 0;
    bool m_archive_initialized = false;
};

} // namespace

struct ZipAssetSource::Impl {
    std::shared_ptr<const ZipBacking> backing;
    std::map<std::string, ZipEntry> entries;
    std::optional<AssetSourceError> initialization_error;
    bool zip64 = false;

    static std::unique_ptr<Impl> build(std::shared_ptr<const ZipBacking> backing);
};

std::unique_ptr<ZipAssetSource::Impl>
ZipAssetSource::Impl::build(std::shared_ptr<const ZipBacking> backing)
{
    auto impl = std::make_unique<ZipAssetSource::Impl>();
    impl->backing = std::move(backing);

    if (impl->backing->file) {
        if (!impl->backing->file->ready) {
            impl->initialization_error =
                make_error(asset_source_error_code::open_failed, "could not open ZIP archive file",
                           {}, impl->backing->description);
            return impl;
        }
    } else if (!impl->backing->bytes) {
        impl->initialization_error =
            make_error(asset_source_error_code::invalidated, "ZIP memory backing is unavailable",
                       {}, impl->backing->description);
        return impl;
    }

    mz_zip_archive archive{};
    if (!initialize_archive(archive, *impl->backing)) {
        const auto error = mz_zip_peek_last_error(&archive);
        impl->initialization_error = make_error(
            error == MZ_ZIP_FILE_OPEN_FAILED ? asset_source_error_code::open_failed
                                             : asset_source_error_code::corrupt,
            "could not open ZIP archive: " + miniz_error(archive), {}, impl->backing->description);
        return impl;
    }

    impl->zip64 = mz_zip_is_zip64(&archive) != 0;
    const auto archive_size = mz_zip_get_archive_size(&archive);
    const auto file_count = mz_zip_reader_get_num_files(&archive);
    for (mz_uint index = 0; index < file_count; ++index) {
        mz_zip_archive_file_stat stat{};
        if (!mz_zip_reader_file_stat(&archive, index, &stat)) {
            impl->initialization_error =
                make_error(asset_source_error_code::corrupt,
                           "could not read ZIP entry metadata: " + miniz_error(archive), {},
                           impl->backing->description);
            break;
        }
        const auto filename = entry_filename(archive, index);
        const bool directory = stat.m_is_directory != 0;
        const auto path = filename ? safe_entry_path(*filename, directory) : std::nullopt;
        if (!path) {
            impl->initialization_error =
                make_error(asset_source_error_code::unsafe_path,
                           "ZIP archive contains an unsafe entry path" +
                               (filename ? ": '" + *filename + "'" : std::string{}),
                           {}, impl->backing->description);
            break;
        }
        if (directory)
            continue;

        ZipEntry entry{.file_index = stat.m_file_index,
                       .compressed_size = stat.m_comp_size,
                       .uncompressed_size = stat.m_uncomp_size,
                       .data_offset = 0,
                       .crc32 = stat.m_crc32,
                       .method = stat.m_method,
                       .supported = stat.m_is_supported != 0,
                       .encrypted = stat.m_is_encrypted != 0,
                       .seekable = stat.m_method == 0 && stat.m_is_supported != 0 &&
                                   stat.m_is_encrypted == 0};

        if (entry.seekable) {
            if (entry.compressed_size != entry.uncompressed_size) {
                impl->initialization_error = make_error(
                    asset_source_error_code::corrupt,
                    "ZIP stored entry has inconsistent compressed and uncompressed sizes", *path,
                    impl->backing->description);
                break;
            }
            std::array<std::uint8_t, 30> local_header{};
            if (mz_zip_read_archive_data(&archive, stat.m_local_header_ofs, local_header.data(),
                                         local_header.size()) != local_header.size() ||
                little_u32(local_header.data()) != 0x04034b50u) {
                impl->initialization_error =
                    make_error(asset_source_error_code::corrupt,
                               "ZIP stored entry has an invalid local header", *path,
                               impl->backing->description);
                break;
            }
            const auto variable_size =
                static_cast<std::uint64_t>(little_u16(local_header.data() + 26)) +
                little_u16(local_header.data() + 28);
            if (stat.m_local_header_ofs >
                std::numeric_limits<std::uint64_t>::max() - local_header.size() - variable_size) {
                impl->initialization_error = make_error(asset_source_error_code::corrupt,
                                                        "ZIP stored entry data offset overflows",
                                                        *path, impl->backing->description);
                break;
            }
            entry.data_offset = stat.m_local_header_ofs + local_header.size() + variable_size;
            if (entry.data_offset > archive_size ||
                entry.compressed_size > archive_size - entry.data_offset) {
                impl->initialization_error = make_error(
                    asset_source_error_code::corrupt, "ZIP stored entry points outside the archive",
                    *path, impl->backing->description);
                break;
            }
        }

        if (conventional_long_form_path(path->relative_path()) && !entry.seekable) {
            impl->initialization_error =
                make_error(asset_source_error_code::unsupported_storage,
                           "long-form music or ambience entry must use ZIP stored storage", *path,
                           impl->backing->description);
            break;
        }

        if (!impl->entries.emplace(path->relative_path(), entry).second) {
            impl->initialization_error = make_error(asset_source_error_code::corrupt,
                                                    "ZIP archive contains duplicate entry paths",
                                                    *path, impl->backing->description);
            break;
        }
    }
    mz_zip_reader_end(&archive);

    if (impl->initialization_error)
        impl->entries.clear();
    return impl;
}

namespace {

std::shared_ptr<const ZipBacking> make_path_backing(std::filesystem::path archive_path)
{
    const auto description = "ZIP read-only:path:" + archive_path.string();
    return std::make_shared<ZipBacking>(ZipBacking{
        .file = std::make_shared<PathZipBacking>(archive_path),
        .bytes = nullptr,
        .description = description,
    });
}

std::shared_ptr<const ZipBacking>
make_memory_backing(std::shared_ptr<const AssetBytes> archive_bytes)
{
    const auto byte_count = archive_bytes ? archive_bytes->size() : 0;
    return std::make_shared<ZipBacking>(ZipBacking{
        .file = nullptr,
        .bytes = std::move(archive_bytes),
        .description = "ZIP read-only:memory:" + std::to_string(byte_count) + " bytes",
    });
}

} // namespace

ZipAssetSource::ZipAssetSource(std::filesystem::path archive_path)
    : m_impl(Impl::build(make_path_backing(std::move(archive_path))))
{
}

ZipAssetSource::ZipAssetSource(AssetBytes archive_bytes)
    : ZipAssetSource(std::make_shared<const AssetBytes>(std::move(archive_bytes)))
{
}

ZipAssetSource::ZipAssetSource(std::shared_ptr<const AssetBytes> archive_bytes)
    : m_impl(Impl::build(make_memory_backing(std::move(archive_bytes))))
{
}

ZipAssetSource::~ZipAssetSource() = default;
ZipAssetSource::ZipAssetSource(ZipAssetSource&&) noexcept = default;
ZipAssetSource& ZipAssetSource::operator=(ZipAssetSource&&) noexcept = default;

AssetResult<AssetEntryMetadata> ZipAssetSource::stat(const AssetPath& path) const
{
    if (!m_impl || !m_impl->backing) {
        return fail<AssetEntryMetadata>(asset_source_error_code::invalidated,
                                        "ZIP source has been invalidated", path,
                                        "ZIP read-only:<invalidated>");
    }
    if (m_impl->initialization_error)
        return {std::nullopt, *m_impl->initialization_error};
    const auto found = m_impl->entries.find(path.relative_path());
    if (found == m_impl->entries.end()) {
        return fail<AssetEntryMetadata>(asset_source_error_code::not_found,
                                        "ZIP archive has no matching entry", path,
                                        m_impl->backing->description);
    }
    const auto& entry = found->second;
    return {AssetEntryMetadata{.uncompressed_size = entry.uncompressed_size,
                               .compressed_size = entry.compressed_size,
                               .seekable = entry.seekable},
            {}};
}

AssetResult<AssetReaderPtr> ZipAssetSource::open(const AssetPath& path) const
{
    if (!m_impl || !m_impl->backing) {
        return fail<AssetReaderPtr>(asset_source_error_code::invalidated,
                                    "ZIP source has been invalidated", path,
                                    "ZIP read-only:<invalidated>");
    }
    if (m_impl->initialization_error)
        return {std::nullopt, *m_impl->initialization_error};
    const auto found = m_impl->entries.find(path.relative_path());
    if (found == m_impl->entries.end()) {
        return fail<AssetReaderPtr>(asset_source_error_code::not_found,
                                    "ZIP archive has no matching entry", path,
                                    m_impl->backing->description);
    }
    const auto entry = found->second;
    if (entry.encrypted || !entry.supported) {
        return fail<AssetReaderPtr>(asset_source_error_code::unsupported_storage,
                                    entry.encrypted
                                        ? "encrypted ZIP entries are not supported"
                                        : "ZIP entry uses an unsupported compression method",
                                    path, m_impl->backing->description);
    }
    if (entry.seekable) {
        auto reader = std::make_unique<StoredZipReader>(m_impl->backing, entry, path);
        if (!reader->valid()) {
            return fail<AssetReaderPtr>(asset_source_error_code::open_failed,
                                        "could not open path-backed ZIP entry reader", path,
                                        m_impl->backing->description);
        }
        return {std::move(reader), {}};
    }

    auto reader = std::make_unique<CompressedZipReader>(m_impl->backing, entry, path);
    if (!reader->valid()) {
        return fail<AssetReaderPtr>(asset_source_error_code::corrupt,
                                    "could not initialize independent ZIP decompression state",
                                    path, m_impl->backing->description);
    }
    return {std::move(reader), {}};
}

bool ZipAssetSource::exists(const AssetPath& path) const
{
    return m_impl && !m_impl->initialization_error &&
           m_impl->entries.contains(path.relative_path());
}

std::string ZipAssetSource::describe() const
{
    return m_impl && m_impl->backing ? m_impl->backing->description : "ZIP read-only:<invalidated>";
}

AssetResult<std::vector<ZipAssetSource::EntryInventory>> ZipAssetSource::inventory() const
{
    if (!m_impl || !m_impl->backing) {
        return fail<std::vector<EntryInventory>>(asset_source_error_code::invalidated,
                                                 "ZIP source has been invalidated", {},
                                                 "ZIP read-only:<invalidated>");
    }
    if (m_impl->initialization_error)
        return {std::nullopt, *m_impl->initialization_error};

    std::vector<EntryInventory> result;
    result.reserve(m_impl->entries.size());
    for (const auto& [path, entry] : m_impl->entries) {
        const auto logical_path = AssetPath(path);
        if (entry.encrypted || !entry.supported) {
            return fail<std::vector<EntryInventory>>(
                asset_source_error_code::unsupported_storage,
                entry.encrypted ? "encrypted ZIP entries are not supported"
                                : "ZIP entry uses an unsupported compression method",
                logical_path, m_impl->backing->description);
        }
        result.push_back(EntryInventory{
            .path = path,
            .metadata = AssetEntryMetadata{.uncompressed_size = entry.uncompressed_size,
                                           .compressed_size = entry.compressed_size,
                                           .seekable = entry.seekable},
            .crc32 = entry.crc32,
        });
    }
    std::sort(result.begin(), result.end(),
              [](const auto& left, const auto& right) { return left.path < right.path; });
    return {std::move(result), {}};
}

AssetResult<void> ZipAssetSource::validate_long_form_audio(std::span<const AssetPath> paths) const
{
    for (const auto& path : paths) {
        auto metadata = stat(path);
        if (!metadata)
            return {false, std::move(metadata.error)};
        if (!metadata.value->seekable) {
            return {false, make_error(asset_source_error_code::unsupported_storage,
                                      "long-form music or ambience entry is not directly seekable",
                                      path, describe())};
        }
    }
    return {true, {}};
}

} // namespace noveltea::assets
