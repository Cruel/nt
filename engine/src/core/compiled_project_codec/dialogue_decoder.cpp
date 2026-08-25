#include "internal.hpp"

namespace noveltea::core::compiled::wire::detail {

namespace {

std::optional<std::vector<SceneInputBinding>>
decode_dialogue_scene_input_bindings(Decoder& decoder, const nlohmann::json& value,
                                     std::string_view pointer)
{
    return decoder.array<SceneInputBinding>(
        value, pointer,
        [&](const nlohmann::json& binding,
            const std::string& binding_pointer) -> std::optional<SceneInputBinding> {
            if (!decoder.object(binding, binding_pointer, {"inputId", "value"}))
                return std::nullopt;
            const auto* input_value = decoder.member(binding, "inputId", binding_pointer);
            const auto* runtime_value = decoder.member(binding, "value", binding_pointer);
            auto input = input_value ? decoder.id<SceneInputId>(
                                           *input_value, pointer_child(binding_pointer, "inputId"))
                                     : std::nullopt;
            auto decoded_value = runtime_value
                                     ? decode_runtime_value(decoder, *runtime_value,
                                                            pointer_child(binding_pointer, "value"))
                                     : std::nullopt;
            return input && decoded_value ? std::optional<SceneInputBinding>(SceneInputBinding{
                                                std::move(*input), std::move(*decoded_value)})
                                          : std::nullopt;
        });
}

std::optional<ActorPosition> decode_dialogue_actor_position(Decoder& decoder,
                                                            const nlohmann::json& value,
                                                            std::string_view pointer)
{
    return decoder.enumeration<ActorPosition>(value, pointer,
                                              {{"left", ActorPosition::Left},
                                               {"center", ActorPosition::Center},
                                               {"right", ActorPosition::Right}});
}

std::optional<DialogueSlotMutationAction>
decode_dialogue_slot_action(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    return decoder.enumeration<DialogueSlotMutationAction>(
        value, pointer,
        {{"update", DialogueSlotMutationAction::Update},
         {"show", DialogueSlotMutationAction::Show},
         {"hide", DialogueSlotMutationAction::Hide},
         {"clear", DialogueSlotMutationAction::Clear}});
}

std::optional<DialogueMediaContent>
decode_dialogue_media(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected Dialogue media content object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "image") {
        decoder.object(value, pointer, {"asset", "kind"});
        const auto* asset_value = decoder.member(value, "asset", pointer);
        auto asset = asset_value
                         ? decode_reference<AssetId>(decoder, *asset_value,
                                                     pointer_child(pointer, "asset"), "asset")
                         : std::nullopt;
        return asset ? std::optional<DialogueMediaContent>(DialogueImageMedia{std::move(*asset)})
                     : std::nullopt;
    }
    if (*kind == "character") {
        decoder.object(
            value, pointer,
            {"appearanceId", "character", "expressionId", "kind", "poseId", "profileId"});
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
        auto profile = profile_value ? decoder.id<CharacterPresentationProfileId>(
                                           *profile_value, pointer_child(pointer, "profileId"))
                                     : std::nullopt;
        auto pose = pose_value
                        ? decoder.id<CharacterPoseId>(*pose_value, pointer_child(pointer, "poseId"))
                        : std::nullopt;
        auto expression = expression_value
                              ? decoder.id<CharacterExpressionId>(
                                    *expression_value, pointer_child(pointer, "expressionId"))
                              : std::nullopt;
        std::optional<CharacterAppearanceId> appearance;
        bool appearance_ok = appearance_value != nullptr;
        if (appearance_value && !appearance_value->is_null()) {
            appearance = decoder.id<CharacterAppearanceId>(*appearance_value,
                                                           pointer_child(pointer, "appearanceId"));
            appearance_ok = appearance.has_value();
        }
        return character && profile && pose && expression && appearance_ok
                   ? std::optional<DialogueMediaContent>(DialogueCharacterMedia{
                         std::move(*character), std::move(*profile), std::move(*pose),
                         std::move(*expression), std::move(appearance)})
                   : std::nullopt;
    }
    decoder.error(k_code_variant, "Unknown Dialogue media variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<DialogueStageSlotState>
decode_dialogue_stage_state(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"appearanceId", "character", "expressionId", "offset", "poseId",
                         "position", "profileId", "scale", "visible"}))
        return std::nullopt;
    const auto* character_value = decoder.member(value, "character", pointer);
    const auto* profile_value = decoder.member(value, "profileId", pointer);
    const auto* pose_value = decoder.member(value, "poseId", pointer);
    const auto* expression_value = decoder.member(value, "expressionId", pointer);
    const auto* appearance_value = decoder.member(value, "appearanceId", pointer);
    const auto* position_value = decoder.member(value, "position", pointer);
    const auto* offset_value = decoder.member(value, "offset", pointer);
    const auto* scale_value = decoder.member(value, "scale", pointer);
    const auto* visible_value = decoder.member(value, "visible", pointer);
    auto character =
        character_value
            ? decode_reference<CharacterId>(decoder, *character_value,
                                            pointer_child(pointer, "character"), "character")
            : std::nullopt;
    auto profile = profile_value ? decoder.id<CharacterPresentationProfileId>(
                                       *profile_value, pointer_child(pointer, "profileId"))
                                 : std::nullopt;
    auto pose = pose_value
                    ? decoder.id<CharacterPoseId>(*pose_value, pointer_child(pointer, "poseId"))
                    : std::nullopt;
    auto expression =
        expression_value ? decoder.id<CharacterExpressionId>(*expression_value,
                                                             pointer_child(pointer, "expressionId"))
                         : std::nullopt;
    std::optional<CharacterAppearanceId> appearance;
    bool appearance_ok = appearance_value != nullptr;
    if (appearance_value && !appearance_value->is_null()) {
        appearance = decoder.id<CharacterAppearanceId>(*appearance_value,
                                                       pointer_child(pointer, "appearanceId"));
        appearance_ok = appearance.has_value();
    }
    auto position = position_value
                        ? decode_dialogue_actor_position(decoder, *position_value,
                                                         pointer_child(pointer, "position"))
                        : std::nullopt;
    auto offset = offset_value
                      ? decode_vector2(decoder, *offset_value, pointer_child(pointer, "offset"))
                      : std::nullopt;
    auto scale = scale_value ? decoder.finite_number(*scale_value, pointer_child(pointer, "scale"))
                             : std::nullopt;
    auto visible = visible_value
                       ? decoder.boolean(*visible_value, pointer_child(pointer, "visible"))
                       : std::nullopt;
    if (scale && *scale <= 0.0) {
        decoder.error(k_code_type, "Dialogue Stage Slot scale must be positive.",
                      pointer_child(pointer, "scale"));
        scale.reset();
    }
    return character && profile && pose && expression && appearance_ok && position && offset &&
                   scale && visible
               ? std::optional<DialogueStageSlotState>(DialogueStageSlotState{
                     std::move(*character), std::move(*profile), std::move(*pose),
                     std::move(*expression), std::move(appearance), *position, *offset, *scale,
                     *visible})
               : std::nullopt;
}

} // namespace

