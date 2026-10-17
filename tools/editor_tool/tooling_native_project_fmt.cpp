#include "tooling_native_project_fmt.hpp"

#include "../project_authoring/contracts.hpp"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/yaml_codec.hpp"
#include "../project_authoring/yaml_transaction.hpp"

#include <algorithm>
#include <fstream>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace noveltea::authoring;

Json failure(std::string message) { return {{"ok", false}, {"error", std::move(message)}}; }

std::string bytes_at(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read native format source.");
    const std::string bytes{std::istreambuf_iterator<char>(input),
                            std::istreambuf_iterator<char>()};
    if (input.bad())
        throw std::runtime_error("Cannot finish reading native format source.");
    return bytes;
}

std::vector<std::string> tokens(std::string_view path)
{
    std::vector<std::string> parts;
    if (path.empty() || path.front() != '/')
        return parts;
    for (std::size_t start = 1; start <= path.size();) {
        const auto end = path.find('/', start);
        const auto size = (end == std::string_view::npos ? path.size() : end) - start;
        std::string part(path.substr(start, size));
        for (std::size_t pos = 0; (pos = part.find('~', pos)) != std::string::npos;) {
            if (pos + 1 >= part.size() || (part[pos + 1] != '0' && part[pos + 1] != '1'))
                return {};
            part.replace(pos, 2, part[pos + 1] == '1' ? "/" : "~");
            ++pos;
        }
        parts.push_back(std::move(part));
        if (end == std::string_view::npos)
            break;
        start = end + 1;
    }
    return parts;
}

std::optional<Json> omission_default(const Json& metadata, const std::vector<std::string>& parts)
{
    for (std::size_t prefix = parts.size(); prefix > 0; --prefix) {
        std::string key;
        for (std::size_t index = 0; index < prefix; ++index) {
            if (index)
                key += '.';
            const auto& part = parts[index];
            const bool index_segment =
                !part.empty() && std::all_of(part.begin(), part.end(), [](char character) {
                    return character >= '0' && character <= '9';
                });
            key += index_segment ? "*" : part;
        }
        if (!metadata.contains(key))
            continue;
        Json value = metadata.at(key);
        bool complete = true;
        for (std::size_t index = prefix; index < parts.size(); ++index) {
            if (!value.is_object() || !value.contains(parts[index])) {
                complete = false;
                break;
            }
            value = value.at(parts[index]);
        }
        if (complete)
            return value;
    }
    return std::nullopt;
}

ValidationResult normalize(std::string_view family, std::string_view json)
{
    if (family == "rooms")
        return validate_room_source(json);
    if (family == "maps")
        return validate_map_source(json);
    if (family == "characters")
        return validate_character_source(json);
    if (family == "archetypes")
        return validate_archetype_source(json);
    if (family == "animations")
        return validate_animation_source(json);
    if (family == "materials")
        return validate_material_source(json);
    if (family == "interactables")
        return validate_interactable_sparse_source(json);
    if (family == "dialogues")
        return validate_dialogue_source(json);
    if (family == "scenes")
        return validate_scene_source(json);
    if (family == "verbs")
        return validate_verb_source(json);
    if (family == "interactions")
        return validate_interaction_source(json);
    if (family == "tests")
        return validate_test_source(json);
    return {};
}

struct SparseCompaction {
    bool accepted = false;
    std::string candidate;
    std::vector<YamlValueEdit> edits;
    std::string error;
};

