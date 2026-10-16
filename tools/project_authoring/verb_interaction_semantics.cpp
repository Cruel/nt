#include "verb_interaction_semantics.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <utility>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

const Json* field(const Json* value, std::string_view key)
{
    return value && value->is_object() && value->contains(key) ? &value->at(key) : nullptr;
}

const Json* item(const Json* value, std::size_t index)
{
    return value && value->is_array() && index < value->size() ? &value->at(index) : nullptr;
}

std::string str(const Json* value, std::string_view key)
{
    const auto* member = field(value, key);
    return member && member->is_string() ? member->as<std::string>() : std::string{};
}

std::string ref(const Json* value) { return str(field(value, "$ref"), "id"); }

void report(ValidationResult& out, std::string path, std::string code, std::string message,
            std::string severity = "error")
{
    if (severity == "error")
        out.accepted = false;
    out.diagnostics.push_back(
        {std::move(path), std::move(code), std::move(message), std::move(severity)});
}

std::string escaped(std::string_view value)
{
    std::string result;
    for (const char c : value) {
        if (c == '~')
            result += "~0";
        else if (c == '/')
            result += "~1";
        else
            result += c;
    }
    return result;
}

std::set<std::string> ids(const Json* values, std::string_view key = "id")
{
    std::set<std::string> result;
    if (values && values->is_array())
        for (const auto& value : values->array_range())
            result.insert(str(&value, key));
    return result;
}

enum class Truth {
    No,
    Yes,
    Unknown
};

Truth all(const std::vector<Truth>& values)
{
    if (std::find(values.begin(), values.end(), Truth::No) != values.end())
        return Truth::No;
    return std::find(values.begin(), values.end(), Truth::Unknown) != values.end() ? Truth::Unknown
                                                                                   : Truth::Yes;
}

Truth any(const std::vector<Truth>& values)
{
    if (std::find(values.begin(), values.end(), Truth::Yes) != values.end())
        return Truth::Yes;
    return std::find(values.begin(), values.end(), Truth::Unknown) != values.end() ? Truth::Unknown
                                                                                   : Truth::No;
}

bool variable_compatible(const Json& data, const Json& value)
{
    if (value.is_null())
        return field(&data, "nullable") && data.at("nullable") == true;
    const auto type = str(&data, "type");
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
        const auto* options = field(&data, "enumValues");
        if (options && options->is_array())
            for (const auto& entry : options->array_range())
                if (trim_ecmascript(entry.as<std::string>()) == value.as<std::string>())
                    return true;
    }
    return false;
}

std::string identity(const Json* subject)
{
    const auto kind = str(subject, "kind");
    if (kind == "character")
        return ref(field(subject, "character"));
    if (kind == "interactable")
        return ref(field(subject, "interactable"));
    const auto* feature = field(subject, "feature");
    return str(feature, "ownerKind") == "room"
               ? "room:" + ref(field(feature, "room")) + "#" + str(feature, "featureId")
               : "interactable:" + ref(field(feature, "interactable")) + "#" +
                     str(feature, "featureId");
}

