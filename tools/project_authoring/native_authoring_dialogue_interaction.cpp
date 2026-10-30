#include "native_authoring_programs.hpp"

#include "native_authoring_messages.hpp"
#include "native_authoring_shared.hpp"

#include <algorithm>
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
    auto it = source.find(std::string(key));
    return it == source.end() ? Json(nullptr) : *it;
}

std::string str(const Json& source, std::string_view key)
{
    const auto value = optional(source, key);
    return value.is_string() ? value.get<std::string>() : "";
}

std::string escape(std::string_view source)
{
    std::string output;
    for (const auto c : source) {
        if (c == '~')
            output += "~0";
        else if (c == '/')
            output += "~1";
        else
            output += c;
    }
    return output;
}

Json reference(const Json& authored, std::string_view kind)
{
    if (authored.is_null())
        return nullptr;
    return {{"kind", kind}, {"id", object(authored, "$ref").at("id")}};
}

Json fields(const Json& source, std::initializer_list<std::string_view> names)
{
    Json result = Json::object();
    for (const auto name : names)
        if (source.contains(std::string(name)))
            result[std::string(name)] = source.at(std::string(name));
    return result;
}

Json flow_target(const Json& source)
{
    const auto kind = str(source, "kind");
    if (kind == "return" || kind == "end")
        return {{"kind", kind}};
    if (kind == "scene" || kind == "dialogue" || kind == "room")
        return {{"kind", kind}, {kind, Json{{"kind", kind}, {"id", source.at("id")}}}};
    throw std::runtime_error("Unsupported Flow target '" + kind + "'.");
}

Json commands(const Json& project, const NativeMessageProjection& messages, const Json& items,
              const std::string& path)
{
    Json result = Json::array();
    for (const auto& item : items) {
        const auto at = path + "/@" + escape(str(item, "id"));
        try {
            result.push_back(lower_gameplay_command(project, messages, item, at));
        } catch (const std::exception& error) {
            if (std::string_view(error.what()).starts_with("at /"))
                throw;
            throw std::runtime_error("at " + at + ": " + error.what());
        }
    }
    return result;
}

Json program(const Json& project, const NativeMessageProjection& messages, const Json& source,
             const std::string& path)
{
    return {{"instructions",
             commands(project, messages, array(source, "instructions"), path + "/instructions")},
            {"completion", flow_target(source.at("completion"))},
            {"outcome", source.at("outcome")}};
}

Json stage_state(const Json& source)
{
    Json result = fields(source, {"profileId", "poseId", "expressionId", "appearanceId", "position",
                                  "offset", "scale", "visible"});
    result["character"] = reference(source.at("character"), "character");
    return result;
}

Json media(const Json& source)
{
    const auto kind = str(source, "kind");
    if (kind == "image")
        return {{"kind", kind}, {"asset", reference(source.at("asset"), "asset")}};
    if (kind == "character") {
        Json result =
            fields(source, {"kind", "profileId", "poseId", "expressionId", "appearanceId"});
        result["character"] = reference(source.at("character"), "character");
        return result;
    }
    throw std::runtime_error("Unsupported Dialogue media kind '" + kind + "'.");
}

Json stage_mutation(const Json& source)
{
    Json result = fields(source, {"slotId", "action", "profileId", "poseId", "expressionId",
                                  "appearanceId", "position", "offset", "scale"});
    if (source.contains("character"))
        result["character"] = reference(source.at("character"), "character");
    return result;
}

Json semantic_cue(const Json& cue)
{
    const auto kind = str(cue, "kind");
    Json result = fields(cue, {"id", "kind", "position"});
    if (kind == "speaker-expression") {
        result["expressionId"] = cue.at("expressionId");
    } else if (kind == "stage") {
        result["mutation"] = stage_mutation(cue.at("mutation"));
    } else if (kind == "media") {
        const auto& mutation = cue.at("mutation");
        Json output = fields(mutation, {"slotId", "action"});
        if (mutation.contains("content"))
            output["content"] = media(mutation.at("content"));
        result["mutation"] = std::move(output);
    } else if (kind == "gesture") {
        result.update(fields(cue, {"slotId", "gestureId", "waitForCompletion", "skippable"}));
    } else if (kind == "voice" || kind == "sound-effect") {
        result.update(fields(cue, {"pausePolicy", "gain", "pan", "waitForCompletion",
                                   "skipBehavior", "causality", "synchronized"}));
        result["asset"] = reference(cue.at("asset"), "asset");
    } else if (kind == "camera") {
        result["emphasis"] = cue.at("emphasis");
    } else {
        throw std::runtime_error("Unsupported Dialogue semantic cue '" + kind + "'.");
    }
    return result;
}

