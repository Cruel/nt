#include "room_session.hpp"

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
    if (before && after && before->is_object() && after->is_object()) {
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

bool is_id(std::string_view id)
{
    static const std::regex pattern(R"(^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$)");
    return std::regex_match(id.begin(), id.end(), pattern);
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
        error.clear();
        return result;
    } catch (const std::exception& e) {
        error = e.what();
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
        return std::unique_ptr<ProjectSession>(
            new ProjectSession(std::move(source), std::move(authority), root));
    } catch (const std::exception& e) {
        error = e.what();
        return nullptr;
    }
}

RoomSessionSnapshot ProjectSession::snapshot() const
{
    auto state = source_->snapshot();
    state.working_revision = working_revision_;
    for (const auto& [owner, session] : records_) {
        const auto record = session->snapshot();
        state.dirty |= record.dirty;
        state.valid &= record.valid;
        for (auto diagnostic : record.diagnostics) {
            diagnostic.path = "/" + owner + diagnostic.path;
            state.diagnostics.push_back(std::move(diagnostic));
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
        if ((family != "rooms" && family != "maps") || !is_id(id)) {
            result.error = "Unsupported native record owner.";
        } else if (const auto found = records_.find(name); found != records_.end()) {
            if (exact_source_revision(read_bytes(found->second->source_path())) !=
                found->second->snapshot().disk_source_revision)
                result.error = "External source conflict for " + name;
            else
                result.accepted = true;
        } else {
            std::string error;
            auto record = family == "rooms" ? RoomSession::open(root_, id, error)
                                            : RoomSession::open_map(root_, id, error);
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
            else {
                const auto slash = owner.find('/');
                if (slash == std::string::npos)
                    throw std::runtime_error("Invalid disk precondition owner.");
                const auto family = owner.substr(0, slash);
                const auto id = owner.substr(slash + 1);
                if ((family != "rooms" && family != "maps") || !is_id(id))
                    throw std::runtime_error("Invalid disk precondition owner.");
                path = root_ / "records" / family / (id + ".yaml");
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
            if (family != "rooms" && family != "maps") {
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
            if (first == std::string::npos)
                throw std::runtime_error("Record patch requires an ID and field path.");
            const auto field = operation.path.find('/', first + 1);
            if (field == std::string::npos || field == first + 1)
                throw std::runtime_error("Record patch requires a non-root field path.");
            const auto id = operation.path.substr(first + 1, field - first - 1);
            const auto owner = family + "/" + id;
            auto it = staged.find(owner);
            if (it == staged.end()) {
                std::string error;
                auto record = family == "rooms" ? RoomSession::open(root_, id, error)
                                                : RoomSession::open_map(root_, id, error);
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
    state.dirty = Json::parse(disk_json_) != Json::parse(working_json_);
    const auto result = is_project_ ? validate_record("WorkspaceManifest", working_json_)
                        : is_map_   ? validate_map_source(working_json_)
                                    : validate_room_source(working_json_);
    state.valid = result.accepted;
    state.normalized_json = result.effective_json;
    state.diagnostics = result.diagnostics;
    if (result.accepted && !is_project_) {
        const auto local =
            validate_room_map_local(is_map_ ? "maps" : "rooms", result.effective_json);
        state.valid = local.accepted;
        state.diagnostics.insert(state.diagnostics.end(), local.diagnostics.begin(),
                                 local.diagnostics.end());
        if (!state.valid)
            state.normalized_json.clear();
    }
    const auto value = Json::parse(working_json_);
    if (!is_project_ &&
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

RoomSessionResult RoomSession::result(bool accepted, std::string error, bool changed) const
{
    RoomSessionResult response;
    response.accepted = accepted;
    response.error = std::move(error);
    response.snapshot = snapshot();
    if (changed)
        response.affected_records.push_back(is_project_ ? "project"
                                            : is_map_   ? "maps/" + room_id_
                                                        : "rooms/" + room_id_);
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
        for (const auto& operation : operations) {
            auto concrete = operation;
            concrete.path = resolve_id_pointer(next, operation.path);
            apply_patch(next, concrete);
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
        ++working_revision_;
        auto response = result(true, {}, true);
        diagnostic_delta(response, previous);
        return response;
    } catch (const std::exception& e) {
        return result(false, e.what());
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
        if (!is_project_ &&
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
        const auto project_root =
            is_project_ ? path_.parent_path() : path_.parent_path().parent_path().parent_path();
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
        if (!is_project_ && (!merged_json.is_object() || !merged_json.contains("id") ||
                             !merged_json.at("id").is_string() || merged_json.at("id") != room_id_))
            return result(false, "Rebased Room source ID does not match filename.");
        if (!is_project_) {
            const auto normalized = is_map_ ? validate_map_source(merged.source_json)
                                            : validate_room_source(merged.source_json);
            if (!normalized.accepted ||
                !validate_room_map_local(is_map_ ? "maps" : "rooms", normalized.effective_json)
                     .accepted)
                return result(false, "Rebased Room or Map failed semantic validation.");
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