Truth contained(const Json& narrow, const Json& broad)
{
    const auto a = str(&narrow, "kind");
    const auto b = str(&broad, "kind");
    if (b == "any-subject")
        return Truth::Yes;
    if (a == "any-subject")
        return Truth::No;
    if (a == "exact") {
        const auto* subject = field(&narrow, "subject");
        const auto family = str(subject, "kind");
        if (b == "trait")
            return Truth::Unknown;
        if (b == "family")
            return family == str(&broad, "family") ? Truth::Yes : Truth::No;
        if (b == "exact") {
            const auto* other = field(&broad, "subject");
            return family == str(other, "kind") && identity(subject) == identity(other) ? Truth::Yes
                                                                                        : Truth::No;
        }
        if (b == "qualified-pattern") {
            const auto pattern = str(&broad, "pattern");
            return family == str(&broad, "family") &&
                           identity(subject).starts_with(pattern.substr(0, pattern.size() - 1))
                       ? Truth::Yes
                       : Truth::No;
        }
        if ((b == "interactable-definition" && family == "interactable") ||
            (b == "interactable-feature" && family == "feature"))
            return Truth::Unknown;
        return Truth::No;
    }
    if (b == "exact")
        return Truth::No;
    if (a == "family")
        return b == "family" && str(&narrow, "family") == str(&broad, "family") ? Truth::Yes
                                                                                : Truth::No;
    if (a == "qualified-pattern") {
        if (b == "family")
            return str(&narrow, "family") == str(&broad, "family") ? Truth::Yes : Truth::No;
        const auto left = str(&narrow, "pattern");
        const auto right = str(&broad, "pattern");
        return b == "qualified-pattern" && str(&narrow, "family") == str(&broad, "family") &&
                       left.substr(0, left.size() - 1)
                           .starts_with(right.substr(0, right.size() - 1))
                   ? Truth::Yes
                   : Truth::No;
    }
    if (a == "interactable-definition" || a == "interactable-feature") {
        if (b == "family")
            return str(&broad, "family") ==
                           (a == "interactable-feature" ? "feature" : "interactable")
                       ? Truth::Yes
                       : Truth::No;
        return a == b &&
                       ref(field(&narrow, "interactableDefinition")) ==
                           ref(field(&broad, "interactableDefinition")) &&
                       (a != "interactable-feature" ||
                        str(&narrow, "featureId") == str(&broad, "featureId"))
                   ? Truth::Yes
                   : Truth::No;
    }
    return a == "trait" && b == "trait" &&
                   ref(field(&narrow, "trait")) == ref(field(&broad, "trait"))
               ? Truth::Yes
               : Truth::No;
}

Truth overlapping(const Json& a, const Json& b)
{
    const auto ab = contained(a, b);
    const auto ba = contained(b, a);
    if (ab == Truth::Yes || ba == Truth::Yes)
        return Truth::Yes;
    if (ab == Truth::Unknown || ba == Truth::Unknown)
        return Truth::Unknown;
    const auto ak = str(&a, "kind");
    const auto bk = str(&b, "kind");
    if (ak == "trait" || bk == "trait")
        return Truth::Unknown;
    if (ak == "qualified-pattern" && bk == "qualified-pattern" &&
        str(&a, "family") == str(&b, "family")) {
        const auto av = str(&a, "pattern");
        const auto bv = str(&b, "pattern");
        const auto as = av.substr(0, av.size() - 1);
        const auto bs = bv.substr(0, bv.size() - 1);
        return as.starts_with(bs) || bs.starts_with(as) ? Truth::Yes : Truth::No;
    }
    return Truth::No;
}

Truth selector_union(const Json* narrow, const Json* broad, bool overlap)
{
    if (!narrow || !broad || !narrow->is_array() || !broad->is_array())
        return Truth::No;
    std::vector<Truth> outer;
    for (const auto& a : narrow->array_range()) {
        std::vector<Truth> inner;
        for (const auto& b : broad->array_range())
            inner.push_back(overlap ? overlapping(a, b) : contained(a, b));
        outer.push_back(any(inner));
    }
    return overlap ? any(outer) : all(outer);
}

struct Relation {
    Truth overlap = Truth::No;
    Truth left_within = Truth::No;
    Truth right_within = Truth::No;
};

Relation relation(const Json& left, const Json& right)
{
    if (ref(field(&left, "verb")) != ref(field(&right, "verb")))
        return {};
    const auto* a = field(&left, "slots");
    const auto* b = field(&right, "slots");
    if (!a || !b || ids(a, "slotId") != ids(b, "slotId") || a->size() != b->size())
        return {};
    std::vector<Truth> overlap_values, left_values, right_values;
    for (const auto& slot : a->array_range()) {
        const auto id = str(&slot, "slotId");
        const Json* other = nullptr;
        for (const auto& candidate : b->array_range())
            if (str(&candidate, "slotId") == id) {
                other = &candidate;
                break;
            }
        const auto* ls = field(&slot, "selectors");
        const auto* rs = field(other, "selectors");
        overlap_values.push_back(selector_union(ls, rs, true));
        left_values.push_back(selector_union(ls, rs, false));
        right_values.push_back(selector_union(rs, ls, false));
    }
    return {all(overlap_values), all(left_values), all(right_values)};
}

