#include "native_flow_prediction.hpp"

#include <algorithm>
#include <deque>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

const Json& array(const Json& value, std::string_view key)
{
    static const Json empty = Json::array();
    const auto found = value.is_object() ? value.find(std::string(key)) : value.end();
    return found != value.end() && found->is_array() ? *found : empty;
}
const Json& obj(const Json& value, std::string_view key)
{
    static const Json empty = Json::object();
    const auto found = value.is_object() ? value.find(std::string(key)) : value.end();
    return found != value.end() && found->is_object() ? *found : empty;
}
Json get(const Json& value, std::string_view key)
{
    if (!value.is_object())
        return nullptr;
    const auto it = value.find(std::string(key));
    return it == value.end() ? Json(nullptr) : *it;
}
std::string str(const Json& value, std::string_view key)
{
    const auto field = get(value, key);
    return field.is_string() ? field.get<std::string>() : std::string{};
}
bool truthy(const Json& value) { return !value.is_null() && value != false; }
Json ref(std::string_view kind, std::string_view id) { return {{"kind", kind}, {"id", id}}; }
Json point(std::string_view kind, std::string_view field, const Json& value)
{
    return {{"kind", kind}, {field, value}};
}
Json dialogue_point(const std::string& dialogue, const std::string& block, const std::string& stage,
                    std::string_view segment = {}, std::string_view edge = {},
                    std::size_t cursor = 0)
{
    Json result{{"kind", "dialogue-position"},
                {"dialogue", ref("dialogue", dialogue)},
                {"blockId", block},
                {"stage", stage},
                {"cursor", cursor}};
    if (!segment.empty())
        result["segmentId"] = segment;
    if (!edge.empty())
        result["edgeId"] = edge;
    return result;
}
Json sequential(Json next = nullptr)
{
    return {{"kind", "sequential"}, {"successor", std::move(next)}};
}

Json summary(const Json& commands)
{
    Json result = Json::array();
    for (const auto& command : commands) {
        const auto kind = str(command, "kind");
        Json entry{{"kind", ""}};
        if (command.contains("id"))
            entry["commandId"] = command.at("id");
        const auto copy = [&](std::string_view field) {
            entry[std::string(field)] = command.at(std::string(field));
        };
        if (kind == "set-global-property") {
            entry["kind"] = kind;
            copy("property");
            copy("value");
        } else if (kind == "unset-global-property") {
            entry["kind"] = "invalidate-global-property";
            copy("property");
        } else if (kind == "set-property") {
            entry["kind"] = "set-identity-property";
            copy("owner");
            copy("property");
            copy("value");
        } else if (kind == "add-trait" || kind == "remove-trait") {
            entry["kind"] = "set-trait-presence";
            copy("owner");
            copy("trait");
            entry["present"] = kind == "add-trait";
        } else if (kind == "move-instance") {
            entry["kind"] = "set-location";
            copy("subject");
            copy("location");
        } else if (kind == "unset-property" || kind == "set-enabled" || kind == "set-visible" ||
                   kind == "create-room" || kind == "create-character" ||
                   kind == "create-interactable" || kind == "destroy-instance" ||
                   kind == "split-quantity" || kind == "merge-quantity" ||
                   kind == "transfer-quantity" || kind == "add-quantity" ||
                   kind == "consume-quantity") {
            entry["kind"] = "invalidate-condition-facts";
        } else if (kind == "navigate-exit" || kind == "change-room") {
            entry["kind"] = "invalidate-prediction-state";
        } else if (kind == "call-scene" || kind == "call-dialogue") {
            entry["kind"] = kind;
            copy(kind == "call-scene" ? "scene" : "dialogue");
        } else if (kind == "run-lua") {
            entry["kind"] = "opaque";
        } else if (kind == "if") {
            entry["kind"] = "if";
            copy("condition");
            entry["thenCommands"] = summary(array(command, "then"));
            entry["elseCommands"] = summary(array(command, "else"));
        } else {
            continue;
        }
        result.push_back(std::move(entry));
    }
    return result;
}
Json target_program(const Json& target)
{
    const auto kind = str(target, "kind");
    if (kind == "scene" || kind == "dialogue" || kind == "room")
        return Json::array(
            {{{"kind", kind == "room" ? "enter-room" : "call-" + kind}, {kind, target.at(kind)}}});
    return Json::array();
}
Json interaction_program(const Json& program)
{
    Json result = summary(array(program, "instructions"));
    const auto flow = target_program(get(program, "completion"));
    result.insert(result.end(), flow.begin(), flow.end());
    return result;
}
void background_deps(Json& result, const Json& background)
{
    for (const auto* kind : {"asset", "material"})
        if (truthy(get(background, kind)))
            result.push_back({{"kind", kind}, {kind, background.at(kind)}});
}
Json character_dependency(const Json& character, const Json& options = Json::object())
{
    Json result{{"kind", "character"}, {"character", character}};
    for (const auto* key : {"profileId", "poseId", "expressionId", "appearanceId"})
        result[key] = get(options, key);
    return result;
}
Json scene_deps(const Json& instruction)
{
    Json result = Json::array();
    const auto kind = str(instruction, "kind");
    if (kind == "set-background") {
        background_deps(result, instruction);
    } else if (kind == "actor-cue" && str(instruction, "action") != "hide") {
        result.push_back(character_dependency(instruction.at("character"), instruction));
    } else if (kind == "audio-cue" && truthy(get(instruction, "asset")) &&
               (str(instruction, "action") == "play" || str(instruction, "action") == "fade-in")) {
        result.push_back({{"kind", "audio"},
                          {"asset", instruction.at("asset")},
                          {"purpose", instruction.at("purpose")}});
    } else if (kind == "set-layout" && str(instruction, "action") != "hide" &&
               truthy(get(instruction, "layout"))) {
        result.push_back({{"kind", "layout"}, {"layout", instruction.at("layout")}});
    } else if (kind == "material-parameter") {
        result.push_back({{"kind", "material"}, {"material", instruction.at("material")}});
    } else if (kind == "postprocess-effect" && str(instruction, "action") == "upsert" &&
               truthy(get(instruction, "material"))) {
        result.push_back({{"kind", "material"}, {"material", instruction.at("material")}});
    } else if (kind == "transition-group") {
        for (const auto& child : array(instruction, "children")) {
            const auto child_kind = str(child, "kind");
            if (child_kind == "set-background")
                background_deps(result, child);
            else if (child_kind == "actor-cue" && str(child, "action") != "hide")
                result.push_back(character_dependency(child.at("character"), child));
            else if (child_kind == "set-layout" && str(child, "action") != "hide" &&
                     truthy(get(child, "layout")))
                result.push_back({{"kind", "layout"}, {"layout", child.at("layout")}});
        }
    }
    return result;
}
Json scene_program(const Json& instruction)
{
    const auto kind = str(instruction, "kind");
    if (kind == "call-scene" || kind == "start-detached-scene")
        return Json::array({{{"kind", kind}, {"scene", instruction.at("scene")}}});
    if (kind == "call-dialogue")
        return Json::array({{{"kind", kind}, {"dialogue", instruction.at("dialogue")}}});
    if (kind == "gameplay-effect-batch")
        return summary(array(instruction, "operations"));
    if (kind == "run-lua")
        return Json::array({{{"kind", "opaque"}}});
    if (kind == "runtime-world-transaction")
        return Json::array({{{"kind", "invalidate-condition-facts"}}});
    if (kind == "directed-room-change" || kind == "navigation-attempt" ||
        kind == "call-interaction")
        return Json::array({{{"kind", "invalidate-prediction-state"}}});
    return Json::array();
}
std::string scene_frontier(const Json& instruction)
{
    const auto kind = str(instruction, "kind");
    if (kind == "choice")
        return "decision";
    if (kind == "wait-input" || kind == "wait-condition" || kind == "wait-operation" ||
        kind == "wait-audio" || kind == "wait-layout-signal")
        return "strong-wait";
    if (kind == "wait-duration")
        return instruction.value("durationMs", 0) <= 2000 ? "short-wait" : "strong-wait";
    if (kind == "show-text")
        return str(instruction, "wait") == "input" ? "strong-wait" : "normal";
    if (kind == "audio-cue")
        return instruction.value("waitForCompletion", false) ? "strong-wait" : "normal";
    if (kind == "set-background" || kind == "actor-cue" || kind == "set-layout" ||
        kind == "material-parameter" || kind == "transition-group") {
        if (!instruction.value("waitForCompletion", false))
            return "normal";
        return instruction.value("durationMs", 0) <= 2000 ? "short-wait" : "strong-wait";
    }
    if (kind == "run-lua" && instruction.value("mayYield", false))
        return "strong-wait";
    return "normal";
}

