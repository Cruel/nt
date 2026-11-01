#include "room_session.hpp"
#include "validation_work_instrumentation.hpp"
#include "source_authority.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <algorithm>
#include <array>
#include <noveltea/core/fingerprint.hpp>
#include <set>

#ifdef __linux__
#include <fcntl.h>
#include <unistd.h>
#endif

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

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
        // The checked-in native CLI smoke Project may have disposable local
        // caches. Every certification requires a truly cold independent copy.
        std::error_code ignored;
        std::filesystem::remove_all(root / ".noveltea" / "cache", ignored);
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
    const auto saved = project->save(noveltea::core::xxh3_128_revision(unchanged));
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
        const auto contains = [](const std::vector<std::string>& paths, std::string_view path) {
            return std::find(paths.begin(), paths.end(), path) != paths.end();
        };
        const auto first_observation = project->observe_sources();
        require(first_observation.authoritative && first_observation.unchanged,
                "Project session starts with an exact physical source baseline");
        auto other_session = ProjectSession::open(temp.root, error);
        require(other_session && other_session->observe_sources().unchanged,
                "Separate consumers own independent physical source authority");

        const auto observed_room = temp.root / "records/rooms/room-lifecycle-roundtrip.yaml";
        auto changed_room = room_before;
        const auto id_offset = changed_room.find("room-lifecycle-roundtrip");
        require(id_offset != std::string::npos, "Room fixture has identity to modify");
        changed_room[id_offset + std::strlen("room-lifecycle-roundtri")] = 'q';
        const auto original_time = std::filesystem::last_write_time(observed_room);
        write(observed_room, changed_room);
        std::filesystem::last_write_time(observed_room, original_time);
        project->source_watch_hint("records/rooms/room-lifecycle-roundtrip.yaml");
        const auto changed_source = project->observe_sources();
        require(
            changed_source.authoritative &&
                contains(changed_source.delta.changed,
                         "records/rooms/room-lifecycle-roundtrip.yaml") &&
                contains(changed_source.watch_paths, "records/rooms/room-lifecycle-roundtrip.yaml"),
            "Equal-size equal-mtime physical edit is proven from exact bytes");
        require(contains(other_session->observe_sources().delta.changed,
                         "records/rooms/room-lifecycle-roundtrip.yaml"),
                "Independent watcher does not share or consume other session's deltas");
        write(observed_room, room_before);
        require(contains(project->observe_sources().delta.changed,
                         "records/rooms/room-lifecycle-roundtrip.yaml"),
                "Restoring prior bytes is still a new physical revision observation");

        const auto added_room = temp.root / "records/rooms/watch-created.yaml";
        write(added_room, "id: watch-created\n");
        require(
            contains(project->observe_sources().delta.added, "records/rooms/watch-created.yaml"),
            "Missed create notification still discovered in tracked source directory");
        std::filesystem::remove(added_room);
        require(
            contains(project->observe_sources().delta.removed, "records/rooms/watch-created.yaml"),
            "Tracked removal is reported explicitly");

        const auto missing_file = temp.root / "traits.yaml";
        const auto traits_source = read(missing_file);
        std::filesystem::remove(missing_file);
        require(contains(project->observe_sources().delta.removed, "traits.yaml"),
                "Missing fixed tracked source is a proven removal, not a stale snapshot");
        write(missing_file, traits_source);
        require(contains(project->observe_sources().delta.added, "traits.yaml"),
                "Restored fixed source is rediscovered");

        const auto asset_record = temp.root / "records/assets/watch-asset.yaml";
        const auto asset_source = temp.root / "external/custom.bin";
        std::filesystem::create_directories(asset_source.parent_path());
        write(asset_source, std::string_view("\0asset", 6));
        write(asset_source.parent_path() / "unrelated.bin", "unrelated\n");
        write(asset_record, "id: watch-asset\ndata:\n  source:\n    path: external/custom.bin\n");
        auto asset_added = project->observe_sources();
        require(asset_added.authoritative &&
                    contains(asset_added.delta.added, "records/assets/watch-asset.yaml") &&
                    contains(asset_added.delta.added, "external/custom.bin"),
                "Asset reference discovers binary outside the assets directory without root sweep");
        write(asset_source.parent_path() / "unrelated.bin", "elsewhere\n");
        require(project->observe_sources().unchanged,
                "Unrelated binary/root file does not enter source authority");
        write(asset_source, "new asset bytes");
        require(contains(project->observe_sources().delta.changed, "external/custom.bin"),
                "Changed referenced binary is verified by exact-byte revision");
        std::filesystem::remove(asset_source);
        require(contains(project->observe_sources().delta.removed, "external/custom.bin"),
                "Missing referenced Asset source is not considered unchanged");
        write(asset_record, "id: watch-asset\ndata:\n  source:\n    path: external/new.bin\n");
        write(asset_source.parent_path() / "new.bin", "new\n");
        auto rerouted = project->observe_sources();
        require(rerouted.authoritative && contains(rerouted.delta.added, "external/new.bin") &&
                    !contains(rerouted.delta.added, "external/custom.bin"),
                "Changing an Asset reference rebuilds dynamic source membership");
        write(asset_record, "id: [\n");
        auto unprovable = project->observe_sources();
        require(!unprovable.authoritative && unprovable.scoped_authority &&
                    unprovable.error.empty() && !unprovable.unchanged &&
                    !unprovable.invalid_sources.empty() &&
                    unprovable.invalid_sources.front().path == "records/assets/watch-asset.yaml" &&
                    contains(unprovable.delta.changed, "records/assets/watch-asset.yaml") &&
                    !contains(unprovable.delta.removed, "external/new.bin"),
                "Known invalid Asset is an exact observed source, not globally proven valid");
        write(asset_source.parent_path() / "new.bin", "new physical bytes\n");
        const auto referenced_during_invalid = project->observe_sources();
        require(referenced_during_invalid.scoped_authority &&
                    contains(referenced_during_invalid.delta.changed, "external/new.bin"),
                "An invalid Asset retains previous verified binary references for observation");
        const auto source_name_before = project->snapshot();
        const auto independent_project_edit = project->patch(
            source_name_before.working_revision,
            {{RoomPatch::Operation::Replace, "/project/name", "\"Saved With Invalid Asset\""}});
        require(independent_project_edit.accepted,
                "Unrelated manifest edit remains possible during attributable Asset invalidity");
        const auto scoped_save = project->save(source_name_before.disk_source_revision);
        require(scoped_save.accepted && !scoped_save.snapshot.dirty &&
                    read(file).find("Saved With Invalid Asset") != std::string::npos &&
                    read(asset_record) == "id: [\n",
                "Attributable invalid Asset must not block independent scoped manifest Save");
        const auto while_invalid = project->observe_sources();
        require(while_invalid.scoped_authority && !while_invalid.authoritative &&
                    !while_invalid.invalid_sources.empty() && !while_invalid.unchanged,
                "Scoped invalidity remains visible after unrelated Save and a quiet watch pass");
        const auto good_project_source = read(file);
        write(file, "settings: [\n");
        const auto globally_uncertain = project->observe_sources();
        require(!globally_uncertain.authoritative && !globally_uncertain.scoped_authority &&
                    globally_uncertain.full_rescan &&
                    !project->save(scoped_save.snapshot.disk_source_revision).accepted,
                "Malformed Project manifest remains a global source-authority failure");
        write(file, good_project_source);
        require(project->observe_sources().scoped_authority,
                "Restored Project manifest permits scoped observation again");
        std::filesystem::remove(asset_record);
        auto recovered = project->observe_sources();
        require(recovered.authoritative && recovered.invalid_sources.empty() &&
                    contains(recovered.delta.removed, "records/assets/watch-asset.yaml"),
                "Repair clears scoped invalidity and restores complete authority");
        std::filesystem::remove_all(asset_source.parent_path());
        require(project->observe_sources().unchanged,
                "Removed unreferenced binary subtree is ignored");

        const auto watched_directory = temp.root / "scripts/watch-directory";
        std::filesystem::create_directory(watched_directory);
        write(watched_directory / "before.lua", "return 1\n");
        require(
            contains(project->observe_sources().delta.added, "scripts/watch-directory/before.lua"),
            "New source subdirectory is discovered without a root scan");
        std::filesystem::rename(watched_directory, temp.root / "notes/moved-watch-directory");
        std::filesystem::create_directory(watched_directory);
        write(watched_directory / "after.lua", "return 2\n");
        const auto replaced_directory = project->observe_sources();
        require(
            replaced_directory.authoritative &&
                contains(replaced_directory.delta.removed, "scripts/watch-directory/before.lua") &&
                contains(replaced_directory.delta.added, "scripts/watch-directory/after.lua"),
            "Replaced source directory recovers old removals and new source membership");
        std::filesystem::remove_all(watched_directory);
        std::filesystem::remove_all(temp.root / "notes/moved-watch-directory");
        require(
            contains(project->observe_sources().delta.removed, "scripts/watch-directory/after.lua"),
            "Removed source directory cannot retain a stale watched child");

        project->source_watch_coverage_lost();
        const auto before_lost_watch = project->snapshot();
        const auto observer_patch =
            project->patch(before_lost_watch.working_revision,
                           {{RoomPatch::Operation::Replace, "/project/name", "\"Own Write\""}});
        require(observer_patch.accepted &&
                    !project->save(before_lost_watch.disk_source_revision).accepted,
                "Uncertain watcher authority blocks a Save without losing dirty working values");
        auto resumed = project->observe_sources();
        require(resumed.authoritative && resumed.full_rescan && resumed.unchanged,
                "Lost watcher or resume forces a complete revision proof without false deltas");

        require(project->snapshot().dirty, "Blocked Save retains dirty working source");
        const auto own_saved = project->save(before_lost_watch.disk_source_revision);
        require(own_saved.accepted && project->observe_sources().unchanged,
                "Own-write matching exact source revision is a watcher no-op");
        require(contains(other_session->observe_sources().delta.changed, "project.yaml"),
                "Second independent owner still observes first owner's physical Save");

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
        std::filesystem::create_directory_symlink(fixture / "scripts", temp.root / "scripts/alias");
        const auto escaped_parent = with_alias->observe_sources();
        require(!escaped_parent.authoritative && !escaped_parent.scoped_authority &&
                    escaped_parent.full_rescan,
                "Replacing a verified source parent with an out-of-root symlink revokes authority");
        std::filesystem::remove(temp.root / "scripts/alias");
        std::filesystem::create_directory_symlink("shared-helper", temp.root / "scripts/alias");
        require(with_alias->observe_sources().unchanged,
                "Restoring an in-root directory alias recovers physical observation");
        std::filesystem::remove(temp.root / "scripts/shared-helper/extra.lua");
        std::filesystem::create_symlink(fixture / "project.yaml",
                                        temp.root / "scripts/shared-helper/extra.lua");
        const auto escaped_leaf = with_alias->observe_sources();
        require(!escaped_leaf.authoritative && !escaped_leaf.scoped_authority &&
                    escaped_leaf.full_rescan,
                "Replacing a verified source leaf with an out-of-root symlink revokes authority");
        std::filesystem::remove(temp.root / "scripts/shared-helper/extra.lua");
        write(temp.root / "scripts/shared-helper/extra.lua", "return {}\n");
        require(with_alias->observe_sources().unchanged,
                "Restoring an in-root source leaf recovers physical observation");
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