void program_local(ValidationResult& out, const Json* program, const std::string& base)
{
    if (!program || !program->is_object())
        return;
    std::set<std::string> seen;
    const auto visit = [&](const auto& self, const Json* commands,
                           const std::string& path) -> void {
        if (!commands || !commands->is_array())
            return;
        for (std::size_t i = 0; i < commands->size(); ++i) {
            const auto* command = item(commands, i);
            const auto at = path + "/" + std::to_string(i);
            const auto id = str(command, "id");
            if (!seen.insert(id).second)
                report(out, at + "/id", "authoring.interaction.command-duplicate",
                       "Duplicate Gameplay Command ID '" + id + "'.");
            if (str(command, "kind") == "if") {
                self(self, field(command, "then"), at + "/then");
                self(self, field(command, "else"), at + "/else");
            }
        }
    };
    const auto* instructions = field(program, "instructions");
    visit(visit, instructions, base + "/instructions");
    if (str(program, "outcome") == "unhandled" && instructions && !instructions->empty())
        report(out, base, "authoring.interaction.unhandled-program",
               "An unhandled Interaction program must be empty so fallback cannot follow committed "
               "work.");
}

class References {
    ValidationResult& out_;
    const Json& manifest_;
    const Json& traits_;
    const AuthoringRecordResolver& resolve_;
    const std::function<bool(std::string_view, std::string_view)>& exists_;
    std::map<std::string, std::optional<Json>> cache_;

    const Json* record(std::string_view family, std::string_view id)
    {
        const std::string key = std::string(family) + "/" + std::string(id);
        auto [it, inserted] = cache_.try_emplace(key);
        if (inserted)
            if (const auto source = resolve_(family, id)) {
                const auto data = Json::parse(*source);
                if (family == "interactables" || family == "characters" || family == "rooms") {
                    const auto effective = validate_archetype_owner(family, *source, resolve_);
                    it->second = effective.accepted && !effective.effective_json.empty()
                                     ? Json::parse(effective.effective_json)
                                     : data;
                } else
                    it->second = data;
            }
        return it->second ? &*it->second : nullptr;
    }

    bool exists(std::string_view family, std::string_view id) const
    {
        if (family == "interactableInstances")
            return field(&manifest_, "interactableInstances") &&
                   manifest_.at("interactableInstances").contains(id);
        if (family == "traits")
            return traits_.is_object() && traits_.contains(id);
        return exists_(family, id);
    }

    void missing(std::string_view family, std::string_view id, const std::string& path,
                 std::string label)
    {
        if (!exists(family, id))
            report(out_, path, "authoring.interaction.reference-missing",
                   "Missing " + label + " '" + std::string(id) + "'.");
    }

    void feature(const Json* value, const std::string& path)
    {
        const auto kind = str(value, "ownerKind");
        const auto feature_id = str(value, "featureId");
        if (kind == "room") {
            const auto id = ref(field(value, "room"));
            const auto* owner = record("rooms", id);
            if (!owner) {
                missing("rooms", id, path + "/room/$ref", "Room");
                return;
            }
            if (!ids(field(field(owner, "data"), "features")).contains(feature_id))
                report(out_, path + "/featureId", "authoring.interaction.feature-missing",
                       "Missing Feature '" + feature_id + "' on Room '" + id + "'.");
        } else if (kind == "interactable") {
            const auto id = ref(field(value, "interactable"));
            const auto* instances = field(&manifest_, "interactableInstances");
            const auto* instance =
                instances && instances->contains(id) ? &instances->at(id) : nullptr;
            if (!instance) {
                missing("interactableInstances", id, path + "/interactable/$ref",
                        "Interactable Instance");
                return;
            }
            const auto* owner = record("interactables", ref(field(instance, "definition")));
            if (!owner) {
                report(out_, path + "/interactable/$ref", "authoring.interaction.feature-owner",
                       "Missing or invalid Interactable Instance '" + id + "'.");
                return;
            }
            if (!ids(field(field(owner, "data"), "features")).contains(feature_id))
                report(out_, path + "/featureId", "authoring.interaction.feature-missing",
                       "Missing Feature '" + feature_id + "' on Interactable Instance '" + id +
                           "'.");
        }
    }

    void subject(const Json* value, const std::string& path)
    {
        const auto kind = str(value, "kind");
        if (kind == "character")
            missing("characters", ref(field(value, "character")), path + "/character/$ref",
                    "Character");
        else if (kind == "interactable")
            missing("interactableInstances", ref(field(value, "interactable")),
                    path + "/interactable/$ref", "Interactable Instance");
        else if (kind == "feature")
            feature(field(value, "feature"), path + "/feature");
    }

