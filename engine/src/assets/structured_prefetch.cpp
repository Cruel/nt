#include "noveltea/assets/structured_prefetch.hpp"

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"

#include <algorithm>
#include <limits>
#include <map>
#include <set>
#include <string>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <utility>

namespace noveltea::assets {
namespace {

using DependencyDescriptorList = std::vector<StructuredAssetRequestDescriptor>;
using CacheIdentity = std::pair<std::string, std::uint64_t>;
constexpr std::size_t prefetch_plan_structural_ceiling = 4096;

struct PrefetchCostEstimate {
    ResidencyCost cost;
    PrefetchCostEstimateKind kind = PrefetchCostEstimateKind::Conservative;
};

[[nodiscard]] std::uint64_t saturating_multiply(std::uint64_t left, std::uint64_t right) noexcept
{
    if (left == 0 || right == 0)
        return 0;
    if (left > std::numeric_limits<std::uint64_t>::max() / right)
        return std::numeric_limits<std::uint64_t>::max();
    return left * right;
}

[[nodiscard]] std::uint64_t saturating_add(std::uint64_t left, std::uint64_t right) noexcept
{
    if (left > std::numeric_limits<std::uint64_t>::max() - right)
        return std::numeric_limits<std::uint64_t>::max();
    return left + right;
}

[[nodiscard]] std::string package_relative_path(std::string_view path)
{
    if (path.starts_with("project:/"))
        return std::string(path.substr(9));
    return std::string(path);
}

[[nodiscard]] CacheIdentity identity_of(const AssetCacheKey& key)
{
    return {key.stable_identity, key.source_generation.value};
}

[[nodiscard]] std::string logical_project_path(std::string_view path)
{
    return path.find(":/") == std::string_view::npos ? "project:/" + std::string(path)
                                                     : std::string(path);
}

void add_diagnostic(core::Diagnostics& diagnostics, std::string code, std::string message,
                    core::ErrorSeverity severity = core::ErrorSeverity::Warning)
{
    diagnostics.push_back(
        {.code = std::move(code), .message = std::move(message), .severity = severity});
}

[[nodiscard]] bool is_builtin_runtime_layout(const core::LayoutId& id) noexcept
{
    return id.text() == core::compiled::builtin_inventory_layout_id ||
           id.text() == core::compiled::builtin_verb_menu_layout_id;
}

struct SeenDescriptorState {
    bool retain_alpha_coverage = false;
};

[[nodiscard]] bool
descriptor_retain_alpha_coverage(const StructuredAssetRequestDescriptor& descriptor) noexcept
{
    const auto* texture = std::get_if<TextureAssetRequest>(&descriptor.request);
    return texture != nullptr && texture->retain_alpha_coverage;
}

class DescriptorAccumulator {
public:
    explicit DescriptorAccumulator(
        std::map<CacheIdentity, SeenDescriptorState>* shared_seen = nullptr)
        : m_seen(shared_seen == nullptr ? &m_owned_seen : shared_seen)
    {
    }

    void add(const StructuredAssetRequestDescriptor& descriptor)
    {
        if (!descriptor.cache_key.valid())
            return;
        const auto identity = identity_of(descriptor.cache_key);
        const bool incoming_alpha = descriptor_retain_alpha_coverage(descriptor);
        const auto [seen, inserted] = m_seen->try_emplace(
            identity, SeenDescriptorState{.retain_alpha_coverage = incoming_alpha});
        if (inserted) {
            m_local.emplace(identity, m_descriptors.size());
            m_descriptors.push_back(descriptor);
            return;
        }
        const auto local = m_local.find(identity);
        if (local == m_local.end()) {
            if (!incoming_alpha || seen->second.retain_alpha_coverage)
                return;
            seen->second.retain_alpha_coverage = true;
            m_local.emplace(identity, m_descriptors.size());
            m_descriptors.push_back(descriptor);
            return;
        }
        auto* existing = std::get_if<TextureAssetRequest>(&m_descriptors[local->second].request);
        const auto* incoming = std::get_if<TextureAssetRequest>(&descriptor.request);
        if (existing != nullptr && incoming != nullptr) {
            existing->retain_alpha_coverage |= incoming->retain_alpha_coverage;
            seen->second.retain_alpha_coverage |= incoming->retain_alpha_coverage;
        }
    }

    void add(const DependencyDescriptorList& descriptors)
    {
        for (const auto& descriptor : descriptors)
            add(descriptor);
    }

    [[nodiscard]] DependencyDescriptorList take() { return std::move(m_descriptors); }

private:
    std::map<CacheIdentity, SeenDescriptorState> m_owned_seen;
    std::map<CacheIdentity, SeenDescriptorState>* m_seen;
    std::map<CacheIdentity, std::size_t> m_local;
    DependencyDescriptorList m_descriptors;
};

[[nodiscard]] MaterialTextureSampler image_sampler(core::compiled::ImageSampling sampling) noexcept
{
    return sampling == core::compiled::ImageSampling::Nearest ? MaterialTextureSampler::ClampNearest
                                                              : MaterialTextureSampler::ClampLinear;
}

[[nodiscard]] AudioClipKind audio_kind(core::compiled::AudioPurpose channel) noexcept
{
    switch (channel) {
    case core::compiled::AudioPurpose::SoundEffect:
        return AudioClipKind::Sfx;
    case core::compiled::AudioPurpose::Music:
        return AudioClipKind::Music;
    case core::compiled::AudioPurpose::Voice:
        return AudioClipKind::Voice;
    case core::compiled::AudioPurpose::Ambience:
        return AudioClipKind::Ambience;
    case core::compiled::AudioPurpose::UiSound:
        return AudioClipKind::Sfx;
    }
    return AudioClipKind::Auto;
}

[[nodiscard]] StructuredAssetRequestDescriptor
font_descriptor(const core::compiled::AssetResource& asset, AssetSourceGeneration generation)
{
    FontAssetRequest request{.alias = asset.id.text(),
                             .source_path = std::nullopt,
                             .style = TextFontRegular,
                             .language = "und",
                             .size = 0.0f};
    return {.request = request, .cache_key = make_font_cache_key(request, generation)};
}

[[nodiscard]] StructuredAssetRequestDescriptor
texture_descriptor(const core::compiled::AssetResource& asset, AssetSourceGeneration generation)
{
    assert(asset.kind == core::compiled::AssetKind::Image && asset.sampling.has_value());
    TextureAssetRequest request{.path = logical_project_path(asset.path),
                                .sampler = image_sampler(*asset.sampling)};
    return {.request = request, .cache_key = make_texture_cache_key(request, generation)};
}

[[nodiscard]] StructuredAssetRequestDescriptor
texture_descriptor(const core::compiled::AssetResource& asset, AssetSourceGeneration generation,
                   bool retain_alpha_coverage)
{
    auto descriptor = texture_descriptor(asset, generation);
    std::get<TextureAssetRequest>(descriptor.request).retain_alpha_coverage = retain_alpha_coverage;
    return descriptor;
}

[[nodiscard]] StructuredAssetRequestDescriptor
hotspot_mask_descriptor(HotspotMaskAssetRequest request, AssetSourceGeneration generation)
{
    const auto key = make_hotspot_mask_cache_key(request, generation);
    return {.request = std::move(request), .cache_key = key};
}

[[nodiscard]] StructuredAssetRequestDescriptor texture_descriptor(std::string_view path,
                                                                  MaterialTextureSampler sampler,
                                                                  AssetSourceGeneration generation)
{
    TextureAssetRequest request{.path = std::string(path), .sampler = sampler};
    return {.request = request, .cache_key = make_texture_cache_key(request, generation)};
}

[[nodiscard]] StructuredAssetRequestDescriptor
audio_descriptor(const core::compiled::AssetResource& asset, core::compiled::AudioPurpose channel,
                 AssetSourceGeneration generation)
{
    AudioAssetRequest request{.path = logical_project_path(asset.path),
                              .mode = AudioLoadMode::Auto,
                              .kind = audio_kind(channel)};
    return {.request = request, .cache_key = make_audio_cache_key(request, generation)};
}

[[nodiscard]] bool static_package_texture(std::string_view source) noexcept
{
    return source.starts_with("project:/") || source.starts_with("system:/");
}

} // namespace

struct StructuredAssetDependencyIndex::Impl {
    struct MaterialDependencies {
        DependencyDescriptorList descriptors;
        core::Diagnostics diagnostics;
    };

