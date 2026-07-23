#include "noveltea/assets/asset_manager.hpp"

#include <SDL3/SDL_error.h>
#include <SDL3/SDL_iostream.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <array>
#include <fstream>
#include <iterator>
#include <limits>
#include <span>
#include <sstream>
#include <utility>

namespace noveltea::assets {
namespace {

bool valid_namespace(std::string_view value)
{
    if (value.empty())
        return false;
    return std::all_of(value.begin(), value.end(), [](char ch) {
        return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
    });
}

AssetSourceError source_error(std::string_view code, std::string message, const AssetPath& path,
                              std::string source_description)
{
    return AssetSourceError{.code = std::string(code),
                            .message = std::move(message),
                            .logical_path = path,
                            .source_description = std::move(source_description)};
}

template<class T>
AssetResult<T> source_fail(std::string_view code, std::string message, const AssetPath& path,
                           std::string source_description)
{
    return {std::nullopt,
            source_error(code, std::move(message), path, std::move(source_description))};
}

template<class T> AssetLoadResult<T> load_fail(std::string message)
{
    return {std::nullopt, std::move(message)};
}

std::optional<std::uint64_t> seek_target(std::uint64_t current, std::uint64_t size,
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

class MemoryReader final : public AssetReader {
public:
    MemoryReader(AssetBytes bytes, AssetPath path, std::string source_description)
        : m_bytes(std::move(bytes)), m_path(std::move(path)),
          m_source_description(std::move(source_description))
    {
    }

    AssetResult<std::size_t> read(void* buffer, std::size_t bytes) noexcept override
    {
        if (bytes > 0 && !buffer) {
            return source_fail<std::size_t>(asset_source_error_code::read_failed,
                                            "memory reader received a null destination", m_path,
                                            m_source_description);
        }
        const std::size_t remaining = m_bytes.size() - m_pos;
        const std::size_t count = std::min(bytes, remaining);
        if (count > 0) {
            std::memcpy(buffer, m_bytes.data() + m_pos, count);
            m_pos += count;
        }
        return {count, {}};
    }

    AssetResult<void> seek(std::int64_t offset, AssetSeekOrigin origin) noexcept override
    {
        const auto next = seek_target(m_pos, m_bytes.size(), offset, origin);
        if (!next) {
            return {false, source_error(asset_source_error_code::seek_failed,
                                        "memory reader seek is outside the entry", m_path,
                                        m_source_description)};
        }
        m_pos = static_cast<std::size_t>(*next);
        return {true, {}};
    }

    AssetResult<std::uint64_t> tell() const noexcept override { return {m_pos, {}}; }
    AssetResult<std::uint64_t> size() const noexcept override { return {m_bytes.size(), {}}; }

private:
    AssetBytes m_bytes;
    AssetPath m_path;
    std::string m_source_description;
    std::size_t m_pos = 0;
};

class FileReader final : public AssetReader {
public:
    FileReader(std::filesystem::path path, AssetPath logical_path, std::string source_description)
        : m_stream(path, std::ios::binary), m_path(std::move(logical_path)),
          m_source_description(std::move(source_description))
    {
        if (m_stream) {
            m_stream.seekg(0, std::ios::end);
            const auto end = m_stream.tellg();
            if (end >= 0) {
                m_size = static_cast<std::uint64_t>(end);
            }
            m_stream.seekg(0, std::ios::beg);
        }
    }

    [[nodiscard]] bool valid() const { return m_stream.good() && m_size.has_value(); }

    AssetResult<std::size_t> read(void* buffer, std::size_t bytes) noexcept override
    {
        if (bytes > 0 && !buffer) {
            return source_fail<std::size_t>(asset_source_error_code::read_failed,
                                            "file reader received a null destination", m_path,
                                            m_source_description);
        }
        if (bytes > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max())) {
            return source_fail<std::size_t>(asset_source_error_code::read_failed,
                                            "file reader request exceeds stream limits", m_path,
                                            m_source_description);
        }
        m_stream.read(static_cast<char*>(buffer), static_cast<std::streamsize>(bytes));
        const auto count = static_cast<std::size_t>(m_stream.gcount());
        if (m_stream.bad()) {
            return source_fail<std::size_t>(asset_source_error_code::read_failed,
                                            "file reader failed while reading", m_path,
                                            m_source_description);
        }
        return {count, {}};
    }

    AssetResult<void> seek(std::int64_t offset, AssetSeekOrigin origin) noexcept override
    {
        const auto current = tell();
        if (!current)
            return {false, current.error};
        if (!m_size) {
            return {false, source_error(asset_source_error_code::seek_failed,
                                        "file reader cannot seek without a known size", m_path,
                                        m_source_description)};
        }
        const auto target = seek_target(*current.value, *m_size, offset, origin);
        if (!target)
            return {false, source_error(asset_source_error_code::seek_failed,
                                        "file reader seek is outside the entry", m_path,
                                        m_source_description)};
        m_stream.clear();
        m_stream.seekg(static_cast<std::streamoff>(*target), std::ios::beg);
        if (m_stream.fail())
            return {false, source_error(asset_source_error_code::seek_failed,
                                        "file reader seek failed", m_path, m_source_description)};
        return {true, {}};
    }

    AssetResult<std::uint64_t> tell() const noexcept override
    {
        auto& stream = const_cast<std::ifstream&>(m_stream);
        const auto pos = stream.tellg();
        if (pos < 0)
            return source_fail<std::uint64_t>(asset_source_error_code::read_failed,
                                              "file reader could not report its position", m_path,
                                              m_source_description);
        return {static_cast<std::uint64_t>(pos), {}};
    }

    AssetResult<std::uint64_t> size() const noexcept override
    {
        if (!m_size)
            return source_fail<std::uint64_t>(asset_source_error_code::read_failed,
                                              "file reader could not determine entry size", m_path,
                                              m_source_description);
        return {*m_size, {}};
    }

private:
    mutable std::ifstream m_stream;
    AssetPath m_path;
    std::string m_source_description;
    std::optional<std::uint64_t> m_size;
};

class SdlReader final : public AssetReader {
public:
    SdlReader(SDL_IOStream* stream, AssetPath path, std::string source_description)
        : m_stream(stream), m_path(std::move(path)),
          m_source_description(std::move(source_description))
    {
        const Sint64 current = SDL_TellIO(m_stream);
        const Sint64 end = SDL_SeekIO(m_stream, 0, SDL_IO_SEEK_END);
        if (end >= 0) {
            m_size = static_cast<std::uint64_t>(end);
        }
        SDL_SeekIO(m_stream, current >= 0 ? current : 0, SDL_IO_SEEK_SET);
    }

