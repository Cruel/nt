#include "tooling_native_project_entity.hpp"

#include "../project_authoring/contracts.hpp"
#include "../project_authoring/localization_semantics.hpp"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_analysis.hpp"
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/yaml_codec.hpp"
#include "../project_authoring/yaml_transaction.hpp"

#include <algorithm>
#include <chrono>
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

struct ScopedValidationStage {
    std::filesystem::path root;
    ~ScopedValidationStage()
    {
        if (!root.empty()) {
            std::error_code ignored;
            std::filesystem::remove_all(root, ignored);
        }
    }
};

std::optional<std::string> validate_structural_transaction(const ProjectSession& source,
                                                           const std::filesystem::path& root,
                                                           const PreparedYamlTransaction& prepared)
{
    // A source-accurate multi-owner patch can still invalidate an unmodified
    // dependent owner. Verify the *resulting disk Project* before publishing
    // any transaction target, never just the edited YAML syntax.
    ScopedValidationStage stage;
    const auto prefix = "nt501-native-mutation-" +
                        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    for (unsigned int attempt = 0; attempt < 100; ++attempt) {
        const auto candidate =
            std::filesystem::temp_directory_path() / (prefix + "-" + std::to_string(attempt));
        if (std::filesystem::create_directory(candidate)) {
            stage.root = candidate;
            break;
        }
    }
    if (stage.root.empty())
        return "Cannot allocate native dependency-validation staging directory.";
    for (const auto& file : source.file_inventory()) {
        if (file.kind == ProjectFileKind::IgnoredState ||
            file.kind == ProjectFileKind::UntrackedFile)
            continue;
        const auto origin = root / file.path;
        if (std::filesystem::is_symlink(origin) || !std::filesystem::is_regular_file(origin))
            return "Native mutation cannot stage an unverified Project source: " + file.path;
        const auto destination = stage.root / file.path;
        std::filesystem::create_directories(destination.parent_path());
        std::error_code linked;
        std::filesystem::create_hard_link(origin, destination, linked);
        if (linked)
            std::filesystem::copy_file(origin, destination);
    }
    for (const auto& target : prepared.targets) {
        const auto path = stage.root / target.path;
        std::filesystem::remove(path); // Never modify a hard-linked original in place.
        if (target.erase)
            continue;
        std::filesystem::create_directories(path.parent_path());
        std::ofstream out(path, std::ios::binary | std::ios::trunc);
        if (!out || !out.write(target.after_source.data(),
                               static_cast<std::streamsize>(target.after_source.size())))
            return "Cannot prepare native dependent-source validation target: " + target.path;
    }
    std::string error;
    auto projected = ProjectSession::open(stage.root, error);
    if (!projected)
        return "Structural transaction would invalidate Project admission: " + error;
    const auto proof = projected->validate_project();
    if (!proof.valid)
        return "Structural transaction would invalidate dependent Project sources.";
    return std::nullopt;
}

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

std::size_t utf16_byte_offset(std::string_view source, std::size_t offset)
{
    std::size_t units = 0, byte = 0;
    while (byte < source.size() && units < offset) {
        const auto lead = static_cast<unsigned char>(source[byte]);
        const auto width = lead < 0x80 ? 1u : lead < 0xe0 ? 2u : lead < 0xf0 ? 3u : 4u;
        units += width == 4 ? 2 : 1;
        byte += width;
    }
    if (units != offset)
        throw std::runtime_error("Invalid native UTF-16 source range.");
    return byte;
}

