#include "interactable_inventory_semantics.hpp"
#include "property_semantics.hpp"

#include <jsoncons/json.hpp>

#include <map>
#include <set>
#include <string>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

const Json* member(const Json* value, std::string_view key)
{
    return value && value->is_object() && value->contains(key) ? &value->at(key) : nullptr;
}

std::string string(const Json* value, std::string_view key)
{
    const auto* found = member(value, key);
    return found && found->is_string() ? found->as<std::string>() : std::string{};
}

std::string ref(const Json* value) { return string(member(value, "$ref"), "id"); }

std::string pointer(std::string_view value)
{
    std::string escaped;
    for (const char ch : value) {
        if (ch == '~')
            escaped += "~0";
        else if (ch == '/')
            escaped += "~1";
        else
            escaped += ch;
    }
    return escaped;
}

void error(ValidationResult& result, std::string path, std::string code, std::string message)
{
    result.accepted = false;
    result.diagnostics.push_back({std::move(path), std::move(code), std::move(message)});
}

const Json* named(const Json* values, std::string_view id)
{
    if (!values || !values->is_array())
        return nullptr;
    for (const auto& value : values->array_range())
        if (string(&value, "id") == id)
            return &value;
    return nullptr;
}

void inventories_unique(ValidationResult& result, const Json* values, const std::string& base)
{
    if (!values || !values->is_array())
        return;
    std::set<std::string> ids;
    for (std::size_t i = 0; i < values->size(); ++i) {
        const auto id = string(&values->at(i), "id");
        if (!ids.insert(id).second)
            error(result, base + "/" + std::to_string(i) + "/id",
                  "authoring.inventory.duplicate-id", "Duplicate Inventory ID '" + id + "'.");
    }
}

void feature_inventories(ValidationResult& result, const Json* features, const std::string& base)
{
    if (!features || !features->is_array())
        return;
    for (std::size_t i = 0; i < features->size(); ++i)
        inventories_unique(result, member(&features->at(i), "inventories"),
                           base + "/" + std::to_string(i) + "/inventories");
}

} // namespace

ValidationResult validate_interactable_definition_local(std::string_view record_json)
{
    ValidationResult result{true};
    try {
        const Json record = Json::parse(record_json);
        const auto* data = member(&record, "data");
        if (!data)
            return result;
        const bool stackable = member(data, "stackable") && data->at("stackable") == true;
        const auto* limit = member(data, "stackLimit");
        const auto* features = member(data, "features");
        const auto* inventories = member(data, "inventories");
        if (!stackable && limit && !limit->is_null())
            error(result, "/data/stackLimit", "authoring.interactable.invalid_stack_limit",
                  "Non-stackable Interactables cannot declare a Stack limit.");
        if (stackable &&
            ((features && !features->empty()) || (inventories && !inventories->empty())))
            error(result, "/data", "authoring.interactable.stackable_identity_children",
                  "Stackable Interactables cannot own Features or Inventories.");
        inventories_unique(result, inventories, "/data/inventories");
        feature_inventories(result, features, "/data/features");
        const auto* presentation = member(data, "presentation");
        const auto* hotspots = member(presentation, "hotspots");
        const auto kind = string(hotspots, "kind");
        const auto* entries = kind == "custom" ? member(hotspots, "hotspots") : nullptr;
        const auto* alpha = kind == "visual-alpha" ? member(hotspots, "hotspot") : nullptr;
        const std::size_t count = alpha ? 1 : entries && entries->is_array() ? entries->size() : 0;
        std::set<std::string> hotspot_ids;
        for (std::size_t i = 0; i < count; ++i) {
            const auto* hotspot = alpha ? alpha : &entries->at(i);
            const auto path = std::string("/data/presentation/hotspots/") +
                              (alpha ? "hotspot" : "hotspots/" + std::to_string(i));
            if (!hotspot_ids.insert(string(hotspot, "id")).second)
                error(result, path + "/id", "hotspot.authoring.id.duplicate",
                      "Hotspot ID is duplicated on this Interactable.");
            const auto* target = member(hotspot, "target");
            if (string(target, "kind") == "owner-feature" &&
                !named(features, string(target, "featureId")))
                error(result, path + "/target/featureId",
                      "hotspot.authoring.target.feature-missing",
                      "Hotspot target Feature does not belong to this Definition.");
        }
        if (count > 0 && (!member(presentation, "visual") || presentation->at("visual").is_null()))
            error(result, "/data/presentation/visual", "hotspot.authoring.visual-missing",
                  "Interactable Hotspots require an image or Animation Visual.");
    } catch (const std::exception& e) {
        error(result, "", "authoring.interactable.validation_failure", e.what());
    }
    return result;
}

