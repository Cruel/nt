#include "compiled_project_wire.hpp"

#include "noveltea/core/json_access.hpp"

#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>

namespace noveltea::core::compiled::wire {
namespace {

constexpr std::string_view k_code_missing = "compiled_project.missing_field";
constexpr std::string_view k_code_type = "compiled_project.type";
constexpr std::string_view k_code_unknown = "compiled_project.unknown_field";
constexpr std::string_view k_code_enum = "compiled_project.unknown_value";
constexpr std::string_view k_code_variant = "compiled_project.unknown_variant";
constexpr std::string_view k_code_id = "compiled_project.invalid_id";
constexpr std::string_view k_code_duplicate = "compiled_project.duplicate_id";
constexpr std::string_view k_code_number = "compiled_project.invalid_number";

std::string pointer_child(std::string_view parent, std::string_view child)
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

std::string pointer_index(std::string_view parent, std::size_t index)
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

std::optional<RuntimeValue> decode_runtime_value(Decoder& decoder, const nlohmann::json& value,
                                                 std::string_view pointer, bool allow_null = true)
{
    if (value.is_null()) {
        if (allow_null)
            return RuntimeValue{std::monostate{}};
        decoder.error(k_code_type, "Null is not allowed here.", std::string(pointer));
        return std::nullopt;
    }
    if (const auto decoded = json_access::get<bool>(value))
        return RuntimeValue{*decoded};
    if (const auto* integer = value.get_ptr<const nlohmann::json::number_integer_t*>())
        return RuntimeValue{static_cast<std::int64_t>(*integer)};
    if (const auto* integer = value.get_ptr<const nlohmann::json::number_unsigned_t*>()) {
        if (*integer <= static_cast<nlohmann::json::number_unsigned_t>(
                            std::numeric_limits<std::int64_t>::max()))
            return RuntimeValue{static_cast<std::int64_t>(*integer)};
        decoder.error(k_code_number, "Integer is outside the signed 64-bit runtime range.",
                      std::string(pointer));
        return std::nullopt;
    }
    if (const auto* number = value.get_ptr<const nlohmann::json::number_float_t*>()) {
        if (std::isfinite(*number))
            return RuntimeValue{static_cast<double>(*number)};
        decoder.error(k_code_number, "Number must be finite.", std::string(pointer));
        return std::nullopt;
    }
    if (const auto decoded = json_access::get<std::string>(value))
        return RuntimeValue{*decoded};
    decoder.error(k_code_type, "Expected a scalar runtime value.", std::string(pointer));
    return std::nullopt;
}

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

std::optional<TextContent> decode_text(Decoder& decoder, const nlohmann::json& value,
                                       std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"markup", "source"}))
        return std::nullopt;
    const auto* markup_value = decoder.member(value, "markup", pointer);
    const auto* source_value = decoder.member(value, "source", pointer);
    auto markup = markup_value
                      ? decoder.enumeration<TextMarkup>(
                            *markup_value, pointer_child(pointer, "markup"),
                            {{"plain", TextMarkup::Plain}, {"active-text", TextMarkup::ActiveText}})
                      : std::nullopt;
    std::optional<TextSource> source;
    if (source_value && decoder.object(*source_value, pointer_child(pointer, "source"),
                                       {"kind", "text", "key", "source"})) {
        const auto source_pointer = pointer_child(pointer, "source");
        const auto* kind_value = decoder.member(*source_value, "kind", source_pointer);
        auto kind = kind_value ? decoder.string(*kind_value, pointer_child(source_pointer, "kind"))
                               : std::nullopt;
        if (kind && *kind == "inline") {
            decoder.object(*source_value, source_pointer, {"kind", "text"});
            const auto* text_value = decoder.member(*source_value, "text", source_pointer);
            auto text = text_value
                            ? decoder.string(*text_value, pointer_child(source_pointer, "text"))
                            : std::nullopt;
            if (text)
                source = InlineText{std::move(*text)};
        } else if (kind && *kind == "localized") {
            decoder.object(*source_value, source_pointer, {"kind", "key"});
            const auto* key_value = decoder.member(*source_value, "key", source_pointer);
            auto key = key_value
                           ? decoder.string(*key_value, pointer_child(source_pointer, "key"), true)
                           : std::nullopt;
            if (key)
                source = LocalizedTextKey{std::move(*key)};
        } else if (kind && *kind == "lua-expression") {
            decoder.object(*source_value, source_pointer, {"kind", "source"});
            const auto* lua_value = decoder.member(*source_value, "source", source_pointer);
            auto lua = lua_value ? decoder.string(*lua_value,
                                                  pointer_child(source_pointer, "source"), true)
                                 : std::nullopt;
            if (lua)
                source = LuaTextExpression{std::move(*lua)};
        } else if (kind) {
            decoder.error(k_code_variant, "Unknown text source variant '" + *kind + "'.",
                          pointer_child(source_pointer, "kind"));
        }
    }
    if (!markup || !source)
        return std::nullopt;
    return TextContent{std::move(*source), *markup};
}

std::optional<Condition> decode_condition_impl(Decoder& decoder, const nlohmann::json& value,
                                               std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a condition object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "always") {
        decoder.object(value, pointer, {"kind"});
        return Condition{Always{}};
    }
    if (*kind == "lua-predicate") {
        decoder.object(value, pointer, {"kind", "source"});
        const auto* source_value = decoder.member(value, "source", pointer);
        auto source = source_value
                          ? decoder.string(*source_value, pointer_child(pointer, "source"), true)
                          : std::nullopt;
        return source ? std::optional<Condition>(LuaPredicate{std::move(*source)}) : std::nullopt;
    }
    if (*kind == "variable-comparison") {
        decoder.object(value, pointer, {"kind", "operator", "value", "variable"});
        const auto* operation_value = decoder.member(value, "operator", pointer);
        const auto* variable_value = decoder.member(value, "variable", pointer);
        auto operation = operation_value
                             ? decoder.string(*operation_value, pointer_child(pointer, "operator"))
                             : std::nullopt;
        auto variable =
            variable_value
                ? decode_reference<VariableId>(decoder, *variable_value,
                                               pointer_child(pointer, "variable"), "variable")
                : std::nullopt;
        if (!operation || !variable)
            return std::nullopt;
        if (*operation == "truthy" || *operation == "falsy") {
            if (json_access::member(value, "value"))
                decoder.error(k_code_unknown, "Truthiness comparisons do not accept 'value'.",
                              pointer_child(pointer, "value"));
            return Condition{VariableComparison{VariableTruthiness{
                std::move(*variable),
                *operation == "truthy" ? TruthinessOperator::Truthy : TruthinessOperator::Falsy}}};
        }
        const auto* comparison_value = decoder.member(value, "value", pointer);
        auto comparison = comparison_value ? decode_runtime_value(decoder, *comparison_value,
                                                                  pointer_child(pointer, "value"))
                                           : std::nullopt;
        auto comparison_operator = decoder.enumeration<ValueComparisonOperator>(
            *operation_value, pointer_child(pointer, "operator"),
            {{"equal", ValueComparisonOperator::Equal},
             {"not-equal", ValueComparisonOperator::NotEqual},
             {"less", ValueComparisonOperator::Less},
             {"less-equal", ValueComparisonOperator::LessEqual},
             {"greater", ValueComparisonOperator::Greater},
             {"greater-equal", ValueComparisonOperator::GreaterEqual}});
        if (!comparison || !comparison_operator)
            return std::nullopt;
        return Condition{VariableComparison{VariableValueComparison{
            std::move(*variable), *comparison_operator, std::move(*comparison)}}};
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown condition variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<Effect> decode_effect_impl(Decoder& decoder, const nlohmann::json& value,
                                         std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an effect object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "set-variable") {
        decoder.object(value, pointer, {"kind", "value", "variable"});
        const auto* variable_value = decoder.member(value, "variable", pointer);
        const auto* assignment_value = decoder.member(value, "value", pointer);
        auto variable =
            variable_value
                ? decode_reference<VariableId>(decoder, *variable_value,
                                               pointer_child(pointer, "variable"), "variable")
                : std::nullopt;
        auto assignment = assignment_value ? decode_runtime_value(decoder, *assignment_value,
                                                                  pointer_child(pointer, "value"))
                                           : std::nullopt;
        if (variable && assignment)
            return Effect{SetVariable{std::move(*variable), std::move(*assignment)}};
        return std::nullopt;
    }
    if (*kind == "run-lua-effect") {
        decoder.object(value, pointer, {"kind", "source"});
        const auto* source_value = decoder.member(value, "source", pointer);
        auto source = source_value
                          ? decoder.string(*source_value, pointer_child(pointer, "source"), true)
                          : std::nullopt;
        return source ? std::optional<Effect>(RunLuaEffect{std::move(*source)}) : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown effect variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<FlowTarget> decode_flow_target_impl(Decoder& decoder, const nlohmann::json& value,
                                                  std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a flow target object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "return") {
        decoder.object(value, pointer, {"kind"});
        return FlowTarget{ReturnFlow{}};
    }
    if (*kind == "end") {
        decoder.object(value, pointer, {"kind"});
        return FlowTarget{EndFlow{}};
    }
    if (*kind == "scene") {
        decoder.object(value, pointer, {"kind", "scene"});
        const auto* reference = decoder.member(value, "scene", pointer);
        auto id = reference ? decode_reference<SceneId>(decoder, *reference,
                                                        pointer_child(pointer, "scene"), "scene")
                            : std::nullopt;
        return id ? std::optional<FlowTarget>(std::move(*id)) : std::nullopt;
    }
    if (*kind == "dialogue") {
        decoder.object(value, pointer, {"kind", "dialogue"});
        const auto* reference = decoder.member(value, "dialogue", pointer);
        auto id = reference
                      ? decode_reference<DialogueId>(decoder, *reference,
                                                     pointer_child(pointer, "dialogue"), "dialogue")
                      : std::nullopt;
        return id ? std::optional<FlowTarget>(std::move(*id)) : std::nullopt;
    }
    if (*kind == "room") {
        decoder.object(value, pointer, {"kind", "room"});
        const auto* reference = decoder.member(value, "room", pointer);
        auto id = reference ? decode_reference<RoomId>(decoder, *reference,
                                                       pointer_child(pointer, "room"), "room")
                            : std::nullopt;
        return id ? std::optional<FlowTarget>(std::move(*id)) : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown flow target variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<Vector2> decode_vector2(Decoder& decoder, const nlohmann::json& value,
                                      std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"x", "y"}))
        return std::nullopt;
    const auto* x_value = decoder.member(value, "x", pointer);
    const auto* y_value = decoder.member(value, "y", pointer);
    auto x = x_value ? decoder.finite_number(*x_value, pointer_child(pointer, "x")) : std::nullopt;
    auto y = y_value ? decoder.finite_number(*y_value, pointer_child(pointer, "y")) : std::nullopt;
    return x && y ? std::optional<Vector2>(Vector2{*x, *y}) : std::nullopt;
}