std::string recognized_lua_collection(std::string_view text, const LuaLiteralOccurrence& literal,
                                      std::string_view owner)
{
    const auto prefix = std::string(text.substr(0, utf16_byte_offset(text, literal.start_utf16)));
    std::smatch found;
    if (std::regex_search(
            prefix, found,
            std::regex(R"(noveltea\.project\.(room|character|interactable)\s*\(\s*$)")))
        return found[1].str() + "s";
    if (owner.starts_with("scripts/") &&
        (std::regex_search(prefix, std::regex(R"((?:^|[^\w.])import\s*\(\s*$)")) ||
         std::regex_search(
             prefix,
             std::regex(
                 R"((?:^|[^\w.])hooks\s*\.\s*register\s*\(\s*(['"])room\1\s*,\s*(['"])[^'"\r\n]*\2\s*,\s*(['"])[^'"\r\n]*\3\s*,\s*$)"))))
        return "scripts";
    return {};
}

std::vector<LuaLiteralOccurrence> lua_reference_literals(std::string_view source,
                                                         bool embedded_rml = false)
{
    auto analyzed = analyze_project_text(
        embedded_rml ? "__native_references.rml" : "__native_references.lua", source, true);
    if (!analyzed.complete)
        throw std::runtime_error("Native source reference analysis is incomplete.");
    std::erase_if(analyzed.lua_literals, [&](const auto& literal) {
        return std::any_of(analyzed.messages.begin(), analyzed.messages.end(),
                           [&](const auto& message) {
                               return literal.start_utf16 >= message.call_start_utf16 &&
                                      literal.end_utf16 <= message.call_end_utf16;
                           });
    });
    return analyzed.lua_literals;
}

std::string rewrite_lua_references(std::string text, const std::string& owner,
                                   const std::string& family, const std::string& id,
                                   const std::string& to_id, bool force, bool& possible,
                                   std::vector<std::string>& blockers)
{
    auto literals = lua_reference_literals(text);
    for (auto it = literals.rbegin(); it != literals.rend(); ++it) {
        if (it->value != id)
            continue;
        const auto recognized = recognized_lua_collection(text, *it, owner);
        if (recognized.empty()) {
            possible = true;
            continue;
        }
        if (recognized != family)
            continue;
        if (to_id.empty()) {
            if (!force)
                blockers.push_back("Exact source reference blocks deletion.");
            continue;
        }
        if (it->kind == "long-bracket") {
            blockers.push_back("Exact source reference requires a manual rewrite.");
            continue;
        }
        const auto start = utf16_byte_offset(text, it->start_utf16 + 1);
        const auto end = utf16_byte_offset(text, it->end_utf16 - 1);
        if (text.substr(start, end - start) != id) {
            blockers.push_back(
                "Recognized source rewrite range no longer matches the analyzed source.");
            continue;
        }
        text.replace(start, end - start, to_id);
    }
    return text;
}

void rewrite_inline_lua(const Json& value, const std::string& path, const std::string& owner,
                        const std::string& family, const std::string& id, const std::string& to_id,
                        bool force, bool& possible, std::vector<std::string>& blockers,
                        std::vector<YamlValueEdit>& edits)
{
    if (value.is_array()) {
        for (std::size_t i = 0; i < value.size(); ++i)
            rewrite_inline_lua(value[i], path + "/" + std::to_string(i), owner, family, id, to_id,
                               force, possible, blockers, edits);
        return;
    }
    if (!value.is_object())
        return;
    const auto kind = value.value("kind", Json{});
    if ((kind == "lua" || kind == "lua-predicate" || kind == "lua-expression" ||
         kind == "run-lua" || kind == "run-lua-effect" ||
         value.value("type", Json{}) == "run-lua") &&
        value.contains("source") && value.at("source").is_string()) {
        const auto text = value.at("source").get<std::string>();
        const auto rewritten =
            rewrite_lua_references(text, owner, family, id, to_id, force, possible, blockers);
        if (text != rewritten)
            edits.push_back({path + "/source", Json(rewritten).dump(), YamlCommentDisposition::Keep,
                             std::nullopt, YamlEditOperation::Replace});
    }
    for (const auto& [key, child] : value.items())
        rewrite_inline_lua(child, path + "/" + pointer_segment(key), owner, family, id, to_id,
                           force, possible, blockers, edits);
}

bool deletion_repair(std::string path, const std::string& owner_family,
                     std::vector<YamlValueEdit>& edits)
{
    const auto replace_null = [&] {
        edits.push_back(
            {path, "null", YamlCommentDisposition::Keep, std::nullopt, YamlEditOperation::Replace});
        return true;
    };
    if (path == "/archetype" || path.starts_with("/settings/ui/systemLayouts/") ||
        path == "/settings/inventory/defaultLayout")
        return replace_null();
    if (std::regex_match(
            path,
            std::regex(
                R"(^/data/(background/(asset|material)|props/[0-9]+/(asset|material)|environments/[0-9]+/asset|placements/[0-9]+/presentation/layout)$)")))
        return replace_null();
    if (path == "/data/compose/script") {
        path = "/data/compose";
        return replace_null();
    }
    if (owner_family == "materials" && path == "/data/base/material")
        return false;
    if (std::regex_match(
            path,
            std::regex(
                R"(^/data/(cast/[0-9]+/character|overlays/[0-9]+/layout|scriptHooks/[0-9]+/handler/module)$)"))) {
        const auto first = path.find('/', 6);
        const auto end = path.find('/', first + 1);
        path = path.substr(0, end);
    } else {
        // The graph's default deletion policy removes the nearest array item.
        // Required Room exits and environment Materials instead require replacements.
        if (std::regex_match(
                path, std::regex(R"(^/data/(exits/[0-9]+/target|environments/[0-9]+/material)$)")))
            return false;
        std::smatch found;
        if (!std::regex_match(path, found, std::regex(R"(^(.*\/[0-9]+)(?:\/.*)?$)")))
            return false;
        path = found[1].str();
    }
    edits.push_back(
        {path, "", YamlCommentDisposition::Keep, std::nullopt, YamlEditOperation::Remove});
    return true;
}

void reference_rewrites(const Json& value, std::string pointer, const std::string& family,
                        const std::string& owner_family, const std::string& from_id,
                        const std::string& to_id, std::vector<YamlValueEdit>& edits,
                        std::vector<std::string>& blockers, const Json* normalized = nullptr)
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
                else if (!deletion_repair(pointer, owner_family, edits))
                    blockers.push_back(pointer + "/$ref");
                return;
            }
        }
        if (value.contains("$var") && family == "variables" && value.at("$var") == from_id) {
            if (!to_id.empty())
                edits.push_back({pointer + "/$var", Json(to_id).dump(),
                                 YamlCommentDisposition::Keep, std::nullopt,
                                 YamlEditOperation::Replace});
            else if (!deletion_repair(pointer, owner_family, edits))
                blockers.push_back(pointer + "/$var");
            return;
        }
        const auto kind = value.value("kind", Json{});
        const bool flow = (pointer == "/entrypoint" || pointer.ends_with("/completion") ||
                           pointer.ends_with("/continuation")) &&
                          kind.is_string() && kind.get<std::string>() + "s" == family;
        const bool explicit_dependency =
            kind == "record" && value.value("collection", Json{}) == family;
        if ((flow || explicit_dependency) && value.value("id", Json{}) == from_id) {
            if (!to_id.empty())
                edits.push_back({pointer + "/id", Json(to_id).dump(), YamlCommentDisposition::Keep,
                                 std::nullopt, YamlEditOperation::Replace});
            else if (!deletion_repair(pointer, owner_family, edits))
                blockers.push_back(pointer + "/$ref");
        }
        for (const auto& [key, child] : value.items())
            reference_rewrites(child, pointer + "/" + pointer_segment(key), family, owner_family,
                               from_id, to_id, edits, blockers, normalized);
    } else if (value.is_array()) {
        for (std::size_t remaining = value.size(); remaining > 0; --remaining) {
            const auto index = to_id.empty() ? remaining - 1 : value.size() - remaining;
            reference_rewrites(value.at(index), pointer + "/" + std::to_string(index), family,
                               owner_family, from_id, to_id, edits, blockers, normalized);
        }
    } else if (value.is_string() && value.get<std::string>().find(from_id) != std::string::npos) {
        // Sparse source references are scalar IDs rather than `$ref` mappings.
        // These declared structural paths are exact references, never lexical
        // uncertainty that --allow-possible-source-references may override.
        struct Rule {
            std::string_view owner;
            std::string_view target;
            std::regex path;
        };
        static const std::vector<Rule> scalar_references{
            {"rooms", "rooms", std::regex(R"(^/data/exits/[0-9]+/target$)")},
            {"tests", "rooms",
             std::regex(R"(^/data/steps/[0-9]+/expectations/[0-9]+/currentRoom/roomId$)")},
            {"rooms", "characters", std::regex(R"(^/data/cast/[0-9]+/character$)")},
            {"rooms", "layouts",
             std::regex(
                 R"(^/data/(overlays/[0-9]+/layout|placements/[0-9]+/presentation/layout)$)")},
            {"rooms", "materials",
             std::regex(
                 R"(^/data/(background/material|props/[0-9]+/(material|materialApplication/material)|environments/[0-9]+/(material|materialApplication/material))$)")},
            {"rooms", "assets",
             std::regex(
                 R"(^/data/(background/asset|props/[0-9]+/asset|environments/[0-9]+/asset)$)")},
            {"rooms", "scripts",
             std::regex(R"(^/data/(compose/script|scriptHooks/[0-9]+/handler/module)$)")},
            {"interactables", "materials", std::regex(R"(^/data/presentation/material$)")},
            {"interactables", "assets", std::regex(R"(^/data/presentation/visual/image$)")},
            {"interactables", "animations", std::regex(R"(^/data/presentation/visual/animation$)")},
            {"materials", "assets", std::regex(R"(^/data/textures/[^/]+/source$)")},
            {"layouts", "assets", std::regex(R"(^/data/(rml|rcss)/sourceAsset$)")},
            {"layouts", "materials", std::regex(R"(^/data/dependencies/materials/[0-9]+$)")},
        };
        bool normalized_reference = false;
        if (normalized) {
            const auto path = Json::json_pointer(pointer);
            if (normalized->contains(path)) {
                const auto& node = normalized->at(path);
                normalized_reference = node.is_object() && node.contains("$ref") &&
                                       node.at("$ref").is_object() &&
                                       node.at("$ref").value("collection", Json{}) == family &&
                                       node.at("$ref").value("id", Json{}) == from_id;
            }
        }
        const bool exact =
            normalized_reference ||
            std::any_of(scalar_references.begin(), scalar_references.end(), [&](const Rule& rule) {
                return rule.owner == owner_family && rule.target == family &&
                       std::regex_match(pointer, rule.path);
            });
        if (exact && value == from_id) {
            if (!to_id.empty())
                edits.push_back({pointer, Json(to_id).dump(), YamlCommentDisposition::Keep,
                                 std::nullopt, YamlEditOperation::Replace});
            else if (!deletion_repair(pointer, owner_family, edits))
                blockers.push_back(pointer + "/$ref");
        }
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
    const bool force = !rename && request.value("force", false);
    const bool allow_possible = request.value("allowPossibleSourceReferences", false);
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

    const auto usage_result = native_project_entity_usages(request, session, root);
    if (!usage_result.value("ok", false))
        return usage_result;
    const auto normalized_records = session.validated_disk_record_snapshots();
    std::vector<YamlTransactionTarget> reference_targets;
    std::vector<std::string> blockers;
    std::set<std::string> possible_sources;
    Json rewritten = Json::array();
    const auto classify_uncertain = [&](const std::string& source,
                                        const std::vector<std::string>& uncertain) {
        static const std::set<std::string> textual_fields{
            "label",   "displayName",    "text",      "source", "sourceText", "description",
            "context", "translatorNote", "usageNote", "title",  "notes"};
        for (const auto& path : uncertain) {
            if (path.ends_with("/$ref") || path.ends_with("/$var")) {
                // TS authoring --force explicitly opts out of incoming typed
                // reference repairs when deleting an owner. Preserve this
                // established CLI mode; ordinary deletion still requires a
                // safe repair plan for each exact reference.
                if (!force)
                    blockers.push_back(source + path);
                continue;
            }
            const auto tail_at = path.find_last_of('/');
            const auto tail = path.substr(tail_at == std::string::npos ? 0 : tail_at + 1);
            if (textual_fields.contains(tail))
                possible_sources.insert(source);
            else
                blockers.push_back(source + path);
        }
    };
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
            std::string physical_owner;
            for (const auto& [owner, snapshot] : normalized_records) {
                if (!owner.starts_with("scripts/"))
                    continue;
                const auto record = Json::parse(snapshot.normalized_json);
                const auto& selector = record.at("data").at("source");
                if (selector.value("path", Json{}) == file.path) {
                    physical_owner = owner;
                    break;
                }
            }
            if (file.path.starts_with("records/layouts/")) {
                constexpr auto prefix = sizeof("records/layouts/") - 1;
                const auto id_end = file.path.find('/', prefix);
                physical_owner = "layouts/" + file.path.substr(prefix, id_end - prefix);
            }
            if (physical_owner.empty() || !file.path.ends_with(".lua"))
                continue;
            bool possible = false;
            const auto next =
                rewrite_lua_references(text, physical_owner, family, id,
                                       rename ? to_id : std::string{}, force, possible, blockers);
            if (possible)
                possible_sources.insert(file.path);
            if (next != text) {
                reference_targets.push_back({.path = file.path,
                                             .expected_revision = exact_source_revision(text),
                                             .baseline_source = text,
                                             .edits = {},
                                             .create_source = std::nullopt,
                                             .raw_text_source = next});
                rewritten.push_back(file.path);
            }
            continue;
        }
        const auto opened = open_yaml_source(text);
        if (!opened.accepted)
            return failure("Native entity reference source is invalid: " + file.path);
        auto value = Json::parse(opened.source_json);
        std::vector<YamlValueEdit> edits;
        if (file.path == "i18n/messages.yaml")
            // Dedicated structured-Message remapping below owns these
            // semantic-path mapping keys. They are not external references.
            value.erase("structuredMessageIds");
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
        std::vector<std::string> uncertain;
        const auto owner_family = file.path.starts_with("records/")
                                      ? file.path.substr(8, file.path.find('/', 8) - 8)
                                      : std::string{};
        Json normalized = value;
        if (!owner_family.empty()) {
            const auto rest = file.path.substr(8 + owner_family.size() + 1);
            const auto owner_id = owner_family == "layouts" ? rest.substr(0, rest.find('/'))
                                                            : rest.substr(0, rest.size() - 5);
            const auto found = normalized_records.find(owner_family + "/" + owner_id);
            if (found != normalized_records.end())
                normalized = Json::parse(found->second.normalized_json);
        } else if (file.path == "project.yaml") {
            normalized = Json::parse(session.snapshot().normalized_json);
        } else if (file.path == "i18n/project.yaml") {
            const auto admitted =
                validate_record("WorkspaceLocalizationPolicy", opened.source_json);
            if (admitted.accepted)
                normalized = Json::parse(admitted.effective_json);
        }
        if (!force)
            reference_rewrites(value, "", family, owner_family, id, rename ? to_id : std::string{},
                               edits, uncertain, &normalized);
        classify_uncertain(file.path, uncertain);
        bool possible = false;
        rewrite_inline_lua(
            value, "", owner_family + "/" + std::filesystem::path(file.path).stem().string(),
            family, id, rename ? to_id : std::string{}, force, possible, blockers, edits);
        if (possible)
            possible_sources.insert(file.path);
        if (edits.empty())
            continue;
        std::vector<YamlValueEdit> unique;
        for (const auto& edit : edits) {
            const bool removed_parent =
                std::any_of(edits.begin(), edits.end(), [&](const auto& other) {
                    return other.operation == YamlEditOperation::Remove &&
                           edit.path.starts_with(other.path + "/");
                });
            if (!removed_parent &&
                std::none_of(unique.begin(), unique.end(), [&](const auto& other) {
                    return edit.path == other.path && edit.operation == other.operation;
                }))
                unique.push_back(edit);
        }
        edits = std::move(unique);
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
        std::vector<std::string> own_uncertain;
        const auto own_normalized =
            Json::parse(normalized_records.at(family + "/" + id).normalized_json);
        reference_rewrites(own_record, "", family, family, id, to_id, edits, own_uncertain,
                           &own_normalized);
        classify_uncertain(from_path, own_uncertain);
        bool possible = false;
        rewrite_inline_lua(own_record, "", family + "/" + id, family, id, to_id, false, possible,
                           blockers, edits);
        if (possible)
            possible_sources.insert(from_path);
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
    if (!possible_sources.empty() && !allow_possible && !force)
        return failure("Possible source reference requires "
                       "--allow-possible-source-references: " +
                       *possible_sources.begin());
    Json result{{"ok", true},        {"collection", family},       {"id", id},
                {"dryRun", dry_run}, {"sourceRevision", revision}, {"writes", Json::array()}};
    result["usages"] = usage_result.at("usages");
    if (rename)
        result["toId"] = to_id;
    result["rewrittenSources"] = rewritten;
    result["possibleSourceReferences"] = Json::array();
    for (const auto& source_path : possible_sources)
        result["possibleSourceReferences"].push_back(source_path);

    std::set<std::string> reference_repairs;
    if (rename) {
        reference_repairs.insert("/" + family + "/" + id);
        reference_repairs.insert("/" + family + "/" + to_id);
    }
    for (const auto& target : reference_targets) {
        if (!target.path.starts_with("records/"))
            continue;
        const auto rest = target.path.substr(sizeof("records/") - 1);
        const auto split = rest.find('/');
        if (split == std::string::npos)
            continue;
        const auto collection = rest.substr(0, split);
        const auto suffix = rest.substr(split + 1);
        const auto record_id = collection == "layouts" ? suffix.substr(0, suffix.find('/'))
                                                       : suffix.substr(0, suffix.rfind('.'));
        for (const auto& edit : target.edits)
            reference_repairs.insert("/" + collection + "/" + record_id + edit.path);
    }
    std::vector<YamlTransactionTarget> targets;
    targets.insert(targets.end(), reference_targets.begin(), reference_targets.end());
    // Structured Messages normally derive identity from semantic paths.
    // A record rename changes those paths, so preserve *old* derived IDs
    // explicitly at the destination; otherwise translations silently lose
    // their owning Message despite successful record/schema validation.
    const auto semantic_sources = native_localization_record_structured_sources(root, family, id);
    const auto original_prefix = "/" + family + "/" + id + "/";
    const auto new_prefix = rename ? "/" + family + "/" + to_id + "/" : std::string{};
    const auto messages_path = std::string("i18n/messages.yaml");
    const auto messages_source = read_text(root / messages_path);
    const auto opened_messages = open_yaml_source(messages_source);
    if (!opened_messages.accepted)
        return failure("Cannot inspect structured Message identities before entity mutation.");
    const auto document = Json::parse(opened_messages.source_json);
    if (!document.contains("structuredMessageIds") ||
        !document.at("structuredMessageIds").is_object())
        return failure("Localization Message identity map is not a canonical mapping.");
    const auto& identities = document.at("structuredMessageIds");
    std::vector<YamlValueEdit> identity_edits;
    Json next_identities = identities;
    for (const auto& [path, _] : semantic_sources) {
        if (!rename || !path.starts_with(original_prefix))
            continue;
        const auto new_path = rename ? new_prefix + path.substr(original_prefix.size()) : "";
        const auto id_value = identities.contains(path)
                                  ? identities.at(path).get<std::string>()
                                  : native_localization_structured_message_id(path);
        if (!rename) {
            // Unlike a rename, deletion has no surviving semantic path to
            // carry a translated Message. Until native orphan preparation
            // owns that case, fail closed instead of discarding the history.
            const auto locales = root / "i18n/locales";
            const auto status = std::filesystem::symlink_status(locales).type();
            if (status != std::filesystem::file_type::directory &&
                status != std::filesystem::file_type::not_found)
                return failure("Localization chunk directory is not a contained directory.");
            if (status == std::filesystem::file_type::directory)
                for (const auto& locale_file : std::filesystem::directory_iterator(locales)) {
                    if (!locale_file.is_regular_file() || locale_file.path().extension() != ".yaml")
                        continue;
                    const auto locale = open_yaml_source(read_text(locale_file.path()));
                    if (!locale.accepted)
                        return failure(
                            "Cannot verify dependent translation before record deletion.");
                    if (Json::parse(locale.source_json).contains(id_value))
                        return failure("Deletion would orphan translated structured Message " +
                                       id_value + " without a native repair plan.");
                }
        }
        if (rename) {
            if (identities.contains(new_path))
                return failure("Destination already claims a structured Message identity: " +
                               new_path);
            // Report semantic repair paths, not the physical YAML writer's
            // flow-map replacement. A flow replacement may update many keys
            // even when only these derived Message identities changed.
            reference_repairs.insert("/localization/structuredMessageIds/" +
                                     pointer_segment(new_path));
            next_identities[new_path] = id_value;
            identity_edits.push_back({"/structuredMessageIds/" + pointer_segment(new_path),
                                      Json(id_value).dump(), YamlCommentDisposition::Keep,
                                      std::nullopt, YamlEditOperation::Add});
        }
        if (identities.contains(path)) {
            next_identities.erase(path);
            identity_edits.push_back({"/structuredMessageIds/" + pointer_segment(path), "",
                                      YamlCommentDisposition::Keep, std::nullopt,
                                      YamlEditOperation::Remove});
        }
    }
    // The canonical writer can encode this mapping as an inline flow object,
    // which does not support surgical peer insertion. Replace that mapping
    // exactly once, guarded by libfyaml's comment/subtree safety checks;
    // retain per-key patches for block mappings to preserve annotated peers.
    const bool flow_identities =
        std::regex_search(messages_source, std::regex(R"((^|\n)structuredMessageIds:[ \t]*\{)"));
    if (flow_identities) {
        identity_edits.clear();
        if (next_identities != identities)
            identity_edits.push_back({"/structuredMessageIds", next_identities.dump(),
                                      YamlCommentDisposition::Keep, std::nullopt,
                                      YamlEditOperation::Replace});
    }
    if (!identity_edits.empty())
        targets.push_back({.path = messages_path,
                           .expected_revision = exact_source_revision(messages_source),
                           .baseline_source = messages_source,
                           .edits = std::move(identity_edits),
                           .create_source = std::nullopt,
                           .erase = false});
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
            if (rename && std::string_view(channel) == "lua" && !allow_possible) {
                const auto literals = lua_reference_literals(current_source);
                if (std::any_of(literals.begin(), literals.end(),
                                [&](const auto& literal) { return literal.value == id; }))
                    return failure(
                        "Possible source reference requires --allow-possible-source-references: " +
                        current_path);
            }
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
    Json plan_writes = Json::array(), plan_deletes = Json::array();
    for (const auto& target : targets) {
        if (target.erase)
            plan_deletes.push_back(target.path);
        else
            plan_writes.push_back(target.path);
    }
    std::sort(plan_writes.begin(), plan_writes.end());
    std::sort(plan_deletes.begin(), plan_deletes.end());
    Json repairs = Json::array();
    for (const auto& repair : reference_repairs)
        repairs.push_back(repair);
    result["plan"] = {{"writes", plan_writes},
                      {"deletes", plan_deletes},
                      {"moves", Json::array()},
                      {"referenceRepairs", std::move(repairs)}};
    if (dry_run)
        return result;
    YamlTransactionService transaction(root);
    const auto prepared = transaction.prepare(targets, TransactionDecision::KeepComments);
    if (!prepared.accepted)
        return failure(prepared.error);
    if (!force) {
        const auto invalid = validate_structural_transaction(session, root, prepared);
        if (invalid)
            return failure(*invalid);
    }
    const auto committed = transaction.commit(prepared, TransactionDecision::KeepComments);
    if (!committed.accepted)
        return failure(committed.error);
    result["writes"] = committed.changed_paths;
    return result;
}

} // namespace