    struct LayoutDependencies {
        DependencyDescriptorList descriptors;
        core::Diagnostics diagnostics;
    };

    const core::LoadedCompiledPackage* package = nullptr;
    AssetSourceGeneration source_generation;
    std::string renderer_variant;
    core::Diagnostics configuration_diagnostics;
    core::Diagnostics diagnostics;
    std::unordered_map<std::string, std::uint64_t> package_entry_sizes;
    std::unordered_map<std::string, const core::compiled::AssetResource*> assets_by_logical_path;

    std::unordered_map<core::AssetId, const core::compiled::AssetResource*> assets;
    std::unordered_map<core::LayoutId, const core::compiled::LayoutResource*> layouts;
    std::unordered_map<core::CharacterId, const core::compiled::CharacterDefinition*> characters;
    std::unordered_map<core::RoomId, const core::compiled::RoomDefinition*> rooms;
    std::unordered_map<core::InteractableInstanceId, const core::compiled::InteractableDefinition*>
        interactables;
    std::unordered_map<std::string, MaterialDependencies> material_dependencies;
    std::unordered_map<core::LayoutId, LayoutDependencies> layout_dependencies;
    std::unordered_map<core::RoomId, std::vector<const core::compiled::CharacterDefinition*>>
        initial_characters_by_room;
    struct InitialInteractable {
        core::InteractableInstanceId instance;
        const core::compiled::InteractableDefinition* definition;
    };
    std::unordered_map<core::RoomId, std::vector<InitialInteractable>>
        initial_interactables_by_room;

    [[nodiscard]] const core::compiled::AssetResource* find_asset(const core::AssetId& id) const
    {
        const auto found = assets.find(id);
        return found == assets.end() ? nullptr : found->second;
    }

    [[nodiscard]] std::optional<std::uint64_t> package_entry_size(std::string_view path) const
    {
        const auto found = package_entry_sizes.find(package_relative_path(path));
        return found == package_entry_sizes.end() ? std::nullopt
                                                  : std::optional<std::uint64_t>{found->second};
    }

    [[nodiscard]] PrefetchCostEstimate
    estimate_cost(const StructuredAssetRequestDescriptor& descriptor) const
    {
        PrefetchCostEstimate estimate;
        std::visit(
            [&](const auto& request) {
                using T = std::decay_t<decltype(request)>;
                if constexpr (std::is_same_v<T, TextureAssetRequest>) {
                    if (const auto size = package_entry_size(request.path))
                        estimate.cost.source_bytes = *size;
                    const auto asset = assets_by_logical_path.find(request.path);
                    if (asset != assets_by_logical_path.end() && asset->second->width &&
                        asset->second->height) {
                        const auto pixels =
                            saturating_multiply(*asset->second->width, *asset->second->height);
                        estimate.cost.gpu_bytes = saturating_multiply(pixels, 4);
                        if (request.retain_alpha_coverage)
                            estimate.cost.prepared_cpu_bytes = pixels;
                        estimate.kind = PrefetchCostEstimateKind::Metadata;
                    } else {
                        // Unknown image dimensions must not force decode merely to price
                        // speculation. A 2048x2048 RGBA surface is deliberately conservative.
                        estimate.cost.gpu_bytes = 16u * 1024u * 1024u;
                        if (request.retain_alpha_coverage)
                            estimate.cost.prepared_cpu_bytes = 4u * 1024u * 1024u;
                    }
                } else if constexpr (std::is_same_v<T, HotspotMaskAssetRequest>) {
                    if (request.width != 0 && request.height != 0) {
                        estimate.cost.prepared_cpu_bytes =
                            saturating_multiply(request.width, request.height);
                        estimate.kind = PrefetchCostEstimateKind::Metadata;
                    } else {
                        estimate.cost.prepared_cpu_bytes = 1024u * 1024u;
                    }
                } else if constexpr (std::is_same_v<T, AudioAssetRequest>) {
                    if (const auto size = package_entry_size(request.path))
                        estimate.cost.source_bytes = *size;
                    if (request.mode == AudioLoadMode::Stream ||
                        request.kind == AudioClipKind::Music ||
                        request.kind == AudioClipKind::Ambience) {
                        estimate.cost.audio_bytes = 768'000;
                        estimate.kind = PrefetchCostEstimateKind::Metadata;
                    } else if (const auto size = package_entry_size(request.path)) {
                        estimate.cost.audio_bytes =
                            std::max<std::uint64_t>(1024u * 1024u, saturating_multiply(*size, 8));
                    } else {
                        estimate.cost.audio_bytes = 8u * 1024u * 1024u;
                    }
                } else if constexpr (std::is_same_v<T, FontAssetRequest>) {
                    estimate.cost.prepared_cpu_bytes = 2u * 1024u * 1024u;
                } else if constexpr (std::is_same_v<T, ShaderProgramAssetRequest>) {
                    estimate.cost.prepared_cpu_bytes = 512u * 1024u;
                    if (const auto vertex = package_entry_size(request.resolution.key.vertex_path))
                        estimate.cost.source_bytes = *vertex;
                    if (const auto fragment =
                            package_entry_size(request.resolution.key.fragment_path))
                        estimate.cost.source_bytes =
                            saturating_add(estimate.cost.source_bytes, *fragment);
                } else if constexpr (std::is_same_v<T, MaterialAssetRequest>) {
                    estimate.cost.prepared_cpu_bytes = 64u * 1024u;
                }
            },
            descriptor.request);
        return estimate;
    }

