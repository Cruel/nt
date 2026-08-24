#include "noveltea/assets/resource_aliases.hpp"
#include "noveltea/core/json_access.hpp"

#include <nlohmann/json.hpp>

#include <initializer_list>
#include <string_view>
#include <utility>

namespace noveltea::assets {
namespace {

template<class T> AssetLoadResult<T> fail(std::string message)
{
    return {std::nullopt, std::move(message)};
}

std::optional<std::string> get_string(const nlohmann::json& object, const char* key)
{
    const auto it = object.find(key);
    if (it == object.end() || !it->is_string())
        return std::nullopt;
    return core::json_access::get<std::string>(*it);
}

bool has_only_keys(const nlohmann::json& object, std::initializer_list<std::string_view> allowed)
{
    for (auto it = object.begin(); it != object.end(); ++it) {
        bool found = false;
        for (const auto key : allowed) {
            if (it.key() == key) {
                found = true;
                break;
            }
        }
        if (!found)
            return false;
    }
    return true;
}

std::optional<AudioClipKind> parse_audio_kind(const std::string& value)
{
    if (value == "auto")
        return AudioClipKind::Auto;
    if (value == "sfx")
        return AudioClipKind::Sfx;
    if (value == "music")
        return AudioClipKind::Music;
    if (value == "ambience")
        return AudioClipKind::Ambience;
    if (value == "voice")
        return AudioClipKind::Voice;
    return std::nullopt;
}

std::optional<AudioLoadMode> parse_audio_load_mode(const std::string& value)
{
    if (value == "auto")
        return AudioLoadMode::Auto;
    if (value == "decode")
        return AudioLoadMode::Decode;
    if (value == "stream")
        return AudioLoadMode::Stream;
    return std::nullopt;
}

std::optional<MaterialTextureSampler> parse_sampler(const std::string& value)
{
    if (value == "linear")
        return MaterialTextureSampler::ClampLinear;
    if (value == "nearest")
        return MaterialTextureSampler::ClampNearest;
    if (value == "repeat_nearest")
        return MaterialTextureSampler::RepeatNearest;
    if (value == "repeat_linear")
        return MaterialTextureSampler::RepeatLinear;
    return std::nullopt;
}

std::optional<std::string> parse_audio_aliases(const nlohmann::json& resources,
                                               ResourceAliasRegistry& registry)
{
    const auto it = resources.find("audio");
    if (it == resources.end())
        return std::nullopt;
    if (!it->is_object())
        return "resource alias manifest audio must be an object";

    for (auto item = it->begin(); item != it->end(); ++item) {
        const std::string& alias = item.key();
        const auto& value = *item;
        if (alias.empty() || !value.is_object() || !has_only_keys(value, {"path", "kind", "load"}))
            return "resource alias manifest contains an invalid audio entry";
        auto path = get_string(value, "path");
        if (!path || path->empty())
            return "resource alias manifest audio path must be a non-empty string";
        AudioAssetRequest request{.path = *path};
        if (value.contains("kind")) {
            auto kind_name = get_string(value, "kind");
            auto kind = kind_name ? parse_audio_kind(*kind_name) : std::nullopt;
            if (!kind)
                return "resource alias manifest audio kind is invalid";
            request.kind = *kind;
        }
        if (value.contains("load")) {
            auto mode_name = get_string(value, "load");
            auto mode = mode_name ? parse_audio_load_mode(*mode_name) : std::nullopt;
            if (!mode)
                return "resource alias manifest audio load mode is invalid";
            request.mode = *mode;
        }
        registry.register_audio(alias, std::move(request));
    }
    return std::nullopt;
}

std::optional<std::string> parse_texture_aliases(const nlohmann::json& resources,
                                                 ResourceAliasRegistry& registry)
{
    const auto it = resources.find("textures");
    if (it == resources.end())
        return std::nullopt;
    if (!it->is_object())
        return "resource alias manifest textures must be an object";

    for (auto item = it->begin(); item != it->end(); ++item) {
        const std::string& alias = item.key();
        const auto& value = *item;
        if (alias.empty() || !value.is_object() || !has_only_keys(value, {"path", "sampler"}))
            return "resource alias manifest contains an invalid texture entry";
        auto path = get_string(value, "path");
        if (!path || path->empty())
            return "resource alias manifest texture path must be a non-empty string";
        TextureAssetRequest request{.path = *path};
        if (value.contains("sampler")) {
            auto sampler_name = get_string(value, "sampler");
            auto sampler = sampler_name ? parse_sampler(*sampler_name) : std::nullopt;
            if (!sampler)
                return "resource alias manifest texture sampler is invalid";
            request.sampler = *sampler;
        }
        registry.register_texture(alias, std::move(request));
    }
    return std::nullopt;
}

std::optional<std::string> parse_material_aliases(const nlohmann::json& resources,
                                                  ResourceAliasRegistry& registry)
{
    const auto it = resources.find("materials");
    if (it == resources.end())
        return std::nullopt;
    if (!it->is_object())
        return "resource alias manifest materials must be an object";

    for (auto item = it->begin(); item != it->end(); ++item) {
        const std::string& alias = item.key();
        const auto& value = *item;
        if (alias.empty() || !value.is_object() || !has_only_keys(value, {"id"}))
            return "resource alias manifest contains an invalid material entry";
        auto id = get_string(value, "id");
        if (!id || id->empty())
            return "resource alias manifest material id must be a non-empty string";
        registry.register_material(alias, MaterialAssetRequest{.id = *id});
    }
    return std::nullopt;
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

AssetLoadResult<ResourceAliasRegistry> parse_resource_alias_registry(std::string_view json_text)
{
    const auto root = nlohmann::json::parse(json_text, nullptr, false);
    if (root.is_discarded()) {
        return fail<ResourceAliasRegistry>("invalid resource alias manifest JSON");
    }
    if (!root.is_object()) {
        return fail<ResourceAliasRegistry>("resource alias manifest root must be an object");
    }

    const auto schema = core::json_access::member_as<std::string>(root, "schema");
    const auto* resources = core::json_access::member(root, "resources");
    if (!has_only_keys(root, {"schema", "resources"}) ||
        schema != std::optional<std::string>{"noveltea.resource-aliases"} || !resources ||
        !resources->is_object()) {
        return fail<ResourceAliasRegistry>(
            "unsupported resource alias manifest; expected noveltea.resource-aliases");
    }

    if (!has_only_keys(*resources, {"audio", "textures", "materials"}))
        return fail<ResourceAliasRegistry>(
            "resource alias manifest resources contain unknown fields");

    ResourceAliasRegistry registry;
    if (auto error = parse_audio_aliases(*resources, registry))
        return fail<ResourceAliasRegistry>(std::move(*error));
    if (auto error = parse_texture_aliases(*resources, registry))
        return fail<ResourceAliasRegistry>(std::move(*error));
    if (auto error = parse_material_aliases(*resources, registry))
        return fail<ResourceAliasRegistry>(std::move(*error));
    return {std::move(registry), {}};
}

} // namespace noveltea::assets