std::optional<NormalizedRect> decode_rect(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"height", "width", "x", "y"}))
        return std::nullopt;
    const auto* height_value = decoder.member(value, "height", pointer);
    const auto* width_value = decoder.member(value, "width", pointer);
    const auto* x_value = decoder.member(value, "x", pointer);
    const auto* y_value = decoder.member(value, "y", pointer);
    auto height = height_value
                      ? decoder.finite_number(*height_value, pointer_child(pointer, "height"))
                      : std::nullopt;
    auto width = width_value ? decoder.finite_number(*width_value, pointer_child(pointer, "width"))
                             : std::nullopt;
    auto x = x_value ? decoder.finite_number(*x_value, pointer_child(pointer, "x")) : std::nullopt;
    auto y = y_value ? decoder.finite_number(*y_value, pointer_child(pointer, "y")) : std::nullopt;
    if (height && (*height <= 0.0 || *height > 1.0)) {
        decoder.error(k_code_number, "Height must be greater than zero and at most one.",
                      pointer_child(pointer, "height"));
        height.reset();
    }
    if (width && (*width <= 0.0 || *width > 1.0)) {
        decoder.error(k_code_number, "Width must be greater than zero and at most one.",
                      pointer_child(pointer, "width"));
        width.reset();
    }
    if (x && (*x < 0.0 || *x > 1.0)) {
        decoder.error(k_code_number, "X must be between zero and one.",
                      pointer_child(pointer, "x"));
        x.reset();
    }
    if (y && (*y < 0.0 || *y > 1.0)) {
        decoder.error(k_code_number, "Y must be between zero and one.",
                      pointer_child(pointer, "y"));
        y.reset();
    }
    return height && width && x && y
               ? std::optional<NormalizedRect>(NormalizedRect{*x, *y, *width, *height})
               : std::nullopt;
}

std::optional<BackgroundPresentation>
decode_background(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"asset", "color", "fit", "material"}))
        return std::nullopt;
    const auto* asset_value = decoder.member(value, "asset", pointer);
    const auto* color_value = decoder.member(value, "color", pointer);
    const auto* fit_value = decoder.member(value, "fit", pointer);
    const auto* material_value = decoder.member(value, "material", pointer);
    std::optional<AssetId> asset;
    bool asset_ok = asset_value != nullptr;
    if (asset_value && !asset_value->is_null()) {
        asset = decode_reference<AssetId>(decoder, *asset_value, pointer_child(pointer, "asset"),
                                          "asset");
        asset_ok = asset.has_value();
    }
    std::optional<std::string> color;
    bool color_ok = color_value != nullptr;
    if (color_value && !color_value->is_null()) {
        color = decoder.string(*color_value, pointer_child(pointer, "color"));
        color_ok = color.has_value();
    }
    auto fit = fit_value
                   ? decoder.enumeration<BackgroundFit>(*fit_value, pointer_child(pointer, "fit"),
                                                        {{"cover", BackgroundFit::Cover},
                                                         {"contain", BackgroundFit::Contain},
                                                         {"stretch", BackgroundFit::Stretch},
                                                         {"center", BackgroundFit::Center}})
                   : std::nullopt;
    std::optional<MaterialId> material;
    bool material_ok = material_value != nullptr;
    if (material_value && !material_value->is_null()) {
        material = decode_reference<MaterialId>(decoder, *material_value,
                                                pointer_child(pointer, "material"), "material");
        material_ok = material.has_value();
    }
    if (!asset_ok || !color_ok || !fit || !material_ok)
        return std::nullopt;
    return BackgroundPresentation{std::move(asset), std::move(color), *fit, std::move(material)};
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

std::optional<RoomPlacementRef> decode_placement_ref(Decoder& decoder, const nlohmann::json& value,
                                                     std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"placementId", "room"}))
        return std::nullopt;
    const auto* placement_value = decoder.member(value, "placementId", pointer);
    const auto* room_value = decoder.member(value, "room", pointer);
    auto placement =
        placement_value
            ? decoder.id<RoomPlacementId>(*placement_value, pointer_child(pointer, "placementId"))
            : std::nullopt;
    auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                      pointer_child(pointer, "room"), "room")
                           : std::nullopt;
    return placement && room ? std::optional<RoomPlacementRef>(
                                   RoomPlacementRef{std::move(*room), std::move(*placement)})
                             : std::nullopt;
}

