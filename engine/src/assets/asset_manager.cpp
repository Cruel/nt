#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_progress.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"

#include <SDL3/SDL_error.h>
#include <SDL3/SDL_iostream.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <array>
#include <fstream>
#include <iterator>
#include <limits>
#include <map>
#include <span>
#include <sstream>
#include <utility>

namespace noveltea::assets {
namespace {

std::string filesystem_path_to_utf8(const std::filesystem::path& path)
{
    const auto encoded = path.generic_u8string();
    return std::string(reinterpret_cast<const char*>(encoded.data()), encoded.size());
}

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

FontAssetRequest canonical_font_source_request(const FontAssetRequest& request,
                                               const FontAssetConfig& config)
{
    auto resolved = request;
    if (resolved.alias.empty())
        resolved.alias = config.default_alias;
    if (resolved.alias == kSystemFontDisplayName || resolved.alias == "runtime-ui")
        resolved.alias = std::string(kSystemFontAlias);
    return resolved;
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
        : m_stream(path, std::ios::binary), m_native_path(std::move(path)),
          m_path(std::move(logical_path)), m_source_description(std::move(source_description))
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

    [[nodiscard]] std::optional<std::filesystem::path> native_path() const override
    {
        return m_native_path;
    }

private:
    mutable std::ifstream m_stream;
    std::filesystem::path m_native_path;
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

std::unique_ptr<AssetPreparationTask<AudioAsset>>
AudioAssetLoader::create_audio_preparation_task(const AudioAssetRequest&)
{
    return {};
}

struct AssetManager::AsyncState {
    AsyncState(jobs::JobExecutor& executor, std::shared_ptr<ResidencyManager> residency,
               core::AssetTelemetrySink* telemetry)
        : residency(std::move(residency)), telemetry(telemetry),
          fonts(executor, this->residency, telemetry, [this] { progress_wakeup_requested = true; }),
          textures(executor, this->residency, telemetry,
                   [this] { progress_wakeup_requested = true; }),
          hotspot_masks(executor, this->residency, telemetry,
                        [this] { progress_wakeup_requested = true; }),
          shaders(executor, this->residency, telemetry,
                  [this] { progress_wakeup_requested = true; }),
          materials(executor, this->residency, telemetry,
                    [this] { progress_wakeup_requested = true; }),
          audio(executor, this->residency, telemetry, [this] { progress_wakeup_requested = true; })
    {
    }

    void invalidate_generation_on_owner(AssetSourceGeneration generation) noexcept
    {
        fonts.invalidate_generation_on_owner(generation);
        textures.invalidate_generation_on_owner(generation);
        hotspot_masks.invalidate_generation_on_owner(generation);
        shaders.invalidate_generation_on_owner(generation);
        materials.invalidate_generation_on_owner(generation);
        audio.invalidate_generation_on_owner(generation);
    }

    std::size_t retry_deferred_on_owner() noexcept
    {
        return fonts.retry_deferred_on_owner() + textures.retry_deferred_on_owner() +
               hotspot_masks.retry_deferred_on_owner() + shaders.retry_deferred_on_owner() +
               materials.retry_deferred_on_owner() + audio.retry_deferred_on_owner();
    }

    [[nodiscard]] AssetRequestProgress progress_on_owner() const noexcept
    {
        AssetRequestProgress result;
        const auto merge = [&](const AssetRequestProgress& current) {
            result.blocking = result.blocking || current.blocking;
            result.background = result.background || current.background;
            result.deferred_mandatory = result.deferred_mandatory || current.deferred_mandatory;
        };
        merge(fonts.progress_on_owner());
        merge(textures.progress_on_owner());
        merge(hotspot_masks.progress_on_owner());
        merge(shaders.progress_on_owner());
        merge(materials.progress_on_owner());
        merge(audio.progress_on_owner());
        return result;
    }

    std::size_t retry_deferred_mandatory_on_owner() noexcept
    {
        return fonts.retry_deferred_mandatory_on_owner() +
               textures.retry_deferred_mandatory_on_owner() +
               hotspot_masks.retry_deferred_mandatory_on_owner() +
               shaders.retry_deferred_mandatory_on_owner() +
               materials.retry_deferred_mandatory_on_owner() +
               audio.retry_deferred_mandatory_on_owner();
    }

    [[nodiscard]] bool consume_progress_wakeup_on_owner() noexcept
    {
        const bool requested = progress_wakeup_requested;
        progress_wakeup_requested = false;
        return requested;
    }

    std::shared_ptr<ResidencyManager> residency;
    core::AssetTelemetrySink* telemetry = nullptr;
    bool progress_wakeup_requested = false;
    AssetRequestOrchestrator<FontAsset> fonts;
    AssetRequestOrchestrator<TextureAsset> textures;
    AssetRequestOrchestrator<HotspotMaskAsset> hotspot_masks;
    AssetRequestOrchestrator<ShaderProgramAsset> shaders;
    AssetRequestOrchestrator<MaterialAsset> materials;
    AssetRequestOrchestrator<AudioAsset> audio;
};

struct AssetManager::LeaseState {
    std::optional<StructuredAssetLeaseSet> candidate;
    std::optional<StructuredAssetLeaseSet> published;
    std::optional<StructuredAssetLeaseSet> previous_published;
    std::optional<StructuredAssetLeaseSet> supplemental;
    std::optional<StructuredAssetLeaseSet> focused_candidate;
    std::optional<StructuredAssetLeaseSet> focused_published;
};

AssetManager::AssetManager() : m_leases(std::make_unique<LeaseState>())
{
    const auto generation = allocate_asset_source_generation();
    if (generation)
        m_source_generation = *generation;
}

AssetManager::~AssetManager() = default;
AssetManager::AssetManager(AssetManager&&) noexcept = default;
AssetManager& AssetManager::operator=(AssetManager&&) noexcept = default;

AssetProgressOrchestrator::AssetProgressOrchestrator(AssetManager& assets) noexcept
    : m_assets(assets)
{
}

AssetProgressUrgency AssetProgressOrchestrator::urgency_on_owner() const noexcept
{
    if (m_assets.m_async == nullptr)
        return AssetProgressUrgency::Idle;
    const auto progress = m_assets.m_async->progress_on_owner();
    if (progress.blocking)
        return AssetProgressUrgency::Blocking;
    if (progress.background)
        return AssetProgressUrgency::Background;
    return AssetProgressUrgency::Idle;
}

void AssetProgressOrchestrator::service_owner_frame() noexcept
{
    if (m_assets.m_async == nullptr)
        return;
    if (m_assets.m_async->consume_progress_wakeup_on_owner()) {
        (void)m_assets.m_async->retry_deferred_mandatory_on_owner();
        return;
    }
    if (!m_assets.m_async->progress_on_owner().deferred_mandatory)
        return;
    (void)m_assets.m_async->retry_deferred_mandatory_on_owner();
}

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
            error ? "directory source could not inspect '" + filesystem_path_to_utf8(physical) +
                        "': " + error.message()
                  : "directory source has no file at '" + filesystem_path_to_utf8(physical) + "'",
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
        return source_fail<AssetReaderPtr>(asset_source_error_code::open_failed,
                                           "directory source could not open '" +
                                               filesystem_path_to_utf8(physical) + "'",
                                           path, describe());
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
                                      "directory source could not open '" +
                                          filesystem_path_to_utf8(physical) + "'",
                                      path, describe());
    }
    AssetBlob result;
    result.logical_path = path;
    result.source_description = describe();
    result.native_path = physical;
    result.bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    if (in.bad()) {
        return source_fail<AssetBlob>(asset_source_error_code::read_failed,
                                      "directory source failed while reading '" +
                                          filesystem_path_to_utf8(physical) + "'",
                                      path, describe());
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
           filesystem_path_to_utf8(m_root);
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
    bump_source_generation_on_owner();
}

void AssetManager::clear_namespace(std::string_view namespace_name)
{
    if (m_mounts.erase(std::string(namespace_name)) != 0)
        bump_source_generation_on_owner();
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
            bump_source_generation_on_owner();
            return previous;
        }
        found->second = std::move(sources);
        bump_source_generation_on_owner();
        return previous;
    }

    if (!sources.empty()) {
        m_mounts.emplace(std::move(namespace_name), std::move(sources));
        bump_source_generation_on_owner();
    }
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