    void variable_value(const Json* reference, const Json* value, const std::string& path)
    {
        const auto id = ref(reference);
        const auto* variable = record("variables", id);
        if (!variable) {
            missing("variables", id, path + "/variable/$ref", "Variable");
            return;
        }
        if (value && !variable_compatible(variable->at("data"), *value))
            report(out_, path + "/value", "authoring.condition.variable-type-mismatch",
                   "Value does not match variable '" + id + "'.");
    }

    void inventory_owner(const Json* owner, const std::string& path,
                         const std::set<std::string>& slots)
    {
        const auto kind = str(owner, "kind");
        if (kind == "project")
            return;
        if (kind == "interaction-slot" || kind == "command-result") {
            identity(owner, path, slots, false);
            return;
        }
        if (kind == "character")
            missing("characters", ref(field(owner, "character")), path + "/character/$ref",
                    "Character");
        else if (kind == "room-feature")
            missing("rooms", ref(field(owner, "room")), path + "/room/$ref", "Room");
        else if (kind == "interactable" || kind == "interactable-feature")
            missing("interactableInstances", ref(field(owner, "interactable")),
                    path + "/interactable/$ref", "Interactable Instance");
    }

    void inventory_reference(const Json* inventory_ref, const std::string& path)
    {
        const auto* owner = field(inventory_ref, "owner");
        const auto kind = str(owner, "kind");
        const auto inventory_id = str(inventory_ref, "inventoryId");
        const Json* inventories = nullptr;
        if (kind == "project") {
            inventories = field(&manifest_, "inventories");
        } else if (kind == "character") {
            const auto* character = record("characters", ref(field(owner, "character")));
            inventories = field(field(character, "data"), "inventories");
        } else if (kind == "room-feature") {
            const auto* room = record("rooms", ref(field(owner, "room")));
            const auto* features = field(field(room, "data"), "features");
            if (features && features->is_array())
                for (const auto& feature : features->array_range())
                    if (str(&feature, "id") == str(owner, "featureId")) {
                        inventories = field(&feature, "inventories");
                        break;
                    }
        } else if (kind == "interactable" || kind == "interactable-feature") {
            const auto id = ref(field(owner, "interactable"));
            const auto* instances = field(&manifest_, "interactableInstances");
            const auto* instance =
                instances && instances->contains(id) ? &instances->at(id) : nullptr;
            const auto* definition =
                instance ? record("interactables", ref(field(instance, "definition"))) : nullptr;
            const auto* data = field(definition, "data");
            if (kind == "interactable")
                inventories = field(data, "inventories");
            else {
                const auto* features = field(data, "features");
                if (features && features->is_array())
                    for (const auto& feature : features->array_range())
                        if (str(&feature, "id") == str(owner, "featureId")) {
                            inventories = field(&feature, "inventories");
                            break;
                        }
            }
        }
        if (!inventories) {
            report(out_, path + "/owner", "authoring.inventory.owner-missing",
                   "Inventory owner does not exist.");
            return;
        }
        if (!ids(inventories).contains(inventory_id))
            report(out_, path + "/inventoryId", "authoring.inventory.missing",
                   "Inventory '" + inventory_id + "' does not exist on the selected owner.");
    }

    void inventory(const Json* operand, const std::string& path, const std::set<std::string>& slots)
    {
        const auto kind = str(operand, "kind");
        if (kind == "owner-inventory")
            inventory_owner(field(operand, "owner"), path + "/owner", slots);
        else if (kind == "command-result")
            identity(operand, path, slots, false);
        else if (kind == "player-inventory")
            report(out_, path, "authoring.condition.player-inventory-out-of-scope",
                   "Player Inventory is not available in this Condition host.");
        else if (kind == "inventory")
            inventory_reference(field(operand, "inventory"), path);
    }

public:
    References(ValidationResult& out, const Json& manifest, const Json& traits,
               const AuthoringRecordResolver& resolve,
               const std::function<bool(std::string_view, std::string_view)>& exists)
        : out_(out), manifest_(manifest), traits_(traits), resolve_(resolve), exists_(exists)
    {
    }

