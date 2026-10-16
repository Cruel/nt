#include "dialogue_scene_semantics.hpp"

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

void issue(ValidationResult& result, std::string path, std::string code, std::string message,
           std::string severity = "error")
{
    if (severity == "error")
        result.accepted = false;
    result.diagnostics.push_back(
        {std::move(path), std::move(code), std::move(message), std::move(severity)});
}

std::map<std::string, const Json*> index(const Json* values)
{
    std::map<std::string, const Json*> result;
    if (values && values->is_array())
        for (const auto& entry : values->array_range())
            result.emplace(str(&entry, "id"), &entry);
    return result;
}

void unique(ValidationResult& result, const Json* values, const std::string& base,
            const std::string& type)
{
    if (!values || !values->is_array())
        return;
    std::set<std::string> seen;
    for (std::size_t i = 0; i < values->size(); ++i) {
        const auto name = str(&values->at(i), "id");
        if (!seen.insert(name).second)
            issue(result, base + "/" + std::to_string(i) + "/id", "flow.duplicate-id",
                  "Duplicate " + type + " ID '" + name + "'.");
    }
}

void dialogue_local(ValidationResult& result, const Json& data)
{
    const auto* blocks = field(&data, "blocks");
    const auto* edges = field(&data, "edges");
    unique(result, field(&data, "stageSlots"), "/data/stageSlots", "stage slot");
    unique(result, field(&data, "mediaSlots"), "/data/mediaSlots", "media slot");
    unique(result, blocks, "/data/blocks", "block");
    unique(result, edges, "/data/edges", "edge");
    const auto block_by_id = index(blocks);
    const auto entry_id = str(&data, "entryBlockId");
    const auto entry = block_by_id.find(entry_id);
    if (entry == block_by_id.end())
        issue(result, "/data/entryBlockId", "dialogue.entry.missing",
              "Missing entry block '" + entry_id + "'.");
    else if (str(entry->second, "type") == "comment")
        issue(result, "/data/entryBlockId", "dialogue.entry.comment",
              "A Comment block cannot be the entry block.");

    std::set<std::string> segments;
    std::set<std::string> cue_ids;
    std::map<std::string, std::vector<const Json*>> outgoing;
    if (edges && edges->is_array())
        for (std::size_t i = 0; i < edges->size(); ++i) {
            const auto& edge = edges->at(i);
            const auto base = "/data/edges/" + std::to_string(i);
            const auto from = str(&edge, "fromBlockId");
            const auto to = str(&edge, "toBlockId");
            outgoing[from].push_back(&edge);
            const auto source = block_by_id.find(from);
            const auto target = block_by_id.find(to);
            if (source == block_by_id.end())
                issue(result, base + "/fromBlockId", "dialogue.edge.source-missing",
                      "Missing source block '" + from + "'.");
            if (target == block_by_id.end())
                issue(result, base + "/toBlockId", "dialogue.edge.target-missing",
                      "Missing target block '" + to + "'.");
            else if (str(target->second, "type") == "comment")
                issue(result, base + "/toBlockId", "dialogue.edge.comment-target",
                      "An edge cannot target a Comment block.");
            const auto source_type = source == block_by_id.end() ? "" : str(source->second, "type");
            const auto kind = str(&edge, "kind");
            if (source_type == "sequence" && kind != "next")
                issue(result, base + "/kind", "dialogue.edge.sequence-kind",
                      "Sequence blocks only emit Next edges.");
            else if (source_type == "choice" && kind != "choice")
                issue(result, base + "/kind", "dialogue.edge.choice-kind",
                      "Choice blocks only emit Choice edges.");
            else if (source_type == "redirect" || source_type == "comment")
                issue(result, base + "/fromBlockId", "dialogue.edge.forbidden-source",
                      "Redirect and Comment blocks cannot emit edges.");
        }

    if (!blocks || !blocks->is_array())
        return;
    for (std::size_t i = 0; i < blocks->size(); ++i) {
        const auto& block = blocks->at(i);
        const auto base = "/data/blocks/" + std::to_string(i);
        const auto kind = str(&block, "type");
        const auto id = str(&block, "id");
        const auto& from = outgoing[id];
        if (kind == "sequence") {
            if (from.size() > 1)
                issue(result, base, "dialogue.sequence.outgoing",
                      "Sequence blocks admit at most one Next edge.");
            const auto* children = field(&block, "segments");
            if (children && children->is_array())
                for (std::size_t j = 0; j < children->size(); ++j) {
                    const auto& segment = children->at(j);
                    const auto path = base + "/segments/" + std::to_string(j);
                    if (!segments.insert(str(&segment, "id")).second)
                        issue(result, path + "/id", "dialogue.segment.duplicate",
                              "Dialogue segment IDs must be unique across blocks.");
                    if (str(&segment, "type") != "line")
                        continue;
                    const auto* cues = field(&segment, "cues");
                    std::set<std::string> positions;
                    if (!cues || !cues->is_array())
                        continue;
                    const auto* source = field(field(&segment, "text"), "source");
                    const bool inline_text = str(source, "kind") == "inline";
                    // Dialogue cue offsets count Unicode code points, not UTF-8 bytes.
                    std::size_t length = 0;
                    for (const unsigned char ch : str(source, "text"))
                        if ((ch & 0xc0) != 0x80)
                            ++length;
                    for (std::size_t k = 0; k < cues->size(); ++k) {
                        const auto& cue = cues->at(k);
                        const auto cue_path = path + "/cues/" + std::to_string(k);
                        if (!cue_ids.insert(str(&cue, "id")).second)
                            issue(result, cue_path + "/id", "dialogue.cue.duplicate",
                                  "Dialogue cue ID must be unique across the graph.");
                        if (!inline_text)
                            issue(result, cue_path, "dialogue.cue.inline-required",
                                  "Positioned cues require an inline text source.");
                        const auto* position = field(&cue, "position");
                        if (!position)
                            continue;
                        const auto offset = position->at("offset").as<std::uint64_t>();
                        const auto order = position->at("order").as<std::uint64_t>();
                        if (inline_text && offset > length)
                            issue(result, cue_path + "/position/offset",
                                  "dialogue.cue.out-of-range", "Cue offset exceeds line length.");
                        if (!positions.insert(std::to_string(offset) + ":" + std::to_string(order))
                                 .second)
                            issue(result, cue_path + "/position/order",
                                  "dialogue.cue.position-duplicate",
                                  "Two cues occupy the same offset and order.");
                    }
                }
        } else if (kind == "choice" && from.empty()) {
            issue(result, base, "dialogue.choice.no-edges", "Choice blocks require Choice edges.");
        } else if (kind == "redirect") {
            const auto target_id = str(&block, "targetBlockId");
            const auto target = block_by_id.find(target_id);
            if (target == block_by_id.end())
                issue(result, base + "/targetBlockId", "dialogue.redirect.target-missing",
                      "Missing redirect target '" + target_id + "'.");
            else if (str(target->second, "type") == "comment")
                issue(result, base + "/targetBlockId", "dialogue.redirect.comment-target",
                      "Redirect cannot target a Comment block.");
            std::set<std::string> visited{id};
            auto following = target_id;
            while (block_by_id.contains(following) &&
                   str(block_by_id.at(following), "type") == "redirect") {
                if (!visited.insert(following).second) {
                    issue(result, "/data/blocks", "dialogue.redirect.cycle",
                          "Redirect-only cycle detected.");
                    break;
                }
                following = str(block_by_id.at(following), "targetBlockId");
            }
        }
    }
    if (entry != block_by_id.end()) {
        std::set<std::string> reached;
        std::vector<std::string> pending{entry_id};
        while (!pending.empty()) {
            auto id = std::move(pending.back());
            pending.pop_back();
            if (!reached.insert(id).second || !block_by_id.contains(id))
                continue;
            const auto* block = block_by_id.at(id);
            if (str(block, "type") == "redirect")
                pending.push_back(str(block, "targetBlockId"));
            for (const auto* edge : outgoing[id])
                pending.push_back(str(edge, "toBlockId"));
        }
        for (std::size_t i = 0; i < blocks->size(); ++i) {
            const auto& block = blocks->at(i);
            if (str(&block, "type") != "comment" && !reached.contains(str(&block, "id")))
                issue(result, "/data/blocks/" + std::to_string(i), "dialogue.block.unreachable",
                      "Block is unreachable from entry.", "warning");
        }
    }
}