AssetResult<AssetReaderFactory> AssetManager::reader_factory(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path) {
        return source_fail<AssetReaderFactory>(
            asset_source_error_code::unsafe_path,
            "invalid asset path '" + std::string(logical_path) + "'", {}, "AssetManager");
    }

    const auto ns = namespace_for(*path);
    const auto* sources = sources_for(*path);
    if (!sources || sources->empty()) {
        return source_fail<AssetReaderFactory>(asset_source_error_code::not_found,
                                               "no mount for asset namespace '" + ns + "'", *path,
                                               "AssetManager");
    }

    std::ostringstream searched;
    for (const auto& source : *sources) {
        auto metadata = source->stat(*path);
        if (metadata)
            return {AssetReaderFactory(source, *path), {}};
        if (metadata.error.code != asset_source_error_code::not_found)
            return {std::nullopt, std::move(metadata.error)};
        searched << "[" << source->kind() << " " << source->describe() << " -> "
                 << metadata.error.code << ": " << metadata.error.message << "] ";
    }

    return source_fail<AssetReaderFactory>(asset_source_error_code::not_found,
                                           "asset was not found in namespace '" + ns +
                                               "'; searched: " + searched.str(),
                                           *path, "AssetManager");
}

AssetResult<AssetEntryMetadata> AssetManager::stat(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path) {
        return source_fail<AssetEntryMetadata>(
            asset_source_error_code::unsafe_path,
            "invalid asset path '" + std::string(logical_path) + "'", {}, "AssetManager");
    }

    const auto ns = namespace_for(*path);
    const auto* sources = sources_for(*path);
    if (!sources || sources->empty()) {
        return source_fail<AssetEntryMetadata>(asset_source_error_code::not_found,
                                               "no mount for asset namespace '" + ns + "'", *path,
                                               "AssetManager");
    }

    std::ostringstream searched;
    for (const auto& source : *sources) {
        auto result = source->stat(*path);
        if (result)
            return result;
        if (result.error.code != asset_source_error_code::not_found)
            return result;
        searched << "[" << source->kind() << " " << source->describe() << " -> "
                 << result.error.code << ": " << result.error.message << "] ";
    }

    return source_fail<AssetEntryMetadata>(asset_source_error_code::not_found,
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
    bump_source_generation_on_owner();
}

void AssetManager::configure_fonts(FontAssetConfig config)
{
    if (config.default_alias.empty()) {
        config.default_alias = std::string(kSystemFontAlias);
    }
    m_font_config = std::move(config);
    bump_source_generation_on_owner();
}

const FontAssetConfig& AssetManager::font_config() const noexcept { return m_font_config; }

const std::string& AssetManager::default_font_alias() const noexcept
{
    return m_font_config.default_alias;
}

