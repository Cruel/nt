#include "room_session.hpp"
#include "property_semantics.hpp"
#include "character_archetype_semantics.hpp"
#include "asset_animation_semantics.hpp"

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

std::vector<ProjectFile> inventory_project(const std::filesystem::path& root, const Json& manifest)
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
        if (!std::filesystem::is_regular_file(root / required))
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
                 !std::filesystem::is_regular_file(it->path() / "layout.yaml")))
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
            const auto opened = open_yaml_source(read_bytes(it->path()));
            if (!opened.accepted)
                throw std::runtime_error("Invalid tracked YAML " + relative + ": " + opened.error);
            if (!Json::parse(opened.source_json).is_object())
                throw std::runtime_error("Tracked Project YAML must be an object: " + relative);
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
                if (!decoded.accepted)
                    throw std::runtime_error("Invalid record YAML: " + relative);
                const auto value = Json::parse(decoded.source_json);
                if (!value.is_object() || !value.contains("id") || !value.at("id").is_string() ||
                    value.at("id") != leaf.substr(0, leaf.size() - 5))
                    throw std::runtime_error("Record ID does not match filename: " + relative);
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
                        const auto companion =
                            it->path().parent_path() / (std::string("layout.") + channel);
                        if ((mode == "file") != std::filesystem::exists(companion))
                            throw std::runtime_error(
                                "Layout companion and source selector disagree: " +
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
RoomSession::open_project_source(const std::filesystem::path& project_root, std::string& error)
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
        auto inventory = inventory_project(project_root, Json::parse(opened.source_json));
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

std::unique_ptr<ProjectSession> ProjectSession::open(const std::filesystem::path& root,
                                                     std::string& error)
{
    auto source = RoomSession::open_project_source(root, error);
    if (!source)
        return nullptr;
    try {
        auto authority = std::make_unique<SourceAuthority>(root);
        if (!authority->initialize(error))
            return nullptr;
        auto traits = RoomSession::open_traits_source(root, error);
        if (!traits)
            return nullptr;
        if (!RoomSession::open_editor_source(root, error))
            return nullptr;
        // Check tracked source validity at Project admission, but keep their
        // working sessions lazy: opening a Project must not publish untouched
        // owners or change the worker's initial record-snapshot contract.
        return std::unique_ptr<ProjectSession>(new ProjectSession(
            std::move(source), std::move(authority), root, traits->snapshot().normalized_json));
    } catch (const std::exception& e) {
        error = e.what();
        return nullptr;
    }
}

RoomSessionSnapshot ProjectSession::snapshot() const
{
    auto state = source_->snapshot();
    const bool manifest_dirty = state.dirty;
    state.working_revision = working_revision_;
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
    }
    // Locale variants are separate tracked YAML sources; inspect their semantic
    // Asset targets when an Asset owner or manifest enters the working session.
    if (manifest_dirty || std::any_of(records_.begin(), records_.end(), [](const auto& entry) {
            return entry.first.starts_with("assets/");
        })) {
        const auto aliases = validate_project_asset_aliases(root_, resolve_record);
        state.valid &= aliases.accepted;
        state.diagnostics.insert(state.diagnostics.end(), aliases.diagnostics.begin(),
                                 aliases.diagnostics.end());
        const auto locales = validate_asset_localizations(root_, resolve_record);
        state.valid &= locales.accepted;
        state.diagnostics.insert(state.diagnostics.end(), locales.diagnostics.begin(),
                                 locales.diagnostics.end());
    }
    // An Instance is owned by the manifest rather than by a separate YAML
    // record. Validate only changed Instances and Instances whose Definition
    // is resident, not every unrelated definition in the Project.
    const bool inspected_definition =
        std::any_of(records_.begin(), records_.end(),
                    [](const auto& record) { return record.first.starts_with("interactables/"); });
    if ((manifest_dirty || inspected_definition) && !state.normalized_json.empty() &&
        !traits_json.empty()) {
        const auto working = Json::parse(state.normalized_json);
        const auto authored = Json::parse(state.source_json);
        const auto baseline = Json::parse(state.baseline_json);
        const auto* instances = working.contains("interactableInstances")
                                    ? &working.at("interactableInstances")
                                    : nullptr;
        const auto* old_instances = baseline.contains("interactableInstances")
                                        ? &baseline.at("interactableInstances")
                                        : nullptr;
        const auto* authored_instances = authored.contains("interactableInstances")
                                             ? &authored.at("interactableInstances")
                                             : nullptr;
        std::map<std::string, std::optional<std::string>> definitions;
        if (instances && instances->is_object()) {
            for (const auto& entry : instances->object_range()) {
                const auto id = std::string(entry.key());
                const auto definition =
                    entry.value().at("definition").at("$ref").at("id").as<std::string>();
                const auto* old =
                    old_instances && old_instances->contains(id) ? &old_instances->at(id) : nullptr;
                const auto* source = authored_instances && authored_instances->contains(id)
                                         ? &authored_instances->at(id)
                                         : nullptr;
                if (old && source && *old == *source &&
                    !records_.contains("interactables/" + definition))
                    continue;
                auto found = definitions.find(definition);
                if (found == definitions.end()) {
                    std::optional<std::string> effective;
                    if (const auto record = records_.find("interactables/" + definition);
                        record != records_.end()) {
                        const auto snapshot = record->second->snapshot();
                        if (snapshot.valid)
                            effective = snapshot.normalized_json;
                    } else if (is_id(definition)) {
                        std::string error;
                        auto record =
                            RoomSession::open_record(root_, "interactables", definition, error);
                        if (record && record->snapshot().valid)
                            effective = record->snapshot().normalized_json;
                    }
                    found = definitions.emplace(definition, effective).first;
                }
                if (!found->second)
                    continue; // malformed/missing Definition is diagnosed at its source boundary
                const auto semantic = validate_interactable_instance(entry.value().to_string(),
                                                                     *found->second, traits_json);
                state.valid &= semantic.accepted;
                for (auto diagnostic : semantic.diagnostics) {
                    diagnostic.path =
                        "/interactableInstances/" + pointer_token(id) + diagnostic.path;
                    state.diagnostics.push_back(std::move(diagnostic));
                }
            }
        }
    }
    return state;
}