void traits_editor_roundtrip(const std::filesystem::path& fixture)
{
    {
        TemporaryProject sparse(fixture);
        const auto path = sparse.root / "editor.yaml";
        write(path, "# tracked editor comment\nchapters: {} # chapter note\n"
                    "tags: {} # tag note\nrecordMetadata: {} # metadata note\n");
        std::string open_error;
        auto session = ProjectSession::open(sparse.root, open_error);
        require(session != nullptr, "Valid sparse editor metadata admits: " + open_error);
        const std::vector<RoomPatch> populate{
            {RoomPatch::Operation::Add, "/editor/tags/records/review",
             R"({"name":"Review","color":"#00aacc"})"},
            {RoomPatch::Operation::Add, "/editor/chapters/records/chapter-one",
             R"({"id":"chapter-one","label":"Chapter One"})"},
            {RoomPatch::Operation::Add,
             "/editor/recordMetadata/rooms/room-lifecycle-roundtrip/tags/0", "\"review\""}};
        const auto populated = session->patch(0, populate);
        require(populated.accepted && populated.snapshot.valid,
                "Generic Add materializes omitted editor defaults and record metadata namespace");
        const auto undone = session->patch(
            1, {{RoomPatch::Operation::Remove, "/editor/tags/records/review", ""},
                {RoomPatch::Operation::Remove, "/editor/chapters/records/chapter-one", ""},
                {RoomPatch::Operation::Remove,
                 "/editor/recordMetadata/rooms/room-lifecycle-roundtrip/tags/0", ""}});
        require(undone.accepted && !undone.snapshot.dirty,
                "Undo of sparse editor Adds restores omitted parent containers exactly");
        const auto redone = session->patch(2, populate);
        require(redone.accepted && redone.snapshot.valid,
                "Reapplying sparse editor additions yields a valid working Project");
        const auto saved =
            session->save_owners(3, {"editor"}, false, TransactionDecision::KeepComments,
                                 {{"editor", {"/tags", "/recordMetadata"}}});
        require(saved.accepted && session->record_snapshots().at("editor").dirty &&
                    read(path).find("chapter-one") == std::string::npos &&
                    read(path).starts_with("# tracked editor comment\n") &&
                    read(path).find("# chapter note") != std::string::npos &&
                    read(path).find("# tag note") != std::string::npos &&
                    read(path).find("# metadata note") != std::string::npos,
                "Scoped Save of sparse editor owners preserves unsaved Chapters and comments");
    }
    TemporaryProject temp(fixture);
    const auto traits_path = temp.root / "traits.yaml";
    const auto editor_path = temp.root / "editor.yaml";
    const auto manifest_before = read(temp.root / "project.yaml");
    const auto traits_before = read(traits_path);
    const auto editor_before = read(editor_path);
    write(traits_path, "# preserved Traits heading\n" + traits_before);
    write(editor_path, "# preserved organization heading\n" + editor_before);
    std::string error;
    auto project = ProjectSession::open(temp.root, error);
    require(project != nullptr, "Tracked Traits and editor organization admit: " + error);
    require(project->record_snapshots().empty(),
            "Project admission does not eagerly materialize tracked working owners");
    require(project->inspect_record("traits").accepted &&
                project->inspect_record("editor").accepted,
            "Traits and editor metadata can be inspected independently after Project admission");
    const auto baseline = project->record_snapshots();
    require(baseline.contains("traits") && baseline.contains("editor") &&
                baseline.at("traits").valid && baseline.at("editor").valid &&
                Json::parse(baseline.at("traits").normalized_json).contains("lab-layered") &&
                Json::parse(baseline.at("editor").normalized_json).contains("recordMetadata"),
            "Distinct tracked sources expose independently validated, normalized owners");
    auto duplicates = Json::parse(baseline.at("traits").source_json);
    auto& definition = duplicates.at("lab-layered");
    definition.at("ownerKinds").push_back("interactable");
    definition.at("properties").push_back(definition.at("properties").at(0));
    const auto duplicate_check =
        validate_record("WorkspaceTraitDeclarations", duplicates.to_string());
    const auto has_diagnostic = [&](std::string_view code) {
        return std::any_of(duplicate_check.diagnostics.begin(), duplicate_check.diagnostics.end(),
                           [&](const Diagnostic& entry) { return entry.code == code; });
    };
    require(!duplicate_check.accepted && has_diagnostic("semantic.trait.definition"),
            "Duplicate Trait owner kinds and Properties are rejected by native refinements");
    auto invalid_default = Json::parse(baseline.at("traits").source_json);
    invalid_default.at("lab-layered").at("properties").at(0).at("defaultValue") = 42;
    const auto default_check =
        validate_record("WorkspaceTraitDeclarations", invalid_default.to_string());
    require(!default_check.accepted &&
                std::any_of(default_check.diagnostics.begin(), default_check.diagnostics.end(),
                            [](const Diagnostic& entry) {
                                return entry.code == "semantic.trait.property";
                            }),
            "Incompatible Trait Property defaults diagnose at the native semantic boundary");

    const auto local_state =
        project->patch(0, {{RoomPatch::Operation::Add, "/editor/recovery", "{}"}});
    require(!local_state.accepted && !project->snapshot().dirty,
            "Ignored local editor recovery is not accepted into tracked editor.yaml");

    const auto wrong_trait = project->patch(
        0, {{RoomPatch::Operation::Replace, "/traits/lab-layered/id", "\"other-id\""}});
    require(
        wrong_trait.accepted && !wrong_trait.snapshot.valid &&
            !project->save_owners(1, {"traits"}, false, TransactionDecision::KeepComments).accepted,
        "Trait map-key mismatch is a diagnosable unsaved error, never a persisted value");
    const auto repaired = project->patch(
        1, {{RoomPatch::Operation::Replace, "/traits/lab-layered/id", "\"lab-layered\""}});
    require(repaired.accepted && repaired.snapshot.valid && !repaired.snapshot.dirty,
            "Restoring a Trait ID clears its semantic diagnostics");
    const auto edited = project->patch(
        2, {{RoomPatch::Operation::Replace, "/traits/lab-layered/label", "\"Native Trait\""},
            {RoomPatch::Operation::Add, "/editor/tags/records/review",
             R"({"name":"Review","color":"#00aacc"})"},
            {RoomPatch::Operation::Add, "/editor/recordMetadata/rooms",
             R"({"room-lifecycle-roundtrip":{"tags":["review"]}})"}});
    require(edited.accepted && edited.snapshot.valid &&
                edited.affected_records == std::vector<std::string>({"editor", "traits"}),
            "Traits and tagged organization edit through one generic atomic Project batch");
    const auto tags_saved = project->save_owners(
        3, {"editor"}, false, TransactionDecision::KeepComments, {{"editor", {"/tags"}}});
    require(tags_saved.accepted &&
                tags_saved.affected_records == std::vector<std::string>{"editor"} &&
                project->record_snapshots().at("editor").dirty &&
                project->record_snapshots().at("traits").dirty,
            "Tag Save leaves metadata in the same physical file and Traits independently dirty");
    require(read(editor_path).find("review") != std::string::npos,
            "Tag Save publishes the new Tag into editor.yaml");
    require(read(editor_path).find("room-lifecycle-roundtrip") == std::string::npos,
            "Tag Save does not publish independently dirty record metadata");
    require(read(traits_path) == "# preserved Traits heading\n" + traits_before,
            "Tag Save does not rewrite the independently dirty Traits source");

    const auto remainder =
        project->save_owners(4, {"editor", "traits"}, false, TransactionDecision::KeepComments,
                             {{"editor", {"/recordMetadata"}}});
    require(remainder.accepted && !remainder.snapshot.dirty,
            "Remaining editor metadata and Traits commit together without rewriting tags");
    require(read(editor_path).starts_with("# preserved organization heading\n") &&
                read(traits_path).starts_with("# preserved Traits heading\n") &&
                read(temp.root / "project.yaml") == manifest_before,
            "Tracked source comments and unrelated Project manifest survive separate Save units");
    auto reopened = ProjectSession::open(temp.root, error);
    require(reopened != nullptr, "Saved tracked sources can be reopened: " + error);
    require(reopened->inspect_record("traits").accepted &&
                reopened->inspect_record("editor").accepted &&
                reopened->record_snapshots().at("traits").normalized_json ==
                    project->record_snapshots().at("traits").normalized_json &&
                reopened->record_snapshots().at("editor").normalized_json ==
                    project->record_snapshots().at("editor").normalized_json,
            "Reopened Traits and editor metadata agree with saved native effective values");

    write(traits_path, "invalid-key:\n  id: different\n");
    require(!ProjectSession::open(temp.root, error),
            "Invalid or structurally mismatched Traits cannot be admitted as tracked source");
    write(traits_path, traits_before);
    write(editor_path, editor_before + "recovery: {}\n");
    require(!ProjectSession::open(temp.root, error),
            "Tracked editor.yaml rejects an ignored local recovery field");
    write(editor_path, "chapters:\n  records: {}\n  assignments: {}\ntags:\n  records: {}\n"
                       "recordMetadata:\n  rooms:\n    __proto__:\n      tags: []\n");
    require(!ProjectSession::open(temp.root, error),
            "Tracked record metadata rejects prototype keys as the TypeScript workspace does");
}
void property_semantics_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    std::string error;
    // The canonical Trait ID is present only after decoding a quoted YAML
    // escape. Searching raw physical bytes must never prune this dependent.
    const auto escaped_source = temp.root / "records/interactables/lab-specimen.yaml";
    auto escaped_bytes = read(escaped_source);
    const auto escaped_at = escaped_bytes.find("  - lab-layered");
    require(escaped_at != std::string::npos, "Trait dependency fixture is present");
    escaped_bytes.replace(escaped_at, std::string("  - lab-layered").size(),
                          R"(  - "lab-\u006cayered")");
    write(escaped_source, escaped_bytes);
    auto unopened = ProjectSession::open(temp.root, error);
    require(unopened != nullptr, "Unopened dependency fixture can be admitted");
    const auto dependent = unopened->patch(
        0,
        {{RoomPatch::Operation::Replace, "/traits/lab-layered/properties/0/type", "\"number\""},
         {RoomPatch::Operation::Replace, "/traits/lab-layered/properties/0/defaultValue", "42"}});
    require(dependent.accepted && !dependent.snapshot.valid &&
                std::any_of(
                    dependent.snapshot.diagnostics.begin(), dependent.snapshot.diagnostics.end(),
                    [](const Diagnostic& issue) {
                        return issue.path == "/interactables/lab-specimen/defaultProperties";
                    }) &&
                !unopened->record_snapshots().contains("interactables/lab-specimen"),
            "Trait edits validate unopened dependent owners without inspecting them");
    auto project = ProjectSession::open(temp.root, error);
    require(project != nullptr, "Variable and Trait fixture opens: " + error);
    require(project->inspect_record("variables/board-stock").accepted &&
                project->inspect_record("interactables/lab-specimen").accepted,
            "Variable and attached Trait owner are lazily inspectable");
    const auto valid = project->snapshot();
    if (!valid.valid)
        for (const auto& diagnostic : valid.diagnostics)
            std::cerr << "Baseline property diagnostic: " << diagnostic.path << " "
                      << diagnostic.code << " " << diagnostic.message << '\n';
    require(valid.valid, "Baseline typed Variable and Trait owner validate");

    const auto incompatible = project->patch(
        0, {{RoomPatch::Operation::Replace, "/variables/board-stock/data/value", "\"wrong\""}});
    require(incompatible.accepted && !incompatible.snapshot.valid &&
                std::any_of(incompatible.snapshot.diagnostics.begin(),
                            incompatible.snapshot.diagnostics.end(),
                            [](const Diagnostic& item) {
                                return item.path == "/variables/board-stock/data/value";
                            }),
            "Invalid Variable Value stays dirty and reports a precise diagnostic");
    require(
        !project
             ->save_owners(1, {"variables/board-stock"}, false, TransactionDecision::KeepComments)
             .accepted,
        "Invalid Variable cannot be persisted");
    const auto recovered = project->patch(
        1, {{RoomPatch::Operation::Replace, "/variables/board-stock/data/value", "0"}});
    require(recovered.accepted && recovered.snapshot.valid && !recovered.snapshot.dirty &&
                !recovered.diagnostics_removed.empty(),
            "Repairing Variable restores validity without rewriting disk");

    const auto changed_trait = project->patch(
        2,
        {{RoomPatch::Operation::Replace, "/traits/lab-layered/properties/0/type", "\"number\""},
         {RoomPatch::Operation::Replace, "/traits/lab-layered/properties/0/defaultValue", "42"}});
    require(changed_trait.accepted && !changed_trait.snapshot.valid &&
                std::any_of(changed_trait.snapshot.diagnostics.begin(),
                            changed_trait.snapshot.diagnostics.end(),
                            [](const Diagnostic& item) {
                                return item.path == "/interactables/lab-specimen/defaultProperties";
                            }),
            "Changing a Trait contract revalidates previously inspected dependent owners");
    require(!project->save_owners(3, {"traits"}, false, TransactionDecision::KeepComments).accepted,
            "Saving a Trait cannot publish an incompatible inspected dependent owner");
    const auto repaired_trait = project->patch(
        3, {{RoomPatch::Operation::Replace, "/traits/lab-layered/properties/0/type", "\"string\""},
            {RoomPatch::Operation::Replace, "/traits/lab-layered/properties/0/defaultValue",
             "\"trait-default\""}});
    require(repaired_trait.accepted && repaired_trait.snapshot.valid &&
                !repaired_trait.snapshot.dirty && !repaired_trait.diagnostics_removed.empty(),
            "Restoring a Trait clears dependent diagnostics without full Project reconstruction");

    require(project->inspect_record("variables/policy-entry-allowed").accepted &&
                project->inspect_record("rooms/room-lifecycle-start").accepted,
            "Referenced Variable and Room can be inspected without opening other record owners");
    const auto comparable =
        project->patch(4, {{RoomPatch::Operation::Add,
                            "/rooms/room-lifecycle-start/data/exits/1/condition/value", "true"}});
    require(comparable.accepted && comparable.snapshot.valid,
            "A typed comparison Value can be added without changing its referenced Variable");
    const auto changed_variable = project->patch(
        5,
        {{RoomPatch::Operation::Replace, "/variables/policy-entry-allowed/data/type", "\"string\""},
         {RoomPatch::Operation::Replace, "/variables/policy-entry-allowed/data/value",
          "\"available\""}});
    require(
        changed_variable.accepted && !changed_variable.snapshot.valid &&
            std::any_of(changed_variable.snapshot.diagnostics.begin(),
                        changed_variable.snapshot.diagnostics.end(),
                        [](const Diagnostic& item) {
                            return item.path ==
                                       "/rooms/room-lifecycle-start/data/exits/1/condition/value" &&
                                   item.code == "authoring.condition.variable-type-mismatch";
                        }),
        "Variable type edits invalidate dependent Room comparison Values");
    require(
        !project
             ->save_owners(6, {"variables/policy-entry-allowed"}, false,
                           TransactionDecision::KeepComments)
             .accepted,
        "Cannot Save a valid Variable whose newly incompatible type breaks an inspected condition");
    require(!project
                 ->save_owners(6, {"rooms/room-lifecycle-start"}, false,
                               TransactionDecision::KeepComments)
                 .accepted,
            "Cannot Save a structurally valid Room with an incompatible referenced Variable");
    const auto fixed_variable = project->patch(
        6,
        {{RoomPatch::Operation::Replace, "/variables/policy-entry-allowed/data/type",
          "\"boolean\""},
         {RoomPatch::Operation::Replace, "/variables/policy-entry-allowed/data/value", "false"}});
    require(fixed_variable.accepted && fixed_variable.snapshot.valid &&
                !fixed_variable.diagnostics_removed.empty(),
            "Dependent comparison diagnostics disappear when the referenced Variable is repaired");
    const auto removed_comparison =
        project->patch(7, {{RoomPatch::Operation::Remove,
                            "/rooms/room-lifecycle-start/data/exits/1/condition/value", ""}});
    require(
        removed_comparison.accepted && removed_comparison.snapshot.valid &&
            !removed_comparison.snapshot.dirty,
        "Restoring the optional comparison Value returns the entire working Project to baseline");

    const auto instance_override = project->patch(
        8, {{RoomPatch::Operation::Replace,
             "/interactableInstances/state-specimen-instance/localProperties/0/type", "\"enum\""},
            {RoomPatch::Operation::Add,
             "/interactableInstances/state-specimen-instance/localProperties/0/enumValues",
             R"(["instance-value"])"}});
    require(
        instance_override.accepted && !instance_override.snapshot.valid &&
            std::any_of(
                instance_override.snapshot.diagnostics.begin(),
                instance_override.snapshot.diagnostics.end(),
                [](const Diagnostic& item) {
                    return item.path ==
                               "/interactableInstances/state-specimen-instance/localProperties/0" &&
                           item.code == "authoring.interactable.instance_property_schema";
                }),
        "Valid local enum Value still diagnoses incompatibility with an inherited string Property");
    require(
        !project->save_owners(9, {"project"}, false, TransactionDecision::KeepComments).accepted,
        "Cannot publish an invalid Instance-local schema through the manifest Save");
    const auto fixed_override = project->patch(
        9,
        {{RoomPatch::Operation::Remove,
          "/interactableInstances/state-specimen-instance/localProperties/0/enumValues", ""},
         {RoomPatch::Operation::Replace,
          "/interactableInstances/state-specimen-instance/localProperties/0/type", "\"string\""}});
    require(fixed_override.accepted && fixed_override.snapshot.valid &&
                !fixed_override.snapshot.dirty,
            "Reverting an Instance override removes dependent errors and restores sparse source");

    const auto variable_source = temp.root / "records/variables/board-stock.yaml";
    const auto room_source = temp.root / "records/rooms/room-lifecycle-start.yaml";
    const auto untouched_room = read(room_source);
    const auto edited_variable = project->patch(
        10, {{RoomPatch::Operation::Replace, "/variables/board-stock/data/value", "7"}});
    require(edited_variable.accepted && edited_variable.snapshot.valid,
            "Valid typed Variable changes are dirty without affecting unrelated owners");
    const auto persisted = project->save_owners(11, {"variables/board-stock"}, false,
                                                TransactionDecision::KeepComments);
    require(persisted.accepted && read(room_source) == untouched_room &&
                read(variable_source).find("value: 7") != std::string::npos,
            "Source-aware Save publishes only the selected Variable YAML");
    auto reopened = ProjectSession::open(temp.root, error);
    require(reopened && reopened->inspect_record("variables/board-stock").accepted &&
                reopened->record_snapshots().at("variables/board-stock").normalized_json ==
                    project->record_snapshots().at("variables/board-stock").normalized_json,
            "Reopened Variable retains the saved typed effective Value");
}

void structural_record_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    const auto original_layout = temp.root / "records/layouts/notice-board";
    const auto removed_layout = temp.root / "records/layouts/structural-sidecar";
    const auto movable_layout = temp.root / "records/layouts/structural-movable";
    const auto renamed_layout = temp.root / "records/layouts/structural-renamed";
    std::filesystem::copy(original_layout, removed_layout,
                          std::filesystem::copy_options::recursive);
    std::filesystem::copy(original_layout, movable_layout,
                          std::filesystem::copy_options::recursive);
    auto layout_source = read(removed_layout / "layout.yaml");
    const auto layout_id = layout_source.find("id: notice-board");
    require(layout_id != std::string::npos, "Layout fixture must carry a source identity");
    layout_source.replace(layout_id, std::string("id: notice-board").size(),
                          "id: structural-sidecar");
    write(removed_layout / "layout.yaml", layout_source);
    auto movable_source = read(movable_layout / "layout.yaml");
    const auto movable_id = movable_source.find("id: notice-board");
    require(movable_id != std::string::npos, "Layout fixture has expected identity");
    movable_source.replace(movable_id, std::string("id: notice-board").size(),
                           "id: structural-movable");
    write(movable_layout / "layout.yaml", movable_source);
    const auto original_asset = temp.root / "assets/native-structural/clip.bin";
    std::filesystem::create_directories(original_asset.parent_path());
    const auto asset_bytes = std::string("\0asset\xff", 7);
    write(original_asset, asset_bytes);
    const auto old_file = temp.root / "records/variables/board-stock-copy.yaml";
    const auto new_file = temp.root / "records/variables/board-stock-renamed.yaml";
    std::string error;
    auto project = ProjectSession::open(temp.root, error);
    require(project != nullptr, "Structural source Project opens with sidecar fixture");
    require(project->inspect_record("layouts/structural-sidecar").accepted,
            "Deleted Layout has a native source snapshot for undo");
    const auto deleted_layout_value =
        project->record_snapshots().at("layouts/structural-sidecar").source_json;
    const auto deleted_rml = read(removed_layout / "layout.rml");
    const auto remove_layout =
        project->patch(project->snapshot().working_revision,
                       {{RoomPatch::Operation::Remove, "/layouts/structural-sidecar", ""}});
    require(remove_layout.accepted, "Native Layout deletion stages its source and companions");
    write(removed_layout / "layout.rml", deleted_rml + "external edit");
    const auto concurrent_delete = project->save_owners(remove_layout.snapshot.working_revision,
                                                        {"layouts/structural-sidecar"}, false,
                                                        TransactionDecision::RemoveComments);
    require(!concurrent_delete.accepted && std::filesystem::exists(removed_layout / "layout.yaml"),
            "A changed companion after Delete staging rejects the whole native transaction");
    write(removed_layout / "layout.rml", deleted_rml);
    const auto deleted_layout = project->save_owners(remove_layout.snapshot.working_revision,
                                                     {"layouts/structural-sidecar"}, false,
                                                     TransactionDecision::RemoveComments);
    require(deleted_layout.accepted && !std::filesystem::exists(removed_layout / "layout.yaml") &&
                !std::filesystem::exists(removed_layout / "layout.rml") &&
                !std::filesystem::exists(removed_layout / "layout.rcss") &&
                !std::filesystem::exists(removed_layout / "layout.lua"),
            "A native Layout removal journals YAML and all local source companions together: " +
                deleted_layout.error);
    const auto archived_rml = temp.root / ".noveltea/trash/layouts/structural-sidecar/layout.rml";
    require(read(archived_rml) == deleted_rml,
            "Deleted Layout companions remain in journal-owned undo storage");
    // Simulate the worker restarting between a committed deletion and Undo.
    project = ProjectSession::open(temp.root, error);
    require(project != nullptr, "Committed Layout deletion reopens");
    const auto undo_layout = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Add, "/layouts/structural-sidecar", deleted_layout_value}}, {},
        {{"layouts/structural-sidecar", "layouts/structural-sidecar"}});
    require(undo_layout.accepted && undo_layout.snapshot.valid,
            "Layout undo stages archived companions after a native worker restart: " +
                undo_layout.error);
    write(archived_rml, deleted_rml + "external archive mutation");
    const auto undo_race =
        project->save_owners(undo_layout.snapshot.working_revision, {"layouts/structural-sidecar"},
                             false, TransactionDecision::KeepComments);
    require(!undo_race.accepted && !std::filesystem::exists(removed_layout / "layout.yaml"),
            "An altered archived companion rejects atomic Layout undo");
    write(archived_rml, deleted_rml);
    const auto undo_saved =
        project->save_owners(undo_layout.snapshot.working_revision, {"layouts/structural-sidecar"},
                             false, TransactionDecision::KeepComments);
    require(undo_saved.accepted && read(removed_layout / "layout.rml") == deleted_rml &&
                !std::filesystem::exists(archived_rml),
            "Layout undo atomically restores YAML and companions and consumes the tombstone: " +
                undo_saved.error);
    require(project->inspect_record("layouts/structural-movable").accepted,
            "Layout with source companions can be inspected before structural rename");
    const auto moved_bytes = read(movable_layout / "layout.rml");
    auto moving =
        Json::parse(project->record_snapshots().at("layouts/structural-movable").source_json);
    moving.at("id") = "structural-renamed";
    const auto rename_layout = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Remove, "/layouts/structural-movable", ""},
         {RoomPatch::Operation::Add, "/layouts/structural-renamed", moving.to_string()}},
        {}, {{"layouts/structural-renamed", "layouts/structural-movable"}});
    require(rename_layout.accepted && rename_layout.snapshot.valid &&
                !std::filesystem::exists(renamed_layout),
            "Native Layout rename stages complete valid source without prematurely moving files: " +
                rename_layout.error);
    write(movable_layout / "layout.rml", "<div>concurrent external Layout edit</div>");
    const auto raced_layout =
        project->save_owners(rename_layout.snapshot.working_revision,
                             {"layouts/structural-movable", "layouts/structural-renamed"}, false,
                             TransactionDecision::RemoveComments);
    require(!raced_layout.accepted && !std::filesystem::exists(renamed_layout) &&
                read(movable_layout / "layout.rml") != moved_bytes,
            "Concurrent Layout companion modification prevents partial native rename");
    write(movable_layout / "layout.rml", moved_bytes);
    const auto moved =
        project->save_owners(rename_layout.snapshot.working_revision,
                             {"layouts/structural-movable", "layouts/structural-renamed"}, false,
                             TransactionDecision::RemoveComments);
    require(moved.accepted && !std::filesystem::exists(movable_layout / "layout.yaml") &&
                !std::filesystem::exists(movable_layout / "layout.rml") &&
                read(renamed_layout / "layout.rml") == moved_bytes &&
                std::filesystem::exists(renamed_layout / "layout.yaml"),
            "Native Layout identity change atomically journals the metadata and companions: " +
                moved.error);
    auto undo_moving = moving;
    undo_moving.at("id") = "structural-movable";
    const auto reverse = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Remove, "/layouts/structural-renamed", ""},
         {RoomPatch::Operation::Add, "/layouts/structural-movable", undo_moving.to_string()}},
        {}, {{"layouts/structural-movable", "layouts/structural-renamed"}});
    require(reverse.accepted, "Native Layout rename Undo stages the archived destination");
    const auto reversed =
        project->save_owners(reverse.snapshot.working_revision,
                             {"layouts/structural-renamed", "layouts/structural-movable"}, false,
                             TransactionDecision::RemoveComments);
    require(reversed.accepted && read(movable_layout / "layout.rml") == moved_bytes &&
                !std::filesystem::exists(temp.root /
                                         ".noveltea/trash/layouts/structural-movable/layout.rml"),
            "Native rename Undo consumes prior destination archive atomically: " + reversed.error);
    const auto forward_again = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Remove, "/layouts/structural-movable", ""},
         {RoomPatch::Operation::Add, "/layouts/structural-renamed", moving.to_string()}},
        {}, {{"layouts/structural-renamed", "layouts/structural-movable"}});
    require(forward_again.accepted, "Native Layout rename Redo stages its own archive");
    const auto redone =
        project->save_owners(forward_again.snapshot.working_revision,
                             {"layouts/structural-movable", "layouts/structural-renamed"}, false,
                             TransactionDecision::RemoveComments);
    require(redone.accepted && read(renamed_layout / "layout.rml") == moved_bytes &&
                !std::filesystem::exists(temp.root /
                                         ".noveltea/trash/layouts/structural-renamed/layout.rml"),
            "Native rename Undo/Redo consumes archives without an occupied-path collision: " +
                redone.error);
    const auto duplicate_layout = temp.root / "records/layouts/structural-duplicate";
    auto duplicate =
        Json::parse(project->record_snapshots().at("layouts/structural-renamed").source_json);
    duplicate.at("id") = "structural-duplicate";
    duplicate.at("label") = "Copied structural Layout";
    const auto duplicated = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Add, "/layouts/structural-duplicate", duplicate.to_string()}}, {},
        {{"layouts/structural-duplicate", "layouts/structural-renamed"}});
    require(duplicated.accepted && duplicated.snapshot.valid &&
                !std::filesystem::exists(duplicate_layout / "layout.rml"),
            "Explicit generic Layout copy source resolves ambiguous matching physical owners: " +
                duplicated.error);
    const auto duplicate_saved =
        project->save_owners(duplicated.snapshot.working_revision, {"layouts/structural-duplicate"},
                             false, TransactionDecision::KeepComments);
    require(duplicate_saved.accepted &&
                read(duplicate_layout / "layout.rml") == read(renamed_layout / "layout.rml") &&
                std::filesystem::exists(renamed_layout / "layout.rml"),
            "Generic structural duplicate journals copied Layout companions without deleting "
            "the original: " +
                duplicate_saved.error);
    require(project && project->inspect_record("variables/board-stock").accepted,
            "Existing record must be inspectable before structural patch");
    auto copied = Json::parse(project->record_snapshots().at("variables/board-stock").source_json);
    copied.at("id") = "board-stock-copy";
    const auto seeded = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Add, "/variables/board-stock-copy", copied.to_string()}});
    require(seeded.accepted && seeded.snapshot.valid && !std::filesystem::exists(old_file),
            "New record and native Asset transition are staged before journaled Save");
    ProjectAssetTransition trash;
    trash.paths = {"assets/native-structural/clip.bin"};
    std::filesystem::remove(original_asset);
    const auto asset_conflict =
        project->save_owners(seeded.snapshot.working_revision, {"variables/board-stock-copy"},
                             false, TransactionDecision::KeepComments, {}, {}, trash);
    require(!asset_conflict.accepted && !std::filesystem::exists(old_file) &&
                !std::filesystem::exists(original_asset),
            "Missing Asset source prevents partial YAML structural Save");
    write(original_asset, asset_bytes);
    const auto asset_saved =
        project->save_owners(seeded.snapshot.working_revision, {"variables/board-stock-copy"},
                             false, TransactionDecision::KeepComments, {}, {}, trash);
    require(asset_saved.accepted && asset_saved.asset_trash_moves.size() == 1 &&
                std::filesystem::exists(old_file) && !std::filesystem::exists(original_asset),
            "Native journal creates YAML and trashes original binary asset atomically: " +
                asset_saved.error);
    const auto trash_path = temp.root / asset_saved.asset_trash_moves.front().second;
    require(read(trash_path) == asset_bytes,
            "Binary trash preserves byte-exact content including embedded NUL");
    ProjectAssetTransition restore;
    restore.kind = ProjectAssetTransition::Kind::Restore;
    restore.moves = asset_saved.asset_trash_moves;
    write(original_asset, "occupied");
    const auto restore_conflict =
        project->save_owners(asset_saved.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, restore);
    require(!restore_conflict.accepted && read(original_asset) == "occupied" &&
                read(trash_path) == asset_bytes,
            "Native Asset restore refuses occupied destination without touching trash");
    std::filesystem::remove(original_asset);
    const auto restored_asset =
        project->save_owners(asset_saved.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, restore);
    require(restored_asset.accepted && read(original_asset) == asset_bytes &&
                !std::filesystem::exists(trash_path),
            "Native Asset restore commits exact binary and trash deletion together: " +
                restored_asset.error);
    const auto import_stage =
        temp.root / ".noveltea/native-asset-import/123e4567-e89b-12d3-a456-426614174000";
    const auto imported_asset = temp.root / "assets/native-structural/published.bin";
    std::filesystem::create_directories(import_stage.parent_path());
    write(import_stage, asset_bytes);
    ProjectAssetTransition publication;
    publication.kind = ProjectAssetTransition::Kind::Publish;
    publication.publications.push_back(
        {"assets/native-structural/published.bin",
         ".noveltea/native-asset-import/123e4567-e89b-12d3-a456-426614174000",
         noveltea::core::xxh3_128_revision(asset_bytes)});
    auto wrong_revision = publication;
    wrong_revision.publications[0].source_revision = "sha256:invalid";
    const auto rejected_publication =
        project->save_owners(restored_asset.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, wrong_revision);
    require(!rejected_publication.accepted && std::filesystem::exists(import_stage) &&
                !std::filesystem::exists(imported_asset),
            "Stale staged Asset bytes reject publication without any partial write");
    const auto published =
        project->save_owners(restored_asset.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, publication);
    require(published.accepted && read(imported_asset) == asset_bytes &&
                !std::filesystem::exists(import_stage),
            "Native Asset publication moves immutable staged bytes in one transaction: " +
                published.error);
    write(import_stage, asset_bytes);
    const auto occupied =
        project->save_owners(published.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, publication);
    require(!occupied.accepted && read(imported_asset) == asset_bytes &&
                read(import_stage) == asset_bytes,
            "Native Asset publication refuses occupied destinations");
    ProjectAssetTransition organization;
    organization.kind = ProjectAssetTransition::Kind::Move;
    organization.moves.emplace_back("assets/native-structural/published.bin",
                                    "support/published.bin");
    const auto organized =
        project->save_owners(published.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, organization);
    require(organized.accepted && !std::filesystem::exists(imported_asset) &&
                read(temp.root / "support/published.bin") == asset_bytes,
            "Native Asset organization journals byte-exact moves into Support: " + organized.error);
    const auto native_script = temp.root / "scripts/native-file-511.lua";
    const auto native_moved_script = temp.root / "scripts/native-file-511-moved.lua";
    ProjectAssetTransition source_create;
    source_create.kind = ProjectAssetTransition::Kind::SourceFiles;
    source_create.source_files.push_back({"scripts/native-file-511.lua", "absent", "return 511\n"});
    const auto source_created =
        project->save_owners(organized.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, source_create);
    require(source_created.accepted && read(native_script) == "return 511\n",
            "Native source-file creation commits through native journal: " + source_created.error);
    const auto colliding_source =
        project->save_owners(source_created.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, source_create);
    require(!colliding_source.accepted && read(native_script) == "return 511\n",
            "Native source-file collision refuses overwrite");
    ProjectAssetTransition source_move;
    source_move.kind = ProjectAssetTransition::Kind::SourceFiles;
    source_move.source_files.push_back({"scripts/native-file-511.lua",
                                        noveltea::core::xxh3_128_revision("return 511\n"),
                                        std::nullopt});
    source_move.source_files.push_back(
        {"scripts/native-file-511-moved.lua", "absent", "return 511\n"});
    const auto source_moved =
        project->save_owners(source_created.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, source_move);
    require(source_moved.accepted && !std::filesystem::exists(native_script) &&
                read(native_moved_script) == "return 511\n",
            "Native source-file rename atomically publishes destination and removes source: " +
                source_moved.error);
    auto invalid_move = source_move;
    invalid_move.source_files[0].path = "scripts/native-file-511-moved.lua";
    invalid_move.source_files[0].expected_revision = "sha256:stale";
    invalid_move.source_files[1].path = "scripts/native-file-511.lua";
    const auto rejected_source =
        project->save_owners(source_moved.snapshot.working_revision, {}, false,
                             TransactionDecision::KeepComments, {}, {}, invalid_move);
    require(!rejected_source.accepted && read(native_moved_script) == "return 511\n" &&
                !std::filesystem::exists(native_script),
            "Native source-file transaction rejects stale source revision atomically");
    const auto folder_created = project->mutate_source_directory(
        source_moved.snapshot.working_revision, "create", "scripts/native-empty-511", "");
    require(folder_created.accepted,
            "Native empty source folder creation: " + folder_created.error);
    const auto folder_moved = project->mutate_source_directory(
        folder_created.snapshot.working_revision, "move", "scripts/native-empty-511",
        "scripts/native-empty-511-moved");
    require(folder_moved.accepted, "Native empty folder relocation: " + folder_moved.error);
    const auto folder_deleted = project->mutate_source_directory(
        folder_moved.snapshot.working_revision, "delete", "scripts/native-empty-511-moved", "");
    require(folder_deleted.accepted &&
                !std::filesystem::exists(temp.root / "scripts/native-empty-511-moved"),
            "Native empty folder deletion: " + folder_deleted.error);
    require(project->inspect_record("assets/counter-document").accepted,
            "Native Asset source template must be admitted");
    auto imported_record =
        Json::parse(project->record_snapshots().at("assets/counter-document").source_json);
    imported_record.at("id") = "native-published-asset";
    imported_record.at("label") = "Native published binary";
    imported_record.at("data").at("kind") = "binary";
    imported_record.at("data").at("source").at("path") =
        "assets/native-structural/published-record.bin";
    imported_record.at("data").at("mimeType") = "application/octet-stream";
    imported_record.at("data").at("extension") = ".bin";
    const auto candidate_record =
        project->patch(folder_deleted.snapshot.working_revision,
                       {{RoomPatch::Operation::Add, "/assets/native-published-asset",
                         imported_record.to_string()}});
    require(candidate_record.accepted,
            "A new Asset record may be staged while its binary is not yet published");
    const auto imported_staging =
        temp.root / ".noveltea/native-asset-import/123e4567-e89b-12d3-a456-426614174001";
    write(imported_staging, asset_bytes);
    ProjectAssetTransition imported_publication;
    imported_publication.kind = ProjectAssetTransition::Kind::Publish;
    imported_publication.publications.push_back(
        {"assets/native-structural/published-record.bin",
         ".noveltea/native-asset-import/123e4567-e89b-12d3-a456-426614174001",
         exact_source_revision(asset_bytes)});
    const auto imported_record_file = temp.root / "records/assets/native-published-asset.yaml";
    const auto import_accepted = project->save_owners(
        candidate_record.snapshot.working_revision, {"assets/native-published-asset"}, false,
        TransactionDecision::KeepComments, {}, {}, imported_publication);
    require(import_accepted.accepted && std::filesystem::exists(imported_record_file) &&
                read(temp.root / "assets/native-structural/published-record.bin") == asset_bytes,
            "Native Asset record and binary publication commit atomically: " +
                import_accepted.error);
    const auto source = read(old_file);
    copied.at("id") = "board-stock-renamed";
    const auto structural = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Remove, "/variables/board-stock-copy", ""},
         {RoomPatch::Operation::Add, "/variables/board-stock-renamed", copied.to_string()}});
    require(structural.accepted && structural.snapshot.dirty &&
                structural.affected_records ==
                    std::vector<std::string>(
                        {"variables/board-stock-copy", "variables/board-stock-renamed"}) &&
                !project->record_snapshots().contains("variables/board-stock-copy") &&
                project->record_snapshots().contains("variables/board-stock-renamed") &&
                read(old_file) == source && !std::filesystem::exists(new_file),
            "A native structural rename stages removal and creation without writing disk");
    const auto canceled =
        project->save_owners(structural.snapshot.working_revision,
                             {"variables/board-stock-copy", "variables/board-stock-renamed"}, false,
                             TransactionDecision::Cancel);
    require(!canceled.accepted && read(old_file) == source && !std::filesystem::exists(new_file),
            "Canceled structural Save has no physical effects");
    const auto saved =
        project->save_owners(structural.snapshot.working_revision,
                             {"variables/board-stock-copy", "variables/board-stock-renamed"}, false,
                             TransactionDecision::RemoveComments);
    require(
        saved.accepted && !std::filesystem::exists(old_file) && std::filesystem::exists(new_file) &&
            saved.affected_records == std::vector<std::string>({"variables/board-stock-copy",
                                                                "variables/board-stock-renamed"}),
        "Native journal atomically commits a record deletion and a record creation: " +
            saved.error + " owners=" + Json(saved.affected_records).to_string() +
            " oldExists=" + std::to_string(std::filesystem::exists(old_file)) +
            " newExists=" + std::to_string(std::filesystem::exists(new_file)));
    auto reopened = ProjectSession::open(temp.root, error);
    require(reopened && !reopened->inspect_record("variables/board-stock-copy").accepted &&
                reopened->inspect_record("variables/board-stock-renamed").accepted,
            "Structural record changes survive reopening without ghost sources");

    const auto restored = project->patch(
        saved.snapshot.working_revision,
        {{RoomPatch::Operation::Remove, "/variables/board-stock-renamed", ""},
         {RoomPatch::Operation::Add, "/variables/board-stock-copy",
          Json::parse(project->record_snapshots().at("variables/board-stock-renamed").source_json)
              .to_string()}});
    // The final add above deliberately uses the wrong identity; the native
    // record schema must refuse this before Save, with zero working changes.
    require(!restored.accepted && std::filesystem::exists(new_file) &&
                !std::filesystem::exists(old_file),
            "A malformed reverse structural patch does not partially mutate the session");

    auto next =
        Json::parse(project->record_snapshots().at("variables/board-stock-renamed").source_json);
    next.at("id") = "board-stock-final";
    const auto pending = project->patch(
        saved.snapshot.working_revision,
        {{RoomPatch::Operation::Remove, "/variables/board-stock-renamed", ""},
         {RoomPatch::Operation::Add, "/variables/board-stock-final", next.to_string()}});
    require(pending.accepted, "A second multi-source native rename stages successfully");
    const auto final_file = temp.root / "records/variables/board-stock-final.yaml";
    const auto committed_source = read(new_file);
    write(new_file, committed_source + "# concurrent comment\n");
    const auto stale =
        project->save_owners(pending.snapshot.working_revision,
                             {"variables/board-stock-renamed", "variables/board-stock-final"},
                             false, TransactionDecision::RemoveComments);
    require(!stale.accepted && read(new_file) == committed_source + "# concurrent comment\n" &&
                !std::filesystem::exists(final_file),
            "A stale deletion CAS rejects the entire multi-file structural Save");
}

