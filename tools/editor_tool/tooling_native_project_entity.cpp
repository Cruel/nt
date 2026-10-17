#include "tooling_native_project_entity.hpp"

#include "../project_authoring/contracts.hpp"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/yaml_codec.hpp"
#include "../project_authoring/yaml_transaction.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <regex>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace noveltea::authoring;

Json failure(std::string error) { return {{"ok", false}, {"error", std::move(error)}}; }

void replace_all(std::string& source, std::string_view target, std::string_view replacement)
{
    for (std::size_t at = 0; (at = source.find(target, at)) != std::string::npos;) {
        source.replace(at, target.size(), replacement);
        at += replacement.size();
    }
}

std::string source_path(const std::string& family, const std::string& id)
{
    return "records/" + family + "/" + id + (family == "layouts" ? "/layout.yaml" : ".yaml");
}

std::string read_text(const std::filesystem::path& path)
{
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        throw std::runtime_error("Cannot read native entity source: " + path.string());
    const std::string result{std::istreambuf_iterator<char>(stream),
                             std::istreambuf_iterator<char>()};
    if (stream.bad())
        throw std::runtime_error("Cannot finish reading native entity source.");
    return result;
}

std::string pointer_segment(std::string_view value)
{
    std::string result;
    for (const char ch : value)
        result += ch == '~' ? "~0" : ch == '/' ? "~1" : std::string(1, ch);
    return result;
}

void reference_rewrites(const Json& value, std::string pointer, const std::string& family,
                        const std::string& from_id, const std::string& to_id,
                        std::vector<YamlValueEdit>& edits, std::vector<std::string>& blockers)
{
    if (value.is_object()) {
        if (value.contains("$ref")) {
            const auto& ref = value.at("$ref");
            if (ref.is_object() && ref.value("collection", std::string{}) == family &&
                ref.value("id", std::string{}) == from_id) {
                if (!to_id.empty())
                    edits.push_back({pointer + "/$ref/id", Json(to_id).dump(),
                                     YamlCommentDisposition::Keep, std::nullopt,
                                     YamlEditOperation::Replace});
                else
                    blockers.push_back(pointer + "/$ref");
                return;
            }
        }
        if (value.contains("$var") && family == "variables" && value.at("$var") == from_id) {
            if (!to_id.empty())
                edits.push_back({pointer + "/$var", Json(to_id).dump(),
                                 YamlCommentDisposition::Keep, std::nullopt,
                                 YamlEditOperation::Replace});
            else
                blockers.push_back(pointer + "/$var");
            return;
        }
        for (const auto& [key, child] : value.items()) {
            if (key.find(from_id) != std::string::npos)
                blockers.push_back(pointer + "/" + pointer_segment(key));
            else
                reference_rewrites(child, pointer + "/" + pointer_segment(key), family, from_id,
                                   to_id, edits, blockers);
        }
    } else if (value.is_array()) {
        for (std::size_t index = 0; index < value.size(); ++index)
            reference_rewrites(value.at(index), pointer + "/" + std::to_string(index), family,
                               from_id, to_id, edits, blockers);
    } else if (value.is_string() && value.get<std::string>().find(from_id) != std::string::npos) {
        blockers.push_back(pointer);
    }
}

bool canonical_id(const std::string& id)
{
    static const std::regex valid_id("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$");
    return std::regex_match(id, valid_id);
}