    void append_asset(DescriptorAccumulator& output, const core::AssetId& id,
                      core::compiled::AssetKind expected, core::Diagnostics& collection_diagnostics,
                      std::string_view context, bool retain_alpha_coverage = false) const
    {
        const auto* asset = find_asset(id);
        if (asset == nullptr) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_asset",
                           std::string(context) + " references missing asset '" + id.text() + "'");
            return;
        }
        if (asset->kind != expected) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_asset_kind_mismatch",
                           std::string(context) + " expects asset '" + id.text() +
                               "' to have the required typed kind");
            return;
        }
        if (expected == core::compiled::AssetKind::Image)
            output.add(texture_descriptor(*asset, source_generation, retain_alpha_coverage));
        else if (expected == core::compiled::AssetKind::Font)
            output.add(font_descriptor(*asset, source_generation));
    }

    void append_audio(DescriptorAccumulator& output, const core::AssetId& id,
                      core::compiled::AudioPurpose channel,
                      core::Diagnostics& collection_diagnostics, std::string_view context) const
    {
        const auto* asset = find_asset(id);
        if (asset == nullptr) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_audio",
                           std::string(context) + " references missing audio asset '" + id.text() +
                               "'");
            return;
        }
        if (asset->kind != core::compiled::AssetKind::Audio) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_audio_kind_mismatch",
                           std::string(context) + " references non-audio asset '" + id.text() +
                               "'");
            return;
        }
        output.add(audio_descriptor(*asset, channel, source_generation));
    }

    void append_material(DescriptorAccumulator& output, const core::MaterialId& id,
                         core::Diagnostics& collection_diagnostics, std::string_view context) const
    {
        const auto found = material_dependencies.find(id.text());
        if (found == material_dependencies.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_material",
                           std::string(context) + " references missing material '" + id.text() +
                               "'");
            return;
        }
        core::append_diagnostics(collection_diagnostics, found->second.diagnostics);
        output.add(found->second.descriptors);
    }

    void append_layout(DescriptorAccumulator& output, const core::LayoutId& id,
                       core::Diagnostics& collection_diagnostics, std::string_view context) const
    {
        // Built-in contextual Layouts are system-owned documents realized from system:/ assets.
        // They intentionally do not appear in the compiled project's Layout resource collection,
        // so they have no project dependency closure for structured prefetch to collect.
        if (is_builtin_runtime_layout(id))
            return;
        const auto found = layout_dependencies.find(id);
        if (found == layout_dependencies.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_layout",
                           std::string(context) + " references missing Layout '" + id.text() + "'");
            return;
        }
        core::append_diagnostics(collection_diagnostics, found->second.diagnostics);
        output.add(found->second.descriptors);
    }

    void append_background(DescriptorAccumulator& output,
                           const core::compiled::BackgroundPresentation& background,
                           core::Diagnostics& collection_diagnostics,
                           std::string_view context) const
    {
        if (background.asset)
            append_asset(output, *background.asset, core::compiled::AssetKind::Image,
                         collection_diagnostics, context);
        if (background.material)
            append_material(output, *background.material, collection_diagnostics, context);
    }

    void append_highlight_material(DescriptorAccumulator& output,
                                   const core::compiled::HotspotHighlight& highlight,
                                   core::Diagnostics& collection_diagnostics,
                                   std::string_view context) const
    {
        if (const auto* material =
                std::get_if<core::compiled::MaterialHotspotHighlight>(&highlight)) {
            append_material(output, material->material, collection_diagnostics, context);
        }
    }

    void append_room_hotspots(DescriptorAccumulator& output,
                              const core::compiled::RoomDefinition& room,
                              core::Diagnostics& collection_diagnostics) const
    {
        if (room.hotspots.empty() || !room.background.asset)
            return;
        bool requires_mask = false;
        HotspotMaskAssetRequest request{
            .owner = core::compiled::RoomHotspotOwnerRef{.room = room.identity.id}, .regions = {}};
        for (const auto& hotspot : room.hotspots) {
            requires_mask |=
                !std::holds_alternative<core::compiled::NoHotspotHighlight>(hotspot.highlight);
            request.regions.push_back({.hotspot = hotspot.id, .bounds = hotspot.shape.bounds});
            append_highlight_material(output, hotspot.highlight, collection_diagnostics,
                                      "Room hotspot highlight");
        }
        if (!requires_mask)
            return;
        const auto* image = find_asset(*room.background.asset);
        if (!image || !image->width || !image->height || *image->width > UINT16_MAX ||
            *image->height > UINT16_MAX) {
            add_diagnostic(collection_diagnostics, "assets.hotspot_mask.invalid_dimensions",
                           "Room hotspot mask source image has invalid dimensions");
            return;
        }
        request.width = static_cast<std::uint16_t>(*image->width);
        request.height = static_cast<std::uint16_t>(*image->height);
        output.add(hotspot_mask_descriptor(std::move(request), source_generation));
    }

    void append_interactable_hotspots(DescriptorAccumulator& output,
                                      const core::InteractableInstanceId& instance,
                                      const core::compiled::InteractableDefinition& interactable,
                                      core::Diagnostics& collection_diagnostics) const
    {
        const auto* custom = std::get_if<core::compiled::CustomInteractableHotspots>(
            &interactable.presentation.hotspots);
        if (!custom || custom->hotspots.empty() || !interactable.presentation.sprite)
            return;
        bool requires_mask = false;
        HotspotMaskAssetRequest request{
            .owner = core::compiled::InteractableHotspotOwnerRef{.interactable = instance},
            .regions = {}};
        for (const auto& hotspot : custom->hotspots) {
            requires_mask |=
                !std::holds_alternative<core::compiled::NoHotspotHighlight>(hotspot.highlight);
            request.regions.push_back({.hotspot = hotspot.id, .bounds = hotspot.shape.bounds});
            append_highlight_material(output, hotspot.highlight, collection_diagnostics,
                                      "Interactable hotspot highlight");
        }
        if (!requires_mask)
            return;
        const auto* image = find_asset(*interactable.presentation.sprite);
        if (!image || !image->width || !image->height || *image->width > UINT16_MAX ||
            *image->height > UINT16_MAX) {
            add_diagnostic(collection_diagnostics, "assets.hotspot_mask.invalid_dimensions",
                           "Interactable hotspot mask source image has invalid dimensions");
            return;
        }
        request.width = static_cast<std::uint16_t>(*image->width);
        request.height = static_cast<std::uint16_t>(*image->height);
        output.add(hotspot_mask_descriptor(std::move(request), source_generation));
    }

    void append_character(DescriptorAccumulator& output, const core::CharacterId& character_id,
                          std::optional<core::CharacterPresentationProfileId> requested_profile,
                          std::optional<core::CharacterPoseId> requested_pose,
                          std::optional<core::CharacterExpressionId> requested_expression,
                          std::optional<core::CharacterAppearanceId> requested_appearance,
                          core::Diagnostics& collection_diagnostics, std::string_view context) const
    {
        const auto found = characters.find(character_id);
        if (found == characters.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_character",
                           std::string(context) + " references missing character '" +
                               character_id.text() + "'");
            return;
        }
        const auto& character = *found->second;
        const core::CharacterPresentationProfileId profile_id =
            requested_profile.value_or(character.defaults.profile_id);
        const auto profile =
            std::find_if(character.profiles.begin(), character.profiles.end(),
                         [&](const auto& candidate) { return candidate.id == profile_id; });
        if (profile == character.profiles.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_profile",
                           std::string(context) + " references missing profile '" +
                               profile_id.text() + "' on character '" + character_id.text() + "'");
            return;
        }
        const core::CharacterExpressionId expression_id =
            requested_expression.value_or(character.defaults.expression_id);
        const auto expression =
            std::find_if(character.expressions.begin(), character.expressions.end(),
                         [&](const core::compiled::CharacterExpression& candidate) {
                             return candidate.id == expression_id;
                         });
        if (expression == character.expressions.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_expression",
                           std::string(context) + " references missing expression '" +
                               expression_id.text() + "' on character '" + character_id.text() +
                               "'");
            return;
        }
        const core::CharacterPoseId pose_id = requested_pose.value_or(profile->default_pose_id);
        const auto pose = std::find_if(profile->poses.begin(), profile->poses.end(),
                                       [&](const core::compiled::CharacterPose& candidate) {
                                           return candidate.id == pose_id;
                                       });
        if (pose == profile->poses.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_pose",
                           std::string(context) + " references missing pose '" + pose_id.text() +
                               "' on character '" + character_id.text() + "'");
            return;
        }
        const auto profile_overrides =
            [&](const auto& semantic) -> const core::compiled::CharacterProfileLayerOverrides* {
            const auto item = std::find_if(
                semantic.profiles.begin(), semantic.profiles.end(),
                [&](const auto& candidate) { return candidate.profile_id == profile_id; });
            return item == semantic.profiles.end() ? nullptr : &*item;
        };
        const auto default_expression = std::find_if(
            character.expressions.begin(), character.expressions.end(), [&](const auto& candidate) {
                return candidate.id == character.defaults.expression_id;
            });
        const auto* expression_overrides = profile_overrides(*expression);
        if (expression_overrides == nullptr && expression != default_expression &&
            default_expression != character.expressions.end())
            expression_overrides = profile_overrides(*default_expression);
        const core::compiled::CharacterProfileLayerOverrides* appearance_overrides = nullptr;
        const auto appearance_id =
            requested_appearance ? requested_appearance : character.defaults.appearance_id;
        if (appearance_id) {
            const auto appearance =
                std::find_if(character.appearances.begin(), character.appearances.end(),
                             [&](const auto& candidate) { return candidate.id == *appearance_id; });
            if (appearance != character.appearances.end())
                appearance_overrides = profile_overrides(*appearance);
        }
        for (const auto& layer_definition : profile->layers) {
            const auto layer =
                std::find_if(pose->layers.begin(), pose->layers.end(), [&](const auto& candidate) {
                    return candidate.layer_id == layer_definition.id;
                });
            if (layer == pose->layers.end())
                continue;
            auto sprite = layer->sprite;
            auto material = layer->material;
            bool visible = layer->visible;
            const auto apply =
                [&](const core::compiled::CharacterProfileLayerOverrides* overrides) {
                    if (overrides == nullptr)
                        return;
                    const auto patch =
                        std::find_if(overrides->layers.begin(), overrides->layers.end(),
                                     [&](const auto& candidate) {
                                         return candidate.layer_id == layer_definition.id;
                                     });
                    if (patch == overrides->layers.end())
                        return;
                    if (patch->sprite.specified)
                        sprite = patch->sprite.value;
                    if (patch->material.specified)
                        material = patch->material.value;
                    if (patch->visible)
                        visible = *patch->visible;
                };
            apply(expression_overrides);
            apply(appearance_overrides);
            if (!visible)
                continue;
            if (sprite)
                append_asset(output, *sprite, core::compiled::AssetKind::Image,
                             collection_diagnostics, context);
            if (material)
                append_material(output, *material, collection_diagnostics, context);
        }
        for (const auto& clip : profile->animation_clips) {
            for (const auto& frame : clip.frames) {
                for (const auto& layer : frame.layers) {
                    if (layer.sprite.specified && layer.sprite.value)
                        append_asset(output, *layer.sprite.value, core::compiled::AssetKind::Image,
                                     collection_diagnostics, context);
                    if (layer.material.specified && layer.material.value)
                        append_material(output, *layer.material.value, collection_diagnostics,
                                        context);
                }
            }
        }
        for (const auto& gesture : character.gestures) {
            const auto gesture_profile = std::find_if(
                gesture.profiles.begin(), gesture.profiles.end(),
                [&](const auto& candidate) { return candidate.profile_id == profile_id; });
            if (gesture_profile == gesture.profiles.end())
                continue;
            for (const auto& cue : gesture_profile->cues) {
                if (const auto* audio = std::get_if<core::compiled::CharacterAudioGestureCue>(&cue))
                    append_asset(output, audio->asset, core::compiled::AssetKind::Audio,
                                 collection_diagnostics, context);
            }
        }
    }

    void append_room(DescriptorAccumulator& output, const core::RoomId& id,
                     core::Diagnostics& collection_diagnostics) const
    {
        const auto found = rooms.find(id);
        if (found == rooms.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_room",
                           "prefetch target references missing Room '" + id.text() + "'");
            return;
        }
        const auto& room = *found->second;
        append_background(output, room.background, collection_diagnostics, "Room background");
        append_room_hotspots(output, room, collection_diagnostics);
        for (const auto& placement : room.placements) {
            if (placement.presentation.layout)
                append_layout(output, *placement.presentation.layout, collection_diagnostics,
                              "Room placement");
        }
        for (const auto& overlay : room.overlays)
            append_layout(output, overlay.layout, collection_diagnostics, "Room overlay");
        for (const auto& cast : room.cast) {
            append_character(output, cast.character, cast.profile_id, cast.pose_id,
                             cast.expression_id, cast.appearance_id, collection_diagnostics,
                             "Room cast");
        }
        for (const auto& prop : room.props) {
            if (prop.asset)
                append_asset(output, *prop.asset, core::compiled::AssetKind::Image,
                             collection_diagnostics, "Room prop");
            if (prop.material)
                append_material(output, *prop.material, collection_diagnostics, "Room prop");
        }
        for (const auto& environment : room.environments) {
            if (environment.asset)
                append_asset(output, *environment.asset, core::compiled::AssetKind::Image,
                             collection_diagnostics, "Room environment");
            append_material(output, environment.material, collection_diagnostics,
                            "Room environment");
        }
        if (const auto initial = initial_characters_by_room.find(id);
            initial != initial_characters_by_room.end()) {
            for (const auto* character : initial->second)
                append_character(output, character->identity.id, std::nullopt, std::nullopt,
                                 std::nullopt, std::nullopt, collection_diagnostics,
                                 "Room initial character");
        }
        if (const auto initial = initial_interactables_by_room.find(id);
            initial != initial_interactables_by_room.end()) {
            for (const auto& placed : initial->second) {
                const auto* interactable = placed.definition;
                if (interactable->presentation.sprite) {
                    const bool retain_alpha_coverage =
                        std::holds_alternative<core::compiled::SpriteAlphaHotspots>(
                            interactable->presentation.hotspots);
                    append_asset(output, *interactable->presentation.sprite,
                                 core::compiled::AssetKind::Image, collection_diagnostics,
                                 "Room initial interactable", retain_alpha_coverage);
                }
                if (interactable->presentation.material)
                    append_material(output, *interactable->presentation.material,
                                    collection_diagnostics, "Room initial interactable");
                append_interactable_hotspots(output, placed.instance, *interactable,
                                             collection_diagnostics);
            }
        }
    }
};

