#include "native_cli_test_catalog.hpp"

#include <algorithm>
#include <cstdint>
#include <cmath>
#include <limits>
#include <optional>
#include <regex>
#include <string>
#include <string_view>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

std::string field(const Json& value, const char* key)
{
    return value.is_object() && value.contains(key) && value.at(key).is_string()
               ? value.at(key).get<std::string>()
               : std::string{};
}

const Json& object(const Json& value, const char* key)
{
    static const Json empty = Json::object();
    if (value.is_object() && value.contains(key) && value.at(key).is_object())
        return value.at(key);
    return empty;
}

const Json& array(const Json& value, const char* key)
{
    static const Json empty = Json::array();
    if (value.is_object() && value.contains(key) && value.at(key).is_array())
        return value.at(key);
    return empty;
}

std::string ref(const Json& value) { return field(object(value, "$ref"), "id"); }

Json subject(const Json& value)
{
    const auto kind = field(value, "kind");
    if (kind == "character")
        return {{"kind", "character"}, {"id", ref(object(value, "character"))}};
    if (kind == "interactable")
        return {{"kind", "interactable"}, {"id", ref(object(value, "interactable"))}};
    const auto& feature = object(value, "feature");
    const auto owner = field(feature, "ownerKind");
    return {{"kind", "feature"},
            {"ownerKind", owner},
            {"ownerId", ref(object(feature, owner == "room" ? "room" : "interactable"))},
            {"featureId", field(feature, "featureId")}};
}

Json expectation(const Json& value)
{
    const auto type = field(value, "type");
    Json result{{"id", field(value, "id")}, {"type", type}, {"operator", field(value, "operator")}};
    const auto* group = type == "property"       ? "property"
                        : type == "current-room" ? "currentRoom"
                        : type == "location"     ? "location"
                        : type == "quantity"     ? "quantity"
                        : type == "trait"        ? "trait"
                        : type == "entity-state" ? "entityState"
                        : type == "active-flow"  ? "activeFlow"
                        : type == "layout"       ? "layout"
                        : type == "ui-element"   ? "uiElement"
                        : type == "event"        ? "event"
                                                 : "diagnostic";
    const auto& nested = object(value, group);
    if (type == "ui-element") {
        const auto mount = field(nested, "mountInstanceId");
        result["documentId"] = mount.empty() ? field(nested, "documentId") : "mount:" + mount;
        result["selector"] = field(nested, "selector");
        result["field"] = field(nested, "field");
        if (nested.contains("value"))
            result["value"] = nested.at("value");
    } else {
        result.update(nested);
    }
    return result;
}

Json expectations(const Json& values)
{
    Json converted = Json::array();
    for (const auto& value : values)
        converted.push_back(expectation(value));
    return converted;
}

bool has_ui_expectation(const Json& values)
{
    return std::any_of(values.begin(), values.end(),
                       [](const Json& value) { return field(value, "type") == "ui-element"; });
}

std::optional<Json> input(const Json& step)
{
    const auto kind = field(step, "input");
    if (kind == "tick") {
        const auto& tick = object(step, "tick");
        if (!tick.contains("deltaSeconds") || !tick.at("deltaSeconds").is_number())
            return std::nullopt;
        const auto seconds = tick.at("deltaSeconds").get<double>();
        if (!std::isfinite(seconds) || seconds < 0 ||
            seconds > static_cast<double>(std::numeric_limits<std::int64_t>::max()) / 1000000)
            return std::nullopt;
        return Json{
            {"type", "advance-time"},
            {"microseconds", static_cast<std::int64_t>(std::floor(seconds * 1000000 + 0.5))}};
    }
    if (kind == "continue" || kind == "fast-forward")
        return Json{{"type", kind}};
    if (kind == "dialogue-choice")
        return Json{{"type", kind}, {"edge", field(object(step, "dialogueChoice"), "edgeId")}};
    if (kind == "scene-choice")
        return Json{{"type", kind}, {"option", field(object(step, "sceneChoice"), "optionId")}};
    if (kind == "navigate")
        return Json{{"type", kind}, {"exit", field(object(step, "navigate"), "exitId")}};
    if (kind == "select-subjects") {
        Json subjects = Json::array();
        for (const auto& item : array(object(step, "selectSubjects"), "subjects"))
            subjects.push_back(subject(item));
        return Json{{"type", kind}, {"subjects", std::move(subjects)}};
    }
    if (kind == "primary-activate" || kind == "open-verb-menu") {
        const auto& selection = object(step, "subjectAction");
        if (!selection.contains("subject") || !selection.at("subject").is_object())
            return std::nullopt;
        return Json{{"type", kind}, {"subject", subject(selection.at("subject"))}};
    }
    if (kind == "clear-subject-selection")
        return Json{{"type", "clear-selection"}};
    if (kind == "run-interaction") {
        const auto& interaction = object(step, "runInteraction");
        Json bindings = Json::array();
        for (const auto& binding : array(interaction, "bindings"))
            bindings.push_back({{"slotId", field(binding, "slotId")},
                                {"subject", subject(object(binding, "subject"))}});
        const auto& verb = interaction.contains("verb") ? interaction.at("verb") : Json();
        return Json{
            {"type", "invoke-interaction"}, {"verb", ref(verb)}, {"bindings", std::move(bindings)}};
    }
    if (kind == "save" || kind == "load") {
        const auto slot = field(object(step, "saveSlot"), "slotId");
        if (slot == "autosave")
            return Json{{"type", kind}, {"slot", "autosave"}};
        static const std::regex valid_slot(R"(^slot-(0|[1-9][0-9]*)$)");
        if (std::regex_match(slot, valid_slot))
            return Json{{"type", kind}, {"slot", "manual-" + slot.substr(5)}};
        return std::nullopt;
    }
    if (kind == "ui-click") {
        const auto& ui = object(step, "uiClick");
        const auto mount = field(ui, "mountInstanceId");
        return Json{{"type", kind},
                    {"documentId", mount.empty() ? field(ui, "documentId") : "mount:" + mount},
                    {"selector", field(ui, "selector")}};
    }
    return std::nullopt;
}

