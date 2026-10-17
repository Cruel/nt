#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>
#include <jsoncons_ext/jsonpointer/jsonpointer.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <regex>
#include <set>
#include <stdexcept>
#include <utility>

#include <libfyaml.h>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

struct SourceFailure : std::runtime_error {
    std::optional<std::size_t> offset;
    SourceFailure(std::string message, std::optional<std::size_t> at = std::nullopt)
        : std::runtime_error(std::move(message)), offset(at)
    {
    }
};

void validate_utf8(std::string_view bytes)
{
    for (std::size_t i = 0; i < bytes.size();) {
        const auto start = i;
        const auto lead = static_cast<unsigned char>(bytes[i++]);
        if (!lead)
            throw SourceFailure("NUL bytes are not permitted in YAML source.", start);
        if (lead < 0x80)
            continue;
        const int width = lead >= 0xc2 && lead <= 0xdf   ? 2
                          : lead >= 0xe0 && lead <= 0xef ? 3
                          : lead >= 0xf0 && lead <= 0xf4 ? 4
                                                         : 0;
        if (!width || start + static_cast<std::size_t>(width) > bytes.size())
            throw SourceFailure("Invalid UTF-8 in YAML source.", start);
        const auto second = static_cast<unsigned char>(bytes[i]);
        if (second < 0x80 || second > 0xbf || (lead == 0xe0 && second < 0xa0) ||
            (lead == 0xed && second > 0x9f) || (lead == 0xf0 && second < 0x90) ||
            (lead == 0xf4 && second > 0x8f))
            throw SourceFailure("Invalid UTF-8 in YAML source.", start);
        for (int consumed = 1; consumed < width; ++consumed) {
            const auto continuation = static_cast<unsigned char>(bytes[i++]);
            if (continuation < 0x80 || continuation > 0xbf)
                throw SourceFailure("Invalid UTF-8 in YAML source.", start);
        }
    }
}

std::string pointer_token(std::string_view value)
{
    std::string result;
    for (char c : value) {
        if (c == '~')
            result += "~0";
        else if (c == '/')
            result += "~1";
        else
            result += c;
    }
    return result;
}

std::vector<std::string> split_pointer(std::string_view pointer)
{
    if (pointer.empty())
        return {};
    if (pointer.front() != '/')
        throw SourceFailure("Expected an RFC 6901 source pointer.");
    std::vector<std::string> result;
    for (std::size_t i = 1; i <= pointer.size();) {
        const auto next = pointer.find('/', i);
        const auto end = next == std::string_view::npos ? pointer.size() : next;
        std::string part;
        for (std::size_t j = i; j < end; ++j) {
            if (pointer[j] != '~') {
                part += pointer[j];
            } else {
                if (++j == end || (pointer[j] != '0' && pointer[j] != '1'))
                    throw SourceFailure("Malformed RFC 6901 escape.");
                part += pointer[j] == '0' ? '~' : '/';
            }
        }
        result.push_back(std::move(part));
        if (end == pointer.size())
            break;
        i = end + 1;
    }
    return result;
}

std::optional<std::size_t> mark_offset(fy_token* token, bool end = false)
{
    const fy_mark* mark = end ? fy_token_end_mark(token) : fy_token_start_mark(token);
    if (!mark)
        return std::nullopt;
    return mark->input_pos;
}

std::size_t location(fy_node* node)
{
    return mark_offset(fy_node_get_start_token(node)).value_or(0);
}

class Parsed {
public:
    explicit Parsed(std::string_view text) : source(text)
    {
        validate_utf8(source);
        // libfyaml tokens/documents can reference the parser's input storage. Both the input
        // and parser outlive the document until all token marks/comments have been consumed.
        fy_parse_cfg cfg{};
        cfg.flags = static_cast<fy_parse_cfg_flags>(FYPCF_QUIET | FYPCF_PARSE_COMMENTS |
                                                    FYPCF_DEFAULT_VERSION_1_2);
        parser = fy_parser_create(&cfg);
        if (!parser)
            throw SourceFailure("Could not create YAML parser.");
        try {
            if (fy_parser_set_string(parser, source.data(), source.size()) != 0)
                throw SourceFailure("Could not read YAML input.");
            doc = fy_parse_load_document(parser);
            if (!doc || fy_parser_get_stream_error(parser))
                throw SourceFailure("Invalid YAML document.");
            if (auto* extra = fy_parse_load_document(parser)) {
                fy_parse_document_destroy(parser, extra);
                throw SourceFailure("Expected exactly one YAML document.");
            }
            if (fy_parser_get_stream_error(parser))
                throw SourceFailure("Invalid YAML stream.");
            // A 1.1 directive changes implicit type resolution and is never canonical.
            static const std::regex wrong_version(
                R"((^|\n)%YAML[ \t]+(?!1\.2(?:[ \t\r\n]|$))[^\r\n]*)");
            if (std::regex_search(source, wrong_version))
                throw SourceFailure("Only YAML 1.2 documents are supported.", 0);
            if (!fy_document_root(doc))
                throw SourceFailure("Expected a YAML document root.");
        } catch (...) {
            if (doc) {
                fy_parse_document_destroy(parser, doc);
                doc = nullptr;
            }
            fy_parser_destroy(parser);
            parser = nullptr;
            throw;
        }
    }

