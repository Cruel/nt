#include "room_session.hpp"
#include "dialogue_scene_semantics.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>

namespace {
using namespace noveltea::authoring;
using Json = jsoncons::ojson;

void require(bool ok, std::string_view message)
{
    if (!ok)
        throw std::runtime_error(std::string(message));
}

std::string read(const std::filesystem::path& path)
{
    std::ifstream stream(path, std::ios::binary);
    require(static_cast<bool>(stream), "Cannot read Project fixture");
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

void write(const std::filesystem::path& path, std::string_view contents)
{
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    stream.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    require(static_cast<bool>(stream), "Cannot write Project fixture");
}

struct Fixture {
    std::filesystem::path path;
    explicit Fixture(const std::filesystem::path& source)
    {
        path = std::filesystem::temp_directory_path() /
               ("noveltea-dialogue-scene-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(source, path, std::filesystem::copy_options::recursive);
    }
    ~Fixture()
    {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

bool has(const std::vector<Diagnostic>& values, std::string_view path, std::string_view code)
{
    for (const auto& value : values)
        if (value.path == path && (code.empty() || value.code == code))
            return true;
    return false;
}

void certify(const std::filesystem::path& original)
{
    Fixture fixture(original);
    std::string error;
    auto material_scene =
        RoomSession::open_record(fixture.path, "scenes", "materials-engine2d", error);
    require(material_scene && material_scene->snapshot().valid,
            "Feature Lab Scene Material occurrence must normalize");
    const auto material_events =
        Json::parse(material_scene->snapshot().normalized_json).at("data").at("events");
    bool material_checked = false;
    for (std::size_t i = 0; i < material_events.size(); ++i) {
        if (material_events.at(i).at("type") != "material-parameter")
            continue;
        const auto path = "/data/events/" + std::to_string(i) + "/value";
        const auto invalid = material_scene->patch(material_scene->snapshot().working_revision,
                                                   {{RoomPatch::Operation::Replace, path, "null"}});
        require(invalid.accepted && !invalid.snapshot.valid &&
                    has(invalid.snapshot.diagnostics, path, "semantic.scene.material-value"),
                "Scene Material occurrence rejects null with its generated operation code");
        material_checked = true;
        break;
    }
    require(material_checked, "Feature Lab needs a Scene Material occurrence");
    auto command_scene =
        RoomSession::open_record(fixture.path, "scenes", "director-flow-child", error);
    require(command_scene && command_scene->snapshot().valid,
            "Feature Lab Scene Command source must normalize");
    auto commands_record = Json::parse(command_scene->snapshot().normalized_json);
    bool tested_batch = false;
    auto& commands_events = commands_record.at("data").at("events");
    for (std::size_t i = 0; i < commands_events.size(); ++i) {
        if (commands_events.at(i).at("type") != "gameplay-effect-batch")
            continue;
        commands_events.at(i).at("operations").at(0) =
            Json::parse(R"({"id":"illegal-script","kind":"run-lua","source":"return true"})");
        const auto invalid = validate_dialogue_scene_local("scenes", commands_record.to_string());
        require(!invalid.accepted && has(invalid.diagnostics,
                                         "/data/events/" + std::to_string(i) + "/operations/0/kind",
                                         "scene.command.forbidden"),
                "Scene effect batches cannot execute Run Lua Gameplay Commands");
        tested_batch = true;
        break;
    }
    require(tested_batch, "Feature Lab needs a Scene effect batch");
    auto wait_scene = RoomSession::open_record(fixture.path, "scenes", "director-waits", error);
    require(wait_scene && wait_scene->snapshot().valid,
            "Feature Lab Scene wait variants must normalize");
    const auto wait_events =
        Json::parse(wait_scene->snapshot().normalized_json).at("data").at("events");
    bool tested_wait = false;
    for (std::size_t i = 0; i < wait_events.size(); ++i) {
        if (wait_events.at(i).at("type") != "wait")
            continue;
        const auto path = "/data/events/" + std::to_string(i) + "/waitKind";
        const auto invalid =
            wait_scene->patch(wait_scene->snapshot().working_revision,
                              {{RoomPatch::Operation::Replace, path, "\"invalid-wait-kind\""}});
        require(invalid.accepted && !invalid.snapshot.valid &&
                    has(invalid.snapshot.diagnostics, path, "schema.discriminator"),
                "Nested Scene wait discriminator errors must report the exact logical field");
        tested_wait = true;
        break;
    }
    require(tested_wait, "Feature Lab needs a tagged Scene wait variant");
    auto project = ProjectSession::open(fixture.path, error);
    require(project != nullptr, error);
    for (const auto& record : {"dialogues/conversation-paths", "scenes/director-input-child",
                               "scenes/director-flow-child", "scenes/layout-counter"}) {
        const auto inspected = project->inspect_record(record);
        require(inspected.accepted && inspected.snapshot.valid,
                "Feature Lab authored Dialogue/Scene failed admission: " + inspected.error);
    }
    const auto baseline = project->snapshot();
    require(baseline.valid, "Native Dialogue/Scene Project snapshot must be valid");

    const auto dialogue = fixture.path / "records/dialogues/conversation-paths.yaml";
    const auto scene = fixture.path / "records/scenes/director-input-child.yaml";
    const auto prior_dialogue = read(dialogue);
    const auto prior_scene = read(scene);
    const auto update = [&](const std::string& path, std::string_view value) {
        const auto changed =
            project->patch(project->snapshot().working_revision,
                           {{RoomPatch::Operation::Replace, path, std::string(value)}});
        require(changed.accepted, "Failed patch " + path + ": " + changed.error);
        return changed;
    };
    const auto invalid_at = [&](const RoomSessionResult& edited, std::string_view path,
                                std::string_view code) {
        if (!has(edited.snapshot.diagnostics, path, code))
            for (const auto& diagnostic : edited.snapshot.diagnostics)
                std::cerr << diagnostic.path << " " << diagnostic.code << ' ' << diagnostic.message
                          << '\n';
        require(!edited.snapshot.valid && has(edited.snapshot.diagnostics, path, code),
                "Expected precise native Flow diagnostic");
    };
    const auto changed =
        update("/dialogues/conversation-paths/data/entryBlockId", "\"missing-block\"");
    require(!changed.snapshot.valid && has(changed.snapshot.diagnostics,
                                           "/dialogues/conversation-paths/data/entryBlockId", ""),
            "Dialogue entry-block corruption must be diagnosed with its logical owner");
    require(!project
                 ->save_owners(changed.snapshot.working_revision, {"dialogues/conversation-paths"},
                               false, TransactionDecision::UseEditDecisions)
                 .accepted,
            "Invalid Dialogue may not be persisted");
    const auto original_record =
        RoomSession::open_record(fixture.path, "dialogues", "conversation-paths", error);
    require(original_record != nullptr, error);
    const auto entry = Json::parse(original_record->snapshot().baseline_json)
                           .at("data")
                           .at("entryBlockId")
                           .as<std::string>();
    const auto repaired =
        update("/dialogues/conversation-paths/data/entryBlockId", Json(entry).to_string());
    require(repaired.snapshot.valid, "Restored Dialogue must be valid");

    const auto edge = Json::parse(original_record->snapshot().normalized_json)
                          .at("data")
                          .at("edges")
                          .at(0)
                          .at("toBlockId")
                          .to_string();
    auto malformed =
        update("/dialogues/conversation-paths/data/edges/0/toBlockId", "\"no-such-target\"");
    invalid_at(malformed, "/dialogues/conversation-paths/data/edges/0/toBlockId",
               "dialogue.edge.target-missing");
    require(update("/dialogues/conversation-paths/data/edges/0/toBlockId", edge).snapshot.valid,
            "Restoring Dialogue graph edge removes diagnostic");

    malformed =
        update("/scenes/director-input-child/data/terminal/outcome", "\"undeclared-outcome\"");
    invalid_at(malformed, "/scenes/director-input-child/data/terminal/outcome",
               "scene.outcome.missing");
    require(update("/scenes/director-input-child/data/terminal/outcome", "\"done\"").snapshot.valid,
            "Scene terminal must reference a declared Outcome");

    malformed =
        update("/scenes/director-flow-child/data/events/0/inputs/0/value", "\"not-a-boolean\"");
    invalid_at(malformed, "/scenes/director-flow-child/data/events/0/inputs/0/value",
               "scene.input.type-mismatch");
    require(!project
                 ->save_owners(malformed.snapshot.working_revision, {"scenes/director-flow-child"},
                               false, TransactionDecision::UseEditDecisions)
                 .accepted,
            "Invalid cross-record Scene input binding cannot be saved");
    require(
        update("/scenes/director-flow-child/data/events/0/inputs/0/value", "false").snapshot.valid,
        "Restoring typed Scene binding repairs reference diagnostic");

    malformed = update("/scenes/director-input-child/data/inputs/0/id", "\"renamed-input\"");
    invalid_at(malformed, "/scenes/director-flow-child/data/events/0/inputs/0/inputId",
               "scene.input.undeclared");
    require(!project
                 ->save_owners(malformed.snapshot.working_revision, {"scenes/director-input-child"},
                               false, TransactionDecision::UseEditDecisions)
                 .accepted,
            "Scene input declaration edits must respect inspected dependent callers");
    require(update("/scenes/director-input-child/data/inputs/0/id", "\"enabled\"").snapshot.valid,
            "Repaired Scene input declaration restores dependent caller");

    malformed = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Replace, "/scenes/director-flow-child/data/events/0/type",
          "\"start-detached-scene\""},
         {RoomPatch::Operation::Add, "/scenes/director-flow-child/data/events/0/owner",
          "\"runtime-session\""}});
    require(malformed.accepted, malformed.error);
    invalid_at(malformed, "/scenes/director-flow-child/data/events/0/scene",
               "scene.detached.unsafe");
    auto restored_detached = project->patch(
        malformed.snapshot.working_revision,
        {{RoomPatch::Operation::Remove, "/scenes/director-flow-child/data/events/0/owner", ""},
         {RoomPatch::Operation::Replace, "/scenes/director-flow-child/data/events/0/type",
          "\"call-scene\""}});
    require(restored_detached.accepted && restored_detached.snapshot.valid,
            "Restoring the foreground Scene call repairs unsafe detached ownership");

    const auto flow_source =
        RoomSession::open_record(fixture.path, "scenes", "director-flow-child", error);
    require(flow_source && flow_source->snapshot().valid,
            "Feature Lab Scene call graph must remain physically source-owned");
    const auto original_terminal =
        Json::parse(flow_source->snapshot().normalized_json).at("data").at("terminal").to_string();
    malformed = update(
        "/scenes/director-flow-child/data/terminal",
        R"({"kind":"continue-scene","scene":{"$ref":{"collection":"scenes","id":"director-flow-child"}},"inputs":[]})");
    invalid_at(malformed, "/scenes/director-flow-child/data/terminal", "scene.unconditional-cycle");
    require(update("/scenes/director-flow-child/data/terminal", original_terminal).snapshot.valid,
            "Restoring terminal eliminates unconditional Scene cycle");

    const auto initial_entrypoint = Json::parse(baseline.normalized_json).at("entrypoint");
    const auto contextual = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Replace, "/entrypoint/kind", "\"scene\""},
         {RoomPatch::Operation::Replace, "/entrypoint/id", "\"director-input-child\""}});
    require(contextual.accepted, "Native Project entrypoint patch failed");
    invalid_at(contextual, "/scenes/director-input-child/data/terminal",
               "scene.entrypoint.invalid-terminal");
    require(!project
                 ->save_owners(contextual.snapshot.working_revision, {"project"}, false,
                               TransactionDecision::UseEditDecisions)
                 .accepted,
            "Invalid Project-entrypoint Scene may not be saved through manifest ownership");
    const auto restored_entrypoint = project->patch(
        contextual.snapshot.working_revision, {{RoomPatch::Operation::Replace, "/entrypoint/kind",
                                                initial_entrypoint.at("kind").to_string()},
                                               {RoomPatch::Operation::Replace, "/entrypoint/id",
                                                initial_entrypoint.at("id").to_string()}});
    require(restored_entrypoint.accepted && restored_entrypoint.snapshot.valid,
            "Restoring the Project entrypoint removes Scene terminal diagnostics");

    const auto scene_edit =
        update("/scenes/director-input-child/data/inputs/0/label", "\"Renamed input label\"");
    require(scene_edit.snapshot.valid && read(scene) == prior_scene &&
                read(dialogue) == prior_dialogue,
            "Scene edit must remain working-only until Save");
    const auto saved =
        project->save_owners(scene_edit.snapshot.working_revision, {"scenes/director-input-child"},
                             false, TransactionDecision::UseEditDecisions);
    require(saved.accepted && saved.snapshot.valid && read(dialogue) == prior_dialogue &&
                read(scene) != prior_scene,
            "Scene Save must preserve independently owned Dialogue source");
    auto reopened = RoomSession::open_record(fixture.path, "scenes", "director-input-child", error);
    require(reopened && reopened->snapshot().valid &&
                Json::parse(reopened->snapshot().normalized_json)
                        .at("data")
                        .at("inputs")
                        .at(0)
                        .at("label") == "Renamed input label",
            "Scene Save must reopen to the same normalized authored value");
    const auto after = read(scene);
    require(project->save_owners(saved.snapshot.working_revision, {"scenes/director-input-child"},
                                 false, TransactionDecision::UseEditDecisions)
                    .accepted &&
                read(scene) == after,
            "No-op Scene Save must not rewrite source bytes");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        if (argc == 5 && std::string_view(argv[1]) == "--normalized") {
            std::string error;
            auto owner = RoomSession::open_record(argv[2], argv[3], argv[4], error);
            require(owner != nullptr, error);
            const auto normalized = owner->snapshot();
            if (!normalized.valid)
                for (const auto& issue : normalized.diagnostics)
                    std::cerr << issue.path << " " << issue.code << " " << issue.message << '\n';
            require(normalized.valid,
                    "Native normalization failed: " + std::string(argv[3]) + "/" + argv[4]);
            std::cout << normalized.normalized_json << '\n';
            return 0;
        }
        require(argc == 2, "Expected Feature Lab root or normalized record request");
        certify(argv[1]);
        std::cout << "Native Dialogue/Scene Project certification passed.\n";
    } catch (const std::exception& e) {
        std::cerr << "Native Dialogue/Scene certification failed: " << e.what() << '\n';
        return 1;
    }
}
