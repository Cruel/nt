#include "room_session.hpp"

#include <node_api.h>
#include <jsoncons/json.hpp>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {
using Json = jsoncons::ojson;
using noveltea::authoring::ProjectSession;
using noveltea::authoring::RoomPatch;
using noveltea::authoring::RoomSessionResult;
using noveltea::authoring::RoomSessionSnapshot;
using noveltea::authoring::SourceObservation;

struct Session {
    std::unique_ptr<ProjectSession> project;
    std::filesystem::path root;
    std::map<std::string, std::vector<noveltea::authoring::Diagnostic>> record_diagnostics;
};

std::string string_arg(napi_env env, napi_value value)
{
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string)
        throw std::runtime_error("Expected string argument.");
    std::size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
        length > 16 * 1024 * 1024)
        throw std::runtime_error("Invalid or oversized string argument.");
    std::string result(length + 1, '\0');
    if (napi_get_value_string_utf8(env, value, result.data(), result.size(), &length) != napi_ok)
        throw std::runtime_error("Cannot read argument.");
    result.resize(length);
    return result;
}

napi_value js_string(napi_env env, const std::string& value)
{
    napi_value result = nullptr;
    if (napi_create_string_utf8(env, value.data(), value.size(), &result) != napi_ok)
        throw std::runtime_error("Cannot allocate JS string.");
    return result;
}

Json json_array(const std::vector<std::string>& values)
{
    Json array = Json::array();
    for (const auto& value : values)
        array.push_back(value);
    return array;
}

Json snapshot_json(const RoomSessionSnapshot& state)
{
    Json result = Json::object();
    result["workingRevision"] = state.working_revision;
    result["diskSourceRevision"] = state.disk_source_revision;
    result["source"] = Json::parse(state.source_json);
    // Absence is not an empty record; a deleted or newly staged physical
    // owner has no saved semantic value.
    result["baseline"] =
        state.disk_source_revision == "absent" ? Json::null() : Json::parse(state.baseline_json);
    result["dirty"] = state.dirty;
    result["valid"] = state.valid;
    result["normalized"] =
        state.normalized_json.empty() ? Json::null() : Json::parse(state.normalized_json);
    result["diagnostics"] = Json::array();
    result["conflictingPaths"] = json_array(state.conflicting_paths);
    for (const auto& error : state.diagnostics) {
        Json entry = Json::object();
        entry["path"] = error.path;
        entry["code"] = error.code;
        entry["message"] = error.message;
        entry["severity"] = error.severity;
        if (!error.source_path.empty())
            entry["sourcePath"] = error.source_path;
        if (error.line)
            entry["line"] = *error.line;
        if (error.column)
            entry["column"] = *error.column;
        result["diagnostics"].push_back(std::move(entry));
    }
    return result;
}

Json project_snapshot_json(const ProjectSession& project)
{
    auto value = snapshot_json(project.snapshot());
    value["recordSnapshots"] = Json::object();
    for (const auto& [owner, snapshot] : project.record_snapshots())
        value["recordSnapshots"][owner] = snapshot_json(snapshot);
    return value;
}

Json result_json(const ProjectSession& project, const RoomSessionResult& result)
{
    Json value = Json::object();
    value["accepted"] = result.accepted;
    value["error"] = result.error;
    auto current = snapshot_json(project.snapshot());
    current["recordSnapshots"] = Json::object();
    const auto records = project.record_snapshots();
    for (const auto& owner : result.affected_records) {
        const auto found = records.find(owner);
        if (found != records.end())
            current["recordSnapshots"][owner] = snapshot_json(found->second);
    }
    value["snapshot"] = std::move(current);
    value["affectedRecords"] = json_array(result.affected_records);
    auto diagnostics = [](const std::vector<noveltea::authoring::Diagnostic>& entries) {
        Json list = Json::array();
        for (const auto& entry : entries) {
            Json value = Json::object();
            value["path"] = entry.path;
            value["code"] = entry.code;
            value["message"] = entry.message;
            value["severity"] = entry.severity;
            if (!entry.source_path.empty())
                value["sourcePath"] = entry.source_path;
            if (entry.line)
                value["line"] = *entry.line;
            if (entry.column)
                value["column"] = *entry.column;
            list.push_back(std::move(value));
        }
        return list;
    };
    value["diagnosticsAdded"] = diagnostics(result.diagnostics_added);
    value["diagnosticsRemoved"] = diagnostics(result.diagnostics_removed);
    if (!result.comment_impacts.empty()) {
        value["commentImpacts"] = Json::array();
        for (const auto& impact : result.comment_impacts) {
            Json entry = Json::object();
            entry["file"] = impact.file;
            entry["path"] = impact.path;
            entry["comment"] = impact.comment;
            entry["kind"] = impact.kind;
            value["commentImpacts"].push_back(std::move(entry));
        }
    }
    if (!result.asset_trash_moves.empty()) {
        value["assetTrashMoves"] = Json::array();
        for (const auto& [source, trash] : result.asset_trash_moves) {
            Json entry = Json::object();
            entry["projectRelativePath"] = source;
            entry["trashRelativePath"] = trash;
            value["assetTrashMoves"].push_back(std::move(entry));
        }
    }
    return value;
}

