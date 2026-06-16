#include "noveltea/assets/asset_manager.hpp"

#include <algorithm>
#include <fstream>
#include <sstream>

namespace noveltea::assets {
namespace {

bool valid_namespace(std::string_view value)
{
    if (value.empty()) return false;
    return std::all_of(value.begin(), value.end(), [](char ch) {
        return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
    });
}

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
    }

    if (rest.empty() || rest.front() == '/' || rest.find("//") != std::string_view::npos) return std::nullopt;

    std::size_t start = 0;
    while (start <= rest.size()) {
        const std::size_t slash = rest.find('/', start);
        const std::string_view part = rest.substr(start, slash == std::string_view::npos ? slash : slash - start);
        if (part.empty() || part == "." || part == "..") return std::nullopt;
        if (slash == std::string_view::npos) break;
        start = slash + 1;
    }

    result.m_relative_path = std::string(rest);
    return result;
}

std::string AssetPath::logical_path() const
{
    if (m_namespace.empty()) return m_relative_path;
    return m_namespace + ":/" + m_relative_path;
}

DirectoryAssetSource::DirectoryAssetSource(std::filesystem::path root)
    : m_root(std::move(root))
{
}

std::filesystem::path DirectoryAssetSource::resolve(const AssetPath& path) const
{
    return m_root / std::filesystem::path(path.relative_path());
}

std::optional<AssetReadResult> DirectoryAssetSource::read_binary(const AssetPath& path) const
{
    const auto physical = resolve(path);
    std::ifstream in(physical, std::ios::binary);
    if (!in) return std::nullopt;
    AssetReadResult result;
    result.physical_path = physical;
    result.bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    return result;
}

bool DirectoryAssetSource::exists(const AssetPath& path) const
{
    return std::filesystem::is_regular_file(resolve(path));
}

std::string DirectoryAssetSource::describe() const
{
    return "directory:" + m_root.string();
}

void AssetManager::mount(std::string namespace_name, AssetSourcePtr source)
{
    if (!source || !valid_namespace(namespace_name)) return;
    m_mounts[std::move(namespace_name)].push_back(std::move(source));
}

void AssetManager::mount_directory(std::string namespace_name, std::filesystem::path root)
{
    mount(std::move(namespace_name), std::make_shared<DirectoryAssetSource>(std::move(root)));
}

const std::vector<AssetSourcePtr>* AssetManager::sources_for(const AssetPath& path) const
{
    const auto ns = path.has_namespace() ? path.namespace_name() : std::string("project");
    auto it = m_mounts.find(ns);
    if (it == m_mounts.end()) return nullptr;
    return &it->second;
}

std::optional<AssetReadResult> AssetManager::read_binary(std::string_view logical_path) const
{
    const auto path = AssetPath::parse(logical_path);
    if (!path) {
        set_error("invalid asset path: " + std::string(logical_path));
        return std::nullopt;
    }

    const auto* sources = sources_for(*path);
    if (!sources || sources->empty()) {
        set_error("no mount for asset namespace: " + (path->has_namespace() ? path->namespace_name() : std::string("project")));
        return std::nullopt;
    }

    std::ostringstream searched;
    for (const auto& source : *sources) {
        if (auto result = source->read_binary(*path)) {
            m_last_error.clear();
            return result;
        }
        searched << source->describe() << " ";
    }

    set_error("asset not found: " + path->logical_path() + " searched: " + searched.str());
    return std::nullopt;
}

std::optional<AssetText> AssetManager::read_text(std::string_view logical_path) const
{
    auto binary = read_binary(logical_path);
    if (!binary) return std::nullopt;
    return AssetText(binary->bytes.begin(), binary->bytes.end());
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

std::vector<std::string> AssetManager::describe_mounts() const
{
    std::vector<std::string> result;
    for (const auto& [ns, sources] : m_mounts) {
        for (const auto& source : sources) {
            result.push_back(ns + ":/ -> " + source->describe());
        }
    }
    return result;
}

void AssetManager::set_error(std::string message) const
{
    m_last_error = std::move(message);
}

} // namespace noveltea::assets
