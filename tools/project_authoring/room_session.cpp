#include "room_session.hpp"
#include "property_semantics.hpp"
#include "character_archetype_semantics.hpp"
#include "asset_animation_semantics.hpp"
#include "material_semantics.hpp"
#include "interactable_inventory_semantics.hpp"
#include "dialogue_scene_semantics.hpp"
#include "verb_interaction_semantics.hpp"
#include "test_semantics.hpp"
#include "localization_semantics.hpp"
#include "localization_operations.hpp"

#include <jsoncons/json.hpp>
#include <jsoncons_ext/jsonpointer/jsonpointer.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <set>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <tuple>
#include <utility>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;
std::string pointer_token(std::string_view token);

std::string read_bytes(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read Room source: " + path.string());
    std::string result(std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{});
    if (input.bad())
        throw std::runtime_error("Cannot finish reading Room source: " + path.string());
    return result;
}

bool analyzable_text_path(std::string_view path)
{
    return (path.ends_with(".lua") || path.ends_with(".rml") || path.ends_with(".rcss")) &&
           !path.starts_with(".noveltea/");
}

bool indexed_text_owner(std::string_view owner)
{
    for (const auto* family : {"scripts/", "layouts/", "rooms/", "scenes/", "dialogues/", "verbs/",
                               "interactions/", "maps/"})
        if (owner.starts_with(family))
            return true;
    return false;
}

bool localization_record_owner(std::string_view owner)
{
    // Character and Interactable records contain structured TextContent but
    // do not own Lua/RML source analyses. Keep the two indexes independent.
    return indexed_text_owner(owner) || owner.starts_with("characters/") ||
           owner.starts_with("interactables/");
}

// Search decoded semantic scalar values, never physical YAML substrings:
// quoted escapes, block scalars and aliases can encode a canonical ID without
// spelling its bytes in the source file.
bool references_any(const Json& value, const std::set<std::string>& ids)
{
    if (ids.empty())
        return false;
    if (value.is_string())
        return ids.contains(value.as<std::string>());
    if (value.is_array())
        return std::any_of(value.array_range().begin(), value.array_range().end(),
                           [&](const Json& member) { return references_any(member, ids); });
    if (value.is_object())
        for (const auto& field : value.object_range())
            if (ids.contains(std::string(field.key())) || references_any(field.value(), ids))
                return true;
    return false;
}

std::optional<Json> decoded_record(const std::filesystem::path& path)
{
    const auto opened = open_yaml_source(read_bytes(path));
    if (!opened.accepted)
        return std::nullopt;
    return Json::parse(opened.source_json);
}

void collect_inline_lua(const Json& value, const std::string& pointer,
                        std::map<std::string, std::string>& sources)
{
    if (value.is_array()) {
        for (std::size_t index = 0; index < value.size(); ++index)
            collect_inline_lua(value.at(index), pointer + "/" + std::to_string(index), sources);
        return;
    }
    if (!value.is_object())
        return;
    const auto is = [&](std::string_view key, std::string_view expected) {
        return value.contains(key) && value.at(key).is_string() && value.at(key) == expected;
    };
    // These are the authored execution surfaces registered by the TS source
    // registry. Do not analyze incidental strings or non-Lua inline content.
    if ((is("kind", "inline-lua") || is("kind", "lua-expression") || is("kind", "lua-predicate") ||
         is("kind", "run-lua-effect") || is("kind", "run-lua") || is("type", "run-lua")) &&
        value.contains("source") && value.at("source").is_string())
        sources.emplace(pointer + "/source", value.at("source").as<std::string>());
    for (const auto& entry : value.object_range())
        collect_inline_lua(entry.value(), pointer + "/" + pointer_token(entry.key()), sources);
}

std::string source_diagnostic_owner(std::string_view path, std::string_view owner = {})
{
    if (owner.starts_with("scripts/"))
        return "/" + pointer_token(owner.substr(0, 7)) + "/" + pointer_token(owner.substr(8)) +
               "/data/source/path";
    if (owner.starts_with("layouts/")) {
        const auto id = owner.substr(8);
        const auto stem = "records/layouts/" + std::string(id) + "/layout.";
        if (path.starts_with(stem)) {
            const auto channel = path.substr(stem.size());
            if (channel == "lua" || channel == "rml" || channel == "rcss")
                return "/layouts/" + pointer_token(id) + "/data/" + std::string(channel) +
                       "/sourceText";
        }
        // Asset-backed RML/RCSS has a source Asset selector, not a
        // Layout-local companion or a script dependency.
        if (path.starts_with("assets/") && (path.ends_with(".rml") || path.ends_with(".rcss")))
            return "/layouts/" + pointer_token(id) + "/data/" +
                   (path.ends_with(".rml") ? "rml" : "rcss") + "/sourceAsset/$ref";
        return "/layouts/" + pointer_token(id) + "/data/dependencies/scripts";
    }
    const auto name = std::string(path);
    if (name.starts_with("records/layouts/")) {
        const auto rest = name.substr(sizeof("records/layouts/") - 1);
        const auto split = rest.find('/');
        if (split != std::string::npos && rest.substr(split + 1).starts_with("layout.")) {
            const auto suffix = rest.substr(split + sizeof("/layout.") - 1);
            if (suffix == "rml" || suffix == "rcss" || suffix == "lua")
                return "/layouts/" + pointer_token(rest.substr(0, split)) + "/data/" + suffix +
                       "/sourceText";
        }
    }
    if (name.starts_with("scripts/") && name.ends_with(".lua")) {
        const auto id =
            name.substr(sizeof("scripts/") - 1, name.size() - (sizeof("scripts/") - 1) - 4);
        return "/scripts/" + pointer_token(id) + "/data/source/path";
    }
    return "/sources/" + pointer_token(path);
}

} // namespace

