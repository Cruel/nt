#include "noveltea/assets/structured_prefetch.hpp"

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace noveltea::assets {
namespace {

using DependencyDescriptorList = std::vector<StructuredAssetRequestDescriptor>;
using CacheIdentity = std::pair<std::string, std::uint64_t>;

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

[[nodiscard]] std::string target_identity(const core::compiled::Entrypoint& target)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::RoomId>)
                return "room:" + value.text();
            else if constexpr (std::is_same_v<T, core::SceneId>)
                return "scene:" + value.text();
            else
                return "dialogue:" + value.text();
        },
        target);
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

    std::unordered_map<core::AssetId, const core::compiled::AssetResource*> assets;
    std::unordered_map<core::LayoutId, const core::compiled::LayoutResource*> layouts;
    std::unordered_map<core::CharacterId, const core::compiled::CharacterDefinition*> characters;
    std::unordered_map<core::RoomId, const core::compiled::RoomDefinition*> rooms;
    std::unordered_map<core::InteractableInstanceId, const core::compiled::InteractableDefinition*>
        interactables;
    std::unordered_map<core::SceneId, const core::compiled::SceneDefinition*> scenes;
    std::unordered_map<core::DialogueId, const core::compiled::DialogueDefinition*> dialogues;
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

    void append_flow_target(DescriptorAccumulator& output, const core::FlowTarget& target,
                            core::Diagnostics& collection_diagnostics,
                            std::unordered_set<std::string>& traversal) const
    {
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::RoomId> || std::is_same_v<T, core::SceneId> ||
                              std::is_same_v<T, core::DialogueId>) {
                    append_target(output, core::compiled::Entrypoint{value}, collection_diagnostics,
                                  traversal);
                }
            },
            target);
    }

    void append_room(DescriptorAccumulator& output, const core::RoomId& id,
                     core::Diagnostics& collection_diagnostics,
                     std::unordered_set<std::string>& traversal) const
    {
        (void)traversal;
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

    void append_scene(DescriptorAccumulator& output, const core::SceneId& id,
                      core::Diagnostics& collection_diagnostics,
                      std::unordered_set<std::string>& traversal) const
    {
        const auto found = scenes.find(id);
        if (found == scenes.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_scene",
                           "prefetch target references missing Scene '" + id.text() + "'");
            return;
        }
        const auto& scene = *found->second;
        std::visit(
            [&](const auto& stage) {
                using Stage = std::decay_t<decltype(stage)>;
                if constexpr (std::is_same_v<Stage, core::compiled::StagedRoomSceneStage>) {
                    append_room(output, stage.room, collection_diagnostics, traversal);
                } else if constexpr (std::is_same_v<Stage, core::compiled::BlankSceneStage>) {
                    append_background(output, stage.background, collection_diagnostics,
                                      "Scene blank Stage background");
                    if (stage.layout)
                        append_layout(output, *stage.layout, collection_diagnostics,
                                      "Scene blank Stage Layout");
                }
            },
            scene.stage);

        for (const auto& instruction : scene.program.instructions) {
            std::visit(
                [&](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, core::compiled::SetBackgroundInstruction>) {
                        append_background(output, value.background, collection_diagnostics,
                                          "Scene background instruction");
                    } else if constexpr (std::is_same_v<T, core::compiled::ActorCueInstruction>) {
                        if (value.action != core::compiled::ActorCueAction::Hide) {
                            append_character(output, value.character, value.profile_id,
                                             value.pose_id, value.expression_id,
                                             value.appearance_id, collection_diagnostics,
                                             "Scene actor cue");
                        }
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::CallSceneSceneInstruction> ||
                                         std::is_same_v<
                                             T, core::compiled::StartDetachedSceneInstruction>) {
                        append_target(output, core::compiled::Entrypoint{value.scene},
                                      collection_diagnostics, traversal);
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::CallDialogueSceneInstruction>) {
                        append_target(output, core::compiled::Entrypoint{value.dialogue},
                                      collection_diagnostics, traversal);
                    } else if constexpr (std::is_same_v<T, core::compiled::AudioCueInstruction>) {
                        if (value.asset)
                            append_audio(output, *value.asset, value.purpose,
                                         collection_diagnostics, "Scene audio cue");
                    } else if constexpr (std::is_same_v<T, core::compiled::SetLayoutInstruction>) {
                        if (value.layout)
                            append_layout(output, *value.layout, collection_diagnostics,
                                          "Scene Layout instruction");
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::TransitionGroupInstruction>) {
                        for (const auto& child : value.children) {
                            std::visit(
                                [&](const auto& mutation) {
                                    using M = std::decay_t<decltype(mutation)>;
                                    if constexpr (std::is_same_v<
                                                      M,
                                                      core::compiled::
                                                          TransitionGroupSetBackgroundMutation>) {
                                        append_background(output, mutation.background,
                                                          collection_diagnostics,
                                                          "Scene transition background");
                                    } else if constexpr (std::is_same_v<
                                                             M, core::compiled::
                                                                    TransitionGroupActorMutation>) {
                                        if (mutation.action !=
                                            core::compiled::ActorCueAction::Hide) {
                                            append_character(
                                                output, mutation.character, mutation.profile_id,
                                                mutation.pose_id, mutation.expression_id,
                                                mutation.appearance_id, collection_diagnostics,
                                                "Scene transition actor");
                                        }
                                    } else if constexpr (
                                        std::is_same_v<
                                            M, core::compiled::TransitionGroupLayoutMutation>) {
                                        if (mutation.layout)
                                            append_layout(output, *mutation.layout,
                                                          collection_diagnostics,
                                                          "Scene transition Layout");
                                    }
                                },
                                child);
                        }
                    }
                },
                instruction);
        }
        std::visit(
            [&](const auto& terminal) {
                using T = std::decay_t<decltype(terminal)>;
                if constexpr (std::is_same_v<T, core::compiled::ContinueSceneTerminal>)
                    append_target(output, core::compiled::Entrypoint{terminal.scene},
                                  collection_diagnostics, traversal);
                else if constexpr (std::is_same_v<T, core::compiled::ContinueDialogueSceneTerminal>)
                    append_target(output, core::compiled::Entrypoint{terminal.dialogue},
                                  collection_diagnostics, traversal);
            },
            scene.terminal);
    }

    void append_dialogue(DescriptorAccumulator& output, const core::DialogueId& id,
                         core::Diagnostics& collection_diagnostics,
                         std::unordered_set<std::string>& traversal) const
    {
        const auto found = dialogues.find(id);
        if (found == dialogues.end()) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_missing_dialogue",
                           "prefetch target references missing Dialogue '" + id.text() + "'");
            return;
        }
        append_flow_target(output, found->second->completion, collection_diagnostics, traversal);
    }

    void append_target(DescriptorAccumulator& output, const core::compiled::Entrypoint& target,
                       core::Diagnostics& collection_diagnostics,
                       std::unordered_set<std::string>& traversal) const
    {
        const std::string identity = target_identity(target);
        if (!traversal.insert(identity).second) {
            add_diagnostic(collection_diagnostics, "assets.prefetch_dependency_cycle",
                           "prefetch dependency traversal stopped at cycle '" + identity + "'",
                           core::ErrorSeverity::Info);
            return;
        }
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::RoomId>)
                    append_room(output, value, collection_diagnostics, traversal);
                else if constexpr (std::is_same_v<T, core::SceneId>)
                    append_scene(output, value, collection_diagnostics, traversal);
                else
                    append_dialogue(output, value, collection_diagnostics, traversal);
            },
            target);
        traversal.erase(identity);
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
    for (const auto& asset : project.assets()) {
        const auto* registered = package.resources().find_asset(asset.id);
        if (registered != nullptr) {
            impl->assets.emplace(asset.id, registered);
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
    for (const auto& scene : project.scenes())
        impl->scenes.emplace(scene.identity.id, &scene);
    for (const auto& dialogue : project.dialogues())
        impl->dialogues.emplace(dialogue.identity.id, &dialogue);
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

StructuredAssetDependencyCollector::StructuredAssetDependencyCollector(
    StructuredAssetDependencyIndex index) noexcept
    : m_index(std::move(index))
{
}

StructuredAssetDependencyBuckets
StructuredAssetDependencyCollector::collect(const StructuredAssetDependencyContext& context) const
{
    StructuredAssetDependencyBuckets result;
    result.diagnostics = m_index.m_impl->diagnostics;
    result.mandatory_diagnostics = m_index.m_impl->configuration_diagnostics;
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
    result.current_mandatory = current.take();
    core::append_diagnostics(result.mandatory_diagnostics, current_diagnostics);
    core::append_diagnostics(result.diagnostics, std::move(current_diagnostics));

    DescriptorAccumulator direct(&seen);
    core::Diagnostics direct_diagnostics;
    if (context.direct_next) {
        std::unordered_set<std::string> traversal;
        m_index.m_impl->append_target(direct, *context.direct_next, direct_diagnostics, traversal);
    }
    result.direct_next = direct.take();
    core::append_diagnostics(result.diagnostics, std::move(direct_diagnostics));

    DescriptorAccumulator adjacent(&seen);
    core::Diagnostics adjacent_diagnostics;
    for (const auto& target : context.adjacent_alternatives) {
        std::unordered_set<std::string> traversal;
        m_index.m_impl->append_target(adjacent, target, adjacent_diagnostics, traversal);
    }
    if (context.current_presentation && context.current_presentation->current_room) {
        const auto room = m_index.m_impl->rooms.find(*context.current_presentation->current_room);
        if (room != m_index.m_impl->rooms.end()) {
            for (const auto& exit : room->second->exits) {
                std::unordered_set<std::string> traversal;
                m_index.m_impl->append_target(adjacent, core::compiled::Entrypoint{exit.target},
                                              adjacent_diagnostics, traversal);
            }
        }
    }
    result.adjacent_alternatives = adjacent.take();
    core::append_diagnostics(result.diagnostics, std::move(adjacent_diagnostics));
    return result;
}

PrefetchPlan resolve_flow_prediction(const StructuredAssetDependencyIndex& index,
                                     const runtime::FlowPredictionProjection& projection)
{
    PrefetchPlan plan;
    plan.diagnostics = projection.diagnostics;
    std::map<CacheIdentity, SeenDescriptorState> seen;
    for (const auto& projected : projection.entries) {
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

        const auto identity = identity_of(descriptor->cache_key);
        const bool retain_alpha_coverage = descriptor_retain_alpha_coverage(*descriptor);
        const auto [existing, inserted] = seen.try_emplace(
            identity, SeenDescriptorState{.retain_alpha_coverage = retain_alpha_coverage});
        if (!inserted) {
            existing->second.retain_alpha_coverage |= retain_alpha_coverage;
            continue;
        }
        plan.candidates.push_back({.descriptor = std::move(*descriptor),
                                   .prediction = PrefetchPredictionKind::ExpectedNext,
                                   .execution_distance = projected.execution_distance});
    }
    return plan;
}

struct PrefetchPlanner::Impl {
    explicit Impl(AssetManager& manager) : assets(&manager) {}

    AssetManager* assets;
    std::optional<PrefetchGenerationId> generation;
    std::vector<PrefetchTicket> tickets;
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

} // namespace

PrefetchPlanner::PrefetchPlanner(AssetManager& assets) noexcept
    : m_impl(std::make_unique<Impl>(assets))
{
}

PrefetchPlanner::~PrefetchPlanner() = default;
PrefetchPlanner::PrefetchPlanner(PrefetchPlanner&&) noexcept = default;
PrefetchPlanner& PrefetchPlanner::operator=(PrefetchPlanner&&) noexcept = default;

core::Result<PrefetchSubmissionReport, core::Diagnostic>
PrefetchPlanner::replace_generation_on_owner(
    const StructuredAssetDependencyBuckets& dependencies) noexcept
{
    auto allocated = m_impl->assets->create_prefetch_generation_on_owner();
    if (!allocated)
        return core::Result<PrefetchSubmissionReport, core::Diagnostic>::failure(allocated.error());

    PrefetchSubmissionReport report;
    report.generation = *allocated.value_if();
    std::vector<PrefetchTicket> next_tickets;
    std::map<CacheIdentity, SeenDescriptorState> seen;
    for (const auto& current : dependencies.current_mandatory) {
        const auto identity = identity_of(current.cache_key);
        const bool retain_alpha_coverage = descriptor_retain_alpha_coverage(current);
        auto [found, inserted] = seen.try_emplace(
            identity, SeenDescriptorState{.retain_alpha_coverage = retain_alpha_coverage});
        if (!inserted)
            found->second.retain_alpha_coverage |= retain_alpha_coverage;
    }

    auto submit = [&](const StructuredAssetRequestDescriptor& descriptor, bool direct_next) {
        const auto identity = identity_of(descriptor.cache_key);
        const bool retain_alpha_coverage = descriptor_retain_alpha_coverage(descriptor);
        const auto [found, inserted] = seen.try_emplace(
            identity, SeenDescriptorState{.retain_alpha_coverage = retain_alpha_coverage});
        if (!inserted) {
            if (!retain_alpha_coverage || found->second.retain_alpha_coverage)
                return;
            found->second.retain_alpha_coverage = true;
        }

        if (direct_next)
            ++report.direct_next_count;
        else
            ++report.adjacent_count;
        const AssetSourceGeneration current_generation =
            m_impl->assets->source_generation_on_owner();
        const auto prediction = direct_next ? PrefetchPredictionKind::ExpectedNext
                                            : PrefetchPredictionKind::PossibleNext;
        if (descriptor.cache_key.source_generation != current_generation) {
            report.failures.push_back(
                {.cache_key = descriptor.cache_key,
                 .prediction = prediction,
                 .diagnostic = {.code = "assets.prefetch_stale_descriptor",
                                .message = "prefetch descriptor source generation is stale"}});
            return;
        }
        const AssetCacheKey expected = descriptor_cache_key(descriptor.request, current_generation);
        if (expected != descriptor.cache_key) {
            report.failures.push_back(
                {.cache_key = descriptor.cache_key,
                 .prediction = prediction,
                 .diagnostic = {
                     .code = "assets.prefetch_descriptor_key_mismatch",
                     .message = "typed prefetch descriptor does not match its derived cache key"}});
            return;
        }

        auto submitted = dispatch_prefetch(*m_impl->assets, descriptor.request, report.generation);
        if (!submitted) {
            report.failures.push_back({.cache_key = descriptor.cache_key,
                                       .prediction = prediction,
                                       .diagnostic = submitted.error()});
            return;
        }
        next_tickets.push_back(std::move(*submitted.value_if()));
        report.submitted_entries.push_back(
            {.cache_key = descriptor.cache_key, .prediction = prediction});
        report.submitted_keys.push_back(descriptor.cache_key);
        if (direct_next)
            ++report.direct_next_submitted;
        else
            ++report.adjacent_submitted;
    };

    for (const auto& descriptor : dependencies.direct_next)
        submit(descriptor, true);
    for (const auto& descriptor : dependencies.adjacent_alternatives)
        submit(descriptor, false);

    m_impl->generation = report.generation;
    m_impl->tickets = std::move(next_tickets);
    return core::Result<PrefetchSubmissionReport, core::Diagnostic>::success(std::move(report));
}

core::Result<PrefetchSubmissionReport, core::Diagnostic>
PrefetchPlanner::replace_generation_on_owner(const PrefetchPlan& plan) noexcept
{
    auto allocated = m_impl->assets->create_prefetch_generation_on_owner();
    if (!allocated)
        return core::Result<PrefetchSubmissionReport, core::Diagnostic>::failure(allocated.error());

    PrefetchSubmissionReport report;
    report.generation = *allocated.value_if();
    std::vector<PrefetchTicket> next_tickets;
    std::map<CacheIdentity, SeenDescriptorState> seen;
    for (const auto& candidate : plan.candidates) {
        const auto& descriptor = candidate.descriptor;
        const auto identity = identity_of(descriptor.cache_key);
        const bool retain_alpha_coverage = descriptor_retain_alpha_coverage(descriptor);
        const auto [found, inserted] = seen.try_emplace(
            identity, SeenDescriptorState{.retain_alpha_coverage = retain_alpha_coverage});
        if (!inserted) {
            if (!retain_alpha_coverage || found->second.retain_alpha_coverage)
                continue;
            found->second.retain_alpha_coverage = true;
        }

        if (candidate.prediction == PrefetchPredictionKind::ExpectedNext)
            ++report.direct_next_count;
        else
            ++report.adjacent_count;
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

        auto submitted = dispatch_prefetch(*m_impl->assets, descriptor.request, report.generation);
        if (!submitted) {
            report.failures.push_back({.cache_key = descriptor.cache_key,
                                       .prediction = candidate.prediction,
                                       .diagnostic = submitted.error()});
            continue;
        }
        next_tickets.push_back(std::move(*submitted.value_if()));
        report.submitted_entries.push_back(
            {.cache_key = descriptor.cache_key, .prediction = candidate.prediction});
        report.submitted_keys.push_back(descriptor.cache_key);
        if (candidate.prediction == PrefetchPredictionKind::ExpectedNext)
            ++report.direct_next_submitted;
        else
            ++report.adjacent_submitted;
    }

    m_impl->generation = report.generation;
    m_impl->tickets = std::move(next_tickets);
    return core::Result<PrefetchSubmissionReport, core::Diagnostic>::success(std::move(report));
}

void PrefetchPlanner::clear_on_owner() noexcept
{
    m_impl->tickets.clear();
    m_impl->generation.reset();
}

std::optional<PrefetchGenerationId> PrefetchPlanner::active_generation_on_owner() const noexcept
{
    return m_impl->generation;
}

std::size_t PrefetchPlanner::retained_ticket_count_on_owner() const noexcept
{
    return m_impl->tickets.size();
}

} // namespace noveltea::assets
