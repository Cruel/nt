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
    if (value.empty()) return false;
    return std::all_of(value.begin(), value.end(), [](char ch) {
        return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
    });
}

template<class T>
AssetResult<T> fail(std::string message)
{
    return {std::nullopt, std::move(message)};
}

AssetBytes bytes_from(std::span<const std::byte> bytes)
{
    AssetBytes out;
    out.reserve(bytes.size());
    std::transform(bytes.begin(), bytes.end(), std::back_inserter(out), [](std::byte value) {
        return static_cast<std::uint8_t>(value);
    });
    return out;
}

class MemoryReader final : public AssetReader {
public:
    explicit MemoryReader(AssetBytes bytes) : m_bytes(std::move(bytes)) {}

    std::size_t read(void* buffer, std::size_t bytes) override
    {
        const std::size_t remaining = m_bytes.size() - m_pos;
        const std::size_t count = std::min(bytes, remaining);
        if (count > 0) {
            std::memcpy(buffer, m_bytes.data() + m_pos, count);
            m_pos += count;
        }
        return count;
    }

    bool seek(std::int64_t offset, int origin) override
    {
        std::int64_t base = 0;
        if (origin == SEEK_SET) {
            base = 0;
        } else if (origin == SEEK_CUR) {
            base = static_cast<std::int64_t>(m_pos);
        } else if (origin == SEEK_END) {
            base = static_cast<std::int64_t>(m_bytes.size());
        } else {
            return false;
        }

        const std::int64_t next = base + offset;
        if (next < 0 || static_cast<std::uint64_t>(next) > m_bytes.size()) {
            return false;
        }
        m_pos = static_cast<std::size_t>(next);
        return true;
    }

    std::optional<std::uint64_t> tell() const override { return m_pos; }
    std::optional<std::uint64_t> size() const override { return m_bytes.size(); }

private:
    AssetBytes m_bytes;
    std::size_t m_pos = 0;
};

class FileReader final : public AssetReader {
public:
    explicit FileReader(std::filesystem::path path)
        : m_stream(path, std::ios::binary)
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

    [[nodiscard]] bool valid() const { return m_stream.good(); }

    std::size_t read(void* buffer, std::size_t bytes) override
    {
        m_stream.read(static_cast<char*>(buffer), static_cast<std::streamsize>(bytes));
        return static_cast<std::size_t>(m_stream.gcount());
    }

    bool seek(std::int64_t offset, int origin) override
    {
        std::ios_base::seekdir dir = std::ios::beg;
        if (origin == SEEK_CUR) {
            dir = std::ios::cur;
        } else if (origin == SEEK_END) {
            dir = std::ios::end;
        } else if (origin != SEEK_SET) {
            return false;
        }
        m_stream.clear();
        m_stream.seekg(static_cast<std::streamoff>(offset), dir);
        return !m_stream.fail();
    }

    std::optional<std::uint64_t> tell() const override
    {
        auto& stream = const_cast<std::ifstream&>(m_stream);
        const auto pos = stream.tellg();
        if (pos < 0) return std::nullopt;
        return static_cast<std::uint64_t>(pos);
    }

    std::optional<std::uint64_t> size() const override { return m_size; }

private:
    mutable std::ifstream m_stream;
    std::optional<std::uint64_t> m_size;
};

class SdlReader final : public AssetReader {
public:
    explicit SdlReader(SDL_IOStream* stream)
        : m_stream(stream)
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

    std::size_t read(void* buffer, std::size_t bytes) override
    {
        return SDL_ReadIO(m_stream, buffer, bytes);
    }

    bool seek(std::int64_t offset, int origin) override
    {
        SDL_IOWhence whence = SDL_IO_SEEK_SET;
        if (origin == SEEK_CUR) {
            whence = SDL_IO_SEEK_CUR;
        } else if (origin == SEEK_END) {
            whence = SDL_IO_SEEK_END;
        } else if (origin != SEEK_SET) {
            return false;
        }
        return SDL_SeekIO(m_stream, offset, whence) >= 0;
    }

    std::optional<std::uint64_t> tell() const override
    {
        const Sint64 pos = SDL_TellIO(m_stream);
        if (pos < 0) return std::nullopt;
        return static_cast<std::uint64_t>(pos);
    }