    ~SdlReader() override
    {
        if (m_stream) {
            SDL_CloseIO(m_stream);
        }
    }

    AssetResult<std::size_t> read(void* buffer, std::size_t bytes) noexcept override
    {
        if (bytes > 0 && !buffer)
            return source_fail<std::size_t>(asset_source_error_code::read_failed,
                                            "SDL reader received a null destination", m_path,
                                            m_source_description);
        const auto count = SDL_ReadIO(m_stream, buffer, bytes);
        if (count < bytes && SDL_GetIOStatus(m_stream) == SDL_IO_STATUS_ERROR)
            return source_fail<std::size_t>(asset_source_error_code::read_failed,
                                            "SDL reader failed: " + std::string(SDL_GetError()),
                                            m_path, m_source_description);
        return {count, {}};
    }

    AssetResult<void> seek(std::int64_t offset, AssetSeekOrigin origin) noexcept override
    {
        SDL_IOWhence whence = SDL_IO_SEEK_SET;
        if (origin == AssetSeekOrigin::Current) {
            whence = SDL_IO_SEEK_CUR;
        } else if (origin == AssetSeekOrigin::End) {
            whence = SDL_IO_SEEK_END;
        }
        if (SDL_SeekIO(m_stream, offset, whence) < 0)
            return {false, source_error(asset_source_error_code::seek_failed,
                                        "SDL reader seek failed: " + std::string(SDL_GetError()),
                                        m_path, m_source_description)};
        return {true, {}};
    }