Json sequence_segments(const Json& project, const NativeMessageProjection& messages,
                       const Json& block, const std::string& block_path)
{
    Json output = Json::array();
    for (const auto& segment : array(block, "segments")) {
        const auto kind = str(segment, "type");
        if (kind == "comment")
            continue;
        const auto path = block_path + "/segments/@" + escape(str(segment, "id"));
        try {
            Json result{{"id", segment.at("id")}};
            if (segment.contains("condition"))
                result["condition"] = lower_gameplay_condition(segment.at("condition"));
            if (kind == "run-lua") {
                result.update(fields(segment, {"source", "mayYield"}));
                result["kind"] = "run-lua";
            } else if (kind == "call-scene") {
                result["kind"] = "call-scene";
                result["scene"] = reference(segment.at("scene"), "scene");
                Json inputs = Json::array();
                for (const auto& binding : array(segment, "inputs"))
                    inputs.push_back(fields(binding, {"inputId", "value"}));
                result["inputs"] = std::move(inputs);
                result["uiPolicy"] = segment.at("uiPolicy");
            } else if (kind == "handoff") {
                result["kind"] = "handoff";
                if (segment.contains("payload"))
                    result["payload"] = segment.at("payload");
            } else if (kind == "line") {
                result["kind"] = "line";
                result["speaker"] = reference(optional(segment, "speaker"), "character");
                result["text"] =
                    lower_authoring_text(project, messages, segment.at("text"), path + "/text");
                Json cues = Json::array();
                for (const auto& cue : array(segment, "cues"))
                    if (str(cue, "kind") != "active-text" && str(cue, "kind") != "invalid-markup")
                        cues.push_back(semantic_cue(cue));
                // Authored cue array order is not runtime order. Preserve both
                // position dimensions, then sort by stable semantic cue ID.
                std::sort(cues.begin(), cues.end(), [](const Json& left, const Json& right) {
                    const auto& a = left.at("position");
                    const auto& b = right.at("position");
                    if (a.at("offset") != b.at("offset"))
                        return a.at("offset") < b.at("offset");
                    if (a.at("order") != b.at("order"))
                        return a.at("order") < b.at("order");
                    return left.at("id").get<std::string>() < right.at("id").get<std::string>();
                });
                result["cues"] = std::move(cues);
                result["effects"] =
                    commands(project, messages, array(segment, "effects"), path + "/effects");
                result.update(fields(segment, {"showOnce", "logged", "autosaveSafePoint"}));
            } else {
                throw std::runtime_error("Unsupported Dialogue segment '" + kind + "'.");
            }
            output.push_back(std::move(result));
        } catch (const std::exception& error) {
            if (std::string_view(error.what()).starts_with("at /"))
                throw;
            throw std::runtime_error("at " + path + ": " + error.what());
        }
    }
    return output;
}

void dialogue(const Json& project, const NativeMessageProjection& messages, const Json& data,
              Json& target, const std::string& path)
{
    Json blocks = Json::array();
    for (const auto& block : array(data, "blocks")) {
        const auto kind = str(block, "type");
        if (kind == "comment")
            continue;
        Json item{{"id", block.at("id")}};
        if (kind == "choice") {
            item["kind"] = "choice";
        } else if (kind == "redirect") {
            item["kind"] = "redirect";
            item["targetBlockId"] = block.at("targetBlockId");
        } else if (kind == "sequence") {
            item["kind"] = "sequence";
            item["defaultSpeaker"] = reference(optional(block, "defaultSpeaker"), "character");
            item["segments"] = sequence_segments(project, messages, block,
                                                 path + "/blocks/@" + escape(str(block, "id")));
        } else {
            throw std::runtime_error("at " + path + "/blocks/@" + escape(str(block, "id")) +
                                     ": Unsupported Dialogue block '" + kind + "'.");
        }
        blocks.push_back(std::move(item));
    }
    Json edges = Json::array();
    for (const auto& edge : array(data, "edges")) {
        const auto kind = str(edge, "kind");
        Json result = fields(edge, {"id", "kind", "fromBlockId", "toBlockId"});
        if (kind == "choice") {
            const auto at = path + "/edges/@" + escape(str(edge, "id"));
            result["label"] =
                lower_authoring_text(project, messages, edge.at("label"), at + "/label");
            if (edge.contains("condition"))
                result["condition"] = lower_gameplay_condition(edge.at("condition"));
            result["effects"] =
                commands(project, messages, array(edge, "effects"), at + "/effects");
            result.update(fields(edge, {"logged", "autosaveSafePoint"}));
        } else if (kind != "next") {
            throw std::runtime_error("Unsupported Dialogue edge '" + kind + "'.");
        }
        edges.push_back(std::move(result));
    }
    Json stage = Json::array();
    for (const auto& slot : array(data, "stageSlots"))
        stage.push_back(
            {{"id", slot.at("id")},
             {"speakerSync", slot.at("speakerSync")},
             {"initial", optional(slot, "initial").is_null() ? Json(nullptr)
                                                             : stage_state(slot.at("initial"))}});
    Json media_slots = Json::array();
    for (const auto& slot : array(data, "mediaSlots"))
        media_slots.push_back(
            {{"id", slot.at("id")},
             {"visible", slot.at("visible")},
             {"initial",
              optional(slot, "initial").is_null() ? Json(nullptr) : media(slot.at("initial"))}});
    target["stageSlots"] = std::move(stage);
    target["mediaSlots"] = std::move(media_slots);
    target["program"] = {{"entryBlockId", data.at("entryBlockId")},
                         {"blocks", std::move(blocks)},
                         {"edges", std::move(edges)}};
    target["completion"] = flow_target(data.at("completion"));
}

} // namespace