namespace {
// The CLI's dependency graph identifies record edges by their canonical
// semantic JSON pointer, rather than by the source YAML shorthand. This is
// also used by entity mutation certification to compare exact graph edges
// against the currently installed CLI before any authority is transferred.
std::string reference_role(std::string_view path)
{
    static const auto roles = [] {
        std::vector<std::pair<std::regex, std::string>> result;
        for (const auto& rule : Json::parse(structural_reference_rules_json()))
            result.emplace_back(std::regex(rule.at("pattern").get<std::string>()),
                                rule.at("role").get<std::string>());
        result.emplace_back(std::regex(R"(/materials/[^/]+/data/base/material/\$ref$)"),
                            "material-base");
        result.emplace_back(
            std::regex(
                R"(/(?:condition|guard|availability|visibility|canEnter|canLeave|waitCondition)(?:/(?:conditions/[0-9]+|condition))*/variable/\$ref$)"),
            "condition-variable");
        return result;
    }();
    for (const auto& [expression, role] : roles)
        if (std::regex_search(path.begin(), path.end(), expression))
            return role;
    return "explicit-ref";
}

void collect_lua_literal_usage(std::string_view source, const std::string& path,
                               const std::string& owner, const std::string& id,
                               const std::string& collection, Json& usages,
                               std::string_view source_url = "authoring:inline-lua",
                               bool embedded_rml = false)
{
    const auto literals = lua_reference_literals(source, embedded_rml);
    std::map<std::string, const LuaLiteralOccurrence*> selected;
    for (const auto& literal : literals) {
        if (literal.value != id)
            continue;
        const auto recognized = recognized_lua_collection(source, literal, owner);
        if (!recognized.empty() && recognized != collection)
            continue;
        const auto classification = recognized.empty()               ? "possible-lexical"
                                    : literal.kind == "long-bracket" ? "exact-manual"
                                                                     : "exact-rewriteable";
        auto& occurrence = selected[classification];
        if (!occurrence ||
            std::to_string(literal.start_utf16) < std::to_string(occurrence->start_utf16))
            occurrence = &literal;
    }
    const auto separator = owner.find('/');
    const auto source_key =
        owner.starts_with("@project:")
            ? Json::array({"project-field", owner.substr(9)}).dump()
            : Json::array({"record", owner.substr(0, separator), owner.substr(separator + 1)})
                  .dump();
    const auto target_key = Json::array({"record", collection, id}).dump();
    for (const auto& [classification, occurrence] : selected) {
        const auto role = classification == "possible-lexical" ? "lua-possible-reference"
                                                               : "lua-recognized-reference";
        usages.push_back({{"edgeId", Json::array({source_key, path, target_key, role}).dump()},
                          {"role", role},
                          {"sourcePath", std::string(source_url)},
                          {"sourceUrl", std::string(source_url)},
                          {"classification", classification},
                          {"location",
                           {{"line", occurrence->line},
                            {"column", occurrence->column},
                            {"endLine", occurrence->end_line},
                            {"endColumn", occurrence->end_column}}}});
    }
}

void collect_native_usages(const Json& record, const std::string& path, const std::string& owner,
                           const std::string& id, const std::string& collection, Json& usages)
{
    if (record.is_array()) {
        for (std::size_t n = 0; n < record.size(); ++n)
            collect_native_usages(record[n], path + "/" + std::to_string(n), owner, id, collection,
                                  usages);
        return;
    }
    if (record.is_string())
        return;
    if (!record.is_object())
        return;
    const auto kind = record.value("kind", Json{});
    if ((kind == "lua" || kind == "lua-predicate" || kind == "lua-expression" ||
         kind == "run-lua" || kind == "run-lua-effect" ||
         record.value("type", Json{}) == "run-lua") &&
        record.contains("source") && record.at("source").is_string())
        collect_lua_literal_usage(record.at("source").get<std::string>(), path + "/source", owner,
                                  id, collection, usages);
    if (path.ends_with("/data/lua") && record.contains("sourceText") &&
        record.at("sourceText").is_string())
        collect_lua_literal_usage(record.at("sourceText").get<std::string>(), path + "/sourceText",
                                  owner, id, collection, usages);
    if (owner.starts_with("layouts/") && path.ends_with("/data/rml") &&
        record.value("sourceMode", std::string{}) == "inline" && record.contains("sourceText") &&
        record.at("sourceText").is_string())
        collect_lua_literal_usage(record.at("sourceText").get<std::string>(), path + "/sourceText",
                                  owner, id, collection, usages,
                                  "project:/records/layouts/" +
                                      owner.substr(sizeof("layouts/") - 1) + "/layout.rml",
                                  true);
    const auto source_key_for = [&] {
        const auto split = owner.find('/');
        return owner.starts_with("@project:")
                   ? Json::array({"project-field", owner.substr(9)}).dump()
                   : Json::array({"record", owner.substr(0, split), owner.substr(split + 1)})
                         .dump();
    };
    const bool flow = (path.ends_with("/completion") || path.ends_with("/continuation") ||
                       path == "/entrypoint") &&
                      kind.is_string() && kind.get<std::string>() + "s" == collection;
    const bool explicit_dependency =
        kind == "record" && record.value("collection", Json{}) == collection;
    if ((flow || explicit_dependency) && record.value("id", Json{}) == id) {
        const auto role = path == "/entrypoint" ? "entrypoint"
                          : flow                ? "flow-target"
                                                : "lua-explicit-reference";
        usages.push_back(
            {{"edgeId", Json::array({source_key_for(), path,
                                     Json::array({"record", collection, id}).dump(), role})
                            .dump()},
             {"role", role},
             {"sourcePath", path}});
    }
    if (record.contains("$ref") && record.at("$ref").is_object()) {
        const auto& reference = record.at("$ref");
        if (reference.value("collection", std::string{}) == collection &&
            reference.value("id", std::string{}) == id) {
            const auto pointer = path + "/$ref";
            const auto role = reference_role(pointer);
            const auto source_key = source_key_for();
            const auto target_key = Json::array({"record", collection, id}).dump();
            usages.push_back(
                {{"edgeId", Json::array({source_key, pointer, target_key, role}).dump()},
                 {"role", role},
                 {"sourcePath", pointer}});
        }
        return;
    }
    if (record.contains("$var") && collection == "variables" && record.at("$var") == id) {
        const auto pointer = path + "/$var";
        const auto source_key = source_key_for();
        const auto target_key = Json::array({"record", collection, id}).dump();
        usages.push_back(
            {{"edgeId", Json::array({source_key, pointer, target_key, "variable-ref"}).dump()},
             {"role", "variable-ref"},
             {"sourcePath", pointer}});
        return;
    }
    for (const auto& [key, child] : record.items())
        collect_native_usages(child, path + "/" + pointer_segment(key), owner, id, collection,
                              usages);
}
} // namespace

