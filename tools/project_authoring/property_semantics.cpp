#include "property_semantics.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

const Json* field(const Json* value, const char* name)
{
    return value && value->is_object() && value->contains(name) ? &value->at(name) : nullptr;
}

Json* field(Json* value, const char* name)
{
    return value && value->is_object() && value->contains(name) ? &value->at(name) : nullptr;
}

std::string string_field(const Json* value, const char* name)
{
    const auto* member = field(value, name);
    return member && member->is_string() ? member->as<std::string>() : std::string{};
}

std::string pointer_token(std::string_view value)
{
    std::string escaped;
    for (const auto c : value) {
        if (c == '~')
            escaped += "~0";
        else if (c == '/')
            escaped += "~1";
        else
            escaped += c;
    }
    return escaped;
}

std::string reference_id(const Json* value)
{
    if (!value)
        return {};
    if (value->is_string())
        return value->as<std::string>();
    if (const auto* ref = field(value, "$ref"))
        return string_field(ref, "id");
    return {};
}

void report(ValidationResult& result, std::string path, std::string code, std::string message)
{
    result.accepted = false;
    result.diagnostics.push_back({std::move(path), std::move(code), std::move(message)});
}

bool compatible(const Json& declaration, const Json& value, bool trim_enum = false)
{
    if (value.is_null())
        return field(&declaration, "nullable") && declaration.at("nullable") == true;
    const auto type = string_field(&declaration, "type");
    if (type == "boolean")
        return value.is_bool();
    if (type == "integer")
        return value.is_number() && std::isfinite(value.as<double>()) &&
               std::trunc(value.as<double>()) == value.as<double>();
    if (type == "number")
        return value.is_number() && std::isfinite(value.as<double>());
    if (type == "string")
        return value.is_string();
    if (type == "message")
        return value.is_object() && value.size() == 1 && field(&value, "$message") &&
               value.at("$message").is_string();
    if (type == "enum" && value.is_string()) {
        const auto* choices = field(&declaration, "enumValues");
        if (choices && choices->is_array()) {
            for (const auto& choice : choices->array_range()) {
                if (choice.is_string() &&
                    (trim_enum ? trim_ecmascript(choice.as<std::string>())
                               : choice.as<std::string>()) == value.as<std::string>())
                    return true;
            }
        }
    }
    return false;
}

bool schema_compatible(const Json& left, const Json& right)
{
    if (left.at("type") != right.at("type") || left.at("nullable") != right.at("nullable"))
        return false;
    if (left.at("type") != "enum")
        return true;
    const auto* a = field(&left, "enumValues");
    const auto* b = field(&right, "enumValues");
    if (!a || !b)
        return !a && !b;
    return *a == *b;
}

bool value_equal(const Json& a, const Json& b)
{
    // JSON objects representing typed Message refs compare by named key.
    if (const auto* key = field(&a, "$message")) {
        const auto* other = field(&b, "$message");
        return other && *key == *other;
    }
    return a == b;
}

struct Contribution {
    const Json* schema;
    std::string trait_id;
};