void source_analysis_roundtrip(const std::filesystem::path& fixture)
{
    const auto lua = analyze_project_text("scripts/probe.lua",
                                          "-- Text.tr('ignored')\nlocal message = "
                                          "Text.tr('Hello'); local named = Text.msg([[notice]])\n");
    require(lua.complete && lua.diagnostics.empty() && lua.messages.size() == 2 &&
                lua.messages[0].kind == "local" && lua.messages[0].source == "Hello" &&
                lua.messages[0].line == 2 && lua.messages[1].kind == "named" &&
                lua.messages[1].source == "notice",
            "Native Lua analysis tracks direct managed literals with physical source locations");
    const auto invalid = analyze_project_text("scripts/probe.lua", "Text.tr(variable)\n");
    require(invalid.diagnostics.size() == 1 &&
                invalid.diagnostics[0].code == "authoring.localization.lua_source_literal" &&
                invalid.diagnostics[0].line == 1 &&
                invalid.diagnostics[0].source_path == "scripts/probe.lua",
            "Unsupported managed Lua calls carry existing diagnostic codes and file provenance");
    const auto markup = analyze_project_text(
        "records/layouts/probe/layout.rml",
        "<body><button onclick=\"Text.tr('Click')\">OK</button>"
        "<script>Text.tr('Inline')</script><script src=\"scripts/menu.lua\" /></body>");
    require(markup.complete && markup.messages.size() == 2 &&
                markup.messages[0].source == "Click" && markup.messages[1].source == "Inline" &&
                markup.references.size() == 1 && markup.references[0].kind == "script" &&
                markup.references[0].target == "scripts/menu.lua",
            "RML event handlers, embedded Lua and external dependencies share source analysis");
    const auto linked = analyze_project_text(
        "assets/ui/probe.rml",
        "<rml><head><link type=\"text/rcss\" href=\"project:/assets/ui/shared.rcss\"/>"
        "<link type=\"text/template\" href=\"project:/assets/ui/counter-template.rml\"/>"
        "</head><body><script src=\"project:/scripts/layout-counter-ui.lua\"/></body></rml>");
    require(linked.complete && linked.references.size() == 3 &&
                linked.references[0].kind == "stylesheet" &&
                linked.references[0].target == "project:/assets/ui/shared.rcss" &&
                linked.references[1].kind == "template-link" &&
                linked.references[2].kind == "script",
            "Native RML analysis recognizes stylesheet, template and script resource purposes");
    const auto inline_messages = analyze_project_text(
        "records/layouts/probe/layout.rml", "<rml><body><nt-tr>Source <b>markup</b></nt-tr>"
                                            "<nt-tr key=\"lab.read\" /></body></rml>");
    require(inline_messages.complete && inline_messages.messages.size() == 2 &&
                inline_messages.messages[0].kind == "local" &&
                inline_messages.messages[0].source == "Source <b>markup</b>" &&
                inline_messages.messages[1].kind == "named" &&
                inline_messages.messages[1].source == "lab.read",
            "Native RML extraction retains local and named nt-tr occurrences");
    const auto stylesheet =
        analyze_project_text("records/layouts/probe/layout.rcss",
                             "/* cursor: ignored */\nbutton { cursor: hand !important; }\n"
                             "span { cursor: inspect; }\n");
    require(stylesheet.complete && stylesheet.cursors.size() == 2 &&
                stylesheet.cursors[0].name == "hand" && stylesheet.cursors[0].line == 2 &&
                stylesheet.cursors[1].name == "inspect",
            "RCSS source tracks cursor dependencies without matching comments");
    const auto styled =
        analyze_project_text("records/layouts/probe/layout.rml",
                             "<rml><head><style>button { cursor: hand; }</style></head>"
                             "<body style=\"cursor: inspect;\" /></rml>");
    require(styled.cursors.size() == 2 && styled.cursors[0].name == "hand" &&
                styled.cursors[1].name == "inspect",
            "RML style elements and style attributes expose cursor occurrences");
    const auto selectors = analyze_project_text(
        "scripts/probe.lua",
        "Text.plural(n, { one = 'One', other = '' })\n"
        "Text.select(kind, { ['other'] = 'Fallback' }, { context = 'Notice' })\n"
        "Text.tr('Hello', nil, { note = 'Reminder' })\n");
    require(selectors.complete && selectors.diagnostics.empty() && selectors.messages.size() == 3 &&
                selectors.messages[0].kind == "plural" && selectors.messages[0].source.empty() &&
                selectors.messages[1].kind == "select" &&
                selectors.messages[1].source == "Fallback",
            "Static managed plural/select cases accept empty source and quoted keys");
    const auto invalid_cases = analyze_project_text(
        "scripts/probe.lua", "Text.plural(n, { weird = 'Unsupported', other = 'Fallback' })\n"
                             "Text.select(n, { other = dynamic })\n"
                             "Text.tr('Hello', nil, { note = dynamic })\n");
    require(invalid_cases.diagnostics.size() == 3 &&
                invalid_cases.diagnostics[0].code ==
                    "authoring.localization.lua_plural_case_invalid" &&
                invalid_cases.diagnostics[1].code == "authoring.localization.lua_cases_static" &&
                invalid_cases.diagnostics[2].code == "authoring.localization.lua_metadata_static",
            "Invalid managed cases and dynamic metadata keep the TypeScript diagnostic codes");
    const auto escaped =
        analyze_project_text("scripts/probe.lua", "Text.msg(\"\\x67reeting\")\nText.tr(\"\\117\")\n"
                                                  "Text.tr(\"\\u{1F600}\")\n");
    require(escaped.complete && escaped.diagnostics.empty() && escaped.messages.size() == 3 &&
                escaped.messages[0].source == "greeting" && escaped.messages[1].source == "u" &&
                escaped.messages[2].source == "\xf0\x9f\x98\x80",
            "Lua hex, decimal and Unicode escapes match the runtime and TypeScript analyzer");
    const auto latin1 =
        analyze_project_text("scripts/probe.lua", R"(Text.tr("\233"); Text.tr("\xE9"))");
    require(latin1.complete && latin1.diagnostics.empty() && latin1.messages.size() == 2 &&
                latin1.messages[0].source == "\xc3\xa9" && latin1.messages[1].source == "\xc3\xa9",
            "Lua decimal and hexadecimal escapes produce Unicode scalar U+00E9 encoded as UTF-8");
    const auto unrecognized = analyze_project_text("scripts/probe.lua", "Text.tr(\"\\q\")");
    require(!unrecognized.complete && !unrecognized.diagnostics.empty(),
            "Unknown Lua escapes mark source analysis incomplete");
    const auto preserved = analyze_project_text(
        "scripts/probe.lua", "Text.select(mode, { sealed = 'Closed', other = 'Open' }, { context = "
                             "'Door', note = 'For translators' })\n"
                             "Text.tr('Hello {name}', { name = user }, { note = 'Name' })\n");
    require(preserved.complete && preserved.diagnostics.empty() && preserved.messages.size() == 2 &&
                preserved.messages[0].cases.size() == 2 &&
                preserved.messages[0].cases.at("sealed") == "Closed" &&
                preserved.messages[0].context == "Door" &&
                preserved.messages[0].translator_note == "For translators" &&
                preserved.messages[1].runtime_argument_names &&
                *preserved.messages[1].runtime_argument_names == std::vector<std::string>{"name"} &&
                preserved.messages[1].translator_note == "Name",
            "Managed occurrences preserve selector branches, guidance and runtime arguments");
    const auto missing_args =
        analyze_project_text("scripts/probe.lua", "Text.tr('Hello {name}')\n");
    require(missing_args.diagnostics.size() == 1 &&
                missing_args.diagnostics[0].code ==
                    "authoring.localization.lua_message_arguments_missing",
            "Missing managed runtime arguments fail native validation");

    TemporaryProject temp(fixture);
    std::string error;
    auto editor = ProjectSession::open(temp.root, error);
    require(editor != nullptr, "Cannot admit native source-analysis fixture: " + error);
    const auto path = std::string("scripts/notice-board.lua");
    const auto disk = read(temp.root / path);
    const auto clean = editor->snapshot();
    const auto baseline = editor->source_analyses();
    require(baseline.contains(path), "Saved Lua Project source must be analyzed natively");
    const auto unrelated = std::string("scripts/feature-lab-bootstrap.lua");
    require(baseline.contains(unrelated), "Independent Project source must be indexed");
    const auto staged = editor->stage_text_source(clean.working_revision, path,
                                                  "local message = Text.tr(variable)\n");
    require(staged.accepted && staged.snapshot.dirty && !staged.snapshot.valid &&
                !staged.diagnostics_added.empty() &&
                staged.diagnostics_added.front().source_path == path,
            "Dirty source must update the working validation without writing physical bytes");
    require(read(temp.root / path) == disk,
            "Dirty source validation must not write to the Project Workspace");
    const auto changed = editor->source_analyses();
    require(changed.at(path).source_revision != baseline.at(path).source_revision &&
                changed.at(unrelated).source_revision == baseline.at(unrelated).source_revision,
            "One dirty source preserves unaffected analysis and dependency contributions");
    auto cli = ProjectSession::open(temp.root, error);
    require(cli && cli->snapshot().valid &&
                cli->source_analyses().at(path).source_revision ==
                    baseline.at(path).source_revision,
            "Separate CLI Project admission reads only saved physical source");
    require(!editor->stage_text_source(clean.working_revision, path, disk).accepted,
            "Stale source revisions cannot overwrite newer working text");
    require(!editor
                 ->stage_text_source(staged.snapshot.working_revision,
                                     "../scripts/notice-board.lua", "Text.tr('X')")
                 .accepted,
            "Text overlays cannot escape canonical Project paths");
    const auto reverted = editor->stage_text_source(staged.snapshot.working_revision, path, disk);
    require(reverted.accepted && reverted.snapshot.valid && !reverted.snapshot.dirty &&
                editor->text_source_overlays().empty() &&
                editor->source_analyses().at(path).source_revision ==
                    baseline.at(path).source_revision,
            "Reverting dirty Lua clears diagnostics without changing disk authority");

    const auto layout_path = std::string("records/layouts/notice-board/layout.rml");
    const auto layout_source = read(temp.root / layout_path);
    const auto staged_layout = editor->stage_text_source(
        reverted.snapshot.working_revision, layout_path,
        "<rml><body><button onclick=\"Text.msg('absent.message')\">Review</button>"
        "<script src=\"project:/scripts/not-declared.lua\" /></body></rml>");
    require(staged_layout.accepted && !staged_layout.snapshot.valid &&
                std::any_of(staged_layout.snapshot.diagnostics.begin(),
                            staged_layout.snapshot.diagnostics.end(),
                            [&](const Diagnostic& issue) {
                                return issue.code ==
                                           "authoring.localization.lua_named_message_missing" &&
                                       issue.path == "/layouts/notice-board/data/rml/sourceText" &&
                                       issue.source_path == layout_path && issue.line == 1;
                            }) &&
                std::any_of(staged_layout.snapshot.diagnostics.begin(),
                            staged_layout.snapshot.diagnostics.end(),
                            [&](const Diagnostic& issue) {
                                return issue.code == "authoring.lua.external_source_unresolved" &&
                                       issue.severity == "warning" &&
                                       issue.source_path == layout_path;
                            }),
            "Dirty RML produces consuming-owner diagnostics for managed Messages and undeclared "
            "dependencies");
    require(read(temp.root / layout_path) == layout_source,
            "A dirty Layout buffer is analyzed without writing its physical companion");
    const auto restored_layout = editor->stage_text_source(staged_layout.snapshot.working_revision,
                                                           layout_path, layout_source);
    require(restored_layout.accepted && restored_layout.snapshot.valid &&
                !restored_layout.snapshot.dirty,
            "RML source restoration also clears dependent diagnostics");
    const auto missing_stylesheet = editor->stage_text_source(
        restored_layout.snapshot.working_revision, layout_path,
        "<rml><head><link type=\"text/rcss\" "
        "href=\"project:/assets/ui/not-declared.rcss\"/></head><body/></rml>");
    require(missing_stylesheet.accepted &&
                std::any_of(missing_stylesheet.snapshot.diagnostics.begin(),
                            missing_stylesheet.snapshot.diagnostics.end(),
                            [](const auto& issue) {
                                return issue.code ==
                                           "authoring.rml.external_stylesheet_unresolved" &&
                                       issue.severity == "warning";
                            }),
            "Unresolvable RML stylesheet links expose targeted reference warnings");
    const auto linked_stylesheet = editor->stage_text_source(
        missing_stylesheet.snapshot.working_revision, layout_path,
        "<rml><head><link type=\"text/rcss\" href=\"layout.rcss\"/></head><body/></rml>");
    require(linked_stylesheet.accepted &&
                std::none_of(linked_stylesheet.snapshot.diagnostics.begin(),
                             linked_stylesheet.snapshot.diagnostics.end(),
                             [](const auto& issue) {
                                 return issue.code ==
                                        "authoring.rml.external_stylesheet_unresolved";
                             }),
            "Resolving the stylesheet link clears its reference warning");
    const auto removed_stylesheet = editor->stage_text_source(
        linked_stylesheet.snapshot.working_revision, layout_path, "<rml><body/></rml>");
    require(removed_stylesheet.accepted &&
                std::none_of(removed_stylesheet.snapshot.diagnostics.begin(),
                             removed_stylesheet.snapshot.diagnostics.end(),
                             [](const auto& issue) {
                                 return issue.code ==
                                        "authoring.rml.external_stylesheet_unresolved";
                             }),
            "Removing a formerly unresolved stylesheet link clears stale reference diagnostics");
    require(editor
                ->stage_text_source(removed_stylesheet.snapshot.working_revision, layout_path,
                                    layout_source)
                .accepted,
            "Restoring the RML source preserves later source tests");
    const std::string shared_rcss = "assets/ui/shared.rcss";
    const auto saved_rcss = read(temp.root / shared_rcss);
    const auto before_rcss = editor->source_analyses().at(shared_rcss).source_revision;
    const auto before_parent_rml =
        editor->source_analyses().at("assets/ui/counter.rml").source_revision;
    ValidationWorkCounters css_work;
    RoomSessionResult css_edit;
    {
        ScopedValidationWork measured(css_work);
        css_edit = editor->stage_text_source(editor->snapshot().working_revision, shared_rcss,
                                             saved_rcss + "\n/* stylesheet-only change */\n");
    }
    require(css_edit.accepted && css_work.parsed_rcss >= 1 && css_work.parsed_rml == 0 &&
                editor->source_analyses().at(shared_rcss).source_revision != before_rcss &&
                editor->source_analyses().at("assets/ui/counter.rml").source_revision ==
                    before_parent_rml,
            "Linked stylesheet edits reanalyze RCSS without reparsing an unchanged parent RML");
    require(editor->stage_text_source(css_edit.snapshot.working_revision, shared_rcss, saved_rcss)
                .accepted,
            "Reverting a linked stylesheet preserves independent downstream source tests");

    write(temp.root / path, "Text.tr(dynamic_value)\n");
    const auto observed = editor->observe_sources();
    require(std::find(observed.delta.changed.begin(), observed.delta.changed.end(), path) !=
                    observed.delta.changed.end() &&
                editor->source_analyses().at(path).source_revision !=
                    baseline.at(path).source_revision &&
                !editor->snapshot().valid,
            "External disk-only Lua changes invalidate the exact source analysis generation");
    const auto from_disk = ProjectSession::open(temp.root, error);
    require(
        from_disk && !from_disk->snapshot().valid,
        "A new CLI session sees the changed disk source rather than the editor's former overlay");
    write(temp.root / path, disk);
    editor->observe_sources();
    require(editor->snapshot().valid,
            "Restoring saved Lua re-admits its original native source diagnostics");
    TemporaryProject inline_fixture(fixture);
    write(inline_fixture.root / "records/scripts/notice-board.yaml",
          "id: notice-board\nlabel: notice-board\ndata:\n  source:\n"
          "    kind: inline-lua\n    source: \"Text.msg('missing.inline.message')\"\n");
    auto inlined = ProjectSession::open(inline_fixture.root, error);
    require(inlined != nullptr, "Inline Script can be admitted as a native Project");
    const auto virtual_path = std::string("inline/scripts/notice-board/data/source/source.lua");
    const auto inline_state = inlined->snapshot();
    if (!inlined->source_analyses().contains(virtual_path) || inline_state.valid) {
        for (const auto& [path, _] : inlined->source_analyses())
            if (path.starts_with("inline/scripts/"))
                std::cerr << "Inline analysis: " << path << "\n";
        for (const auto& issue : inline_state.diagnostics)
            std::cerr << "Inline diagnostic: " << issue.path << " " << issue.code << "\n";
    }
    require(inlined->source_analyses().contains(virtual_path) && !inline_state.valid &&
                std::any_of(inline_state.diagnostics.begin(), inline_state.diagnostics.end(),
                            [](const auto& entry) {
                                return entry.code ==
                                           "authoring.localization.lua_named_message_missing" &&
                                       entry.path == "/scripts/notice-board/data/source/source";
                            }),
            "Inline Lua Script contributes managed Message diagnostics to its logical owner");
    const auto asset_rml = std::string("assets/ui/counter.rml");
    const auto saved_asset_rml = read(temp.root / asset_rml);
    const auto asset_overlay = editor->stage_text_source(
        editor->snapshot().working_revision, asset_rml,
        "<rml><body><button "
        "onclick=\"Text.msg('missing.asset.message')\">Click</button></body></rml>");
    require(asset_overlay.accepted && !asset_overlay.snapshot.valid &&
                std::any_of(asset_overlay.snapshot.diagnostics.begin(),
                            asset_overlay.snapshot.diagnostics.end(),
                            [&](const Diagnostic& issue) {
                                return issue.code ==
                                           "authoring.localization.lua_named_message_missing" &&
                                       issue.source_path == asset_rml &&
                                       issue.path.starts_with("/layouts/");
                            }) &&
                read(temp.root / asset_rml) == saved_asset_rml,
            "Asset-backed Layout RML is indexed and validated without disk writes");
    {
        TemporaryProject template_fixture(fixture);
        auto linked = ProjectSession::open(template_fixture.root, error);
        require(linked != nullptr, "Sparse Asset template indexing fixture opens");
        const auto template_path = std::string("assets/ui/counter-template.rml");
        const auto saved_template = read(template_fixture.root / template_path);
        const auto changed_template = linked->stage_text_source(
            0, template_path, "<rml><body><nt-tr>Unsaved template</nt-tr></body></rml>");
        require(changed_template.accepted &&
                    std::find(changed_template.affected_records.begin(),
                              changed_template.affected_records.end(),
                              "layouts/flow-counter") != changed_template.affected_records.end(),
                "Sparse string template reference contributes to consuming Layout ownership");
        const auto restored = linked->stage_text_source(changed_template.snapshot.working_revision,
                                                        template_path, saved_template);
        require(restored.accepted, "Template overlay restores before Asset retargeting");
        const auto retargeted = linked->patch(
            restored.snapshot.working_revision,
            {{RoomPatch::Operation::Replace, "/assets/counter-template/data/source/path",
              R"("assets/ui/counter.rml")"}});
        require(retargeted.accepted, "Dirty Asset source retargeting is accepted");
        const auto stale_template =
            linked->stage_text_source(retargeted.snapshot.working_revision, template_path,
                                      "<rml><body><nt-tr>Old Asset source</nt-tr></body></rml>");
        require(stale_template.accepted &&
                    std::find(stale_template.affected_records.begin(),
                              stale_template.affected_records.end(),
                              "layouts/flow-counter") == stale_template.affected_records.end(),
                "Dirty Asset retargeting removes the old source-to-Layout association");
    }
}