    void selectors(const Json* selectors, const std::string& base)
    {
        if (!selectors || !selectors->is_array())
            return;
        for (std::size_t i = 0; i < selectors->size(); ++i) {
            const auto* selector = item(selectors, i);
            const auto path = base + "/" + std::to_string(i);
            const auto kind = str(selector, "kind");
            if (kind == "trait")
                missing("traits", ref(field(selector, "trait")), path + "/trait/$ref", "Trait");
            else if (kind == "interactable-definition" || kind == "interactable-feature") {
                const auto definition = ref(field(selector, "interactableDefinition"));
                missing("interactables", definition, path + "/interactableDefinition/$ref",
                        "Interactable definition");
                if (kind == "interactable-feature") {
                    const auto* owner = record("interactables", definition);
                    if (owner && !ids(field(field(owner, "data"), "features"))
                                      .contains(str(selector, "featureId")))
                        report(out_, path + "/featureId", "authoring.interaction.feature-missing",
                               "Missing Feature on Interactable definition '" + definition + "'.");
                }
            } else if (kind == "exact")
                subject(field(selector, "subject"), path + "/subject");
        }
    }

    void identity(const Json* operand, const std::string& path, const std::set<std::string>& slots,
                  bool current_room)
    {
        const auto kind = str(operand, "kind");
        if (kind == "interaction-slot" && !slots.contains(str(operand, "slotId")))
            report(out_, path + "/slotId", "authoring.condition.slot-out-of-scope",
                   "Interaction slot is not in scope here.");
        else if (kind == "command-result")
            report(out_, path + "/bindingId", "authoring.condition.result-out-of-scope",
                   "Command result is not in scope here.");
        else if (kind == "current-room" && !current_room)
            report(out_, path, "authoring.condition.current-room-out-of-scope",
                   "Current Room is not available in this Condition host.");
        else if (kind == "room" || kind == "room-feature")
            missing("rooms", ref(field(operand, "room")), path + "/room/$ref", "Room");
        else if (kind == "character")
            missing("characters", ref(field(operand, "character")), path + "/character/$ref",
                    "Character");
        else if (kind == "interactable" || kind == "interactable-feature")
            missing("interactableInstances", ref(field(operand, "interactable")),
                    path + "/interactable/$ref", "Interactable Instance");
    }

    void condition(const Json* condition, const std::string& path,
                   const std::set<std::string>& slots, bool current_room)
    {
        const auto kind = str(condition, "kind");
        if (kind == "all" || kind == "any") {
            const auto* children = field(condition, "conditions");
            if (children && children->is_array())
                for (std::size_t i = 0; i < children->size(); ++i)
                    this->condition(item(children, i), path + "/conditions/" + std::to_string(i),
                                    slots, current_room);
        } else if (kind == "not")
            this->condition(field(condition, "condition"), path + "/condition", slots,
                            current_room);
        else if (kind == "variable-comparison")
            variable_value(field(condition, "variable"), field(condition, "value"), path);
        else if (kind == "trait-presence") {
            missing("traits", ref(field(condition, "trait")), path + "/trait/$ref", "Trait");
            identity(field(condition, "owner"), path + "/owner", slots, current_room);
        } else if (kind == "property-comparison")
            identity(field(condition, "owner"), path + "/owner", slots, current_room);
        else if (kind == "location-comparison") {
            identity(field(condition, "subject"), path + "/subject", slots, current_room);
            const auto* location = field(condition, "location");
            if (str(location, "kind") == "room")
                identity(field(location, "room"), path + "/location/room", slots, current_room);
            else if (str(location, "kind") == "inventory")
                inventory(field(location, "inventory"), path + "/location/inventory", slots);
        } else if (kind == "inventory-quantity-comparison") {
            inventory(field(condition, "inventory"), path + "/inventory", slots);
            const auto* matcher = field(condition, "matcher");
            if (const auto* definition = field(matcher, "definition");
                definition && !definition->is_null())
                missing("interactables", ref(definition), path + "/matcher/definition/$ref",
                        "Interactable definition");
            const auto* traits = field(matcher, "traits");
            if (traits && traits->is_array())
                for (std::size_t i = 0; i < traits->size(); ++i)
                    missing("traits", ref(item(traits, i)),
                            path + "/matcher/traits/" + std::to_string(i) + "/$ref", "Trait");
            const auto* exact = field(matcher, "exact");
            if (exact && !exact->is_null())
                identity(exact, path + "/matcher/exact", slots, current_room);
        }
    }

