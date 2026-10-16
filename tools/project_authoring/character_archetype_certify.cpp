#include "character_archetype_semantics.hpp"
#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>

namespace {
using namespace noveltea::authoring;
using Json = jsoncons::ojson;

void require(bool condition, std::string_view message)
{
    if (!condition)
        throw std::runtime_error(std::string(message));
}

bool has(const std::vector<Diagnostic>& diagnostics, std::string_view path)
{
    for (const auto& diagnostic : diagnostics)
        if (diagnostic.path == path)
            return true;
    return false;
}

std::string read(const std::filesystem::path& file)
{
    std::ifstream input(file, std::ios::binary);
    require(static_cast<bool>(input), "Cannot read fixture source");
    return {std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
}

struct TempProject {
    std::filesystem::path root;
    explicit TempProject(const std::filesystem::path& project)
    {
        root = std::filesystem::temp_directory_path() /
               ("nt-481-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(project, root, std::filesystem::copy_options::recursive);
    }
    ~TempProject()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};

void certify(const std::filesystem::path& fixture)
{
    TempProject project(fixture);
    const auto source_path = project.root / "records/characters/studio-guide.yaml";
    {
        std::ofstream annotated(source_path, std::ios::binary | std::ios::app);
        annotated << "\n# Character authored note: unchanged by source edits\n";
    }
    std::string error;
    auto character = RoomSession::open_record(project.root, "characters", "studio-guide", error);
    require(character != nullptr, error);
    const auto baseline = character->snapshot();
    require(baseline.valid, "Sparse Character fixture is normalized by native Zod contract");
    const auto normalized = Json::parse(baseline.normalized_json);
    const auto& layer =
        normalized.at("data").at("profiles").at(0).at("poses").at(0).at("layers").at(1);
    require(layer.at("offset").at("x") == 0 && layer.at("offset").at("y") == -450 &&
                layer.at("anchor").at("x") == 0.5 && layer.at("scale") == 0.18,
            "Nested Character composition normalizes omitted vector components without changing "
            "authored overrides");
    require(normalized.at("data").at("kind") == "character" &&
                Json::parse(baseline.source_json).at("data").contains("kind") == false,
            "Character kind is effective only and never authored");
    const auto before = read(source_path);
    auto edited = character->patch(
        baseline.working_revision,
        {{RoomPatch::Operation::Replace, "/data/displayName", "\"Altered guide\""},
         {RoomPatch::Operation::Replace, "/data/profiles/0/poses/0/layers/1/scale", "0.25"}});
    require(edited.accepted && edited.snapshot.valid && edited.snapshot.dirty &&
                read(source_path) == before,
            "Character nested edits are atomic and remain dirty until Save");
    const auto saved = character->save(baseline.disk_source_revision);
    require(saved.accepted && saved.snapshot.valid && !saved.snapshot.dirty,
            "Character nested modifications persist transactionally");
    const auto after = read(source_path);
    auto expected_source = Json::parse(baseline.source_json);
    expected_source.at("data").at("displayName") = "Altered guide";
    expected_source.at("data")
        .at("profiles")
        .at(0)
        .at("poses")
        .at(0)
        .at("layers")
        .at(1)
        .at("scale") = 0.25;
    const auto reopened_yaml = open_yaml_source(after);
    require(reopened_yaml.accepted && Json::parse(reopened_yaml.source_json) == expected_source,
            "Character nested Save changes the selected source without expanding defaults");
    require(after.find("# Character authored note: unchanged by source edits") != std::string::npos,
            "Character nested Save retains unrelated YAML comments");
    auto reopened = RoomSession::open_record(project.root, "characters", "studio-guide", error);
    require(reopened && reopened->snapshot().normalized_json == saved.snapshot.normalized_json,
            "Character Save/reopen preserves normalized effective values");
    auto invalid = reopened->patch(
        0, {{RoomPatch::Operation::Replace, "/data/defaults/profileId", "\"absent\""}});
    require(invalid.accepted && !invalid.snapshot.valid &&
                has(invalid.snapshot.diagnostics, "/data/defaults/profileId"),
            "Missing Character default profile produces exact local path");
    require(!reopened->save(saved.snapshot.disk_source_revision).accepted,
            "Invalid dirty Character source cannot publish to disk");
    auto repaired = reopened->patch(
        1, {{RoomPatch::Operation::Replace, "/data/defaults/profileId", "\"stage\""}});
    require(repaired.accepted && repaired.snapshot.valid,
            "Character local references recover without reopening");
    const auto duplicate = reopened->patch(
        2, {{RoomPatch::Operation::Replace, "/data/profiles/0/layers/1/id", "\"body\""}});
    require(duplicate.accepted && !duplicate.snapshot.valid &&
                has(duplicate.snapshot.diagnostics, "/data/profiles/0/layers/1/id"),
            "Duplicate Character semantic IDs are rejected at exact layer path");

    auto archetype =
        RoomSession::open_record(project.root, "archetypes", "runtime-workshop-character", error);
    require(archetype && archetype->snapshot().valid,
            "Sparse Archetype fixture defaults to null base");
    const auto archetype_value = Json::parse(archetype->snapshot().normalized_json);
    require(archetype_value.at("data").at("base").is_null() &&
                archetype_value.at("data").at("kind") == "archetype",
            "Archetype generated normalization applies base and inferred kind");
    const AuthoringRecordResolver resolve = [&](std::string_view family,
                                                std::string_view id) -> std::optional<std::string> {
        auto record =
            RoomSession::open_record(project.root, std::string(family), std::string(id), error);
        if (!record)
            return std::nullopt;
        const auto snapshot = record->snapshot();
        return snapshot.valid ? std::optional<std::string>{snapshot.normalized_json}
                              : character_reference_resource_source(family, snapshot.source_json,
                                                                    snapshot.diagnostics);
    };
    auto with_archetype = normalized;
    with_archetype["archetype"] =
        Json::parse(R"({"$ref":{"collection":"archetypes","id":"runtime-workshop-character"}})");
    const auto effective =
        validate_archetype_owner("characters", with_archetype.to_string(), resolve);
    require(effective.accepted && !effective.effective_json.empty(),
            "Native Character owner resolves its Archetype from the tracked source");
    const auto flattened = Json::parse(effective.effective_json);
    require(flattened.at("data").at("displayName") == "Runtime assistant" &&
                flattened.at("data").at("initialWorldState") ==
                    normalized.at("data").at("initialWorldState") &&
                flattened.at("defaultProperties").is_array(),
            "Archetype contributes defaults while Character world state remains local");
    auto broken = normalized;
    broken.at("data")
        .at("profiles")
        .at(0)
        .at("poses")
        .at(0)
        .at("layers")
        .at(1)
        .at("visual")
        .at("image")
        .at("$ref")
        .at("id") = "missing-image";
    const auto missing = validate_character_dependencies(broken.to_string(), resolve);
    require(!missing.accepted &&
                has(missing.diagnostics, "/data/profiles/0/poses/0/layers/1/visual/image/$ref"),
            "Missing Visual Image Asset is diagnosed through a scoped native source resolver");
    const auto a = archetype->patch(
        0, {{RoomPatch::Operation::Add, "/data/overrides/~1data~1initialWorldState", "{}"}});
    require(a.accepted && !a.snapshot.valid &&
                has(a.snapshot.diagnostics, "/data/overrides/~1data~1initialWorldState"),
            "Archetype cannot override Character-local initial world state");

    auto archetype_edit =
        RoomSession::open_record(project.root, "archetypes", "runtime-workshop-character", error);
    const auto archetype_before = archetype_edit->snapshot();
    const auto archetype_source =
        project.root / "records/archetypes/runtime-workshop-character.yaml";
    const auto archetype_yaml_before = read(archetype_source);
    const auto archetype_changed = archetype_edit->patch(
        0, {{RoomPatch::Operation::Replace, "/data/overrides/~1data~1displayName",
             "\"Runtime assistant (edited)\""}});
    require(archetype_changed.accepted && archetype_changed.snapshot.valid &&
                read(archetype_source) == archetype_yaml_before,
            "Nested Archetype override edit remains a working-only change");
    const auto archetype_saved = archetype_edit->save(archetype_before.disk_source_revision);
    auto archetype_reopened =
        RoomSession::open_record(project.root, "archetypes", "runtime-workshop-character", error);
    require(archetype_saved.accepted && archetype_reopened &&
                archetype_reopened->snapshot().normalized_json ==
                    archetype_saved.snapshot.normalized_json,
            "Archetype JSON Pointer override survives transactional Save/reopen");
    require(read(archetype_source).find("/data/dialogue/name:") != std::string::npos,
            "Archetype Save retains unrelated sparse override keys");

    auto session = ProjectSession::open(project.root, error);
    require(session != nullptr, error);
    require(session->inspect_record("characters/studio-guide").accepted,
            "Project session admits Character owner");
    require(session->inspect_record("archetypes/runtime-workshop-character").accepted,
            "Project session admits Archetype owner");
    require(!has(session->snapshot().diagnostics, "/archetypes/runtime-workshop-character/data"),
            "Valid Character Archetype resolves from generated starter configuration");
    require(session->snapshot().valid, "Existing Character and Archetype Feature Lab fixtures "
                                       "remain valid under native cross-record checks");
    const auto initial = session->snapshot();
    const auto bad_trait =
        session->patch(initial.working_revision,
                       {{RoomPatch::Operation::Add,
                         "/archetypes/runtime-workshop-character/data/overrides/~1traits",
                         "[\"missing-trait\"]"}});
    require(bad_trait.accepted && !bad_trait.snapshot.valid &&
                has(bad_trait.snapshot.diagnostics,
                    "/archetypes/runtime-workshop-character/data/effectiveConfiguration/traits/0"),
            "Inherited Archetype Trait references use Project declarations");
    const auto corrected_trait =
        session->patch(bad_trait.snapshot.working_revision,
                       {{RoomPatch::Operation::Replace,
                         "/archetypes/runtime-workshop-character/data/overrides/~1traits", "[]"}});
    require(corrected_trait.accepted && corrected_trait.snapshot.valid,
            "Repairing inherited Trait attachments restores valid working state");
    auto cycle = session->patch(
        corrected_trait.snapshot.working_revision,
        {{RoomPatch::Operation::Replace, "/archetypes/runtime-workshop-character/data/base",
          "\"runtime-workshop-character\""}});
    require(cycle.accepted && !cycle.snapshot.valid &&
                has(cycle.snapshot.diagnostics, "/archetypes/runtime-workshop-character/data"),
            "Archetype inheritance cycles are diagnosed in native Project working session");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        require(argc == 2, "Expected Feature Lab fixture path");
        certify(argv[1]);
        std::cout << "Native Character and Archetype certification passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
