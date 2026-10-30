#include "test_semantics.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

const Json* field(const Json* value, std::string_view key)
{
    return value && value->is_object() && value->contains(key) ? &value->at(key) : nullptr;
}

std::string str(const Json* value, std::string_view key)
{
    const auto* member = field(value, key);
    return member && member->is_string() ? member->as<std::string>() : std::string{};
}

std::string ref(const Json* value) { return str(field(value, "$ref"), "id"); }

void issue(ValidationResult& out, std::string path, std::string code, std::string message,
           std::string severity = "error")
{
    if (severity == "error")
        out.accepted = false;
    out.diagnostics.push_back(
        {std::move(path), std::move(code), std::move(message), std::move(severity)});
}

bool member(const Json* value, std::string_view key, std::string_view expected)
{
    return str(value, key) == expected;
}

void unique_ids(ValidationResult& out, const Json& array, std::string_view path,
                std::string_view label)
{
    std::set<std::string> seen;
    for (std::size_t i = 0; i < array.size(); ++i) {
        const auto id = str(&array.at(i), "id");
        if (!seen.insert(id).second)
            issue(out, std::string(path) + "/" + std::to_string(i) + "/id",
                  "authoring.test.duplicate-id",
                  "Duplicate " + std::string(label) + " ID '" + id + "'.");
    }
}

bool is_numeric(std::string_view op)
{
    return op == "gt" || op == "gte" || op == "lt" || op == "lte";
}
bool is_equality(std::string_view op) { return op == "eq" || op == "ne"; }
bool is_presence(std::string_view op) { return op == "present" || op == "absent"; }

void address(ValidationResult& out, const Json* value, const std::string& path,
             std::string_view label)
{
    const auto document = trim_ecmascript(str(value, "documentId"));
    const auto mount = trim_ecmascript(str(value, "mountInstanceId"));
    if (document.empty() == mount.empty())
        issue(out, path, "authoring.test.address",
              std::string(label) + " requires exactly one address: documentId or mountInstanceId.");
    if (trim_ecmascript(str(value, "selector")).empty())
        issue(out, path + "/selector", "authoring.test.selector",
              std::string(label) + " selector is required.");
}

void expectation_local(ValidationResult& out, const Json& value, const std::string& path)
{
    const auto type = str(&value, "type");
    const auto op = str(&value, "operator");
    const auto* layout = field(&value, "layout");
    const auto* ui = field(&value, "uiElement");
    const auto error = [&](std::string message) {
        issue(out, path + "/operator", "authoring.test.operator", std::move(message));
    };
    if (type == "quantity" && !is_numeric(op) && !is_equality(op))
        error("Quantity expectations require a numeric or equality operator.");
    if ((type == "trait" || type == "event" || type == "diagnostic") && !is_presence(op))
        error(type == "trait"   ? "Trait expectations require present or absent."
              : type == "event" ? "Event expectations require present or absent."
                                : "Diagnostic expectations require present or absent.");
    if (type == "layout") {
        if (member(layout, "field", "mounted") && !is_presence(op))
            error("Mounted Layout expectations require present or absent.");
        if (member(layout, "field", "state")) {
            if (is_presence(op))
                error("Layout state expectations require equality or numeric comparison.");
            const auto* expected = field(layout, "value");
            if (is_numeric(op) && (!expected || !expected->is_number()))
                issue(out, path + "/layout/value", "authoring.test.numeric-value",
                      "Numeric Layout state comparisons require a numeric expected value.");
        }
    }
    if (type == "entity-state" && !is_equality(op))
        error("Entity-state expectations require eq or ne.");
    if (type == "ui-element") {
        address(out, ui, path + "/uiElement", "UI element expectation");
        if (member(ui, "field", "present") && !is_presence(op))
            error("UI element presence expectations require present or absent.");
        if (member(ui, "field", "visible") && !is_equality(op))
            error("UI element visibility expectations require eq or ne.");
    }
    if ((type == "current-room" || type == "active-flow" || type == "location") &&
        !is_equality(op) && !is_presence(op))
        error(type == "current-room"
                  ? "Current Room expectations require equality or presence operators."
              : type == "active-flow"
                  ? "Active Flow expectations require equality or presence operators."
                  : "Location expectations require equality or presence operators.");
    if (type == "property" && is_numeric(op) &&
        !field(field(&value, "property"), "value")->is_number())
        issue(out, path + "/property/value", "authoring.test.numeric-value",
              "Numeric property comparisons require a numeric expected value.");
}