Json observation_json(Session& session, const SourceObservation& observed)
{
    Json result = Json::object();
    result["authoritative"] = observed.authoritative;
    result["scopedAuthority"] = observed.scoped_authority;
    result["unchanged"] = observed.unchanged;
    result["fullRescan"] = observed.full_rescan;
    result["error"] = observed.error;
    result["added"] = json_array(observed.delta.added);
    result["changed"] = json_array(observed.delta.changed);
    result["removed"] = json_array(observed.delta.removed);
    result["revisions"] = Json::object();
    for (const auto& [path, revision] : observed.delta_revisions)
        result["revisions"][path] = revision;
    result["watchPaths"] = json_array(observed.watch_paths);
    result["invalidSources"] = Json::array();
    for (const auto& invalid : observed.invalid_sources) {
        Json item = Json::object();
        item["path"] = invalid.path;
        item["error"] = invalid.error;
        result["invalidSources"].push_back(std::move(item));
    }
    // Only read changed Room/Map owners. The byte digest from SourceAuthority
    // must match this exact read, otherwise never publish unverified diagnostics.
    for (const auto& relative : observed.delta.removed)
        session.record_diagnostics.erase(relative);
    for (const auto& [relative, revision] : observed.delta_revisions) {
        const auto slash = relative.find('/', 8);
        if (!relative.starts_with("records/") || slash == std::string::npos ||
            !relative.ends_with(".yaml"))
            continue;
        const auto family = relative.substr(8, slash - 8);
        if (family != "rooms" && family != "maps")
            continue;
        const auto id = relative.substr(slash + 1, relative.size() - slash - 6);
        if (revision == "absent")
            continue;
        const auto file = std::filesystem::weakly_canonical(session.root / relative);
        const auto contained = file.lexically_relative(session.root);
        if (contained.empty() || contained == ".." || *contained.begin() == "..")
            throw std::runtime_error("Native Project record escaped its admitted root.");
        std::ifstream input(file, std::ios::binary);
        if (!input)
            throw std::runtime_error("Cannot reopen changed native Project record.");
        const std::string bytes{std::istreambuf_iterator<char>(input),
                                std::istreambuf_iterator<char>()};
        if (noveltea::authoring::exact_source_revision(bytes) != revision)
            throw std::runtime_error("Changed Project source revision raced with validation.");
        const auto decoded = noveltea::authoring::open_yaml_source(bytes);
        const auto base = "/" + family + "/" + id;
        auto& diagnostics = session.record_diagnostics[relative];
        diagnostics.clear();
        if (!decoded.accepted)
            diagnostics.push_back({base, "source.yaml", decoded.error});
        else {
            const auto validated =
                family == "rooms" ? noveltea::authoring::validate_room_source(decoded.source_json)
                                  : noveltea::authoring::validate_map_source(decoded.source_json);
            for (const auto& error : validated.diagnostics)
                diagnostics.push_back(
                    {base + error.path, error.code, error.message, error.severity});
            if (validated.accepted) {
                const auto local =
                    noveltea::authoring::validate_room_map_local(family, validated.effective_json);
                for (const auto& error : local.diagnostics)
                    diagnostics.push_back(
                        {base + error.path, error.code, error.message, error.severity});
            }
        }
    }
    result["recordDiagnostics"] = Json::array();
    for (const auto& [relative, errors] : session.record_diagnostics) {
        (void)relative;
        for (const auto& error : errors) {
            Json entry = Json::object();
            entry["path"] = error.path;
            entry["code"] = error.code;
            entry["message"] = error.message;
            entry["severity"] = error.severity;
            result["recordDiagnostics"].push_back(std::move(entry));
        }
    }
    return result;
}

Session& session_arg(napi_env env, napi_value value)
{
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_external)
        throw std::runtime_error("Expected native session handle.");
    Session* session = nullptr;
    if (napi_get_value_external(env, value, reinterpret_cast<void**>(&session)) != napi_ok ||
        !session || !session->project)
        throw std::runtime_error("Native Project session has been closed.");
    return *session;
}