    ~Parsed()
    {
        if (doc)
            fy_parse_document_destroy(parser, doc);
        if (parser)
            fy_parser_destroy(parser);
    }
    Parsed(const Parsed&) = delete;
    Parsed& operator=(const Parsed&) = delete;

    fy_node* root() const { return fy_document_root(doc); }
    fy_document* document() const { return doc; }
    std::string source;

private:
    fy_parser* parser = nullptr;
    fy_document* doc = nullptr;
};

bool ambiguous(std::string_view s)
{
    std::string value(s);
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    static const std::set<std::string> words{"yes", "no",   "on",    "off",  "y",    "n",
                                             "~",   "true", "false", "null", ".inf", ".nan"};
    static const std::regex zeroes(R"(^[-+]?0[0-9]+$)");
    return words.contains(value) || std::regex_match(value, zeroes);
}

bool json_number(std::string_view s)
{
    static const std::regex number(R"(^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$)");
    return std::regex_match(s.begin(), s.end(), number);
}

bool has_comment(fy_node* node)
{
    return node && (fy_node_get_comment(node, fycp_top) || fy_node_get_comment(node, fycp_right) ||
                    fy_node_get_comment(node, fycp_bottom));
}

bool contains_comment(fy_node* node)
{
    if (!node)
        return false;
    if (has_comment(node))
        return true;
    if (fy_node_is_mapping(node)) {
        void* previous = nullptr;
        while (auto* pair = fy_node_mapping_iterate(node, &previous))
            if (contains_comment(fy_node_pair_key(pair)) ||
                contains_comment(fy_node_pair_value(pair)))
                return true;
    } else if (fy_node_is_sequence(node)) {
        void* previous = nullptr;
        while (auto* child = fy_node_sequence_iterate(node, &previous))
            if (contains_comment(child))
                return true;
    }
    return false;
}

void validate_node_tag(fy_node* node)
{
    if (fy_node_is_alias(node) || fy_node_get_anchor(node))
        throw SourceFailure("YAML aliases and anchors are not supported.", location(node));
    if (auto* tag = fy_node_get_tag_token(node)) {
        const auto* value = fy_token_get_text0(tag);
        if (!value || (std::string_view(value) != "!!str" &&
                       std::string_view(value) != "tag:yaml.org,2002:str"))
            throw SourceFailure("Explicit YAML tags are not supported.", location(node));
    }
}