Json initial_dialogue_deps(const Json& dialogue)
{
    Json result = Json::array();
    for (const auto& slot : array(dialogue, "stageSlots")) {
        const auto initial = get(slot, "initial");
        if (initial.is_object() && initial.value("visible", false))
            result.push_back(character_dependency(initial.at("character"), initial));
    }
    for (const auto& slot : array(dialogue, "mediaSlots")) {
        const auto initial = get(slot, "initial");
        if (!slot.value("visible", false) || !initial.is_object())
            continue;
        if (str(initial, "kind") == "image")
            result.push_back({{"kind", "asset"}, {"asset", initial.at("asset")}});
        else
            result.push_back(character_dependency(initial.at("character"), initial));
    }
    return result;
}
Json stage_characters(const Json& dialogue, const std::string& slot_id)
{
    Json characters = Json::array();
    std::set<std::string> seen;
    const auto append = [&](const Json& character) {
        if (seen.insert(str(character, "id")).second)
            characters.push_back(character);
    };
    for (const auto& slot : array(dialogue, "stageSlots")) {
        const auto initial = get(slot, "initial");
        if (str(slot, "id") == slot_id && initial.is_object())
            append(initial.at("character"));
    }
    for (const auto& block : array(obj(dialogue, "program"), "blocks"))
        if (str(block, "kind") == "sequence")
            for (const auto& segment : array(block, "segments"))
                if (str(segment, "kind") == "line")
                    for (const auto& cue : array(segment, "cues")) {
                        const auto mutation = obj(cue, "mutation");
                        if (str(cue, "kind") == "stage" && str(mutation, "slotId") == slot_id &&
                            truthy(get(mutation, "character"))) {
                            const auto& character = mutation.at("character");
                            append(character);
                        }
                    }
    return characters;
}
Json media_contents(const Json& dialogue, const std::string& slot_id)
{
    Json contents = Json::array();
    const auto append = [&](const Json& content) {
        if (!truthy(content))
            return;
        if (std::find(contents.begin(), contents.end(), content) == contents.end())
            contents.push_back(content);
    };
    for (const auto& slot : array(dialogue, "mediaSlots"))
        if (str(slot, "id") == slot_id)
            append(get(slot, "initial"));
    for (const auto& block : array(obj(dialogue, "program"), "blocks"))
        if (str(block, "kind") == "sequence")
            for (const auto& segment : array(block, "segments"))
                if (str(segment, "kind") == "line")
                    for (const auto& cue : array(segment, "cues")) {
                        const auto mutation = obj(cue, "mutation");
                        if (str(cue, "kind") == "media" && str(mutation, "slotId") == slot_id)
                            append(get(mutation, "content"));
                    }
    return contents;
}
bool contains_id(const Json& values, const std::string& id)
{
    return std::any_of(values.begin(), values.end(),
                       [&](const Json& value) { return str(value, "id") == id; });
}
Json valid_character_deps(const Json& wire, const Json& character, const Json& options)
{
    const auto& characters = array(obj(wire, "definitions"), "characters");
    const auto it = std::find_if(characters.begin(), characters.end(), [&](const Json& candidate) {
        return str(candidate, "id") == str(character, "id");
    });
    if (it == characters.end())
        return Json::array({character_dependency(character, options)});
    for (const auto* key : {"expressionId", "appearanceId"}) {
        const auto id = str(options, key);
        if (!id.empty() &&
            !contains_id(
                array(*it, std::string(key) == "expressionId" ? "expressions" : "appearances"), id))
            return Json::array();
    }
    const auto profile = str(options, "profileId");
    const auto pose = str(options, "poseId");
    if (!profile.empty()) {
        for (const auto& value : array(*it, "profiles"))
            if (str(value, "id") == profile)
                return pose.empty() || contains_id(array(value, "poses"), pose)
                           ? Json::array({character_dependency(character, options)})
                           : Json::array();
        return Json::array();
    }
    if (!pose.empty()) {
        Json result = Json::array();
        for (const auto& value : array(*it, "profiles"))
            if (contains_id(array(value, "poses"), pose)) {
                Json qualified = options;
                qualified["profileId"] = value.at("id");
                result.push_back(character_dependency(character, qualified));
            }
        return result;
    }
    return Json::array({character_dependency(character, options)});
}
Json cue_deps(const Json& wire, const Json& dialogue, const Json& block, const Json& line,
              const Json& cue)
{
    Json result = Json::array();
    const auto kind = str(cue, "kind");
    if (kind == "speaker-expression") {
        Json speaker = get(line, "speaker");
        if (!truthy(speaker))
            speaker = get(block, "defaultSpeaker");
        if (!truthy(speaker))
            speaker = get(dialogue, "defaultSpeaker");
        if (truthy(speaker))
            result.push_back(
                character_dependency(speaker, {{"expressionId", get(cue, "expressionId")}}));
    } else if (kind == "stage" || kind == "media") {
        const auto& mutation = obj(cue, "mutation");
        const auto action = str(mutation, "action");
        if (action == "hide" || action == "clear")
            return result;
        if (kind == "stage") {
            Json characters = Json::array();
            if (truthy(get(mutation, "character")))
                characters.push_back(mutation.at("character"));
            else
                characters = stage_characters(dialogue, str(mutation, "slotId"));
            for (const auto& character : characters) {
                const auto candidates = valid_character_deps(wire, character, mutation);
                result.insert(result.end(), candidates.begin(), candidates.end());
            }
        } else {
            Json contents = Json::array();
            if (truthy(get(mutation, "content")))
                contents.push_back(mutation.at("content"));
            else
                contents = media_contents(dialogue, str(mutation, "slotId"));
            for (const auto& content : contents) {
                if (str(content, "kind") == "image")
                    result.push_back({{"kind", "asset"}, {"asset", content.at("asset")}});
                else
                    result.push_back(character_dependency(content.at("character"), content));
            }
        }
    } else if (kind == "gesture") {
        for (const auto& character : stage_characters(dialogue, str(cue, "slotId")))
            result.push_back(character_dependency(character));
    } else if (kind == "voice" || kind == "sound-effect") {
        result.push_back({{"kind", "audio"}, {"asset", cue.at("asset")}, {"purpose", kind}});
    }
    return result;
}
std::string cue_frontier(const Json& cue)
{
    const auto kind = str(cue, "kind");
    if (kind == "voice" || kind == "sound-effect" || kind == "gesture")
        return cue.value("waitForCompletion", false) ? "strong-wait" : "normal";
    if (kind == "camera" && obj(cue, "emphasis").value("waitForCompletion", false))
        return obj(cue, "emphasis").value("durationMs", 0) <= 2000 ? "short-wait" : "strong-wait";
    return "normal";
}
Json hint_target(const Json& target)
{
    const auto kind = str(target, "kind");
    Json result{{"kind", kind}};
    result[kind] = ref(kind, str(obj(target, kind).at("$ref"), "id"));
    return result;
}
Json hint_point(const Json& source)
{
    const auto kind = str(source, "kind");
    Json point{{"kind", kind}};
    const std::string field = kind.starts_with("scene-")      ? "scene"
                              : kind.starts_with("dialogue-") ? "dialogue"
                              : kind == "room-lifecycle"      ? "room"
                              : kind == "interaction-rule"    ? "interaction"
                              : kind == "verb-default"        ? "verb"
                              : kind == "resident-layout"     ? "layout"
                                                              : "";
    if (!field.empty())
        point[field] = ref(field, str(obj(obj(source, field), "$ref"), "id"));
    if (kind == "scene-step")
        point["stepId"] = source.at("stepId");
    if (kind == "dialogue-position") {
        for (const auto* key : {"blockId", "stage", "cursor", "segmentId", "edgeId"})
            if (source.contains(key))
                point[key] = source.at(key);
    }
    if (kind == "room-lifecycle")
        point["stage"] = source.at("stage");
    if (kind == "interaction-rule")
        point["ruleId"] = source.at("ruleId");
    return point;
}

