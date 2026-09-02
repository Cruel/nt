#include "internal.hpp"

namespace noveltea::core::compiled::wire {
using namespace detail;

Result<Condition, Diagnostics> decode_condition(const nlohmann::json& value,
                                                std::string source_path, std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_condition_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<Condition, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<Condition, Diagnostics>::success(std::move(*result));
}

Result<Effect, Diagnostics> decode_effect(const nlohmann::json& value, std::string source_path,
                                          std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_effect_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<Effect, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<Effect, Diagnostics>::success(std::move(*result));
}

Result<FlowTarget, Diagnostics>
decode_flow_target(const nlohmann::json& value, std::string source_path, std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_flow_target_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<FlowTarget, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<FlowTarget, Diagnostics>::success(std::move(*result));
}

namespace {

std::optional<FlowPredictionDependency>
decode_flow_prediction_dependency(Decoder& decoder, const nlohmann::json& value,
                                  std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"kind", "asset", "character", "profileId", "poseId", "expressionId",
                         "appearanceId", "layout", "material", "room", "purpose"}))
        return std::nullopt;
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "room") {
        const auto* room_value = decoder.member(value, "room", pointer);
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        if (!room)
            return std::nullopt;
        return FlowPredictionDependency{FlowPredictionRoomDependency{std::move(*room)}};
    }
    if (*kind == "layout") {
        const auto* layout_value = decoder.member(value, "layout", pointer);
        auto layout = layout_value
                          ? decode_reference<LayoutId>(decoder, *layout_value,
                                                       pointer_child(pointer, "layout"), "layout")
                          : std::nullopt;
        return layout ? std::optional<FlowPredictionDependency>{FlowPredictionLayoutDependency{
                            std::move(*layout)}}
                      : std::nullopt;
    }
    if (*kind == "material") {
        const auto* material_value = decoder.member(value, "material", pointer);
        auto material =
            material_value
                ? decode_reference<MaterialId>(decoder, *material_value,
                                               pointer_child(pointer, "material"), "material")
                : std::nullopt;
        return material ? std::optional<FlowPredictionDependency>{FlowPredictionMaterialDependency{
                              std::move(*material)}}
                        : std::nullopt;
    }
    if (*kind == "character") {
        const auto* character_value = decoder.member(value, "character", pointer);
        const auto* profile_value = decoder.member(value, "profileId", pointer);
        const auto* pose_value = decoder.member(value, "poseId", pointer);
        const auto* expression_value = decoder.member(value, "expressionId", pointer);
        const auto* appearance_value = decoder.member(value, "appearanceId", pointer);
        auto character =
            character_value
                ? decode_reference<CharacterId>(decoder, *character_value,
                                                pointer_child(pointer, "character"), "character")
                : std::nullopt;
        auto optional_id = [&]<typename Id>(const nlohmann::json* item, std::string_view name,
                                            std::optional<Id>& output) -> bool {
            if (item == nullptr)
                return false;
            if (item->is_null())
                return true;
            auto parsed = decoder.id<Id>(*item, pointer_child(pointer, name));
            if (!parsed)
                return false;
            output = std::move(*parsed);
            return true;
        };
        std::optional<CharacterPresentationProfileId> profile;
        std::optional<CharacterPoseId> pose;
        std::optional<CharacterExpressionId> expression;
        std::optional<CharacterAppearanceId> appearance;
        if (!character || !optional_id(profile_value, "profileId", profile) ||
            !optional_id(pose_value, "poseId", pose) ||
            !optional_id(expression_value, "expressionId", expression) ||
            !optional_id(appearance_value, "appearanceId", appearance))
            return std::nullopt;
        return FlowPredictionDependency{FlowPredictionCharacterDependency{
            std::move(*character), std::move(profile), std::move(pose), std::move(expression),
            std::move(appearance)}};
    }
    if (*kind == "audio") {
        const auto* asset_value = decoder.member(value, "asset", pointer);
        const auto* purpose_value = decoder.member(value, "purpose", pointer);
        auto asset = asset_value
                         ? decode_reference<AssetId>(decoder, *asset_value,
                                                     pointer_child(pointer, "asset"), "asset")
                         : std::nullopt;
        auto purpose = purpose_value ? decoder.enumeration<AudioPurpose>(
                                           *purpose_value, pointer_child(pointer, "purpose"),
                                           {{"music", AudioPurpose::Music},
                                            {"ambience", AudioPurpose::Ambience},
                                            {"voice", AudioPurpose::Voice},
                                            {"sound-effect", AudioPurpose::SoundEffect},
                                            {"ui-sound", AudioPurpose::UiSound}})
                                     : std::nullopt;
        if (!asset || !purpose)
            return std::nullopt;
        return FlowPredictionDependency{FlowPredictionAudioDependency{std::move(*asset), *purpose}};
    }
    if (*kind != "asset") {
        decoder.error(k_code_variant, "Unknown Flow Prediction dependency kind '" + *kind + "'.",
                      pointer_child(pointer, "kind"));
        return std::nullopt;
    }
    const auto* asset_value = decoder.member(value, "asset", pointer);
    auto asset = asset_value ? decode_reference<AssetId>(decoder, *asset_value,
                                                         pointer_child(pointer, "asset"), "asset")
                             : std::nullopt;
    if (!asset)
        return std::nullopt;
    return FlowPredictionDependency{FlowPredictionAssetDependency{std::move(*asset)}};
}

