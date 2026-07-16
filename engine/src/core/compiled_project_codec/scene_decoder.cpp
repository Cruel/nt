#include "internal.hpp"

namespace noveltea::core::compiled::wire::detail {

std::optional<SceneInstruction>
decode_scene_instruction(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a Scene instruction object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* id_value = decoder.member(value, "id", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    auto id =
        id_value ? decoder.id<SceneStepId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    bool condition_ok = false;
    auto condition = decode_optional_condition(decoder, value, pointer, condition_ok);
    if (!kind || !id || !condition_ok)
        return std::nullopt;
#define SCENE_FIELDS(...) decoder.object(value, pointer, {"condition", "id", "kind", __VA_ARGS__})
    if (*kind == "set-background") {
        SCENE_FIELDS("asset", "color", "durationMs", "fit", "material", "skippable", "transition",
                     "waitForCompletion");
        const auto* asset_value = decoder.member(value, "asset", pointer);
        const auto* color_value = decoder.member(value, "color", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* fit_value = decoder.member(value, "fit", pointer);
        const auto* material_value = decoder.member(value, "material", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        const auto* transition_value = decoder.member(value, "transition", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        std::optional<AssetId> asset;
        bool asset_ok = asset_value != nullptr;
        if (asset_value && !asset_value->is_null()) {
            asset = decode_reference<AssetId>(decoder, *asset_value,
                                              pointer_child(pointer, "asset"), "asset");
            asset_ok = asset.has_value();
        }
        std::optional<std::string> color;
        bool color_ok = color_value != nullptr;
        if (color_value && !color_value->is_null()) {
            color = decoder.string(*color_value, pointer_child(pointer, "color"));
            color_ok = color.has_value();
        }
        auto fit =
            fit_value
                ? decoder.enumeration<BackgroundFit>(*fit_value, pointer_child(pointer, "fit"),
                                                     {{"cover", BackgroundFit::Cover},
                                                      {"contain", BackgroundFit::Contain},
                                                      {"stretch", BackgroundFit::Stretch},
                                                      {"center", BackgroundFit::Center}})
                : std::nullopt;
        std::optional<MaterialId> material;
        bool material_ok = material_value != nullptr;
        if (material_value && !material_value->is_null()) {
            material = decode_reference<MaterialId>(decoder, *material_value,
                                                    pointer_child(pointer, "material"), "material");
            material_ok = material.has_value();
        }
        auto transition = transition_value
                              ? decoder.enumeration<BackgroundTransition>(
                                    *transition_value, pointer_child(pointer, "transition"),
                                    {{"none", BackgroundTransition::None},
                                     {"fade", BackgroundTransition::Fade},
                                     {"cut", BackgroundTransition::Cut}})
                              : std::nullopt;
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        if (transition && duration && waits) {
            if (*transition == BackgroundTransition::Fade && *duration == 0) {
                decoder.error(k_code_number,
                              "Animated background transitions require a positive duration.",
                              pointer_child(pointer, "durationMs"));
                duration.reset();
            } else if (*transition != BackgroundTransition::Fade && (*duration != 0 || *waits)) {
                decoder.error(k_code_variant,
                              "Immediate background transitions require zero duration and no wait.",
                              pointer_child(pointer, "transition"));
                duration.reset();
            }
        }
        PresentationInstructionWait wait =
            waits && *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                            : PresentationInstructionWait{ImmediateWait{}};
        return asset_ok && color_ok && duration && fit && material_ok && skippable && transition &&
                       waits
                   ? std::optional<SceneInstruction>(SetBackgroundInstruction{
                         std::move(*id), std::move(condition),
                         BackgroundPresentation{std::move(asset), std::move(color), *fit,
                                                std::move(material)},
                         *transition, *duration, std::move(wait), *skippable})
                   : std::nullopt;
    }
    if (*kind == "actor-cue") {
        SCENE_FIELDS("action", "character", "durationMs", "expressionId", "offset", "poseId",
                     "position", "scale", "skippable", "slotId", "transition", "waitForCompletion");
        const auto* action_value = decoder.member(value, "action", pointer);
        const auto* character_value = decoder.member(value, "character", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* expression_value = decoder.member(value, "expressionId", pointer);
        const auto* offset_value = decoder.member(value, "offset", pointer);
        const auto* pose_value = decoder.member(value, "poseId", pointer);
        const auto* position_value = decoder.member(value, "position", pointer);
        const auto* scale_value = decoder.member(value, "scale", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        const auto* slot_value = decoder.member(value, "slotId", pointer);
        const auto* transition_value = decoder.member(value, "transition", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        auto action = action_value ? decoder.enumeration<ActorCueAction>(
                                         *action_value, pointer_child(pointer, "action"),
                                         {{"show", ActorCueAction::Show},
                                          {"hide", ActorCueAction::Hide},
                                          {"move", ActorCueAction::Move},
                                          {"pose", ActorCueAction::Pose},
                                          {"expression", ActorCueAction::Expression}})
                                   : std::nullopt;
        auto character =
            character_value
                ? decode_reference<CharacterId>(decoder, *character_value,
                                                pointer_child(pointer, "character"), "character")
                : std::nullopt;
        std::optional<CharacterExpressionId> expression;
        bool expression_ok = expression_value != nullptr;
        if (expression_value && !expression_value->is_null()) {
            expression = decoder.id<CharacterExpressionId>(*expression_value,
                                                           pointer_child(pointer, "expressionId"));
            expression_ok = expression.has_value();
        }
        auto offset = offset_value
                          ? decode_vector2(decoder, *offset_value, pointer_child(pointer, "offset"))
                          : std::nullopt;
        std::optional<CharacterPoseId> pose;
        bool pose_ok = pose_value != nullptr;
        if (pose_value && !pose_value->is_null()) {
            pose = decoder.id<CharacterPoseId>(*pose_value, pointer_child(pointer, "poseId"));
            pose_ok = pose.has_value();
        }
        auto position = position_value ? decoder.enumeration<ActorPosition>(
                                             *position_value, pointer_child(pointer, "position"),
                                             {{"left", ActorPosition::Left},
                                              {"center", ActorPosition::Center},
                                              {"right", ActorPosition::Right},
                                              {"custom", ActorPosition::Custom}})
                                       : std::nullopt;
        auto scale = scale_value
                         ? decoder.finite_number(*scale_value, pointer_child(pointer, "scale"))
                         : std::nullopt;
        if (scale && *scale <= 0.0) {
            decoder.error(k_code_number, "Scale must be positive.",
                          pointer_child(pointer, "scale"));
            scale.reset();
        }
        auto slot = slot_value
                        ? decoder.id<ActorSlotId>(*slot_value, pointer_child(pointer, "slotId"))
                        : std::nullopt;
        auto transition = transition_value
                              ? decoder.enumeration<ActorTransition>(
                                    *transition_value, pointer_child(pointer, "transition"),
                                    {{"none", ActorTransition::None},
                                     {"fade", ActorTransition::Fade},
                                     {"slide", ActorTransition::Slide}})
                              : std::nullopt;
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        if (action && transition && duration && waits) {
            if (*transition == ActorTransition::None && (*duration != 0 || *waits)) {
                decoder.error(k_code_variant,
                              "Immediate actor changes require zero duration and no wait.",
                              pointer_child(pointer, "transition"));
                duration.reset();
            } else if (*transition != ActorTransition::None && *duration == 0) {
                decoder.error(k_code_number,
                              "Animated actor transitions require a positive duration.",
                              pointer_child(pointer, "durationMs"));
                duration.reset();
            }
            if (*transition == ActorTransition::Slide && *action != ActorCueAction::Show &&
                *action != ActorCueAction::Hide && *action != ActorCueAction::Move) {
                decoder.error(k_code_variant,
                              "Slide is valid only for show, hide, and move actor actions.",
                              pointer_child(pointer, "transition"));
                transition.reset();
            }
        }
        if (!action || !character || !expression_ok || !offset || !pose_ok || !position || !scale ||
            !skippable || !slot || !transition || !duration || !waits)
            return std::nullopt;
        PresentationInstructionWait wait =
            *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                   : PresentationInstructionWait{ImmediateWait{}};
        return ActorCueInstruction{std::move(*id),
                                   std::move(condition),
                                   *action,
                                   std::move(*character),
                                   std::move(expression),
                                   std::move(*offset),
                                   std::move(pose),
                                   *position,
                                   *scale,
                                   std::move(*slot),
                                   *transition,
                                   *duration,
                                   std::move(wait),
                                   *skippable};
    }
    if (*kind == "call-dialogue") {
        SCENE_FIELDS("autosaveSafePoint", "dialogue", "startBlockId");
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
        const auto* block_value = decoder.member(value, "startBlockId", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        auto dialogue =
            dialogue_value
                ? decode_reference<DialogueId>(decoder, *dialogue_value,
                                               pointer_child(pointer, "dialogue"), "dialogue")
                : std::nullopt;
        std::optional<DialogueBlockId> block;
        bool block_ok = block_value != nullptr;
        if (block_value && !block_value->is_null()) {
            block =
                decoder.id<DialogueBlockId>(*block_value, pointer_child(pointer, "startBlockId"));
            block_ok = block.has_value();
        }
        return safe && dialogue && block_ok
                   ? std::optional<SceneInstruction>(
                         CallDialogueSceneInstruction{std::move(*id), std::move(condition), *safe,
                                                      std::move(*dialogue), std::move(block)})
                   : std::nullopt;
    }
    if (*kind == "show-text") {
        SCENE_FIELDS("autosaveSafePoint", "speaker", "text", "wait");
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* speaker_value = decoder.member(value, "speaker", pointer);
        const auto* text_value = decoder.member(value, "text", pointer);
        const auto* wait_value = decoder.member(value, "wait", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        std::optional<CharacterId> speaker;
        bool speaker_ok = speaker_value != nullptr;
        if (speaker_value && !speaker_value->is_null()) {
            speaker = decode_reference<CharacterId>(decoder, *speaker_value,
                                                    pointer_child(pointer, "speaker"), "character");
            speaker_ok = speaker.has_value();
        }
        auto text = text_value ? decode_text(decoder, *text_value, pointer_child(pointer, "text"))
                               : std::nullopt;
        auto wait_name =
            wait_value ? decoder.string(*wait_value, pointer_child(pointer, "wait")) : std::nullopt;
        std::optional<InputInstructionWait> wait;
        if (wait_name && *wait_name == "input")
            wait = InputWait{};
        else if (wait_name && *wait_name == "immediate")
            wait = ImmediateWait{};
        else if (wait_name)
            decoder.error(k_code_enum, "Unknown wait value '" + *wait_name + "'.",
                          pointer_child(pointer, "wait"));
        return safe && speaker_ok && text && wait
                   ? std::optional<SceneInstruction>(ShowTextInstruction{
                         std::move(*id), std::move(condition), *safe, std::move(speaker),
                         std::move(*text), std::move(*wait)})
                   : std::nullopt;
    }
    if (*kind == "audio-cue") {
        SCENE_FIELDS("action", "asset", "channel", "fadeMs", "loop", "volume", "waitForCompletion");
        const auto* action_value = decoder.member(value, "action", pointer);
        const auto* asset_value = decoder.member(value, "asset", pointer);
        const auto* channel_value = decoder.member(value, "channel", pointer);
        const auto* fade_value = decoder.member(value, "fadeMs", pointer);
        const auto* loop_value = decoder.member(value, "loop", pointer);
        const auto* volume_value = decoder.member(value, "volume", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        auto action =
            action_value
                ? decoder.enumeration<AudioAction>(*action_value, pointer_child(pointer, "action"),
                                                   {{"play", AudioAction::Play},
                                                    {"stop", AudioAction::Stop},
                                                    {"fade-in", AudioAction::FadeIn},
                                                    {"fade-out", AudioAction::FadeOut}})
                : std::nullopt;
        std::optional<AssetId> asset;
        bool asset_ok = asset_value != nullptr;
        if (asset_value && !asset_value->is_null()) {
            asset = decode_reference<AssetId>(decoder, *asset_value,
                                              pointer_child(pointer, "asset"), "asset");
            asset_ok = asset.has_value();
        }
        auto channel = channel_value ? decoder.enumeration<AudioChannel>(
                                           *channel_value, pointer_child(pointer, "channel"),
                                           {{"sound-effect", AudioChannel::SoundEffect},
                                            {"music", AudioChannel::Music},
                                            {"voice", AudioChannel::Voice},
                                            {"ambient", AudioChannel::Ambient}})
                                     : std::nullopt;
        auto fade = fade_value ? decoder.unsigned_integer<std::uint64_t>(
                                     *fade_value, pointer_child(pointer, "fadeMs"))
                               : std::nullopt;
        auto loop = loop_value ? decoder.boolean(*loop_value, pointer_child(pointer, "loop"))
                               : std::nullopt;
        auto volume = volume_value
                          ? decoder.finite_number(*volume_value, pointer_child(pointer, "volume"))
                          : std::nullopt;
        if (volume && (*volume < 0.0 || *volume > 1.0)) {
            decoder.error(k_code_number, "Volume must be between zero and one.",
                          pointer_child(pointer, "volume"));
            volume.reset();
        }
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        if (!action || !asset_ok || !channel || !fade || !loop || !volume || !waits)
            return std::nullopt;
        AudioInstructionWait wait = *waits ? AudioInstructionWait{AudioCompletionWait{}}
                                           : AudioInstructionWait{ImmediateWait{}};
        return AudioCueInstruction{
            std::move(*id), std::move(condition), *action, std::move(asset), *channel, *fade, *loop,
            *volume,        std::move(wait)};
    }
    if (*kind == "set-variable") {
        SCENE_FIELDS("value", "variable");
        const auto* variable_value = decoder.member(value, "variable", pointer);
        const auto* assignment_value = decoder.member(value, "value", pointer);
        auto variable =
            variable_value
                ? decode_reference<VariableId>(decoder, *variable_value,
                                               pointer_child(pointer, "variable"), "variable")
                : std::nullopt;
        auto assignment = assignment_value ? decode_runtime_value(decoder, *assignment_value,
                                                                  pointer_child(pointer, "value"))
                                           : std::nullopt;
        return variable && assignment ? std::optional<SceneInstruction>(SetVariableSceneInstruction{
                                            std::move(*id), std::move(condition),
                                            std::move(*variable), std::move(*assignment)})
                                      : std::nullopt;
    }
    if (*kind == "run-lua") {
        SCENE_FIELDS("autosaveSafePoint", "mayYield", "source");
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* yield_value = decoder.member(value, "mayYield", pointer);
        const auto* source_value = decoder.member(value, "source", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        auto may_yield = yield_value
                             ? decoder.boolean(*yield_value, pointer_child(pointer, "mayYield"))
                             : std::nullopt;
        auto source = source_value
                          ? decoder.string(*source_value, pointer_child(pointer, "source"), true)
                          : std::nullopt;
        return safe && may_yield && source ? std::optional<SceneInstruction>(RunLuaSceneInstruction{
                                                 std::move(*id), std::move(condition), *safe,
                                                 *may_yield, std::move(*source)})
                                           : std::nullopt;
    }
    if (*kind == "wait-duration") {
        SCENE_FIELDS("durationMs", "skippable");
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        if (!duration || !skippable ||
            *duration > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
            if (duration)
                decoder.error(k_code_number, "Duration is outside the supported range.",
                              pointer_child(pointer, "durationMs"));
            return std::nullopt;
        }
        auto wait_result = DurationWait::create(std::chrono::milliseconds(*duration));
        std::optional<DurationWait> wait;
        (void)wait_result.transform([&](const DurationWait& decoded) {
            wait = decoded;
            return true;
        });
        return wait ? std::optional<SceneInstruction>(WaitDurationInstruction{
                          std::move(*id), std::move(condition), std::move(*wait), *skippable})
                    : std::nullopt;
    }
    if (*kind == "wait-input") {
        SCENE_FIELDS("skippable");
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        return skippable ? std::optional<SceneInstruction>(WaitInputInstruction{
                               std::move(*id), std::move(condition), *skippable})
                         : std::nullopt;
    }
    if (*kind == "conditional-branch") {
        SCENE_FIELDS("branches", "fallbackInstructionId");
        const auto* branches_value = decoder.member(value, "branches", pointer);
        const auto* fallback_value = decoder.member(value, "fallbackInstructionId", pointer);
        auto branches =
            branches_value
                ? decoder.array<SceneBranch>(
                      *branches_value, pointer_child(pointer, "branches"),
                      [&](const nlohmann::json& branch,
                          const std::string& branch_pointer) -> std::optional<SceneBranch> {
                          if (!decoder.object(branch, branch_pointer,
                                              {"condition", "id", "targetInstructionId"}))
                              return std::nullopt;
                          const auto* branch_id_value =
                              decoder.member(branch, "id", branch_pointer);
                          const auto* branch_condition_value =
                              decoder.member(branch, "condition", branch_pointer);
                          const auto* target_value =
                              decoder.member(branch, "targetInstructionId", branch_pointer);
                          auto branch_id =
                              branch_id_value
                                  ? decoder.id<SceneBranchId>(*branch_id_value,
                                                              pointer_child(branch_pointer, "id"))
                                  : std::nullopt;
                          auto branch_condition =
                              branch_condition_value
                                  ? decode_condition_impl(
                                        decoder, *branch_condition_value,
                                        pointer_child(branch_pointer, "condition"))
                                  : std::nullopt;
                          auto target =
                              target_value
                                  ? decoder.id<SceneStepId>(
                                        *target_value,
                                        pointer_child(branch_pointer, "targetInstructionId"))
                                  : std::nullopt;
                          return branch_id && branch_condition && target
                                     ? std::optional<SceneBranch>(SceneBranch{
                                           std::move(*branch_id), std::move(*branch_condition),
                                           std::move(*target)})
                                     : std::nullopt;
                      })
                : std::nullopt;
        auto fallback = fallback_value
                            ? decoder.id<SceneStepId>(
                                  *fallback_value, pointer_child(pointer, "fallbackInstructionId"))
                            : std::nullopt;
        if (branches)
            decoder.duplicate_ids(
                *branches, pointer_child(pointer, "branches"),
                [](const SceneBranch& branch) -> const SceneBranchId& { return branch.id; });
        return branches && fallback ? std::optional<SceneInstruction>(ConditionalBranchInstruction{
                                          std::move(*id), std::move(condition),
                                          std::move(*branches), std::move(*fallback)})
                                    : std::nullopt;
    }
    if (*kind == "choice") {
        SCENE_FIELDS("autosaveSafePoint", "options", "prompt");
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* options_value = decoder.member(value, "options", pointer);
        const auto* prompt_value = decoder.member(value, "prompt", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        auto options =
            options_value
                ? decoder.array<SceneChoiceOption>(
                      *options_value, pointer_child(pointer, "options"),
                      [&](const nlohmann::json& option,
                          const std::string& option_pointer) -> std::optional<SceneChoiceOption> {
                          if (!decoder.object(
                                  option, option_pointer,
                                  {"condition", "effects", "id", "label", "targetInstructionId"}))
                              return std::nullopt;
                          const auto* option_id_value =
                              decoder.member(option, "id", option_pointer);
                          const auto* effects_value =
                              decoder.member(option, "effects", option_pointer);
                          const auto* label_value = decoder.member(option, "label", option_pointer);
                          const auto* target_value =
                              decoder.member(option, "targetInstructionId", option_pointer);
                          auto option_id =
                              option_id_value
                                  ? decoder.id<SceneChoiceOptionId>(
                                        *option_id_value, pointer_child(option_pointer, "id"))
                                  : std::nullopt;
                          bool option_condition_ok = false;
                          auto option_condition = decode_optional_condition(
                              decoder, option, option_pointer, option_condition_ok);
                          auto effects =
                              effects_value
                                  ? decode_effects(decoder, *effects_value,
                                                   pointer_child(option_pointer, "effects"))
                                  : std::nullopt;
                          auto label = label_value
                                           ? decode_text(decoder, *label_value,
                                                         pointer_child(option_pointer, "label"))
                                           : std::nullopt;
                          auto target =
                              target_value
                                  ? decoder.id<SceneStepId>(
                                        *target_value,
                                        pointer_child(option_pointer, "targetInstructionId"))
                                  : std::nullopt;
                          if (option_id && option_condition_ok && effects && label && target)
                              return SceneChoiceOption{
                                  std::move(*option_id), std::move(option_condition),
                                  std::move(*effects), std::move(*label), std::move(*target)};
                          return std::nullopt;
                      })
                : std::nullopt;
        if (options && options->empty()) {
            decoder.error(k_code_type, "At least one choice option is required.",
                          pointer_child(pointer, "options"));
            options.reset();
        }
        std::optional<TextContent> prompt;
        bool prompt_ok = prompt_value != nullptr;
        if (prompt_value && !prompt_value->is_null()) {
            prompt = decode_text(decoder, *prompt_value, pointer_child(pointer, "prompt"));
            prompt_ok = prompt.has_value();
        }
        if (options)
            decoder.duplicate_ids(
                *options, pointer_child(pointer, "options"),
                [](const SceneChoiceOption& option) -> const SceneChoiceOptionId& {
                    return option.id;
                });
        return safe && options && prompt_ok
                   ? std::optional<SceneInstruction>(
                         ChoiceSceneInstruction{std::move(*id), std::move(condition), *safe,
                                                std::move(*options), std::move(prompt)})
                   : std::nullopt;
    }
    if (*kind == "set-layout") {
        SCENE_FIELDS("action", "durationMs", "layout", "skippable", "slot", "transition",
                     "waitForCompletion");
        const auto* action_value = decoder.member(value, "action", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* layout_value = decoder.member(value, "layout", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        const auto* slot_value = decoder.member(value, "slot", pointer);
        const auto* transition_value = decoder.member(value, "transition", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        auto action =
            action_value
                ? decoder.enumeration<LayoutAction>(*action_value, pointer_child(pointer, "action"),
                                                    {{"show", LayoutAction::Show},
                                                     {"hide", LayoutAction::Hide},
                                                     {"swap", LayoutAction::Swap}})
                : std::nullopt;
        std::optional<LayoutId> layout;
        bool layout_ok = layout_value != nullptr;
        if (layout_value && !layout_value->is_null()) {
            layout = decode_reference<LayoutId>(decoder, *layout_value,
                                                pointer_child(pointer, "layout"), "layout");
            layout_ok = layout.has_value();
        }
        auto slot =
            slot_value
                ? decoder.enumeration<LayoutSlot>(*slot_value, pointer_child(pointer, "slot"),
                                                  {{"hud", LayoutSlot::Hud},
                                                   {"dialogue-box", LayoutSlot::DialogueBox},
                                                   {"overlay", LayoutSlot::Overlay},
                                                   {"custom", LayoutSlot::Custom}})
                : std::nullopt;
        auto transition =
            transition_value
                ? decoder.enumeration<LayoutTransition>(
                      *transition_value, pointer_child(pointer, "transition"),
                      {{"none", LayoutTransition::None}, {"fade", LayoutTransition::Fade}})
                : std::nullopt;
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        if (action && layout_ok) {
            if ((*action == LayoutAction::Hide) != !layout.has_value()) {
                decoder.error(k_code_variant,
                              "Hide Layout changes require no Layout; show and swap require one.",
                              pointer_child(pointer, "layout"));
                layout_ok = false;
            }
        }
        if (transition && duration && waits) {
            if (*transition == LayoutTransition::None && (*duration != 0 || *waits)) {
                decoder.error(k_code_variant,
                              "Immediate Layout changes require zero duration and no wait.",
                              pointer_child(pointer, "transition"));
                duration.reset();
            } else if (*transition == LayoutTransition::Fade && *duration == 0) {
                decoder.error(k_code_number,
                              "Animated Layout transitions require a positive duration.",
                              pointer_child(pointer, "durationMs"));
                duration.reset();
            }
        }
        PresentationInstructionWait wait =
            waits && *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                            : PresentationInstructionWait{ImmediateWait{}};
        return action && duration && layout_ok && skippable && slot && transition && waits
                   ? std::optional<SceneInstruction>(SetLayoutInstruction{
                         std::move(*id), std::move(condition), *action, std::move(layout), *slot,
                         *transition, *duration, std::move(wait), *skippable})
                   : std::nullopt;
    }
    if (*kind == "transition-group") {
        SCENE_FIELDS("children", "color", "durationMs", "skippable", "transitionKind",
                     "waitForCompletion");
        const auto* children_value = decoder.member(value, "children", pointer);
        const auto* color_value = decoder.member(value, "color", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        const auto* transition_value = decoder.member(value, "transitionKind", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        auto children =
            children_value
                ? decoder.array<TransitionGroupMutation>(
                      *children_value, pointer_child(pointer, "children"),
                      [&](const nlohmann::json& child, const std::string& child_pointer)
                          -> std::optional<TransitionGroupMutation> {
                          if (!child.is_object()) {
                              decoder.error(k_code_type, "Expected a TransitionGroup child object.",
                                            child_pointer);
                              return std::nullopt;
                          }
                          const auto* child_kind_value =
                              decoder.member(child, "kind", child_pointer);
                          const auto* child_id_value = decoder.member(child, "id", child_pointer);
                          auto child_kind =
                              child_kind_value
                                  ? decoder.string(*child_kind_value,
                                                   pointer_child(child_pointer, "kind"))
                                  : std::nullopt;
                          auto child_id = child_id_value ? decoder.id<TransitionGroupChildId>(
                                                               *child_id_value,
                                                               pointer_child(child_pointer, "id"))
                                                         : std::nullopt;
                          if (!child_kind || !child_id)
                              return std::nullopt;
                          if (*child_kind == "clear-background") {
                              if (!decoder.object(child, child_pointer, {"id", "kind"}))
                                  return std::nullopt;
                              return TransitionGroupClearBackgroundMutation{std::move(*child_id)};
                          }
                          if (*child_kind == "set-background") {
                              if (!decoder.object(
                                      child, child_pointer,
                                      {"asset", "color", "fit", "id", "kind", "material"}))
                                  return std::nullopt;
                              const auto* asset_value =
                                  decoder.member(child, "asset", child_pointer);
                              const auto* child_color_value =
                                  decoder.member(child, "color", child_pointer);
                              const auto* fit_value = decoder.member(child, "fit", child_pointer);
                              const auto* material_value =
                                  decoder.member(child, "material", child_pointer);
                              std::optional<AssetId> asset;
                              bool asset_ok = asset_value != nullptr;
                              if (asset_value && !asset_value->is_null()) {
                                  asset = decode_reference<AssetId>(
                                      decoder, *asset_value, pointer_child(child_pointer, "asset"),
                                      "asset");
                                  asset_ok = asset.has_value();
                              }
                              std::optional<std::string> child_color;
                              bool child_color_ok = child_color_value != nullptr;
                              if (child_color_value && !child_color_value->is_null()) {
                                  child_color = decoder.string(
                                      *child_color_value, pointer_child(child_pointer, "color"));
                                  child_color_ok = child_color.has_value();
                              }
                              auto fit = fit_value
                                             ? decoder.enumeration<BackgroundFit>(
                                                   *fit_value, pointer_child(child_pointer, "fit"),
                                                   {{"cover", BackgroundFit::Cover},
                                                    {"contain", BackgroundFit::Contain},
                                                    {"stretch", BackgroundFit::Stretch},
                                                    {"center", BackgroundFit::Center}})
                                             : std::nullopt;
                              std::optional<MaterialId> material;
                              bool material_ok = material_value != nullptr;
                              if (material_value && !material_value->is_null()) {
                                  material = decode_reference<MaterialId>(
                                      decoder, *material_value,
                                      pointer_child(child_pointer, "material"), "material");
                                  material_ok = material.has_value();
                              }
                              if (!asset_ok || !child_color_ok || !fit || !material_ok)
                                  return std::nullopt;
                              return TransitionGroupSetBackgroundMutation{
                                  std::move(*child_id),
                                  BackgroundPresentation{std::move(asset), std::move(child_color),
                                                         *fit, std::move(material)}};
                          }
                          if (*child_kind == "actor-cue") {
                              if (!decoder.object(child, child_pointer,
                                                  {"action", "character", "expressionId", "id",
                                                   "kind", "offset", "poseId", "position", "scale",
                                                   "slotId"}))
                                  return std::nullopt;
                              const auto* action_value =
                                  decoder.member(child, "action", child_pointer);
                              const auto* character_value =
                                  decoder.member(child, "character", child_pointer);
                              const auto* expression_value =
                                  decoder.member(child, "expressionId", child_pointer);
                              const auto* offset_value =
                                  decoder.member(child, "offset", child_pointer);
                              const auto* pose_value =
                                  decoder.member(child, "poseId", child_pointer);
                              const auto* position_value =
                                  decoder.member(child, "position", child_pointer);
                              const auto* scale_value =
                                  decoder.member(child, "scale", child_pointer);
                              const auto* slot_value =
                                  decoder.member(child, "slotId", child_pointer);
                              auto action =
                                  action_value
                                      ? decoder.enumeration<ActorCueAction>(
                                            *action_value, pointer_child(child_pointer, "action"),
                                            {{"show", ActorCueAction::Show},
                                             {"hide", ActorCueAction::Hide},
                                             {"move", ActorCueAction::Move},
                                             {"pose", ActorCueAction::Pose},
                                             {"expression", ActorCueAction::Expression}})
                                      : std::nullopt;
                              auto character =
                                  character_value
                                      ? decode_reference<CharacterId>(
                                            decoder, *character_value,
                                            pointer_child(child_pointer, "character"), "character")
                                      : std::nullopt;
                              std::optional<CharacterExpressionId> expression;
                              bool expression_ok = expression_value != nullptr;
                              if (expression_value && !expression_value->is_null()) {
                                  expression = decoder.id<CharacterExpressionId>(
                                      *expression_value,
                                      pointer_child(child_pointer, "expressionId"));
                                  expression_ok = expression.has_value();
                              }
                              auto offset =
                                  offset_value
                                      ? decode_vector2(decoder, *offset_value,
                                                       pointer_child(child_pointer, "offset"))
                                      : std::nullopt;
                              std::optional<CharacterPoseId> pose;
                              bool pose_ok = pose_value != nullptr;
                              if (pose_value && !pose_value->is_null()) {
                                  pose = decoder.id<CharacterPoseId>(
                                      *pose_value, pointer_child(child_pointer, "poseId"));
                                  pose_ok = pose.has_value();
                              }
                              auto position = position_value
                                                  ? decoder.enumeration<ActorPosition>(
                                                        *position_value,
                                                        pointer_child(child_pointer, "position"),
                                                        {{"left", ActorPosition::Left},
                                                         {"center", ActorPosition::Center},
                                                         {"right", ActorPosition::Right},
                                                         {"custom", ActorPosition::Custom}})
                                                  : std::nullopt;
                              auto scale =
                                  scale_value
                                      ? decoder.finite_number(*scale_value,
                                                              pointer_child(child_pointer, "scale"))
                                      : std::nullopt;
                              if (scale && *scale <= 0.0) {
                                  decoder.error(k_code_number, "Scale must be positive.",
                                                pointer_child(child_pointer, "scale"));
                                  scale.reset();
                              }
                              auto slot = slot_value ? decoder.id<ActorSlotId>(
                                                           *slot_value,
                                                           pointer_child(child_pointer, "slotId"))
                                                     : std::nullopt;
                              if (!action || !character || !expression_ok || !offset || !pose_ok ||
                                  !position || !scale || !slot)
                                  return std::nullopt;
                              return TransitionGroupActorMutation{std::move(*child_id),
                                                                  *action,
                                                                  std::move(*character),
                                                                  std::move(expression),
                                                                  std::move(*offset),
                                                                  std::move(pose),
                                                                  *position,
                                                                  *scale,
                                                                  std::move(*slot)};
                          }
                          if (*child_kind == "set-layout") {
                              if (!decoder.object(
                                      child, child_pointer,
                                      {"action", "id", "kind", "layout", "plane", "slot"}))
                                  return std::nullopt;
                              const auto* action_value =
                                  decoder.member(child, "action", child_pointer);
                              const auto* layout_value =
                                  decoder.member(child, "layout", child_pointer);
                              const auto* plane_value =
                                  decoder.member(child, "plane", child_pointer);
                              const auto* slot_value = decoder.member(child, "slot", child_pointer);
                              auto action =
                                  action_value
                                      ? decoder.enumeration<LayoutAction>(
                                            *action_value, pointer_child(child_pointer, "action"),
                                            {{"show", LayoutAction::Show},
                                             {"hide", LayoutAction::Hide},
                                             {"swap", LayoutAction::Swap}})
                                      : std::nullopt;
                              std::optional<LayoutId> layout;
                              bool layout_ok = layout_value != nullptr;
                              if (layout_value && !layout_value->is_null()) {
                                  layout = decode_reference<LayoutId>(
                                      decoder, *layout_value,
                                      pointer_child(child_pointer, "layout"), "layout");
                                  layout_ok = layout.has_value();
                              }
                              auto plane =
                                  plane_value
                                      ? decoder.string(*plane_value,
                                                       pointer_child(child_pointer, "plane"))
                                      : std::nullopt;
                              if (plane && *plane != "world-overlay") {
                                  decoder.error(k_code_enum,
                                                "TransitionGroup Layout children must target "
                                                "world-overlay.",
                                                pointer_child(child_pointer, "plane"));
                                  plane.reset();
                              }
                              auto slot = slot_value ? decoder.enumeration<LayoutSlot>(
                                                           *slot_value,
                                                           pointer_child(child_pointer, "slot"),
                                                           {{"overlay", LayoutSlot::Overlay},
                                                            {"custom", LayoutSlot::Custom}})
                                                     : std::nullopt;
                              if (!action || !layout_ok || !plane || !slot)
                                  return std::nullopt;
                              if ((*action == LayoutAction::Hide) != !layout.has_value()) {
                                  decoder.error(k_code_variant,
                                                "Hide Layout children require no Layout; show and "
                                                "swap require one.",
                                                pointer_child(child_pointer, "layout"));
                                  return std::nullopt;
                              }
                              return TransitionGroupLayoutMutation{std::move(*child_id), *action,
                                                                   std::move(layout), *slot};
                          }
                          decoder.object(child, child_pointer, {"id", "kind"});
                          decoder.error(k_code_variant,
                                        "Unknown TransitionGroup child variant '" + *child_kind +
                                            "'.",
                                        pointer_child(child_pointer, "kind"));
                          return std::nullopt;
                      })
                : std::nullopt;
        std::optional<std::string> color;
        bool color_ok = color_value != nullptr;
        if (color_value && !color_value->is_null()) {
            color = decoder.string(*color_value, pointer_child(pointer, "color"));
            color_ok = color.has_value();
        }
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        auto transition = transition_value
                              ? decoder.enumeration<TransitionKind>(
                                    *transition_value, pointer_child(pointer, "transitionKind"),
                                    {{"fade", TransitionKind::Fade},
                                     {"cut", TransitionKind::Cut},
                                     {"dissolve", TransitionKind::Dissolve}})
                              : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        if (children && children->empty()) {
            decoder.error(k_code_type, "TransitionGroup requires at least one child.",
                          pointer_child(pointer, "children"));
            children.reset();
        }
        if (children)
            decoder.duplicate_ids(
                *children, pointer_child(pointer, "children"),
                [](const TransitionGroupMutation& child) -> const TransitionGroupChildId& {
                    return std::visit(
                        [](const auto& typed) -> const TransitionGroupChildId& { return typed.id; },
                        child);
                });
        if (!children || !color_ok || !duration || !skippable || !transition || !waits)
            return std::nullopt;
        if (*transition == TransitionKind::Cut && (*duration != 0 || *waits || color.has_value())) {
            decoder.error(
                k_code_variant,
                "Cut TransitionGroup values require zero duration, no wait, and no color.",
                pointer_child(pointer, "transitionKind"));
            return std::nullopt;
        }
        if (*transition != TransitionKind::Cut && *duration == 0) {
            decoder.error(k_code_number,
                          "Animated TransitionGroup values require a positive duration.",
                          pointer_child(pointer, "durationMs"));
            return std::nullopt;
        }
        if (*transition == TransitionKind::Dissolve && color.has_value()) {
            decoder.error(k_code_variant, "Dissolve TransitionGroup values do not accept a color.",
                          pointer_child(pointer, "color"));
            return std::nullopt;
        }
        PresentationInstructionWait wait =
            *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                   : PresentationInstructionWait{ImmediateWait{}};
        return TransitionGroupInstruction{std::move(*id), std::move(condition), std::move(color),
                                          *duration,      *transition,          std::move(wait),
                                          *skippable,     std::move(*children)};
    }
#undef SCENE_FIELDS
    decoder.object(value, pointer, {"condition", "id", "kind"});
    decoder.error(k_code_variant, "Unknown Scene instruction variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<SceneDefinition> decode_scene(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"continuation", "defaultBackground", "defaultLayout", "displayName",
                         "extends", "id", "program", "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<SceneId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* background_value = decoder.member(value, "defaultBackground", pointer);
    const auto* layout_value = decoder.member(value, "defaultLayout", pointer);
    const auto* program_value = decoder.member(value, "program", pointer);
    const auto* continuation_value = decoder.member(value, "continuation", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto background = background_value
                          ? decode_background(decoder, *background_value,
                                              pointer_child(pointer, "defaultBackground"))
                          : std::nullopt;
    std::optional<LayoutId> layout;
    bool layout_ok = layout_value != nullptr;
    if (layout_value && !layout_value->is_null()) {
        layout = decode_reference<LayoutId>(decoder, *layout_value,
                                            pointer_child(pointer, "defaultLayout"), "layout");
        layout_ok = layout.has_value();
    }
    std::optional<SceneProgram> program;
    if (program_value &&
        decoder.object(*program_value, pointer_child(pointer, "program"), {"instructions"})) {
        const auto program_pointer = pointer_child(pointer, "program");
        const auto* instructions_value =
            decoder.member(*program_value, "instructions", program_pointer);
        auto instructions =
            instructions_value
                ? decoder.array<SceneInstruction>(
                      *instructions_value, pointer_child(program_pointer, "instructions"),
                      [&](const nlohmann::json& instruction,
                          const std::string& instruction_pointer) {
                          return decode_scene_instruction(decoder, instruction,
                                                          instruction_pointer);
                      })
                : std::nullopt;
        if (instructions) {
            decoder.duplicate_ids(
                *instructions, pointer_child(program_pointer, "instructions"),
                [](const SceneInstruction& instruction) -> const SceneStepId& {
                    return std::visit(
                        [](const auto& typed) -> const SceneStepId& { return typed.id; },
                        instruction);
                });
            program = SceneProgram{std::move(*instructions)};
        }
    }
    auto continuation = continuation_value
                            ? decode_flow_target_impl(decoder, *continuation_value,
                                                      pointer_child(pointer, "continuation"))
                            : std::nullopt;
    if (!identity || !display || !background || !layout_ok || !program || !continuation)
        return std::nullopt;
    return SceneDefinition{std::move(*identity), std::move(*display), std::move(*background),
                           std::move(layout),    std::move(*program), std::move(*continuation)};
}

} // namespace noveltea::core::compiled::wire::detail