bool accepts(const Json& input, const Json& value)
{
    if (value.is_null())
        return input.at("nullable") == true;
    const auto type = str(&input, "type");
    if (type == "boolean")
        return value.is_bool();
    if (type == "string")
        return value.is_string();
    if (type == "integer")
        return value.is_number() && std::isfinite(value.as<double>()) &&
               std::trunc(value.as<double>()) == value.as<double>();
    return value.is_number();
}

void scene_commands(ValidationResult& result, const Json* commands, const std::string& base,
                    bool choice, bool top_level, std::set<std::string>& seen)
{
    if (!commands || !commands->is_array())
        return;
    for (std::size_t i = 0; i < commands->size(); ++i) {
        const auto& command = commands->at(i);
        const auto path = base + "/" + std::to_string(i);
        const auto id = str(&command, "id");
        const auto kind = str(&command, "kind");
        if (!seen.insert(id).second)
            issue(result, path + "/id", "scene.command.duplicate-id",
                  "Gameplay Command ID must be unique within a Scene effect program.");
        static const std::set<std::string> forbidden{"call-scene",        "call-dialogue",
                                                     "present-inventory", "navigate-exit",
                                                     "change-room",       "notify"};
        if (forbidden.contains(kind) || (kind == "run-lua" && (!choice || !top_level)))
            issue(result, path + "/kind", "scene.command.forbidden",
                  "Gameplay Command is not admitted in this Scene mutation context.");
        if (choice && field(&command, "result") &&
            (kind == "create-room" || kind == "create-character" || kind == "create-interactable" ||
             kind == "split-quantity" ||
             (kind == "transfer-quantity" && str(&command, "mode") == "exact")))
            issue(result, path + "/result", "scene.command.choice-result",
                  "Scene Choice effects cannot bind command results across a yielding choice.");
        if (kind == "if") {
            scene_commands(result, field(&command, "then"), path + "/then", choice, false, seen);
            scene_commands(result, field(&command, "else"), path + "/else", choice, false, seen);
        }
    }
}

