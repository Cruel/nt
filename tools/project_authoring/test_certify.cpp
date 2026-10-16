#include "room_session.hpp"
#include "test_semantics.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using namespace noveltea::authoring;
using Json = jsoncons::ojson;

void require(bool condition, std::string_view message)
{
    if (!condition)
        throw std::runtime_error(std::string(message));
}

bool has(const std::vector<Diagnostic>& diagnostics, std::string_view path,
         std::string_view code = {})
{
    for (const auto& diagnostic : diagnostics)
        if (diagnostic.path == path && (code.empty() || diagnostic.code == code))
            return true;
    return false;
}

struct Fixture {
    std::filesystem::path path;
    explicit Fixture(const std::filesystem::path& original)
    {
        path = std::filesystem::temp_directory_path() /
               ("noveltea-native-tests-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(original, path, std::filesystem::copy_options::recursive);
    }
    ~Fixture()
    {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

void certify(const std::filesystem::path& original)
{
    Fixture fixture(original);
    std::string error;
    auto test = RoomSession::open_record(fixture.path, "tests", "verbs-and-offers-flow", error);
    if (test && !test->snapshot().valid)
        for (const auto& diagnostic : test->snapshot().diagnostics)
            std::cerr << diagnostic.path << " " << diagnostic.code << ": " << diagnostic.message
                      << '\n';
    require(test && test->snapshot().valid, "Feature Lab Test must normalize: " + error);
    const auto missing_authored_field = test->patch(
        test->snapshot().working_revision,
        {{RoomPatch::Operation::Remove, "/data/steps/0/expectations/0/currentRoom/roomId", ""}});
    require(missing_authored_field.accepted && !missing_authored_field.snapshot.valid &&
                has(missing_authored_field.snapshot.diagnostics,
                    "/data/steps/0/expectations/0/currentRoom/roomId", "source.test.required"),
            "An omitted authored Test target must not be supplied from editor-form defaults");
    const auto restored_source =
        test->patch(missing_authored_field.snapshot.working_revision,
                    {{RoomPatch::Operation::Add, "/data/steps/0/expectations/0/currentRoom/roomId",
                      "\"feature-lab-home\""}});
    require(restored_source.accepted && restored_source.snapshot.valid,
            "Restoring explicit source intent must restore Test normalization");
    auto project = ProjectSession::open(fixture.path, error);
    require(project != nullptr, "Feature Lab Project must open: " + error);
    const auto inspected = project->inspect_record("tests/verbs-and-offers-flow");
    require(inspected.accepted && inspected.snapshot.valid,
            "Test must validate through the native Project session");

    const auto normalized = Json::parse(test->snapshot().normalized_json);
    auto duplicate = normalized;
    duplicate.at("data").at("steps").at(1).at("id") = "start";
    auto local = validate_test_local(duplicate.to_string());
    require(!local.accepted &&
                has(local.diagnostics, "/data/steps/1/id", "authoring.test.duplicate-id"),
            "Duplicate step IDs must be attributed to their indexed owner");
    auto expectation = normalized;
    expectation.at("data").at("steps").at(0).at("expectations").at(0).at("operator") = "gt";
    local = validate_test_local(expectation.to_string());
    require(!local.accepted && has(local.diagnostics, "/data/steps/0/expectations/0/operator",
                                   "authoring.test.operator"),
            "Incompatible expectation operators must fail before playback");
    auto empty = normalized;
    empty.at("data").at("steps") = Json::array();
    local = validate_test_local(empty.to_string());
    require(!local.accepted && has(local.diagnostics, "/data/steps"),
            "An empty Test must be locally invalid");
    auto slot = normalized;
    slot.at("data").at("steps").at(0).at("input") = "save";
    slot.at("data").at("steps").at(0).at("saveSlot").at("slotId") = "manual-0";
    local = validate_test_local(slot.to_string());
    require(!local.accepted && has(local.diagnostics, "/data/steps/0/saveSlot/slotId"),
            "Native authored save slot validation must reject transport slot names");
    auto click = normalized;
    click.at("data").at("steps").at(0).at("input") = "ui-click";
    click.at("data").at("steps").at(0).at("uiClick").at("mountInstanceId") = "instance";
    local = validate_test_local(click.to_string());
    require(!local.accepted && has(local.diagnostics, "/data/steps/0/uiClick"),
            "UI address must select exactly one document or mount instance");

    auto missing_room = project->patch(
        inspected.snapshot.working_revision,
        {{RoomPatch::Operation::Replace,
          "/tests/verbs-and-offers-flow/data/steps/0/expectations/0/currentRoom/roomId",
          "\"does-not-exist\""}});
    require(missing_room.accepted && !missing_room.snapshot.valid &&
                has(missing_room.snapshot.diagnostics,
                    "/tests/verbs-and-offers-flow/data/steps/0/expectations/0/currentRoom/roomId",
                    "authoring.test.reference-missing"),
            "Dirty Test references must identify Test owner and exact expectation path");
    require(!project
                 ->save_owners(missing_room.snapshot.working_revision,
                               {"tests/verbs-and-offers-flow"}, false,
                               TransactionDecision::UseEditDecisions)
                 .accepted,
            "Invalid Test source cannot be saved");
    auto repaired = project->patch(
        missing_room.snapshot.working_revision,
        {{RoomPatch::Operation::Replace,
          "/tests/verbs-and-offers-flow/data/steps/0/expectations/0/currentRoom/roomId",
          "\"feature-lab-home\""}});
    require(repaired.accepted && repaired.snapshot.valid,
            "Repairing a Test reference must restore native validation");
    auto changed = project->patch(
        repaired.snapshot.working_revision,
        {{RoomPatch::Operation::Replace, "/tests/verbs-and-offers-flow/data/displayName",
          "\"Native Test editing\""}});
    require(changed.accepted && changed.snapshot.valid, "Valid Test edit must remain savable");
    const auto saved =
        project->save_owners(changed.snapshot.working_revision, {"tests/verbs-and-offers-flow"},
                             false, TransactionDecision::UseEditDecisions);
    require(saved.accepted, "Native Test save failed: " + saved.error);
    auto reopened = ProjectSession::open(fixture.path, error);
    require(reopened && reopened->inspect_record("tests/verbs-and-offers-flow").accepted,
            "Saved Test must reopen through native Project session");
    const auto reopened_record = reopened->record_snapshots().at("tests/verbs-and-offers-flow");
    require(reopened_record.valid &&
                Json::parse(reopened_record.normalized_json).at("data").at("displayName") ==
                    "Native Test editing",
            "Test edits must persist across Save and reopen");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        if (argc == 4 && std::string_view(argv[1]) == "--normalized-record") {
            std::string error;
            auto test = RoomSession::open_record(argv[2], "tests", argv[3], error);
            require(test && test->snapshot().valid, "Cannot normalize authored Test: " + error);
            std::cout << test->snapshot().normalized_json << '\n';
            return 0;
        }
        require(argc == 2, "Pass the Feature Lab Project root");
        certify(argv[1]);
        std::cout << "Native authored Test certification passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