    void program(const Json* program, const std::string& base)
    {
        if (!program)
            return;
        const auto visit = [&](const auto& self, const Json* commands,
                               const std::string& path) -> void {
            if (!commands || !commands->is_array())
                return;
            for (std::size_t i = 0; i < commands->size(); ++i) {
                const auto* command = item(commands, i);
                const auto at = path + "/" + std::to_string(i);
                const auto kind = str(command, "kind");
                if (kind == "call-scene")
                    missing("scenes", ref(field(command, "scene")), at + "/scene/$ref", "Scene");
                else if (kind == "call-dialogue")
                    missing("dialogues", ref(field(command, "dialogue")), at + "/dialogue/$ref",
                            "Dialogue");
                else if (kind == "set-global-property")
                    variable_value(field(command, "variable"), field(command, "value"), at);
                else if (kind == "unset-global-property")
                    missing("variables", ref(field(command, "variable")), at + "/variable/$ref",
                            "Variable");
                else if (kind == "if") {
                    condition(field(command, "condition"), at + "/condition", {}, false);
                    self(self, field(command, "then"), at + "/then");
                    self(self, field(command, "else"), at + "/else");
                }
            }
        };
        visit(visit, field(program, "instructions"), base + "/instructions");
        const auto* completion = field(program, "completion");
        const auto kind = str(completion, "kind");
        if (kind == "room" || kind == "scene" || kind == "dialogue")
            missing(kind == "room"    ? "rooms"
                    : kind == "scene" ? "scenes"
                                      : "dialogues",
                    str(completion, "id"), base + "/completion/id", kind);
    }
};

} // namespace

ValidationResult validate_verb_interaction_local(std::string_view family,
                                                 std::string_view record_json)
{
    ValidationResult result{true};
    try {
        const auto record = Json::parse(record_json);
        const auto* data = field(&record, "data");
        if (family == "verbs") {
            program_local(result, field(data, "defaultProgram"), "/data/defaultProgram");
        } else if (family == "interactions") {
            const auto* rules = field(data, "rules");
            if (rules && rules->is_array()) {
                std::set<std::string> seen;
                for (std::size_t i = 0; i < rules->size(); ++i) {
                    const auto* rule = item(rules, i);
                    const auto path = "/data/rules/" + std::to_string(i);
                    if (!seen.insert(str(rule, "id")).second)
                        report(result, path + "/id", "authoring.interaction.duplicate-rule",
                               "Duplicate interaction rule ID '" + str(rule, "id") + "'.");
                    program_local(result, field(rule, "program"), path + "/program");
                }
                for (std::size_t i = 0; i < rules->size(); ++i)
                    for (std::size_t j = i + 1; j < rules->size(); ++j) {
                        const auto& left = rules->at(i);
                        const auto& right = rules->at(j);
                        const auto rel = relation(left, right);
                        const auto lpath = "/data/rules/" + std::to_string(i);
                        const auto rpath = "/data/rules/" + std::to_string(j);
                        const auto lp = left.at("priority").as<std::int64_t>();
                        const auto rp = right.at("priority").as<std::int64_t>();
                        const bool la = str(field(&left, "guard"), "kind") == "always";
                        const bool ra = str(field(&right, "guard"), "kind") == "always";
                        if (rel.overlap != Truth::No && rel.left_within == rel.right_within &&
                            lp == rp) {
                            const bool definite = la && ra && rel.overlap == Truth::Yes;
                            report(result, rpath, "authoring.interaction.resolver-conflict",
                                   definite ? "Rule conflicts with an unconditional equal-tier, "
                                              "equal-priority Rule."
                                            : "Rule may be ambiguous with another equal-tier, "
                                              "equal-priority Rule.",
                                   definite ? "error" : "warning");
                        }
                        if (rel.left_within == Truth::Yes && rel.right_within == Truth::Yes) {
                            if (ra && rp > lp)
                                report(result, lpath, "authoring.interaction.unreachable",
                                       "Rule is unreachable because an unconditional "
                                       "equal-match Rule has higher priority.");
                            if (la && lp > rp)
                                report(result, rpath, "authoring.interaction.unreachable",
                                       "Rule is unreachable because an unconditional "
                                       "equal-match Rule has higher priority.");
                        }
                    }
            }
        }
    } catch (const std::exception& e) {
        report(result, "", "authoring.interaction.local-failure", e.what());
    }
    return result;
}