StructuredAssetDependencyIndex::StructuredAssetDependencyIndex(
    std::shared_ptr<const Impl> impl) noexcept
    : m_impl(std::move(impl))
{
}

StructuredAssetDependencyIndex
StructuredAssetDependencyIndex::build(const core::LoadedCompiledPackage& package,
                                      std::string_view active_renderer_variant,
                                      AssetSourceGeneration source_generation)
{
    auto impl = std::make_shared<Impl>();
    impl->package = &package;
    impl->source_generation = source_generation;
    impl->renderer_variant = active_renderer_variant;

    if (!source_generation.valid()) {
        add_diagnostic(impl->diagnostics, "assets.prefetch_invalid_source_generation",
                       "structured dependency indexes require a valid source generation",
                       core::ErrorSeverity::Error);
        impl->configuration_diagnostics.push_back(impl->diagnostics.back());
    }
    if (active_renderer_variant.empty()) {
        add_diagnostic(impl->diagnostics, "assets.prefetch_missing_renderer_variant",
                       "structured dependency indexes require the active renderer shader variant",
                       core::ErrorSeverity::Error);
        impl->configuration_diagnostics.push_back(impl->diagnostics.back());
    }

    const auto& project = package.project();
    for (const auto& entry : package.manifest().entries)
        impl->package_entry_sizes.emplace(entry.path, entry.size);
    for (const auto& asset : project.assets()) {
        const auto* registered = package.resources().find_asset(asset.id);
        if (registered != nullptr) {
            impl->assets.emplace(asset.id, registered);
            impl->assets_by_logical_path.emplace(logical_project_path(registered->path),
                                                 registered);
        } else {
            add_diagnostic(impl->diagnostics, "assets.prefetch_asset_registry_miss",
                           "prepared resource registry is missing asset '" + asset.id.text() + "'",
                           core::ErrorSeverity::Error);
        }
    }
    for (const auto& layout : project.layouts()) {
        const auto* registered = package.resources().find_layout(layout.id);
        if (registered != nullptr) {
            impl->layouts.emplace(layout.id, registered);
        } else {
            add_diagnostic(impl->diagnostics, "assets.prefetch_layout_registry_miss",
                           "prepared resource registry is missing Layout '" + layout.id.text() +
                               "'",
                           core::ErrorSeverity::Error);
        }
    }
    for (const auto& character : project.characters()) {
        impl->characters.emplace(character.identity.id, &character);
        if (const auto* location = std::get_if<core::compiled::RoomLocation>(
                &character.initial_world_state.location)) {
            impl->initial_characters_by_room[location->room].push_back(&character);
        }
    }
    for (const auto& room : project.rooms())
        impl->rooms.emplace(room.identity.id, &room);
    for (const auto& instance : project.interactable_instances()) {
        const auto* definition = project.find_interactable_definition(instance.definition);
        if (definition == nullptr)
            continue;
        impl->interactables.emplace(instance.id, definition);
        if (const auto* location = std::get_if<core::compiled::RoomLocation>(&instance.location))
            impl->initial_interactables_by_room[location->room].push_back(
                Impl::InitialInteractable{instance.id, definition});
    }

    if (package.shader_materials()) {
        for (const auto& material : package.shader_materials()->materials) {
            auto material_id = core::MaterialId::create(material.id.string());
            if (!material_id) {
                add_diagnostic(impl->diagnostics, "assets.prefetch_invalid_material_id",
                               "prepared material has invalid domain ID '" + material.id.string() +
                                   "'",
                               core::ErrorSeverity::Error);
                continue;
            }
            const auto* registered = package.resources().find_material(*material_id.value_if());
            if (registered == nullptr) {
                add_diagnostic(impl->diagnostics, "assets.prefetch_material_registry_miss",
                               "prepared resource registry is missing material '" +
                                   material.id.string() + "'",
                               core::ErrorSeverity::Error);
                continue;
            }
            DescriptorAccumulator dependencies;
            core::Diagnostics material_diagnostics;
            MaterialAssetRequest material_request{.id = registered->id.string()};
            dependencies.add(
                {.request = material_request,
                 .cache_key = make_material_cache_key(material_request, source_generation)});

            const auto resolution = resolve_material_shader_program(
                *package.shader_materials(), registered->id, active_renderer_variant);
            if (resolution.program) {
                ShaderProgramAssetRequest shader_request{.resolution = *resolution.program};
                dependencies.add({.request = shader_request,
                                  .cache_key = make_shader_program_cache_key(shader_request,
                                                                             source_generation)});
            } else {
                add_diagnostic(material_diagnostics, "assets.prefetch_shader_resolution_failed",
                               "material '" + registered->id.string() +
                                   "' could not resolve a shader program for renderer variant '" +
                                   std::string(active_renderer_variant) + "'");
            }

            for (const auto& assignment : registered->textures) {
                if (!static_package_texture(assignment.source))
                    continue;
                dependencies.add(
                    texture_descriptor(assignment.source, assignment.filtering, source_generation));
            }
            impl->material_dependencies.emplace(
                registered->id.string(),
                Impl::MaterialDependencies{.descriptors = dependencies.take(),
                                           .diagnostics = std::move(material_diagnostics)});
        }
    }

    for (const auto& layout : project.layouts()) {
        DescriptorAccumulator dependencies;
        core::Diagnostics layout_diagnostics;
        if (package.resources().find_layout(layout.id) == nullptr) {
            add_diagnostic(layout_diagnostics, "assets.prefetch_layout_registry_miss",
                           "prepared resource registry is missing Layout '" + layout.id.text() +
                               "'",
                           core::ErrorSeverity::Error);
        }
        for (const auto& font : layout.dependencies.fonts)
            impl->append_asset(dependencies, font, core::compiled::AssetKind::Font,
                               layout_diagnostics, "Layout font dependency");
        for (const auto& image : layout.dependencies.images)
            impl->append_asset(dependencies, image, core::compiled::AssetKind::Image,
                               layout_diagnostics, "Layout image dependency");
        for (const auto& material : layout.dependencies.materials)
            impl->append_material(dependencies, material, layout_diagnostics,
                                  "Layout material dependency");
        impl->layout_dependencies.emplace(
            layout.id, Impl::LayoutDependencies{.descriptors = dependencies.take(),
                                                .diagnostics = std::move(layout_diagnostics)});
    }

    return StructuredAssetDependencyIndex(std::move(impl));
}