void AssetManager::configure_resource_aliases(ResourceAliasRegistry aliases)
{
    m_resource_aliases = std::move(aliases);
    bump_source_generation_on_owner();
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

void AssetManager::bind_font_loader(FontAssetLoader* loader) const
{
    if (m_font_loader == loader)
        return;
    m_font_loader = loader;
    bump_source_generation_on_owner();
}
void AssetManager::bind_texture_loader(TextureAssetLoader* loader) const
{
    if (m_texture_loader == loader)
        return;
    m_texture_loader = loader;
    bump_source_generation_on_owner();
}

void AssetManager::bind_hotspot_mask_loader(HotspotMaskAssetLoader* loader) const
{
    m_hotspot_mask_loader = loader;
    bump_source_generation_on_owner();
}
void AssetManager::bind_shader_program_loader(ShaderProgramAssetLoader* loader) const
{
    if (m_shader_program_loader == loader)
        return;
    m_shader_program_loader = loader;
    bump_source_generation_on_owner();
}
void AssetManager::bind_material_loader(MaterialAssetLoader* loader) const
{
    if (m_material_loader == loader)
        return;
    m_material_loader = loader;
    bump_source_generation_on_owner();
}
void AssetManager::bind_audio_loader(AudioAssetLoader* loader) const
{
    if (m_audio_loader == loader)
        return;
    m_audio_loader = loader;
    bump_source_generation_on_owner();
}

std::optional<AudioAssetRequest> AssetManager::resolve_audio_alias(std::string_view alias) const
{
    return m_resource_aliases.audio_request(alias);
}

core::DiagnosticResult<void>
AssetManager::configure_async_requests(jobs::JobExecutor& executor,
                                       std::shared_ptr<ResidencyManager> residency,
                                       core::AssetTelemetrySink* telemetry) noexcept
{
    if (residency == nullptr) {
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.async_residency_required",
             .message = "async asset requests require a residency manager"});
    }
    if (!m_source_generation.valid()) {
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.source_generation_exhausted",
             .message = "asset source generation could not be allocated"});
    }
    if (m_async != nullptr) {
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.async_already_configured",
             .message = "async asset requests are already configured"});
    }
    m_async = std::make_shared<AsyncState>(executor, std::move(residency), telemetry);
    return core::DiagnosticResult<void>::success();
}

AssetSourceGeneration AssetManager::source_generation_on_owner() const noexcept
{
    return m_source_generation;
}

core::DiagnosticResult<void> AssetManager::install_texture_preparation_requirements_on_owner(
    AssetSourceGeneration generation, TexturePreparationRequirementMap requirements) noexcept
{
    if (generation != m_source_generation) {
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.texture_requirements_wrong_generation",
             .message = "texture preparation requirements target a stale source generation"});
    }
    for (const auto& [key, requirement] : requirements) {
        (void)requirement;
        if (!key.valid() || key.source_generation != generation) {
            return core::DiagnosticResult<void>::failure(
                {.code = "assets.texture_requirements_invalid_key",
                 .message = "texture preparation requirements contain an invalid cache key"});
        }
        if (m_texture_preparation_requirements.contains(key)) {
            return core::DiagnosticResult<void>::failure(
                {.code = "assets.texture_requirements_duplicate_key",
                 .message = "texture preparation requirements contain an already-installed key"});
        }
        if (m_async != nullptr && m_async->textures.contains_key_on_owner(key)) {
            return core::DiagnosticResult<void>::failure(
                {.code = "assets.texture_requirements_late_install",
                 .message =
                     "texture preparation requirements were installed after request creation"});
        }
    }
    m_texture_preparation_requirements.insert(std::make_move_iterator(requirements.begin()),
                                              std::make_move_iterator(requirements.end()));
    return core::DiagnosticResult<void>::success();
}

core::Result<PrefetchGenerationId, core::Diagnostic>
AssetManager::create_prefetch_generation_on_owner() const noexcept
{
    const auto generation = allocate_prefetch_generation();
    if (!generation) {
        return core::Result<PrefetchGenerationId, core::Diagnostic>::failure(
            {.code = "assets.prefetch_generation_exhausted",
             .message = "process prefetch generation ID space is exhausted"});
    }
    return core::Result<PrefetchGenerationId, core::Diagnostic>::success(*generation);
}

