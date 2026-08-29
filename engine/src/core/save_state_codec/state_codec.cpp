#include "internal.hpp"

namespace noveltea::core::save_state_codec {
namespace {

nlohmann::json encode_character_location(const CharacterWorldLocation& location)
{
    return std::visit(
        [](const auto& item) -> nlohmann::json {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, compiled::UnplacedLocation>)
                return {{"kind", "unplaced"}};
            else
                return {{"kind", "room"}, {"room", item.room.text()}};
        },
        location);
}

std::optional<CharacterWorldLocation>
decode_character_location(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a Character location object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    if (*name == "unplaced") {
        d.object(value, pointer, {"kind"});
        return compiled::UnplacedLocation{};
    }
    if (*name == "room") {
        d.object(value, pointer, {"kind", "room"});
        const auto* room = d.member(value, "room", pointer);
        auto room_id = room ? d.id<RoomId>(*room, child(pointer, "room")) : std::nullopt;
        if (room_id)
            return compiled::RoomLocation{std::move(*room_id)};
        return std::nullopt;
    }
    d.error(k_variant, "Unknown Character location kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

std::string_view room_entry_cause_name(RoomEntryCause cause) noexcept
{
    switch (cause) {
    case RoomEntryCause::Entrypoint:
        return "entrypoint";
    case RoomEntryCause::NavigationAttempt:
        return "navigation-attempt";
    case RoomEntryCause::DirectedRoomChange:
        return "directed-room-change";
    }
    return "directed-room-change";
}

std::string_view execution_relationship_name(ExecutionRelationship relationship) noexcept
{
    switch (relationship) {
    case ExecutionRelationship::Root:
        return "root";
    case ExecutionRelationship::Call:
        return "call";
    case ExecutionRelationship::Continue:
        return "continue";
    case ExecutionRelationship::Detached:
        return "detached";
    case ExecutionRelationship::Interaction:
        return "interaction";
    case ExecutionRelationship::Navigation:
        return "navigation";
    }
    return "root";
}

std::optional<ExecutionRelationship>
decode_execution_relationship(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    auto name = d.string(value, pointer);
    if (!name)
        return std::nullopt;
    if (*name == "root")
        return ExecutionRelationship::Root;
    if (*name == "call")
        return ExecutionRelationship::Call;
    if (*name == "continue")
        return ExecutionRelationship::Continue;
    if (*name == "detached")
        return ExecutionRelationship::Detached;
    if (*name == "interaction")
        return ExecutionRelationship::Interaction;
    if (*name == "navigation")
        return ExecutionRelationship::Navigation;
    d.error(k_variant, "Unknown Execution Provenance relationship.", std::string(pointer));
    return std::nullopt;
}

std::string_view execution_state_name(ExecutionState state) noexcept
{
    switch (state) {
    case ExecutionState::Running:
        return "running";
    case ExecutionState::Waiting:
        return "waiting";
    case ExecutionState::Suspended:
        return "suspended";
    case ExecutionState::Completed:
        return "completed";
    case ExecutionState::Cancelled:
        return "cancelled";
    case ExecutionState::Failed:
        return "failed";
    }
    return "running";
}

std::optional<ExecutionState> decode_execution_state(Decoder& d, const nlohmann::json& value,
                                                     std::string_view pointer)
{
    auto name = d.string(value, pointer);
    if (!name)
        return std::nullopt;
    if (*name == "running")
        return ExecutionState::Running;
    if (*name == "waiting")
        return ExecutionState::Waiting;
    if (*name == "suspended")
        return ExecutionState::Suspended;
    if (*name == "completed")
        return ExecutionState::Completed;
    if (*name == "cancelled")
        return ExecutionState::Cancelled;
    if (*name == "failed")
        return ExecutionState::Failed;
    d.error(k_variant, "Unknown Execution Provenance state.", std::string(pointer));
    return std::nullopt;
}

nlohmann::json encode_room_visit(const std::optional<RoomVisitContext>& visit)
{
    if (!visit)
        return nullptr;
    nlohmann::json entry_exit = nullptr;
    if (visit->entry_exit)
        entry_exit = {{"room", visit->entry_exit->room.text()},
                      {"exit", visit->entry_exit->exit_id.text()}};
    return {{"room", visit->room.text()},
            {"sourceRoom", visit->source_room ? nlohmann::json(visit->source_room->text())
                                              : nlohmann::json(nullptr)},
            {"entryExit", std::move(entry_exit)},
            {"entryCause", room_entry_cause_name(visit->entry_cause)},
            {"entrySequence", visit->entry_sequence},
            {"visitIndex", visit->visit_index}};
}

nlohmann::json encode_gameplay_instance_ref(const GameplayInstanceRef& value)
{
    return std::visit(
        [](const auto& id) -> nlohmann::json {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return {{"kind", "room"}, {"id", id.text()}};
            else if constexpr (std::is_same_v<T, CharacterId>)
                return {{"kind", "character"}, {"id", id.text()}};
            else
                return {{"kind", "interactable"}, {"id", id.text()}};
        },
        value);
}

std::optional<GameplayInstanceRef>
decode_gameplay_instance_ref(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer, {"id", "kind"}))
        return std::nullopt;
    const auto* kind = d.member(value, "kind", pointer);
    const auto* id = d.member(value, "id", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name || !id)
        return std::nullopt;
    if (*name == "room") {
        auto decoded = d.id<RoomId>(*id, child(pointer, "id"));
        return decoded ? std::optional<GameplayInstanceRef>{std::move(*decoded)} : std::nullopt;
    }
    if (*name == "character") {
        auto decoded = d.id<CharacterId>(*id, child(pointer, "id"));
        return decoded ? std::optional<GameplayInstanceRef>{std::move(*decoded)} : std::nullopt;
    }
    if (*name == "interactable") {
        auto decoded = d.id<InteractableInstanceId>(*id, child(pointer, "id"));
        return decoded ? std::optional<GameplayInstanceRef>{std::move(*decoded)} : std::nullopt;
    }
    d.error(k_variant, "Unknown Gameplay Instance reference kind.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_configuration_source(const RuntimeConfigurationSource& source)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CompiledRoomConfigurationSource>)
                return {{"kind", "room-definition"}, {"id", value.room.text()}};
            else if constexpr (std::is_same_v<T, CompiledCharacterConfigurationSource>)
                return {{"kind", "character-definition"}, {"id", value.character.text()}};
            else if constexpr (std::is_same_v<T, CompiledInteractableConfigurationSource>)
                return {{"kind", "interactable-definition"}, {"id", value.definition.text()}};
            else
                return {{"kind", "archetype"}, {"id", value.archetype.text()}};
        },
        source);
}