void validate_attachment(ValidationResult& result, const Json& owner, const Json& traits,
                         std::string_view owner_kind, const std::string& base, bool concrete,
                         const char* local_field)
{
    const auto* attachments = field(&owner, "traits");
    if (!attachments || !attachments->is_array())
        return;
    std::set<std::string> seen;
    std::map<std::string, Contribution> contributed;
    std::map<std::string, Contribution> defaults;
    std::map<std::string, const Json*> local;
    if (const auto* properties = field(&owner, local_field); properties && properties->is_array())
        for (const auto& property : properties->array_range())
            local[string_field(&property, "id")] = &property;

    std::size_t index = 0;
    for (const auto& attachment : attachments->array_range()) {
        const auto id = attachment.as<std::string>();
        const auto path = base + "/traits/" + std::to_string(index++);
        if (!seen.insert(id).second) {
            report(result, path, "authoring.trait.duplicate_attachment",
                   "Trait '" + id + "' is attached more than once.");
            continue;
        }
        const auto* trait = field(&traits, id.c_str());
        if (!trait) {
            report(result, path, "authoring.trait.missing", "Trait '" + id + "' is not declared.");
            continue;
        }
        const auto* kinds = field(trait, "ownerKinds");
        if (!kinds || std::none_of(kinds->array_range().begin(), kinds->array_range().end(),
                                   [&](const Json& kind) { return kind == owner_kind; })) {
            report(result, path, "authoring.trait.owner_kind",
                   "Trait '" + id + "' cannot be attached to " + std::string(owner_kind) + ".");
            continue;
        }
        const auto* members = field(trait, "properties");
        if (!members)
            continue;
        for (const auto& member : members->array_range()) {
            const auto key = string_field(&member, "id");
            if (const auto it = contributed.find(key); it != contributed.end()) {
                if (!schema_compatible(*it->second.schema, member))
                    report(result, path, "authoring.trait.schema_conflict",
                           "Trait '" + id + "' contributes property '" + key +
                               "' with a schema incompatible with Trait '" + it->second.trait_id +
                               "'.");
            } else {
                contributed.emplace(key, Contribution{&member, id});
            }
            if (const auto* value = field(&member, "defaultValue")) {
                if (const auto it = defaults.find(key); it != defaults.end()) {
                    if (!value_equal(*field(it->second.schema, "defaultValue"), *value))
                        report(result, path, "authoring.trait.default_conflict",
                               "Trait '" + id + "' provides a conflicting Default for property '" +
                                   key + "' with Trait '" + it->second.trait_id + "'.");
                } else {
                    defaults.emplace(key, Contribution{&member, id});
                }
            }
        }
    }

    for (const auto& [key, contribution] : contributed) {
        if (const auto it = local.find(key); it != local.end()) {
            if (!schema_compatible(*it->second, *contribution.schema))
                report(result, base + "/" + local_field, "authoring.trait.local_schema_conflict",
                       "Local Property '" + key + "' is incompatible with Trait '" +
                           contribution.trait_id + "'.");
        }
    }
    if (concrete) {
        for (const auto& [key, contribution] : contributed)
            if (!local.contains(key) && !defaults.contains(key))
                report(result, base + "/traits", "authoring.trait.required_value",
                       "Trait '" + contribution.trait_id + "' requires property '" + key +
                           "' to have an authored value.");
    }
}

void visit_references(ValidationResult& result, const Json& value, const std::string& path,
                      const Json& traits, const VariableResolver& variables)
{
    if (value.is_array()) {
        for (std::size_t i = 0; i < value.size(); ++i)
            visit_references(result, value.at(i), path + "/" + std::to_string(i), traits,
                             variables);
    } else if (value.is_object()) {
        const auto kind = string_field(&value, "kind");
        if (kind == "variable-comparison") {
            const auto id = reference_id(field(&value, "variable"));
            const auto variable = variables(id);
            if (!variable) {
                report(result, path + "/variable/$ref", "authoring.condition.variable-missing",
                       "Missing variable '" + id + "'.");
            } else {
                const auto record = Json::parse(*variable);
                const auto* data = field(&record, "data");
                const auto* compared = field(&value, "value");
                if (data && compared && !compatible(*data, *compared, true))
                    report(result, path + "/value", "authoring.condition.variable-type-mismatch",
                           "Value does not match variable '" + id + "'.");
            }
        } else if (kind == "trait-presence") {
            const auto id = reference_id(field(&value, "trait"));
            if (!traits.contains(id))
                report(result, path + "/trait", "authoring.trait.missing_reference",
                       "Trait '" + id + "' is not declared.");
        }
        for (const auto& entry : value.object_range())
            visit_references(result, entry.value(), path + "/" + pointer_token(entry.key()), traits,
                             variables);
    }
}

} // namespace

ValidationResult validate_interactable_source(std::string_view source_json)
{
    auto record = Json::parse(source_json);
    if (!record.is_object())
        return validate_record("InteractablesRecord", source_json);
    auto* data = field(&record, "data");
    if (!data || !data->is_object())
        return validate_record("InteractablesRecord", source_json);
    if (!data->contains("kind"))
        data->insert_or_assign("kind", "interactable");
    if (!data->contains("features"))
        data->insert_or_assign("features", Json::array());
    if (!data->contains("inventories"))
        data->insert_or_assign("inventories", Json::array());
    if (!data->contains("presentation"))
        data->insert_or_assign(
            "presentation",
            Json::parse(
                R"({"visual":null,"materialApplication":null,"hotspots":{"kind":"none"}})"));
    if (auto* presentation = field(data, "presentation");
        presentation && presentation->is_object()) {
        if (!presentation->contains("visual"))
            presentation->insert_or_assign("visual", Json::null());
        if (!presentation->contains("materialApplication"))
            presentation->insert_or_assign("materialApplication", Json::null());
        if (!presentation->contains("hotspots"))
            presentation->insert_or_assign("hotspots", Json::parse(R"({"kind":"none"})"));
        if (auto* visual = field(presentation, "visual"); visual && visual->is_object()) {
            if (visual->contains("kind") && visual->at("kind") == "image") {
                if (auto* image = field(visual, "image"); image && image->is_string()) {
                    const auto id = image->as<std::string>();
                    *image = Json::parse(R"({"$ref":{"collection":"assets","id":""}})");
                    image->at("$ref").at("id") = id;
                }
            }
        }
    }
    auto* features = field(data, "features");
    if (features && features->is_array()) {
        for (auto& feature : features->array_range()) {
            if (!feature.is_object())
                continue;
            for (const auto* field_name :
                 {"traits", "localProperties", "defaultProperties", "inventories"})
                if (!feature.contains(field_name))
                    feature.insert_or_assign(field_name, Json::array());
        }
    }
    // The condition schema's authored scalar 'always' is a separate sparse
    // representation from its normalized tagged form.
    const auto expand_conditions = [&](auto&& self, Json& value) -> void {
        if (value.is_object()) {
            for (auto& entry : value.object_range()) {
                if (entry.key() == "condition" && entry.value() == "always")
                    entry.value() = Json::parse(R"({"kind":"always"})");
                else
                    self(self, entry.value());
            }
        } else if (value.is_array()) {
            for (auto& entry : value.array_range())
                self(self, entry);
        }
    };
    expand_conditions(expand_conditions, record);
    return validate_record("InteractablesRecord", record.to_string());
}