enum class StaticTruth {
    Yes,
    No,
    Unknown
};
StaticTruth static_truth(const Json& condition)
{
    const auto kind = str(condition, "kind");
    if (kind == "always")
        return StaticTruth::Yes;
    if (kind == "not") {
        const auto child = static_truth(get(condition, "condition"));
        return child == StaticTruth::Yes  ? StaticTruth::No
               : child == StaticTruth::No ? StaticTruth::Yes
                                          : StaticTruth::Unknown;
    }
    if (kind == "all" || kind == "any") {
        bool unknown = false;
        for (const auto& child : array(condition, "conditions")) {
            const auto value = static_truth(child);
            if ((kind == "all" && value == StaticTruth::No) ||
                (kind == "any" && value == StaticTruth::Yes))
                return value;
            unknown |= value == StaticTruth::Unknown;
        }
        return unknown ? StaticTruth::Unknown : kind == "all" ? StaticTruth::Yes : StaticTruth::No;
    }
    return StaticTruth::Unknown;
}

struct PredictionBuilder {
    const Json& wire;
    const Json& hints;
    Json dependency_groups = Json::array();
    Json slices = Json::array();
    std::map<std::string, std::size_t> group_by_key;
    std::map<std::string, std::size_t> slice_by_point;
    std::set<std::string> hinted_points;