std::optional<RuntimeConfigurationSource>
decode_configuration_source(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer, {"id", "kind"}))
        return std::nullopt;
    const auto* kind = d.member(value, "kind", pointer);
    const auto* id = d.member(value, "id", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name || !id)
        return std::nullopt;
    if (*name == "room-definition") {
        auto decoded = d.id<RoomId>(*id, child(pointer, "id"));
        return decoded ? std::optional<RuntimeConfigurationSource>{CompiledRoomConfigurationSource{
                             std::move(*decoded)}}
                       : std::nullopt;
    }
    if (*name == "character-definition") {
        auto decoded = d.id<CharacterId>(*id, child(pointer, "id"));
        return decoded
                   ? std::optional<RuntimeConfigurationSource>{CompiledCharacterConfigurationSource{
                         std::move(*decoded)}}
                   : std::nullopt;
    }
    if (*name == "interactable-definition") {
        auto decoded = d.id<InteractableDefinitionId>(*id, child(pointer, "id"));
        return decoded ? std::optional<
                             RuntimeConfigurationSource>{CompiledInteractableConfigurationSource{
                             std::move(*decoded)}}
                       : std::nullopt;
    }
    if (*name == "archetype") {
        auto decoded = d.id<ArchetypeId>(*id, child(pointer, "id"));
        return decoded ? std::optional<RuntimeConfigurationSource>{ArchetypeConfigurationSource{
                             std::move(*decoded)}}
                       : std::nullopt;
    }
    d.error(k_variant, "Unknown runtime configuration source kind.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_provenance(const RuntimeInstanceProvenance& provenance)
{
    std::string kind = "declared";
    switch (provenance.kind) {
    case RuntimeInstanceProvenanceKind::Declared:
        kind = "declared";
        break;
    case RuntimeInstanceProvenanceKind::Archetype:
        kind = "archetype";
        break;
    case RuntimeInstanceProvenanceKind::CompiledDefinition:
        kind = "compiled-definition";
        break;
    case RuntimeInstanceProvenanceKind::Clone:
        kind = "clone";
        break;
    }
    return {{"kind", std::move(kind)},
            {"archetype", provenance.archetype ? nlohmann::json(provenance.archetype->text())
                                               : nlohmann::json(nullptr)},
            {"source", provenance.source_instance
                           ? encode_gameplay_instance_ref(*provenance.source_instance)
                           : nlohmann::json(nullptr)}};
}

std::optional<std::vector<RuntimeRoomExitTargetOverride>>
decode_room_exit_targets(Decoder& d, const nlohmann::json* value, std::string_view pointer)
{
    if (!value || !value->is_array()) {
        d.error(k_type, "Expected an array.", std::string(pointer));
        return std::nullopt;
    }
    std::vector<RuntimeRoomExitTargetOverride> result;
    result.reserve(value->size());
    for (std::size_t item = 0; item < value->size(); ++item) {
        const auto* edit = json_access::element(*value, item);
        const auto edit_pointer = index(pointer, item);
        if (!edit || !d.object(*edit, edit_pointer, {"exit", "target"}))
            continue;
        const auto* exit_value = d.member(*edit, "exit", edit_pointer);
        const auto* target_value = d.member(*edit, "target", edit_pointer);
        auto exit =
            exit_value ? d.id<RoomExitId>(*exit_value, child(edit_pointer, "exit")) : std::nullopt;
        auto target = target_value ? d.id<RoomId>(*target_value, child(edit_pointer, "target"))
                                   : std::nullopt;
        if (exit && target)
            result.push_back(RuntimeRoomExitTargetOverride{std::move(*exit), std::move(*target)});
    }
    return result;
}

std::optional<RuntimeInstanceProvenance> decode_provenance(Decoder& d, const nlohmann::json& value,
                                                           std::string_view pointer)
{
    if (!d.object(value, pointer, {"archetype", "kind", "source"}))
        return std::nullopt;
    const auto* kind = d.member(value, "kind", pointer);
    const auto* archetype = d.member(value, "archetype", pointer);
    const auto* source = d.member(value, "source", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name || archetype == nullptr || source == nullptr)
        return std::nullopt;
    RuntimeInstanceProvenanceKind provenance_kind;
    if (*name == "declared")
        provenance_kind = RuntimeInstanceProvenanceKind::Declared;
    else if (*name == "archetype")
        provenance_kind = RuntimeInstanceProvenanceKind::Archetype;
    else if (*name == "compiled-definition")
        provenance_kind = RuntimeInstanceProvenanceKind::CompiledDefinition;
    else if (*name == "clone")
        provenance_kind = RuntimeInstanceProvenanceKind::Clone;
    else {
        d.error(k_variant, "Unknown runtime provenance kind.", child(pointer, "kind"));
        return std::nullopt;
    }
    std::optional<ArchetypeId> saved_archetype;
    if (!archetype->is_null()) {
        auto decoded = d.id<ArchetypeId>(*archetype, child(pointer, "archetype"));
        if (!decoded)
            return std::nullopt;
        saved_archetype = std::move(*decoded);
    }
    std::optional<GameplayInstanceRef> saved_source;
    if (!source->is_null()) {
        auto decoded = decode_gameplay_instance_ref(d, *source, child(pointer, "source"));
        if (!decoded)
            return std::nullopt;
        saved_source = std::move(*decoded);
    }
    return RuntimeInstanceProvenance{provenance_kind, std::move(saved_archetype),
                                     std::move(saved_source)};
}

std::optional<RoomEntryCause> decode_room_entry_cause(Decoder& d, const nlohmann::json& value,
                                                      std::string_view pointer)
{
    auto name = d.string(value, pointer);
    if (!name)
        return std::nullopt;
    if (*name == "entrypoint")
        return RoomEntryCause::Entrypoint;
    if (*name == "navigation-attempt")
        return RoomEntryCause::NavigationAttempt;
    if (*name == "directed-room-change")
        return RoomEntryCause::DirectedRoomChange;
    d.error(k_variant, "Unknown Room entry cause '" + *name + "'.", std::string(pointer));
    return std::nullopt;
}

std::optional<std::optional<RoomVisitContext>>
decode_room_visit(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<RoomVisitContext>{};
    if (!d.object(value, pointer,
                  {"room", "sourceRoom", "entryExit", "entryCause", "entrySequence", "visitIndex"}))
        return std::nullopt;
    const auto* room = d.member(value, "room", pointer);
    const auto* source = d.member(value, "sourceRoom", pointer);
    const auto* entry = d.member(value, "entryExit", pointer);
    const auto* cause_value = d.member(value, "entryCause", pointer);
    const auto* sequence_value = d.member(value, "entrySequence", pointer);
    const auto* index_value = d.member(value, "visitIndex", pointer);
    auto room_id = room ? d.id<RoomId>(*room, child(pointer, "room")) : std::nullopt;
    std::optional<RoomId> source_room;
    bool source_ok = source != nullptr;
    if (source && !source->is_null()) {
        auto decoded = d.id<RoomId>(*source, child(pointer, "sourceRoom"));
        source_ok = decoded.has_value();
        if (decoded)
            source_room = std::move(*decoded);
    }
    std::optional<compiled::RoomExitRef> entry_exit;
    bool entry_ok = entry != nullptr;
    if (entry && !entry->is_null() &&
        d.object(*entry, child(pointer, "entryExit"), {"room", "exit"})) {
        const auto entry_pointer = child(pointer, "entryExit");
        const auto* exit_room = d.member(*entry, "room", entry_pointer);
        const auto* exit = d.member(*entry, "exit", entry_pointer);
        auto exit_room_id =
            exit_room ? d.id<RoomId>(*exit_room, child(entry_pointer, "room")) : std::nullopt;
        auto exit_id = exit ? d.id<RoomExitId>(*exit, child(entry_pointer, "exit")) : std::nullopt;
        entry_ok = exit_room_id.has_value() && exit_id.has_value();
        if (entry_ok)
            entry_exit = compiled::RoomExitRef{std::move(*exit_room_id), std::move(*exit_id)};
    }
    auto cause = cause_value
                     ? decode_room_entry_cause(d, *cause_value, child(pointer, "entryCause"))
                     : std::nullopt;
    auto entry_sequence =
        sequence_value ? d.unsigned_integer<std::uint64_t>(*sequence_value,
                                                           child(pointer, "entrySequence"), true)
                       : std::nullopt;
    auto visit_index =
        index_value
            ? d.unsigned_integer<std::uint64_t>(*index_value, child(pointer, "visitIndex"), true)
            : std::nullopt;
    if (!room_id || !source_ok || !entry_ok || !cause || !entry_sequence || !visit_index)
        return std::nullopt;
    return std::optional<RoomVisitContext>{
        RoomVisitContext{std::move(*room_id), std::move(source_room), std::move(entry_exit), *cause,
                         *entry_sequence, *visit_index}};
}

} // namespace

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
    nlohmann::json overrides = nlohmann::json::array();
    for (const auto& value : save.property_overrides)
        overrides.push_back({{"target", encode_property_target(value.target)},
                             {"property", value.property.text()},
                             {"value", encode_value(value.value)}});
    nlohmann::json interactables = nlohmann::json::array();
    for (const auto& value : save.interactables) {
        nlohmann::json dynamic_room_occurrence = nullptr;
        if (value.dynamic_room_occurrence)
            dynamic_room_occurrence = {
                {"room", value.dynamic_room_occurrence->room.text()},
                {"placement", value.dynamic_room_occurrence->placement.text()}};
        interactables.push_back({{"id", value.interactable.text()},
                                 {"location", encode_location(value.location)},
                                 {"enabled", value.enabled},
                                 {"visible", value.visible},
                                 {"quantity", value.quantity},
                                 {"dynamicRoomOccurrence", std::move(dynamic_room_occurrence)}});
    }
    nlohmann::json characters = nlohmann::json::array();
    for (const auto& value : save.characters)
        characters.push_back({{"id", value.character.text()},
                              {"location", encode_character_location(value.location)},
                              {"enabled", value.enabled},
                              {"visible", value.visible}});
    nlohmann::json item_stacks = nlohmann::json::array();
    for (const auto& value : save.item_stacks) {
        nlohmann::json traits = nlohmann::json::array();
        for (const auto& trait : value.traits)
            traits.push_back(trait.text());
        item_stacks.push_back({{"id", value.id.text()},
                               {"definition", value.definition.text()},
                               {"quantity", value.quantity},
                               {"location", encode_location(value.location)},
                               {"traits", std::move(traits)},
                               {"declared", value.declared}});
    }

    nlohmann::json runtime_rooms = nlohmann::json::array();
    for (const auto& value : save.runtime_rooms) {
        nlohmann::json birth_exit_targets = nlohmann::json::array();
        for (const auto& edit : value.birth_exit_target_overrides)
            birth_exit_targets.push_back(
                {{"exit", edit.exit.text()}, {"target", edit.target.text()}});
        nlohmann::json structural_exit_targets = nlohmann::json::array();
        for (const auto& edit : value.structural_override_exit_target_overrides)
            structural_exit_targets.push_back(
                {{"exit", edit.exit.text()}, {"target", edit.target.text()}});
        nlohmann::json exit_targets = nlohmann::json::array();
        for (const auto& edit : value.exit_target_overrides)
            exit_targets.push_back({{"exit", edit.exit.text()}, {"target", edit.target.text()}});
        runtime_rooms.push_back(
            {{"id", value.id.text()},
             {"declared", value.declared},
             {"birthSource", encode_configuration_source(value.birth_source)},
             {"structuralOverrideSource",
              value.structural_override_source
                  ? encode_configuration_source(*value.structural_override_source)
                  : nlohmann::json(nullptr)},
             {"provenance", encode_provenance(value.provenance)},
             {"birthExitTargetOverrides", std::move(birth_exit_targets)},
             {"structuralOverrideExitTargetOverrides", std::move(structural_exit_targets)},
             {"exitTargetOverrides", std::move(exit_targets)}});
    }
    nlohmann::json runtime_characters = nlohmann::json::array();
    for (const auto& value : save.runtime_characters)
        runtime_characters.push_back(
            {{"id", value.id.text()},
             {"declared", value.declared},
             {"birthSource", encode_configuration_source(value.birth_source)},
             {"structuralOverrideSource",
              value.structural_override_source
                  ? encode_configuration_source(*value.structural_override_source)
                  : nlohmann::json(nullptr)},
             {"provenance", encode_provenance(value.provenance)}});
    nlohmann::json runtime_interactables = nlohmann::json::array();
    for (const auto& value : save.runtime_interactables)
        runtime_interactables.push_back(
            {{"id", value.id.text()},
             {"declared", value.declared},
             {"birthSource", encode_configuration_source(value.birth_source)},
             {"structuralOverrideSource",
              value.structural_override_source
                  ? encode_configuration_source(*value.structural_override_source)
                  : nlohmann::json(nullptr)},
             {"provenance", encode_provenance(value.provenance)}});
    nlohmann::json runtime_world = {{"nextInstanceId", save.next_runtime_instance_id},
                                    {"nextItemStackId", save.next_item_stack_id},
                                    {"roomEntrySequence", save.room_entry_sequence},
                                    {"rooms", std::move(runtime_rooms)},
                                    {"characters", std::move(runtime_characters)},
                                    {"interactables", std::move(runtime_interactables)}};

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
    nlohmann::json detached_flows = nlohmann::json::array();
    for (const auto& value : save.detached_flows) {
        nlohmann::json detached_frames = nlohmann::json::array();
        for (const auto& frame : value.flow_stack)
            detached_frames.push_back(encode_frame(frame));
        const char* owner = value.owner == compiled::DetachedSceneOwner::Flow ? "flow"
                            : value.owner == compiled::DetachedSceneOwner::ActiveRoom
                                ? "active-room"
                                : "runtime-session";
        detached_flows.push_back(
            {{"owner", owner},
             {"flowOwner",
              value.flow_owner ? nlohmann::json(value.flow_owner->value) : nlohmann::json(nullptr)},
             {"roomEntrySequence", value.room_entry_sequence},
             {"flowStack", std::move(detached_frames)},
             {"blocker", encode_blocker(value.blocker)}});
    }
    nlohmann::json execution_provenance = nlohmann::json::array();
    for (const auto& value : save.execution_provenance) {
        execution_provenance.push_back(
            {{"id", value.id},
             {"activeFrame", value.active_frame ? nlohmann::json(value.active_frame->value)
                                                : nlohmann::json(nullptr)},
             {"parent", value.parent ? nlohmann::json(*value.parent) : nlohmann::json(nullptr)},
             {"root", value.root},
             {"relationship", execution_relationship_name(value.relationship)},
             {"source", value.source ? nlohmann::json(*value.source) : nlohmann::json(nullptr)},
             {"state", execution_state_name(value.state)}});
    }
    return Result<nlohmann::json, Diagnostics>::success(
        {{"schema", std::string(k_schema)},
         {"metadata",
          {{"project", save.metadata.project.text()},
           {"projectVersion", save.metadata.project_version},
           {"saveContract", save.metadata.save_contract}}},
         {"playTimeMs", save.play_time.count()},
         {"randomState", save.random_state},
         {"runtimeWorld", std::move(runtime_world)},
         {"propertyOverrides", std::move(overrides)},
         {"characters", std::move(characters)},
         {"interactables", std::move(interactables)},
         {"itemStacks", std::move(item_stacks)},
         {"activeRoomVisit", encode_room_visit(save.active_room_visit)},
         {"roomVisits", std::move(room_visits)},
         {"dialogueLineHistory", std::move(line_history)},
         {"dialogueChoiceHistory", std::move(choice_history)},
         {"textLog", std::move(log)},
         {"logicalTimers", std::move(timers)},
         {"pendingTimerCompletions", std::move(completions)},
         {"presentation", encode_presentation_records(save)},
         {"mode", encode_mode(save.mode)},
         {"flowStack", std::move(frames)},
         {"blocker", encode_blocker(save.blocker)},
         {"detachedFlows", std::move(detached_flows)},
         {"executionProvenance", std::move(execution_provenance)}});
}

