#include "noveltea/core/editor_runtime_protocol.hpp"

#include "noveltea/core/json_access.hpp"
#include "noveltea/render/material_codec.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <functional>
#include <limits>
#include <map>
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

std::optional<std::string> string_field_with_limit(const nlohmann::json& object,
                                                   std::string_view key, Diagnostics& diagnostics,
                                                   std::string_view path,
                                                   std::size_t max_string_bytes)
{
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_string()) {
        diagnostics.push_back(error("editor_protocol.wrong_type", "Expected a string.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    const auto value = *json_access::get<std::string>(*found);
    if (value.size() > max_string_bytes) {
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

template<class Limits>
std::optional<std::string> string_field(const nlohmann::json& object, std::string_view key,
                                        Diagnostics& diagnostics, std::string_view path,
                                        const Limits& limits)
{
    return string_field_with_limit(object, key, diagnostics, path, limits.max_string_bytes);
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
    auto kind = string_field(*found, "kind", diagnostics, owner_path, limits);
    if (!kind)
        return std::nullopt;

#define DECODE_OWNER(kind_text, id_type)                                                           \
    if (*kind == kind_text) {                                                                      \
        exact_fields(*found, {"kind", "id"}, diagnostics, owner_path);                             \
        auto id = id_field<id_type>(*found, "id", diagnostics, owner_path, limits);                \
        return id ? std::optional<PropertyOwnerRef>{PropertyOwnerRef{std::move(*id)}}              \
                  : std::nullopt;                                                                  \
    }
    DECODE_OWNER("room", RoomId)
    DECODE_OWNER("character", CharacterId)
    DECODE_OWNER("interactable", InteractableInstanceId)
#undef DECODE_OWNER
    if (*kind == "feature") {
        exact_fields(*found, {"kind", "ownerKind", "ownerId", "featureId"}, diagnostics,
                     owner_path);
        auto owner_kind = string_field(*found, "ownerKind", diagnostics, owner_path, limits);
        auto feature = id_field<FeatureId>(*found, "featureId", diagnostics, owner_path, limits);
        if (!owner_kind || !feature)
            return std::nullopt;
        if (*owner_kind == "room") {
            auto owner = id_field<RoomId>(*found, "ownerId", diagnostics, owner_path, limits);
            return owner ? std::optional<PropertyOwnerRef>{RoomFeatureRef{std::move(*owner),
                                                                          std::move(*feature)}}
                         : std::nullopt;
        }
        if (*owner_kind == "interactable") {
            auto owner = id_field<InteractableInstanceId>(*found, "ownerId", diagnostics,
                                                          owner_path, limits);
            return owner ? std::optional<PropertyOwnerRef>{InteractableFeatureRef{
                               std::move(*owner), std::move(*feature)}}
                         : std::nullopt;
        }
        diagnostics.push_back(error("editor_protocol.invalid_owner_kind",
                                    "Feature ownerKind must be room or interactable.",
                                    owner_path + "/ownerKind"));
        return std::nullopt;
    }

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

std::optional<PersistableValue> preview_persistable_value(const nlohmann::json& value,
                                                          Diagnostics& diagnostics,
                                                          std::string_view path,
                                                          const EditorRuntimeProtocolLimits& limits,
                                                          std::size_t depth = 0)
{
    if (depth > 64) {
        diagnostics.push_back(error("editor_preview.state_depth_limit",
                                    "Layout preview state exceeds the nesting limit.",
                                    std::string(path)));
        return std::nullopt;
    }
    if (value.is_null())
        return PersistableValue{std::monostate{}};
    if (value.is_boolean())
        return PersistableValue{*json_access::get<bool>(value)};
    if (value.is_number_integer())
        return PersistableValue{*json_access::get<std::int64_t>(value)};
    if (value.is_number_float()) {
        const auto number = *json_access::get<double>(value);
        if (!std::isfinite(number)) {
            diagnostics.push_back(error("editor_preview.state_non_finite",
                                        "Layout preview state numbers must be finite.",
                                        std::string(path)));
            return std::nullopt;
        }
        return PersistableValue{number};
    }
    if (value.is_string()) {
        const auto text = *json_access::get<std::string>(value);
        if (text.size() > limits.max_string_bytes || !valid_utf8(text)) {
            diagnostics.push_back(error("editor_preview.invalid_string",
                                        "Layout preview state string is invalid or too large.",
                                        std::string(path)));
            return std::nullopt;
        }
        return PersistableValue{std::move(text)};
    }
    if (value.is_array()) {
        PersistableValue::Array array;
        array.reserve(value.size());
        for (std::size_t index = 0; index < value.size(); ++index) {
            const auto* element = json_access::element(value, index);
            if (element == nullptr)
                return std::nullopt;
            auto item = preview_persistable_value(*element, diagnostics,
                                                  std::string(path) + "/" + std::to_string(index),
                                                  limits, depth + 1);
            if (!item)
                return std::nullopt;
            array.push_back(std::move(*item));
        }
        return PersistableValue{std::move(array)};
    }
    if (value.is_object()) {
        PersistableValue::Object object;
        object.reserve(value.size());
        for (const auto& [name, member] : value.items()) {
            if (name.empty() || name.size() > limits.max_string_bytes || !valid_utf8(name)) {
                diagnostics.push_back(error(
                    "editor_preview.invalid_string",
                    "Layout preview state field name is invalid or too large.", std::string(path)));
                return std::nullopt;
            }
            auto decoded = preview_persistable_value(
                member, diagnostics, std::string(path) + "/" + name, limits, depth + 1);
            if (!decoded)
                return std::nullopt;
            object.emplace_back(name, std::move(*decoded));
        }
        return PersistableValue{std::move(object)};
    }
    diagnostics.push_back(error("editor_preview.unsupported_state_value",
                                "Layout preview state must contain only persistable values.",
                                std::string(path)));
    return std::nullopt;
}

std::optional<LayoutContractValueType>
preview_layout_contract_value_type(const nlohmann::json& value, Diagnostics& diagnostics,
                                   std::string_view path, const EditorRuntimeProtocolLimits& limits)
{
    if (!value.is_string()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Layout contract value type must be a string.",
                                    std::string(path)));
        return std::nullopt;
    }
    const auto type = json_access::get<std::string_view>(value);
    if (!type || type->size() > limits.max_string_bytes || !valid_utf8(*type))
        return std::nullopt;
    if (*type == "boolean")
        return LayoutContractValueType::Boolean;
    if (*type == "integer")
        return LayoutContractValueType::Integer;
    if (*type == "number")
        return LayoutContractValueType::Number;
    if (*type == "string")
        return LayoutContractValueType::String;
    diagnostics.push_back(error("editor_preview.invalid_layout_contract_type",
                                "Layout contract value type is unsupported.", std::string(path)));
    return std::nullopt;
}

template<class Id>
std::optional<Id> preview_layout_contract_id(const nlohmann::json& value, Diagnostics& diagnostics,
                                             std::string_view path,
                                             const EditorRuntimeProtocolLimits& limits)
{
    if (!value.is_string()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Layout contract ID must be a string.", std::string(path)));
        return std::nullopt;
    }
    auto text = json_access::get<std::string>(value);
    if (!text || text->size() > limits.max_string_bytes || !valid_utf8(*text))
        return std::nullopt;
    auto id = Id::create(std::move(*text));
    if (!id) {
        diagnostics.push_back(error(
            "editor_preview.invalid_layout_contract_id",
            "Layout contract ID must begin with a lowercase letter and contain only lowercase "
            "letters, numbers, hyphens, and underscores.",
            std::string(path)));
        return std::nullopt;
    }
    return std::move(*id.value_if());
}

std::optional<LayoutStateShape>
preview_layout_state_shape(const nlohmann::json& value, Diagnostics& diagnostics,
                           std::string_view path, const EditorRuntimeProtocolLimits& limits,
                           std::size_t depth = 0)
{
    if (depth > 64) {
        diagnostics.push_back(error("editor_preview.state_shape_depth_limit",
                                    "Layout State Shape exceeds the nesting limit.",
                                    std::string(path)));
        return std::nullopt;
    }
    if (!value.is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Layout State Shape must be an object.", std::string(path)));
        return std::nullopt;
    }
    const auto* type_value = json_access::member(value, "type");
    const auto* nullable_value = json_access::member(value, "nullable");
    const auto* has_default_value = json_access::member(value, "hasDefault");
    const auto* default_value = json_access::member(value, "defaultValue");
    if (type_value == nullptr || nullable_value == nullptr || has_default_value == nullptr ||
        default_value == nullptr || !type_value->is_string() || !nullable_value->is_boolean() ||
        !has_default_value->is_boolean()) {
        diagnostics.push_back(error("editor_preview.layout_state_shape_required",
                                    "Layout State Shape requires type, nullable, hasDefault, and "
                                    "defaultValue.",
                                    std::string(path)));
        return std::nullopt;
    }

    LayoutStateShape shape;
    const auto type = *json_access::get<std::string_view>(*type_value);
    if (type == "boolean")
        shape.type = LayoutStateShapeType::Boolean;
    else if (type == "integer")
        shape.type = LayoutStateShapeType::Integer;
    else if (type == "number")
        shape.type = LayoutStateShapeType::Number;
    else if (type == "string")
        shape.type = LayoutStateShapeType::String;
    else if (type == "array")
        shape.type = LayoutStateShapeType::Array;
    else if (type == "object")
        shape.type = LayoutStateShapeType::Object;
    else {
        diagnostics.push_back(error("editor_preview.invalid_layout_state_shape_type",
                                    "Layout State Shape type is unsupported.",
                                    std::string(path) + "/type"));
        return std::nullopt;
    }
    shape.nullable = *json_access::get<bool>(*nullable_value);
    const bool has_default = *json_access::get<bool>(*has_default_value);
    if (has_default) {
        auto decoded = preview_persistable_value(
            *default_value, diagnostics, std::string(path) + "/defaultValue", limits, depth + 1);
        if (!decoded)
            return std::nullopt;
        shape.default_value = std::move(*decoded);
    } else if (!default_value->is_null()) {
        diagnostics.push_back(error("editor_preview.layout_state_default_presence",
                                    "Layout State Shape without a default must encode defaultValue "
                                    "as null.",
                                    std::string(path) + "/defaultValue"));
        return std::nullopt;
    }

    if (shape.type == LayoutStateShapeType::Array) {
        exact_fields(value, {"defaultValue", "hasDefault", "items", "nullable", "type"},
                     diagnostics, path);
        const auto* items = json_access::member(value, "items");
        if (items == nullptr) {
            diagnostics.push_back(error("editor_preview.missing_field",
                                        "Array Layout State Shape requires items.",
                                        std::string(path) + "/items"));
            return std::nullopt;
        }
        auto item = preview_layout_state_shape(*items, diagnostics, std::string(path) + "/items",
                                               limits, depth + 1);
        if (!item)
            return std::nullopt;
        shape.items.push_back(std::move(*item));
    } else if (shape.type == LayoutStateShapeType::Object) {
        exact_fields(value, {"defaultValue", "fields", "hasDefault", "nullable", "type"},
                     diagnostics, path);
        const auto* fields = json_access::member(value, "fields");
        if (fields == nullptr || !fields->is_array()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Object Layout State Shape fields must be an array.",
                                        std::string(path) + "/fields"));
            return std::nullopt;
        }
        std::set<std::string> seen;
        for (std::size_t index = 0; index < fields->size(); ++index) {
            const auto* field_value = json_access::element(*fields, index);
            if (field_value == nullptr)
                return std::nullopt;
            const auto& field = *field_value;
            const auto field_path = std::string(path) + "/fields/" + std::to_string(index);
            if (!field.is_object()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "Layout State field must be an object.", field_path));
                return std::nullopt;
            }
            exact_fields(field, {"id", "required", "shape"}, diagnostics, field_path);
            const auto* id_value = json_access::member(field, "id");
            const auto* required_value = json_access::member(field, "required");
            const auto* child_value = json_access::member(field, "shape");
            if (id_value == nullptr || !id_value->is_string() || required_value == nullptr ||
                !required_value->is_boolean() || child_value == nullptr) {
                diagnostics.push_back(error("editor_preview.layout_state_field_required",
                                            "Layout State field requires id, required, and shape.",
                                            field_path));
                return std::nullopt;
            }
            const auto id = *json_access::get<std::string>(*id_value);
            if (!valid_strong_id(id, StrongIdSyntax::KebabOrSnakeCase) || !seen.insert(id).second) {
                diagnostics.push_back(error("editor_preview.invalid_layout_contract_id",
                                            "Layout State field ID is invalid or duplicated.",
                                            field_path + "/id"));
                return std::nullopt;
            }
            auto child = preview_layout_state_shape(*child_value, diagnostics,
                                                    field_path + "/shape", limits, depth + 1);
            if (!child)
                return std::nullopt;
            shape.fields.push_back(LayoutStateObjectField{
                id, *json_access::get<bool>(*required_value), {std::move(*child)}});
        }
    } else {
        exact_fields(value, {"defaultValue", "hasDefault", "nullable", "type"}, diagnostics, path);
    }

    if (!layout_state_shape_valid(shape)) {
        diagnostics.push_back(error("editor_preview.invalid_layout_state_shape",
                                    "Layout State Shape is internally inconsistent.",
                                    std::string(path)));
        return std::nullopt;
    }
    return shape;
}

std::optional<LayoutContract> preview_layout_contract(const nlohmann::json& value,
                                                      Diagnostics& diagnostics,
                                                      std::string_view path,
                                                      const EditorRuntimeProtocolLimits& limits)
{
    if (!value.is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Layout preview contract must be an object.",
                                    std::string(path)));
        return std::nullopt;
    }
    exact_fields(value, {"inputs", "signals", "state"}, diagnostics, path);
    const auto* inputs_value = json_access::member(value, "inputs");
    const auto* signals_value = json_access::member(value, "signals");
    const auto* state_value = json_access::member(value, "state");
    if (inputs_value == nullptr || !inputs_value->is_array() || signals_value == nullptr ||
        !signals_value->is_array() || state_value == nullptr) {
        diagnostics.push_back(error("editor_preview.layout_contract_required",
                                    "Layout preview contract requires inputs, signals, and state.",
                                    std::string(path)));
        return std::nullopt;
    }

    LayoutContract contract;
    std::set<std::string> input_ids;
    for (std::size_t index = 0; index < inputs_value->size(); ++index) {
        const auto* input_value = json_access::element(*inputs_value, index);
        if (input_value == nullptr)
            return std::nullopt;
        const auto& input = *input_value;
        const auto input_path = std::string(path) + "/inputs/" + std::to_string(index);
        if (!input.is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Layout input definition must be an object.", input_path));
            return std::nullopt;
        }
        exact_fields(input, {"defaultValue", "hasDefault", "id", "nullable", "type"}, diagnostics,
                     input_path);
        const auto* id_value = json_access::member(input, "id");
        const auto* type_value = json_access::member(input, "type");
        const auto* nullable_value = json_access::member(input, "nullable");
        const auto* has_default_value = json_access::member(input, "hasDefault");
        const auto* default_value = json_access::member(input, "defaultValue");
        if (id_value == nullptr || type_value == nullptr || nullable_value == nullptr ||
            !nullable_value->is_boolean() || has_default_value == nullptr ||
            !has_default_value->is_boolean() || default_value == nullptr)
            return std::nullopt;
        auto id = preview_layout_contract_id<LayoutInputId>(*id_value, diagnostics,
                                                            input_path + "/id", limits);
        auto type = preview_layout_contract_value_type(*type_value, diagnostics,
                                                       input_path + "/type", limits);
        if (!id || !type)
            return std::nullopt;
        if (!input_ids.insert(id->text()).second) {
            diagnostics.push_back(error("editor_preview.duplicate_layout_contract_id",
                                        "Layout input ID is duplicated.", input_path + "/id"));
            return std::nullopt;
        }
        LayoutContractValueShape shape{*type, *json_access::get<bool>(*nullable_value)};
        std::optional<RuntimeValue> decoded_default;
        if (*json_access::get<bool>(*has_default_value)) {
            decoded_default =
                runtime_value(*default_value, diagnostics, input_path + "/defaultValue", limits);
            if (!decoded_default || !layout_contract_value_matches(shape, *decoded_default)) {
                diagnostics.push_back(
                    error("editor_preview.layout_contract_default_type",
                          "Layout input default does not match its declared type.",
                          input_path + "/defaultValue"));
                return std::nullopt;
            }
        } else if (!default_value->is_null()) {
            diagnostics.push_back(
                error("editor_preview.layout_contract_default_presence",
                      "Layout input without a default must encode defaultValue as "
                      "null.",
                      input_path + "/defaultValue"));
            return std::nullopt;
        }
        contract.inputs.push_back(
            LayoutInputDefinition{std::move(*id), shape, std::move(decoded_default)});
    }

    std::set<std::string> signal_ids;
    for (std::size_t index = 0; index < signals_value->size(); ++index) {
        const auto* signal_value = json_access::element(*signals_value, index);
        if (signal_value == nullptr)
            return std::nullopt;
        const auto& signal = *signal_value;
        const auto signal_path = std::string(path) + "/signals/" + std::to_string(index);
        if (!signal.is_object())
            return std::nullopt;
        exact_fields(signal, {"fields", "id"}, diagnostics, signal_path);
        const auto* id_value = json_access::member(signal, "id");
        const auto* fields_value = json_access::member(signal, "fields");
        if (id_value == nullptr || fields_value == nullptr || !fields_value->is_array())
            return std::nullopt;
        auto id = preview_layout_contract_id<LayoutSignalId>(*id_value, diagnostics,
                                                             signal_path + "/id", limits);
        if (!id || !signal_ids.insert(id->text()).second) {
            diagnostics.push_back(error("editor_preview.duplicate_layout_contract_id",
                                        "Layout signal ID is invalid or duplicated.",
                                        signal_path + "/id"));
            return std::nullopt;
        }
        LayoutSignalDefinition definition{std::move(*id), {}};
        std::set<std::string> field_ids;
        for (std::size_t field_index = 0; field_index < fields_value->size(); ++field_index) {
            const auto* field_value = json_access::element(*fields_value, field_index);
            if (field_value == nullptr)
                return std::nullopt;
            const auto& field = *field_value;
            const auto field_path = signal_path + "/fields/" + std::to_string(field_index);
            if (!field.is_object())
                return std::nullopt;
            exact_fields(field, {"id", "nullable", "required", "type"}, diagnostics, field_path);
            const auto* field_id_value = json_access::member(field, "id");
            const auto* type_value = json_access::member(field, "type");
            const auto* nullable_value = json_access::member(field, "nullable");
            const auto* required_value = json_access::member(field, "required");
            if (field_id_value == nullptr || type_value == nullptr || nullable_value == nullptr ||
                !nullable_value->is_boolean() || required_value == nullptr ||
                !required_value->is_boolean())
                return std::nullopt;
            auto field_id = preview_layout_contract_id<LayoutSignalFieldId>(
                *field_id_value, diagnostics, field_path + "/id", limits);
            auto field_type = preview_layout_contract_value_type(*type_value, diagnostics,
                                                                 field_path + "/type", limits);
            if (!field_id || !field_type || !field_ids.insert(field_id->text()).second) {
                diagnostics.push_back(error("editor_preview.duplicate_layout_contract_id",
                                            "Layout signal field ID is invalid or duplicated.",
                                            field_path + "/id"));
                return std::nullopt;
            }
            definition.fields.push_back(
                LayoutSignalFieldDefinition{std::move(*field_id),
                                            {*field_type, *json_access::get<bool>(*nullable_value)},
                                            *json_access::get<bool>(*required_value)});
        }
        contract.signals.push_back(std::move(definition));
    }

    if (!state_value->is_null()) {
        auto state = preview_layout_state_shape(*state_value, diagnostics,
                                                std::string(path) + "/state", limits);
        if (!state)
            return std::nullopt;
        contract.state = std::move(*state);
    }
    return contract;
}

bool resolve_layout_preview_samples(const nlohmann::json& sample_state,
                                    const LayoutContract& contract,
                                    TypedEditorLayoutPreviewDocument& result,
                                    Diagnostics& diagnostics,
                                    const EditorRuntimeProtocolLimits& limits)
{
    if (!sample_state.is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Layout preview sampleState must be an object.",
                                    "/sampleState"));
        return false;
    }
    const auto* inputs_value = json_access::member(sample_state, "inputs");
    if (inputs_value != nullptr && !inputs_value->is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "sampleState.inputs must be an object.",
                                    "/sampleState/inputs"));
        return false;
    }
    for (const auto& input : contract.inputs) {
        const nlohmann::json* sample = nullptr;
        if (inputs_value != nullptr)
            sample = json_access::member(*inputs_value, input.id.text());
        if (sample != nullptr) {
            auto value = runtime_value(*sample, diagnostics,
                                       "/sampleState/inputs/" + input.id.text(), limits);
            if (!value || !layout_contract_value_matches(input.shape, *value)) {
                diagnostics.push_back(error("editor_preview.layout_input_sample_type",
                                            "Layout preview input sample does not match its "
                                            "declared type.",
                                            "/sampleState/inputs/" + input.id.text()));
                return false;
            }
            result.preview_inputs.push_back(LayoutResolvedInput{input.id, std::move(*value)});
        } else if (input.default_value) {
            result.preview_inputs.push_back(LayoutResolvedInput{input.id, *input.default_value});
        } else {
            diagnostics.push_back(
                error("editor_preview.layout_input_sample_required",
                      "Layout preview requires a sample value for input '" + input.id.text() + "'.",
                      "/sampleState/inputs/" + input.id.text()));
            return false;
        }
    }
    if (inputs_value != nullptr) {
        for (const auto& [name, _] : inputs_value->items()) {
            const auto known =
                std::find_if(contract.inputs.begin(), contract.inputs.end(),
                             [&](const auto& input) { return input.id.text() == name; });
            if (known == contract.inputs.end()) {
                diagnostics.push_back(
                    error("editor_preview.layout_input_sample_unknown",
                          "sampleState.inputs contains undeclared input '" + name + "'.",
                          "/sampleState/inputs/" + name));
                return false;
            }
        }
    }

    const auto* state_value = json_access::member(sample_state, "state");
    if (state_value != nullptr) {
        if (!contract.state) {
            diagnostics.push_back(error("editor_preview.layout_state_sample_undeclared",
                                        "sampleState.state requires a declared Layout State Shape.",
                                        "/sampleState/state"));
            return false;
        }
        auto value =
            preview_persistable_value(*state_value, diagnostics, "/sampleState/state", limits);
        if (!value || !persistable_value_matches(*contract.state, *value)) {
            diagnostics.push_back(
                error("editor_preview.layout_state_sample_type",
                      "sampleState.state does not match the declared Layout State "
                      "Shape.",
                      "/sampleState/state"));
            return false;
        }
        result.preview_state = std::move(*value);
    } else if (contract.state && contract.state->default_value) {
        result.preview_state = *contract.state->default_value;
    }
    return true;
}