struct DecodedDialogueLinePresentation {
    std::optional<CharacterExpressionId> speaker_expression_id;
    std::vector<DialogueStageMutation> stage;
    std::vector<DialogueMediaMutation> media;
};

std::optional<DecodedDialogueLinePresentation>
decode_dialogue_line_presentation(Decoder& decoder, const nlohmann::json& value,
                                  std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"media", "speakerExpressionId", "stage"}))
        return std::nullopt;
    const auto speaker_expression_it = value.find("speakerExpressionId");
    const auto* stage_value = decoder.member(value, "stage", pointer);
    const auto* media_value = decoder.member(value, "media", pointer);
    std::optional<CharacterExpressionId> speaker_expression;
    bool speaker_expression_ok = true;
    if (speaker_expression_it != value.end()) {
        speaker_expression = decoder.id<CharacterExpressionId>(
            *speaker_expression_it, pointer_child(pointer, "speakerExpressionId"));
        speaker_expression_ok = speaker_expression.has_value();
    }
    auto stage =
        stage_value
            ? decoder.array<DialogueStageMutation>(
                  *stage_value, pointer_child(pointer, "stage"),
                  [&](const nlohmann::json& mutation,
                      const std::string& mutation_pointer) -> std::optional<DialogueStageMutation> {
                      if (!mutation.is_object()) {
                          decoder.error(k_code_type, "Expected Dialogue Stage mutation object.",
                                        mutation_pointer);
                          return std::nullopt;
                      }
                      decoder.object(mutation, mutation_pointer,
                                     {"action", "appearanceId", "character", "expressionId",
                                      "offset", "poseId", "position", "profileId", "scale",
                                      "slotId"});
                      const auto* slot_value = decoder.member(mutation, "slotId", mutation_pointer);
                      const auto* action_value =
                          decoder.member(mutation, "action", mutation_pointer);
                      auto slot = slot_value
                                      ? decoder.id<DialogueStageSlotId>(
                                            *slot_value, pointer_child(mutation_pointer, "slotId"))
                                      : std::nullopt;
                      auto action = action_value ? decode_dialogue_slot_action(
                                                       decoder, *action_value,
                                                       pointer_child(mutation_pointer, "action"))
                                                 : std::nullopt;
                      if (!slot || !action)
                          return std::nullopt;
                      DialogueStageMutation result{
                          .slot_id = std::move(*slot),
                          .action = *action,
                          .character = std::nullopt,
                          .profile_id = std::nullopt,
                          .pose_id = std::nullopt,
                          .expression_id = std::nullopt,
                          .appearance_id = std::nullopt,
                          .position = std::nullopt,
                          .offset = std::nullopt,
                          .scale = std::nullopt,
                      };
                      if (const auto it = mutation.find("character"); it != mutation.end()) {
                          auto decoded = decode_reference<CharacterId>(
                              decoder, *it, pointer_child(mutation_pointer, "character"),
                              "character");
                          if (!decoded)
                              return std::nullopt;
                          result.character = std::move(*decoded);
                      }
                      if (const auto it = mutation.find("profileId"); it != mutation.end()) {
                          auto decoded = decoder.id<CharacterPresentationProfileId>(
                              *it, pointer_child(mutation_pointer, "profileId"));
                          if (!decoded)
                              return std::nullopt;
                          result.profile_id = std::move(*decoded);
                      }
                      if (const auto it = mutation.find("poseId"); it != mutation.end()) {
                          auto decoded = decoder.id<CharacterPoseId>(
                              *it, pointer_child(mutation_pointer, "poseId"));
                          if (!decoded)
                              return std::nullopt;
                          result.pose_id = std::move(*decoded);
                      }
                      if (const auto it = mutation.find("expressionId"); it != mutation.end()) {
                          auto decoded = decoder.id<CharacterExpressionId>(
                              *it, pointer_child(mutation_pointer, "expressionId"));
                          if (!decoded)
                              return std::nullopt;
                          result.expression_id = std::move(*decoded);
                      }
                      if (const auto it = mutation.find("appearanceId"); it != mutation.end()) {
                          if (it->is_null()) {
                              result.appearance_id = std::optional<CharacterAppearanceId>{};
                          } else {
                              auto decoded = decoder.id<CharacterAppearanceId>(
                                  *it, pointer_child(mutation_pointer, "appearanceId"));
                              if (!decoded)
                                  return std::nullopt;
                              result.appearance_id =
                                  std::optional<CharacterAppearanceId>{std::move(*decoded)};
                          }
                      }
                      if (const auto it = mutation.find("position"); it != mutation.end()) {
                          auto decoded = decode_dialogue_actor_position(
                              decoder, *it, pointer_child(mutation_pointer, "position"));
                          if (!decoded)
                              return std::nullopt;
                          result.position = *decoded;
                      }
                      if (const auto it = mutation.find("offset"); it != mutation.end()) {
                          auto decoded = decode_vector2(decoder, *it,
                                                        pointer_child(mutation_pointer, "offset"));
                          if (!decoded)
                              return std::nullopt;
                          result.offset = *decoded;
                      }
                      if (const auto it = mutation.find("scale"); it != mutation.end()) {
                          auto decoded =
                              decoder.finite_number(*it, pointer_child(mutation_pointer, "scale"));
                          if (!decoded || *decoded <= 0.0) {
                              decoder.error(k_code_type,
                                            "Dialogue Stage mutation scale must be positive.",
                                            pointer_child(mutation_pointer, "scale"));
                              return std::nullopt;
                          }
                          result.scale = *decoded;
                      }
                      return result;
                  })
            : std::nullopt;
    auto media =
        media_value
            ? decoder.array<DialogueMediaMutation>(
                  *media_value, pointer_child(pointer, "media"),
                  [&](const nlohmann::json& mutation,
                      const std::string& mutation_pointer) -> std::optional<DialogueMediaMutation> {
                      if (!mutation.is_object()) {
                          decoder.error(k_code_type, "Expected Dialogue Media mutation object.",
                                        mutation_pointer);
                          return std::nullopt;
                      }
                      decoder.object(mutation, mutation_pointer, {"action", "content", "slotId"});
                      const auto* slot_value = decoder.member(mutation, "slotId", mutation_pointer);
                      const auto* action_value =
                          decoder.member(mutation, "action", mutation_pointer);
                      auto slot = slot_value
                                      ? decoder.id<DialogueMediaSlotId>(
                                            *slot_value, pointer_child(mutation_pointer, "slotId"))
                                      : std::nullopt;
                      auto action = action_value ? decode_dialogue_slot_action(
                                                       decoder, *action_value,
                                                       pointer_child(mutation_pointer, "action"))
                                                 : std::nullopt;
                      if (!slot || !action)
                          return std::nullopt;
                      DialogueMediaMutation result{
                          .slot_id = std::move(*slot), .action = *action, .content = std::nullopt};
                      if (const auto it = mutation.find("content"); it != mutation.end()) {
                          auto decoded = decode_dialogue_media(
                              decoder, *it, pointer_child(mutation_pointer, "content"));
                          if (!decoded)
                              return std::nullopt;
                          result.content = std::move(*decoded);
                      }
                      return result;
                  })
            : std::nullopt;
    return speaker_expression_ok && stage && media
               ? std::optional<DecodedDialogueLinePresentation>(DecodedDialogueLinePresentation{
                     std::move(speaker_expression), std::move(*stage), std::move(*media)})
               : std::nullopt;
}