    AssetResult<std::uint64_t> tell() const noexcept override
    {
        const Sint64 pos = SDL_TellIO(m_stream);
        if (pos < 0)
            return source_fail<std::uint64_t>(asset_source_error_code::read_failed,
                                              "SDL reader could not report its position: " +
                                                  std::string(SDL_GetError()),
                                              m_path, m_source_description);
        return {static_cast<std::uint64_t>(pos), {}};
    }

    AssetResult<std::uint64_t> size() const noexcept override
    {
        if (!m_size)
            return source_fail<std::uint64_t>(asset_source_error_code::read_failed,
                                              "SDL reader could not determine entry size", m_path,
                                              m_source_description);
        return {*m_size, {}};
    }

private:
    SDL_IOStream* m_stream = nullptr;
    AssetPath m_path;
    std::string m_source_description;
    std::optional<std::uint64_t> m_size;
};

} // namespace

AssetPath::AssetPath(std::string logical)
{
    if (auto parsed = parse(logical)) {
        *this = std::move(*parsed);
    }
}

std::optional<AssetPath> AssetPath::parse(std::string_view logical)
{
    if (logical.empty())
        return std::nullopt;
    if (logical.front() == '/' || logical.find('\\') != std::string_view::npos)
        return std::nullopt;

    AssetPath result;
    std::string_view rest = logical;
    const std::size_t scheme = logical.find(":/");
    if (scheme != std::string_view::npos) {
        const std::string_view ns = logical.substr(0, scheme);
        if (!valid_namespace(ns))
            return std::nullopt;
        result.m_namespace = std::string(ns);
        rest = logical.substr(scheme + 2);
    } else if (logical.find(':') != std::string_view::npos) {
        return std::nullopt;
    }

    if (rest.empty() || rest.front() == '/' || rest.find("//") != std::string_view::npos)
        return std::nullopt;

    std::size_t start = 0;
    while (start <= rest.size()) {
        const std::size_t slash = rest.find('/', start);
        const std::string_view part =
            rest.substr(start, slash == std::string_view::npos ? slash : slash - start);
        if (part.empty() || part == "." || part == "..")
            return std::nullopt;
        if (part.find(':') != std::string_view::npos)
            return std::nullopt;
        if (slash == std::string_view::npos)
            break;
        start = slash + 1;
    }

    result.m_relative_path = std::string(rest);
    return result;
}

std::optional<AssetPath> AssetPath::parse_with_default_namespace(std::string_view logical,
                                                                 std::string_view default_namespace)
{
    auto parsed = parse(logical);
    if (!parsed)
        return std::nullopt;
    if (!parsed->has_namespace()) {
        if (!valid_namespace(default_namespace))
            return std::nullopt;
        parsed->m_namespace = std::string(default_namespace);
    }
    return parsed;
}

std::string AssetPath::logical_path() const
{
    if (m_namespace.empty())
        return m_relative_path;
    return m_namespace + ":/" + m_relative_path;
}

AssetResult<AssetBlob> AssetSource::read_binary(const AssetPath& path) const
{
    auto opened = open(path);
    if (!opened)
        return {std::nullopt, std::move(opened.error)};

    AssetReader& reader = **opened.value;
    AssetBlob blob;
    blob.logical_path = path;
    blob.source_description = describe();

    const auto size = reader.size();
    if (!size)
        return {std::nullopt, size.error};
    if (*size.value > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        return source_fail<AssetBlob>(asset_source_error_code::unsupported_storage,
                                      "asset is too large to materialize in memory", path,
                                      describe());
    }

    blob.bytes.resize(static_cast<std::size_t>(*size.value));
    std::size_t total = 0;
    while (total < blob.bytes.size()) {
        auto read = reader.read(blob.bytes.data() + total, blob.bytes.size() - total);
        if (!read)
            return {std::nullopt, std::move(read.error)};
        if (*read.value == 0) {
            return source_fail<AssetBlob>(asset_source_error_code::read_failed,
                                          "short read before the advertised entry size", path,
                                          describe());
        }
        total += *read.value;
    }
    return {std::move(blob), {}};
}

bool path_is_inside_root(const std::filesystem::path& root, const std::filesystem::path& child)
{
    std::error_code root_error;
    const auto normalized_root = std::filesystem::weakly_canonical(root, root_error);
    if (root_error)
        return false;
    std::error_code child_error;
    const auto normalized_child = std::filesystem::weakly_canonical(child, child_error);
    if (child_error)
        return false;
    auto root_it = normalized_root.begin();
    auto child_it = normalized_child.begin();
    for (; root_it != normalized_root.end(); ++root_it, ++child_it) {
        if (child_it == normalized_child.end() || *root_it != *child_it) {
            return false;
        }
    }
    return true;
}

DirectoryAssetSource::DirectoryAssetSource(std::filesystem::path root, bool writable)
    : m_root(std::move(root)), m_writable(writable)
{
}

std::filesystem::path DirectoryAssetSource::resolve(const AssetPath& path) const
{
    return (m_root / std::filesystem::path(path.relative_path())).lexically_normal();
}

AssetResult<AssetEntryMetadata> DirectoryAssetSource::stat(const AssetPath& path) const
{
    const auto physical = resolve(path);
    if (!path_is_inside_root(m_root, physical)) {
        return source_fail<AssetEntryMetadata>(asset_source_error_code::unsafe_path,
                                               "directory source rejected a path outside its root",
                                               path, describe());
    }
    std::error_code error;
    if (!std::filesystem::is_regular_file(physical, error)) {
        const auto code =
            error ? asset_source_error_code::open_failed : asset_source_error_code::not_found;
        return source_fail<AssetEntryMetadata>(
            code,
            error ? "directory source could not inspect '" + physical.string() +
                        "': " + error.message()
                  : "directory source has no file at '" + physical.string() + "'",
            path, describe());
    }
    const auto size = std::filesystem::file_size(physical, error);
    if (error) {
        return source_fail<AssetEntryMetadata>(
            asset_source_error_code::open_failed,
            "directory source could not determine file size: " + error.message(), path, describe());
    }
    return {AssetEntryMetadata{
                .uncompressed_size = size, .compressed_size = std::nullopt, .seekable = true},
            {}};
}

AssetResult<AssetReaderPtr> DirectoryAssetSource::open(const AssetPath& path) const
{
    const auto physical = resolve(path);
    if (!path_is_inside_root(m_root, physical)) {
        return source_fail<AssetReaderPtr>(asset_source_error_code::unsafe_path,
                                           "directory source rejected a path outside its root",
                                           path, describe());
    }
    auto metadata = stat(path);
    if (!metadata)
        return {std::nullopt, std::move(metadata.error)};
    auto reader = std::make_unique<FileReader>(physical, path, describe());
    if (!reader->valid()) {
        return source_fail<AssetReaderPtr>(
            asset_source_error_code::open_failed,
            "directory source could not open '" + physical.string() + "'", path, describe());
    }
    return {std::move(reader), {}};
}

AssetResult<AssetBlob> DirectoryAssetSource::read_binary(const AssetPath& path) const
{
    const auto physical = resolve(path);
    if (!path_is_inside_root(m_root, physical)) {
        return source_fail<AssetBlob>(asset_source_error_code::unsafe_path,
                                      "directory source rejected a path outside its root", path,
                                      describe());
    }
    std::ifstream in(physical, std::ios::binary);
    if (!in) {
        std::error_code error;
        const bool exists = std::filesystem::is_regular_file(physical, error);
        return source_fail<AssetBlob>(!error && !exists ? asset_source_error_code::not_found
                                                        : asset_source_error_code::open_failed,
                                      "directory source could not open '" + physical.string() + "'",
                                      path, describe());
    }
    AssetBlob result;
    result.logical_path = path;
    result.source_description = describe();
    result.native_path = physical;
    result.bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    if (in.bad()) {
        return source_fail<AssetBlob>(
            asset_source_error_code::read_failed,
            "directory source failed while reading '" + physical.string() + "'", path, describe());
    }
    return {std::move(result), {}};
}

bool DirectoryAssetSource::exists(const AssetPath& path) const
{
    const auto physical = resolve(path);
    std::error_code error;
    return path_is_inside_root(m_root, physical) &&
           std::filesystem::is_regular_file(physical, error) && !error;
}

std::string DirectoryAssetSource::describe() const
{
    return std::string(writable() ? "directory writable:" : "directory read-only:") +
           m_root.string();
}

SdlPackagedAssetSource::SdlPackagedAssetSource(std::string internal_prefix)
    : m_internal_prefix(std::move(internal_prefix))
{
    while (!m_internal_prefix.empty() && m_internal_prefix.back() == '/') {
        m_internal_prefix.pop_back();
    }
}

std::string SdlPackagedAssetSource::map_path(const AssetPath& path) const
{
    if (m_internal_prefix.empty()) {
        return path.relative_path();
    }
    return m_internal_prefix + "/" + path.relative_path();
}

AssetResult<AssetEntryMetadata> SdlPackagedAssetSource::stat(const AssetPath& path) const
{
    auto opened = open(path);
    if (!opened)
        return {std::nullopt, std::move(opened.error)};
    auto size = (*opened.value)->size();
    if (!size)
        return {std::nullopt, std::move(size.error)};
    return {AssetEntryMetadata{.uncompressed_size = *size.value,
                               .compressed_size = std::nullopt,
                               .seekable = true},
            {}};
}

AssetResult<AssetReaderPtr> SdlPackagedAssetSource::open(const AssetPath& path) const
{
    const std::string mapped = map_path(path);
    SDL_IOStream* io = SDL_IOFromFile(mapped.c_str(), "rb");
    if (!io) {
        return source_fail<AssetReaderPtr>(asset_source_error_code::not_found,
                                           "SDL packaged source could not open '" + mapped +
                                               "': " + SDL_GetError(),
                                           path, describe());
    }
    return {std::make_unique<SdlReader>(io, path, describe()), {}};
}

AssetResult<AssetBlob> SdlPackagedAssetSource::read_binary(const AssetPath& path) const
{
    const std::string mapped = map_path(path);
    SDL_IOStream* stream = SDL_IOFromFile(mapped.c_str(), "rb");
    if (!stream) {
        return source_fail<AssetBlob>(asset_source_error_code::not_found,
                                      "SDL packaged source could not open '" + mapped +
                                          "': " + SDL_GetError(),
                                      path, describe());
    }
    size_t size = 0;
    void* data = SDL_LoadFile_IO(stream, &size, true);
    if (!data) {
        return source_fail<AssetBlob>(asset_source_error_code::read_failed,
                                      "SDL packaged source could not load '" + mapped +
                                          "': " + SDL_GetError(),
                                      path, describe());
    }

    AssetBlob blob;
    blob.logical_path = path;
    blob.source_description = describe() + " mapped:" + mapped;
    blob.bytes.resize(size);
    if (size > 0) {
        std::memcpy(blob.bytes.data(), data, size);
    }
    SDL_free(data);
    return {std::move(blob), {}};
}

bool SdlPackagedAssetSource::exists(const AssetPath& path) const
{
    auto opened = open(path);
    return opened.value.has_value();
}

std::string SdlPackagedAssetSource::describe() const
{
    return "SDL packaged read-only:" +
           (m_internal_prefix.empty() ? std::string("<asset-root>") : m_internal_prefix);
}

void MemoryAssetSource::add(AssetPath path, AssetBytes bytes, std::string description)
{
    m_entries[path.relative_path()] = Entry{std::move(bytes), std::move(description)};
}

void MemoryAssetSource::add(std::string_view logical_path, AssetBytes bytes,
                            std::string description)
{
    if (auto path = AssetPath::parse(logical_path)) {
        add(std::move(*path), std::move(bytes), std::move(description));
    }
}

AssetResult<AssetEntryMetadata> MemoryAssetSource::stat(const AssetPath& path) const
{
    const auto it = m_entries.find(path.relative_path());
    if (it == m_entries.end()) {
        return source_fail<AssetEntryMetadata>(asset_source_error_code::not_found,
                                               "memory source has no matching entry", path,
                                               describe());
    }
    return {AssetEntryMetadata{.uncompressed_size = it->second.bytes.size(),
                               .compressed_size = std::nullopt,
                               .seekable = true},
            {}};
}

AssetResult<AssetReaderPtr> MemoryAssetSource::open(const AssetPath& path) const
{
    auto it = m_entries.find(path.relative_path());
    if (it == m_entries.end()) {
        return source_fail<AssetReaderPtr>(asset_source_error_code::not_found,
                                           "memory source has no matching entry", path, describe());
    }
    const auto description = it->second.description.empty() ? describe() : it->second.description;
    return {std::make_unique<MemoryReader>(it->second.bytes, path, description), {}};
}

AssetResult<AssetBlob> MemoryAssetSource::read_binary(const AssetPath& path) const
{
    auto it = m_entries.find(path.relative_path());
    if (it == m_entries.end()) {
        return source_fail<AssetBlob>(asset_source_error_code::not_found,
                                      "memory source has no matching entry", path, describe());
    }
    AssetBlob blob;
    blob.bytes = it->second.bytes;
    blob.logical_path = path;
    blob.source_description = it->second.description.empty() ? describe() : it->second.description;
    return {std::move(blob), {}};
}

bool MemoryAssetSource::exists(const AssetPath& path) const
{
    return m_entries.find(path.relative_path()) != m_entries.end();
}

std::string MemoryAssetSource::describe() const
{
    return "memory read-only:" + std::to_string(m_entries.size()) + " entries";
}

void AssetManager::mount(std::string namespace_name, AssetSourcePtr source)
{
    if (!source || !valid_namespace(namespace_name))
        return;
    m_mounts[std::move(namespace_name)].push_back(std::move(source));
}

void AssetManager::clear_namespace(std::string_view namespace_name)
{
    m_mounts.erase(std::string(namespace_name));
}

AssetManager::NamespaceMounts AssetManager::replace_namespace(std::string namespace_name,
                                                              NamespaceMounts sources)
{
    NamespaceMounts previous;
    if (!valid_namespace(namespace_name))
        return previous;

    auto found = m_mounts.find(namespace_name);
    if (found != m_mounts.end()) {
        previous = std::move(found->second);
        if (sources.empty()) {
            m_mounts.erase(found);
            return previous;
        }
        found->second = std::move(sources);
        return previous;
    }

    if (!sources.empty())
        m_mounts.emplace(std::move(namespace_name), std::move(sources));
    return previous;
}

void AssetManager::mount_directory(std::string namespace_name, std::filesystem::path root,
                                   bool writable)
{
    mount(std::move(namespace_name),
          std::make_shared<DirectoryAssetSource>(std::move(root), writable));
}

std::string AssetManager::namespace_for(const AssetPath& path) const
{
    return path.has_namespace() ? path.namespace_name() : std::string("project");
}

const std::vector<AssetSourcePtr>* AssetManager::sources_for(const AssetPath& path) const
{
    auto it = m_mounts.find(namespace_for(path));
    if (it == m_mounts.end())
        return nullptr;
    return &it->second;
}

AssetResult<AssetReaderPtr> AssetManager::open(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path) {
        return source_fail<AssetReaderPtr>(asset_source_error_code::unsafe_path,
                                           "invalid asset path '" + std::string(logical_path) + "'",
                                           {}, "AssetManager");
    }