void scene_local(ValidationResult& result, const Json& data)
{
    const auto* inputs = field(&data, "inputs");
    const auto* outcomes = field(&data, "outcomes");
    const auto* events = field(&data, "events");
    unique(result, inputs, "/data/inputs", "Scene input");
    unique(result, outcomes, "/data/outcomes", "Scene Outcome");
    unique(result, events, "/data/events", "Scene Event");
    const auto event_ids = index(events);
    if (inputs && inputs->is_array())
        for (std::size_t i = 0; i < inputs->size(); ++i) {
            const auto& input = inputs->at(i);
            if (const auto* fallback = field(&input, "defaultValue");
                fallback && !accepts(input, *fallback))
                issue(result, "/data/inputs/" + std::to_string(i) + "/defaultValue",
                      "scene.input.default-type", "Default value does not match Scene input type.");
        }
    if (events && events->is_array()) {
        std::set<std::string> earlier;
        for (std::size_t i = 0; i < events->size(); ++i) {
            const auto& event = events->at(i);
            const auto base = "/data/events/" + std::to_string(i);
            const auto kind = str(&event, "type");
            if (kind == "comment")
                continue;
            const auto* deps = field(&event, "completionDependencies");
            if (deps && deps->is_array())
                for (std::size_t j = 0; j < deps->size(); ++j) {
                    const auto target = deps->at(j).as<std::string>();
                    if (!earlier.contains(target))
                        issue(result, base + "/completionDependencies/" + std::to_string(j),
                              "scene.dependency.not-earlier",
                              "Completion dependency must refer to an earlier enabled Event.");
                }
            if (kind == "wait" &&
                (str(&event, "waitKind") == "audio" || str(&event, "waitKind") == "operation")) {
                const auto id = str(&event, "eventId");
                const auto target = event_ids.find(id);
                if (!earlier.contains(id))
                    issue(result, base + "/eventId", "scene.wait.not-earlier",
                          "Wait must target an earlier Event.");
                else if (target != event_ids.end()) {
                    const auto target_kind = str(target->second, "type");
                    const auto wait_kind = str(&event, "waitKind");
                    const bool valid =
                        wait_kind == "audio"
                            ? target_kind == "audio-cue"
                            : (target_kind == "set-background" || target_kind == "actor-cue" ||
                               target_kind == "set-layout" || target_kind == "material-parameter" ||
                               target_kind == "transition-group");
                    if (!valid)
                        issue(result, base + "/eventId", "scene.wait.wrong-type",
                              "Wait targets an Event with an incompatible kind.");
                }
            }
            if (kind == "gameplay-effect-batch") {
                std::set<std::string> command_ids;
                scene_commands(result, field(&event, "operations"), base + "/operations", false,
                               true, command_ids);
            }
            if (kind == "conditional-branch" || kind == "choice") {
                const auto* arms = field(&event, kind == "choice" ? "options" : "branches");
                const auto name = kind == "choice" ? "options" : "branches";
                unique(result, arms, base + "/" + name, "branch");
                if (arms && arms->is_array())
                    for (std::size_t j = 0; j < arms->size(); ++j) {
                        if (kind == "choice") {
                            std::set<std::string> command_ids;
                            scene_commands(result, field(&arms->at(j), "effects"),
                                           base + "/options/" + std::to_string(j) + "/effects",
                                           true, true, command_ids);
                        }
                        const auto target = str(&arms->at(j), "targetStepId");
                        if (!event_ids.contains(target))
                            issue(result,
                                  base + "/" + name + "/" + std::to_string(j) + "/targetStepId",
                                  "scene.branch.target-missing",
                                  "Branch target Event does not exist.");
                    }
                if (kind == "conditional-branch" &&
                    !event_ids.contains(str(&event, "fallbackStepId")))
                    issue(result, base + "/fallbackStepId", "scene.branch.fallback-missing",
                          "Fallback Event does not exist.");
            }
            if (field(&event, "enabled") && event.at("enabled") == true)
                earlier.insert(str(&event, "id"));
        }
    }
    const auto* terminal = field(&data, "terminal");
    if (str(terminal, "kind") == "return" && field(terminal, "outcome") &&
        !terminal->at("outcome").is_null() && !index(outcomes).contains(str(terminal, "outcome")))
        issue(result, "/data/terminal/outcome", "scene.outcome.missing",
              "Return Outcome is not declared by this Scene.");
}

} // namespace