ValidationResult validate_verb_interaction_dependencies(
    std::string_view family, std::string_view record_json, std::string_view manifest_json,
    std::string_view traits_json, const AuthoringRecordResolver& resolve,
    const std::function<bool(std::string_view, std::string_view)>& exists)
{
    ValidationResult result{true};
    try {
        const auto record = Json::parse(record_json);
        const auto manifest = Json::parse(manifest_json);
        const auto traits = Json::parse(traits_json);
        References check(result, manifest, traits, resolve, exists);
        const auto* data = field(&record, "data");
        if (family == "verbs") {
            const auto* slots = field(data, "slots");
            if (slots && slots->is_array())
                for (std::size_t i = 0; i < slots->size(); ++i)
                    check.selectors(field(item(slots, i), "selectors"),
                                    "/data/slots/" + std::to_string(i) + "/selectors");
            const auto* offers = field(data, "offers");
            if (offers && offers->is_array())
                for (std::size_t i = 0; i < offers->size(); ++i) {
                    const auto* offer = item(offers, i);
                    const auto path = "/data/offers/" + std::to_string(i);
                    check.selectors(field(offer, "selectors"), path + "/selectors");
                    if (field(offer, "condition"))
                        check.condition(field(offer, "condition"), path + "/condition",
                                        {str(offer, "slotId")}, true);
                }
            check.condition(field(data, "availability"), "/data/availability", {}, true);
            check.program(field(data, "defaultProgram"), "/data/defaultProgram");
        } else if (family == "interactions") {
            const auto* rules = field(data, "rules");
            if (rules && rules->is_array())
                for (std::size_t i = 0; i < rules->size(); ++i) {
                    const auto* rule = item(rules, i);
                    const auto path = "/data/rules/" + std::to_string(i);
                    const auto verb_id = ref(field(rule, "verb"));
                    const auto verb_source = resolve("verbs", verb_id);
                    std::set<std::string> expected;
                    std::optional<Json> verb;
                    if (!verb_source) {
                        report(result, path + "/verb/$ref", "authoring.interaction.verb-missing",
                               "Missing or invalid verb '" + verb_id + "'.");
                    } else {
                        verb = Json::parse(*verb_source);
                        const auto* slots = field(field(&*verb, "data"), "slots");
                        if (slots && slots->is_array())
                            for (const auto& slot : slots->array_range()) {
                                expected.insert(str(&slot, "id"));
                            }
                    }
                    const auto* slots = field(rule, "slots");
                    const auto actual = ids(slots, "slotId");
                    if (verb_source &&
                        (actual != expected || (slots && actual.size() != slots->size())))
                        report(result, path + "/slots", "authoring.interaction.slots",
                               "Interaction rule slots must bind every named slot of Verb '" +
                                   verb_id + "' exactly once.");
                    const auto* offer = field(rule, "offer");
                    if (verb_source && offer && !offer->is_null() &&
                        !expected.contains(str(offer, "slotId")))
                        report(result, path + "/offer/slotId", "authoring.interaction.offer-slot",
                               "Rule Offer slot must name a slot of Verb '" + verb_id + "'.");
                    if (slots && slots->is_array())
                        for (std::size_t j = 0; j < slots->size(); ++j) {
                            const auto* slot = item(slots, j);
                            check.selectors(field(item(slots, j), "selectors"),
                                            path + "/slots/" + std::to_string(j) + "/selectors");
                            if (verb) {
                                const auto* definitions = field(field(&*verb, "data"), "slots");
                                if (definitions && definitions->is_array())
                                    for (const auto& candidate : definitions->array_range()) {
                                        if (str(&candidate, "id") != str(slot, "slotId"))
                                            continue;
                                        const auto overlap =
                                            selector_union(field(slot, "selectors"),
                                                           field(&candidate, "selectors"), true);
                                        const auto slot_path =
                                            path + "/slots/" + std::to_string(j) + "/selectors";
                                        if (overlap == Truth::No)
                                            report(result, slot_path,
                                                   "authoring.interaction.selector-disjoint",
                                                   "Rule can never match Verb '" + verb_id +
                                                       "' slot '" + str(slot, "slotId") + "'.");
                                        else if (overlap == Truth::Unknown)
                                            report(result, slot_path,
                                                   "authoring.interaction.selector-conditional",
                                                   "Rule may match only for runtime-dependent "
                                                   "Trait or identity facts.",
                                                   "info");
                                        break;
                                    }
                            }
                        }
                    const auto binding_ids = ids(slots, "slotId");
                    check.condition(field(rule, "guard"), path + "/guard", binding_ids, true);
                    if (offer && !offer->is_null())
                        check.condition(field(offer, "condition"), path + "/offer/condition",
                                        {str(offer, "slotId")}, true);
                    check.program(field(rule, "program"), path + "/program");
                }
        }
    } catch (const std::exception& e) {
        report(result, "", "authoring.interaction.dependency-failure", e.what());
    }
    return result;
}