Json native_project_entity_usages(const Json& request, ProjectSession& session,
                                  const std::filesystem::path& root)
{
    if (!request.contains("collection") || !request.at("collection").is_string() ||
        !request.contains("id") || !request.at("id").is_string())
        return failure("Native usages requires a collection and ID.");
    const auto collection = request.at("collection").get<std::string>();
    const auto id = request.at("id").get<std::string>();
    if (collection != "assets" && !default_entity_source_json(collection))
        return failure("Native usages collection is not registered.");
    session.validate_project();
    // Semantic diagnostics elsewhere in the Project do not invalidate an
    // otherwise complete reference inventory. Physical authority and every
    // record's normalized structure are still required for a negative result.
    if (!session.verified_source_revisions())
        return failure("Native usages cannot certify physical Project sources.");
    const auto records = session.reconciliation_disk_record_snapshots();
    for (const auto& file : session.file_inventory()) {
        if (file.kind != ProjectFileKind::TrackedSource || !file.path.starts_with("records/") ||
            !file.path.ends_with(".yaml"))
            continue;
        const auto name = file.path.substr(sizeof("records/") - 1);
        const auto slash = name.find('/');
        if (slash == std::string::npos || !default_entity_source_json(name.substr(0, slash)))
            continue;
        const auto family = name.substr(0, slash);
        const auto filename = name.substr(slash + 1);
        const auto owner = family == "layouts" && filename.ends_with("/layout.yaml")
                               ? family + "/" + filename.substr(0, filename.size() - 12)
                               : family + "/" + filename.substr(0, filename.size() - 5);
        if (!records.contains(owner))
            return failure("Native usages cannot inspect an unadmitted record dependency.");
    }
    if (!records.contains(collection + "/" + id))
        return failure("Entity record does not exist.");
    Json usages = Json::array();
    for (const auto& [owner, snapshot] : records) {
        if (snapshot.normalized_json.empty())
            return failure("Native usages cannot inspect an invalid record dependency.");
        const auto record = Json::parse(snapshot.normalized_json);
        if (record.contains("data"))
            collect_native_usages(record.at("data"), "/" + owner + "/data", owner, id, collection,
                                  usages);
        if (record.contains("archetype"))
            collect_native_usages(record.at("archetype"), "/" + owner + "/archetype", owner, id,
                                  collection, usages);
        if (owner.starts_with("rooms/") && collection == "assets" && record.contains("data") &&
            record.at("data").is_object()) {
            const auto& data = record.at("data");
            if (data.contains("background") && data.at("background").is_object() &&
                data.at("background").contains("asset") &&
                data.at("background").at("asset").is_object() &&
                data.at("background").at("asset").contains("$ref") &&
                data.at("background").at("asset").at("$ref").is_object() &&
                data.at("background").at("asset").at("$ref").value("id", std::string{}) == id &&
                data.contains("hotspots") && data.at("hotspots").is_array()) {
                const auto room_id = owner.substr(sizeof("rooms/") - 1);
                const auto target_key = Json::array({"record", collection, id}).dump();
                const auto pointer = "/" + owner + "/data/background/asset/$ref";
                for (const auto& hotspot : data.at("hotspots")) {
                    if (!hotspot.is_object() || !hotspot.contains("id") ||
                        !hotspot.at("id").is_string())
                        continue;
                    const auto source_key =
                        Json::array({"nested", "rooms", room_id, "room-hotspot", hotspot.at("id")})
                            .dump();
                    usages.push_back({{"edgeId", Json::array({source_key, pointer, target_key,
                                                              "hotspot-source-image"})
                                                     .dump()},
                                      {"role", "hotspot-source-image"},
                                      {"sourcePath", pointer}});
                }
            }
        }
        if (owner.starts_with("interactables/") &&
            (collection == "assets" || collection == "animations") && record.contains("data") &&
            record.at("data").is_object() && record.at("data").contains("presentation") &&
            record.at("data").at("presentation").is_object()) {
            const auto& presentation = record.at("data").at("presentation");
            if (presentation.contains("visual") && presentation.at("visual").is_object() &&
                presentation.contains("hotspots") && presentation.at("hotspots").is_object()) {
                const auto& visual = presentation.at("visual");
                const auto field =
                    visual.value("kind", std::string{}) == "animation" ? "animation" : "image";
                if ((std::string_view(field) == "animation" ? "animations" : "assets") ==
                        collection &&
                    visual.contains(field) && visual.at(field).is_object() &&
                    visual.at(field).contains("$ref") && visual.at(field).at("$ref").is_object() &&
                    visual.at(field).at("$ref").value("id", std::string{}) == id) {
                    const auto& definition = presentation.at("hotspots");
                    Json hotspots = Json::array();
                    if (definition.value("kind", std::string{}) == "visual-alpha" &&
                        definition.contains("hotspot") && definition.at("hotspot").is_object())
                        hotspots.push_back(definition.at("hotspot"));
                    else if (definition.value("kind", std::string{}) == "custom" &&
                             definition.contains("hotspots") &&
                             definition.at("hotspots").is_array())
                        hotspots = definition.at("hotspots");
                    const auto target_key = Json::array({"record", collection, id}).dump();
                    const auto pointer =
                        "/" + owner + "/data/presentation/visual/" + field + "/$ref";
                    for (const auto& hotspot : hotspots) {
                        if (!hotspot.is_object() || !hotspot.contains("id") ||
                            !hotspot.at("id").is_string())
                            continue;
                        const auto source_key =
                            Json::array({"nested", "interactables",
                                         owner.substr(sizeof("interactables/") - 1),
                                         "interactable-hotspot", hotspot.at("id")})
                                .dump();
                        usages.push_back({{"edgeId", Json::array({source_key, pointer, target_key,
                                                                  "hotspot-source-image"})
                                                         .dump()},
                                          {"role", "hotspot-source-image"},
                                          {"sourcePath", pointer}});
                    }
                }
            }
        }
        if (owner.starts_with("scripts/") && record.contains("data") &&
            record.at("data").is_object() && record.at("data").contains("source")) {
            const auto& source = record.at("data").at("source");
            if (!source.is_object() || source.value("kind", std::string{}) != "project-file")
                continue;
            const auto physical = source.value("path", std::string{});
            const auto candidate = std::filesystem::path(physical);
            if (!physical.starts_with("scripts/") || candidate.is_absolute() ||
                candidate != candidate.lexically_normal() ||
                !std::filesystem::is_regular_file(root / candidate))
                return failure("Native usages cannot certify the script's physical source.");
            const auto resolved = std::filesystem::canonical(root / candidate);
            const auto within = resolved.lexically_relative(root);
            if (within.empty() || within.is_absolute() ||
                (within.begin() != within.end() && *within.begin() == ".."))
                return failure("Native usages script source escapes the Project root.");
            collect_lua_literal_usage(read_text(root / candidate),
                                      "/" + owner + "/data/source/path", owner, id, collection,
                                      usages, "project:/" + physical);
        }
    }
    const auto manifest = Json::parse(session.snapshot().normalized_json);
    const auto project_field = [&](const std::string& path) {
        const auto pointer = Json::json_pointer(path);
        if (manifest.contains(pointer))
            collect_native_usages(manifest.at(pointer), path, "@project:" + path, id, collection,
                                  usages);
    };
    for (const auto* path :
         {"/bootstrapModule", "/entrypoint", "/undefinedInteractionProgram", "/prefetchHints",
          "/settings/display", "/settings/accessibility", "/settings/text/defaultFont",
          "/settings/text/fontStack", "/settings/cursors", "/settings/inventory/defaultLayout"})
        project_field(path);
    const auto systems = Json::json_pointer("/settings/ui/systemLayouts");
    if (manifest.contains(systems))
        for (const auto& [role, _] : manifest.at(systems).items())
            project_field("/settings/ui/systemLayouts/" + pointer_segment(role));
    if (manifest.contains("interactableInstances"))
        for (const auto& [instance, _] : manifest.at("interactableInstances").items())
            project_field("/interactableInstances/" + pointer_segment(instance));
    const auto localization = validate_project_localization(root);
    if (!localization.accepted && collection == "assets")
        return failure("Native usages cannot certify localization references.");
    if (localization.accepted) {
        const auto model = Json::parse(localization.effective_json);
        if (model.contains("locales"))
            for (const auto& [locale, definition] : model.at("locales").items())
                if (definition.contains("fontStack")) {
                    const auto path =
                        "/localization/locales/" + pointer_segment(locale) + "/fontStack";
                    collect_native_usages(definition.at("fontStack"), path, "@project:" + path, id,
                                          collection, usages);
                }
    }
    std::sort(usages.begin(), usages.end(), [](const Json& left, const Json& right) {
        return std::tie(left.at("sourcePath"), left.at("edgeId")) <
               std::tie(right.at("sourcePath"), right.at("edgeId"));
    });
    return {{"ok", true}, {"collection", collection}, {"id", id}, {"usages", usages}};
}

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
    Json planned = Json::array();
    for (const auto& target : targets)
        planned.push_back(target.path);
    std::sort(planned.begin(), planned.end());
    result["plan"] = {{"writes", std::move(planned)},
                      {"deletes", Json::array()},
                      {"moves", Json::array()},
                      {"referenceRepairs", Json::array({"/" + family + "/" + id})}};
    if (dry_run)
        return result;
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