bool canonical_slot(std::string_view slot)
{
    if (slot == "autosave")
        return true;
    if (!slot.starts_with("slot-"))
        return false;
    slot.remove_prefix(5);
    if (slot.empty() || (slot.size() > 1 && slot.front() == '0'))
        return false;
    return std::all_of(slot.begin(), slot.end(), [](char c) { return c >= '0' && c <= '9'; });
}

void expectations_local(ValidationResult& out, const Json& values, const std::string& path)
{
    unique_ids(out, values, path, "expectation");
    for (std::size_t i = 0; i < values.size(); ++i)
        expectation_local(out, values.at(i), path + "/" + std::to_string(i));
}

struct References {
    ValidationResult& out;
    const Json& manifest;
    const Json& traits;
    const AuthoringRecordResolver& resolve;
    const std::function<bool(std::string_view, std::string_view)>& exists;

    bool has(std::string_view collection, std::string_view id) const
    {
        if (collection == "interactableInstances") {
            const auto* instances = field(&manifest, "interactableInstances");
            return instances && instances->contains(id);
        }
        if (collection == "traits")
            return traits.is_object() && traits.contains(id);
        return exists(collection, id);
    }

    void record(std::string_view collection, const std::string& id, const std::string& path,
                std::string_view label)
    {
        if (!has(collection, id))
            issue(out, path, "authoring.test.reference-missing",
                  "Missing " + std::string(label) + " '" + id + "'.");
    }

    void subject(const Json& subject, const std::string& path)
    {
        const auto kind = str(&subject, "kind");
        if (kind == "character") {
            const auto id = ref(field(&subject, "character"));
            record("characters", id, path + "/character/$ref", "characters record");
        } else if (kind == "interactable") {
            const auto id = ref(field(&subject, "interactable"));
            record("interactableInstances", id, path + "/interactable/$ref",
                   "Interactable Instance");
        } else if (kind == "feature") {
            const auto* feature = field(&subject, "feature");
            const auto room_owner = member(feature, "ownerKind", "room");
            const auto id = ref(field(feature, room_owner ? "room" : "interactable"));
            const auto feature_id = str(feature, "featureId");
            std::optional<std::string> owner;
            if (room_owner) {
                owner = resolve("rooms", id);
                if (!owner)
                    issue(out, path + "/feature/room/$ref", "authoring.test.reference-missing",
                          "Missing Room '" + id + "'.");
            } else {
                const auto* instance = field(field(&manifest, "interactableInstances"), id);
                if (instance)
                    owner = resolve("interactables", ref(field(instance, "definition")));
                if (!owner)
                    issue(out, path + "/feature/interactable/$ref",
                          "authoring.test.reference-missing",
                          "Missing Interactable Instance '" + id + "'.");
            }
            if (owner) {
                const auto normalized = Json::parse(*owner);
                const auto* features = field(field(&normalized, "data"), "features");
                bool found = false;
                if (features && features->is_array())
                    for (const auto& feature_value : features->array_range())
                        found |= str(&feature_value, "id") == feature_id;
                if (!found)
                    issue(out, path + "/feature/featureId", "authoring.test.feature-missing",
                          "Missing Feature '" + feature_id + "' on " +
                              (room_owner ? "Room" : "Interactable Instance") + " '" + id + "'.");
            }
        }
    }