    const auto ns = namespace_for(*path);
    const auto* sources = sources_for(*path);
    if (!sources || sources->empty()) {
        return source_fail<AssetReaderPtr>(asset_source_error_code::not_found,
                                           "no mount for asset namespace '" + ns + "'", *path,
                                           "AssetManager");
    }

    std::ostringstream searched;
    for (const auto& source : *sources) {
        auto result = source->open(*path);
        if (result) {
            return result;
        }
        if (result.error.code != asset_source_error_code::not_found)
            return result;
        searched << "[" << source->kind() << " " << source->describe() << " -> "
                 << result.error.code << ": " << result.error.message << "] ";
    }

    return source_fail<AssetReaderPtr>(asset_source_error_code::not_found,
                                       "asset was not found in namespace '" + ns +
                                           "'; searched: " + searched.str(),
                                       *path, "AssetManager");
}

AssetResult<AssetBlob> AssetManager::read_binary(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path) {
        return source_fail<AssetBlob>(asset_source_error_code::unsafe_path,
                                      "invalid asset path '" + std::string(logical_path) + "'", {},
                                      "AssetManager");
    }

    const auto ns = namespace_for(*path);
    const auto* sources = sources_for(*path);
    if (!sources || sources->empty()) {
        return source_fail<AssetBlob>(asset_source_error_code::not_found,
                                      "no mount for asset namespace '" + ns + "'", *path,
                                      "AssetManager");
    }

    std::ostringstream searched;
    for (const auto& source : *sources) {
        auto result = source->read_binary(*path);
        if (result) {
            return result;
        }
        if (result.error.code != asset_source_error_code::not_found)
            return result;
        searched << "[" << source->kind() << " " << source->describe() << " -> "
                 << result.error.code << ": " << result.error.message << "] ";
    }

    return source_fail<AssetBlob>(asset_source_error_code::not_found,
                                  "asset was not found in namespace '" + ns +
                                      "'; searched: " + searched.str(),
                                  *path, "AssetManager");
}

