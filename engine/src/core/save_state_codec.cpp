#include "noveltea/core/save_state_codec.hpp"

#include "noveltea/core/json_access.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <optional>
#include <string_view>
#include <type_traits>
#include <unordered_set>
#include <utility>

namespace noveltea::core {
namespace {

constexpr std::string_view k_schema = "noveltea.save.state";
constexpr std::string_view k_missing = "save_codec.missing_field";
constexpr std::string_view k_type = "save_codec.type";
constexpr std::string_view k_unknown = "save_codec.unknown_field";
constexpr std::string_view k_value = "save_codec.invalid_value";
constexpr std::string_view k_id = "save_codec.invalid_id";
constexpr std::string_view k_variant = "save_codec.invalid_variant";

std::string child(std::string_view parent, std::string_view name)
{
    std::string result(parent);
    result.push_back('/');
    for (const auto character : name) {
        if (character == '~')
            result += "~0";
        else if (character == '/')
            result += "~1";
        else
            result.push_back(character);
    }
    return result;
}

std::string index(std::string_view parent, std::size_t value)
{
    return child(parent, std::to_string(value));
}

class Decoder {
public:
    explicit Decoder(std::string source_path) : m_source_path(std::move(source_path)) {}

    void error(std::string_view code, std::string message, std::string pointer)
    {
        m_diagnostics.push_back(Diagnostic{.code = std::string(code),
                                           .message = std::move(message),
                                           .source_path = m_source_path,
                                           .json_pointer = std::move(pointer)});
    }

    bool object(const nlohmann::json& value, std::string_view pointer,
                std::initializer_list<std::string_view> fields)
    {
        if (!value.is_object()) {
            error(k_type, "Expected an object.", std::string(pointer));
            return false;
        }
        for (auto it = value.begin(); it != value.end(); ++it) {
            const auto known = std::find(fields.begin(), fields.end(), it.key()) != fields.end();
            if (!known)
                error(k_unknown, "Unknown field '" + it.key() + "'.", child(pointer, it.key()));
        }
        return true;
    }

    const nlohmann::json* member(const nlohmann::json& value, std::string_view name,
                                 std::string_view pointer)
    {
        const auto* result = json_access::member(value, name);
        if (!result)
            error(k_missing, "Missing required field '" + std::string(name) + "'.",
                  child(pointer, name));
        return result;
    }

    std::optional<std::string> string(const nlohmann::json& value, std::string_view pointer,
                                      bool nonempty = false)
    {
        auto result = json_access::get<std::string>(value);
        if (!result || (nonempty && result->empty())) {
            error(k_type, nonempty ? "Expected a non-empty string." : "Expected a string.",
                  std::string(pointer));
            return std::nullopt;
        }
        return result;
    }

    std::optional<bool> boolean(const nlohmann::json& value, std::string_view pointer)
    {
        auto result = json_access::get<bool>(value);
        if (!result)
            error(k_type, "Expected a boolean.", std::string(pointer));
        return result;
    }

    template<class T>
    std::optional<T> unsigned_integer(const nlohmann::json& value, std::string_view pointer,
                                      bool positive = false)
    {
        auto result = json_access::get<T>(value);
        if (!result || (positive && *result == 0)) {
            error(k_type,
                  positive ? "Expected a positive integer."
                           : "Expected a nonnegative integer in range.",
                  std::string(pointer));
            return std::nullopt;
        }
        return result;
    }

    template<class Id> std::optional<Id> id(const nlohmann::json& value, std::string_view pointer)
    {
        auto text = string(value, pointer, true);
        if (!text)
            return std::nullopt;
        auto result = Id::create(std::move(*text));
        if (!result) {
            error(k_id, result.error().front().message, std::string(pointer));
            return std::nullopt;
        }
        return std::move(*result.value_if());
    }

    template<class Id> struct OptionalId {
        bool valid = false;
        std::optional<Id> value;
        [[nodiscard]] explicit operator bool() const noexcept { return valid; }
    };

    template<class Id>
    OptionalId<Id> optional_id(const nlohmann::json& value, std::string_view pointer)
    {
        if (value.is_null())
            return OptionalId<Id>{true, std::nullopt};
        auto result = id<Id>(value, pointer);
        return result ? OptionalId<Id>{true, std::move(result)}
                      : OptionalId<Id>{false, std::nullopt};
    }

    [[nodiscard]] bool failed() const noexcept { return !m_diagnostics.empty(); }
    [[nodiscard]] Diagnostics take() { return std::move(m_diagnostics); }

private:
    std::string m_source_path;
    Diagnostics m_diagnostics;
};

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

template<class Id> nlohmann::json encode_optional_id(const std::optional<Id>& value)
{
    return value ? nlohmann::json(value->text()) : nlohmann::json(nullptr);
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

nlohmann::json encode_destination(const ReturnDestination& destination)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CallerDestination>)
                return {{"kind", "caller"}};
            else if constexpr (std::is_same_v<T, ResumeRoomDestination>)
                return {{"kind", "resume-room"}, {"room", value.room.text()}};
            else
                return {{"kind", "none"}};
        },
        destination);
}