    explicit PredictionBuilder(const Json& value, const Json& authored_hints)
        : wire(value), hints(authored_hints)
    {
        for (const auto& [_, hint] : hints.items())
            if (str(obj(hint, "attachment"), "kind") == "point")
                hinted_points.insert(hint_point(hint.at("attachment").at("point")).dump());
    }

    std::size_t add(Json target, Json dependencies = Json::array(), Json program = Json::array(),
                    Json condition = nullptr, std::string frontier = "normal")
    {
        Json group_refs = Json::array();
        if (!dependencies.empty()) {
            const std::string key = dependencies.dump();
            auto it = group_by_key.find(key);
            if (it == group_by_key.end()) {
                const auto index = dependency_groups.size();
                dependency_groups.push_back(std::move(dependencies));
                it = group_by_key.emplace(key, index).first;
            }
            group_refs.push_back(it->second);
        }
        Json slice{{"point", target},
                   {"dependencyGroups", std::move(group_refs)},
                   {"conditionFalseSuccessor", nullptr},
                   {"control", sequential()},
                   {"frontier", std::move(frontier)},
                   {"program", std::move(program)}};
        if (truthy(condition))
            slice["condition"] = std::move(condition);
        const auto index = slices.size();
        slice_by_point[target.dump()] = index;
        slices.push_back(std::move(slice));
        return index;
    }
    void resume(std::size_t index, const Json& target)
    {
        if (!slices[index].contains("resumePoints"))
            slices[index]["resumePoints"] = Json::array();
        slices[index]["resumePoints"].push_back(target);
        slice_by_point[target.dump()] = index;
    }
    Json find(const Json& target) const
    {
        const auto it = slice_by_point.find(target.dump());
        return it == slice_by_point.end() ? Json(nullptr) : Json(it->second);
    }
    void control(Json index, Json next)
    {
        if (index.is_number_unsigned() || index.is_number_integer())
            slices[index.get<std::size_t>()]["control"] = sequential(std::move(next));
    }