    void expectation(const Json& value, const std::string& path)
    {
        const auto type = str(&value, "type");
        const auto op = str(&value, "operator");
        if (type == "current-room" && is_equality(op)) {
            const auto id = str(field(&value, "currentRoom"), "roomId");
            if (id.empty())
                issue(out, path + "/currentRoom/roomId", "authoring.test.required",
                      "Room ID is required.");
            else
                record("rooms", id, path + "/currentRoom/roomId", "Room");
        }
        if (type == "location") {
            const auto* location = field(&value, "location");
            const auto kind = str(location, "entityKind");
            const auto id = str(location, "entityId");
            if (id.empty())
                issue(out, path + "/location/entityId", "authoring.test.required",
                      "Entity ID is required.");
            else
                record(kind == "character" ? "characters" : "interactableInstances", id,
                       path + "/location/entityId",
                       kind == "character" ? "Character" : "Interactable");
            if (member(location, "locationKind", "room"))
                record("rooms", str(location, "roomId"), path + "/location/roomId", "Room");
            if (member(location, "locationKind", "inventory") &&
                trim_ecmascript(str(location, "inventoryId")).empty())
                issue(out, path + "/location/inventoryId", "authoring.test.required",
                      "Inventory ID is required.");
        }
        if (type == "quantity")
            record("interactableInstances", str(field(&value, "quantity"), "interactableId"),
                   path + "/quantity/interactableId", "Interactable Instance");
        if (type == "trait") {
            const auto* trait = field(&value, "trait");
            const auto kind = str(trait, "ownerKind");
            record(kind == "room"        ? "rooms"
                   : kind == "character" ? "characters"
                                         : "interactableInstances",
                   str(trait, "ownerId"), path + "/trait/ownerId",
                   kind == "room"        ? "Room"
                   : kind == "character" ? "Character"
                                         : "Interactable");
            record("traits", str(trait, "traitId"), path + "/trait/traitId", "Trait");
        }
        if (type == "entity-state") {
            const auto* entity = field(&value, "entityState");
            const auto kind = str(entity, "entityKind");
            record(kind == "character" ? "characters" : "interactableInstances",
                   str(entity, "entityId"), path + "/entityState/entityId",
                   kind == "character" ? "Character" : "Interactable");
        }
        if (type == "active-flow" && is_equality(op)) {
            const auto* flow = field(&value, "activeFlow");
            const auto kind = str(flow, "kind");
            const auto id = str(flow, "flowId");
            if (id.empty())
                issue(out, path + "/activeFlow/flowId", "authoring.test.required",
                      "Flow ID is required.");
            else
                record(kind == "scene" ? "scenes" : "dialogues", id, path + "/activeFlow/flowId",
                       kind == "scene" ? "Scene" : "Dialogue");
        }
        if (type == "layout")
            record("layouts", str(field(&value, "layout"), "layoutId"), path + "/layout/layoutId",
                   "Layout");
        if (type == "property") {
            const auto* property = field(&value, "property");
            const auto scope = str(property, "scope");
            if (scope == "global")
                record("variables", str(property, "propertyId"), path + "/property/propertyId",
                       "global Property");
            else
                record(scope == "room"        ? "rooms"
                       : scope == "character" ? "characters"
                                              : "interactableInstances",
                       str(property, "ownerId"), path + "/property/ownerId",
                       scope == "room"        ? "Room"
                       : scope == "character" ? "Character"
                                              : "Interactable");
        }
    }

    void expectations(const Json& values, const std::string& path)
    {
        for (std::size_t i = 0; i < values.size(); ++i)
            expectation(values.at(i), path + "/" + std::to_string(i));
    }
};

} // namespace

