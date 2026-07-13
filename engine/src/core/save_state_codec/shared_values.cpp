#include "codec_internal.hpp"

namespace noveltea::core::save_state_codec {
nlohmann::json encode_value(const RuntimeValue& value)
{
    return std::visit(
        [](const auto& item) -> nlohmann::json {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, std::monostate>)
                return nullptr;
            else
                return item;
        },
        value);
}

std::optional<RuntimeValue> decode_value(Decoder& d, const nlohmann::json& value,
                                         std::string_view pointer)
{
    if (value.is_null())
        return RuntimeValue{std::monostate{}};
    if (const auto result = json_access::get<bool>(value))
        return RuntimeValue{*result};
    if (const auto* integer = value.get_ptr<const nlohmann::json::number_integer_t*>())
        return RuntimeValue{static_cast<std::int64_t>(*integer)};
    if (const auto* integer = value.get_ptr<const nlohmann::json::number_unsigned_t*>()) {
        if (*integer <= static_cast<nlohmann::json::number_unsigned_t>(
                            std::numeric_limits<std::int64_t>::max()))
            return RuntimeValue{static_cast<std::int64_t>(*integer)};
    }
    if (const auto* number = value.get_ptr<const nlohmann::json::number_float_t*>()) {
        if (std::isfinite(*number))
            return RuntimeValue{static_cast<double>(*number)};
        d.error(k_value, "Numbers must be finite.", std::string(pointer));
        return std::nullopt;
    }
    if (const auto result = json_access::get<std::string>(value))
        return RuntimeValue{*result};
    d.error(k_type, "Expected a scalar runtime value.", std::string(pointer));
    return std::nullopt;
}

nlohmann::json encode_owner(const PropertyOwnerRef& owner)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return nlohmann::json{{"kind", "room"}, {"id", value.text()}};
            else if constexpr (std::is_same_v<T, SceneId>)
                return nlohmann::json{{"kind", "scene"}, {"id", value.text()}};
            else if constexpr (std::is_same_v<T, DialogueId>)
                return nlohmann::json{{"kind", "dialogue"}, {"id", value.text()}};
            else if constexpr (std::is_same_v<T, CharacterId>)
                return nlohmann::json{{"kind", "character"}, {"id", value.text()}};
            else if constexpr (std::is_same_v<T, InteractableId>)
                return nlohmann::json{{"kind", "interactable"}, {"id", value.text()}};
            else if constexpr (std::is_same_v<T, VerbId>)
                return nlohmann::json{{"kind", "verb"}, {"id", value.text()}};
            else if constexpr (std::is_same_v<T, InteractionId>)
                return nlohmann::json{{"kind", "interaction"}, {"id", value.text()}};
            else
                return nlohmann::json{{"kind", "map"}, {"id", value.text()}};
        },
        owner);
}

