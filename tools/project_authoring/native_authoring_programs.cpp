#include "native_authoring_programs.hpp"

#include "native_authoring_messages.hpp"
#include "native_authoring_shared.hpp"

#include <algorithm>
#include <array>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

const Json& object(const Json& source, std::string_view key)
{
    static const Json empty = Json::object();
    if (!source.is_object())
        return empty;
    const auto it = source.find(std::string(key));
    return it != source.end() && it->is_object() ? *it : empty;
}

const Json& array(const Json& source, std::string_view key)
{
    static const Json empty = Json::array();
    if (!source.is_object())
        return empty;
    const auto it = source.find(std::string(key));
    return it != source.end() && it->is_array() ? *it : empty;
}

Json optional(const Json& source, std::string_view key)
{
    if (!source.is_object())
        return nullptr;
    const auto it = source.find(std::string(key));
    return it != source.end() ? *it : Json(nullptr);
}

std::string str(const Json& source, std::string_view key)
{
    const auto value = optional(source, key);
    return value.is_string() ? value.get<std::string>() : "";
}

std::string escape(std::string_view source)
{
    std::string result;
    for (const char ch : source) {
        if (ch == '~')
            result += "~0";
        else if (ch == '/')
            result += "~1";
        else
            result += ch;
    }
    return result;
}

Json ref(const Json& source, std::string_view kind)
{
    if (source.is_null())
        return nullptr;
    if (!object(source, "$ref").contains("id"))
        throw std::runtime_error("Expected normalized " + std::string(kind) + " reference.");
    return {{"kind", kind}, {"id", source.at("$ref").at("id")}};
}

Json references(const Json& source)
{
    if (source.is_array()) {
        Json result = Json::array();
        for (const auto& item : source)
            result.push_back(references(item));
        return result;
    }
    if (!source.is_object())
        return source;
    if (source.contains("$ref")) {
        const auto& inner = source.at("$ref");
        const std::string collection = str(inner, "collection");
        if (collection.empty() && str(inner, "registry") == "interactableInstances")
            return ref(source, "interactable");
        for (const auto& [name, kind] :
             {std::pair{"rooms", "room"}, std::pair{"scenes", "scene"},
              std::pair{"dialogues", "dialogue"}, std::pair{"characters", "character"},
              std::pair{"interactables", "interactable"},
              std::pair{"interactableDefinitions", "interactable-definition"},
              std::pair{"verbs", "verb"}, std::pair{"traits", "trait"},
              std::pair{"materials", "material"}, std::pair{"assets", "asset"},
              std::pair{"layouts", "layout"}, std::pair{"archetypes", "archetype"},
              std::pair{"variables", "property"}, std::pair{"scripts", "script"}})
            if (collection == name)
                return ref(source, kind);
        throw std::runtime_error("Unsupported normalized reference collection '" + collection +
                                 "'.");
    }
    Json result = Json::object();
    for (const auto& [key, value] : source.items())
        result[key] = references(value);
    return result;
}

Json fields(const Json& source, std::initializer_list<std::string_view> keys)
{
    Json result = Json::object();
    for (const auto key : keys)
        if (source.contains(std::string(key)))
            result[std::string(key)] = references(source.at(std::string(key)));
    return result;
}

Json location(const Json& source);
Json inventory_operand(const Json& source);
Json matcher(const Json& source);

Json condition(const Json& source)
{
    const auto kind = str(source, "kind");
    if (kind == "always")
        return {{"kind", kind}};
    if (kind == "lua-predicate")
        return fields(source, {"kind", "source"});
    if (kind == "not")
        return {{"kind", kind}, {"condition", condition(source.at("condition"))}};
    if (kind == "all" || kind == "any") {
        Json children = Json::array();
        for (const auto& item : array(source, "conditions"))
            children.push_back(condition(item));
        return {{"kind", kind}, {"conditions", children}};
    }
    if (kind == "variable-comparison") {
        auto result = fields(source, {"operator", "value"});
        result["kind"] = "global-property-comparison";
        result["property"] = ref(source.at("variable"), "property");
        return result;
    }
    if (kind == "property-comparison")
        return fields(source, {"kind", "owner", "propertyId", "operator", "value"});
    if (kind == "trait-presence")
        return fields(source, {"kind", "owner", "trait", "present"});
    if (kind == "location-comparison") {
        auto result = fields(source, {"kind", "subject", "operator"});
        result["location"] = location(source.at("location"));
        return result;
    }
    if (kind == "inventory-quantity-comparison") {
        auto result = fields(source, {"kind", "operator", "quantity"});
        result["inventory"] = inventory_operand(source.at("inventory"));
        result["matcher"] = matcher(source.at("matcher"));
        return result;
    }
    throw std::runtime_error("Unsupported normalized Condition kind '" + kind + "'.");
}