AssetResult<AssetText> AssetManager::read_text(std::string_view logical_path) const
{
    auto binary = read_binary(logical_path);
    if (!binary)
        return {std::nullopt, std::move(binary.error)};
    return {AssetText(binary.value->bytes.begin(), binary.value->bytes.end()), {}};
}

core::Result<std::string, runtime::ScriptSourceError>
AssetManager::read_script_source(std::string_view logical_path) const
{
    auto text = read_text(logical_path);
    if (!text)
        return core::Result<std::string, runtime::ScriptSourceError>::failure(
            runtime::ScriptSourceError{std::move(text.error.message)});
    return core::Result<std::string, runtime::ScriptSourceError>::success(std::move(*text.value));
}

void AssetManager::set_default_font_alias(std::string alias)
{
    m_font_config.default_alias = alias.empty() ? std::string(kSystemFontAlias) : std::move(alias);
}

void AssetManager::configure_fonts(FontAssetConfig config)
{
    if (config.default_alias.empty()) {
        config.default_alias = std::string(kSystemFontAlias);
    }
    m_font_config = std::move(config);
}

const FontAssetConfig& AssetManager::font_config() const noexcept { return m_font_config; }

const std::string& AssetManager::default_font_alias() const noexcept
{
    return m_font_config.default_alias;
}