Json visit(fy_node* node, std::string_view path, std::vector<YamlSourceLocation>& locations,
           std::size_t depth = 0)
{
    if (depth > 128)
        throw SourceFailure("YAML nesting exceeds the native authoring limit.");
    if (!node)
        return Json::null();
    validate_node_tag(node);
    auto* first = fy_node_get_start_token(node);
    auto* last = fy_node_get_end_token(node);
    auto* start = fy_token_start_mark(first);
    auto* finish = fy_token_end_mark(last);
    locations.push_back(
        {std::string(path), start ? start->input_pos : 0, finish ? finish->input_pos : 0,
         start ? static_cast<std::size_t>(start->line + 1) : 0,
         start ? static_cast<std::size_t>(start->column + 1) : 0, has_comment(node)});
    if (fy_node_is_mapping(node)) {
        Json result = Json::object();
        std::set<std::string> keys;
        void* previous = nullptr;
        while (auto* pair = fy_node_mapping_iterate(node, &previous)) {
            auto* key = fy_node_pair_key(pair);
            if (!key || !fy_node_is_scalar(key))
                throw SourceFailure("YAML mapping keys must be strings.", location(key));
            validate_node_tag(key);
            const auto style = fy_node_get_style(key);
            std::size_t length = 0;
            const auto* text = fy_node_get_scalar(key, &length);
            const std::string name(text ? text : "", text ? length : 0);
            if (style == FYNS_PLAIN && !fy_node_get_tag_token(key) &&
                (json_number(name) || ambiguous(name)))
                throw SourceFailure("Quote numeric or ambiguous YAML mapping keys.", location(key));
            if (name == "<<" || name == "__proto__")
                throw SourceFailure("YAML merge and prototype keys are not supported.",
                                    location(key));
            if (!keys.insert(name).second)
                throw SourceFailure("Duplicate YAML mapping key: " + name, location(key));
            auto child_path = std::string(path) + "/" + pointer_token(name);
            result.insert_or_assign(
                name, visit(fy_node_pair_value(pair), child_path, locations, depth + 1));
            // The editor's comment ownership includes comments attached to mapping keys.
            if (has_comment(key)) {
                for (auto& value : locations)
                    if (value.path == child_path) {
                        value.has_comment = true;
                        break;
                    }
            }
        }
        return result;
    }
    if (fy_node_is_sequence(node)) {
        Json result = Json::array();
        void* previous = nullptr;
        std::size_t index = 0;
        while (auto* child = fy_node_sequence_iterate(node, &previous))
            result.push_back(visit(child, std::string(path) + "/" + std::to_string(index++),
                                   locations, depth + 1));
        return result;
    }
    std::size_t length = 0;
    const auto* raw = fy_node_get_scalar(node, &length);
    const std::string value(raw ? raw : "", raw ? length : 0);
    // The restricted profile admits !!str. It overrides implicit typing even for
    // plain scalars (e.g. !!str 123, !!str false, and !!str null).
    if (fy_node_get_tag_token(node))
        return Json(value);
    if (fy_node_get_style(node) != FYNS_PLAIN)
        return Json(value);
    if (value == "true")
        return Json(true);
    if (value == "false")
        return Json(false);
    if (value == "null" || value.empty())
        return Json::null();
    if (ambiguous(value))
        throw SourceFailure("Ambiguous plain YAML scalar must be quoted: " + value, location(node));
    if (json_number(value)) {
        try {
            Json number = Json::parse(value);
            if (number.is_double() && !std::isfinite(number.as<double>()))
                throw SourceFailure("YAML numbers must be finite.", location(node));
            return number;
        } catch (const SourceFailure&) {
            throw;
        } catch (const std::exception&) {
            throw SourceFailure("Invalid YAML numeric scalar.", location(node));
        }
    }
    static const std::regex other_number(
        R"(^[-+]?(?:[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|0[xXoObB][0-9a-fA-F]+|\.[0-9]+)$)");
    if (std::regex_match(value, other_number))
        throw SourceFailure("YAML numeric scalar is not a JSON number: " + value, location(node));
    return Json(value);
}

fy_node* find_node(fy_node* root, const std::vector<std::string>& parts)
{
    auto* node = root;
    for (const auto& part : parts) {
        if (!node)
            return nullptr;
        if (fy_node_is_mapping(node)) {
            node = fy_node_mapping_lookup_by_string(node, part.data(), part.size());
        } else if (fy_node_is_sequence(node)) {
            if (part.empty() || (part.size() > 1 && part.front() == '0') ||
                !std::all_of(part.begin(), part.end(),
                             [](unsigned char c) { return std::isdigit(c); }))
                throw SourceFailure("Invalid YAML sequence index.");
            auto index = static_cast<std::size_t>(std::stoull(part));
            void* previous = nullptr;
            fy_node* found = nullptr;
            for (std::size_t i = 0; i <= index; ++i) {
                found = fy_node_sequence_iterate(node, &previous);
                if (!found)
                    break;
            }
            node = found;
        } else {
            return nullptr;
        }
    }
    return node;
}

std::size_t start_of_line(std::string_view source, std::size_t position)
{
    auto previous = source.rfind('\n', position == 0 ? 0 : position - 1);
    return previous == std::string_view::npos ? 0 : previous + 1;
}

std::size_t after_line(std::string_view source, std::size_t position)
{
    const auto end = source.find('\n', position);
    return end == std::string_view::npos ? source.size() : end + 1;
}

fy_node_pair* mapping_pair(fy_node* parent, const std::string& key)
{
    return parent && fy_node_is_mapping(parent)
               ? fy_node_mapping_lookup_pair_by_string(parent, key.data(), key.size())
               : nullptr;
}