std::size_t AssetManager::retry_deferred_asset_requests_on_owner() noexcept
{
    return m_async == nullptr ? 0 : m_async->retry_deferred_on_owner();
}

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
std::vector<core::AssetProfilerEntry> AssetManager::asset_profiler_inventory_on_owner() const
{
    if (m_async == nullptr)
        return {};

    using Type = core::AssetProfilerAssetType;
    using Key = std::pair<Type, AssetCacheKey>;
    std::map<Key, core::AssetProfilerEntry> rows;

    const auto identity =
        [](const AssetCacheKey& key) -> std::optional<std::pair<Type, std::string>> {
        const auto& stable_identity = key.stable_identity;
        const auto strip_prefix = [&](std::string_view prefix) -> std::optional<std::string> {
            if (!stable_identity.starts_with(prefix))
                return std::nullopt;
            return stable_identity.substr(prefix.size());
        };
        if (auto value = strip_prefix("texture|")) {
            const auto suffix = value->rfind('|');
            if (suffix != std::string::npos)
                value->resize(suffix);
            return std::pair{Type::Image, std::move(*value)};
        }
        if (auto value = strip_prefix("hotspot-mask|"))
            return std::pair{Type::Image, std::move(*value)};
        if (auto value = strip_prefix("audio|")) {
            for (int suffix_count = 0; suffix_count < 2; ++suffix_count) {
                const auto suffix = value->rfind('|');
                if (suffix == std::string::npos)
                    break;
                value->resize(suffix);
            }
            return std::pair{Type::Audio, std::move(*value)};
        }
        if (auto value = strip_prefix("font-source|"))
            return std::pair{Type::Font, std::move(*value)};
        if (auto value = strip_prefix("shader-material|program|"))
            return std::pair{Type::Shader, std::move(*value)};
        if (auto value = strip_prefix("shader-material|material|"))
            return std::pair{Type::Material, std::move(*value)};
        return std::nullopt;
    };

    const auto origin = [](AssetRequestReason reason) {
        switch (reason) {
        case AssetRequestReason::Startup:
            return core::AssetProfilerRequestOrigin::Startup;
        case AssetRequestReason::Demand:
            return core::AssetProfilerRequestOrigin::Demand;
        case AssetRequestReason::Prefetch:
            return core::AssetProfilerRequestOrigin::Prefetched;
        }
        return core::AssetProfilerRequestOrigin::Demand;
    };
    const auto origin_reason = [](core::AssetProfilerRequestOrigin value) {
        switch (value) {
        case core::AssetProfilerRequestOrigin::Startup:
            return core::AssetProfilerRetentionReason::Startup;
        case core::AssetProfilerRequestOrigin::Demand:
            return core::AssetProfilerRetentionReason::Demand;
        case core::AssetProfilerRequestOrigin::ExpectedNext:
            return core::AssetProfilerRetentionReason::ExpectedNext;
        case core::AssetProfilerRequestOrigin::PossibleNext:
            return core::AssetProfilerRetentionReason::PossibleNext;
        case core::AssetProfilerRequestOrigin::Prefetched:
            return core::AssetProfilerRetentionReason::Prefetched;
        }
        return core::AssetProfilerRetentionReason::Demand;
    };
    const auto add_orchestrator = [&](Type type,
                                      const std::vector<AssetOrchestratorProfilerEntry>& entries) {
        const auto blocked_by_memory_policy = [](const core::Diagnostics& diagnostics) {
            return std::ranges::any_of(diagnostics, [](const core::Diagnostic& diagnostic) {
                return diagnostic.code == "assets.prefetch_allowance_exceeded" ||
                       diagnostic.code == "assets.prefetch_preparation_rejected" ||
                       diagnostic.code == "assets.prefetch_preparation_resize_rejected" ||
                       diagnostic.code == "assets.prefetch_residency_rejected";
            });
        };
        for (const auto& source : entries) {
            const auto typed_identity = identity(source.cache_key);
            core::AssetProfilerEntry row;
            row.cache_key = source.cache_key;
            row.asset_type = type;
            row.display_identity = typed_identity && typed_identity->first == type
                                       ? std::move(typed_identity->second)
                                       : source.cache_key.stable_identity;
            row.request_origin = origin(source.request_origin);
            row.retention_reason = origin_reason(row.request_origin);
            row.estimated_cost = source.estimated_cost;
            row.loading_memory_bytes = source.loading_memory_bytes;
            if (source.job_id.valid())
                row.job_id = source.job_id;
            row.prefetch_generation = source.prefetch_generation;
            row.completed_prefetch_claimed = source.completed_prefetch_claimed;
            row.reload_count = source.reload_count;
            row.diagnostics = source.diagnostics;
            switch (source.cache_state) {
            case AssetCacheState::Failed:
                row.state = core::AssetProfilerState::Failed;
                break;
            case AssetCacheState::Canceled:
                row.state = blocked_by_memory_policy(source.diagnostics)
                                ? core::AssetProfilerState::Blocked
                                : core::AssetProfilerState::Loading;
                break;
            case AssetCacheState::WaitingForOwnerFinalization:
                row.state = core::AssetProfilerState::Finishing;
                break;
            case AssetCacheState::Resident:
                row.state = core::AssetProfilerState::Cached;
                break;
            default:
                row.state = core::AssetProfilerState::Loading;
                break;
            }
            rows.insert_or_assign(Key{type, source.cache_key}, std::move(row));
        }
    };

    add_orchestrator(Type::Font, m_async->fonts.profiler_entries_on_owner());
    add_orchestrator(Type::Image, m_async->textures.profiler_entries_on_owner());
    add_orchestrator(Type::Image, m_async->hotspot_masks.profiler_entries_on_owner());
    add_orchestrator(Type::Shader, m_async->shaders.profiler_entries_on_owner());
    add_orchestrator(Type::Material, m_async->materials.profiler_entries_on_owner());
    add_orchestrator(Type::Audio, m_async->audio.profiler_entries_on_owner());

    if (m_async->residency != nullptr) {
        const auto residents = m_async->residency->profiler_records_on_owner();
        for (const auto& resident : residents) {
            auto typed_identity = identity(resident.cache_key);
            if (!typed_identity)
                continue;
            const Key typed_key{typed_identity->first, resident.cache_key};
            auto [found, inserted] = rows.try_emplace(typed_key);
            auto& row = found->second;
            if (inserted) {
                row.cache_key = resident.cache_key;
                row.asset_type = typed_identity->first;
                row.display_identity = std::move(typed_identity->second);
            }
            row.request_origin = origin(resident.request_origin);
            row.committed_cost = resident.committed_cost;
            row.estimated_cost.reset();
            row.loading_memory_bytes = 0;
            row.removable = resident.pin_count == 0;
            row.reload_count = resident.reload_count;
            switch (resident.classification) {
            case ResidencyClass::Pinned:
                row.state = core::AssetProfilerState::InUse;
                row.retention_reason = core::AssetProfilerRetentionReason::RequiredNow;
                break;
            case ResidencyClass::Warm:
                row.state = core::AssetProfilerState::Prefetched;
                row.retention_reason = core::AssetProfilerRetentionReason::Prefetched;
                break;
            case ResidencyClass::Cold:
                row.state = core::AssetProfilerState::Cached;
                row.retention_reason = core::AssetProfilerRetentionReason::RetainedInCache;
                break;
            }
        }
    }

    std::vector<core::AssetProfilerEntry> result;
    result.reserve(rows.size());
    for (auto& [_, row] : rows)
        result.push_back(std::move(row));
    return result;
}