Json inventory_reference(const Json& source)
{
    Json result = fields(source, {"owner", "inventoryId"});
    if (str(result.at("owner"), "kind") == "project")
        result["inventoryId"] = "player";
    return result;
}

Json inventory_operand(const Json& source)
{
    const auto kind = str(source, "kind");
    if (kind == "player-inventory" || kind == "command-result")
        return source;
    if (kind == "owner-inventory")
        return fields(source, {"kind", "owner", "inventoryId"});
    if (kind == "inventory")
        return {{"kind", kind}, {"inventory", inventory_reference(source.at("inventory"))}};
    throw std::runtime_error("Unsupported Inventory operand '" + kind + "'.");
}

Json location(const Json& source)
{
    const auto kind = str(source, "kind");
    if (kind == "unplaced")
        return {{"kind", kind}};
    if (kind == "room")
        return {{"kind", kind}, {"room", references(source.at("room"))}};
    if (kind == "inventory")
        return {{"kind", kind}, {"inventory", inventory_operand(source.at("inventory"))}};
    throw std::runtime_error("Unsupported Location operand '" + kind + "'.");
}

Json matcher(const Json& source)
{
    Json result = fields(source, {"traits", "properties"});
    if (!optional(source, "definition").is_null())
        result["definition"] = ref(source.at("definition"), "interactable-definition");
    if (!optional(source, "exact").is_null())
        result["exact"] = references(source.at("exact"));
    return result;
}

Json commands(const Json& project, const NativeMessageProjection& messages, const Json& source,
              const std::string& path)
{
    Json output = Json::array();
    for (const auto& command : source) {
        const auto command_path = path + "/@" + escape(str(command, "id"));
        try {
            output.push_back(lower_gameplay_command(project, messages, command, command_path));
        } catch (const std::exception& error) {
            const std::string message = error.what();
            if (message.starts_with("at /"))
                throw;
            throw std::runtime_error("at " + command_path + ": " + message);
        }
    }
    return output;
}

Json material_application(const Json& source)
{
    Json result{{"material", ref(optional(source, "material"), "material")}};
    Json parameters = Json::array();
    for (const auto& [name, value] : object(source, "parameters").items()) {
        Json parameter{{"name", name}, {"type", value.at("type")}};
        auto source_value = value.at("source");
        if (str(source_value, "kind") == "literal") {
            if (source_value.at("value").is_null())
                throw std::runtime_error("Material literal cannot be null.");
            auto literal = source_value.at("value");
            if (str(value, "type") == "color" && literal.is_array() && literal.size() == 4)
                literal = {
                    {"r", literal[0]}, {"g", literal[1]}, {"b", literal[2]}, {"a", literal[3]}};
            source_value["value"] = {{"type", value.at("type")}, {"value", literal}};
        }
        parameter["source"] = source_value;
        parameters.push_back(std::move(parameter));
    }
    if (!parameters.empty())
        result["materialParameters"] = std::move(parameters);
    Json textures = Json::array();
    for (const auto& [name, value] : object(source, "textures").items())
        textures.push_back({{"name", name}, {"source", ref(value.at("source"), "asset")}});
    if (!textures.empty())
        result["materialTextures"] = std::move(textures);
    return result;
}

Json compiled_text(const Json& project, const NativeMessageProjection& messages, const Json& value,
                   const std::string& path)
{
    return lower_authoring_text(project, messages, value, path);
}