std::optional<PropertyOwnerRef> decode_owner(Decoder& d, const nlohmann::json& value,
                                             std::string_view pointer)
{
    if (!d.object(value, pointer, {"kind", "id"}))
        return std::nullopt;
    const auto* kind = d.member(value, "kind", pointer);
    const auto* id = d.member(value, "id", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name || !id)
        return std::nullopt;
    if (*name == "room") {
        auto result = d.id<RoomId>(*id, child(pointer, "id"));
        return result ? std::optional<PropertyOwnerRef>(*result) : std::nullopt;
    }
    if (*name == "scene") {
        auto result = d.id<SceneId>(*id, child(pointer, "id"));
        return result ? std::optional<PropertyOwnerRef>(*result) : std::nullopt;
    }
    if (*name == "dialogue") {
        auto result = d.id<DialogueId>(*id, child(pointer, "id"));
        return result ? std::optional<PropertyOwnerRef>(*result) : std::nullopt;
    }
    if (*name == "character") {
        auto result = d.id<CharacterId>(*id, child(pointer, "id"));
        return result ? std::optional<PropertyOwnerRef>(*result) : std::nullopt;
    }
    if (*name == "interactable") {
        auto result = d.id<InteractableId>(*id, child(pointer, "id"));
        return result ? std::optional<PropertyOwnerRef>(*result) : std::nullopt;
    }
    if (*name == "verb") {
        auto result = d.id<VerbId>(*id, child(pointer, "id"));
        return result ? std::optional<PropertyOwnerRef>(*result) : std::nullopt;
    }
    if (*name == "interaction") {
        auto result = d.id<InteractionId>(*id, child(pointer, "id"));
        return result ? std::optional<PropertyOwnerRef>(*result) : std::nullopt;
    }
    if (*name == "map") {
        auto result = d.id<MapId>(*id, child(pointer, "id"));
        return result ? std::optional<PropertyOwnerRef>(*result) : std::nullopt;
    }
    d.error(k_variant, "Unknown property owner kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_location(const compiled::InteractableLocation& location)
{
    return std::visit(
        [](const auto& item) -> nlohmann::json {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, compiled::InventoryLocation>)
                return {{"kind", "inventory"}};
            else if constexpr (std::is_same_v<T, compiled::NowhereLocation>)
                return {{"kind", "nowhere"}};
            else
                return {{"kind", "room-placement"},
                        {"room", item.room.text()},
                        {"placement", item.placement_id.text()}};
        },
        location);
}

std::optional<compiled::InteractableLocation>
decode_location(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a location object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    if (*name == "inventory") {
        d.object(value, pointer, {"kind"});
        return compiled::InventoryLocation{};
    }
    if (*name == "nowhere") {
        d.object(value, pointer, {"kind"});
        return compiled::NowhereLocation{};
    }
    if (*name == "room-placement") {
        d.object(value, pointer, {"kind", "room", "placement"});
        const auto* room = d.member(value, "room", pointer);
        const auto* placement = d.member(value, "placement", pointer);
        auto room_id = room ? d.id<RoomId>(*room, child(pointer, "room")) : std::nullopt;
        auto placement_id = placement
                                ? d.id<RoomPlacementId>(*placement, child(pointer, "placement"))
                                : std::nullopt;
        if (room_id && placement_id)
            return compiled::RoomPlacementRef{std::move(*room_id), std::move(*placement_id)};
        return std::nullopt;
    }
    d.error(k_variant, "Unknown location kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_text_origin(const TextLogOrigin& origin)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneTextLogOrigin>)
                return {
                    {"kind", "scene"}, {"scene", value.scene.text()}, {"step", value.step.text()}};
            else if constexpr (std::is_same_v<T, DialogueLineTextLogOrigin>)
                return {{"kind", "dialogue-line"},
                        {"dialogue", value.dialogue.text()},
                        {"segment", value.segment.text()}};
            else if constexpr (std::is_same_v<T, DialogueChoiceTextLogOrigin>)
                return {{"kind", "dialogue-choice"},
                        {"dialogue", value.dialogue.text()},
                        {"edge", value.edge.text()}};
            else if constexpr (std::is_same_v<T, InteractionTextLogOrigin>)
                return {{"kind", "interaction"},
                        {"interaction", value.interaction.text()},
                        {"instruction", value.instruction.text()}};
            else
                return {{"kind", "system"}};
        },
        origin);
}