std::optional<ReturnDestination> decode_destination(Decoder& d, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a destination object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    if (*name == "caller") {
        d.object(value, pointer, {"kind"});
        return CallerDestination{};
    }
    if (*name == "none") {
        d.object(value, pointer, {"kind"});
        return NoReturnDestination{};
    }
    if (*name == "resume-room") {
        d.object(value, pointer, {"kind", "room"});
        const auto* room = d.member(value, "room", pointer);
        auto result = room ? d.id<RoomId>(*room, child(pointer, "room")) : std::nullopt;
        return result ? std::optional<ReturnDestination>(ResumeRoomDestination{std::move(*result)})
                      : std::nullopt;
    }
    d.error(k_variant, "Unknown return destination '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

// Frame encoding keeps every live cursor variant explicit. This is intentionally not a generic
// object serializer: all discriminants remain closed and all IDs retain their field type.
nlohmann::json encode_scene_position(const SceneFramePosition& position)
{
    nlohmann::json substate;
    std::visit(
        [&substate](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneStepReady>)
                substate = {{"kind", "ready"}};
            else if constexpr (std::is_same_v<T, SceneInstructionCompletionPosition>)
                substate = {{"kind", "instruction-complete"},
                            {"nextStep", encode_optional_id(value.next_step)},
                            {"autosaveSafePoint", value.autosave_safe_point}};
            else if constexpr (std::is_same_v<T, SceneAutosavePendingPosition>)
                substate = {{"kind", "autosave-pending"},
                            {"completedStep", value.completed_step.text()},
                            {"nextStep", encode_optional_id(value.next_step)}};
            else if constexpr (std::is_same_v<T, SceneChoiceSelectionPosition>)
                substate = {{"kind", "choice-selection"}};
            else
                substate = {{"kind", "choice-effects"},
                            {"option", value.option.text()},
                            {"nextEffect", value.next_effect},
                            {"awaitingCompletion", value.awaiting_completion}};
        },
        position.substate);
    return {{"nextStep", encode_optional_id(position.next_step)},
            {"substate", std::move(substate)}};
}

std::optional<SceneFramePosition> decode_scene_position(Decoder& d, const nlohmann::json& value,
                                                        std::string_view pointer)
{
    if (!d.object(value, pointer, {"nextStep", "substate"}))
        return std::nullopt;
    const auto* next = d.member(value, "nextStep", pointer);
    const auto* substate = d.member(value, "substate", pointer);
    auto next_id = next ? d.optional_id<SceneStepId>(*next, child(pointer, "nextStep"))
                        : Decoder::OptionalId<SceneStepId>{};
    if (!next_id || !substate || !substate->is_object()) {
        if (substate && !substate->is_object())
            d.error(k_type, "Expected a substate object.", child(pointer, "substate"));
        return std::nullopt;
    }
    const auto sub = child(pointer, "substate");
    const auto* kind = d.member(*substate, "kind", sub);
    auto name = kind ? d.string(*kind, child(sub, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    SceneStepSubstate decoded;
    if (*name == "ready") {
        d.object(*substate, sub, {"kind"});
        decoded = SceneStepReady{};
    } else if (*name == "instruction-complete") {
        d.object(*substate, sub, {"kind", "nextStep", "autosaveSafePoint"});
        const auto* after = d.member(*substate, "nextStep", sub);
        const auto* autosave = d.member(*substate, "autosaveSafePoint", sub);
        auto after_id = after ? d.optional_id<SceneStepId>(*after, child(sub, "nextStep"))
                              : Decoder::OptionalId<SceneStepId>{};
        auto safe = autosave ? d.boolean(*autosave, child(sub, "autosaveSafePoint")) : std::nullopt;
        if (!after_id || !safe)
            return std::nullopt;
        decoded = SceneInstructionCompletionPosition{std::move(after_id.value), *safe};
    } else if (*name == "autosave-pending") {
        d.object(*substate, sub, {"kind", "completedStep", "nextStep"});
        const auto* completed = d.member(*substate, "completedStep", sub);
        const auto* after = d.member(*substate, "nextStep", sub);
        auto completed_id =
            completed ? d.id<SceneStepId>(*completed, child(sub, "completedStep")) : std::nullopt;
        auto after_id = after ? d.optional_id<SceneStepId>(*after, child(sub, "nextStep"))
                              : Decoder::OptionalId<SceneStepId>{};
        if (!completed_id || !after_id)
            return std::nullopt;
        decoded = SceneAutosavePendingPosition{std::move(*completed_id), std::move(after_id.value)};
    } else if (*name == "choice-selection") {
        d.object(*substate, sub, {"kind"});
        decoded = SceneChoiceSelectionPosition{};
    } else if (*name == "choice-effects") {
        d.object(*substate, sub, {"kind", "option", "nextEffect", "awaitingCompletion"});
        const auto* option = d.member(*substate, "option", sub);
        const auto* effect = d.member(*substate, "nextEffect", sub);
        const auto* awaiting = d.member(*substate, "awaitingCompletion", sub);
        auto option_id =
            option ? d.id<SceneChoiceOptionId>(*option, child(sub, "option")) : std::nullopt;
        auto effect_index = effect
                                ? d.unsigned_integer<std::size_t>(*effect, child(sub, "nextEffect"))
                                : std::nullopt;
        auto awaiting_value =
            awaiting ? d.boolean(*awaiting, child(sub, "awaitingCompletion")) : std::nullopt;
        if (!option_id || !effect_index || !awaiting_value)
            return std::nullopt;
        decoded = SceneChoiceEffectPosition{std::move(*option_id), *effect_index, *awaiting_value};
    } else {
        d.error(k_variant, "Unknown Scene substate '" + *name + "'.", child(sub, "kind"));
        return std::nullopt;
    }
    return SceneFramePosition{std::move(next_id.value), std::move(decoded)};
}

nlohmann::json encode_dialogue_position(const DialogueFramePosition& value)
{
    static constexpr std::string_view names[] = {
        "enter-block",     "present-segment",      "apply-segment-effects",
        "present-choices", "apply-choice-effects", "follow-edge",
        "complete"};
    return {{"block", value.block.text()},
            {"segment", encode_optional_id(value.segment)},
            {"edge", encode_optional_id(value.edge)},
            {"stage", names[static_cast<std::size_t>(value.stage)]},
            {"nextEffect", value.next_effect},
            {"awaitingCompletion", value.awaiting_completion}};
}

std::optional<DialogueFramePosition>
decode_dialogue_position(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer,
                  {"block", "segment", "edge", "stage", "nextEffect", "awaitingCompletion"}))
        return std::nullopt;
    const auto* block = d.member(value, "block", pointer);
    const auto* segment = d.member(value, "segment", pointer);
    const auto* edge = d.member(value, "edge", pointer);
    const auto* stage = d.member(value, "stage", pointer);
    const auto* effect = d.member(value, "nextEffect", pointer);
    const auto* awaiting = d.member(value, "awaitingCompletion", pointer);
    auto block_id = block ? d.id<DialogueBlockId>(*block, child(pointer, "block")) : std::nullopt;
    auto segment_id = segment
                          ? d.optional_id<DialogueSegmentId>(*segment, child(pointer, "segment"))
                          : Decoder::OptionalId<DialogueSegmentId>{};
    auto edge_id = edge ? d.optional_id<DialogueEdgeId>(*edge, child(pointer, "edge"))
                        : Decoder::OptionalId<DialogueEdgeId>{};
    auto name = stage ? d.string(*stage, child(pointer, "stage")) : std::nullopt;
    auto effect_index = effect
                            ? d.unsigned_integer<std::size_t>(*effect, child(pointer, "nextEffect"))
                            : std::nullopt;
    auto awaiting_value =
        awaiting ? d.boolean(*awaiting, child(pointer, "awaitingCompletion")) : std::nullopt;
    if (!block_id || !segment_id || !edge_id || !name || !effect_index || !awaiting_value)
        return std::nullopt;
    const std::array<std::string_view, 7> names = {
        "enter-block",     "present-segment",      "apply-segment-effects",
        "present-choices", "apply-choice-effects", "follow-edge",
        "complete"};
    const auto found = std::find(names.begin(), names.end(), *name);
    if (found == names.end()) {
        d.error(k_variant, "Unknown Dialogue stage '" + *name + "'.", child(pointer, "stage"));
        return std::nullopt;
    }
    return DialogueFramePosition{
        std::move(*block_id),
        std::move(segment_id.value),
        std::move(edge_id.value),
        static_cast<DialogueFramePosition::Stage>(std::distance(names.begin(), found)),
        *effect_index,
        *awaiting_value};
}

nlohmann::json encode_interaction_program(const InteractionProgramRef& value)
{
    return std::visit(
        [](const auto& item) -> nlohmann::json {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, InteractionRuleProgramRef>)
                return {{"kind", "rule"},
                        {"interaction", item.interaction.text()},
                        {"rule", item.rule.text()}};
            else
                return {{"kind", "verb-default"}, {"verb", item.verb.text()}};
        },
        value);
}

