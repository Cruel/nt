#include "internal.hpp"

namespace noveltea::core::compiled::wire::detail {

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
                        "showOnce", "speaker", "text"});
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
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
        if (safe && effects && logged && once && speaker_ok && text)
            return DialogueLineSegment{std::move(*id),      *safe,           std::move(condition),
                                       std::move(*effects), *logged,         *once,
                                       std::move(speaker),  std::move(*text)};
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
                        {"completion", "defaultSpeaker", "displayName", "extends", "id", "program",
                         "propertyAssignments", "settings"}))
        return std::nullopt;
    auto identity = decode_identity<DialogueId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* speaker_value = decoder.member(value, "defaultSpeaker", pointer);
    const auto* settings_value = decoder.member(value, "settings", pointer);
    const auto* program_value = decoder.member(value, "program", pointer);
    const auto* completion_value = decoder.member(value, "completion", pointer);
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
    if (!identity || !display || !speaker_ok || !program || !settings || !completion)
        return std::nullopt;
    return DialogueDefinition{std::move(*identity), std::move(*display),  std::move(speaker),
                              std::move(*program),  std::move(*settings), std::move(*completion)};
}

} // namespace noveltea::core::compiled::wire::detail