bool safe_project_logical_path(std::string_view value) noexcept
{
    constexpr std::string_view prefix = "project:/";
    if (!value.starts_with(prefix) || value.size() == prefix.size() ||
        value.find('\\') != std::string_view::npos)
        return false;
    value.remove_prefix(prefix.size());
    while (!value.empty()) {
        const auto separator = value.find('/');
        const auto component = value.substr(0, separator);
        if (component.empty() || component == "." || component == "..")
            return false;
        if (separator == std::string_view::npos)
            break;
        value.remove_prefix(separator + 1);
    }
    return true;
}

std::string_view editor_shader_variant_name(EditorPreviewShaderVariant variant) noexcept
{
    switch (variant) {
    case EditorPreviewShaderVariant::Glsl330:
        return "glsl-330";
    case EditorPreviewShaderVariant::Essl300:
        return "essl-300";
    case EditorPreviewShaderVariant::Metal:
        return "metal";
    }
    return {};
}

std::size_t layout_source_limit(const EditorRuntimeProtocolLimits& limits) noexcept
{
    return limits.max_document_bytes;
}

std::size_t layout_source_limit(const FocusedEditorDocumentLimits& limits) noexcept
{
    return limits.max_source_bytes;
}

template<class Limits>
std::optional<TypedEditorLayoutSourceComponent>
preview_layout_source(const nlohmann::json& data, std::string_view key, Diagnostics& diagnostics,
                      const Limits& limits, std::string_view base_path = "/")
{
    const auto path =
        std::string(base_path) + (base_path.ends_with('/') ? "" : "/") + std::string(key);
    const auto found = data.find(std::string(key));
    if (found == data.end() || !found->is_object()) {
        diagnostics.push_back(
            error("editor_preview.wrong_type", "Layout source must be an object.", path));
        return std::nullopt;
    }
    auto kind = string_field(*found, "kind", diagnostics, path, limits);
    if (!kind)
        return std::nullopt;
    if (*kind == "inline") {
        exact_fields(*found, {"kind", "text"}, diagnostics, path);
        auto text =
            string_field_with_limit(*found, "text", diagnostics, path, layout_source_limit(limits));
        if (!text)
            return std::nullopt;
        return TypedEditorLayoutSourceComponent{
            .kind = TypedEditorLayoutSourceComponent::Kind::Inline, .value = std::move(*text)};
    }
    if (*kind == "asset") {
        exact_fields(*found, {"kind", "logicalPath"}, diagnostics, path);
        auto logical_path = string_field(*found, "logicalPath", diagnostics, path, limits);
        if (!logical_path)
            return std::nullopt;
        if (!safe_project_logical_path(*logical_path)) {
            diagnostics.push_back(error("editor_preview.invalid_logical_path",
                                        "Layout Asset source must use a safe project:/ path.",
                                        path + "/logicalPath"));
            return std::nullopt;
        }
        return TypedEditorLayoutSourceComponent{
            .kind = TypedEditorLayoutSourceComponent::Kind::LogicalAsset,
            .value = std::move(*logical_path)};
    }
    diagnostics.push_back(error("editor_preview.invalid_source_kind",
                                "Layout source kind must be 'inline' or 'asset'.", path + "/kind"));
    return std::nullopt;
}

std::optional<std::string> optional_preview_string(const nlohmann::json& object,
                                                   std::string_view key, Diagnostics& diagnostics,
                                                   std::string_view path,
                                                   const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end())
        return std::nullopt;
    if (!found->is_string()) {
        diagnostics.push_back(error("editor_preview.wrong_type", "Expected a string.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    const auto value = found->get<std::string>();
    if (value.size() > limits.max_document_bytes || !valid_utf8(value)) {
        diagnostics.push_back(error("editor_preview.invalid_string",
                                    "Preview string is invalid or exceeds the size limit.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    return value;
}

std::optional<compiled::ReferenceResolution> preview_resolution(const nlohmann::json& object,
                                                                std::string_view key,
                                                                Diagnostics& diagnostics,
                                                                std::string_view path)
{
    const auto field_path = std::string(path) + "/" + std::string(key);
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_object()) {
        diagnostics.push_back(
            error("editor_preview.wrong_type", "Resolution must be an object.", field_path));
        return std::nullopt;
    }
    exact_fields(*found, {"width", "height"}, diagnostics, field_path);
    const auto width_it = found->find("width");
    const auto height_it = found->find("height");
    const auto width =
        width_it == found->end() ? std::optional<std::uint64_t>{} : nonnegative_integer(*width_it);
    const auto height = height_it == found->end() ? std::optional<std::uint64_t>{}
                                                  : nonnegative_integer(*height_it);
    const auto valid_dimension = [](const auto value) {
        return value && *value > 0 && *value <= compiled::max_reference_resolution_dimension;
    };
    if (!valid_dimension(width))
        diagnostics.push_back(error("editor_preview.invalid_resolution",
                                    "Resolution width must be a positive supported integer.",
                                    field_path + "/width"));
    if (!valid_dimension(height))
        diagnostics.push_back(error("editor_preview.invalid_resolution",
                                    "Resolution height must be a positive supported integer.",
                                    field_path + "/height"));
    if (!valid_dimension(width) || !valid_dimension(height))
        return std::nullopt;
    return compiled::ReferenceResolution{static_cast<std::uint32_t>(*width),
                                         static_cast<std::uint32_t>(*height)};
}

std::optional<LayoutScalePolicy>
preview_scale_policy(const nlohmann::json& object, Diagnostics& diagnostics, std::string_view path)
{
    if (!object.is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type", "scalePolicy must be an object.",
                                    std::string(path)));
        return std::nullopt;
    }
    exact_fields(object, {"ui", "text"}, diagnostics, path);
    const auto decode = [&](std::string_view key) -> std::optional<LayoutScaleInheritance> {
        const auto found = object.find(std::string(key));
        const auto field_path = std::string(path) + "/" + std::string(key);
        if (found == object.end() || !found->is_string()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Scale inheritance must be a string.", field_path));
            return std::nullopt;
        }
        const auto value = found->get<std::string>();
        if (value == "inherit")
            return LayoutScaleInheritance::Inherit;
        if (value == "ignore")
            return LayoutScaleInheritance::Ignore;
        diagnostics.push_back(error("editor_preview.invalid_scale_policy",
                                    "Scale inheritance must be 'inherit' or 'ignore'.",
                                    field_path));
        return std::nullopt;
    };
    const auto ui = decode("ui");
    const auto text = decode("text");
    return ui && text ? std::optional{LayoutScalePolicy{*ui, *text}} : std::nullopt;
}

std::optional<compiled::AccessibilityScalePolicy>
preview_accessibility_scale_policy(const nlohmann::json& object, Diagnostics& diagnostics,
                                   std::string_view path)
{
    if (!object.is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Accessibility scale policy must be an object.",
                                    std::string(path)));
        return std::nullopt;
    }
    exact_fields(object, {"enabled", "minimum", "maximum"}, diagnostics, path);
    const auto enabled = object.find("enabled");
    const auto minimum = object.find("minimum");
    const auto maximum = object.find("maximum");
    if (enabled == object.end() || !enabled->is_boolean())
        diagnostics.push_back(error("editor_preview.wrong_type", "enabled must be a boolean.",
                                    std::string(path) + "/enabled"));
    const auto minimum_value = minimum != object.end() && minimum->is_number()
                                   ? std::optional{minimum->get<double>()}
                                   : std::nullopt;
    const auto maximum_value = maximum != object.end() && maximum->is_number()
                                   ? std::optional{maximum->get<double>()}
                                   : std::nullopt;
    if (!minimum_value || !std::isfinite(*minimum_value) || *minimum_value <= 0.0)
        diagnostics.push_back(error("editor_preview.invalid_accessibility",
                                    "minimum must be a positive finite number.",
                                    std::string(path) + "/minimum"));
    if (!maximum_value || !minimum_value || !std::isfinite(*maximum_value) ||
        *maximum_value < *minimum_value)
        diagnostics.push_back(error("editor_preview.invalid_accessibility",
                                    "maximum must be finite and at least minimum.",
                                    std::string(path) + "/maximum"));
    if (enabled == object.end() || !enabled->is_boolean() || !minimum_value || !maximum_value ||
        !std::isfinite(*minimum_value) || !std::isfinite(*maximum_value) || *minimum_value <= 0.0 ||
        *maximum_value < *minimum_value)
        return std::nullopt;
    return compiled::AccessibilityScalePolicy{enabled->get<bool>(), *minimum_value, *maximum_value};
}

std::optional<TypedEditorAuthoredPreviewEnvironment>
preview_authored_environment(const nlohmann::json& document, Diagnostics& diagnostics,
                             const EditorRuntimeProtocolLimits& limits)
{
    const auto environment = document.find("environment");
    if (environment == document.end() || !environment->is_object()) {
        diagnostics.push_back(error("editor_preview.environment_required",
                                    "Authored Layout preview environment is required.",
                                    "/environment"));
        return std::nullopt;
    }
    exact_fields(*environment, {"profile", "project"}, diagnostics, "/environment");
    const auto profile = environment->find("profile");
    const auto project = environment->find("project");
    if (profile == environment->end() || !profile->is_object())
        diagnostics.push_back(error("editor_preview.wrong_type", "profile must be an object.",
                                    "/environment/profile"));
    if (project == environment->end() || !project->is_object())
        diagnostics.push_back(error("editor_preview.wrong_type", "project must be an object.",
                                    "/environment/project"));
    if (profile == environment->end() || !profile->is_object() || project == environment->end() ||
        !project->is_object())
        return std::nullopt;

    exact_fields(*profile, {"name", "nativeResolution", "scalePolicy"}, diagnostics,
                 "/environment/profile");
    exact_fields(*project,
                 {"referenceResolution", "worldRasterPolicy", "barColor", "accessibility"},
                 diagnostics, "/environment/project");
    auto name = string_field(*profile, "name", diagnostics, "/environment/profile", limits);
    auto native_resolution =
        preview_resolution(*profile, "nativeResolution", diagnostics, "/environment/profile");
    const auto scale_policy_it = profile->find("scalePolicy");
    if (scale_policy_it == profile->end()) {
        diagnostics.push_back(error("editor_preview.missing_field",
                                    "Missing authored Layout scalePolicy.",
                                    "/environment/profile/scalePolicy"));
    }
    auto scale_policy = scale_policy_it == profile->end()
                            ? std::optional<LayoutScalePolicy>{}
                            : preview_scale_policy(*scale_policy_it, diagnostics,
                                                   "/environment/profile/scalePolicy");
    auto reference_resolution =
        preview_resolution(*project, "referenceResolution", diagnostics, "/environment/project");

    compiled::WorldRasterPolicy world_raster_policy = compiled::WorldRasterPolicy::Capped;
    const auto world_raster = project->find("worldRasterPolicy");
    if (world_raster == project->end() || !world_raster->is_string()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "worldRasterPolicy must be a string.",
                                    "/environment/project/worldRasterPolicy"));
    } else if (world_raster->get<std::string>() == "native") {
        world_raster_policy = compiled::WorldRasterPolicy::Native;
    } else if (world_raster->get<std::string>() != "capped") {
        diagnostics.push_back(error("editor_preview.invalid_world_raster_policy",
                                    "worldRasterPolicy must be 'capped' or 'native'.",
                                    "/environment/project/worldRasterPolicy"));
    }

    auto bar_color =
        string_field(*project, "barColor", diagnostics, "/environment/project", limits);
    if (bar_color) {
        unsigned rgb = 0;
        const auto parsed = bar_color->size() == 7 && bar_color->front() == '#'
                                ? std::from_chars(bar_color->data() + 1,
                                                  bar_color->data() + bar_color->size(), rgb, 16)
                                : std::from_chars(bar_color->data(), bar_color->data(), rgb, 16);
        if (bar_color->size() != 7 || bar_color->front() != '#' || parsed.ec != std::errc{} ||
            parsed.ptr != bar_color->data() + bar_color->size()) {
            diagnostics.push_back(error("editor_preview.invalid_bar_color",
                                        "barColor must be #RRGGBB.",
                                        "/environment/project/barColor"));
        }
    }

    const auto accessibility = project->find("accessibility");
    std::optional<compiled::AccessibilityScalePolicy> ui_scale;
    std::optional<compiled::AccessibilityScalePolicy> text_scale;
    if (accessibility == project->end() || !accessibility->is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type", "accessibility must be an object.",
                                    "/environment/project/accessibility"));
    } else {
        exact_fields(*accessibility, {"uiScale", "textScale"}, diagnostics,
                     "/environment/project/accessibility");
        const auto ui = accessibility->find("uiScale");
        const auto text = accessibility->find("textScale");
        if (ui == accessibility->end()) {
            diagnostics.push_back(error("editor_preview.missing_field",
                                        "Missing UI accessibility scale policy.",
                                        "/environment/project/accessibility/uiScale"));
        } else {
            ui_scale = preview_accessibility_scale_policy(
                *ui, diagnostics, "/environment/project/accessibility/uiScale");
        }
        if (text == accessibility->end()) {
            diagnostics.push_back(error("editor_preview.missing_field",
                                        "Missing text accessibility scale policy.",
                                        "/environment/project/accessibility/textScale"));
        } else {
            text_scale = preview_accessibility_scale_policy(
                *text, diagnostics, "/environment/project/accessibility/textScale");
        }
    }

    if (name && name->empty()) {
        diagnostics.push_back(error("editor_preview.invalid_profile_name",
                                    "Authored preview profile name must not be empty.",
                                    "/environment/profile/name"));
    }
    const bool complete = name && !name->empty() && native_resolution && scale_policy &&
                          reference_resolution && bar_color && ui_scale && text_scale;
    if (!complete && diagnostics.empty()) {
        diagnostics.push_back(error("editor_preview.environment_invalid",
                                    "Authored preview environment is incomplete.", "/environment"));
    }
    if (!complete || !diagnostics.empty())
        return std::nullopt;
    return TypedEditorAuthoredPreviewEnvironment{
        .profile_name = std::move(*name),
        .native_resolution = *native_resolution,
        .scale_policy = *scale_policy,
        .project_display = {.reference_resolution = *reference_resolution,
                            .bar_color = std::move(*bar_color),
                            .world_raster_policy = world_raster_policy},
        .accessibility = {.ui_scale = *ui_scale, .text_scale = *text_scale},
    };
}

void append_material_diagnostics(const std::vector<MaterialDiagnostic>& material_diagnostics,
                                 Diagnostics& diagnostics, std::string_view fallback_path)
{
    for (const auto& material : material_diagnostics) {
        if (material.severity != MaterialDiagnosticSeverity::Error)
            continue;
        diagnostics.push_back(error(
            "editor_preview.shader_material." + std::string(to_string(material.code)),
            material.message, material.path.empty() ? std::string(fallback_path) : material.path));
    }
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

std::optional<std::vector<compiled::InteractionSubject>>
subject_array(const nlohmann::json& object, std::string_view key, Diagnostics& diagnostics,
              std::string_view path, const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_array() || found->size() > limits.max_ids_per_input) {
        diagnostics.push_back(error("editor_protocol.wrong_type",
                                    "Expected a bounded Interaction subject array.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    std::vector<compiled::InteractionSubject> result;
    for (std::size_t index = 0; index < found->size(); ++index) {
        const auto item_path =
            std::string(path) + "/" + std::string(key) + "/" + std::to_string(index);
        const auto& item = (*found)[index];
        if (!item.is_object()) {
            diagnostics.push_back(error("editor_protocol.wrong_type",
                                        "Expected an Interaction subject object.", item_path));
            continue;
        }
        const auto kind = string_field(item, "kind", diagnostics, item_path, limits);
        if (kind && *kind == "character") {
            exact_fields(item, {"kind", "id"}, diagnostics, item_path);
            auto id = id_field<CharacterId>(item, "id", diagnostics, item_path, limits);
            if (id)
                result.emplace_back(compiled::CharacterInteractionSubject{std::move(*id)});
        } else if (kind && *kind == "interactable") {
            exact_fields(item, {"kind", "id"}, diagnostics, item_path);
            auto id = id_field<InteractableInstanceId>(item, "id", diagnostics, item_path, limits);
            if (id)
                result.emplace_back(compiled::InteractableInteractionSubject{std::move(*id)});
        } else if (kind && *kind == "feature") {
            exact_fields(item, {"kind", "ownerKind", "ownerId", "featureId"}, diagnostics,
                         item_path);
            auto owner_kind = string_field(item, "ownerKind", diagnostics, item_path, limits);
            auto feature = id_field<FeatureId>(item, "featureId", diagnostics, item_path, limits);
            if (!owner_kind || !feature)
                continue;
            if (*owner_kind == "room") {
                auto owner = id_field<RoomId>(item, "ownerId", diagnostics, item_path, limits);
                if (owner)
                    result.emplace_back(compiled::FeatureInteractionSubject{
                        RoomFeatureRef{std::move(*owner), std::move(*feature)}});
            } else if (*owner_kind == "interactable") {
                auto owner = id_field<InteractableInstanceId>(item, "ownerId", diagnostics,
                                                              item_path, limits);
                if (owner)
                    result.emplace_back(compiled::FeatureInteractionSubject{
                        InteractableFeatureRef{std::move(*owner), std::move(*feature)}});
            } else {
                diagnostics.push_back(error("editor_protocol.invalid_subject_kind",
                                            "Feature ownerKind must be room or interactable.",
                                            item_path + "/ownerKind"));
            }
        } else if (kind) {
            diagnostics.push_back(
                error("editor_protocol.invalid_subject_kind",
                      "Interaction subject kind must be character, interactable, or feature.",
                      item_path + "/kind"));
        }
    }
    return diagnostics.empty() ? std::optional{std::move(result)} : std::nullopt;
}

std::optional<std::vector<InteractionSubjectBinding>>
binding_array(const nlohmann::json& object, std::string_view key, Diagnostics& diagnostics,
              std::string_view path, const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_array() || found->size() > limits.max_ids_per_input) {
        diagnostics.push_back(error("editor_protocol.wrong_type",
                                    "Expected a bounded Interaction binding array.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    std::vector<InteractionSubjectBinding> result;
    for (std::size_t index = 0; index < found->size(); ++index) {
        const auto item_path =
            std::string(path) + "/" + std::string(key) + "/" + std::to_string(index);
        const auto& item = (*found)[index];
        if (!item.is_object()) {
            diagnostics.push_back(error("editor_protocol.wrong_type",
                                        "Expected an Interaction binding object.", item_path));
            continue;
        }
        exact_fields(item, {"slotId", "subject"}, diagnostics, item_path);
        auto slot = id_field<VerbSlotId>(item, "slotId", diagnostics, item_path, limits);
        const auto subject = item.find("subject");
        if (subject == item.end()) {
            diagnostics.push_back(
                error("editor_protocol.missing_field", "Missing subject.", item_path + "/subject"));
            continue;
        }
        nlohmann::json wrapper{{"subjects", nlohmann::json::array({*subject})}};
        auto subjects = subject_array(wrapper, "subjects", diagnostics, item_path, limits);
        if (slot && subjects && subjects->size() == 1)
            result.push_back(
                InteractionSubjectBinding{std::move(*slot), std::move(subjects->front())});
    }
    return diagnostics.empty() ? std::optional{std::move(result)} : std::nullopt;
}

nlohmann::json encode_subject(const compiled::InteractionSubject& subject)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::CharacterInteractionSubject>)
                return nlohmann::json{{"kind", "character"}, {"id", value.character.text()}};
            else if constexpr (std::is_same_v<T, compiled::InteractableInteractionSubject>)
                return nlohmann::json{{"kind", "interactable"}, {"id", value.interactable.text()}};
            else
                return std::visit(
                    [](const auto& reference) -> nlohmann::json {
                        using R = std::decay_t<decltype(reference)>;
                        if constexpr (std::is_same_v<R, RoomFeatureRef>)
                            return {{"kind", "feature"},
                                    {"ownerKind", "room"},
                                    {"ownerId", reference.room.text()},
                                    {"featureId", reference.feature_id.text()}};
                        else
                            return {{"kind", "feature"},
                                    {"ownerKind", "interactable"},
                                    {"ownerId", reference.interactable.text()},
                                    {"featureId", reference.feature_id.text()}};
                    },
                    value.feature);
        },
        subject);
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
            return success(ClearInteractionSubjectSelectionInput{});
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
    } else if (*type == "select-subjects") {
        exact_fields(*input, {"type", "subjects"}, diagnostics, path);
        auto ids = subject_array(*input, "subjects", diagnostics, path, limits);
        if (ids)
            return success(SelectInteractionSubjectsInput{std::move(*ids)});
    } else if (*type == "primary-activate" || *type == "open-verb-menu") {
        exact_fields(*input, {"type", "subject"}, diagnostics, path);
        const auto found = input->find("subject");
        if (found == input->end()) {
            diagnostics.push_back(error("editor_protocol.missing_field", "Missing subject.",
                                        std::string(path) + "/subject"));
        } else {
            nlohmann::json wrapper{{"subjects", nlohmann::json::array({*found})}};
            auto subjects = subject_array(wrapper, "subjects", diagnostics, path, limits);
            if (subjects && subjects->size() == 1) {
                if (*type == "primary-activate")
                    return success(PrimaryActivateInput{std::move(subjects->front())});
                return success(OpenVerbMenuInput{std::move(subjects->front())});
            }
        }
    } else if (*type == "invoke-interaction") {
        exact_fields(*input, {"type", "verb", "bindings"}, diagnostics, path);
        auto verb = id_field<VerbId>(*input, "verb", diagnostics, path, limits);
        auto bindings = binding_array(*input, "bindings", diagnostics, path, limits);
        if (verb && bindings)
            return success(InvokeInteractionInput{std::move(*verb), std::move(*bindings)});
    } else if (*type == "set-variable") {
        exact_fields(*input, {"type", "variable", "value"}, diagnostics, path);
        auto variable = id_field<PropertyId>(*input, "variable", diagnostics, path, limits);
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

nlohmann::json encode_inventory_owner(const compiled::InventoryOwnerRef& owner)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::ProjectInventoryOwner>)
                return {{"kind", "project"}};
            else if constexpr (std::is_same_v<T, compiled::CharacterInventoryOwner>)
                return {{"kind", "character"}, {"character", value.character.text()}};
            else if constexpr (std::is_same_v<T, compiled::InteractableInventoryOwner>)
                return {{"kind", "interactable"}, {"interactable", value.interactable.text()}};
            else if constexpr (std::is_same_v<T, RoomFeatureRef>)
                return {{"kind", "room-feature"},
                        {"room", value.room.text()},
                        {"feature", value.feature_id.text()}};
            else
                return {{"kind", "interactable-feature"},
                        {"interactable", value.interactable.text()},
                        {"feature", value.feature_id.text()}};
        },
        owner);
}