Json scene_terminal(const Json& source)
{
    const auto kind = str(source, "kind");
    if (kind == "return")
        return fields(source, {"kind", "outcome"});
    if (kind == "continue-scene")
        return fields(source, {"kind", "scene", "inputs"});
    if (kind == "continue-dialogue")
        return fields(source, {"kind", "dialogue"});
    if (kind == "release-to-exploration" || kind == "complete-game")
        return {{"kind", kind}};
    throw std::runtime_error("Unsupported Scene terminal '" + kind + "'.");
}

Json transition_child(const Json& source)
{
    const auto type = str(source, "type");
    Json result{{"id", source.at("id")}, {"kind", type}};
    if (type == "clear-background")
        return result;
    if (type == "set-background") {
        result.update(fields(source, {"asset", "color", "fit"}));
        result.update(material_application(optional(source, "materialApplication")));
    } else if (type == "actor-cue") {
        result.update(
            fields(source, {"slotId", "character", "action", "profileId", "poseId", "expressionId",
                            "appearanceId", "position", "offset", "scale"}));
    } else if (type == "set-layout") {
        result.update(fields(source, {"layout", "action", "scaleOverrides", "slot"}));
        result["plane"] = "world-overlay";
    } else {
        throw std::runtime_error("Unsupported Scene transition child '" + type + "'.");
    }
    return result;
}

Json world_location(const Json& source)
{
    const auto kind = str(source, "kind");
    if (kind == "room")
        return {{"kind", kind}, {"room", ref(source.at("room"), "room")}};
    if (kind == "inventory")
        return {{"kind", kind}, {"inventory", inventory_reference(source.at("inventory"))}};
    if (kind == "unplaced")
        return {{"kind", kind}};
    throw std::runtime_error("Unsupported world transaction Location '" + kind + "'.");
}

Json world_operation(const Json& source)
{
    const auto kind = str(source, "kind");
    if (kind == "create-room")
        return fields(source, {"kind", "source"});
    if (kind == "create-character" || kind == "create-interactable") {
        Json result = fields(source, {"kind", "source", "definition", "quantity", "enabled",
                                      "visible", "roomPresentation"});
        if (kind == "create-interactable")
            result["definition"] = ref(source.at("definition"), "interactable-definition");
        result["location"] = world_location(source.at("location"));
        return result;
    }
    if (kind == "replace-configuration")
        return fields(source, {"kind", "instance", "source"});
    if (kind == "clear-configuration" || kind == "destroy-instance")
        return fields(source, {"kind", "instance"});
    if (kind == "retarget-room-exit")
        return fields(source, {"kind", "room", "exitId", "target"});
    throw std::runtime_error("Unsupported Runtime World transaction '" + kind + "'.");
}

Json typed_parameter(const Json& interfaces, const Json& source)
{
    const Json& value = source.at("value");
    if (value.is_null())
        throw std::runtime_error("Scene Material parameter value cannot be null.");
    std::string type;
    const std::string id = object(source.at("material"), "$ref").at("id").get<std::string>();
    // The native shared-definition lowerer already resolved inherited Material
    // presets and custom shader interfaces. Use its authoritative result.
    for (const auto& material : interfaces)
        if (str(material, "id") == id)
            for (const auto& parameter : array(material, "parameters"))
                if (str(parameter, "name") == str(source, "parameter"))
                    type = str(parameter, "type");
    if (type.empty()) {
        if (value.is_boolean())
            type = "bool";
        else if (value.is_number())
            type = "float";
        else if (value.is_array())
            type = "vec" + std::to_string(value.size());
        else
            type = "color";
    }
    Json normalized = value;
    if (type == "color" && value.is_array() && value.size() == 4)
        normalized = {{"r", value[0]}, {"g", value[1]}, {"b", value[2]}, {"a", value[3]}};
    return {{"type", type}, {"value", normalized}};
}

