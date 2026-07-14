#include "noveltea/core/editor_runtime_protocol.hpp"

#include "noveltea/core/json_access.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <string>
#include <type_traits>
#include <utility>

namespace noveltea::core::editor {
namespace {

template<typename> inline constexpr bool always_false = false;

Diagnostic error(std::string code, std::string message, std::string path = {})
{
    return Diagnostic{
        .code = std::move(code), .message = std::move(message), .source_path = std::move(path)};
}

std::optional<std::uint64_t> nonnegative_integer(const nlohmann::json& value) noexcept
{
    return json_access::get<std::uint64_t>(value);
}

bool valid_utf8(std::string_view text) noexcept
{
    const auto* bytes = reinterpret_cast<const unsigned char*>(text.data());
    std::size_t index = 0;
    while (index < text.size()) {
        const unsigned char lead = bytes[index++];
        if (lead <= 0x7f)
            continue;
        std::size_t continuation = 0;
        std::uint32_t value = 0;
        if ((lead & 0xe0) == 0xc0) {
            continuation = 1;
            value = lead & 0x1f;
        } else if ((lead & 0xf0) == 0xe0) {
            continuation = 2;
            value = lead & 0x0f;
        } else if ((lead & 0xf8) == 0xf0) {
            continuation = 3;
            value = lead & 0x07;
        } else {
            return false;
        }
        if (index + continuation > text.size())
            return false;
        for (std::size_t offset = 0; offset < continuation; ++offset) {
            const unsigned char byte = bytes[index++];
            if ((byte & 0xc0) != 0x80)
                return false;
            value = (value << 6) | (byte & 0x3f);
        }
        if ((continuation == 1 && value < 0x80) || (continuation == 2 && value < 0x800) ||
            (continuation == 3 && value < 0x10000) || value > 0x10ffff ||
            (value >= 0xd800 && value <= 0xdfff))
            return false;
    }
    return true;
}

bool exact_fields(const nlohmann::json& value, std::initializer_list<std::string_view> allowed,
                  Diagnostics& diagnostics, std::string_view path)
{
    if (!value.is_object()) {
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "Expected an object.", std::string(path)));
        return false;
    }
    for (const auto& [key, unused] : value.items()) {
        (void)unused;
        if (std::none_of(allowed.begin(), allowed.end(),
                         [&](std::string_view item) { return item == key; })) {
            diagnostics.push_back(error("editor_protocol.unknown_field",
                                        "Unknown field '" + key + "'.",
                                        std::string(path) + "/" + key));
        }
    }
    return diagnostics.empty();
}