nlohmann::json encode_inventory_ref(const compiled::InventoryRef& inventory)
{
    return {{"owner", encode_inventory_owner(inventory.owner)},
            {"id", inventory.inventory_id.text()}};
}

nlohmann::json encode_view(const TypedRuntimeUIViewState& view)
{
    nlohmann::json out = {{"mode", view.mode},
                          {"gameplayPaused", view.gameplay_paused},
                          {"canContinue", view.can_continue},
                          {"verbMenuOpen", view.verb_menu_open},
                          {"verbOffers", nlohmann::json::array()},
                          {"selectedSubjects", nlohmann::json::array()},
                          {"inventories", nlohmann::json::array()},
                          {"inventory", nlohmann::json::array()},
                          {"textLog", nlohmann::json::array()}};
    for (const auto& offer : view.verb_offers) {
        nlohmann::json binding_order = nlohmann::json::array();
        for (const auto& slot : offer.binding_order)
            binding_order.push_back(slot.text());
        out["verbOffers"].push_back({{"verb", offer.verb.text()},
                                     {"slotId", offer.slot.text()},
                                     {"label", offer.label},
                                     {"bindingOrder", std::move(binding_order)},
                                     {"rank", offer.rank},
                                     {"primary", offer.primary}});
    }
    for (const auto& id : view.selected_subjects)
        out["selectedSubjects"].push_back(encode_subject(id));
    for (const auto& inventory : view.inventory.inventories) {
        out["inventories"].push_back(
            {{"inventory", encode_inventory_ref(inventory.inventory)},
             {"label", inventory.label},
             {"effectiveRoom", inventory.effective_room
                                   ? nlohmann::json(inventory.effective_room->text())
                                   : nlohmann::json(nullptr)}});
    }
    for (const auto& item : view.inventory.items) {
        out["inventory"].push_back(
            {{"id", item.interactable.text()},
             {"definition",
              item.definition ? nlohmann::json(item.definition->text()) : nlohmann::json(nullptr)},
             {"inventory", encode_inventory_ref(item.inventory)},
             {"effectiveRoom", item.effective_room ? nlohmann::json(item.effective_room->text())
                                                   : nlohmann::json(nullptr)},
             {"label", item.display_name},
             {"quantity", item.quantity},
             {"stackable", item.stackable},
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
        for (const auto& placement : view.room->placements) {
            nlohmann::json occupants = nlohmann::json::array();
            for (const auto& occupant : placement.occupants) {
                nlohmann::json encoded{{"enabled", occupant.enabled},
                                       {"visible", occupant.visible}};
                std::visit(
                    [&encoded](const auto& subject) {
                        using T = std::decay_t<decltype(subject)>;
                        if constexpr (std::is_same_v<T, compiled::CharacterInteractionSubject>) {
                            encoded["kind"] = "character";
                            encoded["character"] = subject.character.text();
                        } else if constexpr (std::is_same_v<
                                                 T, compiled::InteractableInteractionSubject>) {
                            encoded["kind"] = "interactable";
                            encoded["interactable"] = subject.interactable.text();
                        } else {
                            encoded.update(std::visit(
                                [](const auto& reference) -> nlohmann::json {
                                    using R = std::decay_t<decltype(reference)>;
                                    if constexpr (std::is_same_v<R, RoomFeatureRef>)
                                        return {{"kind", "feature"},
                                                {"ownerKind", "room"},
                                                {"ownerId", reference.room.text()},
                                                {"featureId", reference.feature_id.text()}};
                                    else
                                        return {{"kind", "feature"},
                                                {"ownerKind", "interactable"},
                                                {"ownerId", reference.interactable.text()},
                                                {"featureId", reference.feature_id.text()}};
                                },
                                subject.feature));
                        }
                    },
                    occupant.subject);
                occupants.push_back(std::move(encoded));
            }
            out["room"]["placements"].push_back(
                {{"id", placement.placement.text()}, {"occupants", std::move(occupants)}});
        }
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
                              {"bindings", nlohmann::json::array()}};
    if (view.interaction)
        for (const auto& binding : view.interaction->bindings)
            out["interaction"]["bindings"].push_back(
                {{"slotId", binding.slot_id.text()}, {"subject", encode_subject(binding.subject)}});
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

nlohmann::json encode_save_outcome(const SaveOutcome& value)
{
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
    const std::string slot =
        value.slot.is_autosave() ? "autosave" : "manual-" + std::to_string(value.slot.number());
    return {{"type", "save-outcome"},
            {"slot", slot},
            {"status", std::move(status)},
            {"autosave", value.autosave}};
}

nlohmann::json encode_observation(const RuntimeObservation& value)
{
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
            else if constexpr (std::is_same_v<O, RoomPresentationDiagnosticObservation>) {
                nlohmann::json diagnostics = nlohmann::json::array();
                for (const auto& diagnostic : observation.diagnostics)
                    diagnostics.push_back(
                        {{"code", diagnostic.code},
                         {"message", diagnostic.message},
                         {"severity", static_cast<std::uint8_t>(diagnostic.severity)}});
                return {{"type", "room-presentation-diagnostic"},
                        {"room", observation.room.text()},
                        {"diagnostics", std::move(diagnostics)}};
            } else if constexpr (std::is_same_v<O, VerbOfferAmbiguityObservation>) {
                nlohmann::json verbs = nlohmann::json::array();
                for (const auto& verb : observation.primary_verbs)
                    verbs.push_back(verb.text());
                return {{"type", "verb-offer-ambiguity-observation"},
                        {"primaryVerbs", std::move(verbs)}};
            } else if constexpr (std::is_same_v<O, LayoutSignalObservation>) {
                nlohmann::json fields = nlohmann::json::array();
                for (const auto& field : observation.fields)
                    fields.push_back({{"field", field.field.text()}});
                return {{"type", "layout-signal-observation"},
                        {"occurrence", observation.occurrence.number()},
                        {"signal", observation.signal.text()},
                        {"fields", std::move(fields)}};
            } else if constexpr (std::is_same_v<O, CheckpointRuntimeObservation>) {
                nlohmann::json issues = nlohmann::json::array();
                for (const auto& issue : observation.readiness.issues) {
                    issues.push_back({{"reason", static_cast<std::uint8_t>(issue.reason)},
                                      {"code", issue.diagnostic.code},
                                      {"message", issue.diagnostic.message},
                                      {"hasBarrier", issue.barrier.has_value()}});
                }
                nlohmann::json retained = nullptr;
                if (observation.retained_revision && observation.retained_metadata) {
                    retained = {{"revision", observation.retained_revision->number()},
                                {"saveFileFormatVersion", save_file_format_version},
                                {"project", observation.retained_metadata->project.text()},
                                {"projectVersion", observation.retained_metadata->project_version},
                                {"saveContract", observation.retained_metadata->save_contract},
                                {"playTimeMs", observation.retained_metadata->play_time.count()}};
                }
                nlohmann::json reconstructible = nullptr;
                if (observation.presentation.reconstructible_activity) {
                    const auto& activity = *observation.presentation.reconstructible_activity;
                    reconstructible = {
                        {"snapshotRevision", activity.snapshot.number()},
                        {"actorIdleCount", activity.actor_idles.size()},
                        {"environmentLoopCount", activity.environment_loops.size()},
                        {"desiredAudioCount", activity.desired_audio.size()},
                    };
                }
                return {
                    {"type", "checkpoint-observation"},
                    {"readinessRevision", observation.readiness.revision.number()},
                    {"canCapture", observation.readiness.can_capture()},
                    {"issues", std::move(issues)},
                    {"presentationStatusRevision", observation.presentation.revision.number()},
                    {"activeBarrierCount", observation.presentation.active_barriers.size()},
                    {"reconstructibleActivity", std::move(reconstructible)},
                    {"retained", std::move(retained)},
                    {"replayDistance",
                     {{"structuralGenerations", observation.replay_distance.structural_generations},
                      {"timeGenerations", observation.replay_distance.time_generations},
                      {"playTimeMs", observation.replay_distance.play_time.count()}}},
                    {"thumbnailAvailable", observation.thumbnail_available},
                    {"thumbnailCapturePending", observation.thumbnail_capture_pending},
                };
            } else
                static_assert(always_false<O>, "Unhandled RuntimeObservation alternative");
        },
        value);
}

nlohmann::json encode_event(const runtime::RuntimeEvent& event)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, runtime::NotificationEvent>)
                return {{"type", "notification"}, {"message", value.message}};
            else if constexpr (std::is_same_v<T, runtime::SaveOutcomeEvent>)
                return encode_save_outcome(value.outcome);
            else if constexpr (std::is_same_v<T, runtime::ObservationEvent>)
                return encode_observation(value.observation);
            else
                static_assert(always_false<T>, "Unhandled RuntimeEvent alternative");
        },
        event);
}

nlohmann::json encode_publication(const runtime::RuntimePublication& publication)
{
    const auto& presentation = publication.presentation;
    nlohmann::json observations = nlohmann::json::array();
    for (const auto& observation : publication.observations.values)
        observations.push_back(encode_observation(observation));
    nlohmann::json instances = nlohmann::json::array();
    for (const auto& snapshot : publication.gameplay_instances) {
        std::string kind;
        std::string id;
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, RoomId>)
                    kind = "room";
                else if constexpr (std::is_same_v<T, CharacterId>)
                    kind = "character";
                else
                    kind = "interactable";
                id = value.text();
            },
            snapshot.instance);
        std::string provenance = "declared";
        switch (snapshot.provenance.kind) {
        case RuntimeInstanceProvenanceKind::Declared:
            provenance = "declared";
            break;
        case RuntimeInstanceProvenanceKind::Archetype:
            provenance = "archetype";
            break;
        case RuntimeInstanceProvenanceKind::CompiledDefinition:
            provenance = "compiled-definition";
            break;
        case RuntimeInstanceProvenanceKind::Clone:
            provenance = "clone";
            break;
        }
        nlohmann::json source = nullptr;
        if (snapshot.provenance.source_instance)
            std::visit([&](const auto& value) { source = value.text(); },
                       *snapshot.provenance.source_instance);
        instances.push_back(
            {{"kind", std::move(kind)},
             {"id", std::move(id)},
             {"declared", snapshot.declared},
             {"provenance", std::move(provenance)},
             {"archetype", snapshot.provenance.archetype
                               ? nlohmann::json(snapshot.provenance.archetype->text())
                               : nlohmann::json(nullptr)},
             {"source", std::move(source)}});
    }
    return {
        {"revision", publication.revision.number()},
        {"gameplayUi", encode_view(publication.gameplay_ui)},
        {"presentation",
         {{"revision", presentation.revision.number()},
          {"actorCount", presentation.actors.size()},
          {"interactableCount", presentation.interactables.size()},
          {"propCount", presentation.props.size()},
          {"environmentCount", presentation.environments.size()},
          {"layoutCount", presentation.layouts.size()},
          {"desiredAudioCount", presentation.desired_audio.size()}}},
        {"observations", std::move(observations)},
        {"gameplayInstances", std::move(instances)},
    };
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
    auto document = parse_editor_protocol_document(text, limits);
    if (!document)
        return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(document).error());
    return decode_editor_runtime_input(*document.value_if(), limits);
}

Result<RuntimeValue, Diagnostics>
decode_editor_runtime_value_text(std::string_view text, const EditorRuntimeProtocolLimits& limits)
{
    auto parsed = parse_editor_protocol_document(text, limits);
    if (!parsed)
        return Result<RuntimeValue, Diagnostics>::failure(std::move(parsed).error());
    auto& document = *parsed.value_if();
    Diagnostics diagnostics;
    auto value = runtime_value(document, diagnostics, "/value", limits);
    if (!value || !diagnostics.empty())
        return Result<RuntimeValue, Diagnostics>::failure(std::move(diagnostics));
    return Result<RuntimeValue, Diagnostics>::success(std::move(*value));
}

Result<std::vector<compiled::InteractionSubject>, Diagnostics>
decode_editor_interaction_subjects_text(std::string_view text,
                                        const EditorRuntimeProtocolLimits& limits)
{
    auto parsed = parse_editor_protocol_document(text, limits);
    if (!parsed)
        return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::failure(
            std::move(parsed).error());
    auto& document = *parsed.value_if();

    Diagnostics diagnostics;
    if (!document.is_array()) {
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "Expected an array.", "/subjects"));
        return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::failure(
            std::move(diagnostics));
    }
    if (document.size() > limits.max_ids_per_input) {
        diagnostics.push_back(error("editor_protocol.size_limit",
                                    "Interaction subject array exceeds size limit.", "/subjects"));
        return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::failure(
            std::move(diagnostics));
    }

    std::vector<compiled::InteractionSubject> subjects;
    subjects.reserve(document.size());
    for (std::size_t index = 0; index < document.size(); ++index) {
        const auto path = "/subjects/" + std::to_string(index);
        const auto& item = document[index];
        exact_fields(item, {"kind", "id"}, diagnostics, path);
        auto kind = string_field(item, "kind", diagnostics, path, limits);
        if (!kind)
            continue;
        if (*kind == "character") {
            auto id = id_field<CharacterId>(item, "id", diagnostics, path, limits);
            if (id)
                subjects.emplace_back(compiled::CharacterInteractionSubject{std::move(*id)});
        } else if (*kind == "interactable") {
            auto id = id_field<InteractableInstanceId>(item, "id", diagnostics, path, limits);
            if (id)
                subjects.emplace_back(compiled::InteractableInteractionSubject{std::move(*id)});
        } else {
            diagnostics.push_back(error("editor_protocol.invalid_subject_kind",
                                        "Interaction subject kind is unsupported.",
                                        path + "/kind"));
        }
    }
    if (!diagnostics.empty())
        return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::failure(
            std::move(diagnostics));
    return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::success(
        std::move(subjects));
}

Result<std::vector<InteractionSubjectBinding>, Diagnostics>
decode_editor_interaction_bindings_text(std::string_view text,
                                        const EditorRuntimeProtocolLimits& limits)
{
    auto parsed = parse_editor_protocol_document(text, limits);
    if (!parsed)
        return Result<std::vector<InteractionSubjectBinding>, Diagnostics>::failure(
            std::move(parsed).error());
    auto& document = *parsed.value_if();
    Diagnostics diagnostics;
    if (!document.is_array()) {
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "Expected an array.", "/bindings"));
        return Result<std::vector<InteractionSubjectBinding>, Diagnostics>::failure(
            std::move(diagnostics));
    }
    nlohmann::json wrapper{{"bindings", document}};
    auto bindings = binding_array(wrapper, "bindings", diagnostics, "", limits);
    if (!bindings || !diagnostics.empty())
        return Result<std::vector<InteractionSubjectBinding>, Diagnostics>::failure(
            std::move(diagnostics));
    return Result<std::vector<InteractionSubjectBinding>, Diagnostics>::success(
        std::move(*bindings));
}