std::optional<InteractionProgramRef>
decode_interaction_program(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected an interaction program object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    if (*name == "rule") {
        d.object(value, pointer, {"kind", "interaction", "rule"});
        const auto* interaction = d.member(value, "interaction", pointer);
        const auto* rule = d.member(value, "rule", pointer);
        auto interaction_id = interaction
                                  ? d.id<InteractionId>(*interaction, child(pointer, "interaction"))
                                  : std::nullopt;
        auto rule_id = rule ? d.id<InteractionRuleId>(*rule, child(pointer, "rule")) : std::nullopt;
        return interaction_id && rule_id
                   ? std::optional<InteractionProgramRef>(
                         InteractionRuleProgramRef{std::move(*interaction_id), std::move(*rule_id)})
                   : std::nullopt;
    }
    if (*name == "verb-default") {
        d.object(value, pointer, {"kind", "verb"});
        const auto* verb = d.member(value, "verb", pointer);
        auto verb_id = verb ? d.id<VerbId>(*verb, child(pointer, "verb")) : std::nullopt;
        return verb_id ? std::optional<InteractionProgramRef>(
                             VerbDefaultProgramRef{std::move(*verb_id)})
                       : std::nullopt;
    }
    d.error(k_variant, "Unknown interaction program kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_interaction_position(const InteractionFramePosition& value)
{
    static constexpr std::string_view stages[] = {"selected-program", "parent-verb",
                                                  "undefined-interaction", "complete"};
    static constexpr std::string_view outcomes[] = {"pending", "handled", "unhandled", "failed"};
    return {{"nextInstruction", encode_optional_id(value.next_instruction)},
            {"fallbackStage", stages[static_cast<std::size_t>(value.fallback_stage)]},
            {"outcome", outcomes[static_cast<std::size_t>(value.outcome)]},
            {"awaitingCompletion", value.awaiting_completion}};
}

std::optional<InteractionFramePosition>
decode_interaction_position(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer,
                  {"nextInstruction", "fallbackStage", "outcome", "awaitingCompletion"}))
        return std::nullopt;
    const auto* next = d.member(value, "nextInstruction", pointer);
    const auto* stage = d.member(value, "fallbackStage", pointer);
    const auto* outcome = d.member(value, "outcome", pointer);
    const auto* awaiting = d.member(value, "awaitingCompletion", pointer);
    auto next_id =
        next ? d.optional_id<InteractionInstructionId>(*next, child(pointer, "nextInstruction"))
             : Decoder::OptionalId<InteractionInstructionId>{};
    auto stage_name = stage ? d.string(*stage, child(pointer, "fallbackStage")) : std::nullopt;
    auto outcome_name = outcome ? d.string(*outcome, child(pointer, "outcome")) : std::nullopt;
    auto awaiting_value =
        awaiting ? d.boolean(*awaiting, child(pointer, "awaitingCompletion")) : std::nullopt;
    if (!next_id || !stage_name || !outcome_name || !awaiting_value)
        return std::nullopt;
    const std::array<std::string_view, 4> stages = {"selected-program", "parent-verb",
                                                    "undefined-interaction", "complete"};
    const std::array<std::string_view, 4> outcomes = {"pending", "handled", "unhandled", "failed"};
    const auto stage_found = std::find(stages.begin(), stages.end(), *stage_name);
    const auto outcome_found = std::find(outcomes.begin(), outcomes.end(), *outcome_name);
    if (stage_found == stages.end() || outcome_found == outcomes.end()) {
        d.error(k_variant, "Unknown interaction position value.", std::string(pointer));
        return std::nullopt;
    }
    return InteractionFramePosition{
        std::move(next_id.value),
        static_cast<InteractionFallbackStage>(std::distance(stages.begin(), stage_found)),
        static_cast<InteractionExecutionOutcome>(std::distance(outcomes.begin(), outcome_found)),
        *awaiting_value};
}

nlohmann::json encode_room_position(const RoomTransitionPosition& value)
{
    static constexpr std::string_view stages[] = {
        "source-can-leave",   "exit-condition", "target-can-enter", "before-leave", "before-enter",
        "commit-room-switch", "after-leave",    "after-enter",      "complete"};
    return {{"stage", stages[static_cast<std::size_t>(value.stage)]},
            {"nextEffect", value.next_effect},
            {"awaitingCompletion", value.awaiting_completion}};
}

std::optional<RoomTransitionPosition> decode_room_position(Decoder& d, const nlohmann::json& value,
                                                           std::string_view pointer)
{
    if (!d.object(value, pointer, {"stage", "nextEffect", "awaitingCompletion"}))
        return std::nullopt;
    const auto* stage = d.member(value, "stage", pointer);
    const auto* effect = d.member(value, "nextEffect", pointer);
    const auto* awaiting = d.member(value, "awaitingCompletion", pointer);
    auto name = stage ? d.string(*stage, child(pointer, "stage")) : std::nullopt;
    auto effect_index = effect
                            ? d.unsigned_integer<std::size_t>(*effect, child(pointer, "nextEffect"))
                            : std::nullopt;
    auto awaiting_value =
        awaiting ? d.boolean(*awaiting, child(pointer, "awaitingCompletion")) : std::nullopt;
    if (!name || !effect_index || !awaiting_value)
        return std::nullopt;
    const std::array<std::string_view, 9> names = {
        "source-can-leave",   "exit-condition", "target-can-enter", "before-leave", "before-enter",
        "commit-room-switch", "after-leave",    "after-enter",      "complete"};
    const auto found = std::find(names.begin(), names.end(), *name);
    if (found == names.end()) {
        d.error(k_variant, "Unknown Room transition stage '" + *name + "'.",
                child(pointer, "stage"));
        return std::nullopt;
    }
    return RoomTransitionPosition{
        static_cast<RoomTransitionStage>(std::distance(names.begin(), found)), *effect_index,
        *awaiting_value};
}

