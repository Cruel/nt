#include "tooling_native_c.h"

#include "../project_authoring/room_session.hpp"
#include "tooling_native_project_fmt.hpp"
#include "tooling_native_project_localization.hpp"
#include "tooling_native_project_sync.hpp"
#include "tooling_native_project_bundle.hpp"
#include "tooling_native_project_entity.hpp"
#include "tooling_native_project_asset.hpp"
#include "tooling_native_project_create.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <mutex>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace noveltea::authoring;

Json provenance(const Json& effective, const Json* explicit_source)
{
    if (effective.is_array()) {
        if (effective.empty())
            return explicit_source ? "explicit" : "default";
        Json result = Json::array();
        for (std::size_t i = 0; i < effective.size(); ++i) {
            const Json* authored =
                explicit_source && explicit_source->is_array() && i < explicit_source->size()
                    ? &(*explicit_source)[i]
                    : nullptr;
            result.push_back(provenance(effective[i], authored));
        }
        return result;
    }
    if (effective.is_object()) {
        if (effective.empty())
            return explicit_source ? "explicit" : "default";
        Json result = Json::object();
        for (auto it = effective.begin(); it != effective.end(); ++it) {
            // The source shorthand for a typed reference or Condition carries
            // one explicit scalar, not a physically present nested mapping.
            if (explicit_source && explicit_source->is_string() &&
                (it.key() == "$ref" || (it.key() == "kind" && it.value() == "always"))) {
                result[it.key()] = "explicit";
                continue;
            }
            const Json* authored = explicit_source && explicit_source->is_object() &&
                                           explicit_source->contains(it.key())
                                       ? &explicit_source->at(it.key())
                                       : nullptr;
            result[it.key()] = provenance(it.value(), authored);
        }
        return result;
    }
    return explicit_source ? "explicit" : "default";
}

Json failure(std::string error) { return {{"ok", false}, {"error", std::move(error)}}; }

// The native-admitted Project owns the runtime Asset reference closure. The heavy
// runtime worker must not rebuild an authoring dependency graph by rereading Lua or Layout sources.
void collect_runtime_asset_references(const Json& value, const std::string& path,
                                      std::set<std::string>& ids)
{
    if (value.is_array()) {
        for (std::size_t i = 0; i < value.size(); ++i)
            collect_runtime_asset_references(value[i], path + "/" + std::to_string(i), ids);
        return;
    }
    if (!value.is_object())
        return;
    const auto reference = value.find("$ref");
    if (reference != value.end() && reference->is_object() &&
        reference->value("collection", Json{}) == "assets" && reference->contains("id") &&
        reference->at("id").is_string())
        ids.insert(reference->at("id").get<std::string>());
    if (value.value("kind", Json{}) == "record" && value.value("collection", Json{}) == "assets" &&
        value.contains("id") && value.at("id").is_string())
        ids.insert(value.at("id").get<std::string>());
    for (auto it = value.begin(); it != value.end(); ++it) {
        const auto child_path = path + "/" + it.key();
        // Tests and editor views are tooling-only and never contribute Runtime
        // Package Asset reachability. The existing runtime compiler strips both.
        if ((path.empty() && (it.key() == "tests" || it.key() == "editor")) ||
            child_path.starts_with("/tests/") || child_path.starts_with("/editor/"))
            continue;
        // Localization-owned Assets are resolved by the separate export locale closure.
        if (child_path.starts_with("/localization/assets/") ||
            (child_path.starts_with("/localization/locales/") &&
             child_path.find("/fontStack") != std::string::npos))
            continue;
        collect_runtime_asset_references(it.value(), child_path, ids);
    }
}

bool mutating_request(const Json& request)
{
    const auto action =
        request.is_object() && request.contains("action") && request.at("action").is_string()
            ? request.at("action").get<std::string>()
            : std::string{};
    const auto boolean_flag = [&](std::string_view key, bool default_value) {
        return request.is_object() && request.contains(std::string(key)) &&
                       request.at(std::string(key)).is_boolean()
                   ? request.at(std::string(key)).get<bool>()
                   : default_value;
    };
    return action == "project-create" || action == "project-import" || action == "project-export" ||
           (action == "asset-import" && !boolean_flag("dryRun", true)) ||
           (action == "scoped-edit" && !boolean_flag("dryRun", true)) ||
           ((action == "fmt-strip-defaults" || action == "fmt") && !boolean_flag("check", true)) ||
           ((action == "localization-targets" || action == "localization-sync" ||
             action == "localization-reconcile" || action == "entity-create" ||
             action == "entity-rename" || action == "entity-delete") &&
            !boolean_flag("dryRun", true));
}

