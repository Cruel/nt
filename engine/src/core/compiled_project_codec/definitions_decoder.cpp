#include "internal.hpp"
#include "noveltea/core/presentation_contracts.hpp"

namespace noveltea::core::compiled::wire::detail {

namespace {
std::optional<std::int32_t> decode_order(Decoder& decoder, const nlohmann::json& value,
                                         std::string_view pointer)
{
    auto number = decoder.finite_number(value, pointer);
    if (!number || std::trunc(*number) != *number ||
        *number < static_cast<double>(std::numeric_limits<std::int32_t>::min()) ||
        *number > static_cast<double>(std::numeric_limits<std::int32_t>::max())) {
        decoder.error(k_code_number, "Expected a 32-bit integer.", std::string(pointer));
        return std::nullopt;
    }
    return static_cast<std::int32_t>(*number);
}

std::optional<LayoutClockDomain>
decode_presentation_clock(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    return decoder.enumeration<LayoutClockDomain>(
        value, pointer,
        {{"gameplay", LayoutClockDomain::Gameplay},
         {"unscaled-presentation", LayoutClockDomain::UnscaledPresentation}});
}

std::optional<PresentationPlane> decode_world_plane(Decoder& decoder, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    return decoder.enumeration<PresentationPlane>(
        value, pointer,
        {{"world-background", PresentationPlane::WorldBackground},
         {"world-content", PresentationPlane::WorldContent},
         {"world-overlay", PresentationPlane::WorldOverlay}});
}

std::optional<HotspotHighlight>
decode_hotspot_highlight(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected hotspot highlight object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "default" && decoder.object(value, pointer, {"kind"}))
        return DefaultHotspotHighlight{};
    if (*kind == "none" && decoder.object(value, pointer, {"kind"}))
        return NoHotspotHighlight{};
    if (*kind == "material" && decoder.object(value, pointer, {"kind", "material"})) {
        const auto* material_value = decoder.member(value, "material", pointer);
        auto material =
            material_value
                ? decode_reference<MaterialId>(decoder, *material_value,
                                               pointer_child(pointer, "material"), "material")
                : std::nullopt;
        if (material)
            return MaterialHotspotHighlight{std::move(*material)};
    }
    decoder.error(k_code_variant, "Unknown hotspot highlight kind.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

struct DecodedHotspotCommon {
    HotspotId id;
    std::string label;
    Condition condition;
    std::int32_t input_order;
    HotspotHighlight highlight;
};

std::optional<std::vector<InventoryDefinition>>
decode_inventories(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    auto inventories = decoder.array<InventoryDefinition>(
        value, pointer,
        [&](const nlohmann::json& inventory,
            const std::string& item_pointer) -> std::optional<InventoryDefinition> {
            if (!decoder.object(inventory, item_pointer, {"id", "label"}))
                return std::nullopt;
            const auto* id_value = decoder.member(inventory, "id", item_pointer);
            const auto* label_value = decoder.member(inventory, "label", item_pointer);
            auto id = id_value
                          ? decoder.id<InventoryId>(*id_value, pointer_child(item_pointer, "id"))
                          : std::nullopt;
            auto label = label_value
                             ? decoder.string(*label_value, pointer_child(item_pointer, "label"))
                             : std::nullopt;
            return id && label ? std::optional<InventoryDefinition>(
                                     InventoryDefinition{std::move(*id), std::move(*label)})
                               : std::nullopt;
        });
    if (inventories)
        decoder.duplicate_ids(*inventories, pointer,
                              [](const InventoryDefinition& inventory) -> const InventoryId& {
                                  return inventory.id;
                              });
    return inventories;
}

std::optional<std::vector<TraitProperty>>
decode_owner_contracts(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    return decoder.array<TraitProperty>(
        value, pointer,
        [&](const nlohmann::json& property,
            const std::string& item_pointer) -> std::optional<TraitProperty> {
            return decode_owner_property_contract(decoder, property, item_pointer);
        });
}

std::optional<FeatureDefinition> decode_feature(Decoder& decoder, const nlohmann::json& value,
                                                std::string_view pointer)
{
    if (!decoder.object(
            value, pointer,
            {"id", "inventories", "label", "properties", "propertyAssignments", "traits"}))
        return std::nullopt;
    auto identity = decode_identity<FeatureId>(decoder, value, pointer);
    const auto* label_value = decoder.member(value, "label", pointer);
    const auto* properties_value = decoder.member(value, "properties", pointer);
    const auto* inventories_value = decoder.member(value, "inventories", pointer);
    auto label =
        label_value ? decoder.string(*label_value, pointer_child(pointer, "label")) : std::nullopt;
    auto properties = properties_value
                          ? decode_owner_contracts(decoder, *properties_value,
                                                   pointer_child(pointer, "properties"))
                          : std::nullopt;
    auto inventories = inventories_value ? decode_inventories(decoder, *inventories_value,
                                                              pointer_child(pointer, "inventories"))
                                         : std::nullopt;
    if (!identity || !label || !properties || !inventories)
        return std::nullopt;
    return FeatureDefinition{std::move(*identity), std::move(*label), std::move(*properties),
                             std::move(*inventories)};
}

std::optional<RoomHotspotTarget>
decode_room_hotspot_target(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected Room hotspot target object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "owner-feature" && decoder.object(value, pointer, {"featureId", "kind"})) {
        const auto* feature_value = decoder.member(value, "featureId", pointer);
        auto feature = feature_value ? decoder.id<FeatureId>(*feature_value,
                                                             pointer_child(pointer, "featureId"))
                                     : std::nullopt;
        if (feature)
            return HotspotOwnerFeatureTarget{std::move(*feature)};
    }
    if (*kind == "subject" && decoder.object(value, pointer, {"kind", "subject"})) {
        const auto* subject_value = decoder.member(value, "subject", pointer);
        auto subject = subject_value ? decode_interaction_subject(decoder, *subject_value,
                                                                  pointer_child(pointer, "subject"))
                                     : std::nullopt;
        if (subject)
            return HotspotSubjectTarget{std::move(*subject)};
    }
    if (*kind == "exit" && decoder.object(value, pointer, {"exitId", "kind"})) {
        const auto* exit_value = decoder.member(value, "exitId", pointer);
        auto exit = exit_value
                        ? decoder.id<RoomExitId>(*exit_value, pointer_child(pointer, "exitId"))
                        : std::nullopt;
        if (exit)
            return RoomExitHotspotTarget{std::move(*exit)};
    }
    decoder.error(k_code_variant, "Unknown Room hotspot target kind.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<InteractableHotspotTarget>
decode_interactable_hotspot_target(Decoder& decoder, const nlohmann::json& value,
                                   std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected Interactable hotspot target object.",
                      std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "owner" && decoder.object(value, pointer, {"kind"}))
        return HotspotOwnerTarget{};
    if (*kind == "owner-feature" && decoder.object(value, pointer, {"featureId", "kind"})) {
        const auto* feature_value = decoder.member(value, "featureId", pointer);
        auto feature = feature_value ? decoder.id<FeatureId>(*feature_value,
                                                             pointer_child(pointer, "featureId"))
                                     : std::nullopt;
        if (feature)
            return HotspotOwnerFeatureTarget{std::move(*feature)};
    }
    if (*kind == "subject" && decoder.object(value, pointer, {"kind", "subject"})) {
        const auto* subject_value = decoder.member(value, "subject", pointer);
        auto subject = subject_value ? decode_interaction_subject(decoder, *subject_value,
                                                                  pointer_child(pointer, "subject"))
                                     : std::nullopt;
        if (subject)
            return HotspotSubjectTarget{std::move(*subject)};
    }
    decoder.error(k_code_variant, "Unknown Interactable hotspot target kind.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<DecodedHotspotCommon>
decode_hotspot_common(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* label_value = decoder.member(value, "label", pointer);
    const auto* condition_value = decoder.member(value, "condition", pointer);
    const auto* order_value = decoder.member(value, "inputOrder", pointer);
    const auto* highlight_value = decoder.member(value, "highlight", pointer);
    auto id =
        id_value ? decoder.id<HotspotId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto label =
        label_value ? decoder.string(*label_value, pointer_child(pointer, "label")) : std::nullopt;
    auto condition = condition_value ? decode_condition_impl(decoder, *condition_value,
                                                             pointer_child(pointer, "condition"))
                                     : std::nullopt;
    auto order = order_value
                     ? decode_order(decoder, *order_value, pointer_child(pointer, "inputOrder"))
                     : std::nullopt;
    auto highlight = highlight_value ? decode_hotspot_highlight(decoder, *highlight_value,
                                                                pointer_child(pointer, "highlight"))
                                     : std::nullopt;
    if (!id || !label || !condition || !order || !highlight)
        return std::nullopt;
    return DecodedHotspotCommon{std::move(*id), std::move(*label), std::move(*condition), *order,
                                std::move(*highlight)};
}

std::optional<RectHotspotShape>
decode_rect_hotspot_shape(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"bounds", "kind"}))
        return std::nullopt;
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* bounds_value = decoder.member(value, "bounds", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    auto bounds = bounds_value
                      ? decode_rect(decoder, *bounds_value, pointer_child(pointer, "bounds"))
                      : std::nullopt;
    if (!kind || *kind != "rect") {
        decoder.error(k_code_variant, "Expected rectangular hotspot shape.",
                      pointer_child(pointer, "kind"));
        return std::nullopt;
    }
    return bounds ? std::optional<RectHotspotShape>(RectHotspotShape{std::move(*bounds)})
                  : std::nullopt;
}
std::optional<RoomNavigationTransition> decode_navigation_transition(Decoder& decoder,
                                                                     const nlohmann::json& value,
                                                                     std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"color", "durationMs", "kind", "skippable"}))
        return std::nullopt;
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* duration_value = decoder.member(value, "durationMs", pointer);
    const auto* color_value = decoder.member(value, "color", pointer);
    const auto* skippable_value = decoder.member(value, "skippable", pointer);
    auto kind =
        kind_value
            ? decoder.enumeration<TransitionKind>(*kind_value, pointer_child(pointer, "kind"),
                                                  {{"fade", TransitionKind::Fade},
                                                   {"cut", TransitionKind::Cut},
                                                   {"dissolve", TransitionKind::Dissolve}})
            : std::nullopt;
    auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                         *duration_value, pointer_child(pointer, "durationMs"))
                                   : std::nullopt;
    std::optional<std::string> color;
    bool color_ok = color_value != nullptr;
    if (color_value && !color_value->is_null()) {
        color = decoder.string(*color_value, pointer_child(pointer, "color"));
        color_ok = color.has_value();
    }
    auto skippable = skippable_value
                         ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                         : std::nullopt;
    if (!kind || !duration || !color_ok || !skippable)
        return std::nullopt;
    if ((*kind == TransitionKind::Cut) != (*duration == 0) ||
        (*kind != TransitionKind::Fade && color)) {
        decoder.error(k_code_variant, "Invalid Room navigation transition fields.",
                      std::string(pointer));
        return std::nullopt;
    }
    return RoomNavigationTransition{*kind, *duration, std::move(color), *skippable};
}
} // namespace