napi_value call(napi_env env, napi_callback_info info)
{
    void* callback_data = nullptr;
    napi_value argv[8]{};
    std::size_t argc = 8;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, &callback_data) != napi_ok)
        return nullptr;
    const std::string name(static_cast<const char*>(callback_data));
    try {
        if (name == "open") {
            if (argc != 1)
                throw std::runtime_error("open requires one canonical Project root.");
            std::string error;
            auto project = ProjectSession::open(string_arg(env, argv[0]), error);
            if (!project)
                throw std::runtime_error("Native Project open failed: " + error);
            auto handle = std::make_unique<Session>();
            handle->project = std::move(project);
            handle->root = std::filesystem::canonical(string_arg(env, argv[0]));
            napi_value value = nullptr;
            const auto status = napi_create_external(
                env, handle.get(),
                [](napi_env, void* data, void*) { delete static_cast<Session*>(data); }, nullptr,
                &value);
            if (status != napi_ok)
                throw std::runtime_error("Cannot allocate native session handle.");
            handle.release();
            return value;
        }
        if (argc < 1)
            throw std::runtime_error("Native session handle required.");
        auto& session = session_arg(env, argv[0]);
        if (name == "close") {
            session.project.reset();
            napi_value value = nullptr;
            napi_get_undefined(env, &value);
            return value;
        }
        if (name == "snapshot") {
            if (argc != 1)
                throw std::runtime_error("snapshot takes only the session handle.");
            Json result = project_snapshot_json(*session.project);
            result["inventory"] = Json::array();
            for (const auto& file : session.project->file_inventory())
                if (file.kind == noveltea::authoring::ProjectFileKind::TrackedSource)
                    result["inventory"].push_back(file.path);
            return js_string(env, result.to_string());
        }
        if (name == "validateClean") {
            if (argc != 1)
                throw std::runtime_error("Clean validation takes only the session handle.");
            const auto validated = session.project->validate_clean_project();
            Json result = Json::object();
            result["valid"] = validated.snapshot.valid;
            result["cacheHit"] = validated.cache_hit;
            result["diagnostics"] =
                Json::parse(noveltea::authoring::validation_result_json(
                                noveltea::authoring::ValidationResult{
                                    validated.snapshot.valid, "", validated.snapshot.diagnostics}))
                    .at("diagnostics");
            const auto work = session.project->validation_work();
            result["work"] = Json::object();
            result["work"]["recheckedRecords"] = work.rechecked_records;
            result["work"]["retainedRecords"] = work.retained_records;
            result["work"]["recheckedContributions"] = work.rechecked_contributions;
            result["work"]["retainedContributions"] = work.retained_contributions;
            return js_string(env, result.to_string());
        }
        if (name == "inspect") {
            if (argc != 2)
                throw std::runtime_error("inspect requires a Project record owner.");
            const auto inspected = session.project->inspect_record(string_arg(env, argv[1]));
            return js_string(env, result_json(*session.project, inspected).to_string());
        }
        if (name == "reconcile") {
            if (argc != 2)
                throw std::runtime_error("reconcile requires a Project owner.");
            const auto reconciled = session.project->reconcile_owner(string_arg(env, argv[1]));
            return js_string(env, result_json(*session.project, reconciled).to_string());
        }
        if (name == "useDisk") {
            if (argc < 3 || argc > 5)
                throw std::runtime_error("useDisk requires working revision and owner.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid working revision.");
            std::vector<std::string> paths;
            if (argc >= 4) {
                const auto selection = Json::parse(string_arg(env, argv[3]));
                if (!selection.is_array() || selection.size() > 256)
                    throw std::runtime_error("Invalid logical Use Disk paths.");
                for (const auto& path : selection.array_range())
                    paths.push_back(path.as<std::string>());
            }
            const auto resolved = session.project->use_disk(static_cast<std::uint64_t>(revision),
                                                            string_arg(env, argv[2]), paths);
            return js_string(env, result_json(*session.project, resolved).to_string());
        }
        if (name == "restoreConflicts") {
            if (argc != 3)
                throw std::runtime_error("Conflict restoration requires revision and paths.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid conflict restoration revision.");
            const auto source = Json::parse(string_arg(env, argv[2]));
            if (!source.is_object() || source.size() > 256)
                throw std::runtime_error("Invalid conflict restoration owners.");
            std::map<std::string, std::vector<std::string>> conflicts;
            for (const auto& owner : source.object_range()) {
                if (!owner.value().is_array() || owner.value().size() > 256)
                    throw std::runtime_error("Invalid conflict restoration paths.");
                for (const auto& path : owner.value().array_range())
                    conflicts[owner.key()].push_back(path.as<std::string>());
            }
            const auto restored =
                session.project->restore_conflicts(static_cast<std::uint64_t>(revision), conflicts);
            return js_string(env, result_json(*session.project, restored).to_string());
        }
        if (name == "useDiskOwners") {
            if (argc != 3)
                throw std::runtime_error("Use Disk owners requires revision and paths.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid Use Disk owners revision.");
            const auto source = Json::parse(string_arg(env, argv[2]));
            if (!source.is_object() || source.empty() || source.size() > 256)
                throw std::runtime_error("Invalid Use Disk owner selection.");
            std::map<std::string, std::vector<std::string>> paths;
            for (const auto& owner : source.object_range()) {
                if (!owner.value().is_array() || owner.value().size() > 256)
                    throw std::runtime_error("Invalid Use Disk owner paths.");
                for (const auto& path : owner.value().array_range())
                    paths[owner.key()].push_back(path.as<std::string>());
            }
            const auto result =
                session.project->use_disk_owners(static_cast<std::uint64_t>(revision), paths);
            return js_string(env, result_json(*session.project, result).to_string());
        }
        if (name == "mutateSourceDirectory") {
            if (argc != 5)
                throw std::runtime_error("Native source folder operation requires revision, kind and paths.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid native source folder revision.");
            const auto result = session.project->mutate_source_directory(
                revision, string_arg(env, argv[2]), string_arg(env, argv[3]),
                string_arg(env, argv[4]));
            return js_string(env, result_json(*session.project, result).to_string());
        }
        if (name == "saveOwners") {
            if (argc < 5 || argc > 8)
                throw std::runtime_error("saveOwners needs revision, owners, keepMine, comments.");
            std::int64_t revision = -1;
            bool keep_mine = false;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0 ||
                napi_get_value_bool(env, argv[3], &keep_mine) != napi_ok)
                throw std::runtime_error("Invalid scoped Save revision or conflict decision.");
            const auto owners = Json::parse(string_arg(env, argv[2]));
            if (!owners.is_array() || owners.size() > 2100)
                throw std::runtime_error("Invalid native Save owner list.");
            std::vector<std::string> selected;
            for (const auto& owner : owners.array_range())
                selected.push_back(owner.as<std::string>());
            const auto choice = string_arg(env, argv[4]);
            const auto decision =
                choice == "keep"      ? noveltea::authoring::TransactionDecision::KeepComments
                : choice == "remove"  ? noveltea::authoring::TransactionDecision::RemoveComments
                : choice == "cancel"  ? noveltea::authoring::TransactionDecision::Cancel
                : choice == "perEdit" ? noveltea::authoring::TransactionDecision::UseEditDecisions
                                      : throw std::runtime_error("Invalid comment decision.");
            std::map<std::string, std::vector<std::string>> paths;
            if (argc >= 6) {
                const auto logical = Json::parse(string_arg(env, argv[5]));
                if (!logical.is_object() || logical.size() > 2100)
                    throw std::runtime_error("Invalid logical Save selections.");
                for (const auto& item : logical.object_range()) {
                    if (!item.value().is_array() || item.value().size() > 256)
                        throw std::runtime_error("Invalid logical Save paths.");
                    for (const auto& value : item.value().array_range())
                        paths[item.key()].push_back(value.as<std::string>());
                }
            }
            std::vector<std::string> text_paths;
            if (argc >= 7) {
                const auto text = Json::parse(string_arg(env, argv[6]));
                if (!text.is_array() || text.size() > 128)
                    throw std::runtime_error("Invalid native mixed Save text source list.");
                for (const auto& path : text.array_range())
                    text_paths.push_back(path.as<std::string>());
            }
            std::optional<noveltea::authoring::ProjectAssetTransition> assets;
            if (argc == 8) {
                const auto value = Json::parse(string_arg(env, argv[7]));
                if (!value.is_object() || !value.contains("kind") || !value.at("kind").is_string())
                    throw std::runtime_error("Invalid native Asset transition.");
                noveltea::authoring::ProjectAssetTransition selected_assets;
                const auto kind = value.at("kind").as<std::string>();
                if (kind == "trash" && value.size() == 2 &&
                    value.contains("projectRelativePaths") &&
                    value.at("projectRelativePaths").is_array()) {
                    selected_assets.kind = noveltea::authoring::ProjectAssetTransition::Kind::Trash;
                    for (const auto& path : value.at("projectRelativePaths").array_range())
                        selected_assets.paths.push_back(path.as<std::string>());
                } else if (kind == "restore" && value.size() == 2 && value.contains("moves") &&
                           value.at("moves").is_array()) {
                    selected_assets.kind =
                        noveltea::authoring::ProjectAssetTransition::Kind::Restore;
                    for (const auto& move : value.at("moves").array_range()) {
                        if (!move.is_object() || move.size() != 2 ||
                            !move.contains("projectRelativePath") ||
                            !move.contains("trashRelativePath"))
                            throw std::runtime_error("Invalid native Asset restoration entry.");
                        selected_assets.moves.emplace_back(
                            move.at("projectRelativePath").as<std::string>(),
                            move.at("trashRelativePath").as<std::string>());
                    }
                } else if (kind == "move" && value.size() == 2 && value.contains("moves") &&
                           value.at("moves").is_array()) {
                    selected_assets.kind = noveltea::authoring::ProjectAssetTransition::Kind::Move;
                    for (const auto& move : value.at("moves").array_range()) {
                        if (!move.is_object() || move.size() != 2 || !move.contains("fromPath") ||
                            !move.contains("toPath"))
                            throw std::runtime_error("Invalid native Asset move entry.");
                        selected_assets.moves.emplace_back(move.at("fromPath").as<std::string>(),
                                                           move.at("toPath").as<std::string>());
                    }
                } else if (kind == "publish" && value.size() == 2 && value.contains("files") &&
                           value.at("files").is_array()) {
                    selected_assets.kind =
                        noveltea::authoring::ProjectAssetTransition::Kind::Publish;
                    for (const auto& file : value.at("files").array_range()) {
                        if (!file.is_object() || file.size() != 3 ||
                            !file.contains("projectRelativePath") ||
                            !file.contains("stagedRelativePath") ||
                            !file.contains("sourceRevision"))
                            throw std::runtime_error("Invalid native Asset publication entry.");
                        selected_assets.publications.push_back(
                            {file.at("projectRelativePath").as<std::string>(),
                             file.at("stagedRelativePath").as<std::string>(),
                             file.at("sourceRevision").as<std::string>()});
                    }
                } else if (kind == "source-files" && value.size() == 2 &&
                           value.contains("files") && value.at("files").is_array() &&
                           value.at("files").size() <= 256) {
                    selected_assets.kind =
                        noveltea::authoring::ProjectAssetTransition::Kind::SourceFiles;
                    for (const auto& file : value.at("files").array_range()) {
                        if (!file.is_object() || file.size() != 3 ||
                            !file.contains("path") || !file.contains("expectedRevision") ||
                            !file.contains("contents") || !file.at("path").is_string() ||
                            !file.at("expectedRevision").is_string() ||
                            (!file.at("contents").is_null() && !file.at("contents").is_string()))
                            throw std::runtime_error("Invalid native source file transaction entry.");
                        std::optional<std::string> contents;
                        if (!file.at("contents").is_null())
                            contents = file.at("contents").as<std::string>();
                        selected_assets.source_files.push_back(
                            {file.at("path").as<std::string>(),
                             file.at("expectedRevision").as<std::string>(), std::move(contents)});
                    }
                } else
                    throw std::runtime_error("Unsupported native Asset transition.");
                assets = std::move(selected_assets);
            }
            const auto saved =
                session.project->save_owners(static_cast<std::uint64_t>(revision), selected,
                                             keep_mine, decision, paths, text_paths, assets);
            auto response = result_json(*session.project, saved);
            if (saved.accepted && !text_paths.empty()) {
                response["textSourceDiskRevisions"] = Json::object();
                for (const auto& path : text_paths)
                    response["textSourceDiskRevisions"][path] =
                        session.project->text_source_disk_revisions().at(path);
            }
            return js_string(env, response.to_string());
        }
        if (name == "observe") {
            if (argc != 1)
                throw std::runtime_error("observe takes only the session handle.");
            return js_string(
                env, observation_json(session, session.project->observe_sources()).to_string());
        }
        if (name == "coverageLost") {
            session.project->source_watch_coverage_lost();
            napi_value value = nullptr;
            napi_get_undefined(env, &value);
            return value;
        }
        if (name == "hint") {
            if (argc != 2)
                throw std::runtime_error("hint requires a Project-relative source path.");
            session.project->source_watch_hint(string_arg(env, argv[1]));
            napi_value value = nullptr;
            napi_get_undefined(env, &value);
            return value;
        }
        if (name == "materialCompilerRequest") {
            if (argc != 2)
                throw std::runtime_error("Material compiler request requires a Material ID.");
            const auto request =
                session.project->material_compiler_request(string_arg(env, argv[1]));
            return js_string(env, request ? *request : "null");
        }
        if (name == "shaderSourceOverlays") {
            if (argc != 1)
                throw std::runtime_error("Shader overlays require only the session handle.");
            Json overlays = Json::object();
            for (const auto& [path, content] : session.project->shader_source_overlays())
                overlays[path] = content;
            return js_string(env, overlays.to_string());
        }
        if (name == "textSourceOverlays") {
            if (argc != 1)
                throw std::runtime_error("Text overlays require only the session handle.");
            Json overlays = Json::object();
            for (const auto& [path, content] : session.project->text_source_overlays())
                overlays[path] = content;
            return js_string(env, overlays.to_string());
        }
        if (name == "sourceAnalyses") {
            if (argc != 1)
                throw std::runtime_error("Source analyses require only the session handle.");
            Json sources = Json::object();
            for (const auto& [path, analysis] : session.project->source_analyses()) {
                Json entry = Json::object();
                entry["sourceRevision"] = analysis.source_revision;
                entry["complete"] = analysis.complete;
                entry["messages"] = Json::array();
                for (const auto& message : analysis.messages) {
                    Json item = Json::object();
                    item["kind"] = message.kind;
                    item["source"] = message.source;
                    item["sourcePath"] = message.source_path;
                    item["sourceRevision"] = message.source_revision;
                    item["line"] = message.line;
                    item["column"] = message.column;
                    item["cases"] = Json::object();
                    for (const auto& [branch, value] : message.cases)
                        item["cases"][branch] = value;
                    if (message.context)
                        item["context"] = *message.context;
                    if (message.translator_note)
                        item["translatorNote"] = *message.translator_note;
                    item["hasRuntimeArguments"] = message.has_runtime_arguments;
                    item["luaCall"] = message.lua_call;
                    item["callStartUtf16"] = message.call_start_utf16;
                    item["callEndUtf16"] = message.call_end_utf16;
                    item["memberStartUtf16"] = message.member_start_utf16;
                    item["memberEndUtf16"] = message.member_end_utf16;
                    const auto optional_offset = [&](std::string_view key,
                                                     const std::optional<std::size_t>& value) {
                        if (value)
                            item[std::string(key)] = *value;
                    };
                    optional_offset("sourceStartUtf16", message.source_start_utf16);
                    optional_offset("sourceEndUtf16", message.source_end_utf16);
                    optional_offset("selectorStartUtf16", message.selector_start_utf16);
                    optional_offset("selectorEndUtf16", message.selector_end_utf16);
                    optional_offset("casesStartUtf16", message.cases_start_utf16);
                    optional_offset("casesEndUtf16", message.cases_end_utf16);
                    optional_offset("runtimeArgsStartUtf16", message.runtime_args_start_utf16);
                    optional_offset("runtimeArgsEndUtf16", message.runtime_args_end_utf16);
                    optional_offset("metadataStartUtf16", message.metadata_start_utf16);
                    optional_offset("metadataEndUtf16", message.metadata_end_utf16);
                    if (message.runtime_argument_names) {
                        item["runtimeArgumentNames"] = Json::array();
                        for (const auto& name : *message.runtime_argument_names)
                            item["runtimeArgumentNames"].push_back(name);
                    }
                    entry["messages"].push_back(std::move(item));
                }
                entry["references"] = Json::array();
                for (const auto& reference : analysis.references) {
                    Json item = Json::object();
                    item["kind"] = reference.kind;
                    item["target"] = reference.target;
                    item["line"] = reference.line;
                    item["column"] = reference.column;
                    entry["references"].push_back(std::move(item));
                }
                entry["cursors"] = Json::array();
                for (const auto& cursor : analysis.cursors) {
                    Json item = Json::object();
                    item["name"] = cursor.name;
                    item["line"] = cursor.line;
                    item["column"] = cursor.column;
                    entry["cursors"].push_back(std::move(item));
                }
                entry["diagnostics"] =
                    Json::parse(
                        noveltea::authoring::validation_result_json(
                            noveltea::authoring::ValidationResult{false, "", analysis.diagnostics}))
                        .at("diagnostics");
                sources[path] = std::move(entry);
            }
            return js_string(env, sources.to_string());
        }
        if (name == "prepareWorking" || name == "prepareCompleteWorking") {
            if (argc != 3)
                throw std::runtime_error("Working preparation requires revision and Test ID.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid working preparation revision.");
            const auto test_id = string_arg(env, argv[2]);
            if (test_id.size() > 256)
                throw std::runtime_error("Invalid authored Test ID.");
            const auto prepared = name == "prepareCompleteWorking"
                                      ? session.project->prepare_complete_working(
                                            static_cast<std::uint64_t>(revision), test_id)
                                      : session.project->prepare_working(
                                            static_cast<std::uint64_t>(revision), test_id);
            Json result = Json::object();
            result["accepted"] = prepared.accepted;
            result["error"] = prepared.error;
            result["workingRevision"] = prepared.working_revision;
            result["project"] =
                prepared.accepted ? Json::parse(prepared.project_json) : Json::null();
            result["recordOverrides"] =
                prepared.accepted ? Json::parse(prepared.record_overrides_json) : Json::object();
            if (name == "prepareCompleteWorking")
                result["completeProject"] =
                    prepared.accepted ? Json::parse(prepared.complete_project_json) : Json::null();
            if (name == "prepareCompleteWorking" && prepared.accepted) {
                result["referencedAssetIds"] = Json::array();
                if (!prepared.referenced_asset_ids)
                    throw std::runtime_error("Complete Project omitted native runtime references.");
                for (const auto& asset : *prepared.referenced_asset_ids)
                    result["referencedAssetIds"].push_back(asset);
            }
            result["sourceRevisions"] = Json::object();
            for (const auto& [path, value] : prepared.source_revisions)
                result["sourceRevisions"][path] = value;
            result["textOverlays"] = Json::object();
            for (const auto& [path, content] : prepared.text_overlays)
                result["textOverlays"][path] = content;
            result["shaderOverlays"] = Json::object();
            for (const auto& [path, content] : prepared.shader_overlays)
                result["shaderOverlays"][path] = content;
            result["diagnostics"] =
                Json::parse(
                    noveltea::authoring::validation_result_json(
                        noveltea::authoring::ValidationResult{false, "", prepared.diagnostics}))
                    .at("diagnostics");
            return js_string(env, result.to_string());
        }
        if (name == "stageTextSource") {
            if (argc != 4 && argc != 5)
                throw std::runtime_error("Text source operation requires revision, path and body.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid text source revision.");
            const auto path = string_arg(env, argv[2]);
            const auto content = string_arg(env, argv[3]);
            if (content.size() > 4 * 1024 * 1024)
                throw std::runtime_error("Text source overlay exceeds 4 MiB.");
            const auto& baselines = session.project->text_source_disk_revisions();
            const auto baseline = baselines.find(path);
            if (argc == 5 &&
                (baseline == baselines.end() || baseline->second != string_arg(env, argv[4]))) {
                noveltea::authoring::RoomSessionResult rejected;
                rejected.error = "Native Project text-source recovery conflict for " + path;
                rejected.snapshot = session.project->snapshot();
                return js_string(env, result_json(*session.project, rejected).to_string());
            }
            auto result = result_json(*session.project,
                                      session.project->stage_text_source(
                                          static_cast<std::uint64_t>(revision), path, content));
            if (result.at("accepted") == true) {
                result["textSourceStaged"] = session.project->text_source_overlays().contains(path);
                result["textSourceDiskRevision"] = baselines.at(path);
            }
            return js_string(env, result.to_string());
        }
        if (name == "saveTextSources") {
            if (argc != 4)
                throw std::runtime_error(
                    "Native text Save needs revision, source paths and exact disk preconditions.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid native text Save revision.");
            const auto paths = Json::parse(string_arg(env, argv[2]));
            if (!paths.is_array() || paths.empty() || paths.size() > 128)
                throw std::runtime_error("Invalid native text Save source selection.");
            std::vector<std::string> selected;
            for (const auto& path : paths.array_range())
                selected.push_back(path.as<std::string>());
            const auto preconditions = Json::parse(string_arg(env, argv[3]));
            if (!preconditions.is_object() || preconditions.size() > 128)
                throw std::runtime_error("Invalid native text Save disk preconditions.");
            std::map<std::string, std::string> revisions;
            for (const auto& item : preconditions.object_range())
                revisions[item.key()] = item.value().as<std::string>();
            auto response = session.project->save_text_sources(static_cast<std::uint64_t>(revision),
                                                               selected, revisions);
            auto result = result_json(*session.project, response);
            if (response.accepted) {
                Json revisions = Json::object();
                for (const auto& path : selected)
                    revisions[path] = session.project->text_source_disk_revisions().at(path);
                result["textSourceDiskRevisions"] = std::move(revisions);
            }
            return js_string(env, result.to_string());
        }
        if (name == "stageShaderSource" || name == "publishMaterialCompilerResult") {
            if (argc != 4)
                throw std::runtime_error(
                    "Shader source operation requires revision, owner and body.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid shader authoring revision.");
            const auto owner = string_arg(env, argv[2]);
            const auto content = string_arg(env, argv[3]);
            if (content.size() > 16 * 1024 * 1024)
                throw std::runtime_error("Shader authoring payload exceeds 16 MiB.");
            const auto updated = name == "stageShaderSource"
                                     ? session.project->stage_shader_source(
                                           static_cast<std::uint64_t>(revision), owner, content)
                                     : session.project->publish_material_compiler_result(
                                           static_cast<std::uint64_t>(revision), owner, content);
            return js_string(env, result_json(*session.project, updated).to_string());
        }
        if (name == "save") {
            if (argc != 2)
                throw std::runtime_error("save requires a disk source revision.");
            return js_string(
                env, result_json(*session.project, session.project->save(string_arg(env, argv[1])))
                         .to_string());
        }
        if (name == "patch") {
            if (argc < 3 || argc > 5)
                throw std::runtime_error("patch requires working revision and operations JSON.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid working revision.");
            const auto operations = Json::parse(string_arg(env, argv[2]));
            if (!operations.is_array() || operations.size() > 2100)
                throw std::runtime_error("Patch needs a bounded operation array.");
            std::vector<RoomPatch> patches;
            for (const auto& entry : operations.array_range()) {
                const auto op = entry.at("operation").as<std::string>();
                const auto kind = op == "add"       ? RoomPatch::Operation::Add
                                  : op == "replace" ? RoomPatch::Operation::Replace
                                  : op == "remove"
                                      ? RoomPatch::Operation::Remove
                                      : throw std::runtime_error("Unknown patch operation.");
                patches.push_back({kind, entry.at("path").as<std::string>(),
                                   entry.contains("value") ? entry.at("value").to_string() : ""});
            }
            std::map<std::string, std::string> disk_preconditions;
            if (argc >= 4) {
                const auto preconditions = Json::parse(string_arg(env, argv[3]));
                if (!preconditions.is_object() || preconditions.size() > 2100)
                    throw std::runtime_error("Invalid recovery source preconditions.");
                for (const auto& entry : preconditions.object_range()) {
                    if (!entry.value().is_string())
                        throw std::runtime_error("Invalid recovery source revision.");
                    disk_preconditions.emplace(entry.key(), entry.value().as<std::string>());
                }
            }
            std::map<std::string, std::string> layout_sources;
            if (argc == 5) {
                const auto source = Json::parse(string_arg(env, argv[4]));
                if (!source.is_object() || source.size() > 128)
                    throw std::runtime_error("Invalid Layout copy source selection.");
                for (const auto& entry : source.object_range()) {
                    if (!entry.value().is_string())
                        throw std::runtime_error("Invalid Layout copy source owner.");
                    layout_sources.emplace(entry.key(), entry.value().as<std::string>());
                }
            }
            const auto updated = session.project->patch(
                static_cast<std::uint64_t>(revision), patches, disk_preconditions, layout_sources);
            return js_string(env, result_json(*session.project, updated).to_string());
        }
        throw std::runtime_error("Unknown native Project operation.");
    } catch (const std::exception& error) {
        napi_throw_error(env, nullptr, error.what());
        return nullptr;
    } catch (...) {
        napi_throw_error(env, nullptr, "Unknown native Project failure.");
        return nullptr;
    }
}

napi_value initialize(napi_env env, napi_value exports)
{
    static const char* operations[]{"open",
                                    "close",
                                    "snapshot",
                                    "validateClean",
                                    "observe",
                                    "inspect",
                                    "reconcile",
                                    "useDisk",
                                    "saveOwners",
                                    "mutateSourceDirectory",
                                    "restoreConflicts",
                                    "useDiskOwners",
                                    "coverageLost",
                                    "hint",
                                    "save",
                                    "patch",
                                    "materialCompilerRequest",
                                    "shaderSourceOverlays",
                                    "stageShaderSource",
                                    "textSourceOverlays",
                                    "stageTextSource",
                                    "saveTextSources",
                                    "sourceAnalyses",
                                    "prepareWorking",
                                    "prepareCompleteWorking",
                                    "publishMaterialCompilerResult"};
    for (const auto* name : operations) {
        napi_value callback = nullptr;
        if (napi_create_function(env, name, NAPI_AUTO_LENGTH, call, const_cast<char*>(name),
                                 &callback) != napi_ok ||
            napi_set_named_property(env, exports, name, callback) != napi_ok) {
            napi_throw_error(env, nullptr, "Failed to initialize Project addon.");
            return nullptr;
        }
    }
    return exports;
}
} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