Result<TypedEditorPreviewDocument, Diagnostics>
decode_editor_preview_document_text(std::string_view kind, std::string_view data_text,
                                    const EditorRuntimeProtocolLimits& limits)
{
    if (kind.size() > limits.max_string_bytes || data_text.size() > limits.max_document_bytes) {
        return Result<TypedEditorPreviewDocument, Diagnostics>::failure(
            Diagnostics{error("editor_preview.size_limit", "Preview request exceeds size limit.")});
    }
    auto document = nlohmann::json::parse(data_text.empty() ? "{}" : data_text, nullptr, false);
    if (document.is_discarded()) {
        return Result<TypedEditorPreviewDocument, Diagnostics>::failure(
            Diagnostics{error("editor_preview.malformed_json", "Malformed preview JSON.")});
    }
    if (!document.is_object()) {
        return Result<TypedEditorPreviewDocument, Diagnostics>::failure(Diagnostics{
            error("editor_preview.wrong_type", "Preview data must be an object.", "/")});
    }

    Diagnostics diagnostics;
    if (kind == "layout-preview") {
        TypedEditorLayoutPreviewDocument result;
        exact_fields(document,
                     {"schema", "contentMode", "layoutId", "layoutKind", "templateId", "sourceUrl",
                      "defaultParent", "scopedStyles", "script", "rml", "rcss", "lua",
                      "scalePolicy", "contract", "sampleState", "environment", "cursors",
                      "shaderMaterials"},
                     diagnostics, "/");
        const auto schema = string_field(document, "schema", diagnostics, "/", limits);
        if (schema && *schema != "noveltea.layout-preview")
            diagnostics.push_back(error("editor_preview.invalid_schema",
                                        "Layout preview schema must be noveltea.layout-preview.",
                                        "/schema"));
        const auto content_mode = string_field(document, "contentMode", diagnostics, "/", limits);
        if (content_mode && *content_mode != "layout")
            diagnostics.push_back(error("editor_preview.invalid_content_mode",
                                        "Layout preview contentMode must be layout.",
                                        "/contentMode"));
        if (auto value = string_field(document, "layoutId", diagnostics, "/", limits))
            result.layout_id = std::move(*value);
        if (auto value = string_field(document, "sourceUrl", diagnostics, "/", limits)) {
            if (!safe_project_logical_path(*value))
                diagnostics.push_back(error("editor_preview.invalid_source_url",
                                            "Layout sourceUrl must use a safe project:/ path.",
                                            "/sourceUrl"));
            else
                result.source_url = std::move(*value);
        }
        const auto* contract = json_access::member(document, "contract");
        if (contract != nullptr) {
            auto decoded_contract =
                preview_layout_contract(*contract, diagnostics, "/contract", limits);
            if (!decoded_contract) {
                if (diagnostics.empty())
                    diagnostics.push_back(error(
                        "editor_preview.invalid_layout_contract",
                        "Layout contract contains a missing, invalid, or oversized declaration.",
                        "/contract"));
                return Result<TypedEditorPreviewDocument, Diagnostics>::failure(
                    std::move(diagnostics));
            }
            result.contract = std::move(*decoded_contract);
        }
        const auto* sample_state = json_access::member(document, "sampleState");
        const nlohmann::json empty_sample_state = nlohmann::json::object();
        const auto& sample = sample_state == nullptr ? empty_sample_state : *sample_state;
        (void)resolve_layout_preview_samples(sample, result.contract, result, diagnostics, limits);
        auto environment = preview_authored_environment(document, diagnostics, limits);
        if (environment)
            result.environment = std::move(*environment);

        if (const auto cursors = document.find("cursors");
            cursors == document.end() || !cursors->is_object()) {
            diagnostics.push_back(
                error("editor_preview.wrong_type", "cursors must be an object.", "/cursors"));
        } else {
            exact_fields(*cursors, {"defaultCursor", "pointerCursor", "hotspotCursor", "named"},
                         diagnostics, "/cursors");
            if (auto value =
                    string_field(*cursors, "defaultCursor", diagnostics, "/cursors", limits))
                result.cursors.default_cursor = std::move(*value);
            if (auto value =
                    string_field(*cursors, "pointerCursor", diagnostics, "/cursors", limits))
                result.cursors.pointer_cursor = std::move(*value);
            if (auto value =
                    string_field(*cursors, "hotspotCursor", diagnostics, "/cursors", limits))
                result.cursors.hotspot_cursor = std::move(*value);
            const auto named = cursors->find("named");
            if (named == cursors->end() || !named->is_array()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "cursors.named must be an array.", "/cursors/named"));
            } else {
                for (std::size_t index = 0; index < named->size(); ++index) {
                    const auto& value = (*named)[index];
                    const std::string base = "/cursors/named/" + std::to_string(index);
                    if (!value.is_object()) {
                        diagnostics.push_back(error("editor_preview.wrong_type",
                                                    "Named cursor must be an object.", base));
                        continue;
                    }
                    exact_fields(value,
                                 {"id", "logicalPath", "width", "height", "hotspotX", "hotspotY"},
                                 diagnostics, base);
                    auto id = string_field(value, "id", diagnostics, base, limits);
                    auto logical_path =
                        string_field(value, "logicalPath", diagnostics, base, limits);
                    const auto read_uint =
                        [&](std::string_view field) -> std::optional<std::uint32_t> {
                        const auto it = value.find(std::string(field));
                        if (it == value.end() || !it->is_number_unsigned()) {
                            diagnostics.push_back(
                                error("editor_preview.wrong_type",
                                      std::string(field) + " must be an unsigned integer.",
                                      base + "/" + std::string(field)));
                            return std::nullopt;
                        }
                        const auto number = it->get<std::uint64_t>();
                        if (number > std::numeric_limits<std::uint32_t>::max()) {
                            diagnostics.push_back(error("editor_preview.invalid_number",
                                                        std::string(field) + " is out of range.",
                                                        base + "/" + std::string(field)));
                            return std::nullopt;
                        }
                        return static_cast<std::uint32_t>(number);
                    };
                    auto width = read_uint("width");
                    auto height = read_uint("height");
                    auto hotspot_x = read_uint("hotspotX");
                    auto hotspot_y = read_uint("hotspotY");
                    if (logical_path && !safe_project_logical_path(*logical_path)) {
                        diagnostics.push_back(
                            error("editor_preview.invalid_resource_path",
                                  "Cursor logicalPath must use a safe project:/ path.",
                                  base + "/logicalPath"));
                        logical_path.reset();
                    }
                    if (id && logical_path && width && height && hotspot_x && hotspot_y) {
                        result.cursors.named.push_back(TypedEditorPreviewCursorDefinition{
                            .id = std::move(*id),
                            .logical_path = std::move(*logical_path),
                            .width = *width,
                            .height = *height,
                            .hotspot_x = *hotspot_x,
                            .hotspot_y = *hotspot_y,
                        });
                    }
                }
            }
        }
        auto rml = preview_layout_source(document, "rml", diagnostics, limits);
        auto rcss = preview_layout_source(document, "rcss", diagnostics, limits);
        auto lua = preview_layout_source(document, "lua", diagnostics, limits);
        if (rml)
            result.rml = std::move(*rml);
        if (rcss)
            result.rcss = std::move(*rcss);
        if (lua)
            result.lua = std::move(*lua);

        if (auto layout_kind = string_field(document, "layoutKind", diagnostics, "/", limits)) {
            if (*layout_kind == "document")
                result.layout_kind = EditorPreviewLayoutKind::Document;
            else if (*layout_kind == "fragment")
                result.layout_kind = EditorPreviewLayoutKind::Fragment;
            else
                diagnostics.push_back(error("editor_preview.invalid_layout_kind",
                                            "layoutKind must be 'document' or 'fragment'.",
                                            "/layoutKind"));
        }

        const auto template_id = document.find("templateId");
        if (template_id == document.end() ||
            (!template_id->is_null() && !template_id->is_string())) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "templateId must be a string or null.", "/templateId"));
        } else if (template_id->is_string()) {
            result.template_id = template_id->get<std::string>();
            if (*result.template_id != "layout-fragment-host-v1")
                diagnostics.push_back(error("editor_preview.invalid_template_id",
                                            "Unsupported Layout preview templateId.",
                                            "/templateId"));
        }
        if (result.layout_kind == EditorPreviewLayoutKind::Fragment && !result.template_id)
            diagnostics.push_back(error("editor_preview.template_required",
                                        "Fragment Layout preview requires layout-fragment-host-v1.",
                                        "/templateId"));
        if (result.layout_kind == EditorPreviewLayoutKind::Document && result.template_id)
            diagnostics.push_back(error("editor_preview.template_forbidden",
                                        "Document Layout preview must not specify templateId.",
                                        "/templateId"));

        const auto default_parent = document.find("defaultParent");
        if (default_parent == document.end() ||
            (!default_parent->is_null() && !default_parent->is_string())) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "defaultParent must be a string or null.",
                                        "/defaultParent"));
        } else if (default_parent->is_string()) {
            const auto value = default_parent->get<std::string>();
            if (value.size() > limits.max_string_bytes || !valid_utf8(value))
                diagnostics.push_back(error("editor_preview.invalid_string",
                                            "defaultParent is invalid or too large.",
                                            "/defaultParent"));
            else
                result.default_parent = value;
        }
        const auto scoped_styles = document.find("scopedStyles");
        if (scoped_styles == document.end() || !scoped_styles->is_boolean())
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "scopedStyles must be a boolean.", "/scopedStyles"));
        else
            result.scoped_styles = scoped_styles->get<bool>();

        if (const auto script = document.find("script"); script != document.end()) {
            if (!script->is_object()) {
                diagnostics.push_back(
                    error("editor_preview.wrong_type", "script must be an object.", "/script"));
            } else {
                exact_fields(*script, {"enabled", "namespace"}, diagnostics, "/script");
                const auto enabled = script->find("enabled");
                if (enabled == script->end() || !enabled->is_boolean()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "script.enabled must be a boolean.",
                                                "/script/enabled"));
                } else {
                    result.script_enabled = enabled->get<bool>();
                }
                const auto script_namespace = script->find("namespace");
                if (script_namespace == script->end() ||
                    (!script_namespace->is_null() && !script_namespace->is_string())) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "script.namespace must be a string or null.",
                                                "/script/namespace"));
                } else if (script_namespace->is_string()) {
                    result.script_namespace = script_namespace->get<std::string>();
                }
            }
        } else {
            diagnostics.push_back(
                error("editor_preview.missing_field", "script is required.", "/script"));
        }

        const auto scale_policy = document.find("scalePolicy");
        if (scale_policy == document.end()) {
            diagnostics.push_back(
                error("editor_preview.missing_field", "scalePolicy is required.", "/scalePolicy"));
        } else if (auto parsed = preview_scale_policy(*scale_policy, diagnostics, "/scalePolicy")) {
            if (parsed->ui != result.environment.scale_policy.ui ||
                parsed->text != result.environment.scale_policy.text)
                diagnostics.push_back(error("editor_preview.scale_policy_mismatch",
                                            "Layout scalePolicy must match environment profile.",
                                            "/scalePolicy"));
        }

        const auto materials = document.find("shaderMaterials");
        if (materials == document.end() || !materials->is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "shaderMaterials must be an object.", "/shaderMaterials"));
        } else {
            auto parsed = parse_shader_material_project_json_value(*materials);
            append_material_diagnostics(parsed.diagnostics, diagnostics, "/shaderMaterials");
            if (parsed.project && !parsed.has_errors())
                result.shader_materials = std::move(*parsed.project);
        }

        if (!diagnostics.empty())
            return Result<TypedEditorPreviewDocument, Diagnostics>::failure(std::move(diagnostics));
        return Result<TypedEditorPreviewDocument, Diagnostics>::success(
            TypedEditorPreviewDocument{std::move(result)});
    }

    if (kind == "shader-preview") {
        TypedEditorShaderPreviewDocument result;
        exact_fields(document,
                     {"schema", "contentMode", "shaderId", "previewMaterialId", "templateId",
                      "activeShaderVariant", "shaderMaterials"},
                     diagnostics, "/");
        const auto schema = string_field(document, "schema", diagnostics, "/", limits);
        if (schema && *schema != "noveltea.shader-preview")
            diagnostics.push_back(error("editor_preview.invalid_schema",
                                        "Shader preview schema must be noveltea.shader-preview.",
                                        "/schema"));
        const auto content_mode = string_field(document, "contentMode", diagnostics, "/", limits);
        if (content_mode && *content_mode != "shader")
            diagnostics.push_back(error("editor_preview.invalid_content_mode",
                                        "Shader preview contentMode must be shader.",
                                        "/contentMode"));

        const auto materials = document.find("shaderMaterials");
        if (materials == document.end() || !materials->is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "shaderMaterials must be an object.", "/shaderMaterials"));
        } else {
            auto parsed = parse_shader_material_project_json_value(*materials);
            append_material_diagnostics(parsed.diagnostics, diagnostics, "/shaderMaterials");
            if (parsed.project && !parsed.has_errors())
                result.shader_materials = std::move(*parsed.project);
        }

        if (auto value =
                optional_preview_string(document, "previewMaterialId", diagnostics, "/", limits))
            result.preview_material_id = std::move(*value);
        if (auto value = optional_preview_string(document, "shaderId", diagnostics, "/", limits))
            result.shader_id = std::move(*value);

        if (auto parsed = parse_material_id(result.preview_material_id); !parsed.ok()) {
            append_material_diagnostics(parsed.diagnostics, diagnostics, "/previewMaterialId");
        }
        if (!result.shader_id.empty()) {
            if (auto parsed = parse_shader_id(result.shader_id); !parsed.ok())
                append_material_diagnostics(parsed.diagnostics, diagnostics, "/shaderId");
        }

        if (auto value = string_field(document, "templateId", diagnostics, "/", limits)) {
            result.template_id = std::move(*value);
            if (result.template_id != "shader-square-v1")
                diagnostics.push_back(error("editor_preview.invalid_template_id",
                                            "Unsupported Shader preview templateId.",
                                            "/templateId"));
        }
        if (auto value = string_field(document, "activeShaderVariant", diagnostics, "/", limits)) {
            if (*value == "glsl-330")
                result.active_shader_variant = EditorPreviewShaderVariant::Glsl330;
            else if (*value == "essl-300")
                result.active_shader_variant = EditorPreviewShaderVariant::Essl300;
            else if (*value == "metal")
                result.active_shader_variant = EditorPreviewShaderVariant::Metal;
            else
                diagnostics.push_back(error("editor_preview.invalid_shader_variant",
                                            "Shader preview active variant is unsupported.",
                                            "/activeShaderVariant"));
        }

        if (!diagnostics.empty())
            return Result<TypedEditorPreviewDocument, Diagnostics>::failure(std::move(diagnostics));
        return Result<TypedEditorPreviewDocument, Diagnostics>::success(
            TypedEditorPreviewDocument{std::move(result)});
    }

    return Result<TypedEditorPreviewDocument, Diagnostics>::failure(Diagnostics{error(
        "editor_preview.unsupported_kind", "Unsupported editor preview document kind.", "/kind")});
}

Result<FocusedEditorDocumentRequest, Diagnostics>
decode_focused_editor_document_request_text(std::string_view request_text,
                                            const FocusedEditorDocumentLimits& limits)
{
    if (request_text.size() > limits.max_request_bytes) {
        return Result<FocusedEditorDocumentRequest, Diagnostics>::failure(Diagnostics{
            error("editor_preview.size_limit", "Focused preview request exceeds size limit.")});
    }
    auto document =
        nlohmann::json::parse(request_text.empty() ? "{}" : request_text, nullptr, false);
    if (document.is_discarded()) {
        return Result<FocusedEditorDocumentRequest, Diagnostics>::failure(
            Diagnostics{error("editor_preview.malformed_json", "Malformed focused preview JSON.")});
    }
    Diagnostics diagnostics;
    const auto source_bearing_field = [](std::string_view name) {
        return name == "rml" || name == "rcss" || name == "lua" || name == "sourceText" ||
               name == "source_text" || name == "fragmentRml" || name == "hostRml" ||
               name == "hostRcss" || name == "templateRml" || name == "templateRcss";
    };
    std::function<void(const nlohmann::json&, std::string_view, std::size_t)> validate_limits;
    validate_limits = [&](const nlohmann::json& value, std::string_view path, std::size_t depth) {
        if (depth > limits.max_json_depth) {
            diagnostics.push_back(error("editor_preview.depth_limit",
                                        "Focused preview JSON exceeds nesting limit.",
                                        std::string(path)));
            return;
        }
        if (value.is_array()) {
            std::size_t named_limit = limits.max_items_per_array;
            if (path.ends_with("/layouts"))
                named_limit = std::min(named_limit, limits.max_layouts);
            if (path.ends_with("/admission") || path.ends_with("/occurrences"))
                named_limit = std::min(named_limit, limits.max_admission_items_per_source);
            if (value.size() > named_limit) {
                diagnostics.push_back(error("editor_preview.size_limit",
                                            "Focused preview array exceeds item limit.",
                                            std::string(path)));
                return;
            }
            for (std::size_t index = 0; index < value.size(); ++index)
                validate_limits(value[index], std::string(path) + "/" + std::to_string(index),
                                depth + 1);
            return;
        }
        if (value.is_object()) {
            for (const auto& [name, child] : value.items()) {
                const auto child_path = std::string(path) + (path == "/" ? "" : "/") + name;
                if (child.is_string()) {
                    const auto size = child.get_ref<const std::string&>().size();
                    const auto limit = source_bearing_field(name) ? limits.max_source_bytes
                                                                  : limits.max_string_bytes;
                    if (size > limit)
                        diagnostics.push_back(
                            error("editor_preview.size_limit",
                                  source_bearing_field(name)
                                      ? "Focused preview source exceeds source-size limit."
                                      : "Focused preview string exceeds string-size limit.",
                                  child_path));
                } else {
                    validate_limits(child, child_path, depth + 1);
                }
            }
        }
    };
    validate_limits(document, "/", 1);
    if (!document.is_object()) {
        diagnostics.push_back(
            error("editor_preview.wrong_type", "Focused preview request must be an object.", "/"));
        return Result<FocusedEditorDocumentRequest, Diagnostics>::failure(std::move(diagnostics));
    }
    exact_fields(document,
                 {"protocol", "protocolVersion", "requestId", "applySequence", "projectInstanceId",
                  "resourceStageGeneration", "kind", "recordId", "revision", "resourceRevision",
                  "resources", "data"},
                 diagnostics, "/");
    FocusedEditorDocumentRequest result;
    auto string = [&](std::string_view name) -> std::optional<std::string> {
        return string_field(
            document, name, diagnostics, "/",
            EditorRuntimeProtocolLimits{.max_string_bytes = limits.max_string_bytes});
    };
    const auto protocol = string("protocol");
    if (protocol && *protocol != "noveltea.focused-editor-document")
        diagnostics.push_back(error("editor_preview.invalid_protocol",
                                    "Focused preview protocol is unsupported.", "/protocol"));
    const auto protocol_version = json_access::member_as<int>(document, "protocolVersion");
    if (!protocol_version || *protocol_version != editor_runtime_protocol_version)
        diagnostics.push_back(error("editor_preview.invalid_protocol_version",
                                    "Focused preview protocolVersion is unsupported.",
                                    "/protocolVersion"));
    if (auto value = string("requestId"))
        result.request_id = std::move(*value);
    if (auto value = string("projectInstanceId"))
        result.project_instance_id = std::move(*value);
    if (auto value = string("recordId"))
        result.record_id = std::move(*value);
    if (auto value = string("revision"))
        result.revision = std::move(*value);
    if (auto value = string("resourceRevision"))
        result.resource_revision = std::move(*value);
    auto unsigned_integer = [&](std::string_view name, std::uint64_t& target) {
        const auto value = json_access::member_as<std::uint64_t>(document, name);
        if (!value) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        std::string(name) + " must be a non-negative integer.",
                                        "/" + std::string(name)));
            return;
        }
        target = *value;
    };
    unsigned_integer("applySequence", result.apply_sequence);
    unsigned_integer("resourceStageGeneration", result.resource_stage_generation);
    if (auto kind = string("kind")) {
        if (*kind == "layout-preview")
            result.kind = FocusedEditorDocumentKind::Layout;
        else if (*kind == "shader-preview")
            result.kind = FocusedEditorDocumentKind::Shader;
        else if (*kind == "room-preview")
            result.kind = FocusedEditorDocumentKind::Room;
        else
            diagnostics.push_back(error("editor_preview.invalid_kind",
                                        "Focused preview document kind is unsupported.", "/kind"));
    }
    const auto resources = document.find("resources");
    if (resources == document.end() || !resources->is_array()) {
        diagnostics.push_back(
            error("editor_preview.wrong_type", "resources must be an array.", "/resources"));
    } else if (resources->size() > limits.max_resources) {
        diagnostics.push_back(error("editor_preview.size_limit",
                                    "Focused preview manifest exceeds resource limit.",
                                    "/resources"));
    } else {
        std::uint64_t total_resource_bytes = 0;
        std::set<std::string> resource_ids;
        std::map<std::string, std::string> logical_paths;
        result.resources.reserve(resources->size());
        for (std::size_t index = 0; index < resources->size(); ++index) {
            const auto& item = (*resources)[index];
            const auto path = "/resources/" + std::to_string(index);
            exact_fields(item,
                         {"resourceId", "sourceKind", "logicalPath", "contentHash", "byteSize",
                          "kind", "sampling", "assetId", "shaderId", "shaderStage", "shaderVariant",
                          "retainAlphaCoverage"},
                         diagnostics, path);
            if (!item.is_object())
                continue;
            FocusedEditorManifestProjection entry;
            auto entry_string = [&](std::string_view name) -> std::optional<std::string> {
                return string_field(
                    item, name, diagnostics, path,
                    EditorRuntimeProtocolLimits{.max_string_bytes = limits.max_string_bytes});
            };
            if (auto value = entry_string("resourceId"))
                entry.resource_id = std::move(*value);
            if (auto value = entry_string("sourceKind"))
                entry.source_kind = std::move(*value);
            if (auto value = entry_string("logicalPath"))
                entry.logical_path = std::move(*value);
            if (auto value = entry_string("contentHash"))
                entry.content_hash = std::move(*value);
            if (auto value = entry_string("kind"))
                entry.kind = std::move(*value);
            if (const auto byte_size = json_access::member_as<std::uint64_t>(item, "byteSize"))
                entry.byte_size = *byte_size;
            else
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "byteSize must be a non-negative integer.",
                                            path + "/byteSize"));
            if (entry.byte_size > limits.max_resource_bytes) {
                diagnostics.push_back(error("editor_preview.size_limit",
                                            "Focused preview resource exceeds byte-size limit.",
                                            path + "/byteSize"));
            } else if (total_resource_bytes > limits.max_total_resource_bytes - entry.byte_size) {
                diagnostics.push_back(
                    error("editor_preview.size_limit",
                          "Focused preview resources exceed aggregate byte limit.", "/resources"));
            } else {
                total_resource_bytes += entry.byte_size;
            }
            auto optional_string = [&](std::string_view name, std::optional<std::string>& target) {
                if (!item.contains(name))
                    return;
                if (auto value = entry_string(name))
                    target = std::move(*value);
            };
            optional_string("sampling", entry.sampling);
            if (item.contains("retainAlphaCoverage")) {
                if (const auto value = json_access::member_as<bool>(item, "retainAlphaCoverage"))
                    entry.retain_alpha_coverage = *value;
                else
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "retainAlphaCoverage must be a boolean.",
                                                path + "/retainAlphaCoverage"));
            }
            optional_string("assetId", entry.asset_id);
            optional_string("shaderId", entry.shader_id);
            optional_string("shaderStage", entry.shader_stage);
            if (item.contains("shaderVariant")) {
                if (auto variant = entry_string("shaderVariant")) {
                    if (*variant == "glsl-330")
                        entry.shader_variant = EditorPreviewShaderVariant::Glsl330;
                    else if (*variant == "essl-300")
                        entry.shader_variant = EditorPreviewShaderVariant::Essl300;
                    else if (*variant == "metal")
                        entry.shader_variant = EditorPreviewShaderVariant::Metal;
                    else
                        diagnostics.push_back(error("editor_preview.invalid_shader_variant",
                                                    "Shader variant is unsupported.",
                                                    path + "/shaderVariant"));
                }
            }
            if (entry.content_hash.size() != 71 || !entry.content_hash.starts_with("sha256:") ||
                !std::all_of(
                    entry.content_hash.begin() + 7, entry.content_hash.end(),
                    [](unsigned char ch) { return std::isxdigit(ch) && !std::isupper(ch); }))
                diagnostics.push_back(error("editor_preview.invalid_hash",
                                            "contentHash must be canonical lowercase SHA-256.",
                                            path + "/contentHash"));
            if (entry.resource_id.empty() || !resource_ids.insert(entry.resource_id).second)
                diagnostics.push_back(
                    error("editor_preview.duplicate_resource_id",
                          "Focused preview resourceId must be unique and non-empty.",
                          path + "/resourceId"));
            if (!safe_project_logical_path(entry.logical_path)) {
                diagnostics.push_back(
                    error("editor_preview.invalid_logical_path",
                          "Focused preview logicalPath must be a safe project:/ path.",
                          path + "/logicalPath"));
            } else if (const auto [found, inserted] =
                           logical_paths.emplace(entry.logical_path, entry.resource_id);
                       !inserted && found->second != entry.resource_id) {
                diagnostics.push_back(
                    error("editor_preview.conflicting_logical_path",
                          "Focused preview logicalPath has conflicting identities.",
                          path + "/logicalPath"));
            }
            if (entry.source_kind == "authoring-asset") {
                if (!entry.asset_id || entry.shader_id || entry.shader_stage ||
                    entry.shader_variant || entry.resource_id != "asset:" + *entry.asset_id)
                    diagnostics.push_back(error(
                        "editor_preview.invalid_manifest_identity",
                        "Authoring Asset resources require only assetId typed identity.", path));
                constexpr std::array<std::string_view, 7> asset_kinds = {
                    "image", "font", "audio", "video", "text", "data", "binary"};
                if (std::ranges::find(asset_kinds, entry.kind) == asset_kinds.end())
                    diagnostics.push_back(error("editor_preview.invalid_asset_kind",
                                                "Authoring Asset kind is unsupported.",
                                                path + "/kind"));
                if (entry.kind == "image" && !entry.sampling)
                    diagnostics.push_back(error("editor_preview.invalid_sampling",
                                                "Image Assets require explicit sampling.",
                                                path + "/sampling"));
                else if (entry.sampling &&
                         (entry.kind != "image" ||
                          (*entry.sampling != "linear" && *entry.sampling != "nearest")))
                    diagnostics.push_back(error("editor_preview.invalid_sampling",
                                                "Sampling is valid only for image Assets.",
                                                path + "/sampling"));
                if (entry.retain_alpha_coverage && entry.kind != "image")
                    diagnostics.push_back(
                        error("editor_preview.invalid_alpha_coverage_requirement",
                              "Alpha coverage retention is valid only for image Assets.", path));
            } else if (entry.source_kind == "project-source") {
                const auto project_prefix = std::string_view{"project:/"};
                const auto relative = entry.logical_path.starts_with(project_prefix)
                                          ? entry.logical_path.substr(project_prefix.size())
                                          : std::string{};
                if (entry.asset_id || entry.shader_id || entry.shader_stage ||
                    entry.shader_variant || entry.kind != "lua" || entry.sampling ||
                    relative.empty() || entry.resource_id != "source:" + relative)
                    diagnostics.push_back(error(
                        "editor_preview.invalid_manifest_identity",
                        "Project source resources require a canonical Lua path identity.", path));
            } else if (entry.source_kind == "shader-compiled-output") {
                if (!entry.shader_id || !entry.shader_stage || !entry.shader_variant ||
                    entry.asset_id || entry.kind != "shader-binary" || entry.sampling ||
                    (*entry.shader_stage != "vertex" && *entry.shader_stage != "fragment") ||
                    entry.resource_id !=
                        "shader:" + *entry.shader_id + ":" + *entry.shader_stage + ":" +
                            std::string(editor_shader_variant_name(*entry.shader_variant)))
                    diagnostics.push_back(error(
                        "editor_preview.invalid_manifest_identity",
                        "Compiled Shader resources require shader identity, stage, and variant.",
                        path));
            } else {
                diagnostics.push_back(error("editor_preview.invalid_source_kind",
                                            "Focused preview resource sourceKind is unsupported.",
                                            path + "/sourceKind"));
            }
            result.resources.push_back(std::move(entry));
        }
    }
    if (const auto data = document.find("data"); data != document.end() && data->is_object())
        result.data_json = data->dump();
    else
        diagnostics.push_back(
            error("editor_preview.wrong_type", "data must be an object.", "/data"));
    if (!diagnostics.empty())
        return Result<FocusedEditorDocumentRequest, Diagnostics>::failure(std::move(diagnostics));
    return Result<FocusedEditorDocumentRequest, Diagnostics>::success(std::move(result));
}