std::optional<InteractableLocation> decode_location(Decoder& decoder, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a location object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "inventory") {
        decoder.object(value, pointer, {"kind"});
        return InteractableLocation{InventoryLocation{}};
    }
    if (*kind == "nowhere") {
        decoder.object(value, pointer, {"kind"});
        return InteractableLocation{NowhereLocation{}};
    }
    if (*kind == "room-placement") {
        decoder.object(value, pointer, {"kind", "placement"});
        const auto* placement_value = decoder.member(value, "placement", pointer);
        auto placement = placement_value ? decode_placement_ref(decoder, *placement_value,
                                                                pointer_child(pointer, "placement"))
                                         : std::nullopt;
        return placement ? std::optional<InteractableLocation>(std::move(*placement))
                         : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown interactable location variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<LayoutSource> decode_layout_source(Decoder& decoder, const nlohmann::json& value,
                                                 std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a layout source object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "inline") {
        decoder.object(value, pointer, {"kind", "text"});
        const auto* text_value = decoder.member(value, "text", pointer);
        auto text =
            text_value ? decoder.string(*text_value, pointer_child(pointer, "text")) : std::nullopt;
        return text ? std::optional<LayoutSource>(InlineLayoutSource{std::move(*text)})
                    : std::nullopt;
    }
    if (*kind == "asset") {
        decoder.object(value, pointer, {"asset", "kind"});
        const auto* asset_value = decoder.member(value, "asset", pointer);
        auto asset = asset_value
                         ? decode_reference<AssetId>(decoder, *asset_value,
                                                     pointer_child(pointer, "asset"), "asset")
                         : std::nullopt;
        return asset ? std::optional<LayoutSource>(AssetLayoutSource{std::move(*asset)})
                     : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown layout source variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<ScriptSource> decode_script_source(Decoder& decoder, const nlohmann::json& value,
                                                 std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a script source object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "inline-lua") {
        decoder.object(value, pointer, {"kind", "source"});
        const auto* source_value = decoder.member(value, "source", pointer);
        auto source = source_value ? decoder.string(*source_value, pointer_child(pointer, "source"))
                                   : std::nullopt;
        return source ? std::optional<ScriptSource>(InlineLuaSource{std::move(*source)})
                      : std::nullopt;
    }
    if (*kind == "asset") {
        decoder.object(value, pointer, {"asset", "kind"});
        const auto* asset_value = decoder.member(value, "asset", pointer);
        auto asset = asset_value
                         ? decode_reference<AssetId>(decoder, *asset_value,
                                                     pointer_child(pointer, "asset"), "asset")
                         : std::nullopt;
        return asset ? std::optional<ScriptSource>(AssetScriptSource{std::move(*asset)})
                     : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown script source variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<PropertyValueType> decode_value_type(Decoder& decoder, const nlohmann::json& value,
                                                   const nlohmann::json& enum_values,
                                                   std::string_view pointer,
                                                   std::vector<std::string>& decoded_enum_values)
{
    auto values = decoder.array<std::string>(
        enum_values, pointer_child(pointer, "enumValues"),
        [&](const nlohmann::json& item, const std::string& item_pointer) {
            return decoder.string(item, item_pointer, true);
        });
    auto type = decoder.string(value, pointer_child(pointer, "type"));
    if (!values || !type)
        return std::nullopt;
    decoded_enum_values = std::move(*values);
    if (*type == "boolean")
        return PropertyValueType{BooleanPropertyType{}};
    if (*type == "integer")
        return PropertyValueType{IntegerPropertyType{}};
    if (*type == "number")
        return PropertyValueType{NumberPropertyType{}};
    if (*type == "string")
        return PropertyValueType{StringPropertyType{}};
    if (*type == "enum")
        return PropertyValueType{EnumPropertyType{decoded_enum_values}};
    decoder.error(k_code_enum, "Unknown scalar declaration type '" + *type + "'.",
                  pointer_child(pointer, "type"));
    return std::nullopt;
}

std::optional<ProjectIdentity>
decode_project_identity(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"author", "description", "id", "name", "version"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* name_value = decoder.member(value, "name", pointer);
    const auto* version_value = decoder.member(value, "version", pointer);
    const auto* author_value = decoder.member(value, "author", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    auto id =
        id_value ? decoder.id<ProjectId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto name =
        name_value ? decoder.string(*name_value, pointer_child(pointer, "name")) : std::nullopt;
    auto version = version_value ? decoder.string(*version_value, pointer_child(pointer, "version"))
                                 : std::nullopt;
    auto author = author_value ? decoder.string(*author_value, pointer_child(pointer, "author"))
                               : std::nullopt;
    auto description = description_value ? decoder.string(*description_value,
                                                          pointer_child(pointer, "description"))
                                         : std::nullopt;
    if (!id || !name || !version || !author || !description)
        return std::nullopt;
    return ProjectIdentity{std::move(*id), std::move(*name), std::move(*version),
                           std::move(*author), std::move(*description)};
}

std::optional<Entrypoint> decode_entrypoint(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an entrypoint object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "room") {
        decoder.object(value, pointer, {"kind", "room"});
        const auto* room_value = decoder.member(value, "room", pointer);
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        return room ? std::optional<Entrypoint>(std::move(*room)) : std::nullopt;
    }
    if (*kind == "scene") {
        decoder.object(value, pointer, {"kind", "scene"});
        const auto* scene_value = decoder.member(value, "scene", pointer);
        auto scene = scene_value
                         ? decode_reference<SceneId>(decoder, *scene_value,
                                                     pointer_child(pointer, "scene"), "scene")
                         : std::nullopt;
        return scene ? std::optional<Entrypoint>(std::move(*scene)) : std::nullopt;
    }
    if (*kind == "dialogue") {
        decoder.object(value, pointer, {"dialogue", "kind"});
        const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
        auto dialogue =
            dialogue_value
                ? decode_reference<DialogueId>(decoder, *dialogue_value,
                                               pointer_child(pointer, "dialogue"), "dialogue")
                : std::nullopt;
        return dialogue ? std::optional<Entrypoint>(std::move(*dialogue)) : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown entrypoint variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<Localization> decode_localization(Decoder& decoder, const nlohmann::json& value,
                                                std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"catalogs", "defaultLocale", "fallbackLocale"}))
        return std::nullopt;
    const auto* default_value = decoder.member(value, "defaultLocale", pointer);
    const auto* fallback_value = decoder.member(value, "fallbackLocale", pointer);
    const auto* catalogs_value = decoder.member(value, "catalogs", pointer);
    auto default_locale =
        default_value
            ? decoder.string(*default_value, pointer_child(pointer, "defaultLocale"), false, true)
            : std::nullopt;
    std::optional<std::string> fallback;
    bool fallback_ok = fallback_value != nullptr;
    if (fallback_value && !fallback_value->is_null()) {
        fallback =
            decoder.string(*fallback_value, pointer_child(pointer, "fallbackLocale"), false, true);
        fallback_ok = fallback.has_value();
    }
    auto catalogs =
        catalogs_value
            ? decoder.array<LocalizationCatalog>(
                  *catalogs_value, pointer_child(pointer, "catalogs"),
                  [&](const nlohmann::json& catalog,
                      const std::string& catalog_pointer) -> std::optional<LocalizationCatalog> {
                      if (!decoder.object(catalog, catalog_pointer, {"entries", "locale"}))
                          return std::nullopt;
                      const auto* locale_value = decoder.member(catalog, "locale", catalog_pointer);
                      const auto* entries_value =
                          decoder.member(catalog, "entries", catalog_pointer);
                      auto locale = locale_value
                                        ? decoder.string(*locale_value,
                                                         pointer_child(catalog_pointer, "locale"),
                                                         false, true)
                                        : std::nullopt;
                      auto entries =
                          entries_value
                              ? decoder.array<LocalizationEntry>(
                                    *entries_value, pointer_child(catalog_pointer, "entries"),
                                    [&](const nlohmann::json& entry,
                                        const std::string& entry_pointer)
                                        -> std::optional<LocalizationEntry> {
                                        if (!decoder.object(entry, entry_pointer, {"key", "value"}))
                                            return std::nullopt;
                                        const auto* key_value =
                                            decoder.member(entry, "key", entry_pointer);
                                        const auto* text_value =
                                            decoder.member(entry, "value", entry_pointer);
                                        auto key =
                                            key_value
                                                ? decoder.string(
                                                      *key_value,
                                                      pointer_child(entry_pointer, "key"), true)
                                                : std::nullopt;
                                        auto text = text_value
                                                        ? decoder.string(
                                                              *text_value,
                                                              pointer_child(entry_pointer, "value"))
                                                        : std::nullopt;
                                        if (key && text)
                                            return LocalizationEntry{std::move(*key),
                                                                     std::move(*text)};
                                        return std::nullopt;
                                    })
                              : std::nullopt;
                      if (entries) {
                          std::unordered_set<std::string> keys;
                          for (std::size_t index = 0; index < entries->size(); ++index) {
                              if (!keys.insert((*entries)[index].key).second)
                                  decoder.error(
                                      k_code_duplicate,
                                      "Duplicate localization key '" + (*entries)[index].key + "'.",
                                      pointer_child(
                                          pointer_index(pointer_child(catalog_pointer, "entries"),
                                                        index),
                                          "key"));
                          }
                      }
                      if (locale && entries)
                          return LocalizationCatalog{std::move(*locale), std::move(*entries)};
                      return std::nullopt;
                  })
            : std::nullopt;
    if (catalogs) {
        std::unordered_set<std::string> locales;
        for (std::size_t index = 0; index < catalogs->size(); ++index) {
            if (!locales.insert((*catalogs)[index].locale).second)
                decoder.error(
                    k_code_duplicate,
                    "Duplicate localization locale '" + (*catalogs)[index].locale + "'.",
                    pointer_child(pointer_index(pointer_child(pointer, "catalogs"), index),
                                  "locale"));
        }
    }
    if (!default_locale || !fallback_ok || !catalogs)
        return std::nullopt;
    return Localization{std::move(*default_locale), std::move(fallback), std::move(*catalogs)};
}

std::optional<RuntimeSettings> decode_settings(Decoder& decoder, const nlohmann::json& value,
                                               std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"display", "systemLayouts", "text", "titleScreen"}))
        return std::nullopt;
    const auto* display_value = decoder.member(value, "display", pointer);
    const auto* layouts_value = decoder.member(value, "systemLayouts", pointer);
    const auto* text_value = decoder.member(value, "text", pointer);
    const auto* title_value = decoder.member(value, "titleScreen", pointer);
    std::optional<DisplaySettings> display;
    if (display_value && decoder.object(*display_value, pointer_child(pointer, "display"),
                                        {"aspectRatio", "barColor", "orientation"})) {
        const auto display_pointer = pointer_child(pointer, "display");
        const auto* ratio_value = decoder.member(*display_value, "aspectRatio", display_pointer);
        const auto* bar_value = decoder.member(*display_value, "barColor", display_pointer);
        const auto* orientation_value =
            decoder.member(*display_value, "orientation", display_pointer);
        std::optional<AspectRatio> ratio;
        if (ratio_value &&
            decoder.object(*ratio_value, pointer_child(display_pointer, "aspectRatio"),
                           {"height", "width"})) {
            const auto ratio_pointer = pointer_child(display_pointer, "aspectRatio");
            const auto* height_value = decoder.member(*ratio_value, "height", ratio_pointer);
            const auto* width_value = decoder.member(*ratio_value, "width", ratio_pointer);
            auto height = height_value
                              ? decoder.unsigned_integer<std::uint32_t>(
                                    *height_value, pointer_child(ratio_pointer, "height"), true)
                              : std::nullopt;
            auto width = width_value
                             ? decoder.unsigned_integer<std::uint32_t>(
                                   *width_value, pointer_child(ratio_pointer, "width"), true)
                             : std::nullopt;
            if (height && width)
                ratio = AspectRatio{*width, *height};
        }
        auto bar = bar_value
                       ? decoder.string(*bar_value, pointer_child(display_pointer, "barColor"))
                       : std::nullopt;
        auto orientation = orientation_value ? decoder.enumeration<DisplayOrientation>(
                                                   *orientation_value,
                                                   pointer_child(display_pointer, "orientation"),
                                                   {{"landscape", DisplayOrientation::Landscape},
                                                    {"portrait", DisplayOrientation::Portrait}})
                                             : std::nullopt;
        if (ratio && bar && orientation)
            display = DisplaySettings{std::move(*ratio), std::move(*bar), *orientation};
    }
    auto layouts =
        layouts_value
            ? decoder.array<SystemLayout>(
                  *layouts_value, pointer_child(pointer, "systemLayouts"),
                  [&](const nlohmann::json& layout,
                      const std::string& item_pointer) -> std::optional<SystemLayout> {
                      if (!decoder.object(layout, item_pointer, {"layout", "role"}))
                          return std::nullopt;
                      const auto* role_value = decoder.member(layout, "role", item_pointer);
                      const auto* id_value = decoder.member(layout, "layout", item_pointer);
                      auto role = role_value
                                      ? decoder.enumeration<SystemLayoutRole>(
                                            *role_value, pointer_child(item_pointer, "role"),
                                            {{"title", SystemLayoutRole::Title},
                                             {"game-hud", SystemLayoutRole::GameHud},
                                             {"pause-menu", SystemLayoutRole::PauseMenu},
                                             {"load-menu", SystemLayoutRole::LoadMenu},
                                             {"settings-menu", SystemLayoutRole::SettingsMenu},
                                             {"modal", SystemLayoutRole::Modal},
                                             {"debug-overlay", SystemLayoutRole::DebugOverlay}})
                                      : std::nullopt;
                      std::optional<LayoutId> id;
                      bool id_ok = id_value != nullptr;
                      if (id_value && !id_value->is_null()) {
                          id = decode_reference<LayoutId>(
                              decoder, *id_value, pointer_child(item_pointer, "layout"), "layout");
                          id_ok = id.has_value();
                      }
                      return role && id_ok
                                 ? std::optional<SystemLayout>(SystemLayout{*role, std::move(id)})
                                 : std::nullopt;
                  })
            : std::nullopt;
    std::optional<TextSettings> text;
    if (text_value &&
        decoder.object(*text_value, pointer_child(pointer, "text"), {"defaultFont"})) {
        const auto text_pointer = pointer_child(pointer, "text");
        const auto* font_value = decoder.member(*text_value, "defaultFont", text_pointer);
        std::optional<AssetId> font;
        bool font_ok = font_value != nullptr;
        if (font_value && !font_value->is_null()) {
            font = decode_reference<AssetId>(decoder, *font_value,
                                             pointer_child(text_pointer, "defaultFont"), "asset");
            font_ok = font.has_value();
        }
        if (font_ok)
            text = TextSettings{std::move(font)};
    }
    std::optional<TitleScreenSettings> title;
    if (title_value && decoder.object(*title_value, pointer_child(pointer, "titleScreen"),
                                      {"showAuthor", "showProjectTitle", "startLabel", "subtitle",
                                       "titleImage"})) {
        const auto title_pointer = pointer_child(pointer, "titleScreen");
        const auto* show_author_value = decoder.member(*title_value, "showAuthor", title_pointer);
        const auto* show_title_value =
            decoder.member(*title_value, "showProjectTitle", title_pointer);
        const auto* start_value = decoder.member(*title_value, "startLabel", title_pointer);
        const auto* subtitle_value = decoder.member(*title_value, "subtitle", title_pointer);
        const auto* image_value = decoder.member(*title_value, "titleImage", title_pointer);
        auto show_author =
            show_author_value
                ? decoder.boolean(*show_author_value, pointer_child(title_pointer, "showAuthor"))
                : std::nullopt;
        auto show_title = show_title_value
                              ? decoder.boolean(*show_title_value,
                                                pointer_child(title_pointer, "showProjectTitle"))
                              : std::nullopt;
        auto start = start_value ? decoder.string(*start_value,
                                                  pointer_child(title_pointer, "startLabel"), true)
                                 : std::nullopt;
        auto subtitle = subtitle_value ? decoder.string(*subtitle_value,
                                                        pointer_child(title_pointer, "subtitle"))
                                       : std::nullopt;
        std::optional<AssetId> image;
        bool image_ok = image_value != nullptr;
        if (image_value && !image_value->is_null()) {
            image = decode_reference<AssetId>(decoder, *image_value,
                                              pointer_child(title_pointer, "titleImage"), "asset");
            image_ok = image.has_value();
        }
        if (show_author && show_title && start && subtitle && image_ok)
            title = TitleScreenSettings{*show_author, *show_title, std::move(*start),
                                        std::move(*subtitle), std::move(image)};
    }
    if (!display || !layouts || !text || !title)
        return std::nullopt;
    return RuntimeSettings{std::move(*display), std::move(*layouts), std::move(*text),
                           std::move(*title)};
}

std::optional<VariableDeclaration> decode_variable(Decoder& decoder, const nlohmann::json& value,
                                                   std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"defaultValue", "enumValues", "id", "type"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* type_value = decoder.member(value, "type", pointer);
    const auto* enum_value = decoder.member(value, "enumValues", pointer);
    const auto* default_value = decoder.member(value, "defaultValue", pointer);
    auto id =
        id_value ? decoder.id<VariableId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    std::vector<std::string> enum_values;
    auto type = type_value && enum_value
                    ? decode_value_type(decoder, *type_value, *enum_value, pointer, enum_values)
                    : std::nullopt;
    auto default_runtime = default_value
                               ? decode_runtime_value(decoder, *default_value,
                                                      pointer_child(pointer, "defaultValue"), false)
                               : std::nullopt;
    if (!id || !type || !default_runtime)
        return std::nullopt;
    return VariableDeclaration{std::move(*id), std::move(*type), std::move(*default_runtime),
                               std::move(enum_values)};
}