std::pair<ResidencyAccountingSnapshot, ResidencyCost>
AssetManager::asset_profiler_memory_on_owner() const
{
    ResidencyAccountingSnapshot accounting;
    ResidencyCost warm;
    if (m_async == nullptr || m_async->residency == nullptr)
        return {accounting, warm};
    accounting = m_async->residency->accounting_on_owner();
    for (const auto& record : m_async->residency->profiler_records_on_owner()) {
        if (record.classification != ResidencyClass::Warm)
            continue;
        warm.source_bytes += record.committed_cost.source_bytes;
        warm.prepared_cpu_bytes += record.committed_cost.prepared_cpu_bytes;
        warm.gpu_bytes += record.committed_cost.gpu_bytes;
        warm.audio_bytes += record.committed_cost.audio_bytes;
    }
    return {accounting, warm};
}

core::AssetTelemetrySink* AssetManager::asset_profiler_sink_on_owner() const noexcept
{
    return m_async ? m_async->telemetry : nullptr;
}
#endif

void AssetManager::bump_source_generation_on_owner() const noexcept
{
    const auto next = allocate_asset_source_generation();
    if (!next)
        return;
    const auto previous = m_source_generation;
    m_source_generation = *next;
    if (m_async != nullptr && previous.valid())
        m_async->invalidate_generation_on_owner(previous);
    m_texture_preparation_requirements.clear();
    m_hotspot_mask_requests.clear();
}

core::Result<AssetSourceGeneration, core::Diagnostic>
AssetManager::refresh_namespace_on_owner(std::string_view namespace_name) noexcept
{
    if (!valid_namespace(namespace_name) || !has_namespace(namespace_name)) {
        return core::Result<AssetSourceGeneration, core::Diagnostic>::failure(
            {.code = "assets.namespace_not_mounted",
             .message = "cannot refresh an asset namespace that is not mounted: " +
                        std::string(namespace_name)});
    }
    bump_source_generation_on_owner();
    return core::Result<AssetSourceGeneration, core::Diagnostic>::success(m_source_generation);
}

core::Result<AssetRequestHandle<FontAsset>, core::Diagnostic>
AssetManager::request_font(const FontAssetRequest& request, AssetRequestReason reason) noexcept
{
    if (m_async == nullptr || m_font_loader == nullptr) {
        return core::Result<AssetRequestHandle<FontAsset>, core::Diagnostic>::failure(
            {.code = "assets.async_font_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed font loader is bound"});
    }
    auto resolved = canonical_font_source_request(request, m_font_config);
    auto task = m_font_loader->create_font_preparation_task(resolved);
    if (task == nullptr) {
        return core::Result<AssetRequestHandle<FontAsset>, core::Diagnostic>::failure(
            {.code = "assets.font_preparation_unavailable",
             .message = "bound font loader cannot create asynchronous preparation tasks"});
    }
    return m_async->fonts.request_on_owner(make_font_cache_key(resolved, m_source_generation),
                                           reason, std::move(task));
}

core::Result<AssetRequestHandle<TextureAsset>, core::Diagnostic>
AssetManager::request_texture(const TextureAssetRequest& request,
                              AssetRequestReason reason) noexcept
{
    if (m_async == nullptr || m_texture_loader == nullptr) {
        return core::Result<AssetRequestHandle<TextureAsset>, core::Diagnostic>::failure(
            {.code = "assets.async_texture_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed texture loader is bound"});
    }
    auto prepared_request = request;
    const auto key = make_texture_cache_key(request, m_source_generation);
    if (const auto found = m_texture_preparation_requirements.find(key);
        found != m_texture_preparation_requirements.end()) {
        prepared_request.retain_alpha_coverage |= found->second.retain_alpha_coverage;
    }
    auto task = m_texture_loader->create_texture_preparation_task(prepared_request);
    if (task == nullptr) {
        return core::Result<AssetRequestHandle<TextureAsset>, core::Diagnostic>::failure(
            {.code = "assets.texture_preparation_unavailable",
             .message = "bound texture loader cannot create asynchronous preparation tasks"});
    }
    return m_async->textures.request_on_owner(key, reason, std::move(task));
}

core::Result<AssetRequestHandle<HotspotMaskAsset>, core::Diagnostic>
AssetManager::request_hotspot_mask(const HotspotMaskAssetRequest& request,
                                   AssetRequestReason reason) noexcept
{
    if (m_async == nullptr || m_hotspot_mask_loader == nullptr) {
        return core::Result<AssetRequestHandle<HotspotMaskAsset>, core::Diagnostic>::failure(
            {.code = "assets.hotspot_mask.unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no hotspot mask loader is bound"});
    }
    const auto key = make_hotspot_mask_cache_key(request, m_source_generation);
    const auto [found, inserted] = m_hotspot_mask_requests.emplace(key, request);
    if (!inserted && found->second != request) {
        return core::Result<AssetRequestHandle<HotspotMaskAsset>, core::Diagnostic>::failure(
            {.code = "assets.hotspot_mask.request_mismatch",
             .message = "hotspot mask owner was requested with different dimensions or regions"});
    }
    auto task = m_hotspot_mask_loader->create_hotspot_mask_preparation_task(request);
    if (task == nullptr) {
        return core::Result<AssetRequestHandle<HotspotMaskAsset>, core::Diagnostic>::failure(
            {.code = "assets.hotspot_mask.preparation_unavailable",
             .message = "bound hotspot mask loader cannot create a preparation task"});
    }
    return m_async->hotspot_masks.request_on_owner(key, reason, std::move(task));
}

