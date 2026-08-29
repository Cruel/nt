#pragma once

#include "../json_decoder.hpp"

#include "noveltea/core/save_state_codec.hpp"

#include <algorithm>
#include <array>
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
    return JsonDecoder::child(parent, name);
}

inline std::string index(std::string_view parent, std::size_t value)
{
    return JsonDecoder::index(parent, value);
}

class Decoder final : public JsonDecoder {
public:
    explicit Decoder(std::string source_path)
        : JsonDecoder(std::move(source_path),
                      JsonDecoderCodes{.missing_field = std::string(k_missing),
                                       .type = std::string(k_type),
                                       .unknown_field = std::string(k_unknown),
                                       .invalid_number = std::string(k_type),
                                       .invalid_id = std::string(k_id),
                                       .unknown_value = std::string(k_value)})
    {
    }
};

nlohmann::json encode_value(const RuntimeValue& value);
std::optional<RuntimeValue> decode_value(Decoder& d, const nlohmann::json& value,
                                         std::string_view pointer);
nlohmann::json encode_persistable_value(const PersistableValue& value);
std::optional<PersistableValue> decode_persistable_value(Decoder& d, const nlohmann::json& value,
                                                         std::string_view pointer);
template<class Id> nlohmann::json encode_optional_id(const std::optional<Id>& value)
{
    return value ? nlohmann::json(value->text()) : nlohmann::json(nullptr);
}
nlohmann::json encode_owner(const PropertyOwnerRef& owner);
std::optional<PropertyOwnerRef> decode_owner(Decoder& d, const nlohmann::json& value,
                                             std::string_view pointer);
nlohmann::json encode_property_target(const PropertyTargetRef& target);
std::optional<PropertyTargetRef> decode_property_target(Decoder& d, const nlohmann::json& value,
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
    std::vector<SavedCameraView> camera_views;
    std::vector<SavedActorPresentation> actors;
    std::vector<SavedPresentationProp> props;
    std::vector<SavedPresentationEnvironment> environments;
    std::vector<SavedMaterialParameter> material_parameters;
    std::vector<SavedPostprocessEffect> postprocess_effects;
    std::vector<SavedMountedLayout> layouts;
    std::vector<SavedLayoutStateSlot> layout_state_slots;
    std::vector<SavedDesiredAudio> desired_audio;
    std::optional<PresentedTextState> presented_text;
    std::optional<ActiveChoiceState> active_choice;
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
