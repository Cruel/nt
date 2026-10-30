#include "tooling_native_c.h"
#include "../../tools/editor_tool/tooling_native_project_localization.hpp"
#include "../../tools/editor_tool/tooling_native_project_bundle.hpp"
#include "../../tools/project_authoring/room_session.hpp"

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

Json disk_validate(const std::filesystem::path& project_root, std::string action = "validate",
                   Json fields = Json::object())
{
    const bool command =
        action == "project-validate" || action == "validation-source-generation-proof";
    fields["projectRoot"] = project_root.string();
    fields["action"] = std::move(action);
    const auto text = fields.dump();
    std::vector<std::uint8_t> bytes(16 * 1024 * 1024);
    // The native operation is stateful. A size probe followed by execution
    // would consume cold authority and incorrectly turn one invocation warm.
    const auto invoke = command ? noveltea_tooling_native_project_commands_json
                                : noveltea_tooling_native_disk_project_validation_json;
    const auto count = invoke(reinterpret_cast<const std::uint8_t*>(text.data()), text.size(),
                              bytes.data(), bytes.size());
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

TEST_CASE("validation final proof reuses admission and rejects intervening disk changes",
          "[native-disk-validation]")
{
    Copy project;
    const auto room = project.root / "records/rooms/feature-lab-home.yaml";
    const auto original = read(room);
    const auto cold =
        disk_validate(project.root, "project-validate", {{"includeFontCoverageInputs", true}});
    REQUIRE(cold["valid"] == true);
    auto edited = original;
    const auto label = edited.find("label: Feature Lab Home");
    REQUIRE(label != std::string::npos);
    edited.replace(label, std::string("label: Feature Lab Home").size(), "label: Edited Home");
    write(room, edited);
    const auto changed =
        disk_validate(project.root, "project-validate", {{"includeFontCoverageInputs", true}});
    REQUIRE(changed["valid"] == true);
    REQUIRE(changed["warm"] == true);
    REQUIRE(changed["work"]["sessionAdmissions"] == cold["work"]["sessionAdmissions"]);
    REQUIRE(changed["work"]["recheckedRecords"] == 1);
    // An unrelated label edit must not admit a fresh Project or recursively
    // multiply source scans through nested full Project preparation.
    REQUIRE(changed["work"]["sourceCaptures"].get<std::uint64_t>() <= 5);
    REQUIRE(changed["fontCoverageInputs"] == cold["fontCoverageInputs"]);
    REQUIRE(changed["materialCompilerPrograms"] == cold["materialCompilerPrograms"]);
    REQUIRE(changed["materialEffectiveInputs"] == cold["materialEffectiveInputs"]);
    const auto proof = [&]() {
        return disk_validate(project.root, "validation-source-generation-proof",
                             {{"expectedSourceGeneration", changed.at("sourceGeneration")}});
    };
    const auto current = proof();
    REQUIRE(current["ok"] == true);
    REQUIRE(current["sessionAdmissions"] == cold["work"]["sessionAdmissions"]);

    SECTION("same size Asset edit with restored timestamp")
    {
        const auto asset = project.root / "assets/images/ui-pattern.png";
        auto bytes = read(asset);
        REQUIRE(!bytes.empty());
        const auto time = std::filesystem::last_write_time(asset);
        bytes.back() ^= 1;
        write(asset, bytes);
        std::filesystem::last_write_time(asset, time);
    }
    SECTION("changed valid record") { write(room, original); }
    SECTION("invalid record") { write(room, "not: [valid\n"); }
    SECTION("removed record") { REQUIRE(std::filesystem::remove(room)); }
    SECTION("added record")
    {
        write(project.root / "records/rooms/added.yaml", "id: added\nlabel: Added\n");
    }
    SECTION("pending transaction")
    {
        std::filesystem::create_directories(project.root / ".noveltea/transactions/pending");
    }
    SECTION("external Asset directory symlink with identical bytes")
    {
        std::filesystem::remove_all(project.root / "assets/images");
        std::filesystem::create_directory_symlink(std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                                                      "tests/projects/feature-lab/assets/images",
                                                  project.root / "assets/images");
    }
    SECTION("external symlink")
    {
        REQUIRE(std::filesystem::remove(room));
        std::filesystem::create_symlink(
            std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                "tests/projects/feature-lab/records/rooms/feature-lab-home.yaml",
            room);
    }
    REQUIRE(proof()["ok"] == false);
}

TEST_CASE("same-size binary Asset edits cannot reuse exact generation evidence",
          "[native-disk-validation]")
{
    Copy project;
    const auto first = disk_validate(project.root, "project-validate");
    REQUIRE(first["ok"] == true);
    REQUIRE(first["valid"] == true);
    const auto generation = first.at("sourceGeneration");

    const auto asset = project.root / "assets/images/ui-pattern.png";
    const auto modified = std::filesystem::last_write_time(asset);
    auto contents = read(asset);
    REQUIRE(!contents.empty());
    contents.back() ^= 1;
    write(asset, contents);
    std::filesystem::last_write_time(asset, modified);

    const auto changed = disk_validate(project.root, "project-validate");
    REQUIRE(changed["ok"] == true);
    REQUIRE(changed["valid"] == true);
    REQUIRE(changed["sourceGeneration"] != generation);
    REQUIRE(disk_validate(project.root, "validation-source-generation-proof",
                          {{"expectedSourceGeneration", generation}})["ok"] == false);
}

TEST_CASE("portable validation checks source paths without exporting unused revision maps",
          "[native-disk-validation]")
{
    Copy project;
    std::string error;
    auto session = noveltea::authoring::ProjectSession::open(project.root, error);
    REQUIRE(session != nullptr);
    REQUIRE(session->validate_project().valid);
    const auto prepared =
        session->prepare_complete_working(session->snapshot().working_revision, {}, true);
    REQUIRE(prepared.accepted);
    const auto admitted = Json::parse(prepared.complete_project_json);
    const auto check = [&] {
        return native_project_bundle(
            {{"action", "validation-source-check"}, {"admittedProject", admitted}}, session.get(),
            project.root);
    };
    const auto valid = check();
    REQUIRE(valid.value("ok", false));
    REQUIRE_FALSE(valid.contains("sourceRevisions"));
    REQUIRE_FALSE(valid.contains("sourcePaths"));
    REQUIRE_FALSE(valid.contains("project"));
    const auto pinned = native_project_bundle(
        {{"action", "test-source-preparation"}, {"admittedProject", admitted}}, session.get(),
        project.root);
    REQUIRE(pinned.value("ok", false));
    REQUIRE(pinned.contains("sourceRevisions"));
    REQUIRE(pinned.at("sourceRevisions").contains("project.yaml"));

    REQUIRE(std::filesystem::remove(project.root / "records/rooms/feature-lab-home.yaml"));
    REQUIRE_FALSE(check().value("ok", false));
}

TEST_CASE("localization projections reuse unchanged records and refresh changed Message inputs",
          "[native-disk-validation]")
{
    Copy project;
    std::string error;
    auto session = noveltea::authoring::ProjectSession::open(project.root, error);
    REQUIRE(session != nullptr);
    REQUIRE(session->validate_project().valid);
    const Json request{{"locale", "fr"}};
    const auto initial = native_project_localization_view(request, *session, true);
    REQUIRE(initial.value("ok", false));
    REQUIRE(native_project_localization_view(request, *session, true) == initial);
    REQUIRE(session->localization_record_cache_hits() >= 200);
    REQUIRE(session->localization_source_path_cache_hits() >= 200);

    const auto room = project.root / "records/rooms/feature-lab-home.yaml";
    auto contents = read(room);
    const auto original_label = contents.find("label: Feature Lab Home");
    REQUIRE(original_label != std::string::npos);
    contents.replace(original_label, std::string("label: Feature Lab Home").size(),
                     "label: Localization Cache Probe");
    write(room, contents);
    REQUIRE(session->validate_project().valid);
    const auto hits = session->localization_record_cache_hits();
    const auto unchanged = native_project_localization_view(request, *session, true);
    REQUIRE(unchanged == initial);
    REQUIRE(session->localization_record_cache_hits() >= hits + 200);

    const auto previous_key = contents.find("key: feature_lab.empty");
    REQUIRE(previous_key != std::string::npos);
    contents.replace(previous_key, std::string("key: feature_lab.empty").size(), "key: lab.sample");
    write(room, contents);
    REQUIRE(session->validate_project().valid);
    const auto changed = native_project_localization_view(request, *session, true);
    REQUIRE(changed.value("ok", false));
    REQUIRE(changed != initial);

    // A fresh Project must produce the identical projection, not a stale
    // cached usage/fingerprint from before the record's localization edit.
    auto fresh = noveltea::authoring::ProjectSession::open(project.root, error);
    REQUIRE(fresh != nullptr);
    REQUIRE(fresh->validate_project().valid);
    REQUIRE(native_project_localization_view(request, *fresh, true) == changed);

    const auto& lua = session->localization_inline_analysis(
        "inline/rooms/cache-probe/data/source.lua", "Text.msg('lab.read')");
    const auto lua_revision = lua.source_revision;
    REQUIRE(&lua == &session->localization_inline_analysis(
                        "inline/rooms/cache-probe/data/source.lua", "Text.msg('lab.read')"));
    REQUIRE(session
                ->localization_inline_analysis("inline/rooms/cache-probe/data/source.lua",
                                               "Text.msg('lab.sample')")
                .source_revision != lua_revision);
}