Result<TypedEditorRoomPreviewDocument, Diagnostics>
decode_editor_room_preview_document_text(std::string_view data_text,
                                         const FocusedEditorDocumentLimits& limits)
{
    if (data_text.size() > limits.max_request_bytes)
        return Result<TypedEditorRoomPreviewDocument, Diagnostics>::failure(
            {error("editor_preview.size_limit", "Room preview document exceeds size limit.")});
    auto document = nlohmann::json::parse(data_text.empty() ? "{}" : data_text, nullptr, false);
    if (document.is_discarded() || !document.is_object())
        return Result<TypedEditorRoomPreviewDocument, Diagnostics>::failure(
            {error("editor_preview.malformed_json", "Malformed Room preview JSON.")});

    Diagnostics diagnostics;
    exact_fields(document,
                 {"schema", "environment", "room", "luaAdmission", "queryState", "shaderMaterials",
                  "world", "layouts", "ui", "composition", "cursors"},
                 diagnostics, "/");
    const auto schema = json_access::member_as<std::string>(document, "schema");
    if (!schema || *schema != "noveltea.room-preview")
        diagnostics.push_back(error("editor_preview.invalid_schema",
                                    "Room preview schema must be noveltea.room-preview.",
                                    "/schema"));

    TypedEditorRoomPreviewDocument result;
    const auto object = [&](std::string_view name) -> const nlohmann::json* {
        const auto found = document.find(name);
        if (found == document.end() || !found->is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        std::string(name) + " must be an object.",
                                        "/" + std::string(name)));
            return nullptr;
        }
        return &*found;
    };
    const auto required_string = [&](const nlohmann::json& value, std::string_view name,
                                     std::string_view path) -> std::string {
        auto parsed =
            string_field(value, name, diagnostics, path,
                         EditorRuntimeProtocolLimits{.max_string_bytes = limits.max_string_bytes});
        return parsed ? std::move(*parsed) : std::string{};
    };
    const auto required_bool = [&](const nlohmann::json& value, std::string_view name,
                                   std::string_view path) {
        const auto parsed = json_access::member_as<bool>(value, name);
        if (!parsed)
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        std::string(name) + " must be a boolean.",
                                        std::string(path) + "/" + std::string(name)));
        return parsed.value_or(false);
    };
    const auto positive_resolution = [&](const nlohmann::json& value, std::string_view path) {
        compiled::ReferenceResolution resolution{};
        exact_fields(value, {"width", "height"}, diagnostics, path);
        const auto width = json_access::member_as<std::uint32_t>(value, "width");
        const auto height = json_access::member_as<std::uint32_t>(value, "height");
        if (!width || *width == 0 || !height || *height == 0)
            diagnostics.push_back(error("editor_preview.invalid_resolution",
                                        "Room preview resolutions must be positive integers.",
                                        std::string(path)));
        resolution.width = width.value_or(0);
        resolution.height = height.value_or(0);
        return resolution;
    };
    const auto optional_string = [&](const nlohmann::json& value, std::string_view name,
                                     std::string_view path) -> std::optional<std::string> {
        const auto found = value.find(name);
        if (found == value.end() || found->is_null())
            return std::nullopt;
        if (!found->is_string()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        std::string(name) + " must be a string or null.",
                                        std::string(path) + "/" + std::string(name)));
            return std::nullopt;
        }
        return json_access::get<std::string>(*found);
    };
    const auto focused_id = [&]<class Id>(std::string text, std::string path) -> std::optional<Id> {
        auto parsed = Id::create(std::move(text));
        if (!parsed) {
            diagnostics.push_back(
                error("editor_preview.invalid_id", "Invalid stable ID.", std::move(path)));
            return std::nullopt;
        }
        return std::move(*parsed.value_if());
    };
    const auto inventory_owner =
        [&](const nlohmann::json& value,
            std::string path) -> std::optional<compiled::InventoryOwnerRef> {
        if (!value.is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Inventory owner must be an object.", std::move(path)));
            return std::nullopt;
        }
        const auto kind = required_string(value, "kind", path);
        if (kind == "project") {
            exact_fields(value, {"kind"}, diagnostics, path);
            return compiled::ProjectInventoryOwner{};
        }
        if (kind == "character") {
            exact_fields(value, {"kind", "character"}, diagnostics, path);
            auto character = focused_id.template operator()<CharacterId>(
                required_string(value, "character", path), path + "/character");
            return character ? std::optional<compiled::InventoryOwnerRef>(
                                   compiled::CharacterInventoryOwner{std::move(*character)})
                             : std::nullopt;
        }
        if (kind == "interactable") {
            exact_fields(value, {"kind", "interactable"}, diagnostics, path);
            auto interactable = focused_id.template operator()<InteractableInstanceId>(
                required_string(value, "interactable", path), path + "/interactable");
            return interactable
                       ? std::optional<compiled::InventoryOwnerRef>(
                             compiled::InteractableInventoryOwner{std::move(*interactable)})
                       : std::nullopt;
        }
        if (kind == "room-feature") {
            exact_fields(value, {"kind", "room", "featureId"}, diagnostics, path);
            auto room = focused_id.template operator()<RoomId>(required_string(value, "room", path),
                                                               path + "/room");
            auto feature = focused_id.template operator()<FeatureId>(
                required_string(value, "featureId", path), path + "/featureId");
            return room && feature ? std::optional<compiled::InventoryOwnerRef>(
                                         RoomFeatureRef{std::move(*room), std::move(*feature)})
                                   : std::nullopt;
        }
        if (kind == "interactable-feature") {
            exact_fields(value, {"kind", "interactable", "featureId"}, diagnostics, path);
            auto interactable = focused_id.template operator()<InteractableInstanceId>(
                required_string(value, "interactable", path), path + "/interactable");
            auto feature = focused_id.template operator()<FeatureId>(
                required_string(value, "featureId", path), path + "/featureId");
            return interactable && feature
                       ? std::optional<compiled::InventoryOwnerRef>(
                             InteractableFeatureRef{std::move(*interactable), std::move(*feature)})
                       : std::nullopt;
        }
        diagnostics.push_back(error("editor_preview.invalid_enum",
                                    "Inventory owner kind is unsupported.", path + "/kind"));
        return std::nullopt;
    };
    const auto inventory_ref = [&](const nlohmann::json& value,
                                   std::string path) -> std::optional<compiled::InventoryRef> {
        if (!value.is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Inventory reference must be an object.", std::move(path)));
            return std::nullopt;
        }
        exact_fields(value, {"owner", "inventoryId"}, diagnostics, path);
        const auto owner_value = value.find("owner");
        auto owner = owner_value != value.end() ? inventory_owner(*owner_value, path + "/owner")
                                                : std::nullopt;
        auto inventory = focused_id.template operator()<InventoryId>(
            required_string(value, "inventoryId", path), path + "/inventoryId");
        return owner && inventory ? std::optional<compiled::InventoryRef>(compiled::InventoryRef{
                                        std::move(*owner), std::move(*inventory)})
                                  : std::nullopt;
    };
    const auto interactable_location = [&](const nlohmann::json& value,
                                           std::string path) -> compiled::InteractableLocation {
        if (!value.is_object()) {
            diagnostics.push_back(
                error("editor_preview.wrong_type", "location must be an object.", std::move(path)));
            return compiled::UnplacedLocation{};
        }
        const auto kind = required_string(value, "kind", path);
        if (kind == "unplaced") {
            exact_fields(value, {"kind"}, diagnostics, path);
            return compiled::UnplacedLocation{};
        }
        if (kind == "room") {
            exact_fields(value, {"kind", "room"}, diagnostics, path);
            const auto room_value = value.find("room");
            if (room_value == value.end() || !room_value->is_object()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "Room Location requires a typed room reference.",
                                            path + "/room"));
                return compiled::UnplacedLocation{};
            }
            exact_fields(*room_value, {"$ref"}, diagnostics, path + "/room");
            const auto ref = room_value->find("$ref");
            if (ref == room_value->end() || !ref->is_object()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "Room Location reference is invalid.",
                                            path + "/room/$ref"));
                return compiled::UnplacedLocation{};
            }
            exact_fields(*ref, {"collection", "id"}, diagnostics, path + "/room/$ref");
            if (required_string(*ref, "collection", path + "/room/$ref") != "rooms")
                diagnostics.push_back(error("editor_preview.invalid_reference",
                                            "Room Location reference must target rooms.",
                                            path + "/room/$ref/collection"));
            auto room = focused_id.template operator()<RoomId>(
                required_string(*ref, "id", path + "/room/$ref"), path + "/room/$ref/id");
            return room ? compiled::InteractableLocation{compiled::RoomLocation{std::move(*room)}}
                        : compiled::InteractableLocation{compiled::UnplacedLocation{}};
        }
        if (kind == "inventory") {
            exact_fields(value, {"kind", "inventory"}, diagnostics, path);
            const auto inventory_value = value.find("inventory");
            auto inventory = inventory_value != value.end()
                                 ? inventory_ref(*inventory_value, path + "/inventory")
                                 : std::nullopt;
            return inventory ? compiled::InteractableLocation{compiled::InventoryLocation{
                                   std::move(*inventory)}}
                             : compiled::InteractableLocation{compiled::UnplacedLocation{}};
        }
        diagnostics.push_back(error("editor_preview.invalid_enum",
                                    "Interactable location kind is unsupported.", path + "/kind"));
        return compiled::UnplacedLocation{};
    };
    const auto scalar = [&](const nlohmann::json& value, std::string_view path) {
        TypedFocusedScalar result_value;
        if (value.is_null())
            return result_value;
        if (value.is_boolean()) {
            if (const auto parsed = json_access::get<bool>(value))
                return TypedFocusedScalar{*parsed};
        } else if (value.is_number_integer()) {
            if (const auto parsed = json_access::get<std::int64_t>(value))
                return TypedFocusedScalar{*parsed};
        } else if (value.is_number()) {
            if (const auto parsed = json_access::get<double>(value))
                return TypedFocusedScalar{*parsed};
        } else if (value.is_string()) {
            if (auto parsed = json_access::get<std::string>(value))
                return TypedFocusedScalar{std::move(*parsed)};
        }
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Focused scalar must be null, boolean, number, or string.",
                                    std::string(path)));
        return result_value;
    };
    const auto vector2 = [&](const nlohmann::json& value, std::string_view path) {
        TypedFocusedVector2 result_value;
        if (!value.is_object()) {
            diagnostics.push_back(
                error("editor_preview.wrong_type", "Vector must be an object.", std::string(path)));
            return result_value;
        }
        exact_fields(value, {"x", "y"}, diagnostics, path);
        const auto x = json_access::member_as<double>(value, "x");
        const auto y = json_access::member_as<double>(value, "y");
        if (!x || !y)
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Vector components must be finite numbers.",
                                        std::string(path)));
        result_value.x = x.value_or(0.0);
        result_value.y = y.value_or(0.0);
        return result_value;
    };
    const auto rect = [&](const nlohmann::json& value, std::string_view path) {
        TypedFocusedNormalizedRect result_value;
        if (!value.is_object()) {
            diagnostics.push_back(
                error("editor_preview.wrong_type", "Bounds must be an object.", std::string(path)));
            return result_value;
        }
        exact_fields(value, {"x", "y", "width", "height"}, diagnostics, path);
        const auto x = json_access::member_as<double>(value, "x");
        const auto y = json_access::member_as<double>(value, "y");
        const auto width = json_access::member_as<double>(value, "width");
        const auto height = json_access::member_as<double>(value, "height");
        if (!x || !y || !width || !height)
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Bounds fields must be finite numbers.",
                                        std::string(path)));
        result_value = {.x = x.value_or(0.0),
                        .y = y.value_or(0.0),
                        .width = width.value_or(0.0),
                        .height = height.value_or(0.0)};
        return result_value;
    };
    std::function<TypedFocusedCondition(const nlohmann::json&, std::string_view)> condition;
    condition = [&](const nlohmann::json& value, std::string_view path) {
        TypedFocusedCondition result_value;
        if (!value.is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type", "Condition must be an object.",
                                        std::string(path)));
            return result_value;
        }
        const auto kind = json_access::member_as<std::string>(value, "kind");
        if (kind == "always") {
            exact_fields(value, {"kind"}, diagnostics, path);
        } else if (kind == "all" || kind == "any") {
            exact_fields(value, {"conditions", "kind"}, diagnostics, path);
            result_value.kind =
                kind == "all" ? TypedFocusedCondition::Kind::All : TypedFocusedCondition::Kind::Any;
            const auto found = value.find("conditions");
            if (found == value.end() || !found->is_array()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "Boolean Condition children must be an array.",
                                            std::string(path) + "/conditions"));
            } else {
                for (std::size_t index = 0; index < found->size(); ++index)
                    result_value.conditions.push_back(
                        condition((*found)[index],
                                  std::string(path) + "/conditions/" + std::to_string(index)));
            }
        } else if (kind == "not") {
            exact_fields(value, {"condition", "kind"}, diagnostics, path);
            result_value.kind = TypedFocusedCondition::Kind::Not;
            const auto found = value.find("condition");
            if (found == value.end()) {
                diagnostics.push_back(error("editor_preview.missing_field",
                                            "Not Condition requires one child Condition.",
                                            std::string(path) + "/condition"));
            } else {
                result_value.conditions.push_back(
                    condition(*found, std::string(path) + "/condition"));
            }
        } else if (kind == "variable-comparison") {
            exact_fields(value, {"kind", "variableId", "operator", "value"}, diagnostics, path);
            result_value.kind = TypedFocusedCondition::Kind::VariableComparison;
            result_value.variable_id = required_string(value, "variableId", path);
            result_value.comparison_operator = required_string(value, "operator", path);
            static constexpr std::array<std::string_view, 8> operators{
                "equal",   "not-equal",     "less",   "less-equal",
                "greater", "greater-equal", "truthy", "falsy"};
            if (std::find(operators.begin(), operators.end(), result_value.comparison_operator) ==
                operators.end())
                diagnostics.push_back(error("editor_preview.invalid_enum",
                                            "Variable comparison operator is unsupported.",
                                            std::string(path) + "/operator"));
            if (const auto found = value.find("value"); found != value.end())
                result_value.value = scalar(*found, std::string(path) + "/value");
        } else if (kind == "lua-predicate") {
            exact_fields(value, {"kind", "source"}, diagnostics, path);
            result_value.kind = TypedFocusedCondition::Kind::LuaPredicate;
            result_value.lua_source = required_string(value, "source", path);
        } else if (kind == "runtime-only") {
            exact_fields(value, {"conditionKind", "kind"}, diagnostics, path);
            result_value.kind = TypedFocusedCondition::Kind::RuntimeOnly;
            result_value.runtime_condition_kind = required_string(value, "conditionKind", path);
        } else {
            diagnostics.push_back(error("editor_preview.invalid_enum",
                                        "Condition kind is unsupported.",
                                        std::string(path) + "/kind"));
        }
        return result_value;
    };
    const auto text = [&](const nlohmann::json& value, std::string_view path) {
        TypedFocusedText result_value;
        if (!value.is_object()) {
            diagnostics.push_back(
                error("editor_preview.wrong_type", "Text must be an object.", std::string(path)));
            return result_value;
        }
        exact_fields(value, {"markup", "source"}, diagnostics, path);
        const auto markup = required_string(value, "markup", path);
        if (markup == "active-text")
            result_value.markup = TypedFocusedText::Markup::ActiveText;
        else if (markup != "plain")
            diagnostics.push_back(error("editor_preview.invalid_enum",
                                        "Text markup is unsupported.",
                                        std::string(path) + "/markup"));
        const auto source = value.find("source");
        if (source == value.end() || !source->is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Text source must be an object.",
                                        std::string(path) + "/source"));
            return result_value;
        }
        const auto source_kind = json_access::member_as<std::string>(*source, "kind");
        if (source_kind == "resolved") {
            exact_fields(*source, {"kind", "text"}, diagnostics, std::string(path) + "/source");
            result_value.source = required_string(*source, "text", std::string(path) + "/source");
        } else if (source_kind == "lua-expression") {
            exact_fields(*source, {"kind", "source"}, diagnostics, std::string(path) + "/source");
            result_value.source_kind = TypedFocusedText::SourceKind::LuaExpression;
            result_value.source = required_string(*source, "source", std::string(path) + "/source");
        } else {
            diagnostics.push_back(error("editor_preview.invalid_enum",
                                        "Text source kind is unsupported.",
                                        std::string(path) + "/source/kind"));
        }
        return result_value;
    };
    std::function<TypedFocusedCharacterVisual(const nlohmann::json&, std::string_view)> visual;
    visual = [&](const nlohmann::json& value, std::string_view path) {
        TypedFocusedCharacterVisual result_value;
        if (!value.is_object()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Character visual must be an object.", std::string(path)));
            return result_value;
        }
        exact_fields(value,
                     {"profileId", "requestedPoseId", "resolvedPoseId", "expressionId",
                      "appearanceId", "idleId", "layers", "idle"},
                     diagnostics, path);
        result_value.profile_id = required_string(value, "profileId", path);
        result_value.requested_pose_id = required_string(value, "requestedPoseId", path);
        result_value.resolved_pose_id = required_string(value, "resolvedPoseId", path);
        result_value.expression_id = required_string(value, "expressionId", path);
        result_value.appearance_id = optional_string(value, "appearanceId", path);
        result_value.idle_id = optional_string(value, "idleId", path);
        if (const auto layers = value.find("layers"); layers != value.end() && layers->is_array()) {
            for (std::size_t index = 0; index < layers->size(); ++index) {
                const auto& layer = (*layers)[index];
                const auto layer_path = std::string(path) + "/layers/" + std::to_string(index);
                if (!layer.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Character layer must be an object.", layer_path));
                    continue;
                }
                exact_fields(layer,
                             {"id", "role", "spriteAssetId", "materialId", "offset", "scale",
                              "anchor", "visible"},
                             diagnostics, layer_path);
                TypedFocusedCharacterVisual::Layer typed;
                typed.id = required_string(layer, "id", layer_path);
                typed.role = optional_string(layer, "role", layer_path);
                typed.sprite_asset_id = optional_string(layer, "spriteAssetId", layer_path);
                typed.material_id = optional_string(layer, "materialId", layer_path);
                typed.offset = vector2(layer["offset"], layer_path + "/offset");
                typed.scale = json_access::member_as<double>(layer, "scale").value_or(1.0);
                typed.anchor = vector2(layer["anchor"], layer_path + "/anchor");
                typed.visible = json_access::member_as<bool>(layer, "visible").value_or(true);
                result_value.layers.push_back(std::move(typed));
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type", "layers must be an array.",
                                        std::string(path) + "/layers"));
        }
        if (const auto idle = value.find("idle"); idle != value.end() && !idle->is_null()) {
            if (!idle->is_object()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "idle must be an object or null.",
                                            std::string(path) + "/idle"));
            } else {
                exact_fields(*idle, {"kind", "amplitude", "periodMs", "clock"}, diagnostics,
                             std::string(path) + "/idle");
                TypedFocusedCharacterVisual::Idle typed;
                typed.kind = required_string(*idle, "kind", std::string(path) + "/idle");
                typed.amplitude = json_access::member_as<double>(*idle, "amplitude").value_or(0.0);
                typed.period_ms =
                    json_access::member_as<std::uint64_t>(*idle, "periodMs").value_or(0);
                typed.clock = required_string(*idle, "clock", std::string(path) + "/idle");
                if ((typed.kind != "bob" && typed.kind != "sway" && typed.kind != "pulse") ||
                    typed.period_ms == 0 ||
                    (typed.clock != "gameplay" && typed.clock != "unscaled-presentation"))
                    diagnostics.push_back(error("editor_preview.invalid_enum",
                                                "Character idle contract is invalid.",
                                                std::string(path) + "/idle"));
                result_value.idle = std::move(typed);
            }
        }
        return result_value;
    };

    if (const auto* cursors = object("cursors")) {
        exact_fields(*cursors, {"defaultCursor", "pointerCursor", "hotspotCursor", "named"},
                     diagnostics, "/cursors");
        result.cursors.default_cursor = required_string(*cursors, "defaultCursor", "/cursors");
        result.cursors.pointer_cursor = required_string(*cursors, "pointerCursor", "/cursors");
        result.cursors.hotspot_cursor = required_string(*cursors, "hotspotCursor", "/cursors");
        if (const auto named = cursors->find("named");
            named != cursors->end() && named->is_array()) {
            for (std::size_t index = 0; index < named->size(); ++index) {
                const auto& value = (*named)[index];
                const auto path = "/cursors/named/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Named cursor must be an object.", path));
                    continue;
                }
                exact_fields(value,
                             {"id", "logicalPath", "width", "height", "hotspotX", "hotspotY"},
                             diagnostics, path);
                TypedEditorPreviewCursorDefinition cursor;
                cursor.id = required_string(value, "id", path);
                cursor.logical_path = required_string(value, "logicalPath", path);
                cursor.width = json_access::member_as<std::uint32_t>(value, "width").value_or(0);
                cursor.height = json_access::member_as<std::uint32_t>(value, "height").value_or(0);
                cursor.hotspot_x =
                    json_access::member_as<std::uint32_t>(value, "hotspotX").value_or(0);
                cursor.hotspot_y =
                    json_access::member_as<std::uint32_t>(value, "hotspotY").value_or(0);
                if (!safe_project_logical_path(cursor.logical_path))
                    diagnostics.push_back(
                        error("editor_preview.invalid_resource_path",
                              "Cursor logicalPath must use a safe project:/ path.",
                              path + "/logicalPath"));
                if (cursor.width == 0 || cursor.height == 0 || cursor.hotspot_x >= cursor.width ||
                    cursor.hotspot_y >= cursor.height)
                    diagnostics.push_back(error("editor_preview.invalid_cursor",
                                                "Focused cursor dimensions or hotspot are invalid.",
                                                path));
                result.cursors.named.push_back(std::move(cursor));
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "cursors.named must be an array.", "/cursors/named"));
        }
    }

    if (const auto* environment = object("environment")) {
        exact_fields(*environment, {"profile", "project"}, diagnostics, "/environment");
        if (const auto profile = environment->find("profile");
            profile != environment->end() && profile->is_object()) {
            exact_fields(*profile, {"name", "nativeResolution"}, diagnostics,
                         "/environment/profile");
            result.environment.profile_name =
                required_string(*profile, "name", "/environment/profile");
            if (const auto native = profile->find("nativeResolution");
                native != profile->end() && native->is_object())
                result.environment.native_resolution =
                    positive_resolution(*native, "/environment/profile/nativeResolution");
            else
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "nativeResolution must be an object.",
                                            "/environment/profile/nativeResolution"));
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type", "profile must be an object.",
                                        "/environment/profile"));
        }
        if (const auto project = environment->find("project");
            project != environment->end() && project->is_object()) {
            exact_fields(*project,
                         {"referenceResolution", "worldRasterPolicy", "barColor", "accessibility"},
                         diagnostics, "/environment/project");
            result.environment.world_raster_policy =
                required_string(*project, "worldRasterPolicy", "/environment/project");
            if (result.environment.world_raster_policy != "capped" &&
                result.environment.world_raster_policy != "native")
                diagnostics.push_back(error("editor_preview.invalid_enum",
                                            "worldRasterPolicy must be capped or native.",
                                            "/environment/project/worldRasterPolicy"));
            result.environment.bar_color =
                required_string(*project, "barColor", "/environment/project");
            if (const auto reference = project->find("referenceResolution");
                reference != project->end() && reference->is_object())
                result.environment.reference_resolution =
                    positive_resolution(*reference, "/environment/project/referenceResolution");
            else
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "referenceResolution must be an object.",
                                            "/environment/project/referenceResolution"));
            if (const auto accessibility = project->find("accessibility");
                accessibility != project->end() && accessibility->is_object()) {
                exact_fields(*accessibility, {"uiScale", "textScale"}, diagnostics,
                             "/environment/project/accessibility");
                const auto ui = accessibility->find("uiScale");
                const auto text = accessibility->find("textScale");
                const auto ui_scale =
                    ui == accessibility->end()
                        ? std::optional<compiled::AccessibilityScalePolicy>{}
                        : preview_accessibility_scale_policy(
                              *ui, diagnostics, "/environment/project/accessibility/uiScale");
                const auto text_scale =
                    text == accessibility->end()
                        ? std::optional<compiled::AccessibilityScalePolicy>{}
                        : preview_accessibility_scale_policy(
                              *text, diagnostics, "/environment/project/accessibility/textScale");
                if (ui == accessibility->end())
                    diagnostics.push_back(error("editor_preview.missing_field",
                                                "Missing UI accessibility scale policy.",
                                                "/environment/project/accessibility/uiScale"));
                if (text == accessibility->end())
                    diagnostics.push_back(error("editor_preview.missing_field",
                                                "Missing text accessibility scale policy.",
                                                "/environment/project/accessibility/textScale"));
                if (ui_scale && text_scale) {
                    result.environment.accessibility = {
                        .ui_scale = *ui_scale,
                        .text_scale = *text_scale,
                    };
                }
            } else {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "accessibility must be an object.",
                                            "/environment/project/accessibility"));
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type", "project must be an object.",
                                        "/environment/project"));
        }
    }

    if (const auto* room = object("room")) {
        exact_fields(*room, {"roomId", "recordLabel", "displayName", "visit"}, diagnostics,
                     "/room");
        result.room_id = required_string(*room, "roomId", "/room");
        result.record_label = required_string(*room, "recordLabel", "/room");
        result.display_name = required_string(*room, "displayName", "/room");
        if (const auto visit = room->find("visit"); visit != room->end() && visit->is_object()) {
            exact_fields(*visit, {"visitIndex", "sourceRoomId", "entryExitId"}, diagnostics,
                         "/room/visit");
            if (json_access::member_as<int>(*visit, "visitIndex") != 1 ||
                !visit->contains("sourceRoomId") || !(*visit)["sourceRoomId"].is_null() ||
                !visit->contains("entryExitId") || !(*visit)["entryExitId"].is_null())
                diagnostics.push_back(error(
                    "editor_preview.invalid_room_visit",
                    "Focused Room visit must be the deterministic first visit.", "/room/visit"));
        } else {
            diagnostics.push_back(
                error("editor_preview.wrong_type", "visit must be an object.", "/room/visit"));
        }
    }

    const auto parse_string_array = [&](const nlohmann::json& section, std::string_view field,
                                        std::vector<std::string>& output,
                                        std::string_view section_path) {
        const auto values = section.find(field);
        if (values == section.end() || !values->is_array()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        std::string(field) + " must be an array.",
                                        std::string(section_path) + "/" + std::string(field)));
            return;
        }
        for (std::size_t index = 0; index < values->size(); ++index) {
            auto parsed = json_access::get<std::string>((*values)[index]);
            if (parsed && !parsed->empty()) {
                output.push_back(std::move(*parsed));
            } else {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "Identifier entries must be non-empty strings.",
                                            std::string(section_path) + "/" + std::string(field) +
                                                "/" + std::to_string(index)));
            }
        }
    };

    if (const auto* admission = object("luaAdmission")) {
        exact_fields(*admission,
                     {"definitions", "variableIds", "properties", "interactableLocationIds",
                      "compositionDraftCharacterIds", "compositionDraftInteractableIds"},
                     diagnostics, "/luaAdmission");
        parse_string_array(*admission, "variableIds", result.lua_admission.variable_ids,
                           "/luaAdmission");
        parse_string_array(*admission, "interactableLocationIds",
                           result.lua_admission.interactable_location_ids, "/luaAdmission");
        parse_string_array(*admission, "compositionDraftCharacterIds",
                           result.lua_admission.composition_draft_character_ids, "/luaAdmission");
        parse_string_array(*admission, "compositionDraftInteractableIds",
                           result.lua_admission.composition_draft_interactable_ids,
                           "/luaAdmission");
        if (const auto definitions = admission->find("definitions");
            definitions != admission->end() && definitions->is_array()) {
            for (std::size_t index = 0; index < definitions->size(); ++index) {
                const auto& value = (*definitions)[index];
                const auto path = "/luaAdmission/definitions/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Definition admission must be an object.", path));
                    continue;
                }
                exact_fields(value, {"collection", "id"}, diagnostics, path);
                result.lua_admission.definitions.push_back(
                    {.collection = required_string(value, "collection", path),
                     .id = required_string(value, "id", path)});
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "definitions must be an array.",
                                        "/luaAdmission/definitions"));
        }
        if (const auto properties = admission->find("properties");
            properties != admission->end() && properties->is_array()) {
            for (std::size_t index = 0; index < properties->size(); ++index) {
                const auto& value = (*properties)[index];
                const auto path = "/luaAdmission/properties/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Property admission must be an object.", path));
                    continue;
                }
                exact_fields(value, {"ownerKind", "ownerId", "propertyId"}, diagnostics, path);
                result.lua_admission.properties.push_back(
                    {.owner_kind = required_string(value, "ownerKind", path),
                     .owner_id = required_string(value, "ownerId", path),
                     .property_id = required_string(value, "propertyId", path)});
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type", "properties must be an array.",
                                        "/luaAdmission/properties"));
        }
    }

    if (const auto* query = object("queryState")) {
        exact_fields(*query, {"variables", "properties", "definitions", "interactableLocations"},
                     diagnostics, "/queryState");
        if (const auto variables = query->find("variables");
            variables != query->end() && variables->is_array()) {
            for (std::size_t index = 0; index < variables->size(); ++index) {
                const auto& value = (*variables)[index];
                const auto path = "/queryState/variables/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Variable query state must be an object.", path));
                    continue;
                }
                exact_fields(value, {"id", "type", "value"}, diagnostics, path);
                TypedFocusedRoomQueryState::Variable typed{
                    .id = required_string(value, "id", path),
                    .type = required_string(value, "type", path),
                    .value = scalar(value.contains("value") ? value["value"] : nlohmann::json{},
                                    path + "/value")};
                static constexpr std::array<std::string_view, 5> types{"boolean", "integer",
                                                                       "number", "string", "enum"};
                if (std::find(types.begin(), types.end(), typed.type) == types.end())
                    diagnostics.push_back(error("editor_preview.invalid_enum",
                                                "Variable query type is unsupported.",
                                                path + "/type"));
                result.query_state.variables.push_back(std::move(typed));
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type", "variables must be an array.",
                                        "/queryState/variables"));
        }
        if (const auto properties = query->find("properties");
            properties != query->end() && properties->is_array()) {
            for (std::size_t index = 0; index < properties->size(); ++index) {
                const auto& value = (*properties)[index];
                const auto path = "/queryState/properties/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Property query state must be an object.", path));
                    continue;
                }
                exact_fields(value, {"ownerKind", "ownerId", "propertyId", "result"}, diagnostics,
                             path);
                TypedFocusedRoomQueryState::Property typed{
                    .identity = {.owner_kind = required_string(value, "ownerKind", path),
                                 .owner_id = required_string(value, "ownerId", path),
                                 .property_id = required_string(value, "propertyId", path)},
                    .missing = false,
                    .value = {}};
                const auto property_result = value.find("result");
                if (property_result == value.end() || !property_result->is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Property result must be an object.",
                                                path + "/result"));
                } else {
                    const auto kind = json_access::member_as<std::string>(*property_result, "kind");
                    if (kind == "missing") {
                        exact_fields(*property_result, {"kind"}, diagnostics, path + "/result");
                        typed.missing = true;
                    } else if (kind == "value") {
                        exact_fields(*property_result, {"kind", "value"}, diagnostics,
                                     path + "/result");
                        typed.value = scalar((*property_result)["value"], path + "/result/value");
                    } else {
                        diagnostics.push_back(error("editor_preview.invalid_enum",
                                                    "Property result kind is unsupported.",
                                                    path + "/result/kind"));
                    }
                }
                result.query_state.properties.push_back(std::move(typed));
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type", "properties must be an array.",
                                        "/queryState/properties"));
        }
        if (const auto definitions = query->find("definitions");
            definitions != query->end() && definitions->is_array()) {
            for (std::size_t index = 0; index < definitions->size(); ++index) {
                const auto& value = (*definitions)[index];
                const auto path = "/queryState/definitions/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Definition query state must be an object.", path));
                    continue;
                }
                exact_fields(value, {"collection", "id", "displayName"}, diagnostics, path);
                result.query_state.definitions.push_back(
                    {.collection = required_string(value, "collection", path),
                     .id = required_string(value, "id", path),
                     .display_name = optional_string(value, "displayName", path)});
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "definitions must be an array.",
                                        "/queryState/definitions"));
        }
        if (const auto locations = query->find("interactableLocations");
            locations != query->end() && locations->is_array()) {
            for (std::size_t index = 0; index < locations->size(); ++index) {
                const auto& value = (*locations)[index];
                const auto path = "/queryState/interactableLocations/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Interactable location state must be an object.",
                                                path));
                    continue;
                }
                exact_fields(value, {"interactableId", "location"}, diagnostics, path);
                TypedFocusedRoomQueryState::InteractableLocation typed{
                    .interactable_id = required_string(value, "interactableId", path),
                    .location = compiled::UnplacedLocation{}};
                const auto location = value.find("location");
                if (location == value.end())
                    diagnostics.push_back(error("editor_preview.missing_field",
                                                "location is required.", path + "/location"));
                else
                    typed.location = interactable_location(*location, path + "/location");
                result.query_state.interactable_locations.push_back(std::move(typed));
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "interactableLocations must be an array.",
                                        "/queryState/interactableLocations"));
        }
    }

    if (const auto* materials = object("shaderMaterials")) {
        exact_fields(*materials, {"schema", "shaders", "materials"}, diagnostics,
                     "/shaderMaterials");
        auto parsed = parse_shader_material_project_json_value(*materials);
        if (!parsed.ok()) {
            for (const auto& diagnostic : parsed.diagnostics)
                diagnostics.push_back(error("editor_preview.invalid_material_metadata",
                                            diagnostic.message,
                                            "/shaderMaterials" + diagnostic.path));
        } else {
            result.shader_materials = std::move(*parsed.project);
        }
    }

    if (const auto* world = object("world")) {
        exact_fields(*world,
                     {"presentationSpace", "anchors", "background", "placements",
                      "persistentCharacters", "cast", "interactables", "props", "environments",
                      "overlays", "hotspots"},
                     diagnostics, "/world");
        if (const auto presentation = world->find("presentationSpace");
            presentation != world->end() && presentation->is_object()) {
            exact_fields(*presentation, {"size", "bounds", "edgePolicy", "view"}, diagnostics,
                         "/world/presentationSpace");
            const auto finite = [&](const nlohmann::json& value, std::string_view field,
                                    std::string_view path, double fallback = 0.0) {
                const auto parsed = json_access::member_as<double>(value, field);
                if (!parsed || !std::isfinite(*parsed)) {
                    diagnostics.push_back(error("editor_preview.invalid_number",
                                                std::string(field) + " must be finite.",
                                                std::string(path) + "/" + std::string(field)));
                    return fallback;
                }
                return *parsed;
            };
            if (const auto size = presentation->find("size");
                size != presentation->end() && size->is_object()) {
                exact_fields(*size, {"width", "height"}, diagnostics,
                             "/world/presentationSpace/size");
                result.world.presentation_space.size = {
                    finite(*size, "width", "/world/presentationSpace/size", 1920.0),
                    finite(*size, "height", "/world/presentationSpace/size", 1080.0)};
                if (result.world.presentation_space.size.x <= 0.0 ||
                    result.world.presentation_space.size.y <= 0.0)
                    diagnostics.push_back(error("editor_preview.invalid_value",
                                                "Presentation Space size must be positive.",
                                                "/world/presentationSpace/size"));
            } else {
                diagnostics.push_back(error("editor_preview.wrong_type", "size must be an object.",
                                            "/world/presentationSpace/size"));
            }
            if (const auto bounds = presentation->find("bounds");
                bounds != presentation->end() && !bounds->is_null()) {
                if (!bounds->is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "bounds must be an object or null.",
                                                "/world/presentationSpace/bounds"));
                } else {
                    exact_fields(*bounds, {"x", "y", "width", "height"}, diagnostics,
                                 "/world/presentationSpace/bounds");
                    result.world.presentation_space.bounds = compiled::WorldPresentationRect{
                        finite(*bounds, "x", "/world/presentationSpace/bounds"),
                        finite(*bounds, "y", "/world/presentationSpace/bounds"),
                        finite(*bounds, "width", "/world/presentationSpace/bounds"),
                        finite(*bounds, "height", "/world/presentationSpace/bounds")};
                }
            }
            const auto edge =
                required_string(*presentation, "edgePolicy", "/world/presentationSpace");
            if (edge == "overscan")
                result.world.presentation_space.edge_policy =
                    compiled::WorldPresentationEdgePolicy::Overscan;
            else if (edge != "contain")
                diagnostics.push_back(error("editor_preview.invalid_value",
                                            "edgePolicy must be contain or overscan.",
                                            "/world/presentationSpace/edgePolicy"));
            if (const auto view = presentation->find("view");
                view != presentation->end() && view->is_object()) {
                exact_fields(*view, {"center", "zoom", "rotationDegrees"}, diagnostics,
                             "/world/presentationSpace/view");
                if (const auto center = view->find("center");
                    center != view->end() && center->is_object()) {
                    exact_fields(*center, {"x", "y"}, diagnostics,
                                 "/world/presentationSpace/view/center");
                    result.world.presentation_space.view.center = {
                        finite(*center, "x", "/world/presentationSpace/view/center"),
                        finite(*center, "y", "/world/presentationSpace/view/center")};
                }
                result.world.presentation_space.view.zoom =
                    finite(*view, "zoom", "/world/presentationSpace/view", 1.0);
                result.world.presentation_space.view.rotation_degrees =
                    finite(*view, "rotationDegrees", "/world/presentationSpace/view");
                if (result.world.presentation_space.view.zoom <= 0.0)
                    diagnostics.push_back(error("editor_preview.invalid_value",
                                                "Camera View zoom must be positive.",
                                                "/world/presentationSpace/view/zoom"));
            } else {
                diagnostics.push_back(error("editor_preview.wrong_type", "view must be an object.",
                                            "/world/presentationSpace/view"));
            }
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "presentationSpace must be an object.",
                                        "/world/presentationSpace"));
        }
        if (const auto background = world->find("background");
            background != world->end() && background->is_object()) {
            exact_fields(*background, {"assetId", "materialId", "fit", "color"}, diagnostics,
                         "/world/background");
            result.world.background.asset_id =
                optional_string(*background, "assetId", "/world/background");
            result.world.background.material_id =
                optional_string(*background, "materialId", "/world/background");
            result.world.background.fit = required_string(*background, "fit", "/world/background");
            result.world.background.color =
                optional_string(*background, "color", "/world/background");
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "background must be an object.", "/world/background"));
        }
        const auto array = [&](std::string_view field) -> const nlohmann::json* {
            const auto found = world->find(field);
            if (found == world->end() || !found->is_array()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            std::string(field) + " must be an array.",
                                            "/world/" + std::string(field)));
                return nullptr;
            }
            return &*found;
        };
        if (const auto* anchors = array("anchors"))
            for (std::size_t index = 0; index < anchors->size(); ++index) {
                const auto& value = (*anchors)[index];
                const auto path = "/world/anchors/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(
                        error("editor_preview.wrong_type", "Anchor must be an object.", path));
                    continue;
                }
                exact_fields(value, {"id", "bounds"}, diagnostics, path);
                result.world.anchors.push_back({.id = required_string(value, "id", path),
                                                .bounds = rect(value["bounds"], path + "/bounds")});
            }
        if (const auto* placements = array("placements"))
            for (std::size_t index = 0; index < placements->size(); ++index) {
                const auto& value = (*placements)[index];
                const auto path = "/world/placements/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(
                        error("editor_preview.wrong_type", "Placement must be an object.", path));
                    continue;
                }
                exact_fields(value, {"id", "bounds", "order", "label", "layoutId"}, diagnostics,
                             path);
                TypedFocusedRoomWorldDefinition::Placement typed{
                    .id = required_string(value, "id", path),
                    .bounds = rect(value["bounds"], path + "/bounds"),
                    .order = json_access::member_as<int>(value, "order").value_or(0),
                    .label = std::nullopt,
                    .layout_id = optional_string(value, "layoutId", path)};
                if (const auto label = value.find("label");
                    label != value.end() && !label->is_null())
                    typed.label = text(*label, path + "/label");
                result.world.placements.push_back(std::move(typed));
            }
        if (const auto* characters = array("persistentCharacters"))
            for (std::size_t index = 0; index < characters->size(); ++index) {
                const auto& value = (*characters)[index];
                const auto path = "/world/persistentCharacters/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Persistent Character must be an object.", path));
                    continue;
                }
                exact_fields(
                    value, {"characterId", "placementId", "enabled", "visible", "order", "visual"},
                    diagnostics, path);
                if (json_access::member_as<int>(value, "order") != 0)
                    diagnostics.push_back(error("editor_preview.invalid_value",
                                                "Persistent Character order must be zero.",
                                                path + "/order"));
                result.world.persistent_characters.push_back(
                    {.character_id = required_string(value, "characterId", path),
                     .placement_id = required_string(value, "placementId", path),
                     .enabled = required_bool(value, "enabled", path),
                     .visible = required_bool(value, "visible", path),
                     .visual = visual(value["visual"], path + "/visual")});
            }
        if (const auto* cast = array("cast"))
            for (std::size_t index = 0; index < cast->size(); ++index) {
                const auto& value = (*cast)[index];
                const auto path = "/world/cast/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(
                        error("editor_preview.wrong_type", "Cast entry must be an object.", path));
                    continue;
                }
                exact_fields(value,
                             {"entryId", "characterId", "condition", "placementId", "enabled",
                              "visible", "occurrenceVisible", "order", "visual"},
                             diagnostics, path);
                result.world.cast.push_back(
                    {.entry_id = required_string(value, "entryId", path),
                     .character_id = required_string(value, "characterId", path),
                     .condition = condition(value["condition"], path + "/condition"),
                     .placement_id = required_string(value, "placementId", path),
                     .enabled = required_bool(value, "enabled", path),
                     .visible = required_bool(value, "visible", path),
                     .occurrence_visible = required_bool(value, "occurrenceVisible", path),
                     .order = json_access::member_as<int>(value, "order").value_or(0),
                     .visual = visual(value["visual"], path + "/visual")});
            }
        if (const auto* interactables = array("interactables"))
            for (std::size_t index = 0; index < interactables->size(); ++index) {
                const auto& value = (*interactables)[index];
                const auto path = "/world/interactables/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Interactable must be an object.", path));
                    continue;
                }
                exact_fields(value,
                             {"occurrenceId", "interactableId", "condition", "placementId",
                              "spriteAssetId", "materialId", "enabled", "visible",
                              "occurrenceVisible", "order"},
                             diagnostics, path);
                result.world.interactables.push_back(
                    {.occurrence_id = required_string(value, "occurrenceId", path),
                     .interactable_id = required_string(value, "interactableId", path),
                     .condition = condition(value["condition"], path + "/condition"),
                     .placement_id = required_string(value, "placementId", path),
                     .sprite_asset_id = optional_string(value, "spriteAssetId", path),
                     .material_id = optional_string(value, "materialId", path),
                     .enabled = required_bool(value, "enabled", path),
                     .visible = required_bool(value, "visible", path),
                     .occurrence_visible = required_bool(value, "occurrenceVisible", path),
                     .order = json_access::member_as<int>(value, "order").value_or(0)});
            }
        if (const auto* props = array("props"))
            for (std::size_t index = 0; index < props->size(); ++index) {
                const auto& value = (*props)[index];
                const auto path = "/world/props/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(
                        error("editor_preview.wrong_type", "Prop must be an object.", path));
                    continue;
                }
                exact_fields(value,
                             {"propId", "condition", "placementId", "assetId", "materialId",
                              "visible", "order"},
                             diagnostics, path);
                result.world.props.push_back(
                    {.prop_id = required_string(value, "propId", path),
                     .condition = condition(value["condition"], path + "/condition"),
                     .placement_id = required_string(value, "placementId", path),
                     .asset_id = optional_string(value, "assetId", path),
                     .material_id = optional_string(value, "materialId", path),
                     .visible = required_bool(value, "visible", path),
                     .order = json_access::member_as<int>(value, "order").value_or(0)});
            }
        if (const auto* environments = array("environments"))
            for (std::size_t index = 0; index < environments->size(); ++index) {
                const auto& value = (*environments)[index];
                const auto path = "/world/environments/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(
                        error("editor_preview.wrong_type", "Environment must be an object.", path));
                    continue;
                }
                exact_fields(value,
                             {"environmentId", "condition", "assetId", "materialId", "bounds",
                              "plane", "order", "clock", "scrollPerSecond", "opacity", "visible"},
                             diagnostics, path);
                result.world.environments.push_back(
                    {.environment_id = required_string(value, "environmentId", path),
                     .condition = condition(value["condition"], path + "/condition"),
                     .asset_id = optional_string(value, "assetId", path),
                     .material_id = required_string(value, "materialId", path),
                     .bounds = rect(value["bounds"], path + "/bounds"),
                     .plane = required_string(value, "plane", path),
                     .order = json_access::member_as<int>(value, "order").value_or(0),
                     .clock = required_string(value, "clock", path),
                     .scroll_per_second =
                         vector2(value["scrollPerSecond"], path + "/scrollPerSecond"),
                     .opacity = json_access::member_as<double>(value, "opacity").value_or(1.0),
                     .visible = required_bool(value, "visible", path)});
            }
        if (const auto* overlays = array("overlays"))
            for (std::size_t index = 0; index < overlays->size(); ++index) {
                const auto& value = (*overlays)[index];
                const auto path = "/world/overlays/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(
                        error("editor_preview.wrong_type", "Overlay must be an object.", path));
                    continue;
                }
                exact_fields(value, {"overlayId", "condition", "layoutId", "visible", "order"},
                             diagnostics, path);
                result.world.overlays.push_back(
                    {.overlay_id = required_string(value, "overlayId", path),
                     .condition = condition(value["condition"], path + "/condition"),
                     .layout_id = required_string(value, "layoutId", path),
                     .visible = required_bool(value, "visible", path),
                     .order = json_access::member_as<int>(value, "order").value_or(0)});
            }
        if (const auto* hotspots = array("hotspots"))
            for (std::size_t index = 0; index < hotspots->size(); ++index) {
                const auto& value = (*hotspots)[index];
                const auto path = "/world/hotspots/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(
                        error("editor_preview.wrong_type", "Hotspot must be an object.", path));
                    continue;
                }
                exact_fields(value,
                             {"ownerKind", "ownerId", "hotspotId", "label", "condition",
                              "inputOrder", "shape", "target", "cursor", "sourceAssetId",
                              "sourceWidth", "sourceHeight", "placementId"},
                             diagnostics, path);
                TypedFocusedRoomWorldDefinition::Hotspot typed{
                    .owner_kind = required_string(value, "ownerKind", path),
                    .owner_id = required_string(value, "ownerId", path),
                    .hotspot_id = required_string(value, "hotspotId", path),
                    .label = required_string(value, "label", path),
                    .condition = condition(value["condition"], path + "/condition"),
                    .input_order = json_access::member_as<int>(value, "inputOrder").value_or(0),
                    .alpha_shape = false,
                    .bounds = std::nullopt,
                    .target = {},
                    .cursor = required_string(value, "cursor", path),
                    .source_asset = std::nullopt,
                    .source_width = 0,
                    .source_height = 0,
                    .placement_id = optional_string(value, "placementId", path)};
                const auto source_asset_text = required_string(value, "sourceAssetId", path);
                if (auto source_asset = AssetId::create(source_asset_text))
                    typed.source_asset = std::move(source_asset).value();
                else
                    diagnostics.push_back(error("editor_preview.invalid_id",
                                                "Hotspot sourceAssetId is invalid.",
                                                path + "/sourceAssetId"));
                const auto source_width =
                    json_access::member_as<std::uint32_t>(value, "sourceWidth");
                const auto source_height =
                    json_access::member_as<std::uint32_t>(value, "sourceHeight");
                if (!source_width || *source_width == 0 || *source_width > UINT16_MAX)
                    diagnostics.push_back(error("editor_preview.invalid_value",
                                                "Hotspot sourceWidth must be between 1 and 65535.",
                                                path + "/sourceWidth"));
                else
                    typed.source_width = static_cast<std::uint16_t>(*source_width);
                if (!source_height || *source_height == 0 || *source_height > UINT16_MAX)
                    diagnostics.push_back(error("editor_preview.invalid_value",
                                                "Hotspot sourceHeight must be between 1 and 65535.",
                                                path + "/sourceHeight"));
                else
                    typed.source_height = static_cast<std::uint16_t>(*source_height);
                if (const auto shape = value.find("shape");
                    shape != value.end() && shape->is_object()) {
                    const auto shape_path = path + "/shape";
                    const auto kind = required_string(*shape, "kind", shape_path);
                    if (kind == "alpha") {
                        exact_fields(*shape, {"kind"}, diagnostics, shape_path);
                        typed.alpha_shape = true;
                    } else if (kind == "rect") {
                        exact_fields(*shape, {"kind", "bounds"}, diagnostics, shape_path);
                        if (shape->contains("bounds"))
                            typed.bounds = rect((*shape)["bounds"], shape_path + "/bounds");
                    } else {
                        diagnostics.push_back(error("editor_preview.invalid_value",
                                                    "Hotspot shape kind is invalid.",
                                                    shape_path + "/kind"));
                    }
                } else {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Hotspot shape must be an object.",
                                                path + "/shape"));
                }
                if (const auto target = value.find("target");
                    target != value.end() && target->is_object()) {
                    const auto target_path = path + "/target";
                    const auto kind = required_string(*target, "kind", target_path);
                    typed.target.kind = kind;
                    if (kind == "character") {
                        exact_fields(*target, {"kind", "characterId"}, diagnostics, target_path);
                        typed.target.primary_id =
                            required_string(*target, "characterId", target_path);
                    } else if (kind == "interactable") {
                        exact_fields(*target, {"kind", "interactableId"}, diagnostics, target_path);
                        typed.target.primary_id =
                            required_string(*target, "interactableId", target_path);
                    } else if (kind == "room-feature") {
                        exact_fields(*target, {"kind", "roomId", "featureId"}, diagnostics,
                                     target_path);
                        typed.target.primary_id = required_string(*target, "roomId", target_path);
                        typed.target.secondary_id =
                            required_string(*target, "featureId", target_path);
                    } else if (kind == "interactable-feature") {
                        exact_fields(*target, {"kind", "interactableId", "featureId"}, diagnostics,
                                     target_path);
                        typed.target.primary_id =
                            required_string(*target, "interactableId", target_path);
                        typed.target.secondary_id =
                            required_string(*target, "featureId", target_path);
                    } else if (kind == "exit") {
                        exact_fields(*target, {"kind", "roomId", "exitId"}, diagnostics,
                                     target_path);
                        typed.target.primary_id = required_string(*target, "roomId", target_path);
                        typed.target.secondary_id = required_string(*target, "exitId", target_path);
                    } else {
                        diagnostics.push_back(error("editor_preview.invalid_value",
                                                    "Hotspot target kind is invalid.",
                                                    target_path + "/kind"));
                    }
                } else {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "Hotspot target must be an object.",
                                                path + "/target"));
                }
                result.world.hotspots.push_back(std::move(typed));
            }
    }

    if (const auto* ui = object("ui")) {
        exact_fields(*ui, {"description", "exits"}, diagnostics, "/ui");
        if (ui->contains("description"))
            result.ui.description = text((*ui)["description"], "/ui/description");
        if (const auto exits = ui->find("exits"); exits != ui->end() && exits->is_array()) {
            for (std::size_t index = 0; index < exits->size(); ++index) {
                const auto& value = (*exits)[index];
                const auto path = "/ui/exits/" + std::to_string(index);
                if (!value.is_object()) {
                    diagnostics.push_back(
                        error("editor_preview.wrong_type", "Exit must be an object.", path));
                    continue;
                }
                exact_fields(value, {"exitId", "label", "direction", "targetRoomId", "condition"},
                             diagnostics, path);
                result.ui.exits.push_back(
                    {.exit_id = required_string(value, "exitId", path),
                     .label = required_string(value, "label", path),
                     .direction = required_string(value, "direction", path),
                     .target_room_id = required_string(value, "targetRoomId", path),
                     .condition = condition(value["condition"], path + "/condition")});
            }
        } else {
            diagnostics.push_back(
                error("editor_preview.wrong_type", "exits must be an array.", "/ui/exits"));
        }
    }

    const auto layouts = document.find("layouts");
    if (layouts == document.end() || !layouts->is_array()) {
        diagnostics.push_back(
            error("editor_preview.wrong_type", "layouts must be an array.", "/layouts"));
    } else if (layouts->size() > limits.max_layouts) {
        diagnostics.push_back(
            error("editor_preview.size_limit", "Room preview has too many Layouts.", "/layouts"));
    } else {
        result.layouts.reserve(layouts->size());
        for (std::size_t index = 0; index < layouts->size(); ++index) {
            const auto& layout = (*layouts)[index];
            const auto path = "/layouts/" + std::to_string(index);
            if (!layout.is_object()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "Room Layout definition must be an object.", path));
                continue;
            }
            exact_fields(layout,
                         {"instanceId", "layoutId", "mount", "source", "scriptEnabled",
                          "containsDedicatedLuaSource", "containsExecutableRmlLua", "contract",
                          "scalePolicy"},
                         diagnostics, path);
            TypedFocusedRoomLayoutDefinition decoded;
            decoded.instance_id = required_string(layout, "instanceId", path);
            if (const auto id = layout.find("layoutId"); id != layout.end()) {
                if (id->is_string())
                    decoded.layout_id = id->get<std::string>();
                else if (!id->is_null())
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "layoutId must be a string or null.",
                                                path + "/layoutId"));
            }
            decoded.script_enabled = required_bool(layout, "scriptEnabled", path);
            decoded.contains_dedicated_lua_source =
                required_bool(layout, "containsDedicatedLuaSource", path);
            decoded.contains_executable_rml_lua =
                required_bool(layout, "containsExecutableRmlLua", path);
            if (!layout.contains("mount") || !layout["mount"].is_object() ||
                !layout.contains("source") || !layout["source"].is_object() ||
                !layout.contains("scalePolicy") || !layout["scalePolicy"].is_object()) {
                diagnostics.push_back(
                    error("editor_preview.wrong_type",
                          "Room Layout mount, source, and scalePolicy must be objects.", path));
            } else {
                const auto& mount = layout["mount"];
                const auto mount_kind = json_access::member_as<std::string>(mount, "kind");
                if (mount_kind == "game-hud") {
                    exact_fields(mount, {"kind"}, diagnostics, path + "/mount");
                    decoded.mount_kind = TypedFocusedRoomLayoutDefinition::MountKind::GameHud;
                } else if (mount_kind == "room-overlay") {
                    exact_fields(mount, {"kind", "overlayId", "order", "visible"}, diagnostics,
                                 path + "/mount");
                    decoded.mount_kind = TypedFocusedRoomLayoutDefinition::MountKind::RoomOverlay;
                    decoded.overlay_id = required_string(mount, "overlayId", path + "/mount");
                    decoded.order = json_access::member_as<int>(mount, "order").value_or(0);
                    decoded.visible =
                        json_access::member_as<bool>(mount, "visible").value_or(false);
                } else
                    diagnostics.push_back(error("editor_preview.invalid_enum",
                                                "Room Layout mount kind is unsupported.",
                                                path + "/mount/kind"));

                const auto& source = layout["source"];
                const auto source_kind = json_access::member_as<std::string>(source, "kind");
                if (source_kind == "builtin-game-hud") {
                    exact_fields(source, {"kind"}, diagnostics, path + "/source");
                    decoded.source_kind =
                        TypedFocusedRoomLayoutDefinition::SourceKind::BuiltinGameHud;
                } else if (source_kind == "authored") {
                    exact_fields(source,
                                 {"kind", "layoutKind", "templateId", "sourceUrl", "defaultParent",
                                  "scopedStyles", "scriptNamespace", "rml", "rcss", "lua"},
                                 diagnostics, path + "/source");
                    decoded.source_kind = TypedFocusedRoomLayoutDefinition::SourceKind::Authored;
                    if (auto value = string_field(source, "sourceUrl", diagnostics,
                                                  path + "/source", limits)) {
                        if (!safe_project_logical_path(*value))
                            diagnostics.push_back(
                                error("editor_preview.invalid_logical_path",
                                      "Authored Layout sourceUrl must use a safe project:/ path.",
                                      path + "/source/sourceUrl"));
                        else
                            decoded.source_url = std::move(*value);
                    }
                    if (auto value = string_field(source, "layoutKind", diagnostics,
                                                  path + "/source", limits)) {
                        if (*value == "document")
                            decoded.layout_kind =
                                TypedFocusedRoomLayoutDefinition::LayoutKind::Document;
                        else if (*value == "fragment")
                            decoded.layout_kind =
                                TypedFocusedRoomLayoutDefinition::LayoutKind::Fragment;
                        else
                            diagnostics.push_back(error("editor_preview.invalid_layout_kind",
                                                        "Authored Layout kind is unsupported.",
                                                        path + "/source/layoutKind"));
                    }
                    const auto template_id = source.find("templateId");
                    if (template_id == source.end() ||
                        (!template_id->is_null() && !template_id->is_string())) {
                        diagnostics.push_back(error("editor_preview.wrong_type",
                                                    "Layout templateId must be a string or null.",
                                                    path + "/source/templateId"));
                    } else if (template_id->is_string()) {
                        decoded.template_id = template_id->get<std::string>();
                        if (*decoded.template_id != "layout-fragment-host-v1")
                            diagnostics.push_back(error("editor_preview.invalid_template_id",
                                                        "Unsupported focused Layout templateId.",
                                                        path + "/source/templateId"));
                    }
                    if ((decoded.layout_kind ==
                         TypedFocusedRoomLayoutDefinition::LayoutKind::Fragment) !=
                        decoded.template_id.has_value())
                        diagnostics.push_back(error("editor_preview.template_kind_mismatch",
                                                    "Layout templateId does not match layoutKind.",
                                                    path + "/source/templateId"));
                    const auto default_parent = source.find("defaultParent");
                    if (default_parent == source.end() ||
                        (!default_parent->is_null() && !default_parent->is_string()))
                        diagnostics.push_back(
                            error("editor_preview.wrong_type",
                                  "Layout defaultParent must be a string or null.",
                                  path + "/source/defaultParent"));
                    else if (default_parent->is_string())
                        decoded.default_parent = default_parent->get<std::string>();
                    const auto scoped_styles = source.find("scopedStyles");
                    if (scoped_styles == source.end() || !scoped_styles->is_boolean())
                        diagnostics.push_back(error("editor_preview.wrong_type",
                                                    "Layout scopedStyles must be a boolean.",
                                                    path + "/source/scopedStyles"));
                    else
                        decoded.scoped_styles = scoped_styles->get<bool>();
                    const auto script_namespace = source.find("scriptNamespace");
                    if (script_namespace == source.end() ||
                        (!script_namespace->is_null() && !script_namespace->is_string()))
                        diagnostics.push_back(
                            error("editor_preview.wrong_type",
                                  "Layout scriptNamespace must be a string or null.",
                                  path + "/source/scriptNamespace"));
                    else if (script_namespace->is_string())
                        decoded.script_namespace = script_namespace->get<std::string>();
                    auto rml =
                        preview_layout_source(source, "rml", diagnostics, limits, path + "/source");
                    auto rcss = preview_layout_source(source, "rcss", diagnostics, limits,
                                                      path + "/source");
                    auto lua =
                        preview_layout_source(source, "lua", diagnostics, limits, path + "/source");
                    if (rml)
                        decoded.rml = std::move(*rml);
                    if (rcss)
                        decoded.rcss = std::move(*rcss);
                    if (lua)
                        decoded.lua = std::move(*lua);
                    if (decoded.rml.kind == TypedEditorLayoutSourceComponent::Kind::LogicalAsset &&
                        !decoded.source_url.empty() && decoded.source_url != decoded.rml.value)
                        diagnostics.push_back(
                            error("editor_preview.source_url_mismatch",
                                  "Asset-backed Layout sourceUrl must equal its RML logical path.",
                                  path + "/source/sourceUrl"));
                    const bool dedicated_source_present =
                        decoded.lua.kind == TypedEditorLayoutSourceComponent::Kind::LogicalAsset ||
                        !decoded.lua.value.empty();
                    if (decoded.contains_dedicated_lua_source != dedicated_source_present)
                        diagnostics.push_back(error(
                            "editor_preview.lua_presence_mismatch",
                            "containsDedicatedLuaSource does not match the decoded Lua source.",
                            path + "/containsDedicatedLuaSource"));
                } else
                    diagnostics.push_back(error("editor_preview.invalid_enum",
                                                "Room Layout source kind is unsupported.",
                                                path + "/source/kind"));
                const auto* contract = json_access::member(layout, "contract");
                if (decoded.source_kind ==
                    TypedFocusedRoomLayoutDefinition::SourceKind::BuiltinGameHud) {
                    if (decoded.mount_kind !=
                            TypedFocusedRoomLayoutDefinition::MountKind::GameHud ||
                        decoded.layout_id || decoded.script_enabled ||
                        decoded.contains_dedicated_lua_source ||
                        decoded.contains_executable_rml_lua || contract == nullptr ||
                        !contract->is_null()) {
                        diagnostics.push_back(error(
                            "editor_preview.invalid_builtin_game_hud",
                            "Built-in Game HUD carries invalid authored Layout state.", path));
                    }
                } else {
                    if (!decoded.layout_id) {
                        diagnostics.push_back(error("editor_preview.layout_id_required",
                                                    "Authored focused Layout requires layoutId.",
                                                    path + "/layoutId"));
                    }
                    if (contract == nullptr || !contract->is_object()) {
                        diagnostics.push_back(
                            error("editor_preview.invalid_layout_contract",
                                  "Authored focused Room Layout requires its Mount Contract.",
                                  path + "/contract"));
                    } else {
                        EditorRuntimeProtocolLimits contract_limits;
                        contract_limits.max_document_bytes = limits.max_request_bytes;
                        contract_limits.max_string_bytes = limits.max_string_bytes;
                        const auto diagnostics_before_contract = diagnostics.size();
                        auto decoded_contract = preview_layout_contract(
                            *contract, diagnostics, path + "/contract", contract_limits);
                        if (!decoded_contract &&
                            diagnostics.size() == diagnostics_before_contract) {
                            diagnostics.push_back(error("editor_preview.invalid_layout_contract",
                                                        "Layout contract contains a missing, "
                                                        "invalid, or oversized declaration.",
                                                        path + "/contract"));
                        }
                        if (decoded_contract) {
                            decoded.contract = std::move(*decoded_contract);
                            for (const auto& input : decoded.contract.inputs) {
                                if (input.default_value) {
                                    decoded.preview_inputs.push_back(
                                        LayoutResolvedInput{input.id, *input.default_value});
                                } else {
                                    diagnostics.push_back(error(
                                        "editor_preview.focused_room_layout_input_required",
                                        "Mounted focused Room Layout is missing a required input.",
                                        path + "/contract/inputs/" + input.id.text()));
                                }
                            }
                            if (decoded.contract.state)
                                decoded.preview_state = decoded.contract.state->default_value;
                            decoded.synthetic_semantic_mount = true;
                        }
                    }
                }
                exact_fields(layout["scalePolicy"], {"ui", "text"}, diagnostics,
                             path + "/scalePolicy");
                const auto parse_scale = [&](std::string_view field) {
                    const auto value =
                        json_access::member_as<std::string>(layout["scalePolicy"], field);
                    if (value == "inherit")
                        return LayoutScaleInheritance::Inherit;
                    if (value == "ignore")
                        return LayoutScaleInheritance::Ignore;
                    diagnostics.push_back(error("editor_preview.invalid_enum",
                                                "Layout scale inheritance is unsupported.",
                                                path + "/scalePolicy/" + std::string(field)));
                    return LayoutScaleInheritance::Inherit;
                };
                decoded.scale_policy.ui = parse_scale("ui");
                decoded.scale_policy.text = parse_scale("text");
            }
            result.layouts.push_back(std::move(decoded));
        }
    }

    if (const auto composition = document.find("composition"); composition != document.end()) {
        if (composition->is_null()) {
            result.composition.reset();
        } else if (composition->is_object()) {
            exact_fields(*composition, {"moduleId", "exportName", "source"}, diagnostics,
                         "/composition");
            TypedFocusedRoomCompositionDefinition typed;
            typed.module_id = required_string(*composition, "moduleId", "/composition");
            typed.export_name = required_string(*composition, "exportName", "/composition");
            if (const auto source = composition->find("source");
                source != composition->end() && source->is_object()) {
                const auto source_kind =
                    json_access::member_as<std::string>(*source, "kind").value_or("");
                if (source_kind == "inline") {
                    exact_fields(*source, {"kind", "text"}, diagnostics, "/composition/source");
                    typed.source.inline_source = true;
                    typed.source.value = required_string(*source, "text", "/composition/source");
                } else if (source_kind == "asset") {
                    exact_fields(*source, {"kind", "logicalPath"}, diagnostics,
                                 "/composition/source");
                    typed.source.inline_source = false;
                    typed.source.value =
                        required_string(*source, "logicalPath", "/composition/source");
                } else {
                    diagnostics.push_back(error("editor_preview.invalid_enum",
                                                "Composition source kind is unsupported.",
                                                "/composition/source/kind"));
                }
            } else {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "Composition source must be an object.",
                                            "/composition/source"));
            }
            result.composition = std::move(typed);
        } else {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "composition must be an object or null.", "/composition"));
        }
    }

    if (!diagnostics.empty())
        return Result<TypedEditorRoomPreviewDocument, Diagnostics>::failure(std::move(diagnostics));
    return Result<TypedEditorRoomPreviewDocument, Diagnostics>::success(std::move(result));
}