void working_preparation_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    std::string error;
    auto editor = ProjectSession::open(temp.root, error);
    require(editor != nullptr, "Cannot admit editor preparation: " + error);
    const auto baseline = editor->prepare_working(0);
    if (!baseline.accepted) {
        std::cerr << "Baseline preparation rejected: " << baseline.error << "\n";
        for (const auto& issue : baseline.diagnostics)
            std::cerr << issue.path << " [" << issue.code << "] " << issue.message << "\n";
    }
    require(baseline.accepted && Json::parse(baseline.record_overrides_json).empty() &&
                Json::parse(baseline.project_json).at("project").at("name") == "Feature Lab",
            "Saved Project preview baseline has no dirty native record overrides");
    const auto shader = std::string("shaders/lab-grade.fs.sc");
    const auto original_shader = read(temp.root / shader);
    require(baseline.source_revisions.contains(shader),
            "Saved shader sources participate in runtime preparation identity");
    write(temp.root / shader, original_shader + "\n// native-cache-invalidation\n");
    editor->observe_sources();
    const auto after_shader = editor->prepare_working(0);
    require(after_shader.accepted &&
                baseline.source_revisions.at(shader) != after_shader.source_revisions.at(shader),
            "Saved shader changes invalidate preview and Test runtime cache inputs");
    write(temp.root / shader, original_shader);
    editor->observe_sources();
    const auto changed =
        editor->patch(0, {{RoomPatch::Operation::Replace, "/project/name", R"("Dirty Project")"},
                          {RoomPatch::Operation::Replace, "/rooms/room-lifecycle-roundtrip/label",
                           R"("Dirty Room")"},
                          {RoomPatch::Operation::Replace, "/tests/world-composition-flow/label",
                           R"("Dirty Test")"}});
    require(changed.accepted && changed.snapshot.valid,
            "Native preview certification accepts dirty Manifest, Room and Test patches");
    const auto script_path = std::string("scripts/notice-board.lua");
    const auto saved_script = read(temp.root / script_path);
    const auto script = editor->stage_text_source(changed.snapshot.working_revision, script_path,
                                                  "local label = Text.tr('Working Message')\n");
    require(script.accepted && script.snapshot.valid,
            "Native working preparation accepts unsaved managed Lua source");
    const auto rml_path = std::string("records/layouts/notice-board/layout.rml");
    const auto saved_markup = read(temp.root / rml_path);
    const auto markup =
        editor->stage_text_source(script.snapshot.working_revision, rml_path,
                                  "<rml><body><nt-tr>Working UI</nt-tr></body></rml>");
    require(markup.accepted && markup.snapshot.valid,
            "Native working preparation accepts unsaved RML source");
    const auto prepared =
        editor->prepare_working(markup.snapshot.working_revision, "world-composition-flow");
    require(
        prepared.accepted && prepared.working_revision == markup.snapshot.working_revision &&
            Json::parse(prepared.project_json).at("project").at("name") == "Dirty Project" &&
            Json::parse(prepared.record_overrides_json)
                    .at("rooms")
                    .at("room-lifecycle-roundtrip")
                    .at("label") == "Dirty Room" &&
            Json::parse(prepared.record_overrides_json)
                    .at("tests")
                    .at("world-composition-flow")
                    .at("label") == "Dirty Test" &&
            Json::parse(prepared.record_overrides_json)
                    .at("layouts")
                    .at("notice-board")
                    .at("data")
                    .at("rml")
                    .at("sourceText") == "<rml><body><nt-tr>Working UI</nt-tr></body></rml>" &&
            prepared.text_overlays.at(script_path).find("Working Message") != std::string::npos &&
            prepared.source_revisions.contains("records/tests/world-composition-flow.yaml"),
        "Preview and Test preparations capture only native dirty sources, revisions and owners");
    require(!editor->prepare_working(changed.snapshot.working_revision).accepted &&
                !editor->prepare_working(markup.snapshot.working_revision, "absent-test").accepted,
            "Native preparation rejects stale generations and missing authored Tests");
    require(read(temp.root / script_path) == saved_script &&
                read(temp.root / rml_path) == saved_markup,
            "Unsaved preview sources never rewrite physical Project files");
    auto cli = ProjectSession::open(temp.root, error);
    require(cli && cli->prepare_working(0).accepted &&
                Json::parse(cli->prepare_working(0).project_json).at("project").at("name") ==
                    "Feature Lab",
            "Independent CLI admission sees only saved disk state, not editor preview");
    const auto invalid = editor->stage_text_source(markup.snapshot.working_revision, script_path,
                                                   "Text.tr(dynamic)\n");
    require(invalid.accepted && !invalid.snapshot.valid &&
                !editor->prepare_working(invalid.snapshot.working_revision).accepted,
            "Dirty source validation failures block preview and authored Test preparation");
    auto text_editor = ProjectSession::open(temp.root, error);
    require(text_editor != nullptr, "Native text Save opens independent Project session");
    const auto text_staged =
        text_editor->stage_text_source(text_editor->snapshot().working_revision, script_path,
                                       saved_script + "\n-- xxh source revision\n");
    require(text_staged.accepted && text_staged.snapshot.valid,
            "Valid native Lua overlay is available for XXH3-128 Save precondition");
    require(!text_editor
                    ->save_text_sources(text_staged.snapshot.working_revision, {script_path},
                                        {{script_path, "xxh3-128:" + std::string(32, '0')}})
                    .accepted &&
                read(temp.root / script_path) == saved_script,
            "Stale XXH3-128 precondition does not publish the staged text");
    const auto text_saved = text_editor->save_text_sources(
        text_staged.snapshot.working_revision, {script_path},
        {{script_path, noveltea::core::xxh3_128_revision(saved_script)}});
    require(text_saved.accepted &&
                read(temp.root / script_path) == saved_script + "\n-- xxh source revision\n" &&
                text_saved.snapshot.valid,
            "Editor native text Save accepts correct XXH3-128 precondition and publishes XXH3-128");
}