ValidationResult validate_variable_semantics(std::string_view record_json)
{
    ValidationResult result;
    result.accepted = true;
    const auto record = Json::parse(record_json);
    const auto* data = field(&record, "data");
    if (!data)
        return result;
    if (string_field(data, "type") == "enum") {
        const auto* values = field(data, "enumValues");
        if (!values || values->empty())
            report(result, "/data/enumValues", "authoring.variable.enum_empty",
                   "Enum variables require at least one enum value.");
        if (values) {
            std::set<std::string> seen;
            std::size_t i = 0;
            for (const auto& item : values->array_range()) {
                const auto value = item.as<std::string>();
                if (trim_ecmascript(value).empty())
                    report(result, "/data/enumValues/" + std::to_string(i),
                           "authoring.variable.enum_blank", "Enum values cannot be empty.");
                if (!seen.insert(value).second)
                    report(result, "/data/enumValues/" + std::to_string(i),
                           "authoring.variable.enum_duplicate",
                           "Duplicate enum value '" + value + "'.");
                ++i;
            }
        }
    }
    const auto* value = field(data, "value");
    if (value && !compatible(*data, *value, true))
        report(result, "/data/value", "authoring.variable.value_type",
               "Value does not match " + string_field(data, "type") + ".");
    return result;
}

ValidationResult validate_property_dependencies(std::string_view family,
                                                std::string_view record_json,
                                                std::string_view traits_json,
                                                const VariableResolver& variables)
{
    ValidationResult result;
    result.accepted = true;
    const auto record = Json::parse(record_json);
    const auto traits = Json::parse(traits_json);
    if (family == "rooms" || family == "characters" || family == "interactables") {
        const auto kind = family == "rooms"        ? "room"
                          : family == "characters" ? "character"
                                                   : "interactable";
        validate_attachment(result, record, traits, kind, "", family != "interactables",
                            family == "interactables" ? "defaultProperties" : "localProperties");
        const auto* data = field(&record, "data");
        if (const auto* features = field(data, "features"); features && features->is_array()) {
            std::size_t index = 0;
            std::set<std::string> seen_features;
            for (const auto& feature : features->array_range()) {
                const auto path = "/data/features/" + std::to_string(index++);
                const auto id = string_field(&feature, "id");
                if (!seen_features.insert(id).second)
                    report(result, path + "/id", "authoring.feature.duplicate",
                           "Feature '" + id + "' is declared more than once.");
                const auto* forbidden = field(
                    &feature, family == "interactables" ? "localProperties" : "defaultProperties");
                if (forbidden && forbidden->is_array() && !forbidden->empty())
                    report(result,
                           path + (family == "interactables" ? "/localProperties"
                                                             : "/defaultProperties"),
                           "authoring.feature.property_mode",
                           family == "interactables"
                               ? "Interactable-definition Features use Property Defaults, not "
                                 "concrete local Values."
                               : "Room Features are concrete and use Property Values, not "
                                 "definition Defaults.");
                validate_attachment(
                    result, feature, traits, "feature", path, family != "interactables",
                    family == "interactables" ? "defaultProperties" : "localProperties");
            }
        }
    }
    visit_references(result, record, "", traits, variables);
    return result;
}