SparseCompaction compact_record(std::string_view family, std::string_view baseline)
{
    SparseCompaction result;
    result.candidate = std::string(baseline);
    const auto defaults_json = source_omission_defaults_json(family);
    if (!defaults_json) {
        result.accepted = true;
        return result;
    }
    const auto opened = open_yaml_source(baseline);
    if (!opened.accepted) {
        result.error = opened.error;
        return result;
    }
    const auto first = normalize(family, opened.source_json);
    if (!first.accepted) {
        result.error = "Native default stripping requires a valid semantic record.";
        return result;
    }
    const auto explicit_data = Json::parse(opened.source_json);
    const auto defaults = Json::parse(*defaults_json);
    auto locations = opened.locations;
    std::stable_sort(locations.begin(), locations.end(), [](const auto& left, const auto& right) {
        return tokens(left.path).size() > tokens(right.path).size();
    });
    for (const auto& location : locations) {
        if (location.path.empty() || location.has_comment)
            continue;
        const auto parts = tokens(location.path);
        const auto value = omission_default(defaults, parts);
        if (!value || !explicit_data.contains(Json::json_pointer(location.path)) ||
            explicit_data.at(Json::json_pointer(location.path)) != *value)
            continue;
        const auto current = open_yaml_source(result.candidate);
        if (!current.accepted ||
            !Json::parse(current.source_json).contains(Json::json_pointer(location.path)))
            continue;
        YamlValueEdit edit;
        edit.path = location.path;
        edit.value_json = value->dump();
        edit.omission_default_json = value->dump();
        const auto compacted = edit_yaml_source(result.candidate, {edit});
        if (!compacted.accepted || compacted.source == result.candidate)
            continue;
        const auto projected = normalize(family, compacted.source_json);
        if (!projected.accepted ||
            Json::parse(projected.effective_json) != Json::parse(first.effective_json))
            continue;
        result.candidate = compacted.source;
        result.edits.push_back(std::move(edit));
    }
    const auto after = open_yaml_source(result.candidate);
    const auto final = after.accepted ? normalize(family, after.source_json) : ValidationResult{};
    if (!final.accepted || Json::parse(final.effective_json) != Json::parse(first.effective_json)) {
        result.error = "Native sparse formatting changed effective Project semantics.";
        return result;
    }
    result.accepted = true;
    return result;
}

} // namespace

Json native_project_strip_defaults(const Json& request, ProjectSession& session,
                                   const std::filesystem::path& root)
{
    if (!request.contains("path") || !request.at("path").is_string() ||
        (request.contains("check") && !request.at("check").is_boolean()) ||
        (request.contains("sourceRevision") && !request.at("sourceRevision").is_string()))
        return failure("Native sparse format requires a tracked source path.");
    const std::string path = request.at("path").get<std::string>();
    // This command intentionally accepts only an existing record-owned source.
    // Do not generalize an arbitrary user path to the filesystem writer.
    const auto prefix = std::string("records/");
    if (!path.starts_with(prefix) || !path.ends_with(".yaml"))
        return failure("Native sparse formatting currently requires a record YAML path.");
    const auto rest = path.substr(prefix.size());
    const auto slash = rest.find('/');
    if (slash == std::string::npos || rest.find('/', slash + 1) != std::string::npos)
        return failure("Native sparse formatting does not support this source layout.");
    const auto family = rest.substr(0, slash);
    const auto id = rest.substr(slash + 1, rest.size() - slash - 6);
    const auto defaults_json = source_omission_defaults_json(family);
    if (!defaults_json || id.empty())
        return failure("Native sparse defaults are not registered for this record family.");
    if (std::none_of(session.file_inventory().begin(), session.file_inventory().end(),
                     [&](const ProjectFile& file) {
                         return file.path == path && file.kind == ProjectFileKind::TrackedSource;
                     }))
        return failure("Native format source is not a tracked Project file.");
    const auto verified = session.validate_project();
    if (!verified.valid)
        return failure("Cannot compact an invalid Project.");

    const std::string baseline = bytes_at(root / path);
    const auto revision = exact_source_revision(baseline);
    const bool check = request.value("check", true);
    if (!check && (!request.contains("sourceRevision") ||
                   request.at("sourceRevision").get<std::string>() != revision))
        return failure("Native format commit requires the current exact source revision.");
    const auto compaction = compact_record(family, baseline);
    if (!compaction.accepted)
        return failure(compaction.error);
    const bool changed = compaction.candidate != baseline;
    Json response{{"ok", true},
                  {"check", check},
                  {"changed", changed},
                  {"path", path},
                  {"sourceRevision", revision},
                  {"removedDefaults", compaction.edits.size()}};
    if (!check && changed) {
        YamlTransactionService writer(root);
        const auto prepared = writer.prepare({YamlTransactionTarget{.path = path,
                                                                    .expected_revision = revision,
                                                                    .baseline_source = baseline,
                                                                    .edits = compaction.edits,
                                                                    .create_source = std::nullopt,
                                                                    .erase = false}},
                                             TransactionDecision::KeepComments);
        if (!prepared.accepted || prepared.targets.size() != 1 ||
            prepared.targets.front().after_source != compaction.candidate)
            return failure(prepared.error.empty() ? "Format transaction projection mismatch."
                                                  : prepared.error);
        const auto committed = writer.commit(prepared, TransactionDecision::KeepComments);
        if (!committed.accepted)
            return failure(committed.error);
        response["writes"] = Json::array({path});
    } else {
        response["writes"] = Json::array();
    }
    return response;
}