ValidationResult validate_project_interaction_program(
    std::string_view manifest_json, std::string_view traits_json,
    const AuthoringRecordResolver& resolve,
    const std::function<bool(std::string_view, std::string_view)>& exists)
{
    ValidationResult result{true};
    try {
        const auto manifest = Json::parse(manifest_json);
        const auto* program = field(&manifest, "undefinedInteractionProgram");
        if (!program || program->is_null())
            return result;
        program_local(result, program, "/undefinedInteractionProgram");
        const auto traits = Json::parse(traits_json);
        References check(result, manifest, traits, resolve, exists);
        check.program(program, "/undefinedInteractionProgram");
    } catch (const std::exception& error) {
        report(result, "/undefinedInteractionProgram", "authoring.interaction.fallback-failure",
               error.what());
    }
    return result;
}

ValidationResult validate_interaction_resolver(
    const std::vector<std::pair<std::string, std::string>>& interaction_records)
{
    ValidationResult result{true};
    struct Rule {
        std::string owner;
        std::size_t index;
        Json value;
    };
    std::vector<Rule> rules;
    try {
        for (const auto& [owner, source] : interaction_records) {
            const auto record = Json::parse(source);
            const auto* entries = field(field(&record, "data"), "rules");
            if (!entries || !entries->is_array())
                continue;
            for (std::size_t i = 0; i < entries->size(); ++i)
                rules.push_back({owner, i, entries->at(i)});
        }
        for (std::size_t i = 0; i < rules.size(); ++i) {
            const auto& left = rules[i];
            for (std::size_t j = i + 1; j < rules.size(); ++j) {
                const auto& right = rules[j];
                if (left.owner == right.owner)
                    continue;
                const auto rel = relation(left.value, right.value);
                const auto right_path = "/interactions/" + escaped(right.owner) + "/data/rules/" +
                                        std::to_string(right.index);
                const auto left_path = "/interactions/" + escaped(left.owner) + "/data/rules/" +
                                       std::to_string(left.index);
                const auto same_tier = rel.left_within == rel.right_within;
                const auto left_priority = left.value.at("priority").as<std::int64_t>();
                const auto right_priority = right.value.at("priority").as<std::int64_t>();
                const auto left_always = str(field(&left.value, "guard"), "kind") == "always";
                const auto right_always = str(field(&right.value, "guard"), "kind") == "always";
                if (rel.overlap != Truth::No && same_tier && left_priority == right_priority) {
                    const bool definite = rel.overlap == Truth::Yes && left_always && right_always;
                    report(result, right_path, "authoring.interaction.resolver-conflict",
                           definite ? "Rule conflicts with unconditional rule '" + left.owner +
                                          ":" + str(&left.value, "id") +
                                          "' at equal structural tier and priority."
                                    : "Rule may be ambiguous with rule '" + left.owner + ":" +
                                          str(&left.value, "id") +
                                          "' at equal structural tier and priority.",
                           definite ? "error" : "warning");
                }
                if (rel.left_within == Truth::Yes && rel.right_within == Truth::Yes) {
                    if (left_always && left_priority > right_priority)
                        report(result, right_path, "authoring.interaction.unreachable",
                               "Rule is unreachable because unconditional rule '" + left.owner +
                                   ":" + str(&left.value, "id") + "' has higher priority.");
                    if (right_always && right_priority > left_priority)
                        report(result, left_path, "authoring.interaction.unreachable",
                               "Rule is unreachable because unconditional rule '" + right.owner +
                                   ":" + str(&right.value, "id") + "' has higher priority.");
                }
            }
        }
    } catch (const std::exception& e) {
        report(result, "", "authoring.interaction.resolver-failure", e.what());
    }
    return result;
}

} // namespace noveltea::authoring