    std::optional<std::uint64_t> size() const override { return m_size; }

private:
    SDL_IOStream* m_stream = nullptr;
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
    if (logical.empty()) return std::nullopt;
    if (logical.front() == '/' || logical.find('\\') != std::string_view::npos) return std::nullopt;

    AssetPath result;
    std::string_view rest = logical;
    const std::size_t scheme = logical.find(":/");
    if (scheme != std::string_view::npos) {
        const std::string_view ns = logical.substr(0, scheme);
        if (!valid_namespace(ns)) return std::nullopt;
        result.m_namespace = std::string(ns);
        rest = logical.substr(scheme + 2);
    } else if (logical.find(':') != std::string_view::npos) {
        return std::nullopt;
    }

    if (rest.empty() || rest.front() == '/' || rest.find("//") != std::string_view::npos) return std::nullopt;

    std::size_t start = 0;
    while (start <= rest.size()) {
        const std::size_t slash = rest.find('/', start);
        const std::string_view part = rest.substr(start, slash == std::string_view::npos ? slash : slash - start);
        if (part.empty() || part == "." || part == "..") return std::nullopt;
        if (part.find(':') != std::string_view::npos) return std::nullopt;
        if (slash == std::string_view::npos) break;
        start = slash + 1;
    }

    result.m_relative_path = std::string(rest);
    return result;
}

std::optional<AssetPath> AssetPath::parse_with_default_namespace(
    std::string_view logical,
    std::string_view default_namespace)
{
    auto parsed = parse(logical);
    if (!parsed) return std::nullopt;
    if (!parsed->has_namespace()) {
        if (!valid_namespace(default_namespace)) return std::nullopt;
        parsed->m_namespace = std::string(default_namespace);
    }
    return parsed;
}

std::string AssetPath::logical_path() const
{
    if (m_namespace.empty()) return m_relative_path;
    return m_namespace + ":/" + m_relative_path;
}

AssetResult<AssetBlob> AssetSource::read_binary(const AssetPath& path) const
{
    auto opened = open(path);
    if (!opened) {
        return fail<AssetBlob>(std::move(opened.error));
    }

    AssetReader& reader = *opened.value.value();
    AssetBlob blob;
    blob.logical_path = path;
    blob.source_description = describe();
    if (const auto size = reader.size()) {
        if (*size > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
            return fail<AssetBlob>("asset too large to read " + path.logical_path() + " from " + describe());
        }
        blob.bytes.resize(static_cast<std::size_t>(*size));
        if (!blob.bytes.empty()) {
            const std::size_t read_count = reader.read(blob.bytes.data(), blob.bytes.size());
            if (read_count != blob.bytes.size()) {
                return fail<AssetBlob>("short read for " + path.logical_path() + " from " + describe());
            }
        }
    } else {
        std::array<std::uint8_t, 8192> buffer {};
        for (;;) {
            const std::size_t read_count = reader.read(buffer.data(), buffer.size());
            blob.bytes.insert(blob.bytes.end(), buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(read_count));
            if (read_count < buffer.size()) {
                break;
            }
        }
    }
    return {std::move(blob), {}};
}