Json native_project_format(const Json& request, ProjectSession& session,
                           const std::filesystem::path& root)
{
    if ((request.contains("path") && !request.at("path").is_string()) ||
        (request.contains("check") && !request.at("check").is_boolean()) ||
        (request.contains("diskPreconditions") && !request.at("diskPreconditions").is_object()) ||
        (request.contains("stripDefaults") && !request.at("stripDefaults").is_boolean()))
        return failure("Native fmt requires a tracked source path and valid options.");
    const bool check = request.value("check", true);
    const bool strip_defaults = request.value("stripDefaults", false);
    if (strip_defaults && !session.validate_project().valid)
        return failure("Cannot compact sparse YAML defaults from an invalid Project.");
    const auto path = request.value("path", std::string{});
    std::vector<std::string> selected;
    for (const auto& file : session.file_inventory()) {
        if (file.kind != ProjectFileKind::TrackedSource || !file.path.ends_with(".yaml"))
            continue;
        if (!path.empty() && path != file.path)
            continue;
        selected.push_back(file.path);
    }
    if (!path.empty() && selected.empty())
        return failure("Requested format path is not an existing tracked YAML source.");
    std::vector<YamlTransactionTarget> targets;
    Json files = Json::array();
    std::size_t removed_defaults = 0;
    for (const auto& file : selected) {
        const auto source = bytes_at(root / file);
        std::string candidate = source;
        if (strip_defaults && file.starts_with("records/")) {
            const auto rest = file.substr(std::string("records/").size());
            const auto family_end = rest.find('/');
            if (family_end != std::string::npos &&
                rest.find('/', family_end + 1) == std::string::npos) {
                const auto family = rest.substr(0, family_end);
                const auto sparse = compact_record(family, source);
                if (!sparse.accepted)
                    return failure("Sparse default stripping rejected " + file + ": " +
                                   sparse.error);
                candidate = sparse.candidate;
                removed_defaults += sparse.edits.size();
            }
        }
        const auto formatted = format_yaml_source(candidate);
        if (!formatted.accepted)
            return failure("Native formatter rejected " + file + ": " + formatted.error);
        if (formatted.source == source)
            continue;
        const auto revision = exact_source_revision(source);
        files.push_back(file);
        if (check)
            continue;
        if (!request.contains("diskPreconditions") ||
            !request.at("diskPreconditions").contains(file) ||
            !request.at("diskPreconditions").at(file).is_string() ||
            request.at("diskPreconditions").at(file) != revision)
            return failure("Native fmt requires an exact source revision for " + file);
        std::optional<std::string> semantic_family;
        if (strip_defaults && file.starts_with("records/")) {
            const auto rest = file.substr(std::string("records/").size());
            const auto slash = rest.find('/');
            if (slash != std::string::npos && rest.find('/', slash + 1) == std::string::npos)
                semantic_family = rest.substr(0, slash);
        }
        targets.push_back(YamlTransactionTarget{.path = file,
                                                .expected_revision = revision,
                                                .baseline_source = source,
                                                .edits = {},
                                                .create_source = std::nullopt,
                                                .erase = false,
                                                .replacement_source = formatted.source,
                                                .semantic_compaction_family = semantic_family});
    }
    Json response{{"ok", true},
                  {"check", check},
                  {"changed", !files.empty()},
                  {"stripDefaults", strip_defaults},
                  {"removedDefaults", removed_defaults},
                  {"files", files},
                  {"writes", Json::array()}};
    if (!check && !targets.empty()) {
        YamlTransactionService transaction(root);
        const auto prepared = transaction.prepare(targets, TransactionDecision::KeepComments);
        if (!prepared.accepted)
            return failure(prepared.error);
        const auto committed = transaction.commit(prepared, TransactionDecision::KeepComments);
        if (!committed.accepted)
            return failure(committed.error);
        response["writes"] = committed.changed_paths;
    }
    return response;
}