void AssetManager::configure_resource_aliases(ResourceAliasRegistry aliases)
{
    m_resource_aliases = std::move(aliases);
}

AssetLoadResult<ResourceAliasRegistry>
AssetManager::load_resource_aliases(std::string_view logical_path)
{
    auto text = read_text(logical_path);
    if (!text) {
        return load_fail<ResourceAliasRegistry>("failed to read resource alias manifest '" +
                                                std::string(logical_path) +
                                                "': " + text.error.message);
    }
    auto parsed = parse_resource_alias_registry(*text.value);
    if (!parsed) {
        return parsed;
    }
    configure_resource_aliases(*parsed.value);
    return parsed;
}

const ResourceAliasRegistry& AssetManager::resource_aliases() const noexcept
{
    return m_resource_aliases;
}

void AssetManager::bind_font_loader(FontAssetLoader* loader) const { m_font_loader = loader; }
void AssetManager::bind_texture_loader(TextureAssetLoader* loader) const
{
    m_texture_loader = loader;
}
void AssetManager::bind_shader_program_loader(ShaderProgramAssetLoader* loader) const
{
    m_shader_program_loader = loader;
}
void AssetManager::bind_material_loader(MaterialAssetLoader* loader) const
{
    m_material_loader = loader;
}
void AssetManager::bind_audio_loader(AudioAssetLoader* loader) const { m_audio_loader = loader; }