    void create_slices()
    {
        const auto& definitions = obj(wire, "definitions");
        for (const auto& scene : array(definitions, "scenes")) {
            const auto scene_ref = ref("scene", str(scene, "id"));
            Json deps = Json::array();
            const auto& stage = obj(scene, "stage");
            if (str(stage, "kind") == "staged-room")
                deps.push_back({{"kind", "room"}, {"room", stage.at("room")}});
            else if (str(stage, "kind") == "blank") {
                background_deps(deps, obj(stage, "background"));
                if (truthy(get(stage, "layout")))
                    deps.push_back({{"kind", "layout"}, {"layout", stage.at("layout")}});
            }
            add(point("scene-entry", "scene", scene_ref), std::move(deps));
            Json inert_run = nullptr;
            for (const auto& event : array(obj(scene, "program"), "events")) {
                const auto target =
                    Json{{"kind", "scene-step"}, {"scene", scene_ref}, {"stepId", event.at("id")}};
                const auto& instruction = event.at("instruction");
                auto dependencies = scene_deps(instruction);
                auto program = scene_program(instruction);
                const auto frontier = scene_frontier(instruction);
                const bool inert = str(instruction, "kind") == "show-text" &&
                                   str(instruction, "wait") == "immediate" &&
                                   dependencies.empty() && program.empty() &&
                                   !truthy(get(instruction, "condition")) && frontier == "normal" &&
                                   !hinted_points.contains(target.dump());
                if (inert && !inert_run.is_null()) {
                    resume(inert_run.get<std::size_t>(), target);
                    continue;
                }
                const auto index = add(target, std::move(dependencies), std::move(program),
                                       get(instruction, "condition"), frontier);
                inert_run = inert ? Json(index) : Json(nullptr);
            }
            add(point("scene-terminal", "scene", scene_ref));
        }

        for (const auto& dialogue : array(definitions, "dialogues")) {
            const auto id = str(dialogue, "id");
            const auto dialogue_ref = ref("dialogue", id);
            add(point("dialogue-entry", "dialogue", dialogue_ref), initial_dialogue_deps(dialogue));
            const auto& program = obj(dialogue, "program");
            for (const auto& block : array(program, "blocks")) {
                const auto block_id = str(block, "id");
                add(dialogue_point(id, block_id, "enter-block"));
                if (str(block, "kind") == "choice") {
                    add(dialogue_point(id, block_id, "present-choices"), Json::array(),
                        Json::array(), nullptr, "decision");
                    continue;
                }
                if (str(block, "kind") != "sequence")
                    continue;
                for (const auto& segment : array(block, "segments")) {
                    const auto segment_id = str(segment, "id");
                    const auto kind = str(segment, "kind");
                    if (kind == "line") {
                        Json speaker = get(segment, "speaker");
                        if (!truthy(speaker))
                            speaker = get(block, "defaultSpeaker");
                        if (!truthy(speaker))
                            speaker = get(dialogue, "defaultSpeaker");
                        const auto& cues = array(segment, "cues");
                        for (std::size_t cursor = 0; cursor <= cues.size(); ++cursor) {
                            Json deps = Json::array();
                            if (cursor == 0 && truthy(speaker))
                                deps.push_back(character_dependency(speaker));
                            if (cursor < cues.size()) {
                                const auto cue_dependencies =
                                    cue_deps(wire, dialogue, block, segment, cues[cursor]);
                                deps.insert(deps.end(), cue_dependencies.begin(),
                                            cue_dependencies.end());
                            }
                            add(dialogue_point(id, block_id, "present-segment", segment_id, {},
                                               cursor),
                                std::move(deps), Json::array(),
                                cursor == 0 ? get(segment, "condition") : Json(nullptr),
                                cursor == cues.size() ? "strong-wait" : cue_frontier(cues[cursor]));
                        }
                        const auto& effects = array(segment, "effects");
                        for (std::size_t cursor = 0; cursor <= effects.size(); ++cursor)
                            add(dialogue_point(id, block_id, "apply-segment-effects", segment_id,
                                               {}, cursor),
                                Json::array(),
                                cursor < effects.size() ? summary(Json::array({effects[cursor]}))
                                                        : Json::array());
                    } else {
                        Json commands = Json::array();
                        std::string frontier = "normal";
                        if (kind == "call-scene")
                            commands.push_back(
                                {{"kind", "call-scene"}, {"scene", segment.at("scene")}});
                        else if (kind == "run-lua") {
                            commands.push_back({{"kind", "opaque"}});
                            if (segment.value("mayYield", false))
                                frontier = "strong-wait";
                        } else if (kind == "handoff")
                            frontier = "strong-wait";
                        add(dialogue_point(id, block_id, "present-segment", segment_id),
                            Json::array(), std::move(commands), get(segment, "condition"),
                            frontier);
                    }
                }
            }
            for (const auto& edge : array(program, "edges")) {
                const auto block = str(edge, "fromBlockId");
                const auto edge_id = str(edge, "id");
                add(dialogue_point(id, block, "follow-edge", {}, edge_id));
                if (str(edge, "kind") == "choice") {
                    const auto& effects = array(edge, "effects");
                    for (std::size_t cursor = 0; cursor <= effects.size(); ++cursor)
                        add(dialogue_point(id, block, "apply-choice-effects", {}, edge_id, cursor),
                            Json::array(),
                            cursor < effects.size() ? summary(Json::array({effects[cursor]}))
                                                    : Json::array());
                }
            }
            add(point("dialogue-terminal", "dialogue", dialogue_ref));
        }

        for (const auto& room : array(definitions, "rooms")) {
            for (const auto& [stage, hook] :
                 std::array<std::pair<std::string_view, std::string_view>, 5>{
                     {{"before-leave", "beforeLeave"},
                      {"before-enter", "beforeEnter"},
                      {"presentation", ""},
                      {"after-leave", "afterLeave"},
                      {"after-enter", "afterEnter"}}}) {
                Json deps = Json::array();
                if (stage == "presentation")
                    deps.push_back({{"kind", "room"}, {"room", ref("room", str(room, "id"))}});
                Json commands =
                    hook.empty() ? Json::array() : summary(array(obj(room, "lifecycle"), hook));
                for (const auto& script_hook : array(room, "scriptHooks"))
                    if (!hook.empty() && str(script_hook, "hook") == stage) {
                        commands.push_back({{"kind", "opaque"}});
                        break;
                    }
                add({{"kind", "room-lifecycle"},
                     {"room", ref("room", str(room, "id"))},
                     {"stage", stage}},
                    std::move(deps), std::move(commands));
            }
        }
        for (const auto& interaction : array(definitions, "interactions"))
            for (const auto& rule : array(interaction, "rules"))
                add({{"kind", "interaction-rule"},
                     {"interaction", ref("interaction", str(interaction, "id"))},
                     {"ruleId", rule.at("id")}},
                    Json::array(), interaction_program(rule.at("program")), get(rule, "guard"));
        for (const auto& verb : array(definitions, "verbs"))
            add(point("verb-default", "verb", ref("verb", str(verb, "id"))), Json::array(),
                interaction_program(verb.at("defaultProgram")), get(verb, "availability"));
        if (truthy(get(wire, "undefinedInteractionProgram")))
            add({{"kind", "undefined-interaction"}}, Json::array(),
                interaction_program(wire.at("undefinedInteractionProgram")));
        std::set<std::string> resident_layout_ids;
        for (const auto* field : {"defaultVerbMenuLayout", "defaultLayout"}) {
            const auto& settings = obj(wire, "settings");
            const auto layout = field == std::string_view("defaultLayout")
                                    ? get(obj(settings, "inventory"), field)
                                    : get(obj(settings, "interaction"), field);
            if (truthy(layout))
                resident_layout_ids.insert(str(layout, "id"));
        }
        for (const auto& [_, hint] : hints.items())
            if (str(obj(hint, "attachment"), "kind") == "point" &&
                str(obj(obj(hint, "attachment"), "point"), "kind") == "resident-layout")
                resident_layout_ids.insert(
                    str(obj(obj(obj(hint, "attachment"), "point"), "layout").at("$ref"), "id"));
        for (const auto& id : resident_layout_ids) {
            const auto layout = ref("layout", id);
            add(point("resident-layout", "layout", layout),
                Json::array({{{"kind", "layout"}, {"layout", layout}}}));
        }
    }