core::Result<AssetRequestHandle<ShaderProgramAsset>, core::Diagnostic>
AssetManager::request_shader_program(const ShaderProgramAssetRequest& request,
                                     AssetRequestReason reason) noexcept
{
    if (m_async == nullptr || m_shader_program_loader == nullptr) {
        return core::Result<AssetRequestHandle<ShaderProgramAsset>, core::Diagnostic>::failure(
            {.code = "assets.async_shader_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed shader program loader is bound"});
    }
    auto task = m_shader_program_loader->create_shader_program_preparation_task(request);
    if (task == nullptr) {
        return core::Result<AssetRequestHandle<ShaderProgramAsset>, core::Diagnostic>::failure(
            {.code = "assets.shader_preparation_unavailable",
             .message = "bound shader loader cannot create asynchronous preparation tasks"});
    }
    return m_async->shaders.request_on_owner(
        make_shader_program_cache_key(request, m_source_generation), reason, std::move(task));
}

core::Result<AssetRequestHandle<MaterialAsset>, core::Diagnostic>
AssetManager::request_material(const MaterialAssetRequest& request,
                               AssetRequestReason reason) noexcept
{
    if (m_async == nullptr || m_material_loader == nullptr) {
        return core::Result<AssetRequestHandle<MaterialAsset>, core::Diagnostic>::failure(
            {.code = "assets.async_material_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed material loader is bound"});
    }
    auto task = m_material_loader->create_material_preparation_task(request);
    if (task == nullptr) {
        return core::Result<AssetRequestHandle<MaterialAsset>, core::Diagnostic>::failure(
            {.code = "assets.material_preparation_unavailable",
             .message = "bound material loader cannot create asynchronous preparation tasks"});
    }
    return m_async->materials.request_on_owner(
        make_material_cache_key(request, m_source_generation), reason, std::move(task));
}

core::Result<AssetRequestHandle<AudioAsset>, core::Diagnostic>
AssetManager::request_audio(const AudioAssetRequest& request, AssetRequestReason reason) noexcept
{
    if (m_async == nullptr || m_audio_loader == nullptr) {
        return core::Result<AssetRequestHandle<AudioAsset>, core::Diagnostic>::failure(
            {.code = "assets.async_audio_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed audio loader is bound"});
    }
    auto task = m_audio_loader->create_audio_preparation_task(request);
    if (task == nullptr) {
        return core::Result<AssetRequestHandle<AudioAsset>, core::Diagnostic>::failure(
            {.code = "assets.audio_preparation_unavailable",
             .message = "bound audio loader cannot create asynchronous preparation tasks"});
    }
    return m_async->audio.request_on_owner(make_audio_cache_key(request, m_source_generation),
                                           reason, std::move(task));
}

core::Result<PrefetchTicket, core::Diagnostic>
AssetManager::prefetch_font(const FontAssetRequest& request,
                            PrefetchGenerationId generation) noexcept
{
    if (m_async == nullptr || m_font_loader == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.async_font_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed font loader is bound"});
    }
    auto resolved = canonical_font_source_request(request, m_font_config);
    auto task = m_font_loader->create_font_preparation_task(resolved);
    if (task == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.font_preparation_unavailable",
             .message = "bound font loader cannot create asynchronous preparation tasks"});
    }
    return m_async->fonts.prefetch_on_owner(make_font_cache_key(resolved, m_source_generation),
                                            generation, std::move(task));
}

core::Result<PrefetchTicket, core::Diagnostic>
AssetManager::prefetch_texture(const TextureAssetRequest& request,
                               PrefetchGenerationId generation) noexcept
{
    if (m_async == nullptr || m_texture_loader == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.async_texture_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed texture loader is bound"});
    }
    auto prepared_request = request;
    const auto key = make_texture_cache_key(request, m_source_generation);
    if (const auto found = m_texture_preparation_requirements.find(key);
        found != m_texture_preparation_requirements.end()) {
        prepared_request.retain_alpha_coverage |= found->second.retain_alpha_coverage;
    }
    auto task = m_texture_loader->create_texture_preparation_task(prepared_request);
    if (task == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.texture_preparation_unavailable",
             .message = "bound texture loader cannot create asynchronous preparation tasks"});
    }
    return m_async->textures.prefetch_on_owner(key, generation, std::move(task));
}

core::Result<PrefetchTicket, core::Diagnostic>
AssetManager::prefetch_hotspot_mask(const HotspotMaskAssetRequest& request,
                                    PrefetchGenerationId generation) noexcept
{
    if (m_async == nullptr || m_hotspot_mask_loader == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.hotspot_mask.unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no hotspot mask loader is bound"});
    }
    const auto key = make_hotspot_mask_cache_key(request, m_source_generation);
    const auto [found, inserted] = m_hotspot_mask_requests.emplace(key, request);
    if (!inserted && found->second != request) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.hotspot_mask.request_mismatch",
             .message = "hotspot mask owner was requested with different dimensions or regions"});
    }
    auto task = m_hotspot_mask_loader->create_hotspot_mask_preparation_task(request);
    if (task == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.hotspot_mask.preparation_unavailable",
             .message = "bound hotspot mask loader cannot create a preparation task"});
    }
    return m_async->hotspot_masks.prefetch_on_owner(key, generation, std::move(task));
}