AssetLoadResult<FontAsset> AssetManager::load_font(const FontAssetRequest& request) const
{
    if (!m_font_loader) {
        return load_fail<FontAsset>("no typed font loader bound to AssetManager");
    }
    auto resolved_request = request;
    if (resolved_request.alias.empty()) {
        resolved_request.alias = m_font_config.default_alias;
    }
    return m_font_loader->load_font(resolved_request);
}

AssetLoadResult<TextureAsset> AssetManager::load_texture(const TextureAssetRequest& request) const
{
    if (!m_texture_loader) {
        return load_fail<TextureAsset>("no typed texture loader bound to AssetManager");
    }
    return m_texture_loader->load_texture(request);
}

AssetLoadResult<TextureAsset> AssetManager::load_texture_alias(std::string_view alias) const
{
    const auto request = m_resource_aliases.texture_request(alias);
    if (!request) {
        return load_fail<TextureAsset>("unknown texture resource alias: " + std::string(alias));
    }
    return load_texture(*request);
}

AssetLoadResult<ShaderProgramAsset>
AssetManager::load_shader_program(const ShaderProgramAssetRequest& request) const
{
    if (!m_shader_program_loader) {
        return load_fail<ShaderProgramAsset>(
            "no typed shader program loader bound to AssetManager");
    }
    return m_shader_program_loader->load_shader_program(request);
}