std::optional<FlowPredictionPoint> decode_flow_prediction_point(Decoder& decoder,
                                                                const nlohmann::json& value,
                                                                std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"kind", "scene", "stepId", "dialogue", "room", "stage"}))
        return std::nullopt;
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "dialogue-entry") {
        const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
        auto dialogue =
            dialogue_value
                ? decode_reference<DialogueId>(decoder, *dialogue_value,
                                               pointer_child(pointer, "dialogue"), "dialogue")
                : std::nullopt;
        if (!dialogue)
            return std::nullopt;
        return FlowPredictionPoint{DialogueEntryPredictionPoint{std::move(*dialogue)}};
    }
    if (*kind == "room-lifecycle") {
        const auto* room_value = decoder.member(value, "room", pointer);
        const auto* stage_value = decoder.member(value, "stage", pointer);
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        auto stage = stage_value ? decoder.string(*stage_value, pointer_child(pointer, "stage"))
                                 : std::nullopt;
        if (!room || !stage)
            return std::nullopt;
        std::optional<RoomLifecyclePredictionStage> parsed_stage;
        if (*stage == "before-leave")
            parsed_stage = RoomLifecyclePredictionStage::BeforeLeave;
        else if (*stage == "before-enter")
            parsed_stage = RoomLifecyclePredictionStage::BeforeEnter;
        else if (*stage == "presentation")
            parsed_stage = RoomLifecyclePredictionStage::Presentation;
        else if (*stage == "after-leave")
            parsed_stage = RoomLifecyclePredictionStage::AfterLeave;
        else if (*stage == "after-enter")
            parsed_stage = RoomLifecyclePredictionStage::AfterEnter;
        else {
            decoder.error(k_code_variant,
                          "Unknown Flow Prediction Room lifecycle stage '" + *stage + "'.",
                          pointer_child(pointer, "stage"));
            return std::nullopt;
        }
        return FlowPredictionPoint{RoomLifecyclePredictionPoint{std::move(*room), *parsed_stage}};
    }
    if (*kind != "scene-entry" && *kind != "scene-step" && *kind != "scene-terminal") {
        decoder.error(k_code_variant, "Unknown Flow Prediction point kind '" + *kind + "'.",
                      pointer_child(pointer, "kind"));
        return std::nullopt;
    }
    const auto* scene_value = decoder.member(value, "scene", pointer);
    auto scene = scene_value ? decode_reference<SceneId>(decoder, *scene_value,
                                                         pointer_child(pointer, "scene"), "scene")
                             : std::nullopt;
    if (!scene)
        return std::nullopt;
    if (*kind == "scene-step") {
        const auto* step_value = decoder.member(value, "stepId", pointer);
        auto step = step_value
                        ? decoder.id<SceneStepId>(*step_value, pointer_child(pointer, "stepId"))
                        : std::nullopt;
        return step ? std::optional<FlowPredictionPoint>{SceneStepPredictionPoint{std::move(*scene),
                                                                                  std::move(*step)}}
                    : std::nullopt;
    }
    if (*kind == "scene-terminal")
        return FlowPredictionPoint{SceneTerminalPredictionPoint{std::move(*scene)}};
    return FlowPredictionPoint{SceneEntryPredictionPoint{std::move(*scene)}};
}

std::optional<FlowPredictionCommand> decode_flow_prediction_command(Decoder& decoder,
                                                                    const nlohmann::json& value,
                                                                    std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"kind", "property", "value", "scene", "dialogue", "condition",
                         "thenCommands", "elseCommands"}))
        return std::nullopt;
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;

    if (*kind == "opaque")
        return FlowPredictionCommand{FlowPredictionOpaque{}};
    if (*kind == "set-global-property" || *kind == "invalidate-global-property") {
        const auto* property_value = decoder.member(value, "property", pointer);
        auto property =
            property_value
                ? decode_reference<PropertyId>(decoder, *property_value,
                                               pointer_child(pointer, "property"), "property")
                : std::nullopt;
        if (!property)
            return std::nullopt;
        if (*kind == "invalidate-global-property")
            return FlowPredictionCommand{
                FlowPredictionInvalidateGlobalProperty{std::move(*property)}};
        const auto* runtime_value = decoder.member(value, "value", pointer);
        auto parsed_value = runtime_value ? decode_runtime_value(decoder, *runtime_value,
                                                                 pointer_child(pointer, "value"))
                                          : std::nullopt;
        if (!parsed_value)
            return std::nullopt;
        return FlowPredictionCommand{
            FlowPredictionSetGlobalProperty{std::move(*property), std::move(*parsed_value)}};
    }
    if (*kind == "call-scene" || *kind == "start-detached-scene") {
        const auto* scene_value = decoder.member(value, "scene", pointer);
        auto scene = scene_value
                         ? decode_reference<SceneId>(decoder, *scene_value,
                                                     pointer_child(pointer, "scene"), "scene")
                         : std::nullopt;
        if (!scene)
            return std::nullopt;
        if (*kind == "start-detached-scene")
            return FlowPredictionCommand{FlowPredictionStartDetachedScene{std::move(*scene)}};
        return FlowPredictionCommand{FlowPredictionCallScene{std::move(*scene)}};
    }
    if (*kind == "call-dialogue") {
        const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
        auto dialogue =
            dialogue_value
                ? decode_reference<DialogueId>(decoder, *dialogue_value,
                                               pointer_child(pointer, "dialogue"), "dialogue")
                : std::nullopt;
        return dialogue ? std::optional<FlowPredictionCommand>{FlowPredictionCommand{
                              FlowPredictionCallDialogue{std::move(*dialogue)}}}
                        : std::nullopt;
    }
    if (*kind == "if") {
        const auto* condition_value = decoder.member(value, "condition", pointer);
        const auto* then_value = decoder.member(value, "thenCommands", pointer);
        const auto* else_value = decoder.member(value, "elseCommands", pointer);
        auto condition = condition_value
                             ? decode_condition_impl(decoder, *condition_value,
                                                     pointer_child(pointer, "condition"))
                             : std::nullopt;
        auto decode_commands =
            [&](const nlohmann::json* commands,
                std::string_view name) -> std::optional<std::vector<FlowPredictionCommand>> {
            return commands
                       ? decoder.array<FlowPredictionCommand>(
                             *commands, pointer_child(pointer, name),
                             [&](const nlohmann::json& item, const std::string& item_pointer) {
                                 return decode_flow_prediction_command(decoder, item, item_pointer);
                             })
                       : std::nullopt;
        };
        auto then_commands = decode_commands(then_value, "thenCommands");
        auto else_commands = decode_commands(else_value, "elseCommands");
        if (!condition || !then_commands || !else_commands)
            return std::nullopt;
        return FlowPredictionCommand{FlowPredictionIf{
            std::move(*condition), std::move(*then_commands), std::move(*else_commands)}};
    }

    decoder.error(k_code_variant, "Unknown Flow Prediction command kind '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<std::vector<std::size_t>> decode_flow_prediction_indexes(Decoder& decoder,
                                                                       const nlohmann::json& value,
                                                                       std::string_view pointer)
{
    return decoder.array<std::size_t>(
        value, pointer, [&](const nlohmann::json& item, const std::string& item_pointer) {
            return decoder.unsigned_integer<std::size_t>(item, item_pointer);
        });
}

std::optional<std::size_t> decode_flow_prediction_target(Decoder& decoder,
                                                         const nlohmann::json& value,
                                                         std::string_view pointer)
{
    return decoder.unsigned_integer<std::size_t>(value, pointer);
}

