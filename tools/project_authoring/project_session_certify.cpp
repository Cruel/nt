#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
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

std::string read(const std::filesystem::path& path)
{
    std::ifstream in(path, std::ios::binary);
    require(static_cast<bool>(in), "Cannot read certification source");
    return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

void write(const std::filesystem::path& path, std::string_view source)
{
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << source;
    require(static_cast<bool>(out), "Cannot write certification source");
}

struct TemporaryProject {
    std::filesystem::path root;
    explicit TemporaryProject(const std::filesystem::path& fixture)
    {
        root = std::filesystem::temp_directory_path() /
               ("noveltea-project-session-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(fixture, root, std::filesystem::copy_options::recursive);
    }
    ~TemporaryProject()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};

Json roundtrip(const std::filesystem::path& fixture, bool verify)
{
    TemporaryProject temp(fixture);
    const auto file = temp.root / "project.yaml";
    std::filesystem::create_directories(temp.root / ".noveltea" / "editor");
    write(temp.root / ".noveltea" / "editor" / "state.json", "{}\n");
    std::filesystem::create_directories(temp.root / "workflows");
    write(temp.root / "workflows" / "sample.json", "{}\n");
    std::filesystem::create_directories(temp.root / "notes");
    write(temp.root / "notes" / "LICENSE.md", "Local author notice.\n");
    write(temp.root / "notes" / "scratch.txt", "Untracked note.\n");
    auto before = read(file);
    const auto notices = before.find("distributionNotices: []");
    require(notices != std::string::npos, "Fixture needs explicit distribution notices");
    before.replace(notices, std::strlen("distributionNotices: []"),
                   "distributionNotices:\n    - path: notes/LICENSE.md");
    const auto original = "  name: Feature Lab\n";
    const auto at = before.find(original);
    require(at != std::string::npos, "Cannot annotate source manifest");
    auto annotated = before;
    annotated.replace(at, std::strlen(original), "  name: Feature Lab # name note\n");
    write(file, "# project note\n" + annotated);

    std::string error;
    auto project = ProjectSession::open(temp.root, error);
    require(project != nullptr, "Project admission failed: " + error);
    const auto first = project->snapshot();
    require(first.valid && !first.dirty && first.diagnostics.empty(),
            "Canonical Project must admit with normalized data");
    require(Json::parse(first.normalized_json).at("schema") == "noveltea.project.workspace",
            "Current workspace-v1 schema retained");
    bool tracked = false, source = false, ignored = false, locale = false, notice = false,
         untracked = false;
    for (const auto& file_info : project->file_inventory()) {
        tracked |=
            file_info.path == "project.yaml" && file_info.kind == ProjectFileKind::TrackedSource;
        source |= file_info.path.starts_with("scripts/") &&
                  file_info.kind == ProjectFileKind::ProjectSource;
        ignored |= file_info.path == ".noveltea/editor/state.json" &&
                   file_info.kind == ProjectFileKind::IgnoredState;
        locale |= file_info.path.starts_with("i18n/locales/") &&
                  file_info.kind == ProjectFileKind::TrackedSource;
        notice |= file_info.path == "notes/LICENSE.md" &&
                  file_info.kind == ProjectFileKind::ProjectSource;
        untracked |= file_info.path == "notes/scratch.txt" &&
                     file_info.kind == ProjectFileKind::UntrackedFile;
    }
    require(tracked && source && ignored && locale && notice && untracked,
            "File inventory separates tracked, referenced, untracked and ignored source paths");
    const auto unchanged = read(file);
    const auto editor_before = read(temp.root / "editor.yaml");
    const auto room_before = read(temp.root / "records/rooms/room-lifecycle-roundtrip.yaml");
    const auto localization_before = read(temp.root / "i18n/project.yaml");
    const auto note_before = read(temp.root / "notes/LICENSE.md");
    const auto failed =
        project->patch(0, {{RoomPatch::Operation::Replace, "/project/name", "\"Bad\""},
                           {RoomPatch::Operation::Remove, "/missing", ""}});
    require(!failed.accepted && !project->snapshot().dirty,
            "Atomic mutation fails without partial working changes");
    const auto edited = project->patch(
        0, {{RoomPatch::Operation::Replace, "/project/name", "\"Native Project\""},
            {RoomPatch::Operation::Replace, "/settings/display/barColor", "\"#ffffff\""},
            {RoomPatch::Operation::Replace, "/entrypoint/kind", "\"scene\""},
            {RoomPatch::Operation::Replace, "/entrypoint/id", "\"background-clock-a\""},
            {RoomPatch::Operation::Replace, "/export/runtime/includeTests", "false"},
            {RoomPatch::Operation::Replace, "/export/profiles/0/includeDebugSymbols", "false"}});
    require(edited.accepted && edited.snapshot.valid && edited.snapshot.dirty &&
                edited.affected_records == std::vector<std::string>{"project"} &&
                read(file) == unchanged,
            "Project and Export generic patch changes one working generation only");
    require(!project->patch(0, {{RoomPatch::Operation::Replace, "/project/name", "\"stale\""}})
                 .accepted,
            "Stale working revision rejected");
    const auto invalid =
        project->patch(1, {{RoomPatch::Operation::Replace, "/inventories/0/id", "\"wrong\""}});
    require(invalid.accepted && !invalid.snapshot.valid &&
                !project->save(first.disk_source_revision).accepted && read(file) == unchanged,
            "Invalid inventory cannot persist to current manifest");
    const auto repaired =
        project->patch(2, {{RoomPatch::Operation::Replace, "/inventories/0/id", "\"inventory\""}});
    require(repaired.accepted && repaired.snapshot.valid && !repaired.diagnostics_removed.empty(),
            "Invalid manifest can be repaired");
    const auto saved = project->save(first.disk_source_revision);
    require(saved.accepted && saved.snapshot.valid && !saved.snapshot.dirty &&
                saved.snapshot.disk_source_revision != first.disk_source_revision &&
                saved.snapshot.working_revision == 3,
            "Save advances exact disk revision but not working revision");
    const auto after = read(file);
    require(read(temp.root / "editor.yaml") == editor_before &&
                read(temp.root / "records/rooms/room-lifecycle-roundtrip.yaml") == room_before &&
                read(temp.root / "i18n/project.yaml") == localization_before &&
                read(temp.root / "notes/LICENSE.md") == note_before,
            "Manifest Save never rewrites independently owned tracked or referenced source");
    require(after.starts_with("# project note\n"), "Project header comment retained");
    require(after.find("# name note") != std::string::npos, "Project field comment retained");
    require(after.find("name: \"Native Project\"") != std::string::npos ||
                after.find("name: Native Project") != std::string::npos,
            "Project name is written with correct YAML syntax");
    require(after.find("defaultLocale: en") != std::string::npos,
            "Unrelated export localization is retained");
    auto reopened = ProjectSession::open(temp.root, error);
    require(reopened && reopened->snapshot().normalized_json == saved.snapshot.normalized_json,
            "Reopening returns identical normalized manifest");

    if (verify) {
#ifndef _WIN32
        std::filesystem::create_directories(temp.root / "scripts/shared-helper");
        write(temp.root / "scripts/shared-helper/extra.lua", "return {}\n");
        std::filesystem::create_directory_symlink("shared-helper", temp.root / "scripts/alias");
        auto with_alias = ProjectSession::open(temp.root, error);
        require(with_alias != nullptr, "In-root source directory symlink must be admitted");
        bool alias_indexed = false;
        for (const auto& file_info : with_alias->file_inventory())
            alias_indexed |= file_info.path == "scripts/alias/extra.lua" &&
                             file_info.kind == ProjectFileKind::ProjectSource;
        require(alias_indexed, "In-root source aliases retain Project-relative source identity");
        std::filesystem::remove(temp.root / "scripts/alias");
        std::filesystem::create_directory_symlink(".", temp.root / "scripts/cycle");
        require(!ProjectSession::open(temp.root, error),
                "Recursive source directory symlink must fail closed");
        std::filesystem::remove(temp.root / "scripts/cycle");
        std::filesystem::remove_all(temp.root / "scripts/shared-helper");
#endif
        write(temp.root / "project.json", "{}");
        require(!ProjectSession::open(temp.root, error) &&
                    error.find("Retired") != std::string::npos,
                "Retired manifest JSON blocks current workspace admission");
        std::filesystem::remove(temp.root / "project.json");
        auto broken = after;
        broken.replace(broken.find("schemaVersion: 1"), std::strlen("schemaVersion: 1"),
                       "schemaVersion: 2");
        write(file, broken);
        require(!ProjectSession::open(temp.root, error), "Other workspace versions fail closed");
        write(file, after);
        write(temp.root / "editor.yaml", "# broken\n: [");
        require(!ProjectSession::open(temp.root, error),
                "Malformed contextual tracked source fails closed");
        write(temp.root / "editor.yaml", "[]\n");
        require(!ProjectSession::open(temp.root, error),
                "Non-object tracked fragment fails closed even when syntactically valid YAML");
        write(temp.root / "editor.yaml", read(fixture / "editor.yaml"));
        std::filesystem::create_directories(temp.root / "records/rooms/nested");
        require(!ProjectSession::open(temp.root, error),
                "Noncanonical nested record directory fails closed");
        std::filesystem::remove(temp.root / "records/rooms/nested");
        std::filesystem::remove(temp.root / "records/layouts/lab-pause/layout.rml");
        require(!ProjectSession::open(temp.root, error),
                "Missing declared Layout source companion fails closed");
        std::filesystem::remove(temp.root / "records/layouts/lab-pause/layout.yaml");
        require(!ProjectSession::open(temp.root, error),
                "A Layout companion without its canonical metadata blocks Project admission");
    }
    Json result = Json::object();
    result.insert_or_assign("beforeSource", unchanged);
    result.insert_or_assign("savedSource", after);
    result.insert_or_assign("workingValue", Json::parse(saved.snapshot.source_json));
    result.insert_or_assign("nativeNormalized", Json::parse(saved.snapshot.normalized_json));
    result.insert_or_assign("nativeValid", saved.snapshot.valid);
    result.insert_or_assign("revision", saved.snapshot.working_revision);
    Json affected = Json::array();
    for (const auto& record : edited.affected_records)
        affected.push_back(record);
    result.insert_or_assign("affectedRecords", std::move(affected));
    return result;
}
} // namespace

int main(int argc, char** argv)
{
    try {
        if (argc == 2 && std::string_view(argv[1]) == "--validate") {
            const std::string source{std::istreambuf_iterator<char>{std::cin},
                                     std::istreambuf_iterator<char>{}};
            const auto decoded = open_yaml_source(source);
            const auto result = decoded.accepted
                                    ? validate_record("WorkspaceManifest", decoded.source_json)
                                    : ValidationResult{};
            Json response = Json::object();
            response.insert_or_assign("valid", result.accepted);
            if (result.accepted)
                response.insert_or_assign("nativeNormalized", Json::parse(result.effective_json));
            Json diagnostics = Json::array();
            for (const auto& diagnostic : result.diagnostics) {
                Json entry = Json::object();
                entry.insert_or_assign("path", diagnostic.path);
                entry.insert_or_assign("code", diagnostic.code);
                diagnostics.push_back(std::move(entry));
            }
            if (!decoded.accepted) {
                Json entry = Json::object();
                entry.insert_or_assign("path", "");
                entry.insert_or_assign("code", "source.yaml");
                diagnostics.push_back(std::move(entry));
            }
            response.insert_or_assign("diagnostics", std::move(diagnostics));
            std::cout << response.to_string() << '\n';
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--roundtrip") {
            std::cout << roundtrip(argv[2], false).to_string() << '\n';
            return 0;
        }
        if (argc == 2) {
            roundtrip(argv[1], true);
            return 0;
        }
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "Project certification failed: " << e.what() << '\n';
        return 1;
    }
}