// The existing daemon executes a single Project-owner process per root.
// Retain native source/revision and semantic caches inside that process;
// never share dirty editor state or create a second watcher/daemon.
struct NativeCliOwner {
    std::mutex mutex;
    std::filesystem::path root;
    std::unique_ptr<ProjectSession> session;
};

NativeCliOwner& native_cli_owner()
{
    static NativeCliOwner owner;
    return owner;
}

Json operate(const Json& request)
{
    if (!request.is_object() || !request.contains("action") || !request.at("action").is_string())
        return failure("Native CLI Project action must be a string.");
    if (request.at("action") == "project-import")
        return native_project_bundle(request, nullptr, {});
    if (request.at("action") == "project-create")
        return native_project_create(request);
    if (!request.is_object() || !request.contains("projectRoot") ||
        !request["projectRoot"].is_string())
        return failure("Native CLI Project operation requires projectRoot.");
    // Construct paths from UTF-8 explicitly: Windows' narrow path constructor
    // otherwise uses the process code page and can select a different Project.
    const auto root_utf8 = request["projectRoot"].get<std::string>();
    const auto requested = std::filesystem::path(std::u8string(root_utf8.begin(), root_utf8.end()));
    if (!requested.is_absolute())
        return failure("Native CLI Project operation requires an absolute root.");
    const auto root = std::filesystem::canonical(requested);
    const auto action = request.at("action").get<std::string>();
    if (action == "project-validate") {
        const auto serialized = Json{{"projectRoot", root_utf8}, {"action", "validate"}}.dump();
        const auto* bytes = reinterpret_cast<const std::uint8_t*>(serialized.data());
        // Validation retains a warm owner cache. A length probe would execute
        // it twice and change the published cold/warm generation between the
        // calls, just as a mutation probe could execute a write twice.
        std::string response(16 * 1024 * 1024, '\0');
        const auto required = noveltea_tooling_native_disk_project_validation_json(
            bytes, serialized.size(), reinterpret_cast<std::uint8_t*>(response.data()),
            response.size());
        if (required > response.size())
            return failure("Native disk validation result exceeds the command response limit.");
        response.resize(required);
        return Json::parse(response);
    }
    if (action == "source-generation-proof") {
        if (!request.contains("expectedSourceGeneration") ||
            !request.at("expectedSourceGeneration").is_string())
            return failure("Source proof requires an expected source generation.");
        if (!native_project_source_generation_is_current(
                root, request.at("expectedSourceGeneration").get<std::string>()))
            return {{"ok", false}, {"kind", "conflict"}, {"error", "Project sources changed."}};
        return {{"ok", true}};
    }
    if (action == "asset-audit")
        return native_project_asset_audit(root);
    auto& owner = native_cli_owner();
    std::scoped_lock owner_lock(owner.mutex);
    if (owner.root != root) {
        owner.session.reset();
        owner.root = root;
    }
    if (action == "asset-import" &&
        (!request.contains("dryRun") || request.at("dryRun") == false)) {
        if (const auto recovery_error = native_project_asset_recover(root))
            return failure("Native Asset import recovery: " + *recovery_error);
    }
    if (owner.session) {
        const auto observed = owner.session->observe_sources();
        // The CLI owns only clean disk state. Open record editors must not
        // retain old source baselines after an external or transactional write.
        if (observed.full_rescan || !observed.authoritative || !observed.delta.changed.empty() ||
            !observed.delta.added.empty() || !observed.delta.removed.empty())
            owner.session.reset();
    }
    std::string error;
    const bool reused_owner = owner.session != nullptr;
    if (!owner.session)
        owner.session = ProjectSession::open(root, error);
    auto* session = owner.session.get();
    if (!session) {
        constexpr std::string_view malformed_prefix = "Invalid record YAML: ";
        if (error.starts_with(malformed_prefix)) {
            const auto source = error.substr(malformed_prefix.size());
            return {{"ok", false},
                    {"error", "Record is malformed."},
                    {"exitCode", 3},
                    {"diagnostics", Json::array({{{"code", "WORKSPACE_SOURCE_READ"},
                                                  {"severity", "error"},
                                                  {"path", "/" + source},
                                                  {"message", "Record is malformed."}}})}};
        }
        if (action == "project-export")
            return {{"ok", false}, {"error", error}, {"kind", "invalid-project"}};
        return failure(error);
    }

    struct DiskSessionReset {
        NativeCliOwner& owner;
        bool active;
        ~DiskSessionReset()
        {
            // A writer may have changed disk or left an uncommitted working patch.
            // Neither state may leak into the next disk-authoritative command.
            if (active)
                owner.session.reset();
        }
    } disk_session_reset{owner, action == "scoped-edit" || mutating_request(request)};

    // Capture before validation so a disk race cannot attach newer source bytes
    // to an effective Project assembled from an earlier generation.
    const auto shader_generation = action == "shader-preparation"
                                       ? native_project_source_generation(*session, root)
                                       : std::string{};

    // The public CLI reports authoring warnings gathered during workspace
    // admission even when the requested operation itself succeeds. Preserve
    // them at the same pre-mutation generation, rather than reconstructing
    // Project semantics in the ScriptC transport layer.
    Json authoring_diagnostics = Json::array();
    const auto validation = session->validate_project();
    for (const auto& diagnostic : validation.diagnostics) {
        // This is an editor-side authoring explanation, not a public CLI
        // diagnostic. Match the disk-validation CLI projection policy.
        const bool blocked_test_semantic = diagnostic.severity == "error" &&
                                           diagnostic.path.starts_with("/tests/") &&
                                           diagnostic.code == "authoring.test.steps-required";
        if ((diagnostic.severity == "error" && !blocked_test_semantic) ||
            diagnostic.code == "authoring.interaction.selector-conditional")
            continue;
        // Public CLI diagnostics retain the established schema-family code
        // even where the native spatial validator has a shorter internal ID.
        const auto code = diagnostic.code == "room.description.empty"
                              ? "authoring.rooms.rooms.record.data.description"
                          : diagnostic.code == "layout.source" &&
                                  diagnostic.path.ends_with("/data/rml/sourceText") &&
                                  diagnostic.severity == "warning"
                              ? "authoring.layouts.layouts.record.data.rml.sourcetext"
                          : diagnostic.code == "authoring.test.preview-step"
                              ? "authoring.tests.tests.record.data.preview.selectedstepid"
                          : blocked_test_semantic ? "authoring.tests.tests.record.data.steps"
                                                  : diagnostic.code.c_str();
        authoring_diagnostics.push_back({{"code", code},
                                         {"path", diagnostic.path},
                                         {"severity", diagnostic.severity},
                                         {"message", diagnostic.message}});
    }
    const auto effective = Json::parse(session->snapshot().normalized_json, nullptr, false);
    if (effective.is_object() && effective.contains("project") &&
        effective.at("project").is_object() && effective.at("project").contains("version") &&
        effective.at("project").at("version").is_string()) {
        const auto version =
            trim_ecmascript(effective.at("project").at("version").get<std::string>());
        static const std::regex semver(R"(^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$)");
        if (!version.empty() && !std::regex_match(version, semver))
            authoring_diagnostics.push_back(
                {{"code", "authoring.project.version.semver-recommended"},
                 {"path", "/project/version"},
                 {"severity", "warning"},
                 {"message", "Project version should use a semver-like value such as 0.1.0."}});
    }
    if (validation.valid && effective.is_object() &&
        (!effective.contains("entrypoint") || effective.at("entrypoint").is_null())) {
        authoring_diagnostics.push_back({{"code", "authoring.entrypoint.missing"},
                                         {"severity", "warning"},
                                         {"path", "/entrypoint"},
                                         {"message", "No project entrypoint is configured yet."}});
    }
    const auto with_diagnostics = [&](Json result) -> Json {
        if (result.is_object()) {
            result["cliDiagnostics"] = authoring_diagnostics;
            result["nativeOwnerReused"] = reused_owner;
        }
        return result;
    };

    if (action == "shader-preparation") {
        const auto prepared =
            session->prepare_complete_working(session->snapshot().working_revision);
        if (!prepared.accepted) {
            auto result = with_diagnostics(failure(prepared.error));
            result["projectDiagnostics"] = Json::array();
            for (const auto& diagnostic : prepared.diagnostics)
                result["projectDiagnostics"].push_back({{"code", diagnostic.code},
                                                        {"path", diagnostic.path},
                                                        {"severity", diagnostic.severity},
                                                        {"message", diagnostic.message}});
            return result;
        }
        Json overlays = Json::object();
        Json source_revisions = Json::object();
        for (const auto& [relative, revision] : prepared.source_revisions) {
            source_revisions[relative] = revision;
            if (!relative.starts_with("shaders/"))
                continue;
            const auto source = root / relative;
            if (std::filesystem::is_symlink(source) || !std::filesystem::is_regular_file(source))
                return failure("Unsafe native shader source: " + relative);
            std::ifstream input(source, std::ios::binary);
            if (!input)
                return failure("Cannot read native shader source: " + relative);
            std::string bytes{std::istreambuf_iterator<char>{input},
                              std::istreambuf_iterator<char>{}};
            if (input.bad())
                return failure("Cannot finish native shader source: " + relative);
            if (exact_source_revision(bytes) != revision)
                return {{"ok", false},
                        {"kind", "conflict"},
                        {"error", "Shader source changed: " + relative}};
            overlays[relative] = std::move(bytes);
        }
        if (!native_project_source_generation_is_current(root, shader_generation))
            return {{"ok", false}, {"kind", "conflict"}, {"error", "Project sources changed."}};
        const auto prepared_project = Json::parse(prepared.complete_project_json);
        std::set<std::string> referenced_assets;
        collect_runtime_asset_references(prepared_project, "", referenced_assets);
        return with_diagnostics({{"ok", true},
                                 {"project", prepared_project},
                                 {"sourceGeneration", shader_generation},
                                 {"sourceRevisions", std::move(source_revisions)},
                                 {"sourceOverlays", std::move(overlays)},
                                 {"referencedAssetIds", referenced_assets}});
    }

    if (action == "asset-import")
        return with_diagnostics(native_project_asset_import(request, *session, root));

    if (action == "entity-inspect") {
        if (!request.contains("collection") || !request.at("collection").is_string() ||
            !request.contains("id") || !request.at("id").is_string() ||
            (request.contains("provenance") && !request.at("provenance").is_boolean()))
            return failure("Invalid native CLI record identity or provenance flag.");
        const auto collection = request.at("collection").get<std::string>();
        const auto id = request.at("id").get<std::string>();
        const auto owner = collection + "/" + id;
        const auto inspected = session->inspect_record(owner);
        if (!inspected.accepted) {
            const auto relative = collection == "layouts"
                                      ? "records/layouts/" + id + "/layout.yaml"
                                      : "records/" + collection + "/" + id + ".yaml";
            if (!std::filesystem::exists(root / relative))
                return with_diagnostics(
                    {{"ok", false}, {"kind", "not-found"}, {"error", "Record does not exist."}});
            return with_diagnostics(failure(inspected.error));
        }
        const auto snapshots = session->record_snapshots();
        const auto found = snapshots.find(owner);
        if (found == snapshots.end() || !found->second.valid)
            return failure("Native record inspection is invalid.");
        Json record = Json::parse(found->second.normalized_json);
        Json fields{{"collection", collection}, {"id", id}, {"record", record}};
        if (request.value("provenance", false)) {
            const Json source = Json::parse(found->second.source_json);
            fields["provenance"] = provenance(record, &source);
        }
        return with_diagnostics({{"ok", true},
                                 {"fields", std::move(fields)},
                                 {"sourceRevision", found->second.disk_source_revision}});
    }

    if (action == "scoped-edit") {
        if (!request.contains("patches") || !request.at("patches").is_array())
            return failure("Scoped edit requires a patch array.");
        std::vector<RoomPatch> patches;
        for (const auto& item : request.at("patches")) {
            if (!item.is_object() || !item.contains("path") || !item.at("path").is_string() ||
                !item.contains("op") || !item.at("op").is_string() ||
                (item.contains("comments") && !item.at("comments").is_string()))
                return failure("Malformed native CLI patch.");
            const auto operation = item.at("op").get<std::string>();
            RoomPatch patch;
            patch.operation = operation == "add"       ? RoomPatch::Operation::Add
                              : operation == "replace" ? RoomPatch::Operation::Replace
                              : operation == "remove"
                                  ? RoomPatch::Operation::Remove
                                  : throw std::runtime_error("Unknown patch operation.");
            patch.path = item.at("path").get<std::string>();
            if (patch.operation != RoomPatch::Operation::Remove) {
                if (!item.contains("value"))
                    return failure("Native CLI patch value is missing.");
                patch.value_json = item.at("value").dump();
            }
            patch.comments = item.value("comments", std::string("keep")) == "remove"
                                 ? YamlCommentDisposition::Remove
                                 : YamlCommentDisposition::Keep;
            patches.push_back(std::move(patch));
        }
        std::map<std::string, std::string> preconditions;
        if (request.contains("diskPreconditions")) {
            if (!request.at("diskPreconditions").is_object())
                return failure("Native disk preconditions must be a mapping.");
            for (const auto& [_, value] : request.at("diskPreconditions").items())
                if (!value.is_string())
                    return failure("Native disk precondition revision must be a string.");
            preconditions =
                request.at("diskPreconditions").get<std::map<std::string, std::string>>();
        }
        if ((request.contains("dryRun") && !request.at("dryRun").is_boolean()) ||
            (request.contains("expectedWorkingRevision") &&
             !request.at("expectedWorkingRevision").is_number_unsigned()) ||
            (request.contains("commentDecision") && !request.at("commentDecision").is_string()))
            return failure("Invalid native CLI edit options.");
        const bool dry_run = request.value("dryRun", true);
        if (!dry_run && !request.contains("expectedWorkingRevision"))
            return failure("Native CLI commit requires an expected working revision.");
        const auto before = session->snapshot();
        const auto expected = request.value("expectedWorkingRevision", before.working_revision);
        const auto patched = session->patch(expected, patches, preconditions);
        if (!patched.accepted)
            return failure(patched.error);
        Json result{{"ok", true},
                    {"dryRun", dry_run},
                    {"workingRevision", patched.snapshot.working_revision},
                    {"affectedOwners", patched.affected_records},
                    {"valid", patched.snapshot.valid}};
        if (!dry_run && !patched.affected_records.empty()) {
            for (const auto& owner : patched.affected_records)
                if (!preconditions.contains(owner))
                    return failure("Native CLI commit requires exact disk precondition for " +
                                   owner);
            const auto decision = request.value("commentDecision", std::string("keep"));
            const auto comments = decision == "keep"       ? TransactionDecision::KeepComments
                                  : decision == "remove"   ? TransactionDecision::RemoveComments
                                  : decision == "per-edit" ? TransactionDecision::UseEditDecisions
                                                           : TransactionDecision::Cancel;
            const auto saved = session->save_owners(patched.snapshot.working_revision,
                                                    patched.affected_records, false, comments);
            if (!saved.accepted)
                return failure(saved.error);
            result["savedOwners"] = saved.affected_records;
            result["workingRevision"] = saved.snapshot.working_revision;
        }
        return result;
    }

    if (action == "fmt-strip-defaults")
        return with_diagnostics(native_project_strip_defaults(request, *session, root));
    if (action == "fmt")
        return with_diagnostics(native_project_format(request, *session, root));
    if (action == "localization-targets")
        return with_diagnostics(native_project_localization(request, *session, root));
    if (action == "localization-view")
        return with_diagnostics(native_project_localization_view(request, *session));
    if (action == "localization-sync")
        return with_diagnostics(native_project_localization_sync(request, *session, root));
    if (action == "localization-reconcile")
        return with_diagnostics(native_project_localization_reconcile(request, *session, root));
    if (action == "entity-create" || action == "entity-rename" || action == "entity-delete")
        return with_diagnostics(native_project_entity(request, *session, root));
    if (action == "entity-usages")
        return with_diagnostics(native_project_entity_usages(request, *session, root));
    if (action == "project-export" || action == "export-preparation" ||
        action == "runtime-package-preparation")
        return native_project_bundle(request, session, root);

    return failure("Unknown native CLI Project operation.");
}
} // namespace