AssetLoadResult<MaterialAsset>
AssetManager::load_material(const MaterialAssetRequest& request) const
{
    if (!m_material_loader) {
        return load_fail<MaterialAsset>("no typed material loader bound to AssetManager");
    }
    return m_material_loader->load_material(request);
}

AssetLoadResult<MaterialAsset> AssetManager::load_material_alias(std::string_view alias) const
{
    const auto request = m_resource_aliases.material_request(alias);
    if (!request) {
        return load_fail<MaterialAsset>("unknown material resource alias: " + std::string(alias));
    }
    return load_material(*request);
}

AssetLoadResult<AudioAsset> AssetManager::load_audio(const AudioAssetRequest& request) const
{
    if (!m_audio_loader) {
        return load_fail<AudioAsset>("no typed audio loader bound to AssetManager");
    }
    return m_audio_loader->load_audio(request);
}

AssetLoadResult<AudioAsset> AssetManager::load_audio_alias(std::string_view alias) const
{
    const auto request = resolve_audio_alias(alias);
    if (!request) {
        return load_fail<AudioAsset>("unknown audio resource alias: " + std::string(alias));
    }
    return load_audio(*request);
}

std::optional<AudioAssetRequest> AssetManager::resolve_audio_alias(std::string_view alias) const
{
    return m_resource_aliases.audio_request(alias);
}

bool AssetManager::exists(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path)
        return false;
    const auto* sources = sources_for(*path);
    if (!sources)
        return false;
    return std::any_of(sources->begin(), sources->end(),
                       [&](const auto& source) { return source->exists(*path); });
}

bool AssetManager::has_namespace(std::string_view namespace_name) const
{
    return valid_namespace(namespace_name) &&
           m_mounts.find(std::string(namespace_name)) != m_mounts.end();
}

std::vector<std::string> AssetManager::describe_mounts() const
{
    std::vector<std::string> result;
    for (const auto& [ns, sources] : m_mounts) {
        for (const auto& source : sources) {
            result.push_back(ns + ":/ -> " + source->describe() + " kind:" + source->kind() +
                             (source->writable() ? " writable" : " read-only"));
        }
    }
    return result;
}

} // namespace noveltea::assets
