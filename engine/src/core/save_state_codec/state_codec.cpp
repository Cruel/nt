#include "codec_internal.hpp"

namespace noveltea::core::save_state_codec {
template<class T, class Function>
std::optional<std::vector<T>> decode_array(Decoder& d, const nlohmann::json* value,
                                           std::string_view pointer, Function&& decode)
{
    if (!value || !value->is_array()) {
        d.error(k_type, "Expected an array.", std::string(pointer));
        return std::nullopt;
    }
    std::vector<T> result;
    result.reserve(value->size());
    for (std::size_t item = 0; item < value->size(); ++item) {
        const auto* entry = json_access::element(*value, item);
        auto decoded = entry ? decode(*entry, index(pointer, item)) : std::nullopt;
        if (decoded)
            result.push_back(std::move(*decoded));
    }
    return result;
}

Result<nlohmann::json, Diagnostics> encode_save_state_impl(const CompiledProject& project,
                                                           const SaveState& save)
{
    auto validation = validate_save_state_impl(project, save, {});
    if (!validation)
        return Result<nlohmann::json, Diagnostics>::failure(validation.error());
    nlohmann::json variables = nlohmann::json::array();
    for (const auto& value : save.variables)
        variables.push_back({{"id", value.id.text()}, {"value", encode_value(value.value)}});
    nlohmann::json overrides = nlohmann::json::array();
    for (const auto& value : save.property_overrides)
        overrides.push_back({{"owner", encode_owner(value.owner)},
                             {"property", value.property.text()},
                             {"value", encode_value(value.value)}});
    nlohmann::json interactables = nlohmann::json::array();
    for (const auto& value : save.interactables)
        interactables.push_back({{"id", value.interactable.text()},
                                 {"location", encode_location(value.location)},
                                 {"enabled", value.enabled},
                                 {"visible", value.visible}});
    nlohmann::json room_visits = nlohmann::json::array();
    for (const auto& value : save.room_visits)
        room_visits.push_back({{"room", value.room.text()}, {"count", value.count}});
    nlohmann::json line_history = nlohmann::json::array();
    for (const auto& value : save.dialogue_line_history)
        line_history.push_back({{"dialogue", value.key.dialogue.text()},
                                {"segment", value.key.segment.text()},
                                {"count", value.count}});
    nlohmann::json choice_history = nlohmann::json::array();
    for (const auto& value : save.dialogue_choice_history)
        choice_history.push_back({{"dialogue", value.key.dialogue.text()},
                                  {"edge", value.key.edge.text()},
                                  {"count", value.count}});
    nlohmann::json log = nlohmann::json::array();
    for (const auto& value : save.text_log)
        log.push_back(encode_text_log(value));
    nlohmann::json timers = nlohmann::json::array();
    for (const auto& value : save.logical_timers)
        timers.push_back(
            {{"id", value.id.value},
             {"remainingMs", value.remaining.count()},
             {"repeatMs", value.repeat_interval ? nlohmann::json(value.repeat_interval->count())
                                                : nlohmann::json(nullptr)}});
    nlohmann::json completions = nlohmann::json::array();
    for (const auto& value : save.pending_timer_completions)
        completions.push_back({{"id", value.id.value}, {"occurrences", value.occurrences}});
    nlohmann::json frames = nlohmann::json::array();
    for (const auto& value : save.flow_stack)
        frames.push_back(encode_frame(value));
    return Result<nlohmann::json, Diagnostics>::success(
        {{"schema", std::string(k_schema)},
         {"version", SaveStateMetadata::current_format_version},
         {"metadata",
          {{"project", save.metadata.project.text()},
           {"projectVersion", save.metadata.project_version}}},
         {"playTimeMs", save.play_time.count()},
         {"variables", std::move(variables)},
         {"propertyOverrides", std::move(overrides)},
         {"interactables", std::move(interactables)},
         {"roomVisits", std::move(room_visits)},
         {"dialogueLineHistory", std::move(line_history)},
         {"dialogueChoiceHistory", std::move(choice_history)},
         {"textLog", std::move(log)},
         {"logicalTimers", std::move(timers)},
         {"pendingTimerCompletions", std::move(completions)},
         {"mode", encode_mode(save.mode)},
         {"flowStack", std::move(frames)},
         {"blocker", encode_blocker(save.blocker)}});
}

Result<SaveState, Diagnostics> decode_save_state_wire_impl(const nlohmann::json& document,
                                                           std::string source_path)
{
    Decoder d(std::move(source_path));
    d.object(document, "",
             {"schema", "version", "metadata", "playTimeMs", "variables", "propertyOverrides",
              "interactables", "roomVisits", "dialogueLineHistory", "dialogueChoiceHistory",
              "textLog", "logicalTimers", "pendingTimerCompletions", "mode", "flowStack",
              "blocker"});
    const auto* schema = d.member(document, "schema", "");
    const auto* version = d.member(document, "version", "");
    const auto* metadata = d.member(document, "metadata", "");
    const auto* play_time = d.member(document, "playTimeMs", "");
    const auto* variables = d.member(document, "variables", "");
    const auto* overrides = d.member(document, "propertyOverrides", "");
    const auto* interactables = d.member(document, "interactables", "");
    const auto* room_visits = d.member(document, "roomVisits", "");
    const auto* line_history = d.member(document, "dialogueLineHistory", "");
    const auto* choice_history = d.member(document, "dialogueChoiceHistory", "");
    const auto* text_log = d.member(document, "textLog", "");
    const auto* timers = d.member(document, "logicalTimers", "");
    const auto* completions = d.member(document, "pendingTimerCompletions", "");
    const auto* mode = d.member(document, "mode", "");
    const auto* frames = d.member(document, "flowStack", "");
    const auto* blocker = d.member(document, "blocker", "");
    auto schema_name = schema ? d.string(*schema, "/schema") : std::nullopt;
    auto format = version ? d.unsigned_integer<std::uint32_t>(*version, "/version") : std::nullopt;
    if (schema_name && *schema_name != k_schema)
        d.error(k_value, "Unsupported save schema.", "/schema");
    if (format && *format != SaveStateMetadata::current_format_version)
        d.error(k_value, "Unsupported save format version.", "/version");
    std::optional<SaveStateMetadata> saved_metadata;
    if (metadata && d.object(*metadata, "/metadata", {"project", "projectVersion"})) {
        const auto* project = d.member(*metadata, "project", "/metadata");
        const auto* project_version = d.member(*metadata, "projectVersion", "/metadata");
        auto project_id = project ? d.id<ProjectId>(*project, "/metadata/project") : std::nullopt;
        auto saved_version =
            project_version ? d.string(*project_version, "/metadata/projectVersion") : std::nullopt;
        if (format && project_id && saved_version)
            saved_metadata =
                SaveStateMetadata{*format, std::move(*project_id), std::move(*saved_version)};
    }
    auto milliseconds =
        play_time ? d.unsigned_integer<std::uint64_t>(*play_time, "/playTimeMs") : std::nullopt;
    if (milliseconds &&
        *milliseconds > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
        d.error(k_value, "Play time is outside the supported range.", "/playTimeMs");
        milliseconds.reset();
    }
    auto saved_variables = decode_array<SavedVariable>(
        d, variables, "/variables",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedVariable> {
            if (!d.object(value, pointer, {"id", "value"}))
                return std::nullopt;
            const auto* id = d.member(value, "id", pointer);
            const auto* saved = d.member(value, "value", pointer);
            auto variable = id ? d.id<VariableId>(*id, child(pointer, "id")) : std::nullopt;
            auto runtime = saved ? decode_value(d, *saved, child(pointer, "value")) : std::nullopt;
            return variable && runtime ? std::optional<SavedVariable>(SavedVariable{
                                             std::move(*variable), std::move(*runtime)})
                                       : std::nullopt;
        });
    auto saved_overrides = decode_array<SavedPropertyOverride>(
        d, overrides, "/propertyOverrides",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedPropertyOverride> {
            if (!d.object(value, pointer, {"owner", "property", "value"}))
                return std::nullopt;
            const auto* owner = d.member(value, "owner", pointer);
            const auto* property = d.member(value, "property", pointer);
            const auto* saved = d.member(value, "value", pointer);
            auto owner_ref =
                owner ? decode_owner(d, *owner, child(pointer, "owner")) : std::nullopt;
            auto property_id =
                property ? d.id<PropertyId>(*property, child(pointer, "property")) : std::nullopt;
            auto runtime = saved ? decode_value(d, *saved, child(pointer, "value")) : std::nullopt;
            return owner_ref && property_id && runtime
                       ? std::optional<SavedPropertyOverride>(SavedPropertyOverride{
                             std::move(*owner_ref), std::move(*property_id), std::move(*runtime)})
                       : std::nullopt;
        });
    auto saved_interactables = decode_array<InteractableState>(
        d, interactables, "/interactables",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<InteractableState> {
            if (!d.object(value, pointer, {"id", "location", "enabled", "visible"}))
                return std::nullopt;
            const auto* id = d.member(value, "id", pointer);
            const auto* location = d.member(value, "location", pointer);
            const auto* enabled = d.member(value, "enabled", pointer);
            const auto* visible = d.member(value, "visible", pointer);
            auto interactable = id ? d.id<InteractableId>(*id, child(pointer, "id")) : std::nullopt;
            auto saved_location =
                location ? decode_location(d, *location, child(pointer, "location")) : std::nullopt;
            auto saved_enabled =
                enabled ? d.boolean(*enabled, child(pointer, "enabled")) : std::nullopt;
            auto saved_visible =
                visible ? d.boolean(*visible, child(pointer, "visible")) : std::nullopt;
            return interactable && saved_location && saved_enabled && saved_visible
                       ? std::optional<InteractableState>(
                             InteractableState{std::move(*interactable), std::move(*saved_location),
                                               *saved_enabled, *saved_visible})
                       : std::nullopt;
        });
    auto saved_room_visits = decode_array<SavedRoomVisits>(
        d, room_visits, "/roomVisits",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedRoomVisits> {
            if (!d.object(value, pointer, {"room", "count"}))
                return std::nullopt;
            const auto* room = d.member(value, "room", pointer);
            const auto* count = d.member(value, "count", pointer);
            auto room_id = room ? d.id<RoomId>(*room, child(pointer, "room")) : std::nullopt;
            auto visits = count ? d.unsigned_integer<std::uint64_t>(*count, child(pointer, "count"))
                                : std::nullopt;
            return room_id && visits ? std::optional<SavedRoomVisits>(
                                           SavedRoomVisits{std::move(*room_id), *visits})
                                     : std::nullopt;
        });
    auto saved_line_history = decode_array<SavedDialogueLineHistory>(
        d, line_history, "/dialogueLineHistory",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedDialogueLineHistory> {
            if (!d.object(value, pointer, {"dialogue", "segment", "count"}))
                return std::nullopt;
            const auto* dialogue = d.member(value, "dialogue", pointer);
            const auto* segment = d.member(value, "segment", pointer);
            const auto* count = d.member(value, "count", pointer);
            auto dialogue_id =
                dialogue ? d.id<DialogueId>(*dialogue, child(pointer, "dialogue")) : std::nullopt;
            auto segment_id = segment ? d.id<DialogueSegmentId>(*segment, child(pointer, "segment"))
                                      : std::nullopt;
            auto visits = count ? d.unsigned_integer<std::uint64_t>(*count, child(pointer, "count"))
                                : std::nullopt;
            return dialogue_id && segment_id && visits
                       ? std::optional<SavedDialogueLineHistory>(SavedDialogueLineHistory{
                             {std::move(*dialogue_id), std::move(*segment_id)}, *visits})
                       : std::nullopt;
        });
    auto saved_choice_history = decode_array<SavedDialogueChoiceHistory>(
        d, choice_history, "/dialogueChoiceHistory",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedDialogueChoiceHistory> {
            if (!d.object(value, pointer, {"dialogue", "edge", "count"}))
                return std::nullopt;
            const auto* dialogue = d.member(value, "dialogue", pointer);
            const auto* edge = d.member(value, "edge", pointer);
            const auto* count = d.member(value, "count", pointer);
            auto dialogue_id =
                dialogue ? d.id<DialogueId>(*dialogue, child(pointer, "dialogue")) : std::nullopt;
            auto edge_id =
                edge ? d.id<DialogueEdgeId>(*edge, child(pointer, "edge")) : std::nullopt;
            auto visits = count ? d.unsigned_integer<std::uint64_t>(*count, child(pointer, "count"))
                                : std::nullopt;
            return dialogue_id && edge_id && visits
                       ? std::optional<SavedDialogueChoiceHistory>(SavedDialogueChoiceHistory{
                             {std::move(*dialogue_id), std::move(*edge_id)}, *visits})
                       : std::nullopt;
        });
    auto saved_log = decode_array<TextLogEntry>(
        d, text_log, "/textLog", [&d](const nlohmann::json& value, const std::string& pointer) {
            return decode_text_log(d, value, pointer);
        });
    auto saved_timers = decode_array<SavedLogicalTimer>(
        d, timers, "/logicalTimers",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedLogicalTimer> {
            if (!d.object(value, pointer, {"id", "remainingMs", "repeatMs"}))
                return std::nullopt;
            const auto* id = d.member(value, "id", pointer);
            const auto* remaining = d.member(value, "remainingMs", pointer);
            const auto* repeat = d.member(value, "repeatMs", pointer);
            auto timer_id = id ? d.unsigned_integer<std::uint64_t>(*id, child(pointer, "id"), true)
                               : std::nullopt;
            auto duration =
                remaining
                    ? d.unsigned_integer<std::uint64_t>(*remaining, child(pointer, "remainingMs"))
                    : std::nullopt;
            std::optional<std::chrono::milliseconds> interval;
            if (repeat && !repeat->is_null()) {
                auto count =
                    d.unsigned_integer<std::uint64_t>(*repeat, child(pointer, "repeatMs"), true);
                if (count &&
                    *count <= static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()))
                    interval = std::chrono::milliseconds(*count);
                else if (count)
                    d.error(k_value, "Repeat interval is outside the supported range.",
                            child(pointer, "repeatMs"));
            }
            if (!timer_id || !duration ||
                *duration > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
                if (duration)
                    d.error(k_value, "Timer duration is outside the supported range.",
                            child(pointer, "remainingMs"));
                return std::nullopt;
            }
            return SavedLogicalTimer{{*timer_id}, std::chrono::milliseconds(*duration), interval};
        });
    auto saved_completions = decode_array<SavedLogicalTimerCompletion>(
        d, completions, "/pendingTimerCompletions",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedLogicalTimerCompletion> {
            if (!d.object(value, pointer, {"id", "occurrences"}))
                return std::nullopt;
            const auto* id = d.member(value, "id", pointer);
            const auto* occurrences = d.member(value, "occurrences", pointer);
            auto timer_id = id ? d.unsigned_integer<std::uint64_t>(*id, child(pointer, "id"), true)
                               : std::nullopt;
            auto count = occurrences ? d.unsigned_integer<std::uint64_t>(
                                           *occurrences, child(pointer, "occurrences"), true)
                                     : std::nullopt;
            return timer_id && count ? std::optional<SavedLogicalTimerCompletion>(
                                           SavedLogicalTimerCompletion{{*timer_id}, *count})
                                     : std::nullopt;
        });
    auto saved_mode = mode ? decode_mode(d, *mode, "/mode") : std::nullopt;
    auto saved_frames = decode_array<SavedFlowFrame>(
        d, frames, "/flowStack", [&d](const nlohmann::json& value, const std::string& pointer) {
            return decode_frame(d, value, pointer);
        });
    auto saved_blocker = blocker ? decode_blocker(d, *blocker, "/blocker") : std::nullopt;
    if (d.failed() || !saved_metadata || !milliseconds || !saved_variables || !saved_overrides ||
        !saved_interactables || !saved_room_visits || !saved_line_history ||
        !saved_choice_history || !saved_log || !saved_timers || !saved_completions || !saved_mode ||
        !saved_frames || !saved_blocker)
        return Result<SaveState, Diagnostics>::failure(d.take());
    return Result<SaveState, Diagnostics>::success(
        SaveState{std::move(*saved_metadata), std::chrono::milliseconds(*milliseconds),
                  std::move(*saved_variables), std::move(*saved_overrides),
                  std::move(*saved_interactables), std::move(*saved_room_visits),
                  std::move(*saved_line_history), std::move(*saved_choice_history),
                  std::move(*saved_log), std::move(*saved_timers), std::move(*saved_completions),
                  std::move(*saved_mode), std::move(*saved_frames), std::move(*saved_blocker)});
}

Result<SaveState, Diagnostics> decode_save_state_impl(const CompiledProject& project,
                                                      const nlohmann::json& document,
                                                      std::string source_path)
{
    auto decoded = decode_save_state_wire_impl(document, source_path);
    if (!decoded)
        return decoded;
    const auto* save = decoded.value_if();
    auto validation = validate_save_state_impl(project, *save, std::move(source_path));
    return validation ? decoded : Result<SaveState, Diagnostics>::failure(validation.error());
}

} // namespace noveltea::core::save_state_codec