Json relocate_or_remove(const Json& request, ProjectSession& session,
                        const std::filesystem::path& root, const std::string& action,
                        const std::string& family, const std::string& id)
{
    if ((request.contains("sourceRevision") && !request.at("sourceRevision").is_string()) ||
        (request.contains("force") && !request.at("force").is_boolean()) ||
        (request.contains("allowPossibleSourceReferences") &&
         !request.at("allowPossibleSourceReferences").is_boolean()))
        return failure("Malformed native entity mutation options.");
    const bool rename = action == "entity-rename";
    const bool dry_run = request.value("dryRun", true);
    std::string to_id;
    if (rename) {
        if (!request.contains("toId") || !request.at("toId").is_string())
            return failure("Native rename requires the destination ID.");
        to_id = request.at("toId").get<std::string>();
        if (!canonical_id(to_id) || to_id == id)
            return failure("Native rename destination must be distinct canonical kebab-case.");
    }
    const auto from_path = source_path(family, id);
    const auto destination_path = rename ? source_path(family, to_id) : std::string{};
    if (!std::filesystem::is_regular_file(root / from_path))
        return failure("Native entity source does not exist.");
    if (rename && (std::filesystem::exists(root / destination_path) ||
                   std::filesystem::is_symlink(root / destination_path)))
        return failure("Native entity rename destination already exists.");
    const auto validated = session.validate_project();
    if (!validated.valid)
        return failure("Structural native entity operation requires a valid disk Project.");

    std::vector<YamlTransactionTarget> reference_targets;
    std::vector<std::string> blockers;
    Json rewritten = Json::array();
    // Only explicitly typed references may be rewritten. Unclassified source
    // strings and keys remain hard blockers, not user-overridable guesses.
    for (const auto& file : session.file_inventory()) {
        if (file.path == from_path || file.kind == ProjectFileKind::IgnoredState ||
            file.kind == ProjectFileKind::UntrackedFile)
            continue;
        if (family == "layouts" && file.path.starts_with("records/layouts/" + id + "/layout."))
            continue;
        if (!file.path.ends_with(".yaml") && !file.path.ends_with(".lua") &&
            !file.path.ends_with(".rml") && !file.path.ends_with(".rcss"))
            continue;
        if (!std::filesystem::is_regular_file(root / file.path))
            continue;
        const auto text = read_text(root / file.path);
        if (text.find(id) == std::string::npos)
            continue;
        if (!file.path.ends_with(".yaml")) {
            blockers.push_back(file.path);
            continue;
        }
        const auto opened = open_yaml_source(text);
        if (!opened.accepted)
            return failure("Native entity reference source is invalid: " + file.path);
        auto value = Json::parse(opened.source_json);
        std::vector<YamlValueEdit> edits;
        if (file.path == "editor.yaml" && value.is_object() && value.contains("recordMetadata") &&
            value.at("recordMetadata").is_object() && value.at("recordMetadata").contains(family) &&
            value.at("recordMetadata").at(family).is_object() &&
            value.at("recordMetadata").at(family).contains(id)) {
            const auto meta = value.at("recordMetadata").at(family).at(id);
            if (rename) {
                if (value.at("recordMetadata").at(family).contains(to_id))
                    return failure("Editor metadata already uses the destination entity ID.");
                edits.push_back(
                    {"/recordMetadata/" + pointer_segment(family) + "/" + pointer_segment(to_id),
                     meta.dump(), YamlCommentDisposition::Keep, std::nullopt,
                     YamlEditOperation::Add});
            }
            edits.push_back(
                {"/recordMetadata/" + pointer_segment(family) + "/" + pointer_segment(id), "",
                 YamlCommentDisposition::Keep, std::nullopt, YamlEditOperation::Remove});
            value["recordMetadata"][family].erase(id);
        }
        reference_rewrites(value, "", family, id, rename ? to_id : std::string{}, edits, blockers);
        if (edits.empty())
            continue;
        reference_targets.push_back({.path = file.path,
                                     .expected_revision = exact_source_revision(text),
                                     .baseline_source = text,
                                     .edits = std::move(edits),
                                     .create_source = std::nullopt,
                                     .erase = false});
        rewritten.push_back(file.path);
    }
    const auto source = read_text(root / from_path);
    const auto revision = exact_source_revision(source);
    if (!dry_run &&
        (!request.contains("sourceRevision") || request.at("sourceRevision") != revision))
        return failure("Structural mutation requires an exact source revision.");
    auto opened = open_yaml_source(source);
    if (!opened.accepted || !Json::parse(opened.source_json).is_object() ||
        Json::parse(opened.source_json).value("id", std::string{}) != id)
        return failure("Native entity physical owner identity does not match.");
    std::string target_source;
    if (rename) {
        std::vector<YamlValueEdit> edits{{"/id", Json(to_id).dump(), YamlCommentDisposition::Keep,
                                          std::nullopt, YamlEditOperation::Replace}};
        auto own_record = Json::parse(opened.source_json);
        own_record.erase("id");
        own_record.erase("label");
        if (own_record.contains("data") && own_record.at("data").is_object())
            own_record["data"].erase("displayName");
        reference_rewrites(own_record, "", family, id, to_id, edits, blockers);
        const auto next = edit_yaml_source(source, edits);
        if (!next.accepted)
            return failure(next.error);
        target_source = next.source;
    }
    if (!blockers.empty()) {
        std::sort(blockers.begin(), blockers.end());
        blockers.erase(std::unique(blockers.begin(), blockers.end()), blockers.end());
        return failure("Native entity mutation has unclassified or dangling source "
                       "references: " +
                       blockers.front());
    }
    Json result{{"ok", true},
                {"collection", family},
                {"id", id},
                {"dryRun", dry_run},
                {"writes", Json::array()}};
    if (rename)
        result["toId"] = to_id;
    result["rewrittenSources"] = rewritten;
    if (dry_run)
        return result;

    std::vector<YamlTransactionTarget> targets;
    targets.insert(targets.end(), reference_targets.begin(), reference_targets.end());
    targets.push_back({.path = from_path,
                       .expected_revision = revision,
                       .baseline_source = source,
                       .edits = {},
                       .create_source = std::nullopt,
                       .erase = true});
    if (rename)
        targets.push_back({.path = destination_path,
                           .expected_revision = "absent",
                           .baseline_source = "",
                           .edits = {},
                           .create_source = target_source,
                           .erase = false});
    if (family == "layouts") {
        const auto source_record = Json::parse(opened.source_json);
        const auto& data = source_record.at("data");
        for (const char* channel : {"rml", "rcss", "lua"}) {
            const auto mode = data.at(channel).at("sourceMode").get<std::string>();
            if (mode != "file")
                continue;
            const auto current_path = "records/layouts/" + id + "/layout." + channel;
            const auto current_source = read_text(root / current_path);
            if (rename && current_source.find(id) != std::string::npos)
                return failure("Layout companion embeds the old ID and requires a "
                               "semantic source rewrite: " +
                               current_path);
            targets.push_back({.path = current_path,
                               .expected_revision = exact_source_revision(current_source),
                               .baseline_source = current_source,
                               .edits = {},
                               .create_source = std::nullopt,
                               .erase = true});
            if (rename)
                targets.push_back({.path = "records/layouts/" + to_id + "/layout." + channel,
                                   .expected_revision = "absent",
                                   .baseline_source = "",
                                   .edits = {},
                                   .create_source = current_source,
                                   .erase = false});
        }
    }
    YamlTransactionService transaction(root);
    const auto prepared = transaction.prepare(targets, TransactionDecision::KeepComments);
    if (!prepared.accepted)
        return failure(prepared.error);
    const auto committed = transaction.commit(prepared, TransactionDecision::KeepComments);
    if (!committed.accepted)
        return failure(committed.error);
    result["writes"] = committed.changed_paths;
    return result;
}

} // namespace