ValidationResult validate_interactable_instance(std::string_view instance_json,
                                                std::string_view definition_json,
                                                std::string_view traits_json)
{
    ValidationResult result;
    result.accepted = true;
    const auto instance = Json::parse(instance_json);
    const auto definition = Json::parse(definition_json);
    const auto traits = Json::parse(traits_json);
    const auto* delta = field(&instance, "traits");
    std::set<std::string> inherited;
    if (const auto* ids = field(&definition, "traits"); ids && ids->is_array())
        for (const auto& id : ids->array_range())
            inherited.insert(id.as<std::string>());
    auto effective_traits = inherited;
    std::set<std::string> added, removed;
    for (const auto* action : {"add", "remove"}) {
        if (const auto* ids = field(delta, action); ids && ids->is_array()) {
            for (std::size_t i = 0; i < ids->size(); ++i) {
                const auto id = ids->at(i).as<std::string>();
                const auto path = "/traits/" + std::string(action) + "/" + std::to_string(i);
                auto& seen = std::string_view(action) == "add" ? added : removed;
                if (!seen.insert(id).second)
                    report(result, path, "authoring.trait.duplicate_delta",
                           "Trait '" + id + "' appears more than once in the Instance delta.");
                if (std::string_view(action) == "add") {
                    if (inherited.contains(id))
                        report(result, path, "authoring.trait.inherited_add",
                               "Trait '" + id + "' is already inherited from the definition.");
                    effective_traits.insert(id);
                } else {
                    if (!inherited.contains(id))
                        report(result, path, "authoring.trait.uninherited_remove",
                               "Trait '" + id + "' is not inherited from the definition.");
                    if (added.contains(id))
                        report(result, path, "authoring.trait.add_remove",
                               "Trait '" + id + "' cannot be both added and removed.");
                    effective_traits.erase(id);
                }
            }
        }
    }
    struct Effective {
        const Json* schema;
        const Json* fallback;
    };
    std::map<std::string, Effective> properties;
    for (const auto& id : effective_traits) {
        const auto* trait = field(&traits, id.c_str());
        const auto* kinds = field(trait, "ownerKinds");
        if (!trait) {
            report(result, "/traits", "authoring.trait.missing",
                   "Trait '" + id + "' is not declared.");
            continue;
        }
        if (!kinds || std::none_of(kinds->array_range().begin(), kinds->array_range().end(),
                                   [](const Json& kind) { return kind == "interactable"; })) {
            report(result, "/traits", "authoring.trait.owner_kind",
                   "Trait '" + id + "' cannot be attached to interactable.");
            continue;
        }
        const auto* members = field(trait, "properties");
        if (!members)
            continue;
        for (const auto& member : members->array_range()) {
            const auto key = string_field(&member, "id");
            const auto* fallback = field(&member, "defaultValue");
            const auto existing = properties.find(key);
            if (existing == properties.end()) {
                properties.emplace(key, Effective{&member, fallback});
            } else {
                if (!schema_compatible(*existing->second.schema, member))
                    report(result, "/traits", "authoring.trait.schema_conflict",
                           "Trait Properties disagree about the schema for '" + key + "'.");
                if (existing->second.fallback && fallback &&
                    !value_equal(*existing->second.fallback, *fallback))
                    report(result, "/traits", "authoring.trait.default_conflict",
                           "Trait Defaults disagree for '" + key + "'.");
                if (!existing->second.fallback)
                    existing->second.fallback = fallback;
            }
        }
    }
    if (const auto* defaults = field(&definition, "defaultProperties");
        defaults && defaults->is_array()) {
        for (const auto& property : defaults->array_range()) {
            const auto key = string_field(&property, "id");
            const auto specific = field(&property, "defaultValue");
            auto& existing = properties[key];
            existing.schema = &property;
            if (specific)
                existing.fallback = specific;
        }
    }
    std::set<std::string> local_ids;
    if (const auto* local = field(&instance, "localProperties"); local && local->is_array()) {
        for (std::size_t i = 0; i < local->size(); ++i) {
            const auto& property = local->at(i);
            const auto key = string_field(&property, "id");
            local_ids.insert(key);
            const auto existing = properties.find(key);
            if (existing != properties.end() &&
                !schema_compatible(*existing->second.schema, property))
                report(result, "/localProperties/" + std::to_string(i),
                       "authoring.interactable.instance_property_schema",
                       "Instance-local Property '" + key +
                           "' is incompatible with its inherited Property schema.");
        }
    }
    for (const auto& [key, property] : properties)
        if (!local_ids.contains(key) && !property.fallback)
            report(result, "/localProperties", "authoring.interactable.missing_property_value",
                   "Interactable Instance requires Property '" + key + "' to have a Value.");
    return result;
}

} // namespace noveltea::authoring