std::map<std::string, RoomSessionSnapshot> ProjectSession::record_snapshots() const
{
    std::map<std::string, RoomSessionSnapshot> result;
    for (const auto& [owner, session] : records_)
        result.emplace(owner, session->snapshot());
    return result;
}

RoomSessionResult ProjectSession::inspect_record(std::string_view owner)
{
    RoomSessionResult result;
    try {
        const auto name = std::string(owner);
        const auto slash = name.find('/');
        const auto family = name.substr(0, slash);
        const auto id = slash == std::string::npos ? std::string() : name.substr(slash + 1);
        if (name != "editor" && name != "traits" &&
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
                                             : RoomSession::open_record(root_, family, id, error);
            if (!record)
                result.error = error;
            else {
                records_.emplace(name, std::move(record));
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
                const bool invalid_selected_record =
                    diagnostic.path.starts_with("/" + owner + "/") &&
                    (all_paths || std::any_of(filter->second.begin(), filter->second.end(),
                                              [&](const std::string& path) {
                                                  return paths_overlap("/" + owner + path,
                                                                       diagnostic.path);
                                              }));
                const bool trait_dependency =
                    owner == "traits" && (diagnostic.code.starts_with("authoring.trait.") ||
                                          diagnostic.code == "authoring.trait.missing_reference");
                const bool variable_dependency =
                    !variable_id.empty() &&
                    diagnostic.code == "authoring.condition.variable-type-mismatch" &&
                    diagnostic.message.find("'" + variable_id + "'") != std::string::npos;
                const bool instance_dependency =
                    owner == "project" && diagnostic.path.starts_with("/interactableInstances/") &&
                    (diagnostic.code.starts_with("authoring.trait.") ||
                     diagnostic.code.starts_with("authoring.interactable.")) &&
                    (all_paths || std::any_of(filter->second.begin(), filter->second.end(),
                                              [&](const std::string& path) {
                                                  return paths_overlap(path, diagnostic.path);
                                              }));
                if (invalid_selected_record || trait_dependency || variable_dependency ||
                    instance_dependency)
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
    ++working_revision_;
    response.accepted = true;
    response.affected_records.assign(affected.begin(), affected.end());
    response.snapshot = snapshot();
    diagnostic_delta(response, before);
    return response;
}

RoomSessionSnapshot RoomSession::snapshot() const
{
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
    if (!is_project_ && !is_editor_ && !is_traits_ &&
        (!value.is_object() || !value.contains("id") || !value.at("id").is_string() ||
         value.at("id").as<std::string>() != room_id_)) {
        state.valid = false;
        state.normalized_json.clear();
        state.diagnostics.push_back({"/id", is_map_ ? "map.id_mismatch" : "room.id_mismatch",
                                     is_map_ ? "Map ID must match its source filename."
                                             : "Room ID must match its source filename."});
    }
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