std::optional<FlowPredictionControl> decode_flow_prediction_control(Decoder& decoder,
                                                                    const nlohmann::json& value,
                                                                    std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"kind", "successor", "branches", "fallback", "options"}))
        return std::nullopt;
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "sequential") {
        const auto* successor_value = decoder.member(value, "successor", pointer);
        if (successor_value == nullptr)
            return std::nullopt;
        std::optional<std::size_t> successor;
        if (!successor_value->is_null()) {
            successor = decode_flow_prediction_target(decoder, *successor_value,
                                                      pointer_child(pointer, "successor"));
            if (!successor)
                return std::nullopt;
        }
        return FlowPredictionControl{FlowPredictionSequentialControl{successor}};
    }
    if (*kind == "branch") {
        const auto* branches_value = decoder.member(value, "branches", pointer);
        const auto* fallback_value = decoder.member(value, "fallback", pointer);
        auto branches =
            branches_value
                ? decoder.array<FlowPredictionBranchEdge>(
                      *branches_value, pointer_child(pointer, "branches"),
                      [&](const nlohmann::json& branch, const std::string& branch_pointer)
                          -> std::optional<FlowPredictionBranchEdge> {
                          if (!decoder.object(branch, branch_pointer, {"condition", "target"}))
                              return std::nullopt;
                          const auto* condition_value =
                              decoder.member(branch, "condition", branch_pointer);
                          const auto* target_value =
                              decoder.member(branch, "target", branch_pointer);
                          auto condition = condition_value
                                               ? decode_condition_impl(
                                                     decoder, *condition_value,
                                                     pointer_child(branch_pointer, "condition"))
                                               : std::nullopt;
                          auto target = target_value ? decode_flow_prediction_target(
                                                           decoder, *target_value,
                                                           pointer_child(branch_pointer, "target"))
                                                     : std::nullopt;
                          if (!condition || !target)
                              return std::nullopt;
                          return FlowPredictionBranchEdge{std::move(*condition), *target};
                      })
                : std::nullopt;
        auto fallback = fallback_value
                            ? decode_flow_prediction_target(decoder, *fallback_value,
                                                            pointer_child(pointer, "fallback"))
                            : std::nullopt;
        if (!branches || !fallback)
            return std::nullopt;
        return FlowPredictionControl{FlowPredictionBranchControl{std::move(*branches), *fallback}};
    }
    if (*kind == "choice") {
        const auto* options_value = decoder.member(value, "options", pointer);
        auto options =
            options_value
                ? decoder.array<FlowPredictionChoiceEdge>(
                      *options_value, pointer_child(pointer, "options"),
                      [&](const nlohmann::json& option, const std::string& option_pointer)
                          -> std::optional<FlowPredictionChoiceEdge> {
                          if (!decoder.object(option, option_pointer,
                                              {"optionId", "condition", "programs", "target"}))
                              return std::nullopt;
                          const auto* option_id_value =
                              decoder.member(option, "optionId", option_pointer);
                          std::optional<Condition> condition;
                          if (const auto condition_iter = option.find("condition");
                              condition_iter != option.end()) {
                              auto parsed =
                                  decode_condition_impl(decoder, *condition_iter,
                                                        pointer_child(option_pointer, "condition"));
                              if (!parsed)
                                  return std::nullopt;
                              condition = std::move(*parsed);
                          }
                          const auto* programs_value =
                              decoder.member(option, "programs", option_pointer);
                          const auto* target_value =
                              decoder.member(option, "target", option_pointer);
                          auto option_id =
                              option_id_value
                                  ? decoder.id<SceneChoiceOptionId>(
                                        *option_id_value, pointer_child(option_pointer, "optionId"))
                                  : std::nullopt;
                          auto programs =
                              programs_value
                                  ? decoder.array<std::vector<FlowPredictionCommand>>(
                                        *programs_value, pointer_child(option_pointer, "programs"),
                                        [&](const nlohmann::json& program,
                                            const std::string& program_pointer) {
                                            return decoder.array<FlowPredictionCommand>(
                                                program, program_pointer,
                                                [&](const nlohmann::json& command,
                                                    const std::string& command_pointer) {
                                                    return decode_flow_prediction_command(
                                                        decoder, command, command_pointer);
                                                });
                                        })
                                  : std::nullopt;
                          auto target = target_value ? decode_flow_prediction_target(
                                                           decoder, *target_value,
                                                           pointer_child(option_pointer, "target"))
                                                     : std::nullopt;
                          if (!option_id || !programs || !target)
                              return std::nullopt;
                          return FlowPredictionChoiceEdge{std::move(*option_id),
                                                          std::move(condition),
                                                          std::move(*programs), *target};
                      })
                : std::nullopt;
        if (!options)
            return std::nullopt;
        return FlowPredictionControl{FlowPredictionChoiceControl{std::move(*options)}};
    }
    decoder.error(k_code_variant, "Unknown Flow Prediction control kind '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<FlowPredictionFrontier> decode_flow_prediction_frontier(Decoder& decoder,
                                                                      const nlohmann::json& value,
                                                                      std::string_view pointer)
{
    auto frontier = decoder.string(value, pointer);
    if (!frontier)
        return std::nullopt;
    if (*frontier == "normal")
        return FlowPredictionFrontier::Normal;
    if (*frontier == "short-wait")
        return FlowPredictionFrontier::ShortWait;
    if (*frontier == "strong-wait")
        return FlowPredictionFrontier::StrongWait;
    if (*frontier == "decision")
        return FlowPredictionFrontier::Decision;
    decoder.error(k_code_variant, "Unknown Flow Prediction frontier '" + *frontier + "'.",
                  std::string(pointer));
    return std::nullopt;
}

