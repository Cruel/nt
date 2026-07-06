#include <noveltea/core/editor_api.hpp>

#include <noveltea/core/legacy/project_importer.hpp>
#include <noveltea/core/project_ids.hpp>

#include <algorithm>
#include <cstdint>
#include <utility>

namespace noveltea::core::editor {
namespace {

ToolDiagnostic error(std::string path, std::string message)
{
    return ToolDiagnostic{DiagnosticSeverity::Error, std::move(path), std::move(message)};
}

ToolDiagnostic warning(std::string path, std::string message)
{
    return ToolDiagnostic{DiagnosticSeverity::Warning, std::move(path), std::move(message)};
}

bool is_entity_collection(std::string_view collection)
{
    for (const auto key : project_ids::entity_collection_keys) {
        if (key == collection)
            return true;
    }
    return false;
}

std::string to_string(RuntimePlaybackInputType type)
{
    switch (type) {
    case RuntimePlaybackInputType::Tick:
        return "tick";
    case RuntimePlaybackInputType::Continue:
        return "continue";
    case RuntimePlaybackInputType::DialogueOption:
        return "dialogue_option";
    case RuntimePlaybackInputType::Navigate:
        return "navigate";
    case RuntimePlaybackInputType::SelectObject:
        return "select_object";
    case RuntimePlaybackInputType::ClearObjectSelection:
        return "clear_object_selection";
    case RuntimePlaybackInputType::RunAction:
        return "run_action";
    case RuntimePlaybackInputType::LoadSave:
        return "load_save";
    case RuntimePlaybackInputType::SetEntrypoint:
        return "set_entrypoint";
    }
    return "tick";
}

std::optional<RuntimePlaybackInputType> playback_input_from_string(std::string_view value)
{
    if (value == "tick")
        return RuntimePlaybackInputType::Tick;
    if (value == "continue")
        return RuntimePlaybackInputType::Continue;
    if (value == "dialogue_option")
        return RuntimePlaybackInputType::DialogueOption;
    if (value == "navigate")
        return RuntimePlaybackInputType::Navigate;
    if (value == "select_object")
        return RuntimePlaybackInputType::SelectObject;
    if (value == "clear_object_selection")
        return RuntimePlaybackInputType::ClearObjectSelection;
    if (value == "run_action")
        return RuntimePlaybackInputType::RunAction;
    if (value == "load_save")
        return RuntimePlaybackInputType::LoadSave;
    if (value == "set_entrypoint")
        return RuntimePlaybackInputType::SetEntrypoint;
    return std::nullopt;
}

std::optional<RuntimePlaybackAssertionType> playback_assertion_from_string(std::string_view value)
{
    if (value == "mode")
        return RuntimePlaybackAssertionType::Mode;
    if (value == "current_room")
        return RuntimePlaybackAssertionType::CurrentRoom;
    if (value == "title")
        return RuntimePlaybackAssertionType::Title;
    if (value == "text_log_contains")
        return RuntimePlaybackAssertionType::TextLogContains;
    if (value == "property_equals")
        return RuntimePlaybackAssertionType::PropertyEquals;
    if (value == "object_location")
        return RuntimePlaybackAssertionType::ObjectLocation;
    if (value == "inventory_contains")
        return RuntimePlaybackAssertionType::InventoryContains;
    if (value == "output_type")
        return RuntimePlaybackAssertionType::OutputType;
    if (value == "diagnostic_category")
        return RuntimePlaybackAssertionType::DiagnosticCategory;
    return std::nullopt;
}

std::string to_string(RuntimeDiagnosticSeverity severity)
{
    switch (severity) {
    case RuntimeDiagnosticSeverity::Info:
        return "info";
    case RuntimeDiagnosticSeverity::Warning:
        return "warning";
    case RuntimeDiagnosticSeverity::Error:
        return "error";
    }
    return "warning";
}

std::string to_string(RuntimeOutputType type)
{
    switch (type) {
    case RuntimeOutputType::Command:
        return "command";
    case RuntimeOutputType::ModeChanged:
        return "mode_changed";
    case RuntimeOutputType::ViewUpdated:
        return "view_updated";
    case RuntimeOutputType::ScriptRequest:
        return "script_request";
    case RuntimeOutputType::ScriptResult:
        return "script_result";
    case RuntimeOutputType::SaveMutationRequest:
        return "save_mutation_request";
    case RuntimeOutputType::TextLogEntry:
        return "text_log_entry";
    case RuntimeOutputType::Notification:
        return "notification";
    case RuntimeOutputType::Diagnostic:
        return "diagnostic";
    case RuntimeOutputType::TestObservation:
        return "test_observation";
    case RuntimeOutputType::AudioCommand:
        return "audio_command";
    }
    return "command";
}

std::optional<RuntimeOutputType> output_type_from_string(std::string_view value)
{
    if (value == "command")
        return RuntimeOutputType::Command;
    if (value == "mode_changed")
        return RuntimeOutputType::ModeChanged;
    if (value == "view_updated")
        return RuntimeOutputType::ViewUpdated;
    if (value == "script_request")
        return RuntimeOutputType::ScriptRequest;
    if (value == "script_result")
        return RuntimeOutputType::ScriptResult;
    if (value == "save_mutation_request")
        return RuntimeOutputType::SaveMutationRequest;
    if (value == "text_log_entry")
        return RuntimeOutputType::TextLogEntry;
    if (value == "notification")
        return RuntimeOutputType::Notification;
    if (value == "diagnostic")
        return RuntimeOutputType::Diagnostic;
    if (value == "test_observation")
        return RuntimeOutputType::TestObservation;
    if (value == "audio_command")
        return RuntimeOutputType::AudioCommand;
    return std::nullopt;
}

std::string entity_type_token(EntityType type)
{
    switch (type) {
    case EntityType::Action:
        return "action";
    case EntityType::Cutscene:
        return "cutscene";
    case EntityType::Dialogue:
        return "dialogue";
    case EntityType::Map:
        return "map";
    case EntityType::Object:
        return "object";
    case EntityType::Room:
        return "room";
    case EntityType::CustomScript:
        return "custom_script";
    case EntityType::Script:
        return "script";
    case EntityType::Verb:
        return "verb";
    case EntityType::Invalid:
        return "invalid";
    }
    return "unknown";
}

nlohmann::json entity_ref_to_report_json(const EntityRef& ref)
{
    return nlohmann::json{{"type", entity_type_token(ref.type)},
                          {"id", ref.id},
                          {"legacy_type", to_integer(ref.type)}};
}

std::optional<EntityRef> parse_ref_field(const nlohmann::json& json)
{
    if (json.is_array()) {
        return EntityRef::from_json(json);
    }
    if (json.is_object()) {
        auto type_it = json.find("type");
        auto id_it = json.find("id");
        if (type_it != json.end() && type_it->is_number_integer() && id_it != json.end() &&
            id_it->is_string()) {
            auto type = entity_type_from_integer(type_it->get<int>());
            if (type)
                return EntityRef{*type, id_it->get<std::string>()};
        }
    }
    return std::nullopt;
}

nlohmann::json diagnostic_to_json(const RuntimeDiagnostic& diagnostic)
{
    nlohmann::json json = {
        {"severity", to_string(diagnostic.severity)},
        {"category", diagnostic.category},
        {"message", diagnostic.message},
    };
    if (diagnostic.source)
        json["source"] = entity_ref_to_report_json(*diagnostic.source);
    if (!diagnostic.script_context.empty())
        json["script_context"] = diagnostic.script_context;
    if (!diagnostic.hook_context.empty())
        json["hook_context"] = diagnostic.hook_context;
    if (!diagnostic.lua_traceback.empty())
        json["lua_traceback"] = diagnostic.lua_traceback;
    if (diagnostic.playback_step_index)
        json["step_index"] = *diagnostic.playback_step_index;
    return json;
}

nlohmann::json output_to_json(const RuntimeOutput& output)
{
    nlohmann::json json = {{"type", to_string(output.type)}, {"payload", output.payload}};
    if (output.step_index)
        json["step_index"] = *output.step_index;
    if (output.command)
        json["command_type"] = static_cast<int>(output.command->type);
    if (output.diagnostic)
        json["diagnostic"] = diagnostic_to_json(*output.diagnostic);
    return json;
}

nlohmann::json preview_state_to_json(const RuntimePreviewState& state)
{
    return nlohmann::json{{"loaded", state.loaded},
                          {"running", state.running},
                          {"mode", state.mode},
                          {"title", state.view.title},
                          {"current_room", state.view.map_view.current_room_id},
                          {"controller_state", state.controller_state},
                          {"save_snapshot", state.save_snapshot}};
}

bool has_output_type(const std::vector<RuntimeOutput>& outputs, RuntimeOutputType type)
{
    return std::any_of(outputs.begin(), outputs.end(),
                       [type](const RuntimeOutput& output) { return output.type == type; });
}

bool has_diagnostic_category(const std::vector<RuntimeDiagnostic>& diagnostics,
                             const std::string& category)
{
    return std::any_of(diagnostics.begin(), diagnostics.end(),
                       [&category](const RuntimeDiagnostic& diagnostic) {
                           return diagnostic.category == category;
                       });
}

std::string json_pointer_value(const nlohmann::json& json, std::string_view pointer)
{
    if (pointer.empty())
        return json.dump();
    try {
        const auto& value = json.at(nlohmann::json::json_pointer(std::string(pointer)));
        return value.is_string() ? value.get<std::string>() : value.dump();
    } catch (const nlohmann::json::exception&) {
        return {};
    }
}

void append_failure(RuntimePlaybackReport& report, RuntimePlaybackObservation& observation,
                    std::string message)
{
    observation.passed = false;
    report.passed = false;
    observation.assertion_failures.push_back(message);
    report.failures.push_back("step " + std::to_string(observation.step_index) + ": " + message);
}

void append_diagnostics(RuntimePlaybackReport& report, RuntimePlaybackObservation& observation,
                        const std::vector<RuntimeDiagnostic>& diagnostics)
{
    observation.diagnostics.insert(observation.diagnostics.end(), diagnostics.begin(),
                                   diagnostics.end());
    report.diagnostics.insert(report.diagnostics.end(), diagnostics.begin(), diagnostics.end());
    if (std::any_of(diagnostics.begin(), diagnostics.end(),
                    [](const RuntimeDiagnostic& diagnostic) {
                        return diagnostic.severity == RuntimeDiagnosticSeverity::Error;
                    })) {
        observation.passed = false;
        report.passed = false;
    }
}

RuntimeInput runtime_input_for_step(const RuntimePlaybackStep& step, double delta_seconds,
                                    std::uint64_t step_index)
{
    RuntimeInput input;
    input.delta_seconds = delta_seconds;
    input.index = step.option_index;
    input.direction = step.direction;
    input.verb_id = step.verb_id;
    input.object_ids = step.object_ids;
    input.entity_ref = step.entity_ref;
    input.payload = step.payload;
    input.step_index = step_index;

    switch (step.input) {
    case RuntimePlaybackInputType::Tick:
        input.type = RuntimeInputType::Tick;
        break;
    case RuntimePlaybackInputType::Continue:
        input.type = RuntimeInputType::Continue;
        break;
    case RuntimePlaybackInputType::DialogueOption:
        input.type = RuntimeInputType::SelectDialogueOption;
        break;
    case RuntimePlaybackInputType::Navigate:
        input.type = RuntimeInputType::Navigate;
        break;
    case RuntimePlaybackInputType::SelectObject:
        input.type = RuntimeInputType::SelectObject;
        break;
    case RuntimePlaybackInputType::ClearObjectSelection:
        input.type = RuntimeInputType::ClearObjectSelection;
        break;
    case RuntimePlaybackInputType::RunAction:
        input.type = RuntimeInputType::RunAction;
        break;
    case RuntimePlaybackInputType::LoadSave:
        input.type = RuntimeInputType::LoadSave;
        break;
    case RuntimePlaybackInputType::SetEntrypoint:
        input.type = RuntimeInputType::SetEntrypoint;
        break;
    }
    return input;
}

void evaluate_assertion(const RuntimePlaybackAssertion& assertion,
                        const RuntimePlaybackObservation& observation,
                        RuntimePlaybackReport& report,
                        RuntimePlaybackObservation& mutable_observation)
{
    const auto& state = observation.state;
    switch (assertion.type) {
    case RuntimePlaybackAssertionType::Mode:
        if (state.mode != assertion.value)
            append_failure(report, mutable_observation,
                           "expected mode '" + assertion.value + "', got '" + state.mode + "'");
        break;
    case RuntimePlaybackAssertionType::CurrentRoom:
        if (state.view.map_view.current_room_id != assertion.value)
            append_failure(report, mutable_observation,
                           "expected current room '" + assertion.value + "', got '" +
                               state.view.map_view.current_room_id + "'");
        break;
    case RuntimePlaybackAssertionType::Title:
        if (state.view.title != assertion.value)
            append_failure(report, mutable_observation,
                           "expected title '" + assertion.value + "', got '" + state.view.title +
                               "'");
        break;
    case RuntimePlaybackAssertionType::TextLogContains: {
        const bool found =
            std::any_of(state.view.text_log.begin(), state.view.text_log.end(),
                        [&assertion](const RuntimeUITextLogEntry& entry) {
                            return entry.plain_text.find(assertion.value) != std::string::npos;
                        });
        if (!found)
            append_failure(report, mutable_observation,
                           "expected text log to contain '" + assertion.value + "'");
        break;
    }
    case RuntimePlaybackAssertionType::PropertyEquals: {
        const auto actual = json_pointer_value(
            state.save_snapshot, "/" + std::string(project_ids::properties) + "/" + assertion.key);
        const auto expected = assertion.expected.is_string() ? assertion.expected.get<std::string>()
                                                             : assertion.expected.dump();
        if (actual != expected)
            append_failure(report, mutable_observation,
                           "expected property '" + assertion.key + "' to equal " + expected +
                               ", got " + actual);
        break;
    }
    case RuntimePlaybackAssertionType::ObjectLocation: {
        const auto actual = json_pointer_value(state.save_snapshot,
                                               "/" + std::string(project_ids::object_locations) +
                                                   "/" + assertion.key);
        std::string expected;
        if (assertion.entity_ref)
            expected = assertion.entity_ref->to_json().dump();
        else if (!assertion.expected.is_null())
            expected = assertion.expected.dump();
        if (actual != expected)
            append_failure(report, mutable_observation,
                           "expected object '" + assertion.key + "' location " + expected +
                               ", got " + actual);
        break;
    }
    case RuntimePlaybackAssertionType::InventoryContains: {
        const bool found =
            std::any_of(state.view.objects.begin(), state.view.objects.end(),
                        [&assertion](const RuntimeUIObject& object) {
                            return object.id == assertion.value && object.in_inventory;
                        });
        if (!found)
            append_failure(report, mutable_observation,
                           "expected inventory to contain '" + assertion.value + "'");
        break;
    }
    case RuntimePlaybackAssertionType::OutputType: {
        auto type = output_type_from_string(assertion.value);
        if (!type || !has_output_type(observation.outputs, *type))
            append_failure(report, mutable_observation,
                           "expected output type '" + assertion.value + "'");
        break;
    }
    case RuntimePlaybackAssertionType::DiagnosticCategory:
        if (!has_diagnostic_category(observation.diagnostics, assertion.value))
            append_failure(report, mutable_observation,
                           "expected diagnostic category '" + assertion.value + "'");
        break;
    }
}

std::optional<RuntimePlaybackAssertion> parse_assertion(const nlohmann::json& json,
                                                        std::vector<ToolDiagnostic>& diagnostics,
                                                        const std::string& path)
{
    if (!json.is_object()) {
        diagnostics.push_back(error(path, "Playback assertion must be an object."));
        return std::nullopt;
    }
    const auto type_name = json.value("type", std::string{});
    auto type = playback_assertion_from_string(type_name);
    if (!type) {
        diagnostics.push_back(error(path + "/type", "Unknown playback assertion type."));
        return std::nullopt;
    }

    RuntimePlaybackAssertion assertion;
    assertion.type = *type;
    assertion.value = json.value("value", std::string{});
    assertion.key = json.value("key", std::string{});
    if (json.contains("expected"))
        assertion.expected = json["expected"];
    if (json.contains("entity_ref"))
        assertion.entity_ref = parse_ref_field(json["entity_ref"]);
    return assertion;
}

std::optional<RuntimePlaybackStep> parse_step(const nlohmann::json& json,
                                              std::vector<ToolDiagnostic>& diagnostics,
                                              const std::string& path)
{
    if (!json.is_object()) {
        diagnostics.push_back(error(path, "Playback step must be an object."));
        return std::nullopt;
    }
    auto input = playback_input_from_string(json.value("input", std::string{"tick"}));
    if (!input) {
        diagnostics.push_back(error(path + "/input", "Unknown playback input type."));
        return std::nullopt;
    }

    RuntimePlaybackStep step;
    step.input = *input;
    if (json.contains("index") && json["index"].is_number_unsigned())
        step.index = json["index"].get<std::uint64_t>();
    if (json.contains("delta_seconds") && json["delta_seconds"].is_number())
        step.delta_seconds = json["delta_seconds"].get<double>();
    step.option_index = json.value("option_index", json.value("index_value", -1));
    step.direction = json.value("direction", -1);
    step.verb_id = json.value("verb_id", std::string{});
    if (json.contains("object_id") && json["object_id"].is_string()) {
        step.object_ids.push_back(json["object_id"].get<std::string>());
    }
    if (json.contains("object_ids") && json["object_ids"].is_array()) {
        for (const auto& object_id : json["object_ids"]) {
            if (object_id.is_string())
                step.object_ids.push_back(object_id.get<std::string>());
        }
    }
    if (json.contains("entity_ref"))
        step.entity_ref = parse_ref_field(json["entity_ref"]);
    if (json.contains("payload"))
        step.payload = json["payload"];
    step.init_script = json.value(std::string(project_ids::test_script_init), std::string{});
    step.check_script = json.value(std::string(project_ids::test_script_check), std::string{});
    if (json.contains("assertions") && json["assertions"].is_array()) {
        for (std::size_t i = 0; i < json["assertions"].size(); ++i) {
            auto parsed = parse_assertion(json["assertions"][i], diagnostics,
                                          path + "/assertions/" + std::to_string(i));
            if (parsed)
                step.assertions.push_back(std::move(*parsed));
        }
    }
    return step;
}

void capture_output_commands(const RuntimeInputResult& result,
                             std::vector<ControllerCommand>& captured)
{
    for (const auto& output : result.outputs) {
        if (output.command.has_value()) {
            captured.push_back(*output.command);
        }
    }
}

} // namespace

bool ProjectLoadResult::has_errors() const noexcept
{
    return std::any_of(diagnostics.begin(), diagnostics.end(),
                       [](const ToolDiagnostic& diagnostic) {
                           return diagnostic.severity == DiagnosticSeverity::Error;
                       });
}

bool EntityEditResult::success() const noexcept
{
    return std::none_of(diagnostics.begin(), diagnostics.end(),
                        [](const ToolDiagnostic& diagnostic) {
                            return diagnostic.severity == DiagnosticSeverity::Error;
                        });
}

nlohmann::json RuntimePlaybackReport::to_json() const
{
    nlohmann::json observations = nlohmann::json::array();
    for (const auto& observation : this->observations) {
        nlohmann::json outputs = nlohmann::json::array();
        for (const auto& output : observation.outputs)
            outputs.push_back(output_to_json(output));

        nlohmann::json diagnostics_json = nlohmann::json::array();
        for (const auto& diagnostic : observation.diagnostics)
            diagnostics_json.push_back(diagnostic_to_json(diagnostic));

        observations.push_back({{"step_index", observation.step_index},
                                {"input", observation.input},
                                {"handled", observation.handled},
                                {"passed", observation.passed},
                                {"state", preview_state_to_json(observation.state)},
                                {"outputs", std::move(outputs)},
                                {"diagnostics", std::move(diagnostics_json)},
                                {"assertion_failures", observation.assertion_failures}});
    }

    nlohmann::json outputs = nlohmann::json::array();
    for (const auto& output : this->outputs)
        outputs.push_back(output_to_json(output));

    nlohmann::json diagnostics_json = nlohmann::json::array();
    for (const auto& diagnostic : this->diagnostics)
        diagnostics_json.push_back(diagnostic_to_json(diagnostic));

    return {{"id", id},
            {"passed", passed},
            {"failures", failures},
            {"final_state", preview_state_to_json(final_state)},
            {"observations", std::move(observations)},
            {"outputs", std::move(outputs)},
            {"diagnostics", std::move(diagnostics_json)}};
}

ProjectLoadResult ProjectTooling::load_project_json(std::string_view source)
{
    ProjectLoadResult result;
    try {
        result.project = ProjectDocument(nlohmann::json::parse(source));
    } catch (const nlohmann::json::parse_error& parse_error) {
        result.diagnostics.push_back(
            error("/", std::string("Malformed project JSON: ") + parse_error.what()));
        return result;
    }

    auto validation = validate_project(*result.project);
    result.diagnostics.insert(result.diagnostics.end(), std::make_move_iterator(validation.begin()),
                              std::make_move_iterator(validation.end()));
    return result;
}

ProjectLoadResult ProjectTooling::import_legacy_game_json(std::string_view source)
{
    ProjectLoadResult result;
    std::vector<legacy::ImportError> errors;
    auto imported = legacy::ProjectImporter::import_game_json_text(source, errors);
    if (!imported) {
        for (const auto& import_error : errors) {
            result.diagnostics.push_back(error("/", import_error.message));
        }
        if (result.diagnostics.empty()) {
            result.diagnostics.push_back(error("/", "Legacy project import failed."));
        }
        return result;
    }

    result.imported_legacy = true;
    result.project = std::move(imported->document);
    auto validation = validate_project(*result.project);
    result.diagnostics.insert(result.diagnostics.end(), std::make_move_iterator(validation.begin()),
                              std::make_move_iterator(validation.end()));
    return result;
}

std::vector<ToolDiagnostic> ProjectTooling::validate_project(const ProjectDocument& project)
{
    std::vector<ToolDiagnostic> diagnostics;
    for (const auto& issue : ProjectValidator::validate(project)) {
        diagnostics.push_back(error(issue.path, issue.message));
    }
    return diagnostics;
}

std::string ProjectTooling::save_project_json(const ProjectDocument& project)
{
    return project.dump();
}

PackageExportResult ProjectTooling::export_project_package(const ProjectDocument& project,
                                                           const std::filesystem::path& path,
                                                           const PackageExportOptions& options)
{
    return ProjectPackageWriter::write_to_file(project, path, options);
}

EntityEditResult ProjectTooling::set_entity_record(ProjectDocument& project,
                                                   std::string_view collection,
                                                   std::string_view entity_id,
                                                   nlohmann::json record)
{
    EntityEditResult result;
    if (!is_entity_collection(collection)) {
        result.diagnostics.push_back(
            error("/", "Unknown entity collection '" + std::string(collection) + "'."));
        return result;
    }
    if (entity_id.empty()) {
        result.diagnostics.push_back(
            error("/" + std::string(collection), "Entity id must not be empty."));
        return result;
    }
    if (!record.is_array()) {
        result.diagnostics.push_back(
            error("/" + std::string(collection) + "/" + std::string(entity_id),
                  "Entity record must use the legacy array shape."));
        return result;
    }
    if (record.empty() || !record[0].is_string()) {
        result.diagnostics.push_back(
            error("/" + std::string(collection) + "/" + std::string(entity_id) + "[0]",
                  "Entity record id field must be a string."));
        return result;
    }
    if (record[0].get<std::string>() != entity_id) {
        result.diagnostics.push_back(
            warning("/" + std::string(collection) + "/" + std::string(entity_id) + "[0]",
                    "Entity record id did not match the map key and was normalized."));
        record[0] = std::string(entity_id);
    }

    auto& root = project.root();
    if (!root.contains(std::string(collection)) || !root[std::string(collection)].is_object()) {
        root[std::string(collection)] = nlohmann::json::object();
    }
    root[std::string(collection)][std::string(entity_id)] = std::move(record);
    return result;
}

EntityEditResult ProjectTooling::erase_entity_record(ProjectDocument& project,
                                                     std::string_view collection,
                                                     std::string_view entity_id)
{
    EntityEditResult result;
    if (!is_entity_collection(collection)) {
        result.diagnostics.push_back(
            error("/", "Unknown entity collection '" + std::string(collection) + "'."));
        return result;
    }
    auto& root = project.root();
    auto collection_it = root.find(std::string(collection));
    if (collection_it == root.end() || !collection_it->is_object())
        return result;
    collection_it->erase(std::string(entity_id));
    return result;
}

std::optional<RuntimePlaybackSpec>
RuntimePlaybackSession::parse_spec(const nlohmann::json& json,
                                   std::vector<ToolDiagnostic>& diagnostics, std::string_view path)
{
    const auto base_path = std::string(path);
    if (!json.is_object()) {
        diagnostics.push_back(error(base_path, "Playback spec must be an object."));
        return std::nullopt;
    }

    RuntimePlaybackSpec spec;
    spec.id = json.value("id", std::string{});
    if (spec.id.empty()) {
        diagnostics.push_back(error(base_path + "/id", "Playback spec requires an id."));
    }
    if (json.contains("entrypoint"))
        spec.entrypoint = parse_ref_field(json["entrypoint"]);
    if (json.contains("fixed_delta_seconds") && json["fixed_delta_seconds"].is_number())
        spec.fixed_delta_seconds = json["fixed_delta_seconds"].get<double>();
    spec.init_script = json.value(std::string(project_ids::test_script_init), std::string{});
    spec.check_script = json.value(std::string(project_ids::test_script_check), std::string{});

    const auto steps_key = std::string(project_ids::test_steps);
    auto steps_it = json.find(steps_key);
    if (steps_it == json.end() || !steps_it->is_array()) {
        diagnostics.push_back(
            error(base_path + "/" + steps_key, "Playback spec requires a steps array."));
    } else {
        for (std::size_t i = 0; i < steps_it->size(); ++i) {
            auto parsed = parse_step((*steps_it)[i], diagnostics,
                                     base_path + "/" + steps_key + "/" + std::to_string(i));
            if (parsed)
                spec.steps.push_back(std::move(*parsed));
        }
    }

    if (std::any_of(diagnostics.begin(), diagnostics.end(),
                    [&base_path](const ToolDiagnostic& diagnostic) {
                        return diagnostic.severity == DiagnosticSeverity::Error &&
                               diagnostic.path.rfind(base_path, 0) == 0;
                    })) {
        return std::nullopt;
    }
    return spec;
}

std::vector<RuntimePlaybackSpec>
RuntimePlaybackSession::specs_from_project(const ProjectDocument& project,
                                           std::vector<ToolDiagnostic>& diagnostics)
{
    std::vector<RuntimePlaybackSpec> specs;
    const auto& root = project.root();
    auto tests_it = root.find(std::string(project_ids::tests));
    if (tests_it == root.end() || tests_it->is_null())
        return specs;

    if (tests_it->is_array()) {
        for (std::size_t i = 0; i < tests_it->size(); ++i) {
            auto parsed =
                parse_spec((*tests_it)[i], diagnostics,
                           "/" + std::string(project_ids::tests) + "/" + std::to_string(i));
            if (parsed)
                specs.push_back(std::move(*parsed));
        }
        return specs;
    }

    if (tests_it->is_object()) {
        for (auto it = tests_it->begin(); it != tests_it->end(); ++it) {
            auto test_json = it.value();
            if (test_json.is_object() && !test_json.contains("id"))
                test_json["id"] = it.key();
            auto parsed = parse_spec(test_json, diagnostics,
                                     "/" + std::string(project_ids::tests) + "/" + it.key());
            if (parsed)
                specs.push_back(std::move(*parsed));
        }
        return specs;
    }

    diagnostics.push_back(
        error("/" + std::string(project_ids::tests), "Project tests must be an object or array."));
    return specs;
}

RuntimePlaybackReport RuntimePlaybackSession::run(ProjectDocument project,
                                                  const RuntimePlaybackSpec& spec)
{
    return run(std::move(project), SaveDocument::new_save(), spec);
}

RuntimePlaybackReport RuntimePlaybackSession::run(ProjectDocument project, SaveDocument save,
                                                  const RuntimePlaybackSpec& spec)
{
    RuntimePlaybackReport report;
    report.id = spec.id;

    if (spec.entrypoint)
        project.root()[project_ids::entrypoint_entity] = spec.entrypoint->to_json();

    RuntimeSessionHost host;
    auto load = host.load(std::move(project), std::move(save));
    if (!load.success) {
        report.passed = false;
        for (const auto& load_error : load.diagnostics) {
            RuntimeDiagnostic diagnostic;
            diagnostic.severity = RuntimeDiagnosticSeverity::Error;
            diagnostic.category = "playback-load";
            diagnostic.message = load_error.message;
            report.diagnostics.push_back(std::move(diagnostic));
            report.failures.push_back(load_error.message);
        }
        report.final_state.loaded = false;
        return report;
    }

    auto make_state = [&host]() {
        RuntimePreviewState state;
        state.loaded = host.loaded();
        state.running = true;
        state.mode = std::string(host.current_mode_name());
        state.view = host.view_state();
        if (const auto* controller = host.controller())
            state.controller_state = controller->save_state();
        if (host.loaded())
            state.save_snapshot = host.snapshot_save().root();
        return state;
    };

    auto run_hook = [&](std::string_view source, std::string_view context,
                        std::optional<std::uint64_t> step_index,
                        RuntimePlaybackObservation* observation) {
        if (source.empty())
            return;

        RuntimeOutput request;
        request.type = RuntimeOutputType::ScriptRequest;
        request.payload = {{"context", context}, {"source", source}};
        request.step_index = step_index;
        report.outputs.push_back(request);
        if (observation)
            observation->outputs.push_back(std::move(request));

        if (!m_hook_executor)
            return;

        auto hook = m_hook_executor(source, context, step_index, host);
        report.outputs.insert(report.outputs.end(), hook.outputs.begin(), hook.outputs.end());
        report.diagnostics.insert(report.diagnostics.end(), hook.diagnostics.begin(),
                                  hook.diagnostics.end());
        if (observation) {
            observation->outputs.insert(observation->outputs.end(), hook.outputs.begin(),
                                        hook.outputs.end());
            observation->diagnostics.insert(observation->diagnostics.end(),
                                            hook.diagnostics.begin(), hook.diagnostics.end());
            if (!hook.passed) {
                observation->passed = false;
                report.passed = false;
                report.failures.push_back("step " + std::to_string(observation->step_index) +
                                          ": hook '" + std::string(context) + "' failed");
            }
        } else if (!hook.passed) {
            report.passed = false;
            report.failures.push_back("hook '" + std::string(context) + "' failed");
        }
    };

    run_hook(spec.init_script, "playback_init", std::nullopt, nullptr);

    RuntimeInput start;
    start.type = RuntimeInputType::Tick;
    start.delta_seconds = 0.0;
    auto start_result = host.apply_input(start);
    report.outputs.insert(report.outputs.end(), start_result.outputs.begin(),
                          start_result.outputs.end());
    report.diagnostics.insert(report.diagnostics.end(), start_result.diagnostics.begin(),
                              start_result.diagnostics.end());

    for (std::size_t i = 0; i < spec.steps.size(); ++i) {
        const auto& step = spec.steps[i];
        const auto step_index = step.index.value_or(static_cast<std::uint64_t>(i));
        RuntimePlaybackObservation observation;
        observation.step_index = step_index;
        observation.input = to_string(step.input);

        run_hook(step.init_script, "playback_step_init", step_index, &observation);

        const double delta_seconds =
            step.delta_seconds.value_or(spec.fixed_delta_seconds.value_or(0.0));
        if (step.input == RuntimePlaybackInputType::SetEntrypoint) {
            if (step.entity_ref) {
                RuntimeDiagnostic diagnostic;
                diagnostic.severity = RuntimeDiagnosticSeverity::Warning;
                diagnostic.category = "playback";
                diagnostic.message =
                    "set_entrypoint is only supported before load in this playback slice";
                diagnostic.source = step.entity_ref;
                diagnostic.playback_step_index = step_index;
                observation.handled = false;
                append_diagnostics(report, observation, {diagnostic});
            } else {
                RuntimeDiagnostic diagnostic;
                diagnostic.severity = RuntimeDiagnosticSeverity::Warning;
                diagnostic.category = "playback";
                diagnostic.message = "set_entrypoint step requires entity_ref";
                diagnostic.playback_step_index = step_index;
                observation.handled = false;
                append_diagnostics(report, observation, {diagnostic});
            }
        } else {
            auto input = runtime_input_for_step(step, delta_seconds, step_index);
            auto result = host.apply_input(input);
            observation.handled = result.handled;
            observation.outputs = result.outputs;
            observation.diagnostics = result.diagnostics;
            report.outputs.insert(report.outputs.end(), result.outputs.begin(),
                                  result.outputs.end());
            append_diagnostics(report, observation, result.diagnostics);
            if (!result.handled) {
                observation.passed = false;
                report.passed = false;
                report.failures.push_back("step " + std::to_string(step_index) +
                                          ": input was not handled");
            } else if (step.input != RuntimePlaybackInputType::Tick) {
                RuntimeInput drain;
                drain.type = RuntimeInputType::Tick;
                drain.delta_seconds = 0.0;
                drain.step_index = step_index;
                auto drain_result = host.apply_input(drain);
                observation.outputs.insert(observation.outputs.end(), drain_result.outputs.begin(),
                                           drain_result.outputs.end());
                report.outputs.insert(report.outputs.end(), drain_result.outputs.begin(),
                                      drain_result.outputs.end());
                append_diagnostics(report, observation, drain_result.diagnostics);
            }
        }

        run_hook(step.check_script, "playback_step_check", step_index, &observation);

        observation.state = make_state();
        for (const auto& assertion : step.assertions)
            evaluate_assertion(assertion, observation, report, observation);

        RuntimeOutput observation_output;
        observation_output.type = RuntimeOutputType::TestObservation;
        observation_output.step_index = step_index;
        observation_output.payload = {{"input", observation.input},
                                      {"handled", observation.handled},
                                      {"passed", observation.passed},
                                      {"assertion_failures", observation.assertion_failures}};
        report.outputs.push_back(observation_output);
        observation.outputs.push_back(std::move(observation_output));

        report.observations.push_back(std::move(observation));
    }

    run_hook(spec.check_script, "playback_check", std::nullopt, nullptr);
    report.final_state = make_state();
    return report;
}

GameSessionLoadResult RuntimePreviewSession::load(ProjectDocument project)
{
    m_initial_save.reset();
    m_project = project;
    m_captured_commands.clear();
    m_running = false;
    return m_host.load(std::move(project));
}

GameSessionLoadResult RuntimePreviewSession::load(ProjectDocument project, SaveDocument save)
{
    m_project = project;
    m_initial_save = save;
    m_captured_commands.clear();
    m_running = false;
    return m_host.load(std::move(project), std::move(save));
}

void RuntimePreviewSession::start()
{
    if (!m_host.loaded())
        return;
    m_running = true;
    step(0.0);
}

void RuntimePreviewSession::stop() { m_running = false; }

GameSessionLoadResult RuntimePreviewSession::reset()
{
    if (!m_project) {
        m_host.reset();
        m_captured_commands.clear();
        m_running = false;
        return GameSessionLoadResult{};
    }
    const bool was_running = m_running;
    auto result =
        m_initial_save ? m_host.load(*m_project, *m_initial_save) : m_host.load(*m_project);
    m_captured_commands.clear();
    m_running = was_running && result.success;
    if (m_running)
        step(0.0);
    return result;
}

GameSessionLoadResult RuntimePreviewSession::set_entrypoint(EntityRef entrypoint)
{
    if (!m_project)
        return GameSessionLoadResult{};
    m_project->root()[project_ids::entrypoint_entity] = entrypoint.to_json();
    return reset();
}

void RuntimePreviewSession::step(double delta_seconds)
{
    if (!m_host.loaded())
        return;
    if (!m_running && delta_seconds > 0.0)
        return;
    RuntimeInput input;
    input.type = RuntimeInputType::Tick;
    input.delta_seconds = delta_seconds;
    capture_output_commands(m_host.apply_input(input), m_captured_commands);
}

RuntimePreviewState RuntimePreviewSession::inspect_state() const
{
    RuntimePreviewState state;
    state.loaded = m_host.loaded();
    state.running = m_running;
    state.mode = std::string(m_host.current_mode_name());
    state.view = m_host.view_state();
    if (const auto* controller = m_host.controller()) {
        state.controller_state = controller->save_state();
    }
    if (m_host.loaded()) {
        state.save_snapshot = m_host.snapshot_save().root();
    }
    return state;
}

std::vector<ControllerCommand> RuntimePreviewSession::take_captured_commands()
{
    auto commands = std::move(m_captured_commands);
    m_captured_commands.clear();
    return commands;
}

bool RuntimePreviewSession::inject_navigation_choice(int direction)
{
    RuntimeInput input;
    input.type = RuntimeInputType::Navigate;
    input.direction = direction;
    auto result = m_host.apply_input(input);
    if (result.handled) {
        capture_output_commands(result, m_captured_commands);
    }
    return result.handled;
}

bool RuntimePreviewSession::inject_dialogue_option(int option_index)
{
    RuntimeInput input;
    input.type = RuntimeInputType::SelectDialogueOption;
    input.index = option_index;
    auto result = m_host.apply_input(input);
    if (result.handled) {
        capture_output_commands(result, m_captured_commands);
    }
    return result.handled;
}

bool RuntimePreviewSession::inject_continue()
{
    RuntimeInput input;
    input.type = RuntimeInputType::Continue;
    auto result = m_host.apply_input(input);
    if (result.handled) {
        capture_output_commands(result, m_captured_commands);
    }
    return result.handled;
}

bool RuntimePreviewSession::inject_object_selection(const std::string& object_id)
{
    RuntimeInput input;
    input.type = RuntimeInputType::SelectObject;
    input.object_ids = {object_id};
    auto result = m_host.apply_input(input);
    if (result.handled) {
        capture_output_commands(result, m_captured_commands);
    }
    return result.handled;
}

bool RuntimePreviewSession::clear_object_selection()
{
    RuntimeInput input;
    input.type = RuntimeInputType::ClearObjectSelection;
    auto result = m_host.apply_input(input);
    if (result.handled) {
        capture_output_commands(result, m_captured_commands);
    }
    return result.handled;
}

bool RuntimePreviewSession::inject_action(const std::string& verb_id,
                                          const std::vector<std::string>& object_ids)
{
    RuntimeInput input;
    input.type = RuntimeInputType::RunAction;
    input.verb_id = verb_id;
    input.object_ids = object_ids;
    auto result = m_host.apply_input(input);
    if (result.handled) {
        capture_output_commands(result, m_captured_commands);
    }
    return result.handled;
}

bool RuntimePreviewSession::debug_set_variable(const std::string& variable_id,
                                               nlohmann::json value)
{
    if (!m_host.loaded() || variable_id.empty())
        return false;
    m_host.session().set_property(variable_id, std::move(value));
    m_host.refresh_interactions();
    return true;
}

bool RuntimePreviewSession::debug_reset_variable(const std::string& variable_id)
{
    if (!m_host.loaded() || variable_id.empty())
        return false;
    m_host.session().unset_property(variable_id);
    m_host.refresh_interactions();
    return true;
}

bool RuntimePreviewSession::debug_give_object(const std::string& object_id)
{
    if (!m_host.loaded() || object_id.empty())
        return false;
    const auto* project = m_host.session().project();
    if (!project || !project->objects().contains(object_id))
        return false;
    m_host.session().set_object_location(object_id,
                                         EntityRef{EntityType::CustomScript,
                                                   std::string(project_ids::player)});
    m_host.refresh_interactions();
    return true;
}

bool RuntimePreviewSession::debug_remove_inventory_object(const std::string& object_id)
{
    if (!m_host.loaded() || object_id.empty())
        return false;
    const auto* project = m_host.session().project();
    if (!project || !project->objects().contains(object_id))
        return false;
    m_host.session().set_object_location(
        object_id, EntityRef{EntityType::CustomScript, "__debug_removed"});
    m_host.refresh_interactions();
    return true;
}

bool RuntimePreviewSession::debug_teleport_room(const std::string& room_id)
{
    if (!m_host.loaded() || room_id.empty())
        return false;
    const auto* project = m_host.session().project();
    if (!project || !project->rooms().contains(room_id))
        return false;
    auto result = m_host.start_room(room_id);
    if (result.handled) {
        capture_output_commands(result, m_captured_commands);
    }
    return result.handled;
}

} // namespace noveltea::core::editor
