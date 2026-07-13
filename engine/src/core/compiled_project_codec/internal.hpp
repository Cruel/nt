#pragma once

#include "../compiled_project_wire.hpp"

#include "noveltea/core/json_access.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <limits>
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
    std::string escaped;
    escaped.reserve(child.size());
    for (const char character : child) {
        if (character == '~')
            escaped += "~0";
        else if (character == '/')
            escaped += "~1";
        else
            escaped.push_back(character);
    }
    std::string result(parent);
    result.push_back('/');
    result += escaped;
    return result;
}

inline std::string pointer_index(std::string_view parent, std::size_t index)
{
    return pointer_child(parent, std::to_string(index));
}

class Decoder {
public:
    explicit Decoder(std::string source_path) : m_source_path(std::move(source_path)) {}

    void error(std::string_view code, std::string message, std::string pointer)
    {
        m_diagnostics.push_back(Diagnostic{.code = std::string(code),
                                           .message = std::move(message),
                                           .severity = ErrorSeverity::Error,
                                           .source_path = m_source_path,
                                           .json_pointer = std::move(pointer)});
    }

    bool object(const nlohmann::json& value, std::string_view pointer,
                std::initializer_list<std::string_view> fields)
    {
        if (!value.is_object()) {
            error(k_code_type, "Expected an object.", std::string(pointer));
            return false;
        }
        for (auto iterator = value.begin(); iterator != value.end(); ++iterator) {
            const std::string& key = iterator.key();
            bool known = false;
            for (const auto field : fields) {
                if (field == key) {
                    known = true;
                    break;
                }
            }
            if (!known)
                error(k_code_unknown, "Unknown field '" + key + "'.", pointer_child(pointer, key));
        }
        return true;
    }

    const nlohmann::json* member(const nlohmann::json& object, std::string_view key,
                                 std::string_view pointer)
    {
        const auto* value = json_access::member(object, key);
        if (!value)
            error(k_code_missing, "Missing required field '" + std::string(key) + "'.",
                  pointer_child(pointer, key));
        return value;
    }

    std::optional<std::string> string(const nlohmann::json& value, std::string_view pointer,
                                      bool nonempty = false, bool trim_nonempty = false)
    {
        auto decoded = json_access::get<std::string>(value);
        if (!decoded) {
            error(k_code_type, "Expected a string.", std::string(pointer));
            return std::nullopt;
        }
        bool has_content = !decoded->empty();
        if (trim_nonempty) {
            has_content = false;
            for (const unsigned char character : *decoded) {
                if (character != ' ' && character != '\t' && character != '\n' &&
                    character != '\r') {
                    has_content = true;
                    break;
                }
            }
        }
        if ((nonempty || trim_nonempty) && !has_content) {
            error(k_code_type, "Expected a non-empty string.", std::string(pointer));
            return std::nullopt;
        }
        return decoded;
    }

    std::optional<bool> boolean(const nlohmann::json& value, std::string_view pointer)
    {
        auto decoded = json_access::get<bool>(value);
        if (!decoded)
            error(k_code_type, "Expected a boolean.", std::string(pointer));
        return decoded;
    }

    std::optional<double> finite_number(const nlohmann::json& value, std::string_view pointer)
    {
        auto decoded = json_access::get<double>(value);
        if (!decoded) {
            error(k_code_type, "Expected a number.", std::string(pointer));
            return std::nullopt;
        }
        if (!std::isfinite(*decoded)) {
            error(k_code_number, "Number must be finite.", std::string(pointer));
            return std::nullopt;
        }
        return decoded;
    }

    template<class Unsigned>
    std::optional<Unsigned> unsigned_integer(const nlohmann::json& value, std::string_view pointer,
                                             bool positive = false)
    {
        auto decoded = json_access::get<Unsigned>(value);
        if (!decoded) {
            error(k_code_type, "Expected a nonnegative integer in range.", std::string(pointer));
            return std::nullopt;
        }
        if (positive && *decoded == 0) {
            error(k_code_number, "Expected a positive integer.", std::string(pointer));
            return std::nullopt;
        }
        return decoded;
    }

    template<class Id> std::optional<Id> id(const nlohmann::json& value, std::string_view pointer)
    {
        auto text = string(value, pointer, true);
        if (!text)
            return std::nullopt;
        auto result = Id::create(std::move(*text));
        if (!result) {
            error(k_code_id, result.error().front().message, std::string(pointer));
            return std::nullopt;
        }
        std::optional<Id> decoded;
        (void)result.transform([&decoded](const Id& id) {
            decoded = id;
            return true;
        });
        return decoded;
    }

