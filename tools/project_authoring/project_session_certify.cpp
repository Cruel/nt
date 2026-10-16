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
#include <algorithm>

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
}

void working_preparation_roundtrip(const std::filesystem::path& fixture)
{
    TemporaryProject temp(fixture);
    std::string error;
    auto editor = ProjectSession::open(temp.root, error);
    require(editor != nullptr, "Cannot admit editor preparation: " + error);
    const auto baseline = editor->prepare_working(0);
    require(baseline.accepted && Json::parse(baseline.record_overrides_json).empty() &&
                Json::parse(baseline.project_json).at("project").at("name") == "Feature Lab",
            "Saved Project preview baseline has no dirty native record overrides");
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
}
} // namespace

int main(int argc, char** argv)
{
    try {
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
        if (argc == 3 && std::string_view(argv[1]) == "--working-preparation") {
            working_preparation_roundtrip(argv[2]);
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
            return 0;
        }
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "Project certification failed: " << e.what() << '\n';
        return 1;
    }
}