void source_watcher_races(const std::filesystem::path& fixture)
{
#ifdef __linux__
    constexpr std::string_view source = "scripts/notice-board.lua";
    constexpr std::string_view changed = "\n-- open file writer must invalidate before close\n";
    const auto check_changed = [=](SourceAuthority& authority, std::string_view original,
                                   std::string_view reason) {
        require(!authority.fence(), reason);
        const auto observed = authority.observe();
        const auto* current = authority.verified_source(source);
        require(observed.authoritative && !observed.unchanged &&
                    std::find(observed.delta.changed.begin(), observed.delta.changed.end(),
                              source) != observed.delta.changed.end() &&
                    current && current->bytes != original && current->bytes.ends_with(changed),
                "Watcher observation must replace stale Lua evidence with actual written bytes");
    };
    {
        TemporaryProject temp(fixture);
        std::string error;
        SourceAuthority authority(temp.root);
        require(authority.initialize(error), "Open-writer watcher fixture: " + error);
        const auto path = temp.root / source;
        const auto original = read(path);
        const int fd = ::open(path.c_str(), O_WRONLY | O_APPEND | O_CLOEXEC);
        require(fd >= 0, "Open tracked Lua writer");
        require(::write(fd, changed.data(), changed.size()) ==
                        static_cast<ssize_t>(changed.size()) &&
                    ::fsync(fd) == 0,
                "Tracked Lua writer has flushed without closing");
        check_changed(authority, original, "An open writer invalidates pinned source generation");
        ::close(fd);
    }
    {
        TemporaryProject temp(fixture);
        const auto lexical = temp.root / source;
        const auto original = read(lexical);
        const auto target = temp.root / "untracked/helper.lua";
        std::filesystem::create_directories(target.parent_path());
        std::filesystem::rename(lexical, target);
        std::filesystem::create_symlink("../untracked/helper.lua", lexical);
        std::string error;
        SourceAuthority authority(temp.root);
        require(authority.initialize(error), "In-root symlinked Lua source admitted: " + error);
        require(authority.fence(), "Unchanged symlinked source starts with valid evidence");
        const int fd = ::open(target.c_str(), O_WRONLY | O_APPEND | O_CLOEXEC);
        require(fd >= 0 &&
                    ::write(fd, changed.data(), changed.size()) ==
                        static_cast<ssize_t>(changed.size()) &&
                    ::fsync(fd) == 0,
                "Unwatched symlink target is modified through its resolved path");
        ::close(fd);
        check_changed(authority, original,
                      "Unwatched symlink targets cannot pass pinned publication fence");
        require(authority.fence(), "Reproved symlink bytes allow a new pinned generation");
        std::filesystem::remove(lexical);
        const auto removed = authority.observe();
        require(removed.authoritative &&
                    std::find(removed.delta.removed.begin(), removed.delta.removed.end(), source) !=
                        removed.delta.removed.end() &&
                    authority.fence(),
                "Deleted lexical symlinks revoke their stale target proof and membership");
    }
    {
        TemporaryProject temp(fixture);
        const auto lexical = temp.root / source;
        const auto target = temp.root / "untracked/not-yet-created.lua";
        std::filesystem::create_directories(target.parent_path());
        std::filesystem::remove(lexical);
        std::filesystem::create_symlink("../untracked/not-yet-created.lua", lexical);
        std::string error;
        SourceAuthority authority(temp.root);
        require(authority.initialize(error) && authority.fence(),
                "Missing contained file-symlink target remains tracked as absent: " + error);
        write(target, "return true\n");
        require(!authority.fence(),
                "Creating an unwatched symlink target invalidates the absent generation");
        const auto appeared = authority.observe();
        require(appeared.authoritative &&
                    std::find(appeared.delta.added.begin(), appeared.delta.added.end(), source) !=
                        appeared.delta.added.end() &&
                    authority.verified_source(source) != nullptr && authority.fence(),
                "New symlink target is re-admitted with exact source bytes");
    }
#else
    (void)fixture;
#endif
}

void typed_reference_invalidation_roundtrip(const std::filesystem::path& fixture)
{
    const auto typed = semantic_graph_record_dependencies(
        "tests/review-test",
        R"({"data":{"steps":[{"expectations":[{"type":"active-flow","operator":"eq","activeFlow":{"kind":"scene","flowId":"review-isolated"}},{"type":"current-room","operator":"eq","currentRoom":{"roomId":"test-room"}},{"type":"property","property":{"scope":"global","propertyId":"test-variable"}},{"type":"layout","layout":{"layoutId":"test-layout"}}]}],"finalExpectations":[{"type":"active-flow","operator":"ne","activeFlow":{"kind":"dialogue","flowId":"test-dialogue"}}]},"label":"review-isolated"})");
    require(typed.size() == 5, "Test graph recognizes only five typed expectation references");
    const auto contains_identity = [&](std::string_view target) {
        return std::any_of(typed.begin(), typed.end(), [&](const auto& edge) {
            return edge.target_owner == target &&
                   edge.target_impact_paths ==
                       std::vector<std::string>{"/" + std::string(target) + "/@identity"};
        });
    };
    for (const auto target :
         {"scenes/review-isolated", "rooms/test-room", "variables/test-variable",
          "layouts/test-layout", "dialogues/test-dialogue"})
        require(contains_identity(target), "Test field identity is typed: " + std::string(target));

    TemporaryProject temp(fixture);
    const auto isolated = temp.root / "records/scenes/review-isolated.yaml";
    auto source = read(temp.root / "records/scenes/director-blank.yaml");
    require(source.starts_with("id: director-blank\n"), "Isolated Scene source can be cloned");
    source.replace(0, std::strlen("id: director-blank"), "id: review-isolated");
    write(isolated, source);

    const auto test_path = temp.root / "records/tests/runtime-diagnostics-ui.yaml";
    auto test_source = read(test_path);
    const auto position = test_source.find("flowId: runtime-diagnostics");
    require(position != std::string::npos, "Feature Lab has an active-flow Test expectation");
    test_source.replace(position, std::strlen("flowId: runtime-diagnostics"),
                        "flowId: review-isolated");
    write(test_path, test_source);

    std::string error;
    auto resident = ProjectSession::open(temp.root, error);
    require(resident != nullptr, "Isolated typed reference fixture admits: " + error);
    require(resident->validate_project().valid,
            "An isolated Scene referenced by a Test is initially valid");
    require(resident->validate_clean_project().snapshot.valid,
            "Typed Test reference fixture publishes a portable valid generation");
    auto imported = ProjectSession::open(temp.root, error);
    require(imported && imported->validate_clean_project().cache_hit,
            "An independent native session hydrates typed Test edges from portable cache");
    const auto signature = [](const RoomSessionSnapshot& snapshot) {
        std::vector<std::string> result;
        for (const auto& issue : snapshot.diagnostics)
            result.push_back(issue.code + "|" + issue.path + "|" + issue.message + "|" +
                             issue.severity + "|" + issue.source_path + "|" +
                             (issue.line ? std::to_string(*issue.line) : "") + "|" +
                             (issue.column ? std::to_string(*issue.column) : ""));
        return result;
    };
    const auto test_diagnostic = [](const RoomSessionSnapshot& snapshot) {
        return std::any_of(snapshot.diagnostics.begin(), snapshot.diagnostics.end(),
                           [](const Diagnostic& issue) {
                               return issue.code == "authoring.test.reference-missing" &&
                                      issue.path == "/tests/runtime-diagnostics-ui/data/steps/2/"
                                                    "expectations/1/activeFlow/flowId";
                           });
    };

    // A presentation-only change must not consume the Test's identity-only
    // edge or replace its retained valid diagnostic contribution.
    auto relabeled = source;
    const auto label = relabeled.find("label: director-blank");
    require(label != std::string::npos, "Isolated Scene presentation label exists");
    relabeled.replace(label, std::strlen("label: director-blank"),
                      "label: Isolated presentation edit");
    write(isolated, relabeled);
    require(resident->validate_project().valid &&
                resident->validation_work().rechecked_contributions == 1,
            "Unconsumed Scene label rechecks only its own semantic contribution");

    std::filesystem::remove(isolated);
    const auto missing = resident->validate_project();
    require(!missing.valid && test_diagnostic(missing) &&
                resident->validation_work().rechecked_contributions > 0,
            "Deleting a Scene revokes the cached valid Test expectation");
    require(
        resident->validation_work().semantic_fallback_reasons.contains("test-identity-inventory"),
        "A record inventory change explains its conservative Test recheck");
    const auto missing_retained = resident->validate_project();
    require(!missing_retained.valid && test_diagnostic(missing_retained) &&
                resident->validation_work().rechecked_contributions == 0,
            "Unchanged invalid Test diagnostics are retained without rechecking");
    auto cold = ProjectSession::open(temp.root, error);
    require(cold && signature(cold->validate_project()) == signature(missing),
            "Missing-Scene warm and cold diagnostics agree in order and locations");
    const auto imported_missing = imported->validate_project();
    require(test_diagnostic(imported_missing) && signature(imported_missing) == signature(missing),
            "Portable-hydrated Test reverse edges also revoke stale success after Scene deletion");
    write(isolated, source);
    const auto restored = resident->validate_project();
    cold = ProjectSession::open(temp.root, error);
    require(restored.valid && !test_diagnostic(restored) && cold &&
                signature(cold->validate_project()) == signature(restored),
            "Restoring the Scene retracts the missing Test diagnostic with cold parity");

    // Rewire the expectation to a different existing Scene. The old identity
    // must no longer invalidate this Test when it disappears.
    const auto old_flow = test_source.find("flowId: review-isolated");
    require(old_flow != std::string::npos, "Isolated Test reference can be rewired");
    test_source.replace(old_flow, std::strlen("flowId: review-isolated"), "flowId: director-blank");
    write(test_path, test_source);
    require(resident->validate_project().valid, "Rewired Test expectation is valid");
    std::filesystem::remove(isolated);
    const auto rewired = resident->validate_project();
    cold = ProjectSession::open(temp.root, error);
    require(rewired.valid && !test_diagnostic(rewired) && cold &&
                signature(cold->validate_project()) == signature(rewired),
            "Deleting the former Scene target leaves the rewired Test valid");
}