std::optional<CharacterDefinition> decode_character(Decoder& decoder, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"appearances", "defaults", "dialogue", "displayName", "expressions",
                         "gestures", "id", "idles", "initialWorldState", "inventories", "profiles",
                         "properties", "propertyAssignments", "traits"}))
        return std::nullopt;
    auto identity = decode_identity<CharacterId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* properties_value = decoder.member(value, "properties", pointer);
    const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
    const auto* defaults_value = decoder.member(value, "defaults", pointer);
    const auto* profiles_value = decoder.member(value, "profiles", pointer);
    const auto* expressions_value = decoder.member(value, "expressions", pointer);
    const auto* appearances_value = decoder.member(value, "appearances", pointer);
    const auto* gestures_value = json_access::member(value, "gestures");
    const auto* idles_value = json_access::member(value, "idles");
    const auto* inventories_value = decoder.member(value, "inventories", pointer);
    const auto* initial_world_value = decoder.member(value, "initialWorldState", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto properties = properties_value
                          ? decode_owner_contracts(decoder, *properties_value,
                                                   pointer_child(pointer, "properties"))
                          : std::nullopt;
    std::optional<CharacterDialoguePresentation> dialogue;
    if (dialogue_value && decoder.object(*dialogue_value, pointer_child(pointer, "dialogue"),
                                         {"name", "nameColor", "styleClass", "textColor"})) {
        const auto dialogue_pointer = pointer_child(pointer, "dialogue");
        const auto* name_value = decoder.member(*dialogue_value, "name", dialogue_pointer);
        const auto* name_color_value =
            decoder.member(*dialogue_value, "nameColor", dialogue_pointer);
        const auto* style_value = decoder.member(*dialogue_value, "styleClass", dialogue_pointer);
        const auto* text_color_value =
            decoder.member(*dialogue_value, "textColor", dialogue_pointer);
        auto name = name_value
                        ? decoder.string(*name_value, pointer_child(dialogue_pointer, "name"))
                        : std::nullopt;
        auto style = style_value ? decoder.string(*style_value,
                                                  pointer_child(dialogue_pointer, "styleClass"))
                                 : std::nullopt;
        std::optional<std::string> name_color;
        bool name_color_ok = name_color_value != nullptr;
        if (name_color_value && !name_color_value->is_null()) {
            name_color =
                decoder.string(*name_color_value, pointer_child(dialogue_pointer, "nameColor"));
            name_color_ok = name_color.has_value();
        }
        std::optional<std::string> text_color;
        bool text_color_ok = text_color_value != nullptr;
        if (text_color_value && !text_color_value->is_null()) {
            text_color =
                decoder.string(*text_color_value, pointer_child(dialogue_pointer, "textColor"));
            text_color_ok = text_color.has_value();
        }
        if (name && style && name_color_ok && text_color_ok)
            dialogue = CharacterDialoguePresentation{std::move(*name), std::move(name_color),
                                                     std::move(*style), std::move(text_color)};
    }
    std::optional<CharacterDefaults> defaults;
    if (defaults_value && decoder.object(*defaults_value, pointer_child(pointer, "defaults"),
                                         {"appearanceId", "expressionId", "idleId", "profileId"})) {
        const auto defaults_pointer = pointer_child(pointer, "defaults");
        const auto* profile_value = decoder.member(*defaults_value, "profileId", defaults_pointer);
        const auto* expression_value =
            decoder.member(*defaults_value, "expressionId", defaults_pointer);
        const auto* appearance_value =
            decoder.member(*defaults_value, "appearanceId", defaults_pointer);
        const auto* idle_value = json_access::member(*defaults_value, "idleId");
        auto profile = profile_value
                           ? decoder.id<CharacterPresentationProfileId>(
                                 *profile_value, pointer_child(defaults_pointer, "profileId"))
                           : std::nullopt;
        auto expression =
            expression_value
                ? decoder.id<CharacterExpressionId>(*expression_value,
                                                    pointer_child(defaults_pointer, "expressionId"))
                : std::nullopt;
        std::optional<CharacterAppearanceId> appearance;
        bool appearance_ok = appearance_value != nullptr;
        if (appearance_value && !appearance_value->is_null()) {
            appearance = decoder.id<CharacterAppearanceId>(
                *appearance_value, pointer_child(defaults_pointer, "appearanceId"));
            appearance_ok = appearance.has_value();
        }
        std::optional<CharacterIdleId> idle;
        bool idle_ok = true;
        if (idle_value && !idle_value->is_null()) {
            idle =
                decoder.id<CharacterIdleId>(*idle_value, pointer_child(defaults_pointer, "idleId"));
            idle_ok = idle.has_value();
        }
        if (profile && expression && appearance_ok && idle_ok)
            defaults = CharacterDefaults{std::move(*profile), std::move(*expression),
                                         std::move(appearance), std::move(idle)};
    }
    const auto decode_layer_composition =
        [&](const nlohmann::json& layer,
            const std::string& layer_pointer) -> std::optional<CharacterLayerComposition> {
        if (!decoder.object(
                layer, layer_pointer,
                {"anchor", "layerId", "material", "offset", "scale", "sprite", "visible"}))
            return std::nullopt;
        const auto* layer_id_value = decoder.member(layer, "layerId", layer_pointer);
        const auto* sprite_value = decoder.member(layer, "sprite", layer_pointer);
        const auto* material_value = decoder.member(layer, "material", layer_pointer);
        const auto* offset_value = decoder.member(layer, "offset", layer_pointer);
        const auto* scale_value = decoder.member(layer, "scale", layer_pointer);
        const auto* anchor_value = decoder.member(layer, "anchor", layer_pointer);
        const auto* visible_value = decoder.member(layer, "visible", layer_pointer);
        auto layer_id = layer_id_value
                            ? decoder.id<CharacterPresentationLayerId>(
                                  *layer_id_value, pointer_child(layer_pointer, "layerId"))
                            : std::nullopt;
        std::optional<AssetId> sprite;
        bool sprite_ok = sprite_value != nullptr;
        if (sprite_value && !sprite_value->is_null()) {
            sprite = decode_reference<AssetId>(decoder, *sprite_value,
                                               pointer_child(layer_pointer, "sprite"), "asset");
            sprite_ok = sprite.has_value();
        }
        std::optional<MaterialId> material;
        bool material_ok = material_value != nullptr;
        if (material_value && !material_value->is_null()) {
            material = decode_reference<MaterialId>(
                decoder, *material_value, pointer_child(layer_pointer, "material"), "material");
            material_ok = material.has_value();
        }
        auto offset = offset_value ? decode_vector2(decoder, *offset_value,
                                                    pointer_child(layer_pointer, "offset"))
                                   : std::nullopt;
        auto scale =
            scale_value ? decoder.finite_number(*scale_value, pointer_child(layer_pointer, "scale"))
                        : std::nullopt;
        if (scale && *scale <= 0.0) {
            decoder.error(k_code_number, "Scale must be positive.",
                          pointer_child(layer_pointer, "scale"));
            scale.reset();
        }
        auto anchor = anchor_value ? decode_vector2(decoder, *anchor_value,
                                                    pointer_child(layer_pointer, "anchor"))
                                   : std::nullopt;
        auto visible =
            visible_value ? decoder.boolean(*visible_value, pointer_child(layer_pointer, "visible"))
                          : std::nullopt;
        if (!layer_id || !sprite_ok || !material_ok || !offset || !scale || !anchor || !visible)
            return std::nullopt;
        return CharacterLayerComposition{std::move(*layer_id),
                                         std::move(sprite),
                                         std::move(material),
                                         std::move(*offset),
                                         *scale,
                                         std::move(*anchor),
                                         *visible};
    };
    const auto decode_animation_layer =
        [&](const nlohmann::json& layer,
            const std::string& layer_pointer) -> std::optional<CharacterAnimationLayerFrame> {
        if (!decoder.object(
                layer, layer_pointer,
                {"anchor", "layerId", "material", "offset", "scale", "sprite", "visible"}))
            return std::nullopt;
        const auto* layer_id_value = decoder.member(layer, "layerId", layer_pointer);
        auto layer_id = layer_id_value
                            ? decoder.id<CharacterPresentationLayerId>(
                                  *layer_id_value, pointer_child(layer_pointer, "layerId"))
                            : std::nullopt;
        CharacterOptionalOverride<AssetId> sprite;
        if (const auto* sprite_value = json_access::member(layer, "sprite")) {
            sprite.specified = true;
            if (!sprite_value->is_null()) {
                sprite.value = decode_reference<AssetId>(
                    decoder, *sprite_value, pointer_child(layer_pointer, "sprite"), "asset");
                if (!sprite.value)
                    return std::nullopt;
            }
        }
        CharacterOptionalOverride<MaterialId> material;
        if (const auto* material_value = json_access::member(layer, "material")) {
            material.specified = true;
            if (!material_value->is_null()) {
                material.value = decode_reference<MaterialId>(
                    decoder, *material_value, pointer_child(layer_pointer, "material"), "material");
                if (!material.value)
                    return std::nullopt;
            }
        }
        std::optional<Vector2> offset;
        if (const auto* offset_value = json_access::member(layer, "offset")) {
            offset = decode_vector2(decoder, *offset_value, pointer_child(layer_pointer, "offset"));
            if (!offset)
                return std::nullopt;
        }
        std::optional<double> scale;
        if (const auto* scale_value = json_access::member(layer, "scale")) {
            scale = decoder.finite_number(*scale_value, pointer_child(layer_pointer, "scale"));
            if (!scale || *scale <= 0.0) {
                if (scale)
                    decoder.error(k_code_number, "Scale must be positive.",
                                  pointer_child(layer_pointer, "scale"));
                return std::nullopt;
            }
        }
        std::optional<Vector2> anchor;
        if (const auto* anchor_value = json_access::member(layer, "anchor")) {
            anchor = decode_vector2(decoder, *anchor_value, pointer_child(layer_pointer, "anchor"));
            if (!anchor)
                return std::nullopt;
        }
        std::optional<bool> visible;
        if (const auto* visible_value = json_access::member(layer, "visible")) {
            visible = decoder.boolean(*visible_value, pointer_child(layer_pointer, "visible"));
            if (!visible)
                return std::nullopt;
        }
        if (!layer_id)
            return std::nullopt;
        return CharacterAnimationLayerFrame{std::move(*layer_id),
                                            std::move(sprite),
                                            std::move(material),
                                            std::move(offset),
                                            scale,
                                            std::move(anchor),
                                            visible};
    };
    auto profiles =
        profiles_value
            ? decoder.array<CharacterPresentationProfile>(
                  *profiles_value, pointer_child(pointer, "profiles"),
                  [&](const nlohmann::json& profile, const std::string& profile_pointer)
                      -> std::optional<CharacterPresentationProfile> {
                      if (!decoder.object(profile, profile_pointer,
                                          {"animationClips", "automaticAnimations", "defaultPoseId",
                                           "id", "layers", "poses"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(profile, "id", profile_pointer);
                      const auto* layers_value = decoder.member(profile, "layers", profile_pointer);
                      const auto* default_pose_value =
                          decoder.member(profile, "defaultPoseId", profile_pointer);
                      const auto* poses_value = decoder.member(profile, "poses", profile_pointer);
                      const auto* clips_value = json_access::member(profile, "animationClips");
                      const auto* automatic_value =
                          json_access::member(profile, "automaticAnimations");
                      auto id = id_value ? decoder.id<CharacterPresentationProfileId>(
                                               *id_value, pointer_child(profile_pointer, "id"))
                                         : std::nullopt;
                      auto layers =
                          layers_value
                              ? decoder.array<CharacterPresentationLayer>(
                                    *layers_value, pointer_child(profile_pointer, "layers"),
                                    [&](const nlohmann::json& layer,
                                        const std::string& layer_pointer)
                                        -> std::optional<CharacterPresentationLayer> {
                                        if (!decoder.object(layer, layer_pointer, {"id", "role"}))
                                            return std::nullopt;
                                        const auto* layer_id_value =
                                            decoder.member(layer, "id", layer_pointer);
                                        const auto* role_value =
                                            decoder.member(layer, "role", layer_pointer);
                                        auto layer_id =
                                            layer_id_value
                                                ? decoder.id<CharacterPresentationLayerId>(
                                                      *layer_id_value,
                                                      pointer_child(layer_pointer, "id"))
                                                : std::nullopt;
                                        std::optional<std::string> role;
                                        bool role_ok = role_value != nullptr;
                                        if (role_value && !role_value->is_null()) {
                                            role = decoder.string(
                                                *role_value, pointer_child(layer_pointer, "role"));
                                            role_ok = role.has_value();
                                        }
                                        if (!layer_id || !role_ok)
                                            return std::nullopt;
                                        return CharacterPresentationLayer{std::move(*layer_id),
                                                                          std::move(role)};
                                    })
                              : std::nullopt;
                      auto default_pose = default_pose_value
                                              ? decoder.id<CharacterPoseId>(
                                                    *default_pose_value,
                                                    pointer_child(profile_pointer, "defaultPoseId"))
                                              : std::nullopt;
                      auto poses =
                          poses_value
                              ? decoder.array<CharacterPose>(
                                    *poses_value, pointer_child(profile_pointer, "poses"),
                                    [&](const nlohmann::json& pose, const std::string& pose_pointer)
                                        -> std::optional<CharacterPose> {
                                        if (!decoder.object(pose, pose_pointer, {"id", "layers"}))
                                            return std::nullopt;
                                        const auto* pose_id_value =
                                            decoder.member(pose, "id", pose_pointer);
                                        const auto* pose_layers_value =
                                            decoder.member(pose, "layers", pose_pointer);
                                        auto pose_id = pose_id_value
                                                           ? decoder.id<CharacterPoseId>(
                                                                 *pose_id_value,
                                                                 pointer_child(pose_pointer, "id"))
                                                           : std::nullopt;
                                        auto pose_layers =
                                            pose_layers_value
                                                ? decoder.array<CharacterLayerComposition>(
                                                      *pose_layers_value,
                                                      pointer_child(pose_pointer, "layers"),
                                                      decode_layer_composition)
                                                : std::nullopt;
                                        if (!pose_id || !pose_layers)
                                            return std::nullopt;
                                        decoder.duplicate_ids(
                                            *pose_layers, pointer_child(pose_pointer, "layers"),
                                            [](const CharacterLayerComposition& item)
                                                -> const CharacterPresentationLayerId& {
                                                return item.layer_id;
                                            });
                                        return CharacterPose{std::move(*pose_id),
                                                             std::move(*pose_layers)};
                                    })
                              : std::nullopt;
                      auto clips = clips_value ? decoder.array<CharacterAnimationClip>(
                                                     *clips_value,
                                                     pointer_child(profile_pointer,
                                                                   "animationClips"),
                                                     [&](const nlohmann::json& clip,
                                                         const std::string& clip_pointer)
                                                         -> std::optional<CharacterAnimationClip> {
                                                         if (!decoder.object(
                                                                 clip, clip_pointer,
                                                                 {"clock", "frames", "id"}))
                                                             return std::nullopt;
                                                         const auto* clip_id_value = decoder.member(
                                                             clip, "id", clip_pointer);
                                                         const auto* clock_value = decoder.member(
                                                             clip, "clock", clip_pointer);
                                                         const auto* frames_value = decoder.member(
                                                             clip, "frames", clip_pointer);
                                                         auto clip_id =
                                                             clip_id_value
                                                                 ? decoder.id<
                                                                       CharacterAnimationClipId>(
                                                                       *clip_id_value,
                                                                       pointer_child(clip_pointer,
                                                                                     "id"))
                                                                 : std::nullopt;
                                                         auto clock =
                                                             clock_value
                                                                 ? decode_presentation_clock(
                                                                       decoder, *clock_value,
                                                                       pointer_child(clip_pointer,
                                                                                     "clock"))
                                                                 : std::nullopt;
                                                         auto
                                                             frames =
                                                                 frames_value ? decoder
                                                                                    .array<
                                                                                        CharacterAnimationFrame>(
                                                                                        *frames_value,
                                                                                        pointer_child(
                                                                                            clip_pointer,
                                                                                            "frame"
                                                                                            "s"),
                                                                                        [&](const nlohmann::
                                                                                                json&
                                                                                                    frame,
                                                                                            const std::
                                                                                                string&
                                                                                                    frame_pointer)
                                                                                            -> std::
                                                                                                optional<CharacterAnimationFrame> {
                                                                                                    if (!decoder
                                                                                                             .object(
                                                                                                                 frame,
                                                                                                                 frame_pointer,
                                                                                                                 {"durationMs",
                                                                                                                  "layers"}))
                                                                                                        return std::
                                                                                                            nullopt;
                                                                                                    const auto* duration_value =
                                                                                                        decoder
                                                                                                            .member(
                                                                                                                frame,
                                                                                                                "durationMs",
                                                                                                                frame_pointer);
                                                                                                    const auto* frame_layers_value =
                                                                                                        decoder
                                                                                                            .member(
                                                                                                                frame,
                                                                                                                "layers",
                                                                                                                frame_pointer);
                                                                                                    auto duration =
                                                                                                        duration_value
                                                                                                            ? decoder
                                                                                                                  .unsigned_integer<
                                                                                                                      std::
                                                                                                                          uint64_t>(
                                                                                                                      *duration_value,
                                                                                                                      pointer_child(
                                                                                                                          frame_pointer,
                                                                                                                          "durationMs"))
                                                                                                            : std::
                                                                                                                  nullopt;
                                                                                                    if (duration &&
                                                                                                        *duration ==
                                                                                                            0) {
                                                                                                        decoder
                                                                                                            .error(
                                                                                                                k_code_number,
                                                                                                                "Animation frame duration must be "
                                                                                                                "positive.",
                                                                                                                pointer_child(
                                                                                                                    frame_pointer,
                                                                                                                    "durationMs"));
                                                                                                        duration
                                                                                                            .reset();
                                                                                                    }
                                                                                                    auto frame_layers =
                                                                                                        frame_layers_value
                                                                                                            ? decoder
                                                                                                                  .array<
                                                                                                                      CharacterAnimationLayerFrame>(
                                                                                                                      *frame_layers_value,
                                                                                                                      pointer_child(
                                                                                                                          frame_pointer,
                                                                                                                          "layers"),
                                                                                                                      decode_animation_layer)
                                                                                                            : std::
                                                                                                                  nullopt;
                                                                                                    if (!duration ||
                                                                                                        !frame_layers)
                                                                                                        return std::
                                                                                                            nullopt;
                                                                                                    decoder
                                                                                                        .duplicate_ids(
                                                                                                            *frame_layers,
                                                                                                            pointer_child(
                                                                                                                frame_pointer,
                                                                                                                "layers"),
                                                                                                            [](const CharacterAnimationLayerFrame&
                                                                                                                   item)
                                                                                                                -> const CharacterPresentationLayerId& {
                                                                                                                return item
                                                                                                                    .layer_id;
                                                                                                            });
                                                                                                    return CharacterAnimationFrame{
                                                                                                        *duration,
                                                                                                        std::move(
                                                                                                            *frame_layers)};
                                                                                                })
                                                                              : std::nullopt;
                                                         if (!clip_id || !clock || !frames ||
                                                             frames->empty())
                                                             return std::nullopt;
                                                         return CharacterAnimationClip{
                                                             std::move(*clip_id), *clock,
                                                             std::move(*frames)};
                                                     })
                                               : std::optional<std::vector<CharacterAnimationClip>>{
                                                     std::in_place};
                      std::optional<CharacterAutomaticAnimations> automatic{
                          CharacterAutomaticAnimations{}};
                      if (automatic_value &&
                          decoder.object(*automatic_value,
                                         pointer_child(profile_pointer, "automaticAnimations"),
                                         {"blink", "speaking"})) {
                          automatic.reset();
                          const auto automatic_pointer =
                              pointer_child(profile_pointer, "automaticAnimations");
                          const auto* blink_value =
                              decoder.member(*automatic_value, "blink", automatic_pointer);
                          const auto* speaking_value =
                              decoder.member(*automatic_value, "speaking", automatic_pointer);
                          std::optional<CharacterAutomaticBlink> blink;
                          bool blink_ok = blink_value != nullptr;
                          if (blink_value && !blink_value->is_null()) {
                              if (!decoder.object(*blink_value,
                                                  pointer_child(automatic_pointer, "blink"),
                                                  {"clipId", "intervalMs", "role"})) {
                                  blink_ok = false;
                              } else {
                                  const auto blink_pointer =
                                      pointer_child(automatic_pointer, "blink");
                                  const auto* clip_value =
                                      decoder.member(*blink_value, "clipId", blink_pointer);
                                  const auto* role_value =
                                      decoder.member(*blink_value, "role", blink_pointer);
                                  const auto* interval_value =
                                      decoder.member(*blink_value, "intervalMs", blink_pointer);
                                  auto clip_id =
                                      clip_value
                                          ? decoder.id<CharacterAnimationClipId>(
                                                *clip_value, pointer_child(blink_pointer, "clipId"))
                                          : std::nullopt;
                                  auto role =
                                      role_value
                                          ? decoder.string(*role_value,
                                                           pointer_child(blink_pointer, "role"))
                                          : std::nullopt;
                                  auto interval =
                                      interval_value
                                          ? decoder.unsigned_integer<std::uint64_t>(
                                                *interval_value,
                                                pointer_child(blink_pointer, "intervalMs"))
                                          : std::nullopt;
                                  if (interval && *interval == 0) {
                                      decoder.error(k_code_number,
                                                    "Blink interval must be positive.",
                                                    pointer_child(blink_pointer, "intervalMs"));
                                      interval.reset();
                                  }
                                  if (clip_id && role && !role->empty() && interval)
                                      blink = CharacterAutomaticBlink{std::move(*clip_id),
                                                                      std::move(*role), *interval};
                                  else
                                      blink_ok = false;
                              }
                          }
                          std::optional<CharacterAutomaticSpeaking> speaking;
                          bool speaking_ok = speaking_value != nullptr;
                          if (speaking_value && !speaking_value->is_null()) {
                              if (!decoder.object(*speaking_value,
                                                  pointer_child(automatic_pointer, "speaking"),
                                                  {"clipId", "role"})) {
                                  speaking_ok = false;
                              } else {
                                  const auto speaking_pointer =
                                      pointer_child(automatic_pointer, "speaking");
                                  const auto* clip_value =
                                      decoder.member(*speaking_value, "clipId", speaking_pointer);
                                  const auto* role_value =
                                      decoder.member(*speaking_value, "role", speaking_pointer);
                                  auto clip_id =
                                      clip_value ? decoder.id<CharacterAnimationClipId>(
                                                       *clip_value,
                                                       pointer_child(speaking_pointer, "clipId"))
                                                 : std::nullopt;
                                  auto role =
                                      role_value
                                          ? decoder.string(*role_value,
                                                           pointer_child(speaking_pointer, "role"))
                                          : std::nullopt;
                                  if (clip_id && role && !role->empty())
                                      speaking = CharacterAutomaticSpeaking{std::move(*clip_id),
                                                                            std::move(*role)};
                                  else
                                      speaking_ok = false;
                              }
                          }
                          if (blink_ok && speaking_ok)
                              automatic = CharacterAutomaticAnimations{std::move(blink),
                                                                       std::move(speaking)};
                      }
                      if (!id || !layers || !default_pose || !poses || !clips || !automatic)
                          return std::nullopt;
                      decoder.duplicate_ids(
                          *layers, pointer_child(profile_pointer, "layers"),
                          [](const CharacterPresentationLayer& item)
                              -> const CharacterPresentationLayerId& { return item.id; });
                      decoder.duplicate_ids(
                          *poses, pointer_child(profile_pointer, "poses"),
                          [](const CharacterPose& item) -> const CharacterPoseId& {
                              return item.id;
                          });
                      decoder.duplicate_ids(
                          *clips, pointer_child(profile_pointer, "animationClips"),
                          [](const CharacterAnimationClip& item)
                              -> const CharacterAnimationClipId& { return item.id; });
                      return CharacterPresentationProfile{
                          std::move(*id),    std::move(*layers), std::move(*default_pose),
                          std::move(*poses), std::move(*clips),  std::move(*automatic)};
                  })
            : std::nullopt;
    const auto decode_profile_overrides =
        [&](const nlohmann::json& profile,
            const std::string& profile_pointer) -> std::optional<CharacterProfileLayerOverrides> {
        if (!decoder.object(profile, profile_pointer, {"layers", "profileId"}))
            return std::nullopt;
        const auto* profile_id_value = decoder.member(profile, "profileId", profile_pointer);
        const auto* layers_value = decoder.member(profile, "layers", profile_pointer);
        auto profile_id = profile_id_value
                              ? decoder.id<CharacterPresentationProfileId>(
                                    *profile_id_value, pointer_child(profile_pointer, "profileId"))
                              : std::nullopt;
        auto layers =
            layers_value
                ? decoder.array<CharacterLayerOverride>(
                      *layers_value, pointer_child(profile_pointer, "layers"),
                      [&](const nlohmann::json& layer, const std::string& layer_pointer)
                          -> std::optional<CharacterLayerOverride> {
                          if (!decoder.object(layer, layer_pointer,
                                              {"layerId", "material", "sprite", "visible"}))
                              return std::nullopt;
                          const auto* layer_id_value =
                              decoder.member(layer, "layerId", layer_pointer);
                          auto layer_id =
                              layer_id_value
                                  ? decoder.id<CharacterPresentationLayerId>(
                                        *layer_id_value, pointer_child(layer_pointer, "layerId"))
                                  : std::nullopt;
                          CharacterOptionalOverride<AssetId> sprite;
                          if (const auto* sprite_value = json_access::member(layer, "sprite")) {
                              sprite.specified = true;
                              if (!sprite_value->is_null()) {
                                  sprite.value = decode_reference<AssetId>(
                                      decoder, *sprite_value,
                                      pointer_child(layer_pointer, "sprite"), "asset");
                                  if (!sprite.value)
                                      return std::nullopt;
                              }
                          }
                          CharacterOptionalOverride<MaterialId> material;
                          if (const auto* material_value = json_access::member(layer, "material")) {
                              material.specified = true;
                              if (!material_value->is_null()) {
                                  material.value = decode_reference<MaterialId>(
                                      decoder, *material_value,
                                      pointer_child(layer_pointer, "material"), "material");
                                  if (!material.value)
                                      return std::nullopt;
                              }
                          }
                          std::optional<bool> visible;
                          if (const auto* visible_value = json_access::member(layer, "visible")) {
                              visible = decoder.boolean(*visible_value,
                                                        pointer_child(layer_pointer, "visible"));
                              if (!visible)
                                  return std::nullopt;
                          }
                          if (!layer_id)
                              return std::nullopt;
                          return CharacterLayerOverride{std::move(*layer_id), std::move(sprite),
                                                        std::move(material), visible};
                      })
                : std::nullopt;
        if (!profile_id || !layers)
            return std::nullopt;
        decoder.duplicate_ids(
            *layers, pointer_child(profile_pointer, "layers"),
            [](const CharacterLayerOverride& item) -> const CharacterPresentationLayerId& {
                return item.layer_id;
            });
        return CharacterProfileLayerOverrides{std::move(*profile_id), std::move(*layers)};
    };
    auto expressions =
        expressions_value
            ? decoder.array<CharacterExpression>(
                  *expressions_value, pointer_child(pointer, "expressions"),
                  [&](const nlohmann::json& expression,
                      const std::string& expression_pointer) -> std::optional<CharacterExpression> {
                      if (!decoder.object(expression, expression_pointer, {"id", "profiles"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(expression, "id", expression_pointer);
                      const auto* profiles_value =
                          decoder.member(expression, "profiles", expression_pointer);
                      auto id = id_value ? decoder.id<CharacterExpressionId>(
                                               *id_value, pointer_child(expression_pointer, "id"))
                                         : std::nullopt;
                      auto profile_overrides =
                          profiles_value
                              ? decoder.array<CharacterProfileLayerOverrides>(
                                    *profiles_value, pointer_child(expression_pointer, "profiles"),
                                    decode_profile_overrides)
                              : std::nullopt;
                      if (!id || !profile_overrides)
                          return std::nullopt;
                      decoder.duplicate_ids(
                          *profile_overrides, pointer_child(expression_pointer, "profiles"),
                          [](const CharacterProfileLayerOverrides& item)
                              -> const CharacterPresentationProfileId& { return item.profile_id; });
                      return CharacterExpression{std::move(*id), std::move(*profile_overrides)};
                  })
            : std::nullopt;
    auto appearances =
        appearances_value
            ? decoder.array<CharacterAppearance>(
                  *appearances_value, pointer_child(pointer, "appearances"),
                  [&](const nlohmann::json& appearance,
                      const std::string& appearance_pointer) -> std::optional<CharacterAppearance> {
                      if (!decoder.object(appearance, appearance_pointer, {"id", "profiles"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(appearance, "id", appearance_pointer);
                      const auto* profiles_value =
                          decoder.member(appearance, "profiles", appearance_pointer);
                      auto id = id_value ? decoder.id<CharacterAppearanceId>(
                                               *id_value, pointer_child(appearance_pointer, "id"))
                                         : std::nullopt;
                      auto profile_overrides =
                          profiles_value
                              ? decoder.array<CharacterProfileLayerOverrides>(
                                    *profiles_value, pointer_child(appearance_pointer, "profiles"),
                                    decode_profile_overrides)
                              : std::nullopt;
                      if (!id || !profile_overrides)
                          return std::nullopt;
                      decoder.duplicate_ids(
                          *profile_overrides, pointer_child(appearance_pointer, "profiles"),
                          [](const CharacterProfileLayerOverrides& item)
                              -> const CharacterPresentationProfileId& { return item.profile_id; });
                      return CharacterAppearance{std::move(*id), std::move(*profile_overrides)};
                  })
            : std::nullopt;
    auto gestures =
        gestures_value
            ? decoder.array<CharacterGesture>(
                  *gestures_value, pointer_child(pointer, "gestures"),
                  [&](const nlohmann::json& gesture,
                      const std::string& gesture_pointer) -> std::optional<CharacterGesture> {
                      if (!decoder.object(gesture, gesture_pointer, {"id", "profiles"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(gesture, "id", gesture_pointer);
                      const auto* profiles_value =
                          decoder.member(gesture, "profiles", gesture_pointer);
                      auto id = id_value ? decoder.id<CharacterGestureId>(
                                               *id_value, pointer_child(gesture_pointer, "id"))
                                         : std::nullopt;
                      auto gesture_profiles =
                          profiles_value
                              ? decoder.array<CharacterGestureProfile>(
                                    *profiles_value, pointer_child(gesture_pointer, "profiles"),
                                    [&](const nlohmann::json& profile,
                                        const std::string& profile_pointer)
                                        -> std::optional<CharacterGestureProfile> {
                                        if (!decoder.object(profile, profile_pointer,
                                                            {"clipId", "cues", "profileId"}))
                                            return std::nullopt;
                                        const auto* profile_id_value =
                                            decoder.member(profile, "profileId", profile_pointer);
                                        const auto* clip_id_value =
                                            decoder.member(profile, "clipId", profile_pointer);
                                        const auto* cues_value =
                                            decoder.member(profile, "cues", profile_pointer);
                                        auto profile_id =
                                            profile_id_value
                                                ? decoder.id<CharacterPresentationProfileId>(
                                                      *profile_id_value,
                                                      pointer_child(profile_pointer, "profileId"))
                                                : std::nullopt;
                                        auto clip_id =
                                            clip_id_value
                                                ? decoder.id<CharacterAnimationClipId>(
                                                      *clip_id_value,
                                                      pointer_child(profile_pointer, "clipId"))
                                                : std::nullopt;
                                        auto cues =
                                            cues_value
                                                ? decoder.array<CharacterGestureCue>(
                                                      *cues_value,
                                                      pointer_child(profile_pointer, "cues"),
                                                      [&](const nlohmann::json& cue,
                                                          const std::string& cue_pointer)
                                                          -> std::optional<CharacterGestureCue> {
                                                          if (!cue.is_object()) {
                                                              decoder.error(
                                                                  k_code_type,
                                                                  "Expected a gesture cue object.",
                                                                  cue_pointer);
                                                              return std::nullopt;
                                                          }
                                                          const auto* kind_value = decoder.member(
                                                              cue, "kind", cue_pointer);
                                                          auto kind =
                                                              kind_value
                                                                  ? decoder.string(
                                                                        *kind_value,
                                                                        pointer_child(cue_pointer,
                                                                                      "kind"))
                                                                  : std::nullopt;
                                                          if (!kind)
                                                              return std::nullopt;
                                                          if (*kind == "presentation") {
                                                              if (!decoder.object(cue, cue_pointer,
                                                                                  {"atMs", "event",
                                                                                   "id", "kind"}))
                                                                  return std::nullopt;
                                                              const auto* cue_id_value =
                                                                  decoder.member(cue, "id",
                                                                                 cue_pointer);
                                                              const auto* at_value = decoder.member(
                                                                  cue, "atMs", cue_pointer);
                                                              const auto* event_value =
                                                                  decoder.member(cue, "event",
                                                                                 cue_pointer);
                                                              auto cue_id =
                                                                  cue_id_value
                                                                      ? decoder.id<
                                                                            CharacterGestureCueId>(
                                                                            *cue_id_value,
                                                                            pointer_child(
                                                                                cue_pointer, "id"))
                                                                      : std::nullopt;
                                                              auto at =
                                                                  at_value
                                                                      ? decoder.unsigned_integer<
                                                                            std::uint64_t>(
                                                                            *at_value,
                                                                            pointer_child(
                                                                                cue_pointer,
                                                                                "atMs"))
                                                                      : std::nullopt;
                                                              auto event =
                                                                  event_value
                                                                      ? decoder.id<
                                                                            CharacterGestureEventId>(
                                                                            *event_value,
                                                                            pointer_child(
                                                                                cue_pointer,
                                                                                "event"))
                                                                      : std::nullopt;
                                                              if (!cue_id || !at || !event)
                                                                  return std::nullopt;
                                                              return CharacterPresentationGestureCue{
                                                                  std::move(*cue_id), *at,
                                                                  std::move(*event)};
                                                          }
                                                          if (*kind == "audio") {
                                                              if (!decoder.object(cue, cue_pointer,
                                                                                  {"asset", "atMs",
                                                                                   "gain", "id",
                                                                                   "kind", "pan"}))
                                                                  return std::nullopt;
                                                              const auto* cue_id_value =
                                                                  decoder.member(cue, "id",
                                                                                 cue_pointer);
                                                              const auto* at_value = decoder.member(
                                                                  cue, "atMs", cue_pointer);
                                                              const auto* asset_value =
                                                                  decoder.member(cue, "asset",
                                                                                 cue_pointer);
                                                              const auto* gain_value =
                                                                  decoder.member(cue, "gain",
                                                                                 cue_pointer);
                                                              const auto* pan_value =
                                                                  decoder.member(cue, "pan",
                                                                                 cue_pointer);
                                                              auto cue_id =
                                                                  cue_id_value
                                                                      ? decoder.id<
                                                                            CharacterGestureCueId>(
                                                                            *cue_id_value,
                                                                            pointer_child(
                                                                                cue_pointer, "id"))
                                                                      : std::nullopt;
                                                              auto at =
                                                                  at_value
                                                                      ? decoder.unsigned_integer<
                                                                            std::uint64_t>(
                                                                            *at_value,
                                                                            pointer_child(
                                                                                cue_pointer,
                                                                                "atMs"))
                                                                      : std::nullopt;
                                                              auto asset =
                                                                  asset_value
                                                                      ? decode_reference<AssetId>(
                                                                            decoder, *asset_value,
                                                                            pointer_child(
                                                                                cue_pointer,
                                                                                "asset"),
                                                                            "asset")
                                                                      : std::nullopt;
                                                              auto gain =
                                                                  gain_value
                                                                      ? decoder.finite_number(
                                                                            *gain_value,
                                                                            pointer_child(
                                                                                cue_pointer,
                                                                                "gain"))
                                                                      : std::nullopt;
                                                              auto pan =
                                                                  pan_value
                                                                      ? decoder.finite_number(
                                                                            *pan_value,
                                                                            pointer_child(
                                                                                cue_pointer, "pan"))
                                                                      : std::nullopt;
                                                              if (gain &&
                                                                  (*gain < 0.0 || *gain > 1.0)) {
                                                                  decoder.error(
                                                                      k_code_number,
                                                                      "Gesture audio gain must be "
                                                                      "in "
                                                                      "[0, 1].",
                                                                      pointer_child(cue_pointer,
                                                                                    "gain"));
                                                                  gain.reset();
                                                              }
                                                              if (pan &&
                                                                  (*pan < -1.0 || *pan > 1.0)) {
                                                                  decoder.error(
                                                                      k_code_number,
                                                                      "Gesture audio pan must be "
                                                                      "in "
                                                                      "[-1, 1].",
                                                                      pointer_child(cue_pointer,
                                                                                    "pan"));
                                                                  pan.reset();
                                                              }
                                                              if (!cue_id || !at || !asset ||
                                                                  !gain || !pan)
                                                                  return std::nullopt;
                                                              return CharacterAudioGestureCue{
                                                                  std::move(*cue_id), *at,
                                                                  std::move(*asset), *gain, *pan};
                                                          }
                                                          decoder.error(
                                                              k_code_variant,
                                                              "Unknown gesture cue variant '" +
                                                                  *kind + "'.",
                                                              pointer_child(cue_pointer, "kind"));
                                                          return std::nullopt;
                                                      })
                                                : std::nullopt;
                                        if (!profile_id || !clip_id || !cues)
                                            return std::nullopt;
                                        decoder.duplicate_ids(
                                            *cues, pointer_child(profile_pointer, "cues"),
                                            [](const CharacterGestureCue& cue)
                                                -> const CharacterGestureCueId& {
                                                return std::visit(
                                                    [](const auto& value)
                                                        -> const CharacterGestureCueId& {
                                                        return value.id;
                                                    },
                                                    cue);
                                            });
                                        return CharacterGestureProfile{std::move(*profile_id),
                                                                       std::move(*clip_id),
                                                                       std::move(*cues)};
                                    })
                              : std::nullopt;
                      if (!id || !gesture_profiles)
                          return std::nullopt;
                      decoder.duplicate_ids(
                          *gesture_profiles, pointer_child(gesture_pointer, "profiles"),
                          [](const CharacterGestureProfile& item)
                              -> const CharacterPresentationProfileId& { return item.profile_id; });
                      return CharacterGesture{std::move(*id), std::move(*gesture_profiles)};
                  })
            : std::optional<std::vector<CharacterGesture>>{std::in_place};
    auto idles =
        idles_value
            ? decoder.array<CharacterIdle>(
                  *idles_value, pointer_child(pointer, "idles"),
                  [&](const nlohmann::json& idle,
                      const std::string& idle_pointer) -> std::optional<CharacterIdle> {
                      if (!decoder.object(idle, idle_pointer,
                                          {"amplitude", "clock", "id", "kind", "periodMs"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(idle, "id", idle_pointer);
                      const auto* kind_value = decoder.member(idle, "kind", idle_pointer);
                      const auto* amplitude_value = decoder.member(idle, "amplitude", idle_pointer);
                      const auto* period_value = decoder.member(idle, "periodMs", idle_pointer);
                      const auto* clock_value = decoder.member(idle, "clock", idle_pointer);
                      auto id = id_value ? decoder.id<CharacterIdleId>(
                                               *id_value, pointer_child(idle_pointer, "id"))
                                         : std::nullopt;
                      auto kind = kind_value ? decoder.enumeration<CharacterIdleKind>(
                                                   *kind_value, pointer_child(idle_pointer, "kind"),
                                                   {{"bob", CharacterIdleKind::Bob},
                                                    {"sway", CharacterIdleKind::Sway},
                                                    {"pulse", CharacterIdleKind::Pulse}})
                                             : std::nullopt;
                      auto amplitude =
                          amplitude_value
                              ? decoder.finite_number(*amplitude_value,
                                                      pointer_child(idle_pointer, "amplitude"))
                              : std::nullopt;
                      if (amplitude && *amplitude < 0.0) {
                          decoder.error(k_code_number, "Idle amplitude must be non-negative.",
                                        pointer_child(idle_pointer, "amplitude"));
                          amplitude.reset();
                      }
                      auto period =
                          period_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *period_value, pointer_child(idle_pointer, "periodMs"))
                                       : std::nullopt;
                      if (period && *period == 0) {
                          decoder.error(k_code_number, "Idle period must be positive.",
                                        pointer_child(idle_pointer, "periodMs"));
                          period.reset();
                      }
                      auto clock =
                          clock_value
                              ? decode_presentation_clock(decoder, *clock_value,
                                                          pointer_child(idle_pointer, "clock"))
                              : std::nullopt;
                      if (id && kind && amplitude && period && clock)
                          return CharacterIdle{std::move(*id), *kind, *amplitude, *period, *clock};
                      return std::nullopt;
                  })
            : std::optional<std::vector<CharacterIdle>>{std::in_place};
    if (profiles)
        decoder.duplicate_ids(*profiles, pointer_child(pointer, "profiles"),
                              [](const CharacterPresentationProfile& profile)
                                  -> const CharacterPresentationProfileId& { return profile.id; });
    if (expressions)
        decoder.duplicate_ids(
            *expressions, pointer_child(pointer, "expressions"),
            [](const CharacterExpression& expression) -> const CharacterExpressionId& {
                return expression.id;
            });
    if (appearances)
        decoder.duplicate_ids(
            *appearances, pointer_child(pointer, "appearances"),
            [](const CharacterAppearance& appearance) -> const CharacterAppearanceId& {
                return appearance.id;
            });
    if (gestures)
        decoder.duplicate_ids(*gestures, pointer_child(pointer, "gestures"),
                              [](const CharacterGesture& gesture) -> const CharacterGestureId& {
                                  return gesture.id;
                              });
    if (idles)
        decoder.duplicate_ids(
            *idles, pointer_child(pointer, "idles"),
            [](const CharacterIdle& idle) -> const CharacterIdleId& { return idle.id; });
    auto inventories = inventories_value ? decode_inventories(decoder, *inventories_value,
                                                              pointer_child(pointer, "inventories"))
                                         : std::nullopt;
    std::optional<CharacterInitialWorldState> initial_world;
    if (initial_world_value &&
        decoder.object(*initial_world_value, pointer_child(pointer, "initialWorldState"),
                       {"enabled", "location", "visible"})) {
        const auto world_pointer = pointer_child(pointer, "initialWorldState");
        const auto* enabled_value = decoder.member(*initial_world_value, "enabled", world_pointer);
        const auto* location_value =
            decoder.member(*initial_world_value, "location", world_pointer);
        const auto* visible_value = decoder.member(*initial_world_value, "visible", world_pointer);
        auto enabled =
            enabled_value ? decoder.boolean(*enabled_value, pointer_child(world_pointer, "enabled"))
                          : std::nullopt;
        auto visible =
            visible_value ? decoder.boolean(*visible_value, pointer_child(world_pointer, "visible"))
                          : std::nullopt;
        std::optional<CharacterInitialWorldLocation> location;
        if (location_value) {
            const auto location_pointer = pointer_child(world_pointer, "location");
            if (!location_value->is_object()) {
                decoder.error(k_code_type, "Expected a character location object.",
                              location_pointer);
            } else {
                const auto* kind_value = decoder.member(*location_value, "kind", location_pointer);
                auto kind = kind_value ? decoder.string(*kind_value,
                                                        pointer_child(location_pointer, "kind"))
                                       : std::nullopt;
                if (kind && *kind == "unplaced" &&
                    decoder.object(*location_value, location_pointer, {"kind"})) {
                    location = UnplacedLocation{};
                } else if (kind && *kind == "room" &&
                           decoder.object(*location_value, location_pointer, {"kind", "room"})) {
                    const auto* room_value =
                        decoder.member(*location_value, "room", location_pointer);
                    auto room = room_value ? decode_reference<RoomId>(
                                                 decoder, *room_value,
                                                 pointer_child(location_pointer, "room"), "room")
                                           : std::nullopt;
                    if (room)
                        location = RoomLocation{std::move(*room)};
                } else if (kind) {
                    decoder.object(*location_value, location_pointer, {"kind"});
                    decoder.error(k_code_variant,
                                  "Unknown character location variant '" + *kind + "'.",
                                  pointer_child(location_pointer, "kind"));
                }
            }
        }
        if (enabled && visible && location)
            initial_world = CharacterInitialWorldState{std::move(*location), *enabled, *visible};
    }
    if (!identity || !display || !properties || !dialogue || !defaults || !profiles ||
        !expressions || !appearances || !gestures || !idles || !inventories || !initial_world)
        return std::nullopt;
    return CharacterDefinition{
        std::move(*identity),    std::move(*display),     std::move(*properties),
        std::move(*dialogue),    std::move(*defaults),    std::move(*profiles),
        std::move(*expressions), std::move(*appearances), std::move(*gestures),
        std::move(*idles),       std::move(*inventories), std::move(*initial_world)};
}

std::optional<RoomDefinition> decode_room(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"anchors",
                         "background",
                         "cast",
                         "description",
                         "displayName",
                         "environments",
                         "exits",
                         "fallbackInteractablePlacementId",
                         "features",
                         "hotspots",
                         "id",
                         "interactables",
                         "lifecycle",
                         "overlays",
                         "placements",
                         "presentationSpace",
                         "props",
                         "properties",
                         "propertyAssignments",
                         "scriptHooks",
                         "traits"}))
        return std::nullopt;
    auto identity = decode_identity<RoomId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* properties_value = decoder.member(value, "properties", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    const auto* background_value = decoder.member(value, "background", pointer);
    const auto* presentation_space_value = decoder.member(value, "presentationSpace", pointer);
    const auto* anchors_value = decoder.member(value, "anchors", pointer);
    const auto* lifecycle_value = decoder.member(value, "lifecycle", pointer);
    const auto* overlays_value = decoder.member(value, "overlays", pointer);
    const auto* placements_value = decoder.member(value, "placements", pointer);
    const auto* exits_value = decoder.member(value, "exits", pointer);
    const auto* features_value = decoder.member(value, "features", pointer);
    const auto* hotspots_value = decoder.member(value, "hotspots", pointer);
    const auto* cast_value = decoder.member(value, "cast", pointer);
    const auto* interactables_value = decoder.member(value, "interactables", pointer);
    const auto* fallback_interactable_placement_value =
        decoder.member(value, "fallbackInteractablePlacementId", pointer);
    const auto* props_value = decoder.member(value, "props", pointer);
    const auto* environments_value = json_access::member(value, "environments");
    const auto* script_hooks_value = decoder.member(value, "scriptHooks", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto properties = properties_value
                          ? decode_owner_contracts(decoder, *properties_value,
                                                   pointer_child(pointer, "properties"))
                          : std::nullopt;
    auto description = description_value ? decode_text(decoder, *description_value,
                                                       pointer_child(pointer, "description"))
                                         : std::nullopt;
    auto background = background_value ? decode_background(decoder, *background_value,
                                                           pointer_child(pointer, "background"))
                                       : std::nullopt;
    std::optional<RoomPlacementId> fallback_interactable_placement;
    bool fallback_interactable_placement_ok = fallback_interactable_placement_value != nullptr;
    if (fallback_interactable_placement_value &&
        !fallback_interactable_placement_value->is_null()) {
        fallback_interactable_placement =
            decoder.id<RoomPlacementId>(*fallback_interactable_placement_value,
                                        pointer_child(pointer, "fallbackInteractablePlacementId"));
        fallback_interactable_placement_ok = fallback_interactable_placement.has_value();
    }
    const auto decode_camera_view =
        [&decoder](const nlohmann::json& camera,
                   const std::string& camera_pointer) -> std::optional<CameraView> {
        if (!decoder.object(camera, camera_pointer, {"center", "rotationDegrees", "zoom"}))
            return std::nullopt;
        const auto* center_value = decoder.member(camera, "center", camera_pointer);
        const auto* zoom_value = decoder.member(camera, "zoom", camera_pointer);
        const auto* rotation_value = decoder.member(camera, "rotationDegrees", camera_pointer);
        auto center = center_value ? decode_vector2(decoder, *center_value,
                                                    pointer_child(camera_pointer, "center"))
                                   : std::nullopt;
        auto zoom = zoom_value
                        ? decoder.finite_number(*zoom_value, pointer_child(camera_pointer, "zoom"))
                        : std::nullopt;
        auto rotation =
            rotation_value ? decoder.finite_number(*rotation_value,
                                                   pointer_child(camera_pointer, "rotationDegrees"))
                           : std::nullopt;
        if (zoom && *zoom <= 0.0) {
            decoder.error(k_code_number, "Camera zoom must be positive.",
                          pointer_child(camera_pointer, "zoom"));
            zoom.reset();
        }
        if (!center || !zoom || !rotation)
            return std::nullopt;
        return CameraView{std::move(*center), *zoom, *rotation};
    };
    std::optional<WorldPresentationSpace> presentation_space;
    if (presentation_space_value &&
        decoder.object(*presentation_space_value, pointer_child(pointer, "presentationSpace"),
                       {"bounds", "defaultView", "edgePolicy", "size", "views"})) {
        const auto presentation_pointer = pointer_child(pointer, "presentationSpace");
        const auto* size_value =
            decoder.member(*presentation_space_value, "size", presentation_pointer);
        const auto* bounds_value =
            decoder.member(*presentation_space_value, "bounds", presentation_pointer);
        const auto* edge_policy_value =
            decoder.member(*presentation_space_value, "edgePolicy", presentation_pointer);
        const auto* default_view_value =
            decoder.member(*presentation_space_value, "defaultView", presentation_pointer);
        const auto* views_value =
            decoder.member(*presentation_space_value, "views", presentation_pointer);
        std::optional<Vector2> size;
        if (size_value && decoder.object(*size_value, pointer_child(presentation_pointer, "size"),
                                         {"height", "width"})) {
            const auto size_pointer = pointer_child(presentation_pointer, "size");
            const auto* width_value = decoder.member(*size_value, "width", size_pointer);
            const auto* height_value = decoder.member(*size_value, "height", size_pointer);
            auto width = width_value ? decoder.finite_number(*width_value,
                                                             pointer_child(size_pointer, "width"))
                                     : std::nullopt;
            auto height =
                height_value
                    ? decoder.finite_number(*height_value, pointer_child(size_pointer, "height"))
                    : std::nullopt;
            if (width && *width <= 0.0) {
                decoder.error(k_code_number, "Presentation Space width must be positive.",
                              pointer_child(size_pointer, "width"));
                width.reset();
            }
            if (height && *height <= 0.0) {
                decoder.error(k_code_number, "Presentation Space height must be positive.",
                              pointer_child(size_pointer, "height"));
                height.reset();
            }
            if (width && height)
                size = Vector2{*width, *height};
        }
        std::optional<WorldPresentationRect> bounds;
        bool bounds_ok = bounds_value != nullptr;
        if (bounds_value && !bounds_value->is_null() &&
            decoder.object(*bounds_value, pointer_child(presentation_pointer, "bounds"),
                           {"height", "width", "x", "y"})) {
            const auto bounds_pointer = pointer_child(presentation_pointer, "bounds");
            const auto* x_value = decoder.member(*bounds_value, "x", bounds_pointer);
            const auto* y_value = decoder.member(*bounds_value, "y", bounds_pointer);
            const auto* width_value = decoder.member(*bounds_value, "width", bounds_pointer);
            const auto* height_value = decoder.member(*bounds_value, "height", bounds_pointer);
            auto x = x_value ? decoder.finite_number(*x_value, pointer_child(bounds_pointer, "x"))
                             : std::nullopt;
            auto y = y_value ? decoder.finite_number(*y_value, pointer_child(bounds_pointer, "y"))
                             : std::nullopt;
            auto width = width_value ? decoder.finite_number(*width_value,
                                                             pointer_child(bounds_pointer, "width"))
                                     : std::nullopt;
            auto height =
                height_value
                    ? decoder.finite_number(*height_value, pointer_child(bounds_pointer, "height"))
                    : std::nullopt;
            if (width && *width <= 0.0) {
                decoder.error(k_code_number, "Presentation bounds width must be positive.",
                              pointer_child(bounds_pointer, "width"));
                width.reset();
            }
            if (height && *height <= 0.0) {
                decoder.error(k_code_number, "Presentation bounds height must be positive.",
                              pointer_child(bounds_pointer, "height"));
                height.reset();
            }
            if (x && y && width && height)
                bounds = WorldPresentationRect{*x, *y, *width, *height};
            else
                bounds_ok = false;
        }
        auto edge_policy =
            edge_policy_value
                ? decoder.enumeration<WorldPresentationEdgePolicy>(
                      *edge_policy_value, pointer_child(presentation_pointer, "edgePolicy"),
                      {{"contain", WorldPresentationEdgePolicy::Contain},
                       {"overscan", WorldPresentationEdgePolicy::Overscan}})
                : std::nullopt;
        auto default_view =
            default_view_value
                ? decode_camera_view(*default_view_value,
                                     pointer_child(presentation_pointer, "defaultView"))
                : std::nullopt;
        auto views =
            views_value
                ? decoder.array<NamedCameraView>(
                      *views_value, pointer_child(presentation_pointer, "views"),
                      [&](const nlohmann::json& item,
                          const std::string& item_pointer) -> std::optional<NamedCameraView> {
                          if (!decoder.object(item, item_pointer, {"id", "view"}))
                              return std::nullopt;
                          const auto* id_value = decoder.member(item, "id", item_pointer);
                          const auto* view_value = decoder.member(item, "view", item_pointer);
                          auto id = id_value ? decoder.id<CameraViewId>(
                                                   *id_value, pointer_child(item_pointer, "id"))
                                             : std::nullopt;
                          auto view = view_value
                                          ? decode_camera_view(*view_value,
                                                               pointer_child(item_pointer, "view"))
                                          : std::nullopt;
                          if (!id || !view)
                              return std::nullopt;
                          return NamedCameraView{std::move(*id), std::move(*view)};
                      })
                : std::nullopt;
        if (views)
            decoder.duplicate_ids(
                *views, pointer_child(presentation_pointer, "views"),
                [](const NamedCameraView& view) -> const CameraViewId& { return view.id; });
        if (size && bounds_ok && edge_policy && default_view && views)
            presentation_space =
                WorldPresentationSpace{std::move(*size), std::move(bounds), *edge_policy,
                                       std::move(*default_view), std::move(*views)};
    }
    auto anchors =
        anchors_value
            ? decoder.array<RoomAnchor>(
                  *anchors_value, pointer_child(pointer, "anchors"),
                  [&](const nlohmann::json& item,
                      const std::string& item_pointer) -> std::optional<RoomAnchor> {
                      if (!decoder.object(item, item_pointer, {"bounds", "id"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", item_pointer);
                      const auto* bounds_value = decoder.member(item, "bounds", item_pointer);
                      auto id = id_value ? decoder.id<RoomAnchorId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto bounds = bounds_value
                                        ? decode_rect(decoder, *bounds_value,
                                                      pointer_child(item_pointer, "bounds"))
                                        : std::nullopt;
                      if (!id || !bounds)
                          return std::nullopt;
                      return RoomAnchor{std::move(*id), std::move(*bounds)};
                  })
            : std::nullopt;
    if (anchors)
        decoder.duplicate_ids(
            *anchors, pointer_child(pointer, "anchors"),
            [](const RoomAnchor& anchor) -> const RoomAnchorId& { return anchor.id; });
    std::optional<RoomLifecycle> lifecycle;
    if (lifecycle_value && decoder.object(*lifecycle_value, pointer_child(pointer, "lifecycle"),
                                          {"canEnter", "canLeave"})) {
        const auto lifecycle_pointer = pointer_child(pointer, "lifecycle");
        const auto* enter_value = decoder.member(*lifecycle_value, "canEnter", lifecycle_pointer);
        const auto* leave_value = decoder.member(*lifecycle_value, "canLeave", lifecycle_pointer);
        auto enter = enter_value
                         ? decode_condition_impl(decoder, *enter_value,
                                                 pointer_child(lifecycle_pointer, "canEnter"))
                         : std::nullopt;
        auto leave = leave_value
                         ? decode_condition_impl(decoder, *leave_value,
                                                 pointer_child(lifecycle_pointer, "canLeave"))
                         : std::nullopt;
        if (enter && leave)
            lifecycle = RoomLifecycle{std::move(*enter), std::move(*leave)};
    }
    auto overlays =
        overlays_value
            ? decoder.array<RoomOverlay>(
                  *overlays_value, pointer_child(pointer, "overlays"),
                  [&](const nlohmann::json& overlay,
                      const std::string& item_pointer) -> std::optional<RoomOverlay> {
                      if (!decoder.object(overlay, item_pointer,
                                          {"condition", "id", "layout", "order", "visible"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(overlay, "id", item_pointer);
                      const auto* condition_value =
                          decoder.member(overlay, "condition", item_pointer);
                      const auto* visible_value = decoder.member(overlay, "visible", item_pointer);
                      const auto* order_value = decoder.member(overlay, "order", item_pointer);
                      const auto* layout_value = decoder.member(overlay, "layout", item_pointer);
                      auto id = id_value ? decoder.id<RoomOverlayId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto condition =
                          condition_value
                              ? decode_condition_impl(decoder, *condition_value,
                                                      pointer_child(item_pointer, "condition"))
                              : std::nullopt;
                      auto visible = visible_value
                                         ? decoder.boolean(*visible_value,
                                                           pointer_child(item_pointer, "visible"))
                                         : std::nullopt;
                      auto order = order_value ? decode_order(decoder, *order_value,
                                                              pointer_child(item_pointer, "order"))
                                               : std::nullopt;
                      auto layout = layout_value
                                        ? decode_reference<LayoutId>(
                                              decoder, *layout_value,
                                              pointer_child(item_pointer, "layout"), "layout")
                                        : std::nullopt;
                      if (id && layout && condition && visible && order)
                          return RoomOverlay{std::move(*id), std::move(*layout),
                                             std::move(*condition), *visible, *order};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto placements =
        placements_value
            ? decoder.array<RoomPlacement>(
                  *placements_value, pointer_child(pointer, "placements"),
                  [&](const nlohmann::json& placement,
                      const std::string& item_pointer) -> std::optional<RoomPlacement> {
                      if (!decoder.object(placement, item_pointer,
                                          {"bounds", "id", "order", "presentation"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(placement, "id", item_pointer);
                      const auto* order_value = decoder.member(placement, "order", item_pointer);
                      const auto* bounds_value = decoder.member(placement, "bounds", item_pointer);
                      const auto* presentation_value =
                          decoder.member(placement, "presentation", item_pointer);
                      auto id = id_value ? decoder.id<RoomPlacementId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto order = order_value ? decode_order(decoder, *order_value,
                                                              pointer_child(item_pointer, "order"))
                                               : std::nullopt;
                      auto bounds = bounds_value
                                        ? decode_rect(decoder, *bounds_value,
                                                      pointer_child(item_pointer, "bounds"))
                                        : std::nullopt;
                      std::optional<RoomPlacementPresentation> presentation;
                      if (presentation_value &&
                          decoder.object(*presentation_value,
                                         pointer_child(item_pointer, "presentation"),
                                         {"label", "layout"})) {
                          const auto presentation_pointer =
                              pointer_child(item_pointer, "presentation");
                          const auto* label_value =
                              decoder.member(*presentation_value, "label", presentation_pointer);
                          const auto* layout_value =
                              decoder.member(*presentation_value, "layout", presentation_pointer);
                          std::optional<TextContent> label;
                          bool label_ok = label_value != nullptr;
                          if (label_value && !label_value->is_null()) {
                              label = decode_text(decoder, *label_value,
                                                  pointer_child(presentation_pointer, "label"));
                              label_ok = label.has_value();
                          }
                          std::optional<LayoutId> layout;
                          bool layout_ok = layout_value != nullptr;
                          if (layout_value && !layout_value->is_null()) {
                              layout = decode_reference<LayoutId>(
                                  decoder, *layout_value,
                                  pointer_child(presentation_pointer, "layout"), "layout");
                              layout_ok = layout.has_value();
                          }
                          if (label_ok && layout_ok)
                              presentation =
                                  RoomPlacementPresentation{std::move(label), std::move(layout)};
                      }
                      if (id && order && bounds && presentation)
                          return RoomPlacement{std::move(*id), std::move(*bounds), *order,
                                               std::move(*presentation)};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto exits =
        exits_value
            ? decoder.array<RoomExit>(
                  *exits_value, pointer_child(pointer, "exits"),
                  [&](const nlohmann::json& exit,
                      const std::string& item_pointer) -> std::optional<RoomExit> {
                      if (!decoder.object(
                              exit, item_pointer,
                              {"condition", "direction", "id", "label", "target", "transition"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(exit, "id", item_pointer);
                      const auto* condition_value = decoder.member(exit, "condition", item_pointer);
                      const auto* direction_value = decoder.member(exit, "direction", item_pointer);
                      const auto* label_value = decoder.member(exit, "label", item_pointer);
                      const auto* target_value = decoder.member(exit, "target", item_pointer);
                      const auto* transition_value =
                          decoder.member(exit, "transition", item_pointer);
                      auto id = id_value ? decoder.id<RoomExitId>(*id_value,
                                                                  pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto condition =
                          condition_value
                              ? decode_condition_impl(decoder, *condition_value,
                                                      pointer_child(item_pointer, "condition"))
                              : std::nullopt;
                      auto direction =
                          direction_value
                              ? decoder.enumeration<RoomExitDirection>(
                                    *direction_value, pointer_child(item_pointer, "direction"),
                                    {{"northwest", RoomExitDirection::Northwest},
                                     {"north", RoomExitDirection::North},
                                     {"northeast", RoomExitDirection::Northeast},
                                     {"west", RoomExitDirection::West},
                                     {"east", RoomExitDirection::East},
                                     {"southwest", RoomExitDirection::Southwest},
                                     {"south", RoomExitDirection::South},
                                     {"southeast", RoomExitDirection::Southeast},
                                     {"custom", RoomExitDirection::Custom}})
                              : std::nullopt;
                      auto label = label_value ? decode_text(decoder, *label_value,
                                                             pointer_child(item_pointer, "label"))
                                               : std::nullopt;
                      auto target = target_value
                                        ? decode_reference<RoomId>(
                                              decoder, *target_value,
                                              pointer_child(item_pointer, "target"), "room")
                                        : std::nullopt;
                      std::optional<RoomNavigationTransition> transition;
                      bool transition_ok = transition_value != nullptr;
                      if (transition_value && !transition_value->is_null()) {
                          transition = decode_navigation_transition(
                              decoder, *transition_value,
                              pointer_child(item_pointer, "transition"));
                          transition_ok = transition.has_value();
                      }
                      if (id && condition && direction && label && target && transition_ok)
                          return RoomExit{std::move(*id),     std::move(*condition),
                                          *direction,         std::move(*label),
                                          std::move(*target), std::move(transition)};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto features =
        features_value
            ? decoder.array<FeatureDefinition>(
                  *features_value, pointer_child(pointer, "features"),
                  [&](const nlohmann::json& feature,
                      const std::string& item_pointer) -> std::optional<FeatureDefinition> {
                      return decode_feature(decoder, feature, item_pointer);
                  })
            : std::nullopt;
    auto hotspots =
        hotspots_value
            ? decoder.array<RoomHotspot>(
                  *hotspots_value, pointer_child(pointer, "hotspots"),
                  [&](const nlohmann::json& hotspot,
                      const std::string& item_pointer) -> std::optional<RoomHotspot> {
                      if (!decoder.object(hotspot, item_pointer,
                                          {"condition", "highlight", "id", "inputOrder", "label",
                                           "shape", "target"}))
                          return std::nullopt;
                      auto common = decode_hotspot_common(decoder, hotspot, item_pointer);
                      const auto* shape_value = decoder.member(hotspot, "shape", item_pointer);
                      const auto* target_value = decoder.member(hotspot, "target", item_pointer);
                      auto shape =
                          shape_value
                              ? decode_rect_hotspot_shape(decoder, *shape_value,
                                                          pointer_child(item_pointer, "shape"))
                              : std::nullopt;
                      auto target =
                          target_value
                              ? decode_room_hotspot_target(decoder, *target_value,
                                                           pointer_child(item_pointer, "target"))
                              : std::nullopt;
                      if (!common || !shape || !target)
                          return std::nullopt;
                      return RoomHotspot{std::move(common->id),
                                         std::move(common->label),
                                         std::move(common->condition),
                                         common->input_order,
                                         std::move(common->highlight),
                                         std::move(*shape),
                                         std::move(*target)};
                  })
            : std::nullopt;
    auto cast =
        cast_value
            ? decoder.array<RoomCastEntry>(
                  *cast_value, pointer_child(pointer, "cast"),
                  [&](const nlohmann::json& item,
                      const std::string& item_pointer) -> std::optional<RoomCastEntry> {
                      if (!decoder.object(item, item_pointer,
                                          {"appearanceId", "character", "condition", "expressionId",
                                           "id", "idleId", "order", "placementId", "poseId",
                                           "profileId", "visible"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", item_pointer);
                      const auto* character_value = decoder.member(item, "character", item_pointer);
                      const auto* condition_value = decoder.member(item, "condition", item_pointer);
                      const auto* placement_value =
                          decoder.member(item, "placementId", item_pointer);
                      const auto* profile_value = decoder.member(item, "profileId", item_pointer);
                      const auto* pose_value = decoder.member(item, "poseId", item_pointer);
                      const auto* expression_value =
                          decoder.member(item, "expressionId", item_pointer);
                      const auto* appearance_value =
                          decoder.member(item, "appearanceId", item_pointer);
                      const auto* idle_value = json_access::member(item, "idleId");
                      const auto* visible_value = decoder.member(item, "visible", item_pointer);
                      const auto* order_value = decoder.member(item, "order", item_pointer);
                      auto id = id_value ? decoder.id<RoomCastEntryId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto character =
                          character_value
                              ? decode_reference<CharacterId>(
                                    decoder, *character_value,
                                    pointer_child(item_pointer, "character"), "character")
                              : std::nullopt;
                      auto condition =
                          condition_value
                              ? decode_condition_impl(decoder, *condition_value,
                                                      pointer_child(item_pointer, "condition"))
                              : std::nullopt;
                      auto placement =
                          placement_value
                              ? decoder.id<RoomPlacementId>(
                                    *placement_value, pointer_child(item_pointer, "placementId"))
                              : std::nullopt;
                      auto visible = visible_value
                                         ? decoder.boolean(*visible_value,
                                                           pointer_child(item_pointer, "visible"))
                                         : std::nullopt;
                      auto order = order_value ? decode_order(decoder, *order_value,
                                                              pointer_child(item_pointer, "order"))
                                               : std::nullopt;
                      std::optional<CharacterPresentationProfileId> profile;
                      bool profile_ok = profile_value != nullptr;
                      if (profile_value && !profile_value->is_null()) {
                          profile = decoder.id<CharacterPresentationProfileId>(
                              *profile_value, pointer_child(item_pointer, "profileId"));
                          profile_ok = profile.has_value();
                      }
                      std::optional<CharacterPoseId> pose;
                      bool pose_ok = pose_value != nullptr;
                      if (pose_value && !pose_value->is_null()) {
                          pose = decoder.id<CharacterPoseId>(*pose_value,
                                                             pointer_child(item_pointer, "poseId"));
                          pose_ok = pose.has_value();
                      }
                      std::optional<CharacterExpressionId> expression;
                      bool expression_ok = expression_value != nullptr;
                      if (expression_value && !expression_value->is_null()) {
                          expression = decoder.id<CharacterExpressionId>(
                              *expression_value, pointer_child(item_pointer, "expressionId"));
                          expression_ok = expression.has_value();
                      }
                      std::optional<CharacterAppearanceId> appearance;
                      bool appearance_ok = appearance_value != nullptr;
                      if (appearance_value && !appearance_value->is_null()) {
                          appearance = decoder.id<CharacterAppearanceId>(
                              *appearance_value, pointer_child(item_pointer, "appearanceId"));
                          appearance_ok = appearance.has_value();
                      }
                      std::optional<CharacterIdleId> idle;
                      bool idle_ok = true;
                      if (idle_value && !idle_value->is_null()) {
                          idle = decoder.id<CharacterIdleId>(*idle_value,
                                                             pointer_child(item_pointer, "idleId"));
                          idle_ok = idle.has_value();
                      }
                      if (id && character && condition && placement && visible && order &&
                          profile_ok && pose_ok && expression_ok && appearance_ok && idle_ok)
                          return RoomCastEntry{std::move(*id),
                                               std::move(*character),
                                               std::move(*condition),
                                               std::move(*placement),
                                               std::move(profile),
                                               std::move(pose),
                                               std::move(expression),
                                               std::move(appearance),
                                               std::move(idle),
                                               *visible,
                                               *order};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto interactables =
        interactables_value
            ? decoder.array<RoomInteractableEntry>(
                  *interactables_value, pointer_child(pointer, "interactables"),
                  [&](const nlohmann::json& item,
                      const std::string& item_pointer) -> std::optional<RoomInteractableEntry> {
                      if (!decoder.object(item, item_pointer,
                                          {"condition", "id", "interactable", "order",
                                           "placementId", "visible"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", item_pointer);
                      const auto* interactable_value =
                          decoder.member(item, "interactable", item_pointer);
                      const auto* condition_value = decoder.member(item, "condition", item_pointer);
                      const auto* placement_value =
                          decoder.member(item, "placementId", item_pointer);
                      const auto* visible_value = decoder.member(item, "visible", item_pointer);
                      const auto* order_value = decoder.member(item, "order", item_pointer);
                      auto id = id_value ? decoder.id<RoomInteractableEntryId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto interactable =
                          interactable_value
                              ? decode_reference<InteractableInstanceId>(
                                    decoder, *interactable_value,
                                    pointer_child(item_pointer, "interactable"), "interactable")
                              : std::nullopt;
                      auto condition =
                          condition_value
                              ? decode_condition_impl(decoder, *condition_value,
                                                      pointer_child(item_pointer, "condition"))
                              : std::nullopt;
                      auto placement =
                          placement_value
                              ? decoder.id<RoomPlacementId>(
                                    *placement_value, pointer_child(item_pointer, "placementId"))
                              : std::nullopt;
                      auto visible = visible_value
                                         ? decoder.boolean(*visible_value,
                                                           pointer_child(item_pointer, "visible"))
                                         : std::nullopt;
                      auto order = order_value ? decode_order(decoder, *order_value,
                                                              pointer_child(item_pointer, "order"))
                                               : std::nullopt;
                      if (id && interactable && condition && placement && visible && order)
                          return RoomInteractableEntry{std::move(*id),
                                                       std::move(*interactable),
                                                       std::move(*condition),
                                                       std::move(*placement),
                                                       *visible,
                                                       *order};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto environments =
        environments_value
            ? decoder.array<RoomEnvironment>(
                  *environments_value, pointer_child(pointer, "environments"),
                  [&](const nlohmann::json& item,
                      const std::string& item_pointer) -> std::optional<RoomEnvironment> {
                      if (!decoder.object(item, item_pointer,
                                          {"asset", "bounds", "clock", "condition", "id",
                                           "material", "opacity", "order", "plane",
                                           "scrollPerSecond", "visible"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", item_pointer);
                      const auto* condition_value = decoder.member(item, "condition", item_pointer);
                      const auto* asset_value = decoder.member(item, "asset", item_pointer);
                      const auto* material_value = decoder.member(item, "material", item_pointer);
                      const auto* bounds_value = decoder.member(item, "bounds", item_pointer);
                      const auto* plane_value = decoder.member(item, "plane", item_pointer);
                      const auto* order_value = decoder.member(item, "order", item_pointer);
                      const auto* clock_value = decoder.member(item, "clock", item_pointer);
                      const auto* scroll_value =
                          decoder.member(item, "scrollPerSecond", item_pointer);
                      const auto* opacity_value = decoder.member(item, "opacity", item_pointer);
                      const auto* visible_value = decoder.member(item, "visible", item_pointer);
                      auto id = id_value ? decoder.id<RoomEnvironmentId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto condition =
                          condition_value
                              ? decode_condition_impl(decoder, *condition_value,
                                                      pointer_child(item_pointer, "condition"))
                              : std::nullopt;
                      std::optional<AssetId> asset;
                      bool asset_ok = asset_value != nullptr;
                      if (asset_value && !asset_value->is_null()) {
                          asset = decode_reference<AssetId>(
                              decoder, *asset_value, pointer_child(item_pointer, "asset"), "asset");
                          asset_ok = asset.has_value();
                      }
                      auto material = material_value
                                          ? decode_reference<MaterialId>(
                                                decoder, *material_value,
                                                pointer_child(item_pointer, "material"), "material")
                                          : std::nullopt;
                      auto bounds = bounds_value
                                        ? decode_rect(decoder, *bounds_value,
                                                      pointer_child(item_pointer, "bounds"))
                                        : std::nullopt;
                      auto plane = plane_value
                                       ? decode_world_plane(decoder, *plane_value,
                                                            pointer_child(item_pointer, "plane"))
                                       : std::nullopt;
                      auto order = order_value ? decode_order(decoder, *order_value,
                                                              pointer_child(item_pointer, "order"))
                                               : std::nullopt;
                      auto clock =
                          clock_value
                              ? decode_presentation_clock(decoder, *clock_value,
                                                          pointer_child(item_pointer, "clock"))
                              : std::nullopt;
                      auto scroll =
                          scroll_value
                              ? decode_vector2(decoder, *scroll_value,
                                               pointer_child(item_pointer, "scrollPerSecond"))
                              : std::nullopt;
                      auto opacity =
                          opacity_value
                              ? decoder.finite_number(*opacity_value,
                                                      pointer_child(item_pointer, "opacity"))
                              : std::nullopt;
                      if (opacity && (*opacity < 0.0 || *opacity > 1.0)) {
                          decoder.error(k_code_number, "Environment opacity must be in [0, 1].",
                                        pointer_child(item_pointer, "opacity"));
                          opacity.reset();
                      }
                      auto visible = visible_value
                                         ? decoder.boolean(*visible_value,
                                                           pointer_child(item_pointer, "visible"))
                                         : std::nullopt;
                      if (id && condition && asset_ok && material && bounds && plane && order &&
                          clock && scroll && opacity && visible)
                          return RoomEnvironment{std::move(*id),
                                                 std::move(*condition),
                                                 std::move(asset),
                                                 std::move(*material),
                                                 std::move(*bounds),
                                                 *plane,
                                                 *order,
                                                 *clock,
                                                 std::move(*scroll),
                                                 *opacity,
                                                 *visible};
                      return std::nullopt;
                  })
            : std::optional<std::vector<RoomEnvironment>>{std::in_place};
    auto props =
        props_value
            ? decoder.array<RoomProp>(
                  *props_value, pointer_child(pointer, "props"),
                  [&](const nlohmann::json& item,
                      const std::string& item_pointer) -> std::optional<RoomProp> {
                      if (!decoder.object(item, item_pointer,
                                          {"asset", "condition", "id", "material", "order",
                                           "placementId", "visible"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", item_pointer);
                      const auto* condition_value = decoder.member(item, "condition", item_pointer);
                      const auto* placement_value =
                          decoder.member(item, "placementId", item_pointer);
                      const auto* asset_value = decoder.member(item, "asset", item_pointer);
                      const auto* material_value = decoder.member(item, "material", item_pointer);
                      const auto* visible_value = decoder.member(item, "visible", item_pointer);
                      const auto* order_value = decoder.member(item, "order", item_pointer);
                      auto id = id_value ? decoder.id<RoomPropId>(*id_value,
                                                                  pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto condition =
                          condition_value
                              ? decode_condition_impl(decoder, *condition_value,
                                                      pointer_child(item_pointer, "condition"))
                              : std::nullopt;
                      auto placement =
                          placement_value
                              ? decoder.id<RoomPlacementId>(
                                    *placement_value, pointer_child(item_pointer, "placementId"))
                              : std::nullopt;
                      auto visible = visible_value
                                         ? decoder.boolean(*visible_value,
                                                           pointer_child(item_pointer, "visible"))
                                         : std::nullopt;
                      auto order = order_value ? decode_order(decoder, *order_value,
                                                              pointer_child(item_pointer, "order"))
                                               : std::nullopt;
                      std::optional<AssetId> asset;
                      bool asset_ok = asset_value != nullptr;
                      if (asset_value && !asset_value->is_null()) {
                          asset = decode_reference<AssetId>(
                              decoder, *asset_value, pointer_child(item_pointer, "asset"), "asset");
                          asset_ok = asset.has_value();
                      }
                      std::optional<MaterialId> material;
                      bool material_ok = material_value != nullptr;
                      if (material_value && !material_value->is_null()) {
                          material = decode_reference<MaterialId>(
                              decoder, *material_value, pointer_child(item_pointer, "material"),
                              "material");
                          material_ok = material.has_value();
                      }
                      if (id && condition && placement && visible && order && asset_ok &&
                          material_ok && (asset || material))
                          return RoomProp{std::move(*id),
                                          std::move(*condition),
                                          std::move(*placement),
                                          std::move(asset),
                                          std::move(material),
                                          *visible,
                                          *order};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto script_hooks =
        script_hooks_value
            ? decoder.array<RoomScriptHookMapping>(
                  *script_hooks_value, pointer_child(pointer, "scriptHooks"),
                  [&](const nlohmann::json& mapping,
                      const std::string& mapping_pointer) -> std::optional<RoomScriptHookMapping> {
                      if (!decoder.object(mapping, mapping_pointer, {"handler", "hook"}))
                          return std::nullopt;
                      const auto* hook_value = decoder.member(mapping, "hook", mapping_pointer);
                      const auto* handler_value =
                          decoder.member(mapping, "handler", mapping_pointer);
                      auto hook = hook_value
                                      ? decoder.enumeration<RoomScriptHookKind>(
                                            *hook_value, pointer_child(mapping_pointer, "hook"),
                                            {{"can-enter", RoomScriptHookKind::CanEnter},
                                             {"can-leave", RoomScriptHookKind::CanLeave},
                                             {"reject-enter", RoomScriptHookKind::RejectEnter},
                                             {"reject-leave", RoomScriptHookKind::RejectLeave},
                                             {"before-enter", RoomScriptHookKind::BeforeEnter},
                                             {"after-enter", RoomScriptHookKind::AfterEnter},
                                             {"before-leave", RoomScriptHookKind::BeforeLeave},
                                             {"after-leave", RoomScriptHookKind::AfterLeave},
                                             {"compose", RoomScriptHookKind::Compose}})
                                      : std::nullopt;
                      if (!handler_value ||
                          !decoder.object(*handler_value, pointer_child(mapping_pointer, "handler"),
                                          {"export", "module"}))
                          return std::nullopt;
                      const auto handler_pointer = pointer_child(mapping_pointer, "handler");
                      const auto* module_value =
                          decoder.member(*handler_value, "module", handler_pointer);
                      const auto* export_value =
                          decoder.member(*handler_value, "export", handler_pointer);
                      auto module = module_value
                                        ? decode_reference<ScriptId>(
                                              decoder, *module_value,
                                              pointer_child(handler_pointer, "module"), "script")
                                        : std::nullopt;
                      auto export_name =
                          export_value ? decoder.string(*export_value,
                                                        pointer_child(handler_pointer, "export"),
                                                        false, true)
                                       : std::nullopt;
                      if (!hook || !module || !export_name)
                          return std::nullopt;
                      return RoomScriptHookMapping{
                          *hook,
                          ScriptHookHandlerReference{std::move(*module), std::move(*export_name)}};
                  })
            : std::nullopt;
    if (overlays)
        decoder.duplicate_ids(
            *overlays, pointer_child(pointer, "overlays"),
            [](const RoomOverlay& overlay) -> const RoomOverlayId& { return overlay.id; });
    if (placements)
        decoder.duplicate_ids(
            *placements, pointer_child(pointer, "placements"),
            [](const RoomPlacement& placement) -> const RoomPlacementId& { return placement.id; });
    if (exits)
        decoder.duplicate_ids(*exits, pointer_child(pointer, "exits"),
                              [](const RoomExit& exit) -> const RoomExitId& { return exit.id; });
    if (features)
        decoder.duplicate_ids(*features, pointer_child(pointer, "features"),
                              [](const FeatureDefinition& feature) -> const FeatureId& {
                                  return feature.identity.id;
                              });
    if (hotspots)
        decoder.duplicate_ids(
            *hotspots, pointer_child(pointer, "hotspots"),
            [](const RoomHotspot& hotspot) -> const HotspotId& { return hotspot.id; });
    if (cast)
        decoder.duplicate_ids(
            *cast, pointer_child(pointer, "cast"),
            [](const RoomCastEntry& entry) -> const RoomCastEntryId& { return entry.id; });
    if (interactables)
        decoder.duplicate_ids(
            *interactables, pointer_child(pointer, "interactables"),
            [](const RoomInteractableEntry& entry) -> const RoomInteractableEntryId& {
                return entry.id;
            });
    if (props)
        decoder.duplicate_ids(*props, pointer_child(pointer, "props"),
                              [](const RoomProp& prop) -> const RoomPropId& { return prop.id; });
    if (environments)
        decoder.duplicate_ids(*environments, pointer_child(pointer, "environments"),
                              [](const RoomEnvironment& environment) -> const RoomEnvironmentId& {
                                  return environment.id;
                              });
    if (!identity || !display || !properties || !description || !background ||
        !presentation_space || !anchors || !lifecycle || !overlays || !placements || !exits ||
        !features || !hotspots || !cast || !interactables || !props || !environments ||
        !script_hooks || !fallback_interactable_placement_ok)
        return std::nullopt;
    return RoomDefinition{std::move(*identity),      std::move(*display),
                          std::move(*properties),    std::move(*description),
                          std::move(*background),    std::move(*presentation_space),
                          std::move(*anchors),       std::move(*lifecycle),
                          std::move(*overlays),      std::move(*cast),
                          std::move(*interactables), std::move(fallback_interactable_placement),
                          std::move(*props),         std::move(*environments),
                          std::move(*script_hooks),  std::move(*placements),
                          std::move(*exits),         std::move(*features),
                          std::move(*hotspots)};
}

std::optional<InteractableDefinition>
decode_interactable(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"displayName", "features", "id", "inventories", "presentation",
                         "properties", "propertyAssignments", "stackLimit", "stackable", "traits"}))
        return std::nullopt;
    auto identity = decode_identity<InteractableDefinitionId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* properties_value = decoder.member(value, "properties", pointer);
    const auto* features_value = decoder.member(value, "features", pointer);
    const auto* inventories_value = decoder.member(value, "inventories", pointer);
    const auto* presentation_value = decoder.member(value, "presentation", pointer);
    const auto* stackable_value = decoder.member(value, "stackable", pointer);
    const auto* stack_limit_value = decoder.member(value, "stackLimit", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto stackable = stackable_value
                         ? decoder.boolean(*stackable_value, pointer_child(pointer, "stackable"))
                         : std::nullopt;
    std::optional<std::uint64_t> stack_limit;
    bool stack_limit_ok = stack_limit_value != nullptr;
    if (stack_limit_value && !stack_limit_value->is_null()) {
        stack_limit = decoder.unsigned_integer<std::uint64_t>(
            *stack_limit_value, pointer_child(pointer, "stackLimit"), true);
        stack_limit_ok = stack_limit.has_value() && *stack_limit <= max_interactable_quantity;
        if (stack_limit && *stack_limit > max_interactable_quantity)
            decoder.error(k_code_number,
                          "Interactable quantity exceeds the portable numeric range.",
                          pointer_child(pointer, "stackLimit"));
    }
    auto properties =
        properties_value
            ? decoder.array<TraitProperty>(
                  *properties_value, pointer_child(pointer, "properties"),
                  [&](const nlohmann::json& property,
                      const std::string& item_pointer) -> std::optional<TraitProperty> {
                      return decode_owner_property_contract(decoder, property, item_pointer);
                  })
            : std::nullopt;
    auto features =
        features_value
            ? decoder.array<FeatureDefinition>(
                  *features_value, pointer_child(pointer, "features"),
                  [&](const nlohmann::json& feature,
                      const std::string& item_pointer) -> std::optional<FeatureDefinition> {
                      return decode_feature(decoder, feature, item_pointer);
                  })
            : std::nullopt;
    auto inventories = inventories_value ? decode_inventories(decoder, *inventories_value,
                                                              pointer_child(pointer, "inventories"))
                                         : std::nullopt;
    std::optional<InteractablePresentation> presentation;
    if (presentation_value &&
        decoder.object(*presentation_value, pointer_child(pointer, "presentation"),
                       {"hotspots", "material", "sprite"})) {
        const auto presentation_pointer = pointer_child(pointer, "presentation");
        const auto* material_value =
            decoder.member(*presentation_value, "material", presentation_pointer);
        const auto* sprite_value =
            decoder.member(*presentation_value, "sprite", presentation_pointer);
        const auto* hotspots_value =
            decoder.member(*presentation_value, "hotspots", presentation_pointer);
        std::optional<MaterialId> material;
        bool material_ok = material_value != nullptr;
        if (material_value && !material_value->is_null()) {
            material = decode_reference<MaterialId>(decoder, *material_value,
                                                    pointer_child(presentation_pointer, "material"),
                                                    "material");
            material_ok = material.has_value();
        }
        std::optional<AssetId> sprite;
        bool sprite_ok = sprite_value != nullptr;
        if (sprite_value && !sprite_value->is_null()) {
            sprite = decode_reference<AssetId>(
                decoder, *sprite_value, pointer_child(presentation_pointer, "sprite"), "asset");
            sprite_ok = sprite.has_value();
        }
        std::optional<InteractableHotspots> hotspots;
        if (hotspots_value && hotspots_value->is_object()) {
            const auto hotspots_pointer = pointer_child(presentation_pointer, "hotspots");
            const auto* kind_value = decoder.member(*hotspots_value, "kind", hotspots_pointer);
            auto kind = kind_value
                            ? decoder.string(*kind_value, pointer_child(hotspots_pointer, "kind"))
                            : std::nullopt;
            auto decode_behavior = [&](const nlohmann::json& behavior,
                                       const std::string& behavior_pointer)
                -> std::optional<InteractableHotspotBehavior> {
                if (!decoder.object(
                        behavior, behavior_pointer,
                        {"condition", "highlight", "id", "inputOrder", "label", "target"}))
                    return std::nullopt;
                auto common = decode_hotspot_common(decoder, behavior, behavior_pointer);
                const auto* target_value = decoder.member(behavior, "target", behavior_pointer);
                auto target = target_value ? decode_interactable_hotspot_target(
                                                 decoder, *target_value,
                                                 pointer_child(behavior_pointer, "target"))
                                           : std::nullopt;
                if (!common || !target)
                    return std::nullopt;
                return InteractableHotspotBehavior{
                    std::move(common->id),        std::move(common->label),
                    std::move(common->condition), common->input_order,
                    std::move(common->highlight), std::move(*target)};
            };
            if (kind && *kind == "none" &&
                decoder.object(*hotspots_value, hotspots_pointer, {"kind"})) {
                hotspots = NoInteractableHotspots{};
            } else if (kind && *kind == "sprite-alpha" &&
                       decoder.object(*hotspots_value, hotspots_pointer, {"hotspot", "kind"})) {
                const auto* hotspot_value =
                    decoder.member(*hotspots_value, "hotspot", hotspots_pointer);
                auto hotspot = hotspot_value
                                   ? decode_behavior(*hotspot_value,
                                                     pointer_child(hotspots_pointer, "hotspot"))
                                   : std::nullopt;
                if (hotspot)
                    hotspots = SpriteAlphaHotspots{std::move(*hotspot)};
            } else if (kind && *kind == "custom" &&
                       decoder.object(*hotspots_value, hotspots_pointer, {"hotspots", "kind"})) {
                const auto* items_value =
                    decoder.member(*hotspots_value, "hotspots", hotspots_pointer);
                auto items =
                    items_value
                        ? decoder.array<InteractableCustomHotspot>(
                              *items_value, pointer_child(hotspots_pointer, "hotspots"),
                              [&](const nlohmann::json& item, const std::string& item_pointer)
                                  -> std::optional<InteractableCustomHotspot> {
                                  if (!decoder.object(item, item_pointer,
                                                      {"condition", "highlight", "id", "inputOrder",
                                                       "label", "shape", "target"}))
                                      return std::nullopt;
                                  auto common = decode_hotspot_common(decoder, item, item_pointer);
                                  const auto* target_value =
                                      decoder.member(item, "target", item_pointer);
                                  const auto* shape_value =
                                      decoder.member(item, "shape", item_pointer);
                                  auto target = target_value
                                                    ? decode_interactable_hotspot_target(
                                                          decoder, *target_value,
                                                          pointer_child(item_pointer, "target"))
                                                    : std::nullopt;
                                  auto shape = shape_value
                                                   ? decode_rect_hotspot_shape(
                                                         decoder, *shape_value,
                                                         pointer_child(item_pointer, "shape"))
                                                   : std::nullopt;
                                  if (!common || !target || !shape)
                                      return std::nullopt;
                                  InteractableCustomHotspot result{
                                      {std::move(common->id), std::move(common->label),
                                       std::move(common->condition), common->input_order,
                                       std::move(common->highlight), std::move(*target)},
                                      std::move(*shape)};
                                  return result;
                              })
                        : std::nullopt;
                if (items) {
                    decoder.duplicate_ids(
                        *items, pointer_child(hotspots_pointer, "hotspots"),
                        [](const InteractableCustomHotspot& hotspot) -> const HotspotId& {
                            return hotspot.id;
                        });
                    hotspots = CustomInteractableHotspots{std::move(*items)};
                }
            }
        }
        if (material_ok && sprite_ok && hotspots)
            presentation = InteractablePresentation{std::move(material), std::move(sprite),
                                                    std::move(*hotspots)};
    }
    if (features)
        decoder.duplicate_ids(*features, pointer_child(pointer, "features"),
                              [](const FeatureDefinition& feature) -> const FeatureId& {
                                  return feature.identity.id;
                              });
    if (properties)
        decoder.duplicate_ids(*properties, pointer_child(pointer, "properties"),
                              [](const TraitProperty& property) -> const PropertyId& {
                                  return property.property_id;
                              });
    if (!identity || !display || !stackable || !stack_limit_ok || !properties || !features ||
        !inventories || !presentation)
        return std::nullopt;
    if (!*stackable && stack_limit)
        decoder.error(k_code_variant, "Non-stackable Interactable cannot declare a Stack limit.",
                      pointer_child(pointer, "stackLimit"));
    return InteractableDefinition{
        std::move(*identity),    std::move(*display),     *stackable,
        std::move(stack_limit),  std::move(*properties),  std::move(*features),
        std::move(*inventories), std::move(*presentation)};
}

std::optional<ItemDefinition> decode_item_definition(Decoder& decoder, const nlohmann::json& value,
                                                     std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"description", "displayName", "id", "presentation", "propertyAssignments",
                         "stackLimit", "traits"}))
        return std::nullopt;
    auto identity = decode_identity<ItemDefinitionId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    const auto* presentation_value = decoder.member(value, "presentation", pointer);
    const auto* limit_value = decoder.member(value, "stackLimit", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto description = description_value ? decoder.string(*description_value,
                                                          pointer_child(pointer, "description"))
                                         : std::nullopt;

    std::optional<ItemDefinitionPresentation> presentation;
    if (presentation_value &&
        decoder.object(*presentation_value, pointer_child(pointer, "presentation"),
                       {"material", "sprite"})) {
        const auto presentation_pointer = pointer_child(pointer, "presentation");
        const auto* material_value =
            decoder.member(*presentation_value, "material", presentation_pointer);
        const auto* sprite_value =
            decoder.member(*presentation_value, "sprite", presentation_pointer);
        std::optional<MaterialId> material;
        bool material_ok = material_value != nullptr;
        if (material_value && !material_value->is_null()) {
            material = decode_reference<MaterialId>(decoder, *material_value,
                                                    pointer_child(presentation_pointer, "material"),
                                                    "material");
            material_ok = material.has_value();
        }
        std::optional<AssetId> sprite;
        bool sprite_ok = sprite_value != nullptr;
        if (sprite_value && !sprite_value->is_null()) {
            sprite = decode_reference<AssetId>(
                decoder, *sprite_value, pointer_child(presentation_pointer, "sprite"), "asset");
            sprite_ok = sprite.has_value();
        }
        if (material_ok && sprite_ok)
            presentation = ItemDefinitionPresentation{std::move(material), std::move(sprite)};
    }

    std::optional<std::uint64_t> stack_limit;
    bool limit_ok = limit_value != nullptr;
    if (limit_value && !limit_value->is_null()) {
        stack_limit = decoder.unsigned_integer<std::uint64_t>(
            *limit_value, pointer_child(pointer, "stackLimit"), true);
        limit_ok = stack_limit.has_value() && *stack_limit <= max_item_stack_quantity;
        if (stack_limit && *stack_limit > max_item_stack_quantity)
            decoder.error(k_code_number, "Item Stack quantity exceeds the portable numeric range.",
                          pointer_child(pointer, "stackLimit"));
    }
    if (!identity || !display || !description || !presentation || !limit_ok)
        return std::nullopt;
    return ItemDefinition{std::move(*identity), std::move(*display), std::move(*description),
                          std::move(*presentation), stack_limit};
}

std::optional<ArchetypeDefinition> decode_archetype(Decoder& decoder, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"configuration", "id", "instanceKind"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "instanceKind", pointer);
    const auto* configuration_value = decoder.member(value, "configuration", pointer);
    auto id =
        id_value ? decoder.id<ArchetypeId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto kind = kind_value ? decoder.string(*kind_value, pointer_child(pointer, "instanceKind"))
                           : std::nullopt;
    if (!id || !kind || !configuration_value || !configuration_value->is_object()) {
        if (configuration_value && !configuration_value->is_object())
            decoder.error(k_code_type, "Expected Archetype configuration object.",
                          pointer_child(pointer, "configuration"));
        return std::nullopt;
    }

    auto configuration = *configuration_value;
    configuration["id"] = id->text();
    const auto configuration_pointer = pointer_child(pointer, "configuration");
    if (*kind == "room") {
        auto decoded = decode_room(decoder, configuration, configuration_pointer);
        if (decoded)
            return ArchetypeDefinition{std::move(*id), GameplayInstanceKind::Room,
                                       std::move(*decoded)};
        return std::nullopt;
    }
    if (*kind == "character") {
        configuration["initialWorldState"] = {
            {"enabled", true}, {"location", {{"kind", "unplaced"}}}, {"visible", true}};
        auto decoded = decode_character(decoder, configuration, configuration_pointer);
        if (decoded)
            return ArchetypeDefinition{std::move(*id), GameplayInstanceKind::Character,
                                       std::move(*decoded)};
        return std::nullopt;
    }
    if (*kind == "interactable") {
        auto decoded = decode_interactable(decoder, configuration, configuration_pointer);
        if (decoded)
            return ArchetypeDefinition{std::move(*id), GameplayInstanceKind::Interactable,
                                       std::move(*decoded)};
        return std::nullopt;
    }
    decoder.error(k_code_variant, "Unknown Gameplay Instance Archetype kind.",
                  pointer_child(pointer, "instanceKind"));
    return std::nullopt;
}

std::optional<MapDefinition> decode_map(Decoder& decoder, const nlohmann::json& value,
                                        std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"connections", "id", "locations", "presentation"}))
        return std::nullopt;
    auto identity = decode_definition_identity<MapId>(decoder, value, pointer);
    const auto* connections_value = decoder.member(value, "connections", pointer);
    const auto* locations_value = decoder.member(value, "locations", pointer);
    const auto* presentation_value = decoder.member(value, "presentation", pointer);
    auto decode_map_point = [&](const nlohmann::json& point,
                                const std::string& point_pointer) -> std::optional<Vector2> {
        auto decoded = decode_vector2(decoder, point, point_pointer);
        if (decoded &&
            (decoded->x < 0.0 || decoded->x > 1.0 || decoded->y < 0.0 || decoded->y > 1.0)) {
            decoder.error(k_code_number, "Map coordinates must be normalized to [0, 1].",
                          point_pointer);
            return std::nullopt;
        }
        return decoded;
    };
    auto decode_polygon = [&](const nlohmann::json& polygon,
                              const std::string& polygon_pointer) -> std::optional<MapPolygon> {
        if (!decoder.object(polygon, polygon_pointer, {"points"}))
            return std::nullopt;
        const auto* points_value = decoder.member(polygon, "points", polygon_pointer);
        auto points = points_value
                          ? decoder.array<Vector2>(
                                *points_value, pointer_child(polygon_pointer, "points"),
                                [&](const nlohmann::json& point, const std::string& point_pointer) {
                                    return decode_map_point(point, point_pointer);
                                })
                          : std::nullopt;
        if (points && points->size() < 3) {
            decoder.error(k_code_number, "Map polygons require at least three points.",
                          pointer_child(polygon_pointer, "points"));
            points.reset();
        }
        return points ? std::optional<MapPolygon>{MapPolygon{std::move(*points)}} : std::nullopt;
    };
    auto decode_optional_point = [&](const nlohmann::json* point, const std::string& point_pointer,
                                     bool& ok) -> std::optional<Vector2> {
        ok = point != nullptr;
        if (point == nullptr || point->is_null())
            return std::nullopt;
        auto decoded = decode_map_point(*point, point_pointer);
        ok = decoded.has_value();
        return decoded;
    };
    auto decode_optional_asset = [&](const nlohmann::json* asset, const std::string& asset_pointer,
                                     bool& ok) -> std::optional<AssetId> {
        ok = asset != nullptr;
        if (asset == nullptr || asset->is_null())
            return std::nullopt;
        auto decoded = decode_reference<AssetId>(decoder, *asset, asset_pointer, "asset");
        ok = decoded.has_value();
        return decoded;
    };
    auto decode_optional_style = [&](const nlohmann::json* style, const std::string& style_pointer,
                                     bool& ok) -> std::optional<std::string> {
        ok = style != nullptr;
        if (style == nullptr || style->is_null())
            return std::nullopt;
        auto decoded = decoder.string(*style, style_pointer, true, true);
        ok = decoded.has_value();
        return decoded;
    };
    auto decode_order = [&](const nlohmann::json* order,
                            const std::string& order_pointer) -> std::optional<std::int64_t> {
        if (order == nullptr)
            return std::nullopt;
        auto decoded = json_access::get<std::int64_t>(*order);
        if (!decoded)
            decoder.error(k_code_type, "Expected an integer.", order_pointer);
        return decoded;
    };
    auto locations =
        locations_value
            ? decoder.array<MapLocation>(
                  *locations_value, pointer_child(pointer, "locations"),
                  [&](const nlohmann::json& location,
                      const std::string& item_pointer) -> std::optional<MapLocation> {
                      if (!decoder.object(location, item_pointer,
                                          {"connectionAnchor", "icon", "id", "label", "labelAnchor",
                                           "logicalOrder", "pickOrder", "regions", "room", "style",
                                           "visibility"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(location, "id", item_pointer);
                      const auto* room_value = decoder.member(location, "room", item_pointer);
                      const auto* regions_value = decoder.member(location, "regions", item_pointer);
                      const auto* label_value = decoder.member(location, "label", item_pointer);
                      const auto* icon_value = decoder.member(location, "icon", item_pointer);
                      const auto* style_value = decoder.member(location, "style", item_pointer);
                      const auto* label_anchor_value =
                          decoder.member(location, "labelAnchor", item_pointer);
                      const auto* connection_anchor_value =
                          decoder.member(location, "connectionAnchor", item_pointer);
                      const auto* visibility_value =
                          decoder.member(location, "visibility", item_pointer);
                      const auto* pick_order_value =
                          decoder.member(location, "pickOrder", item_pointer);
                      const auto* logical_order_value =
                          decoder.member(location, "logicalOrder", item_pointer);
                      auto id = id_value ? decoder.id<MapLocationId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto room = room_value ? decode_reference<RoomId>(
                                                   decoder, *room_value,
                                                   pointer_child(item_pointer, "room"), "room")
                                             : std::nullopt;
                      auto regions =
                          regions_value
                              ? decoder.array<MapPolygon>(*regions_value,
                                                          pointer_child(item_pointer, "regions"),
                                                          decode_polygon)
                              : std::nullopt;
                      std::optional<TextContent> label;
                      bool label_ok = label_value != nullptr;
                      if (label_value && !label_value->is_null()) {
                          label = decode_text(decoder, *label_value,
                                              pointer_child(item_pointer, "label"));
                          label_ok = label.has_value();
                      }
                      bool icon_ok = false;
                      auto icon = decode_optional_asset(
                          icon_value, pointer_child(item_pointer, "icon"), icon_ok);
                      bool style_ok = false;
                      auto style = decode_optional_style(
                          style_value, pointer_child(item_pointer, "style"), style_ok);
                      bool label_anchor_ok = false;
                      auto label_anchor = decode_optional_point(
                          label_anchor_value, pointer_child(item_pointer, "labelAnchor"),
                          label_anchor_ok);
                      bool connection_anchor_ok = false;
                      auto connection_anchor = decode_optional_point(
                          connection_anchor_value, pointer_child(item_pointer, "connectionAnchor"),
                          connection_anchor_ok);
                      auto visibility =
                          visibility_value
                              ? decode_condition_impl(decoder, *visibility_value,
                                                      pointer_child(item_pointer, "visibility"))
                              : std::nullopt;
                      auto pick_order =
                          decode_order(pick_order_value, pointer_child(item_pointer, "pickOrder"));
                      auto logical_order = decode_order(
                          logical_order_value, pointer_child(item_pointer, "logicalOrder"));
                      if (id && room && regions && label_ok && icon_ok && style_ok &&
                          label_anchor_ok && connection_anchor_ok && visibility && pick_order &&
                          logical_order)
                          return MapLocation{std::move(*id),          std::move(*room),
                                             std::move(*regions),     std::move(label),
                                             std::move(icon),         std::move(style),
                                             std::move(label_anchor), std::move(connection_anchor),
                                             std::move(*visibility),  *pick_order,
                                             *logical_order};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto decode_exit_reference =
        [&](const nlohmann::json& value,
            const std::string& item_pointer) -> std::optional<RoomExitRef> {
        if (!decoder.object(value, item_pointer, {"exitId", "room"}))
            return std::nullopt;
        const auto* exit_id_value = decoder.member(value, "exitId", item_pointer);
        const auto* room_value = decoder.member(value, "room", item_pointer);
        auto exit_id = exit_id_value ? decoder.id<RoomExitId>(*exit_id_value,
                                                              pointer_child(item_pointer, "exitId"))
                                     : std::nullopt;
        auto room = room_value
                        ? decode_reference<RoomId>(decoder, *room_value,
                                                   pointer_child(item_pointer, "room"), "room")
                        : std::nullopt;
        return exit_id && room
                   ? std::optional<RoomExitRef>{RoomExitRef{std::move(*room), std::move(*exit_id)}}
                   : std::nullopt;
    };
    auto connections =
        connections_value
            ? decoder.array<MapConnection>(
                  *connections_value, pointer_child(pointer, "connections"),
                  [&](const nlohmann::json& connection,
                      const std::string& item_pointer) -> std::optional<MapConnection> {
                      if (!decoder.object(connection, item_pointer,
                                          {"exits", "hitRegions", "icon", "id", "label",
                                           "logicalOrder", "path", "sourceLocationId", "style",
                                           "targetLocationId", "visibility"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(connection, "id", item_pointer);
                      const auto* exits_value = decoder.member(connection, "exits", item_pointer);
                      const auto* source_value =
                          decoder.member(connection, "sourceLocationId", item_pointer);
                      const auto* target_value =
                          decoder.member(connection, "targetLocationId", item_pointer);
                      const auto* label_value = decoder.member(connection, "label", item_pointer);
                      const auto* icon_value = decoder.member(connection, "icon", item_pointer);
                      const auto* style_value = decoder.member(connection, "style", item_pointer);
                      const auto* visibility_value =
                          decoder.member(connection, "visibility", item_pointer);
                      const auto* logical_order_value =
                          decoder.member(connection, "logicalOrder", item_pointer);
                      const auto* path_value = decoder.member(connection, "path", item_pointer);
                      const auto* hit_regions_value =
                          decoder.member(connection, "hitRegions", item_pointer);
                      auto id = id_value ? decoder.id<MapConnectionId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto exits = exits_value
                                       ? decoder.array<RoomExitRef>(
                                             *exits_value, pointer_child(item_pointer, "exits"),
                                             decode_exit_reference)
                                       : std::nullopt;
                      if (exits && (exits->empty() || exits->size() > 2)) {
                          decoder.error(k_code_number,
                                        "Map Connections require one Exit or one reciprocal pair.",
                                        pointer_child(item_pointer, "exits"));
                          exits.reset();
                      }
                      auto source =
                          source_value
                              ? decoder.id<MapLocationId>(
                                    *source_value, pointer_child(item_pointer, "sourceLocationId"))
                              : std::nullopt;
                      auto target =
                          target_value
                              ? decoder.id<MapLocationId>(
                                    *target_value, pointer_child(item_pointer, "targetLocationId"))
                              : std::nullopt;
                      std::optional<TextContent> label;
                      bool label_ok = label_value != nullptr;
                      if (label_value && !label_value->is_null()) {
                          label = decode_text(decoder, *label_value,
                                              pointer_child(item_pointer, "label"));
                          label_ok = label.has_value();
                      }
                      bool icon_ok = false;
                      auto icon = decode_optional_asset(
                          icon_value, pointer_child(item_pointer, "icon"), icon_ok);
                      bool style_ok = false;
                      auto style = decode_optional_style(
                          style_value, pointer_child(item_pointer, "style"), style_ok);
                      auto visibility =
                          visibility_value
                              ? decode_condition_impl(decoder, *visibility_value,
                                                      pointer_child(item_pointer, "visibility"))
                              : std::nullopt;
                      auto logical_order = decode_order(
                          logical_order_value, pointer_child(item_pointer, "logicalOrder"));
                      auto path_points =
                          path_value ? decoder.array<Vector2>(*path_value,
                                                              pointer_child(item_pointer, "path"),
                                                              decode_map_point)
                                     : std::nullopt;
                      auto hit_regions =
                          hit_regions_value
                              ? decoder.array<MapPolygon>(*hit_regions_value,
                                                          pointer_child(item_pointer, "hitRegions"),
                                                          decode_polygon)
                              : std::nullopt;
                      if (id && exits && source && target && label_ok && icon_ok && style_ok &&
                          visibility && logical_order && path_points && hit_regions)
                          return MapConnection{
                              std::move(*id),          std::move(*exits),      std::move(*source),
                              std::move(*target),      std::move(label),       std::move(icon),
                              std::move(style),        std::move(*visibility), *logical_order,
                              std::move(*path_points), std::move(*hit_regions)};
                      return std::nullopt;
                  })
            : std::nullopt;
    std::optional<MapPresentation> presentation;
    if (presentation_value &&
        decoder.object(*presentation_value, pointer_child(pointer, "presentation"),
                       {"background", "initialMode", "layout", "title"})) {
        const auto presentation_pointer = pointer_child(pointer, "presentation");
        const auto* background_value =
            decoder.member(*presentation_value, "background", presentation_pointer);
        const auto* mode_value =
            decoder.member(*presentation_value, "initialMode", presentation_pointer);
        const auto* layout_value =
            decoder.member(*presentation_value, "layout", presentation_pointer);
        const auto* title_value =
            decoder.member(*presentation_value, "title", presentation_pointer);
        std::optional<AssetId> background;
        bool background_ok = background_value != nullptr;
        if (background_value && !background_value->is_null()) {
            background = decode_reference<AssetId>(
                decoder, *background_value, pointer_child(presentation_pointer, "background"),
                "asset");
            background_ok = background.has_value();
        }
        auto mode =
            mode_value
                ? decoder.enumeration<InitialMapMode>(
                      *mode_value, pointer_child(presentation_pointer, "initialMode"),
                      {{"minimap", InitialMapMode::Minimap}, {"full-map", InitialMapMode::FullMap}})
                : std::nullopt;
        std::optional<LayoutId> layout;
        bool layout_ok = layout_value != nullptr;
        if (layout_value && !layout_value->is_null()) {
            layout = decode_reference<LayoutId>(
                decoder, *layout_value, pointer_child(presentation_pointer, "layout"), "layout");
            layout_ok = layout.has_value();
        }
        std::optional<TextContent> title;
        bool title_ok = title_value != nullptr;
        if (title_value && !title_value->is_null()) {
            title =
                decode_text(decoder, *title_value, pointer_child(presentation_pointer, "title"));
            title_ok = title.has_value();
        }
        if (background_ok && mode && layout_ok && title_ok)
            presentation =
                MapPresentation{std::move(background), *mode, std::move(layout), std::move(title)};
    }
    if (locations)
        decoder.duplicate_ids(
            *locations, pointer_child(pointer, "locations"),
            [](const MapLocation& location) -> const MapLocationId& { return location.id; });
    if (connections)
        decoder.duplicate_ids(*connections, pointer_child(pointer, "connections"),
                              [](const MapConnection& connection) -> const MapConnectionId& {
                                  return connection.id;
                              });
    if (!identity || !connections || !locations || !presentation)
        return std::nullopt;
    return MapDefinition{std::move(*identity), std::move(*connections), std::move(*locations),
                         std::move(*presentation)};
}

} // namespace noveltea::core::compiled::wire::detail
