#include "room_session.hpp"

#include <jsoncons/json.hpp>
#include <jsoncons_ext/jsonpointer/jsonpointer.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <random>
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

// Use the same sha256:<hex> source identity as the existing Project Workspace.
// Save also checks original bytes exactly to eliminate reliance on the digest alone.
std::string source_revision(std::string_view source)
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

void apply_patch(Json& value, const RoomPatch& patch)
{
    check_pointer(patch.path);
    const jsoncons::jsonpointer::json_pointer pointer(patch.path);
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

std::filesystem::path temporary_path(const std::filesystem::path& path)
{
    // A random staging name is sufficient for this single-source certification seam;
    // #480 supplies exclusive writer coordination and crash-safe persistence.
    std::random_device entropy;
    for (unsigned int attempt = 0; attempt < 20; ++attempt) {
        auto candidate = path;
        candidate += ".noveltea-session-" + std::to_string(entropy()) + "-" +
                     std::to_string(attempt) + ".tmp";
        if (!std::filesystem::exists(candidate))
            return candidate;
    }
    throw std::runtime_error("Could not select a Room staging path.");
}
} // namespace

RoomSession::RoomSession(std::filesystem::path path, std::string room_id, std::string source,
                         std::string source_json)
    : path_(std::move(path)), room_id_(std::move(room_id)), disk_source_(std::move(source)),
      disk_revision_(source_revision(disk_source_)), disk_json_(source_json),
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

RoomSessionSnapshot RoomSession::snapshot() const
{
    RoomSessionSnapshot state;
    state.working_revision = working_revision_;
    state.disk_source_revision = disk_revision_;
    state.source_json = working_json_;
    state.dirty = Json::parse(disk_json_) != Json::parse(working_json_);
    const auto result = validate_room_source(working_json_);
    state.valid = result.accepted;
    state.normalized_json = result.effective_json;
    state.diagnostics = result.diagnostics;
    const auto value = Json::parse(working_json_);
    if (!value.is_object() || !value.contains("id") || !value.at("id").is_string() ||
        value.at("id").as<std::string>() != room_id_) {
        state.valid = false;
        state.normalized_json.clear();
        state.diagnostics.push_back(
            {"/id", "room.id_mismatch", "Room ID must match its source filename."});
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
        response.affected_records.push_back("rooms/" + room_id_);
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
        for (const auto& operation : operations)
            apply_patch(next, operation);
        if (next.to_string() == working_json_)
            return result(true);
        // No structural/semantic validity gate here: representable invalid working
        // records must be diagnosable without obligating a Save.
        working_json_ = next.to_string();
        unsaved_patches_.insert(unsaved_patches_.end(), operations.begin(), operations.end());
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

RoomSessionResult RoomSession::save(std::string_view expected_disk_revision)
{
    if (expected_disk_revision != disk_revision_)
        return result(false, "Stale disk source revision.");
    if (unsaved_patches_.empty())
        return result(true);
    try {
        const auto working = Json::parse(working_json_);
        if (!working.is_object() || !working.contains("id") || !working.at("id").is_string() ||
            working.at("id").as<std::string>() != room_id_)
            return result(false, "Cannot save a Room whose ID does not match its filename.");
        if (read_bytes(path_) != disk_source_)
            return result(false, "Room source changed on disk since admission.");
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

        // #477 is a single-source certification seam. The full multi-file locking,
        // journaling, and cross-process transaction coordinator belongs to #480.
        const auto staged = temporary_path(path_);
        try {
            {
                std::ofstream output(staged, std::ios::binary | std::ios::trunc);
                if (!output || !(output << edited.source) || !output.flush())
                    throw std::runtime_error("Cannot stage Room source.");
            }
            if (read_bytes(path_) != disk_source_)
                throw std::runtime_error("Room source changed during scoped Save.");
            std::filesystem::rename(staged, path_);
        } catch (...) {
            std::error_code ignored;
            std::filesystem::remove(staged, ignored);
            throw;
        }
        disk_source_ = edited.source;
        disk_revision_ = source_revision(disk_source_);
        disk_json_ = edited.source_json;
        unsaved_patches_.clear();
        return result(true, {}, true);
    } catch (const std::exception& e) {
        return result(false, e.what());
    }
}

} // namespace noveltea::authoring