    void connect()
    {
        const auto& definitions = obj(wire, "definitions");
        for (const auto& scene : array(definitions, "scenes")) {
            const auto scene_ref = ref("scene", str(scene, "id"));
            const auto terminal_point = point("scene-terminal", "scene", scene_ref);
            const Json terminal = find(terminal_point);
            const auto& events = array(obj(scene, "program"), "events");
            const auto step = [&](const Json& event) {
                return Json{
                    {"kind", "scene-step"}, {"scene", scene_ref}, {"stepId", event.at("id")}};
            };
            const Json first = events.empty() ? terminal : find(step(events.front()));
            control(find(point("scene-entry", "scene", scene_ref)), first);
            for (std::size_t i = 0; i < events.size(); ++i) {
                const auto& event = events[i];
                const auto& instruction = event.at("instruction");
                const auto target = step(event);
                const Json index = find(target);
                if (index.is_null() || slices[index.get<std::size_t>()].at("point") != target)
                    continue;
                Json next = terminal;
                for (std::size_t j = i + 1; j < events.size(); ++j) {
                    const Json candidate = find(step(events[j]));
                    if (!candidate.is_null() && candidate != index) {
                        next = candidate;
                        break;
                    }
                }
                const auto at = index.get<std::size_t>();
                slices[at]["conditionFalseSuccessor"] =
                    truthy(get(instruction, "condition")) ? next : Json(nullptr);
                const auto kind = str(instruction, "kind");
                if (kind == "conditional-branch") {
                    Json branches = Json::array();
                    for (const auto& branch : array(instruction, "branches")) {
                        const Json branch_target =
                            find({{"kind", "scene-step"},
                                  {"scene", scene_ref},
                                  {"stepId", branch.at("targetInstructionId")}});
                        if (!branch_target.is_null())
                            branches.push_back(
                                {{"condition", branch.at("condition")}, {"target", branch_target}});
                    }
                    const Json fallback =
                        find({{"kind", "scene-step"},
                              {"scene", scene_ref},
                              {"stepId", instruction.at("fallbackInstructionId")}});
                    if (!fallback.is_null())
                        slices[at]["control"] = {
                            {"kind", "branch"}, {"branches", branches}, {"fallback", fallback}};
                } else if (kind == "choice") {
                    Json options = Json::array();
                    for (const auto& option : array(instruction, "options")) {
                        const Json option_target =
                            find({{"kind", "scene-step"},
                                  {"scene", scene_ref},
                                  {"stepId", option.at("targetInstructionId")}});
                        if (option_target.is_null())
                            continue;
                        Json programs = Json::array();
                        for (const auto& effect : array(option, "effects"))
                            programs.push_back(summary(Json::array({effect})));
                        Json choice{{"optionId", option.at("id")},
                                    {"programs", programs},
                                    {"target", option_target}};
                        if (truthy(get(option, "condition")))
                            choice["condition"] = option.at("condition");
                        options.push_back(std::move(choice));
                    }
                    slices[at]["control"] = {{"kind", "choice"}, {"options", options}};
                } else {
                    control(index, next);
                }
            }
            if (!terminal.is_null()) {
                const auto& ending = obj(scene, "terminal");
                if (str(ending, "kind") == "continue-scene")
                    control(terminal, find(point("scene-entry", "scene", ending.at("scene"))));
                else if (str(ending, "kind") == "continue-dialogue")
                    control(terminal,
                            find(point("dialogue-entry", "dialogue", ending.at("dialogue"))));
            }
        }
        for (const auto& dialogue : array(definitions, "dialogues")) {
            const auto id = str(dialogue, "id");
            const auto dp = [&](const std::string& block, const std::string& stage,
                                std::string_view segment = {}, std::string_view edge = {},
                                std::size_t cursor = 0) {
                return find(dialogue_point(id, block, stage, segment, edge, cursor));
            };
            const Json terminal = find(point("dialogue-terminal", "dialogue", ref("dialogue", id)));
            const auto& program = obj(dialogue, "program");
            const auto& blocks = array(program, "blocks");
            const auto& edges = array(program, "edges");
            const auto entry = dp(str(program, "entryBlockId"), "enter-block");
            control(find(point("dialogue-entry", "dialogue", ref("dialogue", id))),
                    entry.is_null() ? terminal : entry);
            const auto next_after_sequence = [&](const Json& block, std::size_t next_index) {
                const auto& segments = array(block, "segments");
                const auto block_id = str(block, "id");
                if (next_index < segments.size())
                    return dp(block_id, "present-segment", str(segments[next_index], "id"));
                for (const auto& edge : edges)
                    if (str(edge, "kind") == "next" && str(edge, "fromBlockId") == block_id)
                        return dp(block_id, "follow-edge", {}, str(edge, "id"));
                return terminal;
            };
            for (const auto& block : blocks) {
                const auto block_id = str(block, "id");
                const auto block_entry = dp(block_id, "enter-block");
                if (block_entry.is_null())
                    continue;
                const auto kind = str(block, "kind");
                if (kind == "redirect") {
                    control(block_entry, dp(str(block, "targetBlockId"), "enter-block"));
                    continue;
                }
                if (kind == "choice") {
                    const auto choice = dp(block_id, "present-choices");
                    control(block_entry, choice);
                    if (!choice.is_null()) {
                        Json options = Json::array();
                        for (const auto& edge : edges) {
                            if (str(edge, "kind") != "choice" ||
                                str(edge, "fromBlockId") != block_id)
                                continue;
                            const auto target =
                                dp(block_id, "apply-choice-effects", {}, str(edge, "id"));
                            if (target.is_null())
                                continue;
                            Json item{{"optionId", edge.at("id")},
                                      {"programs", Json::array()},
                                      {"target", target}};
                            if (truthy(get(edge, "condition")))
                                item["condition"] = edge.at("condition");
                            options.push_back(std::move(item));
                        }
                        slices[choice.get<std::size_t>()]["control"] = {
                            {"kind", "choice"}, {"options", std::move(options)}};
                    }
                    continue;
                }
                const auto& segments = array(block, "segments");
                control(block_entry, next_after_sequence(block, 0));
                for (std::size_t i = 0; i < segments.size(); ++i) {
                    const auto& segment = segments[i];
                    const auto sid = str(segment, "id");
                    const Json next = next_after_sequence(block, i + 1);
                    if (str(segment, "kind") == "line") {
                        const auto& cues = array(segment, "cues");
                        const auto& effects = array(segment, "effects");
                        for (std::size_t cursor = 0; cursor <= cues.size(); ++cursor) {
                            const Json index = dp(block_id, "present-segment", sid, {}, cursor);
                            if (index.is_null())
                                continue;
                            slices[index.get<std::size_t>()]["conditionFalseSuccessor"] =
                                cursor == 0 ? next : Json(nullptr);
                            control(index,
                                    cursor < cues.size()
                                        ? dp(block_id, "present-segment", sid, {}, cursor + 1)
                                        : dp(block_id, "apply-segment-effects", sid));
                        }
                        for (std::size_t cursor = 0; cursor <= effects.size(); ++cursor)
                            control(dp(block_id, "apply-segment-effects", sid, {}, cursor),
                                    cursor < effects.size()
                                        ? dp(block_id, "apply-segment-effects", sid, {}, cursor + 1)
                                        : next);
                    } else {
                        const Json index = dp(block_id, "present-segment", sid);
                        if (!index.is_null())
                            slices[index.get<std::size_t>()]["conditionFalseSuccessor"] = next;
                        control(index, next);
                    }
                }
            }
            for (const auto& edge : edges) {
                const auto block_id = str(edge, "fromBlockId");
                const auto eid = str(edge, "id");
                if (str(edge, "kind") == "choice") {
                    const auto& effects = array(edge, "effects");
                    for (std::size_t cursor = 0; cursor <= effects.size(); ++cursor)
                        control(dp(block_id, "apply-choice-effects", {}, eid, cursor),
                                cursor < effects.size()
                                    ? dp(block_id, "apply-choice-effects", {}, eid, cursor + 1)
                                    : dp(block_id, "follow-edge", {}, eid));
                }
                const bool target_exists = contains_id(blocks, str(edge, "toBlockId"));
                control(dp(block_id, "follow-edge", {}, eid),
                        target_exists ? dp(str(edge, "toBlockId"), "enter-block") : Json(nullptr));
            }
            if (!terminal.is_null())
                slices[terminal.get<std::size_t>()]["program"] =
                    target_program(get(dialogue, "completion"));
        }
    }