core::Result<PrefetchTicket, core::Diagnostic>
AssetManager::prefetch_shader_program(const ShaderProgramAssetRequest& request,
                                      PrefetchGenerationId generation) noexcept
{
    if (m_async == nullptr || m_shader_program_loader == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.async_shader_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed shader program loader is bound"});
    }
    auto task = m_shader_program_loader->create_shader_program_preparation_task(request);
    if (task == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.shader_preparation_unavailable",
             .message = "bound shader loader cannot create asynchronous preparation tasks"});
    }
    return m_async->shaders.prefetch_on_owner(
        make_shader_program_cache_key(request, m_source_generation), generation, std::move(task));
}

core::Result<PrefetchTicket, core::Diagnostic>
AssetManager::prefetch_material(const MaterialAssetRequest& request,
                                PrefetchGenerationId generation) noexcept
{
    if (m_async == nullptr || m_material_loader == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.async_material_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed material loader is bound"});
    }
    auto task = m_material_loader->create_material_preparation_task(request);
    if (task == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.material_preparation_unavailable",
             .message = "bound material loader cannot create asynchronous preparation tasks"});
    }
    return m_async->materials.prefetch_on_owner(
        make_material_cache_key(request, m_source_generation), generation, std::move(task));
}

core::Result<PrefetchTicket, core::Diagnostic>
AssetManager::prefetch_audio(const AudioAssetRequest& request,
                             PrefetchGenerationId generation) noexcept
{
    if (m_async == nullptr || m_audio_loader == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.async_audio_unavailable",
             .message = m_async == nullptr ? "async asset requests are not configured"
                                           : "no typed audio loader is bound"});
    }
    auto task = m_audio_loader->create_audio_preparation_task(request);
    if (task == nullptr) {
        return core::Result<PrefetchTicket, core::Diagnostic>::failure(
            {.code = "assets.audio_preparation_unavailable",
             .message = "bound audio loader cannot create asynchronous preparation tasks"});
    }
    return m_async->audio.prefetch_on_owner(make_audio_cache_key(request, m_source_generation),
                                            generation, std::move(task));
}

void AssetManager::stage_candidate_leases_on_owner(StructuredAssetLeaseSet leases) noexcept
{
    if (m_leases == nullptr)
        m_leases = std::make_unique<LeaseState>();
    m_leases->candidate = std::move(leases);
}

void AssetManager::commit_candidate_leases_on_owner() noexcept
{
    if (m_leases == nullptr || !m_leases->candidate)
        return;
    m_leases->previous_published = std::move(m_leases->published);
    m_leases->published = std::move(m_leases->candidate);
    m_leases->candidate.reset();
}

void AssetManager::rollback_candidate_leases_on_owner() noexcept
{
    if (m_leases != nullptr)
        m_leases->candidate.reset();
}

void AssetManager::clear_previous_published_leases_on_owner() noexcept
{
    if (m_leases != nullptr)
        m_leases->previous_published.reset();
}

void AssetManager::clear_published_leases_on_owner() noexcept
{
    if (m_leases == nullptr)
        return;
    m_leases->candidate.reset();
    m_leases->published.reset();
    m_leases->previous_published.reset();
}

void AssetManager::set_supplemental_leases_on_owner(StructuredAssetLeaseSet leases) noexcept
{
    if (m_leases == nullptr)
        m_leases = std::make_unique<LeaseState>();
    m_leases->supplemental = std::move(leases);
}

void AssetManager::clear_supplemental_leases_on_owner() noexcept
{
    if (m_leases != nullptr)
        m_leases->supplemental.reset();
}

void AssetManager::stage_focused_candidate_leases_on_owner(StructuredAssetLeaseSet leases) noexcept
{
    if (m_leases == nullptr)
        m_leases = std::make_unique<LeaseState>();
    m_leases->focused_candidate = std::move(leases);
}

void AssetManager::commit_focused_candidate_leases_on_owner() noexcept
{
    if (m_leases == nullptr || !m_leases->focused_candidate)
        return;
    m_leases->focused_published = std::move(m_leases->focused_candidate);
    m_leases->focused_candidate.reset();
}

void AssetManager::rollback_focused_candidate_leases_on_owner() noexcept
{
    if (m_leases != nullptr)
        m_leases->focused_candidate.reset();
}

void AssetManager::clear_focused_published_leases_on_owner() noexcept
{
    if (m_leases == nullptr)
        return;
    m_leases->focused_candidate.reset();
    m_leases->focused_published.reset();
}

bool AssetManager::has_candidate_leases_on_owner() const noexcept
{
    return m_leases != nullptr && m_leases->candidate.has_value();
}

bool AssetManager::has_published_leases_on_owner() const noexcept
{
    return m_leases != nullptr && m_leases->published.has_value();
}

bool AssetManager::has_previous_published_leases_on_owner() const noexcept
{
    return m_leases != nullptr && m_leases->previous_published.has_value();
}

bool AssetManager::has_supplemental_leases_on_owner() const noexcept
{
    return m_leases != nullptr && m_leases->supplemental.has_value();
}

bool AssetManager::has_focused_candidate_leases_on_owner() const noexcept
{
    return m_leases != nullptr && m_leases->focused_candidate.has_value();
}

bool AssetManager::has_focused_published_leases_on_owner() const noexcept
{
    return m_leases != nullptr && m_leases->focused_published.has_value();
}