nlohmann::json encode_frame(const SavedFlowFrame& frame)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedSceneFrame>)
                return {{"kind", "scene"},
                        {"id", value.snapshot_id.value},
                        {"scene", value.scene.text()},
                        {"position", encode_scene_position(value.position)},
                        {"destination", encode_destination(value.destination)}};
            else if constexpr (std::is_same_v<T, SavedDialogueFrame>)
                return {{"kind", "dialogue"},
                        {"id", value.snapshot_id.value},
                        {"dialogue", value.dialogue.text()},
                        {"position", encode_dialogue_position(value.position)},
                        {"destination", encode_destination(value.destination)}};
            else if constexpr (std::is_same_v<T, SavedInteractionFrame>) {
                nlohmann::json operands = nlohmann::json::array();
                for (const auto& operand : value.invocation.operands)
                    operands.push_back(operand.text());
                return {{"kind", "interaction"},
                        {"id", value.snapshot_id.value},
                        {"invocation",
                         {{"verb", value.invocation.verb.text()},
                          {"room", encode_optional_id(value.invocation.room)},
                          {"operands", std::move(operands)}}},
                        {"program", encode_interaction_program(value.program)},
                        {"position", encode_interaction_position(value.position)},
                        {"destination", encode_destination(value.destination)}};
            } else
                return {{"kind", "room-transition"},
                        {"id", value.snapshot_id.value},
                        {"sourceRoom", encode_optional_id(value.source_room)},
                        {"targetRoom", value.target_room.text()},
                        {"selectedExit",
                         value.selected_exit
                             ? nlohmann::json{{"room", value.selected_exit->room.text()},
                                              {"exit", value.selected_exit->exit_id.text()}}
                             : nlohmann::json(nullptr)},
                        {"position", encode_room_position(value.position)},
                        {"destination", encode_destination(value.destination)}};
        },
        frame);
}

std::optional<SavedFlowFrame> decode_frame(Decoder& d, const nlohmann::json& value,
                                           std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a flow frame object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    const auto* id = d.member(value, "id", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    auto snapshot =
        id ? d.unsigned_integer<std::uint64_t>(*id, child(pointer, "id"), true) : std::nullopt;
    if (!name || !snapshot)
        return std::nullopt;
    if (*name == "scene") {
        d.object(value, pointer, {"kind", "id", "scene", "position", "destination"});
        const auto* scene = d.member(value, "scene", pointer);
        const auto* position = d.member(value, "position", pointer);
        const auto* destination = d.member(value, "destination", pointer);
        auto scene_id = scene ? d.id<SceneId>(*scene, child(pointer, "scene")) : std::nullopt;
        auto saved_position = position
                                  ? decode_scene_position(d, *position, child(pointer, "position"))
                                  : std::nullopt;
        auto saved_destination =
            destination ? decode_destination(d, *destination, child(pointer, "destination"))
                        : std::nullopt;
        return scene_id && saved_position && saved_destination
                   ? std::optional<SavedFlowFrame>(SavedSceneFrame{{*snapshot},
                                                                   std::move(*scene_id),
                                                                   std::move(*saved_position),
                                                                   std::move(*saved_destination)})
                   : std::nullopt;
    }
    if (*name == "dialogue") {
        d.object(value, pointer, {"kind", "id", "dialogue", "position", "destination"});
        const auto* dialogue = d.member(value, "dialogue", pointer);
        const auto* position = d.member(value, "position", pointer);
        const auto* destination = d.member(value, "destination", pointer);
        auto dialogue_id =
            dialogue ? d.id<DialogueId>(*dialogue, child(pointer, "dialogue")) : std::nullopt;
        auto saved_position =
            position ? decode_dialogue_position(d, *position, child(pointer, "position"))
                     : std::nullopt;
        auto saved_destination =
            destination ? decode_destination(d, *destination, child(pointer, "destination"))
                        : std::nullopt;
        return dialogue_id && saved_position && saved_destination
                   ? std::optional<SavedFlowFrame>(
                         SavedDialogueFrame{{*snapshot},
                                            std::move(*dialogue_id),
                                            std::move(*saved_position),
                                            std::move(*saved_destination)})
                   : std::nullopt;
    }
    if (*name == "interaction") {
        d.object(value, pointer,
                 {"kind", "id", "invocation", "program", "position", "destination"});
        const auto* invocation = d.member(value, "invocation", pointer);
        const auto* program = d.member(value, "program", pointer);
        const auto* position = d.member(value, "position", pointer);
        const auto* destination = d.member(value, "destination", pointer);
        if (!invocation ||
            !d.object(*invocation, child(pointer, "invocation"), {"verb", "room", "operands"}))
            return std::nullopt;
        const auto invoke = child(pointer, "invocation");
        const auto* verb = d.member(*invocation, "verb", invoke);
        const auto* room = d.member(*invocation, "room", invoke);
        const auto* operands = d.member(*invocation, "operands", invoke);
        auto verb_id = verb ? d.id<VerbId>(*verb, child(invoke, "verb")) : std::nullopt;
        auto room_id = room ? d.optional_id<RoomId>(*room, child(invoke, "room"))
                            : Decoder::OptionalId<RoomId>{};
        std::vector<InteractableId> decoded_operands;
        if (!operands || !operands->is_array()) {
            if (operands)
                d.error(k_type, "Expected an array.", child(invoke, "operands"));
            return std::nullopt;
        }
        for (std::size_t item = 0; item < operands->size(); ++item) {
            const auto* source = json_access::element(*operands, item);
            auto operand =
                source ? d.id<InteractableId>(*source, index(child(invoke, "operands"), item))
                       : std::nullopt;
            if (operand)
                decoded_operands.push_back(std::move(*operand));
        }
        auto saved_program =
            program ? decode_interaction_program(d, *program, child(pointer, "program"))
                    : std::nullopt;
        auto saved_position =
            position ? decode_interaction_position(d, *position, child(pointer, "position"))
                     : std::nullopt;
        auto saved_destination =
            destination ? decode_destination(d, *destination, child(pointer, "destination"))
                        : std::nullopt;
        return verb_id && room_id && saved_program && saved_position && saved_destination
                   ? std::optional<SavedFlowFrame>(
                         SavedInteractionFrame{{*snapshot},
                                               {std::move(*verb_id), std::move(room_id.value),
                                                std::move(decoded_operands)},
                                               std::move(*saved_program),
                                               std::move(*saved_position),
                                               std::move(*saved_destination)})
                   : std::nullopt;
    }
    if (*name == "room-transition") {
        d.object(
            value, pointer,
            {"kind", "id", "sourceRoom", "targetRoom", "selectedExit", "position", "destination"});
        const auto* source = d.member(value, "sourceRoom", pointer);
        const auto* target = d.member(value, "targetRoom", pointer);
        const auto* selected = d.member(value, "selectedExit", pointer);
        const auto* position = d.member(value, "position", pointer);
        const auto* destination = d.member(value, "destination", pointer);
        auto source_id = source ? d.optional_id<RoomId>(*source, child(pointer, "sourceRoom"))
                                : Decoder::OptionalId<RoomId>{};
        auto target_id =
            target ? d.id<RoomId>(*target, child(pointer, "targetRoom")) : std::nullopt;
        std::optional<compiled::RoomExitRef> exit;
        if (selected && !selected->is_null()) {
            const auto selected_pointer = child(pointer, "selectedExit");
            if (d.object(*selected, selected_pointer, {"room", "exit"})) {
                const auto* room = d.member(*selected, "room", selected_pointer);
                const auto* exit_id = d.member(*selected, "exit", selected_pointer);
                auto room_id =
                    room ? d.id<RoomId>(*room, child(selected_pointer, "room")) : std::nullopt;
                auto parsed_exit = exit_id
                                       ? d.id<RoomExitId>(*exit_id, child(selected_pointer, "exit"))
                                       : std::nullopt;
                if (room_id && parsed_exit)
                    exit = compiled::RoomExitRef{std::move(*room_id), std::move(*parsed_exit)};
            }
        }
        auto saved_position = position
                                  ? decode_room_position(d, *position, child(pointer, "position"))
                                  : std::nullopt;
        auto saved_destination =
            destination ? decode_destination(d, *destination, child(pointer, "destination"))
                        : std::nullopt;
        return source_id && target_id && saved_position && saved_destination &&
                       (selected == nullptr || selected->is_null() || exit)
                   ? std::optional<SavedFlowFrame>(
                         SavedRoomTransitionFrame{{*snapshot},
                                                  std::move(source_id.value),
                                                  std::move(*target_id),
                                                  std::move(exit),
                                                  std::move(*saved_position),
                                                  std::move(*saved_destination)})
                   : std::nullopt;
    }
    d.error(k_variant, "Unknown flow frame kind '" + *name + "'.", child(pointer, "kind"));
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

nlohmann::json encode_blocker(const std::optional<SavedFlowBlocker>& blocker)
{
    if (!blocker)
        return nullptr;
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedInputBlocker>)
                return {{"kind", "input"}, {"owner", value.owner.value}};
            else
                return {{"kind", "duration"},
                        {"owner", value.owner.value},
                        {"remainingMs", value.remaining.count()}};
        },
        *blocker);
}

