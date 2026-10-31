#include "yaml_transaction.hpp"

#include "contracts.hpp"
#include "source_authority.hpp"

#include <jsoncons/json.hpp>
#include <jsoncons_ext/jsonpointer/jsonpointer.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <tuple>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <fstream>
#include <iterator>
#include <random>
#include <regex>
#include <set>
#include <stdexcept>
#include <system_error>
#include <utility>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <unistd.h>
#endif

namespace noveltea::authoring {
namespace {
namespace fs = std::filesystem;
using Json = jsoncons::ojson;

constexpr std::string_view journal_root = ".noveltea/transactions";
constexpr std::string_view lock_name = ".writer-lock";
constexpr std::string_view guard_name = ".writer-lock-reclaim";
constexpr std::string_view journal_schema = "noveltea.workspace.transaction";

std::string token()
{
    static std::atomic<std::uint64_t> counter{0};
    std::random_device random;
    return std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" +
           std::to_string(random()) + "-" + std::to_string(++counter);
}

std::uint64_t process_id()
{
#ifdef _WIN32
    return GetCurrentProcessId();
#else
    return static_cast<std::uint64_t>(getpid());
#endif
}

// Only a provably dead owner may have its lock reclaimed. Indeterminate == busy.
bool proven_dead(std::uint64_t pid)
{
    if (pid == 0 || pid > 0x7fffffff)
        return false;
#ifdef _WIN32
    HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
    if (!handle)
        return GetLastError() == ERROR_INVALID_PARAMETER;
    DWORD code = STILL_ACTIVE;
    const bool obtained = GetExitCodeProcess(handle, &code) != 0;
    CloseHandle(handle);
    return obtained && code != STILL_ACTIVE;
#else
    if (kill(static_cast<pid_t>(pid), 0) == 0)
        return false;
    return errno == ESRCH;
#endif
}

void sync_file(const fs::path& path)
{
#ifdef _WIN32
    HANDLE handle = CreateFileW(path.c_str(), GENERIC_WRITE,
                                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        throw std::runtime_error("Cannot open staged source for durability sync.");
    const bool synced = FlushFileBuffers(handle) != 0;
    CloseHandle(handle);
    if (!synced)
        throw std::runtime_error("Cannot flush staged source.");
#else
    const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        throw std::runtime_error("Cannot open staged source for durability sync.");
    const bool synced = fsync(fd) == 0;
    close(fd);
    if (!synced)
        throw std::runtime_error("Cannot flush staged source.");
#endif
}

void sync_directory(const fs::path& path)
{
#ifndef _WIN32
    const int fd = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0)
        throw std::runtime_error("Cannot open transaction directory for durability sync.");
    const bool synced = fsync(fd) == 0;
    close(fd);
    if (!synced)
        throw std::runtime_error("Cannot flush transaction directory.");
#else
    (void)path;
#endif
}

std::string read_source(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read Project transaction source: " + path.string());
    std::string result{std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
    if (input.bad())
        throw std::runtime_error("Cannot finish reading Project transaction source.");
    return result;
}

bool regular_source_exists(const fs::path& path)
{
    std::error_code ec;
    const auto status = fs::symlink_status(path, ec);
    if (ec == std::errc::no_such_file_or_directory)
        return false;
    if (ec)
        throw std::runtime_error("Cannot inspect Project transaction path: " + path.string());
    if (status.type() == fs::file_type::not_found)
        return false;
    if (!fs::is_regular_file(status))
        throw std::runtime_error("Transaction source is not a regular file: " + path.string());
    return true;
}

std::string revision(const fs::path& path)
{
    if (!regular_source_exists(path))
        return "absent";
    const auto before = fs::last_write_time(path);
    const auto size = fs::file_size(path);
    const auto bytes = read_source(path);
    if (bytes.size() != size || fs::last_write_time(path) != before || fs::file_size(path) != size)
        throw std::runtime_error("Project source changed during exact revision read.");
    return exact_source_revision(bytes);
}

void write_atomic(const fs::path& path, std::string_view contents)
{
    fs::create_directories(path.parent_path());
    const auto temp = fs::path(path.string() + ".noveltea-" + token() + ".tmp");
    try {
        {
            std::ofstream file(temp, std::ios::binary | std::ios::trunc);
            if (!file ||
                !file.write(contents.data(), static_cast<std::streamsize>(contents.size())) ||
                !file.flush())
                throw std::runtime_error("Cannot stage Project transaction bytes.");
        }
        sync_file(temp);
#ifdef _WIN32
        // std::filesystem::rename cannot atomically replace an existing file on
        // every Windows filesystem. MoveFileExW supplies replacement semantics.
        if (!MoveFileExW(temp.c_str(), path.c_str(),
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("Cannot atomically install staged Project bytes.");
#else
        fs::rename(temp, path);
#endif
        sync_directory(path.parent_path());
    } catch (...) {
        std::error_code ignored;
        fs::remove(temp, ignored);
        throw;
    }
}

// Approval tokens are cryptographic authorization evidence, not source revisions.
std::string approval_sha256(std::string_view source)
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

std::string approval_for(const PreparedYamlTransaction& prepared)
{
    std::string material = std::to_string(static_cast<int>(prepared.decision)) + ":";
    for (const auto& target : prepared.targets)
        material += std::to_string(target.path.size()) + ":" + target.path + ":" +
                    target.before_revision + ":" + target.after_revision + ":" +
                    (target.erase ? "delete" : "write") + ";";
    // Review/approval tokens are authorization evidence, not local source
    // identities. Retain the cryptographic SHA-256 contract.
    return approval_sha256(material);
}

bool valid_revision(std::string_view text)
{
    return source_revision_algorithm(text) != SourceRevisionAlgorithm::Invalid;
}

ValidationResult effective_record_for_compaction(std::string_view family, std::string_view source)
{
    return normalize_compaction_source(family, source);
}

std::vector<std::string> hash_fragments(std::string_view source)
{
    // Deliberately conservative: a '#' in a scalar is also retained in the
    // evidence inventory. An emitter may never silently delete or rewrite
    // comments while claiming to perform formatting only.
    std::vector<std::string> fragments;
    for (std::size_t start = 0; start < source.size();) {
        const auto end = source.find('\n', start);
        auto line = source.substr(start, (end == source.npos ? source.size() : end) - start);
        // CRLF and LF are equivalent line separators for comment text. Preserve
        // every byte of the actual comment, but exclude the CR delimiter.
        if (!line.empty() && line.back() == '\r')
            line.remove_suffix(1);
        if (const auto marker = line.find('#'); marker != line.npos)
            fragments.emplace_back(line.substr(marker));
        if (end == source.npos)
            break;
        start = end + 1;
    }
    return fragments;
}

bool path_safe(std::string_view path)
{
    if (path.empty() || path.find('\\') != path.npos || path.front() == '/' ||
        path.find('\0') != path.npos)
        return false;
    const fs::path value(path);
    if (value.is_absolute() || value != value.lexically_normal())
        return false;
    for (const auto& part : value)
        if (part == "." || part == ".." || part.empty())
            return false;
    return true;
}

bool path_prefix(std::string_view path, std::string_view prefix)
{
    return path == prefix ||
           (path.size() > prefix.size() && path.starts_with(prefix) && path[prefix.size()] == '/');
}

std::optional<Json> value_at(const Json& value, std::string_view pointer)
{
    try {
        return Json(
            jsoncons::jsonpointer::get(value, jsoncons::jsonpointer::json_pointer(pointer)));
    } catch (...) {
        return std::nullopt;
    }
}

bool independent_edit(const Json& baseline, const Json& current, std::string_view pointer)
{
    if (pointer.empty() || pointer.front() != '/')
        return false;
    // Sequence edit ownership is conservative: an insertion/removal/reorder in
    // the same array invalidates all positional edits under that array.
    std::string ancestor;
    for (std::size_t offset = 1; offset <= pointer.size();) {
        const auto slash = pointer.find('/', offset);
        ancestor += "/" + std::string(pointer.substr(offset, slash - offset));
        const auto old_value = value_at(baseline, ancestor);
        const auto new_value = value_at(current, ancestor);
        if (old_value && new_value && old_value->is_array() && *old_value != *new_value)
            return false;
        if (slash == std::string_view::npos)
            break;
        offset = slash + 1;
    }
    return value_at(baseline, pointer) == value_at(current, pointer);
}

struct JournalTarget {
    std::string path;
    std::string before_revision;
    std::string after_revision;
    std::string before_blob;
    std::string after_blob;
};

struct Journal {
    std::string id;
    std::string state;
    std::string owner;
    std::uint64_t pid = 0;
    std::string operation;
    std::vector<JournalTarget> targets;
    std::vector<std::string> completed;
};

Json serialize(const Journal& journal)
{
    Json result = Json::object();
    result.insert_or_assign("schema", std::string(journal_schema));
    result.insert_or_assign("transactionId", journal.id);
    result.insert_or_assign("state", journal.state);
    result.insert_or_assign("writerOwnerToken", journal.owner);
    result.insert_or_assign("writerPid", journal.pid);
    result.insert_or_assign("operationLabel", journal.operation);
    Json entries = Json::array();
    for (const auto& target : journal.targets) {
        Json entry = Json::object();
        entry.insert_or_assign("path", target.path);
        entry.insert_or_assign("operation", target.after_revision == "absent" ? "delete" : "write");
        entry.insert_or_assign("beforeRevision", target.before_revision);
        entry.insert_or_assign("afterRevision", target.after_revision);
        entry.insert_or_assign("beforeBlob", target.before_blob.empty() ? Json::null()
                                                                        : Json(target.before_blob));
        entry.insert_or_assign("afterBlob",
                               target.after_blob.empty() ? Json::null() : Json(target.after_blob));
        entries.push_back(std::move(entry));
    }
    result.insert_or_assign("targets", std::move(entries));
    Json completed = Json::array();
    for (const auto& path : journal.completed)
        completed.push_back(path);
    result.insert_or_assign("completedTargets", std::move(completed));
    return result;
}

Journal deserialize(std::string_view source, std::string_view expected_id)
{
    const auto root = Json::parse(source);
    if (!root.is_object() || root.at("schema") != journal_schema ||
        root.at("transactionId") != expected_id || !root.at("writerOwnerToken").is_string() ||
        !root.at("writerPid").is_number() || !root.at("operationLabel").is_string() ||
        !root.at("completedTargets").is_array() || !root.at("targets").is_array())
        throw std::runtime_error("Malformed transaction journal.");
    Journal journal;
    journal.id = std::string(expected_id);
    journal.state = root.at("state").as<std::string>();
    journal.owner = root.at("writerOwnerToken").as<std::string>();
    journal.pid = root.at("writerPid").as<std::uint64_t>();
    journal.operation = root.at("operationLabel").as<std::string>();
    if (journal.owner.empty() || journal.pid == 0 ||
        (journal.state != "prepared" && journal.state != "writing" &&
         journal.state != "committed" && journal.state != "rolled-back"))
        throw std::runtime_error("Malformed transaction journal state.");
    for (const auto& entry : root.at("targets").array_range()) {
        const auto path = entry.at("path").as<std::string>();
        const auto before = entry.at("beforeRevision").as<std::string>();
        const auto after = entry.at("afterRevision").as<std::string>();
        const auto operation = entry.at("operation").as<std::string>();
        if (!path_safe(path) || !valid_revision(before) || !valid_revision(after) ||
            (operation != "write" && operation != "delete") ||
            (after == "absent") != (operation == "delete"))
            throw std::runtime_error("Invalid transaction journal target.");
        const auto blob = [](const Json& value) {
            return value.is_null() ? std::string{} : value.as<std::string>();
        };
        const auto before_blob = blob(entry.at("beforeBlob"));
        const auto after_blob = blob(entry.at("afterBlob"));
        if ((before == "absent") != before_blob.empty() ||
            (after == "absent") != after_blob.empty() ||
            (!before_blob.empty() && !path_safe(before_blob)) ||
            (!after_blob.empty() && !path_safe(after_blob)))
            throw std::runtime_error("Invalid transaction journal blob reference.");
        journal.targets.push_back({path, before, after, before_blob, after_blob});
    }
    for (const auto& path : root.at("completedTargets").array_range()) {
        if (!path.is_string())
            throw std::runtime_error("Invalid completed transaction path.");
        journal.completed.push_back(path.as<std::string>());
    }
    return journal;
}

Json lock_owner(std::string_view owner, std::uint64_t pid, std::string_view label,
                std::optional<std::string_view> transaction)
{
    Json result = Json::object();
    result.insert_or_assign("ownerToken", std::string(owner));
    result.insert_or_assign("pid", pid);
    result.insert_or_assign("operationLabel", std::string(label));
    result.insert_or_assign("transactionId",
                            transaction ? Json(std::string(*transaction)) : Json::null());
    return result;
}

std::pair<std::string, std::uint64_t> read_owner(const fs::path& directory)
{
    const auto root = Json::parse(read_source(directory / "owner.json"));
    if (!root.is_object() || !root.at("ownerToken").is_string() || !root.at("pid").is_number() ||
        !root.at("operationLabel").is_string() ||
        (!root.at("transactionId").is_null() && !root.at("transactionId").is_string()))
        throw std::runtime_error("Invalid Project writer lock owner.");
    const auto owner = root.at("ownerToken").as<std::string>();
    const auto pid = root.at("pid").as<std::uint64_t>();
    if (owner.empty() || pid == 0)
        throw std::runtime_error("Invalid Project writer lock owner.");
    return {owner, pid};
}

void write_journal(const fs::path& directory, const Journal& journal)
{
    write_atomic(directory / "manifest.json", serialize(journal).to_string() + "\n");
}

fs::path safe_source_path(const fs::path& root, std::string_view relative)
{
    const bool staged_asset = std::regex_match(
        std::string(relative), std::regex(R"(^\.noveltea/native-asset-import/[0-9a-f-]{36}$)"));
    const bool asset_bytes = relative.starts_with("support/") || relative.starts_with("assets/") ||
                             relative.starts_with(".noveltea/trash/assets/") || staged_asset;
    const bool standalone_source =
        (relative.starts_with("scripts/") && relative.ends_with(".lua")) ||
        (relative.starts_with("shaders/") && relative.ends_with(".sc"));
    const bool layout_text = std::regex_match(
        std::string(relative),
        std::regex(
            R"(^(?:records/layouts/|\.noveltea/trash/layouts/)[a-z][a-z0-9]*(?:-[a-z0-9]+)*/layout\.(rml|rcss|lua)$)"));
    const bool admitted_text_path =
        (relative.starts_with("scripts/") || relative.starts_with("assets/")) &&
        (relative.ends_with(".lua") || relative.ends_with(".rml") || relative.ends_with(".rcss"));
    if (!path_safe(relative) ||
        (relative.starts_with(".noveltea/") && !relative.starts_with(".noveltea/trash/assets/") &&
         !layout_text && !staged_asset) ||
        (!asset_bytes && !standalone_source && !relative.ends_with(".yaml") && !layout_text &&
         !admitted_text_path))
        throw std::runtime_error("Invalid tracked YAML transaction target: " +
                                 std::string(relative));
    const auto target = root / fs::path(relative);
    const auto canonical = fs::weakly_canonical(target);
    const auto lexical = canonical.lexically_relative(root);
    if (lexical.empty() || lexical == ".." || *lexical.begin() == "..")
        throw std::runtime_error("Tracked YAML target escapes the Project root.");
    for (auto parent = target; parent != root; parent = parent.parent_path()) {
        std::error_code error;
        const auto status = fs::symlink_status(parent, error);
        if (!error && fs::is_symlink(status))
            throw std::runtime_error("Tracked YAML target traverses a symbolic link.");
        if (error && error != std::errc::no_such_file_or_directory)
            throw std::runtime_error("Cannot inspect tracked YAML target.");
    }
    return target;
}

void write_owned_directory(const fs::path& directory, std::string_view owner,
                           std::string_view label, std::optional<std::string_view> id)
{
    write_atomic(directory / "owner.json",
                 lock_owner(owner, process_id(), label, id).to_string() + "\n");
}

void remove_owned_directory(const fs::path& directory, std::string_view token)
{
    if (!fs::exists(directory))
        return;
    if (read_owner(directory).first != token)
        throw std::runtime_error("Project writer lock ownership changed.");
    fs::remove_all(directory);
    sync_directory(directory.parent_path());
}

std::optional<std::string> journal_target_bytes(const fs::path& directory,
                                                std::string_view identity, std::string_view blob)
{
    if (identity == "absent")
        return std::nullopt;
    if (blob.empty() || !path_safe(blob))
        throw std::runtime_error("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT: missing blob");
    const auto blob_path = directory / blob;
    if (!fs::is_regular_file(fs::symlink_status(blob_path)))
        throw std::runtime_error("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT: unsafe blob");
    auto bytes = read_source(blob_path);
    if (!source_revision_matches(bytes, identity))
        throw std::runtime_error("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT: corrupt blob");
    return bytes;
}

bool journal_target_matches(const fs::path& root, const fs::path& directory,
                            const JournalTarget& target, bool after)
{
    const auto bytes =
        journal_target_bytes(directory, after ? target.after_revision : target.before_revision,
                             after ? target.after_blob : target.before_blob);
    const auto path = safe_source_path(root, target.path);
    return bytes ? regular_source_exists(path) && read_source(path) == *bytes
                 : !regular_source_exists(path);
}

void apply_target(const fs::path& root, const fs::path& directory, const JournalTarget& target,
                  bool after)
{
    const auto path = safe_source_path(root, target.path);
    const auto& wanted = after ? target.after_revision : target.before_revision;
    // A noncryptographic digest is sufficient to label local source revisions,
    // but crash recovery must prove the exact stored original bytes.
    if (journal_target_matches(root, directory, target, after))
        return;
    if (!journal_target_matches(root, directory, target, !after))
        throw std::runtime_error("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT: " + target.path);
    if (wanted == "absent") {
        if (fs::exists(path)) {
            fs::remove(path);
            sync_directory(path.parent_path());
        }
        return;
    }
    write_atomic(path, *journal_target_bytes(directory, wanted,
                                             after ? target.after_blob : target.before_blob));
}

void recover_journals(const fs::path& root)
{
    const auto transactions = root / journal_root;
    if (!fs::exists(transactions))
        return;
    std::vector<fs::path> journals;
    std::vector<fs::path> unpublished;
    for (const auto& entry : fs::directory_iterator(transactions)) {
        const auto name = entry.path().filename().string();
        if (name == lock_name || name == guard_name || name.starts_with(".writer-lock.claimed-"))
            continue;
        if (!path_safe(name) || !entry.is_directory() || entry.is_symlink())
            throw std::runtime_error("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT: invalid journal");
        if (name.starts_with(".preparing-")) {
            // A preparation directory can never contain applied source writes:
            // publication to the real journal name precedes the first rename.
            unpublished.push_back(entry.path());
            continue;
        }
        journals.push_back(entry.path());
    }
    for (const auto& directory : unpublished) {
        fs::remove_all(directory);
        sync_directory(transactions);
    }
    std::sort(journals.begin(), journals.end());
    for (const auto& directory : journals) {
        Journal journal;
        try {
            journal = deserialize(read_source(directory / "manifest.json"),
                                  directory.filename().string());
            std::set<std::string> distinct;
            for (const auto& target : journal.targets) {
                if (!distinct.insert(target.path).second)
                    throw std::runtime_error("Duplicate transaction journal target.");
                const bool before = journal_target_matches(root, directory, target, false);
                if (!before && !journal_target_matches(root, directory, target, true))
                    throw std::runtime_error("Unknown target revision: " + target.path);
                if (journal.state == "rolled-back" && !before)
                    throw std::runtime_error("Rolled-back transaction target diverged.");
            }
            if (journal.state == "committed") {
                for (const auto& target : journal.targets)
                    apply_target(root, directory, target, true);
            } else if (journal.state != "rolled-back") {
                for (auto it = journal.targets.rbegin(); it != journal.targets.rend(); ++it)
                    apply_target(root, directory, *it, false);
                journal.state = "rolled-back";
                write_journal(directory, journal);
            }
            // A structural Layout owner can be removed by deleting its YAML
            // and three companions. Empty directories are not source owners;
            // prune them after replay as well as after a normal commit.
            for (const auto& target : journal.targets) {
                const bool active = journal.state == "committed";
                const bool absent =
                    active ? target.after_revision == "absent" : target.before_revision == "absent";
                if (!absent || !target.path.starts_with("records/layouts/") ||
                    !target.path.ends_with("/layout.yaml"))
                    continue;
                const auto parent = safe_source_path(root, target.path).parent_path();
                if (fs::is_directory(parent) && fs::is_empty(parent)) {
                    fs::remove(parent);
                    sync_directory(parent.parent_path());
                }
            }
            fs::remove_all(directory);
            sync_directory(transactions);
        } catch (const std::exception& e) {
            throw std::runtime_error("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT: " +
                                     directory.filename().string() + ": " + e.what());
        }
    }
}

class WriterLock {
public:
    WriterLock(const fs::path& root, std::string_view label,
               std::optional<std::string_view> transaction)
        : root_(root), token_(token())
    {
        const auto transactions = root / journal_root;
        const auto canonical = fs::weakly_canonical(transactions);
        const auto relative = canonical.lexically_relative(root);
        if (relative.empty() || relative == ".." || *relative.begin() == "..")
            throw std::runtime_error("WORKSPACE_PATH_INVALID: journal root escapes Project.");
        fs::create_directories(transactions);
        const auto lock = transactions / lock_name;
        const auto guard = transactions / guard_name;
        if (fs::exists(guard))
            throw std::runtime_error("WORKSPACE_BUSY: writer reclaim is active.");
        if (fs::is_symlink(fs::symlink_status(lock)))
            throw std::runtime_error("WORKSPACE_BUSY: writer lock is a symbolic link.");
        if (fs::create_directory(lock)) {
            // A reclaimer can acquire the guard between the initial check and
            // exclusive lock creation. Never publish an owner under its guard.
            if (fs::exists(guard)) {
                fs::remove(lock);
                throw std::runtime_error("WORKSPACE_BUSY: writer reclaim started concurrently.");
            }
        } else {
            const auto [prior_owner, prior_pid] = read_owner(lock);
            if (!proven_dead(prior_pid))
                throw std::runtime_error("WORKSPACE_BUSY: another Project writer is active.");
            const auto guard_token = token();
            if (!fs::create_directory(guard))
                throw std::runtime_error("WORKSPACE_BUSY: writer reclaim is active.");
            write_owned_directory(guard, guard_token, "reclaim Project writer", transaction);
            const auto claimed = transactions / (".writer-lock.claimed-" + token());
            bool claimed_lock = false;
            try {
                if (read_owner(lock).first != prior_owner || !proven_dead(prior_pid))
                    throw std::runtime_error("WORKSPACE_BUSY: writer changed during reclaim.");
                fs::rename(lock, claimed);
                claimed_lock = true;
                if (read_owner(claimed).first != prior_owner)
                    throw std::runtime_error("WORKSPACE_BUSY: claimed writer changed.");
                recover_journals(root);
                if (!fs::create_directory(lock))
                    throw std::runtime_error("WORKSPACE_BUSY: writer appeared during reclaim.");
                remove_owned_directory(claimed, prior_owner);
                claimed_lock = false;
                remove_owned_directory(guard, guard_token);
            } catch (...) {
                // Never delete a guard while the lock is unaccounted for.
                if (claimed_lock && !fs::exists(lock) && read_owner(claimed).first == prior_owner) {
                    fs::rename(claimed, lock);
                    claimed_lock = false;
                }
                if (!claimed_lock)
                    remove_owned_directory(guard, guard_token);
                throw;
            }
        }
        // All physical targets use this same cross-process writer lock.
        try {
            write_owned_directory(lock, token_, label, transaction);
        } catch (...) {
            // Only clean an empty, never-published lock. An owner-bearing lock
            // is retained if ownership cannot be safely established.
            std::error_code ignored;
            if (!fs::exists(lock / "owner.json"))
                fs::remove(lock, ignored);
            throw;
        }
        held_ = true;
    }

    ~WriterLock()
    {
        if (!held_)
            return;
        try {
            remove_owned_directory(root_ / journal_root / lock_name, token_);
        } catch (...) {
            // Unknown ownership is retained for conservative manual recovery.
        }
    }

    std::string_view owner() const { return token_; }

private:
    fs::path root_;
    std::string token_;
    bool held_ = false;
};

} // namespace

YamlTransactionService::YamlTransactionService(fs::path root)
    : root_(fs::canonical(std::move(root)))
{
}

fs::path YamlTransactionService::checked_path(std::string_view relative) const
{
    return safe_source_path(root_, relative);
}

void YamlTransactionService::set_invalid_sources(std::vector<std::string> blocked_paths,
                                                 bool structural_uncertainty)
{
    blocked_paths_ = std::move(blocked_paths);
    structural_uncertainty_ = structural_uncertainty;
}

PreparedYamlTransaction
YamlTransactionService::prepare(const std::vector<YamlTransactionTarget>& targets,
                                TransactionDecision decision) const
{
    PreparedYamlTransaction result;
    result.decision = decision;
    if (decision == TransactionDecision::Cancel) {
        result.error = "Comment or deletion approval canceled.";
        return result;
    }
    try {
        if (structural_uncertainty_)
            throw std::runtime_error("WORKSPACE_INVALID_SOURCE_DEPENDENCY: unknown source owner.");
        std::set<std::string> used;
        for (const auto& target : targets) {
            const bool asset_bytes =
                target.path.starts_with("support/") || target.path.starts_with("assets/") ||
                target.path.starts_with(".noveltea/trash/assets/") ||
                std::regex_match(target.path,
                                 std::regex(R"(^\.noveltea/native-asset-import/[0-9a-f-]{36}$)"));
            const bool standalone_source =
                (target.path.starts_with("scripts/") && target.path.ends_with(".lua")) ||
                (target.path.starts_with("shaders/") && target.path.ends_with(".sc"));
            if (target.raw_asset_file &&
                ((!asset_bytes && !standalone_source) || !target.edits.empty() ||
                 target.replacement_source || target.semantic_compaction_family ||
                 (static_cast<int>(target.erase) +
                      static_cast<int>(target.create_source.has_value()) +
                      static_cast<int>(target.raw_text_source.has_value()) !=
                  1)))
                throw std::runtime_error("Invalid native binary Asset transaction target.");
            if (asset_bytes && !target.raw_asset_file &&
                target.path.starts_with(".noveltea/trash/"))
                throw std::runtime_error("Trash writes require admitted native binary move.");
            const bool layout_text = std::regex_match(
                target.path,
                std::regex(
                    R"(^(?:records/layouts/|\.noveltea/trash/layouts/)[a-z][a-z0-9]*(?:-[a-z0-9]+)*/layout\.(rml|rcss|lua)$)"));
            const bool raw_text = target.raw_text_source.has_value();
            const bool admitted_text_path =
                layout_text ||
                ((target.path.starts_with("scripts/") || target.path.starts_with("assets/")) &&
                 (target.path.ends_with(".lua") || target.path.ends_with(".rml") ||
                  target.path.ends_with(".rcss")));
            if (admitted_text_path && !raw_text && !target.erase && !target.create_source)
                throw std::runtime_error(
                    "Tracked text sources require exact raw text replacement.");
            if (layout_text &&
                (!target.edits.empty() || (!target.create_source && !target.erase && !raw_text)))
                throw std::runtime_error("Layout companion transaction only supports whole-file "
                                         "creation or deletion.");
            if (raw_text && (target.erase || target.create_source || target.replacement_source ||
                             target.semantic_compaction_family || !target.edits.empty() ||
                             (!admitted_text_path && !target.raw_asset_file)))
                throw std::runtime_error(
                    "Raw source replacement must be a tracked text-only edit.");
            const auto absolute = checked_path(target.path);
            if (!used.insert(target.path).second)
                throw std::runtime_error("Duplicate YAML transaction target.");
            if (std::any_of(blocked_paths_.begin(), blocked_paths_.end(), [&](const auto& path) {
                    return path_prefix(target.path, path) || path_prefix(path, target.path);
                }))
                throw std::runtime_error("WORKSPACE_INVALID_SOURCE_DEPENDENCY: " + target.path);
            if (!valid_revision(target.expected_revision))
                throw std::runtime_error("Invalid expected YAML source revision.");
            if (target.expected_revision != "absent" &&
                !source_revision_matches(target.baseline_source, target.expected_revision))
                throw std::runtime_error("Untrusted YAML transaction baseline.");
            if (target.erase && (!target.edits.empty() || target.create_source))
                throw std::runtime_error("YAML deletion cannot include field edits.");
            if (target.replacement_source &&
                (target.erase || target.create_source || !target.edits.empty() || layout_text))
                throw std::runtime_error(
                    "Whole-source replacement must be a YAML format operation.");
            if (target.semantic_compaction_family && !target.replacement_source)
                throw std::runtime_error("Semantic compaction requires a whole-source format.");
            if (target.create_source && target.expected_revision != "absent")
                throw std::runtime_error("New YAML source requires absent expected revision.");
            const auto current_revision = revision(absolute);
            const auto current =
                current_revision == "absent" ? std::string{} : read_source(absolute);
            if (current_revision != "absent" && !source_revision_matches(current, current_revision))
                throw std::runtime_error("YAML source changed during preparation.");
            if (current_revision != target.expected_revision) {
                if (current_revision == "absent" || target.erase || target.create_source ||
                    raw_text || target.replacement_source || target.expected_revision == "absent")
                    throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: " + target.path);
                const auto baseline = open_yaml_source(target.baseline_source);
                const auto fresh = open_yaml_source(current);
                if (!baseline.accepted || !fresh.accepted)
                    throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: invalid YAML baseline.");
                const auto previous = Json::parse(baseline.source_json);
                const auto latest = Json::parse(fresh.source_json);
                for (const auto& edit : target.edits)
                    if (!independent_edit(previous, latest, edit.path))
                        throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: overlapping " +
                                                 target.path + " " + edit.path);
            }
            PreparedYamlTarget prepared;
            prepared.path = target.path;
            prepared.before_revision = current_revision;
            prepared.before_source = current;
            prepared.erase = target.erase;
            if (target.erase) {
                prepared.after_revision = "absent";
                if (current_revision != "absent" && !layout_text && !target.raw_asset_file) {
                    const auto opened = open_yaml_source(current);
                    if (!opened.accepted)
                        throw std::runtime_error("Cannot review invalid YAML deletion source.");
                    for (const auto& location : opened.locations)
                        if (location.has_comment)
                            prepared.affected_comments.push_back(location.path);
                }
            } else if (raw_text) {
                if (current_revision == "absent")
                    throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: missing text source.");
                prepared.after_source = *target.raw_text_source;
                prepared.after_revision = exact_source_revision(prepared.after_source);
            } else if (target.create_source) {
                if (current_revision != "absent")
                    throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: existing target.");
                if (!layout_text && !target.raw_asset_file) {
                    const auto opened = open_yaml_source(*target.create_source);
                    if (!opened.accepted)
                        throw std::runtime_error("Cannot create invalid YAML source: " +
                                                 opened.error);
                }
                prepared.after_source = *target.create_source;
                prepared.after_revision = exact_source_revision(prepared.after_source);
            } else if (target.replacement_source) {
                if (current_revision == "absent")
                    throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: missing YAML source.");
                const auto before = open_yaml_source(current);
                const auto after = open_yaml_source(*target.replacement_source);
                if (!before.accepted || !after.accepted)
                    throw std::runtime_error(
                        "Whole-source formatting requires valid restricted YAML.");
                bool same_semantics = jsoncons::json::parse(before.source_json) ==
                                      jsoncons::json::parse(after.source_json);
                if (!same_semantics && target.semantic_compaction_family) {
                    const auto& family = *target.semantic_compaction_family;
                    const auto prefix = "records/" + family + "/";
                    const bool flat_record =
                        target.path.starts_with(prefix) &&
                        target.path.substr(prefix.size()).find('/') == std::string::npos;
                    const bool layout_record =
                        family == "layouts" && target.path.starts_with(prefix) &&
                        target.path.ends_with("/layout.yaml") &&
                        target.path.substr(prefix.size(), target.path.size() - prefix.size() - 12)
                                .find('/') == std::string::npos;
                    const bool non_record = (family == "project.yaml" || family == "editor.yaml" ||
                                             family == "i18n/project.yaml") &&
                                            target.path == family;
                    if (!flat_record && !layout_record && !non_record)
                        throw std::runtime_error(
                            "Semantic compaction is not a canonical tracked source owner.");
                    const auto initial =
                        effective_record_for_compaction(family, before.source_json);
                    const auto updated = effective_record_for_compaction(family, after.source_json);
                    same_semantics = initial.accepted && updated.accepted &&
                                     jsoncons::json::parse(initial.effective_json) ==
                                         jsoncons::json::parse(updated.effective_json);
                }
                if (!same_semantics)
                    throw std::runtime_error("YAML formatting changed source semantics.");
                if (hash_fragments(current) != hash_fragments(*target.replacement_source))
                    throw std::runtime_error("YAML formatting must preserve all comment text.");
                prepared.after_source = *target.replacement_source;
                prepared.after_revision = exact_source_revision(prepared.after_source);
            } else {
                if (current_revision == "absent")
                    throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: missing YAML source.");
                const auto opened = open_yaml_source(current);
                if (!opened.accepted)
                    throw std::runtime_error("Cannot edit invalid YAML source: " + opened.error);
                auto edits = target.edits;
                for (auto& edit : edits) {
                    if (decision != TransactionDecision::UseEditDecisions)
                        edit.comments = decision == TransactionDecision::KeepComments
                                            ? YamlCommentDisposition::Keep
                                            : YamlCommentDisposition::Remove;
                    for (const auto& location : opened.locations)
                        if (location.has_comment && (path_prefix(location.path, edit.path) ||
                                                     path_prefix(edit.path, location.path)))
                            prepared.affected_comments.push_back(location.path);
                }
                std::sort(prepared.affected_comments.begin(), prepared.affected_comments.end());
                prepared.affected_comments.erase(std::unique(prepared.affected_comments.begin(),
                                                             prepared.affected_comments.end()),
                                                 prepared.affected_comments.end());
                const auto edited = edit_yaml_source(current, edits);
                if (!edited.accepted)
                    throw std::runtime_error("YAML comment-aware preflight rejected: " +
                                             edited.error);
                prepared.after_source = edited.source;
                prepared.after_revision = exact_source_revision(prepared.after_source);
            }
            // Compare exact bytes, not algorithm-tagged digests: a legacy
            // SHA-256 precondition and an XXH3-128 after-revision can describe
            // the same unchanged source. An absent target still represents a
            // physical create/delete even when the source contents are empty.
            if (prepared.before_revision == "absent" || prepared.after_revision == "absent" ||
                prepared.before_source != prepared.after_source)
                result.targets.push_back(std::move(prepared));
        }
        std::sort(result.targets.begin(), result.targets.end(),
                  [](const auto& a, const auto& b) { return a.path < b.path; });
        result.approval = approval_for(result);
        result.accepted = true;
    } catch (const std::exception& e) {
        result.targets.clear();
        result.error = e.what();
    }
    return result;
}

YamlTransactionResult YamlTransactionService::recover()
{
    YamlTransactionResult result;
    try {
        const auto root = root_ / journal_root;
        if (!fs::exists(root)) {
            result.accepted = true;
            return result;
        }
        bool pending = false;
        for (const auto& entry : fs::directory_iterator(root)) {
            const auto name = entry.path().filename().string();
            if (name != lock_name && name != guard_name &&
                !name.starts_with(".writer-lock.claimed-")) {
                pending = true;
                break;
            }
        }
        if (!pending) {
            result.accepted = true;
            return result;
        }
        WriterLock lock(root_, "Project journal recovery", std::nullopt);
        recover_journals(root_);
        result.accepted = true;
    } catch (const std::exception& e) {
        result.error = e.what();
    }
    return result;
}

YamlTransactionResult YamlTransactionService::commit(const PreparedYamlTransaction& prepared,
                                                     TransactionDecision decision)
{
    YamlTransactionResult result;
    if (!prepared.accepted || decision == TransactionDecision::Cancel ||
        prepared.decision != decision || prepared.approval != approval_for(prepared)) {
        result.error = "Stale or canceled YAML comment/deletion approval.";
        return result;
    }
    if (structural_uncertainty_) {
        result.error = "WORKSPACE_INVALID_SOURCE_DEPENDENCY: unknown source owner.";
        return result;
    }
    try {
        // Do not create a writer lock or journal for a no-op save.
        if (prepared.targets.empty()) {
            result.accepted = true;
            return result;
        }
        const auto id = token();
        WriterLock lock(root_, "native YAML Project Save", id);
        recover_journals(root_);
        std::set<std::string> paths;
        for (const auto& target : prepared.targets) {
            if (!paths.insert(target.path).second ||
                std::any_of(blocked_paths_.begin(), blocked_paths_.end(), [&](const auto& path) {
                    return path_prefix(target.path, path) || path_prefix(path, target.path);
                }))
                throw std::runtime_error("WORKSPACE_INVALID_SOURCE_DEPENDENCY: " + target.path);
            const auto absolute = checked_path(target.path);
            if (revision(absolute) != target.before_revision ||
                (target.before_revision != "absent" &&
                 read_source(absolute) != target.before_source))
                throw std::runtime_error("WORKSPACE_REVISION_CONFLICT: " + target.path);
            if ((target.erase && target.after_revision != "absent") ||
                (!target.erase &&
                 !source_revision_matches(target.after_source, target.after_revision)))
                throw std::runtime_error("Stale YAML transaction approval payload.");
        }
        const auto directory = root_ / journal_root / id;
        const auto preparation = root_ / journal_root / (".preparing-" + id);
        if (!fs::create_directory(preparation))
            throw std::runtime_error("WORKSPACE_BUSY: transaction ID collision.");
        sync_directory(preparation.parent_path());
        Journal journal{
            id, "prepared", std::string(lock.owner()), process_id(), "native YAML Project Save",
            {}, {}};
        bool persisted = false;
        try {
            for (std::size_t i = 0; i < prepared.targets.size(); ++i) {
                const auto& target = prepared.targets[i];
                const auto before_blob = target.before_revision == "absent"
                                             ? std::string{}
                                             : "before/" + std::to_string(i);
                const auto after_blob = target.erase ? std::string{} : "after/" + std::to_string(i);
                if (!before_blob.empty())
                    write_atomic(preparation / before_blob, target.before_source);
                if (!after_blob.empty())
                    write_atomic(preparation / after_blob, target.after_source);
                journal.targets.push_back({target.path, target.before_revision,
                                           target.after_revision, before_blob, after_blob});
            }
            sync_directory(preparation);
            write_journal(preparation, journal);
            fs::rename(preparation, directory);
            sync_directory(directory.parent_path());
            persisted = true;
            for (const auto& target : journal.targets)
                if (revision(checked_path(target.path)) != target.before_revision)
                    throw std::runtime_error(
                        "WORKSPACE_REVISION_CONFLICT: target changed after staging: " +
                        target.path);
            journal.state = "writing";
            write_journal(directory, journal);
            for (std::size_t index = 0; index < journal.targets.size(); ++index) {
                const auto& target = journal.targets[index];
                apply_target(root_, directory, target, true);
                if (after_target_hook_)
                    after_target_hook_(index);
                journal.completed.push_back(target.path);
                write_journal(directory, journal);
            }
            journal.state = "committed";
            write_journal(directory, journal);
            for (const auto& target : journal.targets) {
                if (target.after_revision != "absent" ||
                    !target.path.starts_with("records/layouts/") ||
                    !target.path.ends_with("/layout.yaml"))
                    continue;
                const auto parent = checked_path(target.path).parent_path();
                if (fs::is_directory(parent) && fs::is_empty(parent)) {
                    fs::remove(parent);
                    sync_directory(parent.parent_path());
                }
            }
        } catch (...) {
            if (persisted) {
                // A failed recovery must leave the journal intact, so a later
                // writer cannot overwrite external bytes of unknown revision.
                try {
                    for (const auto& target : journal.targets) {
                        const auto path = checked_path(target.path);
                        const auto current = revision(path);
                        if (current != target.before_revision && current != target.after_revision)
                            throw std::runtime_error("Unknown source revision during rollback.");
                    }
                    for (auto it = journal.targets.rbegin(); it != journal.targets.rend(); ++it)
                        apply_target(root_, directory, *it, false);
                    journal.state = "rolled-back";
                    write_journal(directory, journal);
                    fs::remove_all(directory);
                    sync_directory(directory.parent_path());
                } catch (...) {
                    throw std::runtime_error("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT: " + id);
                }
            } else {
                fs::remove_all(preparation);
                fs::remove_all(directory);
                sync_directory(directory.parent_path());
            }
            throw;
        }
        fs::remove_all(directory);
        sync_directory(directory.parent_path());
        result.accepted = true;
        for (const auto& target : prepared.targets)
            result.changed_paths.push_back(target.path);
    } catch (const std::exception& e) {
        result.error = e.what();
    }
    return result;
}

} // namespace noveltea::authoring