Json scene_step(const Json& project, const NativeMessageProjection& messages,
                const Json& material_interfaces, const Json& step, const std::string& path)
{
    const auto type = str(step, "type");
    Json result{{"id", step.at("id")}, {"kind", type}};
    if (step.contains("condition"))
        result["condition"] = condition(step.at("condition"));
    if (type == "set-background") {
        result.update(fields(step, {"owner", "asset", "color", "fit", "transition", "durationMs",
                                    "waitForCompletion", "skippable"}));
        result.update(material_application(optional(step, "materialApplication")));
    } else if (type == "actor-cue") {
        result.update(fields(step, {"owner", "slotId", "character", "action", "profileId", "poseId",
                                    "expressionId", "appearanceId", "position", "offset", "scale",
                                    "transition", "durationMs", "waitForCompletion", "skippable"}));
    } else if (type == "call-scene" || type == "start-detached-scene") {
        result.update(fields(step, {"scene", "inputs", "owner", "autosaveSafePoint"}));
    } else if (type == "call-dialogue") {
        result.update(fields(step, {"dialogue", "startBlockId", "autosaveSafePoint"}));
    } else if (type == "resume-dialogue") {
        result.update(fields(step, {"autosaveSafePoint"}));
    } else if (type == "show-text") {
        result.update(fields(step, {"speaker", "wait", "autosaveSafePoint"}));
        result["text"] = compiled_text(project, messages, step.at("text"), path + "/text");
    } else if (type == "audio-cue") {
        result.update(
            fields(step, {"owner", "asset", "purpose", "action", "lifetime", "pausePolicy", "gain",
                          "pan", "panSource", "fadeMs", "waitForCompletion", "causality",
                          "synchronized", "skipBehavior", "instanceId", "replacementGroup"}));
    } else if (type == "set-variable") {
        result["kind"] = "gameplay-effect-batch";
        result["operations"] = Json::array({{{"id", step.at("id")},
                                             {"kind", "set-global-property"},
                                             {"property", ref(step.at("variable"), "property")},
                                             {"value", step.at("value")}}});
    } else if (type == "gameplay-effect-batch") {
        result["operations"] =
            commands(project, messages, array(step, "operations"), path + "/operations");
    } else if (type == "runtime-world-transaction") {
        Json operations = Json::array();
        for (const auto& operation : array(step, "operations"))
            operations.push_back(world_operation(operation));
        result["operations"] = std::move(operations);
    } else if (type == "directed-room-change" || type == "navigation-attempt") {
        result.update(fields(step, {"room", "exitId"}));
    } else if (type == "call-interaction") {
        result["verb"] = ref(step.at("verb"), "verb");
        Json bindings = Json::array();
        for (const auto& binding : array(step, "bindings")) {
            Json subject = references(binding.at("subject"));
            if (str(subject, "kind") == "feature")
                subject["feature"] = references(binding.at("subject").at("feature"));
            bindings.push_back({{"slotId", binding.at("slotId")}, {"subject", subject}});
        }
        result["bindings"] = std::move(bindings);
    } else if (type == "run-lua") {
        result.update(fields(step, {"source", "mayYield", "autosaveSafePoint"}));
    } else if (type == "wait") {
        const auto kind = str(step, "waitKind");
        const std::set<std::string> kinds = {"duration",  "input", "condition",
                                             "operation", "audio", "layout-signal"};
        if (!kinds.contains(kind))
            throw std::runtime_error("Unsupported Scene wait '" + kind + "'.");
        result["kind"] = "wait-" + kind;
        result.update(
            fields(step, {"durationMs", "eventId", "owner", "slot", "signalId", "skippable"}));
        if (kind == "condition")
            result["waitCondition"] = condition(step.at("waitCondition"));
        if (kind != "duration")
            result.erase("durationMs");
        if (kind != "operation" && kind != "audio")
            result.erase("eventId");
        if (kind != "layout-signal")
            for (const auto field : {"owner", "slot", "signalId"})
                result.erase(field);
    } else if (type == "conditional-branch") {
        Json branches = Json::array();
        for (const auto& branch : array(step, "branches"))
            branches.push_back({{"id", branch.at("id")},
                                {"condition", condition(branch.at("condition"))},
                                {"targetInstructionId", branch.at("targetStepId")}});
        result["branches"] = std::move(branches);
        result["fallbackInstructionId"] = step.at("fallbackStepId");
    } else if (type == "choice") {
        result["prompt"] =
            optional(step, "prompt").is_null()
                ? Json(nullptr)
                : compiled_text(project, messages, step.at("prompt"), path + "/prompt");
        Json options = Json::array();
        for (const auto& option : array(step, "options")) {
            const auto option_path = path + "/options/@" + escape(str(option, "id"));
            Json output{{"id", option.at("id")},
                        {"label", compiled_text(project, messages, option.at("label"),
                                                option_path + "/label")},
                        {"effects", commands(project, messages, array(option, "effects"),
                                             option_path + "/effects")},
                        {"targetInstructionId", option.at("targetStepId")}};
            if (option.contains("condition"))
                output["condition"] = condition(option.at("condition"));
            options.push_back(std::move(output));
        }
        result["options"] = std::move(options);
        result["autosaveSafePoint"] = step.at("autosaveSafePoint");
    } else if (type == "set-layout") {
        result.update(fields(step, {"owner", "layout", "action", "scaleOverrides", "slot",
                                    "transition", "durationMs", "waitForCompletion", "skippable"}));
    } else if (type == "material-parameter") {
        result.update(
            fields(step, {"owner", "target", "material", "parameter", "transition", "durationMs",
                          "easing", "clock", "waitForCompletion", "skippable"}));
        result["value"] = typed_parameter(material_interfaces, step);
    } else if (type == "postprocess-effect") {
        result.update(fields(step, {"owner", "action", "instanceId", "scope", "order", "clock"}));
        result.update(material_application(optional(step, "materialApplication")));
    } else if (type == "transition-group") {
        result.update(
            fields(step, {"owner", "durationMs", "color", "waitForCompletion", "skippable"}));
        result["transitionKind"] = step.at("transitionKind");
        Json children = Json::array();
        for (const auto& child : array(step, "children"))
            children.push_back(transition_child(child));
        result["children"] = std::move(children);
    } else {
        throw std::runtime_error("Unsupported Scene instruction '" + type + "' at " + path);
    }
    return result;
}