ValidationResult validate_dialogue_scene_local(std::string_view family,
                                               std::string_view normalized_record)
{
    ValidationResult result{true};
    try {
        const Json record = Json::parse(normalized_record);
        const auto* data = field(&record, "data");
        if (!data)
            return result;
        if (family == "dialogues")
            dialogue_local(result, *data);
        else if (family == "scenes")
            scene_local(result, *data);
    } catch (const std::exception& e) {
        issue(result, "/data", "flow.validation-failure", e.what());
    }
    return result;
}

ValidationResult validate_dialogue_scene_entrypoint(std::string_view family,
                                                    std::string_view normalized_record,
                                                    std::string_view manifest_json)
{
    ValidationResult result{true};
    try {
        const Json manifest = Json::parse(manifest_json);
        const Json record = Json::parse(normalized_record);
        const auto* entrypoint = field(&manifest, "entrypoint");
        const auto selected = family == "scenes" ? "scene" : "dialogue";
        if (str(entrypoint, "kind") != selected || str(entrypoint, "id") != str(&record, "id"))
            return result;
        const auto& data = record.at("data");
        if (family == "dialogues") {
            if (str(field(&data, "completion"), "kind") == "return")
                issue(result, "/data/completion", "dialogue.entrypoint.return",
                      "A direct Dialogue entrypoint cannot complete with Return.");
        } else {
            const auto terminal = str(field(&data, "terminal"), "kind");
            if (terminal == "return" || terminal == "release-to-exploration")
                issue(result, "/data/terminal", "scene.entrypoint.invalid-terminal",
                      "An entrypoint Scene cannot Return or release before a Current Room exists.");
            const auto* inputs = field(&data, "inputs");
            if (inputs && inputs->is_array())
                for (std::size_t i = 0; i < inputs->size(); ++i) {
                    const auto& input = inputs->at(i);
                    if (input.at("nullable") == false && !field(&input, "defaultValue"))
                        issue(result, "/data/inputs/" + std::to_string(i),
                              "scene.entrypoint.required-input",
                              "Entrypoint Scene input needs a default value or nullable type.");
                }
        }
    } catch (const std::exception& e) {
        issue(result, "/data", "flow.entrypoint-failure", e.what());
    }
    return result;
}

