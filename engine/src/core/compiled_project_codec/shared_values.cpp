#include "internal.hpp"

namespace noveltea::core::compiled::wire::detail {

std::optional<RuntimeValue> decode_runtime_value(Decoder& decoder, const nlohmann::json& value,
                                                 std::string_view pointer, bool allow_null)
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

} // namespace noveltea::core::compiled::wire::detail
