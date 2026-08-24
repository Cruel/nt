#include "internal.hpp"

namespace noveltea::core::compiled::wire::detail {

namespace {

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

std::optional<DialogueLinePresentation>
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
               ? std::optional<DialogueLinePresentation>(DialogueLinePresentation{
                     std::move(speaker_expression), std::move(*stage), std::move(*media)})
               : std::nullopt;
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
                       {"autosaveSafePoint", "condition", "effects", "id", "kind", "logged",
                        "presentation", "showOnce", "speaker", "text"});
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* effects_value = decoder.member(value, "effects", pointer);
        const auto* logged_value = decoder.member(value, "logged", pointer);
        const auto* once_value = decoder.member(value, "showOnce", pointer);
        const auto* speaker_value = decoder.member(value, "speaker", pointer);
        const auto* text_value = decoder.member(value, "text", pointer);
        const auto* presentation_value = decoder.member(value, "presentation", pointer);
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
        auto presentation =
            presentation_value
                ? decode_dialogue_line_presentation(decoder, *presentation_value,
                                                    pointer_child(pointer, "presentation"))
                : std::nullopt;
        if (safe && effects && logged && once && speaker_ok && text && presentation)
            return DialogueLineSegment{std::move(*id),
                                       *safe,
                                       std::move(condition),
                                       std::move(*effects),
                                       *logged,
                                       *once,
                                       std::move(speaker),
                                       std::move(*text),
                                       std::move(*presentation)};
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