AssetSourceGeneration StructuredAssetDependencyIndex::source_generation() const noexcept
{
    return m_impl->source_generation;
}

const core::Diagnostics& StructuredAssetDependencyIndex::diagnostics() const noexcept
{
    return m_impl->diagnostics;
}

MandatoryAssetDependencyCollector::MandatoryAssetDependencyCollector(
    StructuredAssetDependencyIndex index) noexcept
    : m_index(std::move(index))
{
}

MandatoryAssetDependencyClosure
MandatoryAssetDependencyCollector::collect(const MandatoryAssetDependencyContext& context) const
{
    MandatoryAssetDependencyClosure result;
    result.diagnostics = m_index.m_impl->configuration_diagnostics;
    std::map<CacheIdentity, SeenDescriptorState> seen;
    core::Diagnostics current_diagnostics;

    DescriptorAccumulator current(&seen);
    if (const auto* snapshot = context.current_presentation) {
        if (snapshot->background) {
            core::compiled::BackgroundPresentation background{.asset = snapshot->background->asset,
                                                              .color = snapshot->background->color,
                                                              .fit = snapshot->background->fit,
                                                              .material =
                                                                  snapshot->background->material};
            m_index.m_impl->append_background(current, background, current_diagnostics,
                                              "current presentation background");
        }
        for (const auto& actor : snapshot->actors) {
            if (!actor.enabled || !actor.visible)
                continue;
            for (const auto& layer : actor.layers) {
                if (!layer.visible)
                    continue;
                if (layer.sprite)
                    m_index.m_impl->append_asset(current, *layer.sprite,
                                                 core::compiled::AssetKind::Image,
                                                 current_diagnostics, "current actor layer");
                if (layer.material)
                    m_index.m_impl->append_material(current, *layer.material, current_diagnostics,
                                                    "current actor layer");
            }
        }
        for (const auto& interactable : snapshot->interactables) {
            if (!interactable.enabled || !interactable.visible)
                continue;
            const auto definition = m_index.m_impl->interactables.find(interactable.interactable);
            const bool retain_alpha_coverage =
                definition != m_index.m_impl->interactables.end() &&
                std::holds_alternative<core::compiled::SpriteAlphaHotspots>(
                    definition->second->presentation.hotspots);
            if (interactable.sprite)
                m_index.m_impl->append_asset(current, *interactable.sprite,
                                             core::compiled::AssetKind::Image, current_diagnostics,
                                             "current interactable", retain_alpha_coverage);
            if (interactable.material)
                m_index.m_impl->append_material(current, *interactable.material,
                                                current_diagnostics, "current interactable");
            if (definition != m_index.m_impl->interactables.end()) {
                m_index.m_impl->append_interactable_hotspots(
                    current, interactable.interactable, *definition->second, current_diagnostics);
            }
        }
        if (snapshot->current_room) {
            if (const auto room = m_index.m_impl->rooms.find(*snapshot->current_room);
                room != m_index.m_impl->rooms.end()) {
                m_index.m_impl->append_room_hotspots(current, *room->second, current_diagnostics);
            }
        }
        for (const auto& prop : snapshot->props) {
            if (!prop.visible)
                continue;
            if (prop.asset)
                m_index.m_impl->append_asset(current, *prop.asset, core::compiled::AssetKind::Image,
                                             current_diagnostics, "current prop");
            if (prop.material)
                m_index.m_impl->append_material(current, *prop.material, current_diagnostics,
                                                "current prop");
        }
        for (const auto& environment : snapshot->environments) {
            if (!environment.visible)
                continue;
            if (environment.asset)
                m_index.m_impl->append_asset(current, *environment.asset,
                                             core::compiled::AssetKind::Image, current_diagnostics,
                                             "current environment");
            m_index.m_impl->append_material(current, environment.material, current_diagnostics,
                                            "current environment");
        }
        for (const auto& layout : snapshot->layouts)
            m_index.m_impl->append_layout(current, layout.layout, current_diagnostics,
                                          "current mounted Layout");
        for (const auto& effect : snapshot->postprocess_effects) {
            if (!effect.visible)
                continue;
            m_index.m_impl->append_material(current, effect.material, current_diagnostics,
                                            "current postprocess effect");
        }
        for (const auto& audio : snapshot->desired_audio)
            m_index.m_impl->append_audio(current, audio.asset, audio.purpose, current_diagnostics,
                                         "current desired audio");
    }
    for (const auto role : context.required_system_layouts) {
        const auto found = std::find_if(
            m_index.m_impl->package->project().settings().system_layouts.begin(),
            m_index.m_impl->package->project().settings().system_layouts.end(),
            [&](const core::compiled::SystemLayout& candidate) { return candidate.role == role; });
        if (found != m_index.m_impl->package->project().settings().system_layouts.end() &&
            found->layout) {
            m_index.m_impl->append_layout(current, *found->layout, current_diagnostics,
                                          "required system Layout");
        }
    }
    result.requests = current.take();
    core::append_diagnostics(result.diagnostics, std::move(current_diagnostics));
    return result;
}

