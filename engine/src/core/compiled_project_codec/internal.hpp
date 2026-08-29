#pragma once

#include "../compiled_project_wire.hpp"
#include "../json_decoder.hpp"

#include <chrono>
#include <cstdint>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>

namespace noveltea::core::compiled::wire::detail {

constexpr std::string_view k_code_missing = "compiled_project.missing_field";
constexpr std::string_view k_code_type = "compiled_project.type";
constexpr std::string_view k_code_unknown = "compiled_project.unknown_field";
constexpr std::string_view k_code_enum = "compiled_project.unknown_value";
constexpr std::string_view k_code_variant = "compiled_project.unknown_variant";
constexpr std::string_view k_code_id = "compiled_project.invalid_id";
constexpr std::string_view k_code_duplicate = "compiled_project.duplicate_id";
constexpr std::string_view k_code_number = "compiled_project.invalid_number";

inline std::string pointer_child(std::string_view parent, std::string_view child)
{
    return JsonDecoder::child(parent, child);
}

inline std::string pointer_index(std::string_view parent, std::size_t index)
{
    return JsonDecoder::index(parent, index);
}

class Decoder final : public JsonDecoder {
public:
    explicit Decoder(std::string source_path)
        : JsonDecoder(std::move(source_path),
                      JsonDecoderCodes{.missing_field = std::string(k_code_missing),
                                       .type = std::string(k_code_type),
                                       .unknown_field = std::string(k_code_unknown),
                                       .invalid_number = std::string(k_code_number),
                                       .invalid_id = std::string(k_code_id),
                                       .unknown_value = std::string(k_code_enum)})
    {
    }