std::optional<TextLogOrigin> decode_text_origin(Decoder& d, const nlohmann::json& value,
                                                std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a text-log origin object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    if (*name == "system") {
        d.object(value, pointer, {"kind"});
        return SystemTextLogOrigin{};
    }
    if (*name == "scene") {
        d.object(value, pointer, {"kind", "scene", "step"});
        const auto* scene = d.member(value, "scene", pointer);
        const auto* step = d.member(value, "step", pointer);
        auto scene_id = scene ? d.id<SceneId>(*scene, child(pointer, "scene")) : std::nullopt;
        auto step_id = step ? d.id<SceneStepId>(*step, child(pointer, "step")) : std::nullopt;
        return scene_id && step_id ? std::optional<TextLogOrigin>(SceneTextLogOrigin{
                                         std::move(*scene_id), std::move(*step_id)})
                                   : std::nullopt;
    }
    if (*name == "dialogue-line") {
        d.object(value, pointer, {"kind", "dialogue", "segment"});
        const auto* dialogue = d.member(value, "dialogue", pointer);
        const auto* segment = d.member(value, "segment", pointer);
        auto dialogue_id =
            dialogue ? d.id<DialogueId>(*dialogue, child(pointer, "dialogue")) : std::nullopt;
        auto segment_id =
            segment ? d.id<DialogueSegmentId>(*segment, child(pointer, "segment")) : std::nullopt;
        return dialogue_id && segment_id ? std::optional<TextLogOrigin>(DialogueLineTextLogOrigin{
                                               std::move(*dialogue_id), std::move(*segment_id)})
                                         : std::nullopt;
    }
    if (*name == "dialogue-choice") {
        d.object(value, pointer, {"kind", "dialogue", "edge"});
        const auto* dialogue = d.member(value, "dialogue", pointer);
        const auto* edge = d.member(value, "edge", pointer);
        auto dialogue_id =
            dialogue ? d.id<DialogueId>(*dialogue, child(pointer, "dialogue")) : std::nullopt;
        auto edge_id = edge ? d.id<DialogueEdgeId>(*edge, child(pointer, "edge")) : std::nullopt;
        return dialogue_id && edge_id ? std::optional<TextLogOrigin>(DialogueChoiceTextLogOrigin{
                                            std::move(*dialogue_id), std::move(*edge_id)})
                                      : std::nullopt;
    }
    if (*name == "interaction") {
        d.object(value, pointer, {"kind", "interaction", "instruction"});
        const auto* interaction = d.member(value, "interaction", pointer);
        const auto* instruction = d.member(value, "instruction", pointer);
        auto interaction_id = interaction
                                  ? d.id<InteractionId>(*interaction, child(pointer, "interaction"))
                                  : std::nullopt;
        auto instruction_id =
            instruction
                ? d.id<InteractionInstructionId>(*instruction, child(pointer, "instruction"))
                : std::nullopt;
        return interaction_id && instruction_id
                   ? std::optional<TextLogOrigin>(InteractionTextLogOrigin{
                         std::move(*interaction_id), std::move(*instruction_id)})
                   : std::nullopt;
    }
    d.error(k_variant, "Unknown text-log origin kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_text_log(const TextLogEntry& entry)
{
    static constexpr std::string_view kinds[] = {"line", "choice", "notification"};
    return {{"kind", kinds[static_cast<std::size_t>(entry.kind)]},
            {"origin", encode_text_origin(entry.origin)},
            {"speaker", encode_optional_id(entry.speaker)},
            {"text", entry.text},
            {"markup", entry.markup == TextMarkup::Plain ? "plain" : "active-text"}};
}

std::optional<TextLogEntry> decode_text_log(Decoder& d, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!d.object(value, pointer, {"kind", "origin", "speaker", "text", "markup"}))
        return std::nullopt;
    const auto* kind = d.member(value, "kind", pointer);
    const auto* origin = d.member(value, "origin", pointer);
    const auto* speaker = d.member(value, "speaker", pointer);
    const auto* text = d.member(value, "text", pointer);
    const auto* markup = d.member(value, "markup", pointer);
    auto kind_name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    auto saved_origin =
        origin ? decode_text_origin(d, *origin, child(pointer, "origin")) : std::nullopt;
    auto speaker_id = speaker ? d.optional_id<CharacterId>(*speaker, child(pointer, "speaker"))
                              : Decoder::OptionalId<CharacterId>{};
    auto contents = text ? d.string(*text, child(pointer, "text")) : std::nullopt;
    auto markup_name = markup ? d.string(*markup, child(pointer, "markup")) : std::nullopt;
    if (!kind_name || !saved_origin || !speaker_id || !contents || !markup_name)
        return std::nullopt;
    TextLogEntryKind decoded_kind;
    if (*kind_name == "line")
        decoded_kind = TextLogEntryKind::Line;
    else if (*kind_name == "choice")
        decoded_kind = TextLogEntryKind::Choice;
    else if (*kind_name == "notification")
        decoded_kind = TextLogEntryKind::Notification;
    else {
        d.error(k_variant, "Unknown text-log kind '" + *kind_name + "'.", child(pointer, "kind"));
        return std::nullopt;
    }
    TextMarkup decoded_markup;
    if (*markup_name == "plain")
        decoded_markup = TextMarkup::Plain;
    else if (*markup_name == "active-text")
        decoded_markup = TextMarkup::ActiveText;
    else {
        d.error(k_variant, "Unknown text markup '" + *markup_name + "'.", child(pointer, "markup"));
        return std::nullopt;
    }
    return TextLogEntry{decoded_kind, std::move(*saved_origin), std::move(speaker_id.value),
                        std::move(*contents), decoded_markup};
}

nlohmann::json encode_mode(const RuntimeMode& mode)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RoomMode>)
                return {{"kind", "room"}, {"room", value.room.text()}};
            else if constexpr (std::is_same_v<T, FlowMode>)
                return {{"kind", "flow"}};
            else
                return {{"kind", "ended"}};
        },
        mode);
}

std::optional<RuntimeMode> decode_mode(Decoder& d, const nlohmann::json& value,
                                       std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a mode object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    if (*name == "flow") {
        d.object(value, pointer, {"kind"});
        return FlowMode{};
    }
    if (*name == "ended") {
        d.object(value, pointer, {"kind"});
        return EndedMode{};
    }
    if (*name == "room") {
        d.object(value, pointer, {"kind", "room"});
        const auto* room = d.member(value, "room", pointer);
        auto room_id = room ? d.id<RoomId>(*room, child(pointer, "room")) : std::nullopt;
        return room_id ? std::optional<RuntimeMode>(RoomMode{std::move(*room_id)}) : std::nullopt;
    }
    d.error(k_variant, "Unknown runtime mode '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

} // namespace noveltea::core::save_state_codec