extern "C" std::uint64_t
noveltea_tooling_native_project_commands_json(const std::uint8_t* request,
                                              std::uint64_t request_size, std::uint8_t* response,
                                              std::uint64_t response_capacity)
{
    std::string serialized;
    try {
        if (!request && request_size != 0)
            throw std::runtime_error("Native CLI Project request is absent.");
        const auto parsed = Json::parse(std::string_view(reinterpret_cast<const char*>(request),
                                                         static_cast<std::size_t>(request_size)),
                                        nullptr, false);
        if (parsed.is_discarded())
            serialized = failure("Malformed native CLI Project JSON request.").dump();
        else {
            // The native API may be used by a two-pass C caller. Such a size
            // probe must never execute a filesystem mutation on its first
            // call or execute with a buffer too small for the result.
            if (mutating_request(parsed) && (!response || response_capacity < 8 * 1024 * 1024))
                serialized = failure("Mutating native Project commands require a preallocated "
                                     "8 MiB response buffer; probing is forbidden.")
                                 .dump();
            else
                serialized = operate(parsed).dump();
        }
    } catch (const std::exception& error) {
        serialized = failure(error.what()).dump();
    }
    const auto required = static_cast<std::uint64_t>(serialized.size());
    if (response && response_capacity >= required)
        std::memcpy(response, serialized.data(), serialized.size());
    return required;
}
