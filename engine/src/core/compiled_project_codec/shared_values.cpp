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

std::optional<PersistableValue>
decode_persistable_value(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return PersistableValue{std::monostate{}};
    if (const auto decoded = json_access::get<bool>(value))
        return PersistableValue{*decoded};
    if (const auto* integer = value.get_ptr<const nlohmann::json::number_integer_t*>())
        return PersistableValue{static_cast<std::int64_t>(*integer)};
    if (const auto* integer = value.get_ptr<const nlohmann::json::number_unsigned_t*>()) {
        if (*integer <= static_cast<nlohmann::json::number_unsigned_t>(
                            std::numeric_limits<std::int64_t>::max()))
            return PersistableValue{static_cast<std::int64_t>(*integer)};
        decoder.error(k_code_number, "Integer is outside the signed 64-bit persistable range.",
                      std::string(pointer));
        return std::nullopt;
    }
    if (const auto* number = value.get_ptr<const nlohmann::json::number_float_t*>()) {
        if (std::isfinite(*number))
            return PersistableValue{static_cast<double>(*number)};
        decoder.error(k_code_number, "Persistable number must be finite.", std::string(pointer));
        return std::nullopt;
    }
    if (const auto decoded = json_access::get<std::string>(value))
        return PersistableValue{*decoded};
    if (value.is_array()) {
        PersistableValue::Array array;
        array.reserve(value.size());
        for (std::size_t index = 0; index < value.size(); ++index) {
            const auto item_pointer = pointer_child(pointer, std::to_string(index));
            auto item = decode_persistable_value(decoder, value[index], item_pointer);
            if (!item)
                return std::nullopt;
            array.push_back(std::move(*item));
        }
        return PersistableValue{std::move(array)};
    }
    if (value.is_object()) {
        PersistableValue::Object object;
        object.reserve(value.size());
        for (const auto& [key, member] : value.items()) {
            if (key.empty()) {
                decoder.error(k_code_type, "Persistable object keys must not be empty.",
                              std::string(pointer));
                return std::nullopt;
            }
            auto decoded = decode_persistable_value(decoder, member, pointer_child(pointer, key));
            if (!decoded)
                return std::nullopt;
            object.emplace_back(key, std::move(*decoded));
        }
        return PersistableValue{std::move(object)};
    }
    decoder.error(k_code_type, "Expected a recursive persistable value.", std::string(pointer));
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

namespace {
std::optional<GameplayIdentityOperand> decode_gameplay_identity_operand(Decoder& decoder,
                                                                        const nlohmann::json& value,
                                                                        std::string_view pointer);
std::optional<LocationSubjectOperand> decode_location_subject_operand(Decoder& decoder,
                                                                      const nlohmann::json& value,
                                                                      std::string_view pointer);
std::optional<InteractableOperand> decode_interactable_operand(Decoder& decoder,
                                                               const nlohmann::json& value,
                                                               std::string_view pointer);
std::optional<LocationOperand>
decode_location_operand(Decoder& decoder, const nlohmann::json& value, std::string_view pointer);
std::optional<InventoryOperand>
decode_inventory_operand(Decoder& decoder, const nlohmann::json& value, std::string_view pointer);
std::optional<ConditionInteractableMatcher>
decode_condition_interactable_matcher(Decoder& decoder, const nlohmann::json& value,
                                      std::string_view pointer);
} // namespace

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
    if (*kind == "all" || *kind == "any") {
        decoder.object(value, pointer, {"conditions", "kind"});
        const auto* conditions_value = decoder.member(value, "conditions", pointer);
        auto conditions =
            conditions_value
                ? decoder.array<Condition>(
                      *conditions_value, pointer_child(pointer, "conditions"),
                      [&](const nlohmann::json& item,
                          const std::string& item_pointer) -> std::optional<Condition> {
                          return decode_condition_impl(decoder, item, item_pointer);
                      })
                : std::nullopt;
        if (!conditions)
            return std::nullopt;
        return *kind == "all" ? std::optional<Condition>(AllCondition{std::move(*conditions)})
                              : std::optional<Condition>(AnyCondition{std::move(*conditions)});
    }
    if (*kind == "not") {
        decoder.object(value, pointer, {"condition", "kind"});
        const auto* condition_value = decoder.member(value, "condition", pointer);
        auto condition = condition_value
                             ? decode_condition_impl(decoder, *condition_value,
                                                     pointer_child(pointer, "condition"))
                             : std::nullopt;
        if (!condition)
            return std::nullopt;
        std::vector<Condition> nested;
        nested.push_back(std::move(*condition));
        return Condition{NotCondition{std::move(nested)}};
    }
    if (*kind == "lua-predicate") {
        decoder.object(value, pointer, {"kind", "source"});
        const auto* source_value = decoder.member(value, "source", pointer);
        auto source = source_value
                          ? decoder.string(*source_value, pointer_child(pointer, "source"), true)
                          : std::nullopt;
        return source ? std::optional<Condition>(LuaPredicate{std::move(*source)}) : std::nullopt;
    }
    if (*kind == "global-property-comparison") {
        decoder.object(value, pointer, {"kind", "operator", "property", "value"});
        const auto* operation_value = decoder.member(value, "operator", pointer);
        const auto* property_value = decoder.member(value, "property", pointer);
        auto operation = operation_value
                             ? decoder.string(*operation_value, pointer_child(pointer, "operator"))
                             : std::nullopt;
        auto property =
            property_value
                ? decode_reference<PropertyId>(decoder, *property_value,
                                               pointer_child(pointer, "property"), "property")
                : std::nullopt;
        if (!operation || !property)
            return std::nullopt;
        if (*operation == "truthy" || *operation == "falsy") {
            if (json_access::member(value, "value"))
                decoder.error(k_code_unknown, "Truthiness comparisons do not accept 'value'.",
                              pointer_child(pointer, "value"));
            return Condition{GlobalPropertyComparison{GlobalPropertyTruthiness{
                std::move(*property),
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
        return Condition{GlobalPropertyComparison{GlobalPropertyValueComparison{
            std::move(*property), *comparison_operator, std::move(*comparison)}}};
    }
    if (*kind == "property-comparison") {
        decoder.object(value, pointer, {"kind", "operator", "owner", "propertyId", "value"});
        const auto* owner_value = decoder.member(value, "owner", pointer);
        const auto* property_value = decoder.member(value, "propertyId", pointer);
        const auto* operation_value = decoder.member(value, "operator", pointer);
        auto owner = owner_value ? decode_gameplay_identity_operand(decoder, *owner_value,
                                                                    pointer_child(pointer, "owner"))
                                 : std::nullopt;
        auto property =
            property_value
                ? decoder.id<PropertyId>(*property_value, pointer_child(pointer, "propertyId"))
                : std::nullopt;
        auto operation = operation_value
                             ? decoder.string(*operation_value, pointer_child(pointer, "operator"))
                             : std::nullopt;
        if (!owner || !property || !operation)
            return std::nullopt;
        if (*operation == "truthy" || *operation == "falsy") {
            if (json_access::member(value, "value"))
                decoder.error(k_code_unknown, "Truthiness comparisons do not accept 'value'.",
                              pointer_child(pointer, "value"));
            return Condition{IdentityPropertyComparison{IdentityPropertyTruthiness{
                std::move(*owner), std::move(*property),
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
        return Condition{IdentityPropertyComparison{
            IdentityPropertyValueComparison{std::move(*owner), std::move(*property),
                                            *comparison_operator, std::move(*comparison)}}};
    }
    if (*kind == "trait-presence") {
        decoder.object(value, pointer, {"kind", "owner", "present", "trait"});
        const auto* owner_value = decoder.member(value, "owner", pointer);
        const auto* trait_value = decoder.member(value, "trait", pointer);
        const auto* present_value = decoder.member(value, "present", pointer);
        auto owner = owner_value ? decode_gameplay_identity_operand(decoder, *owner_value,
                                                                    pointer_child(pointer, "owner"))
                                 : std::nullopt;
        auto trait = trait_value
                         ? decode_reference<TraitId>(decoder, *trait_value,
                                                     pointer_child(pointer, "trait"), "trait")
                         : std::nullopt;
        auto present = present_value
                           ? decoder.boolean(*present_value, pointer_child(pointer, "present"))
                           : std::nullopt;
        return owner && trait && present ? std::optional<Condition>(TraitPresenceCondition{
                                               std::move(*owner), std::move(*trait), *present})
                                         : std::nullopt;
    }
    if (*kind == "location-comparison") {
        decoder.object(value, pointer, {"kind", "location", "operator", "subject"});
        const auto* subject_value = decoder.member(value, "subject", pointer);
        const auto* operation_value = decoder.member(value, "operator", pointer);
        const auto* location_value = decoder.member(value, "location", pointer);
        auto subject = subject_value
                           ? decode_location_subject_operand(decoder, *subject_value,
                                                             pointer_child(pointer, "subject"))
                           : std::nullopt;
        auto operation = operation_value
                             ? decoder.enumeration<EqualityComparisonOperator>(
                                   *operation_value, pointer_child(pointer, "operator"),
                                   {{"equal", EqualityComparisonOperator::Equal},
                                    {"not-equal", EqualityComparisonOperator::NotEqual}})
                             : std::nullopt;
        auto location = location_value ? decode_location_operand(decoder, *location_value,
                                                                 pointer_child(pointer, "location"))
                                       : std::nullopt;
        return subject && operation && location
                   ? std::optional<Condition>(LocationComparisonCondition{
                         std::move(*subject), *operation, std::move(*location)})
                   : std::nullopt;
    }
    if (*kind == "inventory-quantity-comparison") {
        decoder.object(value, pointer, {"inventory", "kind", "matcher", "operator", "quantity"});
        const auto* inventory_value = decoder.member(value, "inventory", pointer);
        const auto* matcher_value = decoder.member(value, "matcher", pointer);
        const auto* operation_value = decoder.member(value, "operator", pointer);
        const auto* quantity_value = decoder.member(value, "quantity", pointer);
        auto inventory = inventory_value
                             ? decode_inventory_operand(decoder, *inventory_value,
                                                        pointer_child(pointer, "inventory"))
                             : std::nullopt;
        auto matcher =
            matcher_value ? decode_condition_interactable_matcher(decoder, *matcher_value,
                                                                  pointer_child(pointer, "matcher"))
                          : std::nullopt;
        auto operation = operation_value
                             ? decoder.enumeration<ValueComparisonOperator>(
                                   *operation_value, pointer_child(pointer, "operator"),
                                   {{"equal", ValueComparisonOperator::Equal},
                                    {"not-equal", ValueComparisonOperator::NotEqual},
                                    {"less", ValueComparisonOperator::Less},
                                    {"less-equal", ValueComparisonOperator::LessEqual},
                                    {"greater", ValueComparisonOperator::Greater},
                                    {"greater-equal", ValueComparisonOperator::GreaterEqual}})
                             : std::nullopt;
        auto quantity = quantity_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *quantity_value, pointer_child(pointer, "quantity"))
                                       : std::nullopt;
        return inventory && matcher && operation && quantity
                   ? std::optional<Condition>(InventoryQuantityComparisonCondition{
                         std::move(*inventory), std::move(*matcher), *operation, *quantity})
                   : std::nullopt;
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
    if (*kind == "set-global-property") {
        decoder.object(value, pointer, {"kind", "property", "value"});
        const auto* property_value = decoder.member(value, "property", pointer);
        const auto* assignment_value = decoder.member(value, "value", pointer);
        auto property =
            property_value
                ? decode_reference<PropertyId>(decoder, *property_value,
                                               pointer_child(pointer, "property"), "property")
                : std::nullopt;
        auto assignment = assignment_value ? decode_runtime_value(decoder, *assignment_value,
                                                                  pointer_child(pointer, "value"))
                                           : std::nullopt;
        if (property && assignment)
            return Effect{SetGlobalProperty{std::move(*property), std::move(*assignment)}};
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

std::optional<GameplayCommand> decode_gameplay_command_impl(Decoder& decoder,
                                                            const nlohmann::json& value,
                                                            std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a Gameplay Command object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto id = id_value
                  ? decoder.id<InteractionInstructionId>(*id_value, pointer_child(pointer, "id"))
                  : std::nullopt;
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!id || !kind)
        return std::nullopt;

    const auto binding = [&](std::string_view name) -> std::optional<CommandResultBindingId> {
        const auto* member = json_access::member(value, name);
        return member ? decoder.id<CommandResultBindingId>(*member, pointer_child(pointer, name))
                      : std::nullopt;
    };
    const auto property = [&](std::string_view name) -> std::optional<PropertyId> {
        const auto* member = decoder.member(value, name, pointer);
        return member ? decode_reference<PropertyId>(decoder, *member, pointer_child(pointer, name),
                                                     "property")
                      : std::nullopt;
    };
    const auto runtime_value = [&](std::string_view name) -> std::optional<RuntimeValue> {
        const auto* member = decoder.member(value, name, pointer);
        return member ? decode_runtime_value(decoder, *member, pointer_child(pointer, name))
                      : std::nullopt;
    };
    const auto identity = [&](std::string_view name) -> std::optional<GameplayIdentityOperand> {
        const auto* member = decoder.member(value, name, pointer);
        return member ? decode_gameplay_identity_operand(decoder, *member,
                                                         pointer_child(pointer, name))
                      : std::nullopt;
    };
    const auto location_subject =
        [&](std::string_view name) -> std::optional<LocationSubjectOperand> {
        const auto* member = decoder.member(value, name, pointer);
        return member
                   ? decode_location_subject_operand(decoder, *member, pointer_child(pointer, name))
                   : std::nullopt;
    };
    const auto location = [&](std::string_view name) -> std::optional<LocationOperand> {
        const auto* member = decoder.member(value, name, pointer);
        return member ? decode_location_operand(decoder, *member, pointer_child(pointer, name))
                      : std::nullopt;
    };
    const auto interactable = [&](std::string_view name) -> std::optional<InteractableOperand> {
        const auto* member = decoder.member(value, name, pointer);
        return member ? decode_interactable_operand(decoder, *member, pointer_child(pointer, name))
                      : std::nullopt;
    };
    const auto quantity = [&](std::string_view name) -> std::optional<std::uint64_t> {
        const auto* member = decoder.member(value, name, pointer);
        return member
                   ? decoder.unsigned_integer<std::uint64_t>(*member, pointer_child(pointer, name))
                   : std::nullopt;
    };
    const auto configuration_source = [&]() -> std::optional<GameplayConfigurationSource> {
        const auto* source_value = decoder.member(value, "source", pointer);
        if (!source_value || !source_value->is_object()) {
            if (source_value)
                decoder.error(k_code_type, "Expected a Gameplay configuration source object.",
                              pointer_child(pointer, "source"));
            return std::nullopt;
        }
        const auto source_pointer = pointer_child(pointer, "source");
        const auto* source_kind_value = decoder.member(*source_value, "kind", source_pointer);
        auto source_kind = source_kind_value ? decoder.string(*source_kind_value,
                                                              pointer_child(source_pointer, "kind"))
                                             : std::nullopt;
        if (!source_kind)
            return std::nullopt;
        if (*source_kind == "archetype") {
            decoder.object(*source_value, source_pointer, {"archetype", "kind"});
            const auto* archetype_value =
                decoder.member(*source_value, "archetype", source_pointer);
            auto archetype = archetype_value
                                 ? decode_reference<ArchetypeId>(
                                       decoder, *archetype_value,
                                       pointer_child(source_pointer, "archetype"), "archetype")
                                 : std::nullopt;
            return archetype
                       ? std::optional<GameplayConfigurationSource>(GameplayConfigurationSource{
                             GameplayConfigurationSourceKind::Archetype, std::move(*archetype)})
                       : std::nullopt;
        }
        if (*source_kind == "compiled-instance" || *source_kind == "effective-instance") {
            decoder.object(*source_value, source_pointer, {"instance", "kind"});
            const auto* instance_value = decoder.member(*source_value, "instance", source_pointer);
            auto instance =
                instance_value
                    ? decode_gameplay_identity_operand(decoder, *instance_value,
                                                       pointer_child(source_pointer, "instance"))
                    : std::nullopt;
            if (!instance)
                return std::nullopt;
            return GameplayConfigurationSource{
                *source_kind == "compiled-instance"
                    ? GameplayConfigurationSourceKind::CompiledInstance
                    : GameplayConfigurationSourceKind::EffectiveInstance,
                std::move(*instance)};
        }
        decoder.object(*source_value, source_pointer, {"kind"});
        decoder.error(k_code_variant,
                      "Unknown Gameplay configuration source variant '" + *source_kind + "'.",
                      pointer_child(source_pointer, "kind"));
        return std::nullopt;
    };

    if (*kind == "set-global-property") {
        decoder.object(value, pointer, {"id", "kind", "property", "value"});
        auto p = property("property");
        auto v = runtime_value("value");
        return p && v ? std::optional<GameplayCommand>(GameplayCommand{
                            std::move(*id), SetGlobalPropertyCommand{std::move(*p), std::move(*v)}})
                      : std::nullopt;
    }
    if (*kind == "unset-global-property") {
        decoder.object(value, pointer, {"id", "kind", "property"});
        auto p = property("property");
        return p ? std::optional<GameplayCommand>(
                       GameplayCommand{std::move(*id), UnsetGlobalPropertyCommand{std::move(*p)}})
                 : std::nullopt;
    }
    if (*kind == "set-property" || *kind == "unset-property") {
        decoder.object(
            value, pointer,
            *kind == "set-property"
                ? std::initializer_list<std::string_view>{"id", "kind", "owner", "property",
                                                          "value"}
                : std::initializer_list<std::string_view>{"id", "kind", "owner", "property"});
        auto owner = identity("owner");
        auto p = property("property");
        if (!owner || !p)
            return std::nullopt;
        if (*kind == "unset-property")
            return GameplayCommand{std::move(*id),
                                   UnsetPropertyCommand{std::move(*owner), std::move(*p)}};
        auto v = runtime_value("value");
        return v ? std::optional<GameplayCommand>(GameplayCommand{
                       std::move(*id),
                       SetPropertyCommand{std::move(*owner), std::move(*p), std::move(*v)}})
                 : std::nullopt;
    }
    if (*kind == "add-trait" || *kind == "remove-trait") {
        decoder.object(value, pointer, {"id", "kind", "owner", "trait"});
        auto owner = identity("owner");
        const auto* trait_value = decoder.member(value, "trait", pointer);
        auto trait = trait_value
                         ? decode_reference<TraitId>(decoder, *trait_value,
                                                     pointer_child(pointer, "trait"), "trait")
                         : std::nullopt;
        if (!owner || !trait)
            return std::nullopt;
        return GameplayCommand{
            std::move(*id),
            *kind == "add-trait"
                ? GameplayCommand::Value(AddTraitCommand{std::move(*owner), std::move(*trait)})
                : GameplayCommand::Value(RemoveTraitCommand{std::move(*owner), std::move(*trait)})};
    }
    if (*kind == "set-enabled" || *kind == "set-visible") {
        decoder.object(
            value, pointer,
            *kind == "set-enabled"
                ? std::initializer_list<std::string_view>{"enabled", "id", "kind", "subject"}
                : std::initializer_list<std::string_view>{"id", "kind", "subject", "visible"});
        auto subject = location_subject("subject");
        const auto field = *kind == "set-enabled" ? "enabled" : "visible";
        const auto* state_value = decoder.member(value, field, pointer);
        auto state = state_value ? decoder.boolean(*state_value, pointer_child(pointer, field))
                                 : std::nullopt;
        if (!subject || !state)
            return std::nullopt;
        return GameplayCommand{
            std::move(*id),
            *kind == "set-enabled"
                ? GameplayCommand::Value(SetEnabledCommand{std::move(*subject), *state})
                : GameplayCommand::Value(SetVisibleCommand{std::move(*subject), *state})};
    }
    if (*kind == "move-instance") {
        decoder.object(value, pointer, {"id", "kind", "location", "subject"});
        auto subject = location_subject("subject");
        auto target = location("location");
        return subject && target ? std::optional<GameplayCommand>(GameplayCommand{
                                       std::move(*id), MoveInstanceCommand{std::move(*subject),
                                                                           std::move(*target)}})
                                 : std::nullopt;
    }
    if (*kind == "create-room" || *kind == "create-character" || *kind == "create-interactable") {
        if (*kind == "create-room")
            decoder.object(value, pointer, {"id", "kind", "result", "source"});
        else
            decoder.object(value, pointer,
                           {"enabled", "id", "kind", "location", "result", "source", "visible"});
        auto source = configuration_source();
        if (!source)
            return std::nullopt;
        auto result = binding("result");
        if (*kind == "create-room")
            return GameplayCommand{std::move(*id), CreateRoomCommand{std::move(*source), result}};
        auto target = location("location");
        const auto* enabled_value = decoder.member(value, "enabled", pointer);
        const auto* visible_value = decoder.member(value, "visible", pointer);
        auto enabled = enabled_value
                           ? decoder.boolean(*enabled_value, pointer_child(pointer, "enabled"))
                           : std::nullopt;
        auto visible = visible_value
                           ? decoder.boolean(*visible_value, pointer_child(pointer, "visible"))
                           : std::nullopt;
        if (!target || !enabled || !visible)
            return std::nullopt;
        return GameplayCommand{
            std::move(*id),
            *kind == "create-character"
                ? GameplayCommand::Value(CreateCharacterCommand{
                      std::move(*source), std::move(*target), *enabled, *visible, result})
                : GameplayCommand::Value(CreateInteractableCommand{
                      std::move(*source), std::move(*target), *enabled, *visible, result})};
    }
    if (*kind == "destroy-instance") {
        decoder.object(value, pointer, {"id", "instance", "kind"});
        auto instance = identity("instance");
        return instance ? std::optional<GameplayCommand>(GameplayCommand{
                              std::move(*id), DestroyInstanceCommand{std::move(*instance)}})
                        : std::nullopt;
    }
    if (*kind == "split-quantity") {
        decoder.object(value, pointer, {"id", "kind", "quantity", "result", "source"});
        auto source = interactable("source");
        auto count = quantity("quantity");
        auto result = binding("result");
        return source && count
                   ? std::optional<GameplayCommand>(GameplayCommand{
                         std::move(*id), SplitQuantityCommand{std::move(*source), *count, result}})
                   : std::nullopt;
    }
    if (*kind == "merge-quantity") {
        decoder.object(value, pointer, {"donor", "id", "kind", "receiver"});
        auto receiver = interactable("receiver");
        auto donor = interactable("donor");
        return receiver && donor ? std::optional<GameplayCommand>(GameplayCommand{
                                       std::move(*id), MergeQuantityCommand{std::move(*receiver),
                                                                            std::move(*donor)}})
                                 : std::nullopt;
    }
    if (*kind == "transfer-quantity" || *kind == "consume-quantity") {
        const bool transfer = *kind == "transfer-quantity";
        decoder.object(
            value, pointer,
            transfer
                ? std::initializer_list<std::string_view>{"id", "kind", "location", "matcher",
                                                          "mode", "quantity", "result", "source",
                                                          "sourceInventory"}
                : std::initializer_list<std::string_view>{"id", "kind", "matcher", "mode",
                                                          "quantity", "source", "sourceInventory"});
        const auto* mode_value = decoder.member(value, "mode", pointer);
        auto mode =
            mode_value ? decoder.string(*mode_value, pointer_child(pointer, "mode")) : std::nullopt;
        auto count = quantity("quantity");
        if (!mode || !count)
            return std::nullopt;
        std::optional<std::variant<InteractableOperand, ConditionInteractableMatcher>> source;
        std::optional<InventoryOperand> source_inventory;
        if (*mode == "exact") {
            auto exact = interactable("source");
            if (!exact)
                return std::nullopt;
            source = std::move(*exact);
        } else if (*mode == "aggregate") {
            const auto* matcher_value = decoder.member(value, "matcher", pointer);
            auto matcher = matcher_value
                               ? decode_condition_interactable_matcher(
                                     decoder, *matcher_value, pointer_child(pointer, "matcher"))
                               : std::nullopt;
            if (!matcher)
                return std::nullopt;
            source = std::move(*matcher);
            const auto* inventory_value = json_access::member(value, "sourceInventory");
            if (inventory_value) {
                auto inventory = decode_inventory_operand(
                    decoder, *inventory_value, pointer_child(pointer, "sourceInventory"));
                if (!inventory)
                    return std::nullopt;
                source_inventory = std::move(*inventory);
            }
        } else {
            decoder.error(k_code_variant, "Quantity command mode must be 'exact' or 'aggregate'.",
                          pointer_child(pointer, "mode"));
            return std::nullopt;
        }
        if (transfer) {
            auto target = location("location");
            if (!target)
                return std::nullopt;
            auto result = binding("result");
            if (*mode == "aggregate" && result) {
                decoder.error(k_code_variant,
                              "Aggregate Transfer cannot bind a singular command result.",
                              pointer_child(pointer, "result"));
                return std::nullopt;
            }
            return GameplayCommand{std::move(*id),
                                   TransferQuantityCommand{std::move(*source),
                                                           std::move(source_inventory), *count,
                                                           std::move(*target), result}};
        }
        return GameplayCommand{
            std::move(*id),
            ConsumeQuantityCommand{std::move(*source), std::move(source_inventory), *count}};
    }
    if (*kind == "add-quantity") {
        decoder.object(value, pointer, {"definition", "id", "kind", "location", "quantity"});
        const auto* definition_value = decoder.member(value, "definition", pointer);
        auto definition = definition_value
                              ? decode_reference<InteractableDefinitionId>(
                                    decoder, *definition_value,
                                    pointer_child(pointer, "definition"), "interactable-definition")
                              : std::nullopt;
        auto count = quantity("quantity");
        auto target = location("location");
        return definition && count && target
                   ? std::optional<GameplayCommand>(GameplayCommand{
                         std::move(*id),
                         AddQuantityCommand{std::move(*definition), *count, std::move(*target)}})
                   : std::nullopt;
    }
    if (*kind == "present-inventory") {
        decoder.object(value, pointer, {"id", "inventory", "kind", "layout"});
        const auto* inventory_value = decoder.member(value, "inventory", pointer);
        const auto* layout_value = json_access::member(value, "layout");
        auto inventory = inventory_value
                             ? decode_inventory_operand(decoder, *inventory_value,
                                                        pointer_child(pointer, "inventory"))
                             : std::nullopt;
        std::optional<LayoutId> layout;
        bool layout_ok = true;
        if (layout_value && !layout_value->is_null()) {
            layout = decode_reference<LayoutId>(decoder, *layout_value,
                                                pointer_child(pointer, "layout"), "layout");
            layout_ok = layout.has_value();
        }
        return inventory && layout_ok
                   ? std::optional<GameplayCommand>(GameplayCommand{
                         std::move(*id), PresentInventoryCommand{std::move(*inventory), layout}})
                   : std::nullopt;
    }
    if (*kind == "call-scene" || *kind == "call-dialogue") {
        const auto name = *kind == "call-scene" ? "scene" : "dialogue";
        decoder.object(value, pointer, {"id", "kind", name});
        const auto* reference = decoder.member(value, name, pointer);
        if (*kind == "call-scene") {
            auto scene = reference ? decode_reference<SceneId>(
                                         decoder, *reference, pointer_child(pointer, name), "scene")
                                   : std::nullopt;
            return scene ? std::optional<GameplayCommand>(
                               GameplayCommand{std::move(*id), CallSceneCommand{std::move(*scene)}})
                         : std::nullopt;
        }
        auto dialogue = reference
                            ? decode_reference<DialogueId>(decoder, *reference,
                                                           pointer_child(pointer, name), "dialogue")
                            : std::nullopt;
        return dialogue ? std::optional<GameplayCommand>(GameplayCommand{
                              std::move(*id), CallDialogueCommand{std::move(*dialogue)}})
                        : std::nullopt;
    }
    if (*kind == "notify") {
        decoder.object(value, pointer, {"id", "kind", "message"});
        const auto* message_value = decoder.member(value, "message", pointer);
        auto message = message_value
                           ? decode_text(decoder, *message_value, pointer_child(pointer, "message"))
                           : std::nullopt;
        return message ? std::optional<GameplayCommand>(
                             GameplayCommand{std::move(*id), NotifyCommand{std::move(*message)}})
                       : std::nullopt;
    }
    if (*kind == "run-lua") {
        decoder.object(value, pointer, {"id", "kind", "source"});
        const auto* source_value = decoder.member(value, "source", pointer);
        auto source = source_value
                          ? decoder.string(*source_value, pointer_child(pointer, "source"), true)
                          : std::nullopt;
        return source ? std::optional<GameplayCommand>(
                            GameplayCommand{std::move(*id), RunLuaCommand{std::move(*source)}})
                      : std::nullopt;
    }
    if (*kind == "if") {
        decoder.object(value, pointer, {"condition", "else", "id", "kind", "then"});
        const auto* condition_value = decoder.member(value, "condition", pointer);
        const auto* then_value = decoder.member(value, "then", pointer);
        const auto* else_value = decoder.member(value, "else", pointer);
        auto condition = condition_value
                             ? decode_condition_impl(decoder, *condition_value,
                                                     pointer_child(pointer, "condition"))
                             : std::nullopt;
        auto then_commands = then_value ? decode_gameplay_commands(decoder, *then_value,
                                                                   pointer_child(pointer, "then"))
                                        : std::nullopt;
        auto else_commands = else_value ? decode_gameplay_commands(decoder, *else_value,
                                                                   pointer_child(pointer, "else"))
                                        : std::nullopt;
        return condition && then_commands && else_commands
                   ? std::optional<GameplayCommand>(GameplayCommand{
                         std::move(*id),
                         IfGameplayCommand{std::move(*condition), std::move(*then_commands),
                                           std::move(*else_commands)}})
                   : std::nullopt;
    }

    decoder.object(value, pointer, {"id", "kind"});
    decoder.error(k_code_variant, "Unknown Gameplay Command variant '" + *kind + "'.",
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
    if (x && width && *x + *width > 1.0) {
        decoder.error(k_code_number, "Rectangle exceeds normalized width.",
                      pointer_child(pointer, "width"));
        width.reset();
    }
    if (y && height && *y + *height > 1.0) {
        decoder.error(k_code_number, "Rectangle exceeds normalized height.",
                      pointer_child(pointer, "height"));
        height.reset();
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

namespace {
std::optional<InventoryOwnerRef>
decode_inventory_owner(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an Inventory owner object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "project") {
        decoder.object(value, pointer, {"kind"});
        return InventoryOwnerRef{ProjectInventoryOwner{}};
    }
    if (*kind == "character") {
        decoder.object(value, pointer, {"character", "kind"});
        const auto* character_value = decoder.member(value, "character", pointer);
        auto character =
            character_value
                ? decode_reference<CharacterId>(decoder, *character_value,
                                                pointer_child(pointer, "character"), "character")
                : std::nullopt;
        return character ? std::optional<InventoryOwnerRef>(CharacterInventoryOwner{*character})
                         : std::nullopt;
    }
    if (*kind == "interactable") {
        decoder.object(value, pointer, {"interactable", "kind"});
        const auto* interactable_value = decoder.member(value, "interactable", pointer);
        auto interactable = interactable_value
                                ? decode_reference<InteractableInstanceId>(
                                      decoder, *interactable_value,
                                      pointer_child(pointer, "interactable"), "interactable")
                                : std::nullopt;
        return interactable
                   ? std::optional<InventoryOwnerRef>(InteractableInventoryOwner{*interactable})
                   : std::nullopt;
    }
    if (*kind == "room-feature") {
        decoder.object(value, pointer, {"featureId", "kind", "room"});
        const auto* feature_value = decoder.member(value, "featureId", pointer);
        const auto* room_value = decoder.member(value, "room", pointer);
        auto feature = feature_value ? decoder.id<FeatureId>(*feature_value,
                                                             pointer_child(pointer, "featureId"))
                                     : std::nullopt;
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        return feature && room ? std::optional<InventoryOwnerRef>(RoomFeatureRef{*room, *feature})
                               : std::nullopt;
    }
    if (*kind == "interactable-feature") {
        decoder.object(value, pointer, {"featureId", "interactable", "kind"});
        const auto* feature_value = decoder.member(value, "featureId", pointer);
        const auto* interactable_value = decoder.member(value, "interactable", pointer);
        auto feature = feature_value ? decoder.id<FeatureId>(*feature_value,
                                                             pointer_child(pointer, "featureId"))
                                     : std::nullopt;
        auto interactable = interactable_value
                                ? decode_reference<InteractableInstanceId>(
                                      decoder, *interactable_value,
                                      pointer_child(pointer, "interactable"), "interactable")
                                : std::nullopt;
        return feature && interactable ? std::optional<InventoryOwnerRef>(
                                             InteractableFeatureRef{*interactable, *feature})
                                       : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown Inventory owner variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<InventoryRef> decode_inventory_ref(Decoder& decoder, const nlohmann::json& value,
                                                 std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"inventoryId", "owner"}))
        return std::nullopt;
    const auto* owner_value = decoder.member(value, "owner", pointer);
    const auto* inventory_value = decoder.member(value, "inventoryId", pointer);
    auto owner =
        owner_value ? decode_inventory_owner(decoder, *owner_value, pointer_child(pointer, "owner"))
                    : std::nullopt;
    auto inventory =
        inventory_value
            ? decoder.id<InventoryId>(*inventory_value, pointer_child(pointer, "inventoryId"))
            : std::nullopt;
    return owner && inventory
               ? std::optional<InventoryRef>(InventoryRef{std::move(*owner), *inventory})
               : std::nullopt;
}

std::optional<GameplayIdentityOperand> decode_gameplay_identity_operand(Decoder& decoder,
                                                                        const nlohmann::json& value,
                                                                        std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a gameplay identity operand object.",
                      std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "room") {
        decoder.object(value, pointer, {"kind", "room"});
        const auto* member = decoder.member(value, "room", pointer);
        auto room = member ? decode_reference<RoomId>(decoder, *member,
                                                      pointer_child(pointer, "room"), "room")
                           : std::nullopt;
        return room ? std::optional<GameplayIdentityOperand>(*room) : std::nullopt;
    }
    if (*kind == "character") {
        decoder.object(value, pointer, {"character", "kind"});
        const auto* member = decoder.member(value, "character", pointer);
        auto character =
            member ? decode_reference<CharacterId>(decoder, *member,
                                                   pointer_child(pointer, "character"), "character")
                   : std::nullopt;
        return character ? std::optional<GameplayIdentityOperand>(*character) : std::nullopt;
    }
    if (*kind == "interactable") {
        decoder.object(value, pointer, {"interactable", "kind"});
        const auto* member = decoder.member(value, "interactable", pointer);
        auto interactable =
            member ? decode_reference<InteractableInstanceId>(
                         decoder, *member, pointer_child(pointer, "interactable"), "interactable")
                   : std::nullopt;
        return interactable ? std::optional<GameplayIdentityOperand>(*interactable) : std::nullopt;
    }
    if (*kind == "room-feature") {
        decoder.object(value, pointer, {"featureId", "kind", "room"});
        const auto* room_value = decoder.member(value, "room", pointer);
        const auto* feature_value = decoder.member(value, "featureId", pointer);
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        auto feature = feature_value ? decoder.id<FeatureId>(*feature_value,
                                                             pointer_child(pointer, "featureId"))
                                     : std::nullopt;
        return room && feature
                   ? std::optional<GameplayIdentityOperand>(RoomFeatureRef{*room, *feature})
                   : std::nullopt;
    }
    if (*kind == "interactable-feature") {
        decoder.object(value, pointer, {"featureId", "interactable", "kind"});
        const auto* interactable_value = decoder.member(value, "interactable", pointer);
        const auto* feature_value = decoder.member(value, "featureId", pointer);
        auto interactable = interactable_value
                                ? decode_reference<InteractableInstanceId>(
                                      decoder, *interactable_value,
                                      pointer_child(pointer, "interactable"), "interactable")
                                : std::nullopt;
        auto feature = feature_value ? decoder.id<FeatureId>(*feature_value,
                                                             pointer_child(pointer, "featureId"))
                                     : std::nullopt;
        return interactable && feature ? std::optional<GameplayIdentityOperand>(
                                             InteractableFeatureRef{*interactable, *feature})
                                       : std::nullopt;
    }
    if (*kind == "current-room") {
        decoder.object(value, pointer, {"kind"});
        return GameplayIdentityOperand{CurrentRoomOperand{}};
    }
    if (*kind == "interaction-slot") {
        decoder.object(value, pointer, {"kind", "slotId"});
        const auto* slot_value = decoder.member(value, "slotId", pointer);
        auto slot = slot_value
                        ? decoder.id<VerbSlotId>(*slot_value, pointer_child(pointer, "slotId"))
                        : std::nullopt;
        return slot ? std::optional<GameplayIdentityOperand>(InteractionSlotOperand{*slot})
                    : std::nullopt;
    }
    if (*kind == "command-result") {
        decoder.object(value, pointer, {"bindingId", "kind"});
        const auto* binding_value = decoder.member(value, "bindingId", pointer);
        auto binding = binding_value ? decoder.id<CommandResultBindingId>(
                                           *binding_value, pointer_child(pointer, "bindingId"))
                                     : std::nullopt;
        return binding ? std::optional<GameplayIdentityOperand>(CommandResultOperand{*binding})
                       : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown gameplay identity operand variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<InteractableOperand>
decode_interactable_operand(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    auto decoded = decode_gameplay_identity_operand(decoder, value, pointer);
    if (!decoded)
        return std::nullopt;
    if (const auto* interactable = std::get_if<InteractableInstanceId>(&*decoded))
        return InteractableOperand{*interactable};
    if (const auto* slot = std::get_if<InteractionSlotOperand>(&*decoded))
        return InteractableOperand{*slot};
    if (const auto* result = std::get_if<CommandResultOperand>(&*decoded))
        return InteractableOperand{*result};
    decoder.error(k_code_variant, "Operand cannot resolve an Interactable.", std::string(pointer));
    return std::nullopt;
}

std::optional<LocationSubjectOperand> decode_location_subject_operand(Decoder& decoder,
                                                                      const nlohmann::json& value,
                                                                      std::string_view pointer)
{
    auto decoded = decode_gameplay_identity_operand(decoder, value, pointer);
    if (!decoded)
        return std::nullopt;
    if (const auto* character = std::get_if<CharacterId>(&*decoded))
        return LocationSubjectOperand{*character};
    if (const auto* interactable = std::get_if<InteractableInstanceId>(&*decoded))
        return LocationSubjectOperand{*interactable};
    if (const auto* slot = std::get_if<InteractionSlotOperand>(&*decoded))
        return LocationSubjectOperand{*slot};
    if (const auto* result = std::get_if<CommandResultOperand>(&*decoded))
        return LocationSubjectOperand{*result};
    decoder.error(k_code_variant, "Operand cannot expose a Location.", std::string(pointer));
    return std::nullopt;
}

std::optional<RoomOperand> decode_room_operand(Decoder& decoder, const nlohmann::json& value,
                                               std::string_view pointer)
{
    auto decoded = decode_gameplay_identity_operand(decoder, value, pointer);
    if (!decoded)
        return std::nullopt;
    if (const auto* room = std::get_if<RoomId>(&*decoded))
        return RoomOperand{*room};
    if (std::holds_alternative<CurrentRoomOperand>(*decoded))
        return RoomOperand{CurrentRoomOperand{}};
    if (const auto* result = std::get_if<CommandResultOperand>(&*decoded))
        return RoomOperand{*result};
    decoder.error(k_code_variant, "Operand cannot resolve a Room.", std::string(pointer));
    return std::nullopt;
}

std::optional<InventoryOwnerOperand> decode_inventory_owner_operand(Decoder& decoder,
                                                                    const nlohmann::json& value,
                                                                    std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an Inventory owner operand object.",
                      std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "project") {
        decoder.object(value, pointer, {"kind"});
        return InventoryOwnerOperand{ProjectInventoryOwnerOperand{}};
    }
    auto identity = decode_gameplay_identity_operand(decoder, value, pointer);
    if (!identity)
        return std::nullopt;
    if (const auto* character = std::get_if<CharacterId>(&*identity))
        return InventoryOwnerOperand{*character};
    if (const auto* interactable = std::get_if<InteractableInstanceId>(&*identity))
        return InventoryOwnerOperand{*interactable};
    if (const auto* room_feature = std::get_if<RoomFeatureRef>(&*identity))
        return InventoryOwnerOperand{*room_feature};
    if (const auto* interactable_feature = std::get_if<InteractableFeatureRef>(&*identity))
        return InventoryOwnerOperand{*interactable_feature};
    if (const auto* slot = std::get_if<InteractionSlotOperand>(&*identity))
        return InventoryOwnerOperand{*slot};
    if (const auto* result = std::get_if<CommandResultOperand>(&*identity))
        return InventoryOwnerOperand{*result};
    decoder.error(k_code_variant, "Operand cannot own an Inventory.", std::string(pointer));
    return std::nullopt;
}

std::optional<InventoryOperand>
decode_inventory_operand(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an Inventory operand object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "inventory") {
        decoder.object(value, pointer, {"inventory", "kind"});
        const auto* inventory_value = decoder.member(value, "inventory", pointer);
        auto inventory = inventory_value ? decode_inventory_ref(decoder, *inventory_value,
                                                                pointer_child(pointer, "inventory"))
                                         : std::nullopt;
        return inventory ? std::optional<InventoryOperand>(ExactInventoryOperand{*inventory})
                         : std::nullopt;
    }
    if (*kind == "player-inventory") {
        decoder.object(value, pointer, {"kind"});
        return InventoryOperand{PlayerInventoryOperand{}};
    }
    if (*kind == "owner-inventory") {
        decoder.object(value, pointer, {"inventoryId", "kind", "owner"});
        const auto* owner_value = decoder.member(value, "owner", pointer);
        const auto* inventory_value = decoder.member(value, "inventoryId", pointer);
        auto owner = owner_value ? decode_inventory_owner_operand(decoder, *owner_value,
                                                                  pointer_child(pointer, "owner"))
                                 : std::nullopt;
        auto inventory =
            inventory_value
                ? decoder.id<InventoryId>(*inventory_value, pointer_child(pointer, "inventoryId"))
                : std::nullopt;
        return owner && inventory ? std::optional<InventoryOperand>(
                                        OwnerInventoryOperand{std::move(*owner), *inventory})
                                  : std::nullopt;
    }
    if (*kind == "command-result") {
        decoder.object(value, pointer, {"bindingId", "kind"});
        const auto* binding_value = decoder.member(value, "bindingId", pointer);
        auto binding = binding_value ? decoder.id<CommandResultBindingId>(
                                           *binding_value, pointer_child(pointer, "bindingId"))
                                     : std::nullopt;
        return binding ? std::optional<InventoryOperand>(CommandResultOperand{*binding})
                       : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown Inventory operand variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<LocationOperand>
decode_location_operand(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a Location operand object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "unplaced") {
        decoder.object(value, pointer, {"kind"});
        return LocationOperand{UnplacedLocation{}};
    }
    if (*kind == "room") {
        decoder.object(value, pointer, {"kind", "room"});
        const auto* room_value = decoder.member(value, "room", pointer);
        auto room = room_value
                        ? decode_room_operand(decoder, *room_value, pointer_child(pointer, "room"))
                        : std::nullopt;
        return room ? std::optional<LocationOperand>(RoomLocationOperand{std::move(*room)})
                    : std::nullopt;
    }
    if (*kind == "inventory") {
        decoder.object(value, pointer, {"inventory", "kind"});
        const auto* inventory_value = decoder.member(value, "inventory", pointer);
        auto inventory = inventory_value
                             ? decode_inventory_operand(decoder, *inventory_value,
                                                        pointer_child(pointer, "inventory"))
                             : std::nullopt;
        return inventory
                   ? std::optional<LocationOperand>(InventoryLocationOperand{std::move(*inventory)})
                   : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown Location operand variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<ConditionInteractableMatcher>
decode_condition_interactable_matcher(Decoder& decoder, const nlohmann::json& value,
                                      std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"definition", "exact", "properties", "traits"}))
        return std::nullopt;
    std::optional<InteractableDefinitionId> definition;
    if (const auto* definition_value = json_access::member(value, "definition")) {
        definition = decode_reference<InteractableDefinitionId>(
            decoder, *definition_value, pointer_child(pointer, "definition"),
            "interactable-definition");
        if (!definition)
            return std::nullopt;
    }
    const auto* traits_value = decoder.member(value, "traits", pointer);
    const auto* properties_value = decoder.member(value, "properties", pointer);
    auto traits =
        traits_value
            ? decoder.array<TraitId>(
                  *traits_value, pointer_child(pointer, "traits"),
                  [&](const nlohmann::json& trait,
                      const std::string& item_pointer) -> std::optional<TraitId> {
                      return decode_reference<TraitId>(decoder, trait, item_pointer, "trait");
                  })
            : std::nullopt;
    auto properties =
        properties_value
            ? decoder.array<InteractablePropertyMatch>(
                  *properties_value, pointer_child(pointer, "properties"),
                  [&](const nlohmann::json& item,
                      const std::string& item_pointer) -> std::optional<InteractablePropertyMatch> {
                      if (!decoder.object(item, item_pointer, {"propertyId", "value"}))
                          return std::nullopt;
                      const auto* property_value = decoder.member(item, "propertyId", item_pointer);
                      const auto* runtime_value = decoder.member(item, "value", item_pointer);
                      auto property =
                          property_value
                              ? decoder.id<PropertyId>(*property_value,
                                                       pointer_child(item_pointer, "propertyId"))
                              : std::nullopt;
                      auto decoded_value =
                          runtime_value ? decode_runtime_value(decoder, *runtime_value,
                                                               pointer_child(item_pointer, "value"))
                                        : std::nullopt;
                      return property && decoded_value
                                 ? std::optional<InteractablePropertyMatch>(
                                       InteractablePropertyMatch{*property, *decoded_value})
                                 : std::nullopt;
                  })
            : std::nullopt;
    std::optional<InteractableOperand> exact;
    if (const auto* exact_value = json_access::member(value, "exact")) {
        exact = decode_interactable_operand(decoder, *exact_value, pointer_child(pointer, "exact"));
        if (!exact)
            return std::nullopt;
    }
    return traits && properties
               ? std::optional<ConditionInteractableMatcher>(
                     ConditionInteractableMatcher{std::move(definition), std::move(*traits),
                                                  std::move(*properties), std::move(exact)})
               : std::nullopt;
}
} // namespace

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
        decoder.object(value, pointer, {"inventory", "kind"});
        const auto* inventory_value = decoder.member(value, "inventory", pointer);
        auto inventory = inventory_value ? decode_inventory_ref(decoder, *inventory_value,
                                                                pointer_child(pointer, "inventory"))
                                         : std::nullopt;
        return inventory
                   ? std::optional<InteractableLocation>(InventoryLocation{std::move(*inventory)})
                   : std::nullopt;
    }
    if (*kind == "unplaced") {
        decoder.object(value, pointer, {"kind"});
        return InteractableLocation{UnplacedLocation{}};
    }
    if (*kind == "room") {
        decoder.object(value, pointer, {"kind", "room"});
        const auto* room_value = decoder.member(value, "room", pointer);
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        return room ? std::optional<InteractableLocation>(RoomLocation{*room}) : std::nullopt;
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
