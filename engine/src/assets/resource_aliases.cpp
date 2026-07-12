#include "noveltea/assets/resource_aliases.hpp"

#include <nlohmann/json.hpp>

#include <utility>

namespace noveltea::assets {
namespace {

template<class T> AssetResult<T> fail(std::string message)
{
    return {std::nullopt, std::move(message)};
}

std::optional<std::string> get_string(const nlohmann::json& object, const char* key)
{
    const auto it = object.find(key);
    if (it == object.end() || !it->is_string())
        return std::nullopt;
    return it->get<std::string>();
}

AudioClipKind parse_audio_kind(const std::string& value)
{
    if (value == "sfx" || value == "Sfx")
        return AudioClipKind::Sfx;
    if (value == "music" || value == "Music")
        return AudioClipKind::Music;
    if (value == "ambience" || value == "Ambience" || value == "ambient")
        return AudioClipKind::Ambience;
    if (value == "voice" || value == "Voice")
        return AudioClipKind::Voice;
    return AudioClipKind::Auto;
}

AudioLoadMode parse_audio_load_mode(const std::string& value)
{
    if (value == "decode" || value == "Decode")
        return AudioLoadMode::Decode;
    if (value == "stream" || value == "Stream")
        return AudioLoadMode::Stream;
    return AudioLoadMode::Auto;
}

MaterialTextureSampler parse_sampler(const std::string& value)
{
    if (value == "nearest" || value == "clamp_nearest" || value == "ClampNearest")
        return MaterialTextureSampler::ClampNearest;
    if (value == "repeat_nearest" || value == "RepeatNearest")
        return MaterialTextureSampler::RepeatNearest;
    if (value == "repeat_linear" || value == "RepeatLinear")
        return MaterialTextureSampler::RepeatLinear;
    return MaterialTextureSampler::ClampLinear;
}

void parse_audio_aliases(const nlohmann::json& resources, ResourceAliasRegistry& registry)
{
    const auto it = resources.find("audio");
    if (it == resources.end() || !it->is_object())
        return;

    for (const auto& item : it->items()) {
        const std::string& alias = item.key();
        const auto& value = item.value();
        if (value.is_string()) {
            registry.register_audio(alias, AudioAssetRequest{.path = value.get<std::string>()});
            continue;
        }
        if (!value.is_object())
            continue;
        auto path = get_string(value, "path");
        if (!path)
            continue;
        AudioAssetRequest request{.path = *path};
        if (auto kind = get_string(value, "kind"))
            request.kind = parse_audio_kind(*kind);
        if (auto mode = get_string(value, "load"))
            request.mode = parse_audio_load_mode(*mode);
        if (auto mode = get_string(value, "mode"))
            request.mode = parse_audio_load_mode(*mode);
        registry.register_audio(alias, std::move(request));
    }
}

void parse_texture_aliases(const nlohmann::json& resources, ResourceAliasRegistry& registry)
{
    const auto it = resources.find("textures");
    if (it == resources.end() || !it->is_object())
        return;

    for (const auto& item : it->items()) {
        const std::string& alias = item.key();
        const auto& value = item.value();
        if (value.is_string()) {
            registry.register_texture(alias, TextureAssetRequest{.path = value.get<std::string>()});
            continue;
        }
        if (!value.is_object())
            continue;
        auto path = get_string(value, "path");
        if (!path)
            continue;
        TextureAssetRequest request{.path = *path};
        if (auto sampler = get_string(value, "sampler"))
            request.sampler = parse_sampler(*sampler);
        registry.register_texture(alias, std::move(request));
    }
}

void parse_material_aliases(const nlohmann::json& resources, ResourceAliasRegistry& registry)
{
    const auto it = resources.find("materials");
    if (it == resources.end() || !it->is_object())
        return;

    for (const auto& item : it->items()) {
        const std::string& alias = item.key();
        const auto& value = item.value();
        if (value.is_string()) {
            registry.register_material(alias, MaterialAssetRequest{.id = value.get<std::string>()});
            continue;
        }
        if (!value.is_object())
            continue;
        auto id = get_string(value, "id");
        if (!id)
            id = get_string(value, "material");
        if (!id)
            continue;
        registry.register_material(alias, MaterialAssetRequest{.id = *id});
    }
}

} // namespace

void ResourceAliasRegistry::clear()
{
    audio.clear();
    textures.clear();
    materials.clear();
}

bool ResourceAliasRegistry::empty() const noexcept
{
    return audio.empty() && textures.empty() && materials.empty();
}

void ResourceAliasRegistry::register_audio(std::string alias, AudioAssetRequest request)
{
    audio[std::move(alias)] = std::move(request);
}

void ResourceAliasRegistry::register_texture(std::string alias, TextureAssetRequest request)
{
    textures[std::move(alias)] = std::move(request);
}

void ResourceAliasRegistry::register_material(std::string alias, MaterialAssetRequest request)
{
    materials[std::move(alias)] = std::move(request);
}

std::optional<AudioAssetRequest> ResourceAliasRegistry::audio_request(std::string_view alias) const
{
    const auto it = audio.find(std::string(alias));
    if (it == audio.end())
        return std::nullopt;
    return it->second;
}

std::optional<TextureAssetRequest>
ResourceAliasRegistry::texture_request(std::string_view alias) const
{
    const auto it = textures.find(std::string(alias));
    if (it == textures.end())
        return std::nullopt;
    return it->second;
}

std::optional<MaterialAssetRequest>
ResourceAliasRegistry::material_request(std::string_view alias) const
{
    const auto it = materials.find(std::string(alias));
    if (it == materials.end())
        return std::nullopt;
    return it->second;
}

AssetResult<ResourceAliasRegistry> parse_resource_alias_registry(std::string_view json_text)
{
    const auto root = nlohmann::json::parse(json_text, nullptr, false);
    if (root.is_discarded()) {
        return fail<ResourceAliasRegistry>("invalid resource alias manifest JSON");
    }
    if (!root.is_object()) {
        return fail<ResourceAliasRegistry>("resource alias manifest root must be an object");
    }

    const nlohmann::json* resources = &root;
    const auto resources_it = root.find("resources");
    if (resources_it != root.end()) {
        if (!resources_it->is_object()) {
            return fail<ResourceAliasRegistry>(
                "resource alias manifest resources must be an object");
        }
        resources = &*resources_it;
    }

    ResourceAliasRegistry registry;
    parse_audio_aliases(*resources, registry);
    parse_texture_aliases(*resources, registry);
    parse_material_aliases(*resources, registry);
    return {std::move(registry), {}};
}

} // namespace noveltea::assets