namespace {

template<class Lease, class Lookup>
const Lease* find_leased_asset(const std::optional<StructuredAssetLeaseSet>& candidate,
                               const std::optional<StructuredAssetLeaseSet>& published,
                               const std::optional<StructuredAssetLeaseSet>& previous_published,
                               const std::optional<StructuredAssetLeaseSet>& supplemental,
                               const std::optional<StructuredAssetLeaseSet>& focused_candidate,
                               const std::optional<StructuredAssetLeaseSet>& focused_published,
                               Lookup&& lookup) noexcept
{
    if (focused_candidate) {
        if (const auto* lease = lookup(*focused_candidate))
            return lease;
    }
    if (focused_published) {
        if (const auto* lease = lookup(*focused_published))
            return lease;
    }
    if (candidate) {
        if (const auto* lease = lookup(*candidate))
            return lease;
    }
    if (published) {
        if (const auto* lease = lookup(*published))
            return lease;
    }
    if (previous_published) {
        if (const auto* lease = lookup(*previous_published))
            return lease;
    }
    return supplemental ? lookup(*supplemental) : nullptr;
}

} // namespace

const AssetLease<FontAsset>*
AssetManager::leased_font_on_owner(const FontAssetRequest& request) const noexcept
{
    const auto resolved = canonical_font_source_request(request, m_font_config);
    const auto key = make_font_cache_key(resolved, m_source_generation);
    if (m_leases == nullptr)
        return nullptr;
    return find_leased_asset<AssetLease<FontAsset>>(
        m_leases->candidate, m_leases->published, m_leases->previous_published,
        m_leases->supplemental, m_leases->focused_candidate, m_leases->focused_published,
        [&](const auto& set) { return set.find_font(key); });
}

const AssetLease<TextureAsset>*
AssetManager::leased_texture_on_owner(const TextureAssetRequest& request) const noexcept
{
    const auto key = make_texture_cache_key(request, m_source_generation);
    if (m_leases == nullptr)
        return nullptr;
    return find_leased_asset<AssetLease<TextureAsset>>(
        m_leases->candidate, m_leases->published, m_leases->previous_published,
        m_leases->supplemental, m_leases->focused_candidate, m_leases->focused_published,
        [&](const auto& set) { return set.find_texture(key); });
}

const AssetLease<HotspotMaskAsset>*
AssetManager::leased_hotspot_mask_on_owner(const HotspotMaskAssetRequest& request) const noexcept
{
    const auto key = make_hotspot_mask_cache_key(request, m_source_generation);
    if (m_leases == nullptr)
        return nullptr;
    return find_leased_asset<AssetLease<HotspotMaskAsset>>(
        m_leases->candidate, m_leases->published, m_leases->previous_published,
        m_leases->supplemental, m_leases->focused_candidate, m_leases->focused_published,
        [&](const auto& set) { return set.find_hotspot_mask(key); });
}

const AssetLease<ShaderProgramAsset>* AssetManager::leased_shader_program_on_owner(
    const ShaderProgramAssetRequest& request) const noexcept
{
    const auto key = make_shader_program_cache_key(request, m_source_generation);
    if (m_leases == nullptr)
        return nullptr;
    return find_leased_asset<AssetLease<ShaderProgramAsset>>(
        m_leases->candidate, m_leases->published, m_leases->previous_published,
        m_leases->supplemental, m_leases->focused_candidate, m_leases->focused_published,
        [&](const auto& set) { return set.find_shader_program(key); });
}

const AssetLease<MaterialAsset>*
AssetManager::leased_material_on_owner(const MaterialAssetRequest& request) const noexcept
{
    const auto key = make_material_cache_key(request, m_source_generation);
    if (m_leases == nullptr)
        return nullptr;
    return find_leased_asset<AssetLease<MaterialAsset>>(
        m_leases->candidate, m_leases->published, m_leases->previous_published,
        m_leases->supplemental, m_leases->focused_candidate, m_leases->focused_published,
        [&](const auto& set) { return set.find_material(key); });
}

const AssetLease<AudioAsset>*
AssetManager::leased_audio_on_owner(const AudioAssetRequest& request) const noexcept
{
    const auto key = make_audio_cache_key(request, m_source_generation);
    if (m_leases == nullptr)
        return nullptr;
    return find_leased_asset<AssetLease<AudioAsset>>(
        m_leases->candidate, m_leases->published, m_leases->previous_published,
        m_leases->supplemental, m_leases->focused_candidate, m_leases->focused_published,
        [&](const auto& set) { return set.find_audio(key); });
}

std::string
AssetManager::describe_texture_lease_lookup_on_owner(const TextureAssetRequest& request) const
{
    const auto key = make_texture_cache_key(request, m_source_generation);
    std::string result =
        "lookup=" + key.stable_identity + "@" + std::to_string(key.source_generation.value);
    if (m_leases == nullptr) {
        return result + " candidate=<none> published=<none> focused-candidate=<none> "
                        "focused-published=<none> supplemental=<none>";
    }

    const auto describe = [](const std::optional<StructuredAssetLeaseSet>& leases) {
        return leases ? leases->describe_texture_keys() : std::string{"<absent>"};
    };
    result += " candidate=[" + describe(m_leases->candidate) + "]";
    result += " published=[" + describe(m_leases->published) + "]";
    result += " previous-published=[" + describe(m_leases->previous_published) + "]";
    result += " focused-candidate=[" + describe(m_leases->focused_candidate) + "]";
    result += " focused-published=[" + describe(m_leases->focused_published) + "]";
    result += " supplemental=[" + describe(m_leases->supplemental) + "]";
    return result;
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