ValidationResult validate_interactable_inventory_project(
    std::string_view manifest_json, const AuthoringRecordResolver& resolve,
    std::string_view traits_json,
    const std::function<bool(std::string_view, std::string_view)>& exists,
    const std::set<std::string>& affected_instances)
{
    ValidationResult result{true};
    try {
        const Json project = Json::parse(manifest_json);
        const auto* instances = member(&project, "interactableInstances");
        const auto* declared_inventories = member(&project, "inventories");
        inventories_unique(result, declared_inventories, "/inventories");
        if (!instances || !instances->is_object())
            return result;

        std::map<std::string, std::optional<Json>> definitions;
        std::map<std::string, std::optional<Json>> owners;
        const auto resolve_data = [&](std::string_view family, const std::string& id,
                                      auto& cache) -> const Json* {
            const auto [it, inserted] = cache.try_emplace(std::string(family) + "/" + id);
            if (inserted) {
                if (const auto source = resolve(family, id)) {
                    const auto parsed = Json::parse(*source);
                    const auto semantic = (family == "interactables" || family == "characters")
                                              ? validate_archetype_owner(family, *source, resolve)
                                              : ValidationResult{true, *source, {}};
                    if (semantic.accepted && !semantic.effective_json.empty())
                        it->second = Json::parse(semantic.effective_json);
                    else if (parsed.is_object() && parsed.contains("data"))
                        it->second = parsed;
                }
            }
            return it->second ? &*it->second : nullptr;
        };
        const auto definition_for = [&](const Json& instance) -> const Json* {
            const auto id = ref(member(&instance, "definition"));
            return resolve_data("interactables", id, definitions);
        };
        const auto check_inventory = [&](const Json& inventory, const std::string& base) {
            const auto* owner = member(&inventory, "owner");
            const auto kind = string(owner, "kind");
            const auto inventory_id = string(&inventory, "inventoryId");
            const Json* list = nullptr;
            if (kind == "project") {
                list = declared_inventories;
            } else if (kind == "character") {
                const auto id = ref(member(owner, "character"));
                const auto* record = resolve_data("characters", id, owners);
                if (!record && exists("characters", id))
                    return;
                list = member(member(record, "data"), "inventories");
            } else if (kind == "room-feature") {
                const auto id = ref(member(owner, "room"));
                const auto* record = resolve_data("rooms", id, owners);
                if (!record && exists("rooms", id))
                    return;
                const auto* feature =
                    named(member(member(record, "data"), "features"), string(owner, "featureId"));
                list = member(feature, "inventories");
            } else if (kind == "interactable" || kind == "interactable-feature") {
                const auto* selected = member(instances, ref(member(owner, "interactable")));
                const auto* record = selected ? definition_for(*selected) : nullptr;
                if (selected && !record &&
                    exists("interactables", ref(member(selected, "definition"))))
                    return;
                const auto* data = member(record, "data");
                list = kind == "interactable"
                           ? member(data, "inventories")
                           : member(named(member(data, "features"), string(owner, "featureId")),
                                    "inventories");
            }
            if (!list) {
                error(result, base + "/owner", "authoring.inventory.owner-missing",
                      "Inventory owner or owner Feature does not exist.");
            } else if (!named(list, inventory_id)) {
                error(result, base + "/inventoryId", "authoring.inventory.missing",
                      "Inventory '" + inventory_id + "' does not exist on the selected owner.");
            }
        };

        for (const auto& entry : instances->object_range()) {
            const auto id = std::string(entry.key());
            if (!affected_instances.contains(id))
                continue;
            const auto base = "/interactableInstances/" + pointer(id);
            const auto& instance = entry.value();
            if (string(&instance, "id") != id)
                error(result, base + "/id", "authoring.interactable.instance-id-mismatch",
                      "Instance ID must match its registry key.");
            const auto* definition = definition_for(instance);
            if (!definition && !exists("interactables", ref(member(&instance, "definition")))) {
                error(result, base + "/definition/$ref",
                      "authoring.interactable.definition-missing",
                      "Referenced Interactable Definition is missing or invalid.");
            } else {
                const auto* data = member(definition, "data");
                const bool stackable = member(data, "stackable") && data->at("stackable") == true;
                const auto* limit = member(data, "stackLimit");
                const auto quantity = instance.at("quantity").as<std::uint64_t>();
                if ((!stackable && quantity != 1) || (stackable && limit && !limit->is_null() &&
                                                      quantity > limit->as<std::uint64_t>()))
                    error(result, base + "/quantity", "authoring.interactable.invalid_quantity",
                          "Quantity is incompatible with the Interactable Definition.");
                const auto* overrides = member(&instance, "featureOverrides");
                if (overrides && overrides->is_array()) {
                    std::set<std::string> visited;
                    for (std::size_t i = 0; i < overrides->size(); ++i) {
                        const auto& override = overrides->at(i);
                        const auto name = string(&override, "featureId");
                        const auto path = base + "/featureOverrides/" + std::to_string(i);
                        if (!visited.insert(name).second)
                            error(result, path + "/featureId",
                                  "authoring.interactable.feature.duplicate_override",
                                  "Feature is overridden more than once.");
                        if (stackable)
                            error(result, path, "authoring.interactable.feature.stackable_override",
                                  "Stackable Interactables cannot carry Feature overrides.");
                        if (!named(member(data, "features"), name))
                            error(result, path + "/featureId",
                                  "authoring.interactable.feature.missing",
                                  "Feature is not declared on the Definition.");
                    }
                }
                const auto properties = validate_interactable_instance(
                    instance.to_string(), definition->to_string(), traits_json);
                for (auto diagnostic : properties.diagnostics) {
                    diagnostic.path = base + diagnostic.path;
                    result.diagnostics.push_back(std::move(diagnostic));
                }
                result.accepted &= properties.accepted;
            }
            const auto* location = member(&instance, "location");
            const auto kind = string(location, "kind");
            if (kind == "room" && !resolve("rooms", ref(member(location, "room"))) &&
                !exists("rooms", ref(member(location, "room"))))
                error(result, base + "/location/room/$ref", "authoring.interactable.room-missing",
                      "Referenced Room does not exist.");
            if (kind != "inventory")
                continue;
            const auto* target = member(location, "inventory");
            check_inventory(*target, base + "/location/inventory");
            std::set<std::string> visited{id};
            const Json* current = target;
            while (current) {
                const auto* owner = member(current, "owner");
                const auto owner_kind = string(owner, "kind");
                if (owner_kind != "interactable" && owner_kind != "interactable-feature")
                    break;
                const auto parent_id = ref(member(owner, "interactable"));
                if (!visited.insert(parent_id).second) {
                    error(result, base + "/location/inventory",
                          "authoring.inventory.containment-cycle",
                          "Inventory containment cycle reaches Interactable '" + parent_id + "'.");
                    break;
                }
                const auto* parent = member(instances, parent_id);
                const auto* parent_location = member(parent, "location");
                current = string(parent_location, "kind") == "inventory"
                              ? member(parent_location, "inventory")
                              : nullptr;
            }
        }
    } catch (const std::exception& e) {
        error(result, "/interactableInstances", "authoring.interactable.project_failure", e.what());
    }
    return result;
}

} // namespace noveltea::authoring