ValidationResult validate_test_local(std::string_view record_json)
{
    ValidationResult out{true};
    try {
        const auto record = Json::parse(record_json);
        const auto& data = record.at("data");
        if (trim_ecmascript(str(&data, "displayName")).empty())
            issue(out, "/data/displayName", "authoring.test.display-name",
                  "Display name is required.", "warning");
        const auto& steps = data.at("steps");
        if (steps.empty())
            issue(out, "/data/steps", "authoring.test.steps-required",
                  "Test requires at least one step.");
        unique_ids(out, steps, "/data/steps", "step");
        std::set<std::string> step_ids;
        for (const auto& step : steps.array_range())
            step_ids.insert(str(&step, "id"));
        const auto selected = str(field(&data, "preview"), "selectedStepId");
        if (!selected.empty() && !step_ids.contains(selected))
            issue(out, "/data/preview/selectedStepId", "authoring.test.preview-step",
                  "Missing preview step '" + selected + "'.", "warning");
        for (std::size_t i = 0; i < steps.size(); ++i) {
            const auto& step = steps.at(i);
            const auto path = "/data/steps/" + std::to_string(i);
            if (trim_ecmascript(str(&step, "label")).empty())
                issue(out, path + "/label", "authoring.test.step-label", "Step label is required.");
            expectations_local(out, step.at("expectations"), path + "/expectations");
            if (step.at("enabled") == false)
                continue;
            const auto input = str(&step, "input");
            if ((input == "primary-activate" || input == "open-verb-menu") &&
                step.at("subjectAction").at("subject").is_null())
                issue(out, path + "/subjectAction/subject", "authoring.test.subject-required",
                      "A subject is required.");
            if ((input == "save" || input == "load") &&
                !canonical_slot(str(field(&step, "saveSlot"), "slotId")))
                issue(out, path + "/saveSlot/slotId", "authoring.test.save-slot",
                      "Save slot must be 'autosave' or 'slot-N' for a non-negative integer N.");
            if (input == "ui-click")
                address(out, field(&step, "uiClick"), path + "/uiClick", "UI click");
        }
        expectations_local(out, data.at("finalExpectations"), "/data/finalExpectations");
    } catch (const std::exception& e) {
        issue(out, "/data", "authoring.test.local-failure", e.what());
    }
    return out;
}

ValidationResult
validate_test_dependencies(std::string_view record_json, std::string_view manifest_json,
                           std::string_view traits_json, const AuthoringRecordResolver& resolve,
                           const std::function<bool(std::string_view, std::string_view)>& exists)
{
    ValidationResult out{true};
    try {
        const auto record = Json::parse(record_json);
        const auto& data = record.at("data");
        const auto manifest = Json::parse(manifest_json);
        const auto traits = Json::parse(traits_json);
        References refs{out, manifest, traits, resolve, exists};
        const auto& steps = data.at("steps");
        for (std::size_t i = 0; i < steps.size(); ++i) {
            const auto& step = steps.at(i);
            const auto path = "/data/steps/" + std::to_string(i);
            refs.expectations(step.at("expectations"), path + "/expectations");
            if (step.at("enabled") == false)
                continue;
            const auto input = str(&step, "input");
            if (input == "select-subjects") {
                const auto& subjects = step.at("selectSubjects").at("subjects");
                for (std::size_t j = 0; j < subjects.size(); ++j)
                    refs.subject(subjects.at(j),
                                 path + "/selectSubjects/subjects/" + std::to_string(j));
            }
            if (input == "primary-activate" || input == "open-verb-menu") {
                const auto& subject = step.at("subjectAction").at("subject");
                if (!subject.is_null())
                    refs.subject(subject, path + "/subjectAction/subject");
            }
            if (input == "run-interaction") {
                const auto& action = step.at("runInteraction");
                const auto& verb_ref = action.at("verb");
                std::optional<std::string> verb_json;
                if (!verb_ref.is_null()) {
                    const auto id = ref(&verb_ref);
                    refs.record("verbs", id, path + "/runInteraction/verb/$ref", "verbs record");
                    verb_json = resolve("verbs", id);
                }
                const auto& bindings = action.at("bindings");
                if (verb_json) {
                    const auto verb = Json::parse(*verb_json);
                    const auto& order = verb.at("data").at("bindingOrder");
                    std::set<std::string> expected, actual;
                    for (const auto& slot : order.array_range())
                        expected.insert(slot.as<std::string>());
                    for (const auto& binding : bindings.array_range())
                        actual.insert(str(&binding, "slotId"));
                    if (actual != expected || bindings.size() != expected.size())
                        issue(out, path + "/runInteraction/bindings", "authoring.test.bindings",
                              "Run Interaction must bind every named Verb slot exactly once.");
                }
                for (std::size_t j = 0; j < bindings.size(); ++j)
                    refs.subject(bindings.at(j).at("subject"), path + "/runInteraction/bindings/" +
                                                                   std::to_string(j) + "/subject");
            }
        }
        refs.expectations(data.at("finalExpectations"), "/data/finalExpectations");
    } catch (const std::exception& e) {
        issue(out, "/data", "authoring.test.dependencies-failure", e.what());
    }
    return out;
}

} // namespace noveltea::authoring