std::optional<FlowPredictionIndex> decode_flow_prediction_index(Decoder& decoder,
                                                                const nlohmann::json& value,
                                                                std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"dependencyGroups", "slices"}))
        return std::nullopt;
    const auto* groups_value = decoder.member(value, "dependencyGroups", pointer);
    const auto* slices_value = decoder.member(value, "slices", pointer);
    auto groups =
        groups_value ? decoder.array<std::vector<FlowPredictionDependency>>(
                           *groups_value, pointer_child(pointer, "dependencyGroups"),
                           [&](const nlohmann::json& group, const std::string& group_pointer) {
                               return decoder.array<FlowPredictionDependency>(
                                   group, group_pointer,
                                   [&](const nlohmann::json& dependency,
                                       const std::string& dependency_pointer) {
                                       return decode_flow_prediction_dependency(decoder, dependency,
                                                                                dependency_pointer);
                                   });
                           })
                     : std::nullopt;
    auto slices =
        slices_value
            ? decoder.array<FlowPredictionSlice>(
                  *slices_value, pointer_child(pointer, "slices"),
                  [&](const nlohmann::json& slice,
                      const std::string& slice_pointer) -> std::optional<FlowPredictionSlice> {
                      if (!decoder.object(slice, slice_pointer,
                                          {"point", "dependencyGroups", "condition",
                                           "conditionFalseSuccessor", "control", "frontier",
                                           "program"}))
                          return std::nullopt;
                      const auto* point_value = decoder.member(slice, "point", slice_pointer);
                      const auto* dependency_groups_value =
                          decoder.member(slice, "dependencyGroups", slice_pointer);
                      const auto* false_successor_value =
                          decoder.member(slice, "conditionFalseSuccessor", slice_pointer);
                      const auto* control_value = decoder.member(slice, "control", slice_pointer);
                      const auto* frontier_value = decoder.member(slice, "frontier", slice_pointer);
                      const auto* program_value = decoder.member(slice, "program", slice_pointer);
                      auto point =
                          point_value
                              ? decode_flow_prediction_point(decoder, *point_value,
                                                             pointer_child(slice_pointer, "point"))
                              : std::nullopt;
                      auto dependency_groups =
                          dependency_groups_value
                              ? decode_flow_prediction_indexes(
                                    decoder, *dependency_groups_value,
                                    pointer_child(slice_pointer, "dependencyGroups"))
                              : std::nullopt;
                      std::optional<Condition> condition;
                      if (const auto condition_iter = slice.find("condition");
                          condition_iter != slice.end()) {
                          auto parsed = decode_condition_impl(
                              decoder, *condition_iter, pointer_child(slice_pointer, "condition"));
                          if (!parsed)
                              return std::nullopt;
                          condition = std::move(*parsed);
                      }
                      bool false_successor_ok = false_successor_value != nullptr;
                      std::optional<std::size_t> false_successor;
                      if (false_successor_value && !false_successor_value->is_null()) {
                          false_successor = decode_flow_prediction_target(
                              decoder, *false_successor_value,
                              pointer_child(slice_pointer, "conditionFalseSuccessor"));
                          false_successor_ok = false_successor.has_value();
                      }
                      auto control = control_value ? decode_flow_prediction_control(
                                                         decoder, *control_value,
                                                         pointer_child(slice_pointer, "control"))
                                                   : std::nullopt;
                      auto frontier = frontier_value ? decode_flow_prediction_frontier(
                                                           decoder, *frontier_value,
                                                           pointer_child(slice_pointer, "frontier"))
                                                     : std::nullopt;
                      auto program = program_value ? decoder.array<FlowPredictionCommand>(
                                                         *program_value,
                                                         pointer_child(slice_pointer, "program"),
                                                         [&](const nlohmann::json& command,
                                                             const std::string& command_pointer) {
                                                             return decode_flow_prediction_command(
                                                                 decoder, command, command_pointer);
                                                         })
                                                   : std::nullopt;
                      if (!point || !dependency_groups || !false_successor_ok || !control ||
                          !frontier || !program)
                          return std::nullopt;
                      return FlowPredictionSlice{
                          std::move(*point),  std::move(*dependency_groups), std::move(condition),
                          false_successor,    std::move(*control),           *frontier,
                          std::move(*program)};
                  })
            : std::nullopt;
    if (!groups || !slices)
        return std::nullopt;
    return FlowPredictionIndex{std::move(*groups), std::move(*slices)};
}

} // namespace