std::optional<std::string> string_field(const nlohmann::json& object, std::string_view key,
                                        Diagnostics& diagnostics, std::string_view path,
                                        const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_string()) {
        diagnostics.push_back(error("editor_protocol.wrong_type", "Expected a string.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    const auto value = *json_access::get<std::string>(*found);
    if (value.size() > limits.max_string_bytes) {
        diagnostics.push_back(error("editor_protocol.size_limit", "String exceeds size limit.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    if (!valid_utf8(value)) {
        diagnostics.push_back(error("editor_protocol.invalid_utf8", "String is not valid UTF-8.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    return value;
}

template<class Id>
std::optional<Id> id_field(const nlohmann::json& object, std::string_view key,
                           Diagnostics& diagnostics, std::string_view path,
                           const EditorRuntimeProtocolLimits& limits)
{
    auto value = string_field(object, key, diagnostics, path, limits);
    if (!value)
        return std::nullopt;
    auto id = Id::create(std::move(*value));
    if (!id) {
        diagnostics.push_back(error("editor_protocol.invalid_id", "Invalid stable ID.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    return std::move(*id.value_if());
}

std::optional<PropertyOwnerRef> property_owner_field(const nlohmann::json& object,
                                                     std::string_view key, Diagnostics& diagnostics,
                                                     std::string_view path,
                                                     const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    const auto owner_path = std::string(path) + "/" + std::string(key);
    if (found == object.end() || !found->is_object()) {
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "Expected an owner object.", owner_path));
        return std::nullopt;
    }
    exact_fields(*found, {"kind", "id"}, diagnostics, owner_path);
    auto kind = string_field(*found, "kind", diagnostics, owner_path, limits);
    if (!kind)
        return std::nullopt;

#define DECODE_OWNER(kind_text, id_type)                                                           \
    if (*kind == kind_text) {                                                                      \
        auto id = id_field<id_type>(*found, "id", diagnostics, owner_path, limits);                \
        return id ? std::optional<PropertyOwnerRef>{PropertyOwnerRef{std::move(*id)}}              \
                  : std::nullopt;                                                                  \
    }
    DECODE_OWNER("room", RoomId)
    DECODE_OWNER("scene", SceneId)
    DECODE_OWNER("dialogue", DialogueId)
    DECODE_OWNER("character", CharacterId)
    DECODE_OWNER("interactable", InteractableId)
    DECODE_OWNER("verb", VerbId)
    DECODE_OWNER("interaction", InteractionId)
    DECODE_OWNER("map", MapId)
#undef DECODE_OWNER

    diagnostics.push_back(error("editor_protocol.invalid_owner_kind",
                                "Unknown property owner kind.", owner_path + "/kind"));
    return std::nullopt;
}

std::optional<TypedSaveSlotId> save_slot_field(const nlohmann::json& object, std::string_view key,
                                               Diagnostics& diagnostics, std::string_view path,
                                               const EditorRuntimeProtocolLimits& limits)
{
    auto value = string_field(object, key, diagnostics, path, limits);
    if (!value)
        return std::nullopt;
    if (*value == "autosave")
        return TypedSaveSlotId::autosave();
    constexpr std::string_view prefix = "manual-";
    if (!value->starts_with(prefix) || value->size() == prefix.size()) {
        diagnostics.push_back(error("editor_protocol.invalid_save_slot",
                                    "Save slot must be 'autosave' or 'manual-N'.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    std::uint64_t number = 0;
    for (const char character : std::string_view(*value).substr(prefix.size())) {
        if (character < '0' || character > '9' ||
            number > (std::numeric_limits<std::uint32_t>::max() -
                      static_cast<std::uint64_t>(character - '0')) /
                         10) {
            diagnostics.push_back(error("editor_protocol.invalid_save_slot",
                                        "Manual save slot number is invalid.",
                                        std::string(path) + "/" + std::string(key)));
            return std::nullopt;
        }
        number = number * 10 + static_cast<std::uint64_t>(character - '0');
    }
    return TypedSaveSlotId::manual(static_cast<std::uint32_t>(number));
}

std::optional<RuntimeValue> runtime_value(const nlohmann::json& value, Diagnostics& diagnostics,
                                          std::string_view path,
                                          const EditorRuntimeProtocolLimits& limits)
{
    if (value.is_null())
        return RuntimeValue{std::monostate{}};
    if (value.is_boolean())
        return RuntimeValue{*json_access::get<bool>(value)};
    if (value.is_number_integer())
        return RuntimeValue{*json_access::get<std::int64_t>(value)};
    if (value.is_number_float()) {
        const auto number = *json_access::get<double>(value);
        if (!std::isfinite(number)) {
            diagnostics.push_back(
                error("editor_protocol.non_finite", "Number must be finite.", std::string(path)));
            return std::nullopt;
        }
        return RuntimeValue{number};
    }
    if (value.is_string()) {
        const auto text = *json_access::get<std::string>(value);
        if (text.size() > limits.max_string_bytes || !valid_utf8(text)) {
            diagnostics.push_back(error("editor_protocol.invalid_string",
                                        "String is invalid or exceeds the size limit.",
                                        std::string(path)));
            return std::nullopt;
        }
        return RuntimeValue{text};
    }
    diagnostics.push_back(
        error("editor_protocol.unsupported_value",
              "Runtime values must be null, boolean, integer, finite number, or string.",
              std::string(path)));
    return std::nullopt;
}

template<class Id>
std::optional<std::vector<Id>> id_array(const nlohmann::json& object, std::string_view key,
                                        Diagnostics& diagnostics, std::string_view path,
                                        const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_array()) {
        diagnostics.push_back(error("editor_protocol.wrong_type", "Expected an array.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    if (found->size() > limits.max_ids_per_input) {
        diagnostics.push_back(error("editor_protocol.size_limit", "ID array exceeds size limit.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    std::vector<Id> result;
    result.reserve(found->size());
    for (std::size_t index = 0; index < found->size(); ++index) {
        const auto& item = (*found)[index];
        const auto item_path =
            std::string(path) + "/" + std::string(key) + "/" + std::to_string(index);
        if (!item.is_string()) {
            diagnostics.push_back(
                error("editor_protocol.wrong_type", "Expected a string ID.", item_path));
            continue;
        }
        const auto text = *json_access::get<std::string>(item);
        if (text.size() > limits.max_string_bytes) {
            diagnostics.push_back(
                error("editor_protocol.size_limit", "ID exceeds size limit.", item_path));
            continue;
        }
        if (!valid_utf8(text)) {
            diagnostics.push_back(
                error("editor_protocol.invalid_utf8", "ID is not valid UTF-8.", item_path));
            continue;
        }
        auto id = Id::create(text);
        if (!id) {
            diagnostics.push_back(
                error("editor_protocol.invalid_id", "Invalid stable ID.", item_path));
            continue;
        }
        result.push_back(std::move(*id.value_if()));
    }
    if (!diagnostics.empty())
        return std::nullopt;
    return result;
}

Result<RuntimeInputMessage, Diagnostics>
decode_input_object(const nlohmann::json& document, const EditorRuntimeProtocolLimits& limits,
                    std::string_view path, bool require_envelope)
{
    Diagnostics diagnostics;
    const nlohmann::json* input = &document;
    if (require_envelope) {
        exact_fields(document, {"schema", "version", "input"}, diagnostics, path);
        const auto schema = document.find("schema");
        const auto version = document.find("version");
        const auto input_value = document.find("input");
        if (schema == document.end() || !schema->is_string() ||
            schema->get<std::string>() != runtime_input_schema) {
            diagnostics.push_back(error("editor_protocol.unsupported_schema",
                                        "Unsupported runtime input schema.", "/schema"));
        }
        const auto decoded_version = version == document.end() ? std::optional<std::uint64_t>{}
                                                               : nonnegative_integer(*version);
        if (!decoded_version || *decoded_version != editor_runtime_protocol_version) {
            diagnostics.push_back(error("editor_protocol.unsupported_version",
                                        "Unsupported runtime input version.", "/version"));
        }
        if (input_value == document.end()) {
            diagnostics.push_back(
                error("editor_protocol.missing_field", "Missing input.", "/input"));
        } else {
            input = &*input_value;
        }
    }
    if (!diagnostics.empty())
        return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));
    if (!input->is_object())
        return Result<RuntimeInputMessage, Diagnostics>::failure(Diagnostics{
            error("editor_protocol.wrong_type", "Input must be an object.", std::string(path))});
    auto type = string_field(*input, "type", diagnostics, path, limits);
    if (!type)
        return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));

    auto success = [](RuntimeInputMessage message) {
        return Result<RuntimeInputMessage, Diagnostics>::success(std::move(message));
    };
    if (*type == "start" || *type == "stop" || *type == "reset" || *type == "continue" ||
        *type == "clear-selection" || *type == "begin-playback" || *type == "end-playback" ||
        *type == "clear-playback" || *type == "undo-playback-step" || *type == "replay-playback") {
        exact_fields(*input, {"type"}, diagnostics, path);
        if (!diagnostics.empty())
            return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));
        if (*type == "start")
            return success(StartRuntimeInput{});
        if (*type == "stop")
            return success(StopRuntimeInput{});
        if (*type == "reset")
            return success(ResetRuntimeInput{});
        if (*type == "continue")
            return success(ContinueInput{});
        if (*type == "clear-selection")
            return success(ClearInteractableSelectionInput{});
        if (*type == "begin-playback")
            return success(BeginPlaybackInput{});
        if (*type == "end-playback")
            return success(EndPlaybackInput{});
        if (*type == "clear-playback")
            return success(ClearPlaybackInput{});
        if (*type == "undo-playback-step")
            return success(UndoPlaybackStepInput{});
        return success(ReplayPlaybackInput{});
    }
    if (*type == "advance-time") {
        exact_fields(*input, {"type", "microseconds"}, diagnostics, path);
        const auto found = input->find("microseconds");
        const auto duration =
            found == input->end() ? std::optional<std::uint64_t>{} : nonnegative_integer(*found);
        if (!duration ||
            *duration > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
            diagnostics.push_back(error("editor_protocol.invalid_duration",
                                        "microseconds must be a non-negative 64-bit integer.",
                                        std::string(path) + "/microseconds"));
        }
        if (!diagnostics.empty())
            return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));
        return success(
            AdvanceTimeInput{std::chrono::microseconds(static_cast<std::int64_t>(*duration))});
    }
    if (*type == "dialogue-choice") {
        exact_fields(*input, {"type", "edge"}, diagnostics, path);
        auto id = id_field<DialogueEdgeId>(*input, "edge", diagnostics, path, limits);
        if (id)
            return success(SelectDialogueChoiceInput{std::move(*id)});
    } else if (*type == "scene-choice") {
        exact_fields(*input, {"type", "option"}, diagnostics, path);
        auto id = id_field<SceneChoiceOptionId>(*input, "option", diagnostics, path, limits);
        if (id)
            return success(SelectSceneChoiceInput{std::move(*id)});
    } else if (*type == "navigate") {
        exact_fields(*input, {"type", "exit"}, diagnostics, path);
        auto id = id_field<RoomExitId>(*input, "exit", diagnostics, path, limits);
        if (id)
            return success(NavigateRoomInput{std::move(*id)});
    } else if (*type == "select-interactables") {
        exact_fields(*input, {"type", "interactables"}, diagnostics, path);
        auto ids = id_array<InteractableId>(*input, "interactables", diagnostics, path, limits);
        if (ids)
            return success(SelectInteractablesInput{std::move(*ids)});
    } else if (*type == "invoke-interaction") {
        exact_fields(*input, {"type", "verb", "operands"}, diagnostics, path);
        auto verb = id_field<VerbId>(*input, "verb", diagnostics, path, limits);
        auto operands = id_array<InteractableId>(*input, "operands", diagnostics, path, limits);
        if (verb && operands)
            return success(InvokeInteractionInput{std::move(*verb), std::move(*operands)});
    } else if (*type == "set-variable") {
        exact_fields(*input, {"type", "variable", "value"}, diagnostics, path);
        auto variable = id_field<VariableId>(*input, "variable", diagnostics, path, limits);
        const auto found = input->find("value");
        if (found == input->end())
            diagnostics.push_back(error("editor_protocol.missing_field", "Missing value.",
                                        std::string(path) + "/value"));
        auto value = found == input->end()
                         ? std::optional<RuntimeValue>{}
                         : runtime_value(*found, diagnostics, std::string(path) + "/value", limits);
        if (variable && value)
            return success(SetVariableDebugInput{std::move(*variable), std::move(*value)});
    } else if (*type == "set-property") {
        exact_fields(*input, {"type", "owner", "property", "value"}, diagnostics, path);
        auto owner = property_owner_field(*input, "owner", diagnostics, path, limits);
        auto property = id_field<PropertyId>(*input, "property", diagnostics, path, limits);
        const auto found = input->find("value");
        if (found == input->end())
            diagnostics.push_back(error("editor_protocol.missing_field", "Missing value.",
                                        std::string(path) + "/value"));
        auto value = found == input->end()
                         ? std::optional<RuntimeValue>{}
                         : runtime_value(*found, diagnostics, std::string(path) + "/value", limits);
        if (owner && property && value)
            return success(
                SetPropertyDebugInput{std::move(*owner), std::move(*property), std::move(*value)});
    } else if (*type == "save" || *type == "load") {
        exact_fields(*input, {"type", "slot"}, diagnostics, path);
        auto slot = save_slot_field(*input, "slot", diagnostics, path, limits);
        if (slot) {
            if (*type == "save")
                return success(SaveRuntimeInput{std::move(*slot)});
            return success(LoadRuntimeInput{std::move(*slot)});
        }
    } else {
        diagnostics.push_back(error("editor_protocol.unknown_input", "Unknown runtime input type.",
                                    std::string(path) + "/type"));
    }
    return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));
}

nlohmann::json encode_view(const TypedRuntimeUIViewState& view)
{
    nlohmann::json out = {{"mode", view.mode},
                          {"gameplayPaused", view.gameplay_paused},
                          {"canContinue", view.can_continue},
                          {"selectedInteractables", nlohmann::json::array()},
                          {"inventory", nlohmann::json::array()},
                          {"textLog", nlohmann::json::array()}};
    for (const auto& id : view.selected_interactables)
        out["selectedInteractables"].push_back(id.text());
    for (const auto& item : view.inventory.items) {
        out["inventory"].push_back({{"id", item.interactable.text()},
                                    {"label", item.display_name},
                                    {"enabled", item.enabled},
                                    {"visible", item.visible}});
    }
    for (const auto& entry : view.text_log.entries)
        out["textLog"].push_back(entry.text);
    if (view.room) {
        out["room"] = {{"id", view.room->room.text()},
                       {"visits", view.room->visits},
                       {"description", view.room->description},
                       {"exits", nlohmann::json::array()},
                       {"placements", nlohmann::json::array()}};
        for (const auto& exit : view.room->exits)
            out["room"]["exits"].push_back({{"id", exit.exit.text()},
                                            {"target", exit.target.text()},
                                            {"label", exit.label},
                                            {"enabled", exit.enabled}});
        for (const auto& placement : view.room->placements)
            out["room"]["placements"].push_back({{"id", placement.placement.text()},
                                                 {"interactable", placement.interactable.text()},
                                                 {"enabled", placement.enabled},
                                                 {"visible", placement.visible}});
    }
    if (view.dialogue)
        out["dialogue"] = {{"id", view.dialogue->dialogue.text()},
                           {"hasLine", view.dialogue->line.has_value()},
                           {"hasChoice", view.dialogue->choice.has_value()}};
    if (view.scene)
        out["scene"] = {{"id", view.scene->scene.text()},
                        {"hasText", view.scene->text.has_value()},
                        {"hasChoice", view.scene->choice.has_value()}};
    if (view.interaction)
        out["interaction"] = {{"verb", view.interaction->verb.text()},
                              {"operands", nlohmann::json::array()}};
    if (view.interaction)
        for (const auto& operand : view.interaction->operands)
            out["interaction"]["operands"].push_back(operand.text());
    return out;
}

std::string severity_name(ErrorSeverity severity)
{
    switch (severity) {
    case ErrorSeverity::Info:
        return "info";
    case ErrorSeverity::Warning:
        return "warning";
    case ErrorSeverity::Error:
        return "error";
    case ErrorSeverity::Fatal:
        return "fatal";
    }
    return "error";
}

nlohmann::json encode_diagnostic(const Diagnostic& diagnostic)
{
    return {{"severity", severity_name(diagnostic.severity)},
            {"code", diagnostic.code},
            {"message", diagnostic.message},
            {"sourcePath", diagnostic.source_path}};
}

nlohmann::json encode_output(const RuntimeOutputMessage& output)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RuntimeViewPublication>)
                return {{"type", "view-publication"}, {"view", encode_view(value.view)}};
            else if constexpr (std::is_same_v<T, PresentationOperation>)
                return {{"type", "presentation-operation"}};
            else if constexpr (std::is_same_v<T, AudioOperation>)
                return {{"type", "audio-operation"}, {"operation", value.id.number()}};
            else if constexpr (std::is_same_v<T, TypedHostRequest>)
                return {{"type", "host-request"}};
            else if constexpr (std::is_same_v<T, UserCommunicationOutput>) {
                return std::visit(
                    [](const auto& message) -> nlohmann::json {
                        using M = std::decay_t<decltype(message)>;
                        if constexpr (std::is_same_v<M, NotificationOutput>)
                            return {{"type", "notification"}, {"message", message.message}};
                        else if constexpr (std::is_same_v<M, TextLogOutput>)
                            return {{"type", "text-log"}, {"text", message.text}};
                        else
                            static_assert(always_false<M>,
                                          "Unhandled UserCommunicationOutput alternative");
                    },
                    value);
            } else if constexpr (std::is_same_v<T, SaveOutcome>) {
                std::string status;
                switch (value.status) {
                case SaveOutcomeStatus::Saved:
                    status = "saved";
                    break;
                case SaveOutcomeStatus::Loaded:
                    status = "loaded";
                    break;
                case SaveOutcomeStatus::Deleted:
                    status = "deleted";
                    break;
                case SaveOutcomeStatus::Failed:
                    status = "failed";
                    break;
                }
                const std::string slot = value.slot.is_autosave()
                                             ? "autosave"
                                             : "manual-" + std::to_string(value.slot.number());
                return {{"type", "save-outcome"},
                        {"slot", slot},
                        {"status", std::move(status)},
                        {"autosave", value.autosave}};
            } else if constexpr (std::is_same_v<T, RuntimeObservation>) {
                return std::visit(
                    [](const auto& observation) -> nlohmann::json {
                        using O = std::decay_t<decltype(observation)>;
                        if constexpr (std::is_same_v<O, PlaybackObservation>)
                            return {{"type", "playback-observation"},
                                    {"stepIndex", observation.step_index},
                                    {"handled", observation.handled}};
                        else if constexpr (std::is_same_v<O, DebuggerObservation>)
                            return {{"type", "debugger-observation"},
                                    {"hasActiveFrame", observation.active_frame.has_value()}};
                        else if constexpr (std::is_same_v<O, RuntimeStateObservation>)
                            return {{"type", "runtime-state-observation"},
                                    {"hasActiveFrame", observation.active_frame.has_value()},
                                    {"blocked", observation.blocker.has_value()}};
                        else
                            static_assert(always_false<O>,
                                          "Unhandled RuntimeObservation alternative");
                    },
                    value);
            } else if constexpr (std::is_same_v<T, Diagnostic>)
                return {{"type", "diagnostic"}, {"diagnostic", encode_diagnostic(value)}};
            else
                static_assert(always_false<T>, "Unhandled RuntimeOutputMessage alternative");
        },
        output);
}

} // namespace

