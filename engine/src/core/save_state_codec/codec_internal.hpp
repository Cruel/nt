#pragma once

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
namespace save_state_codec {

constexpr std::string_view k_schema = "noveltea.save.state";
constexpr std::string_view k_missing = "save_codec.missing_field";
constexpr std::string_view k_type = "save_codec.type";
constexpr std::string_view k_unknown = "save_codec.unknown_field";
constexpr std::string_view k_value = "save_codec.invalid_value";
constexpr std::string_view k_id = "save_codec.invalid_id";
constexpr std::string_view k_variant = "save_codec.invalid_variant";

inline std::string child(std::string_view parent, std::string_view name)
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

inline std::string index(std::string_view parent, std::size_t value)
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

nlohmann::json encode_value(const RuntimeValue& value);
std::optional<RuntimeValue> decode_value(Decoder& d, const nlohmann::json& value,
                                         std::string_view pointer);
template<class Id> nlohmann::json encode_optional_id(const std::optional<Id>& value)
{
    return value ? nlohmann::json(value->text()) : nlohmann::json(nullptr);
}
nlohmann::json encode_owner(const PropertyOwnerRef& owner);
std::optional<PropertyOwnerRef> decode_owner(Decoder& d, const nlohmann::json& value,
                                             std::string_view pointer);
nlohmann::json encode_location(const compiled::InteractableLocation& location);
std::optional<compiled::InteractableLocation>
decode_location(Decoder& d, const nlohmann::json& value, std::string_view pointer);
nlohmann::json encode_destination(const ReturnDestination& destination);
std::optional<ReturnDestination> decode_destination(Decoder& d, const nlohmann::json& value,
                                                    std::string_view pointer);
nlohmann::json encode_scene_position(const SceneFramePosition& position);
std::optional<SceneFramePosition> decode_scene_position(Decoder& d, const nlohmann::json& value,
                                                        std::string_view pointer);
nlohmann::json encode_dialogue_position(const DialogueFramePosition& value);
std::optional<DialogueFramePosition>
decode_dialogue_position(Decoder& d, const nlohmann::json& value, std::string_view pointer);
nlohmann::json encode_interaction_program(const InteractionProgramRef& value);
std::optional<InteractionProgramRef>
decode_interaction_program(Decoder& d, const nlohmann::json& value, std::string_view pointer);
nlohmann::json encode_interaction_position(const InteractionFramePosition& value);
std::optional<InteractionFramePosition>
decode_interaction_position(Decoder& d, const nlohmann::json& value, std::string_view pointer);
nlohmann::json encode_room_position(const RoomTransitionPosition& value);
std::optional<RoomTransitionPosition> decode_room_position(Decoder& d, const nlohmann::json& value,
                                                           std::string_view pointer);
nlohmann::json encode_frame(const SavedFlowFrame& frame);
std::optional<SavedFlowFrame> decode_frame(Decoder& d, const nlohmann::json& value,
                                           std::string_view pointer);
nlohmann::json encode_text_origin(const TextLogOrigin& origin);
std::optional<TextLogOrigin> decode_text_origin(Decoder& d, const nlohmann::json& value,
                                                std::string_view pointer);
nlohmann::json encode_text_log(const TextLogEntry& entry);
std::optional<TextLogEntry> decode_text_log(Decoder& d, const nlohmann::json& value,
                                            std::string_view pointer);
nlohmann::json encode_mode(const RuntimeMode& mode);
std::optional<RuntimeMode> decode_mode(Decoder& d, const nlohmann::json& value,
                                       std::string_view pointer);
template<class T, class Function>
std::optional<std::vector<T>> decode_array(Decoder& d, const nlohmann::json* value,
                                           std::string_view pointer, Function&& decode);
nlohmann::json encode_blocker(const std::optional<SavedFlowBlocker>& blocker);
std::optional<std::optional<SavedFlowBlocker>>
decode_blocker(Decoder& d, const nlohmann::json& value, std::string_view pointer);

struct SavedPresentationRecords {
    std::vector<SavedBackgroundOverride> background_overrides;
    std::vector<SavedActorPresentation> actors;
    std::vector<SavedPresentationProp> props;
    std::vector<SavedPresentationEnvironment> environments;
    std::vector<SavedMountedLayout> layouts;
    std::vector<SavedDesiredAudio> desired_audio;
    std::optional<PresentedTextState> presented_text;
    std::optional<ActiveChoiceState> active_choice;
    std::optional<MapPresentationState> map_presentation;
};

nlohmann::json encode_presentation_records(const SaveState& save);
std::optional<SavedPresentationRecords>
decode_presentation_records(Decoder& d, const nlohmann::json& value, std::string_view pointer);

Result<nlohmann::json, Diagnostics> encode_save_state_impl(const CompiledProject& project,
                                                           const SaveState& save);
Result<SaveState, Diagnostics> decode_save_state_wire_impl(const nlohmann::json& document,
                                                           std::string source_path);
Result<void, Diagnostics> validate_save_state_impl(const CompiledProject& project,
                                                   const SaveState& save, std::string source_path);
Result<SaveState, Diagnostics> decode_save_state_impl(const CompiledProject& project,
                                                      const nlohmann::json& document,
                                                      std::string source_path);

} // namespace save_state_codec
} // namespace noveltea::core