Json lower_dialogue_interaction_programs(const Json& project,
                                         const NativeMessageProjection& messages, Json draft)
{
    const Json& authored = messages.lowered_project;
    for (auto& target : draft["definitions"]["dialogues"]) {
        const auto id = str(target, "id");
        const auto path = "/dialogues/" + escape(id) + "/data";
        const auto& data = object(object(authored.at("dialogues"), id), "data");
        if (data.empty())
            throw std::runtime_error("at " + path + ": Validated Dialogue data is missing.");
        try {
            dialogue(project, messages, data, target, path);
        } catch (const std::exception& error) {
            if (std::string_view(error.what()).starts_with("at /"))
                throw;
            throw std::runtime_error("at " + path + ": " + error.what());
        }
    }
    for (auto& verb : draft["definitions"]["verbs"]) {
        const auto id = str(verb, "id");
        const auto path = "/verbs/" + escape(id) + "/data";
        const auto& data = object(object(authored.at("verbs"), id), "data");
        if (data.empty())
            throw std::runtime_error("at " + path + ": Validated Verb data is missing.");
        const auto& offers = array(data, "offers");
        for (std::size_t i = 0; i < verb["offers"].size(); ++i)
            if (i < offers.size() && offers[i].contains("condition"))
                verb["offers"][i]["condition"] =
                    lower_gameplay_condition(offers[i].at("condition"));
        verb["availability"] = lower_gameplay_condition(data.at("availability"));
        verb["defaultProgram"] =
            program(project, messages, data.at("defaultProgram"), path + "/defaultProgram");
    }
    for (auto& target : draft["definitions"]["interactions"]) {
        const auto id = str(target, "id");
        const auto path = "/interactions/" + escape(id) + "/data";
        const auto& data = object(object(authored.at("interactions"), id), "data");
        if (data.empty())
            throw std::runtime_error("at " + path + ": Validated Interaction data is missing.");
        Json rules = Json::array();
        for (const auto& rule : array(data, "rules")) {
            const auto at = path + "/rules/@" + escape(str(rule, "id"));
            Json slots = Json::array();
            for (const auto& slot : array(rule, "slots")) {
                Json selectors = Json::array();
                for (const auto& source : array(slot, "selectors"))
                    selectors.push_back(lower_subject_selector(source));
                slots.push_back(
                    {{"slotId", slot.at("slotId")}, {"selectors", std::move(selectors)}});
            }
            Json offer = nullptr;
            if (!optional(rule, "offer").is_null()) {
                const auto& authored_offer = rule.at("offer");
                offer = fields(authored_offer, {"slotId", "rank", "primary"});
                if (authored_offer.contains("condition"))
                    offer["condition"] = lower_gameplay_condition(authored_offer.at("condition"));
            }
            rules.push_back(
                {{"id", rule.at("id")},
                 {"verb", reference(rule.at("verb"), "verb")},
                 {"slots", std::move(slots)},
                 {"offer", std::move(offer)},
                 {"guard", lower_gameplay_condition(rule.at("guard"))},
                 {"priority", rule.at("priority")},
                 {"program", program(project, messages, rule.at("program"), at + "/program")}});
        }
        target["rules"] = std::move(rules);
    }
    if (!optional(authored, "undefinedInteractionProgram").is_null())
        draft["undefinedInteractionProgram"] =
            program(project, messages, authored.at("undefinedInteractionProgram"),
                    "/undefinedInteractionProgram");
    return draft;
}
} // namespace noveltea::cli