std::optional<PropertyDeclaration> decode_property(Decoder& decoder, const nlohmann::json& value,
                                                   std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"defaultValue", "description", "enumValues", "id", "label", "nullable",
                         "ownerKinds", "persistence", "type"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* type_value = decoder.member(value, "type", pointer);
    const auto* enum_value = decoder.member(value, "enumValues", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    const auto* label_value = decoder.member(value, "label", pointer);
    const auto* nullable_value = decoder.member(value, "nullable", pointer);
    const auto* owners_value = decoder.member(value, "ownerKinds", pointer);
    const auto* persistence_value = decoder.member(value, "persistence", pointer);
    auto id =
        id_value ? decoder.id<PropertyId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    std::vector<std::string> enum_values;
    auto type = type_value && enum_value
                    ? decode_value_type(decoder, *type_value, *enum_value, pointer, enum_values)
                    : std::nullopt;
    auto description = description_value ? decoder.string(*description_value,
                                                          pointer_child(pointer, "description"))
                                         : std::nullopt;
    auto label = label_value ? decoder.string(*label_value, pointer_child(pointer, "label"), true)
                             : std::nullopt;
    auto nullable = nullable_value
                        ? decoder.boolean(*nullable_value, pointer_child(pointer, "nullable"))
                        : std::nullopt;
    auto owners = owners_value
                      ? decoder.array<PropertyOwnerKind>(
                            *owners_value, pointer_child(pointer, "ownerKinds"),
                            [&](const nlohmann::json& owner, const std::string& owner_pointer) {
                                return decoder.enumeration<PropertyOwnerKind>(
                                    owner, owner_pointer,
                                    {{"room", PropertyOwnerKind::Room},
                                     {"scene", PropertyOwnerKind::Scene},
                                     {"dialogue", PropertyOwnerKind::Dialogue},
                                     {"character", PropertyOwnerKind::Character},
                                     {"interactable", PropertyOwnerKind::Interactable},
                                     {"verb", PropertyOwnerKind::Verb},
                                     {"interaction", PropertyOwnerKind::Interaction},
                                     {"map", PropertyOwnerKind::Map}});
                            })
                      : std::nullopt;
    auto persistence =
        persistence_value
            ? decoder.enumeration<PropertyPersistence>(
                  *persistence_value, pointer_child(pointer, "persistence"),
                  {{"Session", PropertyPersistence::Session}, {"Save", PropertyPersistence::Save}})
            : std::nullopt;
    std::optional<RuntimeValue> default_runtime;
    bool default_ok = true;
    if (const auto* default_value = json_access::member(value, "defaultValue")) {
        default_runtime =
            decode_runtime_value(decoder, *default_value, pointer_child(pointer, "defaultValue"));
        default_ok = default_runtime.has_value();
    }
    if (!id || !type || !description || !label || !nullable || !owners || !persistence ||
        !default_ok)
        return std::nullopt;
    return PropertyDeclaration{
        std::move(*id),         std::move(*type),   *nullable,    std::move(default_runtime),
        std::move(enum_values), std::move(*owners), *persistence, std::move(*label),
        std::move(*description)};
}

std::optional<AssetResource> decode_asset(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"aliases", "id", "kind", "path"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* path_value = decoder.member(value, "path", pointer);
    const auto* aliases_value = decoder.member(value, "aliases", pointer);
    auto id =
        id_value ? decoder.id<AssetId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto kind = kind_value
                    ? decoder.enumeration<AssetKind>(*kind_value, pointer_child(pointer, "kind"),
                                                     {{"image", AssetKind::Image},
                                                      {"font", AssetKind::Font},
                                                      {"audio", AssetKind::Audio},
                                                      {"script", AssetKind::Script},
                                                      {"shader-source", AssetKind::ShaderSource},
                                                      {"text", AssetKind::Text},
                                                      {"data", AssetKind::Data},
                                                      {"binary", AssetKind::Binary}})
                    : std::nullopt;
    auto path = path_value ? decoder.string(*path_value, pointer_child(pointer, "path"), true)
                           : std::nullopt;
    auto aliases = aliases_value
                       ? decoder.array<std::string>(
                             *aliases_value, pointer_child(pointer, "aliases"),
                             [&](const nlohmann::json& alias, const std::string& alias_pointer) {
                                 return decoder.string(alias, alias_pointer, true);
                             })
                       : std::nullopt;
    if (!id || !kind || !path || !aliases)
        return std::nullopt;
    return AssetResource{std::move(*id), *kind, std::move(*path), std::move(*aliases)};
}

std::optional<LayoutResource> decode_layout(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!decoder.object(
            value, pointer,
            {"dependencies", "id", "kind", "lua", "mount", "rcss", "rml", "script", "target"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* target_value = decoder.member(value, "target", pointer);
    const auto* rml_value = decoder.member(value, "rml", pointer);
    const auto* rcss_value = decoder.member(value, "rcss", pointer);
    const auto* lua_value = decoder.member(value, "lua", pointer);
    const auto* dependencies_value = decoder.member(value, "dependencies", pointer);
    const auto* mount_value = decoder.member(value, "mount", pointer);
    const auto* script_value = decoder.member(value, "script", pointer);
    auto id =
        id_value ? decoder.id<LayoutId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto kind = kind_value
                    ? decoder.enumeration<LayoutKind>(
                          *kind_value, pointer_child(pointer, "kind"),
                          {{"document", LayoutKind::Document}, {"fragment", LayoutKind::Fragment}})
                    : std::nullopt;
    auto target =
        target_value
            ? decoder.enumeration<LayoutTarget>(*target_value, pointer_child(pointer, "target"),
                                                {{"default-ui", LayoutTarget::DefaultUi},
                                                 {"dialogue-ui", LayoutTarget::DialogueUi},
                                                 {"scene-overlay", LayoutTarget::SceneOverlay},
                                                 {"room-overlay", LayoutTarget::RoomOverlay},
                                                 {"menu-ui", LayoutTarget::MenuUi},
                                                 {"custom-overlay", LayoutTarget::CustomOverlay}})
            : std::nullopt;
    auto rml = rml_value ? decode_layout_source(decoder, *rml_value, pointer_child(pointer, "rml"))
                         : std::nullopt;
    auto rcss = rcss_value
                    ? decode_layout_source(decoder, *rcss_value, pointer_child(pointer, "rcss"))
                    : std::nullopt;
    auto lua = lua_value ? decode_layout_source(decoder, *lua_value, pointer_child(pointer, "lua"))
                         : std::nullopt;
    std::optional<LayoutDependencies> dependencies;
    if (dependencies_value &&
        decoder.object(*dependencies_value, pointer_child(pointer, "dependencies"),
                       {"fonts", "images", "materials", "scripts", "stylesheets"})) {
        const auto dependency_pointer = pointer_child(pointer, "dependencies");
        auto decode_assets = [&](std::string_view key) -> std::optional<std::vector<AssetId>> {
            const auto* collection = decoder.member(*dependencies_value, key, dependency_pointer);
            return collection
                       ? decoder.array<AssetId>(
                             *collection, pointer_child(dependency_pointer, key),
                             [&](const nlohmann::json& reference, const std::string& item_pointer) {
                                 return decode_reference<AssetId>(decoder, reference, item_pointer,
                                                                  "asset");
                             })
                       : std::nullopt;
        };
        auto fonts = decode_assets("fonts");
        auto images = decode_assets("images");
        auto scripts = decode_assets("scripts");
        auto stylesheets = decode_assets("stylesheets");
        const auto* material_collection =
            decoder.member(*dependencies_value, "materials", dependency_pointer);
        auto materials =
            material_collection
                ? decoder.array<MaterialId>(
                      *material_collection, pointer_child(dependency_pointer, "materials"),
                      [&](const nlohmann::json& reference, const std::string& item_pointer) {
                          return decode_reference<MaterialId>(decoder, reference, item_pointer,
                                                              "material");
                      })
                : std::nullopt;
        if (fonts && images && materials && scripts && stylesheets)
            dependencies =
                LayoutDependencies{std::move(*fonts), std::move(*images), std::move(*materials),
                                   std::move(*scripts), std::move(*stylesheets)};
    }
    std::optional<std::string> default_parent;
    std::optional<bool> scoped_styles;
    bool mount_ok = false;
    if (mount_value && decoder.object(*mount_value, pointer_child(pointer, "mount"),
                                      {"defaultParent", "scopedStyles"})) {
        const auto mount_pointer = pointer_child(pointer, "mount");
        const auto* parent_value = decoder.member(*mount_value, "defaultParent", mount_pointer);
        const auto* scoped_value = decoder.member(*mount_value, "scopedStyles", mount_pointer);
        bool parent_ok = parent_value != nullptr;
        if (parent_value && !parent_value->is_null()) {
            default_parent =
                decoder.string(*parent_value, pointer_child(mount_pointer, "defaultParent"));
            parent_ok = default_parent.has_value();
        }
        scoped_styles = scoped_value ? decoder.boolean(*scoped_value,
                                                       pointer_child(mount_pointer, "scopedStyles"))
                                     : std::nullopt;
        mount_ok = parent_ok && scoped_styles.has_value();
    }
    std::optional<bool> script_enabled;
    std::optional<std::string> script_namespace;
    bool script_ok = false;
    if (script_value &&
        decoder.object(*script_value, pointer_child(pointer, "script"), {"enabled", "namespace"})) {
        const auto script_pointer = pointer_child(pointer, "script");
        const auto* enabled_value = decoder.member(*script_value, "enabled", script_pointer);
        const auto* namespace_value = decoder.member(*script_value, "namespace", script_pointer);
        script_enabled = enabled_value ? decoder.boolean(*enabled_value,
                                                         pointer_child(script_pointer, "enabled"))
                                       : std::nullopt;
        bool namespace_ok = namespace_value != nullptr;
        if (namespace_value && !namespace_value->is_null()) {
            script_namespace =
                decoder.string(*namespace_value, pointer_child(script_pointer, "namespace"));
            namespace_ok = script_namespace.has_value();
        }
        script_ok = script_enabled.has_value() && namespace_ok;
    }
    if (!id || !kind || !target || !rml || !rcss || !lua || !dependencies || !mount_ok ||
        !script_ok)
        return std::nullopt;
    return LayoutResource{std::move(*id),
                          *kind,
                          *target,
                          std::move(*rml),
                          std::move(*rcss),
                          std::move(*lua),
                          std::move(*dependencies),
                          std::move(default_parent),
                          *scoped_styles,
                          *script_enabled,
                          std::move(script_namespace)};
}

std::optional<ScriptResource> decode_script(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"id", "source"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* source_value = decoder.member(value, "source", pointer);
    auto id =
        id_value ? decoder.id<ScriptId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto source = source_value ? decode_script_source(decoder, *source_value,
                                                      pointer_child(pointer, "source"))
                               : std::nullopt;
    return id && source
               ? std::optional<ScriptResource>(ScriptResource{std::move(*id), std::move(*source)})
               : std::nullopt;
}

std::optional<CharacterDefinition> decode_character(Decoder& decoder, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"defaults", "dialogue", "displayName", "expressions", "extends", "id",
                         "poses", "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<CharacterId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
    const auto* defaults_value = decoder.member(value, "defaults", pointer);
    const auto* poses_value = decoder.member(value, "poses", pointer);
    const auto* expressions_value = decoder.member(value, "expressions", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    std::optional<CharacterDialoguePresentation> dialogue;
    if (dialogue_value && decoder.object(*dialogue_value, pointer_child(pointer, "dialogue"),
                                         {"name", "nameColor", "styleClass", "textColor"})) {
        const auto dialogue_pointer = pointer_child(pointer, "dialogue");
        const auto* name_value = decoder.member(*dialogue_value, "name", dialogue_pointer);
        const auto* name_color_value =
            decoder.member(*dialogue_value, "nameColor", dialogue_pointer);
        const auto* style_value = decoder.member(*dialogue_value, "styleClass", dialogue_pointer);
        const auto* text_color_value =
            decoder.member(*dialogue_value, "textColor", dialogue_pointer);
        auto name = name_value
                        ? decoder.string(*name_value, pointer_child(dialogue_pointer, "name"))
                        : std::nullopt;
        auto style = style_value ? decoder.string(*style_value,
                                                  pointer_child(dialogue_pointer, "styleClass"))
                                 : std::nullopt;
        std::optional<std::string> name_color;
        bool name_color_ok = name_color_value != nullptr;
        if (name_color_value && !name_color_value->is_null()) {
            name_color =
                decoder.string(*name_color_value, pointer_child(dialogue_pointer, "nameColor"));
            name_color_ok = name_color.has_value();
        }
        std::optional<std::string> text_color;
        bool text_color_ok = text_color_value != nullptr;
        if (text_color_value && !text_color_value->is_null()) {
            text_color =
                decoder.string(*text_color_value, pointer_child(dialogue_pointer, "textColor"));
            text_color_ok = text_color.has_value();
        }
        if (name && style && name_color_ok && text_color_ok)
            dialogue = CharacterDialoguePresentation{std::move(*name), std::move(name_color),
                                                     std::move(*style), std::move(text_color)};
    }
    std::optional<CharacterDefaults> defaults;
    if (defaults_value && decoder.object(*defaults_value, pointer_child(pointer, "defaults"),
                                         {"expressionId", "poseId"})) {
        const auto defaults_pointer = pointer_child(pointer, "defaults");
        const auto* expression_value =
            decoder.member(*defaults_value, "expressionId", defaults_pointer);
        const auto* pose_value = decoder.member(*defaults_value, "poseId", defaults_pointer);
        auto expression =
            expression_value
                ? decoder.id<CharacterExpressionId>(*expression_value,
                                                    pointer_child(defaults_pointer, "expressionId"))
                : std::nullopt;
        auto pose = pose_value ? decoder.id<CharacterPoseId>(
                                     *pose_value, pointer_child(defaults_pointer, "poseId"))
                               : std::nullopt;
        if (expression && pose)
            defaults = CharacterDefaults{std::move(*expression), std::move(*pose)};
    }
    auto poses =
        poses_value
            ? decoder.array<CharacterPose>(
                  *poses_value, pointer_child(pointer, "poses"),
                  [&](const nlohmann::json& pose,
                      const std::string& pose_pointer) -> std::optional<CharacterPose> {
                      if (!decoder.object(
                              pose, pose_pointer,
                              {"anchor", "id", "material", "offset", "scale", "sprite"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(pose, "id", pose_pointer);
                      const auto* anchor_value = decoder.member(pose, "anchor", pose_pointer);
                      const auto* offset_value = decoder.member(pose, "offset", pose_pointer);
                      const auto* scale_value = decoder.member(pose, "scale", pose_pointer);
                      const auto* material_value = decoder.member(pose, "material", pose_pointer);
                      const auto* sprite_value = decoder.member(pose, "sprite", pose_pointer);
                      auto id = id_value ? decoder.id<CharacterPoseId>(
                                               *id_value, pointer_child(pose_pointer, "id"))
                                         : std::nullopt;
                      auto anchor = anchor_value
                                        ? decode_vector2(decoder, *anchor_value,
                                                         pointer_child(pose_pointer, "anchor"))
                                        : std::nullopt;
                      auto offset = offset_value
                                        ? decode_vector2(decoder, *offset_value,
                                                         pointer_child(pose_pointer, "offset"))
                                        : std::nullopt;
                      auto scale = scale_value
                                       ? decoder.finite_number(*scale_value,
                                                               pointer_child(pose_pointer, "scale"))
                                       : std::nullopt;
                      if (scale && *scale <= 0.0) {
                          decoder.error(k_code_number, "Scale must be positive.",
                                        pointer_child(pose_pointer, "scale"));
                          scale.reset();
                      }
                      std::optional<MaterialId> material;
                      bool material_ok = material_value != nullptr;
                      if (material_value && !material_value->is_null()) {
                          material = decode_reference<MaterialId>(
                              decoder, *material_value, pointer_child(pose_pointer, "material"),
                              "material");
                          material_ok = material.has_value();
                      }
                      std::optional<AssetId> sprite;
                      bool sprite_ok = sprite_value != nullptr;
                      if (sprite_value && !sprite_value->is_null()) {
                          sprite = decode_reference<AssetId>(decoder, *sprite_value,
                                                             pointer_child(pose_pointer, "sprite"),
                                                             "asset");
                          sprite_ok = sprite.has_value();
                      }
                      if (id && anchor && offset && scale && material_ok && sprite_ok)
                          return CharacterPose{std::move(*id),
                                               std::move(*anchor),
                                               std::move(material),
                                               std::move(*offset),
                                               *scale,
                                               std::move(sprite)};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto expressions =
        expressions_value
            ? decoder.array<CharacterExpression>(
                  *expressions_value, pointer_child(pointer, "expressions"),
                  [&](const nlohmann::json& expression,
                      const std::string& expression_pointer) -> std::optional<CharacterExpression> {
                      if (!decoder.object(expression, expression_pointer,
                                          {"id", "material", "poseId", "sprite"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(expression, "id", expression_pointer);
                      const auto* material_value =
                          decoder.member(expression, "material", expression_pointer);
                      const auto* pose_value =
                          decoder.member(expression, "poseId", expression_pointer);
                      const auto* sprite_value =
                          decoder.member(expression, "sprite", expression_pointer);
                      auto id = id_value ? decoder.id<CharacterExpressionId>(
                                               *id_value, pointer_child(expression_pointer, "id"))
                                         : std::nullopt;
                      std::optional<MaterialId> material;
                      bool material_ok = material_value != nullptr;
                      if (material_value && !material_value->is_null()) {
                          material = decode_reference<MaterialId>(
                              decoder, *material_value,
                              pointer_child(expression_pointer, "material"), "material");
                          material_ok = material.has_value();
                      }
                      std::optional<CharacterPoseId> pose;
                      bool pose_ok = pose_value != nullptr;
                      if (pose_value && !pose_value->is_null()) {
                          pose = decoder.id<CharacterPoseId>(
                              *pose_value, pointer_child(expression_pointer, "poseId"));
                          pose_ok = pose.has_value();
                      }
                      std::optional<AssetId> sprite;
                      bool sprite_ok = sprite_value != nullptr;
                      if (sprite_value && !sprite_value->is_null()) {
                          sprite = decode_reference<AssetId>(
                              decoder, *sprite_value, pointer_child(expression_pointer, "sprite"),
                              "asset");
                          sprite_ok = sprite.has_value();
                      }
                      if (id && material_ok && pose_ok && sprite_ok)
                          return CharacterExpression{std::move(*id), std::move(material),
                                                     std::move(pose), std::move(sprite)};
                      return std::nullopt;
                  })
            : std::nullopt;
    if (poses)
        decoder.duplicate_ids(
            *poses, pointer_child(pointer, "poses"),
            [](const CharacterPose& pose) -> const CharacterPoseId& { return pose.id; });
    if (expressions)
        decoder.duplicate_ids(
            *expressions, pointer_child(pointer, "expressions"),
            [](const CharacterExpression& expression) -> const CharacterExpressionId& {
                return expression.id;
            });
    if (!identity || !display || !dialogue || !defaults || !poses || !expressions)
        return std::nullopt;
    return CharacterDefinition{std::move(*identity), std::move(*display), std::move(*dialogue),
                               std::move(*defaults), std::move(*poses),   std::move(*expressions)};
}

std::optional<RoomDefinition> decode_room(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"background", "description", "displayName", "exits", "extends", "id",
                         "lifecycle", "overlays", "placements", "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<RoomId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    const auto* background_value = decoder.member(value, "background", pointer);
    const auto* lifecycle_value = decoder.member(value, "lifecycle", pointer);
    const auto* overlays_value = decoder.member(value, "overlays", pointer);
    const auto* placements_value = decoder.member(value, "placements", pointer);
    const auto* exits_value = decoder.member(value, "exits", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto description = description_value ? decode_text(decoder, *description_value,
                                                       pointer_child(pointer, "description"))
                                         : std::nullopt;
    auto background = background_value ? decode_background(decoder, *background_value,
                                                           pointer_child(pointer, "background"))
                                       : std::nullopt;
    std::optional<RoomLifecycle> lifecycle;
    if (lifecycle_value && decoder.object(*lifecycle_value, pointer_child(pointer, "lifecycle"),
                                          {"canEnter", "canLeave", "hooks"})) {
        const auto lifecycle_pointer = pointer_child(pointer, "lifecycle");
        const auto* enter_value = decoder.member(*lifecycle_value, "canEnter", lifecycle_pointer);
        const auto* leave_value = decoder.member(*lifecycle_value, "canLeave", lifecycle_pointer);
        const auto* hooks_value = decoder.member(*lifecycle_value, "hooks", lifecycle_pointer);
        auto enter = enter_value
                         ? decode_condition_impl(decoder, *enter_value,
                                                 pointer_child(lifecycle_pointer, "canEnter"))
                         : std::nullopt;
        auto leave = leave_value
                         ? decode_condition_impl(decoder, *leave_value,
                                                 pointer_child(lifecycle_pointer, "canLeave"))
                         : std::nullopt;
        if (hooks_value && !hooks_value->is_array())
            decoder.error(k_code_type, "Expected an array.",
                          pointer_child(lifecycle_pointer, "hooks"));
        if (enter && leave && hooks_value && hooks_value->is_array())
            lifecycle = RoomLifecycle{std::move(*enter), std::move(*leave)};
    }
    auto overlays =
        overlays_value
            ? decoder.array<RoomOverlay>(
                  *overlays_value, pointer_child(pointer, "overlays"),
                  [&](const nlohmann::json& overlay,
                      const std::string& item_pointer) -> std::optional<RoomOverlay> {
                      if (!decoder.object(overlay, item_pointer, {"enabled", "id", "layout"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(overlay, "id", item_pointer);
                      const auto* enabled_value = decoder.member(overlay, "enabled", item_pointer);
                      const auto* layout_value = decoder.member(overlay, "layout", item_pointer);
                      auto id = id_value ? decoder.id<RoomOverlayId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto enabled = enabled_value
                                         ? decoder.boolean(*enabled_value,
                                                           pointer_child(item_pointer, "enabled"))
                                         : std::nullopt;
                      auto layout = layout_value
                                        ? decode_reference<LayoutId>(
                                              decoder, *layout_value,
                                              pointer_child(item_pointer, "layout"), "layout")
                                        : std::nullopt;
                      if (id && enabled && layout)
                          return RoomOverlay{std::move(*id), *enabled, std::move(*layout)};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto placements =
        placements_value
            ? decoder.array<RoomPlacement>(
                  *placements_value, pointer_child(pointer, "placements"),
                  [&](const nlohmann::json& placement,
                      const std::string& item_pointer) -> std::optional<RoomPlacement> {
                      if (!decoder.object(placement, item_pointer,
                                          {"bounds", "id", "interactable", "presentation"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(placement, "id", item_pointer);
                      const auto* interactable_value =
                          decoder.member(placement, "interactable", item_pointer);
                      const auto* bounds_value = decoder.member(placement, "bounds", item_pointer);
                      const auto* presentation_value =
                          decoder.member(placement, "presentation", item_pointer);
                      auto id = id_value ? decoder.id<RoomPlacementId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto interactable =
                          interactable_value
                              ? decode_reference<InteractableId>(
                                    decoder, *interactable_value,
                                    pointer_child(item_pointer, "interactable"), "interactable")
                              : std::nullopt;
                      auto bounds = bounds_value
                                        ? decode_rect(decoder, *bounds_value,
                                                      pointer_child(item_pointer, "bounds"))
                                        : std::nullopt;
                      std::optional<RoomPlacementPresentation> presentation;
                      if (presentation_value &&
                          decoder.object(*presentation_value,
                                         pointer_child(item_pointer, "presentation"),
                                         {"label", "layout"})) {
                          const auto presentation_pointer =
                              pointer_child(item_pointer, "presentation");
                          const auto* label_value =
                              decoder.member(*presentation_value, "label", presentation_pointer);
                          const auto* layout_value =
                              decoder.member(*presentation_value, "layout", presentation_pointer);
                          std::optional<TextContent> label;
                          bool label_ok = label_value != nullptr;
                          if (label_value && !label_value->is_null()) {
                              label = decode_text(decoder, *label_value,
                                                  pointer_child(presentation_pointer, "label"));
                              label_ok = label.has_value();
                          }
                          std::optional<LayoutId> layout;
                          bool layout_ok = layout_value != nullptr;
                          if (layout_value && !layout_value->is_null()) {
                              layout = decode_reference<LayoutId>(
                                  decoder, *layout_value,
                                  pointer_child(presentation_pointer, "layout"), "layout");
                              layout_ok = layout.has_value();
                          }
                          if (label_ok && layout_ok)
                              presentation =
                                  RoomPlacementPresentation{std::move(label), std::move(layout)};
                      }
                      if (id && interactable && bounds && presentation)
                          return RoomPlacement{std::move(*id), std::move(*interactable),
                                               std::move(*bounds), std::move(*presentation)};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto exits =
        exits_value
            ? decoder.array<RoomExit>(
                  *exits_value, pointer_child(pointer, "exits"),
                  [&](const nlohmann::json& exit,
                      const std::string& item_pointer) -> std::optional<RoomExit> {
                      if (!decoder.object(exit, item_pointer,
                                          {"condition", "direction", "id", "label", "target"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(exit, "id", item_pointer);
                      const auto* condition_value = decoder.member(exit, "condition", item_pointer);
                      const auto* direction_value = decoder.member(exit, "direction", item_pointer);
                      const auto* label_value = decoder.member(exit, "label", item_pointer);
                      const auto* target_value = decoder.member(exit, "target", item_pointer);
                      auto id = id_value ? decoder.id<RoomExitId>(*id_value,
                                                                  pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      auto condition =
                          condition_value
                              ? decode_condition_impl(decoder, *condition_value,
                                                      pointer_child(item_pointer, "condition"))
                              : std::nullopt;
                      auto direction =
                          direction_value
                              ? decoder.enumeration<RoomExitDirection>(
                                    *direction_value, pointer_child(item_pointer, "direction"),
                                    {{"northwest", RoomExitDirection::Northwest},
                                     {"north", RoomExitDirection::North},
                                     {"northeast", RoomExitDirection::Northeast},
                                     {"west", RoomExitDirection::West},
                                     {"east", RoomExitDirection::East},
                                     {"southwest", RoomExitDirection::Southwest},
                                     {"south", RoomExitDirection::South},
                                     {"southeast", RoomExitDirection::Southeast},
                                     {"custom", RoomExitDirection::Custom}})
                              : std::nullopt;
                      auto label = label_value ? decode_text(decoder, *label_value,
                                                             pointer_child(item_pointer, "label"))
                                               : std::nullopt;
                      auto target = target_value
                                        ? decode_reference<RoomId>(
                                              decoder, *target_value,
                                              pointer_child(item_pointer, "target"), "room")
                                        : std::nullopt;
                      if (id && condition && direction && label && target)
                          return RoomExit{std::move(*id), std::move(*condition), *direction,
                                          std::move(*label), std::move(*target)};
                      return std::nullopt;
                  })
            : std::nullopt;
    if (overlays)
        decoder.duplicate_ids(
            *overlays, pointer_child(pointer, "overlays"),
            [](const RoomOverlay& overlay) -> const RoomOverlayId& { return overlay.id; });
    if (placements)
        decoder.duplicate_ids(
            *placements, pointer_child(pointer, "placements"),
            [](const RoomPlacement& placement) -> const RoomPlacementId& { return placement.id; });
    if (exits)
        decoder.duplicate_ids(*exits, pointer_child(pointer, "exits"),
                              [](const RoomExit& exit) -> const RoomExitId& { return exit.id; });
    if (!identity || !display || !description || !background || !lifecycle || !overlays ||
        !placements || !exits)
        return std::nullopt;
    return RoomDefinition{std::move(*identity),   std::move(*display),   std::move(*description),
                          std::move(*background), std::move(*lifecycle), std::move(*overlays),
                          std::move(*placements), std::move(*exits)};
}

std::optional<InteractableDefinition>
decode_interactable(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"displayName", "extends", "id", "initialState", "presentation",
                         "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<InteractableId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* state_value = decoder.member(value, "initialState", pointer);
    const auto* presentation_value = decoder.member(value, "presentation", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    std::optional<InteractableInitialState> state;
    if (state_value && decoder.object(*state_value, pointer_child(pointer, "initialState"),
                                      {"enabled", "location", "visible"})) {
        const auto state_pointer = pointer_child(pointer, "initialState");
        const auto* enabled_value = decoder.member(*state_value, "enabled", state_pointer);
        const auto* location_value = decoder.member(*state_value, "location", state_pointer);
        const auto* visible_value = decoder.member(*state_value, "visible", state_pointer);
        auto enabled =
            enabled_value ? decoder.boolean(*enabled_value, pointer_child(state_pointer, "enabled"))
                          : std::nullopt;
        auto location = location_value ? decode_location(decoder, *location_value,
                                                         pointer_child(state_pointer, "location"))
                                       : std::nullopt;
        auto visible =
            visible_value ? decoder.boolean(*visible_value, pointer_child(state_pointer, "visible"))
                          : std::nullopt;
        if (enabled && location && visible)
            state = InteractableInitialState{*enabled, std::move(*location), *visible};
    }
    std::optional<InteractablePresentation> presentation;
    if (presentation_value &&
        decoder.object(*presentation_value, pointer_child(pointer, "presentation"),
                       {"material", "sprite"})) {
        const auto presentation_pointer = pointer_child(pointer, "presentation");
        const auto* material_value =
            decoder.member(*presentation_value, "material", presentation_pointer);
        const auto* sprite_value =
            decoder.member(*presentation_value, "sprite", presentation_pointer);
        std::optional<MaterialId> material;
        bool material_ok = material_value != nullptr;
        if (material_value && !material_value->is_null()) {
            material = decode_reference<MaterialId>(decoder, *material_value,
                                                    pointer_child(presentation_pointer, "material"),
                                                    "material");
            material_ok = material.has_value();
        }
        std::optional<AssetId> sprite;
        bool sprite_ok = sprite_value != nullptr;
        if (sprite_value && !sprite_value->is_null()) {
            sprite = decode_reference<AssetId>(
                decoder, *sprite_value, pointer_child(presentation_pointer, "sprite"), "asset");
            sprite_ok = sprite.has_value();
        }
        if (material_ok && sprite_ok)
            presentation = InteractablePresentation{std::move(material), std::move(sprite)};
    }
    if (!identity || !display || !state || !presentation)
        return std::nullopt;
    return InteractableDefinition{std::move(*identity), std::move(*display), std::move(*state),
                                  std::move(*presentation)};
}

std::optional<VerbDefinition> decode_verb(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"actionText", "arity", "availability", "defaultProgram", "extends", "id",
                         "operandRoles", "propertyAssignments", "quickAction"}))
        return std::nullopt;
    auto identity = decode_identity<VerbId>(decoder, value, pointer);
    const auto* action_value = decoder.member(value, "actionText", pointer);
    const auto* arity_value = decoder.member(value, "arity", pointer);
    const auto* availability_value = decoder.member(value, "availability", pointer);
    const auto* program_value = decoder.member(value, "defaultProgram", pointer);
    const auto* roles_value = decoder.member(value, "operandRoles", pointer);
    const auto* quick_value = decoder.member(value, "quickAction", pointer);
    auto action = action_value
                      ? decode_text(decoder, *action_value, pointer_child(pointer, "actionText"))
                      : std::nullopt;
    auto arity =
        arity_value
            ? decoder.unsigned_integer<std::uint8_t>(*arity_value, pointer_child(pointer, "arity"))
            : std::nullopt;
    if (arity && *arity > 2) {
        decoder.error(k_code_enum, "Verb arity must be 0, 1, or 2.",
                      pointer_child(pointer, "arity"));
        arity.reset();
    }
    auto roles = roles_value
                     ? decoder.array<std::string>(
                           *roles_value, pointer_child(pointer, "operandRoles"),
                           [&](const nlohmann::json& role, const std::string& item_pointer) {
                               return decoder.string(role, item_pointer, true);
                           })
                     : std::nullopt;
    if (roles && roles->size() > 2) {
        decoder.error(k_code_type, "At most two operand roles are allowed.",
                      pointer_child(pointer, "operandRoles"));
        roles.reset();
    }
    auto quick = quick_value ? decoder.boolean(*quick_value, pointer_child(pointer, "quickAction"))
                             : std::nullopt;
    if (availability_value && !availability_value->is_object())
        decoder.error(k_code_type, "Expected an object.", pointer_child(pointer, "availability"));
    if (program_value && !program_value->is_object())
        decoder.error(k_code_type, "Expected an object.", pointer_child(pointer, "defaultProgram"));
    if (!identity || !action || !arity || !roles || !quick || !availability_value ||
        !availability_value->is_object() || !program_value || !program_value->is_object())
        return std::nullopt;
    return VerbDefinition{std::move(*identity), std::move(*action), *arity, std::move(*roles),
                          *quick};
}

std::optional<InteractionDefinition>
decode_interaction(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"extends", "id", "propertyAssignments", "rules"}))
        return std::nullopt;
    auto identity = decode_identity<InteractionId>(decoder, value, pointer);
    const auto* rules_value = decoder.member(value, "rules", pointer);
    if (rules_value && !rules_value->is_array())
        decoder.error(k_code_type, "Expected an array.", pointer_child(pointer, "rules"));
    if (!identity || !rules_value || !rules_value->is_array())
        return std::nullopt;
    return InteractionDefinition{std::move(*identity)};
}

std::optional<SceneDefinition> decode_scene(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"continuation", "defaultBackground", "defaultLayout", "displayName",
                         "extends", "id", "program", "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<SceneId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* background_value = decoder.member(value, "defaultBackground", pointer);
    const auto* layout_value = decoder.member(value, "defaultLayout", pointer);
    const auto* program_value = decoder.member(value, "program", pointer);
    const auto* continuation_value = decoder.member(value, "continuation", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto background = background_value
                          ? decode_background(decoder, *background_value,
                                              pointer_child(pointer, "defaultBackground"))
                          : std::nullopt;
    std::optional<LayoutId> layout;
    bool layout_ok = layout_value != nullptr;
    if (layout_value && !layout_value->is_null()) {
        layout = decode_reference<LayoutId>(decoder, *layout_value,
                                            pointer_child(pointer, "defaultLayout"), "layout");
        layout_ok = layout.has_value();
    }
    if (program_value && !program_value->is_object())
        decoder.error(k_code_type, "Expected an object.", pointer_child(pointer, "program"));
    if (continuation_value && !continuation_value->is_object())
        decoder.error(k_code_type, "Expected an object.", pointer_child(pointer, "continuation"));
    if (!identity || !display || !background || !layout_ok || !program_value ||
        !program_value->is_object() || !continuation_value || !continuation_value->is_object())
        return std::nullopt;
    return SceneDefinition{std::move(*identity), std::move(*display), std::move(*background),
                           std::move(layout)};
}

std::optional<DialogueDefinition> decode_dialogue(Decoder& decoder, const nlohmann::json& value,
                                                  std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"completion", "defaultSpeaker", "displayName", "extends", "id", "program",
                         "propertyAssignments", "settings"}))
        return std::nullopt;
    auto identity = decode_identity<DialogueId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* speaker_value = decoder.member(value, "defaultSpeaker", pointer);
    const auto* settings_value = decoder.member(value, "settings", pointer);
    const auto* program_value = decoder.member(value, "program", pointer);
    const auto* completion_value = decoder.member(value, "completion", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    std::optional<CharacterId> speaker;
    bool speaker_ok = speaker_value != nullptr;
    if (speaker_value && !speaker_value->is_null()) {
        speaker = decode_reference<CharacterId>(
            decoder, *speaker_value, pointer_child(pointer, "defaultSpeaker"), "character");
        speaker_ok = speaker.has_value();
    }
    std::optional<DialogueSettings> settings;
    if (settings_value && decoder.object(*settings_value, pointer_child(pointer, "settings"),
                                         {"logMode", "showDisabledChoices"})) {
        const auto settings_pointer = pointer_child(pointer, "settings");
        const auto* log_value = decoder.member(*settings_value, "logMode", settings_pointer);
        const auto* disabled_value =
            decoder.member(*settings_value, "showDisabledChoices", settings_pointer);
        auto log = log_value ? decoder.enumeration<DialogueLogMode>(
                                   *log_value, pointer_child(settings_pointer, "logMode"),
                                   {{"everything", DialogueLogMode::Everything},
                                    {"nothing", DialogueLogMode::Nothing},
                                    {"only-choices", DialogueLogMode::OnlyChoices},
                                    {"only-lines", DialogueLogMode::OnlyLines}})
                             : std::nullopt;
        auto disabled =
            disabled_value ? decoder.boolean(*disabled_value,
                                             pointer_child(settings_pointer, "showDisabledChoices"))
                           : std::nullopt;
        if (log && disabled)
            settings = DialogueSettings{*log, *disabled};
    }
    if (program_value && !program_value->is_object())
        decoder.error(k_code_type, "Expected an object.", pointer_child(pointer, "program"));
    if (completion_value && !completion_value->is_object())
        decoder.error(k_code_type, "Expected an object.", pointer_child(pointer, "completion"));
    if (!identity || !display || !speaker_ok || !settings || !program_value ||
        !program_value->is_object() || !completion_value || !completion_value->is_object())
        return std::nullopt;
    return DialogueDefinition{std::move(*identity), std::move(*display), std::move(speaker),
                              std::move(*settings)};
}

std::optional<MapDefinition> decode_map(Decoder& decoder, const nlohmann::json& value,
                                        std::string_view pointer)
{
    if (!decoder.object(
            value, pointer,
            {"connections", "extends", "id", "locations", "presentation", "propertyAssignments"}))
        return std::nullopt;
    auto identity = decode_identity<MapId>(decoder, value, pointer);
    const auto* connections_value = decoder.member(value, "connections", pointer);
    const auto* locations_value = decoder.member(value, "locations", pointer);
    const auto* presentation_value = decoder.member(value, "presentation", pointer);
    auto locations =
        locations_value
            ? decoder.array<MapLocation>(
                  *locations_value, pointer_child(pointer, "locations"),
                  [&](const nlohmann::json& location,
                      const std::string& item_pointer) -> std::optional<MapLocation> {
                      if (!decoder.object(location, item_pointer,
                                          {"id", "label", "position", "room", "shape"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(location, "id", item_pointer);
                      const auto* label_value = decoder.member(location, "label", item_pointer);
                      const auto* position_value =
                          decoder.member(location, "position", item_pointer);
                      const auto* room_value = decoder.member(location, "room", item_pointer);
                      const auto* shape_value = decoder.member(location, "shape", item_pointer);
                      auto id = id_value ? decoder.id<MapLocationId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      std::optional<TextContent> label;
                      bool label_ok = label_value != nullptr;
                      if (label_value && !label_value->is_null()) {
                          label = decode_text(decoder, *label_value,
                                              pointer_child(item_pointer, "label"));
                          label_ok = label.has_value();
                      }
                      auto position = position_value
                                          ? decode_vector2(decoder, *position_value,
                                                           pointer_child(item_pointer, "position"))
                                          : std::nullopt;
                      auto room = room_value ? decode_reference<RoomId>(
                                                   decoder, *room_value,
                                                   pointer_child(item_pointer, "room"), "room")
                                             : std::nullopt;
                      std::optional<MapShape> shape;
                      if (shape_value && shape_value->is_object()) {
                          const auto shape_pointer = pointer_child(item_pointer, "shape");
                          const auto* kind_value =
                              decoder.member(*shape_value, "kind", shape_pointer);
                          auto kind = kind_value
                                          ? decoder.string(*kind_value,
                                                           pointer_child(shape_pointer, "kind"))
                                          : std::nullopt;
                          if (kind && *kind == "point") {
                              decoder.object(*shape_value, shape_pointer, {"kind"});
                              shape = PointMapShape{};
                          } else if (kind && *kind == "circle") {
                              decoder.object(*shape_value, shape_pointer, {"kind", "radius"});
                              const auto* radius_value =
                                  decoder.member(*shape_value, "radius", shape_pointer);
                              auto radius =
                                  radius_value
                                      ? decoder.finite_number(
                                            *radius_value, pointer_child(shape_pointer, "radius"))
                                      : std::nullopt;
                              if (radius && *radius <= 0.0) {
                                  decoder.error(k_code_number, "Radius must be positive.",
                                                pointer_child(shape_pointer, "radius"));
                                  radius.reset();
                              }
                              if (radius)
                                  shape = CircleMapShape{*radius};
                          } else if (kind && *kind == "rect") {
                              decoder.object(*shape_value, shape_pointer,
                                             {"height", "kind", "width"});
                              const auto* height_value =
                                  decoder.member(*shape_value, "height", shape_pointer);
                              const auto* width_value =
                                  decoder.member(*shape_value, "width", shape_pointer);
                              auto height =
                                  height_value
                                      ? decoder.finite_number(
                                            *height_value, pointer_child(shape_pointer, "height"))
                                      : std::nullopt;
                              auto width =
                                  width_value
                                      ? decoder.finite_number(*width_value,
                                                              pointer_child(shape_pointer, "width"))
                                      : std::nullopt;
                              if (height && *height <= 0.0) {
                                  decoder.error(k_code_number, "Height must be positive.",
                                                pointer_child(shape_pointer, "height"));
                                  height.reset();
                              }
                              if (width && *width <= 0.0) {
                                  decoder.error(k_code_number, "Width must be positive.",
                                                pointer_child(shape_pointer, "width"));
                                  width.reset();
                              }
                              if (height && width)
                                  shape = RectMapShape{*width, *height};
                          } else if (kind) {
                              decoder.object(*shape_value, shape_pointer, {"kind"});
                              decoder.error(k_code_variant,
                                            "Unknown map shape variant '" + *kind + "'.",
                                            pointer_child(shape_pointer, "kind"));
                          }
                      } else if (shape_value) {
                          decoder.error(k_code_type, "Expected an object.",
                                        pointer_child(item_pointer, "shape"));
                      }
                      if (id && label_ok && position && room && shape)
                          return MapLocation{std::move(*id), std::move(label), std::move(*position),
                                             std::move(*room), std::move(*shape)};
                      return std::nullopt;
                  })
            : std::nullopt;
    auto connections =
        connections_value
            ? decoder.array<MapConnection>(
                  *connections_value, pointer_child(pointer, "connections"),
                  [&](const nlohmann::json& connection,
                      const std::string& item_pointer) -> std::optional<MapConnection> {
                      if (!decoder.object(connection, item_pointer,
                                          {"exit", "id", "sourceLocationId", "targetLocationId"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(connection, "id", item_pointer);
                      const auto* exit_value = decoder.member(connection, "exit", item_pointer);
                      const auto* source_value =
                          decoder.member(connection, "sourceLocationId", item_pointer);
                      const auto* target_value =
                          decoder.member(connection, "targetLocationId", item_pointer);
                      auto id = id_value ? decoder.id<MapConnectionId>(
                                               *id_value, pointer_child(item_pointer, "id"))
                                         : std::nullopt;
                      std::optional<RoomExitRef> exit;
                      if (exit_value &&
                          decoder.object(*exit_value, pointer_child(item_pointer, "exit"),
                                         {"exitId", "room"})) {
                          const auto exit_pointer = pointer_child(item_pointer, "exit");
                          const auto* exit_id_value =
                              decoder.member(*exit_value, "exitId", exit_pointer);
                          const auto* room_value =
                              decoder.member(*exit_value, "room", exit_pointer);
                          auto exit_id =
                              exit_id_value
                                  ? decoder.id<RoomExitId>(*exit_id_value,
                                                           pointer_child(exit_pointer, "exitId"))
                                  : std::nullopt;
                          auto room = room_value ? decode_reference<RoomId>(
                                                       decoder, *room_value,
                                                       pointer_child(exit_pointer, "room"), "room")
                                                 : std::nullopt;
                          if (exit_id && room)
                              exit = RoomExitRef{std::move(*room), std::move(*exit_id)};
                      }
                      auto source =
                          source_value
                              ? decoder.id<MapLocationId>(
                                    *source_value, pointer_child(item_pointer, "sourceLocationId"))
                              : std::nullopt;
                      auto target =
                          target_value
                              ? decoder.id<MapLocationId>(
                                    *target_value, pointer_child(item_pointer, "targetLocationId"))
                              : std::nullopt;
                      if (id && exit && source && target)
                          return MapConnection{std::move(*id), std::move(*exit), std::move(*source),
                                               std::move(*target)};
                      return std::nullopt;
                  })
            : std::nullopt;
    std::optional<MapPresentation> presentation;
    if (presentation_value &&
        decoder.object(*presentation_value, pointer_child(pointer, "presentation"),
                       {"background", "initialMode", "layout", "title"})) {
        const auto presentation_pointer = pointer_child(pointer, "presentation");
        const auto* background_value =
            decoder.member(*presentation_value, "background", presentation_pointer);
        const auto* mode_value =
            decoder.member(*presentation_value, "initialMode", presentation_pointer);
        const auto* layout_value =
            decoder.member(*presentation_value, "layout", presentation_pointer);
        const auto* title_value =
            decoder.member(*presentation_value, "title", presentation_pointer);
        std::optional<AssetId> background;
        bool background_ok = background_value != nullptr;
        if (background_value && !background_value->is_null()) {
            background = decode_reference<AssetId>(
                decoder, *background_value, pointer_child(presentation_pointer, "background"),
                "asset");
            background_ok = background.has_value();
        }
        auto mode =
            mode_value
                ? decoder.enumeration<InitialMapMode>(
                      *mode_value, pointer_child(presentation_pointer, "initialMode"),
                      {{"minimap", InitialMapMode::Minimap}, {"full-map", InitialMapMode::FullMap}})
                : std::nullopt;
        std::optional<LayoutId> layout;
        bool layout_ok = layout_value != nullptr;
        if (layout_value && !layout_value->is_null()) {
            layout = decode_reference<LayoutId>(
                decoder, *layout_value, pointer_child(presentation_pointer, "layout"), "layout");
            layout_ok = layout.has_value();
        }
        std::optional<TextContent> title;
        bool title_ok = title_value != nullptr;
        if (title_value && !title_value->is_null()) {
            title =
                decode_text(decoder, *title_value, pointer_child(presentation_pointer, "title"));
            title_ok = title.has_value();
        }
        if (background_ok && mode && layout_ok && title_ok)
            presentation =
                MapPresentation{std::move(background), *mode, std::move(layout), std::move(title)};
    }
    if (locations)
        decoder.duplicate_ids(
            *locations, pointer_child(pointer, "locations"),
            [](const MapLocation& location) -> const MapLocationId& { return location.id; });
    if (connections)
        decoder.duplicate_ids(*connections, pointer_child(pointer, "connections"),
                              [](const MapConnection& connection) -> const MapConnectionId& {
                                  return connection.id;
                              });
    if (!identity || !connections || !locations || !presentation)
        return std::nullopt;
    return MapDefinition{std::move(*identity), std::move(*connections), std::move(*locations),
                         std::move(*presentation)};
}

} // namespace

Result<Condition, Diagnostics> decode_condition(const nlohmann::json& value,
                                                std::string source_path, std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_condition_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<Condition, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<Condition, Diagnostics>::success(std::move(*result));
}

Result<Effect, Diagnostics> decode_effect(const nlohmann::json& value, std::string source_path,
                                          std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_effect_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<Effect, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<Effect, Diagnostics>::success(std::move(*result));
}

Result<FlowTarget, Diagnostics>
decode_flow_target(const nlohmann::json& value, std::string source_path, std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_flow_target_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<FlowTarget, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<FlowTarget, Diagnostics>::success(std::move(*result));
}

Result<SharedProject, Diagnostics> decode_shared_project(const nlohmann::json& document,
                                                         std::string source_path)
{
    Decoder decoder(std::move(source_path));
    if (!decoder.object(document, "",
                        {"definitions", "entrypoint", "localization", "project", "properties",
                         "resources", "schema", "schemaVersion", "settings", "startupHook",
                         "variables"}))
        return Result<SharedProject, Diagnostics>::failure(decoder.take_diagnostics());

    const auto* schema_value = decoder.member(document, "schema", "");
    const auto* version_value = decoder.member(document, "schemaVersion", "");
    const auto* project_value = decoder.member(document, "project", "");
    const auto* settings_value = decoder.member(document, "settings", "");
    const auto* entrypoint_value = decoder.member(document, "entrypoint", "");
    const auto* startup_value = decoder.member(document, "startupHook", "");
    const auto* localization_value = decoder.member(document, "localization", "");
    const auto* variables_value = decoder.member(document, "variables", "");
    const auto* properties_value = decoder.member(document, "properties", "");
    const auto* resources_value = decoder.member(document, "resources", "");
    const auto* definitions_value = decoder.member(document, "definitions", "");

    auto schema = schema_value ? decoder.string(*schema_value, "/schema") : std::nullopt;
    if (schema && *schema != "noveltea.compiled.project") {
        decoder.error("compiled_project.unsupported_schema",
                      "Expected schema 'noveltea.compiled.project'.", "/schema");
        schema.reset();
    }
    auto version = version_value
                       ? decoder.unsigned_integer<std::uint32_t>(*version_value, "/schemaVersion")
                       : std::nullopt;
    if (version && *version != 1) {
        decoder.error("compiled_project.unsupported_version", "Only schema version 1 is supported.",
                      "/schemaVersion");
        version.reset();
    }
    auto identity =
        project_value ? decode_project_identity(decoder, *project_value, "/project") : std::nullopt;
    auto settings =
        settings_value ? decode_settings(decoder, *settings_value, "/settings") : std::nullopt;
    auto entrypoint = entrypoint_value
                          ? decode_entrypoint(decoder, *entrypoint_value, "/entrypoint")
                          : std::nullopt;
    std::optional<StartupHook> startup;
    bool startup_ok = startup_value != nullptr;
    if (startup_value && !startup_value->is_null()) {
        if (decoder.object(*startup_value, "/startupHook", {"source"})) {
            const auto* source_value = decoder.member(*startup_value, "source", "/startupHook");
            auto source =
                source_value ? decoder.string(*source_value, "/startupHook/source") : std::nullopt;
            if (source)
                startup = StartupHook{std::move(*source)};
            else
                startup_ok = false;
        } else {
            startup_ok = false;
        }
    }
    auto localization = localization_value
                            ? decode_localization(decoder, *localization_value, "/localization")
                            : std::nullopt;
    auto variables = variables_value
                         ? decoder.array<VariableDeclaration>(
                               *variables_value, "/variables",
                               [&](const nlohmann::json& item, const std::string& pointer) {
                                   return decode_variable(decoder, item, pointer);
                               })
                         : std::nullopt;
    auto properties = properties_value
                          ? decoder.array<PropertyDeclaration>(
                                *properties_value, "/properties",
                                [&](const nlohmann::json& item, const std::string& pointer) {
                                    return decode_property(decoder, item, pointer);
                                })
                          : std::nullopt;

    std::optional<std::vector<AssetResource>> assets;
    std::optional<std::vector<LayoutResource>> layouts;
    std::optional<std::vector<ScriptResource>> scripts;
    if (resources_value &&
        decoder.object(*resources_value, "/resources", {"assets", "layouts", "scripts"})) {
        const auto* assets_value = decoder.member(*resources_value, "assets", "/resources");
        const auto* layouts_value = decoder.member(*resources_value, "layouts", "/resources");
        const auto* scripts_value = decoder.member(*resources_value, "scripts", "/resources");
        if (assets_value)
            assets = decoder.array<AssetResource>(
                *assets_value, "/resources/assets",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_asset(decoder, item, pointer);
                });
        if (layouts_value)
            layouts = decoder.array<LayoutResource>(
                *layouts_value, "/resources/layouts",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_layout(decoder, item, pointer);
                });
        if (scripts_value)
            scripts = decoder.array<ScriptResource>(
                *scripts_value, "/resources/scripts",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_script(decoder, item, pointer);
                });
    }

    std::optional<std::vector<CharacterDefinition>> characters;
    std::optional<std::vector<RoomDefinition>> rooms;
    std::optional<std::vector<InteractableDefinition>> interactables;
    std::optional<std::vector<VerbDefinition>> verbs;
    std::optional<std::vector<InteractionDefinition>> interactions;
    std::optional<std::vector<SceneDefinition>> scenes;
    std::optional<std::vector<DialogueDefinition>> dialogues;
    std::optional<std::vector<MapDefinition>> maps;
    if (definitions_value && decoder.object(*definitions_value, "/definitions",
                                            {"characters", "dialogues", "interactables",
                                             "interactions", "maps", "rooms", "scenes", "verbs"})) {
#define NOVELTEA_DECODE_DEFINITION(member_name, variable_name, type_name, function_name)           \
    if (const auto* collection = decoder.member(*definitions_value, member_name, "/definitions"))  \
    variable_name =                                                                                \
        decoder.array<type_name>(*collection, "/definitions/" member_name,                         \
                                 [&](const nlohmann::json& item, const std::string& pointer) {     \
                                     return function_name(decoder, item, pointer);                 \
                                 })
        NOVELTEA_DECODE_DEFINITION("characters", characters, CharacterDefinition, decode_character);
        NOVELTEA_DECODE_DEFINITION("rooms", rooms, RoomDefinition, decode_room);
        NOVELTEA_DECODE_DEFINITION("interactables", interactables, InteractableDefinition,
                                   decode_interactable);
        NOVELTEA_DECODE_DEFINITION("verbs", verbs, VerbDefinition, decode_verb);
        NOVELTEA_DECODE_DEFINITION("interactions", interactions, InteractionDefinition,
                                   decode_interaction);
        NOVELTEA_DECODE_DEFINITION("scenes", scenes, SceneDefinition, decode_scene);
        NOVELTEA_DECODE_DEFINITION("dialogues", dialogues, DialogueDefinition, decode_dialogue);
        NOVELTEA_DECODE_DEFINITION("maps", maps, MapDefinition, decode_map);
#undef NOVELTEA_DECODE_DEFINITION
    }

    if (variables)
        decoder.duplicate_ids(
            *variables, "/variables",
            [](const VariableDeclaration& value) -> const VariableId& { return value.id; });
    if (properties)
        decoder.duplicate_ids(
            *properties, "/properties",
            [](const PropertyDeclaration& value) -> const PropertyId& { return value.id; });
    if (assets)
        decoder.duplicate_ids(
            *assets, "/resources/assets",
            [](const AssetResource& value) -> const AssetId& { return value.id; });
    if (layouts)
        decoder.duplicate_ids(
            *layouts, "/resources/layouts",
            [](const LayoutResource& value) -> const LayoutId& { return value.id; });
    if (scripts)
        decoder.duplicate_ids(
            *scripts, "/resources/scripts",
            [](const ScriptResource& value) -> const ScriptId& { return value.id; });
#define NOVELTEA_DUPLICATE_DEFINITION(variable_name, pointer, id_type)                             \
    if (variable_name)                                                                             \
    decoder.duplicate_ids(*variable_name, pointer,                                                 \
                          [](const auto& value) -> const id_type& { return value.identity.id; })
    NOVELTEA_DUPLICATE_DEFINITION(characters, "/definitions/characters", CharacterId);
    NOVELTEA_DUPLICATE_DEFINITION(rooms, "/definitions/rooms", RoomId);
    NOVELTEA_DUPLICATE_DEFINITION(interactables, "/definitions/interactables", InteractableId);
    NOVELTEA_DUPLICATE_DEFINITION(verbs, "/definitions/verbs", VerbId);
    NOVELTEA_DUPLICATE_DEFINITION(interactions, "/definitions/interactions", InteractionId);
    NOVELTEA_DUPLICATE_DEFINITION(scenes, "/definitions/scenes", SceneId);
    NOVELTEA_DUPLICATE_DEFINITION(dialogues, "/definitions/dialogues", DialogueId);
    NOVELTEA_DUPLICATE_DEFINITION(maps, "/definitions/maps", MapId);
#undef NOVELTEA_DUPLICATE_DEFINITION

    const bool complete = schema && version && identity && settings && entrypoint && startup_ok &&
                          localization && variables && properties && assets && layouts && scripts &&
                          characters && rooms && interactables && verbs && interactions && scenes &&
                          dialogues && maps;
    if (!complete || decoder.failed())
        return Result<SharedProject, Diagnostics>::failure(decoder.take_diagnostics());

    return Result<SharedProject, Diagnostics>::success(SharedProject{
        std::move(*identity), std::move(*settings), std::move(*entrypoint), std::move(startup),
        std::move(*localization), std::move(*variables), std::move(*properties), std::move(*assets),
        std::move(*layouts), std::move(*scripts), std::move(*characters), std::move(*rooms),
        std::move(*interactables), std::move(*verbs), std::move(*interactions), std::move(*scenes),
        std::move(*dialogues), std::move(*maps)});
}

} // namespace noveltea::core::compiled::wire