bool has_physical_comment(std::string_view source, fy_node* node, fy_node* key)
{
    if (contains_comment(node) || has_comment(key))
        return true;
    if (!node)
        return false;
    const auto last = mark_offset(fy_node_get_end_token(node), true);
    if (last) {
        auto end = after_line(source, *last);
        auto hash = source.find('#', *last);
        if (hash != std::string_view::npos && hash < end &&
            std::all_of(source.begin() + static_cast<std::ptrdiff_t>(*last),
                        source.begin() + static_cast<std::ptrdiff_t>(hash),
                        [](char c) { return c == ' ' || c == '\t'; }))
            return true;
    }
    // Root-leading prose is document metadata. Never mistake it for the first field's note.
    if (!key)
        return false;
    const auto at = mark_offset(fy_node_get_start_token(key));
    if (!at)
        return false;
    auto line = start_of_line(source, *at);
    const auto indent = *at - line;
    while (line > 0) {
        const auto previous = start_of_line(source, line - 1);
        if (line == previous)
            break;
        const auto content = source.find_first_not_of(' ', previous);
        if (content != previous + indent || content >= line || source[content] != '#')
            break;
        // A header before the very first root-level key does not belong to the key.
        if (indent == 0 && previous == 0)
            return false;
        return true;
    }
    return false;
}