void project_validation_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    // SourceAuthority's semantic registry must pin exact bytes to each
    // observed revision and replace the entry after physical changes.
    {
        SourceAuthority authority(temp.root);
        std::string source_error;
        require(authority.initialize(source_error),
                "Physical Project source registry initializes: " + source_error);
        const auto* initial =
            authority.verified_source("records/rooms/room-lifecycle-roundtrip.yaml");
        require(initial != nullptr, "Initial physical room source is retained");
        ValidationWorkCounters quiet_work;
        SourceObservation quiet;
        {
            ScopedValidationWork measure(quiet_work);
            quiet = authority.observe();
        }
#ifdef __linux__
        require(quiet.authoritative && quiet.unchanged &&
                    authority.verified_source("records/rooms/room-lifecycle-roundtrip.yaml") ==
                        initial &&
                    quiet_work.source_captures == 1 && quiet_work.directory_enumerations == 0 &&
                    quiet_work.file_byte_reads == 0 && quiet_work.content_hashes == 0 &&
                    quiet_work.parsed_yaml == 0,
                "Healthy watcher reuses unchanged directory and source evidence without IO");
        require(authority.fence(), "Quiet resident generation has an unchanged watcher epoch");
        authority.hint("records/rooms/room-lifecycle-roundtrip.yaml");
        require(!authority.fence(),
                "An explicitly reported source path revokes the pinned publication epoch");
        require(authority.observe().authoritative,
                "Revoked pinned source generation is re-admitted before further reads");
#else
        require(quiet.authoritative && quiet.unchanged,
                "Platform without native watchers retains conservative physical observation");
#endif
        const auto scripts = temp.root / "scripts";
        const auto relocated_scripts = temp.root / "scripts-observer-relocated";
        std::filesystem::rename(scripts, relocated_scripts);
        std::filesystem::create_directory(scripts);
        write(scripts / "replacement.lua", "return true\n");
        const auto replaced = authority.observe();
        require(replaced.authoritative &&
                    std::find(replaced.delta.added.begin(), replaced.delta.added.end(),
                              "scripts/replacement.lua") != replaced.delta.added.end() &&
                    std::find(replaced.delta.removed.begin(), replaced.delta.removed.end(),
                              "scripts/notice-board.lua") != replaced.delta.removed.end(),
                "Replacing a top-level watched source directory refreshes its entire membership");
        std::filesystem::remove_all(scripts);
        std::filesystem::rename(relocated_scripts, scripts);
        require(authority.observe().authoritative &&
                    authority.verified_revisions()->contains("scripts/notice-board.lua"),
                "Restoring top-level source directory restores its watched source inventory");
        const std::string owner = "records/rooms/room-lifecycle-roundtrip.yaml";
        const auto before = read(temp.root / owner);
        const auto* first = authority.verified_source(owner);
        require(first && first->yaml && first->yaml->accepted && first->bytes == before &&
                    first->revision == exact_source_revision(before),
                "Verified source entry pins exact bytes, revision and YAML locations");
        require(first->size == before.size() &&
                    first->modified == std::filesystem::last_write_time(temp.root / owner),
                "Verified source retains exact file metadata with observed bytes");
        const auto previous_time = first->modified;
        const auto previous_bytes = first->bytes;
        const auto previous_revision = first->revision;
        std::filesystem::last_write_time(temp.root / owner,
                                         previous_time - std::chrono::seconds(2));
        authority.hint(owner);
        const auto metadata_observation = authority.observe();
        const auto* timestamp_only = authority.verified_source(owner);
        require(metadata_observation.authoritative && metadata_observation.delta.changed.empty() &&
                    timestamp_only && timestamp_only->revision == previous_revision &&
                    timestamp_only->modified ==
                        std::filesystem::last_write_time(temp.root / owner) &&
                    timestamp_only->bytes == previous_bytes &&
                    previous_time != timestamp_only->modified,
                "Timestamp-only notification updates retained metadata without changing source "
                "identity");
        const auto original_revision = previous_revision;
        write(temp.root / owner, before + "\n# physical generation change\n");
        const auto observed = authority.observe();
        const auto* changed = authority.verified_source(owner);
        require(observed.authoritative && changed && changed->yaml && changed->yaml->accepted &&
                    changed->revision != original_revision &&
                    changed->bytes == before + "\n# physical generation change\n",
                "Physical edit replaces source evidence even when normalized YAML is unchanged");
        write(temp.root / owner, before);
        require(authority.observe().authoritative && authority.verified_source(owner) &&
                    authority.verified_source(owner)->revision == original_revision,
                "Restoring exact source bytes restores their verified identity");
        write(temp.root / owner, before + "\n# acknowledged XXH3 write\n");
        require(authority.acknowledge_own_write(
                    owner, noveltea::core::xxh3_128_revision(read(temp.root / owner))),
                "Native source observer accepts verified XXH3-128 own-write identity");
        const auto own_observation = authority.observe();
        require(own_observation.authoritative && own_observation.delta.changed.empty(),
                "Native source observer stores canonical XXH3-128 after own-write proof");
        write(temp.root / owner, before);
        require(authority.observe().authoritative,
                "Source observer restores original bytes after XXH3-128 certification");
    }
    std::string error;
    auto project = ProjectSession::open(temp.root, error);
    require(project != nullptr, "Cannot admit full native validation: " + error);
    // Native worker diagnostics must consume the same immutable physical
    // capture as SourceAuthority. A subsequent edit cannot mutate its bytes
    // or revision; the next observation must discover the newer generation.
    {
        const std::string owner = "records/rooms/room-lifecycle-roundtrip.yaml";
        const auto original = read(temp.root / owner);
        const auto first_edit = original + "\n# native observer capture A\n";
        const auto second_edit = original + "\n# native observer capture B\n";
        write(temp.root / owner, first_edit);
        const auto first_observation = project->observe_sources();
        const auto* captured = project->verified_observed_source(owner);
        require(first_observation.authoritative && captured && captured->yaml &&
                    captured->yaml->accepted && captured->bytes == first_edit &&
                    first_observation.delta_revisions.at(owner) == captured->revision,
                "Project diagnostic capture uses exact observed bytes and revision");
        write(temp.root / owner, second_edit);
        require(captured->bytes == first_edit &&
                    captured->revision == exact_source_revision(first_edit),
                "Previously verified diagnostic bytes remain immutable after an external edit");
        const auto later = project->observe_sources();
        const auto* updated = project->verified_observed_source(owner);
        require(later.authoritative && updated && updated->bytes == second_edit &&
                    later.delta_revisions.at(owner) == updated->revision,
                "Next observer poll verifies the later external generation");
        write(temp.root / owner, original);
        require(project->observe_sources().authoritative,
                "Restored native Project source is verified before subsequent certification");
    }
    const auto cold = project->validate_project();
    if (!cold.valid)
        for (const auto& issue : cold.diagnostics)
            std::cerr << "Full Project diagnostic: " << issue.path << " [" << issue.code << "] "
                      << issue.message << '\n';
    require(cold.valid, "Feature Lab must pass complete cold native Project validation");
    require(project->validation_work().rechecked_records > 0,
            "Cold Project validation checks tracked record sources");
    ValidationWorkCounters repeated_work;
    RoomSessionSnapshot repeated;
    {
        ScopedValidationWork measure(repeated_work);
        repeated = project->validate_project();
    }
    require(repeated_work.source_captures > 0,
            "Warm native validation still invokes source observation");
    require(repeated.valid && project->validation_work().rechecked_records == 0 &&
                project->validation_work().retained_records > 0,
            "Unchanged native validation retains every source contribution");

    const auto signature = [](const RoomSessionSnapshot& snapshot) {
        std::multiset<std::string> result;
        for (const auto& issue : snapshot.diagnostics)
            result.insert(issue.code + "|" + issue.path + "|" + issue.severity + "|" +
                          issue.source_path + "|" +
                          (issue.line ? std::to_string(*issue.line) : "") + "|" +
                          (issue.column ? std::to_string(*issue.column) : ""));
        return result;
    };
    const auto ordered_signature = [](const RoomSessionSnapshot& snapshot) {
        std::vector<std::string> result;
        for (const auto& issue : snapshot.diagnostics)
            result.push_back(issue.code + "|" + issue.path + "|" + issue.severity + "|" +
                             issue.message + "|" + issue.source_path + "|" +
                             (issue.line ? std::to_string(*issue.line) : "") + "|" +
                             (issue.column ? std::to_string(*issue.column) : ""));
        return result;
    };
    const auto media = temp.root / "assets/images/girl_normal.webp";
    const auto original_media = read(media);
    std::filesystem::remove(media);
    const auto removed_asset_observation = project->observe_sources();
    require(std::find(removed_asset_observation.delta.removed.begin(),
                      removed_asset_observation.delta.removed.end(),
                      "assets/images/girl_normal.webp") !=
                removed_asset_observation.delta.removed.end(),
            "Native watcher detects missing referenced binary before validation");
    const auto missing_media = project->validate_project();
    require(
        !missing_media.valid &&
            std::any_of(
                missing_media.diagnostics.begin(), missing_media.diagnostics.end(),
                [](const Diagnostic& issue) { return issue.code == "asset.source.missing"; }) &&
            project->validation_work().rechecked_records > 0,
        "A physical Asset deletion invalidates a resident full-Project proof without a YAML edit");
    write(media, original_media);
    const auto restored_media = project->validate_project();
    require(restored_media.valid && signature(restored_media) == signature(cold) &&
                project->validation_work().rechecked_records > 0,
            "Restoring physical Asset membership refreshes the dependent full-Project contributor");
    require(project->validate_project().valid && project->validation_work().rechecked_records == 0,
            "Restored physical Asset proof is reusable after revalidation");
    // CLI-owned native validation and the opt-in editor addon use this same
    // disk-only cache boundary. A dirty editor view must never overwrite it.
    const auto cached_path = temp.root / ".noveltea/cache/authoring/native-clean-current.json";
    const auto published = project->validate_clean_project();
    require(!published.cache_hit && signature(published.snapshot) == signature(cold) &&
                std::filesystem::is_regular_file(cached_path),
            "Native resident validation publishes its exact clean generation");
    auto editor = ProjectSession::open(temp.root, error);
    require(editor != nullptr, "Clean editor Project can open: " + error);
    ValidationWorkCounters restored_work;
    ProjectSession::CleanValidation editor_hit;
    {
        ScopedValidationWork measured(restored_work);
        editor_hit = editor->validate_clean_project();
    }
    // Hashing the saved contributor bytes is necessary to bind their contents
    // to the exact source proof; it is not semantic revalidation or hydration.
    require(restored_work.parsed_lua == 0 && restored_work.parsed_rml == 0 &&
                restored_work.parsed_rcss == 0 &&
                editor->validation_work().rechecked_contributions == 0,
            "Cold ledger restoration must not hydrate and analyze unchanged record contents");
    require(editor_hit.cache_hit && signature(editor_hit.snapshot) == signature(cold),
            "Independently opened editor session consumes the native CLI generation");
    const std::string cache_room = "records/rooms/room-lifecycle-roundtrip.yaml";
    const auto cache_room_bytes = read(temp.root / cache_room);
    const auto before_label = cache_room_bytes.find("label: ");
    require(before_label != std::string::npos, "Cache fixture Room label is present");
    auto changed_label = cache_room_bytes;
    changed_label.replace(before_label, changed_label.find('\n', before_label) - before_label,
                          "label: Native cache changed");
    write(temp.root / cache_room, changed_label);
    const auto editor_first_change = editor->validate_clean_project();
    require(!editor_first_change.cache_hit && editor_first_change.snapshot.valid &&
                signature(editor_first_change.snapshot) == signature(cold) &&
                editor->validation_work().rechecked_records == 1 &&
                editor->validation_work().rechecked_contributions == 1 &&
                editor->validation_work().retained_records > 0,
            "First presentation-only disk edit after cross-host cache import rechecks one owner");
    auto independent_cli = ProjectSession::open(temp.root, error);
    require(independent_cli && independent_cli->validate_clean_project().cache_hit,
            "Presentation-only edit publishes a clean generation consumable by a new CLI owner");
    write(temp.root / cache_room, cache_room_bytes);
    const auto editor_revert = editor->validate_clean_project();
    require(!editor_revert.cache_hit && signature(editor_revert.snapshot) == signature(cold) &&
                editor->validation_work().rechecked_records == 1,
            "Reverting a cached presentation-only source retains contributor incrementality");
    // The daemon's owner eviction/restart drops RAM state but the new owner
    // can still re-prove and reuse the unchanged portable exact result.
    independent_cli.reset();
    independent_cli = ProjectSession::open(temp.root, error);
    require(independent_cli && independent_cli->validate_clean_project().cache_hit,
            "Eviction and fresh daemon owner admission recheck physical cache proof");
    const auto cache_bytes = read(cached_path);
    const auto cache_value = Json::parse(cache_bytes);
    {
        auto inconsistent = cache_value;
        auto& contributors = inconsistent.at("resident").at("contributions");
        require(!contributors.empty(), "Cold cache fixture contains contributor records");
        auto& first = contributors.object_range().begin()->value();
        first.at("record").at("bytes") = "id: substituted-on-disk\n";
        write(cached_path, inconsistent.to_string());
        auto reopened = ProjectSession::open(temp.root, error);
        require(
            reopened && !reopened->validate_clean_project().cache_hit,
            "Cold cache rejects saved record bytes inconsistent with the proved source revision");
        write(cached_path, cache_bytes);
    }
    {
        auto inconsistent = cache_value;
        auto& contributors = inconsistent.at("resident").at("contributions");
        require(!contributors.empty(), "Cold cache fixture contains normalized contributors");
        contributors.object_range().begin()->value().at("record").at("normalized") = "null";
        write(cached_path, inconsistent.to_string());
        auto reopened = ProjectSession::open(temp.root, error);
        require(
            reopened && !reopened->validate_clean_project().cache_hit,
            "Cold cache rejects altered derived normalized data even with unchanged source bytes");
        write(cached_path, cache_bytes);
    }
    for (const auto& malformed :
         {cache_bytes.substr(0, cache_bytes.size() / 2), std::string("{\"contract\":null}")}) {
        write(cached_path, malformed);
        auto recovered = ProjectSession::open(temp.root, error);
        require(recovered && !recovered->validate_clean_project().cache_hit &&
                    signature(recovered->validate_project()) == signature(cold),
                "Truncated or malformed ledgers fall back to authoritative validation");
        write(cached_path, cache_bytes);
    }
    {
        auto malformed = cache_value;
        auto& contributors = malformed.at("resident").at("contributions");
        require(!contributors.empty(), "Cold certification fixture contains resident contributors");
        auto& first = contributors.object_range().begin()->value();
        first.at("dependencies") = Json::array();
        Json invalid_dependency = Json::object();
        invalid_dependency["owner"] = "rooms/other";
        invalid_dependency["paths"] = "wrong-type";
        first.at("dependencies").push_back(std::move(invalid_dependency));
        write(cached_path, malformed.to_string());
        auto recovered = ProjectSession::open(temp.root, error);
        require(recovered && !recovered->validate_clean_project().cache_hit &&
                    signature(recovered->validate_project()) == signature(cold),
                "Malformed semantic dependencies must reject the optional ledger before admission");
        write(cached_path, cache_bytes);
    }
    {
        auto publishing = ProjectSession::open(temp.root, error);
        require(publishing != nullptr, "Deferred-publisher fixture can open");
        const auto stale = publishing->validate_clean_project(false, true);
        require(stale.cache_hit && stale.deferred_exact_revisions.has_value(),
                "Cold publication returns a deferred generation token");
        publishing->source_watch_coverage_lost();
        auto refreshed = publishing->validate_clean_project(false, true);
        if (!refreshed.deferred_exact_revisions)
            refreshed = publishing->validate_clean_project(false, true);
        require(refreshed.deferred_exact_revisions.has_value() &&
                    refreshed.validation_generation != stale.validation_generation,
                "A new validated generation gets a distinct publication token");
        require(
            !publishing->publish_deferred_clean_validation(stale, *stale.deferred_exact_revisions),
            "A stale deferred result must not publish over a newer verified generation");
        require(publishing->publish_deferred_clean_validation(refreshed,
                                                              *refreshed.deferred_exact_revisions),
                "Rejecting a stale publication does not revoke the newer verified generation");
    }
    require(cache_value.at("sourceRevisionAlgorithm") == "xxh3-128" &&
                cache_value.at("assetProofAlgorithm") == "xxh3-128",
            "Native cache explicitly records both local hash algorithms");
    for (const auto& key : {"sourceRevisionAlgorithm", "assetProofAlgorithm"}) {
        auto corrupted = cache_value;
        corrupted[key] = "wrong-algorithm";
        write(cached_path, corrupted.to_string());
        auto incompatible = ProjectSession::open(temp.root, error);
        require(incompatible && !incompatible->validate_clean_project().cache_hit,
                "Native clean cache rejects evidence published under an incompatible algorithm");
        write(cached_path, cache_bytes);
    }
    const auto unsaved = editor->patch(
        editor->snapshot().working_revision,
        {{RoomPatch::Operation::Replace, "/rooms/room-lifecycle-roundtrip/label", "\"Unsaved\""}});
    require(unsaved.accepted, "Editor working copy can be patched independently");
    const auto private_result = editor->validate_clean_project();
    require(!private_result.cache_hit && read(cached_path) == cache_bytes,
            "Dirty editor validation remains private and does not replace clean cache bytes");
    // Working validation is private to the editor generation. A pinned,
    // unchanged Linux watcher epoch needs no additional physical source
    // captures, even though the working Room label differs from disk.
    {
        ValidationWorkCounters counts;
        ScopedValidationWork measured(counts);
        const auto working = editor->validate_working_project();
        require(working.valid && working.dirty &&
                    working.working_revision == editor->working_revision() &&
                    read(cached_path) == cache_bytes,
                "Unsaved Room label is validated without publishing disk cache");
#ifdef __linux__
        require(counts.source_captures == 0,
                "Unchanged working generation validates without disk source recapture");
#endif
    }
    const auto changed_again =
        editor->patch(editor->working_revision(),
                      {{RoomPatch::Operation::Replace, "/rooms/room-lifecycle-roundtrip/label",
                        "\"Unsaved again\""}});
    require(changed_again.accepted, "Second unsaved Room label edit is admitted");
    const auto working_again = editor->validate_working_project();
    require(working_again.valid && editor->validation_work().rechecked_records == 1 &&
                editor->validation_work().rechecked_contributions == 1 &&
                editor->validation_work().global_stage_reuses == 1 &&
                editor->validation_work().source_location_rebuilds == 0,
            "Editor label edit rechecks one contribution and reuses global/source locations");
    const auto stable_working = editor->validate_working_project();
    require(stable_working.valid && editor->validation_work().rechecked_records == 0 &&
                editor->validation_work().diagnostic_assemblies == 0,
            "Unchanged working generation retains its diagnostic result");

    const std::string overlay_path = "scripts/notice-board.lua";
    const auto original_overlay = read(temp.root / overlay_path);
    const auto staged_overlay = editor->stage_text_source(
        editor->working_revision(), overlay_path, original_overlay + "\nText.tr(dynamic)\n");
    require(staged_overlay.accepted, "Editor accepts private Lua source overlay");
    const auto invalid_overlay = editor->validate_working_project();
    require(!invalid_overlay.valid &&
                std::any_of(invalid_overlay.diagnostics.begin(), invalid_overlay.diagnostics.end(),
                            [](const Diagnostic& issue) {
                                return issue.code == "authoring.localization.lua_source_literal";
                            }) &&
                editor->validation_work().rechecked_records == 0 &&
                read(temp.root / overlay_path) == original_overlay &&
                read(cached_path) == cache_bytes,
            "Unsaved Lua errors update working diagnostics only, without scanning records or disk "
            "writes");
    require(editor->stage_text_source(editor->working_revision(), overlay_path, original_overlay)
                    .accepted &&
                editor->validate_working_project().valid,
            "Undoing Lua overlay restores the retained working validation");
    const std::string rml_path = "records/layouts/notice-board/layout.rml";
    const auto original_rml = read(temp.root / rml_path);
    require(editor
                ->stage_text_source(
                    editor->working_revision(), rml_path,
                    "<rml><body><button onclick=\"Text.msg('absent.message')\">Review</button>"
                    "<script src=\"project:/scripts/not-declared.lua\" /></body></rml>")
                .accepted,
            "Editor stages working RML buffer without changing its disk source");
    const auto invalid_rml = editor->validate_working_project();
    require(!invalid_rml.valid &&
                std::any_of(invalid_rml.diagnostics.begin(), invalid_rml.diagnostics.end(),
                            [&](const Diagnostic& issue) {
                                return issue.code ==
                                           "authoring.localization.lua_named_message_missing" &&
                                       issue.source_path == rml_path;
                            }) &&
                editor->validation_work().rechecked_records == 0 &&
                read(temp.root / rml_path) == original_rml && read(cached_path) == cache_bytes,
            "Working RML references invalidate their analysis but not disk contributors");
    require(
        editor->stage_text_source(editor->working_revision(), rml_path, original_rml).accepted &&
            editor->validate_working_project().valid,
        "RML undo restores working validation without a disk write");
    auto cli = ProjectSession::open(temp.root, error);
    require(cli != nullptr && cli->validate_clean_project().cache_hit,
            "CLI Project still consumes the clean generation after an unsaved editor edit");

    // Unlike an imported result, this independently validated warm owner has
    // real in-memory dependency contributions for all tracked record families.
    write(temp.root / cache_room, changed_label);
    const auto incremental = project->validate_clean_project();
    require(!incremental.cache_hit && incremental.snapshot.valid &&
                project->validation_work().rechecked_records == 1,
            "One disk Room edit invalidates only its existing resident validation record");
    cli = ProjectSession::open(temp.root, error);
    require(cli != nullptr && cli->validate_clean_project().cache_hit,
            "Editor-written native generation is reusable by an independent CLI owner");
    write(temp.root / cache_room, cache_room_bytes);
    require(project->validate_clean_project().snapshot.valid,
            "Restored disk source regenerates the original clean cache proof");
    write(cached_path, "{\"schema\":\"noveltea.authoring-cache\"}\n");
    cli = ProjectSession::open(temp.root, error);
    require(cli && !cli->validate_clean_project().cache_hit,
            "Legacy or malformed validation cache is rejected without a migration reader");
    project->source_watch_coverage_lost();
    const auto recovered_authority = project->validate_clean_project();
    require(!recovered_authority.cache_hit && recovered_authority.snapshot.valid &&
                project->validation_work().rechecked_records > 0,
            "Watch coverage loss requires a fresh native validation before result reuse");

    const std::string path = "scripts/notice-board.lua";
    const auto original = read(temp.root / path);
    write(temp.root / path, original + "\nText.tr(dynamic)\n");
    const auto separately_observed = project->observe_sources();
    require(std::find(separately_observed.delta.changed.begin(),
                      separately_observed.delta.changed.end(),
                      path) != separately_observed.delta.changed.end(),
            "The independent native watcher observes the edited Lua source");
    const auto after_invalid = project->validate_project();
    require(!after_invalid.valid &&
                std::any_of(after_invalid.diagnostics.begin(), after_invalid.diagnostics.end(),
                            [](const Diagnostic& issue) {
                                return issue.code == "authoring.localization.lua_source_literal";
                            }),
            "Changed Lua source revokes old valid diagnostic proof");
    require(project->validation_work().rechecked_records == 0,
            "Source-only edit does not reparse unrelated YAML records");
    auto fresh = ProjectSession::open(temp.root, error);
    require(fresh != nullptr && signature(fresh->validate_project()) == signature(after_invalid),
            "Cold and warm invalid Lua diagnostics have identical codes and navigation");
    write(temp.root / path, original);
    const auto repaired = project->validate_project();
    require(repaired.valid && signature(repaired) == signature(cold),
            "Repairing one Lua source withdraws only its stale diagnostics");

    const std::string record_path = "records/rooms/room-lifecycle-roundtrip.yaml";
    const auto original_room = read(temp.root / record_path);
    const auto label_position = original_room.find("label: ");
    require(label_position != std::string::npos, "Room fixture needs a sparse label");
    auto relabeled = original_room;
    const auto label_end = relabeled.find('\n', label_position);
    relabeled.replace(label_position, label_end - label_position, "label: Incremental Room");
    write(temp.root / record_path, relabeled);
    const auto changed_room = project->validate_project();
    require(changed_room.valid && project->validation_work().rechecked_records == 1 &&
                project->validation_work().retained_records > 0 &&
                project->validation_work().rechecked_contributions == 1 &&
                project->validation_work().retained_contributions > 0 &&
                project->validation_work().global_stage_executions == 0 &&
                project->validation_work().global_stage_reuses == 1 &&
                project->validation_work().diagnostic_assemblies == 1,
            "One presentation edit rechecks its contribution and reuses global diagnostics");
    const auto unchanged_after_label = project->validate_project();
    require(ordered_signature(unchanged_after_label) == ordered_signature(changed_room) &&
                project->validation_work().global_stage_executions == 0 &&
                project->validation_work().diagnostic_assemblies == 0 &&
                project->validation_work().source_location_rebuilds == 0,
            "Unchanged resident validation assembles no diagnostics or source locations");
    fresh = ProjectSession::open(temp.root, error);
    require(fresh && signature(fresh->validate_project()) == signature(changed_room),
            "Changed Room cold/warm semantic diagnostics agree");
    write(temp.root / record_path, original_room);
    require(project->validate_project().valid, "Reverted Room returns to original valid state");

    // Typed validation edges are the native semantic graph's edges, not a
    // second index of every string that resembles a record ID.
    const auto typed = semantic_graph_record_dependencies(
        "animations/typed-test",
        R"({"label":"ui-pattern","data":{"motions":[{"frames":[{"image":"ui-pattern"}]}]}})");
    require(typed.size() == 1 && typed.front().target_owner == "assets/ui-pattern" &&
                typed.front().target_impact_paths ==
                    std::vector<std::string>{"/assets/ui-pattern/data/kind"},
            "Only graph-admitted Animation image fields create Asset validation dependencies");
    const auto flow_edges = semantic_graph_record_dependencies(
        "scenes/typed-test",
        R"({"label":"director-inherited","data":{"events":[{"type":"call-scene","scene":"director-inherited"}]}})");
    require(flow_edges.size() == 1 &&
                flow_edges.front().target_owner == "scenes/director-inherited" &&
                std::find(flow_edges.front().target_impact_paths.begin(),
                          flow_edges.front().target_impact_paths.end(),
                          "/scenes/director-inherited/data/inputs") !=
                    flow_edges.front().target_impact_paths.end(),
            "Scalar Flow calls use the same typed graph and Scene input dependency paths");

    const auto asset_path = temp.root / "records/assets/ui-pattern.yaml";
    const auto original_asset = read(asset_path);
    auto asset_label = original_asset;
    const auto asset_label_position = asset_label.find("label: ui-pattern");
    require(asset_label_position != std::string::npos, "Typed Asset fixture label exists");
    asset_label.replace(asset_label_position, std::strlen("label: ui-pattern"),
                        "label: A different presentation label");
    write(asset_path, asset_label);
    const auto label_only = project->validate_project();
    require(label_only.valid && project->validation_work().rechecked_records == 1 &&
                project->validation_work().rechecked_contributions == 1 &&
                project->validation_work().global_stage_executions == 1,
            "Asset label edits recheck no typed Animation consumers but retain global scrutiny");
    auto asset_kind = asset_label;
    const auto kind_position = asset_kind.find("kind: image");
    require(kind_position != std::string::npos, "Typed Asset fixture kind exists");
    asset_kind.replace(kind_position, std::strlen("kind: image"), "kind: audio");
    write(asset_path, asset_kind);
    const auto changed_kind = project->validate_project();
    const auto typed_work = project->validation_work();
    require(!changed_kind.valid && typed_work.rechecked_records == 1 &&
                typed_work.rechecked_contributions > 1 &&
                std::any_of(changed_kind.diagnostics.begin(), changed_kind.diagnostics.end(),
                            [](const Diagnostic& issue) {
                                return issue.path.starts_with("/animations/custom-board-loop/");
                            }),
            "Changing consumed Asset kind rechecks its typed Animation and diagnostics");
    auto independent = ProjectSession::open(temp.root, error);
    require(independent && ordered_signature(independent->validate_project()) ==
                               ordered_signature(changed_kind),
            "Changed typed-dependency diagnostics match fresh validation including order and "
            "locations");
    write(asset_path, original_asset);
    require(project->validate_project().valid &&
                signature(project->validate_project()) == signature(cold),
            "Restored typed Asset target revokes its stale dependent diagnostics");

    std::filesystem::remove(asset_path);
    const auto missing_identity = project->validate_project();
    require(!missing_identity.valid && project->validation_work().rechecked_contributions > 1,
            "A present-to-missing typed target invalidates previously resolved consumers");
    write(asset_path, original_asset);
    const auto restored_identity = project->validate_project();
    require(restored_identity.valid && signature(restored_identity) == signature(cold) &&
                project->validation_work().rechecked_contributions > 1,
            "A missing-to-present target invalidates previously unresolved consumers");

    // Rewiring drops the old reverse edge as well as admitting the new edge.
    // A later change to the former target must not diagnose the rewired
    // Animation; a change to the new target must diagnose it.
    const auto animation_path = temp.root / "records/animations/custom-board-loop.yaml";
    const auto original_animation = read(animation_path);
    auto rewired_animation = original_animation;
    std::size_t replacement = 0;
    for (std::size_t at = 0;
         (at = rewired_animation.find("image: ui-pattern", at)) != std::string::npos;) {
        rewired_animation.replace(at, std::strlen("image: ui-pattern"),
                                  "image: pilot-button-sprite");
        at += std::strlen("image: pilot-button-sprite");
        ++replacement;
    }
    require(replacement == 3, "Animation fixture has three image references to rewire");
    write(animation_path, rewired_animation);
    require(project->validate_project().valid, "Rewired Animation target remains valid");
    write(asset_path, asset_kind);
    const auto old_target_changed = project->validate_project();
    require(std::none_of(old_target_changed.diagnostics.begin(),
                         old_target_changed.diagnostics.end(),
                         [](const Diagnostic& issue) {
                             return issue.path.starts_with("/animations/custom-board-loop/");
                         }),
            "Rewired Animation no longer consumes old Asset identity");
    write(asset_path, original_asset);
    require(project->validate_project().valid, "Old Asset target can be restored");
    const auto new_asset_path = temp.root / "records/assets/pilot-button-sprite.yaml";
    const auto original_new_asset = read(new_asset_path);
    auto changed_new_asset = original_new_asset;
    const auto new_kind = changed_new_asset.find("kind: image");
    require(new_kind != std::string::npos, "Rewired target is a valid image Asset");
    changed_new_asset.replace(new_kind, std::strlen("kind: image"), "kind: audio");
    write(new_asset_path, changed_new_asset);
    const auto new_target_changed = project->validate_project();
    require(!new_target_changed.valid &&
                std::any_of(new_target_changed.diagnostics.begin(),
                            new_target_changed.diagnostics.end(),
                            [](const Diagnostic& issue) {
                                return issue.path.starts_with("/animations/custom-board-loop/");
                            }),
            "Rewired Animation now consumes new Asset identity");
    write(new_asset_path, original_new_asset);
    write(animation_path, original_animation);
    require(project->validate_project().valid &&
                signature(project->validate_project()) == signature(cold),
            "Reverting both sides of a typed reference restores original diagnostics");

    write(temp.root / record_path, "not: [valid\n");
    const auto broken = project->validate_project();
    require(!broken.valid && std::any_of(broken.diagnostics.begin(), broken.diagnostics.end(),
                                         [&](const Diagnostic& issue) {
                                             return issue.source_path == record_path &&
                                                    issue.severity == "error";
                                         }),
            "Invalid edited YAML revokes its record and supplies a physical diagnostic");
    require(!ProjectSession::open(temp.root, error),
            "Mutable Project admission still rejects malformed saved YAML");
    const auto cold_invalid = ProjectSession::validate_cold_project(temp.root, error);
    require(cold_invalid.has_value(), "Cold invalid YAML Project must remain inspectable");
    const auto cold_broken = signature(*cold_invalid);
    const auto warm_broken = signature(broken);
    if (cold_broken != warm_broken) {
        std::vector<std::string> cold_only, warm_only;
        std::set_difference(cold_broken.begin(), cold_broken.end(), warm_broken.begin(),
                            warm_broken.end(), std::back_inserter(cold_only));
        std::set_difference(warm_broken.begin(), warm_broken.end(), cold_broken.begin(),
                            cold_broken.end(), std::back_inserter(warm_only));
        for (const auto& issue : cold_only)
            std::cerr << "Cold-only diagnostic: " << issue << '\n';
        for (const auto& issue : warm_only)
            std::cerr << "Warm-only diagnostic: " << issue << '\n';
    }
    require(cold_broken == warm_broken,
            "Cold and warm invalid-YAML diagnostics agree including physical owner attribution");
    const auto retained_invalid = project->validate_project();
    require(!retained_invalid.valid && signature(retained_invalid) == warm_broken,
            "Stable invalid physical evidence retains the complete diagnostic proof");
    require(project->validation_work().rechecked_records == 0 &&
                project->validation_work().retained_records > 0,
            "Stable invalid physical evidence does not reparse unchanged YAML owners");
    write(temp.root / record_path, original_room);
    const auto restored = project->validate_project();
    fresh = ProjectSession::open(temp.root, error);
    require(restored.valid && fresh != nullptr &&
                signature(fresh->validate_project()) == signature(restored),
            "Cold and incremental Project diagnostics agree after YAML repair");
    std::filesystem::remove(temp.root / path);
    const auto missing = project->validate_project();
    require(!missing.valid && std::any_of(missing.diagnostics.begin(), missing.diagnostics.end(),
                                          [&](const Diagnostic& issue) {
                                              return issue.source_path == path &&
                                                     issue.severity == "error";
                                          }),
            "Missing declared physical Lua source revokes saved validation proof");
    write(temp.root / path, original);
    require(project->validate_project().valid,
            "Reinstating a missing Lua source restores a complete valid generation");

    const std::string optional_chunk = "i18n/assets/fr-CA.yaml";
    const auto optional_source = read(temp.root / optional_chunk);
    std::filesystem::remove(temp.root / optional_chunk);
    const auto without_chunk = project->validate_project();
    require(without_chunk.valid &&
                std::none_of(without_chunk.diagnostics.begin(), without_chunk.diagnostics.end(),
                             [&](const Diagnostic& issue) {
                                 return issue.source_path == optional_chunk &&
                                        issue.code == "source.yaml";
                             }),
            "Removing an optional localization chunk revokes its contribution, not its validity");
    write(temp.root / optional_chunk, optional_source);
    require(project->validate_project().valid,
            "An added optional localization chunk is admitted in the same resident session");

    const auto dirty = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Replace, "/rooms/room-lifecycle-roundtrip/label", "\"Mine\""}});
    require(dirty.accepted, "A Room may retain unsaved changes beside full validation");
    write(temp.root / record_path, relabeled);
    const auto conflicted = project->validate_project();
    require(!conflicted.valid &&
                std::any_of(conflicted.diagnostics.begin(), conflicted.diagnostics.end(),
                            [&](const Diagnostic& issue) {
                                return issue.code == "source.conflict" &&
                                       issue.source_path == record_path;
                            }) &&
                project->record_snapshots().at("rooms/room-lifecycle-roundtrip").dirty,
            "External edits cannot replace an unsaved record's validation evidence");
}