Json native_project_entity(const Json& request, ProjectSession& session,
                           const std::filesystem::path& root)
{
    if (!request.contains("collection") || !request.at("collection").is_string() ||
        !request.contains("id") || !request.at("id").is_string() ||
        (request.contains("dryRun") && !request.at("dryRun").is_boolean()))
        return failure("Native entity operation requires a valid collection and record ID.");
    const auto action = request.at("action").get<std::string>();
    const auto family = request.at("collection").get<std::string>();
    const auto id = request.at("id").get<std::string>();
    if (!canonical_id(id))
        return failure("Entity ID must be canonical lowercase kebab-case.");
    // Check the collection before it is ever used as a physical path segment.
    // In particular, a delete/rename must never construct records/../../...
    // from a caller-supplied collection; the source template registry is the
    // authoritative list of record-owned collections.
    const auto template_json = default_entity_source_json(family);
    if (!template_json)
        return failure("Unknown or unsupported native entity collection.");
    if (action == "entity-rename" || action == "entity-delete")
        return relocate_or_remove(request, session, root, action, family, id);
    if (action != "entity-create")
        return failure("Unsupported native structural entity operation.");

    const bool dry_run = request.value("dryRun", true);
    const auto validated = session.validate_project();
    if (!validated.valid)
        return failure("Native entity create requires a valid disk Project.");
    const auto path = source_path(family, id);
    if (std::filesystem::exists(root / path) || std::filesystem::is_symlink(root / path))
        return failure("An entity source already exists at the target path.");
    const auto source = Json::parse(*template_json);
    if (!source.contains("source") || !source.at("source").is_string() ||
        !source.contains("labelPrefix") || !source.at("labelPrefix").is_string())
        return failure("Generated native entity source template is malformed.");
    const auto label = source.at("labelPrefix").get<std::string>() + " " + id;
    auto new_source = source.at("source").get<std::string>();
    replace_all(new_source, "nt-template-id", id);
    replace_all(new_source, "NovelTeaTemplateLabel", label);
    const auto opened = open_yaml_source(new_source);
    if (!opened.accepted)
        return failure("Generated source is not valid YAML: " + opened.error);
    const auto record = Json::parse(opened.source_json);
    if (record.value("id", std::string{}) != id || record.value("label", std::string{}) != label)
        return failure("Native entity source identity changed during creation.");
    Json result{{"ok", true},        {"collection", family}, {"id", id},
                {"dryRun", dry_run}, {"sourcePath", path},   {"writes", Json::array()}};
    if (dry_run)
        return result;

    std::vector<YamlTransactionTarget> targets;
    targets.push_back({.path = path,
                       .expected_revision = "absent",
                       .baseline_source = "",
                       .edits = {},
                       .create_source = new_source,
                       .erase = false});
    if (family == "layouts") {
        if (!source.contains("companions") || !source.at("companions").is_object())
            return failure("Missing generated Layout companion source metadata.");
        for (const auto& [leaf, content] : source.at("companions").items()) {
            if ((leaf != "layout.rml" && leaf != "layout.rcss" && leaf != "layout.lua") ||
                !content.is_string())
                return failure("Malformed generated Layout companion source.");
            targets.push_back({.path = "records/layouts/" + id + "/" + leaf,
                               .expected_revision = "absent",
                               .baseline_source = "",
                               .edits = {},
                               .create_source = content.get<std::string>(),
                               .erase = false});
        }
        if (source.at("companions").size() != 3)
            return failure("Native Layout generator requires three companion sources.");
    }
    YamlTransactionService transaction(root);
    auto prepared = transaction.prepare(targets, TransactionDecision::KeepComments);
    if (!prepared.accepted)
        return failure(prepared.error);
    const auto committed = transaction.commit(prepared, TransactionDecision::KeepComments);
    if (!committed.accepted)
        return failure(committed.error);
    result["writes"] = committed.changed_paths;
    return result;
}