Result<SharedProject, Diagnostics> decode_shared_project(const nlohmann::json& document,
                                                         std::string source_path)
{
    Decoder decoder(std::move(source_path));
    if (!decoder.object(document, "",
                        {"archetypes", "bootstrapModule", "definitions", "entrypoint",
                         "flowPrediction", "interactableInstances", "inventories", "localization",
                         "project", "properties", "resources", "saveContract", "schema",
                         "schemaVersion", "settings", "traits", "undefinedInteractionProgram"}))
        return Result<SharedProject, Diagnostics>::failure(decoder.take_diagnostics());

    const auto* schema_value = decoder.member(document, "schema", "");
    const auto* version_value = decoder.member(document, "schemaVersion", "");
    const auto* project_value = decoder.member(document, "project", "");
    const auto* settings_value = decoder.member(document, "settings", "");
    const auto* entrypoint_value = decoder.member(document, "entrypoint", "");
    const auto flow_prediction_iter = document.find("flowPrediction");
    const auto* flow_prediction_value =
        flow_prediction_iter == document.end() ? nullptr : &*flow_prediction_iter;
    const auto* bootstrap_value = decoder.member(document, "bootstrapModule", "");
    const auto* save_contract_value = decoder.member(document, "saveContract", "");
    const auto* localization_value = decoder.member(document, "localization", "");
    const auto* inventories_value = decoder.member(document, "inventories", "");
    const auto* interactable_instances_value =
        decoder.member(document, "interactableInstances", "");
    const auto* properties_value = decoder.member(document, "properties", "");
    const auto* traits_value = decoder.member(document, "traits", "");
    const auto* archetypes_value = decoder.member(document, "archetypes", "");
    const auto* resources_value = decoder.member(document, "resources", "");
    const auto* definitions_value = decoder.member(document, "definitions", "");
    const auto undefined_interaction_iter = document.find("undefinedInteractionProgram");
    const auto* undefined_interaction_value =
        undefined_interaction_iter == document.end() ? nullptr : &*undefined_interaction_iter;

    auto schema = schema_value ? decoder.string(*schema_value, "/schema") : std::nullopt;
    if (schema && *schema != "noveltea.compiled.project") {
        if (*schema == "noveltea.runtime.project")
            decoder.error("compiled_project.unsupported_provisional_schema",
                          "The provisional 'noveltea.runtime.project' schema is unsupported; "
                          "expected 'noveltea.compiled.project' format version 1.",
                          "/schema");
        else
            decoder.error("compiled_project.unsupported_schema",
                          "Expected schema 'noveltea.compiled.project'.", "/schema");
        schema.reset();
    }
    auto version = version_value
                       ? decoder.unsigned_integer<std::uint32_t>(*version_value, "/schemaVersion")
                       : std::nullopt;
    if (version && *version != 1) {
        decoder.error("compiled_project.unsupported_version", "Only format version 1 is supported.",
                      "/schemaVersion");
        version.reset();
    }
    auto identity =
        project_value ? decode_project_identity(decoder, *project_value, "/project") : std::nullopt;
    auto settings =
        settings_value ? decode_settings(decoder, *settings_value, "/settings") : std::nullopt;
    auto entrypoint = entrypoint_value
                          ? decode_entrypoint(decoder, *entrypoint_value, "/entrypoint")
                          : std::nullopt;
    bool flow_prediction_valid = true;
    std::optional<FlowPredictionIndex> flow_prediction;
    if (flow_prediction_value && !flow_prediction_value->is_null()) {
        auto decoded =
            decode_flow_prediction_index(decoder, *flow_prediction_value, "/flowPrediction");
        flow_prediction_valid = decoded.has_value();
        if (decoded)
            flow_prediction = std::move(*decoded);
    }
    auto bootstrap = bootstrap_value ? decode_reference<ScriptId>(decoder, *bootstrap_value,
                                                                  "/bootstrapModule", "script")
                                     : std::nullopt;
    auto save_contract =
        save_contract_value ? decoder.string(*save_contract_value, "/saveContract") : std::nullopt;
    if (save_contract) {
        const auto suffix = std::string_view(*save_contract)
                                .substr(std::min<std::size_t>(4, save_contract->size()));
        const bool lowercase_hex = std::ranges::all_of(suffix, [](const char character) {
            return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
        });
        if (!save_contract->starts_with("sc1:") || save_contract->size() != 36 || !lowercase_hex) {
            decoder.error("compiled_project.invalid_save_contract",
                          "Save Contract must use canonical 'sc1:' identity spelling.",
                          "/saveContract");
            save_contract.reset();
        }
    }
    auto localization = localization_value
                            ? decode_localization(decoder, *localization_value, "/localization")
                            : std::nullopt;
    bool undefined_interaction_valid = true;
    std::optional<InteractionProgram> undefined_interaction_program;
    if (undefined_interaction_value && !undefined_interaction_value->is_null()) {
        auto decoded = decode_interaction_program(decoder, *undefined_interaction_value,
                                                  "/undefinedInteractionProgram");
        undefined_interaction_valid = decoded.has_value();
        if (decoded)
            undefined_interaction_program = std::move(*decoded);
    }
    auto inventories =
        inventories_value
            ? decoder.array<InventoryDefinition>(
                  *inventories_value, "/inventories",
                  [&](const nlohmann::json& item,
                      const std::string& pointer) -> std::optional<InventoryDefinition> {
                      if (!decoder.object(item, pointer, {"id", "label"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", pointer);
                      const auto* label_value = decoder.member(item, "label", pointer);
                      auto id = id_value ? decoder.id<InventoryId>(*id_value,
                                                                   pointer_child(pointer, "id"))
                                         : std::nullopt;
                      auto label = label_value ? decoder.string(*label_value,
                                                                pointer_child(pointer, "label"))
                                               : std::nullopt;
                      return id && label ? std::optional<InventoryDefinition>(InventoryDefinition{
                                               std::move(*id), std::move(*label)})
                                         : std::nullopt;
                  })
            : std::nullopt;
    auto properties = properties_value
                          ? decoder.array<PropertyDeclaration>(
                                *properties_value, "/properties",
                                [&](const nlohmann::json& item, const std::string& pointer) {
                                    return decode_property(decoder, item, pointer);
                                })
                          : std::nullopt;
    auto interactable_instances =
        interactable_instances_value
            ? decoder.array<InteractableInstanceDeclaration>(
                  *interactable_instances_value, "/interactableInstances",
                  [&](const nlohmann::json& item, const std::string& pointer)
                      -> std::optional<InteractableInstanceDeclaration> {
                      if (!decoder.object(item, pointer,
                                          {"definition", "enabled", "featureOverrides", "id",
                                           "location", "localProperties", "propertyOverrides",
                                           "quantity", "traitAdds", "traitRemoves", "visible"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", pointer);
                      const auto* definition_value = decoder.member(item, "definition", pointer);
                      const auto* location_value = decoder.member(item, "location", pointer);
                      const auto* enabled_value = decoder.member(item, "enabled", pointer);
                      const auto* visible_value = decoder.member(item, "visible", pointer);
                      const auto* quantity_value = decoder.member(item, "quantity", pointer);
                      const auto* adds_value = decoder.member(item, "traitAdds", pointer);
                      const auto* removes_value = decoder.member(item, "traitRemoves", pointer);
                      const auto* overrides_value =
                          decoder.member(item, "propertyOverrides", pointer);
                      const auto* local_properties_value =
                          decoder.member(item, "localProperties", pointer);
                      const auto* feature_overrides_value =
                          decoder.member(item, "featureOverrides", pointer);
                      auto id = id_value ? decoder.id<InteractableInstanceId>(
                                               *id_value, pointer_child(pointer, "id"))
                                         : std::nullopt;
                      auto definition =
                          definition_value
                              ? decode_reference<InteractableDefinitionId>(
                                    decoder, *definition_value,
                                    pointer_child(pointer, "definition"), "interactable-definition")
                              : std::nullopt;
                      auto location = location_value
                                          ? decode_location(decoder, *location_value,
                                                            pointer_child(pointer, "location"))
                                          : std::nullopt;
                      auto enabled =
                          enabled_value
                              ? decoder.boolean(*enabled_value, pointer_child(pointer, "enabled"))
                              : std::nullopt;
                      auto visible =
                          visible_value
                              ? decoder.boolean(*visible_value, pointer_child(pointer, "visible"))
                              : std::nullopt;
                      auto quantity = quantity_value ? decoder.unsigned_integer<std::uint64_t>(
                                                           *quantity_value,
                                                           pointer_child(pointer, "quantity"), true)
                                                     : std::nullopt;
                      if (quantity && *quantity > max_interactable_quantity) {
                          decoder.error(k_code_number,
                                        "Interactable quantity exceeds the portable numeric range.",
                                        pointer_child(pointer, "quantity"));
                          quantity = std::nullopt;
                      }
                      const auto decode_traits =
                          [&](const nlohmann::json* value,
                              std::string_view member) -> std::optional<std::vector<TraitId>> {
                          if (!value)
                              return std::nullopt;
                          return decoder.array<TraitId>(
                              *value, pointer_child(pointer, member),
                              [&](const nlohmann::json& trait,
                                  const std::string& item_pointer) -> std::optional<TraitId> {
                                  return decoder.id<TraitId>(trait, item_pointer);
                              });
                      };
                      auto trait_adds = decode_traits(adds_value, "traitAdds");
                      auto trait_removes = decode_traits(removes_value, "traitRemoves");
                      auto property_overrides =
                          overrides_value
                              ? decoder.array<PropertyAssignment>(
                                    *overrides_value, pointer_child(pointer, "propertyOverrides"),
                                    [&](const nlohmann::json& assignment,
                                        const std::string& item_pointer)
                                        -> std::optional<PropertyAssignment> {
                                        if (!decoder.object(assignment, item_pointer,
                                                            {"propertyId", "value"}))
                                            return std::nullopt;
                                        const auto* property_value =
                                            decoder.member(assignment, "propertyId", item_pointer);
                                        const auto* value_value =
                                            decoder.member(assignment, "value", item_pointer);
                                        auto property =
                                            property_value
                                                ? decoder.id<PropertyId>(
                                                      *property_value,
                                                      pointer_child(item_pointer, "propertyId"))
                                                : std::nullopt;
                                        auto runtime_value =
                                            value_value ? decode_runtime_value(
                                                              decoder, *value_value,
                                                              pointer_child(item_pointer, "value"))
                                                        : std::nullopt;
                                        return property && runtime_value
                                                   ? std::optional<PropertyAssignment>(
                                                         PropertyAssignment{
                                                             std::move(*property),
                                                             std::move(*runtime_value)})
                                                   : std::nullopt;
                                    })
                              : std::nullopt;
                      auto local_properties =
                          local_properties_value
                              ? decoder.array<InstanceLocalProperty>(
                                    *local_properties_value,
                                    pointer_child(pointer, "localProperties"),
                                    [&](const nlohmann::json& local,
                                        const std::string& item_pointer)
                                        -> std::optional<InstanceLocalProperty> {
                                        if (!local.is_object())
                                            return std::nullopt;
                                        auto contract_json = local;
                                        const auto* value_value =
                                            decoder.member(local, "value", item_pointer);
                                        contract_json.erase("value");
                                        auto contract = decode_owner_property_contract(
                                            decoder, contract_json, item_pointer);
                                        auto runtime_value =
                                            value_value ? decode_runtime_value(
                                                              decoder, *value_value,
                                                              pointer_child(item_pointer, "value"))
                                                        : std::nullopt;
                                        return contract && runtime_value
                                                   ? std::optional<InstanceLocalProperty>(
                                                         InstanceLocalProperty{
                                                             std::move(*contract),
                                                             std::move(*runtime_value)})
                                                   : std::nullopt;
                                    })
                              : std::nullopt;
                      auto feature_overrides =
                          feature_overrides_value
                              ? decoder.array<InteractableFeatureOverride>(
                                    *feature_overrides_value,
                                    pointer_child(pointer, "featureOverrides"),
                                    [&](const nlohmann::json& override_value,
                                        const std::string& override_pointer)
                                        -> std::optional<InteractableFeatureOverride> {
                                        if (!decoder.object(override_value, override_pointer,
                                                            {"featureId", "propertyOverrides",
                                                             "traitAdds", "traitRemoves"}))
                                            return std::nullopt;
                                        const auto* feature_value = decoder.member(
                                            override_value, "featureId", override_pointer);
                                        const auto* override_adds = decoder.member(
                                            override_value, "traitAdds", override_pointer);
                                        const auto* override_removes = decoder.member(
                                            override_value, "traitRemoves", override_pointer);
                                        const auto* override_properties = decoder.member(
                                            override_value, "propertyOverrides", override_pointer);
                                        auto feature =
                                            feature_value
                                                ? decoder.id<FeatureId>(
                                                      *feature_value,
                                                      pointer_child(override_pointer, "featureId"))
                                                : std::nullopt;
                                        const auto decode_override_traits =
                                            [&](const nlohmann::json* values,
                                                std::string_view member)
                                            -> std::optional<std::vector<TraitId>> {
                                            if (!values)
                                                return std::nullopt;
                                            return decoder.array<TraitId>(
                                                *values, pointer_child(override_pointer, member),
                                                [&](const nlohmann::json& trait,
                                                    const std::string& trait_pointer)
                                                    -> std::optional<TraitId> {
                                                    return decoder.id<TraitId>(trait,
                                                                               trait_pointer);
                                                });
                                        };
                                        auto adds =
                                            decode_override_traits(override_adds, "traitAdds");
                                        auto removes = decode_override_traits(override_removes,
                                                                              "traitRemoves");
                                        auto properties =
                                            override_properties
                                                ? decoder.array<PropertyAssignment>(
                                                      *override_properties,
                                                      pointer_child(override_pointer,
                                                                    "propertyOverrides"),
                                                      [&](const nlohmann::json& assignment,
                                                          const std::string& assignment_pointer)
                                                          -> std::optional<PropertyAssignment> {
                                                          if (!decoder.object(
                                                                  assignment, assignment_pointer,
                                                                  {"propertyId", "value"}))
                                                              return std::nullopt;
                                                          const auto* property_value =
                                                              decoder.member(assignment,
                                                                             "propertyId",
                                                                             assignment_pointer);
                                                          const auto* runtime_value =
                                                              decoder.member(assignment, "value",
                                                                             assignment_pointer);
                                                          auto property =
                                                              property_value
                                                                  ? decoder.id<PropertyId>(
                                                                        *property_value,
                                                                        pointer_child(
                                                                            assignment_pointer,
                                                                            "propertyId"))
                                                                  : std::nullopt;
                                                          auto value =
                                                              runtime_value
                                                                  ? decode_runtime_value(
                                                                        decoder, *runtime_value,
                                                                        pointer_child(
                                                                            assignment_pointer,
                                                                            "value"))
                                                                  : std::nullopt;
                                                          return property && value
                                                                     ? std::optional<
                                                                           PropertyAssignment>(
                                                                           PropertyAssignment{
                                                                               std::move(*property),
                                                                               std::move(*value)})
                                                                     : std::nullopt;
                                                      })
                                                : std::nullopt;
                                        return feature && adds && removes && properties
                                                   ? std::optional<InteractableFeatureOverride>(
                                                         InteractableFeatureOverride{
                                                             std::move(*feature), std::move(*adds),
                                                             std::move(*removes),
                                                             std::move(*properties)})
                                                   : std::nullopt;
                                    })
                              : std::nullopt;
                      if (!id || !definition || !location || !enabled || !visible || !quantity ||
                          !trait_adds || !trait_removes || !property_overrides ||
                          !local_properties || !feature_overrides)
                          return std::nullopt;
                      return InteractableInstanceDeclaration{std::move(*id),
                                                             std::move(*definition),
                                                             std::move(*location),
                                                             *enabled,
                                                             *visible,
                                                             *quantity,
                                                             std::move(*trait_adds),
                                                             std::move(*trait_removes),
                                                             std::move(*property_overrides),
                                                             std::move(*local_properties),
                                                             std::move(*feature_overrides)};
                  })
            : std::nullopt;
    auto traits = traits_value ? decoder.array<TraitDeclaration>(
                                     *traits_value, "/traits",
                                     [&](const nlohmann::json& item, const std::string& pointer) {
                                         return decode_trait(decoder, item, pointer);
                                     })
                               : std::nullopt;
    auto archetypes = archetypes_value
                          ? decoder.array<ArchetypeDefinition>(
                                *archetypes_value, "/archetypes",
                                [&](const nlohmann::json& item, const std::string& pointer) {
                                    return decode_archetype(decoder, item, pointer);
                                })
                          : std::nullopt;

    std::optional<std::vector<AssetResource>> assets;
    std::optional<std::vector<LayoutResource>> layouts;
    std::optional<std::vector<MaterialInterfaceResource>> material_interfaces;
    std::optional<std::vector<ScriptResource>> scripts;
    if (resources_value && decoder.object(*resources_value, "/resources",
                                          {"assets", "layouts", "materialInterfaces", "scripts"})) {
        const auto* assets_value = decoder.member(*resources_value, "assets", "/resources");
        const auto* layouts_value = decoder.member(*resources_value, "layouts", "/resources");
        const auto* material_interfaces_value =
            decoder.member(*resources_value, "materialInterfaces", "/resources");
        const auto* scripts_value = decoder.member(*resources_value, "scripts", "/resources");
        if (assets_value)
            assets = decoder.array<AssetResource>(
                *assets_value, "/resources/assets",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_asset(decoder, item, pointer);
                });
        if (layouts_value)
            layouts = decoder.array<LayoutResource>(
                *layouts_value, "/resources/layouts",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_layout(decoder, item, pointer);
                });
        if (material_interfaces_value)
            material_interfaces = decoder.array<MaterialInterfaceResource>(
                *material_interfaces_value, "/resources/materialInterfaces",
                [&](const nlohmann::json& item,
                    const std::string& pointer) -> std::optional<MaterialInterfaceResource> {
                    if (!decoder.object(item, pointer,
                                        {"id", "parameters", "postprocessScope", "role"}))
                        return std::nullopt;
                    const auto* id_value = decoder.member(item, "id", pointer);
                    const auto* role_value = decoder.member(item, "role", pointer);
                    const auto* scope_value = decoder.member(item, "postprocessScope", pointer);
                    const auto* parameters_value = decoder.member(item, "parameters", pointer);
                    auto id = id_value
                                  ? decoder.id<MaterialId>(*id_value, pointer_child(pointer, "id"))
                                  : std::nullopt;
                    auto role = role_value
                                    ? decoder.enumeration<MaterialRole>(
                                          *role_value, pointer_child(pointer, "role"),
                                          {{"engine-2d", MaterialRole::Engine2D},
                                           {"active-text", MaterialRole::ActiveText},
                                           {"rmlui-decorator", MaterialRole::RmlUiDecorator},
                                           {"rmlui-filter", MaterialRole::RmlUiFilter},
                                           {"postprocess", MaterialRole::Postprocess},
                                           {"hotspot-overlay", MaterialRole::HotspotOverlay}})
                                    : std::nullopt;
                    auto scope = scope_value
                                     ? decoder.enumeration<MaterialPostprocessScope>(
                                           *scope_value, pointer_child(pointer, "postprocessScope"),
                                           {{"world", MaterialPostprocessScope::World},
                                            {"full-game-viewport",
                                             MaterialPostprocessScope::FullGameViewport}})
                                     : std::nullopt;
                    auto parameters =
                        parameters_value
                            ? decoder.array<MaterialParameterDeclaration>(
                                  *parameters_value, pointer_child(pointer, "parameters"),
                                  [&](const nlohmann::json& parameter,
                                      const std::string& parameter_pointer)
                                      -> std::optional<MaterialParameterDeclaration> {
                                      if (!decoder.object(parameter, parameter_pointer,
                                                          {"name", "rendererBinding", "type"}))
                                          return std::nullopt;
                                      const auto* name_value =
                                          decoder.member(parameter, "name", parameter_pointer);
                                      const auto* type_value =
                                          decoder.member(parameter, "type", parameter_pointer);
                                      const auto* binding_value = decoder.member(
                                          parameter, "rendererBinding", parameter_pointer);
                                      auto name =
                                          name_value ? decoder.string(
                                                           *name_value,
                                                           pointer_child(parameter_pointer, "name"))
                                                     : std::nullopt;
                                      auto type =
                                          type_value ? decoder.enumeration<MaterialParameterType>(
                                                           *type_value,
                                                           pointer_child(parameter_pointer, "type"),
                                                           {{"float", MaterialParameterType::Float},
                                                            {"vec2", MaterialParameterType::Vec2},
                                                            {"vec3", MaterialParameterType::Vec3},
                                                            {"vec4", MaterialParameterType::Vec4},
                                                            {"color", MaterialParameterType::Color},
                                                            {"int", MaterialParameterType::Int},
                                                            {"bool", MaterialParameterType::Bool}})
                                                     : std::nullopt;
                                      std::optional<std::string> binding;
                                      bool binding_ok = binding_value != nullptr;
                                      if (binding_value && !binding_value->is_null()) {
                                          binding = decoder.string(
                                              *binding_value,
                                              pointer_child(parameter_pointer, "rendererBinding"));
                                          binding_ok = binding.has_value();
                                      }
                                      return name && type && binding_ok
                                                 ? std::optional<MaterialParameterDeclaration>(
                                                       MaterialParameterDeclaration{
                                                           std::move(*name), *type,
                                                           std::move(binding)})
                                                 : std::nullopt;
                                  })
                            : std::nullopt;
                    if (parameters) {
                        std::unordered_set<std::string> names;
                        for (std::size_t index = 0; index < parameters->size(); ++index) {
                            if (!names.emplace((*parameters)[index].name).second)
                                decoder.error(k_code_duplicate,
                                              "Duplicate Material Parameter declaration name.",
                                              pointer_child(pointer_child(pointer, "parameters"),
                                                            std::to_string(index)) +
                                                  "/name");
                        }
                    }
                    return id && role && scope && parameters
                               ? std::optional<MaterialInterfaceResource>(MaterialInterfaceResource{
                                     std::move(*id), *role, *scope, std::move(*parameters)})
                               : std::nullopt;
                });
        if (scripts_value)
            scripts = decoder.array<ScriptResource>(
                *scripts_value, "/resources/scripts",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_script(decoder, item, pointer);
                });
    }

    std::optional<std::vector<CharacterDefinition>> characters;
    std::optional<std::vector<RoomDefinition>> rooms;
    std::optional<std::vector<InteractableDefinition>> interactables;
    std::optional<std::vector<VerbDefinition>> verbs;
    std::optional<std::vector<InteractionDefinition>> interactions;
    std::optional<std::vector<SceneDefinition>> scenes;
    std::optional<std::vector<DialogueDefinition>> dialogues;
    std::optional<std::vector<MapDefinition>> maps;
    if (definitions_value && decoder.object(*definitions_value, "/definitions",
                                            {"characters", "dialogues", "interactables",
                                             "interactions", "maps", "rooms", "scenes", "verbs"})) {
#define NOVELTEA_DECODE_DEFINITION(member_name, variable_name, type_name, function_name)           \
    if (const auto* collection = decoder.member(*definitions_value, member_name, "/definitions"))  \
    variable_name =                                                                                \
        decoder.array<type_name>(*collection, "/definitions/" member_name,                         \
                                 [&](const nlohmann::json& item, const std::string& pointer) {     \
                                     return function_name(decoder, item, pointer);                 \
                                 })
        NOVELTEA_DECODE_DEFINITION("characters", characters, CharacterDefinition, decode_character);
        NOVELTEA_DECODE_DEFINITION("rooms", rooms, RoomDefinition, decode_room);
        NOVELTEA_DECODE_DEFINITION("interactables", interactables, InteractableDefinition,
                                   decode_interactable);
        NOVELTEA_DECODE_DEFINITION("verbs", verbs, VerbDefinition, decode_verb);
        NOVELTEA_DECODE_DEFINITION("interactions", interactions, InteractionDefinition,
                                   decode_interaction);
        NOVELTEA_DECODE_DEFINITION("scenes", scenes, SceneDefinition, decode_scene);
        NOVELTEA_DECODE_DEFINITION("dialogues", dialogues, DialogueDefinition, decode_dialogue);
        NOVELTEA_DECODE_DEFINITION("maps", maps, MapDefinition, decode_map);
#undef NOVELTEA_DECODE_DEFINITION
    }

    if (inventories)
        decoder.duplicate_ids(
            *inventories, "/inventories",
            [](const InventoryDefinition& value) -> const InventoryId& { return value.id; });
    if (properties) {
        for (std::size_t index = 0; index < properties->size(); ++index) {
            const auto& property = (*properties)[index];
            for (std::size_t previous = 0; previous < index; ++previous) {
                const auto& candidate = (*properties)[previous];
                const bool same_registry_identity =
                    !property.exact_owner && !candidate.exact_owner && property.id == candidate.id;
                const bool same_exact_identity = property.exact_owner && candidate.exact_owner &&
                                                 property.id == candidate.id &&
                                                 *property.exact_owner == *candidate.exact_owner;
                if (!same_registry_identity && !same_exact_identity)
                    continue;
                decoder.error("compiled_project.duplicate_id",
                              "Duplicate Property identity '" + property.id.text() + "'.",
                              "/properties/" + std::to_string(index) + "/id");
                break;
            }
        }
    }
    if (interactable_instances)
        decoder.duplicate_ids(
            *interactable_instances, "/interactableInstances",
            [](const InteractableInstanceDeclaration& value) -> const InteractableInstanceId& {
                return value.id;
            });
    if (traits)
        decoder.duplicate_ids(
            *traits, "/traits",
            [](const TraitDeclaration& value) -> const TraitId& { return value.id; });
    if (archetypes)
        decoder.duplicate_ids(
            *archetypes, "/archetypes",
            [](const ArchetypeDefinition& value) -> const ArchetypeId& { return value.id; });
    if (assets)
        decoder.duplicate_ids(
            *assets, "/resources/assets",
            [](const AssetResource& value) -> const AssetId& { return value.id; });
    if (layouts)
        decoder.duplicate_ids(
            *layouts, "/resources/layouts",
            [](const LayoutResource& value) -> const LayoutId& { return value.id; });
    if (material_interfaces)
        decoder.duplicate_ids(
            *material_interfaces, "/resources/materialInterfaces",
            [](const MaterialInterfaceResource& value) -> const MaterialId& { return value.id; });
    if (scripts)
        decoder.duplicate_ids(
            *scripts, "/resources/scripts",
            [](const ScriptResource& value) -> const ScriptId& { return value.id; });
#define NOVELTEA_DUPLICATE_DEFINITION(variable_name, pointer, id_type)                             \
    if (variable_name)                                                                             \
    decoder.duplicate_ids(*variable_name, pointer,                                                 \
                          [](const auto& value) -> const id_type& { return value.identity.id; })
    NOVELTEA_DUPLICATE_DEFINITION(characters, "/definitions/characters", CharacterId);
    NOVELTEA_DUPLICATE_DEFINITION(rooms, "/definitions/rooms", RoomId);
    NOVELTEA_DUPLICATE_DEFINITION(interactables, "/definitions/interactables",
                                  InteractableDefinitionId);
    NOVELTEA_DUPLICATE_DEFINITION(verbs, "/definitions/verbs", VerbId);
    NOVELTEA_DUPLICATE_DEFINITION(interactions, "/definitions/interactions", InteractionId);
    NOVELTEA_DUPLICATE_DEFINITION(scenes, "/definitions/scenes", SceneId);
    NOVELTEA_DUPLICATE_DEFINITION(dialogues, "/definitions/dialogues", DialogueId);
    NOVELTEA_DUPLICATE_DEFINITION(maps, "/definitions/maps", MapId);
#undef NOVELTEA_DUPLICATE_DEFINITION

    const bool complete =
        schema && version && identity && settings && entrypoint && flow_prediction_valid &&
        bootstrap && save_contract && localization && inventories && properties && traits &&
        archetypes && interactable_instances && assets && layouts && material_interfaces &&
        scripts && characters && rooms && interactables && verbs && interactions &&
        undefined_interaction_valid && scenes && dialogues && maps;
    if (!complete || decoder.failed())
        return Result<SharedProject, Diagnostics>::failure(decoder.take_diagnostics());

    return Result<SharedProject, Diagnostics>::success(
        SharedProject{std::move(*identity),
                      std::move(*settings),
                      std::move(*entrypoint),
                      std::move(flow_prediction),
                      std::move(*bootstrap),
                      std::move(*save_contract),
                      std::move(*localization),
                      std::move(*properties),
                      std::move(*traits),
                      std::move(*archetypes),
                      std::move(*inventories),
                      std::move(*assets),
                      std::move(*layouts),
                      std::move(*material_interfaces),
                      std::move(*scripts),
                      std::move(*characters),
                      std::move(*rooms),
                      std::move(*interactables),
                      std::move(*interactable_instances),
                      std::move(*verbs),
                      std::move(*interactions),
                      std::move(undefined_interaction_program),
                      std::move(*scenes),
                      std::move(*dialogues),
                      std::move(*maps)});
}

} // namespace noveltea::core::compiled::wire