    std::vector<std::size_t> room_entry_roots(const std::string& room) const
    {
        std::vector<std::size_t> result;
        for (const auto* stage : {"before-enter", "presentation", "after-enter"}) {
            const auto index =
                find({{"kind", "room-lifecycle"}, {"room", ref("room", room)}, {"stage", stage}});
            if (!index.is_null())
                result.push_back(index.get<std::size_t>());
        }
        return result;
    }
    std::vector<std::size_t> target_roots(const Json& target) const
    {
        const auto kind = str(target, "kind");
        if (kind == "room")
            return room_entry_roots(str(get(target, "room"), "id"));
        if (kind == "scene" || kind == "dialogue") {
            const auto index = find(
                point(kind == "scene" ? "scene-entry" : "dialogue-entry", kind, target.at(kind)));
            if (!index.is_null())
                return {index.get<std::size_t>()};
        }
        return {};
    }
    std::vector<std::size_t> entry_path_roots(const std::string& room) const
    {
        std::vector<std::size_t> result;
        for (const auto& [_, hint] : hints.items()) {
            const auto& attachment = obj(hint, "attachment");
            if (str(attachment, "kind") != "room" || str(attachment, "scope") != "entry-path" ||
                str(obj(attachment, "room").at("$ref"), "id") != room)
                continue;
            const auto roots = target_roots(hint_target(hint.at("target")));
            result.insert(result.end(), roots.begin(), roots.end());
        }
        return result;
    }
    std::vector<std::size_t> program_roots(const Json& program) const
    {
        std::vector<std::size_t> result;
        for (const auto& command : program) {
            const auto kind = str(command, "kind");
            if (kind == "call-scene" || kind == "start-detached-scene" || kind == "call-dialogue") {
                const auto& field = kind == "call-dialogue" ? "dialogue" : "scene";
                const auto target =
                    point(kind == "call-dialogue" ? "dialogue-entry" : "scene-entry", field,
                          command.at(field));
                const auto index = find(target);
                if (!index.is_null())
                    result.push_back(index.get<std::size_t>());
            } else if (kind == "enter-room") {
                const auto room = str(get(command, "room"), "id");
                auto roots = room_entry_roots(room);
                const auto hinted = entry_path_roots(room);
                roots.insert(roots.end(), hinted.begin(), hinted.end());
                result.insert(result.end(), roots.begin(), roots.end());
            } else if (kind == "if") {
                const auto truth = static_truth(command.at("condition"));
                if (truth != StaticTruth::No) {
                    const auto roots = program_roots(array(command, "thenCommands"));
                    result.insert(result.end(), roots.begin(), roots.end());
                }
                if (truth != StaticTruth::Yes) {
                    const auto roots = program_roots(array(command, "elseCommands"));
                    result.insert(result.end(), roots.begin(), roots.end());
                }
            }
        }
        return result;
    }
    std::vector<std::size_t> successors(const Json& slice) const
    {
        const auto& control = slice.at("control");
        const auto kind = str(control, "kind");
        if (kind == "sequential") {
            const auto value = get(control, "successor");
            return value.is_null() ? std::vector<std::size_t>{}
                                   : std::vector<std::size_t>{value.get<std::size_t>()};
        }
        std::vector<std::size_t> result;
        if (kind == "choice") {
            for (const auto& option : array(control, "options")) {
                if (truthy(get(option, "condition")) &&
                    static_truth(option.at("condition")) == StaticTruth::No)
                    continue;
                for (const auto& program : array(option, "programs")) {
                    const auto nested = program_roots(program);
                    result.insert(result.end(), nested.begin(), nested.end());
                }
                result.push_back(option.at("target").get<std::size_t>());
            }
        } else if (kind == "branch") {
            bool fallthrough = true;
            for (const auto& branch : array(control, "branches")) {
                const auto truth = static_truth(branch.at("condition"));
                if (truth == StaticTruth::No)
                    continue;
                result.push_back(branch.at("target").get<std::size_t>());
                if (truth == StaticTruth::Yes) {
                    fallthrough = false;
                    break;
                }
            }
            if (fallthrough)
                result.push_back(control.at("fallback").get<std::size_t>());
        }
        return result;
    }
    std::vector<std::size_t> expansion(const Json& target) const
    {
        auto roots = target_roots(target);
        if (str(target, "kind") == "room") {
            const auto extra = entry_path_roots(str(get(target, "room"), "id"));
            roots.insert(roots.end(), extra.begin(), extra.end());
        }
        std::deque<std::size_t> pending(roots.begin(), roots.end());
        std::set<std::size_t> traversed;
        std::vector<std::size_t> result;
        const auto enqueue = [&](const std::vector<std::size_t>& values) {
            pending.insert(pending.end(), values.begin(), values.end());
        };
        while (!pending.empty() && traversed.size() < 4096) {
            const auto index = pending.front();
            pending.pop_front();
            if (index >= slices.size() || !traversed.insert(index).second)
                continue;
            const auto& slice = slices.at(index);
            const auto truth = slice.contains("condition") ? static_truth(slice.at("condition"))
                                                           : StaticTruth::Yes;
            if (truth != StaticTruth::No) {
                result.push_back(index);
                for (const auto& [_, hint] : hints.items()) {
                    const auto& attachment = obj(hint, "attachment");
                    if (str(attachment, "kind") != "point")
                        continue;
                    const auto attached = find(hint_point(attachment.at("point")));
                    if (!attached.is_null() && attached == index)
                        enqueue(target_roots(hint_target(hint.at("target"))));
                }
                enqueue(program_roots(slice.at("program")));
                enqueue(successors(slice));
            }
            const auto fallback = get(slice, "conditionFalseSuccessor");
            if (!fallback.is_null() && truth != StaticTruth::Yes)
                pending.push_back(fallback.get<std::size_t>());
        }
        return result;
    }
    Json supplemental_hints() const
    {
        std::vector<Json> ordered;
        for (const auto& [_, hint] : hints.items())
            ordered.push_back(hint);
        std::sort(ordered.begin(), ordered.end(),
                  [](const Json& a, const Json& b) { return str(a, "id") < str(b, "id"); });
        Json result = Json::array();
        for (const auto& hint : ordered) {
            const auto& attachment = obj(hint, "attachment");
            const auto target = hint_target(hint.at("target"));
            Json resolved;
            if (str(attachment, "kind") == "point") {
                const auto slice = find(hint_point(attachment.at("point")));
                if (slice.is_null())
                    continue;
                resolved = {{"kind", "point"}, {"slice", slice}};
            } else {
                resolved = {{"kind", "room"},
                            {"room", ref("room", str(obj(attachment, "room").at("$ref"), "id"))},
                            {"scope", attachment.at("scope")}};
            }
            result.push_back({{"id", hint.at("id")},
                              {"target", target},
                              {"potentialExpansionSlices", expansion(target)},
                              {"attachment", std::move(resolved)}});
        }
        return result;
    }
};
} // namespace

std::optional<nlohmann::json> compile_native_flow_prediction(const nlohmann::json& wire,
                                                             const nlohmann::json& hints)
{
    const auto& definitions = obj(wire, "definitions");
    if (array(definitions, "scenes").empty() && array(definitions, "dialogues").empty() &&
        array(definitions, "rooms").empty())
        return std::nullopt;
    PredictionBuilder builder(wire, hints);
    builder.create_slices();
    builder.connect();
    Json supplemental = builder.supplemental_hints();
    return Json{{"dependencyGroups", std::move(builder.dependency_groups)},
                {"supplementalHints", std::move(supplemental)},
                {"slices", std::move(builder.slices)}};
}
} // namespace noveltea::cli