std::optional<std::optional<SavedFlowBlocker>>
decode_blocker(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<SavedFlowBlocker>{};
    if (!value.is_object()) {
        d.error(k_type, "Expected a blocker object or null.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    const auto* owner = d.member(value, "owner", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    auto owner_id = owner ? d.unsigned_integer<std::uint64_t>(*owner, child(pointer, "owner"), true)
                          : std::nullopt;
    if (!name || !owner_id)
        return std::nullopt;
    if (*name == "input") {
        d.object(value, pointer, {"kind", "owner"});
        return std::optional<SavedFlowBlocker>(SavedInputBlocker{{*owner_id}});
    }
    if (*name == "duration") {
        d.object(value, pointer, {"kind", "owner", "remainingMs"});
        const auto* remaining = d.member(value, "remainingMs", pointer);
        auto duration =
            remaining
                ? d.unsigned_integer<std::uint64_t>(*remaining, child(pointer, "remainingMs"), true)
                : std::nullopt;
        if (!duration ||
            *duration > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
            if (duration)
                d.error(k_value, "Duration is outside the supported range.",
                        child(pointer, "remainingMs"));
            return std::nullopt;
        }
        return std::optional<SavedFlowBlocker>(
            SavedDurationBlocker{{*owner_id}, std::chrono::milliseconds(*duration)});
    }
    d.error(k_variant, "Unknown blocker kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

template<class Id> bool contains_id(const std::vector<Id>& ids, const Id& id)
{
    return std::find(ids.begin(), ids.end(), id) != ids.end();
}

template<class Id, class Function>
bool duplicate_records(const std::vector<Id>& records, Function&& id, Diagnostics& diagnostics,
                       std::string_view code, std::string_view noun)
{
    std::unordered_set<std::string> seen;
    bool valid = true;
    for (const auto& record : records)
        if (!seen.insert(id(record).text()).second) {
            diagnostics.push_back(Diagnostic{.code = std::string(code),
                                             .message = "Duplicate " + std::string(noun) + " '" +
                                                        id(record).text() + "'."});
            valid = false;
        }
    return valid;
}

bool owner_exists(const CompiledProject& project, const PropertyOwnerRef& owner)
{
    return std::visit(
        [&project](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return project.find_room(id) != nullptr;
            else if constexpr (std::is_same_v<T, SceneId>)
                return project.find_scene(id) != nullptr;
            else if constexpr (std::is_same_v<T, DialogueId>)
                return project.find_dialogue(id) != nullptr;
            else if constexpr (std::is_same_v<T, CharacterId>)
                return project.find_character(id) != nullptr;
            else if constexpr (std::is_same_v<T, InteractableId>)
                return project.find_interactable(id) != nullptr;
            else if constexpr (std::is_same_v<T, VerbId>)
                return project.find_verb(id) != nullptr;
            else if constexpr (std::is_same_v<T, InteractionId>)
                return project.find_interaction(id) != nullptr;
            else
                return project.find_map(id) != nullptr;
        },
        owner);
}

template<class T> const auto* instruction_by_id(const std::vector<T>& values, const auto& id)
{
    const auto found = std::find_if(values.begin(), values.end(), [&id](const T& value) {
        return std::visit([&id](const auto& item) { return item.id == id; }, value);
    });
    return found == values.end() ? nullptr : &*found;
}

bool has_scene_step(const compiled::SceneDefinition& scene, const SceneStepId& id)
{
    return instruction_by_id(scene.program.instructions, id) != nullptr;
}

const compiled::ChoiceSceneInstruction* scene_choice(const compiled::SceneDefinition& scene,
                                                     const SceneStepId& id)
{
    const auto* instruction = instruction_by_id(scene.program.instructions, id);
    return instruction ? std::get_if<compiled::ChoiceSceneInstruction>(instruction) : nullptr;
}

const compiled::DialogueBlock* dialogue_block(const compiled::DialogueDefinition& dialogue,
                                              const DialogueBlockId& id)
{
    const auto found = std::find_if(
        dialogue.program.blocks.begin(), dialogue.program.blocks.end(),
        [&id](const compiled::DialogueBlock& block) {
            return std::visit([&id](const auto& item) { return item.id == id; }, block);
        });
    return found == dialogue.program.blocks.end() ? nullptr : &*found;
}

const compiled::DialogueSegment* dialogue_segment(const compiled::DialogueBlock& block,
                                                  const DialogueSegmentId& id)
{
    const auto* sequence = std::get_if<compiled::DialogueSequenceBlock>(&block);
    if (!sequence)
        return nullptr;
    return instruction_by_id(sequence->segments, id);
}

const compiled::DialogueEdge* dialogue_edge(const compiled::DialogueDefinition& dialogue,
                                            const DialogueEdgeId& id)
{
    const auto found =
        std::find_if(dialogue.program.edges.begin(), dialogue.program.edges.end(),
                     [&id](const compiled::DialogueEdge& edge) {
                         return std::visit([&id](const auto& item) { return item.id == id; }, edge);
                     });
    return found == dialogue.program.edges.end() ? nullptr : &*found;
}

const compiled::InteractionProgram* interaction_program(const CompiledProject& project,
                                                        const InteractionProgramRef& reference)
{
    return std::visit(
        [&project](const auto& item) -> const compiled::InteractionProgram* {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, InteractionRuleProgramRef>) {
                const auto* interaction = project.find_interaction(item.interaction);
                if (!interaction)
                    return nullptr;
                const auto found =
                    std::find_if(interaction->rules.begin(), interaction->rules.end(),
                                 [&item](const compiled::InteractionRule& rule) {
                                     return rule.id == item.rule;
                                 });
                return found == interaction->rules.end() ? nullptr : &found->program;
            } else {
                const auto* verb = project.find_verb(item.verb);
                return verb ? &verb->default_program : nullptr;
            }
        },
        reference);
}

bool has_interaction_instruction(const compiled::InteractionProgram& program,
                                 const InteractionInstructionId& id)
{
    return instruction_by_id(program.instructions, id) != nullptr;
}

bool valid_location(const CompiledProject& project, const InteractableId& interactable,
                    const compiled::InteractableLocation& location)
{
    const auto* placement = std::get_if<compiled::RoomPlacementRef>(&location);
    if (!placement)
        return true;
    const auto* room = project.find_room(placement->room);
    if (!room)
        return false;
    const auto found = std::find_if(room->placements.begin(), room->placements.end(),
                                    [&placement](const compiled::RoomPlacement& item) {
                                        return item.id == placement->placement_id;
                                    });
    return found != room->placements.end() && found->interactable == interactable;
}

bool valid_destination(const CompiledProject& project, const ReturnDestination& destination)
{
    if (const auto* room = std::get_if<ResumeRoomDestination>(&destination))
        return project.find_room(room->room) != nullptr;
    return true;
}

bool value_matches_type(const PropertyValueType& type, const RuntimeValue& value)
{
    if (!runtime_value_is_finite(value) || std::holds_alternative<std::monostate>(value))
        return false;
    return std::visit(
        [&value](const auto& item) {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, BooleanPropertyType>)
                return std::holds_alternative<bool>(value);
            else if constexpr (std::is_same_v<T, IntegerPropertyType>)
                return std::holds_alternative<std::int64_t>(value);
            else if constexpr (std::is_same_v<T, NumberPropertyType>)
                return std::holds_alternative<std::int64_t>(value) ||
                       std::holds_alternative<double>(value);
            else if constexpr (std::is_same_v<T, StringPropertyType>)
                return std::holds_alternative<std::string>(value);
            else {
                const auto* string = std::get_if<std::string>(&value);
                return string != nullptr && std::find(item.values.begin(), item.values.end(),
                                                      *string) != item.values.end();
            }
        },
        type);
}

std::string owner_text(const PropertyOwnerRef& owner)
{
    return std::visit([](const auto& id) { return id.text(); }, owner);
}

bool valid_scene_position(const compiled::SceneDefinition& scene,
                          const SceneFramePosition& position)
{
    if (position.next_step && !has_scene_step(scene, *position.next_step))
        return false;
    return std::visit(
        [&scene, &position](const auto& item) {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, SceneStepReady>)
                return true;
            else if constexpr (std::is_same_v<T, SceneInstructionCompletionPosition>)
                return position.next_step &&
                       (!item.next_step || has_scene_step(scene, *item.next_step));
            else if constexpr (std::is_same_v<T, SceneAutosavePendingPosition>)
                return position.next_step == item.completed_step &&
                       (!item.next_step || has_scene_step(scene, *item.next_step));
            else if constexpr (std::is_same_v<T, SceneChoiceSelectionPosition>)
                return position.next_step && scene_choice(scene, *position.next_step) != nullptr;
            else {
                const auto* choice =
                    position.next_step ? scene_choice(scene, *position.next_step) : nullptr;
                if (!choice)
                    return false;
                const auto found = std::find_if(choice->options.begin(), choice->options.end(),
                                                [&item](const compiled::SceneChoiceOption& option) {
                                                    return option.id == item.option;
                                                });
                return found != choice->options.end() &&
                       item.next_effect <= found->effects.size() &&
                       (!item.awaiting_completion || item.next_effect < found->effects.size());
            }
        },
        position.substate);
}

bool valid_dialogue_position(const compiled::DialogueDefinition& dialogue,
                             const DialogueFramePosition& position)
{
    const auto* block = dialogue_block(dialogue, position.block);
    if (!block || position.stage > DialogueFramePosition::Stage::Complete)
        return false;
    const auto* segment = position.segment ? dialogue_segment(*block, *position.segment) : nullptr;
    const auto* edge = position.edge ? dialogue_edge(dialogue, *position.edge) : nullptr;
    if ((position.segment && !segment) ||
        (position.edge &&
         (!edge ||
          std::visit([&position](const auto& item) { return item.from_block_id != position.block; },
                     *edge))))
        return false;
    switch (position.stage) {
    case DialogueFramePosition::Stage::EnterBlock:
    case DialogueFramePosition::Stage::Complete:
        return !position.segment && !position.edge && position.next_effect == 0 &&
               !position.awaiting_completion;
    case DialogueFramePosition::Stage::PresentSegment:
        return segment && !position.edge && position.next_effect == 0 &&
               (!position.awaiting_completion ||
                std::holds_alternative<compiled::DialogueRunLuaSegment>(*segment));
    case DialogueFramePosition::Stage::ApplySegmentEffects: {
        const auto* line = segment ? std::get_if<compiled::DialogueLineSegment>(segment) : nullptr;
        return line && !position.edge && position.next_effect <= line->effects.size() &&
               (!position.awaiting_completion || position.next_effect < line->effects.size());
    }
    case DialogueFramePosition::Stage::PresentChoices:
        return std::holds_alternative<compiled::DialogueChoiceBlock>(*block) && !position.segment &&
               !position.edge && position.next_effect == 0;
    case DialogueFramePosition::Stage::ApplyChoiceEffects: {
        const auto* choice = edge ? std::get_if<compiled::DialogueChoiceEdge>(edge) : nullptr;
        return choice && !position.segment && position.next_effect <= choice->effects.size() &&
               (!position.awaiting_completion || position.next_effect < choice->effects.size());
    }
    case DialogueFramePosition::Stage::FollowEdge:
        return edge && !position.segment && position.next_effect == 0 &&
               !position.awaiting_completion;
    }
    return false;
}

std::size_t hook_effects(const CompiledProject& project, const SavedRoomTransitionFrame& frame,
                         RoomTransitionStage stage)
{
    const compiled::RoomDefinition* room = nullptr;
    std::optional<compiled::RoomHookKind> hook;
    switch (stage) {
    case RoomTransitionStage::BeforeLeave:
        room = frame.source_room ? project.find_room(*frame.source_room) : nullptr;
        hook = compiled::RoomHookKind::BeforeLeave;
        break;
    case RoomTransitionStage::BeforeEnter:
        room = project.find_room(frame.target_room);
        hook = compiled::RoomHookKind::BeforeEnter;
        break;
    case RoomTransitionStage::AfterLeave:
        room = frame.source_room ? project.find_room(*frame.source_room) : nullptr;
        hook = compiled::RoomHookKind::AfterLeave;
        break;
    case RoomTransitionStage::AfterEnter:
        room = project.find_room(frame.target_room);
        hook = compiled::RoomHookKind::AfterEnter;
        break;
    default:
        return 0;
    }
    if (!room || !hook)
        return 0;
    const auto found = std::find_if(
        room->lifecycle.hooks.begin(), room->lifecycle.hooks.end(),
        [&hook](const compiled::RoomHookProgram& program) { return program.hook == *hook; });
    return found == room->lifecycle.hooks.end() ? 0 : found->effects.size();
}

bool valid_room_position(const CompiledProject& project, const SavedRoomTransitionFrame& frame)
{
    const auto& position = frame.position;
    if (position.stage > RoomTransitionStage::Complete)
        return false;
    switch (position.stage) {
    case RoomTransitionStage::BeforeLeave:
    case RoomTransitionStage::BeforeEnter:
    case RoomTransitionStage::AfterLeave:
    case RoomTransitionStage::AfterEnter: {
        const auto count = hook_effects(project, frame, position.stage);
        return position.next_effect <= count &&
               (!position.awaiting_completion || position.next_effect < count);
    }
    default:
        return position.next_effect == 0 && !position.awaiting_completion;
    }
}

} // namespace