    template<class Enum>
    std::optional<Enum> enumeration(const nlohmann::json& value, std::string_view pointer,
                                    std::initializer_list<std::pair<std::string_view, Enum>> values)
    {
        auto text = string(value, pointer);
        if (!text)
            return std::nullopt;
        for (const auto& [name, result] : values) {
            if (*text == name)
                return result;
        }
        error(k_code_enum, "Unknown value '" + *text + "'.", std::string(pointer));
        return std::nullopt;
    }

    template<class T, class Function>
    std::optional<std::vector<T>> array(const nlohmann::json& value, std::string_view pointer,
                                        Function&& function)
    {
        if (!value.is_array()) {
            error(k_code_type, "Expected an array.", std::string(pointer));
            return std::nullopt;
        }
        std::vector<T> output;
        output.reserve(value.size());
        for (std::size_t index = 0; index < value.size(); ++index) {
            const auto* element = json_access::element(value, index);
            if (!element)
                continue;
            auto decoded = function(*element, pointer_index(pointer, index));
            if (decoded)
                output.push_back(std::move(*decoded));
        }
        return output;
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

    [[nodiscard]] bool failed() const noexcept { return !m_diagnostics.empty(); }
    [[nodiscard]] Diagnostics take_diagnostics() { return std::move(m_diagnostics); }

private:
    std::string m_source_path;
    Diagnostics m_diagnostics;
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
std::optional<TextContent> decode_text(Decoder&, const nlohmann::json&, std::string_view);
std::optional<Condition> decode_condition_impl(Decoder&, const nlohmann::json&, std::string_view);
std::optional<Effect> decode_effect_impl(Decoder&, const nlohmann::json&, std::string_view);
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

template<class Id>
std::optional<PropertyBearingDefinition<Id>>
decode_identity(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* extends_value = decoder.member(value, "extends", pointer);
    const auto* assignments_value = decoder.member(value, "propertyAssignments", pointer);
    auto decoded_id =
        id_value ? decoder.id<Id>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    std::optional<Id> parent;
    bool parent_ok = extends_value != nullptr;
    if (extends_value && !extends_value->is_null()) {
        parent = decoder.id<Id>(*extends_value, pointer_child(pointer, "extends"));
        parent_ok = parent.has_value();
    }
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
    if (!decoded_id || !parent_ok || !assignments)
        return std::nullopt;
    return PropertyBearingDefinition<Id>{std::move(*decoded_id), std::move(parent),
                                         std::move(*assignments)};
}

std::optional<ProjectIdentity> decode_project_identity(Decoder&, const nlohmann::json&,
                                                       std::string_view);
std::optional<Entrypoint> decode_entrypoint(Decoder&, const nlohmann::json&, std::string_view);
std::optional<Localization> decode_localization(Decoder&, const nlohmann::json&, std::string_view);
std::optional<RuntimeSettings> decode_settings(Decoder&, const nlohmann::json&, std::string_view);
std::optional<VariableDeclaration> decode_variable(Decoder&, const nlohmann::json&,
                                                   std::string_view);
std::optional<PropertyDeclaration> decode_property(Decoder&, const nlohmann::json&,
                                                   std::string_view);
std::optional<AssetResource> decode_asset(Decoder&, const nlohmann::json&, std::string_view);
std::optional<LayoutResource> decode_layout(Decoder&, const nlohmann::json&, std::string_view);
std::optional<ScriptResource> decode_script(Decoder&, const nlohmann::json&, std::string_view);

std::optional<Condition> decode_optional_condition(Decoder&, const nlohmann::json&,
                                                   std::string_view, bool& valid);
std::optional<std::vector<Effect>> decode_effects(Decoder&, const nlohmann::json&,
                                                  std::string_view);
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
std::optional<MapDefinition> decode_map(Decoder&, const nlohmann::json&, std::string_view);
std::optional<SceneDefinition> decode_scene(Decoder&, const nlohmann::json&, std::string_view);
std::optional<DialogueDefinition> decode_dialogue(Decoder&, const nlohmann::json&,
                                                  std::string_view);

} // namespace noveltea::core::compiled::wire::detail