std::optional<DialogueCuePosition> decode_dialogue_cue_position(Decoder& decoder,
                                                                const nlohmann::json& value,
                                                                std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"offset", "order"}))
        return std::nullopt;
    const auto* offset_value = decoder.member(value, "offset", pointer);
    const auto* order_value = decoder.member(value, "order", pointer);
    auto offset = offset_value ? decoder.unsigned_integer<std::uint64_t>(
                                     *offset_value, pointer_child(pointer, "offset"))
                               : std::nullopt;
    auto order =
        order_value
            ? decoder.unsigned_integer<std::uint64_t>(*order_value, pointer_child(pointer, "order"))
            : std::nullopt;
    return offset && order
               ? std::optional<DialogueCuePosition>(DialogueCuePosition{*offset, *order})
               : std::nullopt;
}

std::optional<DialogueSemanticCue> decode_dialogue_semantic_cue(Decoder& decoder,
                                                                const nlohmann::json& value,
                                                                std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a Dialogue cue object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* position_value = decoder.member(value, "position", pointer);
    auto id = id_value ? decoder.id<DialogueCueId>(*id_value, pointer_child(pointer, "id"))
                       : std::nullopt;
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    auto position = position_value
                        ? decode_dialogue_cue_position(decoder, *position_value,
                                                       pointer_child(pointer, "position"))
                        : std::nullopt;
    if (!id || !kind || !position)
        return std::nullopt;

    if (*kind == "speaker-expression") {
        decoder.object(value, pointer, {"expressionId", "id", "kind", "position"});
        const auto* expression_value = decoder.member(value, "expressionId", pointer);
        auto expression = expression_value
                              ? decoder.id<CharacterExpressionId>(
                                    *expression_value, pointer_child(pointer, "expressionId"))
                              : std::nullopt;
        return expression ? std::optional<DialogueSemanticCue>(DialogueSpeakerExpressionCue{
                                std::move(*id), *position, std::move(*expression)})
                          : std::nullopt;
    }
    if (*kind == "gesture") {
        decoder.object(
            value, pointer,
            {"gestureId", "id", "kind", "position", "skippable", "slotId", "waitForCompletion"});
        const auto* slot_value = decoder.member(value, "slotId", pointer);
        const auto* gesture_value = decoder.member(value, "gestureId", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        auto slot = slot_value ? decoder.id<DialogueStageSlotId>(*slot_value,
                                                                 pointer_child(pointer, "slotId"))
                               : std::nullopt;
        auto gesture = gesture_value ? decoder.id<CharacterGestureId>(
                                           *gesture_value, pointer_child(pointer, "gestureId"))
                                     : std::nullopt;
        auto wait = wait_value
                        ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                        : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        return slot && gesture && wait && skippable
                   ? std::optional<DialogueSemanticCue>(
                         DialogueGestureCue{std::move(*id), *position, std::move(*slot),
                                            std::move(*gesture), *wait, *skippable})
                   : std::nullopt;
    }
    if (*kind == "voice" || *kind == "sound-effect") {
        if (*kind == "voice")
            decoder.object(value, pointer,
                           {"asset", "gain", "id", "kind", "pan", "pausePolicy", "position",
                            "skipBehavior", "waitForCompletion"});
        else
            decoder.object(value, pointer,
                           {"asset", "causality", "gain", "id", "kind", "pan", "pausePolicy",
                            "position", "skipBehavior", "synchronized", "waitForCompletion"});
        const auto* asset_value = decoder.member(value, "asset", pointer);
        const auto* pause_value = decoder.member(value, "pausePolicy", pointer);
        const auto* gain_value = decoder.member(value, "gain", pointer);
        const auto* pan_value = decoder.member(value, "pan", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        const auto* skip_value = decoder.member(value, "skipBehavior", pointer);
        auto asset = asset_value
                         ? decode_reference<AssetId>(decoder, *asset_value,
                                                     pointer_child(pointer, "asset"), "asset")
                         : std::nullopt;
        auto pause = pause_value ? decoder.enumeration<AudioPausePolicy>(
                                       *pause_value, pointer_child(pointer, "pausePolicy"),
                                       {{"gameplay", AudioPausePolicy::Gameplay},
                                        {"owner", AudioPausePolicy::Owner},
                                        {"unscaled", AudioPausePolicy::Unscaled}})
                                 : std::nullopt;
        auto gain = gain_value ? decoder.finite_number(*gain_value, pointer_child(pointer, "gain"))
                               : std::nullopt;
        auto pan = pan_value ? decoder.finite_number(*pan_value, pointer_child(pointer, "pan"))
                             : std::nullopt;
        auto wait = wait_value
                        ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                        : std::nullopt;
        auto skip = skip_value ? decoder.enumeration<AudioSkipBehavior>(
                                     *skip_value, pointer_child(pointer, "skipBehavior"),
                                     {{"stop", AudioSkipBehavior::Stop},
                                      {"suppress", AudioSkipBehavior::Suppress},
                                      {"play", AudioSkipBehavior::Play}})
                               : std::nullopt;
        if (!asset || !pause || !gain || !pan || !wait || !skip)
            return std::nullopt;
        if (*kind == "voice")
            return DialogueVoiceCue{
                std::move(*id), *position, std::move(*asset), *pause, *gain, *pan, *wait, *skip};
        const auto* causality_value = decoder.member(value, "causality", pointer);
        const auto* synchronized_value = decoder.member(value, "synchronized", pointer);
        auto causality = causality_value
                             ? decoder.enumeration<AudioCausality>(
                                   *causality_value, pointer_child(pointer, "causality"),
                                   {{"causal", AudioCausality::Causal},
                                    {"disposable", AudioCausality::Disposable}})
                             : std::nullopt;
        auto synchronized =
            synchronized_value
                ? decoder.boolean(*synchronized_value, pointer_child(pointer, "synchronized"))
                : std::nullopt;
        return causality && synchronized
                   ? std::optional<DialogueSemanticCue>(DialogueSoundEffectCue{
                         std::move(*id), *position, std::move(*asset), *pause, *gain, *pan, *wait,
                         *causality, *synchronized, *skip})
                   : std::nullopt;
    }
    if (*kind == "camera") {
        decoder.object(value, pointer, {"emphasis", "id", "kind", "position"});
        const auto* emphasis_value = decoder.member(value, "emphasis", pointer);
        if (emphasis_value == nullptr || !emphasis_value->is_object()) {
            decoder.error(k_code_type, "Expected Dialogue camera emphasis object.",
                          pointer_child(pointer, "emphasis"));
            return std::nullopt;
        }
        const auto emphasis_pointer = pointer_child(pointer, "emphasis");
        const auto* emphasis_kind_value = decoder.member(*emphasis_value, "kind", emphasis_pointer);
        auto emphasis_kind =
            emphasis_kind_value
                ? decoder.string(*emphasis_kind_value, pointer_child(emphasis_pointer, "kind"))
                : std::nullopt;
        if (!emphasis_kind)
            return std::nullopt;
        const auto decode_common = [&]() -> std::optional<std::tuple<std::uint64_t, bool, bool>> {
            const auto* duration_value =
                decoder.member(*emphasis_value, "durationMs", emphasis_pointer);
            const auto* skippable_value =
                decoder.member(*emphasis_value, "skippable", emphasis_pointer);
            const auto* wait_value =
                decoder.member(*emphasis_value, "waitForCompletion", emphasis_pointer);
            auto duration =
                duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                     *duration_value, pointer_child(emphasis_pointer, "durationMs"))
                               : std::nullopt;
            auto skippable = skippable_value
                                 ? decoder.boolean(*skippable_value,
                                                   pointer_child(emphasis_pointer, "skippable"))
                                 : std::nullopt;
            auto wait = wait_value
                            ? decoder.boolean(*wait_value,
                                              pointer_child(emphasis_pointer, "waitForCompletion"))
                            : std::nullopt;
            return duration && skippable && wait
                       ? std::optional<std::tuple<std::uint64_t, bool, bool>>{std::tuple{
                             *duration, *skippable, *wait}}
                       : std::nullopt;
        };
        if (*emphasis_kind == "shake") {
            decoder.object(*emphasis_value, emphasis_pointer,
                           {"amplitude", "durationMs", "frequencyHz", "kind", "skippable",
                            "waitForCompletion"});
            auto common = decode_common();
            const auto* amplitude_value =
                decoder.member(*emphasis_value, "amplitude", emphasis_pointer);
            const auto* frequency_value =
                decoder.member(*emphasis_value, "frequencyHz", emphasis_pointer);
            auto amplitude = amplitude_value
                                 ? decode_vector2(decoder, *amplitude_value,
                                                  pointer_child(emphasis_pointer, "amplitude"))
                                 : std::nullopt;
            auto frequency =
                frequency_value
                    ? decoder.finite_number(*frequency_value,
                                            pointer_child(emphasis_pointer, "frequencyHz"))
                    : std::nullopt;
            if (common && amplitude && frequency) {
                const auto [duration, skippable, wait] = *common;
                return DialogueCameraCue{
                    std::move(*id), *position,
                    DialogueCameraShakeEmphasis{*amplitude, *frequency, duration, skippable, wait}};
            }
            return std::nullopt;
        }
        if (*emphasis_kind == "punch") {
            decoder.object(*emphasis_value, emphasis_pointer,
                           {"durationMs", "kind", "rotationDegrees", "skippable", "translation",
                            "waitForCompletion", "zoomDelta"});
            auto common = decode_common();
            const auto* translation_value =
                decoder.member(*emphasis_value, "translation", emphasis_pointer);
            const auto* zoom_value = decoder.member(*emphasis_value, "zoomDelta", emphasis_pointer);
            const auto* rotation_value =
                decoder.member(*emphasis_value, "rotationDegrees", emphasis_pointer);
            auto translation = translation_value
                                   ? decode_vector2(decoder, *translation_value,
                                                    pointer_child(emphasis_pointer, "translation"))
                                   : std::nullopt;
            auto zoom = zoom_value ? decoder.finite_number(
                                         *zoom_value, pointer_child(emphasis_pointer, "zoomDelta"))
                                   : std::nullopt;
            auto rotation =
                rotation_value
                    ? decoder.finite_number(*rotation_value,
                                            pointer_child(emphasis_pointer, "rotationDegrees"))
                    : std::nullopt;
            if (common && translation && zoom && rotation) {
                const auto [duration, skippable, wait] = *common;
                return DialogueCameraCue{std::move(*id), *position,
                                         DialogueCameraPunchEmphasis{*translation, *zoom, *rotation,
                                                                     duration, skippable, wait}};
            }
            return std::nullopt;
        }
        if (*emphasis_kind == "flash") {
            decoder.object(
                *emphasis_value, emphasis_pointer,
                {"color", "durationMs", "kind", "opacity", "skippable", "waitForCompletion"});
            auto common = decode_common();
            const auto* color_value = decoder.member(*emphasis_value, "color", emphasis_pointer);
            const auto* opacity_value =
                decoder.member(*emphasis_value, "opacity", emphasis_pointer);
            auto color =
                color_value ? decoder.string(*color_value, pointer_child(emphasis_pointer, "color"))
                            : std::nullopt;
            auto opacity = opacity_value
                               ? decoder.finite_number(*opacity_value,
                                                       pointer_child(emphasis_pointer, "opacity"))
                               : std::nullopt;
            if (common && color && opacity) {
                const auto [duration, skippable, wait] = *common;
                return DialogueCameraCue{std::move(*id), *position,
                                         DialogueCameraFlashEmphasis{std::move(*color), *opacity,
                                                                     duration, skippable, wait}};
            }
            return std::nullopt;
        }
        decoder.error(k_code_variant,
                      "Unknown Dialogue camera emphasis variant '" + *emphasis_kind + "'.",
                      pointer_child(emphasis_pointer, "kind"));
        return std::nullopt;
    }
    if (*kind == "stage" || *kind == "media") {
        decoder.object(value, pointer, {"id", "kind", "mutation", "position"});
        const auto* mutation = decoder.member(value, "mutation", pointer);
        if (mutation == nullptr)
            return std::nullopt;
        nlohmann::json presentation = nlohmann::json::object();
        presentation["stage"] = nlohmann::json::array();
        presentation["media"] = nlohmann::json::array();
        presentation[*kind] = nlohmann::json::array({*mutation});
        auto decoded = decode_dialogue_line_presentation(decoder, presentation,
                                                         pointer_child(pointer, "mutation"));
        if (!decoded)
            return std::nullopt;
        if (*kind == "stage" && decoded->stage.size() == 1)
            return DialogueStageCue{std::move(*id), *position, std::move(decoded->stage.front())};
        if (*kind == "media" && decoded->media.size() == 1)
            return DialogueMediaCue{std::move(*id), *position, std::move(decoded->media.front())};
        return std::nullopt;
    }
    decoder.object(value, pointer, {"id", "kind", "position"});
    decoder.error(k_code_variant, "Unknown Dialogue cue variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<DialogueSegment>
decode_dialogue_segment(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a Dialogue segment object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* id_value = decoder.member(value, "id", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    auto id = id_value ? decoder.id<DialogueSegmentId>(*id_value, pointer_child(pointer, "id"))
                       : std::nullopt;
    bool condition_ok = false;
    auto condition = decode_optional_condition(decoder, value, pointer, condition_ok);
    if (!kind || !id || !condition_ok)
        return std::nullopt;
    if (*kind == "line") {
        decoder.object(value, pointer,
                       {"autosaveSafePoint", "condition", "cues", "effects", "id", "kind", "logged",
                        "showOnce", "speaker", "text"});
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* cues_value = decoder.member(value, "cues", pointer);
        const auto* effects_value = decoder.member(value, "effects", pointer);
        const auto* logged_value = decoder.member(value, "logged", pointer);
        const auto* once_value = decoder.member(value, "showOnce", pointer);
        const auto* speaker_value = decoder.member(value, "speaker", pointer);
        const auto* text_value = decoder.member(value, "text", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        auto effects = effects_value ? decode_effects(decoder, *effects_value,
                                                      pointer_child(pointer, "effects"))
                                     : std::nullopt;
        auto logged = logged_value
                          ? decoder.boolean(*logged_value, pointer_child(pointer, "logged"))
                          : std::nullopt;
        auto once = once_value ? decoder.boolean(*once_value, pointer_child(pointer, "showOnce"))
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
        auto cues = cues_value
                        ? decoder.array<DialogueSemanticCue>(
                              *cues_value, pointer_child(pointer, "cues"),
                              [&](const nlohmann::json& cue, const std::string& cue_pointer) {
                                  return decode_dialogue_semantic_cue(decoder, cue, cue_pointer);
                              })
                        : std::nullopt;
        if (safe && cues && effects && logged && once && speaker_ok && text)
            return DialogueLineSegment{
                std::move(*id),  *safe, std::move(condition), std::move(*effects),
                *logged,         *once, std::move(speaker),   std::move(*text),
                std::move(*cues)};
        return std::nullopt;
    }
    if (*kind == "run-lua") {
        decoder.object(value, pointer, {"condition", "id", "kind", "mayYield", "source"});
        const auto* yield_value = decoder.member(value, "mayYield", pointer);
        const auto* source_value = decoder.member(value, "source", pointer);
        auto may_yield = yield_value
                             ? decoder.boolean(*yield_value, pointer_child(pointer, "mayYield"))
                             : std::nullopt;
        auto source = source_value
                          ? decoder.string(*source_value, pointer_child(pointer, "source"), true)
                          : std::nullopt;
        return may_yield && source
                   ? std::optional<DialogueSegment>(DialogueRunLuaSegment{
                         std::move(*id), std::move(condition), *may_yield, std::move(*source)})
                   : std::nullopt;
    }
    if (*kind == "call-scene") {
        decoder.object(value, pointer, {"condition", "id", "inputs", "kind", "scene", "uiPolicy"});
        const auto* scene_value = decoder.member(value, "scene", pointer);
        const auto* inputs_value = decoder.member(value, "inputs", pointer);
        const auto* policy_value = decoder.member(value, "uiPolicy", pointer);
        auto scene = scene_value
                         ? decode_reference<SceneId>(decoder, *scene_value,
                                                     pointer_child(pointer, "scene"), "scene")
                         : std::nullopt;
        auto inputs = inputs_value ? decode_dialogue_scene_input_bindings(
                                         decoder, *inputs_value, pointer_child(pointer, "inputs"))
                                   : std::nullopt;
        auto policy = policy_value ? decoder.enumeration<DialogueChildSceneUiPolicy>(
                                         *policy_value, pointer_child(pointer, "uiPolicy"),
                                         {{"preserve", DialogueChildSceneUiPolicy::Preserve},
                                          {"conceal", DialogueChildSceneUiPolicy::Conceal}})
                                   : std::nullopt;
        if (inputs)
            decoder.duplicate_ids(*inputs, pointer_child(pointer, "inputs"),
                                  [](const SceneInputBinding& binding) -> const SceneInputId& {
                                      return binding.input_id;
                                  });
        return scene && inputs && policy ? std::optional<DialogueSegment>(DialogueCallSceneSegment{
                                               std::move(*id), std::move(condition),
                                               std::move(*scene), std::move(*inputs), *policy})
                                         : std::nullopt;
    }
    if (*kind == "handoff") {
        decoder.object(value, pointer, {"condition", "id", "kind", "payload"});
        std::optional<RuntimeValue> payload;
        bool payload_ok = true;
        if (const auto it = value.find("payload"); it != value.end()) {
            payload = decode_runtime_value(decoder, *it, pointer_child(pointer, "payload"));
            payload_ok = payload.has_value();
        }
        return payload_ok ? std::optional<DialogueSegment>(DialogueHandoffSegment{
                                std::move(*id), std::move(condition), std::move(payload)})
                          : std::nullopt;
    }
    decoder.object(value, pointer, {"condition", "id", "kind"});
    decoder.error(k_code_variant, "Unknown Dialogue segment variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<DialogueProgram>
decode_dialogue_program(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"blocks", "edges", "entryBlockId"}))
        return std::nullopt;
    const auto* blocks_value = decoder.member(value, "blocks", pointer);
    const auto* edges_value = decoder.member(value, "edges", pointer);
    const auto* entry_value = decoder.member(value, "entryBlockId", pointer);
    auto blocks =
        blocks_value
            ? decoder.array<DialogueBlock>(
                  *blocks_value, pointer_child(pointer, "blocks"),
                  [&](const nlohmann::json& block,
                      const std::string& block_pointer) -> std::optional<DialogueBlock> {
                      if (!block.is_object()) {
                          decoder.error(k_code_type, "Expected a Dialogue block object.",
                                        block_pointer);
                          return std::nullopt;
                      }
                      const auto* kind_value = decoder.member(block, "kind", block_pointer);
                      const auto* id_value = decoder.member(block, "id", block_pointer);
                      auto kind = kind_value ? decoder.string(*kind_value,
                                                              pointer_child(block_pointer, "kind"))
                                             : std::nullopt;
                      auto id = id_value ? decoder.id<DialogueBlockId>(
                                               *id_value, pointer_child(block_pointer, "id"))
                                         : std::nullopt;
                      if (!kind || !id)
                          return std::nullopt;
                      if (*kind == "choice") {
                          decoder.object(block, block_pointer, {"id", "kind"});
                          return DialogueBlock{DialogueChoiceBlock{std::move(*id)}};
                      }
                      if (*kind == "redirect") {
                          decoder.object(block, block_pointer, {"id", "kind", "targetBlockId"});
                          const auto* target_value =
                              decoder.member(block, "targetBlockId", block_pointer);
                          auto target = target_value
                                            ? decoder.id<DialogueBlockId>(
                                                  *target_value,
                                                  pointer_child(block_pointer, "targetBlockId"))
                                            : std::nullopt;
                          return target ? std::optional<DialogueBlock>(DialogueRedirectBlock{
                                              std::move(*id), std::move(*target)})
                                        : std::nullopt;
                      }
                      if (*kind == "sequence") {
                          decoder.object(block, block_pointer,
                                         {"defaultSpeaker", "id", "kind", "segments"});
                          const auto* speaker_value =
                              decoder.member(block, "defaultSpeaker", block_pointer);
                          const auto* segments_value =
                              decoder.member(block, "segments", block_pointer);
                          std::optional<CharacterId> speaker;
                          bool speaker_ok = speaker_value != nullptr;
                          if (speaker_value && !speaker_value->is_null()) {
                              speaker = decode_reference<CharacterId>(
                                  decoder, *speaker_value,
                                  pointer_child(block_pointer, "defaultSpeaker"), "character");
                              speaker_ok = speaker.has_value();
                          }
                          auto segments =
                              segments_value
                                  ? decoder.array<DialogueSegment>(
                                        *segments_value, pointer_child(block_pointer, "segments"),
                                        [&](const nlohmann::json& segment,
                                            const std::string& segment_pointer) {
                                            return decode_dialogue_segment(decoder, segment,
                                                                           segment_pointer);
                                        })
                                  : std::nullopt;
                          if (segments)
                              decoder.duplicate_ids(
                                  *segments, pointer_child(block_pointer, "segments"),
                                  [](const DialogueSegment& segment) -> const DialogueSegmentId& {
                                      return std::visit(
                                          [](const auto& typed) -> const DialogueSegmentId& {
                                              return typed.id;
                                          },
                                          segment);
                                  });
                          return speaker_ok && segments
                                     ? std::optional<DialogueBlock>(
                                           DialogueSequenceBlock{std::move(*id), std::move(speaker),
                                                                 std::move(*segments)})
                                     : std::nullopt;
                      }
                      decoder.object(block, block_pointer, {"id", "kind"});
                      decoder.error(k_code_variant,
                                    "Unknown Dialogue block variant '" + *kind + "'.",
                                    pointer_child(block_pointer, "kind"));
                      return std::nullopt;
                  })
            : std::nullopt;
    auto edges =
        edges_value
            ? decoder.array<DialogueEdge>(
                  *edges_value, pointer_child(pointer, "edges"),
                  [&](const nlohmann::json& edge,
                      const std::string& edge_pointer) -> std::optional<DialogueEdge> {
                      if (!edge.is_object()) {
                          decoder.error(k_code_type, "Expected a Dialogue edge object.",
                                        edge_pointer);
                          return std::nullopt;
                      }
                      const auto* kind_value = decoder.member(edge, "kind", edge_pointer);
                      const auto* id_value = decoder.member(edge, "id", edge_pointer);
                      const auto* from_value = decoder.member(edge, "fromBlockId", edge_pointer);
                      const auto* to_value = decoder.member(edge, "toBlockId", edge_pointer);
                      auto kind = kind_value ? decoder.string(*kind_value,
                                                              pointer_child(edge_pointer, "kind"))
                                             : std::nullopt;
                      auto id = id_value ? decoder.id<DialogueEdgeId>(
                                               *id_value, pointer_child(edge_pointer, "id"))
                                         : std::nullopt;
                      auto from = from_value
                                      ? decoder.id<DialogueBlockId>(
                                            *from_value, pointer_child(edge_pointer, "fromBlockId"))
                                      : std::nullopt;
                      auto to = to_value ? decoder.id<DialogueBlockId>(
                                               *to_value, pointer_child(edge_pointer, "toBlockId"))
                                         : std::nullopt;
                      if (!kind || !id || !from || !to)
                          return std::nullopt;
                      if (*kind == "next") {
                          decoder.object(edge, edge_pointer,
                                         {"fromBlockId", "id", "kind", "toBlockId"});
                          return DialogueEdge{
                              DialogueNextEdge{std::move(*id), std::move(*from), std::move(*to)}};
                      }
                      if (*kind == "choice") {
                          decoder.object(edge, edge_pointer,
                                         {"autosaveSafePoint", "condition", "effects",
                                          "fromBlockId", "id", "kind", "label", "logged",
                                          "toBlockId"});
                          const auto* safe_value =
                              decoder.member(edge, "autosaveSafePoint", edge_pointer);
                          const auto* effects_value = decoder.member(edge, "effects", edge_pointer);
                          const auto* label_value = decoder.member(edge, "label", edge_pointer);
                          const auto* logged_value = decoder.member(edge, "logged", edge_pointer);
                          bool condition_ok = false;
                          auto condition =
                              decode_optional_condition(decoder, edge, edge_pointer, condition_ok);
                          auto safe =
                              safe_value
                                  ? decoder.boolean(*safe_value, pointer_child(edge_pointer,
                                                                               "autosaveSafePoint"))
                                  : std::nullopt;
                          auto effects =
                              effects_value ? decode_effects(decoder, *effects_value,
                                                             pointer_child(edge_pointer, "effects"))
                                            : std::nullopt;
                          auto label = label_value
                                           ? decode_text(decoder, *label_value,
                                                         pointer_child(edge_pointer, "label"))
                                           : std::nullopt;
                          auto logged = logged_value
                                            ? decoder.boolean(*logged_value,
                                                              pointer_child(edge_pointer, "logged"))
                                            : std::nullopt;
                          if (condition_ok && safe && effects && label && logged)
                              return DialogueChoiceEdge{std::move(*id),
                                                        *safe,
                                                        std::move(condition),
                                                        std::move(*effects),
                                                        std::move(*from),
                                                        std::move(*label),
                                                        *logged,
                                                        std::move(*to)};
                          return std::nullopt;
                      }
                      decoder.object(edge, edge_pointer,
                                     {"fromBlockId", "id", "kind", "toBlockId"});
                      decoder.error(k_code_variant,
                                    "Unknown Dialogue edge variant '" + *kind + "'.",
                                    pointer_child(edge_pointer, "kind"));
                      return std::nullopt;
                  })
            : std::nullopt;
    auto entry = entry_value ? decoder.id<DialogueBlockId>(*entry_value,
                                                           pointer_child(pointer, "entryBlockId"))
                             : std::nullopt;
    if (blocks)
        decoder.duplicate_ids(
            *blocks, pointer_child(pointer, "blocks"),
            [](const DialogueBlock& block) -> const DialogueBlockId& {
                return std::visit(
                    [](const auto& typed) -> const DialogueBlockId& { return typed.id; }, block);
            });
    if (edges)
        decoder.duplicate_ids(
            *edges, pointer_child(pointer, "edges"),
            [](const DialogueEdge& edge) -> const DialogueEdgeId& {
                return std::visit(
                    [](const auto& typed) -> const DialogueEdgeId& { return typed.id; }, edge);
            });
    return blocks && edges && entry ? std::optional<DialogueProgram>(DialogueProgram{
                                          std::move(*blocks), std::move(*edges), std::move(*entry)})
                                    : std::nullopt;
}

std::optional<DialogueDefinition> decode_dialogue(Decoder& decoder, const nlohmann::json& value,
                                                  std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"completion", "defaultSpeaker", "displayName", "id", "mediaSlots",
                         "program", "settings", "stageSlots"}))
        return std::nullopt;
    auto identity = decode_definition_identity<DialogueId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* speaker_value = decoder.member(value, "defaultSpeaker", pointer);
    const auto* settings_value = decoder.member(value, "settings", pointer);
    const auto* program_value = decoder.member(value, "program", pointer);
    const auto* completion_value = decoder.member(value, "completion", pointer);
    const auto* stage_slots_value = decoder.member(value, "stageSlots", pointer);
    const auto* media_slots_value = decoder.member(value, "mediaSlots", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    std::optional<CharacterId> speaker;
    bool speaker_ok = speaker_value != nullptr;
    if (speaker_value && !speaker_value->is_null()) {
        speaker = decode_reference<CharacterId>(
            decoder, *speaker_value, pointer_child(pointer, "defaultSpeaker"), "character");
        speaker_ok = speaker.has_value();
    }
    std::optional<DialogueSettings> settings;
    if (settings_value && decoder.object(*settings_value, pointer_child(pointer, "settings"),
                                         {"logMode", "showDisabledChoices"})) {
        const auto settings_pointer = pointer_child(pointer, "settings");
        const auto* log_value = decoder.member(*settings_value, "logMode", settings_pointer);
        const auto* disabled_value =
            decoder.member(*settings_value, "showDisabledChoices", settings_pointer);
        auto log = log_value ? decoder.enumeration<DialogueLogMode>(
                                   *log_value, pointer_child(settings_pointer, "logMode"),
                                   {{"everything", DialogueLogMode::Everything},
                                    {"nothing", DialogueLogMode::Nothing},
                                    {"only-choices", DialogueLogMode::OnlyChoices},
                                    {"only-lines", DialogueLogMode::OnlyLines}})
                             : std::nullopt;
        auto disabled =
            disabled_value ? decoder.boolean(*disabled_value,
                                             pointer_child(settings_pointer, "showDisabledChoices"))
                           : std::nullopt;
        if (log && disabled)
            settings = DialogueSettings{*log, *disabled};
    }
    auto program = program_value ? decode_dialogue_program(decoder, *program_value,
                                                           pointer_child(pointer, "program"))
                                 : std::nullopt;
    auto completion = completion_value
                          ? decode_flow_target_impl(decoder, *completion_value,
                                                    pointer_child(pointer, "completion"))
                          : std::nullopt;
    auto stage_slots =
        stage_slots_value
            ? decoder.array<DialogueStageSlotDefinition>(
                  *stage_slots_value, pointer_child(pointer, "stageSlots"),
                  [&](const nlohmann::json& slot, const std::string& slot_pointer)
                      -> std::optional<DialogueStageSlotDefinition> {
                      if (!decoder.object(slot, slot_pointer, {"id", "initial", "speakerSync"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(slot, "id", slot_pointer);
                      const auto* initial_value = decoder.member(slot, "initial", slot_pointer);
                      const auto* sync_value = decoder.member(slot, "speakerSync", slot_pointer);
                      auto id = id_value ? decoder.id<DialogueStageSlotId>(
                                               *id_value, pointer_child(slot_pointer, "id"))
                                         : std::nullopt;
                      auto sync = sync_value
                                      ? decoder.boolean(*sync_value,
                                                        pointer_child(slot_pointer, "speakerSync"))
                                      : std::nullopt;
                      std::optional<DialogueStageSlotState> initial;
                      bool initial_ok = initial_value != nullptr;
                      if (initial_value && !initial_value->is_null()) {
                          initial = decode_dialogue_stage_state(
                              decoder, *initial_value, pointer_child(slot_pointer, "initial"));
                          initial_ok = initial.has_value();
                      }
                      return id && sync && initial_ok
                                 ? std::optional<DialogueStageSlotDefinition>(
                                       DialogueStageSlotDefinition{std::move(*id), *sync,
                                                                   std::move(initial)})
                                 : std::nullopt;
                  })
            : std::nullopt;
    auto media_slots =
        media_slots_value
            ? decoder.array<DialogueMediaSlotDefinition>(
                  *media_slots_value, pointer_child(pointer, "mediaSlots"),
                  [&](const nlohmann::json& slot, const std::string& slot_pointer)
                      -> std::optional<DialogueMediaSlotDefinition> {
                      if (!decoder.object(slot, slot_pointer, {"id", "initial", "visible"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(slot, "id", slot_pointer);
                      const auto* initial_value = decoder.member(slot, "initial", slot_pointer);
                      const auto* visible_value = decoder.member(slot, "visible", slot_pointer);
                      auto id = id_value ? decoder.id<DialogueMediaSlotId>(
                                               *id_value, pointer_child(slot_pointer, "id"))
                                         : std::nullopt;
                      auto visible = visible_value
                                         ? decoder.boolean(*visible_value,
                                                           pointer_child(slot_pointer, "visible"))
                                         : std::nullopt;
                      std::optional<DialogueMediaContent> initial;
                      bool initial_ok = initial_value != nullptr;
                      if (initial_value && !initial_value->is_null()) {
                          initial = decode_dialogue_media(decoder, *initial_value,
                                                          pointer_child(slot_pointer, "initial"));
                          initial_ok = initial.has_value();
                      }
                      return id && visible && initial_ok
                                 ? std::optional<DialogueMediaSlotDefinition>(
                                       DialogueMediaSlotDefinition{std::move(*id),
                                                                   std::move(initial), *visible})
                                 : std::nullopt;
                  })
            : std::nullopt;
    if (stage_slots)
        decoder.duplicate_ids(
            *stage_slots, pointer_child(pointer, "stageSlots"),
            [](const DialogueStageSlotDefinition& slot) -> const DialogueStageSlotId& {
                return slot.id;
            });
    if (media_slots)
        decoder.duplicate_ids(
            *media_slots, pointer_child(pointer, "mediaSlots"),
            [](const DialogueMediaSlotDefinition& slot) -> const DialogueMediaSlotId& {
                return slot.id;
            });
    if (!identity || !display || !speaker_ok || !program || !settings || !completion ||
        !stage_slots || !media_slots)
        return std::nullopt;
    return DialogueDefinition{std::move(*identity),    std::move(*display),     std::move(speaker),
                              std::move(*stage_slots), std::move(*media_slots), std::move(*program),
                              std::move(*settings),    std::move(*completion)};
}

} // namespace noveltea::core::compiled::wire::detail