PrefetchPlan resolve_flow_prediction(const StructuredAssetDependencyIndex& index,
                                     const runtime::FlowPredictionProjection& projection)
{
    PrefetchPlan plan;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    plan.opaque_frontiers = projection.opaque_frontiers;
#endif
    plan.diagnostics = projection.diagnostics;
    std::map<CacheIdentity, SeenDescriptorState> seen;
    auto append_descriptor = [&](StructuredAssetRequestDescriptor descriptor,
                                 const runtime::FlowPredictionProjectionEntry& projected) {
        const auto incoming_prediction =
            projected.confidence == runtime::FlowPredictionConfidence::Expected
                ? PrefetchPredictionKind::ExpectedNext
                : PrefetchPredictionKind::PossibleNext;
        const auto identity = identity_of(descriptor.cache_key);
        const bool retain_alpha_coverage = descriptor_retain_alpha_coverage(descriptor);
        const auto [existing, inserted] = seen.try_emplace(
            identity, SeenDescriptorState{.retain_alpha_coverage = retain_alpha_coverage});
        if (inserted && plan.candidates.size() >= prefetch_plan_structural_ceiling) {
            seen.erase(identity);
            plan.structural_limit_reached = true;
            return;
        }
        if (!inserted) {
            existing->second.retain_alpha_coverage |= retain_alpha_coverage;
            const auto candidate = std::find_if(
                plan.candidates.begin(), plan.candidates.end(), [&](const auto& value) {
                    return identity_of(value.descriptor.cache_key) == identity;
                });
            if (candidate != plan.candidates.end()) {
                const auto rank = [](std::size_t distance, PrefetchPredictionKind prediction,
                                     std::size_t order, std::size_t priority) {
                    return std::tuple{
                        distance, prediction == PrefetchPredictionKind::ExpectedNext ? 0u : 1u,
                        prediction == PrefetchPredictionKind::ExpectedNext ? order : 0u, priority};
                };
                if (rank(projected.execution_distance, incoming_prediction,
                         projected.execution_order, projected.dependency_priority) <
                    rank(candidate->execution_distance, candidate->prediction,
                         candidate->execution_order, candidate->dependency_priority)) {
                    candidate->prediction = incoming_prediction;
                    candidate->execution_distance = projected.execution_distance;
                    candidate->execution_order = projected.execution_order;
                    candidate->dependency_priority = projected.dependency_priority;
                }
                if (retain_alpha_coverage) {
                    if (auto* texture =
                            std::get_if<TextureAssetRequest>(&candidate->descriptor.request))
                        texture->retain_alpha_coverage = true;
                }
                if (std::find(candidate->provenance.begin(), candidate->provenance.end(),
                              projected.provenance) == candidate->provenance.end())
                    candidate->provenance.push_back(projected.provenance);
                const auto estimated = index.m_impl->estimate_cost(candidate->descriptor);
                candidate->estimated_cost = estimated.cost;
                candidate->cost_estimate = estimated.kind;
            }
            return;
        }
        const auto estimated = index.m_impl->estimate_cost(descriptor);
        plan.candidates.push_back({.descriptor = std::move(descriptor),
                                   .prediction = incoming_prediction,
                                   .execution_distance = projected.execution_distance,
                                   .execution_order = projected.execution_order,
                                   .dependency_priority = projected.dependency_priority,
                                   .estimated_cost = estimated.cost,
                                   .cost_estimate = estimated.kind,
                                   .provenance = {projected.provenance}});
    };

    for (const auto& projected : projection.entries) {
        if (plan.structural_limit_reached)
            break;
        DescriptorAccumulator semantic_descriptors;
        core::Diagnostics semantic_diagnostics;
        if (const auto* character_dependency =
                std::get_if<core::compiled::FlowPredictionCharacterDependency>(
                    &projected.dependency)) {
            index.m_impl->append_character(
                semantic_descriptors, character_dependency->character,
                character_dependency->profile_id, character_dependency->pose_id,
                character_dependency->expression_id, character_dependency->appearance_id,
                semantic_diagnostics, "Flow Prediction Character");
            core::append_diagnostics(plan.diagnostics, std::move(semantic_diagnostics));
            for (auto& descriptor : semantic_descriptors.take())
                append_descriptor(std::move(descriptor), projected);
            continue;
        }
        if (const auto* layout_dependency =
                std::get_if<core::compiled::FlowPredictionLayoutDependency>(
                    &projected.dependency)) {
            index.m_impl->append_layout(semantic_descriptors, layout_dependency->layout,
                                        semantic_diagnostics, "Flow Prediction Layout");
            core::append_diagnostics(plan.diagnostics, std::move(semantic_diagnostics));
            for (auto& descriptor : semantic_descriptors.take())
                append_descriptor(std::move(descriptor), projected);
            continue;
        }
        if (const auto* material_dependency =
                std::get_if<core::compiled::FlowPredictionMaterialDependency>(
                    &projected.dependency)) {
            index.m_impl->append_material(semantic_descriptors, material_dependency->material,
                                          semantic_diagnostics, "Flow Prediction Material");
            core::append_diagnostics(plan.diagnostics, std::move(semantic_diagnostics));
            for (auto& descriptor : semantic_descriptors.take())
                append_descriptor(std::move(descriptor), projected);
            continue;
        }
        if (const auto* room_dependency =
                std::get_if<core::compiled::FlowPredictionRoomDependency>(&projected.dependency)) {
            DescriptorAccumulator room_descriptors;
            core::Diagnostics room_diagnostics;
            index.m_impl->append_room(room_descriptors, room_dependency->room, room_diagnostics);
            core::append_diagnostics(plan.diagnostics, std::move(room_diagnostics));
            for (auto& descriptor : room_descriptors.take())
                append_descriptor(std::move(descriptor), projected);
            continue;
        }
        if (const auto* audio_dependency =
                std::get_if<core::compiled::FlowPredictionAudioDependency>(&projected.dependency)) {
            index.m_impl->append_audio(semantic_descriptors, audio_dependency->asset,
                                       audio_dependency->purpose, semantic_diagnostics,
                                       "Flow Prediction Audio");
            core::append_diagnostics(plan.diagnostics, std::move(semantic_diagnostics));
            for (auto& descriptor : semantic_descriptors.take())
                append_descriptor(std::move(descriptor), projected);
            continue;
        }

        const auto* asset_dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&projected.dependency);
        if (!asset_dependency)
            continue;
        const auto* asset = index.m_impl->find_asset(asset_dependency->asset);
        if (!asset) {
            add_diagnostic(plan.diagnostics, "assets.flow_prediction_missing_asset",
                           "Flow Prediction dependency references missing Asset '" +
                               asset_dependency->asset.text() + "'");
            continue;
        }

        std::optional<StructuredAssetRequestDescriptor> descriptor;
        if (asset->kind == core::compiled::AssetKind::Image)
            descriptor = texture_descriptor(*asset, index.m_impl->source_generation);
        else if (asset->kind == core::compiled::AssetKind::Font)
            descriptor = font_descriptor(*asset, index.m_impl->source_generation);
        else {
            add_diagnostic(plan.diagnostics, "assets.flow_prediction_unsupported_asset_kind",
                           "Flow Prediction Asset '" + asset_dependency->asset.text() +
                               "' does not yet have a tracer-bullet request mapping",
                           core::ErrorSeverity::Info);
            continue;
        }

        append_descriptor(std::move(*descriptor), projected);
    }
    return plan;
}

struct PrefetchPlanner::Impl {
    explicit Impl(AssetManager& manager) : assets(&manager) {}

    struct Interest {
        PrefetchCandidate candidate;
        PrefetchTicket ticket;
    };

    AssetManager* assets;
    std::optional<PrefetchGenerationId> generation;
    std::vector<Interest> plan_interests;
};

