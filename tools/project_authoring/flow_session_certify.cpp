#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>

namespace {
using Json = jsoncons::ojson;
using namespace noveltea::authoring;

void require(bool condition, std::string_view reason)
{
    if (!condition)
        throw std::runtime_error(std::string(reason));
}

std::string read(const std::filesystem::path& file)
{
    std::ifstream input(file, std::ios::binary);
    require(static_cast<bool>(input), "Missing Feature Lab Room fixture");
    return {std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
}

void write(const std::filesystem::path& file, std::string_view text)
{
    std::ofstream output(file, std::ios::binary | std::ios::trunc);
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
    require(static_cast<bool>(output), "Cannot write Room fixture");
}

struct Fixture {
    std::filesystem::path root;
    std::filesystem::path source;

    explicit Fixture(const std::filesystem::path& feature_lab)
    {
        root = std::filesystem::temp_directory_path() /
               ("noveltea-flow-session-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        source = root / "records" / "rooms" / "room-lifecycle-start.yaml";
        std::filesystem::create_directories(source.parent_path());
        std::filesystem::copy_file(feature_lab / "records/rooms/room-lifecycle-start.yaml", source);
        auto authored = read(source);
        constexpr std::string_view original = "    afterLeave:\n"
                                              "      - id: after-leave-program\n"
                                              "        kind: notify\n"
                                              "        message:\n"
                                              "          source:\n"
                                              "            kind: inline\n"
                                              "            text: Program after-leave ran.\n"
                                              "          markup: plain\n";
        constexpr std::string_view recursive = "    afterLeave:\n"
                                               "      - id: after-leave-program\n"
                                               "        kind: if\n"
                                               "        condition:\n"
                                               "          kind: all\n"
                                               "          conditions:\n"
                                               "            - kind: not\n"
                                               "              condition: always\n"
                                               "            - kind: always\n"
                                               "        then:\n"
                                               "          - id: nested-note\n"
                                               "            kind: notify\n"
                                               "            message:\n"
                                               "              source:\n"
                                               "                kind: inline\n"
                                               "                text: Nested command ran\n"
                                               "              markup: plain\n"
                                               "          - id: transfer-for-certification\n"
                                               "            kind: transfer-quantity\n"
                                               "            mode: aggregate\n"
                                               "            matcher:\n"
                                               "              definition: item-a\n"
                                               "            quantity: 1\n"
                                               "            location:\n"
                                               "              kind: unplaced\n"
                                               "        else: []\n";
        const auto at = authored.find(original);
        require(at != std::string::npos, "Feature Lab lifecycle program fixture changed");
        authored.replace(at, original.size(), recursive);
        write(source, "# nested Gameplay Command test note\n" + authored);
    }

    ~Fixture()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};

bool has_diagnostic(const std::vector<Diagnostic>& diagnostics, std::string_view path,
                    std::string_view code = {})
{
    for (const auto& diagnostic : diagnostics)
        if (diagnostic.path == path && (code.empty() || diagnostic.code == code))
            return true;
    return false;
}

void certify(const std::filesystem::path& project)
{
    Fixture fixture(project);
    std::string error;
    auto room = RoomSession::open(fixture.root, "room-lifecycle-start", error);
    require(room != nullptr, error);
    const auto baseline = room->snapshot();
    require(baseline.valid, "Initial Feature Lab Room is valid with native Flow schema");
    const auto original = read(fixture.source);

    // The authored fixture contains a recursive `if` program. Change a nested
    // logical field without causing a wholesale multi-line YAML replacement.
    const auto changed = room->patch(
        baseline.working_revision,
        {{RoomPatch::Operation::Replace, "/data/lifecycle/afterLeave/0/then/0/message/source/text",
          "\"Nested command changed\""}});
    require(changed.accepted && changed.snapshot.valid && changed.snapshot.dirty,
            "A real Room accepts nested recursive Gameplay Command edits");
    require(read(fixture.source) == original, "Edits cannot publish before Save");
    const auto normalized = Json::parse(changed.snapshot.normalized_json);
    const auto& program = normalized.at("data").at("lifecycle").at("afterLeave").at(0);
    require(program.at("condition").at("conditions").at(0).at("condition").at("kind") == "always" &&
                program.at("then").at(0).at("message").at("source").at("text") ==
                    "Nested command changed",
            "Nested tagged Conditions and commands survive native normalization");
    const auto& transfer = program.at("then").at(1);
    require(transfer.at("kind") == "transfer-quantity" && transfer.at("mode") == "aggregate" &&
                transfer.at("matcher").at("definition").at("$ref").at("collection") ==
                    "interactables" &&
                transfer.at("matcher").at("traits") == Json::array(),
            "Sparse nested command mode selects the correct union branch and reference defaults");

    const auto invalid =
        room->patch(changed.snapshot.working_revision,
                    {{RoomPatch::Operation::Replace,
                      "/data/lifecycle/afterLeave/0/then/0/message/source/text", "123"}});
    require(invalid.accepted && !invalid.snapshot.valid &&
                has_diagnostic(invalid.snapshot.diagnostics,
                               "/data/lifecycle/afterLeave/0/then/0/message/source/text",
                               "schema.type"),
            "A malformed deeply nested command reports the specific logical field");
    require(!room->save(baseline.disk_source_revision).accepted && read(fixture.source) == original,
            "Invalid nested Flow edits never reach the physical source");

    const auto restored = room->patch(
        invalid.snapshot.working_revision,
        {{RoomPatch::Operation::Replace, "/data/lifecycle/afterLeave/0/then/0/message/source/text",
          "\"Nested command changed\""}});
    require(restored.accepted && restored.snapshot.valid && !restored.diagnostics_removed.empty(),
            "Repairing nested Flow source removes its exact diagnostics");
    const auto saved = room->save(baseline.disk_source_revision);
    require(saved.accepted && saved.snapshot.valid && !saved.snapshot.dirty,
            "Nested Gameplay Command source saves through the native transaction boundary: " +
                saved.error);
    const auto on_disk = read(fixture.source);
    require(on_disk.starts_with("# nested Gameplay Command test note\n"),
            "Unrelated authored YAML comments survive nested Command Save");
    auto reopened = RoomSession::open(fixture.root, "room-lifecycle-start", error);
    require(reopened && reopened->snapshot().normalized_json == saved.snapshot.normalized_json,
            "Reopened Room reconstructs the exact same effective nested Flow program");
    const auto reopened_source = Json::parse(reopened->snapshot().source_json);
    require(reopened_source.at("data").at("lifecycle").at("afterLeave").at(0).at("kind") == "if" &&
                !reopened_source.at("data").contains("kind"),
            "Nested Flow Save does not expand unrelated sparse Record defaults");
}

void certify_project_owner(const std::filesystem::path& feature_lab)
{
    const auto root = std::filesystem::temp_directory_path() /
                      ("noveltea-flow-owner-" +
                       std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Cleanup {
        const std::filesystem::path& path;
        ~Cleanup()
        {
            std::error_code ignored;
            std::filesystem::remove_all(path, ignored);
        }
    } cleanup{root};
    std::filesystem::copy(feature_lab, root, std::filesystem::copy_options::recursive);
    std::string error;
    auto project = ProjectSession::open(root, error);
    require(project != nullptr, error);
    require(project->inspect_record("rooms/room-lifecycle-start").accepted,
            "Project session admits a real Room's authored Gameplay Commands");
    const auto baseline = project->snapshot();
    const auto failed = project->patch(
        baseline.working_revision,
        {{RoomPatch::Operation::Replace,
          "/rooms/room-lifecycle-start/data/lifecycle/afterLeave/0/message/source/text", "17"}});
    require(failed.accepted && !failed.snapshot.valid &&
                has_diagnostic(
                    failed.snapshot.diagnostics,
                    "/rooms/room-lifecycle-start/data/lifecycle/afterLeave/0/message/source/text",
                    "schema.type") &&
                has_diagnostic(
                    failed.diagnostics_added,
                    "/rooms/room-lifecycle-start/data/lifecycle/afterLeave/0/message/source/text",
                    "schema.type"),
            "Project-wide revisions and diagnostic deltas retain exact Room owner and nested path");
    const auto repaired = project->patch(
        failed.snapshot.working_revision,
        {{RoomPatch::Operation::Replace,
          "/rooms/room-lifecycle-start/data/lifecycle/afterLeave/0/message/source/text",
          "\"Program after-leave ran.\""}});
    require(repaired.accepted && repaired.snapshot.valid &&
                has_diagnostic(
                    repaired.diagnostics_removed,
                    "/rooms/room-lifecycle-start/data/lifecycle/afterLeave/0/message/source/text"),
            "Native Project owner diagnostics recover when a nested Gameplay Command is repaired");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        require(argc == 2, "Expected Feature Lab fixture path");
        certify(argv[1]);
        certify_project_owner(argv[1]);
        std::cout << "Native Flow Project-record certification passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