// Use the same sha256:<hex> source identity as the existing Project Workspace.
// Save also checks original bytes exactly to eliminate reliance on the digest alone.
std::string exact_source_revision(std::string_view source)
{
    static constexpr std::array<std::uint32_t, 64> constants{
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2};
    std::array<std::uint32_t, 8> state{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                       0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    const auto block = [&](const unsigned char* bytes) {
        std::array<std::uint32_t, 64> words{};
        for (std::size_t i = 0; i < 16; ++i)
            words[i] = (static_cast<std::uint32_t>(bytes[i * 4]) << 24) |
                       (static_cast<std::uint32_t>(bytes[i * 4 + 1]) << 16) |
                       (static_cast<std::uint32_t>(bytes[i * 4 + 2]) << 8) | bytes[i * 4 + 3];
        for (std::size_t i = 16; i < 64; ++i) {
            const auto a =
                std::rotr(words[i - 15], 7) ^ std::rotr(words[i - 15], 18) ^ (words[i - 15] >> 3);
            const auto b =
                std::rotr(words[i - 2], 17) ^ std::rotr(words[i - 2], 19) ^ (words[i - 2] >> 10);
            words[i] = words[i - 16] + a + words[i - 7] + b;
        }
        auto [a, b, c, d, e, f, g, h] = std::tuple{state[0], state[1], state[2], state[3],
                                                   state[4], state[5], state[6], state[7]};
        for (std::size_t i = 0; i < 64; ++i) {
            const auto s1 = std::rotr(e, 6) ^ std::rotr(e, 11) ^ std::rotr(e, 25);
            const auto ch = (e & f) ^ (~e & g);
            const auto temp1 = h + s1 + ch + constants[i] + words[i];
            const auto s0 = std::rotr(a, 2) ^ std::rotr(a, 13) ^ std::rotr(a, 22);
            const auto maj = (a & b) ^ (a & c) ^ (b & c);
            const auto temp2 = s0 + maj;
            h = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }
        for (std::size_t i = 0; i < state.size(); ++i)
            state[i] += std::array{a, b, c, d, e, f, g, h}[i];
    };
    const auto bytes = reinterpret_cast<const unsigned char*>(source.data());
    std::size_t offset = 0;
    while (source.size() - offset >= 64) {
        block(bytes + offset);
        offset += 64;
    }
    std::array<unsigned char, 128> final{};
    const auto remaining = source.size() - offset;
    if (remaining)
        std::memcpy(final.data(), bytes + offset, remaining);
    final[remaining] = 0x80;
    const auto length = remaining >= 56 ? 128U : 64U;
    const auto bit_length = static_cast<std::uint64_t>(source.size()) * 8;
    for (unsigned int i = 0; i < 8; ++i)
        final[length - 8 + i] = static_cast<unsigned char>(bit_length >> (56 - i * 8));
    block(final.data());
    if (length == 128)
        block(final.data() + 64);
    std::ostringstream out;
    out << "sha256:" << std::hex << std::setfill('0');
    for (const auto word : state)
        out << std::setw(8) << word;
    return out.str();
}

namespace {

std::string parse_pointer_token(std::string_view token)
{
    std::string decoded;
    for (std::size_t i = 0; i < token.size(); ++i) {
        if (token[i] == '~') {
            if (++i == token.size() || (token[i] != '0' && token[i] != '1'))
                throw std::runtime_error("Invalid RFC 6901 escape in Room patch.");
            decoded += token[i] == '0' ? '~' : '/';
        } else {
            decoded += token[i];
        }
    }
    return decoded;
}

void check_pointer(std::string_view pointer)
{
    if (pointer.empty() || pointer[0] != '/')
        throw std::runtime_error("A Room patch requires a non-root JSON Pointer.");
    for (std::size_t start = 1; start <= pointer.size();) {
        const auto end = pointer.find('/', start);
        parse_pointer_token(
            pointer.substr(start, end == std::string_view::npos ? end : end - start));
        if (end == std::string_view::npos)
            break;
        start = end + 1;
    }
}

std::string pointer_token(std::string_view token);

std::string resolve_id_pointer(const Json& document, std::string_view path)
{
    check_pointer(path);
    const Json* current = &document;
    std::string resolved;
    for (std::size_t start = 1; start <= path.size();) {
        const auto end = path.find('/', start);
        const auto raw = path.substr(start, end == std::string_view::npos ? end : end - start);
        auto token = parse_pointer_token(raw);
        if (current && current->is_array() && token.starts_with('@')) {
            const auto id = token.substr(1);
            std::optional<std::size_t> index;
            for (std::size_t i = 0; i < current->size(); ++i) {
                const auto& entry = current->at(i);
                if (entry.is_object() && entry.contains("id") && entry.at("id") == id) {
                    if (index)
                        throw std::runtime_error("Ambiguous ID-keyed JSON Pointer: " + id);
                    index = i;
                }
            }
            if (!index)
                throw std::runtime_error("Missing ID-keyed JSON Pointer target: " + id);
            token = std::to_string(*index);
        }
        resolved += "/" + pointer_token(token);
        try {
            current = &jsoncons::jsonpointer::get(document,
                                                  jsoncons::jsonpointer::json_pointer(resolved));
        } catch (...) {
            current = nullptr;
        }
        if (end == std::string_view::npos)
            break;
        start = end + 1;
    }
    return resolved;
}

void apply_patch(Json& value, const RoomPatch& patch)
{
    check_pointer(patch.path);
    const jsoncons::jsonpointer::json_pointer pointer(patch.path);
    const auto last_slash = patch.path.rfind('/');
    const auto parent = jsoncons::jsonpointer::json_pointer(patch.path.substr(0, last_slash));
    const auto key = parse_pointer_token(patch.path.substr(last_slash + 1));
    const auto& container = jsoncons::jsonpointer::get(value, parent);
    if (patch.operation == RoomPatch::Operation::Add && container.is_object() &&
        container.contains(key))
        throw std::runtime_error("Object key already exists for add operation.");
    if (patch.operation == RoomPatch::Operation::Remove) {
        if (!patch.value_json.empty())
            throw std::runtime_error("Remove must not include a value.");
        jsoncons::jsonpointer::remove(value, pointer);
    } else {
        if (patch.value_json.empty())
            throw std::runtime_error("Add/replace requires a JSON value.");
        const auto replacement = Json::parse(patch.value_json);
        if (patch.operation == RoomPatch::Operation::Add)
            jsoncons::jsonpointer::add(value, pointer, replacement);
        else
            jsoncons::jsonpointer::replace(value, pointer, replacement);
    }
}

bool same_diagnostic(const Diagnostic& a, const Diagnostic& b)
{
    return a.path == b.path && a.code == b.code && a.message == b.message;
}

void diagnostic_delta(RoomSessionResult& result, const RoomSessionSnapshot& prior)
{
    for (const auto& diagnostic : result.snapshot.diagnostics)
        if (std::none_of(prior.diagnostics.begin(), prior.diagnostics.end(),
                         [&](const Diagnostic& old) { return same_diagnostic(old, diagnostic); }))
            result.diagnostics_added.push_back(diagnostic);
    for (const auto& diagnostic : prior.diagnostics)
        if (std::none_of(result.snapshot.diagnostics.begin(), result.snapshot.diagnostics.end(),
                         [&](const Diagnostic& now) { return same_diagnostic(now, diagnostic); }))
            result.diagnostics_removed.push_back(diagnostic);
}

std::string pointer_token(std::string_view token)
{
    std::string escaped;
    for (char c : token) {
        if (c == '~')
            escaped += "~0";
        else if (c == '/')
            escaped += "~1";
        else
            escaped += c;
    }
    return escaped;
}

void source_diff(const Json* before, const Json* after, const std::string& pointer,
                 const std::vector<RoomPatch>& patches, std::vector<YamlValueEdit>& edits)
{
    if (before && after && *before == *after)
        return;
    // Inserting children into a compact '{}' flow mapping is deliberately
    // rejected by the YAML writer. Replace that empty mapping at its owned
    // path instead, without rewriting any sibling YAML entries.
    if (before && after && before->is_object() && after->is_object() &&
        (pointer.empty() || !before->empty())) {
        for (const auto& member : before->object_range()) {
            const auto child = pointer + "/" + pointer_token(member.key());
            source_diff(&member.value(),
                        after->contains(member.key()) ? &after->at(member.key()) : nullptr, child,
                        patches, edits);
        }
        for (const auto& member : after->object_range())
            if (!before->contains(member.key()))
                source_diff(nullptr, &member.value(), pointer + "/" + pointer_token(member.key()),
                            patches, edits);
        return;
    }
    if (before && after && before->is_array() && after->is_array() &&
        before->size() == after->size()) {
        for (std::size_t i = 0; i < before->size(); ++i)
            source_diff(&before->at(i), &after->at(i), pointer + "/" + std::to_string(i), patches,
                        edits);
        return;
    }
    if (pointer.empty())
        throw std::runtime_error("Cannot replace the Room document root.");
    YamlValueEdit edit{pointer, after ? after->to_string() : ""};
    edit.operation = !before  ? YamlEditOperation::Add
                     : !after ? YamlEditOperation::Remove
                              : YamlEditOperation::Replace;
    for (auto it = patches.rbegin(); it != patches.rend(); ++it)
        if (it->path == pointer) {
            edit.comments = it->comments;
            break;
        }
    edits.push_back(std::move(edit));
}

std::optional<Json> at_pointer(const Json& value, std::string_view pointer)
{
    try {
        return Json(
            jsoncons::jsonpointer::get(value, jsoncons::jsonpointer::json_pointer(pointer)));
    } catch (...) {
        return std::nullopt;
    }
}

void json_delta(const Json* base, const Json* next, const std::string& path,
                std::vector<RoomPatch>& result)
{
    if (base && next && *base == *next)
        return;
    if (base && next && base->is_object() && next->is_object()) {
        for (const auto& item : base->object_range()) {
            const auto child = path + "/" + pointer_token(item.key());
            json_delta(&item.value(), next->contains(item.key()) ? &next->at(item.key()) : nullptr,
                       child, result);
        }
        for (const auto& item : next->object_range())
            if (!base->contains(item.key()))
                json_delta(nullptr, &item.value(), path + "/" + pointer_token(item.key()), result);
        return;
    }
    if (path.empty())
        throw std::runtime_error("Cannot replace the Project source root.");
    RoomPatch patch;
    patch.operation = !base   ? RoomPatch::Operation::Add
                      : !next ? RoomPatch::Operation::Remove
                              : RoomPatch::Operation::Replace;
    patch.path = path;
    patch.value_json = next ? next->to_string() : "";
    result.push_back(std::move(patch));
}

// Editor patches target an effective record: a container supplied by schema
// defaults can be absent from its sparse YAML source. Materialize only the
// missing container shells needed to reach an Add target. Never copy unrelated
// normalized defaults into the authored source, and fail closed when the
// requested parent is not a known implicit object or array.
void materialize_implicit_parents(Json& working, const Json& effective, const RoomPatch& operation,
                                  std::vector<RoomPatch>& resolved)
{
    const auto parent_end = operation.path.rfind('/');
    for (std::size_t end = operation.path.find('/', 1);
         end != std::string::npos && end <= parent_end; end = operation.path.find('/', end + 1)) {
        const auto path = operation.path.substr(0, end);
        if (at_pointer(working, path))
            continue;
        const auto normalized = at_pointer(effective, path);
        if (!normalized || (!normalized->is_array() && !normalized->is_object()))
            throw std::runtime_error("Normalized Add parent is not an implicit container.");
        RoomPatch create{RoomPatch::Operation::Add, path, normalized->is_array() ? "[]" : "{}",
                         operation.comments};
        apply_patch(working, create);
        resolved.push_back(std::move(create));
    }
}

// recordMetadata is a dynamic map, so its new collection/record keys do not
// appear in the normalized baseline. Create only the explicitly addressed
// mapping shells; other editor containers must be proven schema defaults.
void materialize_editor_metadata_parents(Json& working, const RoomPatch& operation,
                                         std::vector<RoomPatch>& resolved)
{
    constexpr std::string_view prefix = "/recordMetadata/";
    if (!operation.path.starts_with(prefix))
        return;
    auto next_slash = operation.path.find('/', prefix.size());
    if (next_slash == std::string::npos)
        return;
    for (int level = 0; level < 2 && next_slash != std::string::npos; ++level) {
        const auto path = operation.path.substr(0, next_slash);
        if (!at_pointer(working, path)) {
            RoomPatch create{RoomPatch::Operation::Add, path, "{}", operation.comments};
            apply_patch(working, create);
            resolved.push_back(std::move(create));
        }
        next_slash = operation.path.find('/', next_slash + 1);
    }
}

// When an inverse removes the last element of a defaulted collection, return
// to the original omission instead of leaving a new explicit empty YAML key.
void omit_restored_default_parents(Json& working, const Json& baseline_source,
                                   const Json& baseline_effective, std::string_view operation_path)
{
    std::vector<std::string> ancestors;
    for (std::size_t end = operation_path.find('/', 1); end != std::string_view::npos;
         end = operation_path.find('/', end + 1))
        ancestors.emplace_back(operation_path.substr(0, end));
    for (auto it = ancestors.rbegin(); it != ancestors.rend(); ++it) {
        if (at_pointer(baseline_source, *it))
            continue;
        const auto effective = at_pointer(baseline_effective, *it);
        const auto current = at_pointer(working, *it);
        if (effective && current && *effective == *current)
            jsoncons::jsonpointer::remove(working, jsoncons::jsonpointer::json_pointer(*it));
    }
}

void omit_empty_editor_metadata_parents(Json& working, const Json& baseline_source,
                                        std::string_view operation_path)
{
    constexpr std::string_view prefix = "/recordMetadata/";
    if (!operation_path.starts_with(prefix))
        return;
    std::vector<std::string> ancestors;
    for (auto end = operation_path.find('/', prefix.size()); end != std::string_view::npos;
         end = operation_path.find('/', end + 1))
        ancestors.emplace_back(operation_path.substr(0, end));
    for (auto it = ancestors.rbegin(); it != ancestors.rend(); ++it) {
        const auto current = at_pointer(working, *it);
        if (!at_pointer(baseline_source, *it) && current && current->empty() &&
            (current->is_object() || (it->ends_with("/tags") && current->is_array())))
            jsoncons::jsonpointer::remove(working, jsoncons::jsonpointer::json_pointer(*it));
    }
}

bool paths_overlap(std::string_view a, std::string_view b)
{
    return a == b || (a.size() > b.size() && a.starts_with(b) && a[b.size()] == '/') ||
           (b.size() > a.size() && b.starts_with(a) && b[a.size()] == '/');
}

// Source-space selection: never replace an entire shared physical source just
// because one logical save unit owns a descendant of a compact '{}' mapping.
void select_path(Json& destination, const Json& desired, std::string_view path)
{
    check_pointer(path);
    const auto last = path.rfind('/');
    const auto parent_path = path.substr(0, last);
    const auto key = parse_pointer_token(path.substr(last + 1));
    const auto value = at_pointer(desired, path);
    Json* parent = &destination;
    for (std::size_t start = 1; start < parent_path.size();) {
        const auto slash = parent_path.find('/', start);
        const auto token = parse_pointer_token(
            parent_path.substr(start, slash == std::string_view::npos ? slash : slash - start));
        if (!parent->is_object())
            throw std::runtime_error("Logical Save path traverses a non-object source.");
        if (!parent->contains(token) && !value)
            return;
        if (!parent->contains(token))
            parent->insert_or_assign(token, Json::object());
        parent = &parent->at(token);
        if (slash == std::string_view::npos)
            break;
        start = slash + 1;
    }
    if (!parent->is_object())
        throw std::runtime_error("Logical Save path parent is not a mapping.");
    if (value)
        parent->insert_or_assign(key, *value);
    else if (parent->contains(key))
        parent->erase(key);
}

bool is_id(std::string_view id)
{
    static const std::regex pattern(R"(^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$)");
    return std::regex_match(id.begin(), id.end(), pattern);
}

const std::map<std::string, std::string>& record_contracts()
{
    static const std::map<std::string, std::string> contracts{
        {"animations", "AnimationsRecord"},
        {"archetypes", "ArchetypesRecord"},
        {"assets", "AssetsRecord"},
        {"characters", "CharactersRecord"},
        {"dialogues", "DialoguesRecord"},
        {"interactables", "InteractablesRecord"},
        {"interactions", "InteractionsRecord"},
        {"layouts", "LayoutsRecord"},
        {"maps", "MapsRecord"},
        {"materials", "MaterialsRecord"},
        {"rooms", "RoomsRecord"},
        {"scenes", "ScenesRecord"},
        {"scripts", "ScriptsRecord"},
        {"tests", "TestsRecord"},
        {"variables", "VariablesRecord"},
        {"verbs", "VerbsRecord"}};
    return contracts;
}

bool tracked_fragment(std::string_view name)
{
    static const std::set<std::string> fixed{
        "project.yaml",       "traits.yaml",           "editor.yaml",        "i18n/project.yaml",
        "i18n/messages.yaml", "i18n/usage-notes.yaml", "i18n/tracking.yaml", "i18n/orphans.yaml"};
    if (fixed.contains(std::string(name)))
        return true;
    for (const auto prefix :
         {std::string_view{"i18n/locales/"}, std::string_view{"i18n/assets/"}}) {
        if (name.starts_with(prefix)) {
            const auto leaf = name.substr(prefix.size());
            return leaf.size() > 5 && leaf.ends_with(".yaml") &&
                   leaf.find('/') == std::string_view::npos;
        }
    }
    return false;
}

struct LocalizationPatchTarget {
    std::string owner;
    std::string relative_path;
};

std::optional<LocalizationPatchTarget> localization_patch_target(std::string_view path)
{
    if (!path.starts_with("/localization/"))
        return std::nullopt;
    const auto tail = path.substr(sizeof("/localization/") - 1);
    const auto slash = tail.find('/');
    const auto field = tail.substr(0, slash);
    const auto suffix = slash == std::string_view::npos ? std::string_view{} : tail.substr(slash);
    if (field == "messages" || field == "structuredMessageIds")
        return LocalizationPatchTarget{"i18n/messages.yaml", "/" + std::string(tail)};
    if (field == "usageNotes" || field == "sourceMessageTracking" || field == "orphanedMessages") {
        if (suffix.empty())
            return std::nullopt;
        return LocalizationPatchTarget{field == "usageNotes"              ? "i18n/usage-notes.yaml"
                                       : field == "sourceMessageTracking" ? "i18n/tracking.yaml"
                                                                          : "i18n/orphans.yaml",
                                       std::string(suffix)};
    }
    if (field == "translations" || field == "assets") {
        if (suffix.empty())
            return std::nullopt;
        const auto end = suffix.find('/', 1);
        if (end == std::string_view::npos)
            return std::nullopt;
        const auto locale = suffix.substr(1, end - 1);
        if (!is_canonical_localization_locale(locale))
            return std::nullopt;
        return LocalizationPatchTarget{
            "i18n/" + std::string(field == "translations" ? "locales" : "assets") + "/" +
                std::string(locale) + ".yaml",
            std::string(suffix.substr(end))};
    }
    if (field == "sourceLocale" || field == "sourceLocaleLock" || field == "defaultLocale" ||
        field == "locales")
        return LocalizationPatchTarget{"i18n/project.yaml", "/" + std::string(tail)};
    return std::nullopt;
}

std::vector<ProjectFile> inventory_project(const std::filesystem::path& root, const Json& manifest,
                                           bool validation_only = false)
{
    static const std::set<std::string> collections{
        "animations",   "archetypes", "assets",    "characters", "dialogues", "interactables",
        "interactions", "layouts",    "maps",      "materials",  "rooms",     "scenes",
        "scripts",      "tests",      "variables", "verbs"};
    static const std::set<std::string> retired{
        "project.json",       "traits.json",           "editor.json",        "i18n/project.json",
        "i18n/messages.json", "i18n/usage-notes.json", "i18n/tracking.json", "i18n/orphans.json"};
    const auto canonical_root = std::filesystem::canonical(root);
    std::set<std::string> referenced_sources;
    if (manifest.contains("settings") && manifest.at("settings").is_object()) {
        const auto& settings = manifest.at("settings");
        if (settings.contains("distributionNotices") &&
            settings.at("distributionNotices").is_array()) {
            for (const auto& notice : settings.at("distributionNotices").array_range())
                if (notice.is_object() && notice.contains("path") && notice.at("path").is_string())
                    referenced_sources.insert(notice.at("path").as<std::string>());
        }
    }
    for (const auto* required :
         {"project.yaml", "traits.yaml", "editor.yaml", "i18n/project.yaml", "i18n/messages.yaml",
          "i18n/usage-notes.yaml", "i18n/tracking.yaml", "i18n/orphans.yaml"})
        if (!std::filesystem::is_regular_file(root / required) && !validation_only)
            throw std::runtime_error("Required Project source is absent: " + std::string(required));

    std::vector<ProjectFile> files;
    std::vector<std::filesystem::path> active_directories{canonical_root};
    std::filesystem::recursive_directory_iterator it(
        root, std::filesystem::directory_options::follow_directory_symlink),
        end;
    for (; it != end; ++it) {
        const auto relative = it->path().lexically_relative(root).generic_string();
        const auto first = relative.substr(0, relative.find('/'));
        // Don't descend into unrelated machine state or Git/build caches; these are not authoring.
        if (first == ".git" || first == "node_modules" || first == "build" || first == ".cache") {
            if (it->is_directory())
                it.disable_recursion_pending();
            files.push_back({relative, ProjectFileKind::IgnoredState});
            continue;
        }
        if (it->is_symlink()) {
            // A source path must not escape the admitted canonical Project root, even via symlinks.
            const auto target = std::filesystem::weakly_canonical(it->path());
            const auto subpath = target.lexically_relative(canonical_root);
            if (subpath.empty() || subpath == ".." || *subpath.begin() == "..")
                throw std::runtime_error("Project source escapes root: " + relative);
        }
        if (it->is_directory()) {
            const auto canonical_directory = std::filesystem::canonical(it->path());
            const auto ancestor_count = static_cast<std::size_t>(it.depth()) + 1;
            if (std::find(active_directories.begin(),
                          active_directories.begin() + static_cast<std::ptrdiff_t>(ancestor_count),
                          canonical_directory) !=
                active_directories.begin() + static_cast<std::ptrdiff_t>(ancestor_count))
                throw std::runtime_error("Project source directory symlink cycle: " + relative);
            active_directories.resize(ancestor_count + 1);
            active_directories[ancestor_count] = canonical_directory;
            if (relative.starts_with("records/") && relative.find('/', 8) == std::string::npos &&
                !collections.contains(relative.substr(8)))
                throw std::runtime_error("Unknown record collection: " + relative);
            if (it->path().parent_path().lexically_relative(root) == "records/layouts" &&
                (!is_id(it->path().filename().string()) ||
                 (!std::filesystem::is_regular_file(it->path() / "layout.yaml") &&
                  !std::filesystem::is_empty(it->path()))))
                throw std::runtime_error("Layout requires canonical layout.yaml: " + relative);
            const auto parent = it->path().parent_path().lexically_relative(root).generic_string();
            if (relative.starts_with("records/") && parent != "records" &&
                parent != "records/layouts")
                throw std::runtime_error("Nested record directories are not canonical: " +
                                         relative);
            continue;
        }
        if (!it->is_regular_file())
            throw std::runtime_error("Non-regular Project source: " + relative);
        if (retired.contains(relative) ||
            (relative.starts_with("records/") && relative.ends_with(".json")))
            throw std::runtime_error("Retired Project source format: " + relative);
        if (relative.starts_with(".noveltea/") || relative.starts_with("workflows/")) {
            files.push_back({relative, ProjectFileKind::IgnoredState});
            continue;
        }
        if (tracked_fragment(relative)) {
            if (!validation_only) {
                const auto opened = open_yaml_source(read_bytes(it->path()));
                if (!opened.accepted)
                    throw std::runtime_error("Invalid tracked YAML " + relative + ": " +
                                             opened.error);
                if (!Json::parse(opened.source_json).is_object())
                    throw std::runtime_error("Tracked Project YAML must be an object: " + relative);
            }
            files.push_back({relative, ProjectFileKind::TrackedSource});
        } else if (relative.starts_with("records/")) {
            const auto parts = std::filesystem::path(relative);
            auto component = parts.begin();
            ++component; // records/
            if (component == parts.end() || !collections.contains(component->string()))
                throw std::runtime_error("Unknown record collection: " + relative);
            const auto collection = component->string();
            ++component;
            if (component == parts.end())
                throw std::runtime_error("Invalid record path: " + relative);
            if (collection != "layouts") {
                const auto leaf = component->string();
                ++component;
                if (component != parts.end() || !relative.ends_with(".yaml") ||
                    !is_id(leaf.substr(0, leaf.size() - 5)))
                    throw std::runtime_error("Noncanonical record path: " + relative);
                const auto decoded = open_yaml_source(read_bytes(it->path()));
                if (!decoded.accepted && validation_only) {
                    files.push_back({relative, ProjectFileKind::TrackedSource});
                    continue;
                }
                if (!decoded.accepted)
                    throw std::runtime_error("Invalid record YAML: " + relative);
                const auto value = Json::parse(decoded.source_json);
                if (!value.is_object() || !value.contains("id") || !value.at("id").is_string() ||
                    value.at("id") != leaf.substr(0, leaf.size() - 5)) {
                    if (validation_only) {
                        files.push_back({relative, ProjectFileKind::TrackedSource});
                        continue;
                    }
                    throw std::runtime_error("Record ID does not match filename: " + relative);
                }
                if (collection == "assets" && value.contains("data") &&
                    value.at("data").is_object()) {
                    const auto& data = value.at("data");
                    if (data.contains("source") && data.at("source").is_object() &&
                        data.at("source").contains("path") &&
                        data.at("source").at("path").is_string())
                        referenced_sources.insert(data.at("source").at("path").as<std::string>());
                    if (data.contains("attachments") && data.at("attachments").is_array())
                        for (const auto& attachment : data.at("attachments").array_range())
                            if (attachment.is_object() && attachment.contains("path") &&
                                attachment.at("path").is_string())
                                referenced_sources.insert(attachment.at("path").as<std::string>());
                }
                files.push_back({relative, ProjectFileKind::TrackedSource});
            } else {
                const auto id = component->string();
                ++component;
                if (!is_id(id) || component == parts.end())
                    throw std::runtime_error("Invalid Layout source: " + relative);
                const auto leaf = component->string();
                ++component;
                if (component != parts.end() || (leaf != "layout.yaml" && leaf != "layout.rml" &&
                                                 leaf != "layout.rcss" && leaf != "layout.lua"))
                    throw std::runtime_error("Invalid Layout companion path: " + relative);
                if (leaf == "layout.yaml") {
                    const auto decoded = open_yaml_source(read_bytes(it->path()));
                    if (validation_only) {
                        files.push_back({relative, ProjectFileKind::TrackedSource});
                        continue;
                    }
                    if (!decoded.accepted)
                        throw std::runtime_error("Invalid Layout metadata YAML: " + relative);
                    const auto layout = Json::parse(decoded.source_json);
                    if (!layout.is_object() || !layout.contains("id") ||
                        !layout.at("id").is_string() || layout.at("id") != id)
                        throw std::runtime_error("Layout ID does not match directory: " + relative);
                    if (!layout.contains("data") || !layout.at("data").is_object())
                        throw std::runtime_error("Layout metadata requires data: " + relative);
                    for (const auto* channel : {"rml", "rcss", "lua"}) {
                        const auto& data = layout.at("data");
                        if (!data.contains(channel) || !data.at(channel).is_object() ||
                            !data.at(channel).contains("sourceMode") ||
                            !data.at(channel).at("sourceMode").is_string())
                            throw std::runtime_error("Layout source selector is malformed: " +
                                                     relative);
                        const auto mode = data.at(channel).at("sourceMode").as<std::string>();
                        const auto& selector = data.at(channel);
                        const bool file_mode = mode == "file";
                        const bool asset_mode =
                            mode == "asset" && std::string_view(channel) != "lua";
                        const bool none_mode = mode == "none" && std::string_view(channel) == "lua";
                        if ((!file_mode && !asset_mode && !none_mode) ||
                            selector.size() != (asset_mode ? 2u : 1u) ||
                            (asset_mode && !selector.contains("sourceAsset")))
                            throw std::runtime_error("Unsupported Layout selector shape: " +
                                                     relative + ": data." + channel);
                        const auto companion =
                            it->path().parent_path() / (std::string("layout.") + channel);
                        if (file_mode != std::filesystem::is_regular_file(companion))
                            throw std::runtime_error(
                                "Layout companion and source selector disagree: " +
                                companion.string());
                        if (!file_mode && std::filesystem::exists(companion))
                            throw std::runtime_error("Orphan Layout companion source: " +
                                                     companion.string());
                    }
                }
                files.push_back({relative, ProjectFileKind::TrackedSource});
            }
        } else if (relative.starts_with("scripts/") || relative.starts_with("shaders/") ||
                   relative.starts_with("assets/")) {
            files.push_back({relative, ProjectFileKind::ProjectSource});
        } else {
            files.push_back({relative, ProjectFileKind::UntrackedFile});
        }
    }
    for (auto& file : files)
        if (file.kind == ProjectFileKind::UntrackedFile && referenced_sources.contains(file.path))
            file.kind = ProjectFileKind::ProjectSource;
    std::sort(files.begin(), files.end(),
              [](const auto& a, const auto& b) { return a.path < b.path; });
    return files;
}
} // namespace

RoomSession::RoomSession(std::filesystem::path path, std::string room_id, std::string source,
                         std::string source_json)
    : path_(std::move(path)), room_id_(std::move(room_id)), disk_source_(std::move(source)),
      disk_revision_(exact_source_revision(disk_source_)), disk_json_(source_json),
      working_json_(std::move(source_json))
{
}

std::unique_ptr<RoomSession> RoomSession::open(const std::filesystem::path& project_root,
                                               std::string room_id, std::string& error)
{
    try {
        // Never permit a Room ID to escape the Project Workspace record directory.
        if (room_id.empty() || room_id == "." || room_id == ".." ||
            room_id.find_first_not_of(
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") !=
                std::string::npos)
            throw std::runtime_error("Invalid Room ID.");
        const auto path = project_root / "records" / "rooms" / (room_id + ".yaml");
        auto source = read_bytes(path);
        const auto opened = open_yaml_source(source);
        if (!opened.accepted)
            throw std::runtime_error("Invalid Room YAML: " + opened.error);
        const auto value = Json::parse(opened.source_json);
        if (!value.is_object() || !value.contains("id") || !value.at("id").is_string() ||
            value.at("id").as<std::string>() != room_id)
            throw std::runtime_error("Room source ID must match its filename.");
        error.clear();
        return std::unique_ptr<RoomSession>(
            new RoomSession(path, std::move(room_id), std::move(source), opened.source_json));
    } catch (const std::exception& e) {
        error = e.what();
        return nullptr;
    }
}

std::unique_ptr<RoomSession> RoomSession::open_map(const std::filesystem::path& project_root,
                                                   std::string map_id, std::string& error)
{
    try {
        if (!is_id(map_id))
            throw std::runtime_error("Invalid Map ID.");
        const auto path = project_root / "records" / "maps" / (map_id + ".yaml");
        auto source = read_bytes(path);
        const auto opened = open_yaml_source(source);
        if (!opened.accepted)
            throw std::runtime_error("Invalid Map YAML: " + opened.error);
        const auto value = Json::parse(opened.source_json);
        if (!value.is_object() || !value.contains("id") || !value.at("id").is_string() ||
            value.at("id").as<std::string>() != map_id)
            throw std::runtime_error("Map source ID must match its filename.");
        auto result = std::unique_ptr<RoomSession>(
            new RoomSession(path, std::move(map_id), std::move(source), opened.source_json));
        result->is_map_ = true;
        result->record_family_ = "maps";
        error.clear();
        return result;
    } catch (const std::exception& e) {
        error = e.what();
        return nullptr;
    }
}

std::unique_ptr<RoomSession> RoomSession::open_record(const std::filesystem::path& project_root,
                                                      std::string family, std::string id,
                                                      std::string& error)
{
    if (family == "rooms")
        return open(project_root, std::move(id), error);
    if (family == "maps")
        return open_map(project_root, std::move(id), error);
    try {
        if (!is_id(id) || !record_contracts().contains(family))
            throw std::runtime_error("Invalid native record owner.");
        const auto path = family == "layouts"
                              ? project_root / "records" / family / id / "layout.yaml"
                              : project_root / "records" / family / (id + ".yaml");
        auto source = read_bytes(path);
        const auto opened = open_yaml_source(source);
        if (!opened.accepted)
            throw std::runtime_error("Invalid record YAML: " + opened.error);
        const auto value = Json::parse(opened.source_json);
        if (!value.is_object() || !value.contains("id") || value.at("id") != id)
            throw std::runtime_error("Record ID must match its source filename.");
        auto record = std::unique_ptr<RoomSession>(
            new RoomSession(path, std::move(id), std::move(source), opened.source_json));
        record->record_family_ = family;
        record->validation_contract_ = record_contracts().at(family);
        error.clear();
        return record;
    } catch (const std::exception& exception) {
        error = exception.what();
        return nullptr;
    }
}

std::unique_ptr<RoomSession>
RoomSession::open_project_source(const std::filesystem::path& project_root, std::string& error,
                                 bool validation_only)
{
    try {
        auto path = project_root / "project.yaml";
        auto source = read_bytes(path);
        const auto opened = open_yaml_source(source);
        if (!opened.accepted)
            throw std::runtime_error("Invalid Project manifest YAML: " + opened.error);
        const auto validation = validate_record("WorkspaceManifest", opened.source_json);
        if (!validation.accepted)
            throw std::runtime_error("Project manifest invalid: " +
                                     (validation.diagnostics.empty()
                                          ? std::string("unknown error")
                                          : validation.diagnostics.front().path + " " +
                                                validation.diagnostics.front().message));
        auto inventory =
            inventory_project(project_root, Json::parse(opened.source_json), validation_only);
        auto result = std::unique_ptr<RoomSession>(
            new RoomSession(path, "", std::move(source), opened.source_json));
        result->is_project_ = true;
        result->file_inventory_ = std::move(inventory);
        error.clear();
        return result;
    } catch (const std::exception& e) {
        error = e.what();
        return nullptr;
    }
}

std::unique_ptr<RoomSession>
RoomSession::open_editor_source(const std::filesystem::path& project_root, std::string& error)
{
    try {
        const auto path = project_root / "editor.yaml";
        auto source = read_bytes(path);
        const auto opened = open_yaml_source(source);
        if (!opened.accepted)
            throw std::runtime_error("Invalid tracked editor YAML: " + opened.error);
        if (!validate_record("WorkspaceTrackedEditor", opened.source_json).accepted)
            throw std::runtime_error("Invalid tracked editor metadata.");
        auto result = std::unique_ptr<RoomSession>(
            new RoomSession(path, "", std::move(source), opened.source_json));
        result->is_editor_ = true;
        error.clear();
        return result;
    } catch (const std::exception& exception) {
        error = exception.what();
        return nullptr;
    }
}

std::unique_ptr<RoomSession>
RoomSession::open_traits_source(const std::filesystem::path& project_root, std::string& error)
{
    try {
        const auto path = project_root / "traits.yaml";
        auto source = read_bytes(path);
        const auto opened = open_yaml_source(source);
        if (!opened.accepted)
            throw std::runtime_error("Invalid Traits YAML: " + opened.error);
        const auto validation = validate_record("WorkspaceTraitDeclarations", opened.source_json);
        if (!validation.accepted)
            throw std::runtime_error("Invalid Traits declarations: " +
                                     (validation.diagnostics.empty()
                                          ? std::string("unknown error")
                                          : validation.diagnostics.front().path + " " +
                                                validation.diagnostics.front().message));
        auto result = std::unique_ptr<RoomSession>(
            new RoomSession(path, "", std::move(source), opened.source_json));
        result->is_traits_ = true;
        result->validation_contract_ = "WorkspaceTraitDeclarations";
        error.clear();
        return result;
    } catch (const std::exception& exception) {
        error = exception.what();
        return nullptr;
    }
}

std::unique_ptr<RoomSession>
RoomSession::open_localization_source(const std::filesystem::path& project_root,
                                      std::string_view relative_path, std::string& error)
{
    try {
        if (!relative_path.starts_with("i18n/") || !tracked_fragment(relative_path))
            throw std::runtime_error("Invalid localization source owner.");
        const auto name = std::string(relative_path);
        const auto dynamic = name.starts_with("i18n/locales/") || name.starts_with("i18n/assets/");
        if (dynamic && !is_canonical_localization_locale(std::string_view(name).substr(
                           name.find_last_of('/') + 1, name.size() - name.find_last_of('/') - 6)))
            throw std::runtime_error("Invalid localization chunk locale.");
        const auto contract = name == "i18n/project.yaml"       ? "WorkspaceLocalizationPolicy"
                              : name == "i18n/messages.yaml"    ? "WorkspaceLocalizationMessages"
                              : name == "i18n/usage-notes.yaml" ? "WorkspaceLocalizationUsageNotes"
                              : name == "i18n/tracking.yaml"    ? "WorkspaceLocalizationTracking"
                              : name == "i18n/orphans.yaml"     ? "WorkspaceLocalizationOrphans"
                              : name.starts_with("i18n/locales/") ? "WorkspaceLocalizationLocale"
                                                                  : "WorkspaceLocalizationAssets";
        const auto path = project_root / name;
        auto bytes = read_bytes(path);
        const auto opened = open_yaml_source(bytes);
        if (!opened.accepted)
            throw std::runtime_error("Invalid localization YAML: " + opened.error);
        auto result = std::unique_ptr<RoomSession>(
            new RoomSession(path, "", std::move(bytes), opened.source_json));
        result->is_localization_ = true;
        result->validation_contract_ = contract;
        if (!result->snapshot().valid)
            throw std::runtime_error("Invalid localization source: " + name);
        error.clear();
        return result;
    } catch (const std::exception& exception) {
        error = exception.what();
        return nullptr;
    }
}

std::unique_ptr<ProjectSession> ProjectSession::open(const std::filesystem::path& root,
                                                     std::string& error)
{
    return open_impl(root, error, false);
}

// Read-only validation of an inadmissible manifest. Mutable Project sessions
// still require an entirely valid manifest and must never use this fallback.
static std::vector<Diagnostic> invalid_manifest_diagnostics(const std::filesystem::path& root)
{
    const auto source = open_yaml_source(read_bytes(root / "project.yaml"));
    if (!source.accepted) {
        Diagnostic issue{"/", "source.project", "Invalid Project manifest YAML: " + source.error};
        issue.source_path = "project.yaml";
        return {std::move(issue)};
    }
    const auto semantic = validate_record("WorkspaceManifest", source.source_json);
    if (semantic.accepted)
        return {};
    auto issues = semantic.diagnostics;
    if (issues.empty())
        issues.push_back({"/", "source.project", "Invalid Project manifest schema."});
    for (auto& issue : issues)
        issue.source_path = "project.yaml";
    return issues;
}

std::optional<RoomSessionSnapshot>
ProjectSession::validate_cold_project(const std::filesystem::path& root, std::string& error)
{
    auto project = open_impl(root, error, true);
    if (!project) {
        try {
            RoomSessionSnapshot invalid;
            invalid.diagnostics = invalid_manifest_diagnostics(root);
            if (!invalid.diagnostics.empty()) {
                invalid.valid = false;
                error.clear();
                return invalid;
            }
        } catch (const std::exception&) {
            // Missing/unreadable manifest or source authority is still a
            // transport/admission failure, not a fabricated parsed result.
        }
        return std::nullopt;
    }
    return project->validate_project();
}

std::unique_ptr<ProjectSession> ProjectSession::open_impl(const std::filesystem::path& root,
                                                          std::string& error, bool validation_only)
{
    auto source = RoomSession::open_project_source(root, error, validation_only);
    if (!source)
        return nullptr;
    try {
        auto authority = std::make_unique<SourceAuthority>(root);
        if (!authority->initialize(error, validation_only))
            return nullptr;
        auto traits = RoomSession::open_traits_source(root, error);
        if (!traits && !validation_only)
            return nullptr;
        if (!RoomSession::open_editor_source(root, error) && !validation_only)
            return nullptr;
        // Check tracked source validity at Project admission, but keep their
        // working sessions lazy: opening a Project must not publish untouched
        // owners or change the worker's initial record-snapshot contract.
        auto project = std::unique_ptr<ProjectSession>(
            new ProjectSession(std::move(source), std::move(authority), root,
                               traits ? traits->snapshot().normalized_json : std::string{}));
        for (const auto& file : project->file_inventory()) {
            if (!analyzable_text_path(file.path) ||
                (file.kind != ProjectFileKind::ProjectSource &&
                 !(file.kind == ProjectFileKind::TrackedSource &&
                   file.path.starts_with("records/layouts/"))))
                continue;
            project->text_source_paths_.insert(file.path);
            project->text_disk_revisions_.emplace(
                file.path, exact_source_revision(read_bytes(root / file.path)));
        }
        for (const auto& file : project->file_inventory()) {
            if (file.kind != ProjectFileKind::TrackedSource || !file.path.ends_with(".yaml") ||
                (!file.path.starts_with("records/scripts/") &&
                 !file.path.starts_with("records/layouts/") &&
                 !file.path.starts_with("records/rooms/") &&
                 !file.path.starts_with("records/scenes/") &&
                 !file.path.starts_with("records/dialogues/") &&
                 !file.path.starts_with("records/verbs/") &&
                 !file.path.starts_with("records/interactions/") &&
                 !file.path.starts_with("records/maps/")))
                continue;
            const auto parsed = open_yaml_source(read_bytes(root / file.path));
            if (!parsed.accepted)
                continue;
            const auto source = Json::parse(parsed.source_json);
            if (source.is_object() && source.contains("id") && source.at("id").is_string()) {
                const auto suffix = file.path.substr(sizeof("records/") - 1);
                const auto slash = suffix.find('/');
                if (slash == std::string::npos)
                    continue;
                project->index_text_owner(suffix.substr(0, slash + 1) +
                                              source.at("id").as<std::string>(),
                                          parsed.source_json);
            }
        }
        project->localization_cache_ = validate_project_localization(root);
        if (project->localization_cache_->accepted) {
            const auto effective = Json::parse(project->localization_cache_->effective_json);
            if (!effective.at("sourceLocaleLock").is_null())
                project->localization_source_lock_ =
                    effective.at("sourceLocaleLock").as<std::string>();
        }
        error.clear();
        return project;
    } catch (const std::exception& e) {
        error = e.what();
        return nullptr;
    }
}

RoomSessionSnapshot ProjectSession::validate_project()
{
    // A malformed on-disk manifest can revoke SourceAuthority before the
    // watcher can emit a usable project.yaml revision. Inspect this one
    // immutable owner first so cold and resident diagnostic readers report
    // the same concrete parse/schema error, not a generic watcher failure.
    if (!source_->snapshot().dirty) {
        try {
            auto issues = invalid_manifest_diagnostics(root_);
            if (!issues.empty()) {
                auto result = source_->snapshot();
                result.valid = false;
                result.diagnostics = std::move(issues);
                validation_snapshot_.reset();
                validation_pending_uncertain_ = true;
                return result;
            }
        } catch (const std::exception&) {
            // Preserve normal authority diagnostics for inaccessible files.
        }
    }
    // Physical observation is a proof, not merely an event hint. In particular,
    // a failed observation must never authorize an old semantic contribution.
    const auto observation = observe_sources();
    validation_work_ = {};
    validation_invalidated_owners_.clear();
    if (validation_snapshot_ &&
        source_->snapshot().source_json != validation_snapshot_->source_json)
        validation_invalidated_owners_.insert("project");
    std::set<std::string> presentation_only_updates;
    std::string invalid_manifest;
    if (validation_pending_source_revisions_.contains("project.yaml")) {
        if (source_->snapshot().dirty) {
            invalid_manifest = "Project manifest changed on disk while local edits are pending.";
        } else {
            const auto reconciled = source_->reconcile_disk();
            if (reconciled.accepted) {
                if (!reconciled.affected_records.empty())
                    ++working_revision_;
                validation_invalidated_owners_.insert("project");
            } else {
                invalid_manifest = reconciled.error;
            }
        }
    }
    // A malformed Manifest cannot supply a valid dependency graph. Do not
    // report hundreds of spurious Scene/Verb/Dialogue dependency errors
    // against the last admitted Manifest; the cold diagnostic reader cannot
    // (and must not) construct a mutable Project from that invalid source.
    if (!invalid_manifest.empty() || !source_->snapshot().valid) {
        auto result = source_->snapshot();
        result.valid = false;
        try {
            auto issues = invalid_manifest_diagnostics(root_);
            if (!issues.empty())
                result.diagnostics = std::move(issues);
        } catch (const std::exception&) {
            if (!invalid_manifest.empty()) {
                Diagnostic issue{"/", "source.project", std::move(invalid_manifest)};
                issue.source_path = "project.yaml";
                result.diagnostics = {std::move(issue)};
            }
        }
        validation_snapshot_.reset();
        return result;
    }
    if (validation_source_paths_.empty()) {
        for (const auto& file : file_inventory())
            if (file.kind == ProjectFileKind::TrackedSource && file.path.ends_with(".yaml") &&
                file.path != "project.yaml")
                validation_source_paths_.insert(file.path);
        for (const auto* required :
             {"traits.yaml", "editor.yaml", "i18n/project.yaml", "i18n/messages.yaml",
              "i18n/usage-notes.yaml", "i18n/tracking.yaml", "i18n/orphans.yaml"})
            validation_source_paths_.insert(required);
    }
    for (const auto& path : observation.delta.added)
        if (path.ends_with(".yaml") && (tracked_fragment(path) || path.starts_with("records/")))
            validation_source_paths_.insert(path);
    // Optional locale chunks and collection records are directory members:
    // their removal deletes a contributor. Required fixed sources, by
    // contrast, must remain present and produce an attributable error.
    for (const auto& [path, revision] : validation_pending_source_revisions_) {
        if (revision != "absent" || !path.ends_with(".yaml"))
            continue;
        if (path.starts_with("i18n/locales/") || path.starts_with("i18n/assets/")) {
            validation_source_paths_.erase(path);
            validation_records_.erase(path);
            validation_source_revisions_.erase(path);
            validation_source_errors_.erase(path);
            validation_contributions_.erase(path);
            validation_invalidated_owners_.insert(path);
        } else if (path.starts_with("records/")) {
            const auto name = path.substr(sizeof("records/") - 1);
            const auto slash = name.find('/');
            if (slash == std::string::npos)
                continue;
            const auto family = name.substr(0, slash);
            const auto file = name.substr(slash + 1);
            if (!record_contracts().contains(family))
                continue;
            std::string owner;
            if (family == "layouts" && file.ends_with("/layout.yaml"))
                owner = family + "/" + file.substr(0, file.size() - 12);
            else if (family != "layouts" && file.ends_with(".yaml"))
                owner = family + "/" + file.substr(0, file.size() - 5);
            if (owner.empty())
                continue;
            validation_source_paths_.erase(path);
            validation_records_.erase(owner);
            validation_source_revisions_.erase(path);
            validation_source_errors_.erase(path);
            validation_contributions_.erase(owner);
            validation_invalidated_owners_.insert(owner);
            index_text_owner(owner, "{}");
        }
    }
    for (const auto& [path, revision] : validation_pending_source_revisions_)
        if (revision != "absent" && path.ends_with(".yaml") &&
            (tracked_fragment(path) || path.starts_with("records/")))
            validation_source_paths_.insert(path);

    bool changed =
        !validation_snapshot_ || (!observation.authoritative && !observation.scoped_authority) ||
        validation_pending_uncertain_ ||
        (validation_snapshot_ && validation_snapshot_->working_revision != working_revision_) ||
        !validation_pending_source_revisions_.empty() ||
        validation_shader_overlays_ != shader_overlays_;
    for (const auto& path : validation_source_paths_) {
        std::string owner;
        if (path == "editor.yaml")
            owner = "editor";
        else if (path == "traits.yaml")
            owner = "traits";
        else if (path.starts_with("i18n/"))
            owner = path;
        else if (path.starts_with("records/")) {
            const auto rest = path.substr(sizeof("records/") - 1);
            const auto separator = rest.find('/');
            if (separator == std::string::npos)
                continue;
            const auto family = rest.substr(0, separator);
            const auto filename = rest.substr(separator + 1);
            if (!record_contracts().contains(family))
                continue;
            if (family == "layouts") {
                if (!filename.ends_with("/layout.yaml"))
                    continue;
                owner = family + "/" + filename.substr(0, filename.size() - 12);
            } else {
                if (!filename.ends_with(".yaml") || filename.find('/') != std::string::npos)
                    continue;
                owner = family + "/" + filename.substr(0, filename.size() - 5);
            }
        } else
            continue;

        const auto working = records_.find(owner);
        const auto saved = validation_source_revisions_.find(path);
        const auto revision = validation_pending_source_revisions_.find(path);
        // An inspected editor owner may be clean yet older than disk. Absence
        // of a *new* watcher delta does not make its old revision current: a
        // prior validation may already have consumed that delta. In that case
        // validate the physical record, not the stale editor snapshot.
        const bool inspected_matches_disk = working != records_.end() &&
                                            std::filesystem::is_regular_file(root_ / path) &&
                                            exact_source_revision(read_bytes(root_ / path)) ==
                                                working->second->snapshot().disk_source_revision;
        const bool physically_changed =
            saved == validation_source_revisions_.end() ||
            revision != validation_pending_source_revisions_.end() ||
            (!observation.authoritative && !observation.scoped_authority);
        // A clean editor owner whose physical baseline was superseded must
        // not keep invalidating an already validated disk contributor. Dirty
        // owners still participate, so disk/working conflicts remain visible.
        const bool working_changed =
            working != records_.end() &&
            (inspected_matches_disk || working->second->snapshot().dirty) &&
            (!validation_records_.contains(owner) ||
             working->second->snapshot().source_json !=
                 validation_records_.at(owner)->snapshot().source_json);
        if (!physically_changed && !working_changed) {
            ++validation_work_.retained_records;
            continue;
        }
        changed = true;
        ++validation_work_.rechecked_records;
        validation_invalidated_owners_.insert(owner);
        const auto previous_record = validation_records_.find(owner);
        const auto previous_normalized = previous_record == validation_records_.end()
                                             ? std::string{}
                                             : previous_record->second->snapshot().normalized_json;
        validation_records_.erase(owner);
        validation_source_errors_.erase(path);
        validation_source_revisions_.erase(path);

        // A dirty editor owner is the semantic input, but its saved bytes must
        // still be attributable to the current physical source.
        if (working != records_.end() && inspected_matches_disk &&
            (observation.authoritative || observation.scoped_authority) &&
            (revision == validation_pending_source_revisions_.end() ||
             revision->second == working->second->snapshot().disk_source_revision)) {
            validation_records_.emplace(owner, working->second->clone());
            validation_source_revisions_.emplace(path,
                                                 working->second->snapshot().disk_source_revision);
            continue;
        }
        if (working != records_.end() && working->second->snapshot().dirty) {
            Diagnostic issue{
                "/" + pointer_token(owner), "source.conflict",
                "Dirty Project owner has changed on disk; reconcile before validation."};
            issue.source_path = path;
            validation_source_errors_.emplace(path, std::move(issue));
            index_text_owner(owner, "{}");
            continue;
        }
        std::string error;
        std::unique_ptr<RoomSession> record;
        if (!std::filesystem::is_regular_file(root_ / path))
            error = "Tracked Project source is missing.";
        else if (owner == "editor")
            record = RoomSession::open_editor_source(root_, error);
        else if (owner == "traits")
            record = RoomSession::open_traits_source(root_, error);
        else if (owner.starts_with("i18n/"))
            record = RoomSession::open_localization_source(root_, owner, error);
        else {
            const auto slash = owner.find('/');
            record = RoomSession::open_record(root_, owner.substr(0, slash),
                                              owner.substr(slash + 1), error);
        }
        if (record) {
            const auto admitted = record->snapshot();
            if (owner == "traits" && !admitted.dirty)
                traits_baseline_json_ = admitted.normalized_json;
            validation_source_revisions_.emplace(path, admitted.disk_source_revision);
            validation_records_.emplace(owner, std::move(record));
            if (!previous_normalized.empty() && !admitted.normalized_json.empty()) {
                auto before = Json::parse(previous_normalized);
                auto after = Json::parse(admitted.normalized_json);
                if (before.is_object() && after.is_object()) {
                    before.erase("label");
                    before.erase("description");
                    after.erase("label");
                    after.erase("description");
                    if (before == after)
                        presentation_only_updates.insert(owner);
                }
            }
            if (indexed_text_owner(owner))
                index_text_owner(owner, admitted.source_json);
            if (owner.starts_with("assets/"))
                reindex_asset_consumers(owner.substr(sizeof("assets/") - 1));
        } else {
            if (owner == "traits")
                traits_baseline_json_.clear();
            index_text_owner(owner, "{}");
            Diagnostic issue{"/" + pointer_token(owner), "source.yaml",
                             error.empty() ? "Invalid tracked Project source." : error};
            issue.source_path = path;
            validation_source_errors_.emplace(path, std::move(issue));
            // An invalid source still has a certified physical identity. Retain
            // that identity with its diagnostic proof, never with normalized
            // contents, so the next unchanged validation can reuse the error.
            if (observation.authoritative || observation.scoped_authority) {
                if (revision != validation_pending_source_revisions_.end())
                    validation_source_revisions_.emplace(path, revision->second);
                else if (std::filesystem::is_regular_file(root_ / path))
                    validation_source_revisions_.emplace(
                        path, exact_source_revision(read_bytes(root_ / path)));
                else
                    validation_source_revisions_.emplace(path, "absent");
            }
        }
    }
    if (!changed && (observation.authoritative || observation.scoped_authority))
        return *validation_snapshot_;

    const auto changed_physical = [&](const std::string& path) {
        if (const auto consumers = text_source_owners_.find(path);
            consumers != text_source_owners_.end())
            validation_invalidated_owners_.insert(consumers->second.begin(),
                                                  consumers->second.end());
        if (!path.ends_with(".yaml")) {
            const std::set<std::string> path_value{path};
            for (const auto& [owner, record] : validation_records_) {
                if ((owner.starts_with("assets/") || owner.starts_with("materials/")) &&
                    references_any(Json::parse(record->snapshot().source_json), path_value))
                    validation_invalidated_owners_.insert(owner);
            }
        }
    };
    for (const auto& [path, revision] : validation_pending_source_revisions_)
        changed_physical(path);
    for (const auto& [path, content] : shader_overlays_) {
        const auto previous = validation_shader_overlays_.find(path);
        if (previous == validation_shader_overlays_.end() || previous->second != content)
            changed_physical(path);
    }
    for (const auto& [path, content] : validation_shader_overlays_)
        if (!shader_overlays_.contains(path))
            changed_physical(path);

    // A record can refer to another record without itself being edited.
    // Follow references transitively, retaining unrelated local contributions.
    // This is conservative for ordinary string IDs, but never promotes stale
    // cross-record validation after a referenced definition changes.
    if (validation_invalidated_owners_.contains("project") ||
        validation_invalidated_owners_.contains("traits")) {
        for (const auto& [owner, record] : validation_records_)
            validation_invalidated_owners_.insert(owner);
    } else {
        std::set<std::string> affected_ids;
        for (const auto& owner : validation_invalidated_owners_) {
            if (presentation_only_updates.contains(owner))
                continue;
            const auto slash = owner.find('/');
            if (slash != std::string::npos && !owner.starts_with("i18n/"))
                affected_ids.insert(owner.substr(slash + 1));
        }
        bool discovered = true;
        while (discovered) {
            discovered = false;
            for (const auto& [owner, record] : validation_records_) {
                if (validation_invalidated_owners_.contains(owner))
                    continue;
                const auto normalized = record->snapshot().normalized_json;
                if (normalized.empty() || !references_any(Json::parse(normalized), affected_ids))
                    continue;
                validation_invalidated_owners_.insert(owner);
                const auto slash = owner.find('/');
                if (slash != std::string::npos && !owner.starts_with("i18n/"))
                    affected_ids.insert(owner.substr(slash + 1));
                discovered = true;
            }
        }
    }
    if (!observation.authoritative && !observation.scoped_authority)
        validation_contributions_.clear();
    for (auto it = validation_contributions_.begin(); it != validation_contributions_.end();) {
        if (!validation_records_.contains(it->first))
            it = validation_contributions_.erase(it);
        else
            ++it;
    }

    // No mutation or graph result is published to the editor's lazy owner map.
    // The full working view is only active during this synchronous validation.
    struct ScopedView {
        bool& active;
        explicit ScopedView(bool& flag) : active(flag) { active = true; }
        ~ScopedView() { active = false; }
    } view(validation_view_active_);
    auto result = snapshot();
    if (!invalid_manifest.empty()) {
        try {
            auto issues = invalid_manifest_diagnostics(root_);
            if (!issues.empty())
                result.diagnostics.insert(result.diagnostics.end(), issues.begin(), issues.end());
            else {
                Diagnostic issue{"/", "source.project", std::move(invalid_manifest)};
                issue.source_path = "project.yaml";
                result.diagnostics.push_back(std::move(issue));
            }
        } catch (const std::exception&) {
            Diagnostic issue{"/", "source.project", std::move(invalid_manifest)};
            issue.source_path = "project.yaml";
            result.diagnostics.push_back(std::move(issue));
        }
        result.valid = false;
    }
    if (!observation.authoritative && !observation.scoped_authority) {
        Diagnostic issue{"/", "source.authority",
                         observation.error.empty() ? "Project source evidence is not authoritative."
                                                   : observation.error};
        result.diagnostics.push_back(std::move(issue));
        result.valid = false;
    }
    for (const auto& [path, issue] : validation_source_errors_) {
        result.valid = false;
        result.diagnostics.push_back(issue);
    }
    // Source analyses must also fail closed when a declared physical Lua/RML
    // source is no longer part of the admitted source graph.
    for (const auto& [path, owners] : text_source_owners_) {
        if (path.starts_with("inline/") || text_source_paths_.contains(path))
            continue;
        for (const auto& owner : owners) {
            Diagnostic issue{source_diagnostic_owner(path, owner),
                             "authoring.lua.external_source_unresolved",
                             "Declared Project text source is missing."};
            issue.source_path = path;
            result.diagnostics.push_back(std::move(issue));
            result.valid = false;
        }
    }
    // The Room/Map/Hotspot validator consumes the complete normalized
    // membership graph, not just records an editor happened to inspect.
    if (!result.normalized_json.empty()) {
        const bool spatial_changed =
            !validation_room_map_cache_ || validation_invalidated_owners_.contains("project") ||
            std::any_of(
                validation_invalidated_owners_.begin(), validation_invalidated_owners_.end(),
                [&](const std::string& owner) {
                    return !presentation_only_updates.contains(owner) &&
                           (owner.starts_with("rooms/") || owner.starts_with("maps/") ||
                            owner.starts_with("interactables/") ||
                            owner.starts_with("characters/") || owner.starts_with("assets/") ||
                            owner.starts_with("animations/") || owner.starts_with("materials/") ||
                            owner.starts_with("layouts/") || owner.starts_with("variables/"));
                });
        if (spatial_changed) {
            Json complete = Json::parse(result.normalized_json);
            for (const auto& [owner, record] : validation_records_) {
                const auto slash = owner.find('/');
                if (slash == std::string::npos || owner.starts_with("i18n/"))
                    continue;
                const auto normalized = record->snapshot().normalized_json;
                if (normalized.empty())
                    continue;
                const auto family = owner.substr(0, slash);
                if (!complete.contains(family))
                    complete[family] = Json::object();
                complete[family].insert_or_assign(owner.substr(slash + 1), Json::parse(normalized));
            }
            validation_room_map_cache_ = validate_room_map_project(complete.to_string());
        }
        for (const auto& issue : validation_room_map_cache_->diagnostics) {
            const bool duplicate = std::any_of(result.diagnostics.begin(), result.diagnostics.end(),
                                               [&](const Diagnostic& previous) {
                                                   return issue.code == previous.code &&
                                                          issue.path == previous.path &&
                                                          issue.severity == previous.severity;
                                               });
            if (!duplicate)
                result.diagnostics.push_back(issue);
            if (issue.severity == "error")
                result.valid = false;
        }
    }
    // Attach navigation to the actual YAML owner, not to the last edited
    // source or an arbitrary dependency. For normalized paths, use the nearest
    // existing source ancestor (for instance /$ref/id maps to a bare YAML ID).
    std::map<std::string, std::vector<YamlSourceLocation>> locations;
    for (auto& issue : result.diagnostics) {
        std::string owner;
        if (issue.path.starts_with("/")) {
            const auto slash = issue.path.find('/', 1);
            const auto family = issue.path.substr(1, slash - 1);
            if (record_contracts().contains(family) && slash != std::string::npos) {
                const auto end = issue.path.find('/', slash + 1);
                owner =
                    issue.path.substr(1, end == std::string::npos ? std::string::npos : end - 1);
            } else if (family == "traits" || family == "editor")
                owner = family;
        }
        const auto record = validation_records_.find(owner);
        if (record == validation_records_.end()) {
            if (issue.source_path.empty()) {
                if (issue.path.starts_with("/localization/"))
                    issue.source_path = "i18n/project.yaml";
                else
                    issue.source_path = "project.yaml";
            }
            continue;
        }
        const auto source_path =
            record->second->source_path().lexically_relative(root_).generic_string();
        if (issue.source_path.empty())
            issue.source_path = source_path;
        if (issue.source_path != source_path || issue.line || issue.column ||
            record->second->snapshot().dirty)
            continue;
        if (!locations.contains(owner))
            locations.emplace(owner, open_yaml_source(record->second->disk_source_).locations);
        std::string pointer = issue.path.substr(owner.size() + 1);
        for (;;) {
            const auto found = std::find_if(
                locations.at(owner).begin(), locations.at(owner).end(),
                [&](const YamlSourceLocation& location) { return location.path == pointer; });
            if (found != locations.at(owner).end()) {
                if (found->line) {
                    issue.line = found->line;
                    issue.column = found->column;
                }
                break;
            }
            if (pointer.empty())
                break;
            const auto split = pointer.rfind('/');
            pointer = split == std::string::npos ? "" : pointer.substr(0, split);
        }
    }
    // Validation can be expensive for a cold Project. Confirm that its input
    // authority did not advance while we were building the diagnostic set.
    const auto final_observation = observe_sources();
    if (final_observation.full_rescan ||
        (!final_observation.authoritative && !final_observation.scoped_authority)) {
        result.valid = false;
        result.diagnostics.push_back(
            {"/", "source.authority", "Project source authority was lost during validation."});
    } else if (!final_observation.delta_revisions.empty()) {
        result.valid = false;
        result.diagnostics.push_back(
            {"/", "source.revision", "Project sources changed during validation; retry."});
    }
    if (final_observation.full_rescan ||
        (!final_observation.authoritative && !final_observation.scoped_authority) ||
        !final_observation.delta_revisions.empty()) {
        if (final_observation.full_rescan ||
            (!final_observation.authoritative && !final_observation.scoped_authority))
            result.diagnostics.back().source_path = "project.yaml";
        else if (!final_observation.delta_revisions.empty())
            result.diagnostics.back().source_path = "project.yaml";
        validation_snapshot_.reset();
        return result;
    }
    validation_snapshot_ = result;
    validation_shader_overlays_ = shader_overlays_;
    validation_pending_source_revisions_.clear();
    validation_pending_uncertain_ = false;
    return result;
}

RoomSessionSnapshot ProjectSession::snapshot() const
{
    // Validation must see every admitted record; ordinary editor snapshots
    // intentionally expose only records opened or changed by the editor.
    const auto& records_ = validation_view_active_ ? validation_records_ : this->records_;
    auto state = source_->snapshot();
    const bool manifest_dirty = state.dirty;
    state.working_revision = working_revision_;
    state.dirty |= !shader_overlays_.empty();
    state.dirty |= !text_source_overlays_.empty();
    const auto trait_owner = records_.find("traits");
    const auto traits_json = trait_owner == records_.end()
                                 ? traits_baseline_json_
                                 : trait_owner->second->snapshot().normalized_json;
    // Load only a referenced Variable, never reconstruct the complete Project.
    // Inspected working owners take precedence over their disk sources.
    std::map<std::string, std::optional<std::string>> referenced_variables;
    const VariableResolver resolve_variable =
        [&](std::string_view id) -> std::optional<std::string> {
        const auto key = std::string(id);
        if (const auto cached = referenced_variables.find(key);
            cached != referenced_variables.end())
            return cached->second;
        std::optional<std::string> value;
        if (const auto edited = records_.find("variables/" + key); edited != records_.end()) {
            const auto record = edited->second->snapshot();
            if (record.valid)
                value = record.normalized_json;
        } else if (is_id(key)) {
            std::string error;
            auto record = RoomSession::open_record(root_, "variables", key, error);
            if (record) {
                const auto snapshot = record->snapshot();
                if (snapshot.valid)
                    value = snapshot.normalized_json;
            }
        }
        referenced_variables.emplace(key, value);
        return value;
    };
    std::map<std::string, std::optional<std::string>> referenced_records;
    const AuthoringRecordResolver resolve_record =
        [&](std::string_view family, std::string_view id) -> std::optional<std::string> {
        const auto owner = std::string(family) + "/" + std::string(id);
        if (const auto found = referenced_records.find(owner); found != referenced_records.end())
            return found->second;
        std::optional<std::string> value;
        if (const auto edited = records_.find(owner); edited != records_.end()) {
            const auto record = edited->second->snapshot();
            if (record.valid)
                value = record.normalized_json;
            else if (family == "assets") {
                const auto structural = validate_asset_source(record.source_json);
                if (structural.accepted)
                    value = structural.effective_json;
            } else
                value = character_reference_resource_source(family, record.source_json,
                                                            record.diagnostics);
        } else if (record_contracts().contains(std::string(family)) && is_id(id)) {
            std::string error;
            auto record =
                RoomSession::open_record(root_, std::string(family), std::string(id), error);
            if (record) {
                const auto snapshot = record->snapshot();
                if (snapshot.valid)
                    value = snapshot.normalized_json;
                else if (family == "assets") {
                    const auto structural = validate_asset_source(snapshot.source_json);
                    if (structural.accepted)
                        value = structural.effective_json;
                } else
                    value = character_reference_resource_source(family, snapshot.source_json,
                                                                snapshot.diagnostics);
            }
        }
        referenced_records.emplace(owner, value);
        return value;
    };
    for (const auto& [owner, session] : records_) {
        if (validation_view_active_ && !validation_invalidated_owners_.contains(owner)) {
            if (const auto prior = validation_contributions_.find(owner);
                prior != validation_contributions_.end()) {
                ++validation_work_.retained_contributions;
                state.dirty |= prior->second.dirty;
                state.valid &= prior->second.valid;
                state.diagnostics.insert(state.diagnostics.end(), prior->second.diagnostics.begin(),
                                         prior->second.diagnostics.end());
                continue;
            }
        }
        if (validation_view_active_)
            ++validation_work_.rechecked_contributions;
        const auto owner_diagnostic_start = state.diagnostics.size();
        const bool preceding_valid = state.valid;
        state.valid = true;
        const auto record = session->snapshot();
        state.dirty |= record.dirty;
        state.valid &= record.valid;
        for (auto diagnostic : record.diagnostics) {
            diagnostic.path = "/" + owner + diagnostic.path;
            state.diagnostics.push_back(std::move(diagnostic));
        }
        const auto slash = owner.find('/');
        const auto family = owner.substr(0, slash);
        if (record.valid && family == "animations") {
            const auto dependencies =
                validate_animation_dependencies(record.normalized_json, resolve_record);
            state.valid &= dependencies.accepted;
            for (auto diagnostic : dependencies.diagnostics) {
                diagnostic.path = "/" + owner + diagnostic.path;
                state.diagnostics.push_back(std::move(diagnostic));
            }
        }
        if (record.valid && family == "materials") {
            const auto material = resolve_material(owner.substr(slash + 1), record.normalized_json,
                                                   resolve_record, root_, shader_overlays_);
            state.valid &= material.accepted;
            for (auto diagnostic : material.diagnostics) {
                diagnostic.path = "/" + owner + diagnostic.path;
                state.diagnostics.push_back(std::move(diagnostic));
            }
            if (const auto compiled = material_compiler_results_.find(owner.substr(slash + 1));
                compiled != material_compiler_results_.end()) {
                state.valid &= compiled->second.accepted;
                state.diagnostics.insert(state.diagnostics.end(),
                                         compiled->second.diagnostics.begin(),
                                         compiled->second.diagnostics.end());
            }
        }
        if (record.valid && (family == "dialogues" || family == "scenes")) {
            const auto entrypoint = validate_dialogue_scene_entrypoint(
                family, record.normalized_json, state.normalized_json);
            state.valid &= entrypoint.accepted;
            for (auto diagnostic : entrypoint.diagnostics) {
                diagnostic.path = "/" + owner + diagnostic.path;
                state.diagnostics.push_back(std::move(diagnostic));
            }
            const auto exists = [&](std::string_view collection, std::string_view id) {
                if (!is_id(id))
                    return false;
                if (collection == "interactableInstances") {
                    const auto project = Json::parse(state.normalized_json);
                    return project.contains("interactableInstances") &&
                           project.at("interactableInstances").contains(id);
                }
                if (!record_contracts().contains(std::string(collection)))
                    return false;
                const auto owner = std::string(collection) + "/" + std::string(id);
                if (records_.contains(owner))
                    return true;
                const auto file =
                    collection == "layouts"
                        ? root_ / "records" / "layouts" / std::string(id) / "layout.yaml"
                        : root_ / "records" / std::string(collection) / (std::string(id) + ".yaml");
                return std::filesystem::is_regular_file(file);
            };
            const auto dependent = validate_dialogue_scene_dependencies(
                family, record.normalized_json, resolve_record, exists);
            state.valid &= dependent.accepted;
            for (auto diagnostic : dependent.diagnostics) {
                diagnostic.path = "/" + owner + diagnostic.path;
                state.diagnostics.push_back(std::move(diagnostic));
            }
        }
        if (record.valid && (family == "verbs" || family == "interactions")) {
            const auto exists = [&](std::string_view collection, std::string_view id) {
                if (!is_id(id))
                    return false;
                if (collection == "interactableInstances") {
                    const auto project = Json::parse(state.normalized_json);
                    return project.contains("interactableInstances") &&
                           project.at("interactableInstances").contains(id);
                }
                if (!record_contracts().contains(std::string(collection)))
                    return false;
                const auto key = std::string(collection) + "/" + std::string(id);
                if (records_.contains(key))
                    return true;
                return std::filesystem::is_regular_file(
                    root_ / "records" / std::string(collection) / (std::string(id) + ".yaml"));
            };
            const auto dependent = validate_verb_interaction_dependencies(
                family, record.normalized_json, state.normalized_json, traits_json, resolve_record,
                exists);
            state.valid &= dependent.accepted;
            for (auto diagnostic : dependent.diagnostics) {
                diagnostic.path = "/" + owner + diagnostic.path;
                state.diagnostics.push_back(std::move(diagnostic));
            }
        }
        if (!record.normalized_json.empty() && family == "tests" &&
            !state.normalized_json.empty() && !traits_json.empty()) {
            const auto exists = [&](std::string_view collection, std::string_view id) {
                if (!is_id(id))
                    return false;
                const auto owner = std::string(collection) + "/" + std::string(id);
                if (collection == "layouts")
                    return records_.contains(owner) ||
                           std::filesystem::is_regular_file(root_ / "records" / "layouts" /
                                                            std::string(id) / "layout.yaml");
                return record_contracts().contains(std::string(collection)) &&
                       (records_.contains(owner) ||
                        std::filesystem::is_regular_file(root_ / "records" /
                                                         std::string(collection) /
                                                         (std::string(id) + ".yaml")));
            };
            const auto dependent = validate_test_dependencies(
                record.normalized_json, state.normalized_json, traits_json, resolve_record, exists);
            state.valid &= dependent.accepted;
            for (auto diagnostic : dependent.diagnostics) {
                diagnostic.path = "/" + owner + diagnostic.path;
                state.diagnostics.push_back(std::move(diagnostic));
            }
        }
        std::string effective_for_traits = record.normalized_json;
        if (record.valid && slash != std::string::npos &&
            (family == "rooms" || family == "characters" || family == "interactables" ||
             family == "archetypes")) {
            const auto record_value = Json::parse(record.normalized_json);
            if (family == "archetypes") {
                const auto semantic = validate_archetype_dependencies(
                    owner.substr(slash + 1), record.normalized_json, resolve_record);
                state.valid &= semantic.accepted;
                for (auto diagnostic : semantic.diagnostics) {
                    diagnostic.path = "/" + owner + diagnostic.path;
                    state.diagnostics.push_back(std::move(diagnostic));
                }
                if (!semantic.effective_json.empty() && !traits_json.empty()) {
                    const auto traits =
                        validate_reusable_trait_configuration(Json::parse(record.normalized_json)
                                                                  .at("data")
                                                                  .at("instanceKind")
                                                                  .as<std::string>(),
                                                              semantic.effective_json, traits_json);
                    state.valid &= traits.accepted;
                    for (auto diagnostic : traits.diagnostics) {
                        diagnostic.path =
                            "/" + owner + "/data/effectiveConfiguration" + diagnostic.path;
                        state.diagnostics.push_back(std::move(diagnostic));
                    }
                }
            } else {
                const auto semantic =
                    validate_archetype_owner(family, record.normalized_json, resolve_record);
                if (!semantic.effective_json.empty())
                    effective_for_traits = semantic.effective_json;
                state.valid &= semantic.accepted;
                for (auto diagnostic : semantic.diagnostics) {
                    diagnostic.path = "/" + owner + diagnostic.path;
                    state.diagnostics.push_back(std::move(diagnostic));
                }
                if (family == "characters") {
                    const auto effective = semantic.effective_json.empty()
                                               ? record.normalized_json
                                               : semantic.effective_json;
                    if (record_value.contains("archetype") &&
                        !record_value.at("archetype").is_null() && semantic.accepted) {
                        const auto local = validate_character_local(effective);
                        state.valid &= local.accepted;
                        for (auto diagnostic : local.diagnostics) {
                            diagnostic.path = "/" + owner + diagnostic.path;
                            state.diagnostics.push_back(std::move(diagnostic));
                        }
                    }
                    const auto references =
                        validate_character_dependencies(effective, resolve_record);
                    state.valid &= references.accepted;
                    for (auto diagnostic : references.diagnostics) {
                        diagnostic.path = "/" + owner + diagnostic.path;
                        state.diagnostics.push_back(std::move(diagnostic));
                    }
                } else if (family == "interactables") {
                    const auto local = validate_interactable_definition_local(effective_for_traits);
                    state.valid &= local.accepted;
                    for (auto diagnostic : local.diagnostics) {
                        diagnostic.path = "/" + owner + diagnostic.path;
                        state.diagnostics.push_back(std::move(diagnostic));
                    }
                }
            }
        }
        if (record.valid && slash != std::string::npos && !traits_json.empty()) {
            const auto semantic = validate_property_dependencies(family, effective_for_traits,
                                                                 traits_json, resolve_variable);
            state.valid &= semantic.accepted;
            for (auto diagnostic : semantic.diagnostics) {
                diagnostic.path = "/" + owner + diagnostic.path;
                state.diagnostics.push_back(std::move(diagnostic));
            }
        }
        if (validation_view_active_) {
            validation_contributions_.insert_or_assign(
                owner,
                ValidationContribution{state.valid,
                                       record.dirty,
                                       {state.diagnostics.begin() +
                                            static_cast<std::ptrdiff_t>(owner_diagnostic_start),
                                        state.diagnostics.end()}});
        }
        state.valid &= preceding_valid;
    }
    const bool traits_changed =
        trait_owner != records_.end() && trait_owner->second->snapshot().dirty;
    const bool variables_changed =
        std::any_of(records_.begin(), records_.end(), [](const auto& entry) {
            return entry.first.starts_with("variables/") && entry.second->snapshot().dirty;
        });
    std::set<std::string> changed_traits;
    std::set<std::string> changed_variables;
    if (traits_changed && !traits_json.empty()) {
        const auto before = Json::parse(traits_baseline_json_);
        const auto after = Json::parse(traits_json);
        for (const auto& entry : before.object_range())
            if (!after.contains(entry.key()) || after.at(entry.key()) != entry.value())
                changed_traits.insert(std::string(entry.key()));
        for (const auto& entry : after.object_range())
            if (!before.contains(entry.key()))
                changed_traits.insert(std::string(entry.key()));
    }
    if (variables_changed)
        for (const auto& [owner, record] : records_)
            if (owner.starts_with("variables/") && record->snapshot().dirty)
                changed_variables.insert(owner.substr(sizeof("variables/") - 1));
    std::set<std::string> affected_archetypes;
    if (!changed_traits.empty() || !changed_variables.empty()) {
        std::map<std::string, Json> archetype_sources;
        const auto directory = root_ / "records/archetypes";
        if (std::filesystem::is_directory(directory))
            for (const auto& file : std::filesystem::directory_iterator(directory))
                if (file.is_regular_file() && file.path().extension() == ".yaml") {
                    const auto id = file.path().stem().string();
                    const auto owner = "archetypes/" + id;
                    if (records_.contains(owner))
                        archetype_sources.emplace(
                            id, Json::parse(records_.at(owner)->snapshot().source_json));
                    else if (auto decoded = decoded_record(file.path()))
                        archetype_sources.emplace(id, std::move(*decoded));
                }
        // Follow inherited Archetype dependencies transitively so only the
        // consumers of edited Trait/Variable declarations need normalization.
        bool discovered = true;
        while (discovered) {
            discovered = false;
            for (const auto& [id, contents] : archetype_sources) {
                if (affected_archetypes.contains(id))
                    continue;
                const bool depends = references_any(contents, changed_traits) ||
                                     references_any(contents, changed_variables) ||
                                     references_any(contents, affected_archetypes);
                if (depends)
                    discovered |= affected_archetypes.insert(id).second;
            }
        }
    }
    // A dependency's working value can change even when none of its consumers
    // has been inspected. Resolve unopened owners lazily from their files,
    // without inserting them into the editor's working-owner inventory.
    if ((!changed_traits.empty() || !changed_variables.empty()) && !traits_json.empty()) {
        for (const auto* family : {"rooms", "characters", "interactables", "archetypes",
                                   "dialogues", "scenes", "verbs", "interactions"}) {
            const auto folder = root_ / "records" / family;
            if (!std::filesystem::is_directory(folder))
                continue;
            for (const auto& item : std::filesystem::directory_iterator(folder)) {
                if (!item.is_regular_file() || item.path().extension() != ".yaml")
                    continue;
                const auto id = item.path().stem().string();
                const auto owner = std::string(family) + "/" + id;
                if (!is_id(id) || records_.contains(owner))
                    continue;
                const auto decoded = decoded_record(item.path());
                if (!decoded || !(references_any(*decoded, changed_traits) ||
                                  references_any(*decoded, changed_variables) ||
                                  references_any(*decoded, affected_archetypes)))
                    continue;
                const auto saved = resolve_record(family, id);
                if (!saved)
                    continue;
                std::string effective = *saved;
                if (std::string_view(family) == "archetypes") {
                    const auto archetype =
                        validate_archetype_dependencies(id, *saved, resolve_record);
                    if (archetype.accepted && !archetype.effective_json.empty()) {
                        const auto kind =
                            Json::parse(*saved).at("data").at("instanceKind").as<std::string>();
                        const auto semantic = validate_reusable_trait_configuration(
                            kind, archetype.effective_json, traits_json);
                        state.valid &= semantic.accepted;
                        for (auto issue : semantic.diagnostics) {
                            issue.path = "/" + owner + "/data/effectiveConfiguration" + issue.path;
                            state.diagnostics.push_back(std::move(issue));
                        }
                    }
                    continue;
                }
                if (std::string_view(family) == "rooms" ||
                    std::string_view(family) == "characters" ||
                    std::string_view(family) == "interactables") {
                    const auto inherited = validate_archetype_owner(family, *saved, resolve_record);
                    if (inherited.accepted && !inherited.effective_json.empty())
                        effective = inherited.effective_json;
                }
                const auto semantic = validate_property_dependencies(family, effective, traits_json,
                                                                     resolve_variable);
                state.valid &= semantic.accepted;
                for (auto issue : semantic.diagnostics) {
                    issue.path = "/" + owner + issue.path;
                    state.diagnostics.push_back(std::move(issue));
                }
            }
        }
    }
    // The Manifest-owned fallback uses the same program rules as Verb and
    // Interaction records, with Manifest-relative diagnostics.
    if (!state.normalized_json.empty() && !traits_json.empty()) {
        const auto exists = [&](std::string_view family, std::string_view id) {
            if (!is_id(id) || !record_contracts().contains(std::string(family)))
                return false;
            const auto owner = std::string(family) + "/" + std::string(id);
            return records_.contains(owner) ||
                   std::filesystem::is_regular_file(root_ / "records" / std::string(family) /
                                                    (std::string(id) + ".yaml"));
        };
        const auto fallback = validate_project_interaction_program(
            state.normalized_json, traits_json, resolve_record, exists);
        state.valid &= fallback.accepted;
        state.diagnostics.insert(state.diagnostics.end(), fallback.diagnostics.begin(),
                                 fallback.diagnostics.end());
    }
    // An edited Verb can invalidate a Rule in a different (uninspected) source.
    // Inspect the dependency closure without adding those sources to the editor's
    // working-session owner list or publishing unrelated record snapshots.
    const bool inspecting_resolver =
        std::any_of(records_.begin(), records_.end(), [](const auto& entry) {
            return entry.first.starts_with("verbs/") || entry.first.starts_with("interactions/");
        });
    // A quantity, location, or presentation change does not alter the
    // static subject/Feature lookup closure. Do not traverse every authored
    // Interaction for those high-frequency Inventory edits.
    bool changed_subjects = false;
    if (manifest_dirty && !state.normalized_json.empty() && !state.baseline_json.empty()) {
        const auto current = Json::parse(state.normalized_json).at("interactableInstances");
        const auto baseline = Json::parse(state.baseline_json).at("interactableInstances");
        changed_subjects = current.size() != baseline.size();
        if (!changed_subjects)
            for (const auto& entry : current.object_range()) {
                if (!baseline.contains(entry.key()) ||
                    entry.value().at("definition") != baseline.at(entry.key()).at("definition")) {
                    changed_subjects = true;
                    break;
                }
            }
    }
    const bool changed_features =
        std::any_of(records_.begin(), records_.end(), [](const auto& entry) {
            if (entry.first != "traits" && !entry.first.starts_with("rooms/") &&
                !entry.first.starts_with("interactables/"))
                return false;
            const auto record = entry.second->snapshot();
            if (!record.dirty)
                return false;
            if (record.normalized_json.empty() || record.baseline_json.empty())
                return true;
            const auto before = Json::parse(record.baseline_json);
            const auto after = Json::parse(record.normalized_json);
            if (entry.first == "traits") {
                if (before.size() != after.size())
                    return true;
                for (const auto& trait : after.object_range())
                    if (!before.contains(trait.key()))
                        return true;
                return false;
            }
            const auto* old_features =
                before.contains("data") && before.at("data").contains("features")
                    ? &before.at("data").at("features")
                    : nullptr;
            const auto* new_features =
                after.contains("data") && after.at("data").contains("features")
                    ? &after.at("data").at("features")
                    : nullptr;
            if ((old_features == nullptr) != (new_features == nullptr))
                return true;
            if (!old_features)
                return false;
            const auto collect_ids = [](const Json& features) {
                std::set<std::string> ids;
                for (const auto& feature : features.array_range())
                    ids.insert(feature.at("id").as<std::string>());
                return ids;
            };
            return collect_ids(*old_features) != collect_ids(*new_features);
        });
    const bool changed_variable_types =
        std::any_of(records_.begin(), records_.end(), [](const auto& entry) {
            if (!entry.first.starts_with("variables/"))
                return false;
            const auto record = entry.second->snapshot();
            if (!record.dirty)
                return false;
            if (record.normalized_json.empty() || record.baseline_json.empty())
                return true;
            const auto prior_record = Json::parse(record.baseline_json);
            const auto next_record = Json::parse(record.normalized_json);
            const auto& before = prior_record.at("data");
            const auto& after = next_record.at("data");
            for (const auto* key : {"type", "nullable", "enumValues"})
                if (before.contains(key) != after.contains(key) ||
                    (before.contains(key) && before.at(key) != after.at(key)))
                    return true;
            return false;
        });
    const bool inspect_interactions =
        changed_subjects || changed_features || changed_variable_types || inspecting_resolver;
    if (inspect_interactions && !state.normalized_json.empty() && !traits_json.empty()) {
        const auto exists = [&](std::string_view collection, std::string_view id) {
            if (!is_id(id))
                return false;
            if (collection == "interactableInstances") {
                const auto manifest = Json::parse(state.normalized_json);
                return manifest.contains("interactableInstances") &&
                       manifest.at("interactableInstances").contains(id);
            }
            if (!record_contracts().contains(std::string(collection)))
                return false;
            const auto owner = std::string(collection) + "/" + std::string(id);
            return records_.contains(owner) ||
                   std::filesystem::is_regular_file(root_ / "records" / std::string(collection) /
                                                    (std::string(id) + ".yaml"));
        };
        if (!interaction_sources_) {
            interaction_sources_.emplace();
            const auto dir = root_ / "records" / "interactions";
            if (std::filesystem::is_directory(dir))
                for (const auto& entry : std::filesystem::directory_iterator(dir)) {
                    if (!entry.is_regular_file() || entry.path().extension() != ".yaml")
                        continue;
                    const auto id = entry.path().stem().string();
                    if (!is_id(id))
                        continue;
                    if (const auto source = resolve_record("interactions", id))
                        interaction_sources_->emplace_back(id, *source);
                }
            std::sort(interaction_sources_->begin(), interaction_sources_->end());
        }
        auto interactions = *interaction_sources_;
        for (auto& [id, source] : interactions)
            if (const auto edited = records_.find("interactions/" + id); edited != records_.end()) {
                const auto snapshot = edited->second->snapshot();
                if (snapshot.valid)
                    source = snapshot.normalized_json;
            }
        const bool inspect_dependents =
            changed_subjects || changed_features || changed_variable_types ||
            std::any_of(records_.begin(), records_.end(), [](const auto& entry) {
                return entry.first.starts_with("verbs/") && entry.second->snapshot().dirty;
            });
        if (inspect_dependents)
            for (const auto& [id, source] : interactions) {
                if (records_.contains("interactions/" + id))
                    continue;
                const auto dependent = validate_verb_interaction_dependencies(
                    "interactions", source, state.normalized_json, traits_json, resolve_record,
                    exists);
                state.valid &= dependent.accepted;
                for (auto diagnostic : dependent.diagnostics) {
                    diagnostic.path = "/interactions/" + id + diagnostic.path;
                    state.diagnostics.push_back(std::move(diagnostic));
                }
            }
        std::sort(interactions.begin(), interactions.end());
        if (inspecting_resolver && state.valid) {
            if (!interaction_resolver_cache_ || interaction_resolver_sources_ != interactions) {
                interaction_resolver_cache_ = validate_interaction_resolver(interactions);
                interaction_resolver_sources_ = interactions;
                interaction_resolver_revision_ = working_revision_;
                interaction_resolver_owner_count_ = records_.size();
            }
            state.valid &= interaction_resolver_cache_->accepted;
            state.diagnostics.insert(state.diagnostics.end(),
                                     interaction_resolver_cache_->diagnostics.begin(),
                                     interaction_resolver_cache_->diagnostics.end());
        }
    }
    // A dirty referenced record can invalidate an unopened Test. Preserve the
    // full dependency answer without admitting those Tests as editable owners.
    const bool inspect_test_dependents =
        changed_subjects || changed_features ||
        std::any_of(records_.begin(), records_.end(), [](const auto& entry) {
            if (!entry.second->snapshot().dirty)
                return false;
            const auto slash = entry.first.find('/');
            const auto family = entry.first.substr(0, slash);
            return family == "traits" || family == "verbs" || family == "rooms" ||
                   family == "characters" || family == "interactables" || family == "variables" ||
                   family == "dialogues" || family == "scenes" || family == "layouts";
        });
    if (inspect_test_dependents && !state.normalized_json.empty() && !traits_json.empty()) {
        if (!test_sources_) {
            test_sources_.emplace();
            const auto dir = root_ / "records" / "tests";
            if (std::filesystem::is_directory(dir))
                for (const auto& entry : std::filesystem::directory_iterator(dir)) {
                    if (!entry.is_regular_file() || entry.path().extension() != ".yaml")
                        continue;
                    const auto id = entry.path().stem().string();
                    if (!is_id(id))
                        continue;
                    if (const auto record = resolve_record("tests", id))
                        test_sources_->emplace_back(id, *record);
                }
        }
        const auto exists = [&](std::string_view collection, std::string_view id) {
            if (!is_id(id))
                return false;
            const auto owner = std::string(collection) + "/" + std::string(id);
            if (collection == "layouts")
                return records_.contains(owner) ||
                       std::filesystem::is_regular_file(root_ / "records" / "layouts" /
                                                        std::string(id) / "layout.yaml");
            return record_contracts().contains(std::string(collection)) &&
                   (records_.contains(owner) ||
                    std::filesystem::is_regular_file(root_ / "records" / std::string(collection) /
                                                     (std::string(id) + ".yaml")));
        };
        for (const auto& [id, source] : *test_sources_) {
            if (records_.contains("tests/" + id))
                continue;
            const auto dependent = validate_test_dependencies(source, state.normalized_json,
                                                              traits_json, resolve_record, exists);
            state.valid &= dependent.accepted;
            for (auto diagnostic : dependent.diagnostics) {
                diagnostic.path = "/tests/" + id + diagnostic.path;
                state.diagnostics.push_back(std::move(diagnostic));
            }
        }
    }
    // The localization cache incorporates dirty tracked source fragments, so
    // Asset referential checks must consume this effective model, not disk YAML.
    if (!localization_cache_)
        localization_cache_ = validate_working_localization();
    // Asset-alias dependency checking is scoped to interested owners.
    if (manifest_dirty || std::any_of(records_.begin(), records_.end(), [](const auto& entry) {
            return entry.first.starts_with("assets/");
        })) {
        const auto aliases = validate_project_asset_aliases(root_, resolve_record);
        state.valid &= aliases.accepted;
        state.diagnostics.insert(state.diagnostics.end(), aliases.diagnostics.begin(),
                                 aliases.diagnostics.end());
    }
    // Always validate the *working* localized Asset mappings: an external
    // observed i18n edit also changes semantics, even if no editor owner is
    // currently dirty or inspected. Project-localization generations are
    // already cached and the locale mapping pass never hashes binary bytes.
    if (localization_cache_->accepted) {
        const auto locales = validate_asset_localizations(root_, resolve_record,
                                                          localization_cache_->effective_json);
        state.valid &= locales.accepted;
        state.diagnostics.insert(state.diagnostics.end(), locales.diagnostics.begin(),
                                 locales.diagnostics.end());
    }
    // Exact Instance membership is manifest-owned; its Definition and Inventory
    // owners are independent records. A dirty manifest or inspected Definition
    // invalidates the dependent inventory/quantity/containment closure.
    const bool inspected_definition =
        std::any_of(records_.begin(), records_.end(),
                    [](const auto& record) { return record.first.starts_with("interactables/"); });
    const bool inspected_inventory_owner =
        std::any_of(records_.begin(), records_.end(), [](const auto& record) {
            return record.first.starts_with("characters/") || record.first.starts_with("rooms/");
        });
    if ((manifest_dirty || inspected_definition || inspected_inventory_owner || traits_changed) &&
        !state.normalized_json.empty() && !traits_json.empty()) {
        const auto working = Json::parse(state.normalized_json);
        const auto baseline = Json::parse(state.baseline_json);
        const auto& instances = working.at("interactableInstances");
        const auto& old_instances = baseline.at("interactableInstances");
        const bool inventory_changed = working.at("inventories") != baseline.at("inventories");
        std::set<std::string> affected_instances;
        for (const auto& entry : instances.object_range()) {
            const auto id = std::string(entry.key());
            const auto definition =
                entry.value().at("definition").at("$ref").at("id").as<std::string>();
            const auto& location = entry.value().at("location");
            bool owner_inspected = false;
            if (location.at("kind") == "inventory") {
                const auto& inventory_owner = location.at("inventory").at("owner");
                const auto kind = inventory_owner.at("kind").as<std::string>();
                if (kind == "character")
                    owner_inspected = records_.contains(
                        "characters/" +
                        inventory_owner.at("character").at("$ref").at("id").as<std::string>());
                else if (kind == "room-feature")
                    owner_inspected = records_.contains(
                        "rooms/" +
                        inventory_owner.at("room").at("$ref").at("id").as<std::string>());
                else if (kind == "interactable" || kind == "interactable-feature") {
                    const auto owner_id =
                        inventory_owner.at("interactable").at("$ref").at("id").as<std::string>();
                    if (instances.contains(owner_id))
                        owner_inspected =
                            records_.contains("interactables/" + instances.at(owner_id)
                                                                     .at("definition")
                                                                     .at("$ref")
                                                                     .at("id")
                                                                     .as<std::string>());
                }
            }
            if (traits_changed || !old_instances.contains(id) ||
                old_instances.at(id) != entry.value() ||
                records_.contains("interactables/" + definition) || owner_inspected ||
                (inventory_changed && location.at("kind") == "inventory"))
                affected_instances.insert(id);
        }
        const auto exists = [&](std::string_view family, std::string_view id) {
            if (!is_id(id))
                return false;
            const auto owner = std::string(family) + "/" + std::string(id);
            if (records_.contains(owner))
                return true;
            if (!record_contracts().contains(std::string(family)))
                return false;
            const auto path = root_ / "records" / std::string(family) / (std::string(id) + ".yaml");
            return std::filesystem::is_regular_file(path);
        };
        const auto semantic = validate_interactable_inventory_project(
            state.normalized_json, resolve_record, traits_json, exists, affected_instances);
        state.valid &= semantic.accepted;
        state.diagnostics.insert(state.diagnostics.end(), semantic.diagnostics.begin(),
                                 semantic.diagnostics.end());
    }
    if (!localization_cache_)
        localization_cache_ = validate_working_localization();
    state.valid &= localization_cache_->accepted;
    state.diagnostics.insert(state.diagnostics.end(), localization_cache_->diagnostics.begin(),
                             localization_cache_->diagnostics.end());
    if (localization_source_lock_ && localization_cache_->accepted &&
        Json::parse(localization_cache_->effective_json).at("sourceLocale") !=
            *localization_source_lock_) {
        Diagnostic issue{"/localization/sourceLocale", "semantic.localization.lock-source",
                         "Source locale cannot change after substantive localization work exists."};
        issue.source_path = "i18n/project.yaml";
        state.valid = false;
        state.diagnostics.push_back(std::move(issue));
    }
    std::set<std::string> named_messages;
    std::map<std::string, std::vector<std::string>> named_message_arguments;
    if (localization_cache_ && localization_cache_->accepted) {
        const auto localization = Json::parse(localization_cache_->effective_json);
        if (localization.contains("messages"))
            for (const auto& entry : localization.at("messages").object_range()) {
                const auto& message = entry.value();
                if (message.contains("kind") && message.at("kind") == "named" &&
                    message.contains("key") && message.at("key").is_string()) {
                    const auto key = message.at("key").as<std::string>();
                    named_messages.insert(key);
                    std::vector<std::string> arguments;
                    if (message.contains("arguments"))
                        for (const auto& argument : message.at("arguments").object_range())
                            arguments.emplace_back(argument.key());
                    std::sort(arguments.begin(), arguments.end());
                    named_message_arguments.insert_or_assign(key, std::move(arguments));
                }
            }
    }
    for (const auto& [path, analysis] : source_analyses()) {
        const auto owners = text_source_owners_.find(path);
        if (owners == text_source_owners_.end())
            continue;
        for (const auto& owner : owners->second)
            for (auto issue : analysis.diagnostics) {
                issue.path = inline_source_diagnostic_paths_.contains(path)
                                 ? inline_source_diagnostic_paths_.at(path)
                                 : source_diagnostic_owner(analysis.source_path, owner);
                state.valid &= issue.severity != "error";
                state.diagnostics.push_back(std::move(issue));
            }
        for (const auto& owner : owners->second)
            for (const auto& occurrence : analysis.messages) {
                if (occurrence.kind != "named" || !localization_cache_ ||
                    !localization_cache_->accepted || named_messages.contains(occurrence.source) ||
                    is_localization_system_message_key(occurrence.source))
                    continue;
                Diagnostic issue{inline_source_diagnostic_paths_.contains(path)
                                     ? inline_source_diagnostic_paths_.at(path)
                                     : source_diagnostic_owner(path, owner),
                                 "authoring.localization.lua_named_message_missing",
                                 "Text.msg references unknown named Message '" + occurrence.source +
                                     "'."};
                issue.source_path = path;
                issue.line = occurrence.line;
                issue.column = occurrence.column;
                state.diagnostics.push_back(std::move(issue));
                state.valid = false;
            }
        for (const auto& owner : owners->second)
            for (const auto& occurrence : analysis.messages) {
                if (occurrence.kind != "named" || !occurrence.lua_call)
                    continue;
                const auto expected = named_message_arguments.find(occurrence.source);
                if (expected == named_message_arguments.end())
                    continue;
                std::string code, message;
                if (!expected->second.empty() && !occurrence.has_runtime_arguments) {
                    code = "authoring.localization.lua_message_arguments_missing";
                    message =
                        "Text.msg('" + occurrence.source + "') requires runtime Message arguments.";
                } else if (occurrence.runtime_argument_names &&
                           *occurrence.runtime_argument_names != expected->second) {
                    code = "authoring.localization.lua_message_arguments_mismatch";
                    message =
                        "Text.msg('" + occurrence.source +
                        "') literal argument table must match its declared Message arguments.";
                }
                if (!code.empty()) {
                    Diagnostic issue{inline_source_diagnostic_paths_.contains(path)
                                         ? inline_source_diagnostic_paths_.at(path)
                                         : source_diagnostic_owner(path, owner),
                                     code, message};
                    issue.source_path = path;
                    issue.line = occurrence.line;
                    issue.column = occurrence.column;
                    state.valid = false;
                    state.diagnostics.push_back(std::move(issue));
                }
            }
        for (const auto& owner : owners->second) {
            if (!owner.starts_with("layouts/") || !path.ends_with(".rml"))
                continue;
            const auto declared = layout_declared_scripts_.find(owner);
            for (const auto& reference : analysis.references) {
                if (reference.kind != "script")
                    continue;
                std::string resolved = trim_ecmascript(reference.target);
                if (resolved.starts_with("project:/"))
                    resolved.erase(0, sizeof("project:/") - 1);
                // Layout file-mode RML has no referenced Asset containing path,
                // so only Project-absolute script dependencies are admissible.
                if (declared != layout_declared_scripts_.end() &&
                    declared->second.contains(resolved) && text_source_paths_.contains(resolved))
                    continue;
                Diagnostic issue{inline_source_diagnostic_paths_.contains(path)
                                     ? inline_source_diagnostic_paths_.at(path)
                                     : source_diagnostic_owner(path, owner),
                                 "authoring.lua.external_source_unresolved",
                                 "RML script '" + reference.target +
                                     "' does not resolve to exactly one declared dependency.",
                                 "warning"};
                issue.source_path = path;
                issue.line = reference.line;
                issue.column = reference.column;
                state.diagnostics.push_back(std::move(issue));
            }
        }
    }
    return state;
}

const std::map<std::string, SourceAnalysis>& ProjectSession::source_analyses() const
{
    for (const auto& path : text_source_paths_) {
        const auto overlay = text_source_overlays_.find(path);
        const auto inlined = inline_text_sources_.find(path);
        const auto expected =
            inlined != inline_text_sources_.end()    ? exact_source_revision(inlined->second)
            : overlay == text_source_overlays_.end() ? text_disk_revisions_.at(path)
                                                     : exact_source_revision(overlay->second);
        if (const auto cached = text_analysis_cache_.find(path);
            cached != text_analysis_cache_.end() && cached->second.source_revision == expected)
            continue;
        const auto source = inlined != inline_text_sources_.end()    ? inlined->second
                            : overlay == text_source_overlays_.end() ? read_bytes(root_ / path)
                                                                     : overlay->second;
        text_analysis_cache_.insert_or_assign(path, analyze_project_text(path, source));
    }
    for (auto it = text_analysis_cache_.begin(); it != text_analysis_cache_.end();) {
        if (!text_source_paths_.contains(it->first))
            it = text_analysis_cache_.erase(it);
        else
            ++it;
    }
    return text_analysis_cache_;
}

void ProjectSession::index_text_owner(std::string_view owner, std::string_view raw_json)
{
    const auto key = std::string(owner);
    localization_cache_.reset();
    layout_declared_scripts_.erase(key);
    for (auto it = asset_text_consumers_.begin(); it != asset_text_consumers_.end();) {
        it->second.erase(key);
        if (it->second.empty())
            it = asset_text_consumers_.erase(it);
        else
            ++it;
    }
    const auto inline_prefix = "inline/" + key + "/";
    for (auto it = inline_text_sources_.begin(); it != inline_text_sources_.end();) {
        if (it->first.starts_with(inline_prefix)) {
            text_source_paths_.erase(it->first);
            inline_source_diagnostic_paths_.erase(it->first);
            text_analysis_cache_.erase(it->first);
            it = inline_text_sources_.erase(it);
        } else
            ++it;
    }
    for (auto it = text_source_owners_.begin(); it != text_source_owners_.end();) {
        it->second.erase(key);
        if (it->second.empty())
            it = text_source_owners_.erase(it);
        else
            ++it;
    }
    const auto record = Json::parse(raw_json);
    if (!record.is_object() || !record.contains("data") || !record.at("data").is_object())
        return;
    const auto& data = record.at("data");
    std::map<std::string, std::string> inlined;
    collect_inline_lua(data, "/" + key + "/data", inlined);
    for (const auto& [pointer, text] : inlined) {
        const auto virtual_path = "inline/" + key + pointer.substr(key.size() + 1) + ".lua";
        inline_text_sources_.insert_or_assign(virtual_path, text);
        inline_source_diagnostic_paths_.insert_or_assign(virtual_path, pointer);
        text_source_paths_.insert(virtual_path);
        text_source_owners_[virtual_path].insert(key);
    }
    const auto track = [&](std::string_view path) {
        if (analyzable_text_path(path) && !path.starts_with("/") &&
            path.find("..") == std::string_view::npos)
            text_source_owners_[std::string(path)].insert(key);
    };
    const auto track_asset = [&](std::string_view asset_id) {
        if (!is_id(asset_id))
            return;
        asset_text_consumers_[std::string(asset_id)].insert(key);
        const auto asset = [&]() -> std::optional<std::string> {
            if (const auto edited = records_.find("assets/" + std::string(asset_id));
                edited != records_.end()) {
                const auto state = edited->second->snapshot();
                if (state.valid)
                    return state.normalized_json;
            }
            std::string error;
            auto saved = RoomSession::open_record(root_, "assets", std::string(asset_id), error);
            if (saved && saved->snapshot().valid)
                return saved->snapshot().normalized_json;
            return std::nullopt;
        }();
        if (!asset)
            return;
        const auto parsed = Json::parse(*asset);
        const auto& source = parsed.at("data").at("source");
        if (source.is_object() && source.contains("type") && source.at("type") == "project-file" &&
            source.contains("path") && source.at("path").is_string())
            track(source.at("path").as<std::string>());
    };
    if (owner.starts_with("scripts/")) {
        if (data.contains("source") && data.at("source").is_object()) {
            const auto& source = data.at("source");
            if (source.contains("kind") && source.at("kind") == "project-file" &&
                source.contains("path") && source.at("path").is_string())
                track(source.at("path").as<std::string>());
        }
    } else if (owner.starts_with("layouts/")) {
        const auto id = owner.substr(sizeof("layouts/") - 1);
        for (const auto* channel : {"rml", "rcss", "lua"}) {
            if (data.contains(channel) && data.at(channel).is_object() &&
                data.at(channel).contains("sourceMode") &&
                data.at(channel).at("sourceMode") == "file")
                track("records/layouts/" + std::string(id) + "/layout." + channel);
            if (data.contains(channel) && data.at(channel).is_object() &&
                data.at(channel).contains("sourceMode") &&
                data.at(channel).at("sourceMode") == "asset" &&
                data.at(channel).contains("sourceAsset")) {
                const auto& source = data.at(channel).at("sourceAsset");
                if (source.is_string())
                    track_asset(source.as<std::string>());
                else if (source.is_object() && source.contains("$ref"))
                    track_asset(source.at("$ref").at("id").as<std::string>());
            }
        }
        if (data.contains("dependencies") && data.at("dependencies").is_object()) {
            const auto& dependencies = data.at("dependencies");
            if (dependencies.contains("scripts") && dependencies.at("scripts").is_array())
                for (const auto& entry : dependencies.at("scripts").array_range())
                    if (entry.is_string()) {
                        layout_declared_scripts_[key].insert(entry.as<std::string>());
                        track(entry.as<std::string>());
                    }
            if (dependencies.contains("templates") && dependencies.at("templates").is_array())
                for (const auto& ref : dependencies.at("templates").array_range())
                    if (ref.is_string())
                        track_asset(ref.as<std::string>());
                    else if (ref.is_object() && ref.contains("$ref"))
                        track_asset(ref.at("$ref").at("id").as<std::string>());
        }
    }
}

void ProjectSession::reindex_asset_consumers(std::string_view asset_id)
{
    const auto found = asset_text_consumers_.find(std::string(asset_id));
    if (found == asset_text_consumers_.end())
        return;
    const auto consumers = found->second;
    for (const auto& owner : consumers) {
        if (const auto opened = records_.find(owner); opened != records_.end()) {
            index_text_owner(owner, opened->second->snapshot().source_json);
            continue;
        }
        const auto split = owner.find('/');
        if (split == std::string::npos)
            continue;
        const auto path =
            root_ / "records" / owner.substr(0, split) / owner.substr(split + 1) / "layout.yaml";
        if (const auto decoded = decoded_record(path))
            index_text_owner(owner, decoded->to_string());
    }
}

SourceObservation ProjectSession::observe_sources()
{
    auto observed = source_authority_->observe();
    for (const auto& [path, revision] : observed.delta_revisions)
        validation_pending_source_revisions_.insert_or_assign(path, revision);
    // A separate watcher poll may consume the coverage-loss event before the
    // next clean-validation request. Keep that revocation pending even if the
    // full rescan re-established physical authority without a byte delta.
    if (observed.full_rescan) {
        // This is a Project-session-wide invalidation, not just a flag for the
        // cache-import path. Already-warm sessions must revoke their resident
        // contributors before they can claim to have revalidated this source.
        validation_snapshot_.reset();
        validation_source_revisions_.clear();
        validation_contributions_.clear();
        validation_room_map_cache_.reset();
    }
    if (observed.full_rescan || (!observed.authoritative && !observed.scoped_authority))
        validation_pending_uncertain_ = true;
    if (observed.authoritative || observed.scoped_authority) {
        for (const auto& path : observed.delta.removed) {
            text_source_paths_.erase(path);
            text_disk_revisions_.erase(path);
            text_analysis_cache_.erase(path);
        }
        for (const auto& [path, revision] : observed.delta_revisions) {
            if (!analyzable_text_path(path) || revision == "absent")
                continue;
            text_source_paths_.insert(path);
            text_disk_revisions_.insert_or_assign(path, revision);
            text_analysis_cache_.erase(path);
        }
    }
    const auto changed_localization = [](const std::vector<std::string>& paths) {
        return std::any_of(paths.begin(), paths.end(),
                           [](const auto& path) { return path.starts_with("i18n/"); });
    };
    const auto source_contributes = [](const std::vector<std::string>& paths) {
        return std::any_of(paths.begin(), paths.end(), [](const auto& path) {
            return path.starts_with("records/") || path.ends_with(".lua") ||
                   path.ends_with(".rml") || path.ends_with(".rcss");
        });
    };
    if (!observed.authoritative || source_contributes(observed.delta.changed) ||
        source_contributes(observed.delta.added) || source_contributes(observed.delta.removed) ||
        changed_localization(observed.delta.changed) ||
        changed_localization(observed.delta.added) || changed_localization(observed.delta.removed))
        localization_cache_.reset();
    const auto changed_interactions = [](const std::vector<std::string>& paths) {
        return std::any_of(paths.begin(), paths.end(), [](const auto& path) {
            return path.starts_with("records/interactions/");
        });
    };
    if (!observed.authoritative || changed_interactions(observed.delta.changed) ||
        changed_interactions(observed.delta.added) ||
        changed_interactions(observed.delta.removed)) {
        interaction_sources_.reset();
        interaction_resolver_cache_.reset();
    }
    const auto changed_tests = [](const std::vector<std::string>& paths) {
        return std::any_of(paths.begin(), paths.end(),
                           [](const auto& path) { return path.starts_with("records/tests/"); });
    };
    if (!observed.authoritative || changed_tests(observed.delta.changed) ||
        changed_tests(observed.delta.added) || changed_tests(observed.delta.removed))
        test_sources_.reset();
    if (!observed.authoritative)
        material_compiler_results_.clear();
    else {
        const auto changed_shader = [](const std::vector<std::string>& paths) {
            return std::any_of(paths.begin(), paths.end(),
                               [](const auto& path) { return path.starts_with("shaders/"); });
        };
        if (changed_shader(observed.delta.changed) || changed_shader(observed.delta.added) ||
            changed_shader(observed.delta.removed))
            material_compiler_results_.clear();
    }
    return observed;
}

RoomSessionResult ProjectSession::stage_text_source(std::uint64_t revision,
                                                    std::string_view relative_path,
                                                    std::string source_text)
{
    RoomSessionResult response;
    const auto before = snapshot();
    response.snapshot = before;
    if (revision != working_revision_) {
        response.error = "Stale working revision.";
        return response;
    }
    const std::string path(relative_path);
    const std::filesystem::path relative(path);
    if (!analyzable_text_path(path) || !text_source_paths_.contains(path) ||
        relative != relative.lexically_normal() || path.find_first_of(":\\") != std::string::npos ||
        path.find("//") != std::string::npos || source_text.size() > 4 * 1024 * 1024) {
        response.error = "Text overlay requires an admitted canonical Lua/RML/RCSS Project source.";
        return response;
    }
    try {
        const auto canonical = std::filesystem::canonical(root_ / relative);
        const auto within = canonical.lexically_relative(std::filesystem::canonical(root_));
        if (within.empty() || within == "." || *within.begin() == "..")
            throw std::runtime_error("Text overlay source escapes Project root.");
        const auto disk = read_bytes(canonical);
        if (exact_source_revision(disk) != text_disk_revisions_.at(path))
            throw std::runtime_error("External source conflict for " + path);
        const auto current = text_source_overlays_.find(path);
        const auto prior = current == text_source_overlays_.end() ? disk : current->second;
        if (prior == source_text) {
            response.accepted = true;
            return response;
        }
        if (source_text == disk)
            text_source_overlays_.erase(path);
        else
            text_source_overlays_.insert_or_assign(path, std::move(source_text));
        text_analysis_cache_.erase(path);
        localization_cache_.reset();
        ++working_revision_;
        response.accepted = true;
        if (const auto owners = text_source_owners_.find(path); owners != text_source_owners_.end())
            response.affected_records.assign(owners->second.begin(), owners->second.end());
        else
            response.affected_records.push_back("source:" + path);
        response.snapshot = snapshot();
        diagnostic_delta(response, before);
    } catch (const std::exception& error) {
        response.error = error.what();
    }
    return response;
}

RoomSessionResult ProjectSession::save_text_sources(std::uint64_t revision,
                                                   const std::vector<std::string>& paths,
                                                   const std::map<std::string, std::string>& disk_preconditions)
{
    RoomSessionResult response;
    const auto before = snapshot();
    response.snapshot = before;
    if (revision != working_revision_) {
        response.error = "Stale working revision.";
        return response;
    }
    if (source_authority_->uncertain()) {
        response.error = "Cannot save text with uncertain Project source authority.";
        return response;
    }
    if (paths.empty() || paths.size() > 128) {
        response.error = "Native text Save requires a bounded nonempty source selection.";
        return response;
    }
    try {
        std::set<std::string> used;
        std::vector<YamlTransactionTarget> targets;
        for (const auto& path : paths) {
            if (!used.insert(path).second || !analyzable_text_path(path) ||
                !text_source_paths_.contains(path) || path.starts_with("inline/") ||
                !text_disk_revisions_.contains(path))
                throw std::runtime_error("Unknown or duplicate admitted text source: " + path);
            const auto overlay = text_source_overlays_.find(path);
            if (overlay == text_source_overlays_.end())
                continue;
            const auto original = disk_preconditions.find(path);
            if (original == disk_preconditions.end() ||
                original->second != text_disk_revisions_.at(path))
                throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: staged text baseline " +
                                         path);
            const auto root = std::filesystem::canonical(root_);
            const auto canonical = std::filesystem::canonical(root_ / path);
            const auto relative = canonical.lexically_relative(root);
            if (relative.empty() || relative == "." || *relative.begin() == "..")
                throw std::runtime_error("Text source escapes the Project root.");
            const auto baseline = read_bytes(canonical);
            const auto expected = text_disk_revisions_.at(path);
            if (exact_source_revision(baseline) != expected)
                throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: " + path);
            YamlTransactionTarget target;
            target.path = path;
            target.expected_revision = expected;
            target.baseline_source = baseline;
            target.raw_text_source = overlay->second;
            targets.push_back(std::move(target));
        }
        if (targets.empty()) {
            response.accepted = true;
            return response;
        }
        YamlTransactionService writer(root_);
        const auto prepared = writer.prepare(targets, TransactionDecision::KeepComments);
        if (!prepared.accepted)
            throw std::runtime_error(prepared.error);
        const auto saved = writer.commit(prepared, TransactionDecision::KeepComments);
        if (!saved.accepted)
            throw std::runtime_error(saved.error);
        for (const auto& target : prepared.targets) {
            text_disk_revisions_[target.path] = target.after_revision;
            text_source_overlays_.erase(target.path);
            response.affected_records.push_back("source:" + target.path);
            if (!source_authority_->acknowledge_own_write(target.path, target.after_revision))
                source_authority_->coverage_lost();
        }
        ++working_revision_;
        response.accepted = true;
        response.snapshot = snapshot();
        diagnostic_delta(response, before);
    } catch (const std::exception& error) {
        response.error = error.what();
    }
    return response;
}

std::optional<std::string> ProjectSession::resolved_material(std::string_view material_id) const
{
    const auto found = records_.find("materials/" + std::string(material_id));
    if (found == records_.end() || !found->second->snapshot().valid)
        return std::nullopt;
    const AuthoringRecordResolver resolve = [&](std::string_view family,
                                                std::string_view id) -> std::optional<std::string> {
        const auto owner = std::string(family) + "/" + std::string(id);
        if (const auto tracked = records_.find(owner); tracked != records_.end()) {
            const auto snapshot = tracked->second->snapshot();
            return snapshot.valid ? std::optional<std::string>{snapshot.normalized_json}
                                  : std::nullopt;
        }
        std::string error;
        auto record = RoomSession::open_record(root_, std::string(family), std::string(id), error);
        if (!record)
            return std::nullopt;
        const auto snapshot = record->snapshot();
        return snapshot.valid ? std::optional<std::string>{snapshot.normalized_json} : std::nullopt;
    };
    const auto result = resolve_material(material_id, found->second->snapshot().normalized_json,
                                         resolve, root_, shader_overlays_);
    return result.accepted ? std::optional<std::string>{result.effective_json} : std::nullopt;
}

std::optional<std::string> ProjectSession::material_compiler_request(std::string_view id) const
{
    const auto effective = resolved_material(id);
    return effective ? std::optional<std::string>{material_shader_program_request(id, *effective)}
                     : std::nullopt;
}

RoomSessionResult ProjectSession::stage_shader_source(std::uint64_t revision,
                                                      std::string_view relative_path,
                                                      std::string source_text)
{
    RoomSessionResult response;
    const auto prior = snapshot();
    response.snapshot = prior;
    if (revision != working_revision_) {
        response.error = "Stale working revision.";
        return response;
    }
    const std::string path(relative_path);
    const auto relative = std::filesystem::path(path);
    if (!path.starts_with("shaders/") || relative != relative.lexically_normal() ||
        path.find_first_of(":\\") != std::string::npos || path.find("//") != std::string::npos ||
        !path.ends_with(".sc")) {
        response.error = "Shader source overlay must have a canonical shaders/*.sc path.";
        return response;
    }
    try {
        const auto file = std::filesystem::weakly_canonical(root_ / relative);
        const auto contained = file.lexically_relative(std::filesystem::canonical(root_));
        if (contained.empty() || contained == "." || *contained.begin() == "..")
            throw std::runtime_error("Shader overlay source escapes Project root.");
        const bool exists = std::filesystem::exists(file);
        if (exists && !std::filesystem::is_regular_file(file))
            throw std::runtime_error("Shader overlay target is not a regular source file.");
        const auto disk_source = exists ? read_bytes(file) : std::string{};
        const auto current = shader_overlays_.find(path);
        const auto was = current == shader_overlays_.end() ? disk_source : current->second;
        if (was == source_text) {
            response.accepted = true;
            return response;
        }
        if (source_text == disk_source)
            shader_overlays_.erase(path);
        else
            shader_overlays_.insert_or_assign(path, std::move(source_text));
        material_compiler_results_.clear();
        ++working_revision_;
        response.accepted = true;
        response.affected_records.push_back("shader-source:" + path);
        response.snapshot = snapshot();
        diagnostic_delta(response, prior);
    } catch (const std::exception& error) {
        response.error = error.what();
    }
    return response;
}

RoomSessionResult ProjectSession::publish_material_compiler_result(
    std::uint64_t revision, std::string_view material_id, std::string_view native_tool_result_json)
{
    RoomSessionResult response;
    const auto prior = snapshot();
    response.snapshot = prior;
    if (revision != working_revision_) {
        response.error = "Stale shader compiler result.";
        return response;
    }
    if (!is_id(material_id) || !records_.contains("materials/" + std::string(material_id))) {
        response.error = "Shader compiler result requires an inspected Material owner.";
        return response;
    }
    try {
        const auto effective = resolved_material(material_id);
        if (!effective)
            throw std::runtime_error("Cannot accept compiler result for invalid Material source.");
        auto validated = validate_material_shader_compiler_result(native_tool_result_json,
                                                                  material_id, *effective);
        material_compiler_results_.insert_or_assign(std::string(material_id), std::move(validated));
        validation_snapshot_.reset();
        validation_contributions_.erase("materials/" + std::string(material_id));
        response.accepted = true;
        response.affected_records.push_back("materials/" + std::string(material_id));
        response.snapshot = snapshot();
        diagnostic_delta(response, prior);
    } catch (const std::exception& error) {
        response.error = error.what();
    }
    return response;
}

std::map<std::string, RoomSessionSnapshot> ProjectSession::record_snapshots() const
{
    std::map<std::string, RoomSessionSnapshot> result;
    for (const auto& [owner, session] : records_)
        result.emplace(owner, session->snapshot());
    return result;
}

ValidationResult ProjectSession::validate_working_localization() const
{
    std::map<std::string, std::string> localization, records;
    for (const auto& [owner, session] : records_) {
        if (owner.starts_with("i18n/"))
            localization.emplace(owner, session->snapshot().source_json);
        else if (localization_record_owner(owner) || owner.starts_with("assets/"))
            records.emplace("records/" + owner +
                                (owner.starts_with("layouts/") ? "/layout.yaml" : ".yaml"),
                            session->snapshot().source_json);
    }
    return validate_project_localization(root_, localization, records, source_analyses());
}

std::map<std::string, RoomSessionSnapshot> ProjectSession::validated_disk_record_snapshots() const
{
    std::map<std::string, RoomSessionSnapshot> snapshots;
    if (!validation_snapshot_ || !validation_snapshot_->valid)
        return snapshots;
    for (const auto& [owner, session] : validation_records_)
        snapshots.emplace(owner, session->snapshot());
    return snapshots;
}

std::map<std::string, RoomSessionSnapshot>
ProjectSession::reconciliation_disk_record_snapshots() const
{
    std::map<std::string, RoomSessionSnapshot> snapshots;
    if (!validation_snapshot_)
        return snapshots;
    for (const auto& [owner, session] : validation_records_)
        snapshots.emplace(owner, session->snapshot());
    return snapshots;
}

RoomSessionResult ProjectSession::inspect_record(std::string_view owner)
{
    RoomSessionResult result;
    try {
        const auto name = std::string(owner);
        const auto slash = name.find('/');
        const auto family = name.substr(0, slash);
        const auto id = slash == std::string::npos ? std::string() : name.substr(slash + 1);
        if (name != "editor" && name != "traits" && !name.starts_with("i18n/") &&
            (!record_contracts().contains(family) || !is_id(id))) {
            result.error = "Unsupported native record owner.";
        } else if (const auto found = records_.find(name); found != records_.end()) {
            if (exact_source_revision(read_bytes(found->second->source_path())) !=
                found->second->snapshot().disk_source_revision)
                result.error = "External source conflict for " + name;
            else
                result.accepted = true;
        } else {
            std::string error;
            auto record = name == "editor"   ? RoomSession::open_editor_source(root_, error)
                          : name == "traits" ? RoomSession::open_traits_source(root_, error)
                          : name.starts_with("i18n/")
                              ? RoomSession::open_localization_source(root_, name, error)
                              : RoomSession::open_record(root_, family, id, error);
            if (!record)
                result.error = error;
            else {
                records_.emplace(name, std::move(record));
                if (indexed_text_owner(name))
                    index_text_owner(name, records_.at(name)->snapshot().source_json);
                if (localization_record_owner(name))
                    localization_cache_.reset();
                if (name.starts_with("i18n/"))
                    localization_cache_.reset();
                result.accepted = true;
            }
        }
        if (result.accepted)
            result.affected_records.push_back(name);
    } catch (const std::exception& error) {
        result.error = error.what();
    }
    result.snapshot = snapshot();
    return result;
}

RoomSessionResult ProjectSession::reconcile_owner(std::string_view owner)
{
    RoomSessionResult response;
    const auto before = snapshot();
    if (owner == "project") {
        response = source_->reconcile_disk();
    } else {
        const auto name = std::string(owner);
        if (!records_.contains(name)) {
            response = inspect_record(owner);
            return response;
        }
        response = records_.at(name)->reconcile_disk();
    }
    if (response.accepted && !response.affected_records.empty()) {
        if (indexed_text_owner(owner) && records_.contains(std::string(owner)))
            index_text_owner(owner, records_.at(std::string(owner))->snapshot().source_json);
        if (localization_record_owner(owner))
            localization_cache_.reset();
        if (owner.starts_with("assets/"))
            reindex_asset_consumers(owner.substr(sizeof("assets/") - 1));
        if (owner.starts_with("assets/"))
            localization_cache_.reset();
        if (owner.starts_with("i18n/"))
            localization_cache_.reset();
        if (owner.starts_with("materials/"))
            material_compiler_results_.clear();
        if (owner.starts_with("interactions/")) {
            interaction_sources_.reset();
            interaction_resolver_cache_.reset();
        }
        ++working_revision_;
        response.affected_records = {std::string(owner)};
    }
    response.snapshot = snapshot();
    diagnostic_delta(response, before);
    return response;
}

RoomSessionResult ProjectSession::use_disk(std::uint64_t revision, std::string_view owner,
                                           const std::vector<std::string>& paths)
{
    RoomSessionResult response;
    const auto before = snapshot();
    if (revision != working_revision_) {
        response.error = "Stale working revision.";
    } else if (owner == "project") {
        response = paths.empty() ? source_->use_disk() : source_->use_disk_paths(paths);
    } else if (const auto found = records_.find(std::string(owner)); found != records_.end()) {
        response = paths.empty() ? found->second->use_disk() : found->second->use_disk_paths(paths);
    } else {
        response.error = "Unknown native Project owner.";
    }
    if (response.accepted && !response.affected_records.empty()) {
        if (indexed_text_owner(owner) && records_.contains(std::string(owner)))
            index_text_owner(owner, records_.at(std::string(owner))->snapshot().source_json);
        if (localization_record_owner(owner))
            localization_cache_.reset();
        if (owner.starts_with("assets/"))
            reindex_asset_consumers(owner.substr(sizeof("assets/") - 1));
        if (owner.starts_with("assets/"))
            localization_cache_.reset();
        if (owner.starts_with("i18n/"))
            localization_cache_.reset();
        ++working_revision_;
        response.affected_records = {std::string(owner)};
    }
    response.snapshot = snapshot();
    diagnostic_delta(response, before);
    return response;
}

RoomSessionResult
ProjectSession::restore_conflicts(std::uint64_t revision,
                                  const std::map<std::string, std::vector<std::string>>& conflicts)
{
    RoomSessionResult response;
    response.snapshot = snapshot();
    if (revision != working_revision_) {
        response.error = "Stale working revision during conflict recovery.";
        return response;
    }
    try {
        for (const auto& [owner, paths] : conflicts) {
            RoomSession* record = nullptr;
            if (owner == "project")
                record = source_.get();
            else if (const auto found = records_.find(owner); found != records_.end())
                record = found->second.get();
            if (!record || !record->snapshot().dirty)
                throw std::runtime_error("Cannot restore conflict for a non-dirty owner.");
            for (const auto& path : paths) {
                check_pointer(path);
                if (at_pointer(Json::parse(record->working_json_), path) ==
                    at_pointer(Json::parse(record->disk_json_), path))
                    throw std::runtime_error("Recovered conflict is no longer unresolved.");
            }
        }
        for (const auto& [owner, paths] : conflicts) {
            auto* record = owner == "project" ? source_.get() : records_.at(owner).get();
            record->conflicting_paths_ = paths;
            response.affected_records.push_back(owner);
        }
        response.accepted = true;
        response.snapshot = snapshot();
    } catch (const std::exception& error) {
        response.error = error.what();
    }
    return response;
}

RoomSessionResult
ProjectSession::use_disk_owners(std::uint64_t revision,
                                const std::map<std::string, std::vector<std::string>>& paths)
{
    RoomSessionResult response;
    response.snapshot = snapshot();
    if (revision != working_revision_) {
        response.error = "Stale working revision.";
        return response;
    }
    try {
        auto manifest = source_->clone();
        std::map<std::string, std::unique_ptr<RoomSession>> staged;
        for (const auto& [owner, record] : records_)
            staged.emplace(owner, record->clone());
        for (const auto& [owner, fields] : paths) {
            if (fields.empty())
                throw std::runtime_error("Logical Use Disk selection cannot be empty.");
            auto* record = owner == "project"       ? manifest.get()
                           : staged.contains(owner) ? staged.at(owner).get()
                                                    : nullptr;
            if (!record)
                throw std::runtime_error("Unknown logical Use Disk owner.");
            const auto result = fields.size() == 1 && fields.front() == "/"
                                    ? record->use_disk()
                                    : record->use_disk_paths(fields);
            if (!result.accepted)
                throw std::runtime_error(result.error);
            if (!result.affected_records.empty())
                response.affected_records.push_back(owner);
        }
        if (!response.affected_records.empty()) {
            const auto before = response.snapshot;
            source_ = std::move(manifest);
            records_ = std::move(staged);
            for (const auto& owner : response.affected_records)
                if (indexed_text_owner(owner))
                    index_text_owner(owner, records_.at(owner)->snapshot().source_json);
            if (std::any_of(response.affected_records.begin(), response.affected_records.end(),
                            localization_record_owner))
                localization_cache_.reset();
            for (const auto& owner : response.affected_records)
                if (owner.starts_with("assets/"))
                    reindex_asset_consumers(owner.substr(sizeof("assets/") - 1));
            if (std::any_of(response.affected_records.begin(), response.affected_records.end(),
                            [](const auto& owner) { return owner.starts_with("assets/"); }))
                localization_cache_.reset();
            if (std::any_of(response.affected_records.begin(), response.affected_records.end(),
                            [](const auto& owner) { return owner.starts_with("i18n/"); }))
                localization_cache_.reset();
            ++working_revision_;
            response.snapshot = snapshot();
            diagnostic_delta(response, before);
        }
        response.accepted = true;
    } catch (const std::exception& error) {
        response.affected_records.clear();
        response.error = error.what();
    }
    return response;
}

RoomSessionResult
ProjectSession::save_owners(std::uint64_t revision, const std::vector<std::string>& owners,
                            bool keep_mine, TransactionDecision comments,
                            const std::map<std::string, std::vector<std::string>>& paths)
{
    RoomSessionResult response;
    response.snapshot = snapshot();
    if (revision != working_revision_) {
        response.error = "Stale working revision.";
        return response;
    }
    if (source_authority_->uncertain()) {
        response.error = "Cannot save with uncertain Project source authority.";
        return response;
    }
    if (comments == TransactionDecision::Cancel) {
        response.error = "Comment or deletion approval canceled.";
        return response;
    }
    try {
        std::map<std::string, RoomSession*> selected;
        for (const auto& owner : owners) {
            RoomSession* session = nullptr;
            if (owner == "project")
                session = source_.get();
            else if (const auto found = records_.find(owner); found != records_.end())
                session = found->second.get();
            if (!session || !selected.emplace(owner, session).second)
                throw std::runtime_error("Unknown or duplicate native Save owner: " + owner);
        }
        // Save validates the selected dirty owner and its already-inspected
        // dependents. Unrelated invalid owners must not block a scoped Save.
        const auto current = snapshot();
        for (const auto& [owner, session] : selected) {
            if (!session->snapshot().dirty)
                continue;
            const auto variable_id = owner.starts_with("variables/")
                                         ? owner.substr(std::string("variables/").size())
                                         : std::string{};
            const auto filter = paths.find(owner);
            const bool all_paths =
                filter == paths.end() || (filter->second.size() == 1 && filter->second[0] == "/");
            for (const auto& diagnostic : current.diagnostics) {
                // Informational and uncertain resolver findings remain visible,
                // but only errors can invalidate a scoped Save.
                if (diagnostic.severity != "error")
                    continue;
                const bool invalid_selected_record =
                    diagnostic.path.starts_with("/" + owner + "/") &&
                    (all_paths || std::any_of(filter->second.begin(), filter->second.end(),
                                              [&](const std::string& path) {
                                                  return paths_overlap("/" + owner + path,
                                                                       diagnostic.path);
                                              }));
                const bool invalid_localization =
                    owner.starts_with("i18n/") && diagnostic.source_path == owner;
                const bool trait_dependency =
                    owner == "traits" && (diagnostic.code.starts_with("authoring.trait.") ||
                                          diagnostic.code == "authoring.trait.missing_reference");
                const bool variable_dependency =
                    !variable_id.empty() &&
                    diagnostic.code == "authoring.condition.variable-type-mismatch" &&
                    diagnostic.message.find("'" + variable_id + "'") != std::string::npos;
                const bool verb_dependency =
                    owner.starts_with("verbs/") && diagnostic.path.starts_with("/interactions/") &&
                    (diagnostic.code == "authoring.interaction.slots" ||
                     diagnostic.code == "authoring.interaction.offer-slot" ||
                     diagnostic.code == "authoring.interaction.verb-missing" ||
                     diagnostic.code == "authoring.interaction.selector-disjoint") &&
                    diagnostic.message.find("'" + owner.substr(std::string("verbs/").size()) +
                                            "'") != std::string::npos;
                const bool scene_input_dependency =
                    owner.starts_with("scenes/") && diagnostic.code.starts_with("scene.input.") &&
                    diagnostic.message.find("Scene '" +
                                            owner.substr(std::string("scenes/").size()) + "'") !=
                        std::string::npos;
                const bool entrypoint_dependency =
                    owner == "project" &&
                    (diagnostic.code.starts_with("scene.entrypoint.") ||
                     diagnostic.code.starts_with("dialogue.entrypoint.")) &&
                    (all_paths || std::any_of(filter->second.begin(), filter->second.end(),
                                              [&](const std::string& path) {
                                                  return paths_overlap(path, "/entrypoint");
                                              }));
                const bool interaction_fallback_dependency =
                    owner == "project" &&
                    diagnostic.path.starts_with("/undefinedInteractionProgram") &&
                    (all_paths ||
                     std::any_of(filter->second.begin(), filter->second.end(),
                                 [&](const std::string& path) {
                                     return paths_overlap(path, "/undefinedInteractionProgram");
                                 }));
                const bool instance_dependency =
                    owner == "project" && diagnostic.path.starts_with("/interactableInstances/") &&
                    (diagnostic.code.starts_with("authoring.trait.") ||
                     diagnostic.code.starts_with("authoring.interactable.") ||
                     diagnostic.code.starts_with("authoring.inventory.")) &&
                    (all_paths || std::any_of(filter->second.begin(), filter->second.end(),
                                              [&](const std::string& path) {
                                                  return paths_overlap(path, diagnostic.path);
                                              }));
                bool owner_dependency = false;
                if (!current.normalized_json.empty() &&
                    diagnostic.path.starts_with("/interactableInstances/")) {
                    const auto start = std::string_view("/interactableInstances/").size();
                    const auto end = diagnostic.path.find('/', start);
                    const auto instance_id = diagnostic.path.substr(start, end - start);
                    const auto manifest = Json::parse(current.normalized_json);
                    const auto& instances = manifest.at("interactableInstances");
                    if (instances.contains(instance_id)) {
                        const auto& instance = instances.at(instance_id);
                        if (owner.starts_with("interactables/") &&
                            diagnostic.code.starts_with("authoring.interactable."))
                            owner_dependency = instance.at("definition").at("$ref").at("id") ==
                                               owner.substr(std::string("interactables/").size());
                        if (diagnostic.code.starts_with("authoring.inventory.") &&
                            instance.at("location").at("kind") == "inventory") {
                            const auto& inventory_owner =
                                instance.at("location").at("inventory").at("owner");
                            const auto kind = inventory_owner.at("kind").as<std::string>();
                            if (kind == "character")
                                owner_dependency =
                                    owner == "characters/" + inventory_owner.at("character")
                                                                 .at("$ref")
                                                                 .at("id")
                                                                 .as<std::string>();
                            else if (kind == "room-feature")
                                owner_dependency = owner == "rooms/" + inventory_owner.at("room")
                                                                           .at("$ref")
                                                                           .at("id")
                                                                           .as<std::string>();
                            else if ((kind == "interactable" || kind == "interactable-feature") &&
                                     owner.starts_with("interactables/")) {
                                const auto owner_id = inventory_owner.at("interactable")
                                                          .at("$ref")
                                                          .at("id")
                                                          .as<std::string>();
                                if (instances.contains(owner_id))
                                    owner_dependency =
                                        instances.at(owner_id)
                                            .at("definition")
                                            .at("$ref")
                                            .at("id") ==
                                        owner.substr(std::string("interactables/").size());
                            }
                        }
                    }
                }
                if (invalid_selected_record || invalid_localization || trait_dependency ||
                    variable_dependency || verb_dependency || scene_input_dependency ||
                    entrypoint_dependency || interaction_fallback_dependency ||
                    instance_dependency || owner_dependency)
                    throw std::runtime_error("Cannot save invalid dependent Project record: " +
                                             diagnostic.path);
            }
        }
        std::vector<YamlTransactionTarget> targets;
        std::map<std::string, Json> projected;
        for (const auto& [owner, session] : selected) {
            const auto state = session->snapshot();
            if (!state.dirty)
                continue;
            auto filter = paths.find(owner);
            if (filter != paths.end() && filter->second.size() == 1 &&
                filter->second.front() == "/")
                filter = paths.end();
            if (filter != paths.end() && filter->second.empty())
                throw std::runtime_error("Empty logical Save path selection.");
            if (!keep_mine &&
                std::any_of(session->conflicting_paths_.begin(), session->conflicting_paths_.end(),
                            [&](const std::string& conflict) {
                                return filter == paths.end() ||
                                       std::any_of(filter->second.begin(), filter->second.end(),
                                                   [&](const std::string& path) {
                                                       return paths_overlap(path, conflict);
                                                   });
                            }))
                throw std::runtime_error("External changes conflict with unsaved edits in '" +
                                         owner + "'. Choose Use Disk or Keep Mine.");
            // Keep Mine is still tied to the newly reconciled exact baseline.
            // Even a second external edit between Prepare and Commit is refused.
            std::vector<YamlValueEdit> edits;
            const auto base = Json::parse(session->disk_json_);
            const auto working = Json::parse(session->working_json_);
            Json target = working;
            if (filter != paths.end()) {
                target = base;
                for (const auto& path : filter->second)
                    select_path(target, working, path);
            }
            if (target == base)
                continue;
            auto validation = session->clone();
            validation->working_json_ = target.to_string();
            if (!validation->snapshot().valid)
                throw std::runtime_error("Cannot save invalid working source: " + owner);
            source_diff(&base, &target, "", session->unsaved_patches_, edits);
            projected.emplace(owner, std::move(target));
            targets.push_back({session->source_path().lexically_relative(root_).generic_string(),
                               session->disk_revision_, session->disk_source_, std::move(edits)});
        }
        if (targets.empty()) {
            response.accepted = true;
            return response;
        }
        YamlTransactionService writer(root_);
        writer.set_invalid_sources(source_authority_->invalid_source_paths(), false);
        const auto prepared = writer.prepare(targets, comments);
        if (!prepared.accepted)
            throw std::runtime_error(prepared.error);
        if (prepared.targets.size() != targets.size())
            throw std::runtime_error(
                "Native Save cannot treat an unapplied dirty owner as successfully persisted.");
        for (const auto& proposed : prepared.targets) {
            const auto reopened = open_yaml_source(proposed.after_source);
            if (!reopened.accepted)
                throw std::runtime_error("Proposed Save source cannot be reopened.");
            auto found = std::find_if(selected.begin(), selected.end(), [&](const auto& item) {
                return item.second->source_path().lexically_relative(root_).generic_string() ==
                       proposed.path;
            });
            if (found == selected.end() ||
                Json::parse(reopened.source_json) != projected.at(found->first))
                throw std::runtime_error("Save projection differs from the working Project.");
        }
        const auto committed = writer.commit(prepared, comments);
        if (!committed.accepted) {
            source_authority_->coverage_lost();
            throw std::runtime_error(committed.error);
        }
        for (const auto& [owner, session] : selected) {
            const auto it = std::find_if(
                prepared.targets.begin(), prepared.targets.end(),
                [&](const PreparedYamlTarget& target) {
                    return target.path ==
                           session->source_path().lexically_relative(root_).generic_string();
                });
            if (it == prepared.targets.end())
                continue;
            session->disk_source_ = it->after_source;
            session->disk_revision_ = it->after_revision;
            session->disk_json_ = open_yaml_source(it->after_source).source_json;
            auto filter = paths.find(owner);
            if (filter != paths.end() && filter->second.size() == 1 &&
                filter->second.front() == "/")
                filter = paths.end();
            if (filter == paths.end())
                session->working_json_ = session->disk_json_;
            if (filter == paths.end())
                session->conflicting_paths_.clear();
            else {
                auto& conflicts = session->conflicting_paths_;
                conflicts.erase(std::remove_if(conflicts.begin(), conflicts.end(),
                                               [&](const std::string& conflict) {
                                                   return std::any_of(
                                                       filter->second.begin(), filter->second.end(),
                                                       [&](const std::string& path) {
                                                           return paths_overlap(conflict, path);
                                                       });
                                               }),
                                conflicts.end());
            }
            session->unsaved_patches_.clear();
            const auto remaining_base = Json::parse(session->disk_json_);
            const auto remaining_working = Json::parse(session->working_json_);
            json_delta(&remaining_base, &remaining_working, "", session->unsaved_patches_);
            ++session->working_revision_;
            response.affected_records.push_back(owner);
            if (!source_authority_->acknowledge_own_write(it->path, it->after_revision))
                source_authority_->coverage_lost();
        }
        ++working_revision_;
        response.accepted = true;
        const auto prior = response.snapshot;
        if (std::any_of(response.affected_records.begin(), response.affected_records.end(),
                        [](const auto& owner) { return owner.starts_with("i18n/"); }))
            localization_cache_.reset();
        response.snapshot = snapshot();
        diagnostic_delta(response, prior);
    } catch (const std::exception& exception) {
        response.error = exception.what();
    }
    return response;
}

RoomSessionResult
ProjectSession::patch(std::uint64_t revision, const std::vector<RoomPatch>& patches,
                      const std::map<std::string, std::string>& disk_preconditions)
{
    RoomSessionResult response;
    response.snapshot = snapshot();
    if (revision != working_revision_) {
        response.error = "Stale working revision.";
        return response;
    }
    if (patches.empty()) {
        response.accepted = true;
        return response;
    }
    try {
        for (const auto& [owner, expected] : disk_preconditions) {
            std::filesystem::path path;
            if (owner == "project")
                path = root_ / "project.yaml";
            else if (owner == "editor")
                path = root_ / "editor.yaml";
            else if (owner == "traits")
                path = root_ / "traits.yaml";
            else if (owner.starts_with("i18n/") && tracked_fragment(owner))
                path = root_ / owner;
            else {
                const auto slash = owner.find('/');
                if (slash == std::string::npos)
                    throw std::runtime_error("Invalid disk precondition owner.");
                const auto family = owner.substr(0, slash);
                const auto id = owner.substr(slash + 1);
                if (!record_contracts().contains(family) || !is_id(id))
                    throw std::runtime_error("Invalid disk precondition owner.");
                path = family == "layouts" ? root_ / "records" / family / id / "layout.yaml"
                                           : root_ / "records" / family / (id + ".yaml");
            }
            if (exact_source_revision(read_bytes(path)) != expected)
                throw std::runtime_error("Recovery source conflict for " + owner);
        }
    } catch (const std::exception& error) {
        response.error = error.what();
        return response;
    }
    // Copy-on-write for the complete batch. A failure in any owner leaves every
    // source, diagnostic, and revision exactly as it was before the command.
    auto manifest = source_->clone();
    std::map<std::string, std::unique_ptr<RoomSession>> staged;
    for (const auto& [owner, session] : records_)
        staged.emplace(owner, session->clone());
    std::set<std::string> affected;
    try {
        for (const auto& operation : patches) {
            if (operation.path.starts_with("/localization/")) {
                const auto destination = localization_patch_target(operation.path);
                if (!destination)
                    throw std::runtime_error("Unsupported localization edit path.");
                auto it = staged.find(destination->owner);
                if (it == staged.end()) {
                    std::string error;
                    auto fragment =
                        RoomSession::open_localization_source(root_, destination->owner, error);
                    if (!fragment)
                        throw std::runtime_error("Cannot admit localization source: " + error);
                    it = staged.emplace(destination->owner, std::move(fragment)).first;
                }
                if (exact_source_revision(read_bytes(it->second->source_path())) !=
                    it->second->snapshot().disk_source_revision)
                    throw std::runtime_error("External localization source conflict.");
                auto relative = operation;
                relative.path = destination->relative_path;
                const auto updated =
                    it->second->patch(it->second->snapshot().working_revision, {relative});
                if (!updated.accepted)
                    throw std::runtime_error(updated.error);
                if (!updated.affected_records.empty())
                    affected.insert(destination->owner);
                continue;
            }
            const auto first = operation.path.find('/', 1);
            const auto family =
                operation.path.substr(1, first == std::string::npos ? first : first - 1);
            if (!record_contracts().contains(family) && family != "editor" && family != "traits") {
                // The remaining top-level paths must belong to the admitted
                // manifest; a record-family edit must never become an unknown
                // manifest field by accident.
                if (!Json::parse(manifest->snapshot().source_json).contains(family))
                    throw std::runtime_error("Unsupported native working Project owner.");
                if (exact_source_revision(read_bytes(manifest->source_path())) !=
                    manifest->snapshot().disk_source_revision)
                    throw std::runtime_error("External source conflict for project");
                const auto updated =
                    manifest->patch(manifest->snapshot().working_revision, {operation});
                if (!updated.accepted)
                    throw std::runtime_error(updated.error);
                for (const auto& owner : updated.affected_records)
                    affected.insert(owner);
                continue;
            }
            if (family != "editor" && first == std::string::npos)
                throw std::runtime_error("Record patch requires an ID and field path.");
            const auto field = family == "editor" || family == "traits"
                                   ? first
                                   : operation.path.find('/', first + 1);
            if (field == std::string::npos ||
                (family != "editor" && family != "traits" && field == first + 1))
                throw std::runtime_error("Record patch requires a non-root field path.");
            const auto id = family == "editor" || family == "traits"
                                ? std::string{}
                                : operation.path.substr(first + 1, field - first - 1);
            const auto owner =
                family == "editor" || family == "traits" ? family : family + "/" + id;
            if (family == "editor") {
                const auto end = operation.path.find('/', first + 1);
                const auto section = operation.path.substr(first + 1, end - first - 1);
                if (section != "chapters" && section != "tags" && section != "recordMetadata")
                    throw std::runtime_error("Transient editor state is not tracked Project data.");
            }
            auto it = staged.find(owner);
            if (it == staged.end()) {
                std::string error;
                auto record = family == "editor" ? RoomSession::open_editor_source(root_, error)
                              : family == "traits"
                                  ? RoomSession::open_traits_source(root_, error)
                                  : RoomSession::open_record(root_, family, id, error);
                if (!record)
                    throw std::runtime_error("Cannot admit " + owner + ": " + error);
                it = staged.emplace(owner, std::move(record)).first;
            }
            // A source that changed on disk cannot silently receive a dirty edit
            // based on the old record. Recovery must explicitly rebase it instead.
            if (exact_source_revision(read_bytes(it->second->source_path())) !=
                it->second->snapshot().disk_source_revision)
                throw std::runtime_error("External source conflict for " + owner);
            auto relative = operation;
            relative.path = operation.path.substr(field);
            const auto updated =
                it->second->patch(it->second->snapshot().working_revision, {relative});
            if (!updated.accepted)
                throw std::runtime_error(updated.error);
            if (!updated.affected_records.empty())
                affected.insert(owner);
        }
    } catch (const std::exception& error) {
        response.error = error.what();
        return response;
    }
    // A multi-step editor action can modify and restore a field in one batch.
    // Only the final working values, not transient intermediate steps, count.
    affected.clear();
    if (manifest->snapshot().source_json != source_->snapshot().source_json)
        affected.insert("project");
    for (const auto& [owner, record] : staged) {
        const auto previous = records_.find(owner);
        if (previous == records_.end()) {
            if (record->snapshot().dirty)
                affected.insert(owner);
        } else if (record->snapshot().source_json != previous->second->snapshot().source_json) {
            affected.insert(owner);
        }
    }
    if (affected.empty()) {
        response.accepted = true;
        return response;
    }
    const auto before = response.snapshot;
    source_ = std::move(manifest);
    records_ = std::move(staged);
    for (const auto& owner : affected)
        if (indexed_text_owner(owner))
            index_text_owner(owner, records_.at(owner)->snapshot().source_json);
    if (std::any_of(affected.begin(), affected.end(), localization_record_owner))
        localization_cache_.reset();
    for (const auto& owner : affected)
        if (owner.starts_with("assets/"))
            reindex_asset_consumers(owner.substr(sizeof("assets/") - 1));
    if (std::any_of(affected.begin(), affected.end(),
                    [](const auto& owner) { return owner.starts_with("assets/"); }))
        localization_cache_.reset();
    if (std::any_of(affected.begin(), affected.end(),
                    [](const auto& owner) { return owner.starts_with("i18n/"); }))
        localization_cache_.reset();
    if (std::any_of(affected.begin(), affected.end(),
                    [](const auto& owner) { return owner.starts_with("materials/"); }))
        material_compiler_results_.clear();
    ++working_revision_;
    response.accepted = true;
    response.affected_records.assign(affected.begin(), affected.end());
    response.snapshot = snapshot();
    if (!localization_source_lock_ && localization_cache_ && localization_cache_->accepted) {
        const auto model = Json::parse(localization_cache_->effective_json);
        if (!model.at("sourceLocaleLock").is_null())
            localization_source_lock_ = model.at("sourceLocaleLock").as<std::string>();
    }
    diagnostic_delta(response, before);
    return response;
}

RoomSessionSnapshot RoomSession::snapshot() const
{
    // Layout normalization incorporates companion RML/RCSS/Lua files; Asset
    // validation checks source and attachment membership. They are not pure
    // functions of the YAML revision, so never reuse their local snapshot on
    // that evidence alone.
    if (record_family_ != "layouts" && record_family_ != "assets" && snapshot_cache_ &&
        snapshot_cache_->working_revision == working_revision_ &&
        snapshot_cache_->disk_source_revision == disk_revision_ &&
        snapshot_cache_->source_json == working_json_ &&
        snapshot_cache_->baseline_json == disk_json_ &&
        snapshot_cache_->conflicting_paths == conflicting_paths_)
        return *snapshot_cache_;
    RoomSessionSnapshot state;
    state.working_revision = working_revision_;
    state.disk_source_revision = disk_revision_;
    state.source_json = working_json_;
    state.baseline_json = disk_json_;
    state.dirty = Json::parse(disk_json_) != Json::parse(working_json_);
    state.conflicting_paths = conflicting_paths_;
    const auto result = validate_source(working_json_);
    state.valid = result.accepted;
    state.normalized_json = result.effective_json;
    state.diagnostics = result.diagnostics;
    if (result.accepted && record_family_ == "variables") {
        const auto semantic = validate_variable_semantics(result.effective_json);
        state.valid = semantic.accepted;
        state.diagnostics.insert(state.diagnostics.end(), semantic.diagnostics.begin(),
                                 semantic.diagnostics.end());
        if (!state.valid)
            state.normalized_json.clear();
    }
    if (result.accepted && (record_family_ == "assets" || record_family_ == "animations")) {
        const auto semantic =
            record_family_ == "assets"
                ? validate_asset_local(result.effective_json,
                                       path_.parent_path().parent_path().parent_path())
                : validate_animation_local(result.effective_json);
        state.valid &= semantic.accepted;
        state.diagnostics.insert(state.diagnostics.end(), semantic.diagnostics.begin(),
                                 semantic.diagnostics.end());
        if (!state.valid)
            state.normalized_json.clear();
    }
    if (result.accepted && (record_family_ == "characters" || record_family_ == "archetypes")) {
        const auto normalized = Json::parse(result.effective_json);
        const bool inherits = record_family_ == "characters" && normalized.contains("archetype") &&
                              !normalized.at("archetype").is_null();
        const auto semantic = record_family_ == "archetypes"
                                  ? validate_archetype_local(result.effective_json)
                              : inherits ? ValidationResult{true, {}, {}}
                                         : validate_character_local(result.effective_json);
        state.valid &= semantic.accepted;
        state.diagnostics.insert(state.diagnostics.end(), semantic.diagnostics.begin(),
                                 semantic.diagnostics.end());
        if (!state.valid)
            state.normalized_json.clear();
    }
    if (result.accepted && (record_family_ == "dialogues" || record_family_ == "scenes")) {
        const auto local = validate_dialogue_scene_local(record_family_, result.effective_json);
        state.valid &= local.accepted;
        state.diagnostics.insert(state.diagnostics.end(), local.diagnostics.begin(),
                                 local.diagnostics.end());
        if (!state.valid)
            state.normalized_json.clear();
    }
    if (result.accepted && (record_family_ == "verbs" || record_family_ == "interactions")) {
        const auto local = validate_verb_interaction_local(record_family_, result.effective_json);
        state.valid &= local.accepted;
        state.diagnostics.insert(state.diagnostics.end(), local.diagnostics.begin(),
                                 local.diagnostics.end());
        if (!state.valid)
            state.normalized_json.clear();
    }
    if (result.accepted && record_family_ == "tests") {
        const auto local = validate_test_local(result.effective_json);
        state.valid &= local.accepted;
        state.diagnostics.insert(state.diagnostics.end(), local.diagnostics.begin(),
                                 local.diagnostics.end());
        // Preserve structurally normalized Test data for additional reference
        // diagnostics; a local semantic error still blocks native Save.
    }
    if (result.accepted && !is_project_ && !is_editor_ && !is_traits_ &&
        validation_contract_.empty()) {
        const auto local =
            validate_room_map_local(is_map_ ? "maps" : "rooms", result.effective_json);
        state.valid = local.accepted;
        state.diagnostics.insert(state.diagnostics.end(), local.diagnostics.begin(),
                                 local.diagnostics.end());
        if (!state.valid)
            state.normalized_json.clear();
    }
    const auto value = Json::parse(working_json_);
    if (!is_project_ && !is_editor_ && !is_traits_ && !is_localization_ &&
        (!value.is_object() || !value.contains("id") || !value.at("id").is_string() ||
         value.at("id").as<std::string>() != room_id_)) {
        state.valid = false;
        state.normalized_json.clear();
        state.diagnostics.push_back({"/id", is_map_ ? "map.id_mismatch" : "room.id_mismatch",
                                     is_map_ ? "Map ID must match its source filename."
                                             : "Room ID must match its source filename."});
    }
    snapshot_cache_ = state;
    return state;
}

ValidationResult RoomSession::validate_source(std::string_view source_json) const
{
    if (is_project_)
        return validate_record("WorkspaceManifest", source_json);
    if (is_editor_)
        return validate_record("WorkspaceTrackedEditor", source_json);
    if (record_family_ == "interactables")
        return validate_interactable_source(source_json);
    if (record_family_ == "dialogues")
        return validate_dialogue_source(source_json);
    if (record_family_ == "scenes")
        return validate_scene_source(source_json);
    if (record_family_ == "verbs")
        return validate_verb_source(source_json);
    if (record_family_ == "interactions")
        return validate_interaction_source(source_json);
    if (record_family_ == "tests")
        return validate_test_source(source_json);
    if (record_family_ == "characters")
        return validate_character_source(source_json);
    if (record_family_ == "archetypes")
        return validate_archetype_source(source_json);
    if (record_family_ == "animations")
        return validate_animation_source(source_json);
    if (record_family_ == "assets")
        return validate_asset_source(source_json);
    if (record_family_ == "materials")
        return validate_material_source(source_json);
    if (record_family_ == "scripts") {
        // Workspace script YAML deliberately omits the runtime schema's
        // discriminant. Project it only into the effective, read-only record.
        auto projected = Json::parse(source_json);
        if (projected.is_object() && projected.contains("data") &&
            projected.at("data").is_object() && !projected.at("data").contains("kind"))
            projected["data"].insert_or_assign("kind", "script-module");
        return validate_record(validation_contract_, projected.to_string());
    }
    if (record_family_ == "layouts") {
        std::map<std::string, std::string> companions;
        for (const auto* channel : {"rml", "rcss", "lua"}) {
            const auto path = path_.parent_path() / (std::string("layout.") + channel);
            if (std::filesystem::exists(path) && std::filesystem::is_regular_file(path))
                companions.emplace(channel, read_bytes(path));
        }
        return validate_layout_source(source_json, companions);
    }
    if (!validation_contract_.empty())
        return validate_record(validation_contract_, source_json);
    return is_map_ ? validate_map_source(source_json) : validate_room_source(source_json);
}

RoomSessionResult RoomSession::result(bool accepted, std::string error, bool changed) const
{
    RoomSessionResult response;
    response.accepted = accepted;
    response.error = std::move(error);
    response.snapshot = snapshot();
    if (changed)
        response.affected_records.push_back(is_project_  ? "project"
                                            : is_editor_ ? "editor"
                                            : is_traits_ ? "traits"
                                                         : record_family_ + "/" + room_id_);
    return response;
}

RoomSessionResult RoomSession::patch(std::uint64_t expected_working_revision,
                                     const std::vector<RoomPatch>& operations)
{
    if (expected_working_revision != working_revision_)
        return result(false, "Stale working revision.");
    try {
        const auto previous = snapshot();
        Json next = Json::parse(working_json_);
        std::vector<RoomPatch> resolved;
        const auto baseline = Json::parse(disk_json_);
        const auto baseline_validation = validate_source(disk_json_);
        const auto baseline_effective =
            baseline_validation.accepted
                ? std::optional<Json>{Json::parse(baseline_validation.effective_json)}
                : std::nullopt;
        for (const auto& operation : operations) {
            auto concrete = operation;
            concrete.path = resolve_id_pointer(next, operation.path);
            if (concrete.operation != RoomPatch::Operation::Remove && !is_editor_ && !is_project_) {
                // Normalization expands compact reference IDs into $ref
                // objects. Editor commands can replace either the expanded
                // reference or its ID child; the sparse YAML owns a string.
                const auto effective = snapshot();
                if (!effective.normalized_json.empty()) {
                    const auto normalized = Json::parse(effective.normalized_json);
                    const auto suffix = std::string("/$ref/id");
                    if (concrete.path.ends_with(suffix)) {
                        const auto parent =
                            concrete.path.substr(0, concrete.path.size() - suffix.size());
                        if (const auto raw = at_pointer(next, parent);
                            raw && raw->is_string() &&
                            at_pointer(normalized, parent + "/$ref/id")) {
                            concrete.path = parent;
                            concrete.operation = RoomPatch::Operation::Replace;
                        }
                    } else if (const auto raw = at_pointer(next, concrete.path);
                               raw && raw->is_string()) {
                        const auto expanded = at_pointer(normalized, concrete.path);
                        const auto replacement = Json::parse(concrete.value_json);
                        if (expanded && expanded->is_object() && expanded->contains("$ref") &&
                            replacement.is_object() && replacement.contains("$ref")) {
                            const auto& expected = expanded->at("$ref");
                            const auto& next_ref = replacement.at("$ref");
                            if (!next_ref.is_object() || !next_ref.contains("id") ||
                                !next_ref.at("id").is_string() ||
                                !next_ref.contains("collection") ||
                                next_ref.at("collection") != expected.at("collection"))
                                throw std::runtime_error(
                                    "Normalized reference has an incompatible collection or ID.");
                            concrete.value_json = next_ref.at("id").to_string();
                        }
                    }
                }
            }
            if (concrete.operation == RoomPatch::Operation::Add && !is_project_) {
                if (is_editor_)
                    materialize_editor_metadata_parents(next, concrete, resolved);
                const auto current_validation = validate_source(next.to_string());
                if (current_validation.accepted)
                    materialize_implicit_parents(
                        next, Json::parse(current_validation.effective_json), concrete, resolved);
            }
            // Editor commands refer to normalized effective records. If an
            // optional source field is supplied by normalization, project a
            // replace onto its sparse source owner as add; when the inverse
            // restores the implicit baseline value, omit the field again.
            if (concrete.operation == RoomPatch::Operation::Replace) {
                const auto current = at_pointer(next, concrete.path);
                const auto baseline = Json::parse(disk_json_);
                const auto original = at_pointer(baseline, concrete.path);
                if (!current) {
                    const auto effective = snapshot();
                    if (effective.normalized_json.empty() ||
                        !at_pointer(Json::parse(effective.normalized_json), concrete.path))
                        throw std::runtime_error(
                            "Normalized patch path cannot be projected to sparse source.");
                    const auto parent_path = concrete.path.substr(0, concrete.path.rfind('/'));
                    if (!at_pointer(next, parent_path))
                        throw std::runtime_error(
                            "Normalized patch requires unsupported source parent projection.");
                    concrete.operation = RoomPatch::Operation::Add;
                } else if (!original && !is_project_) {
                    const auto baseline_effective = validate_source(disk_json_);
                    if (baseline_effective.accepted &&
                        at_pointer(Json::parse(baseline_effective.effective_json), concrete.path) ==
                            std::optional<Json>{Json::parse(concrete.value_json)}) {
                        concrete.operation = RoomPatch::Operation::Remove;
                        concrete.value_json.clear();
                    }
                }
            }
            apply_patch(next, concrete);
            if (baseline_effective && !is_project_)
                omit_restored_default_parents(next, baseline, *baseline_effective, concrete.path);
            if (is_editor_ && concrete.operation == RoomPatch::Operation::Remove)
                omit_empty_editor_metadata_parents(next, baseline, concrete.path);
            resolved.push_back(std::move(concrete));
        }
        if (next.to_string() == working_json_)
            return result(true);
        // No structural/semantic validity gate here: representable invalid working
        // records must be diagnosable without obligating a Save.
        working_json_ = next.to_string();
        unsaved_patches_.insert(unsaved_patches_.end(), resolved.begin(), resolved.end());
        if (Json::parse(working_json_) == Json::parse(disk_json_))
            unsaved_patches_.clear();
        // A user may resolve a conflicting field by editing back to the
        // verified disk value, without explicitly invoking Use Disk.
        conflicting_paths_.erase(
            std::remove_if(conflicting_paths_.begin(), conflicting_paths_.end(),
                           [&](const std::string& path) {
                               return at_pointer(Json::parse(working_json_), path) ==
                                      at_pointer(Json::parse(disk_json_), path);
                           }),
            conflicting_paths_.end());
        ++working_revision_;
        auto response = result(true, {}, true);
        diagnostic_delta(response, previous);
        return response;
    } catch (const std::exception& e) {
        return result(false, e.what());
    }
}

RoomSessionResult RoomSession::reconcile_disk()
{
    try {
        const auto latest_source = read_bytes(path_);
        const auto latest_revision = exact_source_revision(latest_source);
        if (latest_revision == disk_revision_)
            return result(true);
        const auto opened = open_yaml_source(latest_source);
        if (!opened.accepted)
            return result(false, "Invalid external YAML source: " + opened.error);
        const auto base = Json::parse(disk_json_);
        const auto local = Json::parse(working_json_);
        const auto external = Json::parse(opened.source_json);
        if (!external.is_object() || (!is_project_ && !is_editor_ && !is_traits_ &&
                                      (!external.contains("id") || external.at("id") != room_id_)))
            return result(false, "External source ID or structure is invalid.");
        std::vector<RoomPatch> local_diff;
        std::vector<RoomPatch> external_diff;
        json_delta(&base, &local, "", local_diff);
        json_delta(&base, &external, "", external_diff);
        Json merged = local;
        std::vector<std::string> collisions;
        for (const auto& change : external_diff) {
            if (std::any_of(local_diff.begin(), local_diff.end(), [&](const RoomPatch& mine) {
                    return paths_overlap(change.path, mine.path);
                })) {
                for (const auto& mine : local_diff)
                    if (paths_overlap(change.path, mine.path))
                        collisions.push_back(mine.path);
                continue;
            }
            apply_patch(merged, change);
        }
        // Preserve earlier unresolved conflict state across further disjoint
        // external modifications. A resolution is explicit and owner-scoped.
        collisions.insert(collisions.end(), conflicting_paths_.begin(), conflicting_paths_.end());
        std::sort(collisions.begin(), collisions.end());
        collisions.erase(std::unique(collisions.begin(), collisions.end()), collisions.end());
        const auto before = snapshot();
        disk_source_ = latest_source;
        disk_revision_ = latest_revision;
        disk_json_ = opened.source_json;
        working_json_ = merged.to_string();
        conflicting_paths_ = std::move(collisions);
        unsaved_patches_.clear();
        std::vector<RoomPatch> remaining;
        json_delta(&external, &merged, "", remaining);
        unsaved_patches_ = std::move(remaining);
        ++working_revision_;
        auto response = result(true, {}, true);
        diagnostic_delta(response, before);
        return response;
    } catch (const std::exception& exception) {
        return result(false, exception.what());
    }
}

RoomSessionResult RoomSession::use_disk()
{
    try {
        if (exact_source_revision(read_bytes(path_)) != disk_revision_)
            return result(false, "External source changed since conflict was reviewed.");
        const auto before = snapshot();
        const bool changed = before.dirty || !conflicting_paths_.empty();
        working_json_ = disk_json_;
        unsaved_patches_.clear();
        conflicting_paths_.clear();
        if (changed)
            ++working_revision_;
        auto response = result(true, {}, changed);
        diagnostic_delta(response, before);
        return response;
    } catch (const std::exception& exception) {
        return result(false, exception.what());
    }
}

RoomSessionResult RoomSession::use_disk_paths(const std::vector<std::string>& paths)
{
    try {
        if (exact_source_revision(read_bytes(path_)) != disk_revision_)
            return result(false, "External source changed since conflict was reviewed.");
        const auto before = snapshot();
        Json next = Json::parse(working_json_);
        const auto disk = Json::parse(disk_json_);
        for (const auto& path : paths)
            select_path(next, disk, path);
        std::vector<std::string> conflicts;
        for (const auto& path : conflicting_paths_)
            if (std::none_of(paths.begin(), paths.end(),
                             [&](const std::string& root) { return paths_overlap(path, root); }))
                conflicts.push_back(path);
        const bool changed =
            next.to_string() != working_json_ || conflicts.size() != conflicting_paths_.size();
        if (changed) {
            working_json_ = next.to_string();
            conflicting_paths_ = std::move(conflicts);
            unsaved_patches_.clear();
            json_delta(&disk, &next, "", unsaved_patches_);
            ++working_revision_;
        }
        auto response = result(true, {}, changed);
        diagnostic_delta(response, before);
        return response;
    } catch (const std::exception& exception) {
        return result(false, exception.what());
    }
}

RoomSessionResult RoomSession::save(std::string_view expected_disk_revision,
                                    const std::vector<std::string>& invalid_source_paths)
{
    if (expected_disk_revision != disk_revision_)
        return result(false, "Stale disk source revision.");
    if (unsaved_patches_.empty())
        return result(true);
    try {
        const auto working = Json::parse(working_json_);
        if (!is_project_ && !is_editor_ && !is_traits_ &&
            (!working.is_object() || !working.contains("id") || !working.at("id").is_string() ||
             working.at("id").as<std::string>() != room_id_))
            return result(false, "Cannot save a Room whose ID does not match its filename.");
        if (is_project_ && !snapshot().valid)
            return result(false, "Cannot save a structurally invalid Project manifest.");
        if (!is_project_ && !snapshot().valid)
            return result(false, "Cannot save an invalid Room or Map source.");
        // Persist the final source-space delta, never temporary invalid intermediate
        // edits from the dirty session. This also preserves undo and generic batching.
        std::vector<YamlValueEdit> edits;
        const auto disk = Json::parse(disk_json_);
        source_diff(&disk, &working, "", unsaved_patches_, edits);
        const auto edited = edit_yaml_source(disk_source_, edits);
        if (!edited.accepted)
            return result(false, "Room source edit rejected: " + edited.error);
        if (Json::parse(edited.source_json) != Json::parse(working_json_))
            return result(false, "Room source projection does not match the working Project.");

        // The same journaling writer handles both a standalone Room and Project manifest;
        // it never reopens or hashes unrelated workspace source/Asset files.
        const auto project_root = is_project_ || is_editor_ || is_traits_
                                      ? path_.parent_path()
                                      : path_.parent_path().parent_path().parent_path();
        YamlTransactionService writer(project_root);
        writer.set_invalid_sources(invalid_source_paths, false);
        YamlTransactionTarget target{path_.lexically_relative(project_root).generic_string(),
                                     disk_revision_, disk_source_, std::move(edits)};
        const auto preflight = writer.prepare({target}, TransactionDecision::UseEditDecisions);
        if (!preflight.accepted)
            return result(false, preflight.error);
        if (preflight.targets.size() != 1)
            return result(false, "Dirty source produced no physical transaction target.");
        const auto& proposed = preflight.targets.front();
        if (proposed.before_revision == disk_revision_ && proposed.after_source != edited.source)
            return result(false,
                          "Native YAML transaction projection disagrees with working source.");
        const auto merged = open_yaml_source(proposed.after_source);
        if (!merged.accepted)
            return result(false, "Native merged YAML source cannot be reopened.");
        const auto merged_json = Json::parse(merged.source_json);
        for (const auto& edit : target.edits)
            if (at_pointer(merged_json, edit.path) != at_pointer(working, edit.path))
                return result(false, "Rebased YAML source does not preserve the local mutation.");
        if (is_project_ && !validate_record("WorkspaceManifest", merged.source_json).accepted)
            return result(false, "Rebased Project manifest failed validation.");
        if (!is_project_ && !is_editor_ && !is_traits_ &&
            (!merged_json.is_object() || !merged_json.contains("id") ||
             !merged_json.at("id").is_string() || merged_json.at("id") != room_id_))
            return result(false, "Rebased Room source ID does not match filename.");
        if (!is_project_ && !is_editor_ && !is_traits_) {
            const auto normalized = validate_source(merged.source_json);
            const auto* attached =
                merged_json.contains("archetype") ? &merged_json.at("archetype") : nullptr;
            if (!normalized.accepted ||
                ((record_family_ == "rooms" || record_family_ == "maps") &&
                 !validate_room_map_local(record_family_, normalized.effective_json).accepted) ||
                (record_family_ == "characters" && (!attached || attached->is_null()) &&
                 !validate_character_local(normalized.effective_json).accepted) ||
                (record_family_ == "archetypes" &&
                 !validate_archetype_local(normalized.effective_json).accepted) ||
                (record_family_ == "assets" &&
                 !validate_asset_local(normalized.effective_json, project_root).accepted) ||
                (record_family_ == "animations" &&
                 !validate_animation_local(normalized.effective_json).accepted))
                return result(false, "Rebased Project record failed native validation.");
        }
        const auto committed = writer.commit(preflight, TransactionDecision::UseEditDecisions);
        if (!committed.accepted)
            return result(false, committed.error);
        disk_source_ = proposed.after_source;
        disk_revision_ = exact_source_revision(disk_source_);
        disk_json_ = merged.source_json;
        if (Json::parse(working_json_) != merged_json) {
            working_json_ = merged.source_json;
            ++working_revision_;
        }
        unsaved_patches_.clear();
        return result(true, {}, true);
    } catch (const std::exception& e) {
        return result(false, e.what());
    }
}

} // namespace noveltea::authoring