Result<RuntimeInputMessage, Diagnostics>
decode_editor_runtime_input(const nlohmann::json& document,
                            const EditorRuntimeProtocolLimits& limits)
{
    return decode_input_object(document, limits, "/input", true);
}

Result<RuntimeInputMessage, Diagnostics>
decode_editor_runtime_input_text(std::string_view text, const EditorRuntimeProtocolLimits& limits)
{
    if (text.size() > limits.max_document_bytes)
        return Result<RuntimeInputMessage, Diagnostics>::failure(
            Diagnostics{error("editor_protocol.size_limit", "Document exceeds size limit.")});
    auto document = nlohmann::json::parse(text, nullptr, false);
    if (document.is_discarded())
        return Result<RuntimeInputMessage, Diagnostics>::failure(
            Diagnostics{error("editor_protocol.malformed_json", "Malformed JSON document.")});
    return decode_editor_runtime_input(document, limits);
}

Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback(const nlohmann::json& document, const EditorRuntimeProtocolLimits& limits)
{
    Diagnostics diagnostics;
    exact_fields(document, {"schema", "version", "id", "steps"}, diagnostics, "/");
    const auto schema = document.find("schema");
    const auto version = document.find("version");
    if (schema == document.end() || !schema->is_string() ||
        schema->get<std::string>() != playback_schema)
        diagnostics.push_back(
            error("editor_protocol.unsupported_schema", "Unsupported playback schema.", "/schema"));
    const auto decoded_version =
        version == document.end() ? std::optional<std::uint64_t>{} : nonnegative_integer(*version);
    if (!decoded_version || *decoded_version != editor_runtime_protocol_version)
        diagnostics.push_back(error("editor_protocol.unsupported_version",
                                    "Unsupported playback version.", "/version"));
    auto id = string_field(document, "id", diagnostics, "/", limits);
    const auto steps = document.find("steps");
    if (steps == document.end() || !steps->is_array())
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "steps must be an array.", "/steps"));
    else if (steps->size() > limits.max_steps)
        diagnostics.push_back(
            error("editor_protocol.size_limit", "Too many playback steps.", "/steps"));
    TypedPlaybackSpec spec;
    if (id)
        spec.id = std::move(*id);
    if (steps != document.end() && steps->is_array() && steps->size() <= limits.max_steps) {
        std::set<std::uint64_t> indexes;
        for (std::size_t position = 0; position < steps->size(); ++position) {
            const auto path = "/steps/" + std::to_string(position);
            const auto& step = (*steps)[position];
            Diagnostics step_diagnostics;
            exact_fields(step, {"index", "input"}, step_diagnostics, path);
            const auto index = step.find("index");
            const auto decoded_index =
                index == step.end() ? std::optional<std::uint64_t>{} : nonnegative_integer(*index);
            if (!decoded_index || !indexes.insert(*decoded_index).second)
                step_diagnostics.push_back(error("editor_protocol.invalid_step_index",
                                                 "Step index must be a unique unsigned integer.",
                                                 path + "/index"));
            const auto input = step.find("input");
            if (input == step.end())
                step_diagnostics.push_back(
                    error("editor_protocol.missing_field", "Missing input.", path + "/input"));
            else {
                auto decoded = decode_input_object(*input, limits, path + "/input", false);
                if (decoded && decoded_index)
                    spec.steps.push_back({*decoded_index, std::move(*decoded.value_if())});
                else if (!decoded)
                    step_diagnostics.insert(step_diagnostics.end(), decoded.error().begin(),
                                            decoded.error().end());
            }
            diagnostics.insert(diagnostics.end(), step_diagnostics.begin(), step_diagnostics.end());
        }
    }
    if (!diagnostics.empty())
        return Result<TypedPlaybackSpec, Diagnostics>::failure(std::move(diagnostics));
    return Result<TypedPlaybackSpec, Diagnostics>::success(std::move(spec));
}

Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback_text(std::string_view text, const EditorRuntimeProtocolLimits& limits)
{
    if (text.size() > limits.max_document_bytes)
        return Result<TypedPlaybackSpec, Diagnostics>::failure(
            Diagnostics{error("editor_protocol.size_limit", "Document exceeds size limit.")});
    auto document = nlohmann::json::parse(text, nullptr, false);
    if (document.is_discarded())
        return Result<TypedPlaybackSpec, Diagnostics>::failure(
            Diagnostics{error("editor_protocol.malformed_json", "Malformed JSON document.")});
    return decode_editor_playback(document, limits);
}