void clean_cache_alias_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    std::string error;
    auto editor = ProjectSession::open(temp.root, error);
    require(editor != nullptr, "Cannot admit initial Project for path-alias cache check");
    const auto first = editor->validate_clean_project();
    require(!first.cache_hit && first.snapshot.valid,
            "Initial native Project clean validation publishes cache");

    auto alternate = temp.root;
#ifdef _WIN32
    const auto short_path = [](const std::filesystem::path& input) {
        const auto& wide = input.native();
        const DWORD length = GetShortPathNameW(wide.c_str(), nullptr, 0);
        if (!length || length > 32768)
            return input;
        std::wstring buffer(length, L'\0');
        const DWORD written = GetShortPathNameW(wide.c_str(), buffer.data(), length);
        if (!written || written >= length)
            return input;
        buffer.resize(written);
        return std::filesystem::path(buffer);
    };
    alternate = short_path(temp.root);
    if (alternate == temp.root)
        alternate = short_path(temp.root.parent_path()) / temp.root.filename();
    require(std::filesystem::equivalent(alternate, temp.root),
            "Windows short path must denote the exact original Project directory");
#endif
    auto cli = ProjectSession::open(alternate, error);
    require(cli != nullptr, "Cannot admit Project through alternate canonical path");
    const auto imported = cli->validate_clean_project();
    require(imported.cache_hit && imported.snapshot.valid,
            "Long and 8.3 Windows path aliases must share the exact native clean cache");
    const auto cached =
        Json::parse(read(temp.root / ".noveltea/cache/authoring/native-clean-current.json"));
    require(cached.at("projectRoot").is_string() &&
                cached.at("projectRoot").as<std::string>().find('~') == std::string::npos,
            "Native cache root must not retain a Windows short-name alias");
}