namespace {

[[nodiscard]] AssetCacheKey descriptor_cache_key(const StructuredAssetRequest& request,
                                                 AssetSourceGeneration generation)
{
    return std::visit(
        [&](const auto& value) -> AssetCacheKey {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, FontAssetRequest>)
                return make_font_cache_key(value, generation);
            else if constexpr (std::is_same_v<T, TextureAssetRequest>)
                return make_texture_cache_key(value, generation);
            else if constexpr (std::is_same_v<T, HotspotMaskAssetRequest>)
                return make_hotspot_mask_cache_key(value, generation);
            else if constexpr (std::is_same_v<T, ShaderProgramAssetRequest>)
                return make_shader_program_cache_key(value, generation);
            else if constexpr (std::is_same_v<T, MaterialAssetRequest>)
                return make_material_cache_key(value, generation);
            else
                return make_audio_cache_key(value, generation);
        },
        request);
}

[[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
dispatch_prefetch(AssetManager& assets, const StructuredAssetRequest& request,
                  PrefetchGenerationId generation) noexcept
{
    return std::visit(
        [&](const auto& value) -> core::Result<PrefetchTicket, core::Diagnostic> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, FontAssetRequest>)
                return assets.prefetch_font(value, generation);
            else if constexpr (std::is_same_v<T, TextureAssetRequest>)
                return assets.prefetch_texture(value, generation);
            else if constexpr (std::is_same_v<T, HotspotMaskAssetRequest>)
                return assets.prefetch_hotspot_mask(value, generation);
            else if constexpr (std::is_same_v<T, ShaderProgramAssetRequest>)
                return assets.prefetch_shader_program(value, generation);
            else if constexpr (std::is_same_v<T, MaterialAssetRequest>)
                return assets.prefetch_material(value, generation);
            else
                return assets.prefetch_audio(value, generation);
        },
        request);
}

[[nodiscard]] unsigned prediction_rank(PrefetchPredictionKind prediction) noexcept
{
    return prediction == PrefetchPredictionKind::ExpectedNext ? 0u : 1u;
}

[[nodiscard]] std::size_t execution_order_rank(const PrefetchCandidate& candidate) noexcept
{
    // Alternative branches at the same semantic distance are peers. Their traversal order is an
    // implementation detail and must not turn authored/DFS branch order into a prediction score.
    return candidate.prediction == PrefetchPredictionKind::ExpectedNext ? candidate.execution_order
                                                                        : 0u;
}

[[nodiscard]] std::uint64_t planning_cost_score(const ResidencyCost& cost) noexcept
{
    return saturating_add(saturating_add(cost.prepared_cpu_bytes, cost.gpu_bytes),
                          cost.audio_bytes);
}

[[nodiscard]] bool candidate_rank_less(const PrefetchCandidate& left,
                                       const PrefetchCandidate& right) noexcept
{
    return std::tuple{left.execution_distance,
                      prediction_rank(left.prediction),
                      execution_order_rank(left),
                      left.dependency_priority,
                      planning_cost_score(left.estimated_cost),
                      left.descriptor.cache_key.stable_identity} <
           std::tuple{right.execution_distance,
                      prediction_rank(right.prediction),
                      execution_order_rank(right),
                      right.dependency_priority,
                      planning_cost_score(right.estimated_cost),
                      right.descriptor.cache_key.stable_identity};
}

void add_planning_cost(ResidencyCost& current, const ResidencyCost& added) noexcept
{
    current.source_bytes = saturating_add(current.source_bytes, added.source_bytes);
    current.prepared_cpu_bytes =
        saturating_add(current.prepared_cpu_bytes, added.prepared_cpu_bytes);
    current.gpu_bytes = saturating_add(current.gpu_bytes, added.gpu_bytes);
    current.audio_bytes = saturating_add(current.audio_bytes, added.audio_bytes);
    current.temporary_bytes = saturating_add(current.temporary_bytes, added.temporary_bytes);
}

[[nodiscard]] ResidencyCost positive_cost_difference(const ResidencyCost& newer,
                                                     const ResidencyCost& older) noexcept
{
    const auto difference = [](std::uint64_t next, std::uint64_t previous) {
        return next > previous ? next - previous : 0;
    };
    return {.source_bytes = difference(newer.source_bytes, older.source_bytes),
            .prepared_cpu_bytes = difference(newer.prepared_cpu_bytes, older.prepared_cpu_bytes),
            .gpu_bytes = difference(newer.gpu_bytes, older.gpu_bytes),
            .audio_bytes = difference(newer.audio_bytes, older.audio_bytes),
            .temporary_bytes = difference(newer.temporary_bytes, older.temporary_bytes)};
}

void merge_cost_upper_bound(ResidencyCost& target, const ResidencyCost& value) noexcept
{
    target.source_bytes = std::max(target.source_bytes, value.source_bytes);
    target.prepared_cpu_bytes = std::max(target.prepared_cpu_bytes, value.prepared_cpu_bytes);
    target.gpu_bytes = std::max(target.gpu_bytes, value.gpu_bytes);
    target.audio_bytes = std::max(target.audio_bytes, value.audio_bytes);
    target.temporary_bytes = std::max(target.temporary_bytes, value.temporary_bytes);
}

[[nodiscard]] bool descriptor_satisfies(const StructuredAssetRequestDescriptor& retained,
                                        const StructuredAssetRequestDescriptor& requested) noexcept
{
    if (retained.cache_key != requested.cache_key)
        return false;
    const auto* retained_texture = std::get_if<TextureAssetRequest>(&retained.request);
    const auto* requested_texture = std::get_if<TextureAssetRequest>(&requested.request);
    if (retained_texture != nullptr && requested_texture != nullptr)
        return !requested_texture->retain_alpha_coverage || retained_texture->retain_alpha_coverage;
    return retained.request.index() == requested.request.index();
}

void merge_descriptor_capability(StructuredAssetRequestDescriptor& target,
                                 const StructuredAssetRequestDescriptor& source) noexcept
{
    auto* target_texture = std::get_if<TextureAssetRequest>(&target.request);
    const auto* source_texture = std::get_if<TextureAssetRequest>(&source.request);
    if (target_texture != nullptr && source_texture != nullptr)
        target_texture->retain_alpha_coverage |= source_texture->retain_alpha_coverage;
}

struct NormalizedPlan {
    std::vector<PrefetchCandidate> candidates;
    bool structural_limit_reached = false;
};

[[nodiscard]] NormalizedPlan normalize_plan(const PrefetchPlan& plan)
{
    NormalizedPlan result;
    std::map<CacheIdentity, std::size_t> positions;
    for (const auto& candidate : plan.candidates) {
        const auto identity = identity_of(candidate.descriptor.cache_key);
        const auto [found, inserted] = positions.try_emplace(identity, result.candidates.size());
        if (inserted) {
            if (result.candidates.size() >= prefetch_plan_structural_ceiling) {
                positions.erase(found);
                result.structural_limit_reached = true;
                break;
            }
            result.candidates.push_back(candidate);
            continue;
        }

        auto& current = result.candidates[found->second];
        const bool incoming_better = candidate_rank_less(candidate, current);
        merge_descriptor_capability(current.descriptor, candidate.descriptor);
        if (incoming_better) {
            current.prediction = candidate.prediction;
            current.execution_distance = candidate.execution_distance;
            current.execution_order = candidate.execution_order;
            current.dependency_priority = candidate.dependency_priority;
        }
        merge_cost_upper_bound(current.estimated_cost, candidate.estimated_cost);
        if (candidate.cost_estimate == PrefetchCostEstimateKind::Conservative)
            current.cost_estimate = PrefetchCostEstimateKind::Conservative;
        for (const auto& provenance : candidate.provenance) {
            if (std::find(current.provenance.begin(), current.provenance.end(), provenance) ==
                current.provenance.end())
                current.provenance.push_back(provenance);
        }
    }
    std::stable_sort(result.candidates.begin(), result.candidates.end(), candidate_rank_less);
    return result;
}

} // namespace

