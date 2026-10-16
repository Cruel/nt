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
    result["baseline"] = Json::parse(state.baseline_json);
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
            list.push_back(std::move(value));
        }
        return list;
    };
    value["diagnosticsAdded"] = diagnostics(result.diagnostics_added);
    value["diagnosticsRemoved"] = diagnostics(result.diagnostics_removed);
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
    napi_value argv[5]{};
    std::size_t argc = 5;
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
            if (argc != 3)
                throw std::runtime_error("useDisk requires working revision and owner.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid working revision.");
            const auto resolved = session.project->use_disk(static_cast<std::uint64_t>(revision),
                                                            string_arg(env, argv[2]));
            return js_string(env, result_json(*session.project, resolved).to_string());
        }
        if (name == "saveOwners") {
            if (argc != 5)
                throw std::runtime_error("saveOwners needs revision, owners, keepMine, comments.");
            std::int64_t revision = -1;
            bool keep_mine = false;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0 ||
                napi_get_value_bool(env, argv[3], &keep_mine) != napi_ok)
                throw std::runtime_error("Invalid scoped Save revision or conflict decision.");
            const auto owners = Json::parse(string_arg(env, argv[2]));
            if (!owners.is_array() || owners.size() > 256)
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
            const auto saved = session.project->save_owners(static_cast<std::uint64_t>(revision),
                                                            selected, keep_mine, decision);
            return js_string(env, result_json(*session.project, saved).to_string());
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
        if (name == "save") {
            if (argc != 2)
                throw std::runtime_error("save requires a disk source revision.");
            return js_string(
                env, result_json(*session.project, session.project->save(string_arg(env, argv[1])))
                         .to_string());
        }
        if (name == "patch") {
            if (argc != 3 && argc != 4)
                throw std::runtime_error("patch requires working revision and operations JSON.");
            std::int64_t revision = -1;
            if (napi_get_value_int64(env, argv[1], &revision) != napi_ok || revision < 0)
                throw std::runtime_error("Invalid working revision.");
            const auto operations = Json::parse(string_arg(env, argv[2]));
            if (!operations.is_array() || operations.size() > 256)
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
            if (argc == 4) {
                const auto preconditions = Json::parse(string_arg(env, argv[3]));
                if (!preconditions.is_object() || preconditions.size() > 256)
                    throw std::runtime_error("Invalid recovery source preconditions.");
                for (const auto& entry : preconditions.object_range()) {
                    if (!entry.value().is_string())
                        throw std::runtime_error("Invalid recovery source revision.");
                    disk_preconditions.emplace(entry.key(), entry.value().as<std::string>());
                }
            }
            const auto updated = session.project->patch(static_cast<std::uint64_t>(revision),
                                                        patches, disk_preconditions);
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
    static const char* operations[]{"open",         "close",     "snapshot", "observe",
                                    "inspect",      "reconcile", "useDisk",  "saveOwners",
                                    "coverageLost", "hint",      "save",     "patch"};
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