std::string emit_source_value(const Json& value, fy_node* old)
{
    if (!value.is_string())
        return value.to_string(); // JSON flow syntax is a strict YAML 1.2 subset.
    const std::string plain = value.as<std::string>();
    if (old && fy_node_get_style(old) == FYNS_PLAIN && !plain.empty() && !ambiguous(plain) &&
        !json_number(plain) &&
        plain.find_first_not_of(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-@") ==
            std::string::npos)
        return plain;
    return value.to_string(); // Quote YAML-like strings, retaining their exact JSON meaning.
}

// A contiguous comment block belongs to the following field only at the field's
// indentation. The leading comment block of the first root key is document metadata.
std::size_t annotation_start(std::string_view source, std::size_t start, bool remove_leading)
{
    auto line_start = start_of_line(source, start);
    if (!remove_leading)
        return line_start;
    const auto column = start - line_start;
    while (line_start > 0) {
        const auto last_end = line_start - 1;
        const auto prev = last_end ? source.rfind('\n', last_end - 1) : std::string::npos;
        const auto prev_start = prev == std::string::npos ? 0 : prev + 1;
        const auto content = source.find_first_not_of(" \t", prev_start);
        if (content == std::string_view::npos || content >= line_start ||
            content != prev_start + column || source[content] != '#')
            break;
        line_start = prev_start;
    }
    return line_start;
}

void erase_comments(std::string& source, std::size_t start, std::size_t end, bool remove_leading)
{
    auto line_end = source.find('\n', end);
    if (line_end == std::string::npos)
        line_end = source.size();
    auto hash = source.find('#', end);
    if (hash != std::string::npos && hash < line_end &&
        std::all_of(source.begin() + static_cast<std::ptrdiff_t>(end),
                    source.begin() + static_cast<std::ptrdiff_t>(hash),
                    [](char c) { return c == ' ' || c == '\t'; })) {
        source.erase(end, line_end - end);
    }
    const auto leading = annotation_start(source, start, remove_leading);
    source.erase(leading, start_of_line(source, start) - leading);
}

bool is_first_root_key(fy_node* root, fy_node* parent, fy_node* key)
{
    if (!key || root != parent || !fy_node_is_mapping(root))
        return false;
    void* previous = nullptr;
    auto* first = fy_node_mapping_iterate(root, &previous);
    return first && fy_node_pair_key(first) == key;
}

// Reject edits that change any other field, container type, or array length.
// This protects against valid YAML that accidentally reparses with different structure.
bool same_outside_path(const Json& before, const Json& after, const std::vector<std::string>& parts,
                       std::size_t depth = 0)
{
    if (depth == parts.size())
        return true;
    const auto& selected = parts[depth];
    if (before.is_object() && after.is_object()) {
        for (const auto& member : before.object_range()) {
            if (member.key() != selected &&
                (!after.contains(member.key()) || after.at(member.key()) != member.value()))
                return false;
        }
        for (const auto& member : after.object_range())
            if (member.key() != selected && !before.contains(member.key()))
                return false;
        if (depth + 1 == parts.size())
            return true;
        return before.contains(selected) && after.contains(selected) &&
               same_outside_path(before.at(selected), after.at(selected), parts, depth + 1);
    }
    if (before.is_array() && after.is_array() && before.size() == after.size()) {
        if (selected.empty() || (selected.size() > 1 && selected.front() == '0') ||
            !std::all_of(selected.begin(), selected.end(),
                         [](unsigned char c) { return std::isdigit(c); }))
            return false;
        const auto index = std::stoull(selected);
        if (index >= before.size())
            return false;
        for (std::size_t i = 0; i < before.size(); ++i)
            if (i != index && before.at(i) != after.at(i))
                return false;
        return depth + 1 == parts.size() ||
               same_outside_path(before.at(index), after.at(index), parts, depth + 1);
    }
    return false;
}

const Json* json_at_path(const Json& root, const std::vector<std::string>& parts)
{
    const Json* current = &root;
    for (const auto& part : parts) {
        if (current->is_object() && current->contains(part)) {
            current = &current->at(part);
        } else if (current->is_array() && !part.empty() &&
                   std::all_of(part.begin(), part.end(),
                               [](unsigned char c) { return std::isdigit(c); })) {
            const auto index = std::stoull(part);
            if (index >= current->size())
                return nullptr;
            current = &current->at(index);
        } else {
            return nullptr;
        }
    }
    return current;
}

std::string apply_one(std::string_view source, const YamlValueEdit& edit)
{
    Parsed parsed(source);
    std::vector<YamlSourceLocation> locations;
    auto before = visit(parsed.root(), "", locations);
    const auto parts = split_pointer(edit.path);
    if (parts.empty())
        throw SourceFailure("Replace a selected YAML field rather than the document root.");
    const std::vector<std::string> parent_path(parts.begin(), parts.end() - 1);
    auto* parent = find_node(parsed.root(), parent_path);
    auto* pair = mapping_pair(parent, parts.back());
    auto* key = pair ? fy_node_pair_key(pair) : nullptr;
    auto* node = find_node(parsed.root(), parts);
    const bool remove_leading = key && !is_first_root_key(parsed.root(), parent, key);
    const auto replacement =
        edit.operation == YamlEditOperation::Remove ? Json::null() : Json::parse(edit.value_json);
    const auto default_value = edit.omission_default_json
                                   ? std::optional<Json>(Json::parse(*edit.omission_default_json))
                                   : std::nullopt;
    if (!node) {
        if (edit.operation == YamlEditOperation::Remove ||
            edit.operation == YamlEditOperation::Replace)
            throw SourceFailure("YAML edit target does not exist: " + edit.path);
        // This is an explicit sparse omission, not an implicit JSON null.
        if (default_value && replacement == *default_value)
            return std::string(source);
        if (!parent || !fy_node_is_mapping(parent))
            throw SourceFailure("YAML edit path has no mapping owner: " + edit.path);
        if (fy_node_get_style(parent) == FYNS_FLOW)
            throw SourceFailure("Cannot insert a YAML flow mapping field without rewriting peers.");
        void* previous = nullptr;
        fy_node_pair* first = fy_node_mapping_iterate(parent, &previous);
        if (!first)
            throw SourceFailure("Insertion into an empty block mapping requires an explicit map.");
        fy_node_pair* last = first;
        while (auto* next = fy_node_mapping_iterate(parent, &previous))
            last = next;
        auto* last_value = fy_node_pair_value(last);
        auto end = mark_offset(fy_node_get_end_token(last_value), true);
        auto* first_key = fy_node_pair_key(first);
        auto first_at = mark_offset(fy_node_get_start_token(first_key));
        if (!end || !first_at || *end > source.size())
            throw SourceFailure("Cannot locate block mapping insertion boundary.");
        // Composite block end marks point to the following sibling's line,
        // whereas scalar end marks end within their own physical line.
        auto at =
            fy_node_is_scalar(last_value) ? after_line(source, *end) : start_of_line(source, *end);
        const auto indent = *first_at - start_of_line(source, *first_at);
        std::string added(indent, ' ');
        const auto& name = parts.back();
        if (name.find_first_not_of(
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.") !=
                std::string::npos ||
            name.empty() || ambiguous(name) || json_number(name))
            added += Json(name).to_string();
        else
            added += name;
        added += ": " + emit_source_value(replacement, nullptr) + "\n";
        std::string result(source);
        if (at == source.size() && !source.empty() && source.back() != '\n')
            added.insert(0, "\n");
        result.insert(at, added);
        return result;
    }
    if (edit.operation == YamlEditOperation::Add && parent && fy_node_is_sequence(parent))
        throw SourceFailure("YAML sequence insertion needs structural reconciliation.");
    Json previous = before;
    for (const auto& part : parts) {
        if (previous.is_object() && previous.contains(part)) {
            Json child = previous.at(part);
            previous = std::move(child);
        } else if (previous.is_array()) {
            Json child = previous.at(static_cast<std::size_t>(std::stoull(part)));
            previous = std::move(child);
        } else
            throw SourceFailure("YAML edit path has no source value.");
    }
    // A default-valued field still needs to pass through the omission branch.
    // Otherwise an Upsert(default, omission_default=default) silently does nothing.
    if (previous == replacement && edit.operation != YamlEditOperation::Remove &&
        !edit.omission_default_json)
        return std::string(source);
    const bool commented = has_physical_comment(source, node, key);
    if (edit.operation == YamlEditOperation::Remove) {
        if (!pair || !parent || fy_node_get_style(parent) == FYNS_FLOW)
            throw SourceFailure("Cannot safely remove a non-mapping YAML entry.");
        if (commented && edit.comments == YamlCommentDisposition::Keep)
            throw SourceFailure("Removing an annotated field requires Remove disposition.");
        const auto key_at = mark_offset(fy_node_get_start_token(key));
        const auto finish = mark_offset(fy_node_get_end_token(node), true);
        if (!key_at || !finish || start_of_line(source, *key_at) != start_of_line(source, *finish))
            throw SourceFailure("Removing a multi-line YAML mapping field is unsupported.");
        const auto leading = annotation_start(
            source, *key_at, edit.comments == YamlCommentDisposition::Remove && remove_leading);
        const auto line_start = start_of_line(source, *key_at);
        const auto prefix = source.substr(line_start, *key_at - line_start);
        const auto dash = prefix.find_first_not_of(" \t");
        const bool sequence_entry =
            dash != std::string_view::npos && prefix[dash] == '-' &&
            prefix.find_first_not_of(" \t", dash + 1) == std::string_view::npos;
        std::string result(source);
        if (sequence_entry) {
            if (leading != line_start)
                throw SourceFailure("Cannot remove annotations preceding a sequence marker.");
            void* cursor = nullptr;
            std::size_t members = 0;
            while (fy_node_mapping_iterate(parent, &cursor))
                ++members;
            std::string retained = std::string(prefix.substr(0, dash + 1));
            if (members == 1)
                retained += " {}";
            if (after_line(source, *finish) > *finish &&
                source[after_line(source, *finish) - 1] == '\n')
                retained += '\n';
            result.replace(line_start, after_line(source, *finish) - line_start, retained);
        } else {
            result.erase(leading, after_line(source, *finish) - leading);
        }
        return result;
    }
    if (default_value && replacement == *default_value && pair &&
        (edit.comments == YamlCommentDisposition::Remove || !commented)) {
        if (parent && fy_node_get_style(parent) == FYNS_FLOW)
            throw SourceFailure("Cannot omit a YAML flow mapping field without rewriting peers.");
        const auto key_at = mark_offset(fy_node_get_start_token(key));
        const auto last = mark_offset(fy_node_get_end_token(node), true);
        if (!key_at || !last || start_of_line(source, *key_at) != start_of_line(source, *last))
            throw SourceFailure(
                "Cannot omit a multi-line YAML default without source reconciliation.");
        const auto line_start = start_of_line(source, *key_at);
        const auto leading = annotation_start(
            source, *key_at, edit.comments == YamlCommentDisposition::Remove && remove_leading);
        // If the key starts a sequence mapping entry, the dash belongs to the
        // sequence, not the field. Preserve it so the item stays a mapping.
        const auto prefix = source.substr(line_start, *key_at - line_start);
        const auto dash = prefix.find_first_not_of(" \t");
        const bool sequence_entry =
            dash != std::string_view::npos && prefix[dash] == '-' &&
            prefix.find_first_not_of(" \t", dash + 1) == std::string_view::npos;
        std::string result(source);
        if (sequence_entry) {
            if (leading != line_start)
                throw SourceFailure("Cannot remove annotations preceding a sequence marker.");
            void* previous_pair = nullptr;
            std::size_t members = 0;
            while (fy_node_mapping_iterate(parent, &previous_pair))
                ++members;
            auto kept = std::string(prefix.substr(0, dash + 1));
            if (members == 1)
                kept += " {}";
            const auto line_end = after_line(source, *last);
            if (line_end > *last && source[line_end - 1] == '\n')
                kept += '\n';
            result.replace(line_start, after_line(source, *last) - line_start, kept);
        } else {
            result.erase(leading, after_line(source, *last) - leading);
        }
        return result;
    }
    auto start = mark_offset(fy_node_get_start_token(node));
    auto finish = mark_offset(fy_node_get_end_token(node), true);
    if (!start || !finish || *finish < *start || *finish > source.size())
        throw SourceFailure("YAML edit has no safe physical source span.");
    // libfyaml scalar marks exclude surrounding quote delimiters. Replacing only
    // the inner content would emit JSON quotes *inside* the existing YAML quotes.
    if (fy_node_is_scalar(node)) {
        const auto style = fy_node_get_style(node);
        const char quote = style == FYNS_DOUBLE_QUOTED   ? '"'
                           : style == FYNS_SINGLE_QUOTED ? '\''
                                                         : '\0';
        if (quote && *start > 0 && *finish < source.size() && source[*start - 1] == quote &&
            source[*finish] == quote) {
            --*start;
            ++*finish;
        }
    }
    // Replacing an annotated subtree would silently discard its nested comments. Require
    // fine-grained child edits instead (or an explicit future structural reconciliation).
    if (!fy_node_is_scalar(node) && contains_comment(node))
        throw SourceFailure("Cannot replace a commented YAML subtree as one value.", *start);
    std::string result(source);
    auto encoded = emit_source_value(replacement, node);
    // The end mark of a block mapping/sequence can point to the following
    // sibling's token. When replacing its entire multi-line value with a
    // compact JSON-flow value, preserve the consumed line boundary rather
    // than joining the flow value to that sibling's key.
    if (!fy_node_is_scalar(node) &&
        (fy_node_get_style(node) == FYNS_BLOCK || fy_node_get_style(node) == FYNS_ANY) &&
        source.substr(*start, *finish - *start).find('\n') != std::string_view::npos &&
        !encoded.ends_with('\n')) {
        const auto next_line_start = start_of_line(source, *finish);
        const auto indent = source.substr(next_line_start, *finish - next_line_start);
        if (!std::all_of(indent.begin(), indent.end(),
                         [](char c) { return c == ' ' || c == '\t'; }))
            throw SourceFailure("Cannot safely retain the following YAML sibling's indent.");
        encoded += source.substr(*start, *finish - *start).find("\r\n") != std::string_view::npos
                       ? "\r\n"
                       : "\n";
        encoded += indent;
    }
    result.replace(*start, *finish - *start, encoded);
    if (edit.comments == YamlCommentDisposition::Remove) {
        const auto key_start = key ? mark_offset(fy_node_get_start_token(key)) : start;
        erase_comments(result, key_start.value_or(*start), *start + encoded.size(), remove_leading);
    }
    return result;
}

YamlSourceResult failure(std::string_view input, std::string message,
                         std::optional<std::size_t> offset = std::nullopt)
{
    YamlSourceResult result;
    result.source = input;
    result.error = std::move(message);
    result.error_offset = offset;
    return result;
}
} // namespace

YamlSourceResult open_yaml_source(std::string_view source)
{
    try {
        Parsed parsed(source);
        YamlSourceResult result;
        result.source = source;
        result.source_json = visit(parsed.root(), "", result.locations).to_string();
        result.accepted = true;
        return result;
    } catch (const SourceFailure& e) {
        return failure(source, e.what(), e.offset);
    } catch (const std::exception& e) {
        return failure(source, e.what());
    }
}

YamlSourceResult edit_yaml_source(std::string_view source, const std::vector<YamlValueEdit>& edits)
{
    auto current = open_yaml_source(source);
    if (!current.accepted)
        return current;
    try {
        // Atomic batch: no partial result is published if any edit or reopen fails.
        std::string text(source);
        for (const auto& edit : edits) {
            const auto before = open_yaml_source(text);
            text = apply_one(text, edit);
            auto checked = open_yaml_source(text);
            if (!checked.accepted)
                throw SourceFailure("Edited YAML cannot be reopened: " + checked.error,
                                    checked.error_offset);
            const auto parts = split_pointer(edit.path);
            const auto old_json = Json::parse(before.source_json);
            const auto new_json = Json::parse(checked.source_json);
            if (!same_outside_path(old_json, new_json, parts))
                throw SourceFailure("YAML edit changed an unrelated value or container type.");
            const auto replacement = edit.operation == YamlEditOperation::Remove
                                         ? Json::null()
                                         : Json::parse(edit.value_json);
            const auto* final_value = json_at_path(new_json, parts);
            if (edit.operation == YamlEditOperation::Remove) {
                if (final_value)
                    throw SourceFailure("YAML removal still contains the selected field.");
                continue;
            }
            if (final_value) {
                if (*final_value != replacement)
                    throw SourceFailure("YAML edit did not produce the requested value.");
            } else if (!edit.omission_default_json ||
                       replacement != Json::parse(*edit.omission_default_json)) {
                throw SourceFailure("YAML edit unexpectedly removed the selected value.");
            }
        }
        return open_yaml_source(text);
    } catch (const SourceFailure& e) {
        return failure(source, e.what(), e.offset);
    } catch (const std::exception& e) {
        return failure(source, e.what());
    }
}

YamlSourceResult format_yaml_source(std::string_view source)
{
    const auto initial = open_yaml_source(source);
    if (!initial.accepted)
        return initial;
    try {
        Parsed parsed(source);
        auto* buffer = fy_emit_document_to_string(
            parsed.document(), static_cast<fy_emitter_cfg_flags>(
                                   FYECF_MODE_ORIGINAL | FYECF_INDENT_2 | FYECF_WIDTH_INF |
                                   FYECF_OUTPUT_COMMENTS | FYECF_STRIP_DOC));
        if (!buffer)
            throw SourceFailure("Native YAML formatter could not emit its source document.");
        std::string formatted(buffer);
        free(buffer);
        // The authoritative JS YAML writer emits indented block sequences
        // under mapping values ("key:\n  - value"). libfyaml emits valid
        // but indentless sequences ("key:\n- value"). Normalize that one
        // syntactic choice without touching scalar content or comment text.
        std::vector<std::string> lines;
        for (std::size_t at = 0; at < formatted.size();) {
            const auto end = formatted.find('\n', at);
            lines.push_back(
                formatted.substr(at, (end == formatted.npos ? formatted.size() : end) - at));
            at = end == formatted.npos ? formatted.size() : end + 1;
        }
        const auto indent = [](const std::string& line) {
            return static_cast<std::size_t>(
                std::distance(line.begin(), std::find_if(line.begin(), line.end(),
                                                         [](char ch) { return ch != ' '; })));
        };
        std::vector<std::size_t> shift(lines.size(), 0);
        for (std::size_t i = 0; i + 1 < lines.size(); ++i) {
            const auto& line = lines[i];
            const auto pos = line.find_last_not_of(" \t\r");
            if (pos == std::string::npos || line[pos] != ':')
                continue;
            const auto parent_indent = indent(line);
            std::size_t next = i + 1;
            while (next < lines.size() &&
                   (lines[next].empty() ||
                    lines[next].find_first_not_of(" \t\r") == std::string::npos))
                ++next;
            if (next == lines.size() || indent(lines[next]) != parent_indent ||
                !lines[next].substr(parent_indent).starts_with("- "))
                continue;
            for (std::size_t j = next; j < lines.size(); ++j) {
                if (!lines[j].empty() && lines[j].find_first_not_of(" \t\r") != std::string::npos) {
                    const auto level = indent(lines[j]);
                    if (level < parent_indent ||
                        (level == parent_indent && !lines[j].substr(level).starts_with("- ") &&
                         !lines[j].substr(level).starts_with("#")))
                        break;
                }
                shift[j] += 2;
            }
        }
        formatted.clear();
        for (std::size_t i = 0; i < lines.size(); ++i) {
            formatted.append(shift[i], ' ');
            formatted += lines[i];
            formatted += '\n';
        }
        // The existing YAML writer attaches a mapping-key comment immediately
        // before the nested value when it formats a block mapping. libfyaml
        // instead keeps that same comment to the right of the parent colon.
        // Both have identical parsed data but only the former is CLI parity.
        lines.clear();
        for (std::size_t at = 0; at < formatted.size();) {
            const auto end = formatted.find('\n', at);
            lines.push_back(
                formatted.substr(at, (end == formatted.npos ? formatted.size() : end) - at));
            at = end == formatted.npos ? formatted.size() : end + 1;
        }
        for (std::size_t i = 0; i + 1 < lines.size(); ++i) {
            const auto marker = lines[i].find('#');
            if (marker == std::string::npos)
                continue;
            auto prefix = lines[i].substr(0, marker);
            while (!prefix.empty() && prefix.back() == ' ')
                prefix.pop_back();
            if (prefix.empty() || prefix.back() != ':')
                continue;
            const auto parent_indent = indent(lines[i]);
            const auto child_indent = indent(lines[i + 1]);
            if (child_indent <= parent_indent || lines[i + 1].empty())
                continue;
            auto comment = lines[i].substr(marker);
            lines[i] = std::move(prefix);
            lines.insert(lines.begin() + static_cast<std::ptrdiff_t>(i + 1),
                         std::string(child_indent, ' ') + comment);
            ++i;
        }
        formatted.clear();
        for (const auto& line : lines)
            formatted += line + '\n';
        const auto checked = open_yaml_source(formatted);
        if (!checked.accepted ||
            Json::parse(checked.source_json) != Json::parse(initial.source_json))
            throw SourceFailure("Native YAML emitter altered the source semantic value.");
        const auto count_comments = [](const YamlSourceResult& source) {
            return std::count_if(source.locations.begin(), source.locations.end(),
                                 [](const auto& location) { return location.has_comment; });
        };
        if (count_comments(checked) != count_comments(initial))
            throw SourceFailure("Native YAML emission changed the annotated comment inventory.");
        return checked;
    } catch (const SourceFailure& error) {
        return failure(source, error.what(), error.offset);
    } catch (const std::exception& error) {
        return failure(source, error.what());
    }
}

} // namespace noveltea::authoring