Json blocked(std::string id, Json diagnostics)
{
    if (diagnostics.empty())
        diagnostics.push_back({{"severity", "error"},
                               {"path", "/tests/" + id + "/data"},
                               {"message", "Test data is invalid."},
                               {"category", "Tests"}});
    std::sort(diagnostics.begin(), diagnostics.end(), [](const Json& a, const Json& b) {
        for (const auto* key : {"path", "severity", "message", "category"}) {
            if (field(a, key) != field(b, key))
                return field(a, key) < field(b, key);
        }
        return false;
    });
    return Json{
        {"id", std::move(id)}, {"status", "blocked"}, {"diagnostics", std::move(diagnostics)}};
}

} // namespace

Json lower_test_catalog(const Json& project, const Json& source_diagnostics)
{
    Json entries = Json::array();
    const auto& tests = object(project, "tests");
    for (auto iterator = tests.begin(); iterator != tests.end(); ++iterator) {
        const auto id = iterator.key();
        const auto prefix = "/tests/" + id;
        Json errors = Json::array();
        for (const auto& item : source_diagnostics) {
            const auto path = field(item, "path");
            if (field(item, "severity") != "error" ||
                !(path == prefix || path.starts_with(prefix + "/")))
                continue;
            Json error{{"severity", "error"}, {"path", path}, {"message", field(item, "message")}};
            if (item.contains("category") && item.at("category").is_string())
                error["category"] = item.at("category");
            errors.push_back(std::move(error));
        }
        const auto& data = object(iterator.value(), "data");
        if (!errors.empty() || data.empty() || !data.contains("steps") ||
            !data.at("steps").is_array() || !data.contains("finalExpectations") ||
            !data.at("finalExpectations").is_array()) {
            entries.push_back(blocked(id, std::move(errors)));
            continue;
        }
        Json steps = Json::array();
        bool uses_ui = has_ui_expectation(data.at("finalExpectations"));
        std::size_t step_index = 0;
        for (const auto& step : data.at("steps")) {
            if (!step.value("enabled", false))
                continue;
            const auto kind = field(step, "input");
            uses_ui |= kind == "ui-click" || has_ui_expectation(array(step, "expectations"));
            const auto typed = input(step);
            if (!typed) {
                errors.push_back(
                    {{"severity", "error"},
                     {"path",
                      prefix + "/data/steps/" + std::to_string(step_index) +
                          (kind == "save" || kind == "load" ? "/saveSlot/slotId" : "/input")},
                     {"message",
                      kind == "save" || kind == "load"
                          ? "Save slot must be 'autosave' or 'slot-N' for a "
                            "non-negative integer N."
                          : "Input '" + kind + "' does not have a stable typed runtime identity."},
                     {"category", "Test playback"}});
            } else {
                steps.push_back({{"index", step_index},
                                 {"input", *typed},
                                 {"expectations", expectations(array(step, "expectations"))}});
            }
            ++step_index;
        }
        if (!errors.empty()) {
            entries.push_back(blocked(id, std::move(errors)));
            continue;
        }
        entries.push_back({{"id", id},
                           {"status", "runnable"},
                           {"runner", uses_ui ? "runtime-ui" : "runtime"},
                           {"spec",
                            {{"schema", "noveltea.editor.playback"},
                             {"version", 1},
                             {"id", id},
                             {"steps", std::move(steps)},
                             {"finalExpectations", expectations(data.at("finalExpectations"))}}}});
    }
    return {{"schema", "noveltea.runtime-test-catalog"}, {"entries", std::move(entries)}};
}

} // namespace noveltea::cli
