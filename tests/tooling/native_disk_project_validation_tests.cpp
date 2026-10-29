#include "tooling_native_c.h"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {
using Json = nlohmann::json;

Json disk_validate(const std::filesystem::path& project_root, std::string action = "validate")
{
    const auto text =
        Json{{"projectRoot", project_root.string()}, {"action", std::move(action)}}.dump();
    std::vector<std::uint8_t> bytes(16 * 1024 * 1024);
    // The native operation is stateful. A size probe followed by execution
    // would consume cold authority and incorrectly turn one invocation warm.
    const auto count = noveltea_tooling_native_disk_project_validation_json(
        reinterpret_cast<const std::uint8_t*>(text.data()), text.size(), bytes.data(),
        bytes.size());
    REQUIRE(count > 0);
    REQUIRE(count <= bytes.size());
    return Json::parse(std::string(reinterpret_cast<const char*>(bytes.data()), count));
}

std::string read(const std::filesystem::path& path)
{
    std::ifstream stream(path, std::ios::binary);
    REQUIRE(stream.good());
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

void write(const std::filesystem::path& path, std::string_view data)
{
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    REQUIRE(stream.good());
    stream.write(data.data(), static_cast<std::streamsize>(data.size()));
    REQUIRE(stream.good());
}

struct Copy {
    std::filesystem::path root;
    Copy()
    {
        root = std::filesystem::temp_directory_path() /
               ("noveltea-native-disk-validation-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                                  "tests/projects/feature-lab",
                              root, std::filesystem::copy_options::recursive);
    }
    ~Copy()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};
} // namespace

TEST_CASE("native disk validation stays resident and proves edits without mutating YAML",
          "[native-disk-validation]")
{
    Copy project;
    const auto source = project.root / "scripts/notice-board.lua";
    const auto room = project.root / "records/rooms/room-lifecycle-roundtrip.yaml";
    const auto original_script = read(source);
    const auto original_room = read(room);
    const auto original_manifest = read(project.root / "project.yaml");

    const auto cold = disk_validate(project.root);
    REQUIRE(cold["ok"] == true);
    REQUIRE(cold["valid"] == true);
    REQUIRE(cold["warm"] == false);
    // Independently captured Feature Lab TypeScript CLI oracle: the compiler
    // publishes its AUTHORING_* identity as well as the author's source
    // diagnostic. Internal conditional-selector hints are not CLI findings.
    REQUIRE(cold["cliDiagnostics"].size() == 2);
    REQUIRE(cold["cliDiagnostics"][0]["code"] == "AUTHORING_HOTSPOT_AUTHORING_TARGET_NONE");
    REQUIRE(cold["cliDiagnostics"][1]["code"] == "hotspot.authoring.target.none");
    for (const auto& diagnostic : cold["cliDiagnostics"]) {
        REQUIRE(diagnostic["severity"] == "info");
        REQUIRE(diagnostic["path"] ==
                "/interactables/custom-board/data/presentation/hotspots/hotspots/5/target");
        REQUIRE(diagnostic["sourceUrl"] == "project:/records/interactables/custom-board.yaml");
        REQUIRE(diagnostic["line"] == 159);
        REQUIRE(diagnostic["column"] == 13);
    }
    const auto warm = disk_validate(project.root / ".");
    REQUIRE(warm["ok"] == true);
    REQUIRE(warm["valid"] == true);
    REQUIRE(warm["warm"] == true);
    REQUIRE(warm["diagnostics"] == cold["diagnostics"]);
    REQUIRE(warm["cliDiagnostics"] == cold["cliDiagnostics"]);
    REQUIRE(warm["work"]["recheckedRecords"] == 0);
    REQUIRE(warm["work"]["retainedRecords"] > 0);

    // A change is observed by content revision even when no watcher event
    // is delivered to the request. The changed source cannot reuse the proof.
    write(source, original_script + "\nText.tr(dynamic)\n");
    const auto bad_lua = disk_validate(project.root);
    REQUIRE(bad_lua["ok"] == true);
    REQUIRE(bad_lua["valid"] == false);
    REQUIRE(bad_lua["warm"] == true);
    REQUIRE(bad_lua["work"]["recheckedRecords"] == 0);
    write(source, original_script);
    REQUIRE(disk_validate(project.root)["valid"] == true);

    write(room, "not: [valid\n");
    const auto invalid_yaml = disk_validate(project.root);
    REQUIRE(invalid_yaml["valid"] == false);
    bool attributed = false;
    for (const auto& diagnostic : invalid_yaml["diagnostics"])
        attributed |=
            diagnostic.value("sourcePath", "") == "records/rooms/room-lifecycle-roundtrip.yaml";
    REQUIRE(attributed);
    const auto repeated_invalid = disk_validate(project.root);
    REQUIRE(repeated_invalid["diagnostics"] == invalid_yaml["diagnostics"]);
    REQUIRE(repeated_invalid["work"]["recheckedRecords"] == 0);
    write(room, original_room);
    REQUIRE(disk_validate(project.root)["valid"] == true);
    REQUIRE(read(project.root / "project.yaml") == original_manifest);
    REQUIRE(read(room) == original_room);
    REQUIRE(read(source) == original_script);

    // Physical removal/recreation changes the authoritative source inventory,
    // rather than being an incremental in-place edit of a retained record.
    REQUIRE(std::filesystem::remove(room));
    const auto deleted_record = disk_validate(project.root);
    REQUIRE(deleted_record["ok"] == true);
    REQUIRE(deleted_record["warm"] == false);
    for (const auto& diagnostic : deleted_record["diagnostics"])
        REQUIRE(diagnostic.value("code", "") != "WORKSPACE_SOURCE_READ");
    write(room, original_room);
    const auto recreated_record = disk_validate(project.root);
    REQUIRE(recreated_record["ok"] == true);
    REQUIRE(recreated_record["warm"] == false);

    REQUIRE(disk_validate(project.root, "release")["ok"] == true);
    const auto restarted = disk_validate(project.root);
    REQUIRE(restarted["ok"] == true);
    REQUIRE(restarted["warm"] == false);
    REQUIRE(restarted["valid"] == true);
}