void validate_actor_cue(const Json& characters, const Json& cue, const std::string& path)
{
    const auto& original = object(cue.at("character"), "$ref");
    const std::string id = str(original, "id");
    const auto& character = object(object(characters, id), "data");
    if (character.empty())
        throw std::runtime_error("at " + path + "/character: Unknown Character '" + id + "'.");
    const Json authored_profile = optional(cue, "profileId");
    const auto profile_id = authored_profile.is_string()
                                ? authored_profile.get<std::string>()
                                : str(object(character, "defaults"), "profileId");
    const auto& profiles = array(character, "profiles");
    const auto profile = std::find_if(profiles.begin(), profiles.end(), [&](const Json& item) {
        return str(item, "id") == profile_id;
    });
    const auto pose_id = str(cue, "poseId");
    if (!pose_id.empty()) {
        const auto& poses =
            profile != profiles.end() ? array(*profile, "poses") : array(Json::object(), "poses");
        if (std::none_of(poses.begin(), poses.end(),
                         [&](const Json& item) { return str(item, "id") == pose_id; }))
            throw std::runtime_error("at " + path + "/poseId: Pose '" + pose_id +
                                     "' does not exist on Character '" + id + "'.");
    }
    const auto expression_id = str(cue, "expressionId");
    if (!expression_id.empty() &&
        std::none_of(array(character, "expressions").begin(), array(character, "expressions").end(),
                     [&](const Json& item) { return str(item, "id") == expression_id; }))
        throw std::runtime_error("at " + path + "/expressionId: Expression '" + expression_id +
                                 "' does not exist on Character '" + id + "'.");
}

void lower_room(const Json& project, const NativeMessageProjection& messages, const Json& source,
                Json& target, const std::string& path)
{
    const auto& authored_exits = array(source, "exits");
    for (auto& exit : target["exits"]) {
        const auto id = str(exit, "id");
        auto found = std::find_if(authored_exits.begin(), authored_exits.end(),
                                  [&](const Json& item) { return str(item, "id") == id; });
        if (found != authored_exits.end())
            exit["onRejected"] = commands(project, messages, array(*found, "onRejected"),
                                          path + "/exits/@" + escape(id) + "/onRejected");
    }
    for (const auto member : {"beforeEnter", "afterEnter", "beforeLeave", "afterLeave",
                              "onEnterRejected", "onLeaveRejected"})
        target["lifecycle"][member] =
            commands(project, messages, array(source.at("lifecycle"), member),
                     path + "/lifecycle/" + member);
}
} // namespace