nlohmann::json encode_editor_playback_report(std::string_view id,
                                             const std::vector<TypedPlaybackStepReport>& steps,
                                             const TypedRuntimeUIViewState& final_view, bool passed)
{
    nlohmann::json result = {{"schema", playback_report_schema},
                             {"version", editor_runtime_protocol_version},
                             {"id", id},
                             {"passed", passed},
                             {"steps", nlohmann::json::array()},
                             {"finalView", encode_view(final_view)}};
    for (const auto& step : steps) {
        nlohmann::json encoded = {{"index", step.index},
                                  {"handled", step.handled},
                                  {"outputs", nlohmann::json::array()},
                                  {"diagnostics", nlohmann::json::array()}};
        for (const auto& output : step.outputs)
            encoded["outputs"].push_back(encode_output(output));
        for (const auto& diagnostic : step.diagnostics)
            encoded["diagnostics"].push_back(encode_diagnostic(diagnostic));
        result["steps"].push_back(std::move(encoded));
    }
    return result;
}

std::string encode_editor_playback_report_text(std::string_view id,
                                               const std::vector<TypedPlaybackStepReport>& steps,
                                               const TypedRuntimeUIViewState& final_view,
                                               bool passed)
{
    return encode_editor_playback_report(id, steps, final_view, passed).dump();
}