    template<class Record, class GetId>
    void duplicate_ids(const std::vector<Record>& records, std::string_view pointer, GetId&& get_id)
    {
        std::unordered_set<std::string> ids;
        for (std::size_t index = 0; index < records.size(); ++index) {
            const auto& text = get_id(records[index]).text();
            if (!ids.insert(text).second)
                error(k_code_duplicate, "Duplicate ID '" + text + "'.",
                      pointer_child(pointer_index(pointer, index), "id"));
        }
    }
};

template<class T> bool assign(std::optional<T>& source, T& destination)
{
    if (!source)
        return false;
    destination = std::move(*source);
    return true;
}

std::optional<RuntimeValue> decode_runtime_value(Decoder&, const nlohmann::json&, std::string_view,
                                                 bool allow_null = true);
std::optional<PersistableValue> decode_persistable_value(Decoder&, const nlohmann::json&,
                                                         std::string_view);
std::optional<TextContent> decode_text(Decoder&, const nlohmann::json&, std::string_view);
std::optional<Condition> decode_condition_impl(Decoder&, const nlohmann::json&, std::string_view);
std::optional<Effect> decode_effect_impl(Decoder&, const nlohmann::json&, std::string_view);
std::optional<GameplayCommand> decode_gameplay_command_impl(Decoder&, const nlohmann::json&,
                                                            std::string_view);
std::optional<FlowTarget> decode_flow_target_impl(Decoder&, const nlohmann::json&,
                                                  std::string_view);
std::optional<Vector2> decode_vector2(Decoder&, const nlohmann::json&, std::string_view);
std::optional<NormalizedRect> decode_rect(Decoder&, const nlohmann::json&, std::string_view);
std::optional<BackgroundPresentation> decode_background(Decoder&, const nlohmann::json&,
                                                        std::string_view);
std::optional<RoomPlacementRef> decode_placement_ref(Decoder&, const nlohmann::json&,
                                                     std::string_view);
std::optional<InteractableLocation> decode_location(Decoder&, const nlohmann::json&,
                                                    std::string_view);
std::optional<LayoutSource> decode_layout_source(Decoder&, const nlohmann::json&, std::string_view);
std::optional<ScriptSource> decode_script_source(Decoder&, const nlohmann::json&, std::string_view);

template<class Id>
std::optional<Id> decode_reference(Decoder& decoder, const nlohmann::json& value,
                                   std::string_view pointer, std::string_view expected_kind)
{
    if (!decoder.object(value, pointer, {"id", "kind"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto decoded_id =
        id_value ? decoder.id<Id>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (kind && *kind != expected_kind) {
        decoder.error(k_code_variant,
                      "Expected reference kind '" + std::string(expected_kind) + "'.",
                      pointer_child(pointer, "kind"));
        kind.reset();
    }
    return decoded_id && kind ? std::move(decoded_id) : std::nullopt;
}

inline std::optional<FeatureRef> decode_feature_ref(Decoder& decoder, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected Feature reference object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* owner_kind_value = decoder.member(value, "ownerKind", pointer);
    const auto* feature_value = decoder.member(value, "featureId", pointer);
    auto owner_kind = owner_kind_value
                          ? decoder.string(*owner_kind_value, pointer_child(pointer, "ownerKind"))
                          : std::nullopt;
    auto feature = feature_value
                       ? decoder.id<FeatureId>(*feature_value, pointer_child(pointer, "featureId"))
                       : std::nullopt;
    if (!owner_kind || !feature)
        return std::nullopt;
    if (*owner_kind == "room" &&
        decoder.object(value, pointer, {"featureId", "ownerKind", "room"})) {
        const auto* room_value = decoder.member(value, "room", pointer);
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        if (room)
            return RoomFeatureRef{std::move(*room), std::move(*feature)};
    }
    if (*owner_kind == "interactable" &&
        decoder.object(value, pointer, {"featureId", "interactable", "ownerKind"})) {
        const auto* interactable_value = decoder.member(value, "interactable", pointer);
        auto interactable = interactable_value
                                ? decode_reference<InteractableInstanceId>(
                                      decoder, *interactable_value,
                                      pointer_child(pointer, "interactable"), "interactable")
                                : std::nullopt;
        if (interactable)
            return InteractableFeatureRef{std::move(*interactable), std::move(*feature)};
    }
    decoder.error(k_code_variant, "Unknown Feature owner kind.",
                  pointer_child(pointer, "ownerKind"));
    return std::nullopt;
}

inline std::optional<InteractionSubject>
decode_interaction_subject(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected interaction subject object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "character" && decoder.object(value, pointer, {"character", "kind"})) {
        const auto* character_value = decoder.member(value, "character", pointer);
        auto character =
            character_value
                ? decode_reference<CharacterId>(decoder, *character_value,
                                                pointer_child(pointer, "character"), "character")
                : std::nullopt;
        if (character)
            return CharacterInteractionSubject{std::move(*character)};
    }
    if (*kind == "interactable" && decoder.object(value, pointer, {"interactable", "kind"})) {
        const auto* interactable_value = decoder.member(value, "interactable", pointer);
        auto interactable = interactable_value
                                ? decode_reference<InteractableInstanceId>(
                                      decoder, *interactable_value,
                                      pointer_child(pointer, "interactable"), "interactable")
                                : std::nullopt;
        if (interactable)
            return InteractableInteractionSubject{std::move(*interactable)};
    }
    if (*kind == "feature" && decoder.object(value, pointer, {"feature", "kind"})) {
        const auto* feature_value = decoder.member(value, "feature", pointer);
        auto feature = feature_value ? decode_feature_ref(decoder, *feature_value,
                                                          pointer_child(pointer, "feature"))
                                     : std::nullopt;
        if (feature)
            return FeatureInteractionSubject{std::move(*feature)};
    }
    decoder.error(k_code_variant, "Unknown interaction subject kind.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

template<class Id>
std::optional<DefinitionIdentity<Id>>
decode_definition_identity(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    const auto* id_value = decoder.member(value, "id", pointer);
    auto decoded_id =
        id_value ? decoder.id<Id>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    return decoded_id ? std::optional<DefinitionIdentity<Id>>{DefinitionIdentity<Id>{
                            std::move(*decoded_id)}}
                      : std::nullopt;
}

template<class Id>
std::optional<PropertyBearingDefinition<Id>>
decode_identity(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* traits_value = decoder.member(value, "traits", pointer);
    const auto* assignments_value = decoder.member(value, "propertyAssignments", pointer);
    auto decoded_id =
        id_value ? decoder.id<Id>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto traits = traits_value
                      ? decoder.array<TraitId>(
                            *traits_value, pointer_child(pointer, "traits"),
                            [&](const nlohmann::json& trait,
                                const std::string& item_pointer) -> std::optional<TraitId> {
                                return decoder.id<TraitId>(trait, item_pointer);
                            })
                      : std::nullopt;
    auto assignments =
        assignments_value
            ? decoder.array<PropertyAssignment>(
                  *assignments_value, pointer_child(pointer, "propertyAssignments"),
                  [&](const nlohmann::json& assignment,
                      const std::string& item_pointer) -> std::optional<PropertyAssignment> {
                      if (!decoder.object(assignment, item_pointer, {"propertyId", "value"}))
                          return std::nullopt;
                      const auto* property_value =
                          decoder.member(assignment, "propertyId", item_pointer);
                      const auto* value_value = decoder.member(assignment, "value", item_pointer);
                      auto property =
                          property_value
                              ? decoder.id<PropertyId>(*property_value,
                                                       pointer_child(item_pointer, "propertyId"))
                              : std::nullopt;
                      auto runtime_value =
                          value_value ? decode_runtime_value(decoder, *value_value,
                                                             pointer_child(item_pointer, "value"))
                                      : std::nullopt;
                      if (property && runtime_value)
                          return PropertyAssignment{std::move(*property),
                                                    std::move(*runtime_value)};
                      return std::nullopt;
                  })
            : std::nullopt;
    if (traits) {
        std::unordered_set<std::string> ids;
        for (std::size_t index = 0; index < traits->size(); ++index) {
            const auto& text = (*traits)[index].text();
            if (!ids.insert(text).second)
                decoder.error(k_code_duplicate, "Duplicate Trait attachment '" + text + "'.",
                              pointer_index(pointer_child(pointer, "traits"), index));
        }
    }
    if (assignments) {
        std::unordered_set<std::string> ids;
        for (std::size_t index = 0; index < assignments->size(); ++index) {
            const auto& text = (*assignments)[index].property_id.text();
            if (!ids.insert(text).second)
                decoder.error(
                    k_code_duplicate, "Duplicate property assignment '" + text + "'.",
                    pointer_child(
                        pointer_index(pointer_child(pointer, "propertyAssignments"), index),
                        "propertyId"));
        }
    }
    if (!decoded_id || !traits || !assignments)
        return std::nullopt;
    return PropertyBearingDefinition<Id>{std::move(*decoded_id), std::move(*traits),
                                         std::move(*assignments)};
}

std::optional<ProjectIdentity> decode_project_identity(Decoder&, const nlohmann::json&,
                                                       std::string_view);
std::optional<Entrypoint> decode_entrypoint(Decoder&, const nlohmann::json&, std::string_view);
std::optional<Localization> decode_localization(Decoder&, const nlohmann::json&, std::string_view);
std::optional<RuntimeSettings> decode_settings(Decoder&, const nlohmann::json&, std::string_view);
std::optional<PropertyDeclaration> decode_property(Decoder&, const nlohmann::json&,
                                                   std::string_view);
std::optional<TraitProperty> decode_owner_property_contract(Decoder&, const nlohmann::json&,
                                                            std::string_view);
std::optional<TraitDeclaration> decode_trait(Decoder&, const nlohmann::json&, std::string_view);
std::optional<AssetResource> decode_asset(Decoder&, const nlohmann::json&, std::string_view);
std::optional<LayoutResource> decode_layout(Decoder&, const nlohmann::json&, std::string_view);
std::optional<ScriptResource> decode_script(Decoder&, const nlohmann::json&, std::string_view);

std::optional<Condition> decode_optional_condition(Decoder&, const nlohmann::json&,
                                                   std::string_view, bool& valid);
std::optional<std::vector<Effect>> decode_effects(Decoder&, const nlohmann::json&,
                                                  std::string_view);
std::optional<std::vector<GameplayCommand>>
decode_gameplay_commands(Decoder&, const nlohmann::json&, std::string_view);
std::optional<InteractionProgram> decode_interaction_program(Decoder&, const nlohmann::json&,
                                                             std::string_view);
std::optional<VerbDefinition> decode_verb(Decoder&, const nlohmann::json&, std::string_view);
std::optional<InteractionDefinition> decode_interaction(Decoder&, const nlohmann::json&,
                                                        std::string_view);

std::optional<CharacterDefinition> decode_character(Decoder&, const nlohmann::json&,
                                                    std::string_view);
std::optional<RoomDefinition> decode_room(Decoder&, const nlohmann::json&, std::string_view);
std::optional<InteractableDefinition> decode_interactable(Decoder&, const nlohmann::json&,
                                                          std::string_view);
std::optional<ItemDefinition> decode_item_definition(Decoder&, const nlohmann::json&,
                                                     std::string_view);
std::optional<ArchetypeDefinition> decode_archetype(Decoder&, const nlohmann::json&,
                                                    std::string_view);
std::optional<MapDefinition> decode_map(Decoder&, const nlohmann::json&, std::string_view);
std::optional<SceneDefinition> decode_scene(Decoder&, const nlohmann::json&, std::string_view);
std::optional<DialogueDefinition> decode_dialogue(Decoder&, const nlohmann::json&,
                                                  std::string_view);

} // namespace noveltea::core::compiled::wire::detail