Json lower_gameplay_command(const Json& project, const NativeMessageProjection& messages,
                            const Json& command, const std::string& semantic_path)
{
    const auto kind = str(command, "kind");
    static const std::set<std::string> supported = {"set-global-property",
                                                    "unset-global-property",
                                                    "set-property",
                                                    "unset-property",
                                                    "add-trait",
                                                    "remove-trait",
                                                    "set-enabled",
                                                    "set-visible",
                                                    "move-instance",
                                                    "create-room",
                                                    "create-character",
                                                    "create-interactable",
                                                    "destroy-instance",
                                                    "split-quantity",
                                                    "merge-quantity",
                                                    "transfer-quantity",
                                                    "add-quantity",
                                                    "consume-quantity",
                                                    "present-inventory",
                                                    "navigate-exit",
                                                    "change-room",
                                                    "notify",
                                                    "call-scene",
                                                    "call-dialogue",
                                                    "run-lua",
                                                    "if"};
    if (!supported.contains(kind))
        throw std::runtime_error("Unsupported Gameplay Command '" + kind + "' at " + semantic_path);
    Json result = fields(command, {"id",
                                   "kind",
                                   "owner",
                                   "trait",
                                   "subject",
                                   "enabled",
                                   "visible",
                                   "source",
                                   "quantity",
                                   "definition",
                                   "result",
                                   "instance",
                                   "receiver",
                                   "donor",
                                   "mode",
                                   "exitId",
                                   "room",
                                   "scene",
                                   "dialogue",
                                   "layout",
                                   "useTriggerAnchor",
                                   "parentToTriggeringLayout",
                                   "coexist",
                                   "value",
                                   "propertyId",
                                   "roomPresentation"});
    if (kind == "set-global-property" || kind == "unset-global-property") {
        result["property"] = ref(command.at("variable"), "property");
    } else if (kind == "set-property" || kind == "unset-property") {
        result.erase("propertyId");
        result["property"] = {{"kind", "property"}, {"id", command.at("propertyId")}};
    } else if (kind == "create-room" || kind == "create-character") {
        if (kind == "create-character")
            result["location"] = location(command.at("location"));
    } else if (kind == "create-interactable" || kind == "add-quantity" || kind == "move-instance" ||
               kind == "transfer-quantity") {
        result["location"] = location(command.at("location"));
        if (kind == "create-interactable" || kind == "add-quantity")
            result["definition"] = ref(command.at("definition"), "interactable-definition");
    } else if (kind == "consume-quantity" || kind == "split-quantity" || kind == "merge-quantity") {
        // The source/receiver/donor operands were already lowered by reference identity.
    }
    if (kind == "transfer-quantity" || kind == "consume-quantity") {
        if (str(command, "mode") == "aggregate") {
            result["matcher"] = matcher(command.at("matcher"));
            if (command.contains("sourceInventory"))
                result["sourceInventory"] = inventory_operand(command.at("sourceInventory"));
        }
    }
    if (kind == "present-inventory") {
        result["inventory"] = inventory_operand(command.at("inventory"));
        result["layout"] = ref(optional(command, "layout"), "layout");
    }
    if (kind == "notify")
        result["message"] =
            compiled_text(project, messages, command.at("message"), semantic_path + "/message");
    if (kind == "if") {
        result["condition"] = condition(command.at("condition"));
        result["then"] =
            commands(project, messages, array(command, "then"), semantic_path + "/then");
        result["else"] =
            commands(project, messages, array(command, "else"), semantic_path + "/else");
    }
    return result;
}

Json lower_gameplay_condition(const Json& source) { return condition(source); }