Result<nlohmann::json, Diagnostics> encode_save_state(const CompiledProject& project,
                                                      const SaveState& save)
{
    auto validation = validate_save_state(project, save);
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

Result<SaveState, Diagnostics> decode_save_state_wire(const nlohmann::json& document,
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

Result<void, Diagnostics> validate_save_state(const CompiledProject& project, const SaveState& save,
                                              std::string source_path)
{
    Diagnostics diagnostics;
    const auto error = [&diagnostics, &source_path](std::string code, std::string message) {
        diagnostics.push_back(Diagnostic{
            .code = std::move(code), .message = std::move(message), .source_path = source_path});
    };
    if (save.metadata.format_version != SaveStateMetadata::current_format_version)
        error("save_codec.unsupported_version", "Save format version is unsupported.");
    if (save.metadata.project != project.identity().id ||
        save.metadata.project_version != project.identity().version)
        error("save_codec.project_mismatch", "Save metadata does not match the loaded project.");
    if (save.play_time.count() < 0)
        error("save_codec.invalid_time", "Play time cannot be negative.");
    std::unordered_set<std::string> variable_ids;
    for (const auto& item : save.variables) {
        const auto* definition = project.find_variable(item.id);
        if (!variable_ids.insert(item.id.text()).second)
            error("save_codec.duplicate_record", "Variable appears more than once.");
        if (!definition)
            error("save_codec.invalid_reference", "Save references an unknown variable.");
        else if (!value_matches_type(definition->value_type, item.value))
            error("save_codec.invalid_value", "Variable value does not match its declaration.");
    }
    if (save.variables.size() != project.variables().size())
        error("save_codec.incomplete_variables", "Save must contain every declared variable.");
    std::unordered_set<std::string> overrides;
    for (const auto& item : save.property_overrides) {
        const auto key = std::to_string(item.owner.index()) + ":" + owner_text(item.owner) + ":" +
                         item.property.text();
        const auto* definition = project.find_property(item.property);
        if (!overrides.insert(key).second)
            error("save_codec.duplicate_record", "Property override appears more than once.");
        if (!owner_exists(project, item.owner) || !definition ||
            definition->persistence() != PropertyPersistence::Save ||
            !make_property_override(item.owner, *definition, item.value))
            error("save_codec.invalid_property_override",
                  "Property override is not permitted by the loaded project.");
    }
    std::unordered_set<std::string> interactables;
    for (const auto& item : save.interactables) {
        if (!interactables.insert(item.interactable.text()).second)
            error("save_codec.duplicate_record", "Interactable state appears more than once.");
        if (!project.find_interactable(item.interactable) ||
            !valid_location(project, item.interactable, item.location))
            error("save_codec.invalid_interactable",
                  "Interactable state has an invalid reference or location.");
    }
    if (save.interactables.size() != project.interactables().size())
        error("save_codec.incomplete_interactables",
              "Save must contain every compiled Interactable.");
    std::unordered_set<std::string> room_history;
    for (const auto& item : save.room_visits) {
        if (!room_history.insert(item.room.text()).second || !project.find_room(item.room))
            error("save_codec.invalid_room_history", "Room history is duplicate or stale.");
    }
    std::unordered_set<std::string> line_history;
    for (const auto& item : save.dialogue_line_history) {
        const auto* dialogue = project.find_dialogue(item.key.dialogue);
        bool found = false;
        if (dialogue)
            for (const auto& block_item : dialogue->program.blocks)
                if (dialogue_segment(block_item, item.key.segment))
                    found = true;
        const auto key = item.key.dialogue.text() + ":" + item.key.segment.text();
        if (!line_history.insert(key).second || !found)
            error("save_codec.invalid_dialogue_history",
                  "Dialogue line history is duplicate or stale.");
    }
    std::unordered_set<std::string> choice_history;
    for (const auto& item : save.dialogue_choice_history) {
        const auto* dialogue = project.find_dialogue(item.key.dialogue);
        const auto* edge = dialogue ? dialogue_edge(*dialogue, item.key.edge) : nullptr;
        const auto key = item.key.dialogue.text() + ":" + item.key.edge.text();
        if (!choice_history.insert(key).second || !edge ||
            !std::holds_alternative<compiled::DialogueChoiceEdge>(*edge))
            error("save_codec.invalid_dialogue_history",
                  "Dialogue choice history is duplicate or stale.");
    }
    for (const auto& entry : save.text_log) {
        if (entry.kind > TextLogEntryKind::Notification || entry.markup > TextMarkup::ActiveText) {
            error("save_codec.invalid_text_log", "Text log entry has an invalid discriminant.");
            continue;
        }
        bool origin_ok = std::visit(
            [&project](const auto& item) {
                using T = std::decay_t<decltype(item)>;
                if constexpr (std::is_same_v<T, SystemTextLogOrigin>)
                    return true;
                else if constexpr (std::is_same_v<T, SceneTextLogOrigin>) {
                    const auto* scene = project.find_scene(item.scene);
                    return scene && has_scene_step(*scene, item.step);
                } else if constexpr (std::is_same_v<T, DialogueLineTextLogOrigin>) {
                    const auto* dialogue = project.find_dialogue(item.dialogue);
                    if (!dialogue)
                        return false;
                    for (const auto& block : dialogue->program.blocks)
                        if (dialogue_segment(block, item.segment))
                            return true;
                    return false;
                } else if constexpr (std::is_same_v<T, DialogueChoiceTextLogOrigin>) {
                    const auto* dialogue = project.find_dialogue(item.dialogue);
                    return dialogue && dialogue_edge(*dialogue, item.edge) &&
                           std::holds_alternative<compiled::DialogueChoiceEdge>(
                               *dialogue_edge(*dialogue, item.edge));
                } else {
                    const auto* interaction = project.find_interaction(item.interaction);
                    if (!interaction)
                        return false;
                    for (const auto& rule : interaction->rules)
                        if (has_interaction_instruction(rule.program, item.instruction))
                            return true;
                    return false;
                }
            },
            entry.origin);
        if (!origin_ok || (entry.speaker && !project.find_character(*entry.speaker)))
            error("save_codec.invalid_text_log", "Text log entry has a stale origin or speaker.");
    }
    std::unordered_set<std::uint64_t> timer_ids;
    for (const auto& item : save.logical_timers)
        if (item.id.value == 0 || item.remaining.count() < 0 ||
            (item.repeat_interval && item.repeat_interval->count() <= 0) ||
            !timer_ids.insert(item.id.value).second)
            error("save_codec.invalid_timer", "Logical timer record is invalid or duplicated.");
    std::unordered_set<std::uint64_t> completion_ids;
    for (const auto& item : save.pending_timer_completions)
        if (item.id.value == 0 || item.occurrences == 0 ||
            !completion_ids.insert(item.id.value).second)
            error("save_codec.invalid_timer", "Timer completion record is invalid or duplicated.");
    const bool flow_mode = std::holds_alternative<FlowMode>(save.mode);
    if (flow_mode != !save.flow_stack.empty())
        error("save_codec.incoherent_flow", "Runtime mode and flow stack do not agree.");
    if (const auto* room = std::get_if<RoomMode>(&save.mode);
        room && !project.find_room(room->room))
        error("save_codec.invalid_reference", "Room mode references an unknown Room.");
    std::unordered_set<std::uint64_t> frame_ids;
    for (std::size_t item_index = 0; item_index < save.flow_stack.size(); ++item_index) {
        const auto& frame = save.flow_stack[item_index];
        const auto valid = std::visit(
            [&project](const auto& item) {
                using T = std::decay_t<decltype(item)>;
                if (!valid_destination(project, item.destination))
                    return false;
                if constexpr (std::is_same_v<T, SavedSceneFrame>) {
                    const auto* scene = project.find_scene(item.scene);
                    return scene && valid_scene_position(*scene, item.position);
                } else if constexpr (std::is_same_v<T, SavedDialogueFrame>) {
                    const auto* dialogue = project.find_dialogue(item.dialogue);
                    return dialogue && valid_dialogue_position(*dialogue, item.position);
                } else if constexpr (std::is_same_v<T, SavedInteractionFrame>) {
                    const auto* program = interaction_program(project, item.program);
                    const auto* verb = project.find_verb(item.invocation.verb);
                    return program && verb && item.invocation.operands.size() == verb->arity &&
                           std::all_of(item.invocation.operands.begin(),
                                       item.invocation.operands.end(),
                                       [&project](const InteractableId& id) {
                                           return project.find_interactable(id) != nullptr;
                                       }) &&
                           (!item.position.next_instruction ||
                            has_interaction_instruction(*program,
                                                        *item.position.next_instruction)) &&
                           item.position.fallback_stage <= InteractionFallbackStage::Complete &&
                           item.position.outcome <= InteractionExecutionOutcome::Failed &&
                           (!item.position.awaiting_completion ||
                            item.position.next_instruction.has_value());
                } else {
                    if (!project.find_room(item.target_room) ||
                        (item.source_room && !project.find_room(*item.source_room)) ||
                        !valid_room_position(project, item))
                        return false;
                    if (!item.selected_exit)
                        return !item.source_room;
                    const auto* room = project.find_room(item.selected_exit->room);
                    if (!room)
                        return false;
                    const auto found =
                        std::find_if(room->exits.begin(), room->exits.end(),
                                     [&item](const compiled::RoomExit& exit) {
                                         return exit.id == item.selected_exit->exit_id;
                                     });
                    return item.source_room && item.selected_exit->room == *item.source_room &&
                           found != room->exits.end() && found->target == item.target_room;
                }
            },
            frame);
        const auto snapshot =
            std::visit([](const auto& value) { return value.snapshot_id.value; }, frame);
        if (snapshot == 0 || !frame_ids.insert(snapshot).second || !valid)
            error("save_codec.invalid_flow_frame",
                  "Flow frame is stale, duplicate, or incoherent.");
        const auto destination = std::visit(
            [](const auto& value) -> const ReturnDestination& { return value.destination; }, frame);
        if (item_index == 0 ? !std::holds_alternative<NoReturnDestination>(destination)
                            : std::holds_alternative<NoReturnDestination>(destination))
            error("save_codec.incoherent_flow", "Flow return destinations are incoherent.");
    }
    if (save.blocker) {
        const auto owner =
            std::visit([](const auto& value) { return value.owner.value; }, *save.blocker);
        const auto top = save.flow_stack.empty()
                             ? 0
                             : std::visit([](const auto& value) { return value.snapshot_id.value; },
                                          save.flow_stack.back());
        const bool valid_duration = std::visit(
            [](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, SavedDurationBlocker>)
                    return value.remaining.count() > 0;
                else
                    return true;
            },
            *save.blocker);
        const bool valid =
            owner == top && std::holds_alternative<FlowMode>(save.mode) && valid_duration;
        if (!valid)
            error("save_codec.invalid_blocker",
                  "Saved blocker does not belong to the active top frame.");
    }
    return diagnostics.empty() ? Result<void, Diagnostics>::success()
                               : Result<void, Diagnostics>::failure(std::move(diagnostics));
}

Result<SaveState, Diagnostics> decode_save_state(const CompiledProject& project,
                                                 const nlohmann::json& document,
                                                 std::string source_path)
{
    auto decoded = decode_save_state_wire(document, source_path);
    if (!decoded)
        return decoded;
    const auto* save = decoded.value_if();
    auto validation = validate_save_state(project, *save, std::move(source_path));
    return validation ? decoded : Result<SaveState, Diagnostics>::failure(validation.error());
}

} // namespace noveltea::core