Result<SaveState, Diagnostics> decode_save_state_wire_impl(const nlohmann::json& document,
                                                           std::string source_path)
{
    Decoder d(std::move(source_path));
    d.object(document, "",
             {"schema",
              "metadata",
              "playTimeMs",
              "randomState",
              "runtimeWorld",
              "propertyOverrides",
              "characters",
              "interactables",
              "itemStacks",
              "activeRoomVisit",
              "roomVisits",
              "dialogueLineHistory",
              "dialogueChoiceHistory",
              "textLog",
              "logicalTimers",
              "pendingTimerCompletions",
              "presentation",
              "mode",
              "flowStack",
              "blocker",
              "detachedFlows",
              "executionProvenance"});
    const auto* schema = d.member(document, "schema", "");
    const auto* metadata = d.member(document, "metadata", "");
    const auto* play_time = d.member(document, "playTimeMs", "");
    const auto* random_state = d.member(document, "randomState", "");
    const auto* runtime_world = d.member(document, "runtimeWorld", "");
    const auto* overrides = d.member(document, "propertyOverrides", "");
    const auto* characters = d.member(document, "characters", "");
    const auto* interactables = d.member(document, "interactables", "");
    const auto* item_stacks = d.member(document, "itemStacks", "");
    const auto* active_room_visit = d.member(document, "activeRoomVisit", "");
    const auto* room_visits = d.member(document, "roomVisits", "");
    const auto* line_history = d.member(document, "dialogueLineHistory", "");
    const auto* choice_history = d.member(document, "dialogueChoiceHistory", "");
    const auto* text_log = d.member(document, "textLog", "");
    const auto* timers = d.member(document, "logicalTimers", "");
    const auto* completions = d.member(document, "pendingTimerCompletions", "");
    const auto* presentation = d.member(document, "presentation", "");
    const auto* mode = d.member(document, "mode", "");
    const auto* frames = d.member(document, "flowStack", "");
    const auto* blocker = d.member(document, "blocker", "");
    const auto* detached_flows = d.member(document, "detachedFlows", "");
    const auto* execution_provenance = d.member(document, "executionProvenance", "");
    auto schema_name = schema ? d.string(*schema, "/schema") : std::nullopt;
    if (schema_name && *schema_name != k_schema)
        d.error(k_value, "Unsupported save schema.", "/schema");
    std::optional<SaveStateMetadata> saved_metadata;
    if (metadata &&
        d.object(*metadata, "/metadata", {"project", "projectVersion", "saveContract"})) {
        const auto* project = d.member(*metadata, "project", "/metadata");
        const auto* project_version = d.member(*metadata, "projectVersion", "/metadata");
        const auto* save_contract = d.member(*metadata, "saveContract", "/metadata");
        auto project_id = project ? d.id<ProjectId>(*project, "/metadata/project") : std::nullopt;
        auto saved_version =
            project_version ? d.string(*project_version, "/metadata/projectVersion") : std::nullopt;
        auto saved_contract =
            save_contract ? d.string(*save_contract, "/metadata/saveContract") : std::nullopt;
        if (project_id && saved_version && saved_contract)
            saved_metadata = SaveStateMetadata{.project = std::move(*project_id),
                                               .project_version = std::move(*saved_version),
                                               .save_contract = std::move(*saved_contract)};
    }
    auto milliseconds =
        play_time ? d.unsigned_integer<std::uint64_t>(*play_time, "/playTimeMs") : std::nullopt;
    auto saved_random_state = random_state
                                  ? d.unsigned_integer<std::uint64_t>(*random_state, "/randomState")
                                  : std::nullopt;

    std::optional<std::uint64_t> saved_next_runtime_instance_id;
    std::optional<std::uint64_t> saved_next_item_stack_id;
    std::optional<std::uint64_t> saved_room_entry_sequence;
    std::optional<std::vector<SavedRuntimeRoomConfiguration>> saved_runtime_rooms;
    std::optional<std::vector<SavedRuntimeCharacterConfiguration>> saved_runtime_characters;
    std::optional<std::vector<SavedRuntimeInteractableConfiguration>> saved_runtime_interactables;
    if (runtime_world && d.object(*runtime_world, "/runtimeWorld",
                                  {"nextInstanceId", "nextItemStackId", "roomEntrySequence",
                                   "rooms", "characters", "interactables"})) {
        const auto* next_id = d.member(*runtime_world, "nextInstanceId", "/runtimeWorld");
        const auto* rooms = d.member(*runtime_world, "rooms", "/runtimeWorld");
        const auto* characters_value = d.member(*runtime_world, "characters", "/runtimeWorld");
        const auto* interactables_value =
            d.member(*runtime_world, "interactables", "/runtimeWorld");
        const auto* next_item_stack_id =
            d.member(*runtime_world, "nextItemStackId", "/runtimeWorld");
        const auto* room_entry_sequence =
            d.member(*runtime_world, "roomEntrySequence", "/runtimeWorld");
        saved_next_runtime_instance_id =
            next_id
                ? d.unsigned_integer<std::uint64_t>(*next_id, "/runtimeWorld/nextInstanceId", true)
                : std::nullopt;
        saved_next_item_stack_id =
            next_item_stack_id ? d.unsigned_integer<std::uint64_t>(
                                     *next_item_stack_id, "/runtimeWorld/nextItemStackId", true)
                               : std::nullopt;
        saved_room_entry_sequence =
            room_entry_sequence ? d.unsigned_integer<std::uint64_t>(
                                      *room_entry_sequence, "/runtimeWorld/roomEntrySequence")
                                : std::nullopt;
        saved_runtime_rooms = decode_array<SavedRuntimeRoomConfiguration>(
            d, rooms, "/runtimeWorld/rooms",
            [&d](const nlohmann::json& value,
                 const std::string& pointer) -> std::optional<SavedRuntimeRoomConfiguration> {
                if (!d.object(value, pointer,
                              {"id", "declared", "birthSource", "structuralOverrideSource",
                               "provenance", "birthExitTargetOverrides",
                               "structuralOverrideExitTargetOverrides", "exitTargetOverrides"}))
                    return std::nullopt;
                const auto* id_value = d.member(value, "id", pointer);
                const auto* declared_value = d.member(value, "declared", pointer);
                const auto* birth_value = d.member(value, "birthSource", pointer);
                const auto* override_value = d.member(value, "structuralOverrideSource", pointer);
                const auto* provenance_value = d.member(value, "provenance", pointer);
                const auto* birth_edits_value =
                    d.member(value, "birthExitTargetOverrides", pointer);
                const auto* structural_edits_value =
                    d.member(value, "structuralOverrideExitTargetOverrides", pointer);
                const auto* edits_value = d.member(value, "exitTargetOverrides", pointer);
                auto id = id_value ? d.id<RoomId>(*id_value, child(pointer, "id")) : std::nullopt;
                auto declared = declared_value
                                    ? d.boolean(*declared_value, child(pointer, "declared"))
                                    : std::nullopt;
                auto birth = birth_value ? decode_configuration_source(
                                               d, *birth_value, child(pointer, "birthSource"))
                                         : std::nullopt;
                std::optional<RuntimeConfigurationSource> override_source;
                bool override_ok = override_value != nullptr;
                if (override_value && !override_value->is_null()) {
                    auto decoded = decode_configuration_source(
                        d, *override_value, child(pointer, "structuralOverrideSource"));
                    override_ok = decoded.has_value();
                    if (decoded)
                        override_source = std::move(*decoded);
                }
                auto provenance = provenance_value ? decode_provenance(d, *provenance_value,
                                                                       child(pointer, "provenance"))
                                                   : std::nullopt;
                auto birth_edits = decode_room_exit_targets(
                    d, birth_edits_value, child(pointer, "birthExitTargetOverrides"));
                auto structural_edits = decode_room_exit_targets(
                    d, structural_edits_value,
                    child(pointer, "structuralOverrideExitTargetOverrides"));
                auto edits =
                    decode_room_exit_targets(d, edits_value, child(pointer, "exitTargetOverrides"));
                return id && declared && birth && override_ok && provenance && birth_edits &&
                               structural_edits && edits
                           ? std::optional<SavedRuntimeRoomConfiguration>(
                                 SavedRuntimeRoomConfiguration{
                                     std::move(*id), *declared, std::move(*birth),
                                     std::move(override_source), std::move(*provenance),
                                     std::move(*birth_edits), std::move(*structural_edits),
                                     std::move(*edits)})
                           : std::nullopt;
            });
        saved_runtime_characters = decode_array<SavedRuntimeCharacterConfiguration>(
            d, characters_value, "/runtimeWorld/characters",
            [&d](const nlohmann::json& value,
                 const std::string& pointer) -> std::optional<SavedRuntimeCharacterConfiguration> {
                if (!d.object(value, pointer,
                              {"id", "declared", "birthSource", "structuralOverrideSource",
                               "provenance"}))
                    return std::nullopt;
                const auto* id_value = d.member(value, "id", pointer);
                const auto* declared_value = d.member(value, "declared", pointer);
                const auto* birth_value = d.member(value, "birthSource", pointer);
                const auto* override_value = d.member(value, "structuralOverrideSource", pointer);
                const auto* provenance_value = d.member(value, "provenance", pointer);
                auto id =
                    id_value ? d.id<CharacterId>(*id_value, child(pointer, "id")) : std::nullopt;
                auto declared = declared_value
                                    ? d.boolean(*declared_value, child(pointer, "declared"))
                                    : std::nullopt;
                auto birth = birth_value ? decode_configuration_source(
                                               d, *birth_value, child(pointer, "birthSource"))
                                         : std::nullopt;
                std::optional<RuntimeConfigurationSource> override_source;
                bool override_ok = override_value != nullptr;
                if (override_value && !override_value->is_null()) {
                    auto decoded = decode_configuration_source(
                        d, *override_value, child(pointer, "structuralOverrideSource"));
                    override_ok = decoded.has_value();
                    if (decoded)
                        override_source = std::move(*decoded);
                }
                auto provenance = provenance_value ? decode_provenance(d, *provenance_value,
                                                                       child(pointer, "provenance"))
                                                   : std::nullopt;
                return id && declared && birth && override_ok && provenance
                           ? std::optional<SavedRuntimeCharacterConfiguration>(
                                 SavedRuntimeCharacterConfiguration{
                                     std::move(*id), *declared, std::move(*birth),
                                     std::move(override_source), std::move(*provenance)})
                           : std::nullopt;
            });
        saved_runtime_interactables = decode_array<SavedRuntimeInteractableConfiguration>(
            d, interactables_value, "/runtimeWorld/interactables",
            [&d](const nlohmann::json& value, const std::string& pointer)
                -> std::optional<SavedRuntimeInteractableConfiguration> {
                if (!d.object(value, pointer,
                              {"id", "declared", "birthSource", "structuralOverrideSource",
                               "provenance"}))
                    return std::nullopt;
                const auto* id_value = d.member(value, "id", pointer);
                const auto* declared_value = d.member(value, "declared", pointer);
                const auto* birth_value = d.member(value, "birthSource", pointer);
                const auto* override_value = d.member(value, "structuralOverrideSource", pointer);
                const auto* provenance_value = d.member(value, "provenance", pointer);
                auto id = id_value ? d.id<InteractableInstanceId>(*id_value, child(pointer, "id"))
                                   : std::nullopt;
                auto declared = declared_value
                                    ? d.boolean(*declared_value, child(pointer, "declared"))
                                    : std::nullopt;
                auto birth = birth_value ? decode_configuration_source(
                                               d, *birth_value, child(pointer, "birthSource"))
                                         : std::nullopt;
                std::optional<RuntimeConfigurationSource> override_source;
                bool override_ok = override_value != nullptr;
                if (override_value && !override_value->is_null()) {
                    auto decoded = decode_configuration_source(
                        d, *override_value, child(pointer, "structuralOverrideSource"));
                    override_ok = decoded.has_value();
                    if (decoded)
                        override_source = std::move(*decoded);
                }
                auto provenance = provenance_value ? decode_provenance(d, *provenance_value,
                                                                       child(pointer, "provenance"))
                                                   : std::nullopt;
                return id && declared && birth && override_ok && provenance
                           ? std::optional<SavedRuntimeInteractableConfiguration>(
                                 SavedRuntimeInteractableConfiguration{
                                     std::move(*id), *declared, std::move(*birth),
                                     std::move(override_source), std::move(*provenance)})
                           : std::nullopt;
            });
    }
    if (milliseconds &&
        *milliseconds > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
        d.error(k_value, "Play time is outside the supported range.", "/playTimeMs");
        milliseconds.reset();
    }
    auto saved_overrides = decode_array<SavedPropertyOverride>(
        d, overrides, "/propertyOverrides",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedPropertyOverride> {
            if (!d.object(value, pointer, {"property", "target", "value"}))
                return std::nullopt;
            const auto* target = d.member(value, "target", pointer);
            const auto* property = d.member(value, "property", pointer);
            const auto* saved = d.member(value, "value", pointer);
            auto target_ref = target ? decode_property_target(d, *target, child(pointer, "target"))
                                     : std::nullopt;
            auto property_id =
                property ? d.id<PropertyId>(*property, child(pointer, "property")) : std::nullopt;
            auto runtime = saved ? decode_value(d, *saved, child(pointer, "value")) : std::nullopt;
            return target_ref && property_id && runtime
                       ? std::optional<SavedPropertyOverride>(SavedPropertyOverride{
                             std::move(*target_ref), std::move(*property_id), std::move(*runtime)})
                       : std::nullopt;
        });
    auto saved_interactables = decode_array<InteractableState>(
        d, interactables, "/interactables",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<InteractableState> {
            if (!d.object(
                    value, pointer,
                    {"dynamicRoomOccurrence", "enabled", "id", "location", "quantity", "visible"}))
                return std::nullopt;
            const auto* id = d.member(value, "id", pointer);
            const auto* location = d.member(value, "location", pointer);
            const auto* enabled = d.member(value, "enabled", pointer);
            const auto* visible = d.member(value, "visible", pointer);
            const auto* quantity = d.member(value, "quantity", pointer);
            const auto* dynamic_occurrence = d.member(value, "dynamicRoomOccurrence", pointer);
            auto interactable =
                id ? d.id<InteractableInstanceId>(*id, child(pointer, "id")) : std::nullopt;
            auto saved_location =
                location ? decode_location(d, *location, child(pointer, "location")) : std::nullopt;
            auto saved_enabled =
                enabled ? d.boolean(*enabled, child(pointer, "enabled")) : std::nullopt;
            auto saved_visible =
                visible ? d.boolean(*visible, child(pointer, "visible")) : std::nullopt;
            auto saved_quantity =
                quantity
                    ? d.unsigned_integer<std::uint64_t>(*quantity, child(pointer, "quantity"), true)
                    : std::nullopt;
            if (saved_quantity && *saved_quantity > compiled::max_interactable_quantity) {
                d.error("save.invalid_number", "Interactable quantity exceeds the portable range.",
                        child(pointer, "quantity"));
                saved_quantity = std::nullopt;
            }
            std::optional<InteractableState::DynamicRoomOccurrence> saved_dynamic_occurrence;
            bool dynamic_occurrence_ok = dynamic_occurrence != nullptr;
            if (dynamic_occurrence && !dynamic_occurrence->is_null()) {
                const auto dynamic_pointer = child(pointer, "dynamicRoomOccurrence");
                if (!d.object(*dynamic_occurrence, dynamic_pointer, {"placement", "room"})) {
                    dynamic_occurrence_ok = false;
                } else {
                    const auto* room_value = d.member(*dynamic_occurrence, "room", dynamic_pointer);
                    const auto* placement_value =
                        d.member(*dynamic_occurrence, "placement", dynamic_pointer);
                    auto room = room_value
                                    ? d.id<RoomId>(*room_value, child(dynamic_pointer, "room"))
                                    : std::nullopt;
                    auto placement =
                        placement_value ? d.id<RoomPlacementId>(*placement_value,
                                                                child(dynamic_pointer, "placement"))
                                        : std::nullopt;
                    dynamic_occurrence_ok = room.has_value() && placement.has_value();
                    if (dynamic_occurrence_ok)
                        saved_dynamic_occurrence = InteractableState::DynamicRoomOccurrence{
                            std::move(*room), std::move(*placement)};
                }
            }
            return interactable && saved_location && saved_enabled && saved_visible &&
                           saved_quantity && dynamic_occurrence_ok
                       ? std::optional<InteractableState>(InteractableState{
                             std::move(*interactable), std::move(*saved_location), *saved_enabled,
                             *saved_visible, *saved_quantity, std::move(saved_dynamic_occurrence)})
                       : std::nullopt;
        });
    auto saved_characters = decode_array<CharacterWorldState>(
        d, characters, "/characters",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<CharacterWorldState> {
            if (!d.object(value, pointer, {"id", "location", "enabled", "visible"}))
                return std::nullopt;
            const auto* id = d.member(value, "id", pointer);
            const auto* location = d.member(value, "location", pointer);
            const auto* enabled = d.member(value, "enabled", pointer);
            const auto* visible = d.member(value, "visible", pointer);
            auto character = id ? d.id<CharacterId>(*id, child(pointer, "id")) : std::nullopt;
            auto saved_location =
                location ? decode_character_location(d, *location, child(pointer, "location"))
                         : std::nullopt;
            auto saved_enabled =
                enabled ? d.boolean(*enabled, child(pointer, "enabled")) : std::nullopt;
            auto saved_visible =
                visible ? d.boolean(*visible, child(pointer, "visible")) : std::nullopt;
            return character && saved_location && saved_enabled && saved_visible
                       ? std::optional<CharacterWorldState>(
                             CharacterWorldState{std::move(*character), std::move(*saved_location),
                                                 *saved_enabled, *saved_visible})
                       : std::nullopt;
        });
    auto saved_item_stacks = decode_array<ItemStackState>(
        d, item_stacks, "/itemStacks",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<ItemStackState> {
            if (!d.object(value, pointer,
                          {"id", "definition", "quantity", "location", "traits", "declared"}))
                return std::nullopt;
            const auto* id_value = d.member(value, "id", pointer);
            const auto* definition_value = d.member(value, "definition", pointer);
            const auto* quantity_value = d.member(value, "quantity", pointer);
            const auto* location_value = d.member(value, "location", pointer);
            const auto* traits_value = d.member(value, "traits", pointer);
            const auto* declared_value = d.member(value, "declared", pointer);
            auto id = id_value ? d.id<ItemStackId>(*id_value, child(pointer, "id")) : std::nullopt;
            auto definition =
                definition_value
                    ? d.id<ItemDefinitionId>(*definition_value, child(pointer, "definition"))
                    : std::nullopt;
            auto quantity = quantity_value ? d.unsigned_integer<std::uint64_t>(
                                                 *quantity_value, child(pointer, "quantity"), true)
                                           : std::nullopt;
            auto location = location_value
                                ? decode_location(d, *location_value, child(pointer, "location"))
                                : std::nullopt;
            auto traits = decode_array<TraitId>(
                d, traits_value, child(pointer, "traits"),
                [&d](const nlohmann::json& trait, const std::string& trait_pointer) {
                    return d.id<TraitId>(trait, trait_pointer);
                });
            auto declared = declared_value ? d.boolean(*declared_value, child(pointer, "declared"))
                                           : std::nullopt;
            return id && definition && quantity && location && traits && declared
                       ? std::optional<ItemStackState>(
                             ItemStackState{std::move(*id), std::move(*definition), *quantity,
                                            std::move(*location), std::move(*traits), *declared})
                       : std::nullopt;
        });
    auto saved_active_room_visit =
        active_room_visit ? decode_room_visit(d, *active_room_visit, "/activeRoomVisit")
                          : std::nullopt;
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
    auto saved_presentation = presentation
                                  ? decode_presentation_records(d, *presentation, "/presentation")
                                  : std::nullopt;
    auto saved_mode = mode ? decode_mode(d, *mode, "/mode") : std::nullopt;
    auto saved_frames = decode_array<SavedFlowFrame>(
        d, frames, "/flowStack", [&d](const nlohmann::json& value, const std::string& pointer) {
            return decode_frame(d, value, pointer);
        });
    auto saved_blocker = blocker ? decode_blocker(d, *blocker, "/blocker") : std::nullopt;
    auto saved_detached_flows = decode_array<SavedDetachedFlowExecution>(
        d, detached_flows, "/detachedFlows",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedDetachedFlowExecution> {
            if (!d.object(value, pointer,
                          {"owner", "flowOwner", "roomEntrySequence", "flowStack", "blocker"}))
                return std::nullopt;
            const auto* owner_value = d.member(value, "owner", pointer);
            const auto* flow_owner_value = d.member(value, "flowOwner", pointer);
            const auto* sequence_value = d.member(value, "roomEntrySequence", pointer);
            const auto* frames_value = d.member(value, "flowStack", pointer);
            const auto* blocker_value = d.member(value, "blocker", pointer);
            auto owner_name =
                owner_value ? d.string(*owner_value, child(pointer, "owner")) : std::nullopt;
            std::optional<compiled::DetachedSceneOwner> owner;
            if (owner_name) {
                if (*owner_name == "flow")
                    owner = compiled::DetachedSceneOwner::Flow;
                else if (*owner_name == "active-room")
                    owner = compiled::DetachedSceneOwner::ActiveRoom;
                else if (*owner_name == "runtime-session")
                    owner = compiled::DetachedSceneOwner::RuntimeSession;
                else
                    d.error(k_value, "Unknown detached Flow owner.", child(pointer, "owner"));
            }
            std::optional<SavedFlowFrameId> flow_owner;
            bool flow_owner_ok = flow_owner_value != nullptr;
            if (flow_owner_value && !flow_owner_value->is_null()) {
                auto number = d.unsigned_integer<std::uint64_t>(*flow_owner_value,
                                                                child(pointer, "flowOwner"), true);
                flow_owner_ok = number.has_value();
                if (number)
                    flow_owner = SavedFlowFrameId{*number};
            }
            auto sequence = sequence_value
                                ? d.unsigned_integer<std::uint64_t>(
                                      *sequence_value, child(pointer, "roomEntrySequence"))
                                : std::nullopt;
            auto saved_frames = decode_array<SavedFlowFrame>(
                d, frames_value, child(pointer, "flowStack"),
                [&d](const nlohmann::json& frame, const std::string& frame_pointer) {
                    return decode_frame(d, frame, frame_pointer);
                });
            auto saved_blocker = blocker_value
                                     ? decode_blocker(d, *blocker_value, child(pointer, "blocker"))
                                     : std::nullopt;
            return owner && flow_owner_ok && sequence && saved_frames && saved_blocker
                       ? std::optional<SavedDetachedFlowExecution>(SavedDetachedFlowExecution{
                             *owner, flow_owner, *sequence, std::move(*saved_frames),
                             std::move(*saved_blocker)})
                       : std::nullopt;
        });
    auto saved_execution_provenance = decode_array<SavedExecutionProvenance>(
        d, execution_provenance, "/executionProvenance",
        [&d](const nlohmann::json& value,
             const std::string& pointer) -> std::optional<SavedExecutionProvenance> {
            if (!d.object(
                    value, pointer,
                    {"id", "activeFrame", "parent", "root", "relationship", "source", "state"}))
                return std::nullopt;
            const auto* id_value = d.member(value, "id", pointer);
            const auto* active_frame_value = d.member(value, "activeFrame", pointer);
            const auto* parent_value = d.member(value, "parent", pointer);
            const auto* root_value = d.member(value, "root", pointer);
            const auto* relationship_value = d.member(value, "relationship", pointer);
            const auto* source_value = d.member(value, "source", pointer);
            const auto* state_value = d.member(value, "state", pointer);
            auto id = id_value
                          ? d.unsigned_integer<std::uint64_t>(*id_value, child(pointer, "id"), true)
                          : std::nullopt;
            auto root = root_value ? d.unsigned_integer<std::uint64_t>(*root_value,
                                                                       child(pointer, "root"), true)
                                   : std::nullopt;
            auto relationship = relationship_value
                                    ? decode_execution_relationship(d, *relationship_value,
                                                                    child(pointer, "relationship"))
                                    : std::nullopt;
            auto state = state_value
                             ? decode_execution_state(d, *state_value, child(pointer, "state"))
                             : std::nullopt;
            std::optional<SavedFlowFrameId> active_frame;
            bool active_frame_ok = active_frame_value != nullptr;
            if (active_frame_value && !active_frame_value->is_null()) {
                auto number = d.unsigned_integer<std::uint64_t>(
                    *active_frame_value, child(pointer, "activeFrame"), true);
                active_frame_ok = number.has_value();
                if (number)
                    active_frame = SavedFlowFrameId{*number};
            }
            const auto decode_optional_id = [&](const nlohmann::json* field, std::string_view name,
                                                bool& ok) -> std::optional<std::uint64_t> {
                ok = field != nullptr;
                if (field == nullptr || field->is_null())
                    return std::nullopt;
                auto number = d.unsigned_integer<std::uint64_t>(*field, child(pointer, name), true);
                ok = number.has_value();
                return number;
            };
            bool parent_ok = false;
            bool source_ok = false;
            auto parent = decode_optional_id(parent_value, "parent", parent_ok);
            auto source = decode_optional_id(source_value, "source", source_ok);
            return id && root && relationship && state && active_frame_ok && parent_ok && source_ok
                       ? std::optional<SavedExecutionProvenance>(SavedExecutionProvenance{
                             *id, active_frame, parent, *root, *relationship, source, *state})
                       : std::nullopt;
        });
    if (d.failed() || !saved_metadata || !milliseconds || !saved_random_state ||
        !saved_next_runtime_instance_id || !saved_next_item_stack_id ||
        !saved_room_entry_sequence || !saved_runtime_rooms || !saved_runtime_characters ||
        !saved_runtime_interactables || !saved_overrides || !saved_characters ||
        !saved_interactables || !saved_item_stacks || !saved_active_room_visit ||
        !saved_room_visits || !saved_line_history || !saved_choice_history || !saved_log ||
        !saved_timers || !saved_completions || !saved_presentation || !saved_mode ||
        !saved_frames || !saved_blocker || !saved_detached_flows || !saved_execution_provenance)
        return Result<SaveState, Diagnostics>::failure(d.take());
    return Result<SaveState, Diagnostics>::success(
        SaveState{std::move(*saved_metadata),
                  std::chrono::milliseconds(*milliseconds),
                  *saved_random_state,
                  *saved_next_runtime_instance_id,
                  *saved_next_item_stack_id,
                  *saved_room_entry_sequence,
                  std::move(*saved_runtime_rooms),
                  std::move(*saved_runtime_characters),
                  std::move(*saved_runtime_interactables),
                  std::move(*saved_overrides),
                  std::move(*saved_characters),
                  std::move(*saved_interactables),
                  std::move(*saved_item_stacks),
                  std::move(*saved_active_room_visit),
                  std::move(*saved_room_visits),
                  std::move(*saved_line_history),
                  std::move(*saved_choice_history),
                  std::move(*saved_log),
                  std::move(*saved_timers),
                  std::move(*saved_completions),
                  std::move(saved_presentation->background_overrides),
                  std::move(saved_presentation->camera_views),
                  std::move(saved_presentation->actors),
                  std::move(saved_presentation->props),
                  std::move(saved_presentation->environments),
                  std::move(saved_presentation->material_parameters),
                  std::move(saved_presentation->postprocess_effects),
                  std::move(saved_presentation->layouts),
                  std::move(saved_presentation->layout_state_slots),
                  std::move(saved_presentation->desired_audio),
                  std::move(saved_presentation->presented_text),
                  std::move(saved_presentation->active_choice),
                  std::move(*saved_mode),
                  std::move(*saved_frames),
                  std::move(*saved_blocker),
                  std::move(*saved_detached_flows),
                  std::move(*saved_execution_provenance)});
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