bool path_is_inside_root(const std::filesystem::path& root, const std::filesystem::path& child)
{
    const auto normalized_root = std::filesystem::weakly_canonical(root);
    const auto normalized_child = std::filesystem::weakly_canonical(child);
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
    : m_root(std::move(root))
    , m_writable(writable)
{
}

std::filesystem::path DirectoryAssetSource::resolve(const AssetPath& path) const
{
    return (m_root / std::filesystem::path(path.relative_path())).lexically_normal();
}

AssetResult<AssetReaderPtr> DirectoryAssetSource::open(const AssetPath& path) const
{
    const auto physical = resolve(path);
    if (!path_is_inside_root(m_root, physical)) {
        return fail<AssetReaderPtr>("directory source rejected path outside root " + path.logical_path());
    }
    auto reader = std::make_unique<FileReader>(physical);
    if (!reader->valid()) {
        return fail<AssetReaderPtr>("directory source could not open " + path.logical_path()
            + " as " + physical.string());
    }
    return {std::move(reader), {}};
}

AssetResult<AssetBlob> DirectoryAssetSource::read_binary(const AssetPath& path) const
{
    const auto physical = resolve(path);
    if (!path_is_inside_root(m_root, physical)) {
        return fail<AssetBlob>("directory source rejected path outside root " + path.logical_path());
    }
    std::ifstream in(physical, std::ios::binary);
    if (!in) {
        return fail<AssetBlob>("directory source could not open " + path.logical_path()
            + " as " + physical.string());
    }
    AssetBlob result;
    result.logical_path = path;
    result.source_description = describe();
    result.native_path = physical;
    result.bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    return {std::move(result), {}};
}

bool DirectoryAssetSource::exists(const AssetPath& path) const
{
    const auto physical = resolve(path);
    return path_is_inside_root(m_root, physical) && std::filesystem::is_regular_file(physical);
}

std::string DirectoryAssetSource::describe() const
{
    return std::string(writable() ? "directory writable:" : "directory read-only:") + m_root.string();
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

AssetResult<AssetReaderPtr> SdlPackagedAssetSource::open(const AssetPath& path) const
{
    const std::string mapped = map_path(path);
    SDL_IOStream* io = SDL_IOFromFile(mapped.c_str(), "rb");
    if (!io) {
        return fail<AssetReaderPtr>("SDL packaged source could not open " + path.logical_path()
            + " as " + mapped + ": " + SDL_GetError());
    }
    return {std::make_unique<SdlReader>(io), {}};
}

AssetResult<AssetBlob> SdlPackagedAssetSource::read_binary(const AssetPath& path) const
{
    const std::string mapped = map_path(path);
    SDL_IOStream* stream = SDL_IOFromFile(mapped.c_str(), "rb");
    if (!stream) {
        return fail<AssetBlob>("SDL packaged source could not open " + path.logical_path()
            + " as " + mapped + ": " + SDL_GetError());
    }
    size_t size = 0;
    void* data = SDL_LoadFile_IO(stream, &size, true);
    if (!data) {
        return fail<AssetBlob>("SDL packaged source could not load " + path.logical_path()
            + " as " + mapped + ": " + SDL_GetError());
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
    return "SDL packaged read-only:" + (m_internal_prefix.empty() ? std::string("<asset-root>") : m_internal_prefix);
}

void MemoryAssetSource::add(AssetPath path, AssetBytes bytes, std::string description)
{
    m_entries[path.relative_path()] = Entry{std::move(bytes), std::move(description)};
}

void MemoryAssetSource::add(std::string_view logical_path, AssetBytes bytes, std::string description)
{
    if (auto path = AssetPath::parse(logical_path)) {
        add(std::move(*path), std::move(bytes), std::move(description));
    }
}

AssetResult<AssetReaderPtr> MemoryAssetSource::open(const AssetPath& path) const
{
    auto it = m_entries.find(path.relative_path());
    if (it == m_entries.end()) {
        return fail<AssetReaderPtr>("memory source has no entry for " + path.logical_path());
    }
    return {std::make_unique<MemoryReader>(it->second.bytes), {}};
}

AssetResult<AssetBlob> MemoryAssetSource::read_binary(const AssetPath& path) const
{
    auto it = m_entries.find(path.relative_path());
    if (it == m_entries.end()) {
        return fail<AssetBlob>("memory source has no entry for " + path.logical_path());
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

AssetResult<AssetReaderPtr> ZipAssetSource::open(const AssetPath& path) const
{
    return fail<AssetReaderPtr>("ZipAssetSource decompression is not linked yet for " + path.logical_path());
}

bool ZipAssetSource::exists(const AssetPath&) const
{
    return false;
}

std::string ZipAssetSource::describe() const
{
    return "ZIP read-only:<deferred>";
}

void AssetManager::mount(std::string namespace_name, AssetSourcePtr source)
{
    if (!source || !valid_namespace(namespace_name)) return;
    m_mounts[std::move(namespace_name)].push_back(std::move(source));
}

void AssetManager::mount_directory(std::string namespace_name, std::filesystem::path root, bool writable)
{
    mount(std::move(namespace_name), std::make_shared<DirectoryAssetSource>(std::move(root), writable));
}

void AssetManager::mount_legacy_package(std::string namespace_name,
                                         const ::noveltea::core::legacy::ProjectPackage& package)
{
    auto source = std::make_shared<MemoryAssetSource>();
    source->add("project:/game",
        AssetBytes(package.game_json.begin(), package.game_json.end()),
        "legacy package game");
    if (!package.image.empty()) {
        source->add("project:/image",
            bytes_from(std::span<const std::byte>(package.image.data(), package.image.size())),
            "legacy package cover image");
    }
    for (const auto& [name, bytes] : package.fonts) {
        source->add("project:/fonts/" + name,
            bytes_from(std::span<const std::byte>(bytes.data(), bytes.size())),
            "legacy package font:" + name);
    }
    for (const auto& [name, bytes] : package.textures) {
        source->add("project:/textures/" + name,
            bytes_from(std::span<const std::byte>(bytes.data(), bytes.size())),
            "legacy package texture:" + name);
    }
    mount(std::move(namespace_name), std::move(source));
}

std::string AssetManager::namespace_for(const AssetPath& path) const
{
    return path.has_namespace() ? path.namespace_name() : std::string("project");
}

const std::vector<AssetSourcePtr>* AssetManager::sources_for(const AssetPath& path) const
{
    auto it = m_mounts.find(namespace_for(path));
    if (it == m_mounts.end()) return nullptr;
    return &it->second;
}

AssetResult<AssetReaderPtr> AssetManager::open(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path) {
        return fail<AssetReaderPtr>("invalid asset path: " + std::string(logical_path));
    }

    const auto ns = namespace_for(*path);
    const auto* sources = sources_for(*path);
    if (!sources || sources->empty()) {
        return fail<AssetReaderPtr>("no mount for asset namespace '" + ns + "' while opening " + path->logical_path());
    }

    std::ostringstream searched;
    for (const auto& source : *sources) {
        auto result = source->open(*path);
        if (result) {
            return result;
        }
        searched << "[" << source->kind() << " " << source->describe() << " -> " << result.error << "] ";
    }

    return fail<AssetReaderPtr>("asset not found while opening " + path->logical_path()
        + " namespace:" + ns + " searched:" + searched.str());
}

AssetResult<AssetBlob> AssetManager::read_binary(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path) {
        return fail<AssetBlob>("invalid asset path: " + std::string(logical_path));
    }

    const auto ns = namespace_for(*path);
    const auto* sources = sources_for(*path);
    if (!sources || sources->empty()) {
        return fail<AssetBlob>("no mount for asset namespace '" + ns + "' while reading " + path->logical_path());
    }

    std::ostringstream searched;
    for (const auto& source : *sources) {
        auto result = source->read_binary(*path);
        if (result) {
            return result;
        }
        searched << "[" << source->kind() << " " << source->describe() << " -> " << result.error << "] ";
    }

    return fail<AssetBlob>("asset not found while reading " + path->logical_path()
        + " namespace:" + ns + " searched:" + searched.str());
}

AssetResult<AssetText> AssetManager::read_text(std::string_view logical_path) const
{
    auto binary = read_binary(logical_path);
    if (!binary) {
        return fail<AssetText>(std::move(binary.error));
    }
    return {AssetText(binary.value->bytes.begin(), binary.value->bytes.end()), {}};
}

bool AssetManager::exists(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path) return false;
    const auto* sources = sources_for(*path);
    if (!sources) return false;
    return std::any_of(sources->begin(), sources->end(), [&](const auto& source) {
        return source->exists(*path);
    });
}

bool AssetManager::has_namespace(std::string_view namespace_name) const
{
    return valid_namespace(namespace_name) && m_mounts.find(std::string(namespace_name)) != m_mounts.end();
}

std::vector<std::string> AssetManager::describe_mounts() const
{
    std::vector<std::string> result;
    for (const auto& [ns, sources] : m_mounts) {
        for (const auto& source : sources) {
            result.push_back(ns + ":/ -> " + source->describe()
                + " kind:" + source->kind()
                + (source->writable() ? " writable" : " read-only"));
        }
    }
    return result;
}

} // namespace noveltea::assets
