#include "internal.hpp"

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
                        {"defaults", "dialogue", "displayName", "expressions", "extends", "id",
                         "initialWorldState", "poses", "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<CharacterId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
    const auto* defaults_value = decoder.member(value, "defaults", pointer);
    const auto* poses_value = decoder.member(value, "poses", pointer);
    const auto* expressions_value = decoder.member(value, "expressions", pointer);
    const auto* initial_world_value = decoder.member(value, "initialWorldState", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
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
                                         {"expressionId", "poseId"})) {
        const auto defaults_pointer = pointer_child(pointer, "defaults");
        const auto* expression_value =
            decoder.member(*defaults_value, "expressionId", defaults_pointer);
        const auto* pose_value = decoder.member(*defaults_value, "poseId", defaults_pointer);
        auto expression =
            expression_value
                ? decoder.id<CharacterExpressionId>(*expression_value,
                                                    pointer_child(defaults_pointer, "expressionId"))
                : std::nullopt;
        auto pose = pose_value ? decoder.id<CharacterPoseId>(
                                     *pose_value, pointer_child(defaults_pointer, "poseId"))
                               : std::nullopt;
        if (expression && pose)
            defaults = CharacterDefaults{std::move(*expression), std::move(*pose)};
    }
    auto poses =
        poses_value
            ? decoder.array<CharacterPose>(
                  *poses_value, pointer_child(pointer, "poses"),
                  [&](const nlohmann::json& pose,
                      const std::string& pose_pointer) -> std::optional<CharacterPose> {
                      if (!decoder.object(
                              pose, pose_pointer,
                              {"anchor", "id", "material", "offset", "scale", "sprite"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(pose, "id", pose_pointer);
                      const auto* anchor_value = decoder.member(pose, "anchor", pose_pointer);
                      const auto* offset_value = decoder.member(pose, "offset", pose_pointer);
                      const auto* scale_value = decoder.member(pose, "scale", pose_pointer);
                      const auto* material_value = decoder.member(pose, "material", pose_pointer);
                      const auto* sprite_value = decoder.member(pose, "sprite", pose_pointer);
                      auto id = id_value ? decoder.id<CharacterPoseId>(
                                               *id_value, pointer_child(pose_pointer, "id"))
                                         : std::nullopt;
                      auto anchor = anchor_value
                                        ? decode_vector2(decoder, *anchor_value,
                                                         pointer_child(pose_pointer, "anchor"))
                                        : std::nullopt;
                      auto offset = offset_value
                                        ? decode_vector2(decoder, *offset_value,
                                                         pointer_child(pose_pointer, "offset"))
                                        : std::nullopt;
                      auto scale = scale_value
                                       ? decoder.finite_number(*scale_value,
                                                               pointer_child(pose_pointer, "scale"))
                                       : std::nullopt;
                      if (scale && *scale <= 0.0) {
                          decoder.error(k_code_number, "Scale must be positive.",
                                        pointer_child(pose_pointer, "scale"));
                          scale.reset();
                      }
                      std::optional<MaterialId> material;
                      bool material_ok = material_value != nullptr;
                      if (material_value && !material_value->is_null()) {
                          material = decode_reference<MaterialId>(
                              decoder, *material_value, pointer_child(pose_pointer, "material"),
                              "material");
                          material_ok = material.has_value();
                      }
                      std::optional<AssetId> sprite;
                      bool sprite_ok = sprite_value != nullptr;
                      if (sprite_value && !sprite_value->is_null()) {
                          sprite = decode_reference<AssetId>(decoder, *sprite_value,
                                                             pointer_child(pose_pointer, "sprite"),
                                                             "asset");
                          sprite_ok = sprite.has_value();
                      }
                      if (id && anchor && offset && scale && material_ok && sprite_ok)
                          return CharacterPose{std::move(*id),
                                               std::move(*anchor),
                                               std::move(material),
                                               std::move(*offset),
                                               *scale,
                                               std::move(sprite)};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto expressions =
        expressions_value
            ? decoder.array<CharacterExpression>(
                  *expressions_value, pointer_child(pointer, "expressions"),
                  [&](const nlohmann::json& expression,
                      const std::string& expression_pointer) -> std::optional<CharacterExpression> {
                      if (!decoder.object(expression, expression_pointer,
                                          {"id", "material", "poseId", "sprite"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(expression, "id", expression_pointer);
                      const auto* material_value =
                          decoder.member(expression, "material", expression_pointer);
                      const auto* pose_value =
                          decoder.member(expression, "poseId", expression_pointer);
                      const auto* sprite_value =
                          decoder.member(expression, "sprite", expression_pointer);
                      auto id = id_value ? decoder.id<CharacterExpressionId>(
                                               *id_value, pointer_child(expression_pointer, "id"))
                                         : std::nullopt;
                      std::optional<MaterialId> material;
                      bool material_ok = material_value != nullptr;
                      if (material_value && !material_value->is_null()) {
                          material = decode_reference<MaterialId>(
                              decoder, *material_value,
                              pointer_child(expression_pointer, "material"), "material");
                          material_ok = material.has_value();
                      }
                      std::optional<CharacterPoseId> pose;
                      bool pose_ok = pose_value != nullptr;
                      if (pose_value && !pose_value->is_null()) {
                          pose = decoder.id<CharacterPoseId>(
                              *pose_value, pointer_child(expression_pointer, "poseId"));
                          pose_ok = pose.has_value();
                      }
                      std::optional<AssetId> sprite;
                      bool sprite_ok = sprite_value != nullptr;
                      if (sprite_value && !sprite_value->is_null()) {
                          sprite = decode_reference<AssetId>(
                              decoder, *sprite_value, pointer_child(expression_pointer, "sprite"),
                              "asset");
                          sprite_ok = sprite.has_value();
                      }
                      if (id && material_ok && pose_ok && sprite_ok)
                          return CharacterExpression{std::move(*id), std::move(material),
                                                     std::move(pose), std::move(sprite)};
                      return std::nullopt;
                  })
            : std::nullopt;
    if (poses)
        decoder.duplicate_ids(
            *poses, pointer_child(pointer, "poses"),
            [](const CharacterPose& pose) -> const CharacterPoseId& { return pose.id; });
    if (expressions)
        decoder.duplicate_ids(
            *expressions, pointer_child(pointer, "expressions"),
            [](const CharacterExpression& expression) -> const CharacterExpressionId& {
                return expression.id;
            });
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
        if (location_value && location_value->is_object()) {
            const auto location_pointer = pointer_child(world_pointer, "location");
            const auto* kind_value = decoder.member(*location_value, "kind", location_pointer);
            auto kind = kind_value
                            ? decoder.string(*kind_value, pointer_child(location_pointer, "kind"))
                            : std::nullopt;
            if (kind && *kind == "nowhere" &&
                decoder.object(*location_value, location_pointer, {"kind"}))
                location = NowhereCharacterLocation{};
            else if (kind && *kind == "room-placement" &&
                     decoder.object(*location_value, location_pointer, {"kind", "placement"})) {
                const auto* placement_value =
                    decoder.member(*location_value, "placement", location_pointer);
                auto placement =
                    placement_value
                        ? decode_placement_ref(decoder, *placement_value,
                                               pointer_child(location_pointer, "placement"))
                        : std::nullopt;
                if (placement)
                    location = std::move(*placement);
            }
        }
        if (enabled && visible && location)
            initial_world = CharacterInitialWorldState{std::move(*location), *enabled, *visible};
    }
    if (!identity || !display || !dialogue || !defaults || !poses || !expressions || !initial_world)
        return std::nullopt;
    return CharacterDefinition{std::move(*identity),     std::move(*display),
                               std::move(*dialogue),     std::move(*defaults),
                               std::move(*poses),        std::move(*expressions),
                               std::move(*initial_world)};
}

std::optional<RoomDefinition> decode_room(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"background", "description", "displayName", "exits", "extends", "id",
                         "cast", "compose", "lifecycle", "overlays", "placements", "props",
                         "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<RoomId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    const auto* background_value = decoder.member(value, "background", pointer);
    const auto* lifecycle_value = decoder.member(value, "lifecycle", pointer);
    const auto* overlays_value = decoder.member(value, "overlays", pointer);
    const auto* placements_value = decoder.member(value, "placements", pointer);
    const auto* exits_value = decoder.member(value, "exits", pointer);
    const auto* cast_value = decoder.member(value, "cast", pointer);
    const auto* props_value = decoder.member(value, "props", pointer);
    const auto* compose_value = decoder.member(value, "compose", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto description = description_value ? decode_text(decoder, *description_value,
                                                       pointer_child(pointer, "description"))
                                         : std::nullopt;
    auto background = background_value ? decode_background(decoder, *background_value,
                                                           pointer_child(pointer, "background"))
                                       : std::nullopt;
    std::optional<RoomLifecycle> lifecycle;
    if (lifecycle_value && decoder.object(*lifecycle_value, pointer_child(pointer, "lifecycle"),
                                          {"canEnter", "canLeave", "hooks"})) {
        const auto lifecycle_pointer = pointer_child(pointer, "lifecycle");
        const auto* enter_value = decoder.member(*lifecycle_value, "canEnter", lifecycle_pointer);
        const auto* leave_value = decoder.member(*lifecycle_value, "canLeave", lifecycle_pointer);
        const auto* hooks_value = decoder.member(*lifecycle_value, "hooks", lifecycle_pointer);
        auto enter = enter_value
                         ? decode_condition_impl(decoder, *enter_value,
                                                 pointer_child(lifecycle_pointer, "canEnter"))
                         : std::nullopt;
        auto leave = leave_value
                         ? decode_condition_impl(decoder, *leave_value,
                                                 pointer_child(lifecycle_pointer, "canLeave"))
                         : std::nullopt;
        auto hooks =
            hooks_value
                ? decoder.array<RoomHookProgram>(
                      *hooks_value, pointer_child(lifecycle_pointer, "hooks"),
                      [&](const nlohmann::json& hook,
                          const std::string& hook_pointer) -> std::optional<RoomHookProgram> {
                          if (!decoder.object(hook, hook_pointer, {"effects", "hook"}))
                              return std::nullopt;
                          const auto* kind_value = decoder.member(hook, "hook", hook_pointer);
                          const auto* effects_value = decoder.member(hook, "effects", hook_pointer);
                          auto kind = kind_value
                                          ? decoder.enumeration<RoomHookKind>(
                                                *kind_value, pointer_child(hook_pointer, "hook"),
                                                {{"before-enter", RoomHookKind::BeforeEnter},
                                                 {"after-enter", RoomHookKind::AfterEnter},
                                                 {"before-leave", RoomHookKind::BeforeLeave},
                                                 {"after-leave", RoomHookKind::AfterLeave}})
                                          : std::nullopt;
                          auto effects =
                              effects_value ? decode_effects(decoder, *effects_value,
                                                             pointer_child(hook_pointer, "effects"))
                                            : std::nullopt;
                          return kind && effects ? std::optional<RoomHookProgram>(
                                                       RoomHookProgram{*kind, std::move(*effects)})
                                                 : std::nullopt;
                      })
                : std::nullopt;
        if (enter && leave && hooks)
            lifecycle = RoomLifecycle{std::move(*enter), std::move(*leave), std::move(*hooks)};
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
    auto cast =
        cast_value
            ? decoder.array<RoomCastEntry>(
                  *cast_value, pointer_child(pointer, "cast"),
                  [&](const nlohmann::json& item,
                      const std::string& item_pointer) -> std::optional<RoomCastEntry> {
                      if (!decoder.object(item, item_pointer,
                                          {"character", "condition", "expressionId", "id", "order",
                                           "placementId", "poseId", "visible"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", item_pointer);
                      const auto* character_value = decoder.member(item, "character", item_pointer);
                      const auto* condition_value = decoder.member(item, "condition", item_pointer);
                      const auto* placement_value =
                          decoder.member(item, "placementId", item_pointer);
                      const auto* pose_value = decoder.member(item, "poseId", item_pointer);
                      const auto* expression_value =
                          decoder.member(item, "expressionId", item_pointer);
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
                      if (id && character && condition && placement && visible && order &&
                          pose_ok && expression_ok)
                          return RoomCastEntry{std::move(*id),
                                               std::move(*character),
                                               std::move(*condition),
                                               std::move(*placement),
                                               std::move(pose),
                                               std::move(expression),
                                               *visible,
                                               *order};
                      return std::nullopt;
                  })
            : std::nullopt;
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
    std::optional<RoomCompositionHook> compose;
    bool compose_ok = compose_value != nullptr;
    if (compose_value && !compose_value->is_null() &&
        decoder.object(*compose_value, pointer_child(pointer, "compose"), {"script"})) {
        const auto compose_pointer = pointer_child(pointer, "compose");
        const auto* script_value = decoder.member(*compose_value, "script", compose_pointer);
        auto script =
            script_value
                ? decode_reference<ScriptId>(decoder, *script_value,
                                             pointer_child(compose_pointer, "script"), "script")
                : std::nullopt;
        if (script)
            compose = RoomCompositionHook{std::move(*script)};
        compose_ok = compose.has_value();
    }
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
    if (cast)
        decoder.duplicate_ids(
            *cast, pointer_child(pointer, "cast"),
            [](const RoomCastEntry& entry) -> const RoomCastEntryId& { return entry.id; });
    if (props)
        decoder.duplicate_ids(*props, pointer_child(pointer, "props"),
                              [](const RoomProp& prop) -> const RoomPropId& { return prop.id; });
    if (!identity || !display || !description || !background || !lifecycle || !overlays ||
        !placements || !exits || !cast || !props || !compose_ok)
        return std::nullopt;
    return RoomDefinition{std::move(*identity),   std::move(*display),   std::move(*description),
                          std::move(*background), std::move(*lifecycle), std::move(*overlays),
                          std::move(*cast),       std::move(*props),     std::move(compose),
                          std::move(*placements), std::move(*exits)};
}

std::optional<InteractableDefinition>
decode_interactable(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"displayName", "extends", "id", "initialState", "presentation",
                         "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<InteractableId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* state_value = decoder.member(value, "initialState", pointer);
    const auto* presentation_value = decoder.member(value, "presentation", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    std::optional<InteractableInitialState> state;
    if (state_value && decoder.object(*state_value, pointer_child(pointer, "initialState"),
                                      {"enabled", "location", "visible"})) {
        const auto state_pointer = pointer_child(pointer, "initialState");
        const auto* enabled_value = decoder.member(*state_value, "enabled", state_pointer);
        const auto* location_value = decoder.member(*state_value, "location", state_pointer);
        const auto* visible_value = decoder.member(*state_value, "visible", state_pointer);
        auto enabled =
            enabled_value ? decoder.boolean(*enabled_value, pointer_child(state_pointer, "enabled"))
                          : std::nullopt;
        auto location = location_value ? decode_location(decoder, *location_value,
                                                         pointer_child(state_pointer, "location"))
                                       : std::nullopt;
        auto visible =
            visible_value ? decoder.boolean(*visible_value, pointer_child(state_pointer, "visible"))
                          : std::nullopt;
        if (enabled && location && visible)
            state = InteractableInitialState{*enabled, std::move(*location), *visible};
    }
    std::optional<InteractablePresentation> presentation;
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
            presentation = InteractablePresentation{std::move(material), std::move(sprite)};
    }
    if (!identity || !display || !state || !presentation)
        return std::nullopt;
    return InteractableDefinition{std::move(*identity), std::move(*display), std::move(*state),
                                  std::move(*presentation)};
}

std::optional<MapDefinition> decode_map(Decoder& decoder, const nlohmann::json& value,
                                        std::string_view pointer)
{
    if (!decoder.object(
            value, pointer,
            {"connections", "extends", "id", "locations", "presentation", "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<MapId>(decoder, value, pointer);
    const auto* connections_value = decoder.member(value, "connections", pointer);
    const auto* locations_value = decoder.member(value, "locations", pointer);
    const auto* presentation_value = decoder.member(value, "presentation", pointer);
    auto locations =
        locations_value
            ? decoder.array<MapLocation>(
                  *locations_value, pointer_child(pointer, "locations"),
                  [&](const nlohmann::json& location,
                      const std::string& item_pointer) -> std::optional<MapLocation> {
                      if (!decoder.object(location, item_pointer,
                                          {"id", "label", "position", "room", "shape"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(location, "id", item_pointer);
                      const auto* label_value = decoder.member(location, "label", item_pointer);
                      const auto* position_value =
                          decoder.member(location, "position", item_pointer);
                      const auto* room_value = decoder.member(location, "room", item_pointer);
                      const auto* shape_value = decoder.member(location, "shape", item_pointer);
                      auto id = id_value ? decoder.id<MapLocationId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      std::optional<TextContent> label;
                      bool label_ok = label_value != nullptr;
                      if (label_value && !label_value->is_null()) {
                          label = decode_text(decoder, *label_value,
                                              pointer_child(item_pointer, "label"));
                          label_ok = label.has_value();
                      }
                      auto position = position_value
                                          ? decode_vector2(decoder, *position_value,
                                                           pointer_child(item_pointer, "position"))
                                          : std::nullopt;
                      auto room = room_value ? decode_reference<RoomId>(
                                                   decoder, *room_value,
                                                   pointer_child(item_pointer, "room"), "room")
                                             : std::nullopt;
                      std::optional<MapShape> shape;
                      if (shape_value && shape_value->is_object()) {
                          const auto shape_pointer = pointer_child(item_pointer, "shape");
                          const auto* kind_value =
                              decoder.member(*shape_value, "kind", shape_pointer);
                          auto kind = kind_value
                                          ? decoder.string(*kind_value,
                                                           pointer_child(shape_pointer, "kind"))
                                          : std::nullopt;
                          if (kind && *kind == "point") {
                              decoder.object(*shape_value, shape_pointer, {"kind"});
                              shape = PointMapShape{};
                          } else if (kind && *kind == "circle") {
                              decoder.object(*shape_value, shape_pointer, {"kind", "radius"});
                              const auto* radius_value =
                                  decoder.member(*shape_value, "radius", shape_pointer);
                              auto radius =
                                  radius_value
                                      ? decoder.finite_number(
                                            *radius_value, pointer_child(shape_pointer, "radius"))
                                      : std::nullopt;
                              if (radius && *radius <= 0.0) {
                                  decoder.error(k_code_number, "Radius must be positive.",
                                                pointer_child(shape_pointer, "radius"));
                                  radius.reset();
                              }
                              if (radius)
                                  shape = CircleMapShape{*radius};
                          } else if (kind && *kind == "rect") {
                              decoder.object(*shape_value, shape_pointer,
                                             {"height", "kind", "width"});
                              const auto* height_value =
                                  decoder.member(*shape_value, "height", shape_pointer);
                              const auto* width_value =
                                  decoder.member(*shape_value, "width", shape_pointer);
                              auto height =
                                  height_value
                                      ? decoder.finite_number(
                                            *height_value, pointer_child(shape_pointer, "height"))
                                      : std::nullopt;
                              auto width =
                                  width_value
                                      ? decoder.finite_number(*width_value,
                                                              pointer_child(shape_pointer, "width"))
                                      : std::nullopt;
                              if (height && *height <= 0.0) {
                                  decoder.error(k_code_number, "Height must be positive.",
                                                pointer_child(shape_pointer, "height"));
                                  height.reset();
                              }
                              if (width && *width <= 0.0) {
                                  decoder.error(k_code_number, "Width must be positive.",
                                                pointer_child(shape_pointer, "width"));
                                  width.reset();
                              }
                              if (height && width)
                                  shape = RectMapShape{*width, *height};
                          } else if (kind) {
                              decoder.object(*shape_value, shape_pointer, {"kind"});
                              decoder.error(k_code_variant,
                                            "Unknown map shape variant '" + *kind + "'.",
                                            pointer_child(shape_pointer, "kind"));
                          }
                      } else if (shape_value) {
                          decoder.error(k_code_type, "Expected an object.",
                                        pointer_child(item_pointer, "shape"));
                      }
                      if (id && label_ok && position && room && shape)
                          return MapLocation{std::move(*id), std::move(label), std::move(*position),
                                             std::move(*room), std::move(*shape)};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto connections =
        connections_value
            ? decoder.array<MapConnection>(
                  *connections_value, pointer_child(pointer, "connections"),
                  [&](const nlohmann::json& connection,
                      const std::string& item_pointer) -> std::optional<MapConnection> {
                      if (!decoder.object(connection, item_pointer,
                                          {"exit", "id", "sourceLocationId", "targetLocationId"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(connection, "id", item_pointer);
                      const auto* exit_value = decoder.member(connection, "exit", item_pointer);
                      const auto* source_value =
                          decoder.member(connection, "sourceLocationId", item_pointer);
                      const auto* target_value =
                          decoder.member(connection, "targetLocationId", item_pointer);
                      auto id = id_value ? decoder.id<MapConnectionId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      std::optional<RoomExitRef> exit;
                      if (exit_value &&
                          decoder.object(*exit_value, pointer_child(item_pointer, "exit"),
                                         {"exitId", "room"})) {
                          const auto exit_pointer = pointer_child(item_pointer, "exit");
                          const auto* exit_id_value =
                              decoder.member(*exit_value, "exitId", exit_pointer);
                          const auto* room_value =
                              decoder.member(*exit_value, "room", exit_pointer);
                          auto exit_id =
                              exit_id_value
                                  ? decoder.id<RoomExitId>(*exit_id_value,
                                                           pointer_child(exit_pointer, "exitId"))
                                  : std::nullopt;
                          auto room = room_value ? decode_reference<RoomId>(
                                                       decoder, *room_value,
                                                       pointer_child(exit_pointer, "room"), "room")
                                                 : std::nullopt;
                          if (exit_id && room)
                              exit = RoomExitRef{std::move(*room), std::move(*exit_id)};
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
                      if (id && exit && source && target)
                          return MapConnection{std::move(*id), std::move(*exit), std::move(*source),
                                               std::move(*target)};
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