nlohmann::json encode_editor_debug_snapshot(const TypedRuntimeUIViewState& view,
                                            const std::vector<RuntimeOutputMessage>& outputs,
                                            const Diagnostics& diagnostics, bool preview_running)
{
    nlohmann::json result = {
        {"schema", debug_snapshot_schema},         {"version", editor_runtime_protocol_version},
        {"previewRunning", preview_running},       {"view", encode_view(view)},
        {"observations", nlohmann::json::array()}, {"diagnostics", nlohmann::json::array()}};
    for (const auto& output : outputs) {
        if (const auto* observation = std::get_if<RuntimeObservation>(&output)) {
            std::visit(
                [&](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, PlaybackObservation>)
                        result["observations"].push_back({{"type", "playback"},
                                                          {"stepIndex", value.step_index},
                                                          {"handled", value.handled}});
                    else if constexpr (std::is_same_v<T, DebuggerObservation>)
                        result["observations"].push_back(
                            {{"type", "debugger"},
                             {"hasActiveFrame", value.active_frame.has_value()}});
                    else if constexpr (std::is_same_v<T, RuntimeStateObservation>)
                        result["observations"].push_back(
                            {{"type", "runtime-state"},
                             {"hasActiveFrame", value.active_frame.has_value()},
                             {"blocked", value.blocker.has_value()}});
                    else
                        static_assert(always_false<T>, "Unhandled RuntimeObservation alternative");
                },
                *observation);
        }
    }
    for (const auto& diagnostic : diagnostics)
        result["diagnostics"].push_back(encode_diagnostic(diagnostic));
    return result;
}

std::string encode_editor_debug_snapshot_text(const TypedRuntimeUIViewState& view,
                                              const std::vector<RuntimeOutputMessage>& outputs,
                                              const Diagnostics& diagnostics, bool preview_running)
{
    return encode_editor_debug_snapshot(view, outputs, diagnostics, preview_running).dump();
}

} // namespace noveltea::core::editor
