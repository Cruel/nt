#include "catalog.hpp"
#include "catalog_internal.hpp"
#include "generated/contract.hpp"
#include "../project_authoring/contracts.hpp"
#include <noveltea/core/fingerprint.hpp>

#include <libfyaml.h>
#include <algorithm>
#include <fstream>
#include <memory>
#include <regex>
#include <set>
#include <stdexcept>

namespace noveltea::narrative {
namespace {
bool valid_utf8(std::string_view bytes)
{
    for (std::size_t i = 0; i < bytes.size();) {
        const auto lead = static_cast<unsigned char>(bytes[i++]);
        if (lead < 0x80)
            continue;
        const unsigned width = lead >= 0xc2 && lead <= 0xdf   ? 2
                               : lead >= 0xe0 && lead <= 0xef ? 3
                               : lead >= 0xf0 && lead <= 0xf4 ? 4
                                                              : 0;
        if (!width || bytes.size() - i < width - 1)
            return false;
        const auto second = static_cast<unsigned char>(bytes[i]);
        if ((lead == 0xe0 && second < 0xa0) || (lead == 0xed && second > 0x9f) ||
            (lead == 0xf0 && second < 0x90) || (lead == 0xf4 && second > 0x8f))
            return false;
        for (unsigned consumed = 1; consumed < width; ++consumed) {
            const auto continuation = static_cast<unsigned char>(bytes[i++]);
            if (continuation < 0x80 || continuation > 0xbf)
                return false;
        }
    }
    return true;
}
std::string token(std::string value)
{
    std::string result;
    for (char c : value)
        result += c == '~' ? "~0" : c == '/' ? "~1" : std::string(1, c);
    return result;
}
std::string text(fy_node* node)
{
    std::size_t size = 0;
    const char* data = fy_node_get_scalar(node, &size);
    return data ? std::string(data, size) : std::string{};
}
Location location(fy_node* node)
{
    const auto* mark = fy_token_start_mark(fy_node_get_start_token(node));
    const auto style = fy_node_get_style(node);
    const bool quoted = style == FYNS_SINGLE_QUOTED || style == FYNS_DOUBLE_QUOTED;
    return mark ? Location{mark->line + 2, mark->column + (quoted ? 0 : 1)} : Location{};
}
struct YamlError : std::runtime_error {
    Location at;
    YamlError(std::string message, Location position) : std::runtime_error(message), at(position) {}
};
Json yaml_value(fy_node* node, Record& record, const std::string& pointer, unsigned depth = 0)
{
    if (!node)
        return nullptr;
    const auto at = location(node);
    record.locations[pointer] = at;
    if (depth > 128)
        throw YamlError("YAML nesting exceeds the 128-level safety limit.", at);
    if (fy_node_is_alias(node))
        throw YamlError("YAML aliases are unsupported; write explicit metadata values.", at);
    std::string tag;
    if (auto* tagged = fy_node_get_tag_token(node)) {
        const char* raw = fy_token_get_text0(tagged);
        tag = raw ? raw : "";
        if (tag.starts_with("tag:yaml.org,2002:"))
            tag = "!!" + tag.substr(18);
        if (tag != "!!str" && tag != "!!bool" && tag != "!!null" && tag != "!!int" &&
            tag != "!!float" && tag != "!!map" && tag != "!!seq")
            throw YamlError("Unsupported YAML tag: " + tag, at);
    }
    if (fy_node_is_mapping(node)) {
        if (!tag.empty() && tag != "!!map")
            throw YamlError("YAML tag does not match mapping.", at);
        Json result = Json::object();
        void* cursor = nullptr;
        while (auto* pair = fy_node_mapping_iterate(node, &cursor)) {
            auto* key = fy_node_pair_key(pair);
            if (!fy_node_is_scalar(key) || fy_node_is_alias(key))
                throw YamlError("Metadata mapping keys must be scalar names.", location(key));
            const auto name = text(key);
            static_cast<void>(yaml_value(key, record, pointer + "/" + token(name), depth + 1));
            if (result.contains(name))
                throw YamlError("Duplicate YAML mapping key: " + name, location(key));
            result[name] = yaml_value(fy_node_pair_value(pair), record, pointer + "/" + token(name),
                                      depth + 1);
        }
        return result;
    }
    if (fy_node_is_sequence(node)) {
        if (!tag.empty() && tag != "!!seq")
            throw YamlError("YAML tag does not match sequence.", at);
        Json result = Json::array();
        void* cursor = nullptr;
        while (auto* child = fy_node_sequence_iterate(node, &cursor))
            result.push_back(yaml_value(child, record,
                                        pointer + "/" + std::to_string(result.size()), depth + 1));
        return result;
    }
    const auto value = text(node);
    if (tag == "!!str" || (tag.empty() && fy_node_get_style(node) != FYNS_PLAIN))
        return value;
    if (tag.empty() || tag == "!!bool") {
        if (value == "true" || value == "True" || value == "TRUE")
            return true;
        if (value == "false" || value == "False" || value == "FALSE")
            return false;
    }
    if ((tag.empty() || tag == "!!null") &&
        (value.empty() || value == "~" || value == "null" || value == "Null" || value == "NULL"))
        return nullptr;
    static const std::regex number(
        R"(^[-+]?(?:[0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9]+(?:[eE][-+]?[0-9]+)?|0o[0-7]+|0x[0-9a-fA-F]+)$)");
    if ((tag.empty() || tag == "!!int" || tag == "!!float") && std::regex_match(value, number)) {
        // The catalog has no numeric fields. Preserve numeric type rather than accidentally
        // admitting text.
        return 0;
    }
    static const std::regex special_number(R"(^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$)");
    if (tag.empty() && std::regex_match(value, special_number))
        return 0;
    if (!tag.empty())
        throw YamlError("Invalid value for explicit YAML tag " + tag, at);
    return value;
}
void parse_yaml(const std::string& source, Record& record)
{
    fy_parse_cfg config{};
    config.flags = static_cast<fy_parse_cfg_flags>(FYPCF_QUIET | FYPCF_DEFAULT_VERSION_1_2);
    std::unique_ptr<fy_parser, decltype(&fy_parser_destroy)> parser(fy_parser_create(&config),
                                                                    fy_parser_destroy);
    if (!parser)
        throw YamlError("Cannot create YAML parser.", {});
    auto* diagnostic = fy_parser_get_diag(parser.get());
    if (!diagnostic)
        throw YamlError("Cannot configure YAML diagnostics.", {});
    fy_diag_set_collect_errors(diagnostic, true);
    std::unique_ptr<fy_diag, decltype(&fy_diag_unref)> diag(diagnostic, fy_diag_unref);
    if (fy_parser_set_string(parser.get(), source.data(), source.size()))
        throw YamlError("Cannot read YAML input.", {});
    auto destroy = [&](fy_document* doc) { fy_parse_document_destroy(parser.get(), doc); };
    std::unique_ptr<fy_document, decltype(destroy)> document(fy_parse_load_document(parser.get()),
                                                             destroy);
    auto check_errors = [&] {
        void* cursor = nullptr;
        if (auto* error = fy_diag_errors_iterate(diag.get(), &cursor)) {
            const auto* mark = fy_token_start_mark(error->fyt);
            throw YamlError(error->msg ? error->msg : "Invalid YAML.",
                            mark ? Location{mark->line + 2, mark->column + 1} : Location{});
        }
        if (fy_parser_get_stream_error(parser.get()))
            throw YamlError("Invalid YAML stream.", {});
    };
    check_errors();
    if (!document) {
        record.metadata = nullptr;
        return;
    }
    std::unique_ptr<fy_document, decltype(destroy)> extra(fy_parse_load_document(parser.get()),
                                                          destroy);
    check_errors();
    if (extra)
        throw YamlError("Expected one YAML document.", {});
    record.metadata = yaml_value(fy_document_root(document.get()), record, "");
}

// This is an interpreter for the generated upstream schema, not an engine-owned record model.
bool admit(Json& value, const Json& schema, Catalog& catalog, const Record& record,
           const std::string& path, bool complete)
{
    auto error = [&](const std::string& message) {
        catalog.report(record, "schema", (path.empty() ? "metadata" : path) + ": " + message, path);
        return false;
    };
    if (schema.contains("oneOf")) {
        for (const auto& variant : schema["oneOf"]) {
            for (const auto& key : {"type", "kind"}) {
                if (value.is_object() && value.contains(key) && variant.contains("properties") &&
                    variant["properties"].contains(key) &&
                    variant["properties"][key].contains("const") &&
                    value[key] == variant["properties"][key]["const"])
                    return admit(value, variant, catalog, record, path, complete);
            }
        }
        return error("Use a declared type/kind discriminator.");
    }
    const auto type = schema.value("type", "");
    if ((type == "object" && !value.is_object()) || (type == "array" && !value.is_array()) ||
        (type == "string" && !value.is_string()) || (type == "boolean" && !value.is_boolean()))
        return error("Expected " + type + ".");
    bool valid = true;
    if (value.is_object()) {
        for (const auto& required : schema.value("required", Json::array()))
            if (!value.contains(required.get<std::string>())) {
                catalog.report(record, "schema", "Required field: " + required.get<std::string>(),
                               path + "/" + required.get<std::string>());
                valid = false;
            }
        for (auto it = value.begin(); it != value.end(); ++it) {
            const auto child = path + "/" + token(it.key());
            if (!schema["properties"].contains(it.key())) {
                catalog.report(record, "schema", "Unknown field " + child + "; remove it.", child);
                valid = false;
            } else {
                valid = admit(it.value(), schema["properties"][it.key()], catalog, record, child,
                              complete) &&
                        valid;
            }
        }
    } else if (value.is_array()) {
        if (value.size() < schema.value("minItems", std::size_t{0}) ||
            (schema.contains("maxItems") && value.size() > schema["maxItems"].get<std::size_t>()))
            valid = error("Array length is outside the declared bounds.");
        for (std::size_t i = 0; i < value.size(); ++i)
            valid = admit(value[i], schema["items"], catalog, record,
                          path + "/" + std::to_string(i), complete) &&
                    valid;
        if (complete && value.size() < schema.value("x-completeMinItems", std::size_t{0}))
            valid = error("Complete record requires additional entries.");
        if (schema.value("x-unique", false) || schema.contains("x-uniqueBy")) {
            std::set<std::string> seen;
            for (const auto& item : value) {
                const auto field = schema.value("x-uniqueBy", "");
                if (!field.empty() && (!item.is_object() || !item.contains(field)))
                    continue;
                const auto key = field.empty() ? item.dump() : item[field].dump();
                if (!seen.insert(key).second) {
                    valid = error("Values/IDs must be unique in this list.");
                    break;
                }
            }
        }
        if (schema.contains("x-excludedItems"))
            for (const auto& excluded : schema["x-excludedItems"])
                if (std::find(value.begin(), value.end(), excluded) != value.end())
                    valid = error("This list contains a reserved value: " + excluded.dump());
    } else if (value.is_string()) {
        auto string = value.get<std::string>();
        if (schema.value("x-trim", false)) {
            string = authoring::trim_ecmascript(string);
            value = string;
            if (string.empty())
                valid = error("Text must be nonempty.");
        }
        if (schema.contains("pattern") &&
            !std::regex_search(string, std::regex(schema["pattern"].get<std::string>())))
            valid =
                error("Expected an identifier matching " + schema["pattern"].get<std::string>());
    }
    if (schema.contains("x-implies") && value.is_object()) {
        const auto& rule = schema["x-implies"];
        const auto when = rule["when"]["field"].get<std::string>();
        const auto then = rule["then"]["field"].get<std::string>();
        if (value.contains(when) && value[when] == rule["when"]["value"] && value.contains(then) &&
            value[then] != rule["then"]["value"]) {
            catalog.report(record, "schema",
                           "Expected " + then + " = " + rule["then"]["value"].dump() + " when " +
                               when + " = " + rule["when"]["value"].dump(),
                           path + "/" + then);
            valid = false;
        }
    }
    if (schema.contains("const") && value != schema["const"])
        valid = error("Expected " + schema["const"].dump() + ".");
    if (schema.contains("enum") &&
        std::find(schema["enum"].begin(), schema["enum"].end(), value) == schema["enum"].end())
        valid = error("Expected one of " + schema["enum"].dump() + ".");
    return valid;
}
void references(const Json& value, const Json& schema, Catalog& catalog, const Record& record,
                const std::string& path)
{
    if (schema.contains("oneOf")) {
        for (const auto& variant : schema["oneOf"])
            for (const auto& key : {"type", "kind"})
                if (value.contains(key) && variant["properties"].contains(key) &&
                    value[key] == variant["properties"][key]["const"]) {
                    references(value, variant, catalog, record, path);
                    return;
                }
    } else if (value.is_object()) {
        for (auto it = value.begin(); it != value.end(); ++it)
            references(it.value(), schema["properties"][it.key()], catalog, record,
                       path + "/" + token(it.key()));
    } else if (value.is_array()) {
        for (std::size_t i = 0; i < value.size(); ++i)
            references(value[i], schema["items"], catalog, record, path + "/" + std::to_string(i));
    } else if (path != "/id" && schema.value("pattern", "").find("\\.") != std::string::npos) {
        catalog.references.push_back(
            catalog.located(record, path, {{"source", record.metadata["id"]}, {"target", value}}));
    }
}
} // namespace
Json Catalog::located(const Record& record, const std::string& pointer, Json value) const
{
    const auto found = record.locations.find(pointer);
    const auto at = found == record.locations.end() ? Location{} : found->second;
    value["path"] = record.path;
    value["pointer"] = pointer;
    value["line"] = at.line;
    value["column"] = at.column;
    return value;
}
void Catalog::report(const Record& record, const std::string& code, const std::string& message,
                     const std::string& pointer)
{
    diagnostics.push_back(
        located(record, pointer, {{"code", code}, {"severity", "error"}, {"message", message}}));
}
const Record* Catalog::find(const std::string& id) const
{
    const auto it = std::find_if(records.begin(), records.end(),
                                 [&](const Record& r) { return r.metadata["id"] == id; });
    return it == records.end() ? nullptr : &*it;
}
Catalog read_catalog(const std::filesystem::path& root,
                     const std::map<std::string, std::string>* sources)
{
    Catalog catalog;
    const auto contract = Json::parse(contract_source);
    const auto& schema = contract["record"];
    Record root_record{".", {}, {}, {}, {{"", {1, 1}}}};
    std::vector<std::filesystem::path> paths;
    bool root_readable = true;
    try {
        if (sources) {
            for (const auto& [path, content] : *sources) {
                static_cast<void>(content);
                paths.emplace_back(std::u8string(path.begin(), path.end()));
            }
        } else {
            for (const auto& entry : std::filesystem::recursive_directory_iterator(root))
                if (entry.symlink_status().type() == std::filesystem::file_type::regular &&
                    entry.path().extension() == ".md")
                    paths.push_back(entry.path().lexically_relative(root));
        }
        std::sort(paths.begin(), paths.end());
    } catch (const std::filesystem::filesystem_error& error) {
        root_readable = false;
        paths.clear();
        catalog.report(root_record, "io", "Cannot read catalog root: " + std::string(error.what()));
    }
    for (const auto& path : paths) {
        Record record;
        const auto utf8 = path.generic_u8string();
        record.path = std::string(utf8.begin(), utf8.end());
        std::string source;
        if (sources) {
            source = sources->at(record.path);
        } else {
            std::ifstream file(root / path, std::ios::binary);
            if (!file) {
                record.locations[""] = {1, 1};
                catalog.report(record, "io", "Cannot read record.");
                continue;
            }
            source.assign(std::istreambuf_iterator<char>(file), {});
            if (file.bad()) {
                record.locations[""] = {1, 1};
                catalog.report(record, "io", "Cannot read record bytes.");
                continue;
            }
        }
        if (!valid_utf8(source)) {
            record.locations[""] = {1, 1};
            catalog.report(record, "io", "Cannot read record as UTF-8 text.");
            continue;
        }
        record.source_revision = core::xxh3_128_revision(source);
        const std::size_t metadata_start = source.starts_with("---\r\n") ? 5
                                           : source.starts_with("---\n") ? 4
                                                                         : 0;
        std::size_t metadata_end = std::string::npos, body_start = 0;
        // Scan delimiter lines without recursive regex matching on unbounded author text.
        for (auto offset = metadata_start; metadata_start && offset < source.size();) {
            const auto newline = source.find('\n', offset);
            const auto end = newline == std::string::npos ? source.size() : newline;
            auto line = std::string_view(source).substr(offset, end - offset);
            if (!line.empty() && line.back() == '\r')
                line.remove_suffix(1);
            if (line.starts_with("---") &&
                line.substr(3).find_first_not_of(" \t") == std::string_view::npos) {
                metadata_end = offset;
                body_start = newline == std::string::npos ? source.size() : newline + 1;
                break;
            }
            if (newline == std::string::npos)
                break;
            offset = newline + 1;
        }
        if (metadata_end == std::string::npos) {
            record.locations[""] = {1, 1};
            catalog.report(record, "frontmatter",
                           "Start the file with YAML between --- delimiter lines.");
            continue;
        }
        try {
            parse_yaml(source.substr(metadata_start, metadata_end - metadata_start), record);
        } catch (const YamlError& error) {
            record.locations[""] = error.at;
            catalog.report(record, "yaml", error.what());
            continue;
        }
        const bool complete = !record.metadata.is_object() ||
                              record.metadata.value("completeness", Json()) != "partial";
        if (!admit(record.metadata, schema, catalog, record, "", complete))
            continue;
        references(record.metadata, schema, catalog, record, "");
        record.body = source.substr(body_start);
        if (authoring::trim_ecmascript(record.body).empty())
            catalog.report(record, "body", "Add readable narrative prose after the frontmatter.");
        catalog.records.push_back(std::move(record));
    }
    std::map<std::string, std::vector<const Record*>> identities;
    unsigned directions = 0;
    for (const auto& record : catalog.records) {
        const auto& m = record.metadata;
        auto& previous = identities[m["id"].get<std::string>()];
        if (!previous.empty())
            catalog.report(record, "duplicate-id",
                           m["id"].get<std::string>() + " already declared in " +
                               previous.front()->path + "; assign a unique ID.",
                           "/id");
        previous.push_back(&record);
        if (m["type"] == "creative-direction" && m["status"] != "superseded")
            ++directions;
    }
    if (root_readable && directions != 1)
        catalog.report(root_record, "creative-direction-count",
                       "Expected one non-superseded Creative Direction, found " +
                           std::to_string(directions));
    for (const auto& ref : catalog.references) {
        const auto target = ref["target"].get<std::string>();
        if (identities[target].size() != 1) {
            auto diagnostic = ref;
            diagnostic["code"] = "broken-reference";
            diagnostic["severity"] = "error";
            diagnostic["message"] = target + " resolves to " +
                                    std::to_string(identities[target].size()) +
                                    " records; use one existing typed ID.";
            catalog.diagnostics.push_back(std::move(diagnostic));
        }
    }
    return catalog;
}
Json validate(const std::filesystem::path& root, const std::string& base)
{
    auto catalog = read_catalog(root);
    const auto coverage = analyze(catalog);
    const auto contract = Json::parse(contract_source);
    Json records = Json::array();
    for (const auto& r : catalog.records)
        records.push_back({{"path", r.path}, {"metadata", r.metadata}, {"body", r.body}});
    Json authorization = {{"status", "not-assessed"},
                          {"reason", "Structural validation alone does not establish human "
                                     "authorization."}};
    Json protection = nullptr;
    if (!base.empty()) {
        try {
            protection = inspect_git_baseline(root, base, catalog);
            const bool approval_required = !protection.at("findings").empty();
            const bool complete = catalog.diagnostics.empty();
            protection["complete"] = complete;
            authorization = {{"status", !complete           ? "indeterminate"
                                        : approval_required ? "approval-required"
                                                            : "unchanged"},
                             {"verified", false},
                             {"reason", "Git metadata comparison detects changes but cannot "
                                        "verify human authorization."}};
        } catch (const std::exception& error) {
            catalog.diagnostics.push_back(
                {{"code", "baseline-invalid"},
                 {"severity", "error"},
                 {"path", "."},
                 {"pointer", ""},
                 {"line", 1},
                 {"column", 1},
                 {"message", std::string("Cannot verify Git baseline: ") + error.what()}});
            protection = {{"status", "unavailable"},
                          {"findings", Json::array()},
                          {"reason", "Baseline inspection failed closed."}};
        }
    }
    Json result = {{"contractRevision", contract["revision"]},
                   {"records", records},
                   {"diagnostics", catalog.diagnostics},
                   {"reverseReferences", catalog.references},
                   {"coverage", coverage},
                   {"authorization", authorization}};
    if (!base.empty())
        result["protection"] = protection;
    return result;
}
} // namespace noveltea::narrative