PrefetchPlanner::PrefetchPlanner(AssetManager& assets) noexcept
    : m_impl(std::make_unique<Impl>(assets))
{
}

PrefetchPlanner::~PrefetchPlanner() = default;
PrefetchPlanner::PrefetchPlanner(PrefetchPlanner&&) noexcept = default;
PrefetchPlanner& PrefetchPlanner::operator=(PrefetchPlanner&&) noexcept = default;

core::Result<PrefetchSubmissionReport, core::Diagnostic>
PrefetchPlanner::replace_generation_on_owner(const PrefetchPlan& plan) noexcept
{
    auto allocated = m_impl->assets->create_prefetch_generation_on_owner();
    if (!allocated)
        return core::Result<PrefetchSubmissionReport, core::Diagnostic>::failure(allocated.error());

    PrefetchSubmissionReport report;
    report.generation = *allocated.value_if();
    auto normalized = normalize_plan(plan);
    auto& candidates = normalized.candidates;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    report.ranked_candidates = candidates;
    report.opaque_frontiers = plan.opaque_frontiers;
#endif
    for (const auto& candidate : candidates) {
        if (candidate.prediction == PrefetchPredictionKind::ExpectedNext)
            ++report.expected_count;
        else
            ++report.possible_count;
    }

    std::map<CacheIdentity, std::size_t> previous_by_identity;
    for (std::size_t index = 0; index < m_impl->plan_interests.size(); ++index)
        previous_by_identity.emplace(
            identity_of(m_impl->plan_interests[index].candidate.descriptor.cache_key), index);

    const auto residency = m_impl->assets->prefetch_planning_residency_on_owner();
    ResidencyCost planned_warm = residency.warm;
    for (const auto& interest : m_impl->plan_interests) {
        if (m_impl->assets->prefetch_residency_class_on_owner(
                interest.candidate.descriptor.cache_key) != ResidencyClass::Warm)
            add_planning_cost(planned_warm, interest.candidate.estimated_cost);
    }

    std::vector<Impl::Interest> next_interests;
    next_interests.reserve(std::min(candidates.size(), prefetch_plan_structural_ceiling));

    const auto previous_for = [&](const PrefetchCandidate& candidate) -> Impl::Interest* {
        const auto found = previous_by_identity.find(identity_of(candidate.descriptor.cache_key));
        if (found == previous_by_identity.end())
            return nullptr;
        return &m_impl->plan_interests[found->second];
    };

    const auto additional_cost = [&](const PrefetchCandidate& candidate) {
        const auto classification =
            m_impl->assets->prefetch_residency_class_on_owner(candidate.descriptor.cache_key);
        if (auto* previous = previous_for(candidate))
            return positive_cost_difference(candidate.estimated_cost,
                                            previous->candidate.estimated_cost);
        if (classification == ResidencyClass::Warm)
            return ResidencyCost{};
        return candidate.estimated_cost;
    };

    const auto remaining_plausibly_fits = [&](std::size_t start) {
        const std::size_t end = std::min(candidates.size(), prefetch_plan_structural_ceiling);
        for (std::size_t index = start; index < end; ++index) {
            const auto& candidate = candidates[index];
            if (auto* previous = previous_for(candidate);
                previous != nullptr &&
                descriptor_satisfies(previous->candidate.descriptor, candidate.descriptor))
                return true;
            if (prefetch_fits_warm_budget(planned_warm, additional_cost(candidate),
                                          residency.policy.budget))
                return true;
        }
        return false;
    };

    const std::size_t candidate_limit = candidates.size();
    report.structural_limit_reached =
        plan.structural_limit_reached || normalized.structural_limit_reached;
    for (std::size_t candidate_index = 0; candidate_index < candidate_limit; ++candidate_index) {
        auto candidate = candidates[candidate_index];
        const auto& descriptor = candidate.descriptor;

        const AssetSourceGeneration current_generation =
            m_impl->assets->source_generation_on_owner();
        if (descriptor.cache_key.source_generation != current_generation) {
            report.failures.push_back(
                {.cache_key = descriptor.cache_key,
                 .prediction = candidate.prediction,
                 .diagnostic = {.code = "assets.prefetch_stale_descriptor",
                                .message = "prefetch descriptor source generation is stale"}});
            continue;
        }
        const AssetCacheKey expected = descriptor_cache_key(descriptor.request, current_generation);
        if (expected != descriptor.cache_key) {
            report.failures.push_back(
                {.cache_key = descriptor.cache_key,
                 .prediction = candidate.prediction,
                 .diagnostic = {
                     .code = "assets.prefetch_descriptor_key_mismatch",
                     .message = "typed prefetch descriptor does not match its derived cache key"}});
            continue;
        }

        if (auto* previous = previous_for(candidate);
            previous != nullptr &&
            descriptor_satisfies(previous->candidate.descriptor, candidate.descriptor) &&
            previous->ticket.replace_generation_on_owner(report.generation)) {
            merge_descriptor_capability(candidate.descriptor, previous->candidate.descriptor);
            merge_cost_upper_bound(candidate.estimated_cost, previous->candidate.estimated_cost);
            const auto retained_entry =
                PrefetchSubmissionEntry{.cache_key = candidate.descriptor.cache_key,
                                        .prediction = candidate.prediction,
                                        .provenance = candidate.provenance};
            next_interests.push_back(
                {.candidate = std::move(candidate), .ticket = std::move(previous->ticket)});
            report.retained_entries.push_back(retained_entry);
            if (retained_entry.prediction == PrefetchPredictionKind::ExpectedNext)
                ++report.expected_retained;
            else
                ++report.possible_retained;
            continue;
        }

        const auto added_cost = additional_cost(candidate);
        if (!prefetch_fits_warm_budget(planned_warm, added_cost, residency.policy.budget)) {
            report.admission_rejections.push_back(
                {.cache_key = descriptor.cache_key,
                 .prediction = candidate.prediction,
                 .estimated_cost = candidate.estimated_cost,
                 .provenance = candidate.provenance,
                 .diagnostic = {.code = "assets.prefetch_plan_warm_budget",
                                .message = "ranked prefetch candidate does not fit the configured "
                                           "Warm residency allowance",
                                .severity = core::ErrorSeverity::Warning}});
            if (!remaining_plausibly_fits(candidate_index + 1)) {
                report.budget_exhausted = true;
                break;
            }
            continue;
        }

        auto submitted = dispatch_prefetch(*m_impl->assets, descriptor.request, report.generation);
        if (!submitted) {
            report.failures.push_back({.cache_key = descriptor.cache_key,
                                       .prediction = candidate.prediction,
                                       .diagnostic = submitted.error()});
            continue;
        }
        add_planning_cost(planned_warm, added_cost);
        next_interests.push_back(
            {.candidate = candidate, .ticket = std::move(*submitted.value_if())});
        report.submitted_entries.push_back({.cache_key = descriptor.cache_key,
                                            .prediction = candidate.prediction,
                                            .provenance = candidate.provenance});
        report.submitted_keys.push_back(descriptor.cache_key);
        if (candidate.prediction == PrefetchPredictionKind::ExpectedNext)
            ++report.expected_submitted;
        else
            ++report.possible_submitted;
    }

    m_impl->generation = report.generation;
    // All newly admitted interests are attached before obsolete Flow interests are released.
    // Equivalent interests above retain their original ticket while the logical generation
    // advances for observability.
    m_impl->plan_interests = std::move(next_interests);
    return core::Result<PrefetchSubmissionReport, core::Diagnostic>::success(std::move(report));
}

void PrefetchPlanner::clear_on_owner() noexcept
{
    m_impl->plan_interests.clear();
    m_impl->generation.reset();
}

std::optional<PrefetchGenerationId> PrefetchPlanner::active_generation_on_owner() const noexcept
{
    return m_impl->generation;
}

std::size_t PrefetchPlanner::retained_ticket_count_on_owner() const noexcept
{
    return m_impl->plan_interests.size();
}

} // namespace noveltea::assets