Json lower_room_scene_programs(const Json& project, const NativeMessageProjection& messages,
                               Json shared)
{
    const auto& authored = messages.lowered_project;
    const Json material_interfaces = shared.at("resources").at("materialInterfaces");
    const auto& characters = object(authored, "characters");
    for (auto& room : shared["definitions"]["rooms"]) {
        const auto id = str(room, "id");
        try {
            const auto data = effective_room_authoring_data(authored, id, false);
            lower_room(project, messages, data, room, "/rooms/" + escape(id) + "/data");
        } catch (const std::exception& error) {
            if (std::string_view(error.what()).starts_with("at /"))
                throw;
            throw std::runtime_error("at /rooms/" + escape(id) + "/data: " + error.what());
        }
    }
    for (auto& archetype : shared["archetypes"]) {
        if (str(archetype, "instanceKind") != "room")
            continue;
        const auto id = str(archetype, "id");
        try {
            const auto data = effective_room_authoring_data(authored, id, true);
            lower_room(project, messages, data, archetype["configuration"],
                       "/archetypes/" + escape(id) + "/configuration");
        } catch (const std::exception& error) {
            if (std::string_view(error.what()).starts_with("at /"))
                throw;
            throw std::runtime_error("at /archetypes/" + escape(id) +
                                     "/configuration: " + error.what());
        }
    }
    for (auto& scene : shared["definitions"]["scenes"]) {
        const auto id = str(scene, "id");
        const auto& data = object(object(authored.at("scenes"), id), "data");
        if (data.empty())
            throw std::runtime_error("at /scenes/" + escape(id) +
                                     "/data: Validated Scene data is missing.");
        const auto root = "/scenes/" + escape(id) + "/data/events";
        std::set<std::string> executable;
        for (const auto& step : array(data, "events"))
            if (str(step, "type") != "comment" && step.value("enabled", true))
                executable.insert(str(step, "id"));
        for (const auto& step : array(data, "events")) {
            if (str(step, "type") == "comment" || !step.value("enabled", true))
                continue;
            const auto kind = str(step, "type");
            Json targets = Json::array();
            if (kind == "conditional-branch") {
                for (const auto& branch : array(step, "branches"))
                    targets.push_back(branch.at("targetStepId"));
                targets.push_back(step.at("fallbackStepId"));
            } else if (kind == "choice") {
                for (const auto& option : array(step, "options"))
                    targets.push_back(option.at("targetStepId"));
            }
            for (const auto& target : targets)
                if (!executable.contains(target.get<std::string>()))
                    throw std::runtime_error("at " + root + "/@" + escape(str(step, "id")) +
                                             ": Scene target '" + target.get<std::string>() +
                                             "' is not executable.");
        }
        Json events = Json::array();
        for (const auto& step : array(data, "events")) {
            if (str(step, "type") == "comment" || !step.value("enabled", true))
                continue;
            const auto path = root + "/@" + escape(str(step, "id"));
            try {
                if (str(step, "type") == "actor-cue")
                    validate_actor_cue(characters, step, path);
                if (str(step, "type") == "transition-group")
                    for (const auto& child : array(step, "children"))
                        if (str(child, "type") == "actor-cue")
                            validate_actor_cue(characters, child,
                                               path + "/children/@" + escape(str(child, "id")));
                if (str(step, "type") == "call-dialogue" && !str(step, "startBlockId").empty()) {
                    const auto dialogue_id = str(object(step.at("dialogue"), "$ref"), "id");
                    const auto& dialogue =
                        object(object(authored.at("dialogues"), dialogue_id), "data");
                    if (std::none_of(array(dialogue, "blocks").begin(),
                                     array(dialogue, "blocks").end(), [&](const Json& block) {
                                         return str(block, "id") == str(step, "startBlockId");
                                     }))
                        throw std::runtime_error("at " + path + "/startBlockId: Dialogue block '" +
                                                 str(step, "startBlockId") +
                                                 "' does not exist in Dialogue '" + dialogue_id +
                                                 "'.");
                }
                events.push_back({{"id", step.at("id")},
                                  {"timeline", step.at("timeline")},
                                  {"completionDependencies", step.at("completionDependencies")},
                                  {"instruction", scene_step(project, messages, material_interfaces,
                                                             step, path)}});
            } catch (const std::exception& error) {
                if (std::string_view(error.what()).starts_with("at /"))
                    throw;
                throw std::runtime_error("at " + path + ": " + error.what());
            }
        }
        scene["program"] = {{"events", std::move(events)}};
        scene["terminal"] = scene_terminal(data.at("terminal"));
    }
    return shared;
}
} // namespace noveltea::cli