namespace {

std::optional<TypedPlaybackExpectationKind> playback_expectation_kind(std::string_view value)
{
    if (value == "property")
        return TypedPlaybackExpectationKind::Property;
    if (value == "current-room")
        return TypedPlaybackExpectationKind::CurrentRoom;
    if (value == "location")
        return TypedPlaybackExpectationKind::Location;
    if (value == "quantity")
        return TypedPlaybackExpectationKind::Quantity;
    if (value == "trait")
        return TypedPlaybackExpectationKind::Trait;
    if (value == "entity-state")
        return TypedPlaybackExpectationKind::EntityState;
    if (value == "active-flow")
        return TypedPlaybackExpectationKind::ActiveFlow;
    if (value == "layout")
        return TypedPlaybackExpectationKind::Layout;
    if (value == "event")
        return TypedPlaybackExpectationKind::Event;
    if (value == "diagnostic")
        return TypedPlaybackExpectationKind::Diagnostic;
    return std::nullopt;
}

std::optional<TypedPlaybackExpectationOperator>
playback_expectation_operator(std::string_view value)
{
    if (value == "eq")
        return TypedPlaybackExpectationOperator::Equal;
    if (value == "ne")
        return TypedPlaybackExpectationOperator::NotEqual;
    if (value == "present")
        return TypedPlaybackExpectationOperator::Present;
    if (value == "absent")
        return TypedPlaybackExpectationOperator::Absent;
    if (value == "gt")
        return TypedPlaybackExpectationOperator::Greater;
    if (value == "gte")
        return TypedPlaybackExpectationOperator::GreaterEqual;
    if (value == "lt")
        return TypedPlaybackExpectationOperator::Less;
    if (value == "lte")
        return TypedPlaybackExpectationOperator::LessEqual;
    return std::nullopt;
}

void decode_playback_expectations(const nlohmann::json& value, std::string_view path,
                                  const EditorRuntimeProtocolLimits& limits,
                                  std::vector<TypedPlaybackExpectation>& output,
                                  Diagnostics& diagnostics)
{
    if (!value.is_array()) {
        diagnostics.push_back(error("editor_protocol.wrong_type", "expectations must be an array.",
                                    std::string(path)));
        return;
    }
    if (value.size() > limits.max_steps) {
        diagnostics.push_back(error("editor_protocol.size_limit", "Too many playback expectations.",
                                    std::string(path)));
        return;
    }
    std::set<std::string> ids;
    for (std::size_t index = 0; index < value.size(); ++index) {
        const auto expectation_path = std::string(path) + "/" + std::to_string(index);
        const auto& item = value[index];
        if (!item.is_object()) {
            diagnostics.push_back(error("editor_protocol.wrong_type",
                                        "Playback expectation must be an object.",
                                        expectation_path));
            continue;
        }
        auto id = string_field(item, "id", diagnostics, expectation_path, limits);
        auto type = string_field(item, "type", diagnostics, expectation_path, limits);
        auto op = string_field(item, "operator", diagnostics, expectation_path, limits);
        if (id && !ids.insert(*id).second)
            diagnostics.push_back(error("editor_protocol.duplicate_expectation_id",
                                        "Expectation id must be unique in its expectation list.",
                                        expectation_path + "/id"));
        const auto kind = type ? playback_expectation_kind(*type) : std::nullopt;
        const auto decoded_op = op ? playback_expectation_operator(*op) : std::nullopt;
        if (type && !kind)
            diagnostics.push_back(error("editor_protocol.invalid_expectation_type",
                                        "Unsupported playback expectation type.",
                                        expectation_path + "/type"));
        if (op && !decoded_op)
            diagnostics.push_back(error("editor_protocol.invalid_expectation_operator",
                                        "Unsupported playback expectation operator.",
                                        expectation_path + "/operator"));
        if (!kind || !decoded_op)
            continue;

        const auto require_string = [&](std::string_view field) {
            return string_field(item, field, diagnostics, expectation_path, limits);
        };
        const auto require_enum = [&](std::string_view field,
                                      std::initializer_list<std::string_view> allowed) {
            auto decoded = require_string(field);
            if (!decoded)
                return;
            if (std::find(allowed.begin(), allowed.end(), *decoded) == allowed.end())
                diagnostics.push_back(error("editor_protocol.invalid_expectation_field",
                                            "Playback expectation field has an unsupported value.",
                                            expectation_path + "/" + std::string(field)));
        };
        const auto equality = *decoded_op == TypedPlaybackExpectationOperator::Equal ||
                              *decoded_op == TypedPlaybackExpectationOperator::NotEqual;
        const auto presence = *decoded_op == TypedPlaybackExpectationOperator::Present ||
                              *decoded_op == TypedPlaybackExpectationOperator::Absent;
        const auto numeric = *decoded_op == TypedPlaybackExpectationOperator::Greater ||
                             *decoded_op == TypedPlaybackExpectationOperator::GreaterEqual ||
                             *decoded_op == TypedPlaybackExpectationOperator::Less ||
                             *decoded_op == TypedPlaybackExpectationOperator::LessEqual;
        const auto invalid_operator = [&](std::string_view message) {
            diagnostics.push_back(error("editor_protocol.invalid_expectation_operator",
                                        std::string(message), expectation_path + "/operator"));
        };

        switch (*kind) {
        case TypedPlaybackExpectationKind::Property:
            exact_fields(item,
                         {"id", "type", "operator", "scope", "ownerId", "propertyId", "value"},
                         diagnostics, expectation_path);
            require_enum("scope", {"global", "room", "character", "interactable"});
            require_string("ownerId");
            require_string("propertyId");
            if (!equality && !presence && !numeric)
                invalid_operator(
                    "Property expectations require equality, presence, or numeric operators.");
            break;
        case TypedPlaybackExpectationKind::CurrentRoom:
            exact_fields(item, {"id", "type", "operator", "roomId"}, diagnostics, expectation_path);
            require_string("roomId");
            if (!equality && !presence)
                invalid_operator(
                    "Current Room expectations require equality or presence operators.");
            break;
        case TypedPlaybackExpectationKind::Location:
            exact_fields(item,
                         {"id", "type", "operator", "entityKind", "entityId", "locationKind",
                          "roomId", "inventoryOwnerKind", "inventoryOwnerId", "inventoryId"},
                         diagnostics, expectation_path);
            require_enum("entityKind", {"character", "interactable"});
            require_string("entityId");
            require_enum("locationKind", {"unplaced", "room", "inventory"});
            require_string("roomId");
            require_enum("inventoryOwnerKind", {"project", "character", "interactable"});
            require_string("inventoryOwnerId");
            require_string("inventoryId");
            if (!equality && !presence)
                invalid_operator("Location expectations require equality or presence operators.");
            break;
        case TypedPlaybackExpectationKind::Quantity:
            exact_fields(item, {"id", "type", "operator", "interactableId", "value"}, diagnostics,
                         expectation_path);
            require_string("interactableId");
            if (!equality && !numeric)
                invalid_operator("Quantity expectations require equality or numeric operators.");
            break;
        case TypedPlaybackExpectationKind::Trait:
            exact_fields(item, {"id", "type", "operator", "ownerKind", "ownerId", "traitId"},
                         diagnostics, expectation_path);
            require_enum("ownerKind", {"room", "character", "interactable"});
            require_string("ownerId");
            require_string("traitId");
            if (!presence)
                invalid_operator("Trait expectations require presence operators.");
            break;
        case TypedPlaybackExpectationKind::EntityState:
            exact_fields(item,
                         {"id", "type", "operator", "entityKind", "entityId", "field", "value"},
                         diagnostics, expectation_path);
            require_enum("entityKind", {"character", "interactable"});
            require_string("entityId");
            require_enum("field", {"enabled", "visible"});
            if (!equality)
                invalid_operator("Entity-state expectations require equality operators.");
            break;
        case TypedPlaybackExpectationKind::ActiveFlow:
            exact_fields(item, {"id", "type", "operator", "kind", "flowId"}, diagnostics,
                         expectation_path);
            require_enum("kind", {"scene", "dialogue"});
            require_string("flowId");
            if (!equality && !presence)
                invalid_operator(
                    "Active-flow expectations require equality or presence operators.");
            break;
        case TypedPlaybackExpectationKind::Layout: {
            exact_fields(item, {"id", "type", "operator", "layoutId", "field", "value"},
                         diagnostics, expectation_path);
            require_string("layoutId");
            auto field = require_string("field");
            if (field && *field != "mounted" && *field != "state")
                diagnostics.push_back(error("editor_protocol.invalid_expectation_field",
                                            "Layout expectation field must be mounted or state.",
                                            expectation_path + "/field"));
            if (field && *field == "mounted" && !presence)
                invalid_operator("Mounted Layout expectations require presence operators.");
            if (field && *field == "state" && !equality && !numeric)
                invalid_operator(
                    "Layout-state expectations require equality or numeric operators.");
            break;
        }
        case TypedPlaybackExpectationKind::Event:
            exact_fields(item, {"id", "type", "operator", "kind", "value"}, diagnostics,
                         expectation_path);
            require_enum("kind", {"notification", "save-outcome"});
            require_string("value");
            if (!presence)
                invalid_operator("Event expectations require presence operators.");
            break;
        case TypedPlaybackExpectationKind::Diagnostic:
            exact_fields(item, {"id", "type", "operator", "code"}, diagnostics, expectation_path);
            require_string("code");
            if (!presence)
                invalid_operator("Diagnostic expectations require presence operators.");
            break;
        }

        if (*kind == TypedPlaybackExpectationKind::Property) {
            const auto field = item.find("value");
            if (field == item.end())
                diagnostics.push_back(error("editor_protocol.missing_field", "Missing value.",
                                            expectation_path + "/value"));
            else {
                Diagnostics value_diagnostics;
                (void)runtime_value(*field, value_diagnostics, expectation_path + "/value", limits);
                diagnostics.insert(diagnostics.end(), value_diagnostics.begin(),
                                   value_diagnostics.end());
                if (numeric && !field->is_number())
                    diagnostics.push_back(
                        error("editor_protocol.wrong_type",
                              "Numeric Property comparisons require a numeric expected value.",
                              expectation_path + "/value"));
            }
        }
        if (*kind == TypedPlaybackExpectationKind::Quantity) {
            const auto field = item.find("value");
            if (field == item.end() || !field->is_number())
                diagnostics.push_back(error("editor_protocol.wrong_type",
                                            "Quantity expectation value must be numeric.",
                                            expectation_path + "/value"));
        }
        if (*kind == TypedPlaybackExpectationKind::EntityState) {
            const auto field = item.find("value");
            if (field == item.end() || !field->is_boolean())
                diagnostics.push_back(error("editor_protocol.wrong_type",
                                            "Entity-state expectation value must be boolean.",
                                            expectation_path + "/value"));
        }
        if (*kind == TypedPlaybackExpectationKind::Layout) {
            const auto field = item.find("value");
            if (field == item.end())
                diagnostics.push_back(error("editor_protocol.missing_field", "Missing value.",
                                            expectation_path + "/value"));
            else {
                Diagnostics value_diagnostics;
                (void)preview_persistable_value(*field, value_diagnostics,
                                                expectation_path + "/value", limits);
                diagnostics.insert(diagnostics.end(), value_diagnostics.begin(),
                                   value_diagnostics.end());
                if (numeric && !field->is_number())
                    diagnostics.push_back(
                        error("editor_protocol.wrong_type",
                              "Numeric Layout-state comparisons require a numeric expected value.",
                              expectation_path + "/value"));
            }
        }
        if (id)
            output.push_back(TypedPlaybackExpectation{*id, *kind, *decoded_op, item});
    }
}

} // namespace

Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback(const nlohmann::json& document, const EditorRuntimeProtocolLimits& limits)
{
    Diagnostics diagnostics;
    exact_fields(document, {"schema", "version", "id", "steps", "finalExpectations"}, diagnostics,
                 "/");
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
    const auto final_expectations = document.find("finalExpectations");
    if (final_expectations == document.end())
        diagnostics.push_back(error("editor_protocol.missing_field", "Missing finalExpectations.",
                                    "/finalExpectations"));
    else
        decode_playback_expectations(*final_expectations, "/finalExpectations", limits,
                                     spec.final_expectations, diagnostics);
    if (steps != document.end() && steps->is_array() && steps->size() <= limits.max_steps) {
        std::set<std::uint64_t> indexes;
        for (std::size_t position = 0; position < steps->size(); ++position) {
            const auto path = "/steps/" + std::to_string(position);
            const auto& step = (*steps)[position];
            Diagnostics step_diagnostics;
            exact_fields(step, {"index", "input", "expectations"}, step_diagnostics, path);
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
                std::optional<TypedPlaybackInput> decoded_input;
                bool recognized_ui_click = false;
                if (input->is_object()) {
                    const auto type = input->find("type");
                    if (type != input->end() && type->is_string() &&
                        type->get<std::string>() == "ui-click") {
                        recognized_ui_click = true;
                        exact_fields(*input, {"type", "documentId", "selector"}, step_diagnostics,
                                     path + "/input");
                        auto document_id = string_field(*input, "documentId", step_diagnostics,
                                                        path + "/input", limits);
                        auto selector = string_field(*input, "selector", step_diagnostics,
                                                     path + "/input", limits);
                        if (document_id && document_id->empty())
                            step_diagnostics.push_back(
                                error("editor_protocol.invalid_value",
                                      "UI click documentId must not be empty.",
                                      path + "/input/documentId"));
                        if (selector && selector->empty())
                            step_diagnostics.push_back(error("editor_protocol.invalid_value",
                                                             "UI click selector must not be empty.",
                                                             path + "/input/selector"));
                        if (document_id && selector && !document_id->empty() && !selector->empty())
                            decoded_input = TypedPlaybackUiClickInput{std::move(*document_id),
                                                                      std::move(*selector)};
                    }
                }
                if (!decoded_input && !recognized_ui_click) {
                    auto decoded = decode_input_object(*input, limits, path + "/input", false);
                    if (decoded)
                        decoded_input = std::move(*decoded.value_if());
                    else
                        step_diagnostics.insert(step_diagnostics.end(), decoded.error().begin(),
                                                decoded.error().end());
                }
                if (decoded_input && decoded_index) {
                    TypedPlaybackStep typed_step{*decoded_index, std::move(*decoded_input), {}};
                    const auto expectations = step.find("expectations");
                    if (expectations == step.end())
                        step_diagnostics.push_back(error("editor_protocol.missing_field",
                                                         "Missing expectations.",
                                                         path + "/expectations"));
                    else
                        decode_playback_expectations(*expectations, path + "/expectations", limits,
                                                     typed_step.expectations, step_diagnostics);
                    spec.steps.push_back(std::move(typed_step));
                }
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
    auto document = parse_editor_protocol_document(text, limits);
    if (!document)
        return Result<TypedPlaybackSpec, Diagnostics>::failure(std::move(document).error());
    return decode_editor_playback(*document.value_if(), limits);
}

nlohmann::json
encode_editor_playback_report(std::string_view id,
                              const std::vector<TypedPlaybackStepReport>& steps,
                              const std::vector<TypedPlaybackExpectationReport>& final_expectations,
                              const runtime::RuntimePublication& final_publication, bool passed)
{
    nlohmann::json result = {{"schema", playback_report_schema},
                             {"version", editor_runtime_protocol_version},
                             {"id", id},
                             {"passed", passed},
                             {"steps", nlohmann::json::array()},
                             {"finalExpectations", nlohmann::json::array()},
                             {"finalPublication", encode_publication(final_publication)}};
    for (const auto& step : steps) {
        nlohmann::json encoded = {{"index", step.index},
                                  {"handled", step.handled},
                                  {"events", nlohmann::json::array()},
                                  {"diagnostics", nlohmann::json::array()},
                                  {"expectations", nlohmann::json::array()}};
        for (const auto& event : step.events)
            encoded["events"].push_back(encode_event(event));
        for (const auto& diagnostic : step.diagnostics)
            encoded["diagnostics"].push_back(encode_diagnostic(diagnostic));
        for (const auto& expectation : step.expectations)
            encoded["expectations"].push_back({{"id", expectation.id},
                                               {"passed", expectation.passed},
                                               {"message", expectation.message}});
        result["steps"].push_back(std::move(encoded));
    }
    for (const auto& expectation : final_expectations)
        result["finalExpectations"].push_back({{"id", expectation.id},
                                               {"passed", expectation.passed},
                                               {"message", expectation.message}});
    return result;
}

std::string encode_editor_playback_report_text(
    std::string_view id, const std::vector<TypedPlaybackStepReport>& steps,
    const std::vector<TypedPlaybackExpectationReport>& final_expectations,
    const runtime::RuntimePublication& final_publication, bool passed)
{
    return encode_editor_playback_report(id, steps, final_expectations, final_publication, passed)
        .dump();
}

nlohmann::json encode_editor_debug_snapshot(const runtime::RuntimePublication& publication,
                                            const std::vector<runtime::RuntimeEvent>& events,
                                            const Diagnostics& diagnostics, bool preview_running)
{
    nlohmann::json result = {
        {"schema", debug_snapshot_schema},   {"version", editor_runtime_protocol_version},
        {"previewRunning", preview_running}, {"publication", encode_publication(publication)},
        {"events", nlohmann::json::array()}, {"diagnostics", nlohmann::json::array()}};
    for (const auto& event : events)
        result["events"].push_back(encode_event(event));
    for (const auto& diagnostic : diagnostics)
        result["diagnostics"].push_back(encode_diagnostic(diagnostic));
    return result;
}

std::string encode_editor_debug_snapshot_text(const runtime::RuntimePublication& publication,
                                              const std::vector<runtime::RuntimeEvent>& events,
                                              const Diagnostics& diagnostics, bool preview_running)
{
    return encode_editor_debug_snapshot(publication, events, diagnostics, preview_running).dump();
}

} // namespace noveltea::core::editor