ValidationResult validate_dialogue_scene_dependencies(
    std::string_view family, std::string_view normalized_record,
    const AuthoringRecordResolver& resolve,
    const std::function<bool(std::string_view, std::string_view)>& exists)
{
    ValidationResult result{true};
    try {
        const Json record = Json::parse(normalized_record);
        const auto* data = field(&record, "data");
        if (!data)
            return result;
        const auto visit = [&](auto&& self, const Json& value, const std::string& path) -> void {
            if (value.is_array()) {
                for (std::size_t i = 0; i < value.size(); ++i)
                    self(self, value.at(i), path + "/" + std::to_string(i));
            } else if (value.is_object()) {
                if (const auto* ref_obj = field(&value, "$ref")) {
                    const auto collection = str(ref_obj, "collection");
                    const auto registry = str(ref_obj, "registry");
                    const auto id = str(ref_obj, "id");
                    const auto target = collection.empty() ? registry : collection;
                    if (!target.empty() && !exists(target, id))
                        issue(result, path, "reference.missing",
                              "Missing " + target + " record '" + id + "'.");
                }
                for (const auto& field : value.object_range()) {
                    std::string key = field.key();
                    std::string escaped;
                    for (char c : key) {
                        if (c == '~')
                            escaped += "~0";
                        else if (c == '/')
                            escaped += "~1";
                        else
                            escaped += c;
                    }
                    if (key != "$ref")
                        self(self, field.value(), path + "/" + escaped);
                }
            }
        };
        visit(visit, *data, "/data");

        if (family == "dialogues") {
            // Flow completion uses a compact target ID rather than a $ref;
            // it therefore needs an explicit Project inventory lookup.
            const auto* completion = field(data, "completion");
            const auto kind = str(completion, "kind");
            const auto id = str(completion, "id");
            const auto target = kind == "scene"      ? "scenes"
                                : kind == "dialogue" ? "dialogues"
                                : kind == "room"     ? "rooms"
                                                     : "";
            if (*target && !exists(target, id))
                issue(result, "/data/completion/id", "reference.missing",
                      "Flow completion targets a missing " + std::string(target) + " record '" +
                          id + "'.");
        }

        const auto validate_bindings = [&](const Json& call, const std::string& path) {
            const auto target_id = ref(field(&call, "scene"));
            const auto source = resolve("scenes", target_id);
            if (!source)
                return; // Invalid dependency is diagnosed at its own physical source.
            const auto target = Json::parse(*source);
            const auto inputs = index(field(field(&target, "data"), "inputs"));
            const auto* bindings = field(&call, "inputs");
            std::set<std::string> seen;
            if (bindings && bindings->is_array())
                for (std::size_t j = 0; j < bindings->size(); ++j) {
                    const auto& binding = bindings->at(j);
                    const auto id = str(&binding, "inputId");
                    const auto base = path + "/inputs/" + std::to_string(j);
                    if (!seen.insert(id).second)
                        issue(result, base + "/inputId", "scene.input.duplicate-binding",
                              "Scene '" + target_id + "' input is bound more than once.");
                    if (!inputs.contains(id))
                        issue(result, base + "/inputId", "scene.input.undeclared",
                              "Scene '" + target_id + "' has no input '" + id + "'.");
                    else if (!accepts(*inputs.at(id), binding.at("value")))
                        issue(result, base + "/value", "scene.input.type-mismatch",
                              "Scene '" + target_id + "' input value has an incompatible type.");
                }
            for (const auto& [id, input] : inputs)
                if (input->at("nullable") == false && !field(input, "defaultValue") &&
                    !seen.contains(id))
                    issue(result, path + "/inputs", "scene.input.required",
                          "Missing required Scene '" + target_id + "' input '" + id + "'.");
        };
        if (family == "dialogues") {
            const auto* blocks = field(data, "blocks");
            if (blocks && blocks->is_array())
                for (std::size_t i = 0; i < blocks->size(); ++i) {
                    const auto* segments = field(&blocks->at(i), "segments");
                    if (!segments || !segments->is_array())
                        continue;
                    for (std::size_t j = 0; j < segments->size(); ++j) {
                        const auto& segment = segments->at(j);
                        if (str(&segment, "type") == "call-scene")
                            validate_bindings(segment, "/data/blocks/" + std::to_string(i) +
                                                           "/segments/" + std::to_string(j));
                    }
                }
        } else if (family == "scenes") {
            const auto* events = field(data, "events");
            const auto this_id = str(&record, "id");
            std::map<std::string, Json> referenced_scenes;
            const auto scene = [&](const std::string& id) -> const Json* {
                if (id == this_id)
                    return &record;
                if (const auto found = referenced_scenes.find(id); found != referenced_scenes.end())
                    return &found->second;
                const auto source = resolve("scenes", id);
                if (!source)
                    return nullptr;
                return &referenced_scenes.emplace(id, Json::parse(*source)).first->second;
            };
            const auto detached_safe = [&](auto&& self, const std::string& id,
                                           std::set<std::string>& visiting) -> bool {
                const auto* candidate = scene(id);
                if (!candidate)
                    return false;
                if (!visiting.insert(id).second)
                    return true;
                const auto* candidate_data = field(candidate, "data");
                const auto* candidate_events = field(candidate_data, "events");
                bool safe = true;
                if (candidate_events && candidate_events->is_array())
                    for (const auto& step : candidate_events->array_range()) {
                        const auto type = str(&step, "type");
                        if (type == "choice" || type == "call-dialogue" ||
                            type == "call-interaction" || type == "directed-room-change" ||
                            type == "navigation-attempt" ||
                            (type == "show-text" && str(&step, "wait") == "input") ||
                            (type == "run-lua" && field(&step, "mayYield") &&
                             step.at("mayYield") == true) ||
                            (type == "wait" && (str(&step, "waitKind") == "input" ||
                                                str(&step, "waitKind") == "operation" ||
                                                str(&step, "waitKind") == "audio" ||
                                                str(&step, "waitKind") == "layout-signal"))) {
                            safe = false;
                            break;
                        }
                        static const std::set<std::string> presentation{
                            "set-background",     "actor-cue",        "set-layout",
                            "material-parameter", "transition-group", "audio-cue"};
                        if (presentation.contains(type) && field(&step, "waitForCompletion") &&
                            step.at("waitForCompletion") == true) {
                            safe = false;
                            break;
                        }
                        if ((type == "call-scene" || type == "start-detached-scene") &&
                            !self(self, ref(field(&step, "scene")), visiting)) {
                            safe = false;
                            break;
                        }
                    }
                const auto* terminal = field(candidate_data, "terminal");
                const auto kind = str(terminal, "kind");
                if (safe)
                    safe =
                        kind == "return" || (kind == "continue-scene" &&
                                             self(self, ref(field(terminal, "scene")), visiting));
                visiting.erase(id);
                return safe;
            };
            if (events && events->is_array())
                for (std::size_t i = 0; i < events->size(); ++i) {
                    const auto& event = events->at(i);
                    if (str(&event, "type") == "call-scene" ||
                        str(&event, "type") == "start-detached-scene")
                        validate_bindings(event, "/data/events/" + std::to_string(i));
                    if (str(&event, "type") == "start-detached-scene") {
                        std::set<std::string> visiting;
                        const auto target_id = ref(field(&event, "scene"));
                        if (!detached_safe(detached_safe, target_id, visiting))
                            issue(result, "/data/events/" + std::to_string(i) + "/scene",
                                  "scene.detached.unsafe",
                                  "Detached Scene '" + target_id +
                                      "' contains foreground-only or exclusive player-input work.");
                    }
                }
            const auto* terminal = field(data, "terminal");
            if (str(terminal, "kind") == "continue-scene")
                validate_bindings(*terminal, "/data/terminal");
            std::set<std::string> visiting;
            std::set<std::string> visited;
            const auto cyclic = [&](auto&& self, const std::string& id) -> bool {
                if (visiting.contains(id))
                    return true;
                if (visited.contains(id))
                    return false;
                const auto* candidate = scene(id);
                if (!candidate)
                    return false;
                visiting.insert(id);
                const auto* candidate_data = field(candidate, "data");
                const auto* candidate_events = field(candidate_data, "events");
                bool dynamic = false;
                if (candidate_events && candidate_events->is_array())
                    for (const auto& step : candidate_events->array_range())
                        dynamic |= str(&step, "type") == "choice" ||
                                   str(&step, "type") == "conditional-branch";
                if (!dynamic && candidate_events && candidate_events->is_array())
                    for (const auto& step : candidate_events->array_range())
                        if (str(&step, "type") == "call-scene" && field(&step, "enabled") &&
                            step.at("enabled") == true && !field(&step, "condition") &&
                            self(self, ref(field(&step, "scene"))))
                            return true;
                const auto* candidate_terminal = field(candidate_data, "terminal");
                if (str(candidate_terminal, "kind") == "continue-scene" &&
                    self(self, ref(field(candidate_terminal, "scene"))))
                    return true;
                visiting.erase(id);
                visited.insert(id);
                return false;
            };
            if (cyclic(cyclic, this_id))
                issue(result, "/data/terminal", "scene.unconditional-cycle",
                      "Scene participates in a statically unconditional call/continue cycle.");
        }
    } catch (const std::exception& e) {
        issue(result, "/data", "flow.reference-failure", e.what());
    }
    return result;
}

} // namespace noveltea::authoring
