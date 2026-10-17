#include "tooling_native_c.h"

#include "../project_authoring/room_session.hpp"
#include "tooling_native_project_fmt.hpp"
#include "tooling_native_project_localization.hpp"
#include "tooling_native_project_sync.hpp"
#include "tooling_native_project_bundle.hpp"
#include "tooling_native_project_entity.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstring>
#include <filesystem>
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

Json operate(const Json& request)
{
    if (!request.is_object() || !request.contains("action") || !request.at("action").is_string())
        return failure("Native CLI Project action must be a string.");
    if (request.at("action") == "project-import")
        return native_project_bundle(request, nullptr, {});
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
    // The isolated certification invocation deliberately opens a fresh disk
    // session. It never borrows the editor's unsaved working Project.
    std::string error;
    auto session = ProjectSession::open(root, error);
    if (!session)
        return failure(error);

    if (action == "entity-inspect") {
        if (!request.contains("collection") || !request.at("collection").is_string() ||
            !request.contains("id") || !request.at("id").is_string() ||
            (request.contains("provenance") && !request.at("provenance").is_boolean()))
            return failure("Invalid native CLI record identity or provenance flag.");
        const auto collection = request.at("collection").get<std::string>();
        const auto id = request.at("id").get<std::string>();
        const auto owner = collection + "/" + id;
        const auto inspected = session->inspect_record(owner);
        if (!inspected.accepted)
            return failure(inspected.error);
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
        return {{"ok", true},
                {"fields", std::move(fields)},
                {"sourceRevision", found->second.disk_source_revision}};
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
        return native_project_strip_defaults(request, *session, root);
    if (action == "fmt")
        return native_project_format(request, *session, root);
    if (action == "localization-targets")
        return native_project_localization(request, *session, root);
    if (action == "localization-view")
        return native_project_localization_view(request, *session);
    if (action == "localization-sync")
        return native_project_localization_sync(request, *session, root);
    if (action == "localization-reconcile")
        return native_project_localization_reconcile(request, *session, root);
    if (action == "entity-create" || action == "entity-rename" || action == "entity-delete")
        return native_project_entity(request, *session, root);
    if (action == "entity-usages")
        return native_project_entity_usages(request, *session, root);
    if (action == "project-export" || action == "export-preparation" ||
        action == "runtime-package-preparation")
        return native_project_bundle(request, session.get(), root);

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
            const auto action =
                parsed.is_object() && parsed.contains("action") && parsed.at("action").is_string()
                    ? parsed.at("action").get<std::string>()
                    : std::string{};
            const auto boolean_flag = [&](std::string_view key, bool default_value) {
                return parsed.is_object() && parsed.contains(std::string(key)) &&
                               parsed.at(std::string(key)).is_boolean()
                           ? parsed.at(std::string(key)).get<bool>()
                           : default_value;
            };
            const bool mutating =
                action == "project-import" || action == "project-export" ||
                (action == "scoped-edit" && !boolean_flag("dryRun", true)) ||
                (action == "fmt-strip-defaults" && !boolean_flag("check", true)) ||
                (action == "fmt" && !boolean_flag("check", true)) ||
                (action == "localization-targets" && !boolean_flag("dryRun", true)) ||
                (action == "localization-sync" && !boolean_flag("dryRun", true)) ||
                (action == "localization-reconcile" && !boolean_flag("dryRun", true)) ||
                ((action == "entity-create" || action == "entity-rename" ||
                  action == "entity-delete") &&
                 !boolean_flag("dryRun", true));
            if (mutating && (!response || response_capacity < 8 * 1024 * 1024))
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