void missing_record_inspection_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    std::string error;
    auto session = ProjectSession::open(temp.root, error);
    require(session != nullptr, "Cannot admit Project for missing-record inspection");
    const auto missing = session->inspect_record("rooms/missing");
    require(!missing.accepted && missing.error == "Record does not exist.",
            "Missing Room must return a normal failed inspection without throwing");
    const auto valid = session->inspect_record("rooms/dependent");
    require(valid.accepted, "Failed Room inspection must not poison subsequent valid inspections");
}

void malformed_sibling_scoped_read_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    const auto room = temp.root / "records/rooms/dependent.yaml";
    const auto original = read(room);
    write(room, "broken: [\n");

    // Full Project admission must still reject an unrelated malformed Room,
    // but must not throw: the CLI can then fall back to a scoped record read.
    std::string error;
    auto project = ProjectSession::open(temp.root, error);
    require(!project && error.starts_with("Invalid record YAML: records/rooms/"),
            "Malformed sibling rejects full Project admission without throwing: " + error);
    auto script = RoomSession::open_record(temp.root, "scripts", "bootstrap", error);
    require(script != nullptr && script->snapshot().valid,
            "Valid Script can still be inspected with an unrelated malformed Room");

    write(room, original);
    project = ProjectSession::open(temp.root, error);
    require(project != nullptr, "Repair restores full Project admission: " + error);
}

void clean_cache_recovery_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    std::string error;
    auto daemon_owner = ProjectSession::open(temp.root, error);
    require(daemon_owner != nullptr, "Native daemon admission failed: " + error);
    const auto cold = daemon_owner->validate_clean_project();
    require(!cold.cache_hit && cold.snapshot.valid,
            "First daemon-owned generation is validated without an imported cache");

    // Closing the only owner simulates eviction and daemon process restart.
    daemon_owner.reset();
    auto editor = ProjectSession::open(temp.root, error);
    require(editor && editor->validate_clean_project().cache_hit,
            "A new editor host imports the daemon's exact clean generation");
    editor->source_watch_coverage_lost();
    const auto observed = editor->observe_sources();
    require(observed.full_rescan && observed.authoritative,
            "A separate native worker poll consumes the lost-coverage hint");
    const auto recovered = editor->validate_clean_project();
    require(!recovered.cache_hit && recovered.snapshot.valid &&
                editor->validation_work().rechecked_records > 0,
            "Watcher coverage loss forces full resident revalidation, not stale cache reuse");
    auto restarted_daemon = ProjectSession::open(temp.root, error);
    require(restarted_daemon && restarted_daemon->validate_clean_project().cache_hit,
            "Fresh daemon owner reuses the newly certified physical generation");
    // The cache is optional: an unwritable authoring cache directory must not
    // turn otherwise valid source and diagnostics into a validation failure.
    restarted_daemon.reset();
    std::filesystem::remove_all(temp.root / ".noveltea/cache/authoring");
    write(temp.root / ".noveltea/cache/authoring", "blocked cache directory\n");
    auto unavailable_cache = ProjectSession::open(temp.root, error);
    require(unavailable_cache && unavailable_cache->validate_clean_project().snapshot.valid,
            "Unavailable optional cache storage does not prevent authoritative validation");
}

void clean_cache_correctness_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    std::string error;
    auto project = ProjectSession::open(temp.root, error);
    require(project != nullptr, "Cannot open cache-correctness fixture: " + error);
    require(project->inspect_record("rooms/dependent").accepted,
            "Inspected Room must remain in the editor's working inventory");
    require(project->validate_clean_project().snapshot.valid, "Initial Project is valid");
    auto imported = ProjectSession::open(temp.root, error);
    require(imported != nullptr && imported->validate_clean_project().cache_hit,
            "An independent clean host rehydrates verified native contributors");
    // A replaced Asset can preserve both file size and timestamp. A separate
    // reader must reject the clean cache even when watcher metadata is silent.
    const auto asset_path = temp.root / "assets/data/probe.txt";
    const auto original_asset = read(asset_path);
    const auto original_time = std::filesystem::last_write_time(asset_path);
    require(!original_asset.empty(), "Fixture provides a physical Asset");
    auto replaced_asset = original_asset;
    replaced_asset[replaced_asset.size() / 2] ^= 1;
    write(asset_path, replaced_asset);
    std::filesystem::last_write_time(asset_path, original_time);
    auto replaced_host = ProjectSession::open(temp.root, error);
    require(replaced_host != nullptr && !replaced_host->validate_clean_project().cache_hit,
            "Clean cache rejects same-size, timestamp-restored physical Asset changes");
    write(asset_path, original_asset);
    std::filesystem::last_write_time(asset_path, original_time);
    const auto room_path = temp.root / "records/rooms/dependent.yaml";
    const auto original = read(room_path);
    auto invalid = original;
    const auto marker = invalid.find("width: 1920");
    require(marker != std::string::npos, "Fixture Room has a positive presentation width");
    invalid.replace(marker, std::string("width: 1920").size(), "width: -1");
    write(room_path, invalid);
    const auto first = project->validate_clean_project();
    const auto has_width_error = [](const RoomSessionSnapshot& snapshot) {
        return !snapshot.valid &&
               std::any_of(
                   snapshot.diagnostics.begin(), snapshot.diagnostics.end(),
                   [](const Diagnostic& issue) { return issue.code == "schema.exclusiveMinimum"; });
    };
    require(has_width_error(first.snapshot), "First invalid disk revision is diagnosed");
    const auto imported_change = imported->validate_clean_project();
    require(has_width_error(imported_change.snapshot) &&
                imported->validation_work().rechecked_records == 2 &&
                imported->validation_work().retained_records > 0,
            "Lazy imported contributors recheck the changed Room and the Asset whose physical "
            "source was replaced, retaining unrelated records");
    const auto repeated = project->validate_clean_project();
    require(has_width_error(repeated.snapshot) &&
                project->validation_work().rechecked_records == 0 &&
                project->validation_work().rechecked_contributions == 0,
            "An unchanged stale clean inspected owner must retain invalid disk diagnostics and "
            "reuse all validated contributions");
    const auto unchanged_again = project->validate_clean_project();
    require(has_width_error(unchanged_again.snapshot) &&
                project->validation_work().rechecked_records == 0 &&
                project->validation_work().rechecked_contributions == 0,
            "Repeated unchanged validation must not invalidate stale clean inspected owners");
    auto other_host = ProjectSession::open(temp.root, error);
    require(other_host != nullptr, "Another host can open the invalid-record Project");
    const auto shared = other_host->validate_clean_project();
    require(shared.cache_hit && other_host->validation_work().rechecked_contributions == 0 &&
                shared.snapshot.diagnostics.size() == first.snapshot.diagnostics.size(),
            "Deterministic invalid diagnostics survive a cold ledger restart without execution");
    for (std::size_t i = 0; i < shared.snapshot.diagnostics.size(); ++i) {
        const auto& restored = shared.snapshot.diagnostics[i];
        const auto& original = first.snapshot.diagnostics[i];
        require(restored.path == original.path && restored.code == original.code &&
                    restored.message == original.message &&
                    restored.severity == original.severity &&
                    restored.source_path == original.source_path &&
                    restored.line == original.line && restored.column == original.column,
                "Restored invalid diagnostics preserve exact ordering and source locations");
    }
    require(has_width_error(shared.snapshot),
            "Shared cache must never publish a false-success validation result");
    write(room_path, original);
    require(project->validate_clean_project().snapshot.valid,
            "Repairing the physical Room revokes the invalid diagnostics");
    const auto script_path = temp.root / "scripts/bootstrap.lua";
    const auto script_original = read(script_path);
    auto scripts_host = ProjectSession::open(temp.root, error);
    require(scripts_host && scripts_host->validate_clean_project().cache_hit,
            "A restored clean generation can be reimported");
    write(script_path, script_original + "\nText.tr(dynamic)\n");
    const auto scripts = scripts_host->validate_clean_project();
    require(!scripts.snapshot.valid && scripts_host->validation_work().rechecked_records == 0 &&
                scripts_host->validation_work().retained_contributions > 0,
            "An imported Lua-only edit preserves unrelated YAML semantic contributions");
}

void invalid_manifest_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    std::string error;
    auto warm = ProjectSession::open(temp.root, error);
    require(warm != nullptr, "Cannot open valid manifest fixture: " + error);
    require(warm->validate_project().valid, "Baseline manifest is valid");
    const auto path = temp.root / "project.yaml";
    const auto original = read(path);
    for (const auto& replacement : {"name: []", "name: ["}) {
        auto invalid = original;
        const auto offset = invalid.find("name: ");
        require(offset != std::string::npos, "Fixture manifest must have project name");
        invalid.replace(offset, invalid.find('\n', offset) - offset, replacement);
        write(path, invalid);
        std::string admission_error;
        require(!ProjectSession::open(temp.root, admission_error),
                "Malformed Project manifest must reject mutable admission without throwing");
        require(admission_error.starts_with(replacement == std::string_view("name: [")
                                                ? "Invalid Project manifest YAML:"
                                                : "Project manifest invalid:"),
                "Native admission must retain a specific invalid-Project explanation");
        const auto validated = warm->validate_project();
        require(!validated.valid, "Invalid physical manifest must fail warm validation");
        auto cold = ProjectSession::validate_cold_project(temp.root, error);
        require(cold && !cold->valid && !cold->diagnostics.empty(),
                "Invalid manifest must be diagnosable without mutable admission");
        const auto signature = [](const RoomSessionSnapshot& snapshot) {
            std::multiset<std::string> values;
            for (const auto& issue : snapshot.diagnostics)
                values.insert(issue.code + "|" + issue.path + "|" + issue.severity + "|" +
                              issue.source_path);
            return values;
        };
        if (signature(validated) != signature(*cold)) {
            for (const auto& item : signature(validated))
                std::cerr << "Warm manifest diagnostic: " << item << '\n';
            for (const auto& item : signature(*cold))
                std::cerr << "Cold manifest diagnostic: " << item << '\n';
        }
        require(signature(validated) == signature(*cold),
                "Cold and warm invalid manifest diagnostics have identical source navigation");
        write(path, original);
        require(warm->validate_project().valid, "Restored manifest becomes valid again");
    }
}
} // namespace

int main(int argc, char** argv)
{
    try {
        // One native process certifies the entire physical record corpus. The
        // differential driver still compares every record independently, but
        // no longer pays for hundreds of instrumented process startups.
        if (argc >= 3 && std::string_view(argv[1]) == "--normalized-records") {
            constexpr std::array families{"archetypes",    "scripts", "assets",       "animations",
                                          "materials",     "rooms",   "maps",         "characters",
                                          "interactables", "verbs",   "interactions", "dialogues",
                                          "scenes",        "tests"};
            Json result = Json::object();
            const auto root = std::filesystem::path(argv[2]);
            for (int i = 3; i < argc; ++i)
                require(std::find_if(families.begin(), families.end(),
                                     [&](const char* name) {
                                         return name == std::string_view(argv[i]);
                                     }) != families.end(),
                        "Unsupported normalization family");
            for (const auto* family : families) {
                if (argc > 3 && std::find_if(argv + 3, argv + argc, [&](const char* selected) {
                                    return std::string_view(selected) == family;
                                }) == argv + argc)
                    continue;
                const auto directory = root / "records" / family;
                if (!std::filesystem::exists(directory))
                    continue;
                for (const auto& file : std::filesystem::directory_iterator(directory)) {
                    if (!file.is_regular_file() || file.path().extension() != ".yaml")
                        continue;
                    const auto id = file.path().stem().string();
                    std::string error;
                    auto record = RoomSession::open_record(root, family, id, error);
                    if (!record)
                        throw std::runtime_error("Cannot open native " + std::string(family) + "/" +
                                                 id + ": " + error);
                    const auto normalized = record->snapshot();
                    if (!normalized.valid || normalized.normalized_json.empty())
                        throw std::runtime_error("Native record failed normalization: " +
                                                 std::string(family) + "/" + id);
                    result[std::string(family) + "/" + id] =
                        Json::parse(normalized.normalized_json);
                }
            }
            std::cout << result.to_string() << '\n';
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--profile-cold-validation") {
            const auto start = std::chrono::steady_clock::now();
            std::string error;
            auto project = ProjectSession::open(argv[2], error);
            require(project != nullptr, "Project admission failed: " + error);
            const auto opened = std::chrono::steady_clock::now();
            const auto validation = project->validate_project();
            const auto validated = std::chrono::steady_clock::now();
            const auto milliseconds = [](auto duration) {
                return std::chrono::duration<double, std::milli>(duration).count();
            };
            Json result = Json::object();
            result["openMs"] = milliseconds(opened - start);
            result["validateMs"] = milliseconds(validated - opened);
            result["totalMs"] = milliseconds(validated - start);
            result["valid"] = validation.valid;
            result["diagnosticCount"] = validation.diagnostics.size();
            result["recheckedRecords"] = project->validation_work().rechecked_records;
            std::cout << result.to_string() << '\n';
            return validation.valid ? 0 : 1;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--structural-only") {
            structural_record_roundtrip(argv[2]);
            std::cout << "Native structural transaction certification passed.\n";
            return 0;
        }
        if (argc == 2 && (std::string_view(argv[1]) == "--validate" ||
                          std::string_view(argv[1]) == "--validate-traits" ||
                          std::string_view(argv[1]) == "--validate-editor")) {
            const std::string source{std::istreambuf_iterator<char>{std::cin},
                                     std::istreambuf_iterator<char>{}};
            const auto decoded = open_yaml_source(source);
            const auto contract =
                std::string_view(argv[1]) == "--validate-traits"   ? "WorkspaceTraitDeclarations"
                : std::string_view(argv[1]) == "--validate-editor" ? "WorkspaceTrackedEditor"
                                                                   : "WorkspaceManifest";
            const auto result = decoded.accepted ? validate_record(contract, decoded.source_json)
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
        if (argc == 3 && std::string_view(argv[1]) == "--traits-editor") {
            traits_editor_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--source-analysis") {
            source_analysis_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--project-validation") {
            project_validation_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--typed-reference-invalidation") {
            typed_reference_invalidation_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--source-watcher-races") {
            source_watcher_races(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--clean-cache-alias") {
            clean_cache_alias_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--missing-record-inspection") {
            missing_record_inspection_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--malformed-sibling-scoped-read") {
            malformed_sibling_scoped_read_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--clean-cache-recovery") {
            clean_cache_recovery_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--clean-cache-correctness") {
            clean_cache_correctness_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--invalid-manifest") {
            invalid_manifest_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 5 && std::string_view(argv[1]) == "--normalized-record") {
            std::string error;
            auto record = RoomSession::open_record(argv[2], argv[3], argv[4], error);
            if (!record)
                throw std::runtime_error("Cannot open native record: " + error);
            const auto value = record->snapshot();
            if (!value.valid || value.normalized_json.empty())
                throw std::runtime_error(
                    "Native record failed normalization: " + std::string(argv[3]) + "/" + argv[4]);
            std::cout << value.normalized_json << '\n';
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--working-preparation") {
            working_preparation_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--structural-records") {
            structural_record_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--properties") {
            property_semantics_roundtrip(argv[2]);
            return 0;
        }
        if (argc == 2) {
            source_analysis_roundtrip(argv[1]);
            roundtrip(argv[1], true);
            traits_editor_roundtrip(argv[1]);
            property_semantics_roundtrip(argv[1]);
            structural_record_roundtrip(argv[1]);
            return 0;
        }
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "Project certification failed: " << e.what() << '\n';
        return 1;
    }
}
